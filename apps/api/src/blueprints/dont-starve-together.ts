import type { BlueprintDefinition } from './index.js';

/**
 * Don't Starve Together, on `jamesits/dst-server`.
 *
 * Klei's server is configured entirely by files in the cluster directory — `cluster.ini`, the
 * per-shard `server.ini`, and the cluster token. Only the token is worth lifting into a
 * variable, because it is a secret; the rest is edited in Platter's file editor, where the
 * shard layout is visible.
 */
export const dontStarveTogetherBlueprint: BlueprintDefinition = {
  key: 'dont-starve-together',
  name: "Don't Starve Together",
  game: "Don't Starve Together",
  summary: 'Gothic survival co-op. Light on resources, but needs a cluster token from Klei.',
  description: [
    "A Don't Starve Together dedicated server. It is one of the lighter servers here — 2 GB is",
    'plenty for a six-player world — but it will not start without a cluster token, which you',
    'generate from the Klei account page while logged into the game.',
    '',
    'The world runs as one or two shards: the surface (Master) and, optionally, the caves. Each',
    'shard is a directory with its own `server.ini` under the cluster folder, alongside the',
    "shared `cluster.ini`. Edit those in Platter's file editor after the first start.",
    '',
    'Shutting down takes a while — Klei saves the whole world on exit and it can take minutes.',
    'Interrupting that is how people lose worlds, so the stop timeout here is deliberately long.',
  ].join(' '),
  category: 'survival',
  // Digest-pinned: the publisher ships only rolling tags. The image is a SteamCMD wrapper, so
  // the game build still comes from Steam at start — only the tooling is frozen here.
  image:
    'jamesits/dst-server@sha256:fa61065f8d2d770bc5d45f1a160b87b1deada3fd5903d9524b771321ca98dc58',
  icon: { monogram: 'DS', hue: 336, glyph: 'campfire' },
  minMemoryMb: 1024,
  recommendedMemoryMb: 2048,
  minDiskMb: 4096,
  ports: [
    {
      name: 'master',
      label: 'Surface shard',
      containerPort: 10999,
      protocol: 'udp',
      primary: true,
    },
    { name: 'caves', label: 'Caves shard', containerPort: 11000, protocol: 'udp' },
    { name: 'steam', label: 'Steam', containerPort: 12346, protocol: 'udp' },
    { name: 'steamauth', label: 'Steam authentication', containerPort: 12347, protocol: 'udp' },
  ],
  variables: [
    {
      key: 'DST_CLUSTER_TOKEN',
      label: 'Cluster token',
      description:
        'From the Games page of your Klei account, or the in-game server settings. The server cannot start without one, and a token can only be used by one running server at a time.',
      type: 'password',
      default: null,
      required: true,
      min: 16,
      max: 512,
    },
    {
      key: 'DST_SERVER_ARCH',
      label: 'Server architecture',
      description: 'Klei ships a 64-bit server; only change this for a very old save.',
      type: 'enum',
      default: 'amd64',
      options: [
        { value: 'amd64', label: '64-bit' },
        { value: 'i386', label: '32-bit (legacy)' },
      ],
      advanced: true,
    },
    { key: 'TZ', label: 'Timezone', type: 'string', default: 'UTC', max: 64, advanced: true },
  ],
  signals: {
    // Printed once the shard has a session and is accepting connections.
    ready: ['Telling Client our new session identifier'],
    crash: [
      'LUA ERROR stack traceback',
      'Segmentation fault',
      'Aborted \\(core dumped\\)',
      'Failed to start server',
    ],
    // Klei's own announcements. Group 1 is the player name.
    playerJoin: ['\\[Join Announcement\\] (.+)'],
    playerLeave: ['\\[Leave Announcement\\] (.+)'],
  },
  stop: {
    // SIGINT, not SIGTERM: the image's supervisor forwards an interrupt to the server, which is
    // what triggers Klei's save-and-exit. A world save can genuinely take minutes on a long
    // running cluster, and cutting it short is how a world is lost.
    strategy: 'signal',
    command: null,
    signal: 'SIGINT',
    timeoutSeconds: 300,
  },
  dataPath: '/data',
  features: { console: false, rcon: false, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/Jamesits/docker-dst-server',
};
