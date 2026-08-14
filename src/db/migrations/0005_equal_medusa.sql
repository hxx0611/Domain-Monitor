CREATE TABLE `notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_event_id_idx` ON `notification_deliveries` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_event_channel_unique` ON `notification_deliveries` (`event_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`source` text NOT NULL,
	`event_type` text NOT NULL,
	`previous_state` text,
	`current_state` text,
	`dedup_key` text NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedup_key_unique` ON `notification_events` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `notification_events_domain_id_idx` ON `notification_events` (`domain_id`);--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`channel_id` integer NOT NULL,
	`source` text,
	`event_type` text,
	`domain_id` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
