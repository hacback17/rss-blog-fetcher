import { createHash } from "node:crypto";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Bounded-concurrency map over `items`, running `worker` on each with a
// polite delay between task starts so we never hammer a single server.
export async function runPool(items, { concurrency, delayMs, worker }) {
  const results = [];
  let nextIndex = 0;

  async function runOne() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      const item = items[i];
      try {
        results[i] = await worker(item, i);
      } catch (err) {
        results[i] = { error: err };
      }
      if (delayMs) await sleep(delayMs);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, runOne);
  await Promise.all(workers);
  return results;
}

export function matchesSite(url, site) {
  let pathname;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }

  if (site.includePathPrefixes?.length) {
    if (!site.includePathPrefixes.some((p) => pathname.includes(p.toLowerCase()))) {
      return false;
    }
  }

  if (site.includeKeywords?.length) {
    if (!site.includeKeywords.some((kw) => pathname.includes(kw.toLowerCase()))) {
      return false;
    }
  }

  if (site.excludePathPrefixes?.length) {
    if (site.excludePathPrefixes.some((p) => pathname.includes(p.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

export function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
