#!/usr/bin/env bash

# Reporting PostgreSQL phase-A lifecycle.
#
# `prepare` is the only action in this file which may create the canonical
# database container, external volume, admin secret, roles or schema. Routine
# application deployments source this file and use only the immutable identity
# guard; they must never run `prepare` implicitly.

REPORTING_APP_ROOT="${APP_ROOT:-/opt/winwidget}"
REPORTING_ENV_FILE="$REPORTING_APP_ROOT/deploy/backend/.env.production"
REPORTING_COMPOSE_FILE="$REPORTING_APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml"
REPORTING_DATABASE_MARKER="$REPORTING_APP_ROOT/deploy/backend/.reporting-database-lifecycle-v1"
REPORTING_FIRST_ROLLOUT_STAGED_MARKER="$REPORTING_APP_ROOT/deploy/backend/.reporting-first-rollout-staged-v1"
REPORTING_CUTOVER_MARKER="$REPORTING_APP_ROOT/deploy/backend/.reporting-database-cutover-v1"

reporting_database_restore_guard_script_directory="$(
	cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P
)"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$reporting_database_restore_guard_script_directory/database-restore-production-guard.sh"

REPORTING_POSTGRES_SERVICE='reporting-postgres'
REPORTING_CANONICAL_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
REPORTING_CANONICAL_POSTGRES_PORT='55435'
REPORTING_CANONICAL_POSTGRES_VOLUME='winwidget-reporting-postgres-data'
REPORTING_CANONICAL_POSTGRES_NETWORK='winwidget-reporting-postgres'
REPORTING_CANONICAL_DATABASE='winwidget_reporting'
REPORTING_CANONICAL_SCHEMA='reporting'
REPORTING_CANONICAL_ADMIN_USER='winwidget_reporting_admin'
REPORTING_CANONICAL_RUNTIME_USER='winwidget_reporting_runtime'
REPORTING_CANONICAL_MIGRATION_USER='winwidget_reporting_migration'
REPORTING_CANONICAL_BACKUP_USER='winwidget_reporting_backup'
REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS='webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,reporting-admin-audit,auto-renewal'
REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS='webhook,bitrix24,amo-crm,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,reporting-admin-audit,auto-renewal'
REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS='campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,billing-admin-audit,identity-admin-audit,billing-payment-projection,billing-subscription-projection,billing-affiliate-projection,billing-settings-projection'
REPORTING_PRE_CLEANUP_CORE_NOTIFICATION_DELIVERY_KINDS='email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram'
REPORTING_POST_CLEANUP_CORE_NOTIFICATION_DELIVERY_KINDS='email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,subscription-expiry-email,subscription-expiry-telegram'
REPORTING_STEADY_STATE_REMOVED_PATHS=(
	src/messaging/daily-summary-event.ts
	src/reports
	src/statistics
)
REPORTING_STEADY_STATE_FORBIDDEN_SOURCE_TOKENS=(
	report.daily-summary.requested.v1
	notification.daily-summary.telegram.requested.v1
	reporting.notification.delivery.outcome.v1
	reporting.settings.changed.v1
	daily-summary-telegram
	daily-summary-job
	winwidget.report.daily-summary.telegram
	DAILY_SUMMARY_EVENT_TYPE
	REPORTING_SETTINGS_EVENT_TYPE
	DAILY_TELEGRAM_SUMMARY
	DailySummaryRequestedEventPayload
	DailySummaryReportService
	DailySummaryDeliveryService
	applyDailySummaryDeliveryOutcome
	persistDailySummaryDeadLetter
	getDailySummaryJobId
	enqueueDailySummary
	StatisticsModule
	StatisticsController
	StatisticsService
	/statistics
	"@Controller('/statistics')"
	@/statistics
	@/reports
	reportsThreadId
	dailySummaryEnabled
	dailySummaryTime
	dailySummaryLastSent
)
REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_TOKEN='daily-summary-delivery-telegram'
REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SOURCE_PATHS=(
	src/messaging/messaging-admin.service.spec.ts
	src/messaging/notification-delivery-client.service.spec.ts
	src/messaging/notification-delivery-client.service.ts
)
REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SYMBOL='NOTIFICATION_DELIVERY_ADMIN_KINDS'
REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SYMBOL_PATHS=(
	src/messaging/messaging-admin.service.ts
	src/messaging/notification-delivery-client.service.ts
)
REPORTING_STEADY_STATE_FORBIDDEN_REPORTING_SOURCE_TOKENS=(
	reporting.settings.changed.v1
)

REPORTING_GUARD_CONTAINER_ID=''
REPORTING_GUARD_CONTAINER_SNAPSHOT=''
REPORTING_GUARD_VOLUME_SNAPSHOT=''
REPORTING_GUARD_SECRET_SNAPSHOT=''
REPORTING_GUARD_IMAGE_ID=''
REPORTING_GUARD_SYSTEM_IDENTIFIER=''

REPORTING_CUTOVER_PHASES=(
	preflight
	target-created
	roles-ready
	migrated
	producers-enabled
	backfilled
	caught-up
	shadow-verified
	scheduler-switched
	routes-switched
	cleanup-staged
	source-cleaned
	complete
)

reporting_cutover_phase_index() {
	local requested="$1" index
	for index in "${!REPORTING_CUTOVER_PHASES[@]}"; do
		if [[ "${REPORTING_CUTOVER_PHASES[$index]}" == "$requested" ]]; then
			printf '%s\n' "$index"
			return
		fi
	done
	return 1
}

reporting_expected_integration_worker_kinds() {
	local phase phase_index cleanup_staged_index
	local widgets_ownership_state
	widgets_ownership_state="$(reporting_widgets_ownership_marker_state)" || return 1
	if [[ "$widgets_ownership_state" == 'active' ]]; then
		printf '%s\n' "$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS"
		return
	fi
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" &&
		! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		printf '%s\n' "$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS"
		return
	fi
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is invalid while resolving integration worker ownership.' >&2
		return 1
	}
	phase="$(reporting_cutover_marker_value phase)" || return 1
	phase_index="$(reporting_cutover_phase_index "$phase")" || return 1
	cleanup_staged_index="$(reporting_cutover_phase_index cleanup-staged)" || return 1
	if ((phase_index >= cleanup_staged_index)); then
		printf '%s\n' "$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS"
	else
		printf '%s\n' "$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS"
	fi
}

reporting_widgets_lifecycle_libpq_url() {
	local raw_url="${1:-}"
	local base_url query parameter key separator='?'
	[[ "$#" -eq 1 && -n "$raw_url" ]] || return 1
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

reporting_widgets_ownership_marker_state() {
	local database_url postgres_image query result volume
	database_url="$(reporting_get_env_value WIDGETS_DATABASE_URL 2>/dev/null || true)"
	if [[ -z "$database_url" ]]; then
		printf 'inactive\n'
		return
	fi
	database_url="$(reporting_widgets_lifecycle_libpq_url "$database_url")" || {
		echo 'Widgets database URL cannot be converted to a libpq connection string.' >&2
		return 1
	}
	postgres_image="$(reporting_get_env_value WIDGETS_POSTGRES_IMAGE 2>/dev/null || true)"
	postgres_image="${postgres_image:-postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296}"
	query="$(cat <<'SQL'
SELECT CASE
  WHEN count(*) = 1
    AND bool_and(ownership_activated_at IS NOT NULL)
    AND bool_and(ownership_generation > 0)
    AND bool_and(source_database_fingerprint IS NOT NULL)
  THEN 'active'
  WHEN count(*) = 1
    AND bool_and(ownership_activated_at IS NULL)
    AND bool_and(ownership_generation = 0)
  THEN 'inactive'
  ELSE 'invalid'
END
FROM widgets.service_identity
WHERE id = 'widgets-service';
SQL
)"
	if result="$(
		PGURL="$database_url" WIDGETS_IDENTITY_SQL="$query" \
			docker run --rm --network host -e PGURL -e WIDGETS_IDENTITY_SQL \
				--entrypoint sh "$postgres_image" -euc '
					exec psql "$PGURL" --no-psqlrc --tuples-only --no-align \
						--set ON_ERROR_STOP=1 --command "$WIDGETS_IDENTITY_SQL"
				' 2>/dev/null
	)"; then
		case "$result" in
		active | inactive) printf '%s\n' "$result" ;;
		*)
			echo 'Widgets service_identity is invalid while resolving Core integration ownership.' >&2
			return 1
			;;
		esac
		return
	fi
	volume="$(reporting_get_env_value WIDGETS_POSTGRES_DATA_VOLUME 2>/dev/null || true)"
	if [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; then
		echo 'Widgets PostgreSQL exists but service_identity cannot be read; refusing to restore legacy integration ownership.' >&2
		return 1
	fi
	printf 'inactive\n'
}

reporting_expected_core_notification_delivery_kinds() {
	local phase phase_index cleanup_staged_index
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" &&
		! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		printf '%s\n' "$REPORTING_PRE_CLEANUP_CORE_NOTIFICATION_DELIVERY_KINDS"
		return
	fi
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is invalid while resolving Core notification readiness ownership.' >&2
		return 1
	}
	phase="$(reporting_cutover_marker_value phase)" || return 1
	phase_index="$(reporting_cutover_phase_index "$phase")" || return 1
	cleanup_staged_index="$(reporting_cutover_phase_index cleanup-staged)" || return 1
	if ((phase_index >= cleanup_staged_index)); then
		printf '%s\n' "$REPORTING_POST_CLEANUP_CORE_NOTIFICATION_DELIVERY_KINDS"
	else
		printf '%s\n' "$REPORTING_PRE_CLEANUP_CORE_NOTIFICATION_DELIVERY_KINDS"
	fi
}

reporting_cutover_validate_marker_contents() {
	local marker="$1" line key value seen='|'
	local version='' phase='' revision='' database_system_identifier=''
	local database_volume='' backfill_snapshot_id='' backfill_sha256=''
	local shadow_evidence_sha256='' scheduler_step='' scheduler_evidence_sha256=''
	local route_evidence_sha256='' restore_evidence_sha256=''
	local switch_generation='' cleanup_previous_revision='' cleanup_revision=''
	local cleanup_review_evidence_sha256='' cleanup_manifest_sha256=''
	local cleanup_restore_evidence_sha256=''
	local source_cleanup_evidence_sha256='' completion_evidence_sha256=''
	local updated_at='' phase_index backfilled_index shadow_index scheduler_index
	local routes_index cleanup_staged_index source_cleaned_index complete_index
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[a-z_][a-z0-9_]*=[^[:cntrl:]]*$ ]] || return 1
		key="${line%%=*}"
		value="${line#*=}"
		[[ "$seen" != *"|$key|"* ]] || return 1
		seen+="$key|"
		case "$key" in
		version) version="$value" ;;
		phase) phase="$value" ;;
		revision) revision="$value" ;;
		database_system_identifier) database_system_identifier="$value" ;;
		database_volume) database_volume="$value" ;;
		backfill_snapshot_id) backfill_snapshot_id="$value" ;;
		backfill_sha256) backfill_sha256="$value" ;;
		shadow_evidence_sha256) shadow_evidence_sha256="$value" ;;
		scheduler_step) scheduler_step="$value" ;;
		scheduler_evidence_sha256) scheduler_evidence_sha256="$value" ;;
		route_evidence_sha256) route_evidence_sha256="$value" ;;
		restore_evidence_sha256) restore_evidence_sha256="$value" ;;
		switch_generation) switch_generation="$value" ;;
		cleanup_previous_revision) cleanup_previous_revision="$value" ;;
		cleanup_revision) cleanup_revision="$value" ;;
		cleanup_review_evidence_sha256) cleanup_review_evidence_sha256="$value" ;;
		cleanup_manifest_sha256) cleanup_manifest_sha256="$value" ;;
		cleanup_restore_evidence_sha256) cleanup_restore_evidence_sha256="$value" ;;
		source_cleanup_evidence_sha256) source_cleanup_evidence_sha256="$value" ;;
		completion_evidence_sha256) completion_evidence_sha256="$value" ;;
		updated_at) updated_at="$value" ;;
		*) return 1 ;;
		esac
	done <"$marker"
	[[ "$version" == '1' ]] || return 1
	reporting_cutover_phase_index "$phase" >/dev/null || return 1
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	[[ "$database_system_identifier" =~ ^[0-9]+$ ]] || return 1
	[[ "$database_volume" == "$REPORTING_CANONICAL_POSTGRES_VOLUME" ]] || return 1
	[[ "$backfill_snapshot_id" == 'pending' ||
		"$backfill_snapshot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
	for value in "$backfill_sha256" "$shadow_evidence_sha256" \
		"$scheduler_evidence_sha256" "$route_evidence_sha256" \
		"$restore_evidence_sha256" "$cleanup_review_evidence_sha256" \
		"$cleanup_manifest_sha256" "$cleanup_restore_evidence_sha256" \
		"$source_cleanup_evidence_sha256" "$completion_evidence_sha256"; do
		[[ "$value" == 'pending' || "$value" =~ ^[0-9a-f]{64}$ ]] || return 1
	done
	[[ "$switch_generation" == 'pending' ||
		"$switch_generation" =~ ^[1-9][0-9]*$ ]] || return 1
	for value in "$cleanup_previous_revision" "$cleanup_revision"; do
		[[ "$value" == 'pending' || "$value" =~ ^[0-9a-f]{40}$ ]] || return 1
	done
	[[ "$scheduler_step" == 'pending' ||
		"$scheduler_step" == 'switch-intent' ||
		"$scheduler_step" == 'core-stopped' ||
		"$scheduler_step" == 'target-claim-intent' ||
		"$scheduler_step" == 'target-owned' ||
		"$scheduler_step" == 'rollback-intent' ||
		"$scheduler_step" == 'rollback-target-shadowed' ||
		"$scheduler_step" == 'rollback-repair-backfilled' ]] || return 1
	[[ "$updated_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	phase_index="$(reporting_cutover_phase_index "$phase")"
	backfilled_index="$(reporting_cutover_phase_index backfilled)"
	shadow_index="$(reporting_cutover_phase_index shadow-verified)"
	scheduler_index="$(reporting_cutover_phase_index scheduler-switched)"
	routes_index="$(reporting_cutover_phase_index routes-switched)"
	cleanup_staged_index="$(reporting_cutover_phase_index cleanup-staged)"
	source_cleaned_index="$(reporting_cutover_phase_index source-cleaned)"
	complete_index="$(reporting_cutover_phase_index complete)"
	if ((phase_index < backfilled_index)); then
		[[ "$backfill_snapshot_id" == 'pending' && "$backfill_sha256" == 'pending' ]] || return 1
	else
		[[ "$backfill_snapshot_id" != 'pending' && "$backfill_sha256" != 'pending' ]] || return 1
	fi
	if ((phase_index < shadow_index)); then
		[[ "$shadow_evidence_sha256" == 'pending' && "$scheduler_step" == 'pending' &&
			"$switch_generation" == 'pending' &&
			"$scheduler_evidence_sha256" == 'pending' ]] || return 1
	elif ((phase_index < scheduler_index)); then
		[[ "$shadow_evidence_sha256" != 'pending' &&
			"$scheduler_evidence_sha256" == 'pending' ]] || return 1
		if [[ "$scheduler_step" == 'pending' ||
			"$scheduler_step" == 'switch-intent' ]]; then
			[[ "$switch_generation" == 'pending' ]] || return 1
		else
			[[ "$switch_generation" != 'pending' ]] || return 1
		fi
	else
		[[ "$shadow_evidence_sha256" != 'pending' && "$scheduler_step" == 'target-owned' &&
			"$switch_generation" != 'pending' &&
			"$scheduler_evidence_sha256" != 'pending' ]] || return 1
	fi
	if ((phase_index < routes_index)); then
		[[ "$route_evidence_sha256" == 'pending' ]] || return 1
	else
		[[ "$route_evidence_sha256" != 'pending' ]] || return 1
	fi
	if ((phase_index < cleanup_staged_index)); then
		[[ "$cleanup_previous_revision" == 'pending' &&
			"$cleanup_revision" == 'pending' &&
			"$cleanup_review_evidence_sha256" == 'pending' &&
			"$cleanup_manifest_sha256" == 'pending' &&
			"$cleanup_restore_evidence_sha256" == 'pending' &&
			"$source_cleanup_evidence_sha256" == 'pending' &&
			"$completion_evidence_sha256" == 'pending' ]] || return 1
	else
		[[ "$restore_evidence_sha256" != 'pending' &&
			"$cleanup_previous_revision" == "$revision" &&
			"$cleanup_revision" != 'pending' &&
			"$cleanup_revision" != "$revision" &&
			"$cleanup_review_evidence_sha256" != 'pending' &&
			"$cleanup_manifest_sha256" != 'pending' ]] || return 1
	fi
	if ((phase_index < source_cleaned_index)); then
		[[ "$source_cleanup_evidence_sha256" == 'pending' &&
			"$cleanup_restore_evidence_sha256" == 'pending' &&
			"$completion_evidence_sha256" == 'pending' ]] || return 1
	else
		[[ "$source_cleanup_evidence_sha256" != 'pending' ]] || return 1
	fi
	if ((phase_index < complete_index)); then
		[[ "$completion_evidence_sha256" == 'pending' ]] || return 1
	else
		[[ "$cleanup_restore_evidence_sha256" != 'pending' &&
			"$completion_evidence_sha256" != 'pending' ]] || return 1
	fi
}

reporting_cutover_validate_marker() {
	[[ -f "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]] || return 1
	[[ "$(reporting_stat_mode "$REPORTING_CUTOVER_MARKER")" == '600' &&
		"$(reporting_stat_owner "$REPORTING_CUTOVER_MARKER")" == '0:0' ]] || return 1
	reporting_cutover_validate_marker_contents "$REPORTING_CUTOVER_MARKER"
}

reporting_cutover_marker_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$REPORTING_CUTOVER_MARKER"
}

reporting_validate_staged_marker_contents() {
	local marker="$1"
	local line key value version='' revision='' staged_at='' seen='|'
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:cntrl:]]*$ ]] || return 1
		key="${line%%=*}"
		value="${line#*=}"
		[[ "$seen" != *"|$key|"* ]] || return 1
		seen+="$key|"
		case "$key" in
		version) version="$value" ;;
		revision) revision="$value" ;;
		staged_at) staged_at="$value" ;;
		*) return 1 ;;
		esac
	done <"$marker"
	[[ "$version" == '1' && "$revision" =~ ^[0-9a-f]{40}$ &&
		"$staged_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

reporting_validate_first_rollout_staged_marker() {
	[[ -f "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" &&
		! -L "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ]] || return 1
	[[ "$(reporting_stat_mode "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER")" == '600' &&
		"$(reporting_stat_owner "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER")" == '0:0' ]] || return 1
	reporting_validate_staged_marker_contents "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER"
}

reporting_staged_marker_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER"
}

reporting_require_staged_revision() {
	local expected_revision="$1"
	local staged_revision
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo 'Expected Reporting staged revision is invalid.' >&2
		return 1
	}
	reporting_validate_first_rollout_staged_marker || {
		echo 'A valid root-owned Reporting first-rollout staged marker is required.' >&2
		return 1
	}
	staged_revision="$(reporting_staged_marker_value revision)"
	[[ "$staged_revision" == "$expected_revision" ]] || {
		echo "Reporting first rollout is pinned to $staged_revision; refusing $expected_revision." >&2
		return 1
	}
}

reporting_write_first_rollout_staged_marker() {
	local revision="$1"
	local marker_directory temporary_marker
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	if [[ -e "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ||
		-L "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ]]; then
		reporting_require_staged_revision "$revision"
		return
	fi
	marker_directory="$(dirname "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER")"
	reporting_validate_root_owned_directory "$marker_directory" || {
		echo 'Reporting staged marker directory is missing or unsafe.' >&2
		return 1
	}
	temporary_marker="$marker_directory/.reporting-first-rollout-staged-v1.$$"
	[[ ! -e "$temporary_marker" && ! -L "$temporary_marker" ]] || return 1
	if ! {
		(umask 077; {
			printf 'version=1\n'
			printf 'revision=%s\n' "$revision"
			printf 'staged_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
		} >"$temporary_marker") &&
			chown 0:0 "$temporary_marker" &&
			chmod 600 "$temporary_marker" &&
			mv "$temporary_marker" "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER"
	}; then
		rm -f -- "$temporary_marker"
		return 1
	fi
	reporting_require_staged_revision "$revision"
}

reporting_first_rollout_deploy_action() {
	local automatic_prod_push="$1"
	local expected_revision="$2"
	local database_phase
	[[ "$automatic_prod_push" == 'true' || "$automatic_prod_push" == 'false' ]] || return 1
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	if [[ -e "$REPORTING_DATABASE_MARKER" || -L "$REPORTING_DATABASE_MARKER" ]]; then
		reporting_validate_database_marker || return 1
		database_phase="$(reporting_marker_value phase)"
		case "$database_phase" in
		prepared)
			reporting_guard_before_checkout_revision "$expected_revision" || return 1
			printf 'deploy\n'
			;;
		preparing)
			reporting_require_staged_revision "$expected_revision" >/dev/null || return 1
			printf 'block\n'
			;;
		*) return 1 ;;
		esac
		return
	fi
	if [[ "$automatic_prod_push" == 'true' ]]; then
		if [[ -e "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ||
			-L "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ]]; then
			reporting_require_staged_revision "$expected_revision" >/dev/null || return 1
		fi
		printf 'stage\n'
		return
	fi
	reporting_require_staged_revision "$expected_revision" >/dev/null || return 1
	printf 'prepare\n'
}

reporting_require_exact_post_cleanup_token_paths() {
	local revision="$1" token="$2" repository actual expected grep_status path
	shift 2
	repository="$REPORTING_APP_ROOT/winwidget.ru_server"
	if actual="$(git -C "$repository" grep -I -l -F -e "$token" \
		"$revision" -- src prisma/schema.prisma 2>/dev/null)"; then
		grep_status=0
	else
		grep_status=$?
	fi
	case "$grep_status" in
	0) ;;
	1) actual='' ;;
	*)
		echo 'Reporting post-cleanup source contract could not inspect an allowed control-plane token.' >&2
		return 1
		;;
	esac
	expected=''
	for path in "$@"; do
		expected+="${revision}:${path}"$'\n'
	done
	expected="${expected%$'\n'}"
	actual="$(printf '%s\n' "$actual" | LC_ALL=C sort)"
	expected="$(printf '%s\n' "$expected" | LC_ALL=C sort)"
	[[ "$actual" == "$expected" ]] || {
		echo 'Reporting post-cleanup control-plane token path set is not exact.' >&2
		return 1
	}
}

reporting_require_post_cleanup_revision_contract() {
	local revision="$1" repository path token grep_status
	repository="$REPORTING_APP_ROOT/winwidget.ru_server"
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	git -C "$repository" cat-file -e "$revision^{commit}" 2>/dev/null || {
		echo "Reporting post-cleanup contract cannot inspect unknown revision $revision." >&2
		return 1
	}
	for path in "${REPORTING_STEADY_STATE_REMOVED_PATHS[@]}"; do
		if git -C "$repository" cat-file -e "$revision:$path" 2>/dev/null; then
			echo "Reporting post-cleanup revision reintroduced legacy path: $path" >&2
			return 1
		fi
	done
	reporting_require_exact_post_cleanup_token_paths \
		"$revision" "$REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_TOKEN" \
		"${REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SOURCE_PATHS[@]}" || return 1
	reporting_require_exact_post_cleanup_token_paths \
		"$revision" "$REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SYMBOL" \
		"${REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SYMBOL_PATHS[@]}" || return 1
	for token in "${REPORTING_STEADY_STATE_FORBIDDEN_SOURCE_TOKENS[@]}"; do
		if git -C "$repository" grep -I -n -F -e "$token" "$revision" -- \
			src prisma/schema.prisma \
			>/dev/null 2>&1; then
			grep_status=0
		else
			grep_status=$?
		fi
		case "$grep_status" in
		1) ;;
		0)
			echo "Reporting post-cleanup revision contains forbidden legacy source token: $token" >&2
			return 1
			;;
		*)
			echo "Reporting post-cleanup source contract could not inspect token: $token" >&2
			return 1
			;;
		esac
	done
	for token in "${REPORTING_STEADY_STATE_FORBIDDEN_REPORTING_SOURCE_TOKENS[@]}"; do
		if git -C "$repository" grep -I -n -F -e "$token" "$revision" -- \
			apps/reporting/src apps/reporting/test \
			apps/reporting/prisma/schema.prisma \
			>/dev/null 2>&1; then
			grep_status=0
		else
			grep_status=$?
		fi
		case "$grep_status" in
		1) ;;
		0)
			echo "Reporting post-cleanup service source contains forbidden transitional token: $token" >&2
			return 1
			;;
		*)
			echo "Reporting post-cleanup service source contract could not inspect token: $token" >&2
			return 1
			;;
		esac
	done
}

reporting_guard_before_checkout_revision() {
	local expected_revision="$1"
	local phase lifecycle_revision cutover_phase cutover_revision cleanup_revision
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	if [[ -e "$REPORTING_DATABASE_MARKER" || -L "$REPORTING_DATABASE_MARKER" ]]; then
		reporting_validate_database_marker || {
			echo 'Reporting database lifecycle marker is invalid before checkout.' >&2
			return 1
		}
		phase="$(reporting_marker_value phase)"
		if [[ "$phase" == 'prepared' ]]; then
			lifecycle_revision="$(reporting_marker_value revision)" || return 1
			if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
				reporting_cutover_validate_marker || {
					echo 'Reporting cutover marker is invalid before checkout.' >&2
					return 1
				}
				cutover_phase="$(reporting_cutover_marker_value phase)" || return 1
				cutover_revision="$(reporting_cutover_marker_value revision)" || return 1
				[[ "$cutover_revision" == "$lifecycle_revision" ]] || {
					echo 'Reporting database and cutover markers are pinned to different revisions.' >&2
					return 1
				}
				case "$cutover_phase" in
				cleanup-staged)
					cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)" || return 1
					[[ "$expected_revision" == "$cutover_revision" ||
						"$expected_revision" == "$cleanup_revision" ]] || {
						echo "Reporting cleanup is pinned to $cutover_revision -> $cleanup_revision; refusing checkout $expected_revision." >&2
						return 1
					}
					if [[ "$expected_revision" == "$cleanup_revision" ]]; then
						reporting_require_post_cleanup_revision_contract \
							"$expected_revision" || return 1
					fi
					return
					;;
				source-cleaned)
					cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)" || return 1
					[[ "$expected_revision" == "$cleanup_revision" ]] || {
						echo "Reporting source cleanup is pinned to $cleanup_revision; refusing checkout $expected_revision." >&2
						return 1
					}
					reporting_require_post_cleanup_revision_contract \
						"$expected_revision" || return 1
					return
					;;
				complete)
					cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)" || return 1
					if [[ "$expected_revision" != "$cleanup_revision" ]]; then
						git -C "$REPORTING_APP_ROOT/winwidget.ru_server" \
							cat-file -e "$expected_revision^{commit}" 2>/dev/null || {
							echo "Reporting completed-cutover guard cannot verify unknown revision $expected_revision before checkout." >&2
							return 1
						}
						git -C "$REPORTING_APP_ROOT/winwidget.ru_server" \
							merge-base --is-ancestor "$cleanup_revision" "$expected_revision" || {
							echo "Reporting completed cutover only allows cleanup revision $cleanup_revision and its descendants; refusing checkout $expected_revision." >&2
							return 1
						}
					fi
					reporting_require_post_cleanup_revision_contract \
						"$expected_revision" || return 1
					return
					;;
				esac
				[[ "$cutover_revision" == "$expected_revision" ]] || {
					echo "Active Reporting cutover is pinned to $cutover_revision; refusing checkout $expected_revision." >&2
					return 1
				}
				return
			fi
			[[ "$lifecycle_revision" == "$expected_revision" ]] || {
				echo "Prepared Reporting database has not initialized cutover and is pinned to $lifecycle_revision; refusing checkout $expected_revision." >&2
				return 1
			}
			return
		fi
		[[ ! -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]] || {
			echo 'Reporting cutover marker cannot coexist with an incomplete database prepare.' >&2
			return 1
		}
		lifecycle_revision="$(reporting_marker_value revision)"
		[[ "$lifecycle_revision" == "$expected_revision" ]] || {
			echo "Reporting database preparation is pinned to $lifecycle_revision; refusing checkout $expected_revision." >&2
			return 1
		}
	fi
	[[ ! -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]] || {
		echo 'Reporting cutover marker exists without its prepared database marker.' >&2
		return 1
	}
	reporting_require_staged_revision "$expected_revision"
}

# Fetching an immutable Git object does not change the protected checkout or a
# runtime resource. A routes-switched cutover needs this narrow exception so an
# operator can fetch and review the future cleanup revision before fixing it in
# the durable marker. After phase=complete the object must likewise be fetched
# before the ancestry-aware checkout guard can prove it descends from cleanup.
# Every actual checkout still passes reporting_guard_before_checkout_revision
# after the fetch and therefore remains fail closed.
reporting_guard_before_fetch_revision() {
	local expected_revision="$1" phase restore_evidence
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		reporting_cutover_validate_marker || {
			echo 'Reporting cutover marker is invalid before fetch.' >&2
			return 1
		}
		phase="$(reporting_cutover_marker_value phase)" || return 1
		case "$phase" in
		routes-switched)
			restore_evidence="$(reporting_cutover_marker_value restore_evidence_sha256)" || return 1
			[[ "$restore_evidence" =~ ^[0-9a-f]{64}$ ]] || {
				echo 'Reporting cleanup candidate cannot be fetched before real restore evidence is fixed.' >&2
				return 1
			}
			return
			;;
		complete)
			return
			;;
		esac
	fi
	reporting_guard_before_checkout_revision "$expected_revision"
}

reporting_get_env_value() {
	local key="$1"
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
	' "$REPORTING_ENV_FILE"
}

reporting_require_env_key() {
	local key="$1"
	local value
	value="$(reporting_get_env_value "$key")" || {
		echo "Required production env key must occur exactly once: $key" >&2
		return 1
	}
	[[ -n "$value" && "$value" != 'XYZXYZXYZ' && "$value" != change_me* ]] || {
		echo "Production env key is missing or still a placeholder: $key" >&2
		return 1
	}
}

reporting_compose() {
	docker compose \
		--project-name winwidget \
		--env-file "$REPORTING_ENV_FILE" \
		-f "$REPORTING_COMPOSE_FILE" \
		"$@"
}

reporting_assert_no_ambient_compose_overrides() {
	local allowed_keys='|'
	local key
	local ambient_overrides=()

	for key in "$@"; do
		[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
		allowed_keys+="$key|"
	done
	while IFS= read -r key; do
		[[ -n "$key" ]] || continue
		[[ "$allowed_keys" == *"|$key|"* ]] && continue
		if printenv "$key" >/dev/null 2>&1; then
			ambient_overrides+=("$key")
		fi
	done < <(
		LC_ALL=C grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$REPORTING_COMPOSE_FILE" |
			sed 's/^${//' |
			LC_ALL=C sort -u
	)
	if ((${#ambient_overrides[@]} > 0)); then
		echo "Unset shell variables that would override $REPORTING_ENV_FILE in Reporting Compose:" >&2
		printf '%s\n' "${ambient_overrides[@]}" >&2
		return 1
	fi
}

reporting_stat_mode() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

reporting_stat_owner() {
	stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

reporting_validate_root_owned_directory() {
	local directory="$1"
	local mode
	[[ -d "$directory" && ! -L "$directory" &&
		"$(reporting_stat_owner "$directory")" == '0:0' ]] || return 1
	mode="$(reporting_stat_mode "$directory")"
	[[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
	(( (8#$mode & 8#0022) == 0 ))
}

reporting_sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

reporting_validate_production_files() {
	[[ -f "$REPORTING_ENV_FILE" && ! -L "$REPORTING_ENV_FILE" ]] || {
		echo 'Backend production env file must be a regular non-symlink file.' >&2
		return 1
	}
	[[ "$(reporting_stat_mode "$REPORTING_ENV_FILE")" == '600' &&
		"$(reporting_stat_owner "$REPORTING_ENV_FILE")" == '0:0' ]] || {
		echo 'Backend production env file must be root-owned with mode 600.' >&2
		return 1
	}
	[[ -f "$REPORTING_COMPOSE_FILE" && ! -L "$REPORTING_COMPOSE_FILE" ]] || {
		echo 'Backend production Compose file was not found.' >&2
		return 1
	}
}

reporting_transition_cleanup_integration_worker_env() {
	local revision="${1:-}" phase cleanup_revision current_value temporary
	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting cleanup env transition must run as root.' >&2
		return 1
	}
	reporting_validate_exact_revision "$revision" || return 1
	reporting_validate_production_files || return 1
	reporting_validate_root_owned_directory "$(dirname -- "$REPORTING_ENV_FILE")" || {
		echo 'Reporting cleanup env directory is unsafe.' >&2
		return 1
	}
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" &&
		! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		return 0
	fi
	reporting_cutover_validate_marker || return 1
	phase="$(reporting_cutover_marker_value phase)" || return 1
	[[ "$phase" == 'cleanup-staged' ]] || return 0
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)" || return 1
	[[ "$cleanup_revision" == "$revision" ]] || {
		echo 'Reporting cleanup env transition revision differs from the staged cleanup revision.' >&2
		return 1
	}
	current_value="$(reporting_get_env_value INTEGRATION_WORKER_KINDS)" || {
		echo 'Reporting cleanup env transition requires exactly one INTEGRATION_WORKER_KINDS line.' >&2
		return 1
	}
	if [[ "$current_value" == "$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS" ]]; then
		return 0
	fi
	[[ "$current_value" == "$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS" ]] || {
		echo 'Reporting cleanup env transition rejected an unexpected integration-worker kind set.' >&2
		return 1
	}
	temporary="${REPORTING_ENV_FILE}.reporting-cleanup.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || {
		echo 'Reporting cleanup env staging path already exists.' >&2
		return 1
	}
	umask 077
	if ! awk -F= -v replacement="$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS" '
		/^[[:space:]]*(#|$)/ { print; next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			if (name == "INTEGRATION_WORKER_KINDS") {
				print "INTEGRATION_WORKER_KINDS=" replacement
				replaced += 1
			} else {
				print
			}
		}
		END { exit(replaced == 1 ? 0 : 1) }
	' "$REPORTING_ENV_FILE" >"$temporary"; then
		rm -f -- "$temporary"
		echo 'Reporting cleanup env transition could not stage the exact line replacement.' >&2
		return 1
	fi
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	[[ -f "$temporary" && ! -L "$temporary" &&
		"$(reporting_stat_owner "$temporary")" == '0:0' &&
		"$(reporting_stat_mode "$temporary")" == '600' &&
		"$(awk -F= '$1 == "INTEGRATION_WORKER_KINDS" { print $0; found += 1 } END { exit(found == 1 ? 0 : 1) }' "$temporary")" == \
			"INTEGRATION_WORKER_KINDS=$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS" ]] || {
		rm -f -- "$temporary"
		echo 'Reporting cleanup env staging file failed exact validation.' >&2
		return 1
	}
	if ! mv -- "$temporary" "$REPORTING_ENV_FILE"; then
		rm -f -- "$temporary"
		echo 'Reporting cleanup env transition could not replace the production env atomically.' >&2
		return 1
	fi
	[[ "$(reporting_get_env_value INTEGRATION_WORKER_KINDS)" == \
		"$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS" ]] || {
		echo 'Reporting cleanup env transition did not persist the exact target value.' >&2
		return 1
	}
	echo 'Reporting cleanup integration-worker env ownership transitioned to steady state.'
}

reporting_validate_exact_revision() {
	local expected_revision="${1:-}"
	local server_root="$REPORTING_APP_ROOT/winwidget.ru_server"
	local actual_revision branch dirty

	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo 'EXPECTED_REVISION must be an exact lowercase Git SHA.' >&2
		return 1
	}
	actual_revision="$(git -C "$server_root" rev-parse HEAD)"
	branch="$(git -C "$server_root" branch --show-current)"
	dirty="$(git -C "$server_root" status --porcelain --untracked-files=all)"
	[[ "$actual_revision" == "$expected_revision" && "$branch" == 'prod' && -z "$dirty" ]] || {
		echo 'Reporting lifecycle requires a clean protected prod checkout at EXPECTED_REVISION.' >&2
		return 1
	}
}

reporting_export_pinned_runtime_identity() {
	local revision="${1:-}"
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo 'Reporting runtime identity requires an exact lowercase Git SHA.' >&2
		return 1
	}
	REPORTING_REVISION="$revision"
	REPORTING_IMAGE="winwidget-reporting:git-$revision"
	# Docker Compose interpolates the complete model even for a targeted
	# Reporting command. These exact-SHA values are parse-only identities for
	# unrelated services; Reporting lifecycle actions never operate on them.
	NOTIFICATION_DELIVERY_REVISION="$revision"
	NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$revision"
	CAMPAIGNS_REVISION="$revision"
	CAMPAIGNS_IMAGE="winwidget-campaigns:git-$revision"
	DATABASE_RESTORE_REVISION="$revision"
	DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$revision"
	export REPORTING_REVISION REPORTING_IMAGE
	export NOTIFICATION_DELIVERY_REVISION NOTIFICATION_DELIVERY_IMAGE
	export CAMPAIGNS_REVISION CAMPAIGNS_IMAGE
	export DATABASE_RESTORE_REVISION DATABASE_RESTORE_IMAGE
}

reporting_resolve_image_id_for_revision() {
	local expected_revision="${1:-}" image_reference="${2:-${REPORTING_IMAGE:-}}"
	local image_id image_revision
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ && -n "$image_reference" ]] || {
		echo 'Reporting validator image requires an exact revision and image reference.' >&2
		return 1
	}
	image_id="$(docker image inspect "$image_reference" --format '{{.Id}}' 2>/dev/null || true)"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
		echo 'The exact Reporting validator image is not present locally.' >&2
		return 1
	}
	image_revision="$(docker image inspect "$image_id" \
		--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		2>/dev/null || true)"
	[[ "$image_revision" == "$expected_revision" ]] || {
		echo 'Reporting validator image revision label differs from the expected revision.' >&2
		return 1
	}
	printf '%s\n' "$image_id"
}

reporting_run_isolated_node_validator() {
	local image_id="${1:-}" source="${2:-}"
	shift 2
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && -n "$source" ]] || return 1
	docker run --rm -i --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		"$@" --entrypoint node "$image_id" -e "$source"
}

reporting_assert_canonical_postgres_env() {
	local secret_file
	[[ "$(reporting_get_env_value REPORTING_POSTGRES_IMAGE)" == "$REPORTING_CANONICAL_POSTGRES_IMAGE" &&
		"$(reporting_get_env_value REPORTING_POSTGRES_PORT)" == "$REPORTING_CANONICAL_POSTGRES_PORT" &&
		"$(reporting_get_env_value REPORTING_POSTGRES_DATA_VOLUME)" == "$REPORTING_CANONICAL_POSTGRES_VOLUME" &&
		"$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_USER)" == "$REPORTING_CANONICAL_ADMIN_USER" ]] || {
		echo 'Reporting PostgreSQL image, port, volume or admin role differs from the reviewed canonical identity.' >&2
		return 1
	}
	secret_file="$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ "$secret_file" == "$REPORTING_APP_ROOT/deploy/backend/.reporting-postgres-admin-password" ]] || {
		echo 'REPORTING_POSTGRES_ADMIN_PASSWORD_FILE must use the canonical deploy secret path.' >&2
		return 1
	}
}

reporting_validate_runtime_numeric_env() {
	local prefetch outbox_batch_size outbox_poll_interval_ms outbox_retention_days
	prefetch="$(reporting_get_env_value REPORTING_PREFETCH)"
	outbox_batch_size="$(reporting_get_env_value REPORTING_OUTBOX_BATCH_SIZE)"
	outbox_poll_interval_ms="$(reporting_get_env_value REPORTING_OUTBOX_POLL_INTERVAL_MS)"
	outbox_retention_days="$(reporting_get_env_value REPORTING_OUTBOX_RETENTION_DAYS)"

	[[ "$prefetch" =~ ^[1-9][0-9]*$ && "$prefetch" -le 100 ]] || {
		echo 'REPORTING_PREFETCH must be between 1 and 100.' >&2
		return 1
	}
	[[ "$outbox_batch_size" =~ ^[1-9][0-9]*$ && "$outbox_batch_size" -le 500 ]] || {
		echo 'REPORTING_OUTBOX_BATCH_SIZE must be between 1 and 500.' >&2
		return 1
	}
	[[ "$outbox_poll_interval_ms" =~ ^[0-9]+$ &&
		"$outbox_poll_interval_ms" -ge 100 &&
		"$outbox_poll_interval_ms" -le 60000 ]] || {
		echo 'REPORTING_OUTBOX_POLL_INTERVAL_MS must be between 100 and 60000.' >&2
		return 1
	}
	[[ "$outbox_retention_days" =~ ^[1-9][0-9]*$ &&
		"$outbox_retention_days" -le 365 ]] || {
		echo 'REPORTING_OUTBOX_RETENTION_DAYS must be between 1 and 365.' >&2
		return 1
	}
}

reporting_validate_preflight_secret_component() {
	local decoded_value
	decoded_value="$(reporting_decode_preflight_secret_component "$1" "$2")" || return 1
	unset decoded_value
}

reporting_decode_preflight_secret_component() {
	local key="$1"
	local encoded_value="$2"
	local remainder prefix hex decoded_character decoded_value=''
	local LC_ALL=C

	[[ -n "$encoded_value" ]] || {
		echo "$key must contain a production-only secret." >&2
		return 1
	}
	[[ "$encoded_value" != *[![:graph:]]* &&
		"$encoded_value" != *'$'* &&
		"$encoded_value" != *'@'* &&
		"$encoded_value" != *'/'* &&
		"$encoded_value" != *'?'* &&
		"$encoded_value" != *'#'* &&
		"$encoded_value" != *'\'* ]] || {
		echo "$key contains an unsafe unescaped URL character." >&2
		return 1
	}

	remainder="$encoded_value"
	while [[ "$remainder" == *'%'* ]]; do
		prefix="${remainder%%\%*}"
		decoded_value+="$prefix"
		remainder="${remainder#*%}"
		hex="${remainder:0:2}"
		[[ "$hex" =~ ^(2[1-9A-Fa-f]|[3-6][0-9A-Fa-f]|7[0-9A-Ea-e])$ ]] || {
			echo "$key percent-encoding must decode to printable ASCII." >&2
			return 1
		}
		printf -v decoded_character '%b' "\\x$hex"
		decoded_value+="$decoded_character"
		remainder="${remainder:2}"
	done
	decoded_value+="$remainder"
	[[ "$decoded_value" != change_me* ]] || {
		echo "$key must contain a production-only secret." >&2
		return 1
	}
	((${#decoded_value} >= 32)) || {
		echo "$key password must contain at least 32 decoded characters." >&2
		return 1
	}
	printf '%s\n' "$decoded_value"
}

reporting_decode_preflight_url_secret() {
	local key="$1"
	local expected_prefix="$2"
	local expected_suffix="$3"
	local value encoded_password

	value="$(reporting_get_env_value "$key")" || {
		echo "Required production env key must occur exactly once: $key" >&2
		return 1
	}
	case "$value" in
	"$expected_prefix"*"$expected_suffix") ;;
	*)
		echo "$key violates the canonical role or loopback target." >&2
		return 1
		;;
	esac
	encoded_password="${value#"$expected_prefix"}"
	encoded_password="${encoded_password%"$expected_suffix"}"
	reporting_decode_preflight_secret_component "$key" "$encoded_password"
}

reporting_validate_preflight_url() {
	local decoded_value
	decoded_value="$(reporting_decode_preflight_url_secret "$1" "$2" "$3")" || return 1
	unset decoded_value
}

reporting_validate_preflight_database_urls() {
	local suffix
	suffix="@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable"
	reporting_validate_preflight_url REPORTING_DATABASE_URL \
		"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:" "$suffix"
	reporting_validate_preflight_url REPORTING_MIGRATION_DATABASE_URL \
		"postgresql://$REPORTING_CANONICAL_MIGRATION_USER:" "$suffix"
	reporting_validate_preflight_url REPORTING_BACKUP_URL \
		"postgresql://$REPORTING_CANONICAL_BACKUP_USER:" "$suffix"
}

reporting_validate_preflight_rabbitmq_url() {
	reporting_validate_preflight_url RABBITMQ_REPORTING_URL \
		'amqp://winwidget-reporting:' \
		'@127.0.0.1:5672/winwidget'
}

reporting_validate_preflight_secret_isolation() {
	local suffix runtime_password migration_password backup_password rabbit_password
	local -a passwords
	local first_index second_index
	suffix="@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable"
	runtime_password="$(reporting_decode_preflight_url_secret REPORTING_DATABASE_URL \
		"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:" "$suffix")" || return 1
	migration_password="$(reporting_decode_preflight_url_secret REPORTING_MIGRATION_DATABASE_URL \
		"postgresql://$REPORTING_CANONICAL_MIGRATION_USER:" "$suffix")" || return 1
	backup_password="$(reporting_decode_preflight_url_secret REPORTING_BACKUP_URL \
		"postgresql://$REPORTING_CANONICAL_BACKUP_USER:" "$suffix")" || return 1
	rabbit_password="$(reporting_decode_preflight_url_secret RABBITMQ_REPORTING_URL \
		'amqp://winwidget-reporting:' '@127.0.0.1:5672/winwidget')" || return 1
	passwords=("$runtime_password" "$migration_password" "$backup_password" "$rabbit_password")
	for first_index in "${!passwords[@]}"; do
		for second_index in "${!passwords[@]}"; do
			((second_index > first_index)) || continue
			[[ "${passwords[$first_index]}" != "${passwords[$second_index]}" ]] || {
				echo 'Reporting runtime, migration, backup and RabbitMQ credentials must be pairwise distinct.' >&2
				unset runtime_password migration_password backup_password rabbit_password passwords
				return 1
			}
		done
	done
	unset runtime_password migration_password backup_password rabbit_password passwords
}

reporting_validate_preflight_internal_token_value() {
	local value="$1"
	local LC_ALL=C
	[[ "$value" =~ ^[A-Za-z0-9._~-]{32,}$ &&
		"$value" != change_me* &&
		"$value" != 'ci_reporting_internal_token_at_least_32_chars' ]] || {
		echo 'REPORTING_INTERNAL_TOKEN must be an unquoted URL-safe production secret of at least 32 characters.' >&2
		return 1
	}
}

reporting_require_local_docker_daemon() {
	local context endpoint server_version
	[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" &&
		-z "${DOCKER_TLS_VERIFY:-}" && -z "${DOCKER_CERT_PATH:-}" ]] || {
		echo 'Unset ambient Docker connection overrides before Reporting lifecycle actions.' >&2
		return 1
	}
	context="$(docker context show 2>/dev/null)" || {
		echo 'Docker context is unavailable for Reporting lifecycle actions.' >&2
		return 1
	}
	endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || {
		echo 'Docker endpoint identity is unavailable for Reporting lifecycle actions.' >&2
		return 1
	}
	[[ "$endpoint" == 'unix:///var/run/docker.sock' ]] || {
		echo "Reporting lifecycle requires the local production Docker socket, current endpoint=$endpoint." >&2
		return 1
	}
	server_version="$(docker info --format '{{.ServerVersion}}' 2>/dev/null)" || {
		echo 'Local Docker daemon is unavailable for Reporting lifecycle actions.' >&2
		return 1
	}
	[[ -n "$server_version" && "$server_version" != *$'\n'* ]] || {
		echo 'Local Docker daemon returned an invalid server identity.' >&2
		return 1
	}
}

reporting_preflight_network_identity() {
	local network_ids
	network_ids="$(docker network ls --format '{{.Name}}|{{.ID}}' |
		awk -F '|' -v name="$REPORTING_CANONICAL_POSTGRES_NETWORK" \
			'$1 == name { print $2 }')" || return 1
	[[ -n "$network_ids" ]] || return 0
	[[ "$network_ids" != *$'\n'* ]] || return 1
	docker network inspect "$network_ids" \
		--format '{{printf "%s|%s|%s|%t|%s|%s" .Name .Driver .Scope .Internal (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose")}}'
}

reporting_preflight_volume_identity() {
	local volume_names
	volume_names="$(docker volume ls --format '{{.Name}}' |
		awk -v name="$REPORTING_CANONICAL_POSTGRES_VOLUME" \
			'$0 == name { print }')" || return 1
	[[ -n "$volume_names" ]] || return 0
	[[ "$volume_names" == "$REPORTING_CANONICAL_POSTGRES_VOLUME" ]] || return 1
	docker volume inspect "$volume_names" \
		--format '{{printf "%s|%s|%s|%s|%s|%s" .Name .Driver .Scope (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.lifecycle.revision")}}'
}

reporting_preflight_compose_container_ids() {
	reporting_compose --profile reporting-database ps -a -q \
		"$REPORTING_POSTGRES_SERVICE" 2>/dev/null
}

reporting_preflight_owned_container_ids() {
	docker ps -aq --no-trunc \
		--filter label=com.winwidget.owner=reporting \
		--filter label=com.winwidget.purpose=postgres | LC_ALL=C sort
}

reporting_preflight_named_container_ids() {
	docker ps -aq --no-trunc --filter name=reporting-postgres | LC_ALL=C sort
}

reporting_preflight_port_container_ids() {
	docker ps -aq --no-trunc \
		--filter "publish=$REPORTING_CANONICAL_POSTGRES_PORT" | LC_ALL=C sort
}

reporting_preflight_host_port_is_listening() {
	local socket_state
	command -v ss >/dev/null 2>&1 || {
		echo 'The ss utility is required to validate the Reporting loopback port.' >&2
		return 2
	}
	socket_state="$(ss -H -ltn)" || {
		echo 'Listening TCP sockets could not be inspected.' >&2
		return 2
	}
	printf '%s\n' "$socket_state" |
		awk -v suffix=":$REPORTING_CANONICAL_POSTGRES_PORT" '
		index($4, suffix) == length($4) - length(suffix) + 1 { found = 1 }
		END { exit(found ? 0 : 1) }
	'
}

reporting_preflight_container_running() {
	docker inspect --format '{{.State.Running}}' "$1"
}

reporting_preflight_container_health() {
	docker inspect --format \
		'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1"
}

reporting_verify_partial_postgres_container_static() {
	local container_id="$1"
	local expected_state="$2"
	local status running health restart_count exit_code oom_killed state_error
	local image_ref image_id container_labels mount secret_mount port
	local network_names mount_count network_count container_env secret_file expected_env

	[[ "$expected_state" == 'stopped' || "$expected_state" == 'starting' ]] || return 1
	status="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
	running="$(docker inspect --format '{{.State.Running}}' "$container_id")" || return 1
	health="$(reporting_preflight_container_health "$container_id")" || return 1
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
	exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")" || return 1
	oom_killed="$(docker inspect --format '{{.State.OOMKilled}}' "$container_id")" || return 1
	state_error="$(docker inspect --format '{{.State.Error}}' "$container_id")" || return 1
	image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")" || return 1
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
	container_labels="$(docker inspect --format '{{printf "%s|%s|%s|%s|%s" (index .Config.Labels "com.docker.compose.project") (index .Config.Labels "com.docker.compose.service") (index .Config.Labels "com.winwidget.owner") (index .Config.Labels "com.winwidget.purpose") .HostConfig.RestartPolicy.Name}}' "$container_id")" || return 1
	mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{printf "%s|%s|%s|%t" .Destination .Type .Name .RW}}{{end}}{{end}}' "$container_id")" || return 1
	secret_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/reporting-postgres-admin-password"}}{{printf "%s|%s|%t" .Type .Source .RW}}{{end}}{{end}}' "$container_id")" || return 1
	port="$(docker inspect --format '{{with (index .HostConfig.PortBindings "5432/tcp")}}{{printf "%s|%s|%d" (index . 0).HostIp (index . 0).HostPort (len .)}}{{end}}' "$container_id")" || return 1
	network_names="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container_id" | sed '/^$/d')" || return 1
	mount_count="$(docker inspect --format '{{len .Mounts}}' "$container_id")" || return 1
	network_count="$(docker inspect --format '{{len .NetworkSettings.Networks}}' "$container_id")" || return 1
	container_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")" || return 1
	secret_file="$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_PASSWORD_FILE)" || return 1

	case "$expected_state" in
	stopped)
		[[ "$running" == 'false' && "$exit_code" == '0' &&
			("$status" == 'created' || "$status" == 'exited') ]] || {
			echo 'Stopped Reporting PostgreSQL container state is not safely resumable.' >&2
			return 1
		}
		;;
	starting)
		[[ "$running" == 'true' && "$status" == 'running' &&
			"$health" == 'starting' && "$exit_code" == '0' ]] || {
			echo 'Starting Reporting PostgreSQL container state is not safely resumable.' >&2
			return 1
		}
		;;
	esac

	[[ "$restart_count" == '0' && "$oom_killed" == 'false' && -z "$state_error" &&
		"$image_ref" == "$REPORTING_CANONICAL_POSTGRES_IMAGE" &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$container_labels" == 'winwidget|reporting-postgres|reporting|postgres|unless-stopped' &&
		"$mount_count" == '2' &&
		"$mount" == "/var/lib/postgresql|volume|$REPORTING_CANONICAL_POSTGRES_VOLUME|true" &&
		"$secret_mount" == "bind|$secret_file|false" &&
		"$port" == "127.0.0.1|$REPORTING_CANONICAL_POSTGRES_PORT|1" &&
		"$network_count" == '1' &&
		"$network_names" == "$REPORTING_CANONICAL_POSTGRES_NETWORK" ]] || {
		echo 'Partial Reporting PostgreSQL container is not safely resumable.' >&2
		return 1
	}
	for expected_env in \
		"POSTGRES_DB=$REPORTING_CANONICAL_DATABASE" \
		"POSTGRES_USER=$REPORTING_CANONICAL_ADMIN_USER" \
		'POSTGRES_PASSWORD_FILE=/run/secrets/reporting-postgres-admin-password' \
		'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		'PGDATA=/var/lib/postgresql/18/docker'; do
		[[ "$(printf '%s\n' "$container_env" | grep -Fxc "$expected_env")" == '1' ]] || {
			echo 'Partial Reporting PostgreSQL environment invariant failed.' >&2
			return 1
		}
	done
}

reporting_validate_preparing_resources() {
	local revision="$1"
	local mode="${2:-resume}"
	local container_id container_running network_identity volume_identity
	local owned_ids named_ids port_ids
	local expected_network="$REPORTING_CANONICAL_POSTGRES_NETWORK|bridge|local|false|reporting|postgres-network"
	local expected_volume="$REPORTING_CANONICAL_POSTGRES_VOLUME|local|local|reporting|postgres-data|$revision"
	[[ "$mode" == 'resume' || "$mode" == 'absent' ]] || return 1

	container_id="$(reporting_preflight_compose_container_ids)" || return 1
	network_identity="$(reporting_preflight_network_identity)" || return 1
	volume_identity="$(reporting_preflight_volume_identity)" || return 1
	owned_ids="$(reporting_preflight_owned_container_ids)" || return 1
	named_ids="$(reporting_preflight_named_container_ids)" || return 1
	port_ids="$(reporting_preflight_port_container_ids)" || return 1

	if [[ "$mode" == 'absent' ]]; then
		[[ -z "$container_id" && -z "$network_identity" &&
			-z "$volume_identity" && -z "$owned_ids" &&
			-z "$named_ids" && -z "$port_ids" ]] || {
			echo 'Untracked Reporting PostgreSQL resource exists without a lifecycle marker.' >&2
			return 1
		}
		if reporting_preflight_host_port_is_listening; then
			echo "Loopback port $REPORTING_CANONICAL_POSTGRES_PORT is already occupied." >&2
			return 1
		else
			case "$?" in
			1) return 0 ;;
			*) return 1 ;;
			esac
		fi
	fi

	[[ -z "$network_identity" || "$network_identity" == "$expected_network" ]] || {
		echo 'Existing Reporting PostgreSQL network has an unsafe identity.' >&2
		return 1
	}
	[[ -z "$volume_identity" || "$volume_identity" == "$expected_volume" ]] || {
		echo 'Existing Reporting PostgreSQL volume has an unsafe identity.' >&2
		return 1
	}
	if [[ -n "$container_id" ]]; then
		[[ "$network_identity" == "$expected_network" &&
			"$volume_identity" == "$expected_volume" &&
			"$container_id" != *$'\n'* &&
			"$owned_ids" == "$container_id" &&
			"$named_ids" == "$container_id" &&
			"$port_ids" == "$container_id" ]] || {
			echo 'Reporting PostgreSQL has colliding or multiply-owned containers.' >&2
			return 1
		}
		container_running="$(reporting_preflight_container_running "$container_id")" || return 1
		case "$container_running" in
		true)
			case "$(reporting_preflight_container_health "$container_id")" in
			healthy)
				reporting_verify_postgres_container >/dev/null || {
					echo 'Running partial Reporting PostgreSQL failed its read-only identity check.' >&2
					return 1
				}
				;;
			starting)
				reporting_verify_partial_postgres_container_static \
					"$container_id" starting || return 1
				;;
			*)
				echo 'Running partial Reporting PostgreSQL is not healthy or safely starting.' >&2
				return 1
				;;
			esac
			;;
		false)
			reporting_verify_partial_postgres_container_static \
				"$container_id" stopped || return 1
			;;
		*) return 1 ;;
		esac
	else
		[[ -z "$owned_ids" && -z "$named_ids" && -z "$port_ids" ]] || {
			echo 'A foreign or detached container conflicts with Reporting PostgreSQL.' >&2
			return 1
		}
		if reporting_preflight_host_port_is_listening; then
			echo "Loopback port $REPORTING_CANONICAL_POSTGRES_PORT is already occupied." >&2
			return 1
		else
			case "$?" in
			1) ;;
			*) return 1 ;;
			esac
		fi
	fi
	if [[ -n "$container_id" || -n "$volume_identity" ]]; then
		reporting_secret_snapshot >/dev/null || {
			echo 'Reporting resources exist but their admin secret is missing or invalid.' >&2
			return 1
		}
	fi
}

reporting_validate_preflight_state() {
	local revision="$1"
	local action="$2"
	local marker_revision marker_phase marker_container_id marker_image_id
	local marker_system_identifier
	[[ "$action" == 'prepare' || "$action" == 'status' ]] || return 1
	if [[ -e "$REPORTING_DATABASE_MARKER" || -L "$REPORTING_DATABASE_MARKER" ]]; then
		reporting_validate_database_marker || {
			echo 'Existing Reporting database lifecycle marker is invalid.' >&2
			return 1
		}
		marker_revision="$(reporting_marker_value revision)" || return 1
		marker_phase="$(reporting_marker_value phase)" || return 1
		[[ "$action" != 'prepare' && "$marker_phase" != 'preparing' ]] ||
			[[ "$marker_revision" == "$revision" ]] || {
			echo "Reporting database preparation is pinned to $marker_revision; refusing $revision." >&2
			return 1
		}
		if [[ "$marker_phase" == 'preparing' ]]; then
			reporting_require_staged_revision "$marker_revision" || return 1
			reporting_validate_preparing_resources "$marker_revision" || return 1
			return
		fi
		marker_container_id="$(reporting_marker_value container_id)" || return 1
		marker_image_id="$(reporting_marker_value postgres_image_id)" || return 1
		marker_system_identifier="$(
			reporting_marker_value postgres_system_identifier
		)" || return 1
		reporting_verify_postgres_container \
			"$marker_container_id" "$marker_image_id" \
			"$marker_system_identifier" >/dev/null || {
			echo 'Prepared Reporting database resources failed the read-only preflight.' >&2
			return 1
		}
		reporting_verify_role_boundaries || {
			echo 'Prepared Reporting database role boundaries failed the read-only preflight.' >&2
			return 1
		}
		reporting_secret_snapshot >/dev/null || {
			echo 'Reporting PostgreSQL admin secret is missing or invalid.' >&2
			return 1
		}
		return
	fi
	reporting_require_staged_revision "$revision" || return 1
	reporting_validate_preparing_resources "$revision" absent || return 1
}

reporting_preflight_env_contract() {
	local revision="$1"
	local action="$2"
	local key internal_token internal_timeout scheduler_enabled
	local env_snapshot_before env_snapshot_after

	reporting_validate_exact_revision "$revision"
	reporting_validate_production_files
	reporting_require_local_docker_daemon
	env_snapshot_before="$(reporting_sha256_file "$REPORTING_ENV_FILE")"
	[[ "$env_snapshot_before" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Reporting production env snapshot could not be captured.' >&2
		return 1
	}
	case "$action" in
	prepare) reporting_require_staged_revision "$revision" ;;
	status) ;;
	*)
		echo 'Reporting env preflight action must be prepare or status.' >&2
		return 1
		;;
	esac
	reporting_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	for key in \
		REPORTING_POSTGRES_IMAGE REPORTING_POSTGRES_PORT \
		REPORTING_POSTGRES_DATA_VOLUME REPORTING_POSTGRES_ADMIN_USER \
		REPORTING_POSTGRES_ADMIN_PASSWORD_FILE REPORTING_DATABASE_URL \
		REPORTING_MIGRATION_DATABASE_URL REPORTING_BACKUP_URL \
		REPORTING_PROCESS_ROLE REPORTING_LISTEN_HOST REPORTING_PORT \
		REPORTING_CORE_INTERNAL_BASE_URL REPORTING_INTERNAL_TOKEN \
		REPORTING_INTERNAL_TIMEOUT_MS REPORTING_SCHEDULER_ENABLED \
		REPORTING_PREFETCH REPORTING_OUTBOX_BATCH_SIZE \
		REPORTING_OUTBOX_POLL_INTERVAL_MS REPORTING_OUTBOX_RETENTION_DAYS \
		CORS_ALLOWED_ORIGINS RABBITMQ_REPORTING_URL INTEGRATION_WORKER_KINDS; do
		reporting_require_env_key "$key"
	done
	reporting_assert_canonical_postgres_env
	reporting_validate_admin_secret_precondition
	reporting_validate_preflight_database_urls
	reporting_validate_preflight_rabbitmq_url
	reporting_validate_preflight_secret_isolation
	[[ "$(reporting_get_env_value REPORTING_PROCESS_ROLE)" == 'all' ]] || {
		echo 'Current single-VPS Reporting deployment requires REPORTING_PROCESS_ROLE=all.' >&2
		return 1
	}
	[[ "$(reporting_get_env_value REPORTING_LISTEN_HOST)" == '127.0.0.1' ]] || {
		echo 'REPORTING_LISTEN_HOST must remain loopback-only.' >&2
		return 1
	}
	[[ "$(reporting_get_env_value REPORTING_PORT)" == '4600' ]] || {
		echo 'REPORTING_PORT must use the reviewed loopback port 4600.' >&2
		return 1
	}
	[[ "$(reporting_get_env_value REPORTING_CORE_INTERNAL_BASE_URL)" == \
		'http://127.0.0.1:4200' ]] || {
		echo 'REPORTING_CORE_INTERNAL_BASE_URL must use the reviewed loopback core endpoint.' >&2
		return 1
	}
	internal_token="$(reporting_get_env_value REPORTING_INTERNAL_TOKEN)"
	reporting_validate_preflight_internal_token_value "$internal_token"
	unset internal_token
	internal_timeout="$(reporting_get_env_value REPORTING_INTERNAL_TIMEOUT_MS)"
	[[ "$internal_timeout" =~ ^[0-9]+$ &&
		"$internal_timeout" -ge 500 && "$internal_timeout" -le 60000 ]] || {
		echo 'REPORTING_INTERNAL_TIMEOUT_MS must be between 500 and 60000.' >&2
		return 1
	}
	scheduler_enabled="$(reporting_get_env_value REPORTING_SCHEDULER_ENABLED)"
	[[ "$scheduler_enabled" == 'false' || "$scheduler_enabled" == 'true' ]] || {
		echo 'REPORTING_SCHEDULER_ENABLED must be true or false.' >&2
		return 1
	}
	[[ "$action" != 'prepare' || "$scheduler_enabled" == 'false' ]] || {
		echo 'REPORTING_SCHEDULER_ENABLED must remain false during phase-A database prepare.' >&2
		return 1
	}
	reporting_validate_runtime_numeric_env
	[[ "$(reporting_get_env_value INTEGRATION_WORKER_KINDS)" == \
		"$(reporting_expected_integration_worker_kinds)" ]] || {
		echo 'INTEGRATION_WORKER_KINDS differs from the reviewed Reporting audit-consumer set.' >&2
		return 1
	}
	reporting_compose \
		--profile reporting-migration \
		--profile reporting-database \
		config --quiet
	case "$action" in
	prepare|status) reporting_validate_preflight_state "$revision" "$action" || return 1 ;;
	esac
	env_snapshot_after="$(reporting_sha256_file "$REPORTING_ENV_FILE")"
	[[ "$env_snapshot_after" == "$env_snapshot_before" ]] || {
		echo 'Reporting production env changed during preflight; retry from a stable file.' >&2
		return 1
	}
	echo "Reporting production env/Compose preflight passed for revision $revision; no runtime resource changed."
}

reporting_parse_database_url() {
	local key="$1"
	local expected_user="$2"
	local url parser_image
	url="$(reporting_get_env_value "$key")"
	parser_image="$(reporting_resolve_image_id_for_revision "${REPORTING_REVISION:-}")" || return 1
	printf '%s' "$url" | reporting_run_isolated_node_validator "$parser_image" '
const { readFileSync } = require("node:fs");
const input = readFileSync(0, "utf8");
let url;
try {
  url = new URL(input);
} catch {
  process.stderr.write("Reporting database URL is invalid\n");
  process.exit(1);
}
const fail = message => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
let username;
let password;
let database;
try {
  username = decodeURIComponent(url.username);
  password = decodeURIComponent(url.password);
  database = decodeURIComponent(url.pathname.slice(1));
} catch {
  fail("Reporting database URL contains invalid percent-encoding");
}
const allowedParameters = new Set([
  "schema",
  "sslmode",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "statement_cache_size",
]);
for (const key of url.searchParams.keys()) {
  if (!allowedParameters.has(key)) {
    fail("Reporting database URL contains an unsupported parameter");
  }
}
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  username !== process.env.REPORTING_URL_EXPECTED_USER ||
  !password ||
  password.length < 32 ||
  /[\u0000-\u001f\u007f]/.test(password) ||
  url.hostname !== "127.0.0.1" ||
  (url.port || "5432") !== process.env.REPORTING_URL_EXPECTED_PORT ||
  database !== process.env.REPORTING_URL_EXPECTED_DATABASE ||
  url.hash ||
  url.searchParams.getAll("schema").length !== 1 ||
  url.searchParams.get("schema") !== process.env.REPORTING_URL_EXPECTED_SCHEMA ||
  url.searchParams.getAll("sslmode").length !== 1 ||
  url.searchParams.get("sslmode") !== "disable"
) {
  fail("Reporting database URL violates the canonical role or loopback boundary");
}
process.stdout.write(password);
' \
		-e "REPORTING_URL_EXPECTED_USER=$expected_user" \
		-e "REPORTING_URL_EXPECTED_PORT=$REPORTING_CANONICAL_POSTGRES_PORT" \
		-e "REPORTING_URL_EXPECTED_DATABASE=$REPORTING_CANONICAL_DATABASE" \
		-e "REPORTING_URL_EXPECTED_SCHEMA=$REPORTING_CANONICAL_SCHEMA"
}

reporting_validate_database_urls() {
	reporting_parse_database_url REPORTING_DATABASE_URL "$REPORTING_CANONICAL_RUNTIME_USER" >/dev/null
	reporting_parse_database_url REPORTING_MIGRATION_DATABASE_URL "$REPORTING_CANONICAL_MIGRATION_USER" >/dev/null
	reporting_parse_database_url REPORTING_BACKUP_URL "$REPORTING_CANONICAL_BACKUP_USER" >/dev/null
}

reporting_secret_snapshot() {
	local secret_file secret_value secret_hash
	secret_file="$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ -f "$secret_file" && ! -L "$secret_file" &&
		"$(reporting_stat_mode "$secret_file")" == '600' &&
		"$(reporting_stat_owner "$secret_file")" == '0:0' ]] || return 1
	secret_value="$(tr -d '\r\n' <"$secret_file")"
	[[ "$secret_value" =~ ^[0-9a-f]{64}$ &&
		"$(wc -l <"$secret_file" | tr -d '[:space:]')" == '1' ]] || return 1
	secret_hash="$(reporting_sha256_file "$secret_file")"
	[[ "$secret_hash" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s|%s|%s\n' \
		"$(reporting_stat_mode "$secret_file"):$(reporting_stat_owner "$secret_file"):$(wc -c <"$secret_file" | tr -d '[:space:]')" \
		"$secret_hash" \
		"$secret_file"
}

reporting_validate_admin_secret_precondition() {
	local secret_file secret_directory
	secret_file="$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_PASSWORD_FILE)"
	secret_directory="$(dirname "$secret_file")"
	reporting_validate_root_owned_directory "$secret_directory" || {
		echo 'Reporting PostgreSQL admin secret directory is missing or unsafe.' >&2
		return 1
	}
	if [[ -e "$secret_file" || -L "$secret_file" ]]; then
		reporting_secret_snapshot >/dev/null || {
			echo 'Existing Reporting PostgreSQL admin secret is invalid.' >&2
			return 1
		}
	fi
}

reporting_create_admin_secret_if_missing() {
	local secret_file temporary_file
	secret_file="$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_PASSWORD_FILE)"
	if [[ -e "$secret_file" || -L "$secret_file" ]]; then
		reporting_secret_snapshot >/dev/null || {
			echo 'Existing Reporting PostgreSQL admin secret is invalid.' >&2
			return 1
		}
		return
	fi
	if docker volume inspect "$REPORTING_CANONICAL_POSTGRES_VOLUME" >/dev/null 2>&1 ||
		[[ -n "$(reporting_postgres_container_id)" ]]; then
		echo 'Reporting PostgreSQL resources already exist; refusing to regenerate the missing admin secret.' >&2
		return 1
	fi
	reporting_validate_root_owned_directory "$(dirname "$secret_file")" || {
		echo 'Reporting PostgreSQL admin secret directory is missing or unsafe.' >&2
		return 1
	}
	temporary_file="$(dirname "$secret_file")/.reporting-postgres-admin-password.$$"
	[[ ! -e "$temporary_file" && ! -L "$temporary_file" ]] || return 1
	if ! {
		(umask 077; openssl rand -hex 32 >"$temporary_file") &&
			chown 0:0 "$temporary_file" &&
			chmod 600 "$temporary_file" &&
			mv "$temporary_file" "$secret_file"
	}; then
		rm -f -- "$temporary_file"
		return 1
	fi
	reporting_secret_snapshot >/dev/null
}

reporting_marker_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$REPORTING_DATABASE_MARKER"
}

reporting_validate_marker_contents() {
	local marker="$1"
	local line key value
	local version='' phase='' revision='' target_volume='' postgres_image=''
	local postgres_image_id='' postgres_system_identifier='' container_id=''
	local prepared_at='' seen='|'

	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:cntrl:]]*$ ]] || return 1
		key="${line%%=*}"
		value="${line#*=}"
		[[ "$seen" != *"|$key|"* ]] || return 1
		seen+="$key|"
		case "$key" in
		version) version="$value" ;;
		phase) phase="$value" ;;
		revision) revision="$value" ;;
		target_volume) target_volume="$value" ;;
		postgres_image) postgres_image="$value" ;;
		postgres_image_id) postgres_image_id="$value" ;;
		postgres_system_identifier) postgres_system_identifier="$value" ;;
		container_id) container_id="$value" ;;
		prepared_at) prepared_at="$value" ;;
		*) return 1 ;;
		esac
	done <"$marker"

	[[ "$version" == '1' && "$phase" =~ ^(preparing|prepared)$ &&
		"$revision" =~ ^[0-9a-f]{40}$ &&
		"$target_volume" == "$REPORTING_CANONICAL_POSTGRES_VOLUME" &&
		"$postgres_image" == "$REPORTING_CANONICAL_POSTGRES_IMAGE" &&
		"$prepared_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	if [[ "$phase" == 'preparing' ]]; then
		[[ "$postgres_image_id" == 'pending' &&
			"$postgres_system_identifier" == 'pending' &&
			"$container_id" == 'pending' ]] || return 1
	else
		[[ "$postgres_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$postgres_system_identifier" =~ ^[0-9]+$ &&
			"$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	fi
}

reporting_validate_database_marker() {
	[[ -f "$REPORTING_DATABASE_MARKER" && ! -L "$REPORTING_DATABASE_MARKER" ]] || return 1
	[[ "$(reporting_stat_mode "$REPORTING_DATABASE_MARKER")" == '600' &&
		"$(reporting_stat_owner "$REPORTING_DATABASE_MARKER")" == '0:0' ]] || return 1
	reporting_validate_marker_contents "$REPORTING_DATABASE_MARKER"
}

reporting_write_database_marker() {
	local phase="$1"
	local revision="$2"
	local image_id="${3:-pending}"
	local system_identifier="${4:-pending}"
	local container_id="${5:-pending}"
	local marker_directory temporary_marker timestamp

	marker_directory="$(dirname "$REPORTING_DATABASE_MARKER")"
	reporting_validate_root_owned_directory "$marker_directory" || return 1
	temporary_marker="$marker_directory/.reporting-database-lifecycle-v1.$$"
	[[ ! -e "$temporary_marker" && ! -L "$temporary_marker" ]] || return 1
	timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	if ! {
		(umask 077; {
			printf 'version=1\n'
			printf 'phase=%s\n' "$phase"
			printf 'revision=%s\n' "$revision"
			printf 'target_volume=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME"
			printf 'postgres_image=%s\n' "$REPORTING_CANONICAL_POSTGRES_IMAGE"
			printf 'postgres_image_id=%s\n' "$image_id"
			printf 'postgres_system_identifier=%s\n' "$system_identifier"
			printf 'container_id=%s\n' "$container_id"
			printf 'prepared_at=%s\n' "$timestamp"
		} >"$temporary_marker") &&
			chown 0:0 "$temporary_marker" &&
			chmod 600 "$temporary_marker" &&
			mv -f "$temporary_marker" "$REPORTING_DATABASE_MARKER"
	}; then
		rm -f -- "$temporary_marker"
		return 1
	fi
	reporting_validate_database_marker
}

reporting_postgres_container_id() {
	reporting_compose --profile reporting-database ps -a -q "$REPORTING_POSTGRES_SERVICE" 2>/dev/null || true
}

reporting_postgres_system_identifier() {
	local container_id="$1"
	docker exec "$container_id" \
		psql --no-psqlrc --tuples-only --no-align \
			--username "$REPORTING_CANONICAL_ADMIN_USER" \
			--dbname postgres \
			--command 'SELECT system_identifier FROM pg_control_system();' 2>/dev/null |
		tr -d '[:space:]'
}

reporting_container_snapshot() {
	docker inspect --format \
		'{{.Id}}|{{.Image}}|{{.Created}}|{{.State.StartedAt}}|{{.RestartCount}}' "$1"
}

reporting_volume_snapshot() {
	docker volume inspect --format \
		'{{.Name}}|{{.Driver}}|{{.Scope}}|{{.Mountpoint}}|{{json .Options}}|{{json .Labels}}|{{.CreatedAt}}' "$1"
}

reporting_verify_postgres_container() {
	local expected_container_id="${1:-}"
	local expected_image_id="${2:-}"
	local expected_system_identifier="${3:-}"
	local container_id running health image_ref image_id restart_count mount port network
	local volume_labels volume_attachments system_identifier database_identity
	local container_labels secret_mount container_env secret_file expected_env

	container_id="$(reporting_postgres_container_id)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || {
		echo 'Exactly one canonical Reporting PostgreSQL container is required.' >&2
		return 1
	}
	[[ -z "$expected_container_id" || "$container_id" == "$expected_container_id" ]] || {
		echo 'Reporting PostgreSQL container identity changed.' >&2
		return 1
	}
	running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
	image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	container_labels="$(docker inspect --format '{{printf "%s|%s|%s|%s|%s" (index .Config.Labels "com.docker.compose.project") (index .Config.Labels "com.docker.compose.service") (index .Config.Labels "com.winwidget.owner") (index .Config.Labels "com.winwidget.purpose") .HostConfig.RestartPolicy.Name}}' "$container_id")"
	mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{printf "%s|%s|%s|%t" .Destination .Type .Name .RW}}{{end}}{{end}}' "$container_id")"
	secret_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/reporting-postgres-admin-password"}}{{printf "%s|%s|%t" .Type .Source .RW}}{{end}}{{end}}' "$container_id")"
	container_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")"
	secret_file="$(reporting_get_env_value REPORTING_POSTGRES_ADMIN_PASSWORD_FILE)"
	port="$(docker inspect --format '{{with (index .NetworkSettings.Ports "5432/tcp")}}{{printf "%s|%s|%d" (index . 0).HostIp (index . 0).HostPort (len .)}}{{end}}' "$container_id")"
	network="$(docker network inspect "$REPORTING_CANONICAL_POSTGRES_NETWORK" --format '{{printf "%s|%s|%t|%s|%s" .Driver .Scope .Internal (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose")}}' 2>/dev/null || true)"
	volume_labels="$(docker volume inspect "$REPORTING_CANONICAL_POSTGRES_VOLUME" --format '{{printf "%s|%s|%s" (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.lifecycle.revision")}}' 2>/dev/null || true)"
	volume_attachments="$(docker ps -aq --no-trunc --filter "volume=$REPORTING_CANONICAL_POSTGRES_VOLUME" | sort)"
	system_identifier="$(reporting_postgres_system_identifier "$container_id")"
	database_identity="$(docker exec "$container_id" psql --no-psqlrc --tuples-only --no-align --field-separator='|' --username "$REPORTING_CANONICAL_ADMIN_USER" --dbname "$REPORTING_CANONICAL_DATABASE" --command "SELECT current_database(), current_user, current_setting('server_version_num')::INTEGER / 10000, current_setting('data_checksums'), current_setting('data_directory');" | tr -d '[:space:]')"

	[[ "$running" == 'true' && "$health" == 'healthy' && "$restart_count" == '0' &&
		"$image_ref" == "$REPORTING_CANONICAL_POSTGRES_IMAGE" &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$container_labels" == 'winwidget|reporting-postgres|reporting|postgres|unless-stopped' &&
		"$mount" == "/var/lib/postgresql|volume|$REPORTING_CANONICAL_POSTGRES_VOLUME|true" &&
		"$secret_mount" == "bind|$secret_file|false" &&
		"$port" == "127.0.0.1|$REPORTING_CANONICAL_POSTGRES_PORT|1" &&
		"$network" == 'bridge|local|false|reporting|postgres-network' &&
		"$volume_labels" == "reporting|postgres-data|$(reporting_marker_value revision)" &&
		"$volume_attachments" == "$container_id" &&
		"$system_identifier" =~ ^[0-9]+$ &&
		"$database_identity" == "$REPORTING_CANONICAL_DATABASE|$REPORTING_CANONICAL_ADMIN_USER|18|on|/var/lib/postgresql/18/docker" ]] || {
		echo 'Canonical Reporting PostgreSQL container, volume, network or database invariant failed.' >&2
		return 1
	}
	for expected_env in \
		"POSTGRES_DB=$REPORTING_CANONICAL_DATABASE" \
		"POSTGRES_USER=$REPORTING_CANONICAL_ADMIN_USER" \
		'POSTGRES_PASSWORD_FILE=/run/secrets/reporting-postgres-admin-password' \
		'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		'PGDATA=/var/lib/postgresql/18/docker'; do
		[[ "$(printf '%s\n' "$container_env" | grep -Fxc "$expected_env")" == '1' ]] || {
			echo 'Canonical Reporting PostgreSQL environment invariant failed.' >&2
			return 1
		}
	done
	[[ -z "$expected_image_id" || "$image_id" == "$expected_image_id" ]] || return 1
	[[ -z "$expected_system_identifier" || "$system_identifier" == "$expected_system_identifier" ]] || return 1
	printf '%s\n' "$container_id"
}

reporting_wait_for_postgres() {
	local attempts="${REPORTING_POSTGRES_HEALTHCHECK_ATTEMPTS:-60}"
	local interval="${REPORTING_POSTGRES_HEALTHCHECK_INTERVAL:-2}"
	local attempt container_id health
	for ((attempt = 1; attempt <= attempts; attempt++)); do
		container_id="$(reporting_postgres_container_id)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
			[[ "$health" == 'healthy' ]] && return 0
		fi
		sleep "$interval"
	done
	return 1
}

reporting_configure_roles_and_schema() {
	local container_id runtime_password migration_password backup_password
	container_id="$(reporting_postgres_container_id)"
	runtime_password="$(reporting_parse_database_url REPORTING_DATABASE_URL "$REPORTING_CANONICAL_RUNTIME_USER")"
	migration_password="$(reporting_parse_database_url REPORTING_MIGRATION_DATABASE_URL "$REPORTING_CANONICAL_MIGRATION_USER")"
	backup_password="$(reporting_parse_database_url REPORTING_BACKUP_URL "$REPORTING_CANONICAL_BACKUP_USER")"
	{
		printf '%s\n' "$runtime_password"
		printf '%s\n' "$migration_password"
		printf '%s\n' "$backup_password"
		cat <<'SQL'
\getenv reporting_runtime_password REPORTING_RUNTIME_PASSWORD
\getenv reporting_migration_password REPORTING_MIGRATION_PASSWORD
\getenv reporting_backup_password REPORTING_BACKUP_PASSWORD
SELECT format(
  'CREATE ROLE winwidget_reporting_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'reporting_runtime_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_reporting_runtime') \gexec
SELECT format(
  'CREATE ROLE winwidget_reporting_migration LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'reporting_migration_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_reporting_migration') \gexec
SELECT format(
  'CREATE ROLE winwidget_reporting_backup LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'reporting_backup_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_reporting_backup') \gexec
SELECT format('ALTER ROLE winwidget_reporting_runtime PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'reporting_runtime_password') \gexec
SELECT format('ALTER ROLE winwidget_reporting_migration PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'reporting_migration_password') \gexec
SELECT format('ALTER ROLE winwidget_reporting_backup PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'reporting_backup_password') \gexec
REVOKE ALL ON DATABASE winwidget_reporting FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_reporting TO winwidget_reporting_runtime, winwidget_reporting_migration, winwidget_reporting_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_reporting FROM winwidget_reporting_runtime, winwidget_reporting_migration, winwidget_reporting_backup;
CREATE SCHEMA IF NOT EXISTS reporting AUTHORIZATION winwidget_reporting_migration;
ALTER SCHEMA reporting OWNER TO winwidget_reporting_migration;
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
REVOKE ALL ON SCHEMA reporting FROM winwidget_reporting_runtime, winwidget_reporting_backup;
GRANT USAGE ON SCHEMA reporting TO winwidget_reporting_runtime, winwidget_reporting_backup;
GRANT USAGE, CREATE ON SCHEMA reporting TO winwidget_reporting_migration;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  REVOKE ALL ON TABLES FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT SELECT ON TABLES TO winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT SELECT ON SEQUENCES TO winwidget_reporting_backup;
SQL
	} | docker exec -i "$container_id" sh -euc '
IFS= read -r REPORTING_RUNTIME_PASSWORD
IFS= read -r REPORTING_MIGRATION_PASSWORD
IFS= read -r REPORTING_BACKUP_PASSWORD
export REPORTING_RUNTIME_PASSWORD REPORTING_MIGRATION_PASSWORD REPORTING_BACKUP_PASSWORD
exec psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username winwidget_reporting_admin --dbname winwidget_reporting --file -
'
	unset runtime_password migration_password backup_password
}

reporting_reconcile_database_acl() {
	local container_id
	container_id="$(reporting_postgres_container_id)"
	docker exec -i "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username "$REPORTING_CANONICAL_ADMIN_USER" \
		--dbname "$REPORTING_CANONICAL_DATABASE" --file - <<'SQL'
REVOKE ALL ON ALL TABLES IN SCHEMA reporting FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA reporting FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reporting FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reporting TO winwidget_reporting_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA reporting TO winwidget_reporting_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO winwidget_reporting_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA reporting TO winwidget_reporting_backup;
REVOKE ALL ON TABLE reporting._prisma_migrations FROM winwidget_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  REVOKE ALL ON TABLES FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_reporting_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT SELECT ON TABLES TO winwidget_reporting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration IN SCHEMA reporting
  GRANT SELECT ON SEQUENCES TO winwidget_reporting_backup;
SQL
}

reporting_verify_role_boundaries() {
	local container_id role_state
	container_id="$(reporting_postgres_container_id)"
	role_state="$(docker exec "$container_id" psql --no-psqlrc --tuples-only --no-align \
		--username "$REPORTING_CANONICAL_ADMIN_USER" \
		--dbname "$REPORTING_CANONICAL_DATABASE" --command "
SELECT CASE WHEN
  (SELECT count(*) FROM pg_roles WHERE rolname IN (
    '$REPORTING_CANONICAL_RUNTIME_USER',
    '$REPORTING_CANONICAL_MIGRATION_USER',
    '$REPORTING_CANONICAL_BACKUP_USER'
  )) = 3
  AND NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN (
      '$REPORTING_CANONICAL_RUNTIME_USER',
      '$REPORTING_CANONICAL_MIGRATION_USER',
      '$REPORTING_CANONICAL_BACKUP_USER'
    )
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit)
  )
  AND (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '$REPORTING_CANONICAL_SCHEMA') = '$REPORTING_CANONICAL_MIGRATION_USER'
  AND NOT has_database_privilege('$REPORTING_CANONICAL_RUNTIME_USER', current_database(), 'CREATE')
  AND NOT has_database_privilege('$REPORTING_CANONICAL_MIGRATION_USER', current_database(), 'CREATE')
  AND NOT has_database_privilege('$REPORTING_CANONICAL_BACKUP_USER', current_database(), 'CREATE')
  AND NOT has_schema_privilege('$REPORTING_CANONICAL_RUNTIME_USER', '$REPORTING_CANONICAL_SCHEMA', 'CREATE')
  AND has_schema_privilege('$REPORTING_CANONICAL_MIGRATION_USER', '$REPORTING_CANONICAL_SCHEMA', 'CREATE')
  AND NOT has_schema_privilege('$REPORTING_CANONICAL_BACKUP_USER', '$REPORTING_CANONICAL_SCHEMA', 'CREATE')
  AND (
    SELECT count(*) = 1
      AND bool_and(
        privilege.grantor = to_regrole('$REPORTING_CANONICAL_MIGRATION_USER')::oid
        AND privilege.grantee = to_regrole('$REPORTING_CANONICAL_MIGRATION_USER')::oid
        AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable
      )
    FROM pg_default_acl defaults
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
    WHERE defaults.defaclrole = to_regrole('$REPORTING_CANONICAL_MIGRATION_USER')::oid
      AND defaults.defaclnamespace = 0
      AND defaults.defaclobjtype = 'f'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_default_acl defaults
    JOIN pg_namespace namespace_state ON namespace_state.oid = defaults.defaclnamespace
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
    WHERE defaults.defaclrole = to_regrole('$REPORTING_CANONICAL_MIGRATION_USER')::oid
      AND namespace_state.nspname = '$REPORTING_CANONICAL_SCHEMA'
      AND defaults.defaclobjtype = 'f'
      AND privilege.grantee <> to_regrole('$REPORTING_CANONICAL_MIGRATION_USER')::oid
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc routine
    JOIN pg_namespace namespace_state ON namespace_state.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(routine.proacl, acldefault('f', routine.proowner))
    ) privilege
    WHERE namespace_state.nspname = '$REPORTING_CANONICAL_SCHEMA'
      AND privilege.grantee <> routine.proowner
  )
THEN 'ok' ELSE 'unsafe' END;
")"
	[[ "$role_state" == 'ok' ]] || {
		echo 'Reporting runtime, migration or backup role boundary is unsafe.' >&2
		return 1
	}
}

reporting_libpq_url() {
	local key="$1"
	local parser_image
	local url
	url="$(reporting_get_env_value "$key")"
	parser_image="$(reporting_resolve_image_id_for_revision "${REPORTING_REVISION:-}")" || return 1
	printf '%s' "$url" | reporting_run_isolated_node_validator "$parser_image" '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
for (const key of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) {
  url.searchParams.delete(key);
}
process.stdout.write(url.toString());
'
}

reporting_database_psql() {
	local key="$1"
	shift
	local PGURL command_status
	PGURL="$(reporting_libpq_url "$key")"
	export PGURL
	if docker run --rm -i --network host -e PGURL "$REPORTING_CANONICAL_POSTGRES_IMAGE" \
		sh -euc 'psql --no-psqlrc --set ON_ERROR_STOP=1 "$PGURL" "$@"' sh "$@"; then
		command_status=0
	else
		command_status=$?
	fi
	unset PGURL
	return "$command_status"
}

reporting_verify_database_access_boundaries() {
	local runtime_state migration_state backup_state
	runtime_state="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  current_user = '$REPORTING_CANONICAL_RUNTIME_USER'
  AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname = current_user)
  AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
  AND NOT has_schema_privilege(current_user, '$REPORTING_CANONICAL_SCHEMA', 'CREATE')
  AND NOT has_table_privilege(current_user, '$REPORTING_CANONICAL_SCHEMA._prisma_migrations', 'SELECT')
  AND NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = '$REPORTING_CANONICAL_SCHEMA'
      AND tablename <> '_prisma_migrations'
      AND NOT (
        has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT')
        AND has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT')
        AND has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE')
        AND has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE')
        AND NOT has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE')
        AND NOT has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'REFERENCES')
        AND NOT has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRIGGER')
      )
  )
THEN 'ok' ELSE 'unsafe' END;
")"
	[[ "$runtime_state" == 'ok' ]] || {
		echo 'Reporting runtime database boundary is unsafe.' >&2
		return 1
	}
	migration_state="$(reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  current_user = '$REPORTING_CANONICAL_MIGRATION_USER'
  AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname = current_user)
  AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
  AND has_schema_privilege(current_user, '$REPORTING_CANONICAL_SCHEMA', 'CREATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = '$REPORTING_CANONICAL_SCHEMA'
      AND tableowner <> '$REPORTING_CANONICAL_MIGRATION_USER'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_sequences
    WHERE schemaname = '$REPORTING_CANONICAL_SCHEMA'
      AND sequenceowner <> '$REPORTING_CANONICAL_MIGRATION_USER'
  )
THEN 'ok' ELSE 'unsafe' END;
")"
	[[ "$migration_state" == 'ok' ]] || {
		echo 'Reporting migration database boundary is unsafe.' >&2
		return 1
	}
reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --file - <<'SQL'
BEGIN;
CREATE TABLE reporting.deployment_acl_smoke (id BIGSERIAL PRIMARY KEY);
CREATE FUNCTION reporting.deployment_acl_function_smoke()
RETURNS INTEGER LANGUAGE SQL AS 'SELECT 1';
DO $reporting_acl_smoke$
DECLARE
  probe_function REGPROCEDURE := 'reporting.deployment_acl_function_smoke()'::REGPROCEDURE;
BEGIN
  IF NOT (
    has_table_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke', 'SELECT')
    AND has_table_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke', 'INSERT')
    AND has_table_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke', 'UPDATE')
    AND has_table_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke', 'DELETE')
    AND NOT has_table_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke', 'TRUNCATE')
    AND has_sequence_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke_id_seq', 'USAGE')
    AND has_sequence_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke_id_seq', 'SELECT')
    AND has_sequence_privilege('winwidget_reporting_runtime', 'reporting.deployment_acl_smoke_id_seq', 'UPDATE')
    AND has_table_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke', 'SELECT')
    AND NOT has_table_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke', 'INSERT')
    AND NOT has_table_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke', 'UPDATE')
    AND NOT has_table_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke', 'DELETE')
    AND has_sequence_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke_id_seq', 'SELECT')
    AND NOT has_sequence_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke_id_seq', 'USAGE')
    AND NOT has_sequence_privilege('winwidget_reporting_backup', 'reporting.deployment_acl_smoke_id_seq', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'Reporting future table or sequence ACL is unsafe';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(
      COALESCE(routine.proacl, acldefault('f', routine.proowner))
    ) privilege
    WHERE routine.oid = probe_function
      AND privilege.grantee <> routine.proowner
  ) THEN
    RAISE EXCEPTION 'Reporting future function ACL is unsafe';
  END IF;
END
$reporting_acl_smoke$;
DROP FUNCTION reporting.deployment_acl_function_smoke();
DROP TABLE reporting.deployment_acl_smoke;
ROLLBACK;
SQL
	backup_state="$(reporting_database_psql REPORTING_BACKUP_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  current_user = '$REPORTING_CANONICAL_BACKUP_USER'
  AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname = current_user)
  AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
  AND NOT has_schema_privilege(current_user, '$REPORTING_CANONICAL_SCHEMA', 'CREATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = '$REPORTING_CANONICAL_SCHEMA'
      AND (
        NOT has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT')
        OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT')
        OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE')
        OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE')
        OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE')
      )
  )
THEN 'ok' ELSE 'unsafe' END;
")"
	[[ "$backup_state" == 'ok' ]] || {
		echo 'Reporting backup database boundary is unsafe.' >&2
		return 1
	}
	reporting_database_psql REPORTING_BACKUP_URL \
		--command 'SELECT count(*) FROM reporting._prisma_migrations;' >/dev/null
}

reporting_initialize_database_guard() {
	local operation="${1:-routine Reporting deployment}"
	local restore_worker_mode="${2:-healthy-required}"
	local marker_phase marker_image_id marker_system_identifier marker_container_id

	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation \
		"$restore_worker_mode" "$REPORTING_ENV_FILE"

	reporting_validate_production_files
	reporting_assert_canonical_postgres_env
	reporting_validate_database_urls
	reporting_validate_database_marker || {
		echo "$operation requires a valid prepared Reporting database lifecycle marker." >&2
		return 1
	}
	marker_phase="$(reporting_marker_value phase)"
	[[ "$marker_phase" == 'prepared' ]] || {
		echo "$operation is blocked while Reporting database preparation is in phase $marker_phase." >&2
		return 1
	}
	marker_image_id="$(reporting_marker_value postgres_image_id)"
	marker_system_identifier="$(reporting_marker_value postgres_system_identifier)"
	marker_container_id="$(reporting_marker_value container_id)"

	REPORTING_GUARD_CONTAINER_ID="$(reporting_verify_postgres_container "$marker_container_id" "$marker_image_id" "$marker_system_identifier")"
	reporting_verify_role_boundaries
	REPORTING_GUARD_CONTAINER_SNAPSHOT="$(reporting_container_snapshot "$REPORTING_GUARD_CONTAINER_ID")"
	REPORTING_GUARD_VOLUME_SNAPSHOT="$(reporting_volume_snapshot "$REPORTING_CANONICAL_POSTGRES_VOLUME")"
	REPORTING_GUARD_SECRET_SNAPSHOT="$(reporting_secret_snapshot)" || {
		echo 'Reporting PostgreSQL admin secret is missing or invalid.' >&2
		return 1
	}
	REPORTING_GUARD_IMAGE_ID="$marker_image_id"
	REPORTING_GUARD_SYSTEM_IDENTIFIER="$marker_system_identifier"
}

reporting_verify_database_lifecycle_unchanged() {
	local container_snapshot volume_snapshot secret_snapshot
	reporting_verify_postgres_container \
		"$REPORTING_GUARD_CONTAINER_ID" \
		"$REPORTING_GUARD_IMAGE_ID" \
		"$REPORTING_GUARD_SYSTEM_IDENTIFIER" >/dev/null || {
		echo 'Reporting PostgreSQL identity changed during routine deployment.' >&2
		return 1
	}
	container_snapshot="$(reporting_container_snapshot "$REPORTING_GUARD_CONTAINER_ID")"
	volume_snapshot="$(reporting_volume_snapshot "$REPORTING_CANONICAL_POSTGRES_VOLUME")"
	secret_snapshot="$(reporting_secret_snapshot)" || return 1
	[[ "$container_snapshot" == "$REPORTING_GUARD_CONTAINER_SNAPSHOT" &&
		"$volume_snapshot" == "$REPORTING_GUARD_VOLUME_SNAPSHOT" &&
		"$secret_snapshot" == "$REPORTING_GUARD_SECRET_SNAPSHOT" ]] || {
		echo 'Routine deployment restarted or changed Reporting PostgreSQL, its volume or admin secret.' >&2
		return 1
	}
}

reporting_prepare_database() {
	local revision="$1"
	local marker_phase volume_identity container_id image_id system_identifier
	local key

	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting database prepare must run as root.' >&2
		return 1
	}
	reporting_validate_production_files
	reporting_validate_exact_revision "$revision"
	reporting_require_local_docker_daemon
	reporting_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	reporting_require_staged_revision "$revision"
	for key in REPORTING_POSTGRES_IMAGE REPORTING_POSTGRES_PORT REPORTING_POSTGRES_DATA_VOLUME \
		REPORTING_POSTGRES_ADMIN_USER REPORTING_POSTGRES_ADMIN_PASSWORD_FILE REPORTING_DATABASE_URL \
		REPORTING_MIGRATION_DATABASE_URL REPORTING_BACKUP_URL; do
		reporting_require_env_key "$key"
	done
	reporting_assert_canonical_postgres_env
	reporting_validate_database_urls
	reporting_validate_admin_secret_precondition
	reporting_validate_preflight_state "$revision" prepare

	if [[ -e "$REPORTING_DATABASE_MARKER" || -L "$REPORTING_DATABASE_MARKER" ]]; then
		marker_phase="$(reporting_marker_value phase)"
		if [[ "$marker_phase" == 'prepared' ]]; then
			reporting_initialize_database_guard \
				'Reporting database prepare' identity-if-present
			echo "Reporting database is already prepared at revision $revision."
			return
		fi
	else
		reporting_write_database_marker preparing "$revision"
	fi

	reporting_create_admin_secret_if_missing
	if ! docker volume inspect "$REPORTING_CANONICAL_POSTGRES_VOLUME" >/dev/null 2>&1; then
		docker volume create \
			--label com.winwidget.owner=reporting \
			--label com.winwidget.purpose=postgres-data \
			--label "com.winwidget.lifecycle.revision=$revision" \
			"$REPORTING_CANONICAL_POSTGRES_VOLUME" >/dev/null
	fi
	volume_identity="$(docker volume inspect "$REPORTING_CANONICAL_POSTGRES_VOLUME" --format '{{printf "%s|%s|%s|%s|%s" .Driver .Scope (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.lifecycle.revision")}}')"
	[[ "$volume_identity" == "local|local|reporting|postgres-data|$revision" ]] || {
		echo 'Existing Reporting PostgreSQL volume has an unsafe identity.' >&2
		return 1
	}

	reporting_compose --profile reporting-database up -d "$REPORTING_POSTGRES_SERVICE"
	reporting_wait_for_postgres || {
		echo 'Reporting PostgreSQL did not become healthy.' >&2
		return 1
	}
	container_id="$(reporting_postgres_container_id)"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	system_identifier="$(reporting_postgres_system_identifier "$container_id")"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$system_identifier" =~ ^[0-9]+$ ]] || {
		echo 'Reporting PostgreSQL identity could not be captured.' >&2
		return 1
	}
	reporting_configure_roles_and_schema
	reporting_verify_role_boundaries
	reporting_write_database_marker prepared "$revision" "$image_id" "$system_identifier" "$container_id"
	reporting_verify_postgres_container "$container_id" "$image_id" "$system_identifier" >/dev/null
	echo "Reporting PostgreSQL prepared at revision $revision; routine deploys cannot recreate it."
}

reporting_status_count_ids() {
	awk 'NF { count += 1 } END { print count + 0 }'
}

reporting_database_status() {
	local result=0 staged_valid=false database_valid=false cutover_valid=false
	local phase='' revision='' staged_revision='' cutover_phase='' cutover_revision=''
	local owned_ids='' named_ids='' port_ids='' owned_count named_count port_count
	local network_identity='' volume_identity='' expected_network expected_volume
	local container_id='' recorded_container_id='' container_state='' secret_file secret_value=''
	local secret_state='absent' network_state='absent' volume_state='absent'
	local port_state='unknown' database_identity='absent'

	printf 'status_version=1\n'
	if [[ -e "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ||
		-L "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" ]]; then
		if reporting_validate_first_rollout_staged_marker; then
			staged_valid=true
			staged_revision="$(reporting_staged_marker_value revision)" || return 1
			printf 'staged_marker=valid\n'
			printf 'staged_revision=%s\n' "$staged_revision"
		else
			printf 'staged_marker=invalid\n'
			result=1
		fi
	else
		printf 'staged_marker=absent\n'
	fi

	if [[ -e "$REPORTING_DATABASE_MARKER" || -L "$REPORTING_DATABASE_MARKER" ]]; then
		if reporting_validate_database_marker; then
			database_valid=true
			phase="$(reporting_marker_value phase)" || return 1
			revision="$(reporting_marker_value revision)" || return 1
			printf 'database_marker=valid\n'
			printf 'database_phase=%s\n' "$phase"
			printf 'database_revision=%s\n' "$revision"
		else
			printf 'database_marker=invalid\n'
			result=1
		fi
	else
		printf 'database_marker=absent\n'
	fi

	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		if reporting_cutover_validate_marker; then
			cutover_valid=true
			cutover_phase="$(reporting_cutover_marker_value phase)" || return 1
			cutover_revision="$(reporting_cutover_marker_value revision)" || return 1
			printf 'cutover_marker=valid\n'
			printf 'cutover_phase=%s\n' "$cutover_phase"
			printf 'cutover_revision=%s\n' "$cutover_revision"
		else
			printf 'cutover_marker=invalid\n'
			result=1
		fi
	else
		printf 'cutover_marker=absent\n'
	fi

	if [[ "$cutover_valid" == 'true' ]] &&
		[[ "$database_valid" != 'true' || "$phase" != 'prepared' ||
			"$cutover_revision" != "$revision" ]]; then
		printf 'marker_relationship=invalid\n'
		result=1
	else
		printf 'marker_relationship=consistent\n'
	fi
	if [[ "$database_valid" == 'true' && "$phase" == 'preparing' ]] &&
		[[ "$staged_valid" != 'true' || "$staged_revision" != "$revision" ]]; then
		printf 'staged_relationship=invalid\n'
		result=1
	else
		printf 'staged_relationship=consistent\n'
	fi

	if ! reporting_require_local_docker_daemon; then
		printf 'docker_daemon=unavailable\n'
		printf 'database_identity=unavailable\n'
		return 1
	fi
	printf 'docker_daemon=available\n'
	owned_ids="$(reporting_preflight_owned_container_ids)" || {
		printf 'postgres_container_query=failed\n'
		return 1
	}
	named_ids="$(reporting_preflight_named_container_ids)" || {
		printf 'postgres_container_query=failed\n'
		return 1
	}
	port_ids="$(reporting_preflight_port_container_ids)" || {
		printf 'postgres_port_query=failed\n'
		return 1
	}
	owned_count="$(printf '%s\n' "$owned_ids" | reporting_status_count_ids)"
	named_count="$(printf '%s\n' "$named_ids" | reporting_status_count_ids)"
	port_count="$(printf '%s\n' "$port_ids" | reporting_status_count_ids)"
	printf 'owned_postgres_containers=%s\n' "$owned_count"
	printf 'named_postgres_containers=%s\n' "$named_count"
	printf 'bound_postgres_containers=%s\n' "$port_count"
	[[ "$owned_count" -le 1 && "$named_count" -le 1 && "$port_count" -le 1 ]] || result=1

	network_identity="$(reporting_preflight_network_identity)" || {
		printf 'postgres_network=unavailable\n'
		return 1
	}
	volume_identity="$(reporting_preflight_volume_identity)" || {
		printf 'postgres_volume=unavailable\n'
		return 1
	}
	expected_network="$REPORTING_CANONICAL_POSTGRES_NETWORK|bridge|local|false|reporting|postgres-network"
	if [[ -n "$network_identity" ]]; then
		if [[ "$network_identity" == "$expected_network" ]]; then
			network_state='canonical'
		else
			network_state='conflict'
			result=1
		fi
	fi
	if [[ -n "$volume_identity" ]]; then
		if [[ "$database_valid" == 'true' ]]; then
			expected_volume="$REPORTING_CANONICAL_POSTGRES_VOLUME|local|local|reporting|postgres-data|$revision"
			if [[ "$volume_identity" == "$expected_volume" ]]; then
				volume_state='canonical'
			else
				volume_state='conflict'
				result=1
			fi
		else
			volume_state='untracked'
			result=1
		fi
	fi
	printf 'postgres_network=%s\n' "$network_state"
	printf 'postgres_volume=%s\n' "$volume_state"

	if reporting_preflight_host_port_is_listening; then
		port_state='listening'
	else
		case "$?" in
		1) port_state='free' ;;
		*) port_state='unavailable'; result=1 ;;
		esac
	fi
	printf 'loopback_port=%s\n' "$port_state"

	secret_file="$REPORTING_APP_ROOT/deploy/backend/.reporting-postgres-admin-password"
	if [[ -e "$secret_file" || -L "$secret_file" ]]; then
		if [[ -f "$secret_file" && ! -L "$secret_file" &&
			"$(reporting_stat_mode "$secret_file")" == '600' &&
			"$(reporting_stat_owner "$secret_file")" == '0:0' ]]; then
			secret_value="$(tr -d '\r\n' <"$secret_file")"
			if [[ "$secret_value" =~ ^[0-9a-f]{64}$ &&
				"$(wc -l <"$secret_file" | tr -d '[:space:]')" == '1' ]]; then
				secret_state='valid'
			else
				secret_state='invalid'
				result=1
			fi
		else
			secret_state='invalid'
			result=1
		fi
	fi
	unset secret_value
	printf 'admin_secret=%s\n' "$secret_state"

	if [[ "$owned_count" == '1' && "$named_count" == '1' && "$port_count" == '1' &&
		"$owned_ids" == "$named_ids" && "$owned_ids" == "$port_ids" ]]; then
		container_id="$owned_ids"
		container_state="$(docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' "$container_id" 2>/dev/null)" || {
			printf 'postgres_container_state=unavailable\n'
			return 1
		}
		case "$container_state" in
		running\|true\|healthy\|0\|0\|false\|) printf 'postgres_container_state=running-healthy\n' ;;
		running\|true\|starting\|0\|0\|false\|) printf 'postgres_container_state=running-starting\n' ;;
		created\|false\|*\|0\|0\|false\| | exited\|false\|*\|0\|0\|false\|)
			printf 'postgres_container_state=stopped-resumable-candidate\n'
			;;
		*)
			printf 'postgres_container_state=unsafe\n'
			result=1
			;;
		esac
	else
		[[ "$owned_count" == '0' && "$named_count" == '0' && "$port_count" == '0' ]] || result=1
		printf 'postgres_container_state=%s\n' "$([[ "$owned_count" == '0' && "$named_count" == '0' && "$port_count" == '0' ]] && printf 'absent' || printf 'conflict')"
	fi

	if [[ "$database_valid" == 'true' && "$phase" == 'prepared' ]]; then
		recorded_container_id="$(reporting_marker_value container_id)" || return 1
		if [[ "$container_id" == "$recorded_container_id" &&
			"$network_state" == 'canonical' && "$volume_state" == 'canonical' &&
			"$secret_state" == 'valid' && "$port_state" == 'listening' &&
			"$container_state" == 'running|true|healthy|0|0|false|' ]]; then
			database_identity='static-consistent'
		else
			database_identity='inconsistent'
			result=1
		fi
	elif [[ "$database_valid" == 'true' && "$phase" == 'preparing' ]]; then
		database_identity='partial'
	elif [[ "$owned_count" != '0' || "$named_count" != '0' || "$port_count" != '0' ||
		"$network_state" != 'absent' || "$volume_state" != 'absent' ||
		"$secret_state" != 'absent' || "$port_state" != 'free' ]]; then
		database_identity='untracked-resources'
		result=1
	fi
	printf 'database_identity=%s\n' "$database_identity"
	return "$result"
}

reporting_database_lifecycle_self_test() {
	local temporary_root marker staged_marker cutover_marker revision other_revision original_compose_file
	local valid_password partial_container_id source_text state_source_text status_text status_output
	local network_identity
	local prepare_text admin_precondition_index marker_write_index validator_text
	local post_cleanup_contract_text checkout_guard_text
	local acl_configure_text acl_reconcile_text role_boundary_text access_boundary_text
	revision='0123456789abcdef0123456789abcdef01234567'
	other_revision='89abcdef0123456789abcdef0123456789abcdef'
	partial_container_id='1111111111111111111111111111111111111111111111111111111111111111'
	[[ "$REPORTING_ENV_FILE" == "$REPORTING_APP_ROOT/deploy/backend/.env.production" &&
		"$REPORTING_COMPOSE_FILE" == "$REPORTING_APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml" &&
		"$REPORTING_DATABASE_MARKER" == "$REPORTING_APP_ROOT/deploy/backend/.reporting-database-lifecycle-v1" &&
		"$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" == "$REPORTING_APP_ROOT/deploy/backend/.reporting-first-rollout-staged-v1" &&
		"$REPORTING_CUTOVER_MARKER" == "$REPORTING_APP_ROOT/deploy/backend/.reporting-database-cutover-v1" ]] || {
		echo 'Reporting lifecycle accepted non-canonical production paths.' >&2
		return 1
	}
	[[ "$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" == *'billing-admin-audit'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" == *'identity-admin-audit'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" == *'billing-payment-projection'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" == *'billing-subscription-projection'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" == *'billing-affiliate-projection'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" == *'billing-settings-projection'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" != *'telegram-destination-unavailable'* &&
		"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" != *'auto-renewal'* ]] || {
		echo 'Reporting lifecycle has an invalid post-Identity worker ownership set.' >&2
		return 1
	}
	(
		reporting_widgets_ownership_marker_state() { printf 'active\n'; }
		[[ "$(reporting_expected_integration_worker_kinds)" == \
			"$REPORTING_CURRENT_IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" ]]
	) || {
		echo 'Reporting lifecycle did not resolve the post-Identity worker ownership set.' >&2
		return 1
	}
	(
		widgets_prisma_url='postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?schema=widgets&sslmode=disable&connection_limit=5&pool_timeout=10&pgbouncer=true&statement_cache_size=0&application_name=widgets%20service'
		widgets_libpq_url='postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?sslmode=disable&application_name=widgets%20service'
		[[ "$(reporting_widgets_lifecycle_libpq_url "$widgets_prisma_url")" == "$widgets_libpq_url" &&
			"$(reporting_widgets_lifecycle_libpq_url 'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets')" == \
				'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets' &&
			"$(reporting_widgets_lifecycle_libpq_url 'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?schema=widgets&connection_limit=5')" == \
				'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets' ]]
		! reporting_widgets_lifecycle_libpq_url '' >/dev/null 2>&1
		reporting_get_env_value() {
			case "$1" in
			WIDGETS_DATABASE_URL) printf '%s\n' "$widgets_prisma_url" ;;
			WIDGETS_POSTGRES_DATA_VOLUME) printf 'winwidget-widgets-postgres-data\n' ;;
			*) return 1 ;;
			esac
		}
		docker() {
			if [[ "${1:-}" == run ]]; then
				[[ "${PGURL:-}" == "$widgets_libpq_url" &&
					"${WIDGETS_IDENTITY_SQL:-}" == *'FROM widgets.service_identity'* ]] || return 1
				printf 'active\n'
				return
			fi
			return 1
		}
		[[ "$(reporting_widgets_ownership_marker_state)" == 'active' ]]
	) || {
		echo 'Reporting Widgets ownership libpq boundary self-test failed.' >&2
		return 1
	}
	(
		reporting_get_env_value() {
			case "$1" in
			WIDGETS_DATABASE_URL) printf 'postgresql://runtime:masked@127.0.0.1:55436/winwidget_widgets?schema=widgets\n' ;;
			WIDGETS_POSTGRES_DATA_VOLUME) printf 'winwidget-widgets-postgres-data\n' ;;
			*) return 1 ;;
			esac
		}
		docker() {
			if [[ "${1:-}" == volume && "${2:-}" == inspect ]]; then
				return 0
			fi
			return 1
		}
		! reporting_widgets_ownership_marker_state >/dev/null 2>&1
	) || {
		echo 'Reporting Widgets ownership reader did not fail closed.' >&2
		return 1
	}
	(
		docker() {
			if [[ "${1:-}" == network && "${2:-}" == ls ]] ||
				[[ "${1:-}" == volume && "${2:-}" == ls ]]; then
				return 0
			fi
			return 1
		}
		[[ -z "$(reporting_preflight_network_identity)" &&
			-z "$(reporting_preflight_volume_identity)" ]]
	) || {
		echo 'Reporting lifecycle rejected an absent network or volume.' >&2
		return 1
	}
	(
		docker() {
			if [[ "${1:-}" == network && "${2:-}" == ls ]]; then
				printf '%s\n' "$REPORTING_CANONICAL_POSTGRES_NETWORK|network-id"
				return
			fi
			if [[ "${1:-}" == network && "${2:-}" == inspect &&
				"${3:-}" == network-id ]]; then
				printf '%s\n' "$REPORTING_CANONICAL_POSTGRES_NETWORK|bridge|local|false|reporting|postgres-network"
				return
			fi
			return 1
		}
		network_identity="$(reporting_preflight_network_identity)" || return 1
		[[ "$network_identity" == \
			"$REPORTING_CANONICAL_POSTGRES_NETWORK|bridge|local|false|reporting|postgres-network" ]]
	) || {
		echo 'Reporting lifecycle network identity parser is not portable.' >&2
		return 1
	}
	temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-lifecycle.XXXXXX")"
	marker="$temporary_root/marker"
	staged_marker="$temporary_root/staged-marker"
	cutover_marker="$temporary_root/cutover-marker"
	REPORTING_DATABASE_MARKER="$temporary_root/database-marker"
	REPORTING_FIRST_ROLLOUT_STAGED_MARKER="$staged_marker"
	REPORTING_CUTOVER_MARKER="$cutover_marker"
	original_compose_file="$REPORTING_COMPOSE_FILE"
	trap 'rm -rf -- "$temporary_root"' RETURN

	REPORTING_COMPOSE_FILE="$temporary_root/compose.yml"
	printf 'name: ${REPORTING_AMBIENT_SELF_TEST:-safe}\n' >"$REPORTING_COMPOSE_FILE"
	export REPORTING_AMBIENT_SELF_TEST=unsafe
	if reporting_assert_no_ambient_compose_overrides >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test accepted an ambient Compose override.' >&2
		return 1
	fi
	reporting_assert_no_ambient_compose_overrides REPORTING_AMBIENT_SELF_TEST
	unset REPORTING_AMBIENT_SELF_TEST
	REPORTING_COMPOSE_FILE="$original_compose_file"
	(
		REPORTING_ENV_FILE="$temporary_root/cleanup-env"
		REPORTING_CUTOVER_MARKER="$temporary_root/cleanup-cutover-marker"
		cleanup_phase='cleanup-staged'
		printf '# preserved\nINTEGRATION_WORKER_KINDS=%s\nUNCHANGED=value\n' \
			"$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS" >"$REPORTING_ENV_FILE"
		printf 'marker\n' >"$REPORTING_CUTOVER_MARKER"
		id() { printf '0\n'; }
		chown() { :; }
		reporting_stat_owner() { printf '0:0\n'; }
		reporting_validate_exact_revision() { [[ "$1" == "$revision" ]]; }
		reporting_validate_production_files() { :; }
		reporting_validate_root_owned_directory() { :; }
		reporting_cutover_validate_marker() { :; }
		reporting_cutover_marker_value() {
			case "$1" in
			phase) printf '%s\n' "$cleanup_phase" ;;
			cleanup_revision) printf '%s\n' "$revision" ;;
			*) return 1 ;;
			esac
		}
		reporting_transition_cleanup_integration_worker_env "$revision" >/dev/null
		[[ "$(reporting_get_env_value INTEGRATION_WORKER_KINDS)" == \
			"$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS" &&
			"$(grep -c '^INTEGRATION_WORKER_KINDS=' "$REPORTING_ENV_FILE")" == '1' &&
			"$(grep -c '^# preserved$' "$REPORTING_ENV_FILE")" == '1' &&
			"$(grep -c '^UNCHANGED=value$' "$REPORTING_ENV_FILE")" == '1' ]]
		reporting_transition_cleanup_integration_worker_env "$revision" >/dev/null
		printf 'INTEGRATION_WORKER_KINDS=unexpected\n' >"$REPORTING_ENV_FILE"
		if reporting_transition_cleanup_integration_worker_env "$revision" >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unexpected cleanup env value.' >&2
			return 1
		fi
		printf 'INTEGRATION_WORKER_KINDS=%s\n' \
			"$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS" >"$REPORTING_ENV_FILE"
		cleanup_phase='routes-switched'
		reporting_transition_cleanup_integration_worker_env "$revision" >/dev/null
		[[ "$(reporting_get_env_value INTEGRATION_WORKER_KINDS)" == \
			"$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS" ]]
	) || {
		echo 'Reporting cleanup env transition self-test failed.' >&2
		return 1
	}
	(
		reporting_export_pinned_runtime_identity "$revision"
		[[ "$REPORTING_REVISION" == "$revision" &&
			"$REPORTING_IMAGE" == "winwidget-reporting:git-$revision" &&
			"$NOTIFICATION_DELIVERY_REVISION" == "$revision" &&
			"$NOTIFICATION_DELIVERY_IMAGE" == "winwidget-notification-delivery:git-$revision" &&
			"$CAMPAIGNS_REVISION" == "$revision" &&
			"$CAMPAIGNS_IMAGE" == "winwidget-campaigns:git-$revision" &&
			"$DATABASE_RESTORE_REVISION" == "$revision" &&
			"$DATABASE_RESTORE_IMAGE" == "winwidget-database-restore:git-$revision" ]]
	) || {
		echo 'Reporting lifecycle self-test did not derive all immutable Compose identities.' >&2
		return 1
	}
	if reporting_export_pinned_runtime_identity "${revision}x" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test accepted a non-SHA runtime identity.' >&2
		return 1
	fi
	validator_text="$(declare -f reporting_resolve_image_id_for_revision \
		reporting_run_isolated_node_validator)"
	[[ "$validator_text" == *'org.opencontainers.image.revision'* &&
		"$validator_text" == *'--network none'* &&
		"$validator_text" == *'--read-only'* &&
		"$validator_text" == *'--cap-drop ALL'* &&
		"$validator_text" == *'--security-opt no-new-privileges'* ]] || {
		echo 'Reporting lifecycle self-test found an unsafe validator container.' >&2
		return 1
	}
	(
		stub_revision="$revision"
		docker() {
			[[ "$1" == 'image' && "$2" == 'inspect' ]] || return 1
			if [[ "$*" == *'{{.Id}}'* ]]; then
				printf 'sha256:%064d\n' 0
			else
				printf '%s\n' "$stub_revision"
			fi
		}
		[[ "$(reporting_resolve_image_id_for_revision \
			"$revision" reporting:test)" == "sha256:$(printf '%064d' 0)" ]]
		stub_revision="$other_revision"
		if reporting_resolve_image_id_for_revision \
			"$revision" reporting:test >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted a mutable tag with a stale revision label.' >&2
			return 1
		fi
	) || return 1
	valid_password='0123456789abcdef0123456789abcdef'
	(
		test_url="postgresql://$REPORTING_CANONICAL_RUNTIME_USER:$valid_password@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable"
		reporting_get_env_value() {
			[[ "$1" == 'TEST_URL' ]] || return 1
			printf '%s\n' "$test_url"
		}
		reporting_validate_preflight_url TEST_URL \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:" \
			"@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable"
		for test_url in \
			"postgresql://wrong:$valid_password@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:short@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:change_me_password_that_is_long_enough@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:change%5Fme_password_that_is_long_enough@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:0123456789abcdef0123456789abc%ZZ@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:0123456789abcdef0123456789abc\$HOME@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:0123456789abcdef0123456789ab\${HOME}@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:0123456789abcdef0123456789abc\\unsafe@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:0123456789abcdef0123456789ab%00@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" \
			"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:0123456789abcdef0123456789ab%FF@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable"; do
			if reporting_validate_preflight_url TEST_URL \
				"postgresql://$REPORTING_CANONICAL_RUNTIME_USER:" \
				"@127.0.0.1:$REPORTING_CANONICAL_POSTGRES_PORT/$REPORTING_CANONICAL_DATABASE?schema=$REPORTING_CANONICAL_SCHEMA&sslmode=disable" >/dev/null 2>&1; then
				echo 'Reporting lifecycle self-test accepted an unsafe static URL.' >&2
				return 1
			fi
		done
		) || return 1
	(
		runtime_secret='0123456789abcdef0123456789abcde!'
		migration_secret='1123456789abcdef0123456789abcdef'
		backup_secret='2123456789abcdef0123456789abcdef'
		rabbit_secret='3123456789abcdef0123456789abcdef'
		reporting_get_env_value() {
			case "$1" in
			REPORTING_DATABASE_URL)
				printf 'postgresql://%s:%s@127.0.0.1:%s/%s?schema=%s&sslmode=disable\n' \
					"$REPORTING_CANONICAL_RUNTIME_USER" "$runtime_secret" \
					"$REPORTING_CANONICAL_POSTGRES_PORT" "$REPORTING_CANONICAL_DATABASE" \
					"$REPORTING_CANONICAL_SCHEMA"
				;;
			REPORTING_MIGRATION_DATABASE_URL)
				printf 'postgresql://%s:%s@127.0.0.1:%s/%s?schema=%s&sslmode=disable\n' \
					"$REPORTING_CANONICAL_MIGRATION_USER" "$migration_secret" \
					"$REPORTING_CANONICAL_POSTGRES_PORT" "$REPORTING_CANONICAL_DATABASE" \
					"$REPORTING_CANONICAL_SCHEMA"
				;;
			REPORTING_BACKUP_URL)
				printf 'postgresql://%s:%s@127.0.0.1:%s/%s?schema=%s&sslmode=disable\n' \
					"$REPORTING_CANONICAL_BACKUP_USER" "$backup_secret" \
					"$REPORTING_CANONICAL_POSTGRES_PORT" "$REPORTING_CANONICAL_DATABASE" \
					"$REPORTING_CANONICAL_SCHEMA"
				;;
			RABBITMQ_REPORTING_URL)
				printf 'amqp://winwidget-reporting:%s@127.0.0.1:5672/winwidget\n' "$rabbit_secret"
				;;
			*) return 1 ;;
			esac
		}
		reporting_validate_preflight_secret_isolation
		rabbit_secret='0123456789abcdef0123456789abcde%21'
		if isolation_error="$(reporting_validate_preflight_secret_isolation 2>&1)"; then
			echo 'Reporting lifecycle self-test accepted equal decoded credentials.' >&2
			return 1
		fi
		[[ "$isolation_error" == \
			'Reporting runtime, migration, backup and RabbitMQ credentials must be pairwise distinct.' &&
			"$isolation_error" != *"$runtime_secret"* ]] || {
			echo 'Reporting credential isolation failure leaked or obscured a secret.' >&2
			return 1
		}
	) || return 1
	(
		reporting_validate_preflight_internal_token_value \
			'0123456789abcdef0123456789abcdef'
		for invalid_token in \
			'short' \
			'change_me_reporting_internal_token_at_least_32_chars' \
			'ci_reporting_internal_token_at_least_32_chars' \
			'"0123456789abcdef0123456789abcdef"' \
			'0123456789abcdef0123456789abc #comment' \
			'0123456789abcdef0123456789abc\unsafe' \
			'0123456789abcdef0123456789abc$HOME'; do
			if reporting_validate_preflight_internal_token_value \
				"$invalid_token" >/dev/null 2>&1; then
				echo 'Reporting lifecycle self-test accepted an unsafe internal token.' >&2
				return 1
			fi
		done
	) || return 1
	(
		mock_container_id="$partial_container_id"
		mock_secret_file="$temporary_root/reporting-postgres-admin-password"
		mock_status='created'
		mock_running='false'
		mock_health='missing'
		mock_restart_count='0'
		mock_exit_code='0'
		mock_oom_killed='false'
		mock_state_error=''
		mock_image_ref="$REPORTING_CANONICAL_POSTGRES_IMAGE"
		mock_image_id="sha256:$(printf '%064d' 8)"
		mock_container_labels='winwidget|reporting-postgres|reporting|postgres|unless-stopped'
		mock_mount="/var/lib/postgresql|volume|$REPORTING_CANONICAL_POSTGRES_VOLUME|true"
		mock_secret_mount="bind|$mock_secret_file|false"
		mock_port="127.0.0.1|$REPORTING_CANONICAL_POSTGRES_PORT|1"
		mock_network_names="$REPORTING_CANONICAL_POSTGRES_NETWORK"
		mock_mount_count='2'
		mock_network_count='1'
		mock_container_env="$(printf '%s\n' \
			"POSTGRES_DB=$REPORTING_CANONICAL_DATABASE" \
			"POSTGRES_USER=$REPORTING_CANONICAL_ADMIN_USER" \
			'POSTGRES_PASSWORD_FILE=/run/secrets/reporting-postgres-admin-password' \
			'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
			'PGDATA=/var/lib/postgresql/18/docker')"
		valid_container_env="$mock_container_env"
		docker() {
			[[ "$1" == 'inspect' && "$2" == '--format' && "$4" == "$mock_container_id" ]] || return 1
			case "$3" in
			'{{.State.Status}}') printf '%s\n' "$mock_status" ;;
			'{{.State.Running}}') printf '%s\n' "$mock_running" ;;
			'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')
				printf '%s\n' "$mock_health"
				;;
			'{{.RestartCount}}') printf '%s\n' "$mock_restart_count" ;;
			'{{.State.ExitCode}}') printf '%s\n' "$mock_exit_code" ;;
			'{{.State.OOMKilled}}') printf '%s\n' "$mock_oom_killed" ;;
			'{{.State.Error}}') printf '%s\n' "$mock_state_error" ;;
			'{{.Config.Image}}') printf '%s\n' "$mock_image_ref" ;;
			'{{.Image}}') printf '%s\n' "$mock_image_id" ;;
			*'com.docker.compose.project'*)
				printf '%s\n' "$mock_container_labels"
				;;
			*'Destination "/var/lib/postgresql"'*)
				printf '%s\n' "$mock_mount"
				;;
			*'Destination "/run/secrets/reporting-postgres-admin-password"'*)
				printf '%s\n' "$mock_secret_mount"
				;;
			*'HostConfig.PortBindings "5432/tcp"'*)
				printf '%s\n' "$mock_port"
				;;
			*'NetworkSettings.Networks}}{{println $name'*)
				printf '%s\n' "$mock_network_names"
				;;
			'{{len .Mounts}}') printf '%s\n' "$mock_mount_count" ;;
			'{{len .NetworkSettings.Networks}}') printf '%s\n' "$mock_network_count" ;;
			'{{range .Config.Env}}{{println .}}{{end}}') printf '%s\n' "$mock_container_env" ;;
			*) return 1 ;;
			esac
		}
		reporting_get_env_value() {
			[[ "$1" == 'REPORTING_POSTGRES_ADMIN_PASSWORD_FILE' ]] || return 1
			printf '%s\n' "$mock_secret_file"
		}
		expect_static_rejection() {
			local rejected_state="$1"
			local expected_state="${2:-stopped}"
			if reporting_verify_partial_postgres_container_static \
				"$mock_container_id" "$expected_state" >/dev/null 2>&1; then
				echo "Reporting lifecycle self-test accepted unsafe partial-container state: $rejected_state." >&2
				return 1
			fi
		}
		reporting_verify_partial_postgres_container_static "$mock_container_id" stopped
		mock_status='exited'
		reporting_verify_partial_postgres_container_static "$mock_container_id" stopped
		mock_exit_code='1'
		expect_static_rejection 'exit-code'
		mock_exit_code='0'
		mock_status='dead'
		expect_static_rejection 'dead'
		mock_status='created'
		mock_running='true'
		expect_static_rejection 'running'
		mock_running='false'
		mock_restart_count='1'
		expect_static_rejection 'restart-count'
		mock_restart_count='0'
		mock_oom_killed='true'
		expect_static_rejection 'oom-killed'
		mock_oom_killed='false'
		mock_state_error='unsafe'
		expect_static_rejection 'state-error'
		mock_state_error=''
		mock_image_id='unsafe-image-id'
		expect_static_rejection 'image-id'
		mock_image_id="sha256:$(printf '%064d' 8)"
		mock_image_ref='postgres:latest'
		expect_static_rejection 'image-ref'
		mock_image_ref="$REPORTING_CANONICAL_POSTGRES_IMAGE"
		mock_container_labels='unsafe-labels'
		expect_static_rejection 'labels'
		mock_container_labels='winwidget|reporting-postgres|reporting|postgres|unless-stopped'
		mock_mount='unsafe-mount'
		expect_static_rejection 'data-mount'
		mock_mount="/var/lib/postgresql|volume|$REPORTING_CANONICAL_POSTGRES_VOLUME|true"
		mock_secret_mount="bind|$mock_secret_file|true"
		expect_static_rejection 'secret-mount'
		mock_secret_mount="bind|$mock_secret_file|false"
		mock_port="0.0.0.0|$REPORTING_CANONICAL_POSTGRES_PORT|1"
		expect_static_rejection 'port-binding'
		mock_port="127.0.0.1|$REPORTING_CANONICAL_POSTGRES_PORT|1"
		mock_network_names='unsafe-network'
		expect_static_rejection 'network'
		mock_network_names="$REPORTING_CANONICAL_POSTGRES_NETWORK"
		mock_mount_count='3'
		expect_static_rejection 'mount-count'
		mock_mount_count='2'
		mock_network_count='2'
		expect_static_rejection 'network-count'
		mock_network_count='1'
		mock_container_env="$valid_container_env"$'\n'"POSTGRES_DB=$REPORTING_CANONICAL_DATABASE"
		expect_static_rejection 'duplicate-environment'
		mock_container_env="$valid_container_env"
		mock_status='running'
		mock_running='true'
		mock_health='starting'
		reporting_verify_partial_postgres_container_static "$mock_container_id" starting
		mock_health='unhealthy'
		expect_static_rejection 'unhealthy' starting
		mock_health='starting'
		mock_restart_count='1'
		expect_static_rejection 'starting-restart-count' starting
	) || return 1
	(
		REPORTING_DATABASE_MARKER="$temporary_root/precondition-marker"
		reporting_require_staged_revision() { :; }
		reporting_preflight_compose_container_ids() { :; }
		reporting_preflight_network_identity() { :; }
		reporting_preflight_volume_identity() { :; }
		reporting_preflight_owned_container_ids() { :; }
		reporting_preflight_named_container_ids() { :; }
		reporting_preflight_port_container_ids() { :; }
		reporting_preflight_host_port_is_listening() { return 1; }
		reporting_preflight_container_running() { printf 'false\n'; }
		reporting_preflight_container_health() { printf 'starting\n'; }
		reporting_verify_partial_postgres_container_static() { :; }
		reporting_verify_postgres_container() { :; }
		reporting_verify_role_boundaries() { :; }
		reporting_secret_snapshot() { :; }
		reporting_validate_preflight_state "$revision" prepare
		reporting_validate_preflight_state "$revision" status
		reporting_require_staged_revision() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted no-marker state without its staged revision.' >&2
			return 1
		fi
		reporting_require_staged_revision() { :; }
		reporting_preflight_owned_container_ids() { return 7; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test ignored a failed Docker container query.' >&2
			return 1
		fi
		reporting_preflight_owned_container_ids() { :; }
		reporting_preflight_named_container_ids() { printf 'unexpected-container\n'; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted a colliding PostgreSQL container.' >&2
			return 1
		fi
		reporting_preflight_named_container_ids() { :; }
		reporting_preflight_volume_identity() { printf 'unsafe-volume\n'; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unsafe PostgreSQL volume.' >&2
			return 1
		fi
		reporting_preflight_volume_identity() { :; }
		reporting_preflight_network_identity() { printf 'unsafe-network\n'; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unsafe PostgreSQL network.' >&2
			return 1
		fi
		reporting_preflight_network_identity() { :; }
		reporting_preflight_host_port_is_listening() { return 0; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an occupied PostgreSQL port.' >&2
			return 1
		fi
		reporting_preflight_host_port_is_listening() { return 2; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test ignored a failed host-port inspection.' >&2
			return 1
		fi
		reporting_preflight_host_port_is_listening() { return 1; }
		printf 'marker\n' >"$REPORTING_DATABASE_MARKER"
		reporting_validate_database_marker() { return 0; }
		reporting_marker_value() { printf '%s\n' "$other_revision"; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted a marker pinned to another revision.' >&2
			return 1
		fi
		reporting_marker_value() {
			case "$1" in
			revision) printf '%s\n' "$revision" ;;
			phase) printf 'preparing\n' ;;
			*) printf 'pending\n' ;;
			esac
		}
		reporting_require_staged_revision() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted preparing state without its staged revision.' >&2
			return 1
		fi
		reporting_require_staged_revision() { :; }
		reporting_validate_preflight_state "$revision" status
		reporting_preflight_compose_container_ids() { printf '%s\n' "$partial_container_id"; }
		reporting_preflight_network_identity() {
			printf '%s|bridge|local|false|reporting|postgres-network\n' \
				"$REPORTING_CANONICAL_POSTGRES_NETWORK"
		}
		reporting_preflight_volume_identity() {
			printf '%s|local|local|reporting|postgres-data|%s\n' \
				"$REPORTING_CANONICAL_POSTGRES_VOLUME" "$revision"
		}
		reporting_preflight_owned_container_ids() { printf '%s\n' "$partial_container_id"; }
		reporting_preflight_named_container_ids() { printf '%s\n' "$partial_container_id"; }
		reporting_preflight_port_container_ids() { printf '%s\n' "$partial_container_id"; }
		reporting_validate_preflight_state "$revision" status
		reporting_verify_partial_postgres_container_static() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unsafe stopped PostgreSQL container.' >&2
			return 1
		fi
		reporting_verify_partial_postgres_container_static() { :; }
		reporting_preflight_container_running() { printf 'true\n'; }
		reporting_validate_preflight_state "$revision" status
		reporting_verify_partial_postgres_container_static() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unsafe starting partial container.' >&2
			return 1
		fi
		reporting_verify_partial_postgres_container_static() { :; }
		reporting_preflight_container_health() { printf 'unhealthy\n'; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unhealthy running partial container.' >&2
			return 1
		fi
		reporting_preflight_container_health() { printf 'healthy\n'; }
		reporting_verify_postgres_container() { :; }
		reporting_validate_preflight_state "$revision" status
		reporting_verify_postgres_container() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted a broken healthy partial container.' >&2
			return 1
		fi
		reporting_verify_postgres_container() { :; }
		reporting_preflight_container_running() { printf 'unknown\n'; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted an unknown partial-container state.' >&2
			return 1
		fi
		reporting_preflight_compose_container_ids() { :; }
		reporting_preflight_network_identity() { :; }
		reporting_preflight_volume_identity() { :; }
		reporting_preflight_owned_container_ids() { :; }
		reporting_preflight_named_container_ids() { :; }
		reporting_preflight_port_container_ids() { :; }
		reporting_marker_value() {
			case "$1" in
			revision) printf '%s\n' "$other_revision" ;;
			phase) printf 'prepared\n' ;;
			container_id) printf '%064d\n' 0 ;;
			postgres_image_id) printf 'sha256:%064d\n' 0 ;;
			postgres_system_identifier) printf '123\n' ;;
			*) return 1 ;;
			esac
		}
		reporting_validate_preflight_state "$revision" status
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test allowed prepare against an older prepared revision.' >&2
			return 1
		fi
		reporting_marker_value() {
			case "$1" in
			revision) printf '%s\n' "$revision" ;;
			phase) printf 'prepared\n' ;;
			container_id) printf '%064d\n' 0 ;;
			postgres_image_id) printf 'sha256:%064d\n' 0 ;;
			postgres_system_identifier) printf '123\n' ;;
			*) return 1 ;;
			esac
		}
		reporting_verify_postgres_container() { return 1; }
		if reporting_validate_preflight_state "$revision" prepare >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted broken prepared resources.' >&2
			return 1
		fi
		reporting_verify_postgres_container() { :; }
		reporting_verify_role_boundaries() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted unsafe prepared roles.' >&2
			return 1
		fi
		reporting_verify_role_boundaries() { :; }
		reporting_secret_snapshot() { return 1; }
		if reporting_validate_preflight_state "$revision" status >/dev/null 2>&1; then
			echo 'Reporting lifecycle self-test accepted a missing prepared secret.' >&2
			return 1
		fi
	) || return 1
	source_text="$(declare -f reporting_preflight_env_contract)"
	state_source_text="$(declare -f reporting_validate_preflight_state \
		reporting_validate_preparing_resources \
		reporting_preflight_network_identity \
		reporting_preflight_volume_identity \
		reporting_preflight_compose_container_ids \
		reporting_preflight_owned_container_ids \
		reporting_preflight_named_container_ids \
		reporting_preflight_port_container_ids \
		reporting_preflight_host_port_is_listening \
		reporting_preflight_container_running \
		reporting_preflight_container_health \
		reporting_verify_partial_postgres_container_static)"
	acl_configure_text="$(declare -f reporting_configure_roles_and_schema)"
	acl_reconcile_text="$(declare -f reporting_reconcile_database_acl)"
	role_boundary_text="$(declare -f reporting_verify_role_boundaries)"
	access_boundary_text="$(declare -f reporting_verify_database_access_boundaries)"
	[[ "$source_text" == *'config --quiet'* &&
		"$source_text" == *'reporting_require_staged_revision "$revision"'* &&
		"$source_text" == *'reporting_validate_admin_secret_precondition'* &&
		"$source_text" == *'reporting_require_local_docker_daemon'* &&
		"$source_text" == *'env_snapshot_before'* &&
		"$source_text" == *'env_snapshot_after'* &&
		"$source_text" == *'REPORTING_SCHEDULER_ENABLED must remain false during phase-A database prepare.'* &&
		"$source_text" != *' compose up '* &&
		"$source_text" != *' compose build '* &&
		"$source_text" != *'docker run'* &&
		"$source_text" != *'docker exec'* &&
		"$source_text" != *'docker volume'* &&
		"$source_text" != *'reporting_write_database_marker'* ]] || {
		echo 'Reporting env preflight is missing Compose validation or contains a mutating operation.' >&2
		return 1
	}
	[[ "$state_source_text" == *'reporting_verify_postgres_container'* &&
		"$state_source_text" == *'reporting_verify_role_boundaries'* &&
		"$state_source_text" != *'reporting_database_status'* &&
		"$state_source_text" != *'reporting_validate_database_urls'* &&
		"$state_source_text" != *'reporting_parse_database_url'* &&
		"$state_source_text" != *'reporting_database_psql'* &&
		"$state_source_text" != *'docker run'* &&
		"$state_source_text" != *'docker exec'* ]] || {
		echo 'Reporting read-only state preflight can transitively create a parser or client container.' >&2
		return 1
	}
	[[ "$acl_configure_text" == *'ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_reporting_migration'* &&
		"$acl_configure_text" == *'REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup'* &&
		"$acl_reconcile_text" == *'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reporting FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup'* &&
		"$acl_reconcile_text" == *'REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_reporting_runtime, winwidget_reporting_backup'* &&
		"$role_boundary_text" == *'defaults.defaclnamespace = 0'* &&
		"$role_boundary_text" == *"acldefault('f', routine.proowner)"* &&
		"$access_boundary_text" == *'deployment_acl_function_smoke'* &&
		"$access_boundary_text" == *'Reporting future table or sequence ACL is unsafe'* &&
		"$access_boundary_text" == *'Reporting future function ACL is unsafe'* ]] || {
		echo 'Reporting function default ACL hardening is incomplete.' >&2
		return 1
	}
	post_cleanup_contract_text="$(declare -f \
		reporting_require_post_cleanup_revision_contract)"
	post_cleanup_token_path_text="$(declare -f \
		reporting_require_exact_post_cleanup_token_paths)"
	checkout_guard_text="$(declare -f reporting_guard_before_checkout_revision)"
	[[ "$post_cleanup_contract_text" == *'REPORTING_STEADY_STATE_REMOVED_PATHS'* &&
		"$post_cleanup_contract_text" == *'REPORTING_STEADY_STATE_FORBIDDEN_SOURCE_TOKENS'* &&
		"$post_cleanup_contract_text" == *'REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SOURCE_PATHS'* &&
		"$post_cleanup_contract_text" == *'REPORTING_STEADY_STATE_DAILY_SUMMARY_ADMIN_SYMBOL_PATHS'* &&
		"$(printf '%s\n' "$post_cleanup_contract_text" | awk \
			'/reporting_require_exact_post_cleanup_token_paths/ { count += 1 } END { print count + 0 }')" == '2' &&
		"$post_cleanup_token_path_text" == *'grep -I -l -F -e "$token"'* &&
		"$post_cleanup_token_path_text" == *'LC_ALL=C sort'* &&
		"$post_cleanup_contract_text" == *'cat-file -e "$revision^{commit}"'* &&
		"$post_cleanup_contract_text" == *'src prisma/schema.prisma'* &&
		"$checkout_guard_text" == *'cleanup-staged)'* &&
		"$checkout_guard_text" == *'source-cleaned)'* &&
		"$checkout_guard_text" == *'complete)'* &&
		"$(printf '%s\n' "$checkout_guard_text" | awk \
			'/reporting_require_post_cleanup_revision_contract/ { count += 1 } END { print count + 0 }')" == '3' ]] || {
		echo 'Reporting steady-state checkout guard does not enforce the post-cleanup source contract.' >&2
		return 1
	}
	prepare_text="$(declare -f reporting_prepare_database)"
	admin_precondition_index="$(printf '%s\n' "$prepare_text" | grep -n 'reporting_validate_admin_secret_precondition' | cut -d: -f1)"
	marker_write_index="$(printf '%s\n' "$prepare_text" | grep -n 'reporting_write_database_marker preparing' | cut -d: -f1)"
	[[ "$prepare_text" == *'DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION'* &&
		"$admin_precondition_index" =~ ^[0-9]+$ &&
		"$marker_write_index" =~ ^[0-9]+$ &&
		"$admin_precondition_index" -lt "$marker_write_index" ]] || {
		echo 'Reporting database prepare identity or admin-secret ordering is unsafe.' >&2
		return 1
	}

	[[ "$(reporting_first_rollout_deploy_action true "$revision")" == 'stage' ]] || {
		echo 'Reporting lifecycle self-test did not stage an automatic first rollout.' >&2
		return 1
	}
	if reporting_first_rollout_deploy_action false "$revision" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test allowed manual prepare without a staged marker.' >&2
		return 1
	fi
	{
		printf 'version=1\nrevision=%s\nstaged_at=2026-07-31T00:00:00Z\n' "$revision"
	} >"$staged_marker"
	reporting_validate_staged_marker_contents "$staged_marker"
	# The portable contents test intentionally does not require root ownership.
	reporting_validate_first_rollout_staged_marker() {
		reporting_validate_staged_marker_contents "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER"
	}
	[[ "$(reporting_first_rollout_deploy_action false "$revision")" == 'prepare' &&
		"$(reporting_first_rollout_deploy_action true "$revision")" == 'stage' ]] || {
		echo 'Reporting lifecycle self-test classified the staged first rollout incorrectly.' >&2
		return 1
	}
	reporting_guard_before_checkout_revision "$revision"
	if reporting_guard_before_checkout_revision "$other_revision" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test accepted a checkout different from the staged revision.' >&2
		return 1
	fi
	printf 'revision=%s\n' "$revision" >>"$staged_marker"
	if reporting_validate_staged_marker_contents "$staged_marker"; then
		echo 'Reporting lifecycle self-test accepted a duplicate staged marker key.' >&2
		return 1
	fi

	{
		printf 'version=1\nphase=preparing\nrevision=%s\n' "$revision"
		printf 'target_volume=%s\npostgres_image=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME" "$REPORTING_CANONICAL_POSTGRES_IMAGE"
		printf 'postgres_image_id=pending\npostgres_system_identifier=pending\ncontainer_id=pending\n'
		printf 'prepared_at=2026-07-31T00:00:00Z\n'
	} >"$marker"
	reporting_validate_marker_contents "$marker"
	sed 's/phase=preparing/phase=prepared/' "$marker" >"$marker.invalid"
	if reporting_validate_marker_contents "$marker.invalid"; then
		echo 'Reporting lifecycle self-test accepted incomplete prepared identity.' >&2
		return 1
	fi
	{
		printf 'version=1\nphase=prepared\nrevision=%s\n' "$revision"
		printf 'target_volume=%s\npostgres_image=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME" "$REPORTING_CANONICAL_POSTGRES_IMAGE"
		printf 'postgres_image_id=sha256:%064d\npostgres_system_identifier=123456789\ncontainer_id=%064d\n' 1 2
		printf 'prepared_at=2026-07-31T00:00:00Z\n'
	} >"$marker"
	reporting_validate_marker_contents "$marker"
	printf 'unexpected=value\n' >>"$marker"
	if reporting_validate_marker_contents "$marker"; then
		echo 'Reporting lifecycle self-test accepted an unknown marker key.' >&2
		return 1
	fi
	{
		printf 'version=1\nphase=prepared\nrevision=%s\n' "$revision"
		printf 'target_volume=%s\npostgres_image=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME" "$REPORTING_CANONICAL_POSTGRES_IMAGE"
		printf 'postgres_image_id=sha256:%064d\npostgres_system_identifier=123456789\ncontainer_id=%064d\n' 1 2
		printf 'prepared_at=2026-07-31T00:00:00Z\n'
	} >"$REPORTING_DATABASE_MARKER"
	reporting_validate_database_marker() {
		reporting_validate_marker_contents "$REPORTING_DATABASE_MARKER"
	}
	reporting_guard_before_checkout_revision "$revision"
	if reporting_guard_before_checkout_revision "$other_revision" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test allowed checkout drift before cutover initialization.' >&2
		return 1
	fi
	{
		printf 'version=1\nphase=preflight\nrevision=%s\n' "$revision"
		printf 'database_system_identifier=123456789\n'
		printf 'database_volume=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME"
		printf 'backfill_snapshot_id=pending\nbackfill_sha256=pending\n'
		printf 'shadow_evidence_sha256=pending\nscheduler_step=pending\n'
		printf 'scheduler_evidence_sha256=pending\nroute_evidence_sha256=pending\n'
		printf 'restore_evidence_sha256=pending\nswitch_generation=pending\n'
		printf 'cleanup_previous_revision=pending\ncleanup_revision=pending\n'
		printf 'cleanup_review_evidence_sha256=pending\ncleanup_manifest_sha256=pending\n'
		printf 'cleanup_restore_evidence_sha256=pending\nsource_cleanup_evidence_sha256=pending\n'
		printf 'completion_evidence_sha256=pending\nupdated_at=2026-07-31T00:00:00Z\n'
	} >"$cutover_marker"
	reporting_cutover_validate_marker_contents "$cutover_marker"
	reporting_cutover_validate_marker() {
		reporting_cutover_validate_marker_contents "$REPORTING_CUTOVER_MARKER"
	}
	reporting_guard_before_checkout_revision "$revision"
	if reporting_guard_before_checkout_revision "$other_revision" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test allowed checkout drift during active cutover.' >&2
		return 1
	fi
	if reporting_first_rollout_deploy_action true "$other_revision" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test allowed a routine deploy at another active-cutover revision.' >&2
		return 1
	fi
	reporting_require_post_cleanup_revision_contract() {
		[[ "$1" == "$other_revision" ]]
	}
	sed -i.bak \
		-e 's/^phase=preflight$/phase=complete/' \
		-e 's/^backfill_snapshot_id=pending$/backfill_snapshot_id=12345678-1234-4123-8123-123456789abc/' \
		-e 's/^backfill_sha256=pending$/backfill_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
		-e 's/^shadow_evidence_sha256=pending$/shadow_evidence_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' \
		-e 's/^scheduler_step=pending$/scheduler_step=target-owned/' \
		-e 's/^scheduler_evidence_sha256=pending$/scheduler_evidence_sha256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/' \
		-e 's/^route_evidence_sha256=pending$/route_evidence_sha256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/' \
		-e 's/^restore_evidence_sha256=pending$/restore_evidence_sha256=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/' \
		-e 's/^switch_generation=pending$/switch_generation=7/' \
		-e "s/^cleanup_previous_revision=pending$/cleanup_previous_revision=$revision/" \
		-e "s/^cleanup_revision=pending$/cleanup_revision=$other_revision/" \
		-e 's/^cleanup_review_evidence_sha256=pending$/cleanup_review_evidence_sha256=2222222222222222222222222222222222222222222222222222222222222222/' \
		-e 's/^cleanup_manifest_sha256=pending$/cleanup_manifest_sha256=3333333333333333333333333333333333333333333333333333333333333333/' \
		-e 's/^cleanup_restore_evidence_sha256=pending$/cleanup_restore_evidence_sha256=4444444444444444444444444444444444444444444444444444444444444444/' \
		-e 's/^source_cleanup_evidence_sha256=pending$/source_cleanup_evidence_sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/' \
		-e 's/^completion_evidence_sha256=pending$/completion_evidence_sha256=1111111111111111111111111111111111111111111111111111111111111111/' \
		"$cutover_marker"
	rm -f -- "$cutover_marker.bak"
	reporting_cutover_validate_marker_contents "$cutover_marker"
	reporting_guard_before_checkout_revision "$other_revision"
	[[ "$(reporting_first_rollout_deploy_action true "$other_revision")" == 'deploy' ]] || {
		echo 'Reporting lifecycle self-test did not release the checkout guard after complete.' >&2
		return 1
	}
	printf 'unexpected=value\n' >>"$cutover_marker"
	if reporting_guard_before_checkout_revision "$revision" >/dev/null 2>&1; then
		echo 'Reporting lifecycle self-test accepted an invalid cutover marker before checkout.' >&2
		return 1
	fi
	status_text="$(declare -f reporting_database_status)"
	[[ "$status_text" != *'reporting_validate_production_files'* &&
		"$status_text" != *'reporting_compose'* &&
		"$status_text" != *'reporting_database_psql'* &&
		"$status_text" != *'docker run'* &&
		"$status_text" != *'docker create'* &&
		"$status_text" != *'docker start'* &&
		"$status_text" != *'docker stop'* &&
		"$status_text" != *'docker rm'* ]] || {
		echo 'Reporting diagnostic status contains a mutating or expensive lifecycle operation.' >&2
		return 1
	}
	rm -f -- "$REPORTING_DATABASE_MARKER" "$REPORTING_FIRST_ROLLOUT_STAGED_MARKER" \
		"$REPORTING_CUTOVER_MARKER"
	(
		REPORTING_APP_ROOT="$temporary_root"
		reporting_require_local_docker_daemon() { :; }
		reporting_preflight_owned_container_ids() { :; }
		reporting_preflight_named_container_ids() { :; }
		reporting_preflight_port_container_ids() { :; }
		reporting_preflight_network_identity() { :; }
		reporting_preflight_volume_identity() { :; }
		reporting_preflight_host_port_is_listening() { return 1; }
		status_output="$(reporting_database_status)"
		[[ "$status_output" == *'staged_marker=absent'* &&
			"$status_output" == *'database_marker=absent'* &&
			"$status_output" == *'cutover_marker=absent'* &&
			"$status_output" == *'database_identity=absent'* ]]
	) || {
		echo 'Reporting diagnostic status rejected a clean absent state.' >&2
		return 1
	}
	printf 'invalid\n' >"$REPORTING_DATABASE_MARKER"
	(
		REPORTING_APP_ROOT="$temporary_root"
		reporting_validate_database_marker() { return 1; }
		reporting_require_local_docker_daemon() { :; }
		reporting_preflight_owned_container_ids() { :; }
		reporting_preflight_named_container_ids() { :; }
		reporting_preflight_port_container_ids() { :; }
		reporting_preflight_network_identity() { :; }
		reporting_preflight_volume_identity() { :; }
		reporting_preflight_host_port_is_listening() { return 1; }
		if status_output="$(reporting_database_status 2>/dev/null)"; then
			echo 'Reporting diagnostic status accepted an invalid marker.' >&2
			return 1
		fi
		[[ "$status_output" == *'database_marker=invalid'* &&
			"$status_output" == *'database_identity=absent'* ]]
	) || return 1
	trap - RETURN
	[[ "$temporary_root" == "${TMPDIR:-/tmp}/winwidget-reporting-lifecycle."* ]] || return 1
	rm -rf -- "$temporary_root"
	echo 'Reporting staged revision, database marker, ambient Compose and phase-A action helpers verified.'
}

reporting_database_lifecycle_main() {
	local stage_action
	set -Eeuo pipefail
	case "${1:-}" in
	preflight-env)
		[[ $# == 2 ]] || {
			echo "Usage: EXPECTED_REVISION=<sha> $0 preflight-env prepare|status" >&2
			return 1
		}
		[[ "$(id -u)" == '0' ]] || {
			echo 'Reporting production env preflight must run as root.' >&2
			return 1
		}
		reporting_preflight_env_contract "${EXPECTED_REVISION:-}" "$2"
		;;
	stage)
		[[ $# == 1 ]] || return 1
		[[ "$(id -u)" == '0' ]] || {
			echo 'Reporting first-rollout staging must run as root.' >&2
			return 1
		}
		# shellcheck source=scripts/production-deploy-lock.sh
		source "$REPORTING_APP_ROOT/winwidget.ru_server/scripts/production-deploy-lock.sh"
		acquire_production_deploy_lock 'Reporting first-rollout staging'
		# database-restore-production-guard: before-mutation
		database_restore_guard_assert_before_mutation \
			identity-if-present "$REPORTING_ENV_FILE"
		reporting_validate_exact_revision "${EXPECTED_REVISION:-}"
		stage_action="$(reporting_first_rollout_deploy_action true "${EXPECTED_REVISION:-}")" || {
			echo 'Reporting first-rollout marker state is invalid.' >&2
			return 1
		}
		[[ "$stage_action" == 'stage' ]] || {
			echo "Reporting first-rollout staging is not allowed while lifecycle action is $stage_action." >&2
			return 1
		}
		reporting_write_first_rollout_staged_marker "${EXPECTED_REVISION:-}"
		echo "Reporting first rollout staged at revision ${EXPECTED_REVISION:-}; no database or runtime resource was changed."
		;;
	prepare)
		[[ $# == 1 ]] || {
			echo "Usage: EXPECTED_REVISION=<sha> $0 prepare" >&2
			return 1
		}
		# shellcheck source=scripts/production-deploy-lock.sh
		source "$REPORTING_APP_ROOT/winwidget.ru_server/scripts/production-deploy-lock.sh"
		acquire_production_deploy_lock 'Reporting database prepare'
		# database-restore-production-guard: before-mutation
		database_restore_guard_assert_before_mutation \
			identity-if-present "$REPORTING_ENV_FILE"
		reporting_prepare_database "${EXPECTED_REVISION:-}"
		;;
	status)
		[[ $# == 1 ]] || return 1
		reporting_database_status
		;;
	--self-test)
		[[ $# == 1 ]] || return 1
		reporting_database_lifecycle_self_test
		;;
	--guard-before-checkout-revision)
		[[ $# == 2 ]] || return 1
		# database-restore-production-guard: before-checkout
		database_restore_guard_assert_before_checkout "$REPORTING_ENV_FILE"
		reporting_guard_before_checkout_revision "$2"
		;;
	--guard-before-fetch-revision)
		[[ $# == 2 ]] || return 1
		# database-restore-production-guard: before-fetch
		database_restore_guard_assert_before_checkout "$REPORTING_ENV_FILE"
		reporting_guard_before_fetch_revision "$2"
		;;
	--require-staged-revision)
		[[ $# == 2 ]] || return 1
		reporting_require_staged_revision "$2"
		;;
	*)
		echo "Usage: EXPECTED_REVISION=<sha> $0 preflight-env prepare|status | EXPECTED_REVISION=<sha> $0 stage | EXPECTED_REVISION=<sha> $0 prepare | $0 status | $0 --guard-before-fetch-revision SHA | $0 --guard-before-checkout-revision SHA | $0 --require-staged-revision SHA | $0 --self-test" >&2
		return 1
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	reporting_database_lifecycle_main "$@"
fi
