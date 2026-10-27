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

  assert.deepEqual(await git.findAiTools(exec), []);
  assert.equal(await git.generateCommitMessage(exec, dir, st.files, true, 'claude'), null); // no claude yet

  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'claude-input'), '');
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\n[ "$1" = -p ] || exit 9\nprintf '%s' "$2" > ${root}/claude-prompt\ncat > ${root}/claude-input\nprintf '\\140\\140\\140\\nUpdate a.txt and add b.txt\\n\\nBody line.\\n\\140\\140\\140\\n'\n`,
    { mode: 0o755 },
  );
  assert.deepEqual((await git.findAiTools(exec)).map((t) => t.id), ['claude']);
  const msg = await git.generateCommitMessage(exec, dir, st.files, true, 'claude');
  assert.deepEqual(msg, { summary: 'Update a.txt and add b.txt', description: 'Body line.' });
  const input = readFileSync(join(root, 'claude-input'), 'utf8');
  assert.match(input, /-old\n\+new/);
  assert.match(input, /\+brand new/);
  assert.match(readFileSync(join(root, 'claude-prompt'), 'utf8'), /feat: it's "quoted" \$HOME/);
  rmSync(join(bin, 'claude'));
});

test('generateCommitMessage runs codex exec read-only', async () => {
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
  const msg = await git.generateCommitMessage(exec, dir, st.files, true, 'codex');
  assert.deepEqual(msg, { summary: 'Change a.txt', description: 'From codex.' });
  assert.match(readFileSync(join(root, 'codex-input'), 'utf8'), /-old\n\+new/);
  const args = readFileSync(join(root, 'codex-args'), 'utf8');
  assert.match(args, /--sandbox read-only/);
  assert.match(args, /--ephemeral/);
  assert.match(args, /Add a/);

  // A failing codex reports its log instead of its progress output.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n[ "$2" = --help ] && exit 0\necho "Not logged in" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(git.generateCommitMessage(exec, dir, st.files, true, 'codex'), /Not logged in/);

  // Both installed: both are offered, Claude Code first.
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\necho From claude\n', { mode: 0o755 });
  assert.deepEqual((await git.findAiTools(exec)).map((t) => t.id), ['claude', 'codex']);
  assert.equal((await git.generateCommitMessage(exec, dir, st.files, true, 'claude')).summary, 'From claude');
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

test('stash per branch: save, list files and diffs, restore, drop', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'git add -A && git commit -qm init');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  writeFileSync(join(dir, 'new file.txt'), 'fresh\n');
  assert.equal((await git.getStatus(exec, dir)).stash, null);

  await git.stashChanges(exec, dir, 'main');
  let st = await git.getStatus(exec, dir);
  assert.equal(st.files.length, 0);
  assert.ok(st.stash?.sha);
  // Shows up in GitHub Desktop too.
  assert.match(sh(dir, 'git stash list'), /!!GitHub_Desktop<main>/);

  const files = await git.getStashFiles(exec, dir, st.stash.sha);
  assert.deepEqual(files.map((f) => [f.path, f.kind, !!f.untracked]), [['a.txt', 'modified', false], ['new file.txt', 'new', true]]);
  assert.match((await git.getStashFileDiff(exec, dir, st.stash.sha, files[0])).text, /-one\n\+two/);
  assert.match((await git.getStashFileDiff(exec, dir, st.stash.sha, files[1])).text, /\+fresh/);

  // Another branch doesn't see it.
  sh(dir, 'git switch -q -c other');
  assert.equal((await git.getStatus(exec, dir)).stash, null);
  sh(dir, 'git switch -q main');

  await git.restoreStash(exec, dir, st.stash.sha);
  st = await git.getStatus(exec, dir);
  assert.equal(st.stash, null);
  assert.deepEqual(st.files.map((f) => f.path), ['a.txt', 'new file.txt']);

  await git.stashChanges(exec, dir, 'main');
  const sha = (await git.getStatus(exec, dir)).stash.sha;
  sh(dir, 'git stash push -q --include-untracked -m unrelated || true');
  await git.dropStash(exec, dir, sha);
  assert.equal((await git.getStatus(exec, dir)).stash, null);
  await assert.rejects(git.dropStash(exec, dir, sha), /stash is gone/);
});

test('getLog search matches summary, author and sha prefix', async () => {
  const dir = newRepo();
  sh(dir, 'git commit -q --allow-empty -m "Fix login bug"');
  sh(dir, 'git -c user.name="Jana Nováková" commit -q --allow-empty -m "Add cart"');
  sh(dir, 'git commit -q --allow-empty -m "Update docs"');
  const all = (await git.getLog(exec, dir)).commits;
  const find = async (search, opts) => (await git.getLog(exec, dir, { search, ...opts })).commits.map((c) => c.summary);
  assert.deepEqual(await find('LOGIN'), ['Fix login bug']);
  assert.deepEqual(await find('jana'), ['Add cart']);
  assert.deepEqual(await find(all[2].sha.slice(0, 7)), ['Fix login bug']);
  assert.deepEqual(await find("it's \"odd\" $HOME"), []);
  assert.deepEqual(await find('u', { skip: 1, limit: 1 }), ['Fix login bug']);
});

test('rename and delete branches', async () => {
  const dir = newRepo();
  sh(dir, 'git commit -q --allow-empty -m init && git branch feature && git branch wip && git switch -q wip && git commit -q --allow-empty -m "only here" && git switch -q main');
  await git.renameBranch(exec, dir, 'feature', 'feature-2');
  await git.deleteBranch(exec, dir, 'feature-2');
  const err = await git.deleteBranch(exec, dir, 'wip').catch((e) => e);
  assert.equal(err.unmerged, true);
  await git.deleteBranch(exec, dir, 'wip', { force: true });
  assert.deepEqual((await git.getBranches(exec, dir)).local.map((b) => b.name), ['main']);

  // Remote deletion through a bare "origin".
  const bare = join(root, `bare${n}`);
  sh(root, `git init -q --bare ${bare}`);
  sh(dir, `git remote add origin ${bare} && git push -q -u origin main && git switch -q -c topic && git push -q -u origin topic && git switch -q main`);
  await git.deleteRemoteBranch(exec, dir, 'origin/topic');
  assert.equal(sh(bare, 'git branch --list topic').trim(), '');
});

test('cloneRepo clones a URL and refuses an existing folder', async () => {
  const src = newRepo();
  sh(src, 'git commit -q --allow-empty -m init');
  const target = join(root, 'clones', 'copy');
  assert.equal(git.cloneName('https://github.com/a/my-app.git'), 'my-app');
  assert.equal(git.cloneName('git@github.com:a/my-app.git'), 'my-app');
  assert.equal(git.cloneName('a/my-app'), 'my-app');
  await git.cloneRepo(exec, src, target);
  assert.equal(sh(target, 'git log --format=%s').trim(), 'init');
  await assert.rejects(git.cloneRepo(exec, src, target), /already exists/);
});

test('image versions from git and the working tree', async () => {
  const dir = newRepo();
  const png1 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const png2 = Buffer.concat([png1, Buffer.from('extra')]);
  writeFileSync(join(dir, 'logo.png'), png1);
  sh(dir, 'git add -A && git commit -qm "Add logo"');
  writeFileSync(join(dir, 'logo.png'), png2);
  assert.equal(git.imageType('a/Logo.PNG'), 'image/png');
  assert.equal(git.imageType('a.svg'), null);
  const v = await git.getImageVersions(exec, dir, { rev: 'HEAD', path: 'logo.png' }, { worktree: 'logo.png' });
  assert.deepEqual(Buffer.from(v.before.base64, 'base64'), png1);
  assert.deepEqual(Buffer.from(v.after.base64, 'base64'), png2);
  assert.equal(v.after.size, png2.length);
  // An added image has no "before" (HEAD~1 doesn't exist here).
  const added = await git.getImageVersions(exec, dir, { rev: 'HEAD~1', path: 'logo.png' }, { rev: 'HEAD', path: 'logo.png' });
  assert.equal(added.before, null);
  assert.deepEqual(Buffer.from(added.after.base64, 'base64'), png1);
  const none = await git.getImageVersions(exec, dir, null, { rev: 'HEAD', path: 'missing.png' });
  assert.deepEqual(none, { before: null, after: null });
});

test('checks, branch pull request and creating one via a fake gh', async () => {
  const dir = newRepo();
  sh(dir, 'git commit -q --allow-empty -m init');
  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "api repos/{owner}/{repo}/commits/abc/check-runs?per_page=100") printf 'build\\tcompleted\\tsuccess\\thttps://x/1\\ntest\\tin_progress\\t\\thttps://x/2\\n' ;;
  "api repos/{owner}/{repo}/commits/abc/status") printf 'ci/legacy\\tfailure\\thttps://x/3\\n' ;;
  "api "*) echo 'Not Found' >&2; exit 1 ;;
  "pr view") echo '{"number":7,"title":"Feature","url":"https://github.com/a/b/pull/7","state":"OPEN","isDraft":false,"baseRefName":"main"}' ;;
  "pr create") printf '%s\\n' "$@" > ${root}/gh-create; echo 'https://github.com/a/b/pull/8' ;;
esac
`,
    { mode: 0o755 },
  );
  const checks = await git.getChecks(exec, dir, 'abc');
  assert.deepEqual(checks.map((c) => [c.name, c.state]), [['build', 'success'], ['test', 'pending'], ['ci/legacy', 'failure']]);
  assert.equal(git.checksState(checks), 'failure');
  assert.equal(git.checksState(checks.slice(0, 2)), 'pending');
  assert.equal(git.checksState([]), null);
  assert.equal(await git.getChecks(exec, dir, 'nope'), null);
  assert.equal((await git.getBranchPullRequest(exec, dir)).number, 7);
  const url = await git.createPullRequest(exec, dir, { base: 'main', title: `It's "new"`, body: 'Body $HOME', draft: true });
  assert.equal(url, 'https://github.com/a/b/pull/8');
  assert.deepEqual(readFileSync(join(root, 'gh-create'), 'utf8').trim().split('\n'), ['pr', 'create', '--base', 'main', '--title', `It's "new"`, '--body', 'Body $HOME', '--draft']);
  rmSync(join(bin, 'gh'));
  assert.equal(await git.getChecks(exec, dir, 'abc'), null); // no gh
});

test('generatePullRequest sends the commits and diff to the AI', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'git add -A && git commit -qm init && git switch -q -c feature');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  sh(dir, 'git commit -qam "Change a"');
  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > ${root}/pr-input\nprintf 'Change a to two\\n\\nIt now says two.\\n'\n`, { mode: 0o755 });
  const pr = await git.generatePullRequest(exec, dir, 'main', 'claude');
  assert.deepEqual(pr, { summary: 'Change a to two', description: 'It now says two.' });
  const input = readFileSync(join(root, 'pr-input'), 'utf8');
  assert.match(input, /- Change a/);
  assert.match(input, /-one\n\+two/);
  rmSync(join(bin, 'claude'));
});

const conflictRepo = () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
  writeFileSync(join(dir, 'g.txt'), 'g\n');
  sh(dir, 'git add -A && git commit -qm base && git switch -q -c other');
  writeFileSync(join(dir, 'f.txt'), 'a\nTHEIRS\nc\n');
  writeFileSync(join(dir, 'g.txt'), 'g2\n');
  sh(dir, 'git commit -qam theirs && git switch -q main');
  writeFileSync(join(dir, 'f.txt'), 'a\nMINE\nc\n');
  sh(dir, 'git commit -qam mine && git merge other -q || true');
  return dir;
};

test('conflicts: pick a side, then the merge commit keeps both parents', async () => {
  const dir = conflictRepo();
  let st = await git.getStatus(exec, dir);
  assert.ok(st.state.includes('MERGE_HEAD'));
  assert.equal(st.files.find((f) => f.path === 'f.txt').kind, 'conflicted');
  assert.match(await git.getMergeMessage(exec, dir), /^Merge branch 'other'/);
  // Committing with a conflict left is refused instead of committing the markers.
  await assert.rejects(git.commit(exec, dir, { files: st.files, summary: 'Merge' }), /Resolve the conflicted files first/);

  await git.useConflictSide(exec, dir, 'f.txt', 'theirs');
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'a\nTHEIRS\nc\n');
  st = await git.getStatus(exec, dir);
  assert.equal(st.files.some((f) => f.kind === 'conflicted'), false);
  // Only one file checked: a merge still goes in whole.
  await git.commit(exec, dir, { files: st.files.filter((f) => f.path === 'f.txt'), summary: "Merge branch 'other'" });
  assert.equal(sh(dir, 'git log -1 --format=%P').trim().split(' ').length, 2);
  assert.equal(sh(dir, 'git show HEAD:g.txt'), 'g2\n');
  assert.equal(sh(dir, 'git status --porcelain'), '');
});

test('conflicts: use mine, abort, and AI resolution', async () => {
  let dir = conflictRepo();
  await git.useConflictSide(exec, dir, 'f.txt', 'mine');
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'a\nMINE\nc\n');
  await git.abortOperation(exec, dir, (await git.getStatus(exec, dir)).state);
  assert.equal((await git.getStatus(exec, dir)).state.length, 0);

  dir = conflictRepo();
  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > ${root}/ai-conflict-in\nprintf 'a\\nMINE and THEIRS\\nc'\n`, { mode: 0o755 });
  assert.equal(await git.resolveConflictWithAi(exec, dir, 'f.txt', { ours: 'main', theirs: 'other', tool: 'claude' }), true);
  assert.match(readFileSync(join(root, 'ai-conflict-in'), 'utf8'), /<<<<<<< HEAD\nMINE\n=======\nTHEIRS\n>>>>>>> other/);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'a\nMINE and THEIRS\nc\n'); // trailing newline kept
  // Left for review: still unmerged until marked resolved.
  assert.equal((await git.getStatus(exec, dir)).files.find((f) => f.path === 'f.txt').kind, 'conflicted');
  await git.markResolved(exec, dir, 'f.txt');
  assert.equal((await git.getStatus(exec, dir)).files.find((f) => f.path === 'f.txt').kind, 'modified');

  // An answer that still has markers is rejected and the file is untouched.
  dir = conflictRepo();
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\nprintf '<<<<<<< HEAD\\nx\\n=======\\ny\\n>>>>>>> other\\n'\n`, { mode: 0o755 });
  await assert.rejects(git.resolveConflictWithAi(exec, dir, 'f.txt', { ours: 'main', theirs: 'other', tool: 'claude' }), /conflict markers/);
  assert.match(readFileSync(join(dir, 'f.txt'), 'utf8'), /<<<<<<< HEAD/);
  rmSync(join(bin, 'claude'));
  assert.equal(await git.resolveConflictWithAi(exec, dir, 'f.txt', { ours: 'main', theirs: 'other', tool: 'claude' }), false);
});

test('worktrees: list and add for a new and an existing branch', async () => {
  const dir = newRepo();
  sh(dir, 'git commit -q --allow-empty -m init && git branch existing');
  let trees = await git.listWorktrees(exec, dir);
  assert.deepEqual(trees.map((t) => [t.branch, t.current]), [['main', true]]);
  await git.addWorktree(exec, dir, join(root, 'wt-new'), 'feature/new');
  await git.addWorktree(exec, dir, join(root, 'wt old'), 'existing');
  trees = await git.listWorktrees(exec, dir);
  const byName = (a, b) => (a[0] < b[0] ? -1 : 1); // git lists them in its own order
  assert.deepEqual(trees.map((t) => [t.path.split('/').pop(), t.branch, t.current]).sort(byName), [[dir.split('/').pop(), 'main', true], ['wt old', 'existing', false], ['wt-new', 'feature/new', false]].sort(byName));
  assert.equal(sh(join(root, 'wt-new'), 'git branch --show-current').trim(), 'feature/new');
  await assert.rejects(git.addWorktree(exec, dir, join(root, 'wt again'), 'existing'), /already (checked out|used by worktree)/);
});

test('discardLines removes only the chosen lines; -w hides whitespace edits', async () => {
  const dir = newRepo();
  writeFileSync(join(dir, 'f.txt'), 'one\ntwo\nthree\nfour\n');
  sh(dir, 'git add -A && git commit -qm init');
  writeFileSync(join(dir, 'f.txt'), 'one\nTWO\nthree\nfour\nfive\n');
  const st = await git.getStatus(exec, dir);
  const { text } = await git.getFileDiff(exec, dir, st.files[0], true);
  const lines = git.parseDiff(text).hunks.flatMap((hk) => hk.lines).filter((l) => l.i != null);
  // Throw away the added "five" only.
  await git.discardLines(exec, dir, text, [lines.find((l) => l.text === 'five').i]);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'one\nTWO\nthree\nfour\n');
  // Then the removed "two" and its replacement: back to the original.
  const d2 = (await git.getFileDiff(exec, dir, st.files[0], true)).text;
  await git.discardLines(exec, dir, d2, git.parseDiff(d2).hunks.flatMap((hk) => hk.lines).filter((l) => l.i != null).map((l) => l.i));
  assert.equal(sh(dir, 'git status --porcelain'), '');
  // A stale diff is refused.
  writeFileSync(join(dir, 'f.txt'), 'one\nTWO\nthree\nfour\n');
  const stale = (await git.getFileDiff(exec, dir, st.files[0], true)).text;
  writeFileSync(join(dir, 'f.txt'), 'changed\nmeanwhile\n');
  await assert.rejects(git.discardLines(exec, dir, stale, [0, 1]), /changed in the meantime/);

  writeFileSync(join(dir, 'f.txt'), 'one\n  two\nthree\nfour\n');
  assert.match((await git.getFileDiff(exec, dir, st.files[0], true)).text, /\+  two/);
  assert.equal((await git.getFileDiff(exec, dir, st.files[0], true, { ignoreWhitespace: true })).text, '');
});

test('repoSummaries counts changes and ahead/behind per repository', async () => {
  const a = newRepo();
  sh(a, 'git commit -q --allow-empty -m init');
  writeFileSync(join(a, 'x.txt'), 'x');
  const bare = join(root, `sum-bare${n}`);
  sh(root, `git init -q --bare ${bare}`);
  const b = newRepo();
  sh(b, `git commit -q --allow-empty -m init && git remote add origin ${bare} && git push -q -u origin main && git commit -q --allow-empty -m two`);
  const res = await git.repoSummaries(exec, [a, b, join(root, 'missing dir')]);
  assert.deepEqual(res[a], { changes: 1, ahead: 0, behind: 0 });
  assert.deepEqual(res[b], { changes: 0, ahead: 1, behind: 0 });
  assert.deepEqual(res[join(root, 'missing dir')], { changes: 0, ahead: 0, behind: 0 });
});

test('createRepo makes main with a README commit and refuses an existing repo', async () => {
  const dir = join(root, 'brand new', 'my-app');
  await git.createRepo(exec, dir);
  assert.equal(sh(dir, 'git branch --show-current').trim(), 'main');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# my-app\n');
  assert.equal(sh(dir, 'git log --format=%s').trim(), 'Initial commit');
  await assert.rejects(git.createRepo(exec, dir), /already a Git repository/);
  const empty = join(root, 'empty-repo');
  await git.createRepo(exec, empty, { readme: false });
  assert.equal((await git.getStatus(exec, empty)).branch.oid, null);

  // Templates and GitHub through a fake gh.
  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> ${root}/gh-repo-log
case "$1 $2" in
  "api gitignore/templates") printf 'Node\\nPython\\n' ;;
  "api licenses") printf 'mit\\tMIT License\\n' ;;
  "api user") echo adammery ;;
  "api user/orgs") echo vocalio ;;
  "api gitignore/templates/Node") echo 'node_modules/' ;;
  "api licenses/mit") echo 'Copyright (c) [year] [fullname]' ;;
  "repo create") exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  assert.deepEqual(await git.getRepoOptions(exec), { gitignores: ['Node', 'Python'], licenses: [{ key: 'mit', name: 'MIT License' }], owners: ['adammery', 'vocalio'] });
  const full = join(root, 'full-repo');
  await git.createRepo(exec, full, { description: 'A test app', gitignore: 'Node', license: 'mit', github: 'private', owner: 'vocalio' });
  assert.equal(readFileSync(join(full, 'README.md'), 'utf8'), '# full-repo\n\nA test app\n');
  assert.equal(readFileSync(join(full, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.equal(readFileSync(join(full, 'LICENSE'), 'utf8'), `Copyright (c) ${new Date().getFullYear()} Test User\n`);
  assert.equal(sh(full, 'git show --name-only --format= HEAD').trim().split('\n').sort().join(','), '.gitignore,LICENSE,README.md');
  assert.match(readFileSync(join(root, 'gh-repo-log'), 'utf8'), /repo create vocalio\/full-repo --private --description A test app --source \. --remote origin --push/);
  rmSync(join(bin, 'gh'));
  assert.equal(await git.getRepoOptions(exec), null);
});
