-- PitchRoots v2 schema (Neon Postgres)
create extension if not exists pg_trgm;

create table if not exists sources (
  id serial primary key,
  name text not null,
  feed_url text not null unique,
  home_url text not null,
  tier text not null check (tier in ('national-team','pro-league','semi-pro','media','independent','provincial')),
  -- media-tier feeds carry lots of non-Canadian soccer; the classifier gates harder on them
  media_gate boolean not null default false,
  -- some CDNs drop non-browser UAs; null = default honest UA
  ua_override text,
  -- regex rewrite applied to item links before verification (some feeds emit
  -- systematically broken paths, e.g. Daily Hive's /offside/ links 404)
  link_rewrite_from text,
  link_rewrite_to text,
  active boolean not null default true,
  last_polled_at timestamptz,
  last_ok_at timestamptz,
  fail_count int not null default 0
);

create table if not exists items (
  id bigserial primary key,
  source_id int not null references sources(id),
  guid text not null,
  url text not null,
  canonical_url text not null unique,
  title text not null,
  summary text not null,
  tags text[] not null default '{}',
  published_at timestamptz not null,
  ingested_at timestamptz not null default now()
);

create index if not exists items_pub_idx on items (published_at desc);
create index if not exists items_tags_idx on items using gin (tags);
create index if not exists items_title_trgm_idx on items using gin (lower(title) gin_trgm_ops);
create unique index if not exists items_source_guid_idx on items (source_id, guid);

-- Items the classifier rejected — remembered so they aren't re-classified every run.
create table if not exists rejections (
  source_id int not null references sources(id),
  guid text not null,
  rejected_at timestamptz not null default now(),
  primary key (source_id, guid)
);

-- Per-run ingestion summary. Resonate GCs completed promises after ~24h, so the
-- durable run's own result is not a durable history. This append-only log keeps
-- run-level stats for feed-health debugging. Keyed on the run's origin promise id
-- so a replayed final step upserts the same row instead of appending a duplicate.
create table if not exists run_log (
  origin_id text primary key,
  ran_at timestamptz not null default now(),
  sources int, published int, classified int, dead_links int, dropped int,
  per_source jsonb
);
create index if not exists run_log_ran_at_idx on run_log (ran_at desc);

insert into sources (name, feed_url, home_url, tier, media_gate, ua_override) values
  ('Canada Soccer', 'https://www.canadasoccer.com/feed', 'https://www.canadasoccer.com', 'national-team', false, null),
  ('Sportsnet Soccer', 'https://www.sportsnet.ca/soccer/feed/', 'https://www.sportsnet.ca/soccer/', 'media', true, null),
  ('Northern Tribune', 'https://northerntribune.ca/feed/', 'https://northerntribune.ca', 'independent', false,
   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'),
  ('League1 Ontario', 'https://league1ontario.com/feed', 'https://league1ontario.com', 'semi-pro', false, null),
  ('CBC Soccer', 'https://www.cbc.ca/webfeed/rss/rss-sports-soccer', 'https://www.cbc.ca/sports/soccer', 'media', true,
   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'),
  ('Alberta Soccer', 'https://www.albertasoccer.com/feed', 'https://www.albertasoccer.com', 'provincial', false, null),
  ('Soccer Nova Scotia', 'https://soccerns.ca/feed', 'https://soccerns.ca', 'provincial', false, null),
  ('Daily Hive Offside', 'https://www.dailyhive.com/feed/offside', 'https://dailyhive.com/channel/offside', 'media', true, null)
on conflict (feed_url) do nothing;

alter table sources add column if not exists link_rewrite_from text;
alter table sources add column if not exists link_rewrite_to text;
update sources set link_rewrite_from = '^https://dailyhive\.com/offside/', link_rewrite_to = 'https://dailyhive.com/canada/'
  where feed_url = 'https://www.dailyhive.com/feed/offside' and link_rewrite_from is null;
