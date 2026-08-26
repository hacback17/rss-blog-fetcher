import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { fetchWithTimeout } from "./util.js";

// jsdom forwards page-internal warnings (malformed inline CSS, script
// errors on the scraped page, etc.) to the console by default — none of
// that is actionable for us, so use a silent virtual console instead of
// spamming run logs with other sites' broken CSS.
const silentConsole = new VirtualConsole();

// Fetches a single article URL and extracts the full readable content
// (title, byline, cleaned HTML body, plain text, excerpt). Returns null if
// the page isn't fetchable or doesn't look like an article.
export async function extractArticle(url, { userAgent, timeoutMs }) {
  const res = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" } },
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("html")) throw new Error(`Not HTML (${contentType})`);

  const html = await res.text();
  const dom = new JSDOM(html, { url, virtualConsole: silentConsole });
  const reader = new Readability(dom.window.document, { keepClasses: false });
  const article = reader.parse();

  if (!article || !article.textContent || article.textContent.trim().length < 200) {
    throw new Error("Readability could not extract a substantial article");
  }

  return {
    title: article.title?.trim() || null,
    author: article.byline?.trim() || null,
    contentHtml: article.content,
    contentText: article.textContent.trim(),
    excerpt: article.excerpt?.trim() || article.textContent.trim().slice(0, 280),
    leadImage: findLeadImage(dom.window.document),
    siteName: article.siteName?.trim() || null,
    publishedTimeMeta: findPublishedTime(dom.window.document),
  };
}

function findLeadImage(document) {
  const og = document.querySelector('meta[property="og:image"]');
  if (og?.content) return og.content;
  const tw = document.querySelector('meta[name="twitter:image"]');
  if (tw?.content) return tw.content;
  return null;
}

function findPublishedTime(document) {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="publish-date"]',
    'meta[itemprop="datePublished"]',
    "time[datetime]",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const value = el.getAttribute("content") || el.getAttribute("datetime");
    if (value) return value;
  }
  return null;
}
