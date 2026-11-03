# Worktrees shared with a dev container

When a repository is used by Paseo on your machine and by Paseo inside its dev container, both sides share one `.git`. Some git commands run on one side can break the other side's worktrees. This page explains why, what the plugin does about it, what it cannot catch, and how to recover by hand.

## Why it breaks

Git keeps one record per worktree in `.git/worktrees/<name>`, and stores absolute paths:

- each worktree's `.git` file points at its record: `gitdir: <repository>/.git/worktrees/<name>`;
- each record's `gitdir` file points back at the worktree's `.git` file.

The repository has a different path on each side, for example `~/git/app` on your machine and `/workspaces/app` in the container. Two commands then do damage:

- `git worktree prune` deletes the record of every worktree whose folder it cannot see. Paseo runs it each time it archives a workspace, on whichever side archives.
- `git worktree repair` rewrites every worktree's `.git` file to the repository path of the side that runs it. The other side can no longer open those worktrees: git reports "not a git repository" or "gitfile does not point to a valid repository".

## What the plugin does

These protections are on by default. You can turn them off with "Guard shared worktrees" in the plugin's settings, which needs "Keep the Paseo home".

- **Same paths.** The container's Paseo home and this machine's Paseo worktrees for the repository are mounted at their own paths. Paseo worktrees then have the same path on both sides, so a prune on either side keeps their records.
- **Your repository's path in the container.** Each time the plugin starts the container's Paseo daemon, and on each check of a running container, it links the repository's path on this machine to its folder in the container, as root. A `.git` file that a repair on this machine rewrote still opens in the container. The link is lost when the container is rebuilt and made again on the next start or check.
- **Snapshots.** The plugin copies each working record into `<container home>/devcontainer-guard/snapshots`, which both sides see at the same path. It keeps a snapshot until both sides confirm the worktree's folder is gone.
- **Checks.** Each worktree is shown as one of:
  - safe;
  - at risk: only one side can see its folder, so a prune on the other side deletes its record. This is often a worktree created by hand outside the shared folders;
  - broken: its record was deleted, taken by another worktree with the same name, or its `.git` file points to a path a side cannot open.
  The dev container's row shows the count, and its card lists each worktree with what is wrong. Checks run every 15 seconds while the Paseo app is open, and every minute otherwise.
- **Repairs after archives.** After an archive on this machine, the plugin waits for Paseo to remove the worktree and prune, then puts back any other worktree's record from its snapshot. A small companion plugin, `devcontainer-guard`, does the same inside the container after the container's own archives. Records it cannot reach there are reported to this machine, which repairs them within seconds. The archived worktree stays gone: a record is only put back when the worktree's folder still exists and its `.git` file names that record.
- **Restore.** The card's Restore button repairs every broken worktree it can, on either side.
- **A warning.** When you create a workspace on this machine for a repository that also runs in a dev container, the plugin logs a warning and shows it once.

A repair writes the record's `HEAD`, `gitdir`, `commondir`, and `locked` and `config.worktree` when they exist, then rebuilds the index from `HEAD` with a mixed `git reset`. Files in the worktree are not touched. Changes that were staged show as unstaged afterwards, and a merge or rebase in progress is lost. A worktree on a detached `HEAD` returns to the commit of its last snapshot.

## What it cannot catch

- A `git worktree prune` or `repair` run by hand, by an agent, or by a tool such as GitKraken, on either side. The next check shows the damage. Press Restore to repair it: only archives are repaired on their own.
- Damage while this machine's Paseo daemon is not running. The next check after it starts shows it.
- Worktrees whose record was deleted before the plugin took its first snapshot. Recover those by hand, below.
- Containers without the plugin's Paseo home, such as ones created before it was turned on, or whose config sets `PASEO_HOME`. Rebuild them from Paseo.

The companion plugin needs Paseo 0.15 or later in the container. The plugin copies it into the container's Paseo home and registers it in that daemon's config before starting the daemon. This sets `pluginsEnabled`, which also starts any other plugin configured there, and skips Paseo's trust prompt, since it is the plugin's own code. Updates reach a running daemon with a plugin reload, and a first install takes effect at the daemon's next start. If you disable it with `paseo plugin disable devcontainer-guard` in the container, it stays disabled.

With Docker Desktop, the container can take a while to see a file this machine just wrote in the shared `.git`. That is why repairs run inside the container whenever it can reach the worktree. If git in the container fails right after a change on this machine, wait a few seconds and try again.

## Recover by hand

1. In the broken worktree, read its `.git` file:

   ```bash
   cat .git
   # gitdir: /Users/you/git/app/.git/worktrees/feature-x
   ```

   The last part, `feature-x`, is the record's name.

2. If the `.git` file points at the other side's path, such as `/workspaces/app/...` on your machine, point it at this side's path of the repository:

   ```bash
   echo "gitdir: $HOME/git/app/.git/worktrees/feature-x" > .git
   ```

3. If the record is missing, copy it back from the snapshot, leaving out `.guard.json`:

   ```bash
   SNAPSHOT=~/.paseo/plugin-data/devcontainer-host/homes/app/devcontainer-guard/snapshots/feature-x
   mkdir ~/git/app/.git/worktrees/feature-x
   cp "$SNAPSHOT"/HEAD "$SNAPSHOT"/commondir "$SNAPSHOT"/gitdir ~/git/app/.git/worktrees/feature-x/
   ```

   Without a snapshot, create it: `gitdir` holds the worktree's `.git` path, for example `/Users/you/.paseo/worktrees/abc123/feature-x/.git`, `commondir` holds `../..`, and `HEAD` holds `ref: refs/heads/<branch>`.

4. Rebuild the index without touching files:

   ```bash
   git reset
   ```

   `git status` should now show only your own changes.

Run these on the side where you use the worktree. The home folder above is the default; it is under the "Paseo homes folder" setting when that is set.
