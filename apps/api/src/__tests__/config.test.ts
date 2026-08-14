import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripBlankValues } from '../config.js';

/**
 * Regression cover for the one fault that broke every documented way of installing Platter.
 *
 * `docker-compose.yml` passes `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}`, and Compose has no
 * syntax for "omit this variable" — so an operator without an Anthropic key got an empty
 * string in the container, `z.string().min(1).optional()` rejected it, and the container
 * crash-looped on `ANTHROPIC_API_KEY: Too small: expected string to have >=1 characters`.
 * `cp .env.example .env && pnpm dev` failed the same way, because dotenv reads a bare `KEY=`
 * as `''` as well.
 *
 * CI never saw it: the Docker job runs `docker run` with only JWT_SECRET and
 * DEFAULT_NODE_DRIVER set, so the compose path — the one the README tells people to use —
 * was the single install route with no test behind it.
 */

describe('stripBlankValues', () => {
  it('drops keys whose value is empty, so a bare KEY= reads as unset', () => {
    expect(stripBlankValues({ ANTHROPIC_API_KEY: '', JWT_SECRET: 'kept' })).toEqual({
      JWT_SECRET: 'kept',
    });
  });

  it('treats whitespace as empty — a trailing space in an env file is not a value', () => {
    expect(stripBlankValues({ AI_MODEL: '   ', PUBLIC_HOST: '\t\n' })).toEqual({});
  });

  it('keeps WEB_ROOT and CORS_ORIGINS blank, where blank is the documented setting', () => {
    expect(stripBlankValues({ WEB_ROOT: '', CORS_ORIGINS: '' })).toEqual({
      WEB_ROOT: '',
      CORS_ORIGINS: '',
    });
  });

  it('leaves every real value alone, including ones that merely look empty', () => {
    const input = { PORT: '8080', REGISTRATION_ENABLED: 'false', PORT_RANGE_START: '0' };
    expect(stripBlankValues(input)).toEqual(input);
  });

  it('passes non-object input through rather than throwing', () => {
    expect(stripBlankValues(null)).toBeNull();
    expect(stripBlankValues('nonsense')).toBe('nonsense');
  });
});

describe('config with a blank ANTHROPIC_API_KEY', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /**
   * The end-to-end shape of the bug: re-import the module with the exact environment
   * `docker compose up` produces for an operator who has no Anthropic key.
   */
  it('starts, and reports AI as unavailable rather than refusing to boot', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.aiEnabled).toBe(false);
    expect(config.anthropicApiKey).toBeNull();
  });

  it('still reads a key that is actually set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-not-a-real-key');
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.aiEnabled).toBe(true);
    expect(config.anthropicApiKey).toBe('sk-ant-not-a-real-key');
  });

  /** Blank values must fall back to the documented default, not to a startup error. */
  it('falls back to the default AI model when AI_MODEL is blank', async () => {
    vi.stubEnv('AI_MODEL', '');
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.aiModel).toBe('claude-opus-5');
  });
});
