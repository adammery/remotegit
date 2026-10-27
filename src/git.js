// Git operations, expressed as POSIX shell scripts that run on the server,
// plus parsers for their output. Every function takes `exec(script, timeoutSecs)`
// which resolves to { stdout, stderr, code } — over SSH in the app, local `sh`
// in tests and the browser preview.

const SEP = '\x1d';
const PRINT_SEP = "printf '\\035'";
const DIFF_LIMIT = 2_000_000;
const NET_TIMEOUT = 300;

/** POSIX single-quote escaping. */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Like q() but keeps a leading ~ expandable on the server. */
export function qpath(p) {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${q(p.slice(2))}`;
  return q(p);
}

// GIT_OPTIONAL_LOCKS=0 keeps background polling from fighting with whoever is
// using the repo on the server. Prompts would hang without a terminal.
const GIT =
  'GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C git -c core.quotepath=false -c color.ui=false --literal-pathspecs';

const inRepo = (repo, body) => `cd ${qpath(repo)} || exit 128\n${body}`;

// The GitHub CLI, also when it's installed in ~/.local/bin; exit 127 without it.
const GH = 'GH_PROMPT_DISABLED=1 NO_COLOR=1 gh';
const ghPath = 'PATH="$HOME/.local/bin:/usr/local/bin:$PATH"\ncommand -v gh >/dev/null 2>&1 || exit 127';

export class GitError extends Error {}

function must(r) {
  if (r.code !== 0) throw new GitError((r.stderr || r.stdout).trim() || `Command failed (exit ${r.code})`);
  return r.stdout;
}

const run = async (exec, script, timeout) => must(await exec(script, timeout));

// ---------------------------------------------------------------- repos

export async function findRepos(exec) {
  const out = await run(
    exec,
    `echo "$HOME"
for r in "$HOME" /var/www /srv; do
  [ -d "$r" ] || continue
  find "$r" -maxdepth 5 \\( -name node_modules -o -name vendor -o -name .cache -o -name .npm \\
    -o -name .cargo -o -name .rustup -o -name .local -o -name target -o -name .Trash \\) -prune \\
    -o -name .git -print -prune 2>/dev/null
done | head -n 400`,
    60,
  );
  const [home, ...lines] = out.split('\n');
  const repos = [...new Set(lines.filter(Boolean).map((l) => l.replace(/\/\.git$/, '')))].sort();
  return { home, repos };
}

/** Resolves a user-typed path to the repository's top-level directory. */
export async function resolveRepo(exec, path) {
  const out = await run(exec, inRepo(path, `${GIT} rev-parse --show-toplevel`));
  return out.trim();
}

// --------------------------------------------------------------- status

export async function getStatus(exec, repo) {
  const out = await run(
    exec,
    inRepo(
      repo,
      `${GIT} status --porcelain=v2 -z --branch --untracked-files=all || exit $?
${PRINT_SEP}
${GIT} remote -v
${PRINT_SEP}
f=$(${GIT} rev-parse --git-path FETCH_HEAD)
stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null
${PRINT_SEP}
d=$(${GIT} rev-parse --git-dir)
for s in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e "$d/$s" ] && echo "$s"; done
{ [ -d "$d/rebase-merge" ] || [ -d "$d/rebase-apply" ]; } && echo REBASE
${PRINT_SEP}
${GIT} config user.name
${PRINT_SEP}
${GIT} config user.email
${PRINT_SEP}
${GIT} stash list --format='%gd%x1f%H%x1f%ct%x1f%gs' 2>/dev/null
true`,
    ),
  );
  return { ...parseStatus(out), raw: out };
}

export function parseStatus(raw) {
  const [st = '', remotesRaw = '', fetched = '', stateRaw = '', userName = '', userEmail = '', stashRaw = ''] = raw.split(SEP);
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const files = [];
  const parts = st.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') branch.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') branch.head = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) [branch.ahead, branch.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    const f = rec.split(' ');
    switch (rec[0]) {
      case '1':
        files.push({ path: f.slice(8).join(' '), xy: f[1], kind: kindOf(f[1]) });
        break;
      case '2':
        files.push({ path: f.slice(9).join(' '), orig: parts[++i], xy: f[1], kind: 'renamed' });
        break;
      case 'u':
        files.push({ path: f.slice(10).join(' '), xy: f[1], kind: 'conflicted' });
        break;
      case '?':
        files.push({ path: rec.slice(2), xy: '??', kind: 'new' });
        break;
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const remotes = [];
  for (const line of remotesRaw.split('\n')) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  const upstreamRemote = branch.upstream && remotes.find((r) => branch.upstream.startsWith(r.name + '/'));
  const remote = upstreamRemote || remotes.find((r) => r.name === 'origin') || remotes[0] || null;

  return {
    branch,
    files,
    remote,
    remotes,
    lastFetched: Number(fetched.trim()) || null,
    state: stateRaw.split('\n').filter(Boolean),
    user: { name: userName.trim(), email: userEmail.trim() },
    stash: branch.head ? findStash(stashRaw, branch.head) : null,
  };
}

// ---------------------------------------------------------------- stash

// The same marker GitHub Desktop uses, so stashes made in either app show up in both.
const stashMarker = (branch) => `!!GitHub_Desktop<${branch}>`;

/** The stash made for `branch` (one per branch, like GitHub Desktop). */
function findStash(raw, branch) {
  for (const line of raw.split('\n')) {
    const [ref, sha, time, subject = ''] = line.split('\x1f');
    if (sha && subject.endsWith(': ' + stashMarker(branch))) return { ref, sha, time: Number(time) };
  }
  return null;
}

/** Stashes every change, untracked files included, for `branch`. */
// Without --literal-pathspecs: with it, git silently leaves untracked files out.
export const stashChanges = (exec, repo, branch) =>
  run(exec, inRepo(repo, `${GIT.replace(' --literal-pathspecs', '')} stash push -q --include-untracked -m ${q(stashMarker(branch))}`), 60);

// By sha, so a stash made or dropped meanwhile can't shift which one is meant.
const stashRef = (sha) => `ref=$(${GIT} reflog show --format='%gd %H' refs/stash | awk -v s=${q(sha)} '$2 == s { print $1; exit }')
[ -n "$ref" ] || { echo 'The stash is gone.' >&2; exit 1; }`;

export const restoreStash = (exec, repo, sha) =>
  run(exec, inRepo(repo, `${stashRef(sha)}\n${GIT} stash pop -q "$ref"`), 60).catch((e) => {
    if (/conflict|overwritten|already exists/i.test(e.message))
      throw new GitError('The stash could not be restored over the current changes. Commit or discard them first; the stash is kept.');
    throw e;
  });

export const dropStash = (exec, repo, sha) => run(exec, inRepo(repo, `${stashRef(sha)}\n${GIT} stash drop -q "$ref"`));

/** Files in a stash; untracked ones live in its third parent. */
export async function getStashFiles(exec, repo, sha) {
  const out = await run(
    exec,
    inRepo(
      repo,
      `${GIT} diff --name-status -z -M ${q(sha + '^1')} ${q(sha)} || exit $?
${PRINT_SEP}
${GIT} ls-tree -r -z --name-only ${q(sha + '^3')} 2>/dev/null
true`,
    ),
  );
  const [tracked, untracked = ''] = out.split(SEP);
  const files = parseNameStatus(tracked);
  for (const path of untracked.split('\0').filter(Boolean)) files.push({ path, kind: 'new', untracked: true });
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function getStashFileDiff(exec, repo, sha, file, { ignoreWhitespace = false } = {}) {
  const paths = [file.path, file.orig].filter(Boolean).map(q).join(' ');
  const to = file.untracked ? sha + '^3' : sha;
  return diffOutput(exec, inRepo(repo, limited(`${GIT} diff --no-color --no-ext-diff -M${ws(ignoreWhitespace)} ${q(sha + '^1')} ${q(to)} -- ${paths}`)));
}

function kindOf(xy) {
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'A') return 'new';
  return 'modified';
}

// ---------------------------------------------------------------- diffs

const limited = (cmd) => `${cmd} | head -c ${DIFF_LIMIT + 1}`;
const ws = (ignore) => (ignore ? ' -w' : '');

async function diffOutput(exec, script) {
  const r = await exec(script, 60);
  // `diff --no-index` exits 1 when files differ; head hides git's own code.
  if (!r.stdout && r.stderr.trim()) throw new GitError(r.stderr.trim());
  const truncated = r.stdout.length > DIFF_LIMIT;
  return { text: truncated ? r.stdout.slice(0, DIFF_LIMIT) : r.stdout, truncated };
}

/** Working tree vs HEAD for one changed file, like GitHub Desktop shows it. */
export function getFileDiff(exec, repo, file, hasHead, { ignoreWhitespace = false } = {}) {
  const paths = [file.path, file.orig].filter(Boolean).map(q).join(' ');
  const cmd =
    file.xy === '??' || !hasHead
      ? `${GIT} diff --no-index --no-color --no-ext-diff -- /dev/null ${q(file.path)}`
      : `${GIT} diff HEAD --no-color --no-ext-diff -M${ws(ignoreWhitespace)} -- ${paths}`;
  return diffOutput(exec, inRepo(repo, limited(cmd)));
}

export function getCommitFileDiff(exec, repo, sha, file, { ignoreWhitespace = false } = {}) {
  const paths = [file.path, file.orig].filter(Boolean).map(q).join(' ');
  return diffOutput(
    exec,
    inRepo(repo, limited(`${GIT} show -m --first-parent --format= --no-color --no-ext-diff -M${ws(ignoreWhitespace)} ${q(sha)} -- ${paths}`)),
  );
}

export function parseDiff(text) {
  const result = { binary: false, notes: [], hunks: [], changes: 0 };
  let hunk = null;
  let o = 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      o = Number(m[1]);
      n = Number(m[2]);
      hunk = { header: line, context: m[3], lines: [] };
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line)) result.binary = true;
      else if (/^(new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)/.test(line))
        result.notes.push(line);
      continue;
    }
    const c = line[0];
    if (c === '+') hunk.lines.push({ t: 'add', text: line.slice(1), n: n++, i: result.changes++ });
    else if (c === '-') hunk.lines.push({ t: 'del', text: line.slice(1), o: o++, i: result.changes++ });
    else if (c === ' ') hunk.lines.push({ t: 'ctx', text: line.slice(1), o: o++, n: n++ });
    else if (c === '\\') hunk.lines.push({ t: 'meta', text: line });
    else if (line.startsWith('diff --git')) hunk = null;
  }
  return result;
}

/**
 * Rewrites a one-file diff so it only contains the change lines whose index
 * (as numbered by parseDiff) is not in `excluded`: an unselected deletion
 * becomes context, an unselected addition disappears. Returns null when
 * nothing is selected. The result applies to the index with `git apply --cached`.
 */
export function buildPartialPatch(diffText, excluded) {
  const lines = diffText.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let hunk = null;
  let idx = 0;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) {
      hunk = { oldStart: Number(m[1]), tail: m[3], body: [], oldCount: 0, newCount: 0, selected: 0, lastKept: false };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('diff --git') && header.length) break; // one file only
      header.push(line);
      continue;
    }
    const c = line[0];
    if (c === ' ') {
      hunk.body.push(line);
      hunk.oldCount++;
      hunk.newCount++;
      hunk.lastKept = true;
    } else if (c === '-') {
      if (excluded.has(idx++)) {
        hunk.body.push(' ' + line.slice(1));
        hunk.newCount++;
      } else {
        hunk.body.push(line);
        hunk.selected++;
      }
      hunk.oldCount++;
      hunk.lastKept = true;
    } else if (c === '+') {
      if (excluded.has(idx++)) {
        hunk.lastKept = false;
        continue;
      }
      hunk.selected++;
      hunk.body.push(line);
      hunk.newCount++;
      hunk.lastKept = true;
    } else if (c === '\\') {
      if (hunk.lastKept) hunk.body.push(line);
    }
  }
  const out = [];
  let delta = 0;
  for (const hk of hunks) {
    if (!hk.selected) continue;
    const newStart = hk.newCount === 0 ? hk.oldStart + delta - 1 : hk.oldStart === 0 ? 1 : hk.oldStart + delta;
    out.push(`@@ -${hk.oldStart},${hk.oldCount} +${Math.max(0, newStart)},${hk.newCount} @@${hk.tail}`, ...hk.body);
    delta += hk.newCount - hk.oldCount;
  }
  if (!out.length) return null;
  return [...header, ...out].join('\n') + '\n';
}

// -------------------------------------------------------------- history

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%P%x1f%D%x1e';

// Matches the start of the sha, the author, email, summary or tags/branches,
// ignoring case. git log can only AND --author with --grep, hence awk.
const searchLog = (term, skip, limit) =>
  `${GIT} log --format='${LOG_FORMAT}' HEAD -- | T=${q(term)} awk -F '\\037' -v skip=${Number(skip)} -v limit=${Number(limit)} '
BEGIN { t = tolower(ENVIRON["T"]) }
index(tolower($1), t) == 1 || index(tolower($3), t) || index(tolower($4), t) || index(tolower($6), t) || index(tolower($8), t) {
  if (n++ >= skip) { print; if (++c >= limit) exit }
}'`;

export async function getLog(exec, repo, { skip = 0, limit = 100, search = '' } = {}) {
  const listing = search
    ? searchLog(search, skip, limit)
    : `${GIT} log --format='${LOG_FORMAT}' -n ${Number(limit)} --skip ${Number(skip)} HEAD -- || exit $?`;
  const r = await exec(
    inRepo(
      repo,
      `${listing}
${PRINT_SEP}
${GIT} rev-list '@{upstream}..HEAD' 2>/dev/null
true`,
    ),
    60,
  );
  if (r.code !== 0) {
    if (/does not have any commits|unknown revision|bad (default )?revision|ambiguous argument 'HEAD'/.test(r.stderr))
      return { commits: [], unpushed: new Set() };
    must(r);
  }
  const [log, unpushed = ''] = r.stdout.split(SEP);
  const commits = log
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, short, author, email, time, summary, parents, refs = ''] = rec.split('\x1f');
      const tags = refs.split(', ').filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
      return { sha, short, author, email, time: Number(time), summary, parents: parents ? parents.split(' ') : [], tags };
    });
  return { commits, unpushed: new Set(unpushed.split('\n').filter(Boolean)) };
}

/** The tip commit, or null on a branch without commits. */
export async function getHeadCommit(exec, repo) {
  const r = await exec(inRepo(repo, `${GIT} log -1 --format='%H%x1f%s%x1f%ct' HEAD`));
  if (r.code !== 0) return null;
  const [sha, summary, time] = r.stdout.trim().split('\x1f');
  return sha ? { sha, summary, time: Number(time) } : null;
}

export async function getCommit(exec, repo, sha) {
  const out = await run(
    exec,
    inRepo(
      repo,
      `${GIT} show -s --format='%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B' ${q(sha)} || exit $?
${PRINT_SEP}
${GIT} show -m --first-parent --format= --name-status -z -M ${q(sha)}`,
    ),
  );
  const [info, names = ''] = out.split(SEP);
  const [fullSha, author, email, time, parents, ...body] = info.split('\x1f');
  const message = body.join('\x1f').replace(/\n+$/, '');
  const [summary, ...rest] = message.split('\n');
  return {
    sha: fullSha,
    author,
    email,
    time: Number(time),
    parents: parents ? parents.split(' ') : [],
    summary,
    body: rest.join('\n').trim(),
    files: parseNameStatus(names),
  };
}

export function parseNameStatus(raw) {
  const parts = raw.replace(/^\n+/, '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const kinds = { A: 'new', D: 'deleted', M: 'modified', T: 'modified', U: 'conflicted' };
    if (code[0] === 'R' || code[0] === 'C') {
      files.push({ orig: parts[++i], path: parts[++i], kind: code[0] === 'R' ? 'renamed' : 'new' });
    } else {
      files.push({ path: parts[++i], kind: kinds[code[0]] || 'modified' });
    }
  }
  return files;
}

// ------------------------------------------------------------- branches

export async function getBranches(exec, repo) {
  const out = await run(
    exec,
    inRepo(
      repo,
      `${GIT} for-each-ref --sort=-committerdate --format='%(refname)%1f%(refname:short)%1f%(committerdate:unix)%1f%(upstream:short)' refs/heads refs/remotes || exit $?
${PRINT_SEP}
${GIT} symbolic-ref -q --short refs/remotes/origin/HEAD
${PRINT_SEP}
${GIT} reflog --format=%gs -n 300 2>/dev/null
true`,
    ),
  );
  const [refs, originHead = '', reflog = ''] = out.split(SEP);
  const local = [];
  const remote = [];
  for (const line of refs.split('\n')) {
    if (!line) continue;
    const [ref, name, time, upstream] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) local.push({ name, time: Number(time), upstream });
    else if (!ref.endsWith('/HEAD')) remote.push({ name, time: Number(time) });
  }
  const localNames = new Set(local.map((b) => b.name));
  const fromOrigin = originHead.trim().replace(/^[^/]+\//, '');
  const defaultBranch = fromOrigin || ['main', 'master'].find((n) => localNames.has(n)) || null;

  // Branches most recently switched to, like GitHub Desktop's "Recent Branches".
  const recent = [];
  for (const line of reflog.split('\n')) {
    const m = /^checkout: moving from .+ to (.+)$/.exec(line);
    if (m && localNames.has(m[1]) && !recent.includes(m[1])) recent.push(m[1]);
    if (recent.length === 5) break;
  }
  return { local, remote, defaultBranch, recent };
}

export const checkoutBranch = (exec, repo, name) => run(exec, inRepo(repo, `${GIT} switch -q ${q(name)}`), 60);

/** "origin/feature" → local tracking branch "feature" (reused if it exists). */
export function checkoutRemoteBranch(exec, repo, remoteName) {
  const local = remoteName.slice(remoteName.indexOf('/') + 1);
  return run(
    exec,
    inRepo(
      repo,
      `if ${GIT} show-ref --verify --quiet refs/heads/${q(local)}; then ${GIT} switch -q ${q(local)}
else ${GIT} switch -q -c ${q(local)} --track ${q(remoteName)}; fi`,
    ),
    60,
  );
}

/** The GitHub account `gh` is signed in to on the server, or null. */
export async function getGitHubUser(exec) {
  const r = await exec(
    `PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
command -v gh >/dev/null 2>&1 || exit 127
GH_PROMPT_DISABLED=1 gh api user --jq '[.login, .avatar_url] | @tsv'`,
    30,
  );
  if (r.code !== 0) return null;
  const [login, avatar] = r.stdout.trim().split('\t');
  return login ? { login, avatar } : null;
}

/** Open PRs via the GitHub CLI on the server; null when `gh` isn't installed. */
export async function getPullRequests(exec, repo) {
  const r = await exec(
    inRepo(
      repo,
      `${ghPath}
${GH} pr list --state open --limit 100 --json number,title,headRefName,author,updatedAt,isDraft,url,statusCheckRollup`,
    ),
    60,
  );
  if (r.code === 127) return null;
  return JSON.parse(must(r) || '[]').map((p) => ({ ...p, checks: rollupState(p.statusCheckRollup || []) }));
}

export const checkoutPullRequest = (exec, repo, number) =>
  run(exec, inRepo(repo, `${ghPath}\n${GH} pr checkout ${Number(number)}`), NET_TIMEOUT);

export const createBranch = (exec, repo, name) => run(exec, inRepo(repo, `${GIT} switch -q -c ${q(name)}`), 60);

export const renameBranch = (exec, repo, from, to) => run(exec, inRepo(repo, `${GIT} branch -m ${q(from)} ${q(to)}`));

/** Without `force`, git refuses when the branch has unmerged commits. */
export const deleteBranch = (exec, repo, name, { force = false } = {}) =>
  run(exec, inRepo(repo, `${GIT} branch ${force ? '-D' : '-d'} ${q(name)}`)).catch((e) => {
    if (/not fully merged/.test(e.message)) throw Object.assign(new GitError(e.message), { unmerged: true });
    throw e;
  });

/** "origin/feature" → deletes feature on origin. */
export function deleteRemoteBranch(exec, repo, upstream) {
  const i = upstream.indexOf('/');
  return run(exec, inRepo(repo, `${GIT} push -q ${q(upstream.slice(0, i))} --delete ${q(upstream.slice(i + 1))}`), NET_TIMEOUT);
}

/** How many commits `branch` would bring into HEAD. */
export async function mergeCount(exec, repo, branch) {
  const out = await run(exec, inRepo(repo, `${GIT} rev-list --count HEAD..${q(branch)}`));
  return Number(out.trim()) || 0;
}

/** Merges `branch` into the current branch; squash makes one commit of it. */
export function mergeBranch(exec, repo, branch, { squash = false } = {}) {
  const cmd = squash
    ? `${GIT} merge --squash ${q(branch)} && ${GIT} commit -q --no-edit`
    : `${GIT} merge --no-edit ${q(branch)}`;
  return run(exec, inRepo(repo, cmd), 120).catch((e) => {
    if (/CONFLICT|Automatic merge failed/.test(e.message))
      throw new GitError('The merge has conflicts. Resolve the conflicted files, then commit to finish the merge.');
    throw e;
  });
}

// --------------------------------------------------------------- remote

export const fetchRemote = (exec, repo, remote) =>
  run(exec, inRepo(repo, `${GIT} fetch --prune ${q(remote)}`), NET_TIMEOUT);

// Merge unless the user configured pull.rebase themselves.
export const pull = (exec, repo) =>
  run(
    exec,
    inRepo(
      repo,
      `if ${GIT} config --get pull.rebase >/dev/null; then ${GIT} pull --no-edit
else ${GIT} pull --no-edit --no-rebase; fi`,
    ),
    NET_TIMEOUT,
  );

// --follow-tags sends the annotated tags created with createTag().
export const push = (exec, repo, { remote, hasUpstream }) =>
  run(
    exec,
    inRepo(repo, hasUpstream ? `${GIT} push --follow-tags` : `${GIT} push --follow-tags -u ${q(remote)} HEAD`),
    NET_TIMEOUT,
  );

// ------------------------------------------------------ commit actions

/** Moves the branch to `sha`, keeping later changes as uncommitted edits. */
export const resetToCommit = (exec, repo, sha) => run(exec, inRepo(repo, `${GIT} reset -q ${q(sha)}`), 60);

export const checkoutCommit = (exec, repo, sha) => run(exec, inRepo(repo, `${GIT} switch -q --detach ${q(sha)}`), 60);

export const revertCommit = (exec, repo, sha, isMerge) =>
  run(exec, inRepo(repo, `${GIT} revert --no-edit ${isMerge ? '-m 1 ' : ''}${q(sha)}`), 120);

export const createBranchAt = (exec, repo, name, sha) =>
  run(exec, inRepo(repo, `${GIT} switch -q -c ${q(name)} ${q(sha)}`), 60);

export const createTag = (exec, repo, name, sha) =>
  run(exec, inRepo(repo, `${GIT} tag -a ${q(name)} -m ${q(name)} ${q(sha)}`));

/** Applies `sha` on top of `branch`, which is checked out first. */
export const cherryPick = (exec, repo, sha, branch) =>
  run(exec, inRepo(repo, `${GIT} switch -q ${q(branch)} && ${GIT} cherry-pick ${q(sha)}`), 120);

// -------------------------------------------------------------- changes

const inProgress = `{ d=$(${GIT} rev-parse --git-dir); [ -e "$d/MERGE_HEAD" ] || [ -e "$d/CHERRY_PICK_HEAD" ] || [ -e "$d/REVERT_HEAD" ]; }`;

/**
 * Commits exactly the checked files, ignoring whatever was staged before —
 * the same model GitHub Desktop uses.
 */
export async function commit(
  exec,
  repo,
  { files, all, summary, description = '', coAuthors = [], noVerify = false, signoff = false, allowEmpty = false, patches = [] },
) {
  const desc = description.trim();
  const trailers = coAuthors.map((a) => `Co-authored-by: ${a}`).join('\n');
  const message = [summary.trim(), desc, trailers].filter(Boolean).join('\n\n') + '\n';
  const paths = files.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path])).map(q);
  const flags = [noVerify && '--no-verify', signoff && '--signoff', allowEmpty && '--allow-empty'].filter(Boolean).join(' ');
  const out = await run(
    exec,
    inRepo(
      repo,
      // A merge (or cherry-pick/revert) in progress is committed whole: `git
      // reset` would forget MERGE_HEAD and turn it into an ordinary commit.
      `if ${inProgress}; then
  ${GIT} ls-files -u | grep -q . && { echo 'Resolve the conflicted files first.' >&2; exit 1; }
  ${GIT} add -A || exit $?
else
${[
  `${GIT} reset -q`,
  all ? `${GIT} add -A` : paths.length ? `${GIT} add -A -- ${paths.join(' ')}` : 'true',
  // Files with only some lines selected arrive as patches for the index.
  ...patches.map((patch) => `printf '%s' ${q(patch)} | ${GIT} apply --cached --recount --whitespace=nowarn -`),
].join(' &&\n')} || exit $?
fi
printf '%s' ${q(message)} | ${GIT} commit -q ${flags} -F - &&
${GIT} rev-parse HEAD`,
    ),
    120,
  );
  return out.trim();
}

/** "Name <mail>" stays; "@login" becomes GitHub's noreply address for it. */
export function parseCoAuthors(text) {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const login = /^@([A-Za-z0-9-]+)$/.exec(s);
      if (login) return `${login[1]} <${login[1]}@users.noreply.github.com>`;
      return /^.+ <[^<>\s]+@[^<>\s]+>$/.test(s) ? s : null;
    });
}

/** Where Claude Code and Codex usually live when the login shell doesn't say. */
export const AI_PATH = 'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:/usr/local/bin:$PATH"';

/** AI CLIs that can write commit messages, in the order they're offered. */
export const AI_TOOLS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
];

/** Which of AI_TOOLS are installed on the server. */
export async function findAiTools(exec) {
  const out = await run(exec, `${AI_PATH}
for t in ${AI_TOOLS.map((t) => t.id).join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; true`);
  const found = out.split('\n');
  return AI_TOOLS.filter((t) => found.includes(t.id));
}

/**
 * Runs `tool` ('claude' or 'codex') on the server with `prompt` (a shell
 * expression) and the output of `input` (shell commands) on stdin. The reply is
 * split into its first line and the rest; null when the tool isn't installed.
 */
async function askAi(exec, repo, tool, opts) {
  const text = await askAiText(exec, repo, tool, opts);
  if (text == null) return null;
  const [summary, ...rest] = text.split('\n');
  return { summary: summary.trim(), description: rest.join('\n').trim() };
}

async function askAiText(exec, repo, tool, { setup = '', prompt, input }) {
  const r = await exec(
    inRepo(
      repo,
      `${AI_PATH}
ai=${q(tool)}
command -v "$ai" >/dev/null 2>&1 || exit 127
${setup}
prompt=${prompt}
changes() { { ${input} } | head -c 120000; }
if [ "$ai" = claude ]; then
  changes | claude -p "$prompt"
  exit
fi
# Codex is an agent: keep it read-only and take only its final answer.
out=$(mktemp) || exit 1
eph=
codex exec --help 2>/dev/null | grep -q -- --ephemeral && eph=--ephemeral
changes | codex exec --sandbox read-only --skip-git-repo-check $eph --color never -o "$out" "$prompt" >/dev/null 2>"$out.log"
rc=$?
if [ $rc -eq 0 ]; then cat "$out"; else tail -n 20 "$out.log" >&2; fi
rm -f "$out" "$out.log"
exit $rc`,
    ),
    240,
  );
  if (r.code === 127) return null;
  return must(r)
    .trim()
    .replace(/^```\w*\n?|\n?```$/g, '')
    .trim();
}

/**
 * A commit message for `files` in the style of the recent history, from `tool`
 * on the server. Returns null when it isn't installed.
 */
export function generateCommitMessage(exec, repo, files, hasHead, tool) {
  const tracked = files.filter((f) => hasHead && f.xy !== '??');
  const untracked = files.filter((f) => !hasHead || f.xy === '??').slice(0, 30);
  const diffs = [
    tracked.length &&
      `${GIT} diff HEAD --no-color --no-ext-diff -M -- ${tracked.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path])).map(q).join(' ')}`,
    ...untracked.map((f) => `${GIT} diff --no-index --no-color --no-ext-diff -- /dev/null ${q(f.path)}`),
  ].filter(Boolean);
  const intro =
    'Write a git commit message for the diff on stdin. Use only that diff, do not run commands. Match the style (language, casing, prefixes) of these recent commit subjects:';
  const outro =
    'Reply with only the message: a summary line under 72 characters, then optionally a blank line and a short body. No quotes, no code fences.';
  return askAi(exec, repo, tool, {
    setup: `recent=$(${GIT} log -n 15 --format=%s 2>/dev/null)`,
    prompt: `$(printf '%s\n%s\n\n%s' ${q(intro)} "$recent" ${q(outro)})`,
    input: diffs.map((d) => `${d};`).join(' ') || 'true;',
  });
}

/** A pull request title and description for HEAD against `base` (e.g. origin/main). */
export function generatePullRequest(exec, repo, base, tool) {
  const prompt =
    'Write a GitHub pull request title and description for the commits and diff on stdin. Use only that input, do not run commands. Reply with only: the title on the first line (under 72 characters), a blank line, then a short Markdown description of what changes and why. No code fences around the reply.';
  return askAi(exec, repo, tool, {
    prompt: q(prompt),
    input: `${GIT} log --format='- %s' ${q(base + '..HEAD')}; echo; ${GIT} diff --no-color --no-ext-diff -M ${q(base + '...HEAD')};`,
  });
}

/** Your GitHub repositories via `gh`, newest first; null without `gh`. */
export async function listGitHubRepos(exec) {
  const r = await exec(
    `PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
command -v gh >/dev/null 2>&1 || exit 127
GH_PROMPT_DISABLED=1 NO_COLOR=1 gh repo list --limit 200 --json nameWithOwner,description,isPrivate,updatedAt`,
    60,
  );
  if (r.code === 127) return null;
  return JSON.parse(must(r) || '[]');
}

/** "owner/name" or a URL → the folder name git clone would pick. */
export const cloneName = (source) =>
  source
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop() || '';

/**
 * Clones `source` (a URL, or owner/name for GitHub) into `path`. owner/name
 * goes through `gh` when it's there, so private repositories just work.
 */
export function cloneRepo(exec, source, path) {
  const src = source.trim();
  const short = /^[\w.-]+\/[\w.-]+$/.test(src);
  return run(
    exec,
    `PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
[ -e ${qpath(path)} ] && { echo ${q(`${path} already exists.`)} >&2; exit 1; }
mkdir -p "$(dirname ${qpath(path)})" || exit 1
${
  short
    ? `if command -v gh >/dev/null 2>&1; then GH_PROMPT_DISABLED=1 gh repo clone ${q(src)} ${qpath(path)} -- -q
else ${GIT} clone -q ${q(`https://github.com/${src}.git`)} ${qpath(path)}; fi`
    : `${GIT} clone -q ${q(src)} ${qpath(path)}`
}`,
    1800,
  );
}

/**
 * A new repository at `path` (created if needed), on branch main, optionally
 * with a README as its first commit and published to GitHub through `gh`.
 */
export async function createRepo(exec, path, { readme = true, github = null } = {}) {
  const name = path.replace(/\/+$/, '').split('/').pop();
  await run(
    exec,
    `[ -e ${qpath(path)}/.git ] && { echo ${q(`${path} is already a Git repository.`)} >&2; exit 1; }
mkdir -p ${qpath(path)} && cd ${qpath(path)} || exit 1
${GIT} init -q || exit $?
${GIT} symbolic-ref HEAD refs/heads/main
${readme ? `[ -e README.md ] || printf '# %s\\n' ${q(name)} > README.md
${GIT} add -A && ${GIT} commit -q -m 'Initial commit'` : 'true'}`,
    60,
  );
  if (github)
    await run(
      exec,
      `${ghPath}\ncd ${qpath(path)} && ${GH} repo create ${q(name)} --${github === 'public' ? 'public' : 'private'} --source . --remote origin${readme ? ' --push' : ''}`,
      NET_TIMEOUT,
    );
}

/**
 * Changes and ahead/behind for several repositories on one server in one go,
 * for the repository list: { path: { changes, ahead, behind } }.
 */
export async function repoSummaries(exec, paths) {
  if (!paths.length) return {};
  const out = await run(
    exec,
    `for p in ${paths.map(qpath).join(' ')}; do
  printf '%s\\037' "$p"
  (cd "$p" 2>/dev/null && ${GIT} status --porcelain=v2 --branch 2>/dev/null) | awk '/^# branch.ab/ { a = $3; b = $4 } !/^#/ { n++ } END { print n + 0, a + 0, -b }'
done`,
    60,
  );
  const result = {};
  paths.forEach((p, i) => {
    const line = out.split('\n').filter(Boolean)[i];
    const [, nums = ''] = (line || '').split('\x1f');
    const [changes, ahead, behind] = nums.trim().split(' ').map(Number);
    result[p] = { changes: changes || 0, ahead: ahead || 0, behind: behind || 0 };
  });
  return result;
}

/** Folders in `path` on the server, for the in-app folder browser. */
export async function listDir(exec, path) {
  const out = await run(
    exec,
    `cd ${qpath(path || '~')} || exit 1
pwd
for d in */; do
  [ -d "$d" ] || continue
  d=\${d%/}
  if [ -e "$d/.git" ]; then echo "git	$d"; else echo "dir	$d"; fi
done
[ -e .git ] && echo "self	git"
true`,
  );
  const [cwd, ...lines] = out.split('\n');
  const dirs = [];
  let isRepo = false;
  for (const line of lines) {
    const [kind, name] = line.split('\t');
    if (kind === 'self') isRepo = true;
    else if (name) dirs.push({ name, isRepo: kind === 'git' });
  }
  return { path: cwd, dirs, isRepo };
}

/** Undoes `sha` (keeping its changes) only if it is still the tip. */
export const undoCommit = (exec, repo, sha) =>
  run(
    exec,
    inRepo(
      repo,
      `[ "$(${GIT} rev-parse HEAD)" = ${q(sha)} ] || { echo 'The branch has moved since that commit.' >&2; exit 1; }
if ${GIT} rev-parse -q --verify HEAD~1 >/dev/null; then ${GIT} reset -q --soft HEAD~1
else ${GIT} update-ref -d HEAD; fi`,
    ),
  );

/**
 * Throws away the changes numbered `indexes` (parseDiff's `i`) of a modified
 * file, from the diff text the user saw. Fails without touching the file when
 * it changed since.
 */
export function discardLines(exec, repo, diffText, indexes) {
  const keep = new Set(indexes);
  const total = parseDiff(diffText).changes;
  // The patch has to fit the file as it is now, so build it on the reversed diff
  // (working tree -> HEAD): other changes stay as context, the chosen ones are undone.
  const patch = buildPartialPatch(reverseDiff(diffText), new Set([...Array(total).keys()].filter((i) => !keep.has(i))));
  if (!patch) return Promise.resolve();
  return run(exec, inRepo(repo, `printf '%s' ${q(patch)} | ${GIT} apply --recount --whitespace=nowarn -`)).catch((e) => {
    throw new GitError(/patch does not apply|while searching/.test(e.message) ? 'The file changed in the meantime. Look at the diff again and retry.' : e.message);
  });
}

/** The same diff the other way round; change lines keep their order (and indexes). */
function reverseDiff(text) {
  return text
    .split('\n')
    .map((line) => {
      const m = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line);
      if (m) return `@@ -${m[2]} +${m[1]} @@${m[3]}`;
      if (line.startsWith('--- a/')) return '--- b/' + line.slice(6);
      if (line.startsWith('+++ b/')) return '+++ a/' + line.slice(6);
      if (line[0] === '+' && !line.startsWith('+++')) return '-' + line.slice(1);
      if (line[0] === '-' && !line.startsWith('---')) return '+' + line.slice(1);
      return line;
    })
    .join('\n');
}

export function discard(exec, repo, files) {
  const cmds = files.map((f) => {
    if (f.xy === '??') return `${GIT} clean -f -q -- ${q(f.path)}`;
    if (f.kind === 'renamed')
      return `${GIT} rm -q -f -- ${q(f.path)} && ${GIT} restore --source=HEAD --staged --worktree -- ${q(f.orig)}`;
    if (f.xy[0] === 'A') return `${GIT} rm -q -f -- ${q(f.path)}`;
    return `${GIT} restore --source=HEAD --staged --worktree -- ${q(f.path)}`;
  });
  return run(exec, inRepo(repo, cmds.join(' &&\n')), 60);
}

export const ignorePath = (exec, repo, path) =>
  run(
    exec,
    inRepo(
      repo,
      `[ -s .gitignore ] && [ "$(tail -c 1 .gitignore)" != "" ] && echo >> .gitignore
printf '%s\\n' ${q('/' + path)} >> .gitignore`,
    ),
  );

// ------------------------------------------------------------ worktrees

/** Every worktree of the repository: { path, branch, sha, detached, bare, current }. */
export async function listWorktrees(exec, repo) {
  const out = await run(exec, inRepo(repo, `${GIT} worktree list --porcelain || exit $?\n${PRINT_SEP}\npwd -P`));
  const [list, here = ''] = out.split(SEP);
  const trees = [];
  for (const block of list.split('\n\n')) {
    const t = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'worktree') t.path = val;
      else if (key === 'HEAD') t.sha = val;
      else if (key === 'branch') t.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'detached' || key === 'bare' || key === 'locked' || key === 'prunable') t[key] = true;
    }
    if (t.path) trees.push({ ...t, current: t.path === here.trim() });
  }
  return trees;
}

/** A new worktree at `path` on `branch`, created from HEAD when it doesn't exist yet. */
export const addWorktree = (exec, repo, path, branch) =>
  run(
    exec,
    inRepo(
      repo,
      `if ${GIT} show-ref --verify --quiet ${q('refs/heads/' + branch)}; then ${GIT} worktree add -q ${qpath(path)} ${q(branch)}
else ${GIT} worktree add -q -b ${q(branch)} ${qpath(path)}; fi`,
    ),
    120,
  );

// ------------------------------------------------------------ conflicts

const MARKERS = /^(<<<<<<<|>>>>>>>)( |$)/m;
export const hasConflictMarkers = (text) => MARKERS.test(text);

/**
 * Takes one side of a conflicted file and marks it resolved. `side` is 'mine'
 * or 'theirs'; during a rebase git's --ours is the branch being rebased onto,
 * so the flags swap. A side that deleted the file deletes it.
 */
export function useConflictSide(exec, repo, path, side, rebasing = false) {
  const flag = (side === 'mine') !== rebasing ? '--ours' : '--theirs';
  return run(
    exec,
    inRepo(repo, `if ${GIT} checkout ${flag} -- ${q(path)} 2>/dev/null; then ${GIT} add -- ${q(path)}; else ${GIT} rm -q -- ${q(path)}; fi`),
  );
}

export const markResolved = (exec, repo, path) => run(exec, inRepo(repo, `${GIT} add -- ${q(path)}`));

/** Stops the merge, cherry-pick, revert or rebase in progress. */
export function abortOperation(exec, repo, state) {
  const cmd = state.includes('REBASE') ? 'rebase' : state.includes('CHERRY_PICK_HEAD') ? 'cherry-pick' : state.includes('REVERT_HEAD') ? 'revert' : 'merge';
  return run(exec, inRepo(repo, `${GIT} ${cmd} --abort`), 60);
}

/** The prepared message of a merge in progress (git's MERGE_MSG), or ''. */
export async function getMergeMessage(exec, repo) {
  const r = await exec(inRepo(repo, `f=$(${GIT} rev-parse --git-path MERGE_MSG) && [ -f "$f" ] && grep -v '^#' "$f"`));
  return r.code === 0 ? r.stdout.trim() : '';
}

const AI_FILE_LIMIT = 200_000;

/**
 * Lets `tool` rewrite a conflicted file without its conflict markers. The file
 * stays unresolved in git so the result can be reviewed first. Returns false
 * when the tool isn't installed.
 */
export async function resolveConflictWithAi(exec, repo, path, { ours, theirs, tool }) {
  const file = await exec(inRepo(repo, `wc -c < ${q(path)} | tr -d ' '; ${PRINT_SEP}; tail -c 1 ${q(path)} | od -An -c`));
  const [size, last = ''] = must(file).split(SEP);
  if (Number(size) > AI_FILE_LIMIT) throw new GitError('This file is too large to resolve with AI. Pick a side or resolve it in an editor.');
  const prompt =
    `The file "${path}" on stdin contains git conflict markers between "${ours}" (between <<<<<<< and =======) and "${theirs}" (between ======= and >>>>>>>). ` +
    'Resolve every conflict: keep what both sides intended and combine them where they don\'t contradict. Use only that file, do not run commands. ' +
    'Reply with only the complete resolved file content, nothing before or after it, no code fences.';
  const text = await askAiText(exec, repo, tool, { prompt: q(prompt), input: `cat ${q(path)};` });
  if (text == null) return false;
  if (!text.trim() || hasConflictMarkers(text)) throw new GitError('The AI answer still had conflict markers, so the file was left as it was.');
  const content = last.includes('\\n') ? text.replace(/\n*$/, '\n') : text;
  await run(exec, inRepo(repo, `printf '%s' ${q(content)} > ${q(path)}`));
  return true;
}

// ------------------------------------------------------ CI and pull requests

/** 'success' | 'failure' | 'pending' | null for a list of checks. */
export function checksState(checks) {
  if (!checks.length) return null;
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

const checkState = (status, conclusion) => {
  if (status && status.toLowerCase() !== 'completed') return 'pending';
  const c = (conclusion || '').toLowerCase();
  if (['failure', 'timed_out', 'action_required', 'startup_failure', 'error', 'cancelled'].includes(c)) return 'failure';
  if (['', 'pending', 'expected', 'queued', 'in_progress', 'waiting'].includes(c)) return 'pending';
  return 'success'; // success, neutral, skipped
};

// statusCheckRollup mixes check runs (status/conclusion) and commit statuses (state).
const rollupState = (rollup) =>
  checksState(rollup.map((c) => ({ state: c.__typename === 'StatusContext' ? checkState('completed', c.state) : checkState(c.status, c.conclusion) })));

/**
 * GitHub Actions runs and commit statuses for `sha`, via `gh`. null without
 * `gh` or when the repository isn't on GitHub; [] when the commit has none.
 */
export async function getChecks(exec, repo, sha) {
  const r = await exec(
    inRepo(
      repo,
      `${ghPath}
${GH} api ${q(`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`)} --jq '.check_runs[] | [.name, .status, (.conclusion // ""), .html_url] | @tsv' || exit 3
${PRINT_SEP}
${GH} api ${q(`repos/{owner}/{repo}/commits/${sha}/status`)} --jq '.statuses[] | [.context, .state, (.target_url // "")] | @tsv'
true`,
    ),
    30,
  );
  if (r.code !== 0) return null;
  const [runs, statuses = ''] = r.stdout.split(SEP);
  const rows = (s) => s.split('\n').filter(Boolean).map((l) => l.split('\t'));
  return [
    ...rows(runs).map(([name, status, conclusion, url]) => ({ name, state: checkState(status, conclusion), detail: conclusion || status.replace('_', ' '), url })),
    ...rows(statuses).map(([name, state, url]) => ({ name, state: checkState('completed', state), detail: state, url })),
  ];
}

/** Summaries of the commits in `range` (e.g. origin/main..HEAD), newest first. */
export async function commitSummaries(exec, repo, range) {
  const r = await exec(inRepo(repo, `${GIT} log --format=%s ${q(range)} --`));
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** The open pull request for the current branch, or null. */
export async function getBranchPullRequest(exec, repo) {
  const r = await exec(inRepo(repo, `${ghPath}\n${GH} pr view --json number,title,url,state,isDraft,baseRefName`), 30);
  if (r.code !== 0) return null;
  const pr = JSON.parse(r.stdout || 'null');
  return pr && pr.state === 'OPEN' ? pr : null;
}

/** Opens a pull request for the current (pushed) branch; returns its URL. */
export async function createPullRequest(exec, repo, { base, title, body, draft }) {
  const out = await run(
    exec,
    inRepo(repo, `${ghPath}\n${GH} pr create --base ${q(base)} --title ${q(title)} --body ${q(body || '')}${draft ? ' --draft' : ''}`),
    NET_TIMEOUT,
  );
  return out.trim().split('\n').pop();
}

// ---------------------------------------------------------------- images

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
export const IMAGE_LIMIT = 10_000_000;

/** MIME type when `path` is an image the diff view can show, else null. */
export const imageType = (path) => IMAGE_TYPES[(/\.([^./]+)$/.exec(path || '')?.[1] || '').toLowerCase()] || null;

/**
 * Both versions of an image as base64. Each side is { rev, path } for a blob
 * in git, { worktree: path } for the file on disk, or null when it doesn't
 * exist. A side comes back as null (missing), { size } (too large) or
 * { size, base64 }.
 */
export async function getImageVersions(exec, repo, before, after) {
  const side = (s) => {
    if (!s) return 'echo none';
    if (s.worktree)
      return `if [ -f ${q(s.worktree)} ]; then s=$(wc -c < ${q(s.worktree)} | tr -d ' '); echo "$s"; [ "$s" -le ${IMAGE_LIMIT} ] && base64 < ${q(s.worktree)}; else echo none; fi`;
    const spec = q(`${s.rev}:${s.path}`);
    return `if s=$(${GIT} cat-file -s ${spec} 2>/dev/null); then echo "$s"; [ "$s" -le ${IMAGE_LIMIT} ] && ${GIT} cat-file blob ${spec} | base64; else echo none; fi`;
  };
  const out = await run(exec, inRepo(repo, `${side(before)}\n${PRINT_SEP}\n${side(after)}\ntrue`), 120);
  const parse = (text) => {
    const [first, ...rest] = text.trim().split('\n');
    if (!first || first === 'none') return null;
    const size = Number(first);
    return size > IMAGE_LIMIT ? { size } : { size, base64: rest.join('').replace(/\s+/g, '') };
  };
  const [a, b = ''] = out.split(SEP);
  return { before: parse(a), after: parse(b) };
}

// ---------------------------------------------------------------- misc

/** git@github.com:a/b.git → https://github.com/a/b */
export function webUrl(remoteUrl) {
  if (!remoteUrl) return null;
  let m = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}
