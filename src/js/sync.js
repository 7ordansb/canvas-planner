// GitHub sync: keeps the board in a JSON file in a (private) GitHub repo.
// Transport: plain window.fetch to api.github.com (GitHub's REST API supports CORS).
// The token lives only in the OS keychain via app.secrets; it is never logged.

import { mergeBoards, sameBoard, encodeBase64Utf8, decodeBase64Utf8 } from "./sync-merge.js";

const API = "https://api.github.com";
const TOKEN_KEY = "github-token";
const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
const DEBOUNCE_MS = 4000;
const INTERVAL_MS = 2 * 60 * 1000;
const FOCUS_MIN_GAP_MS = 15 * 1000; // don't hammer GitHub when switching windows a lot
const MAX_CONFLICT_RETRIES = 3;

const S = { repo: "sync.repo", branch: "sync.branch", path: "sync.path", last: "sync.lastSyncedAt" };

let app;
let hasToken = false;
let status = { kind: "off", message: "" }; // off | synced | syncing | offline | error
let lastToastKey = null;
let running = null;      // promise of the sync loop in progress
let again = false;       // a sync was requested while one was running
let debounceTimer = null;
let lastAttemptAt = 0;
const listeners = new Set();
let btn;

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
      const localEmpty = !local.tasks.length && !Object.keys(local.deleted || {}).length;
      const merged = localEmpty && remote.board ? remote.board : mergeBoards(local, remote.board);
      if (!sameBoard(merged, local)) {
        app.store.setBoard(merged, { silent: true });
        app.render();
      }

      // Task order is per-device z-order: don't commit just because it differs
      // (two devices would keep swapping it back and forth).
      if (remote.board && sameBoard(merged, remote.board, { ignoreTaskOrder: true })) break;
      const ok = await putRemote(token, cfg, app.store.normalize(merged), remote.sha, remote.createWithoutBranch);
      if (ok) break;
      if (attempt >= MAX_CONFLICT_RETRIES) {
        throw new SyncError("offline", "The file kept changing on GitHub (will retry)");
      }
    }
    const iso = new Date().toISOString();
    app.settings.set(S.last, iso);
    setStatus({ kind: "synced" });
  } catch (e) {
    if (e instanceof SyncError) setStatus({ kind: e.kind, message: e.message });
    else {
      console.error("Sync failed:", e?.name, e?.message); // never includes the token
      setStatus({ kind: "error", message: "Sync failed unexpectedly" });
    }
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
    case "syncing": return "Syncing…";
    case "synced": {
      const last = app.settings.get(S.last);
      return last ? `Synced · ${timeAgo(last)}` : "Synced";
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
  const key = status.kind === "synced" || status.kind === "off" ? status.kind : `${status.kind}:${status.message}`;
  if (key === lastToastKey) return;
  const hadProblem = lastToastKey && /^(offline|error)/.test(lastToastKey);
  lastToastKey = key;
  if (status.kind === "error") app.toast(`Sync error: ${status.message}`, { ms: 10000 });
  else if (status.kind === "offline") app.toast(`Sync: ${status.message}`);
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
    if (status.message && (status.kind === "error" || status.kind === "offline")) text += ` – ${status.message}`;
    if (status.kind === "synced") text += ` to ${config().repo}`;
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
      say(status.kind === "synced" ? `Connected to ${repo}.` : "", status.kind !== "synced");
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
