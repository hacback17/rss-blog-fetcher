import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  getSitemapState,
  upsertSitemapState,
  getSitemapFileState,
  upsertSitemapFileState,
  upsertArticle,
  getArticleByUrl,
  setAutoTags,
  setKeywords,
  listExistingTagNames,
  recordSiteRun,
  recordRunLog,
} from "./db.js";
import { fetchRobotsRules, isPathAllowed } from "./robots.js";
import { fetchSitemapLevel } from "./sitemap.js";
import { fetchRssItems } from "./rss.js";
import { extractArticle } from "./extract.js";
import { generateTags } from "./autotag.js";
import { runPool, matchesSite, sha256 } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "sites.json"), "utf8"));
const DB_PATH = path.join(ROOT, "data", "blogs.db");
const MAX_CHILD_SITEMAPS_PER_RUN = config.maxChildSitemapsPerRun ?? 20;
const MAX_SITEMAP_DEPTH = 4;

// --site=<id> restricts a run to one site — used by the "add a site" issue
// automation to do that site's first pull immediately without re-touching
// every other site.
const SITE_FILTER = process.argv.find((a) => a.startsWith("--site="))?.slice("--site=".length) || null;

// robots.txt is respected by default (safe default); a site — or the whole
// config — can explicitly set respectRobotsTxt:false to bypass it. That's a
// deliberate choice left to the user, not decided for them; see README
// "Respecting robots.txt" for the tradeoffs before turning it off.
function robotsEnabledFor(site) {
  if (site.respectRobotsTxt !== undefined) return site.respectRobotsTxt;
  return config.respectRobotsTxt !== false;
}

// Walks a site's sitemap tree breadth-first, newest-first (by <lastmod>),
// stopping once `budget` sitemap *files* have been fetched this run.
// Sitemap index files whose lastmod hasn't changed since the last run are
// skipped entirely (their contents can't have changed), which is what keeps
// large, date-partitioned indexes (one file per day, years deep) cheap to
// poll daily instead of walking thousands of files every run.
async function collectSitemapUrls(db, site) {
  const queue = (site.sitemapUrls || []).map((loc) => ({ loc, lastmod: null, depth: 0 }));
  const seen = new Set();
  const collected = [];
  let budget = MAX_CHILD_SITEMAPS_PER_RUN;
  let skippedUnchanged = 0;

  while (queue.length) {
    const node = queue.shift();
    if (seen.has(node.loc) || node.depth > MAX_SITEMAP_DEPTH) continue;
    seen.add(node.loc);

    let level;
    try {
      level = await fetchSitemapLevel(node.loc, { userAgent: config.userAgent, timeoutMs: config.requestTimeoutMs });
    } catch (err) {
      console.warn(`  ! could not read sitemap ${node.loc}: ${err.message}`);
      continue;
    }
    upsertSitemapFileState(db, { url: node.loc, lastmod: node.lastmod });

    if (level.type === "urlset") {
      collected.push(...level.items);
      continue;
    }

    if (level.type === "index") {
      const sorted = [...level.items].sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""));
      for (const child of sorted) {
        const state = getSitemapFileState(db, child.loc);
        if (state && child.lastmod && state.lastmod === child.lastmod) {
          skippedUnchanged++;
          continue; // this child sitemap file is unchanged since we last fully read it
        }
        if (budget <= 0) continue;
        budget--;
        queue.push({ loc: child.loc, lastmod: child.lastmod, depth: node.depth + 1 });
      }
    }
  }

  if (skippedUnchanged) console.log(`  skipped ${skippedUnchanged} unchanged sitemap file(s)`);
  if (budget <= 0) console.log(`  hit the ${MAX_CHILD_SITEMAPS_PER_RUN}-sitemap-file budget for this run; older files will be picked up over subsequent runs`);
  return collected;
}

// RSS feeds are a discovery mechanism here, same as sitemaps — we only use
// the feed to find article URLs, then run each one through the same full
// Readability extraction as everything else, so the result is never limited
// to whatever snippet the feed itself carries.
async function collectRssUrls(site) {
  const collected = [];
  for (const rssUrl of site.rssUrls || []) {
    try {
      const items = await fetchRssItems(rssUrl, { userAgent: config.userAgent, timeoutMs: config.requestTimeoutMs });
      collected.push(...items);
    } catch (err) {
      console.warn(`  ! could not read RSS feed ${rssUrl}: ${err.message}`);
    }
  }
  return collected;
}

async function processSite(db, site) {
  console.log(`\n=== ${site.name} (${site.id}) ===`);
  const stats = { urlsInSitemap: 0, newArticles: 0, updatedArticles: 0, errors: 0, lastStatus: "ok" };
  const newTitles = [];

  let robots = { disallow: [] };
  if (robotsEnabledFor(site)) {
    try {
      robots = await fetchRobotsRules(site.baseUrl, config.userAgent, config.requestTimeoutMs);
    } catch {
      robots = { disallow: [] };
    }
  } else {
    console.log("  robots.txt checking disabled for this site (respectRobotsTxt: false)");
  }

  const sitemapEntries = await collectSitemapUrls(db, site);
  const rssEntries = await collectRssUrls(site);
  if (rssEntries.length) console.log(`  read ${rssEntries.length} article url(s) from RSS feed(s)`);

  // Merge, preferring the sitemap's lastmod when a URL appears in both.
  const byUrl = new Map();
  for (const entry of [...rssEntries, ...sitemapEntries]) {
    const existing = byUrl.get(entry.loc);
    if (!existing || (!existing.lastmod && entry.lastmod)) byUrl.set(entry.loc, entry);
  }
  const allEntries = [...byUrl.values()];

  stats.urlsInSitemap = allEntries.length;
  console.log(`  ${allEntries.length} total article url(s) discovered this run`);

  const candidates = allEntries.filter((entry) => {
    let pathname;
    try {
      pathname = new URL(entry.loc).pathname;
    } catch {
      return false;
    }
    if (!isPathAllowed(robots, pathname)) return false;
    if (!matchesSite(entry.loc, site)) return false;

    const state = getSitemapState(db, entry.loc);
    if (state && entry.lastmod && state.lastmod === entry.lastmod) return false; // unchanged since last check
    if (state && !entry.lastmod && state.lastmod === null) return false; // no lastmod info, already checked once
    return true;
  });

  console.log(`  ${candidates.length} candidate url(s) are new or changed`);

  const queue = candidates.slice(0, config.maxNewPerSiteRun);
  if (candidates.length > queue.length) {
    console.log(`  capping this run to ${queue.length} url(s); remainder will be picked up on a future run`);
  }

  await runPool(queue, {
    concurrency: config.concurrency,
    delayMs: config.requestDelayMs,
    worker: async (entry) => {
      try {
        const article = await extractArticle(entry.loc, {
          userAgent: config.userAgent,
          timeoutMs: config.requestTimeoutMs,
        });
        const contentHash = sha256(article.contentText);
        const publishedAt = entry.lastmod || article.publishedTimeMeta || null;

        const result = upsertArticle(db, {
          siteId: site.id,
          siteName: site.name,
          url: entry.loc,
          title: article.title,
          author: article.author,
          publishedAt,
          contentHtml: article.contentHtml,
          contentText: article.contentText,
          excerpt: article.excerpt,
          leadImage: article.leadImage,
          wordCount: article.contentText.split(/\s+/).filter(Boolean).length,
          contentHash,
        });

        if (result === "inserted") stats.newArticles++;
        if (result === "updated") stats.updatedArticles++;
        if (result === "inserted" || result === "updated") {
          newTitles.push({ title: article.title || entry.loc, url: entry.loc });
        }

        if (result === "inserted" || result === "updated") {
          try {
            const row = getArticleByUrl(db, entry.loc);
            const { tags, keywords } = await generateTags(article, listExistingTagNames(db));
            setAutoTags(db, row.id, tags);
            setKeywords(db, row.id, keywords);
          } catch (tagErr) {
            console.warn(`  ! auto-tagging failed for ${entry.loc}: ${tagErr.message}`);
          }
        }

        upsertSitemapState(db, { url: entry.loc, siteId: site.id, lastmod: entry.lastmod });
        console.log(`  [${result}] ${article.title || entry.loc}`);
      } catch (err) {
        stats.errors++;
        console.warn(`  [error] ${entry.loc}: ${err.message}`);
        // Still mark as checked so a permanently broken URL doesn't get retried every single run.
        upsertSitemapState(db, { url: entry.loc, siteId: site.id, lastmod: entry.lastmod });
      }
    },
  });

  if (stats.errors > 0 && stats.newArticles === 0 && stats.updatedArticles === 0) stats.lastStatus = "failed";
  recordSiteRun(db, site.id, stats);
  recordRunLog(db, site.id, site.name, stats, newTitles);
  console.log(`  done: +${stats.newArticles} new, ${stats.updatedArticles} updated, ${stats.errors} errors`);
}

async function main() {
  const db = openDb(DB_PATH);
  const sites = SITE_FILTER ? config.sites.filter((s) => s.id === SITE_FILTER) : config.sites;
  if (SITE_FILTER && sites.length === 0) {
    console.error(`No configured site matches --site=${SITE_FILTER}`);
    process.exitCode = 1;
  }
  for (const site of sites) {
    try {
      await processSite(db, site);
    } catch (err) {
      console.error(`Site ${site.id} failed entirely: ${err.stack}`);
      const failStats = { urlsInSitemap: 0, newArticles: 0, updatedArticles: 0, errors: 1, lastStatus: "failed" };
      recordSiteRun(db, site.id, failStats);
      recordRunLog(db, site.id, site.name, failStats, []);
    }
  }
  db.exec("PRAGMA optimize;");
  db.close();
  console.log("\nAll sites processed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
