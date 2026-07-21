import type { Metadata } from "next";
import { Feed } from "@/components/Feed";
import { latestItems } from "@/lib/db";

export const revalidate = 900;

const SITE = process.env.SITE_URL ?? "https://pitchroots.ca";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
    types: { "application/rss+xml": "/feed.xml" },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE}/#website`,
      url: SITE,
      name: "PitchRoots",
      description: "Canadian soccer news, one feed.",
      inLanguage: "en-CA",
      publisher: { "@id": `${SITE}/#organization` },
    },
    {
      "@type": "Organization",
      "@id": `${SITE}/#organization`,
      name: "PitchRoots",
      url: SITE,
      email: "hello@pitchroots.ca",
      logo: `${SITE}/opengraph-image`,
    },
  ],
};

export default async function HomePage() {
  const items = await latestItems({ limit: 100 });
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <h1 className="font-display font-bold text-sm uppercase tracking-widest text-pitch mb-4">
        The latest in Canadian soccer
      </h1>
      <Feed items={items} />
    </>
  );
}
