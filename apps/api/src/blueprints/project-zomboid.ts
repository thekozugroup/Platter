import type { BlueprintDefinition, EnvironmentHook } from './index.js';

/**
 * Project Zomboid, on `renegademaster/zomboid-dedicated-server`.
 *
 * Zomboid's server is a Java application, so the same heap-versus-container trap that catches
 * Minecraft catches this one — see `zomboidHeapMb` below.
 */

/**
 * `MAX_RAM` becomes the JVM's `-Xmx`. Everything the JVM allocates outside the heap — the
 * zombie pathfinding native code, thread stacks, metaspace — sits on top of it, so a heap
 * sized at the container limit gets the container OOM-killed with no Java stack trace to
 * explain it. Zomboid's non-heap footprint is smaller than a modded Minecraft's, so the
 * reserve is smaller too, but it is not zero.
 */
const NON_HEAP_RESERVE_RATIO = 0.15;
const MIN_NON_HEAP_RESERVE_MB = 512;
const MAX_NON_HEAP_RESERVE_MB = 1536;
const MIN_HEAP_MB = 1024;

export function zomboidHeapMb(containerMemoryMb: number): number {
  const proportional = Math.ceil(containerMemoryMb * NON_HEAP_RESERVE_RATIO);
  const reserve = Math.min(
    MAX_NON_HEAP_RESERVE_MB,
    Math.max(MIN_NON_HEAP_RESERVE_MB, proportional),
  );
  return Math.max(MIN_HEAP_MB, containerMemoryMb - reserve);
}

export const projectZomboidEnvironment: EnvironmentHook = ({
  values,
  server,
}): Record<string, string> => {
  if ((values['MAX_RAM'] ?? '').length > 0) return {};
  return { MAX_RAM: `${zomboidHeapMb(server.limits.memoryMb)}m` };
};

export const projectZomboidBlueprint: BlueprintDefinition = {
  key: 'project-zomboid',
  name: 'Project Zomboid',
  game: 'Project Zomboid',
  summary: 'Isometric zombie survival. Persistent world, heavy on memory as the map is explored.',
  description: [
    'A Project Zomboid dedicated server. Memory use grows with how much of the map players have',
    'visited, not with how many of them there are — a long-running server on a well-explored map',
    'will use far more than a fresh one, so give it room to grow.',
    '',
    'Platter sizes the Java heap from the container limit and leaves headroom outside it, which',
    'is what stops the kernel killing the server without warning. Workshop mods are listed by id',
    'below and downloaded at start; the ids and the mod names both have to be right or the',
    'server starts without them.',
  ].join(' '),
  category: 'survival',
  image: 'renegademaster/zomboid-dedicated-server:2.5.0',
  icon: { monogram: 'PZ', hue: 4 },
  minMemoryMb: 2048,
  recommendedMemoryMb: 6144,
  minDiskMb: 8192,
  ports: [
    { name: 'game', label: 'Game', containerPort: 16261, protocol: 'udp', primary: true },
    { name: 'direct', label: 'Direct connection', containerPort: 16262, protocol: 'udp' },
    { name: 'steam', label: 'Steam', containerPort: 8766, protocol: 'udp' },
    { name: 'rcon', label: 'RCON', containerPort: 27015, protocol: 'tcp', bindLocal: true },
  ],
  variables: [
    {
      key: 'SERVER_NAME',
      label: 'Server name',
      description: 'Also names the save folder. Changing it starts a new world.',
      type: 'string',
      default: 'PlatterServer',
      min: 1,
      max: 48,
      pattern: '^[A-Za-z0-9_-]+$',
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
      key: 'ADMIN_USERNAME',
      label: 'Admin username',
      type: 'string',
      default: 'superuser',
      min: 1,
      max: 32,
    },
    {
      key: 'ADMIN_PASSWORD',
      label: 'Admin password',
      description: 'The in-game admin account. Change it — the image ships a well-known default.',
      type: 'password',
      default: null,
      required: true,
      min: 8,
      max: 64,
    },
    {
      key: 'RCON_PASSWORD',
      label: 'RCON password',
      description: 'Required for the console, scheduled commands and the player list.',
      type: 'password',
      default: null,
      required: true,
      min: 8,
      max: 64,
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      type: 'number',
      default: 16,
      min: 1,
      max: 100,
    },
    {
      key: 'PUBLIC_SERVER',
      label: 'List in the public server browser',
      type: 'boolean',
      default: false,
    },
    {
      key: 'PAUSE_ON_EMPTY',
      label: 'Pause when empty',
      description:
        'Stops time passing while nobody is connected. Saves CPU and stops the world rotting.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'AUTOSAVE_INTERVAL',
      label: 'Autosave interval',
      description: 'Zomboid syntax, e.g. 15m. How much progress a crash can cost.',
      type: 'string',
      default: '15m',
      max: 8,
      pattern: '^\\d+[smh]$',
    },
    {
      key: 'MAP_NAMES',
      label: 'Maps',
      description: 'Semicolon-separated, in load order. Mod maps go before `Muldraugh, KY`.',
      type: 'string',
      default: 'Muldraugh, KY',
      max: 1000,
    },
    {
      key: 'MOD_WORKSHOP_IDS',
      label: 'Workshop item ids',
      description: 'Semicolon-separated numeric Steam Workshop ids to download.',
      type: 'string',
      default: '',
      max: 4000,
    },
    {
      key: 'MOD_NAMES',
      label: 'Mod ids',
      description:
        'Semicolon-separated mod ids to load. These are not the Workshop ids — a mod needs both lists filled in.',
      type: 'string',
      default: '',
      max: 4000,
    },
    {
      key: 'MAX_RAM',
      label: 'Java heap override',
      description:
        'Leave empty. Platter sizes the heap from the container memory limit, keeping enough outside it that the kernel does not kill the server. Set this (e.g. 8192m) only to override that.',
      type: 'string',
      default: '',
      max: 12,
      pattern: '^(?:\\d+[mgMG])?$',
      advanced: true,
    },
    {
      key: 'GC_CONFIG',
      label: 'Garbage collector',
      description: 'ZGC has the shortest pauses and is the right default on a modern JVM.',
      type: 'enum',
      default: 'ZGC',
      options: [
        { value: 'ZGC', label: 'ZGC' },
        { value: 'G1GC', label: 'G1GC' },
        { value: 'SerialGC', label: 'SerialGC' },
      ],
      advanced: true,
    },
    {
      key: 'GAME_VERSION',
      label: 'Steam branch',
      description: '`public` is the release branch; `unstable` is the beta.',
      type: 'string',
      default: 'public',
      max: 32,
      advanced: true,
    },
    { key: 'STEAM_VAC', label: 'Enable VAC', type: 'boolean', default: true, advanced: true },
    { key: 'TZ', label: 'Timezone', type: 'string', default: 'UTC', max: 64, advanced: true },

    // Fixed by the blueprint: these have to agree with `ports` above.
    { key: 'DEFAULT_PORT', label: 'Game port', type: 'number', default: 16261, hidden: true },
    { key: 'UDP_PORT', label: 'Steam port', type: 'number', default: 8766, hidden: true },
    { key: 'RCON_PORT', label: 'RCON port', type: 'number', default: 27015, hidden: true },
    { key: 'BIND_IP', label: 'Bind address', type: 'string', default: '0.0.0.0', hidden: true },
  ],
  signals: {
    ready: ['SERVER STARTED'],
    crash: [
      'java\\.lang\\.OutOfMemoryError',
      'Exception in thread "main"',
      'Segmentation fault',
      'Address already in use',
    ],
    // Zomboid's console output does not name players reliably across versions. The player list
    // comes from the RCON `players` command instead, which is exact.
    playerJoin: [],
    playerLeave: [],
  },
  stop: {
    // `quit` is Zomboid's own save-and-exit. Signalling the JVM instead leaves the world at the
    // last autosave, which by default is fifteen minutes of play ago.
    strategy: 'command',
    command: 'quit',
    signal: 'SIGTERM',
    timeoutSeconds: 120,
  },
  // The saves, config and logs live here; the game install itself is disposable and is
  // re-downloaded by SteamCMD.
  dataPath: '/home/steam/Zomboid',
  features: { console: true, rcon: true, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/Renegade-Master/zomboid-dedicated-server',
};
