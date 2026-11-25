import { daysUntilDue } from "./growth.js";
import { isTask } from "./model.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderDashboard(app, root) {
  const tasks = app.store.board.tasks.filter(isTask);
  const open = tasks.filter((task) => !task.completedAt);
  const now = Date.now();
  const dated = open.filter((task) => task.due)
    .map((task) => ({ task, days: daysUntilDue(task.due, now) }))
    .sort((a, b) => a.days - b.days || a.task.title.localeCompare(b.task.title));
  const daysLeftThisWeek = (7 - new Date(now).getDay()) % 7;

  const metrics = element("section", "dashboard-metrics");
  for (const [label, count] of [
    ["Total tasks", tasks.length], ["Open", open.length],
    ["Completed", tasks.length - open.length], ["Overdue", dated.filter(({ days }) => days < 0).length],
  ]) {
    const metric = element("div", "dashboard-metric");
    metric.append(element("span", "", label), element("strong", "", count));
    metrics.append(metric);
  }

  const schedule = element("div", "dashboard-schedule");
  for (const [label, items] of [
    ["Overdue", dated.filter(({ days }) => days < 0)],
    ["Today", dated.filter(({ days }) => days === 0)],
    ["Later this week", dated.filter(({ days }) => days > 0 && days <= daysLeftThisWeek)],

  ]) {
    if (!items.length) continue;
    const section = element("section", "dashboard-widget");
    const heading = element("div", "dashboard-widget-heading");
    heading.append(element("h3", "", label), element("span", "dashboard-count", items.length));
    section.append(heading);
    if (!items.length) section.append(element("p", "dashboard-empty", "No tasks due"));
    for (const { task } of items) {
      const row = element("button", "dashboard-task");
      const location = app.getWorkspace(task.canvasId)?.title || "Original canvas";
      const date = new Date(`${task.due}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      row.append(element("strong", "", task.title || "Untitled task"), element("span", "", `${location} · ${date}`));
      row.addEventListener("click", () => app.revealTask(task.id));
      section.append(row);
    }
    schedule.append(section);
  }

  const workspaces = element("section", "dashboard-workspaces");
  const heading = element("div", "dashboard-section-heading");
  const add = element("button", "primary", "+ New canvas");
  add.addEventListener("click", () => app.newWorkspace());
  heading.append(element("h2", "", "Your canvases"), add);
  workspaces.append(heading);
  const tiles = element("div", "dashboard-tiles");
  const canvases = app.store.board.tasks.filter((task) => task.kind === "canvas" && task.workspace && !task.canvasId);
  const loose = app.store.board.tasks.filter((task) => !task.canvasId && !(task.kind === "canvas" && task.workspace));
  const entries = canvases.map((card) => ({ id: card.id, title: card.title, count: app.store.descendants(card.id).length }));
  if (loose.length) entries.unshift({ id: null, title: "Original canvas", count: loose.length });
  for (const { id, title, count } of entries) {
    const tile = element("button", "dashboard-tile");
    const preview = element("div", "canvas-miniature dashboard-miniature");
    app.renderMiniature(preview, id);
    tile.append(preview, element("strong", "", title || "Untitled canvas"),
      element("span", "dashboard-detail", `${count} item${count === 1 ? "" : "s"}`));
    tile.addEventListener("click", () => app.enterCanvas(id, preview));
    tiles.append(tile);
  }
  if (entries.length) workspaces.append(tiles);
  else workspaces.append(element("p", "dashboard-empty", "Create a canvas to start adding notes and tasks."));

  const agenda = element("aside", "agenda");
  agenda.append(element("h2","","Agenda"),schedule);
  const layout=element("div","review-layout");
  layout.append(workspaces);
  if(dated.length) layout.append(agenda);
  const stamp=element("p","stamp",new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"}));
  root.replaceChildren(stamp,element("h1","","The pinboard"),layout);
  if(tasks.length)root.append(metrics);
}
