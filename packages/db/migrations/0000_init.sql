CREATE TYPE "public"."actor_type" AS ENUM('human', 'agent', 'service', 'external', 'system');--> statement-breakpoint
CREATE TYPE "public"."autonomy_level" AS ENUM('human_led', 'agent_led_approval', 'agent_autonomous');--> statement-breakpoint
CREATE TYPE "public"."clarification_level" AS ENUM('must_confirm', 'default_applicable', 'assumption_ok', 'auto_resolved');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('pending', 'approved', 'rejected', 'revision_requested', 'delegated', 'taken_over', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('finish_to_start', 'start_to_start', 'artifact', 'decision', 'permission', 'external', 'data');--> statement-breakpoint
CREATE TYPE "public"."environment" AS ENUM('dev', 'test', 'staging', 'production');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."requirement_status" AS ENUM('draft', 'analyzing', 'clarifying', 'awaiting_approval', 'approved', 'rejected', 'on_hold');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'dispatching', 'running', 'paused', 'completed', 'failed', 'timeout', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('intake', 'planning', 'execution', 'review', 'release', 'done');--> statement-breakpoint
CREATE TYPE "public"."work_item_status" AS ENUM('draft', 'clarifying', 'awaiting_requirement_approval', 'planning', 'awaiting_plan_approval', 'ready', 'executing', 'blocked', 'failed', 'reviewing', 'changes_requested', 'awaiting_decision', 'waiting_for_release', 'releasing', 'released', 'acceptance', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_item_type" AS ENUM('requirement', 'feature', 'story', 'task', 'bug', 'research', 'review', 'test', 'incident', 'decision', 'approval', 'release', 'knowledge');--> statement-breakpoint
CREATE TABLE "agent_permission_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"changed_by" uuid NOT NULL,
	"direction" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"previous_run_id" uuid,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"goal" text NOT NULL,
	"input_context" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"model_config" jsonb,
	"tools_snapshot" text[] DEFAULT '{}' NOT NULL,
	"permission_snapshot" jsonb,
	"step_current" integer,
	"step_total" integer,
	"step_description" text,
	"progress_note" text,
	"tokens_input" bigint DEFAULT 0 NOT NULL,
	"tokens_output" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_read" bigint DEFAULT 0 NOT NULL,
	"cost" numeric(10, 4) DEFAULT '0' NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"error_class" text,
	"error_message" text,
	"error_detail" jsonb,
	"agent_self_report" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text,
	"credential_ref" text,
	"protocol_version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"runtime_id" uuid NOT NULL,
	"runtime_ref" text NOT NULL,
	"model" text,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"applicable_types" "work_item_type"[] DEFAULT '{}' NOT NULL,
	"allowed_tools" text[] DEFAULT '{}' NOT NULL,
	"denied_tools" text[] DEFAULT '{}' NOT NULL,
	"resource_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrency" integer DEFAULT 3 NOT NULL,
	"timeout_seconds" integer DEFAULT 1800 NOT NULL,
	"cost_limit_per_run" numeric(10, 4),
	"cost_limit_daily" numeric(10, 2),
	"retry_policy" jsonb DEFAULT '{"max_attempts":2,"backoff_seconds":[60,300]}'::jsonb NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"storage" text DEFAULT 'external' NOT NULL,
	"external_url" text,
	"storage_key" text,
	"content" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"produced_by_type" "actor_type" NOT NULL,
	"produced_by_id" uuid,
	"from_incomplete_run" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_approvals" (
	"decision_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"opinion" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "decision_approvals_decision_id_approver_id_pk" PRIMARY KEY("decision_id","approver_id")
);
--> statement-breakpoint
CREATE TABLE "decision_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"ref" text,
	"produced_by_type" "actor_type",
	"produced_by_id" uuid,
	"is_live" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"confidence" numeric(4, 3),
	"rationale" text,
	"uncertainties" text[] DEFAULT '{}' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reversible" boolean,
	"position" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"run_id" uuid,
	"type" text NOT NULL,
	"status" "decision_status" DEFAULT 'pending' NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"reversible" boolean DEFAULT true NOT NULL,
	"title" text NOT NULL,
	"background" text,
	"why_human" text NOT NULL,
	"consequence" text,
	"impact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_by_policy" uuid,
	"policy_trace" jsonb,
	"assignee_id" uuid,
	"assignee_role" text,
	"delegated_from" uuid,
	"requires_cosign" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"escalation_level" smallint DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"selected_option_id" uuid,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"applied_constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"outcome_note" text,
	"outcome_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"level" text DEFAULT 'milestone' NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_snapshot" jsonb,
	"causation_id" bigint,
	"correlation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requirement_id" uuid,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scope" jsonb,
	"phases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"critical_path" uuid[] DEFAULT '{}' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"release_plan" jsonb,
	"rollback_plan" jsonb,
	"estimated_hours" numeric(8, 2),
	"estimated_cost" numeric(10, 2),
	"estimated_end" date,
	"auto_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by" uuid,
	"generation_run_id" uuid,
	"model" text,
	"generation_cost" numeric(10, 4),
	"generation_ms" integer,
	"approved_by" uuid[] DEFAULT '{}' NOT NULL,
	"approved_at" timestamp with time zone,
	"revision_feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_projectId_requirementId_version_unique" UNIQUE("project_id","requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"hit_count30d" integer DEFAULT 0 NOT NULL,
	"avg_wait_seconds" integer,
	"created_by" uuid NOT NULL,
	"disabled_by" uuid,
	"disabled_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"policy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"direction" text,
	"simulation_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_versions_policy_id_version_pk" PRIMARY KEY("policy_id","version")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_actor_type_actor_id_pk" PRIMARY KEY("project_id","actor_type","actor_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"type" text DEFAULT 'development' NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"autonomy_level" "autonomy_level" DEFAULT 'agent_led_approval' NOT NULL,
	"risk_level" "risk_level" DEFAULT 'medium' NOT NULL,
	"sponsor_id" uuid,
	"tech_lead_id" uuid,
	"starts_at" date,
	"ends_at" date,
	"budget_amount" numeric(12, 2),
	"budget_currency" text DEFAULT 'USD' NOT NULL,
	"cost_spent" numeric(12, 2) DEFAULT '0' NOT NULL,
	"stage_config" jsonb DEFAULT '["intake","planning","execution","review","release","done"]'::jsonb NOT NULL,
	"wip_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused_reason" text,
	"paused_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"origin" text NOT NULL,
	"confirmed_by" uuid,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"level" "clarification_level" NOT NULL,
	"question" text NOT NULL,
	"impact" text,
	"agent_suggestion" text,
	"suggestion_basis" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"resolved_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "requirement_status" DEFAULT 'draft' NOT NULL,
	"raw_input" text NOT NULL,
	"input_method" text DEFAULT 'manual' NOT NULL,
	"source_ref" jsonb,
	"title" text,
	"business_context" text,
	"user_problem" text,
	"business_goal" text,
	"user_stories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"non_functional" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"success_metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completeness" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"due_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reject_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"level" text DEFAULT 'detail' NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb,
	"cost_delta" numeric(10, 6),
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"org_role" text DEFAULT 'member' NOT NULL,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"approval_scopes" text[] DEFAULT '{}' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_orgId_email_unique" UNIQUE("org_id","email")
);
--> statement-breakpoint
CREATE TABLE "work_item_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" "dependency_type" DEFAULT 'finish_to_start' NOT NULL,
	"lag_minutes" integer DEFAULT 0 NOT NULL,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_dependencies_fromId_toId_type_unique" UNIQUE("from_id","to_id","type")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"requirement_id" uuid,
	"plan_id" uuid,
	"type" "work_item_type" NOT NULL,
	"status" "work_item_status" DEFAULT 'draft' NOT NULL,
	"stage" "stage" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" smallint DEFAULT 2 NOT NULL,
	"risk_level" "risk_level" DEFAULT 'low' NOT NULL,
	"parent_id" uuid,
	"path" text,
	"position" integer DEFAULT 0 NOT NULL,
	"owner_id" uuid,
	"executor_type" "actor_type",
	"executor_id" uuid,
	"planned_start" timestamp with time zone,
	"planned_end" timestamp with time zone,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"estimated_hours" numeric(6, 2),
	"estimated_cost" numeric(10, 4),
	"actual_cost" numeric(10, 4) DEFAULT '0' NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_gate" text,
	"human_gate_ref" uuid,
	"blocked_since" timestamp with time zone,
	"blocked_reason" text,
	"blocked_detail" jsonb,
	"previous_status" "work_item_status",
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"type_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_permission_changes" ADD CONSTRAINT "agent_permission_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_permission_changes" ADD CONSTRAINT "agent_permission_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_id_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."agent_runtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_approvals" ADD CONSTRAINT "decision_approvals_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_approvals" ADD CONSTRAINT "decision_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_evidence" ADD CONSTRAINT "decision_evidence_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_sponsor_id_users_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tech_lead_id_users_id_fk" FOREIGN KEY ("tech_lead_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_assumptions" ADD CONSTRAINT "requirement_assumptions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_clarifications" ADD CONSTRAINT "requirement_clarifications_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_dependencies" ADD CONSTRAINT "work_item_dependencies_from_id_work_items_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_dependencies" ADD CONSTRAINT "work_item_dependencies_to_id_work_items_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_idem_idx" ON "agent_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_runs_heartbeat_idx" ON "agent_runs" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "agent_runs_item_idx" ON "agent_runs" USING btree ("work_item_id","attempt");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_idx" ON "agent_runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agents_org_status_idx" ON "agents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "artifacts_item_idx" ON "artifacts" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "decisions_inbox_idx" ON "decisions" USING btree ("assignee_id","status","due_at");--> statement-breakpoint
CREATE INDEX "decisions_project_idx" ON "decisions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "decisions_type_idx" ON "decisions" USING btree ("type","status","created_at");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "events" USING btree ("project_id","level","id");--> statement-breakpoint
CREATE INDEX "events_correlation_idx" ON "events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_type","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_policy_sim_idx" ON "events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "policies_lookup_idx" ON "policies" USING btree ("org_id","project_id","priority");--> statement-breakpoint
CREATE INDEX "projects_org_id_status_index" ON "projects" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "requirements_project_id_status_index" ON "requirements" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "deps_to_idx" ON "work_item_dependencies" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "deps_from_idx" ON "work_item_dependencies" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "work_items_board_idx" ON "work_items" USING btree ("project_id","stage","status");--> statement-breakpoint
CREATE INDEX "work_items_executor_idx" ON "work_items" USING btree ("executor_type","executor_id","status");--> statement-breakpoint
CREATE INDEX "work_items_owner_idx" ON "work_items" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "work_items_blocked_idx" ON "work_items" USING btree ("project_id","blocked_since");--> statement-breakpoint
CREATE INDEX "work_items_path_idx" ON "work_items" USING btree ("path");