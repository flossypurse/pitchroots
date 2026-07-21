import { revalidatePath } from "next/cache";
import { runPipeline } from "@/lib/pipeline";
import { TAG_SLUGS } from "@/lib/tags";

export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const stats = await runPipeline();
  if (stats.published > 0) {
    revalidatePath("/");
    for (const slug of TAG_SLUGS) revalidatePath(`/${slug}`);
  }
  return Response.json(stats);
}
