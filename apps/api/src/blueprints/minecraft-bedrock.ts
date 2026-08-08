import type { BlueprintDefinition } from './index.js';

/**
 * Minecraft: Bedrock Edition, on `itzg/minecraft-bedrock-server`.
 *
 * A different product from Java Edition, not a variant of it: different protocol, different
 * world format, different port, and no RCON at all. It shares only the brand, which is why
 * it is a separate blueprint rather than a `TYPE` on the Java one.
 */
export const minecraftBedrockBlueprint: BlueprintDefinition = {
  key: 'minecraft-bedrock',
  name: 'Minecraft: Bedrock Edition',
  game: 'Minecraft',
  summary: 'The console, mobile and Windows edition. Cross-play with phones and consoles.',
  description: [
    'Minecraft: Bedrock Edition — the version that ships on consoles, phones, tablets and the',
    'Microsoft Store. Players on all of those can join the same world.',
    '',
    'Bedrock servers are much lighter than Java ones: 1 GB is comfortable for a family world.',
    'There are no plugins and no mods, and the server speaks no RCON, so Platter drives it',
    'through the container console instead. Console and phone clients cannot type a port, so',
    'the mDNS name Platter advertises is usually the easiest way in on a home network.',
  ].join(' '),
  category: 'sandbox',
  image: 'itzg/minecraft-bedrock-server:2026.8.0',
  icon: { monogram: 'BE', hue: 38 },
  minMemoryMb: 512,
  recommendedMemoryMb: 1536,
  minDiskMb: 2048,
  // Only the IPv4 port. The server's `server-portv6` listener is bound to an IPv6 socket, so
  // mapping an IPv4 host port onto it would publish an endpoint nothing can reach.
  ports: [{ name: 'game', label: 'Game', containerPort: 19132, protocol: 'udp', primary: true }],
  variables: [
    {
      key: 'EULA',
      label: 'I accept the Minecraft EULA',
      description:
        'Mojang requires every server operator to accept the Minecraft End User Licence Agreement at https://aka.ms/MinecraftEULA. The server will not start until you do.',
      type: 'boolean',
      default: null,
      required: true,
    },
    {
      key: 'VERSION',
      label: 'Server version',
      description:
        'LATEST tracks the current release. PREVIEW runs the beta build, which only preview clients can join.',
      type: 'string',
      default: 'LATEST',
      max: 32,
      pattern: '^(?:LATEST|PREVIEW|EXISTING|\\d+(?:\\.\\d+){2,3})$',
    },
    {
      key: 'SERVER_NAME',
      label: 'Server name',
      description: 'Shown in the friends and servers lists on every client.',
      type: 'string',
      default: 'Platter',
      max: 96,
    },
    {
      key: 'GAMEMODE',
      label: 'Game mode',
      type: 'enum',
      default: 'survival',
      options: [
        { value: 'survival', label: 'Survival' },
        { value: 'creative', label: 'Creative' },
        { value: 'adventure', label: 'Adventure' },
      ],
    },
    {
      key: 'DIFFICULTY',
      label: 'Difficulty',
      type: 'enum',
      default: 'easy',
      options: [
        { value: 'peaceful', label: 'Peaceful — no hostile mobs' },
        { value: 'easy', label: 'Easy' },
        { value: 'normal', label: 'Normal' },
        { value: 'hard', label: 'Hard' },
      ],
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      type: 'number',
      default: 10,
      min: 1,
      max: 100,
    },
    {
      key: 'LEVEL_NAME',
      label: 'World name',
      description: 'The folder the world is saved into. Changing it starts a new world.',
      type: 'string',
      default: 'Bedrock level',
      max: 64,
      pattern: '^[A-Za-z0-9 _.-]+$',
    },
    {
      key: 'LEVEL_SEED',
      label: 'World seed',
      description: 'Leave empty for a random world. Only used the first time the world generates.',
      type: 'string',
      default: '',
      max: 128,
    },
    {
      key: 'LEVEL_TYPE',
      label: 'World type',
      type: 'enum',
      default: 'DEFAULT',
      options: [
        { value: 'DEFAULT', label: 'Infinite' },
        { value: 'FLAT', label: 'Superflat' },
        { value: 'LEGACY', label: 'Legacy (finite world)' },
      ],
    },
    {
      key: 'ALLOW_CHEATS',
      label: 'Allow cheats',
      description: 'Required for /gamemode, /give and the rest of the operator commands in game.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'ONLINE_MODE',
      label: 'Verify Xbox Live accounts',
      description: 'Turn this off only on a private network where no client can sign in.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'ALLOW_LIST',
      label: 'Allow list only',
      description: 'When on, only the gamertags listed below can connect.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'ALLOW_LIST_USERS',
      label: 'Allowed players',
      description: 'Comma-separated gamertags. Only has an effect when the allow list is on.',
      type: 'string',
      default: '',
      max: 4000,
    },
    {
      key: 'OPS',
      label: 'Operators',
      description:
        'Comma-separated gamertags or XUIDs given operator permission. Cheats must be on for their commands to work.',
      type: 'string',
      default: '',
      max: 1000,
    },
    {
      key: 'VIEW_DISTANCE',
      label: 'View distance',
      description: 'Chunks sent to each player. The biggest lever on CPU and bandwidth.',
      type: 'number',
      default: 10,
      min: 4,
      max: 32,
    },
    {
      key: 'TICK_DISTANCE',
      label: 'Tick distance',
      description: 'Chunks that keep simulating around each player.',
      type: 'number',
      default: 4,
      min: 4,
      max: 12,
      advanced: true,
    },
    {
      key: 'PLAYER_IDLE_TIMEOUT',
      label: 'Idle kick (minutes)',
      description: '0 never kicks idle players.',
      type: 'number',
      default: 30,
      min: 0,
      max: 1440,
      advanced: true,
    },
    {
      key: 'DEFAULT_PLAYER_PERMISSION_LEVEL',
      label: 'Default permission level',
      type: 'enum',
      default: 'member',
      options: [
        { value: 'visitor', label: 'Visitor — cannot build' },
        { value: 'member', label: 'Member' },
        { value: 'operator', label: 'Operator' },
      ],
      advanced: true,
    },
    {
      key: 'TEXTUREPACK_REQUIRED',
      label: 'Require resource packs',
      type: 'boolean',
      default: false,
      advanced: true,
    },
    { key: 'TZ', label: 'Timezone', type: 'string', default: 'UTC', max: 64, advanced: true },

    // Fixed by the blueprint: has to agree with `ports` above.
    { key: 'SERVER_PORT', label: 'Server port', type: 'number', default: 19132, hidden: true },
  ],
  signals: {
    // The Bedrock server prints `[INFO] Server started.` once it is accepting connections.
    ready: ['Server started\\.'],
    crash: [
      'must be set to TRUE',
      'Failed to bind to port',
      'Unable to start server',
      'Segmentation fault',
    ],
    // BDS logs `Player connected: Steve, xuid: 2535000000000000`. Group 1 is the gamertag.
    playerJoin: ['Player connected: (.+?), xuid:'],
    playerLeave: ['Player disconnected: (.+?), xuid:'],
  },
  stop: {
    // BDS has a console and `stop` is its clean shutdown: it flushes the level DB. Killing it
    // mid-write corrupts the LevelDB world, which is not repairable.
    strategy: 'command',
    command: 'stop',
    signal: 'SIGTERM',
    timeoutSeconds: 60,
  },
  // Bedrock's own pair. `save query` reports which files are ready; Platter does not read
  // that back, so the hold is best-effort — still far better than copying a live world.
  saveCommands: { flush: ['save hold', 'save query'], resume: ['save resume'] },
  dataPath: '/data',
  // No RCON in Bedrock — Mojang never implemented it. The console is the only control channel,
  // and the player list is derived from the connect/disconnect lines above.
  features: { console: true, rcon: false, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/itzg/docker-minecraft-bedrock-server',
};
