#!/usr/bin/env node
// Shared by Claude and Codex on macOS and Windows. start/finish/status never
// stage or commit; checkpoint (the exit hook) commits all outstanding work.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_CI = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;
// Hooks that validate a commit. post-commit (auto-deploy) is deliberately absent.
const VALIDATION_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
const SECRET_NAME =
  /^(?:\.env(?!\.(?:example|sample|template)$)(?:\..*)?|\.dev\.vars|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx|keystore|sqlite3?|db)|credentials.*\.json|service-account.*\.json)$/i;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PATHS = 300;

export function synchronize(cwd, mode = 'status') {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    delete env[key];
  }
  let hooks;
  const run = (hooksPath, timeout, args) => {
    try {
      return execFileSync(
        'git',
        [...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []), '-C', cwd, ...args],
        {
          encoding: 'utf8',
          timeout,
          maxBuffer: 64 * 1024 * 1024,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      ).trim();
    } catch {
      // Credential helpers, remote URLs and hook output (PHI/secret scanners) can
      // contain sensitive text; do not echo stderr.
      throw new Error(`git ${args[0]} failed; inspect Git locally.`);
    }
  };
  const git = (...args) => run(hooks, 30000, args);
  const optional = (...args) => {
    try {
      return git(...args);
    } catch {
      return '';
    }
  };
  if (!['start', 'finish', 'status', 'checkpoint'].includes(mode))
    throw new Error('Use start, finish, status, or checkpoint.');
  const root = git('rev-parse', '--show-toplevel');
  const branch = optional('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (!branch) throw new Error('Detached HEAD: choose a branch deliberately before synchronizing.');
  for (const marker of [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'index.lock',
  ]) {
    if (existsSync(path.resolve(cwd, git('rev-parse', '--git-path', marker)))) {
      throw new Error(`Git operation in progress (${marker}); finish it before synchronizing.`);
    }
  }
  const remote = optional('config', '--get', `branch.${branch}.remote`);
  const remoteRef = optional('config', '--get', `branch.${branch}.merge`);
  if (!remote || remote === '.' || !remoteRef.startsWith('refs/heads/')) {
    throw new Error('No remote upstream: verify the intended remote and set tracking explicitly.');
  }
  let head = git('rev-parse', 'HEAD');
  const dirty = Boolean(git('status', '--porcelain=v1', '--untracked-files=normal'));
  if (mode === 'status') {
    const upstream = optional('rev-parse', '--verify', '@{upstream}');
    const counts = upstream
      ? git('rev-list', '--left-right', '--count', `${head}...${upstream}`).split(/\s+/).map(Number)
      : [null, null];
    return {
      status: 'local-status',
      root,
      branch,
      head,
      uncommittedChanges: dirty,
      ahead: counts[0],
      behind: counts[1],
      remoteVerified: false,
    };
  }
  // The older user-wide Codex checkpoint staged every file with validation
  // disabled. This helper's checkpoint replaces it for this clone.
  git('config', '--local', 'codex.sync.enabled', 'false');
  const syncDir = path.resolve(cwd, git('rev-parse', '--git-common-dir'), 'agent-sync');
  let checkpointed = false;
  if (mode === 'checkpoint' && dirty) {
    const entries = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
    const changed = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const status = entry.slice(0, 2);
      changed.push({ status, file: entry.slice(3) });
      if (/[RC]/.test(status)) i++; // rename/copy: the source path follows
    }
    const maxPaths = Number(optional('config', '--get', 'agentsync.maxpaths')) || DEFAULT_MAX_PATHS;
    if (changed.length > maxPaths) {
      throw new Error(
        `${changed.length} changed paths exceed the checkpoint limit of ${maxPaths}; ` +
          'commit deliberately, or raise it with `git config agentsync.maxpaths <n>`. Nothing was committed.'
      );
    }
    const refused = [];
    for (const { status, file } of changed) {
      if (status.includes('D')) continue;
      if (SECRET_NAME.test(path.basename(file))) refused.push(`${file} (looks like a secret or database)`);
      else {
        try {
          if (statSync(path.join(root, file)).size > MAX_FILE_BYTES) refused.push(`${file} (over 20 MB)`);
        } catch {
          /* vanished or a directory entry; git add reports real problems */
        }
      }
    }
    if (refused.length) {
      throw new Error(
        `Checkpoint refused: ${refused.slice(0, 5).join(', ')}${refused.length > 5 ? ', …' : ''}. ` +
          'Ignore or remove these, or commit deliberately. Nothing was committed.'
      );
    }
    // Run the repository's commit validation (e.g. PHI/secret scanners) but not
    // post-commit, which some clones use to deploy.
    const realHooks = path.resolve(root, git('rev-parse', '--git-path', 'hooks'));
    const validate = path.join(syncDir, 'validate-hooks');
    rmSync(validate, { recursive: true, force: true });
    mkdirSync(validate, { recursive: true });
    for (const name of VALIDATION_HOOKS) {
      const real = path.join(realHooks, name);
      if (existsSync(real) && statSync(real).isFile()) {
        writeFileSync(
          path.join(validate, name),
          `#!/bin/sh\nexec "${real.replace(/\\/g, '/')}" "$@"\n`,
          { mode: 0o755 }
        );
      }
    }
    git('add', '-A', '--', '.');
    try {
      run(validate, 600000, [
        'commit',
        '--quiet',
        '-m',
        `sync: ${hostname()} exit checkpoint ${new Date().toISOString()} [skip ci]`,
      ]);
    } catch {
      optional('reset', '--quiet');
      throw new Error(
        'Commit validation rejected the exit checkpoint; files are unstaged and still local. ' +
          'Run `git commit` by hand to see why.'
      );
    }
    head = git('rev-parse', 'HEAD');
    checkpointed = true;
  }
  // Fetch/fast-forward/push must not execute machine-local deployment hooks.
  hooks = path.join(syncDir, 'empty-hooks');
  mkdirSync(hooks, { recursive: true });
  if (readdirSync(hooks).length) throw new Error('Expected an empty sync hooks directory.');
  git('fetch', '--quiet', remote, remoteRef);
  const remoteHead = git('rev-parse', 'FETCH_HEAD');
  const [ahead, behind] = git('rev-list', '--left-right', '--count', `${head}...${remoteHead}`)
    .split(/\s+/)
    .map(Number);
  if (behind && (ahead || (dirty && !checkpointed))) {
    throw new Error(
      `Upstream is ${behind} commit(s) ahead; local commits or edits require deliberate reconciliation.` +
        (checkpointed ? ' The exit checkpoint was committed locally but not pushed.' : '')
    );
  }
  if (mode === 'start') {
    if (behind) git('merge', '--ff-only', '--no-edit', remoteHead);
    return {
      status: 'ready',
      root,
      branch,
      head: git('rev-parse', 'HEAD'),
      ahead,
      behind: 0,
      uncommittedChanges: dirty,
      remoteVerified: true,
    };
  }
  if (behind)
    throw new Error('Upstream advanced; run start and validate the combined work before pushing.');
  if (ahead) {
    if (!SKIP_CI.test(git('log', '-1', '--format=%B'))) {
      if (mode !== 'checkpoint') {
        throw new Error(
          'Sync push requires a reviewed final commit marked [skip ci] to suppress push-triggered workflows.'
        );
      }
      // Unpushed commits without the marker could trigger CI deploys on push.
      run(path.join(syncDir, 'validate-hooks'), 600000, [
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        `sync: ${hostname()} exit checkpoint ${new Date().toISOString()} [skip ci]`,
      ]);
      head = git('rev-parse', 'HEAD');
      checkpointed = true;
    }
    git('push', remote, `HEAD:${remoteRef}`);
  }
  const verified = git('ls-remote', '--heads', remote, remoteRef).split(/\s+/)[0];
  if (verified !== head)
    throw new Error('Remote HEAD differs; cross-machine synchronization is not confirmed.');
  return {
    status: 'synced',
    root,
    branch,
    head,
    checkpointed,
    uncommittedChanges: mode === 'checkpoint' ? Boolean(optional('status', '--porcelain')) : dirty,
    remoteVerified: true,
  };
}

const reportPath = cwd => {
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return path.resolve(cwd, common, 'agent-sync', 'last-checkpoint.json');
};

// The previous session's exit checkpoint ran detached; surface its outcome once.
function previousCheckpoint(cwd) {
  try {
    const file = reportPath(cwd);
    if (!existsSync(file)) return '';
    const result = JSON.parse(readFileSync(file, 'utf8'));
    renameSync(file, file.replace(/\.json$/, '.reported.json'));
    return result.status === 'failed'
      ? ` Last exit checkpoint (${result.at}) FAILED: ${result.reason}`
      : result.checkpointed
        ? ` Last exit checkpoint (${result.at}) pushed ${result.head.slice(0, 12)}.`
        : '';
  } catch {
    return '';
  }
}

function hookPayload() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/**
 * Session context for the startup hook (GIT_SYNC.md item 8): the latest
 * docs/changelog.md entry and the open ToDo.md item count, so every Claude or
 * Codex session starts from the last session's summary.
 */
export function sessionContext(root) {
  const lines = [];
  // Either spelling (some repos track docs/CHANGELOG.md).
  const log = ['changelog.md', 'CHANGELOG.md'].map((name) => path.join(root, 'docs', name)).find((file) => existsSync(file));
  if (log) {
    // Entry headings are level-2 headings outside fenced code (a format example
    // inside ``` must not count as the latest entry).
    const all = readFileSync(log, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const headings = [];
    let fenced = false;
    all.forEach((line, i) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      else if (!fenced && /^## /.test(line)) headings.push(i);
    });
    if (headings.length === 0) {
      lines.push('[session] docs/changelog.md has no entries yet; add one before this session ends.');
    } else {
      let entry = all.slice(headings[0], headings[1] ?? all.length).join('\n').trim();
      const entryLines = entry.split('\n');
      if (entryLines.length > 40 || entry.length > 3000) {
        entry = entryLines.slice(0, 40).join('\n').slice(0, 3000) + '\n… (see docs/changelog.md for the rest)';
      }
      lines.push('[session] Latest docs/changelog.md entry:', entry);
    }
  } else {
    lines.push('[session] docs/changelog.md is missing; create it and log this session (GIT_SYNC.md item 8).');
  }
  const todo = path.join(root, 'ToDo.md');
  if (existsSync(todo)) {
    const open = (readFileSync(todo, 'utf8').match(/^\s*[-*] \[ \]/gm) || []).length;
    lines.push(`[session] ToDo.md: ${open} open item${open === 1 ? '' : 's'}; read it before starting.`);
  }
  lines.push('[session] Before finishing, prepend this session to docs/changelog.md.');
  return lines.join('\n');
}

function printSessionContext(cwd) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
    console.log(sessionContext(root));
  } catch {
    /* not a repository; nothing to report */
  }
}

function main() {
  const input = process.argv[2] || 'status';
  const hook = input.startsWith('hook-');
  const cwd = process.cwd();
  if (input === 'hook-end') {
    // Exit hooks get ~3 seconds; commit and push from a detached worker instead.
    // A /clear or resume continues the same work, so it is not a checkpoint.
    if (['clear', 'resume'].includes(hookPayload().reason)) return;
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'checkpoint-worker'], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      console.log('[git-sync] Exit checkpoint queued; the next session start reports its result.');
    } catch (error) {
      console.error(`[git-sync] Could not queue the exit checkpoint: ${error.message}`);
    }
    return;
  }
  if (input === 'checkpoint-worker') {
    let result;
    try {
      result = synchronize(cwd, 'checkpoint');
    } catch (error) {
      result = { status: 'failed', reason: error.message };
    }
    try {
      const file = reportPath(cwd);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2) + '\n');
    } catch {
      /* not a repository; nothing to report */
    }
    return;
  }
  const mode = input === 'hook-start' ? 'start' : input;
  const earlier = hook ? previousCheckpoint(cwd) : '';
  try {
    const result = synchronize(cwd, mode);
    if (hook) {
      console.log(
        `[git-sync] ${result.status}: ${result.branch} ${result.head.slice(0, 12)}.` +
          (result.uncommittedChanges
            ? ' Uncommitted files remain local; the exit checkpoint will commit them.'
            : '') +
          (result.ahead ? ` ${result.ahead} commit(s) need a verified push.` : '') +
          earlier
      );
    } else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[git-sync] ${error.message}${earlier}`);
    process.exitCode = hook ? 0 : 1;
  }
  if (hook) printSessionContext(cwd);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { main, printSessionContext };
