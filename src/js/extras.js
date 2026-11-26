// Canvas Planner – extras: search, keyboard-shortcut help, settings/about
// (diagnostics, clear completed, JSON backup) and card tooltips.

import { daysUntilDue } from "./growth.js";
import { isTask, NOTE_STYLES, noteStyle } from "./model.js";

// ---------- Error capture (installed first thing in init) ----------
const MAX_ERRORS = 20;
const errorLog = [];

function stringifyArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack.split("\n").slice(1, 6).join("\n")}` : ""}`;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Strip anything that looks like a secret before it ends up in copied diagnostics.
function redact(s) {
  return String(s)
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "$1[REDACTED]")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/((?:access_token|refresh_token|token|code|password|secret|key)=)[^&\s"']+/gi, "$1[REDACTED]");
}

function logError(kind, parts) {
  const text = redact(parts.map(stringifyArg).join(" ")).slice(0, 800);
  errorLog.push(`${new Date().toISOString()} [${kind}] ${text}`);
  if (errorLog.length > MAX_ERRORS) errorLog.shift();
}

let captureInstalled = false;
function installErrorCapture() {
  if (captureInstalled) return;
  captureInstalled = true;
  const orig = console.error.bind(console);
  console.error = (...args) => {
    try { logError("console.error", args); } catch {}
    orig(...args);
  };
  addEventListener("error", (e) => {
    const where = e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno}:${e.colno})` : "";
    logError("error", [e.error || e.message || "Unknown error", where]);
  });
  addEventListener("unhandledrejection", (e) => logError("unhandledrejection", [e.reason ?? "Unknown rejection"]));
}

// ---------- Helpers ----------
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl";
const isTyping = (el) => el?.matches?.("input, textarea, select, [contenteditable]");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (n) => `${Math.round(n * 100)}%`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for webviews without async clipboard permission.
    const ta = el("textarea", { style: "position:fixed;left:-9999px;top:0" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

function formatDue(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// ---------- Init ----------
export async function init(app) {
  if (!Array.isArray(app.errorLog)) installErrorCapture(); // core captures from startup when available

  const store = app.store;
  const slot = app.toolbarSlot;

  // ===== Search =====
  let query = "";
  let matches = [];
  let cursor = -1;

  const searchBtn = el("button", { id: "btn-extras-search", class: "extras-tool", title: `Search (${MOD}+F or /)`, text: "Search" });
  const input = el("input", { type: "search", class: "extras-search-input", placeholder: "Search tasks…", "aria-label": "Search tasks", spellcheck: "false" });
  const count = el("span", { class: "extras-search-count", "aria-live": "polite" });
  const closeBtn = el("button", { class: "extras-search-close", title: "Close search (Esc)", "aria-label": "Close search", text: "×" });
  const searchBox = el("div", { id: "extras-search", class: "extras-search", hidden: "" }, [input, count, closeBtn]);

  const hideDoneOn = () => !!document.querySelector("#chk-hide-done")?.checked;
  const matchesTask = (t, q) => (t.title || "").toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q);

  function computeMatches() {
    const q = query.trim().toLowerCase();
    if (!q) { matches = []; cursor = -1; return; }
    const hide = hideDoneOn();
    const keepId = cursor >= 0 ? matches[cursor] : null;
    matches = store.board.tasks
      .filter((t) => matchesTask(t, q) && !(hide && isTask(t) && t.completedAt && t.id !== app.getSelectedId()))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((t) => t.id);
    cursor = keepId ? matches.indexOf(keepId) : -1;
  }

  function updateCount() {
    if (!query.trim()) count.textContent = "";
    else if (!matches.length) count.textContent = "No matches";
    else if (cursor < 0) count.textContent = plural(matches.length, "match", "matches");
    else count.textContent = `${cursor + 1} of ${matches.length}`;
  }

  let countQueued = false;
  function queueCountUpdate() {
    if (countQueued) return;
    countQueued = true;
    queueMicrotask(() => { countQueued = false; computeMatches(); updateCount(); });
  }

  function openSearch() {
    searchBox.hidden = false;
    searchBtn.hidden = true;
    input.focus();
    input.select();
  }

  function closeSearch() {
    query = "";
    input.value = "";
    matches = [];
    cursor = -1;
    updateCount();
    searchBox.hidden = true;
    searchBtn.hidden = false;
    if (document.activeElement === input) input.blur();
    app.render();
  }

  function cycle(dir) {
    computeMatches();
    if (!matches.length) { updateCount(); return; }
    cursor = cursor < 0 ? (dir > 0 ? 0 : matches.length - 1) : (cursor + dir + matches.length) % matches.length;
    const id = matches[cursor];
    app.revealTask(id);
    updateCount();
  }

  input.addEventListener("input", () => {
    query = input.value;
    cursor = -1;
    computeMatches();
    updateCount();
    app.render();
  });
  searchBtn.addEventListener("click", openSearch);
  closeBtn.addEventListener("click", closeSearch);

  app.addDecorator((task, cardEl) => {
    const q = query.trim().toLowerCase();
    const active = !!q;
    const hit = active && matchesTask(task, q);
    cardEl.classList.toggle("search-hit", hit);
    cardEl.classList.toggle("search-dim", active && !hit);
    if (active) queueCountUpdate();

    // Tooltip: full title + due date.
    let tip = task.title?.trim() || "Untitled";
    if (task.due) tip += `\nDue: ${formatDue(task.due)}`;
    if (task.completedAt) tip += "\nDone";
    if (cardEl.title !== tip) cardEl.title = tip;
  });

  // ===== Keyboard =====
  app.addKeyHandler((e) => {
    const mod = e.metaKey || e.ctrlKey;
    const inSearch = e.target === input;

    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") { openSearch(); return true; }

    if (inSearch) {
      if (e.key === "Escape") { closeSearch(); return true; }
      if (e.key === "Enter") { cycle(e.shiftKey ? -1 : 1); return true; }
      return false; // core sees a focused input and ignores the key

    }

    if (isTyping(e.target) || mod || e.altKey) return false;
    if (e.key === "/") { openSearch(); return true; }
    if (e.key === "?") { openHelp(); return true; }
    if (e.key === "Escape" && !searchBox.hidden && query) { closeSearch(); return true; }
    return false;
  });

  // ===== Shortcut help =====
  const helpBtn = el("button", { id: "btn-extras-help", class: "extras-tool", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", text: "Shortcuts" });
  helpBtn.addEventListener("click", () => openHelp());

  function growthText() {
    const g = app.getGrowth();
    const ageDays = Math.round(g.ageMax / g.agePerDay);
    return [
      g.agePerDay === 0 ? "Growth from age is off." : `<b>Age:</b> a card grows ${pct(g.agePerDay)} for each day it exists, up to +${pct(g.ageMax)} (after about ${plural(ageDays, "day")}).`,
      `<b>Due date:</b> starting ${plural(g.dueWindowDays, "day")} before it's due, it grows steadily to +${pct(g.dueMax)} on the due date.`,
      `<b>Overdue:</b> it keeps growing ${pct(g.overduePerDay)} per day, up to +${pct(g.overdueMax)} more, and gets a red outline.`,
      `Age and due-date growth add up, capped at ${g.maxScale}× normal size. Colour shifts from yellow to red as a card grows.`,
      `<b>Done:</b> completed cards shrink to ${g.doneScale}× and fade.`,
    ];
  }

  function openHelp() {
    const k = (...keys) => keys.map((x) => `<kbd>${esc(x)}</kbd>`).join(" + ");
    const groups = [
      ["Canvas", [
        ["Pan", "Drag empty space, or scroll"],
        ["Zoom", isMac ? "Pinch, or ⌘ + scroll" : "Ctrl + scroll, or pinch"],
        ["Zoom in / out", `${k("+")} / ${k("−")}`],
        ["Reset zoom to 100%", k("0")],
        ["Zoom to fit all cards", k("F")],
      ]],
      ["Tasks", [
        ["New note or task", `${k("N")}, or double-click empty space`],
        ["Add a timer, document or other element", "Open the arrow beside New note"],
        ["Edit a task in place", "Double-click it"],
        ["Switch between title and notes", k("Tab")],
        ["Finish editing the title", k("Enter")],
        ["Finish editing from title or notes", `${k(MOD, "Enter")} or ${k("Esc")}`],
        ["Move a task", "Drag it"],
        ["Resize a note or label", "Drag its bottom-right corner"],
        ["Add a label", "Right-click empty canvas space and choose Label"],
        ["Edit title of selected task", k("Enter")],
        ["Mark selected done / not done", k("Space")],
        ["Delete selected task", `${k("Delete")} or ${k("Backspace")}`],
        ["Undo delete", k(MOD, "Z")],
        ["Deselect / leave a text field", k("Esc")],
      ]],
      ["Links, attachments and sub-canvases", [
        ["Add a linked card", "Hover near a card’s edge and click +"],
        ["Link cards or create a linked card", "Drag from + to a card or empty space"],
        ["Change or remove a link", "Click its label"],
        ["Add a file or image", `Drop it on the canvas or paste with ${k(MOD, "V")}`],
        ["Open a file or image", "Double-click it"],
        ["Open a sub-canvas", `Click it, or select it and press ${k("Enter")}`],
        ["Go up one canvas", `Click the breadcrumb or press ${k("Esc")} with no card selected`],
        ["Move a card into a sub-canvas", "Drag it onto the sub-canvas card"],
      ]],
      ["Search", [
        ["Open search", `${k(MOD, "F")} or ${k("/")}`],
        ["Next / previous match", `${k("Enter")} / ${k("Shift", "Enter")}`],
        ["Clear and close search", k("Esc")],
        ["Show this help", k("?")],
      ]],
    ];
    const html =
      groups.map(([name, rows]) =>
        `<h3 class="extras-h3">${name}</h3><table class="extras-keys">` +
        rows.map(([what, keys]) => `<tr><td>${esc(what)}</td><td>${keys}</td></tr>`).join("") +
        `</table>`).join("") +
      `<h3 class="extras-h3">How cards grow</h3><ul class="extras-growth">` +
      growthText().map((li) => `<li>${li}</li>`).join("") + `</ul>`;
    app.openModal("Keyboard shortcuts", html);
  }

  // ===== Settings / About =====
  const gearBtn = el("button", { id: "btn-extras-settings", class: "extras-tool", title: "Settings", "aria-label": "Settings" }, [
    el("span", { class: "toolbar-gear", "aria-hidden": "true", text: "⚙" }),
    el("span", { class: "toolbar-settings-label", text: "Settings" }),
  ]);
  gearBtn.addEventListener("click", () => openSettings());

  async function appVersion() {
    try {
      const v = await window.__TAURI__?.app?.getVersion?.();
      return v || "dev";
    } catch { return "dev"; }
  }

  async function dataFolder() {
    if (!app.invoke) return "n/a";
    try { return String(await app.invoke("data_folder")); }
    catch (e) { return `error: ${redact(e)}`; }
  }

  function taskCounts() {
    const now = Date.now();
    let open = 0, done = 0, overdue = 0;
    for (const t of store.board.tasks) {
      if (!isTask(t)) continue;
      if (t.completedAt) done++;
      else {
        open++;
        if (t.due && daysUntilDue(t.due, now) < 0) overdue++;
      }
    }
    return { open, done, overdue, total: open + done, tombstones: Object.keys(store.board.deleted || {}).length };
  }

  function featureModules() {
    const loaded = Array.isArray(app.loadedFeatures) ? app.loadedFeatures : null;
    const find = (word) =>
      !!document.querySelector(`[id*="${word}" i], [class*="${word}" i]`) ||
      [...slot.children].some((n) => new RegExp(word, "i").test(`${n.title || ""} ${n.textContent || ""}`));
    const result = {
      sync: loaded ? loaded.includes("sync") : find("sync"),
      importer: loaded ? loaded.includes("importer") : find("import"),
      extras: true,
    };
    const slotItems = [...slot.children]
      .filter((n) => !n.id?.startsWith("btn-extras") && n.id !== "extras-search")
      .map((n) => n.id || n.title || n.textContent.trim().slice(0, 30) || n.tagName.toLowerCase());
    return { result, slotItems, source: loaded ? "app.loadedFeatures" : "toolbar heuristic" };
  }

  function syncKeyNames() {
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && /sync|github|gist|onedrive|graph|microsoft|ms-|token|secret/i.test(key)) names.push(key);
    }
    return names.sort();
  }

  async function diagnostics() {
    const [version, folder] = await Promise.all([appVersion(), dataFolder()]);
    const c = taskCounts();
    const f = featureModules();
    const keys = syncKeyNames();
    const errs = (Array.isArray(app.errorLog) ? app.errorLog : errorLog).map((e) => redact(e));
    const lines = [
      "Canvas Planner diagnostics",
      `Generated: ${new Date().toISOString()} (local: ${new Date().toString()})`,
      `App version: ${version}`,
      `Runtime: ${app.isDesktop ? "desktop (Tauri)" : "plain browser"}`,
      `Platform: ${navigator.userAgentData?.platform || navigator.platform || "unknown"}`,
      `User agent: ${navigator.userAgent}`,
      `Language: ${navigator.language}`,
      `Screen: ${screen.width}x${screen.height}, window ${innerWidth}x${innerHeight}, devicePixelRatio ${devicePixelRatio}`,
      `Data folder: ${folder}`,
      `Tasks: ${c.total} total, ${c.open} open, ${c.done} done, ${c.overdue} overdue, ${c.tombstones} deletion tombstones`,
      `Feature modules (${f.source}): ${Object.entries(f.result).map(([k, v]) => `${k}=${v ? "loaded" : "not detected"}`).join(", ")}`,
      `Toolbar slot items: ${f.slotItems.length ? f.slotItems.join(", ") : "(none besides extras)"}`,
      `Sync-related localStorage keys (names only): ${keys.length ? keys.join(", ") : "(none)"}`,
      "",
      `Recent errors (${errs.length}, newest last):`,
      ...(errs.length ? errs : ["(none)"]),
    ];
    return lines.join("\n");
  }

  const updateSection = el("section", { class: "extras-update" });
  if (app.isDesktop) {
    const updateButton = el("button", { class: "small", text: "Update from GitHub" });
    const updateStatus = el("p", { class: "hint", role: "status" });
    updateButton.addEventListener("click", async () => {
      updateButton.disabled = true;
      updateStatus.textContent = "Checking GitHub and downloading any available update…";
      try {
        const version = await app.invoke("prepare_update");
        if (!version) {
          updateStatus.textContent = "You’re using the latest version.";
          return;
        }
        updateStatus.textContent = `Restarting to apply version ${version}…`;
        await store.flushForRestart();
        await app.invoke("apply_update");
      } catch (error) {
        updateStatus.textContent = `Couldn't update. ${error.message || error}`;
      } finally {
        updateButton.disabled = false;
      }
    });
    updateSection.append(el("h3", { class: "extras-h3", text: "App updates" }), updateButton, updateStatus);
    app.invoke("update_result").then((message) => {
      if (message) {
        updateStatus.textContent = message;
        app.toast(message, { ms: 10000 });
      }
    }).catch((error) => console.warn("Could not read update result", error));
  }

  async function openSettings() {
    const body = el("div", { class: "extras-settings" });
    const versionEl = el("span", { text: "…" });
    const folderEl = el("code", { class: "extras-path", text: "…" });
    const copyFolderBtn = el("button", { class: "ghost small", text: "Copy", disabled: "" });
    const c = taskCounts();

    const defaultTask = el("input", { type: "checkbox" });
    defaultTask.checked = app.canvasSettings.get("defaultTaskMode", false);
    defaultTask.addEventListener("change", () => {
      app.canvasSettings.set("defaultTaskMode", defaultTask.checked);
      app.updateNewButton();
    });
    const hideDone = el("input", { type: "checkbox" });
    hideDone.checked = app.getHideDone();
    hideDone.addEventListener("change", () => app.setHideDone(hideDone.checked));
    const defaultStyle = el("select", { "aria-label": "Default note style" });
    for (const [value, text] of Object.entries(NOTE_STYLES)) defaultStyle.append(el("option", { value, text }));
    defaultStyle.value = noteStyle(app.canvasSettings.get("defaultNoteStyle", "card"));
    defaultStyle.addEventListener("change", () => app.canvasSettings.set("defaultNoteStyle", defaultStyle.value));
    const theme = el("select", { "aria-label": "Colour theme" });
    for (const [value, text] of [["system", "Use system setting"], ["light", "Light paper"], ["dark", "Charcoal"]]) {
      theme.append(el("option", { value, text }));
    }
    theme.value = localStorage.getItem("pinboard-theme") || "system";
    theme.onchange = () => {
      localStorage.setItem("pinboard-theme", theme.value);
      document.documentElement.dataset.theme = theme.value;
    };
    body.append(el("h3", {class: "extras-h3", text: "Appearance"}), el("label", {}, ["Colour theme", theme]));
    const workspace = app.getWorkspace();
    body.append(el("h3", { class: "extras-h3", text: "Canvas" }));
    if (workspace) {
      const name = el("input", { type: "text", maxlength: "100" });
      name.value = workspace.title;
      name.addEventListener("change", () => {
        name.value = name.value.trim() || workspace.title;
        store.update(workspace.id, { title: name.value });
        app.render();
      });
      body.append(el("label", {}, [el("span", { text: "Canvas name" }), name]));
    }
    body.append(
      el("label", { class: "settings-toggle" }, [defaultTask, document.createTextNode("Start new notes in task mode")]),
      el("label", {}, ["Default note style", defaultStyle]),
      el("label", { class: "settings-toggle" }, [hideDone, document.createTextNode("Hide completed tasks")]),
      el("h3", { class: "extras-h3", text: "Task growth" }),
      el("p", { class: "hint", text: app.isDashboard() ? "Defaults for new canvases on this device. These also apply to the original canvas." : "These settings apply on this device to this canvas and its sub-canvases." }),
    );

    const growthFields = [
      ["agePerDay", "Size increase per day (%)", 100, 100],
      ["ageMax", "Maximum increase from age (%)", 100, 260],
      ["dueWindowDays", "Days before due-date growth starts", 1, 90],
      ["overduePerDay", "Extra increase per overdue day (%)", 100, 100],
    ];
    const fields = el("div", { class: "settings-growth" });
    const refreshGrowth = [];
    for (const [key, label, multiplier, max] of growthFields) {
      const input = el("input", { type: "number", min: "0", max: String(max), step: "1" });
      const refresh = () => { input.value = String(Math.round(app.getGrowth()[key] * multiplier)); };
      refresh();
      refreshGrowth.push(refresh);
      input.addEventListener("change", () => {
        const value = input.valueAsNumber;
        if (input.validity.valid && Number.isFinite(value)) {
          app.setGrowth({ ...app.getGrowth(), [key]: value / multiplier });
        }
        refresh();
      });
      fields.append(el("label", {}, [el("span", { text: label }), input]));
    }
    const resetGrowth = el("button", { class: "ghost small", text: "Reset growth to defaults" });
    resetGrowth.addEventListener("click", () => {
      app.setGrowth({});
      refreshGrowth.forEach((refresh) => refresh());
    });
    body.append(fields, resetGrowth, el("h3", { class: "extras-h3", text: "About" }),
      el("dl", { class: "extras-about" }, [
        el("dt", { text: "Version" }), el("dd", {}, versionEl),
        el("dt", { text: "Data folder" }), el("dd", { class: "extras-folder" }, [folderEl, copyFolderBtn]),
        el("dt", { text: "Tasks" }), el("dd", { text: `${c.open} open · ${c.done} done · ${c.overdue} overdue` }),
      ]),
    );
    if (app.isDesktop) body.append(updateSection);

    // Diagnostics + backup
    const diagBtn = el("button", { class: "small", text: "Copy diagnostics" });
    const jsonBtn = el("button", { class: "small", text: "Copy board as JSON" });
    body.append(
      el("h3", { class: "extras-h3", text: "Support & backup" }),
      el("div", { class: "extras-row" }, [diagBtn, jsonBtn]),
      el("p", { class: "hint", text: "Diagnostics include version, system info, task counts and recent errors. No task text or tokens." }),
    );

    // Clear completed (two-step confirm)
    const entireBoard = app.isDashboard();
    const completedTasks = () => store.board.tasks.filter((task) =>
      isTask(task) && task.completedAt && (entireBoard || app.getWorkspace(task.canvasId)?.id === workspace?.id));
    const clearBtn = el("button", { class: "danger small", text: "Clear completed tasks…" });
    const confirmRow = el("div", { class: "extras-confirm", hidden: "" });
    body.append(el("h3", { class: "extras-h3", text: "Clean up" }), el("div", { class: "extras-row" }, [clearBtn]), confirmRow);

    const modal = app.openModal(workspace ? `Settings · ${workspace.title}` : "Settings", body, { fullPage: true, onClose: () => gearBtn.focus() });

    appVersion().then((v) => { versionEl.textContent = v; });
    dataFolder().then((p) => {
      folderEl.textContent = p;
      if (app.invoke && !p.startsWith("error:")) copyFolderBtn.disabled = false;
    });

    copyFolderBtn.addEventListener("click", async () => {
      const ok = await copyText(folderEl.textContent);
      app.toast(ok ? "Data folder path copied" : "Couldn't copy to clipboard");
    });

    diagBtn.addEventListener("click", async () => {
      const ok = await copyText(await diagnostics());
      app.toast(ok ? "Diagnostics copied. Paste them into a chat or issue." : "Couldn't copy to clipboard");
    });

    jsonBtn.addEventListener("click", async () => {
      await store.flush?.();
      const ok = await copyText(JSON.stringify(store.board, null, 2));
      app.toast(ok ? `Board copied as JSON (${plural(store.board.tasks.length, "task")})` : "Couldn't copy to clipboard");
    });

    clearBtn.addEventListener("click", () => {
      const n = completedTasks().length;
      confirmRow.textContent = "";
      if (!n) {
        confirmRow.append(el("span", { text: "There are no completed tasks." }));
        confirmRow.hidden = false;
        return;
      }
      const yes = el("button", { class: "danger small", text: `Delete ${plural(n, "task")}` });
      const no = el("button", { class: "ghost small", text: "Cancel" });
      confirmRow.append(el("span", { text: `Permanently delete ${plural(n, "completed task")}? This can't be undone.` }), yes, no);
      confirmRow.hidden = false;
      clearBtn.disabled = true;
      no.addEventListener("click", () => { confirmRow.hidden = true; clearBtn.disabled = false; });
      yes.addEventListener("click", () => {
        const ids = completedTasks().map((t) => t.id);
        if (ids.includes(app.getSelectedId())) app.select(null);
        let removed = 0;
        for (const id of ids) if (store.remove(id)) removed++;
        app.render();
        modal.close();
        app.toast(`Cleared ${plural(removed, "completed task")}`);
      });
    });
  }

  slot.append(searchBtn, searchBox, helpBtn, gearBtn);
}
