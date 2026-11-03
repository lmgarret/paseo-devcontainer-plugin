Start, stop, and rebuild your dev containers from Paseo, open a shell in them, and keep the Paseo daemon inside each one running, without opening VS Code.

## How it finds dev containers

The plugin lists:

- every Paseo project on this host with a `.devcontainer/devcontainer.json` or `.devcontainer.json`, even if its container was never built;
- every running container created by VS Code or the `devcontainer` CLI, and stopped ones whose folder is still a Paseo workspace;
- repositories you add in settings.

Each container is linked to its Paseo project and workspace on this host, and shown with the project's icon. The Paseo daemon inside a container is matched to the host you paired in the app by its server ID, read from the daemon while the container runs, or from the `server-id` file when its Paseo home is mounted from this machine.

## What you get

A "Dev containers" row in the sidebar footer shows how many containers run. Its popover lists up to five active containers, those running, busy, paired with the app, or left without a container by a failed build, with a status dot and icon actions:

- start, stop, and rebuild, with stop and rebuild asking for confirmation because agents in the container stop with it. The rebuild confirmation also offers a rebuild without the image cache;
- logs: a Paseo terminal in the project's workspace following the latest job's full log. Rebuilds, and starts that create a container, open it on their own;
- rebuild in every state but while a job runs, including containers built by VS Code or the `devcontainer` CLI;
- after a failed build that removed the container, retry, rebuild, the log, and dismiss;
- start the Paseo daemon when it is down, or install Paseo when it is missing;
- open a shell: a Paseo terminal in the project's workspace running `docker exec` into the container.

Pressing a row opens the "All dev containers" page with that container shown. When a paired container stops, a toast suggests starting it. The Command Center lists the actions valid for each container.

The "All dev containers" page sums up what runs, what is paired, and how many ports are forwarded. Running containers come first, as cards that open on their details: its project's workspaces on the container's own Paseo host, most urgent first, each opening on that host; its forwarded ports; and its Paseo daemon. Pressing a card's header folds it. Other containers follow as a compact list grouped by project, with their start action, and any container can be hidden from the sidebar.

## Port forwarding

Like VS Code, the plugin forwards ports from running containers to this machine through `docker exec`, so devcontainer.json needs no `appPort` and nothing has to listen outside the container's loopback:

- each container's Paseo daemon gets its own local port, from 6768 up, saved per repository so it stays the same across restarts and rebuilds;
- other ports opened in a container, such as a dev server, are detected within a few seconds and forwarded on the same local port, or the next free one. A toast announces them, and they show as pills on the container's row: press one to open it in the browser.

A running container's card lists its ports like VS Code's Ports view: each forwarded port with its local address and the listening process, then the daemon's address and whether it is paired. Pressing a port opens it; hovering shows copy and stop. Stopping a detected port ignores it for that repository, with an undo, and a collapsed "ignored ports" list brings it back. "Forward a port" adds one by hand, even before anything listens on it.

Ports below 1024, Linux's ephemeral range (32768–60999), and ignored ports in settings are not detected, but can be forwarded by hand. Containers on the host network already share their ports with this machine through Docker, so only their daemon is forwarded, to a port that does not clash with this machine's own daemon. A daemon's port carries connections only while the container reports its daemon running: in a host-network container the daemon's address is shared with this machine and with other host-network containers, so another daemon could answer there. Containers need Node.js on their login PATH, which Paseo already requires.

## Setup

Install the plugin on the daemon of the machine that runs Docker, not on a daemon inside a container. That machine needs Docker and the `devcontainer` CLI (`@devcontainers/cli`). Pair each container's Paseo daemon with the app once, at the `localhost` address shown on its row.

Settings:

- Discovery: scan Paseo projects for dev container configs, and add other repositories.
- Paseo in containers: the command that installs the Paseo CLI (`@getpaseo/cli` from the npm registry by default), run as the container's remote user, and whether Start and Rebuild run it when Paseo is missing. This is on by default. When it is off, Start and Rebuild still succeed and the container offers Install Paseo.
- Paseo home: keep each container's Paseo home in a folder on this machine, `~/.paseo/plugin-data/devcontainer-host/homes/<repository>` by default. See below. On by default; applies to containers created afterwards.
- Builds: whether rebuilds open their log in a terminal. On by default.
- Port forwarding: daemon and detected-port forwarding, the first daemon port, and ports to ignore.
- Dotfiles: a repository, target path, and install command passed to `devcontainer up`, so created containers match VS Code's dotfiles setting.
- SSH agent: mount this machine's SSH agent into created containers, so keys with a passphrase work without typing it, like VS Code's agent forwarding. On macOS the plugin uses the socket that Docker Desktop and OrbStack provide. With another runtime such as Colima, set the agent socket's path in its VM. On Linux it uses `$SSH_AUTH_SOCK`. On by default. Existing containers need a rebuild.
- Advanced: paths to `docker` and `devcontainer` when they are not on the daemon's PATH, in Homebrew, Docker Desktop, or nvm.

## Paseo home and worktrees

When a container is created, the plugin mounts its Paseo home folder at the same absolute path inside the container, links the container's `~/.paseo` to it, and sets that daemon's `worktrees.root` to the folder's `worktrees`. It also mounts this machine's Paseo worktrees for the repository at their own path. So:

- the daemon keeps its server ID, pairing, and agents across rebuilds;
- every Paseo worktree has the same path on this machine and in the container. Git records each worktree's absolute path in the repository's shared `.git`, and `git worktree prune`, which Paseo runs whenever it archives a worktree, deletes the record of any worktree it cannot see. With different paths on each side, archiving on one side broke the other side's worktrees.

The plugin leaves the home alone when the dev container config sets `PASEO_HOME`, and keeps `~/.paseo` when it already holds another daemon's data. Worktrees created outside these folders, by hand or by other tools, can still be pruned by the other side.

## Limits

A daemon keeps its server ID across rebuilds only if its Paseo home is on a mount; the page warns when it is not. The plugin cannot pair hosts or change Paseo's built-in "host unreachable" screen. Forwarded ports exist only while this machine's Paseo daemon runs, and each new connection starts a `docker exec`, adding a little latency.
