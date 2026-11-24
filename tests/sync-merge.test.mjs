// Run with: node tests/sync-merge.test.mjs
import assert from "node:assert/strict";
import {
  mergeBoards, sameBoard, canonicalJSON, encodeBase64Utf8, decodeBase64Utf8, TOMBSTONE_TTL_MS,
} from "../src/js/sync-merge.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
const task = (id, updatedMin, extra = {}) => ({
  id, title: id, notes: "", x: 0, y: 0, due: null,
  createdAt: at(-1000), updatedAt: at(updatedMin), completedAt: null, ...extra,
});
const board = (tasks = [], deleted = {}) => ({ version: 1, tasks, deleted });
const merge = (a, b) => mergeBoards(a, b, { now: NOW });
const ids = (b) => b.tasks.map((t) => t.id);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n${e.stack}`); }
}

/** Every test checks idempotence on the side too. */
function checkIdempotent(a, b) {
  const m = merge(a, b);
  assert.deepEqual(merge(m, b), m, "merge(merge(a,b), b) should equal merge(a,b)");
  assert.deepEqual(merge(m, m), m, "merge(m, m) should equal m");
  return m;
}

console.log("sync-merge");

test("both empty", () => {
  const m = checkIdempotent(board(), board());
  assert.deepEqual(m, board());
});

test("remote missing (null / undefined) keeps local", () => {
  const local = board([task("a", 0), task("b", 1)], { z: at(-5) });
  for (const remote of [null, undefined]) {
    const m = merge(local, remote);
    assert.deepEqual(m, local);
    assert.deepEqual(merge(m, remote), m);
  }
});

test("local empty takes everything from remote", () => {
  const remote = board([task("a", 0), task("b", 1)]);
  const m = checkIdempotent(board(), remote);
  assert.deepEqual(m, remote);
});

test("garbage inputs don't throw", () => {
  const m = merge({ tasks: "nope", deleted: [] }, { tasks: [null, { title: "no id" }, task("a", 0)] });
  assert.deepEqual(ids(m), ["a"]);
  assert.deepEqual(m.deleted, {});
});

test("edits on both sides: newer updatedAt wins per task, as a whole", () => {
  const local = board([task("a", 10, { title: "local A" }), task("b", 1, { title: "local B", notes: "ln" })]);
  const remote = board([task("a", 5, { title: "remote A", notes: "rn" }), task("b", 2, { title: "remote B" })]);
  const m = checkIdempotent(local, remote);
  assert.equal(m.tasks[0].title, "local A");
  assert.equal(m.tasks[0].notes, "", "whole task wins, fields aren't mixed");
  assert.equal(m.tasks[1].title, "remote B");
  assert.equal(m.tasks[1].notes, "");
});

test("extra fields on tasks are preserved", () => {
  const m = merge(board([task("a", 0, { source: "To Do", externalId: "x1" })]), board());
  assert.equal(m.tasks[0].source, "To Do");
  assert.equal(m.tasks[0].externalId, "x1");
});

test("exact timestamp tie is deterministic and symmetric", () => {
  const l = board([task("a", 0, { title: "L" })]);
  const r = board([task("a", 0, { title: "R" })]);
  const m1 = checkIdempotent(l, r);
  const m2 = checkIdempotent(r, l);
  assert.deepEqual(m1.tasks[0], m2.tasks[0], "both devices pick the same winner");
});

test("delete on one side removes the task (other side unchanged since)", () => {
  const local = board([task("b", 0)], { a: at(5) });
  const remote = board([task("a", 0), task("b", 0)]);
  const m = checkIdempotent(local, remote);
  assert.deepEqual(ids(m), ["b"]);
  assert.deepEqual(m.deleted, { a: at(5) });
  // And the mirror: deleted remotely, still present locally.
  const m2 = checkIdempotent(remote, local);
  assert.deepEqual(ids(m2), ["b"]);
  assert.deepEqual(m2.deleted, { a: at(5) });
});

test("delete vs edit: edit after deletion survives and tombstone is dropped", () => {
  const local = board([], { a: at(5) });
  const remote = board([task("a", 10, { title: "edited later" })]);
  const m = checkIdempotent(local, remote);
  assert.deepEqual(ids(m), ["a"]);
  assert.equal(m.tasks[0].title, "edited later");
  assert.deepEqual(m.deleted, {});
});

test("delete vs edit: deletion after edit wins", () => {
  const local = board([], { a: at(10) });
  const remote = board([task("a", 5)]);
  const m = checkIdempotent(local, remote);
  assert.deepEqual(ids(m), []);
  assert.deepEqual(m.deleted, { a: at(10) });
});

test("delete at exactly the same time as the edit counts as deleted", () => {
  const m = checkIdempotent(board([], { a: at(5) }), board([task("a", 5)]));
  assert.deepEqual(ids(m), []);
});

test("tombstones combine keeping the newest deletedAt", () => {
  const m = checkIdempotent(board([], { a: at(1), b: at(9) }), board([], { a: at(7), b: at(3), c: at(2) }));
  assert.deepEqual(m.deleted, { a: at(7), b: at(9), c: at(2) });
});

test("tombstones older than 60 days are pruned", () => {
  const old = new Date(NOW - TOMBSTONE_TTL_MS - 60_000).toISOString();
  const recent = new Date(NOW - TOMBSTONE_TTL_MS + 60_000).toISOString();
  const m = checkIdempotent(board([], { a: old, b: recent }), board([], { c: old }));
  assert.deepEqual(m.deleted, { b: recent });
});

test("an expired tombstone is kept while a stale copy of the task still exists", () => {
  const old = new Date(NOW - TOMBSTONE_TTL_MS - 60_000).toISOString();
  const staleTask = { ...task("a", 0), updatedAt: new Date(Date.parse(old) - 1000).toISOString() };
  const remote = board([staleTask]);
  const m = merge(board([], { a: old }), remote);
  assert.deepEqual(merge(m, remote), m, "idempotent against the stale remote");
  assert.deepEqual(ids(m), [], "old tombstone still deletes an older copy");
  assert.deepEqual(m.deleted, { a: old }, "kept so the stale copy can't come back");
  // Once the remote has been overwritten with the merge result, it's pruned.
  const m2 = merge(m, m);
  assert.deepEqual(m2.deleted, {});
  assert.deepEqual(merge(m2, m), m2);
});

test("order: local order kept, remote-only appended in remote order", () => {
  const local = board([task("c", 0), task("a", 0), task("x", 0)]);
  const remote = board([task("r2", 0), task("a", 3), task("r1", 0), task("c", 0)]);
  const m = checkIdempotent(local, remote);
  assert.deepEqual(ids(m), ["c", "a", "x", "r2", "r1"]);
});

test("result shares no objects with inputs", () => {
  const local = board([task("a", 0)]);
  const m = merge(local, null);
  m.tasks[0].title = "changed";
  m.deleted.zz = at(0);
  assert.equal(local.tasks[0].title, "a");
  assert.deepEqual(local.deleted, {});
});

test("idempotence across a mixed scenario", () => {
  const a = board(
    [task("1", 5), task("2", 1, { title: "😀 local" }), task("4", 0)],
    { "3": at(2), "5": at(1), "6": at(-1) },
  );
  const b = board(
    [task("2", 3, { title: "remote" }), task("3", 1), task("5", 4), task("7", 0)],
    { "1": at(1), "4": at(6) },
  );
  const m = checkIdempotent(a, b);
  assert.deepEqual(ids(m), ["1", "2", "5", "7"]);
  assert.equal(m.tasks[1].title, "remote");
  assert.deepEqual(m.deleted, { "3": at(2), "4": at(6), "6": at(-1) });
  // Converges: the other device merging the result ends up with the same content.
  assert.ok(sameBoard(merge(b, m), m, { ignoreTaskOrder: true }));
});

test("sameBoard ignores key order, optionally task order", () => {
  const a = { version: 1, tasks: [{ id: "a", title: "x" }, { id: "b" }], deleted: { q: "1", r: "2" } };
  const b = { deleted: { r: "2", q: "1" }, tasks: [{ title: "x", id: "a" }, { id: "b" }], version: 1 };
  const c = { ...b, tasks: [b.tasks[1], b.tasks[0]] };
  assert.ok(sameBoard(a, b));
  assert.ok(!sameBoard(a, c));
  assert.ok(sameBoard(a, c, { ignoreTaskOrder: true }));
  assert.ok(!sameBoard(a, { ...a, tasks: [{ id: "a", title: "y" }, { id: "b" }] }, { ignoreTaskOrder: true }));
  assert.ok(!sameBoard(a, null));
  assert.equal(canonicalJSON({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("base64 UTF-8 round trip with emoji and accents", () => {
  const text = JSON.stringify(board([task("a", 0, { title: "Café ☕ 😀 日本語 👩‍💻" })]), null, 1);
  const b64 = encodeBase64Utf8(text);
  assert.equal(decodeBase64Utf8(b64), text);
  // GitHub wraps base64 at 60 chars with newlines.
  assert.equal(decodeBase64Utf8(b64.replace(/(.{60})/g, "$1\n")), text);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), text, "matches node's own decoder");
  const big = "😀".repeat(100_000);
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(big)), big, "large input doesn't blow the stack");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
