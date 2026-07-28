# Decant

Local-first analysis of Claude Code and Codex sessions: token spend, context
windows, files touched, and cost.

Built by [Dosu](https://dosu.dev) for developers who want their agents to learn
from real work.

`decant` is the Node-compatible launcher for the compiled `decant` CLI. It
selects the matching optional platform package, then runs the embedded
Bun-compiled binary.

```sh
npx @dosu/decant sync
npx @dosu/decant ls
npx @dosu/decant serve
```

For a persistent install:

```sh
npm i -g @dosu/decant
decant serve
```

The global install puts a `decant` binary on your PATH, so day-to-day the
command is just `decant`.

Supported platforms are macOS and Linux on x64 and arm64. On unsupported
platforms, the launcher exits with a clear message:

> Decant does not ship a binary for win32/x64. Supported targets:
> darwin/arm64, darwin/x64, linux/arm64, linux/x64.

Source, docs, and release assets live at
<https://github.com/dosu-ai/decant>. Distribution details are in
<https://github.com/dosu-ai/decant/blob/main/docs/distribution.md>.

Apache-2.0
