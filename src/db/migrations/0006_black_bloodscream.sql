CREATE TABLE `admin_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`password_hash` text,
	`recovery_code_hash` text,
	`session_secret` text,
	`encryption_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_secrets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`key` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_secrets_channel_key_unique` ON `notification_secrets` (`channel_id`,`key`);