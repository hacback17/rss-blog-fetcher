import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Deliberately NOT WAL: this file is committed to git as a single
  // self-contained artifact and loaded read-only in the browser via
  // sqlite3_deserialize(), which doesn't support WAL's shared-memory
  // locking. Plain rollback-journal mode keeps everything in one file.
  db.exec("PRAGMA journal_mode = DELETE;");
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      site_name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      author TEXT,
      published_at TEXT,
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content_html TEXT,
      content_text TEXT,
      excerpt TEXT,
      lead_image TEXT,
      word_count INTEGER,
      content_hash TEXT,
      -- NULL = unread. The scraper never touches this column; it's only
      -- ever written by applyOverlay() (see apply-overlay.js), which merges
      -- read/unread state exported from the browser back into the source
      -- of truth. See tags/article_tags below for the same pattern.
      read_at TEXT,
      -- Pipe-separated specific search terms (people/orgs/places/etc, LLM-
      -- extracted alongside tags -- see autotag.js). Deliberately uncapped
      -- unlike the tags table: these exist purely to sharpen search and
      -- retrieval, not as a grouping UI, so more of them only helps.
      keywords TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_articles_site ON articles(site_id);
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);

    -- Tags are a many-to-many label, not a duplicated grouping: one row per
    -- distinct tag name, joined to articles via article_tags so an article
    -- can carry several tags without its content being copied anywhere.
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS article_tags (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      -- 'auto' rows are fully owned by the scraper's auto-tagger and get
      -- replaced wholesale on each re-tag; 'manual' rows are only ever
      -- written by applyOverlay() from a user's browser-side edits and the
      -- scraper never removes them.
      source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
      PRIMARY KEY (article_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags(tag_id);

    CREATE TABLE IF NOT EXISTS sitemap_state (
      url TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      lastmod TEXT,
      checked_at TEXT NOT NULL
    );

    -- Tracks sitemap *files themselves* (as opposed to article URLs), so that
    -- e.g. an unchanged "sitemap-daily-2026-08-01.xml" is never re-fetched or
    -- re-walked on later runs. This is what makes large, date-partitioned
    -- sitemap indexes cheap to poll daily instead of walking thousands of
    -- files every single run.
    CREATE TABLE IF NOT EXISTS sitemap_files (
      url TEXT PRIMARY KEY,
      lastmod TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_runs (
      site_id TEXT PRIMARY KEY,
      last_run_at TEXT,
      last_status TEXT,
      urls_in_sitemap INTEGER,
      new_articles INTEGER,
      updated_articles INTEGER,
      errors INTEGER
    );

    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  migrateColumns(db);
  migrateFtsSchema(db);
}

// CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists
// from before this column was added, so new columns need an explicit,
// idempotent ALTER TABLE migration.
function migrateColumns(db) {
  const columns = db.prepare("PRAGMA table_info(articles)").all().map((c) => c.name);
  if (!columns.includes("read_at")) {
    db.exec("ALTER TABLE articles ADD COLUMN read_at TEXT");
  }
  if (!columns.includes("keywords")) {
    db.exec("ALTER TABLE articles ADD COLUMN keywords TEXT");
  }
}

// FTS5 virtual tables have a fixed column list — adding a column means
// dropping and recreating the index (then rebuilding it from the `articles`
// content table), which is why this isn't just another CREATE ... IF NOT
// EXISTS. schema_meta tracks the fts5 column-set version so this migration
// only actually runs once per upgrade.
const FTS_SCHEMA_VERSION = "2"; // v2 added the `keywords` column

function migrateFtsSchema(db) {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'fts_version'").get();
  if (row?.value === FTS_SCHEMA_VERSION) return;

  db.exec(`
    DROP TRIGGER IF EXISTS articles_ai;
    DROP TRIGGER IF EXISTS articles_ad;
    DROP TRIGGER IF EXISTS articles_au;
    DROP TABLE IF EXISTS articles_fts;

    CREATE VIRTUAL TABLE articles_fts USING fts5(
      title,
      content_text,
      author,
      keywords,
      content='articles',
      content_rowid='id'
    );

    CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, title, content_text, author, keywords)
      VALUES (new.id, new.title, new.content_text, new.author, new.keywords);
    END;

    CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content_text, author, keywords)
      VALUES ('delete', old.id, old.title, old.content_text, old.author, old.keywords);
    END;

    CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content_text, author, keywords)
      VALUES ('delete', old.id, old.title, old.content_text, old.author, old.keywords);
      INSERT INTO articles_fts(rowid, title, content_text, author, keywords)
      VALUES (new.id, new.title, new.content_text, new.author, new.keywords);
    END;

    INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
  `);

  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('fts_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(FTS_SCHEMA_VERSION);
}

export function getSitemapState(db, url) {
  return db.prepare("SELECT * FROM sitemap_state WHERE url = ?").get(url);
}

export function upsertSitemapState(db, { url, siteId, lastmod }) {
  db.prepare(
    `INSERT INTO sitemap_state (url, site_id, lastmod, checked_at)
     VALUES (@url, @siteId, @lastmod, @checkedAt)
     ON CONFLICT(url) DO UPDATE SET lastmod = @lastmod, checked_at = @checkedAt`
  ).run({ url, siteId, lastmod, checkedAt: new Date().toISOString() });
}

export function getSitemapFileState(db, url) {
  return db.prepare("SELECT * FROM sitemap_files WHERE url = ?").get(url);
}

export function upsertSitemapFileState(db, { url, lastmod }) {
  db.prepare(
    `INSERT INTO sitemap_files (url, lastmod, checked_at)
     VALUES (@url, @lastmod, @checkedAt)
     ON CONFLICT(url) DO UPDATE SET lastmod = @lastmod, checked_at = @checkedAt`
  ).run({ url, lastmod: lastmod ?? null, checkedAt: new Date().toISOString() });
}

export function getArticleByUrl(db, url) {
  return db.prepare("SELECT * FROM articles WHERE url = ?").get(url);
}

export function upsertArticle(db, article) {
  const now = new Date().toISOString();
  const existing = getArticleByUrl(db, article.url);

  if (!existing) {
    db.prepare(
      `INSERT INTO articles
        (site_id, site_name, url, title, author, published_at, fetched_at, updated_at,
         content_html, content_text, excerpt, lead_image, word_count, content_hash)
       VALUES
        (@siteId, @siteName, @url, @title, @author, @publishedAt, @fetchedAt, @updatedAt,
         @contentHtml, @contentText, @excerpt, @leadImage, @wordCount, @contentHash)`
    ).run({ ...article, fetchedAt: now, updatedAt: now });
    return "inserted";
  }

  if (existing.content_hash === article.contentHash) {
    return "unchanged";
  }

  db.prepare(
    `UPDATE articles SET
      title = @title, author = @author, published_at = @publishedAt,
      updated_at = @updatedAt, content_html = @contentHtml, content_text = @contentText,
      excerpt = @excerpt, lead_image = @leadImage, word_count = @wordCount,
      content_hash = @contentHash
     WHERE url = @url`
  ).run({ ...article, updatedAt: now });
  return "updated";
}

function upsertTag(db, name) {
  db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
  return db.prepare("SELECT id FROM tags WHERE name = ?").get(name).id;
}

export function listExistingTagNames(db, limit = 60) {
  return db
    .prepare(
      `SELECT t.name, COUNT(*) c FROM tags t
       JOIN article_tags at ON at.tag_id = t.id
       GROUP BY t.id ORDER BY c DESC LIMIT ?`
    )
    .all(limit)
    .map((r) => r.name);
}

// Replaces this article's *auto* tags wholesale (source='auto'); manual
// tags (added via applyOverlay from the browser) are never touched here.
export function setAutoTags(db, articleId, tagNames) {
  db.prepare("DELETE FROM article_tags WHERE article_id = ? AND source = 'auto'").run(articleId);
  const insert = db.prepare("INSERT INTO article_tags (article_id, tag_id, source) VALUES (?, ?, 'auto') ON CONFLICT DO NOTHING");
  for (const name of tagNames.slice(0, 5)) {
    const tagId = upsertTag(db, name);
    insert.run(articleId, tagId);
  }
}

// Keywords are stored as a single pipe-separated column (not a join table
// like tags) since they're purely a search/retrieval signal, never a
// grouping UI — no need for relational structure.
export function setKeywords(db, articleId, keywords) {
  db.prepare("UPDATE articles SET keywords = ? WHERE id = ?").run(keywords.join(" | "), articleId);
}

export function addManualTag(db, articleId, name) {
  const tagId = upsertTag(db, name);
  db.prepare("INSERT INTO article_tags (article_id, tag_id, source) VALUES (?, ?, 'manual') ON CONFLICT DO NOTHING").run(articleId, tagId);
}

export function removeManualTag(db, articleId, name) {
  const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(name);
  if (!row) return;
  db.prepare("DELETE FROM article_tags WHERE article_id = ? AND tag_id = ? AND source = 'manual'").run(articleId, row.id);
}

export function setReadAt(db, articleId, iso) {
  db.prepare("UPDATE articles SET read_at = ? WHERE id = ?").run(iso, articleId);
}

export function recordSiteRun(db, siteId, stats) {
  db.prepare(
    `INSERT INTO site_runs (site_id, last_run_at, last_status, urls_in_sitemap, new_articles, updated_articles, errors)
     VALUES (@siteId, @lastRunAt, @lastStatus, @urlsInSitemap, @newArticles, @updatedArticles, @errors)
     ON CONFLICT(site_id) DO UPDATE SET
       last_run_at = @lastRunAt, last_status = @lastStatus, urls_in_sitemap = @urlsInSitemap,
       new_articles = @newArticles, updated_articles = @updatedArticles, errors = @errors`
  ).run({ siteId, lastRunAt: new Date().toISOString(), ...stats });
}
