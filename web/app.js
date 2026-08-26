import sqlite3InitModule from "./vendor/sqlite3.mjs";

const PAGE_SIZE = 40;
const DB_URL = "data/blogs.db";
const SQLITE_DESERIALIZE_FREEONCLOSE = 1;
const SQLITE_DESERIALIZE_RESIZEABLE = 2; // without this, any INSERT that grows the db fails with SQLITE_FULL
const OVERLAY_KEY = "blogArchive.overlay.v1";
const THEME_KEY = "blogArchive.theme";

const state = {
  db: null,
  page: 0,
  total: 0,
  query: "",
  siteId: "",
  tagId: 0,
  tagName: "",
  unreadOnly: false,
  selectedId: null,
};

const els = {};
[
  "article-list", "prev-page", "next-page", "page-label", "search-input", "search-help-btn",
  "search-help", "site-filter", "unread-only", "result-count", "db-status", "active-tag-bar",
  "tag-list", "reader-empty", "reader-article", "reader-title", "reader-author", "reader-date",
  "reader-words", "reader-body", "reader-source-link", "reader-pane", "reader-read-toggle",
  "reader-tags", "theme-toggle", "data-menu-btn", "data-menu", "export-db-btn", "export-jsonl-btn",
  "export-overlay-btn", "import-overlay-input", "reports-btn", "reports-menu", "reports-list",
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
    };
  } catch {
    return { read: {}, unread: [], manualTags: {}, removedManualTags: {} };
  }
}

function saveOverlay(overlay) {
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
}

function applyOverlayToDb(db, overlay) {
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
  document.addEventListener("click", (e) => {
    if (!els.dataMenu.contains(e.target) && e.target !== els.dataMenuBtn) els.dataMenu.classList.add("hidden");
    if (!els.reportsMenu.contains(e.target) && e.target !== els.reportsBtn) els.reportsMenu.classList.add("hidden");
  });

  els.exportDbBtn.addEventListener("click", exportDatabase);
  els.exportJsonlBtn.addEventListener("click", exportJsonl);
  els.exportOverlayBtn.addEventListener("click", exportOverlay);
  els.importOverlayInput.addEventListener("change", importOverlay);
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

function commonFilters(alias) {
  return `AND ($siteId = '' OR ${alias}.site_id = $siteId)
          AND ($tagId = 0 OR EXISTS (SELECT 1 FROM article_tags at2 WHERE at2.article_id = ${alias}.id AND at2.tag_id = $tagId))
          AND ($unreadOnly = 0 OR ${alias}.read_at IS NULL)`;
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
