// Parses a GitHub Issue Form body (from the "Add a source" template) and
// appends the described site to scraper/config/sites.json. Run by
// .github/workflows/add-site.yml with the issue body piped in via stdin.
//
// Usage: cat issue-body.txt | node src/parse-issue-and-add-site.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSitemapUrls } from "./robots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config", "sites.json");

// GitHub renders each Issue Form field as "### <label>\n\n<value>\n\n",
// with "_No response_" standing in for an empty optional field.
function parseFields(body) {
  const fields = {};
  const parts = body.split(/^### /m).slice(1);
  for (const part of parts) {
    const newlineIdx = part.indexOf("\n");
    const label = part.slice(0, newlineIdx).trim();
    let value = part.slice(newlineIdx + 1).trim();
    if (value === "_No response_") value = "";
    fields[label] = value;
  }
  return fields;
}

function splitList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

async function main() {
  const body = fs.readFileSync(0, "utf8");
  const fields = parseFields(body);

  const name = fields["Display name"];
  const baseUrl = fields["Base URL"];
  if (!name || !baseUrl) {
    console.error("Missing required field(s): Display name and/or Base URL.");
    process.exit(1);
  }

  const sitemapUrlField = fields["Sitemap URL (optional — leave blank to auto-discover from robots.txt)"] || "";
  const rssUrlField = fields["RSS/Atom feed URL (optional)"] || "";
  const includePathPrefixesField = fields["Only include URLs under these path(s) (optional, comma-separated)"] || "";
  const includeKeywordsField = fields["Only include URLs containing these keyword(s) (optional, comma-separated)"] || "";
  const respectRobotsField = fields["Respect robots.txt for this site?"] || "";

  let sitemapUrls = sitemapUrlField ? [sitemapUrlField] : [];
  let discoveryNote = "";
  if (sitemapUrls.length === 0 && !rssUrlField) {
    const userAgent = "BlogArchiverBot/1.0 (+add-site-automation)";
    sitemapUrls = await discoverSitemapUrls(baseUrl, userAgent, 15000);
    discoveryNote = sitemapUrls.length
      ? `Auto-discovered ${sitemapUrls.length} sitemap URL(s) from robots.txt.`
      : "Could not auto-discover a sitemap from robots.txt — no sitemap or RSS configured for this site; add one manually in sites.json.";
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  let id = slugify(name);
  const existingIds = new Set(config.sites.map((s) => s.id));
  if (existingIds.has(id)) {
    let n = 2;
    while (existingIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }

  const site = { id, name, baseUrl };
  if (sitemapUrls.length) site.sitemapUrls = sitemapUrls;
  if (rssUrlField) site.rssUrls = [rssUrlField];
  if (includePathPrefixesField) site.includePathPrefixes = splitList(includePathPrefixesField);
  if (includeKeywordsField) site.includeKeywords = splitList(includeKeywordsField);
  if (respectRobotsField.startsWith("No")) site.respectRobotsTxt = false;

  config.sites.push(site);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  // Consumed by the workflow via $GITHUB_OUTPUT.
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `site_id=${id}\n`);
    fs.appendFileSync(out, `site_name=${name}\n`);
  }
  console.log(`Added site "${name}" (id: ${id}).${discoveryNote ? " " + discoveryNote : ""}`);
  if (sitemapUrls.length === 0 && !rssUrlField) {
    console.warn("Warning: no sitemap or RSS URL — this site will find nothing to scrape until one is added.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
