// Pure parsing helpers for the importer: pasted lists, CSV, dates, and
// Microsoft Graph (To Do) task mapping. No DOM here, so it runs in node tests.

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/** True if y-m-d is a real calendar date. */
export function isValidDate(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const fullYear = (y) => (y < 100 ? 2000 + y : y);

// ---------------------------------------------------------------- Paste ----

// One leading marker: a bullet, a number ("1." / "1)"), or a checkbox ("[ ]" / "[x]").
const MARKER = /^(?:[•‣◦▪●]|[-*+–—](?=\s)|\d{1,3}[.)](?=\s)|\[[ xX✓✔]?\])\s*/;

/**
 * Find a due date in a pasted line: an ISO date anywhere (2026-12-03), or
 * "due: 3/12" / "due 3/12/2026" (day first). A date without a year means the
 * next time that day comes round (allowing two months of "overdue").
 * Returns { due, rest } where rest is the line with the date text removed.
 */
export function extractDue(line, today = new Date()) {
  let m = line.match(/(?:\bdue\s*:?\s*)?\b(\d{4})-(\d{1,2})-(\d{1,2})\b/i); // optional "due:" prefix is removed too
  if (m && isValidDate(+m[1], +m[2], +m[3])) {
    return { due: isoOf(+m[1], +m[2], +m[3]), rest: cleanAfterRemoval(line, m) };
  }
  m = line.match(/\bdue\s*:?\s*(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/i);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? fullYear(+m[3]) : today.getFullYear();
    if (!m[3]) {
      const candidate = new Date(y, mo - 1, d);
      if (today - candidate > 60 * 86400000) y += 1; // long past: means next year
    }
    if (isValidDate(y, mo, d)) return { due: isoOf(y, mo, d), rest: cleanAfterRemoval(line, m) };
  }
  return { due: null, rest: line };
}

function cleanAfterRemoval(line, m) {
  return (line.slice(0, m.index) + " " + line.slice(m.index + m[0].length))
    .replace(/[([{]\s*[)\]}]/g, " ")          // empty brackets left behind: "(due: 3/12)"
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "") // dangling separators
    .trim();
}

/**
 * Parse a pasted list, one task per line.
 * @returns {{title: string, due: string|null, done: boolean}[]}
 */
export function parsePasteList(text, today = new Date()) {
  const items = [];
  for (const raw of String(text ?? "").split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    let done = false;
    // Strip up to a few stacked markers, e.g. "- [x] 1. Thing".
    for (let i = 0; i < 3; i++) {
      const m = line.match(MARKER);
      if (!m) break;
      if (/^\[[xX✓✔]\]/.test(m[0])) done = true;
      line = line.slice(m[0].length);
    }
    line = line.trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue; // blank, or just "---"
    const { due, rest } = extractDue(line, today);
    const title = rest || line;
    items.push({ title, due, done });
  }
  return items;
}

// ------------------------------------------------------------------ CSV ----

/** Guess the delimiter from the first line (outside quotes): ; , or tab. */
export function detectDelimiter(text) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * RFC 4180-style CSV parser: quoted fields, "" escapes, delimiters and
 * newlines inside quotes, CRLF/CR/LF, a leading BOM, and Excel's "sep=;" line.
 * @returns {{rows: string[][], delimiter: string}}
 */
export function parseCSV(text, delimiter) {
  text = String(text ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const sep = text.match(/^sep=(.)\r?\n/i);
  if (sep) { delimiter = delimiter || sep[1]; text = text.slice(sep[0].length); }
  delimiter = delimiter || detectDelimiter(text);

  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (field !== "" || row.length) endRow();
  // Drop fully blank rows (e.g. trailing empty lines).
  return { rows: rows.filter((r) => r.some((c) => c.trim() !== "")), delimiter };
}

const HEADER_NAMES = {
  title: ["title", "subject", "task", "name", "taskname", "tasktitle"],
  notes: ["notes", "note", "body", "description", "details", "content"],
  due: ["due", "duedate", "dueon", "deadline", "dueby"],
  completed: ["status", "completed", "complete", "done", "datecompleted", "completeddate", "iscompleted"],
};

const normHeader = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guess which column holds each field. Exact header matches win, then
 * headers that start with a known name ("Due Date (UTC)").
 * @returns {{title:number, notes:number, due:number, completed:number}} -1 = none
 */
export function guessMapping(headers) {
  const norm = headers.map(normHeader);
  const used = new Set();
  const out = {};
  for (const field of Object.keys(HEADER_NAMES)) {
    const names = HEADER_NAMES[field];
    let idx = -1;
    for (const n of names) {
      idx = norm.findIndex((h, i) => h === n && !used.has(i));
      if (idx >= 0) break;
    }
    if (idx < 0) {
      for (const n of names) {
        idx = norm.findIndex((h, i) => h.startsWith(n) && !used.has(i));
        if (idx >= 0) break;
      }
    }
    if (idx >= 0) used.add(idx);
    out[field] = idx;
  }
  return out;
}

// Splits "12/03/2026", "2026-03-12", "12.03.26 09:00", "2026-03-12T00:00:00Z".
function dateParts(s) {
  const m = String(s ?? "").trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:$|[\sT])/);
  return m ? [+m[1], +m[2], +m[3], m[1].length] : null;
}

/**
 * Parse one date cell. format: "ymd" | "dmy" | "mdy".
 * @returns {string|null} 'YYYY-MM-DD'
 */
export function parseDate(s, format = "dmy") {
  const p = dateParts(s);
  if (!p) return null;
  const [a, b, c, aLen] = p;
  let y, m, d;
  if (aLen === 4) [y, m, d] = [a, b, c];          // year first is never ambiguous
  else if (format === "mdy") [m, d, y] = [a, b, fullYear(c)];
  else if (format === "ymd") return null;
  else [d, m, y] = [a, b, fullYear(c)];
  return isValidDate(y, m, d) ? isoOf(y, m, d) : null;
}

/**
 * Pick the date format for a whole column: the one that is unambiguous
 * across all values, falling back to DD/MM.
 */
export function detectDateFormat(values) {
  let dmyOk = true, mdyOk = true, any = false, allYearFirst = true;
  for (const v of values) {
    const p = dateParts(v);
    if (!p) continue;
    any = true;
    if (p[3] === 4) continue;
    allYearFirst = false;
    if (!parseDate(v, "dmy")) dmyOk = false;
    if (!parseDate(v, "mdy")) mdyOk = false;
  }
  if (any && allYearFirst) return "ymd";
  if (mdyOk && !dmyOk) return "mdy";
  return "dmy";
}

const DONE_WORDS = new Set(["completed", "complete", "done", "yes", "y", "true", "1", "x", "finished", "closed", "resolved", "✓", "✔"]);

/** Is this "completed" cell a yes? A date in it (e.g. "Date Completed") also counts. */
export function isCompletedValue(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return DONE_WORDS.has(s) || !!dateParts(s);
}

/**
 * Turn CSV rows (first row = headers) into tasks for app.addTasks.
 * Completed rows get `done: true`; the caller decides whether to keep them.
 */
export function csvToTasks(rows, mapping, { dateFormat = "auto", skipCompleted = true } = {}) {
  const body = rows.slice(1);
  const cell = (r, i) => (i >= 0 && i < r.length ? r[i].trim() : "");
  const fmt = dateFormat === "auto" ? detectDateFormat(body.map((r) => cell(r, mapping.due))) : dateFormat;
  const tasks = [];
  for (const r of body) {
    const title = cell(r, mapping.title);
    if (!title) continue;
    const done = isCompletedValue(cell(r, mapping.completed));
    if (done && skipCompleted) continue;
    tasks.push({
      title,
      notes: cell(r, mapping.notes),
      due: parseDate(cell(r, mapping.due), fmt),
      done,
      source: "CSV",
    });
  }
  return { tasks, dateFormat: fmt };
}

// ---------------------------------------------------- Microsoft Graph ----

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Very small HTML-to-text for To Do note bodies (no DOM needed). */
export function stripHtml(html) {
  return String(html ?? "")
    .replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Graph dateTimeTimeZone -> 'YYYY-MM-DD'. To Do stores due dates as midnight
 * in the user's zone; Graph may return that converted to UTC (e.g.
 * 22:00 the day before for UTC+2). If the time isn't midnight and the zone is
 * UTC, convert to the local calendar date; otherwise take the date part.
 */
export function graphDueDate(dt) {
  const s = dt?.dateTime;
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const isMidnight = !m[4] || (m[4] === "00" && m[5] === "00");
  const tz = String(dt.timeZone || "UTC").toUpperCase();
  if (!isMidnight && (tz === "UTC" || tz === "Z")) {
    const local = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    return isoOf(local.getFullYear(), local.getMonth() + 1, local.getDate());
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Map one Graph todoTask to a canvas task (plus completedAt for done ones). */
export function mapGraphTask(t, listName) {
  const body = t.body || {};
  const notes = String(body.contentType).toLowerCase() === "html" ? stripHtml(body.content) : String(body.content ?? "").trim();
  const done = t.status === "completed";
  let completedAt = null;
  if (done) {
    const c = t.completedDateTime?.dateTime;
    const parsed = c ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(c) ? c : c + "Z") : NaN;
    completedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }
  return {
    title: String(t.title ?? "").trim() || "Untitled",
    notes,
    due: graphDueDate(t.dueDateTime),
    done,
    completedAt,
    source: "To Do",
    externalId: t.id,
    externalList: listName,
  };
}

/**
 * Explain a Microsoft identity platform error in plain words.
 * Input: the parsed JSON error body ({error, error_description, error_codes}).
 * @returns {{kind: string, message: string}}
 */
export function classifyAuthError(body) {
  const err = String(body?.error ?? "");
  const desc = String(body?.error_description ?? "");
  const codes = (body?.error_codes ?? []).map(String);
  const has = (code) => codes.includes(code) || desc.includes(`AADSTS${code}`);
  const pasteTip = " You can still bring tasks in with the Paste tab.";

  // Device-code polling states (not real errors).
  if (err === "authorization_pending") return { kind: "pending", message: "" };
  if (err === "slow_down") return { kind: "slow_down", message: "" };
  if (err === "expired_token" || has("70020")) return { kind: "expired", message: "The sign-in code expired. Click Sign in to get a new one." };
  if (err === "authorization_declined" || has("70019") || has("65004")) return { kind: "declined", message: "Sign-in was cancelled or permission was declined." };
  if (err === "bad_verification_code") return { kind: "bad_code", message: "Microsoft didn't recognise the sign-in code. Click Sign in to try again." };

  if (has("65001") || has("90094") || has("90095") || has("90099") || /admin (consent|approval)/i.test(desc)) {
    return { kind: "consent", message: "Your organisation's IT needs to approve this app before it can read your To Do tasks. Ask them to grant admin consent for your app registration, or use the Paste tab instead." };
  }
  if (has("53003") || has("53000") || has("53001") || has("50105") || has("530003")) {
    return { kind: "blocked", message: "Your organisation's sign-in rules blocked this app (for example, it may only allow approved apps or managed devices)." + pasteTip };
  }
  if (has("9002326")) {
    return { kind: "origin", message: "Microsoft refused the request because the app sent a browser \"Origin\" header. This needs a small fix in the app itself (see IMPORT.md, Troubleshooting)." + pasteTip };
  }
  if (has("7000218") || has("700025")) {
    return { kind: "public_client", message: "Your app registration doesn't allow this kind of sign-in. In the Azure portal, open the app → Authentication, set \"Allow public client flows\" to Yes, and save." };
  }
  if (has("700016") || has("900023") || has("700038") || err === "invalid_client") {
    return { kind: "invalid_client", message: "Microsoft doesn't recognise that Application (client) ID. Check you copied the right ID, and that the tenant setting matches where you registered the app." };
  }
  if (has("9002331")) return { kind: "tenant", message: "Your app is set up for personal Microsoft accounts only. Change the tenant setting to \"consumers\"." };
  if (has("50194")) return { kind: "tenant", message: "Your app is set up for one organisation only. Set the tenant to your organisation's tenant ID or domain instead of \"common\"/\"organizations\"." };
  if (has("50020") || err === "unauthorized_client") {
    return { kind: "account_type", message: "This account type isn't allowed by your app registration (for example, a personal account on a work-only app). Check \"Supported account types\" in the Azure portal, or the tenant setting here." };
  }
  if (has("90002") || has("90013") || has("900971")) return { kind: "tenant", message: "Microsoft couldn't find that tenant. Check the tenant setting (try \"common\")." };
  if (has("50076") || has("50079")) return { kind: "mfa", message: "Extra verification is required. Try signing in again and complete the multi-factor prompt." };
  if (err === "invalid_grant") return { kind: "invalid_grant", message: "Your saved sign-in has expired. Please sign in again." };
  if (err === "invalid_scope") return { kind: "scope", message: "The app registration doesn't allow the Tasks.Read permission. Add it under API permissions." };
  const short = desc.split(/\r?\n/)[0] || err || "Unknown error";
  return { kind: "other", message: `Microsoft sign-in failed: ${short}` };
}

/** Looks like a GUID (the shape of an Application (client) ID). */
export const isGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s).trim());

/** Tenant is "common"/"consumers"/"organizations", a GUID, or a domain. */
export const isValidTenant = (s) => /^[a-z0-9][a-z0-9.-]{0,254}$/i.test(String(s).trim());
