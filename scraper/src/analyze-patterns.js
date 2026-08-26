// Cross-article "intelligence gathering" pattern analysis: pulls matching
// articles out of the archive and asks Gemini (chosen for its large context
// window — this can span years of articles in one prompt) to synthesize
// recurring themes, shifts over time, and notable entities, with citations
// back to source articles.
//
// Usage:
//   node src/analyze-patterns.js --tag="Water Crisis" --since=2024-01-01
//   node src/analyze-patterns.js --site=downtoearth --limit=200
//   node src/analyze-patterns.js   (no filters = whole archive)
//
// Requires GEMINI_API_KEY in the environment. Get a free key at
// https://aistudio.google.com/apikey
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { fetchWithTimeout } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(ROOT, "data", "blogs.db");
const REPORTS_DIR = path.join(ROOT, "reports");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const CONTENT_CHARS_PER_ARTICLE = 1500;

function parseArgs(argv) {
  const args = { limit: 300 };
  for (const raw of argv) {
    const m = raw.match(/^--([a-z]+)=(.*)$/i);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function buildQuery(db, args) {
  const clauses = ["1=1"];
  const params = {};

  if (args.site) {
    clauses.push("a.site_id = $site");
    params.$site = args.site;
  }
  if (args.since) {
    clauses.push("COALESCE(a.published_at, a.fetched_at) >= $since");
    params.$since = args.since;
  }
  if (args.tag) {
    clauses.push("EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.name = $tag)");
    params.$tag = args.tag;
  }

  params.$limit = Number(args.limit) || 300;

  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.url, a.site_name, a.published_at, a.excerpt, a.content_text
       FROM articles a WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(a.published_at, a.fetched_at) ASC LIMIT $limit`
    )
    .all(params);

  return rows;
}

function buildPrompt(rows, args) {
  const corpus = rows
    .map((r, i) => {
      const date = (r.published_at || "").slice(0, 10) || "unknown date";
      const text = (r.content_text || r.excerpt || "").slice(0, CONTENT_CHARS_PER_ARTICLE);
      return `[${i + 1}] (${date}) ${r.title} — ${r.site_name}\n${text}`;
    })
    .join("\n\n---\n\n");

  const scope = [
    args.tag ? `tag "${args.tag}"` : null,
    args.site ? `site "${args.site}"` : null,
    args.since ? `since ${args.since}` : null,
  ].filter(Boolean).join(", ") || "the full archive";

  return [
    `You are an intelligence analyst reviewing ${rows.length} archived news/blog articles (scope: ${scope}),`,
    "ordered chronologically. Produce a structured Markdown report covering:",
    "",
    "1. **Recurring themes** — what topics/issues keep coming up, and how often.",
    "2. **Trends over time** — what's increasing, decreasing, or shifting in framing across the date range.",
    "3. **Notable entities** — people, organizations, places, or projects mentioned repeatedly.",
    "4. **Emerging signals** — anything that appears only recently and looks like it's growing.",
    "5. **Notable contradictions or tensions** — where sources disagree or a stated plan conflicts with reported outcomes.",
    "",
    "Cite evidence using the article's bracketed number, e.g. [3], [12]. Be specific and concrete — prefer",
    "naming actual places/numbers/dates from the text over vague generalities. If the corpus is too thin to",
    "support a section, say so briefly rather than padding it.",
    "",
    "ARTICLES:",
    "",
    corpus,
  ].join("\n");
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
    120000
  );
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

function updateManifest(entry) {
  const manifestPath = path.join(REPORTS_DIR, "index.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : [];
  manifest.unshift(entry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb(DB_PATH);
  const rows = buildQuery(db, args);
  db.close();

  if (rows.length === 0) {
    console.log("No articles matched that filter — nothing to analyze.");
    return;
  }
  console.log(`Analyzing ${rows.length} article(s) with ${GEMINI_MODEL}...`);

  const prompt = buildPrompt(rows, args);
  const reportBody = await callGemini(prompt);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const title = [args.tag, args.site, args.since].filter(Boolean).join(" · ") || "Full archive";
  const filename = `${generatedAt.slice(0, 10)}-${slugify(title)}.md`;
  const filePath = path.join(REPORTS_DIR, filename);

  const header = [
    `# Pattern analysis: ${title}`,
    "",
    `Generated ${generatedAt} · ${rows.length} articles · model ${GEMINI_MODEL}`,
    "",
    "---",
    "",
  ].join("\n");

  fs.writeFileSync(filePath, header + reportBody);
  updateManifest({ file: filename, title, generatedAt, articleCount: rows.length, filters: args });

  console.log(`Report written to reports/${filename}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
