// A local MCP (Model Context Protocol) server that lets a locally-installed
// AI app (currently: Claude Desktop — see README "Local AI app access" for
// why ChatGPT/Perplexity desktop apps can't use this yet) search and read
// this archive directly, instead of the user manually pasting a prompt.
// Runs over stdio, spawned by the AI app itself per its own MCP config —
// this file is never run as a long-lived server on its own.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "blogs.db");

// Same minimal AND/OR/NOT/parens uppercasing as web/app.js's
// normalizeFtsQuery — duplicated rather than shared because that file is
// browser-only (DOM globals, sql.js-wasm) and this one is a plain Node
// script; the logic is a few lines and not worth a shared-module split.
function normalizeFtsQuery(raw) {
  const tokens = raw.match(/"[^"]*"|\(|\)|[^\s()]+/g) || [];
  return tokens
    .map((tok) => {
      if (tok.startsWith('"') || tok === "(" || tok === ")") return tok;
      const upper = tok.toUpperCase();
      return upper === "AND" || upper === "OR" || upper === "NOT" ? upper : tok;
    })
    .join(" ");
}

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function main() {
  const db = openDb(DB_PATH);
  const server = new McpServer({ name: "blog-archive", version: "1.0.0" });

  server.registerTool(
    "search_archive",
    {
      title: "Search archive",
      description:
        "Full-text search over the locally scraped/saved article archive. Supports AND/OR/NOT and " +
        'parentheses (e.g. "climate AND (water OR carbon) NOT explained"), plain words are AND-ed by ' +
        "default. Returns matching articles with an excerpt/snippet — call get_article for full text.",
      inputSchema: {
        query: z.string().describe("Search query, e.g. climate AND (water OR carbon)"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results, default 15"),
        tag: z.string().optional().describe("Restrict to articles carrying this tag name"),
        site: z.string().optional().describe("Restrict to this site_id (see list_sources)"),
        date_from: z.string().optional().describe("Only articles published on/after this YYYY-MM-DD"),
        date_to: z.string().optional().describe("Only articles published on/before this YYYY-MM-DD"),
      },
    },
    ({ query, limit, tag, site, date_from, date_to }) => {
      const clauses = [];
      const params = { $q: normalizeFtsQuery(query), $limit: limit || 15 };
      if (tag) {
        clauses.push(
          "EXISTS (SELECT 1 FROM article_tags at2 JOIN tags t2 ON t2.id = at2.tag_id WHERE at2.article_id = a.id AND t2.name = $tag)"
        );
        params.$tag = tag;
      }
      if (site) {
        clauses.push("a.site_id = $site");
        params.$site = site;
      }
      if (date_from) {
        clauses.push("substr(a.published_at, 1, 10) >= $dateFrom");
        params.$dateFrom = date_from;
      }
      if (date_to) {
        clauses.push("substr(a.published_at, 1, 10) <= $dateTo");
        params.$dateTo = date_to;
      }
      const extraFilter = clauses.map((c) => `AND ${c}`).join(" ");
      const rows = db
        .prepare(
          `SELECT a.id, a.title, a.url, a.site_name, a.author, a.published_at, a.word_count,
                  snippet(articles_fts, 1, '[', ']', '…', 20) AS snippet
           FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
           WHERE articles_fts MATCH $q ${extraFilter}
           ORDER BY rank LIMIT $limit`
        )
        .all(params);
      return textResult({ count: rows.length, results: rows });
    }
  );

  server.registerTool(
    "get_article",
    {
      title: "Get full article",
      description: "Fetch the full text, tags, and metadata of one archived article by id or exact url.",
      inputSchema: {
        id: z.number().int().optional().describe("Article id, from search_archive/list_recent_articles"),
        url: z.string().optional().describe("Exact article URL (alternative to id)"),
      },
    },
    ({ id, url }) => {
      if (!id && !url) return textResult({ error: "Provide either id or url" });
      const row = id
        ? db.prepare("SELECT * FROM articles WHERE id = ?").get(id)
        : db.prepare("SELECT * FROM articles WHERE url = ?").get(url);
      if (!row) return textResult({ error: "Article not found" });
      const tags = db
        .prepare(
          `SELECT t.name FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?`
        )
        .all(row.id)
        .map((t) => t.name);
      return textResult({
        id: row.id,
        title: row.title,
        url: row.url,
        site_name: row.site_name,
        author: row.author,
        published_at: row.published_at,
        word_count: row.word_count,
        tags,
        keywords: row.keywords ? row.keywords.split("|") : [],
        content_text: row.content_text,
      });
    }
  );

  server.registerTool(
    "list_recent_articles",
    {
      title: "List recent articles",
      description: "List the most recently published/fetched articles, optionally filtered by tag or site.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results, default 20"),
        tag: z.string().optional().describe("Restrict to articles carrying this tag name"),
        site: z.string().optional().describe("Restrict to this site_id (see list_sources)"),
      },
    },
    ({ limit, tag, site }) => {
      const clauses = [];
      const params = { $limit: limit || 20 };
      if (tag) {
        clauses.push(
          "EXISTS (SELECT 1 FROM article_tags at2 JOIN tags t2 ON t2.id = at2.tag_id WHERE at2.article_id = a.id AND t2.name = $tag)"
        );
        params.$tag = tag;
      }
      if (site) {
        clauses.push("a.site_id = $site");
        params.$site = site;
      }
      const extraFilter = clauses.map((c) => `AND ${c}`).join(" ");
      const rows = db
        .prepare(
          `SELECT a.id, a.title, a.url, a.site_name, a.author, a.published_at, a.word_count, a.excerpt
           FROM articles a WHERE 1=1 ${extraFilter}
           ORDER BY COALESCE(a.published_at, a.fetched_at) DESC LIMIT $limit`
        )
        .all(params);
      return textResult({ count: rows.length, results: rows });
    }
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "List all tags in the archive with how many articles carry each, most-used first.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Max tags, default 100"),
      },
    },
    ({ limit }) => {
      const rows = db
        .prepare(
          `SELECT t.name, COUNT(*) AS article_count
           FROM tags t JOIN article_tags at ON at.tag_id = t.id
           GROUP BY t.id ORDER BY article_count DESC LIMIT ?`
        )
        .all(limit || 100);
      return textResult({ count: rows.length, tags: rows });
    }
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description: "List every configured source (site/feed) in the archive with its article count.",
      inputSchema: {},
    },
    () => {
      const rows = db
        .prepare(
          `SELECT site_id, site_name, COUNT(*) AS article_count
           FROM articles GROUP BY site_id, site_name ORDER BY article_count DESC`
        )
        .all();
      return textResult({ count: rows.length, sources: rows });
    }
  );

  const transport = new StdioServerTransport();
  server.connect(transport);
}

main();
