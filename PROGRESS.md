# Progress

## Status: pushed to GitHub, live features verified against real data

Repo: https://github.com/hacback17/rss-blog-fetcher

## Done — v1 (scraper, storage, search UI)
- [x] Scraper (Node.js, `scraper/`): robots.txt-aware sitemap discovery →
      Mozilla Readability full-article extraction → SQLite (`node:sqlite`,
      built-in, no native build step) with FTS5 full-text index.
- [x] Politeness: delay + low concurrency, per-URL dedup via `<lastmod>`,
      bounded/newest-first traversal of large date-partitioned sitemap
      indexes so a huge historical archive backfills gradually instead of
      being crawled in one shot.
- [x] Investigated all 13 URLs the user listed; 6 are usable via
      sitemap-driven full-article scraping, 5 are not (see README "Not
      tracked" table for why). Recorded in `scraper/config/sites.json`.
- [x] Found and fixed sitemap-quality issues: CSE India's and Mongabay
      India's top-level sitemap indexes mix real articles with
      org/programme/tag/author pages; repointed both at the specific
      sitemap files that contain only posts.
- [x] Web UI (`web/`): static, no backend, loads `data/blogs.db` client-side
      via the **official SQLite Wasm build** (`@sqlite.org/sqlite-wasm`) —
      switched to it after discovering `sql.js` ships without FTS5.
      FTS5-backed search box supporting `AND`/`OR`/`NOT`/parentheses/phrases.
- [x] Fixed a data-loss risk: scraper was using WAL journal mode, whose
      writes live in a separate `-wal` file that never gets committed.
      Switched to plain rollback-journal mode.
- [x] GitHub Actions workflow: daily cron + manual "Run workflow" button,
      commits `data/blogs.db`, deploys `web/` to GitHub Pages.
- [x] Pushed to https://github.com/hacback17/rss-blog-fetcher (root commit
      `35f6ef6`).

## Done — v2 (tags, read state, theming, portability, LLM analysis)
- [x] **Tags** — real many-to-many schema (`tags` + `article_tags`, never
      duplicated per-article). Auto-tagged during scraping via Groq
      (`scraper/src/autotag.js`), capped at 5 tags/article, prompted to
      reuse existing tags over inventing near-duplicates. Falls back to an
      offline keyword tagger with zero setup if no `GROQ_API_KEY`. Verified
      live against the real Groq API (see "issues found" below).
- [x] **Read/unread** — opening an article marks it read; toggle button to
      revert; "unread only" filter; dot indicator in the list.
- [x] **Light/dark toggle** — 🌓 button, cycles system → light → dark,
      persisted per-browser.
- [x] **Manual tagging** in the reader pane (add/remove chips), left sidebar
      tag list with counts, click-to-filter.
- [x] **Portability**: one-click "download full .db" (complete backup/
      transfer file), one-click JSONL export (LLM/analysis-friendly), plus
      the database itself is directly SQL-queryable for the same purpose.
- [x] **State sync design**: since there's no backend, read/unread + manual
      tags are written directly into the browser's in-memory SQLite (so
      pagination/filters/counts all stay consistent immediately) *and*
      mirrored into a `localStorage` "overlay" JSON for persistence across
      reloads. Export/import that overlay between browsers, or fold it
      permanently into the real database with
      `scraper/src/apply-overlay.js`. Documented in README "Where read/tags/
      manual edits actually live".
- [x] **Intelligence-style pattern analysis** (`scraper/src/analyze-patterns.js`
      + `.github/workflows/analyze-patterns.yml`): pulls a filtered slice of
      the archive (tag/site/date), asks **Gemini** to synthesize recurring
      themes, trends over time, entities, emerging signals, and
      contradictions, with citations back to source articles. Ran for real
      against 20 "Water Crisis"-tagged articles spanning 2018–2026 — output
      quality is genuinely good (see `reports/2026-08-26-water-crisis.md`).
      Minimal in-app "Reports" viewer added to the web UI.
- [x] Storage-scaling question answered in README rather than
      over-engineered now: current pace (~500 articles ≈ 12MB) would take
      many years to approach GitHub's free limits; the fix if it ever
      matters (split by year / GitHub Releases) doesn't need paid hosting.

### Issues found and fixed while wiring up the LLM calls (both keys were
### already present in the shell environment, so this was tested live)
- Hardcoded Groq model (`llama-3.3-70b-versatile`) no longer exists on
  Groq's catalog — switched to `openai/gpt-oss-20b`.
- That model is a reasoning model and was burning hundreds of hidden
  "thinking" tokens per call, blowing through the free tier's 8000
  tokens/minute limit almost immediately → added `reasoning_effort: "low"`,
  trimmed the prompt (vocabulary list and excerpt length), and added an
  internal request queue in `autotag.js` that paces all Groq calls to a
  safe minimum interval regardless of scraper concurrency.
- Client-side bug: `sqlite3_deserialize()` was missing the
  `SQLITE_DESERIALIZE_RESIZEABLE` flag, so any write into the browser's
  in-memory database (adding a tag, marking read) failed with
  `SQLITE_FULL` once the buffer needed to grow. Fixed.
- Two "unused bind parameter" crashes in `web/app.js` (sqlite3-wasm's
  `bind()` throws if an object key isn't an actual `$param` in the SQL
  text) — found via live UI testing, fixed by giving count queries and
  list queries their own parameter objects instead of sharing one.
- Default Gemini model name needed correcting live (`gemini-2.5-flash` has
  been retired for new callers) → `gemini-3.6-flash`.
- Backfilled tags for the whole existing archive with the corrected
  pipeline (see below) instead of leaving early low-quality keyword-only
  tags in place.

## Done — cleanup
- [x] Re-tagged the full archive (759 articles) with the corrected Groq
      pipeline: 42 consolidated tags, ~3.8 tags/article average, good reuse
      across the vocabulary. Committed and pushed.
- [x] Fixed a shell-arg bug in `analyze-patterns.yml`: tag names with
      spaces (e.g. "Water Crisis") would have broken the unquoted arg
      splice; switched to env vars + a proper bash array.
- [x] Discovered and documented a real operational limit: Groq's free tier
      has a tokens-*per-day* cap (200k) in addition to per-minute — a very
      large single-day backfill could exhaust it (graceful degradation to
      keyword tags, never a crash). Documented the one-off re-tag command
      to upgrade any keyword-tagged articles later.

## Done — v3 (robots toggle, RSS, keywords, Ask/RAG, add-site issue-ops)
- [x] **robots.txt toggle**: respected by default; `respectRobotsTxt: false`
      (global or per-site in `sites.json`) opts out explicitly — left as the
      user's informed choice rather than decided for them.
- [x] **RSS/Atom as a discovery source** (`scraper/src/rss.js`): merged into
      the same candidate pipeline as sitemap URLs — a feed only needs to
      list links, every one still gets full Readability extraction, so this
      directly covers the original "RSS only gives snippets" complaint for
      sites that do publish a feed.
- [x] **Keywords**: added a second, uncapped LLM-extracted field alongside
      the capped tags — specific entities/terms for search/retrieval
      precision, indexed into FTS5. Required an FTS5 schema migration
      (drop/recreate + rebuild, tracked via a new `schema_meta` table) since
      virtual tables can't just get an ALTER TABLE ADD COLUMN. Verified
      against the real 759→983-article database: migration ran cleanly,
      integrity check passed, FTS row count matched, search still worked.
- [x] **"Ask your archive"** — client-side RAG chat: FTS5 retrieval (broad
      OR-based recall) → prompt with citation instructions → user's choice
      of Groq / Gemini / a local OpenAI-compatible server (LM Studio/Ollama-
      style — flagged that this assumes the local tool exposes that kind of
      server, since I couldn't confirm "Locally AI" specifically does).
      Verified direct browser→Groq and browser→Gemini calls aren't CORS-
      blocked (checked for real, not assumed) before building this
      architecture. Settings/keys live only in browser localStorage.
- [x] **Sources panel** — lists every configured site's exact sitemap/RSS
      URLs (fetched from a `data/sites.json` copy the deploy step publishes
      alongside the database), plus a one-click config export.
- [x] **"Add a source" issue-ops flow**: an Issue Form
      (`.github/ISSUE_TEMPLATE/add-site.yml`) + workflow
      (`add-site.yml`) that parses the issue, appends to `sites.json`,
      commits, runs an immediate scoped first-scrape (`run.js --site=<id>`),
      comments the result back, closes the issue, and redeploys — "add a
      site → pulls instantly → joins the daily run" with no backend.
      Restricted to repo owner/collaborators (it spends API quota and
      commits to the repo) and both shell-injection points (issue body,
      user-entered display name) routed through env vars rather than direct
      YAML interpolation. Factored the "publish to Pages" steps into a
      shared reusable workflow (`deploy.yml`) since three workflows now need
      them.
- [x] Tested live end-to-end: schema migration on the real DB, `--site=`
      CLI filter (including the "no such site" error path), the issue-body
      parser against a realistic GitHub Issue Form rendering (including
      sitemap auto-discovery), and the full scraper run with the new
      robots-toggle/RSS/keywords code paths — all clean, no regressions.

## Done — v4 (local preview fix, paste/import text)
- [x] User reported local preview showing "SQLITE_CANTOPEN" with no data —
      expected: `web/data/` and `web/reports/` are gitignored dev-convenience
      copies that only exist on whichever machine ran the scraper/tests, not
      the user's fresh clone. Fixed properly instead of just explaining it:
      added `npm run preview` (`scraper/src/preview.js`) which copies
      `data/blogs.db` + `sites.json` + `reports/` into `web/` and serves it
      with a small built-in static server (correct MIME types, no `python3`
      dependency) — one command instead of manual copying. Verified working
      end-to-end from a clean state (deleted `web/data/` and `web/reports/`
      first, confirmed the command recreates both).
- [x] Verified no duplicate content: 983 rows, 983 distinct URLs (`url` has
      a UNIQUE constraint, so it's structurally impossible, but checked the
      real numbers anyway). The 983 count comes from several backfill runs
      across the session (each capped at 80 new articles/site/run) — that's
      genuine growth, not duplication. Also spot-checked the 16 same-
      title/site pairs that do exist: different URLs, different
      content_hash, different word counts — CSE India reusing templated
      titles for similar event pages, not the same article twice.
- [x] **Paste/import text**: Data ⇅ → "＋ Add pasted text or a file" opens a
      modal (title + textarea, or load a `.txt`/`.md` file into the
      textarea). Saves as a regular article (`site_id='custom'`, "My
      Notes") — searchable, taggable, and included in "Ask your archive"
      retrieval with zero special-casing anywhere else, since it's just
      another row with the same schema. Mirrored the insert logic on both
      sides: `web/app.js` (live, in-browser) and `scraper/src/db.js`'s new
      `insertCustomArticle()` (used by `apply-overlay.js` to sync it into
      the permanent database). Found and fixed a real bug while wiring this
      up: `populateSiteFilter()` wasn't idempotent — calling it a second
      time (now needed after adding custom text introduces a new
      `site_id`) would have duplicated every `<option>` in the site
      filter dropdown. Verified live end-to-end: added a real note through
      the actual UI, confirmed it appeared in FTS5 search with highlighting,
      rendered correctly in the reader pane, and persisted to the
      localStorage overlay — and separately verified the Node-side
      `apply-overlay.js` path against the real database (then removed that
      test row before committing).

## Done — v5 (add article by URL, add/remove sources)
- [x] **Add article(s) by URL**: fetches and fully extracts one or more
      specific article URLs through the same Readability pipeline as
      regular scraping. New shared core (`scraper/src/add-single-article.js`,
      exports `addSingleArticle()`), usable both locally (`npm run
      add-article -- <url> [--tags=...]`) and via a new "Add an article"
      issue form + workflow. If the URL's host matches an already-
      configured site it joins that source; otherwise it gets its own
      host-based bucket. Writes directly to the real database (not the
      browser overlay), so no sync step needed. Respects the resolved
      site's `respectRobotsTxt` setting.
- [x] **Remove a source**: new "Remove a source" issue form + workflow +
      local CLI (`npm run remove-site -- <id> [--delete-articles]`).
      Already-scraped articles are kept by default — removal only stops
      future scraping — with an explicit opt-in to also delete historical
      articles from that source, following the same "safe default,
      informed opt-in for anything destructive" pattern used for
      robots.txt.
- [x] Extracted the shared Issue-Form body parser (`scraper/src/
      issue-utils.js`) out of the add-site script so add-article and
      remove-site reuse the same parsing instead of copy-pasting it a
      third time.
- [x] Sources panel and Data ⇅ menu now link directly to the add-source,
      remove-source, and add-article issue forms (pre-filled via GitHub's
      `?template=` deep link) instead of just pointing at "the Issues tab".
- [x] Found and fixed a real bug during this work: `process.argv[1]` isn't
      guaranteed absolute, so the `import.meta.url === file://${process
      .argv[1]}` "is this the main module" check silently never matched —
      both new dual-purpose (CLI + importable) scripts ran their whole file
      with zero output and exit 0, doing nothing. Fixed with
      `pathToFileURL()`. Worth remembering for any future script built the
      same way.
- [x] Verified all of it live against the real repo state: `add-single-
      article.js` on both a non-article page (correctly rejected) and a
      real article (correctly inserted, tagged, extra manual tag handled
      correctly even when it collided with an auto-tag already present —
      no duplicate row, no crash, thanks to the `(article_id, tag_id)`
      primary key); `remove-site.js` on a throwaway site with and without
      `--delete-articles`, and its "not found" error path. All test data
      removed / reverted before committing.

## Done — v6 (Pages deploy fix, topic graph)
- [x] **Fixed the Pages deploy failure** the user hit on a real run
      (`git' failed with exit code 128` / `repository ... not found` during
      checkout). Root cause: declaring a `permissions:` block at all
      *replaces* the default token permissions rather than adding to them —
      the deploy job's `{pages: write, id-token: write}` (added when the
      "publish to Pages" steps were factored into a shared reusable
      workflow) silently zeroed out `contents`, which `actions/checkout`
      needs. Added `contents: read` everywhere the reusable `deploy.yml` is
      declared or called (6 files). Confirmed via the user's own screenshot
      this was the actual failure, not user error.
- [x] **Topic graph**: 🕸 Graph button opens an Obsidian-style interactive
      graph — tags as nodes (sized by article count), edges = co-occurrence,
      click a tag to drill into an article-level graph for it (edges = other
      shared tags), click an article to open it in the reader. Hand-rolled
      canvas force simulation (`web/graph.js`, no charting library),
      drag/pan/zoom, theme-aware (reads CSS custom properties live). Chose
      tag-level (not article-level) as the default specifically because the
      tag vocabulary was already deliberately kept small — an all-1200+-
      articles graph would be unreadable, but tags are exactly the layer
      designed to avoid that.
- [x] Computed entirely live from `tags`/`article_tags` on every open — no
      precomputation or sync step, so it automatically reflects whatever's
      been scraped/tagged/added, including this session's new features
      (custom pasted text, articles added by URL).
- [x] Found and fixed two real bugs while building this, both through live
      testing against the real ~1200-article/42-tag database (not
      hypothetical — the UI genuinely rendered a blank canvas on drill-down
      until both were fixed):
      1. Tag ids and article ids are both plain autoincrement integers from
         different tables, so they numerically collide (e.g. tag id 812 vs
         article id 812) — the graph's node-position-reuse logic (keyed
         only by raw numeric id) matched a tag's stale node object onto an
         article with the same id when switching between the two graph
         modes, and since that stale node could itself have been corrupted
         (see next bug), positions came through as `null`/`NaN`. Fixed by
         namespacing node ids (`t${id}` / `a${id}`) so the two graph modes
         can never collide.
      2. Drilling into a common tag (e.g. "Water Crisis," 163 articles) produced
         a near-complete graph (10,000+ edges, since most of those articles
         also share 1+ other tags) — dense enough that repulsion and spring
         forces fed back into each other and positions overflowed to
         `Infinity`/`NaN` within a few ticks, silently rendering nothing.
         Fixed two ways: excluded the trivial "connected only via the tag
         you're drilling into" edges and required 2+ *other* shared tags
         (cuts a real near-complete graph down to real substructure, not
         just fewer edges), and added a hard per-tick force/velocity clamp
         in the simulation itself as a general safety net — the second fix
         matters for any dense graph, not just this specific case.
- [x] Verified live end-to-end after both fixes: tag graph renders correctly
      with real clustering, drilling into "Water Crisis" produces a valid
      layout (0 non-finite positions, down from 163/163), back button
      returns to tag view, clicking an article node closes the graph and
      opens the correct article in the reader (confirmed via title match),
      and the whole graph re-renders correctly in both themes.

## Done — v7 (log, auto-pull, date filter, graph physics fix, copy-prompt, Substack)
- [x] **7-day scraping run log**: new `run_log` table (one row per site per
      run, unlike `site_runs` which only keeps the latest), auto-pruned to a
      rolling 7 days on every write. 📋 Log button lists timestamp/status/
      counts per run with expandable actual article titles. Directly
      answers "is scraping still working, and what did it find" without
      digging through Action run history. Verified live against a real
      scraper run (6 rows, one per site, correct counts/titles).
- [x] **Clarified (no code needed)**: the deploy failure the user re-checked
      was them using GitHub's "Re-run jobs" on the *old failed run*, which
      replays that run's original commit rather than pulling latest `main`
      — the earlier `contents: read` fix was real but hadn't been exercised
      yet. Explained the distinction; a fresh "Run workflow" click uses
      current code.
- [x] **`npm run preview` now auto-pulls from GitHub** (`git pull
      --ff-only` — refuses rather than merging on diverged history, skips
      entirely if there are local uncommitted changes, so it can't clobber
      anything) and **opens the browser automatically**. Added
      `preview.command` at the repo root for a real double-click launcher
      (macOS). Verified both the "clean → pulls" and "dirty → skips safely"
      paths live.
- [x] **Date range filter**: From/To date pickers in the toolbar, ANDed
      with search/tag/site/unread like the other filters. Verified live
      (1438 → 114 articles on a real from-date, clear button correctly
      resets).
- [x] **Fixed the graph "flickering"** the user hit on a real dense tag
      ("Climate Policy," 200 articles): the previous damping-only physics
      could oscillate forever instead of converging for a sufficiently
      dense graph. Replaced with a d3-force-style alpha-decay cooling
      schedule (forces scaled by a global `alpha` that geometrically decays
      to 0), which *guarantees* settling within a bounded number of ticks
      regardless of density — this is the standard, well-tested technique
      for exactly this failure mode, not an ad-hoc patch. Also decluttered
      rendering (labels below a pixel-size threshold are skipped rather
      than overlapping into unreadable text at default zoom; zooming in or
      hovering still reveals them) and reduced edge density further
      (require 2+ shared tags, not 1+). Verified live: same "Climate
      Policy" scenario now settles (RAF loop genuinely stops, confirmed via
      `_raf === null`) with 0 non-finite positions, and zooming in reveals
      individually readable article clusters.
- [x] **"⧉ Copy prompt" for ChatGPT/Claude desktop apps**: those apps don't
      expose a local server the way LM Studio/Ollama do, so true API
      integration isn't possible — explained that honestly rather than
      building something that can't work. Built the practical equivalent
      instead: composes the same retrieval-augmented prompt and puts it on
      the clipboard instead of calling an API. Also added a fully editable
      **prompt template** (`{{articles}}`/`{{question}}` placeholders,
      persisted per-browser) used by both the automated providers and copy-
      prompt, so custom instructions apply everywhere. Verified live (error
      handling for the clipboard-permission case confirmed working; the
      write itself is blocked in headless test automation specifically
      because that environment's document isn't focused — a real user
      clicking the button doesn't hit this).
- [x] **Substack support — verified, no new code needed.** Substack feeds
      are standard RSS 2.0, already covered by existing RSS support.
      Confirmed live against a real, currently-publishing Substack: feed
      parsing found 20 items with correct dates, and full-text extraction
      on a real post pulled a clean 2163-word article. Paywalled posts are
      naturally excluded (Substack's own feed omits/truncates them for
      logged-out requests) — no bypass needed or attempted. Also don't need
      a special weekly-only schedule: daily's dedup-by-URL makes checking a
      weekly-publishing feed daily just 6 cheap no-op checks, not 6x the
      load. Documented in README.

## Done — v8 (graph hub/leaf redesign, recent searches, MCP server for local AI apps)
- [x] **Graph visual overhaul.** Nodes now come in two visually distinct
      kinds instead of one uniform style: **hub** nodes (topics/tags — purple,
      `--accent2`) sized by degree (how many things connect to them, not raw
      article count), and **leaf** nodes (individual articles — green,
      `--accent`, fixed small size regardless of their own degree) which
      always show their title, not just on hover. Increased repulsion
      (3200→5200) and spring length (100→150), and added a real collision-
      resolution pass (like d3-force's `forceCollide` — every tick, any
      overlapping pair of circles is pushed apart by exactly their overlap,
      not scaled by the alpha cooldown so it stays enforced even after
      settling) so edges/nodes spread out rather than visually compressing
      or overlapping. New `--accent2`/`--accent2-bg` CSS tokens added to all
      three theme blocks (light, system-dark, explicit dark) so hub coloring
      stays theme-aware. Verified live in the browser at both the 43-topic
      top level and a 200-article drill-down: no overlapping circles at any
      zoom.
- [x] **Graph structure fix (same day, user feedback):** first version of
      the article-level drill-down sub-clustered articles by *other* shared
      tags (each qualifying secondary tag became its own hub). User reported
      this produced "cluster inside cluster" when drilling in, which read as
      confusing rather than Obsidian-like. **Redesigned to be strictly flat,
      one level deep**: zooming into a tag now shows exactly one hub (that
      tag) with every one of its articles spoking directly off it — like
      Obsidian's local graph view for a single note/tag, not a nested tree.
      `handleGraphNodeClick` now only drills further when `graphState.mode
      === "tags"` (i.e. from the top level); the central hub inside an
      article view is a no-op, not another drill-in target. Removed the
      now-unused `buildIdInClause` helper and the secondary-tag grouping
      query entirely — simpler code, and the hub's own label ("why are these
      grouped: they all carry this tag") already answers the "why" without
      needing sub-hubs. Verified live: zoomed into "Human Worth" (18
      articles), confirmed a single central hub with 18 leaves spoking off
      it and titles all visible, and confirmed clicking the central hub does
      nothing (stays on the same flat view).
- [x] **Graph spacing fix (same day, user feedback):** even after the
      collision-resolution pass, nodes sat exactly edge-to-edge with zero
      gap, which the user still read as "compressed." Root cause: the
      collision padding was a flat 4px, invisible against a 32px-radius hub.
      Replaced with padding that scales with node size (`8 + 0.6 *
      min(radiusA, radiusB)`, so bigger nodes get more visible breathing
      room), and further increased repulsion (5200→9000), spring length
      (150→220), and reduced center-pull strength (0.012→0.007) so the whole
      layout spreads out more before collision resolution even kicks in.
      Verified live: the 43-topic view and a 104-article "Mining & Minerals"
      hub-and-spoke both now show a clear visible gap between every circle,
      at any zoom level.
- [x] **Graph density/dragging fix (same day, user feedback):** dragging
      "Legal & Governance" revealed the real problem — with only 43 broad
      category tags, most pairs co-occur *somewhat*, so the top-level topic
      graph was carrying a near-complete edge set (every tag linked to
      nearly every other), which no amount of spacing tuning alone could
      untangle, and made every node feel "hard to pull" since it was held by
      30+ springs at once. Fixed at the source: **prune to each tag's
      strongest 3 co-occurrences** (by shared-article count, unioned across
      both endpoints so a strong link survives even if the other tag has
      even stronger ties elsewhere), cutting the topic graph from ~doubled
      hundreds of edges down to roughly one per node-pair that actually
      matters. Combined with further tuning (repulsion 9000→15000, spring
      length 220→260, spring strength 0.02→0.012, center-pull 0.007→0.004)
      and a full (not partial) reheat on drag-start so neighbors visibly
      make room in real time instead of staying stiff. Verified live:
      dragging the largest hub now visibly relocates it and reshapes its
      neighborhood in real time, the zoomed-out 43-topic view shows real
      breathing room with outliers pushed to the fringes instead of one
      dense blob, and it resettles cleanly (no jitter) after release.
- [x] **Graph information-density fix (same day, user feedback):** the
      strictly-flat single-hub-plus-200-leaves view (previous entry) turned
      out to have the opposite problem from the nested version — a big tag
      like "Biodiversity" (200 articles) rendered as one giant starburst
      where every spoke looked identical, carrying no information beyond
      "these all share this tag." Restored sub-grouping by *other* tags
      shared by several articles (e.g. "Wildlife Conservation," "Water
      Resources" sub-hubs inside "Biodiversity"), but kept it genuinely flat
      *in the sense that matters*: sub-hubs are inert, not another drill-in
      target — `handleGraphNodeClick` already only lets a hub drill further
      when `graphState.mode === "tags"` (the top level), so bringing back
      the visual sub-clustering didn't reintroduce the earlier "cluster
      inside cluster" navigation confusion, it just restores the
      information. Capped at each sub-group's top 15 largest (min 3 shared
      articles) so it stays legible even on a 200-article tag; articles with
      no qualifying sub-group still connect straight to the main hub as
      before. Verified live: "Biodiversity" now shows "200 article(s)...
      grouped by 15 related topic(s)" with real named sub-clusters
      (Wildlife Conservation, Water Resources, Agriculture, etc.) instead of
      one undifferentiated starburst; confirmed clicking a sub-hub is still
      a no-op (stays on the same view) and clicking a leaf article still
      opens it correctly.
- [x] **Recent search history.** Last 8 searches persist in `localStorage`
      (`blogArchive.recentSearches.v1`) and render as clickable chips under
      the search box — clicking one refills the search box, re-runs the
      query, and moves it back to the front of the list (dedup on re-run).
      Rendered on page load too, not just after a new search, so history
      survives a full reload as required. Verified: `node --check web/app.js`.
- [x] **Local AI app access via a real MCP server** — the user explicitly
      rejected "⧉ Copy prompt" as insufficient ("I don't really want that...
      I must need... my locally installed chatgpt or claude or perplexity to
      find me the content"), so built the actual thing: `scraper/src/
      mcp-server.js`, a [Model Context Protocol](https://modelcontextprotocol.io)
      server (`@modelcontextprotocol/sdk`) that runs over stdio and exposes
      five tools reading `data/blogs.db` directly (read-only queries):
      `search_archive` (same FTS5 AND/OR/NOT syntax as the web UI),
      `get_article`, `list_recent_articles`, `list_tags`, `list_sources`.
      Documented exact `claude_desktop_config.json` setup in README. Honestly
      caveated rather than overclaiming: as of now, ChatGPT desktop's
      MCP/connector support targets *hosted* servers with OAuth (not a local
      `stdio` process like this), and Perplexity desktop has no equivalent
      local-tool mechanism at all — so this genuinely works for Claude
      Desktop today, not (yet) for the other two; MCP being app-agnostic
      means it should work for them too if/when they add local-server
      support. Verified live: spawned the server as a real child process,
      drove it through the actual MCP JSON-RPC handshake (`initialize` →
      `tools/list` → `tools/call`), and confirmed `search_archive` and
      `list_sources` return correct real data from the live archive (e.g.
      `search_archive({query:"climate"})` returned real matching articles
      with working snippets; `list_sources` returned all 5 real sources with
      correct per-site counts).

## Next / not started yet
- [ ] Confirm GitHub Pages is enabled (Settings → Pages → Source → GitHub
      Actions) and Actions has write permissions (Settings → Actions →
      General → Workflow permissions → Read and write) — one-time manual
      steps I can't do via git. This is very likely the cause of the newest
      `Failed to create deployment (status: 404)` / `HttpError: Not Found`
      error at the `deploy-pages` step (distinct from the earlier
      `contents: read` permissions bug, which is already fixed) — the scrape
      job itself succeeds and produces a build artifact, but the Pages API
      call 404s, which matches "Pages was never enabled" rather than a
      workflow-file bug.
- [ ] Add `GROQ_API_KEY` and `GEMINI_API_KEY` as repo secrets (Settings →
      Secrets and variables → Actions) so the daily Action and the
      "Analyze patterns" workflow can use them too — I only had them
      available in this local shell session for testing, they are **not**
      committed anywhere and won't carry over to GitHub Actions on their
      own.
- [ ] Trigger the workflow once (push or manual "Run workflow") and confirm
      the Pages URL serves the live archive.

## Known limitations (by design, documented in README)
- Indian Express: filtered by keyword-in-URL since article URLs don't
  encode category — best-effort, will miss some relevant articles.
- The Hindu / Frontline: pointed at each site's small rolling "recently
  updated" sitemap, not a full historical archive — Frontline's archive
  index is itself irregular (a `<urlset>` whose entries are actually more
  sitemap files, not articles), so a full historical crawl there would need
  bespoke handling; skipped for now.
- `indiaenvironmentportal.org.in` skipped entirely — its `robots.txt` bans
  all crawling.
- Read/unread and manually-added tags live per-browser (localStorage), not
  auto-synced across devices — by design, given the no-backend constraint;
  see README for the export/import and `apply-overlay.js` sync path.
- "Ask your archive" local-model option assumes an OpenAI-compatible local
  server (LM Studio/Ollama-style). Couldn't confirm whether "Locally AI"
  specifically exposes one — if it doesn't, that option has nothing to
  connect to and Groq/Gemini are the working paths today.
- The "Add a source" issue flow only runs for the repo owner/collaborators,
  by design (it spends API quota and commits to the repo on anyone's say-so
  otherwise, if the repo is public).
