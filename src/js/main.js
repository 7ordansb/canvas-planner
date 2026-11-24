// Canvas Planner – core canvas: camera, cards, editing panel, and the `app`
// API that feature modules (sync, importer, extras) plug into.

import { growthOf, daysUntilDue, DAY } from "./growth.js";

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
import * as store from "./store.js";

const $ = (s) => document.querySelector(s);
const canvas = $("#canvas");
const world = $("#world");
const hint = $("#hint");
const panel = $("#panel");
const fTitle = $("#f-title");
const fDue = $("#f-due");
const fNotes = $("#f-notes");
const fInfo = $("#f-info");
const btnComplete = $("#btn-complete");
const zoomLabel = $("#zoom-label");
const chkHideDone = $("#chk-hide-done");
const timeTravel = $("#time-travel");
const timeLabel = $("#time-label");

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;

// ---------- State ----------
const cam = { x: innerWidth / 2, y: innerHeight / 2, z: 1 }; // screen = world * z + (x, y)
let selectedId = null;
let panelTaskId = null;
let timeOffsetDays = 0;
let hideDone = localStorage.getItem("hideDone") === "1";
const els = new Map(); // task id -> card element
const decorators = []; // feature hooks: (task, el) => void, run on every render

const now = () => Date.now() + timeOffsetDays * DAY;
const isTyping = (el) => el?.matches?.("input, textarea, select, [contenteditable]");

// ---------- Camera ----------
let camSaveTimer = null;
function applyCamera() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  const grid = 24 * cam.z;
  canvas.classList.toggle("no-grid", cam.z < 0.35);
  canvas.style.backgroundSize = `${grid}px ${grid}px`;
  canvas.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  zoomLabel.textContent = `${Math.round(cam.z * 100)}%`;
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => localStorage.setItem("camera", JSON.stringify(cam)), 400);
}

const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });

function zoomAt(sx, sy, z) {
  z = Math.min(3, Math.max(0.1, z));
  const w = toWorld(sx, sy);
  cam.z = z;
  cam.x = sx - w.x * z;
  cam.y = sy - w.y * z;
  applyCamera();
}

/** Visible area of the canvas (excluding the side panel), in screen px. */
function viewRect() {
  const right = panel.hidden ? innerWidth : innerWidth - 324;
  return { left: 0, top: 56, right, bottom: innerHeight };
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
    (r.right - r.left - pad * 2) / (maxX - minX),
    (r.bottom - r.top - pad * 2) / (maxY - minY),
  )));
  cam.z = z;
  cam.x = (r.left + r.right) / 2 - ((minX + maxX) / 2) * z;
  cam.y = (r.top + r.bottom) / 2 - ((minY + maxY) / 2) * z;
  applyCamera();
}

/** Pan so a task is centred in view. */
function focusTask(id) {
  const t = store.get(id);
  if (!t) return;
  const r = viewRect();
  cam.x = (r.left + r.right) / 2 - t.x * cam.z;
  cam.y = (r.top + r.bottom) / 2 - t.y * cam.z;
  applyCamera();
}

// ---------- Rendering ----------
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function metaText(task, t) {
  if (task.completedAt) return "Done";
  if (task.due) {
    const days = daysUntilDue(task.due, t);
    if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
    if (days === 0) return "Due today";
    if (days === 1) return "Due tomorrow";
    return `Due ${formatDate(task.due)}`;
  }
  return "";
}

function createCardEl(id) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = id;
  el.innerHTML = `<button class="check" title="Mark complete"></button><div class="title"></div><div class="meta"></div><div class="badges"></div>`;
  return el;
}

function render() {
  const t = now();
  const seen = new Set();
  store.board.tasks.forEach((task, i) => {
    if (hideDone && task.completedAt && task.id !== selectedId) return;
    seen.add(task.id);
    let el = els.get(task.id);
    if (!el) {
      el = createCardEl(task.id);
      els.set(task.id, el);
      world.appendChild(el);
    }
    const g = growthOf(task, t);
    el.style.left = `${task.x}px`;
    el.style.top = `${task.y}px`;
    el.style.zIndex = String(i + 1);
    el.style.setProperty("--s", g.scale.toFixed(3));
    el.style.setProperty("--hue", String(g.hue));
    el.classList.toggle("done", !!task.completedAt);
    el.classList.toggle("overdue", g.overdue);
    el.classList.toggle("selected", task.id === selectedId);
    const title = el.querySelector(".title");
    setText(title, task.title || "Untitled");
    title.classList.toggle("placeholder", !task.title);
    setText(el.querySelector(".meta"), metaText(task, t));
    const check = el.querySelector(".check");
    setText(check, task.completedAt ? "✓" : "");
    check.title = task.completedAt ? "Mark not done" : "Mark complete";
    const badges = el.querySelector(".badges");
    setText(badges, "");
    if (task.source) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = task.source;
      badges.appendChild(b);
    }
    for (const fn of decorators) {
      try { fn(task, el); } catch (e) { console.error(e); }
    }
  });
  for (const [id, el] of els) {
    if (!seen.has(id)) { el.remove(); els.delete(id); }
  }
  hint.hidden = store.board.tasks.length > 0;
  updatePanel();
}

// ---------- Selection & side panel ----------
function select(id) {
  if (selectedId && selectedId !== id) removeIfEmpty(selectedId);
  selectedId = id;
  if (id) store.bringToFront(id);
  render();
}

function removeIfEmpty(id) {
  const t = store.get(id);
  if (t && !t.title.trim() && !t.notes.trim() && !t.due) {
    store.remove(id);
    delete store.board.deleted[id]; // never synced, no need for a tombstone
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
  // Refresh fields on a new selection, or when sync changed them (but never while typing in them).
  const fresh = panelTaskId !== task.id;
  if (fresh || (document.activeElement !== fTitle && fTitle.value !== task.title)) fTitle.value = task.title;
  if (fresh || (document.activeElement !== fNotes && fNotes.value !== task.notes)) fNotes.value = task.notes;
  panelTaskId = task.id;
  if (document.activeElement !== fDue) fDue.value = task.due || "";
  const g = growthOf(task, now());
  fInfo.textContent =
    `Created ${relativeAge(task.createdAt)}` +
    (task.completedAt ? ` · completed ${relativeAge(task.completedAt)}` : ` · size ${g.scale.toFixed(1)}×`) +
    (task.source ? ` · imported from ${task.source}` : "");
  setText(btnComplete, task.completedAt ? "Mark not done" : "Mark complete");
}

fTitle.addEventListener("input", () => { store.update(selectedId, { title: fTitle.value }); render(); });
fNotes.addEventListener("input", () => { store.update(selectedId, { notes: fNotes.value }); });
fDue.addEventListener("change", () => { store.update(selectedId, { due: fDue.value || null }); render(); });
$("#btn-clear-due").addEventListener("click", () => { store.update(selectedId, { due: null }); render(); });
btnComplete.addEventListener("click", () => toggleComplete(selectedId));
$("#btn-delete").addEventListener("click", () => deleteTask(selectedId));

// ---------- Task actions ----------
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createTask({ title = "", notes = "", due = null, x, y, completedAt = null, ...extra } = {}) {
  if (x === undefined || y === undefined) ({ x, y } = viewCenterWorld());
  // Nudge so new cards don't land exactly on top of each other.
  while (store.board.tasks.some((t) => Math.abs(t.x - x) < 20 && Math.abs(t.y - y) < 20)) { x += 30; y += 30; }
  const iso = new Date().toISOString();
  const task = { ...extra, id: newId(), title, notes, due, x, y, createdAt: iso, updatedAt: iso, completedAt };
  store.add(task);
  return task;
}

/** Lay out many new tasks in a tidy grid around the view centre. Returns created tasks. */
function addTasks(list) {
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(list.length * 1.5))));
  const rows = Math.ceil(list.length / cols);
  const gapX = 230, gapY = 140;
  // Put the new block in empty space: centred in view if nothing is there,
  // otherwise just below everything already on the canvas.
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

function toggleComplete(id) {
  const t = store.get(id);
  if (!t) return;
  store.update(id, { completedAt: t.completedAt ? null : new Date().toISOString() });
  render();
}

let lastDeleted = null;
function deleteTask(id) {
  const t = store.get(id);
  if (!t) return;
  if (selectedId === id) selectedId = null;
  lastDeleted = store.remove(id);
  render();
  toast(`Deleted “${t.title || "Untitled"}”`, { action: "Undo", onAction: undoDelete });
}

function undoDelete() {
  if (!lastDeleted) return;
  store.restore(lastDeleted);
  selectedId = lastDeleted.task.id;
  lastDeleted = null;
  hideToast();
  render();
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

// ---------- Pointer input: pan, drag cards, create ----------
let drag = null;

canvas.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".check")) return;
  const cardEl = e.target.closest(".card");
  if (cardEl && e.button === 0) {
    const t = store.get(cardEl.dataset.id);
    if (!t) return;
    select(t.id);
    drag = { kind: "card", id: t.id, el: cardEl, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
  } else if (e.button === 0 || e.button === 1) {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  } else return;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    if (drag.kind === "card") drag.el.classList.add("dragging");
    else canvas.classList.add("panning");
  }
  if (drag.kind === "card") {
    const t = store.get(drag.id);
    t.x = drag.ox + dx / cam.z;
    t.y = drag.oy + dy / cam.z;
    drag.el.style.left = `${t.x}px`;
    drag.el.style.top = `${t.y}px`;
  } else {
    cam.x = drag.cx + dx;
    cam.y = drag.cy + dy;
    applyCamera();
  }
});

function endDrag() {
  if (!drag) return;
  if (drag.kind === "card") {
    drag.el.classList.remove("dragging");
    if (drag.moved) store.update(drag.id, {});
  } else {
    canvas.classList.remove("panning");
    if (!drag.moved) select(null);
  }
  drag = null;
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("click", (e) => {
  const check = document.elementFromPoint(e.clientX, e.clientY)?.closest(".check");
  if (check) toggleComplete(check.closest(".card").dataset.id);
});

canvas.addEventListener("dblclick", (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit?.closest(".check")) return;
  const cardEl = hit?.closest(".card");
  if (cardEl) {
    select(cardEl.dataset.id);
    fTitle.focus();
    fTitle.select();
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  const task = createTask({ x: w.x, y: w.y });
  select(task.id);
  fTitle.focus();
});

// ---------- Wheel / trackpad: pan and zoom ----------
let gestureActive = false;
let gestureStartZ = 1;

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
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
  if (document.querySelector(".modal-backdrop")) return;
  for (const fn of keyHandlers) if (fn(e)) { e.preventDefault(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (isTyping(e.target)) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undoDelete(); return; }
  if (mod) return;
  switch (e.key) {
    case "n": case "N": {
      e.preventDefault();
      const t = createTask();
      select(t.id);
      fTitle.focus();
      break;
    }
    case "Delete": case "Backspace":
      if (selectedId) { e.preventDefault(); deleteTask(selectedId); }
      break;
    case "Enter":
      if (selectedId) { e.preventDefault(); fTitle.focus(); }
      break;
    case " ":
      if (selectedId) { e.preventDefault(); toggleComplete(selectedId); }
      break;
    case "Escape": select(null); break;
    case "f": case "F": fit(); break;
    case "0": zoomAt(innerWidth / 2, innerHeight / 2, 1); break;
    case "=": case "+": zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.2); break;
    case "-": case "_": zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.2); break;
  }
});

// ---------- Toolbar ----------
$("#btn-new").addEventListener("click", () => {
  const t = createTask();
  select(t.id);
  fTitle.focus();
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

export const app = {
  store,                     // board, get, add, update, remove, setBoard, normalize, events, flush
  render,
  select,
  getSelectedId: () => selectedId,
  focusTask,
  fit,
  createTask,                // ({title, notes, due, x?, y?, ...extraFields}) -> task
  addTasks,                  // ([{title, notes, due, ...}]) -> tasks, laid out in a grid in view
  toggleComplete,
  deleteTask,
  toast,                     // (message, {action, onAction, ms})
  openModal,                 // (title, htmlOrElement, {onClose}) -> {el, body, close}
  toolbarSlot: $("#toolbar-slot"),
  addDecorator: (fn) => decorators.push(fn),       // (task, cardEl) on every render
  addKeyHandler: (fn) => keyHandlers.push(fn),     // (keydownEvent) -> true if handled
  settings,                  // per-device preferences (not synced)
  secrets,                   // OS keychain
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
