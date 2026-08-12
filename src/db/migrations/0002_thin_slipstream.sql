CREATE TABLE `dns_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`priority` integer,
	`ttl` integer,
	FOREIGN KEY (`snapshot_id`) REFERENCES `dns_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dns_records_snapshot_id_idx` ON `dns_records` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `dns_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dns_snapshots_domain_id_idx` ON `dns_snapshots` (`domain_id`);