import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serverDataDir } from '../lib/paths.js';

/**
 * `server.properties`, read and written without disturbing anything Platter did not change.
 *
 * The file belongs to the operator. It arrives full of the comments the server wrote, the
 * comments *they* wrote, blank lines that group related settings and a key order that is
 * historical rather than alphabetical. A settings page that flips `pvp` and hands back a
 * regenerated file has silently thrown all of that away, and the operator finds out later.
 *
 * So parsing here keeps every physical line verbatim and only re-renders the single line
 * whose value actually changed. Round-tripping a file nobody edited is byte-for-byte
 * identical, including the line terminators and whether the last line ends with one.
 *
 * The format is Java's `.properties`, which is not INI: `=`, `:` and bare whitespace all
 * separate a key from a value, `#` and `!` both start comments, a trailing backslash
 * continues onto the next line, and `\uXXXX` escapes appear in files written by older
 * servers.
 */

export const SERVER_PROPERTIES_FILE = 'server.properties';

/** A comment, a blank line, or an entry whose line is still exactly as it was read. */
interface RawRecord {
  kind: 'raw';
  text: string;
}

interface EntryRecord {
  kind: 'entry';
  key: string;
  value: string;
  /** The source text, or null once the value changed and the line must be re-rendered. */
  text: string | null;
  /** Whatever sat between key and value — `=`, ` = `, `: `, or a bare space. */
  separator: string;
  /** Line terminator this entry ended with, so a rewrite does not change the file's style. */
  terminator: string;
}

type PropertyRecord = RawRecord | EntryRecord;

export interface PropertiesEntry {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
};

/**
 * Java's rule for an unrecognised escape is to drop the backslash and keep the character,
 * which is why `C:\Users` in a hand-edited file reads back as `C:Users` and not as an
 * error. Reproducing that exactly is the point: Platter must see the same value the game
 * sees.
 */
function unescape(text: string): string {
  if (!text.includes('\\')) return text;

  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) break;

    if (next === 'u') {
      const hex = text.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
      // Malformed `\u`: Java throws here. Platter is reading a file it did not write and
      // must not fail the whole settings page over one bad escape, so it degrades to the
      // literal `u` the same way any other unknown escape would.
      out += 'u';
      index += 1;
      continue;
    }

    out += ESCAPES[next] ?? next;
    index += 1;
  }
  return out;
}

/**
 * Escapes only what would otherwise change the file's meaning.
 *
 * Java's own `store()` also escapes `=`, `:` and every non-ASCII character as `\uXXXX`.
 * Neither is necessary — Minecraft has read `server.properties` as UTF-8 since 1.13 and
 * writes it the same way — and both make the file materially worse to edit by hand, which
 * is something operators do. A MOTD in Japanese stays in Japanese.
 */
function escapeValue(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    switch (char) {
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\f':
        out += '\\f';
        break;
      case ' ':
        // Only leading spaces are significant; the parser strips them, so they have to be
        // escaped to survive. A space inside a MOTD does not.
        out += index === 0 ? '\\ ' : ' ';
        break;
      default:
        out += char;
    }
  }
  return out;
}

function escapeKey(key: string): string {
  let out = '';
  for (const char of key) {
    if (char === '\\') out += '\\\\';
    else if (char === '=' || char === ':' || char === '#' || char === '!' || char === ' ') {
      out += `\\${char}`;
    } else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += char;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Splits on line terminators while keeping them attached, so nothing is normalised away. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function stripTerminator(line: string): { content: string; terminator: string } {
  if (line.endsWith('\r\n')) return { content: line.slice(0, -2), terminator: '\r\n' };
  if (line.endsWith('\n')) return { content: line.slice(0, -1), terminator: '\n' };
  return { content: line, terminator: '' };
}

/** A line continues when it ends with an *odd* number of backslashes. */
function continues(content: string): boolean {
  let backslashes = 0;
  for (let index = content.length - 1; index >= 0 && content[index] === '\\'; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isCommentOrBlank(content: string): boolean {
  const trimmed = content.replace(/^[ \t\f]+/, '');
  return trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!');
}

const SEPARATOR_CHARS = new Set(['=', ':']);
const WHITESPACE_CHARS = new Set([' ', '\t', '\f']);

interface SplitLine {
  key: string;
  value: string;
  separator: string;
}

/**
 * Splits an assembled logical line into key, separator and value.
 *
 * The key ends at the first *unescaped* separator or whitespace — `\=` is part of the key.
 * The separator captured here is the literal source text between the two, so re-rendering
 * a changed value keeps the file's spacing style instead of imposing one.
 */
function splitEntry(content: string): SplitLine {
  const leading = /^[ \t\f]*/.exec(content)?.[0] ?? '';
  let index = leading.length;
  let key = '';

  while (index < content.length) {
    const char = content[index] as string;
    if (char === '\\') {
      key += char + (content[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (SEPARATOR_CHARS.has(char) || WHITESPACE_CHARS.has(char)) break;
    key += char;
    index += 1;
  }

  const separatorStart = index;
  while (index < content.length && WHITESPACE_CHARS.has(content[index] as string)) index += 1;
  if (index < content.length && SEPARATOR_CHARS.has(content[index] as string)) {
    index += 1;
    while (index < content.length && WHITESPACE_CHARS.has(content[index] as string)) index += 1;
  }

  return {
    key: leading + key,
    separator: content.slice(separatorStart, index),
    value: content.slice(index),
  };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export class PropertiesFile {
  private readonly records: PropertyRecord[];

  private constructor(records: PropertyRecord[]) {
    this.records = records;
  }

  static parse(text: string): PropertiesFile {
    const lines = splitLines(text);
    const records: PropertyRecord[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      const { content, terminator } = stripTerminator(line);

      // Comments and blanks are not subject to continuation in Java's reader, so they are
      // classified before any line joining happens.
      if (isCommentOrBlank(content)) {
        records.push({ kind: 'raw', text: line });
        continue;
      }

      let raw = line;
      let logical = content;
      let lastTerminator = terminator;
      while (continues(logical) && index + 1 < lines.length) {
        index += 1;
        const nextLine = lines[index] as string;
        const next = stripTerminator(nextLine);
        raw += nextLine;
        lastTerminator = next.terminator;
        // Drop the continuing backslash and the next line's leading whitespace, exactly as
        // `java.util.Properties` does.
        logical = logical.slice(0, -1) + next.content.replace(/^[ \t\f]+/, '');
      }

      const split = splitEntry(logical);
      records.push({
        kind: 'entry',
        key: unescape(split.key.replace(/^[ \t\f]+/, '')),
        value: unescape(split.value),
        text: raw,
        separator: split.separator.length > 0 ? split.separator : '=',
        terminator: lastTerminator,
      });
    }

    return new PropertiesFile(records);
  }

  static empty(): PropertiesFile {
    return new PropertiesFile([]);
  }

  /** The last occurrence wins, which is what `java.util.Properties` does on a duplicate. */
  get(key: string): string | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record?.kind === 'entry' && record.key === key) return record.value;
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  getString(key: string, fallback: string): string {
    return this.get(key) ?? fallback;
  }

  getNumber(key: string): number | null {
    const raw = this.get(key);
    if (raw === undefined) return null;
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Minecraft writes `true`/`false`; anything else is false, as the game itself treats it. */
  getBoolean(key: string): boolean | null {
    const raw = this.get(key);
    if (raw === undefined) return null;
    return raw.trim().toLowerCase() === 'true';
  }

  /**
   * Updates the last occurrence, or appends. Earlier duplicates are left alone: they are
   * dead weight in the file but removing lines the operator wrote is not this method's job.
   */
  set(key: string, value: string): this {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record?.kind !== 'entry' || record.key !== key) continue;
      if (record.value === value) return this;
      record.value = value;
      // Dropping the source text is what marks the line for re-rendering.
      record.text = null;
      return this;
    }

    this.append(key, value);
    return this;
  }

  private append(key: string, value: string): void {
    const last = this.records[this.records.length - 1];
    const terminator = this.dominantTerminator();
    // A file whose final line has no terminator would otherwise get the new entry glued
    // onto the end of it.
    if (last) {
      if (last.kind === 'raw' && !last.text.endsWith('\n')) last.text += terminator;
      if (last.kind === 'entry' && last.terminator === '') {
        last.terminator = terminator;
        // An untouched entry renders from its source text, so the terminator has to go
        // there too — setting only the field would leave the two lines glued together.
        if (last.text !== null) last.text += terminator;
      }
    }
    this.records.push({ kind: 'entry', key, value, text: null, separator: '=', terminator });
  }

  /** New lines match the file they are joining rather than the platform Platter runs on. */
  private dominantTerminator(): string {
    for (const record of this.records) {
      if (record.kind === 'entry' && record.terminator !== '') return record.terminator;
      if (record.kind === 'raw' && record.text.endsWith('\r\n')) return '\r\n';
      if (record.kind === 'raw' && record.text.endsWith('\n')) return '\n';
    }
    return '\n';
  }

  /** Removes every occurrence. Returns whether anything was there. */
  delete(key: string): boolean {
    const before = this.records.length;
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record?.kind === 'entry' && record.key === key) this.records.splice(index, 1);
    }
    return this.records.length !== before;
  }

  keys(): string[] {
    const seen = new Set<string>();
    for (const record of this.records) {
      if (record.kind === 'entry') seen.add(record.key);
    }
    return [...seen];
  }

  entries(): PropertiesEntry[] {
    return this.keys().map((key) => ({ key, value: this.get(key) ?? '' }));
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const record of this.records) {
      if (record.kind === 'entry') out[record.key] = record.value;
    }
    return out;
  }

  toString(): string {
    let out = '';
    for (const record of this.records) {
      if (record.kind === 'raw') {
        out += record.text;
        continue;
      }
      out +=
        record.text ??
        `${escapeKey(record.key)}${record.separator}${escapeValue(record.value)}${record.terminator}`;
    }
    return out;
  }
}

export function parseProperties(text: string): PropertiesFile {
  return PropertiesFile.parse(text);
}

// ---------------------------------------------------------------------------
// The keys the UI exposes
// ---------------------------------------------------------------------------

export type PropertyKind = 'string' | 'number' | 'boolean' | 'enum';

export interface MinecraftPropertyDescriptor {
  key: string;
  label: string;
  kind: PropertyKind;
  /** Present for `enum`; the exact strings the game accepts, lowercase. */
  options?: readonly string[];
  min?: number;
  max?: number;
  description?: string;
}

/**
 * Not every key in the file — the ones a control panel has any business putting in a form.
 *
 * Anything absent from this table is still readable and writable through `PropertiesFile`
 * and through the file editor. The table exists so the UI can render a typed control and
 * so a value can be validated before it reaches a file the server refuses to parse.
 */
export const MINECRAFT_PROPERTIES: readonly MinecraftPropertyDescriptor[] = [
  { key: 'motd', label: 'Message of the day', kind: 'string' },
  { key: 'max-players', label: 'Maximum players', kind: 'number', min: 0, max: 2_147_483_647 },
  {
    key: 'gamemode',
    label: 'Default game mode',
    kind: 'enum',
    options: ['survival', 'creative', 'adventure', 'spectator'],
  },
  {
    key: 'difficulty',
    label: 'Difficulty',
    kind: 'enum',
    options: ['peaceful', 'easy', 'normal', 'hard'],
  },
  { key: 'hardcore', label: 'Hardcore', kind: 'boolean' },
  { key: 'pvp', label: 'Player versus player', kind: 'boolean' },
  {
    key: 'online-mode',
    label: 'Verify accounts with Mojang',
    kind: 'boolean',
    description:
      'Off lets cracked clients join and lets anyone claim any username. Only turn it off behind a proxy that does the check itself.',
  },
  { key: 'white-list', label: 'Whitelist', kind: 'boolean' },
  { key: 'enforce-whitelist', label: 'Kick non-whitelisted players', kind: 'boolean' },
  { key: 'allow-flight', label: 'Allow flight', kind: 'boolean' },
  { key: 'allow-nether', label: 'Allow the Nether', kind: 'boolean' },
  { key: 'force-gamemode', label: 'Force game mode on join', kind: 'boolean' },
  { key: 'spawn-protection', label: 'Spawn protection radius', kind: 'number', min: 0, max: 1000 },
  { key: 'view-distance', label: 'View distance', kind: 'number', min: 2, max: 32 },
  { key: 'simulation-distance', label: 'Simulation distance', kind: 'number', min: 2, max: 32 },
  { key: 'level-name', label: 'World folder', kind: 'string' },
  { key: 'level-seed', label: 'World seed', kind: 'string' },
  { key: 'level-type', label: 'World type', kind: 'string' },
  { key: 'generate-structures', label: 'Generate structures', kind: 'boolean' },
  { key: 'spawn-monsters', label: 'Spawn monsters', kind: 'boolean' },
  { key: 'spawn-animals', label: 'Spawn animals', kind: 'boolean' },
  { key: 'spawn-npcs', label: 'Spawn villagers', kind: 'boolean' },
  { key: 'enable-command-block', label: 'Enable command blocks', kind: 'boolean' },
  { key: 'op-permission-level', label: 'Operator permission level', kind: 'number', min: 0, max: 4 },
  {
    key: 'player-idle-timeout',
    label: 'Idle kick (minutes)',
    kind: 'number',
    min: 0,
    max: 525_600,
    description: '0 never kicks.',
  },
  { key: 'max-world-size', label: 'World border radius', kind: 'number', min: 1, max: 29_999_984 },
  { key: 'resource-pack', label: 'Resource pack URL', kind: 'string' },
  { key: 'require-resource-pack', label: 'Require the resource pack', kind: 'boolean' },
  { key: 'enforce-secure-profile', label: 'Require signed chat', kind: 'boolean' },
  { key: 'hide-online-players', label: 'Hide the player list from pings', kind: 'boolean' },
  { key: 'enable-status', label: 'Answer server-list pings', kind: 'boolean' },
];

export const MINECRAFT_PROPERTY_BY_KEY: ReadonlyMap<string, MinecraftPropertyDescriptor> = new Map(
  MINECRAFT_PROPERTIES.map((descriptor) => [descriptor.key, descriptor]),
);

export type PropertyValue = string | number | boolean;

/**
 * The typed view of the keys above.
 *
 * A key the file does not contain is absent rather than defaulted: "the operator has not
 * set this" and "the operator set this to the default" are different facts, and only the
 * game knows what its own default is for the version being run.
 */
export function readMinecraftProperties(file: PropertiesFile): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const descriptor of MINECRAFT_PROPERTIES) {
    const raw = file.get(descriptor.key);
    if (raw === undefined) continue;
    if (descriptor.kind === 'boolean') out[descriptor.key] = raw.trim().toLowerCase() === 'true';
    else if (descriptor.kind === 'number') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) out[descriptor.key] = parsed;
    } else out[descriptor.key] = raw;
  }
  return out;
}

export interface PropertyPatchResult {
  applied: string[];
  /** Keyed by dotted path, the shape `PlatterError.details` expects. */
  errors: Record<string, string[]>;
}

function reject(errors: Record<string, string[]>, key: string, message: string): void {
  const existing = errors[`properties.${key}`];
  if (existing) existing.push(message);
  else errors[`properties.${key}`] = [message];
}

/**
 * Applies a patch of typed values, validating each against its descriptor.
 *
 * Unknown keys are refused rather than written through. `server.properties` is loaded by
 * the game at boot and a key it cannot parse takes the server down, so a settings form is
 * the wrong place to accept arbitrary input — the file editor already exists for operators
 * who know what they are doing.
 */
export function applyMinecraftProperties(
  file: PropertiesFile,
  patch: Readonly<Record<string, PropertyValue>>,
): PropertyPatchResult {
  const applied: string[] = [];
  const errors: Record<string, string[]> = {};

  for (const [key, value] of Object.entries(patch)) {
    const descriptor = MINECRAFT_PROPERTY_BY_KEY.get(key);
    if (!descriptor) {
      reject(errors, key, 'That is not a setting Platter can change here.');
      continue;
    }

    switch (descriptor.kind) {
      case 'boolean': {
        if (typeof value !== 'boolean') {
          reject(errors, key, 'Use true or false.');
          continue;
        }
        file.set(key, value ? 'true' : 'false');
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          reject(errors, key, 'Use a number.');
          continue;
        }
        if (descriptor.min !== undefined && value < descriptor.min) {
          reject(errors, key, `Use ${descriptor.min} or more.`);
          continue;
        }
        if (descriptor.max !== undefined && value > descriptor.max) {
          reject(errors, key, `Use ${descriptor.max} or less.`);
          continue;
        }
        file.set(key, String(value));
        break;
      }
      case 'enum': {
        const normalised = String(value).trim().toLowerCase();
        if (!descriptor.options?.includes(normalised)) {
          reject(errors, key, `Choose one of: ${descriptor.options?.join(', ') ?? ''}.`);
          continue;
        }
        file.set(key, normalised);
        break;
      }
      default: {
        if (typeof value !== 'string') {
          reject(errors, key, 'Use text.');
          continue;
        }
        // A newline would be written as `\n` and read back correctly, but the operator
        // opening the file would see one setting spanning two lines. Refuse it instead.
        if (/[\r\n]/.test(value)) {
          reject(errors, key, 'That value cannot contain a line break.');
          continue;
        }
        file.set(key, value);
      }
    }
    applied.push(key);
  }

  return { applied, errors };
}

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function serverPropertiesPath(serverId: string): string {
  return path.join(serverDataDir(serverId), SERVER_PROPERTIES_FILE);
}

/**
 * Null when the file is not there yet.
 *
 * That is the normal state between "server created" and "first boot finished" — the image
 * writes `server.properties` itself — so it is a value, not an error.
 */
export async function readServerProperties(serverId: string): Promise<PropertiesFile | null> {
  try {
    return PropertiesFile.parse(await readFile(serverPropertiesPath(serverId), 'utf8'));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function writeServerProperties(
  serverId: string,
  file: PropertiesFile,
): Promise<void> {
  await writeFile(serverPropertiesPath(serverId), file.toString(), 'utf8');
}
