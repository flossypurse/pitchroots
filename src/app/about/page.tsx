import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description: "What PitchRoots is and how the feed works.",
};

export default function AboutPage() {
  return (
    <article className="prose-sm max-w-none space-y-4 leading-relaxed">
      <h1 className="font-display font-black text-2xl">About PitchRoots</h1>
      <p>
        PitchRoots is a Canada-wide soccer news feed. It answers one question:{" "}
        <em>what&apos;s happening in Canadian soccer today?</em> — across the national
        teams, the Canadian Premier League, the Northern Super League, Canada&apos;s MLS
        clubs, League1, and the provincial game.
      </p>
      <p>
        Every item is a headline, a short summary written in our own words, and a link
        to the original publisher. We are a router, not a destination: the full story
        always lives with the source, and we send you there.
      </p>
      <h2 className="font-display font-bold text-lg pt-2">How it works</h2>
      <p>
        The feed checks a curated list of Canadian soccer sources every hour — national
        media, league sites, independent outlets, and club news. Items are filtered for
        Canadian relevance, tagged, and summarized. No accounts, no paywall, no
        newsletter — just the feed and{" "}
        <a href="/feed.xml" className="text-pitch underline">RSS</a>.
      </p>
      <h2 className="font-display font-bold text-lg pt-2">For publishers</h2>
      <p>
        We link out prominently and never republish article text or images. If you run a
        source we cover and want your coverage adjusted or removed, email{" "}
        <a href="mailto:hello@pitchroots.ca" className="text-pitch underline">
          hello@pitchroots.ca
        </a>{" "}
        and we&apos;ll act the same day.
      </p>
    </article>
  );
}
