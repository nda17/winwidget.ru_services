BEGIN;

CREATE TABLE billing.crm_admin_day_grants (
  command_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES billing.crm_entitlements(workspace_id) ON DELETE RESTRICT,
  actor_subject VARCHAR(256) NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:space:][:cntrl:]]'),
  actor_role VARCHAR(16) NOT NULL CHECK (actor_role IN ('ADMIN', 'DEV')),
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 3650),
  reason VARCHAR(1000) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  target VARCHAR(32) NOT NULL CHECK (target IN ('ENTITLEMENT', 'PAID_PERIOD')),
  period_id UUID REFERENCES billing.crm_paid_periods(id) ON DELETE RESTRICT,
  old_expires_at TIMESTAMP(3) NOT NULL,
  new_expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((target = 'PAID_PERIOD') = (period_id IS NOT NULL)),
  CHECK (new_expires_at > old_expires_at),
  FOREIGN KEY (period_id, workspace_id) REFERENCES billing.crm_paid_periods(id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX crm_admin_day_grants_workspace_id_created_at_command_id_idx
  ON billing.crm_admin_day_grants(workspace_id, created_at, command_id);

CREATE FUNCTION billing.protect_crm_admin_day_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WinCRM administrative day grants are append-only';
END;
$$;
REVOKE ALL ON FUNCTION billing.protect_crm_admin_day_grants() FROM PUBLIC;
CREATE TRIGGER crm_admin_day_grants_append_only BEFORE UPDATE OR DELETE ON billing.crm_admin_day_grants
  FOR EACH ROW EXECUTE FUNCTION billing.protect_crm_admin_day_grants();
CREATE TRIGGER crm_admin_day_grants_no_truncate BEFORE TRUNCATE ON billing.crm_admin_day_grants
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_crm_admin_day_grants();

-- A delayed HTTP request must never become executable after receipt retention.
-- Only these new CRM command types are retained; legacy Widgets rows keep their
-- existing update/delete permissions and behavior.
CREATE FUNCTION billing.protect_crm_admin_command_receipts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM billing.command_receipts WHERE command_type IN ('ADMIN_EXTEND_WINCRM_DAYS', 'CANCEL_ADMIN_EXTEND_WINCRM_DAYS')) THEN
      RAISE EXCEPTION 'WinCRM administrative terminal receipts cannot be truncated';
    END IF;
    RETURN NULL;
  END IF;
  IF OLD.command_type IN ('ADMIN_EXTEND_WINCRM_DAYS', 'CANCEL_ADMIN_EXTEND_WINCRM_DAYS') THEN
    RAISE EXCEPTION 'WinCRM administrative terminal receipts are immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.command_type IN ('ADMIN_EXTEND_WINCRM_DAYS', 'CANCEL_ADMIN_EXTEND_WINCRM_DAYS') THEN
      RAISE EXCEPTION 'WinCRM administrative terminal receipts cannot replace another command';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION billing.protect_crm_admin_command_receipts() FROM PUBLIC;
CREATE TRIGGER crm_admin_command_receipts_retention_guard BEFORE UPDATE OR DELETE ON billing.command_receipts
  FOR EACH ROW EXECUTE FUNCTION billing.protect_crm_admin_command_receipts();
CREATE TRIGGER crm_admin_command_receipts_no_truncate BEFORE TRUNCATE ON billing.command_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION billing.protect_crm_admin_command_receipts();
REVOKE ALL ON TABLE billing.crm_admin_day_grants FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('winwidget_billing_runtime') IS NOT NULL THEN
    REVOKE ALL ON TABLE billing.crm_admin_day_grants FROM winwidget_billing_runtime;
    GRANT SELECT, INSERT ON TABLE billing.crm_admin_day_grants TO winwidget_billing_runtime;
    REVOKE ALL ON FUNCTION billing.protect_crm_admin_day_grants() FROM winwidget_billing_runtime;
    REVOKE ALL ON FUNCTION billing.protect_crm_admin_command_receipts() FROM winwidget_billing_runtime;
  END IF;
END;
$$;

COMMIT;
