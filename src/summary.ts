import type { FailureHistoryRecord } from './types';

export function buildSummary(record: FailureHistoryRecord): string {
  const recentRuns = record.recentRuns.length > 0
    ? [
        '## Recent occurrences',
        '',
        ...record.recentRuns.map(
          run => `- \`${run.runId}\` at \`${run.timestamp}\` from \`${run.logPath}\``
        ),
        '',
      ]
    : [];

  return [
    '# FailureMemory Summary',
    '',
    `- Fingerprint: \`${record.fingerprint}\``,
    `- Seen count: **${record.seenCount}**`,
    `- First seen: \`${record.firstSeenAt}\``,
    `- Last seen: \`${record.lastSeenAt}\``,
    '',
    '## Normalized excerpt',
    '',
    '```text',
    record.normalizedExcerpt,
    '```',
    '',
    ...recentRuns,
  ].join('\n');
}
