// One-off: after adding slugs to the tag registry, re-run the classifier over
// the existing corpus and union in ONLY the new slugs — existing tags and
// summaries are left untouched.
import Anthropic from "@anthropic-ai/sdk";
import { sql } from "../src/lib/db";
import { TAG_SLUGS } from "../src/lib/tags";

const NEW_SLUGS = process.argv.slice(2);
if (NEW_SLUGS.length === 0 || NEW_SLUGS.some((s) => !TAG_SLUGS.includes(s))) {
  console.error("usage: backfill-tags.ts <new-slug> [...] (must exist in registry)");
  process.exit(1);
}

async function main() {
  const q = sql();
  const anthropic = new Anthropic();
  const rows = (await q`
    select i.id, i.title, i.summary, i.tags, s.name as source_name
    from items i join sources s on s.id = i.source_id order by i.id`) as {
    id: number; title: string; summary: string; tags: string[]; source_name: string;
  }[];

  for (const item of rows) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      tools: [
        {
          name: "assign_tags",
          description: "Assign applicable tags to a Canadian soccer news item.",
          strict: true,
          input_schema: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: { type: "string", enum: NEW_SLUGS },
                description: "The subset of these tags that clearly apply. May be empty.",
              },
            },
            required: ["tags"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "tool", name: "assign_tags", disable_parallel_tool_use: true },
      system:
        "You tag items for PitchRoots, a Canadian soccer news feed. Assign a tag only when the story clearly involves it. " +
        "world-cup = the FIFA World Cup (incl. the 2026 tournament Canada co-hosted: matches, standings, fan events, host-city coverage, aftermath). " +
        "canadian-championship = the Canadian Championship domestic cup (incl. the women's edition).",
      messages: [
        {
          role: "user",
          content: `Source: ${item.source_name}\nTitle: ${item.title}\nSummary: ${item.summary}`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    const added = ((block?.input as { tags: string[] })?.tags ?? []).filter(
      (t) => NEW_SLUGS.includes(t) && !item.tags.includes(t),
    );
    if (added.length > 0) {
      const merged = [...item.tags, ...added];
      await q`update items set tags = ${merged} where id = ${item.id}`;
      console.log(`+${added.join(",")}  ${item.title.slice(0, 60)}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
