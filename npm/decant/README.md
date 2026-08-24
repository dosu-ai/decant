# Decant

[![npm version](https://img.shields.io/npm/v/%40dosu%2Fdecant?logo=npm)](https://www.npmjs.com/package/@dosu/decant)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/dosu-ai/decant/blob/main/LICENSE)

Local-first analytics for Claude Code and Codex sessions: token and cost
breakdowns, context-window usage, full-text search, files touched, tool usage,
and complete transcript browsing.

Decant is local-first. It makes no outbound network calls at runtime,
and your transcripts never leave your machine.

Built by
[Dosu](https://dosu.dev?utm_source=decant&utm_medium=npm&utm_campaign=attribution&utm_content=package_readme),
Knowledge Infrastructure for Agents. Dosu helps make agents faster, cheaper,
and more effective.

## Run without installing

```sh
npx @dosu/decant@latest          # start the local web UI
npx @dosu/decant@latest --help
npx @dosu/decant@latest ls
npx @dosu/decant@latest search "auth bug"
```

## Install globally

```sh
npm install --global @dosu/decant@latest
decant
```

The package is a small Node-compatible launcher that selects and runs the
matching compiled Decant binary. Node.js 18 or newer is required by the
launcher; Bun is not required.

Published binaries support:

- macOS arm64 and x64;
- Linux arm64 and x64.

Native Windows binaries are not currently available. If the matching optional
platform package was omitted during installation, reinstall without disabling
optional dependencies.

The local UI binds to <http://127.0.0.1:3000> by default. Run
`decant serve --no-open` to keep Decant from opening a browser, or
`decant --help` for the complete CLI.

Documentation, alternative install methods, source, and issue tracking are at
<https://github.com/dosu-ai/decant>.

Apache-2.0
