// Images and files placed on the canvas.
// Bytes live in the app data folder (attachments/<id>) via Rust; the board only
// stores the id, name, type and size. In a plain browser (dev) they're kept in memory.

import { MAX_ATTACHMENT_BYTES } from "./model.js";

const invoke = window.__TAURI__?.core?.invoke;
const devStore = new Map(); // id -> base64 (browser-only fallback)
const urlCache = new Map(); // id -> object URL (or a pending promise)
const listeners = new Set();

export function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Make a safe id like "uuid.png" from a file name. */
export function newAttachmentId(fileName) {
  const ext = (fileName.match(/\.([A-Za-z0-9]{1,10})$/)?.[1] || "").toLowerCase();
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return ext ? `${uuid}.${ext}` : uuid;
}

export const attachments = {
  /** Save base64 data under an id. */
  async save(id, base64) {
    if (invoke) await invoke("save_attachment", { id, data: base64 });
    else devStore.set(id, base64);
  },
  /** base64 data, or null if not on this computer. */
  async read(id) {
    if (invoke) return invoke("read_attachment", { id });
    return devStore.get(id) ?? null;
  },
  /** ids stored on this computer. */
  async list() {
    if (invoke) return invoke("list_attachments");
    return [...devStore.keys()];
  },
  async exists(id) {
    return (await this.list()).includes(id);
  },
  /** Open in the default app (desktop) or a new tab (browser). */
  async open(id, mime) {
    if (invoke) return invoke("open_attachment", { id });
    const url = await imageUrl(id, mime);
    if (url) window.open(url, "_blank");
  },
  /** Tell the UI an attachment arrived (e.g. downloaded by sync) so images refresh. */
  changed(id) {
    const old = urlCache.get(id);
    if (typeof old === "string") URL.revokeObjectURL(old);
    urlCache.delete(id);
    for (const fn of listeners) fn(id);
  },
  onChanged(fn) { listeners.add(fn); },
};

/** Object URL for showing an attachment, or null if it isn't available locally. */
export async function imageUrl(id, mime = "") {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const p = (async () => {
    const b64 = await attachments.read(id);
    if (!b64) { urlCache.delete(id); return null; }
    const url = URL.createObjectURL(new Blob([base64ToBytes(b64)], { type: mime || "application/octet-stream" }));
    urlCache.set(id, url);
    return url;
  })();
  urlCache.set(id, p);
  return p;
}

/** Store a File (from a picker, drop or paste). Returns fields for a new canvas element. */
export async function storeFile(file) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`“${file.name}” is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB.`);
  }
  const id = newAttachmentId(file.name || "pasted.png");
  const bytes = new Uint8Array(await file.arrayBuffer());
  await attachments.save(id, bytesToBase64(bytes));
  const isImage = /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp)$/i.test(file.type);
  return {
    kind: isImage ? "image" : "file",
    title: file.name || "Pasted image",
    attachmentId: id,
    mime: file.type || "",
    size: file.size,
  };
}

/** Ask the user to pick a file. Resolves to a File or null. */
export function pickFile(accept = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => { resolve(input.files?.[0] || null); input.remove(); });
    input.addEventListener("cancel", () => { resolve(null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
