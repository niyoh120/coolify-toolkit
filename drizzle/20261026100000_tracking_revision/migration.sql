ALTER TABLE `image_tracks` ADD `tracking_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `update_jobs` ADD `tracking_revision` integer DEFAULT 0 NOT NULL;