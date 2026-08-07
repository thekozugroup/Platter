import { describe, expect, it } from 'vitest';
import { isReadOnlyCommand } from './read-only';

describe('isReadOnlyCommand', () => {
  it('exempts genuine inspection commands', () => {
    expect(isReadOnlyCommand('list')).toBe(true);
    expect(isReadOnlyCommand('/list')).toBe(true);
    expect(isReadOnlyCommand('list uuids')).toBe(true);
    expect(isReadOnlyCommand('seed')).toBe(true);
    expect(isReadOnlyCommand('help give')).toBe(true);
    expect(isReadOnlyCommand('version')).toBe(true);
    expect(isReadOnlyCommand('tps')).toBe(true);
    expect(isReadOnlyCommand('whitelist list')).toBe(true);
    expect(isReadOnlyCommand('datapack list')).toBe(true);
    expect(isReadOnlyCommand('banlist ips')).toBe(true);
  });

  it('requires confirmation for the subcommands that write', () => {
    // The whole reason the allowlist is keyed on shape rather than verb.
    expect(isReadOnlyCommand('datapack disable file/greed')).toBe(false);
    expect(isReadOnlyCommand('datapack enable file/greed')).toBe(false);
    expect(isReadOnlyCommand('whitelist add mallory')).toBe(false);
    expect(isReadOnlyCommand('whitelist off')).toBe(false);
  });

  it('never exempts the command-execution verbs', () => {
    // `/debug function` executes an arbitrary .mcfunction; `/debug start` and `/perf start`
    // write unbounded profiler dumps into the world's bind mount.
    expect(isReadOnlyCommand('debug function evil:grief')).toBe(false);
    expect(isReadOnlyCommand('debug start')).toBe(false);
    expect(isReadOnlyCommand('debug')).toBe(false);
    expect(isReadOnlyCommand('perf start')).toBe(false);
  });

  it('never exempts state-changing commands', () => {
    expect(isReadOnlyCommand('op mallory')).toBe(false);
    expect(isReadOnlyCommand('stop')).toBe(false);
    expect(isReadOnlyCommand('/kill @a')).toBe(false);
  });

  it('is not fooled by a newline hiding a second command', () => {
    expect(isReadOnlyCommand('list\nop mallory')).toBe(false);
    expect(isReadOnlyCommand('list\r\nstop')).toBe(false);
  });

  it('is case insensitive on the verb and its subcommand', () => {
    expect(isReadOnlyCommand('LIST')).toBe(true);
    expect(isReadOnlyCommand('Whitelist LIST')).toBe(true);
    expect(isReadOnlyCommand('DATAPACK DISABLE x')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isReadOnlyCommand('')).toBe(false);
    expect(isReadOnlyCommand('   ')).toBe(false);
    expect(isReadOnlyCommand('/')).toBe(false);
  });
});
