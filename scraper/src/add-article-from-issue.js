// Parses a GitHub Issue Form body (from the "Add an article" template) and
// adds each listed URL via addSingleArticle(). Run by
// .github/workflows/add-article.yml with the issue body piped in via stdin.
//
// Usage: cat issue-body.txt | node src/add-article-from-issue.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { addSingleArticle } from "./add-single-article.js";
import { parseIssueFields, splitList, splitLines } from "./issue-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(ROOT, "data", "blogs.db");

async function main() {
  const body = fs.readFileSync(0, "utf8");
  const fields = parseIssueFields(body);

  const urls = splitLines(fields["Article URL(s)"]);
  const extraTags = splitList(fields["Extra tags to add (optional, comma-separated)"]);

  if (urls.length === 0) {
    console.error("No URLs found in the issue body.");
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  const lines = [];
  let succeeded = 0;
  for (const url of urls) {
    try {
      const { status, title } = await addSingleArticle(db, url, { extraTags });
      lines.push(`- ✅ [${status}] ${title || url}`);
      succeeded++;
    } catch (err) {
      lines.push(`- ❌ ${url}: ${err.message}`);
    }
  }
  db.close();

  const summary = lines.join("\n");
  console.log(summary);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `succeeded=${succeeded}\n`);
    fs.appendFileSync(out, `total=${urls.length}\n`);
    // Multi-line GITHUB_OUTPUT values need the heredoc form.
    const delimiter = `SUMMARY_${Date.now()}`;
    fs.appendFileSync(out, `summary<<${delimiter}\n${summary}\n${delimiter}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
