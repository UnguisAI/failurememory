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
    expect(parsed.normalizedExcerpt).toBe('gh: Resource not accessible by integration (HTTP <id>)');
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
