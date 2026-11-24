// How a task card grows. Size comes from two things added together:
//   1. Age:      how long since the task was created.
//   2. Due date: how close the due date is (and how overdue it is).
// Tweak the numbers in GROWTH to change the feel.

export const DAY = 24 * 60 * 60 * 1000;

export const GROWTH = {
  agePerDay: 0.07,       // +7% size for each day the task exists...
  ageMax: 0.8,           // ...up to +80% from age alone (about 11 days)
  dueWindowDays: 7,      // start growing this many days before the due date
  dueMax: 1.0,           // +100% by the time the due date arrives
  overduePerDay: 0.2,    // keeps growing +20%/day once overdue...
  overdueMax: 0.8,       // ...up to +80% more
  maxScale: 3.6,         // hard cap so a card can't swallow the canvas
  doneScale: 0.75,       // completed tasks shrink to this
};

function endOfDay(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days from `now` until the due date (negative = overdue). */
export function daysUntilDue(isoDate, now) {
  return Math.round((startOfDay(endOfDay(isoDate)) - startOfDay(now)) / DAY);
}

/**
 * @returns {{ scale: number, urgency: number, hue: number, overdue: boolean }}
 *   scale   – size multiplier for the card (1 = normal)
 *   urgency – 0..1, used for colour
 *   hue     – card colour hue: 50 (calm yellow) → 0 (red)
 */
export function growthOf(task, now) {
  if (task.completedAt) {
    return { scale: GROWTH.doneScale, urgency: 0, hue: 50, overdue: false };
  }

  const ageDays = Math.max(0, (now - Date.parse(task.createdAt)) / DAY);
  const age = Math.min(GROWTH.ageMax, ageDays * GROWTH.agePerDay);

  let due = 0;
  let overdue = false;
  if (task.due) {
    const daysLeft = (endOfDay(task.due) - now) / DAY;
    if (daysLeft <= 0) {
      overdue = true;
      due = GROWTH.dueMax + Math.min(GROWTH.overdueMax, -daysLeft * GROWTH.overduePerDay);
    } else if (daysLeft < GROWTH.dueWindowDays) {
      due = GROWTH.dueMax * (1 - daysLeft / GROWTH.dueWindowDays);
    }
  }

  const scale = Math.min(GROWTH.maxScale, 1 + age + due);
  const urgency = Math.min(1, (scale - 1) / (GROWTH.maxScale - 1.4));
  return { scale, urgency, hue: Math.round(50 - 50 * urgency), overdue };
}
