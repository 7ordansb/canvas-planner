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
export const KINDS = ["task", "image", "file", "canvas"];

/**
 * Link types. A link always has a direction (from → to); some types use it.
 *   related – just connected
 *   parent  – `from` is the parent, `to` is a subtask
 *   blocks  – `to` can't start until `from` is done (a dependency)
 *   or      – either one is enough: when one is done, the other is "covered"
 */
export const LINK_TYPES = {
  related: { label: "Related", chip: "", directed: false },
  parent: { label: "Parent → subtask", chip: "subtask", directed: true },
  blocks: { label: "Dependency", chip: "blocks", directed: true },
  or: { label: "Optional (OR)", chip: "OR", directed: false },
};

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
