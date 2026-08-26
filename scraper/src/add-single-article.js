// Fetches and fully extracts ONE specific article URL and stores it —
// exactly the same extraction pipeline the scraper uses for sitemap/RSS-
// discovered URLs, just triggered manually for a URL you already have
// instead of one discovered by crawling.
//
// Usage (local): node --experimental-sqlite src/add-single-article.js <url> [<url2> ...] [--tags=Tag One,Tag Two]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  openDb,
  upsertArticle,
  getArticleByUrl,
  setAutoTags,
  setKeywords,
  addManualTag,
  listExistingTagNames,
} from "./db.js";
import { fetchRobotsRules, isPathAllowed } from "./robots.js";
import { extractArticle } from "./extract.js";
import { generateTags } from "./autotag.js";
import { sha256 } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(__dirname, "..", "config", "sites.json");
const DB_PATH = path.join(ROOT, "data", "blogs.db");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// If the URL's host matches a site already in sites.json, the article joins
// that source (so e.g. one extra Down To Earth article you found manually
// shows up alongside the rest of Down To Earth, not in some separate
// bucket). Otherwise it gets its own host-based bucket.
function resolveSite(url, config) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  const match = config.sites.find((s) => {
    try {
      return new URL(s.baseUrl).host === host;
    } catch {
      return false;
    }
  });
  if (match) return { site: match, siteId: match.id, siteName: match.name };
  const genericId = `manual-${host.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return { site: null, siteId: genericId, siteName: host };
}

// Returns { status: 'inserted'|'updated'|'unchanged', title, siteId } or
// throws with a human-readable message on failure.
export async function addSingleArticle(db, url, { extraTags = [] } = {}) {
  const config = loadConfig();
  const resolved = resolveSite(url, config);
  if (!resolved) throw new Error(`Not a valid URL: ${url}`);
  const { site, siteId, siteName } = resolved;

  const respectRobots = site ? site.respectRobotsTxt !== false && config.respectRobotsTxt !== false : config.respectRobotsTxt !== false;
  if (respectRobots) {
    const robots = await fetchRobotsRules(new URL(url).origin, config.userAgent, config.requestTimeoutMs);
    if (!isPathAllowed(robots, new URL(url).pathname)) {
      throw new Error(`Disallowed by ${new URL(url).origin}/robots.txt (this source has respectRobotsTxt on)`);
    }
  }

  const article = await extractArticle(url, { userAgent: config.userAgent, timeoutMs: config.requestTimeoutMs });
  const contentHash = sha256(article.contentText);

  const status = upsertArticle(db, {
    siteId,
    siteName,
    url,
    title: article.title,
    author: article.author,
    publishedAt: article.publishedTimeMeta,
    contentHtml: article.contentHtml,
    contentText: article.contentText,
    excerpt: article.excerpt,
    leadImage: article.leadImage,
    wordCount: article.contentText.split(/\s+/).filter(Boolean).length,
    contentHash,
  });

  const row = getArticleByUrl(db, url);
  if (status === "inserted" || status === "updated") {
    const { tags, keywords } = await generateTags(article, listExistingTagNames(db));
    setAutoTags(db, row.id, tags);
    setKeywords(db, row.id, keywords);
  }
  for (const tag of extraTags) addManualTag(db, row.id, tag);

  return { status, title: article.title, siteId };
}

async function main() {
  const args = process.argv.slice(2);
  const tagsArg = args.find((a) => a.startsWith("--tags="));
  const extraTags = tagsArg ? tagsArg.slice("--tags=".length).split(",").map((t) => t.trim()).filter(Boolean) : [];
  const urls = args.filter((a) => !a.startsWith("--"));

  if (urls.length === 0) {
    console.error("Usage: node src/add-single-article.js <url> [<url2> ...] [--tags=Tag One,Tag Two]");
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  let failures = 0;
  for (const url of urls) {
    try {
      const { status, title, siteId } = await addSingleArticle(db, url, { extraTags });
      console.log(`[${status}] ${title || url} (site: ${siteId})`);
    } catch (err) {
      failures++;
      console.error(`[error] ${url}: ${err.message}`);
    }
  }
  db.close();
  if (failures) process.exitCode = 1;
}

// process.argv[1] isn't guaranteed absolute (e.g. when invoked via a
// relative path like `node src/add-single-article.js ...`), so compare via
// pathToFileURL rather than a raw string template — a naive
// `file://${process.argv[1]}` comparison silently never matches in that
// case and main() never runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
