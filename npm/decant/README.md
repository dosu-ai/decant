# @dosu/decant

Local Claude Code and Codex session search, analytics, and workflow distillation.

`@dosu/decant` is the Node-compatible launcher for the compiled `decant` CLI. It
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

Supported platforms are macOS and Linux on x64 and arm64. On unsupported
platforms, the launcher exits with a clear message:

> decant does not ship a binary for win32/x64. Supported targets:
> darwin/arm64, darwin/x64, linux/arm64, linux/x64.

Source, docs, and release assets live at
<https://github.com/dosu-ai/decant>. Distribution details are in
<https://github.com/dosu-ai/decant/blob/main/docs/distribution.md>.

Apache-2.0
