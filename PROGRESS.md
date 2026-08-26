# Progress

## Status: MVP built and verified end-to-end against real scraped data

## Done
- [x] Scraper (Node.js, `scraper/`): robots.txt-aware sitemap discovery →
      Mozilla Readability full-article extraction → SQLite (`node:sqlite`,
      built-in, no native build step) with FTS5 full-text index.
- [x] Politeness: delay + low concurrency, per-URL dedup via `<lastmod>`,
      bounded/newest-first traversal of large date-partitioned sitemap
      indexes so a huge historical archive backfills gradually instead of
      being crawled in one shot.
- [x] Investigated all 13 URLs the user listed; 6 are usable via
      sitemap-driven full-article scraping, 5 are not (see README "Not
      tracked" table for why — dashboards, PDF listings, disallowed by
      robots.txt, etc). Recorded in `scraper/config/sites.json`.
- [x] Found and fixed sitemap-quality issues before the real backfill:
      CSE India's and Mongabay India's top-level sitemap indexes mix real
      articles with org/programme/tag/author pages; repointed both at the
      specific sitemap files that contain only posts.
- [x] Ran a real backfill across all 6 sites: 316 full articles stored
      (153 Down To Earth, 90 Mongabay India, 64 CSE India, 7 Indian
      Express, 2 The Hindu — capped per-site so subsequent runs keep
      filling in history without hammering any server in one shot).
- [x] Web UI (`web/`): static, no backend. Loads `data/blogs.db` client-side
      via the **official SQLite Wasm build** (`@sqlite.org/sqlite-wasm`) —
      switched to it after discovering the popular `sql.js` package is
      compiled *without* FTS5, which would have silently broken search.
      Paginated article list (lazy: full article body only fetched from the
      DB on click), reader pane with sanitized HTML (DOMPurify), site
      filter, FTS5-backed search box supporting `AND` / `OR` / `NOT` /
      parentheses / `"phrases"`. Verified in-browser against the real 316-
      article database: search, filtering, and full-article reading all
      confirmed working.
- [x] Fixed a real data-loss risk found during testing: the scraper had
      been using SQLite's WAL journal mode, which keeps recent writes in a
      separate `-wal` file — since only `blogs.db` itself gets committed to
      git, any uncommitted WAL data would have been silently lost on every
      Action run. Switched to plain rollback-journal mode (single
      self-contained file); also required for the browser side, since
      `sqlite3_deserialize()` doesn't support WAL's shared-memory locking.
- [x] GitHub Actions workflow (`.github/workflows/scrape-and-deploy.yml`):
      daily cron (03:00 UTC) + manual "Run workflow" button. Scrapes, commits
      `data/blogs.db` back to the repo, then deploys `web/` + the db to
      GitHub Pages.
- [x] README.md with setup steps, site list, and "how to add a site" guide.

## Next / not started yet
- [ ] Push to the GitHub repo once you share the URL; enable Pages
      (Settings → Pages → Source → GitHub Actions) and Actions write
      permissions (Settings → Actions → General → Workflow permissions →
      Read and write) — both one-time manual steps, can't be done via git.
- [ ] Trigger the workflow once (push or manual "Run workflow") and confirm
      the Pages URL serves the live archive.
- [ ] Watch the first few scheduled runs to confirm no site is getting
      rate-limited or blocked (check Action logs for repeated errors).

## Known limitations (by design, documented in README)
- Indian Express: filtered by keyword-in-URL since article URLs don't
  encode category — best-effort, will miss some relevant articles.
- The Hindu / Frontline: pointed at each site's small rolling "recently
  updated" sitemap, not a full historical archive — the Frontline archive
  index is itself irregular (a `<urlset>` whose entries are actually more
  sitemap files, not articles), so a full historical crawl there would need
  bespoke handling; skipped for now in favor of the standard rolling feed.
- `indiaenvironmentportal.org.in` skipped entirely — its `robots.txt` bans
  all crawling.
