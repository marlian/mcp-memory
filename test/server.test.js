'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  initDb,
  upsertEntity,
  addObservation,
  searchMemory,
  handleTool,
  createEvent,
  getFullEvent,
  decayedConfidence,
  getDb,
  exFmt,
  parseDotEnv,
  loadDotEnv,
  resolveProjectPath,
  loadExamples,
  EXAMPLES,
  DEFAULT_EXAMPLES,
  TOOLS,
} = require('../server.js');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
let tmpDir;
let testDb;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-memory-test-'));
  testDb = initDb(path.join(tmpDir, 'test.db'));
});

after(() => {
  testDb.close();
  fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// remember + recall
// ---------------------------------------------------------------------------
describe('remember + recall', () => {
  it('should store and retrieve an entity via searchMemory', () => {
    const eid = upsertEntity(testDb, 'TestEntity', 'test');
    addObservation(testDb, eid, 'test observation', 'user', 1.0);
    const results = searchMemory(testDb, 'test', 5, 12);
    assert.ok(results.length > 0, 'recall returned no results');
  });
});

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------
describe('forget', () => {
  it('should delete by observation_id without FTS5 errors', () => {
    const eid = upsertEntity(testDb, 'ForgetObsEntity', 'test');
    const obsId = addObservation(testDb, eid, 'observation to forget', 'user', 1.0);
    const result = handleTool(testDb, 'forget', { observation_id: obsId });
    assert.ok(result.deleted, 'forget by observation_id did not delete');
    const row = testDb.prepare('SELECT id FROM observations WHERE id = ?').get(obsId);
    assert.equal(row, undefined, 'observation still in DB after delete');
  });

  it('should delete by entity name (cascade)', () => {
    const eid = upsertEntity(testDb, 'EntityToForget', 'test');
    addObservation(testDb, eid, 'entity observation 1', 'user', 1.0);
    addObservation(testDb, eid, 'entity observation 2', 'user', 1.0);
    const result = handleTool(testDb, 'forget', { entity: 'EntityToForget' });
    assert.ok(result.deleted, 'forget by entity did not delete');
    const row = testDb.prepare('SELECT id FROM entities WHERE name = ?').get('EntityToForget');
    assert.equal(row, undefined, 'entity still in DB after delete');
  });

  it('should use original indexed entity_type for FTS delete after type change', () => {
    const eid = upsertEntity(testDb, 'TypeChangingEntity', 'original_type');
    const obsId = addObservation(testDb, eid, 'observation with original type', 'user', 1.0);
    // Mutate entity_type after indexing
    upsertEntity(testDb, 'TypeChangingEntity', 'updated_type');
    // forget must not throw (stale entity_type must not be used)
    const result = handleTool(testDb, 'forget', { observation_id: obsId });
    assert.ok(result.deleted, 'forget after entity_type change did not delete');
    const row = testDb.prepare('SELECT id FROM observations WHERE id = ?').get(obsId);
    assert.equal(row, undefined, 'observation still in DB after type-changed delete');
  });
});

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------
describe('relations', () => {
  it('should insert a relation between two entities', () => {
    const eid1 = upsertEntity(testDb, 'RelFrom', 'test');
    const eid2 = upsertEntity(testDb, 'RelTo', 'test');
    testDb.prepare(
      'INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
    ).run(eid1, eid2, 'depends_on');
    const row = testDb.prepare(
      'SELECT * FROM relations WHERE from_entity_id = ? AND to_entity_id = ?'
    ).get(eid1, eid2);
    assert.ok(row, 'relation not found after insert');
    assert.equal(row.relation_type, 'depends_on');
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------
describe('events', () => {
  it('should create an event and recall it with observations', () => {
    const eid = upsertEntity(testDb, 'EventTestEntity', 'test');
    const eventId = createEvent(testDb, 'Test event', null, 'test', null, null);
    addObservation(testDb, eid, 'event observation', 'user', 1.0, eventId);
    const event = getFullEvent(testDb, eventId, 12);
    assert.ok(event, 'event recall failed');
  });
});

// ---------------------------------------------------------------------------
// decay
// ---------------------------------------------------------------------------
describe('decayedConfidence', () => {
  it('should return a valid confidence number between 0 and 1', () => {
    const conf = decayedConfidence(
      { created_at: new Date().toISOString().replace('Z', ''), confidence: 1.0, access_count: 0 },
      12
    );
    assert.equal(typeof conf, 'number');
    assert.ok(conf >= 0 && conf <= 1, `decay returned out-of-range confidence: ${conf}`);
  });
});

// ---------------------------------------------------------------------------
// project DB isolation
// ---------------------------------------------------------------------------
describe('project DB isolation', () => {
  let projDb;

  before(() => {
    const projDir = path.join(tmpDir, 'fake-project');
    fs.mkdirSync(projDir, { recursive: true });
    projDb = getDb(testDb, projDir);
  });

  after(() => {
    projDb.close();
  });

  it('should not leak project entities into global DB', () => {
    const peid = upsertEntity(projDb, 'ProjectOnly', 'test');
    addObservation(projDb, peid, 'project fact', 'user', 1.0);
    const globalSearch = searchMemory(testDb, 'ProjectOnly', 5, 12);
    const leaked = globalSearch.some(r => r.entity_name === 'ProjectOnly');
    assert.ok(!leaked, 'project entity leaked to global DB');
  });
});

// ---------------------------------------------------------------------------
// exFmt
// ---------------------------------------------------------------------------
describe('exFmt', () => {
  it('should format multiple values as quoted, comma-separated', () => {
    assert.equal(exFmt(['a', 'b', 'c']), '"a", "b", "c"');
  });

  it('should return empty string for empty array', () => {
    assert.equal(exFmt([]), '');
  });

  it('should format single value correctly', () => {
    assert.equal(exFmt(['solo']), '"solo"');
  });
});

// ---------------------------------------------------------------------------
// EXAMPLES system
// ---------------------------------------------------------------------------
describe('EXAMPLES system', () => {
  const requiredKeys = ['entities', 'entity_types', 'relations', 'event_labels', 'event_types'];

  it('should have all required keys populated', () => {
    for (const k of requiredKeys) {
      assert.ok(Array.isArray(EXAMPLES[k]) && EXAMPLES[k].length > 0, `EXAMPLES.${k} missing or empty`);
    }
  });

  it('should embed examples into tool descriptions', () => {
    const rememberTool = TOOLS.find(t => t.name === 'remember');
    assert.ok(rememberTool, 'remember tool not found');
    const entityDesc = rememberTool.inputSchema.properties.entity.description;
    assert.ok(
      entityDesc.includes(EXAMPLES.entities[0]),
      'tool description does not embed current EXAMPLES.entities'
    );
  });
});

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
describe('loadDotEnv', () => {
  it('should not throw when file is absent', () => {
    assert.doesNotThrow(() => loadDotEnv(path.join(tmpDir, 'does-not-exist.env')));
  });

  it('should not mutate already-set env vars', () => {
    const envBefore = process.env.MEMORY_DB_PATH;
    loadDotEnv();
    assert.equal(process.env.MEMORY_DB_PATH, envBefore);
  });

  it('should load new vars, preserve existing, strip comments', () => {
    const tmpEnvPath = path.join(tmpDir, 'test.env');
    const keys = ['MCP_MEMORY_TEST_NEW', 'MCP_MEMORY_TEST_EXISTING', 'MCP_MEMORY_TEST_COMMENTED'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
      fs.writeFileSync(tmpEnvPath,
        'MCP_MEMORY_TEST_NEW=new_value\n' +
        'MCP_MEMORY_TEST_EXISTING=from_file\n' +
        '# a comment line\n' +
        'MCP_MEMORY_TEST_COMMENTED=actual_value # trailing\n'
      );
      process.env.MCP_MEMORY_TEST_EXISTING = 'from_process';
      loadDotEnv(tmpEnvPath);

      assert.equal(process.env.MCP_MEMORY_TEST_NEW, 'new_value');
      assert.equal(process.env.MCP_MEMORY_TEST_EXISTING, 'from_process', 'overwrote existing value');
      assert.equal(process.env.MCP_MEMORY_TEST_COMMENTED, 'actual_value');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseDotEnv (table-driven)
// ---------------------------------------------------------------------------
describe('parseDotEnv', () => {
  const cases = [
    { name: 'simple KEY=value',                         input: 'FOO=bar',                          expect: { FOO: 'bar' } },
    { name: 'multiple keys',                            input: 'FOO=bar\nBAZ=qux',                 expect: { FOO: 'bar', BAZ: 'qux' } },
    { name: 'double-quoted value',                      input: 'FOO="hello world"',                expect: { FOO: 'hello world' } },
    { name: 'single-quoted value',                      input: "FOO='hello world'",                expect: { FOO: 'hello world' } },
    { name: 'inline comment (unquoted)',                input: 'FOO=bar # this is a comment',      expect: { FOO: 'bar' } },
    { name: 'inline comment with no space before hash', input: 'FOO=bar #comment',                 expect: { FOO: 'bar' } },
    { name: 'hash inside double quotes is literal',     input: 'FOO="value # not a comment"',      expect: { FOO: 'value # not a comment' } },
    { name: 'hash inside single quotes is literal',     input: "FOO='value # not a comment'",      expect: { FOO: 'value # not a comment' } },
    { name: 'full-line comment ignored',                input: '# comment\nFOO=bar',               expect: { FOO: 'bar' } },
    { name: 'blank lines ignored',                      input: '\n\nFOO=bar\n\n',                  expect: { FOO: 'bar' } },
    { name: 'empty value is empty string',              input: 'FOO=',                             expect: { FOO: '' } },
    { name: 'export prefix (bash-style)',               input: 'export FOO=bar',                   expect: { FOO: 'bar' } },
    { name: 'export prefix with quoted value',          input: 'export FOO="hello world"',         expect: { FOO: 'hello world' } },
    { name: 'CRLF line endings',                        input: 'FOO=bar\r\nBAZ=qux\r\n',           expect: { FOO: 'bar', BAZ: 'qux' } },
    { name: 'leading/trailing whitespace on unquoted',  input: 'FOO=  bar  ',                      expect: { FOO: 'bar' } },
    { name: 'whitespace preserved inside double quotes',input: 'FOO="  spaced  "',                 expect: { FOO: '  spaced  ' } },
    { name: 'path-like value with slashes',             input: 'MEMORY_DB_PATH=/tmp/foo/bar.db',   expect: { MEMORY_DB_PATH: '/tmp/foo/bar.db' } },
    { name: 'path-like value with inline comment',      input: 'MEMORY_DB_PATH=/tmp/foo.db # dev', expect: { MEMORY_DB_PATH: '/tmp/foo.db' } },
    { name: 'numeric value',                            input: 'MEMORY_HALF_LIFE_WEEKS=26',        expect: { MEMORY_HALF_LIFE_WEEKS: '26' } },
    { name: 'malformed line without equals is skipped', input: 'NOT_AN_ASSIGNMENT\nFOO=bar',       expect: { FOO: 'bar' } },
    { name: 'key with invalid characters is skipped',   input: '123FOO=bar\nVALID=ok',             expect: { VALID: 'ok' } },
    { name: 'unterminated quote skips line',             input: 'FOO="unterminated\nBAZ=qux',       expect: { BAZ: 'qux' } },
    { name: 'UTF-8 BOM is stripped',                    input: '\uFEFFFOO=bar',                    expect: { FOO: 'bar' } },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const got = parseDotEnv(tc.input);
      assert.deepStrictEqual(got, tc.expect);
    });
  }
});

// ---------------------------------------------------------------------------
// resolveProjectPath
// ---------------------------------------------------------------------------
describe('resolveProjectPath', () => {
  const FAKE_HOME = path.join(path.sep, 'fake-home', 'testuser');
  const cases = [
    { input: path.join(path.sep, 'abs', 'path'),        expected: path.join(path.sep, 'abs', 'path'),              note: 'absolute path unchanged' },
    { input: path.join(path.sep, 'abs', 'other', 'repo'), expected: path.join(path.sep, 'abs', 'other', 'repo'),  note: 'another absolute' },
    { input: '~/repo',                                   expected: path.join(FAKE_HOME, 'repo'),                   note: 'tilde-slash expanded' },
    { input: '~/nested/path',                            expected: path.join(FAKE_HOME, 'nested', 'path'),         note: 'tilde-slash deep' },
    { input: '~',                                        expected: FAKE_HOME,                                      note: 'bare tilde' },
    { input: 'repo',                                     expected: path.join(FAKE_HOME, 'repo'),                   note: 'relative treated as home-relative' },
    { input: 'nested/repo',                              expected: path.join(FAKE_HOME, 'nested', 'repo'),         note: 'relative nested' },
  ];

  for (const tc of cases) {
    it(tc.note, () => {
      assert.equal(resolveProjectPath(tc.input, FAKE_HOME), tc.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// loadExamples
// ---------------------------------------------------------------------------
describe('loadExamples', () => {
  it('should merge partial override with defaults', () => {
    const p = path.join(tmpDir, 'examples-valid.json');
    fs.writeFileSync(p, JSON.stringify({ entities: ['Zebra', 'Unicorn'], relations: ['hunts', 'befriends'] }));
    const merged = loadExamples(p);
    assert.equal(merged.entities[0], 'Zebra');
    assert.equal(merged.relations[0], 'hunts');
    // Omitted keys fall back to defaults
    assert.equal(merged.entity_types[0], DEFAULT_EXAMPLES.entity_types[0]);
    assert.equal(merged.event_labels[0], DEFAULT_EXAMPLES.event_labels[0]);
  });

  // Suppress console.error for fallback tests (expected warnings, not test noise)
  const fallbackCases = [
    { name: 'invalid JSON',       content: '{ this is not valid json' },
    { name: 'top-level null',     content: 'null' },
    { name: 'top-level array',    content: '["not", "an", "object"]' },
    { name: 'top-level primitive', content: '42' },
  ];

  for (const tc of fallbackCases) {
    it(`should fall back to defaults on ${tc.name}`, () => {
      const p = path.join(tmpDir, `examples-${tc.name.replace(/\s+/g, '-')}.json`);
      fs.writeFileSync(p, tc.content);
      const origErr = console.error;
      console.error = () => {};
      try {
        const result = loadExamples(p);
        assert.equal(result.entities[0], DEFAULT_EXAMPLES.entities[0]);
      } finally {
        console.error = origErr;
      }
    });
  }

  it('should return defaults for missing file', () => {
    const result = loadExamples(path.join(tmpDir, 'does-not-exist.json'));
    assert.equal(result.entities[0], DEFAULT_EXAMPLES.entities[0]);
  });

  it('should return a fresh copy, not a shared reference', () => {
    const result = loadExamples(path.join(tmpDir, 'does-not-exist.json'));
    result.entities.push('MUTATED');
    assert.ok(!DEFAULT_EXAMPLES.entities.includes('MUTATED'), 'returned shared reference');
  });
});
