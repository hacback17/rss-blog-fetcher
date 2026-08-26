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

## Features

- **Tags, manual + automatic.** Every article is auto-tagged (up to 5 tags)
  during scraping by an LLM call (Groq), which is told to *reuse* existing
  tags rather than invent near-duplicates — see "Auto-tagging" below. You can
  also add/remove your own tags per article in the reader pane. Tags are a
  real many-to-many join (`tags` + `article_tags` tables), never duplicated
  per-article data. Click any tag in the left sidebar to filter.
- **Read/unread.** Opening an article marks it read (dot disappears from the
  list); a button in the reader pane lets you mark it unread again. "Unread
  only" checkbox in the toolbar.
- **Light/dark toggle.** The 🌓 button in the header cycles
  system → light → dark, remembered per-browser.
- **Export/import**, see "Portability" below.
- **Pattern analysis**, see "Intelligence-style pattern analysis" below.

### Auto-tagging

`scraper/src/autotag.js` calls Groq (`GROQ_API_KEY`) with the article's title
+ excerpt and the list of tags already used elsewhere in the archive, asking
it to pick up to 5 tags and strongly prefer reusing an existing one — this is
what keeps the tag list a small set of real categories (e.g. "Water Crisis",
"Air Pollution", "Data Centre") instead of one bespoke tag per article. If no
`GROQ_API_KEY` is set, it falls back to a small offline keyword-matching
tagger instead (less precise, but the feature still works with zero setup).

Get a free key at [console.groq.com/keys](https://console.groq.com/keys),
then add it as a repo secret: **Settings → Secrets and variables → Actions →
New repository secret**, name `GROQ_API_KEY`. Locally, `export
GROQ_API_KEY=...` before `npm run run`.

### Where read/tags/manual edits actually live

This is a static site with no backend, so there's no server for the browser
to write back to. The split:

- **Auto-tags** are written by the scraper into `data/blogs.db` directly —
  durable, synced everywhere, as soon as the daily Action runs.
- **Read/unread state and manually-added tags** are interactive, so they're
  written straight into the in-memory database your browser already loaded
  (instantly reflected everywhere in the UI — unread counts, tag sidebar,
  filters) *and* mirrored into an "overlay" in that browser's `localStorage`
  so they survive a page reload. This overlay is **per-browser** — it does
  not sync itself to other devices or back into the committed database.

To make browser-side changes durable/shared: **Data ⇅ menu → "Export my
read/tag state"** downloads a small JSON file. Either keep re-importing it on
each device (**Data ⇅ menu → Import**), or fold it permanently into the real
database once in a while:

```bash
cd scraper
npm run apply-overlay -- path/to/blog-archive-state.json
git add ../data/blogs.db && git commit -m "sync read/tag state" && git push
```

## Portability

- **Data ⇅ → "Download full database (.db)"** — the entire archive as one
  file. To use it on another machine: put it at `data/blogs.db` in a clone of
  this repo (or `web/data/blogs.db` for local preview) and everything works,
  since the whole app is just this one file plus static code. This is also
  your backup/restore mechanism — the file is a complete snapshot.
- **Data ⇅ → "Export JSONL (for LLM analysis)"** — one JSON object per line
  (`{id, url, title, author, site, published_at, tags, text}`), the friendliest
  shape for feeding into an LLM, notebook, or `jq`/`grep` pipeline. Generated
  client-side from whatever's currently loaded, so it always matches what
  you see in the archive (including your local read/tag overlay).
- The database itself is also directly queryable for the same purpose —
  `content_text` is clean, script-free plain text, and `tags`/`article_tags`
  give you structured categories without needing a full LLM export step:
  ```bash
  sqlite3 data/blogs.db "SELECT title, content_text FROM articles WHERE id IN
    (SELECT article_id FROM article_tags JOIN tags ON tags.id = tag_id WHERE tags.name = 'Water Crisis')"
  ```

## Intelligence-style pattern analysis

`scraper/src/analyze-patterns.js` pulls a filtered slice of the archive
(by tag / site / date, or the whole thing) and asks **Gemini** — chosen for
its large context window, so years of articles fit in one prompt — to
synthesize recurring themes, trends over time, repeated entities, and
emerging signals, with citations back to source articles. Output is a
Markdown report in `reports/`.

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
add it as repo secret `GEMINI_API_KEY`, then run the **"Analyze patterns
(Gemini)"** workflow from the Actions tab (optional inputs: tag, site, since
date, limit). It commits the report back to `reports/`. Locally:

```bash
cd scraper
GEMINI_API_KEY=... npm run analyze -- --tag="Water Crisis" --since=2024-01-01
```

## A note on long-term storage (years of data)

At the current pace (~500 articles ≈ 12MB), even 100,000 articles over many
years of daily scraping would land around 2-3GB — comfortably inside
GitHub's free, no-cost limits (repos are soft-capped around 1-5GB with no
hard block below that, and GitHub Pages sites up to 1GB). **No action needed
for years.** If it ever does become a problem, the fix doesn't require a paid
service: split `data/blogs.db` into one file per year
(`data/blogs-2028.db`, ...) loaded on demand by the web UI, or move older
years to GitHub Releases (2GB per file, effectively unlimited total, still
free). Worth revisiting only once the repo actually approaches a few GB —
not a reason to add complexity today.

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
