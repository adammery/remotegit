import * as git from './git.js';
import { icons, fileIcon } from './icons.js';
import { h, ago, targetOf, undoable as undoableCommit, openMenu, closeMenu, readKey, setShowInMenuBar, setMenuBarOnly, STORE_KEY, TRAY_KEY } from './ui.js';

const tauri = window.__TAURI__;

// ============================================================ persistence

const store = Object.assign(
  {
    servers: [],
    repos: [],
    currentRepoId: null,
    serverFilter: null,
    sidebarWidth: 300,
    theme: 'system',
    commitOpts: { noVerify: false, signoff: false, allowEmpty: false },
  },
  readKey(STORE_KEY),
);

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {}
}
if (!store.servers.some((s) => s.id === store.serverFilter)) store.serverFilter = null;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ============================================================ DOM helpers

const $ = (sel) => document.querySelector(sel);
const ico = (name) => h('span', { class: 'ico', html: icons[name] });

// GitHub account `gh` is signed in to, per server; used for the user's own commits.
const ghUsers = new Map();

function loadGitHubUser(server) {
  if (ghUsers.has(server.id)) return;
  ghUsers.set(server.id, null);
  git.getGitHubUser((script, t) => execOn(server, script, t)).then(
    (user) => {
      if (!user) return;
      ghUsers.set(server.id, user);
      if (S.server?.id === server.id) {
        renderChanges();
        renderHistory();
        if (S.tab === 'history') renderContent();
      }
    },
    () => ghUsers.delete(server.id),
  );
}

// Your own email maps to the signed-in GitHub account even when it isn't public
// on GitHub; anyone else goes through the email lookup GitHub Desktop uses.
function avatarUrl(email) {
  if (!email) return null;
  const me = S.server && ghUsers.get(S.server.id);
  if (me && email.toLowerCase() === S.status?.user.email?.toLowerCase()) return me.avatar;
  const noreply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
  if (noreply) return `https://avatars.githubusercontent.com/u/${noreply[1]}?s=64`;
  return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=64`;
}

function avatar(name, small, email) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  let hash = 0;
  for (const c of name || '') hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const url = avatarUrl(email);
  const img = url && h('img', { src: url, alt: '', loading: 'lazy', draggable: false, onerror: (e) => e.target.remove() });
  return h('span', { class: 'avatar' + (small ? ' small' : ''), style: `background:hsl(${Math.abs(hash) % 360} 45% 42%)`, title: email ? `${name} <${email}>` : name || '' }, initials, img);
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
  partial: new Map(), // path -> { text, excluded: Set of change-line indexes }
  selectedPath: null,
  filter: '',
  diff: null, // { key, text, truncated }
  diffFull: false,
  busy: null, // label of a running network/commit operation
  lastCommit: null, // { sha, summary, repoId } for undo
  headCommit: null, // tip of the branch, offered for Undo while unpushed
  history: { commits: [], unpushed: new Set(), done: false, loading: false, oid: undefined, search: '', req: 0 },
  selectedSha: null,
  commit: null, // details of selected commit
  commitFile: null,
  commitDiff: null,
  stashView: null, // { sha, files, file, diff } while the branch's stash is open
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
    partial: new Map(),
    selectedPath: null,
    diff: null,
    diffFull: false,
    lastCommit: null,
    headCommit: null,
    history: { commits: [], unpushed: new Set(), done: false, loading: false, oid: undefined, search: '', req: 0 },
    selectedSha: null,
    commit: null,
    commitFile: null,
    commitDiff: null,
    stashView: null,
  });
  if (repo && !S.server) S.repo = null;
  if (S.repo && store.serverFilter && S.repo.serverId !== store.serverFilter) store.serverFilter = S.repo.serverId;
  store.currentRepoId = S.repo?.id || null;
  save();
  $('#summary').value = '';
  $('#description').value = '';
  $('#history-filter').value = '';
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
    const stashClosed = !!S.stashView && S.stashView.sha !== st.stash?.sha;
    if (stashClosed) S.stashView = null;
    if (!prev || prev.raw !== st.raw || hadError) {
      const paths = new Set(st.files.map((f) => f.path));
      for (const p of S.excluded) if (!paths.has(p)) S.excluded.delete(p);
      for (const p of S.partial.keys()) if (!paths.has(p)) S.partial.delete(p);
      const prevSelected = S.selectedPath;
      if (!paths.has(S.selectedPath)) S.selectedPath = st.files[0]?.path || null;
      if (S.selectedPath !== prevSelected) S.diff = null;
      renderToolbar();
      renderChanges();
      // An open diff refreshes itself below; everything else depends on status.
      if (hadError || !prev || stashClosed || (S.tab === 'changes' && (S.selectedPath !== prevSelected || !S.selectedPath)))
        renderContent();
    }
    if (headMoved && S.tab === 'history') loadHistory(true);
    if (headMoved) loadHeadCommit();
    loadGitHubUser(S.server);
    if (S.tab === 'changes' && !S.stashView) await refreshDiff();
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
    const partial = S.partial.get(file.path);
    if (partial && partial.text !== d.text) {
      S.partial.delete(file.path);
      renderChanges();
      toast(`${file.path} changed on the server, so its line selection was reset.`);
    }
    S.diff = { key, ...d };
    renderContent();
  } catch (e) {
    if (gen !== S.gen) return;
    S.diff = { key, error: e.message };
    renderContent();
  }
}

// One `git status` over the open SSH connection: ~1.5 KB and a few ms on the server.
const POLL_SECONDS = 4;
let pollTimer = null;
// Polls only while the window has focus; nothing at all goes to the server
// while you're in another app. Coming back refreshes right away.
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!document.hasFocus()) return;
  const secs = S.error?.kind === 'conn' ? 15 : POLL_SECONDS;
  pollTimer = setTimeout(async () => {
    if (!S.busy) await refresh();
    schedulePoll();
  }, secs * 1000);
}

// ============================================================ history

// A reset (new search, branch moved) supersedes a page that is still loading.
async function loadHistory(reset) {
  if (!S.repo) return;
  const H = S.history;
  if (!reset && (H.loading || H.done)) return;
  H.loading = true;
  const req = ++H.req;
  const gen = S.gen;
  try {
    const skip = reset ? 0 : H.commits.length;
    const { commits, unpushed } = await git.getLog(ex, S.repo.path, { skip, limit: 100, search: H.search });
    if (gen !== S.gen || req !== H.req) return;
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
    if (gen === S.gen && req === H.req) toast(e.message, 'error', 'Could not load history');
  } finally {
    if (req === H.req) H.loading = false;
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

function selectCommitFile(f) {
  if (S.commitFile === f) return;
  S.commitFile = f;
  S.commitDiff = null;
  renderContent();
  loadCommitDiff();
}

// ↑ ↓ move between the commit's files, ← goes back to the commit list.
function commitFilesKey(e) {
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    $('#commit-list').focus();
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  // While another commit is still loading, the list on screen belongs to the old one.
  const c = S.commit;
  if (c?.sha !== S.selectedSha) return;
  const i = c.files.indexOf(S.commitFile);
  const next = c.files[Math.max(0, Math.min(c.files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (!next || next === S.commitFile) return;
  selectCommitFile(next);
  $('#commit-files .selected')?.scrollIntoView({ block: 'nearest' });
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
  const opts = store.commitOpts;
  if (!summary || (!files.length && !opts.allowEmpty) || S.busy || !S.repo) return;
  const coAuthors = $('#coauthors').hidden ? [] : git.parseCoAuthors($('#coauthors').value);
  if (coAuthors.includes(null))
    return toast('Write co-authors as @github-login or Name <email>, separated by commas.', 'error', 'Invalid co-author');
  const partial = files.filter((f) => S.partial.has(f.path));
  const whole = files.filter((f) => !S.partial.has(f.path));
  const patches = partial.map((f) => git.buildPartialPatch(S.partial.get(f.path).text, S.partial.get(f.path).excluded)).filter(Boolean);
  await withBusy('Commit', async () => {
    const sha = await git.commit(ex, S.repo.path, {
      files: whole,
      patches,
      all: !partial.length && whole.length > 0 && whole.length === currentFiles().length,
      summary,
      description: $('#description').value,
      coAuthors,
      ...opts,
    });
    S.lastCommit = { sha, summary, repoId: S.repo.id };
    $('#summary').value = '';
    $('#description').value = '';
    $('#coauthors').value = '';
    $('#coauthors').hidden = true;
    S.excluded.clear();
    S.partial.clear();
    S.history.oid = undefined;
  });
}

function commitOptionsMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const o = store.commitOpts;
  const toggle = (key) => () => {
    o[key] = !o[key];
    save();
    renderCommitFlags();
    updateCommitButton();
  };
  openMenu(r.left, r.bottom + 4, [
    { label: (o.noVerify ? '✓ ' : '') + 'Bypass Commit Hooks', run: toggle('noVerify') },
    { label: (o.signoff ? '✓ ' : '') + 'Add Signed-off-by Trailer', run: toggle('signoff') },
    { label: (o.allowEmpty ? '✓ ' : '') + 'Allow Empty Commit', run: toggle('allowEmpty') },
  ]);
}

function renderCommitFlags() {
  const o = store.commitOpts;
  const flags = [o.noVerify && 'no hooks', o.signoff && 'signed-off', o.allowEmpty && 'empty ok'].filter(Boolean);
  $('#commit-flags').replaceChildren(...flags.map((f) => h('span', { class: 'tag-badge' }, f)));
  $('#commit-opts-btn').classList.toggle('on', flags.length > 0);
}

function toggleCoAuthors() {
  const input = $('#coauthors');
  input.hidden = !input.hidden;
  $('#coauthor-btn').classList.toggle('on', !input.hidden);
  if (!input.hidden) input.focus();
}

// Looks for the AI CLIs on every click: one found is used right away, several
// are offered in a small menu under the button.
async function generateMessage() {
  const files = checkedFiles();
  if (!S.repo || !files.length) return toast('Check the files the message should describe.', 'info', 'Nothing selected');
  const btn = $('#ai-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.innerHTML = icons.spinner;
  let tools = [];
  try {
    tools = await git.findAiTools(ex);
  } catch (e) {
    toast(e.message, 'error', 'Could not look for AI tools');
  }
  btn.disabled = false;
  btn.innerHTML = icons.sparkle;
  if (!tools.length) {
    if (S.repo) toast('Install Claude Code or Codex on the server and sign in there once (run `claude` or `codex`). RemoteGit uses it to write the message.', 'error', 'No AI found on the server');
    return;
  }
  if (tools.length === 1) return writeMessage(tools[0].id, files);
  const r = btn.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [{ label: 'Write the message with', disabled: true }, ...tools.map((t) => ({ label: t.name, run: () => writeMessage(t.id, files) }))]);
}

async function writeMessage(tool, files) {
  const btn = $('#ai-btn');
  btn.disabled = true;
  btn.innerHTML = icons.spinner;
  try {
    const m = await git.generateCommitMessage(ex, S.repo.path, files, hasHead(), tool);
    if (!m) {
      toast(`${git.AI_TOOLS.find((t) => t.id === tool)?.name} is no longer on the server.`, 'error', 'AI not found');
    } else {
      $('#summary').value = m.summary;
      $('#description').value = m.description;
      updateCommitButton();
      $('#summary').focus();
    }
  } catch (e) {
    toast(e.message, 'error', 'Could not generate a message');
  } finally {
    btn.disabled = false;
    btn.innerHTML = icons.sparkle;
  }
}

async function loadHeadCommit() {
  const gen = S.gen;
  const oid = S.status?.branch.oid;
  const head = oid ? await git.getHeadCommit(ex, S.repo.path).catch(() => null) : null;
  if (gen !== S.gen || S.status?.branch.oid !== oid) return;
  S.headCommit = head;
  renderUndo();
}

const undoable = () => undoableCommit(S.status, S.headCommit);

async function undoLastCommit() {
  const c = undoable();
  if (!c) return;
  await withBusy('Undo', async () => {
    const full = await git.getCommit(ex, S.repo.path, c.sha);
    await git.undoCommit(ex, S.repo.path, c.sha);
    S.lastCommit = null;
    if (!$('#summary').value.trim()) {
      $('#summary').value = full.summary;
      $('#description').value = full.body;
    }
  });
}

function renderUndo() {
  const undo = $('#undo-bar');
  const c = undoable();
  undo.hidden = !c;
  if (!c) return;
  undo.replaceChildren(
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'undo-when' }, `Committed ${ago(c.time)}`),
      h('div', { class: 'undo-summary', title: c.summary }, c.summary),
    ),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: undoLastCommit, disabled: !!S.busy }, 'Undo'),
  );
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
  if (s.local) return `vscode://file${S.repo.path.startsWith('/') ? '' : '/'}${encodeURI(S.repo.path)}`;
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

const dotClass = (serverId) => ({ ok: 'ok', connecting: 'busy', error: 'err' }[connState.get(serverId)] || '');
const filterServer = () => store.servers.find((s) => s.id === store.serverFilter) || null;

function renderConn() {
  const shown = filterServer();
  const server = shown || S.server;
  $('#tb-server-name').textContent = shown ? shown.name || shown.host : 'All servers';
  const dot = $('#server-dot');
  dot.hidden = !server;
  if (!server) return;
  dot.className = 'dot ' + dotClass(server.id);
  const state = { ok: 'connected', connecting: 'connecting…', error: 'not connected' }[connState.get(server.id)] || 'idle';
  $('#tb-server').title = `${server.name || server.host}: ${state}`;
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
  $('#tb-sync-more').disabled = !st?.remote || !!S.busy;
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
  renderStashRow();

  updateCommitButton();
  $('#avatar').replaceWith(Object.assign(avatar(S.status?.user.name, false, S.status?.user.email), { id: 'avatar' }));

  renderUndo();
}

function updateCommitButton() {
  const btn = $('#commit-btn');
  const branch = S.status?.branch.head || 'HEAD';
  const n = checkedFiles().length;
  const what = n > 1 ? `Commit ${n} files to ` : 'Commit to ';
  btn.replaceChildren(S.busy === 'Commit' ? 'Committing…' : what, S.busy === 'Commit' ? '' : h('b', {}, branch));
  btn.disabled = !S.status || (!checkedFiles().length && !store.commitOpts.allowEmpty) || !$('#summary').value.trim() || !!S.busy;
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
      class: 'file-row' + (f.path === S.selectedPath && !S.stashView ? ' selected' : ''),
      title: f.orig ? `${f.orig} → ${f.path}` : f.path,
      onclick: () => selectFile(f.path),
      oncontextmenu: (e) => fileMenu(e, f),
    },
    h('input', {
      type: 'checkbox',
      checked: !S.excluded.has(f.path),
      indeterminate: S.partial.has(f.path),
      title: S.partial.has(f.path) ? 'Some lines selected' : null,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        S.partial.delete(f.path);
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
  if (S.selectedPath === path && !S.stashView) return;
  S.stashView = null;
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
        oncontextmenu: (e) => commitMenu(e, c),
      },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'commit-summary', title: c.summary }, c.summary),
        h('div', { class: 'commit-meta' }, avatar(c.author, true, c.email), `${c.author} • ${ago(c.time)}`, c.tags.map((t) => h('span', { class: 'tag-badge' }, t))),
      ),
      H.unpushed.has(c.sha) && h('span', { class: 'unpushed', title: 'Not pushed yet' }, h('span', { html: icons.up })),
    ),
  );
  if (!H.commits.length) rows.push(h('div', { class: 'list-note' }, H.loading ? 'Loading…' : H.search ? 'No commits match.' : 'No commits yet.'));
  list.replaceChildren(...rows);
}

function renderContent() {
  const root = $('#content');
  const key = S.tab === 'history' ? `h:${S.selectedSha}:${S.commitFile?.path}` : `c:${S.selectedPath}`;
  const old = root.querySelector('.diff');
  const scroll = root.dataset.key === key && old ? [old.scrollTop, old.scrollLeft] : null;
  // The commit's file list is rebuilt too; keep its focus and scroll so the arrow keys keep working.
  const oldFiles = root.querySelector('#commit-files');
  const filesSha = oldFiles?.dataset.sha;
  const filesScroll = oldFiles?.scrollTop;
  const filesFocused = !!oldFiles && document.activeElement === oldFiles;
  root.replaceChildren(...[contentView()].flat());
  root.dataset.key = key;
  const diff = root.querySelector('.diff');
  if (scroll && diff) [diff.scrollTop, diff.scrollLeft] = scroll;
  const files = root.querySelector('#commit-files');
  if (files && files.dataset.sha === filesSha) files.scrollTop = filesScroll;
  if (files && filesFocused) files.focus({ preventScroll: true });
}

function contentView() {
  if (!store.servers.length) return welcomeView();
  if (!S.repo) return noRepoView();
  if (S.error) return errorView();
  if (!S.status) return h('div', { class: 'diff-notice' }, 'Loading…');
  if (S.tab === 'history') return historyView();
  if (S.stashView) return stashView();
  const file = currentFiles().find((f) => f.path === S.selectedPath);
  if (!file) return noChangesView();
  return [
    h('div', { class: 'diff-header' }, h('span', { class: `file-status ${file.kind}`, html: fileIcon(file.kind) }), h('span', { class: 'path' }, ltr(file.orig ? `${file.orig} → ${file.path}` : file.path))),
    diffView(S.diff, file),
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
    card({ title: 'Use repositories on this computer', sub: isMac ? 'Works like GitHub Desktop, with git on this Mac.' : 'Works like GitHub Desktop, with Git for Windows on this PC.', button: 'Add this computer', onclick: addThisComputer }),
  ]);
}

function noRepoView() {
  return blank('No repository selected', 'Pick a repository from the toolbar, or add one from a server.', [
    card({ title: 'Add a repository', sub: 'Scan a server for Git repositories or enter a path.', button: 'Add repository', onclick: () => addRepoModal(), primary: true }),
    card({ title: 'Clone a repository', sub: 'From GitHub or any Git URL, into a folder on the server.', button: 'Clone repository', onclick: () => cloneModal() }),
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
        !S.server.local &&
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
  cards.push(card({ title: 'Open the repository in Visual Studio Code', sub: S.server.local ? 'Opens the folder in VS Code.' : 'Opens on the server through the Remote - SSH extension.', button: 'Open in VS Code', onclick: () => openExternal(vscodeUrl()) }));
  if (S.server.local)
    cards.push(card({ title: `Show the repository in ${isMac ? 'Finder' : 'Explorer'}`, sub: S.repo.path, button: `Show in ${isMac ? 'Finder' : 'Explorer'}`, onclick: () => tauri.opener?.revealItemInDir(S.repo.path).catch((e) => toast(String(e), 'error')) }));
  else cards.push(card({ title: 'Open a terminal in this repository', sub: 'Copies an ssh command that lands in this folder.', button: 'Copy SSH command', onclick: () => copyText(sshCommand()) }));
  const web = git.webUrl(st.remote?.url);
  if (web) {
    const host = new URL(web).hostname.replace(/^www\./, '');
    const site = host === 'github.com' ? 'GitHub' : host === 'gitlab.com' ? 'GitLab' : host;
    cards.push(card({ title: `Open the repository page on ${site} in your browser`, sub: web, button: `View on ${site}`, onclick: () => openExternal(web) }));
  }
  return blank('No local changes', 'There are no uncommitted changes in this repository. Here are some friendly suggestions for what to do next.', cards);
}

const DIFF_LINE_CAP = 5000;

// Change lines left out of the commit for `file`, as indexes from parseDiff.
function excludedLines(file, text, total) {
  const entry = S.partial.get(file.path);
  if (entry && entry.text === text) return entry.excluded;
  return S.excluded.has(file.path) ? new Set(Array.from({ length: total }, (_, i) => i)) : new Set();
}

function setLines(file, text, total, indices, include) {
  const excluded = new Set(excludedLines(file, text, total));
  for (const i of indices) include ? excluded.delete(i) : excluded.add(i);
  S.partial.delete(file.path);
  if (!excluded.size) S.excluded.delete(file.path);
  else if (excluded.size >= total) S.excluded.add(file.path);
  else {
    S.excluded.delete(file.path);
    S.partial.set(file.path, { text, excluded });
  }
  return excluded;
}

// Click or drag over the gutter to pick lines; click a hunk header for the whole hunk.
function wireLineSelection(table, file, d, parsed) {
  const repaint = (excluded) => {
    for (const row of table.querySelectorAll('.dl[data-i]')) row.classList.toggle('sel', !excluded.has(Number(row.dataset.i)));
  };
  let drag = null;
  const stop = () => {
    if (!drag) return;
    drag = null;
    document.removeEventListener('mouseup', stop);
    renderChanges();
    updateCommitButton();
  };
  table.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.dl');
    if (e.button !== 0 || !row) return;
    // Hunk headers are clickable anywhere; change lines only in the gutter, so text stays selectable.
    if (row.dataset.hunk == null && !e.target.closest('.selcol, .ln, .sign')) return;
    e.preventDefault();
    if (row.dataset.hunk != null) {
      const idx = parsed.hunks[Number(row.dataset.hunk)].lines.filter((l) => l.i != null).map((l) => l.i);
      const current = excludedLines(file, d.text, parsed.changes);
      repaint(setLines(file, d.text, parsed.changes, idx, idx.some((i) => current.has(i))));
      renderChanges();
      updateCommitButton();
      return;
    }
    if (row.dataset.i == null) return;
    const i = Number(row.dataset.i);
    drag = { include: excludedLines(file, d.text, parsed.changes).has(i) };
    repaint(setLines(file, d.text, parsed.changes, [i], drag.include));
    document.addEventListener('mouseup', stop);
  });
  table.addEventListener('mouseover', (e) => {
    const row = drag && e.target.closest('.dl[data-i]');
    if (row) repaint(setLines(file, d.text, parsed.changes, [Number(row.dataset.i)], drag.include));
  });
}

// File name -> highlight.js language, or null when we have no grammar for it.
function languageFor(path) {
  const hljs = window.hljs;
  if (!hljs || !path) return null;
  const name = path.split('/').pop().toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const lang = { vue: 'xml', svelte: 'xml', htm: 'xml', svg: 'xml', env: 'ini', conf: 'ini', cjs: 'javascript', mjs: 'javascript', lock: null }[ext] ?? ext;
  return lang && hljs.getLanguage(lang) ? lang : null;
}

// Highlights lines as one block (so strings and comments spanning lines come
// out right), then splits the HTML back into lines, closing and reopening any
// span that crosses a line break. highlight.js escapes the text it returns.
function highlightLines(lines, lang) {
  let html;
  try {
    html = window.hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const out = [];
  const open = [];
  let cur = '';
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!tok) continue;
    if (tok === '\n') {
      out.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else if (tok.startsWith('<span')) {
      open.push(tok);
      cur += tok;
    } else if (tok === '</span>') {
      open.pop();
      cur += tok;
    } else cur += tok;
  }
  out.push(cur + '</span>'.repeat(open.length));
  return out.length === lines.length ? out : null;
}

// The new side (context + additions) and old side (context + deletions) of a
// hunk are each valid code, so each is highlighted on its own.
function highlightHunk(hk, lang) {
  if (!lang) return null;
  const newSide = hk.lines.filter((l) => l.t === 'ctx' || l.t === 'add');
  const oldSide = hk.lines.filter((l) => l.t === 'ctx' || l.t === 'del');
  if (hk.lines.some((l) => l.text.length > 1000)) return null; // minified files: skip
  const nh = highlightLines(newSide.map((l) => l.text), lang);
  const oh = oldSide.some((l) => l.t === 'del') ? highlightLines(oldSide.map((l) => l.text), lang) : [];
  if (!nh || !oh) return null;
  const map = new Map();
  newSide.forEach((l, i) => map.set(l, nh[i]));
  oldSide.forEach((l, i) => l.t === 'del' && map.set(l, oh[i]));
  return map;
}

function diffView(d, file, path = file?.path) {
  if (!d) return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, 'Loading diff…'));
  if (d.error) return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, h('div', { class: 'error-box' }, d.error)));
  const parsed = git.parseDiff(d.text);
  if (parsed.binary) return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, 'This binary file has changed.'));
  if (!parsed.hunks.length)
    return h('div', { class: 'diff' }, h('div', { class: 'diff-notice' }, parsed.notes.length ? parsed.notes.join('\n') : 'No content changes (empty file).'));

  // Line picking works for edited and new files; renames and deletions go in whole.
  const selectable = !!file && (file.kind === 'modified' || file.kind === 'new') && !d.truncated && parsed.changes > 0;
  const excluded = selectable ? excludedLines(file, d.text, parsed.changes) : null;
  const total = parsed.hunks.reduce((n, hk) => n + hk.lines.length + 1, 0);
  const cap = S.diffFull ? Infinity : DIFF_LINE_CAP;
  const frag = document.createDocumentFragment();
  const sel = () => selectable && h('span', { class: 'selcol' });
  const lang = d.text.length < 400_000 ? languageFor(path) : null;
  let count = 0;
  outer: for (const [hi, hk] of parsed.hunks.entries()) {
    const colored = highlightHunk(hk, lang);
    frag.append(
      h('div', { class: 'dl hunk', dataset: selectable ? { hunk: hi } : null, title: selectable ? 'Click to include or leave out this whole block' : null }, sel(), h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'sign' }), h('span', { class: 'code' }, hk.header)),
    );
    for (const l of hk.lines) {
      if (++count > cap) break outer;
      const change = l.i != null;
      frag.append(
        h(
          'div',
          { class: `dl ${l.t}` + (selectable && change && !excluded.has(l.i) ? ' sel' : ''), dataset: selectable && change ? { i: l.i } : null },
          sel(),
          h('span', { class: 'ln' }, l.o ?? ''),
          h('span', { class: 'ln' }, l.n ?? ''),
          h('span', { class: 'sign' }, l.t === 'add' ? '+' : l.t === 'del' ? '-' : ''),
          colored?.has(l) ? h('span', { class: 'code', html: colored.get(l) || ' ' }) : h('span', { class: 'code' }, l.text || ' '),
        ),
      );
    }
  }
  const table = h('div', { class: 'diff-table' + (selectable ? ' selectable' : '') }, frag);
  if (selectable) wireLineSelection(table, file, d, parsed);
  const extras = [];
  if (count > cap)
    extras.push(h('div', { class: 'diff-notice' }, `Showing ${cap} of ${total} lines.`, h('br'), h('button', { class: 'btn', type: 'button', onclick: () => { S.diffFull = true; renderContent(); } }, 'Show the whole diff')));
  if (d.truncated) extras.push(h('div', { class: 'diff-notice' }, 'This diff is larger than 2 MB and was cut off.'));
  return h('div', { class: 'diff' }, table, extras);
}

function historyView() {
  const c = S.commit;
  if (!c) return h('div', { class: 'diff-notice' }, S.history.commits.length ? 'Loading…' : S.history.search ? 'No commits match the search.' : 'No commits yet.');
  const head = h(
    'div',
    { class: 'commit-detail-head' },
    h('h2', {}, c.summary),
    c.body && h('div', { class: 'body' }, c.body),
    h(
      'div',
      { class: 'meta' },
      h('span', {}, avatar(c.author, true, c.email), c.author),
      h('span', { class: 'sha', title: 'Click to copy', style: 'cursor:pointer', onclick: () => copyText(c.sha) }, h('span', { html: icons.commit }), c.sha.slice(0, 7)),
      h('span', { title: new Date(c.time * 1000).toLocaleString() }, ago(c.time)),
      h('span', {}, `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}`),
    ),
  );
  const files = h(
    'div',
    { class: 'file-list', id: 'commit-files', tabindex: '0', dataset: { sha: c.sha }, onkeydown: commitFilesKey },
    c.files.map((f) => {
      const [dir, name] = splitPath(f.path);
      return h(
        'div',
        {
          class: 'file-row' + (f === S.commitFile ? ' selected' : ''),
          title: f.orig ? `${f.orig} → ${f.path}` : f.path,
          onclick: () => selectCommitFile(f),
        },
        h('span', { class: 'file-path' }, h('span', { class: 'dir' }, ltr((f.orig ? f.orig + ' → ' : '') + dir)), h('span', { class: 'name' }, name)),
        h('span', { class: `file-status ${f.kind}`, html: fileIcon(f.kind) }),
      );
    }),
  );
  const diffCol = h('div', { class: 'diff-col' }, S.commitFile ? diffView(S.commitDiff, null, S.commitFile.path) : h('div', { class: 'diff-notice' }, 'No file changes in this commit.'));
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
  const w = width || r.width;
  const left = Math.max(0, Math.min(r.left, innerWidth - w));
  const el = h('div', { class: 'popover', style: `left:${left}px;top:${r.bottom}px;width:${w}px` });
  popover = { el, anchor };
  anchor.classList.add('open');
  $('#popover-root').append(el);
  build(el);
  el.querySelector('input')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (popover && !popover.el.contains(e.target) && !popover.anchor.contains(e.target)) closePopover();
});

function repoPopover() {
  openPopover($('#tb-repo'), (el) => {
    const filter = h('input', { type: 'search', placeholder: 'Filter repositories', oninput: () => fill() });
    const body = h('div', { class: 'pop-body' });
    const fill = () => {
      const term = filter.value.toLowerCase();
      const shown = filterServer();
      const groups = (shown ? [shown] : store.servers).map((s) => {
        const repos = store.repos.filter((r) => r.serverId === s.id && (r.name + r.path).toLowerCase().includes(term));
        return [
          h(
            'div',
            { class: 'pop-group' },
            h('span', { class: 'dot ' + dotClass(s.id) }),
            h('span', { class: 'grow', title: s.host }, s.name || s.host),
            h('button', { class: 'btn-icon', type: 'button', title: 'Add repository from this server', html: icons.plus, onclick: () => { closePopover(); addRepoModal(s); } }),
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
      body.replaceChildren(...groups.flat(Infinity), store.servers.length ? '' : h('div', { class: 'pop-empty' }, 'No servers yet. Add one from the Server menu in the top right.'));
    };
    fill();
    el.append(
      h('div', { class: 'pop-head' }, filter),
      body,
      h(
        'div',
        { class: 'pop-foot' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: !store.servers.length, onclick: () => { closePopover(); addRepoModal(filterServer()); } }, h('span', { html: icons.plus }), 'Add repository'),
        h('button', { class: 'btn', type: 'button', disabled: !store.servers.length, onclick: () => { closePopover(); cloneModal(filterServer()); } }, h('span', { html: icons.clone }), 'Clone'),
      ),
    );
  }, 360);
}

function serverPopover() {
  openPopover($('#tb-server'), (el) => {
    const repoCount = (server) => {
      const n = store.repos.filter((r) => !server || r.serverId === server.id).length;
      return `${n} repositor${n === 1 ? 'y' : 'ies'}`;
    };
    const row = (server) => {
      const current = (store.serverFilter || null) === (server?.id || null);
      return h(
        'div',
        { class: 'pop-item' + (current ? ' current' : ''), onclick: () => { closePopover(); setServerFilter(server?.id || null); } },
        server ? h('span', { class: 'dot ' + dotClass(server.id) }) : h('span', { html: icons.server }),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'title' }, server ? server.name || server.host : 'All servers'),
          h('div', { class: 'sub' }, server ? `${server.local ? 'This computer' : (server.user ? server.user + '@' : '') + server.host} · ${repoCount(server)}` : repoCount(null)),
        ),
        current && h('span', { html: icons.check }),
        server && h('button', { class: 'btn-icon always', type: 'button', title: 'Server settings', html: icons.gear, onclick: (e) => { e.stopPropagation(); closePopover(); serverModal(server); } }),
      );
    };
    el.append(
      h('div', { class: 'pop-body' }, store.servers.length ? [row(null), store.servers.map(row)].flat() : h('div', { class: 'pop-empty' }, 'No servers yet.')),
      h('div', { class: 'pop-foot' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { closePopover(); serverModal(); } }, h('span', { html: icons.plus }), 'Add server')),
    );
  }, 300);
}

function applyTheme() {
  const t = store.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    tauri?.window?.getCurrentWindow?.().setTheme(t === 'system' ? null : t)?.catch?.(() => {});
  } catch {}
}

// Shared with the tray window, which has the same switch.
const trayPrefs = () => readKey(TRAY_KEY);

function settingsPopover() {
  openPopover($('#tb-settings'), (el) => {
    const seg = (options, value, onPick) =>
      h('div', { class: 'segmented' }, options.map(([v, label]) => h('button', { type: 'button', class: v === value ? 'active' : '', onclick: () => onPick(v) }, label)));
    const fill = () =>
      el.replaceChildren(
        h(
          'div',
          { class: 'settings' },
          h('div', { class: 'settings-label' }, 'Appearance'),
          seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], store.theme || 'system', (v) => { store.theme = v; save(); applyTheme(); fill(); }),
          h('div', { class: 'settings-label' }, isMac ? 'Menu bar' : 'System tray'),
          h(
            'label',
            { class: 'check settings-check' },
            h('input', { type: 'checkbox', checked: !!trayPrefs().showInMenuBar, onchange: (e) => { setShowInMenuBar(e.target.checked); fill(); } }),
            h('span', {}, h('b', {}, isMac ? 'Show in menu bar' : 'Show in system tray'), h('br'), h('span', { class: 'hint' }, 'A small window with changes, commit and push, one click away.')),
          ),
          h(
            'label',
            { class: 'check settings-check' + (trayPrefs().showInMenuBar ? '' : ' off') },
            h('input', { type: 'checkbox', checked: !!trayPrefs().menuBarOnly, disabled: !trayPrefs().showInMenuBar, onchange: (e) => { setMenuBarOnly(e.target.checked); fill(); } }),
            h('span', {}, h('b', {}, isMac ? 'Hide from the Dock' : 'Hide from the taskbar'), h('br'), h('span', { class: 'hint' }, 'Closing the window keeps RemoteGit running in the menu bar.')),
          ),
          h('button', { class: 'btn btn-block', type: 'button', onclick: () => { closePopover(); shortcutsModal(); } }, 'Keyboard shortcuts'),
          h(
            'div',
            { class: 'settings-version' },
            h('span', {}, `RemoteGit ${appVersion}`),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { closePopover(); checkForUpdates(); } }, 'Check for updates'),
          ),
        ),
      );
    fill();
  }, 280);
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const keyLabel = (combo) =>
  combo
    .split('+')
    .map((k) => (isMac ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Enter: '↩', Backspace: '⌫' }[k] || k : { Mod: 'Ctrl', Backspace: 'Backspace' }[k] || k))
    .join(isMac ? '' : '+');

// Mirrors GitHub Desktop's shortcuts where it has one.
const SHORTCUTS = [
  ['Mod+1', 'Show changes', () => setTab('changes')],
  ['Mod+2', 'Show history', () => setTab('history')],
  ['Mod+T', 'Switch repository', () => repoPopover()],
  ['Mod+B', 'Switch branch', () => branchPopover()],
  ['Mod+Shift+N', 'New branch', () => S.status && newBranchModal()],
  ['Mod+Shift+O', 'Clone repository', () => cloneModal()],
  ['Mod+Shift+S', 'Stash all changes', () => stashAll()],
  ['Mod+F', 'Filter files / search history', () => { const el = $(S.tab === 'history' ? '#history-filter' : '#filter'); el.focus(); el.select(); }],
  ['Mod+Shift+L', 'Switch server', () => serverPopover()],
  ['Mod+P', 'Push', () => S.status?.remote && runSync({ kind: 'push', run: () => git.push(ex, S.repo.path, { remote: S.status.remote.name, hasUpstream: !!S.status.branch.upstream }) })],
  ['Mod+Shift+P', 'Pull', () => S.status?.branch.upstream && runSync({ kind: 'pull', run: () => git.pull(ex, S.repo.path) })],
  ['Mod+Shift+T', 'Fetch', () => S.status?.remote && runSync({ kind: 'fetch', run: () => git.fetchRemote(ex, S.repo.path, S.status.remote.name) })],
  ['Mod+Enter', 'Commit', () => doCommit()],
  ['Mod+Shift+M', 'Generate commit message with AI', () => generateMessage()],
  ['Mod+Shift+A', 'Open in Visual Studio Code', () => S.repo && openExternal(vscodeUrl())],
  ['Mod+`', 'Copy SSH command for a terminal', () => S.repo && !S.server.local && copyText(sshCommand())],
  ['Mod+Shift+G', 'View on GitHub', () => { const w = git.webUrl(S.status?.remote?.url); if (w) openExternal(w); }],
  ['Mod+Shift+Backspace', 'Discard all changes', () => currentFiles().length && confirmDiscard(currentFiles())],
  ['Mod+R', 'Refresh', () => refresh()],
  ['Mod+,', 'Settings', () => settingsPopover()],
  ['Mod+/', 'Keyboard shortcuts', () => shortcutsModal()],
];

function matchShortcut(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const combo = ['Mod', e.shiftKey && 'Shift', key === '?' ? '/' : key].filter(Boolean).join('+');
  return SHORTCUTS.find(([c]) => c.toUpperCase() === combo.toUpperCase()) || null;
}

function shortcutsModal() {
  openModal({
    title: 'Keyboard shortcuts',
    body: h(
      'div',
      { class: 'shortcuts' },
      SHORTCUTS.map(([combo, label]) => h('div', { class: 'shortcut' }, h('span', {}, label), h('kbd', {}, keyLabel(combo)))),
      h('div', { class: 'shortcut' }, h('span', {}, 'Move in lists'), h('kbd', {}, '↑ ↓')),
      h('div', { class: 'shortcut' }, h('span', {}, 'History: go to the commit’s files / back'), h('kbd', {}, '→ ←')),
      h('div', { class: 'shortcut' }, h('span', {}, 'Check / uncheck the selected file'), h('kbd', {}, isMac ? 'Space' : 'Space')),
    ),
  });
}

function setServerFilter(id) {
  store.serverFilter = id;
  save();
  if (id && S.repo?.serverId !== id) selectRepo(store.repos.find((r) => r.serverId === id)?.id);
  else renderAll();
}

function branchPopover(initialTab = 'branches') {
  if (!S.status) return;
  openPopover($('#tb-branch'), (el) => {
    let tab = initialTab;
    let branches = null;
    let prs; // undefined = not loaded, null = no gh on the server
    let prError = null;
    const current = S.status.branch.head;
    const filter = h('input', { type: 'search', placeholder: 'Filter', oninput: () => fill() });
    const newBtn = h('button', { class: 'btn', type: 'button', onclick: () => { closePopover(); newBranchModal(); } }, 'New Branch');
    const tabBtn = (id, label) => h('button', { class: 'pop-tab', type: 'button', dataset: { tab: id }, onclick: () => { tab = id; fill(); load(); } }, label);
    const tabs = h('div', { class: 'pop-tabs' }, tabBtn('branches', 'Branches'), tabBtn('prs', 'Pull Requests'));
    const body = h('div', { class: 'pop-body' });
    const mergeFoot = h(
      'div',
      { class: 'pop-foot' },
      h('button', { class: 'btn btn-block', type: 'button', disabled: !current, onclick: () => { closePopover(); mergeModal(); } }, h('span', { html: icons.merge }), 'Choose a branch to merge into ', h('b', {}, current || 'HEAD')),
    );
    el.append(tabs, h('div', { class: 'pop-head' }, filter, newBtn), body, mergeFoot);

    const branchItem = (name, time, onclick, oncontextmenu) =>
      h(
        'div',
        { class: 'pop-item' + (name === current ? ' current' : ''), onclick, oncontextmenu },
        h('span', { html: name === current ? icons.check : icons.branch }),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, name)),
        time && h('span', { class: 'sub' }, ago(time)),
      );

    const fillBranches = () => {
      if (!branches) return [h('div', { class: 'pop-empty' }, 'Loading…')];
      const term = filter.value.toLowerCase();
      const match = (b) => b.name.toLowerCase().includes(term);
      const byName = new Map(branches.local.map((b) => [b.name, b]));
      const shown = new Set();
      const section = (title, list) => {
        list = list.filter((b) => b && match(b) && !shown.has(b.name));
        list.forEach((b) => shown.add(b.name));
        return list.length ? [h('div', { class: 'pop-group' }, title), list.slice(0, 300).map((b) => branchItem(b.name, b.time, () => switchBranch(b.name, false), (e) => branchMenu(e, b, branches)))] : [];
      };
      const localNames = new Set(branches.local.map((b) => b.name));
      const remote = branches.remote.filter((b) => match(b) && !localNames.has(b.name.slice(b.name.indexOf('/') + 1)));
      const out = [
        section('Default Branch', [byName.get(branches.defaultBranch)]),
        section('Recent Branches', branches.recent.map((n) => byName.get(n))),
        section('Other Branches', branches.local),
        remote.length ? [h('div', { class: 'pop-group' }, 'Remote Branches'), remote.slice(0, 300).map((b) => branchItem(b.name, b.time, () => switchBranch(b.name, true), (e) => remoteBranchMenu(e, b)))] : [],
      ].flat(Infinity);
      return out.length ? out : [h('div', { class: 'pop-empty' }, 'No branches match.')];
    };

    const fillPrs = () => {
      if (prError) return [h('div', { class: 'pop-empty' }, h('div', { class: 'error-box' }, prError))];
      if (prs === undefined) return [h('div', { class: 'pop-empty' }, 'Loading pull requests…')];
      if (prs === null)
        return [h('div', { class: 'pop-empty' }, 'Pull requests come from the GitHub CLI on the server. Install it there and run ', h('code', {}, 'gh auth login'), '.')];
      const term = filter.value.toLowerCase();
      const list = prs.filter((p) => `#${p.number} ${p.title} ${p.headRefName}`.toLowerCase().includes(term));
      if (!list.length) return [h('div', { class: 'pop-empty' }, prs.length ? 'No pull requests match.' : 'No open pull requests.')];
      return [
        h('div', { class: 'pop-group' }, `${prs.length} pull request${prs.length === 1 ? '' : 's'} in this repository`),
        list.map((p) =>
          h(
            'div',
            {
              class: 'pop-item' + (p.headRefName === current ? ' current' : ''),
              title: p.url,
              onclick: () => {
                closePopover();
                withBusy('Checking out pull request', () => git.checkoutPullRequest(ex, S.repo.path, p.number));
              },
            },
            h('span', { html: icons.pr }),
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'title' }, p.title, p.isDraft && h('span', { class: 'tag-badge' }, 'Draft')),
              h('div', { class: 'sub' }, `#${p.number} opened by ${p.author?.login || 'someone'} • updated ${ago(Date.parse(p.updatedAt) / 1000)} • ${p.headRefName}`),
            ),
          ),
        ),
      ].flat(Infinity);
    };

    const fill = () => {
      for (const b of tabs.children) b.classList.toggle('active', b.dataset.tab === tab);
      newBtn.hidden = tab !== 'branches';
      mergeFoot.hidden = tab !== 'branches';
      body.replaceChildren(...(tab === 'branches' ? fillBranches() : fillPrs()));
    };

    const load = async () => {
      try {
        if (tab === 'branches' && !branches) {
          branches = await git.getBranches(ex, S.repo.path);
          if (popover?.el === el) fill();
        }
        if (tab === 'prs' && prs === undefined && !prError) {
          prs = await git.getPullRequests(ex, S.repo.path);
          if (popover?.el === el) fill();
        }
      } catch (e) {
        if (tab === 'prs') prError = e.message;
        else branches = { local: [], remote: [], recent: [], defaultBranch: null };
        if (popover?.el === el) {
          fill();
          if (tab === 'branches') toast(e.message, 'error', 'Could not list branches');
        }
      }
    };
    fill();
    load();
  }, 360);
}

function mergeModal() {
  const target = S.status?.branch.head;
  if (!target) return;
  let branches = [];
  let picked = null;
  let squash = false;
  let countGen = 0;
  const filter = h('input', { type: 'search', placeholder: 'Filter branches', oninput: () => fill() });
  const list = h('div', { class: 'browser merge-list' }, h('div', { class: 'pop-empty' }, 'Loading…'));
  const info = h('div', { class: 'hint' }, 'Pick the branch to bring into ' + target + '.');
  const mode = h('div', { class: 'segmented' });
  const go = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Merge');
  const fillMode = () =>
    mode.replaceChildren(
      ...[[false, 'Create a merge commit'], [true, 'Squash and merge']].map(([v, label]) =>
        h('button', { type: 'button', class: v === squash ? 'active' : '', onclick: () => { squash = v; fillMode(); updateGo(); } }, label),
      ),
    );
  const updateGo = (count) => {
    go.disabled = !picked || count === 0;
    go.replaceChildren(picked ? `${squash ? 'Squash and merge' : 'Merge'} ${picked} into ${target}` : 'Merge');
  };
  const pick = async (name) => {
    picked = name;
    fill();
    updateGo();
    info.textContent = 'Checking…';
    const gen = ++countGen;
    try {
      const n = await git.mergeCount(ex, S.repo.path, name);
      if (gen !== countGen) return;
      info.textContent = n ? `This will merge ${n} commit${n === 1 ? '' : 's'} from ${name} into ${target}.` : `${target} is already up to date with ${name}.`;
      updateGo(n);
    } catch (e) {
      info.textContent = e.message;
    }
  };
  const fill = () => {
    const term = filter.value.toLowerCase();
    const shown = branches.filter((b) => b.toLowerCase().includes(term));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((b) =>
            h('div', { class: 'browser-row' + (b === picked ? ' picked' : ''), onclick: () => pick(b) }, h('span', { html: b === picked ? icons.check : icons.branch }), h('span', { class: 'grow' }, b)),
          )
        : [h('div', { class: 'pop-empty' }, branches.length ? 'No branches match.' : 'No other branches.')]),
    );
  };
  let close;
  go.addEventListener('click', () => {
    close();
    withBusy(squash ? 'Squash and merge' : 'Merge', async () => {
      await git.mergeBranch(ex, S.repo.path, picked, { squash });
      S.history.oid = undefined;
    });
  });
  fillMode();
  close = openModal({
    title: `Merge into ${target}`,
    wide: true,
    body: [filter, list, mode, info],
    foot: (c) => [h('button', { class: 'btn', type: 'button', onclick: c }, 'Cancel'), go],
  });
  git.getBranches(ex, S.repo.path).then(
    (b) => {
      const localNames = new Set(b.local.map((x) => x.name));
      branches = [
        ...b.local.map((x) => x.name).filter((n) => n !== target),
        ...b.remote.map((x) => x.name).filter((n) => !localNames.has(n.slice(n.indexOf('/') + 1)) || n.slice(n.indexOf('/') + 1) === target),
      ];
      fill();
    },
    (e) => list.replaceChildren(h('div', { class: 'pop-empty' }, h('div', { class: 'error-box' }, e.message))),
  );
}

function switchBranch(name, remote) {
  closePopover();
  if (!remote && name === S.status?.branch.head) return;
  const go = () =>
    withBusy('Switching branch', async () => {
      if (remote) await git.checkoutRemoteBranch(ex, S.repo.path, name);
      else await git.checkoutBranch(ex, S.repo.path, name);
      S.lastCommit = null;
    });
  if (currentFiles().length && S.status.branch.head) switchWithChangesModal(remote ? name.slice(name.indexOf('/') + 1) : name, go);
  else go();
}

// GitHub Desktop's choice: leave the changes stashed on this branch, or take them along.
function switchWithChangesModal(target, go) {
  const from = S.status.branch.head;
  const hadStash = !!S.status.stash;
  let leave = true;
  const option = (value, title, sub) =>
    h(
      'label',
      { class: 'check choice' },
      h('input', { type: 'radio', name: 'switch-choice', checked: value === leave, onchange: () => (leave = value) }),
      h('span', {}, h('b', {}, title), h('br'), h('span', { class: 'hint' }, sub)),
    );
  openModal({
    title: 'Switch branch',
    body: [
      h('p', { style: 'margin:0 0 10px' }, `You have changes on ${from}. What should happen to them?`),
      option(true, `Leave my changes on ${from}`, hadStash ? `They are stashed, replacing the changes already stashed on ${from}.` : `They are stashed; restore them when you come back to ${from}.`),
      option(false, `Bring my changes to ${target}`, 'Your changes come along to the other branch.'),
    ],
    foot: (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => {
            close();
            if (!leave) return go();
            // Switch only once the changes are safely stashed.
            withBusy('Stashing changes', async () => {
              if (S.status.stash) await git.dropStash(ex, S.repo.path, S.status.stash.sha);
              await git.stashChanges(ex, S.repo.path, from);
              return true;
            }).then((ok) => ok && go());
          },
        },
        'Switch branch',
      ),
    ],
  });
}

// ============================================================ stash

function renderStashRow() {
  const row = $('#stash-row');
  const stash = S.status?.stash;
  row.hidden = !stash;
  if (!stash) return;
  row.classList.toggle('selected', !!S.stashView);
  row.replaceChildren(
    h('span', { html: icons.stack }),
    h('span', { class: 'grow' }, 'Stashed Changes'),
    h('span', { class: 'sub' }, ago(stash.time)),
    h('span', { html: icons.chevronRight }),
  );
  row.onclick = openStash;
}

async function openStash() {
  const stash = S.status?.stash;
  if (!stash) return;
  if (S.stashView?.sha === stash.sha) return;
  S.stashView = { sha: stash.sha, files: null, file: null, diff: null };
  renderChanges();
  renderContent();
  const gen = S.gen;
  try {
    const files = await git.getStashFiles(ex, S.repo.path, stash.sha);
    if (gen !== S.gen || S.stashView?.sha !== stash.sha) return;
    S.stashView.files = files;
    selectStashFile(files[0] || null);
  } catch (e) {
    if (gen === S.gen && S.stashView) {
      S.stashView.error = e.message;
      renderContent();
    }
  }
}

async function selectStashFile(f) {
  const V = S.stashView;
  if (!V) return;
  V.file = f;
  V.diff = null;
  S.diffFull = false;
  renderContent();
  if (!f) return;
  try {
    const d = await git.getStashFileDiff(ex, S.repo.path, V.sha, f);
    if (S.stashView === V && V.file === f) V.diff = d;
  } catch (e) {
    if (S.stashView === V && V.file === f) V.diff = { error: e.message };
  }
  if (S.stashView === V) renderContent();
}

function stashView() {
  const V = S.stashView;
  const changes = currentFiles().length;
  const head = h(
    'div',
    { class: 'commit-detail-head stash-head' },
    h('div', { class: 'grow' }, h('h2', {}, 'Stashed changes'), h('div', { class: 'meta' }, h('span', {}, V.files ? `${V.files.length} changed file${V.files.length === 1 ? '' : 's'}` : 'Loading…'), h('span', {}, `stashed ${ago(S.status.stash?.time)}`))),
    h(
      'div',
      { class: 'stash-actions' },
      h('button', { class: 'btn', type: 'button', disabled: !!S.busy, onclick: () => confirmModal({ title: 'Discard stashed changes?', message: 'The stashed changes will be permanently lost.', confirm: 'Discard', danger: true, onConfirm: () => withBusy('Discard stash', () => git.dropStash(ex, S.repo.path, V.sha)) }) }, 'Discard'),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: !!S.busy, title: changes ? 'Git restores the stash over your current changes when they don’t touch the same files.' : null, onclick: () => withBusy('Restore stash', () => git.restoreStash(ex, S.repo.path, V.sha)) }, 'Restore'),
    ),
  );
  if (V.error) return [head, h('div', { class: 'diff-notice' }, h('div', { class: 'error-box' }, V.error))];
  const files = h(
    'div',
    { class: 'file-list', id: 'stash-files' },
    (V.files || []).map((f) => {
      const [dir, name] = splitPath(f.path);
      return h(
        'div',
        { class: 'file-row' + (f === V.file ? ' selected' : ''), title: f.path, onclick: () => selectStashFile(f) },
        h('span', { class: 'file-path' }, h('span', { class: 'dir' }, ltr((f.orig ? f.orig + ' → ' : '') + dir)), h('span', { class: 'name' }, name)),
        h('span', { class: `file-status ${f.kind}`, html: fileIcon(f.kind) }),
      );
    }),
  );
  const diffCol = h('div', { class: 'diff-col' }, V.file ? diffView(V.diff, null, V.file.path) : h('div', { class: 'diff-notice' }, V.files ? 'The stash has no file changes.' : 'Loading…'));
  return [head, h('div', { class: 'split' }, files, diffCol)];
}

function stashAll() {
  const branch = S.status?.branch.head;
  if (!branch || !currentFiles().length) return;
  const run = () =>
    withBusy('Stashing changes', async () => {
      if (S.status.stash) await git.dropStash(ex, S.repo.path, S.status.stash.sha);
      await git.stashChanges(ex, S.repo.path, branch);
    });
  if (!S.status.stash) return run();
  confirmModal({
    title: 'Overwrite stashed changes?',
    message: `${branch} already has stashed changes. Stashing again replaces them, and the older stash is lost.`,
    confirm: 'Overwrite',
    danger: true,
    onConfirm: run,
  });
}

// ============================================================ branch actions

function branchMenu(e, b, branches) {
  e.preventDefault();
  e.stopPropagation();
  const st = S.status;
  const isCurrent = b.name === st.branch.head;
  const web = git.webUrl(st.remote?.url);
  const remoteName = b.upstream?.slice(b.upstream.indexOf('/') + 1);
  const onRemote = !!b.upstream && branches.remote.some((r) => r.name === b.upstream);
  openMenu(e.clientX, e.clientY, [
    !isCurrent && { label: 'Switch to Branch', disabled: !!S.busy, run: () => switchBranch(b.name, false) },
    { label: 'Rename…', disabled: !!S.busy, run: () => { closePopover(); renameBranchModal(b); } },
    { label: 'Copy Branch Name', run: () => copyText(b.name) },
    web && onRemote && { label: new URL(web).hostname === 'github.com' ? 'View Branch on GitHub' : 'View Branch on the Web', run: () => openExternal(`${web}/tree/${remoteName.split('/').map(encodeURIComponent).join('/')}`) },
    '-',
    { label: isCurrent ? 'Delete… (switch to another branch first)' : 'Delete…', danger: true, disabled: isCurrent || !!S.busy, run: () => { closePopover(); deleteBranchModal(b, onRemote); } },
  ]);
}

function remoteBranchMenu(e, b) {
  e.preventDefault();
  e.stopPropagation();
  openMenu(e.clientX, e.clientY, [
    { label: 'Check Out', disabled: !!S.busy, run: () => switchBranch(b.name, true) },
    { label: 'Copy Branch Name', run: () => copyText(b.name.slice(b.name.indexOf('/') + 1)) },
  ]);
}

function renameBranchModal(b) {
  const input = h('input', { value: b.name, spellcheck: false });
  const error = h('div', { class: 'form-error' });
  const submit = async (close) => {
    const name = input.value.trim().replace(/\s+/g, '-');
    if (!name || name === b.name) return close();
    try {
      await git.renameBranch(ex, S.repo.path, b.name, name);
      close();
      refresh();
    } catch (e) {
      error.textContent = e.message;
    }
  };
  let closeFn;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(closeFn));
  closeFn = openModal({
    title: 'Rename branch',
    body: [field('Name', input, b.upstream ? `Only the local branch is renamed; ${b.upstream} keeps its name.` : null), error],
    foot: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => submit(close) }, 'Rename')],
  });
  input.select();
}

function deleteBranchModal(b, onRemote) {
  let force = false;
  let alsoRemote = false;
  const message = h('p', { style: 'margin:0' }, `Delete the branch “${b.name}”?`);
  const error = h('div', { class: 'form-error' });
  const remoteBox =
    onRemote &&
    h(
      'label',
      { class: 'check', style: 'margin-top:10px' },
      h('input', { type: 'checkbox', onchange: (e) => (alsoRemote = e.target.checked) }),
      `Also delete ${b.upstream} from the remote`,
    );
  const btn = h('button', { class: 'btn btn-danger', type: 'button' }, 'Delete');
  const closeFn = openModal({
    title: 'Delete branch',
    body: [message, remoteBox, error],
    foot: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), btn],
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    error.textContent = '';
    try {
      await git.deleteBranch(ex, S.repo.path, b.name, { force });
      if (alsoRemote) await git.deleteRemoteBranch(ex, S.repo.path, b.upstream);
      closeFn();
      refresh();
    } catch (e) {
      btn.disabled = false;
      if (e.unmerged && !force) {
        force = true;
        message.textContent = `“${b.name}” has commits that aren’t merged anywhere else. Deleting it loses them.`;
        btn.textContent = 'Delete anyway';
      } else error.textContent = e.message;
    }
  });
}

// ============================================================ clone

function cloneModal(preselected) {
  if (!store.servers.length) return serverModal();
  let server = preselected || filterServer() || S.server || store.servers[0];
  let ghRepos;
  let pathEdited = false;
  const parentOf = (srv) => {
    const last = store.repos.filter((r) => r.serverId === srv.id).pop();
    return last ? last.path.replace(/\/[^/]+\/?$/, '') || '~' : '~';
  };
  let parent = parentOf(server);
  const source = h('input', { placeholder: 'owner/name, https://… or git@…', spellcheck: false, autofocus: true });
  const path = h('input', { spellcheck: false });
  const list = h('div', { class: 'repo-scan' });
  const error = h('div', { class: 'form-error' });
  const cloneBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Clone');
  const updatePath = () => {
    if (!pathEdited) path.value = `${parent.replace(/\/$/, '')}/${git.cloneName(source.value)}`;
  };
  const fillList = () => {
    if (ghRepos === undefined) return list.replaceChildren(h('div', { class: 'pop-empty' }, 'Loading your GitHub repositories…'));
    if (ghRepos === null)
      return list.replaceChildren(h('div', { class: 'pop-empty' }, 'To pick from your GitHub repositories, sign in to the GitHub CLI on the server (', h('code', {}, 'gh auth login'), '). A URL works either way.'));
    const term = source.value.trim().toLowerCase();
    const shown = ghRepos.filter((r) => `${r.nameWithOwner} ${r.description || ''}`.toLowerCase().includes(term)).slice(0, 200);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((r) =>
            h(
              'div',
              { class: 'pop-item' + (r.nameWithOwner === source.value.trim() ? ' current' : ''), onclick: () => { source.value = r.nameWithOwner; updatePath(); fillList(); } },
              h('span', { html: icons.repo }),
              h('div', { class: 'grow' }, h('div', { class: 'title' }, r.nameWithOwner, r.isPrivate && h('span', { class: 'tag-badge' }, 'Private')), r.description && h('div', { class: 'sub' }, r.description)),
            ),
          )
        : [h('div', { class: 'pop-empty' }, ghRepos.length ? 'No repositories match.' : 'No repositories on your GitHub account.')]),
    );
  };
  const loadGh = async () => {
    ghRepos = undefined;
    fillList();
    try {
      ghRepos = await git.listGitHubRepos((script, t) => execOn(server, script, t));
    } catch {
      ghRepos = null;
    }
    fillList();
  };
  source.addEventListener('input', () => { updatePath(); fillList(); });
  path.addEventListener('input', () => (pathEdited = true));
  const serverSelect = h(
    'select',
    { onchange: () => { server = store.servers.find((s) => s.id === serverSelect.value); parent = parentOf(server); updatePath(); loadGh(); } },
    store.servers.map((s) => h('option', { value: s.id, selected: s.id === server.id }, s.name || s.host)),
  );
  const closeFn = openModal({
    title: 'Clone a repository',
    wide: true,
    body: [
      store.servers.length > 1 && field('Server', serverSelect),
      field('Repository', source),
      list,
      h(
        'div',
        { class: 'field' },
        h('span', {}, server.local ? 'Folder on this computer' : 'Folder on the server'),
        h(
          'div',
          { class: 'input-row' },
          path,
          h('button', { class: 'btn', type: 'button', onclick: () => folderBrowser(server, parent, (p) => { parent = p; pathEdited = false; updatePath(); }) }, h('span', { html: icons.folder }), 'Choose…'),
        ),
      ),
      error,
    ],
    foot: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), cloneBtn],
  });
  cloneBtn.addEventListener('click', async () => {
    const src = source.value.trim();
    const dest = path.value.trim();
    if (!src || !dest || dest.endsWith('/')) return (error.textContent = 'Enter the repository and a folder for it.');
    error.textContent = '';
    cloneBtn.disabled = true;
    cloneBtn.textContent = 'Cloning…';
    try {
      const run = (script, t) => execOn(server, script, t);
      await git.cloneRepo(run, src, dest);
      const top = await git.resolveRepo(run, dest);
      closeFn();
      addRepos(server, [top]);
    } catch (e) {
      error.textContent = e.message;
      cloneBtn.disabled = false;
      cloneBtn.textContent = 'Clone';
    }
  });
  updatePath();
  loadGh();
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
    if (e.key === 'Escape' && $('#modal-root').lastElementChild === backdrop) {
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
  const report = h('div', { class: 'test-report' });
  const browse =
    tauri.dialog &&
    h('button', { class: 'btn', type: 'button', onclick: () => pickKey(key, error) }, h('span', { html: icons.folder }), 'Browse…');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, existing ? 'Save' : 'Connect');
  const testBtn = h('button', { class: 'btn', type: 'button' }, 'Test connection');
  let local = !!s.local;
  const sshFields = h(
    'div',
    { class: 'field-stack' },
    field('Host', host),
    h('div', { class: 'field-row' }, field('User', user), field('Port', port)),
    field('SSH key', h('div', { class: 'input-row' }, key, browse), 'The private key file (not .pub). Leave empty to use your SSH agent and ~/.ssh/config.'),
    h('label', { class: 'check' }, agent, h('span', {}, h('b', {}, 'Forward my SSH agent'), h('br'), h('span', { class: 'hint' }, 'Lets push/pull on the server use the keys from this computer (e.g. for GitHub).'))),
  );
  const localNote = h(
    'div',
    { class: 'hint' },
    isMac
      ? 'Repositories on this Mac. Needs git (Xcode Command Line Tools or Homebrew).'
      : 'Repositories on this PC. Needs Git for Windows, which provides the sh.exe RemoteGit runs git through.',
  );
  const kind = h('div', { class: 'segmented' });
  const fillKind = () => {
    kind.replaceChildren(
      ...[[false, 'Server over SSH'], [true, 'This computer']].map(([v, label]) =>
        h('button', { type: 'button', class: v === local ? 'active' : '', disabled: !!existing && v !== local, onclick: () => { local = v; fillKind(); } }, label),
      ),
    );
    sshFields.hidden = local;
    localNote.hidden = !local;
    name.placeholder = local ? 'This computer' : 'My server';
  };
  fillKind();

  const readDraft = () => {
    const draft = local
      ? { id: s.id || uid(), name: name.value.trim() || 'This computer', host: 'localhost', local: true }
      : {
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
      return null;
    }
    error.textContent = '';
    return draft;
  };

  openModal({
    title: existing ? 'Server settings' : 'Add a server',
    body: [kind, field('Name', name), sshFields, localNote, report, error],
    foot: (close) => [
      existing && h('button', { class: 'btn btn-danger left', type: 'button', onclick: () => { close(); removeServer(existing); } }, 'Remove server'),
      testBtn,
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      saveBtn,
    ],
  });

  // Uses a throwaway connection id so an edited server's live session is untouched.
  testBtn.addEventListener('click', async () => {
    const draft = readDraft();
    if (!draft) return;
    const temp = { ...draft, id: 'test-' + uid() };
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    report.replaceChildren();
    try {
      await connect(temp);
      const r = await execOn(
        temp,
        `echo "user $(id -un)@$(hostname)"
git --version 2>/dev/null || echo "git missing"
${git.AI_PATH}
if command -v gh >/dev/null 2>&1; then gh auth status >/dev/null 2>&1 && echo "gh ok" || echo "gh signed-out"; else echo "gh missing"; fi
command -v claude >/dev/null 2>&1 && echo "claude ok" || echo "claude missing"
command -v codex >/dev/null 2>&1 && echo "codex ok" || echo "codex missing"`,
        30,
      );
      const out = r.stdout;
      const line = (ok, text) => h('div', { class: ok ? 'ok' : 'warn' }, ok ? '✓ ' : '– ', text);
      const who = /^user (.+)$/m.exec(out)?.[1];
      const gitVer = /^git version (\S+)/m.exec(out)?.[1];
      report.replaceChildren(
        line(true, draft.local ? `Running as ${who || 'you'} on this computer` : `Connected as ${who || draft.host}`),
        line(!!gitVer, gitVer ? `Git ${gitVer}` : 'Git is not installed on the server'),
        line(/^gh ok$/m.test(out), /^gh ok$/m.test(out) ? 'GitHub CLI signed in — pull requests available' : /^gh signed-out$/m.test(out) ? `GitHub CLI found but not signed in (run gh auth login ${draft.local ? 'in a terminal' : 'on the server'})` : 'GitHub CLI not installed — no pull request list'),
        line(/^claude ok$/m.test(out), /^claude ok$/m.test(out) ? 'Claude Code found — writes AI commit messages' : 'Claude Code not installed'),
        line(/^codex ok$/m.test(out), /^codex ok$/m.test(out) ? (/^claude ok$/m.test(out) ? 'Codex found — used when Claude Code is missing' : 'Codex found — writes AI commit messages') : 'Codex not installed'),
      );
    } catch (e) {
      error.textContent = e.message;
    } finally {
      forgetConnection(temp.id);
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
    }
  });

  saveBtn.addEventListener('click', async () => {
    const draft = readDraft();
    if (!draft) return;
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

async function pickKey(input, error) {
  try {
    const home = await tauri.path.homeDir();
    const picked = await tauri.dialog.open({
      title: 'Choose your private SSH key',
      defaultPath: await tauri.path.join(home, '.ssh'),
      multiple: false,
      directory: false,
    });
    if (typeof picked !== 'string') return;
    let path = picked.replace(/\.pub$/, '');
    if (path.startsWith(home + '/') || path.startsWith(home + '\\')) path = '~' + path.slice(home.length).replace(/\\/g, '/');
    input.value = path;
    error.textContent = picked.endsWith('.pub') ? 'Picked the matching private key (without .pub).' : '';
  } catch (e) {
    error.textContent = String(e);
  }
}

async function addThisComputer() {
  const existing = store.servers.find((s) => s.local);
  if (existing) return addRepoModal(existing);
  const server = { id: uid(), name: 'This computer', host: 'localhost', local: true };
  try {
    await connect(server);
  } catch (e) {
    return toast(e.message, 'error', 'Can’t use git on this computer');
  }
  store.servers.push(server);
  save();
  renderAll();
  addRepoModal(server);
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
      if (store.serverFilter === server.id) store.serverFilter = null;
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
  let server = preselected || filterServer() || S.server || store.servers[0];
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
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'Or pick a folder on the server'),
        h(
          'div',
          { class: 'input-row' },
          manual,
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                if (server.local && tauri.dialog) {
                  const picked = await tauri.dialog.open({ directory: true, multiple: false, title: 'Choose a repository folder' }).catch(() => null);
                  if (typeof picked === 'string') {
                    manual.value = picked;
                    addManual();
                  }
                  return;
                }
                folderBrowser(server, manual.value.trim() || '~', (path) => {
                  manual.value = path;
                  addManual();
                });
              },
            },
            h('span', { html: icons.folder }),
            'Browse…',
          ),
          h('button', { class: 'btn', type: 'button', onclick: addManual }, 'Add'),
        ),
      ),
      error,
    ],
    foot: (close) => [h('button', { class: 'btn left', type: 'button', onclick: scan }, 'Rescan'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), addBtn],
  });
  scan();
}

function commitMenu(e, c) {
  e.preventDefault();
  const st = S.status;
  const H = S.history;
  const idx = H.commits.findIndex((x) => x.sha === c.sha);
  const isHead = c.sha === st?.branch.oid;
  const unpushed = (x) => !st?.branch.upstream || H.unpushed.has(x.sha);
  const busy = !!S.busy;
  const web = git.webUrl(st?.remote?.url);
  const site = web && new URL(web).hostname === 'github.com' ? 'GitHub' : 'the web';
  const reload = () => loadHistory(true);
  openMenu(e.clientX, e.clientY, [
    {
      label: 'Amend Commit…',
      disabled: busy || !isHead || !unpushed(c) || !st.branch.head,
      run: () => amendCommit(c),
    },
    {
      label: 'Reset to Commit…',
      disabled: busy || isHead || !st.branch.head || !H.commits.slice(0, idx).every(unpushed),
      run: () =>
        confirmModal({
          title: 'Reset to this commit?',
          message: `${st.branch.head} will point at “${c.summary}”. The ${idx} newer commit${idx > 1 ? 's' : ''} become uncommitted changes, so nothing is lost.`,
          confirm: 'Reset',
          onConfirm: () => withBusy('Reset', () => git.resetToCommit(ex, S.repo.path, c.sha)),
        }),
    },
    { label: 'Checkout Commit', disabled: busy || isHead, run: () => withBusy('Checkout', () => git.checkoutCommit(ex, S.repo.path, c.sha)) },
    { label: 'Revert Changes in Commit', disabled: busy || !st.branch.head, run: () => withBusy('Revert', () => git.revertCommit(ex, S.repo.path, c.sha, c.parents.length > 1)) },
    '-',
    {
      label: 'Create Branch from Commit',
      disabled: busy,
      run: () => promptModal({ title: 'Create a branch', label: 'Name', placeholder: 'feature/my-change', hint: `Starts at ${c.short} and switches to it.`, confirm: 'Create branch', run: (name) => withBusy('Create branch', () => git.createBranchAt(ex, S.repo.path, name, c.sha)) }),
    },
    {
      label: 'Create Tag…',
      disabled: busy,
      run: () => promptModal({ title: 'Create a tag', label: 'Name', placeholder: 'v1.0.0', hint: `Tags ${c.short}. It's sent to the remote with your next push.`, confirm: 'Create tag', run: (name) => withBusy('Create tag', async () => { await git.createTag(ex, S.repo.path, name, c.sha); reload(); }) }),
    },
    { label: 'Cherry-pick Commit…', disabled: busy, run: () => cherryPickModal(c) },
    '-',
    { label: 'Copy SHA', run: () => copyText(c.sha) },
    { label: 'Copy Tag', disabled: !c.tags.length, run: () => copyText(c.tags[0]) },
    { label: `View on ${site}`, disabled: !web, run: () => openExternal(`${web}/commit/${c.sha}`) },
  ]);
}

/** Like GitHub Desktop's amend: the commit goes back to Changes with its message. */
async function amendCommit(c) {
  await withBusy('Amend', async () => {
    const full = await git.getCommit(ex, S.repo.path, c.sha);
    await git.undoCommit(ex, S.repo.path, c.sha);
    $('#summary').value = full.summary;
    $('#description').value = full.body;
    S.lastCommit = null;
  });
  setTab('changes');
  $('#summary').focus();
}

function promptModal({ title, label, placeholder, hint, confirm, run }) {
  const input = h('input', { placeholder, spellcheck: false });
  let close;
  const submit = () => {
    const value = input.value.trim().replace(/\s+/g, '-');
    if (!value) return;
    close();
    run(value);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  close = openModal({
    title,
    body: field(label, input, hint),
    foot: (c) => [h('button', { class: 'btn', type: 'button', onclick: c }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, confirm)],
  });
}

async function cherryPickModal(c) {
  let branches;
  try {
    branches = (await git.getBranches(ex, S.repo.path)).local.filter((b) => b.name !== S.status?.branch.head);
  } catch (e) {
    return toast(e.message, 'error', 'Could not list branches');
  }
  if (!branches.length) return toast('Create another branch first.', 'info', 'No other branch to cherry-pick onto');
  const select = h('select', {}, branches.map((b) => h('option', { value: b.name }, b.name)));
  openModal({
    title: 'Cherry-pick commit',
    body: field('Onto branch', select, `Switches to that branch and applies “${c.summary}” on top.`),
    foot: (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { close(); withBusy('Cherry-pick', () => git.cherryPick(ex, S.repo.path, c.sha, select.value)); } }, 'Cherry-pick'),
    ],
  });
}

function folderBrowser(server, start, onPick) {
  const run = (script, t) => execOn(server, script, t);
  const crumbs = h('div', { class: 'crumbs' });
  const list = h('div', { class: 'browser', tabindex: '0' });
  const pickBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Add this repository');
  let current = null;
  let close;
  const join = (base, name) => `${base === '/' ? '' : base}/${name}`;
  const pick = (path) => {
    close();
    onPick(path);
  };
  const row = (label, path, { isRepo, up } = {}) =>
    h(
      'div',
      { class: 'browser-row' + (isRepo ? ' repo' : ''), onclick: () => go(path), title: path },
      h('span', { html: up ? icons.up : isRepo ? icons.repo : icons.folder }),
      h('span', { class: 'grow' }, label),
      isRepo && h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: (e) => { e.stopPropagation(); pick(path); } }, 'Add'),
    );
  const go = async (path) => {
    list.replaceChildren(h('div', { class: 'pop-empty' }, 'Loading…'));
    try {
      const res = await git.listDir(run, path);
      current = res;
      const parts = res.path.split('/').filter(Boolean);
      crumbs.replaceChildren(
        h('button', { class: 'crumb', type: 'button', onclick: () => go('/') }, '/'),
        ...parts.map((part, i) => h('button', { class: 'crumb', type: 'button', onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, part)),
      );
      pickBtn.disabled = !res.isRepo;
      pickBtn.textContent = res.isRepo ? 'Add this repository' : 'This folder is not a Git repository';
      list.replaceChildren(
        ...[
          res.path !== '/' && row('..', res.path.replace(/\/[^/]+$/, '') || '/', { up: true }),
          res.dirs.map((d) => row(d.name, join(res.path, d.name), { isRepo: d.isRepo })),
          !res.dirs.length && h('div', { class: 'pop-empty' }, 'No folders here.'),
        ].flat().filter(Boolean),
      );
      list.scrollTop = 0;
    } catch (e) {
      list.replaceChildren(h('div', { class: 'pop-empty' }, h('div', { class: 'error-box' }, e.message)));
    }
  };
  pickBtn.addEventListener('click', () => current && pick(current.path));
  close = openModal({
    title: `Folders on ${server.name || server.host}`,
    wide: true,
    body: [crumbs, list, h('div', { class: 'hint' }, 'Click a folder to open it. Git repositories have the repository icon and an Add button.')],
    foot: (c) => [h('button', { class: 'btn', type: 'button', onclick: c }, 'Cancel'), pickBtn],
  });
  go(start);
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

// ============================================================ updates

let appVersion = '';

// Updates come from the GitHub release's latest.json and are signature-checked
// by the updater plugin before anything is installed.
async function checkForUpdates({ quiet = false } = {}) {
  if (!tauri?.updater) {
    if (!quiet) toast('Updates are checked in the installed app.');
    return;
  }
  try {
    const update = await tauri.updater.check();
    if (update) showUpdatePopup(update);
    else if (!quiet) toast(`RemoteGit ${appVersion} is the latest version.`);
  } catch (e) {
    if (!quiet) toast(String(e), 'error', 'Could not check for updates');
  }
}

function showUpdatePopup(update) {
  if ($('#update-popup')) return;
  const install = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Install and restart');
  const el = h(
    'div',
    { class: 'toast update', id: 'update-popup' },
    h(
      'div',
      { class: 'msg' },
      h('b', {}, `RemoteGit ${update.version} is available`),
      appVersion ? `You have ${appVersion}.` : '',
      update.body && h('div', { class: 'update-notes' }, update.body),
      h('div', { class: 'update-actions' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => el.remove() }, 'Later'), install),
    ),
  );
  install.addEventListener('click', async () => {
    install.disabled = true;
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength || 0;
        else if (ev.event === 'Progress') {
          done += ev.data.chunkLength;
          install.textContent = total ? `Downloading ${Math.round((done / total) * 100)}%` : 'Downloading…';
        } else if (ev.event === 'Finished') install.textContent = 'Installing…';
      });
      await tauri.process.relaunch();
    } catch (e) {
      install.disabled = false;
      install.textContent = 'Install and restart';
      toast(String(e), 'error', 'The update failed');
    }
  });
  $('#toast-root').append(el);
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
  $('#tb-server').addEventListener('click', serverPopover);
  $('#tb-settings').addEventListener('click', settingsPopover);
  // The menu bar window owns no settings of its own; the theme is stored here.
  tauri.event?.listen('set-theme', (e) => {
    store.theme = e.payload;
    save();
    applyTheme();
  });
  $('#commit-opts-btn').addEventListener('click', commitOptionsMenu);
  $('#coauthor-btn').addEventListener('click', toggleCoAuthors);
  $('#ai-btn').addEventListener('click', generateMessage);
  applyTheme();
  renderCommitFlags();
  tauri.app?.getVersion().then((v) => (appVersion = v), () => {});
  setTimeout(() => checkForUpdates({ quiet: true }), 5000);
  setInterval(() => checkForUpdates({ quiet: true }), 6 * 3600 * 1000);
  if (trayPrefs().showInMenuBar) tauri.core.invoke('set_tray_visible', { visible: true }).catch(() => {});
  if (trayPrefs().showInMenuBar && trayPrefs().menuBarOnly) {
    // Start straight in the menu bar; the tray icon brings the window back.
    tauri.core.invoke('set_menu_bar_only', { enabled: true }).catch(() => {});
    try {
      tauri.window?.getCurrentWindow?.().hide();
    } catch {}
  }
  $('#tb-branch').addEventListener('click', () => branchPopover());
  $('#tb-sync').addEventListener('click', () => runSync());
  const syncMenu = (x, y) => {
    const remote = S.status?.remote?.name;
    if (!remote || S.busy) return;
    openMenu(x, y, [
      { label: `Fetch ${remote}`, run: () => runSync({ kind: 'fetch', run: () => git.fetchRemote(ex, S.repo.path, remote) }) },
      S.status.branch.upstream && { label: `Pull ${remote}`, run: () => runSync({ kind: 'pull', run: () => git.pull(ex, S.repo.path) }) },
      S.status.branch.head && { label: `Push ${remote}`, run: () => runSync({ kind: 'push', run: () => git.push(ex, S.repo.path, { remote, hasUpstream: !!S.status.branch.upstream }) }) },
    ]);
  };
  $('#tb-sync').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    syncMenu(e.clientX, e.clientY);
  });
  $('#tb-sync-more').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    syncMenu(r.left, r.bottom + 2);
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
    if (files.length)
      openMenu(e.clientX, e.clientY, [
        S.status.branch.head && { label: 'Stash all changes', disabled: !!S.busy, run: stashAll },
        { label: 'Discard all changes…', danger: true, run: () => confirmDiscard(files) },
      ]);
  });
  $('#commit-form').addEventListener('submit', doCommit);
  $('#summary').addEventListener('input', updateCommitButton);

  for (const id of ['#file-list', '#commit-list'])
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
      if (e.key === 'ArrowRight' && id === '#commit-list') {
        e.preventDefault();
        const files = $('#commit-files');
        if (files?.querySelector('.file-row')) files.focus();
      }
      if (e.key === ' ' && id === '#file-list' && S.selectedPath && e.target === e.currentTarget) {
        e.preventDefault();
        if (S.excluded.has(S.selectedPath)) S.excluded.delete(S.selectedPath);
        else S.excluded.add(S.selectedPath);
        renderChanges();
      }
    });
  let searchTimer;
  $('#history-filter').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const term = e.target.value.trim();
      if (term === S.history.search) return;
      S.history.search = term;
      S.history.commits = [];
      S.history.done = false;
      renderHistory();
      loadHistory(true);
    }, 250);
  });
  $('#history-filter').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('#commit-list').focus();
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
    const sc = matchShortcut(e);
    if (sc && !(sc[0] === 'Mod+Enter' && !e.target.closest?.('#commit-form'))) {
      e.preventDefault();
      sc[2]();
    }
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

  window.addEventListener('focus', () => {
    refresh();
    schedulePoll();
  });
  window.addEventListener('blur', () => clearTimeout(pollTimer));
  // Keep "Last fetched … ago" fresh.
  setInterval(() => {
    if (!S.status || S.busy) return;
    renderToolbar();
    renderUndo();
  }, 30000);

  selectRepo(store.currentRepoId || store.repos[0]?.id);
  schedulePoll();
}

init();
