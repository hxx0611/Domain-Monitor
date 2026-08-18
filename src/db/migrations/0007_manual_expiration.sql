ALTER TABLE `domains` ADD COLUMN `expiration_source` text NOT NULL DEFAULT 'rdap';
--> statement-breakpoint
ALTER TABLE `domains` ADD COLUMN `registration_provider` text;
--> statement-breakpoint
ALTER TABLE `domains` ADD COLUMN `registration_provider_url` text;
--> statement-breakpoint
CREATE TABLE `expiration_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`days_before` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expiration_reminders_domain_days_unique` ON `expiration_reminders` (`domain_id`,`days_before`);
