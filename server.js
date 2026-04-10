#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// .env file loader (no deps — process.env always takes precedence)
// ---------------------------------------------------------------------------
// If a .env file exists next to server.js, load it into process.env.
// Values already set in process.env (from the client's MCP "env" block or
// the shell) are never overwritten. The file is optional; missing is not
// an error.
//
// Supported syntax:
//   KEY=value                           # simple assignment
//   KEY="value with spaces"             # double quotes
//   KEY='value with spaces'             # single quotes
//   KEY=value # trailing comment        # inline comment (unquoted only)
//   KEY="value # literal hash"          # hash is literal inside quotes
//   export KEY=value                    # bash-style export prefix (allowed)
//   # full-line comment
//   KEY=                                # empty string (POSIX: var exists)
//
// NOT supported (use process.env instead if you need them):
//   - Variable interpolation (${OTHER})
//   - Multi-line values (continuation or heredoc)
//   - Escape sequences inside quotes (\n, \t, ...)
//
// Lines that don't match KEY=VALUE shape are skipped silently.

// parseDotEnv is a pure function — takes file content string, returns
// a plain object of parsed key/value pairs. Extracted for testability.
function parseDotEnv(content) {
  const result = {};
  // Strip UTF-8 BOM if present (some Windows editors add it by default).
  // Without this, the first key name would silently contain an invisible
  // \uFEFF prefix and never match what the user expects.
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  // Split on LF; this handles CRLF too because we strip \r below.
  const lines = content.split('\n');
  for (let rawLine of lines) {
    // Strip trailing \r (CRLF handling)
    if (rawLine.endsWith('\r')) rawLine = rawLine.slice(0, -1);
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    // Allow optional 'export ' prefix (bash-compatible)
    const stripped = line.startsWith('export ') ? line.slice(7).trimStart() : line;

    const eq = stripped.indexOf('=');
    if (eq === -1) continue;

    const key = stripped.slice(0, eq).trim();
    if (!key) continue;
    // Key must be a valid env var identifier
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let rest = stripped.slice(eq + 1);
    // Drop leading whitespace but not trailing yet (depends on quoting)
    rest = rest.replace(/^[ \t]+/, '');

    let value;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      // Quoted value: find the matching closing quote. Everything between
      // the quotes is literal (no escape processing, no interpolation).
      const quote = rest[0];
      const closeIdx = rest.indexOf(quote, 1);
      if (closeIdx === -1) {
        // Unterminated quote — skip the whole line
        continue;
      }
      value = rest.slice(1, closeIdx);
      // Anything after the closing quote (other than whitespace or a
      // trailing comment) is ignored.
    } else {
      // Unquoted: strip inline comment (first unescaped #), then trim.
      // We treat any # preceded by whitespace as a comment start.
      const hashIdx = rest.search(/\s#/);
      if (hashIdx !== -1) {
        value = rest.slice(0, hashIdx);
      } else {
        value = rest;
      }
      value = value.replace(/[ \t]+$/, '');
    }

    result[key] = value;
  }
  return result;
}

function loadDotEnv(envPath) {
  if (!envPath) envPath = path.join(__dirname, '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    console.error(`[mcp-memory] warning: cannot read .env: ${err.message}. Ignoring.`);
    return;
  }
  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    // process.env always wins — only fill in values not already set
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadDotEnv();

// ---------------------------------------------------------------------------
// Tool description examples (optional override via examples.json)
// ---------------------------------------------------------------------------
// Tool descriptions include example values to guide the model. Defaults below
// are intentionally generic. To tailor them to a specific deployment (e.g.
// your team's jargon, a personal knowledge base), create an examples.json
// next to server.js with any of the keys below. Unknown keys are ignored,
// missing keys fall back to the default.
const DEFAULT_EXAMPLES = {
  entities: ['Alice', 'ProjectX', 'React'],
  entity_types: ['person', 'project', 'technology'],
  relations: ['works_with', 'uses', 'depends_on'],
  event_labels: ['Weekly standup', 'Architecture decision', 'Debugging session'],
  event_types: ['meeting', 'decision', 'review', 'session'],
};

// Deep copy of DEFAULT_EXAMPLES so callers can mutate the returned object
// without corrupting the module-level defaults. structuredClone is native
// in Node >=17 (we require >=18 in package.json).
function cloneDefaults() {
  return structuredClone(DEFAULT_EXAMPLES);
}

function loadExamples(examplesPath) {
  if (!examplesPath) examplesPath = path.join(__dirname, 'examples.json');
  let raw;
  try {
    raw = fs.readFileSync(examplesPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return cloneDefaults();
    console.error(`[mcp-memory] warning: cannot read examples.json: ${err.message}. Using defaults.`);
    return cloneDefaults();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[mcp-memory] warning: invalid JSON in examples.json: ${err.message}. Using defaults.`);
    return cloneDefaults();
  }
  // Guard against valid JSON with the wrong top-level shape: null,
  // arrays, or primitives would crash the merge loop below (e.g.
  // null.entities throws TypeError). examples.json is documented as
  // optional, so a shape error must never abort startup.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[mcp-memory] warning: examples.json must contain a JSON object at the top level. Using defaults.');
    return cloneDefaults();
  }
  const merged = cloneDefaults();
  for (const key of Object.keys(DEFAULT_EXAMPLES)) {
    if (Array.isArray(parsed[key]) && parsed[key].length > 0) {
      // Defensive: copy the user's array so later mutation of the
      // returned object doesn't leak back into parsed state.
      merged[key] = [...parsed[key]];
    }
  }
  return merged;
}

const EXAMPLES = loadExamples();

// Format an array of strings as a comma-separated, quoted list for embedding
// in tool description strings. ['a', 'b'] -> '"a", "b"'
function exFmt(arr) {
  return arr.map(v => `"${v}"`).join(', ');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DB_PATH = process.env.MEMORY_DB_PATH
  || path.join(__dirname, 'memory.db');

const MEMORY_HALF_LIFE_WEEKS = parseFloat(process.env.MEMORY_HALF_LIFE_WEEKS || '12');
const PROJECT_MEMORY_HALF_LIFE_WEEKS = parseFloat(process.env.PROJECT_MEMORY_HALF_LIFE_WEEKS || '52');

// ---------------------------------------------------------------------------
// Multi-tenant project memory
// ---------------------------------------------------------------------------
const projectDbs = new Map();

// Resolve a project path to an absolute filesystem path. Accepts:
//   - Absolute paths:     "/abs/path/to/repo" -> unchanged
//   - Tilde-prefixed:     "~/repo"            -> "<home>/repo"
//   - Bare tilde:         "~"                 -> "<home>"
//   - Relative to home:   "repo"              -> "<home>/repo"
// The tilde cases matter because some clients pass "~/project" literally
// and path.join(home, "~/project") would produce "<home>/~/project" —
// a literal tilde directory, which is a classic footgun.
//
// `homedir` is a parameter (not a hardcoded os.homedir() call) so the
// pure function can be unit-tested with synthetic homes.
function resolveProjectPath(project, homedir) {
  if (!homedir) homedir = os.homedir();
  if (path.isAbsolute(project)) return project;
  if (project === '~') return homedir;
  if (project.startsWith('~/') || project.startsWith('~\\')) {
    return path.join(homedir, project.slice(2));
  }
  return path.join(homedir, project);
}

function getDb(defaultDb, project) {
  if (!project) return defaultDb;

  const resolved = resolveProjectPath(project);
  if (projectDbs.has(resolved)) return projectDbs.get(resolved);

  const dbDir = path.join(resolved, '.memory');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'memory.db');
  const db = initDb(dbPath);
  projectDbs.set(resolved, db);
  return db;
}

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------
function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      entity_type TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS observations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content        TEXT NOT NULL,
      source         TEXT DEFAULT 'user',
      confidence     REAL DEFAULT 1.0,
      access_count   INTEGER DEFAULT 0,
      last_accessed  TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS relations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type   TEXT NOT NULL,
      context         TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(from_entity_id, to_entity_id, relation_type)
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL,
      event_date  TEXT,
      event_type  TEXT,
      context     TEXT,
      expires_at  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_obs_entity    ON observations(entity_id);
    CREATE INDEX IF NOT EXISTS idx_obs_content    ON observations(content);
    CREATE INDEX IF NOT EXISTS idx_rel_from       ON relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_rel_to         ON relations(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entities_type  ON entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_events_date    ON events(event_date);
    CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_label   ON events(label);
  `);

  // Migration: add event_id to observations (safe for existing DBs)
  try {
    db.exec('ALTER TABLE observations ADD COLUMN event_id INTEGER REFERENCES events(id)');
  } catch (_) {
    // Column already exists — fine
  }
  // Migration: denormalize entity_type into observations so FTS5 delete can
  // always use the exact value that was originally indexed (entity_type on the
  // entities row may be updated later by upsertEntity, causing mismatches).
  try {
    db.exec('ALTER TABLE observations ADD COLUMN entity_type TEXT');
  } catch (_) {
    // Column already exists — fine
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_obs_event ON observations(event_id)');
  } catch (_) {
    // Index already exists — fine
  }

  // FTS5 virtual table — contentless, synced manually
  try {
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        entity_name,
        observation_content,
        entity_type,
        content=''
      );
    `);
  } catch (_) {
    // Already exists — fine
  }

  return db;
}

// ---------------------------------------------------------------------------
// Decay calculation (read-time, no cron needed)
// ---------------------------------------------------------------------------
function decayedConfidence(obs, halfLifeWeeks) {
  if (!obs.created_at) return obs.confidence;
  const hl = halfLifeWeeks || MEMORY_HALF_LIFE_WEEKS;
  const ageMs = Date.now() - new Date(obs.created_at + 'Z').getTime();
  const ageWeeks = ageMs / (7 * 24 * 60 * 60 * 1000);
  const stability = hl * (1 + Math.log2((obs.access_count || 0) + 1));
  return obs.confidence * Math.pow(0.5, ageWeeks / stability);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
function upsertEntity(db, name, entityType) {
  const existing = db.prepare('SELECT id, entity_type FROM entities WHERE name = ?').get(name);
  if (existing) {
    if (entityType && entityType !== existing.entity_type) {
      db.prepare('UPDATE entities SET entity_type = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(entityType, existing.id);
    }
    return existing.id;
  }
  const info = db.prepare('INSERT INTO entities (name, entity_type) VALUES (?, ?)').run(name, entityType || null);
  return info.lastInsertRowid;
}

function addObservation(db, entityId, content, source = 'user', confidence = 1.0, eventId = null) {
  // Smart append — skip exact duplicates
  const dupe = db.prepare(
    'SELECT id FROM observations WHERE entity_id = ? AND content = ?'
  ).get(entityId, content);
  if (dupe) return dupe.id;

  // Snapshot entity_type now so the FTS index and the observations row always
  // hold the same value (upsertEntity can change entities.entity_type later).
  const entity = db.prepare('SELECT name, entity_type FROM entities WHERE id = ?').get(entityId);
  const entityType = entity ? (entity.entity_type || '') : '';

  const info = db.prepare(
    'INSERT INTO observations (entity_id, content, source, confidence, event_id, entity_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(entityId, content, source, confidence, eventId, entityType);

  // Sync FTS — use the same entity_type snapshot stored on the observation row
  if (entity) {
    db.prepare(
      'INSERT INTO memory_fts (rowid, entity_name, observation_content, entity_type) VALUES (?, ?, ?, ?)'
    ).run(info.lastInsertRowid, entity.name, content, entityType);
  }

  return info.lastInsertRowid;
}

function touchObservations(db, observationIds) {
  if (!observationIds.length) return;
  const stmt = db.prepare(
    'UPDATE observations SET access_count = access_count + 1, last_accessed = datetime(\'now\') WHERE id = ?'
  );
  for (const id of observationIds) {
    stmt.run(id);
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------
function createEvent(db, label, eventDate, eventType, context, expiresAt) {
  const info = db.prepare(
    'INSERT INTO events (label, event_date, event_type, context, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(label, eventDate || null, eventType || null, context || null, expiresAt || null);
  return info.lastInsertRowid;
}

function searchEvents(db, query, opts = {}) {
  const { event_type, date_from, date_to, limit = 20 } = opts;
  let sql = 'SELECT e.*, COUNT(o.id) AS observation_count FROM events e LEFT JOIN observations o ON o.event_id = e.id WHERE 1=1';
  const params = [];

  if (query) {
    sql += ' AND e.label LIKE ?';
    params.push(`%${query}%`);
  }
  if (event_type) {
    sql += ' AND e.event_type = ?';
    params.push(event_type);
  }
  if (date_from) {
    sql += ' AND e.event_date >= ?';
    params.push(date_from);
  }
  if (date_to) {
    sql += ' AND e.event_date <= ?';
    params.push(date_to);
  }

  // Exclude expired events unless they have no expiry
  sql += ' AND (e.expires_at IS NULL OR e.expires_at > datetime(\'now\'))';

  sql += ' GROUP BY e.id ORDER BY e.event_date DESC, e.created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function getFullEvent(db, eventId, halfLifeWeeks = null) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return null;

  const observations = db.prepare(`
    SELECT o.*, e.name AS entity_name, e.entity_type
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE o.event_id = ?
    ORDER BY o.created_at ASC
  `).all(eventId);

  // Touch accessed observations
  touchObservations(db, observations.map(o => o.id));

  // Group by entity
  const grouped = {};
  for (const obs of observations) {
    if (!grouped[obs.entity_name]) {
      grouped[obs.entity_name] = {
        entity_name: obs.entity_name,
        entity_type: obs.entity_type,
        observations: [],
      };
    }
    grouped[obs.entity_name].observations.push({
      id: obs.id,
      content: obs.content,
      confidence: decayedConfidence(obs, halfLifeWeeks),
      source: obs.source,
      access_count: obs.access_count,
      created_at: obs.created_at,
    });
  }

  return {
    event,
    entities: Object.values(grouped),
    total_observations: observations.length,
  };
}

// ---------------------------------------------------------------------------
// Search (enhanced with event info)
// ---------------------------------------------------------------------------
function searchMemory(db, query, limit = 20, halfLifeWeeks = null) {
  // Strategy: FTS (OR terms) first, then entity name + content LIKE, deduplicate
  const obsIds = [];

  // 1. FTS5 — split query into words, OR them for broader matching
  try {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const ftsQuery = terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const ftsResults = db.prepare(`
      SELECT rowid, rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(ftsQuery, limit);
    for (const r of ftsResults) obsIds.push(r.rowid);
  } catch (_) {
    // FTS can fail on odd queries — fall through to LIKE
  }

  // 2. Entity name match
  const entityMatches = db.prepare(`
    SELECT o.id FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE e.name LIKE ? OR e.name LIKE ?
    LIMIT ?
  `).all(`%${query}%`, query, limit);

  for (const em of entityMatches) {
    if (!obsIds.includes(em.id)) obsIds.push(em.id);
  }

  // 3. Content LIKE fallback — catches natural language queries FTS misses
  if (obsIds.length < limit) {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const likeResults = db.prepare(`
        SELECT o.id FROM observations o
        JOIN entities e ON o.entity_id = e.id
        WHERE o.content LIKE ? OR e.entity_type LIKE ?
        LIMIT ?
      `).all(`%${term}%`, `%${term}%`, limit);
      for (const r of likeResults) {
        if (!obsIds.includes(r.id)) obsIds.push(r.id);
      }
    }
  }

  // 4. Event label match — also find observations via their event
  if (obsIds.length < limit) {
    const eventMatches = db.prepare(`
      SELECT o.id FROM observations o
      JOIN events ev ON o.event_id = ev.id
      WHERE ev.label LIKE ?
      LIMIT ?
    `).all(`%${query}%`, limit);
    for (const r of eventMatches) {
      if (!obsIds.includes(r.id)) obsIds.push(r.id);
    }
  }

  if (!obsIds.length) return [];

  const placeholders = obsIds.map(() => '?').join(',');
  const observations = db.prepare(`
    SELECT o.*, e.name AS entity_name, e.entity_type,
           ev.id AS event_id, ev.label AS event_label, ev.event_date, ev.event_type AS ev_type
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    LEFT JOIN events ev ON o.event_id = ev.id
    WHERE o.id IN (${placeholders})
  `).all(...obsIds);

  // Touch accessed observations
  touchObservations(db, obsIds);

  // Apply decay, sort by effective confidence
  return observations
    .map(obs => ({
      ...obs,
      effective_confidence: decayedConfidence(obs, halfLifeWeeks),
    }))
    .sort((a, b) => b.effective_confidence - a.effective_confidence);
}

function getEntityGraph(db, entityName, halfLifeWeeks = null) {
  const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(entityName);
  if (!entity) return null;

  const observations = db.prepare(`
    SELECT o.*, ev.id AS event_id, ev.label AS event_label, ev.event_date, ev.event_type AS ev_type
    FROM observations o
    LEFT JOIN events ev ON o.event_id = ev.id
    WHERE o.entity_id = ?
    ORDER BY o.created_at DESC
  `).all(entity.id);

  const relationsFrom = db.prepare(`
    SELECT r.*, e.name AS target_name, e.entity_type AS target_type
    FROM relations r JOIN entities e ON r.to_entity_id = e.id
    WHERE r.from_entity_id = ?
  `).all(entity.id);

  const relationsTo = db.prepare(`
    SELECT r.*, e.name AS source_name, e.entity_type AS source_type
    FROM relations r JOIN entities e ON r.from_entity_id = e.id
    WHERE r.to_entity_id = ?
  `).all(entity.id);

  // Touch observations
  touchObservations(db, observations.map(o => o.id));

  return {
    entity,
    observations: observations.map(o => ({
      ...o,
      effective_confidence: decayedConfidence(o, halfLifeWeeks),
    })),
    relations_outgoing: relationsFrom,
    relations_incoming: relationsTo,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'remember',
    description: 'Store a fact about an entity. Creates the entity if it does not exist, appends observation if it does. Use this proactively whenever you learn something worth retaining across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: `Entity name (e.g. ${exFmt(EXAMPLES.entities)})` },
        entity_type: { type: 'string', description: `Optional type (e.g. ${exFmt(EXAMPLES.entity_types)})` },
        observation: { type: 'string', description: 'The fact to remember — one atomic piece of information' },
        source: { type: 'string', enum: ['user', 'inferred', 'session'], description: 'Where this fact comes from (default: user)' },
        confidence: { type: 'number', description: 'Confidence 0.0-1.0 (default: 1.0 for user-stated facts)' },
        event_id: { type: 'number', description: 'Optional event ID to attach this observation to (from remember_event)' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['entity', 'observation'],
    },
  },
  {
    name: 'remember_batch',
    description: 'Store multiple facts at once. Each item creates/updates an entity and appends an observation.',
    inputSchema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entity: { type: 'string' },
              entity_type: { type: 'string' },
              observation: { type: 'string' },
              source: { type: 'string' },
              confidence: { type: 'number' },
              event_id: { type: 'number', description: 'Optional event ID to attach this observation to' },
            },
            required: ['entity', 'observation'],
          },
          description: 'Array of facts to store',
        },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['facts'],
    },
  },
  {
    name: 'recall',
    description: 'Search memory for facts matching a query. Returns entities with their observations, sorted by relevance and confidence. Updates access counts (frequently recalled facts resist decay).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recall_entity',
    description: 'Get everything known about a specific entity: all observations, all relations. Use when you know the exact entity name.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Exact entity name' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'relate',
    description: 'Create a relation between two entities. Creates entities if they do not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source entity name' },
        to: { type: 'string', description: 'Target entity name' },
        relation_type: { type: 'string', description: `Relation type (e.g. ${exFmt(EXAMPLES.relations)})` },
        context: { type: 'string', description: 'Optional context for the relation' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['from', 'to', 'relation_type'],
    },
  },
  {
    name: 'forget',
    description: 'Remove a specific observation by ID, or an entire entity by name (cascading all observations and relations).',
    inputSchema: {
      type: 'object',
      properties: {
        observation_id: { type: 'number', description: 'Specific observation ID to remove' },
        entity: { type: 'string', description: 'Entity name to remove entirely (cascades)' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
    },
  },
  {
    name: 'list_entities',
    description: 'List all known entities, optionally filtered by type. Useful for orientation at session start.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: `Filter by type (e.g. ${exFmt(EXAMPLES.entity_types.slice(0, 2))})` },
        limit: { type: 'number', description: 'Max results (default 50)' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
    },
  },
  // --- Event tools ---
  {
    name: 'remember_event',
    description: 'Create an event (a session, meeting, decision, etc.) and optionally attach observations to it in one call. Events group related observations across entities so they can be recalled as a coherent block.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: `Event label (e.g. ${exFmt(EXAMPLES.event_labels)})` },
        event_date: { type: 'string', description: 'When the event happened (ISO8601 date or datetime, e.g. "2025-04-01")' },
        event_type: { type: 'string', description: `Event type (e.g. ${exFmt(EXAMPLES.event_types)})` },
        context: { type: 'string', description: 'Optional free-form context about the event' },
        expires_at: { type: 'string', description: 'Optional expiry datetime (ISO8601). Event auto-hides after this time.' },
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entity: { type: 'string' },
              entity_type: { type: 'string' },
              observation: { type: 'string' },
              source: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['entity', 'observation'],
          },
          description: 'Optional array of observations to create and attach to this event',
        },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['label'],
    },
  },
  {
    name: 'recall_events',
    description: 'Search events by label, type, or date range. Returns events with observation counts. Use this to find sessions, meetings, or other grouped memory blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search on event labels' },
        event_type: { type: 'string', description: `Filter by event type (e.g. ${exFmt(EXAMPLES.event_types.slice(0, 2))})` },
        date_from: { type: 'string', description: 'Start date filter (ISO8601)' },
        date_to: { type: 'string', description: 'End date filter (ISO8601)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
    },
  },
  {
    name: 'recall_event',
    description: 'Get a specific event with all its observations grouped by entity. Use when you have an event ID from recall_events or remember_event.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'number', description: 'Event ID to retrieve' },
        project: { type: 'string', description: 'Project workspace path for project-scoped memory (absolute or relative to ~). Omit for global memory.' },
      },
      required: ['event_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
function handleTool(defaultDb, name, args) {
  const db = getDb(defaultDb, args.project);
  const halfLife = args.project ? PROJECT_MEMORY_HALF_LIFE_WEEKS : MEMORY_HALF_LIFE_WEEKS;

  switch (name) {

    case 'remember': {
      const entityId = upsertEntity(db, args.entity, args.entity_type);
      const obsId = addObservation(db, entityId, args.observation, args.source, args.confidence, args.event_id || null);
      return { stored: true, entity_id: entityId, observation_id: obsId, event_id: args.event_id || null, project: args.project || null };
    }

    case 'remember_batch': {
      const results = [];
      const tx = db.transaction(() => {
        for (const fact of args.facts) {
          const entityId = upsertEntity(db, fact.entity, fact.entity_type);
          const obsId = addObservation(db, entityId, fact.observation, fact.source, fact.confidence, fact.event_id || null);
          results.push({ entity: fact.entity, entity_id: entityId, observation_id: obsId, event_id: fact.event_id || null });
        }
      });
      tx();
      return { stored: results.length, facts: results, project: args.project || null };
    }

    case 'recall': {
      const results = searchMemory(db, args.query, args.limit || 20, halfLife);
      // Group by entity for cleaner output
      const grouped = {};
      for (const r of results) {
        if (!grouped[r.entity_name]) {
          grouped[r.entity_name] = {
            entity_name: r.entity_name,
            entity_type: r.entity_type,
            observations: [],
          };
        }
        const obs = {
          id: r.id,
          content: r.content,
          confidence: r.effective_confidence,
          source: r.source,
          access_count: r.access_count,
          created_at: r.created_at,
        };
        // Include event info when present
        if (r.event_id) {
          obs.event_id = r.event_id;
          obs.event_label = r.event_label;
          obs.event_date = r.event_date;
        }
        grouped[r.entity_name].observations.push(obs);
      }
      const response = { results: Object.values(grouped), total_facts: results.length };
      if (results.length === 0) {
        response.hint = 'No results found. Try list_entities to browse available entities, or use broader search terms.';
      }
      return response;
    }

    case 'recall_entity': {
      const graph = getEntityGraph(db, args.entity, halfLife);
      if (!graph) {
        return {
          found: false,
          message: `Entity "${args.entity}" not found`,
          hint: 'Use list_entities to browse available entities, or recall with a broader search query.',
        };
      }
      return { found: true, ...graph };
    }

    case 'relate': {
      const fromId = upsertEntity(db, args.from);
      const toId = upsertEntity(db, args.to);
      try {
        db.prepare(
          'INSERT INTO relations (from_entity_id, to_entity_id, relation_type, context) VALUES (?, ?, ?, ?)'
        ).run(fromId, toId, args.relation_type, args.context || null);
        return { created: true, from: args.from, to: args.to, relation_type: args.relation_type };
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { created: false, message: 'Relation already exists' };
        }
        throw err;
      }
    }

    case 'forget': {
      // Prepared once and shared across both paths
      const ftsDelete = db.prepare(
        'INSERT INTO memory_fts(memory_fts, rowid, entity_name, observation_content, entity_type) VALUES(\'delete\', ?, ?, ?, ?)'
      );

      if (args.observation_id) {
        const result = db.transaction(() => {
          // Fetch the observation's own entity_type snapshot (the exact value
          // that was indexed into memory_fts at insert time) to drive the FTS5
          // special delete.  Reading e.entity_type here would be wrong because
          // upsertEntity can change it after the FTS entry was written.
          const obs = db.prepare(
            'SELECT o.content, o.entity_type, e.name AS entity_name FROM observations o JOIN entities e ON e.id = o.entity_id WHERE o.id = ?'
          ).get(args.observation_id);
          if (obs) {
            // Contentless FTS5 tables don't support DELETE; use the special delete command instead
            ftsDelete.run(args.observation_id, obs.entity_name, obs.content, obs.entity_type || '');
          }
          const info = db.prepare('DELETE FROM observations WHERE id = ?').run(args.observation_id);
          return { deleted: info.changes > 0, type: 'observation', id: args.observation_id };
        })();
        return result;
      }
      if (args.entity) {
        const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(args.entity);
        if (!entity) return { deleted: false, message: `Entity "${args.entity}" not found` };
        db.transaction(() => {
          // Read entity_type from the observation row (the indexed snapshot), not
          // from entities, to guarantee the FTS5 delete matches what was indexed.
          const observations = db.prepare(
            'SELECT o.id, o.content, o.entity_type, e.name AS entity_name FROM observations o JOIN entities e ON e.id = o.entity_id WHERE o.entity_id = ?'
          ).all(entity.id);
          for (const o of observations) {
            ftsDelete.run(o.id, o.entity_name, o.content, o.entity_type || '');
          }
          db.prepare('DELETE FROM entities WHERE id = ?').run(entity.id);
        })();
        return { deleted: true, type: 'entity', name: args.entity };
      }
      return { deleted: false, message: 'Provide observation_id or entity name' };
    }

    case 'list_entities': {
      const limit = args.limit || 50;
      let rows;
      if (args.entity_type) {
        rows = db.prepare(`
          SELECT e.*, COUNT(o.id) AS observation_count
          FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
          WHERE e.entity_type = ?
          GROUP BY e.id ORDER BY e.updated_at DESC LIMIT ?
        `).all(args.entity_type, limit);
      } else {
        rows = db.prepare(`
          SELECT e.*, COUNT(o.id) AS observation_count
          FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
          GROUP BY e.id ORDER BY e.updated_at DESC LIMIT ?
        `).all(limit);
      }
      return { entities: rows, total: rows.length };
    }

    // --- Event handlers ---

    case 'remember_event': {
      const eventId = createEvent(db, args.label, args.event_date, args.event_type, args.context, args.expires_at);
      const obsResults = [];
      if (args.observations && args.observations.length) {
        const tx = db.transaction(() => {
          for (const fact of args.observations) {
            const entityId = upsertEntity(db, fact.entity, fact.entity_type);
            const obsId = addObservation(db, entityId, fact.observation, fact.source, fact.confidence, eventId);
            obsResults.push({ entity: fact.entity, entity_id: entityId, observation_id: obsId });
          }
        });
        tx();
      }
      return {
        created: true,
        event_id: eventId,
        label: args.label,
        event_date: args.event_date || null,
        event_type: args.event_type || null,
        observations_attached: obsResults.length,
        observations: obsResults,
        project: args.project || null,
      };
    }

    case 'recall_events': {
      const events = searchEvents(db, args.query, {
        event_type: args.event_type,
        date_from: args.date_from,
        date_to: args.date_to,
        limit: args.limit || 20,
      });
      return {
        events,
        total: events.length,
        hint: events.length ? 'Use recall_event with an event_id to get the full observation block.' : 'No events found. Try broader search terms or different date range.',
      };
    }

    case 'recall_event': {
      const result = getFullEvent(db, args.event_id, halfLife);
      if (!result) {
        return { found: false, message: `Event with id ${args.event_id} not found` };
      }
      return { found: true, ...result };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
async function main() {
  // Self-test mode (for CI)
  if (process.argv.includes('--test')) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-memory-test-'));
    const testDb = initDb(path.join(tmpDir, 'test.db'));
    try {
      // Test remember + recall
      const eid = upsertEntity(testDb, 'TestEntity', 'test');
      addObservation(testDb, eid, 'test observation', 'user', 1.0);
      const results = searchMemory(testDb, 'test', 5, 12);
      if (!results.length) throw new Error('recall returned no results');

      // Test forget by observation_id — must not throw on contentless FTS5 table
      const obsIdToForget = addObservation(testDb, eid, 'observation to forget', 'user', 1.0);
      const forgetObsResult = handleTool(testDb, 'forget', { observation_id: obsIdToForget });
      if (!forgetObsResult.deleted) throw new Error('forget by observation_id did not delete the observation');
      const stillExists = testDb.prepare('SELECT id FROM observations WHERE id = ?').get(obsIdToForget);
      if (stillExists) throw new Error('forget by observation_id: observation still in DB after delete');

      // Test forget by entity — must not throw on contentless FTS5 table
      const eidToForget = upsertEntity(testDb, 'EntityToForget', 'test');
      addObservation(testDb, eidToForget, 'entity observation 1', 'user', 1.0);
      addObservation(testDb, eidToForget, 'entity observation 2', 'user', 1.0);
      const forgetEntityResult = handleTool(testDb, 'forget', { entity: 'EntityToForget' });
      if (!forgetEntityResult.deleted) throw new Error('forget by entity did not delete the entity');
      const entityStillExists = testDb.prepare('SELECT id FROM entities WHERE name = ?').get('EntityToForget');
      if (entityStillExists) throw new Error('forget by entity: entity still in DB after delete');

      // Test that forget uses the original indexed entity_type, not the current one.
      // If entity_type changes after observation insertion the FTS delete must still
      // use the value that was indexed (stored on observations.entity_type).
      const eidChangedType = upsertEntity(testDb, 'TypeChangingEntity', 'original_type');
      const obsChangedType = addObservation(testDb, eidChangedType, 'observation with original type', 'user', 1.0);
      // Mutate entity_type after indexing — simulates upsertEntity being called later
      upsertEntity(testDb, 'TypeChangingEntity', 'updated_type');
      // forget must not throw (stale entity_type in entities must not be used)
      const forgetChangedResult = handleTool(testDb, 'forget', { observation_id: obsChangedType });
      if (!forgetChangedResult.deleted) throw new Error('forget after entity_type change did not delete the observation');
      const obsChangedStillExists = testDb.prepare('SELECT id FROM observations WHERE id = ?').get(obsChangedType);
      if (obsChangedStillExists) throw new Error('forget after entity_type change: observation still in DB');

      // Test relations
      const eid2 = upsertEntity(testDb, 'OtherEntity', 'test');
      testDb.prepare(
        'INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      ).run(eid, eid2, 'depends_on');

      // Test events
      const eventId = createEvent(testDb, 'Test event', null, 'test', null, null);
      addObservation(testDb, eid, 'event observation', 'user', 1.0, eventId);
      const event = getFullEvent(testDb, eventId, 12);
      if (!event) throw new Error('event recall failed');

      // Test decay calculation
      const conf = decayedConfidence({ created_at: new Date().toISOString().replace('Z',''), confidence: 1.0, access_count: 0 }, 12);
      if (typeof conf !== 'number' || conf > 1 || conf < 0) throw new Error('decay returned invalid confidence');

      // Test project DB isolation
      const projDir = path.join(tmpDir, 'fake-project');
      fs.mkdirSync(projDir, { recursive: true });
      const projDb = getDb(testDb, projDir);
      const peid = upsertEntity(projDb, 'ProjectOnly', 'test');
      addObservation(projDb, peid, 'project fact', 'user', 1.0);
      const globalSearch = searchMemory(testDb, 'ProjectOnly', 5, 12);
      if (globalSearch.some(r => r.entity_name === 'ProjectOnly')) throw new Error('project entity leaked to global DB');

      // Test examples system — format helper
      if (exFmt(['a', 'b', 'c']) !== '"a", "b", "c"') throw new Error('exFmt format is wrong');
      if (exFmt([]) !== '') throw new Error('exFmt empty array should yield empty string');
      if (exFmt(['solo']) !== '"solo"') throw new Error('exFmt single value is wrong');

      // Test examples system — EXAMPLES is populated with all required keys
      const requiredKeys = ['entities', 'entity_types', 'relations', 'event_labels', 'event_types'];
      for (const k of requiredKeys) {
        if (!Array.isArray(EXAMPLES[k]) || EXAMPLES[k].length === 0) {
          throw new Error(`EXAMPLES.${k} missing or empty`);
        }
      }

      // Test examples system — tool descriptions actually embed the examples
      const rememberTool = TOOLS.find(t => t.name === 'remember');
      if (!rememberTool) throw new Error('remember tool not found');
      const entityDesc = rememberTool.inputSchema.properties.entity.description;
      if (!entityDesc.includes(EXAMPLES.entities[0])) {
        throw new Error('tool description does not embed current EXAMPLES.entities');
      }

      // Test .env loader — must not throw when file is absent
      // (loadDotEnv was already called at module load; we verify it is idempotent
      // and safe to invoke again with no file present)
      const envBefore = process.env.MEMORY_DB_PATH;
      loadDotEnv();
      if (process.env.MEMORY_DB_PATH !== envBefore) {
        throw new Error('loadDotEnv mutated an already-set env var');
      }

      // Test parseDotEnv — pure function, table-driven test of edge cases
      const parseCases = [
        {
          name: 'simple KEY=value',
          input: 'FOO=bar',
          expect: { FOO: 'bar' },
        },
        {
          name: 'multiple keys',
          input: 'FOO=bar\nBAZ=qux',
          expect: { FOO: 'bar', BAZ: 'qux' },
        },
        {
          name: 'double-quoted value',
          input: 'FOO="hello world"',
          expect: { FOO: 'hello world' },
        },
        {
          name: 'single-quoted value',
          input: "FOO='hello world'",
          expect: { FOO: 'hello world' },
        },
        {
          name: 'inline comment (unquoted)',
          input: 'FOO=bar # this is a comment',
          expect: { FOO: 'bar' },
        },
        {
          name: 'inline comment with no space before hash',
          input: 'FOO=bar #comment',
          expect: { FOO: 'bar' },
        },
        {
          name: 'hash inside double quotes is literal',
          input: 'FOO="value # not a comment"',
          expect: { FOO: 'value # not a comment' },
        },
        {
          name: 'hash inside single quotes is literal',
          input: "FOO='value # not a comment'",
          expect: { FOO: 'value # not a comment' },
        },
        {
          name: 'full-line comment ignored',
          input: '# comment\nFOO=bar',
          expect: { FOO: 'bar' },
        },
        {
          name: 'blank lines ignored',
          input: '\n\nFOO=bar\n\n',
          expect: { FOO: 'bar' },
        },
        {
          name: 'empty value is empty string',
          input: 'FOO=',
          expect: { FOO: '' },
        },
        {
          name: 'export prefix (bash-style)',
          input: 'export FOO=bar',
          expect: { FOO: 'bar' },
        },
        {
          name: 'export prefix with quoted value',
          input: 'export FOO="hello world"',
          expect: { FOO: 'hello world' },
        },
        {
          name: 'CRLF line endings',
          input: 'FOO=bar\r\nBAZ=qux\r\n',
          expect: { FOO: 'bar', BAZ: 'qux' },
        },
        {
          name: 'leading/trailing whitespace on unquoted value',
          input: 'FOO=  bar  ',
          expect: { FOO: 'bar' },
        },
        {
          name: 'whitespace preserved inside double quotes',
          input: 'FOO="  spaced  "',
          expect: { FOO: '  spaced  ' },
        },
        {
          name: 'path-like value with slashes',
          input: 'MEMORY_DB_PATH=/tmp/foo/bar.db',
          expect: { MEMORY_DB_PATH: '/tmp/foo/bar.db' },
        },
        {
          name: 'path-like value with inline comment',
          input: 'MEMORY_DB_PATH=/tmp/foo.db # use tmp for dev',
          expect: { MEMORY_DB_PATH: '/tmp/foo.db' },
        },
        {
          name: 'numeric value',
          input: 'MEMORY_HALF_LIFE_WEEKS=26',
          expect: { MEMORY_HALF_LIFE_WEEKS: '26' },
        },
        {
          name: 'malformed line without equals is skipped',
          input: 'NOT_AN_ASSIGNMENT\nFOO=bar',
          expect: { FOO: 'bar' },
        },
        {
          name: 'key with invalid characters is skipped',
          input: '123FOO=bar\nVALID=ok',
          expect: { VALID: 'ok' },
        },
        {
          name: 'unterminated quote skips line',
          input: 'FOO="unterminated\nBAZ=qux',
          expect: { BAZ: 'qux' },
        },
        {
          name: 'UTF-8 BOM is stripped',
          input: '\uFEFFFOO=bar',
          expect: { FOO: 'bar' },
        },
      ];

      for (const tc of parseCases) {
        const got = parseDotEnv(tc.input);
        const gotKeys = Object.keys(got).sort();
        const expKeys = Object.keys(tc.expect).sort();
        if (gotKeys.length !== expKeys.length || gotKeys.some((k, i) => k !== expKeys[i])) {
          throw new Error(`parseDotEnv "${tc.name}": key mismatch. got ${JSON.stringify(gotKeys)}, expected ${JSON.stringify(expKeys)}`);
        }
        for (const k of expKeys) {
          if (got[k] !== tc.expect[k]) {
            throw new Error(`parseDotEnv "${tc.name}": value mismatch for ${k}. got ${JSON.stringify(got[k])}, expected ${JSON.stringify(tc.expect[k])}`);
          }
        }
      }

      // Test loadDotEnv end-to-end: create a temp .env, load it, verify
      // process.env is populated but existing values are preserved.
      const tmpEnvPath = path.join(tmpDir, 'test.env');
      fs.writeFileSync(tmpEnvPath,
        'MCP_MEMORY_TEST_NEW=new_value\n' +
        'MCP_MEMORY_TEST_EXISTING=from_file\n' +
        '# a comment line\n' +
        'MCP_MEMORY_TEST_COMMENTED=actual_value # trailing\n'
      );
      // Pre-set one var to verify process.env wins
      process.env.MCP_MEMORY_TEST_EXISTING = 'from_process';
      loadDotEnv(tmpEnvPath);
      if (process.env.MCP_MEMORY_TEST_NEW !== 'new_value') {
        throw new Error(`loadDotEnv did not inject new value (got: ${process.env.MCP_MEMORY_TEST_NEW})`);
      }
      if (process.env.MCP_MEMORY_TEST_EXISTING !== 'from_process') {
        throw new Error(`loadDotEnv overwrote existing process.env value (got: ${process.env.MCP_MEMORY_TEST_EXISTING})`);
      }
      if (process.env.MCP_MEMORY_TEST_COMMENTED !== 'actual_value') {
        throw new Error(`loadDotEnv did not strip inline comment (got: ${process.env.MCP_MEMORY_TEST_COMMENTED})`);
      }
      // Cleanup test env vars
      delete process.env.MCP_MEMORY_TEST_NEW;
      delete process.env.MCP_MEMORY_TEST_EXISTING;
      delete process.env.MCP_MEMORY_TEST_COMMENTED;

      // Test loadDotEnv with missing file: must be silent, no throw
      loadDotEnv(path.join(tmpDir, 'does-not-exist.env'));

      // Test resolveProjectPath — pure function, synthetic home.
      // Covers the tilde-literal bug: passing "~/project" used to produce
      // "<home>/~/project" instead of expanding the tilde to home.
      const FAKE_HOME = '/fake-home/testuser';
      const rpCases = [
        { input: '/abs/path',           expected: '/abs/path',                           note: 'absolute path unchanged' },
        { input: '/abs/other/repo',     expected: '/abs/other/repo',                     note: 'another absolute' },
        { input: '~/repo',              expected: '/fake-home/testuser/repo',             note: 'tilde-slash expanded' },
        { input: '~/nested/path',       expected: '/fake-home/testuser/nested/path',      note: 'tilde-slash deep' },
        { input: '~',                   expected: '/fake-home/testuser',                  note: 'bare tilde' },
        { input: 'repo',                expected: '/fake-home/testuser/repo',             note: 'relative treated as home-relative' },
        { input: 'nested/repo',         expected: '/fake-home/testuser/nested/repo',      note: 'relative nested' },
      ];
      for (const tc of rpCases) {
        const got = resolveProjectPath(tc.input, FAKE_HOME);
        if (got !== tc.expected) {
          throw new Error(`resolveProjectPath "${tc.note}": input=${JSON.stringify(tc.input)} expected=${tc.expected} got=${got}`);
        }
      }

      // Test loadExamples — partial override merges with defaults
      const examplesValidPath = path.join(tmpDir, 'examples-valid.json');
      fs.writeFileSync(examplesValidPath, JSON.stringify({
        entities: ['Zebra', 'Unicorn'],
        relations: ['hunts', 'befriends'],
      }));
      const mergedValid = loadExamples(examplesValidPath);
      if (!Array.isArray(mergedValid.entities) || mergedValid.entities[0] !== 'Zebra') {
        throw new Error('loadExamples did not apply custom entities');
      }
      if (!Array.isArray(mergedValid.relations) || mergedValid.relations[0] !== 'hunts') {
        throw new Error('loadExamples did not apply custom relations');
      }
      // Omitted keys must fall back to defaults
      if (!Array.isArray(mergedValid.entity_types) || mergedValid.entity_types[0] !== DEFAULT_EXAMPLES.entity_types[0]) {
        throw new Error('loadExamples did not preserve defaults for omitted keys');
      }
      if (!Array.isArray(mergedValid.event_labels) || mergedValid.event_labels[0] !== DEFAULT_EXAMPLES.event_labels[0]) {
        throw new Error('loadExamples did not preserve defaults for omitted event_labels');
      }

      // Silence console.error during fallback tests (we expect warnings;
      // we just don't want them cluttering test output).
      const origErr = console.error;
      console.error = () => {};

      try {
        // Test loadExamples — invalid JSON must fall back to defaults
        const examplesInvalidPath = path.join(tmpDir, 'examples-invalid.json');
        fs.writeFileSync(examplesInvalidPath, '{ this is not valid json');
        const fb1 = loadExamples(examplesInvalidPath);
        if (fb1.entities[0] !== DEFAULT_EXAMPLES.entities[0]) {
          throw new Error('loadExamples did not fall back on invalid JSON');
        }

        // Test loadExamples — top-level null must NOT crash (was the Risk)
        const examplesNullPath = path.join(tmpDir, 'examples-null.json');
        fs.writeFileSync(examplesNullPath, 'null');
        const fb2 = loadExamples(examplesNullPath);
        if (fb2.entities[0] !== DEFAULT_EXAMPLES.entities[0]) {
          throw new Error('loadExamples did not fall back on top-level null');
        }

        // Test loadExamples — top-level array must fall back cleanly
        const examplesArrayPath = path.join(tmpDir, 'examples-array.json');
        fs.writeFileSync(examplesArrayPath, '["not", "an", "object"]');
        const fb3 = loadExamples(examplesArrayPath);
        if (fb3.entities[0] !== DEFAULT_EXAMPLES.entities[0]) {
          throw new Error('loadExamples did not fall back on top-level array');
        }

        // Test loadExamples — top-level primitive must fall back cleanly
        const examplesPrimPath = path.join(tmpDir, 'examples-prim.json');
        fs.writeFileSync(examplesPrimPath, '42');
        const fb4 = loadExamples(examplesPrimPath);
        if (fb4.entities[0] !== DEFAULT_EXAMPLES.entities[0]) {
          throw new Error('loadExamples did not fall back on top-level primitive');
        }

        // Test loadExamples — missing file returns defaults silently
        const fb5 = loadExamples(path.join(tmpDir, 'does-not-exist.json'));
        if (fb5.entities[0] !== DEFAULT_EXAMPLES.entities[0]) {
          throw new Error('loadExamples did not return defaults on missing file');
        }

        // Test loadExamples — returned defaults must be a fresh copy, not
        // the DEFAULT_EXAMPLES const itself (defensive copy invariant)
        fb5.entities.push('MUTATED');
        if (DEFAULT_EXAMPLES.entities.includes('MUTATED')) {
          throw new Error('loadExamples returned shared reference to DEFAULT_EXAMPLES');
        }
      } finally {
        console.error = origErr;
      }

      console.log('All tests passed');
      testDb.close();
      projDb.close();
      fs.rmSync(tmpDir, { recursive: true });
      process.exit(0);
    } catch (err) {
      console.error('Test failed:', err.message);
      testDb.close();
      fs.rmSync(tmpDir, { recursive: true });
      process.exit(1);
    }
  }

  const db = initDb(DB_PATH);

  const server = new Server(
    { name: 'memory', version: '0.4.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Required arguments per tool (for validation + RetryArguments)
  const REQUIRED_ARGS = {
    remember: ['entity', 'observation'],
    remember_batch: ['facts'],
    recall: ['query'],
    recall_entity: ['entity'],
    relate: ['from', 'to', 'relation_type'],
    forget: [],
    list_entities: [],
    remember_event: ['label'],
    recall_events: [],
    recall_event: ['event_id'],
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Validate tool exists
    if (!REQUIRED_ARGS.hasOwnProperty(name)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: `Unknown tool: ${name}`,
          available_tools: Object.keys(REQUIRED_ARGS),
        }) }],
        isError: true,
      };
    }

    const safeArgs = args && typeof args === 'object' ? args : {};

    // Validate required arguments
    const required = REQUIRED_ARGS[name];
    const missing = required.filter(k => safeArgs[k] === undefined || safeArgs[k] === null);
    if (missing.length > 0) {
      const toolDef = TOOLS.find(t => t.name === name);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: `Missing required arguments: ${missing.join(', ')}`,
          tool: name,
          RetryArguments: Object.fromEntries(
            Object.entries(toolDef.inputSchema.properties).map(([k, v]) => [k, v.description])
          ),
        }) }],
        isError: true,
      };
    }

    // Type-check string args (catches truncated/malformed params)
    for (const key of ['entity', 'observation', 'query', 'from', 'to', 'relation_type', 'project', 'label', 'event_date', 'event_type', 'date_from', 'date_to']) {
      if (safeArgs[key] !== undefined && typeof safeArgs[key] !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `Invalid argument type: '${key}' must be a string, got ${typeof safeArgs[key]}`,
            tool: name,
            received: { [key]: safeArgs[key] },
            RetryArguments: { [key]: `string — ${TOOLS.find(t => t.name === name)?.inputSchema.properties[key]?.description || 'see schema'}` },
          }) }],
          isError: true,
        };
      }
    }

    try {
      const result = handleTool(db, name, safeArgs);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: err.message,
          tool: name,
          hint: 'Check argument types and values. Use list_entities to discover valid entity names.',
        }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown — close default + all project DBs
  const shutdown = () => {
    db.close();
    for (const pdb of projectDbs.values()) pdb.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[memory] Fatal:', err);
  process.exit(1);
});
