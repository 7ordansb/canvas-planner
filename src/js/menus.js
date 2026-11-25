// Small popup menus: the "+" menu, the link-type picker and right-click menus.
//
// items: array of
//   { label, icon?, hint?, checked?, danger?, disabled?, onClick }
//   { separator: true }
//   { header: "Text" }
//   { swatches: [{ key, label, css, checked }], onPick(key) }

let open = null;

export const isMenuOpen = () => !!open;

export function closeMenu() {
  if (!open) return;
  const { el, onClose } = open;
  open = null;
  el.remove();
  removeEventListener("pointerdown", onOutside, true);
  removeEventListener("keydown", onKey, true);
  onClose?.();
}

function onOutside(e) {
  if (open && !open.el.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (!open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...open.el.querySelectorAll("button:not(:disabled)")];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? (i + 1) % items.length
      : (i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length);
    items[next]?.focus();
  }
}

/** Show a menu with its top-left near screen point (x, y). */
export function showMenu(x, y, items, { onClose, className = "" } = {}) {
  closeMenu();
  const el = document.createElement("div");
  el.className = `popup-menu ${className}`;
  el.setAttribute("role", "menu");

  const choose = (fn) => () => { closeMenu(); fn?.(); };

  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      el.appendChild(Object.assign(document.createElement("div"), { className: "menu-sep" }));
    } else if (it.header) {
      el.appendChild(Object.assign(document.createElement("div"), { className: "menu-header", textContent: it.header }));
    } else if (it.swatches) {
      const row = document.createElement("div");
      row.className = "menu-swatches";
      for (const s of it.swatches) {
        const b = document.createElement("button");
        b.className = `swatch${s.checked ? " checked" : ""}`;
        b.title = s.label;
        b.setAttribute("aria-label", s.label);
        b.setAttribute("role", "menuitemradio");
        b.setAttribute("aria-checked", String(s.checked));
        b.style.background = s.css;
        b.addEventListener("click", choose(() => it.onPick(s.key)));
        row.appendChild(b);
      }
      el.appendChild(row);
    } else {
      const b = document.createElement("button");
      b.className = `menu-item${it.checked ? " checked" : ""}${it.danger ? " danger" : ""}`;
      b.disabled = !!it.disabled;
      b.setAttribute("role", "menuitem");
      b.innerHTML = `<span class="menu-icon"></span><span class="menu-text"><span class="menu-label"></span><span class="menu-hint"></span></span>`;
      b.querySelector(".menu-icon").textContent = it.checked ? "✓" : it.icon || "";
      b.querySelector(".menu-label").textContent = it.label;
      b.querySelector(".menu-hint").textContent = it.hint || "";
      b.addEventListener("click", choose(it.onClick));
      el.appendChild(b);
    }
  }

  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y}px`;

  open = { el, onClose };
  // Listen from the next tick so the click that opened the menu doesn't close it.
  setTimeout(() => {
    if (open?.el !== el) return;
    addEventListener("pointerdown", onOutside, true);
    addEventListener("keydown", onKey, true);
  });
  return el;
}
