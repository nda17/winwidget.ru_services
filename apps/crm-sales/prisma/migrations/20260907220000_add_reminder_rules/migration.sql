-- Service-owned configuration only. No task mutation, schedule, Outbox or send.
BEGIN;
CREATE TABLE "crm_sales"."reminder_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "owner_subject" VARCHAR(256) NOT NULL,
    "owner_membership_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "configuration" JSONB NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reminder_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminder_rules_scope_check" CHECK ("scope" IN ('WORKSPACE', 'PERSONAL')),
    CONSTRAINT "reminder_rules_version_check" CHECK ("version" >= 1),
    CONSTRAINT "reminder_rules_subject_check" CHECK (length("owner_subject") BETWEEN 1 AND 256 AND "owner_subject" !~ '[[:space:][:cntrl:]]'),
    CONSTRAINT "reminder_rules_configuration_binding_check" CHECK ((
        jsonb_typeof("configuration") = 'object'
        AND "configuration"->>'schemaVersion' = '1'
        AND ("configuration"->>'id')::uuid = "id"
        AND "configuration"->>'scope' = "scope"
        AND "configuration"->'ownerBinding'->>'subject' = "owner_subject"
        AND ("configuration"->'ownerBinding'->>'membershipId')::uuid IS NOT DISTINCT FROM "owner_membership_id"
        AND jsonb_typeof("configuration"->'enabled') = 'boolean'
    ) IS TRUE)
);
CREATE UNIQUE INDEX "reminder_rules_id_workspace_id_key" ON "crm_sales"."reminder_rules"("id", "workspace_id");
CREATE INDEX "reminder_rules_list_idx" ON "crm_sales"."reminder_rules"("workspace_id", "scope", "owner_subject", "owner_membership_id", "archived_at", "created_at", "id");

CREATE TABLE "crm_sales"."reminder_rule_commands" (
    "command_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL,
    "actor_membership_id" UUID,
    "command_type" VARCHAR(16) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "rule_id" UUID NOT NULL,
    "before" JSONB,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reminder_rule_commands_pkey" PRIMARY KEY ("command_id"),
    CONSTRAINT "reminder_rule_commands_actor_check" CHECK (length("actor_subject") BETWEEN 1 AND 256 AND "actor_subject" !~ '[[:space:][:cntrl:]]'),
    CONSTRAINT "reminder_rule_commands_type_check" CHECK ("command_type" IN ('CREATED','EDITED','ARCHIVED')),
    CONSTRAINT "reminder_rule_commands_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "reminder_rule_commands_rule_id_workspace_id_fkey" FOREIGN KEY ("rule_id", "workspace_id") REFERENCES "crm_sales"."reminder_rules"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "reminder_rule_commands_history_idx" ON "crm_sales"."reminder_rule_commands"("workspace_id", "rule_id", "created_at", "command_id");

CREATE FUNCTION "crm_sales"."reject_reminder_command_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Reminder command evidence is append only';
END;
$$;
REVOKE ALL ON FUNCTION "crm_sales"."reject_reminder_command_mutation"() FROM PUBLIC;
CREATE TRIGGER "reminder_rule_commands_append_only" BEFORE UPDATE OR DELETE ON "crm_sales"."reminder_rule_commands" FOR EACH ROW EXECUTE FUNCTION "crm_sales"."reject_reminder_command_mutation"();
CREATE TRIGGER "reminder_rule_commands_no_truncate" BEFORE TRUNCATE ON "crm_sales"."reminder_rule_commands" FOR EACH STATEMENT EXECUTE FUNCTION "crm_sales"."reject_reminder_command_mutation"();
REVOKE ALL ON "crm_sales"."reminder_rules", "crm_sales"."reminder_rule_commands" FROM PUBLIC;
COMMIT;
