import type { BlueprintDefinition } from './index.js';

/**
 * Enshrouded, on `mornedhels/enshrouded-server`.
 *
 * A Windows game server run under Wine, which is why the memory floor is high and the disk
 * requirement is 30 GB. The image adds scheduled updates and restarts around it.
 */
export const enshroudedBlueprint: BlueprintDefinition = {
  key: 'enshrouded',
  name: 'Enshrouded',
  game: 'Enshrouded',
  summary: 'Survival action RPG for up to sixteen. Keen Games ask for 16 GB, and they mean it.',
  description: [
    'An Enshrouded dedicated server. This is the most memory-hungry blueprint here after Rust:',
    'Keen Games specify 16 GB for a sixteen-player server, and the server runs under Wine, which',
    'adds to that rather than subtracting from it. 12 GB is the lowest that behaves.',
    '',
    'Enshrouded uses one UDP port for everything — there is no separate game port any more.',
    'Player access is controlled by the role passwords inside `enshrouded_server.json`; open it',
    'in the file editor after the first start, because the image no longer sets them from the',
    'environment.',
  ].join(' '),
  category: 'survival',
  image: 'mornedhels/enshrouded-server:1.7.2',
  icon: { monogram: 'EN', hue: 282 },
  minMemoryMb: 12288,
  recommendedMemoryMb: 16384,
  minDiskMb: 30720,
  // One port, not two. Enshrouded folded the game port into the query port; publishing a
  // second one would advertise an address that nothing listens on.
  ports: [{ name: 'game', label: 'Game', containerPort: 15637, protocol: 'udp', primary: true }],
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
      key: 'SERVER_SLOT_COUNT',
      label: 'Player slots',
      description: 'Sixteen is the maximum Enshrouded supports.',
      type: 'number',
      default: 16,
      min: 1,
      max: 16,
    },
    {
      key: 'SERVER_ENABLE_VOICE_CHAT',
      label: 'Enable voice chat',
      type: 'boolean',
      default: false,
    },
    {
      key: 'SERVER_VOICE_CHAT_MODE',
      label: 'Voice chat mode',
      type: 'enum',
      default: 'Proximity',
      options: [
        { value: 'Proximity', label: 'Proximity — only nearby players' },
        { value: 'Global', label: 'Global — everyone hears everyone' },
      ],
    },
    { key: 'SERVER_ENABLE_TEXT_CHAT', label: 'Enable text chat', type: 'boolean', default: true },
    {
      key: 'UPDATE_CRON',
      label: 'Update check schedule',
      description: 'Cron expression. Empty pins the server to the build already installed.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'UPDATE_CHECK_PLAYERS',
      label: 'Skip updates while players are online',
      type: 'boolean',
      default: true,
      advanced: true,
    },
    {
      key: 'RESTART_CRON',
      label: 'Restart schedule',
      description: 'Cron expression for a scheduled restart. Empty disables it.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'BACKUP_CRON',
      label: "The image's own backup schedule",
      description:
        'Leave empty — Platter already schedules backups of the same save directory, and running both doubles the disk use.',
      type: 'string',
      default: '',
      max: 64,
      advanced: true,
    },
    {
      key: 'GAME_BRANCH',
      label: 'Steam branch',
      description: '`public` is the release branch. Only change this to join a public test.',
      type: 'string',
      default: 'public',
      max: 32,
      advanced: true,
    },

    // Fixed by the blueprint: has to agree with `ports` above, and keeps the save inside the
    // data volume so backups and the file editor see it.
    { key: 'SERVER_QUERYPORT', label: 'Game port', type: 'number', default: 15637, hidden: true },
    { key: 'SERVER_IP', label: 'Bind address', type: 'string', default: '0.0.0.0', hidden: true },
    { key: 'SERVER_SAVE_DIR', label: 'Save directory', type: 'string', default: './savegame', hidden: true },
  ],
  signals: {
    // The server prints `[Session] 'HostOnline' (up)!` once it is reachable.
    ready: ["\\[Session\\] 'HostOnline' \\(up\\)!"],
    crash: [
      'Fatal error',
      'Segmentation fault',
      'Failed to create session',
      'Unable to bind',
      'wine: Unhandled',
    ],
    // Enshrouded's log does not name players on join or leave, and it exposes no query
    // protocol Platter can ask instead.
    playerJoin: [],
    playerLeave: [],
  },
  stop: {
    // No console. The server flushes the savegame on SIGTERM; the image documents a ninety
    // second grace period, and cutting it short loses the session.
    strategy: 'signal',
    command: null,
    signal: 'SIGTERM',
    timeoutSeconds: 90,
  },
  dataPath: '/opt/enshrouded',
  features: { console: false, rcon: false, mods: false, worldUpload: true, playerList: false },
  docsUrl: 'https://github.com/mornedhels/enshrouded-server',
};
