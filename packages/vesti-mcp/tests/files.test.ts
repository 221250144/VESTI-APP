import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import {
  createFileSearchDataSource,
  FILE_EVIDENCE_QUERY_TOKEN_LIMIT,
  FILE_EVIDENCE_ROWS_PER_TOKEN,
  FILE_EVIDENCE_RESULT_LIMIT,
  vestiSearchFiles,
} from '../src/files.js';
import { createFixtureDb, SESSION_A, type Fixture } from './helpers/fixture.js';

let fixture: Fixture;
let db: VestiDatabase;

beforeEach(() => {
  fixture = createFixtureDb();
  db = openVestiDb(fixture.dbPath);
});

afterEach(() => {
  db.close();
  fixture.cleanup();
});

describe('vesti_search_files', () => {
  it('finds the file behind a session recalled by content', () => {
    const result = vestiSearchFiles(db, { query: 'transactional migrations' });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const hit = result.results.find(r => r.path === 'packages/capture-core/src/storage/migrations.ts');
    expect(hit).toBeDefined();
    expect(hit!.projects).toEqual(['C:/work/vesti']);
    expect(hit!.sessions.map(s => s.session_id)).toContain(SESSION_A);
    // The semantic session channel is authoritative here. A single generic
    // path-token hit ("migrations" among a multi-token query) is deliberately
    // not promoted to filename evidence.
    expect(hit!.matched_via).toContain('session-content');
    expect(hit!.matched_via).not.toContain('name');
    expect(hit!.touches).toBeGreaterThanOrEqual(2);
    expect(hit!.last_touched).not.toBeNull();
  });

  it('returns an empty list when matching sessions touched no files', () => {
    // SESSION_B is about deploying a blog; its only tool call is
    // 'npm run deploy' — no file paths anywhere.
    const result = vestiSearchFiles(db, { query: 'deploy blog gh-pages' });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('matches on the file path name alone', () => {
    const result = vestiSearchFiles(db, { query: 'migrations.ts' });
    expect(result.results.some(r => r.path.endsWith('migrations.ts'))).toBe(true);
    expect(result.results[0].matched_via).toContain('name');
  });

  it('requires a query', () => {
    expect(() => vestiSearchFiles(db, { query: '  ' })).toThrow(/query is required/);
  });

  it('caps topK', () => {
    const result = vestiSearchFiles(db, { query: 'migrations', topK: 1 });
    expect(result.count).toBeLessThanOrEqual(1);
  });

  it('bounds direct tool/digest scans in SQL while preserving project filters', () => {
    const insertTool = db.prepare(
      `INSERT INTO tool_executions
       (id, session_id, turn_id, sequence, tool_use_message_id, tool_name, outcome, input_summary, timestamp)
       VALUES (?, ?, ?, 0, ?, 'Read', 'success', ?, ?)`,
    );
    for (let index = 0; index < FILE_EVIDENCE_ROWS_PER_TOKEN + 40; index += 1) {
      insertTool.run(
        `te-bulk-${index}`,
        SESSION_A,
        `${SESSION_A}-t1`,
        'm-a1-a',
        `src/bulkmarker/file-${index}.ts`,
        index,
      );
    }

    const insertSession = db.prepare(
      `INSERT INTO work_sessions
       (id, session_id, platform, project_path, title, started_at, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
    );
    const insertDigest = db.prepare(
      `INSERT INTO session_digests (session_id, key_files, embedding_status)
       VALUES (?, ?, 'none')`,
    );
    for (let index = 0; index < FILE_EVIDENCE_ROWS_PER_TOKEN + 40; index += 1) {
      const sessionId = `ws-digest-bulk-${index}`;
      insertSession.run(
        sessionId,
        sessionId,
        'C:/work/vesti',
        `bulk digest ${index}`,
        index,
        index,
        index,
        index,
      );
      insertDigest.run(sessionId, JSON.stringify([`src/bulkdigest/file-${index}.ts`]));
    }

    const source = createFileSearchDataSource(db);
    const toolRows = source.findToolInputsContaining(['bulkmarker']);
    const digestRows = source.findDigestFilesContaining(['bulkdigest'], {
      projectPaths: ['C:/work/vesti'],
    });
    expect(toolRows).toHaveLength(FILE_EVIDENCE_ROWS_PER_TOKEN);
    expect(digestRows).toHaveLength(FILE_EVIDENCE_ROWS_PER_TOKEN);
    expect(digestRows.every(row => row.projectPath === 'C:/work/vesti')).toBe(true);
    expect(toolRows.length).toBeLessThanOrEqual(FILE_EVIDENCE_RESULT_LIMIT);
  });

  it('prioritizes an exact basename beyond the token cap and keeps project scope', () => {
    const insertTool = db.prepare(
      `INSERT INTO tool_executions
       (id, session_id, turn_id, sequence, tool_use_message_id, tool_name, outcome, input_summary, timestamp)
       VALUES (?, ?, ?, 0, ?, 'Read', 'success', ?, ?)`,
    );
    insertTool.run(
      'te-rare-target',
      SESSION_A,
      `${SESSION_A}-t1`,
      'm-a1-a',
      'packages/search/src/rareTarget.ts',
      Date.UTC(2026, 0, 10),
    );

    const query = [
      ...Array.from({ length: FILE_EVIDENCE_QUERY_TOKEN_LIMIT + 2 }, (_, index) => `ordinarytoken${index}`),
      'rareTarget.ts',
    ].join(' ');
    const result = vestiSearchFiles(db, { query, project: 'vesti' });
    expect(result.results[0]?.path).toBe('packages/search/src/rareTarget.ts');
    expect(result.results[0]?.projects).toEqual(['C:/work/vesti']);
    expect(result.results[0]?.matched_via).toContain('name');
  });
});
