import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as core from '@actions/core';
import { createFingerprint } from './fingerprint';
import { loadHistory, mergeFailureIntoHistory, saveHistory } from './history';
import { parseLog } from './log-parser';
import { buildSummary } from './summary';
import type { ActionInputs, ActionResult, ActionRuntime } from './types';

function createRuntime(): ActionRuntime {
  return {
    getInput: (name, options) => core.getInput(name, options),
    setOutput: (name, value) => core.setOutput(name, value),
    setFailed: message => core.setFailed(message),
    cwd: process.cwd(),
    workspace: process.env.GITHUB_WORKSPACE,
    stepSummaryPath: process.env.GITHUB_STEP_SUMMARY,
    now: () => new Date(),
    log: message => core.info(message),
  };
}

function parsePositiveInteger(value: string, inputName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${inputName} must be a positive integer. Received: ${value}`);
  }

  return Number.parseInt(value, 10);
}

async function resolveActualPath(candidate: string): Promise<string> {
  const missingSegments: string[] = [];
  let current = path.resolve(candidate);

  while (true) {
    try {
      const resolved = await realpath(current);
      return path.join(resolved, ...missingSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }

      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function resolveWithinWorkspace(workspace: string, candidate: string, inputName: string): Promise<string> {
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspace, candidate);
  const workspaceRoot = await realpath(workspace);
  const actualResolved = await resolveActualPath(resolved);
  const relative = path.relative(workspaceRoot, actualResolved);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return actualResolved;
  }

  throw new Error(`${inputName} must stay within the workspace. Received: ${candidate}`);
}

function readInputs(runtime: ActionRuntime): ActionInputs {
  return {
    logPath: runtime.getInput('log_path', { required: true }),
    historyFile: runtime.getInput('history_file', { required: true }),
    maxRuns: parsePositiveInteger(runtime.getInput('max_runs') || '10', 'max_runs'),
    summaryFile: runtime.getInput('summary_file') || '.failurememory/failurememory-summary.md',
  };
}

async function writeSummary(summaryPath: string, markdown: string, stepSummaryPath?: string): Promise<void> {
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, markdown, 'utf8');

  if (stepSummaryPath) {
    await mkdir(path.dirname(stepSummaryPath), { recursive: true });
    await appendFile(stepSummaryPath, `${markdown}\n`, 'utf8');
  }
}

export async function runAction(runtime: ActionRuntime = createRuntime()): Promise<ActionResult> {
  try {
    const inputs = readInputs(runtime);
    const workspace = path.resolve(runtime.workspace ?? runtime.cwd);
    const logPath = await resolveWithinWorkspace(workspace, inputs.logPath, 'log_path');
    const historyPath = await resolveWithinWorkspace(workspace, inputs.historyFile, 'history_file');
    const summaryPath = await resolveWithinWorkspace(workspace, inputs.summaryFile, 'summary_file');
    const timestamp = runtime.now().toISOString();
    const runId = process.env.GITHUB_RUN_ID?.trim() || timestamp;
    const logText = await readFile(logPath, 'utf8');
    const parsedFailure = parseLog(logText);
    const fingerprint = createFingerprint(parsedFailure.normalizedExcerpt);
    const history = await loadHistory(historyPath, inputs.maxRuns);
    const mergedHistory = mergeFailureIntoHistory(
      history,
      {
        fingerprint,
        normalizedExcerpt: parsedFailure.normalizedExcerpt,
      },
      {
        runId,
        timestamp,
        logPath,
        maxRuns: inputs.maxRuns,
      }
    );
    const currentRecord = mergedHistory.failures[fingerprint];
    const summaryMarkdown = buildSummary(currentRecord);

    await saveHistory(historyPath, mergedHistory);
    await writeSummary(summaryPath, summaryMarkdown, runtime.stepSummaryPath);

    runtime.setOutput('fingerprint', fingerprint);
    runtime.setOutput('seen_count', String(currentRecord.seenCount));
    runtime.setOutput('history_path', historyPath);
    runtime.setOutput('summary_path', summaryPath);
    runtime.log(`FailureMemory recorded fingerprint ${fingerprint} with seen count ${currentRecord.seenCount}.`);

    return {
      fingerprint,
      seenCount: currentRecord.seenCount,
      historyPath,
      summaryPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.setFailed(`FailureMemory failed: ${message}`);
    throw error;
  }
}

if (require.main === module) {
  runAction().catch(() => {
    process.exitCode = 1;
  });
}
