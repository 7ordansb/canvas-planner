import assert from "node:assert/strict";
import test from "node:test";
import { changeTimer, normalizeTimer, timerReading, timerText } from "../src/js/timer.js";

test("a countdown retains fractional elapsed time across pause and reset", () => {
  let timer = normalizeTimer({ mode: "countdown", limit: 3 });
  timer = changeTimer(timer, "toggle", 1000);
  timer = changeTimer(timer, "toggle", 1750);
  assert.equal(timerReading(timer, 9000).value, 3);
  timer = changeTimer(timer, "toggle", 10000);
  assert.equal(timerReading(timer, 10250).value, 2);
  assert.equal(timerReading(timer, 12250).finished, true);
  assert.equal(timerReading(timer, 20000).value, 0);
  timer = changeTimer(timer, "reset", 20000);
  assert.equal(timerReading(timer, 30000).value, 3);
  assert.equal(timerReading(timer, 30000).running, false);
});

test("number counters stop at their bounds and can restart", () => {
  for (const [mode, starting, final] of [["count-up", 0, 5], ["count-down", 5, 0]]) {
    const timer = normalizeTimer({ mode, limit: 5, startedAt: 1000 });
    assert.equal(timerReading(timer, 500).value, starting);
    assert.equal(timerReading(timer, 9000).value, final);
    assert.equal(timerReading(timer, 9000).running, false);
    assert.equal(timerReading(changeTimer(timer, "toggle", 9000), 9000).value, starting);
  }
});

test("a stopwatch reads elapsed time after the board is reloaded", () => {
  const timer = normalizeTimer({ mode: "elapsed", limit: 60, startedAt: 1000 });
  const loaded = normalizeTimer(JSON.parse(JSON.stringify(timer)));
  const reading = timerReading(loaded, 3662000);
  assert.equal(reading.running, true);
  assert.equal(timerText(loaded.mode, reading.value), "01:01:01");
});
