# Blog Archive

A self-hosted tool that finds a site's sitemap (or RSS feed), extracts the
**full text** of every blog post/article on it (not snippets), stores
everything in a searchable, taggable local database, and shows it in a web
reader with an AI Q&A chat over your own data. Runs automatically once a day
on GitHub Actions — no laptop required.

## How it works

```
scraper/                Node.js: sitemap/RSS discovery → full-article extraction → SQLite → auto-tag
data/blogs.db            the SQLite database (committed to the repo by the Action)
reports/                 Markdown pattern-analysis reports (see "Intelligence-style pattern analysis")
web/                     static reader + topic graph + Ask-your-archive UI, runs in the browser (no backend)
.github/ISSUE_TEMPLATE/   add-site.yml, add-article.yml, remove-site.yml issue forms
.github/workflows/
  scrape-and-deploy.yml    daily cron + manual "Run workflow" button
  add-site.yml             turns an "Add a source" issue into a live source
  add-article.yml          turns an "Add an article" issue into fetched article(s)
  remove-site.yml          turns a "Remove a source" issue into a config change
  analyze-patterns.yml     on-demand Gemini pattern analysis
  deploy.yml               shared "publish to Pages" step the other five call
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

- **Tags + keywords, manual + automatic.** Every article gets up to 5 broad
  category **tags** (e.g. "Water Crisis", "Data Centre") auto-assigned by an
  LLM call during scraping, told to *reuse* existing tags rather than invent
  near-duplicates — this is what keeps the sidebar a small set of real
  categories instead of one bespoke tag per article. Separately, it also
  extracts up to 12 specific, uncapped **keywords** (named entities, places,
  projects, technical terms) purely to sharpen search and the "Ask your
  archive" retrieval below — see "Auto-tagging" for why these are two
  different, differently-capped things. You can also add/remove your own
  tags per article in the reader pane. Tags are a real many-to-many join
  (`tags` + `article_tags` tables), never duplicated per-article data. Click
  any tag in the left sidebar to filter.
- **Read/unread.** Opening an article marks it read (dot disappears from the
  list); a button in the reader pane lets you mark it unread again. "Unread
  only" checkbox in the toolbar.
- **Date range filter.** "From"/"To" date pickers in the toolbar constrain
  every list/search result to that window (combines with search, tag, site,
  and unread filters — all are ANDed together).
- **Recent searches.** The last 8 searches you've run show as clickable chips
  under the search box — click one to re-run it instantly. Saved in
  `localStorage`, so they survive a full page reload (not tied to a session).
- **Light/dark toggle.** The 🌓 button in the header cycles
  system → light → dark, remembered per-browser.
- **Topic graph** — an Obsidian-style interactive graph of tags and how they
  co-occur, drilling into an article-level graph per tag. See "Topic graph"
  below.
- **Ask your archive** — an AI Q&A chat over your own data, see "Ask your
  archive" below.
- **Tension finder** — surfaces genuine contradictions and surprising gaps
  across recent articles, for curiosity-driven storytelling rather than a
  news summary. See "Tension finder" below.
- **Local AI app access (MCP server)** — lets a locally-installed Claude
  Desktop app search/read the archive directly, no copy/paste. See "Local AI
  app access" below.
- **Sources panel** — lists every configured site with the exact sitemap/RSS
  URLs it's using, and links to add/remove a source. See "Adding a source".
- **Scraping log** — rolling 7-day history of every run, per site, with
  counts and the actual titles found. See "Scraping log".
- **Add pasted text or a file** (Data ⇅ menu → "＋ Add pasted text or a
  file") — paste text or load a `.txt`/`.md` file and it's stored as a
  regular article (source "My Notes"): searchable, taggable, and included
  in "Ask your archive" retrieval exactly like scraped content. Useful for
  folding in a report, a meeting note, or anything else you want the
  archive (and its AI Q&A) to know about that isn't published anywhere
  scrapable. Lives in the browser overlay like read/tag state — see
  "Where read/tags/manual edits actually live" for making it durable.
- **Add article(s) by URL** (Data ⇅ menu → "＋ Add article(s) by URL") — for
  one specific article you already have the link to, rather than an entire
  site. Fetches and extracts full text through the same pipeline as regular
  scraping (durably, into the real database — not the browser overlay, so
  no export/sync step needed). See "Adding a source" for how this works
  (same issue-based mechanism, since fetching arbitrary pages needs a real
  server-side fetch, which a static page can't reliably do — most sites
  don't allow direct browser-to-site calls from another origin).
- **Export/import**, see "Portability" below.
- **Pattern analysis**, see "Intelligence-style pattern analysis" below.

### Auto-tagging

`scraper/src/autotag.js` calls Groq (`GROQ_API_KEY`) with the article's title
+ excerpt and the list of tags already used elsewhere in the archive, asking
it for two different things in one call:

- **tags** — up to 5, told to strongly prefer reusing an existing tag. This
  is what keeps the tag list small and reusable instead of exploding into a
  bespoke tag per article — the original design goal for the grouping UI.
- **keywords** — up to 12, specific rather than broad (people, orgs, places,
  projects, laws, species...). These aren't capped tightly like tags because
  they serve a different purpose: precision search and retrieval quality for
  "Ask your archive", where more specific signal only helps. They never show
  up as their own grouping UI, so they can't cause the "lots of small
  groups" problem tags were capped to avoid.

If no `GROQ_API_KEY` is set, it falls back to a small offline keyword-matching
tagger instead (less precise, but the feature still works with zero setup).

Get a free key at [console.groq.com/keys](https://console.groq.com/keys),
then add it as a repo secret: **Settings → Secrets and variables → Actions →
New repository secret**, name `GROQ_API_KEY`. Locally, `export
GROQ_API_KEY=...` before `npm run run`.

Calls are internally paced (a few seconds apart) to stay under the free
tier's tokens-per-minute limit regardless of scraper concurrency. There's
also a separate tokens-*per-day* cap (200k as of writing) — a very large
single-day backfill across every site could exhaust it, in which case the
remaining articles that day just silently get the offline keyword tags
instead (never a crash). Since already-scraped articles aren't re-tagged
automatically (only new/changed ones are), a one-off re-tag pass like the
loop below is the way to upgrade any keyword-tagged articles once a key is
in place:

```bash
cd scraper
GROQ_API_KEY=... node -e "
import('./src/db.js').then(async ({ openDb, listExistingTagNames, setAutoTags }) => {
  const { generateTags } = await import('./src/autotag.js');
  const db = openDb('../data/blogs.db');
  for (const row of db.prepare('SELECT id, title, content_text FROM articles').all()) {
    setAutoTags(db, row.id, await generateTags(row, listExistingTagNames(db)));
  }
  db.close();
});
"
```

### Where read/tags/manual edits actually live

This is a static site with no backend, so there's no server for the browser
to write back to. The split:

- **Auto-tags** are written by the scraper into `data/blogs.db` directly —
  durable, synced everywhere, as soon as the daily Action runs.
- **Read/unread state, manually-added tags, and pasted/imported text** are
  all interactive, so they're written straight into the in-memory database
  your browser already loaded (instantly reflected everywhere in the UI —
  unread counts, tag sidebar, filters, search) *and* mirrored into an
  "overlay" in that browser's `localStorage` so they survive a page reload.
  This overlay is **per-browser** — it does not sync itself to other
  devices or back into the committed database.

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

## Topic graph

The 🕸 Graph button opens an Obsidian-style interactive graph — but of
**tags**, not individual articles: with a thousand-plus articles, a graph of
every article as its own node is an unreadable hairball, while the tag
vocabulary is deliberately kept small (see "Auto-tagging"), so it's the level
that actually shows structure. Nodes are tags sized by how many articles
carry them; edges connect tags that co-occur on the same articles, weighted
by how often. It's computed live from `tags`/`article_tags` on every open —
there's nothing to precompute or keep in sync, so it automatically reflects
whatever's been scraped/tagged/added so far, no rebuild step.

Click a tag to zoom into just its articles. Two kinds of node are drawn, and
they stay visually distinct at any zoom level:

- **Hub nodes** (purple) are topics. At the top level these are all your
  tags, sized by how many other tags they co-occur with, edged to only each
  tag's 3 strongest co-occurrences (not every pair) so it doesn't collapse
  into a hairball. Click one to zoom into just that tag. Hovering a hub also
  declutters the view: only its own name and its direct neighbors' names are
  shown, every other label disappears until you move on.
- **Leaf nodes** (green) are individual articles. They're always the same
  small size and color, and always show their title, not just on hover.

Zooming into a tag shows that tag as a hub with its articles as leaves — but
for a big tag (hundreds of articles), leaves spoking directly off one point
all look identical and carry no information. So when several articles in the
set also share some *other* tag, that tag becomes its own small sub-hub
(e.g. inside "Biodiversity," articles also tagged "Wildlife Conservation"
cluster around their own sub-hub, separate from ones also tagged "Water
Resources") — the sub-hub's label is the visible answer to "why are these
particular ones grouped." Sub-hubs are capped at each tag's 15 largest
groupings (3+ shared articles) so it stays legible even on huge tags, and
any article with no qualifying sub-group still connects straight to the main
hub. Crucially, **sub-hubs aren't a further drill-in target** — clicking one
does nothing, only the top-level tag graph lets you zoom deeper — so this
stays "flat" in the sense that matters: you never get confusing
cluster-inside-cluster navigation, just one screen with real structure on
it. Click a leaf to open that article in the reader.

Drag to pan, scroll/pinch to zoom, drag a node to reposition it — it's a
small hand-rolled canvas force simulation (no charting library) with enough
node repulsion, size-aware collision resolution, and edge pruning that
nodes keep real breathing room instead of visually overlapping or touching,
themed to match light/dark mode.

## Ask your archive

The 💬 Ask button opens a chat panel that answers questions using your
archived articles as its only source of truth:

1. Your question is turned into a broad full-text search (title, body, and
   the `keywords` column) run **locally in your browser** against the SQLite
   database already loaded — instant, no network call.
2. The top ~12 matches are bundled into a prompt telling the model to answer
   *only* from those articles and cite them as `[1]`, `[2]`, etc.
3. That prompt goes to whichever AI provider you've configured (⚙ in the
   panel) — the answer and its sources are shown in the chat.

**Three provider options**, all configured client-side (⚙ settings, stored
only in your browser's `localStorage`, sent directly from your browser to
that provider — never touches the repo or any server of ours):

- **Groq** — paste a free key from [console.groq.com/keys](https://console.groq.com/keys).
- **Gemini** — paste a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **Local** — point it at any locally-running **OpenAI-compatible** server
  (the `/v1/chat/completions` endpoint that tools like [LM Studio](https://lmstudio.ai)
  or [Ollama](https://ollama.com) (in OpenAI-compat mode) expose), plus the
  model name it's serving. This keeps everything fully offline and free —
  no API key, no per-query cost, and your questions never leave your Mac.
  **Note:** this needs the local tool to actually expose that kind of local
  network server. LM Studio and Ollama do; if you're using something like
  Locally AI that's built as a self-contained app without one, this option
  won't have anything to connect to — in that case Groq's free tier is the
  easiest path to something working today.

Both Groq's and Gemini's APIs allow direct browser calls (verified this
directly — no proxy/backend needed, which is what makes a fully static site
able to do this at all).

**A fourth option that isn't really an "option" so much as a bridge:
"⧉ Copy prompt".** The ChatGPT and Claude *desktop apps* don't expose a
local server the way LM Studio/Ollama do, so there's no way for this page to
call into them directly. Instead, "⧉ Copy prompt" does the same
retrieval step and builds the same prompt, but puts it on your clipboard
instead of calling an API — paste it into ChatGPT, Claude, claude.ai, or
anything else, using whichever of those you already have open, at no
per-query cost. The prompt itself is also fully editable: ⚙ settings has a
**"Prompt template"** field (`{{articles}}` / `{{question}}` placeholders)
used by every provider *and* by "Copy prompt", so your own specially-crafted
instructions apply everywhere, not just when copying.

## Tension finder

The ⚡ Tensions button is a different question than "Ask": instead of
answering something you type, it looks at a set of recent articles and asks
the AI to find **genuine tensions** in them — a surprising stat, a gap
between a headline claim and lived/on-the-ground reality, a contradiction
between two sources, an overlooked consequence. That's the actual raw
material curiosity-driven storytelling looks for, as opposed to "here's
what happened this week."

1. Pick a **scope** — last 7/14/30 days, or the most recent 25 regardless of
   date — and optionally narrow it to one **tag**.
2. It pulls that set of articles (title, excerpt, tags) and sends them to
   the AI with a prompt that explicitly says not to manufacture a tension
   that isn't really there, and to return only what's genuine (as few as
   zero) rather than padding the list.
3. Each result renders as a card: a short curious **hook**, the two
   contrasting **claims** (each linking back to its source article), and one
   line on **why** it's a real tension, not just two unrelated facts.

It reuses the exact same AI provider settings as "Ask your archive" (⚙ in
that panel) — no separate setup. If nothing's configured yet, it'll point
you there.

**A note on the Groq model:** `openai/gpt-oss-20b` is a reasoning model —
without `reasoning_effort: "low"` set on the request, it can burn its entire
completion budget on hidden reasoning tokens and return genuinely empty
content (`finish_reason: "length"`, 0 visible output). This was already
worked around on the scraper side (`autotag.js`) but had been missed in the
browser's `callProvider()`, silently affecting Ask too. Fixed here — both
features now set it. Verified directly against the real Groq API before and
after: the unfixed call returned 0 characters of content with 2046
reasoning tokens burned; the fixed call returned real content immediately
(`finish_reason: "stop"`).

## Local AI app access (MCP server)

"Copy prompt" above is a manual bridge — you still have to paste. If you want
your **locally-installed Claude Desktop app** to search and read this archive
itself, on its own, without you copying anything, this repo also ships a
small [MCP](https://modelcontextprotocol.io) server: `scraper/src/mcp-server.js`.
It runs locally, reads `data/blogs.db` directly (read-only queries — it never
writes to the file), and exposes five tools: `search_archive` (same
AND/OR/NOT full-text search as the web UI), `get_article`, `list_recent_articles`,
`list_tags`, and `list_sources`.

**Setup (one-time):**

1. Make sure you've run `npm install` in `scraper/` at least once (installs
   the MCP SDK).
2. Open Claude Desktop's config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Add an entry under `mcpServers` (create the file/key if it doesn't exist),
   using the **absolute path** to this repo on your machine:
   ```json
   {
     "mcpServers": {
       "blog-archive": {
         "command": "node",
         "args": [
           "--experimental-sqlite",
           "/absolute/path/to/RSS_Data/scraper/src/mcp-server.js"
         ]
       }
     }
   }
   ```
4. Restart Claude Desktop. It should list "blog-archive" under its available
   tools/connectors — from then on you can just ask Claude Desktop things
   like "search my blog archive for articles about water scarcity in India"
   and it calls the tool itself, no copy/paste, no API key, fully offline
   (it's reading the same `data/blogs.db` file the web UI does).

**Honest limitation on ChatGPT and Perplexity:** as of when this was built,
neither the ChatGPT desktop app nor the Perplexity desktop app supports
connecting to an arbitrary local MCP server the way Claude Desktop does —
ChatGPT's MCP/connector support is aimed at *hosted* servers with OAuth, not
a local `stdio` process like this one, and Perplexity's desktop app doesn't
expose an equivalent local-tool mechanism at all. If that changes, this same
server should work for them too (MCP is meant to be app-agnostic). Until
then, for ChatGPT/Perplexity the practical options are still "⧉ Copy prompt"
above, or the "⬇ Export JSONL" button (⇅ Data menu) if you want to hand them
a file to search over manually.

## Respecting robots.txt

Off by default in the sense that matters: **`robots.txt` is respected unless
you explicitly turn that off**, globally (`respectRobotsTxt` in
`scraper/config/sites.json`) or per-site. This is left as your call rather
than silently decided — you know the sites you're archiving and your own
reasons better than a default can. If you do turn it off for a site, that's
an informed choice you're making, not something the tool nudges you toward;
worth knowing that some sites' terms of service independently restrict
automated access regardless of what robots.txt says, which turning this flag
off doesn't change.

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
5. *(Optional, can do anytime)* Add `GROQ_API_KEY` and/or `GEMINI_API_KEY` as
   repo secrets — Settings → Secrets and variables → Actions — to enable
   real auto-tagging and the pattern-analysis workflow. Nothing breaks
   without them (auto-tagging falls back to offline keyword-matching), it's
   just lower quality until they're set.

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

This updates `data/blogs.db` in place.

**To preview locally:** `web/` is served from GitHub Pages in production,
which is a different origin than your local files — a browser opened
straight at `web/index.html` (a `file://` URL) can't `fetch()` the database,
sites config, or reports next to it (that's the "Failed to load database:
SQLITE_CANTOPEN" error if you've hit it), and those files aren't checked
into git in the first place (`web/data/`, `web/reports/` are gitignored —
only `data/blogs.db` and `reports/` at the repo root are tracked). One
command handles both: copies the current database/config/reports into
`web/` and serves it:

```bash
cd scraper
npm run preview
```

This also **pulls the latest data from GitHub first** (a safe `git pull
--ff-only` — it refuses rather than merging if your local history has
diverged, and skips entirely if you have uncommitted local changes, so it
can't clobber anything) and **opens your browser automatically**, so the
above is the only thing you need to run to see the current archive,
including whatever the daily Action added since you last looked. Re-run it
any time; or on macOS, double-click **`preview.command`** at the repo root
instead of opening a terminal at all.

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
| Scroll.in | **unfiltered — all topics, not just environment** (deliberate choice: Scroll's environment coverage doesn't sit under a clean URL path/keyword the way the others do, and the broader range fits). Uses its Google News-format sitemap, which only ever carries roughly the last day or two of articles — this is a rolling recent-news feed, not a backfillable historical archive |

**Not tracked** — these don't fit a sitemap-driven full-article scraper, see
`excludedSites` in `sites.json` for why: MoEF annual reports (PDF listing,
not HTML posts), Global Forest Watch dashboards (JS app, no articles),
PIB `AllFactsheet.aspx` (dynamic page, no real sitemap),
indiaenvironmentportal.org.in (its `robots.txt` disallows all crawling —
respected), Reporters' Collective project page (single page, not a blog).

### Adding a source

**Option A — from the repo's Issues tab (recommended, no laptop needed):**
open a new issue using the **"Add a source"** template. Fill in the name,
base URL, and optionally a sitemap/RSS URL (leave both blank and it tries to
auto-discover a sitemap from the site's `robots.txt`). Submitting it:

1. Adds the site to `scraper/config/sites.json` and commits it.
2. Immediately runs a first scrape for just that site (doesn't wait for the
   next scheduled run).
3. Comments the result on the issue and closes it.
4. Redeploys the live site.

It'll be part of the regular daily run from then on. (Restricted to the repo
owner/collaborators, since it commits to the repo and spends API quota —
see `.github/workflows/add-site.yml` if you want to loosen that.)

**Option B — edit the config directly:** add an entry to the `sites` array in
`scraper/config/sites.json`:

```json
{
  "id": "unique-id",
  "name": "Display Name",
  "baseUrl": "https://example.com",
  "sitemapUrls": ["https://example.com/sitemap.xml"],
  "rssUrls": ["https://example.com/feed"],
  "includePathPrefixes": ["/blog/"],
  "includeKeywords": ["optional", "url-slug", "keyword", "filter"],
  "respectRobotsTxt": false
}
```

`sitemapUrls`, `rssUrls`, `includePathPrefixes`, `includeKeywords`, and
`respectRobotsTxt` are all optional. Provide `sitemapUrls` and/or `rssUrls`
— **RSS/Atom feeds work as a discovery source too**: the feed only needs to
list article links (even if it carries just snippets), since every URL still
gets run through the same full-Readability-extraction pipeline as sitemap
URLs — this is exactly the sites the original RSS-reader pain point was
about, sites that *do* publish a feed but only ever put snippets in it.

If a site's sitemap mixes articles with other page types (common on
WordPress/Drupal sites — category pages, author pages, static pages), check
`curl https://example.com/sitemap.xml` first and point `sitemapUrls` at the
specific child sitemap(s) that only contain posts (commonly named
`post-sitemap.xml`, `articles.xml`, `news-sitemap.xml`, etc.), the same way
CSE India and Mongabay are configured above.

The web UI's **🔗 Sources** panel always shows exactly what's configured
right now (name + every sitemap/RSS URL in use), with a one-click export of
the underlying `sites.json`, and direct links to the add/remove issue forms.

### Removing a source

Same idea, in reverse: open a **"Remove a source"** issue (linked from the
🔗 Sources panel, or the Issues tab) with the site's id — the short lowercase
id from the Sources panel or `sites.json`, e.g. `downtoearth`, not the
display name. **Already-scraped articles are kept by default** — removing a
source only stops future scraping of it; there's an explicit opt-in checkbox
if you actually want its historical articles deleted too. Locally:

```bash
cd scraper
npm run remove-site -- downtoearth              # keeps existing articles
npm run remove-site -- downtoearth --delete-articles   # also deletes them
```

### Adding a single article by URL

For one article you already have the link to — not a whole site. Open an
**"Add an article"** issue (one URL per line, multiple at once is fine) or
locally:

```bash
cd scraper
npm run add-article -- https://example.com/some-article
npm run add-article -- https://example.com/a https://example.com/b --tags="Follow Up"
```

It runs the exact same extraction/auto-tagging pipeline as regular scraping.
If the URL's site is already configured, the article joins that source; if
not, it gets its own bucket named after the domain (e.g. `en.wikipedia.org`).
This writes straight to the real, committed database — unlike "Add pasted
text", there's no browser-overlay/sync step involved.

### Substack (and other newsletters)

No special handling needed — Substack publications expose a standard RSS
feed at `https://<publication>.substack.com/feed` (or the equivalent path if
they've moved to a custom domain), which is exactly what the existing RSS
support handles. Add it like any other source: `rssUrls: ["https://
example.substack.com/feed"]` (Option B) or paste that URL into the RSS field
of the "Add a source" issue form (Option A). Verified this directly against
a real, currently-publishing Substack — feed parsing and full-text extraction
both worked cleanly with zero code changes.

Paid-subscriber-only posts are handled correctly by construction, not by any
special-casing on our end: Substack's own feed simply omits them or includes
only a preview for logged-out requests, so this naturally only ever picks up
what's actually publicly published — there's no way (and no attempt) to
bypass a paywall here.

You also don't need a special once-a-week schedule for a weekly newsletter —
the daily job already dedupes by URL and by the feed's own per-item
timestamp, so checking daily for something that publishes weekly just means
6 cheap "nothing new" checks and 1 real one; it doesn't re-fetch or
re-extract anything that hasn't changed.

## Scraping log

The 📋 Log button shows a **rolling 7-day log**, one entry per site per run:
timestamp, status, how many URLs were discovered, how many were new/updated,
error count, and (click to expand) the actual titles of what was added. This
is specifically for answering "is scraping still working, and when did it
last actually find something" without digging through GitHub Actions run
history — if a source goes quiet for several days running, that's usually a
sign the site changed something (moved its sitemap, changed its HTML layout)
rather than the tool simply having nothing new to report. Older entries are
pruned automatically (each run deletes anything past 7 days), so this stays
small and fast to load rather than becoming a permanent audit trail.

## Politeness / not burdening servers

- Each site's `robots.txt` is fetched and respected (`Disallow` rules) by
  default — see "Respecting robots.txt" for the opt-out.
- Requests go out with a delay (default 700ms) and low concurrency (default 2).
- Articles already stored are never re-fetched unless the sitemap's
  `<lastmod>` for that URL changed.
- Large, date-partitioned sitemap indexes (e.g. one file per day, years deep)
  are walked newest-first with a per-run budget, and unchanged sitemap files
  are skipped entirely on later runs — so a huge historical archive gets
  backfilled gradually over many days instead of being hammered in one run.
- A `maxNewPerSiteRun` cap (default 80) bounds how many *new* article fetches
  happen per site per run.
