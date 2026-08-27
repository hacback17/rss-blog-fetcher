import sqlite3InitModule from "./vendor/sqlite3.mjs";
import { ForceGraph } from "./graph.js";

const PAGE_SIZE = 40;
const DB_URL = "data/blogs.db";
const SQLITE_DESERIALIZE_FREEONCLOSE = 1;
const SQLITE_DESERIALIZE_RESIZEABLE = 2; // without this, any INSERT that grows the db fails with SQLITE_FULL
const OVERLAY_KEY = "blogArchive.overlay.v1";
const THEME_KEY = "blogArchive.theme";
const AI_SETTINGS_KEY = "blogArchive.aiSettings.v1";
const SITES_URL = "data/sites.json";
const RECENT_SEARCHES_KEY = "blogArchive.recentSearches.v1";
const MAX_RECENT_SEARCHES = 8;

const state = {
  db: null,
  page: 0,
  total: 0,
  query: "",
  siteId: "",
  tagId: 0,
  tagName: "",
  unreadOnly: false,
  dateFrom: "",
  dateTo: "",
  selectedId: null,
};

const els = {};
[
  "article-list", "prev-page", "next-page", "page-label", "search-input", "search-help-btn",
  "search-help", "site-filter", "unread-only", "date-from", "date-to", "date-clear-btn",
  "result-count", "db-status", "active-tag-bar",
  "tag-list", "reader-empty", "reader-article", "reader-title", "reader-author", "reader-date",
  "reader-words", "reader-body", "reader-source-link", "reader-pane", "reader-read-toggle",
  "reader-tags", "theme-toggle", "data-menu-btn", "data-menu", "export-db-btn", "export-jsonl-btn",
  "export-overlay-btn", "import-overlay-input", "reports-btn", "reports-menu", "reports-list",
  "log-btn", "log-menu", "log-list", "recent-searches", "recent-searches-list",
  "sources-btn", "sources-menu", "sources-list", "export-sources-btn",
  "ask-btn", "ask-panel", "ask-settings-btn", "ask-close-btn", "ask-settings", "ask-provider",
  "ask-key-row", "ask-api-key", "ask-local-url-row", "ask-local-url", "ask-local-model-row",
  "ask-local-model", "ask-prompt-template", "ask-messages", "ask-form", "ask-input", "ask-copy-btn",
  "tension-btn", "tension-panel", "tension-close-btn", "tension-scope", "tension-tag",
  "tension-find-btn", "tension-results",
  "today-btn", "today-badge", "today-panel", "today-close-btn", "today-refresh-btn", "today-results",
  "add-text-btn", "add-text-backdrop", "add-text-modal", "add-text-close-btn", "add-text-title",
  "add-text-file-input", "add-text-body-input", "add-text-save-btn",
  "graph-btn", "graph-backdrop", "graph-modal", "graph-title", "graph-subtitle", "graph-back-btn",
  "graph-close-btn", "graph-canvas", "graph-tooltip", "graph-empty",
].forEach((id) => {
  els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
});

let dbBytesForExport = null;

initTheme();
init().catch((err) => {
  console.error(err);
  els.dbStatus.textContent = "Failed to load database: " + err.message;
});

// ---------- overlay (localStorage) ----------

function loadOverlay() {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw);
    return {
      read: parsed.read || {},
      unread: parsed.unread || [],
      manualTags: parsed.manualTags || {},
      removedManualTags: parsed.removedManualTags || {},
      customArticles: parsed.customArticles || {},
    };
  } catch {
    return { read: {}, unread: [], manualTags: {}, removedManualTags: {}, customArticles: {} };
  }
}

function saveOverlay(overlay) {
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
}

function applyOverlayToDb(db, overlay) {
  for (const [url, entry] of Object.entries(overlay.customArticles || {})) {
    insertCustomArticleToDb(db, url, entry);
  }
  for (const [url, iso] of Object.entries(overlay.read)) {
    db.exec({ sql: "UPDATE articles SET read_at = $iso WHERE url = $url", bind: { $iso: iso, $url: url } });
  }
  for (const url of overlay.unread) {
    db.exec({ sql: "UPDATE articles SET read_at = NULL WHERE url = $url", bind: { $url: url } });
  }
  for (const [url, names] of Object.entries(overlay.manualTags)) {
    const row = queryOne(db, "SELECT id FROM articles WHERE url = $url", { $url: url });
    if (!row) continue;
    for (const name of names) addTagToDb(db, row.id, name, "manual");
  }
  for (const [url, names] of Object.entries(overlay.removedManualTags)) {
    const row = queryOne(db, "SELECT id FROM articles WHERE url = $url", { $url: url });
    if (!row) continue;
    for (const name of names) removeTagFromDb(db, row.id, name);
  }
}

// Pasted/imported text is stored as a regular article (site_id='custom') so
// it's searchable, taggable, and shows up in "Ask your archive" retrieval
// exactly like scraped content — no special-casing needed anywhere else.
function insertCustomArticleToDb(db, url, entry) {
  const wordCount = entry.contentText.split(/\s+/).filter(Boolean).length;
  db.exec({
    sql: `INSERT OR IGNORE INTO articles
      (site_id, site_name, url, title, published_at, fetched_at, updated_at, content_html, content_text, excerpt, word_count)
      VALUES ('custom', 'My Notes', $url, $title, $addedAt, $addedAt, $addedAt, $html, $text, $excerpt, $wordCount)`,
    bind: {
      $url: url,
      $title: entry.title,
      $addedAt: entry.addedAt,
      $html: textToHtml(entry.contentText),
      $text: entry.contentText,
      $excerpt: entry.contentText.slice(0, 280),
      $wordCount: wordCount,
    },
  });
}

function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

function addTagToDb(db, articleId, name, source) {
  db.exec({ sql: "INSERT INTO tags (name) VALUES ($name) ON CONFLICT(name) DO NOTHING", bind: { $name: name } });
  const tag = queryOne(db, "SELECT id FROM tags WHERE name = $name", { $name: name });
  db.exec({
    sql: "INSERT INTO article_tags (article_id, tag_id, source) VALUES ($aid, $tid, $source) ON CONFLICT DO NOTHING",
    bind: { $aid: articleId, $tid: tag.id, $source: source },
  });
}

function removeTagFromDb(db, articleId, name) {
  const tag = queryOne(db, "SELECT id FROM tags WHERE name = $name", { $name: name });
  if (!tag) return;
  db.exec({
    sql: "DELETE FROM article_tags WHERE article_id = $aid AND tag_id = $tid AND source = 'manual'",
    bind: { $aid: articleId, $tid: tag.id },
  });
}

// ---------- theme ----------

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  updateThemeButton();
}

function updateThemeButton() {
  const current = document.documentElement.getAttribute("data-theme");
  els.themeToggle.textContent = current === "dark" ? "☀️" : current === "light" ? "🌙" : "🌓";
  els.themeToggle.title = current ? `Theme: ${current} (click to change)` : "Theme: system (click to change)";
}

function cycleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "light" ? "dark" : current === "dark" ? null : "light";
  if (next) {
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  } else {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  }
  updateThemeButton();
}

// ---------- init ----------

async function init() {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  els.dbStatus.textContent = "Downloading article database…";
  const res = await fetch(DB_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`could not fetch ${DB_URL} (${res.status})`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  dbBytesForExport = bytes;

  const db = new sqlite3.oo1.DB(":memory:", "c");
  const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
  const flags = SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE;
  const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, "main", ptr, bytes.length, bytes.length, flags);
  db.checkRc(rc);
  state.db = db;

  applyOverlayToDb(db, loadOverlay());

  els.dbStatus.textContent = "";
  populateSiteFilter();
  populateTagList();
  wireEvents();
  renderRecentSearches();
  runQuery();
  maybeGenerateDailyBriefOnLoad();
}

function populateSiteFilter() {
  // Re-callable (e.g. after adding custom text introduces a new site_id),
  // so rebuild from scratch rather than appending on top of last time.
  const currentValue = els.siteFilter.value;
  els.siteFilter.innerHTML = '<option value="">All sources</option>';
  const rows = queryAll(state.db, "SELECT DISTINCT site_id, site_name FROM articles ORDER BY site_name");
  for (const row of rows) {
    const opt = document.createElement("option");
    opt.value = row.site_id;
    opt.textContent = row.site_name;
    els.siteFilter.appendChild(opt);
  }
  els.siteFilter.value = currentValue;
}

function populateTagList() {
  const rows = queryAll(
    state.db,
    `SELECT t.id, t.name, COUNT(*) c FROM tags t
     JOIN article_tags at ON at.tag_id = t.id
     GROUP BY t.id ORDER BY c DESC, t.name ASC`
  );
  els.tagList.innerHTML = "";
  if (rows.length === 0) {
    els.tagList.innerHTML = '<li class="tag-empty">No tags yet</li>';
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    if (row.id === state.tagId) li.classList.add("active");
    li.innerHTML = `<span>${escapeHtml(row.name)}</span><span class="tag-count">${row.c}</span>`;
    li.addEventListener("click", () => {
      state.tagId = state.tagId === row.id ? 0 : row.id;
      state.tagName = state.tagId ? row.name : "";
      state.page = 0;
      populateTagList();
      updateActiveTagBar();
      runQuery();
    });
    els.tagList.appendChild(li);
  }
}

function updateActiveTagBar() {
  if (!state.tagId) {
    els.activeTagBar.classList.add("hidden");
    els.activeTagBar.innerHTML = "";
    return;
  }
  els.activeTagBar.classList.remove("hidden");
  els.activeTagBar.innerHTML = `Filtering by tag: <strong>${escapeHtml(state.tagName)}</strong> <button class="clear-tag-btn" id="clear-tag-btn">clear ×</button>`;
  document.getElementById("clear-tag-btn").addEventListener("click", () => {
    state.tagId = 0;
    state.tagName = "";
    state.page = 0;
    populateTagList();
    updateActiveTagBar();
    runQuery();
  });
}

function wireEvents() {
  let searchDebounce;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.query = els.searchInput.value.trim();
      state.page = 0;
      runQuery();
      if (state.query) recordRecentSearch(state.query);
    }, 300);
  });

  els.searchHelpBtn.addEventListener("click", () => els.searchHelp.classList.toggle("hidden"));

  els.siteFilter.addEventListener("change", () => {
    state.siteId = els.siteFilter.value;
    state.page = 0;
    runQuery();
  });

  els.unreadOnly.addEventListener("change", () => {
    state.unreadOnly = els.unreadOnly.checked;
    state.page = 0;
    runQuery();
  });

  const onDateChange = () => {
    state.dateFrom = els.dateFrom.value;
    state.dateTo = els.dateTo.value;
    els.dateClearBtn.classList.toggle("hidden", !state.dateFrom && !state.dateTo);
    state.page = 0;
    runQuery();
  };
  els.dateFrom.addEventListener("change", onDateChange);
  els.dateTo.addEventListener("change", onDateChange);
  els.dateClearBtn.addEventListener("click", () => {
    els.dateFrom.value = "";
    els.dateTo.value = "";
    onDateChange();
  });

  els.prevPage.addEventListener("click", () => {
    if (state.page > 0) { state.page--; runQuery(); }
  });
  els.nextPage.addEventListener("click", () => {
    if ((state.page + 1) * PAGE_SIZE < state.total) { state.page++; runQuery(); }
  });

  els.themeToggle.addEventListener("click", cycleTheme);

  els.dataMenuBtn.addEventListener("click", () => els.dataMenu.classList.toggle("hidden"));
  els.reportsBtn.addEventListener("click", () => {
    els.reportsMenu.classList.toggle("hidden");
    if (!els.reportsMenu.classList.contains("hidden")) loadReportsList();
  });
  els.sourcesBtn.addEventListener("click", () => {
    els.sourcesMenu.classList.toggle("hidden");
    if (!els.sourcesMenu.classList.contains("hidden")) loadSourcesList();
  });
  els.logBtn.addEventListener("click", () => {
    els.logMenu.classList.toggle("hidden");
    if (!els.logMenu.classList.contains("hidden")) loadLogList();
  });
  document.addEventListener("click", (e) => {
    if (!els.dataMenu.contains(e.target) && e.target !== els.dataMenuBtn) els.dataMenu.classList.add("hidden");
    if (!els.reportsMenu.contains(e.target) && e.target !== els.reportsBtn) els.reportsMenu.classList.add("hidden");
    if (!els.sourcesMenu.contains(e.target) && e.target !== els.sourcesBtn) els.sourcesMenu.classList.add("hidden");
    if (!els.logMenu.contains(e.target) && e.target !== els.logBtn) els.logMenu.classList.add("hidden");
  });

  els.exportDbBtn.addEventListener("click", exportDatabase);
  els.exportJsonlBtn.addEventListener("click", exportJsonl);
  els.exportOverlayBtn.addEventListener("click", exportOverlay);
  els.importOverlayInput.addEventListener("change", importOverlay);
  els.exportSourcesBtn.addEventListener("click", exportSourcesConfig);

  wireAskPanel();
  wireTensionPanel();
  wireTodayPanel();
  wireAddTextModal();
  wireGraph();
}

// ---------- add pasted text / file ----------

function wireAddTextModal() {
  const open = () => {
    els.dataMenu.classList.add("hidden");
    els.addTextBackdrop.classList.remove("hidden");
    els.addTextTitle.focus();
  };
  const close = () => {
    els.addTextBackdrop.classList.add("hidden");
    els.addTextTitle.value = "";
    els.addTextBodyInput.value = "";
    els.addTextFileInput.value = "";
  };

  els.addTextBtn.addEventListener("click", open);
  els.addTextCloseBtn.addEventListener("click", close);
  els.addTextBackdrop.addEventListener("click", (e) => {
    if (e.target === els.addTextBackdrop) close();
  });

  els.addTextFileInput.addEventListener("change", () => {
    const file = els.addTextFileInput.files[0];
    if (!file) return;
    if (!els.addTextTitle.value.trim()) {
      els.addTextTitle.value = file.name.replace(/\.(txt|md)$/i, "");
    }
    const reader = new FileReader();
    reader.onload = () => { els.addTextBodyInput.value = reader.result; };
    reader.readAsText(file);
  });

  els.addTextSaveBtn.addEventListener("click", () => {
    const title = els.addTextTitle.value.trim();
    const text = els.addTextBodyInput.value.trim();
    if (!title || !text) {
      alert("Add both a title and some text first.");
      return;
    }
    addCustomArticle(title, text);
    close();
  });
}

function addCustomArticle(title, text) {
  const url = `custom://${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const addedAt = new Date().toISOString();
  const entry = { title, contentText: text, addedAt };

  const overlay = loadOverlay();
  overlay.customArticles[url] = entry;
  saveOverlay(overlay);

  insertCustomArticleToDb(state.db, url, entry);
  populateSiteFilter();
  populateTagList();
  runQuery();
}

// ---------- query helpers ----------

function queryAll(db, sql, params) {
  const rows = [];
  db.exec({ sql, bind: params, rowMode: "object", resultRows: rows });
  return rows;
}

function queryOne(db, sql, params) {
  return queryAll(db, sql, params)[0] || null;
}

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

function loadRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((q) => typeof q === "string" && q.trim()) : [];
  } catch {
    return [];
  }
}

function saveRecentSearches(list) {
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable (private browsing, quota) — recent searches just won't persist
  }
}

function recordRecentSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) return;
  let list = loadRecentSearches();
  list = list.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  list.unshift(trimmed);
  list = list.slice(0, MAX_RECENT_SEARCHES);
  saveRecentSearches(list);
  renderRecentSearches();
}

function renderRecentSearches() {
  const list = loadRecentSearches();
  if (!list.length) {
    els.recentSearches.classList.add("hidden");
    els.recentSearchesList.innerHTML = "";
    return;
  }
  els.recentSearches.classList.remove("hidden");
  els.recentSearchesList.innerHTML = list
    .map((q, i) => `<span class="recent-search-chip" data-idx="${i}">${escapeHtml(q)}</span>`)
    .join("");
  els.recentSearchesList.querySelectorAll(".recent-search-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = list[Number(chip.dataset.idx)];
      if (q === undefined) return;
      els.searchInput.value = q;
      state.query = q;
      state.page = 0;
      runQuery();
      recordRecentSearch(q);
    });
  });
}

function commonFilters(alias) {
  return `AND ($siteId = '' OR ${alias}.site_id = $siteId)
          AND ($tagId = 0 OR EXISTS (SELECT 1 FROM article_tags at2 WHERE at2.article_id = ${alias}.id AND at2.tag_id = $tagId))
          AND ($unreadOnly = 0 OR ${alias}.read_at IS NULL)
          AND ($dateFrom = '' OR substr(${alias}.published_at, 1, 10) >= $dateFrom)
          AND ($dateTo = '' OR substr(${alias}.published_at, 1, 10) <= $dateTo)`;
}

function runQuery() {
  const offset = state.page * PAGE_SIZE;
  // sqlite3-wasm's bind() throws if an object key isn't an actual parameter
  // in the SQL text, so count queries (no LIMIT/OFFSET) and list queries
  // (which add $limit/$offset) each get their own params object rather than
  // sharing one with unused extra keys.
  const filterParams = {
    $siteId: state.siteId,
    $tagId: state.tagId,
    $unreadOnly: state.unreadOnly ? 1 : 0,
    $dateFrom: state.dateFrom,
    $dateTo: state.dateTo,
  };
  const listParams = { ...filterParams, $limit: PAGE_SIZE, $offset: offset };

  els.articleList.innerHTML = "";
  els.resultCount.textContent = "";

  try {
    if (state.query) {
      const ftsQuery = normalizeFtsQuery(state.query);
      const filters = commonFilters("a");
      const countRow = queryOne(
        state.db,
        `SELECT COUNT(*) AS c FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
         WHERE articles_fts MATCH $q ${filters}`,
        { $q: ftsQuery, ...filterParams }
      );
      state.total = countRow ? countRow.c : 0;

      const rows = queryAll(
        state.db,
        `SELECT a.id, a.title, a.site_name, a.author, a.published_at, a.word_count, a.read_at,
                snippet(articles_fts, 1, '__MARK_OPEN__', '__MARK_CLOSE__', '…', 10) AS snip
         FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
         WHERE articles_fts MATCH $q ${filters}
         ORDER BY rank LIMIT $limit OFFSET $offset`,
        { $q: ftsQuery, ...listParams }
      );
      renderList(rows, true);
    } else {
      const filters = commonFilters("a");
      const countRow = queryOne(state.db, `SELECT COUNT(*) AS c FROM articles a WHERE 1=1 ${filters}`, filterParams);
      state.total = countRow ? countRow.c : 0;

      const rows = queryAll(
        state.db,
        `SELECT a.id, a.title, a.site_name, a.author, a.published_at, a.word_count, a.read_at, a.excerpt
         FROM articles a WHERE 1=1 ${filters}
         ORDER BY COALESCE(a.published_at, a.fetched_at) DESC LIMIT $limit OFFSET $offset`,
        listParams
      );
      renderList(rows, false);
    }
    els.resultCount.textContent = state.total === 0 ? "No articles found" : `${state.total} article(s)`;
  } catch (err) {
    els.articleList.innerHTML = `<li class="search-error">Invalid search: ${escapeHtml(err.message)}</li>`;
    state.total = 0;
  }

  updatePager();
}

function renderList(rows, isSearch) {
  els.articleList.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.dataset.id = row.id;
    if (row.id === state.selectedId) li.classList.add("active");
    if (row.read_at) li.classList.add("is-read");

    const title = document.createElement("p");
    title.className = "article-title";
    title.innerHTML = `${row.read_at ? "" : '<span class="unread-dot"></span>'}<span>${escapeHtml(row.title || "(untitled)")}</span>`;

    const meta = document.createElement("div");
    meta.className = "article-meta";
    meta.innerHTML = `<span>${escapeHtml(row.site_name || "")}</span><span>${formatDate(row.published_at)}</span><span>${row.word_count || 0} words</span>`;

    li.appendChild(title);
    li.appendChild(meta);

    const snippetSource = isSearch ? row.snip : row.excerpt;
    if (snippetSource) {
      const snip = document.createElement("div");
      snip.className = "article-snippet";
      snip.innerHTML = escapeHtml(snippetSource).replaceAll("__MARK_OPEN__", "<mark>").replaceAll("__MARK_CLOSE__", "</mark>");
      li.appendChild(snip);
    }

    li.addEventListener("click", () => selectArticle(row.id, li));
    els.articleList.appendChild(li);
  }
}

function updatePager() {
  const pageCount = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  els.pageLabel.textContent = `Page ${state.page + 1} of ${pageCount}`;
  els.prevPage.disabled = state.page === 0;
  els.nextPage.disabled = (state.page + 1) * PAGE_SIZE >= state.total;
}

// ---------- reader ----------

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
  els.readerBody.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });

  // Opening an article marks it read, like an email/feed reader — done
  // before rendering the toggle/list state so both reflect it immediately.
  if (!row.read_at) {
    toggleRead(row.url, true, liEl);
    row.read_at = new Date().toISOString();
  }
  renderTags(row);
  renderReadToggle(row);

  els.readerPane.scrollTo(0, 0);
}

function renderReadToggle(row) {
  const isRead = !!row.read_at;
  els.readerReadToggle.textContent = isRead ? "✓ Read — mark unread" : "Mark as read";
  els.readerReadToggle.onclick = () => {
    const nowRead = !isRead;
    toggleRead(row.url, nowRead);
    // Re-render this article's state so the button/list update immediately.
    const fresh = queryOne(state.db, "SELECT * FROM articles WHERE id = $id", { $id: row.id });
    renderReadToggle(fresh);
    const li = els.articleList.querySelector(`li[data-id="${row.id}"]`);
    if (li) {
      li.classList.toggle("is-read", nowRead);
      const dot = li.querySelector(".unread-dot");
      if (nowRead && dot) dot.remove();
      if (!nowRead && !dot) li.querySelector(".article-title")?.insertAdjacentHTML("afterbegin", '<span class="unread-dot"></span>');
    }
  };
}

function toggleRead(url, nowRead, liEl) {
  const overlay = loadOverlay();
  const iso = new Date().toISOString();
  if (nowRead) {
    overlay.read[url] = iso;
    overlay.unread = overlay.unread.filter((u) => u !== url);
    state.db.exec({ sql: "UPDATE articles SET read_at = $iso WHERE url = $url", bind: { $iso: iso, $url: url } });
  } else {
    delete overlay.read[url];
    if (!overlay.unread.includes(url)) overlay.unread.push(url);
    state.db.exec({ sql: "UPDATE articles SET read_at = NULL WHERE url = $url", bind: { $url: url } });
  }
  saveOverlay(overlay);
  if (liEl) liEl.classList.toggle("is-read", nowRead);
}

function renderTags(row) {
  const dbTags = queryAll(
    state.db,
    `SELECT t.name, at.source FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = $id ORDER BY at.source, t.name`,
    { $id: row.id }
  );

  els.readerTags.innerHTML = "";
  for (const tag of dbTags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip" + (tag.source === "manual" ? " manual" : "");
    chip.innerHTML = `<span class="chip-label">${escapeHtml(tag.name)}</span>`;
    chip.querySelector(".chip-label").addEventListener("click", () => {
      state.tagId = queryOne(state.db, "SELECT id FROM tags WHERE name = $n", { $n: tag.name })?.id || 0;
      state.tagName = tag.name;
      state.page = 0;
      populateTagList();
      updateActiveTagBar();
      runQuery();
    });
    if (tag.source === "manual") {
      const remove = document.createElement("span");
      remove.className = "remove-tag";
      remove.textContent = "×";
      remove.title = "Remove tag";
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        removeManualTagUi(row, tag.name);
      });
      chip.appendChild(remove);
    }
    els.readerTags.appendChild(chip);
  }

  const form = document.createElement("span");
  form.className = "tag-add-form";
  form.innerHTML = `<input type="text" placeholder="+ tag" maxlength="40" /><button title="Add tag">＋</button>`;
  const input = form.querySelector("input");
  const submit = () => {
    const name = input.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    addManualTagUi(row, name);
    input.value = "";
  };
  form.querySelector("button").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  els.readerTags.appendChild(form);
}

function addManualTagUi(row, name) {
  const overlay = loadOverlay();
  overlay.manualTags[row.url] = [...new Set([...(overlay.manualTags[row.url] || []), name])];
  overlay.removedManualTags[row.url] = (overlay.removedManualTags[row.url] || []).filter((n) => n !== name);
  saveOverlay(overlay);
  addTagToDb(state.db, row.id, name, "manual");
  renderTags(row);
  populateTagList();
}

function removeManualTagUi(row, name) {
  const overlay = loadOverlay();
  overlay.manualTags[row.url] = (overlay.manualTags[row.url] || []).filter((n) => n !== name);
  overlay.removedManualTags[row.url] = [...new Set([...(overlay.removedManualTags[row.url] || []), name])];
  saveOverlay(overlay);
  removeTagFromDb(state.db, row.id, name);
  renderTags(row);
  populateTagList();
}

// ---------- graph ----------

let forceGraph = null;
const graphState = { mode: "tags", tagId: 0 };

function wireGraph() {
  els.graphBtn.addEventListener("click", () => {
    els.graphBackdrop.classList.remove("hidden");
    if (!forceGraph) {
      forceGraph = new ForceGraph(els.graphCanvas, {
        onNodeClick: handleGraphNodeClick,
        onHoverChange: handleGraphHover,
      });
    }
    showTagGraph();
  });

  els.graphCloseBtn.addEventListener("click", () => els.graphBackdrop.classList.add("hidden"));
  els.graphBackdrop.addEventListener("click", (e) => {
    if (e.target === els.graphBackdrop) els.graphBackdrop.classList.add("hidden");
  });
  els.graphBackBtn.addEventListener("click", showTagGraph);
}

function handleGraphNodeClick(node) {
  // Deliberately flat, Obsidian-style: a hub only drills further when it's
  // a top-level topic (graphState.mode === "tags"). Once you're inside a
  // tag's article view, its hub node is just the center of that view, not
  // another drill-in target — there is no cluster-inside-cluster nesting.
  if (node.kind === "hub" && graphState.mode === "tags") {
    showArticleGraphForTag(node.refId, node.label);
  } else if (node.kind === "leaf") {
    els.graphBackdrop.classList.add("hidden");
    const li = els.articleList.querySelector(`li[data-id="${node.refId}"]`);
    selectArticle(node.refId, li);
  }
}

function handleGraphHover(node, clientX, clientY) {
  if (!node) {
    els.graphTooltip.classList.add("hidden");
    return;
  }
  const bodyRect = els.graphCanvas.parentElement.getBoundingClientRect();
  els.graphTooltip.style.left = `${clientX - bodyRect.left + 12}px`;
  els.graphTooltip.style.top = `${clientY - bodyRect.top + 12}px`;
  els.graphTooltip.textContent = node.kind === "hub" ? `${node.label} — ${node.count} article(s)` : node.label;
  els.graphTooltip.classList.remove("hidden");
}

function showTagGraph() {
  graphState.mode = "tags";
  graphState.tagId = 0;
  els.graphBackBtn.classList.add("hidden");
  els.graphTitle.textContent = "Topic graph";

  const rawNodes = queryAll(
    state.db,
    `SELECT t.id, t.name AS label, COUNT(*) AS count
     FROM tags t JOIN article_tags at ON at.tag_id = t.id
     GROUP BY t.id ORDER BY count DESC`
  );
  const rawEdges = queryAll(
    state.db,
    `SELECT at1.tag_id AS source, at2.tag_id AS target, COUNT(*) AS weight
     FROM article_tags at1 JOIN article_tags at2
       ON at1.article_id = at2.article_id AND at1.tag_id < at2.tag_id
     GROUP BY at1.tag_id, at2.tag_id`
  );

  // Node ids are namespaced ("t"+id) because tag ids and article ids are both
  // plain autoincrement integers from different tables — without a prefix
  // they can (and do) collide numerically between this graph and the
  // article-level one, corrupting the force layout's node-reuse logic.
  const nodes = rawNodes.map((n) => ({ id: `t${n.id}`, refId: n.id, label: n.label, count: n.count, kind: "hub" }));

  // With broad category tags, most pairs co-occur *somewhat* — keeping
  // every edge produces a near-complete graph (every node linked to nearly
  // every other), which no amount of repulsion/spacing can untangle into
  // something readable, and makes every node hard to drag free since it's
  // held by 30+ springs at once. Instead, keep only each tag's strongest
  // few co-occurrences (by shared-article count) — the relationships that
  // actually distinguish it — and union across both endpoints so a strong
  // link isn't dropped just because the *other* tag has even stronger ties
  // elsewhere.
  const TOP_EDGES_PER_NODE = 3;
  const byNode = new Map();
  for (const e of rawEdges) {
    if (!byNode.has(e.source)) byNode.set(e.source, []);
    if (!byNode.has(e.target)) byNode.set(e.target, []);
    byNode.get(e.source).push(e);
    byNode.get(e.target).push(e);
  }
  const keep = new Set();
  for (const list of byNode.values()) {
    list.sort((a, b) => b.weight - a.weight);
    for (const e of list.slice(0, TOP_EDGES_PER_NODE)) keep.add(e);
  }
  const edges = [...keep].map((e) => ({ source: `t${e.source}`, target: `t${e.target}`, weight: e.weight }));

  els.graphSubtitle.textContent = `${nodes.length} topics — click one to see its articles`;
  els.graphEmpty.classList.toggle("hidden", nodes.length > 0);
  forceGraph.setData(nodes, edges);
}

function showArticleGraphForTag(tagId, tagName) {
  graphState.mode = "articles";
  graphState.tagId = tagId;
  els.graphBackBtn.classList.remove("hidden");
  els.graphTitle.textContent = tagName;

  const rawArticles = queryAll(
    state.db,
    `SELECT a.id, a.title AS label
     FROM articles a JOIN article_tags at ON at.article_id = a.id
     WHERE at.tag_id = $tagId
     ORDER BY COALESCE(a.published_at, a.fetched_at) DESC LIMIT 200`,
    { $tagId: tagId }
  );

  // One level deep, never recursively drillable — handleGraphNodeClick only
  // lets a hub drill further when graphState.mode === "tags" (the top
  // level), so nothing below is a further click target regardless of what
  // gets drawn here. That's what keeps this "flat" in the sense that
  // matters (no cluster-inside-cluster *navigation*). But a bare tag with
  // every one of its (possibly 200+) articles spoking off one point turned
  // out to carry no information beyond "these all share this tag" — every
  // spoke looks identical, so at any real size it read as noise, not a
  // graph. Sub-grouping by *other* tags shared by several of these articles
  // restores the actual information (which articles relate to each other,
  // and why) without reintroducing the confusing part, since these
  // sub-group hubs are inert — visual grouping only, not another drill-in.
  let secondaryRows = [];
  if (rawArticles.length > 1) {
    secondaryRows = queryAll(
      state.db,
      `SELECT at.article_id AS articleId, t.id AS tagId, t.name AS tagName
       FROM article_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.article_id IN (${rawArticles.map((a) => a.id).join(",")}) AND at.tag_id != $tagId`,
      { $tagId: tagId }
    );
  }
  const bySecondaryTag = new Map(); // tagId -> { tagName, articleIds: Set }
  for (const row of secondaryRows) {
    if (!bySecondaryTag.has(row.tagId)) bySecondaryTag.set(row.tagId, { tagName: row.tagName, articleIds: new Set() });
    bySecondaryTag.get(row.tagId).articleIds.add(row.articleId);
  }
  const SECONDARY_HUB_MIN_ARTICLES = 3;
  const MAX_SECONDARY_HUBS = 15;
  const secondaryHubs = [...bySecondaryTag.entries()]
    .filter(([, h]) => h.articleIds.size >= SECONDARY_HUB_MIN_ARTICLES)
    .sort((a, b) => b[1].articleIds.size - a[1].articleIds.size)
    .slice(0, MAX_SECONDARY_HUBS);
  const articleToHubs = new Map(); // articleId -> [secondaryTagId, ...]
  for (const [secTagId, h] of secondaryHubs) {
    for (const articleId of h.articleIds) {
      if (!articleToHubs.has(articleId)) articleToHubs.set(articleId, []);
      articleToHubs.get(articleId).push(secTagId);
    }
  }

  // See showTagGraph() for why node ids need a namespace prefix.
  const hubNode = { id: `t${tagId}`, refId: tagId, label: tagName, count: rawArticles.length, kind: "hub" };
  const secondaryHubNodes = secondaryHubs.map(([secTagId, h]) => ({
    id: `s${secTagId}`,
    refId: secTagId,
    label: h.tagName,
    count: h.articleIds.size,
    kind: "hub",
  }));
  const articleNodes = rawArticles.map((a) => ({ id: `a${a.id}`, refId: a.id, label: a.label, kind: "leaf" }));

  const edges = [];
  // Backbone: every sub-group hub anchors back to the tag it's a part of.
  for (const [secTagId] of secondaryHubs) edges.push({ source: `t${tagId}`, target: `s${secTagId}`, weight: 3 });
  // Each article links to whichever sub-group(s) it belongs to; articles
  // with no qualifying sub-group link straight to the tag itself, same as
  // the plain flat view.
  for (const a of rawArticles) {
    const hubs = articleToHubs.get(a.id);
    if (hubs && hubs.length) {
      for (const secTagId of hubs) edges.push({ source: `s${secTagId}`, target: `a${a.id}`, weight: 1 });
    } else {
      edges.push({ source: `t${tagId}`, target: `a${a.id}`, weight: 1 });
    }
  }

  const nodes = [hubNode, ...secondaryHubNodes, ...articleNodes];
  els.graphSubtitle.textContent = secondaryHubs.length
    ? `${articleNodes.length} article(s) tagged "${tagName}", grouped by ${secondaryHubs.length} related topic(s) — click an article to open it`
    : `${articleNodes.length} article(s) tagged "${tagName}" — click one to open it`;
  els.graphEmpty.classList.toggle("hidden", articleNodes.length > 0);
  forceGraph.setData(nodes, edges);
}

// ---------- reports ----------

async function loadReportsList() {
  els.reportsList.innerHTML = "<li>Loading…</li>";
  try {
    const res = await fetch("reports/index.json", { cache: "no-cache" });
    const manifest = res.ok ? await res.json() : [];
    if (manifest.length === 0) {
      els.reportsList.innerHTML = '<li class="reports-empty">No reports yet — run the "Analyze patterns (Gemini)" workflow.</li>';
      return;
    }
    els.reportsList.innerHTML = "";
    for (const entry of manifest) {
      const li = document.createElement("li");
      const date = (entry.generatedAt || "").slice(0, 10);
      li.innerHTML = `<a href="reports/${encodeURIComponent(entry.file)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title)}</a>
        <span class="report-meta">${date} · ${entry.articleCount} articles</span>`;
      els.reportsList.appendChild(li);
    }
  } catch {
    els.reportsList.innerHTML = '<li class="reports-empty">No reports yet.</li>';
  }
}

// ---------- run log ----------

function loadLogList() {
  els.logList.innerHTML = "<li>Loading…</li>";
  let rows;
  try {
    rows = queryAll(state.db, "SELECT * FROM run_log ORDER BY run_at DESC LIMIT 200");
  } catch {
    els.logList.innerHTML = '<li class="reports-empty">No log data yet — this database predates the run log.</li>';
    return;
  }
  if (rows.length === 0) {
    els.logList.innerHTML = '<li class="reports-empty">No runs logged in the last 7 days.</li>';
    return;
  }

  els.logList.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    const failed = row.status === "failed";
    const when = new Date(row.run_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    let titles = [];
    try { titles = JSON.parse(row.new_titles || "[]"); } catch { /* ignore malformed */ }

    const head = document.createElement("div");
    head.className = "log-head";
    head.innerHTML = `<span><span class="log-site">${escapeHtml(row.site_name)}</span> <span class="log-counts${failed ? " status-failed" : ""}">— +${row.new_articles} new, ${row.updated_articles} updated, ${row.errors} errors (${row.urls_in_sitemap} discovered)</span></span><span class="log-when">${when}</span>`;
    li.appendChild(head);

    if (titles.length) {
      const list = document.createElement("ul");
      list.className = "log-titles hidden";
      list.innerHTML = titles.map((t) => `<li><a href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.title)}</a></li>`).join("");
      head.addEventListener("click", () => list.classList.toggle("hidden"));
      li.appendChild(list);
    }
    els.logList.appendChild(li);
  }
}

// ---------- sources ----------

let sitesConfigCache = null;

async function fetchSitesConfig() {
  if (sitesConfigCache) return sitesConfigCache;
  const res = await fetch(SITES_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`could not fetch ${SITES_URL} (${res.status})`);
  sitesConfigCache = await res.json();
  return sitesConfigCache;
}

async function loadSourcesList() {
  els.sourcesList.innerHTML = "<li>Loading…</li>";
  try {
    const cfg = await fetchSitesConfig();
    els.sourcesList.innerHTML = "";
    for (const site of cfg.sites || []) {
      const li = document.createElement("li");
      const robotsOff = site.respectRobotsTxt === false || (cfg.respectRobotsTxt === false && site.respectRobotsTxt !== true);
      const urls = [...(site.sitemapUrls || []), ...(site.rssUrls || [])];
      li.innerHTML = `
        <span class="source-name">${escapeHtml(site.name)}</span>
        ${robotsOff ? '<span class="source-flag">robots.txt bypassed</span>' : ""}
        ${urls.map((u) => `<span class="source-url">${escapeHtml(u)}</span>`).join("")}
      `;
      els.sourcesList.appendChild(li);
    }
    if (!cfg.sites?.length) els.sourcesList.innerHTML = '<li class="reports-empty">No sources configured.</li>';
  } catch {
    els.sourcesList.innerHTML = '<li class="reports-empty">Could not load sites.json.</li>';
  }
}

async function exportSourcesConfig() {
  try {
    const cfg = await fetchSitesConfig();
    downloadBlob(new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" }), "sites.json");
  } catch (err) {
    alert("Could not export sources config: " + err.message);
  }
}

// ---------- export / import ----------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportDatabase() {
  if (!dbBytesForExport) return;
  downloadBlob(new Blob([dbBytesForExport], { type: "application/x-sqlite3" }), "blogs.db");
}

function exportJsonl() {
  const rows = queryAll(
    state.db,
    `SELECT a.id, a.url, a.title, a.author, a.site_name, a.published_at, a.word_count, a.content_text,
            (SELECT GROUP_CONCAT(t.name, '|') FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id) AS tags
     FROM articles a ORDER BY a.published_at ASC`
  );
  const lines = rows.map((r) =>
    JSON.stringify({
      id: r.id,
      url: r.url,
      title: r.title,
      author: r.author,
      site: r.site_name,
      published_at: r.published_at,
      word_count: r.word_count,
      tags: r.tags ? r.tags.split("|") : [],
      text: r.content_text,
    })
  );
  downloadBlob(new Blob([lines.join("\n")], { type: "application/jsonl" }), "articles-export.jsonl");
}

function exportOverlay() {
  downloadBlob(new Blob([JSON.stringify(loadOverlay(), null, 2)], { type: "application/json" }), "blog-archive-state.json");
}

function importOverlay(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      const current = loadOverlay();
      const merged = {
        read: { ...current.read, ...(incoming.read || {}) },
        unread: [...new Set([...current.unread, ...(incoming.unread || [])])],
        manualTags: mergeTagMaps(current.manualTags, incoming.manualTags),
        removedManualTags: mergeTagMaps(current.removedManualTags, incoming.removedManualTags),
      };
      saveOverlay(merged);
      applyOverlayToDb(state.db, merged);
      populateTagList();
      runQuery();
      alert("Imported. Read state and tags merged in.");
    } catch (err) {
      alert("Could not import that file: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
}

function mergeTagMaps(a, b) {
  const out = { ...a };
  for (const [url, names] of Object.entries(b || {})) {
    out[url] = [...new Set([...(out[url] || []), ...names])];
  }
  return out;
}

// ---------- ask your archive (retrieval + AI Q&A) ----------

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "have",
  "has", "what", "when", "where", "how", "why", "who", "did", "does", "about",
  "over", "last", "years", "year", "into", "from", "their", "its", "been",
  "there", "which", "will", "would", "could", "than", "then", "them", "they",
]);

const DEFAULT_PROMPT_TEMPLATE = `Answer the question using ONLY the articles below from the user's personal archive. Cite sources
inline like [1], [2] for every claim. If the articles don't contain enough information to answer
well, say so plainly instead of guessing or using outside knowledge.

ARTICLES:

{{articles}}

QUESTION: {{question}}`;

function loadAiSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY));
    return {
      provider: parsed.provider || "groq",
      groqKey: parsed.groqKey || "",
      geminiKey: parsed.geminiKey || "",
      localUrl: parsed.localUrl || "http://localhost:1234/v1/chat/completions",
      localModel: parsed.localModel || "",
      promptTemplate: parsed.promptTemplate || DEFAULT_PROMPT_TEMPLATE,
    };
  } catch {
    return {
      provider: "groq", groqKey: "", geminiKey: "",
      localUrl: "http://localhost:1234/v1/chat/completions", localModel: "",
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    };
  }
}

function saveAiSettings(settings) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
}

function wireAskPanel() {
  const settings = loadAiSettings();
  els.askProvider.value = settings.provider;
  applyProviderVisibility(settings.provider);
  els.askApiKey.value = settings.provider === "gemini" ? settings.geminiKey : settings.groqKey;
  els.askLocalUrl.value = settings.localUrl;
  els.askLocalModel.value = settings.localModel;
  els.askPromptTemplate.value = settings.promptTemplate;

  els.askBtn.addEventListener("click", () => {
    els.askPanel.classList.toggle("hidden");
    if (!els.askPanel.classList.contains("hidden")) els.askInput.focus();
  });
  els.askCloseBtn.addEventListener("click", () => els.askPanel.classList.add("hidden"));
  els.askSettingsBtn.addEventListener("click", () => els.askSettings.classList.toggle("hidden"));

  els.askProvider.addEventListener("change", () => {
    const s = loadAiSettings();
    s.provider = els.askProvider.value;
    saveAiSettings(s);
    applyProviderVisibility(s.provider);
    els.askApiKey.value = s.provider === "gemini" ? s.geminiKey : s.groqKey;
  });
  els.askApiKey.addEventListener("input", () => {
    const s = loadAiSettings();
    if (s.provider === "gemini") s.geminiKey = els.askApiKey.value;
    else s.groqKey = els.askApiKey.value;
    saveAiSettings(s);
  });
  els.askLocalUrl.addEventListener("input", () => {
    const s = loadAiSettings();
    s.localUrl = els.askLocalUrl.value;
    saveAiSettings(s);
  });
  els.askLocalModel.addEventListener("input", () => {
    const s = loadAiSettings();
    s.localModel = els.askLocalModel.value;
    saveAiSettings(s);
  });
  els.askPromptTemplate.addEventListener("input", () => {
    const s = loadAiSettings();
    s.promptTemplate = els.askPromptTemplate.value || DEFAULT_PROMPT_TEMPLATE;
    saveAiSettings(s);
  });

  els.askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = els.askInput.value.trim();
    if (!question) return;
    els.askInput.value = "";
    handleAskQuestion(question);
  });

  els.askCopyBtn.addEventListener("click", () => {
    const question = els.askInput.value.trim();
    if (!question) { alert("Type a question first."); return; }
    handleCopyPrompt(question);
  });
}

function applyProviderVisibility(provider) {
  const isLocal = provider === "local";
  els.askKeyRow.classList.toggle("hidden", isLocal);
  els.askLocalUrlRow.classList.toggle("hidden", !isLocal);
  els.askLocalModelRow.classList.toggle("hidden", !isLocal);
}

// Broad-recall retrieval: OR every meaningful word in the question against
// title/body/keywords, ranked by FTS5's bm25-based `rank`. This is deliberately
// looser than the main search box (which defaults to AND) since the goal here
// is "don't miss anything relevant", not precision — the LLM does the
// precision work afterwards by only using what's actually relevant.
function retrieveForQuestion(question, limit = 12) {
  const words = (question.toLowerCase().match(/[a-z0-9']{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
  const terms = [...new Set(words)].slice(0, 12);
  if (!terms.length) return [];
  const ftsQuery = terms.map((t) => `"${t.replaceAll('"', '')}"`).join(" OR ");
  try {
    return queryAll(
      state.db,
      `SELECT a.id, a.title, a.site_name, a.published_at, a.url, a.excerpt, a.content_text,
              (SELECT GROUP_CONCAT(t.name, ', ') FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.article_id = a.id) AS tags
       FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid
       WHERE articles_fts MATCH $q ORDER BY rank LIMIT $limit`,
      { $q: ftsQuery, $limit: limit }
    );
  } catch {
    return [];
  }
}

function formatArticlesForPrompt(articles, maxChars = 900) {
  return articles
    .map((a, i) => {
      const date = (a.published_at || "").slice(0, 10) || "unknown date";
      const text = (a.content_text || a.excerpt || "").slice(0, maxChars);
      return `[${i + 1}] (${date}) ${a.title} — ${a.site_name}${a.tags ? ` | tags: ${a.tags}` : ""}\n${text}`;
    })
    .join("\n\n---\n\n");
}

function buildAskPrompt(question, articles) {
  const corpus = formatArticlesForPrompt(articles);
  const template = loadAiSettings().promptTemplate || DEFAULT_PROMPT_TEMPLATE;
  return template.replaceAll("{{articles}}", corpus).replaceAll("{{question}}", question);
}

async function callProvider(prompt) {
  const s = loadAiSettings();
  if (s.provider === "groq") {
    if (!s.groqKey) throw new Error("Add a Groq API key in Ask settings (⚙) first.");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.groqKey}`, "Content-Type": "application/json" },
      // gpt-oss is a reasoning model; without reasoning_effort it can burn its
      // entire completion budget on hidden reasoning tokens and return empty
      // content (finish_reason "length", 0 visible output) — same fix already
      // applied on the scraper side in autotag.js.
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        reasoning_effort: "low",
      }),
    });
    if (!res.ok) throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "(no answer returned)";
  }

  if (s.provider === "gemini") {
    if (!s.geminiKey) throw new Error("Add a Gemini API key in Ask settings (⚙) first.");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(s.geminiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "(no answer returned)";
  }

  // Local: any OpenAI-compatible server (LM Studio, Ollama's OpenAI-compat
  // mode, etc). We can't assume every local runtime exposes this, so the
  // URL/model are user-configured rather than guessed.
  if (!s.localUrl) throw new Error("Set your local server URL in Ask settings (⚙) first.");
  const res = await fetch(s.localUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: s.localModel || "local-model", messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`Local model error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "(no answer returned)";
}

function appendAskMessage(role, html) {
  const div = document.createElement("div");
  div.className = `ask-msg ${role}`;
  div.innerHTML = html;
  els.askMessages.appendChild(div);
  els.askMessages.scrollTop = els.askMessages.scrollHeight;
  return div;
}

async function handleAskQuestion(question) {
  document.querySelector(".ask-empty")?.remove();
  appendAskMessage("user", escapeHtml(question));
  const loading = appendAskMessage("assistant loading", '<span class="ask-loading">Searching the archive…</span>');

  const articles = retrieveForQuestion(question);
  if (articles.length === 0) {
    loading.className = "ask-msg assistant";
    loading.innerHTML = "Couldn't find any archived articles matching that question.";
    return;
  }

  loading.querySelector(".ask-loading").textContent = `Found ${articles.length} relevant article(s), asking the AI…`;

  try {
    const prompt = buildAskPrompt(question, articles);
    const answer = await callProvider(prompt);
    const sourcesHtml = articles
      .map((a, i) => `<li>[${i + 1}] <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}</a> — ${escapeHtml(a.site_name)}, ${formatDate(a.published_at)}</li>`)
      .join("");
    loading.className = "ask-msg assistant";
    loading.innerHTML = `${escapeHtml(answer).replaceAll("\n", "<br>")}
      <details class="ask-sources"><summary>${articles.length} source(s)</summary><ol>${sourcesHtml}</ol></details>`;
  } catch (err) {
    loading.className = "ask-msg assistant error";
    loading.textContent = "Error: " + err.message;
  }
  els.askMessages.scrollTop = els.askMessages.scrollHeight;
}

// Builds the same retrieval-augmented prompt as handleAskQuestion but never
// calls any API — just puts it on the clipboard. This is the bridge to
// tools with no local API to call into (the ChatGPT/Claude desktop apps,
// claude.ai, etc): compose it here with your own edited template, paste it
// wherever you actually want an answer from.
async function handleCopyPrompt(question) {
  document.querySelector(".ask-empty")?.remove();
  appendAskMessage("user", escapeHtml(question));

  const articles = retrieveForQuestion(question);
  if (articles.length === 0) {
    appendAskMessage("assistant", "Couldn't find any archived articles matching that question — nothing to copy.");
    return;
  }

  const prompt = buildAskPrompt(question, articles);
  try {
    await navigator.clipboard.writeText(prompt);
    appendAskMessage("assistant", `Copied a prompt built from ${articles.length} article(s) to your clipboard. Paste it into ChatGPT, Claude, or any other tool.`);
  } catch (err) {
    appendAskMessage("assistant error", "Could not copy to clipboard: " + err.message);
  }
  els.askInput.value = "";
  els.askMessages.scrollTop = els.askMessages.scrollHeight;
}

// ---------- tension finder ----------
// Same idea as "Ask", but instead of answering a question, asks the AI to
// surface genuine tensions across a set of recent articles — a surprising
// stat, a gap between a headline claim and lived reality, a contradiction
// between two sources — which is the actual raw material curiosity-driven
// storytelling looks for, rather than a plain summary of "what happened."
// Reuses the same AI provider settings as Ask (⚙ there) rather than
// duplicating that configuration.

const TENSION_PROMPT_TEMPLATE = `You are helping a curiosity-driven storyteller find genuine tensions in the
articles below — a surprising stat, a gap between a headline claim and lived/on-the-ground reality, a
contradiction between two sources, an overlooked consequence. This is for real storytelling, not a listicle:
do not manufacture a tension that isn't actually there, and do not pad the list with weak ones. If you only
find one or two genuine tensions in this set, return only those.

For each tension you find, return a JSON object with exactly these keys:
- "hook": a short, curious framing (a question or observation) someone could open a story with — not clickbait, not a headline.
- "claim_a": {"text": one sentence stating the first fact/claim, "source": the article's number as a bare integer, e.g. 3 — not "[3]" or "Article 3"}
- "claim_b": {"text": one sentence stating the contrasting fact/claim, "source": same format as claim_a}
- "why": one sentence on why these two things are a genuine tension, not just two unrelated facts

Return ONLY a JSON array of these objects — no markdown code fences, no commentary before or after. Return at
most 5. If you find none, return [].

ARTICLES:

{{articles}}`;

function wireTensionPanel() {
  els.tensionBtn.addEventListener("click", () => {
    populateTensionTagFilter();
    els.tensionPanel.classList.toggle("hidden");
  });
  els.tensionCloseBtn.addEventListener("click", () => els.tensionPanel.classList.add("hidden"));
  els.tensionFindBtn.addEventListener("click", handleFindTensions);
}

function populateTensionTagFilter() {
  const currentValue = els.tensionTag.value;
  const rows = queryAll(
    state.db,
    `SELECT t.id, t.name FROM tags t JOIN article_tags at ON at.tag_id = t.id
     GROUP BY t.id ORDER BY COUNT(*) DESC`
  );
  els.tensionTag.innerHTML =
    '<option value="">Any tag</option>' + rows.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("");
  els.tensionTag.value = currentValue;
}

// days=0 means "no date filter, just the most recent `limit`".
function retrieveForTensions(days, tagId, limit = 20) {
  const params = { $limit: limit };
  let dateClause = "";
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    dateClause = "AND substr(COALESCE(a.published_at, a.fetched_at), 1, 10) >= $cutoff";
    params.$cutoff = cutoff;
  }
  let tagClause = "";
  if (tagId) {
    tagClause = "AND EXISTS (SELECT 1 FROM article_tags at2 WHERE at2.article_id = a.id AND at2.tag_id = $tagId)";
    params.$tagId = tagId;
  }
  return queryAll(
    state.db,
    `SELECT a.id, a.title, a.site_name, a.published_at, a.url, a.excerpt, a.content_text,
            (SELECT GROUP_CONCAT(t.name, ', ') FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.article_id = a.id) AS tags
     FROM articles a
     WHERE 1=1 ${dateClause} ${tagClause}
     ORDER BY COALESCE(a.published_at, a.fetched_at) DESC LIMIT $limit`,
    params
  );
}

function buildTensionPrompt(articles) {
  return TENSION_PROMPT_TEMPLATE.replaceAll("{{articles}}", formatArticlesForPrompt(articles, 500));
}

// The prompt asks for bare JSON, but models sometimes wrap it in a markdown
// fence anyway — strip that defensively rather than failing on it. Shared by
// tension finder and the daily brief, which use the same "structured JSON
// array" response shape.
function parseJsonArrayResponse(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Model didn't return a JSON array");
  return parsed;
}

// Renders one claim as a cited quote block. Despite the prompt asking for a
// bare integer source, models sometimes return "[3]" or "Article 3" anyway —
// pull the first number out rather than trusting the format, so the
// citation link still resolves either way.
function renderClaimHtml(claim, articles) {
  const match = String(claim?.source ?? "").match(/\d+/);
  const idx = match ? Number(match[0]) : 0;
  const src = articles[idx - 1];
  const cite = src
    ? `<cite>[${idx}] <a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(src.title)}</a> — ${escapeHtml(src.site_name)}, ${formatDate(src.published_at)}</cite>`
    : "";
  return `<div class="tension-claim">${escapeHtml(claim?.text || "")}${cite}</div>`;
}

function renderTensions(tensions, articles) {
  els.tensionResults.innerHTML = "";
  if (!tensions.length) {
    els.tensionResults.innerHTML =
      '<p class="ask-empty">No genuine tensions found in this set — try a wider date range or a different topic.</p>';
    return;
  }
  for (const t of tensions) {
    const div = document.createElement("div");
    div.className = "tension-card";
    div.innerHTML = `
      <p class="tension-hook">${escapeHtml(t.hook || "")}</p>
      <div class="tension-claims">
        ${renderClaimHtml(t.claim_a, articles)}
        <div class="tension-vs">vs</div>
        ${renderClaimHtml(t.claim_b, articles)}
      </div>
      ${t.why ? `<p class="tension-why">${escapeHtml(t.why)}</p>` : ""}
    `;
    els.tensionResults.appendChild(div);
  }
}

async function handleFindTensions() {
  const days = Number(els.tensionScope.value);
  const tagId = Number(els.tensionTag.value) || 0;
  els.tensionResults.innerHTML = '<p class="tension-loading">Gathering recent articles…</p>';

  const articles = retrieveForTensions(days, tagId);
  if (!articles.length) {
    els.tensionResults.innerHTML = '<p class="ask-empty">No articles found for that scope — try widening the date range.</p>';
    return;
  }

  els.tensionResults.innerHTML = `<p class="tension-loading">Found ${articles.length} article(s), asking the AI to find tensions…</p>`;

  try {
    const prompt = buildTensionPrompt(articles);
    const raw = await callProvider(prompt);
    const tensions = parseJsonArrayResponse(raw);
    renderTensions(tensions, articles);
  } catch (err) {
    els.tensionResults.innerHTML = `<p class="tension-error">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// ---------- today's brief ----------
// The "every day I open the tool, give me something" feature: on load, if
// an AI provider is already configured and there's no cached brief for
// today yet, quietly generates one from the user's unread backlog — same
// "what's genuinely worth noticing" reasoning as the tension finder, just
// scoped automatically instead of the user picking a range. Cached once per
// calendar day (so re-opening the tool the same day costs no extra API
// call), and articles actually cited in a past brief are excluded from
// future ones so the same item doesn't keep resurfacing.

const DAILY_BRIEF_KEY = "blogArchive.dailyBrief.v1";
const DAILY_BRIEF_SEEN_KEY = "blogArchive.dailyBriefSeenIds.v1";
const DAILY_BRIEF_UNREAD_DAYS_PRIMARY = 3;
const DAILY_BRIEF_UNREAD_DAYS_FALLBACK = 7;
const DAILY_BRIEF_SEEN_CAP = 150;

const DAILY_BRIEF_PROMPT_TEMPLATE = `You are picking out what's genuinely worth a curiosity-driven storyteller's
attention today, from the articles below (their unread backlog from the last few days). Look for: a surprising
fact, an overlooked consequence, a contradiction between two claims or sources, a hidden system behind
something ordinary, a quiet change happening, a gap between assumption and reality, or a question nobody
seems to be asking. This is not a news summary — skip anything that's just "here's what happened," and don't
manufacture significance where there isn't any. If nothing here is genuinely worth surfacing, return [].

For each item, return a JSON object with exactly these keys:
- "hook": a short, curious framing (a question or observation) — not clickbait, not a headline.
- "claims": an array of 1 or 2 objects {"text": one sentence stating the fact/claim, "source": the article's number as a bare integer, e.g. 3}. Use 2 when it's a genuine contradiction/tension between two things; use 1 when it's a single striking fact.
- "why": one sentence on why this is worth noticing.

Return ONLY a JSON array of these objects — no markdown code fences, no commentary before or after. Return at
most 5, ranked most-interesting first.

ARTICLES:

{{articles}}`;

// Local (not UTC) calendar date, so "today" matches the user's actual day
// rather than flipping at UTC midnight mid-afternoon somewhere.
function localDateString(d = new Date()) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}

function loadDailyBrief() {
  try {
    return JSON.parse(localStorage.getItem(DAILY_BRIEF_KEY));
  } catch {
    return null;
  }
}

function saveDailyBrief(obj) {
  localStorage.setItem(DAILY_BRIEF_KEY, JSON.stringify(obj));
}

function loadSeenIds() {
  try {
    const arr = JSON.parse(localStorage.getItem(DAILY_BRIEF_SEEN_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function addSeenIds(ids) {
  const capped = [...loadSeenIds(), ...ids].slice(-DAILY_BRIEF_SEEN_CAP);
  localStorage.setItem(DAILY_BRIEF_SEEN_KEY, JSON.stringify(capped));
}

function setTodayBadge(show) {
  els.todayBadge.classList.toggle("hidden", !show);
}

function hasConfiguredAiProvider() {
  const s = loadAiSettings();
  if (s.provider === "local") return !!s.localUrl;
  if (s.provider === "gemini") return !!s.geminiKey;
  return !!s.groqKey;
}

// days-back window on the unread backlog; excludeIds are article ids already
// cited in a previous brief, kept out so the same item doesn't repeat.
function retrieveForDailyBrief(days, excludeIds, limit = 20) {
  const cutoff = localDateString(new Date(Date.now() - days * 86400000));
  // excludeIds are our own internal integer article ids, never user input,
  // so inlining them directly (rather than binding) is safe here.
  const excludeClause = excludeIds.length ? `AND a.id NOT IN (${excludeIds.join(",")})` : "";
  return queryAll(
    state.db,
    `SELECT a.id, a.title, a.site_name, a.published_at, a.url, a.excerpt, a.content_text,
            (SELECT GROUP_CONCAT(t.name, ', ') FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.article_id = a.id) AS tags
     FROM articles a
     WHERE a.read_at IS NULL
       AND substr(COALESCE(a.published_at, a.fetched_at), 1, 10) >= $cutoff
       ${excludeClause}
     ORDER BY COALESCE(a.published_at, a.fetched_at) DESC LIMIT $limit`,
    { $cutoff: cutoff, $limit: limit }
  );
}

function buildDailyBriefPrompt(articles) {
  return DAILY_BRIEF_PROMPT_TEMPLATE.replaceAll("{{articles}}", formatArticlesForPrompt(articles, 500));
}

function renderDailyBriefItems(items, articles) {
  els.todayResults.innerHTML = "";
  if (!items.length) {
    els.todayResults.innerHTML =
      '<p class="ask-empty">Nothing stood out in your unread backlog today — check back tomorrow, or browse the archive directly.</p>';
    return;
  }
  for (const item of items) {
    const claims = Array.isArray(item.claims) ? item.claims : [];
    const claimsHtml = claims
      .map((c) => renderClaimHtml(c, articles))
      .join(claims.length > 1 ? '<div class="tension-vs">vs</div>' : "");
    const div = document.createElement("div");
    div.className = "tension-card";
    div.innerHTML = `
      <p class="tension-hook">${escapeHtml(item.hook || "")}</p>
      <div class="tension-claims">${claimsHtml}</div>
      ${item.why ? `<p class="tension-why">${escapeHtml(item.why)}</p>` : ""}
    `;
    els.todayResults.appendChild(div);
  }
}

async function generateDailyBrief(force) {
  const today = localDateString();
  if (!force) {
    const cached = loadDailyBrief();
    if (cached && cached.date === today) {
      renderDailyBriefItems(cached.items, cached.articles || []);
      return cached;
    }
  }

  if (!hasConfiguredAiProvider()) {
    els.todayResults.innerHTML = '<p class="ask-empty">Set up an AI provider in 💬 Ask\'s ⚙ settings first, then reopen 🔆 Today.</p>';
    return null;
  }

  els.todayResults.innerHTML = '<p class="tension-loading">Gathering your unread backlog…</p>';
  const seen = loadSeenIds();
  let articles = retrieveForDailyBrief(DAILY_BRIEF_UNREAD_DAYS_PRIMARY, seen);
  if (articles.length < 5) articles = retrieveForDailyBrief(DAILY_BRIEF_UNREAD_DAYS_FALLBACK, seen);

  if (!articles.length) {
    const empty = { date: today, items: [], articles: [], opened: false };
    saveDailyBrief(empty);
    els.todayResults.innerHTML = '<p class="ask-empty">No new unread articles in the last week — nothing to brief today.</p>';
    return empty;
  }

  els.todayResults.innerHTML = `<p class="tension-loading">Found ${articles.length} unread article(s), picking out what's worth noticing…</p>`;

  try {
    const prompt = buildDailyBriefPrompt(articles);
    const raw = await callProvider(prompt);
    const items = parseJsonArrayResponse(raw);
    renderDailyBriefItems(items, articles);

    const briefArticles = articles.map((a) => ({ id: a.id, title: a.title, url: a.url, site_name: a.site_name, published_at: a.published_at }));
    saveDailyBrief({ date: today, items, articles: briefArticles, opened: false });

    // Only articles actually cited in an item get marked "seen" — ones the
    // AI passed over stay eligible for a future brief instead of silently
    // disappearing from consideration forever.
    const citedIndices = new Set();
    for (const item of items) {
      for (const c of item.claims || []) {
        const m = String(c?.source ?? "").match(/\d+/);
        if (m) citedIndices.add(Number(m[0]));
      }
    }
    const citedIds = [...citedIndices].map((i) => articles[i - 1]?.id).filter(Boolean);
    if (citedIds.length) addSeenIds(citedIds);

    return { date: today, items, articles: briefArticles };
  } catch (err) {
    els.todayResults.innerHTML = `<p class="tension-error">Error: ${escapeHtml(err.message)}</p>`;
    return null;
  }
}

function maybeGenerateDailyBriefOnLoad() {
  const today = localDateString();
  const cached = loadDailyBrief();
  if (cached && cached.date === today) {
    renderDailyBriefItems(cached.items || [], cached.articles || []);
    setTodayBadge(!cached.opened && cached.items && cached.items.length > 0);
    return;
  }
  if (!hasConfiguredAiProvider()) return; // never auto-call an unconfigured provider
  generateDailyBrief(false).then((result) => {
    if (result && result.items && result.items.length && els.todayPanel.classList.contains("hidden")) {
      setTodayBadge(true);
    }
  });
}

function wireTodayPanel() {
  els.todayBtn.addEventListener("click", () => {
    els.todayPanel.classList.toggle("hidden");
    if (!els.todayPanel.classList.contains("hidden")) {
      setTodayBadge(false);
      const cached = loadDailyBrief();
      if (cached) saveDailyBrief({ ...cached, opened: true });
    }
  });
  els.todayCloseBtn.addEventListener("click", () => els.todayPanel.classList.add("hidden"));
  els.todayRefreshBtn.addEventListener("click", () => generateDailyBrief(true));
}

// ---------- misc ----------

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
