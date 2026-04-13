# Telemetry

> Opt-in usage analytics for mcp-memory. Zero overhead when disabled.

## Enabling

Set `MEMORY_TELEMETRY_PATH` to a file path. The telemetry database is created lazily on first tool call.

**Via `.env`:**
```bash
MEMORY_TELEMETRY_PATH=./telemetry.db
```

**Via client config:**
```json
{
  "env": {
    "MEMORY_TELEMETRY_PATH": "/absolute/path/to/telemetry.db"
  }
}
```

When `MEMORY_TELEMETRY_PATH` is not set (the default), every telemetry function is a no-op — no timing, no logging, no database opened.

## What it logs

### Tool calls (`tool_calls` table)

Every MCP tool invocation is logged with:

| Column | Example |
|--------|---------|
| `ts` | `2026-04-13T20:15:32.456` |
| `tool` | `recall`, `remember`, `forget` |
| `client_name` | `kilo`, `claude-code`, `cursor` |
| `client_version` | `0.43.6` |
| `client_source` | `protocol` / `env` / `none` |
| `db_scope` | `global` / `project` |
| `project_path` | `/Users/you/some-repo` or null |
| `duration_ms` | `12.4` |
| `args_summary` | Sanitized JSON (see below) |
| `result_summary` | Counts only, never data |
| `is_error` | `0` or `1` |

### Search ranking metrics (`search_metrics` table)

For `recall` calls, additional metrics capture the ranking pipeline:

| Column | Example |
|--------|---------|
| `query` | The search text |
| `channels` | `{"fts": 12, "fts_phrase": 3, "entity_exact": 1}` |
| `candidates_total` | `16` |
| `results_returned` | `5` |
| `limit_requested` | `20` |
| `score_min` | `0.32` |
| `score_max` | `0.87` |
| `score_median` | `0.61` |
| `compact` | `0` or `1` |

Additional metadata that may be logged:

- Entity names, search queries, and event labels when needed for telemetry records (see [design rationale](#design-rationale))

## What it does NOT log

- Observation content (replaced with `<N chars>`)
- Result data — only counts (entities returned, observations stored, etc.)

## Client identity

The server identifies which client is calling through two mechanisms:

1. **MCP protocol** (primary) — the `initialize` handshake includes `clientInfo` with `name` and `version`. This is a required field in the MCP spec.
2. **Environment fingerprinting** (fallback) — when the protocol doesn't provide client info, the server detects the client from environment variables:

| Client | Signal |
|--------|--------|
| Kilo | `KILO=1` |
| Claude Code | `CLAUDE_CODE_SSE_PORT` |
| Cursor | `CURSOR_TRACE_ID` |
| Windsurf | `WINDSURF_EXTENSION_ID` |
| VS Code Copilot | `VSCODE_MCP_HTTP_PREFER` |

The `client_source` column tells you which mechanism was used: `protocol`, `env`, or `none`.

## Querying the data

The telemetry database is a standard SQLite file. Open it with any tool: `sqlite3`, DBeaver, Jupyter, pandas, etc.

### Example queries

**Tool usage by client:**
```sql
SELECT client_name, tool, COUNT(*) as calls,
       ROUND(AVG(duration_ms), 1) as avg_ms
FROM tool_calls
GROUP BY client_name, tool
ORDER BY calls DESC;
```

**Search ranking quality:**
```sql
SELECT query, candidates_total, results_returned,
       ROUND(score_min, 3) as min, ROUND(score_max, 3) as max,
       channels
FROM search_metrics
ORDER BY candidates_total DESC
LIMIT 20;
```

**Overfetch detection (candidates >> returned):**
```sql
SELECT query, candidates_total, results_returned, limit_requested,
       ROUND(1.0 * results_returned / candidates_total, 2) as yield_ratio
FROM search_metrics
WHERE candidates_total > 0
ORDER BY yield_ratio ASC
LIMIT 20;
```

**Error rate by tool:**
```sql
SELECT tool, COUNT(*) as total,
       SUM(is_error) as errors,
       ROUND(100.0 * SUM(is_error) / COUNT(*), 1) as error_pct
FROM tool_calls
GROUP BY tool
ORDER BY error_pct DESC;
```

**Channel effectiveness:**
```sql
SELECT json_each.key as channel, COUNT(*) as appearances
FROM search_metrics, json_each(search_metrics.channels)
GROUP BY channel
ORDER BY appearances DESC;
```

## Separate database

Telemetry is stored in its own SQLite file, completely separate from the memory database. This means:

- Deleting the telemetry DB has zero impact on your knowledge graph
- The telemetry DB can be wiped and recreated at any time
- No foreign keys or joins between telemetry and memory data
- WAL mode for concurrent reads

## Init failure handling

If the telemetry path is invalid or the database can't be created, the server logs a single warning to stderr and disables telemetry for the rest of the session. It does not retry on every call.

## Design rationale

**Why are queries/entities logged in plaintext?** This is a local, single-user development tool. The telemetry DB lives on your machine, is gitignored, and is only readable by you. Redacting queries and entity names would make the analytics useless — you can't answer "which queries produce too many candidates?" if the query text is hashed.

**Why a separate SQLite and not the memory DB?** Separation of concerns. The memory DB is your knowledge graph — it should only contain entities, observations, and relations. Telemetry is operational data with a completely different lifecycle (wipe freely, aggregate, export).

**Why not an MCP tool?** Telemetry is infrastructure, not a capability the model needs. Adding a tool would cost context tokens on every call for something only the human developer uses. Query the SQLite directly.
