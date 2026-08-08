import type { BlueprintDefinition } from './index.js';

/**
 * Rust, on `didstopia/rust-server`.
 *
 * The image is a SteamCMD wrapper: the game build comes from Steam at container start, so the
 * image itself changes rarely and the server is always current. That also means the pin below
 * fixes the tooling, not the game version.
 */
export const rustBlueprint: BlueprintDefinition = {
  key: 'rust',
  name: 'Rust',
  game: 'Rust',
  summary: 'Open-world survival PvP. Large procedural maps; the biggest resource ask here.',
  description: [
    'A Rust dedicated server. Rust is the most demanding thing in this catalogue: a 4000-size',
    'map with a busy population wants 16 GB of memory and a fast disk, and the game files alone',
    'are around 30 GB.',
    '',
    'Map size and seed together define the world. Changing either regenerates it and every',
    'building on it is gone, so decide before the first wipe rather than after. Administration',
    'is over RCON — Rust has no usable stdin console — and uMod/Oxide plugins can be enabled',
    'with a single toggle.',
  ].join(' '),
  category: 'survival',
  // Digest-pinned: the publisher ships only rolling tags (`latest`, `full`, `development`), so
  // a digest is the only way to stop an upstream push from changing every server at once.
  image:
    'didstopia/rust-server@sha256:c1832bfaf9e2f83954f372e1d1420e055f2547941bb4b3ebd38383824e64c95c',
  icon: { monogram: 'RU', hue: 18 },
  minMemoryMb: 8192,
  recommendedMemoryMb: 16384,
  minDiskMb: 30720,
  ports: [
    { name: 'game', label: 'Game', containerPort: 28015, protocol: 'udp', primary: true },
    { name: 'rcon', label: 'RCON', containerPort: 28016, protocol: 'tcp', bindLocal: true },
    { name: 'app', label: 'Rust+ companion app', containerPort: 28082, protocol: 'tcp' },
  ],
  variables: [
    {
      key: 'RUST_SERVER_NAME',
      label: 'Server name',
      type: 'string',
      default: 'Platter Rust Server',
      min: 1,
      max: 64,
    },
    {
      key: 'RUST_SERVER_DESCRIPTION',
      label: 'Server description',
      type: 'string',
      default: '',
      max: 1000,
    },
    {
      key: 'RUST_SERVER_MAXPLAYERS',
      label: 'Player slots',
      type: 'number',
      default: 50,
      min: 1,
      max: 500,
    },
    {
      key: 'RUST_SERVER_SEED',
      label: 'Map seed',
      description: 'Changing this generates a completely new map and wipes every base on it.',
      type: 'string',
      default: '12345',
      max: 12,
      pattern: '^\\d+$',
    },
    {
      key: 'RUST_SERVER_WORLDSIZE',
      label: 'Map size',
      description:
        'From 1000 to 6000. Memory and generation time rise sharply with it; 3500 is the usual compromise.',
      type: 'number',
      default: 3500,
      min: 1000,
      max: 6000,
    },
    {
      key: 'RUST_SERVER_IDENTITY',
      label: 'Save identity',
      description:
        'Names the save folder. Keep it stable — changing it abandons the current world without deleting it.',
      type: 'string',
      default: 'platter',
      max: 32,
      pattern: '^[a-z0-9_-]+$',
    },
    {
      key: 'RUST_RCON_PASSWORD',
      label: 'RCON password',
      description: 'Required for the console, scheduled commands and the player list.',
      type: 'password',
      default: null,
      required: true,
      min: 8,
      max: 64,
    },
    {
      key: 'RUST_OXIDE_ENABLED',
      label: 'Install uMod (Oxide)',
      description: 'The plugin framework nearly every modded Rust server runs.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'RUST_SERVER_URL',
      label: 'Server website',
      type: 'string',
      default: '',
      max: 255,
      advanced: true,
    },
    {
      key: 'RUST_SERVER_BANNER_URL',
      label: 'Server banner image URL',
      description: '512x256 PNG or JPG, shown in the Rust server browser.',
      type: 'string',
      default: '',
      max: 255,
      advanced: true,
    },
    {
      key: 'RUST_SERVER_SAVE_INTERVAL',
      label: 'Save interval (seconds)',
      description: 'How much progress a crash can cost. Lower means more disk writes.',
      type: 'number',
      default: 600,
      min: 60,
      max: 3600,
      advanced: true,
    },
    {
      key: 'RUST_RCON_WEB',
      label: 'Use WebSocket RCON',
      description: 'Leave on — it is what the Rust+ app and modern RCON tools speak.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'RUST_UPDATE_CHECKING',
      label: 'Check for updates while running',
      description: 'Restarts the server when Facepunch ships a build. Off keeps it up until you say.',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    {
      key: 'RUST_UPDATE_BRANCH',
      label: 'Steam branch',
      type: 'string',
      default: 'public',
      max: 32,
      advanced: true,
    },
    {
      key: 'RUST_SERVER_STARTUP_ARGUMENTS',
      label: 'Extra startup arguments',
      type: 'string',
      default: '-batchmode -load -nographics +server.secure 1',
      max: 400,
      advanced: true,
    },

    // Fixed by the blueprint: these have to agree with `ports` above.
    { key: 'RUST_SERVER_PORT', label: 'Game port', type: 'number', default: 28015, hidden: true },
    { key: 'RUST_RCON_PORT', label: 'RCON port', type: 'number', default: 28016, hidden: true },
    { key: 'RUST_APP_PORT', label: 'Rust+ port', type: 'number', default: 28082, hidden: true },
  ],
  signals: {
    ready: ['Server startup complete'],
    crash: [
      'SteamServer Initialize failed',
      'Segmentation fault',
      'Aborted \\(core dumped\\)',
      'Unhandled Exception',
      'Failed to bind',
    ],
    // `1.2.3.4:56789/76561198000000000/PlayerName joined [windows/76561198000000000]`.
    // Group 1 is the SteamID64, group 2 the display name.
    playerJoin: ['/(\\d{17})/(.+?) joined \\['],
    playerLeave: ['/(\\d{17})/(.+?) disconnecting'],
  },
  stop: {
    // Rust has no stdin console worth using; the process saves the world on SIGTERM. A large
    // map takes a while to write, and killing it early loses every base built since the last
    // autosave.
    strategy: 'signal',
    command: null,
    signal: 'SIGTERM',
    timeoutSeconds: 180,
  },
  dataPath: '/steamcmd/rust',
  // No world upload: a Rust map is generated from the seed and size above, not imported. `mods`
  // is off because the mod browser only knows the Minecraft registries; uMod is the toggle above.
  features: { console: false, rcon: true, mods: false, worldUpload: false, playerList: true },
  docsUrl: 'https://github.com/Didstopia/rust-server',
};
