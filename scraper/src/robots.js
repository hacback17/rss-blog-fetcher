import { fetchWithTimeout } from "./util.js";

// Minimal robots.txt parser: collects Disallow rules that apply to `*`
// (and to our own user-agent token if a specific block exists), and exposes
// isAllowed(pathname). Good enough for politeness checks against real sites;
// not a full spec implementation (no Allow-precedence edge cases, no wildcards
// beyond simple prefix matching, which covers the overwhelming majority of
// real-world robots.txt files).
export async function fetchRobotsRules(baseUrl, userAgent, timeoutMs) {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  let text = "";
  try {
    const res = await fetchWithTimeout(robotsUrl, { headers: { "User-Agent": userAgent } }, timeoutMs);
    if (res.ok) text = await res.text();
  } catch {
    // No robots.txt or unreachable: treat as "allow all".
    return { disallow: [] };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const botToken = userAgent.split("/")[0].toLowerCase();

  // Group lines into records: consecutive User-agent lines share a group;
  // a non-user-agent line closes the group to new agents.
  const groups = [];
  let current = null;
  let lastWasUserAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      if (!lastWasUserAgent || !current) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasUserAgent = true;
    } else if (key === "disallow") {
      if (current && value) current.disallow.push(value);
      lastWasUserAgent = false;
    } else {
      lastWasUserAgent = false;
    }
  }

  const disallow = [];
  for (const group of groups) {
    const applies = group.agents.includes("*") || group.agents.some((a) => botToken.includes(a) || a.includes(botToken));
    if (applies) disallow.push(...group.disallow);
  }

  return { disallow };
}

export function isPathAllowed(rules, pathname) {
  return !rules.disallow.some((rule) => pathname.startsWith(rule));
}
