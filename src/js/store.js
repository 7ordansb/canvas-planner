// Holds the board (all tasks) and saves it to disk.
// Inside the desktop app it saves via Rust to a file in the app's data folder.
// Opened in a plain browser (for development) it falls back to localStorage.

import { KINDS, COLOR_BY_KEY, LINK_TYPES, webLink } from "./model.js";

const invoke = window.__TAURI__?.core?.invoke;

// tasks: every element on every canvas (tasks, images, files, sub-canvases).
//        `canvasId` says which canvas it sits on (null = the home canvas).
// links: connections between two elements on the same canvas.
// deleted: tombstones {id: deletedAt} for tasks AND links, so sync can propagate deletes.
export let board = { version: 1, tasks: [], links: [], deleted: {} };

/** Fires "changed" after every local edit (not after setBoard with silent). */
export const events = new EventTarget();

let onError = () => {};
export function setErrorHandler(fn) { onError = fn; }

function normalize(data) {
  const now = new Date().toISOString();
  const rawTasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const deleted = data?.deleted && typeof data.deleted === "object" ? { ...data.deleted } : {};
  const tasks = rawTasks
    .filter((t) => t && typeof t.id === "string")
    .map((t) => ({
      ...t, // keep extra fields added by features (e.g. source, externalId, attachmentId)
      id: t.id,
      kind: KINDS.includes(t.kind) ? t.kind : "task",
      title: String(t.title ?? ""),
      notes: String(t.notes ?? ""),
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      due: typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null,
      color: COLOR_BY_KEY[t.color] ? t.color : null,
      canvasId: typeof t.canvasId === "string" ? t.canvasId : null,
      createdAt: t.createdAt || now,
      updatedAt: t.updatedAt || t.createdAt || now,
      completedAt: t.completedAt || null,
      ...(Array.isArray(t.webLinks) ? { webLinks: [...new Set(t.webLinks.map(webLink).filter(Boolean))] } : {}),
    }));
  const canvases = new Map(tasks.filter((t) => t.kind === "canvas").map((t) => [t.id, t]));
  for (const task of tasks) {
    if (!canvases.has(task.canvasId)) task.canvasId = null;
  }
  // Concurrent moves can form a cycle. Detach the same canvas on every device.
  const checked = new Set();
  for (const canvas of canvases.values()) {
    const path = new Map();
    let node = canvas;
    while (node && !checked.has(node.id)) {
      if (path.has(node.id)) {
        const cycle = [...path.keys()].slice(path.get(node.id));
        const root = cycle.map((id) => canvases.get(id)).reduce((a, b) => a.id < b.id ? a : b);
        root.canvasId = null;
        break;
      }
      path.set(node.id, path.size);
      node = canvases.get(node.canvasId);
    }
    for (const id of path.keys()) checked.add(id);
  }
  const ids = new Set(tasks.map((t) => t.id));
  const links = (Array.isArray(data?.links) ? data.links : [])
    .filter((l) => l && typeof l.id === "string" && ids.has(l.from) && ids.has(l.to) && l.from !== l.to)
    .map((l) => ({
      ...l,
      type: LINK_TYPES[l.type] ? l.type : "related",
      createdAt: l.createdAt || now,
      updatedAt: l.updatedAt || l.createdAt || now,
    }));
  return { version: 1, deleted, tasks, links };
}

async function readRaw(backup) {
  if (invoke) return invoke("load_board", { backup });
  return backup ? null : localStorage.getItem("board");
}

/** @returns {"new" | "ok" | "recovered" | "corrupt"} */
export async function load() {
  const raw = await readRaw(false);
  if (!raw) return "new";
  try {
    board = normalize(JSON.parse(raw));
    return "ok";
  } catch {
    try {
      const bak = await readRaw(true);
      if (bak) {
        board = normalize(JSON.parse(bak));
        return "recovered";
      }
    } catch {}
    return "corrupt";
  }
}

let timer = null;
export function save({ silent = false } = {}) {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
  if (!silent) events.dispatchEvent(new Event("changed"));
}

/** Replace the whole board (used by sync after merging). */
export function setBoard(data, { silent = true } = {}) {
  board = normalize(data);
  save({ silent });
}

export { normalize };

export async function flush() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
  const json = JSON.stringify(board, null, 1);
  try {
    if (invoke) await invoke("save_board", { json });
    else localStorage.setItem("board", json);
  } catch (e) {
    onError(String(e));
  }
}

export const get = (id) => board.tasks.find((t) => t.id === id);

export function update(id, patch) {
  const t = get(id);
  if (!t) return;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  save();
}

export function add(task) {
  board.tasks.push(task);
  save();
}

// ---------- Links ----------
export const getLink = (id) => board.links.find((l) => l.id === id);

export function addLink(link) {
  board.links.push(link);
  delete board.deleted[link.id];
  save();
}

export function updateLink(id, patch) {
  const l = getLink(id);
  if (!l) return;
  Object.assign(l, patch, { updatedAt: new Date().toISOString() });
  save();
}

// ---------- Removing and restoring (with tombstones for sync) ----------

/** All elements inside a sub-canvas, at any depth. */
export function descendants(canvasId) {
  const children = new Map();
  for (const task of board.tasks) {
    if (!children.has(task.canvasId)) children.set(task.canvasId, []);
    children.get(task.canvasId).push(task);
  }
  const out = [];
  const seen = new Set([canvasId]);
  const pending = (children.get(canvasId) || []).slice().reverse();
  while (pending.length) {
    const task = pending.pop();
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
    if (task.kind === "canvas") {
      const nested = children.get(task.id) || [];
      for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
    }
  }
  return out;
}

/**
 * Remove tasks (plus everything inside sub-canvases, plus links touching them)
 * and/or specific links. Returns a snapshot that `restoreMany` can undo.
 */
export function removeMany({ taskIds = [], linkIds = [] } = {}) {
  const ts = new Date().toISOString();
  const taskSet = new Set(taskIds);
  for (const id of taskIds) {
    const t = get(id);
    if (t?.kind === "canvas") for (const d of descendants(id)) taskSet.add(d.id);
  }
  const linkSet = new Set(linkIds);
  for (const l of board.links) if (taskSet.has(l.from) || taskSet.has(l.to)) linkSet.add(l.id);

  const snapshot = { tasks: [], links: [] };
  board.tasks = board.tasks.filter((t, index) => {
    if (!taskSet.has(t.id)) return true;
    snapshot.tasks.push({ item: t, index });
    board.deleted[t.id] = ts;
    return false;
  });
  board.links = board.links.filter((l, index) => {
    if (!linkSet.has(l.id)) return true;
    snapshot.links.push({ item: l, index });
    board.deleted[l.id] = ts;
    return false;
  });
  save();
  return snapshot;
}

export function restoreMany(snapshot) {
  const ts = new Date().toISOString();
  for (const { item, index } of snapshot.tasks) {
    board.tasks.splice(Math.min(index, board.tasks.length), 0, item);
    delete board.deleted[item.id];
    item.updatedAt = ts;
  }
  for (const { item, index } of snapshot.links) {
    board.links.splice(Math.min(index, board.links.length), 0, item);
    delete board.deleted[item.id];
    item.updatedAt = ts;
  }
  save();
}

/** Remove one element (and its links / contents). Returns an undo snapshot. */
export function remove(id) {
  return removeMany({ taskIds: [id] });
}

export function removeLink(id) {
  return removeMany({ linkIds: [id] });
}

/** Later in the list = drawn on top. */
export function bringToFront(id) {
  const i = board.tasks.findIndex((t) => t.id === id);
  if (i < 0 || i === board.tasks.length - 1) return;
  board.tasks.push(board.tasks.splice(i, 1)[0]);
  save();
}

addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => document.hidden && flush());
