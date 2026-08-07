import { relations, sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Platter's SQLite schema.
 *
 * Conventions used throughout:
 *   - Primary keys are ULIDs (text). Sortable by creation time, so `ORDER BY id` is a free
 *     chronological sort and pagination needs no extra column.
 *   - Timestamps are stored as INTEGER epoch milliseconds, not SQLite's DATETIME. Comparison,
 *     arithmetic and JS interop are all unambiguous that way.
 *   - Booleans are INTEGER 0/1 via drizzle's boolean mode.
 *   - Structured blobs (settings, provider payloads, diagnosis findings) are JSON text columns.
 *     They are always validated with a Zod schema at the repository boundary — the database
 *     enforces shape for the things we query on, Zod enforces shape for the rest.
 *
 * The database is the source of truth for *intent*. Docker is the source of truth for *reality*.
 * Where they disagree, the reconciler in `packages/core` believes Docker and updates the row.
 */

const now = sql`(unixepoch() * 1000)`;

/* -------------------------------------------------------------------------- */
/* Servers                                                                     */
/* -------------------------------------------------------------------------- */

export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    /** Display name. Freely editable. */
    name: text('name').notNull(),
    /** URL/container/dir-safe derivative of the name. Stable once created. */
    slug: text('slug').notNull(),
    game: text('game').notNull().default('minecraft'),

    /** e.g. 'paper', 'fabric', 'vanilla'. See MINECRAFT_LOADERS in @platter/shared. */
    loader: text('loader').notNull(),
    /** Minecraft version, e.g. '1.21.4'. 'LATEST' is resolved at create time and stored here. */
    gameVersion: text('game_version').notNull(),
    /** Loader build, when pinned (e.g. a specific Fabric loader or Forge build). */
    loaderVersion: text('loader_version'),

    /** Docker image reference actually used, including tag. Recorded for reproducibility. */
    image: text('image').notNull(),
    /** Current container id, if one exists. Null between create and first start. */
    containerId: text('container_id'),

    status: text('status').notNull().default('creating'),
    /** Human-readable detail for `error`/`crashed` — surfaced in the UI verbatim. */
    statusMessage: text('status_message'),
    /** Exit code from the last container exit, when it exited. */
    lastExitCode: integer('last_exit_code'),

    /** Host port players connect to. */
    port: integer('port').notNull(),
    /** Host port RCON is published on, or null when RCON is not exposed to the host. */
    rconPort: integer('rcon_port'),
    /** Generated per server. Never rendered in the UI, never included in exports. */
    rconPassword: text('rcon_password').notNull(),

    memoryMiB: integer('memory_mib').notNull().default(4096),
    cpus: integer('cpus').notNull().default(2000), // millicores; 2000 = 2 CPUs
    pidsLimit: integer('pids_limit').notNull().default(512),
    restartPolicy: text('restart_policy').notNull().default('unless-stopped'),

    /** ServerSettings JSON. Validated with serverSettingsSchema on read. */
    settings: text('settings', { mode: 'json' }).notNull().default('{}'),

    /** Absolute host path bind-mounted to /data. Denormalised so teardown never guesses. */
    dataDir: text('data_dir').notNull(),

    /** Set when the server was created from a modpack, so updates can follow the pack. */
    modpackProvider: text('modpack_provider'),
    modpackProjectId: text('modpack_project_id'),
    modpackVersionId: text('modpack_version_id'),

    autoBackup: integer('auto_backup', { mode: 'boolean' }).notNull().default(true),
    /** Cron expression for scheduled backups. Null disables the schedule. */
    backupCron: text('backup_cron').default('0 4 * * *'),
    backupRetention: integer('backup_retention').notNull().default(7),

    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    startedAt: integer('started_at'),
    stoppedAt: integer('stopped_at'),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    uniqueIndex('servers_slug_unique').on(table.slug),
    uniqueIndex('servers_port_unique').on(table.port),
    index('servers_status_idx').on(table.status),
    index('servers_deleted_idx').on(table.deletedAt),
  ]
);

/* -------------------------------------------------------------------------- */
/* Port allocations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Explicit port ledger.
 *
 * The alternative — scanning `docker ps` for used ports at allocation time — races badly when
 * two servers are created in quick succession, and it cannot see ports held by non-Docker
 * processes. A unique index on `port` makes double-allocation a constraint violation instead of
 * a support ticket, and the row survives a container that failed to create.
 */
export const portAllocations = sqliteTable(
  'port_allocations',
  {
    port: integer('port').primaryKey(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    /** 'game' | 'rcon' | 'query' | 'custom' */
    purpose: text('purpose').notNull(),
    protocol: text('protocol').notNull().default('tcp'),
    allocatedAt: integer('allocated_at').notNull().default(now),
  },
  (table) => [index('port_allocations_server_idx').on(table.serverId)]
);

/* -------------------------------------------------------------------------- */
/* Mod catalogue (cache of upstream project metadata)                          */
/* -------------------------------------------------------------------------- */

/**
 * A cached view of an upstream project (Modrinth or CurseForge).
 *
 * Cached for three reasons: rate limits are real, the compatibility engine reads the same
 * project repeatedly while resolving a dependency graph, and a server should still show what is
 * installed when the network is down.
 */
export const modProjects = sqliteTable(
  'mod_projects',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(), // modrinth | curseforge | manual
    /** Upstream id. Modrinth project id, or the CurseForge numeric mod id as a string. */
    projectId: text('project_id').notNull(),
    slug: text('slug'),
    title: text('title').notNull(),
    summary: text('summary'),
    description: text('description'),
    author: text('author'),
    iconUrl: text('icon_url'),
    projectUrl: text('project_url'),
    license: text('license'),
    downloads: integer('downloads'),
    followers: integer('followers'),
    kind: text('kind').notNull().default('mod'),
    /** required | optional | unsupported | unknown */
    clientSide: text('client_side').notNull().default('unknown'),
    serverSide: text('server_side').notNull().default('unknown'),
    categories: text('categories', { mode: 'json' }).notNull().default('[]'),
    loaders: text('loaders', { mode: 'json' }).notNull().default('[]'),
    gameVersions: text('game_versions', { mode: 'json' }).notNull().default('[]'),
    /** Raw upstream payload, kept so a schema change upstream does not lose information. */
    raw: text('raw', { mode: 'json' }),
    fetchedAt: integer('fetched_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('mod_projects_provider_project_unique').on(table.provider, table.projectId),
    index('mod_projects_slug_idx').on(table.provider, table.slug),
    index('mod_projects_fetched_idx').on(table.fetchedAt),
  ]
);

export const modVersions = sqliteTable(
  'mod_versions',
  {
    id: text('id').primaryKey(),
    modProjectId: text('mod_project_id')
      .notNull()
      .references(() => modProjects.id, { onDelete: 'cascade' }),
    /** Upstream version id (Modrinth version id / CurseForge file id). */
    versionId: text('version_id').notNull(),
    versionNumber: text('version_number'),
    name: text('name'),
    /** release | beta | alpha */
    channel: text('channel').notNull().default('release'),
    gameVersions: text('game_versions', { mode: 'json' }).notNull().default('[]'),
    loaders: text('loaders', { mode: 'json' }).notNull().default('[]'),
    /** [{ projectId, versionId, kind }] — see dependencyKindSchema. */
    dependencies: text('dependencies', { mode: 'json' }).notNull().default('[]'),
    fileName: text('file_name'),
    fileUrl: text('file_url'),
    fileSize: integer('file_size'),
    sha1: text('sha1'),
    sha512: text('sha512'),
    /**
     * CurseForge authors can forbid third-party downloads, in which case the API returns a null
     * downloadUrl. Recording it lets the UI explain *why* a mod cannot be auto-installed rather
     * than failing with a confusing network error.
     */
    downloadable: integer('downloadable', { mode: 'boolean' }).notNull().default(true),
    publishedAt: integer('published_at'),
    raw: text('raw', { mode: 'json' }),
    fetchedAt: integer('fetched_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('mod_versions_project_version_unique').on(table.modProjectId, table.versionId),
    index('mod_versions_game_idx').on(table.modProjectId, table.channel),
  ]
);

/* -------------------------------------------------------------------------- */
/* Installed mods                                                              */
/* -------------------------------------------------------------------------- */

export const modInstalls = sqliteTable(
  'mod_installs',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    modProjectId: text('mod_project_id').references(() => modProjects.id, { onDelete: 'set null' }),
    modVersionId: text('mod_version_id').references(() => modVersions.id, { onDelete: 'set null' }),

    /** Denormalised so an install row still reads correctly if the cache is pruned. */
    provider: text('provider').notNull(),
    projectSlug: text('project_slug'),
    displayName: text('display_name').notNull(),
    versionLabel: text('version_label'),
    kind: text('kind').notNull().default('mod'),

    /** Path relative to /data, e.g. 'mods/sodium-0.6.0.jar'. */
    filePath: text('file_path'),
    fileSize: integer('file_size'),
    sha1: text('sha1'),

    status: text('status').notNull().default('pending'),
    statusMessage: text('status_message'),

    /**
     * True when Platter added this to satisfy another mod's requirement. Removing the parent
     * offers to remove these too; removing them directly warns that the parent will break.
     */
    isDependency: integer('is_dependency', { mode: 'boolean' }).notNull().default(false),
    /** The mod_install id that pulled this one in. */
    requiredBy: text('required_by'),

    /** user | ai | system | schedule */
    installedBy: text('installed_by').notNull().default('user'),
    /** Set when an AI proposal produced this install, for the audit trail. */
    proposalId: text('proposal_id'),

    /** Compatibility verdict at install time, kept so we can explain later breakage. */
    compatSnapshot: text('compat_snapshot', { mode: 'json' }),

    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    removedAt: integer('removed_at'),
  },
  (table) => [
    index('mod_installs_server_idx').on(table.serverId, table.status),
    uniqueIndex('mod_installs_server_project_unique').on(
      table.serverId,
      table.provider,
      table.projectSlug
    ),
  ]
);

/* -------------------------------------------------------------------------- */
/* AI proposals                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An action an AI agent wants to take, recorded *before* a human decides on it.
 *
 * Every destructive MCP tool writes a proposal, elicits a decision, then acts. The row is the
 * audit trail: what was suggested, why, what the compatibility check said at the time, who
 * decided, and what happened. Without it "the AI installed something and now the server is
 * broken" is unanswerable.
 */
export const proposals = sqliteTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    /** install_mods | remove_mods | update_mods | change_settings | restart | restore_backup */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** The model's explanation, shown verbatim to the human deciding. */
    rationale: text('rationale'),
    /** Structured payload describing exactly what will change. */
    payload: text('payload', { mode: 'json' }).notNull(),
    /** The compatibility report generated for this proposal. */
    compatReport: text('compat_report', { mode: 'json' }),
    /** Impact estimate: does this need a restart, will it change worldgen, etc. */
    impact: text('impact', { mode: 'json' }),

    /** pending | accepted | rejected | expired | applied | failed */
    status: text('status').notNull().default('pending'),
    decidedBy: text('decided_by'),
    decisionNote: text('decision_note'),
    /** Result of applying, once applied. */
    result: text('result', { mode: 'json' }),

    /** Which MCP session/agent produced this. */
    source: text('source').notNull().default('mcp'),

    createdAt: integer('created_at').notNull().default(now),
    decidedAt: integer('decided_at'),
    appliedAt: integer('applied_at'),
    expiresAt: integer('expires_at'),
  },
  (table) => [
    index('proposals_server_idx').on(table.serverId, table.status),
    index('proposals_status_idx').on(table.status, table.createdAt),
  ]
);

/* -------------------------------------------------------------------------- */
/* Backups                                                                     */
/* -------------------------------------------------------------------------- */

export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    label: text('label'),
    /** Absolute host path to the archive. */
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    status: text('status').notNull().default('pending'),
    statusMessage: text('status_message'),
    /** manual | schedule | pre-change | pre-restore */
    trigger: text('trigger').notNull().default('manual'),
    /** Whether the server was running (and saves flushed via RCON) at capture time. */
    hotBackup: integer('hot_backup', { mode: 'boolean' }).notNull().default(false),
    /** Mods and versions present at capture time — enough to explain a restore's effect. */
    manifest: text('manifest', { mode: 'json' }),
    createdAt: integer('created_at').notNull().default(now),
    completedAt: integer('completed_at'),
    expiresAt: integer('expires_at'),
  },
  (table) => [
    index('backups_server_idx').on(table.serverId, table.createdAt),
    index('backups_status_idx').on(table.status),
  ]
);

/* -------------------------------------------------------------------------- */
/* Scheduled tasks                                                             */
/* -------------------------------------------------------------------------- */

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** backup | restart | command | prune_backups */
    action: text('action').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().default('{}'),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at'),
    lastStatus: text('last_status'),
    lastMessage: text('last_message'),
    nextRunAt: integer('next_run_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (table) => [
    index('schedules_server_idx').on(table.serverId),
    index('schedules_next_run_idx').on(table.enabled, table.nextRunAt),
  ]
);

/* -------------------------------------------------------------------------- */
/* Events / audit log                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One table for both the user-facing activity feed and the audit log.
 *
 * Splitting them means every action has to remember to write twice, and they drift. A single
 * append-only stream filtered by `level` gives the activity feed for free and keeps the audit
 * trail complete by construction.
 */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    /** Dotted type, e.g. 'server.started', 'mod.installed', 'ai.proposal.accepted'. */
    type: text('type').notNull(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    /** user | ai | system | schedule */
    actor: text('actor').notNull().default('system'),
    /** Free-form context: mod ids, exit codes, durations, proposal ids. */
    data: text('data', { mode: 'json' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => [
    index('events_server_idx').on(table.serverId, table.createdAt),
    index('events_type_idx').on(table.type),
    index('events_created_idx').on(table.createdAt),
  ]
);

/* -------------------------------------------------------------------------- */
/* Diagnoses                                                                   */
/* -------------------------------------------------------------------------- */

export const diagnoses = sqliteTable(
  'diagnoses',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** manual | auto_on_crash | mcp */
    trigger: text('trigger').notNull().default('manual'),
    /** Findings from the rule catalogue: [{ ruleId, severity, title, detail, evidence, fixes }] */
    findings: text('findings', { mode: 'json' }).notNull().default('[]'),
    /** Single-sentence summary suitable for a notification. */
    summary: text('summary'),
    /** Log window analysed, so a finding can be traced back to its evidence. */
    logFrom: integer('log_from'),
    logTo: integer('log_to'),
    /** Set when a fix derived from this diagnosis was applied. */
    resolvedByProposalId: text('resolved_by_proposal_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => [index('diagnoses_server_idx').on(table.serverId, table.createdAt)]
);

/* -------------------------------------------------------------------------- */
/* Key/value settings and API keys                                             */
/* -------------------------------------------------------------------------- */

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** SHA-256 of the token. The plaintext is shown once, at creation, and never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Short prefix kept for display ("pltr_a1b2…"), so keys are identifiable in a list. */
    tokenPrefix: text('token_prefix').notNull(),
    /** JSON array of scopes: ['servers:read', 'servers:write', 'mods:write', ...] */
    scopes: text('scopes', { mode: 'json' }).notNull().default('[]'),
    lastUsedAt: integer('last_used_at'),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('api_keys_token_hash_unique').on(table.tokenHash)]
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                   */
/* -------------------------------------------------------------------------- */

export const serversRelations = relations(servers, ({ many }) => ({
  modInstalls: many(modInstalls),
  backups: many(backups),
  schedules: many(schedules),
  events: many(events),
  proposals: many(proposals),
  diagnoses: many(diagnoses),
  ports: many(portAllocations),
}));

export const modProjectsRelations = relations(modProjects, ({ many }) => ({
  versions: many(modVersions),
  installs: many(modInstalls),
}));

export const modVersionsRelations = relations(modVersions, ({ one }) => ({
  project: one(modProjects, {
    fields: [modVersions.modProjectId],
    references: [modProjects.id],
  }),
}));

export const modInstallsRelations = relations(modInstalls, ({ one }) => ({
  server: one(servers, { fields: [modInstalls.serverId], references: [servers.id] }),
  project: one(modProjects, {
    fields: [modInstalls.modProjectId],
    references: [modProjects.id],
  }),
  version: one(modVersions, {
    fields: [modInstalls.modVersionId],
    references: [modVersions.id],
  }),
}));

export const backupsRelations = relations(backups, ({ one }) => ({
  server: one(servers, { fields: [backups.serverId], references: [servers.id] }),
}));

export const schedulesRelations = relations(schedules, ({ one }) => ({
  server: one(servers, { fields: [schedules.serverId], references: [servers.id] }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  server: one(servers, { fields: [events.serverId], references: [servers.id] }),
}));

export const proposalsRelations = relations(proposals, ({ one }) => ({
  server: one(servers, { fields: [proposals.serverId], references: [servers.id] }),
}));

export const diagnosesRelations = relations(diagnoses, ({ one }) => ({
  server: one(servers, { fields: [diagnoses.serverId], references: [servers.id] }),
}));

export const portAllocationsRelations = relations(portAllocations, ({ one }) => ({
  server: one(servers, { fields: [portAllocations.serverId], references: [servers.id] }),
}));

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type ServerRow = typeof servers.$inferSelect;
export type NewServerRow = typeof servers.$inferInsert;
export type ModProjectRow = typeof modProjects.$inferSelect;
export type NewModProjectRow = typeof modProjects.$inferInsert;
export type ModVersionRow = typeof modVersions.$inferSelect;
export type NewModVersionRow = typeof modVersions.$inferInsert;
export type ModInstallRow = typeof modInstalls.$inferSelect;
export type NewModInstallRow = typeof modInstalls.$inferInsert;
export type BackupRow = typeof backups.$inferSelect;
export type NewBackupRow = typeof backups.$inferInsert;
export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
export type DiagnosisRow = typeof diagnoses.$inferSelect;
export type NewDiagnosisRow = typeof diagnoses.$inferInsert;
export type PortAllocationRow = typeof portAllocations.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
