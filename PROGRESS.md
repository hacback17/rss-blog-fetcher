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

## In progress
- [ ] Background job re-tagging all ~760 existing articles with the fixed
      Groq pipeline (the very first batch was tagged before the model-name
      bug was caught, so those got keyword-fallback tags instead of real
      LLM ones). Runs itself, no action needed — check
      `git log`/`data/blogs.db` tag quality later if curious.

## Next / not started yet
- [ ] Confirm GitHub Pages is enabled (Settings → Pages → Source → GitHub
      Actions) and Actions has write permissions (Settings → Actions →
      General → Workflow permissions → Read and write) — one-time manual
      steps I can't do via git.
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
