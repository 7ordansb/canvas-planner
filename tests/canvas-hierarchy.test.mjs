import assert from "node:assert/strict";
import test from "node:test";
import { mergeBoards } from "../src/js/sync-merge.js";

globalThis.window = {};
globalThis.addEventListener = () => {};
globalThis.document = new EventTarget();

globalThis.localStorage = { setItem() {} };
const { normalize, setBoard, descendants, flush, get, update } = await import("../src/js/store.js");

const canvas = (id, canvasId = null) => ({ id, kind: "canvas", canvasId });
const parentIds = (tasks) => Object.fromEntries(tasks.map(({ id, canvasId }) => [id, canvasId]));

test("recovers cards whose parent is missing or is not a canvas", () => {
  const { tasks } = normalize({ tasks: [
    canvas("project"),
    { id: "task", canvasId: "project" },
    { id: "file", kind: "file", canvasId: "missing" },
    canvas("nested", "task"),
  ] });
  assert.deepEqual(parentIds(tasks), { project: null, task: "project", file: null, nested: null });
});

test("breaks a sync-created cycle consistently in either merge order", () => {
  const local = { tasks: [canvas("b"), canvas("a", "b"), { id: "task", canvasId: "b" }] };
  const remote = { tasks: [canvas("b", "a"), canvas("a")] };
  const stamp = (task, updatedAt) => ({ ...task, updatedAt });
  local.tasks = local.tasks.map((task) => stamp(task, task.id === "a" ? "2026-01-02" : "2026-01-01"));
  remote.tasks = remote.tasks.map((task) => stamp(task, task.id === "b" ? "2026-01-02" : "2026-01-01"));
  for (const [first, second] of [[local, remote], [remote, local]]) {
    const board = normalize(mergeBoards(first, second));
    assert.deepEqual(parentIds(board.tasks), { a: null, b: "a", task: "b" });
  }
});

test("repairs self-parenting and keeps descendants reachable", async () => {
  setBoard({ tasks: [canvas("self", "self"), canvas("child", "self"), { id: "task", canvasId: "child" }] });
  assert.deepEqual(descendants("self").map(({ id }) => id), ["child", "task"]);
  await flush();
});

test("checklist completion stays consistent after loading and editing a legacy task", async () => {
  const items = [{ id: "item-1", title: "First", done: true }, { id: "item-2", title: "Second", done: false }];
  setBoard({ tasks: [{ id: "task", kind: "task", completedAt: "2026-01-01", checklist: items }] });
  assert.equal(get("task").completedAt, null);
  update("task", { checklist: items.map((item) => ({ ...item, done: true })) });
  const completedAt = get("task").completedAt;
  assert.ok(completedAt);
  update("task", { title: "New title" });
  assert.equal(get("task").completedAt, completedAt);
  update("task", { checklist: items });
  assert.equal(get("task").completedAt, null);
  await flush();
});
