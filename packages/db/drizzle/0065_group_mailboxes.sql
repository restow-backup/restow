-- 0.4.5: the group mailbox of a Microsoft 365 group or team (its calendar and its conversations)
-- becomes a protected object of its own kind (docs/MICROSOFT.md, "Gruppenpostfächer"). In a
-- migration of its own: a new enum value cannot be used in the transaction that adds it.
--> statement-breakpoint
ALTER TYPE "public"."protected_object_kind" ADD VALUE IF NOT EXISTS 'group';
