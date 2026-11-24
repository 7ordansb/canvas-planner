// Canvas Planner – core: camera, cards, inline editing, links, sub-canvases,
// side panel, and the `app` API that feature modules (sync, importer, extras) use.

// ---------- Error log (from startup; shown by Settings → Copy diagnostics) ----------
const errorLog = [];
function logErr(kind, args) {
  const text = args
    .map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()))
    .join(" ");
  errorLog.push(`${new Date().toISOString()} [${kind}] ${text}`.slice(0, 800));
  if (errorLog.length > 20) errorLog.shift();
}
for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { try { logErr(`console.${level}`, a); } catch {} orig(...a); };
}
addEventListener("error", (e) => logErr("error", [e.error || e.message]));
addEventListener("unhandledrejection", (e) => logErr("unhandledrejection", [e.reason]));

import { growthOf, daysUntilDue, DAY } from "./growth.js";
import * as store from "./store.js";
import { COLORS, COLOR_BY_KEY, AUTO } from "./model.js";
import { showMenu, closeMenu, isMenuOpen } from "./menus.js";
import * as links from "./links.js";
import { attachments, imageUrl, storeFile, pickFile, formatSize } from "./attachments.js";

const $ = (s) => document.querySelector(s);
const canvas = $("#canvas");
const world = $("#world");
const hint = $("#hint");
const panel = $("#panel");
const fTitle = $("#f-title");
const fDue = $("#f-due");
const fNotes = $("#f-notes");
const fInfo = $("#f-info");
const fColors = $("#f-colors");
const btnComplete = $("#btn-complete");
const btnOpen = $("#btn-open");
const zoomLabel = $("#zoom-label");
const chkHideDone = $("#chk-hide-done");
const timeTravel = $("#time-travel");
const timeLabel = $("#time-label");
const crumbs = $("#crumbs");
const filterBar = $("#filter-bar");

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;

// ---------- State ----------
const cam = { x: innerWidth / 2, y: innerHeight / 2, z: 1 }; // screen = world * z + (x, y)
let currentCanvas = null; // id of the sub-canvas being viewed; null = home
let selectedId = null;
let editingId = null; // card being edited inline
let panelTaskId = null;
let timeOffsetDays = 0;
let hideDone = localStorage.getItem("hideDone") === "1";
const hiddenColors = new Set(JSON.parse(localStorage.getItem("hiddenColors") || "[]"));
const els = new Map(); // element id -> card element (only those visible on this canvas)
const decorators = []; // feature hooks: (task, el) => void, run on every render
let rel = links.computeRelations();

const now = () => Date.now() + timeOffsetDays * DAY;
const isTyping = (el) => el?.matches?.("input, textarea, select, [contenteditable]");
const colorKey = (t) => t.color || AUTO;
const colorable = (t) => t.kind === "task" || t.kind === "canvas";

/** Is this element shown right now (right canvas, not filtered out)? */
function isVisible(t) {
  if ((t.canvasId ?? null) !== currentCanvas) return false;
  if (t.id === selectedId || t.id === editingId) return true;
  if (hideDone && t.completedAt) return false;
  if (colorable(t) && hiddenColors.has(colorKey(t))) return false;
  return true;
}

// ---------- Camera ----------
const cameraKey = () => (currentCanvas ? `camera:${currentCanvas}` : "camera");
let camSaveTimer = null;
function applyCamera() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  world.style.setProperty("--zinv", String(1 / cam.z));
  const grid = 24 * cam.z;
  canvas.classList.toggle("no-grid", cam.z < 0.35);
  canvas.style.backgroundSize = `${grid}px ${grid}px`;
  canvas.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  zoomLabel.textContent = `${Math.round(cam.z * 100)}%`;
  clearTimeout(camSaveTimer);
  const key = cameraKey();
  camSaveTimer = setTimeout(() => localStorage.setItem(key, JSON.stringify(cam)), 400);
}

const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
const toScreen = (wx, wy) => ({ x: wx * cam.z + cam.x, y: wy * cam.z + cam.y });

function zoomAt(sx, sy, z) {
  z = Math.min(3, Math.max(0.1, z));
  const w = toWorld(sx, sy);
  cam.z = z;
  cam.x = sx - w.x * z;
  cam.y = sy - w.y * z;
  hideHandle();
  applyCamera();
}

/** Visible area of the canvas (excluding the side panel), in screen px. */
function viewRect() {
  const right = panel.hidden ? innerWidth : innerWidth - 324;
  return { left: 0, top: 90, right, bottom: innerHeight };
}

function viewCenterWorld() {
  const r = viewRect();
  return toWorld((r.left + r.right) / 2, (r.top + r.bottom) / 2);
}

function fit() {
  const visible = store.board.tasks.filter((t) => els.has(t.id));
  const r = viewRect();
  if (!visible.length) {
    cam.z = 1;
    cam.x = (r.left + r.right) / 2;
    cam.y = (r.top + r.bottom) / 2;
    return applyCamera();
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of visible) {
    const el = els.get(t.id);
    const w = el.offsetWidth / 2, h = el.offsetHeight / 2;
    minX = Math.min(minX, t.x - w); maxX = Math.max(maxX, t.x + w);
    minY = Math.min(minY, t.y - h); maxY = Math.max(maxY, t.y + h);
  }
  const pad = 60;
  const z = Math.min(1.5, Math.max(0.1, Math.min(
    (r.right - r.left - pad * 2) / (maxX - minX || 1),
    (r.bottom - r.top - pad * 2) / (maxY - minY || 1),
  )));
  cam.z = z;
  cam.x = (r.left + r.right) / 2 - ((minX + maxX) / 2) * z;
  cam.y = (r.top + r.bottom) / 2 - ((minY + maxY) / 2) * z;
  applyCamera();
}

/** Pan so an element is centred in view. */
function focusTask(id) {
  const t = store.get(id);
  if (!t) return;
  const r = viewRect();
  cam.x = (r.left + r.right) / 2 - t.x * cam.z;
  cam.y = (r.top + r.bottom) / 2 - t.y * cam.z;
  applyCamera();
}

// ---------- Sub-canvases ----------
function canvasPath() {
  const path = [];
  let id = currentCanvas;
  while (id) {
    const c = store.get(id);
    if (!c) break;
    path.unshift(c);
    id = c.canvasId;
  }
  return path;
}

function enterCanvas(id) {
  if (id && store.get(id)?.kind !== "canvas") return;
  stopEdit();
  closeMenu();
  hideHandle();
  if (selectedId) removeIfEmpty(selectedId);
  selectedId = null;
  localStorage.setItem(cameraKey(), JSON.stringify(cam));
  currentCanvas = id;
  const saved = JSON.parse(localStorage.getItem(cameraKey()) || "null");
  render();
  if (saved && Number.isFinite(saved.z)) { Object.assign(cam, saved); applyCamera(); }
  else fit();
}

function renderCrumbs() {
  const path = canvasPath();
  crumbs.hidden = !path.length;
  if (!path.length) return;
  crumbs.textContent = "";
  const home = document.createElement("button");
  home.textContent = "⌂ Home";
  home.title = "Back to the home canvas";
  home.addEventListener("click", () => enterCanvas(null));
  crumbs.appendChild(home);
  path.forEach((c, i) => {
    crumbs.appendChild(Object.assign(document.createElement("span"), { className: "crumb-sep", textContent: "›" }));
    if (i < path.length - 1) {
      const b = document.createElement("button");
      b.textContent = c.title || "Untitled canvas";
      b.addEventListener("click", () => enterCanvas(c.id));
      crumbs.appendChild(b);
    } else {
      crumbs.appendChild(Object.assign(document.createElement("span"), { className: "crumb-current", textContent: c.title || "Untitled canvas" }));
    }
  });
}

/** Move an element into a sub-canvas (links to things outside it are removed). */
function moveToCanvas(taskId, canvasId, { x, y } = {}) {
  const t = store.get(taskId);
  if (!t || taskId === canvasId) return;
  const before = { canvasId: t.canvasId, x: t.x, y: t.y };
  if (x === undefined) {
    const kids = store.board.tasks.filter((k) => (k.canvasId ?? null) === (canvasId ?? null) && k.id !== taskId);
    if (kids.length) {
      x = Math.max(...kids.map((k) => k.x)) + 260;
      y = kids.reduce((s, k) => s + k.y, 0) / kids.length;
    } else { x = 0; y = 0; }
  }
  const linkIds = store.board.links.filter((l) => l.from === taskId || l.to === taskId).map((l) => l.id);
  const snap = linkIds.length ? store.removeMany({ linkIds }) : null;
  store.update(taskId, { canvasId: canvasId ?? null, x, y });
  if (selectedId === taskId) selectedId = null;
  render();
  const dest = canvasId ? `“${store.get(canvasId)?.title || "Untitled canvas"}”` : "the canvas above";
  setUndo(`Moved “${t.title || "Untitled"}” into ${dest}`, () => {
    store.update(taskId, before);
    if (snap) store.restoreMany(snap);
  });
}

// ---------- Rendering ----------
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function dueText(task, t) {
  if (!task.due) return "";
  const days = daysUntilDue(task.due, t);
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${formatDate(task.due)}`;
}

function fileIcon(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📕";
  if (["xls", "xlsx", "csv", "numbers"].includes(ext)) return "📊";
  if (["doc", "docx", "txt", "md", "rtf", "pages"].includes(ext)) return "📝";
  if (["ppt", "pptx", "key"].includes(ext)) return "📽";
  if (["zip", "7z", "rar", "gz"].includes(ext)) return "🗜";
  if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "🎞";
  if (["mp3", "wav", "m4a"].includes(ext)) return "🎵";
  return "📎";
}

function createCardEl(task) {
  const el = document.createElement("div");
  el.className = `card kind-${task.kind}`;
  el.dataset.id = task.id;
  el.dataset.kind = task.kind;
  switch (task.kind) {
    case "image":
      el.innerHTML = `<div class="img-wrap"><img alt="" draggable="false"><div class="img-missing">Image not on this computer yet</div></div><div class="title caption"></div>`;
      break;
    case "file":
      el.innerHTML = `<div class="file-icon"></div><div class="file-info"><div class="title"></div><div class="meta"></div></div>`;
      break;
    case "canvas":
      el.innerHTML = `<div class="canvas-icon">▦</div><div class="title"></div><div class="meta"></div><div class="canvas-open">Click to open</div>`;
      break;
    default:
      el.innerHTML = `<button class="check" title="Mark complete"></button><div class="title"></div><div class="notes"></div><div class="meta"></div><div class="badges"></div>`;
  }
  return el;
}

function badge(container, text, cls = "") {
  const b = document.createElement("span");
  b.className = `badge ${cls}`;
  b.textContent = text;
  container.appendChild(b);
}

function paint(el, task, autoHue) {
  const c = COLOR_BY_KEY[task.color];
  el.style.setProperty("--hue", String(c ? c.hue : autoHue));
  el.style.setProperty("--sat", `${c ? c.sat : 92}%`);
}

/** Summary + growth for a sub-canvas card, from what's directly inside it. */
function canvasStats(id, t) {
  let open = 0, done = 0, overdue = 0, maxScale = 1, maxUrgency = 0;
  for (const k of store.board.tasks) {
    if (k.canvasId !== id) continue;
    if (k.kind === "task") {
      if (k.completedAt || rel.coveredBy(k)) { done++; continue; }
      open++;
      const g = growthOf(k, t);
      if (g.overdue) overdue++;
      maxScale = Math.max(maxScale, g.scale);
      maxUrgency = Math.max(maxUrgency, g.urgency);
    } else if (k.kind === "canvas") {
      open++;
    }
  }
  return { open, done, overdue, scale: Math.min(2.2, 1 + (maxScale - 1) * 0.6), hue: Math.round(50 - 50 * maxUrgency) };
}

function renderCard(task, el, i, t) {
  const editing = task.id === editingId;
  el.style.left = `${task.x}px`;
  el.style.top = `${task.y}px`;
  el.style.zIndex = String(i + 1);
  el.classList.toggle("selected", task.id === selectedId);
  const title = el.querySelector(".title");

  if (task.kind === "task") {
    const covered = rel.coveredBy(task);
    let g = growthOf(task, t);
    if (covered) g = { ...g, scale: 1, overdue: false };
    el.style.setProperty("--s", g.scale.toFixed(3));
    paint(el, task, g.hue);
    el.classList.toggle("done", !!task.completedAt);
    el.classList.toggle("covered", !!covered);
    el.classList.toggle("overdue", g.overdue);
    if (!editing) {
      setText(title, task.title || "Untitled");
      title.classList.toggle("placeholder", !task.title);
      setText(el.querySelector(".notes"), task.notes);
    }
    const meta = task.completedAt ? "Done" : covered ? `Covered by “${covered.title || "Untitled"}”` : dueText(task, t);
    setText(el.querySelector(".meta"), meta);
    const check = el.querySelector(".check");
    setText(check, task.completedAt ? "✓" : "");
    check.title = task.completedAt ? "Mark not done" : "Mark complete";

    const badges = el.querySelector(".badges");
    badges.textContent = "";
    const blockers = rel.openBlockers(task.id);
    el.classList.toggle("blocked", !task.completedAt && blockers.length > 0);
    if (!task.completedAt && blockers.length) {
      badge(badges, `🔒 Waiting on ${blockers.length === 1 ? `“${blockers[0].title || "Untitled"}”` : `${blockers.length} tasks`}`, "badge-blocked");
    }
    const p = rel.progress(task.id);
    if (p) badge(badges, `✓ ${p.done}/${p.total} subtasks`, p.done === p.total ? "badge-complete" : "");
    if (task.source) badge(badges, task.source);
  } else if (task.kind === "canvas") {
    const s = canvasStats(task.id, t);
    el.style.setProperty("--s", s.scale.toFixed(3));
    paint(el, task, s.hue);
    if (!editing) {
      setText(title, task.title || "Untitled canvas");
      title.classList.toggle("placeholder", !task.title);
    }
    const parts = [];
    if (s.open) parts.push(`${s.open} open`);
    if (s.done) parts.push(`${s.done} done`);
    if (s.overdue) parts.push(`${s.overdue} overdue`);
    setText(el.querySelector(".meta"), parts.join(" · ") || "Empty");
  } else if (task.kind === "image") {
    el.style.setProperty("--w", String(task.w || 260));
    if (!editing) setText(title, task.title || "");
    if (el.dataset.loaded !== task.attachmentId) {
      el.dataset.loaded = task.attachmentId || "";
      imageUrl(task.attachmentId, task.mime).then((url) => {
        el.classList.toggle("missing", !url);
        if (url) el.querySelector("img").src = url;
        links.renderLinksSoon();
      });
    }
  } else if (task.kind === "file") {
    setText(el.querySelector(".file-icon"), fileIcon(task.title));
    if (!editing) setText(title, task.title || "File");
    setText(el.querySelector(".meta"), `${formatSize(task.size)} · double-click to open`);
  }

  for (const fn of decorators) {
    try { fn(task, el); } catch (e) { console.error(e); }
  }
}

function render() {
  if (currentCanvas && store.get(currentCanvas)?.kind !== "canvas") currentCanvas = null; // deleted (e.g. by sync)
  if (editingId && !store.get(editingId)) editingId = null;
  rel = links.computeRelations();
  const t = now();
  const seen = new Set();
  store.board.tasks.forEach((task, i) => {
    if (!isVisible(task)) return;
    seen.add(task.id);
    let el = els.get(task.id);
    if (el && el.dataset.kind !== task.kind) { el.remove(); el = null; }
    if (!el) {
      el = createCardEl(task);
      els.set(task.id, el);
      world.appendChild(el);
    }
    renderCard(task, el, i, t);
  });
  for (const [id, el] of els) {
    if (!seen.has(id)) { el.remove(); els.delete(id); }
  }
  hint.hidden = store.board.tasks.some((x) => (x.canvasId ?? null) === currentCanvas);
  hint.textContent = currentCanvas
    ? "This canvas is empty. Double-click to add a task, or drag cards onto its card from the canvas above."
    : "Double-click anywhere to add a task";
  links.renderLinks();
  renderCrumbs();
  renderFilters();
  updatePanel();
}

// ---------- Colour filters ----------
function swatchCss(key) {
  const c = COLOR_BY_KEY[key];
  return c ? `hsl(${c.hue} ${c.sat}% 72%)` : "linear-gradient(135deg, hsl(50 92% 72%), hsl(0 85% 68%))";
}

function renderFilters() {
  const counts = new Map();
  for (const t of store.board.tasks) {
    if ((t.canvasId ?? null) !== currentCanvas || !colorable(t)) continue;
    counts.set(colorKey(t), (counts.get(colorKey(t)) || 0) + 1);
  }
  const anyHidden = [...counts.keys()].some((k) => hiddenColors.has(k));
  const show = counts.size >= 2 || anyHidden;
  filterBar.hidden = !show;
  if (!show) return;
  const keys = [AUTO, ...COLORS.map((c) => c.key)].filter((k) => counts.has(k));
  const sig = keys.map((k) => `${k}:${counts.get(k)}:${hiddenColors.has(k)}`).join("|");
  if (filterBar.dataset.sig === sig) return;
  filterBar.dataset.sig = sig;
  filterBar.textContent = "";
  filterBar.appendChild(Object.assign(document.createElement("span"), { className: "filter-label", textContent: "Colours" }));
  for (const k of keys) {
    const b = document.createElement("button");
    const off = hiddenColors.has(k);
    b.className = `color-chip${off ? " off" : ""}`;
    const label = k === AUTO ? "Auto (by urgency)" : COLOR_BY_KEY[k].label;
    b.title = `${off ? "Show" : "Hide"} ${label.toLowerCase()} cards`;
    b.innerHTML = `<span class="dot"></span><span class="count"></span>`;
    b.querySelector(".dot").style.background = swatchCss(k);
    b.querySelector(".count").textContent = String(counts.get(k));
    b.addEventListener("click", () => {
      if (hiddenColors.has(k)) hiddenColors.delete(k); else hiddenColors.add(k);
      localStorage.setItem("hiddenColors", JSON.stringify([...hiddenColors]));
      if (selectedId && hiddenColors.has(colorKey(store.get(selectedId) || {}))) selectedId = null;
      render();
    });
    filterBar.appendChild(b);
  }
  if (anyHidden) {
    const all = document.createElement("button");
    all.className = "ghost small";
    all.textContent = "Show all";
    all.addEventListener("click", () => {
      hiddenColors.clear();
      localStorage.setItem("hiddenColors", "[]");
      render();
    });
    filterBar.appendChild(all);
  }
}

function setColor(id, key) {
  store.update(id, { color: key === AUTO ? null : key });
  render();
}

function colorSwatches(task) {
  return [AUTO, ...COLORS.map((c) => c.key)].map((k) => ({
    key: k,
    label: k === AUTO ? "Auto (changes with urgency)" : COLOR_BY_KEY[k].label,
    css: swatchCss(k),
    checked: colorKey(task) === k,
  }));
}

// ---------- Selection & side panel ----------
function select(id) {
  if (selectedId && selectedId !== id) removeIfEmpty(selectedId);
  if (editingId && editingId !== id) stopEdit({ silent: true });
  selectedId = id;
  if (id) store.bringToFront(id);
  render();
}

function removeIfEmpty(id) {
  const t = store.get(id);
  if (t && t.kind === "task" && id !== editingId && !t.title.trim() && !t.notes.trim() && !t.due) {
    const linked = store.board.links.filter((l) => l.from === id || l.to === id).map((l) => l.id);
    store.removeMany({ taskIds: [id] });
    // Never synced, so no need for tombstones.
    delete store.board.deleted[id];
    for (const l of linked) delete store.board.deleted[l];
  }
}

function relativeAge(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function updatePanel() {
  const task = selectedId && store.get(selectedId);
  panel.hidden = !task;
  if (!task) { panelTaskId = null; return; }
  panel.dataset.kind = task.kind;
  // Refresh fields on a new selection, or when something else changed them (never while typing in them).
  const fresh = panelTaskId !== task.id;
  if (fresh || (document.activeElement !== fTitle && fTitle.value !== task.title)) fTitle.value = task.title;
  if (fresh || (document.activeElement !== fNotes && fNotes.value !== task.notes)) fNotes.value = task.notes;
  panelTaskId = task.id;
  if (document.activeElement !== fDue) fDue.value = task.due || "";
  fTitle.placeholder = task.kind === "canvas" ? "Canvas name" : task.kind === "task" ? "What needs doing?" : "Name";

  // Colour swatches
  const sig = `${task.id}:${colorKey(task)}`;
  if (fColors.dataset.sig !== sig) {
    fColors.dataset.sig = sig;
    fColors.textContent = "";
    for (const s of colorSwatches(task)) {
      const b = document.createElement("button");
      b.className = `swatch${s.checked ? " checked" : ""}`;
      b.title = s.label;
      b.style.background = s.css;
      b.addEventListener("click", () => setColor(task.id, s.key));
      fColors.appendChild(b);
    }
  }

  const g = growthOf(task, now());
  const bits = [`Created ${relativeAge(task.createdAt)}`];
  if (task.kind === "task") bits.push(task.completedAt ? `completed ${relativeAge(task.completedAt)}` : `size ${g.scale.toFixed(1)}×`);
  if (task.kind === "image" || task.kind === "file") bits.push(formatSize(task.size));
  if (task.source) bits.push(`imported from ${task.source}`);
  const r = rel.of(task.id);
  const linkCount = store.board.links.filter((l) => l.from === task.id || l.to === task.id).length;
  if (linkCount) bits.push(`${linkCount} link${linkCount === 1 ? "" : "s"}`);
  if (r.blockers.length) bits.push(`waits on ${r.blockers.length}`);
  fInfo.textContent = bits.join(" · ");
  setText(btnComplete, task.completedAt ? "Mark not done" : "Mark complete");
  setText(btnOpen, task.kind === "canvas" ? "Open canvas" : "Open file");
}

fTitle.addEventListener("input", () => { store.update(selectedId, { title: fTitle.value }); render(); });
fNotes.addEventListener("input", () => { store.update(selectedId, { notes: fNotes.value }); render(); });
fDue.addEventListener("change", () => { store.update(selectedId, { due: fDue.value || null }); render(); });
$("#btn-clear-due").addEventListener("click", () => { store.update(selectedId, { due: null }); render(); });
btnComplete.addEventListener("click", () => toggleComplete(selectedId));
btnOpen.addEventListener("click", () => openElement(selectedId));
$("#btn-delete").addEventListener("click", () => deleteTask(selectedId));

// ---------- Inline editing on the card ----------
const EDIT_MODE = (() => {
  const d = document.createElement("div");
  d.contentEditable = "plaintext-only";
  return d.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
})();

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function readText(node) {
  return node.innerText.replace(/\r/g, "").replace(/\n$/, "");
}

function startEdit(id, field = "title") {
  const task = store.get(id);
  if (!task) return;
  if (selectedId !== id) select(id);
  if (editingId && editingId !== id) stopEdit({ silent: true });
  const el = els.get(id);
  if (!el) return;
  editingId = id;
  el.classList.add("editing");
  const titleEl = el.querySelector(".title");
  const notesEl = el.querySelector(".notes");
  titleEl.classList.remove("placeholder");
  titleEl.textContent = task.title;
  titleEl.contentEditable = EDIT_MODE;
  titleEl.dataset.placeholder = task.kind === "canvas" ? "Canvas name" : task.kind === "task" ? "What needs doing?" : "Name";
  if (notesEl) {
    notesEl.textContent = task.notes;
    notesEl.contentEditable = EDIT_MODE;
    notesEl.dataset.placeholder = "Notes… (Tab)";
  }
  const target = field === "notes" && notesEl ? notesEl : titleEl;
  target.focus();
  placeCaretAtEnd(target);
  links.renderLinksSoon();
}

function stopEdit({ silent = false } = {}) {
  if (!editingId) return;
  const el = els.get(editingId);
  editingId = null;
  if (el) {
    el.classList.remove("editing");
    for (const f of el.querySelectorAll("[contenteditable]")) f.removeAttribute("contenteditable");
    if (el.contains(document.activeElement)) document.activeElement.blur();
  }
  if (!silent) render();
}

world.addEventListener("input", (e) => {
  const card = e.target.closest?.(".card");
  if (!card || card.dataset.id !== editingId) return;
  const field = e.target.classList.contains("notes") ? "notes" : "title";
  store.update(editingId, { [field]: readText(e.target) });
  updatePanel();
  links.renderLinksSoon();
});

world.addEventListener("keydown", (e) => {
  const card = e.target.closest?.(".card");
  if (!card || card.dataset.id !== editingId) return;
  const inTitle = e.target.classList.contains("title");
  const notesEl = card.querySelector(".notes");
  if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault(); e.stopPropagation(); stopEdit();
  } else if (inTitle && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault(); e.stopPropagation(); stopEdit();
  } else if (e.key === "Tab" && notesEl) {
    e.preventDefault(); e.stopPropagation();
    const target = inTitle ? notesEl : card.querySelector(".title");
    target.focus();
    placeCaretAtEnd(target);
  }
});

world.addEventListener("focusout", (e) => {
  const card = e.target.closest?.(".card");
  if (!card || card.dataset.id !== editingId) return;
  if (e.relatedTarget && card.contains(e.relatedTarget)) return;
  setTimeout(() => {
    if (editingId === card.dataset.id && !card.contains(document.activeElement)) stopEdit();
  }, 0);
});

// ---------- Element actions ----------
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createTask({ title = "", notes = "", due = null, x, y, completedAt = null, kind = "task", color = null, ...extra } = {}) {
  if (x === undefined || y === undefined) ({ x, y } = viewCenterWorld());
  // Nudge so new cards don't land exactly on top of each other.
  while (store.board.tasks.some((t) => (t.canvasId ?? null) === currentCanvas && Math.abs(t.x - x) < 20 && Math.abs(t.y - y) < 20)) { x += 30; y += 30; }
  const iso = new Date().toISOString();
  const task = {
    ...extra, id: newId(), kind, title, notes, due, color, canvasId: currentCanvas,
    x, y, createdAt: iso, updatedAt: iso, completedAt,
  };
  store.add(task);
  return task;
}

/** Lay out many new tasks in a tidy grid in empty space. Returns created tasks. */
function addTasks(list) {
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(list.length * 1.5))));
  const rows = Math.ceil(list.length / cols);
  const gapX = 230, gapY = 140;
  let cx, top;
  const existing = store.board.tasks.filter((t) => els.has(t.id));
  if (!existing.length) {
    const c = viewCenterWorld();
    cx = c.x;
    top = c.y - ((rows - 1) * gapY) / 2;
  } else {
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of existing) {
      const el = els.get(t.id);
      minX = Math.min(minX, t.x - el.offsetWidth / 2);
      maxX = Math.max(maxX, t.x + el.offsetWidth / 2);
      maxY = Math.max(maxY, t.y + el.offsetHeight / 2);
    }
    cx = (minX + maxX) / 2;
    top = maxY + 120;
  }
  const created = list.map((item, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    return createTask({ ...item, x: cx + (col - (cols - 1) / 2) * gapX, y: top + row * gapY });
  });
  render();
  return created;
}

/** Create a task and start typing into it straight away. */
function newTaskAt(x, y) {
  const t = createTask({ x, y });
  select(t.id);
  startEdit(t.id);
  return t;
}

function toggleComplete(id) {
  const t = store.get(id);
  if (!t || t.kind !== "task") return;
  store.update(id, { completedAt: t.completedAt ? null : new Date().toISOString() });
  render();
}

async function openElement(id) {
  const t = store.get(id);
  if (!t) return;
  if (t.kind === "canvas") return enterCanvas(t.id);
  if (t.kind === "image" || t.kind === "file") {
    try { await attachments.open(t.attachmentId, t.mime); }
    catch (e) { toast(String(e?.message || e)); }
  }
}

// One level of undo, shared by delete / move / unlink.
let undoFn = null;
function setUndo(message, fn) {
  undoFn = fn;
  toast(message, { action: "Undo", onAction: runUndo });
}
function runUndo() {
  const fn = undoFn;
  undoFn = null;
  if (!fn) return;
  fn();
  hideToast();
  render();
}

function deleteTask(id) {
  const t = store.get(id);
  if (!t) return;
  if (editingId === id) stopEdit({ silent: true });
  if (selectedId === id) selectedId = null;
  const snap = store.remove(id);
  render();
  const inside = snap.tasks.length - 1;
  setUndo(`Deleted “${t.title || "Untitled"}”${inside > 0 ? ` and ${inside} item${inside === 1 ? "" : "s"} inside it` : ""}`, () => {
    store.restoreMany(snap);
    selectedId = id;
  });
}

function removeLink(linkId) {
  const snap = store.removeLink(linkId);
  render();
  setUndo("Link removed", () => store.restoreMany(snap));
}

async function addFilesAt(files, pos, linkFrom = null) {
  let { x, y } = pos;
  let last = null;
  for (const f of files) {
    try {
      const fields = await storeFile(f);
      const t = createTask({ ...fields, x, y, w: fields.kind === "image" ? 260 : undefined });
      if (linkFrom) links.connect(linkFrom, t.id);
      last = t;
      x += 40; y += 40;
    } catch (e) {
      toast(String(e?.message || e), { ms: 9000 });
    }
  }
  if (last) select(last.id); else render();
}

// ---------- Toast & modal helpers (shared with feature modules) ----------
let toastTimer = null;
function toast(message, { action, onAction, ms = 6000 } = {}) {
  const el = $("#toast");
  $("#toast-msg").textContent = message;
  const btn = $("#toast-action");
  btn.textContent = action || "";
  btn.onclick = onAction ? () => { onAction(); hideToast(); } : null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $("#toast").hidden = true; }

/**
 * Open a modal dialog. `content` is an HTMLElement or an HTML string.
 * Returns { el, body, close }. Escape / backdrop click closes it.
 */
function openModal(title, content, { onClose } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="ghost small modal-close">Close</button><h2></h2><div class="modal-body"></div></div>`;
  backdrop.querySelector("h2").textContent = title;
  const body = backdrop.querySelector(".modal-body");
  if (typeof content === "string") body.innerHTML = content;
  else if (content) body.appendChild(content);
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector(".modal-close").addEventListener("click", close);
  $("#modal-root").appendChild(backdrop);
  return { el: backdrop.querySelector(".modal"), body, close };
}

// ---------- The "+" handle on card edges ----------
const handle = document.createElement("button");
handle.id = "link-handle";
handle.textContent = "+";
handle.title = "Click for options · drag to link to another card";
handle.hidden = true;
world.appendChild(handle);
let handleFor = null; // { id, side }

function hideHandle() {
  handle.hidden = true;
  handleFor = null;
}

const NEAR = 26; // screen px from a card edge where the "+" appears

function updateHandle(sx, sy) {
  if (handle.contains(document.elementFromPoint(sx, sy))) return; // keep it while hovering it
  let best = null;
  for (const [id, el] of els) {
    const t = store.get(id);
    if (!t) continue;
    const c = toScreen(t.x, t.y);
    const hw = (el.offsetWidth / 2) * cam.z, hh = (el.offsetHeight / 2) * cam.z;
    const ax = Math.abs(sx - c.x), ay = Math.abs(sy - c.y);
    if (ax > hw + NEAR || ay > hh + NEAR) continue;
    const dists = { left: Math.abs(sx - (c.x - hw)), right: Math.abs(sx - (c.x + hw)), top: Math.abs(sy - (c.y - hh)), bottom: Math.abs(sy - (c.y + hh)) };
    // Only count an edge if we're alongside it (not past a corner).
    if (ay > hh) { dists.left = dists.right = Infinity; }
    if (ax > hw) { dists.top = dists.bottom = Infinity; }
    const side = Object.keys(dists).reduce((a, b) => (dists[a] <= dists[b] ? a : b));
    if (dists[side] > NEAR) continue;
    const z = Number(el.style.zIndex) || 0;
    if (!best || z > best.z) best = { id, side, z };
  }
  if (!best) return hideHandle();
  const t = store.get(best.id);
  const p = links.sidePoint(t, best.side, 16 / cam.z);
  handle.style.left = `${p.x}px`;
  handle.style.top = `${p.y}px`;
  handle.hidden = false;
  handleFor = { id: best.id, side: best.side };
}

/** Where to put something new next to a card, on the given side. */
function spotBeside(id, side) {
  const t = store.get(id);
  const p = links.sidePoint(t, side || "right", 0);
  const off = 150;
  const d = { top: [0, -off - 40], bottom: [0, off + 40], left: [-off - 100, 0], right: [off + 100, 0] }[side || "right"];
  return { x: p.x + d[0], y: p.y + d[1] };
}

/** The menu behind the "+": new linked task, image, file, sub-canvas. */
function showPlusMenu(fromId, sx, sy, pos) {
  const linkTo = (t) => (fromId ? links.connect(fromId, t.id) : null);
  showMenu(sx, sy, [
    { header: fromId ? "Add and link" : "Add here" },
    {
      label: "Task", icon: "✎", hint: fromId ? "A new card, linked to this one" : "A new card",
      onClick: () => {
        const t = createTask({ x: pos.x, y: pos.y });
        const link = linkTo(t);
        select(t.id);
        if (link) {
          const s = toScreen(t.x, t.y);
          links.showLinkMenu(link.id, s.x + 20, s.y + 40, { onClose: () => startEdit(t.id) });
        } else startEdit(t.id);
      },
    },
    {
      label: "Image…", icon: "🖼", hint: "Pick a picture",
      onClick: async () => { const f = await pickFile("image/*"); if (f) addFilesAt([f], pos, fromId); },
    },
    {
      label: "File…", icon: "📎", hint: "Attach any file",
      onClick: async () => { const f = await pickFile(""); if (f) addFilesAt([f], pos, fromId); },
    },
    {
      label: "Sub-canvas", icon: "▦", hint: "A canvas inside this one",
      onClick: () => {
        const t = createTask({ kind: "canvas", x: pos.x, y: pos.y });
        linkTo(t);
        select(t.id);
        startEdit(t.id);
      },
    },
  ], { className: "plus-menu" });
}

// ---------- Right-click menu ----------
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (editingId) stopEdit();
  const cardEl = e.target.closest(".card");
  if (!cardEl) {
    showPlusMenu(null, e.clientX, e.clientY, toWorld(e.clientX, e.clientY));
    return;
  }
  const t = store.get(cardEl.dataset.id);
  if (!t) return;
  select(t.id);
  const items = [];
  if (t.kind === "task") {
    items.push({ label: "Edit", icon: "✎", onClick: () => startEdit(t.id) });
    items.push({ label: t.completedAt ? "Mark not done" : "Mark complete", icon: "✓", onClick: () => toggleComplete(t.id) });
  } else {
    items.push({ label: t.kind === "canvas" ? "Open" : "Open file", icon: "↗", onClick: () => openElement(t.id) });
    items.push({ label: "Rename", icon: "✎", onClick: () => startEdit(t.id) });
  }
  if (colorable(t)) {
    items.push({ separator: true }, { header: "Colour" }, { swatches: colorSwatches(t), onPick: (k) => setColor(t.id, k) });
  }
  items.push({ separator: true });
  if (currentCanvas) {
    const parent = store.get(currentCanvas);
    items.push({
      label: "Move out of this canvas", icon: "↖",
      onClick: () => moveToCanvas(t.id, parent?.canvasId ?? null, { x: (parent?.x ?? 0) + 280, y: parent?.y ?? 0 }),
    });
  }
  items.push({ label: "Delete", icon: "🗑", danger: true, onClick: () => deleteTask(t.id) });
  showMenu(e.clientX, e.clientY, items);
});

// ---------- Pointer input: pan, drag cards, draw links ----------
let drag = null;

/** The topmost card under a screen point, ignoring `excludeId`. */
function cardAt(sx, sy, excludeId) {
  for (const node of document.elementsFromPoint(sx, sy)) {
    const card = node.closest?.(".card");
    if (card && card.dataset.id !== excludeId && els.get(card.dataset.id) === card) return card;
  }
  return null;
}

function setHighlight(cls, card) {
  for (const n of world.querySelectorAll(`.${cls}`)) if (n !== card) n.classList.remove(cls);
  card?.classList.add(cls);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".check, .link-chip, .link-hit")) return; // handled on click
  if (e.target.closest("[contenteditable]")) return; // placing the caret while editing
  if (e.target === handle && handleFor && e.button === 0) {
    const t = store.get(handleFor.id);
    drag = { kind: "link", from: handleFor.id, side: handleFor.side, start: links.sidePoint(t, handleFor.side, 0), sx: e.clientX, sy: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (editingId) stopEdit();
  const cardEl = e.target.closest(".card");
  if (cardEl && e.button === 0) {
    const t = store.get(cardEl.dataset.id);
    if (!t) return;
    select(t.id);
    drag = { kind: "card", id: t.id, el: els.get(t.id), sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
  } else if (e.button === 0 || e.button === 1) {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  } else return;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) { updateHandle(e.clientX, e.clientY); return; }
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    if (drag.kind === "card") { drag.el.classList.add("dragging"); hideHandle(); }
    else if (drag.kind === "pan") { canvas.classList.add("panning"); hideHandle(); }
    else if (drag.kind === "link") { handle.classList.add("active"); }
  }
  if (drag.kind === "card") {
    const t = store.get(drag.id);
    t.x = drag.ox + dx / cam.z;
    t.y = drag.oy + dy / cam.z;
    drag.el.style.left = `${t.x}px`;
    drag.el.style.top = `${t.y}px`;
    links.renderLinks();
    const over = cardAt(e.clientX, e.clientY, drag.id);
    setHighlight("drop-target", over?.dataset.kind === "canvas" ? over : null);
  } else if (drag.kind === "link") {
    const w = toWorld(e.clientX, e.clientY);
    links.drawTemp(drag.start, w);
    setHighlight("link-target", cardAt(e.clientX, e.clientY, drag.from));
    handle.style.left = `${w.x}px`;
    handle.style.top = `${w.y}px`;
  } else {
    cam.x = drag.cx + dx;
    cam.y = drag.cy + dy;
    applyCamera();
  }
});

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === "card") {
    d.el.classList.remove("dragging");
    setHighlight("drop-target", null);
    const t = store.get(d.id);
    if (d.moved) {
      const over = e && cardAt(e.clientX, e.clientY, d.id);
      if (over?.dataset.kind === "canvas" && over.dataset.id !== d.id) {
        t.x = d.ox; t.y = d.oy; // so undo puts it back where it started
        moveToCanvas(d.id, over.dataset.id);
      } else {
        store.update(d.id, {});
        render();
      }
    } else if (t?.kind === "canvas" && e?.type === "pointerup") {
      enterCanvas(t.id); // a click on a sub-canvas opens it
    }
  } else if (d.kind === "link") {
    links.clearTemp();
    handle.classList.remove("active");
    setHighlight("link-target", null);
    hideHandle();
    if (e?.type !== "pointerup") return;
    if (!d.moved) {
      showPlusMenu(d.from, e.clientX + 12, e.clientY, spotBeside(d.from, d.side));
      return;
    }
    const target = cardAt(e.clientX, e.clientY, d.from);
    if (target) {
      const link = links.connect(d.from, target.dataset.id);
      render();
      links.showLinkMenu(link.id, e.clientX + 12, e.clientY);
    } else {
      showPlusMenu(d.from, e.clientX + 12, e.clientY, toWorld(e.clientX, e.clientY));
    }
  } else {
    canvas.classList.remove("panning");
    if (!d.moved) select(null);
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", () => { if (!drag) hideHandle(); });

canvas.addEventListener("click", (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const check = hit?.closest(".check");
  if (check) return toggleComplete(check.closest(".card").dataset.id);
  const linkEl = hit?.closest(".link-chip, .link-hit");
  if (linkEl) links.showLinkMenu(linkEl.dataset.link, e.clientX + 8, e.clientY + 8);
});

canvas.addEventListener("dblclick", (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit?.closest(".check, #link-handle, .link-chip, .link-hit, [contenteditable]")) return;
  const cardEl = hit?.closest(".card");
  if (cardEl) {
    const t = store.get(cardEl.dataset.id);
    if (!t) return;
    if (t.kind === "task") startEdit(t.id, hit.closest(".notes") ? "notes" : "title");
    else if (t.kind === "image" || t.kind === "file") openElement(t.id);
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  newTaskAt(w.x, w.y);
});

// Re-draw links once cards finish growing/shrinking.
world.addEventListener("transitionend", (e) => {
  if (e.target.classList?.contains("card")) links.renderLinksSoon();
});

// ---------- Files: drop onto the canvas, or paste ----------
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
});
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  addFilesAt([...e.dataTransfer.files], toWorld(e.clientX, e.clientY));
});
document.addEventListener("paste", (e) => {
  if (isTyping(e.target)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFilesAt(files, viewCenterWorld());
});
attachments.onChanged(() => {
  for (const el of els.values()) if (el.dataset.kind === "image") delete el.dataset.loaded;
  render();
});

// ---------- Wheel / trackpad: pan and zoom ----------
let gestureActive = false;
let gestureStartZ = 1;

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  closeMenu();
  if (e.ctrlKey || e.metaKey) {
    // Trackpad pinch (and Ctrl+wheel on Windows) arrives as ctrl+wheel.
    if (gestureActive) return;
    const d = Math.max(-20, Math.min(20, e.deltaY));
    zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-d * 0.01));
  } else {
    let dx = e.deltaX, dy = e.deltaY;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    cam.x -= dx;
    cam.y -= dy;
    hideHandle();
    applyCamera();
  }
}, { passive: false });

// Safari/WebKit (macOS) may send pinch as gesture events instead.
canvas.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureActive = true; gestureStartZ = cam.z; });
canvas.addEventListener("gesturechange", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, gestureStartZ * e.scale); });
canvas.addEventListener("gestureend", (e) => { e.preventDefault(); gestureActive = false; });
// Stop pinch-zooming the whole page anywhere else.
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

// ---------- Keyboard ----------
const keyHandlers = []; // feature hooks: (event) => true if handled

addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-backdrop") || isMenuOpen()) return;
  for (const fn of keyHandlers) if (fn(e)) { e.preventDefault(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (isTyping(e.target)) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); runUndo(); return; }
  if (mod) return;
  switch (e.key) {
    case "n": case "N": {
      e.preventDefault();
      const c = viewCenterWorld();
      newTaskAt(c.x, c.y);
      break;
    }
    case "Delete": case "Backspace":
      if (selectedId) { e.preventDefault(); deleteTask(selectedId); }
      break;
    case "Enter":
      if (selectedId) {
        e.preventDefault();
        const t = store.get(selectedId);
        if (t?.kind === "canvas") enterCanvas(t.id); else startEdit(selectedId);
      }
      break;
    case " ":
      if (selectedId) { e.preventDefault(); toggleComplete(selectedId); }
      break;
    case "Escape":
      if (selectedId) select(null);
      else if (currentCanvas) enterCanvas(store.get(currentCanvas)?.canvasId ?? null); // up one level
      break;
    case "f": case "F": fit(); break;
    case "0": zoomAt(innerWidth / 2, innerHeight / 2, 1); break;
    case "=": case "+": zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.2); break;
    case "-": case "_": zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.2); break;
  }
});

// ---------- Toolbar ----------
$("#btn-new").addEventListener("click", () => {
  const c = viewCenterWorld();
  newTaskAt(c.x, c.y);
});
$("#btn-fit").addEventListener("click", fit);
chkHideDone.checked = hideDone;
chkHideDone.addEventListener("change", () => {
  hideDone = chkHideDone.checked;
  localStorage.setItem("hideDone", hideDone ? "1" : "0");
  render();
});
timeTravel.addEventListener("input", () => {
  timeOffsetDays = Number(timeTravel.value);
  timeLabel.textContent = timeOffsetDays ? `+${timeOffsetDays} day${timeOffsetDays === 1 ? "" : "s"}` : "today";
  render();
});

// ---------- Feature module API ----------
const settings = {
  get(key, fallback = null) {
    const v = localStorage.getItem(`setting:${key}`);
    return v === null ? fallback : JSON.parse(v);
  },
  set(key, value) { localStorage.setItem(`setting:${key}`, JSON.stringify(value)); },
};

// Secrets go to the OS keychain in the desktop app; localStorage in a plain browser (dev only).
const secrets = {
  async get(key) {
    if (invoke) return invoke("secret_get", { key });
    return localStorage.getItem(`secret:${key}`);
  },
  async set(key, value) {
    if (invoke) return invoke("secret_set", { key, value });
    localStorage.setItem(`secret:${key}`, value);
  },
  async delete(key) {
    if (invoke) return invoke("secret_delete", { key });
    localStorage.removeItem(`secret:${key}`);
  },
};

/** Show an element wherever it lives: open its canvas, select it and centre it. */
function revealTask(id) {
  const t = store.get(id);
  if (!t) return;
  if ((t.canvasId ?? null) !== currentCanvas) enterCanvas(t.canvasId ?? null);
  select(id);
  focusTask(id);
}

export const app = {
  store,                     // board, get, add, update, remove, removeMany, restoreMany, links…, setBoard, normalize, events, flush
  render,
  select,
  getSelectedId: () => selectedId,
  getCurrentCanvas: () => currentCanvas,
  enterCanvas,
  revealTask,                // (id) open the right canvas, select and centre
  isVisible,
  focusTask,
  fit,
  createTask,                // ({title, notes, due, kind?, x?, y?, ...extraFields}) -> task (on the current canvas)
  addTasks,                  // ([{title, notes, due, ...}]) -> tasks, laid out in empty space
  toggleComplete,
  deleteTask,
  connect: links.connect,    // (fromId, toId, type?) -> link
  toast,                     // (message, {action, onAction, ms})
  openModal,                 // (title, htmlOrElement, {onClose}) -> {el, body, close}
  toolbarSlot: $("#toolbar-slot"),
  addDecorator: (fn) => decorators.push(fn),       // (task, cardEl) on every render
  addKeyHandler: (fn) => keyHandlers.push(fn),     // (keydownEvent) -> true if handled
  settings,                  // per-device preferences (not synced)
  secrets,                   // OS keychain
  attachments,               // save/read/list/open attachment files; changed(id) after downloading one
  invoke,                    // Tauri invoke (undefined in a plain browser)
  isDesktop: !!invoke,
  // fetch that bypasses browser CORS (Tauri http plugin), restricted to GitHub + Microsoft hosts.
  nativeFetch: tauri?.http?.fetch ?? window.fetch.bind(window),
  openUrl: (url) => (tauri?.opener?.openUrl ? tauri.opener.openUrl(url) : window.open(url, "_blank")),
  now,
  errorLog,                  // recent errors/warnings since startup
  loadedFeatures: [],        // names of feature modules that initialised
};
window.canvasPlanner = app; // handy for debugging in devtools

// ---------- Start ----------
store.setErrorHandler((msg) => toast(`Couldn't save: ${msg}`));
links.initLinks(world, { els, isVisible, removeLink, render });

async function start() {
  const status = await store.load();
  if (status === "recovered") toast("Your board file was damaged, so the last backup was loaded.");
  if (status === "corrupt") toast("Your board file couldn't be read. Starting empty; the old file is kept in the data folder.", { ms: 15000 });

  const saved = JSON.parse(localStorage.getItem("camera") || "null");
  if (saved && Number.isFinite(saved.z)) Object.assign(cam, saved);
  applyCamera();
  render();
  if (!saved && store.board.tasks.length) fit();

  setInterval(render, 60 * 1000); // let cards keep growing while the app is open

  for (const name of ["sync", "importer", "extras"]) {
    try {
      const mod = await import(`./${name}.js`);
      await mod.init?.(app);
      app.loadedFeatures.push(name);
    } catch (e) {
      console.warn(`Feature "${name}" not loaded:`, e);
    }
  }
}

start();
