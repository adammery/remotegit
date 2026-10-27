// Helpers shared by the main window (app.js) and the menu bar window (tray.js).

export const STORE_KEY = 'remotegit:v1'; // servers, repos, theme, commit options — owned by the main window
export const TRAY_KEY = 'remotegit:tray'; // menu bar window preferences

const tauri = window.__TAURI__;

/** A stored JSON object, or {} when it's missing or storage is unavailable. */
export function readKey(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // static icon markup only
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

export function ago(sec) {
  if (!sec) return 'never';
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 45) return 'just now';
  const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let [div, name] = units[0];
  for (const u of units) if (s >= u[0]) [div, name] = u;
  const n = Math.max(1, Math.round(s / div));
  return `${n} ${name}${n > 1 ? 's' : ''} ago`;
}

export function writeTrayPrefs(patch) {
  try {
    localStorage.setItem(TRAY_KEY, JSON.stringify({ ...readKey(TRAY_KEY), ...patch }));
  } catch {}
}

// The two menu bar switches, settable from either window.
export function setShowInMenuBar(visible) {
  writeTrayPrefs({ showInMenuBar: visible });
  tauri?.core.invoke('set_tray_visible', { visible }).catch(() => {});
  // Without the icon there'd be no way back to a hidden app.
  if (!visible && readKey(TRAY_KEY).menuBarOnly) setMenuBarOnly(false);
}
export function setMenuBarOnly(enabled) {
  if (enabled && !readKey(TRAY_KEY).showInMenuBar) setShowInMenuBar(true);
  writeTrayPrefs({ menuBarOnly: enabled });
  tauri?.core.invoke('set_menu_bar_only', { enabled }).catch(() => {});
}

/** What the Rust side needs to open a connection to `server`. */
export const targetOf = (s) => ({
  host: s.host,
  user: s.user || null,
  port: s.port ? Number(s.port) : null,
  identityFile: s.identityFile || null,
  forwardAgent: !!s.forwardAgent,
  local: !!s.local,
});

/** Like GitHub Desktop: the newest commit can be undone until it is pushed. */
export function undoable(status, head) {
  if (!status || !head || head.sha !== status.branch.oid || !status.branch.head) return null;
  return !status.branch.upstream || status.branch.ahead > 0 ? head : null;
}

// ---------------------------------------------------------------- context menu

let menuEl = null;
export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

/** items: { label, run, danger?, disabled? } or '-' for a separator. */
export function openMenu(x, y, items) {
  closeMenu();
  menuEl = h(
    'div',
    { class: 'menu' },
    items.filter(Boolean).map((it) =>
      it === '-'
        ? h('div', { class: 'menu-sep' })
        : h('div', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''), onclick: it.disabled ? null : () => { closeMenu(); it.run(); } }, it.label),
    ),
  );
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menuEl.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}

document.addEventListener('mousedown', (e) => menuEl && !menuEl.contains(e.target) && closeMenu());

// No browser menu (Reload, Inspect…) in the app; it stays for text fields and
// selected text so copy and paste work.
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented || e.target.closest?.('input, textarea') || String(getSelection()).trim()) return;
  e.preventDefault();
});
