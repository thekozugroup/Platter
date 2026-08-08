/**
 * Core domain vocabulary for Platter.
 *
 * Everything in this file is transport-agnostic: the API, the web client and the
 * orchestration drivers all agree on these names, so a status string never has to be
 * translated at a boundary.
 */

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * The lifecycle of a game server, from "the user pressed create" to "the volume is gone".
 *
 * `installing` covers the blueprint's install script (downloading the game files);
 * `crashed` is distinct from `offline` because it is an *unexpected* exit and drives
 * auto-restart plus AI crash triage.
 */
export const SERVER_STATUSES = [
  'provisioning',
  'installing',
  'install_failed',
  'offline',
  'starting',
  'running',
  'stopping',
  'restarting',
  'crashed',
  'suspended',
  'deleting',
] as const;

export type ServerStatus = (typeof SERVER_STATUSES)[number];

/** Statuses in which the container is expected to exist and be doing something. */
export const ACTIVE_SERVER_STATUSES: readonly ServerStatus[] = [
  'installing',
  'starting',
  'running',
  'stopping',
  'restarting',
];

/** Statuses that are transient — the UI shows a spinner and polls/streams for change. */
export const TRANSITIONAL_SERVER_STATUSES: readonly ServerStatus[] = [
  'provisioning',
  'installing',
  'starting',
  'stopping',
  'restarting',
  'deleting',
];

/** A server in one of these states cannot accept power actions or console input. */
export const LOCKED_SERVER_STATUSES: readonly ServerStatus[] = [
  'provisioning',
  'installing',
  'deleting',
  'suspended',
];

export function isTransitional(status: ServerStatus): boolean {
  return TRANSITIONAL_SERVER_STATUSES.includes(status);
}

export function isLocked(status: ServerStatus): boolean {
  return LOCKED_SERVER_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Power actions
// ---------------------------------------------------------------------------

export const POWER_ACTIONS = ['start', 'stop', 'restart', 'kill'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

/**
 * Which power actions are legal from a given status.
 *
 * The API enforces this table so the UI and the scheduler can never drive the
 * orchestrator into an impossible transition (e.g. starting a server mid-install).
 */
export const ALLOWED_POWER_ACTIONS: Record<ServerStatus, readonly PowerAction[]> = {
  // A server created with `startOnCreate: false` sits here with no container and no data
  // directory. `start` is what installs it and boots it — without that this status is a
  // dead end reachable straight from the create endpoint, with only `delete` out of it.
  provisioning: ['start'],
  installing: ['kill'],
  install_failed: [],
  offline: ['start'],
  starting: ['stop', 'kill'],
  running: ['stop', 'restart', 'kill'],
  stopping: ['kill'],
  restarting: ['kill'],
  crashed: ['start'],
  suspended: [],
  deleting: [],
};

export function canPerformPowerAction(status: ServerStatus, action: PowerAction): boolean {
  return ALLOWED_POWER_ACTIONS[status].includes(action);
}

/** The status a server enters the moment a power action is accepted. */
export const POWER_ACTION_TARGET_STATUS: Record<PowerAction, ServerStatus> = {
  start: 'starting',
  stop: 'stopping',
  restart: 'restarting',
  kill: 'stopping',
};

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

/**
 * Global roles. Per-server access is granted separately via server subusers, so a
 * `member` sees only the servers they own or have been invited to.
 */
export const USER_ROLES = ['owner', 'admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_RANK: Record<UserRole, number> = { owner: 3, admin: 2, member: 1 };

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Fine-grained per-server permissions handed to subusers. Owners and admins
 * implicitly hold all of them.
 */
export const SERVER_PERMISSIONS = [
  'server.view',
  'server.update',
  'server.delete',
  'power.start',
  'power.stop',
  'power.restart',
  'console.read',
  'console.write',
  'files.read',
  'files.write',
  'files.delete',
  'backups.read',
  'backups.create',
  'backups.restore',
  'backups.delete',
  'schedules.read',
  'schedules.write',
  'settings.read',
  'settings.write',
  'ai.use',
] as const;

export type ServerPermission = (typeof SERVER_PERMISSIONS)[number];

/**
 * Scopes that have no per-server analogue. Everything else in the API-key vocabulary is a
 * `ServerPermission`, reused verbatim: a key must not be grantable something a subuser
 * could not be granted, and one list is easier to reason about than two that drift.
 */
export const GLOBAL_SCOPES = ['server.create', 'audit.read'] as const;
export type GlobalScope = (typeof GLOBAL_SCOPES)[number];

/**
 * What an API key can be restricted to. Enforced identically on MCP and on REST — a key
 * that cannot stop a server over one surface must not be able to stop it over the other.
 */
export const API_KEY_SCOPES = [...SERVER_PERMISSIONS, ...GLOBAL_SCOPES] as const;
export type ApiKeyScope = ServerPermission | GlobalScope;

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** Sensible default grant for an invited collaborator: run it, don't destroy it. */
export const DEFAULT_SUBUSER_PERMISSIONS: readonly ServerPermission[] = [
  'server.view',
  'power.start',
  'power.stop',
  'power.restart',
  'console.read',
  'console.write',
  'files.read',
  'backups.read',
  'schedules.read',
  'settings.read',
];

// ---------------------------------------------------------------------------
// Backups & schedules
// ---------------------------------------------------------------------------

export const BACKUP_STATUSES = ['pending', 'running', 'completed', 'failed', 'restoring'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const SCHEDULE_ACTIONS = ['start', 'stop', 'restart', 'backup', 'command'] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Nodes & drivers
// ---------------------------------------------------------------------------

export const NODE_DRIVERS = ['docker', 'mock'] as const;
export type NodeDriver = (typeof NODE_DRIVERS)[number];

export const NODE_STATUSES = ['online', 'offline', 'degraded', 'unknown'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Blueprints ("platters")
// ---------------------------------------------------------------------------

export const BLUEPRINT_CATEGORIES = [
  'survival',
  'sandbox',
  'shooter',
  'simulation',
  'strategy',
  'roleplay',
  'other',
] as const;
export type BlueprintCategory = (typeof BLUEPRINT_CATEGORIES)[number];

export const VARIABLE_TYPES = ['string', 'number', 'boolean', 'enum', 'password'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const STOP_STRATEGIES = ['command', 'signal'] as const;
export type StopStrategy = (typeof STOP_STRATEGIES)[number];

// ---------------------------------------------------------------------------
// Limits — enforced by the API, surfaced by the UI so the two never disagree
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Minimum memory we will let anyone allocate to a container. */
  minMemoryMb: 256,
  maxMemoryMb: 1_048_576,
  minDiskMb: 512,
  maxDiskMb: 10_485_760,
  /** CPU is expressed in whole cores as a float; 0 means "unlimited". */
  minCpuCores: 0,
  maxCpuCores: 256,
  minPort: 1024,
  maxPort: 65535,
  serverNameMin: 1,
  serverNameMax: 60,
  maxConsoleLineLength: 2000,
  /** Ring buffer of log lines kept in memory per server for instant console backfill. */
  consoleScrollback: 500,
  maxFileEditBytes: 5 * 1024 * 1024,
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  passwordMin: 12,
  passwordMax: 256,
} as const;

/** Default grace period before a stop escalates to SIGKILL. */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 30;
