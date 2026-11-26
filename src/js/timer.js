export const TIMER_MODES = {
  elapsed: "Stopwatch",
  countdown: "Countdown",
  "count-up": "Count up to a number",
  "count-down": "Count down from a number",
};

export const MAX_TIMER_LIMIT = 9_999_999;

export function normalizeTimer(value) {
  const mode = Object.hasOwn(TIMER_MODES, value?.mode) ? value.mode : "countdown";
  const limit = Number.isFinite(value?.limit) ? Math.min(MAX_TIMER_LIMIT, Math.max(1, Math.floor(value.limit))) : 60;
  const elapsedMs = Number.isSafeInteger(value?.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : 0;
  const startedAt = Number.isSafeInteger(value?.startedAt) && value.startedAt > 0 ? value.startedAt : null;
  return { mode, limit, elapsedMs, startedAt };
}

export function timerReading(timer, now = Date.now()) {
  const elapsedMs = timer.elapsedMs + (timer.startedAt === null ? 0 : Math.max(0, now - timer.startedAt));
  const elapsed = Math.floor(elapsedMs / 1000);
  const finished = timer.mode !== "elapsed" && elapsed >= timer.limit;
  const running = timer.startedAt !== null && !finished;
  const value = timer.mode === "elapsed" ? elapsed : timer.mode === "count-up"
    ? Math.min(elapsed, timer.limit) : Math.max(0, timer.limit - elapsed);
  return { elapsedMs, value, running, finished };
}

export function timerText(mode, value) {
  if (mode.startsWith("count-")) return value.toLocaleString();
  const units = [Math.floor(value / 60) % 60, value % 60];
  if (value >= 3600) units.unshift(Math.floor(value / 3600));
  return units.map((number) => String(number).padStart(2, "0")).join(":");
}

export function changeTimer(timer, action, now = Date.now()) {
  const { running, finished, elapsedMs } = timerReading(timer, now);
  if (action === "reset") return { ...timer, elapsedMs: 0, startedAt: null };
  if (running) return { ...timer, elapsedMs, startedAt: null };
  return { ...timer, startedAt: now, elapsedMs: finished ? 0 : timer.elapsedMs };
}
