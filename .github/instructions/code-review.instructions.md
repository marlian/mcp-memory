---
applyTo: "**/*"
---

# Code Review Instructions

## Review posture

You are reviewing code in an MCP memory server. The codebase is a single file (`server.js`, ~1400 LOC) backed by SQLite. It has no web framework, no HTTP, and no runtime dependencies beyond `@modelcontextprotocol/sdk` and `better-sqlite3`. Bugs here cause silent data loss, incorrect retrieval, or broken multi-tenant isolation — all invisible to the caller.

## Priority checklist

Check these in order. Stop and flag a finding as soon as you see a violation.

### 1. Tombstone invariant

Every query that reads live data must guard both tables:

- `entities.deleted_at IS NULL`
- `observations.deleted_at IS NULL`

A query missing either guard silently returns soft-deleted rows. This is the highest-frequency escape in this codebase.

Also verify: `forget` correctly tombstones entities, observations, AND cleans up the FTS5 index before setting `deleted_at`.

### 2. FTS5 delete pattern

`memory_fts` is a contentless FTS5 virtual table. You cannot issue `DELETE FROM memory_fts WHERE ...` — it will crash.

The only correct deletion pattern is the special INSERT command:
```sql
INSERT INTO memory_fts(memory_fts, rowid, entity_name, observation_content, entity_type)
VALUES('delete', <id>, <name>, <content>, <type>);
```

The `entity_type` must come from the **observation row** (`o.entity_type`), not from `entities.entity_type`. If a PR reads entity_type from `entities` for this purpose, flag it — the entity type can change after indexing.

### 3. Tool contract compliance

- Is the new/changed tool present in the `TOOLS` array with a correct `inputSchema`?
- Is there a corresponding `case` in the `handleTool` switch?
- Does the handler call `getDb(defaultDb, args.project)` to respect project scoping?
- If the tool accepts `project`, does it pass the correct `halfLife` (project vs. global half-life)?

### 4. Multi-tenant isolation

- Any new tool or query that touches the file system must use `resolveProjectPath` — never raw `path.join(home, userInput)`.
- Project DBs are cached in the `projectDbs` Map. New code that opens DBs must go through `getDb`, not initialize them directly.
- A query must never accidentally cross-contaminate the global DB and a project DB.

### 5. Scoring pipeline integrity

If a PR touches `searchMemory`, `collectCandidates`, `hydrateCandidates`, or `scoreCandidates`:

- `touchObservations` must be called **only on the final ranked slice**, not on candidates.
- `sanitizeSearchLimit` must be applied before any DB query that uses limit.
- The candidate pool must overcollect (`collectLimit = limit * COLLECTION_MULTIPLIER`) before scoring.
- Hard cap (`maxCandidates`) must be respected to avoid oversized `IN()` parameter lists.

### 6. SQL safety

- All queries use parameterized statements (`db.prepare(...)`) with `?` or named `@param` placeholders.
- No string interpolation of user-supplied values into SQL.
- Chunked `IN()` queries (used in `hydrateCandidates` and `getObservationsByIds`) must handle empty arrays without issuing a malformed `IN ()` query.

### 7. Database migration correctness

If a PR adds a column to an existing table:

- The column must appear in the `CREATE TABLE IF NOT EXISTS` statement (fresh DBs).
- A `try/catch` migration block must handle existing DBs: `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch (_) { }`. SQLite raises on duplicate columns — the catch is the idempotency guard.
- Do **not** flag a migration for lacking a `PRAGMA table_info()` gate — this repo uses `try/catch`, not schema inspection.
- The migration must be idempotent: re-running `initDb` on a DB that already has the column must not crash.

### 8. Configuration and hardcoding

- New thresholds, limits, or behavior-controlling constants must come from `process.env` with a sensible default — not hardcoded.
- New env vars must be documented in `.env.example`.
- Tool description examples must use `exFmt(EXAMPLES.*)` — never inline entity names, relation types, or event labels as literals in `TOOLS`.

### 9. Test coverage

- New tools or changed tool behavior must have corresponding test cases in `test/server.test.js`.
- Tests must use an isolated `initDb(tmpDir/...)` — never the production `memory.db`.
- For tombstone-sensitive paths, test that deleted entities/observations are excluded from results.
- For FTS paths, test that `forget` removes the observation from subsequent `recall` results.

## Severity classification

- **Critical:** data loss (tombstoned rows returned), cross-tenant data leak, FTS crash on delete, SQL injection surface
- **High:** missing tool contract entry (tool silently ignored by MCP layer), wrong half-life applied, touchObservations on wrong set
- **Medium:** missing migration block (breaks existing DBs), hardcoded threshold that should be configurable, missing error path test
- **Low:** documentation gap, style inconsistency, non-critical naming

## What NOT to flag

- The single-file architecture — it's intentional for zero-friction deployment
- CommonJS style — this project deliberately does not use ESM
- Missing TypeScript types — plain JS by design
- Performance concerns on the scoring pipeline unless there's a measurable regression on realistic data sizes (< 10k observations)
- Minor naming choices consistent with existing code
