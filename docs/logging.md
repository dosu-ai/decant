# Operational logging

`decant watch` and `decant serve` emit newline-delimited JSON (JSON Lines) to
stderr. Command results and `--json` data remain on stdout, so scripts can
consume them without parsing operational logs.

Each record has the same base fields:

- `@timestamp`: ISO 8601 event time.
- `level`: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, or `FATAL`.
- `message`: short human-readable description.
- `logger`: hierarchical component name such as `decant.server`.
- `service.name`: always `decant`.
- `event.name`: stable, fully qualified event type.

The current event names are:

| Event | Purpose |
| --- | --- |
| `decant.logging.configuration.invalid` | Invalid log level fell back to `info`. |
| `decant.watch.ready` | Source watcher initialized. |
| `decant.watch.stopped` | Source watcher stopped. |
| `decant.sync.completed` | One startup, watch, sweep, or manual sync completed. |
| `decant.sync.exception` | A sync failed. |
| `decant.server.started` | Local HTTP server started. |
| `decant.server.stopped` | Local HTTP server stopped. |
| `http.server.request` | HTTP request completed with method, route, status, and duration. |
| `http.server.request.exception` | Request handling raised an exception. |

Set `DECANT_LOG_LEVEL` to `trace`, `debug`, `info`, `warn` (or `warning`),
`error`, `fatal`, or `off` (or `silent`). The default is `info`. HTTP 4xx
outcomes use `WARN`; 5xx outcomes and exceptions use `ERROR`.

Logging is local and has no network transport. Request logs use route templates
and deliberately omit query strings, headers, bodies, source-directory paths,
and transcript content. Exception records include the runtime error message and
stack trace, which can contain local code or database paths. Redirect or pipe
stderr to an external processor if retention, rotation, or shipping is needed;
those policies stay outside the application process.
