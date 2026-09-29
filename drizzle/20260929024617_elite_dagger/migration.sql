CREATE TABLE `image_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`resource_id` integer NOT NULL,
	`source_registry` text NOT NULL,
	`source_repository` text NOT NULL,
	`source_repository_authored` text NOT NULL,
	`source_tag` text NOT NULL,
	`target_platform` text,
	`platform_source` text,
	`configured_reference` text,
	`configured_digest` text,
	`configured_reference_kind` text,
	`observed_digest` text,
	`observed_at` integer,
	`upstream_tag_updated_at` integer,
	`observed_reference_kind` text,
	`platform_manifest_digest` text,
	`observed_error` text,
	`last_successful_digest` text,
	`last_success_at` integer,
	`last_success_deployment_uuid` text,
	`last_success_source` text,
	`pinned_at` integer,
	`track_source` text DEFAULT 'discovered' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_image_tracks_resource_id_resources_id_fk` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`event_type` text NOT NULL,
	`resource_id` integer,
	`dedupe_key` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	CONSTRAINT `fk_notification_outbox_resource_id_resources_id_fk` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`coolify_uuid` text NOT NULL,
	`parent_id` integer,
	`name` text NOT NULL,
	`compose_service_name` text,
	`server_uuid` text,
	`server_name` text,
	`project_name` text,
	`environment_name` text,
	`project_uuid` text,
	`check_cron` text,
	`environment_uuid` text,
	`domains` text,
	`current_image` text,
	`config_fingerprint` text,
	`policy` text DEFAULT 'ignore' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`blocked_reason` text,
	`excluded_infra` integer DEFAULT false NOT NULL,
	`is_stopped` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`resource_id` integer NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`candidate_digest` text NOT NULL,
	`candidate_reference` text NOT NULL,
	`prior_digest` text,
	`prior_reference` text,
	`expected_fingerprint` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`deployment_uuid` text,
	`error_code` text,
	`error_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`log` text DEFAULT '[]' NOT NULL,
	`confirmed_manually` integer DEFAULT false NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT `fk_update_jobs_resource_id_resources_id_fk` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_tracks_resource_uq` ON `image_tracks` (`resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_dedupe_uq` ON `notification_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_status_idx` ON `notification_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `resources_kind_uuid_uq` ON `resources` (`kind`,`coolify_uuid`);--> statement-breakpoint
CREATE INDEX `resources_parent_idx` ON `resources` (`parent_id`);--> statement-breakpoint
CREATE INDEX `resources_policy_idx` ON `resources` (`policy`);--> statement-breakpoint
CREATE INDEX `resources_status_idx` ON `resources` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `update_jobs_idem_uq` ON `update_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `update_jobs_resource_idx` ON `update_jobs` (`resource_id`);--> statement-breakpoint
CREATE INDEX `update_jobs_status_idx` ON `update_jobs` (`status`);