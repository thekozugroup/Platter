import { readFileSync } from 'node:fs';
import type { RawLogLine } from '../types';

/**
 * Fixture loading, for tests only.
 *
 * The engine itself does no I/O — that is the point of it. This helper exists so the *tests* can
 * hold real log excerpts as real files rather than as string literals embedded in a test.
 * Keeping them as files matters: an excerpt pasted into TypeScript loses its tabs to the
 * formatter, and tab indentation is exactly what Forge's dependency table and Fabric's
 * resolution report use to mark their continuation lines.
 */

const FIXTURE_DIR = new URL('./__fixtures__/', import.meta.url);

export function loadFixture(name: string): RawLogLine[] {
  const text = readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
  return toLines(text);
}

/** Split raw log text into the shape `diagnose()` takes. Trailing blank line is dropped. */
export function toLines(
  text: string,
  options: { stream?: 'stdout' | 'stderr' } = {}
): RawLogLine[] {
  const stream = options.stream ?? 'stdout';
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') {
    rows.pop();
  }
  return rows.map((line, i) => ({ seq: i, stream, text: line }));
}
