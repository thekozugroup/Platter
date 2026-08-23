import type { BlueprintDefinition } from './index.js';

/**
 * Satisfactory, on `wolveix/satisfactory-server`.
 *
 * Unusual among dedicated servers: it has no console and no RCON. All administration happens
 * from inside the game client after claiming the server, so Platter's job here is limited to
 * running it, sizing it and backing it up.
 */
export const satisfactoryBlueprint: BlueprintDefinition = {
  key: 'satisfactory',
  name: 'Satisfactory',
  game: 'Satisfactory',
  summary: 'First-person factory building. Heavy: 8 GB minimum, more once the factory grows.',
  description: [
    'A Satisfactory dedicated server. Coffee Stain are direct about the requirements and so is',
    'this blueprint: 8 GB is the floor, 12–16 GB is what a mature save actually uses, and the',
    'server does not start well below that.',
    '',
    'There is no console and no RCON. After the first start, open the game, add the server by',
    'address, and claim it — that is where the name, password and session live. Platter still',
    'handles the world backups, which is the part that matters.',
  ].join(' '),
  category: 'simulation',
  image: 'wolveix/satisfactory-server:v1.9.10',
  icon: { monogram: 'SF', hue: 258, glyph: 'factory' },
  minMemoryMb: 8192,
  recommendedMemoryMb: 12288,
  minDiskMb: 25600,
  ports: [
    { name: 'game', label: 'Game', containerPort: 7777, protocol: 'udp', primary: true },
    { name: 'api', label: 'Server API', containerPort: 7777, protocol: 'tcp' },
    { name: 'messaging', label: 'Reliable messaging', containerPort: 8888, protocol: 'tcp' },
  ],
  variables: [
    {
      key: 'MAXPLAYERS',
      label: 'Player slots',
      type: 'number',
      default: 4,
      min: 1,
      max: 32,
    },
    {
      key: 'AUTOSAVENUM',
      label: 'Autosave slots',
      description: 'How many rotating autosaves to keep.',
      type: 'number',
      default: 5,
      min: 1,
      max: 50,
    },
    {
      key: 'MAXTICKRATE',
      label: 'Maximum tick rate',
      description: 'Lower this to trade simulation smoothness for CPU on a busy host.',
      type: 'number',
      default: 30,
      min: 5,
      max: 120,
      advanced: true,
    },
    {
      key: 'MAXOBJECTS',
      label: 'Maximum world objects',
      description:
        'Raise this only if a very large factory starts refusing to place buildings. It costs memory.',
      type: 'number',
      default: 2162688,
      min: 1000000,
      max: 20000000,
      advanced: true,
    },
    {
      key: 'DISABLESEASONALEVENTS',
      label: 'Disable seasonal events',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'SERVERSTREAMING',
      label: 'Enable world streaming',
      description: 'Loads distant parts of the world on demand. Off uses more memory.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'SKIPUPDATE',
      label: 'Skip the update check on start',
      description: 'Pins the server to the installed build so a patch cannot lock players out.',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'STEAMBETA',
      label: 'Use the experimental branch',
      description: 'Players must be on the experimental client too.',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'TIMEOUT',
      label: 'Shutdown timeout (seconds)',
      description: "How long the image's wrapper waits for the server to save and exit.",
      type: 'number',
      default: 30,
      min: 5,
      max: 300,
      advanced: true,
    },
    {
      key: 'VMOVERRIDE',
      label: 'Skip the CPU feature check',
      description:
        'Only for virtual machines that hide AVX from the guest. The server refuses to start without it there.',
      type: 'boolean',
      default: false,
      advanced: true,
    },

    // Fixed by the blueprint: these have to agree with `ports` above.
    { key: 'SERVERGAMEPORT', label: 'Game port', type: 'number', default: 7777, hidden: true },
    {
      key: 'SERVERMESSAGINGPORT',
      label: 'Messaging port',
      type: 'number',
      default: 8888,
      hidden: true,
    },
  ],
  signals: {
    // From the image's own captured server.log: the API listener is the last thing to come up.
    ready: ['Server API listening on', 'LogHttpListener: Created new HttpListener'],
    crash: ['LowLevelFatalError', 'Fatal error', 'Signal 11 caught', 'Assertion failed'],
    // Satisfactory logs nothing usable on join or leave, and it exposes no player-count API
    // Platter can reach. Better an empty list than a pattern that never fires.
    playerJoin: [],
    playerLeave: [],
  },
  stop: {
    // No console. The server saves on SIGTERM; the wrapper's own TIMEOUT is set well inside
    // this one so the wrapper, not Docker, decides when to give up.
    strategy: 'signal',
    command: null,
    signal: 'SIGTERM',
    timeoutSeconds: 120,
  },
  dataPath: '/config',
  features: { console: false, rcon: false, mods: false, worldUpload: true, playerList: false },
  docsUrl: 'https://github.com/wolveix/satisfactory-server',
};
