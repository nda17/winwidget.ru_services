#!/usr/bin/env bash

# Widgets has no file-based phase machine. The only durable ownership marker is
# widgets.service_identity in the dedicated PostgreSQL database.

WIDGETS_CANONICAL_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME='20260810000000_remove_legacy_widgets_core_source'
WIDGETS_CORE_SOURCE_CLEANUP_MARKER_NAME='.widgets-core-source-cleanup-v1'
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

widgets_lifecycle_prepare_node_runtime() {
	command -v node >/dev/null 2>&1 && return 0
	command -v docker >/dev/null 2>&1 || return 1
	local container image revision project service oneoff marker_revision=''
	if [[ -n "${WIDGETS_LIFECYCLE_NODE_IMAGE:-}" ]]; then
		[[ "$WIDGETS_LIFECYCLE_NODE_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
		revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$WIDGETS_LIFECYCLE_NODE_IMAGE")" || return 1
		[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
		return 0
	fi
	container="$(docker ps --all --quiet --no-trunc \
		--filter 'label=com.docker.compose.project=winwidget' \
		--filter 'label=com.docker.compose.service=maintenance-worker')" || return 1
	if [[ -n "$container" ]]; then
		[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
		project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" ||
			return 1
		service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")" ||
			return 1
		oneoff="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$container")" ||
			return 1
		[[ "$project" == 'winwidget' && "$service" == 'maintenance-worker' &&
			"$oneoff" =~ ^[Ff]alse$ ]] || return 1
		image="$(docker inspect --format '{{.Image}}' "$container")" || return 1
	else
		widgets_core_source_cleanup_validate_marker || return 1
		marker_revision="$(widgets_core_source_cleanup_marker_value_from_file \
			"$(widgets_core_source_cleanup_marker_path)" revision)" || return 1
		[[ "$marker_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
		image="$(docker image inspect --format '{{.Id}}' \
			"winwidget-maintenance:git-$marker_revision")" || return 1
	fi
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" ||
		return 1
	[[ "$image" =~ ^sha256:[0-9a-f]{64}$ && "$revision" =~ ^[0-9a-f]{40}$ &&
		( -z "$marker_revision" || "$revision" == "$marker_revision" ) ]] || return 1
	export WIDGETS_LIFECYCLE_NODE_IMAGE="$image"
}

widgets_lifecycle_node() {
	if command -v node >/dev/null 2>&1; then
		command node "$@"
		return
	fi
	widgets_lifecycle_prepare_node_runtime || return 1
	local env_name file_variable file_path file_target
	local -a docker_args=(
		run --rm --interactive --network none --read-only
		--user 0:0 --security-opt no-new-privileges --entrypoint node
	)
	for file_variable in PREFLIGHT_FILE RECEIPT_FILE COMPLETION_FILE; do
		file_path="${!file_variable:-}"
		[[ -n "$file_path" ]] || continue
		[[ "$file_path" =~ ^/[A-Za-z0-9._/@+-]+$ && -f "$file_path" && ! -L "$file_path" ]] ||
			return 1
		case "$file_variable" in
		PREFLIGHT_FILE) file_target='/tmp/widgets-lifecycle-preflight-file' ;;
		RECEIPT_FILE) file_target='/tmp/widgets-lifecycle-receipt-file' ;;
		COMPLETION_FILE) file_target='/tmp/widgets-lifecycle-completion-file' ;;
		esac
		docker_args+=(
			--mount "type=bind,source=$file_path,target=$file_target,readonly"
			--env "$file_variable=$file_target"
		)
	done
	for env_name in \
		BASE_DATABASE_URL WIDGETS_CLEANUP_GENERATION WIDGETS_CLEANUP_SNAPSHOT \
		WIDGETS_CLEANUP_CORE_BACKUP WIDGETS_CLEANUP_WIDGETS_BACKUP \
		WIDGETS_CLEANUP_RESTORE_EVIDENCE EXPECTED_KIND EXPECTED_REVISION \
		EXPECTED_GENERATION EXPECTED_FINGERPRINT EXPECTED_CORE_SHA \
		EXPECTED_WIDGETS_SHA EXPECTED_PREFLIGHT_SHA EXPECTED_POST_SHA \
		EXPECTED_RECEIPT_SHA CLEANUP_URL PREVIOUS_REVISION CLEANUP_REVISION \
		OWNERSHIP_GENERATION SOURCE_FINGERPRINT SOURCE_SNAPSHOT CORE_BACKUP_SHA \
		WIDGETS_BACKUP_SHA CORE_SYSTEM_ID WIDGETS_SYSTEM_ID \
		WIDGETS_DATABASE_ID_VALUE CORE_RESTORE_SYSTEM_ID EXPECTED_REVISION_VALUE \
		EXPECTED_POST_SHA256 EXPECTED_POST_RECEIPT_SHA; do
		[[ -n "${!env_name:-}" ]] && docker_args+=(--env "$env_name")
	done
	docker "${docker_args[@]}" "$WIDGETS_LIFECYCLE_NODE_IMAGE" "$@"
}

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

widgets_core_source_cleanup_migration_url() {
	[[ "$#" -eq 6 ]] || return 1
	local base_url="$1"
	local generation="$2"
	local snapshot="$3"
	local core_backup="$4"
	local widgets_backup="$5"
	local restore_evidence="$6"
	[[ -n "$base_url" && "$generation" =~ ^[1-9][0-9]*$ &&
		"$snapshot" =~ ^[0-9a-f]{64}$ && "$snapshot" != "$(printf '0%.0s' {1..64})" &&
		"$core_backup" =~ ^[0-9a-f]{64}$ && "$core_backup" != "$(printf '0%.0s' {1..64})" &&
		"$widgets_backup" =~ ^[0-9a-f]{64}$ && "$widgets_backup" != "$(printf '0%.0s' {1..64})" &&
		"$restore_evidence" =~ ^[0-9a-f]{64}$ && "$restore_evidence" != "$(printf '0%.0s' {1..64})" ]] ||
		return 1
	BASE_DATABASE_URL="$base_url" \
		WIDGETS_CLEANUP_GENERATION="$generation" \
		WIDGETS_CLEANUP_SNAPSHOT="$snapshot" \
		WIDGETS_CLEANUP_CORE_BACKUP="$core_backup" \
		WIDGETS_CLEANUP_WIDGETS_BACKUP="$widgets_backup" \
		WIDGETS_CLEANUP_RESTORE_EVIDENCE="$restore_evidence" \
		widgets_lifecycle_node <<'NODE'
let databaseUrl;
try {
  databaseUrl = new URL(process.env.BASE_DATABASE_URL);
} catch {
  process.exit(1);
}
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
  process.exit(1);
}
const existingOptions = databaseUrl.searchParams.getAll('options');
if (existingOptions.length > 1) {
  process.exit(1);
}
const cleanupOptions = [
  '-c winwidget.widgets_source_cleanup=production-destructive-approved',
  '-c winwidget.widgets_ownership_state=active',
  `-c winwidget.widgets_ownership_generation=${process.env.WIDGETS_CLEANUP_GENERATION}`,
  `-c winwidget.widgets_source_snapshot_sha256=${process.env.WIDGETS_CLEANUP_SNAPSHOT}`,
  `-c winwidget.widgets_core_backup_sha256=${process.env.WIDGETS_CLEANUP_CORE_BACKUP}`,
  `-c winwidget.widgets_backup_sha256=${process.env.WIDGETS_CLEANUP_WIDGETS_BACKUP}`,
  `-c winwidget.widgets_restore_evidence_sha256=${process.env.WIDGETS_CLEANUP_RESTORE_EVIDENCE}`,
].join(' ');
const existing = existingOptions[0]?.trim();
databaseUrl.searchParams.set(
  'options',
  existing ? `${existing} ${cleanupOptions}` : cleanupOptions,
);
const serialized = databaseUrl.toString().replace(
  /([?&]options=)([^&#]*)/,
  (_, prefix, value) => `${prefix}${value.replace(/\+/g, '%20')}`,
);
process.stdout.write(serialized);
NODE
}

widgets_core_source_cleanup_migration_file() {
	local source_root
	source_root="$(
		cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
		pwd -P
	)" || return 1
	printf '%s/prisma/migrations/%s/migration.sql\n' \
		"$source_root" "$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
}

widgets_core_source_cleanup_migration_checksum() {
	local migration_file
	migration_file="$(widgets_core_source_cleanup_migration_file)" || return 1
	[[ -f "$migration_file" && ! -L "$migration_file" ]] || return 1
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$migration_file" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$migration_file" | awk 'NR == 1 { print $1 }'
	fi
}

widgets_lifecycle_sha256_stream() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 | awk 'NR == 1 { print $1 }'
	fi
}

widgets_lifecycle_sha256_file() {
	local file="$1"
	[[ -f "$file" && ! -L "$file" ]] || return 1
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$file" | awk 'NR == 1 { print $1 }'
	fi
}

widgets_lifecycle_stat_mode() {
	if stat -c '%a' "$1" >/dev/null 2>&1; then
		stat -c '%a' "$1"
	else
		stat -f '%Lp' "$1"
	fi
}

widgets_lifecycle_stat_owner() {
	if stat -c '%u:%g' "$1" >/dev/null 2>&1; then
		stat -c '%u:%g' "$1"
	else
		stat -f '%u:%g' "$1"
	fi
}

widgets_core_source_cleanup_marker_path() {
	printf '%s/deploy/backend/%s\n' \
		"${APP_ROOT:-/opt/winwidget}" "$WIDGETS_CORE_SOURCE_CLEANUP_MARKER_NAME"
}

widgets_core_source_cleanup_evidence_directory() {
	local revision="$1" generation="$2"
	[[ "$revision" =~ ^[0-9a-f]{40}$ && "$generation" =~ ^[1-9][0-9]*$ ]] || return 1
	printf '%s/deploy/backend/widgets-core-source-cleanup/%s-g%s\n' \
		"${APP_ROOT:-/opt/winwidget}" "$revision" "$generation"
}

widgets_core_source_cleanup_validate_private_file() {
	local file="$1" expected_sha256="$2"
	[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ && -f "$file" && ! -L "$file" &&
		"$(widgets_lifecycle_stat_owner "$file")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$file")" == '600' && -s "$file" &&
		"$(widgets_lifecycle_sha256_file "$file")" == "$expected_sha256" ]]
}

widgets_core_source_cleanup_reference_is_safe() {
	[[ "$#" -eq 2 ]] || return 1
	local provider="$1" reference="$2"
	case "$provider" in
	operator-managed-macos) [[ "$reference" =~ ^macos-offsite:[A-Za-z0-9][A-Za-z0-9._:@+-]{7,239}$ ]] ;;
	s3-compatible) [[ "$reference" =~ ^s3-offsite:[A-Za-z0-9][A-Za-z0-9._:/@+-]{7,239}$ ]] ;;
	telegram-document) [[ "$reference" =~ ^telegram-document:[A-Za-z0-9][A-Za-z0-9._:@+-]{7,239}$ ]] ;;
	*) return 1 ;;
	esac
}

widgets_core_source_cleanup_validate_offsite_receipt() {
	[[ "$#" -eq 2 || "$#" -eq 3 ]] || return 1
	local receipt="$1" evidence_kind="$2" expected_post_sha="${3:-}" metadata provider reference
	[[ "$evidence_kind" =~ ^(pre|post)$ ]] || return 1
	if [[ "$evidence_kind" == 'post' && -n "$expected_post_sha" ]]; then
		[[ "$expected_post_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	elif [[ -n "$expected_post_sha" ]]; then
		return 1
	fi
	metadata="$(
		RECEIPT_FILE="$receipt" EXPECTED_KIND="$evidence_kind" widgets_lifecycle_node -e '
const fs = require("node:fs");
let value;
try { value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, "utf8")); } catch { process.exit(1); }
const expected = [
  "artifacts", "cleanupRevision", "ownershipGeneration", "provider",
  "providerReference", "sourceDatabaseFingerprint", "status", "verifiedAt", "version",
];
if (!value || Array.isArray(value) || Object.keys(value).sort().join("\n") !== expected.join("\n")) process.exit(1);
if (value.version !== 1 || value.status !== "verified") process.exit(1);
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt)) process.exit(1);
if (!Array.isArray(value.artifacts)) process.exit(1);
const expectedNames = process.env.EXPECTED_KIND === "pre"
  ? ["core-pre-cleanup.dump", "preflight-evidence.json", "widgets-pre-cleanup.dump"]
  : ["core-post-cleanup.dump"];
const names = value.artifacts.map(item => item?.name).sort();
if (names.join("\n") !== expectedNames.join("\n")) process.exit(1);
for (const item of value.artifacts) {
  if (!item || Object.keys(item).sort().join("\n") !== "name\nsha256\nsizeBytes") process.exit(1);
  if (!/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) process.exit(1);
}
process.stdout.write(`${value.provider}\t${value.providerReference}`);
' 2>/dev/null
	)" || return 1
	IFS=$'\t' read -r provider reference <<<"$metadata"
	widgets_core_source_cleanup_reference_is_safe "$provider" "$reference" || return 1
	RECEIPT_FILE="$receipt" \
		EXPECTED_REVISION="$(widgets_core_source_cleanup_marker_value revision)" \
		EXPECTED_GENERATION="$(widgets_core_source_cleanup_marker_value ownership_generation)" \
		EXPECTED_FINGERPRINT="$(widgets_core_source_cleanup_marker_value source_database_fingerprint)" \
		EXPECTED_KIND="$evidence_kind" \
		EXPECTED_CORE_SHA="$(if [[ "$evidence_kind" == 'pre' ]]; then widgets_core_source_cleanup_marker_value core_backup_sha256; elif [[ -n "$expected_post_sha" ]]; then printf '%s' "$expected_post_sha"; else widgets_core_source_cleanup_marker_value post_cleanup_backup_sha256; fi)" \
		EXPECTED_WIDGETS_SHA="$(widgets_core_source_cleanup_marker_value widgets_backup_sha256)" \
		EXPECTED_PREFLIGHT_SHA="$(widgets_core_source_cleanup_marker_value restore_evidence_sha256)" \
		widgets_lifecycle_node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, "utf8"));
if (
  value.cleanupRevision !== process.env.EXPECTED_REVISION ||
  String(value.ownershipGeneration) !== process.env.EXPECTED_GENERATION ||
  value.sourceDatabaseFingerprint !== process.env.EXPECTED_FINGERPRINT
) process.exit(1);
const actual = Object.fromEntries(value.artifacts.map(item => [item.name, item.sha256]));
if (process.env.EXPECTED_KIND === "pre") {
  if (
    actual["core-pre-cleanup.dump"] !== process.env.EXPECTED_CORE_SHA ||
    actual["widgets-pre-cleanup.dump"] !== process.env.EXPECTED_WIDGETS_SHA ||
    actual["preflight-evidence.json"] !== process.env.EXPECTED_PREFLIGHT_SHA
  ) process.exit(1);
} else if (actual["core-post-cleanup.dump"] !== process.env.EXPECTED_CORE_SHA) process.exit(1);
' >/dev/null
}

widgets_core_source_cleanup_verify_receipt_artifacts() {
	[[ "$#" -eq 2 || "$#" -eq 3 ]] || return 1
	local receipt="$1" evidence_kind="$2" expected_post_sha="${3:-}"
	local revision generation directory checklist metadata
	widgets_core_source_cleanup_validate_offsite_receipt \
		"$receipt" "$evidence_kind" ${expected_post_sha:+"$expected_post_sha"} || return 1
	command -v sha256sum >/dev/null 2>&1 || return 1
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	checklist="$directory/.offsite-artifact-check.$$"
	[[ ! -e "$checklist" && ! -L "$checklist" ]] || return 1
	metadata="$(
		RECEIPT_FILE="$receipt" widgets_lifecycle_node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, "utf8"));
for (const item of [...value.artifacts].sort((a, b) => a.name.localeCompare(b.name))) {
  process.stdout.write(`${item.sha256}\t${item.sizeBytes}\t${item.name}\n`);
}
' 2>/dev/null
	)" || return 1
	(umask 077; : >"$checklist") || return 1
	while IFS=$'\t' read -r sha256 size_bytes name; do
		[[ "$sha256" =~ ^[0-9a-f]{64}$ && "$size_bytes" =~ ^[1-9][0-9]*$ &&
			"$name" =~ ^(core-pre-cleanup\.dump|widgets-pre-cleanup\.dump|preflight-evidence\.json|core-post-cleanup\.dump)$ ]] || {
			rm -f -- "$checklist"
			return 1
		}
		[[ -f "$directory/$name" && ! -L "$directory/$name" &&
			"$(widgets_lifecycle_stat_owner "$directory/$name")" == '0:0' &&
			"$(widgets_lifecycle_stat_mode "$directory/$name")" == '600' &&
			"$(stat -c '%s' "$directory/$name")" == "$size_bytes" ]] || {
			rm -f -- "$checklist"
			return 1
		}
		printf '%s  %s\n' "$sha256" "$name" >>"$checklist"
	done <<<"$metadata"
	if ! (cd "$directory" && sha256sum --check --strict --status "$(basename -- "$checklist")"); then
		rm -f -- "$checklist"
		return 1
	fi
	rm -f -- "$checklist"
}

widgets_core_source_cleanup_validate_completion_evidence() {
	[[ "$#" -eq 1 ]] || return 1
	local evidence="$1" zero_sha receipt_sha
	zero_sha="$(printf '0%.0s' {1..64})"
	receipt_sha="$(
		COMPLETION_FILE="$evidence" widgets_lifecycle_node -e '
const fs = require("node:fs");
let value;
try { value = JSON.parse(fs.readFileSync(process.env.COMPLETION_FILE, "utf8")); } catch { process.exit(1); }
const expected = [
  "cleanPostgreSQL18Restore", "cleanupRevision", "legacyRelationsAbsent",
  "migrationApplied", "ownershipGeneration", "postCleanupBackupSha256",
  "postCleanupOffsiteReceiptSha256",
  "preCleanupOffsiteReceiptSha256", "publicAssets", "runtimeSmoke", "status",
  "verifiedAt", "version",
];
if (!value || Array.isArray(value) || Object.keys(value).sort().join("\n") !== expected.join("\n")) process.exit(1);
if (
  value.version !== 1 || value.status !== "verified" ||
  value.migrationApplied !== true || value.legacyRelationsAbsent !== true ||
  value.runtimeSmoke !== true || value.publicAssets !== true ||
  value.cleanPostgreSQL18Restore !== true ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt)
) process.exit(1);
process.stdout.write(value.postCleanupOffsiteReceiptSha256);
' 2>/dev/null
	)" || return 1
	[[ "$receipt_sha" =~ ^[0-9a-f]{64}$ && "$receipt_sha" != "$zero_sha" ]] || return 1
	COMPLETION_FILE="$evidence" \
		EXPECTED_REVISION="$(widgets_core_source_cleanup_marker_value revision)" \
		EXPECTED_GENERATION="$(widgets_core_source_cleanup_marker_value ownership_generation)" \
		EXPECTED_POST_SHA="$(widgets_core_source_cleanup_marker_value post_cleanup_backup_sha256)" \
		EXPECTED_RECEIPT_SHA="$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)" \
		widgets_lifecycle_node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.COMPLETION_FILE, "utf8"));
if (
  value.cleanupRevision !== process.env.EXPECTED_REVISION ||
  String(value.ownershipGeneration) !== process.env.EXPECTED_GENERATION ||
  value.postCleanupBackupSha256 !== process.env.EXPECTED_POST_SHA ||
  value.preCleanupOffsiteReceiptSha256 !== process.env.EXPECTED_RECEIPT_SHA
) process.exit(1);
' >/dev/null
	local revision generation directory post_receipt
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	post_receipt="$directory/post-cleanup-offsite-receipt.json"
	widgets_core_source_cleanup_validate_private_file "$post_receipt" "$receipt_sha" || return 1
	widgets_core_source_cleanup_validate_offsite_receipt "$post_receipt" post
}

widgets_core_source_cleanup_require_preflight_evidence() {
	local revision generation directory core_dump widgets_dump evidence
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	[[ -d "$directory" && ! -L "$directory" &&
		"$(widgets_lifecycle_stat_owner "$directory")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$directory")" == '700' ]] || return 1
	core_dump="$directory/core-pre-cleanup.dump"
	widgets_dump="$directory/widgets-pre-cleanup.dump"
	evidence="$directory/preflight-evidence.json"
	widgets_core_source_cleanup_validate_private_file "$core_dump" \
		"$(widgets_core_source_cleanup_marker_value core_backup_sha256)" || return 1
	widgets_core_source_cleanup_validate_private_file "$widgets_dump" \
		"$(widgets_core_source_cleanup_marker_value widgets_backup_sha256)" || return 1
	widgets_core_source_cleanup_validate_private_file "$evidence" \
		"$(widgets_core_source_cleanup_marker_value restore_evidence_sha256)"
}

widgets_core_source_cleanup_require_staged_evidence() {
	local revision generation directory offsite_receipt offsite_sha
	widgets_core_source_cleanup_require_preflight_evidence || return 1
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	offsite_receipt="$directory/offsite-receipt.json"
	offsite_sha="$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)" || return 1
	[[ "$offsite_sha" =~ ^[0-9a-f]{64}$ &&
		"$offsite_sha" != "$(printf '0%.0s' {1..64})" ]] || return 1
	widgets_core_source_cleanup_validate_private_file "$offsite_receipt" "$offsite_sha" || return 1
	widgets_core_source_cleanup_verify_receipt_artifacts "$offsite_receipt" pre
}

widgets_core_source_cleanup_require_completion_evidence() {
	local revision generation directory
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	[[ -d "$directory" && ! -L "$directory" &&
		"$(widgets_lifecycle_stat_owner "$directory")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$directory")" == '700' ]] || return 1
	widgets_core_source_cleanup_validate_private_file \
		"$directory/preflight-evidence.json" \
		"$(widgets_core_source_cleanup_marker_value restore_evidence_sha256)" || return 1
	widgets_core_source_cleanup_validate_private_file \
		"$directory/offsite-receipt.json" \
		"$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)" || return 1
	widgets_core_source_cleanup_validate_private_file \
		"$directory/completion-evidence.json" \
		"$(widgets_core_source_cleanup_marker_value completion_evidence_sha256)" || return 1
	widgets_core_source_cleanup_validate_completion_evidence \
		"$directory/completion-evidence.json"
}

widgets_core_source_cleanup_local_retention_is_finalized() {
	local revision generation directory file
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	for file in \
		"$directory/core-pre-cleanup.dump" \
		"$directory/widgets-pre-cleanup.dump" \
		"$directory/core-post-cleanup.dump" \
		"/root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g${generation}.json" \
		"/root/winwidget-widgets-core-cleanup-post-offsite-${revision}-g${generation}.json"; do
		[[ ! -e "$file" && ! -L "$file" ]] || return 1
	done
}

widgets_core_source_cleanup_marker_value_from_file() {
	local marker_file="$1" key="$2"
	[[ -f "$marker_file" && ! -L "$marker_file" &&
		"$key" =~ ^[a-z][a-z0-9_]*$ ]] || return 1
	awk -F= -v key="$key" '
		$1 == key { value = substr($0, length(key) + 2); count += 1 }
		END {
			if (count != 1 || value == "") exit 1
			print value
		}
	' "$marker_file"
}

widgets_core_source_cleanup_validate_marker_contents() {
	local marker_file="$1" key value phase offsite_receipt post_backup completion zero_sha
	local -a keys=(
		version phase previous_revision revision migration_name migration_sha256
		ownership_generation source_database_fingerprint source_snapshot_sha256
		core_backup_sha256 widgets_backup_sha256 restore_evidence_sha256
		offsite_receipt_sha256
		core_system_identifier widgets_system_identifier widgets_database_id
		post_cleanup_backup_sha256 completion_evidence_sha256 created_at updated_at
	)
	[[ -f "$marker_file" && ! -L "$marker_file" ]] || return 1
	[[ "$(wc -l <"$marker_file" | tr -d '[:space:]')" == "${#keys[@]}" ]] || return 1
	for key in "${keys[@]}"; do
		value="$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" "$key")" || return 1
	done
	zero_sha="$(printf '0%.0s' {1..64})"
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" version)" == '1' ]] || return 1
	phase="$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" phase)"
	[[ "$phase" =~ ^(staged|applied|complete)$ ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" previous_revision)" =~ ^[0-9a-f]{40}$ ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" revision)" =~ ^[0-9a-f]{40}$ ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" migration_name)" == \
		"$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME" ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" migration_sha256)" =~ ^[0-9a-f]{64}$ ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" ownership_generation)" =~ ^[1-9][0-9]*$ ]] || return 1
	for key in source_database_fingerprint source_snapshot_sha256 core_backup_sha256 \
		widgets_backup_sha256 restore_evidence_sha256; do
		value="$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" "$key")"
		[[ "$value" =~ ^[0-9a-f]{64}$ && "$value" != "$zero_sha" ]] || return 1
	done
	offsite_receipt="$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" offsite_receipt_sha256)"
	if [[ "$phase" == 'staged' ]]; then
		[[ "$offsite_receipt" == 'pending' ||
			( "$offsite_receipt" =~ ^[0-9a-f]{64}$ && "$offsite_receipt" != "$zero_sha" ) ]] ||
			return 1
	else
		[[ "$offsite_receipt" =~ ^[0-9a-f]{64}$ && "$offsite_receipt" != "$zero_sha" ]] ||
			return 1
	fi
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" core_system_identifier)" =~ ^[1-9][0-9]*$ ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" widgets_system_identifier)" =~ ^[1-9][0-9]*$ ]] || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" widgets_database_id)" =~ \
		^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
	post_backup="$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" post_cleanup_backup_sha256)"
	completion="$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" completion_evidence_sha256)"
	if [[ "$phase" == 'complete' ]]; then
		[[ "$post_backup" =~ ^[0-9a-f]{64}$ && "$completion" =~ ^[0-9a-f]{64}$ &&
			"$post_backup" != "$zero_sha" &&
			"$completion" != "$zero_sha" ]] || return 1
	else
		[[ "$post_backup" == 'pending' && "$completion" == 'pending' ]] || return 1
	fi
	for key in created_at updated_at; do
		[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" "$key")" =~ \
			^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	done
}

widgets_core_source_cleanup_validate_marker() {
	local marker_file marker_directory expected_checksum
	marker_file="$(widgets_core_source_cleanup_marker_path)"
	marker_directory="$(dirname -- "$marker_file")"
	[[ -d "$marker_directory" && ! -L "$marker_directory" &&
		"$(widgets_lifecycle_stat_owner "$marker_directory")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$marker_directory")" =~ ^(700|750|755)$ &&
		-f "$marker_file" && ! -L "$marker_file" &&
		"$(widgets_lifecycle_stat_owner "$marker_file")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$marker_file")" == '600' ]] || return 1
	widgets_core_source_cleanup_validate_marker_contents "$marker_file" || return 1
	expected_checksum="$(widgets_core_source_cleanup_migration_checksum)" || return 1
	[[ "$(widgets_core_source_cleanup_marker_value_from_file "$marker_file" migration_sha256)" == \
		"$expected_checksum" ]]
}

widgets_core_source_cleanup_marker_value() {
	widgets_core_source_cleanup_validate_marker || return 1
	widgets_core_source_cleanup_marker_value_from_file \
		"$(widgets_core_source_cleanup_marker_path)" "$1"
}

widgets_core_source_cleanup_write_marker() {
	[[ "$#" -eq 16 ]] || return 1
	local phase="$1" previous_revision="$2" revision="$3" ownership_generation="$4"
	local source_database_fingerprint="$5" source_snapshot_sha256="$6"
	local core_backup_sha256="$7" widgets_backup_sha256="$8"
	local restore_evidence_sha256="$9" offsite_receipt_sha256="${10}"
	local core_system_identifier="${11}" widgets_system_identifier="${12}"
	local widgets_database_id="${13}" post_cleanup_backup_sha256="${14}"
	local completion_evidence_sha256="${15}" created_at="${16}"
	local migration_sha256 marker_file marker_directory temporary updated_at
	local current_phase current_value current_offsite key
	migration_sha256="$(widgets_core_source_cleanup_migration_checksum)" || return 1
	marker_file="$(widgets_core_source_cleanup_marker_path)"
	marker_directory="$(dirname -- "$marker_file")"
	updated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	[[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	[[ -d "$marker_directory" && ! -L "$marker_directory" &&
		"$(widgets_lifecycle_stat_owner "$marker_directory")" == '0:0' ]] || return 1
	if [[ -e "$marker_file" || -L "$marker_file" ]]; then
		widgets_core_source_cleanup_validate_marker || return 1
		current_phase="$(widgets_core_source_cleanup_marker_value phase)" || return 1
		case "$current_phase|$phase" in
		staged\|staged | staged\|applied | applied\|applied | applied\|complete | complete\|complete) ;;
		*) return 1 ;;
		esac
		for key in previous_revision revision ownership_generation source_database_fingerprint \
			source_snapshot_sha256 core_backup_sha256 widgets_backup_sha256 \
			restore_evidence_sha256 core_system_identifier widgets_system_identifier \
			widgets_database_id created_at; do
			current_value="$(widgets_core_source_cleanup_marker_value "$key")" || return 1
			case "$key" in
			previous_revision) [[ "$current_value" == "$previous_revision" ]] || return 1 ;;
			revision) [[ "$current_value" == "$revision" ]] || return 1 ;;
			ownership_generation) [[ "$current_value" == "$ownership_generation" ]] || return 1 ;;
			source_database_fingerprint) [[ "$current_value" == "$source_database_fingerprint" ]] || return 1 ;;
			source_snapshot_sha256) [[ "$current_value" == "$source_snapshot_sha256" ]] || return 1 ;;
			core_backup_sha256) [[ "$current_value" == "$core_backup_sha256" ]] || return 1 ;;
			widgets_backup_sha256) [[ "$current_value" == "$widgets_backup_sha256" ]] || return 1 ;;
			restore_evidence_sha256) [[ "$current_value" == "$restore_evidence_sha256" ]] || return 1 ;;
			core_system_identifier) [[ "$current_value" == "$core_system_identifier" ]] || return 1 ;;
			widgets_system_identifier) [[ "$current_value" == "$widgets_system_identifier" ]] || return 1 ;;
			widgets_database_id) [[ "$current_value" == "$widgets_database_id" ]] || return 1 ;;
			created_at) [[ "$current_value" == "$created_at" ]] || return 1 ;;
			esac
			done
		current_offsite="$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)" || return 1
		[[ "$current_offsite" == 'pending' || "$current_offsite" == "$offsite_receipt_sha256" ]] ||
			return 1
		if [[ "$current_phase" == 'complete' ]]; then
			[[ "$(widgets_core_source_cleanup_marker_value post_cleanup_backup_sha256)" == \
				"$post_cleanup_backup_sha256" &&
				"$(widgets_core_source_cleanup_marker_value completion_evidence_sha256)" == \
				"$completion_evidence_sha256" ]] || return 1
		fi
	fi
	temporary="$marker_directory/.${WIDGETS_CORE_SOURCE_CLEANUP_MARKER_NAME#\.}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! {
		(umask 077; {
			printf 'version=1\n'
			printf 'phase=%s\n' "$phase"
			printf 'previous_revision=%s\n' "$previous_revision"
			printf 'revision=%s\n' "$revision"
			printf 'migration_name=%s\n' "$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
			printf 'migration_sha256=%s\n' "$migration_sha256"
			printf 'ownership_generation=%s\n' "$ownership_generation"
			printf 'source_database_fingerprint=%s\n' "$source_database_fingerprint"
			printf 'source_snapshot_sha256=%s\n' "$source_snapshot_sha256"
			printf 'core_backup_sha256=%s\n' "$core_backup_sha256"
			printf 'widgets_backup_sha256=%s\n' "$widgets_backup_sha256"
			printf 'restore_evidence_sha256=%s\n' "$restore_evidence_sha256"
			printf 'offsite_receipt_sha256=%s\n' "$offsite_receipt_sha256"
			printf 'core_system_identifier=%s\n' "$core_system_identifier"
			printf 'widgets_system_identifier=%s\n' "$widgets_system_identifier"
			printf 'widgets_database_id=%s\n' "$widgets_database_id"
			printf 'post_cleanup_backup_sha256=%s\n' "$post_cleanup_backup_sha256"
			printf 'completion_evidence_sha256=%s\n' "$completion_evidence_sha256"
			printf 'created_at=%s\n' "$created_at"
			printf 'updated_at=%s\n' "$updated_at"
		} >"$temporary") &&
			chown 0:0 "$temporary" && chmod 600 "$temporary" &&
			widgets_core_source_cleanup_validate_marker_contents "$temporary" &&
			mv -f "$temporary" "$marker_file"
	}; then
		rm -f -- "$temporary"
		return 1
	fi
	widgets_core_source_cleanup_validate_marker
}

widgets_core_source_cleanup_marker_state() {
	local marker_file
	marker_file="$(widgets_core_source_cleanup_marker_path)"
	if [[ ! -e "$marker_file" && ! -L "$marker_file" ]]; then
		printf 'absent\n'
		return
	fi
	widgets_core_source_cleanup_validate_marker || {
		printf 'invalid\n'
		return 1
	}
	widgets_core_source_cleanup_marker_value phase
}

widgets_core_source_cleanup_advance_marker() {
	[[ "$#" -eq 3 ]] || return 1
	local next_phase="$1" post_cleanup_backup_sha256="$2"
	local completion_evidence_sha256="$3" created_at
	widgets_core_source_cleanup_validate_marker || return 1
	created_at="$(widgets_core_source_cleanup_marker_value created_at)" || return 1
	widgets_core_source_cleanup_write_marker \
		"$next_phase" \
		"$(widgets_core_source_cleanup_marker_value previous_revision)" \
		"$(widgets_core_source_cleanup_marker_value revision)" \
		"$(widgets_core_source_cleanup_marker_value ownership_generation)" \
		"$(widgets_core_source_cleanup_marker_value source_database_fingerprint)" \
		"$(widgets_core_source_cleanup_marker_value source_snapshot_sha256)" \
		"$(widgets_core_source_cleanup_marker_value core_backup_sha256)" \
		"$(widgets_core_source_cleanup_marker_value widgets_backup_sha256)" \
		"$(widgets_core_source_cleanup_marker_value restore_evidence_sha256)" \
		"$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)" \
		"$(widgets_core_source_cleanup_marker_value core_system_identifier)" \
		"$(widgets_core_source_cleanup_marker_value widgets_system_identifier)" \
		"$(widgets_core_source_cleanup_marker_value widgets_database_id)" \
		"$post_cleanup_backup_sha256" "$completion_evidence_sha256" "$created_at"
}

widgets_core_source_cleanup_set_offsite_receipt() {
	[[ "$#" -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local receipt_sha256="$1" created_at
	widgets_core_source_cleanup_validate_marker || return 1
	[[ "$(widgets_core_source_cleanup_marker_value phase)" == 'staged' ]] || return 1
	created_at="$(widgets_core_source_cleanup_marker_value created_at)" || return 1
	widgets_core_source_cleanup_write_marker \
		staged \
		"$(widgets_core_source_cleanup_marker_value previous_revision)" \
		"$(widgets_core_source_cleanup_marker_value revision)" \
		"$(widgets_core_source_cleanup_marker_value ownership_generation)" \
		"$(widgets_core_source_cleanup_marker_value source_database_fingerprint)" \
		"$(widgets_core_source_cleanup_marker_value source_snapshot_sha256)" \
		"$(widgets_core_source_cleanup_marker_value core_backup_sha256)" \
		"$(widgets_core_source_cleanup_marker_value widgets_backup_sha256)" \
		"$(widgets_core_source_cleanup_marker_value restore_evidence_sha256)" \
		"$receipt_sha256" \
		"$(widgets_core_source_cleanup_marker_value core_system_identifier)" \
		"$(widgets_core_source_cleanup_marker_value widgets_system_identifier)" \
		"$(widgets_core_source_cleanup_marker_value widgets_database_id)" \
		pending pending "$created_at"
}

widgets_core_source_state_from_count() {
	local count="${1:-}"
	[[ "$count" =~ ^[0-9]+$ ]] || return 1
	case "$count" in
	0) printf 'absent\n' ;;
	18) printf 'present\n' ;;
	*) printf 'partial\n' ;;
	esac
}

widgets_core_source_cleanup_recovery_action() {
	[[ "$#" -eq 2 ]] || return 1
	local source_state="$1" migration_state="$2"
	case "$source_state|$migration_state" in
	present\|pending | present\|rolled-back | present\|unfinished) printf 'restore-exact\n' ;;
	absent\|unfinished | absent\|applied) printf 'forward-only\n' ;;
	*) printf 'halt\n' ;;
	esac
}

widgets_core_database_query() {
	local sql="$1" database_url postgres_image
	database_url="$(
		widgets_lifecycle_get_env_value DATABASE_MIGRATION_URL_PRODUCTION \
			2>/dev/null || true
	)"
	[[ -n "$database_url" ]] || return 1
	database_url="$(widgets_lifecycle_libpq_url "$database_url")" || return 1
	postgres_image="$(
		widgets_lifecycle_get_env_value CORE_POSTGRES_IMAGE 2>/dev/null || true
	)"
	postgres_image="${postgres_image:-$WIDGETS_CANONICAL_POSTGRES_IMAGE}"
	PGURL="$database_url" WIDGETS_CORE_SQL="$sql" \
		docker run --rm --network host -e PGURL -e WIDGETS_CORE_SQL \
			--entrypoint sh "$postgres_image" -euc '
				exec psql "$PGURL" --no-psqlrc --tuples-only --no-align \
					--set ON_ERROR_STOP=1 --command "$WIDGETS_CORE_SQL"
			' 2>/dev/null
}

widgets_core_source_ids_and_counts_are_covered() {
	[[ "$#" -eq 1 ]] || return 1
	local verification_image="$1" core_url widgets_url image_id
	image_id="$(docker image inspect --format '{{.Id}}' "$verification_image" 2>/dev/null)" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	core_url="$(widgets_lifecycle_get_env_value DATABASE_MIGRATION_URL_PRODUCTION)" || return 1
	widgets_url="$(widgets_lifecycle_get_env_value WIDGETS_BACKUP_URL)" || return 1
	[[ -n "$core_url" && -n "$widgets_url" ]] || return 1
	CORE_CLEANUP_URL="$core_url" WIDGETS_CLEANUP_URL="$widgets_url" \
		docker run --rm --network host -e CORE_CLEANUP_URL -e WIDGETS_CLEANUP_URL \
			--entrypoint node "$verification_image" -e '
const { spawnSync } = require("node:child_process");
const tables = [
  "widgets", "quizzes", "callbacks", "countdown_timers", "stop_offers",
  "online_consultants", "calculators", "leads", "quiz_leads", "callback_leads",
  "countdown_timer_leads", "stop_offer_leads", "online_consultant_leads",
  "calculator_leads", "widget_config_revisions", "widget_runtime_presence",
  "widget_runtime_daily_metrics", "widget_runtime_daily_step_metrics",
];
function parsed(raw) {
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("invalid database protocol");
  const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get("password") || "";
  url.password = "";
  for (const key of ["password", "schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) url.searchParams.delete(key);
  return { url: url.toString(), password };
}
function query(connection, sql) {
  const result = spawnSync("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", connection.url, "--command", sql], {
    env: { ...process.env, PGPASSWORD: connection.password },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("source parity query failed");
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}
const core = parsed(process.env.CORE_CLEANUP_URL);
const widgets = parsed(process.env.WIDGETS_CLEANUP_URL);
const identityRows = query(widgets, "SELECT source_snapshot_counts::text FROM widgets.service_identity WHERE id = '"'"'widgets-service'"'"'");
if (identityRows.length !== 1) throw new Error("source snapshot counts are unavailable");
const counts = JSON.parse(identityRows[0]);
for (const table of tables) {
  const quoted = `"${table}"`;
  const sourceIds = query(core, `SELECT id::text FROM public.${quoted} ORDER BY id`);
  const targetIds = new Set(query(widgets, `SELECT id::text FROM widgets.${quoted} ORDER BY id`));
  if (!Number.isSafeInteger(Number(counts[table])) || Number(counts[table]) !== sourceIds.length) {
    throw new Error(`snapshot count drift: ${table}`);
  }
  for (const id of sourceIds) {
    if (!targetIds.has(id)) throw new Error(`target is missing a source id: ${table}`);
  }
}
process.stdout.write("Legacy Widgets source counts and ID coverage verified\n");
'
}

widgets_core_source_state() {
	local result
	result="$(widgets_core_database_query "
SELECT count(*)
FROM unnest(ARRAY[
  'widgets','quizzes','callbacks','countdown_timers','stop_offers',
  'online_consultants','calculators','leads','quiz_leads','callback_leads',
  'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
  'calculator_leads','widget_config_revisions','widget_runtime_presence',
  'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
]) AS expected(relation_name)
WHERE to_regclass(format('public.%I', relation_name)) IS NOT NULL;
")" || {
		echo 'Core Widgets source state cannot be read; failing closed.' >&2
		return 1
	}
	widgets_core_source_state_from_count "$result"
}

widgets_core_source_cleanup_migration_state_from_counts() {
	[[ "$#" -eq 5 ]] || return 1
	local total="$1" mismatched="$2" applied="$3" unfinished="$4" rolled_back="$5"
	[[ "$total" =~ ^[0-9]+$ && "$mismatched" =~ ^[0-9]+$ &&
		"$applied" =~ ^[0-9]+$ && "$unfinished" =~ ^[0-9]+$ &&
		"$rolled_back" =~ ^[0-9]+$ ]] || return 1
	if ((total == 0)); then
		printf 'pending\n'
	elif ((mismatched != 0 || applied > 1 || unfinished > 1 ||
		applied + unfinished + rolled_back != total)); then
		printf 'unsafe\n'
	elif ((applied == 1 && unfinished == 0)); then
		printf 'applied\n'
	elif ((applied == 0 && unfinished == 1)); then
		printf 'unfinished\n'
	elif ((applied == 0 && unfinished == 0 && rolled_back >= 1)); then
		printf 'rolled-back\n'
	else
		printf 'unsafe\n'
	fi
}

widgets_core_source_cleanup_migration_state() {
	local expected_checksum result total mismatched applied unfinished rolled_back
	expected_checksum="$(widgets_core_source_cleanup_migration_checksum)" || return 1
	result="$(widgets_core_database_query "
SELECT count(*) || E'\\t' ||
       count(*) FILTER (WHERE checksum <> '$expected_checksum') || E'\\t' ||
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || E'\\t' ||
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) || E'\\t' ||
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)
FROM public.\"_prisma_migrations\"
WHERE migration_name = '$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME';
")" || return 1
	IFS=$'\t' read -r total mismatched applied unfinished rolled_back <<<"$result"
	widgets_core_source_cleanup_migration_state_from_counts \
		"$total" "$mismatched" "$applied" "$unfinished" "$rolled_back" ||
		printf 'unsafe\n'
}

widgets_require_core_source_absent() {
	[[ "$(widgets_core_source_cleanup_migration_state)" == 'applied' &&
		"$(widgets_core_source_state)" == 'absent' ]]
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

widgets_service_identity_cleanup_evidence() {
	local database_url postgres_image result generation fingerprint snapshot database_id
	database_url="$(widgets_lifecycle_get_env_value WIDGETS_DATABASE_URL 2>/dev/null || true)"
	[[ -n "$database_url" ]] || return 1
	database_url="$(widgets_lifecycle_libpq_url "$database_url")" || return 1
	postgres_image="$(widgets_lifecycle_get_env_value WIDGETS_POSTGRES_IMAGE 2>/dev/null || true)"
	postgres_image="${postgres_image:-$WIDGETS_CANONICAL_POSTGRES_IMAGE}"
	result="$({
		PGURL="$database_url" docker run --rm --network host -e PGURL \
			--entrypoint sh "$postgres_image" -euc '
				exec psql "$PGURL" --no-psqlrc --tuples-only --no-align \
					--set ON_ERROR_STOP=1 --field-separator "	" --command "
SELECT ownership_generation,
       source_database_fingerprint,
       source_snapshot_sha256,
       database_id
FROM widgets.service_identity
WHERE id = '\''widgets-service'\''
  AND ownership_activated_at IS NOT NULL
  AND handoff_started_at IS NOT NULL;"
		' 2>/dev/null
	} || true)"
	[[ -n "$result" && "$result" != *$'\n'* ]] || return 1
	IFS=$'\t' read -r generation fingerprint snapshot database_id <<<"$result"
	[[ "$generation" =~ ^[1-9][0-9]*$ && "$fingerprint" =~ ^[0-9a-f]{64}$ &&
		"$snapshot" =~ ^[0-9a-f]{64}$ &&
		"$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
	printf '%s\t%s\t%s\t%s\n' "$generation" "$fingerprint" "$snapshot" "$database_id"
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
	local state marker_file marker_phase marker_revision marker_checksum target_checksum
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
		"$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || return 1
	state="$(widgets_service_identity_state)" || return 1
	marker_file="$(widgets_core_source_cleanup_marker_path)"
	if [[ -e "$marker_file" || -L "$marker_file" ]]; then
		widgets_core_source_cleanup_validate_marker || {
			echo 'Widgets Core source cleanup marker is present but invalid.' >&2
			return 1
		}
		marker_phase="$(widgets_core_source_cleanup_marker_value phase)"
		marker_revision="$(widgets_core_source_cleanup_marker_value revision)"
		marker_checksum="$(widgets_core_source_cleanup_marker_value migration_sha256)"
		if [[ "$marker_phase" == 'complete' ]]; then
			widgets_core_source_cleanup_require_completion_evidence || {
				echo 'Completed Widgets Core source cleanup evidence is missing or invalid.' >&2
				return 1
			}
			widgets_core_source_cleanup_local_retention_is_finalized || {
				echo 'Completed Widgets Core source cleanup still has unfinalized raw VPS evidence.' >&2
				return 1
			}
		fi
		if [[ "$marker_phase" =~ ^(staged|applied)$ &&
			"$expected_revision" != "$marker_revision" ]]; then
			echo "Widgets Core source cleanup pins deployment to revision $marker_revision until post-cleanup restore evidence is complete." >&2
			return 1
		fi
		if [[ "$guard_action" == '--guard-before-checkout-revision' ]]; then
			git -C "$server_root" cat-file -e \
				"$expected_revision:scripts/widgets-database-lifecycle.sh" 2>/dev/null || {
				echo 'Target revision would remove the Widgets Core source cleanup guard.' >&2
				return 1
			}
			target_checksum="$({
				git -C "$server_root" show \
					"$expected_revision:prisma/migrations/$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME/migration.sql" 2>/dev/null
			} | widgets_lifecycle_sha256_stream)" || return 1
			[[ "$target_checksum" == "$marker_checksum" ]] || {
				echo 'Target revision changed or removed the applied Widgets Core source cleanup migration.' >&2
				return 1
			}
			if [[ "$marker_phase" == 'complete' ]]; then
				git -C "$server_root" merge-base --is-ancestor \
					"$marker_revision" "$expected_revision" || {
					echo 'Target revision would downgrade past the completed Widgets Core source cleanup.' >&2
					return 1
				}
			fi
		fi
	fi
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
	local cleanup_url cleanup_options cleanup_sha
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
	cleanup_sha="$(printf 'a%.0s' {1..64})"
	cleanup_url="$(widgets_core_source_cleanup_migration_url \
		'postgresql://migration:masked@127.0.0.1:55432/default_db?schema=public&options=-c%20existing.setting%3Dretained' \
		3 "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha")"
	cleanup_options="$(CLEANUP_URL="$cleanup_url" widgets_lifecycle_node -e \
		'process.stdout.write(new URL(process.env.CLEANUP_URL).searchParams.get("options") ?? "")')"
	[[ "$cleanup_url" == postgresql://migration:masked@127.0.0.1:55432/default_db* &&
		"$cleanup_url" == *'%20'* && "$cleanup_url" != *'+'* &&
		"$cleanup_options" == '-c existing.setting=retained -c winwidget.widgets_source_cleanup=production-destructive-approved -c winwidget.widgets_ownership_state=active -c winwidget.widgets_ownership_generation=3 -c winwidget.widgets_source_snapshot_sha256='"$cleanup_sha"' -c winwidget.widgets_core_backup_sha256='"$cleanup_sha"' -c winwidget.widgets_backup_sha256='"$cleanup_sha"' -c winwidget.widgets_restore_evidence_sha256='"$cleanup_sha" ]]
	! widgets_core_source_cleanup_migration_url \
		'https://example.test/not-postgres' 1 "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
		>/dev/null 2>&1
	! widgets_core_source_cleanup_migration_url \
		'postgresql://migration:masked@127.0.0.1/default_db' 0 "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
		>/dev/null 2>&1
	! widgets_full_deploy_action invalid active >/dev/null 2>&1
	! widgets_full_deploy_action true invalid >/dev/null 2>&1
	[[ "$(widgets_core_source_state_from_count 0)" == 'absent' ]]
	[[ "$(widgets_core_source_state_from_count 18)" == 'present' ]]
	[[ "$(widgets_core_source_state_from_count 7)" == 'partial' ]]
	! widgets_core_source_state_from_count invalid >/dev/null 2>&1
	[[ "$(widgets_core_source_cleanup_recovery_action present pending)" == 'restore-exact' ]]
	[[ "$(widgets_core_source_cleanup_recovery_action present rolled-back)" == 'restore-exact' ]]
	[[ "$(widgets_core_source_cleanup_recovery_action present unfinished)" == 'restore-exact' ]]
	[[ "$(widgets_core_source_cleanup_recovery_action absent unfinished)" == 'forward-only' ]]
	[[ "$(widgets_core_source_cleanup_recovery_action absent applied)" == 'forward-only' ]]
	[[ "$(widgets_core_source_cleanup_recovery_action partial unfinished)" == 'halt' ]]
	[[ "$(widgets_core_source_cleanup_recovery_action present applied)" == 'halt' ]]
	! widgets_core_source_cleanup_recovery_action present >/dev/null 2>&1
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 0 0 0 0 0)" == 'pending' ]]
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 1 0 0 1 0)" == 'unfinished' ]]
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 1 0 0 0 1)" == 'rolled-back' ]]
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 2 0 1 0 1)" == 'applied' ]]
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 2 1 1 0 0)" == 'unsafe' ]]
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 2 0 2 0 0)" == 'unsafe' ]]
	[[ "$(widgets_core_source_cleanup_migration_state_from_counts 2 0 0 1 1)" == 'unfinished' ]]
	! widgets_core_source_cleanup_migration_state_from_counts invalid 0 0 0 0 >/dev/null 2>&1
	[[ "$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME" =~ ^[0-9]{14}_[a-z0-9_]+$ ]]
	[[ "$(widgets_core_source_cleanup_migration_checksum)" =~ ^[0-9a-f]{64}$ ]]
	(
		local marker_directory marker_file marker_sha marker_timestamp
		marker_directory="$(mktemp -d "${TMPDIR:-/tmp}/widgets-cleanup-marker.XXXXXX")"
		trap 'rm -f "$marker_file"; rmdir "$marker_directory"' EXIT
		marker_file="$marker_directory/marker"
		marker_sha="$(printf 'a%.0s' {1..64})"
		marker_timestamp='2026-08-10T00:00:00Z'
		{
			printf 'version=1\nphase=staged\nprevious_revision=%s\nrevision=%s\n' "$revision" "$revision"
			printf 'migration_name=%s\nmigration_sha256=%s\n' \
				"$WIDGETS_CORE_SOURCE_CLEANUP_MIGRATION_NAME" "$marker_sha"
			printf 'ownership_generation=1\nsource_database_fingerprint=%s\n' "$marker_sha"
			printf 'source_snapshot_sha256=%s\ncore_backup_sha256=%s\n' "$marker_sha" "$marker_sha"
			printf 'widgets_backup_sha256=%s\nrestore_evidence_sha256=%s\n' "$marker_sha" "$marker_sha"
			printf 'offsite_receipt_sha256=pending\n'
			printf 'core_system_identifier=123\nwidgets_system_identifier=456\n'
			printf 'widgets_database_id=123e4567-e89b-42d3-a456-426614174000\n'
			printf 'post_cleanup_backup_sha256=pending\ncompletion_evidence_sha256=pending\n'
			printf 'created_at=%s\nupdated_at=%s\n' "$marker_timestamp" "$marker_timestamp"
		} >"$marker_file"
		widgets_core_source_cleanup_validate_marker_contents "$marker_file"
		printf 'unexpected=1\n' >>"$marker_file"
		! widgets_core_source_cleanup_validate_marker_contents "$marker_file"
	)
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
	--core-source-state)
		[[ "$#" -eq 1 ]]
		widgets_core_source_state
		;;
	--core-source-migration-state)
		[[ "$#" -eq 1 ]]
		widgets_core_source_cleanup_migration_state
		;;
	--core-source-cleanup-marker-state)
		[[ "$#" -eq 1 ]]
		widgets_core_source_cleanup_marker_state
		;;
	--self-test)
		[[ "$#" -eq 1 ]]
		widgets_lifecycle_self_test
		;;
	*)
		echo 'Usage: widgets-database-lifecycle.sh --state|--core-source-state|--core-source-migration-state|--core-source-cleanup-marker-state|--guard-before-fetch-revision REVISION|--guard-before-checkout-revision REVISION|--self-test' >&2
		exit 64
		;;
	esac
fi
