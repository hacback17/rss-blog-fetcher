# Blog Archive

A self-hosted tool that finds a site's sitemap, extracts the **full text** of
every blog post/article on it (not RSS snippets), stores everything in a
searchable local database, and shows it in a web reader. Runs automatically
once a day on GitHub Actions — no laptop required.

## How it works

```
scraper/   Node.js script: sitemap discovery → full-article extraction → SQLite
data/      blogs.db — the SQLite database (committed to the repo by the Action)
web/       static reader UI, runs entirely in the browser (no backend)
.github/workflows/scrape-and-deploy.yml   daily cron + manual "Run workflow" button
```

**No server, ever.** The GitHub Action scrapes new articles, writes them into
`data/blogs.db`, and commits it back to the repo. A second job in the same
workflow publishes `web/` + `data/blogs.db` to GitHub Pages. The page loads
the SQLite file with the [official SQLite Wasm build](https://sqlite.org/wasm)
(`@sqlite.org/sqlite-wasm` — chosen specifically because it has FTS5 compiled
in, unlike the more popular `sql.js` package) and runs all search/browsing
**client-side, in your browser** —
the whole archive is downloaded once and then queried locally, so browsing
and searching are instant and work offline after the first load.

Full-text search uses SQLite's **FTS5** engine, which natively supports
`AND`, `OR`, `NOT`, parentheses for grouping, and `"exact phrases"` — see the
`?` button next to the search box in the UI.

## One-time setup

1. **Push this repo to GitHub** (already wired up once you gave me the repo URL).
2. **Enable GitHub Pages**: repo → Settings → Pages → Source → **GitHub Actions**.
3. **Enable Actions write permissions**: repo → Settings → Actions → General →
   Workflow permissions → **Read and write permissions** (needed so the
   Action can commit `data/blogs.db` back to the repo).
4. Push to `main` once, or click **Run workflow** on the
   "Scrape blogs and deploy archive" Action tab to run it manually the first
   time.

After that, it runs automatically every day at 03:00 UTC. You can also click
**Run workflow** any time you want fresh data immediately — the scraper skips
anything it already has (by URL) and skips sitemap files that haven't changed
since the last run, so extra manual runs don't re-download things or hammer
the source sites.

## Running the scraper locally (optional)

```bash
cd scraper
npm install
npm run run
```

This updates `data/blogs.db` in place. Open `web/index.html` via a local
static server (not `file://`, since the browser needs to `fetch()` the `.db`
file) to preview:

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

## Sites currently tracked

Configured in [`scraper/config/sites.json`](scraper/config/sites.json):

| Site | Notes |
|---|---|
| Down To Earth | full sitemap, backfills gradually (years of daily sitemap files) |
| CSE India | pointed at `articles.xml` specifically — the site's main `sitemap.xml` also lists org/programme pages, which aren't articles |
| Mongabay India | pointed at the `post-sitemap*.xml` + `short-article-sitemap.xml` files specifically, for the same reason |
| Indian Express | filtered to the Google News sitemap + a keyword allowlist (climate, environment, pollution, forest, ...) since article URLs don't encode category — best-effort, may miss some relevant articles |
| The Hindu | filtered to the "Energy & Environment" section path |
| Frontline | filtered to the "Environment" section path |

**Not tracked** — these don't fit a sitemap-driven full-article scraper, see
`excludedSites` in `sites.json` for why: MoEF annual reports (PDF listing,
not HTML posts), Global Forest Watch dashboards (JS app, no articles),
PIB `AllFactsheet.aspx` (dynamic page, no real sitemap),
indiaenvironmentportal.org.in (its `robots.txt` disallows all crawling —
respected), Reporters' Collective project page (single page, not a blog).

### Adding a new site

Add an entry to the `sites` array in `scraper/config/sites.json`:

```json
{
  "id": "unique-id",
  "name": "Display Name",
  "baseUrl": "https://example.com",
  "sitemapUrls": ["https://example.com/sitemap.xml"],
  "includePathPrefixes": ["/blog/"],
  "includeKeywords": ["optional", "url-slug", "keyword", "filter"]
}
```

`includePathPrefixes` / `includeKeywords` are optional — omit them to pull
everything the sitemap lists. If a site's sitemap mixes articles with other
page types (common on WordPress/Drupal sites — category pages, author pages,
static pages), check `curl https://example.com/sitemap.xml` first and point
`sitemapUrls` at the specific child sitemap(s) that only contain posts
(commonly named `post-sitemap.xml`, `articles.xml`, `news-sitemap.xml`, etc.),
the same way CSE India and Mongabay are configured above.

## Politeness / not burdening servers

- Each site's `robots.txt` is fetched and respected (`Disallow` rules).
- Requests go out with a delay (default 700ms) and low concurrency (default 2).
- Articles already stored are never re-fetched unless the sitemap's
  `<lastmod>` for that URL changed.
- Large, date-partitioned sitemap indexes (e.g. one file per day, years deep)
  are walked newest-first with a per-run budget, and unchanged sitemap files
  are skipped entirely on later runs — so a huge historical archive gets
  backfilled gradually over many days instead of being hammered in one run.
- A `maxNewPerSiteRun` cap (default 80) bounds how many *new* article fetches
  happen per site per run.
