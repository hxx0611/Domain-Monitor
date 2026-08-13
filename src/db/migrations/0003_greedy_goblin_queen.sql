CREATE TABLE `ssl_certificates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`fingerprint256` text NOT NULL,
	`subject` text,
	`issuer` text,
	`valid_from` text,
	`valid_to` text,
	`serial_number` text,
	`san` text,
	`is_self_signed` integer,
	`hostname_matched` integer,
	FOREIGN KEY (`snapshot_id`) REFERENCES `ssl_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ssl_certificates_snapshot_id_idx` ON `ssl_certificates` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `ssl_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`tls_version` text,
	`cipher_name` text,
	`status` text NOT NULL,
	`error` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ssl_snapshots_domain_id_idx` ON `ssl_snapshots` (`domain_id`);