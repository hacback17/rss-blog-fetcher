// Prints a one-line summary of the most recent run for one site, and (if
// running in GitHub Actions) appends it to $GITHUB_OUTPUT as `summary=...`.
// Used by add-site.yml to report results back on the issue that requested
// the new source.
//
// Usage: node src/print-site-run-summary.js <site-id>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "blogs.db");

const siteId = process.argv[2];
if (!siteId) {
  console.error("Usage: node src/print-site-run-summary.js <site-id>");
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const row = db.prepare("SELECT * FROM site_runs WHERE site_id = ?").get(siteId);
db.close();

const summary = row
  ? `+${row.new_articles} new article(s), ${row.errors} error(s) out of ${row.urls_in_sitemap} URL(s) discovered.`
  : "No run record found.";

console.log(summary);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
}
