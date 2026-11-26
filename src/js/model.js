// Shared definitions for card colours, element kinds and link types.

/** Card colours. "auto" (null on the task) means: colour follows urgency. */
export const COLORS = [
  { key: "yellow", label: "Yellow", hue: 48, sat: 92 },
  { key: "orange", label: "Orange", hue: 28, sat: 90 },
  { key: "red", label: "Red", hue: 4, sat: 80 },
  { key: "pink", label: "Pink", hue: 330, sat: 75 },
  { key: "purple", label: "Purple", hue: 270, sat: 65 },
  { key: "blue", label: "Blue", hue: 212, sat: 80 },
  { key: "teal", label: "Teal", hue: 175, sat: 55 },
  { key: "green", label: "Green", hue: 125, sat: 50 },
  { key: "grey", label: "Grey", hue: 220, sat: 8 },
];
export const COLOR_BY_KEY = Object.fromEntries(COLORS.map((c) => [c.key, c]));
export const AUTO = "auto";

/** Kinds of element that can sit on a canvas. */
export const KINDS = ["task", "image", "file", "canvas", "label"];

export const isTask = (card) => card?.kind === "task" && card.taskMode !== false;

export function normalizeChecklist(items) {
  const ids = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.title !== "string" || ids.has(item.id)) return [];
    ids.add(item.id);
    return [{ id: item.id, title: item.title, done: item.done === true }];
  });
}

/**
 * Link types. A link always has a direction (from → to); some types use it.
 *   related – just connected
 *   parent  – `from` is the parent, `to` is a subtask
 *   blocks  – `to` can't start until `from` is done (a dependency)
 *   or      – either one is enough: when one is done, the other is "covered"
 */
export const LINK_TYPES = {
  attachment: { label: "Attachment", chip: "File", directed: false },
  related: { label: "Related", chip: "Related", directed: false },
  parent: { label: "Parent → subtask", chip: "subtask", directed: true },
  blocks: { label: "Dependency", chip: "blocks", directed: true },
  or: { label: "Optional (OR)", chip: "OR", directed: false },
};

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Accept HTTP(S) links for notes. Bare domains default to HTTPS. */
export function webLink(input) {
  const value = String(input ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
