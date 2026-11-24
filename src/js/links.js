// Links between elements: drawing them, the live line while dragging from a "+"
// handle, the link-type picker, and what each link type means for the tasks.

import * as store from "./store.js";
import { LINK_TYPES } from "./model.js";
import { showMenu } from "./menus.js";

const SVG = "http://www.w3.org/2000/svg";
let core; // { els, isVisible, removeLink, render }
let svg, linesGroup, tempPath, chips;

export function initLinks(world, c) {
  core = c;
  svg = document.createElementNS(SVG, "svg");
  svg.id = "link-layer";
  svg.innerHTML = `
    <defs>
      <marker id="link-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7"
              orient="auto-start-reverse" markerUnits="strokeWidth">
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor"></path>
      </marker>
    </defs>
    <g class="links"></g>
    <path class="temp-link" d=""></path>`;
  linesGroup = svg.querySelector("g.links");
  tempPath = svg.querySelector(".temp-link");
  world.prepend(svg);
  chips = document.createElement("div");
  chips.id = "link-chips";
  world.appendChild(chips);
}

// ---------- Geometry ----------
function boxOf(task) {
  const el = core.els.get(task.id);
  return { x: task.x, y: task.y, hw: (el?.offsetWidth || 0) / 2, hh: (el?.offsetHeight || 0) / 2 };
}

/** Where the line from a box's centre towards (tx, ty) leaves the box (plus a gap). */
function edgePoint(b, tx, ty, gap = 6) {
  const dx = tx - b.x, dy = ty - b.y;
  if (!dx && !dy) return { x: b.x, y: b.y };
  const t = Math.min(
    dx ? (b.hw + gap) / Math.abs(dx) : Infinity,
    dy ? (b.hh + gap) / Math.abs(dy) : Infinity,
    1,
  );
  return { x: b.x + dx * t, y: b.y + dy * t };
}

/** Midpoint of a card's side, pushed `out` world px outward. */
export function sidePoint(task, side, out = 0) {
  const b = boxOf(task);
  switch (side) {
    case "top": return { x: b.x, y: b.y - b.hh - out };
    case "bottom": return { x: b.x, y: b.y + b.hh + out };
    case "left": return { x: b.x - b.hw - out, y: b.y };
    default: return { x: b.x + b.hw + out, y: b.y };
  }
}

// ---------- Drawing ----------
export function renderLinks() {
  if (!svg) return;
  linesGroup.textContent = "";
  chips.textContent = "";
  for (const l of store.board.links) {
    const a = store.get(l.from), b = store.get(l.to);
    if (!a || !b || !core.isVisible(a) || !core.isVisible(b)) continue;
    const def = LINK_TYPES[l.type] || LINK_TYPES.related;
    const A = boxOf(a), B = boxOf(b);
    const p1 = edgePoint(A, B.x, B.y);
    const p2 = edgePoint(B, A.x, A.y, def.directed ? 9 : 6);
    const d = `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;

    const line = document.createElementNS(SVG, "path");
    line.setAttribute("class", `link link-${l.type}`);
    line.setAttribute("d", d);
    if (def.directed) line.setAttribute("marker-end", "url(#link-arrow)");
    const hit = document.createElementNS(SVG, "path");
    hit.setAttribute("class", "link-hit");
    hit.setAttribute("d", d);
    hit.dataset.link = l.id;
    linesGroup.append(line, hit);

    if (def.chip) {
      const chip = document.createElement("button");
      chip.className = `link-chip chip-${l.type}`;
      chip.dataset.link = l.id;
      chip.textContent = def.chip;
      chip.title = "Change link type";
      chip.style.left = `${(p1.x + p2.x) / 2}px`;
      chip.style.top = `${(p1.y + p2.y) / 2}px`;
      chips.appendChild(chip);
    }
  }
}

let pending = 0;
export function renderLinksSoon() {
  if (pending) return;
  pending = requestAnimationFrame(() => { pending = 0; renderLinks(); });
}

export function drawTemp(from, to) {
  tempPath.setAttribute("d", `M${from.x},${from.y} L${to.x},${to.y}`);
}
export function clearTemp() {
  tempPath.setAttribute("d", "");
}

// ---------- Creating & editing links ----------
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `l-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Link two elements (or return the existing link between them). */
export function connect(fromId, toId, type = "related") {
  const existing = store.board.links.find(
    (l) => (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId),
  );
  if (existing) return existing;
  const iso = new Date().toISOString();
  const link = { id: newId(), from: fromId, to: toId, type, createdAt: iso, updatedAt: iso };
  store.addLink(link);
  return link;
}

const short = (t) => {
  const s = (t?.title || "Untitled").replace(/\s+/g, " ").trim();
  return `“${s.length > 22 ? `${s.slice(0, 21)}…` : s}”`;
};

/** The dropdown for choosing what a link means. */
export function showLinkMenu(linkId, sx, sy, { onClose } = {}) {
  const l = store.getLink(linkId);
  if (!l) return;
  const A = short(store.get(l.from)), B = short(store.get(l.to));
  const setType = (type) => () => { store.updateLink(linkId, { type }); core.render(); };
  showMenu(sx, sy, [
    { header: "What does this link mean?" },
    { label: "Related", hint: "Just connected", checked: l.type === "related", onClick: setType("related") },
    { label: "Parent → subtask", hint: `${B} is a subtask of ${A}`, checked: l.type === "parent", onClick: setType("parent") },
    { label: "Dependency", hint: `${B} waits until ${A} is done`, checked: l.type === "blocks", onClick: setType("blocks") },
    { label: "Optional (OR)", hint: `Either ${A} or ${B} is enough`, checked: l.type === "or", onClick: setType("or") },
    { separator: true },
    {
      label: "Swap direction", icon: "⇄", disabled: !LINK_TYPES[l.type]?.directed,
      onClick: () => { store.updateLink(linkId, { from: l.to, to: l.from }); core.render(); },
    },
    { label: "Remove link", icon: "✕", danger: true, onClick: () => core.removeLink(linkId) },
  ], { onClose, className: "link-menu" });
}

// ---------- What links mean ----------
/**
 * For every element: its subtasks, parents, unfinished blockers and OR partners.
 * Also works out which tasks are "covered" (an OR partner is done).
 */
export function computeRelations() {
  const rel = new Map();
  const get = (id) => {
    let r = rel.get(id);
    if (!r) rel.set(id, (r = { children: [], parents: [], blockers: [], blocking: [], or: [] }));
    return r;
  };
  for (const l of store.board.links) {
    if (l.type === "parent") { get(l.from).children.push(l.to); get(l.to).parents.push(l.from); }
    else if (l.type === "blocks") { get(l.to).blockers.push(l.from); get(l.from).blocking.push(l.to); }
    else if (l.type === "or") { get(l.from).or.push(l.to); get(l.to).or.push(l.from); }
  }
  const byId = new Map(store.board.tasks.map((t) => [t.id, t]));
  const coveredBy = (t) => {
    if (t.completedAt) return null;
    const partner = (rel.get(t.id)?.or || []).map((id) => byId.get(id)).find((p) => p?.completedAt);
    return partner || null;
  };
  const isDone = (t) => !!t && (!!t.completedAt || !!coveredBy(t));
  return {
    of: (id) => rel.get(id) || { children: [], parents: [], blockers: [], blocking: [], or: [] },
    coveredBy,
    isDone,
    openBlockers: (id) => (rel.get(id)?.blockers || []).map((b) => byId.get(b)).filter((b) => b && !isDone(b)),
    progress: (id) => {
      const kids = (rel.get(id)?.children || []).map((c) => byId.get(c)).filter(Boolean);
      return kids.length ? { done: kids.filter(isDone).length, total: kids.length } : null;
    },
  };
}
