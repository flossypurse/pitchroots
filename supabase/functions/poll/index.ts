// PitchRoots durable ingestion pipeline — the write-loop, on Resonate.
//
// This is the same fetch → dedupe → verify → classify → insert pipeline that
// used to run as a single Next.js cron route, re-expressed as a *durable*
// Resonate function running on resonate-pg (the Resonate server living entirely
// inside this Supabase Postgres).
//
// The whole point: every expensive or flaky external call is its own
// `ctx.run(...)` checkpoint. If an invocation dies mid-run — Edge Function
// timeout, redeploy, crash — the next invocation replays the function, and each
// completed step returns instantly from Postgres instead of re-executing. So we
// never re-fetch a feed we already read, and — critically — we never re-pay
// Claude to classify an article we already classified.
//
// Semantics are exactly-once *checkpointing*, at-least-once *side effects*. That
// is a clean fit here because the item/rejection writes are idempotent: every
// insert is `on conflict do nothing`, and `rejections` has a composite primary
// key, so a replayed step can never create a duplicate row. The one exception is
// markSourceFail's `fail_count + 1` — a best-effort health counter that can
// over-count by one if its step replays; nothing depends on its exact value.
import { type Context, Resonate } from "jsr:@resonatehq/supabase@0.4.1";
import Anthropic from "npm:@anthropic-ai/sdk@^0.111";
import postgres from "npm:postgres@^3.4.5";
import { XMLParser } from "npm:fast-xml-parser@^5.10.1";

const resonate = new Resonate();
const claude = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

// postgres.js over the Supabase pooler: prepare:false + max:1 is the pooler-safe
// setting (transaction-mode pooling rejects prepared statements).
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });

const DEFAULT_UA = "Mozilla/5.0 (compatible; PitchRoots/1.0; +https://pitchroots.ca)";
const MAX_ITEM_AGE_DAYS = 7;
// Per-source cap. In the old single-pass loop this was one global cap of 40;
// now that sources fan out and run concurrently, the fair unit is per-source.
const MAX_NEW_PER_SOURCE = 12;

// Canonical tag vocabulary — MUST stay in lockstep with web/src/lib/tags.ts.
// (The Edge Function can't import from the Next app; this is the one duplication,
// and it's a flat list of slugs, so drift is easy to eyeball in review.)
const TAG_SLUGS = [
  "canmnt", "canwnt", "canpl", "nsl", "mls", "league1", "world-cup",
  "canadian-championship", "womens", "youth", "alberta", "british-columbia",
  "saskatchewan", "manitoba", "ontario", "quebec", "new-brunswick",
  "nova-scotia", "prince-edward-island", "newfoundland-labrador",
];

type SourceRow = {
  id: number;
  name: string;
  feed_url: string;
  home_url: string;
  tier: string;
  media_gate: boolean;
  ua_override: string | null;
  link_rewrite_from: string | null;
  link_rewrite_to: string | null;
};

type Candidate = {
  guid: string;
  url: string;
  canonicalUrl: string;
  title: string;
  snippet: string;
  publishedAt: string; // ISO — must be JSON-serializable to survive checkpointing
};

type Classification = { relevant: boolean; tags: string[]; summary: string };

type SourceStats = {
  source: string;
  fetched: number;
  deadLinks: number;
  classified: number;
  published: number;
  dropped: number;
  error?: string;
};

// ── pure helpers (identical logic to the original pipeline) ──────────────────

function canonicalize(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|cmp$|ref$)/i.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return rawUrl;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── side-effecting steps (each wrapped in ctx.run at the call site) ──────────

async function fetchFeed(source: SourceRow): Promise<Candidate[]> {
  const res = await fetch(source.feed_url, {
    headers: {
      "User-Agent": source.ua_override ?? DEFAULT_UA,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });
  const doc = parser.parse(xml);

  const text = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      return text(o.__cdata ?? o["#text"] ?? "");
    }
    return String(v);
  };

  const rssItems = doc?.rss?.channel?.item;
  const atomEntries = doc?.feed?.entry;
  const raw: Record<string, unknown>[] = rssItems
    ? Array.isArray(rssItems) ? rssItems : [rssItems]
    : atomEntries
      ? Array.isArray(atomEntries) ? atomEntries : [atomEntries]
      : [];

  const out: Candidate[] = [];
  for (const it of raw) {
    let link = text(it.link);
    if (!link && it.link && typeof it.link === "object") {
      const l = it.link as Record<string, unknown> | Record<string, unknown>[];
      const arr = Array.isArray(l) ? l : [l];
      const alt = arr.find((x) => x["@_rel"] === "alternate") ?? arr[0];
      link = String(alt?.["@_href"] ?? "");
    }
    const title = stripHtml(text(it.title));
    if (!link || !title) continue;
    const guid = text(it.guid) || text(it.id) || link;
    const pub = text(it.pubDate) || text(it.published) || text(it.updated) || text(it["dc:date"]);
    const publishedAt = pub ? new Date(pub) : new Date();
    if (Number.isNaN(publishedAt.getTime())) continue;
    const snippet = stripHtml(
      text(it.description) || text(it.summary) || text(it["content:encoded"]) || text(it.content),
    ).slice(0, 600);
    out.push({
      guid,
      url: link,
      canonicalUrl: canonicalize(link),
      title,
      snippet,
      publishedAt: publishedAt.toISOString(),
    });
  }
  return out;
}

// A link must resolve before we publish it. Applies the source's rewrite rule,
// rejects hard-dead links (404/410/DNS), follows redirects, and adopts the
// page's same-host rel=canonical. WAF blocks / transient errors get the benefit
// of the doubt — the link usually works for a human even when it doesn't for us.
async function verifyLink(
  source: SourceRow,
  rawUrl: string,
): Promise<{ ok: boolean; url: string }> {
  let url = rawUrl;
  if (source.link_rewrite_from && source.link_rewrite_to) {
    url = url.replace(new RegExp(source.link_rewrite_from), source.link_rewrite_to);
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": source.ua_override ?? DEFAULT_UA },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (res.status === 404 || res.status === 410) return { ok: false, url };
    let finalUrl = res.url || url;
    if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
      const head = (await res.text()).slice(0, 200_000);
      const m =
        head.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i) ??
        head.match(/<link[^>]*href="([^"]+)"[^>]*rel="canonical"/i);
      if (m) {
        try {
          const canon = new URL(m[1], finalUrl);
          if (canon.hostname.replace(/^www\./, "") === new URL(finalUrl).hostname.replace(/^www\./, "")) {
            finalUrl = canon.toString();
          }
        } catch {
          /* malformed canonical — keep finalUrl */
        }
      }
    }
    return { ok: true, url: finalUrl };
  } catch (err) {
    if (err instanceof Error && /ENOTFOUND|ECONNREFUSED/.test(String((err as Error).cause ?? err.message))) {
      return { ok: false, url };
    }
    return { ok: true, url }; // transient — benefit of the doubt
  }
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_item",
  description: "Record the classification of one news item for a Canada-wide soccer news feed.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      relevant: {
        type: "boolean",
        description:
          "True only if the item is about Canadian soccer: a Canadian team, league, competition, player, or Canadian soccer governance.",
      },
      tags: {
        type: "array",
        items: { type: "string", enum: TAG_SLUGS },
        description: "Zero or more applicable tags from the fixed vocabulary.",
      },
      summary: {
        type: "string",
        description:
          "One to two plain factual sentences in your own words. Never copy source phrasing. Empty string if not relevant.",
      },
    },
    required: ["relevant", "tags", "summary"],
    additionalProperties: false,
  },
};

async function classify(source: SourceRow, c: Candidate): Promise<Classification> {
  const gate = source.media_gate
    ? "This source is a general sports outlet: be STRICT — mark relevant only when the item clearly involves a Canadian team, league, competition, or Canadian player. Generic international soccer coverage is NOT relevant."
    : "This source covers Canadian soccer: default to relevant unless the item is clearly not about soccer.";
  const response = await claude.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_item", disable_parallel_tool_use: true },
    system:
      "You curate PitchRoots, a Canada-wide soccer news feed. You classify one item at a time. " +
      "Summaries are neutral, factual, 1-2 sentences, written entirely in your own words — never reuse the source's phrasing. No hype, no editorializing. " +
      "Club-to-league map (only tag a league the story actually involves): " +
      "mls = Toronto FC, Vancouver Whitecaps, CF Montréal. " +
      "canpl = Atlético Ottawa, Cavalry FC, Forge FC, Halifax Wanderers, Pacific FC, Valour FC, Vancouver FC, York United. " +
      "nsl = AFC Toronto, Calgary Wild, Halifax Tides, Montreal Roses, Ottawa Rapid, Vancouver Rise. " +
      "Tag provinces only for stories with a clear provincial/city angle. " +
      gate,
    messages: [
      {
        role: "user",
        content: `Source: ${source.name} (tier: ${source.tier})\nTitle: ${c.title}\nPublished: ${c.publishedAt}\nExcerpt: ${c.snippet || "(none)"}`,
      },
    ],
  });
  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!block) throw new Error(`no tool_use block (stop_reason=${response.stop_reason})`);
  return block.input as Classification;
}

// ── durable functions ────────────────────────────────────────────────────────

// poll() — the top-level durable run. Reads the active sources, then fans each
// one out as its own child invocation (ctx.rpc). The parent suspends — holding
// zero compute — until every source settles, then pings the site to revalidate
// if anything new was published.
resonate.register("poll", async function poll(ctx: Context) {
  const sources = (await ctx.run(() => getActiveSources())) as SourceRow[];

  const results = (await Promise.all(
    sources.map(async (s) => {
      try {
        return await ctx.rpc("ingestSource", s);
      } catch (err) {
        return {
          source: s.name, fetched: 0, deadLinks: 0, classified: 0,
          published: 0, dropped: 0, error: String(err),
        } as SourceStats;
      }
    }),
  )) as SourceStats[];

  const published = results.reduce((n, r) => n + r.published, 0);
  if (published > 0) await ctx.run(() => triggerRevalidate());

  return {
    sources: results.length,
    published,
    classified: results.reduce((n, r) => n + r.classified, 0),
    deadLinks: results.reduce((n, r) => n + r.deadLinks, 0),
    dropped: results.reduce((n, r) => n + r.dropped, 0),
    perSource: results,
  };
});

// ingestSource() — durable per-source ingest. fetch (1 checkpoint) → then, per
// candidate: cheap DB dedupe (plain reads) → verify link (checkpoint) → classify
// (checkpoint, the expensive one) → persist (checkpoint). A crash resumes at the
// first step that never completed; everything before it replays from Postgres.
resonate.register("ingestSource", async function ingestSource(ctx: Context, source: SourceRow) {
  const stats: SourceStats = {
    source: source.name, fetched: 0, deadLinks: 0, classified: 0, published: 0, dropped: 0,
  };

  let entries: Candidate[];
  try {
    entries = (await ctx.run(() => fetchFeed(source))) as Candidate[];
    await ctx.run(() => markSourceOk(source.id));
  } catch (err) {
    await ctx.run(() => markSourceFail(source.id));
    stats.error = String(err);
    return stats;
  }

  // Wrapped in ctx.run so the cutoff is checkpointed: every replay uses the same
  // boundary regardless of when a resumed worker wakes (control flow must depend
  // only on checkpointed values, never on live wall-clock time).
  const now = (await ctx.run(() => Date.now())) as number;
  const cutoff = now - MAX_ITEM_AGE_DAYS * 86_400_000;
  const fresh = entries.filter((e) => Date.parse(e.publishedAt) >= cutoff);
  stats.fetched = fresh.length;

  let taken = 0;
  for (const c of fresh) {
    if (taken >= MAX_NEW_PER_SOURCE) break;

    // Cheap dedupe first — never spend a network call or a cent on the LLM for
    // something we've already seen or already rejected. These are idempotent
    // reads; on replay they simply re-run.
    const seen = (await ctx.run(() => alreadySeen(source.id, c.guid))) as boolean;
    if (seen) continue;

    // Verify the link (external fetch, checkpointed). Adopts the real permalink.
    const verdict = (await ctx.run(() => verifyLink(source, c.url))) as { ok: boolean; url: string };
    if (!verdict.ok) {
      stats.deadLinks++;
      await ctx.run(() => remember(source.id, c.guid));
      continue;
    }
    c.url = verdict.url;
    c.canonicalUrl = canonicalize(verdict.url);

    const dup = (await ctx.run(() => isDuplicateContent(c.canonicalUrl, c.title))) as boolean;
    if (dup) continue;

    taken++;

    // Classify (the LLM call — the expensive checkpoint). Once this step is
    // recorded, no crash will ever re-invoke Claude for this article.
    let result: Classification;
    try {
      result = (await ctx.run(() => classify(source, c))) as Classification;
      stats.classified++;
    } catch (err) {
      stats.error = String(err);
      continue;
    }

    const tags = result.tags.filter((t) => TAG_SLUGS.includes(t));
    if (!result.relevant || !result.summary.trim()) {
      stats.dropped++;
      await ctx.run(() => remember(source.id, c.guid));
      continue;
    }
    await ctx.run(() => publishItem(source.id, c, result.summary.trim(), tags));
    stats.published++;
  }

  return stats;
});

resonate.httpHandler();

// ── data access (plain SQL; each is called inside a ctx.run) ─────────────────

async function getActiveSources(): Promise<SourceRow[]> {
  return await sql<SourceRow[]>`select * from sources where active order by id`;
}

async function markSourceOk(id: number): Promise<null> {
  await sql`update sources set last_polled_at = now(), last_ok_at = now(), fail_count = 0 where id = ${id}`;
  return null;
}

async function markSourceFail(id: number): Promise<null> {
  // Non-idempotent increment by design — a best-effort health counter (see the
  // semantics note at the top of the file); an over-count on replay is harmless.
  await sql`update sources set last_polled_at = now(), fail_count = fail_count + 1 where id = ${id}`;
  return null;
}

async function alreadySeen(sourceId: number, guid: string): Promise<boolean> {
  const [byGuid] = await sql`select 1 from items where source_id = ${sourceId} and guid = ${guid} limit 1`;
  if (byGuid) return true;
  const [rejected] = await sql`select 1 from rejections where source_id = ${sourceId} and guid = ${guid} limit 1`;
  return Boolean(rejected);
}

async function isDuplicateContent(canonicalUrl: string, title: string): Promise<boolean> {
  const [byUrl] = await sql`select 1 from items where canonical_url = ${canonicalUrl} limit 1`;
  if (byUrl) return true;
  const [byTitle] = await sql`
    select 1 from items
    where published_at > now() - interval '3 days'
      and similarity(lower(title), lower(${title})) > 0.65 limit 1`;
  return Boolean(byTitle);
}

async function remember(sourceId: number, guid: string): Promise<null> {
  await sql`insert into rejections (source_id, guid) values (${sourceId}, ${guid}) on conflict do nothing`;
  return null;
}

async function publishItem(
  sourceId: number,
  c: Candidate,
  summary: string,
  tags: string[],
): Promise<null> {
  await sql`
    insert into items (source_id, guid, url, canonical_url, title, summary, tags, published_at)
    values (${sourceId}, ${c.guid}, ${c.url}, ${c.canonicalUrl}, ${c.title},
            ${summary}, ${tags}, ${c.publishedAt})
    on conflict (canonical_url) do nothing`;
  return null;
}

// After a run publishes new items, ask the Vercel site to revalidate its static
// pages so the new items show up without waiting for the ISR timer. Bearer-
// protected; a lost ping just means the pages refresh on their normal 15-min
// timer instead of immediately.
async function triggerRevalidate(): Promise<null> {
  const url = Deno.env.get("REVALIDATE_URL");
  const secret = Deno.env.get("REVALIDATE_SECRET");
  if (!url || !secret) return null;
  try {
    await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* the ISR timer is the backstop */
  }
  return null;
}
