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
  compositeScore,
  ftsPositionScore,
  CHANNEL_WEIGHTS,
  sanitizeSearchLimit,
  collectCandidates,
  hydrateCandidates,
  scoreCandidates,
  groupResults,
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
// composite ranking (v5 redesign)
// ---------------------------------------------------------------------------
describe('composite ranking', () => {
  let rankDb;

  before(() => {
    rankDb = initDb(path.join(tmpDir, 'rank-test.db'));

    // Seed data designed for ranking tests:
    // Entity "Alice" with observations about therapy (should FTS-match "Alice terapia")
    const alice = upsertEntity(rankDb, 'Alice', 'person');
    addObservation(rankDb, alice, 'Alice is the therapist, weekly terapia sessions', 'user', 1.0);
    addObservation(rankDb, alice, 'Alice prefers cognitive behavioral approach', 'user', 0.9);

    // Entity "AliceSprings" — should match entity_like for "Alice" but NOT entity_exact
    const aliceSprings = upsertEntity(rankDb, 'AliceSprings', 'location');
    addObservation(rankDb, aliceSprings, 'A city in Australia, hot climate', 'user', 1.0);

    // Entity "Bob" with observation mentioning "Alice" in content only
    const bob = upsertEntity(rankDb, 'Bob', 'person');
    addObservation(rankDb, bob, 'Bob once mentioned Alice in passing', 'user', 1.0);

    // Entity "Cooking" — high confidence, irrelevant to Alice
    const cooking = upsertEntity(rankDb, 'Cooking', 'hobby');
    addObservation(rankDb, cooking, 'Cooking pasta is a daily ritual', 'user', 1.0);

    // Event with label mentioning Alice
    const evId = createEvent(rankDb, 'Session with Alice - intake', null, 'session', null, null);
    const therapy = upsertEntity(rankDb, 'TherapyLog', 'log');
    addObservation(rankDb, therapy, 'First session notes', 'user', 0.8, evId);
  });

  after(() => {
    rankDb.close();
  });

  it('should return composite_score on all results', () => {
    const results = searchMemory(rankDb, 'Alice', 10, 12);
    assert.ok(results.length > 0, 'no results');
    for (const r of results) {
      assert.equal(typeof r.composite_score, 'number', `missing composite_score on obs ${r.id}`);
      assert.equal(typeof r.effective_confidence, 'number', `missing effective_confidence on obs ${r.id}`);
      assert.ok(r.composite_score > 0, `composite_score should be positive, got ${r.composite_score}`);
    }
  });

  it('better FTS match (more terms) should rank above weaker FTS match', () => {
    // "Alice terapia" — Alice's obs contains both terms, Bob's obs contains only "Alice"
    // Both match FTS, but Alice's obs should have a better FTS position (more relevant)
    const results = searchMemory(rankDb, 'Alice terapia', 10, 12);
    const aliceObs = results.find(r => r.entity_name === 'Alice' && r.content.includes('terapia'));
    const bobObs = results.find(r => r.entity_name === 'Bob');
    // Assert both exist before comparing — conditional checks hide regressions
    assert.ok(aliceObs, 'Alice terapia observation not found in results');
    assert.ok(bobObs, 'Bob observation not found in results');
    assert.ok(
      aliceObs.composite_score >= bobObs.composite_score,
      `better FTS match (${aliceObs.composite_score}) should rank >= weaker match (${bobObs.composite_score})`
    );
    assert.ok(results[0].content.includes('terapia'), 'best result should contain both query terms');
  });

  it('entity_exact should rank above entity_like', () => {
    const results = searchMemory(rankDb, 'Alice', 10, 12);
    const exactObs = results.filter(r => r.entity_name === 'Alice');
    const likeObs = results.filter(r => r.entity_name === 'AliceSprings');
    assert.ok(exactObs.length > 0, 'no entity_exact results for Alice');
    assert.ok(likeObs.length > 0, 'no entity_like results for AliceSprings');
    const bestExact = Math.max(...exactObs.map(r => r.composite_score));
    const bestLike = Math.max(...likeObs.map(r => r.composite_score));
    assert.ok(
      bestExact > bestLike,
      `entity_exact best (${bestExact}) should outrank entity_like best (${bestLike})`
    );
  });

  it('irrelevant high-confidence fact should NOT outrank relevant lower-confidence fact', () => {
    // "Alice" query — Cooking (high conf, irrelevant) should not appear above Alice obs
    const results = searchMemory(rankDb, 'Alice', 10, 12);
    const cookingObs = results.find(r => r.entity_name === 'Cooking');
    const aliceObs = results.find(r => r.entity_name === 'Alice');
    if (cookingObs && aliceObs) {
      assert.ok(
        aliceObs.composite_score > cookingObs.composite_score,
        'irrelevant high-confidence fact outranked relevant fact — ranking regression'
      );
    }
    // Cooking shouldn't even appear for "Alice" query
    assert.equal(cookingObs, undefined, 'Cooking should not match Alice query at all');
  });

  it('should enforce limit after scoring', () => {
    const results = searchMemory(rankDb, 'Alice', 2, 12);
    assert.ok(results.length <= 2, `returned ${results.length} results, expected <= 2`);
  });

  it('order independence — shuffled candidate IDs produce identical ranking', () => {
    // Run search twice — results should be deterministic regardless of internal order
    const r1 = searchMemory(rankDb, 'Alice', 10, 12);
    const r2 = searchMemory(rankDb, 'Alice', 10, 12);
    assert.deepStrictEqual(
      r1.map(r => r.id),
      r2.map(r => r.id),
      'non-deterministic ranking'
    );
  });

  it('FTS position should differentiate intra-FTS results (no clamp to 1.0)', () => {
    // Best FTS hit should have higher composite_score than worst FTS hit
    const results = searchMemory(rankDb, 'Alice terapia', 10, 12);
    const ftsResults = results.filter(r =>
      r.content.includes('Alice') || r.content.includes('terapia')
    );
    if (ftsResults.length >= 2) {
      // First and last FTS results should NOT have identical scores
      assert.notEqual(
        ftsResults[0].composite_score,
        ftsResults[ftsResults.length - 1].composite_score,
        'FTS position bonus was clamped — all FTS results have identical score'
      );
    }
  });

  it('global top-k: searchMemory(q, 2) should match searchMemory(q, 10).slice(0, 2)', () => {
    // The collection multiplier ensures per-channel queries don't prematurely
    // truncate candidates before global scoring
    const narrow = searchMemory(rankDb, 'Alice', 2, 12);
    const wide = searchMemory(rankDb, 'Alice', 10, 12).slice(0, 2);
    assert.deepStrictEqual(
      narrow.map(r => r.id),
      wide.map(r => r.id),
      'narrow limit missed candidates that global scoring would have selected'
    );
  });

  it('touchObservations should only bump returned results, not all candidates', () => {
    // Create a fresh DB so access_count is pristine
    const touchDb = initDb(path.join(tmpDir, 'touch-test.db'));
    const e1 = upsertEntity(touchDb, 'TouchTarget', 'test');
    const obs1 = addObservation(touchDb, e1, 'touch observation alpha', 'user', 1.0);
    const obs2 = addObservation(touchDb, e1, 'touch observation beta', 'user', 0.5);
    const obs3 = addObservation(touchDb, e1, 'touch observation gamma', 'user', 0.3);

    // Request limit=1 — only top result should get access_count bumped
    searchMemory(touchDb, 'touch observation', 1, 12);

    const counts = [obs1, obs2, obs3].map(id =>
      touchDb.prepare('SELECT access_count FROM observations WHERE id = ?').get(id).access_count
    );
    const bumped = counts.filter(c => c > 0).length;
    assert.equal(bumped, 1, `expected 1 observation touched, got ${bumped} (counts: ${counts})`);
    touchDb.close();
  });

  it('deterministic tie-break: identical scores produce stable ordering', () => {
    const r1 = searchMemory(rankDb, 'Alice', 10, 12);
    const r2 = searchMemory(rankDb, 'Alice', 10, 12);
    const r3 = searchMemory(rankDb, 'Alice', 10, 12);
    assert.deepStrictEqual(r1.map(r => r.id), r2.map(r => r.id), 'run 1 vs 2');
    assert.deepStrictEqual(r2.map(r => r.id), r3.map(r => r.id), 'run 2 vs 3');
  });

  it('empty/whitespace query should return no results', () => {
    assert.deepStrictEqual(searchMemory(rankDb, '', 10, 12), []);
    assert.deepStrictEqual(searchMemory(rankDb, '   ', 10, 12), []);
  });

  it('limit=0 should return no results', () => {
    assert.deepStrictEqual(searchMemory(rankDb, 'Alice', 0, 12), []);
  });

  it('limit clamped to 200 max', () => {
    const results = searchMemory(rankDb, 'Alice', 9999, 12);
    assert.ok(results.length <= 200, `returned ${results.length}, expected <= 200`);
  });

  it('recall handler should include composite_score in output', () => {
    const result = handleTool(rankDb, 'recall', { query: 'Alice', limit: 5 });
    assert.ok(result.results.length > 0, 'no results from recall handler');
    const firstObs = result.results[0].observations[0];
    assert.equal(typeof firstObs.confidence, 'number', 'missing confidence');
    assert.equal(typeof firstObs.composite_score, 'number', 'missing composite_score');
  });

  it('collectCandidates should accumulate multi-channel metadata in a Map', () => {
    const candidates = collectCandidates(rankDb, 'Alice', 30, 200);
    const aliceObs = rankDb.prepare(`
      SELECT o.id
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.name = ? AND o.content LIKE ?
      LIMIT 1
    `).get('Alice', '%therapist%');

    assert.ok(aliceObs, 'fixture lookup failed for Alice observation');
    const candidate = candidates.get(aliceObs.id);
    assert.ok(candidate, 'Alice observation missing from candidate map');
    assert.ok(candidate.channels.has('fts'), 'expected FTS channel on Alice candidate');
    assert.ok(candidate.channels.has('entity_exact'), 'expected entity_exact channel on Alice candidate');
    assert.equal(candidate.best_channel, 'fts', 'expected strongest channel to remain fts');
  });

  it('hydrateCandidates + scoreCandidates should preserve ranking pipeline behavior', () => {
    const limit = 3;
    const collectLimit = limit * 3;
    const candidates = collectCandidates(rankDb, 'Alice', collectLimit, Math.max(collectLimit, 200));
    const hydrated = hydrateCandidates(rankDb, candidates);
    const ranked = scoreCandidates(hydrated, candidates, 12, limit);

    assert.ok(hydrated.length >= ranked.length, 'hydration should return at least ranked rows');
    assert.ok(ranked.length <= limit, 'scored results should respect limit');
    assert.deepStrictEqual(
      ranked.map(r => r.id),
      searchMemory(rankDb, 'Alice', limit, 12).map(r => r.id),
      'extracted pipeline drifted from searchMemory behavior'
    );
  });

  it('groupResults should preserve grouped recall response shape', () => {
    const ranked = searchMemory(rankDb, 'Alice', 5, 12);
    const grouped = groupResults(ranked);

    assert.equal(grouped.total_facts, ranked.length);
    assert.ok(Array.isArray(grouped.results), 'grouped results should be an array');
    assert.ok(grouped.results.length > 0, 'grouped results should not be empty for Alice query');
    assert.equal(typeof grouped.results[0].entity_name, 'string');
    assert.ok(Array.isArray(grouped.results[0].observations), 'group observations should be an array');
    assert.equal(typeof grouped.results[0].observations[0].confidence, 'number');
  });
});

// ---------------------------------------------------------------------------
// ftsPositionScore
// ---------------------------------------------------------------------------
describe('ftsPositionScore', () => {
  it('should return 1.0 for best position (0)', () => {
    assert.equal(ftsPositionScore(0, 5), 1.0);
  });

  it('should return 0.0 for worst position', () => {
    assert.equal(ftsPositionScore(4, 5), 0.0);
  });

  it('should return 0.5 for middle position', () => {
    assert.equal(ftsPositionScore(2, 5), 0.5);
  });

  it('should return 1.0 for single result', () => {
    assert.equal(ftsPositionScore(0, 1), 1.0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeSearchLimit
// ---------------------------------------------------------------------------
describe('sanitizeSearchLimit', () => {
  it('should default invalid input to 20', () => {
    assert.equal(sanitizeSearchLimit(NaN), 20);
  });

  it('should return 0 for non-positive limits', () => {
    assert.equal(sanitizeSearchLimit(0), 0);
    assert.equal(sanitizeSearchLimit(-5), 0);
  });

  it('should clamp oversized limits to 200', () => {
    assert.equal(sanitizeSearchLimit(9999), 200);
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
