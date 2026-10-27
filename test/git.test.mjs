import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git.js';

// realpath: on macOS the temp dir is behind the /var -> /private/var symlink.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'remotegit-test-')));
const gitconfig = join(root, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
// PATH without any real `claude` install, so the fake one in the test HOME is used.
const PATH = process.env.PATH.split(':').filter((p) => !/\.local\/bin|claude|npm-global/.test(p)).join(':');
const env = { ...process.env, PATH, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root };

// Same contract as the SSH session: the script runs in `sh -c`.
const exec = async (script) => {
  const r = spawnSync('sh', ['-c', script], { env, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? -1 };
};
const sh = (cwd, cmd) => {
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};
let n = 0;
const newRepo = () => {
  const dir = join(root, `repo${++n}`);
  mkdirSync(dir);
  sh(dir, 'git init -q');
  return dir;
};

test.after(() => rmSync(root, { recursive: true, force: true }));

test('q() survives quotes, spaces and $', async () => {
  const s = `it's "a" $HOME \`x\` \\ ü`;
  assert.equal((await exec(`printf '%s' ${git.q(s)}`)).stdout, s);
});

test('empty repo: status, diff of untracked file, first commit', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  const st = await git.getStatus(exec, dir);
  assert.equal(st.branch.oid, null);
  assert.equal(st.branch.head, 'main');
  assert.deepEqual(st.files.map((f) => [f.path, f.kind]), [['a.txt', 'new'], ['b.txt', 'new']]);
  assert.equal(st.user.name, 'Test User');

  const d = git.parseDiff((await git.getFileDiff(exec, dir, st.files[0], false)).text);
  assert.deepEqual(d.hunks[0].lines.map((l) => [l.t, l.text, l.n]), [['add', 'one', 1], ['add', 'two', 2]]);

  assert.deepEqual((await git.getLog(exec, dir)).commits, []);
  const sha = await git.commit(exec, dir, { files: [st.files[0]], all: false, summary: 'First', description: '' });
  assert.match(sha, /^[0-9a-f]{40}$/);
  const after = await git.getStatus(exec, dir);
  assert.deepEqual(after.files.map((f) => f.path), ['b.txt']);
  assert.equal(sh(dir, 'git log --format=%B'), 'First\n\n');
});

test('all change kinds with awkward file names', async () => {
  const dir = newRepo();
  const weird = `we ird 'q' "dq" ü.txt`;
  writeFileSync(join(dir, 'mod.txt'), 'a\n');
  writeFileSync(join(dir, 'del.txt'), 'x\n');
  writeFileSync(join(dir, 'old name.txt'), 'rename me\n'.repeat(20));
  writeFileSync(join(dir, '*glob*.txt'), 'g\n');
  sh(dir, 'git add -A && git commit -qm init');

  writeFileSync(join(dir, 'mod.txt'), 'a\nb\n');
  writeFileSync(join(dir, '*glob*.txt'), 'g2\n');
  rmSync(join(dir, 'del.txt'));
  sh(dir, `git mv 'old name.txt' 'new name.txt'`);
  writeFileSync(join(dir, weird), 'w\n');
  mkdirSync(join(dir, 'sub dir'));
  writeFileSync(join(dir, 'sub dir', 'n.txt'), 'n\n');

  const st = await git.getStatus(exec, dir);
  const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.equal(byPath['mod.txt'].kind, 'modified');
  assert.equal(byPath['del.txt'].kind, 'deleted');
  assert.equal(byPath['new name.txt'].kind, 'renamed');
  assert.equal(byPath['new name.txt'].orig, 'old name.txt');
  assert.equal(byPath[weird].kind, 'new');
  assert.equal(byPath['sub dir/n.txt'].kind, 'new');
  assert.equal(byPath['*glob*.txt'].kind, 'modified');

  const md = git.parseDiff((await git.getFileDiff(exec, dir, byPath['mod.txt'], true)).text);
  assert.deepEqual(md.hunks[0].lines.map((l) => l.t), ['ctx', 'add']);
  assert.equal(md.hunks[0].lines[1].n, 2);

  // Commit a subset: the rename (both sides) and the glob-named file only.
  await git.commit(exec, dir, { files: [byPath['new name.txt'], byPath['*glob*.txt']], all: false, summary: 'Subset', description: 'Body\nline 2' });
  const shown = sh(dir, 'git show --name-status --format=%B HEAD');
  assert.match(shown, /^Subset\n\nBody\nline 2\n/);
  assert.match(shown, /R100\told name.txt\tnew name.txt/);
  assert.match(shown, /M\t\*glob\*.txt/);
  const left = (await git.getStatus(exec, dir)).files.map((f) => f.path);
  assert.deepEqual(left, ['del.txt', 'mod.txt', 'sub dir/n.txt', weird]);

  const commit = await git.getCommit(exec, dir, 'HEAD');
  assert.equal(commit.summary, 'Subset');
  assert.equal(commit.body, 'Body\nline 2');
  assert.deepEqual(commit.files.map((f) => [f.kind, f.path, f.orig]), [
    ['modified', '*glob*.txt', undefined],
    ['renamed', 'new name.txt', 'old name.txt'],
  ]);
  const cd = git.parseDiff((await git.getCommitFileDiff(exec, dir, commit.sha, commit.files[0])).text);
  assert.deepEqual(cd.hunks[0].lines.map((l) => [l.t, l.text]), [['del', 'g'], ['add', 'g2']]);
});

test('discard restores every kind of change', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'mod.txt'), 'a\n');
  writeFileSync(join(dir, 'del.txt'), 'x\n');
  writeFileSync(join(dir, 'ren.txt'), 'r\n');
  sh(dir, 'git add -A && git commit -qm init');
  writeFileSync(join(dir, 'mod.txt'), 'changed\n');
  rmSync(join(dir, 'del.txt'));
  sh(dir, 'git mv ren.txt ren2.txt');
  writeFileSync(join(dir, 'untracked.txt'), 'u\n');
  writeFileSync(join(dir, 'added.txt'), 'a\n');
  sh(dir, 'git add added.txt');

  const st = await git.getStatus(exec, dir);
  assert.equal(st.files.length, 5);
  await git.discard(exec, dir, st.files);
  assert.deepEqual((await git.getStatus(exec, dir)).files, []);
  assert.equal(readFileSync(join(dir, 'mod.txt'), 'utf8'), 'a\n');
  assert.ok(existsSync(join(dir, 'del.txt')) && existsSync(join(dir, 'ren.txt')));
  assert.ok(!existsSync(join(dir, 'untracked.txt')) && !existsSync(join(dir, 'added.txt')));
});

test('remote: push/publish, ahead/behind, fetch, pull, branches', async () => {
  const bare = join(root, 'remote.git');
  sh(root, `git init -q --bare ${bare}`);
  const a = newRepo();
  sh(a, `git remote add origin ${bare}`);
  writeFileSync(join(a, 'f.txt'), '1\n');
  sh(a, 'git add -A && git commit -qm c1');

  let st = await git.getStatus(exec, a);
  assert.equal(st.branch.upstream, null);
  assert.equal(st.remote.name, 'origin');
  await git.push(exec, a, { remote: 'origin', hasUpstream: false });
  st = await git.getStatus(exec, a);
  assert.equal(st.branch.upstream, 'origin/main');

  writeFileSync(join(a, 'f.txt'), '2\n');
  sh(a, 'git commit -qam c2');
  st = await git.getStatus(exec, a);
  assert.equal(st.branch.ahead, 1);
  const log = await git.getLog(exec, a);
  assert.deepEqual(log.commits.map((c) => c.summary), ['c2', 'c1']);
  assert.ok(log.unpushed.has(log.commits[0].sha) && !log.unpushed.has(log.commits[1].sha));
  await git.push(exec, a, { remote: 'origin', hasUpstream: true });

  // Second clone moves the remote forward.
  const b = join(root, 'clone-b');
  sh(root, `git clone -q ${bare} ${b}`);
  writeFileSync(join(b, 'g.txt'), 'g\n');
  sh(b, 'git add -A && git commit -qm from-b && git push -q && git push -q origin HEAD:feature');

  await git.fetchRemote(exec, a, 'origin');
  st = await git.getStatus(exec, a);
  assert.equal(st.branch.behind, 1);
  assert.ok(st.lastFetched > 0);
  await git.pull(exec, a);
  assert.equal((await git.getStatus(exec, a)).branch.behind, 0);

  const br = await git.getBranches(exec, a);
  assert.deepEqual(br.local.map((x) => x.name), ['main']);
  assert.equal(br.defaultBranch, 'main');
  assert.deepEqual(br.remote.map((x) => x.name).sort(), ['origin/feature', 'origin/main']);
  await git.checkoutRemoteBranch(exec, a, 'origin/feature');
  assert.equal((await git.getStatus(exec, a)).branch.head, 'feature');
  await git.checkoutBranch(exec, a, 'main');
  await git.checkoutRemoteBranch(exec, a, 'origin/feature'); // reuses the local branch
  await git.createBranch(exec, a, 'new-thing');
  assert.equal((await git.getStatus(exec, a)).branch.head, 'new-thing');
  assert.deepEqual((await git.getBranches(exec, a)).recent, ['new-thing', 'feature', 'main']);
  await assert.rejects(git.checkoutBranch(exec, a, 'does-not-exist'), git.GitError);
});

test('undo commit keeps changes, refuses if branch moved', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'f.txt'), '1\n');
  const st = await git.getStatus(exec, dir);
  const root1 = await git.commit(exec, dir, { files: st.files, all: true, summary: 'root' });
  await git.undoCommit(exec, dir, root1);
  assert.equal((await git.getStatus(exec, dir)).files.length, 1);

  const c1 = await git.commit(exec, dir, { files: [], all: true, summary: 'c1' });
  writeFileSync(join(dir, 'f.txt'), '2\n');
  const c2 = await git.commit(exec, dir, { files: [], all: true, summary: 'c2' });
  await assert.rejects(git.undoCommit(exec, dir, c1), /moved/);
  await git.undoCommit(exec, dir, c2);
  assert.equal(sh(dir, 'git rev-parse HEAD').trim(), c1);
  assert.equal((await git.getStatus(exec, dir)).files[0].path, 'f.txt');
});

test('commit actions: tag, branch, revert, reset, checkout, cherry-pick', async () => {
  const dir = newRepo();
  const commitFile = (name, text, msg) => {
    writeFileSync(join(dir, name), text);
    sh(dir, `git add -A && git commit -qm ${msg}`);
    return sh(dir, 'git rev-parse HEAD').trim();
  };
  const c1 = commitFile('f.txt', '1\n', 'c1');
  const c2 = commitFile('f.txt', '2\n', 'c2');
  const c3 = commitFile('g.txt', 'g\n', 'c3');

  await git.createTag(exec, dir, 'v1.0', c2);
  const log = await git.getLog(exec, dir);
  assert.deepEqual(log.commits.find((c) => c.sha === c2).tags, ['v1.0']);
  assert.deepEqual(log.commits.find((c) => c.sha === c3).tags, []);

  await git.revertCommit(exec, dir, c3, false);
  assert.ok(!existsSync(join(dir, 'g.txt')));
  assert.match(sh(dir, 'git log -1 --format=%s'), /^Revert "c3"/);

  await git.createBranchAt(exec, dir, 'from-c1', c1);
  assert.equal(sh(dir, 'git rev-parse --abbrev-ref HEAD').trim(), 'from-c1');
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), '1\n');
  await git.cherryPick(exec, dir, c3, 'from-c1');
  assert.ok(existsSync(join(dir, 'g.txt')));

  sh(dir, 'git switch -q main');
  await git.resetToCommit(exec, dir, c1);
  assert.equal(sh(dir, 'git rev-parse HEAD').trim(), c1);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), '2\n'); // kept as an uncommitted change
  sh(dir, 'git checkout -q -- .');

  await git.checkoutCommit(exec, dir, c1);
  assert.equal((await git.getStatus(exec, dir)).branch.head, null);
});

test('commit options, co-authors and empty commits', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'f.txt'), '1\n');
  const st = await git.getStatus(exec, dir);
  const coAuthors = git.parseCoAuthors('@octocat, Jane Doe <jane@example.com>, nonsense');
  assert.deepEqual(coAuthors, ['octocat <octocat@users.noreply.github.com>', 'Jane Doe <jane@example.com>', null]);
  await git.commit(exec, dir, { files: st.files, all: true, summary: 'With trailers', coAuthors: coAuthors.filter(Boolean), signoff: true });
  const msg = sh(dir, 'git log -1 --format=%B');
  assert.match(msg, /^With trailers\n\nCo-authored-by: octocat <octocat@users.noreply.github.com>\nCo-authored-by: Jane Doe <jane@example.com>\nSigned-off-by: Test User <test@example.com>/);

  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(git.commit(exec, dir, { files: [], all: false, summary: 'Empty', allowEmpty: true }), /blocked/);
  await git.commit(exec, dir, { files: [], all: false, summary: 'Empty', allowEmpty: true, noVerify: true });
  assert.equal(sh(dir, 'git log -1 --format=%s').trim(), 'Empty');
});

test('generateCommitMessage pipes the diff to claude on the server', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'a.txt'), 'old\n');
  sh(dir, `git add -A && git commit -qm "feat: it's \\"quoted\\" \\$HOME"`);
  writeFileSync(join(dir, 'a.txt'), 'new\n');
  writeFileSync(join(dir, 'b.txt'), 'brand new\n');
  const st = await git.getStatus(exec, dir);

  assert.equal(await git.generateCommitMessage(exec, dir, st.files, true), null); // no claude yet

  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'claude-input'), '');
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\n[ "$1" = -p ] || exit 9\nprintf '%s' "$2" > ${root}/claude-prompt\ncat > ${root}/claude-input\nprintf '\\140\\140\\140\\nUpdate a.txt and add b.txt\\n\\nBody line.\\n\\140\\140\\140\\n'\n`,
    { mode: 0o755 },
  );
  const msg = await git.generateCommitMessage(exec, dir, st.files, true);
  assert.deepEqual(msg, { summary: 'Update a.txt and add b.txt', description: 'Body line.' });
  const input = readFileSync(join(root, 'claude-input'), 'utf8');
  assert.match(input, /-old\n\+new/);
  assert.match(input, /\+brand new/);
  assert.match(readFileSync(join(root, 'claude-prompt'), 'utf8'), /feat: it's "quoted" \$HOME/);
  rmSync(join(bin, 'claude'));
});

test('generateCommitMessage falls back to a read-only codex exec', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'a.txt'), 'old\n');
  sh(dir, 'git add -A && git commit -qm "Add a"');
  writeFileSync(join(dir, 'a.txt'), 'new\n');
  const st = await git.getStatus(exec, dir);

  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  // Fake codex: checks the flags, saves stdin and writes the answer to the -o file.
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh
[ "$1" = exec ] || exit 9
shift
[ "$1" = --help ] && { echo '      --ephemeral'; exit 0; }
printf '%s ' "$@" > ${root}/codex-args
out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
cat > ${root}/codex-input
echo 'thinking…' >&2
echo 'progress on stdout'
printf 'Change a.txt\\n\\nFrom codex.\\n' > "$out"
`,
    { mode: 0o755 },
  );
  assert.equal(await git.generateCommitMessage(exec, dir, st.files, true, 'claude'), null);
  const msg = await git.generateCommitMessage(exec, dir, st.files, true);
  assert.deepEqual(msg, { summary: 'Change a.txt', description: 'From codex.' });
  assert.match(readFileSync(join(root, 'codex-input'), 'utf8'), /-old\n\+new/);
  const args = readFileSync(join(root, 'codex-args'), 'utf8');
  assert.match(args, /--sandbox read-only/);
  assert.match(args, /--ephemeral/);
  assert.match(args, /Add a/);

  // Auto prefers Claude Code; 'codex' forces Codex.
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\necho From claude\n', { mode: 0o755 });
  assert.equal((await git.generateCommitMessage(exec, dir, st.files, true)).summary, 'From claude');
  assert.equal((await git.generateCommitMessage(exec, dir, st.files, true, 'codex')).summary, 'Change a.txt');

  // A failing codex reports its log instead of its progress output.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n[ "$2" = --help ] && exit 0\necho "Not logged in" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(git.generateCommitMessage(exec, dir, st.files, true, 'codex'), /Not logged in/);
  rmSync(join(bin, 'claude'));
  rmSync(join(bin, 'codex'));
});

test('listDir browses folders and marks repositories', async () => {
  const dir = newRepo();
  mkdirSync(join(dir, 'plain dir'));
  mkdirSync(join(dir, 'nested'));
  sh(join(dir, 'nested'), 'git init -q');
  writeFileSync(join(dir, 'file.txt'), 'x');
  const res = await git.listDir(exec, dir);
  assert.equal(res.path, dir);
  assert.equal(res.isRepo, true);
  assert.deepEqual(res.dirs, [{ name: 'nested', isRepo: true }, { name: 'plain dir', isRepo: false }]);
  assert.equal((await git.listDir(exec, '~')).path, root);
});

test('partial commits: only the selected lines go in', async () => {
  const dir = newRepo();
  const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
  writeFileSync(join(dir, 'a.txt'), lines(30, (i) => `line ${i}`));
  sh(dir, 'git add -A && git commit -qm init');
  // Two separate hunks: line 2 changed, line 28 changed, plus an added line 29b.
  writeFileSync(join(dir, 'a.txt'), lines(30, (i) => (i === 2 ? 'TWO' : i === 28 ? 'TWENTY-EIGHT' : i === 29 ? 'line 29\nline 29b' : `line ${i}`)));
  writeFileSync(join(dir, 'new.txt'), 'keep\ndrop\nkeep too\n');
  const st = await git.getStatus(exec, dir);
  const a = st.files.find((f) => f.path === 'a.txt');
  const n = st.files.find((f) => f.path === 'new.txt');

  const aDiff = (await git.getFileDiff(exec, dir, a, true)).text;
  const parsed = git.parseDiff(aDiff);
  assert.equal(parsed.changes, 5); // -2 +2 | -28 +28 +29b
  // Keep only the first hunk (indexes 0,1): exclude 2,3,4.
  const aPatch = git.buildPartialPatch(aDiff, new Set([2, 3, 4]));
  const nDiff = (await git.getFileDiff(exec, dir, n, true)).text;
  const nPatch = git.buildPartialPatch(nDiff, new Set([1])); // drop "drop"
  assert.equal(git.buildPartialPatch(nDiff, new Set([0, 1, 2])), null);

  await git.commit(exec, dir, { files: [], all: false, summary: 'Partial', patches: [aPatch, nPatch] });
  const committedA = sh(dir, 'git show HEAD:a.txt');
  assert.match(committedA, /^line 1\nTWO\nline 3\n/);
  assert.match(committedA, /line 28\nline 29\nline 30\n$/);
  assert.equal(sh(dir, 'git show HEAD:new.txt'), 'keep\nkeep too\n');
  // The rest stays as uncommitted changes in the working tree.
  assert.match(readFileSync(join(dir, 'a.txt'), 'utf8'), /TWENTY-EIGHT\nline 29\nline 29b/);
  const left = (await git.getStatus(exec, dir)).files.map((f) => f.path);
  assert.deepEqual(left, ['a.txt', 'new.txt']);

  // Excluding a deletion keeps the old line.
  const d2 = (await git.getFileDiff(exec, dir, (await git.getStatus(exec, dir)).files[0], true)).text;
  const p2 = git.parseDiff(d2);
  const del = p2.hunks.flatMap((h) => h.lines).find((l) => l.t === 'del' && l.text === 'line 28');
  const add = p2.hunks.flatMap((h) => h.lines).find((l) => l.t === 'add' && l.text === 'line 29b');
  const keepOnly29b = new Set([...Array(p2.changes).keys()].filter((i) => i !== add.i));
  assert.ok(keepOnly29b.has(del.i));
  await git.commit(exec, dir, { files: [], all: false, summary: 'Only 29b', patches: [git.buildPartialPatch(d2, keepOnly29b)] });
  assert.match(sh(dir, 'git show HEAD:a.txt'), /line 28\nline 29\nline 29b\nline 30\n$/);
});

test('merge and squash-merge a branch', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  sh(dir, 'git add -A && git commit -qm base && git switch -q -c feature');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  sh(dir, 'git add -A && git commit -qm "add a"');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  sh(dir, 'git add -A && git commit -qm "add b" && git switch -q main');
  writeFileSync(join(dir, 'm.txt'), 'main side\n');
  sh(dir, 'git add -A && git commit -qm "main side"');

  assert.equal(await git.mergeCount(exec, dir, 'feature'), 2);
  sh(dir, 'git branch squash-copy main');
  await git.mergeBranch(exec, dir, 'feature');
  assert.equal(sh(dir, 'git rev-list --count --merges HEAD').trim(), '1');
  assert.equal(await git.mergeCount(exec, dir, 'feature'), 0);

  sh(dir, 'git switch -q squash-copy');
  await git.mergeBranch(exec, dir, 'feature', { squash: true });
  assert.equal(sh(dir, 'git rev-list --count --merges HEAD').trim(), '0');
  assert.ok(existsSync(join(dir, 'a.txt')) && existsSync(join(dir, 'b.txt')));

  // Conflicts come back as a readable error and leave the merge in progress.
  sh(dir, 'git switch -q -c c1 main && echo one > f.txt && git commit -qam one && git switch -q -c c2 HEAD~1 && echo two > f.txt && git commit -qam two');
  await assert.rejects(git.mergeBranch(exec, dir, 'c1'), /conflicts/);
  assert.ok((await git.getStatus(exec, dir)).state.includes('MERGE_HEAD'));
});

test('ignorePath appends with a newline guard', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, '.gitignore'), 'node_modules');
  writeFileSync(join(dir, 'secret.env'), 's');
  await git.ignorePath(exec, dir, 'secret.env');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n/secret.env\n');
  const paths = (await git.getStatus(exec, dir)).files.map((f) => f.path);
  assert.ok(!paths.includes('secret.env'));
});

test('findRepos and resolveRepo', async () => {
  const dir = newRepo();
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  sh(join(dir, 'node_modules', 'x'), 'git init -q');
  mkdirSync(join(dir, 'deep', 'er'), { recursive: true });
  const { home, repos } = await git.findRepos(exec);
  assert.equal(home, root);
  assert.ok(repos.includes(dir));
  assert.ok(!repos.some((r) => r.includes('node_modules')));
  assert.equal(await git.resolveRepo(exec, join(dir, 'deep', 'er')), dir);
  assert.equal(await git.resolveRepo(exec, '~/' + dir.slice(root.length + 1)), dir);
  await assert.rejects(git.resolveRepo(exec, join(root, 'nope')));
});

test('binary and truncated-safe diff parsing', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
  const st = await git.getStatus(exec, dir);
  const d = git.parseDiff((await git.getFileDiff(exec, dir, st.files[0], false)).text);
  assert.equal(d.binary, true);
});

test('webUrl', () => {
  assert.equal(git.webUrl('git@github.com:user/repo.git'), 'https://github.com/user/repo');
  assert.equal(git.webUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo');
  assert.equal(git.webUrl('ssh://git@gitlab.example.com:2222/g/sub/repo.git'), 'https://gitlab.example.com/g/sub/repo');
  assert.equal(git.webUrl('/srv/git/repo.git'), null);
});
