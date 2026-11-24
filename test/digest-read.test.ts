import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read.js';

describe('readNight on runs/2026-10-28.jsonl', () => {
  const night = readNight('runs', '2026-10-28');
  const row = (job: string) => night?.rows.find((r) => r.job === job);

  it('reads 5 jobs sorted by job and counts 1 bad line', () => {
    expect(night).not.toBeNull();
    expect(night?.night).toBe('2026-10-28');
    expect(night?.rows.map((r) => r.job)).toEqual([
      'digest/render',
      'fixtures/refresh',
      'lane/sync',
      'notes/backup',
      'rig/rotate-logs',
    ]);
    expect(night?.badLines).toBe(1);
  });

  it('counts runs and retries, keeps last status and error', () => {
    expect(row('fixtures/refresh')).toMatchObject({ runs: 4, retries: 3, lastStatus: 'ok', lastError: 'upstream 503' });
    expect(row('notes/backup')).toMatchObject({ runs: 1, lastStatus: 'fail', lastError: 'quota exceeded' });
    expect(row('lane/sync')).toMatchObject({ retries: 1, lastStatus: 'ok', lastError: 'lock held', owner: 'rook' });
    expect(row('rig/rotate-logs')).toMatchObject({ runs: 1, retries: 0, lastError: null });
  });

  it('keeps a null owner', () => {
    expect(row('digest/render')?.owner).toBeNull();
  });

  it('keeps the log offsets', () => {
    expect(row('fixtures/refresh')?.firstAt).toBe('2026-10-29T01:30:00+01:00');
    expect(row('fixtures/refresh')?.lastAt).toBe('2026-10-29T01:37:00+01:00');
    expect(row('lane/sync')?.firstAt).toBe('2026-10-28T23:00:06+01:00');
    for (const r of night?.rows ?? []) {
      expect(r.firstAt).toMatch(/\+01:00$/);
      expect(r.lastAt).toMatch(/\+01:00$/);
    }
  });
});

describe('readNight on a temp dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-digest-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when the night has no file', () => {
    expect(readNight(dir, '2026-01-01')).toBeNull();
  });

  it('gives no rows and no bad lines for an empty file', () => {
    writeFileSync(join(dir, '2026-01-02.jsonl'), '');
    expect(readNight(dir, '2026-01-02')).toEqual({ night: '2026-01-02', rows: [], badLines: 0 });
  });

  it('skips blank lines and counts invalid lines as bad', () => {
    writeFileSync(
      join(dir, '2026-01-03.jsonl'),
      [
        '',
        '{"at":"2026-01-03T01:00:00-05:00","job":"a","status":"ok","owner":"x"}',
        '   ',
        '{"at":"2026-01-03T02:00:00-05:00","job":"a","status":"maybe","owner":"x"}',
        '{"job":"a","status":"ok","owner":"x"}',
        'not json',
        '{"at":"2026-01-03T03:00:00-05:00","job":"a","status":"retry","owner":"y","error":"e1"}',
        '',
      ].join('\n'),
    );
    const n = readNight(dir, '2026-01-03');
    expect(n?.badLines).toBe(3);
    expect(n?.rows).toEqual([
      {
        job: 'a',
        owner: 'y',
        runs: 2,
        retries: 1,
        lastStatus: 'retry',
        lastError: 'e1',
        firstAt: '2026-01-03T01:00:00-05:00',
        lastAt: '2026-01-03T03:00:00-05:00',
      },
    ]);
  });
});
