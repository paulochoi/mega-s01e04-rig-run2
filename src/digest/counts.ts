import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type NightCounts = { ok: number; retry: number; fail: number };

// Log lines per status for one night. Lines that don't parse, or have no valid
// status, are not counted (same rule as read.ts). A missing file counts as zeros.
export function countNight(runsDir: string, night: string): NightCounts {
  const counts: NightCounts = { ok: 0, retry: 0, fail: 0 };
  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch {
    return counts;
  }
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    if (typeof obj.at !== 'string' || typeof obj.job !== 'string') continue;
    if (obj.status === 'ok' || obj.status === 'retry' || obj.status === 'fail') counts[obj.status]++;
  }
  return counts;
}
