import { XMLParser } from "fast-xml-parser";
import { fetchWithTimeout } from "./util.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") return node["#text"] ?? null;
  return null;
}

// Some sites only expose RSS/Atom, not a sitemap (the original pain point
// with plain RSS readers is that the feed itself only carries a snippet —
// but the feed is still a perfectly good *discovery* mechanism: we just
// follow each item's link and run it through the same full-article
// extraction pipeline as sitemap-discovered URLs).
export async function fetchRssItems(rssUrl, { userAgent, timeoutMs }) {
  const res = await fetchWithTimeout(
    rssUrl,
    { headers: { "User-Agent": userAgent, Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" } },
    timeoutMs
  );
  if (!res.ok) throw new Error(`RSS fetch failed (${res.status}): ${rssUrl}`);
  const text = await res.text();
  const doc = parser.parse(text);

  if (doc.rss?.channel) {
    const items = asArray(doc.rss.channel.item);
    return items
      .map((item) => {
        const loc = textOf(item.link);
        const pubDate = textOf(item.pubDate);
        const lastmod = pubDate ? new Date(pubDate).toISOString() : null;
        return loc ? { loc, lastmod } : null;
      })
      .filter(Boolean);
  }

  if (doc.feed) {
    const entries = asArray(doc.feed.entry);
    return entries
      .map((entry) => {
        const links = asArray(entry.link);
        const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") || links[0];
        const loc = typeof alt === "string" ? alt : alt?.["@_href"];
        const updated = textOf(entry.updated) || textOf(entry.published);
        const lastmod = updated ? new Date(updated).toISOString() : null;
        return loc ? { loc, lastmod } : null;
      })
      .filter(Boolean);
  }

  return [];
}
