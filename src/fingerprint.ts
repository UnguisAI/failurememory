import { createHash } from 'node:crypto';

export function createFingerprint(normalizedExcerpt: string): string {
  return createHash('sha256').update(normalizedExcerpt.trim(), 'utf8').digest('hex');
}
