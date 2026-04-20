import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HistorySnapshot, MergeFailureOptions } from './types';

function createEmptyHistory(maxRuns: number): HistorySnapshot {
  return {
    version: 1,
    maxRuns,
    updatedAt: '',
    failures: {},
  };
}

export async function loadHistory(historyPath: string, maxRuns: number): Promise<HistorySnapshot> {
  try {
    const raw = await readFile(historyPath, 'utf8');
    const parsed = JSON.parse(raw) as HistorySnapshot;
    return {
      ...parsed,
      maxRuns,
      failures: parsed.failures ?? {},
      updatedAt: parsed.updatedAt ?? '',
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return createEmptyHistory(maxRuns);
    }

    throw error;
  }
}

export function mergeFailureIntoHistory(
  history: HistorySnapshot,
  failure: { fingerprint: string; normalizedExcerpt: string },
  options: MergeFailureOptions
): HistorySnapshot {
  const existing = history.failures[failure.fingerprint];
  const recentRuns = [...(existing?.recentRuns ?? []), {
    runId: options.runId,
    timestamp: options.timestamp,
    logPath: options.logPath,
  }].slice(-options.maxRuns);

  return {
    version: 1,
    maxRuns: options.maxRuns,
    updatedAt: options.timestamp,
    failures: {
      ...history.failures,
      [failure.fingerprint]: {
        fingerprint: failure.fingerprint,
        normalizedExcerpt: failure.normalizedExcerpt,
        firstSeenAt: existing?.firstSeenAt ?? options.timestamp,
        lastSeenAt: options.timestamp,
        seenCount: (existing?.seenCount ?? 0) + 1,
        recentRuns,
      },
    },
  };
}

export async function saveHistory(historyPath: string, history: HistorySnapshot): Promise<void> {
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}
