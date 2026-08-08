import { describe, expect, it } from 'vitest';
import {
  assignHostnames,
  baseHostnameLabel,
  hostnameFor,
  isValidHostnameChain,
  isValidHostnameLabel,
} from '../hostname.js';

describe('isValidHostnameLabel', () => {
  it('accepts a plain lowercase label', () => {
    expect(isValidHostnameLabel('survival')).toBe(true);
  });

  it('rejects uppercase, leading/trailing hyphens, and empty strings', () => {
    expect(isValidHostnameLabel('Survival')).toBe(false);
    expect(isValidHostnameLabel('-survival')).toBe(false);
    expect(isValidHostnameLabel('survival-')).toBe(false);
    expect(isValidHostnameLabel('')).toBe(false);
  });

  it('rejects a label over the 63-byte DNS ceiling', () => {
    expect(isValidHostnameLabel('a'.repeat(63))).toBe(true);
    expect(isValidHostnameLabel('a'.repeat(64))).toBe(false);
  });
});

describe('isValidHostnameChain', () => {
  it('validates every label in a dotted chain', () => {
    expect(isValidHostnameChain('survival.platter.local')).toBe(true);
    expect(isValidHostnameChain('Survival.platter.local')).toBe(false);
    expect(isValidHostnameChain('survival..local')).toBe(false);
  });
});

describe('baseHostnameLabel', () => {
  it('slugifies a name into a DNS-safe label', () => {
    expect(baseHostnameLabel('Survival Server!')).toBe('survival-server');
  });

  it('falls back to a safe default for a name with no usable characters', () => {
    const label = baseHostnameLabel('★★★');
    expect(isValidHostnameLabel(label)).toBe(true);
  });
});

describe('assignHostnames', () => {
  it('gives an unambiguous name its bare slug', () => {
    const assigned = assignHostnames([{ id: 'srv_01AAAAAAAAAAAAAAAAAAAAAA', name: 'Survival' }]);
    expect(assigned.get('srv_01AAAAAAAAAAAAAAAAAAAAAA')).toBe('survival');
  });

  it('gives two servers with the same name distinct, valid hostnames', () => {
    const servers = [
      { id: 'srv_01AAAAAAAAAAAAAAAAAAAAAA', name: 'Survival' },
      { id: 'srv_01BBBBBBBBBBBBBBBBBBBBBB', name: 'Survival' },
    ];
    const assigned = assignHostnames(servers);
    const first = assigned.get(servers[0]!.id);
    const second = assigned.get(servers[1]!.id);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(isValidHostnameLabel(first!)).toBe(true);
    expect(isValidHostnameLabel(second!)).toBe(true);
  });

  it('keeps the bare slug for the earliest-created server, ids sort chronologically', () => {
    const servers = [
      { id: 'srv_01BBBBBBBBBBBBBBBBBBBBBB', name: 'Survival' },
      { id: 'srv_01AAAAAAAAAAAAAAAAAAAAAA', name: 'Survival' },
    ];
    const assigned = assignHostnames(servers);
    // The lexicographically smaller id was created first, regardless of array order.
    expect(assigned.get('srv_01AAAAAAAAAAAAAAAAAAAAAA')).toBe('survival');
    expect(assigned.get('srv_01BBBBBBBBBBBBBBBBBBBBBB')).not.toBe('survival');
  });

  it('is deterministic across repeated calls with the same input', () => {
    const servers = [
      { id: 'srv_01AAAAAAAAAAAAAAAAAAAAAA', name: 'Survival' },
      { id: 'srv_01BBBBBBBBBBBBBBBBBBBBBB', name: 'Survival' },
      { id: 'srv_01CCCCCCCCCCCCCCCCCCCCCC', name: 'Creative' },
    ];
    const first = assignHostnames(servers);
    const second = assignHostnames([...servers].reverse());
    for (const server of servers) {
      expect(first.get(server.id)).toBe(second.get(server.id));
    }
  });

  it("does not let one server's hostname depend on an unrelated name", () => {
    const withoutOther = assignHostnames([{ id: 'srv_01CCCCCCCCCCCCCCCCCCCCCC', name: 'Creative' }]);
    const withOther = assignHostnames([
      { id: 'srv_01CCCCCCCCCCCCCCCCCCCCCC', name: 'Creative' },
      { id: 'srv_01DDDDDDDDDDDDDDDDDDDDDD', name: 'Modded' },
    ]);
    expect(withoutOther.get('srv_01CCCCCCCCCCCCCCCCCCCCCC')).toBe(
      withOther.get('srv_01CCCCCCCCCCCCCCCCCCCCCC'),
    );
  });
});

describe('hostnameFor', () => {
  it('looks up a single server from the group', () => {
    const servers = [
      { id: 'srv_01AAAAAAAAAAAAAAAAAAAAAA', name: 'Survival' },
      { id: 'srv_01BBBBBBBBBBBBBBBBBBBBBB', name: 'Survival' },
    ];
    expect(hostnameFor('srv_01AAAAAAAAAAAAAAAAAAAAAA', servers)).toBe('survival');
  });
});
