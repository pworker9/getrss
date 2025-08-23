import "dotenv/config";
import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import { WebhookClient, EmbedBuilder } from "discord.js";

const DISCORD_NEWS_RSS_WEBHOOK = process.env.DISCORD_NEWS_RSS_WEBHOOK;
const JSON_FILE = process.env.JSON_FILE;
const EMBED_HOSTS = (process.env.EMBED_HOSTS || "")
  .split(/\r?\n/)
  .map(h => h.trim())
  .filter(Boolean);

if (!DISCORD_NEWS_RSS_WEBHOOK) {
  console.error("❌ Missing DISCORD_NEWS_RSS_WEBHOOK");
  process.exit(1);
}

const STATE_FILE = path.resolve(`./${JSON_FILE}`);
const sleep = ms => new Promise(res => setTimeout(res, ms));
const SLEEP_BETWEEN_SENDS = 3000;
const webhook = new WebhookClient({ url: DISCORD_NEWS_RSS_WEBHOOK });

async function loadState() {
  try {
    return JSON.parse(await fs.promises.readFile(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  console.log(`Saving state to ${STATE_FILE}…`);
  const t0 = Date.now();
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`State saved in ${Date.now() - t0} ms`);
}

async function main() {
  const parser = new Parser({ requestOptions: { timeout: 10000 } });
  const state = await loadState();

  try {
    // last-48h cutoff
    const now = new Date();
    const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const FEEDS = (process.env.RSS_FEEDS || "")
      .split(/[\r\n,]+/)
      .map(u => u.trim())
      .filter(Boolean);

    const allNew = [];

    for (const url of FEEDS) {
      console.log(`Fetching: ${url}`);
      let feed;
      try {
        feed = await parser.parseURL(url);
      } catch (err) {
        console.error(`⚠️ Skipping ${url}: ${err.message}`);
        continue;
      }
      const seen = new Set(state[url] || []);
      for (const item of feed.items) {
        const uniqueId = item.link;
        if (!uniqueId) continue;
        if (!seen.has(uniqueId) && new Date(item.pubDate) >= cutoff) {
          console.log(`  ✔ Queued: ${item.title}`);
          allNew.push({ item });
          seen.add(uniqueId);
        }
      }
      state[url] = Array.from(seen);
    }

    console.log(`\nTotal new items to post: ${allNew.length}`);
    console.log(`Sorting and posting…`);
    const sorted = allNew.sort(
      (a, b) => new Date(a.item.pubDate) - new Date(b.item.pubDate)
    );

    for (const { item } of sorted) {
      console.log(`Posting now: ${item.title} (${item.pubDate})`);

      const { hostname } = new URL(item.link);

      if (EMBED_HOSTS.some(domain => hostname.includes(domain))) {
        const embed = new EmbedBuilder()
          .setURL(item.link)
          .setAuthor({
            name: hostname,
            url: item.link,
            iconURL: `https://${hostname}/favicon.ico`,
          })
          .setTimestamp(new Date(item.pubDate || Date.now()));

        if (item.title) embed.setTitle(item.title);

        const snippet = item.contentSnippet?.slice(0, 200);
        if (snippet) embed.setDescription(snippet);

        if (item.enclosure?.url) embed.setImage(item.enclosure.url);

        await webhook.send({
          embeds: [embed],
          allowed_mentions: { parse: [] },
        });
      } else {
        // Use raw URL so Discord unfurls it; markdown links won't unfurl.
        await webhook.send({
          content: item.link,
          allowed_mentions: { parse: [] },
        });
      }

      await sleep(SLEEP_BETWEEN_SENDS);
    }

    await saveState(state);
  } catch (error) {
    console.error("❌ Error in main execution:", error);
    return;
  } finally {
    console.log("Finished processing all feeds.");
    await webhook.destroy?.();
  }
}

main().catch(async (err) => {
  console.error(err);
  await webhook.destroy?.();
  process.exit(1);
});
