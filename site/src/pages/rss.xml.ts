import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getCollection } from "astro:content";

export async function GET(context: APIContext) {
  const posts = (await getCollection("blog", ({ data }) => !data.draft)).sort(
    (left, right) => right.data.publishedAt.valueOf() - left.data.publishedAt.valueOf(),
  );

  return rss({
    title: "Volt Blog",
    description: "Engineering notes about Volt, coding agents, local-first infrastructure, and remote sessions over Iroh.",
    site: context.site ?? "https://volt-cli.dev",
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.publishedAt,
      link: `/blog/${post.id}/`,
      categories: post.data.tags,
    })),
    customData: "<language>en-us</language>",
  });
}
