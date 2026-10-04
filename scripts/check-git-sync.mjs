#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const policy = read('GIT_SYNC.md').trim();
const pattern = /<!-- GIT_SYNC:START -->[\s\S]*?<!-- GIT_SYNC:END -->/g;
const names = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'travel/AGENTS.md',
  'travel/CLAUDE.md',
].filter(name => ['AGENTS.md', 'CLAUDE.md'].includes(name) || existsSync(path.join(root, name)));
const failures = [];
const normalize = value => value.replace(/\s+/g, ' ').trim();
for (const name of names) {
  if (!existsSync(path.join(root, name))) {
    failures.push(`${name} missing`);
    continue;
  }
  const blocks = read(name).match(pattern) || [];
  if (blocks.length !== 1 || normalize(blocks[0]) !== normalize(policy))
    failures.push(`${name} Git policy differs`);
}
const claude = JSON.parse(read('.claude/settings.json')).hooks;
const codex = JSON.parse(read('.codex/hooks.json')).hooks;
for (const event of ['SessionStart', 'SessionEnd']) {
  const commands = source =>
    (source[event] || [])
      .flatMap(group => group.hooks || [])
      .filter(hook => hook.command?.includes('scripts/git-sync.mjs'))
      .map(hook => hook.command);
  const left = commands(claude),
    right = commands(codex);
  if (left.length !== 1 || JSON.stringify(left) !== JSON.stringify(right))
    failures.push(`${event} hook commands differ`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Git guidance and hooks match for Claude and Codex (${names.length} guides).`);
