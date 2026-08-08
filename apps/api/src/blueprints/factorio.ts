import type { BlueprintDefinition } from './index.js';

/**
 * Factorio, on `factoriotools/factorio`.
 *
 * Factorio splits its configuration in two: launch options come from the environment, but
 * everything a player sees — server name, visibility, autosave policy — lives in
 * `config/server-settings.json`. Platter renders that file, so the settings page and the file
 * editor are describing the same thing.
 */
export const factorioBlueprint: BlueprintDefinition = {
  key: 'factorio',
  name: 'Factorio',
  game: 'Factorio',
  summary: 'Factory-building automation. Deterministic, single-threaded, CPU-bound late game.',
  description: [
    'A Factorio headless server. Memory use is modest until the factory is large; CPU is what',
    'runs out first, and it is single-threaded, so clock speed matters more than core count.',
    '',
    'The version pin matters here more than anywhere else: Factorio clients refuse to join a',
    'server on a different build, so a surprise update locks every player out until they',
    'update too. This blueprint tracks the stable branch.',
    '',
    'Factorio has a real console. `/quit` saves and exits, which is what Platter sends on stop —',
    'a killed Factorio server loses everything since the last autosave.',
  ].join(' '),
  category: 'simulation',
  // 2.0.x is the stable channel; the image's `latest` tag follows the experimental branch,
  // which clients on the stable build cannot join.
  image: 'factoriotools/factorio:2.0.77',
  icon: { monogram: 'FA', hue: 28 },
  minMemoryMb: 1024,
  recommendedMemoryMb: 4096,
  minDiskMb: 4096,
  ports: [
    { name: 'game', label: 'Game', containerPort: 34197, protocol: 'udp', primary: true },
    { name: 'rcon', label: 'RCON', containerPort: 27015, protocol: 'tcp' },
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
      max: 500,
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      description: '0 means no limit.',
      type: 'number',
      default: 0,
      min: 0,
      max: 500,
    },
    {
      key: 'GAME_PASSWORD',
      label: 'Server password',
      description: 'Leave empty for an open server.',
      type: 'password',
      default: '',
      max: 64,
    },
    {
      key: 'PUBLIC_VISIBILITY',
      label: 'List in the public server browser',
      description: 'Needs a factorio.com username and token below. LAN discovery works either way.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'RCON_PASSWORD',
      label: 'RCON password',
      description:
        'At least eight characters. Required: the console, scheduled commands and the player list all go through RCON.',
      type: 'password',
      default: null,
      required: true,
      min: 8,
      max: 64,
    },
    {
      key: 'AUTO_PAUSE',
      label: 'Pause when empty',
      description: 'Stops the factory while nobody is connected. Almost always what you want.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'AUTOSAVE_INTERVAL',
      label: 'Autosave interval (minutes)',
      type: 'number',
      default: 10,
      min: 1,
      max: 240,
    },
    {
      key: 'AUTOSAVE_SLOTS',
      label: 'Autosave slots',
      description: 'How many rotating autosaves to keep on disk.',
      type: 'number',
      default: 5,
      min: 1,
      max: 50,
      advanced: true,
    },
    {
      key: 'REQUIRE_USER_VERIFICATION',
      label: 'Verify factorio.com accounts',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'USERNAME',
      label: 'factorio.com username',
      description: 'Only needed to list the server publicly.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'TOKEN',
      label: 'factorio.com token',
      description: 'From factorio.com/profile. Only needed to list the server publicly.',
      type: 'password',
      default: '',
      max: 128,
      advanced: true,
    },
    {
      key: 'SAVE_NAME',
      label: 'Save name',
      description: 'Which save under saves/ to load, when not loading the most recent one.',
      type: 'string',
      default: '_autosave1',
      max: 64,
      advanced: true,
    },
    {
      key: 'LOAD_LATEST_SAVE',
      label: 'Load the most recent save',
      description: 'Off loads the named save above instead.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'GENERATE_NEW_SAVE',
      label: 'Generate a save if none exists',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'PRESET',
      label: 'Map preset',
      description: 'Only used when generating a new save. Empty uses the default settings.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'DLC_SPACE_AGE',
      label: 'Enable the Space Age DLC',
      description: 'Loads the Space Age mods. Every player needs the DLC to join.',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'UPDATE_MODS_ON_START',
      label: 'Update mods on every start',
      description: 'Off keeps mods pinned, which is what you want once players are on a version.',
      type: 'boolean',
      default: false,
      advanced: true,
    },

    // Fixed by the blueprint: these have to agree with `ports` above.
    { key: 'PORT', label: 'Game port', type: 'number', default: 34197, hidden: true },
    { key: 'RCON_PORT', label: 'RCON port', type: 'number', default: 27015, hidden: true },
  ],
  files: [
    {
      path: 'config/server-settings.json',
      overwrite: true,
      format: 'json',
      template: [
        '{',
        '  "name": "{{SERVER_NAME}}",',
        '  "description": "{{SERVER_DESCRIPTION}}",',
        '  "tags": [],',
        '  "max_players": {{MAX_PLAYERS}},',
        '  "visibility": { "public": {{PUBLIC_VISIBILITY}}, "lan": true },',
        '  "username": "{{USERNAME}}",',
        '  "token": "{{TOKEN}}",',
        '  "game_password": "{{GAME_PASSWORD}}",',
        '  "require_user_verification": {{REQUIRE_USER_VERIFICATION}},',
        '  "max_upload_in_kilobytes_per_second": 0,',
        '  "max_upload_slots": 5,',
        '  "minimum_latency_in_ticks": 0,',
        '  "ignore_player_limit_for_returning_players": false,',
        '  "allow_commands": "admins-only",',
        '  "autosave_interval": {{AUTOSAVE_INTERVAL}},',
        '  "autosave_slots": {{AUTOSAVE_SLOTS}},',
        '  "afk_autokick_interval": 0,',
        '  "auto_pause": {{AUTO_PAUSE}},',
        '  "only_admins_can_pause_the_game": true,',
        '  "autosave_only_on_server": true,',
        '  "non_blocking_saving": true',
        '}',
        '',
      ].join('\n'),
    },
    {
      // The image invents a random password into this file when it is missing, and then only
      // the container knows it. Rendering it means Platter's RCON client and the server agree
      // without anyone having to read a file out of the volume to find out what the secret is.
      path: 'config/rconpw',
      overwrite: true,
      format: 'text',
      template: '{{RCON_PASSWORD}}\n',
    },
  ],
  signals: {
    // `changing state from(CreatingGame) to(InGame)` is the line that means the map is loaded
    // and the socket is open.
    ready: ['changing state from\\(CreatingGame\\) to\\(InGame\\)', 'Hosting game at IP ADDR'],
    crash: [
      'Error [A-Za-z]+\\.cpp:\\d+:',
      'Factorio crashed',
      'Is another instance already running',
      'Segmentation fault',
    ],
    // `2026-01-01 12:00:00 [JOIN] Alice joined the game` — group 1 is the player name.
    playerJoin: ['\\[JOIN\\] (.+?) joined the game'],
    playerLeave: ['\\[LEAVE\\] (.+?) left the game'],
  },
  stop: {
    // Factorio's console command, not a signal: `/quit` writes the save first. Factorio only
    // persists on autosave and on quit, so a signal-only stop discards everything built since
    // the last autosave.
    strategy: 'command',
    command: '/quit',
    signal: 'SIGTERM',
    timeoutSeconds: 90,
  },
  dataPath: '/factorio',
  // `mods` is off: the flag drives Platter's mod browser, which resolves against the Minecraft
  // registries. Factorio mods go in `mods/` via the file editor and the toggle above.
  features: { console: true, rcon: true, mods: false, worldUpload: true, playerList: true },
  docsUrl: 'https://github.com/factoriotools/factorio-docker',
};
