import { PlatterError } from '@platter/shared';
import { describe, expect, it } from 'vitest';
import { getBlueprint } from '../../services/blueprints.js';
import { parseMspt, parseTps, readMinecraftHealth } from '../health.js';
import {
  assertIpAddress,
  assertPlayerName,
  assertReason,
  compilePlayerSignals,
  isUnknownCommand,
  looksLikeFailure,
  matchPlayerEvent,
  parseBanlistOutput,
  parseListOutput,
  parseRosterJson,
  parseWhitelistOutput,
  playerCommands,
  stripFormatting,
} from '../players.js';

/**
 * The `list` fixtures below are the real wordings, not paraphrases. Mojang and Spigot have
 * each changed this sentence, none of the versions announce themselves, and a parser that
 * only handles the newest one silently reports an empty server.
 */
describe('list output', () => {
  it('reads the modern vanilla format (1.13+)', () => {
    expect(
      parseListOutput('There are 3 of a max of 20 players online: Alice, Bob, Carol_99'),
    ).toEqual({ online: 3, max: 20, players: ['Alice', 'Bob', 'Carol_99'] });
  });

  it('reads the legacy vanilla format (1.7–1.12), where names are on the next line', () => {
    expect(parseListOutput('There are 2/20 players online:\nAlice, Bob')).toEqual({
      online: 2,
      max: 20,
      players: ['Alice', 'Bob'],
    });
  });

  it('reads the Spigot format', () => {
    expect(parseListOutput('There are 2 out of maximum 30 players online.\nAlice, Bob')).toEqual({
      online: 2,
      max: 30,
      players: ['Alice', 'Bob'],
    });
  });

  it('reads the 1.13-era wording without "of"', () => {
    expect(parseListOutput('There are 1 of a max 10 players online: Alice')).toEqual({
      online: 1,
      max: 10,
      players: ['Alice'],
    });
  });

  it('reads an empty server', () => {
    expect(parseListOutput('There are 0 of a max of 20 players online:')).toEqual({
      online: 0,
      max: 20,
      players: [],
    });
  });

  it('strips colour codes a plugin added', () => {
    expect(
      parseListOutput('§6There are §a4§6 of a max of §a20§6 players online: §fAlice, Bob'),
    ).toEqual({ online: 4, max: 20, players: ['Alice', 'Bob'] });
  });

  it('drops the decoration some permission plugins add to a name', () => {
    const result = parseListOutput(
      'There are 2 of a max of 20 players online: Alice (a1b2c3d4), [Admin] Bob',
    );
    expect(result?.players).toEqual(['Alice', 'Bob']);
  });

  it('trusts the header count over the name list the server truncated', () => {
    const result = parseListOutput('There are 120 of a max of 200 players online: Alice, Bob');
    expect(result).toMatchObject({ online: 120, max: 200, players: ['Alice', 'Bob'] });
  });

  it('returns null for output that is not a list reply', () => {
    expect(parseListOutput('Unknown or incomplete command, see below for error')).toBeNull();
    expect(parseListOutput('')).toBeNull();
  });
});

describe('whitelist output', () => {
  it('reads the vanilla format', () => {
    expect(parseWhitelistOutput('There are 2 whitelisted players: Alice, Bob')).toEqual([
      'Alice',
      'Bob',
    ]);
  });

  it('reads the older "player(s)" wording', () => {
    expect(parseWhitelistOutput('There are 1 whitelisted player(s): Alice')).toEqual(['Alice']);
  });

  it('reads the Bukkit format', () => {
    expect(parseWhitelistOutput('White-listed players: Alice, Bob')).toEqual(['Alice', 'Bob']);
  });

  it('reads an empty whitelist as empty, not as a failure', () => {
    expect(parseWhitelistOutput('There are no whitelisted players')).toEqual([]);
  });

  it('returns null when the command was not understood', () => {
    expect(parseWhitelistOutput('Unknown or incomplete command')).toBeNull();
  });
});

describe('ban list output', () => {
  it('reads bans and their reasons', () => {
    expect(
      parseBanlistOutput(
        'There are 2 bans:\nAlice was banned by Server: Griefing: spawn\nBob was banned by Carol: Banned by an operator.',
      ),
    ).toEqual([
      { target: 'Alice', source: 'Server', reason: 'Griefing: spawn' },
      { target: 'Bob', source: 'Carol', reason: 'Banned by an operator.' },
    ]);
  });

  it('reads IP bans', () => {
    expect(parseBanlistOutput('There are 1 bans:\n203.0.113.7 was banned by Server: spam')).toEqual(
      [{ target: '203.0.113.7', source: 'Server', reason: 'spam' }],
    );
  });

  it('reads no bans as empty', () => {
    expect(parseBanlistOutput('There are no bans')).toEqual([]);
  });
});

describe('roster files', () => {
  it('parses ops.json', () => {
    const entries = parseRosterJson(
      '[{"uuid":"a-b","name":"Alice","level":4,"bypassesPlayerLimit":false}]',
    );
    expect(entries).toEqual([
      {
        name: 'Alice',
        uuid: 'a-b',
        level: 4,
        reason: null,
        source: null,
        createdAt: null,
        expiresAt: null,
      },
    ]);
  });

  it('parses banned-ips.json off the `ip` key', () => {
    const entries = parseRosterJson(
      '[{"ip":"203.0.113.7","created":"2025-01-02","source":"Server","expires":"forever","reason":"spam"}]',
      'ip',
    );
    expect(entries[0]).toMatchObject({ name: '203.0.113.7', reason: 'spam', source: 'Server' });
  });

  it('treats a truncated or missing file as empty rather than throwing', () => {
    expect(parseRosterJson('[{"name":"Alice"')).toEqual([]);
    expect(parseRosterJson('')).toEqual([]);
    expect(parseRosterJson('{}')).toEqual([]);
    expect(parseRosterJson('[null, 3, {"level":4}]')).toEqual([]);
  });
});

describe('log signals', () => {
  const blueprint = getBlueprint('minecraft-java');
  const signals = compilePlayerSignals(blueprint.signals);

  it('reads a join off the real blueprint patterns', () => {
    expect(
      matchPlayerEvent('[12:00:01] [Server thread/INFO]: Alice joined the game', signals),
    ).toEqual({ kind: 'join', name: 'Alice' });
  });

  it('reads the login line, which arrives before the join line', () => {
    expect(
      matchPlayerEvent(
        '[12:00:00] [Server thread/INFO]: Bob_99[/203.0.113.7:51234] logged in with entity id 411 at (1.5, 64.0, -2.5)',
        signals,
      ),
    ).toEqual({ kind: 'join', name: 'Bob_99' });
  });

  it('reads a leave', () => {
    expect(
      matchPlayerEvent('[12:05:00] [Server thread/INFO]: Alice left the game', signals),
    ).toEqual({ kind: 'leave', name: 'Alice' });
  });

  it('ignores chat that merely mentions joining', () => {
    expect(
      matchPlayerEvent('[12:01:00] [Server thread/INFO]: <Alice> anyone joined the game?', signals),
    ).toBeNull();
    expect(
      matchPlayerEvent(
        '[12:01:00] [Server thread/INFO]: [Not Secure] <Bob> Alice left the game',
        signals,
      ),
    ).toBeNull();
  });

  it('ignores a line that matches nothing', () => {
    expect(matchPlayerEvent('[12:00:00] [Server thread/INFO]: Done (5.123s)!', signals)).toBeNull();
  });

  it('drops an unparseable blueprint pattern instead of failing the rest', () => {
    const compiled = compilePlayerSignals({ playerJoin: ['([', '(\\w+) in'], playerLeave: [] });
    expect(compiled.join).toHaveLength(1);
    expect(matchPlayerEvent('Alice in', compiled)).toEqual({ kind: 'join', name: 'Alice' });
  });
});

describe('argument validation', () => {
  it('accepts real usernames', () => {
    expect(assertPlayerName('  Notch ')).toBe('Notch');
    expect(assertPlayerName('a_B9')).toBe('a_B9');
  });

  it('refuses anything that could become a second command', () => {
    for (const bad of ['Alice Bob', 'Alice\nop Alice', 'Alice;op', '@a', '', 'x'.repeat(17)]) {
      expect(() => assertPlayerName(bad)).toThrow(PlatterError);
    }
  });

  it('refuses a multi-line reason and trims a long one', () => {
    expect(() => assertReason('one\ntwo')).toThrow(PlatterError);
    expect(assertReason('  ')).toBeNull();
    expect(assertReason(null)).toBeNull();
    expect(assertReason('x'.repeat(500))).toHaveLength(200);
  });

  it('refuses a hostname where an address is required', () => {
    expect(assertIpAddress(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(assertIpAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(() => assertIpAddress('example.com')).toThrow(PlatterError);
    expect(() => assertIpAddress('203.0.113.7 && rm -rf /')).toThrow(PlatterError);
  });

  it('builds commands with and without a reason', () => {
    expect(playerCommands.kick('Alice', null)).toBe('kick Alice');
    expect(playerCommands.ban('Alice', 'griefing')).toBe('ban Alice griefing');
    expect(playerCommands.whitelistRemove('Alice')).toBe('whitelist remove Alice');
  });
});

describe('command outcomes', () => {
  it('recognises a refusal', () => {
    expect(looksLikeFailure('Unknown or incomplete command, see below for error')).toBe(true);
    expect(looksLikeFailure('That player does not exist')).toBe(true);
    expect(looksLikeFailure('No player was found')).toBe(true);
  });

  it('treats success and silence as success', () => {
    expect(looksLikeFailure('Kicked Alice from the game: Griefing')).toBe(false);
    expect(looksLikeFailure('')).toBe(false);
  });

  it('separates "no such command" from "that did not work"', () => {
    expect(isUnknownCommand('Unknown or incomplete command')).toBe(true);
    expect(isUnknownCommand('That player does not exist')).toBe(false);
  });

  it('strips formatting codes without touching the text', () => {
    expect(stripFormatting('§aAlice §rjoined')).toBe('Alice joined');
  });
});

describe('tick health', () => {
  it('reads Paper /tps', () => {
    expect(parseTps('§6TPS from last 1m, 5m, 15m: §a20.0, §a19.87, §a18.4')).toEqual({
      oneMinute: 20,
      fiveMinutes: 19.87,
      fifteenMinutes: 18.4,
      estimated: false,
    });
  });

  it('flags Spigot estimated figures', () => {
    const reading = parseTps('§6TPS from last 1m, 5m, 15m: §a*20.0, §a*20.0, §a*20.0');
    expect(reading).toMatchObject({ oneMinute: 20, estimated: true });
  });

  it('ignores the memory line Purpur prints after it', () => {
    expect(
      parseTps(
        '§6TPS from last 1m, 5m, 15m: §a20.0, §a20.0, §a20.0\n§6Current Memory Usage: §a2048§6/§a4096 mb',
      ),
    ).toMatchObject({ oneMinute: 20, fifteenMinutes: 20 });
  });

  it('reads Paper /mspt', () => {
    expect(
      parseMspt(
        '§6Server tick times §7(§eavg§7/§emax§7) from last 5s§7, §e1m§7, §e5m§7:\n§7◤ §a1.02§7/§a3.66§7, §a1.11§7/§a9.71§7, §a1.05§7/§a24.9 §7◢',
      ),
    ).toEqual({
      fiveSeconds: { average: 1.02, peak: 3.66 },
      oneMinute: { average: 1.11, peak: 9.71 },
      fiveMinutes: { average: 1.05, peak: 24.9 },
    });
  });

  it('refuses to read a number out of unrelated output', () => {
    expect(parseTps('Unknown or incomplete command, see below for error')).toBeNull();
    expect(parseMspt('There are 3 of a max of 20 players online: Alice')).toBeNull();
  });

  it('reports vanilla as unsupported rather than inventing a number', async () => {
    const health = await readMinecraftHealth(async () =>
      Promise.resolve('Unknown or incomplete command, see below for error'),
    );
    expect(health).toEqual({ tps: null, mspt: null, unavailable: 'unsupported' });
  });

  it('reports an unreachable server as offline, not as unsupported', async () => {
    const health = await readMinecraftHealth(() => Promise.reject(new Error('socket closed')));
    expect(health).toEqual({ tps: null, mspt: null, unavailable: 'offline' });
  });

  it('reports whichever of the two commands answered', async () => {
    const health = await readMinecraftHealth(async (command) =>
      command === 'tps'
        ? Promise.resolve('TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0')
        : Promise.resolve('Unknown or incomplete command'),
    );
    expect(health.tps).toMatchObject({ oneMinute: 20 });
    expect(health.mspt).toBeNull();
    expect(health.unavailable).toBeNull();
  });
});
