<!-- GIT_SYNC:START -->

## Git synchronization — Claude and Codex

These instructions apply equally to Claude Code and Codex, on the MacBook and
Windows PC, in every repository under `repos`. GitHub carries work between
machines; saving a file or making a local commit does not make it available on
the other computer.

1. **At task start**, read the repository guidance, inspect `git status --short
--branch`, the current branch, its upstream, and existing changes. The startup
   hook runs `node scripts/git-sync.mjs start`, which fetches and only
   fast-forwards a clean, non-diverged checkout, and reports the previous
   session's exit checkpoint. Preserve unrelated work; do not silently stash,
   reset, clean, switch branches, or overwrite changes. Reconcile divergence
   deliberately before editing overlapping files.
2. **Before finishing each completed work chunk**, review the exact diff and run
   the checks appropriate to the change, including required security/PHI checks.
   Stage only task-owned paths with `git add -- <paths>`, inspect the staged diff,
   and commit without waiting for another prompt. Do not bypass commit
   validation to make synchronization pass.
3. **Push before the final response**: run `node scripts/git-sync.mjs finish`.
   It pushes existing reviewed commits to the configured upstream and compares
   local HEAD with the actual remote branch. Report the commit and any remaining
   local edits or sync failure. Do not claim the other machine has pulled it.
4. **Quitting commits and pushes everything (exit checkpoint).** On session exit
   (not `/clear` or resume) both agents' exit hook starts a detached
   `git-sync.mjs checkpoint`: it stages all outstanding changes (`git add -A`,
   honoring `.gitignore`), commits them as `sync: <host> exit checkpoint …
   [skip ci]` with the repository's pre-commit/commit-msg validation enabled
   (post-commit deploy hooks do not run), and pushes. It refuses, committing
   nothing, when a changed file looks like a secret or database (`.env*`,
   `.dev.vars`, keys, `*.sqlite`/`*.db`), exceeds 20 MB, or more than 300 paths
   changed (`git config agentsync.maxpaths <n>` raises that per clone). When the
   remote is ahead it commits locally but does not push or merge. Checkpoint
   commits are not milestones; they may be squashed before a release.
5. **Synchronization must not deploy**. Sync commits include `[skip ci]`, and the
   helper suppresses machine-local fetch/merge/push hooks. It never deploys or
   applies migrations. Follow a project's separate release process when a
   deployment is authorized.
6. **When interrupted or offline**, preserve the files and commits and state
   what is still local; the next exit checkpoint or `finish` pushes them. Never
   force-push or overwrite the other machine's work.
7. **Use one canonical checkout per project**, under `~/repos/<project>` on the
   Mac and a local `repos` directory on the PC. Any necessary temporary worktree
   belongs inside that project at `.worktrees/<task>` and is removed after
   integration. Credentials, databases, dependencies, and build output do not
   travel through Git; follow the project's setup and backup instructions.
8. **Session log and to-do (every repository, both agents).** Each repository
   keeps a running session log at `docs/changelog.md`, newest first. The startup
   hook prints its latest entry and the number of open `ToDo.md` items; read
   them before starting work. Before the final push of any session that changed
   the repository, prepend a dated entry (date, agent, machine, what changed,
   what was verified, what is still open, commit range), following the file's
   existing format, and commit it with the session's last work chunk. Create
   `docs/changelog.md` if it is missing. Track open work in `ToDo.md` at the
   repository root and check items off as they are finished.

Both agents have identical tracked startup and exit hooks (`.claude/settings.json`,
`.codex/hooks.json`). Closing a terminal window, suspending a computer, or a
crash cannot guarantee the exit hook, so steps 2–3 remain required while the
agent is running. Codex may require one-time review of the hook definitions in
`/hooks` on each machine. The helper disables the older user-wide Codex
checkpoint for this clone with `git config --local codex.sync.enabled false`.
Honor any explicit instruction not to commit/push.
Run `node scripts/check-git-sync.mjs` to verify that both agents' Git guidance and
hook commands still match. Update `GIT_SYNC.md` and every marked guidance block
together when this policy changes.

<!-- GIT_SYNC:END -->
