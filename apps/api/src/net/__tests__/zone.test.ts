import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZONE,
  buildSrvRecord,
  buildWildcardARecord,
  buildZoneFile,
  connectString,
  fqdn,
  isMdnsEligible,
  isValidZoneName,
} from '../zone.js';

describe('isValidZoneName', () => {
  it('accepts a real domain and the default zone', () => {
    expect(isValidZoneName(DEFAULT_ZONE)).toBe(true);
    expect(isValidZoneName('games.example.com')).toBe(true);
  });

  it('rejects a bare label — a zone is a domain, not a single word', () => {
    expect(isValidZoneName('home')).toBe(false);
  });

  it('rejects a domain with an invalid label', () => {
    expect(isValidZoneName('Games.example.com')).toBe(false);
    expect(isValidZoneName('.example.com')).toBe(false);
  });
});

describe('isMdnsEligible', () => {
  it('is true for the default zone and any other .local domain', () => {
    expect(isMdnsEligible('platter.local')).toBe(true);
    expect(isMdnsEligible('mycompany.local')).toBe(true);
  });

  it('is false for a real internet domain', () => {
    expect(isMdnsEligible('games.example.com')).toBe(false);
  });
});

describe('buildSrvRecord', () => {
  it('renders the record a Minecraft Java client actually queries', () => {
    const record = buildSrvRecord('platter.local', { label: 'survival', port: 25565 });

    expect(record.name).toBe('_minecraft._tcp.survival.platter.local.');
    expect(record.target).toBe('survival.platter.local.');
    expect(record.port).toBe(25565);
    expect(record.protocol).toBe('tcp');
    expect(record.line).toContain('SRV');
    expect(record.line).toContain('25565');
  });

  it('honours a custom service and protocol', () => {
    const record = buildSrvRecord('example.com', {
      label: 'valheim',
      port: 2456,
      service: 'valheim',
      protocol: 'udp',
    });
    expect(record.name).toBe('_valheim._udp.valheim.example.com.');
    expect(record.service).toBe('_valheim');
    expect(record.protocol).toBe('udp');
  });
});

describe('buildWildcardARecord', () => {
  it('renders a real target when one is known', () => {
    const record = buildWildcardARecord('example.com', '203.0.113.10');
    expect(record.name).toBe('*.example.com.');
    expect(record.target).toBe('203.0.113.10');
    expect(record.line).toContain('203.0.113.10');
  });

  it('renders an honest placeholder instead of guessing', () => {
    const record = buildWildcardARecord('example.com', null);
    expect(record.target).toBe('<YOUR-PUBLIC-IP>');
  });
});

describe('buildZoneFile', () => {
  it('renders one SRV record per listed server plus the wildcard A record', () => {
    const zoneFile = buildZoneFile({
      zone: 'example.com',
      target: '203.0.113.10',
      servers: [
        { label: 'survival', port: 25565 },
        { label: 'creative', port: 25566 },
      ],
    });

    expect(zoneFile.srvRecords).toHaveLength(2);
    expect(zoneFile.text).toContain('*.example.com.');
    expect(zoneFile.text).toContain('_minecraft._tcp.survival.example.com.');
    expect(zoneFile.text).toContain('_minecraft._tcp.creative.example.com.');
  });

  it('still renders a usable file with no SRV-eligible servers', () => {
    const zoneFile = buildZoneFile({ zone: 'example.com', target: null, servers: [] });
    expect(zoneFile.srvRecords).toHaveLength(0);
    expect(zoneFile.text).toContain('*.example.com.');
  });
});

describe('fqdn', () => {
  it('joins a label and a zone with no trailing dot', () => {
    expect(fqdn('survival', 'platter.local')).toBe('survival.platter.local');
  });
});

describe('connectString', () => {
  const base = { hostname: 'survival.platter.local', ip: '192.168.1.50', port: 25565 };

  it('picks the bare hostname only when an SRV record exists', () => {
    expect(connectString({ ...base, hostnameResolves: true, srvCoversPort: true })).toBe(
      'survival.platter.local',
    );
  });

  it('falls back to host:port when the hostname resolves but has no SRV coverage', () => {
    expect(connectString({ ...base, hostnameResolves: true, srvCoversPort: false })).toBe(
      'survival.platter.local:25565',
    );
  });

  it('falls back to ip:port when the hostname does not resolve at all', () => {
    expect(connectString({ ...base, hostnameResolves: false, srvCoversPort: true })).toBe(
      '192.168.1.50:25565',
    );
  });
});
