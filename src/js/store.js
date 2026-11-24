// Holds the board (all tasks) and saves it to disk.
// Inside the desktop app it saves via Rust to a file in the app's data folder.
// Opened in a plain browser (for development) it falls back to localStorage.

const invoke = window.__TAURI__?.core?.invoke;

export let board = { version: 1, tasks: [], deleted: {} };

/** Fires "changed" after every local edit (not after setBoard with silent). */
export const events = new EventTarget();

let onError = () => {};
export function setErrorHandler(fn) { onError = fn; }

function normalize(data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const deleted = data?.deleted && typeof data.deleted === "object" ? { ...data.deleted } : {};
  return {
    version: 1,
    deleted,
    tasks: tasks
      .filter((t) => t && typeof t.id === "string")
      .map((t) => ({
        ...t, // keep extra fields added by features (e.g. source, externalId)
        id: t.id,
        title: String(t.title ?? ""),
        notes: String(t.notes ?? ""),
        x: Number(t.x) || 0,
        y: Number(t.y) || 0,
        due: typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null,
        createdAt: t.createdAt || new Date().toISOString(),
        updatedAt: t.updatedAt || t.createdAt || new Date().toISOString(),
        completedAt: t.completedAt || null,
      })),
  };
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

/** Removes a task; returns {task, index} so it can be restored. */
export function remove(id) {
  const index = board.tasks.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const [task] = board.tasks.splice(index, 1);
  board.deleted[id] = new Date().toISOString(); // tombstone so sync knows it was deleted
  save();
  return { task, index };
}

export function restore({ task, index }) {
  board.tasks.splice(Math.min(index, board.tasks.length), 0, task);
  delete board.deleted[task.id];
  task.updatedAt = new Date().toISOString();
  save();
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
