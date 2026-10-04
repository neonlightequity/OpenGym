import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synchronize } from './git-sync.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
// Isolate fixtures (and synchronize(), which inherits process.env) from the
// machine's Git config, e.g. core.autocrlf on Windows.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(project, '.git', 'absent-test-config');
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function fixture(t) {
  const area = path.join(project, '.git', 'git-sync-tests');
  mkdirSync(area, { recursive: true });
  const root = mkdtempSync(path.join(area, 'two-machines-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  const mac = path.join(root, 'mac');
  git(root, 'clone', remote, mac);
  for (const [key, value] of [
    ['user.name', 'Sync fixture'],
    ['user.email', 'sync@example.invalid'],
  ])
    git(mac, 'config', key, value);
  writeFileSync(path.join(mac, 'base.txt'), 'base\n');
  git(mac, 'add', 'base.txt');
  git(mac, 'commit', '-m', 'test: initial [skip ci]');
  git(mac, 'push', '-u', 'origin', 'main');
  const pc = path.join(root, 'pc');
  git(root, 'clone', remote, pc);
  for (const [key, value] of [
    ['user.name', 'Sync fixture'],
    ['user.email', 'sync@example.invalid'],
  ])
    git(pc, 'config', key, value);
  const commit = (cwd, name, message = 'test: reviewed change [skip ci]') => {
    writeFileSync(path.join(cwd, name), name + '\n');
    git(cwd, 'add', name);
    git(cwd, 'commit', '-m', message);
  };
  return { root, mac, pc, remote, commit };
}
test('PC pulls a reviewed Mac commit, then Mac pulls the PC update', t => {
  const { mac, pc, commit } = fixture(t);
  commit(mac, 'mac.txt');
  assert.equal(synchronize(mac, 'finish').remoteVerified, true);
  synchronize(pc, 'start');
  assert.equal(readFileSync(path.join(pc, 'mac.txt'), 'utf8'), 'mac.txt\n');
  commit(pc, 'pc.txt');
  synchronize(pc, 'finish');
  synchronize(mac, 'start');
  assert.equal(git(mac, 'rev-parse', 'HEAD'), git(pc, 'rev-parse', 'HEAD'));
});
test('finish pushes reviewed commits without committing staged or untracked files', t => {
  const { mac, commit } = fixture(t);
  commit(mac, 'reviewed.txt');
  writeFileSync(path.join(mac, 'private.txt'), 'local fixture value');
  git(mac, 'add', 'private.txt');
  writeFileSync(path.join(mac, 'unfinished.txt'), 'local work');
  const index = git(mac, 'ls-files', '--stage');
  const before = git(mac, 'rev-parse', 'HEAD');
  assert.equal(synchronize(mac, 'finish').uncommittedChanges, true);
  assert.equal(git(mac, 'rev-parse', 'HEAD'), before);
  assert.equal(git(mac, 'ls-files', '--stage'), index);
  assert.equal(git(mac, 'ls-tree', '--name-only', 'origin/main').includes('private.txt'), false);
});
test('start refuses remote advancement over staged local edits without autostashing', t => {
  const { mac, pc, commit } = fixture(t);
  commit(pc, 'pc.txt');
  synchronize(pc, 'finish');
  writeFileSync(path.join(mac, 'base.txt'), 'local edit\n');
  git(mac, 'add', 'base.txt');
  const index = git(mac, 'ls-files', '--stage');
  assert.throws(() => synchronize(mac, 'start'), /deliberate reconciliation/);
  assert.equal(git(mac, 'ls-files', '--stage'), index);
  assert.equal(git(mac, 'stash', 'list'), '');
});
test('diverged machines are preserved without force push or automatic merge', t => {
  const { mac, pc, commit } = fixture(t);
  commit(mac, 'mac.txt');
  commit(pc, 'pc.txt');
  synchronize(pc, 'finish');
  const before = git(mac, 'rev-parse', 'HEAD');
  assert.throws(() => synchronize(mac, 'finish'), /deliberate reconciliation/);
  assert.equal(git(mac, 'rev-parse', 'HEAD'), before);
});
test('unfinished rebase directories and detached HEAD block synchronization', t => {
  const { mac } = fixture(t);
  const rebase = path.join(mac, '.git', 'rebase-merge');
  mkdirSync(rebase);
  assert.throws(() => synchronize(mac, 'finish'), /operation in progress/);
  rmSync(rebase, { recursive: true });
  git(mac, 'checkout', '--detach');
  assert.throws(() => synchronize(mac, 'start'), /Detached HEAD/);
});
test('sync refuses a push that could trigger CI and does not create a marker commit', t => {
  const { mac, commit } = fixture(t);
  commit(mac, 'feature.txt', 'feat: missing sync marker');
  const head = git(mac, 'rev-parse', 'HEAD');
  assert.throws(() => synchronize(mac, 'finish'), /\[skip ci\]/);
  assert.equal(git(mac, 'rev-parse', 'HEAD'), head);
});
test('push does not execute a local pre-push deployment hook', t => {
  const { mac, commit } = fixture(t);
  commit(mac, 'safe.txt');
  const hook = path.join(mac, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, '#!/bin/sh\nexit 73\n', { mode: 0o755 });
  assert.equal(synchronize(mac, 'finish').status, 'synced');
});
test('an offline remote leaves the commit and local work intact', t => {
  const { mac, commit, root } = fixture(t);
  commit(mac, 'safe.txt');
  git(mac, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  const head = git(mac, 'rev-parse', 'HEAD');
  assert.throws(() => synchronize(mac, 'finish'), /git fetch failed/);
  assert.equal(git(mac, 'rev-parse', 'HEAD'), head);
});
test('exit checkpoint commits all outstanding work and the other machine pulls it', t => {
  const { mac, pc } = fixture(t);
  writeFileSync(path.join(mac, 'base.txt'), 'edited on mac\n');
  writeFileSync(path.join(mac, 'new.txt'), 'untracked on mac\n');
  const result = synchronize(mac, 'checkpoint');
  assert.equal(result.status, 'synced');
  assert.equal(result.checkpointed, true);
  assert.equal(result.uncommittedChanges, false);
  assert.match(git(mac, 'log', '-1', '--format=%B'), /exit checkpoint .*\[skip ci\]/);
  synchronize(pc, 'start');
  assert.equal(readFileSync(path.join(pc, 'new.txt'), 'utf8'), 'untracked on mac\n');
  assert.equal(readFileSync(path.join(pc, 'base.txt'), 'utf8'), 'edited on mac\n');
});
test('exit checkpoint refuses secret-looking files and commits nothing', t => {
  const { mac } = fixture(t);
  const head = git(mac, 'rev-parse', 'HEAD');
  writeFileSync(path.join(mac, 'work.txt'), 'work\n');
  writeFileSync(path.join(mac, '.env.local'), 'TOKEN=fixture\n');
  assert.throws(() => synchronize(mac, 'checkpoint'), /\.env\.local/);
  assert.equal(git(mac, 'rev-parse', 'HEAD'), head);
  assert.equal(git(mac, 'diff', '--cached', '--name-only'), '');
});
test('exit checkpoint refuses mass changes above the path limit', t => {
  const { mac } = fixture(t);
  git(mac, 'config', 'agentsync.maxpaths', '2');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(path.join(mac, name), name);
  assert.throws(() => synchronize(mac, 'checkpoint'), /exceed the checkpoint limit of 2/);
});
test('exit checkpoint runs commit validation but not a post-commit deploy hook', t => {
  const { mac } = fixture(t);
  const hooksDir = path.join(mac, '.git', 'hooks');
  writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\necho deployed > deployed.flag\n', {
    mode: 0o755,
  });
  writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho validated > validated.flag\n', {
    mode: 0o755,
  });
  writeFileSync(path.join(mac, 'work.txt'), 'work\n');
  synchronize(mac, 'checkpoint');
  assert.equal(readFileSync(path.join(mac, 'validated.flag'), 'utf8').trim(), 'validated');
  assert.throws(() => readFileSync(path.join(mac, 'deployed.flag')));
});
test('a rejecting validation hook leaves the work uncommitted and unstaged', t => {
  const { mac } = fixture(t);
  writeFileSync(path.join(mac, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const head = git(mac, 'rev-parse', 'HEAD');
  writeFileSync(path.join(mac, 'phi.txt'), 'blocked\n');
  assert.throws(() => synchronize(mac, 'checkpoint'), /validation rejected/);
  assert.equal(git(mac, 'rev-parse', 'HEAD'), head);
  assert.equal(git(mac, 'diff', '--cached', '--name-only'), '');
  assert.equal(readFileSync(path.join(mac, 'phi.txt'), 'utf8'), 'blocked\n');
});
test('exit checkpoint behind the remote commits locally without pushing or merging', t => {
  const { mac, pc, commit } = fixture(t);
  commit(pc, 'pc.txt');
  synchronize(pc, 'finish');
  writeFileSync(path.join(mac, 'mac.txt'), 'mac\n');
  assert.throws(() => synchronize(mac, 'checkpoint'), /committed locally but not pushed/);
  assert.match(git(mac, 'log', '-1', '--format=%B'), /exit checkpoint/);
  assert.equal(git(pc, 'ls-remote', '--heads', 'origin', 'main').split(/\s+/)[0], git(pc, 'rev-parse', 'HEAD'));
});
test('exit checkpoint marks unpushed unmarked commits with [skip ci] before pushing', t => {
  const { mac, commit } = fixture(t);
  commit(mac, 'feature.txt', 'feat: reviewed but unmarked');
  const result = synchronize(mac, 'checkpoint');
  assert.equal(result.status, 'synced');
  assert.match(git(mac, 'log', '-1', '--format=%B'), /\[skip ci\]/);
});
