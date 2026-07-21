// One-off: re-verify every published item's link; fix via the source's
// rewrite rule + canonical adoption, or delete if the link is truly dead.
import { sql } from "../src/lib/db";
import { verifyLink } from "../src/lib/pipeline";

async function main() {
  const q = sql();
  const rows = (await q`
    select i.id, i.url, s.id as sid, s.name, s.feed_url, s.home_url, s.tier,
           s.media_gate, s.ua_override, s.link_rewrite_from, s.link_rewrite_to
    from items i join sources s on s.id = i.source_id order by i.id`) as {
    id: number; url: string; sid: number; name: string; feed_url: string; home_url: string;
    tier: string; media_gate: boolean; ua_override: string | null;
    link_rewrite_from: string | null; link_rewrite_to: string | null;
  }[];

  for (const r of rows) {
    const source = {
      id: r.sid, name: r.name, feed_url: r.feed_url, home_url: r.home_url,
      tier: r.tier, media_gate: r.media_gate, ua_override: r.ua_override,
      link_rewrite_from: r.link_rewrite_from, link_rewrite_to: r.link_rewrite_to,
    };
    const verdict = await verifyLink(source, r.url);
    if (!verdict.ok) {
      await q`delete from items where id = ${r.id}`;
      console.log(`DELETED ${r.id} (dead): ${r.url}`);
    } else if (verdict.url !== r.url) {
      await q`update items set url = ${verdict.url} where id = ${r.id}`;
      console.log(`FIXED ${r.id}: ${r.url} -> ${verdict.url}`);
    } else {
      console.log(`OK ${r.id}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
