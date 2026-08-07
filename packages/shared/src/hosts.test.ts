import { describe, expect, it } from 'vitest';
import {
  hostname,
  hostPolicy,
  isHostAllowed,
  isIpLiteral,
  isOriginAllowed,
  isStateChanging,
} from './hosts';

describe('hostname', () => {
  it('strips the port', () => {
    expect(hostname('localhost:4880')).toBe('localhost');
    expect(hostname('example.test')).toBe('example.test');
  });

  it('keeps IPv6 brackets and does not mistake the address for a port', () => {
    expect(hostname('[::1]:4880')).toBe('[::1]');
    expect(hostname('[fe80::1]')).toBe('[fe80::1]');
  });

  it('is case insensitive', () => {
    expect(hostname('LocalHost:4880')).toBe('localhost');
  });
});

describe('isIpLiteral', () => {
  it('recognises the forms a DNS answer cannot produce', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('192.168.1.20')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('[fe80::1]')).toBe(true);
  });

  it('rejects names', () => {
    expect(isIpLiteral('localhost')).toBe(false);
    expect(isIpLiteral('platter.lan')).toBe(false);
    // The one that matters: a name that merely looks numeric is still a name.
    expect(isIpLiteral('127.0.0.1.evil.test')).toBe(false);
  });
});

describe('isHostAllowed', () => {
  const policy = hostPolicy('platter.lan, Games.Example.Test');

  it('accepts loopback names and any IP literal', () => {
    expect(isHostAllowed(policy, 'localhost:4880')).toBe(true);
    expect(isHostAllowed(policy, '127.0.0.1:4880')).toBe(true);
    expect(isHostAllowed(policy, '[::1]:4880')).toBe(true);
    // A LAN address needs no configuration: reaching Platter this way is cross-origin for an
    // attacker's page, so it cannot read the answer.
    expect(isHostAllowed(policy, '192.168.1.20:4880')).toBe(true);
  });

  it('accepts configured names, case insensitively', () => {
    expect(isHostAllowed(policy, 'platter.lan')).toBe(true);
    expect(isHostAllowed(policy, 'games.example.test:4880')).toBe(true);
  });

  it('rejects an unlisted name — the rebinding case', () => {
    expect(isHostAllowed(policy, 'evil.test:4880')).toBe(false);
    expect(isHostAllowed(policy, 'platter.lan.evil.test')).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(isHostAllowed(policy, null)).toBe(false);
    expect(isHostAllowed(policy, '  ')).toBe(false);
  });

  it('defaults to loopback names only when nothing is configured', () => {
    const bare = hostPolicy(undefined);
    expect(isHostAllowed(bare, 'localhost:4880')).toBe(true);
    expect(isHostAllowed(bare, 'platter.lan')).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('allows a same-host origin', () => {
    expect(isOriginAllowed('http://localhost:4880', 'localhost:4880')).toBe(true);
    expect(isOriginAllowed('https://Localhost:4880', 'localhost:4880')).toBe(true);
  });

  it('allows a request with no origin — that is a non-browser client', () => {
    expect(isOriginAllowed(null, 'localhost:4880')).toBe(true);
    expect(isOriginAllowed('null', 'localhost:4880')).toBe(true);
  });

  it('rejects a cross-site origin', () => {
    expect(isOriginAllowed('http://evil.test', 'localhost:4880')).toBe(false);
    // Same name, different port is a different origin.
    expect(isOriginAllowed('http://localhost:3000', 'localhost:4880')).toBe(false);
  });

  it('rejects an unparseable origin rather than waving it through', () => {
    expect(isOriginAllowed('not a url', 'localhost:4880')).toBe(false);
  });
});

describe('isStateChanging', () => {
  it('covers the methods that need the origin check', () => {
    expect(isStateChanging('GET')).toBe(false);
    expect(isStateChanging('HEAD')).toBe(false);
    expect(isStateChanging('OPTIONS')).toBe(false);
    expect(isStateChanging('POST')).toBe(true);
    expect(isStateChanging('DELETE')).toBe(true);
  });
});
