// Importer: an "Import" toolbar button that opens a modal with three tabs:
// Paste a list, CSV file, and Microsoft To Do (read-only, via Microsoft Graph).

import * as P from "./import-parse.js";

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPE = "Tasks.Read offline_access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SECRET_KEY = "ms-refresh-token";

let app;
// Access token lives in memory only; the refresh token is in the OS keychain.
const auth = { accessToken: null, expiresAt: 0, key: null };

class NetworkError extends Error {}
class AuthError extends Error {
  constructor(info) { super(info.message); this.info = info; }
}
class NeedSignIn extends Error {}
class GraphError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Microsoft Graph error ${status}`);
    this.status = status;
    this.code = body?.error?.code || "";
  }
}

export async function init(a) {
  app = a;
  const btn = document.createElement("button");
  btn.id = "btn-import";
  btn.textContent = "Import";
  btn.title = "Import tasks from a list, a CSV file or Microsoft To Do";
  btn.addEventListener("click", openImporter);
  app.toolbarSlot.appendChild(btn);
}

// ---------------------------------------------------------------- helpers ----

/** Build DOM from an HTML string; returns [root, refs] where refs maps data-r names to elements. */
function build(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const root = tpl.content.firstElementChild;
  const refs = {};
  for (const el of root.querySelectorAll("[data-r]")) refs[el.dataset.r] = el;
  return [root, refs];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Add tasks to the board, mark the completed ones, close the modal and report. */
function finishImport(modal, items, extra = "") {
  const created = app.addTasks(items.map(({ done, completedAt, ...t }) => t));
  // createTask always starts tasks as not done, so mark completed ones afterwards.
  let anyDone = false;
  items.forEach((it, i) => {
    if (it.done && created[i]) {
      app.store.update(created[i].id, { completedAt: it.completedAt || new Date().toISOString() });
      anyDone = true;
    }
  });
  if (anyDone) app.render();
  modal.close();
  app.fit();
  app.toast(`Imported ${plural(created.length, "task")}${extra}`);
}

// ------------------------------------------------------------------ modal ----

function openImporter() {
  const ctx = { closed: false, cleanup: [] };
  const [root, r] = build(`
    <div class="importer">
      <div class="importer-tabs" role="tablist">
        <button role="tab" data-tab="paste">Paste a list</button>
        <button role="tab" data-tab="csv">CSV file</button>
        <button role="tab" data-tab="ms">Microsoft To Do</button>
      </div>
      <section data-panel="paste" role="tabpanel"></section>
      <section data-panel="csv" role="tabpanel" hidden></section>
      <section data-panel="ms" role="tabpanel" hidden></section>
    </div>`);

  const modal = app.openModal("Import tasks", root, {
    onClose: () => { ctx.closed = true; ctx.cleanup.forEach((fn) => fn()); },
  });
  modal.el.classList.add("importer-modal");

  const panels = Object.fromEntries([...root.querySelectorAll("[data-panel]")].map((p) => [p.dataset.panel, p]));
  const started = new Set();
  const starters = {
    paste: () => pasteTab(panels.paste, modal),
    csv: () => csvTab(panels.csv, modal),
    ms: () => msTab(panels.ms, modal, ctx, showTab),
  };

  function showTab(name) {
    for (const b of root.querySelectorAll("[data-tab]")) {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
    if (!started.has(name)) { started.add(name); starters[name](); }
    app.settings.set("import-tab", name);
    panels[name].querySelector("textarea, input:not([type=checkbox])")?.focus();
  }
  root.querySelector(".importer-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  const last = app.settings.get("import-tab", "paste");
  showTab(panels[last] ? last : "paste");
}

// ------------------------------------------------------------- Paste tab ----

function pasteTab(panel, modal) {
  const [el, r] = build(`
    <div>
      <p class="hint">One task per line. Bullets and numbers are removed. Add a date like
        <code>2026-12-03</code> or <code>due: 3/12</code> (day/month) to set a due date.</p>
      <textarea data-r="text" rows="10" spellcheck="false"
        placeholder="Book dentist appointment&#10;- Send report due: 3/12&#10;[x] Already finished thing"></textarea>
      <label class="importer-check"><input type="checkbox" data-r="done" /> Also import ticked items (<code>[x]</code>) as completed</label>
      <div class="actions">
        <span class="importer-count" data-r="count"></span>
        <button class="primary" data-r="go" disabled>Import</button>
      </div>
    </div>`);
  panel.appendChild(el);

  const items = () => {
    const all = P.parsePasteList(r.text.value);
    return { all, keep: r.done.checked ? all : all.filter((t) => !t.done) };
  };
  const update = () => {
    const { all, keep } = items();
    const skipped = all.length - keep.length;
    r.count.textContent = keep.length
      ? `${plural(keep.length, "task")} will be added` + (skipped ? ` (${skipped} ticked skipped)` : "")
      : skipped ? `${skipped} ticked item${skipped === 1 ? "" : "s"} skipped` : "";
    r.go.disabled = !keep.length;
  };
  const go = () => {
    const { keep } = items();
    if (!keep.length) return;
    finishImport(modal, keep.map((t) => ({ title: t.title, notes: "", due: t.due, done: t.done })));
  };
  r.text.addEventListener("input", update);
  r.done.addEventListener("change", update);
  r.go.addEventListener("click", go);
  r.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
  update();
}

// --------------------------------------------------------------- CSV tab ----

function readFile(file, encoding) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file, encoding);
  });
}

function csvTab(panel, modal) {
  const [el, r] = build(`
    <div>
      <p class="hint">Choose a .csv file. The first row should hold column names (e.g. Title, Notes, Due Date, Status).</p>
      <input type="file" accept=".csv,text/csv" data-r="file" />
      <p class="importer-msg" data-r="msg" hidden></p>
      <div data-r="opts" hidden>
        <div class="importer-grid">
          <label>Title <select data-r="m-title"></select></label>
          <label>Notes <select data-r="m-notes"></select></label>
          <label>Due date <select data-r="m-due"></select></label>
          <label>Completed <select data-r="m-completed"></select></label>
          <label>Date format
            <select data-r="fmt">
              <option value="auto">Automatic</option>
              <option value="ymd">YYYY-MM-DD</option>
              <option value="dmy">DD/MM/YYYY</option>
              <option value="mdy">MM/DD/YYYY</option>
            </select>
          </label>
        </div>
        <label class="importer-check"><input type="checkbox" data-r="skip" checked /> Skip completed tasks</label>
        <div class="importer-preview" data-r="preview"></div>
      </div>
      <div class="actions">
        <span class="importer-count" data-r="count"></span>
        <button class="primary" data-r="go" disabled>Import</button>
      </div>
    </div>`);
  panel.appendChild(el);

  const fields = ["title", "notes", "due", "completed"];
  let rows = null;

  const showMsg = (text, isError = false) => {
    r.msg.hidden = !text;
    r.msg.textContent = text;
    r.msg.classList.toggle("error", isError);
  };

  const mapping = () => Object.fromEntries(fields.map((f) => [f, Number(r[`m-${f}`].value)]));

  function update() {
    if (!rows) return;
    const m = mapping();
    if (m.title < 0) {
      r.preview.textContent = "";
      r.count.textContent = "Pick the column that holds the task title.";
      r.go.disabled = true;
      return;
    }
    const { tasks, dateFormat } = P.csvToTasks(rows, m, { dateFormat: r.fmt.value, skipCompleted: r.skip.checked });
    const fmtName = { ymd: "YYYY-MM-DD", dmy: "DD/MM/YYYY", mdy: "MM/DD/YYYY" }[dateFormat];
    r.fmt.options[0].textContent = m.due >= 0 ? `Automatic (${fmtName})` : "Automatic";
    renderPreview(tasks.slice(0, 5));
    r.count.textContent = tasks.length ? `${plural(tasks.length, "task")} will be added` : "No tasks to add";
    r.go.disabled = !tasks.length;
  }

  function renderPreview(tasks) {
    const [table] = build(`<table><thead><tr><th>Title</th><th>Due</th><th>Notes</th><th></th></tr></thead><tbody></tbody></table>`);
    const tbody = table.querySelector("tbody");
    for (const t of tasks) {
      const tr = document.createElement("tr");
      for (const v of [t.title, t.due || "", t.notes.length > 60 ? t.notes.slice(0, 60) + "…" : t.notes, t.done ? "Done" : ""]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    r.preview.replaceChildren(table);
  }

  r.file.addEventListener("change", async () => {
    const file = r.file.files?.[0];
    rows = null;
    r.opts.hidden = true;
    r.go.disabled = true;
    r.count.textContent = "";
    if (!file) return showMsg("");
    if (file.size > 20 * 1024 * 1024) return showMsg("That file is over 20 MB, which is too big to import.", true);
    try {
      let text = await readFile(file, "utf-8");
      // Older Excel/Outlook exports are often Windows-1252, not UTF-8.
      if (text.includes("�")) text = await readFile(file, "windows-1252");
      const parsed = P.parseCSV(text);
      if (parsed.rows.length < 2) return showMsg("This file has no rows under the header row.", true);
      rows = parsed.rows;
      const headers = rows[0];
      const guess = P.guessMapping(headers);
      for (const f of fields) {
        const sel = r[`m-${f}`];
        sel.replaceChildren(new Option(f === "title" ? "(choose a column)" : "(none)", "-1"));
        headers.forEach((h, i) => sel.appendChild(new Option(h.trim() || `Column ${i + 1}`, String(i))));
        sel.value = String(guess[f]);
      }
      const delim = { ",": "comma", ";": "semicolon", "\t": "tab" }[parsed.delimiter] || parsed.delimiter;
      showMsg(`${plural(rows.length - 1, "row")} found (${delim}-separated). Check the columns below.`);
      r.opts.hidden = false;
      update();
    } catch (e) {
      showMsg(`Couldn't read that file: ${e?.message || e}`, true);
    }
  });
  for (const k of ["m-title", "m-notes", "m-due", "m-completed", "fmt", "skip"]) r[k].addEventListener("change", update);
  r.go.addEventListener("click", () => {
    if (!rows) return;
    const { tasks } = P.csvToTasks(rows, mapping(), { dateFormat: r.fmt.value, skipCompleted: r.skip.checked });
    if (tasks.length) finishImport(modal, tasks);
  });
}

// -------------------------------------------------- Microsoft To Do tab ----

const config = () => ({
  clientId: String(app.settings.get("ms-client-id", "") || "").trim(),
  tenant: String(app.settings.get("ms-tenant", "common") || "common").trim(),
});
const configKey = (c) => `${c.clientId}|${c.tenant}`;
const tenantUrl = (c, path) => `${LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/${path}`;

/** Form-urlencoded POST to the Microsoft identity platform. */
async function postForm(url, params) {
  let res;
  try {
    res = await app.nativeFetch(url, {
      method: "POST",
      // Origin "" asks the HTTP plugin to drop its Origin header (only honoured
      // with its "unsafe-headers" feature); Microsoft rejects public-client
      // token requests that carry one (AADSTS9002326).
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Origin: "" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new NetworkError(String(e?.message || e));
  }
  let body = {};
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body };
}

async function saveTokens(c, body) {
  auth.accessToken = body.access_token;
  auth.expiresAt = Date.now() + Math.max(60, (Number(body.expires_in) || 3600) - 120) * 1000;
  auth.key = configKey(c);
  if (body.refresh_token) {
    try {
      await app.secrets.set(SECRET_KEY, body.refresh_token);
      app.settings.set("ms-token-for", configKey(c));
    } catch (e) {
      console.warn("Couldn't store refresh token", e);
      app.toast("Signed in, but couldn't save the sign-in to the keychain. You'll need to sign in again next time.");
    }
  }
}

/** Try the saved refresh token. Returns true if we now have an access token. */
async function trySilentSignIn(c) {
  if (app.settings.get("ms-token-for") !== configKey(c)) return false;
  let rt = null;
  try { rt = await app.secrets.get(SECRET_KEY); } catch {}
  if (!rt) return false;
  const res = await postForm(tenantUrl(c, "token"), {
    grant_type: "refresh_token", client_id: c.clientId, refresh_token: rt, scope: SCOPE,
  });
  if (res.ok && res.body.access_token) { await saveTokens(c, res.body); return true; }
  const info = P.classifyAuthError(res.body);
  // Consent/blocked errors are worth showing; anything else means "sign in again".
  if (["consent", "blocked", "origin"].includes(info.kind)) throw new AuthError(info);
  if (info.kind === "invalid_grant") await forgetSignIn();
  return false;
}

async function forgetSignIn() {
  auth.accessToken = null;
  auth.key = null;
  app.settings.set("ms-token-for", null);
  try { await app.secrets.delete(SECRET_KEY); } catch {}
}

async function getToken(c) {
  if (auth.accessToken && auth.key === configKey(c) && Date.now() < auth.expiresAt) return auth.accessToken;
  auth.accessToken = null;
  if (await trySilentSignIn(c)) return auth.accessToken;
  throw new NeedSignIn("Please sign in again.");
}

/** GET from Graph with one token refresh on 401 and simple throttling retries. */
async function graphGet(c, url) {
  if (!url.startsWith(GRAPH + "/")) throw new Error("Unexpected address from Microsoft Graph.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getToken(c);
    let res;
    try {
      res = await app.nativeFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (e) {
      throw new NetworkError(String(e?.message || e));
    }
    if (res.status === 401 && attempt === 0) { auth.accessToken = null; continue; }
    if ([429, 503, 504].includes(res.status) && attempt < 4) {
      const wait = Math.min(30, Number(res.headers.get("Retry-After")) || 2 ** attempt * 2);
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      continue;
    }
    let body = {};
    try { body = await res.json(); } catch {}
    if (!res.ok) throw new GraphError(res.status, body);
    return body;
  }
  throw new GraphError(429, { error: { message: "Microsoft is busy right now. Try again in a minute." } });
}

/** GET every page of a collection, following @odata.nextLink. */
async function graphGetAll(c, url, onPage) {
  const out = [];
  for (let page = 0; url && page < 200; page++) {
    const body = await graphGet(c, url);
    out.push(...(body.value || []));
    onPage?.(out.length);
    url = body["@odata.nextLink"];
  }
  return out;
}

async function fetchListTasks(c, list, includeCompleted, onPage) {
  const base = `${GRAPH}/me/todo/lists/${encodeURIComponent(list.id)}/tasks`;
  let tasks;
  if (includeCompleted) tasks = await graphGetAll(c, base, onPage);
  else {
    try {
      tasks = await graphGetAll(c, `${base}?$filter=${encodeURIComponent("status ne 'completed'")}`, onPage);
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 400)) throw e;
      tasks = await graphGetAll(c, base, onPage); // filter not accepted: fetch all, filter below
    }
  }
  return includeCompleted ? tasks : tasks.filter((t) => t.status !== "completed");
}

/** Plain-words message for any error from the To Do flow. */
function explain(e) {
  if (e instanceof NetworkError) {
    return { text: "Couldn't reach Microsoft. Your network (or a company proxy) may be blocking it. Use Paste or CSV instead.", paste: true };
  }
  if (e instanceof AuthError) {
    return { text: e.info.message, paste: ["consent", "blocked", "origin"].includes(e.info.kind) };
  }
  if (e instanceof NeedSignIn) return { text: "Your sign-in has expired. Please sign in again." };
  if (e instanceof GraphError) {
    if (e.code === "MailboxNotEnabledForRESTAPI" || (e.code === "ResourceNotFound" && e.status === 404)) {
      return { text: "Microsoft To Do isn't available for this account through Graph (it needs an Exchange Online mailbox). Use the Paste tab instead.", paste: true };
    }
    if (e.status === 403) {
      return { text: "Microsoft refused access to your tasks. The app may be missing the Tasks.Read permission, or your organisation blocks it. Use the Paste tab instead.", paste: true };
    }
    return { text: `Microsoft Graph error: ${e.message}` };
  }
  return { text: `Something went wrong: ${e?.message || e}` };
}

function msTab(panel, modal, ctx, showTab) {
  const [el, r] = build(`
    <div class="ms">
      <details class="ms-setup" data-r="setup">
        <summary>Setup: your Azure app registration</summary>
        <p class="hint">This app doesn't ship with its own Microsoft app ID, so you register a free one once.
          Full steps are in <b>docs/IMPORT.md</b> (“Setting up Microsoft To Do import”). In short:</p>
        <ol class="hint">
          <li>Go to <b>portal.azure.com</b> → <b>App registrations</b> → <b>New registration</b>. Give it a name and choose who can sign in (personal and/or work accounts). Leave Redirect URI empty.</li>
          <li><b>Authentication</b> → set <b>Allow public client flows</b> to <b>Yes</b> → Save.</li>
          <li><b>API permissions</b> → Add → Microsoft Graph → Delegated → <b>Tasks.Read</b>.</li>
          <li>Copy the <b>Application (client) ID</b> from the Overview page into the box below.</li>
        </ol>
        <label>Application (client) ID
          <input type="text" data-r="client" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocomplete="off" />
        </label>
        <label>Tenant
          <select data-r="tenantSel">
            <option value="common">common: personal or work/school accounts</option>
            <option value="consumers">consumers: personal Microsoft accounts only</option>
            <option value="organizations">organizations: work/school accounts only</option>
            <option value="custom">A specific tenant (ID or domain)</option>
          </select>
        </label>
        <input type="text" data-r="tenantCustom" placeholder="contoso.onmicrosoft.com or tenant ID" spellcheck="false" hidden />
        <div class="actions"><button class="primary small" data-r="save">Save</button></div>
      </details>

      <p class="importer-msg" data-r="msg" hidden></p>
      <p data-r="pasteLink" hidden><button class="ghost small" data-r="toPaste">Go to the Paste tab</button></p>

      <div data-r="signin" hidden>
        <p>Sign in to Microsoft to read your To Do lists. This app only reads tasks; it never changes them.</p>
        <div class="actions"><button class="primary" data-r="signinBtn">Sign in with Microsoft</button></div>
      </div>

      <div class="ms-code" data-r="code" hidden>
        <p>1. Copy this code. 2. Sign in on the Microsoft page and paste it there.</p>
        <div class="ms-user-code" data-r="userCode"></div>
        <div class="actions" style="justify-content:center">
          <button class="primary" data-r="copyOpen">Copy code &amp; open sign-in page</button>
        </div>
        <p class="hint" data-r="codeHint"></p>
        <p class="ms-waiting"><span class="ms-spinner"></span> Waiting for you to finish signing in…
          <button class="ghost small" data-r="cancel">Cancel</button></p>
      </div>

      <div data-r="busy" class="ms-waiting" hidden><span class="ms-spinner"></span> <span data-r="busyText">Working…</span></div>

      <div data-r="lists" hidden>
        <p class="hint">Choose the lists to import:</p>
        <div class="ms-lists" data-r="listBox"></div>
        <label class="importer-check"><input type="checkbox" data-r="incDone" /> Include completed tasks</label>
        <div class="actions">
          <button class="ghost small" data-r="signout">Sign out</button>
          <span class="importer-count" style="flex:1"></span>
          <button class="primary" data-r="go">Import</button>
        </div>
      </div>
    </div>`);
  panel.appendChild(el);

  let flow = null; // current device-code flow: { cancelled, wake }
  let lists = [];
  const cancelFlow = () => { if (flow) { flow.cancelled = true; flow.wake?.(); flow = null; } };
  ctx.cleanup.push(cancelFlow);

  const show = (which) => {
    for (const k of ["signin", "code", "busy", "lists"]) r[k].hidden = k !== which;
  };
  const msg = (text, { error = false, paste = false } = {}) => {
    r.msg.hidden = !text;
    r.msg.textContent = text || "";
    r.msg.classList.toggle("error", error);
    r.pasteLink.hidden = !paste;
  };
  const busy = (text) => { r.busyText.textContent = text; show("busy"); };
  const fail = (e) => {
    if (ctx.closed) return;
    console.warn("To Do import:", e);
    const { text, paste } = explain(e);
    msg(text, { error: true, paste });
    show("signin");
  };
  r.toPaste.addEventListener("click", () => showTab("paste"));

  // ---- Setup form ----
  const presets = ["common", "consumers", "organizations"];
  function fillSetup() {
    const c = config();
    r.client.value = c.clientId;
    const preset = presets.includes(c.tenant);
    r.tenantSel.value = preset ? c.tenant : "custom";
    r.tenantCustom.value = preset ? "" : c.tenant;
    r.tenantCustom.hidden = preset;
    r.setup.open = !c.clientId;
  }
  r.tenantSel.addEventListener("change", () => {
    r.tenantCustom.hidden = r.tenantSel.value !== "custom";
    if (!r.tenantCustom.hidden) r.tenantCustom.focus();
  });
  r.save.addEventListener("click", async () => {
    const clientId = r.client.value.trim();
    const tenant = r.tenantSel.value === "custom" ? r.tenantCustom.value.trim() : r.tenantSel.value;
    if (!P.isGuid(clientId)) return msg("That doesn't look like an Application (client) ID. It should look like 1a2b3c4d-1234-5678-9abc-1234567890ab.", { error: true });
    if (!P.isValidTenant(tenant)) return msg("Enter a tenant ID (a GUID) or a domain like contoso.onmicrosoft.com.", { error: true });
    const before = configKey(config());
    app.settings.set("ms-client-id", clientId);
    app.settings.set("ms-tenant", tenant);
    if (configKey(config()) !== before) { cancelFlow(); await forgetSignIn(); }
    r.setup.open = false;
    msg("");
    start();
  });

  // ---- Sign-in (OAuth 2.0 device code flow) ----
  async function deviceCodeSignIn(c) {
    cancelFlow();
    const my = (flow = { cancelled: false, wake: null });
    const sleep = (ms) => new Promise((ok) => {
      const t = setTimeout(ok, ms);
      my.wake = () => { clearTimeout(t); ok(); };
    });

    busy("Contacting Microsoft…");
    const dc = await postForm(tenantUrl(c, "devicecode"), { client_id: c.clientId, scope: SCOPE });
    if (my.cancelled) return false;
    if (!dc.ok || !dc.body.device_code) throw new AuthError(P.classifyAuthError(dc.body));

    const b = dc.body;
    let uri = b.verification_uri || b.verification_url || "";
    if (!/^https:\/\//i.test(uri)) uri = "https://microsoft.com/devicelogin";
    r.userCode.textContent = b.user_code;
    r.codeHint.textContent = `If the page doesn't open, go to ${uri} yourself and enter the code.`;
    r.copyOpen.onclick = async () => {
      let copied = false;
      try { await navigator.clipboard.writeText(b.user_code); copied = true; } catch {}
      try { await app.openUrl(uri); } catch {}
      r.copyOpen.textContent = copied ? "Copied. Opening sign-in page…" : "Opening sign-in page… (copy the code above)";
    };
    r.copyOpen.textContent = "Copy code & open sign-in page";
    show("code");
    msg("");

    let interval = Math.max(1, Number(b.interval) || 5);
    const deadline = Date.now() + (Number(b.expires_in) || 900) * 1000;
    let netFailures = 0;
    while (true) {
      await sleep(interval * 1000);
      if (my.cancelled) return false;
      if (Date.now() > deadline) throw new AuthError(P.classifyAuthError({ error: "expired_token" }));
      let res;
      try {
        res = await postForm(tenantUrl(c, "token"), { grant_type: DEVICE_GRANT, client_id: c.clientId, device_code: b.device_code });
      } catch (e) {
        if (++netFailures >= 4) throw e; // tolerate brief network blips while waiting
        continue;
      }
      if (my.cancelled) return false;
      netFailures = 0;
      if (res.ok && res.body.access_token) {
        await saveTokens(c, res.body);
        flow = null;
        return true;
      }
      const info = P.classifyAuthError(res.body);
      if (info.kind === "pending") continue;
      if (info.kind === "slow_down") { interval += 5; continue; }
      throw new AuthError(info);
    }
  }

  r.signinBtn.addEventListener("click", async () => {
    const c = config();
    if (!c.clientId) { r.setup.open = true; return msg("Add your Application (client) ID first.", { error: true }); }
    try {
      if (await deviceCodeSignIn(c)) await loadLists(c);
    } catch (e) { fail(e); }
  });
  r.cancel.addEventListener("click", () => { cancelFlow(); msg(""); show("signin"); });
  r.signout.addEventListener("click", async () => {
    await forgetSignIn();
    msg("Signed out. Your saved Microsoft sign-in was removed from this computer.");
    show("signin");
  });

  // ---- Lists & import ----
  async function loadLists(c) {
    busy("Loading your To Do lists…");
    lists = await graphGetAll(c, `${GRAPH}/me/todo/lists`);
    if (ctx.closed) return;
    let remembered = app.settings.get("ms-lists", null);
    if (!Array.isArray(remembered) || !lists.some((l) => remembered.includes(l.id))) remembered = null;
    r.listBox.replaceChildren();
    for (const l of lists) {
      const label = document.createElement("label");
      label.className = "importer-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = l.id;
      // Default: everything except the auto-generated "Flagged email" list.
      cb.checked = remembered ? remembered.includes(l.id) : l.wellknownListName !== "flaggedEmails";
      label.append(cb, " ", l.displayName || "Untitled list");
      if (l.wellknownListName === "defaultList") {
        const tag = document.createElement("span");
        tag.className = "hint";
        tag.textContent = " (default)";
        label.append(tag);
      }
      r.listBox.appendChild(label);
    }
    if (!lists.length) r.listBox.textContent = "No lists found in this account.";
    msg("");
    show("lists");
  }

  r.go.addEventListener("click", async () => {
    const c = config();
    const ids = [...r.listBox.querySelectorAll("input:checked")].map((cb) => cb.value);
    const chosen = lists.filter((l) => ids.includes(l.id));
    if (!chosen.length) return msg("Tick at least one list.", { error: true });
    app.settings.set("ms-lists", ids);
    const includeCompleted = r.incDone.checked;
    try {
      const existing = new Set(app.store.board.tasks.map((t) => t.externalId).filter(Boolean));
      const items = [];
      let dupes = 0;
      for (const [i, list] of chosen.entries()) {
        const name = list.displayName || "Untitled list";
        busy(`Fetching “${name}” (${i + 1} of ${chosen.length})…`);
        const tasks = await fetchListTasks(c, list, includeCompleted, (n) => busy(`Fetching “${name}” (${i + 1} of ${chosen.length}): ${n} tasks…`));
        if (ctx.closed) return;
        for (const t of tasks) {
          if (existing.has(t.id)) { dupes++; continue; }
          existing.add(t.id);
          items.push(P.mapGraphTask(t, name));
        }
      }
      const dupeText = dupes ? `${dupes} already on your canvas` : "";
      if (!items.length) {
        msg(dupes ? `Nothing new to import: ${dupeText}.` : "No tasks found in the chosen lists.");
        return show("lists");
      }
      finishImport(modal, items, dupeText ? ` (${dupeText})` : "");
    } catch (e) {
      if (e instanceof GraphError || e instanceof NetworkError) {
        // Stay on the list view so the user can retry.
        const { text, paste } = explain(e);
        msg(text, { error: true, paste });
        show("lists");
      } else fail(e);
    }
  });

  // ---- Entry point: reuse a saved sign-in if possible ----
  async function start() {
    const c = config();
    if (!c.clientId) {
      msg("Set up your Azure app registration first (it only takes a few minutes).");
      show(null);
      return;
    }
    if (!app.isDesktop) msg("Note: Microsoft sign-in only works in the desktop app, not in a plain browser.");
    try {
      busy("Checking your Microsoft sign-in…");
      await getToken(c);
      await loadLists(c);
    } catch (e) {
      if (ctx.closed) return;
      if (e instanceof NeedSignIn) { show("signin"); return; }
      fail(e);
    }
  }

  fillSetup();
  start();
}
