// Pure merge logic for GitHub sync. No DOM, no app access: runs in node for tests.
//
// Board shape: { version: 1, tasks: [...], links: [...], deleted: { id: isoDeletedAt } }
// Tasks and links both have unique ids (UUIDs) and share the one `deleted` map.
// A board from an older version may have no `links`; that counts as [].
//
// Rules (see docs/SYNC.md for the plain-language version), applied to tasks and
// links alike:
// - Items are combined by id. If both sides have an item, the one with the newer
//   `updatedAt` wins as a whole. Exact ties are broken by comparing the items'
//   canonical JSON, so every device picks the same winner.
// - Tombstones (`deleted`) are combined, keeping the newest deletedAt per id.
//   A tombstone removes an item if deletedAt >= the item's updatedAt; otherwise
//   the item was edited after the delete, so it survives and the tombstone is dropped.
// - Tombstones older than 60 days are pruned, except while either input still
//   holds a copy of that item (otherwise the stale copy would come back on the
//   next merge, breaking idempotence).
// - Order: local order first (it is the z-order), then remote-only items in remote order.
// - The merge does not check that a link's `from`/`to` tasks still exist:
//   store.normalize drops such links afterwards.

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

function itemsOf(board, key) {
  const list = board?.[key];
  return Array.isArray(list) ? list.filter((t) => t && typeof t === "object" && typeof t.id === "string") : [];
}
const tasksOf = (board) => itemsOf(board, "tasks");
const linksOf = (board) => itemsOf(board, "links");

function tombstonesOf(board) {
  const d = board?.deleted;
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

/** Pick the winning version of an item (task or link) present on both sides. */
function newer(a, b) {
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
  // 1. Combine tombstones, keeping the newest deletedAt.
  const deleted = {};
  for (const src of [tombstonesOf(local), tombstonesOf(remote)]) {
    for (const [id, at] of Object.entries(src)) {
      if (typeof at !== "string") continue;
      if (!(id in deleted) || ms(at) > ms(deleted[id])) deleted[id] = at;
    }
  }

  // 2. Combine tasks and links the same way. Tombstones are shared (ids are unique).
  const inputIds = new Set(); // every id either input still holds (for pruning)
  const tasks = combine(tasksOf(local), tasksOf(remote), deleted, inputIds);
  const links = combine(linksOf(local), linksOf(remote), deleted, inputIds);

  // 3. Prune old tombstones, but keep one while an input still has the item it removes.
  for (const [id, at] of Object.entries(deleted)) {
    if (now - ms(at) > TOMBSTONE_TTL_MS && !inputIds.has(id)) delete deleted[id];
  }

  // Keep unknown top-level fields (remote first, local overrides), then the known ones.
  const extra = { ...(remote && typeof remote === "object" ? remote : {}), ...(local || {}) };
  const out = { ...extra, version: 1, tasks, links, deleted };
  return JSON.parse(JSON.stringify(out)); // deep copy: no shared references with inputs
}

/**
 * Combine one list (tasks or links) from both sides and apply tombstones.
 * Mutates `deleted` (drops tombstones beaten by a later edit) and adds every
 * input id to `inputIds`.
 */
function combine(localItems, remoteItems, deleted, inputIds) {
  const remoteById = new Map(remoteItems.map((t) => [t.id, t]));
  const localIds = new Set(localItems.map((t) => t.id));
  for (const id of localIds) inputIds.add(id);
  for (const id of remoteById.keys()) inputIds.add(id);

  // Local order, then remote-only items in remote order.
  const combined = [];
  for (const t of localItems) {
    const r = remoteById.get(t.id);
    combined.push(r ? newer(t, r) : t);
  }
  for (const t of remoteItems) if (!localIds.has(t.id)) combined.push(t);

  // Delete wins only if it's at least as new as the item's last edit.
  const out = [];
  const seen = new Set();
  for (const t of combined) {
    if (seen.has(t.id)) continue; // guard against duplicate ids in the input
    seen.add(t.id);
    if (t.id in deleted) {
      if (ms(deleted[t.id]) >= ms(t.updatedAt)) continue; // deleted
      delete deleted[t.id]; // edited after deletion: item survives
    }
    out.push(t);
  }
  return out;
}

/**
 * True if two boards have the same content, ignoring key order.
 * A missing `links` counts as []. With `ignoreTaskOrder`, the order of tasks
 * and of links is ignored too (both are per-device).
 */
export function sameBoard(a, b, { ignoreTaskOrder = false } = {}) {
  if (!a || !b) return !a && !b;
  const byId = (p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
  const prep = (x) => {
    const y = { ...x, links: Array.isArray(x.links) ? x.links : [] };
    if (ignoreTaskOrder) {
      y.tasks = [...tasksOf(x)].sort(byId);
      y.links = [...linksOf(x)].sort(byId);
    }
    return y;
  };
  return canonicalJSON(prep(a)) === canonicalJSON(prep(b));
}

// ---------- Attachments ----------

/** Attachment ids that are safe to use as a file name (also in a repo path). */
export const isSafeAttachmentId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && !id.includes("..");

/** Set of attachmentIds used by tasks on the board (tombstoned tasks excluded). */
export function referencedAttachmentIds(board) {
  const deleted = tombstonesOf(board);
  const out = new Set();
  for (const t of tasksOf(board)) {
    if (t.id in deleted) continue;
    if (isSafeAttachmentId(t.attachmentId)) out.add(t.attachmentId);
  }
  return out;
}

/** Folder for attachment files, next to the board file: "sub/board.json" -> "sub/attachments". */
export function attachmentsDir(boardPath) {
  const p = String(boardPath || "").replace(/^\/+/, "");
  const i = p.lastIndexOf("/");
  return `${i >= 0 ? p.slice(0, i + 1) : ""}attachments`;
}

/**
 * Decide which files to move. All arguments are Sets of ids.
 * upload: referenced, here, not on the remote. download: referenced, on the remote, not here.
 * Sorted, so the work order is stable.
 */
export function planAttachments(referenced, local, remote) {
  const upload = [], download = [];
  for (const id of referenced) {
    if (local.has(id) && !remote.has(id)) upload.push(id);
    else if (!local.has(id) && remote.has(id)) download.push(id);
  }
  return { upload: upload.sort(), download: download.sort() };
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
