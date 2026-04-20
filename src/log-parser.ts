import type { ParsedFailure } from './types';

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const GITHUB_ACTIONS_LINE_PATTERN = /^[^\t]+\t[^\t]*\t(?:\uFEFF)?(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*)?(.*)$/;
const LEADING_TIMESTAMP_PATTERN = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}[:_]\d{2}[:_]\d{2}(?:\.\d+)?Z\s*/;
const GITHUB_ERROR_PREFIX_PATTERN = /^##\[error\]\s*/i;
const GENERIC_EXIT_CODE_PATTERN = /^process completed with exit code\s+(?!0\b)\d+\.?$/i;
const GENERIC_COMMAND_WRAPPER_PATTERN = /^(?:error:\s+|error\s+|elifecycle\s+)?command failed(?:\s+with exit code\s+(?!0\b)\d+\.?|:)/i;

const ERROR_LINE_PATTERNS = [
  /^error:/i,
  /assertionerror/i,
  /module not found/i,
  /cannot find module/i,
  /npm err!/i,
  /require stack/i,
  /command(?:\s+\S+){0,3}\s+failed/i,
  /\bHTTP\s+[45]\d{2}\b/i,
  /^\w*exception(?::|\b)/i,
  /\b(?:uncaught|unhandled)\s+exception\b/i,
  /^traceback/i,
  /caused by:/i,
  /\bfatal:/i,
  /\bundefined\b.+\b(?:no field or method|not found)\b/i,
  /\bbuilding task\b.*\bfailed\./i,
  /^make:\s+\*\*\*/i,
];

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_PATTERN, '');
}

function stripGitHubActionsPrefix(line: string): string {
  const trimmedLine = stripAnsi(line).replace(/^\uFEFF/, '').trim();
  const match = trimmedLine.match(GITHUB_ACTIONS_LINE_PATTERN);
  return (match?.[1] ?? trimmedLine).trim();
}

function stripGitHubErrorPrefix(line: string): string {
  return line.replace(GITHUB_ERROR_PREFIX_PATTERN, '').trim();
}

function stripLeadingTimestamp(line: string): string {
  return line.replace(LEADING_TIMESTAMP_PATTERN, '').trim();
}

function hasGitHubErrorPrefix(line: string): boolean {
  return GITHUB_ERROR_PREFIX_PATTERN.test(line) || GITHUB_ERROR_PREFIX_PATTERN.test(stripLeadingTimestamp(line));
}

function stripSignalNoise(line: string): string {
  let cleaned = stripGitHubActionsPrefix(line);

  while (true) {
    const next = stripGitHubErrorPrefix(stripLeadingTimestamp(cleaned));
    if (next === cleaned) {
      return next;
    }

    cleaned = next;
  }
}

function classifyLine(line: string): {
  cleanedLine: string;
  matchableLine: string;
  isFailure: boolean;
  isGenericExitCode: boolean;
  includeFollowingStackLine: boolean;
} {
  const workflowLine = stripGitHubActionsPrefix(line);
  const cleanedLine = stripSignalNoise(line);
  const matchableLine = cleanedLine;
  const isGitHubError = hasGitHubErrorPrefix(workflowLine);
  const isGenericCommandWrapper = GENERIC_COMMAND_WRAPPER_PATTERN.test(matchableLine);
  const isGenericExitCode = GENERIC_EXIT_CODE_PATTERN.test(matchableLine) || isGenericCommandWrapper;
  const isFailure = isGitHubError || isGenericExitCode || ERROR_LINE_PATTERNS.some(pattern => pattern.test(matchableLine));

  return {
    cleanedLine,
    matchableLine,
    isFailure,
    isGenericExitCode,
    includeFollowingStackLine: /require stack/i.test(matchableLine),
  };
}

function normalizePathLikeContent(line: string): string {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}[:_]\d{2}[:_]\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<timestamp>')
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<sha>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/gi, '<duration>')
    .replace(/(['"])(?:[A-Za-z]:\\[^'"]+|\/[^'"\n]+)\1/g, "$1<path>$1")
    .replace(/(^|\s)(?:[A-Za-z]:\\\S+|\/\S+)/g, '$1<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVolatileNumericIds(line: string): string {
  return line.replace(/\b\d{3,}\b/g, (match, offset, source) => {
    const before = source.slice(0, offset).toLowerCase();
    const after = source.slice(offset + match.length);
    const previousChar = source[offset - 1] ?? '';
    const nextChar = after[0] ?? '';

    if (/\b(?:http|port|sqlstate)\W*$/.test(before)) {
      return match;
    }

    if (previousChar === ':' || nextChar === ':') {
      return match;
    }

    if (/\b(artifact|run|job|build|attempt|workflow|check|id)\s*#?\s*$/.test(before)) {
      return '<id>';
    }

    return '<id>';
  });
}

function normalizeLine(line: string): string {
  return normalizeVolatileNumericIds(normalizePathLikeContent(stripSignalNoise(line)));
}

function buildDeduplicationKey(line: string): string {
  return normalizeVolatileNumericIds(normalizePathLikeContent(stripSignalNoise(line)));
}

export function parseLog(logText: string): ParsedFailure {
  const lines = logText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('Log file is empty or contains only whitespace.');
  }

  const selectedLines: Array<{ line: string; isGenericExitCode: boolean }> = [];
  let includeFollowingStackLine = false;

  for (const line of lines) {
    const classification = classifyLine(line);

    if (classification.isFailure) {
      selectedLines.push({
        line: classification.cleanedLine,
        isGenericExitCode: classification.isGenericExitCode,
      });
      includeFollowingStackLine = classification.includeFollowingStackLine;
      continue;
    }

    if (includeFollowingStackLine && /^-\s+/.test(classification.matchableLine)) {
      selectedLines.push({
        line: classification.cleanedLine,
        isGenericExitCode: false,
      });
      continue;
    }

    includeFollowingStackLine = false;
  }

  if (selectedLines.length === 0) {
    throw new Error('Could not find a recognizable failure excerpt in the provided log.');
  }

  const hasSpecificFailureLine = selectedLines.some(selectedLine => !selectedLine.isGenericExitCode);
  const excerptLines = selectedLines
    .filter(selectedLine => !hasSpecificFailureLine || !selectedLine.isGenericExitCode)
    .map(selectedLine => selectedLine.line);
  const dedupedExcerptLines: string[] = [];
  const dedupedNormalizedLines: string[] = [];
  const seenNormalizedSignals = new Set<string>();

  for (const excerptLine of excerptLines) {
    const deduplicationKey = buildDeduplicationKey(excerptLine);
    const normalizedLine = normalizeLine(excerptLine);

    if (seenNormalizedSignals.has(deduplicationKey)) {
      continue;
    }

    seenNormalizedSignals.add(deduplicationKey);
    dedupedExcerptLines.push(excerptLine);
    dedupedNormalizedLines.push(normalizedLine);
  }

  const rawExcerpt = dedupedExcerptLines.join('\n');
  const normalizedExcerpt = dedupedNormalizedLines.join('\n');

  return {
    rawExcerpt,
    normalizedExcerpt,
    selectedLines: dedupedExcerptLines,
  };
}
