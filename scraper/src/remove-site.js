// Removes a source from scraper/config/sites.json, optionally deleting its
// already-scraped articles too (off by default — removing a source just
// stops future scraping; the historical data it already collected is kept
// unless you explicitly ask to delete it).
//
// Usage: node --experimental-sqlite src/remove-site.js <site-id> [--delete-articles]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(__dirname, "..", "config", "sites.json");
const DB_PATH = path.join(ROOT, "data", "blogs.db");

// Returns { removedName, deletedCount }, or throws if the id isn't found.
export function removeSite(siteId, { deleteArticles = false } = {}) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const index = config.sites.findIndex((s) => s.id === siteId);
  if (index === -1) {
    throw new Error(`No configured site with id "${siteId}". Check the Sources panel or sites.json for the exact id.`);
  }

  const [removed] = config.sites.splice(index, 1);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  let deletedCount = 0;
  if (deleteArticles) {
    const db = openDb(DB_PATH);
    deletedCount = db.prepare("SELECT COUNT(*) c FROM articles WHERE site_id = ?").get(siteId).c;
    db.prepare("DELETE FROM articles WHERE site_id = ?").run(siteId); // FTS trigger cleans up articles_fts
    db.prepare("DELETE FROM sitemap_state WHERE site_id = ?").run(siteId);
    db.prepare("DELETE FROM site_runs WHERE site_id = ?").run(siteId);
    db.close();
  }

  return { removedName: removed.name, deletedCount };
}

function main() {
  const args = process.argv.slice(2);
  const siteId = args.find((a) => !a.startsWith("--"));
  const deleteArticles = args.includes("--delete-articles");

  if (!siteId) {
    console.error("Usage: node src/remove-site.js <site-id> [--delete-articles]");
    process.exit(1);
  }

  let result;
  try {
    result = removeSite(siteId, { deleteArticles });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `site_name=${result.removedName}\n`);
    fs.appendFileSync(out, `deleted_count=${result.deletedCount}\n`);
  }

  console.log(`Removed source "${result.removedName}" (id: ${siteId}) from sites.json.`);
  console.log(
    deleteArticles
      ? `Deleted ${result.deletedCount} already-scraped article(s) from this source.`
      : "Already-scraped articles from this source were kept (pass --delete-articles to remove them too)."
  );
}

// See add-single-article.js for why this isn't a raw string comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
