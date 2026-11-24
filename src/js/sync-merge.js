// Pure merge logic for GitHub sync. No DOM, no app access: runs in node for tests.
//
// Board shape: { version: 1, tasks: [...], deleted: { taskId: isoDeletedAt } }
//
// Rules (see docs/SYNC.md for the plain-language version):
// - Tasks are combined by id. If both sides have a task, the one with the newer
//   `updatedAt` wins as a whole. Exact ties are broken by comparing the tasks'
//   canonical JSON, so every device picks the same winner.
// - Tombstones (`deleted`) are combined, keeping the newest deletedAt per id.
//   A tombstone removes a task if deletedAt >= the task's updatedAt; otherwise
//   the task was edited after the delete, so it survives and the tombstone is dropped.
// - Tombstones older than 60 days are pruned, except while either input still
//   holds a copy of that task (otherwise the stale copy would come back on the
//   next merge, breaking idempotence).
// - Order: local order first (it is the z-order), then remote-only tasks in remote order.

export const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Parse an ISO time to ms; anything unparseable counts as the distant past. */
function ms(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** JSON with object keys sorted, so key order never makes two boards look different. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function tasksOf(board) {
  return Array.isArray(board?.tasks) ? board.tasks.filter((t) => t && typeof t.id === "string") : [];
}

function tombstonesOf(board) {
  const d = board?.deleted;
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

/** Pick the winning version of a task present on both sides. */
function newerTask(a, b) {
  const ta = ms(a.updatedAt), tb = ms(b.updatedAt);
  if (ta !== tb) return ta > tb ? a : b;
  // Same timestamp: deterministic and symmetric tie-break.
  return canonicalJSON(a) >= canonicalJSON(b) ? a : b;
}

/**
 * Merge two boards. `remote` may be null/undefined (file doesn't exist yet).
 * Inputs are not modified; the result shares no objects with them.
 * @param {object} local
 * @param {object|null} remote
 * @param {{now?: number}} [opts] `now` (ms) is only used for pruning old tombstones.
 */
export function mergeBoards(local, remote, { now = Date.now() } = {}) {
  const localTasks = tasksOf(local);
  const remoteTasks = tasksOf(remote);
  const remoteById = new Map(remoteTasks.map((t) => [t.id, t]));
  const localIds = new Set(localTasks.map((t) => t.id));

  // 1. Combine tasks, keeping local order then remote-only tasks in remote order.
  const combined = [];
  for (const t of localTasks) {
    const r = remoteById.get(t.id);
    combined.push(r ? newerTask(t, r) : t);
  }
  for (const t of remoteTasks) if (!localIds.has(t.id)) combined.push(t);

  // 2. Combine tombstones, keeping the newest deletedAt.
  const deleted = {};
  for (const src of [tombstonesOf(local), tombstonesOf(remote)]) {
    for (const [id, at] of Object.entries(src)) {
      if (typeof at !== "string") continue;
      if (!(id in deleted) || ms(at) > ms(deleted[id])) deleted[id] = at;
    }
  }

  // 3. Apply tombstones: delete wins only if it's at least as new as the task's last edit.
  const tasks = [];
  const seen = new Set();
  for (const t of combined) {
    if (seen.has(t.id)) continue; // guard against duplicate ids in the input
    seen.add(t.id);
    if (t.id in deleted) {
      if (ms(deleted[t.id]) >= ms(t.updatedAt)) continue; // deleted
      delete deleted[t.id]; // edited after deletion: task survives
    }
    tasks.push(t);
  }

  // 4. Prune old tombstones, but keep one while an input still has the task it removes.
  for (const [id, at] of Object.entries(deleted)) {
    if (now - ms(at) > TOMBSTONE_TTL_MS && !localIds.has(id) && !remoteById.has(id)) delete deleted[id];
  }

  // Keep unknown top-level fields (remote first, local overrides), then the known ones.
  const extra = { ...(remote && typeof remote === "object" ? remote : {}), ...(local || {}) };
  const out = { ...extra, version: 1, tasks, deleted };
  return JSON.parse(JSON.stringify(out)); // deep copy: no shared references with inputs
}

/** True if two boards have the same content, ignoring key order. */
export function sameBoard(a, b, { ignoreTaskOrder = false } = {}) {
  if (!a || !b) return !a && !b;
  if (!ignoreTaskOrder) return canonicalJSON(a) === canonicalJSON(b);
  const sorted = (x) => ({ ...x, tasks: [...tasksOf(x)].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)) });
  return canonicalJSON(sorted(a)) === canonicalJSON(sorted(b));
}

// ---------- Base64 <-> UTF-8 (GitHub contents API) ----------

/** UTF-8 string -> base64 (handles emoji and other non-Latin text). */
export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack limits on big boards
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** base64 (GitHub wraps it with newlines) -> UTF-8 string. */
export function decodeBase64Utf8(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
