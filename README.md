# PitchRoots

[pitchroots.ca](https://pitchroots.ca) — Canadian soccer, one feed.

A curated Canada-wide soccer news feed: headlines with short original summaries,
tagged by league, national team, and province, always linking out to the original
publisher. No accounts, no paywall — just the feed and [RSS](https://pitchroots.ca/feed.xml).

## How it works

- An hourly cron route polls a registry of Canadian soccer sources (RSS-first).
- New items are deduped (per-source GUID, canonical URL, near-identical titles via
  `pg_trgm`), then classified and summarized by Claude Haiku against a fixed tag
  vocabulary. Items that aren't about Canadian soccer are dropped and remembered.
- Pages are statically rendered and revalidate every 15 minutes.

## Stack

- [Next.js](https://nextjs.org) (App Router) on Vercel, Tailwind CSS v4
- [Neon](https://neon.tech) Postgres (`db/schema.sql`)
- [Anthropic API](https://platform.claude.com) (Haiku) for classify/summarize

## Development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev
```

Run the ingest pipeline once locally:

```bash
npx tsx scripts/run-pipeline.ts
```

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `ANTHROPIC_API_KEY` | Claude API key for the classifier |
| `CRON_SECRET` | Bearer token protecting `/api/cron/poll` |
| `SITE_URL` | Canonical site origin (defaults to `https://pitchroots.ca`) |

## For publishers

We link out prominently and never republish article text or images. If you run a
source we cover and want your coverage adjusted or removed, email
[hello@pitchroots.ca](mailto:hello@pitchroots.ca).
