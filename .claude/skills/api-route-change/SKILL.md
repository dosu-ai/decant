---
name: api-route-change
description: Add, remove, or change a route served by `decant serve`, including parameters, limits, status codes, response shapes, and SSE events. Use when editing the route table in src/server/routes.ts, the path manifest in src/route-paths.ts, or anything the UI fetches through src/ui/api.ts.
---

# Change a serve API route

AGENTS.md invariant 7: the serve routes are a documented local API. These four
move together in one change:

1. The handler and its entry in the route table (`src/server/routes.ts`), plus
   the path manifest in `src/route-paths.ts`.
2. `docs/api/openapi.yaml`, the source contract. `/api/openapi.json` is its
   runtime representation, so a missing or stale entry is a user-visible bug.
3. `docs/api/routes.md`, the prose guide (access control, archive semantics,
   SSE events).
4. Contract tests in `test/api-contract.test.ts` and `test/server-routes.test.ts`
   (which pins the route table to the OpenAPI document), plus behavior tests in
   the relevant `test/server*.test.ts` file.

## Checks before changing semantics

- Find every UI caller: grep `src/ui/` for the path (views live in
  `src/ui/views/`). A new default limit or a narrower response can silently
  truncate what a page renders.
- Keep core modules print-free: the handler shapes HTTP, while queries and
  stats stay in their modules.
- Non-loopback serving needs explicit trusted peers. Host and Origin checks are
  defense in depth, not authentication; do not weaken either.
- No outbound network calls. The only runtime networking is the local server.

## Manual smoke

Use a scratch archive and a loopback port:

```sh
DECANT_DB=/tmp/decant-api.db bun run src/cli.ts --no-sync serve --no-open --port 43111
```

Done means `bun test`, `bunx tsc --noEmit`, and `bunx biome check .` pass.
