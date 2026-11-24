// Run: node tests/import-parse.test.mjs
process.env.TZ = "Europe/Berlin"; // fixed zone for the Graph due-date tests

import assert from "node:assert/strict";
const P = await import("../src/js/import-parse.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`); }
}
const today = new Date(2026, 10, 24); // 24 Nov 2026

// ---------------- Paste ----------------
test("strips bullets, numbers and checkboxes; skips blanks", () => {
  const items = P.parsePasteList("- one\n* two\n• three\n1. four\n2) five\n[ ] six\n- [ ] seven\n\n   \n+ eight\n—\n---", today);
  assert.deepEqual(items.map((i) => i.title), ["one", "two", "three", "four", "five", "six", "seven", "eight"]);
  assert.ok(items.every((i) => !i.done && i.due === null));
});
test("ticked items are marked done", () => {
  const items = P.parsePasteList("[x] a\n- [X] b\n[ ] c", today);
  assert.deepEqual(items.map((i) => [i.title, i.done]), [["a", true], ["b", true], ["c", false]]);
});
test("does not eat leading numbers or hyphens that aren't bullets", () => {
  const items = P.parsePasteList("1.5 hours of review\n-5 degrees check\n2026 planning", today);
  assert.deepEqual(items.map((i) => i.title), ["1.5 hours of review", "-5 degrees check", "2026 planning"]);
});
test("ISO date anywhere becomes due date", () => {
  const [a] = P.parsePasteList("- Pay rent 2026-12-03", today);
  assert.equal(a.title, "Pay rent"); assert.equal(a.due, "2026-12-03");
});
test("due: d/m (day first), year inferred", () => {
  const [a, b, c] = P.parsePasteList("Send report (due: 3/12)\nTax return due 31/1\nOld thing due: 1/11", today);
  assert.deepEqual([a.title, a.due], ["Send report", "2026-12-03"]);
  assert.deepEqual([b.title, b.due], ["Tax return", "2027-01-31"]);  // long past -> next year
  assert.deepEqual([c.title, c.due], ["Old thing", "2026-11-01"]);   // under 2 months ago -> this year
});
test("due with explicit year and invalid dates", () => {
  assert.equal(P.parsePasteList("x due: 3/12/27", today)[0].due, "2027-12-03");
  const [bad] = P.parsePasteList("Thing 2026-02-30", today);
  assert.equal(bad.due, null); assert.equal(bad.title, "Thing 2026-02-30");
});
test("CRLF input", () => {
  assert.equal(P.parsePasteList("a\r\nb\r\n\r\nc", today).length, 3);
});

// ---------------- CSV ----------------
test("basic CSV with quotes, escaped quotes, commas and newlines inside quotes", () => {
  const { rows, delimiter } = P.parseCSV('Title,Notes\n"Hello, world","He said ""hi""\nsecond line"\nplain,x\n');
  assert.equal(delimiter, ",");
  assert.deepEqual(rows, [["Title", "Notes"], ["Hello, world", 'He said "hi"\nsecond line'], ["plain", "x"]]);
});
test("CRLF, BOM, trailing blank lines, empty fields", () => {
  const { rows } = P.parseCSV("﻿a,b,c\r\n1,,3\r\n,,\r\n\r\n4,5,\r\n");
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "", "3"], ["4", "5", ""]]);
});
test("no trailing newline; quoted empty last field", () => {
  assert.deepEqual(P.parseCSV('a,b\n1,""').rows, [["a", "b"], ["1", ""]]);
});
test("semicolon delimiter detection (European Excel)", () => {
  const { rows, delimiter } = P.parseCSV('Title;Due;Notes\n"A; with semi";03/12/2026;"x, y"\n');
  assert.equal(delimiter, ";");
  assert.deepEqual(rows[1], ["A; with semi", "03/12/2026", "x, y"]);
});
test("commas inside quotes don't fool delimiter detection", () => {
  assert.equal(P.detectDelimiter('"a,b,c,d";x;y\n'), ";");
  assert.equal(P.detectDelimiter("a,b\n"), ",");
  assert.equal(P.detectDelimiter("a\tb\tc\n"), "\t");
});
test("Excel sep= line", () => {
  const { rows, delimiter } = P.parseCSV("sep=;\r\nTitle;Notes\r\nA;B\r\n");
  assert.equal(delimiter, ";");
  assert.deepEqual(rows, [["Title", "Notes"], ["A", "B"]]);
});
test("CR-only line endings", () => {
  assert.deepEqual(P.parseCSV("a,b\r1,2\r").rows, [["a", "b"], ["1", "2"]]);
});

test("guessMapping: common header names", () => {
  assert.deepEqual(P.guessMapping(["Subject", "Due Date", "Body", "Status"]), { title: 0, notes: 2, due: 1, completed: 3 });
  assert.deepEqual(P.guessMapping(["Task Name", "DueDate", "Description", "Done"]), { title: 0, notes: 2, due: 1, completed: 3 });
  assert.deepEqual(P.guessMapping(["Name", "Details", "Due", "Complete"]), { title: 0, notes: 1, due: 2, completed: 3 });
  assert.deepEqual(P.guessMapping(["Foo", "Bar"]), { title: -1, notes: -1, due: -1, completed: -1 });
});
test("guessMapping prefers exact match over prefix", () => {
  // "Title (old)" is a prefix match; "Title" is exact.
  assert.equal(P.guessMapping(["Title (old)", "Title"]).title, 1);
});

// ---------------- Dates ----------------
test("parseDate in each format", () => {
  assert.equal(P.parseDate("2026-12-03"), "2026-12-03");
  assert.equal(P.parseDate("2026-12-03T00:00:00Z", "mdy"), "2026-12-03");
  assert.equal(P.parseDate("03/12/2026", "dmy"), "2026-12-03");
  assert.equal(P.parseDate("12/03/2026", "mdy"), "2026-12-03");
  assert.equal(P.parseDate("3.12.26 09:30", "dmy"), "2026-12-03");
  assert.equal(P.parseDate("31/02/2026", "dmy"), null);
  assert.equal(P.parseDate("", "dmy"), null);
  assert.equal(P.parseDate("next week", "dmy"), null);
  assert.equal(P.parseDate("03/12/2026", "ymd"), null);
});
test("detectDateFormat picks the unambiguous one, falls back to DD/MM", () => {
  assert.equal(P.detectDateFormat(["2026-01-02", "", "2026-12-31"]), "ymd");
  assert.equal(P.detectDateFormat(["01/02/2026", "25/12/2026"]), "dmy");
  assert.equal(P.detectDateFormat(["01/02/2026", "12/25/2026"]), "mdy");
  assert.equal(P.detectDateFormat(["01/02/2026", "03/04/2026"]), "dmy"); // ambiguous
  assert.equal(P.detectDateFormat([]), "dmy");
});
test("isCompletedValue", () => {
  for (const v of ["Completed", "done", "Yes", "TRUE", "1", "x", "12/03/2026"]) assert.ok(P.isCompletedValue(v), v);
  for (const v of ["", "Not started", "In progress", "No", "false", "0", "Not completed"]) assert.ok(!P.isCompletedValue(v), v);
});
test("csvToTasks: mapping, auto dates, skip completed, empty titles", () => {
  const { rows } = P.parseCSV("Subject,Due Date,Notes,Status\nA,12/25/2026,n1,Not started\nB,01/02/2026,,Completed\n,01/01/2026,orphan,\nC,,,In progress\n");
  const m = P.guessMapping(rows[0]);
  const r1 = P.csvToTasks(rows, m);
  assert.equal(r1.dateFormat, "mdy");
  assert.deepEqual(r1.tasks.map((t) => [t.title, t.due, t.notes, t.done, t.source]), [
    ["A", "2026-12-25", "n1", false, "CSV"], ["C", null, "", false, "CSV"],
  ]);
  const r2 = P.csvToTasks(rows, m, { skipCompleted: false, dateFormat: "mdy" });
  assert.deepEqual(r2.tasks.map((t) => [t.title, t.due, t.done]), [["A", "2026-12-25", false], ["B", "2026-01-02", true], ["C", null, false]]);
});
test("csvToTasks: short rows and no due column", () => {
  const rows = [["Title", "Notes"], ["Only title"]];
  const { tasks } = P.csvToTasks(rows, { title: 0, notes: 1, due: -1, completed: -1 });
  assert.deepEqual(tasks, [{ title: "Only title", notes: "", due: null, done: false, source: "CSV" }]);
});

// ---------------- Graph ----------------
test("stripHtml", () => {
  const html = '<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>there</b> &amp; you</p><div>Line&#39;2<br>Line 3</div><ul><li>a</li><li>b</li></ul></body></html>';
  assert.equal(P.stripHtml(html), "Hello there & you\nLine'2\nLine 3\n• a\n• b");
  assert.equal(P.stripHtml(""), "");
  assert.equal(P.stripHtml("&#x1F600; &unknown;"), "😀 &unknown;");
});
test("graphDueDate: midnight date part, UTC-shifted midnight converted to local", () => {
  assert.equal(P.graphDueDate({ dateTime: "2026-12-03T00:00:00.0000000", timeZone: "UTC" }), "2026-12-03");
  // Midnight in Berlin (UTC+1 in December) arrives as 23:00 UTC the day before.
  assert.equal(P.graphDueDate({ dateTime: "2026-12-02T23:00:00.0000000", timeZone: "UTC" }), "2026-12-03");
  assert.equal(P.graphDueDate({ dateTime: "2026-12-03T05:00:00.0000000", timeZone: "Eastern Standard Time" }), "2026-12-03");
  assert.equal(P.graphDueDate(undefined), null);
  assert.equal(P.graphDueDate({}), null);
});
test("mapGraphTask: open task with HTML body", () => {
  const t = P.mapGraphTask({
    id: "AAMk1", title: " Buy milk ", status: "notStarted",
    body: { content: "<p>2 litres</p>", contentType: "html" },
    dueDateTime: { dateTime: "2026-12-03T00:00:00.0000000", timeZone: "UTC" },
  }, "Groceries");
  assert.deepEqual(t, {
    title: "Buy milk", notes: "2 litres", due: "2026-12-03", done: false, completedAt: null,
    source: "To Do", externalId: "AAMk1", externalList: "Groceries",
  });
});
test("mapGraphTask: completed task, text body, no due", () => {
  const t = P.mapGraphTask({
    id: "id2", title: "", status: "completed", body: { content: " <b>raw</b> ", contentType: "text" },
    completedDateTime: { dateTime: "2026-11-20T00:00:00.0000000", timeZone: "UTC" },
  }, "Tasks");
  assert.equal(t.title, "Untitled");
  assert.equal(t.notes, "<b>raw</b>");
  assert.equal(t.due, null);
  assert.equal(t.done, true);
  assert.equal(t.completedAt, "2026-11-20T00:00:00.000Z");
});
test("classifyAuthError", () => {
  const k = (b) => P.classifyAuthError(b).kind;
  assert.equal(k({ error: "authorization_pending" }), "pending");
  assert.equal(k({ error: "slow_down" }), "slow_down");
  assert.equal(k({ error: "expired_token" }), "expired");
  assert.equal(k({ error: "authorization_declined" }), "declined");
  assert.equal(k({ error: "bad_verification_code" }), "bad_code");
  assert.equal(k({ error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented", error_codes: [65001] }), "consent");
  assert.equal(k({ error: "invalid_request", error_description: "AADSTS90094: Admin approval required" }), "consent");
  assert.equal(k({ error: "unauthorized_client", error_codes: [700016] }), "invalid_client");
  assert.equal(k({ error: "invalid_client", error_codes: [7000218] }), "public_client");
  assert.equal(k({ error: "invalid_request", error_codes: [9002326] }), "origin");
  assert.equal(k({ error: "invalid_request", error_codes: [9002331] }), "tenant");
  assert.equal(k({ error: "invalid_grant", error_codes: [70000] }), "invalid_grant");
  assert.equal(k({}), "other");
  assert.match(P.classifyAuthError({ error_codes: [65001] }).message, /IT/);
});
test("isGuid / isValidTenant", () => {
  assert.ok(P.isGuid("1a2b3c4d-1234-5678-9abc-1234567890ab"));
  assert.ok(!P.isGuid("not-a-guid"));
  for (const t of ["common", "consumers", "contoso.onmicrosoft.com", "1a2b3c4d-1234-5678-9abc-1234567890ab"]) assert.ok(P.isValidTenant(t), t);
  for (const t of ["", "a/b", "x y", "../x"]) assert.ok(!P.isValidTenant(t), t);
});

test("due: prefix before an ISO date is stripped from the title", () => {
  const [item] = P.parsePasteList("* Update roadmap due: 2026-12-01");
  assert.equal(item.title, "Update roadmap");
  assert.equal(item.due, "2026-12-01");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

