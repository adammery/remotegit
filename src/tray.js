// The small menu bar / tray window: one repository at a glance, commit
// everything (optionally with an AI message) and sync. The full window is one
// click away. Shares servers, repositories and theme with the main window.

import * as git from './git.js';
import { icons, fileIcon } from './icons.js';
import { h, ago, targetOf, undoable as undoableCommit, openMenu, readKey as read, setShowInMenuBar, setMenuBarOnly, STORE_KEY as MAIN_KEY, TRAY_KEY } from './ui.js';

const tauri = window.__TAURI__;
// The window itself is transparent on macOS; the content draws the rounded panel.
if (/Mac/.test(navigator.platform || navigator.userAgent)) document.documentElement.classList.add('rounded');
const FILES_SHOWN = 8;

// The main window changes these too, so always start from what's stored.
const writePrefs = (patch) => {
  prefs = { ...read(TRAY_KEY), ...patch };
  try {
    localStorage.setItem(TRAY_KEY, JSON.stringify(prefs));
  } catch {}
};

let main = read(MAIN_KEY); // servers, repos, theme, commit options — owned by the main window
let prefs = read(TRAY_KEY); // repoId, pushAfterCommit (+ showInMenuBar, menuBarOnly from the main window)

// ---------------------------------------------------------------- SSH

const connections = new Map();
const connState = new Map(); // serverId -> 'connecting' | 'ok' | 'error'
const dot = (serverId) => h('span', { class: 'dot ' + ({ ok: 'ok', connecting: 'busy', error: 'err' }[connState.get(serverId)] || ''), title: { ok: 'Connected', connecting: 'Connecting…', error: 'Not reachable' }[connState.get(serverId)] || 'Not connected yet' });

function setConn(serverId, state) {
  if (connState.get(serverId) === state) return;
  connState.set(serverId, state);
  render();
}
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

// picking: false | 'repo' | 'branch' | 'settings' — what replaces the changes.
// excluded: paths left unchecked, like the main window's checkboxes.
const T = { repo: null, server: null, status: null, head: null, error: null, busy: null, picking: false, branches: null, excluded: new Set(), gen: 0, description: '' };
const ex = (script, t) => execOn(T.server, script, t);
const checkedFiles = () => (T.status?.files || []).filter((f) => !T.excluded.has(f.path));

function selectRepo(id) {
  main = read(MAIN_KEY);
  const repos = main.repos || [];
  const repo = repos.find((r) => r.id === id) || repos.find((r) => r.id === main.currentRepoId) || repos[0] || null;
  T.gen++;
  Object.assign(T, { repo, server: repo && (main.servers || []).find((s) => s.id === repo.serverId), status: null, head: null, error: null, picking: false, excluded: new Set() });
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
    const paths = new Set(st.files.map((f) => f.path));
    for (const p of T.excluded) if (!paths.has(p)) T.excluded.delete(p);
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
  const files = checkedFiles();
  if (!summary || !files.length) return;
  const push = !!prefs.pushAfterCommit && !!st.remote;
  await busy(push ? 'Committing and pushing' : 'Committing', async () => {
    await git.commit(ex, T.repo.path, { files, all: files.length === st.files.length, summary, description: T.description, ...(main.commitOpts || {}) });
    T.description = '';
    if (push && st.remote && st.branch.head)
      await git.push(ex, T.repo.path, { remote: st.remote.name, hasUpstream: !!st.branch.upstream });
  });
}

async function generate() {
  if (!checkedFiles().length || T.busy) return;
  let tools = [];
  await busy('Writing the message', async () => {
    tools = await git.findAiTools(ex);
    if (!tools.length) throw new Error('No AI found on the server. Install Claude Code or Codex there and sign in once.');
    if (tools.length === 1) await write(tools[0].id);
  });
  const btn = document.getElementById('tray-ai');
  if (tools.length > 1 && btn) {
    const r = btn.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [{ label: 'Write the message with', disabled: true }, ...tools.map((t) => ({ label: t.name, run: () => busy('Writing the message', () => write(t.id)) }))]);
  }
}

async function write(tool) {
    const m = await git.generateCommitMessage(ex, T.repo.path, checkedFiles(), !!T.status.branch.oid, tool);
  if (!m) throw new Error('That AI is no longer on the server.');
  T.draft = m.summary;
  T.description = m.description;
}

const undoable = () => undoableCommit(T.status, T.head);

// ---------------------------------------------------------------- render

function render() {
  main = read(MAIN_KEY);
  prefs = read(TRAY_KEY);
  const root = document.getElementById('tray');
  const servers = main.servers || [];
  const repos = main.repos || [];

  const head = h(
    'div',
    { class: 'tray-head' },
    h(
      'button',
      {
        class: 'tray-repo' + (T.picking === 'repo' ? ' open' : ''),
        type: 'button',
        disabled: !repos.length,
        onclick: () => {
          T.picking = T.picking === 'repo' ? false : 'repo';
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
  if (T.picking === 'repo') {
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
  } else if (T.picking === 'settings') {
    parts.push(settingsPanel());
  } else if (T.picking === 'branch') {
    parts.push(branchRow(), branchPicker());
  } else {
    parts.push(...statusParts());
  }

  parts.push(
    h(
      'div',
      { class: 'tray-foot' },
      h('button', { class: 'btn-icon' + (T.picking === 'settings' ? ' on' : ''), type: 'button', title: 'Settings', html: icons.gear, onclick: () => { T.picking = T.picking === 'settings' ? false : 'settings'; render(); } }),
      h('span', { class: 'grow' }),
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

function branchRow() {
  const st = T.status;
  const action = syncAction();
  const open = T.picking === 'branch';
  return h(
    'div',
    { class: 'tray-branch' },
    h(
      'button',
      { class: 'tray-branch-btn' + (open ? ' open' : ''), type: 'button', disabled: !!T.busy, title: 'Switch branch', onclick: toggleBranches },
      h('span', { html: icons.branch }),
      h('span', { class: 'name' }, st.branch.head || `Detached at ${st.branch.oid?.slice(0, 7)}`),
      h('span', { html: icons.caret }),
    ),
    action &&
      !open &&
      h(
        'button',
        { class: 'btn', type: 'button', disabled: !!T.busy, title: `Last fetched ${ago(st.lastFetched)}`, onclick: () => busy(action.label, action.run) },
        action.label,
        action.count ? h('span', { class: 'count' }, String(action.count), h('span', { html: icons[action.icon] })) : '',
      ),
  );
}

async function toggleBranches() {
  if (T.picking === 'branch') {
    T.picking = false;
    return render();
  }
  T.picking = 'branch';
  T.branches = null;
  render();
  const repo = T.repo;
  try {
    const b = await git.getBranches(ex, repo.path);
    if (T.repo === repo && T.picking === 'branch') T.branches = b;
  } catch (e) {
    T.branches = { error: e.message };
  }
  render();
}

function branchPicker() {
  const B = T.branches;
  if (!B) return h('div', { class: 'tray-picker' }, h('div', { class: 'pop-empty' }, 'Loading branches…'));
  if (B.error) return h('div', { class: 'tray-picker' }, h('div', { class: 'tray-error' }, h('div', { class: 'error-box' }, B.error)));
  const current = T.status.branch.head;
  const byName = new Map(B.local.map((b) => [b.name, b]));
  const shown = new Set();
  const item = (name, time, remote) =>
    h(
      'div',
      { class: 'pop-item' + (name === current ? ' current' : ''), onclick: (e) => pickBranch(e, name, remote) },
      h('span', { html: name === current ? icons.check : icons.branch }),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, name)),
      time && h('span', { class: 'sub' }, ago(time)),
    );
  const section = (title, list) => {
    list = list.filter((b) => b && !shown.has(b.name));
    list.forEach((b) => shown.add(b.name));
    return list.length ? [h('div', { class: 'pop-group' }, title), list.map((b) => item(b.name, b.time, false))] : [];
  };
  const remote = B.remote.filter((b) => !byName.has(b.name.slice(b.name.indexOf('/') + 1)));
  return h(
    'div',
    { class: 'tray-picker' },
    section('Default Branch', [byName.get(B.defaultBranch)]),
    section('Recent Branches', B.recent.map((n) => byName.get(n))),
    section('Other Branches', B.local),
    remote.length ? [h('div', { class: 'pop-group' }, 'Remote Branches'), remote.map((b) => item(b.name, b.time, true))] : [],
  );
}

// With changes, asks like the main window: stash them here or take them along.
function pickBranch(e, name, remote) {
  const st = T.status;
  if (!remote && name === st.branch.head) {
    T.picking = false;
    return render();
  }
  const go = () => (remote ? git.checkoutRemoteBranch(ex, T.repo.path, name) : git.checkoutBranch(ex, T.repo.path, name));
  const run = (fn) => {
    T.picking = false;
    busy('Switching branch', fn);
  };
  if (!st.files.length || !st.branch.head) return run(go);
  const target = remote ? name.slice(name.indexOf('/') + 1) : name;
  const from = st.branch.head;
  openMenu(e.clientX, e.clientY, [
    { label: `${st.files.length} changed file${st.files.length === 1 ? '' : 's'} on ${from}:`, disabled: true },
    {
      label: `Leave them on ${from} (stash)`,
      run: () =>
        run(async () => {
          if (st.stash) await git.dropStash(ex, T.repo.path, st.stash.sha);
          await git.stashChanges(ex, T.repo.path, from);
          await go();
        }),
    },
    { label: `Bring them to ${target}`, run: () => run(go) },
  ]);
}

function statusParts() {
  const st = T.status;
  const files = st.files;
  const out = [];

  out.push(branchRow());

  if (T.error) out.push(h('div', { class: 'banner' }, T.error));
  if (st.stash)
    out.push(
      h(
        'div',
        { class: 'tray-stash' },
        h('span', { html: icons.stack }),
        h('span', { class: 'grow' }, 'Stashed changes', h('span', { class: 'sub' }, ` · ${ago(st.stash.time)}`)),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: !!T.busy, onclick: () => busy('Restoring stash', () => git.restoreStash(ex, T.repo.path, st.stash.sha)) }, 'Restore'),
      ),
    );

  if (!files.length) {
    out.push(h('div', { class: 'tray-files' }, h('div', { class: 'tray-clean' }, h('b', {}, 'No local changes'), T.busy ? `${T.busy}…` : 'Everything on the server is committed.')));
  } else {
    out.push(
      h(
        'div',
        { class: 'tray-files' },
        h(
          'label',
          { class: 'files-title check' },
          h('input', {
            type: 'checkbox',
            checked: checkedFiles().length === files.length,
            indeterminate: checkedFiles().length > 0 && checkedFiles().length < files.length,
            onchange: (e) => {
              if (e.target.checked) T.excluded.clear();
              else for (const f of files) T.excluded.add(f.path);
              render();
            },
          }),
          `${files.length} changed file${files.length === 1 ? '' : 's'}`,
        ),
        files.slice(0, FILES_SHOWN).map((f) => {
          const i = f.path.lastIndexOf('/');
          const toggle = () => {
            if (T.excluded.has(f.path)) T.excluded.delete(f.path);
            else T.excluded.add(f.path);
            render();
          };
          return h(
            'div',
            { class: 'file-row', title: `${f.path}\nDouble-click to open it in RemoteGit`, onclick: toggle, ondblclick: () => openFile(f.path), oncontextmenu: (e) => fileMenu(e, f) },
            h('input', { type: 'checkbox', checked: !T.excluded.has(f.path), onclick: (e) => e.stopPropagation(), onchange: toggle }),
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
          h('button', { class: 'btn', id: 'tray-ai', type: 'button', title: 'Write the message with AI (on the server)', html: T.busy === 'Writing the message' ? icons.spinner : icons.sparkle, disabled: !!T.busy, onclick: generate }),
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
  const n = checkedFiles().length;
  const branch = T.status?.branch.head || 'HEAD';
  btn.disabled = !document.getElementById('tray-summary')?.value.trim() || !!T.busy || !n;
  btn.replaceChildren(
    T.busy ? `${T.busy}…` : `Commit ${n > 1 ? `${n} files ` : ''}to `,
    T.busy ? '' : h('b', {}, branch),
    !T.busy && prefs.pushAfterCommit && T.status?.remote ? ' and push' : '',
  );
}

// ---------------------------------------------------------------- window

function fileMenu(e, f) {
  e.preventDefault();
  const st = T.status;
  openMenu(e.clientX, e.clientY, [
    { label: 'Open in RemoteGit', run: () => openFile(f.path) },
    st.branch.head && {
      label: st.stash ? 'Stash all changes (replaces the stash)' : 'Stash all changes',
      disabled: !!T.busy,
      run: () =>
        busy('Stashing changes', async () => {
          if (st.stash) await git.dropStash(ex, T.repo.path, st.stash.sha);
          await git.stashChanges(ex, T.repo.path, st.branch.head);
        }),
    },
    '-',
    { label: 'Copy relative path', run: () => navigator.clipboard?.writeText(f.path).catch(() => {}) },
  ]);
}

// Shows the main window on this file's diff.
function openFile(path) {
  tauri.event?.emit('show-file', { repoId: T.repo.id, path }).catch(() => {});
  openMain();
}

function openMain() {
  tauri.core.invoke('show_main_window').catch(() => {});
  hide();
}

function hide() {
  try {
    tauri.window?.getCurrentWindow?.().hide();
  } catch {}
}

// Same switches as the main window's settings. The theme lives in the main
// window's store, so it is sent there instead of written from here.
let themeChoice = null;
let version = '';
tauri.app?.getVersion().then((v) => (version = v), () => {});

function settingsPanel() {
  const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
  const theme = themeChoice || main.theme || 'system';
  const pickTheme = (v) => {
    themeChoice = v;
    tauri.event?.emit('set-theme', v).catch(() => {});
    applyTheme();
    render();
  };
  return h(
    'div',
    { class: 'tray-picker' },
    h(
      'div',
      { class: 'settings' },
      h('div', { class: 'settings-label' }, 'Appearance'),
      h('div', { class: 'segmented' }, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) => h('button', { type: 'button', class: v === theme ? 'active' : '', onclick: () => pickTheme(v) }, label))),
      h('div', { class: 'settings-label' }, isMac ? 'Menu bar' : 'System tray'),
      h(
        'label',
        { class: 'check settings-check' },
        h('input', { type: 'checkbox', checked: !!prefs.showInMenuBar, onchange: (e) => { setShowInMenuBar(e.target.checked); render(); } }),
        h('span', {}, h('b', {}, isMac ? 'Show in menu bar' : 'Show in system tray'), h('br'), h('span', { class: 'hint' }, 'Turning it off closes this window; turn it back on in the main window.')),
      ),
      h(
        'label',
        { class: 'check settings-check' },
        h('input', { type: 'checkbox', checked: !!prefs.menuBarOnly, onchange: (e) => { setMenuBarOnly(e.target.checked); render(); } }),
        h('span', {}, h('b', {}, isMac ? 'Hide from the Dock' : 'Hide from the taskbar'), h('br'), h('span', { class: 'hint' }, 'Closing the main window keeps RemoteGit running here.')),
      ),
      version && h('div', { class: 'settings-version' }, h('span', {}, `RemoteGit ${version}`), h('span', {}, 'Updates are checked automatically')),
    ),
  );
}

function applyTheme() {
  const stored = read(MAIN_KEY).theme || 'system';
  if (themeChoice === stored) themeChoice = null;
  const t = themeChoice || stored;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function init() {
  if (!tauri?.core) return;
  applyTheme();
  // This window exists even when the menu bar icon is off, so it stays idle
  // until the icon is turned on. Then: every 4 s while open, and every
  // 5 minutes in the background just for the count next to the icon.
  const iconOn = () => !!read(TRAY_KEY).showInMenuBar;
  let started = false;
  let timer = null;
  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };
  function tick() {
    if (!iconOn()) return schedule(60_000);
    if (!started) {
      started = true;
      selectRepo(read(TRAY_KEY).repoId);
    } else refresh();
    schedule(document.hasFocus() ? 4000 : 300_000);
  }
  try {
    // Behave like a menu: close when the user clicks elsewhere.
    tauri.window?.getCurrentWindow?.().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        applyTheme();
        main = read(MAIN_KEY);
        started = true;
        if (!T.repo || !(main.repos || []).some((r) => r.id === T.repo.id)) selectRepo(read(TRAY_KEY).repoId);
        else refresh();
        schedule(4000);
      } else {
        if (!T.busy) hide();
        schedule(300_000);
      }
    });
  } catch {}
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  // Settings may have changed in the main window while this one was closed.
  window.addEventListener('focus', () => render());
  tick();
}

init();
