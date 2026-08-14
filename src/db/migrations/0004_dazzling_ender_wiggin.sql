CREATE TABLE `http_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`response_time_ms` integer,
	`redirected` integer,
	`redirect_count` integer,
	`final_url` text,
	`error` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `http_snapshots_domain_id_idx` ON `http_snapshots` (`domain_id`);