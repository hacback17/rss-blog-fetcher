// Parses a GitHub Issue Form body (from the "Remove a source" template) and
// removes the described site via removeSite(). Run by
// .github/workflows/remove-site.yml with the issue body piped in via stdin.
//
// Usage: cat issue-body.txt | node src/remove-site-from-issue.js
import fs from "node:fs";
import { removeSite } from "./remove-site.js";
import { parseIssueFields } from "./issue-utils.js";

function main() {
  const body = fs.readFileSync(0, "utf8");
  const fields = parseIssueFields(body);

  const siteId = (fields["Site id (see the Sources panel in the app, or sites.json)"] || "").trim();
  const deleteField = fields["Also delete already-scraped articles from this source?"] || "";
  const deleteArticles = deleteField.startsWith("Yes");

  if (!siteId) {
    console.error("Missing required field: Site id.");
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

  console.log(`Removed source "${result.removedName}" (id: ${siteId}).`);
  console.log(
    deleteArticles
      ? `Deleted ${result.deletedCount} already-scraped article(s) from this source.`
      : "Already-scraped articles from this source were kept."
  );
}

main();
