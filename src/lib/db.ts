import { neon } from "@neondatabase/serverless";

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export type FeedItem = {
  id: number;
  source_name: string;
  source_home: string;
  url: string;
  title: string;
  summary: string;
  tags: string[];
  published_at: string;
};

export async function latestItems(opts: { tag?: string; limit?: number } = {}): Promise<FeedItem[]> {
  const q = sql();
  const limit = opts.limit ?? 100;
  const rows = opts.tag
    ? await q`
        select i.id, s.name as source_name, s.home_url as source_home,
               i.url, i.title, i.summary, i.tags, i.published_at
        from items i join sources s on s.id = i.source_id
        where ${opts.tag} = any(i.tags)
        order by i.published_at desc limit ${limit}`
    : await q`
        select i.id, s.name as source_name, s.home_url as source_home,
               i.url, i.title, i.summary, i.tags, i.published_at
        from items i join sources s on s.id = i.source_id
        order by i.published_at desc limit ${limit}`;
  return rows as FeedItem[];
}
