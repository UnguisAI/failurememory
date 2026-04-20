export interface ParsedFailure {
  rawExcerpt: string;
  normalizedExcerpt: string;
  selectedLines: string[];
}

export interface FingerprintedFailure extends ParsedFailure {
  fingerprint: string;
}

export interface FailureRunReference {
  runId: string;
  timestamp: string;
  logPath: string;
}

export interface FailureHistoryRecord {
  fingerprint: string;
  normalizedExcerpt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  recentRuns: FailureRunReference[];
}

export interface HistorySnapshot {
  version: 1;
  maxRuns: number;
  updatedAt: string;
  failures: Record<string, FailureHistoryRecord>;
}

export interface MergeFailureOptions extends FailureRunReference {
  maxRuns: number;
}

export type FetchMode = 'file' | 'github';

export interface ActionInputs {
  fetchMode: FetchMode;
  logPath: string;
  historyFile: string;
  maxRuns: number;
  summaryFile: string;
  githubRepository: string;
  githubToken: string;
  githubRunId: string;
}

export interface ActionResult {
  fingerprint: string;
  seenCount: number;
  historyPath: string;
  summaryPath: string;
}

export interface ActionRuntime {
  getInput(name: string, options?: { required?: boolean }): string;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  cwd: string;
  workspace?: string;
  stepSummaryPath?: string;
  now(): Date;
  log(message: string): void;
  env?: NodeJS.ProcessEnv;
}
