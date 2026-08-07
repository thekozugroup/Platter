import { readFileSync } from 'node:fs';
import { VersionIndex } from '@platter/shared';
import type { ModProject, ModVersion } from '../types';

/**
 * Test support. Recorded payloads and hand-built objects, no network.
 *
 * The JSON in this directory is real: captured from the live APIs while the clients were being
 * written, then trimmed (icons stripped from the loader tags, long file lists cut to a few
 * entries). Invented payloads drift from reality and the tests stop testing anything — the same
 * rule the diagnostics rules follow for log excerpts.
 */

/** Read a recorded payload. `readFileSync` rather than a JSON import so nothing depends on how
 *  the module resolver of the day feels about import attributes. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as T;
}

interface GameVersionTag {
  version: string;
  version_type: 'release' | 'snapshot' | 'alpha' | 'beta';
  date: string;
  major: boolean;
}

/**
 * A `VersionIndex` over the real `/v2/tag/game_version` ordering.
 *
 * Contains the calendar-versioning era (`26.1`, `26.2`) above the classic `1.21.x` line, which
 * is exactly the ordering every string comparator gets backwards.
 */
export function gameVersionIndex(): VersionIndex {
  const tags = fixture<GameVersionTag[]>('modrinth-tag-game-version.json');
  return new VersionIndex(
    tags.map((tag) => ({
      version: tag.version,
      versionType: tag.version_type,
      date: tag.date,
      major: tag.major,
    }))
  );
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

export function makeProject(overrides: Partial<ModProject> = {}): ModProject {
  return {
    id: 'modrinth:AANobbMI',
    provider: 'modrinth',
    projectId: 'AANobbMI',
    slug: 'test-mod',
    title: 'Test Mod',
    summary: 'A mod for tests',
    description: null,
    author: 'someone',
    iconUrl: null,
    projectUrl: 'https://modrinth.com/mod/test-mod',
    license: 'MIT',
    downloads: 1000,
    followers: 10,
    kind: 'mod',
    clientSide: 'optional',
    serverSide: 'required',
    environment: 'server_only_client_optional',
    categories: ['utility'],
    loaders: ['fabric'],
    gameVersions: ['1.21.1'],
    ...overrides,
  };
}

export function makeVersion(overrides: Partial<ModVersion> = {}): ModVersion {
  return {
    id: 'modrinth:v1',
    provider: 'modrinth',
    versionId: 'v1',
    projectId: 'AANobbMI',
    versionNumber: '1.0.0',
    name: 'Test Mod 1.0.0',
    channel: 'release',
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    dependencies: [],
    file: {
      name: 'test-mod-1.0.0.jar',
      url: 'https://cdn.modrinth.com/test-mod-1.0.0.jar',
      size: 1024,
      sha1: 'a'.repeat(40),
      sha512: null,
    },
    downloadable: true,
    downloadBlockedReason: null,
    environmentTags: [],
    publishedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Fake fetch                                                                  */
/* -------------------------------------------------------------------------- */

export interface FakeResponse {
  status?: number;
  /** Serialised as JSON. Ignored when `text` is set. */
  body?: unknown;
  /** Raw body. Use `''` to reproduce the empty-body 404s both APIs actually send. */
  text?: string;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
}

/** Deterministic `fetch` double. The handler sees the call index so retries can differ. */
export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => FakeResponse
): FakeFetch {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const index = calls.length;
    calls.push({ url, init });
    const spec = handler(url, init, index);
    const body = spec.text ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
    return new Response(body.length === 0 ? null : body, {
      status: spec.status ?? 200,
      headers: spec.headers,
    });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

/** Never sleeps. Records what the client *would* have waited, which is what we assert on. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}
