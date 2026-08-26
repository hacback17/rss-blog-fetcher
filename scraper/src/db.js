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
      content_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_articles_site ON articles(site_id);
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);

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

    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      title,
      content_text,
      author,
      content='articles',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, title, content_text, author)
      VALUES (new.id, new.title, new.content_text, new.author);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content_text, author)
      VALUES ('delete', old.id, old.title, old.content_text, old.author);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content_text, author)
      VALUES ('delete', old.id, old.title, old.content_text, old.author);
      INSERT INTO articles_fts(rowid, title, content_text, author)
      VALUES (new.id, new.title, new.content_text, new.author);
    END;
  `);
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

export function recordSiteRun(db, siteId, stats) {
  db.prepare(
    `INSERT INTO site_runs (site_id, last_run_at, last_status, urls_in_sitemap, new_articles, updated_articles, errors)
     VALUES (@siteId, @lastRunAt, @lastStatus, @urlsInSitemap, @newArticles, @updatedArticles, @errors)
     ON CONFLICT(site_id) DO UPDATE SET
       last_run_at = @lastRunAt, last_status = @lastStatus, urls_in_sitemap = @urlsInSitemap,
       new_articles = @newArticles, updated_articles = @updatedArticles, errors = @errors`
  ).run({ siteId, lastRunAt: new Date().toISOString(), ...stats });
}
