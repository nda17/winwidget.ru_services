#!/usr/bin/env bash

# Widgets has no file-based phase machine. The only durable ownership marker is
# widgets.service_identity in the dedicated PostgreSQL database.

WIDGETS_CANONICAL_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS='telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,auto-renewal'
WIDGETS_CANONICAL_RABBITMQ_CONFIGURE_PATTERN='^(winwidget\.widgets(\..*)?|winwidget\.lead-integration\.(webhook|bitrix24|amo-crm)(\.(dead-letter|retry\.[1-3]))?)$'
WIDGETS_CANONICAL_RABBITMQ_WRITE_PATTERN='^(winwidget\.(events|dead-letter)|winwidget\.widgets(\..*)?|winwidget\.lead-integration\.(webhook|bitrix24|amo-crm)(\.(dead-letter|retry\.[1-3]))?)$'
WIDGETS_CANONICAL_RABBITMQ_READ_PATTERN='^(winwidget\.(events|dead-letter)|winwidget\.widgets(\..*)?|winwidget\.lead-integration\.(webhook|bitrix24|amo-crm)(\.(dead-letter|retry\.[1-3]))?)$'
WIDGETS_CANONICAL_EVENTS_TOPIC_WRITE='^(widgets\.(widget|lead)\.changed\.v1|lead\.(integration\.(email|telegram|webhook|bitrix24|amo-crm)|limit\.reached\.(email|telegram))\.v2|admin\.audit\.widgets\.v1)$'
WIDGETS_CANONICAL_EVENTS_TOPIC_READ='^(identity\.user\.changed\.v1|billing\.subscription\.changed\.v1|lead\.integration\.(webhook|bitrix24|amo-crm)\.v2)$'
WIDGETS_CANONICAL_DEAD_LETTER_TOPIC='^widgets\.(identity|entitlement|webhook|bitrix24|amo-crm)\.dead-letter$'
WIDGETS_CANONICAL_SOURCE_FREEZE_SERVICES=(integration-worker)
WIDGETS_CANONICAL_PROJECTION_BINDINGS=(
	'winwidget.widgets.identity-user|identity.user.changed.v1'
	'winwidget.widgets.billing-subscription|billing.subscription.changed.v1'
)
WIDGETS_CANONICAL_PROVIDER_QUEUES=(
	winwidget.lead-integration.webhook
	winwidget.lead-integration.bitrix24
	winwidget.lead-integration.amo-crm
)
WIDGETS_CANONICAL_CORE_TABLES=(
	widgets
	quizzes
	callbacks
	countdown_timers
	stop_offers
	online_consultants
	calculators
	leads
	quiz_leads
	callback_leads
	countdown_timer_leads
	stop_offer_leads
	online_consultant_leads
	calculator_leads
	widget_config_revisions
	widget_runtime_presence
	widget_runtime_daily_metrics
	widget_runtime_daily_step_metrics
)

widgets_export_compose_release_identity() {
	local revision="${1:-}"
	[[ "$#" -eq 1 && "$revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo 'Widgets Compose release identity requires an exact lowercase Git SHA.' >&2
		return 1
	}

	# Docker Compose interpolates the complete production model even for a
	# targeted Widgets command. Unrelated service references are parse-only;
	# Widgets deployment commands never operate on those services.
	export APP_REVISION="$revision"
	export APP_VERSION="git-$revision"
	export MAINTENANCE_REVISION="$revision"
	export MAINTENANCE_IMAGE="winwidget-maintenance:git-$revision"
	export DATABASE_RESTORE_REVISION="$revision"
	export DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$revision"
	export NOTIFICATION_DELIVERY_REVISION="$revision"
	export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$revision"
	export CAMPAIGNS_REVISION="$revision"
	export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$revision"
	export REPORTING_REVISION="$revision"
	export REPORTING_IMAGE="winwidget-reporting:git-$revision"
	export WIDGETS_REVISION="$revision"
	export WIDGETS_IMAGE="winwidget-widgets:git-$revision"
}

widgets_canonical_provider_target_queue_names() {
	local queue retry_index
	for queue in "${WIDGETS_CANONICAL_PROVIDER_QUEUES[@]}"; do
		printf '%s\n%s.dead-letter\n' "$queue" "$queue"
		for retry_index in 1 2 3; do
			printf '%s.retry.%s\n' "$queue" "$retry_index"
		done
	done
}

widgets_canonical_provider_legacy_queue_names() {
	local queue retry_index
	for queue in "${WIDGETS_CANONICAL_PROVIDER_QUEUES[@]}"; do
		printf '%s\n%s.dead-letter\n' "$queue" "$queue"
		for retry_index in 1 2 3; do
			printf '%s.retry-v2.%s\n' "$queue" "$retry_index"
		done
	done
}

widgets_rabbitmq_projection_topology_is_ready() {
	[[ $# == 2 ]] || return 1
	local queues="$1" bindings="$2" contract queue routing_key
	local queue_count binding_count
	for contract in "${WIDGETS_CANONICAL_PROJECTION_BINDINGS[@]}"; do
		queue="${contract%%|*}"
		routing_key="${contract##*|}"
		queue_count="$(awk -F '\t' -v queue="$queue" \
			'$1 == queue { count += 1 } END { print count + 0 }' <<<"$queues")" || return 1
		binding_count="$(awk -v exchange='winwidget.events' -v queue="$queue" \
			-v routing_key="$routing_key" \
			'$1 == exchange && $2 == queue && $3 == routing_key { count += 1 } END { print count + 0 }' \
			<<<"$bindings")" || return 1
		[[ "$queue_count" == '1' && "$binding_count" == '1' ]] || return 1
	done
}

widgets_rabbitmq_provider_namespace_is_exact() {
	[[ $# == 1 ]] || return 1
	local listing="$1" expected actual
	expected="$(widgets_canonical_provider_target_queue_names | LC_ALL=C sort -u)" || return 1
	actual="$(awk -F '\t' '
    $1 ~ /^winwidget\.lead-integration\.(webhook|bitrix24|amo-crm)(\.|$)/ { print $1 }
  ' <<<"$listing" | LC_ALL=C sort -u)" || return 1
	[[ -n "$expected" && "$actual" == "$expected" ]]
}

widgets_rabbitmq_provider_transition_is_drained() {
	[[ $# == 1 ]] || return 1
	local listing="$1" allowed queue count allowed_count seen=''
	allowed="$({
		widgets_canonical_provider_target_queue_names
		widgets_canonical_provider_legacy_queue_names
	} | LC_ALL=C sort -u)" || return 1
	allowed_count="$(wc -l <<<"$allowed" | tr -d '[:space:]')" || return 1
	[[ "$allowed_count" == '24' ]] || return 1
	count=0
	while IFS=$'\t' read -r queue ready unacknowledged consumers; do
		[[ -n "$queue" ]] || continue
		grep -Fqx -- "$queue" <<<"$allowed" || return 1
		if [[ -n "$seen" ]] && grep -Fqx -- "$queue" <<<"$seen"; then
			return 1
		fi
		seen="${seen}${seen:+$'\n'}${queue}"
		[[ "$ready|$unacknowledged|$consumers" == '0|0|0' ]] || return 1
		count=$((count + 1))
	done < <(awk -F '\t' '
    $1 ~ /^winwidget\.lead-integration\.(webhook|bitrix24|amo-crm)(\.|$)/ { print }
  ' <<<"$listing")
	((count <= allowed_count))
}

widgets_cutover_projection_boundary_is_safe() {
	[[ $# == 1 && "$1" == 'true' ]]
}

widgets_cutover_provider_replacement_is_safe() {
	[[ $# == 3 && "$1" == 'true' && "$2" == 'true' && "$3" == 'true' ]]
}

widgets_cutover_post_publisher_namespace_is_safe() {
	[[ $# == 3 && "$1" == 'true' && "$2" == 'true' ]] || return 1
	widgets_rabbitmq_provider_namespace_is_exact "$3"
}

widgets_core_write_fence_install_sql() {
	cat <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5min';
SET LOCAL statement_timeout = '10min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.widgets.write-fence.v1'));

DO $guard$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Widgets write-fence relation is missing: %', relation_name;
    END IF;
  END LOOP;
END
$guard$;

LOCK TABLE
  public.widgets,
  public.quizzes,
  public.callbacks,
  public.countdown_timers,
  public.stop_offers,
  public.online_consultants,
  public.calculators,
  public.leads,
  public.quiz_leads,
  public.callback_leads,
  public.countdown_timer_leads,
  public.stop_offer_leads,
  public.online_consultant_leads,
  public.calculator_leads,
  public.widget_config_revisions,
  public.widget_runtime_presence,
  public.widget_runtime_daily_metrics,
  public.widget_runtime_daily_step_metrics
IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.widgets_cutover_reject_legacy_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $fence$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Widgets ownership cutover write fence is active',
    DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  RETURN NULL;
END
$fence$;
REVOKE ALL ON FUNCTION public.widgets_cutover_reject_legacy_write() FROM PUBLIC;

DO $install$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS widgets_cutover_write_fence ON public.%I',
      relation_name
    );
    EXECUTE format(
      'CREATE TRIGGER widgets_cutover_write_fence '
      'BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.widgets_cutover_reject_legacy_write()',
      relation_name
    );
  END LOOP;
END
$install$;

DO $verify$
DECLARE
  expected_count INTEGER;
  actual_count INTEGER;
BEGIN
  SELECT count(*) INTO expected_count
  FROM unnest(ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ]) AS expected(relation_name);
  SELECT count(*) INTO actual_count
  FROM pg_trigger trigger
  JOIN pg_class relation ON relation.oid = trigger.tgrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND trigger.tgname = 'widgets_cutover_write_fence'
    AND NOT trigger.tgisinternal
    AND trigger.tgtype = 62
    AND trigger.tgfoid = to_regprocedure(
      'public.widgets_cutover_reject_legacy_write()'
    );
  IF expected_count <> 18 OR actual_count <> expected_count OR EXISTS (
    SELECT 1
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND trigger.tgname = 'widgets_cutover_write_fence'
      AND NOT trigger.tgisinternal
      AND relation.relname <> ALL (ARRAY[
        'widgets','quizzes','callbacks','countdown_timers','stop_offers',
        'online_consultants','calculators','leads','quiz_leads','callback_leads',
        'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
        'calculator_leads','widget_config_revisions','widget_runtime_presence',
        'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
      ])
  ) THEN
    RAISE EXCEPTION 'Widgets write-fence trigger set is invalid';
  END IF;
END
$verify$;
COMMIT;
SQL
}

widgets_core_write_fence_drop_statements() {
	cat <<'SQL'
DO $drop$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS widgets_cutover_write_fence ON public.%I',
        relation_name
      );
    END IF;
  END LOOP;
END
$drop$;
DROP FUNCTION IF EXISTS public.widgets_cutover_reject_legacy_write();
DO $verify_drop$
BEGIN
  IF to_regprocedure('public.widgets_cutover_reject_legacy_write()') IS NOT NULL OR
     EXISTS (
       SELECT 1 FROM pg_trigger trigger
       JOIN pg_class relation ON relation.oid = trigger.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND trigger.tgname = 'widgets_cutover_write_fence'
         AND NOT trigger.tgisinternal
     ) THEN
    RAISE EXCEPTION 'Widgets write fence remains after removal';
  END IF;
END
$verify_drop$;
SQL
}

widgets_core_write_fence_remove_sql() {
	cat <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5min';
SET LOCAL statement_timeout = '10min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.widgets.write-fence.v1'));
SQL
	widgets_core_write_fence_drop_statements
	printf 'COMMIT;\n'
}

widgets_should_restore_pre_forward_source() {
	[[ "$#" -eq 3 ]] || return 2
	local source_frozen="$1"
	local forward_only="$2"
	local snapshot_locked="$3"
	[[ "$source_frozen" =~ ^(true|false)$ &&
		"$forward_only" =~ ^(true|false)$ &&
		"$snapshot_locked" =~ ^(true|false)$ ]] || return 2
	[[ "$source_frozen" == 'true' && "$forward_only" == 'false' &&
		"$snapshot_locked" == 'false' ]]
}

widgets_lifecycle_env_file() {
	printf '%s\n' "${ENV_FILE:-${APP_ROOT:-/opt/winwidget}/deploy/backend/.env.production}"
}

widgets_lifecycle_get_env_value() {
	local key="$1"
	local env_file
	env_file="$(widgets_lifecycle_env_file)"
	[[ -f "$env_file" && ! -L "$env_file" ]] || return 1
	awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)
			if (name == key) {
				print value
				found += 1
			}
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$env_file"
}

widgets_lifecycle_libpq_url() {
	local raw_url="$1"
	local base_url
	local query
	local parameter
	local key
	local separator='?'
	[[ -n "$raw_url" ]] || return 1
	if [[ "$raw_url" != *'?'* ]]; then
		printf '%s' "$raw_url"
		return
	fi
	base_url="${raw_url%%\?*}"
	query="${raw_url#*\?}"
	printf '%s' "$base_url"
	while IFS= read -r parameter; do
		[[ -n "$parameter" ]] || continue
		key="${parameter%%=*}"
		case "$key" in
		schema | connection_limit | pool_timeout | pgbouncer | statement_cache_size) continue ;;
		esac
		printf '%s%s' "$separator" "$parameter"
		separator='&'
	done < <(tr '&' '\n' <<<"$query")
}

widgets_service_identity_state() {
	local database_url postgres_image query result volume
	database_url="$(widgets_lifecycle_get_env_value WIDGETS_DATABASE_URL 2>/dev/null || true)"
	volume="$(widgets_lifecycle_get_env_value WIDGETS_POSTGRES_DATA_VOLUME 2>/dev/null || true)"
	if [[ -z "$database_url" ]]; then
		if [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; then
			echo 'Widgets PostgreSQL volume exists but WIDGETS_DATABASE_URL is unavailable.' >&2
			return 1
		fi
		printf 'absent\n'
		return
	fi
	database_url="$(widgets_lifecycle_libpq_url "$database_url")" || return 1
	postgres_image="$(widgets_lifecycle_get_env_value WIDGETS_POSTGRES_IMAGE 2>/dev/null || true)"
	postgres_image="${postgres_image:-$WIDGETS_CANONICAL_POSTGRES_IMAGE}"
	query=$'SELECT CASE\n'
	query+=$'  WHEN count(*) = 1\n'
	query+=$'    AND bool_and(ownership_activated_at IS NOT NULL)\n'
	query+=$'    AND bool_and(handoff_started_at IS NOT NULL)\n'
	query+=$'    AND bool_and(ownership_generation > 0)\n'
	query+=$'    AND bool_and(source_database_fingerprint ~ \'^[0-9a-f]{64}$\')\n'
	query+=$'    AND bool_and(source_exported_at IS NOT NULL)\n'
	query+=$'    AND bool_and(source_snapshot_sha256 ~ \'^[0-9a-f]{64}$\')\n'
	query+=$'    AND bool_and(jsonb_typeof(source_snapshot_counts) = \'object\')\n'
	query+=$'    AND bool_and(source_reporting_high_water >= 0)\n'
	query+=$'  THEN \'active\'\n'
	query+=$'  WHEN count(*) = 1\n'
	query+=$'    AND bool_and(ownership_activated_at IS NULL)\n'
	query+=$'    AND bool_and(handoff_started_at IS NOT NULL)\n'
	query+=$'    AND bool_and(ownership_generation = 0)\n'
	query+=$'    AND bool_and(source_database_fingerprint ~ \'^[0-9a-f]{64}$\')\n'
	query+=$'    AND bool_and(source_exported_at IS NOT NULL)\n'
	query+=$'    AND bool_and(source_snapshot_sha256 ~ \'^[0-9a-f]{64}$\')\n'
	query+=$'    AND bool_and(jsonb_typeof(source_snapshot_counts) = \'object\')\n'
	query+=$'    AND bool_and(source_reporting_high_water >= 0)\n'
	query+=$'  THEN \'handoff\'\n'
	query+=$'  WHEN count(*) = 1\n'
	query+=$'    AND bool_and(ownership_activated_at IS NULL)\n'
	query+=$'    AND bool_and(handoff_started_at IS NULL)\n'
	query+=$'    AND bool_and(ownership_generation = 0)\n'
	query+=$'  THEN \'inactive\'\n'
	query+=$'  ELSE \'invalid\'\n'
	query+=$'END\n'
	query+=$'FROM widgets.service_identity\n'
	query+=$'WHERE id = \'widgets-service\';'
	if result="$(
		PGURL="$database_url" WIDGETS_IDENTITY_SQL="$query" \
			docker run --rm --network host -e PGURL -e WIDGETS_IDENTITY_SQL \
			--entrypoint sh "$postgres_image" -euc '
				exec psql "$PGURL" --no-psqlrc --tuples-only --no-align \
					--set ON_ERROR_STOP=1 --command "$WIDGETS_IDENTITY_SQL"
			' 2>/dev/null
	)"; then
		case "$result" in
		active | handoff | inactive) printf '%s\n' "$result" ;;
		*)
			echo 'Widgets service_identity is invalid.' >&2
			return 1
			;;
		esac
		return
	fi
	if [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; then
		echo 'Widgets PostgreSQL exists but service_identity cannot be read; failing closed.' >&2
		return 1
	fi
	printf 'absent\n'
}

widgets_full_deploy_action() {
	local automatic_push="$1"
	local state="${2:-}"
	[[ "$automatic_push" =~ ^(true|false)$ ]] || return 1
	if [[ -z "$state" ]]; then
		state="$(widgets_service_identity_state)" || return 1
	fi
	case "$state" in
	active) printf 'deploy\n' ;;
	absent | inactive | handoff)
		if [[ "$automatic_push" == 'true' ]]; then
			printf 'defer\n'
		else
			printf 'block\n'
		fi
		;;
	*) return 1 ;;
	esac
}

widgets_guard_checkout_revision() {
	local expected_revision="$1"
	local guard_action="${2:---guard-before-checkout-revision}"
	local server_root="${APP_ROOT:-/opt/winwidget}/winwidget.ru_server"
	local state
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
		"$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || return 1
	state="$(widgets_service_identity_state)" || return 1
	if [[ ( "$state" == 'active' || "$state" == 'handoff' ) &&
		"$guard_action" == '--guard-before-checkout-revision' ]]; then
		git -C "$server_root" cat-file -e \
			"$expected_revision:scripts/widgets-database-lifecycle.sh" 2>/dev/null || {
			echo 'Target revision would remove the active Widgets ownership guard.' >&2
			return 1
		}
	fi
}

widgets_lifecycle_self_test() {
	local table_name projection_queues projection_bindings provider_target_listing
	local provider_polluted_listing provider_transition_listing
	local revision='0123456789abcdef0123456789abcdef01234567'
	(
		local compose_file compose_release_key compose_release_value
		local compose_release_count=0
		unset APP_REVISION APP_VERSION \
			MAINTENANCE_REVISION MAINTENANCE_IMAGE \
			DATABASE_RESTORE_REVISION DATABASE_RESTORE_IMAGE \
			NOTIFICATION_DELIVERY_REVISION NOTIFICATION_DELIVERY_IMAGE \
			CAMPAIGNS_REVISION CAMPAIGNS_IMAGE \
			REPORTING_REVISION REPORTING_IMAGE \
			WIDGETS_REVISION WIDGETS_IMAGE
		widgets_export_compose_release_identity "$revision"
		[[ "$APP_REVISION" == "$revision" &&
			"$APP_VERSION" == "git-$revision" &&
			"$MAINTENANCE_REVISION" == "$revision" &&
			"$MAINTENANCE_IMAGE" == "winwidget-maintenance:git-$revision" &&
			"$DATABASE_RESTORE_REVISION" == "$revision" &&
			"$DATABASE_RESTORE_IMAGE" == "winwidget-database-restore:git-$revision" &&
			"$NOTIFICATION_DELIVERY_REVISION" == "$revision" &&
			"$NOTIFICATION_DELIVERY_IMAGE" == "winwidget-notification-delivery:git-$revision" &&
			"$CAMPAIGNS_REVISION" == "$revision" &&
			"$CAMPAIGNS_IMAGE" == "winwidget-campaigns:git-$revision" &&
			"$REPORTING_REVISION" == "$revision" &&
			"$REPORTING_IMAGE" == "winwidget-reporting:git-$revision" &&
			"$WIDGETS_REVISION" == "$revision" &&
			"$WIDGETS_IMAGE" == "winwidget-widgets:git-$revision" ]]
		compose_file="$(
			cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
			pwd
		)/deploy/docker-compose.prod.yml"
		[[ -f "$compose_file" && ! -L "$compose_file" ]]
		while IFS= read -r compose_release_key; do
			[[ -n "$compose_release_key" ]] || continue
			compose_release_count=$((compose_release_count + 1))
			compose_release_value="${!compose_release_key-}"
			case "$compose_release_key" in
			*_REVISION) [[ "$compose_release_value" == "$revision" ]] ;;
			*_IMAGE) [[ "$compose_release_value" == *":git-$revision" ]] ;;
			*) return 1 ;;
			esac
		done < <(
			grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}' "$compose_file" |
				sed -E 's/^\$\{//; s/:\?.*$//' |
				grep -E '(_REVISION|_IMAGE)$' |
				grep -Ev '_POSTGRES_IMAGE$' |
				LC_ALL=C sort -u
		)
		((compose_release_count >= 10))
	) || {
		echo 'Widgets lifecycle self-test did not derive the complete Compose release identity.' >&2
		return 1
	}
	if widgets_export_compose_release_identity "${revision}x" >/dev/null 2>&1; then
		echo 'Widgets lifecycle self-test accepted a non-SHA Compose release identity.' >&2
		return 1
	fi
	[[ "${#WIDGETS_CANONICAL_SOURCE_FREEZE_SERVICES[@]}" == '1' &&
		"${WIDGETS_CANONICAL_SOURCE_FREEZE_SERVICES[0]}" == 'integration-worker' ]]
	[[ "${#WIDGETS_CANONICAL_CORE_TABLES[@]}" == '18' ]]
	[[ "$(printf '%s\n' "${WIDGETS_CANONICAL_CORE_TABLES[@]}" |
		LC_ALL=C sort -u | wc -l | tr -d '[:space:]')" == '18' ]]
	for table_name in "${WIDGETS_CANONICAL_CORE_TABLES[@]}"; do
		[[ "$table_name" =~ ^[a-z][a-z0-9_]*$ ]]
	done
	[[ "$(widgets_full_deploy_action true active)" == 'deploy' ]]
	[[ "$(widgets_full_deploy_action false active)" == 'deploy' ]]
	[[ "$(widgets_full_deploy_action true absent)" == 'defer' ]]
	[[ "$(widgets_full_deploy_action true inactive)" == 'defer' ]]
	[[ "$(widgets_full_deploy_action true handoff)" == 'defer' ]]
	[[ "$(widgets_full_deploy_action false absent)" == 'block' ]]
	[[ "$(widgets_full_deploy_action false inactive)" == 'block' ]]
	[[ "$(widgets_full_deploy_action false handoff)" == 'block' ]]
	[[ "$(widgets_lifecycle_libpq_url \
		'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?schema=widgets&sslmode=require&application_name=widgets')" == \
		'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?sslmode=require&application_name=widgets' ]]
	[[ "$(widgets_lifecycle_libpq_url \
		'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?schema=widgets&connection_limit=5')" == \
		'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets' ]]
	! widgets_full_deploy_action invalid active >/dev/null 2>&1
	! widgets_full_deploy_action true invalid >/dev/null 2>&1
	[[ "$WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS" == *'widgets-admin-audit'* &&
		"$WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS" != *'webhook'* &&
		"$WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS" != *'bitrix24'* &&
		"$WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS" != *'amo-crm'* ]]
	[[ 'winwidget.lead-integration.webhook' =~ $WIDGETS_CANONICAL_RABBITMQ_CONFIGURE_PATTERN ]]
	[[ 'winwidget.lead-integration.bitrix24.retry.3' =~ $WIDGETS_CANONICAL_RABBITMQ_WRITE_PATTERN ]]
	[[ 'winwidget.lead-integration.amo-crm.dead-letter' =~ $WIDGETS_CANONICAL_RABBITMQ_READ_PATTERN ]]
	[[ 'lead.integration.email.v2' =~ $WIDGETS_CANONICAL_EVENTS_TOPIC_WRITE ]]
	[[ 'lead.integration.telegram.v2' =~ $WIDGETS_CANONICAL_EVENTS_TOPIC_WRITE ]]
	[[ 'identity.user.changed.v1' =~ $WIDGETS_CANONICAL_EVENTS_TOPIC_READ ]]
	[[ 'widgets.webhook.dead-letter' =~ $WIDGETS_CANONICAL_DEAD_LETTER_TOPIC ]]
	[[ ! 'winwidget.payment.auto-renewal' =~ $WIDGETS_CANONICAL_RABBITMQ_READ_PATTERN ]]
	[[ "${#WIDGETS_CANONICAL_PROJECTION_BINDINGS[@]}" == '2' &&
		"${#WIDGETS_CANONICAL_PROVIDER_QUEUES[@]}" == '3' ]]
	projection_queues=$'winwidget.widgets.identity-user\t0\t0\t0\nwinwidget.widgets.billing-subscription\t0\t0\t0'
	projection_bindings=$'winwidget.events\twinwidget.widgets.identity-user\tidentity.user.changed.v1\nwinwidget.events\twinwidget.widgets.billing-subscription\tbilling.subscription.changed.v1'
	widgets_rabbitmq_projection_topology_is_ready \
		"$projection_queues" "$projection_bindings"
	! widgets_rabbitmq_projection_topology_is_ready \
		"$projection_queues" "${projection_bindings%%$'\n'*}"
	widgets_cutover_projection_boundary_is_safe true
	! widgets_cutover_projection_boundary_is_safe false
	provider_target_listing="$(widgets_canonical_provider_target_queue_names |
		awk '{ print $0 "\t0\t0\t0" }')"
	[[ "$(wc -l <<<"$provider_target_listing" | tr -d '[:space:]')" == '15' ]]
	widgets_rabbitmq_provider_namespace_is_exact "$provider_target_listing"
	provider_polluted_listing="$provider_target_listing"$'\nwinwidget.lead-integration.webhook.retry-v2.1\t0\t0\t0'
	! widgets_rabbitmq_provider_namespace_is_exact "$provider_polluted_listing"
	provider_transition_listing="$({
		widgets_canonical_provider_target_queue_names
		widgets_canonical_provider_legacy_queue_names
	} | LC_ALL=C sort -u | awk '{ print $0 "\t0\t0\t0" }')"
	[[ "$(wc -l <<<"$provider_transition_listing" | tr -d '[:space:]')" == '24' ]]
	widgets_rabbitmq_provider_transition_is_drained "$provider_transition_listing"
	widgets_rabbitmq_provider_transition_is_drained "$provider_polluted_listing"
	widgets_rabbitmq_provider_transition_is_drained ''
	widgets_rabbitmq_provider_transition_is_drained \
		"$(awk -F '\t' '$1 != "winwidget.lead-integration.webhook.retry.1"' <<<"$provider_transition_listing")"
	! widgets_rabbitmq_provider_transition_is_drained \
		"${provider_transition_listing/amo-crm.retry-v2.3$'\t0\t0\t0'/amo-crm.retry-v2.3$'\t1\t0\t0'}"
	! widgets_rabbitmq_provider_transition_is_drained \
		"${provider_transition_listing/webhook.retry.1$'\t0\t0\t0'/webhook.retry.1$'\t0\t0\t1'}"
	! widgets_rabbitmq_provider_transition_is_drained \
		"$provider_transition_listing"$'\nwinwidget.lead-integration.webhook.retry-v3.1\t0\t0\t0'
	! widgets_rabbitmq_provider_transition_is_drained \
		"$provider_transition_listing"$'\nwinwidget.lead-integration.webhook.retry.1\t0\t0\t0'
	widgets_cutover_provider_replacement_is_safe true true true
	! widgets_cutover_provider_replacement_is_safe false true true
	! widgets_cutover_provider_replacement_is_safe true false true
	! widgets_cutover_provider_replacement_is_safe true true false
	widgets_cutover_post_publisher_namespace_is_safe \
		true true "$provider_target_listing"
	! widgets_cutover_post_publisher_namespace_is_safe \
		true false "$provider_target_listing"
	! widgets_cutover_post_publisher_namespace_is_safe \
		true true "$provider_polluted_listing"
	widgets_should_restore_pre_forward_source true false false
	! widgets_should_restore_pre_forward_source false false false
	! widgets_should_restore_pre_forward_source true true false
	! widgets_should_restore_pre_forward_source true false true
	[[ "$(widgets_should_restore_pre_forward_source invalid false false 2>/dev/null || printf '%s' "$?")" == '2' ]]
	printf 'widgets_lifecycle_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--state)
		[[ "$#" -eq 1 ]]
		widgets_service_identity_state
		;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ "$#" -eq 2 ]]
		widgets_guard_checkout_revision "$2" "$1"
		;;
	--self-test)
		[[ "$#" -eq 1 ]]
		widgets_lifecycle_self_test
		;;
	*)
		echo 'Usage: widgets-database-lifecycle.sh --state|--guard-before-fetch-revision REVISION|--guard-before-checkout-revision REVISION|--self-test' >&2
		exit 64
		;;
	esac
fi
