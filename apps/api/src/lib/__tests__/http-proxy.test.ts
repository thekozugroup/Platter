import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { configureHttpProxy, proxyConfigured } from '../http-proxy.js';

/**
 * Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, unlike curl, git and npm. Every outbound
 * call Platter makes — mod registries, the Anthropic API — therefore goes direct unless a
 * dispatcher is installed, and an operator behind an egress proxy sees mod search fail with
 * nothing in the logs naming the proxy as the cause.
 *
 * This was found by running the real thing: REST mod search worked while the same search over
 * MCP stdio failed, because the stdio server is a separate process that was not calling this.
 */

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const;

function clearProxyEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of PROXY_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof configureHttpProxy>[0];

afterEach(() => {
  vi.clearAllMocks();
});

describe('proxyConfigured', () => {
  it('is false when the environment names no proxy', () => {
    expect(proxyConfigured({})).toBe(false);
  });

  it('accepts either case, as every other tool does', () => {
    expect(proxyConfigured({ HTTPS_PROXY: 'http://proxy:3128' })).toBe(true);
    expect(proxyConfigured({ https_proxy: 'http://proxy:3128' })).toBe(true);
    expect(proxyConfigured({ HTTP_PROXY: 'http://proxy:3128' })).toBe(true);
    expect(proxyConfigured({ http_proxy: 'http://proxy:3128' })).toBe(true);
  });
});

describe('configureHttpProxy', () => {
  it('leaves the dispatcher alone when no proxy is configured', () => {
    const saved = clearProxyEnv();
    const before = getGlobalDispatcher();
    try {
      configureHttpProxy(logger);
      expect(getGlobalDispatcher()).toBe(before);
    } finally {
      restoreEnv(saved);
      setGlobalDispatcher(before);
    }
  });

  it('installs a dispatcher when a proxy is configured', () => {
    const saved = clearProxyEnv();
    const before = getGlobalDispatcher();
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    try {
      configureHttpProxy(logger);
      expect(getGlobalDispatcher()).not.toBe(before);
    } finally {
      restoreEnv(saved);
      setGlobalDispatcher(before);
    }
  });

  it('never logs proxy credentials', () => {
    const saved = clearProxyEnv();
    const before = getGlobalDispatcher();
    process.env.HTTPS_PROXY = 'http://alice:hunter2@proxy.internal:3128';
    try {
      configureHttpProxy(logger);
      const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
      expect(logged).not.toContain('hunter2');
      expect(logged).toContain('proxy.internal');
    } finally {
      restoreEnv(saved);
      setGlobalDispatcher(before);
    }
  });

  it('keeps the process alive when the proxy URL is unusable', () => {
    const saved = clearProxyEnv();
    const before = getGlobalDispatcher();
    process.env.HTTPS_PROXY = 'not a url';
    try {
      // Outbound calls are all optional; the panel is not. A bad value is logged, not fatal.
      expect(() => configureHttpProxy(logger)).not.toThrow();
    } finally {
      restoreEnv(saved);
      setGlobalDispatcher(before);
    }
  });
});
