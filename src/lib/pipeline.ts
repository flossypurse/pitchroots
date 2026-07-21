import Anthropic from "@anthropic-ai/sdk";
import { XMLParser } from "fast-xml-parser";
import { sql } from "./db";
import { TAG_SLUGS } from "./tags";

const DEFAULT_UA = "Mozilla/5.0 (compatible; PitchRoots/1.0; +https://pitchroots.ca)";
const MAX_NEW_PER_RUN = 40;
const MAX_ITEM_AGE_DAYS = 7;

type SourceRow = {
  id: number;
  name: string;
  feed_url: string;
  home_url: string;
  tier: string;
  media_gate: boolean;
  ua_override: string | null;
};

type Candidate = {
  source: SourceRow;
  guid: string;
  url: string;
  canonicalUrl: string;
  title: string;
  snippet: string;
  publishedAt: Date;
};

export type RunStats = {
  sources: number;
  fetched: number;
  candidates: number;
  classified: number;
  published: number;
  dropped: number;
  errors: string[];
};

function canonicalize(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(key)) u.searchParams.delete(key);
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

async function fetchFeed(source: SourceRow): Promise<Omit<Candidate, "source">[]> {
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

  // RSS 2.0 or Atom
  const rssItems = doc?.rss?.channel?.item;
  const atomEntries = doc?.feed?.entry;
  const raw: Record<string, unknown>[] = rssItems
    ? Array.isArray(rssItems) ? rssItems : [rssItems]
    : atomEntries
      ? Array.isArray(atomEntries) ? atomEntries : [atomEntries]
      : [];

  const out: Omit<Candidate, "source">[] = [];
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
    out.push({ guid, url: link, canonicalUrl: canonicalize(link), title, snippet, publishedAt });
  }
  return out;
}

const CLASSIFY_TOOL: Anthropic.Messages.Tool = {
  name: "classify_item",
  description:
    "Record the classification of one news item for a Canada-wide soccer news feed.",
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

type Classification = { relevant: boolean; tags: string[]; summary: string };

async function classify(anthropic: Anthropic, c: Candidate): Promise<Classification> {
  const gate = c.source.media_gate
    ? "This source is a general sports outlet: be STRICT — mark relevant only when the item clearly involves a Canadian team, league, competition, or Canadian player. Generic international soccer coverage is NOT relevant."
    : "This source covers Canadian soccer: default to relevant unless the item is clearly not about soccer.";
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_item", disable_parallel_tool_use: true },
    system:
      "You curate PitchRoots, a Canada-wide soccer news feed. You classify one item at a time. " +
      "Summaries are neutral, factual, 1-2 sentences, written entirely in your own words — never reuse the source's phrasing. No hype, no editorializing. " +
      gate,
    messages: [
      {
        role: "user",
        content: `Source: ${c.source.name} (tier: ${c.source.tier})\nTitle: ${c.title}\nPublished: ${c.publishedAt.toISOString()}\nExcerpt: ${c.snippet || "(none)"}`,
      },
    ],
  });
  const block = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
  );
  if (!block) throw new Error(`no tool_use block (stop_reason=${response.stop_reason})`);
  return block.input as Classification;
}

export async function runPipeline(): Promise<RunStats> {
  const q = sql();
  const anthropic = new Anthropic();
  const stats: RunStats = {
    sources: 0, fetched: 0, candidates: 0, classified: 0, published: 0, dropped: 0, errors: [],
  };

  const sources = (await q`select * from sources where active order by id`) as SourceRow[];
  stats.sources = sources.length;

  const candidates: Candidate[] = [];
  for (const source of sources) {
    try {
      const entries = await fetchFeed(source);
      stats.fetched += entries.length;
      const cutoff = Date.now() - MAX_ITEM_AGE_DAYS * 86_400_000;
      for (const e of entries) {
        if (e.publishedAt.getTime() < cutoff) continue;
        candidates.push({ ...e, source });
      }
      await q`update sources set last_polled_at = now(), last_ok_at = now(), fail_count = 0 where id = ${source.id}`;
    } catch (err) {
      stats.errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      await q`update sources set last_polled_at = now(), fail_count = fail_count + 1 where id = ${source.id}`;
    }
  }

  // Dedupe against DB: guid per source, canonical URL globally, near-identical recent titles.
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    if (fresh.length >= MAX_NEW_PER_RUN) break;
    const [byGuid] = await q`select 1 from items where source_id = ${c.source.id} and guid = ${c.guid} limit 1`;
    if (byGuid) continue;
    const [rejected] = await q`select 1 from rejections where source_id = ${c.source.id} and guid = ${c.guid} limit 1`;
    if (rejected) continue;
    const [byUrl] = await q`select 1 from items where canonical_url = ${c.canonicalUrl} limit 1`;
    if (byUrl) continue;
    const [byTitle] = await q`
      select 1 from items
      where published_at > now() - interval '3 days'
        and similarity(lower(title), lower(${c.title})) > 0.65 limit 1`;
    if (byTitle) continue;
    fresh.push(c);
  }
  stats.candidates = fresh.length;

  for (const c of fresh) {
    try {
      const result = await classify(anthropic, c);
      stats.classified++;
      const tags = result.tags.filter((t) => TAG_SLUGS.includes(t));
      if (!result.relevant || !result.summary.trim()) {
        stats.dropped++;
        await q`insert into rejections (source_id, guid) values (${c.source.id}, ${c.guid}) on conflict do nothing`;
        continue;
      }
      await q`
        insert into items (source_id, guid, url, canonical_url, title, summary, tags, published_at)
        values (${c.source.id}, ${c.guid}, ${c.url}, ${c.canonicalUrl}, ${c.title},
                ${result.summary.trim()}, ${tags}, ${c.publishedAt.toISOString()})
        on conflict (canonical_url) do nothing`;
      stats.published++;
    } catch (err) {
      stats.errors.push(`classify "${c.title.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return stats;
}
