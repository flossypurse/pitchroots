import Link from "next/link";
import type { FeedItem } from "@/lib/db";
import { tagBySlug } from "@/lib/tags";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Edmonton",
});

export function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-muted">
        Nothing here yet — the feed updates every hour.
      </p>
    );
  }

  return (
    <ol className="space-y-4">
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border border-line bg-card p-4">
          <div className="text-xs text-muted mb-1 flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide">{item.source_name}</span>
            <span>·</span>
            <time dateTime={new Date(item.published_at).toISOString()}>
              {dateFmt.format(new Date(item.published_at))} MT
            </time>
          </div>
          <a href={item.url} target="_blank" rel="noopener">
            <h3 className="font-display font-bold text-lg leading-snug hover:text-pitch transition-colors">
              {item.title}
              <span className="text-pitch"> ↗</span>
            </h3>
          </a>
          <p className="mt-1 text-[15px] leading-relaxed">{item.summary}</p>
          {item.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.tags.map((slug) => {
                const def = tagBySlug(slug);
                if (!def) return null;
                return (
                  <Link
                    key={slug}
                    href={`/${slug}`}
                    className="text-xs text-muted rounded-full border border-line px-2 py-0.5 hover:border-pitch hover:text-pitch"
                  >
                    {def.label}
                  </Link>
                );
              })}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
