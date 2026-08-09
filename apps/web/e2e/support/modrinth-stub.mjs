/**
 * A stand-in for api.modrinth.com, for the mod-proposal journey.
 *
 * The proposal flow is the one place where Platter talks to a third party, and the e2e run
 * has to be able to exercise it on a machine with no egress — the same promise the unit
 * suite makes ("no Docker daemon and no network"). So the API is pointed at this process
 * with `MODRINTH_BASE_URL` and it answers the five v2 endpoints the flow actually calls:
 *
 *   GET /search                      the browser's search
 *   GET /project/:ref                the project the reviewer reads
 *   GET /project/:ref/members        the author line on the detail panel
 *   GET /project/:ref/version        version list, for "newest this server can load"
 *   GET /version/:ref                one version, when a proposal pins it
 *
 * The shapes are Modrinth's wire shapes, not Platter's: `apps/api/src/mods/modrinth.ts`
 * parses these with zod and normalises them, and that normalisation is part of what the
 * journey is testing. Serving Platter's own vocabulary here would skip it.
 *
 * The project is invented rather than copied from a real one. A fixture that claims to be
 * somebody's actual plugin, with their name and licence attached, is a fixture that ends up
 * quoted in a screenshot as though it were real.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MODRINTH_STUB_PORT ?? 8793);

/**
 * A Paper plugin, so `installTargetFor('PAPER', ['paper','spigot','bukkit'])` resolves to
 * `plugins/` and the review panel can say exactly which directory it would write to.
 *
 * No dependencies: the resolver walks required dependencies, and the property this journey
 * asserts is the approval gate, not the graph walk.
 */
const PROJECT_ID = 'PLTRSTUB';
const SLUG = 'lantern-lights';
const TITLE = 'Lantern Lights';
const VERSION_ID = 'lanternv1';
const VERSION_NUMBER = '1.4.0';
const FILENAME = 'lantern-lights-1.4.0.jar';
const SIZE_BYTES = 481_027;

/*
 * The download host is Modrinth's real CDN because the installer refuses anything else
 * (`ALLOWED_DOWNLOAD_HOSTS` in `apps/api/src/mods/install.ts`) — pointing it at this stub
 * would make the e2e run assert the wrong thing, since the refusal, not the download, is
 * what would be under test. Nothing in the suite approves a proposal to completion, so this
 * URL is never fetched.
 */
const DOWNLOAD_URL = `https://cdn.modrinth.com/data/${PROJECT_ID}/versions/${VERSION_ID}/${FILENAME}`;

const SUMMARY = 'Placeable lanterns that keep mobs from spawning in a radius you choose.';
const AUTHOR = 'e2e-fixtures';

const project = {
  id: PROJECT_ID,
  slug: SLUG,
  project_type: 'mod',
  title: TITLE,
  description: SUMMARY,
  body: [
    '## What it does',
    '',
    'Placeable lanterns that keep hostile mobs from spawning within a radius you choose.',
    '',
    '- Configurable spawn-proofing radius',
    '- Survives a world reload',
    '',
    '_A fixture used by Platter’s end-to-end suite. Not a real plugin._',
  ].join('\n'),
  categories: ['utility'],
  additional_categories: [],
  game_versions: ['1.21', '1.21.1'],
  loaders: ['paper', 'spigot', 'bukkit'],
  downloads: 128_400,
  followers: 3_120,
  icon_url: null,
  issues_url: null,
  source_url: null,
  wiki_url: null,
  discord_url: null,
  updated: '2026-07-14T09:12:00Z',
  client_side: 'unsupported',
  server_side: 'required',
  license: { id: 'MIT', name: 'MIT License', url: null },
  donation_urls: [],
  gallery: [],
};

const version = {
  id: VERSION_ID,
  project_id: PROJECT_ID,
  name: `Lantern Lights ${VERSION_NUMBER}`,
  version_number: VERSION_NUMBER,
  changelog: 'Fixes a leak when a lantern is broken while a chunk is unloading.',
  date_published: '2026-07-14T09:12:00Z',
  downloads: 41_002,
  version_type: 'release',
  game_versions: ['1.21', '1.21.1'],
  loaders: ['paper', 'spigot', 'bukkit'],
  files: [
    {
      filename: FILENAME,
      url: DOWNLOAD_URL,
      size: SIZE_BYTES,
      primary: true,
      hashes: {
        sha512:
          '9f2a1c4e7b6d8035ae1f2b93c47d5e60f81a2b3c4d5e6f708192a3b4c5d6e7f8' +
          '0918273645ac0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0',
        sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      },
    },
  ],
  dependencies: [],
};

const searchHit = {
  project_id: PROJECT_ID,
  project_type: 'mod',
  slug: SLUG,
  title: TITLE,
  description: SUMMARY,
  author: AUTHOR,
  categories: ['utility', 'paper'],
  display_categories: ['utility'],
  versions: ['1.21', '1.21.1'],
  downloads: 128_400,
  follows: 3_120,
  icon_url: null,
  date_modified: '2026-07-14T09:12:00Z',
  license: 'MIT',
  client_side: 'unsupported',
  server_side: 'required',
};

const members = [{ role: 'Owner', user: { username: AUTHOR, name: AUTHOR } }];

/** Matches the one fixture project by either id or slug, the way Modrinth's refs work. */
function isOurProject(ref) {
  const decoded = decodeURIComponent(ref).toLowerCase();
  return decoded === PROJECT_ID.toLowerCase() || decoded === SLUG;
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    // The client reads these to pace itself; a generous budget keeps it from ever sleeping.
    'x-ratelimit-limit': '300',
    'x-ratelimit-remaining': '299',
    'x-ratelimit-reset': '60',
  });
  response.end(payload);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub.invalid');
  // Tolerates the `/v2` prefix so the base URL can be given with or without it.
  const path = url.pathname.replace(/^\/v2/, '');

  if (path === '/health') return send(response, 200, { ok: true });

  if (path === '/search') {
    const query = (url.searchParams.get('query') ?? '').toLowerCase();
    // Substring on the words a person would actually type. Everything else finds nothing,
    // which is itself a state the browser has to render.
    const hit =
      query === '' || TITLE.toLowerCase().includes(query) || SLUG.includes(query) ? [searchHit] : [];
    return send(response, 200, {
      hits: hit,
      offset: 0,
      limit: Number(url.searchParams.get('limit') ?? 20),
      total_hits: hit.length,
    });
  }

  const projectMembers = /^\/project\/([^/]+)\/members$/.exec(path);
  if (projectMembers) {
    return isOurProject(projectMembers[1])
      ? send(response, 200, members)
      : send(response, 404, { error: 'not_found' });
  }

  const projectVersions = /^\/project\/([^/]+)\/version$/.exec(path);
  if (projectVersions) {
    return isOurProject(projectVersions[1])
      ? send(response, 200, [version])
      : send(response, 404, { error: 'not_found' });
  }

  const projectDetail = /^\/project\/([^/]+)$/.exec(path);
  if (projectDetail) {
    return isOurProject(projectDetail[1])
      ? send(response, 200, project)
      : send(response, 404, { error: 'not_found' });
  }

  const versionDetail = /^\/version\/([^/]+)$/.exec(path);
  if (versionDetail) {
    return decodeURIComponent(versionDetail[1]) === VERSION_ID
      ? send(response, 200, version)
      : send(response, 404, { error: 'not_found' });
  }

  send(response, 404, { error: 'not_found', path });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`modrinth stub listening on http://127.0.0.1:${PORT}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
