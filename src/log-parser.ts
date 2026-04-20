import type { ParsedFailure } from './types';

const ERROR_LINE_PATTERNS = [
  /^error:/i,
  /assertionerror/i,
  /module not found/i,
  /cannot find module/i,
  /npm err!/i,
  /require stack/i,
  /command(?:\s+\S+){0,3}\s+failed/i,
  /process completed with exit code\s+(?!0\b)\d+/i,
  /\bexception\b/i,
  /^traceback/i,
  /caused by:/i,
  /\bfatal:/i,
];

function isFailureLine(line: string): boolean {
  return ERROR_LINE_PATTERNS.some(pattern => pattern.test(line));
}

function normalizeLine(line: string): string {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}[:_]\d{2}[:_]\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<timestamp>')
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<sha>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/gi, '<duration>')
    .replace(/(['"])(?:[A-Za-z]:\\[^'"]+|\/[^'"\n]+)\1/g, "$1<path>$1")
    .replace(/(^|\s)(?:[A-Za-z]:\\\S+|\/\S+)/g, '$1<path>')
    .replace(/\b\d{3,}\b/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseLog(logText: string): ParsedFailure {
  const lines = logText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('Log file is empty or contains only whitespace.');
  }

  const selectedLines: string[] = [];
  let includeFollowingStackLine = false;

  for (const line of lines) {
    if (isFailureLine(line)) {
      selectedLines.push(line);
      includeFollowingStackLine = /require stack/i.test(line);
      continue;
    }

    if (includeFollowingStackLine && /^-\s+/.test(line)) {
      selectedLines.push(line);
      continue;
    }

    includeFollowingStackLine = false;
  }

  if (selectedLines.length === 0) {
    throw new Error('Could not find a recognizable failure excerpt in the provided log.');
  }

  const excerptLines = selectedLines;
  const rawExcerpt = excerptLines.join('\n');
  const normalizedExcerpt = excerptLines.map(normalizeLine).join('\n');

  return {
    rawExcerpt,
    normalizedExcerpt,
    selectedLines: excerptLines,
  };
}
