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
      `command -v gh >/dev/null 2>&1 || exit 127
GH_PROMPT_DISABLED=1 NO_COLOR=1 gh pr list --state open --limit 100 --json number,title,headRefName,author,updatedAt,isDraft,url`,
    ),
    60,
  );
  if (r.code === 127) return null;
  return JSON.parse(must(r) || '[]');
}

export const checkoutPullRequest = (exec, repo, number) =>
  run(exec, inRepo(repo, `GH_PROMPT_DISABLED=1 gh pr checkout ${Number(number)}`), NET_TIMEOUT);

export const createBranch = (exec, repo, name) => run(exec, inRepo(repo, `${GIT} switch -q -c ${q(name)}`), 60);

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
      [
        `${GIT} reset -q`,
        all ? `${GIT} add -A` : paths.length ? `${GIT} add -A -- ${paths.join(' ')}` : 'true',
        // Files with only some lines selected arrive as patches for the index.
        ...patches.map((patch) => `printf '%s' ${q(patch)} | ${GIT} apply --cached --recount --whitespace=nowarn -`),
        `printf '%s' ${q(message)} | ${GIT} commit -q ${flags} -F -`,
        `${GIT} rev-parse HEAD`,
      ].join(' &&\n'),
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
 * Asks `tool` ('claude' or 'codex') on the server for a commit message for
 * `files`, in the style of the recent history. Returns null when it isn't
 * installed.
 */
export async function generateCommitMessage(exec, repo, files, hasHead, tool) {
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
  const r = await exec(
    inRepo(
      repo,
      `${AI_PATH}
ai=${q(tool)}
command -v "$ai" >/dev/null 2>&1 || exit 127
recent=$(${GIT} log -n 15 --format=%s 2>/dev/null)
prompt=$(printf '%s\n%s\n\n%s' ${q(intro)} "$recent" ${q(outro)})
changes() { { ${diffs.map((d) => `${d};`).join(' ') || 'true;'} } | head -c 120000; }
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
  const text = must(r)
    .trim()
    .replace(/^```\w*\n?|\n?```$/g, '')
    .trim();
  const [summary, ...rest] = text.split('\n');
  return { summary: summary.trim(), description: rest.join('\n').trim() };
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
