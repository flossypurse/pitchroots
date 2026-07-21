import type { MetadataRoute } from "next";
import { TAGS } from "@/lib/tags";

const SITE = process.env.SITE_URL ?? "https://pitchroots.ca";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE}/about`, changeFrequency: "monthly", priority: 0.3 },
    ...TAGS.map((t) => ({
      url: `${SITE}/${t.slug}`,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
  ];
}
