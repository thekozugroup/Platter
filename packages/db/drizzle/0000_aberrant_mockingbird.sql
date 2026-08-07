CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`label` text,
	`path` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_message` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`hot_backup` integer DEFAULT false NOT NULL,
	`manifest` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `backups_server_idx` ON `backups` (`server_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `backups_status_idx` ON `backups` (`status`);--> statement-breakpoint
CREATE TABLE `diagnoses` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`log_from` integer,
	`log_to` integer,
	`resolved_by_proposal_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `diagnoses_server_idx` ON `diagnoses` (`server_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`type` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_server_idx` ON `events` (`server_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `mod_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`mod_project_id` text,
	`mod_version_id` text,
	`provider` text NOT NULL,
	`project_slug` text,
	`display_name` text NOT NULL,
	`version_label` text,
	`kind` text DEFAULT 'mod' NOT NULL,
	`file_path` text,
	`file_size` integer,
	`sha1` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_message` text,
	`is_dependency` integer DEFAULT false NOT NULL,
	`required_by` text,
	`installed_by` text DEFAULT 'user' NOT NULL,
	`proposal_id` text,
	`compat_snapshot` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mod_project_id`) REFERENCES `mod_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mod_version_id`) REFERENCES `mod_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mod_installs_server_idx` ON `mod_installs` (`server_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `mod_installs_server_project_unique` ON `mod_installs` (`server_id`,`provider`,`project_slug`);--> statement-breakpoint
CREATE TABLE `mod_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`project_id` text NOT NULL,
	`slug` text,
	`title` text NOT NULL,
	`summary` text,
	`description` text,
	`author` text,
	`icon_url` text,
	`project_url` text,
	`license` text,
	`downloads` integer,
	`followers` integer,
	`kind` text DEFAULT 'mod' NOT NULL,
	`client_side` text DEFAULT 'unknown' NOT NULL,
	`server_side` text DEFAULT 'unknown' NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`loaders` text DEFAULT '[]' NOT NULL,
	`game_versions` text DEFAULT '[]' NOT NULL,
	`raw` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mod_projects_provider_project_unique` ON `mod_projects` (`provider`,`project_id`);--> statement-breakpoint
CREATE INDEX `mod_projects_slug_idx` ON `mod_projects` (`provider`,`slug`);--> statement-breakpoint
CREATE INDEX `mod_projects_fetched_idx` ON `mod_projects` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `mod_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`mod_project_id` text NOT NULL,
	`version_id` text NOT NULL,
	`version_number` text,
	`name` text,
	`channel` text DEFAULT 'release' NOT NULL,
	`game_versions` text DEFAULT '[]' NOT NULL,
	`loaders` text DEFAULT '[]' NOT NULL,
	`dependencies` text DEFAULT '[]' NOT NULL,
	`file_name` text,
	`file_url` text,
	`file_size` integer,
	`sha1` text,
	`sha512` text,
	`downloadable` integer DEFAULT true NOT NULL,
	`published_at` integer,
	`raw` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mod_project_id`) REFERENCES `mod_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mod_versions_project_version_unique` ON `mod_versions` (`mod_project_id`,`version_id`);--> statement-breakpoint
CREATE INDEX `mod_versions_game_idx` ON `mod_versions` (`mod_project_id`,`channel`);--> statement-breakpoint
CREATE TABLE `port_allocations` (
	`port` integer PRIMARY KEY NOT NULL,
	`server_id` text,
	`purpose` text NOT NULL,
	`protocol` text DEFAULT 'tcp' NOT NULL,
	`allocated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `port_allocations_server_idx` ON `port_allocations` (`server_id`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`rationale` text,
	`payload` text NOT NULL,
	`compat_report` text,
	`impact` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`result` text,
	`source` text DEFAULT 'mcp' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decided_at` integer,
	`applied_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_server_idx` ON `proposals` (`server_id`,`status`);--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`cron` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_message` text,
	`next_run_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_server_idx` ON `schedules` (`server_id`);--> statement-breakpoint
CREATE INDEX `schedules_next_run_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`game` text DEFAULT 'minecraft' NOT NULL,
	`loader` text NOT NULL,
	`game_version` text NOT NULL,
	`loader_version` text,
	`image` text NOT NULL,
	`container_id` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`status_message` text,
	`last_exit_code` integer,
	`port` integer NOT NULL,
	`rcon_port` integer,
	`rcon_password` text NOT NULL,
	`memory_mib` integer DEFAULT 4096 NOT NULL,
	`cpus` integer DEFAULT 2000 NOT NULL,
	`pids_limit` integer DEFAULT 512 NOT NULL,
	`restart_policy` text DEFAULT 'unless-stopped' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`data_dir` text NOT NULL,
	`modpack_provider` text,
	`modpack_project_id` text,
	`modpack_version_id` text,
	`auto_backup` integer DEFAULT true NOT NULL,
	`backup_cron` text DEFAULT '0 4 * * *',
	`backup_retention` integer DEFAULT 7 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`stopped_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_slug_unique` ON `servers` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `servers_port_unique` ON `servers` (`port`);--> statement-breakpoint
CREATE INDEX `servers_status_idx` ON `servers` (`status`);--> statement-breakpoint
CREATE INDEX `servers_deleted_idx` ON `servers` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
