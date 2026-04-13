# Copilot Coding Agent — Repository Instructions

## Project context

This is `@marlian/mcp-memory`: a persistent memory server for LLMs via the Model Context Protocol (MCP). It exposes a knowledge graph (entities, observations, relations, events) backed by local SQLite with cognitive decay, composite relevance ranking, and project-scoped multi-tenancy.

The entire implementation lives in a single file: `server.js` (~1400 LOC). All key functions are exported for testability. Zero web framework, zero HTTP — pure stdio MCP transport.

Stack: Node.js, CommonJS, `better-sqlite3`, `@modelcontextprotocol/sdk`. These are the only runtime dependencies. Keep it that way.

## Code style

- CommonJS (`require`/`module.exports`) — **not ESM**
- No TypeScript — plain JS with JSDoc where helpful
- `node:test` + `node:assert/strict` for tests, no external test frameworks
- Prefer `node:` prefix for built-in modules (`node:fs`, `node:path`, `node:os`)
- `'use strict'` at top of every file
- Trailing newline on all files

## Architecture

### Single-file design

All logic lives in `server.js`. Functions are exported at the bottom so `test/server.test.js` can import them directly — no separate module files, no barrel re-exports.

### Database schema

Four tables. Soft-delete via `deleted_at TEXT` applies only to `entities` and `observations` — not to `relations` or `events`:

- `entities` — named objects (`id`, `name UNIQUE COLLATE NOCASE`, `entity_type`, `deleted_at`, timestamps)
- `observations` — atomic facts linked to an entity (`entity_id`, `content`, `source`, `confidence`, `access_count`, `last_accessed`, `deleted_at`, `event_id`, timestamps)
- `relations` — typed edges between entities (`from_entity_id`, `to_entity_id`, `relation_type`, `context`) — **no soft-delete**, hard-deleted via CASCADE when an entity is tombstoned
- `events` — grouped sessions/meetings/decisions (`label`, `event_date`, `event_type`, `context`, `expires_at`) — **no soft-delete**

**Invariant:** every query that reads live data **must** have `deleted_at IS NULL` guards on both `entities` and `observations`. Missing this guard is a tombstone bypass bug.

### FTS5 — contentless table

`memory_fts` is a **contentless** FTS5 virtual table. Contentless FTS5 tables do not support `DELETE` statements. To remove a row you must issue the special delete command:

```sql
INSERT INTO memory_fts(memory_fts, rowid, entity_name, observation_content, entity_type)
VALUES('delete', <id>, <entity_name>, <content>, <entity_type>);
```

The entity_type value must match **exactly** what was indexed at insert time — read it from the `observations` row (`o.entity_type`), not from `entities.entity_type`, because `upsertEntity` can change the entity type after indexing.

### Multi-tenant project memory

Any tool that accepts a `project` parameter routes to a per-project SQLite DB at `<project>/.memory/memory.db` (created lazily). The global default DB lives at `MEMORY_DB_PATH` (default: `server.js` directory).

- **`resolveProjectPath(project, homedir)`** — always use this to expand `~` and relative paths before any file system operation. Never call `path.join(home, projectPath)` directly on untrusted input.
- **`getDb(defaultDb, project)`** — returns the correct DB for a tool call. Each project DB is initialized once and cached in the `projectDbs` Map.
- Half-life: global = `MEMORY_HALF_LIFE_WEEKS` (default 12 weeks), project-scoped = `PROJECT_MEMORY_HALF_LIFE_WEEKS` (default 52 weeks). The correct value is passed automatically in `handleTool` based on whether `args.project` is set.

### Composite scoring pipeline (`searchMemory`)

Multi-channel candidate collection → hydration → scoring → ranking:

1. **`collectCandidates(db, q, collectLimit, maxCandidates)`** — gathers candidates from FTS, fuzzy match, relation graph, and entity name channels. Overcollects by `COLLECTION_MULTIPLIER` relative to the requested `limit` to give the scorer a broader pool.
2. **`hydrateCandidates(db, candidates)`** — fetches full observation rows for all candidate IDs in a single chunked `IN()` query.
3. **`scoreCandidates(observations, candidates, halfLifeWeeks, limit)`** — applies `compositeScore = decayedConfidence × accessFactor × ftsPositionScore`, returns the top `limit` results.
4. **`touchObservations(db, ids)`** — increments `access_count` and sets `last_accessed`. Called **only on the ranked slice returned to the caller**, never on the full candidate pool.

`sanitizeSearchLimit(limit)` clamps the limit to a safe integer in `[1, 200]`. A limit of 0 or negative returns `[]` immediately.

### Tool surface (MCP tools)

Current tools: `remember`, `remember_batch`, `recall`, `recall_entity`, `relate`, `forget`, `list_entities`, `remember_event`, `recall_events`, `recall_event`, `get_observations`, `get_event_observations`.

Every tool must:
1. Appear in the `TOOLS` array (schema + description)
2. Have a case in the `handleTool` switch
3. Route to `getDb(defaultDb, args.project)` to respect project scoping

`get_observations` and `get_event_observations` are provenance primitives — they bypass the scoring pipeline and return raw observations by ID. Tombstone semantics apply (deleted observations are excluded).

## No hardcoding

- Config comes from env vars. Defaults live in `server.js` only as fallback literals.
- Document any new env vars in `.env.example`.
- `MEMORY_DB_PATH`, `MEMORY_HALF_LIFE_WEEKS`, `PROJECT_MEMORY_HALF_LIFE_WEEKS` are the current env vars.
- Tool description examples come from `examples.json` (optional, merged with `DEFAULT_EXAMPLES`). Never hardcode entity names, relation types, or event labels directly in TOOLS descriptions.

## Security

- **SQL:** parameterize all queries — use `db.prepare('... WHERE id = ?').get(id)` or named params. Never interpolate user input into SQL strings.
- **Path traversal:** always use `resolveProjectPath` before treating user-supplied paths as filesystem targets. Validate that the resolved path is within expected bounds when relevant.
- **Input validation:** tool arguments are untrusted. Guard against `null`, `undefined`, wrong types, and empty strings before using them in queries or file operations.
- **No secrets in output:** `server.js` writes to stderr only for warnings. Never log DB paths, user observations, or env var values in error output sent to the MCP client.

## Database migration pattern

When adding columns to existing tables in `initDb`:

1. Add the column in the `CREATE TABLE IF NOT EXISTS` statement (for fresh DBs)
2. Add an idempotent migration block wrapped in `try/catch` for existing DBs — SQLite raises an error if the column already exists, and the catch silently swallows it:

```js
try {
  db.exec('ALTER TABLE observations ADD COLUMN my_col TEXT');
} catch (_) {
  // Column already exists — fine
}
```

See the existing migration blocks in `initDb` (e.g. `event_id`, `deleted_at`, `entity_type`) for the canonical pattern. Do **not** use `PRAGMA table_info()` gates — the `try/catch` approach is simpler and already established throughout this file.

## Testing

- Tests live in `test/server.test.js`
- Import functions directly from `../server.js` — no mocking of the module itself
- Each test creates an isolated DB: `initDb(path.join(tmpDir, 'test.db'))` in a `before()` hook
- Test both happy path and error/edge paths (tombstoned entities, missing IDs, empty arrays, limit=0, malformed input)
- Run: `node --test test/server.test.js`

## Git discipline

- One logical change per commit
- Commit messages: `type: description` (feat, fix, test, perf, chore, docs, refactor)
- Update `README.md` when adding new tools or changing tool behavior visible to consumers
- Update `.env.example` when adding new env vars
