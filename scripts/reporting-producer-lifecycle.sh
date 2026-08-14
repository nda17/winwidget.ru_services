#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
REPORTING_PRODUCER_HEALTHCHECK_ATTEMPTS="${REPORTING_PRODUCER_HEALTHCHECK_ATTEMPTS:-15}"
REPORTING_PRODUCER_HEALTHCHECK_INTERVAL="${REPORTING_PRODUCER_HEALTHCHECK_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
reporting_lifecycle_source_root="${REPORTING_LIFECYCLE_SOURCE_ROOT:-$server_root}"
if [[ "$reporting_lifecycle_source_root" != /* ||
	! -d "$reporting_lifecycle_source_root" ||
	-L "$reporting_lifecycle_source_root" ||
	"$(cd -- "$reporting_lifecycle_source_root" && pwd -P)" != \
		"$reporting_lifecycle_source_root" ]]; then
	echo 'Reporting lifecycle source root must be an exact absolute non-symlink directory.' >&2
	return 1 2>/dev/null || exit 1
fi
REPORTING_CUTOVER_MARKER="${REPORTING_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.reporting-database-cutover-v1}"
readonly REPORTING_LEGACY_SETTINGS_ROUTING_KEY='reporting.settings.changed.v1'
readonly REPORTING_OPERATIONAL_ROUTING_KEY='reporting.core-operational-routing.changed.v1'

# shellcheck source=scripts/production-deploy-lock.sh
source "$reporting_lifecycle_source_root/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$reporting_lifecycle_source_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/reporting-database-lifecycle.sh
source "$reporting_lifecycle_source_root/scripts/reporting-database-lifecycle.sh"
# shellcheck source=scripts/core-database-production-guard.sh
source "$reporting_lifecycle_source_root/scripts/core-database-production-guard.sh"

reporting_core_libpq_url() {
	local key="$1" url
	url="$(reporting_get_env_value "$key")"
	# assert_core_database_url_boundaries verifies this exact suffix before use.
	printf '%s' "${url/\?schema=public&sslmode=disable/?sslmode=disable}"
}

reporting_core_psql_for() {
	local key="$1" PGURL command_status
	shift
	PGURL="$(reporting_core_libpq_url "$key")"
	export PGURL
	if docker run --rm -i --network host -e PGURL "$CORE_POSTGRES_IMAGE" \
		sh -euc 'psql --no-psqlrc --set ON_ERROR_STOP=1 "$PGURL" "$@"' sh "$@"; then
		command_status=0
	else
		command_status=$?
	fi
	unset PGURL
	return "$command_status"
}

reporting_core_psql() {
	reporting_core_psql_for DATABASE_URL_PRODUCTION "$@"
}

reporting_core_migration_psql() {
	reporting_core_psql_for DATABASE_MIGRATION_URL_PRODUCTION "$@"
}

reporting_require_core_producer_migration() {
	local state
	state="$(reporting_core_psql --tuples-only --no-align <<'SQL'
WITH expected(
  trigger_name,
  table_name,
  function_namespace,
  function_name,
  argument_count,
  encoded_arguments
) AS (
  VALUES
    ('reporting_settings_projection', 'telegram_bot_settings', 'public', 'reporting_settings_projection_trigger', 0, '')
), actual AS (
  SELECT
    trigger.oid,
    trigger.tgname AS trigger_name,
    relation.relname AS table_name,
    function_namespace.nspname AS function_namespace,
    procedure.proname AS function_name,
    trigger.tgnargs::INTEGER AS argument_count,
    encode(trigger.tgargs, 'escape') AS encoded_arguments,
    trigger.tgenabled,
    trigger.tgtype
  FROM pg_trigger trigger
  JOIN pg_class relation ON relation.oid = trigger.tgrelid
  JOIN pg_namespace relation_namespace
    ON relation_namespace.oid = relation.relnamespace
  JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
  JOIN pg_namespace function_namespace
    ON function_namespace.oid = procedure.pronamespace
  WHERE NOT trigger.tgisinternal
    AND relation_namespace.nspname = 'public'
    AND trigger.tgname LIKE 'reporting\_%' ESCAPE '\'
)
SELECT CASE WHEN
  to_regclass('public.reporting_producer_state') IS NOT NULL
  AND to_regclass('public.reporting_projection_versions') IS NOT NULL
  AND to_regclass('public.reporting_source_sequence') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM reporting_producer_state WHERE id = 'singleton'
  )
  AND (SELECT count(*) FROM expected) = 1
  AND (SELECT count(*) FROM actual) = 1
  AND NOT EXISTS (
    SELECT 1
    FROM expected
    LEFT JOIN actual USING (
      trigger_name, table_name, function_namespace, function_name,
      argument_count, encoded_arguments
    )
    WHERE actual.oid IS NULL OR actual.tgenabled <> 'O' OR actual.tgtype <> 29
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'reporting_producers_enabled'
      AND procedure.provolatile = 'v'
  )
  AND (
    (
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'telegram_bot_settings'
         AND column_name IN (
           'daily_summary_enabled', 'reports_thread_id', 'daily_summary_time',
           'daily_summary_last_sent_period_start', 'daily_summary_last_sent_at'
         )) = 5
      AND EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = 'reporting_settings_projection_trigger'
          AND position('reporting.settings.changed.v1' IN pg_get_functiondef(procedure.oid)) > 0
          AND position('coreOperationalAlertsThreadId' IN pg_get_functiondef(procedure.oid)) > 0
      )
    )
    OR (
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'telegram_bot_settings'
         AND column_name IN (
           'daily_summary_enabled', 'reports_thread_id', 'daily_summary_time',
           'daily_summary_last_sent_period_start', 'daily_summary_last_sent_at'
         )) = 0
      AND EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = 'reporting_settings_projection_trigger'
          AND position(
            'reporting.core-operational-routing.changed.v1'
            IN pg_get_functiondef(procedure.oid)
          ) > 0
          AND position(
            'coreOperationalAlertsDestinationChatId'
            IN pg_get_functiondef(procedure.oid)
          ) > 0
          AND position('coreOperationalAlertsThreadId' IN pg_get_functiondef(procedure.oid)) > 0
          AND position('reporting.settings.changed.v1' IN pg_get_functiondef(procedure.oid)) = 0
          AND position('daily_summary_enabled' IN pg_get_functiondef(procedure.oid)) = 0
          AND position('reports_thread_id' IN pg_get_functiondef(procedure.oid)) = 0
          AND position('daily_summary_time' IN pg_get_functiondef(procedure.oid)) = 0
      )
    )
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'telegram_bot_settings'
      AND column_name = 'operational_alerts_thread_id'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reporting_producer_state'
      AND column_name = 'daily_summary_schedule_time'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reporting_producer_state'
      AND column_name = 'daily_summary_schedule_generation'
      AND data_type = 'bigint'
      AND is_nullable = 'NO'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint constraint_state
    JOIN pg_class relation ON relation.oid = constraint_state.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'reporting_producer_state'
      AND constraint_state.conname =
        'reporting_producer_state_daily_summary_schedule_time_check'
      AND constraint_state.convalidated
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint constraint_state
    JOIN pg_class relation ON relation.oid = constraint_state.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'reporting_producer_state'
      AND constraint_state.conname =
        'reporting_producer_state_schedule_generation_check'
      AND constraint_state.convalidated
  )
THEN 'ready' ELSE 'missing' END;
SQL
)"
	[[ "$state" == 'ready' ]] || {
		echo 'Core Reporting producer migration, singleton state, sequence, ledger or exact trigger set is missing.' >&2
		return 1
	}
}

reporting_require_core_producer_acl() {
	local state
	state="$(reporting_core_psql --tuples-only --no-align <<'SQL'
WITH expected_functions(signature) AS (
  VALUES
    ('public.reporting_producers_enabled()'),
    ('public.reporting_iso_timestamp(timestamp without time zone)'),
    ('public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)'),
    ('public.reporting_settings_projection_trigger()')
), resolved_functions AS (
  SELECT signature, to_regprocedure(signature) AS function_oid
  FROM expected_functions
)
SELECT CASE WHEN
  (SELECT count(*) FROM pg_roles WHERE rolname IN (
    'winwidget_api_runtime', 'winwidget_maintenance', 'winwidget_backup'
  )) = 3
  AND (SELECT count(*) FROM resolved_functions WHERE function_oid IS NOT NULL) = 4
  AND NOT EXISTS (
    SELECT 1
    FROM resolved_functions resolved
    JOIN pg_proc procedure ON procedure.oid = resolved.function_oid
    CROSS JOIN LATERAL aclexplode(
      COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
    ) privilege
    WHERE privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM resolved_functions resolved
    CROSS JOIN (VALUES
      ('winwidget_maintenance'),
      ('winwidget_backup')
    ) restricted_role(role_name)
    WHERE has_function_privilege(
      restricted_role.role_name,
      resolved.function_oid,
      'EXECUTE'
    )
  )
  AND has_table_privilege('winwidget_api_runtime', 'public.reporting_producer_state', 'SELECT')
  AND has_column_privilege(
    'winwidget_api_runtime',
    'public.reporting_producer_state',
    'daily_summary_schedule_time',
    'UPDATE'
  )
  AND has_column_privilege(
    'winwidget_api_runtime',
    'public.reporting_producer_state',
    'daily_summary_schedule_generation',
    'UPDATE'
  )
  AND has_column_privilege(
    'winwidget_api_runtime',
    'public.reporting_producer_state',
    'updated_at',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'winwidget_api_runtime',
    'public.reporting_producer_state',
    'daily_summary_owner',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'winwidget_api_runtime',
    'public.reporting_producer_state',
    'enabled',
    'UPDATE'
  )
  AND has_table_privilege('winwidget_api_runtime', 'public.reporting_projection_versions', 'SELECT')
  AND has_table_privilege('winwidget_api_runtime', 'public.reporting_projection_versions', 'INSERT')
  AND has_table_privilege('winwidget_api_runtime', 'public.reporting_projection_versions', 'UPDATE')
  AND has_table_privilege('winwidget_api_runtime', 'public.outbox_events', 'INSERT')
  AND has_sequence_privilege('winwidget_api_runtime', 'public.reporting_source_sequence', 'USAGE')
  AND has_function_privilege('winwidget_api_runtime', 'public.reporting_producers_enabled()', 'EXECUTE')
  AND has_function_privilege('winwidget_api_runtime', 'public.reporting_iso_timestamp(timestamp without time zone)', 'EXECUTE')
  AND has_function_privilege('winwidget_api_runtime', 'public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)', 'EXECUTE')
  AND has_function_privilege('winwidget_api_runtime', 'public.reporting_settings_projection_trigger()', 'EXECUTE')
  AND has_table_privilege('winwidget_maintenance', 'public.reporting_producer_state', 'SELECT')
  AND has_table_privilege('winwidget_backup', 'public.reporting_producer_state', 'SELECT')
  AND has_table_privilege('winwidget_backup', 'public.reporting_projection_versions', 'SELECT')
  AND has_sequence_privilege('winwidget_backup', 'public.reporting_source_sequence', 'SELECT')
THEN 'ready' ELSE 'unsafe' END;
SQL
)"
	[[ "$state" == 'ready' ]] || {
		echo 'Core Reporting producer runtime, maintenance or backup ACL is unsafe.' >&2
		return 1
	}
}

reporting_require_dark_service_ready() {
	local expected_revision="${1:-}"
	local container_id health scheduler_enabled process_role image_id image_revision response
	local attempt health_port
	health_port="$(reporting_get_env_value REPORTING_PORT)"
	[[ "$health_port" == '4600' && "$(reporting_get_env_value REPORTING_SCHEDULER_ENABLED)" == 'false' ]] || {
		echo 'Producer activation requires the phase-A Reporting service on port 4600 with scheduler disabled.' >&2
		return 1
	}
	for ((attempt = 1; attempt <= REPORTING_PRODUCER_HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
			scheduler_enabled="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')"
			process_role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_PROCESS_ROLE=//p')"
			image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
			image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
			response="$(curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:$health_port/health/ready" 2>/dev/null || true)"
			if [[ "$health" == 'healthy' && "$scheduler_enabled" == 'false' &&
				"$process_role" == 'all' && "$image_revision" =~ ^[0-9a-f]{40}$ &&
				( -z "$expected_revision" || "$image_revision" == "$expected_revision" ) ]] &&
				printf '%s' "$response" | grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$image_revision\""; then
				printf '%s\n' "$image_revision"
				return 0
			fi
		fi
		sleep "$REPORTING_PRODUCER_HEALTHCHECK_INTERVAL"
	done
	echo 'Reporting service is not ready as a dark consumer with scheduler disabled.' >&2
	return 1
}

reporting_require_outbox_publisher_ready() {
	local expected_revision="${1:-}"
	local container_id restart_count image_id image_revision service_name heartbeat_state
	container_id="$(reporting_compose ps --status running -q outbox-publisher 2>/dev/null || true)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || {
		echo 'Exactly one running core Outbox publisher is required before producer activation.' >&2
		return 1
	}
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
	service_name="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^MESSAGING_SERVICE_NAME=//p')"
	[[ "$restart_count" == '0' && "$image_revision" =~ ^[0-9a-f]{40}$ &&
		"$service_name" == 'outbox-publisher' &&
		( -z "$expected_revision" || "$image_revision" == "$expected_revision" ) ]] || {
		echo 'Core Outbox publisher process/revision/restart identity is unsafe.' >&2
		return 1
	}
	heartbeat_state="$(reporting_core_psql --tuples-only --no-align --command "
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM \"messaging_heartbeats\"
  WHERE \"service\" = 'outbox-publisher'
    AND \"last_seen_at\" > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
    AND NULLIF(\"metadata\"->>'lastSuccessfulPollAt', '')::TIMESTAMPTZ > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
) THEN 'fresh' ELSE 'stale' END;
")"
	[[ "$heartbeat_state" == 'fresh' ]] || {
		echo 'Core Outbox publisher heartbeat or successful-poll checkpoint is stale.' >&2
		return 1
	}
}

reporting_queue_matrix() {
	cat <<'EOF'
identityUser|winwidget.reporting.identity-user|identity.user.changed.v1
billingPayment|winwidget.reporting.billing-payment|billing.payment.changed.v1
billingSubscription|winwidget.reporting.billing-subscription|billing.subscription.changed.v1
widget|winwidget.reporting.widget|widgets.widget.changed.v1
lead|winwidget.reporting.lead|widgets.lead.changed.v1
reportingSettings|winwidget.reporting.settings|reporting.core-operational-routing.changed.v1
deliveryOutcome|winwidget.reporting.delivery-outcome|reporting.notification.delivery.outcome.v1
EOF
}

reporting_settings_topology_mode() {
	local legacy_column_count
	legacy_column_count="$(reporting_core_psql --tuples-only --no-align --command '
SELECT count(*)::TEXT
FROM information_schema.columns
WHERE table_schema = '"'"'public'"'"'
  AND table_name = '"'"'telegram_bot_settings'"'"'
  AND column_name IN (
    '"'"'daily_summary_enabled'"'"',
    '"'"'reports_thread_id'"'"',
    '"'"'daily_summary_time'"'"',
    '"'"'daily_summary_last_sent_period_start'"'"',
    '"'"'daily_summary_last_sent_at'"'"'
  );
')" || return 1
	[[ "$legacy_column_count" == '0' ]] || {
		echo "Core Reporting steady state requires zero legacy settings columns; got ${legacy_column_count:-unavailable}." >&2
		return 1
	}
	printf 'steady\n'
}

reporting_binding_count() {
	[[ $# == 4 ]] || return 1
	local bindings="$1" exchange="$2" queue="$3" routing_key="$4"
	printf '%s\n' "$bindings" | awk \
		-v exchange="$exchange" -v queue="$queue" -v routing_key="$routing_key" '
		$1 == exchange && $2 == queue && $3 == routing_key { count += 1 }
		END { print count + 0 }
	'
}

reporting_require_rabbitmq_topology() {
	local rabbitmq_container queues bindings kind queue routing_key retry_index
	local queue_line main_line settings_mode binding_count
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || {
		echo 'Exactly one running RabbitMQ container is required before producer activation.' >&2
		return 1
	}
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues -p winwidget name durable consumers)"
	bindings="$(docker exec "$rabbitmq_container" rabbitmqctl --silent list_bindings -p winwidget source_name destination_name routing_key)"
	settings_mode="$(reporting_settings_topology_mode)" || return 1

	while IFS='|' read -r kind queue routing_key; do
		[[ -n "$kind" ]] || continue
		main_line="$(printf '%s\n' "$queues" | grep -E "^${queue//./\.}[[:space:]]+true[[:space:]]+[1-9][0-9]*$" || true)"
		[[ -n "$main_line" && "$main_line" != *$'\n'* ]] || {
			echo "Reporting queue is missing, non-durable or has no active consumer: $queue" >&2
			return 1
		}
		binding_count="$(reporting_binding_count \
			"$bindings" winwidget.events "$queue" "$routing_key")" || return 1
		[[ "$binding_count" == '1' ]] || {
			echo "Reporting main binding is missing: $queue <- $routing_key" >&2
			return 1
		}
		if [[ "$kind" == 'reportingSettings' ]]; then
			[[ "$routing_key" == "$REPORTING_OPERATIONAL_ROUTING_KEY" ]] || {
				echo 'Reporting settings matrix lost the forward operational routing key.' >&2
				return 1
			}
			binding_count="$(reporting_binding_count \
				"$bindings" winwidget.events "$queue" \
				"$REPORTING_LEGACY_SETTINGS_ROUTING_KEY")" || return 1
			if [[ "$binding_count" != '0' ]]; then
				echo 'Reporting steady state still has the legacy settings binding.' >&2
				return 1
			fi
		fi
		if [[ "$kind" == 'deliveryOutcome' ]]; then
			binding_count="$(reporting_binding_count \
				"$bindings" winwidget.events "$queue" \
				'notification.delivery.outcome.v1')" || return 1
			[[ "$binding_count" == '0' ]] || {
				echo 'Reporting steady state still has the Core delivery outcome binding.' >&2
				return 1
			}
		fi
		queue_line="$(printf '%s\n' "$queues" | grep -E "^${queue//./\.}\.dead-letter[[:space:]]+true[[:space:]]+[0-9]+$" || true)"
		[[ -n "$queue_line" && "$queue_line" != *$'\n'* ]] || {
			echo "Reporting dead-letter queue is missing or non-durable: $queue.dead-letter" >&2
			return 1
		}
		printf '%s\n' "$bindings" | grep -Eq "^winwidget\.dead-letter[[:space:]]+${queue//./\.}\.dead-letter[[:space:]]+reporting\.${kind}\.dead-letter$" || {
			echo "Reporting dead-letter binding is missing for $kind." >&2
			return 1
		}
		for retry_index in 1 2 3; do
			queue_line="$(printf '%s\n' "$queues" | grep -E "^${queue//./\.}\.retry\.${retry_index}[[:space:]]+true[[:space:]]+[0-9]+$" || true)"
			[[ -n "$queue_line" && "$queue_line" != *$'\n'* ]] || {
				echo "Reporting retry queue is missing or non-durable: $queue.retry.$retry_index" >&2
				return 1
			}
			printf '%s\n' "$bindings" | grep -Eq "^winwidget\.reporting\.retry[[:space:]]+${queue//./\.}\.retry\.${retry_index}[[:space:]]+${kind}\.retry\.${retry_index}$" || {
				echo "Reporting retry binding is missing for $kind retry $retry_index." >&2
				return 1
			}
		done
	done < <(reporting_queue_matrix)
}

reporting_producer_state() {
	reporting_core_psql --tuples-only --no-align --field-separator='|' --command '
SELECT
  "enabled"::TEXT,
  COALESCE(to_char("activated_at" AT TIME ZONE '"'"'UTC'"'"', '"'"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"'"'), '"'"'never'"'"'),
  to_char("updated_at" AT TIME ZONE '"'"'UTC'"'"', '"'"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"'"'),
  COALESCE((SELECT MAX("source_sequence")::TEXT FROM "reporting_projection_versions"), '"'"'0'"'"'),
  (SELECT COUNT(*)::TEXT FROM "outbox_events" WHERE "event_type" IN (
    '"'"'reporting.core-operational-routing.changed.v1'"'"'
  ) AND "status" <> '"'"'PUBLISHED'"'"'::"OutboxEventStatus")
FROM "reporting_producer_state"
WHERE "id" = '"'"'singleton'"'"';
'
}

reporting_core_producer_bootstrap_state() {
	local relation_state lifecycle_state
	relation_state="$(reporting_core_psql --tuples-only --no-align --command \
		"SELECT CASE WHEN to_regclass('public.reporting_producer_state') IS NULL THEN 'absent' ELSE 'present' END;")"
	case "$relation_state" in
	absent)
		printf 'absent\n'
		return
		;;
	present) ;;
	*) return 1 ;;
	esac
	lifecycle_state="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE
  WHEN COUNT(*) FILTER (WHERE "id" = '"'"'singleton'"'"') <> 1 THEN '"'"'unsafe'"'"'
  WHEN bool_or("enabled") FILTER (WHERE "id" = '"'"'singleton'"'"') THEN '"'"'enabled'"'"'
  WHEN bool_and(
    NOT "enabled"
    AND "activated_at" IS NULL
    AND "daily_summary_owner" = '"'"'CORE'"'"'
    AND "daily_summary_switch_generation" = 0
    AND "daily_summary_switched_at" IS NULL
  ) FILTER (WHERE "id" = '"'"'singleton'"'"')
  AND NOT EXISTS (SELECT 1 FROM "reporting_projection_versions")
  AND NOT EXISTS (
    SELECT 1
    FROM "outbox_events"
    WHERE "event_type" IN (
      '"'"'reporting.core-operational-routing.changed.v1'"'"'
    )
  )
  AND (SELECT NOT "is_called" AND "last_value" = 1 FROM "reporting_source_sequence")
  THEN '"'"'never-activated'"'"'
  ELSE '"'"'historical'"'"'
END
FROM "reporting_producer_state";
')"
	[[ "$lifecycle_state" == 'enabled' ||
		"$lifecycle_state" == 'never-activated' ||
		"$lifecycle_state" == 'historical' ]] || return 1
	printf '%s\n' "$lifecycle_state"
}

reporting_producer_status() {
	local state enabled activated_at updated_at source_sequence pending_outbox
	reporting_require_core_producer_migration
	state="$(reporting_producer_state)"
	IFS='|' read -r enabled activated_at updated_at source_sequence pending_outbox <<<"$state"
	[[ "$enabled" == 'true' || "$enabled" == 'false' ]] || return 1
	printf 'enabled=%s\n' "$enabled"
	printf 'activated_at=%s\n' "$activated_at"
	printf 'updated_at=%s\n' "$updated_at"
	printf 'global_source_sequence_diagnostic=%s\n' "$source_sequence"
	printf 'pending_reporting_outbox=%s\n' "$pending_outbox"
	if reporting_require_dark_service_ready >/dev/null 2>&1 &&
		reporting_require_outbox_publisher_ready >/dev/null 2>&1 &&
		reporting_require_core_producer_acl >/dev/null 2>&1 &&
		reporting_require_rabbitmq_topology >/dev/null 2>&1 &&
		reporting_require_admin_audit_consumer_ready >/dev/null 2>&1; then
		printf 'phase_a_dependencies=ready\n'
	else
		printf 'phase_a_dependencies=not_ready\n'
	fi
	printf 'next_step=%s\n' "$(reporting_producer_next_step "$enabled" "$activated_at")"
}

reporting_producer_next_step() {
	[[ "$1" == 'true' || "$1" == 'false' ]] || return 1
	printf 'steady_state_no_cutover_action\n'
}

reporting_normalize_integration_kinds() {
	tr ',' '\n' <<<"$1" |
		sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		sed '/^$/d' |
		LC_ALL=C sort -u |
		paste -sd, -
}

reporting_require_admin_audit_consumer_ready() {
	local expected_revision="${1:-}"
	local app_revision bindings connection_name container_env container_hostname
	local consumer_state consumers expected_dead_letter_tag expected_main_tag
	local heartbeat_state image_id image_revision integration_container
	local integration_kinds queues rabbitmq_container restart_count retry_index
	local retry_queue runtime_hostname
	integration_container="$(
		reporting_compose ps --status running -q integration-worker 2>/dev/null || true
	)"
	[[ -n "$integration_container" && "$integration_container" != *$'\n'* ]] || {
		echo 'Exactly one running integration worker is required for Reporting audit.' >&2
		return 1
	}
	container_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$integration_container")"
	integration_kinds="$(printf '%s\n' "$container_env" | sed -n 's/^INTEGRATION_WORKER_KINDS=//p')"
	connection_name="$(printf '%s\n' "$container_env" | sed -n 's/^RABBITMQ_CONNECTION_NAME=//p')"
	app_revision="$(printf '%s\n' "$container_env" | sed -n 's/^APP_REVISION=//p')"
	[[ "$(reporting_normalize_integration_kinds "$integration_kinds")" == \
		"$(reporting_normalize_integration_kinds "$(reporting_expected_integration_worker_kinds)")" ]] || {
		echo 'Integration worker must own the exact Reporting admin audit consumer before producer activation.' >&2
		return 1
	}
	image_id="$(docker inspect --format '{{.Image}}' "$integration_container")"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$integration_container")"
	container_hostname="$(docker inspect --format '{{.Config.Hostname}}' "$integration_container")"
	runtime_hostname="$(docker exec "$integration_container" hostname)"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$image_revision" =~ ^[0-9a-f]{40}$ &&
		"$app_revision" == "$image_revision" &&
		"$restart_count" == '0' &&
		"$container_hostname" =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ &&
		"$runtime_hostname" == "$container_hostname" &&
		"$connection_name" == 'winwidget-integration-worker' &&
		( -z "$expected_revision" || "$image_revision" == "$expected_revision" ) ]] || {
		echo 'Integration worker runtime/image/restart identity is unsafe for Reporting audit.' >&2
		return 1
	}
	if [[ -n "$expected_revision" && ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]; then
		return 1
	fi
	rabbitmq_container="$(
		reporting_compose ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent \
			list_queues -p winwidget name durable consumers
	)"
	bindings="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent \
			list_bindings -p winwidget source_name destination_name routing_key
	)"
	consumers="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent \
			list_consumers -p winwidget queue_name consumer_tag ack_required \
			prefetch_count active
	)"
	expected_main_tag="$connection_name:$image_revision:$container_hostname:winwidget.admin.audit.reporting.v1"
	expected_dead_letter_tag="$expected_main_tag.dead-letter"
	consumer_state="$(
		printf '%s\n' "$consumers" |
			awk -v main_tag="$expected_main_tag" \
				-v dead_tag="$expected_dead_letter_tag" '
				$1 == "winwidget.admin.audit.reporting.v1" {
					main_total += 1
					if ($2 == main_tag && $3 == "true" && $4 ~ /^[1-9][0-9]*$/ &&
						$5 == "true") main_ready += 1
				}
				$1 == "winwidget.admin.audit.reporting.v1.dead-letter" {
					dead_total += 1
					if ($2 == dead_tag && $3 == "true" && $4 ~ /^[1-9][0-9]*$/ &&
						$5 == "true") dead_ready += 1
				}
				END {
					if (main_total == 1 && main_ready == 1 &&
						dead_total == 1 && dead_ready == 1) print "ready"
				}
			'
	)"
	[[ "$consumer_state" == 'ready' ]] || {
		echo 'Reporting admin audit consumers are not owned by the exact integration worker.' >&2
		return 1
	}
	printf '%s\n' "$queues" |
		grep -Eq '^winwidget\.admin\.audit\.reporting\.v1[[:space:]]+true[[:space:]]+1$' || return 1
	printf '%s\n' "$queues" |
		grep -Eq '^winwidget\.admin\.audit\.reporting\.v1\.dead-letter[[:space:]]+true[[:space:]]+1$' || return 1
	printf '%s\n' "$bindings" |
		grep -Eq '^winwidget\.events[[:space:]]+winwidget\.admin\.audit\.reporting\.v1[[:space:]]+admin\.audit\.reporting\.v1$' || return 1
	printf '%s\n' "$bindings" |
		grep -Eq '^winwidget\.events[[:space:]]+winwidget\.admin\.audit\.reporting\.v1[[:space:]]+manual\.reporting-admin-audit$' || return 1
	printf '%s\n' "$bindings" |
		grep -Eq '^winwidget\.manual-retry[[:space:]]+winwidget\.admin\.audit\.reporting\.v1[[:space:]]+reporting-admin-audit$' || return 1
	printf '%s\n' "$bindings" |
		grep -Eq '^winwidget\.dead-letter[[:space:]]+winwidget\.admin\.audit\.reporting\.v1\.dead-letter[[:space:]]+reporting-admin-audit\.dead-letter$' || return 1
	printf '%s\n' "$bindings" |
		grep -Eq '^winwidget\.events[[:space:]]+winwidget\.admin\.audit\.reporting\.v1\.dead-letter[[:space:]]+reporting-admin-audit\.dead-letter$' || return 1
	for retry_index in 1 2 3; do
		retry_queue="winwidget.admin.audit.reporting.v1.retry-v2.$retry_index"
		printf '%s\n' "$queues" |
			grep -Eq "^${retry_queue//./\.}[[:space:]]+true[[:space:]]+0$" || return 1
		printf '%s\n' "$bindings" |
			grep -Eq "^winwidget\\.retry[[:space:]]+${retry_queue//./\.}[[:space:]]+reporting-admin-audit\\.retry\\.$retry_index$" || return 1
	done
	heartbeat_state="$(reporting_core_psql --tuples-only --no-align --command "
SELECT CASE WHEN COUNT(*) = 1 THEN 'fresh' ELSE 'unsafe' END
FROM \"messaging_heartbeats\"
WHERE \"service\" = 'integration-worker'
  AND \"last_seen_at\" > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
  AND \"metadata\"->>'hostname' = '$container_hostname'
  AND \"metadata\"->>'pid' = '1';
")"
	[[ "$heartbeat_state" == 'fresh' ]] || {
		echo 'The exact integration worker heartbeat is missing or stale.' >&2
		return 1
	}
}

reporting_admin_audit_consumer_self_test() (
	local expected_revision='0123456789abcdef0123456789abcdef01234567'
	local test_app_revision="$expected_revision" test_heartbeat='fresh'
	local test_container_hostname='msk-1-vm-bzt3'
	local test_image_revision="$expected_revision"
	local test_integration_kinds test_main_consumers='1'
	local test_owner='exact' test_restart_count='0'
	local test_runtime_hostname="$test_container_hostname"
	test_integration_kinds='auto-renewal, reporting-admin-audit,campaign-admin-audit,notification-delivery-outcome,telegram-destination-unavailable,daily-summary-telegram,amo-crm,bitrix24,webhook'
	reporting_compose() {
		case "$*" in
		*'ps --status running -q integration-worker'*) printf 'integration-container\n' ;;
		*'ps --status running -q rabbitmq'*) printf 'rabbitmq-container\n' ;;
		*) return 1 ;;
		esac
	}
	docker() {
		local index tag
		case "$1" in
		inspect)
			if [[ "$3" == *'.Config.Env'* ]]; then
				printf 'INTEGRATION_WORKER_KINDS=%s\n' "$test_integration_kinds"
				printf 'RABBITMQ_CONNECTION_NAME=winwidget-integration-worker\n'
				printf 'APP_REVISION=%s\n' "$test_app_revision"
			elif [[ "$3" == *'.Image'* ]]; then
				printf 'sha256:%064d\n' 0
			elif [[ "$3" == *'.RestartCount'* ]]; then
				printf '%s\n' "$test_restart_count"
			elif [[ "$3" == *'.Config.Hostname'* ]]; then
				printf '%s\n' "$test_container_hostname"
			else
				return 1
			fi
			;;
		image)
			[[ "$2" == 'inspect' ]] || return 1
			printf '%s\n' "$test_image_revision"
			;;
		exec)
			case "$*" in
			*'integration-container hostname'*)
				printf '%s\n' "$test_runtime_hostname"
				;;
			*list_queues*)
				printf 'winwidget.admin.audit.reporting.v1\ttrue\t%s\n' "$test_main_consumers"
				printf 'winwidget.admin.audit.reporting.v1.dead-letter\ttrue\t1\n'
				for index in 1 2 3; do
					printf 'winwidget.admin.audit.reporting.v1.retry-v2.%s\ttrue\t0\n' "$index"
				done
				;;
			*list_bindings*)
				printf 'winwidget.events\twinwidget.admin.audit.reporting.v1\tadmin.audit.reporting.v1\n'
				printf 'winwidget.events\twinwidget.admin.audit.reporting.v1\tmanual.reporting-admin-audit\n'
				printf 'winwidget.manual-retry\twinwidget.admin.audit.reporting.v1\treporting-admin-audit\n'
				printf 'winwidget.dead-letter\twinwidget.admin.audit.reporting.v1.dead-letter\treporting-admin-audit.dead-letter\n'
				printf 'winwidget.events\twinwidget.admin.audit.reporting.v1.dead-letter\treporting-admin-audit.dead-letter\n'
				for index in 1 2 3; do
					printf 'winwidget.retry\twinwidget.admin.audit.reporting.v1.retry-v2.%s\treporting-admin-audit.retry.%s\n' "$index" "$index"
				done
				;;
			*list_consumers*)
				for ((index = 1; index <= test_main_consumers; index++)); do
					tag="winwidget-integration-worker:$test_image_revision:$test_container_hostname:winwidget.admin.audit.reporting.v1"
					if [[ "$test_owner" != 'exact' || "$index" -gt 1 ]]; then
						tag="orphan-worker:$test_image_revision:fedcba987654:winwidget.admin.audit.reporting.v1"
					fi
					printf 'winwidget.admin.audit.reporting.v1\t%s\ttrue\t10\ttrue\n' "$tag"
				done
				printf 'winwidget.admin.audit.reporting.v1.dead-letter\twinwidget-integration-worker:%s:%s:winwidget.admin.audit.reporting.v1.dead-letter\ttrue\t10\ttrue\n' "$test_image_revision" "$test_container_hostname"
				;;
			*) return 1 ;;
			esac
			;;
		*) return 1 ;;
		esac
	}
	reporting_core_psql() {
		printf '%s\n' "$test_heartbeat"
	}
	reporting_require_admin_audit_consumer_ready "$expected_revision"
	for test_main_consumers in 0 2; do
		if reporting_require_admin_audit_consumer_ready "$expected_revision" \
			>/dev/null 2>&1; then
			echo "Reporting audit consumer self-test accepted consumers=$test_main_consumers." >&2
			return 1
		fi
	done
	test_main_consumers='1'
	test_owner='orphan'
	if reporting_require_admin_audit_consumer_ready "$expected_revision" \
		>/dev/null 2>&1; then
		echo 'Reporting audit consumer self-test accepted an orphan queue owner.' >&2
		return 1
	fi
	test_owner='exact'
	test_runtime_hostname='different-host'
	if reporting_require_admin_audit_consumer_ready "$expected_revision" \
		>/dev/null 2>&1; then
		echo 'Reporting audit consumer self-test accepted mismatched runtime metadata.' >&2
		return 1
	fi
	test_runtime_hostname="$test_container_hostname"
	test_image_revision='fedcba9876543210fedcba9876543210fedcba98'
	if reporting_require_admin_audit_consumer_ready "$expected_revision" \
		>/dev/null 2>&1; then
		echo 'Reporting audit consumer self-test accepted the wrong worker revision.' >&2
		return 1
	fi
	test_image_revision="$expected_revision"
	test_heartbeat='unsafe'
	if reporting_require_admin_audit_consumer_ready "$expected_revision" \
		>/dev/null 2>&1; then
		echo 'Reporting audit consumer self-test accepted a stale worker heartbeat.' >&2
		return 1
	fi
	test_heartbeat='fresh'
	test_restart_count='1'
	if reporting_require_admin_audit_consumer_ready "$expected_revision" \
		>/dev/null 2>&1; then
		echo 'Reporting audit consumer self-test accepted a restarted worker.' >&2
		return 1
	fi
)

reporting_producer_lifecycle_self_test() {
	[[ "$(reporting_producer_next_step true)" == 'steady_state_no_cutover_action' &&
		"$(reporting_producer_next_step false)" == 'steady_state_no_cutover_action' ]]
	! reporting_producer_next_step invalid >/dev/null 2>&1
	reporting_admin_audit_consumer_self_test
	(
		reporting_core_psql() { printf '0\n'; }
		[[ "$(reporting_settings_topology_mode)" == 'steady' ]]
		reporting_core_psql() { printf '5\n'; }
		! reporting_settings_topology_mode >/dev/null 2>&1
	)
	local migration_text acl_text main_text
	migration_text="$(declare -f reporting_require_core_producer_migration)"
	acl_text="$(declare -f reporting_require_core_producer_acl)"
	main_text="$(declare -f reporting_producer_lifecycle_main)"
	[[ "$migration_text" == *"(SELECT count(*) FROM expected) = 1"* &&
		"$migration_text" == *"(SELECT count(*) FROM actual) = 1"* &&
		"$migration_text" == *"'reporting_settings_projection'"* &&
		"$migration_text" != *"'reporting_user_projection'"* &&
		"$migration_text" != *"'reporting_auth_identity_projection'"* &&
		"$acl_text" == *'function_oid IS NOT NULL) = 4'* &&
		"$acl_text" == *'reporting_settings_projection_trigger()'* &&
		"$acl_text" != *'reporting_emit_user_projection'* &&
		"$main_text" == *'status)'* &&
		"$main_text" != *'enable)'* && "$main_text" != *'disable)'* &&
		"$main_text" != *'reset)'* ]] || return 1
	printf 'reporting_producer_lifecycle_self_test=passed\n'
}
reporting_producer_lifecycle_main() {
	local action="${1:-}"
	local revision key
	case "$action" in
	--self-test)
		[[ $# == 1 ]] || return 1
		reporting_producer_lifecycle_self_test
		return
		;;
	status)
		[[ $# == 1 ]] || return 1
		;;
	*)
		echo "Usage: $0 status | $0 --self-test" >&2
		return 1
		;;
	esac
	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting producer lifecycle must run as root.' >&2
		return 1
	}
	revision="$(git -C "$server_root" rev-parse HEAD)"
	reporting_export_pinned_runtime_identity "$revision"
	reporting_validate_production_files
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	for key in DATABASE_URL_PRODUCTION DATABASE_MIGRATION_URL_PRODUCTION \
		MAINTENANCE_DATABASE_URL_PRODUCTION DATABASE_BACKUP_URL; do
		reporting_require_env_key "$key"
	done
	for key in REPORTING_PORT REPORTING_SCHEDULER_ENABLED; do
		reporting_require_env_key "$key"
	done
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
	reporting_producer_status
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	reporting_producer_lifecycle_main "$@"
fi
