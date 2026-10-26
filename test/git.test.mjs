import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git.js';

const root = mkdtempSync(join(tmpdir(), 'remotegit-test-'));
const gitconfig = join(root, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root };

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
  assert.deepEqual(br.remote.map((x) => x.name).sort(), ['origin/feature', 'origin/main']);
  await git.checkoutRemoteBranch(exec, a, 'origin/feature');
  assert.equal((await git.getStatus(exec, a)).branch.head, 'feature');
  await git.checkoutBranch(exec, a, 'main');
  await git.checkoutRemoteBranch(exec, a, 'origin/feature'); // reuses the local branch
  await git.createBranch(exec, a, 'new-thing');
  assert.equal((await git.getStatus(exec, a)).branch.head, 'new-thing');
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
