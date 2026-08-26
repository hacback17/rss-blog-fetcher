import sqlite3InitModule from "./vendor/sqlite3.mjs";

const PAGE_SIZE = 40;
const DB_URL = "data/blogs.db";
const SQLITE_DESERIALIZE_FREEONCLOSE = 1;

const state = {
  db: null,
  page: 0,
  total: 0,
  query: "",
  siteId: "",
  selectedId: null,
};

const els = {
  list: document.getElementById("article-list"),
  prev: document.getElementById("prev-page"),
  next: document.getElementById("next-page"),
  pageLabel: document.getElementById("page-label"),
  search: document.getElementById("search-input"),
  searchHelpBtn: document.getElementById("search-help-btn"),
  searchHelp: document.getElementById("search-help"),
  siteFilter: document.getElementById("site-filter"),
  resultCount: document.getElementById("result-count"),
  dbStatus: document.getElementById("db-status"),
  readerEmpty: document.getElementById("reader-empty"),
  readerArticle: document.getElementById("reader-article"),
  readerTitle: document.getElementById("reader-title"),
  readerAuthor: document.getElementById("reader-author"),
  readerDate: document.getElementById("reader-date"),
  readerWords: document.getElementById("reader-words"),
  readerBody: document.getElementById("reader-body"),
  readerSourceLink: document.getElementById("reader-source-link"),
  readerPane: document.getElementById("reader-pane"),
};

init().catch((err) => {
  console.error(err);
  els.dbStatus.textContent = "Failed to load database: " + err.message;
});

async function init() {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  els.dbStatus.textContent = "Downloading article database…";
  const res = await fetch(DB_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`could not fetch ${DB_URL} (${res.status})`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const db = new sqlite3.oo1.DB(":memory:", "c");
  const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, "main", ptr, bytes.length, bytes.length, SQLITE_DESERIALIZE_FREEONCLOSE);
  db.checkRc(rc);
  state.db = db;
  els.dbStatus.textContent = "";

  populateSiteFilter();
  wireEvents();
  runQuery();
}

function populateSiteFilter() {
  const rows = queryAll(state.db, "SELECT DISTINCT site_id, site_name FROM articles ORDER BY site_name");
  for (const row of rows) {
    const opt = document.createElement("option");
    opt.value = row.site_id;
    opt.textContent = row.site_name;
    els.siteFilter.appendChild(opt);
  }
}

function wireEvents() {
  let searchDebounce;
  els.search.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.query = els.search.value.trim();
      state.page = 0;
      runQuery();
    }, 300);
  });

  els.searchHelpBtn.addEventListener("click", () => {
    els.searchHelp.classList.toggle("hidden");
  });

  els.siteFilter.addEventListener("change", () => {
    state.siteId = els.siteFilter.value;
    state.page = 0;
    runQuery();
  });

  els.prev.addEventListener("click", () => {
    if (state.page > 0) {
      state.page--;
      runQuery();
    }
  });

  els.next.addEventListener("click", () => {
    if ((state.page + 1) * PAGE_SIZE < state.total) {
      state.page++;
      runQuery();
    }
  });
}

function queryAll(db, sql, params) {
  const rows = [];
  db.exec({ sql, bind: params, rowMode: "object", resultRows: rows });
  return rows;
}

function queryOne(db, sql, params) {
  const rows = queryAll(db, sql, params);
  return rows[0] || null;
}

// Turns a human-typed boolean query into valid SQLite FTS5 syntax: bare
// and/or/not (outside quoted phrases) are uppercased into FTS5 operators;
// parentheses and quoted phrases pass through untouched.
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

function runQuery() {
  const offset = state.page * PAGE_SIZE;
  // $siteId is always bound (as '' when no filter is active) so the same
  // prepared params work whether or not a site filter is selected — the
  // sqlite3-wasm bind() call throws if a bound key isn't actually present
  // in the SQL text, so we keep the site clause unconditional instead.
  const siteClauseList = "AND ($siteId = '' OR site_id = $siteId)";
  const siteClauseFts = "AND ($siteId = '' OR a.site_id = $siteId)";
  const params = { $siteId: state.siteId, $limit: PAGE_SIZE, $offset: offset };

  els.list.innerHTML = "";
  els.resultCount.textContent = "";

  try {
    if (state.query) {
      const ftsQuery = normalizeFtsQuery(state.query);
      const countRow = queryOne(
        state.db,
        `SELECT COUNT(*) AS c FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
         WHERE articles_fts MATCH $q ${siteClauseFts}`,
        { $q: ftsQuery, $siteId: state.siteId }
      );
      state.total = countRow ? countRow.c : 0;

      const rows = queryAll(
        state.db,
        `SELECT a.id, a.title, a.site_name, a.author, a.published_at, a.word_count,
                snippet(articles_fts, 1, '__MARK_OPEN__', '__MARK_CLOSE__', '…', 10) AS snip
         FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
         WHERE articles_fts MATCH $q ${siteClauseFts}
         ORDER BY rank LIMIT $limit OFFSET $offset`,
        { $q: ftsQuery, ...params }
      );
      renderList(rows, true);
    } else {
      const countRow = queryOne(
        state.db,
        `SELECT COUNT(*) AS c FROM articles WHERE 1=1 ${siteClauseList}`,
        { $siteId: state.siteId }
      );
      state.total = countRow ? countRow.c : 0;

      const rows = queryAll(
        state.db,
        `SELECT id, title, site_name, author, published_at, word_count, excerpt
         FROM articles WHERE 1=1 ${siteClauseList}
         ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT $limit OFFSET $offset`,
        params
      );
      renderList(rows, false);
    }
    els.resultCount.textContent = state.total === 0 ? "No articles found" : `${state.total} article(s)`;
  } catch (err) {
    els.list.innerHTML = `<li class="search-error">Invalid search: ${escapeHtml(err.message)}</li>`;
    state.total = 0;
  }

  updatePager();
}

function renderList(rows, isSearch) {
  els.list.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.dataset.id = row.id;
    if (row.id === state.selectedId) li.classList.add("active");

    const title = document.createElement("p");
    title.className = "article-title";
    title.textContent = row.title || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "article-meta";
    meta.innerHTML = `<span>${escapeHtml(row.site_name || "")}</span><span>${formatDate(row.published_at)}</span><span>${row.word_count || 0} words</span>`;

    li.appendChild(title);
    li.appendChild(meta);

    const snippetSource = isSearch ? row.snip : row.excerpt;
    if (snippetSource) {
      const snip = document.createElement("div");
      snip.className = "article-snippet";
      const safe = escapeHtml(snippetSource)
        .replaceAll("__MARK_OPEN__", "<mark>")
        .replaceAll("__MARK_CLOSE__", "</mark>");
      snip.innerHTML = safe;
      li.appendChild(snip);
    }

    li.addEventListener("click", () => selectArticle(row.id, li));
    els.list.appendChild(li);
  }
}

function selectArticle(id, liEl) {
  const row = queryOne(state.db, "SELECT * FROM articles WHERE id = $id", { $id: id });
  if (!row) return;

  state.selectedId = id;
  document.querySelectorAll("#article-list li").forEach((li) => li.classList.remove("active"));
  if (liEl) liEl.classList.add("active");

  els.readerEmpty.classList.add("hidden");
  els.readerArticle.classList.remove("hidden");
  els.readerTitle.textContent = row.title || "(untitled)";
  els.readerAuthor.textContent = row.author || "";
  els.readerDate.textContent = formatDate(row.published_at);
  els.readerWords.textContent = row.word_count ? `${row.word_count} words` : "";
  els.readerSourceLink.href = row.url;
  els.readerSourceLink.textContent = `${row.site_name} ↗`;

  const clean = DOMPurify.sanitize(row.content_html || "<p>(no content)</p>", {
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
  });
  els.readerBody.innerHTML = clean;
  els.readerBody.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
  els.readerPane.scrollTo(0, 0);
}

function updatePager() {
  const pageCount = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  els.pageLabel.textContent = `Page ${state.page + 1} of ${pageCount}`;
  els.prev.disabled = state.page === 0;
  els.next.disabled = (state.page + 1) * PAGE_SIZE >= state.total;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
