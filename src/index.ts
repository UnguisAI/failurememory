import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as core from '@actions/core';
import { createFingerprint } from './fingerprint';
import { loadHistory, mergeFailureIntoHistory, saveHistory } from './history';
import { parseLog } from './log-parser';
import { buildSummary } from './summary';
import type { ActionInputs, ActionResult, ActionRuntime, FetchMode } from './types';

interface GitHubWorkflowRun {
  id: number;
  conclusion?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface GitHubWorkflowRunsResponse {
  workflow_runs?: GitHubWorkflowRun[];
}

interface GitHubJob {
  id: number;
  name?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
}

interface GitHubJobsResponse {
  jobs?: GitHubJob[];
}

interface FetchedGitHubJobLog {
  job: GitHubJob;
  logText: string;
  sortKey: string;
}

interface LogSource {
  logText: string;
  logReference: string;
  runId: string;
}

const GITHUB_PER_PAGE = 100;

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
    env: process.env,
  };
}

function parsePositiveInteger(value: string, inputName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${inputName} must be a positive integer. Received: ${value}`);
  }

  return Number.parseInt(value, 10);
}

function normalizeOptionalValue(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function parseFetchMode(value: string): FetchMode {
  const normalized = normalizeOptionalValue(value).toLowerCase();

  if (normalized === '' || normalized === 'file') {
    return 'file';
  }

  if (normalized === 'github') {
    return 'github';
  }

  throw new Error(`fetch_mode must be one of: file, github. Received: ${value}`);
}

function getEnv(runtime: ActionRuntime): NodeJS.ProcessEnv {
  return runtime.env ?? process.env;
}

function parseOptionalPositiveInteger(value: string, inputName: string): string {
  const normalized = normalizeOptionalValue(value);

  if (normalized === '') {
    return '';
  }

  return String(parsePositiveInteger(normalized, inputName));
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
    fetchMode: parseFetchMode(runtime.getInput('fetch_mode')),
    logPath: runtime.getInput('log_path'),
    historyFile: runtime.getInput('history_file', { required: true }),
    maxRuns: parsePositiveInteger(runtime.getInput('max_runs') || '10', 'max_runs'),
    summaryFile: runtime.getInput('summary_file') || '.failurememory/failurememory-summary.md',
    githubRepository: runtime.getInput('github_repository'),
    githubToken: runtime.getInput('github_token'),
    githubRunId: runtime.getInput('github_run_id'),
  };
}

function createGitHubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'failurememory',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchGitHubResponse(url: string, context: string, token: string): Promise<Response> {
  const response = await fetch(url, {
    headers: createGitHubHeaders(token),
  });

  if (response.ok) {
    return response;
  }

  const responseBody = (await response.text()).trim();
  const suffix = responseBody === '' ? '' : ` - ${responseBody}`;
  throw new Error(`GitHub API request failed for ${context}: ${response.status} ${response.statusText}${suffix}`);
}

async function fetchGitHubJson<T>(url: string, context: string, token: string): Promise<T> {
  const response = await fetchGitHubResponse(url, context, token);
  return response.json() as Promise<T>;
}

async function fetchGitHubText(url: string, context: string, token: string): Promise<string> {
  const response = await fetchGitHubResponse(url, context, token);
  return response.text();
}

function parseIsoTimestamp(value?: string | null): number {
  if (!value) {
    return Number.NaN;
  }

  return Date.parse(value);
}

function buildFetchedJobSortKey(job: GitHubJob, logText: string): string {
  const normalizedJobName = normalizeOptionalValue(job.name).toLowerCase();

  try {
    return [normalizedJobName, parseLog(logText).normalizedExcerpt].join('\n');
  } catch {
    return [normalizedJobName, logText.trim()].join('\n');
  }
}

function compareStableStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function sortFetchedGitHubJobLogs(jobLogs: FetchedGitHubJobLog[]): FetchedGitHubJobLog[] {
  return [...jobLogs].sort((left, right) => {
    const sortKeyDelta = compareStableStrings(left.sortKey, right.sortKey);
    if (sortKeyDelta !== 0) {
      return sortKeyDelta;
    }

    return left.job.id - right.job.id;
  });
}

function selectNewestFailedRun(runs: GitHubWorkflowRun[]): GitHubWorkflowRun | undefined {
  const failedRuns = runs.filter(run => run.conclusion === 'failure');

  return failedRuns.sort((left, right) => {
    const leftTimestamp = Number.isNaN(parseIsoTimestamp(left.updated_at ?? left.created_at))
      ? 0
      : parseIsoTimestamp(left.updated_at ?? left.created_at);
    const rightTimestamp = Number.isNaN(parseIsoTimestamp(right.updated_at ?? right.created_at))
      ? 0
      : parseIsoTimestamp(right.updated_at ?? right.created_at);

    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return right.id - left.id;
  })[0];
}

function formatGitHubJobHeader(repository: string, runId: string, job: GitHubJob): string {
  const jobName = normalizeOptionalValue(job.name);
  return jobName === ''
    ? `===== ${repository} run ${runId} job ${job.id} =====`
    : `===== ${repository} run ${runId} job ${job.id} (${jobName}) =====`;
}

async function fetchFailedJobs(repository: string, runId: string, token: string): Promise<GitHubJob[]> {
  const failedJobs: GitHubJob[] = [];

  for (let page = 1; ; page += 1) {
    const jobsResponse = await fetchGitHubJson<GitHubJobsResponse>(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=${GITHUB_PER_PAGE}&page=${page}`,
      `workflow run jobs for ${runId} in ${repository} (page ${page})`,
      token
    );
    const pageJobs = jobsResponse.jobs ?? [];
    failedJobs.push(...pageJobs.filter(job => job.conclusion === 'failure'));

    if (pageJobs.length < GITHUB_PER_PAGE) {
      break;
    }
  }

  return failedJobs;
}

async function selectNewestFailedRunId(repository: string, token: string): Promise<string> {
  const failedRuns: GitHubWorkflowRun[] = [];

  for (let page = 1; ; page += 1) {
    const runsResponse = await fetchGitHubJson<GitHubWorkflowRunsResponse>(
      `https://api.github.com/repos/${repository}/actions/runs?status=completed&per_page=${GITHUB_PER_PAGE}&page=${page}`,
      `workflow runs in ${repository} (page ${page})`,
      token
    );
    const pageRuns = runsResponse.workflow_runs ?? [];
    failedRuns.push(...pageRuns.filter(run => run.conclusion === 'failure'));

    if (pageRuns.length < GITHUB_PER_PAGE) {
      break;
    }
  }

  const selectedRun = selectNewestFailedRun(failedRuns);
  if (selectedRun) {
    return String(selectedRun.id);
  }

  throw new Error(`No failed workflow runs found for ${repository}.`);
}

async function resolveGitHubLogSource(inputs: ActionInputs, runtime: ActionRuntime): Promise<LogSource> {
  const env = getEnv(runtime);
  const repository = normalizeOptionalValue(inputs.githubRepository) || normalizeOptionalValue(env.GITHUB_REPOSITORY);
  const token = normalizeOptionalValue(inputs.githubToken)
    || normalizeOptionalValue(env.GITHUB_TOKEN)
    || normalizeOptionalValue(env.GH_TOKEN);

  if (token === '') {
    throw new Error('github_token is required when fetch_mode is github.');
  }

  if (repository === '') {
    throw new Error('github_repository is required when fetch_mode is github.');
  }

  let runId = parseOptionalPositiveInteger(inputs.githubRunId, 'github_run_id');

  if (runId === '') {
    runId = await selectNewestFailedRunId(repository, token);
  }

  const failedJobs = await fetchFailedJobs(repository, runId, token);

  if (failedJobs.length === 0) {
    throw new Error(`No failed jobs found for workflow run ${runId} in ${repository}.`);
  }

  const fetchedJobLogs: FetchedGitHubJobLog[] = [];
  for (const job of failedJobs) {
    const logText = await fetchGitHubText(
      `https://api.github.com/repos/${repository}/actions/jobs/${job.id}/logs`,
      `job logs for ${job.id} in ${repository}`,
      token
    );

    fetchedJobLogs.push({
      job,
      logText,
      sortKey: buildFetchedJobSortKey(job, logText),
    });
  }

  const orderedJobLogs = sortFetchedGitHubJobLogs(fetchedJobLogs);
  const sections = orderedJobLogs.map(({ job, logText }) => [
    formatGitHubJobHeader(repository, runId, job),
    logText.trimEnd(),
  ].join('\n'));

  return {
    logText: sections.join('\n\n'),
    logReference: `github://${repository}/actions/runs/${runId}#jobs=${orderedJobLogs.map(({ job }) => job.id).join(',')}`,
    runId,
  };
}

async function resolveLogSource(inputs: ActionInputs, runtime: ActionRuntime, workspace: string): Promise<LogSource> {
  const env = getEnv(runtime);

  if (inputs.fetchMode === 'github') {
    return resolveGitHubLogSource(inputs, runtime);
  }

  const logPathInput = normalizeOptionalValue(inputs.logPath);
  if (logPathInput === '') {
    throw new Error('log_path is required when fetch_mode is file.');
  }

  const logPath = await resolveWithinWorkspace(workspace, logPathInput, 'log_path');

  return {
    logText: await readFile(logPath, 'utf8'),
    logReference: logPath,
    runId: normalizeOptionalValue(env.GITHUB_RUN_ID) || runtime.now().toISOString(),
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
    const historyPath = await resolveWithinWorkspace(workspace, inputs.historyFile, 'history_file');
    const summaryPath = await resolveWithinWorkspace(workspace, inputs.summaryFile, 'summary_file');
    const logSource = await resolveLogSource(inputs, runtime, workspace);
    const timestamp = runtime.now().toISOString();
    const parsedFailure = parseLog(logSource.logText);
    const fingerprint = createFingerprint(parsedFailure.normalizedExcerpt);
    const history = await loadHistory(historyPath, inputs.maxRuns);
    const mergedHistory = mergeFailureIntoHistory(
      history,
      {
        fingerprint,
        normalizedExcerpt: parsedFailure.normalizedExcerpt,
      },
      {
        runId: logSource.runId,
        timestamp,
        logPath: logSource.logReference,
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
