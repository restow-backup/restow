-- Retention hold on suspicion (docs/RANSOMWARE.md, "Retention hold"): while an object has a
-- suspicious restore point that is neither a false alarm nor released, retention keeps every
-- restore point of it. An administrator's release of the hold (who, when, a note; audited) and
-- the time an unresolved hold was last announced again (`backup.suspicious_hold`).
--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD COLUMN "hold_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD COLUMN "hold_released_by_user_id" text;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD COLUMN "hold_released_by" text;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD COLUMN "hold_release_note" text;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD COLUMN "hold_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD CONSTRAINT "restore_point_suspicions_hold_released_by_user_id_user_id_fk" FOREIGN KEY ("hold_released_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD CONSTRAINT "restore_point_suspicions_hold_note_ck" CHECK ("restore_point_suspicions"."hold_release_note" IS NULL OR char_length("restore_point_suspicions"."hold_release_note") <= 1000);
