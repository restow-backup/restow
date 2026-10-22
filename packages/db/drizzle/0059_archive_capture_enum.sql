-- 0.4.4: a capture path for plain copies a mail provider forwards to an archive address at
-- transport (BCC or routing rule, docs/ARCHIVE.md "Weiterleitung an die Journal-Adresse"). In a
-- migration of its own: a new enum value cannot be used in the transaction that adds it.
--> statement-breakpoint
ALTER TYPE "public"."archive_capture" ADD VALUE IF NOT EXISTS 'smtp_forward';
