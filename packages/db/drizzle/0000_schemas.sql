CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS identity;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS platform;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA identity TO identity;
--> statement-breakpoint
GRANT USAGE ON SCHEMA platform TO platform;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA identity GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO identity;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform;
