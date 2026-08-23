import type { BlueprintDefinition, EnvironmentHook } from './index.js';

/**
 * Palworld, on `thijsvanloef/palworld-server-docker`.
 *
 * The heaviest server in the catalogue by a wide margin. Pocket Pair's own guidance is 16 GB
 * for a full lobby, and the server does not degrade gracefully when it runs short — it stops
 * saving rather than slowing down.
 */

/**
 * Palworld advertises itself to the community browser using `PublicPort`, and it advertises
 * the value it is told, not the port it listens on. Platter maps a host port that is almost
 * never 8211, so without this the server appears in the list at an address nobody can reach.
 */
export const palworldEnvironment: EnvironmentHook = ({
  values,
  server,
}): Record<string, string> => {
  if ((values['PUBLIC_PORT'] ?? '').length > 0) return {};
  const game = server.allocations.find((allocation) => allocation.name === 'game');
  return game ? { PUBLIC_PORT: String(game.hostPort) } : {};
};

export const palworldBlueprint: BlueprintDefinition = {
  key: 'palworld',
  name: 'Palworld',
  game: 'Palworld',
  summary: 'Open-world creature collection and survival. Memory-hungry — plan for 16 GB.',
  description: [
    'A Palworld dedicated server. Be honest with yourself about memory before you start: 8 GB',
    'is the floor for a handful of players, and a full 32-player server wants 32 GB. Palworld',
    'reacts to memory pressure by failing to save, not by running slowly, so under-provisioning',
    'costs you the world rather than the framerate.',
    '',
    'Turn RCON on. The image uses it to save the world before a restart or an update, and',
    'Platter uses it for the player list and console commands.',
  ].join(' '),
  category: 'survival',
  image: 'thijsvanloef/palworld-server-docker:v2.7.1',
  icon: { monogram: 'PW', hue: 190, glyph: 'paw' },
  minMemoryMb: 8192,
  recommendedMemoryMb: 16384,
  minDiskMb: 16384,
  ports: [
    { name: 'game', label: 'Game', containerPort: 8211, protocol: 'udp', primary: true },
    { name: 'query', label: 'Steam query', containerPort: 27015, protocol: 'udp' },
    { name: 'rcon', label: 'RCON', containerPort: 25575, protocol: 'tcp', bindLocal: true },
    { name: 'restapi', label: 'REST API', containerPort: 8212, protocol: 'tcp' },
  ],
  variables: [
    {
      key: 'SERVER_NAME',
      label: 'Server name',
      type: 'string',
      default: 'Platter',
      min: 1,
      max: 64,
    },
    {
      key: 'SERVER_DESCRIPTION',
      label: 'Server description',
      type: 'string',
      default: '',
      max: 200,
    },
    {
      key: 'PLAYERS',
      label: 'Player slots',
      description: 'Memory scales almost linearly with this. 32 players needs roughly 32 GB.',
      type: 'number',
      default: 16,
      min: 1,
      max: 32,
    },
    {
      key: 'SERVER_PASSWORD',
      label: 'Server password',
      description: 'Leave empty for an open server.',
      type: 'password',
      default: '',
      max: 64,
    },
    {
      key: 'ADMIN_PASSWORD',
      label: 'Admin password',
      description: 'Also the RCON password. Required for the console and the player list.',
      type: 'password',
      default: '',
      max: 64,
    },
    {
      key: 'RCON_ENABLED',
      label: 'Enable RCON',
      description:
        'Leave on. Without it the image cannot save the world before a scheduled restart, and Platter cannot list players.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'COMMUNITY',
      label: 'List in the community browser',
      description: 'Needs an admin password set. Off keeps the server invite-only.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'DIFFICULTY',
      label: 'Difficulty',
      type: 'enum',
      default: 'None',
      options: [
        { value: 'None', label: 'Default' },
        { value: 'Casual', label: 'Casual' },
        { value: 'Normal', label: 'Normal' },
        { value: 'Hard', label: 'Hard' },
      ],
    },
    {
      key: 'DEATH_PENALTY',
      label: 'Death penalty',
      type: 'enum',
      default: 'All',
      options: [
        { value: 'None', label: 'Lose nothing' },
        { value: 'Item', label: 'Drop items, keep equipment' },
        { value: 'ItemAndEquipment', label: 'Drop items and equipment' },
        { value: 'All', label: 'Drop everything, including Pals' },
      ],
    },
    { key: 'IS_PVP', label: 'Player versus player', type: 'boolean', default: false },
    {
      key: 'MULTITHREADING',
      label: 'Enable multithreading',
      description: 'Improves performance on hosts with several cores. Safe to leave on.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'UPDATE_ON_BOOT',
      label: 'Update on every start',
      description:
        'Off pins the server to the installed build, which is what you want when players cannot update yet.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'BACKUP_ENABLED',
      label: "Use the image's own backups",
      description: 'Off is usually right — Platter already schedules backups of the same data.',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'PUBLIC_IP',
      label: 'Advertised address',
      description: 'Only needed when the auto-detected public address is wrong.',
      type: 'string',
      default: '',
      max: 255,
      advanced: true,
    },
    {
      key: 'PUBLIC_PORT',
      label: 'Advertised port',
      description:
        'Leave empty. Platter fills in the host port it published, which is what community-listed clients dial.',
      type: 'string',
      default: '',
      max: 5,
      pattern: '^\\d*$',
      advanced: true,
    },
    { key: 'TZ', label: 'Timezone', type: 'string', default: 'UTC', max: 64, advanced: true },

    // Fixed by the blueprint: these have to agree with `ports` above.
    { key: 'PORT', label: 'Game port', type: 'number', default: 8211, hidden: true },
    { key: 'QUERY_PORT', label: 'Query port', type: 'number', default: 27015, hidden: true },
    { key: 'RCON_PORT', label: 'RCON port', type: 'number', default: 25575, hidden: true },
    { key: 'REST_API_PORT', label: 'REST API port', type: 'number', default: 8212, hidden: true },
  ],
  signals: {
    ready: ['Running Palworld dedicated server on'],
    crash: [
      'LowLevelFatalError',
      'Fatal error',
      'Assertion failed',
      'Signal 11 caught',
      'Out of memory',
    ],
    // Palworld's server prints nothing on join or leave — the image's own player logging polls
    // RCON for it. Platter does the same rather than inventing a pattern that never matches.
    playerJoin: [],
    playerLeave: [],
  },
  stop: {
    // No console. The image traps the signal, asks the server to save over RCON and then
    // exits; ninety seconds is enough for a large world and short of Docker's default kill.
    strategy: 'signal',
    command: null,
    signal: 'SIGTERM',
    timeoutSeconds: 90,
  },
  dataPath: '/palworld',
  features: { console: false, rcon: true, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://palworld-server-docker.loef.dev/',
};
