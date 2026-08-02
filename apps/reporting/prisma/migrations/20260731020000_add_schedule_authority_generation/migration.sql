ALTER TABLE reporting."reporting_settings"
ADD COLUMN "schedule_authority_generation" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "schedule_policy_change_id" UUID,
ADD CONSTRAINT "reporting_settings_schedule_authority_generation_check"
    CHECK ("schedule_authority_generation" >= 0);
