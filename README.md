<p align="center"><img src="assets/devcontainers-logo.svg" width="96" alt="Dev Containers logo"></p>

# Paseo dev container plugin

A [Paseo](https://paseo.sh) plugin to start, stop and rebuild dev containers, keep the Paseo daemon inside each one running, and forward container ports to your machine, without opening VS Code.

See [OVERVIEW.md](OVERVIEW.md) for what it does and how it behaves.

## Requirements

- Paseo 0.13.1 or later, with plugins enabled (Settings → Plugins).
- Docker and the [`devcontainer` CLI](https://github.com/devcontainers/cli) on the machine running the Paseo daemon.

## Install

Install it on the daemon of the machine that runs Docker, not on a daemon inside a container:

```bash
paseo plugin add git:lmgarret/paseo-devcontainer-plugin
```

## Development

```bash
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload devcontainer-host   # after each change
paseo plugin logs devcontainer-host
```

Layout: `index.client.tsx` and `client/` run in the app, `index.server.ts` and `server/` run in the daemon, and `shared/` holds the RPC contracts used by both.

## License

[MIT](LICENSE)

The Dev Containers logo is the [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) "Cube" icon, MIT, Copyright (c) Microsoft Corporation. This plugin is not affiliated with the Development Containers project.
