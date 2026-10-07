import crypto from 'node:crypto';

/**
 * Exact-duplicate detection (ARCHITECTURE §7): sha1 over the extracted text
 * after whitespace normalization, so re-renders of the same page with
 * different line breaks collapse to one hash. Stored on `documents.content_hash`
 * (partial unique index keeps one content owner per hash).
 */
export function contentHash(text: string): string {
  return crypto
    .createHash('sha1')
    .update(text.replace(/\s+/g, ' ').trim())
    .digest('hex');
}
