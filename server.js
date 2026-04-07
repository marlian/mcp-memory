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

function resolveProjectPath(project) {
  if (path.isAbsolute(project)) return project;
  return path.join(os.homedir(), project);
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

  const info = db.prepare(
    'INSERT INTO observations (entity_id, content, source, confidence, event_id) VALUES (?, ?, ?, ?, ?)'
  ).run(entityId, content, source, confidence, eventId);

  // Sync FTS
  const entity = db.prepare('SELECT name, entity_type FROM entities WHERE id = ?').get(entityId);
  if (entity) {
    db.prepare(
      'INSERT INTO memory_fts (rowid, entity_name, observation_content, entity_type) VALUES (?, ?, ?, ?)'
    ).run(info.lastInsertRowid, entity.name, content, entity.entity_type || '');
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
        entity: { type: 'string', description: 'Entity name (e.g. "Alice", "ProjectX", "React")' },
        entity_type: { type: 'string', description: 'Optional type (e.g. "person", "project", "technology")' },
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
        relation_type: { type: 'string', description: 'Relation type (e.g. "works_with", "uses", "depends_on")' },
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
        entity_type: { type: 'string', description: 'Filter by type (e.g. "person", "project")' },
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
        label: { type: 'string', description: 'Event label (e.g. "Weekly standup", "Architecture decision", "Debugging session")' },
        event_date: { type: 'string', description: 'When the event happened (ISO8601 date or datetime, e.g. "2025-04-01")' },
        event_type: { type: 'string', description: 'Event type (e.g. "meeting", "decision", "review", "session")' },
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
        event_type: { type: 'string', description: 'Filter by event type (e.g. "meeting", "decision")' },
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
      if (args.observation_id) {
        // Delete FTS entry first
        db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(args.observation_id);
        const info = db.prepare('DELETE FROM observations WHERE id = ?').run(args.observation_id);
        return { deleted: info.changes > 0, type: 'observation', id: args.observation_id };
      }
      if (args.entity) {
        const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get(args.entity);
        if (!entity) return { deleted: false, message: `Entity "${args.entity}" not found` };
        // Delete FTS entries for all observations of this entity
        const obsIds = db.prepare('SELECT id FROM observations WHERE entity_id = ?').all(entity.id);
        for (const o of obsIds) {
          db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(o.id);
        }
        db.prepare('DELETE FROM entities WHERE id = ?').run(entity.id);
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
  const db = initDb(DB_PATH);

  const server = new Server(
    { name: 'memory', version: '0.3.0' },
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
