CREATE TYPE "public"."provider_role" AS ENUM('owner', 'administrator', 'technician', 'read_only');--> statement-breakpoint
CREATE TABLE "provider_member_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" "provider_role" NOT NULL,
	"all_tenants" boolean DEFAULT true NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_members_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "provider_member_tenants" ADD CONSTRAINT "provider_member_tenants_user_id_provider_members_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."provider_members"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_member_tenants" ADD CONSTRAINT "provider_member_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_members" ADD CONSTRAINT "provider_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_members" ADD CONSTRAINT "provider_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_member_tenants_user_tenant_uq" ON "provider_member_tenants" USING btree ("user_id","tenant_id");