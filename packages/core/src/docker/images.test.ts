import { describe, expect, it } from 'vitest';
import { imageRepository, isAllowedImage } from './images';

describe('imageRepository', () => {
  it('strips a tag', () => {
    expect(imageRepository('itzg/minecraft-server:java21')).toBe('itzg/minecraft-server');
  });

  it('strips a digest', () => {
    expect(imageRepository('itzg/minecraft-server@sha256:abc123')).toBe('itzg/minecraft-server');
    expect(imageRepository('itzg/minecraft-server:java21@sha256:abc123')).toBe(
      'itzg/minecraft-server'
    );
  });

  it('keeps a registry port, which is not a tag separator', () => {
    // Splitting on the first colon yields `registry.internal`, which matches no allowlist entry —
    // and the air-gapped mirror is a documented configuration, so the operator's only way out was
    // to disable the allowlist entirely.
    expect(imageRepository('registry.internal:5000/itzg/minecraft-server:java21')).toBe(
      'registry.internal:5000/itzg/minecraft-server'
    );
    expect(imageRepository('registry.internal:5000/itzg/minecraft-server')).toBe(
      'registry.internal:5000/itzg/minecraft-server'
    );
  });

  it('handles a bare repository with no tag', () => {
    expect(imageRepository('itzg/minecraft-server')).toBe('itzg/minecraft-server');
  });
});

describe('isAllowedImage', () => {
  it('accepts the built-in repositories', () => {
    expect(isAllowedImage('itzg/minecraft-server:java25', false)).toBe(true);
    expect(isAllowedImage('itzg/mc-backup:latest', false)).toBe(true);
  });

  it('rejects anything else', () => {
    // A panel that runs an arbitrary image on request is a remote code execution primitive.
    expect(isAllowedImage('attacker/evil:latest', false)).toBe(false);
    expect(isAllowedImage('alpine', false)).toBe(false);
  });

  it('accepts a configured mirror, port and all', () => {
    expect(
      isAllowedImage('registry.internal:5000/itzg/minecraft-server:java25', false, [
        'registry.internal:5000/itzg/minecraft-server',
      ])
    ).toBe(true);
  });

  it('waves everything through only when custom images are explicitly enabled', () => {
    expect(isAllowedImage('attacker/evil:latest', true)).toBe(true);
  });
});
