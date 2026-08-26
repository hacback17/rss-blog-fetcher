// One-command local preview: copies the current data/blogs.db, sites.json,
// and reports/ into web/ (the same files the deploy workflow publishes to
// Pages) and serves web/ over plain HTTP — so `npm run preview` shows
// exactly what's actually scraped, without any manual copying.
//
// Usage: npm run preview   (from scraper/), then open the printed URL.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const WEB_DIR = path.join(ROOT, "web");
const PORT = Number(process.env.PORT) || 8080;

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function syncFiles() {
  const dbCopied = copyIfExists(path.join(ROOT, "data", "blogs.db"), path.join(WEB_DIR, "data", "blogs.db"));
  if (!dbCopied) {
    console.error("No data/blogs.db found yet — run `npm run run` first to scrape something.");
    process.exit(1);
  }
  copyIfExists(path.join(ROOT, "scraper", "config", "sites.json"), path.join(WEB_DIR, "data", "sites.json"));

  const reportsDir = path.join(ROOT, "reports");
  const reportsDest = path.join(WEB_DIR, "reports");
  fs.mkdirSync(reportsDest, { recursive: true });
  if (fs.existsSync(reportsDir)) {
    for (const entry of fs.readdirSync(reportsDir)) {
      copyIfExists(path.join(reportsDir, entry), path.join(reportsDest, entry));
    }
  }
  if (!fs.existsSync(path.join(reportsDest, "index.json"))) {
    fs.writeFileSync(path.join(reportsDest, "index.json"), "[]\n");
  }
  console.log("Synced data/blogs.db, sites.json, and reports/ into web/ for preview.");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".db": "application/x-sqlite3",
  ".md": "text/markdown; charset=utf-8",
};

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const filePath = path.join(WEB_DIR, urlPath === "/" ? "/index.html" : urlPath);
    if (!filePath.startsWith(WEB_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  });
  server.listen(PORT, () => {
    console.log(`Preview running at http://localhost:${PORT}`);
  });
}

syncFiles();
serve();
