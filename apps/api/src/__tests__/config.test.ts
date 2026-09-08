import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripBlankValues } from '../config.js';

/**
 * Regression cover for the one fault that broke every documented way of installing Platter.
 *
 * `KEY=` in an environment file means "not set" to a person and `''` to every parser. Docker
 * Compose has no syntax for "omit this variable", so `KEY: ${KEY:-}` puts an empty string
 * into the container for anyone who has not set it; dotenv reads a bare `KEY=` the same way.
 * A schema field written as `z.string().min(1)` then rejects it, and the container
 * crash-loops on `Too small: expected string to have >=1 characters` — from a line the
 * operator deliberately left blank.
 *
 * CI never saw it: the Docker job runs `docker run` with two variables set, so the compose
 * path — the one the README tells people to use — was the single install route with no test
 * behind it.
 *
 * The rule is applied once, centrally, rather than per field, so a new optional setting
 * cannot reintroduce the fault by being declared the obvious way.
 */

describe('stripBlankValues', () => {
  it('drops keys whose value is empty, so a bare KEY= reads as unset', () => {
    expect(stripBlankValues({ PUBLIC_HOST: '', JWT_SECRET: 'kept' })).toEqual({
      JWT_SECRET: 'kept',
    });
  });

  it('treats whitespace as empty — a trailing space in an env file is not a value', () => {
    expect(stripBlankValues({ LOG_LEVEL: '   ', PUBLIC_HOST: '\t\n' })).toEqual({});
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

describe('config built from an environment with blanks in it', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /**
   * The end-to-end shape of the bug: re-import the module with the environment a blank
   * line in `.env` actually produces, and require a working default rather than a throw.
   */
  it('starts, and uses the documented default, when a setting is left blank', async () => {
    vi.stubEnv('PUBLIC_HOST', '');
    vi.stubEnv('LOG_LEVEL', '');
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.publicHost).toBe('127.0.0.1');
    expect(config.logLevel).toBe('info');
  });

  it('still reads a value that is actually set', async () => {
    vi.stubEnv('PUBLIC_HOST', 'play.example.com');
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.publicHost).toBe('play.example.com');
  });
});
