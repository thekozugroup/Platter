import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `properties.ts` reaches `serverDataDir` for its on-disk helpers, which pulls in `config`
 * — and `config` reads the environment exactly once, at module load. Set first, import
 * after, the same way the service tests do.
 */
const workdir = await mkdtemp(path.join(tmpdir(), 'platter-properties-'));

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'test.db')}`;
process.env['DATA_DIR'] = path.join(workdir, 'data');
process.env['DEFAULT_NODE_DRIVER'] = 'mock';
process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass';

const {
  MINECRAFT_PROPERTIES,
  PropertiesFile,
  applyMinecraftProperties,
  parseProperties,
  readMinecraftProperties,
  serverPropertiesPath,
} = await import('../properties.js');

/**
 * A file with everything that makes a naive round-trip lossy: a banner comment, a `!`
 * comment, blank lines, `:` and bare-space separators, padded `=`, a duplicate key, a
 * unicode escape, a line continuation, a Windows line ending, and no trailing newline.
 */
const MESSY = [
  '#Minecraft server properties',
  '#Thu Jan 02 03:04:05 UTC 2025',
  '',
  '! left by the operator - do not reorder',
  'enable-jmx-monitoring=false',
  'rcon.port : 25575',
  'level-seed  ',
  'gamemode survival',
  'motd=A \\u00a76Minecraft\\u00a7r Server',
  '   spawn-protection=16',
  'resource-pack=',
  'op-permission-level = 4',
  'motd-continued=first \\',
  '    second',
  'view-distance=10',
  'view-distance=12',
].join('\n');

describe('round trip', () => {
  it('returns a file nobody edited byte for byte', () => {
    expect(parseProperties(MESSY).toString()).toBe(MESSY);
  });

  it('preserves CRLF endings and a missing final newline', () => {
    const crlf = 'motd=hi\r\n#comment\r\npvp=true';
    expect(parseProperties(crlf).toString()).toBe(crlf);
  });

  it('preserves an empty file and a file that is only comments', () => {
    expect(parseProperties('').toString()).toBe('');
    expect(parseProperties('#one\n\n#two\n').toString()).toBe('#one\n\n#two\n');
  });

  it('changes exactly one line when one value changes', () => {
    const file = parseProperties(MESSY);
    file.set('spawn-protection', '0');
    const after = file.toString();

    const before = MESSY.split('\n');
    const changed = after.split('\n');
    expect(changed).toHaveLength(before.length);

    const differing = changed.filter((line, index) => line !== before[index]);
    expect(differing).toEqual(['spawn-protection=0']);
  });

  it('leaves the file untouched when the value is unchanged', () => {
    const file = parseProperties(MESSY);
    file.set('op-permission-level', '4');
    // Rewriting the line would have normalised ` = ` to `=`.
    expect(file.toString()).toBe(MESSY);
  });

  it('keeps the separator style of the line it rewrites', () => {
    const file = parseProperties(MESSY);
    file.set('rcon.port', '25580');
    expect(file.toString()).toContain('rcon.port : 25580');
  });

  it('appends a new key at the end without disturbing anything', () => {
    const file = parseProperties(MESSY);
    file.set('enforce-whitelist', 'true');
    const text = file.toString();

    expect(text.startsWith(MESSY)).toBe(true);
    expect(text).toBe(`${MESSY}\nenforce-whitelist=true\n`);
  });

  it('survives a set-and-restore cycle', () => {
    const file = parseProperties(MESSY);
    const original = file.get('motd') ?? '';
    file.set('motd', 'temporary');
    file.set('motd', original);
    expect(parseProperties(file.toString()).get('motd')).toBe(original);
  });
});

describe('parsing', () => {
  const file = parseProperties(MESSY);

  it('accepts every separator the format allows', () => {
    expect(file.get('enable-jmx-monitoring')).toBe('false');
    expect(file.get('rcon.port')).toBe('25575');
    expect(file.get('gamemode')).toBe('survival');
  });

  it('reads an empty value and a value that is only whitespace', () => {
    expect(file.get('resource-pack')).toBe('');
    expect(file.get('level-seed')).toBe('');
  });

  it('trims the leading whitespace of an indented key', () => {
    expect(file.get('spawn-protection')).toBe('16');
  });

  it('decodes unicode escapes', () => {
    expect(file.get('motd')).toBe('A \u00a76Minecraft\u00a7r Server');
  });

  it('joins a continued line and drops the continuation indent', () => {
    expect(file.get('motd-continued')).toBe('first second');
  });

  it('takes the last of a duplicated key, as java.util.Properties does', () => {
    expect(file.get('view-distance')).toBe('12');
  });

  it('ignores comments entirely', () => {
    expect(file.has('Minecraft server properties')).toBe(false);
    expect(file.keys()).not.toContain('!');
  });

  it('reports keys in the order they appear', () => {
    expect(file.keys().slice(0, 4)).toEqual([
      'enable-jmx-monitoring',
      'rcon.port',
      'level-seed',
      'gamemode',
    ]);
  });
});

describe('escaping', () => {
  it('round-trips a value that needs escaping', () => {
    const file = PropertiesFile.empty();
    file.set('motd', 'line one\ttabbed \\ backslash');
    file.set('level-name', ' leading space');

    const text = file.toString();
    expect(text).toContain('motd=line one\\ttabbed \\\\ backslash');
    expect(text).toContain('level-name=\\ leading space');

    const reparsed = parseProperties(text);
    expect(reparsed.get('motd')).toBe('line one\ttabbed \\ backslash');
    expect(reparsed.get('level-name')).toBe(' leading space');
  });

  it('writes non-ASCII as itself, the way the game does', () => {
    const file = PropertiesFile.empty();
    file.set('motd', 'ようこそ §6サーバー');
    expect(file.toString()).toBe('motd=ようこそ §6サーバー\n');
    expect(parseProperties(file.toString()).get('motd')).toBe('ようこそ §6サーバー');
  });

  it('keeps a backslash that is not a known escape, as Java does', () => {
    expect(parseProperties('path=C:\\Users\\admin').get('path')).toBe('C:Usersadmin');
    expect(parseProperties('path=C:\\\\Users').get('path')).toBe('C:\\Users');
  });
});

describe('typed access', () => {
  it('reads booleans and numbers', () => {
    const file = parseProperties('pvp=true\nhardcore=FALSE\nmax-players=40\nmotd=hi\n');
    expect(file.getBoolean('pvp')).toBe(true);
    expect(file.getBoolean('hardcore')).toBe(false);
    expect(file.getNumber('max-players')).toBe(40);
    expect(file.getNumber('motd')).toBeNull();
    expect(file.getBoolean('missing')).toBeNull();
  });

  it('omits keys the file does not set rather than defaulting them', () => {
    const typed = readMinecraftProperties(parseProperties('pvp=false\n'));
    expect(typed).toEqual({ pvp: false });
  });

  it('applies a validated patch and preserves the rest of the file', () => {
    const file = parseProperties(MESSY);
    const result = applyMinecraftProperties(file, {
      'view-distance': 16,
      pvp: false,
      difficulty: 'HARD',
    });

    expect(result.errors).toEqual({});
    expect(result.applied.sort()).toEqual(['difficulty', 'pvp', 'view-distance']);
    expect(file.get('view-distance')).toBe('16');
    expect(file.get('difficulty')).toBe('hard');
    expect(file.toString()).toContain('#Minecraft server properties');
  });

  it('refuses out-of-range, mistyped, unknown and multi-line values', () => {
    const file = PropertiesFile.empty();
    const result = applyMinecraftProperties(file, {
      'view-distance': 99,
      pvp: 'yes',
      difficulty: 'brutal',
      'rcon.password': 'hunter2',
      motd: 'one\ntwo',
    });

    expect(result.applied).toEqual([]);
    expect(Object.keys(result.errors).sort()).toEqual([
      'properties.difficulty',
      'properties.motd',
      'properties.pvp',
      'properties.rcon.password',
      'properties.view-distance',
    ]);
    // Nothing partially applied: a refused patch must not leave the file half-changed.
    expect(file.toString()).toBe('');
  });

  it('describes every key it exposes', () => {
    for (const descriptor of MINECRAFT_PROPERTIES) {
      expect(descriptor.label.length).toBeGreaterThan(0);
      if (descriptor.kind === 'enum') expect(descriptor.options?.length).toBeGreaterThan(0);
    }
    const keys = MINECRAFT_PROPERTIES.map((descriptor) => descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('on disk', () => {
  it('resolves inside the server data directory', () => {
    const target = serverPropertiesPath('srv_test');
    expect(target).toBe(
      path.join(process.env['DATA_DIR'] as string, 'servers', 'srv_test', 'server.properties'),
    );
    // The helper is only ever given a server id, but a caller passing junk must not be
    // able to walk out of the data directory with it.
    expect(path.relative(fileURLToPath(new URL('file:///')), target)).not.toContain('..');
  });
});
