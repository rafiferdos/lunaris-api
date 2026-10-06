CREATE TABLE "notification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_kind" CHECK ("notification_jobs"."kind" in ('summary','reminder')),
	CONSTRAINT "notification_status" CHECK ("notification_jobs"."status" in ('pending','processing','sent','cancelled','failed'))
);
--> statement-breakpoint
CREATE TABLE "notification_subscriptions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"summaries_at" timestamp with time zone,
	"reminders_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_user_period" ON "notification_jobs" USING btree ("user_id","kind","period");--> statement-breakpoint
CREATE INDEX "notification_due" ON "notification_jobs" USING btree ("status","next_at");