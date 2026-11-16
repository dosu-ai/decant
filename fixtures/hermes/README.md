# Hermes Agent fixtures

Each `.sql` script is one or more invented Hermes Agent sessions, written by
hand for Decant's tests. `schema.sql` holds the tables and columns Decant reads
from a Hermes `state.db`, as NousResearch/hermes-agent declares them at schema
version 33. SQLite files are not committed, so `test/hermes-fixture.ts` builds
`state.db` from the schema and the scripts when a test or
`scripts/regen-goldens.ts` stages them. Every path is under
`/decant-fixture/example`, which no user can create.
