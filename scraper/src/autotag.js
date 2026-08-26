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

const MAX_TAGS = 5;
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
    "You are tagging a news/blog article with broad SUBJECT CATEGORIES for a personal archive.",
    `Return at most ${MAX_TAGS} tags, ranked best-first, that describe the article well.`,
    "Strongly prefer reusing one of the EXISTING TAGS below when it reasonably fits — the goal is a",
    "small, consistent set of categories, not a new tag per article. Only invent a new tag when none",
    "of the existing ones fit at all. Tags must be short (1-4 words), broad categories in Title Case",
    "(e.g. \"Water Crisis\", \"Air Pollution\", \"Data Centre\") — never a full sentence, never the",
    "article's own title, never a proper noun/place name alone.",
    "",
    `EXISTING TAGS: ${vocabulary.join(", ")}`,
    "",
    `TITLE: ${article.title || ""}`,
    `EXCERPT: ${excerpt}`,
    "",
    'Respond with ONLY a JSON object: {"tags": ["Tag One", "Tag Two"]} — no other text.',
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
        // hidden reasoning tokens on a 5-word tagging task and blows
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

function parseTags(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("model did not return valid JSON");
  }
  const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
  return tags
    .map((t) => String(t).trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((t) => (t.length > 40 ? t.slice(0, 40) : t))
    .slice(0, MAX_TAGS);
}

// Simple offline fallback (no API key configured): scores each seed/known
// category by keyword hits in the title+text, so tagging still works with
// zero setup, just less precisely than the LLM path.
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

function keywordFallbackTags(article) {
  const haystack = `${article.title || ""} ${article.contentText || ""}`.toLowerCase();
  const scored = Object.entries(KEYWORD_MAP)
    .map(([tag, keywords]) => ({ tag, hits: keywords.filter((k) => haystack.includes(k)).length }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, MAX_TAGS).map((r) => r.tag);
}

let warnedNoKey = false;

export async function generateTags(article, existingTagNames) {
  if (!process.env.GROQ_API_KEY) {
    if (!warnedNoKey) {
      console.log("  (auto-tagging: no GROQ_API_KEY set, using offline keyword fallback)");
      warnedNoKey = true;
    }
    return keywordFallbackTags(article);
  }

  const vocabulary = [...new Set([...existingTagNames, ...SEED_TAGS])].slice(0, 40);
  const prompt = buildPrompt(article, vocabulary);
  try {
    const content = await throttledGroqCall(prompt);
    const tags = parseTags(content);
    return tags.length ? tags : keywordFallbackTags(article);
  } catch (err) {
    console.warn(`  ! auto-tagging via Groq failed (${err.message}), falling back to keywords`);
    return keywordFallbackTags(article);
  }
}
