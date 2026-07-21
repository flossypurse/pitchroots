import { Feed } from "@/components/Feed";
import { latestItems } from "@/lib/db";

export const revalidate = 900;

export default async function HomePage() {
  const items = await latestItems({ limit: 100 });
  return <Feed items={items} />;
}
