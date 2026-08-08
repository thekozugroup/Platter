import type { BlueprintDefinition } from './index.js';

/**
 * Terraria, on `ryshe/terraria`.
 *
 * The one game here that is configured by file rather than by environment: the vanilla
 * dedicated server reads `serverconfig.txt` and nothing else. The image lets us point it at a
 * path inside the data volume, so Platter renders that file from the variables below and the
 * whole configuration lives with the world.
 */

const WORLD_DIR = '/root/.local/share/Terraria/Worlds';

export const terrariaBlueprint: BlueprintDefinition = {
  key: 'terraria',
  name: 'Terraria',
  game: 'Terraria',
  summary: '2D sandbox adventure. Tiny footprint — happy on the smallest host.',
  description: [
    'A vanilla Terraria dedicated server. It is by far the lightest thing in this catalogue:',
    '1 GB runs a full eight-player world comfortably.',
    '',
    'World size, difficulty and seed only apply the first time, when the world is generated.',
    'After that they are ignored and the existing world is loaded, so changing them later does',
    'nothing until you remove the world file. Terraria speaks no RCON — the container console',
    'is the admin interface, and `exit` there is what saves and shuts the world down cleanly.',
  ].join(' '),
  category: 'sandbox',
  image: 'ryshe/terraria:vanilla-1.4.5.6',
  icon: { monogram: 'TR', hue: 96 },
  minMemoryMb: 512,
  recommendedMemoryMb: 1536,
  minDiskMb: 2048,
  // Terraria's protocol is TCP only; the UDP port some guides mention is for the Steam
  // friends list, which a dedicated server does not use.
  ports: [{ name: 'game', label: 'Game', containerPort: 7777, protocol: 'tcp', primary: true }],
  variables: [
    {
      key: 'WORLD_NAME',
      label: 'World name',
      description: 'Names the .wld save file. Changing it creates a second world rather than renaming one.',
      type: 'string',
      default: 'Platter',
      min: 1,
      max: 48,
      pattern: '^[A-Za-z0-9 _.-]+$',
    },
    {
      key: 'WORLD_SIZE',
      label: 'World size',
      description: 'Only used when the world is first generated.',
      type: 'enum',
      default: '2',
      options: [
        { value: '1', label: 'Small' },
        { value: '2', label: 'Medium' },
        { value: '3', label: 'Large' },
      ],
    },
    {
      key: 'DIFFICULTY',
      label: 'Difficulty',
      description: 'Only used when the world is first generated.',
      type: 'enum',
      default: '0',
      options: [
        { value: '0', label: 'Classic' },
        { value: '1', label: 'Expert' },
        { value: '2', label: 'Master' },
        { value: '3', label: 'Journey' },
      ],
    },
    {
      key: 'SEED',
      label: 'World seed',
      description: 'Leave empty for a random world. Only used when the world is first generated.',
      type: 'string',
      default: '',
      max: 64,
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      type: 'number',
      default: 8,
      min: 1,
      max: 255,
    },
    {
      key: 'PASSWORD',
      label: 'Server password',
      description: 'Leave empty for an open server.',
      type: 'password',
      default: '',
      max: 64,
    },
    {
      key: 'MOTD',
      label: 'Welcome message',
      type: 'string',
      default: 'Welcome to a Platter server',
      max: 200,
    },
    {
      key: 'NPC_STREAM',
      label: 'NPC stream rate',
      description: 'How often NPC positions are broadcast. Lower is smoother and uses more bandwidth.',
      type: 'number',
      default: 60,
      min: 1,
      max: 240,
      advanced: true,
    },

    // Not read by the image as environment — these render into serverconfig.txt below and
    // tell the image where to find the file and the worlds.
    { key: 'SERVER_PORT', label: 'Game port', type: 'number', default: 7777, hidden: true },
    { key: 'WORLDPATH', label: 'World directory', type: 'string', default: WORLD_DIR, hidden: true },
    {
      key: 'CONFIGPATH',
      label: 'Config directory',
      type: 'string',
      default: '/root/.local/share/Terraria/config',
      hidden: true,
    },
    {
      key: 'CONFIG_FILENAME',
      label: 'Config file name',
      type: 'string',
      default: 'serverconfig.txt',
      hidden: true,
    },
  ],
  files: [
    {
      path: 'config/serverconfig.txt',
      // Rewritten on every boot so the settings page is the source of truth. `autocreate`
      // and `seed` are inert once the world exists, so re-rendering cannot regenerate it.
      overwrite: true,
      format: 'properties',
      template: [
        '# Rendered by Platter. Edits here are replaced on the next start.',
        `world=${WORLD_DIR}/{{WORLD_NAME}}.wld`,
        `worldpath=${WORLD_DIR}`,
        'worldname={{WORLD_NAME}}',
        'autocreate={{WORLD_SIZE}}',
        'difficulty={{DIFFICULTY}}',
        'seed={{SEED}}',
        'maxplayers={{MAX_PLAYERS}}',
        'port={{SERVER_PORT}}',
        'password={{PASSWORD}}',
        'motd={{MOTD}}',
        'npcstream={{NPC_STREAM}}',
        'secure=1',
        'upnp=0',
        'priority=1',
        '',
      ].join('\n'),
    },
  ],
  signals: {
    ready: ['Server started'],
    crash: [
      'Unhandled Exception',
      'Unable to load the world',
      'Error on message',
      'Segmentation fault',
    ],
    // Terraria prints `Bob has joined.` / `Bob has left.` — group 1 is the character name.
    playerJoin: ['^(.+) has joined\\.'],
    playerLeave: ['^(.+) has left\\.'],
  },
  stop: {
    // `exit` is Terraria's own save-and-quit. A signal skips the save entirely, and a Terraria
    // world only writes on autosave or on exit.
    strategy: 'command',
    command: 'exit',
    signal: 'SIGTERM',
    timeoutSeconds: 60,
  },
  dataPath: '/root/.local/share/Terraria',
  features: { console: true, rcon: false, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/ryansheehan/terraria',
};
