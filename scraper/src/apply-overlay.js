// Merges a "state overlay" JSON file — exported from the web UI's
// localStorage via the "Export my read & tag state" button — back into the
// durable SQLite database. This is the sync path between "read this on my
// laptop, marked some tags" (which only lives in that browser) and the
// database that gets committed to git and reused by every device: export
// from the browser, run this once, commit the updated data/blogs.db.
//
// Usage: node src/apply-overlay.js path/to/overlay.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, getArticleByUrl, setReadAt, addManualTag, removeManualTag, insertCustomArticle } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(ROOT, "data", "blogs.db");

function main() {
  const overlayPath = process.argv[2];
  if (!overlayPath) {
    console.error("Usage: node src/apply-overlay.js path/to/overlay.json");
    process.exit(1);
  }

  const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
  const db = openDb(DB_PATH);
  let applied = 0;
  let missing = 0;

  const forEachUrl = (obj, fn) => {
    for (const [url, value] of Object.entries(obj || {})) {
      const row = getArticleByUrl(db, url);
      if (!row) {
        missing++;
        continue;
      }
      fn(row, value);
      applied++;
    }
  };

  for (const [url, entry] of Object.entries(overlay.customArticles || {})) {
    insertCustomArticle(db, url, entry);
    applied++;
  }

  forEachUrl(overlay.read, (row, iso) => setReadAt(db, row.id, iso));
  for (const url of overlay.unread || []) {
    const row = getArticleByUrl(db, url);
    if (!row) { missing++; continue; }
    setReadAt(db, row.id, null);
    applied++;
  }
  forEachUrl(overlay.manualTags, (row, tagNames) => {
    for (const name of tagNames) addManualTag(db, row.id, name);
  });
  forEachUrl(overlay.removedManualTags, (row, tagNames) => {
    for (const name of tagNames) removeManualTag(db, row.id, name);
  });

  db.close();
  console.log(`Applied ${applied} change(s). ${missing} url(s) in the overlay weren't found in the database (skipped).`);
}

main();
