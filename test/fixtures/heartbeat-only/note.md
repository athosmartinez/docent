### Heartbeat fixture

A single small page, isolated from `test/fixtures/corpus` so this file's
source URI cannot collide with the other e2e spec files that ingest that
directory concurrently in separate Jest workers.
