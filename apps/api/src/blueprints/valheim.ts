import type { BlueprintDefinition } from './index.js';

/**
 * Valheim, on `lloesche/valheim-server`.
 *
 * That image adds the things the bare dedicated server lacks: scheduled updates that wait for
 * an empty server, world backups, and admin/ban lists managed from the environment.
 */
export const valheimBlueprint: BlueprintDefinition = {
  key: 'valheim',
  name: 'Valheim',
  game: 'Valheim',
  summary: 'Norse survival co-op. Small servers, large worlds, ten players at most.',
  description: [
    'A Valheim dedicated server. Valheim is built for small groups — ten players is the hard',
    'ceiling — but the world is large and the server holds all of it in memory, so allow 4 GB',
    'once a world has been explored for a while.',
    '',
    'Every player needs the server password, which Valheim requires to be at least five',
    'characters and refuses to accept if it appears inside the server name. Crossplay lets Xbox',
    'and Game Pass players join and uses one extra UDP port.',
  ].join(' '),
  category: 'survival',
  // lloesche publishes only `latest`, `dev` and per-commit `sha-` tags, so a commit tag is the
  // only pin available. It is still a pin: an upstream push cannot change what this resolves to.
  image: 'lloesche/valheim-server:sha-732221f4d5b5',
  icon: { monogram: 'VH', hue: 205 },
  minMemoryMb: 2048,
  recommendedMemoryMb: 4096,
  minDiskMb: 4096,
  ports: [
    { name: 'game', label: 'Game', containerPort: 2456, protocol: 'udp', primary: true },
    { name: 'query', label: 'Steam query', containerPort: 2457, protocol: 'udp' },
    { name: 'crossplay', label: 'Crossplay', containerPort: 2458, protocol: 'udp' },
  ],
  variables: [
    {
      key: 'SERVER_NAME',
      label: 'Server name',
      description: 'Shown in the Valheim server browser. Must not contain the server password.',
      type: 'string',
      default: 'Platter',
      min: 1,
      max: 64,
    },
    {
      key: 'WORLD_NAME',
      label: 'World name',
      description: 'Names the .db and .fwl save files. Changing it starts a new world.',
      type: 'string',
      default: 'Dedicated',
      min: 1,
      max: 48,
      pattern: '^[A-Za-z0-9 _.-]+$',
    },
    {
      key: 'SERVER_PASS',
      label: 'Server password',
      description:
        'At least five characters. Valheim refuses to start if this appears anywhere in the server name.',
      type: 'password',
      // No default: shipping one would mean every Platter Valheim server shared a password.
      default: null,
      required: true,
      min: 5,
      max: 64,
    },
    {
      key: 'SERVER_PUBLIC',
      label: 'List in the server browser',
      description: 'Off makes the server joinable only by direct address or join code.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'CROSSPLAY',
      label: 'Enable crossplay',
      description: 'Lets Xbox and Microsoft Store players join. Uses the extra crossplay port.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'ADMINLIST_IDS',
      label: 'Admins',
      description: 'Space-separated SteamID64s. Admins can use the in-game console commands.',
      type: 'string',
      default: '',
      max: 2000,
    },
    {
      key: 'PERMITTEDLIST_IDS',
      label: 'Allowed players',
      description: 'Space-separated SteamID64s. When set, nobody else can join.',
      type: 'string',
      default: '',
      max: 4000,
      advanced: true,
    },
    {
      key: 'BANNEDLIST_IDS',
      label: 'Banned players',
      description: 'Space-separated SteamID64s.',
      type: 'string',
      default: '',
      max: 4000,
      advanced: true,
    },
    {
      key: 'BACKUPS',
      label: "Use the image's own backups",
      description:
        'Off is usually right — Platter already backs the world up, and running both doubles the disk use.',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'UPDATE_CRON',
      label: 'Update check schedule',
      description:
        'Cron expression for the Valheim update check. Empty disables it and pins the server to the build already installed.',
      type: 'string',
      default: '*/15 * * * *',
      max: 64,
      advanced: true,
    },
    {
      key: 'UPDATE_IF_IDLE',
      label: 'Only update when empty',
      description: 'Waits for the last player to leave before applying an update.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'RESTART_CRON',
      label: 'Restart schedule',
      description: 'Cron expression for the nightly restart. Empty disables it.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'BEPINEX',
      label: 'Install BepInEx',
      description: 'The mod loader most Valheim mods need. Every player must install it too.',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'SERVER_ARGS',
      label: 'Extra server arguments',
      description: 'Appended to the Valheim command line, e.g. -saveinterval 600.',
      type: 'string',
      default: '',
      max: 400,
      advanced: true,
    },
    { key: 'TZ', label: 'Timezone', type: 'string', default: 'UTC', max: 64, advanced: true },

    // Fixed by the blueprint: has to agree with `ports` above.
    { key: 'SERVER_PORT', label: 'Server port', type: 'number', default: 2456, hidden: true },
  ],
  signals: {
    // Printed once the server has registered with the Valheim backend and is accepting joins.
    ready: ['Game server connected'],
    crash: [
      'Unable to bind',
      'Unhandled exception',
      'Failed to load world',
      'Segmentation fault',
      'Aborted \\(core dumped\\)',
    ],
    // `Got character ZDOID from Bjorn : 12345:1` — group 1 is the character name.
    playerJoin: ['Got character ZDOID from (.+?) :'],
    // Valheim only logs the socket on disconnect, so this carries a Steam id and no name. The
    // players service resolves it against the join it saw earlier.
    playerLeave: ['Closing socket (\\d+)'],
  },
  stop: {
    // No console: the server has no stdin command interface. It handles SIGTERM by saving the
    // world and exiting, and the image documents a two-minute grace period for it.
    strategy: 'signal',
    command: null,
    signal: 'SIGTERM',
    timeoutSeconds: 120,
  },
  // Not /data: this image keeps worlds, lists and backups under /config.
  dataPath: '/config',
  // `mods` stays off even though Valheim is very moddable: the flag lights up Platter's mod
  // browser, which resolves against the Minecraft registries only. BepInEx is a toggle above.
  features: { console: false, rcon: false, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/lloesche/valheim-server-docker',
};
