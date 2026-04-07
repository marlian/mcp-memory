# mcp-memory

Persistent memory for LLMs via [Model Context Protocol](https://modelcontextprotocol.io). A local SQLite knowledge graph that gives any MCP-compatible AI client long-term memory across sessions.

**Zero infrastructure.** No external database, no API keys, no server to manage. Just a single Node.js process that stores everything locally in SQLite.

## Features

- **Knowledge graph** — entities, observations, and named relations
- **Full-text search** — FTS5-powered recall across all stored facts
- **Cognitive decay** — facts fade over time unless recalled, mimicking human memory. Frequently accessed facts build stability and resist decay
- **Event grouping** — bundle related observations under sessions, meetings, or decisions for coherent recall
- **Project-scoped memory** — one server, many workspaces. Each project gets its own isolated database, created lazily on first use
- **Duplicate detection** — identical observations are silently deduplicated
- **Direct stdio** — wire it straight into your client's JSON config. No wrapper, no proxy

## Quick start

```bash
git clone https://github.com/marlian/mcp-memory.git
cd mcp-memory
npm install
```

Then add it to your AI client's MCP configuration (see below).

## Client configuration

mcp-memory communicates over **stdio** — the client spawns it as a child process. No ports, no HTTP. Just add the server entry to your client's config file.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-memory/server.js"]
    }
  }
}
```

### Claude Code

Add to your project's `.claude/settings.json` or global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-memory/server.js"]
    }
  }
}
```

### VS Code / Cursor

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-memory/server.js"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-memory/server.js"]
    }
  }
}
```

### Any MCP client

The server speaks MCP over stdio. The spawn command is:

```bash
node /absolute/path/to/mcp-memory/server.js
```

No arguments required. Configuration is via environment variables (see below).

## How project-scoped memory works

This is the key architectural feature. A single server instance manages both **global** memory and **per-project** memory through one mechanism: the `project` parameter.

### Without `project` — global memory

```
remember({ entity: "Bob", observation: "prefers dark mode" })
```

Stored in the server's own directory: `<mcp-memory>/memory.db`

This is for cross-project knowledge: user preferences, tool configurations, general facts.

### With `project` — workspace-scoped memory

```
remember({ entity: "API", observation: "rate limit is 100/min", project: "/home/user/my-app" })
```

Stored inside the project: `/home/user/my-app/.memory/memory.db`

The database is **created lazily** — it doesn't exist until the first `remember` call with that project path. After that, all tools called with the same `project` parameter read and write to that project's isolated database.

### The mental model

```
                    ┌─────────────────────────┐
                    │     mcp-memory server    │
                    │    (single process)      │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ memory.db│   │.memory/  │   │.memory/  │
      │ (global) │   │memory.db │   │memory.db │
      └──────────┘   └──────────┘   └──────────┘
       server dir     ~/project-a    ~/project-b
```

- One server process, multiple SQLite databases
- Global DB lives next to `server.js`
- Project DBs live inside each workspace at `.memory/memory.db`
- Each DB is fully independent — its own entities, observations, relations, events
- Databases are opened on first access and cached in memory for the session
- The `project` parameter accepts absolute paths or paths relative to `~`

**Add `.memory/` to your `.gitignore`** — you don't want to commit the database.

### Decay rates

Project memory decays slower than global memory by default, because project knowledge tends to stay relevant longer:

| Scope | Default half-life | Env var |
|-------|------------------|---------|
| Global | 12 weeks | `MEMORY_HALF_LIFE_WEEKS` |
| Project | 52 weeks | `PROJECT_MEMORY_HALF_LIFE_WEEKS` |

## Running multiple instances

You can run separate server instances for different purposes. A common pattern is one for general knowledge and one for private/personal notes:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mcp-memory/server.js"]
    },
    "private_memory": {
      "command": "node",
      "args": ["/path/to/mcp-memory/server.js"],
      "env": {
        "MEMORY_DB_PATH": "/path/to/private/memory.db",
        "MEMORY_HALF_LIFE_WEEKS": "26"
      }
    }
  }
}
```

Each instance maintains its own database. The client sees them as separate tool namespaces (`memory__remember` vs `private_memory__remember`).

## Recommended LLM instructions

For the model to use memory effectively, it needs guidance on _when_ and _how_ to use the tools. Add this to your system prompt, `CLAUDE.md`, `.cursorrules`, or equivalent:

```markdown
## Persistent Memory

You have access to a persistent memory store. Use it proactively:

- **`remember`** — store facts about entities (people, projects, tools, decisions).
  One atomic fact per call.
- **`remember_batch`** — store multiple facts at once
- **`remember_event`** — group related observations under a session, meeting, or
  decision. Create the event first, then attach observations via `event_id`
- **`recall`** — search memory by free text. Costs nothing (local SQLite query).
  Do this liberally when you need context
- **`recall_entity`** — get everything about a specific entity
- **`recall_events`** — find events by label, type, or date range
- **`recall_event`** — get a full event with all its grouped observations
- **`relate`** — link two entities with a named relationship
- **`forget`** — remove stale or incorrect facts
- **`list_entities`** — browse what's in memory

### When to remember

- User preferences and corrections ("no, we use Bun not Node")
- Names, roles, relationships
- Architectural decisions and project conventions
- Recurring patterns worth retaining across sessions
- If the user corrects you, that correction is a fact worth storing

### When to use events

When 3+ related facts belong to the same moment — a meeting, a debugging
session, a decision point. Create the event first with `remember_event`,
then reference its `event_id` in subsequent `remember` calls.

### When NOT to remember

Transient task details, code snippets, anything already in docs or git.
Memory is for knowledge that lives between sessions, not within one.

### Project-scoped memory

Pass the `project` parameter to scope memory to a specific workspace:

    remember({ entity: "API", observation: "Uses REST not gRPC", project: "/path/to/repo" })
    recall({ query: "API design", project: "/path/to/repo" })

The project database is created lazily at `<project>/.memory/memory.db`.
Add `.memory/` to your `.gitignore`.

Use project-scoped memory for architecture decisions, local conventions,
and project-specific knowledge. Use global memory (no `project` param)
for cross-project preferences and general facts.
```

## Cognitive decay

Facts don't live forever. mcp-memory implements a decay model inspired by human memory:

**Base formula:**

```
effective_confidence = confidence * 0.5 ^ (age_weeks / stability)
```

**Stability** grows with access:

```
stability = half_life * (1 + log2(access_count + 1))
```

This means:
- A fact recalled 0 times has stability equal to the half-life (12 weeks by default)
- A fact recalled 3 times has stability of 24 weeks (2x)
- A fact recalled 7 times has stability of 36 weeks (3x)
- Frequently recalled facts resist decay; forgotten facts fade naturally

Decay is computed at **read time** — no background jobs, no cron. The database stores raw confidence and access counts; the effective confidence is calculated when you `recall`.

## Tools reference

| Tool | Required params | Optional params | Description |
|------|----------------|-----------------|-------------|
| `remember` | `entity`, `observation` | `entity_type`, `source`, `confidence`, `event_id`, `project` | Store a fact about an entity |
| `remember_batch` | `facts[]` | `project` | Store multiple facts at once |
| `recall` | `query` | `limit`, `project` | Search memory by free text |
| `recall_entity` | `entity` | `project` | Get everything about an entity |
| `relate` | `from`, `to`, `relation_type` | `context`, `project` | Link two entities |
| `forget` | — | `observation_id`, `entity`, `project` | Remove a fact or entity |
| `list_entities` | — | `entity_type`, `limit`, `project` | Browse stored entities |
| `remember_event` | `label` | `event_date`, `event_type`, `context`, `expires_at`, `observations[]`, `project` | Create an event with optional observations |
| `recall_events` | — | `query`, `event_type`, `date_from`, `date_to`, `limit`, `project` | Search events |
| `recall_event` | `event_id` | `project` | Get full event with all observations |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | `./memory.db` | Path to the global SQLite database |
| `MEMORY_HALF_LIFE_WEEKS` | `12` | Decay half-life for global memory (weeks) |
| `PROJECT_MEMORY_HALF_LIFE_WEEKS` | `52` | Decay half-life for project-scoped memory (weeks) |

## Database

SQLite with WAL mode enabled. The schema is created automatically on first run. Tables:

- **entities** — named things (people, projects, tools, concepts)
- **observations** — atomic facts linked to entities, with confidence and access tracking
- **relations** — directed links between entities (e.g. "Alice works_with Bob")
- **events** — temporal groupings (meetings, sessions, decisions) with optional expiry
- **memory_fts** — FTS5 virtual table for full-text search

No migrations needed — the server handles schema creation and upgrades automatically.

## License

MIT
