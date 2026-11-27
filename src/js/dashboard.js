import { daysUntilDue } from "./growth.js";
import { COVER_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, isTask } from "./model.js";
import { imageUrl, pickFile, storeFile } from "./attachments.js";
import { closeMenu, showMenu } from "./menus.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function showCover(preview, cover) {
  if (!cover?.attachmentId) return;
  try {
    const url = await imageUrl(cover.attachmentId, cover.mime);
    if (!url || !preview.isConnected) return;
    const image = Object.assign(element("img", "dashboard-cover-image"), { alt: "", src: url, draggable: false });
    await image.decode();
    if (!preview.isConnected) return;
    preview.replaceChildren(image);
    preview.classList.add("has-cover");
  } catch {
    // Keep the miniature available while a cover is missing or unreadable.
  }
}

function coverButton(app, { id, title, cover }) {
  const button = element("button", "dashboard-cover-button", "Cover");
  button.dataset.canvasId = id ?? "";
  button.setAttribute("aria-label", `Cover for ${title || "Untitled canvas"}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  function saveCover(image) {
    app.store.setCanvasCover(id, image);
    app.render();
    [...document.querySelectorAll(".dashboard-cover-button")]
      .find((item) => item.dataset.canvasId === button.dataset.canvasId)?.focus({ preventScroll: true });
  }

  async function chooseCover() {
    const file = await pickFile(COVER_IMAGE_TYPES.join(","));
    if (!file) return;
    if (!COVER_IMAGE_TYPES.includes(file.type)) return app.toast("Choose a JPG, PNG, WebP or GIF image.");
    if (file.size > MAX_ATTACHMENT_BYTES) return app.toast("Cover images can be up to 20 MB.");
    const url = URL.createObjectURL(file);
    try {
      const image = Object.assign(new Image(), { src: url });
      await image.decode();
      saveCover(await storeFile(file));
    } catch {
      app.toast("Couldn't load that cover image.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  button.addEventListener("click", () => {
    if (button.getAttribute("aria-expanded") === "true") return closeMenu();
    const bounds = button.getBoundingClientRect();
    const menu = showMenu(bounds.right - 258, bounds.bottom + 5, [
      { label: cover?.attachmentId ? "Change cover…" : "Set cover…", icon: "↥", onClick: chooseCover },
      cover?.attachmentId && { label: "Remove cover", icon: "×", onClick: () => saveCover(null) },
    ], { anchor: button, onClose: () => {
      button.setAttribute("aria-expanded", "false");
      button.focus({ preventScroll: true });
    } });
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
  });
  return button;
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
  const entries = canvases.map((card) => ({
    id: card.id, title: card.title, cover: card.cover, count: app.store.descendants(card.id).length,
  }));
  if (loose.length) entries.unshift({ id: null, title: "Original canvas", count: loose.length, cover: app.store.board.rootCover });
  for (const entry of entries) {
    const { id, title, count, cover } = entry;
    const project = element("div", "dashboard-project");
    const tile = element("button", "dashboard-tile");
    const preview = element("div", "canvas-miniature dashboard-miniature");
    app.renderMiniature(preview, id);
    tile.append(preview, element("strong", "", title || "Untitled canvas"),
      element("span", "dashboard-detail", `${count} item${count === 1 ? "" : "s"}`));
    tile.addEventListener("click", () => app.enterCanvas(id, preview));
    project.append(tile, coverButton(app, entry));
    tiles.append(project);
    showCover(preview, cover);
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
