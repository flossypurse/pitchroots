import Link from "next/link";
import type { FeedItem } from "@/lib/db";
import { tagBySlug } from "@/lib/tags";

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "America/Edmonton",
});
const timeFmt = new Intl.DateTimeFormat("en-CA", {
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

  const byDay = new Map<string, FeedItem[]>();
  for (const item of items) {
    const day = dayFmt.format(new Date(item.published_at));
    const list = byDay.get(day) ?? [];
    list.push(item);
    byDay.set(day, list);
  }

  return (
    <div className="space-y-8">
      {[...byDay.entries()].map(([day, dayItems]) => (
        <section key={day}>
          <h2 className="font-display font-bold text-sm uppercase tracking-widest text-pitch mb-3">
            {day}
          </h2>
          <ol className="space-y-4">
            {dayItems.map((item) => (
              <li key={item.id} className="rounded-lg border border-line bg-card p-4">
                <div className="text-xs text-muted mb-1 flex items-center gap-2">
                  <span className="font-semibold uppercase tracking-wide">{item.source_name}</span>
                  <span>·</span>
                  <time dateTime={item.published_at}>{timeFmt.format(new Date(item.published_at))} MT</time>
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
        </section>
      ))}
    </div>
  );
}
