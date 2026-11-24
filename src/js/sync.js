// GitHub sync: keeps the board in a JSON file in a (private) GitHub repo.
// Transport: plain window.fetch to api.github.com (GitHub's REST API supports CORS).
// The token lives only in the OS keychain via app.secrets; it is never logged.

import {
  mergeBoards, sameBoard, encodeBase64Utf8, decodeBase64Utf8,
  referencedAttachmentIds, attachmentsDir, planAttachments,
} from "./sync-merge.js";

const API = "https://api.github.com";
const TOKEN_KEY = "github-token";
const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
const DEBOUNCE_MS = 4000;
const INTERVAL_MS = 2 * 60 * 1000;
const FOCUS_MIN_GAP_MS = 15 * 1000; // don't hammer GitHub when switching windows a lot
const MAX_CONFLICT_RETRIES = 3;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // the app itself refuses files over 20 MB
const CONTENTS_MAX_BYTES = 1024 * 1024;    // bigger files need the blob API to download

const S = { repo: "sync.repo", branch: "sync.branch", path: "sync.path", last: "sync.lastSyncedAt" };

let app;
let hasToken = false;
let status = { kind: "off", message: "" }; // off | synced | partial | syncing | offline | error
let lastToastKey = null;
let running = null;      // promise of the sync loop in progress
let again = false;       // a sync was requested while one was running
let debounceTimer = null;
let lastAttemptAt = 0;
const listeners = new Set();
let btn;
// Attachment sync state (kept across cycles, reset when the repo/branch/path changes).
let remoteKnownKey = "";
let remoteKnown = new Set();   // ids confirmed to exist in the repo (they are never changed)
const tooBigWarned = new Set(); // ids we already toasted about being over 50 MB

// ---------- Settings ----------
function config() {
  return {
    repo: app.settings.get(S.repo, ""),
    branch: app.settings.get(S.branch, "main") || "main",
    path: app.settings.get(S.path, "board.json") || "board.json",
  };
}
const isConfigured = () => hasToken && /^[^/\s]+\/[^/\s]+$/.test(config().repo);

/** Accepts "owner/name" or a pasted github.com URL. Returns "owner/name" or null. */
function parseRepo(input) {
  let s = String(input || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

function platformName() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "desktop";
}

// ---------- HTTP ----------
class SyncError extends Error {
  constructor(kind, message, httpStatus) { super(message); this.kind = kind; this.httpStatus = httpStatus; }
}

const encPath = (p) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
const repoUrl = (repo) => `${API}/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

async function gh(token, method, url, body) {
  const isGet = method === "GET";
  if (isGet) url += `${url.includes("?") ? "&" : "?"}_=${Date.now()}`; // bust any proxy cache
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError("offline", "Offline (will retry)");
  }
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

/** Turn a failed response into a user-facing SyncError. */
function httpError(r) {
  const s = r.status;
  if (s === 401) return new SyncError("error", "Token rejected or expired", s);
  if ((s === 403 || s === 429) && r.headers.get("x-ratelimit-remaining") === "0")
    return new SyncError("offline", "GitHub rate limit reached (will retry)", s);
  if (s === 403) return new SyncError("error", "Token lacks Contents write permission", s);
  if (s === 404) return new SyncError("error", "Repo not found, or token can't see it", s);
  if (s >= 500) return new SyncError("offline", "GitHub is having trouble (will retry)", s);
  return new SyncError("error", `GitHub error ${s}${r.data?.message ? `: ${r.data.message}` : ""}`, s);
}

/**
 * Read the board file. Returns { board, sha, createWithoutBranch }.
 * board/sha are null when the file doesn't exist yet.
 */
async function getRemote(token, { repo, branch, path }) {
  const r = await gh(token, "GET", `${repoUrl(repo)}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
  if (r.status === 404) return missingFile(token, repo, branch);
  if (!r.ok) throw httpError(r);
  if (Array.isArray(r.data) || r.data?.type !== "file") {
    throw new SyncError("error", `"${path}" on GitHub is a folder, not a file`);
  }
  let b64 = r.data.content;
  if (!b64 && r.data.sha) {
    // Files over 1 MB come back without content; fetch the raw blob instead.
    const blob = await gh(token, "GET", `${repoUrl(repo)}/git/blobs/${r.data.sha}`);
    if (!blob.ok) throw httpError(blob);
    b64 = blob.data?.content || "";
  }
  let board;
  try {
    board = JSON.parse(decodeBase64Utf8(b64));
  } catch {
    // Never overwrite a file we can't read: it might be someone's data.
    throw new SyncError("error", `The file "${path}" on GitHub isn't a valid board`);
  }
  return { board: app.store.normalize(board), sha: r.data.sha };
}

/** Contents 404: figure out whether the repo, the branch, or just the file is missing. */
async function missingFile(token, repo, branch) {
  const repoRes = await gh(token, "GET", repoUrl(repo));
  if (!repoRes.ok) throw httpError(repoRes);
  const br = await gh(token, "GET", `${repoUrl(repo)}/branches/${encodeURIComponent(branch)}`);
  if (br.ok) return { board: null, sha: null };
  if (br.status !== 404) throw httpError(br);
  // An empty repo has no branches yet. Creating a file without `branch` makes the default one.
  if (branch === repoRes.data?.default_branch) return { board: null, sha: null, createWithoutBranch: true };
  throw new SyncError("error", `Branch "${branch}" not found in ${repo}`);
}

/** Write the board. Returns true on success, false on a sha conflict (caller retries). */
async function putRemote(token, { repo, branch, path }, board, sha, createWithoutBranch) {
  const body = {
    message: `Update board (${platformName()})`,
    content: encodeBase64Utf8(JSON.stringify(board, null, 1) + "\n"),
  };
  if (sha) body.sha = sha;
  if (!createWithoutBranch) body.branch = branch;
  const r = await gh(token, "PUT", `${repoUrl(repo)}/contents/${encPath(path)}`, body);
  if (r.ok) return true;
  if (r.status === 409 || r.status === 422) return false; // someone else wrote first
  throw httpError(r);
}

// ---------- Sync cycle ----------
async function syncOnce() {
  const token = await app.secrets.get(TOKEN_KEY);
  if (!token) { hasToken = false; setStatus({ kind: "off" }); return; }
  const cfg = config();
  setStatus({ kind: "syncing" });
  try {
    for (let attempt = 0; ; attempt++) {
      const remote = await getRemote(token, cfg);

      // Read the board *now*, after the network wait, so edits made meanwhile are included.
      // Everything from here to setBoard is synchronous, so nothing can slip in between.
      const local = app.store.board;
      const localEmpty = !local.tasks.length && !(local.links || []).length && !Object.keys(local.deleted || {}).length;
      const merged = localEmpty && remote.board ? remote.board : mergeBoards(local, remote.board);
      if (!sameBoard(merged, local)) {
        app.store.setBoard(merged, { silent: true });
        app.render();
      }

      // Task (and link) order is per-device z-order: don't commit just because it
      // differs (two devices would keep swapping it back and forth).
      if (remote.board && sameBoard(merged, remote.board, { ignoreTaskOrder: true })) break;
      const ok = await putRemote(token, cfg, app.store.normalize(merged), remote.sha, remote.createWithoutBranch);
      if (ok) break;
      if (attempt >= MAX_CONFLICT_RETRIES) {
        throw new SyncError("offline", "The file kept changing on GitHub (will retry)");
      }
    }
    const iso = new Date().toISOString();
    app.settings.set(S.last, iso);
    // Board is in sync. Files are a separate step that never fails the board sync.
    const failed = await syncAttachments(token, cfg);
    if (!failed) setStatus({ kind: "synced" });
    else setStatus({
      kind: "partial",
      message: failed < 0 ? "Files couldn't sync (will retry)"
        : `${failed} file${failed === 1 ? "" : "s"} couldn't sync (will retry)`,
    });
  } catch (e) {
    if (e instanceof SyncError) setStatus({ kind: e.kind, message: e.message });
    else {
      console.error("Sync failed:", e?.name, e?.message); // never includes the token
      setStatus({ kind: "error", message: "Sync failed unexpectedly" });
    }
  }
}

// ---------- Attachment files ----------
// Files live in "<board folder>/attachments/<attachmentId>". An id is unique and a
// file never changes, so there are no conflicts: we only copy what's missing.
// Files no longer used are left in the repo (deleting them would also only hide
// them: they stay in the history).

/**
 * Ids (-> {sha, size}) in the repo's attachments folder. Uses the recursive
 * tree (one request, no 1000-entry cap); if GitHub truncates it, falls back to
 * listing the folder.
 */
async function listRemoteAttachments(token, { repo, branch }, dir) {
  const out = new Map();
  const prefix = `${dir}/`;
  const t = await gh(token, "GET", `${repoUrl(repo)}/git/trees/${encPath(branch)}?recursive=1`);
  if (t.status === 404 || t.status === 409) return out; // empty repo / no branch yet
  if (!t.ok) throw httpError(t);
  if (!t.data?.truncated) {
    for (const e of t.data?.tree || []) {
      if (e?.type !== "blob" || typeof e.path !== "string" || !e.path.startsWith(prefix)) continue;
      const name = e.path.slice(prefix.length);
      if (name && !name.includes("/")) out.set(name, { sha: e.sha, size: e.size || 0 });
    }
    return out;
  }
  const c = await gh(token, "GET", `${repoUrl(repo)}/contents/${encPath(dir)}?ref=${encodeURIComponent(branch)}`);
  if (c.status === 404) return out;
  if (!c.ok) throw httpError(c);
  if (Array.isArray(c.data)) {
    for (const e of c.data) if (e?.type === "file") out.set(e.name, { sha: e.sha, size: e.size || 0 });
  }
  return out;
}

/** Upload one file. Returns "ok" or "too-big". Throws on failure. */
async function uploadAttachment(token, { repo, branch }, dir, id, sizeHint) {
  if (sizeHint > MAX_UPLOAD_BYTES) return "too-big";
  const b64 = await app.attachments.read(id);
  if (b64 === null) throw new SyncError("error", `File ${id} isn't on this computer`);
  if (Math.floor((b64.replace(/\s+/g, "").length * 3) / 4) > MAX_UPLOAD_BYTES) return "too-big";
  const r = await gh(token, "PUT", `${repoUrl(repo)}/contents/${encPath(`${dir}/${id}`)}`, {
    message: "Add attachment", content: b64.replace(/\s+/g, ""), branch,
  });
  if (r.ok) return "ok";
  // 422 "sha wasn't supplied": the file is already there (another computer uploaded it).
  if (r.status === 422 && /sha/i.test(r.data?.message || "")) return "ok";
  throw httpError(r);
}

/** Download one file into this computer's attachments folder. */
async function downloadAttachment(token, { repo, branch }, dir, id, entry) {
  let b64 = "";
  if (!(entry.size > CONTENTS_MAX_BYTES)) {
    const r = await gh(token, "GET", `${repoUrl(repo)}/contents/${encPath(`${dir}/${id}`)}?ref=${encodeURIComponent(branch)}`);
    if (!r.ok) throw httpError(r);
    b64 = r.data?.content || "";
    if (!entry.sha) entry = { ...entry, sha: r.data?.sha };
  }
  if (!b64) {
    if (!entry.sha) throw new SyncError("error", `File ${id} has no content on GitHub`);
    const blob = await gh(token, "GET", `${repoUrl(repo)}/git/blobs/${entry.sha}`);
    if (!blob.ok) throw httpError(blob);
    if (blob.data?.encoding && blob.data.encoding !== "base64") throw new SyncError("error", `Unexpected encoding for ${id}`);
    b64 = blob.data?.content || "";
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64 && entry.size) throw new SyncError("error", `File ${id} came back empty`);
  await app.attachments.save(id, b64);
  app.attachments.changed(id);
}

/**
 * Make sure every file the board uses is both here and in the repo.
 * Runs sequentially with progress in the status. Returns the number of files
 * that failed (they are retried next cycle), or -1 if the repo's file list
 * couldn't be read. Never throws.
 */
async function syncAttachments(token, cfg) {
  const att = app.attachments;
  if (!att || typeof att.list !== "function" || typeof att.read !== "function" || typeof att.save !== "function") return 0;
  try {
    const key = `${cfg.repo}|${cfg.branch}|${cfg.path}`;
    if (key !== remoteKnownKey) { remoteKnownKey = key; remoteKnown = new Set(); }

    const board = app.store.board;
    const referenced = referencedAttachmentIds(board);
    if (!referenced.size) return 0;
    const sizes = new Map();
    for (const t of board.tasks) if (t.attachmentId) sizes.set(t.attachmentId, Number(t.size) || 0);

    const local = new Set(await att.list()); // once per cycle
    // Skip the listing entirely when everything is already known to be in both places.
    const unsure = [...referenced].filter((id) =>
      !(local.has(id) && remoteKnown.has(id)) && !(tooBigWarned.has(id) && local.has(id)));
    if (!unsure.length) return 0;

    const dir = attachmentsDir(cfg.path);
    const remote = await listRemoteAttachments(token, cfg, dir); // once per cycle
    for (const id of remote.keys()) remoteKnown.add(id);
    const plan = planAttachments(referenced, local, new Set(remote.keys()));
    const upload = plan.upload.filter((id) => !tooBigWarned.has(id));
    const jobs = [
      ...upload.map((id) => ({ id, up: true })),
      ...plan.download.map((id) => ({ id, up: false })),
    ];
    if (!jobs.length) return 0;

    let failed = 0, done = 0;
    for (const job of jobs) {
      done++;
      setStatus({ kind: "syncing", message: `Syncing files ${done}/${jobs.length}…` });
      try {
        if (job.up) {
          const res = await uploadAttachment(token, cfg, dir, job.id, sizes.get(job.id) || 0);
          if (res === "too-big") {
            if (!tooBigWarned.has(job.id)) {
              tooBigWarned.add(job.id);
              const name = board.tasks.find((t) => t.attachmentId === job.id)?.title || job.id;
              app.toast(`Sync: “${name}” is over ${MAX_UPLOAD_BYTES / 1048576} MB, so it stays on this computer only.`, { ms: 10000 });
            }
          } else remoteKnown.add(job.id);
        } else {
          await downloadAttachment(token, cfg, dir, job.id, remote.get(job.id));
        }
      } catch (e) {
        failed++;
        if (!(e instanceof SyncError)) console.error("Attachment sync failed:", e?.name, e?.message);
        // No point trying the rest while offline or rate limited: count them all as pending.
        if (e instanceof SyncError && e.kind === "offline") { failed += jobs.length - done; break; }
      }
    }
    return failed;
  } catch (e) {
    // Listing failed (offline, rate limit...). The board is synced; files retry next cycle.
    if (!(e instanceof SyncError)) console.error("Attachment sync failed:", e?.name, e?.message);
    return -1;
  }
}

/** Run a sync, or queue exactly one more if one is already running. */
function requestSync() {
  clearTimeout(debounceTimer);
  if (!isConfigured()) return Promise.resolve();
  lastAttemptAt = Date.now();
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do { again = false; await syncOnce(); } while (again && isConfigured());
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------- Status display ----------
function timeAgo(iso) {
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function statusText() {
  switch (status.kind) {
    case "off": return "Sync: not set up";
    case "syncing": return status.message || "Syncing…";
    case "synced": {
      const last = app.settings.get(S.last);
      return last ? `Synced · ${timeAgo(last)}` : "Synced";
    }
    case "partial": {
      const last = app.settings.get(S.last);
      return last ? `Synced · ${timeAgo(last)} · files pending` : "Synced · files pending";
    }
    case "offline": return "Offline (will retry)";
    default: return "Sync error";
  }
}

function renderButton() {
  if (!btn) return;
  btn.dataset.state = status.kind;
  btn.querySelector(".sync-label").textContent = statusText();
  btn.title = status.message || (status.kind === "off" ? "Set up GitHub sync" : "Sync settings");
}

function setStatus(next) {
  status = { kind: next.kind, message: next.message || "" };
  renderButton();
  for (const fn of listeners) fn();

  // Toast only when the situation changes, not on every retry or routine sync.
  if (status.kind === "syncing") return;
  // "partial" (some files failed) toasts once, not again each time the count changes.
  const key = ["synced", "off", "partial"].includes(status.kind) ? status.kind : `${status.kind}:${status.message}`;
  if (key === lastToastKey) return;
  const hadProblem = lastToastKey && /^(offline|error|partial)/.test(lastToastKey);
  lastToastKey = key;
  if (status.kind === "error") app.toast(`Sync error: ${status.message}`, { ms: 10000 });
  else if (status.kind === "offline" || status.kind === "partial") app.toast(`Sync: ${status.message}`);
  else if (status.kind === "synced" && hadProblem) app.toast("Sync is working again");
}

// ---------- Settings modal ----------
function openSettings() {
  const cfg = config();
  const wrap = document.createElement("div");
  wrap.className = "sync-settings";
  wrap.innerHTML = `
    <p class="sync-status-line"><span class="sync-dot"></span><span class="sync-status-text"></span></p>

    <label>Repository <span class="hint">(owner/name)</span>
      <input type="text" name="repo" placeholder="your-username/canvas-planner-data" spellcheck="false" autocomplete="off" />
    </label>
    <div class="sync-row">
      <label>Branch <input type="text" name="branch" spellcheck="false" autocomplete="off" /></label>
      <label>File path <input type="text" name="path" spellcheck="false" autocomplete="off" /></label>
    </div>
    <label>GitHub token
      <input type="password" name="token" spellcheck="false" autocomplete="off" />
    </label>
    <p class="hint">The token is stored in this computer's secure keychain, never in the board file.</p>

    <p class="sync-msg" role="status"></p>

    <div class="actions">
      <button class="danger" data-act="disconnect">Disconnect</button>
      <button class="ghost" data-act="sync">Sync now</button>
      <button class="primary" data-act="connect">Connect</button>
    </div>

    <details class="sync-help">
      <summary>How to set this up (about 5 minutes)</summary>
      <ol>
        <li>On github.com, create a new <b>private</b> repository called <code>canvas-planner-data</code>.
          Tick <b>“Add a README file”</b> so it starts with a <code>main</code> branch.</li>
        <li><button class="ghost small" data-act="token-page">Open the token page</button>
          (Settings → Developer settings → Fine-grained tokens → Generate new token).</li>
        <li>Name it “Canvas Planner”. For <b>Expiration</b> pick 1 year (set a reminder to renew it).</li>
        <li>Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick <code>canvas-planner-data</code>.</li>
        <li>Under <b>Permissions → Repository permissions</b>, set <b>Contents</b> to <b>Read and write</b>.
          Leave everything else as it is.</li>
        <li>Click <b>Generate token</b>, copy it, paste it above, fill in the repository, and click <b>Connect</b>.</li>
      </ol>
      <p class="hint">Do the same on each computer (you can reuse the token, or make one per computer).</p>
    </details>`;

  const $ = (sel) => wrap.querySelector(sel);
  const f = { repo: $('[name="repo"]'), branch: $('[name="branch"]'), path: $('[name="path"]'), token: $('[name="token"]') };
  f.repo.value = cfg.repo;
  f.branch.value = cfg.branch;
  f.path.value = cfg.path;
  const msg = $(".sync-msg");
  const say = (text, bad = false) => { msg.textContent = text; msg.classList.toggle("bad", bad); };

  const refresh = () => {
    $(".sync-status-line").dataset.state = status.kind;
    let text = statusText();
    if (status.message && ["error", "offline", "partial"].includes(status.kind)) text += ` – ${status.message}`;
    if (status.kind === "synced" || status.kind === "partial") text += ` to ${config().repo}`;
    $(".sync-status-text").textContent = text;
    f.token.placeholder = hasToken ? "Saved in keychain – leave blank to keep it" : "Paste your fine-grained token (github_pat_…)";
    $('[data-act="sync"]').disabled = !isConfigured() || !!running;
    $('[data-act="disconnect"]').disabled = !hasToken;
  };
  listeners.add(refresh);
  refresh();

  const busy = (on) => wrap.querySelectorAll("button[data-act]").forEach((b) => {
    if (b.dataset.act !== "token-page") b.disabled = on;
  });

  async function connect() {
    const repo = parseRepo(f.repo.value);
    if (!repo) return say("Enter the repository as owner/name, e.g. jane/canvas-planner-data.", true);
    const branch = f.branch.value.trim() || "main";
    const path = f.path.value.trim().replace(/^\/+/, "") || "board.json";
    const typed = f.token.value.trim();
    const token = typed || (await app.secrets.get(TOKEN_KEY));
    if (!token) return say("Paste your GitHub token first.", true);

    busy(true);
    say("Checking access…");
    try {
      const r = await gh(token, "GET", repoUrl(repo));
      if (!r.ok) throw httpError(r);
      // `permissions` reflects what this user can do in the repo. Missing: can't tell, let the first write decide.
      if (r.data?.permissions && !r.data.permissions.push) {
        throw new SyncError("error", "Token lacks Contents write permission");
      }
      app.settings.set(S.repo, repo);
      app.settings.set(S.branch, branch);
      app.settings.set(S.path, path);
      if (typed) await app.secrets.set(TOKEN_KEY, typed);
      hasToken = true;
      f.token.value = "";
      f.repo.value = repo;
      say(`Connected to ${repo}${r.data?.private === false ? " (note: this repo is public!)" : ""}. Syncing…`);
      await requestSync();
      const ok = status.kind === "synced" || status.kind === "partial";
      say(ok ? `Connected to ${repo}.` : "", !ok);
    } catch (e) {
      say(e instanceof SyncError ? e.message : "Couldn't connect.", true);
    } finally {
      busy(false);
      refresh();
    }
  }

  async function syncNow() {
    say("");
    busy(true);
    await requestSync();
    busy(false);
    refresh();
  }

  async function disconnect() {
    busy(true);
    try {
      await app.secrets.delete(TOKEN_KEY);
      hasToken = false;
      app.settings.set(S.last, null);
      setStatus({ kind: "off" });
      say("Disconnected. The token was removed from this computer. Your board stays here and on GitHub.");
    } catch {
      say("Couldn't remove the token from the keychain.", true);
    } finally {
      busy(false);
      refresh();
    }
  }

  wrap.addEventListener("click", (e) => {
    const act = e.target.closest("button[data-act]")?.dataset.act;
    if (act === "connect") connect();
    else if (act === "sync") syncNow();
    else if (act === "disconnect") disconnect();
    else if (act === "token-page") app.openUrl(TOKEN_PAGE);
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); connect(); }
  });

  if (!cfg.repo || !hasToken) $(".sync-help").open = true;
  app.openModal("GitHub sync", wrap, { onClose: () => listeners.delete(refresh) });
  (cfg.repo ? f.token : f.repo).focus();
}

// ---------- Init ----------
export async function init(appApi) {
  app = appApi;

  btn = document.createElement("button");
  btn.className = "sync-btn";
  btn.innerHTML = `<span class="sync-dot"></span><span class="sync-label"></span>`;
  btn.addEventListener("click", openSettings);
  app.toolbarSlot.appendChild(btn);

  try { hasToken = !!(await app.secrets.get(TOKEN_KEY)); } catch { hasToken = false; }
  // Until the first sync finishes, show the last known sync time.
  status = { kind: isConfigured() && app.settings.get(S.last) ? "synced" : "off", message: "" };
  if (status.kind === "synced") lastToastKey = "synced";
  renderButton();

  app.store.events.addEventListener("changed", () => {
    if (!isConfigured()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(requestSync, DEBOUNCE_MS);
  });
  setInterval(requestSync, INTERVAL_MS);
  addEventListener("focus", () => { if (Date.now() - lastAttemptAt > FOCUS_MIN_GAP_MS) requestSync(); });
  addEventListener("online", () => requestSync());
  setInterval(renderButton, 30 * 1000); // keep "2 min ago" fresh

  requestSync(); // on start, if configured (don't block app start-up)
}
