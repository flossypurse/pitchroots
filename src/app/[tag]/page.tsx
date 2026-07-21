import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Feed } from "@/components/Feed";
import { latestItems } from "@/lib/db";
import { TAGS, tagBySlug } from "@/lib/tags";

export const revalidate = 900;
export const dynamicParams = false;

export function generateStaticParams() {
  return TAGS.map((t) => ({ tag: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tag: string }>;
}): Promise<Metadata> {
  const { tag } = await params;
  const def = tagBySlug(tag);
  if (!def) return {};
  const description = `${def.blurb} — curated Canadian soccer headlines, updated hourly, always linking to the source.`;
  return {
    title: `${def.label} news`,
    description,
    alternates: { canonical: `/${tag}` },
    openGraph: {
      title: `${def.label} news — PitchRoots`,
      description,
      url: `/${tag}`,
    },
  };
}

export default async function TagPage({
  params,
}: {
  params: Promise<{ tag: string }>;
}) {
  const { tag } = await params;
  const def = tagBySlug(tag);
  if (!def) notFound();
  const items = await latestItems({ tag, limit: 50 });
  return (
    <>
      <div className="mb-6">
        <h1 className="font-display font-black text-2xl">{def.label}</h1>
        <p className="text-sm text-muted mt-1">{def.blurb}</p>
      </div>
      <Feed items={items} />
    </>
  );
}
