import { isTask } from "./model.js";

export function initChecklist({ store, render, newId, getSelectedId }) {
  const form = document.querySelector("#f-checklist-form");
  const input = document.querySelector("#f-checklist-item");
  const list = document.querySelector("#f-checklist");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const task = store.get(getSelectedId());
    const title = input.value.trim();
    if (!isTask(task) || !title) return;
    store.update(task.id, { checklist: [...(task.checklist || []), { id: newId(), title, done: false }] });
    input.value = "";
    render();
    input.focus();
  });

  return function updateChecklist(task, fresh) {
    if (fresh) input.value = "";
    const items = isTask(task) ? task.checklist || [] : [];
    const signature = JSON.stringify([task.id, items]);
    if (signature === list.dataset.signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    for (const [index, item] of items.entries()) {
      const row = document.createElement("li");
      row.dataset.item = item.id;
      row.classList.toggle("checked", item.done);

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = item.done;
      check.setAttribute("aria-label", `Complete subtask ${index + 1}`);
      const title = document.createElement("input");
      title.type = "text";
      title.value = item.title;
      title.placeholder = "Subtask";
      title.setAttribute("aria-label", `Subtask ${index + 1}`);

      function updateItem(patch) {
        const current = store.get(task.id);
        if (!isTask(current) || !current.checklist?.some(({ id }) => id === item.id)) return;
        const next = current.checklist.map((entry) => entry.id === item.id ? { ...entry, ...patch } : entry);
        list.dataset.signature = JSON.stringify([task.id, next]);
        store.update(task.id, { checklist: next });
        row.classList.toggle("checked", check.checked);
        render();
      }
      check.addEventListener("change", () => updateItem({ done: check.checked }));
      title.addEventListener("input", () => updateItem({ title: title.value }));
      row.append(check, title);

      for (const [action, symbol, label, offset] of [
        ["up", "↑", "Move up", -1], ["down", "↓", "Move down", 1], ["delete", "×", "Delete", 0],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost";
        button.dataset.action = action;
        button.textContent = symbol;
        button.title = `${label} subtask ${index + 1}`;
        button.setAttribute("aria-label", button.title);
        button.disabled = offset !== 0 && !items[index + offset];
        button.addEventListener("click", () => {
          const current = store.get(task.id);
          if (!isTask(current)) return;
          const next = [...(current.checklist || [])];
          const position = next.findIndex(({ id }) => id === item.id);
          if (position < 0 || (offset && !next[position + offset])) return;
          const [entry] = next.splice(position, 1);
          if (offset) next.splice(position + offset, 0, entry);
          store.update(task.id, { checklist: next });
          render();
          const moved = [...list.children].find((child) => child.dataset.item === item.id);
          const sameButton = moved?.querySelector(`[data-action="${action}"]:enabled`);
          (sameButton || moved?.querySelector('input[type="text"]') || input).focus();
        });
        row.append(button);
      }
      list.append(row);
    }
  };
}
