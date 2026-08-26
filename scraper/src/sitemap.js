import { XMLParser } from "fast-xml-parser";
import { fetchWithTimeout } from "./util.js";

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") return node["#text"] ?? null;
  return null;
}

async function fetchXml(url, userAgent, timeoutMs) {
  const res = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": userAgent, Accept: "application/xml,text/xml,*/*" } },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Sitemap fetch failed (${res.status}): ${url}`);
  const text = await res.text();
  return parser.parse(text);
}

// Fetches exactly one sitemap file and returns its immediate contents,
// without recursing. Some real-world sitemap indexes (e.g. one child file
// per calendar day, going back years) are far too large to walk in full on
// every run, so recursion/prioritisation is left to the caller.
export async function fetchSitemapLevel(url, { userAgent, timeoutMs }) {
  const doc = await fetchXml(url, userAgent, timeoutMs);

  if (doc.sitemapindex) {
    const items = asArray(doc.sitemapindex.sitemap)
      .map((c) => ({ loc: textOf(c.loc), lastmod: textOf(c.lastmod) }))
      .filter((c) => c.loc);
    return { type: "index", items };
  }

  if (doc.urlset) {
    const items = asArray(doc.urlset.url)
      .map((u) => ({ loc: textOf(u.loc), lastmod: textOf(u.lastmod) }))
      .filter((u) => u.loc);
    return { type: "urlset", items };
  }

  return { type: "empty", items: [] };
}
