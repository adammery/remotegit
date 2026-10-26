import * as git from './git.js';
import { icons, fileIcon } from './icons.js';

const tauri = window.__TAURI__;

// ============================================================ persistence

const STORE_KEY = 'remotegit:v1';
const store = Object.assign(
  { servers: [], repos: [], currentRepoId: null, sidebarWidth: 300, pollSeconds: 3, recentBranches: {} },
  readStore(),
);

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {}
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ============================================================ DOM helpers

function h(tag, props, ...kids) {
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
const $ = (sel) => document.querySelector(sel);
const ico = (name) => h('span', { class: 'ico', html: icons[name] });

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

function avatar(name, small) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  let hash = 0;
  for (const c of name || '') hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return h('span', { class: 'avatar' + (small ? ' small' : ''), style: `background:hsl(${Math.abs(hash) % 360} 45% 42%)`, title: name || '' }, initials);
}

const splitPath = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

function openExternal(url) {
  if (tauri?.opener) return tauri.opener.openUrl(url).catch((e) => toast(String(e), 'error'));
  window.open(url, '_blank');
}

// ============================================================ SSH bridge

class ConnError extends Error {}
const connections = new Map(); // serverId -> Promise of ssh_connect
const connState = new Map(); // serverId -> 'connecting' | 'ok' | 'error'

const targetOf = (s) => ({
  host: s.host,
  user: s.user || null,
  port: s.port ? Number(s.port) : null,
  identityFile: s.identityFile || null,
  forwardAgent: !!s.forwardAgent,
});

function connect(server) {
  connState.set(server.id, 'connecting');
  renderConn();
  const p = tauri.core.invoke('ssh_connect', { id: server.id, target: targetOf(server) }).then(
    () => {
      connState.set(server.id, 'ok');
      renderConn();
    },
    (e) => {
      connections.delete(server.id);
      connState.set(server.id, 'error');
      renderConn();
      throw new ConnError(String(e));
    },
  );
  connections.set(server.id, p);
  return p;
}

async function execOn(server, script, timeoutSecs = 60) {
  if (!connections.has(server.id)) connect(server);
  await connections.get(server.id);
  try {
    const r = await tauri.core.invoke('ssh_exec', { id: server.id, script, timeoutSecs });
    if (connState.get(server.id) !== 'ok') {
      connState.set(server.id, 'ok');
      renderConn();
    }
    return r;
  } catch (e) {
    connState.set(server.id, 'error');
    renderConn();
    throw new ConnError(String(e));
  }
}

function forgetConnection(serverId) {
  connections.delete(serverId);
  connState.delete(serverId);
  tauri.core.invoke('ssh_disconnect', { id: serverId }).catch(() => {});
}

// ============================================================ app state

const S = {
  repo: null,
  server: null,
  gen: 0, // bumps on repo switch; stale responses are dropped
  status: null,
  error: null, // { kind: 'conn' | 'git', message }
  tab: 'changes',
  excluded: new Set(),
  selectedPath: null,
  filter: '',
  diff: null, // { key, text, truncated }
  diffFull: false,
  busy: null, // label of a running network/commit operation
  lastCommit: null, // { sha, summary, repoId } for undo
  history: { commits: [], unpushed: new Set(), done: false, loading: false, oid: undefined },
  selectedSha: null,
  commit: null, // details of selected commit
  commitFile: null,
  commitDiff: null,
};
const ex = (script, timeout) => execOn(S.server, script, timeout);
const hasHead = () => !!S.status?.branch.oid;
const currentFiles = () => S.status?.files || [];

function selectRepo(repoId) {
  const repo = store.repos.find((r) => r.id === repoId) || null;
  S.gen++;
  Object.assign(S, {
    repo,
    server: repo ? store.servers.find((s) => s.id === repo.serverId) : null,
    status: null,
    error: null,
    excluded: new Set(),
    selectedPath: null,
    diff: null,
    diffFull: false,
    lastCommit: null,
    history: { commits: [], unpushed: new Set(), done: false, loading: false, oid: undefined },
    selectedSha: null,
    commit: null,
    commitFile: null,
    commitDiff: null,
  });
  if (repo && !S.server) S.repo = null;
  store.currentRepoId = S.repo?.id || null;
  save();
  $('#summary').value = '';
  $('#description').value = '';
  renderAll();
  if (S.repo) refresh();
}

// ============================================================ refreshing

let statusInFlight = false;

async function refresh() {
  if (!S.repo || statusInFlight) return;
  statusInFlight = true;
  const gen = S.gen;
  try {
    const st = await git.getStatus(ex, S.repo.path);
    if (gen !== S.gen) return;
    const prev = S.status;
    const hadError = !!S.error;
    S.status = st;
    S.error = null;
    const headMoved = !prev || prev.branch.oid !== st.branch.oid || prev.branch.head !== st.branch.head;
    if (!prev || prev.raw !== st.raw || hadError) {
      const paths = new Set(st.files.map((f) => f.path));
      for (const p of S.excluded) if (!paths.has(p)) S.excluded.delete(p);
      const prevSelected = S.selectedPath;
      if (!paths.has(S.selectedPath)) S.selectedPath = st.files[0]?.path || null;
      if (S.selectedPath !== prevSelected) S.diff = null;
      renderToolbar();
      renderChanges();
      // An open diff refreshes itself below; everything else depends on status.
      if (hadError || !prev || (S.tab === 'changes' && (S.selectedPath !== prevSelected || !S.selectedPath)))
        renderContent();
    }
    if (headMoved && S.tab === 'history') loadHistory(true);
    if (S.tab === 'changes') await refreshDiff();
  } catch (e) {
    if (gen !== S.gen) return;
    S.error = { kind: e instanceof ConnError ? 'conn' : 'git', message: e.message };
    renderToolbar();
    renderChanges();
    renderContent();
  } finally {
    statusInFlight = false;
  }
}

async function refreshDiff() {
  const file = currentFiles().find((f) => f.path === S.selectedPath);
  if (!file) {
    if (S.diff) {
      S.diff = null;
      renderContent();
    }
    return;
  }
  const gen = S.gen;
  const key = `${file.path}\0${file.xy}`;
  try {
    const d = await git.getFileDiff(ex, S.repo.path, file, hasHead());
    if (gen !== S.gen || S.selectedPath !== file.path) return;
    if (S.diff && S.diff.key === key && S.diff.text === d.text) return;
    S.diff = { key, ...d };
    renderContent();
  } catch (e) {
    if (gen !== S.gen) return;
    S.diff = { key, error: e.message };
    renderContent();
  }
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const secs = S.error?.kind === 'conn' ? 15 : store.pollSeconds;
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === 'visible' && !S.busy) await refresh();
    schedulePoll();
  }, secs * 1000);
}

// ============================================================ history

async function loadHistory(reset) {
  if (!S.repo) return;
  const H = S.history;
  if (H.loading || (!reset && H.done)) return;
  H.loading = true;
  const gen = S.gen;
  try {
    const skip = reset ? 0 : H.commits.length;
    const { commits, unpushed } = await git.getLog(ex, S.repo.path, { skip, limit: 100 });
    if (gen !== S.gen) return;
    H.commits = reset ? commits : H.commits.concat(commits);
    H.unpushed = unpushed;
    H.done = commits.length < 100;
    H.oid = S.status?.branch.oid;
    if (!H.commits.some((c) => c.sha === S.selectedSha)) {
      S.selectedSha = H.commits[0]?.sha || null;
      S.commit = null;
      if (S.selectedSha) selectCommit(S.selectedSha);
    }
    renderHistory();
    if (S.tab === 'history') renderContent();
  } catch (e) {
    if (gen === S.gen) toast(e.message, 'error', 'Could not load history');
  } finally {
    H.loading = false;
  }
}

async function selectCommit(sha) {
  S.selectedSha = sha;
  S.commitDiff = null;
  renderHistory();
  const gen = S.gen;
  try {
    const c = await git.getCommit(ex, S.repo.path, sha);
    if (gen !== S.gen || S.selectedSha !== sha) return;
    S.commit = c;
    S.commitFile = c.files[0] || null;
    renderContent();
    if (S.commitFile) await loadCommitDiff();
  } catch (e) {
    if (gen === S.gen) toast(e.message, 'error', 'Could not load commit');
  }
}

async function loadCommitDiff() {
  const { commit, commitFile } = S;
  if (!commit || !commitFile) return;
  const gen = S.gen;
  try {
    const d = await git.getCommitFileDiff(ex, S.repo.path, commit.sha, commitFile);
    if (gen !== S.gen || S.commitFile !== commitFile) return;
    S.commitDiff = d;
  } catch (e) {
    S.commitDiff = { error: e.message };
  }
  S.diffFull = false;
  renderContent();
}

// ============================================================ actions

async function withBusy(label, fn) {
  if (S.busy) return;
  S.busy = label;
  renderToolbar();
  renderChanges();
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error', `${label} failed`);
  } finally {
    S.busy = null;
    renderToolbar();
    renderChanges();
    await refresh();
  }
}

function syncAction() {
  const st = S.status;
  if (!st || !st.remote) return null;
  const b = st.branch;
  if (!b.head) return null;
  const remote = st.remote.name;
  if (!b.upstream) return { kind: 'publish', title: 'Publish branch', icon: 'upload', run: () => git.push(ex, S.repo.path, { remote, hasUpstream: false }) };
  if (b.behind > 0) return { kind: 'pull', title: `Pull ${remote}`, icon: 'down', run: () => git.pull(ex, S.repo.path) };
  if (b.ahead > 0) return { kind: 'push', title: `Push ${remote}`, icon: 'up', run: () => git.push(ex, S.repo.path, { remote, hasUpstream: true }) };
  return { kind: 'fetch', title: `Fetch ${remote}`, icon: 'sync', run: () => git.fetchRemote(ex, S.repo.path, remote) };
}

function runSync(action = syncAction()) {
  if (!action) return;
  const verbs = { publish: 'Publishing branch', pull: 'Pulling', push: 'Pushing', fetch: 'Fetching' };
  return withBusy(verbs[action.kind], async () => {
    await action.run();
    if (action.kind === 'push' || action.kind === 'publish') S.lastCommit = null;
    if (S.tab === 'history') loadHistory(true);
  });
}

function checkedFiles() {
  return currentFiles().filter((f) => !S.excluded.has(f.path));
}

async function doCommit(ev) {
  ev?.preventDefault();
  const summary = $('#summary').value.trim();
  const files = checkedFiles();
  if (!summary || !files.length || S.busy || !S.repo) return;
  await withBusy('Commit', async () => {
    const sha = await git.commit(ex, S.repo.path, {
      files,
      all: files.length === currentFiles().length,
      summary,
      description: $('#description').value,
    });
    S.lastCommit = { sha, summary, repoId: S.repo.id };
    $('#summary').value = '';
    $('#description').value = '';
    S.excluded.clear();
    S.history.oid = undefined;
  });
}

async function undoLastCommit() {
  const lc = S.lastCommit;
  if (!lc) return;
  await withBusy('Undo', async () => {
    await git.undoCommit(ex, S.repo.path, lc.sha);
    S.lastCommit = null;
    if (!$('#summary').value) $('#summary').value = lc.summary;
  });
}

function confirmDiscard(files) {
  const many = files.length > 1;
  confirmModal({
    title: many ? `Discard ${files.length} changes?` : 'Discard changes?',
    message: many
      ? 'Changes in these files will be permanently lost on the server.'
      : `Changes to “${files[0].path}” will be permanently lost on the server.`,
    confirm: 'Discard changes',
    danger: true,
    onConfirm: () => withBusy('Discard', () => git.discard(ex, S.repo.path, files)),
  });
}

function vscodeUrl() {
  const s = S.server;
  const host = (s.user ? `${s.user}@` : '') + s.host;
  return `vscode://vscode-remote/ssh-remote+${encodeURI(host)}${encodeURI(S.repo.path)}`;
}

function sshCommand() {
  const s = S.server;
  const parts = ['ssh', '-t'];
  if (s.port) parts.push('-p', String(s.port));
  if (s.identityFile) parts.push('-i', JSON.stringify(s.identityFile));
  parts.push((s.user ? `${s.user}@` : '') + s.host);
  parts.push(`"cd ${git.q(S.repo.path)} && exec bash -l"`);
  return parts.join(' ');
}

// ============================================================ rendering

function renderAll() {
  document.documentElement.style.setProperty('--sidebar-w', `${store.sidebarWidth}px`);
  renderToolbar();
  renderTabs();
  renderChanges();
  renderHistory();
  renderContent();
  renderConn();
}

function renderConn() {
  const el = $('#conn');
  if (!S.server) {
    el.hidden = true;
    return;
  }
  const state = connState.get(S.server.id);
  el.hidden = false;
  el.replaceChildren(
    h('span', { class: 'dot ' + ({ ok: 'ok', connecting: 'busy', error: 'err' }[state] || '') }),
    S.server.name || S.server.host,
  );
  el.title = { ok: 'Connected', connecting: 'Connecting…', error: 'Not connected' }[state] || '';
}

function renderToolbar() {
  const st = S.status;
  $('#tb-repo-name').textContent = S.repo ? S.repo.name : 'None';
  $('#tb-repo').title = S.repo ? `${S.server?.name || S.server?.host}:${S.repo.path}` : '';

  const branchBtn = $('#tb-branch');
  branchBtn.disabled = !st;
  $('#tb-branch-name').textContent = !st ? '—' : st.branch.head || `Detached at ${st.branch.oid?.slice(0, 7) || '?'}`;

  const syncBtn = $('#tb-sync');
  const action = syncAction();
  const title = $('#sync-title');
  const sub = $('#sync-sub');
  const counts = $('#sync-counts');
  counts.replaceChildren();
  syncBtn.disabled = !action || !!S.busy;
  if (S.busy) {
    $('#sync-icon').innerHTML = icons.spinner;
    title.textContent = `${S.busy}…`;
    sub.textContent = S.server?.name || '';
    return;
  }
  if (!st) {
    $('#sync-icon').innerHTML = icons.sync;
    title.textContent = 'Fetch origin';
    sub.textContent = S.repo ? (S.error ? 'Unavailable' : 'Loading…') : '';
    return;
  }
  if (!action) {
    $('#sync-icon').innerHTML = icons.sync;
    title.textContent = st.remote ? 'Fetch origin' : 'No remote';
    sub.textContent = st.remote ? 'Not on a branch' : 'This repository has no remote';
    return;
  }
  $('#sync-icon').innerHTML = icons[action.icon];
  title.textContent = action.title;
  sub.textContent =
    action.kind === 'publish' ? `Publish this branch to ${st.remote.name}` : `Last fetched ${ago(st.lastFetched)}`;
  if (action.kind !== 'publish') {
    if (st.branch.behind) counts.append(h('span', {}, String(st.branch.behind), h('span', { html: icons.down })));
    if (st.branch.ahead) counts.append(h('span', {}, String(st.branch.ahead), h('span', { html: icons.up })));
  }
}

function renderTabs() {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === S.tab);
  $('#changes-pane').hidden = S.tab !== 'changes';
  $('#history-pane').hidden = S.tab !== 'history';
}

const MAX_ROWS = 2000;

function renderChanges() {
  const files = currentFiles();
  const shown = S.filter ? files.filter((f) => f.path.toLowerCase().includes(S.filter.toLowerCase())) : files;
  const checked = files.filter((f) => !S.excluded.has(f.path)).length;

  $('#changes-count').textContent = files.length ? `(${files.length})` : '';
  $('#files-count').textContent = `${files.length} changed file${files.length === 1 ? '' : 's'}`;
  const all = $('#check-all');
  all.checked = files.length > 0 && checked === files.length;
  all.indeterminate = checked > 0 && checked < files.length;
  all.disabled = !files.length;

  const banner = $('#state-banner');
  const state = S.status?.state || [];
  const conflicts = files.filter((f) => f.kind === 'conflicted').length;
  banner.hidden = !state.length && !conflicts;
  banner.textContent = state.includes('REBASE')
    ? 'A rebase is in progress on the server. Finish it there (git rebase --continue).'
    : conflicts
      ? `${conflicts} conflicted file${conflicts > 1 ? 's' : ''}. Resolve them, then commit to finish the merge.`
      : state.length
        ? `${state[0].replace('_HEAD', '').toLowerCase().replace('_', '-')} in progress — commit to finish it.`
        : '';

  const list = $('#file-list');
  const rows = shown.slice(0, MAX_ROWS).map((f) => fileRow(f));
  if (shown.length > MAX_ROWS) rows.push(h('div', { class: 'list-note' }, `…and ${shown.length - MAX_ROWS} more files`));
  if (S.filter && !shown.length && files.length) rows.push(h('div', { class: 'list-note' }, 'No files match the filter.'));
  list.replaceChildren(...rows);

  updateCommitButton();
  $('#avatar').replaceWith(Object.assign(avatar(S.status?.user.name), { id: 'avatar' }));

  const undo = $('#undo-bar');
  const lc = S.lastCommit;
  undo.hidden = !(lc && lc.repoId === S.repo?.id);
  if (!undo.hidden) {
    undo.replaceChildren(
      h('span', { html: icons.commit }),
      h('span', { class: 'grow', title: lc.summary }, 'Committed: ', h('b', {}, lc.summary)),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: undoLastCommit, disabled: !!S.busy }, 'Undo'),
    );
  }
}

function updateCommitButton() {
  const btn = $('#commit-btn');
  const branch = S.status?.branch.head || 'HEAD';
  btn.replaceChildren(S.busy === 'Commit' ? 'Committing…' : 'Commit to ', S.busy === 'Commit' ? '' : h('b', {}, branch));
  btn.disabled = !S.status || !checkedFiles().length || !$('#summary').value.trim() || !!S.busy;
}

// Keeps punctuation in place inside left-truncating (rtl) path labels.
const ltr = (s) => `\u200e${s}\u200e`;

function fileRow(f) {
  const [dir, name] = splitPath(f.path);
  const label = f.orig
    ? [h('span', { class: 'dir' }, ltr(f.orig + ' → ' + dir)), h('span', { class: 'name' }, name)]
    : [h('span', { class: 'dir' }, ltr(dir)), h('span', { class: 'name' }, name)];
  const row = h(
    'div',
    {
      class: 'file-row' + (f.path === S.selectedPath ? ' selected' : ''),
      title: f.orig ? `${f.orig} → ${f.path}` : f.path,
      onclick: () => selectFile(f.path),
      oncontextmenu: (e) => fileMenu(e, f),
    },
    h('input', {
      type: 'checkbox',
      checked: !S.excluded.has(f.path),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.checked) S.excluded.delete(f.path);
        else S.excluded.add(f.path);
        renderChanges();
      },
    }),
    h('span', { class: 'file-path' }, label),
    h('span', { class: `file-status ${f.kind}`, title: f.kind, html: fileIcon(f.kind) }),
  );
  return row;
}

function selectFile(path) {
  if (S.selectedPath === path) return;
  S.selectedPath = path;
  S.diff = null;
  S.diffFull = false;
  renderChanges();
  renderContent();
  refreshDiff();
}

function fileMenu(e, f) {
  e.preventDefault();
  const selectedFiles = checkedFiles();
  const items = [
    { label: 'Discard changes…', danger: true, run: () => confirmDiscard([f]) },
    selectedFiles.length > 1 && { label: `Discard ${selectedFiles.length} selected changes…`, danger: true, run: () => confirmDiscard(selectedFiles) },
    '-',
    f.xy === '??' && { label: 'Ignore file (add to .gitignore)', run: () => withBusy('Ignore', () => git.ignorePath(ex, S.repo.path, f.path)) },
    { label: 'Copy file path', run: () => copyText(`${S.repo.path}/${f.path}`) },
    { label: 'Copy relative path', run: () => copyText(f.path) },
  ];
  openMenu(e.clientX, e.clientY, items);
}

function renderHistory() {
  const H = S.history;
  const list = $('#commit-list');
  const rows = H.commits.map((c) =>
    h(
      'div',
      {
        class: 'commit-row' + (c.sha === S.selectedSha ? ' selected' : ''),
        dataset: { sha: c.sha },
        onclick: () => selectCommit(c.sha),
        oncontextmenu: (e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, [
            { label: 'Copy SHA', run: () => copyText(c.sha) },
            { label: 'Copy summary', run: () => copyText(c.summary) },
          ]);
        },
      },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'commit-summary', title: c.summary }, c.summary),
        h('div', { class: 'commit-meta' }, avatar(c.author, true), `${c.author} • ${ago(c.time)}`),
      ),
      H.unpushed.has(c.sha) && h('span', { class: 'unpushed', title: 'Not pushed yet', html: icons.up }),
    ),
  );
  if (!H.commits.length) rows.push(h('div', { class: 'list-note' }, H.loading ? 'Loading…' : 'No commits yet.'));
  list.replaceChildren(...rows);
}

function renderContent() {
  const root = $('#content');
  const key = S.tab === 'history' ? `h:${S.selectedSha}:${S.commitFile?.path}` : `c:${S.selectedPath}`;
  const old = root.querySelector('.diff');
  const scroll = root.dataset.key === key && old ? [old.scrollTop, old.scrollLeft] : null;
  root.replaceChildren(...[contentView()].flat());
  root.dataset.key = key;
  const diff = root.querySelector('.diff');
  if (scroll && diff) [diff.scrollTop, diff.scrollLeft] = scroll;
}

function contentView() {
  if (!store.servers.length) return welcomeView();
  if (!S.repo) return noRepoView();
  if (S.error) return errorView();
  if (!S.status) return h('div', { class: 'diff-notice' }, 'Loading…');
  if (S.tab === 'history') return historyView();
  const file = currentFiles().find((f) => f.path === S.selectedPath);
  if (!file) return noChangesView();
  return [
    h('div', { class: 'diff-header' }, h('span', { class: `file-status ${file.kind}`, html: fileIcon(file.kind) }), h('span', { class: 'path' }, ltr(file.orig ? `${file.orig} → ${file.path}` : file.path))),
    diffView(S.diff),
  ];
}

function blank(title, lead, cards) {
  return h('div', { class: 'blank' }, h('div', { class: 'blank-inner' }, h('h1', {}, title), h('p', { class: 'lead' }, lead), cards && h('div', { class: 'cards' }, cards)));
}

function card({ title, sub, button, onclick, primary, highlight }) {
  return h(
    'div',
    { class: 'card' + (highlight ? ' highlight' : '') },
    h('div', { class: 'grow' }, h('div', { class: 'card-title' }, title), sub && h('div', { class: 'card-sub' }, sub)),
    h('button', { class: 'btn' + (primary ? ' btn-primary' : ''), type: 'button', onclick, disabled: primary && !!S.busy }, button),
  );
}

function welcomeView() {
  return blank('Welcome to RemoteGit', 'Work with Git repositories that live on your servers, over SSH — like GitHub Desktop, but remote.', [
    card({ title: 'Add a server', sub: 'Uses your SSH keys and ~/.ssh/config. Nothing to install on the server besides git.', button: 'Add server', onclick: () => serverModal(), primary: true }),
  ]);
}

function noRepoView() {
  return blank('No repository selected', 'Pick a repository from the toolbar, or add one from a server.', [
    card({ title: 'Add a repository', sub: 'Scan a server for Git repositories or enter a path.', button: 'Add repository', onclick: () => addRepoModal(), primary: true }),
    card({ title: 'Add another server', sub: 'Connect to a different machine over SSH.', button: 'Add server', onclick: () => serverModal() }),
  ]);
}

function errorView() {
  const conn = S.error.kind === 'conn';
  return h(
    'div',
    { class: 'blank' },
    h(
      'div',
      { class: 'blank-inner' },
      h('h1', {}, conn ? `Can’t reach ${S.server.name || S.server.host}` : 'Can’t read this repository'),
      h('p', { class: 'lead' }, conn ? 'The SSH connection failed. RemoteGit will keep retrying in the background.' : S.repo.path),
      h('div', { class: 'error-box' }, S.error.message),
      conn &&
        h('p', { class: 'hint' }, 'RemoteGit signs in with SSH keys (no password prompts). Check that “ssh ', (S.server.user ? S.server.user + '@' : '') + S.server.host, '” works in a terminal without asking for a password — e.g. run ssh-copy-id first.'),
      h(
        'div',
        { style: 'display:flex;gap:8px;margin-top:16px' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { forgetConnection(S.server.id); refresh(); } }, 'Try again'),
        conn && h('button', { class: 'btn', type: 'button', onclick: () => serverModal(S.server) }, 'Edit server'),
        !conn && h('button', { class: 'btn', type: 'button', onclick: () => removeRepo(S.repo) }, 'Remove from list'),
      ),
    ),
  );
}

function noChangesView() {
  const st = S.status;
  const action = syncAction();
  const cards = [];
  if (action?.kind === 'push')
    cards.push(card({ highlight: true, primary: true, title: `Push commits to the ${st.remote.name} remote`, sub: `You have ${st.branch.ahead} local commit${st.branch.ahead > 1 ? 's' : ''} waiting to be pushed.`, button: `Push ${st.remote.name}`, onclick: () => runSync(action) }));
  if (action?.kind === 'pull')
    cards.push(card({ highlight: true, primary: true, title: `Pull ${st.branch.behind} commit${st.branch.behind > 1 ? 's' : ''} from ${st.remote.name}`, sub: 'The remote branch has commits you don’t have yet.', button: `Pull ${st.remote.name}`, onclick: () => runSync(action) }));
  if (action?.kind === 'publish')
    cards.push(card({ highlight: true, primary: true, title: 'Publish your branch', sub: `“${st.branch.head}” doesn’t exist on ${st.remote.name} yet.`, button: 'Publish branch', onclick: () => runSync(action) }));
  cards.push(card({ title: 'Open the repository in Visual Studio Code', sub: 'Opens on the server through the Remote - SSH extension.', button: 'Open in VS Code', onclick: () => openExternal(vscodeUrl()) }));
  cards.push(card({ title: 'Open a terminal in this repository', sub: 'Copies an ssh command that lands in this folder.', button: 'Copy SSH command', onclick: () => copyText(sshCommand()) }));
  const web = git.webUrl(st.remote?.url);
  if (web) {
    const host = new URL(web).hostname.replace(/^www\./, '');
    const site = host === 'github.com' ? 'GitHub' : host === 'gitlab.com' ? 'GitLab' : host;
    cards.push(card({ title: `Open the repository page on ${site} in your browser`, sub: web, button: `View on ${site}`, onclick: () => openExternal(web) }));
  }
  return blank('No local changes', 'There are no uncommitted changes in this repository. Here are some friendly suggestions for what to do next.', cards);
}

const DIFF_LINE_CAP = 5000;

function diffView(d) {
  if (!d) return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, 'Loading diff…'));
  if (d.error) return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, h('div', { class: 'error-box' }, d.error)));
  const parsed = git.parseDiff(d.text);
  if (parsed.binary) return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, 'This binary file has changed.'));
  if (!parsed.hunks.length)
    return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, parsed.notes.length ? parsed.notes.join('\n') : 'No content changes (empty file).'));

  const total = parsed.hunks.reduce((n, hk) => n + hk.lines.length + 1, 0);
  const cap = S.diffFull ? Infinity : DIFF_LINE_CAP;
  const frag = document.createDocumentFragment();
  let count = 0;
  outer: for (const hk of parsed.hunks) {
    frag.append(h('div', { class: 'dl hunk' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'code' }, hk.header)));
    for (const l of hk.lines) {
      if (++count > cap) break outer;
      frag.append(
        h('div', { class: `dl ${l.t}` }, h('span', { class: 'ln' }, l.o ?? ''), h('span', { class: 'ln' }, l.n ?? ''), h('span', { class: 'code' }, l.text || ' ')),
      );
    }
  }
  const table = h('div', { class: 'diff-table' }, frag);
  const extras = [];
  if (count > cap)
    extras.push(h('div', { class: 'diff-notice' }, `Showing ${cap} of ${total} lines.`, h('br'), h('button', { class: 'btn', type: 'button', onclick: () => { S.diffFull = true; renderContent(); } }, 'Show the whole diff')));
  if (d.truncated) extras.push(h('div', { class: 'diff-notice' }, 'This diff is larger than 2 MB and was cut off.'));
  return h('div', { class: 'diff' }, table, extras);
}

function historyView() {
  const c = S.commit;
  if (!c) return h('div', { class: 'diff-notice' }, S.history.commits.length ? 'Loading…' : 'No commits yet.');
  const head = h(
    'div',
    { class: 'commit-detail-head' },
    h('h2', {}, c.summary),
    c.body && h('div', { class: 'body' }, c.body),
    h(
      'div',
      { class: 'meta' },
      h('span', {}, avatar(c.author, true), c.author),
      h('span', { class: 'sha', title: 'Click to copy', style: 'cursor:pointer', onclick: () => copyText(c.sha) }, h('span', { html: icons.commit }), c.sha.slice(0, 7)),
      h('span', { title: new Date(c.time * 1000).toLocaleString() }, ago(c.time)),
      h('span', {}, `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}`),
    ),
  );
  const files = h(
    'div',
    { class: 'file-list', tabindex: '0' },
    c.files.map((f) => {
      const [dir, name] = splitPath(f.path);
      return h(
        'div',
        {
          class: 'file-row' + (f === S.commitFile ? ' selected' : ''),
          title: f.orig ? `${f.orig} → ${f.path}` : f.path,
          onclick: () => {
            S.commitFile = f;
            S.commitDiff = null;
            renderContent();
            loadCommitDiff();
          },
        },
        h('span', { class: 'file-path' }, h('span', { class: 'dir' }, ltr((f.orig ? f.orig + ' → ' : '') + dir)), h('span', { class: 'name' }, name)),
        h('span', { class: `file-status ${f.kind}`, html: fileIcon(f.kind) }),
      );
    }),
  );
  const diffCol = h('div', { class: 'diff-col' }, S.commitFile ? diffView(S.commitDiff) : h('div', { class: 'diff-notice' }, 'No file changes in this commit.'));
  return [head, h('div', { class: 'split' }, files, diffCol)];
}

// ============================================================ popovers

let popover = null;

function closePopover() {
  if (!popover) return;
  popover.anchor.classList.remove('open');
  popover.el.remove();
  popover = null;
}

function openPopover(anchor, build, width) {
  const same = popover?.anchor === anchor;
  closePopover();
  if (same) return;
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'popover', style: `left:${r.left}px;top:${r.bottom}px;width:${width || r.width}px` });
  popover = { el, anchor };
  anchor.classList.add('open');
  $('#popover-root').append(el);
  build(el);
  el.querySelector('input')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (popover && !popover.el.contains(e.target) && !popover.anchor.contains(e.target)) closePopover();
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
});

function repoPopover() {
  openPopover($('#tb-repo'), (el) => {
    const filter = h('input', { type: 'search', placeholder: 'Filter repositories', oninput: () => fill() });
    const body = h('div', { class: 'pop-body' });
    const fill = () => {
      const term = filter.value.toLowerCase();
      const groups = store.servers.map((s) => {
        const repos = store.repos.filter((r) => r.serverId === s.id && (r.name + r.path).toLowerCase().includes(term));
        return [
          h(
            'div',
            { class: 'pop-group' },
            h('span', { class: 'dot ' + ({ ok: 'ok', connecting: 'busy', error: 'err' }[connState.get(s.id)] || '') }),
            h('span', { class: 'grow', title: s.host }, s.name || s.host),
            h('button', { class: 'btn-icon', type: 'button', title: 'Add repository from this server', html: icons.plus, onclick: () => { closePopover(); addRepoModal(s); } }),
            h('button', { class: 'btn-icon', type: 'button', title: 'Server settings', html: icons.gear, onclick: () => { closePopover(); serverModal(s); } }),
          ),
          repos.length
            ? repos.map((r) =>
                h(
                  'div',
                  { class: 'pop-item' + (r.id === S.repo?.id ? ' current' : ''), onclick: () => { closePopover(); selectRepo(r.id); } },
                  h('span', { html: icons.repo }),
                  h('div', { class: 'grow' }, h('div', { class: 'title' }, r.name), h('div', { class: 'sub' }, r.path)),
                  h('button', { class: 'btn-icon', type: 'button', title: 'Remove from list (keeps files)', html: icons.x, onclick: (e) => { e.stopPropagation(); removeRepo(r); fill(); } }),
                ),
              )
            : h('div', { class: 'pop-empty' }, term ? 'No matches' : 'No repositories added yet'),
        ];
      });
      body.replaceChildren(...groups.flat(Infinity), store.servers.length ? '' : h('div', { class: 'pop-empty' }, 'Add a server to get started.'));
    };
    fill();
    el.append(
      h('div', { class: 'pop-head' }, filter),
      body,
      h(
        'div',
        { class: 'pop-foot' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: !store.servers.length, onclick: () => { closePopover(); addRepoModal(); } }, h('span', { html: icons.plus }), 'Add repository'),
        h('button', { class: 'btn', type: 'button', onclick: () => { closePopover(); serverModal(); } }, h('span', { html: icons.server }), 'Add server'),
      ),
    );
  }, 360);
}

function branchPopover() {
  if (!S.status) return;
  openPopover($('#tb-branch'), async (el) => {
    const filter = h('input', { type: 'search', placeholder: 'Filter branches', oninput: () => fill() });
    const body = h('div', { class: 'pop-body' }, h('div', { class: 'pop-empty' }, 'Loading…'));
    el.append(
      h('div', { class: 'pop-head' }, filter, h('button', { class: 'btn', type: 'button', onclick: () => { closePopover(); newBranchModal(); } }, 'New branch')),
      body,
    );
    let data = { local: [], remote: [] };
    const current = S.status.branch.head;
    const item = (name, sub, onclick, isCurrent) =>
      h('div', { class: 'pop-item' + (isCurrent ? ' current' : ''), onclick }, h('span', { html: isCurrent ? icons.check : icons.branch }), h('div', { class: 'grow' }, h('div', { class: 'title' }, name), sub && h('div', { class: 'sub' }, sub)));
    const fill = () => {
      const term = filter.value.toLowerCase();
      const local = data.local.filter((b) => b.name.toLowerCase().includes(term));
      const localNames = new Set(data.local.map((b) => b.name));
      const remote = data.remote.filter((b) => b.name.toLowerCase().includes(term) && !localNames.has(b.name.slice(b.name.indexOf('/') + 1)));
      body.replaceChildren(
        ...[
          h('div', { class: 'pop-group' }, 'Local branches'),
          local.length ? local.slice(0, 300).map((b) => item(b.name, ago(b.time), () => switchBranch(b.name, false), b.name === current)) : h('div', { class: 'pop-empty' }, 'No matches'),
          remote.length ? [h('div', { class: 'pop-group' }, 'Remote branches'), remote.slice(0, 300).map((b) => item(b.name, ago(b.time), () => switchBranch(b.name, true)))] : '',
        ].flat(Infinity),
      );
    };
    try {
      data = await git.getBranches(ex, S.repo.path);
      fill();
    } catch (e) {
      body.replaceChildren(h('div', { class: 'pop-empty' }, h('div', { class: 'error-box' }, e.message)));
    }
  }, 320);
}

function switchBranch(name, remote) {
  closePopover();
  if (!remote && name === S.status?.branch.head) return;
  withBusy('Switching branch', async () => {
    if (remote) await git.checkoutRemoteBranch(ex, S.repo.path, name);
    else await git.checkoutBranch(ex, S.repo.path, name);
    S.lastCommit = null;
  });
}

let menuEl = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
function openMenu(x, y, items) {
  closeMenu();
  menuEl = h(
    'div',
    { class: 'menu' },
    items.filter(Boolean).map((it) =>
      it === '-' ? h('div', { class: 'menu-sep' }) : h('div', { class: 'menu-item' + (it.danger ? ' danger' : ''), onclick: () => { closeMenu(); it.run(); } }, it.label),
    ),
  );
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}

// ============================================================ modals

function openModal({ title, body, foot, wide, onClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.append(
    h(
      'div',
      { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'btn-icon', type: 'button', html: icons.x, onclick: close })),
      h('div', { class: 'modal-body' }, body),
      foot && h('div', { class: 'modal-foot' }, foot(close)),
    ),
  );
  backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  $('#modal-root').append(backdrop);
  backdrop.querySelector('input:not([type=checkbox]), textarea, .btn-primary')?.focus();
  return close;
}

function confirmModal({ title, message, confirm, danger, onConfirm }) {
  openModal({
    title,
    body: h('p', { style: 'margin:0' }, message),
    foot: (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'button', onclick: () => { close(); onConfirm(); } }, confirm),
    ],
  });
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint));

function serverModal(existing) {
  const s = existing || {};
  const name = h('input', { value: s.name || '', placeholder: 'My server' });
  const host = h('input', { value: s.host || '', placeholder: 'example.com, 10.0.0.5 or a ~/.ssh/config alias', spellcheck: false });
  const user = h('input', { value: s.user || '', placeholder: 'from ssh config', spellcheck: false });
  const port = h('input', { type: 'number', value: s.port || '', placeholder: '22', min: 1, max: 65535 });
  const key = h('input', { value: s.identityFile || '', placeholder: '~/.ssh/id_ed25519 (optional)', spellcheck: false });
  const agent = h('input', { type: 'checkbox', checked: !!s.forwardAgent });
  const error = h('div', { class: 'form-error' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, existing ? 'Save' : 'Connect');

  const body = [
    field('Name', name),
    field('Host', host),
    h('div', { class: 'field-row' }, field('User', user), field('Port', port)),
    field('SSH key', key, 'Leave empty to use your SSH agent and ~/.ssh/config.'),
    h('label', { class: 'check' }, agent, h('span', {}, h('b', {}, 'Forward my SSH agent'), h('br'), h('span', { class: 'hint' }, 'Lets push/pull on the server use the keys from this computer (e.g. for GitHub).'))),
    error,
  ];

  openModal({
    title: existing ? 'Server settings' : 'Add a server',
    body,
    foot: (close) => [
      existing && h('button', { class: 'btn btn-danger left', type: 'button', onclick: () => { close(); removeServer(existing); } }, 'Remove server'),
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      saveBtn,
    ],
  });

  saveBtn.addEventListener('click', async () => {
    const draft = {
      id: s.id || uid(),
      name: name.value.trim() || host.value.trim(),
      host: host.value.trim(),
      user: user.value.trim(),
      port: port.value ? Number(port.value) : null,
      identityFile: key.value.trim(),
      forwardAgent: agent.checked,
    };
    if (!draft.host) {
      error.textContent = 'Enter a host.';
      return;
    }
    error.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Connecting…';
    forgetConnection(draft.id);
    try {
      await connect(draft);
    } catch (e) {
      error.textContent = e.message;
      saveBtn.disabled = false;
      saveBtn.textContent = existing ? 'Save' : 'Connect';
      return;
    }
    const i = store.servers.findIndex((x) => x.id === draft.id);
    if (i >= 0) store.servers[i] = draft;
    else store.servers.push(draft);
    save();
    $('#modal-root').replaceChildren();
    if (S.server?.id === draft.id) {
      S.server = draft;
      S.error = null;
      refresh();
    }
    renderAll();
    if (!existing) addRepoModal(draft);
  });
}

function removeServer(server) {
  confirmModal({
    title: `Remove ${server.name || server.host}?`,
    message: 'The server and its repositories are removed from RemoteGit. Nothing is deleted on the server.',
    confirm: 'Remove',
    danger: true,
    onConfirm: () => {
      forgetConnection(server.id);
      store.servers = store.servers.filter((s) => s.id !== server.id);
      store.repos = store.repos.filter((r) => r.serverId !== server.id);
      save();
      if (S.server?.id === server.id) selectRepo(store.repos[0]?.id);
      else renderAll();
    },
  });
}

function removeRepo(repo) {
  store.repos = store.repos.filter((r) => r.id !== repo.id);
  save();
  if (S.repo?.id === repo.id) selectRepo(store.repos[0]?.id);
}

function addRepos(server, paths) {
  let last = null;
  for (const path of paths) {
    const found = store.repos.find((r) => r.serverId === server.id && r.path === path);
    if (found) {
      last = found;
      continue;
    }
    last = { id: uid(), serverId: server.id, path, name: path.split('/').filter(Boolean).pop() || path };
    store.repos.push(last);
  }
  store.repos.sort((a, b) => a.name.localeCompare(b.name));
  save();
  if (last) selectRepo(last.id);
}

function addRepoModal(preselected) {
  if (!store.servers.length) return serverModal();
  let server = preselected || S.server || store.servers[0];
  const serverSelect = h(
    'select',
    { onchange: () => { server = store.servers.find((s) => s.id === serverSelect.value); scan(); } },
    store.servers.map((s) => h('option', { value: s.id, selected: s.id === server.id }, s.name || s.host)),
  );
  const list = h('div', { class: 'repo-scan' }, h('div', { class: 'pop-empty' }, 'Scanning…'));
  const manual = h('input', { placeholder: '/home/me/project or ~/project', spellcheck: false });
  const error = h('div', { class: 'form-error' });
  const addBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Add selected');
  const picked = new Set();
  let home = '';

  const scan = async () => {
    picked.clear();
    addBtn.disabled = true;
    list.replaceChildren(h('div', { class: 'pop-empty' }, `Looking for repositories on ${server.name || server.host}…`));
    try {
      const res = await git.findRepos((script, t) => execOn(server, script, t));
      home = res.home;
      const known = new Set(store.repos.filter((r) => r.serverId === server.id).map((r) => r.path));
      list.replaceChildren(
        ...(res.repos.length
          ? res.repos.map((p) => {
              const added = known.has(p);
              const cb = h('input', { type: 'checkbox', checked: added, disabled: added, onchange: (e) => { e.target.checked ? picked.add(p) : picked.delete(p); addBtn.disabled = !picked.size; addBtn.textContent = picked.size > 1 ? `Add ${picked.size} repositories` : 'Add selected'; } });
              const short = home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
              return h('label', {}, cb, h('div', { class: 'grow' }, h('div', {}, p.split('/').pop(), added ? h('span', { class: 'hint' }, ' — already added') : ''), h('div', { class: 'path' }, short)));
            })
          : [h('div', { class: 'pop-empty' }, 'No repositories found in ~, /var/www or /srv. Enter a path below.')]),
      );
    } catch (e) {
      list.replaceChildren(h('div', { class: 'pop-empty' }, h('div', { class: 'error-box' }, e.message)));
    }
  };

  const addManual = async () => {
    const path = manual.value.trim();
    if (!path) return;
    error.textContent = '';
    try {
      const top = await git.resolveRepo((script, t) => execOn(server, script, t), path);
      $('#modal-root').replaceChildren();
      addRepos(server, [top]);
    } catch (e) {
      error.textContent = /not a git repository/i.test(e.message) ? `${path} is not a Git repository.` : e.message;
    }
  };
  manual.addEventListener('keydown', (e) => e.key === 'Enter' && addManual());

  addBtn.addEventListener('click', () => {
    $('#modal-root').replaceChildren();
    addRepos(server, [...picked]);
  });

  openModal({
    title: 'Add repository',
    wide: true,
    body: [
      store.servers.length > 1 && field('Server', serverSelect),
      h('div', { class: 'field' }, h('span', {}, 'Repositories found on the server'), list),
      h('div', { class: 'field' }, h('span', {}, 'Or enter a path'), h('div', { style: 'display:flex;gap:8px' }, manual, h('button', { class: 'btn', type: 'button', onclick: addManual }, 'Add'))),
      error,
    ],
    foot: (close) => [h('button', { class: 'btn left', type: 'button', onclick: scan }, 'Rescan'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), addBtn],
  });
  manual.style.flex = '1';
  scan();
}

function newBranchModal() {
  const name = h('input', { placeholder: 'feature/my-change', spellcheck: false });
  const error = h('div', { class: 'form-error' });
  const create = async (close) => {
    const n = name.value.trim().replace(/\s+/g, '-');
    if (!n) return;
    try {
      await git.createBranch(ex, S.repo.path, n);
      close();
      S.lastCommit = null;
      refresh();
    } catch (e) {
      error.textContent = e.message;
    }
  };
  let closeFn;
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create(closeFn));
  closeFn = openModal({
    title: 'Create a branch',
    body: [field('Name', name, `Based on ${S.status.branch.head || 'the current commit'}. Uncommitted changes come along.`), error],
    foot: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => create(close) }, 'Create branch')],
  });
}

// ============================================================ toasts

function toast(message, kind = 'info', title) {
  const el = h(
    'div',
    { class: 'toast ' + kind },
    h('div', { class: 'msg' }, title && h('b', {}, title), message),
    h('button', { class: 'btn-icon', type: 'button', html: icons.x, onclick: () => el.remove() }),
  );
  $('#toast-root').append(el);
  if (kind !== 'error') setTimeout(() => el.remove(), 2500);
  else setTimeout(() => el.remove(), 15000);
}

// ============================================================ wiring

function setTab(tab) {
  if (S.tab === tab) return;
  S.tab = tab;
  renderTabs();
  if (tab === 'history' && S.repo && (S.history.oid !== S.status?.branch.oid || !S.history.commits.length)) loadHistory(true);
  renderContent();
  if (tab === 'changes') refreshDiff();
}

function moveSelection(delta) {
  if (S.tab === 'changes') {
    const files = currentFiles().filter((f) => !S.filter || f.path.toLowerCase().includes(S.filter.toLowerCase()));
    const i = files.findIndex((f) => f.path === S.selectedPath);
    const next = files[Math.max(0, Math.min(files.length - 1, i + delta))];
    if (next) {
      selectFile(next.path);
      $('#file-list .selected')?.scrollIntoView({ block: 'nearest' });
    }
  } else {
    const list = S.history.commits;
    const i = list.findIndex((c) => c.sha === S.selectedSha);
    const next = list[Math.max(0, Math.min(list.length - 1, i + delta))];
    if (next && next.sha !== S.selectedSha) {
      selectCommit(next.sha);
      $('#commit-list .selected')?.scrollIntoView({ block: 'nearest' });
    }
  }
}

function init() {
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon];

  if (!tauri?.core) {
    document.body.replaceChildren(h('div', { class: 'diff-notice' }, 'RemoteGit must run inside the desktop app (or `npm run preview`).'));
    return;
  }

  $('#tb-repo').addEventListener('click', repoPopover);
  $('#tb-branch').addEventListener('click', branchPopover);
  $('#tb-sync').addEventListener('click', () => runSync());
  $('#tb-sync').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const remote = S.status?.remote?.name;
    if (!remote || S.busy) return;
    openMenu(e.clientX, e.clientY, [
      { label: `Fetch ${remote}`, run: () => runSync({ kind: 'fetch', run: () => git.fetchRemote(ex, S.repo.path, remote) }) },
      S.status.branch.upstream && { label: `Pull ${remote}`, run: () => runSync({ kind: 'pull', run: () => git.pull(ex, S.repo.path) }) },
      S.status.branch.head && { label: `Push ${remote}`, run: () => runSync({ kind: 'push', run: () => git.push(ex, S.repo.path, { remote, hasUpstream: !!S.status.branch.upstream }) }) },
    ]);
  });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));

  $('#filter').addEventListener('input', (e) => {
    S.filter = e.target.value;
    renderChanges();
  });
  $('#check-all').addEventListener('change', (e) => {
    if (e.target.checked) S.excluded.clear();
    else for (const f of currentFiles()) S.excluded.add(f.path);
    renderChanges();
  });
  $('#files-header').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const files = currentFiles();
    if (files.length) openMenu(e.clientX, e.clientY, [{ label: 'Discard all changes…', danger: true, run: () => confirmDiscard(files) }]);
  });
  $('#commit-form').addEventListener('submit', doCommit);
  $('#summary').addEventListener('input', updateCommitButton);
  for (const id of ['#summary', '#description'])
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doCommit(e);
    });

  for (const id of ['#file-list', '#commit-list'])
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
  $('#commit-list').addEventListener('scroll', (e) => {
    const el = e.target;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) loadHistory(false);
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      closePopover();
      closeMenu();
    }
    if (mod && e.key === '1') setTab('changes');
    if (mod && e.key === '2') setTab('history');
    if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); repoPopover(); }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); branchPopover(); }
    if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(); }
  });

  // Sidebar resizing.
  $('#resizer').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      store.sidebarWidth = Math.max(220, Math.min(600, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-w', `${store.sidebarWidth}px`);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      save();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  window.addEventListener('focus', () => refresh());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
  // Keep "Last fetched … ago" fresh.
  setInterval(() => S.status && !S.busy && renderToolbar(), 30000);

  selectRepo(store.currentRepoId || store.repos[0]?.id);
  schedulePoll();
}

init();
