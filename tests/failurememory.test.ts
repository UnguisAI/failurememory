import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('FailureMemory scaffold', () => {
  it('exports a runAction entrypoint', () => {
    const { runAction } = require('../src/index');
    expect(typeof runAction).toBe('function');
  });
});

describe('fingerprint normalization', () => {
  const fixtureDir = path.join(__dirname, '..', 'fixtures');

  it('normalizes similar logs to the same fingerprint', async () => {
    const { parseLog } = require('../src/log-parser');
    const { createFingerprint } = require('../src/fingerprint');
    const firstLog = await readFile(path.join(fixtureDir, 'repeated-node-error.log'), 'utf8');
    const secondLog = await readFile(path.join(fixtureDir, 'repeated-node-error-variant.log'), 'utf8');

    const firstParsed = parseLog(firstLog);
    const secondParsed = parseLog(secondLog);
    const firstFingerprint = createFingerprint(firstParsed.normalizedExcerpt);
    const secondFingerprint = createFingerprint(secondParsed.normalizedExcerpt);

    expect(firstParsed.normalizedExcerpt).toContain('<timestamp>');
    expect(firstParsed.normalizedExcerpt).toContain('<duration>');
    expect(firstParsed.normalizedExcerpt).toContain('<id>');
    expect(firstParsed.normalizedExcerpt).toContain('<path>');
    expect(firstParsed.normalizedExcerpt).toContain("Error: Cannot find module '<path>'");
    expect(firstParsed.normalizedExcerpt).toBe(secondParsed.normalizedExcerpt);
    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ignores non-failure summary lines that mention passed and failed counts', () => {
    const { parseLog } = require('../src/log-parser');

    expect(() =>
      parseLog('Tests: 10 passed, 0 failed\nCoverage: 100%\nBuild finished successfully')
    ).toThrow('Could not find a recognizable failure excerpt');
  });

  it('ignores successful exit-code and checkout noise lines', () => {
    const { parseLog } = require('../src/log-parser');

    expect(() =>
      parseLog('Process completed with exit code 0\nCheckout complete at commit abcdef1234567890')
    ).toThrow('Could not find a recognizable failure excerpt');
  });

  it('rejects blank logs instead of recording an empty fingerprint', () => {
    const { parseLog } = require('../src/log-parser');

    expect(() => parseLog('   \n\n  ')).toThrow('Log file is empty or contains only whitespace.');
  });
});

describe('GitHub Actions log parsing', () => {
  const fixtureDir = path.join(__dirname, '..', 'fixtures');

  it('prefers specific failure lines over generic GitHub Actions exit-code noise', async () => {
    const { parseLog } = require('../src/log-parser');
    const log = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');

    const parsed = parseLog(log);

    expect(parsed.selectedLines).toEqual(['gh: Resource not accessible by integration (HTTP 403)']);
    expect(parsed.rawExcerpt).toBe('gh: Resource not accessible by integration (HTTP 403)');
    expect(parsed.normalizedExcerpt).toBe('gh: Resource not accessible by integration (HTTP 403)');
  });

  it('ignores command boilerplate that only mentions Exception and keeps specific compile failures', async () => {
    const { parseLog } = require('../src/log-parser');
    const log = await readFile(path.join(fixtureDir, 'github-actions-go-build-error.log'), 'utf8');

    const parsed = parseLog(log);

    expect(parsed.selectedLines).toEqual([
      'pkg/cmd/skills/preview/preview.go:44:17: f.Executable undefined (type *cmdutil.Factory has no field or method Executable)',
      'pkg/cmd/skills/search/search.go:71:17: f.Executable undefined (type *cmdutil.Factory has no field or method Executable)',
      'build.go: building task `bin/gh` failed.',
      'make: *** [Makefile:17: bin/gh] Error 1',
    ]);
    expect(parsed.rawExcerpt).not.toContain('[command]');
    expect(parsed.rawExcerpt).not.toContain('$_.Exception');
    expect(parsed.rawExcerpt).not.toContain('Process completed with exit code 2.');
  });

  it('compresses duplicate multi-job failure excerpts while preserving unique lines in order', async () => {
    const { parseLog } = require('../src/log-parser');
    const log = await readFile(path.join(fixtureDir, 'github-actions-duplicate-multi-job.log'), 'utf8');

    const parsed = parseLog(log);

    expect(parsed.selectedLines).toEqual([
      "Error: Cannot find module '/home/runner/work/failurememory/node_modules/.pnpm/left-pad@1.3.0_18553/node_modules/left-pad/index.js'",
      'Require stack:',
      '- /home/runner/work/failurememory/scripts/run-tests.js',
      'npm ERR! code ELIFECYCLE',
      'npm ERR! path D:\\a\\failurememory\\failurememory\\apps\\web',
    ]);
    expect(parsed.rawExcerpt).not.toContain("Error: Cannot find module 'D:\\a\\failurememory\\failurememory\\node_modules\\.pnpm\\left-pad@1.3.0_99281\\node_modules\\left-pad\\index.js'");
    expect(parsed.normalizedExcerpt).toBe([
      "Error: Cannot find module '<path>'",
      'Require stack:',
      '- <path>',
      'npm ERR! code ELIFECYCLE',
      'npm ERR! path <path>',
    ].join('\n'));
  });

  it('keeps distinct failure lines even when they normalize to the same shape', () => {
    const { parseLog } = require('../src/log-parser');
    const parsed = parseLog([
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.1000000Z ##[error]gh: Resource not accessible by integration (HTTP 403)',
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.2000000Z ##[error]gh: Resource not accessible by integration (HTTP 404)',
    ].join('\n'));

    expect(parsed.selectedLines).toEqual([
      'gh: Resource not accessible by integration (HTTP 403)',
      'gh: Resource not accessible by integration (HTTP 404)',
    ]);
    expect(parsed.rawExcerpt).toContain('HTTP 403');
    expect(parsed.rawExcerpt).toContain('HTTP 404');
    expect(parsed.normalizedExcerpt).toBe([
      'gh: Resource not accessible by integration (HTTP 403)',
      'gh: Resource not accessible by integration (HTTP 404)',
    ].join('\n'));
  });

  it('compresses duplicate failures that only differ by volatile numeric ids', () => {
    const { parseLog } = require('../src/log-parser');
    const parsed = parseLog([
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.1000000Z ##[error]Upload failed for artifact 12345 (HTTP 500)',
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.2000000Z ##[error]Upload failed for artifact 67890 (HTTP 500)',
    ].join('\n'));

    expect(parsed.selectedLines).toEqual([
      'Upload failed for artifact 12345 (HTTP 500)',
    ]);
    expect(parsed.normalizedExcerpt).toBe('Upload failed for artifact <id> (HTTP 500)');
  });

  it('keeps distinct failure lines when port numbers are meaningful', () => {
    const { parseLog } = require('../src/log-parser');
    const parsed = parseLog([
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.1000000Z ##[error]error: failed to connect to localhost on port 5432',
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.2000000Z ##[error]error: failed to connect to localhost on port 6432',
    ].join('\n'));

    expect(parsed.selectedLines).toEqual([
      'error: failed to connect to localhost on port 5432',
      'error: failed to connect to localhost on port 6432',
    ]);
    expect(parsed.normalizedExcerpt).toBe([
      'error: failed to connect to localhost on port 5432',
      'error: failed to connect to localhost on port 6432',
    ].join('\n'));
  });

  it('keeps meaningful status codes when labels use punctuation', () => {
    const { parseLog } = require('../src/log-parser');
    const parsed = parseLog([
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.1000000Z ##[error]error: request failed with HTTP: 403',
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.2000000Z ##[error]error: request failed with HTTP: 404',
    ].join('\n'));

    expect(parsed.selectedLines).toEqual([
      'error: request failed with HTTP: 403',
      'error: request failed with HTTP: 404',
    ]);
    expect(parsed.normalizedExcerpt).toBe([
      'error: request failed with HTTP: 403',
      'error: request failed with HTTP: 404',
    ].join('\n'));
  });

  it('keeps meaningful SQLSTATE codes distinct', () => {
    const { parseLog } = require('../src/log-parser');
    const parsed = parseLog([
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.1000000Z ##[error]error: database rejected row (SQLSTATE 23505)',
      'api\tUNKNOWN STEP\t2026-04-19T20:11:01.2000000Z ##[error]error: database rejected row (SQLSTATE 23503)',
    ].join('\n'));

    expect(parsed.selectedLines).toEqual([
      'error: database rejected row (SQLSTATE 23505)',
      'error: database rejected row (SQLSTATE 23503)',
    ]);
    expect(parsed.normalizedExcerpt).toBe([
      'error: database rejected row (SQLSTATE 23505)',
      'error: database rejected row (SQLSTATE 23503)',
    ].join('\n'));
  });

  it('falls back to the generic exit-code line when no richer failure signal exists', async () => {
    const { parseLog } = require('../src/log-parser');
    const log = await readFile(path.join(fixtureDir, 'github-actions-generic-exit-only.log'), 'utf8');

    const parsed = parseLog(log);

    expect(parsed.selectedLines).toEqual(['Process completed with exit code 1.']);
    expect(parsed.rawExcerpt).toBe('Process completed with exit code 1.');
  });

  it('accepts a plain generic exit-code line when it is the only failure signal', () => {
    const { parseLog } = require('../src/log-parser');
    const parsed = parseLog('Process completed with exit code 1.\nPost job cleanup.');

    expect(parsed.selectedLines).toEqual(['Process completed with exit code 1.']);
    expect(parsed.rawExcerpt).toBe('Process completed with exit code 1.');
  });
});

describe('history persistence', () => {
  it('merges repeated failures into rolling history while preserving first seen metadata', async () => {
    const { mkdtemp, readFile: readTempFile, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { loadHistory, mergeFailureIntoHistory, saveHistory } = require('../src/history');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-history-'));
    const historyPath = path.join(tempDir, 'history.json');

    try {
      const emptyHistory = await loadHistory(historyPath, 2);
      const mergedOnce = mergeFailureIntoHistory(
        emptyHistory,
        {
          fingerprint: 'fp-123',
          normalizedExcerpt: "Error: Cannot find module '<path>'",
        },
        {
          runId: 'run-1',
          timestamp: '2026-04-19T20:00:00.000Z',
          logPath: 'fixtures/repeated-node-error.log',
          maxRuns: 2,
        }
      );
      const mergedTwice = mergeFailureIntoHistory(
        mergedOnce,
        {
          fingerprint: 'fp-123',
          normalizedExcerpt: "Error: Cannot find module '<path>'",
        },
        {
          runId: 'run-2',
          timestamp: '2026-04-19T21:00:00.000Z',
          logPath: 'fixtures/repeated-node-error-variant.log',
          maxRuns: 2,
        }
      );
      const mergedThrice = mergeFailureIntoHistory(
        mergedTwice,
        {
          fingerprint: 'fp-123',
          normalizedExcerpt: "Error: Cannot find module '<path>'",
        },
        {
          runId: 'run-3',
          timestamp: '2026-04-19T22:00:00.000Z',
          logPath: 'fixtures/repeated-node-error.log',
          maxRuns: 2,
        }
      );

      await saveHistory(historyPath, mergedThrice);
      const reloadedHistory = await loadHistory(historyPath, 2);
      const historyJson = JSON.parse(await readTempFile(historyPath, 'utf8'));

      expect(mergedThrice.failures['fp-123']).toEqual({
        fingerprint: 'fp-123',
        normalizedExcerpt: "Error: Cannot find module '<path>'",
        firstSeenAt: '2026-04-19T20:00:00.000Z',
        lastSeenAt: '2026-04-19T22:00:00.000Z',
        seenCount: 3,
        recentRuns: [
          {
            runId: 'run-2',
            timestamp: '2026-04-19T21:00:00.000Z',
            logPath: 'fixtures/repeated-node-error-variant.log',
          },
          {
            runId: 'run-3',
            timestamp: '2026-04-19T22:00:00.000Z',
            logPath: 'fixtures/repeated-node-error.log',
          },
        ],
      });
      expect(mergedThrice.updatedAt).toBe('2026-04-19T22:00:00.000Z');
      expect(reloadedHistory).toEqual(mergedThrice);
      expect(historyJson).toEqual(mergedThrice);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('summary rendering', () => {
  it('renders markdown with recurrence details for the current fingerprint', () => {
    const { buildSummary } = require('../src/summary');

    const summary = buildSummary({
      fingerprint: 'abc123',
      seenCount: 3,
      firstSeenAt: '2026-04-19T20:00:00.000Z',
      lastSeenAt: '2026-04-19T22:00:00.000Z',
      normalizedExcerpt: "Error: Cannot find module '<path>'",
      recentRuns: [
        {
          runId: 'run-2',
          timestamp: '2026-04-19T21:00:00.000Z',
          logPath: 'logs/run-2.log',
        },
        {
          runId: 'run-3',
          timestamp: '2026-04-19T22:00:00.000Z',
          logPath: 'logs/run-3.log',
        },
      ],
    });

    expect(summary).toContain('# FailureMemory Summary');
    expect(summary).toContain('`abc123`');
    expect(summary).toContain('Seen count: **3**');
    expect(summary).toContain('First seen: `2026-04-19T20:00:00.000Z`');
    expect(summary).toContain('Last seen: `2026-04-19T22:00:00.000Z`');
    expect(summary).toContain("Error: Cannot find module '<path>'");
    expect(summary).toContain('## Recent occurrences');
    expect(summary).toContain('`run-2` at `2026-04-19T21:00:00.000Z` from `logs/run-2.log`');
  });
});

describe('runAction integration', () => {
  const originalFetch = global.fetch;

  function createActionRuntime(
    tempDir: string,
    inputs: Record<string, string>,
    overrides: Partial<{
      env: NodeJS.ProcessEnv;
      now: () => Date;
      stepSummaryPath: string;
      log: (message: string) => void;
      setFailed: (message: string) => void;
      setOutput: (name: string, value: string) => void;
    }> = {}
  ) {
    const outputs: Record<string, string> = {};
    const failures: string[] = [];

    return {
      outputs,
      failures,
      runtime: {
        getInput(name: string) {
          return inputs[name] ?? '';
        },
        setOutput(name: string, value: string) {
          outputs[name] = value;
        },
        setFailed(message: string) {
          failures.push(message);
        },
        cwd: tempDir,
        workspace: tempDir,
        stepSummaryPath: path.join(tempDir, 'output', 'step-summary.md'),
        now: () => new Date('2026-04-19T21:00:00.000Z'),
        log: () => undefined,
        env: {},
        ...overrides,
      },
    };
  }

  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  }

  function textResponse(body: string, init: ResponseInit = {}): Response {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      ...init,
    });
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads a log, updates history, writes a summary, and emits outputs', async () => {
    const { mkdtemp, mkdir, readFile: readTempFile, realpath: resolveRealpath, rm, writeFile } = require('node:fs/promises');
    const os = require('node:os');
    const { parseLog } = require('../src/log-parser');
    const { createFingerprint } = require('../src/fingerprint');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-action-'));
    const fixtureLogPath = path.join(__dirname, '..', 'fixtures', 'repeated-node-error.log');
    const priorLogPath = path.join(__dirname, '..', 'fixtures', 'repeated-node-error-variant.log');
    const currentWorkspaceLogPath = path.join(tempDir, 'logs', 'current.log');
    const priorWorkspaceLogPath = path.join(tempDir, 'logs', 'prior.log');
    const historyPath = path.join(tempDir, 'state', 'history.json');
    const summaryPath = path.join(tempDir, 'output', 'summary.md');
    const stepSummaryPath = path.join(tempDir, 'output', 'step-summary.md');
    const outputs: Record<string, string> = {};
    const currentLog = await readFile(fixtureLogPath, 'utf8');
    const variantLog = await readFile(priorLogPath, 'utf8');
    const priorParsed = parseLog(variantLog);
    const fingerprint = createFingerprint(priorParsed.normalizedExcerpt);

    try {
      await mkdir(path.dirname(historyPath), { recursive: true });
      await mkdir(path.dirname(summaryPath), { recursive: true });
      await mkdir(path.dirname(currentWorkspaceLogPath), { recursive: true });
      await writeFile(currentWorkspaceLogPath, currentLog);
      await writeFile(priorWorkspaceLogPath, variantLog);
      await writeFile(
        historyPath,
        `${JSON.stringify(
          {
            version: 1,
            maxRuns: 5,
            updatedAt: '2026-04-19T20:00:00.000Z',
            failures: {
              [fingerprint]: {
                fingerprint,
                normalizedExcerpt: priorParsed.normalizedExcerpt,
                firstSeenAt: '2026-04-19T20:00:00.000Z',
                lastSeenAt: '2026-04-19T20:00:00.000Z',
                seenCount: 1,
                recentRuns: [
                  {
                    runId: 'run-1',
                    timestamp: '2026-04-19T20:00:00.000Z',
                    logPath: priorWorkspaceLogPath,
                  },
                ],
              },
            },
          },
          null,
          2
        )}\n`
      );

      const runtime = {
        getInput(name: string) {
          const inputs: Record<string, string> = {
            log_path: 'logs/current.log',
            history_file: 'state/history.json',
            max_runs: '5',
            summary_file: 'output/summary.md',
          };

          return inputs[name] ?? '';
        },
        setOutput(name: string, value: string) {
          outputs[name] = value;
        },
        setFailed(message: string) {
          throw new Error(message);
        },
        cwd: tempDir,
        workspace: tempDir,
        stepSummaryPath,
        now: () => new Date('2026-04-19T21:00:00.000Z'),
        log: () => undefined,
      };

      const result = await runAction(runtime);
      const summaryMarkdown = await readTempFile(summaryPath, 'utf8');
      const stepSummary = await readTempFile(stepSummaryPath, 'utf8');
      const savedHistory = JSON.parse(await readTempFile(historyPath, 'utf8'));
      const resolvedHistoryPath = await resolveRealpath(historyPath);
      const resolvedSummaryPath = await resolveRealpath(summaryPath);

      expect(result).toEqual({
        fingerprint,
        seenCount: 2,
        historyPath: resolvedHistoryPath,
        summaryPath: resolvedSummaryPath,
      });
      expect(outputs).toEqual({
        fingerprint,
        seen_count: '2',
        history_path: resolvedHistoryPath,
        summary_path: resolvedSummaryPath,
      });
      expect(savedHistory.failures[fingerprint].firstSeenAt).toBe('2026-04-19T20:00:00.000Z');
      expect(savedHistory.failures[fingerprint].lastSeenAt).toBe('2026-04-19T21:00:00.000Z');
      expect(savedHistory.failures[fingerprint].seenCount).toBe(2);
      expect(summaryMarkdown).toContain(fingerprint);
      expect(summaryMarkdown).toContain("Error: Cannot find module '<path>'");
      expect(summaryMarkdown).toContain('## Recent occurrences');
      expect(stepSummary).toContain('# FailureMemory Summary');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fetches the newest failed run from GitHub mode, combines failed job logs deterministically, and records a synthetic source reference', async () => {
    const { mkdtemp, mkdir, readFile: readTempFile, realpath: resolveRealpath, rm, writeFile } = require('node:fs/promises');
    const os = require('node:os');
    const { parseLog } = require('../src/log-parser');
    const { createFingerprint } = require('../src/fingerprint');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-github-action-'));
    const historyPath = path.join(tempDir, 'state', 'history.json');
    const summaryPath = path.join(tempDir, 'output', 'summary.md');
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const earlierFailedJobLog = await readFile(path.join(fixtureDir, 'repeated-node-error.log'), 'utf8');
    const laterFailedJobLog = await readFile(path.join(fixtureDir, 'repeated-node-error-variant.log'), 'utf8');
    const priorParsed = parseLog(laterFailedJobLog);
    const fingerprint = createFingerprint(priorParsed.normalizedExcerpt);
    const syntheticSource = 'github://octo-org/octo-repo/actions/runs/300#jobs=21,22';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [
            {
              id: 301,
              conclusion: 'success',
              created_at: '2026-04-19T21:00:00Z',
            },
            {
              id: 300,
              conclusion: 'failure',
              created_at: '2026-04-19T20:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 22,
              name: 'test',
              conclusion: 'failure',
              started_at: '2026-04-19T20:05:00Z',
            },
            {
              id: 10,
              name: 'lint',
              conclusion: 'success',
              started_at: '2026-04-19T20:01:00Z',
            },
            {
              id: 21,
              name: 'build',
              conclusion: 'failure',
              started_at: '2026-04-19T20:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(earlierFailedJobLog))
      .mockResolvedValueOnce(textResponse(laterFailedJobLog));
    global.fetch = fetchMock as typeof fetch;

    try {
      await mkdir(path.dirname(historyPath), { recursive: true });
      await writeFile(
        historyPath,
        `${JSON.stringify(
          {
            version: 1,
            maxRuns: 5,
            updatedAt: '2026-04-19T20:00:00.000Z',
            failures: {
              [fingerprint]: {
                fingerprint,
                normalizedExcerpt: priorParsed.normalizedExcerpt,
                firstSeenAt: '2026-04-19T20:00:00.000Z',
                lastSeenAt: '2026-04-19T20:00:00.000Z',
                seenCount: 1,
                recentRuns: [
                  {
                    runId: '299',
                    timestamp: '2026-04-19T20:00:00.000Z',
                    logPath: 'github://octo-org/octo-repo/actions/runs/299#jobs=19',
                  },
                ],
              },
            },
          },
          null,
          2
        )}\n`
      );

      const { outputs, runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      }, {
        env: {
          GITHUB_REPOSITORY: 'octo-org/octo-repo',
          GITHUB_TOKEN: 'test-token',
        },
      });

      const result = await runAction(runtime);
      const summaryMarkdown = await readTempFile(summaryPath, 'utf8');
      const stepSummary = await readTempFile(path.join(tempDir, 'output', 'step-summary.md'), 'utf8');
      const savedHistory = JSON.parse(await readTempFile(historyPath, 'utf8'));
      const resolvedHistoryPath = await resolveRealpath(historyPath);
      const resolvedSummaryPath = await resolveRealpath(summaryPath);

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/300/jobs?per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/22/logs',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/21/logs',
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
      expect(result).toEqual({
        fingerprint,
        seenCount: 2,
        historyPath: resolvedHistoryPath,
        summaryPath: resolvedSummaryPath,
      });
      expect(outputs).toEqual({
        fingerprint,
        seen_count: '2',
        history_path: resolvedHistoryPath,
        summary_path: resolvedSummaryPath,
      });
      expect(savedHistory.failures[fingerprint].recentRuns).toEqual([
        {
          runId: '299',
          timestamp: '2026-04-19T20:00:00.000Z',
          logPath: 'github://octo-org/octo-repo/actions/runs/299#jobs=19',
        },
        {
          runId: '300',
          timestamp: '2026-04-19T21:00:00.000Z',
          logPath: syntheticSource,
        },
      ]);
      expect(summaryMarkdown).toContain(syntheticSource);
      expect(stepSummary).toContain('# FailureMemory Summary');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses an explicit github_run_id without listing workflow runs first', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-github-run-id-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const failedJobLog = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 77,
              name: 'publish',
              conclusion: 'failure',
              started_at: '2026-04-19T20:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(failedJobLog));
    global.fetch = fetchMock as typeof fetch;

    try {
      const { runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        github_run_id: '777',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      });

      await runAction(runtime);

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/777/jobs?per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/77/logs',
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/777/jobs?per_page=100&page=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer input-token',
          }),
        })
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects non-numeric github_run_id values before calling the GitHub API', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-invalid-github-run-id-'));
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    const { failures, runtime } = createActionRuntime(tempDir, {
      fetch_mode: 'github',
      github_repository: 'octo-org/octo-repo',
      github_token: 'input-token',
      github_run_id: 'abc',
      history_file: 'state/history.json',
      max_runs: '5',
      summary_file: 'output/summary.md',
    });

    try {
      await expect(runAction(runtime)).rejects.toThrow('github_run_id must be a positive integer');
      expect(failures).toContainEqual(
        expect.stringContaining('github_run_id must be a positive integer')
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores github_run_id validation in file mode', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-file-mode-github-run-id-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const logPath = path.join(tempDir, 'logs', 'current.log');
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;

    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(logPath, await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8'));
      const { runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'file',
        log_path: 'logs/current.log',
        github_run_id: 'abc',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      });

      const result = await runAction(runtime);

      expect(result.seenCount).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('paginates workflow run jobs until it finds failed jobs on later pages', async () => {
    const { mkdtemp, readFile: readTempFile, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-job-pagination-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const failedJobLog = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');
    const firstPageJobs = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `success-${index + 1}`,
      conclusion: 'success',
      started_at: `2026-04-19T20:${String(index % 60).padStart(2, '0')}:00Z`,
    }));
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: firstPageJobs,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 901,
              name: 'publish',
              conclusion: 'failure',
              started_at: '2026-04-19T21:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(failedJobLog));
    global.fetch = fetchMock as typeof fetch;

    try {
      const { runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        github_run_id: '777',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      });

      const result = await runAction(runtime);
      const summaryMarkdown = await readTempFile(path.join(tempDir, 'output', 'summary.md'), 'utf8');

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/777/jobs?per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/777/jobs?per_page=100&page=2',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/901/logs',
      ]);
      expect(result.seenCount).toBe(1);
      expect(summaryMarkdown).toContain('HTTP 403');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps GitHub-mode fingerprints stable when failed job ids and timestamps change across reruns', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-github-order-stability-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const moduleLog = await readFile(path.join(fixtureDir, 'repeated-node-error.log'), 'utf8');
    const artifactLog = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');
    const firstFetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 21,
              name: 'matrix',
              conclusion: 'failure',
              started_at: '2026-04-19T20:00:00Z',
            },
            {
              id: 22,
              name: 'matrix',
              conclusion: 'failure',
              started_at: '2026-04-19T20:05:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(moduleLog))
      .mockResolvedValueOnce(textResponse(artifactLog));
    const secondFetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 91,
              name: 'matrix',
              conclusion: 'failure',
              started_at: '2026-04-20T20:05:00Z',
            },
            {
              id: 90,
              name: 'matrix',
              conclusion: 'failure',
              started_at: '2026-04-20T20:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(artifactLog))
      .mockResolvedValueOnce(textResponse(moduleLog));

    try {
      global.fetch = firstFetchMock as typeof fetch;
      const firstRun = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        github_run_id: '777',
        history_file: 'state/history-one.json',
        max_runs: '5',
        summary_file: 'output/summary-one.md',
      });
      const firstResult = await runAction(firstRun.runtime);

      global.fetch = secondFetchMock as typeof fetch;
      const secondRun = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        github_run_id: '778',
        history_file: 'state/history-two.json',
        max_runs: '5',
        summary_file: 'output/summary-two.md',
      });
      const secondResult = await runAction(secondRun.runtime);

      expect(firstResult.fingerprint).toBe(secondResult.fingerprint);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('paginates completed workflow runs until it finds the newest failed run', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-run-pagination-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const failedJobLog = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');
    const firstPageRuns = Array.from({ length: 100 }, (_, index) => ({
      id: 500 + index,
      conclusion: 'success',
      created_at: `2026-04-19T20:${String(index % 60).padStart(2, '0')}:00Z`,
    }));
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: firstPageRuns,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [
            {
              id: 300,
              conclusion: 'failure',
              created_at: '2026-04-18T20:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 77,
              name: 'publish',
              conclusion: 'failure',
              started_at: '2026-04-18T20:05:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(failedJobLog));
    global.fetch = fetchMock as typeof fetch;

    try {
      const { runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      });

      const result = await runAction(runtime);

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=2',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/300/jobs?per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/77/logs',
      ]);
      expect(result.seenCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers the most recently updated failed run when auto-selecting a GitHub run', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-updated-run-selection-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const failedJobLog = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [
            {
              id: 300,
              conclusion: 'failure',
              created_at: '2026-04-18T20:00:00Z',
              updated_at: '2026-04-19T21:00:00Z',
            },
            {
              id: 301,
              conclusion: 'failure',
              created_at: '2026-04-19T20:30:00Z',
              updated_at: '2026-04-19T20:35:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 88,
              name: 'publish',
              conclusion: 'failure',
              started_at: '2026-04-19T21:05:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(failedJobLog));
    global.fetch = fetchMock as typeof fetch;

    try {
      const { runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      });

      await runAction(runtime);

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/300/jobs?per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/88/logs',
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('picks the most recently updated failed run even when it appears on a later page', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-cross-page-updated-run-selection-'));
    const fixtureDir = path.join(__dirname, '..', 'fixtures');
    const failedJobLog = await readFile(path.join(fixtureDir, 'github-actions-artifact-403.log'), 'utf8');
    const firstPageRuns: Array<{ id: number; conclusion: string; created_at: string; updated_at?: string }> = Array.from({
      length: 99,
    }, (_, index) => ({
      id: 600 + index,
      conclusion: 'success',
      created_at: `2026-04-19T22:${String(index % 60).padStart(2, '0')}:00Z`,
    }));
    firstPageRuns.push({
      id: 300,
      conclusion: 'failure',
      created_at: '2026-04-18T20:00:00Z',
      updated_at: '2026-04-19T20:00:00Z',
    });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: firstPageRuns,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [
            {
              id: 200,
              conclusion: 'failure',
              created_at: '2026-04-17T20:00:00Z',
              updated_at: '2026-04-19T21:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 99,
              name: 'publish',
              conclusion: 'failure',
              started_at: '2026-04-19T21:05:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(textResponse(failedJobLog));
    global.fetch = fetchMock as typeof fetch;

    try {
      const { runtime } = createActionRuntime(tempDir, {
        fetch_mode: 'github',
        github_repository: 'octo-org/octo-repo',
        github_token: 'input-token',
        history_file: 'state/history.json',
        max_runs: '5',
        summary_file: 'output/summary.md',
      });

      await runAction(runtime);

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs?status=completed&per_page=100&page=2',
        'https://api.github.com/repos/octo-org/octo-repo/actions/runs/200/jobs?per_page=100&page=1',
        'https://api.github.com/repos/octo-org/octo-repo/actions/jobs/99/logs',
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails early when GitHub mode is missing a token', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-missing-token-'));
    const { failures, runtime } = createActionRuntime(tempDir, {
      fetch_mode: 'github',
      history_file: 'state/history.json',
      max_runs: '5',
      summary_file: 'output/summary.md',
    }, {
      env: {
        GITHUB_REPOSITORY: 'octo-org/octo-repo',
      },
    });

    try {
      await expect(runAction(runtime)).rejects.toThrow('github_token is required when fetch_mode is github');
      expect(failures).toContainEqual(
        expect.stringContaining('github_token is required when fetch_mode is github')
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails early when GitHub mode cannot resolve a repository', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-missing-repository-'));
    const { failures, runtime } = createActionRuntime(tempDir, {
      fetch_mode: 'github',
      github_token: 'input-token',
      history_file: 'state/history.json',
      max_runs: '5',
      summary_file: 'output/summary.md',
    });

    try {
      await expect(runAction(runtime)).rejects.toThrow('github_repository is required when fetch_mode is github');
      expect(failures).toContainEqual(
        expect.stringContaining('github_repository is required when fetch_mode is github')
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when GitHub mode cannot find a failed run', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-no-failed-runs-'));
    const fetchMock = jest.fn().mockResolvedValueOnce(
      jsonResponse({
        workflow_runs: [
          {
            id: 301,
            conclusion: 'success',
            created_at: '2026-04-19T21:00:00Z',
          },
        ],
      })
    );
    global.fetch = fetchMock as typeof fetch;
    const { failures, runtime } = createActionRuntime(tempDir, {
      fetch_mode: 'github',
      history_file: 'state/history.json',
      max_runs: '5',
      summary_file: 'output/summary.md',
    }, {
      env: {
        GITHUB_REPOSITORY: 'octo-org/octo-repo',
        GITHUB_TOKEN: 'test-token',
      },
    });

    try {
      await expect(runAction(runtime)).rejects.toThrow('No failed workflow runs found for octo-org/octo-repo.');
      expect(failures).toContainEqual(
        expect.stringContaining('No failed workflow runs found for octo-org/octo-repo.')
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when GitHub mode finds no failed jobs for the selected run', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-no-failed-jobs-'));
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [
            {
              id: 300,
              conclusion: 'failure',
              created_at: '2026-04-19T20:00:00Z',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              id: 10,
              name: 'lint',
              conclusion: 'success',
              started_at: '2026-04-19T20:01:00Z',
            },
          ],
        })
      );
    global.fetch = fetchMock as typeof fetch;
    const { failures, runtime } = createActionRuntime(tempDir, {
      fetch_mode: 'github',
      history_file: 'state/history.json',
      max_runs: '5',
      summary_file: 'output/summary.md',
    }, {
      env: {
        GITHUB_REPOSITORY: 'octo-org/octo-repo',
        GITHUB_TOKEN: 'test-token',
      },
    });

    try {
      await expect(runAction(runtime)).rejects.toThrow('No failed jobs found for workflow run 300 in octo-org/octo-repo.');
      expect(failures).toContainEqual(
        expect.stringContaining('No failed jobs found for workflow run 300 in octo-org/octo-repo.')
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces non-OK GitHub API responses with context', async () => {
    const { mkdtemp, rm } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-github-api-error-'));
    const fetchMock = jest.fn().mockResolvedValueOnce(
      textResponse('rate limited', {
        status: 403,
        statusText: 'Forbidden',
      })
    );
    global.fetch = fetchMock as typeof fetch;
    const { failures, runtime } = createActionRuntime(tempDir, {
      fetch_mode: 'github',
      history_file: 'state/history.json',
      max_runs: '5',
      summary_file: 'output/summary.md',
    }, {
      env: {
        GITHUB_REPOSITORY: 'octo-org/octo-repo',
        GITHUB_TOKEN: 'test-token',
      },
    });

    try {
      await expect(runAction(runtime)).rejects.toThrow(
        'GitHub API request failed for workflow runs in octo-org/octo-repo (page 1): 403 Forbidden - rate limited'
      );
      expect(failures).toContainEqual(
        expect.stringContaining(
          'GitHub API request failed for workflow runs in octo-org/octo-repo (page 1): 403 Forbidden - rate limited'
        )
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects max_runs values that are not positive integers', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-invalid-max-runs-'));
    const logSourcePath = path.join(__dirname, '..', 'fixtures', 'repeated-node-error.log');
    const workspaceLogPath = path.join(tempDir, 'logs', 'current.log');
    const failures: string[] = [];

    try {
      await mkdir(path.dirname(workspaceLogPath), { recursive: true });
      await writeFile(workspaceLogPath, await readFile(logSourcePath, 'utf8'));

      const runtime = {
        getInput(name: string) {
          const inputs: Record<string, string> = {
            log_path: 'logs/current.log',
            history_file: 'state/history.json',
            max_runs: '1.5',
            summary_file: 'output/summary.md',
          };

          return inputs[name] ?? '';
        },
        setOutput() {
          return undefined;
        },
        setFailed(message: string) {
          failures.push(message);
        },
        cwd: tempDir,
        workspace: tempDir,
        stepSummaryPath: path.join(tempDir, 'output', 'step-summary.md'),
        now: () => new Date('2026-04-19T21:00:00.000Z'),
        log: () => undefined,
      };

      await expect(runAction(runtime)).rejects.toThrow('max_runs must be a positive integer');
      expect(failures).toContainEqual(expect.stringContaining('max_runs must be a positive integer'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects path escapes outside the workspace', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-path-escape-'));
    const logSourcePath = path.join(__dirname, '..', 'fixtures', 'repeated-node-error.log');
    const workspaceLogPath = path.join(tempDir, 'logs', 'current.log');

    try {
      await mkdir(path.dirname(workspaceLogPath), { recursive: true });
      await writeFile(workspaceLogPath, await readFile(logSourcePath, 'utf8'));

      const runtime = {
        getInput(name: string) {
          const inputs: Record<string, string> = {
            log_path: 'logs/current.log',
            history_file: '../outside/history.json',
            max_runs: '5',
            summary_file: 'output/summary.md',
          };

          return inputs[name] ?? '';
        },
        setOutput() {
          return undefined;
        },
        setFailed() {
          return undefined;
        },
        cwd: tempDir,
        workspace: tempDir,
        stepSummaryPath: path.join(tempDir, 'output', 'step-summary.md'),
        now: () => new Date('2026-04-19T21:00:00.000Z'),
        log: () => undefined,
      };

      await expect(runAction(runtime)).rejects.toThrow('history_file must stay within the workspace');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects symlink-based path escapes outside the workspace', async () => {
    const { mkdtemp, mkdir, rm, symlink, writeFile } = require('node:fs/promises');
    const os = require('node:os');
    const { runAction } = require('../src/index');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-symlink-escape-'));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'failurememory-symlink-outside-'));
    const logSourcePath = path.join(__dirname, '..', 'fixtures', 'repeated-node-error.log');
    const workspaceLogPath = path.join(tempDir, 'logs', 'current.log');
    const symlinkPath = path.join(tempDir, 'alias');

    try {
      await mkdir(path.dirname(workspaceLogPath), { recursive: true });
      await writeFile(workspaceLogPath, await readFile(logSourcePath, 'utf8'));
      await symlink(outsideDir, symlinkPath);

      const runtime = {
        getInput(name: string) {
          const inputs: Record<string, string> = {
            log_path: 'logs/current.log',
            history_file: 'alias/history.json',
            max_runs: '5',
            summary_file: 'alias/summary.md',
          };

          return inputs[name] ?? '';
        },
        setOutput() {
          return undefined;
        },
        setFailed() {
          return undefined;
        },
        cwd: tempDir,
        workspace: tempDir,
        stepSummaryPath: path.join(tempDir, 'output', 'step-summary.md'),
        now: () => new Date('2026-04-19T21:00:00.000Z'),
        log: () => undefined,
      };

      await expect(runAction(runtime)).rejects.toThrow('history_file must stay within the workspace');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
