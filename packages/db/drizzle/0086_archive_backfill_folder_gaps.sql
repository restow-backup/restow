-- 0.5.0: the IMAP backfill and the live capture counted a folder they could not read in the same
-- capture gap row (kind 'folder', the folder's path). A live pass that only asked STATUS (no new
-- mail) resolved it, so the backfill's attempts started over and a folder that refuses EXAMINE was
-- never given up; and both ways' failures together gave a briefly refused folder up after two
-- passes, the backfill completed without its older mail, and the next live pass resolved the gap:
-- that mail was missing from the archive with nothing open. The backfill now counts its own kind,
-- 'backfill_folder', which only a takeover of the folder's older mail resolves. A new enum value;
-- existing rows keep their kind.
--> statement-breakpoint
ALTER TYPE "public"."archive_capture_gap_kind" ADD VALUE 'backfill_folder';
