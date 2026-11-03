# Cursor fixtures

Each directory is one Cursor CLI chat: `meta.json` as Cursor writes it beside
the chat's store, and `store.json` holding the store's metadata and message
records. All of it is invented. SQLite files are not committed, so
`test/cursor-fixture.ts` builds `store.db` from `store.json` when a test or
`scripts/regen-goldens.ts` stages the chat.
