BEGIN;

-- Only WinCRM commerce evidence. Existing Widgets tables and Billing default
-- privileges deliberately remain outside this migration's scope.
DO $wincrm_commerce_acl$
DECLARE
    owner_oid OID := to_regrole(CURRENT_USER);
    runtime_oid OID := to_regrole('winwidget_billing_runtime');
    relation_name TEXT;
    relation_oid OID;
    relations TEXT[] := ARRAY[
        'crm_commerce_accounts', 'crm_commerce_commands', 'crm_orders',
        'crm_paid_periods', 'crm_auto_renewals', 'crm_auto_renewal_consents',
        'crm_provider_operations', 'crm_provider_deliveries', 'crm_payment_receipts'
    ];
BEGIN
    IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'billing')
        IS DISTINCT FROM owner_oid THEN
        RAISE EXCEPTION 'Billing schema must be owned by the current migration role';
    END IF;
    IF runtime_oid IS NOT NULL AND (
        runtime_oid = owner_oid OR EXISTS (
            SELECT 1 FROM pg_roles WHERE oid = runtime_oid
                AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
        )
    ) THEN
        RAISE EXCEPTION 'Billing runtime role is not restricted';
    END IF;

    FOREACH relation_name IN ARRAY relations LOOP
        relation_oid := to_regclass(format('billing.%I', relation_name));
        IF relation_oid IS NULL OR (
            SELECT relowner FROM pg_class WHERE oid = relation_oid
        ) IS DISTINCT FROM owner_oid THEN
            RAISE EXCEPTION 'WinCRM commerce relation owner drifted';
        END IF;
        EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE billing.%I FROM PUBLIC', relation_name);
        IF runtime_oid IS NOT NULL THEN
            EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE billing.%I FROM winwidget_billing_runtime', relation_name);
            IF has_table_privilege(runtime_oid, relation_oid, 'DELETE')
                OR has_table_privilege(runtime_oid, relation_oid, 'TRUNCATE') THEN
                RAISE EXCEPTION 'WinCRM commerce runtime removal privilege remains';
            END IF;
        END IF;
    END LOOP;

    REVOKE UPDATE ON TABLE billing.crm_auto_renewal_consents FROM PUBLIC;
    REVOKE ALL ON FUNCTION billing.protect_wincrm_commerce_evidence() FROM PUBLIC;
    IF runtime_oid IS NOT NULL THEN
        REVOKE UPDATE ON TABLE billing.crm_auto_renewal_consents FROM winwidget_billing_runtime;
        REVOKE ALL ON FUNCTION billing.protect_wincrm_commerce_evidence() FROM winwidget_billing_runtime;
        IF has_any_column_privilege(runtime_oid, 'billing.crm_auto_renewal_consents', 'UPDATE')
            OR has_function_privilege(runtime_oid, 'billing.protect_wincrm_commerce_evidence()', 'EXECUTE') THEN
            RAISE EXCEPTION 'WinCRM consent or routine runtime privilege remains';
        END IF;
    END IF;
END
$wincrm_commerce_acl$;

COMMIT;
