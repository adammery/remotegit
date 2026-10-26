// The small menu bar / tray window: one repository at a glance, commit
// everything (optionally with an AI message) and sync. The full window is one
// click away. Shares servers, repositories and theme with the main window.

import * as git from './git.js';
import { icons, fileIcon } from './icons.js';

const tauri = window.__TAURI__;
const MAIN_KEY = 'remotegit:v1';
const TRAY_KEY = 'remotegit:tray';
const FILES_SHOWN = 8;

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
};
const writePrefs = (patch) => {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(TRAY_KEY, JSON.stringify(prefs));
  } catch {}
};

let main = read(MAIN_KEY); // servers, repos, theme, commit options — owned by the main window
let prefs = read(TRAY_KEY); // repoId, pushAfterCommit, menuBarOnly

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // static icon markup only
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

function ago(sec) {
  if (!sec) return 'never';
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 45) return 'just now';
  const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let [div, name] = units[0];
  for (const u of units) if (s >= u[0]) [div, name] = u;
  const n = Math.max(1, Math.round(s / div));
  return `${n} ${name}${n > 1 ? 's' : ''} ago`;
}

// ---------------------------------------------------------------- SSH

const connections = new Map();
const connState = new Map(); // serverId -> 'connecting' | 'ok' | 'error'
const dot = (serverId) => h('span', { class: 'dot ' + ({ ok: 'ok', connecting: 'busy', error: 'err' }[connState.get(serverId)] || ''), title: { ok: 'Connected', connecting: 'Connecting…', error: 'Not reachable' }[connState.get(serverId)] || 'Not connected yet' });

function setConn(serverId, state) {
  if (connState.get(serverId) === state) return;
  connState.set(serverId, state);
  render();
}
const targetOf = (s) => ({
  host: s.host,
  user: s.user || null,
  port: s.port ? Number(s.port) : null,
  identityFile: s.identityFile || null,
  forwardAgent: !!s.forwardAgent,
  local: !!s.local,
});

function connect(server) {
  if (!connections.has(server.id)) {
    if (connState.get(server.id) !== 'ok') setConn(server.id, 'connecting');
    const p = tauri.core.invoke('ssh_connect', { id: server.id, target: targetOf(server) });
    connections.set(server.id, p);
    p.then(
      () => setConn(server.id, 'ok'),
      () => {
        connections.delete(server.id);
        setConn(server.id, 'error');
      },
    );
  }
  return connections.get(server.id);
}

async function execOn(server, script, timeoutSecs = 60) {
  await connect(server);
  try {
    const r = await tauri.core.invoke('ssh_exec', { id: server.id, script, timeoutSecs });
    setConn(server.id, 'ok');
    return r;
  } catch (e) {
    connections.delete(server.id);
    setConn(server.id, 'error');
    throw e;
  }
}

// ---------------------------------------------------------------- state

const T = { repo: null, server: null, status: null, head: null, error: null, busy: null, picking: false, gen: 0, description: '' };
const ex = (script, t) => execOn(T.server, script, t);

function selectRepo(id) {
  main = read(MAIN_KEY);
  const repos = main.repos || [];
  const repo = repos.find((r) => r.id === id) || repos.find((r) => r.id === main.currentRepoId) || repos[0] || null;
  T.gen++;
  Object.assign(T, { repo, server: repo && (main.servers || []).find((s) => s.id === repo.serverId), status: null, head: null, error: null, picking: false });
  if (repo) writePrefs({ repoId: repo.id });
  render();
  refresh();
}

let inFlight = false;
async function refresh() {
  if (!T.repo || !T.server || inFlight || T.busy) return;
  inFlight = true;
  const gen = T.gen;
  try {
    const st = await git.getStatus(ex, T.repo.path);
    if (gen !== T.gen) return;
    const moved = T.status?.branch.oid !== st.branch.oid;
    const changed = T.status?.raw !== st.raw || T.error;
    T.status = st;
    T.error = null;
    if (moved) T.head = st.branch.oid ? await git.getHeadCommit(ex, T.repo.path).catch(() => null) : null;
    if (changed || moved) render();
    updateTrayStatus();
  } catch (e) {
    if (gen !== T.gen) return;
    T.error = String(e?.message || e);
    render();
  } finally {
    inFlight = false;
  }
}

function updateTrayStatus() {
  const n = T.status?.files.length || 0;
  const ahead = T.status?.branch.ahead || 0;
  const title = [n ? String(n) : '', ahead ? `↑${ahead}` : ''].filter(Boolean).join(' ');
  const tooltip = T.repo ? `RemoteGit — ${T.repo.name}: ${n} changed file${n === 1 ? '' : 's'}` : 'RemoteGit';
  tauri.core.invoke('set_tray_status', { title, tooltip }).catch(() => {});
}

async function busy(label, fn) {
  if (T.busy) return;
  T.busy = label;
  render();
  try {
    await fn();
  } catch (e) {
    T.error = String(e?.message || e);
  } finally {
    T.busy = null;
    T.status = null; // force a full re-render with fresh data
    render();
    await refresh();
  }
}

function syncAction() {
  const st = T.status;
  if (!st?.remote || !st.branch.head) return null;
  const remote = st.remote.name;
  const b = st.branch;
  if (!b.upstream) return { label: 'Publish', run: () => git.push(ex, T.repo.path, { remote, hasUpstream: false }) };
  if (b.behind > 0) return { label: 'Pull', icon: 'down', count: b.behind, run: () => git.pull(ex, T.repo.path) };
  if (b.ahead > 0) return { label: 'Push', icon: 'up', count: b.ahead, run: () => git.push(ex, T.repo.path, { remote, hasUpstream: true }) };
  return { label: 'Fetch', run: () => git.fetchRemote(ex, T.repo.path, remote) };
}

async function commitAll() {
  const summary = document.getElementById('tray-summary')?.value.trim();
  const st = T.status;
  if (!summary || !st?.files.length) return;
  const push = !!prefs.pushAfterCommit && !!st.remote;
  await busy(push ? 'Committing and pushing' : 'Committing', async () => {
    await git.commit(ex, T.repo.path, { files: st.files, all: true, summary, description: T.description, ...(main.commitOpts || {}) });
    T.description = '';
    if (push && st.remote && st.branch.head)
      await git.push(ex, T.repo.path, { remote: st.remote.name, hasUpstream: !!st.branch.upstream });
  });
}

async function generate() {
  if (!T.status?.files.length || T.busy) return;
  await busy('Writing the message', async () => {
    const m = await git.generateCommitMessage(ex, T.repo.path, T.status.files, !!T.status.branch.oid);
    if (!m) throw new Error('Claude Code was not found on the server. Install it there and sign in once by running claude.');
    T.draft = m.summary;
    T.description = m.description;
  });
}

function undoable() {
  const st = T.status;
  const c = T.head;
  if (!st || !c || c.sha !== st.branch.oid || !st.branch.head) return null;
  return !st.branch.upstream || st.branch.ahead > 0 ? c : null;
}

// ---------------------------------------------------------------- render

function render() {
  main = read(MAIN_KEY);
  const root = document.getElementById('tray');
  const servers = main.servers || [];
  const repos = main.repos || [];

  const head = h(
    'div',
    { class: 'tray-head' },
    h(
      'button',
      {
        class: 'tray-repo' + (T.picking ? ' open' : ''),
        type: 'button',
        disabled: !repos.length,
        onclick: () => {
          T.picking = !T.picking;
          render();
          // Check every server so the list shows which ones are reachable.
          if (T.picking) for (const s of servers) connect(s).catch(() => {});
        },
      },
      h('span', { html: icons.repo }),
      h(
        'span',
        { class: 'grow' },
        h('span', { class: 'name' }, T.repo?.name || 'No repository'),
        h('span', { class: 'where' }, T.server && dot(T.server.id), T.server ? T.server.name || T.server.host : 'Add one in the main window'),
      ),
      h('span', { html: icons.caret }),
    ),
    h('button', { class: 'btn-icon', type: 'button', title: 'Open RemoteGit', html: icons.external, onclick: openMain }),
  );

  const parts = [head];
  if (T.picking) {
    parts.push(
      h(
        'div',
        { class: 'tray-picker' },
        servers.map((s) => [
          h('div', { class: 'pop-group' }, dot(s.id), h('span', { class: 'grow' }, s.name || s.host), h('span', { class: 'sub' }, { ok: 'connected', connecting: 'connecting…', error: 'not reachable' }[connState.get(s.id)] || '')),
          repos
            .filter((r) => r.serverId === s.id)
            .map((r) =>
              h(
                'div',
                { class: 'pop-item' + (r.id === T.repo?.id ? ' current' : ''), onclick: () => selectRepo(r.id) },
                h('span', { html: r.id === T.repo?.id ? icons.check : icons.repo }),
                h('div', { class: 'grow' }, h('div', { class: 'title' }, r.name), h('div', { class: 'sub' }, r.path)),
              ),
            ),
        ]),
      ),
    );
  } else if (!T.repo) {
    parts.push(h('div', { class: 'tray-clean' }, h('b', {}, 'No repositories yet'), 'Add a server and a repository in the main window.', h('button', { class: 'btn btn-primary', type: 'button', onclick: openMain }, 'Open RemoteGit')));
  } else if (T.error && !T.status) {
    parts.push(h('div', { class: 'tray-error' }, h('b', {}, `Can’t reach ${T.server?.name || 'the server'}`), h('div', { class: 'error-box' }, T.error), h('button', { class: 'btn', type: 'button', onclick: () => { connections.delete(T.server.id); T.error = null; refresh(); } }, 'Try again')));
  } else if (!T.status) {
    parts.push(h('div', { class: 'tray-clean' }, T.busy ? `${T.busy}…` : 'Loading…'));
  } else {
    parts.push(...statusParts());
  }

  parts.push(
    h(
      'div',
      { class: 'tray-foot' },
      h(
        'label',
        { class: 'check', title: 'Hide RemoteGit from the Dock / taskbar and keep it here' },
        h('input', { type: 'checkbox', checked: !!prefs.menuBarOnly, onchange: (e) => setMenuBarOnly(e.target.checked) }),
        /Mac/.test(navigator.platform || navigator.userAgent) ? 'Hide from the Dock' : 'Hide from the taskbar',
      ),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: openMain }, 'Open RemoteGit'),
    ),
  );

  // Keep what the user is typing across re-renders.
  const typed = document.getElementById('tray-summary')?.value;
  root.replaceChildren(...parts);
  const input = document.getElementById('tray-summary');
  if (input) {
    if (T.draft) {
      input.value = T.draft;
      T.draft = null;
    } else if (typed) input.value = typed;
    updateCommitButton();
  }
}

function statusParts() {
  const st = T.status;
  const action = syncAction();
  const files = st.files;
  const out = [];

  out.push(
    h(
      'div',
      { class: 'tray-branch' },
      h('span', { html: icons.branch }),
      h('span', { class: 'name', title: st.branch.head || '' }, st.branch.head || `Detached at ${st.branch.oid?.slice(0, 7)}`),
      action &&
        h(
          'button',
          { class: 'btn', type: 'button', disabled: !!T.busy, title: `Last fetched ${ago(st.lastFetched)}`, onclick: () => busy(action.label, action.run) },
          action.label,
          action.count ? h('span', { class: 'count' }, String(action.count), h('span', { html: icons[action.icon] })) : '',
        ),
    ),
  );

  if (T.error) out.push(h('div', { class: 'banner' }, T.error));

  if (!files.length) {
    out.push(h('div', { class: 'tray-files' }, h('div', { class: 'tray-clean' }, h('b', {}, 'No local changes'), T.busy ? `${T.busy}…` : 'Everything on the server is committed.')));
  } else {
    out.push(
      h(
        'div',
        { class: 'tray-files' },
        h('div', { class: 'files-title' }, `${files.length} changed file${files.length === 1 ? '' : 's'}`),
        files.slice(0, FILES_SHOWN).map((f) => {
          const i = f.path.lastIndexOf('/');
          return h(
            'div',
            { class: 'file-row', title: f.path, onclick: openMain },
            h('span', { class: 'file-path' }, h('span', { class: 'dir' }, `‎${i < 0 ? '' : f.path.slice(0, i + 1)}‎`), h('span', { class: 'name' }, f.path.slice(i + 1))),
            h('span', { class: `file-status ${f.kind}`, html: fileIcon(f.kind) }),
          );
        }),
        files.length > FILES_SHOWN && h('div', { class: 'list-note' }, `…and ${files.length - FILES_SHOWN} more. Open RemoteGit to pick files or lines.`),
      ),
    );
    out.push(
      h(
        'div',
        { class: 'tray-commit' },
        h(
          'div',
          { class: 'input-row' },
          h('input', { id: 'tray-summary', placeholder: 'Summary (required)', oninput: updateCommitButton, onkeydown: (e) => e.key === 'Enter' && commitAll() }),
          h('button', { class: 'btn', type: 'button', title: 'Write the message with Claude (on the server)', html: T.busy === 'Writing the message' ? icons.spinner : icons.sparkle, disabled: !!T.busy, onclick: generate }),
        ),
        st.remote &&
          h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: !!prefs.pushAfterCommit, onchange: (e) => { writePrefs({ pushAfterCommit: e.target.checked }); updateCommitButton(); } }),
          'Push after committing',
        ),
        h('button', { class: 'btn btn-primary btn-block', id: 'tray-commit-btn', type: 'button', onclick: commitAll }),
      ),
    );
  }

  const c = undoable();
  if (c)
    out.push(
      h(
        'div',
        { class: 'tray-last' },
        h('div', { class: 'grow' }, h('div', { class: 'undo-when' }, `Committed ${ago(c.time)}`), h('div', { class: 'undo-summary', title: c.summary }, c.summary)),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: !!T.busy, onclick: () => busy('Undoing', () => git.undoCommit(ex, T.repo.path, c.sha)) }, 'Undo'),
      ),
    );
  return out;
}

function updateCommitButton() {
  const btn = document.getElementById('tray-commit-btn');
  if (!btn) return;
  const n = T.status?.files.length || 0;
  const branch = T.status?.branch.head || 'HEAD';
  btn.disabled = !document.getElementById('tray-summary')?.value.trim() || !!T.busy || !n;
  btn.replaceChildren(
    T.busy ? `${T.busy}…` : `Commit ${n > 1 ? `${n} files ` : ''}to `,
    T.busy ? '' : h('b', {}, branch),
    !T.busy && prefs.pushAfterCommit && T.status?.remote ? ' and push' : '',
  );
}

// ---------------------------------------------------------------- window

function openMain() {
  tauri.core.invoke('show_main_window').catch(() => {});
  hide();
}

function hide() {
  try {
    tauri.window?.getCurrentWindow?.().hide();
  } catch {}
}

function setMenuBarOnly(enabled) {
  writePrefs({ menuBarOnly: enabled });
  tauri.core.invoke('set_menu_bar_only', { enabled }).catch(() => {});
}

function applyTheme() {
  const t = read(MAIN_KEY).theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function init() {
  if (!tauri?.core) return;
  applyTheme();
  try {
    // Behave like a menu: close when the user clicks elsewhere.
    tauri.window?.getCurrentWindow?.().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        applyTheme();
        main = read(MAIN_KEY);
        if (!T.repo || !(main.repos || []).some((r) => r.id === T.repo.id)) selectRepo(prefs.repoId);
        else refresh();
      } else if (!T.busy) hide();
    });
  } catch {}
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  selectRepo(prefs.repoId);
  // Quick while open, slow in the background just to keep the menu bar count fresh.
  const tick = () => {
    refresh();
    setTimeout(tick, document.hasFocus() ? 4000 : 30000);
  };
  setTimeout(tick, 4000);
}

init();
