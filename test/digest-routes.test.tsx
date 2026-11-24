import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Night } from '../src/digest/types.js';

const GOOD = '2026-10-30';
const EMPTY = '2026-10-31';
const BAD = '2026-11-01';
const MISSING = '2026-11-02';

const line = (at: string, job: string, status: string, owner: string | null, error?: string) =>
  JSON.stringify({ at, job, status, owner, ...(error === undefined ? {} : { error }) });

let runsDir = '';
let app: ReturnType<typeof createApp>;
let savedMarker: string | undefined;

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
  // Jobs written out of order on purpose: rows must come back sorted by job.
  writeFileSync(
    join(runsDir, `${GOOD}.jsonl`),
    [
      line('2026-10-30T02:00:00+01:00', 'zeta-sync', 'ok', 'ana'),
      line('2026-10-30T02:05:00+01:00', 'alpha-backup', 'retry', 'bo', 'timeout'),
      line('2026-10-30T02:10:00+01:00', 'alpha-backup', 'ok', 'bo'),
      line('2026-10-30T02:15:00+01:00', 'mid-report', 'fail', null, 'disk full'),
    ].join('\n') + '\n',
  );
  writeFileSync(join(runsDir, `${EMPTY}.jsonl`), '');
  writeFileSync(
    join(runsDir, `${BAD}.jsonl`),
    [
      line('2026-11-01T01:00:00+01:00', 'nightly-b', 'ok', 'ana'),
      'this is not json',
      '{"at": "2026-11-01T01:30:00+01:00", "job": "no-status"}',
      line('2026-11-01T02:00:00+01:00', 'nightly-a', 'ok', 'bo'),
    ].join('\n') + '\n',
  );
  mkdirSync(join(runsDir, 'subdir'));
  savedMarker = process.env.LANE_MARKER;
  process.env.LANE_MARKER = 'TEST-MARKER';
  app = createApp({ adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir });
});

afterAll(() => {
  rmSync(runsDir, { recursive: true, force: true });
  if (savedMarker === undefined) delete process.env.LANE_MARKER;
  else process.env.LANE_MARKER = savedMarker;
});

// Jobs in the order they first appear in the page.
function order(html: string, jobs: string[]): string[] {
  return jobs
    .map((job) => ({ job, at: html.indexOf(job) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.job);
}

describe('GET /digest/:night', () => {
  it('renders every job and the lane banner', async () => {
    const res = await app.request(`/digest/${GOOD}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('TEST-MARKER');
    expect(html).toContain('lane-07');
    for (const job of ['alpha-backup', 'mid-report', 'zeta-sync']) expect(html).toContain(job);
  });

  it('says nothing ran on the empty night', async () => {
    const res = await app.request(`/digest/${EMPTY}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('nothing ran');
  });

  it('still renders the good lines of a night with a bad line', async () => {
    const res = await app.request(`/digest/${BAD}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('nightly-a');
    expect(html).toContain('nightly-b');
  });

  it('404s for a night with no file, with the layout', async () => {
    const res = await app.request(`/digest/${MISSING}`);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain(`no run log for ${MISSING}`);
    expect(html).toContain('TEST-MARKER');
  });

  it.each(['../etc', '..%2Fetc', 'subdir', '2026-1-1', '2026-10-30.jsonl', 'latest'])(
    '404s for the bad night string %s',
    async (night) => {
      const res = await app.request(`/digest/${night}`);
      expect(res.status).toBe(404);
    },
  );
});

describe('GET /api/digest/:night', () => {
  it('returns { night, rows, badLines } with rows sorted by job', async () => {
    const res = await app.request(`/api/digest/${GOOD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Night;
    expect(Object.keys(body).sort()).toEqual(['badLines', 'night', 'rows']);
    expect(body.night).toBe(GOOD);
    expect(body.badLines).toBe(0);
    expect(body.rows.map((r) => r.job)).toEqual(['alpha-backup', 'mid-report', 'zeta-sync']);
    expect(body.rows[0]).toMatchObject({ job: 'alpha-backup', owner: 'bo', runs: 2, retries: 1, lastStatus: 'ok' });
  });

  it('returns no rows and no bad lines for the empty night', async () => {
    const res = await app.request(`/api/digest/${EMPTY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ night: EMPTY, rows: [], badLines: 0 });
  });

  it('counts bad lines instead of failing', async () => {
    const res = await app.request(`/api/digest/${BAD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Night;
    expect(body.badLines).toBe(2);
    expect(body.rows.map((r) => r.job)).toEqual(['nightly-a', 'nightly-b']);
  });

  it('404s with { error, night } for a night with no file', async () => {
    const res = await app.request(`/api/digest/${MISSING}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such night', night: MISSING });
  });

  it('404s for a bad night string', async () => {
    const res = await app.request('/api/digest/..%2Fetc');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such night', night: '../etc' });
  });
});

describe('page and JSON agree', () => {
  it.each([GOOD, BAD])('list the same jobs in the same order for %s', async (night) => {
    const body = (await (await app.request(`/api/digest/${night}`)).json()) as Night;
    const html = await (await app.request(`/digest/${night}`)).text();
    const jobs = body.rows.map((r) => r.job);
    expect(jobs.length).toBeGreaterThan(0);
    expect(order(html, jobs)).toEqual(jobs);
  });
});
