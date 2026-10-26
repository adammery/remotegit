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
true`,
    ),
  );
  return { ...parseStatus(out), raw: out };
}

export function parseStatus(raw) {
  const [st = '', remotesRaw = '', fetched = '', stateRaw = '', userName = '', userEmail = ''] = raw.split(SEP);
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
  };
}

function kindOf(xy) {
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'A') return 'new';
  return 'modified';
}

// ---------------------------------------------------------------- diffs

const limited = (cmd) => `${cmd} | head -c ${DIFF_LIMIT + 1}`;

async function diffOutput(exec, script) {
  const r = await exec(script, 60);
  // `diff --no-index` exits 1 when files differ; head hides git's own code.
  if (!r.stdout && r.stderr.trim()) throw new GitError(r.stderr.trim());
  const truncated = r.stdout.length > DIFF_LIMIT;
  return { text: truncated ? r.stdout.slice(0, DIFF_LIMIT) : r.stdout, truncated };
}

/** Working tree vs HEAD for one changed file, like GitHub Desktop shows it. */
export function getFileDiff(exec, repo, file, hasHead) {
  const paths = [file.path, file.orig].filter(Boolean).map(q).join(' ');
  const cmd =
    file.xy === '??' || !hasHead
      ? `${GIT} diff --no-index --no-color --no-ext-diff -- /dev/null ${q(file.path)}`
      : `${GIT} diff HEAD --no-color --no-ext-diff -M -- ${paths}`;
  return diffOutput(exec, inRepo(repo, limited(cmd)));
}

export function getCommitFileDiff(exec, repo, sha, file) {
  const paths = [file.path, file.orig].filter(Boolean).map(q).join(' ');
  return diffOutput(
    exec,
    inRepo(repo, limited(`${GIT} show -m --first-parent --format= --no-color --no-ext-diff -M ${q(sha)} -- ${paths}`)),
  );
}

export function parseDiff(text) {
  const result = { binary: false, notes: [], hunks: [] };
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
    if (c === '+') hunk.lines.push({ t: 'add', text: line.slice(1), n: n++ });
    else if (c === '-') hunk.lines.push({ t: 'del', text: line.slice(1), o: o++ });
    else if (c === ' ') hunk.lines.push({ t: 'ctx', text: line.slice(1), o: o++, n: n++ });
    else if (c === '\\') hunk.lines.push({ t: 'meta', text: line });
    else if (line.startsWith('diff --git')) hunk = null;
  }
  return result;
}

// -------------------------------------------------------------- history

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%P%x1e';

export async function getLog(exec, repo, { skip = 0, limit = 100 } = {}) {
  const r = await exec(
    inRepo(
      repo,
      `${GIT} log --format='${LOG_FORMAT}' -n ${Number(limit)} --skip ${Number(skip)} HEAD -- || exit $?
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
      const [sha, short, author, email, time, summary, parents] = rec.split('\x1f');
      return { sha, short, author, email, time: Number(time), summary, parents: parents ? parents.split(' ') : [] };
    });
  return { commits, unpushed: new Set(unpushed.split('\n').filter(Boolean)) };
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
      `${GIT} for-each-ref --sort=-committerdate --format='%(refname)%1f%(refname:short)%1f%(committerdate:unix)%1f%(upstream:short)' refs/heads refs/remotes`,
    ),
  );
  const local = [];
  const remote = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, name, time, upstream] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) local.push({ name, time: Number(time), upstream });
    else if (!ref.endsWith('/HEAD')) remote.push({ name, time: Number(time) });
  }
  return { local, remote };
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

export const createBranch = (exec, repo, name) => run(exec, inRepo(repo, `${GIT} switch -q -c ${q(name)}`), 60);

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

export const push = (exec, repo, { remote, hasUpstream }) =>
  run(exec, inRepo(repo, hasUpstream ? `${GIT} push` : `${GIT} push -u ${q(remote)} HEAD`), NET_TIMEOUT);

// -------------------------------------------------------------- changes

/**
 * Commits exactly the checked files, ignoring whatever was staged before —
 * the same model GitHub Desktop uses.
 */
export async function commit(exec, repo, { files, all, summary, description = '' }) {
  const desc = description.trim();
  const message = `${summary.trim()}\n${desc ? `\n${desc}\n` : ''}`;
  const paths = files.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path])).map(q);
  const out = await run(
    exec,
    inRepo(
      repo,
      [
        `${GIT} reset -q`,
        all ? `${GIT} add -A` : `${GIT} add -A -- ${paths.join(' ')}`,
        `printf '%s' ${q(message)} | ${GIT} commit -q -F -`,
        `${GIT} rev-parse HEAD`,
      ].join(' &&\n'),
    ),
    120,
  );
  return out.trim();
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
