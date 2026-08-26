import { fetchWithTimeout } from "./util.js";

// A starter vocabulary of broad, reusable categories (not granular topics)
// so a fresh database doesn't start from zero reuse. The live DB's existing
// tags (scraper/src/db.js:listExistingTagNames) are merged in on top of
// this and given priority, so the vocabulary organically grows/consolidates
// around whatever categories actually recur in what's been scraped.
const SEED_TAGS = [
  "Climate Policy", "Renewable Energy", "Energy Transition", "Air Pollution",
  "Water Crisis", "Water Resources", "Forest & Land", "Wildlife Conservation",
  "Biodiversity", "Agriculture", "Disaster & Extreme Weather", "Public Health",
  "Urban Planning", "Waste Management", "Data Centre", "Technology & Innovation",
  "Legal & Governance", "International Relations", "Ocean & Coastal",
  "Mining & Minerals", "Transport & Mobility",
];

// Tags stay tightly capped (they drive the sidebar's grouping UI, and the
// whole point is a small reusable set of categories rather than one tag per
// article). Keywords are a *different* signal — specific entities/terms for
// precise search and for the "ask your archive" retrieval feature — so they
// get a much looser cap; more of them only helps matching, and they never
// appear as their own grouping UI.
const MAX_TAGS = 5;
const MAX_KEYWORDS = 12;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// gpt-oss on Groq's free tier is limited to ~8000 tokens/minute, and each
// tagging call (vocabulary + excerpt in, reasoning + JSON out) runs several
// hundred tokens — so calls need pacing regardless of how many articles are
// being fetched concurrently. A simple promise-chained queue serializes
// Groq calls across all concurrent workers to a safe minimum spacing.
const MIN_CALL_INTERVAL_MS = 4000;
let groqQueueTail = Promise.resolve();

function throttledGroqCall(prompt) {
  const run = groqQueueTail.then(async () => {
    const result = await callGroq(prompt);
    await new Promise((r) => setTimeout(r, MIN_CALL_INTERVAL_MS));
    return result;
  });
  // Swallow errors here so one failed call doesn't wedge the queue for
  // everything queued after it; the real error still propagates via `run`.
  groqQueueTail = run.catch(() => {});
  return run;
}

function buildPrompt(article, vocabulary) {
  const excerpt = (article.contentText || "").slice(0, 1200);
  return [
    "You are indexing a news/blog article for a personal, searchable archive. Produce two different",
    "kinds of labels:",
    "",
    `1. TAGS — at most ${MAX_TAGS} broad SUBJECT CATEGORIES, ranked best-first. Strongly prefer reusing`,
    "one of the EXISTING TAGS below when it reasonably fits — the goal is a small, consistent set of",
    "categories, not a new tag per article. Only invent a new one when none of the existing ones fit at",
    "all. Short (1-4 words), Title Case (e.g. \"Water Crisis\", \"Data Centre\") — never a full sentence,",
    "never the article's own title, never a proper noun/place name alone.",
    "",
    `2. KEYWORDS — up to ${MAX_KEYWORDS} specific, searchable terms from THIS article: named entities`,
    "(people, organizations, places, projects, laws/policies, species, technical terms). These are for",
    "precise search, so be specific rather than broad — the opposite instinct from tags. No duplicates",
    "of what's already in TAGS.",
    "",
    `EXISTING TAGS: ${vocabulary.join(", ")}`,
    "",
    `TITLE: ${article.title || ""}`,
    `EXCERPT: ${excerpt}`,
    "",
    'Respond with ONLY a JSON object: {"tags": ["..."], "keywords": ["..."]} — no other text.',
  ].join("\n");
}

async function callGroq(prompt) {
  const res = await fetchWithTimeout(
    GROQ_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        // gpt-oss is a reasoning model; without this it burns hundreds of
        // hidden reasoning tokens on a simple tagging task and blows
        // straight through the free tier's tokens-per-minute limit.
        reasoning_effort: "low",
        response_format: { type: "json_object" },
      }),
    },
    20000
  );
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no content");
  return content;
}

function cleanList(list, maxLen, maxItems) {
  return (Array.isArray(list) ? list : [])
    .map((t) => String(t).trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((t) => (t.length > maxLen ? t.slice(0, maxLen) : t))
    .slice(0, maxItems);
}

function parseResult(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("model did not return valid JSON");
  }
  return {
    tags: cleanList(parsed.tags, 40, MAX_TAGS),
    keywords: cleanList(parsed.keywords, 60, MAX_KEYWORDS),
  };
}

// Simple offline fallback (no API key configured): scores each seed/known
// category by keyword hits in the title+text, so tagging still works with
// zero setup, just less precisely than the LLM path. The matched phrases
// double as a rough keywords list.
const KEYWORD_MAP = {
  "Water Crisis": ["water crisis", "drought", "water scarcity", "groundwater"],
  "Water Resources": ["river", "wetland", "reservoir", "irrigation", "water resource"],
  "Air Pollution": ["air pollution", "aqi", "smog", "particulate", "pm2.5"],
  "Climate Policy": ["climate policy", "cop", "unfccc", "paris agreement", "climate finance"],
  "Renewable Energy": ["solar", "wind power", "renewable energy"],
  "Energy Transition": ["energy transition", "fossil fuel", "coal", "lng", "electricity grid"],
  "Forest & Land": ["forest", "deforestation", "land use", "afforestation"],
  "Wildlife Conservation": ["wildlife", "tiger", "elephant", "poaching", "endangered species"],
  "Biodiversity": ["biodiversity", "ecosystem", "species"],
  "Agriculture": ["farmer", "crop", "agricultur", "irrigation", "monsoon"],
  "Disaster & Extreme Weather": ["flood", "cyclone", "heatwave", "landslide", "wildfire", "earthquake"],
  "Public Health": ["disease", "health emergency", "outbreak", "hospital"],
  "Urban Planning": ["urban", "city planning", "smart city"],
  "Waste Management": ["waste management", "plastic", "recycl", "landfill"],
  "Data Centre": ["data centre", "data center", "server farm"],
  "Technology & Innovation": ["artificial intelligence", "ai ", "technology", "innovation"],
  "Legal & Governance": ["court", "tribunal", "law", "regulation", "policy", "governance"],
  "Mining & Minerals": ["mining", "mineral", "lithium", "coal mine"],
  "Ocean & Coastal": ["ocean", "coastal", "marine", "sea level"],
};

function keywordFallback(article) {
  const haystack = `${article.title || ""} ${article.contentText || ""}`.toLowerCase();
  const scored = Object.entries(KEYWORD_MAP)
    .map(([tag, keywords]) => ({ tag, hits: keywords.filter((k) => haystack.includes(k)) }))
    .filter((r) => r.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);
  return {
    tags: scored.slice(0, MAX_TAGS).map((r) => r.tag),
    keywords: [...new Set(scored.flatMap((r) => r.hits))].slice(0, MAX_KEYWORDS),
  };
}

let warnedNoKey = false;

// Returns { tags: string[], keywords: string[] }.
export async function generateTags(article, existingTagNames) {
  if (!process.env.GROQ_API_KEY) {
    if (!warnedNoKey) {
      console.log("  (auto-tagging: no GROQ_API_KEY set, using offline keyword fallback)");
      warnedNoKey = true;
    }
    return keywordFallback(article);
  }

  const vocabulary = [...new Set([...existingTagNames, ...SEED_TAGS])].slice(0, 40);
  const prompt = buildPrompt(article, vocabulary);
  try {
    const content = await throttledGroqCall(prompt);
    const result = parseResult(content);
    return result.tags.length || result.keywords.length ? result : keywordFallback(article);
  } catch (err) {
    console.warn(`  ! auto-tagging via Groq failed (${err.message}), falling back to keywords`);
    return keywordFallback(article);
  }
}
