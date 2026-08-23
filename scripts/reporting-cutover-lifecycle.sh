#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"

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
readonly REPORTING_EVIDENCE_ROOT="$APP_ROOT/deploy/backend/reporting-evidence"
readonly REPORTING_CANONICAL_OPERATIONAL_ALERTS_THREAD_ID='2024'
readonly REPORTING_LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION='42c422ca4c2c3a8ce758a37773d6cb0e6b689db7'
readonly REPORTING_LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID='sha256:e64d78b3dc511dde592641e979eb0b506b815f0e83c4eb943ac45b1780c3f554'
readonly REPORTING_CORE_CLEANUP_BACKUP_DUMP="$APP_ROOT/deploy/backend/reporting-core-cleanup-backup-v1.dump"
readonly REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE="$APP_ROOT/deploy/backend/reporting-core-cleanup-backup-v1.json"
readonly REPORTING_CORE_CLEANUP_BACKUP_MAX_AGE_SECONDS='86400'
readonly REPORTING_FRONTEND_RUNTIME_ATTESTATION="${REPORTING_FRONTEND_RUNTIME_ATTESTATION:-$APP_ROOT/deploy/backend/reporting-frontend-runtime-attestation-v1.json}"
readonly REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE="${REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE:-$APP_ROOT/deploy/backend/reporting-frontend-runtime-attestation-v1.sig}"
readonly REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY="${REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY:-$APP_ROOT/deploy/backend/reporting-frontend-runtime-attestation-v1.public.pem}"
readonly REPORTING_FRONTEND_RUNTIME_ATTESTATION_MAX_AGE_SECONDS='3600'
REPORTING_CLEANUP_LEGACY_QUEUES=(
	winwidget.report.daily-summary.telegram
	winwidget.report.daily-summary.telegram.dead-letter
	winwidget.report.daily-summary.telegram.retry-v2.1
	winwidget.report.daily-summary.telegram.retry-v2.2
	winwidget.report.daily-summary.telegram.retry-v2.3
)
REPORTING_CLEANUP_RETAINED_QUEUES=(
	winwidget.admin.audit.reporting.v1
	winwidget.admin.audit.reporting.v1.dead-letter
	winwidget.admin.audit.reporting.v1.retry-v2.1
	winwidget.admin.audit.reporting.v1.retry-v2.2
	winwidget.admin.audit.reporting.v1.retry-v2.3
	winwidget.notification.daily-summary.telegram
	winwidget.notification.daily-summary.telegram.dead-letter
	winwidget.notification.daily-summary.telegram.retry-v2.1
	winwidget.notification.daily-summary.telegram.retry-v2.2
	winwidget.notification.daily-summary.telegram.retry-v2.3
)
REPORTING_CLEANUP_REMOVED_PATHS=(
	src/messaging/daily-summary-event.ts
	src/reports
	src/statistics
)
REPORTING_CLEANUP_PRESERVED_PATHS=(
	apps/reporting/prisma/schema.prisma
	prisma/migrations/20260731010000_add_reporting_projection_producers
	src/messaging/reporting-admin-audit-event.ts
	src/reporting-internal/reporting-internal-token.guard.spec.ts
	src/reporting-internal/reporting-internal-token.guard.ts
	src/reporting-internal/reporting-internal.constants.ts
	src/reporting-internal/reporting-internal.controller.spec.ts
	src/reporting-internal/reporting-internal.controller.ts
	src/reporting-internal/reporting-internal.module.ts
	src/reporting-internal/reporting-schedule-authority.service.spec.ts
)
REPORTING_CLEANUP_MUTABLE_REPORTING_PATHS=(
	apps/reporting/src/messaging/reporting-messaging.constants.spec.ts
	apps/reporting/src/messaging/reporting-messaging.constants.ts
	apps/reporting/src/messaging/reporting-rabbitmq.service.spec.ts
	apps/reporting/src/projections/projection.service.spec.ts
	apps/reporting/src/projections/projection.service.ts
	apps/reporting/src/projections/reporting-event.contract.spec.ts
	apps/reporting/src/projections/reporting-event.contract.ts
	apps/reporting/src/shadow-evidence/reporting-shadow-evidence.service.ts
	apps/reporting/test/integration/reporting.integration.mjs
)
REPORTING_CLEANUP_MUTABLE_CORE_PATHS=(
	prisma/schema.prisma
	src/app.module.ts
	src/health/health.service.spec.ts
	src/maintenance/maintenance-scheduler.service.spec.ts
	src/maintenance/maintenance-scheduler.service.ts
	src/maintenance/maintenance-worker.service.spec.ts
	src/maintenance/scheduled-tasks.service.spec.ts
	src/maintenance/scheduled-tasks.service.ts
	src/messaging/integration-delivery.service.spec.ts
	src/messaging/integration-delivery.service.ts
	src/messaging/integration-error-classifier.ts
	src/messaging/integration-worker.module.ts
	src/messaging/integration-worker.service.spec.ts
	src/messaging/integration-worker.service.ts
	src/messaging/messaging-admin.service.ts
	src/messaging/messaging-event-contract.ts
	src/messaging/messaging-operational-alert.service.spec.ts
	src/messaging/messaging.constants.ts
	src/messaging/notification-delivery-event.ts
	src/messaging/reporting-projection-contract.spec.ts
	src/reporting-internal/reporting-schedule-authority.service.ts
	src/scheduled-jobs/scheduled-jobs.service.spec.ts
	src/scheduled-jobs/scheduled-jobs.types.ts
	src/telegram-bot/dto/update-telegram-bot-settings.dto.ts
	src/telegram-bot/telegram-bot.controller.ts
	src/telegram-bot/telegram-bot.service.spec.ts
	src/telegram-bot/telegram-bot.service.ts
)
REPORTING_CLEANUP_MUTABLE_CONTROL_PLANE_PATHS=(
	.env.example
	.github/workflows/deploy-production.yml
	apps/notification-delivery/test/integration/notification-delivery.integration.mjs
	deploy/docker-compose.prod.yml
	scripts/deploy-production.sh
	scripts/deploy-reporting-production.sh
	scripts/reporting-cutover-lifecycle.sh
	scripts/reporting-database-lifecycle.sh
	scripts/reporting-producer-lifecycle.sh
	scripts/test-messaging-integration.mjs
	scripts/test-reporting-cutover-rehearsal.sh
	scripts/test-reporting-production-scripts.sh
)
REPORTING_CLEANUP_ADDED_CONTROL_PLANE_PATHS=(
	scripts/generate-reporting-frontend-runtime-attestation.sh
	scripts/run-reporting-restore-cutover-smoke.sh
	scripts/run-reporting-scheduler-cutover-smoke.sh
)
REPORTING_CLEANUP_TRUSTED_PATHS=(
	.dockerignore
	Dockerfile
	apps/api-gateway
	apps/campaigns
	apps/notification-delivery/.dockerignore
	apps/notification-delivery/.eslintrc.cjs
	apps/notification-delivery/.gitignore
	apps/notification-delivery/.prettierignore
	apps/notification-delivery/Dockerfile
	apps/notification-delivery/emails
	apps/notification-delivery/nest-cli.json
	apps/notification-delivery/package.json
	apps/notification-delivery/pnpm-lock.yaml
	apps/notification-delivery/prisma
	apps/notification-delivery/src
	apps/notification-delivery/tsconfig.build.json
	apps/notification-delivery/tsconfig.json
	apps/reporting/Dockerfile
	apps/reporting/package.json
	apps/reporting/pnpm-lock.yaml
	deploy/nginx.conf
	docker-entrypoint.sh
	nest-cli.json
	package.json
	pnpm-lock.yaml
	scripts/core-database-production-guard.sh
	scripts/database-restore-production-guard.sh
	scripts/production-deploy-lock.sh
	tsconfig.build.json
	tsconfig.json
)

# shellcheck source=scripts/production-deploy-lock.sh
source "$reporting_lifecycle_source_root/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$reporting_lifecycle_source_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/reporting-database-lifecycle.sh
if ! declare -F reporting_validate_database_marker >/dev/null; then
	source "$reporting_lifecycle_source_root/scripts/reporting-database-lifecycle.sh"
fi
# shellcheck source=scripts/reporting-producer-lifecycle.sh
source "$reporting_lifecycle_source_root/scripts/reporting-producer-lifecycle.sh"

reporting_cutover_export_pinned_runtime_identity() {
	local revision="$1"
	reporting_export_pinned_runtime_identity "$revision"
	DATABASE_RESTORE_REVISION="$revision"
	DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$revision"
	export DATABASE_RESTORE_REVISION DATABASE_RESTORE_IMAGE
}

reporting_cutover_validate_transition() {
	local current="$1" next="$2" current_index next_index
	current_index="$(reporting_cutover_phase_index "$current")" || return 1
	next_index="$(reporting_cutover_phase_index "$next")" || return 1
	((next_index == current_index + 1))
}

reporting_cutover_allows_pre_audit_worker() {
	local migrated_index phase phase_index producer_state
	producer_state="$(reporting_core_producer_bootstrap_state)" || {
		echo 'Core Reporting producer state is unavailable while checking the audit consumer bootstrap.' >&2
		return 1
	}
	[[ "$producer_state" == 'absent' ||
		"$producer_state" == 'never-activated' ]] || return 1
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		return 0
	fi
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is invalid while checking the audit consumer bootstrap.' >&2
		return 1
	}
	phase="$(reporting_cutover_marker_value phase)"
	phase_index="$(reporting_cutover_phase_index "$phase")"
	migrated_index="$(reporting_cutover_phase_index migrated)"
	((phase_index < migrated_index))
}

reporting_cutover_worker_kinds_allowed() {
	local actual="$1" current="$2" pre_reporting="$3"
	local phase pre_cleanup post_cleanup
	[[ -n "$actual" && -n "$current" && -n "$pre_reporting" ]] || return 1
	if [[ "$actual" == "$current" ]]; then
		return 0
	fi
	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		reporting_cutover_validate_marker || return 1
		phase="$(reporting_cutover_marker_value phase)" || return 1
		if [[ "$phase" == 'cleanup-staged' ]]; then
			pre_cleanup="$(reporting_normalize_integration_kinds \
				"$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS")"
			post_cleanup="$(reporting_normalize_integration_kinds \
				"$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS")"
			[[ "$actual" == "$pre_cleanup" && "$current" == "$post_cleanup" ]] && return 0
		fi
	fi
	[[ "$actual" == "$pre_reporting" ]] || return 1
	reporting_cutover_allows_pre_audit_worker
}

reporting_cutover_write_marker() {
	[[ $# == 18 ]] || return 1
	local phase="$1" revision="$2" system_identifier="$3"
	local backfill_snapshot_id="$4" backfill_sha256="$5"
	local shadow_evidence_sha256="$6" scheduler_step="$7"
	local scheduler_evidence_sha256="$8" route_evidence_sha256="$9"
	local restore_evidence_sha256="${10}" source_cleanup_evidence_sha256="${11}"
	local completion_evidence_sha256="${12}"
	local switch_generation="${13}" cleanup_previous_revision="${14}"
	local cleanup_revision="${15}" cleanup_review_evidence_sha256="${16}"
	local cleanup_manifest_sha256="${17}" cleanup_restore_evidence_sha256="${18}"
	local marker_directory temporary_marker
	marker_directory="$(dirname "$REPORTING_CUTOVER_MARKER")"
	reporting_validate_root_owned_directory "$marker_directory" || {
		echo 'Reporting cutover marker directory is unsafe.' >&2
		return 1
	}
	temporary_marker="$marker_directory/.reporting-database-cutover-v1.$$"
	[[ ! -e "$temporary_marker" && ! -L "$temporary_marker" ]] || return 1
	if ! {
		(umask 077; {
			printf 'version=1\n'
			printf 'phase=%s\n' "$phase"
			printf 'revision=%s\n' "$revision"
			printf 'database_system_identifier=%s\n' "$system_identifier"
			printf 'database_volume=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME"
			printf 'backfill_snapshot_id=%s\n' "$backfill_snapshot_id"
			printf 'backfill_sha256=%s\n' "$backfill_sha256"
			printf 'shadow_evidence_sha256=%s\n' "$shadow_evidence_sha256"
			printf 'scheduler_step=%s\n' "$scheduler_step"
			printf 'scheduler_evidence_sha256=%s\n' "$scheduler_evidence_sha256"
			printf 'route_evidence_sha256=%s\n' "$route_evidence_sha256"
			printf 'restore_evidence_sha256=%s\n' "$restore_evidence_sha256"
			printf 'switch_generation=%s\n' "$switch_generation"
			printf 'cleanup_previous_revision=%s\n' "$cleanup_previous_revision"
			printf 'cleanup_revision=%s\n' "$cleanup_revision"
			printf 'cleanup_review_evidence_sha256=%s\n' "$cleanup_review_evidence_sha256"
			printf 'cleanup_manifest_sha256=%s\n' "$cleanup_manifest_sha256"
			printf 'cleanup_restore_evidence_sha256=%s\n' "$cleanup_restore_evidence_sha256"
			printf 'source_cleanup_evidence_sha256=%s\n' "$source_cleanup_evidence_sha256"
			printf 'completion_evidence_sha256=%s\n' "$completion_evidence_sha256"
			printf 'updated_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
		} >"$temporary_marker") &&
			chown 0:0 "$temporary_marker" &&
			chmod 600 "$temporary_marker" &&
			reporting_cutover_validate_marker_contents "$temporary_marker" &&
			mv -f "$temporary_marker" "$REPORTING_CUTOVER_MARKER"
	}; then
		rm -f -- "$temporary_marker"
		return 1
	fi
	reporting_cutover_validate_marker
}

reporting_cutover_advance_marker() {
	local next="$1" current revision system_identifier
	local backfill_snapshot_id backfill_sha256 shadow_evidence_sha256
	local scheduler_step scheduler_evidence_sha256 restore_evidence_sha256
	local route_evidence_sha256 source_cleanup_evidence_sha256
	local completion_evidence_sha256
	local switch_generation cleanup_previous_revision cleanup_revision
	local cleanup_review_evidence_sha256 cleanup_manifest_sha256
	local cleanup_restore_evidence_sha256
	reporting_cutover_validate_marker || return 1
	current="$(reporting_cutover_marker_value phase)"
	reporting_cutover_validate_transition "$current" "$next" || {
		echo "Reporting cutover cannot skip or repeat phase $current -> $next." >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	backfill_snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha256="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_evidence_sha256="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	scheduler_step="$(reporting_cutover_marker_value scheduler_step)"
	scheduler_evidence_sha256="$(reporting_cutover_marker_value scheduler_evidence_sha256)"
	route_evidence_sha256="$(reporting_cutover_marker_value route_evidence_sha256)"
	restore_evidence_sha256="$(reporting_cutover_marker_value restore_evidence_sha256)"
	source_cleanup_evidence_sha256="$(reporting_cutover_marker_value source_cleanup_evidence_sha256)"
	completion_evidence_sha256="$(reporting_cutover_marker_value completion_evidence_sha256)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	cleanup_previous_revision="$(reporting_cutover_marker_value cleanup_previous_revision)"
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
	cleanup_review_evidence_sha256="$(reporting_cutover_marker_value cleanup_review_evidence_sha256)"
	cleanup_manifest_sha256="$(reporting_cutover_marker_value cleanup_manifest_sha256)"
	cleanup_restore_evidence_sha256="$(reporting_cutover_marker_value cleanup_restore_evidence_sha256)"
	reporting_cutover_write_marker "$next" "$revision" "$system_identifier" \
		"$backfill_snapshot_id" "$backfill_sha256" "$shadow_evidence_sha256" \
		"$scheduler_step" "$scheduler_evidence_sha256" "$route_evidence_sha256" \
		"$restore_evidence_sha256" "$source_cleanup_evidence_sha256" \
		"$completion_evidence_sha256" "$switch_generation" \
		"$cleanup_previous_revision" "$cleanup_revision" \
		"$cleanup_review_evidence_sha256" "$cleanup_manifest_sha256" \
		"$cleanup_restore_evidence_sha256"
}

reporting_cutover_require_phase() {
	local expected="$1" actual
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is missing or invalid.' >&2
		return 1
	}
	actual="$(reporting_cutover_marker_value phase)"
	[[ "$actual" == "$expected" ]] || {
		echo "Reporting cutover requires phase=$expected, current phase=$actual." >&2
		return 1
	}
}

reporting_cutover_require_evidence_root() {
	local parent mode
	parent="$(dirname "$REPORTING_EVIDENCE_ROOT")"
	reporting_validate_root_owned_directory "$parent" || {
		echo 'Reporting evidence parent directory is unsafe.' >&2
		return 1
	}
	if [[ ! -e "$REPORTING_EVIDENCE_ROOT" && ! -L "$REPORTING_EVIDENCE_ROOT" ]]; then
		(umask 077; mkdir "$REPORTING_EVIDENCE_ROOT") || return 1
		chown 0:0 "$REPORTING_EVIDENCE_ROOT"
		chmod 700 "$REPORTING_EVIDENCE_ROOT"
	fi
	[[ -d "$REPORTING_EVIDENCE_ROOT" && ! -L "$REPORTING_EVIDENCE_ROOT" &&
		"$(reporting_stat_owner "$REPORTING_EVIDENCE_ROOT")" == '0:0' ]] || {
		echo 'Reporting evidence root must be a root-owned non-symlink directory.' >&2
		return 1
	}
	mode="$(reporting_stat_mode "$REPORTING_EVIDENCE_ROOT")"
	[[ "$mode" == '700' ]] || {
		echo 'Reporting evidence root must have mode 700.' >&2
		return 1
	}
}

reporting_cutover_evidence_path() {
	local kind="$1" sha256="$2"
	[[ "$kind" =~ ^[a-z0-9-]+$ && "$sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s/%s-%s.json\n' "$REPORTING_EVIDENCE_ROOT" "$kind" "$sha256"
}

reporting_cutover_require_stable_digest() {
	local kind="$1" source="$2" expected_sha256="$3" actual_sha256
	actual_sha256="$(reporting_sha256_file "$source")" || return 1
	[[ "$actual_sha256" == "$expected_sha256" ]] || {
		echo "Reporting $kind evidence changed while it was being validated." >&2
		return 1
	}
}

reporting_cutover_archive_evidence() {
	local kind="$1" source="$2" sha256="$3" destination temporary
	[[ "$source" == /* && -f "$source" && ! -L "$source" &&
		"$(reporting_stat_owner "$source")" == '0:0' &&
		"$(reporting_stat_mode "$source")" == '600' &&
		"$(reporting_sha256_file "$source")" == "$sha256" ]] || {
		echo "Reporting $kind evidence is not a root-owned mode-600 file with the expected digest." >&2
		return 1
	}
	reporting_cutover_require_evidence_root
	destination="$(reporting_cutover_evidence_path "$kind" "$sha256")" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		[[ -f "$destination" && ! -L "$destination" &&
			"$(reporting_stat_owner "$destination")" == '0:0' &&
			"$(reporting_stat_mode "$destination")" == '600' &&
			"$(reporting_sha256_file "$destination")" == "$sha256" ]] || {
			echo "Archived Reporting $kind evidence is unsafe or differs from its digest." >&2
			return 1
		}
		return
	fi
	temporary="$REPORTING_EVIDENCE_ROOT/.${kind}-${sha256}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! {
		(umask 077; cp "$source" "$temporary") &&
			chown 0:0 "$temporary" &&
			chmod 600 "$temporary" &&
			[[ "$(reporting_sha256_file "$temporary")" == "$sha256" ]] &&
			mv "$temporary" "$destination"
	}; then
		rm -f -- "$temporary"
		return 1
	fi
}

reporting_cutover_require_archived_evidence() {
	local kind="$1" sha256="$2" path
	[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
	reporting_cutover_require_evidence_root
	path="$(reporting_cutover_evidence_path "$kind" "$sha256")" || return 1
	[[ -f "$path" && ! -L "$path" &&
		"$(reporting_stat_owner "$path")" == '0:0' &&
		"$(reporting_stat_mode "$path")" == '600' &&
		"$(reporting_sha256_file "$path")" == "$sha256" ]] || {
		echo "Archived Reporting $kind evidence is missing or invalid." >&2
		return 1
	}
}

# Runtime deploys may happen before the cutover marker exists, while the
# scheduler owner is in the intentional hand-off gap, or after the forward
# boundary. Keep those states explicit so routine deploy scripts cannot infer a
# safe scheduler/route topology from an arbitrary environment value.
reporting_cutover_runtime_scheduler_policy() {
	local phase phase_index scheduler_switched_index scheduler_step
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" &&
		! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		printf 'disabled\n'
		return
	fi
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is present but invalid.' >&2
		return 1
	}
	phase="$(reporting_cutover_marker_value phase)"
	phase_index="$(reporting_cutover_phase_index "$phase")"
	scheduler_switched_index="$(reporting_cutover_phase_index scheduler-switched)"
	if ((phase_index >= scheduler_switched_index)); then
		printf 'enabled\n'
		return
	fi
	if [[ "$phase" == 'shadow-verified' ]]; then
		scheduler_step="$(reporting_cutover_marker_value scheduler_step)"
		if [[ "$scheduler_step" == 'target-owned' ]]; then
			printf 'transitional\n'
			return
		fi
		if [[ "$scheduler_step" != 'pending' ]]; then
			printf 'fenced\n'
			return
		fi
	fi
	printf 'disabled\n'
}

reporting_cutover_runtime_gateway_policy() {
	local phase phase_index scheduler_switched_index
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" &&
		! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		printf 'dark\n'
		return
	fi
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is present but invalid.' >&2
		return 1
	}
	phase="$(reporting_cutover_marker_value phase)"
	phase_index="$(reporting_cutover_phase_index "$phase")"
	scheduler_switched_index="$(reporting_cutover_phase_index scheduler-switched)"
	if ((phase_index >= scheduler_switched_index)); then
		printf 'reporting\n'
	else
		printf 'dark\n'
	fi
}

reporting_cutover_scheduler_value_allowed() {
	local policy="$1" value="$2"
	case "$policy" in
	disabled) [[ "$value" == 'false' ]] ;;
	fenced) [[ "$value" == 'false' ]] ;;
	transitional) [[ "$value" == 'false' || "$value" == 'true' ]] ;;
	enabled) [[ "$value" == 'true' ]] ;;
	*) return 1 ;;
	esac
}

reporting_cutover_initialize() {
	local revision="$1" system_identifier
	[[ ! -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]] || {
		echo 'Reporting cutover marker already exists; resume it instead of replacing it.' >&2
		return 1
	}
	reporting_validate_database_marker
	[[ "$(reporting_marker_value phase)" == 'prepared' &&
		"$(reporting_marker_value revision)" == "$revision" ]] || {
		echo 'Reporting database must be prepared at the exact cutover revision.' >&2
		return 1
	}
	reporting_initialize_database_guard 'Reporting cutover preflight'
	system_identifier="$(reporting_marker_value postgres_system_identifier)"
	reporting_cutover_write_marker preflight "$revision" "$system_identifier" \
		pending pending pending pending pending pending pending pending pending \
		pending pending pending pending pending pending
	echo 'Reporting cutover initialized at phase=preflight. No route, scheduler or source ownership changed.'
}

reporting_cutover_verify_target_created() {
	reporting_verify_database_lifecycle_unchanged
	reporting_cutover_advance_marker target-created
}

reporting_cutover_verify_roles_ready() {
	reporting_verify_role_boundaries
	reporting_cutover_advance_marker roles-ready
}

reporting_cutover_verify_migrated() {
	local state
	state="$(reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  to_regclass('reporting.identity_user_projections') IS NOT NULL
  AND to_regclass('reporting.projection_receipts') IS NOT NULL
  AND to_regclass('reporting.consumer_receipts') IS NOT NULL
  AND to_regclass('reporting.backfill_runs') IS NOT NULL
  AND to_regclass('reporting.reporting_settings') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'reporting'
      AND table_name = 'reporting_settings'
      AND column_name = 'core_operational_alerts_thread_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'reporting'
      AND table_name = 'reporting_settings'
      AND column_name = 'schedule_authority_generation'
      AND data_type = 'bigint'
      AND is_nullable = 'NO'
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting._prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  )
THEN 'ready' ELSE 'missing' END;
")"
	[[ "$state" == 'ready' ]] || {
		echo 'Reporting migrations or required tables are incomplete.' >&2
		return 1
	}
	reporting_cutover_advance_marker migrated
}

reporting_cutover_verify_producers_enabled() {
	local revision state
	revision="$(reporting_cutover_marker_value revision)"
	reporting_require_core_producer_migration
	reporting_require_core_producer_acl
	reporting_require_dark_service_ready "$revision" >/dev/null
	reporting_require_outbox_publisher_ready "$revision"
	reporting_require_rabbitmq_topology
	reporting_require_admin_audit_consumer_ready "$revision"
	state="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN "enabled" AND "activated_at" IS NOT NULL
THEN '"'"'ready'"'"' ELSE '"'"'disabled'"'"' END
FROM "reporting_producer_state" WHERE "id" = '"'"'singleton'"'"';
')"
	[[ "$state" == 'ready' ]] || {
		echo 'Core Reporting producers are not enabled.' >&2
		return 1
	}
	reporting_cutover_advance_marker producers-enabled
}

reporting_cutover_run_backfill() {
	local previous_snapshot result snapshot_id sha256 revision system_identifier
	reporting_cutover_require_phase producers-enabled
	previous_snapshot="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT COALESCE((SELECT snapshot_id::TEXT FROM reporting.backfill_runs
WHERE status = 'VERIFIED'::reporting.\"ReportingBackfillStatus\"
ORDER BY verified_at DESC NULLS LAST LIMIT 1), 'none');
")"
	reporting_compose run --rm --no-deps \
		-e REPORTING_PROCESS_ROLE=backfill \
		--entrypoint node reporting-service dist/src/backfill/main.js
	result="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --field-separator='|' --command "
SELECT snapshot_id::TEXT, btrim(sha256), record_count::TEXT
FROM reporting.backfill_runs
WHERE status = 'VERIFIED'::reporting.\"ReportingBackfillStatus\"
  AND sha256 = expected_sha256
ORDER BY verified_at DESC NULLS LAST
LIMIT 1;
")"
	IFS='|' read -r snapshot_id sha256 _record_count <<<"$result"
	[[ "$snapshot_id" =~ ^[0-9a-f-]{36}$ && "$snapshot_id" != "$previous_snapshot" &&
		"$sha256" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Backfill did not create a new checksum-verified snapshot.' >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	reporting_cutover_write_marker backfilled "$revision" "$system_identifier" \
		"$snapshot_id" "$sha256" pending pending pending pending pending pending pending \
		pending pending pending pending pending pending
	echo "Reporting backfill verified snapshot=$snapshot_id sha256=$sha256."
}

reporting_cutover_require_empty_projection_queues() {
	local rabbitmq_container queues kind queue _routing_key retry_index name line
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues -p winwidget name messages_ready messages_unacknowledged consumers)"
	while IFS='|' read -r kind queue _routing_key; do
		[[ -n "$kind" ]] || continue
		line="$(printf '%s\n' "$queues" | grep -E "^${queue//./\.}[[:space:]]+0[[:space:]]+0[[:space:]]+[1-9][0-9]*$" || true)"
		[[ -n "$line" && "$line" != *$'\n'* ]] || return 1
		for name in "$queue.dead-letter" "$queue.retry.1" "$queue.retry.2" "$queue.retry.3"; do
			line="$(printf '%s\n' "$queues" | grep -E "^${name//./\.}[[:space:]]+0[[:space:]]+0[[:space:]]+[0-9]+$" || true)"
			[[ -n "$line" && "$line" != *$'\n'* ]] || return 1
		done
	done < <(reporting_queue_matrix)
}

reporting_cutover_core_projection_barrier_state() {
	reporting_core_psql --tuples-only --no-align --field-separator='|' --command '
SELECT
  COALESCE(MAX("source_sequence") FILTER (
    WHERE "aggregate_type" = '"'"'identity.user'"'"'
  ), 0)::TEXT,
  COALESCE(MAX("source_sequence") FILTER (
    WHERE "aggregate_type" = '"'"'billing.payment'"'"'
  ), 0)::TEXT,
  COALESCE(MAX("source_sequence") FILTER (
    WHERE "aggregate_type" = '"'"'billing.subscription'"'"'
  ), 0)::TEXT,
  COALESCE(MAX("source_sequence") FILTER (
    WHERE "aggregate_type" LIKE '"'"'widgets.widget.%'"'"'
  ), 0)::TEXT,
  COALESCE(MAX("source_sequence") FILTER (
    WHERE "aggregate_type" LIKE '"'"'widgets.lead.%'"'"'
  ), 0)::TEXT,
  COALESCE(MAX("source_sequence") FILTER (
    WHERE "aggregate_type" IN (
      '"'"'reporting.settings'"'"',
      '"'"'reporting.core-operational-routing.changed.v1'"'"'
    )
  ), 0)::TEXT,
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM "outbox_events"
    WHERE "event_type" IN (
      '"'"'identity.user.changed.v1'"'"',
      '"'"'billing.payment.changed.v1'"'"',
      '"'"'billing.subscription.changed.v1'"'"',
      '"'"'widgets.widget.changed.v1'"'"',
      '"'"'widgets.lead.changed.v1'"'"',
      '"'"'reporting.settings.changed.v1'"'"',
      '"'"'reporting.core-operational-routing.changed.v1'"'"'
    ) AND "status" <> '"'"'PUBLISHED'"'"'::"OutboxEventStatus"
  ) THEN '"'"'clear'"'"' ELSE '"'"'pending'"'"' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM "reporting_producer_state"
    WHERE "id" = '"'"'singleton'"'"'
      AND "enabled" = TRUE
      AND "activated_at" IS NOT NULL
  ) THEN '"'"'ready'"'"' ELSE '"'"'unsafe'"'"' END
FROM "reporting_projection_versions";
'
}

reporting_cutover_target_projection_barrier_state() {
	[[ $# == 6 ]] || return 1
	local identity_user="$1" billing_payment="$2" billing_subscription="$3"
	local widget="$4" lead="$5" reporting_settings="$6"
	local snapshot_id sha256 value
	for value in "$identity_user" "$billing_payment" "$billing_subscription" \
		"$widget" "$lead" "$reporting_settings"; do
		[[ "$value" =~ ^[0-9]+$ ]] || return 1
	done
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	sha256="$(reporting_cutover_marker_value backfill_sha256)"
	reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
WITH snapshot AS (
  SELECT watermarks
  FROM reporting.backfill_runs
  WHERE snapshot_id = '$snapshot_id'::UUID
    AND btrim(sha256) = '$sha256'
    AND btrim(expected_sha256) = '$sha256'
    AND status = 'VERIFIED'::reporting.\"ReportingBackfillStatus\"
), expected(stream, source_sequence) AS (
  VALUES
    ('identityUser', $identity_user::NUMERIC),
    ('billingPayment', $billing_payment::NUMERIC),
    ('billingSubscription', $billing_subscription::NUMERIC),
    ('widget', $widget::NUMERIC),
    ('lead', $lead::NUMERIC),
    ('reportingSettings', $reporting_settings::NUMERIC)
), snapshot_watermarks(stream, value) AS (
  SELECT entry.key, entry.value
  FROM snapshot, LATERAL jsonb_each_text(snapshot.watermarks) entry
), malformed_snapshot_watermark AS (
  SELECT 1
  FROM expected
  FULL JOIN snapshot_watermarks USING (stream)
  WHERE expected.stream IS NULL
    OR snapshot_watermarks.stream IS NULL
    OR CASE
      WHEN snapshot_watermarks.value ~ '^[0-9]+$'
        THEN snapshot_watermarks.value::NUMERIC > expected.source_sequence
      ELSE TRUE
    END
), mismatched_watermark AS (
  SELECT 1
  FROM expected
  LEFT JOIN reporting.projection_watermarks actual
    ON actual.stream = expected.stream
  WHERE COALESCE(actual.source_sequence, 0) <> expected.source_sequence
)
SELECT CASE WHEN
  (SELECT count(*) FROM snapshot) = 1
  AND NOT EXISTS (SELECT 1 FROM malformed_snapshot_watermark)
  AND NOT EXISTS (SELECT 1 FROM mismatched_watermark)
  AND NOT EXISTS (
    SELECT 1 FROM reporting.projection_watermarks
    WHERE stream NOT IN (
      'identityUser', 'billingPayment', 'billingSubscription',
      'widget', 'lead', 'reportingSettings'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM reporting.projection_watermarks watermark
    LEFT JOIN reporting.projection_receipts receipt
      ON receipt.event_id = watermark.event_id
      AND receipt.projection = watermark.stream
      AND receipt.source_sequence = watermark.source_sequence
    WHERE receipt.id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.consumer_receipts
    WHERE status IN (
      'PROCESSING'::reporting.\"ReportingConsumerReceiptStatus\",
      'RETRY_SCHEDULED'::reporting.\"ReportingConsumerReceiptStatus\"
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.consumer_failures
    WHERE status IN (
      'OPEN'::reporting.\"ReportingConsumerFailureStatus\",
      'RETRY_REQUESTED'::reporting.\"ReportingConsumerFailureStatus\"
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.outbox_events
    WHERE status <> 'PUBLISHED'::reporting.\"ReportingOutboxStatus\"
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.backfill_runs
    WHERE status = 'RUNNING'::reporting.\"ReportingBackfillStatus\"
  )
THEN 'clear' ELSE 'pending' END;
"
}

reporting_cutover_require_projection_barrier() {
	local active_revision first_state phase second_state target_state value
	local identity_user billing_payment billing_subscription widget lead
	local reporting_settings outbox_state producer_state
	phase="$(reporting_cutover_marker_value phase)"
	case "$phase" in
	cleanup-staged | source-cleaned | complete)
		active_revision="$(reporting_cutover_marker_value cleanup_revision)"
		;;
	*) active_revision="$(reporting_cutover_marker_value revision)" ;;
	esac
	[[ "$active_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	reporting_require_core_producer_migration
	reporting_require_core_producer_acl
	reporting_require_outbox_publisher_ready "$active_revision"
	reporting_require_rabbitmq_topology
	first_state="$(reporting_cutover_core_projection_barrier_state)" || return 1
	IFS='|' read -r identity_user billing_payment billing_subscription widget lead \
		reporting_settings outbox_state producer_state <<<"$first_state"
	for value in "$identity_user" "$billing_payment" "$billing_subscription" \
		"$widget" "$lead" "$reporting_settings"; do
		[[ "$value" =~ ^[0-9]+$ ]] || return 1
	done
	[[ "$outbox_state" == 'clear' ]] || {
		echo 'Core Reporting projection Outbox is not fully published.' >&2
		return 1
	}
	[[ "$producer_state" == 'ready' ]] || {
		echo 'Core Reporting projection producers are not durably enabled.' >&2
		return 1
	}
	reporting_cutover_require_empty_projection_queues || {
		echo 'Reporting main/retry/DLQ queues are not drained with active main consumers.' >&2
		return 1
	}
	target_state="$(reporting_cutover_target_projection_barrier_state \
		"$identity_user" "$billing_payment" "$billing_subscription" \
		"$widget" "$lead" "$reporting_settings")" || return 1
	[[ "$target_state" == 'clear' ]] || {
		echo 'Reporting watermarks, receipts, failures, Outbox or backfill are not caught up to Core.' >&2
		return 1
	}
	second_state="$(reporting_cutover_core_projection_barrier_state)" || return 1
	[[ "$second_state" == "$first_state" ]] || {
		echo 'Core Reporting projection barrier changed during verification.' >&2
		return 1
	}
	reporting_cutover_require_empty_projection_queues || {
		echo 'Reporting projection queues changed during barrier verification.' >&2
		return 1
	}
	target_state="$(reporting_cutover_target_projection_barrier_state \
		"$identity_user" "$billing_payment" "$billing_subscription" \
		"$widget" "$lead" "$reporting_settings")" || return 1
	[[ "$target_state" == 'clear' ]] || {
		echo 'Reporting projection state changed during barrier verification.' >&2
		return 1
	}
}

reporting_cutover_verify_caught_up() {
	reporting_cutover_require_phase backfilled
	reporting_cutover_require_projection_barrier
	reporting_cutover_advance_marker caught-up
	echo 'Reporting caught-up barrier passed: exact Core/target watermarks, Outbox, Rabbit queues, receipts, failures and backfill are clear.'
}

reporting_cutover_validate_shadow_evidence() {
	local evidence="$1" revision="$2" image_id="$3"
	local core_system_identifier="$4" reporting_system_identifier="$5"
	local backfill_snapshot_id="$6" backfill_sha256="$7"
	[[ -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_mode "$evidence")" == '600' &&
		"$(reporting_stat_owner "$evidence")" == '0:0' ]] || {
		echo 'Shadow evidence must be a root-owned regular file with mode 600.' >&2
		return 1
	}
	[[ "$image_id" == "$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" ]] || return 1
	reporting_run_isolated_node_validator "$image_id" '
const { readFileSync } = require("node:fs");
const { parseReportingShadowEvidence } = require(
  "/app/dist/src/shadow-evidence/reporting-shadow-evidence.contract.js"
);
const value = parseReportingShadowEvidence(readFileSync("/evidence.json", "utf8"));
if (value.revision !== process.env.EXPECTED_REVISION ||
    value.imageId !== process.env.EXPECTED_IMAGE_ID ||
    value.source.systemIdentifier !== process.env.EXPECTED_CORE_SYSTEM_IDENTIFIER ||
    value.target.systemIdentifier !== process.env.EXPECTED_REPORTING_SYSTEM_IDENTIFIER ||
    value.target.backfillSnapshotId !== process.env.EXPECTED_BACKFILL_SNAPSHOT_ID ||
    value.target.backfillSha256 !== process.env.EXPECTED_BACKFILL_SHA256) process.exit(1);
' \
		-e "EXPECTED_REVISION=$revision" \
		-e "EXPECTED_IMAGE_ID=$image_id" \
		-e "EXPECTED_CORE_SYSTEM_IDENTIFIER=$core_system_identifier" \
		-e "EXPECTED_REPORTING_SYSTEM_IDENTIFIER=$reporting_system_identifier" \
		-e "EXPECTED_BACKFILL_SNAPSHOT_ID=$backfill_snapshot_id" \
		-e "EXPECTED_BACKFILL_SHA256=$backfill_sha256" \
		-v "$evidence:/evidence.json:ro" >/dev/null
}

reporting_cutover_run_shadow_evidence_cli() {
	local action="$1" revision="$2" image_id="$3"
	local core_system_identifier="$4" reporting_system_identifier="$5"
	local backfill_snapshot_id="$6" backfill_sha256="$7"
	local backup_url
	backup_url="$(reporting_get_env_value REPORTING_BACKUP_URL)" || return 1
	[[ "$action" == 'generate' || "$action" == 'verify' ]] || return 1
	[[ "$image_id" == "$(reporting_resolve_image_id_for_revision "$revision")" ]] || return 1
	REPORTING_IMAGE="$image_id" \
	REPORTING_DATABASE_URL="$backup_url" \
	REPORTING_SHADOW_EXPECTED_REVISION="$revision" \
	REPORTING_SHADOW_EXPECTED_IMAGE_ID="$image_id" \
	REPORTING_SHADOW_EXPECTED_CORE_SYSTEM_IDENTIFIER="$core_system_identifier" \
	REPORTING_SHADOW_EXPECTED_REPORTING_SYSTEM_IDENTIFIER="$reporting_system_identifier" \
	REPORTING_SHADOW_EXPECTED_BACKFILL_SNAPSHOT_ID="$backfill_snapshot_id" \
	REPORTING_SHADOW_EXPECTED_BACKFILL_SHA256="$backfill_sha256" \
		reporting_compose run --rm --no-deps -T \
			-e REPORTING_PROCESS_ROLE=backfill \
			-e REPORTING_DATABASE_URL \
			-e REPORTING_SHADOW_EXPECTED_REVISION \
			-e REPORTING_SHADOW_EXPECTED_IMAGE_ID \
			-e REPORTING_SHADOW_EXPECTED_CORE_SYSTEM_IDENTIFIER \
			-e REPORTING_SHADOW_EXPECTED_REPORTING_SYSTEM_IDENTIFIER \
			-e REPORTING_SHADOW_EXPECTED_BACKFILL_SNAPSHOT_ID \
			-e REPORTING_SHADOW_EXPECTED_BACKFILL_SHA256 \
			--entrypoint node reporting-service \
			dist/src/shadow-evidence/main.js "$action"
}

reporting_cutover_prepare_shadow_evidence() {
	local revision image_id core_system_identifier reporting_system_identifier
	local backfill_snapshot_id backfill_sha256 temporary sha256 destination
	reporting_cutover_require_phase caught-up
	reporting_cutover_require_projection_barrier
	revision="$(reporting_cutover_marker_value revision)"
	image_id="$(reporting_resolve_image_id_for_revision "$revision")" || return 1
	core_system_identifier="$CORE_POSTGRES_SYSTEM_IDENTIFIER"
	reporting_system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	backfill_snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha256="$(reporting_cutover_marker_value backfill_sha256)"
	reporting_cutover_require_evidence_root
	temporary="$REPORTING_EVIDENCE_ROOT/.shadow-candidate.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! (umask 077; reporting_cutover_run_shadow_evidence_cli generate \
		"$revision" "$image_id" "$core_system_identifier" \
		"$reporting_system_identifier" "$backfill_snapshot_id" \
		"$backfill_sha256" >"$temporary"); then
		rm -f -- "$temporary"
		return 1
	fi
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	if ! reporting_cutover_require_projection_barrier ||
		! reporting_cutover_validate_shadow_evidence "$temporary" "$revision" \
			"$image_id" "$core_system_identifier" "$reporting_system_identifier" \
			"$backfill_snapshot_id" "$backfill_sha256" ||
		! reporting_cutover_run_shadow_evidence_cli verify "$revision" "$image_id" \
			"$core_system_identifier" "$reporting_system_identifier" \
			"$backfill_snapshot_id" "$backfill_sha256" <"$temporary" ||
		! reporting_cutover_require_projection_barrier; then
		rm -f -- "$temporary"
		return 1
	fi
	sha256="$(reporting_sha256_file "$temporary")"
	destination="$(reporting_cutover_evidence_path shadow-candidate "$sha256")" || {
		rm -f -- "$temporary"
		return 1
	}
	if [[ -e "$destination" || -L "$destination" ]]; then
		[[ -f "$destination" && ! -L "$destination" &&
			"$(reporting_stat_owner "$destination")" == '0:0' &&
			"$(reporting_stat_mode "$destination")" == '600' &&
			"$(reporting_sha256_file "$destination")" == "$sha256" ]] || {
			rm -f -- "$temporary"
			return 1
		}
		rm -f -- "$temporary"
	else
		mv "$temporary" "$destination"
	fi
	echo "Reporting shadow candidate generated from live Core/Reporting data: $destination"
	echo "Set REPORTING_SHADOW_EVIDENCE_FILE=$destination"
	echo "After reviewing actual values, set CONFIRM_REPORTING_SHADOW_VERIFIED=shadow:$revision:$sha256 and run shadow-verified."
}

reporting_cutover_verify_shadow() {
	local revision evidence sha256 system_identifier snapshot_id backfill_sha256
	local image_id core_system_identifier expected_candidate
	reporting_cutover_require_phase caught-up
	reporting_cutover_require_projection_barrier
	revision="$(reporting_cutover_marker_value revision)"
	image_id="$(reporting_resolve_image_id_for_revision "$revision")" || return 1
	core_system_identifier="$CORE_POSTGRES_SYSTEM_IDENTIFIER"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha256="$(reporting_cutover_marker_value backfill_sha256)"
	evidence="${REPORTING_SHADOW_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_SHADOW_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	expected_candidate="$(reporting_cutover_evidence_path shadow-candidate "$sha256")" || return 1
	[[ "$evidence" == "$expected_candidate" ]] || {
		echo 'Shadow evidence must be the lifecycle-generated digest-named candidate.' >&2
		return 1
	}
	reporting_cutover_validate_shadow_evidence "$evidence" "$revision" \
		"$image_id" "$core_system_identifier" "$system_identifier" \
		"$snapshot_id" "$backfill_sha256"
	reporting_cutover_run_shadow_evidence_cli verify "$revision" "$image_id" \
		"$core_system_identifier" "$system_identifier" "$snapshot_id" \
		"$backfill_sha256" <"$evidence"
	reporting_cutover_require_projection_barrier
	reporting_cutover_require_stable_digest shadow "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_SHADOW_VERIFIED:-}" == "shadow:$revision:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_SHADOW_VERIFIED=shadow:$revision:$sha256 after reviewing the exact evidence." >&2
		return 1
	}
	reporting_cutover_archive_evidence shadow "$evidence" "$sha256"
	reporting_cutover_write_marker shadow-verified "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha256" "$sha256" pending pending pending pending pending pending \
		pending pending pending pending pending pending
	echo "Reporting shadow evidence verified sha256=$sha256."
}

reporting_cutover_rewrite_scheduler_state() {
	local scheduler_step="$1" scheduler_evidence_sha256="${2:-pending}"
	local switch_generation_override="${3:-}"
	local backfill_snapshot_override="${4:-}" backfill_sha256_override="${5:-}"
	local phase revision system_identifier snapshot_id backfill_sha256
	local shadow_evidence_sha256 route_evidence_sha256 restore_evidence_sha256
	local source_cleanup_evidence_sha256 completion_evidence_sha256
	local switch_generation cleanup_previous_revision cleanup_revision
	local cleanup_review_evidence_sha256 cleanup_manifest_sha256
	local cleanup_restore_evidence_sha256
	phase="$(reporting_cutover_marker_value phase)"
	revision="$(reporting_cutover_marker_value revision)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha256="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_evidence_sha256="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	route_evidence_sha256="$(reporting_cutover_marker_value route_evidence_sha256)"
	restore_evidence_sha256="$(reporting_cutover_marker_value restore_evidence_sha256)"
	source_cleanup_evidence_sha256="$(reporting_cutover_marker_value source_cleanup_evidence_sha256)"
	completion_evidence_sha256="$(reporting_cutover_marker_value completion_evidence_sha256)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	cleanup_previous_revision="$(reporting_cutover_marker_value cleanup_previous_revision)"
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
	cleanup_review_evidence_sha256="$(reporting_cutover_marker_value cleanup_review_evidence_sha256)"
	cleanup_manifest_sha256="$(reporting_cutover_marker_value cleanup_manifest_sha256)"
	cleanup_restore_evidence_sha256="$(reporting_cutover_marker_value cleanup_restore_evidence_sha256)"
	if [[ -n "$switch_generation_override" ]]; then
		switch_generation="$switch_generation_override"
	fi
	if [[ -n "$backfill_snapshot_override" || -n "$backfill_sha256_override" ]]; then
		[[ "$backfill_snapshot_override" =~ ^[0-9a-f-]{36}$ &&
			"$backfill_sha256_override" =~ ^[0-9a-f]{64}$ ]] || return 1
		snapshot_id="$backfill_snapshot_override"
		backfill_sha256="$backfill_sha256_override"
	fi
	reporting_cutover_write_marker "$phase" "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha256" "$shadow_evidence_sha256" \
		"$scheduler_step" "$scheduler_evidence_sha256" "$route_evidence_sha256" \
		"$restore_evidence_sha256" "$source_cleanup_evidence_sha256" \
		"$completion_evidence_sha256" "$switch_generation" \
		"$cleanup_previous_revision" "$cleanup_revision" \
		"$cleanup_review_evidence_sha256" "$cleanup_manifest_sha256" \
		"$cleanup_restore_evidence_sha256"
}

reporting_cutover_require_scheduler_disabled_runtime() {
	local container_id value
	container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	[[ -z "$container_id" || "$container_id" != *$'\n'* ]] || return 1
	if [[ -z "$container_id" ]]; then
		return
	fi
	value="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')"
	[[ "$value" == 'false' ]] || {
		echo 'Reporting scheduler must be disabled before changing scheduler ownership.' >&2
		return 1
	}
}

reporting_cutover_validate_telegram_topic_split_values() {
	local expected_owner="$1" core_value="$2" target_value="$3"
	local core_chat_hash core_operational_thread
	local target_chat_hash target_daily_thread target_operational_chat_hash
	local target_operational_thread
	[[ "$expected_owner" == 'CORE_SHADOW' || "$expected_owner" == 'REPORTING' ]] || return 1
	[[ "$core_value" =~ ^[0-9a-f]{32}\|[1-9][0-9]*$ &&
		"$target_value" =~ ^[0-9a-f]{32}\|[1-9][0-9]*\|[0-9a-f]{32}\|[1-9][0-9]*$ ]] || return 1
	IFS='|' read -r core_chat_hash core_operational_thread <<<"$core_value"
	IFS='|' read -r target_chat_hash target_daily_thread target_operational_chat_hash \
		target_operational_thread <<<"$target_value"
	[[ "$core_operational_thread" == "$REPORTING_CANONICAL_OPERATIONAL_ALERTS_THREAD_ID" &&
		"$core_chat_hash" == "$target_operational_chat_hash" &&
		"$core_operational_thread" == "$target_operational_thread" &&
		! ( "$target_chat_hash" == "$target_operational_chat_hash" &&
			"$target_daily_thread" == "$target_operational_thread" ) ]] || return 1
	if [[ "$expected_owner" == 'CORE_SHADOW' ]]; then
		[[ "$core_chat_hash" == "$target_chat_hash" ]]
	fi
}

reporting_cutover_require_telegram_topic_split() {
	local expected_owner="$1" core_value target_value
	[[ "$expected_owner" == 'CORE_SHADOW' ||
		"$expected_owner" == 'REPORTING' ]] || return 1
	core_value="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN
  count(*) = 1
  AND min("id") = '"'"'singleton'"'"'
  AND min(char_length(btrim("daily_summary_chat_id"))) BETWEEN 1 AND 255
  AND min("operational_alerts_thread_id") > 0
THEN md5(min(btrim("daily_summary_chat_id"))) || '"'"'|'"'"' ||
  min("operational_alerts_thread_id")::TEXT
ELSE '"'"'unsafe'"'"' END
FROM "telegram_bot_settings";
')"
	target_value="$(reporting_database_psql REPORTING_DATABASE_URL \
		--tuples-only --no-align --command "
SELECT CASE WHEN
  count(*) = 1
  AND min(owner::TEXT) = '$expected_owner'
  AND min(char_length(btrim(destination_chat_id))) BETWEEN 1 AND 255
  AND min(message_thread_id) > 0
  AND min(char_length(btrim(core_operational_alerts_destination_chat_id))) BETWEEN 1 AND 255
  AND min(core_operational_alerts_thread_id) > 0
THEN md5(min(btrim(destination_chat_id))) || '|' ||
  min(message_thread_id)::TEXT || '|' ||
  md5(min(btrim(core_operational_alerts_destination_chat_id))) || '|' ||
  min(core_operational_alerts_thread_id)::TEXT
ELSE 'unsafe' END
FROM reporting.reporting_settings
WHERE id = 'daily-summary';
")"
	reporting_cutover_validate_telegram_topic_split_values \
		"$expected_owner" "$core_value" "$target_value" || {
		echo "Telegram routing is unsafe: Core operational routing must match Reporting topic $REPORTING_CANONICAL_OPERATIONAL_ALERTS_THREAD_ID, while Daily Summary must use a distinct route." >&2
		return 1
	}
}

reporting_cutover_validate_schedule_authority_values() {
	local expected_core_owner="$1" expected_target_owner="$2"
	local core_value="$3" target_value="$4"
	local core_owner core_time core_generation
	local target_owner target_time target_timezone target_generation
	[[ "$expected_core_owner" == 'CORE' ||
		"$expected_core_owner" == 'REPORTING' ]] || return 1
	[[ "$expected_target_owner" == 'CORE_SHADOW' ||
		"$expected_target_owner" == 'REPORTING' ]] || return 1
	[[ "$core_value" =~ ^(CORE|REPORTING)\|([01][0-9]|2[0-3]):[0-5][0-9]\|[0-9]+$ &&
		"$target_value" =~ ^(CORE_SHADOW|REPORTING)\|([01][0-9]|2[0-3]):[0-5][0-9]\|Europe/Moscow\|[0-9]+$ ]] || return 1
	IFS='|' read -r core_owner core_time core_generation <<<"$core_value"
	IFS='|' read -r target_owner target_time target_timezone target_generation <<<"$target_value"
	[[ "$core_owner" == "$expected_core_owner" &&
		"$target_owner" == "$expected_target_owner" &&
		"$core_time" == "$target_time" &&
		"$target_timezone" == 'Europe/Moscow' ]] || return 1
	if [[ "$expected_target_owner" == 'REPORTING' &&
		"$core_generation" != "$target_generation" ]]; then
		return 1
	fi
	printf '%s\n' "$core_generation"
}

reporting_cutover_schedule_authority_generation() {
	local expected_core_owner="$1" expected_target_owner="$2"
	local core_value target_value
	core_value="$(reporting_core_psql --tuples-only --no-align --command '
WITH policy AS (
  SELECT
    state."daily_summary_owner" AS owner,
    state."daily_summary_schedule_time" AS schedule_time,
    state."daily_summary_schedule_generation" AS generation,
    split_part(state."daily_summary_schedule_time", '"'"':'"'"', 1)::INTEGER * 60 +
      split_part(state."daily_summary_schedule_time", '"'"':'"'"', 2)::INTEGER AS summary_minutes,
    split_part(settings."database_backup_time", '"'"':'"'"', 1)::INTEGER * 60 +
      split_part(settings."database_backup_time", '"'"':'"'"', 2)::INTEGER AS backup_minutes
  FROM "reporting_producer_state" state
  CROSS JOIN "telegram_bot_settings" settings
  WHERE state."id" = '"'"'singleton'"'"' AND settings."id" = '"'"'singleton'"'"'
)
SELECT CASE WHEN
  owner IN ('"'"'CORE'"'"', '"'"'REPORTING'"'"')
  AND schedule_time ~ '"'"'^([01][0-9]|2[0-3]):[0-5][0-9]$'"'"'
  AND generation >= 0
  AND NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[0, 15, 30, 45]) AS delay(minutes)
    WHERE LEAST(
      ABS(summary_minutes - ((backup_minutes + delay.minutes) % 1440)),
      1440 - ABS(summary_minutes - ((backup_minutes + delay.minutes) % 1440))
    ) < 5
  )
THEN owner || '"'"'|'"'"' || schedule_time || '"'"'|'"'"' || generation::TEXT
ELSE '"'"'unsafe'"'"' END
FROM policy;
')"
	target_value="$(reporting_database_psql REPORTING_DATABASE_URL \
		--tuples-only --no-align --command "
SELECT CASE WHEN count(*) = 1
THEN min(owner::TEXT) || '|' || min(schedule_time) || '|' ||
  min(timezone) || '|' || min(schedule_authority_generation)::TEXT
ELSE 'unsafe' END
FROM reporting.reporting_settings
WHERE id = 'daily-summary';
")"
	reporting_cutover_validate_schedule_authority_values \
		"$expected_core_owner" "$expected_target_owner" \
		"$core_value" "$target_value" || {
		echo 'Daily Summary schedule authority state is invalid or conflicts with a backup.' >&2
		return 1
	}
}

reporting_cutover_require_switch_generation() {
	local expected_owner="$1" expected_generation="${2:-}"
	local actual
	[[ "$expected_owner" == 'CORE' || "$expected_owner" == 'REPORTING' ]] || return 1
	if [[ -z "$expected_generation" ]]; then
		expected_generation="$(reporting_cutover_marker_value switch_generation)"
	fi
	[[ "$expected_generation" =~ ^[1-9][0-9]*$ ]] || return 1
	actual="$(reporting_core_psql --tuples-only --no-align --field-separator='|' --command '
SELECT "daily_summary_owner", "daily_summary_switch_generation"::TEXT
FROM "reporting_producer_state" WHERE "id" = '\''singleton'\'';
')"
	[[ "$actual" == "$expected_owner|$expected_generation" ]] || {
		echo "Daily Summary switch generation drifted: expected $expected_owner|$expected_generation, actual ${actual:-missing}." >&2
		return 1
	}
}

reporting_cutover_stop_core_scheduler() {
	local revision step target_owner result result_owner switch_generation
	reporting_cutover_require_phase shadow-verified
	step="$(reporting_cutover_marker_value scheduler_step)"
	[[ "$step" == 'pending' || "$step" == 'switch-intent' ||
		"$step" == 'core-stopped' ]] || {
		echo "Core scheduler stop cannot resume from scheduler_step=$step." >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	[[ "${CONFIRM_REPORTING_CORE_SCHEDULER_STOP:-}" == "stop-core:$revision" ]] || {
		echo "Set CONFIRM_REPORTING_CORE_SCHEDULER_STOP=stop-core:$revision after reviewing the owner gap." >&2
		return 1
	}
	reporting_cutover_require_scheduler_disabled_runtime
	target_owner="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT COALESCE((SELECT owner::TEXT FROM reporting.reporting_settings
WHERE id = 'daily-summary'), 'missing');
")"
	[[ "$target_owner" == 'CORE_SHADOW' ]] || {
		echo 'Reporting target must remain CORE_SHADOW while stopping the Core owner.' >&2
		return 1
	}
	if [[ "$step" == 'core-stopped' ]]; then
		switch_generation="$(reporting_cutover_marker_value switch_generation)"
		reporting_cutover_require_switch_generation REPORTING "$switch_generation"
		reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		echo 'Core Daily Summary scheduler owner is already stopped at the durable core-stopped checkpoint.'
		return
	fi
	if [[ "$step" == 'pending' ]]; then
		reporting_cutover_schedule_authority_generation CORE CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		# Persist intent before the cross-database owner hand-off. If the shell or
		# SSH session dies after COMMIT, the same action can reconcile the exact
		# REPORTING + CORE_SHADOW state instead of repeating an unknown mutation.
		reporting_cutover_rewrite_scheduler_state switch-intent
	fi
	result="$(reporting_core_migration_psql --tuples-only --no-align --field-separator='|' <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '45s';
SELECT pg_advisory_xact_lock(hashtext('winwidget.reporting.daily-summary.owner.v1'));
SELECT "daily_summary_owner" FROM "reporting_producer_state"
WHERE "id" = 'singleton' FOR UPDATE;
UPDATE "reporting_producer_state"
SET "daily_summary_owner" = 'REPORTING',
    "daily_summary_switch_generation" = "daily_summary_switch_generation" + 1,
    "daily_summary_switched_at" = clock_timestamp() AT TIME ZONE 'UTC',
    "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE "id" = 'singleton' AND "daily_summary_owner" = 'CORE';
SELECT "daily_summary_owner", "daily_summary_switch_generation"::TEXT
FROM "reporting_producer_state" WHERE "id" = 'singleton';
COMMIT;
SQL
)"
	result="$(printf '%s\n' "$result" | grep -E '^REPORTING\|[1-9][0-9]*$' | tail -n 1)"
	[[ "$result" =~ ^REPORTING\|[1-9][0-9]*$ ]] || {
		echo 'Core Daily Summary owner did not reach REPORTING-fenced state.' >&2
		return 1
	}
	IFS='|' read -r result_owner switch_generation <<<"$result"
	[[ "$result_owner" == 'REPORTING' && "$switch_generation" =~ ^[1-9][0-9]*$ ]] || return 1
	reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW >/dev/null
	reporting_cutover_require_telegram_topic_split CORE_SHADOW
	reporting_cutover_rewrite_scheduler_state core-stopped pending "$switch_generation"
	echo 'Core Daily Summary scheduler owner stopped. Reporting remains CORE_SHADOW; drain all legacy work before claiming target ownership.'
}

reporting_cutover_require_empty_named_queue() {
	local queues="$1" queue="$2" line
	line="$(printf '%s\n' "$queues" | grep -E "^${queue//./\.}[[:space:]]+0[[:space:]]+0[[:space:]]+[0-9]+$" || true)"
	[[ -n "$line" && "$line" != *$'\n'* ]] || {
		echo "Daily Summary cutover queue is not empty: $queue" >&2
		return 1
	}
}

reporting_cutover_require_reporting_runtime_stopped() {
	local container_id
	if ! container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null)"; then
		echo 'Unable to verify that the Reporting runtime is stopped; scheduler rollback remains fenced.' >&2
		return 1
	fi
	[[ -z "$container_id" ]] || {
		echo 'Stop the main Reporting service before scheduler rollback so its scheduler, publisher and consumers are fenced together.' >&2
		return 1
	}
}

reporting_cutover_validate_daily_summary_drain_values() {
	[[ "$1" == 'drained' && "$2" == 'drained' ]]
}

reporting_cutover_reporting_daily_summary_database_state() {
	reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM reporting.report_runs
    WHERE status IN (
      'PENDING'::reporting.\"ReportRunStatus\",
      'PROCESSING'::reporting.\"ReportRunStatus\",
      'WAITING_DELIVERY'::reporting.\"ReportRunStatus\"
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.outbox_events
    WHERE event_type = 'notification.daily-summary.telegram.requested.v1'
      AND status <> 'PUBLISHED'::reporting.\"ReportingOutboxStatus\"
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.consumer_receipts
    WHERE consumer = 'reporting-delivery-outcome-v1'
      AND status IN (
        'PROCESSING'::reporting.\"ReportingConsumerReceiptStatus\",
        'RETRY_SCHEDULED'::reporting.\"ReportingConsumerReceiptStatus\"
      )
  )
THEN 'drained' ELSE 'pending' END;
"
}

reporting_cutover_notification_daily_summary_database_state() {
	reporting_database_psql NOTIFICATION_DELIVERY_DATABASE_URL \
		--tuples-only --no-align --command "
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM notification_delivery.delivery_receipts
    WHERE consumer = 'daily-summary-delivery-telegram'
      AND status IN (
        'PROCESSING'::notification_delivery.\"NotificationDeliveryReceiptStatus\",
        'RETRY_SCHEDULED'::notification_delivery.\"NotificationDeliveryReceiptStatus\"
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM notification_delivery.delivery_failures
    WHERE consumer = 'daily-summary-delivery-telegram'
      AND resolved_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM notification_delivery.outbox_events
    WHERE event_type = 'notification.delivery.outcome.v1'
      AND payload->>'sourceKind' = 'daily-summary-delivery-telegram'
      AND status <> 'PUBLISHED'::notification_delivery.\"NotificationDeliveryOutboxStatus\"
  )
THEN 'drained' ELSE 'pending' END;
"
}

reporting_cutover_require_target_daily_summary_drained() {
	local reporting_state notification_state rabbitmq_container queues
	local retry_index
	reporting_cutover_require_reporting_runtime_stopped || return 1
	reporting_state="$(reporting_cutover_reporting_daily_summary_database_state)" || return 1
	notification_state="$(reporting_cutover_notification_daily_summary_database_state)" || return 1
	reporting_cutover_validate_daily_summary_drain_values \
		"$reporting_state" "$notification_state" || {
		echo 'Reporting or Notification Delivery still has active Daily Summary work; scheduler rollback is fenced.' >&2
		return 1
	}

	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues -p winwidget name messages_ready messages_unacknowledged consumers)" || return 1
	reporting_cutover_require_empty_named_queue \
		"$queues" winwidget.notification.daily-summary.telegram || return 1
	reporting_cutover_require_empty_named_queue \
		"$queues" winwidget.notification.daily-summary.telegram.dead-letter || return 1
	reporting_cutover_require_empty_named_queue \
		"$queues" winwidget.reporting.delivery-outcome || return 1
	reporting_cutover_require_empty_named_queue \
		"$queues" winwidget.reporting.delivery-outcome.dead-letter || return 1
	for retry_index in 1 2 3; do
		reporting_cutover_require_empty_named_queue \
			"$queues" "winwidget.notification.daily-summary.telegram.retry-v2.$retry_index" || return 1
		reporting_cutover_require_empty_named_queue \
			"$queues" "winwidget.reporting.delivery-outcome.retry.$retry_index" || return 1
	done

	# A Notification Delivery worker can commit its outcome Outbox immediately
	# after the first DB read. Re-read both databases after the broker snapshot;
	# the stopped Reporting runtime prevents a new request or outcome consume.
	reporting_state="$(reporting_cutover_reporting_daily_summary_database_state)" || return 1
	notification_state="$(reporting_cutover_notification_daily_summary_database_state)" || return 1
	reporting_cutover_validate_daily_summary_drain_values \
		"$reporting_state" "$notification_state" || {
		echo 'Daily Summary drain changed during verification; scheduler rollback remains fenced.' >&2
		return 1
	}
}

reporting_cutover_require_legacy_daily_summary_drained() {
	local state rabbitmq_container queues base retry_index
	state="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM "reporting_producer_state"
    WHERE "id" = '"'"'singleton'"'"' AND "daily_summary_owner" = '"'"'REPORTING'"'"'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "scheduled_job_runs"
    WHERE "job_type" = '"'"'DAILY_TELEGRAM_SUMMARY'"'"'
      AND "status" IN (
        '"'"'QUEUED'"'"'::"ScheduledJobRunStatus",
        '"'"'PROCESSING'"'"'::"ScheduledJobRunStatus"
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "outbox_events"
    WHERE "event_type" IN (
      '"'"'report.daily-summary.requested.v1'"'"',
      '"'"'notification.daily-summary.telegram.requested.v1'"'"',
      '"'"'reporting.settings.changed.v1'"'"'
    ) AND "status" <> '"'"'PUBLISHED'"'"'::"OutboxEventStatus"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "integration_delivery_failures"
    WHERE "integration" IN (
      '"'"'daily-summary-telegram'"'"',
      '"'"'daily-summary-delivery-telegram'"'"'
    ) AND "resolved_at" IS NULL
  )
THEN '"'"'drained'"'"' ELSE '"'"'pending'"'"' END;
')"
	[[ "$state" == 'drained' ]] || {
		echo 'Legacy Daily Summary jobs, Outbox or unresolved failures are not drained.' >&2
		return 1
	}
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues -p winwidget name messages_ready messages_unacknowledged consumers)"
	for base in winwidget.report.daily-summary.telegram winwidget.notification.daily-summary.telegram; do
		reporting_cutover_require_empty_named_queue "$queues" "$base"
		reporting_cutover_require_empty_named_queue "$queues" "$base.dead-letter"
		for retry_index in 1 2 3; do
			reporting_cutover_require_empty_named_queue "$queues" "$base.retry-v2.$retry_index"
		done
	done
	reporting_cutover_require_projection_barrier || {
		echo 'Reporting projection barrier changed after shadow verification.' >&2
		return 1
	}
}

reporting_cutover_require_cleanup_legacy_drain_after_stop() {
	local state rabbitmq_container queues queue line retry_index
	reporting_cutover_require_target_daily_summary_drained || {
		echo 'Target-owned Daily Summary work is not drained at the cleanup migration boundary.' >&2
		return 1
	}
	state="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM "reporting_producer_state"
    WHERE "id" = '"'"'singleton'"'"'
      AND "daily_summary_owner" = '"'"'REPORTING'"'"'
      AND "daily_summary_switch_generation" > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM "scheduled_job_runs"
    WHERE "job_type" = '"'"'DAILY_TELEGRAM_SUMMARY'"'"'
      AND "status" IN (
        '"'"'QUEUED'"'"'::"ScheduledJobRunStatus",
        '"'"'PROCESSING'"'"'::"ScheduledJobRunStatus"
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "outbox_events"
    WHERE "event_type" IN (
      '"'"'report.daily-summary.requested.v1'"'"',
      '"'"'notification.daily-summary.telegram.requested.v1'"'"',
      '"'"'reporting.settings.changed.v1'"'"'
    ) AND "status" <> '"'"'PUBLISHED'"'"'::"OutboxEventStatus"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "integration_delivery_failures"
    WHERE "integration" IN (
      '"'"'daily-summary-telegram'"'"',
      '"'"'daily-summary-delivery-telegram'"'"'
    ) AND "resolved_at" IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM "integration_delivery_receipts"
    WHERE "integration" IN (
      '"'"'daily-summary-telegram'"'"',
      '"'"'daily-summary-delivery-telegram'"'"'
    ) AND "status" IN (
      '"'"'PROCESSING'"'"'::"IntegrationDeliveryReceiptStatus",
      '"'"'RETRY_SCHEDULED'"'"'::"IntegrationDeliveryReceiptStatus"
    )
  )
THEN '"'"'drained'"'"' ELSE '"'"'pending'"'"' END;
')" || return 1
	[[ "$state" == 'drained' ]] || {
		echo 'Stopped Core topology still has active legacy Reporting database state.' >&2
		return 1
	}
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_queues -p winwidget name messages_ready messages_unacknowledged consumers)" || return 1
	for queue in \
		winwidget.report.daily-summary.telegram \
		winwidget.report.daily-summary.telegram.dead-letter; do
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
		[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]] || {
			echo "Legacy Reporting queue is not stopped and empty: $queue" >&2
			return 1
		}
	done
	for retry_index in 1 2 3; do
		queue="winwidget.report.daily-summary.telegram.retry-v2.$retry_index"
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
		[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]] || {
			echo "Legacy Reporting retry queue is not stopped and empty: $queue" >&2
			return 1
		}
	done
	[[ "$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM "scheduled_job_runs"
    WHERE "job_type" = '"'"'DAILY_TELEGRAM_SUMMARY'"'"'
      AND "status" IN (
        '"'"'QUEUED'"'"'::"ScheduledJobRunStatus",
        '"'"'PROCESSING'"'"'::"ScheduledJobRunStatus"
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "outbox_events"
    WHERE "event_type" IN (
      '"'"'report.daily-summary.requested.v1'"'"',
      '"'"'notification.daily-summary.telegram.requested.v1'"'"',
      '"'"'reporting.settings.changed.v1'"'"'
    ) AND "status" <> '"'"'PUBLISHED'"'"'::"OutboxEventStatus"
  )
THEN '"'"'drained'"'"' ELSE '"'"'pending'"'"' END;
')" == 'drained' ]] || {
		echo 'Legacy Reporting database drain changed after the broker snapshot.' >&2
		return 1
	}
}

reporting_cutover_prepare_settings_topology_cleanup_after_stop() {
	local cleanup_revision container_id rabbitmq_container queues bindings
	local queue line retry_index image_id binding_count topology_mode
	reporting_cutover_require_phase cleanup-staged
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)" || return 1
	[[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	[[ -z "$container_id" ]] || {
		echo 'Reporting must be stopped before retiring its transitional RabbitMQ topology.' >&2
		return 1
	}
	topology_mode="$(reporting_settings_topology_mode)" || return 1
	[[ "$topology_mode" == 'transition' || "$topology_mode" == 'steady' ]] || return 1
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_queues -p winwidget name messages_ready messages_unacknowledged consumers)" || return 1
	for queue in winwidget.reporting.settings \
		winwidget.reporting.settings.dead-letter; do
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
		[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]] || {
			echo "Reporting settings queue is not stopped and drained: $queue" >&2
			return 1
		}
	done
	for retry_index in 1 2 3; do
		queue="winwidget.reporting.settings.retry.$retry_index"
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { print; found += 1 } END { exit(found <= 1 ? 0 : 1) }')" || return 1
		[[ -z "$line" ||
			"$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]] || {
			echo "Reporting settings retry queue is not stopped and drained: $queue" >&2
			return 1
		}
	done
	bindings="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_bindings -p winwidget source_name destination_name routing_key)" || return 1
	binding_count="$(reporting_binding_count "$bindings" winwidget.events \
		winwidget.reporting.settings "$REPORTING_LEGACY_SETTINGS_ROUTING_KEY")" || return 1
	[[ "$binding_count" == '0' || "$binding_count" == '1' ]] || {
		echo 'Legacy Reporting settings binding count is unsafe for convergent cleanup.' >&2
		return 1
	}
	local legacy_binding_count="$binding_count"
	binding_count="$(reporting_binding_count "$bindings" winwidget.events \
		winwidget.reporting.settings "$REPORTING_OPERATIONAL_ROUTING_KEY")" || return 1
	[[ "$binding_count" == '1' ]] || {
		echo 'Forward Reporting operational routing binding is missing before cleanup.' >&2
		return 1
	}
	image_id="$(reporting_resolve_image_id_for_revision "$cleanup_revision")" || return 1
	if [[ "$legacy_binding_count" == '1' ]]; then
		docker run --rm --network host --read-only \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--env-file "$ENV_FILE" --entrypoint node "$image_id" -e '
const amqp = require("amqplib");
const url = process.env.RABBITMQ_REPORTING_URL;
if (!url) process.exit(1);
const timer = setTimeout(() => process.exit(124), 15000);
(async () => {
  const connection = await amqp.connect(url, {
    clientProperties: { connection_name: "reporting-cleanup-topology-v1" },
  });
  try {
    const channel = await connection.createChannel();
    try {
      await channel.unbindQueue(
        "winwidget.reporting.settings",
        "winwidget.events",
        "reporting.settings.changed.v1",
      );
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
})().then(() => {
  clearTimeout(timer);
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "RabbitMQ unbind failed"}\n`);
  process.exitCode = 1;
});
' || {
			echo 'Could not remove the exact legacy Reporting settings binding.' >&2
			return 1
		}
	fi
	for retry_index in 1 2 3; do
		queue="winwidget.reporting.settings.retry.$retry_index"
		if printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { found += 1 } END { exit(found == 1 ? 0 : 1) }'; then
			docker exec "$rabbitmq_container" rabbitmqctl --silent delete_queue \
				-p winwidget "$queue" --if-empty --if-unused >/dev/null || return 1
		fi
	done
	bindings="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_bindings -p winwidget source_name destination_name routing_key)" || return 1
	[[ "$(reporting_binding_count "$bindings" winwidget.events \
		winwidget.reporting.settings "$REPORTING_LEGACY_SETTINGS_ROUTING_KEY")" == '0' &&
		"$(reporting_binding_count "$bindings" winwidget.events \
		winwidget.reporting.settings "$REPORTING_OPERATIONAL_ROUTING_KEY")" == '1' ]] || {
		echo 'Reporting settings bindings changed unexpectedly during cleanup preparation.' >&2
		return 1
	}
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_queues -p winwidget name)" || return 1
	for retry_index in 1 2 3; do
		queue="winwidget.reporting.settings.retry.$retry_index"
		if printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { found = 1 } END { exit(found ? 0 : 1) }'; then
			echo "Reporting settings retry queue still exists after cleanup preparation: $queue" >&2
			return 1
		fi
	done
	echo "Reporting settings broker topology converged for forward cleanup from Core schema mode=$topology_mode."
}

reporting_cutover_require_settings_topology_cleanup_converged_after_stop() {
	local container_id rabbitmq_container queues bindings queue line retry_index
	container_id="$(reporting_compose ps --status running -q reporting-service \
		2>/dev/null || true)"
	[[ -z "$container_id" ]] || {
		echo 'Reporting must remain stopped while verifying cleanup broker topology.' >&2
		return 1
	}
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq \
		2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_queues -p winwidget name messages_ready messages_unacknowledged consumers)" || return 1
	for queue in winwidget.reporting.settings \
		winwidget.reporting.settings.dead-letter; do
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
		[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]] || {
			echo "Reporting cleanup settings queue is not stopped and empty: $queue" >&2
			return 1
		}
	done
	for retry_index in 1 2 3; do
		queue="winwidget.reporting.settings.retry.$retry_index"
		if printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { found = 1 } END { exit(found ? 0 : 1) }'; then
			echo "Legacy Reporting settings retry queue exists during cleanup recovery: $queue" >&2
			return 1
		fi
	done
	bindings="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_bindings -p winwidget source_name destination_name routing_key)" || return 1
	[[ "$(reporting_binding_count "$bindings" winwidget.events \
		winwidget.reporting.settings "$REPORTING_LEGACY_SETTINGS_ROUTING_KEY")" == '0' &&
		"$(reporting_binding_count "$bindings" winwidget.events \
		winwidget.reporting.settings "$REPORTING_OPERATIONAL_ROUTING_KEY")" == '1' ]] || {
		echo 'Reporting cleanup settings bindings are not in the exact converged state.' >&2
		return 1
	}
}

reporting_cutover_claim_scheduler_target() {
	local step core_owner result authority_generation switch_generation target_owner
	reporting_cutover_require_phase shadow-verified
	step="$(reporting_cutover_marker_value scheduler_step)"
	[[ "$step" == 'core-stopped' || "$step" == 'target-claim-intent' ||
		"$step" == 'target-owned' ]] || {
		echo "Reporting scheduler claim cannot resume from scheduler_step=$step." >&2
		return 1
	}
	reporting_cutover_require_scheduler_disabled_runtime
	core_owner="$(reporting_core_psql --tuples-only --no-align --command '
SELECT "daily_summary_owner" FROM "reporting_producer_state" WHERE "id" = '"'"'singleton'"'"';
')"
	[[ "$core_owner" == 'REPORTING' ]] || return 1
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	target_owner="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT COALESCE((SELECT owner::TEXT FROM reporting.reporting_settings
WHERE id = 'daily-summary'), 'missing');
")"
	if [[ "$step" == 'target-owned' ]]; then
		[[ "$target_owner" == 'REPORTING' ]] || return 1
		reporting_cutover_schedule_authority_generation REPORTING REPORTING >/dev/null
		reporting_cutover_require_telegram_topic_split REPORTING
		reporting_cutover_require_projection_barrier
		echo 'Reporting already owns Daily Summary at the durable target-owned checkpoint.'
		return
	fi
	if [[ "$step" == 'core-stopped' ]]; then
		[[ "$target_owner" == 'CORE_SHADOW' ]] || return 1
		reporting_cutover_require_legacy_daily_summary_drained
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW >/dev/null
		reporting_cutover_rewrite_scheduler_state target-claim-intent
	fi
	if [[ "$target_owner" == 'CORE_SHADOW' ]]; then
		reporting_cutover_require_legacy_daily_summary_drained
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		authority_generation="$(
			reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW
		)"
	elif [[ "$target_owner" == 'REPORTING' ]]; then
		reporting_cutover_require_projection_barrier
		authority_generation="$(
			reporting_cutover_schedule_authority_generation REPORTING REPORTING
		)"
	else
		echo "Reporting scheduler claim found an unreconcilable target owner: $target_owner" >&2
		return 1
	fi
	[[ "$authority_generation" =~ ^[0-9]+$ ]] || return 1
	if [[ "$target_owner" == 'CORE_SHADOW' ]]; then
		result="$(reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --tuples-only --no-align --command "
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT owner::TEXT FROM reporting.reporting_settings
WHERE id = 'daily-summary' FOR UPDATE;
UPDATE reporting.reporting_settings
SET owner = 'REPORTING'::reporting.\"ReportingOwner\",
    schedule_authority_generation = $authority_generation,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'daily-summary'
  AND owner = 'CORE_SHADOW'::reporting.\"ReportingOwner\";
SELECT owner::TEXT FROM reporting.reporting_settings WHERE id = 'daily-summary';
COMMIT;
")"
		result="$(printf '%s\n' "$result" | grep -Fx REPORTING | tail -n 1)"
	else
		result='REPORTING'
	fi
	[[ "$result" == 'REPORTING' ]] || {
		echo 'Reporting target did not claim Daily Summary ownership.' >&2
		return 1
	}
	reporting_cutover_schedule_authority_generation REPORTING REPORTING >/dev/null
	reporting_cutover_require_telegram_topic_split REPORTING
	reporting_cutover_rewrite_scheduler_state target-owned
	echo 'Reporting DB now owns Daily Summary while its scheduler remains disabled. Set REPORTING_SCHEDULER_ENABLED=true, redeploy only Reporting, then verify scheduler evidence.'
}

reporting_cutover_validate_scheduler_evidence() {
	local evidence="$1" revision="$2" switch_generation="$3" image
	[[ -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_mode "$evidence")" == '600' &&
		"$(reporting_stat_owner "$evidence")" == '0:0' ]] || return 1
	image="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const keys = Object.keys(value).sort().join("|");
if (keys !== ["version", "revision", "switchGeneration", "periodKey", "reportRunCount", "notificationOutboxCount", "reportRunStatus", "deliveryStatus", "verifiedAt"].sort().join("|") ||
    value.version !== 1 || value.revision !== process.env.EXPECTED_REVISION ||
	value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
	!/^[1-9][0-9]*$/.test(value.switchGeneration) ||
    typeof value.periodKey !== "string" || !value.periodKey ||
    value.reportRunCount !== 1 || value.notificationOutboxCount !== 1 ||
    value.reportRunStatus !== "COMPLETED" || value.deliveryStatus !== "DELIVERED" ||
    !Number.isFinite(Date.parse(value.verifiedAt))) process.exit(1);
' \
		-e "EXPECTED_REVISION=$revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-v "$evidence:/evidence.json:ro" >/dev/null
}

reporting_cutover_verify_scheduler() {
	local step revision evidence sha256 container_id state core_owner
	local system_identifier snapshot_id backfill_sha shadow_sha switch_generation
	reporting_cutover_require_phase shadow-verified
	step="$(reporting_cutover_marker_value scheduler_step)"
	[[ "$step" == 'target-owned' ]] || return 1
	revision="$(reporting_cutover_marker_value revision)"
	[[ "$(reporting_get_env_value REPORTING_SCHEDULER_ENABLED)" == 'true' ]] || {
		echo 'Production env must explicitly enable the Reporting scheduler.' >&2
		return 1
	}
	container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
	[[ "$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')" == 'true' ]] || return 1
	core_owner="$(reporting_core_psql --tuples-only --no-align --command '
SELECT "daily_summary_owner" FROM "reporting_producer_state"
WHERE "id" = '"'"'singleton'"'"';
')"
	[[ "$core_owner" == 'REPORTING' ]] || {
		echo 'Core must remain fenced with daily_summary_owner=REPORTING.' >&2
		return 1
	}
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	reporting_cutover_require_telegram_topic_split REPORTING
	reporting_cutover_schedule_authority_generation REPORTING REPORTING >/dev/null
	state="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM reporting.reporting_settings
    WHERE id = 'daily-summary' AND owner = 'REPORTING'::reporting.\"ReportingOwner\")
  AND EXISTS (SELECT 1 FROM reporting.heartbeats
    WHERE role IN ('all', 'scheduler')
      AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds')
THEN 'ready' ELSE 'unsafe' END;
")"
	[[ "$state" == 'ready' ]] || return 1
	evidence="${REPORTING_SCHEDULER_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_SCHEDULER_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	reporting_cutover_validate_scheduler_evidence "$evidence" "$revision" "$switch_generation"
	reporting_cutover_require_stable_digest scheduler "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_SCHEDULER_VERIFIED:-}" == "scheduler:$revision:$switch_generation:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_SCHEDULER_VERIFIED=scheduler:$revision:$switch_generation:$sha256 after reviewing the single-period delivery evidence." >&2
		return 1
	}
	reporting_cutover_archive_evidence scheduler "$evidence" "$sha256"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	reporting_cutover_write_marker scheduler-switched "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha" "$shadow_sha" target-owned \
		"$sha256" pending pending pending pending "$switch_generation" \
		pending pending pending pending pending
	echo "Reporting scheduler ownership and one-period/one-delivery evidence verified sha256=$sha256."
}

	reporting_cutover_validate_gateway_manifest_value() {
	local value="$1" policy="$2" image
	[[ "$policy" == 'dark' || "$policy" == 'reporting' ]] || return 1
	image="$(reporting_resolve_image_id_for_revision "${REPORTING_REVISION:-}")" || return 1
	printf '%s' "$value" | reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const routes = JSON.parse(readFileSync(0, "utf8"));
const billing = [
  ["billing-payments", "/api/v1/payments"],
  ["billing-subscriptions", "/api/v1/subscriptions"],
  ["billing-tariff-prices", "/api/v1/tariff-prices"],
  ["billing-affiliate", "/api/v1/affiliate"],
].map(([id, pathPrefix]) => ({
  id,
  pathPrefix,
  upstreamUrl: "http://127.0.0.1:4800",
  authPolicy: "optional",
  timeoutMs: 30000,
}));
const widgets = [
  ["widgets-admin", "/api/v1/widgets/admin", "required"],
  ["widgets-management", "/api/v1/widgets", "required"],
  ["quizzes-management", "/api/v1/quizzes", "required"],
  ["callbacks-management", "/api/v1/callbacks", "required"],
  ["countdown-timers-management", "/api/v1/countdown-timers", "required"],
  ["stop-offers-management", "/api/v1/stop-offers", "required"],
  ["online-consultants-management", "/api/v1/online-consultants", "required"],
  ["calculators-management", "/api/v1/calculators", "required"],
  ["widget-settings", "/api/v1/widget-settings", "required"],
  ["widget-runtime", "/api/v1/widget-runtime", "required"],
  ["widget-public", "/api/v1/widget", "optional"],
  ["quiz-public", "/api/v1/quiz", "optional"],
  ["callback-public", "/api/v1/callback", "optional"],
  ["countdown-timer-public", "/api/v1/countdown-timer", "optional"],
  ["stop-offer-public", "/api/v1/stop-offer", "optional"],
  ["online-consultant-public", "/api/v1/online-consultant", "optional"],
  ["calculator-public", "/api/v1/calculator", "optional"],
  ["widget-events", "/api/v1/widget-events", "optional"],
].map(([id, pathPrefix, authPolicy]) => ({
  id,
  pathPrefix,
  upstreamUrl: "http://127.0.0.1:4700",
  authPolicy,
  timeoutMs: 60000,
}));
const includeWidgets = routes.some(
  route => route.upstreamUrl === "http://127.0.0.1:4700",
);
const billingIds = new Set(billing.map(route => route.id));
const billingPrefixes = new Set(billing.map(route => route.pathPrefix));
const includeBilling = routes.some(route =>
  billingIds.has(route.id) ||
  billingPrefixes.has(route.pathPrefix) ||
  route.upstreamUrl === "http://127.0.0.1:4800",
);
const expected = [
  ...(includeBilling ? billing : []),
  {
    id: "database-restores",
    pathPrefix: "/api/v1/dev-tools/database-restores",
    upstreamUrl: "http://127.0.0.1:4200",
    authPolicy: "required",
    timeoutMs: 120000,
  },
  {
    id: "campaigns",
    pathPrefix: "/api/v1/admin/campaigns",
    upstreamUrl: "http://127.0.0.1:4500",
    authPolicy: "required",
    timeoutMs: 60000,
  },
  ...(process.env.EXPECTED_POLICY === "reporting" ? [{
    id: "reporting",
    pathPrefix: "/api/v1/admin/reporting",
    upstreamUrl: "http://127.0.0.1:4600",
    authPolicy: "required",
    timeoutMs: 60000,
  }] : []),
  ...(includeWidgets ? widgets : []),
  {
    id: "monolith",
    pathPrefix: "/api/v1",
    upstreamUrl: "http://127.0.0.1:4200",
    authPolicy: "optional",
    timeoutMs: 60000,
  },
];
if (JSON.stringify(routes) !== JSON.stringify(expected)) process.exit(1);
' \
		-e "EXPECTED_POLICY=$policy" >/dev/null
}

reporting_cutover_require_dark_gateway_runtime() {
	local env_manifest container_id live_manifest
	env_manifest="$(reporting_get_env_value GATEWAY_ROUTES_JSON)"
	reporting_cutover_validate_gateway_manifest_value "$env_manifest" dark || {
		echo 'Pre-route scheduler rollback requires the exact dark Gateway manifest.' >&2
		return 1
	}
	container_id="$(reporting_compose ps --status running -q api-gateway 2>/dev/null || true)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || {
		echo 'Pre-route scheduler rollback requires one running API Gateway.' >&2
		return 1
	}
	live_manifest="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^GATEWAY_ROUTES_JSON=//p')"
	[[ "$live_manifest" == "$env_manifest" ]] || {
		echo 'Live Gateway is not the reviewed dark pre-route target.' >&2
		return 1
	}
}

reporting_cutover_require_forward_scheduler_ready() {
	local container_id scheduler_enabled listen_host health revision image_id image_revision
	local response core_owner target_state
	[[ "$(reporting_get_env_value REPORTING_SCHEDULER_ENABLED)" == 'true' ]] || return 1
	container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
	scheduler_enabled="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')"
	listen_host="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^REPORTING_LISTEN_HOST=//p')"
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
	revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^APP_REVISION=//p')"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	[[ "$scheduler_enabled" == 'true' && "$listen_host" == '127.0.0.1' &&
		"$health" == 'healthy' && "$revision" =~ ^[0-9a-f]{40}$ &&
		"$image_revision" == "$revision" ]] || return 1
	response="$(curl -fsS --connect-timeout 2 --max-time 5 \
		"http://127.0.0.1:4600/health/ready" 2>/dev/null || true)"
	printf '%s' "$response" | grep -Eq \
		"\"revision\"[[:space:]]*:[[:space:]]*\"$revision\"" || return 1
	core_owner="$(reporting_core_psql --tuples-only --no-align --command '
SELECT "daily_summary_owner" FROM "reporting_producer_state"
WHERE "id" = '"'"'singleton'"'"';
')"
	[[ "$core_owner" == 'REPORTING' ]] || return 1
	reporting_cutover_schedule_authority_generation REPORTING REPORTING >/dev/null
	target_state="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM reporting.reporting_settings
    WHERE id = 'daily-summary' AND owner = 'REPORTING'::reporting.\"ReportingOwner\")
  AND EXISTS (SELECT 1 FROM reporting.heartbeats
    WHERE role IN ('all', 'scheduler')
      AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds')
THEN 'ready' ELSE 'unsafe' END;
")"
	[[ "$target_state" == 'ready' ]]
}

reporting_cutover_validate_route_evidence() {
	local evidence="$1" revision="$2" switch_generation="$3" image allowed_origins
	[[ -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_mode "$evidence")" == '600' &&
		"$(reporting_stat_owner "$evidence")" == '0:0' ]] || return 1
	image="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	allowed_origins="$(reporting_get_env_value CORS_ALLOWED_ORIGINS)"
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) && Object.keys(object).sort().join("|") === [...keys].sort().join("|");
const checks = [
  "gatewayRoute", "frontendReportingApi", "adminDashboard", "adminOverview",
  "adminRegistrations", "dailySummarySettings", "legacyStatisticsTombstoned",
  "allowedCors", "deniedCors",
  "databaseRestoreSettings", "databaseRestoreUnauthenticatedRejected",
  "logoutRejected", "blockedUserRejected", "revokedSessionRejected",
  "roleChangeRejected", "jwtKeyRotationAccepted", "introspectionFailClosed",
  "forgedForwardedHeadersRejected", "correlationIdPreserved",
];
let origin;
try { origin = new URL(value.origin); } catch { process.exit(1); }
const allowed = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()));
if (!exact(value, [
      "version", "backendRevision", "frontendRevision", "switchGeneration",
      "origin", "frontendRuntimeAttestationSha256",
      "frontendRuntimeSignatureSha256", "frontendRuntimePublicKeySha256",
      "frontendRuntimeChallenge", "verifiedAt", "checks",
    ]) ||
    value.version !== 1 || value.backendRevision !== process.env.EXPECTED_REVISION ||
    !/^[0-9a-f]{40}$/.test(value.frontendRevision) ||
	value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
	!/^[1-9][0-9]*$/.test(value.switchGeneration) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimeAttestationSha256) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimeSignatureSha256) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimePublicKeySha256) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimeChallenge) ||
    origin.origin !== value.origin || origin.username || origin.password ||
    !allowed.has(value.origin) || !Number.isFinite(Date.parse(value.verifiedAt)) ||
    !exact(value.checks, checks) || checks.some(key => value.checks[key] !== true)) process.exit(1);
' \
		-e "EXPECTED_REVISION=$revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-e "ALLOWED_ORIGINS=$allowed_origins" \
		-v "$evidence:/evidence.json:ro" >/dev/null
}

reporting_cutover_route_evidence_identity() {
	local evidence="$1" revision="$2" image
	image="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
if (!/^[0-9a-f]{40}$/.test(value.frontendRevision) ||
    typeof value.origin !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimeAttestationSha256) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimeSignatureSha256) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimePublicKeySha256) ||
    !/^[0-9a-f]{64}$/.test(value.frontendRuntimeChallenge)) process.exit(1);
process.stdout.write([
  value.frontendRevision,
  new URL(value.origin).origin,
  value.frontendRuntimeAttestationSha256,
  value.frontendRuntimeSignatureSha256,
  value.frontendRuntimePublicKeySha256,
  value.frontendRuntimeChallenge,
].join("|"));
' -v "$evidence:/evidence.json:ro"
}

reporting_cutover_validate_frontend_runtime_attestation() (
	set -Eeuo pipefail
	[[ $# == 11 ]] || return 1
	local attestation="$1" signature="$2" public_key="$3"
	local backend_revision="$4" frontend_revision="$5" origin="$6"
	local switch_generation="$7" challenge="$8"
	local expected_attestation_sha="$9" expected_signature_sha="${10}"
	local expected_public_key_sha="${11}" image value size key_text
	local attestation_sha signature_sha public_key_sha asset_path asset_sha asset_tmp
	for value in "$attestation" "$signature" "$public_key"; do
		[[ "$value" == /* && -f "$value" && ! -L "$value" &&
			"$(reporting_stat_mode "$value")" == '600' &&
			"$(reporting_stat_owner "$value")" == '0:0' ]] || {
			echo 'Cross-VPS frontend runtime attestation, signature and public key must be absolute root-owned mode-600 regular files.' >&2
			return 1
		}
	done
	for value in "$attestation" "$signature" "$public_key"; do
		size="$(wc -c <"$value" | tr -d '[:space:]')" || return 1
		[[ "$size" =~ ^[0-9]+$ && "$size" -ge 32 && "$size" -le 16384 ]] || {
			echo 'Cross-VPS frontend runtime attestation artifact has an unsafe size.' >&2
			return 1
		}
	done
	attestation_sha="$(reporting_sha256_file "$attestation")" || return 1
	signature_sha="$(reporting_sha256_file "$signature")" || return 1
	public_key_sha="$(reporting_sha256_file "$public_key")" || return 1
	[[ "$public_key_sha" == "$expected_public_key_sha" &&
		( -z "$expected_attestation_sha" || "$attestation_sha" == "$expected_attestation_sha" ) &&
		( -z "$expected_signature_sha" || "$signature_sha" == "$expected_signature_sha" ) ]] || {
		echo 'Cross-VPS frontend runtime attestation artifacts differ from the route evidence.' >&2
		return 1
	}
	key_text="$(openssl pkey -pubin -in "$public_key" -text -noout 2>/dev/null)" || return 1
	[[ "$key_text" == ED25519\ Public-Key:* ]] || {
		echo 'Cross-VPS frontend runtime attestation key must be Ed25519.' >&2
		return 1
	}
	openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
		-in "$attestation" -sigfile "$signature" >/dev/null 2>&1 || {
		echo 'Cross-VPS frontend runtime attestation signature is invalid.' >&2
		return 1
	}
	image="$(reporting_resolve_image_id_for_revision \
		"$backend_revision" "winwidget-reporting:git-$backend_revision")" || return 1
	value="$(reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/attestation.json", "utf8"));
const keys = [
  "version", "backendRevision", "frontendRevision", "switchGeneration",
  "origin", "challenge", "composeProject", "composeService", "containerId",
  "imageId", "appRevision", "imageRevision", "status", "health",
  "restarting", "restartCount", "contractScan", "legacyContractAbsent",
  "localHttp", "publicHttp", "assetPath", "assetSha256", "verifiedAt",
];
const verifiedAt = Date.parse(value.verifiedAt);
const ageMs = Date.now() - verifiedAt;
if (Object.keys(value).sort().join("|") !== keys.sort().join("|") ||
    value.version !== 1 ||
    value.backendRevision !== process.env.EXPECTED_BACKEND_REVISION ||
    value.frontendRevision !== process.env.EXPECTED_FRONTEND_REVISION ||
    value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
    value.origin !== process.env.EXPECTED_ORIGIN ||
    value.challenge !== process.env.EXPECTED_CHALLENGE ||
    value.composeProject !== "winwidget" || value.composeService !== "client" ||
    !/^[0-9a-f]{64}$/.test(value.containerId) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.imageId) ||
    value.appRevision !== value.frontendRevision ||
    value.imageRevision !== value.frontendRevision ||
    value.status !== "running" ||
    !["healthy", "not-configured"].includes(value.health) ||
    value.restarting !== false || value.restartCount !== 0 ||
    value.contractScan !== true || value.legacyContractAbsent !== true ||
    value.localHttp !== true || value.publicHttp !== true ||
    typeof value.assetPath !== "string" ||
    !/^\/_next\/static\/[A-Za-z0-9._/-]+$/.test(value.assetPath) ||
    value.assetPath.split("/").includes("..") ||
    !/^[0-9a-f]{64}$/.test(value.assetSha256) ||
    !Number.isFinite(verifiedAt) || ageMs < -120000 ||
    ageMs > Number(process.env.MAX_AGE_SECONDS) * 1000) process.exit(1);
process.stdout.write(`${value.assetPath}|${value.assetSha256}`);
' \
		-e "EXPECTED_BACKEND_REVISION=$backend_revision" \
		-e "EXPECTED_FRONTEND_REVISION=$frontend_revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-e "EXPECTED_ORIGIN=$origin" \
		-e "EXPECTED_CHALLENGE=$challenge" \
		-e "MAX_AGE_SECONDS=$REPORTING_FRONTEND_RUNTIME_ATTESTATION_MAX_AGE_SECONDS" \
		-v "$attestation:/attestation.json:ro")" || {
		echo 'Cross-VPS frontend runtime attestation is stale or does not match the live cutover identity.' >&2
		return 1
	}
	IFS='|' read -r asset_path asset_sha <<<"$value"
	[[ "$asset_path" =~ ^/_next/static/[A-Za-z0-9._/-]+$ &&
		"$asset_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	asset_tmp="$(mktemp "${TMPDIR:-/tmp}/winwidget-reporting-frontend-asset.XXXXXX")" || return 1
	trap 'rm -f -- "$asset_tmp"' EXIT
	curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 5 --max-time 20 \
		"$origin$asset_path" -o "$asset_tmp" || {
		echo 'Signed frontend runtime asset is not reachable through the reviewed public origin.' >&2
		return 1
	}
	[[ "$(reporting_sha256_file "$asset_tmp")" == "$asset_sha" ]] || {
		echo 'Public frontend asset does not match the signed frontend runtime image.' >&2
		return 1
	}
	reporting_cutover_require_stable_digest frontend-runtime "$attestation" "$attestation_sha"
	reporting_cutover_require_stable_digest frontend-runtime-signature "$signature" "$signature_sha"
	reporting_cutover_require_stable_digest frontend-runtime-public-key "$public_key" "$public_key_sha"
)

reporting_cutover_route_evidence_verified_at() {
	local revision route_sha evidence image
	revision="$(reporting_cutover_marker_value revision)" || return 1
	route_sha="$(reporting_cutover_marker_value route_evidence_sha256)" || return 1
	reporting_cutover_require_archived_evidence routes "$route_sha" || return 1
	evidence="$(reporting_cutover_evidence_path routes "$route_sha")" || return 1
	image="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
if (!Number.isFinite(Date.parse(value.verifiedAt))) process.exit(1);
process.stdout.write(value.verifiedAt);
' -v "$evidence:/evidence.json:ro"
}

reporting_cutover_require_live_frontend_runtime() {
	local evidence="$1" backend_revision="$2" pin_digests="${3:-false}"
	local identity frontend_revision origin attestation_sha signature_sha
	local public_key_sha challenge switch_generation expected_attestation_sha
	local expected_signature_sha
	identity="$(reporting_cutover_route_evidence_identity \
		"$evidence" "$backend_revision")" || return 1
	IFS='|' read -r frontend_revision origin attestation_sha signature_sha \
		public_key_sha challenge <<<"$identity"
	[[ "$frontend_revision" =~ ^[0-9a-f]{40}$ &&
		"$origin" =~ ^https://[^/]+$ &&
		"$attestation_sha" =~ ^[0-9a-f]{64}$ &&
		"$signature_sha" =~ ^[0-9a-f]{64}$ &&
		"$public_key_sha" =~ ^[0-9a-f]{64}$ &&
		"$challenge" =~ ^[0-9a-f]{64}$ ]] || return 1
	[[ "$pin_digests" == 'true' || "$pin_digests" == 'false' ]] || return 1
	switch_generation="$(reporting_cutover_marker_value switch_generation)" || return 1
	expected_attestation_sha=''
	expected_signature_sha=''
	if [[ "$pin_digests" == 'true' ]]; then
		expected_attestation_sha="$attestation_sha"
		expected_signature_sha="$signature_sha"
	fi
	reporting_cutover_validate_frontend_runtime_attestation \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY" \
		"$backend_revision" "$frontend_revision" "$origin" \
		"$switch_generation" "$challenge" "$expected_attestation_sha" \
		"$expected_signature_sha" "$public_key_sha" || return 1
	curl -fsS --connect-timeout 5 --max-time 15 "$origin/" >/dev/null || {
		echo 'Reviewed public frontend origin is not reachable from the cutover host.' >&2
		return 1
	}
}

reporting_cutover_require_live_legacy_routes() {
	local runtime_revision="$1" policy="$2" token_file image_id public_origin token_size
	[[ "$policy" == 'retained' || "$policy" == 'absent' ]] || return 1
	token_file="${REPORTING_CUTOVER_ADMIN_ACCESS_TOKEN_FILE:-$APP_ROOT/deploy/backend/.reporting-cutover-admin-access-token}"
	[[ "$token_file" == /* && -f "$token_file" && ! -L "$token_file" &&
		"$(reporting_stat_owner "$token_file")" == '0:0' &&
		"$(reporting_stat_mode "$token_file")" == '600' ]] || {
		echo 'REPORTING_CUTOVER_ADMIN_ACCESS_TOKEN_FILE must be an absolute root-owned mode-600 regular file.' >&2
		return 1
	}
	token_size="$(wc -c <"$token_file" | tr -d '[:space:]')" || return 1
	[[ "$token_size" =~ ^[0-9]+$ && "$token_size" -ge 64 && "$token_size" -le 16385 ]] || {
		echo 'Reporting cutover admin token file has an unsafe size.' >&2
		return 1
	}
	public_origin="$(reporting_get_env_value PRODUCTION_HOST)"
	[[ "$public_origin" =~ ^https://[^/:]+$ ]] || {
		echo 'PRODUCTION_HOST must be one canonical HTTPS origin for the live route smoke.' >&2
		return 1
	}
	image_id="$(reporting_resolve_image_id_for_revision \
		"$runtime_revision" "winwidget-reporting:git-$runtime_revision")" || return 1
	docker run --rm --network host --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		-e "EXPECTED_PUBLIC_API_ORIGIN=$public_origin" \
		-e "EXPECTED_LEGACY_POLICY=$policy" \
		-v "$token_file:/run/secrets/reporting-cutover-admin-token:ro" \
		--entrypoint node "$image_id" -e '
const { readFileSync } = require("node:fs");
const token = readFileSync("/run/secrets/reporting-cutover-admin-token", "utf8").trim();
if (!/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/.test(token) || token.length > 16384) {
  process.exit(1);
}
const origins = ["http://127.0.0.1:4100", process.env.EXPECTED_PUBLIC_API_ORIGIN];
const current = "/api/v1/admin/reporting/overview";
const legacy = [
  "/api/v1/statistics/dashboard",
  "/api/v1/statistics/overview",
  "/api/v1/statistics/registrations-by-month",
];
const request = async (origin, path) => fetch(`${origin}${path}`, {
  headers: { Authorization: `Bearer ${token}` },
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
const parseJson = async response => {
  try { return await response.json(); } catch { process.exit(1); }
};
(async () => {
  if (!["retained", "absent"].includes(process.env.EXPECTED_LEGACY_POLICY)) {
    process.exit(1);
  }
	for (const origin of origins) {
		if (process.env.EXPECTED_LEGACY_POLICY === "retained") {
			const currentResponse = await request(origin, current);
			if (currentResponse.status !== 200) process.exit(1);
		}
    for (const path of legacy) {
      const response = await request(origin, path);
      if (process.env.EXPECTED_LEGACY_POLICY === "absent") {
        if (response.status !== 404 || (await parseJson(response)).code !== "route_not_found") {
          process.exit(1);
        }
        continue;
      }
      if (response.status !== 200) process.exit(1);
      const value = await parseJson(response);
      if (path.endsWith("/dashboard") &&
          (!value || typeof value !== "object" || typeof value.generatedAt !== "string")) {
        process.exit(1);
      }
      if (path.endsWith("/overview") &&
          (!value || typeof value !== "object" || Array.isArray(value))) {
        process.exit(1);
      }
      if (path.endsWith("/registrations-by-month") && !Array.isArray(value)) {
        process.exit(1);
      }
    }
  }
})().catch(() => { process.exitCode = 1; });
' >/dev/null || {
		echo "Authenticated live smoke did not prove the $policy legacy statistics route policy." >&2
		return 1
	}
}

reporting_cutover_require_live_legacy_routes_retained() {
	reporting_cutover_require_live_legacy_routes "$1" retained
}

reporting_cutover_require_live_legacy_routes_absent() {
	reporting_cutover_require_live_legacy_routes "$1" absent
}

reporting_cutover_archive_frontend_runtime_attestation() {
	local evidence="$1" backend_revision="$2" identity frontend_revision origin
	local attestation_sha signature_sha public_key_sha challenge
	identity="$(reporting_cutover_route_evidence_identity \
		"$evidence" "$backend_revision")" || return 1
	IFS='|' read -r frontend_revision origin attestation_sha signature_sha \
		public_key_sha challenge <<<"$identity"
	[[ "$(reporting_sha256_file "$REPORTING_FRONTEND_RUNTIME_ATTESTATION")" == "$attestation_sha" &&
		"$(reporting_sha256_file "$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE")" == "$signature_sha" &&
		"$(reporting_sha256_file "$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY")" == "$public_key_sha" ]] || {
		echo 'Frontend runtime attestation changed before archival.' >&2
		return 1
	}
	reporting_cutover_archive_evidence frontend-runtime-attestation \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION" "$attestation_sha"
	reporting_cutover_archive_evidence frontend-runtime-signature \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE" "$signature_sha"
	reporting_cutover_archive_evidence frontend-runtime-public-key \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY" "$public_key_sha"
}

reporting_cutover_require_archived_frontend_runtime_attestation() {
	local evidence="$1" backend_revision="$2" identity frontend_revision origin
	local attestation_sha signature_sha public_key_sha challenge
	identity="$(reporting_cutover_route_evidence_identity \
		"$evidence" "$backend_revision")" || return 1
	IFS='|' read -r frontend_revision origin attestation_sha signature_sha \
		public_key_sha challenge <<<"$identity"
	reporting_cutover_require_archived_evidence \
		frontend-runtime-attestation "$attestation_sha"
	reporting_cutover_require_archived_evidence \
		frontend-runtime-signature "$signature_sha"
	reporting_cutover_require_archived_evidence \
		frontend-runtime-public-key "$public_key_sha"
}

reporting_cutover_require_archived_route_runtime() {
	local evidence_revision="$1" runtime_revision="$2" route_sha route_evidence
	route_sha="$(reporting_cutover_marker_value route_evidence_sha256)" || return 1
	reporting_cutover_require_archived_evidence routes "$route_sha" || return 1
	route_evidence="$(reporting_cutover_evidence_path routes "$route_sha")" || return 1
	reporting_cutover_require_archived_frontend_runtime_attestation \
		"$route_evidence" "$evidence_revision" || return 1
	reporting_cutover_require_live_frontend_runtime "$route_evidence" "$evidence_revision"
	reporting_cutover_require_live_legacy_routes_absent "$runtime_revision"
}

reporting_cutover_verify_routes() {
	local revision env_manifest container_id live_manifest evidence sha256
	local system_identifier snapshot_id backfill_sha256 shadow_sha scheduler_sha
	local switch_generation
	reporting_cutover_require_phase scheduler-switched
	revision="$(reporting_cutover_marker_value revision)"
	env_manifest="$(reporting_get_env_value GATEWAY_ROUTES_JSON)"
	reporting_cutover_validate_gateway_manifest_value "$env_manifest" reporting || {
		echo 'Production Gateway manifest is not the exact Reporting cutover manifest.' >&2
		return 1
	}
	container_id="$(reporting_compose ps --status running -q api-gateway 2>/dev/null || true)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
	live_manifest="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^GATEWAY_ROUTES_JSON=//p')"
	[[ "$live_manifest" == "$env_manifest" ]] || {
		echo 'Live Gateway manifest differs byte-for-byte from production env.' >&2
		return 1
	}
	reporting_cutover_require_forward_scheduler_ready || {
		echo 'Reporting scheduler/runtime ownership is not safe for public routing.' >&2
		return 1
	}
	reporting_cutover_require_projection_barrier || {
		echo 'Reporting projection barrier is not clear for public routing.' >&2
		return 1
	}
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	evidence="${REPORTING_ROUTE_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_ROUTE_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	reporting_cutover_validate_route_evidence "$evidence" "$revision" "$switch_generation"
	reporting_cutover_require_live_frontend_runtime "$evidence" "$revision" true
	reporting_cutover_require_live_legacy_routes_absent "$revision"
	reporting_cutover_require_stable_digest routes "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_ROUTES_VERIFIED:-}" == "routes:$revision:$switch_generation:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_ROUTES_VERIFIED=routes:$revision:$switch_generation:$sha256 after reviewing frontend/auth/CORS smoke." >&2
		return 1
	}
	reporting_cutover_archive_frontend_runtime_attestation \
		"$evidence" "$revision"
	reporting_cutover_archive_evidence routes "$evidence" "$sha256"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha256="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	scheduler_sha="$(reporting_cutover_marker_value scheduler_evidence_sha256)"
	reporting_cutover_write_marker routes-switched "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha256" "$shadow_sha" target-owned \
		"$scheduler_sha" "$sha256" pending pending pending "$switch_generation" \
		pending pending pending pending pending
	echo "Reporting Gateway/frontend/auth route evidence verified sha256=$sha256."
}

reporting_cutover_validate_restore_evidence() {
	local evidence="$1" revision="$2" system_identifier="$3" switch_generation="$4" image
	[[ -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_mode "$evidence")" == '600' &&
		"$(reporting_stat_owner "$evidence")" == '0:0' ]] || return 1
	image="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) && Object.keys(object).sort().join("|") === [...keys].sort().join("|");
const checks = ["isolatedTarget", "migrations", "tables", "sequences", "rows", "invariants", "runtimeCrud", "backupRedump"];
if (!exact(value, ["version", "revision", "databaseSystemIdentifier", "switchGeneration", "dumpSha256", "externalReceipt", "restoredAt", "checks"]) ||
    value.version !== 1 || value.revision !== process.env.EXPECTED_REVISION ||
    String(value.databaseSystemIdentifier) !== process.env.EXPECTED_SYSTEM_IDENTIFIER ||
	value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
	!/^[1-9][0-9]*$/.test(value.switchGeneration) ||
    !/^[0-9a-f]{64}$/.test(value.dumpSha256) ||
    typeof value.externalReceipt !== "string" || !value.externalReceipt.trim() ||
    value.externalReceipt.length > 512 || /[\u0000-\u001f\u007f]/.test(value.externalReceipt) ||
    !Number.isFinite(Date.parse(value.restoredAt)) || !exact(value.checks, checks) ||
    checks.some(key => value.checks[key] !== true)) process.exit(1);
' \
		-e "EXPECTED_REVISION=$revision" \
		-e "EXPECTED_SYSTEM_IDENTIFIER=$system_identifier" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-v "$evidence:/evidence.json:ro" >/dev/null
}

reporting_cutover_verify_restore() {
	local revision system_identifier evidence sha256 phase snapshot_id backfill_sha
	local shadow_sha scheduler_sha route_sha switch_generation
	reporting_cutover_require_phase routes-switched
	[[ "$(reporting_cutover_marker_value restore_evidence_sha256)" == 'pending' ]] || {
		echo 'Reporting restore evidence is already fixed in the marker.' >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	evidence="${REPORTING_RESTORE_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_RESTORE_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	reporting_cutover_validate_restore_evidence \
		"$evidence" "$revision" "$system_identifier" "$switch_generation"
	reporting_cutover_require_stable_digest restore "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_RESTORE_VERIFIED:-}" == "restore:$revision:$switch_generation:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_RESTORE_VERIFIED=restore:$revision:$switch_generation:$sha256 after reviewing the isolated real-dump restore." >&2
		return 1
	}
	reporting_cutover_archive_evidence restore "$evidence" "$sha256"
	phase="$(reporting_cutover_marker_value phase)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	scheduler_sha="$(reporting_cutover_marker_value scheduler_evidence_sha256)"
	route_sha="$(reporting_cutover_marker_value route_evidence_sha256)"
	reporting_cutover_write_marker "$phase" "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha" "$shadow_sha" target-owned \
		"$scheduler_sha" "$route_sha" "$sha256" pending pending \
		"$switch_generation" pending pending pending pending pending
	echo "Reporting real backup restore evidence fixed in marker sha256=$sha256."
}

reporting_cutover_core_content_manifest_sql() {
	cat <<'SQL'
WITH params AS (
  SELECT :'backup_job_id'::TEXT AS backup_job_id
)
SELECT format(
  $statement$
SELECT %L || '|' || count(*)::TEXT || '|' ||
  md5(COALESCE(
    string_agg(
      md5(to_jsonb(source_row)::TEXT),
      '' ORDER BY to_jsonb(source_row)::TEXT COLLATE "C"
    ),
    ''
  ))
FROM %I.%I AS source_row %s;
$statement$,
  schemaname || '.' || tablename,
  schemaname,
  tablename,
  CASE tablename
    WHEN 'scheduled_job_runs' THEN format(
      $filter$WHERE NOT (
  source_row.id = %L::UUID
  AND source_row.job_type = 'DATABASE_BACKUP'
)$filter$,
      params.backup_job_id
    )
    WHEN 'outbox_events' THEN format(
      $filter$WHERE NOT (
  source_row.message_id = %L::UUID
  AND source_row.event_type = 'database.backup.requested.v1'
  AND source_row.routing_key IN (
    'database.backup.requested.v1',
    'manual.database-backup',
    'database-backup.dead-letter'
  )
  AND source_row.payload ->> 'schemaVersion' = '1'
  AND source_row.payload ->> 'eventType' = 'database.backup.requested.v1'
  AND source_row.payload ->> 'jobId' = %L
  AND source_row.payload ->> 'jobType' = 'DATABASE_BACKUP'
)$filter$,
      params.backup_job_id,
      params.backup_job_id
    )
    WHEN 'admin_event_logs' THEN format(
      $filter$WHERE NOT (
  (
    source_row.section = 'TELEGRAM_BOT'
    AND source_row.action = 'TELEGRAM_DATABASE_BACKUP_CREATE'
    AND source_row.entity_type = 'scheduled_job'
    AND source_row.entity_id = %L
    AND source_row.metadata ->> 'target' = 'core'
    AND source_row.metadata ->> 'jobId' = %L
  )
  OR (
    source_row.section = 'MESSAGING'
    AND source_row.action = 'MESSAGING_FAILURE_RETRY'
    AND source_row.entity_type = 'integration_delivery_failure'
    AND source_row.metadata ->> 'eventId' = %L
    AND source_row.metadata ->> 'integration' = 'database-backup'
  )
)$filter$,
      params.backup_job_id,
      params.backup_job_id,
      params.backup_job_id
    )
    WHEN 'integration_delivery_failures' THEN format(
      $filter$WHERE NOT (
  source_row.event_id = %L::UUID
  AND source_row.integration = 'database-backup'
  AND source_row.routing_key = 'database.backup.requested.v1'
  AND source_row.payload ->> 'schemaVersion' = '1'
  AND source_row.payload ->> 'eventType' = 'database.backup.requested.v1'
  AND source_row.payload ->> 'jobId' = %L
  AND source_row.payload ->> 'jobType' = 'DATABASE_BACKUP'
)$filter$,
      params.backup_job_id,
      params.backup_job_id
    )
    ELSE ''
  END
)
FROM pg_tables
CROSS JOIN params
WHERE schemaname = 'public'
  AND tablename <> 'messaging_heartbeats'
ORDER BY tablename::TEXT COLLATE "C"
\gexec
SQL
}

reporting_cutover_core_migration_manifest_sql() {
	cat <<'SQL'
SELECT migration_name, checksum
FROM public._prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name COLLATE "C";
SQL
}

reporting_cutover_core_schema_manifest_sql() {
	cat <<'SQL'
SELECT table_name, column_name, ordinal_position::TEXT, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name COLLATE "C", ordinal_position;
SQL
}

reporting_cutover_core_row_anchor_manifest_sql() {
	cat <<'SQL'
SELECT
  (SELECT count(*) FROM "User"),
  (SELECT count(*) FROM widgets),
  (SELECT count(*) FROM leads),
  (SELECT count(*) FROM telegram_bot_settings),
  (SELECT count(*) FROM reporting_producer_state),
  (SELECT count(*) FROM reporting_projection_versions),
  (SELECT count(*) FROM outbox_events AS source_row
    WHERE NOT (
      source_row.message_id = :'backup_job_id'::UUID
      AND source_row.event_type = 'database.backup.requested.v1'
      AND source_row.routing_key IN (
        'database.backup.requested.v1',
        'manual.database-backup',
        'database-backup.dead-letter'
      )
      AND source_row.payload ->> 'schemaVersion' = '1'
      AND source_row.payload ->> 'eventType' = 'database.backup.requested.v1'
      AND source_row.payload ->> 'jobId' = :'backup_job_id'
      AND source_row.payload ->> 'jobType' = 'DATABASE_BACKUP'
    )),
  (SELECT count(*) FROM scheduled_job_runs AS source_row
    WHERE NOT (
      source_row.id = :'backup_job_id'::UUID
      AND source_row.job_type = 'DATABASE_BACKUP'
    ));
SQL
}

reporting_cutover_core_sequence_manifest_sql() {
	cat <<'SQL'
SELECT schemaname, sequencename, COALESCE(last_value::TEXT, 'null')
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY sequencename COLLATE "C";
SQL
}

reporting_cutover_core_backup_job_json() {
	[[ $# == 1 && "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
	local job_id="$1"
	reporting_core_psql_for DATABASE_BACKUP_URL --tuples-only --no-align --command "
SELECT json_build_object(
  'jobId', id::TEXT,
  'jobType', job_type,
  'trigger', trigger::TEXT,
  'status', status::TEXT,
  'finishedAt', to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
  'result', result
)::TEXT
FROM scheduled_job_runs
WHERE id = '$job_id'::UUID;
"
}

reporting_cutover_core_backup_job_summary() {
	[[ $# == 4 ]] || return 1
	local job_json="$1" job_id="$2" route_boundary="$3" expected_database="$4"
	local revision image_id
	revision="$(reporting_cutover_marker_value revision)" || return 1
	image_id="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	printf '%s\n' "$job_json" | reporting_run_isolated_node_validator "$image_id" '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const exact = (value, keys) => value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const value = JSON.parse(readFileSync(0, "utf8"));
const resultKeys = [
  "target", "databaseName", "schema", "fileName", "fileSize",
  "fileSha256", "createdAt", "telegramSent", "telegramReceipt",
];
const receiptKeys = ["messageId", "chatId", "messageThreadId", "fileId", "fileUniqueId"];
const finishedAt = Date.parse(value.finishedAt);
const createdAt = Date.parse(value.result?.createdAt);
const routeBoundary = Date.parse(process.env.EXPECTED_ROUTE_BOUNDARY || "");
if (!exact(value, ["jobId", "jobType", "trigger", "status", "finishedAt", "result"]) ||
    value.jobId !== process.env.EXPECTED_JOB_ID || value.jobType !== "DATABASE_BACKUP" ||
    value.trigger !== "MANUAL" || value.status !== "SUCCEEDED" ||
    !exact(value.result, resultKeys) || value.result.target !== "core" ||
    value.result.databaseName !== process.env.EXPECTED_DATABASE ||
    value.result.schema !== "public" || value.result.telegramSent !== true ||
    !/^winwidget-db-[0-9TZ-]+[.]dump$/.test(value.result.fileName) ||
    !Number.isSafeInteger(value.result.fileSize) || value.result.fileSize < 1 ||
    value.result.fileSize > 51380224 || !/^[0-9a-f]{64}$/.test(value.result.fileSha256) ||
    !exact(value.result.telegramReceipt, receiptKeys) ||
    !Number.isSafeInteger(value.result.telegramReceipt.messageId) ||
    value.result.telegramReceipt.messageId < 1 ||
    typeof value.result.telegramReceipt.chatId !== "string" ||
    !value.result.telegramReceipt.chatId || value.result.telegramReceipt.chatId.length > 255 ||
    !Number.isSafeInteger(value.result.telegramReceipt.messageThreadId) ||
    value.result.telegramReceipt.messageThreadId < 1 ||
    typeof value.result.telegramReceipt.fileId !== "string" ||
    !value.result.telegramReceipt.fileId || value.result.telegramReceipt.fileId.length > 512 ||
    typeof value.result.telegramReceipt.fileUniqueId !== "string" ||
    !value.result.telegramReceipt.fileUniqueId ||
    value.result.telegramReceipt.fileUniqueId.length > 512 ||
    !Number.isFinite(finishedAt) || !Number.isFinite(createdAt) ||
    !Number.isFinite(routeBoundary) || createdAt < routeBoundary ||
    finishedAt < routeBoundary ||
    createdAt > finishedAt || Date.now() - finishedAt < 0 ||
    Date.now() - finishedAt > Number(process.env.MAX_AGE_SECONDS) * 1000) process.exit(1);
const receiptSha = createHash("sha256")
  .update(JSON.stringify(value.result.telegramReceipt)).digest("hex");
process.stdout.write([
  value.result.fileName,
  String(value.result.fileSize),
  value.result.fileSha256,
  value.result.createdAt,
  value.finishedAt,
  receiptSha,
].join("|") + "\n");
' \
		-e "EXPECTED_JOB_ID=$job_id" \
		-e "EXPECTED_ROUTE_BOUNDARY=$route_boundary" \
		-e "EXPECTED_DATABASE=$expected_database" \
		-e "MAX_AGE_SECONDS=$REPORTING_CORE_CLEANUP_BACKUP_MAX_AGE_SECONDS"
}

reporting_cutover_validate_core_cleanup_backup_evidence() {
	[[ $# == 1 ]] || return 1
	local evidence="$1" revision switch_generation route_boundary job_id
	local source_system_identifier restore_image_id expected_database job_json summary
	local file_name file_size dump_sha backup_created_at job_finished_at receipt_sha
	[[ "$evidence" == /* && -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_owner "$evidence")" == '0:0' &&
		"$(reporting_stat_mode "$evidence")" == '600' &&
		-f "$REPORTING_CORE_CLEANUP_BACKUP_DUMP" &&
		! -L "$REPORTING_CORE_CLEANUP_BACKUP_DUMP" &&
		"$(reporting_stat_owner "$REPORTING_CORE_CLEANUP_BACKUP_DUMP")" == '0:0' &&
		"$(reporting_stat_mode "$REPORTING_CORE_CLEANUP_BACKUP_DUMP")" == '600' ]] || {
		echo 'Core cleanup backup evidence and dump must be absolute root-owned mode-600 regular files.' >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)" || return 1
	switch_generation="$(reporting_cutover_marker_value switch_generation)" || return 1
	route_boundary="$(reporting_cutover_route_evidence_verified_at)" || return 1
	source_system_identifier="$(reporting_core_migration_psql --tuples-only --no-align --command \
		'SELECT system_identifier::TEXT FROM pg_control_system();')" || return 1
	restore_image_id="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-database-restore:git-$revision")" || return 1
	expected_database="$(printf '%s\n' "$(reporting_get_env_value DATABASE_BACKUP_URL)" | \
		reporting_run_isolated_node_validator \
			"$(reporting_resolve_image_id_for_revision \
				"$revision" "winwidget-reporting:git-$revision")" '
const { readFileSync } = require("node:fs");
const value = new URL(readFileSync(0, "utf8").trim());
if (!value.pathname || value.pathname === "/") process.exit(1);
process.stdout.write(decodeURIComponent(value.pathname.slice(1)));
')" || return 1
	job_id="$(reporting_run_isolated_node_validator \
		"$(reporting_resolve_image_id_for_revision \
			"$revision" "winwidget-reporting:git-$revision")" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
if (!value || typeof value !== "object" || Array.isArray(value) ||
    !/^[0-9a-f-]{36}$/.test(String(value.jobId || ""))) process.exit(1);
process.stdout.write(value.jobId);
' -v "$evidence:/evidence.json:ro")" || return 1
	job_json="$(reporting_cutover_core_backup_job_json "$job_id")" || return 1
	[[ -n "$job_json" && "$job_json" != *$'\n'* ]] || return 1
	summary="$(reporting_cutover_core_backup_job_summary \
		"$job_json" "$job_id" "$route_boundary" "$expected_database")" || return 1
	IFS='|' read -r file_name file_size dump_sha backup_created_at \
		job_finished_at receipt_sha <<<"$summary"
	[[ "$file_size" == "$(wc -c <"$REPORTING_CORE_CLEANUP_BACKUP_DUMP" | tr -d '[:space:]')" &&
		"$dump_sha" == "$(reporting_sha256_file "$REPORTING_CORE_CLEANUP_BACKUP_DUMP")" ]] || {
		echo 'Core cleanup dump bytes do not match the durable backup job result.' >&2
		return 1
	}
	reporting_run_isolated_node_validator \
		"$(reporting_resolve_image_id_for_revision \
			"$revision" "winwidget-reporting:git-$revision")" '
const { readFileSync } = require("node:fs");
const exact = (value, keys) => value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const keys = [
  "version", "jobId", "revision", "switchGeneration",
  "sourceDatabaseSystemIdentifier", "dumpFileName", "dumpFileSize",
  "dumpSha256", "telegramReceiptSha256", "backupCreatedAt", "jobFinishedAt",
  "restoreImageId", "postgresImage", "restoredAt", "verifiedAt",
  "migrationManifestSha256", "schemaManifestSha256", "rowAnchorManifestSha256",
  "rowContentManifestSha256", "sequenceManifestSha256", "redumpSha256", "checks",
];
const checkKeys = [
  "job", "offVpsArtifact", "archive", "isolatedTarget", "migrations",
  "schema", "rows", "rowContent", "sequences", "invariants", "redump",
];
const restoredAt = Date.parse(value.restoredAt);
const verifiedAt = Date.parse(value.verifiedAt);
const finishedAt = Date.parse(value.jobFinishedAt);
if (!exact(value, keys) || value.version !== 1 ||
    value.jobId !== process.env.EXPECTED_JOB_ID ||
    value.revision !== process.env.EXPECTED_REVISION ||
    value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
    String(value.sourceDatabaseSystemIdentifier) !== process.env.EXPECTED_SYSTEM_ID ||
    value.dumpFileName !== process.env.EXPECTED_FILE_NAME ||
    String(value.dumpFileSize) !== process.env.EXPECTED_FILE_SIZE ||
    value.dumpSha256 !== process.env.EXPECTED_DUMP_SHA ||
    value.telegramReceiptSha256 !== process.env.EXPECTED_RECEIPT_SHA ||
    value.backupCreatedAt !== process.env.EXPECTED_BACKUP_CREATED_AT ||
    value.jobFinishedAt !== process.env.EXPECTED_JOB_FINISHED_AT ||
    value.restoreImageId !== process.env.EXPECTED_RESTORE_IMAGE_ID ||
    value.postgresImage !== process.env.EXPECTED_POSTGRES_IMAGE ||
    !exact(value.checks, checkKeys) || checkKeys.some(key => value.checks[key] !== true) ||
    ![value.migrationManifestSha256, value.schemaManifestSha256,
      value.rowAnchorManifestSha256, value.rowContentManifestSha256,
      value.sequenceManifestSha256,
      value.redumpSha256].every(item => /^[0-9a-f]{64}$/.test(item)) ||
    !Number.isFinite(restoredAt) || !Number.isFinite(verifiedAt) ||
    !Number.isFinite(finishedAt) || restoredAt < finishedAt ||
    verifiedAt < restoredAt || Date.now() - finishedAt < 0 ||
    Date.now() - finishedAt > Number(process.env.MAX_AGE_SECONDS) * 1000) process.exit(1);
' \
		-e "EXPECTED_JOB_ID=$job_id" \
		-e "EXPECTED_REVISION=$revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-e "EXPECTED_SYSTEM_ID=$source_system_identifier" \
		-e "EXPECTED_FILE_NAME=$file_name" \
		-e "EXPECTED_FILE_SIZE=$file_size" \
		-e "EXPECTED_DUMP_SHA=$dump_sha" \
		-e "EXPECTED_RECEIPT_SHA=$receipt_sha" \
		-e "EXPECTED_BACKUP_CREATED_AT=$backup_created_at" \
		-e "EXPECTED_JOB_FINISHED_AT=$job_finished_at" \
		-e "EXPECTED_RESTORE_IMAGE_ID=$restore_image_id" \
		-e "EXPECTED_POSTGRES_IMAGE=$REPORTING_CANONICAL_POSTGRES_IMAGE" \
		-e "MAX_AGE_SECONDS=$REPORTING_CORE_CLEANUP_BACKUP_MAX_AGE_SECONDS" \
		-v "$evidence:/evidence.json:ro" >/dev/null || {
		echo 'Core cleanup backup evidence is stale, forged or inconsistent with the live job and dump.' >&2
		return 1
	}
}

reporting_cutover_core_cleanup_migration_name() {
	local cleanup_revision="${1:-}" migration_path migration_name
	[[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	migration_path="$(git -C "$server_root" ls-tree -r --name-only \
		"$cleanup_revision" -- prisma/migrations | awk '
/^prisma\/migrations\/[0-9]{14}_remove_legacy_reporting_state\/migration[.]sql$/ {
  value = $0
  count += 1
}
END {
  if (count == 1) print value
  else exit 1
	}')" || return 1
	migration_name="${migration_path#prisma/migrations/}"
	migration_name="${migration_name%/migration.sql}"
	[[ "$migration_name" =~ ^[0-9]{14}_remove_legacy_reporting_state$ ]] || return 1
	printf '%s\n' "$migration_name"
}

reporting_cutover_core_cleanup_migration_checksum() {
	local cleanup_revision="${1:-}" migration_name="${2:-}"
	local migration_path checksum
	[[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
		"$migration_name" =~ ^[0-9]{14}_remove_legacy_reporting_state$ ]] || return 1
	migration_path="prisma/migrations/$migration_name/migration.sql"
	if command -v sha256sum >/dev/null 2>&1; then
		checksum="$(git -C "$server_root" cat-file blob \
			"$cleanup_revision:$migration_path" | sha256sum | awk 'NR == 1 { print $1 }')" || return 1
	else
		checksum="$(git -C "$server_root" cat-file blob \
			"$cleanup_revision:$migration_path" | shasum -a 256 | awk 'NR == 1 { print $1 }')" || return 1
	fi
	[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s\n' "$checksum"
}

reporting_cutover_core_cleanup_migration_state() {
	local cleanup_revision="${1:-}" migration_name migration_checksum
	local topology_mode ledger_state
	migration_name="$(reporting_cutover_core_cleanup_migration_name \
		"$cleanup_revision")" || return 1
	migration_checksum="$(reporting_cutover_core_cleanup_migration_checksum \
		"$cleanup_revision" "$migration_name")" || return 1
	if ! topology_mode="$(reporting_settings_topology_mode)"; then
		printf 'unsafe\n'
		return 0
	fi
	ledger_state="$(reporting_core_migration_psql --tuples-only --no-align --command "
SELECT count(*) FILTER (
    WHERE checksum IS DISTINCT FROM '$migration_checksum'
  )::TEXT || '|' ||
  count(*) FILTER (
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  )::TEXT || '|' ||
  count(*) FILTER (
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  )::TEXT || '|' ||
  CASE WHEN EXISTS (
    SELECT 1 FROM public.reporting_producer_state
    WHERE id = 'singleton' AND enabled = TRUE
      AND activated_at IS NOT NULL AND daily_summary_owner = 'REPORTING'
      AND daily_summary_switch_generation > 0
  ) THEN 'ready' ELSE 'unsafe' END
FROM public._prisma_migrations
WHERE migration_name = '$migration_name';
")" || return 1
	case "$topology_mode|$ledger_state" in
	transition\|0\|0\|0\|ready) printf 'pending\n' ;;
	transition\|0\|0\|1\|ready) printf 'unfinished-transition\n' ;;
	steady\|0\|1\|0\|ready) printf 'applied\n' ;;
	steady\|0\|0\|1\|ready) printf 'unfinished-steady\n' ;;
	*) printf 'unsafe\n' ;;
	esac
}

reporting_cutover_require_core_cleanup_pending() {
	local cleanup_revision="${1:-}" state
	if [[ -z "$cleanup_revision" ]]; then
		[[ "$(reporting_settings_topology_mode)" == 'transition' ]] || {
			echo 'Core cleanup is no longer pending on the exact transitional schema.' >&2
			return 1
		}
		state="$(reporting_core_migration_psql --tuples-only --no-align --command '
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM public.reporting_producer_state
  WHERE id = '\''singleton'\'' AND enabled = TRUE
    AND activated_at IS NOT NULL AND daily_summary_owner = '\''REPORTING'\''
    AND daily_summary_switch_generation > 0
) THEN '\''pending'\'' ELSE '\''unsafe'\'' END;
')" || return 1
	else
		state="$(reporting_cutover_core_cleanup_migration_state \
			"$cleanup_revision")" || return 1
	fi
	[[ "$state" == 'pending' ]] || {
		case "$state" in
		unfinished-transition | unfinished-steady)
			echo "Core cleanup migration has one exact-checksum unfinished Prisma attempt ($state); reviewed recovery is required and this lifecycle will not resolve it automatically." >&2
			;;
		*)
			echo 'Core cleanup migration is already applied or its preconditions drifted.' >&2
			;;
		esac
		return 1
	}
}

reporting_cutover_core_cleanup_image_identity() {
	[[ $# == 3 ]] || return 1
	local cleanup_revision="$1" migration_name="$2" migration_checksum="$3"
	local image_id image_revision image_migration_checksum
	[[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
		"$migration_name" =~ ^[0-9]{14}_remove_legacy_reporting_state$ &&
		"$migration_checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
	image_id="$(docker image inspect "winwidget-api:git-$cleanup_revision" \
		--format '{{.Id}}' 2>/dev/null || true)"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
		echo 'Exact cleanup API image is unavailable for Prisma resolve.' >&2
		return 1
	}
	image_revision="$(docker image inspect "$image_id" --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		2>/dev/null || true)"
	[[ "$image_revision" == "$cleanup_revision" ]] || {
		echo 'Cleanup API image revision label differs from the staged cleanup revision.' >&2
		return 1
	}
	image_migration_checksum="$(docker run --rm --network none --read-only \
		--cap-drop ALL --security-opt no-new-privileges \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--pids-limit 32 --memory 128m --cpus 0.25 \
		--env HOME=/tmp --entrypoint node "$image_id" -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = process.argv[1];
process.stdout.write(createHash("sha256").update(readFileSync(path)).digest("hex"));
' "/app/prisma/migrations/$migration_name/migration.sql")" || return 1
	[[ "$image_migration_checksum" == "$migration_checksum" ]] || {
		echo 'Cleanup API image contains a different migration blob.' >&2
		return 1
	}
	printf '%s|%s\n' "$image_id" "$image_migration_checksum"
}

reporting_cutover_core_cleanup_stopped_exit_is_safe() {
	[[ $# == 4 ]] || return 1
	local service="$1" exit_code="$2" image_id="$3" image_revision="$4"
	case "$exit_code" in
	0 | 143) return 0 ;;
	137)
		[[ "$service" == 'api' &&
			"$image_id" == "$REPORTING_LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID" &&
			"$image_revision" == "$REPORTING_LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION" ]]
		return
		;;
	*) return 1 ;;
	esac
}

reporting_cutover_write_core_cleanup_stopped_writer_proof() (
	set -Eeuo pipefail
	[[ $# == 3 ]] || return 1
	local original_revision="$1" cleanup_revision="$2" output="$3"
	local service container_id identity container_state exit_code oom_killed
	local state_error started_at finished_at image_id image_revision
	local compose_project compose_service active_migrate_ids session_count unsorted
	local -a writer_services=(
		reporting-service
		api-gateway
		campaigns-service
		api
		outbox-publisher
		integration-worker
		maintenance-worker
		database-restore-worker
		notification-delivery-worker
	)
	[[ "$original_revision" =~ ^[0-9a-f]{40}$ &&
		"$cleanup_revision" =~ ^[0-9a-f]{40}$ && "$output" == /* ]] || return 1
	unsorted="$output.unsorted"
	: >"$unsorted"
	for service in "${writer_services[@]}"; do
		container_id="$(APP_REVISION="$cleanup_revision" \
			APP_VERSION="git-$cleanup_revision" \
			reporting_compose ps -a -q "$service" 2>/dev/null || true)"
		if [[ -z "$container_id" && "$service" == 'database-restore-worker' ]]; then
			printf '%s|container=absent|image=absent|revision=absent|state=absent|exitCode=absent|oomKilled=absent|error=absent|startedAt=absent|finishedAt=absent\n' \
				"$service" >>"$unsorted"
			continue
		fi
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Resolve proof requires one exact stopped container for $service." >&2
			return 1
		}
		identity="$(docker inspect --format \
			'{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
			"$container_id" 2>/dev/null || true)"
		IFS='|' read -r container_state exit_code oom_killed state_error \
			started_at finished_at image_id compose_project compose_service \
			<<<"$identity"
		[[ "$container_state" == 'exited' && "$exit_code" =~ ^[0-9]+$ &&
			"$oom_killed" == 'false' && -z "$state_error" &&
			"$started_at" =~ ^[0-9TZ:.-]+$ && "$finished_at" =~ ^[0-9TZ:.-]+$ &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$compose_project" == 'winwidget' && "$compose_service" == "$service" ]] || {
			echo "Resolve proof found an active, OOM-killed, errored or untrusted writer: $service." >&2
			return 1
		}
		image_revision="$(docker image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image_id" 2>/dev/null || true)"
		if [[ ! "$image_revision" =~ ^[0-9a-f]{40}$ ||
			"$image_revision" == "$cleanup_revision" ]] ||
			! git -C "$server_root" cat-file -e \
				"$image_revision^{commit}" 2>/dev/null ||
			! git -C "$server_root" merge-base --is-ancestor \
				"$image_revision" "$cleanup_revision"; then
			echo "Resolve proof found a writer image outside the pre-cleanup history: $service." >&2
			return 1
		fi
		[[ "$service" != 'reporting-service' ||
			"$image_revision" == "$original_revision" ]] || {
			echo 'Resolve proof requires the exact original stopped Reporting image.' >&2
			return 1
		}
		reporting_cutover_core_cleanup_stopped_exit_is_safe \
			"$service" "$exit_code" "$image_id" "$image_revision" || {
			echo "Resolve proof found an unsafe stopped exit for $service: $exit_code." >&2
			return 1
		}
		printf '%s|container=%s|image=%s|revision=%s|state=%s|exitCode=%s|oomKilled=%s|error=none|startedAt=%s|finishedAt=%s\n' \
			"$service" "$container_id" "$image_id" "$image_revision" \
			"$container_state" "$exit_code" "$oom_killed" "$started_at" \
			"$finished_at" >>"$unsorted"
	done
	active_migrate_ids="$(docker ps -q \
		--filter label=com.docker.compose.project=winwidget \
		--filter label=com.docker.compose.service=migrate)" || return 1
	[[ -z "$active_migrate_ids" ]] || {
		echo 'Core migration container is still running; resolve is blocked.' >&2
		return 1
	}
	session_count="$(reporting_core_migration_psql --tuples-only --no-align --command '
SELECT count(*)::TEXT
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = $type$client backend$type$
  AND pid <> pg_backend_pid();
')" || return 1
	[[ "$session_count" == '0' ]] || {
		echo "Core cleanup resolve requires zero other PostgreSQL client sessions; got ${session_count:-unknown}." >&2
		return 1
	}
	printf 'core-migrate-containers|count=0\n' >>"$unsorted"
	printf 'core-postgresql-client-sessions|count=0\n' >>"$unsorted"
	LC_ALL=C sort "$unsorted" >"$output"
	rm -f -- "$unsorted"
)

reporting_cutover_core_cleanup_resolve() (
	set -Eeuo pipefail
	[[ $# == 1 && ( "$1" == 'prepare' || "$1" == 'resolve' ) ]] || return 1
	local action="$1" original_revision cleanup_revision switch_generation state
	local migration_name migration_checksum review_sha manifest_sha restore_sha
	local ledger_json failed_migration_id ledger_proof_sha cleanup_image_identity
	local core_image_id core_image_digest image_migration_checksum
	local writer_proof_sha proof_root writer_proof ledger_proof
	local writer_before writer_after writer_before_sha writer_after_sha
	local writers_unchanged=true boundary_after='unsafe' applied_invariants='not-applicable'
	local token resolution expected_post_state migration_url post_state evidence evidence_sha
	local resolve_rc=0
	reporting_cutover_require_phase cleanup-staged
	original_revision="$(reporting_cutover_marker_value revision)" || return 1
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)" || return 1
	switch_generation="$(reporting_cutover_marker_value switch_generation)" || return 1
	review_sha="$(reporting_cutover_marker_value cleanup_review_evidence_sha256)" || return 1
	manifest_sha="$(reporting_cutover_marker_value cleanup_manifest_sha256)" || return 1
	restore_sha="$(reporting_cutover_marker_value restore_evidence_sha256)" || return 1
	[[ "$original_revision" =~ ^[0-9a-f]{40}$ &&
		"$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
		"$switch_generation" =~ ^[1-9][0-9]*$ &&
		"$review_sha" =~ ^[0-9a-f]{64}$ && "$manifest_sha" =~ ^[0-9a-f]{64}$ &&
		"$restore_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	[[ "$(git -C "$server_root" rev-parse HEAD)" == "$cleanup_revision" ]] || {
		echo 'Core cleanup resolve must run from the exact staged cleanup revision.' >&2
		return 1
	}
	state="$(reporting_cutover_core_cleanup_migration_state "$cleanup_revision")" || return 1
	case "$state" in
	unfinished-transition)
		resolution='rolled-back'
		expected_post_state='pending'
		;;
	unfinished-steady)
		resolution='applied'
		expected_post_state='applied'
		;;
	*)
		echo "Core cleanup resolve is available only for one exact unfinished attempt; got state=$state." >&2
		return 1
		;;
	esac
	migration_name="$(reporting_cutover_core_cleanup_migration_name "$cleanup_revision")" || return 1
	migration_checksum="$(reporting_cutover_core_cleanup_migration_checksum \
		"$cleanup_revision" "$migration_name")" || return 1
	cleanup_image_identity="$(reporting_cutover_core_cleanup_image_identity \
		"$cleanup_revision" "$migration_name" "$migration_checksum")" || return 1
	IFS='|' read -r core_image_id image_migration_checksum \
		<<<"$cleanup_image_identity"
	core_image_digest="${core_image_id#sha256:}"
	[[ "$core_image_digest" =~ ^[0-9a-f]{64}$ &&
		"$image_migration_checksum" == "$migration_checksum" ]] || return 1
	ledger_json="$(reporting_core_migration_psql --tuples-only --no-align --command "
SELECT json_build_object(
  'id', id::TEXT,
  'migrationName', migration_name,
  'checksum', checksum,
  'startedAt', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
  'finishedAt', finished_at,
  'rolledBackAt', rolled_back_at,
  'appliedStepsCount', applied_steps_count,
  'logsMd5', md5(COALESCE(logs, ''))
)::TEXT
FROM public._prisma_migrations
WHERE migration_name = '$migration_name'
  AND checksum = '$migration_checksum'
  AND finished_at IS NULL
  AND rolled_back_at IS NULL;
")" || return 1
	[[ -n "$ledger_json" && "$ledger_json" != *$'\n'* ]] || return 1
	failed_migration_id="$(printf '%s\n' "$ledger_json" | \
		reporting_run_isolated_node_validator "$core_image_id" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(0, "utf8"));
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) && Object.keys(object).sort().join("|") === [...keys].sort().join("|");
if (!exact(value, ["id", "migrationName", "checksum", "startedAt", "finishedAt",
    "rolledBackAt", "appliedStepsCount", "logsMd5"]) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value.id || "")) ||
    value.migrationName !== process.env.EXPECTED_MIGRATION ||
    value.checksum !== process.env.EXPECTED_CHECKSUM ||
    !Number.isFinite(Date.parse(value.startedAt)) || value.finishedAt !== null ||
    value.rolledBackAt !== null || !Number.isSafeInteger(value.appliedStepsCount) ||
    value.appliedStepsCount < 0 || value.appliedStepsCount > 1 ||
    !/^[0-9a-f]{32}$/.test(String(value.logsMd5 || ""))) process.exit(1);
process.stdout.write(value.id);
' -e "EXPECTED_MIGRATION=$migration_name" \
			-e "EXPECTED_CHECKSUM=$migration_checksum")" || return 1
	proof_root="$(mktemp -d \
		"${TMPDIR:-/tmp}/winwidget-reporting-core-resolve.XXXXXX")" || return 1
	cleanup_core_cleanup_resolve_proofs() {
		if [[ "$proof_root" == "${TMPDIR:-/tmp}/winwidget-reporting-core-resolve."* ]]; then
			rm -rf -- "$proof_root"
		fi
	}
	trap cleanup_core_cleanup_resolve_proofs EXIT
	umask 077
	ledger_proof="$proof_root/ledger.proof"
	writer_proof="$proof_root/writers.proof"
	writer_before="$proof_root/writers.before-command.proof"
	writer_after="$proof_root/writers.after-command.proof"
	{
		printf 'version=2\noriginalRevision=%s\ncleanupRevision=%s\n' \
			"$original_revision" "$cleanup_revision"
		printf 'switchGeneration=%s\nstate=%s\nmigrationName=%s\n' \
			"$switch_generation" "$state" "$migration_name"
		printf 'migrationChecksum=%s\ncleanupApiImageId=%s\n' \
			"$migration_checksum" "$core_image_id"
		printf 'imageMigrationChecksum=%s\ncleanupReviewSha256=%s\n' \
			"$image_migration_checksum" "$review_sha"
		printf 'cleanupManifestSha256=%s\nrestoreEvidenceSha256=%s\n' \
			"$manifest_sha" "$restore_sha"
		printf 'cleanupLegacyDrain=verified\ncleanupSettingsTopology=converged\n'
		printf 'ledger=%s\n' "$ledger_json"
	} >"$ledger_proof"
	ledger_proof_sha="$(reporting_sha256_file "$ledger_proof")" || return 1
	reporting_cutover_require_cleanup_legacy_drain_after_stop
	reporting_cutover_require_settings_topology_cleanup_converged_after_stop
	reporting_cutover_write_core_cleanup_stopped_writer_proof \
		"$original_revision" "$cleanup_revision" "$writer_proof"
	writer_proof_sha="$(reporting_sha256_file "$writer_proof")" || return 1
	token="resolve-core-cleanup:$original_revision:$cleanup_revision:$switch_generation:$state:$migration_name:$failed_migration_id:$migration_checksum:$core_image_digest:$image_migration_checksum:$ledger_proof_sha:$writer_proof_sha"
	printf '%s\n' '--- Core cleanup resolve ledger proof ---'
	sed -n '1,120p' "$ledger_proof"
	printf '%s\n' '--- Core cleanup resolve stopped-writer proof ---'
	sed -n '1,120p' "$writer_proof"
	if [[ "$action" == 'prepare' ]]; then
		printf 'CONFIRM_REPORTING_CORE_CLEANUP_RESOLVE=%s\n' "$token"
		return 0
	fi
	[[ "${CONFIRM_REPORTING_CORE_CLEANUP_RESOLVE:-}" == "$token" ]] || {
		echo "Resolve confirmation changed. Re-run prepare-core-cleanup-resolve and review the new exact proof token." >&2
		return 1
	}
	[[ "$(reporting_cutover_core_cleanup_migration_state "$cleanup_revision")" == "$state" ]] || {
		echo 'Core cleanup migration state changed after resolve proof generation.' >&2
		return 1
	}
	[[ "$(reporting_cutover_core_cleanup_image_identity \
		"$cleanup_revision" "$migration_name" "$migration_checksum")" == \
		"$cleanup_image_identity" ]] || {
		echo 'Cleanup API image identity changed after resolve proof generation.' >&2
		return 1
	}
	if [[ "$resolution" == 'applied' ]]; then
		reporting_cutover_require_core_producer_continuity
		reporting_cutover_require_legacy_core_state_absent
	fi
	reporting_cutover_require_cleanup_legacy_drain_after_stop
	reporting_cutover_require_settings_topology_cleanup_converged_after_stop
	reporting_cutover_write_core_cleanup_stopped_writer_proof \
		"$original_revision" "$cleanup_revision" "$writer_before"
	writer_before_sha="$(reporting_sha256_file "$writer_before")" || return 1
	[[ "$writer_before_sha" == "$writer_proof_sha" ]] || {
		echo 'Stopped writer proof changed immediately before Prisma resolve.' >&2
		return 1
	}
	migration_url="$(reporting_get_env_value DATABASE_MIGRATION_URL_PRODUCTION)" || return 1
	if DATABASE_URL="$migration_url" docker run --rm --network host --read-only \
		--cap-drop ALL --security-opt no-new-privileges \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
		--pids-limit 64 --memory 256m --cpus 0.5 \
		--env DATABASE_URL --env CHECKPOINT_DISABLE=1 --env HOME=/tmp \
		--env APP_REVISION="$cleanup_revision" --env NODE_ENV=production \
		--label com.winwidget.owner=reporting \
		--label com.winwidget.purpose=core-cleanup-migration-resolve \
		--entrypoint /app/node_modules/.bin/prisma "$core_image_id" \
		migrate resolve --schema /app/prisma/schema.prisma \
		"--$resolution" "$migration_name"; then
		resolve_rc=0
	else
		resolve_rc=$?
	fi
	if ! reporting_cutover_write_core_cleanup_stopped_writer_proof \
		"$original_revision" "$cleanup_revision" "$writer_after"; then
		writers_unchanged=false
		printf 'verification=unsafe\n' >"$writer_after"
	fi
	writer_after_sha="$(reporting_sha256_file "$writer_after")" || return 1
	[[ "$writer_after_sha" == "$writer_proof_sha" ]] || writers_unchanged=false
	post_state="$(reporting_cutover_core_cleanup_migration_state \
		"$cleanup_revision" 2>/dev/null || printf 'unavailable\n')"
	case "$post_state" in
	pending | applied | unfinished-transition | unfinished-steady | unsafe | unavailable) ;;
	*) post_state='unavailable' ;;
	esac
	if reporting_cutover_require_cleanup_legacy_drain_after_stop &&
		reporting_cutover_require_settings_topology_cleanup_converged_after_stop; then
		boundary_after='verified'
	fi
	if [[ "$resolution" == 'applied' && "$post_state" == 'applied' ]]; then
		if reporting_cutover_require_core_producer_continuity &&
			reporting_cutover_require_legacy_core_state_absent; then
			applied_invariants='verified'
		else
			applied_invariants='unsafe'
		fi
	fi
	evidence="$proof_root/resolve-evidence.json"
	printf '{"version":2,"originalRevision":"%s","cleanupRevision":"%s","switchGeneration":"%s","migrationName":"%s","failedMigrationId":"%s","migrationChecksum":"%s","cleanupApiImageId":"%s","imageMigrationChecksum":"%s","resolution":"%s","beforeState":"%s","expectedAfterState":"%s","afterState":"%s","prismaExitCode":%s,"ledgerProofSha256":"%s","stoppedWritersProofBeforeSha256":"%s","stoppedWritersProofAfterSha256":"%s","writersUnchanged":%s,"cleanupBoundaryAfter":"%s","appliedInvariants":"%s","resolvedAt":"%s"}\n' \
		"$original_revision" "$cleanup_revision" "$switch_generation" \
		"$migration_name" "$failed_migration_id" "$migration_checksum" \
		"$core_image_id" "$image_migration_checksum" "$resolution" \
		"$state" "$expected_post_state" "$post_state" "$resolve_rc" \
		"$ledger_proof_sha" "$writer_before_sha" "$writer_after_sha" \
		"$writers_unchanged" "$boundary_after" "$applied_invariants" \
		"$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')" \
		>"$evidence"
	chown 0:0 "$evidence"
	chmod 600 "$evidence"
	evidence_sha="$(reporting_sha256_file "$evidence")" || return 1
	reporting_cutover_archive_evidence core-cleanup-resolve \
		"$evidence" "$evidence_sha"
	[[ "$post_state" == "$expected_post_state" &&
		"$writers_unchanged" == 'true' && "$boundary_after" == 'verified' ]] || {
		echo "Prisma resolve exit=$resolve_rc produced state=$post_state or changed the stopped cleanup boundary. Evidence sha256=$evidence_sha. Keep all writers stopped." >&2
		return 1
	}
	if [[ "$resolution" == 'applied' && "$applied_invariants" != 'verified' ]]; then
		echo "Applied resolve did not preserve every exact steady-state invariant. Evidence sha256=$evidence_sha. Keep all writers stopped." >&2
		return 1
	fi
	if ((resolve_rc != 0)); then
		echo "Prisma CLI returned exit=$resolve_rc after the exact resolve committed; post-state and stopped boundary were independently verified." >&2
	fi
	if [[ "$post_state" == 'pending' ]]; then
		echo "Core cleanup attempt marked rolled back. Evidence sha256=$evidence_sha. Retry the exact cleanup deploy with the same fresh verified backup/review; refresh them only if their freshness or digest validation fails."
	else
		echo "Core cleanup attempt marked applied. Evidence sha256=$evidence_sha. Retry the exact cleanup deploy; recovery remains forward-only."
	fi
)

reporting_cutover_verify_core_cleanup_backup() (
	set -Eeuo pipefail
	local revision switch_generation route_boundary job_id job_json summary
	local file_name file_size dump_sha backup_created_at job_finished_at receipt_sha
	local source_system_identifier restore_image_id restore_root restore_container
	local migration_expected migration_actual migration_file path migration_name migration_sha
	local schema_manifest row_manifest row_content_manifest sequence_manifest redump_path evidence_tmp
	local restored_at verified_at evidence_sha expected_database container_id
	local phase cleanup_revision
	phase="$(reporting_cutover_marker_value phase)"
	case "$phase" in
	routes-switched)
		cleanup_revision="${REPORTING_CLEANUP_REVISION:-}"
		;;
	cleanup-staged)
		cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
		;;
	*)
		echo 'Core cleanup backup can only be verified before the cleanup migration.' >&2
		return 1
		;;
	esac
	reporting_cutover_require_core_cleanup_pending "$cleanup_revision"
	job_id="${REPORTING_CORE_CLEANUP_BACKUP_JOB_ID:-}"
	[[ "$job_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
		echo 'REPORTING_CORE_CLEANUP_BACKUP_JOB_ID must be the exact manual Core backup job UUID.' >&2
		return 1
	}
	[[ -f "$REPORTING_CORE_CLEANUP_BACKUP_DUMP" &&
		! -L "$REPORTING_CORE_CLEANUP_BACKUP_DUMP" &&
		"$(reporting_stat_owner "$REPORTING_CORE_CLEANUP_BACKUP_DUMP")" == '0:0' &&
		"$(reporting_stat_mode "$REPORTING_CORE_CLEANUP_BACKUP_DUMP")" == '600' ]] || {
		echo "Place the Telegram-downloaded dump at $REPORTING_CORE_CLEANUP_BACKUP_DUMP as root:root mode 600." >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	route_boundary="$(reporting_cutover_route_evidence_verified_at)"
	expected_database="$(printf '%s\n' "$(reporting_get_env_value DATABASE_BACKUP_URL)" | \
		reporting_run_isolated_node_validator \
			"$(reporting_resolve_image_id_for_revision "$revision")" '
const { readFileSync } = require("node:fs");
const value = new URL(readFileSync(0, "utf8").trim());
if (!value.pathname || value.pathname === "/") process.exit(1);
process.stdout.write(decodeURIComponent(value.pathname.slice(1)));
')"
	job_json="$(reporting_cutover_core_backup_job_json "$job_id")"
	[[ -n "$job_json" && "$job_json" != *$'\n'* ]] || return 1
	summary="$(reporting_cutover_core_backup_job_summary \
		"$job_json" "$job_id" "$route_boundary" "$expected_database")"
	IFS='|' read -r file_name file_size dump_sha backup_created_at \
		job_finished_at receipt_sha <<<"$summary"
	[[ "$file_size" == "$(wc -c <"$REPORTING_CORE_CLEANUP_BACKUP_DUMP" | tr -d '[:space:]')" &&
		"$dump_sha" == "$(reporting_sha256_file "$REPORTING_CORE_CLEANUP_BACKUP_DUMP")" ]] || {
		echo 'Downloaded Core dump does not match the exact durable backup job.' >&2
		return 1
	}
	source_system_identifier="$(reporting_core_migration_psql --tuples-only --no-align --command \
		'SELECT system_identifier::TEXT FROM pg_control_system();')"
	restore_image_id="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-database-restore:git-$revision")"
	restore_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-core-restore.XXXXXX")"
	restore_container="winwidget-reporting-core-restore-${job_id//-/}"
	[[ ! -e "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE" ||
		( -f "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE" &&
		! -L "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE" &&
		"$(reporting_stat_owner "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE")" == '0:0' &&
		"$(reporting_stat_mode "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE")" == '600' ) ]] || return 1
	cleanup_core_restore_drill() {
		if [[ -n "${container_id:-}" ]]; then
			[[ "$(docker inspect --format '{{index .Config.Labels "com.winwidget.purpose"}}' \
				"$container_id" 2>/dev/null || true)" == 'reporting-core-cleanup-restore-drill' ]] &&
				docker rm --force "$container_id" >/dev/null 2>&1 || true
		fi
		if [[ -n "${evidence_tmp:-}" &&
			"$evidence_tmp" == "$(dirname "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE")/.reporting-core-cleanup-backup."* ]]; then
			rm -f -- "$evidence_tmp"
		fi
		[[ "$restore_root" == "${TMPDIR:-/tmp}/winwidget-reporting-core-restore."* ]] &&
			rm -rf -- "$restore_root"
	}
	trap cleanup_core_restore_drill EXIT
	[[ -z "$(docker ps -a -q --filter "name=^/${restore_container}$")" ]] || {
		echo 'A stale Core cleanup restore drill container already exists.' >&2
		return 1
	}
	container_id="$(docker run --detach --name "$restore_container" \
		--network none --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
		--tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
		--tmpfs /var/lib/postgresql:rw,nosuid,nodev,size=1g \
		--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
		--cap-add FOWNER --cap-add SETGID --cap-add SETUID \
		--label com.winwidget.owner=reporting \
		--label com.winwidget.purpose=reporting-core-cleanup-restore-drill \
		--env POSTGRES_DB=core_restore_drill --env POSTGRES_USER=postgres \
		--env POSTGRES_HOST_AUTH_METHOD=trust \
		--env LANG=C.UTF-8 --env LC_ALL=C.UTF-8 \
		--env 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --data-checksums' \
		--env PGDATA=/var/lib/postgresql/18/docker \
		"$REPORTING_CANONICAL_POSTGRES_IMAGE")"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	for attempt in $(seq 1 60); do
		docker exec "$container_id" pg_isready --username postgres \
			--dbname core_restore_drill >/dev/null 2>&1 && break
		[[ "$attempt" != '60' ]] || {
			docker logs "$container_id" >&2
			return 1
		}
		sleep 1
	done
	docker run --rm --network "container:$container_id" --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		-v "$REPORTING_CORE_CLEANUP_BACKUP_DUMP:/evidence/core.dump:ro" \
		--entrypoint pg_restore "$restore_image_id" --list /evidence/core.dump >/dev/null
	docker run --rm --network "container:$container_id" --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		-v "$REPORTING_CORE_CLEANUP_BACKUP_DUMP:/evidence/core.dump:ro" \
		--entrypoint pg_restore "$restore_image_id" \
		--exit-on-error --single-transaction --no-owner --no-privileges \
		--schema public --dbname postgresql://postgres@127.0.0.1:5432/core_restore_drill \
		/evidence/core.dump
	restored_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	migration_expected="$restore_root/migrations.expected"
	migration_actual="$restore_root/migrations.actual"
	migration_file="$restore_root/migration.sql"
	: >"$migration_expected"
	while IFS= read -r path; do
		[[ "$path" =~ ^prisma/migrations/([^/]+)/migration\.sql$ ]] || continue
		migration_name="${BASH_REMATCH[1]}"
		git -C "$server_root" show "$revision:$path" >"$migration_file"
		migration_sha="$(reporting_sha256_file "$migration_file")"
		printf '%s|%s\n' "$migration_name" "$migration_sha" >>"$migration_expected"
	done < <(git -C "$server_root" ls-tree -r --name-only "$revision" -- prisma/migrations | LC_ALL=C sort)
	docker exec "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--tuples-only --no-align --field-separator='|' --username postgres \
		--dbname core_restore_drill \
		--command "$(reporting_cutover_core_migration_manifest_sql)" \
		>"$migration_actual"
	cmp -s "$migration_expected" "$migration_actual" || {
		echo 'Restored Core migration manifest differs from the exact switched revision.' >&2
		return 1
	}
	schema_manifest="$restore_root/schema.manifest"
	row_manifest="$restore_root/rows.manifest"
	row_content_manifest="$restore_root/row-content.manifest"
	sequence_manifest="$restore_root/sequences.manifest"
	docker exec "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--tuples-only --no-align --field-separator='|' --username postgres \
		--dbname core_restore_drill \
		--command "$(reporting_cutover_core_schema_manifest_sql)" \
		>"$schema_manifest"
	reporting_cutover_core_row_anchor_manifest_sql | \
		docker exec -i "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--set="backup_job_id=$job_id" \
			--tuples-only --no-align --field-separator='|' --username postgres \
			--dbname core_restore_drill >"$row_manifest"
	reporting_cutover_core_content_manifest_sql | \
		docker exec -i "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--set="backup_job_id=$job_id" \
			--tuples-only --no-align --username postgres \
			--dbname core_restore_drill >"$row_content_manifest"
	[[ -s "$row_content_manifest" ]] || {
		echo 'Restored Core row-content manifest is empty.' >&2
		return 1
	}
	docker exec "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--tuples-only --no-align --field-separator='|' --username postgres \
		--dbname core_restore_drill \
		--command "$(reporting_cutover_core_sequence_manifest_sql)" \
		>"$sequence_manifest"
	[[ "$(docker exec "$container_id" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--tuples-only --no-align --username postgres --dbname core_restore_drill --command '
SELECT CASE WHEN
  current_database() = '"'"'core_restore_drill'"'"'
  AND (SELECT count(*) FROM public.telegram_bot_settings WHERE id = '"'"'singleton'"'"') = 1
  AND EXISTS (SELECT 1 FROM public.reporting_producer_state
    WHERE id = '"'"'singleton'"'"' AND enabled = TRUE
      AND activated_at IS NOT NULL AND daily_summary_owner = '"'"'REPORTING'"'"'
      AND daily_summary_switch_generation > 0)
  AND (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = '"'"'public'"'"' AND table_name = '"'"'telegram_bot_settings'"'"'
      AND column_name IN ('"'"'daily_summary_enabled'"'"', '"'"'reports_thread_id'"'"',
        '"'"'daily_summary_time'"'"', '"'"'daily_summary_last_sent_period_start'"'"',
        '"'"'daily_summary_last_sent_at'"'"')) = 5
  AND NOT EXISTS (SELECT 1 FROM pg_index WHERE NOT indisvalid)
  AND NOT EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL)
THEN '"'"'verified'"'"' ELSE '"'"'unsafe'"'"' END;
')" == 'verified' ]] || {
		echo 'Restored Core invariants do not match the pre-cleanup switched state.' >&2
		return 1
	}
	redump_path="$restore_root/core-redump.dump"
	docker run --rm --network "container:$container_id" --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		-v "$restore_root:/evidence" --entrypoint pg_dump "$restore_image_id" \
		--format custom --no-owner --no-privileges --schema public \
		--file /evidence/core-redump.dump \
		postgresql://postgres@127.0.0.1:5432/core_restore_drill
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		-v "$redump_path:/evidence/core-redump.dump:ro" \
		--entrypoint pg_restore "$restore_image_id" --list \
		/evidence/core-redump.dump >/dev/null
	verified_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	evidence_tmp="$(mktemp "$(dirname "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE")/.reporting-core-cleanup-backup.XXXXXX")"
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		-e "JOB_ID=$job_id" -e "REVISION=$revision" \
		-e "SWITCH_GENERATION=$switch_generation" \
		-e "SOURCE_SYSTEM_ID=$source_system_identifier" \
		-e "DUMP_FILE_NAME=$file_name" -e "DUMP_FILE_SIZE=$file_size" \
		-e "DUMP_SHA=$dump_sha" -e "RECEIPT_SHA=$receipt_sha" \
		-e "BACKUP_CREATED_AT=$backup_created_at" \
		-e "JOB_FINISHED_AT=$job_finished_at" \
		-e "RESTORE_IMAGE_ID=$restore_image_id" \
		-e "POSTGRES_IMAGE=$REPORTING_CANONICAL_POSTGRES_IMAGE" \
		-e "RESTORED_AT=$restored_at" -e "VERIFIED_AT=$verified_at" \
		-e "MIGRATIONS_SHA=$(reporting_sha256_file "$migration_actual")" \
		-e "SCHEMA_SHA=$(reporting_sha256_file "$schema_manifest")" \
		-e "ROWS_SHA=$(reporting_sha256_file "$row_manifest")" \
		-e "ROW_CONTENT_SHA=$(reporting_sha256_file "$row_content_manifest")" \
		-e "SEQUENCES_SHA=$(reporting_sha256_file "$sequence_manifest")" \
		-e "REDUMP_SHA=$(reporting_sha256_file "$redump_path")" \
		--entrypoint node "$(reporting_resolve_image_id_for_revision "$revision")" -e '
const value = {
  version: 1,
  jobId: process.env.JOB_ID,
  revision: process.env.REVISION,
  switchGeneration: process.env.SWITCH_GENERATION,
  sourceDatabaseSystemIdentifier: process.env.SOURCE_SYSTEM_ID,
  dumpFileName: process.env.DUMP_FILE_NAME,
  dumpFileSize: Number(process.env.DUMP_FILE_SIZE),
  dumpSha256: process.env.DUMP_SHA,
  telegramReceiptSha256: process.env.RECEIPT_SHA,
  backupCreatedAt: process.env.BACKUP_CREATED_AT,
  jobFinishedAt: process.env.JOB_FINISHED_AT,
  restoreImageId: process.env.RESTORE_IMAGE_ID,
  postgresImage: process.env.POSTGRES_IMAGE,
  restoredAt: process.env.RESTORED_AT,
  verifiedAt: process.env.VERIFIED_AT,
  migrationManifestSha256: process.env.MIGRATIONS_SHA,
  schemaManifestSha256: process.env.SCHEMA_SHA,
  rowAnchorManifestSha256: process.env.ROWS_SHA,
  rowContentManifestSha256: process.env.ROW_CONTENT_SHA,
  sequenceManifestSha256: process.env.SEQUENCES_SHA,
  redumpSha256: process.env.REDUMP_SHA,
  checks: {
    job: true, offVpsArtifact: true, archive: true, isolatedTarget: true,
    migrations: true, schema: true, rows: true, rowContent: true, sequences: true,
    invariants: true, redump: true,
  },
};
process.stdout.write(`${JSON.stringify(value)}\n`);
' >"$evidence_tmp"
	chown 0:0 "$evidence_tmp"
	chmod 600 "$evidence_tmp"
	mv -f "$evidence_tmp" "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE"
	reporting_cutover_validate_core_cleanup_backup_evidence \
		"$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE"
	evidence_sha="$(reporting_sha256_file "$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE")"
	reporting_cutover_archive_evidence core-cleanup-backup \
		"$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE" "$evidence_sha"
	echo "Core cleanup backup restored in isolated PostgreSQL 18 and archived. Evidence sha256=$evidence_sha."
)

reporting_cutover_core_backup_sha_from_review() {
	[[ $# == 1 ]] || return 1
	local review="$1" revision image_id
	revision="$(reporting_cutover_marker_value revision)" || return 1
	image_id="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	reporting_run_isolated_node_validator "$image_id" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/review.json", "utf8"));
if (!/^[0-9a-f]{64}$/.test(String(value.coreBackupEvidenceSha256 || ""))) process.exit(1);
process.stdout.write(value.coreBackupEvidenceSha256);
' -v "$review:/review.json:ro"
}

reporting_cutover_require_live_core_matches_backup_evidence() (
	set -Eeuo pipefail
	[[ $# == 1 ]] || return 1
	local evidence="$1" revision image_id expected_value manifest_root
	local expected_migration_sha expected_schema_sha
	local migration_manifest schema_manifest actual_sha
	revision="$(reporting_cutover_marker_value revision)" || return 1
	image_id="$(reporting_resolve_image_id_for_revision \
		"$revision" "winwidget-reporting:git-$revision")" || return 1
	expected_value="$(reporting_run_isolated_node_validator "$image_id" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const shaKeys = ["migrationManifestSha256", "schemaManifestSha256"];
if (!shaKeys.every(key => /^[0-9a-f]{64}$/.test(String(value[key] || "")))) process.exit(1);
process.stdout.write(shaKeys.map(key => value[key]).join("|"));
' -v "$evidence:/evidence.json:ro")" || return 1
	IFS='|' read -r expected_migration_sha expected_schema_sha <<<"$expected_value"
	[[ "$expected_migration_sha" =~ ^[0-9a-f]{64}$ &&
		"$expected_schema_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	manifest_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-core-live-manifests.XXXXXX")" || return 1
	cleanup_live_core_manifests() {
		[[ "$manifest_root" == "${TMPDIR:-/tmp}/winwidget-reporting-core-live-manifests."* ]] &&
			rm -rf -- "$manifest_root"
	}
	trap cleanup_live_core_manifests EXIT
	migration_manifest="$manifest_root/migrations.manifest"
	schema_manifest="$manifest_root/schema.manifest"
	reporting_core_migration_psql --tuples-only --no-align \
		--field-separator='|' \
		--command "$(reporting_cutover_core_migration_manifest_sql)" \
		>"$migration_manifest" || return 1
	reporting_core_migration_psql --tuples-only --no-align \
		--field-separator='|' \
		--command "$(reporting_cutover_core_schema_manifest_sql)" \
		>"$schema_manifest" || return 1
	for manifest in "$migration_manifest" "$schema_manifest"; do
		[[ -s "$manifest" ]] || {
			echo "Live Core manifest $(basename "$manifest") is empty after stopping writers." >&2
			return 1
		}
	done
	compare_live_core_manifest() {
		[[ $# == 3 ]] || return 1
		local label="$1" manifest="$2" expected_sha="$3"
		actual_sha="$(reporting_sha256_file "$manifest")" || return 1
		[[ "$actual_sha" == "$expected_sha" ]] || {
			echo "Live Core $label no longer matches the reviewed pre-cleanup DDL boundary." >&2
			return 1
		}
	}
	compare_live_core_manifest 'migration manifest' "$migration_manifest" "$expected_migration_sha" || return 1
	compare_live_core_manifest 'schema manifest' "$schema_manifest" "$expected_schema_sha" || return 1
)

reporting_cutover_core_cleanup_backup_archive_from_review() {
	local review_sha review core_sha evidence
	review_sha="$(reporting_cutover_marker_value cleanup_review_evidence_sha256)" || return 1
	[[ "$review_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	reporting_cutover_require_archived_evidence cleanup-review "$review_sha" || return 1
	review="$(reporting_cutover_evidence_path cleanup-review "$review_sha")" || return 1
	core_sha="$(reporting_cutover_core_backup_sha_from_review "$review")" || return 1
	reporting_cutover_require_archived_evidence core-cleanup-backup "$core_sha" || return 1
	evidence="$(reporting_cutover_evidence_path core-cleanup-backup "$core_sha")" || return 1
	printf '%s|%s\n' "$core_sha" "$evidence"
}

reporting_cutover_require_core_cleanup_backup_archive_from_review() {
	local value core_sha evidence
	value="$(reporting_cutover_core_cleanup_backup_archive_from_review)" || return 1
	IFS='|' read -r core_sha evidence <<<"$value"
	[[ "$core_sha" =~ ^[0-9a-f]{64}$ && "$evidence" == /* ]] || return 1
	reporting_cutover_require_stable_digest core-cleanup-backup "$evidence" "$core_sha"
}

reporting_cutover_require_core_cleanup_backup_from_review() {
	local value core_sha evidence
	value="$(reporting_cutover_core_cleanup_backup_archive_from_review)" || return 1
	IFS='|' read -r core_sha evidence <<<"$value"
	[[ "$core_sha" =~ ^[0-9a-f]{64}$ && "$evidence" == /* ]] || return 1
	reporting_cutover_validate_core_cleanup_backup_evidence "$evidence" || return 1
	reporting_cutover_require_live_core_matches_backup_evidence "$evidence" || return 1
	reporting_cutover_require_stable_digest core-cleanup-backup "$evidence" "$core_sha"
}

reporting_cutover_validate_cleanup_contract() {
	local review="$1" manifest="$2" previous_revision="$3"
	local cleanup_revision="$4" switch_generation="$5" core_backup_sha="$6" image value
	[[ "$core_backup_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	for value in "$review" "$manifest"; do
		[[ "$value" == /* && -f "$value" && ! -L "$value" &&
			"$(reporting_stat_owner "$value")" == '0:0' &&
			"$(reporting_stat_mode "$value")" == '600' ]] || {
			echo 'Reporting cleanup review and manifest must be absolute, root-owned mode-600 files.' >&2
			return 1
		}
	done
	image="$(reporting_resolve_image_id_for_revision "$previous_revision")" || return 1
	git -C "$server_root" diff-tree --no-commit-id --raw -r -z --no-renames \
		"$previous_revision" "$cleanup_revision" | \
		reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const review = JSON.parse(readFileSync("/review.json", "utf8"));
const manifest = JSON.parse(readFileSync("/manifest.json", "utf8"));
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) && Object.keys(object).sort().join("|") === [...keys].sort().join("|");
const exactArray = (value, expected) => Array.isArray(value) &&
  JSON.stringify(value) === JSON.stringify(expected);
const raw = readFileSync(0);
const rawText = raw.toString("utf8");
if (!Buffer.from(rawText).equals(raw)) process.exit(1);
const rawFields = rawText.split("\0");
if (rawFields.pop() !== "" || rawFields.length % 2 !== 0) process.exit(1);
const changedFiles = [];
for (let index = 0; index < rawFields.length; index += 2) {
  const header = rawFields[index];
  const path = rawFields[index + 1];
  const match = header.match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])$/);
  const zeroBlob = "0".repeat(40);
  const allowedModes = new Set(["000000", "100644", "100755"]);
  if (!match || !/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith("/") ||
      path.split("/").includes("..") || !allowedModes.has(match[1]) ||
      !allowedModes.has(match[2]) ||
      (match[5] === "A" && (match[1] !== "000000" || match[3] !== zeroBlob ||
        match[2] === "000000" || match[4] === zeroBlob)) ||
      (match[5] === "D" && (match[2] !== "000000" || match[4] !== zeroBlob || match[1] === "000000")) ||
      (match[5] === "M" && (match[1] !== match[2] || match[1] === "000000" ||
        match[3] === zeroBlob || match[4] === zeroBlob))) process.exit(1);
  changedFiles.push({
    path,
    status: match[5],
    oldMode: match[1],
    newMode: match[2],
    oldBlob: match[3],
    newBlob: match[4],
  });
}
const checks = [
  "routeSmoke", "authSmoke", "corsSmoke", "shadowParity", "lagZero",
  "singleSchedulerOwner", "dailySummaryDelivered", "offVpsBackup",
  "cleanRestore", "legacyQueuesDrained", "cleanupDiffReviewed",
  "rollbackBoundaryApproved",
];
const removedPaths = [
  "src/messaging/daily-summary-event.ts", "src/reports", "src/statistics",
];
const preservedPaths = [
  "apps/reporting/prisma/schema.prisma",
  "prisma/migrations/20260731010000_add_reporting_projection_producers",
  "src/messaging/reporting-admin-audit-event.ts",
  "src/reporting-internal/reporting-internal-token.guard.spec.ts",
  "src/reporting-internal/reporting-internal-token.guard.ts",
  "src/reporting-internal/reporting-internal.constants.ts",
  "src/reporting-internal/reporting-internal.controller.spec.ts",
  "src/reporting-internal/reporting-internal.controller.ts",
  "src/reporting-internal/reporting-internal.module.ts",
  "src/reporting-internal/reporting-schedule-authority.service.spec.ts",
];
const modifiedReportingPaths = [
  "apps/reporting/src/messaging/reporting-messaging.constants.spec.ts",
  "apps/reporting/src/messaging/reporting-messaging.constants.ts",
  "apps/reporting/src/messaging/reporting-rabbitmq.service.spec.ts",
  "apps/reporting/src/projections/projection.service.spec.ts",
  "apps/reporting/src/projections/projection.service.ts",
  "apps/reporting/src/projections/reporting-event.contract.spec.ts",
  "apps/reporting/src/projections/reporting-event.contract.ts",
  "apps/reporting/src/shadow-evidence/reporting-shadow-evidence.service.ts",
  "apps/reporting/test/integration/reporting.integration.mjs",
];
const modifiedCorePaths = [
  "prisma/schema.prisma",
  "src/app.module.ts",
  "src/health/health.service.spec.ts",
  "src/maintenance/maintenance-scheduler.service.spec.ts",
  "src/maintenance/maintenance-scheduler.service.ts",
  "src/maintenance/maintenance-worker.service.spec.ts",
  "src/maintenance/scheduled-tasks.service.spec.ts",
  "src/maintenance/scheduled-tasks.service.ts",
  "src/messaging/integration-delivery.service.spec.ts",
  "src/messaging/integration-delivery.service.ts",
  "src/messaging/integration-error-classifier.ts",
  "src/messaging/integration-worker.module.ts",
  "src/messaging/integration-worker.service.spec.ts",
  "src/messaging/integration-worker.service.ts",
  "src/messaging/messaging-admin.service.ts",
  "src/messaging/messaging-event-contract.ts",
  "src/messaging/messaging-operational-alert.service.spec.ts",
  "src/messaging/messaging.constants.ts",
  "src/messaging/notification-delivery-event.ts",
  "src/messaging/reporting-projection-contract.spec.ts",
  "src/reporting-internal/reporting-schedule-authority.service.ts",
  "src/scheduled-jobs/scheduled-jobs.service.spec.ts",
  "src/scheduled-jobs/scheduled-jobs.types.ts",
  "src/telegram-bot/dto/update-telegram-bot-settings.dto.ts",
  "src/telegram-bot/telegram-bot.controller.ts",
  "src/telegram-bot/telegram-bot.service.spec.ts",
  "src/telegram-bot/telegram-bot.service.ts",
];
const modifiedControlPlanePaths = [
  ".env.example",
  ".github/workflows/deploy-production.yml",
  "apps/notification-delivery/test/integration/notification-delivery.integration.mjs",
  "deploy/docker-compose.prod.yml",
  "scripts/deploy-production.sh",
  "scripts/deploy-reporting-production.sh",
  "scripts/reporting-cutover-lifecycle.sh",
  "scripts/reporting-database-lifecycle.sh",
  "scripts/reporting-producer-lifecycle.sh",
  "scripts/test-messaging-integration.mjs",
  "scripts/test-reporting-cutover-rehearsal.sh",
  "scripts/test-reporting-production-scripts.sh",
];
const addedControlPlanePaths = [
  "scripts/generate-reporting-frontend-runtime-attestation.sh",
  "scripts/run-reporting-restore-cutover-smoke.sh",
  "scripts/run-reporting-scheduler-cutover-smoke.sh",
];
const removedQueues = [
  "winwidget.report.daily-summary.telegram",
  "winwidget.report.daily-summary.telegram.dead-letter",
  "winwidget.report.daily-summary.telegram.retry-v2.1",
  "winwidget.report.daily-summary.telegram.retry-v2.2",
  "winwidget.report.daily-summary.telegram.retry-v2.3",
];
const retainedQueues = [
  "winwidget.admin.audit.reporting.v1",
  "winwidget.admin.audit.reporting.v1.dead-letter",
  "winwidget.admin.audit.reporting.v1.retry-v2.1",
  "winwidget.admin.audit.reporting.v1.retry-v2.2",
  "winwidget.admin.audit.reporting.v1.retry-v2.3",
  "winwidget.notification.daily-summary.telegram",
  "winwidget.notification.daily-summary.telegram.dead-letter",
  "winwidget.notification.daily-summary.telegram.retry-v2.1",
  "winwidget.notification.daily-summary.telegram.retry-v2.2",
  "winwidget.notification.daily-summary.telegram.retry-v2.3",
];
const modifiedPaths = new Set([
  ...modifiedReportingPaths, ...modifiedCorePaths, ...modifiedControlPlanePaths,
]);
const addedPaths = new Set(addedControlPlanePaths);
const removedPath = path => removedPaths.some(root =>
  path === root || path.startsWith(`${root}/`));
const cleanupMigrationPath = path =>
  /^prisma\/migrations\/[0-9]{14}_remove_legacy_reporting_state\/migration[.]sql$/.test(path);
if (changedFiles.some(file =>
      (modifiedPaths.has(file.path) && file.status !== "M") ||
      (addedPaths.has(file.path) && (file.status !== "A" || file.newMode !== "100755")) ||
      (removedPath(file.path) && file.status !== "D") ||
      (cleanupMigrationPath(file.path) && (file.status !== "A" || file.newMode !== "100644")) ||
      (!modifiedPaths.has(file.path) && !addedPaths.has(file.path) &&
        !removedPath(file.path) && !cleanupMigrationPath(file.path))) ||
    [...modifiedPaths].some(path => !changedFiles.some(file => file.path === path)) ||
    [...addedPaths].some(path => !changedFiles.some(file => file.path === path)) ||
    !removedPaths.every(root => changedFiles.some(file => removedPath(file.path) &&
      (file.path === root || file.path.startsWith(`${root}/`)))) ||
    changedFiles.filter(file => cleanupMigrationPath(file.path)).length !== 1) process.exit(1);
if (!exact(review, ["version", "previousRevision", "cleanupRevision", "switchGeneration", "coreBackupEvidenceSha256", "approvedBy", "approvedAt", "checks"]) ||
    review.version !== 1 || review.previousRevision !== process.env.EXPECTED_PREVIOUS_REVISION ||
    review.cleanupRevision !== process.env.EXPECTED_CLEANUP_REVISION ||
    review.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
    review.coreBackupEvidenceSha256 !== process.env.EXPECTED_CORE_BACKUP_SHA ||
    typeof review.approvedBy !== "string" || !review.approvedBy.trim() ||
    review.approvedBy.length > 128 || /[\u0000-\u001f\u007f]/.test(review.approvedBy) ||
    !Number.isFinite(Date.parse(review.approvedAt)) || !exact(review.checks, checks) ||
    checks.some(key => review.checks[key] !== true)) process.exit(1);
if (!exact(manifest, ["version", "previousRevision", "cleanupRevision", "switchGeneration", "changedFiles", "removedPaths", "preservedPaths", "modifiedReportingPaths", "modifiedCorePaths", "modifiedControlPlanePaths", "addedControlPlanePaths", "removedQueues", "retainedQueues", "createdAt"]) ||
    manifest.version !== 1 || manifest.previousRevision !== process.env.EXPECTED_PREVIOUS_REVISION ||
    manifest.cleanupRevision !== process.env.EXPECTED_CLEANUP_REVISION ||
    manifest.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.changedFiles) ||
    manifest.changedFiles.some(file => !exact(file, ["path", "status", "oldMode", "newMode", "oldBlob", "newBlob"])) ||
    JSON.stringify(manifest.changedFiles) !== JSON.stringify(changedFiles) ||
    !exactArray(manifest.removedPaths, removedPaths) ||
    !exactArray(manifest.preservedPaths, preservedPaths) ||
    !exactArray(manifest.modifiedReportingPaths, modifiedReportingPaths) ||
    !exactArray(manifest.modifiedCorePaths, modifiedCorePaths) ||
    !exactArray(manifest.modifiedControlPlanePaths, modifiedControlPlanePaths) ||
    !exactArray(manifest.addedControlPlanePaths, addedControlPlanePaths) ||
    !exactArray(manifest.removedQueues, removedQueues) ||
    !exactArray(manifest.retainedQueues, retainedQueues)) process.exit(1);
' \
		-e "EXPECTED_PREVIOUS_REVISION=$previous_revision" \
		-e "EXPECTED_CLEANUP_REVISION=$cleanup_revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-e "EXPECTED_CORE_BACKUP_SHA=$core_backup_sha" \
		-v "$review:/review.json:ro" -v "$manifest:/manifest.json:ro" >/dev/null
}

reporting_cutover_expected_cleanup_migration_sql() {
	cat <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.reporting.daily-summary.owner.v1'));

DO $reporting_cleanup_guard$
DECLARE
    owner_ready BOOLEAN;
    pristine_bootstrap BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM "reporting_producer_state"
        WHERE "id" = 'singleton'
          AND "enabled" = true
          AND "activated_at" IS NOT NULL
          AND "daily_summary_owner" = 'REPORTING'
          AND "daily_summary_switch_generation" > 0
          AND "daily_summary_switched_at" IS NOT NULL
    ) INTO owner_ready;

    SELECT
        (SELECT count(*) = 1 FROM "reporting_producer_state")
        AND EXISTS (
            SELECT 1
            FROM "reporting_producer_state"
            WHERE "id" = 'singleton'
              AND "enabled" = false
              AND "activated_at" IS NULL
              AND "daily_summary_owner" = 'CORE'
              AND "daily_summary_switch_generation" = 0
              AND "daily_summary_switched_at" IS NULL
              AND "daily_summary_schedule_time" = '01:50'
              AND "daily_summary_schedule_generation" = 0
              AND "daily_summary_policy_confirmed_change_id" IS NULL
              AND "daily_summary_policy_pending_change_id" IS NULL
              AND "daily_summary_policy_pending_time" IS NULL
              AND "daily_summary_policy_pending_generation" IS NULL
        )
        AND NOT (SELECT "is_called" FROM "reporting_source_sequence")
        AND NOT EXISTS (SELECT 1 FROM "reporting_projection_versions")
        AND NOT EXISTS (SELECT 1 FROM "outbox_events")
        AND NOT EXISTS (SELECT 1 FROM "scheduled_job_runs")
        AND NOT EXISTS (SELECT 1 FROM "scheduled_job_idempotency_keys")
        AND NOT EXISTS (SELECT 1 FROM "integration_credential_snapshots")
        AND NOT EXISTS (SELECT 1 FROM "integration_delivery_receipts")
        AND NOT EXISTS (SELECT 1 FROM "integration_delivery_failures")
        AND (SELECT count(*) = 1 FROM "telegram_bot_settings")
        AND EXISTS (
            SELECT 1
            FROM "telegram_bot_settings"
            WHERE "id" = 'singleton'
              AND "daily_summary_enabled" = false
              AND "daily_summary_chat_id" = ''
              AND "daily_summary_last_sent_period_start" IS NULL
              AND "daily_summary_last_sent_at" IS NULL
              AND "daily_summary_time" = '01:50'
              AND "reports_thread_id" IS NULL
              AND "database_backup_enabled" = true
              AND "database_backup_time" = '01:45'
              AND "database_backup_last_sent_period_start" IS NULL
              AND "database_backup_last_sent_at" IS NULL
              AND "support_thread_id" IS NULL
              AND "database_backup_thread_id" IS NULL
              AND "payments_thread_id" IS NULL
              AND "operational_alerts_thread_id" = 2024
        )
        AND NOT EXISTS (SELECT 1 FROM "User")
        AND NOT EXISTS (SELECT 1 FROM "auth_identities")
        AND NOT EXISTS (SELECT 1 FROM "payments")
        AND NOT EXISTS (SELECT 1 FROM "subscriptions")
        AND NOT EXISTS (SELECT 1 FROM "widgets")
        AND NOT EXISTS (SELECT 1 FROM "quizzes")
        AND NOT EXISTS (SELECT 1 FROM "callbacks")
        AND NOT EXISTS (SELECT 1 FROM "countdown_timers")
        AND NOT EXISTS (SELECT 1 FROM "stop_offers")
        AND NOT EXISTS (SELECT 1 FROM "online_consultants")
        AND NOT EXISTS (SELECT 1 FROM "calculators")
        AND NOT EXISTS (SELECT 1 FROM "leads")
        AND NOT EXISTS (SELECT 1 FROM "quiz_leads")
        AND NOT EXISTS (SELECT 1 FROM "callback_leads")
        AND NOT EXISTS (SELECT 1 FROM "countdown_timer_leads")
        AND NOT EXISTS (SELECT 1 FROM "stop_offer_leads")
        AND NOT EXISTS (SELECT 1 FROM "online_consultant_leads")
        AND NOT EXISTS (SELECT 1 FROM "calculator_leads")
    INTO pristine_bootstrap;

    IF NOT (owner_ready OR pristine_bootstrap) OR EXISTS (
        SELECT 1
        FROM "scheduled_job_runs"
        WHERE "job_type" = 'DAILY_TELEGRAM_SUMMARY'
          AND "status" IN (
              'QUEUED'::"ScheduledJobRunStatus",
              'PROCESSING'::"ScheduledJobRunStatus"
          )
    ) OR EXISTS (
        SELECT 1
        FROM "outbox_events"
        WHERE "event_type" IN (
            'report.daily-summary.requested.v1',
            'notification.daily-summary.telegram.requested.v1',
            'reporting.settings.changed.v1'
        )
          AND "status" <> 'PUBLISHED'::"OutboxEventStatus"
    ) OR EXISTS (
        SELECT 1
        FROM "integration_delivery_failures"
        WHERE "integration" IN (
            'daily-summary-telegram',
            'daily-summary-delivery-telegram'
        )
          AND "resolved_at" IS NULL
    ) OR EXISTS (
        SELECT 1
        FROM "integration_delivery_receipts"
        WHERE "integration" IN (
            'daily-summary-telegram',
            'daily-summary-delivery-telegram'
        )
          AND "status" IN (
              'PROCESSING'::"IntegrationDeliveryReceiptStatus",
              'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus"
          )
    ) OR EXISTS (
        SELECT 1
        FROM "scheduled_job_idempotency_keys" key
        JOIN "scheduled_job_runs" run ON run."id" = key."job_id"
        WHERE (key."job_type" = 'DAILY_TELEGRAM_SUMMARY') <>
              (run."job_type" = 'DAILY_TELEGRAM_SUMMARY')
    ) THEN
        RAISE EXCEPTION 'Legacy Reporting state is not drained';
    END IF;
END
$reporting_cleanup_guard$;

DELETE FROM "scheduled_job_idempotency_keys" key
USING "scheduled_job_runs" run
WHERE key."job_id" = run."id"
  AND key."job_type" = 'DAILY_TELEGRAM_SUMMARY'
  AND run."job_type" = 'DAILY_TELEGRAM_SUMMARY';

DELETE FROM "scheduled_job_runs"
WHERE "job_type" = 'DAILY_TELEGRAM_SUMMARY';

DELETE FROM "outbox_events"
WHERE "event_type" IN (
    'report.daily-summary.requested.v1',
    'notification.daily-summary.telegram.requested.v1',
    'reporting.settings.changed.v1'
);

UPDATE "reporting_projection_versions"
SET "aggregate_type" = 'reporting.core-operational-routing.changed.v1',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "aggregate_type" = 'reporting.settings';

DELETE FROM "integration_credential_snapshots"
WHERE "integration" IN (
    'daily-summary-telegram',
    'daily-summary-delivery-telegram'
);

DELETE FROM "integration_delivery_receipts"
WHERE "integration" IN (
    'daily-summary-telegram',
    'daily-summary-delivery-telegram'
);

DELETE FROM "integration_delivery_failures"
WHERE "integration" IN (
    'daily-summary-telegram',
    'daily-summary-delivery-telegram'
);

CREATE OR REPLACE FUNCTION "reporting_settings_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."daily_summary_chat_id" IS NOT DISTINCT FROM OLD."daily_summary_chat_id"
        AND NEW."operational_alerts_thread_id" IS NOT DISTINCT FROM OLD."operational_alerts_thread_id"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_record_projection_event"(
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            OLD."id",
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'coreOperationalAlertsDestinationChatId', NEW."daily_summary_chat_id",
            'coreOperationalAlertsThreadId', NEW."operational_alerts_thread_id"
        );
        PERFORM "reporting_record_projection_event"(
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            NEW."id",
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

ALTER TABLE "telegram_bot_settings"
    DROP COLUMN "daily_summary_enabled",
    DROP COLUMN "reports_thread_id",
    DROP COLUMN "daily_summary_time",
    DROP COLUMN "daily_summary_last_sent_period_start",
    DROP COLUMN "daily_summary_last_sent_at";

COMMIT;
SQL
}

reporting_cutover_require_exact_cleanup_migration() {
	local cleanup_revision="$1" migration_path="$2" actual expected
	[[ "$migration_path" =~ ^prisma/migrations/[0-9]{14}_remove_legacy_reporting_state/migration\.sql$ ]] || {
		echo "Reporting cleanup migration path is not the exact reviewed contract: $migration_path" >&2
		return 1
	}
	actual="$(git -C "$server_root" show "$cleanup_revision:$migration_path")" || return 1
	expected="$(reporting_cutover_expected_cleanup_migration_sql)" || return 1
	[[ "$actual" == "$expected" ]] || {
		echo 'Reporting cleanup migration SQL differs from the exact allowlisted destructive scope.' >&2
		return 1
	}
}

reporting_cutover_is_mutable_reporting_path() {
	[[ $# == 1 ]] || return 1
	local candidate="$1" expected
	for expected in "${REPORTING_CLEANUP_MUTABLE_REPORTING_PATHS[@]}"; do
		[[ "$candidate" == "$expected" ]] && return 0
	done
	return 1
}

reporting_cutover_require_cleanup_git_contract() {
	local previous_revision="$1" cleanup_revision="$2" path previous_blob cleanup_blob
	local migration_entry new_core_migration_count=0
	git -C "$server_root" cat-file -e "$cleanup_revision^{commit}" 2>/dev/null || {
		echo 'Reporting cleanup revision is not present as a verified Git commit.' >&2
		return 1
	}
	git -C "$server_root" merge-base --is-ancestor \
		"$previous_revision" "$cleanup_revision" || {
		echo 'Reporting cleanup revision must be a forward descendant of the switched revision.' >&2
		return 1
	}
	[[ "$previous_revision" != "$cleanup_revision" ]] || return 1
	reporting_require_post_cleanup_revision_contract "$cleanup_revision" || {
		echo 'Reporting cleanup revision violates the permanent post-cleanup source contract.' >&2
		return 1
	}
	for path in "${REPORTING_CLEANUP_TRUSTED_PATHS[@]}"; do
		previous_blob="$(git -C "$server_root" rev-parse "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ "$previous_blob" =~ ^[0-9a-f]{40}$ && "$cleanup_blob" == "$previous_blob" ]] || {
			echo "Reporting cleanup changed or removed trusted lifecycle path: $path" >&2
			return 1
		}
	done
	for path in "${REPORTING_CLEANUP_REMOVED_PATHS[@]}"; do
		git -C "$server_root" cat-file -e "$previous_revision:$path" 2>/dev/null || {
			echo "Reporting switched revision does not contain expected legacy path: $path" >&2
			return 1
		}
		if git -C "$server_root" cat-file -e "$cleanup_revision:$path" 2>/dev/null; then
			echo "Reporting cleanup revision still contains legacy path: $path" >&2
			return 1
		fi
	done
	for path in "${REPORTING_CLEANUP_PRESERVED_PATHS[@]}"; do
		previous_blob="$(git -C "$server_root" rev-parse "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ "$previous_blob" =~ ^[0-9a-f]{40}$ && "$cleanup_blob" == "$previous_blob" ]] || {
			echo "Reporting cleanup changed or removed preserved producer/service path: $path" >&2
			return 1
		}
	done
	for path in "${REPORTING_CLEANUP_MUTABLE_REPORTING_PATHS[@]}"; do
		previous_blob="$(git -C "$server_root" rev-parse "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ "$previous_blob" =~ ^[0-9a-f]{40}$ &&
			"$cleanup_blob" =~ ^[0-9a-f]{40}$ &&
			"$cleanup_blob" != "$previous_blob" ]] || {
			echo "Reporting cleanup did not make the required transitional source change: $path" >&2
			return 1
		}
	done
	for path in "${REPORTING_CLEANUP_MUTABLE_CORE_PATHS[@]}" \
		"${REPORTING_CLEANUP_MUTABLE_CONTROL_PLANE_PATHS[@]}"; do
		previous_blob="$(git -C "$server_root" rev-parse "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ "$previous_blob" =~ ^[0-9a-f]{40}$ &&
			"$cleanup_blob" =~ ^[0-9a-f]{40}$ &&
			"$cleanup_blob" != "$previous_blob" ]] || {
			echo "Reporting cleanup did not make the required reviewed change: $path" >&2
			return 1
		}
	done
	for path in "${REPORTING_CLEANUP_ADDED_CONTROL_PLANE_PATHS[@]}"; do
		previous_blob="$(git -C "$server_root" rev-parse --verify "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ -z "$previous_blob" && "$cleanup_blob" =~ ^[0-9a-f]{40}$ &&
			"$(git -C "$server_root" ls-tree "$cleanup_revision" -- "$path")" =~ ^100755[[:space:]]blob[[:space:]][0-9a-f]{40}[[:space:]] ]] || {
			echo "Reporting cleanup control-plane addition is missing or unsafe: $path" >&2
			return 1
		}
	done
	while IFS= read -r -d '' path; do
		reporting_cutover_is_mutable_reporting_path "$path" && continue
		previous_blob="$(git -C "$server_root" rev-parse "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ "$previous_blob" =~ ^[0-9a-f]{40}$ && "$cleanup_blob" == "$previous_blob" ]] || {
			echo "Reporting cleanup changed or removed an unrelated service path: $path" >&2
			return 1
		}
	done < <(git -C "$server_root" ls-tree -r -z --name-only \
		"$previous_revision" -- apps/reporting)
	while IFS= read -r -d '' path; do
		git -C "$server_root" cat-file -e "$previous_revision:$path" 2>/dev/null || {
			echo "Reporting cleanup added an unapproved service path: $path" >&2
			return 1
		}
	done < <(git -C "$server_root" ls-tree -r -z --name-only \
		"$cleanup_revision" -- apps/reporting)
	while IFS= read -r -d '' path; do
		previous_blob="$(git -C "$server_root" rev-parse "$previous_revision:$path" 2>/dev/null || true)"
		cleanup_blob="$(git -C "$server_root" rev-parse "$cleanup_revision:$path" 2>/dev/null || true)"
		[[ "$previous_blob" =~ ^[0-9a-f]{40}$ && "$cleanup_blob" == "$previous_blob" ]] || {
			echo "Reporting cleanup modified or removed immutable migration file: $path" >&2
			return 1
		}
	done < <(git -C "$server_root" ls-tree -r -z --name-only "$previous_revision" -- \
		prisma/migrations apps/reporting/prisma/migrations \
		apps/notification-delivery/prisma/migrations apps/campaigns/prisma/migrations)
	while IFS= read -r -d '' path; do
		if git -C "$server_root" cat-file -e "$previous_revision:$path" 2>/dev/null; then
			continue
		fi
		[[ "$path" =~ ^prisma/migrations/[0-9]{14}_remove_legacy_reporting_state/migration\.sql$ ]] || {
			echo "Reporting cleanup added an unapproved migration path: $path" >&2
			return 1
		}
		migration_entry="$(git -C "$server_root" ls-tree "$cleanup_revision" -- "$path")"
		[[ "$migration_entry" =~ ^100644[[:space:]]blob[[:space:]][0-9a-f]{40}[[:space:]] ]] || {
			echo "Reporting cleanup migration must be one regular migration.sql blob: $path" >&2
			return 1
		}
		reporting_cutover_require_exact_cleanup_migration \
			"$cleanup_revision" "$path" || return 1
		new_core_migration_count=$((new_core_migration_count + 1))
	done < <(git -C "$server_root" ls-tree -r -z --name-only "$cleanup_revision" -- \
		prisma/migrations apps/reporting/prisma/migrations \
		apps/notification-delivery/prisma/migrations apps/campaigns/prisma/migrations)
	[[ "$new_core_migration_count" == '1' ]] || {
		echo 'Reporting cleanup revision must add exactly one allowlisted Core state migration.' >&2
		return 1
	}
}

reporting_cutover_stage_cleanup() {
	local phase revision cleanup_revision switch_generation review manifest core_evidence
	local review_sha manifest_sha core_sha system_identifier snapshot_id backfill_sha
	local shadow_sha scheduler_sha route_sha restore_sha
	phase="$(reporting_cutover_marker_value phase)"
	[[ "$phase" == 'routes-switched' || "$phase" == 'cleanup-staged' ]] || {
		echo 'Reporting cleanup can only be staged or refreshed before its migration is applied.' >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	cleanup_revision="${REPORTING_CLEANUP_REVISION:-}"
	[[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo 'REPORTING_CLEANUP_REVISION must be an exact lowercase Git SHA.' >&2
		return 1
	}
	if [[ "$phase" == 'cleanup-staged' &&
		"$cleanup_revision" != "$(reporting_cutover_marker_value cleanup_revision)" ]]; then
		echo 'A staged Reporting cleanup can only refresh evidence for the already pinned cleanup revision.' >&2
		return 1
	fi
	reporting_cutover_require_core_cleanup_pending "$cleanup_revision"
	restore_sha="$(reporting_cutover_marker_value restore_evidence_sha256)"
	[[ "$restore_sha" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Reporting cleanup cannot be staged before a real backup restore is verified.' >&2
		return 1
	}
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	reporting_cutover_require_forward_scheduler_ready
	reporting_cutover_require_cleanup_git_contract "$revision" "$cleanup_revision"
	review="${REPORTING_CLEANUP_REVIEW_FILE:-}"
	manifest="${REPORTING_CLEANUP_MANIFEST_FILE:-}"
	core_evidence="$REPORTING_CORE_CLEANUP_BACKUP_EVIDENCE"
	[[ -n "$review" && -n "$manifest" ]] || {
		echo 'REPORTING_CLEANUP_REVIEW_FILE and REPORTING_CLEANUP_MANIFEST_FILE are required.' >&2
		return 1
	}
	reporting_cutover_validate_core_cleanup_backup_evidence "$core_evidence"
	core_sha="$(reporting_sha256_file "$core_evidence")"
	reporting_cutover_require_archived_evidence core-cleanup-backup "$core_sha"
	reporting_cutover_require_stable_digest \
		core-cleanup-backup "$core_evidence" "$core_sha"
	review_sha="$(reporting_sha256_file "$review")"
	manifest_sha="$(reporting_sha256_file "$manifest")"
	if [[ "$phase" == 'cleanup-staged' ]]; then
		[[ "$manifest_sha" == "$(reporting_cutover_marker_value cleanup_manifest_sha256)" ]] || {
			echo 'Refreshing Core backup evidence cannot replace the pinned cleanup manifest.' >&2
			return 1
		}
		reporting_cutover_require_archived_evidence cleanup-manifest "$manifest_sha"
	fi
	reporting_cutover_validate_cleanup_contract \
		"$review" "$manifest" "$revision" "$cleanup_revision" \
		"$switch_generation" "$core_sha"
	reporting_cutover_require_stable_digest cleanup-review "$review" "$review_sha"
	reporting_cutover_require_stable_digest cleanup-manifest "$manifest" "$manifest_sha"
	[[ "${CONFIRM_REPORTING_CLEANUP_STAGE:-}" == \
		"stage-cleanup:$revision:$cleanup_revision:$switch_generation:$core_sha:$review_sha:$manifest_sha" ]] || {
		echo "Set CONFIRM_REPORTING_CLEANUP_STAGE=stage-cleanup:$revision:$cleanup_revision:$switch_generation:$core_sha:$review_sha:$manifest_sha after reviewing the exact forward-only cleanup and verified Core restore evidence." >&2
		return 1
	}
	shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	scheduler_sha="$(reporting_cutover_marker_value scheduler_evidence_sha256)"
	route_sha="$(reporting_cutover_marker_value route_evidence_sha256)"
	reporting_cutover_require_archived_evidence shadow "$shadow_sha"
	reporting_cutover_require_archived_evidence scheduler "$scheduler_sha"
	reporting_cutover_require_archived_evidence routes "$route_sha"
	reporting_cutover_require_archived_route_runtime "$revision" "$revision"
	reporting_cutover_require_archived_evidence restore "$restore_sha"
	reporting_cutover_archive_evidence cleanup-review "$review" "$review_sha"
	reporting_cutover_archive_evidence cleanup-manifest "$manifest" "$manifest_sha"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha="$(reporting_cutover_marker_value backfill_sha256)"
	reporting_cutover_write_marker cleanup-staged "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha" "$shadow_sha" target-owned \
		"$scheduler_sha" "$route_sha" "$restore_sha" pending pending \
		"$switch_generation" "$revision" "$cleanup_revision" \
		"$review_sha" "$manifest_sha" pending
	if [[ "$phase" == 'cleanup-staged' ]]; then
		echo "Reporting cleanup backup evidence and review refreshed for $revision -> $cleanup_revision; the cleanup manifest remains pinned."
	else
		echo "Reporting cleanup revision staged: $revision -> $cleanup_revision. Route rollback is now closed."
	fi
}

reporting_cutover_validate_source_cleanup_evidence() {
	local evidence="$1" previous_revision="$2" cleanup_revision="$3"
	local switch_generation="$4" image
	[[ "$evidence" == /* && -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_owner "$evidence")" == '0:0' &&
		"$(reporting_stat_mode "$evidence")" == '600' ]] || return 1
	image="$(reporting_resolve_image_id_for_revision "$cleanup_revision")" || return 1
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) && Object.keys(object).sort().join("|") === [...keys].sort().join("|");
const checks = [
  "legacyCodeRemoved", "legacyRoutesRemoved", "legacyContractsRemoved",
  "legacyQueuesDrained", "legacyStateCleared", "canonicalSourcePreserved",
  "producerLedgerPreserved", "projectionContinuity", "singleSchedulerOwner",
  "dailySummaryDelivered", "routeSmoke", "authSmoke", "corsSmoke",
];
if (!exact(value, ["version", "previousRevision", "cleanupRevision", "switchGeneration", "verifiedAt", "checks"]) ||
    value.version !== 1 || value.previousRevision !== process.env.EXPECTED_PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.EXPECTED_CLEANUP_REVISION ||
    value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
    !Number.isFinite(Date.parse(value.verifiedAt)) || !exact(value.checks, checks) ||
    checks.some(key => value.checks[key] !== true)) process.exit(1);
' \
		-e "EXPECTED_PREVIOUS_REVISION=$previous_revision" \
		-e "EXPECTED_CLEANUP_REVISION=$cleanup_revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-v "$evidence:/evidence.json:ro" >/dev/null
}

reporting_cutover_validate_completion_evidence() {
	local evidence="$1" previous_revision="$2" cleanup_revision="$3"
	local switch_generation="$4" image
	[[ "$evidence" == /* && -f "$evidence" && ! -L "$evidence" &&
		"$(reporting_stat_owner "$evidence")" == '0:0' &&
		"$(reporting_stat_mode "$evidence")" == '600' ]] || return 1
	image="$(reporting_resolve_image_id_for_revision "$cleanup_revision")" || return 1
	reporting_run_isolated_node_validator "$image" '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/evidence.json", "utf8"));
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) && Object.keys(object).sort().join("|") === [...keys].sort().join("|");
const checks = [
  "routeSmoke", "authSmoke", "corsSmoke", "lagZero", "shadowParity",
  "singleSchedulerOwner", "dailySummaryDelivered", "offVpsBackup",
  "cleanRestore", "legacyCodeAbsent", "legacyRoutesAbsent",
  "legacyQueuesAbsent", "legacyStateAbsent", "canonicalSourcePreserved",
  "producerContinuity", "rollbackImageRetained", "scopedCleanup",
];
if (!exact(value, ["version", "previousRevision", "cleanupRevision", "switchGeneration", "completedAt", "checks"]) ||
    value.version !== 1 || value.previousRevision !== process.env.EXPECTED_PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.EXPECTED_CLEANUP_REVISION ||
    value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION ||
    !Number.isFinite(Date.parse(value.completedAt)) || !exact(value.checks, checks) ||
    checks.some(key => value.checks[key] !== true)) process.exit(1);
' \
		-e "EXPECTED_PREVIOUS_REVISION=$previous_revision" \
		-e "EXPECTED_CLEANUP_REVISION=$cleanup_revision" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-v "$evidence:/evidence.json:ro" >/dev/null
}

reporting_cutover_require_legacy_code_absent_from_image() {
	local image_id="$1"
	reporting_run_isolated_node_validator "$image_id" '
const { existsSync, readFileSync, readdirSync } = require("node:fs");
for (const path of [
  "/app/dist/src/statistics",
  "/app/dist/src/reports",
  "/app/dist/src/messaging/daily-summary-event.js",
]) {
  if (existsSync(path)) process.exit(1);
}
const forbidden = [
  "report.daily-summary.requested.v1",
  "notification.daily-summary.telegram.requested.v1",
  "reporting.settings.changed.v1",
  "daily-summary-telegram",
  "daily-summary-job",
  "winwidget.report.daily-summary.telegram",
  "DAILY_SUMMARY_EVENT_TYPE",
  "REPORTING_SETTINGS_EVENT_TYPE",
  "DAILY_TELEGRAM_SUMMARY",
  "DailySummaryRequestedEventPayload",
  "DailySummaryReportService",
  "DailySummaryDeliveryService",
  "applyDailySummaryDeliveryOutcome",
  "persistDailySummaryDeadLetter",
  "getDailySummaryJobId",
  "enqueueDailySummary",
  "StatisticsModule",
  "StatisticsController",
  "StatisticsService",
  "/statistics",
  "reportsThreadId",
  "dailySummaryEnabled",
  "dailySummaryTime",
  "dailySummaryLastSent",
];
const files = [];
const visit = directory => {
  if (!existsSync(directory)) process.exit(1);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      const text = readFileSync(path, "utf8");
      files.push({ path, text });
    }
  }
};
visit("/app/dist/src");
const pathsContaining = token => files
  .filter(({ text }) => text.includes(token))
  .map(({ path }) => path)
  .sort();
const client = require(
  "/app/dist/src/messaging/notification-delivery-client.service.js"
);
const contract = require("/app/dist/src/messaging/messaging.constants.js");
const expectedAdminKinds = [
  ...contract.NOTIFICATION_DELIVERY_KINDS,
  "daily-summary-delivery-telegram",
];
if (JSON.stringify(pathsContaining("daily-summary-delivery-telegram")) !==
    JSON.stringify([]) ||
    JSON.stringify(pathsContaining("NOTIFICATION_DELIVERY_ADMIN_KINDS")) !==
    JSON.stringify([
      "/app/dist/src/messaging/messaging-admin.service.js",
      "/app/dist/src/messaging/notification-delivery-client.service.js",
    ]) ||
    client.NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND !==
      "daily-summary-delivery-telegram" ||
    JSON.stringify(client.NOTIFICATION_DELIVERY_ADMIN_KINDS) !==
      JSON.stringify(expectedAdminKinds) ||
    files.some(({ text }) => forbidden.some(token => text.includes(token)))) process.exit(1);
' >/dev/null || {
		echo 'Cleanup runtime image still contains legacy Reporting code or contracts.' >&2
		return 1
	}
}

reporting_cutover_require_cleanup_migration_in_restore_image() {
	local image_id="$1" expected
	expected="$(reporting_cutover_expected_cleanup_migration_sql)" || return 1
	printf '%s\n' "$expected" | reporting_run_isolated_node_validator "$image_id" '
const { readFileSync, readdirSync } = require("node:fs");
const root = "/app/prisma/migrations";
const matches = readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^[0-9]{14}_remove_legacy_reporting_state$/.test(entry.name))
  .map(entry => `${root}/${entry.name}/migration.sql`);
const expected = readFileSync(0, "utf8");
if (matches.length !== 1 || readFileSync(matches[0], "utf8") !== expected) process.exit(1);
const schema = readFileSync("/app/prisma/schema.prisma", "utf8");
for (const token of [
  "dailySummaryEnabled",
  "reportsThreadId",
  "dailySummaryTime",
  "dailySummaryLastSentPeriodStart",
  "dailySummaryLastSentAt",
]) {
  if (schema.includes(token)) process.exit(1);
}
' --user 1001:1001 >/dev/null || {
		echo 'Database restore worker does not contain the exact cleanup migration and steady-state Core schema.' >&2
		return 1
	}
}

reporting_cutover_require_notification_delivery_runtime_contract() {
	local container_id="$1" image_id="$2" kinds expected_kinds
	expected_kinds='email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram'
	kinds="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^NOTIFICATION_DELIVERY_KINDS=//p')" || return 1
	[[ "$(reporting_normalize_integration_kinds "$kinds")" == \
		"$(reporting_normalize_integration_kinds "$expected_kinds")" ]] || {
		echo 'Notification Delivery runtime does not own the exact post-cutover kind set.' >&2
		return 1
	}
	reporting_run_isolated_node_validator "$image_id" '
const contract = require("/app/dist/src/messaging/messaging.constants.js");
const expected = [
  "email", "telegram", "payment-email", "payment-telegram", "limit-email",
  "limit-telegram", "campaign-email", "campaign-telegram",
  "daily-summary-delivery-telegram", "subscription-expiry-email",
  "subscription-expiry-telegram",
];
if (JSON.stringify(contract.NOTIFICATION_DELIVERY_KINDS) !== JSON.stringify(expected) ||
    contract.MESSAGING_ROUTING_KEYS["daily-summary-delivery-telegram"] !==
      "notification.daily-summary.telegram.requested.v1" ||
    contract.MESSAGING_QUEUE_NAMES["daily-summary-delivery-telegram"] !==
      "winwidget.notification.daily-summary.telegram") process.exit(1);
' >/dev/null || {
		echo 'Notification Delivery image does not contain the exact retained Daily Summary delivery contract.' >&2
		return 1
	}
}

reporting_cutover_require_reporting_steady_runtime_contract() {
	local image_id="$1"
	reporting_run_isolated_node_validator "$image_id" '
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const contract = require("/app/dist/src/messaging/reporting-messaging.constants.js");
const operational = "reporting.core-operational-routing.changed.v1";
const deliveryOutcome = "reporting.notification.delivery.outcome.v1";
if (contract.REPORTING_ROUTING_KEYS.reportingSettings !== operational ||
    JSON.stringify(contract.REPORTING_ACCEPTED_ROUTING_KEYS.reportingSettings) !==
      JSON.stringify([operational]) ||
    JSON.stringify(contract.REPORTING_ACCEPTED_PROJECTION_EVENT_TYPES.reportingSettings) !==
      JSON.stringify([operational]) ||
    contract.DELIVERY_OUTCOME_EVENT_TYPE !== deliveryOutcome ||
    contract.REPORTING_ROUTING_KEYS.deliveryOutcome !== deliveryOutcome ||
    JSON.stringify(contract.REPORTING_ACCEPTED_ROUTING_KEYS.deliveryOutcome) !==
      JSON.stringify([deliveryOutcome]) ||
    JSON.stringify(contract.REPORTING_NOTIFICATION_DELIVERY_KINDS) !==
      JSON.stringify(["daily-summary-delivery-telegram"]) ||
    contract.REPORTING_NOTIFICATION_DELIVERY_ROUTING_KEYS[
      "daily-summary-delivery-telegram"
    ] !== "notification.daily-summary.telegram.requested.v1") process.exit(1);
const visit = directory => {
  if (!existsSync(directory)) process.exit(1);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && entry.name.endsWith(".js") &&
      readFileSync(path, "utf8").includes("reporting.settings.changed.v1")) process.exit(1);
  }
};
visit("/app/dist/src");
' >/dev/null || {
		echo 'Cleanup Reporting image still accepts or emits the transitional settings event.' >&2
		return 1
	}
}

reporting_cutover_require_cleanup_runtime_revision() {
	local expected_revision="$1" service container_id app_revision health
	local status restarting restart_count service_expected_revision reporting_revision
	local image_id image_revision core_image_id='' maintenance_image_id=''
	local restore_image_id='' notification_image_id='' notification_container_id=''
	local reporting_image_id='' retained_reporting_image_id
	local gateway_container_id='' expected_manifest live_manifest
	reporting_revision="$(reporting_cutover_marker_value revision)" || return 1
	[[ "$reporting_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	for service in api api-gateway outbox-publisher integration-worker \
		maintenance-worker database-restore-worker notification-delivery-worker \
		reporting-service; do
		container_id="$(reporting_compose ps --status running -q "$service" 2>/dev/null || true)"
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Reporting cleanup requires exactly one running $service container." >&2
			return 1
		}
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
			sed -n 's/^APP_REVISION=//p')"
		service_expected_revision="$expected_revision"
		image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
		image_revision="$(docker image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image_id")" || return 1
		status="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
		restarting="$(docker inspect --format '{{.State.Restarting}}' "$container_id")" || return 1
		restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
		[[ "$app_revision" == "$service_expected_revision" &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$image_revision" == "$service_expected_revision" &&
			"$status" == 'running' && "$restarting" == 'false' &&
			"$restart_count" == '0' ]] || {
			echo "Reporting cleanup runtime $service is not on exact revision $service_expected_revision." >&2
			return 1
		}
		case "$service" in
		api) core_image_id="$image_id" ;;
		api-gateway) gateway_container_id="$container_id" ;;
		outbox-publisher | integration-worker)
			[[ -n "$core_image_id" && "$image_id" == "$core_image_id" ]] || {
				echo "API and $service are not using the same reviewed cleanup image." >&2
				return 1
			}
			;;
		maintenance-worker) maintenance_image_id="$image_id" ;;
		database-restore-worker) restore_image_id="$image_id" ;;
		notification-delivery-worker)
			notification_image_id="$image_id"
			notification_container_id="$container_id"
			;;
		reporting-service) reporting_image_id="$image_id" ;;
		esac
		case "$service" in
		api | api-gateway | maintenance-worker | database-restore-worker | notification-delivery-worker | reporting-service)
			health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
			[[ "$health" == 'healthy' ]] || {
				echo "Reporting cleanup runtime $service is not healthy." >&2
				return 1
			}
			;;
		esac
	done
	[[ -n "$core_image_id" && -n "$maintenance_image_id" &&
		-n "$restore_image_id" && -n "$notification_image_id" &&
		-n "$notification_container_id" && -n "$reporting_image_id" &&
		-n "$gateway_container_id" ]] || return 1
	reporting_cutover_require_legacy_code_absent_from_image "$core_image_id"
	reporting_cutover_require_legacy_code_absent_from_image "$maintenance_image_id"
	reporting_cutover_require_legacy_code_absent_from_image "$restore_image_id"
	reporting_cutover_require_cleanup_migration_in_restore_image "$restore_image_id"
	reporting_cutover_require_notification_delivery_runtime_contract \
		"$notification_container_id" "$notification_image_id"
	reporting_cutover_require_reporting_steady_runtime_contract \
		"$reporting_image_id"
	retained_reporting_image_id="$(reporting_resolve_image_id_for_revision \
		"$reporting_revision" "winwidget-reporting:git-$reporting_revision")" || return 1
	[[ "$retained_reporting_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$retained_reporting_image_id" != "$reporting_image_id" ]] || {
		echo 'The exact pre-cleanup Reporting runtime image is not retained for cutover completion.' >&2
		return 1
	}
	expected_manifest="$(reporting_get_env_value GATEWAY_ROUTES_JSON)"
	reporting_cutover_validate_gateway_manifest_value "$expected_manifest" reporting || {
		echo 'Reporting cleanup requires the exact Reporting Gateway manifest.' >&2
		return 1
	}
	live_manifest="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$gateway_container_id" | sed -n 's/^GATEWAY_ROUTES_JSON=//p')" || return 1
	[[ "$live_manifest" == "$expected_manifest" ]] || {
		echo 'Cleanup Gateway runtime manifest differs byte-for-byte from production env.' >&2
		return 1
	}
}

reporting_cutover_require_core_producer_continuity() {
	local state
	# Reuse the exact trigger/function/ACL contract from the producer lifecycle.
	# Counts and LIKE patterns alone can accept missing definitions or extra broad
	# privileges after the cleanup revision.
	reporting_require_core_producer_migration
	reporting_require_core_producer_acl
	state="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM "reporting_producer_state"
    WHERE "id" = '"'"'singleton'"'"'
      AND "enabled" = true
      AND "daily_summary_owner" = '"'"'REPORTING'"'"'
      AND "daily_summary_switch_generation" > 0
  )
  AND to_regclass('"'"'public.reporting_projection_versions'"'"') IS NOT NULL
  AND to_regclass('"'"'public.reporting_source_sequence'"'"') IS NOT NULL
	  AND NOT EXISTS (
    SELECT 1 FROM "outbox_events"
    WHERE "event_type" = '"'"'report.daily-summary.requested.v1'"'"'
      AND "status" <> '"'"'PUBLISHED'"'"'::"OutboxEventStatus"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "scheduled_job_runs"
    WHERE "job_type" = '"'"'DAILY_TELEGRAM_SUMMARY'"'"'
      AND "status" IN (
        '"'"'QUEUED'"'"'::"ScheduledJobRunStatus",
        '"'"'PROCESSING'"'"'::"ScheduledJobRunStatus"
      )
  )
THEN '"'"'preserved'"'"' ELSE '"'"'unsafe'"'"' END;
')"
	[[ "$state" == 'preserved' ]] || {
		echo 'Core Reporting producer ledger, source sequence, projection versions, triggers or Outbox continuity is unsafe.' >&2
		return 1
	}
}

reporting_cutover_require_legacy_core_state_absent() {
	local state
	state="$(reporting_core_psql --tuples-only --no-align --command '
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM "scheduled_job_idempotency_keys"
    WHERE "job_type" = '"'"'DAILY_TELEGRAM_SUMMARY'"'"'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "scheduled_job_runs"
    WHERE "job_type" = '"'"'DAILY_TELEGRAM_SUMMARY'"'"'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "outbox_events"
    WHERE "event_type" IN (
      '"'"'report.daily-summary.requested.v1'"'"',
      '"'"'notification.daily-summary.telegram.requested.v1'"'"',
      '"'"'reporting.settings.changed.v1'"'"'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "reporting_projection_versions"
    WHERE "aggregate_type" = '"'"'reporting.settings'"'"'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "integration_delivery_receipts"
    WHERE "integration" IN (
      '"'"'daily-summary-telegram'"'"',
      '"'"'daily-summary-delivery-telegram'"'"'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "integration_delivery_failures"
    WHERE "integration" IN (
      '"'"'daily-summary-telegram'"'"',
      '"'"'daily-summary-delivery-telegram'"'"'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "integration_credential_snapshots"
    WHERE "integration" IN (
      '"'"'daily-summary-telegram'"'"',
      '"'"'daily-summary-delivery-telegram'"'"'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '"'"'public'"'"'
      AND table_name = '"'"'telegram_bot_settings'"'"'
      AND column_name IN (
        '"'"'daily_summary_enabled'"'"',
        '"'"'reports_thread_id'"'"',
        '"'"'daily_summary_time'"'"',
        '"'"'daily_summary_last_sent_period_start'"'"',
        '"'"'daily_summary_last_sent_at'"'"'
      )
  )
  AND (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = '"'"'public'"'"'
      AND table_name = '"'"'telegram_bot_settings'"'"'
      AND column_name IN (
        '"'"'daily_summary_chat_id'"'"',
        '"'"'database_backup_enabled'"'"',
        '"'"'database_backup_time'"'"',
        '"'"'database_backup_thread_id'"'"',
        '"'"'payments_thread_id'"'"',
        '"'"'operational_alerts_thread_id'"'"'
      )
  ) = 6
THEN '"'"'absent'"'"' ELSE '"'"'present'"'"' END;
')" || return 1
	[[ "$state" == 'absent' ]] || {
		echo 'Core still contains Reporting-owned jobs, events, receipts, failures, credentials or Telegram settings state.' >&2
		return 1
	}
}

reporting_cutover_cleanup_legacy_queues() {
	local rabbitmq_container queues queue line
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_queues -p winwidget name messages_ready messages_unacknowledged consumers)"
	for queue in "${REPORTING_CLEANUP_RETAINED_QUEUES[@]}"; do
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" '$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" || {
			echo "Required post-cleanup queue is missing: $queue" >&2
			return 1
		}
		reporting_cutover_validate_retained_queue_line "$queue" "$line" || {
			echo "Required post-cleanup queue is not drained: $queue" >&2
			return 1
		}
	done
	for queue in "${REPORTING_CLEANUP_LEGACY_QUEUES[@]}"; do
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" '$1 == queue { print; found += 1 } END { exit(found <= 1 ? 0 : 1) }')"
		if [[ -z "$line" ]]; then
			continue
		fi
		[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]] || {
			echo "Legacy Reporting queue is active or not drained: $queue" >&2
			return 1
		}
		docker exec "$rabbitmq_container" rabbitmqctl --silent delete_queue \
			-p winwidget "$queue" --if-empty --if-unused >/dev/null
	done
	reporting_cutover_require_post_cleanup_queue_topology
}

reporting_cutover_validate_retained_queue_line() {
	local queue="$1" line="$2"
	if [[ "$queue" == *.retry-v2.* ]]; then
		[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+0$ ]]
		return
	fi
	[[ "$line" =~ ^[^[:space:]]+[[:space:]]+0[[:space:]]+0[[:space:]]+[1-9][0-9]*$ ]]
}

reporting_cutover_require_post_cleanup_queue_topology() {
	local rabbitmq_container queues queue line
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || return 1
	queues="$(docker exec "$rabbitmq_container" rabbitmqctl --silent \
		list_queues -p winwidget name messages_ready messages_unacknowledged consumers)"
	for queue in "${REPORTING_CLEANUP_RETAINED_QUEUES[@]}"; do
		line="$(printf '%s\n' "$queues" | awk -v queue="$queue" '$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" || {
			echo "Required post-cleanup queue is missing: $queue" >&2
			return 1
		}
		reporting_cutover_validate_retained_queue_line "$queue" "$line" || {
			echo "Required post-cleanup queue is not drained: $queue" >&2
			return 1
		}
	done
	for queue in "${REPORTING_CLEANUP_LEGACY_QUEUES[@]}"; do
		if printf '%s\n' "$queues" | awk -v queue="$queue" \
			'$1 == queue { found = 1 } END { exit(found ? 0 : 1) }'; then
			echo "Legacy Reporting queue exists after cleanup: $queue" >&2
			return 1
		fi
	done
}

reporting_cutover_write_cleanup_state() {
	local phase="$1" source_cleanup_sha="$2" cleanup_restore_sha="$3"
	local completion_sha="$4" revision system_identifier snapshot_id backfill_sha
	local shadow_sha scheduler_sha route_sha restore_sha switch_generation
	local cleanup_previous cleanup_revision review_sha manifest_sha
	revision="$(reporting_cutover_marker_value revision)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	scheduler_sha="$(reporting_cutover_marker_value scheduler_evidence_sha256)"
	route_sha="$(reporting_cutover_marker_value route_evidence_sha256)"
	restore_sha="$(reporting_cutover_marker_value restore_evidence_sha256)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	cleanup_previous="$(reporting_cutover_marker_value cleanup_previous_revision)"
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
	review_sha="$(reporting_cutover_marker_value cleanup_review_evidence_sha256)"
	manifest_sha="$(reporting_cutover_marker_value cleanup_manifest_sha256)"
	reporting_cutover_write_marker "$phase" "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha" "$shadow_sha" target-owned \
		"$scheduler_sha" "$route_sha" "$restore_sha" "$source_cleanup_sha" \
		"$completion_sha" "$switch_generation" "$cleanup_previous" \
		"$cleanup_revision" "$review_sha" "$manifest_sha" "$cleanup_restore_sha"
}

reporting_cutover_mark_source_cleaned() {
	local revision cleanup_revision switch_generation evidence sha256
	reporting_cutover_require_phase cleanup-staged
	revision="$(reporting_cutover_marker_value revision)"
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_cleanup_git_contract "$revision" "$cleanup_revision"
	reporting_cutover_require_cleanup_runtime_revision "$cleanup_revision"
	reporting_cutover_require_archived_route_runtime "$revision" "$cleanup_revision"
	reporting_cutover_require_forward_scheduler_ready
	reporting_require_admin_audit_consumer_ready "$cleanup_revision"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	reporting_cutover_require_core_producer_continuity
	reporting_cutover_require_legacy_core_state_absent
	reporting_cutover_require_projection_barrier
	evidence="${REPORTING_SOURCE_CLEANUP_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_SOURCE_CLEANUP_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	reporting_cutover_validate_source_cleanup_evidence \
		"$evidence" "$revision" "$cleanup_revision" "$switch_generation"
	reporting_cutover_require_stable_digest source-cleanup "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_SOURCE_CLEANED:-}" == \
		"source-cleaned:$revision:$cleanup_revision:$switch_generation:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_SOURCE_CLEANED=source-cleaned:$revision:$cleanup_revision:$switch_generation:$sha256 after reviewing the exact cleanup evidence." >&2
		return 1
	}
	reporting_cutover_cleanup_legacy_queues
	reporting_cutover_archive_evidence source-cleanup "$evidence" "$sha256"
	reporting_cutover_write_cleanup_state source-cleaned "$sha256" pending pending
	echo "Reporting legacy source and exact queues are cleaned; producer continuity is preserved. Evidence sha256=$sha256."
}

reporting_cutover_verify_cleanup_restore() {
	local revision cleanup_revision system_identifier switch_generation evidence sha256 source_sha
	reporting_cutover_require_phase source-cleaned
	[[ "$(reporting_cutover_marker_value cleanup_restore_evidence_sha256)" == 'pending' ]] || {
		echo 'Reporting cleanup restore evidence is already fixed in the marker.' >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	evidence="${REPORTING_CLEANUP_RESTORE_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_CLEANUP_RESTORE_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	reporting_cutover_validate_restore_evidence \
		"$evidence" "$cleanup_revision" "$system_identifier" "$switch_generation"
	reporting_cutover_require_stable_digest cleanup-restore "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_CLEANUP_RESTORE_VERIFIED:-}" == \
		"cleanup-restore:$cleanup_revision:$switch_generation:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_CLEANUP_RESTORE_VERIFIED=cleanup-restore:$cleanup_revision:$switch_generation:$sha256 after reviewing the post-cleanup restore." >&2
		return 1
	}
	reporting_cutover_archive_evidence cleanup-restore "$evidence" "$sha256"
	source_sha="$(reporting_cutover_marker_value source_cleanup_evidence_sha256)"
	reporting_cutover_write_cleanup_state source-cleaned "$source_sha" "$sha256" pending
	echo "Reporting post-cleanup real backup restore evidence fixed sha256=$sha256."
}

reporting_cutover_complete() {
	local revision cleanup_revision switch_generation evidence sha256
	local source_sha cleanup_restore_sha kind digest pair
	reporting_cutover_require_phase source-cleaned
	revision="$(reporting_cutover_marker_value revision)"
	cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	cleanup_restore_sha="$(reporting_cutover_marker_value cleanup_restore_evidence_sha256)"
	[[ "$cleanup_restore_sha" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Reporting cannot complete before the post-cleanup real backup restore.' >&2
		return 1
	}
	reporting_cutover_require_cleanup_git_contract "$revision" "$cleanup_revision"
	reporting_cutover_require_cleanup_runtime_revision "$cleanup_revision"
	reporting_cutover_require_archived_route_runtime "$revision" "$cleanup_revision"
	reporting_cutover_require_forward_scheduler_ready
	reporting_require_admin_audit_consumer_ready "$cleanup_revision"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	reporting_cutover_require_core_producer_continuity
	reporting_cutover_require_legacy_core_state_absent
	reporting_cutover_require_projection_barrier
	reporting_cutover_require_post_cleanup_queue_topology
	for pair in \
		"shadow:$(reporting_cutover_marker_value shadow_evidence_sha256)" \
		"scheduler:$(reporting_cutover_marker_value scheduler_evidence_sha256)" \
		"routes:$(reporting_cutover_marker_value route_evidence_sha256)" \
		"restore:$(reporting_cutover_marker_value restore_evidence_sha256)" \
		"cleanup-review:$(reporting_cutover_marker_value cleanup_review_evidence_sha256)" \
		"cleanup-manifest:$(reporting_cutover_marker_value cleanup_manifest_sha256)" \
		"source-cleanup:$(reporting_cutover_marker_value source_cleanup_evidence_sha256)" \
		"cleanup-restore:$cleanup_restore_sha"; do
		kind="${pair%%:*}"
		digest="${pair#*:}"
		reporting_cutover_require_archived_evidence "$kind" "$digest"
	done
	evidence="${REPORTING_COMPLETION_EVIDENCE_FILE:-}"
	[[ -n "$evidence" ]] || {
		echo 'REPORTING_COMPLETION_EVIDENCE_FILE is required.' >&2
		return 1
	}
	sha256="$(reporting_sha256_file "$evidence")"
	reporting_cutover_validate_completion_evidence \
		"$evidence" "$revision" "$cleanup_revision" "$switch_generation"
	reporting_cutover_require_stable_digest completion "$evidence" "$sha256"
	[[ "${CONFIRM_REPORTING_COMPLETE:-}" == \
		"complete:$revision:$cleanup_revision:$switch_generation:$sha256" ]] || {
		echo "Set CONFIRM_REPORTING_COMPLETE=complete:$revision:$cleanup_revision:$switch_generation:$sha256 after the final smoke, cleanup and rollback-image review." >&2
		return 1
	}
	reporting_cutover_archive_evidence completion "$evidence" "$sha256"
	source_sha="$(reporting_cutover_marker_value source_cleanup_evidence_sha256)"
	reporting_cutover_write_cleanup_state complete "$source_sha" "$cleanup_restore_sha" "$sha256"
	echo "Reporting cutover is complete at cleanup revision $cleanup_revision; future deploys must descend from it."
}

reporting_cutover_rollback_target_owner() {
	case "$1" in
	core-stopped) printf 'CORE_SHADOW\n' ;;
	target-owned) printf 'REPORTING\n' ;;
	*) return 1 ;;
	esac
}

reporting_cutover_rollback_routes() {
	local revision system_identifier snapshot_id backfill_sha shadow_sha
	local switch_generation
	reporting_cutover_require_phase routes-switched
	revision="$(reporting_cutover_marker_value revision)"
	[[ "${CONFIRM_REPORTING_ROUTE_ROLLBACK:-}" == "rollback-routes:$revision" ]] || {
		echo "Set CONFIRM_REPORTING_ROUTE_ROLLBACK=rollback-routes:$revision after the Gateway is returned to the exact dark manifest." >&2
		return 1
	}
	reporting_cutover_require_dark_gateway_runtime
	reporting_cutover_require_scheduler_disabled_runtime || {
		echo 'Disable the Reporting scheduler before reopening the pre-route boundary.' >&2
		return 1
	}
	reporting_cutover_require_switch_generation REPORTING
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
	backfill_sha="$(reporting_cutover_marker_value backfill_sha256)"
	shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_write_marker shadow-verified "$revision" "$system_identifier" \
		"$snapshot_id" "$backfill_sha" "$shadow_sha" target-owned \
		pending pending pending pending pending \
		"$switch_generation" pending pending pending pending pending
	echo 'Reporting public routes returned to the reviewed dark manifest. Scheduler/route/restore evidence was invalidated for this window; archived files remain for audit.'
}

reporting_cutover_rollback_scheduler() {
	local step revision previous_snapshot result snapshot_id sha256 core_result
	local system_identifier phase route_evidence target_owner core_owner
	local shadow_sha switch_generation
	reporting_cutover_validate_marker
	phase="$(reporting_cutover_marker_value phase)"
	case "$phase" in
	shadow-verified) ;;
	scheduler-switched)
		route_evidence="$(reporting_cutover_marker_value route_evidence_sha256)"
		[[ "$route_evidence" == 'pending' ]] || {
			echo 'Scheduler rollback is forbidden while public route evidence remains active.' >&2
			return 1
		}
		reporting_cutover_require_dark_gateway_runtime || return 1
		;;
	*)
		echo "Scheduler rollback is only safe before public routes switch, current phase=$phase." >&2
		return 1
		;;
	esac
	step="$(reporting_cutover_marker_value scheduler_step)"
	[[ "$step" == 'core-stopped' || "$step" == 'target-owned' ||
		"$step" == 'rollback-intent' ||
		"$step" == 'rollback-target-shadowed' ||
		"$step" == 'rollback-repair-backfilled' ]] || {
		echo "Scheduler rollback cannot resume from scheduler_step=$step." >&2
		return 1
	}
	revision="$(reporting_cutover_marker_value revision)"
	[[ "${CONFIRM_REPORTING_SCHEDULER_ROLLBACK:-}" == "rollback-scheduler:$revision" ]] || {
		echo "Set CONFIRM_REPORTING_SCHEDULER_ROLLBACK=rollback-scheduler:$revision for the reviewed pre-route rollback." >&2
		return 1
	}
	reporting_cutover_require_target_daily_summary_drained
	if [[ "$phase" == 'scheduler-switched' ]]; then
		system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
		snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
		sha256="$(reporting_cutover_marker_value backfill_sha256)"
		shadow_sha="$(reporting_cutover_marker_value shadow_evidence_sha256)"
		switch_generation="$(reporting_cutover_marker_value switch_generation)"
		reporting_cutover_write_marker shadow-verified "$revision" "$system_identifier" \
			"$snapshot_id" "$sha256" "$shadow_sha" target-owned \
			pending pending pending pending pending \
			"$switch_generation" pending pending pending pending pending
		phase='shadow-verified'
		step='target-owned'
	fi

	if [[ "$step" == 'core-stopped' || "$step" == 'target-owned' ]]; then
		target_owner="$(reporting_cutover_rollback_target_owner "$step")"
		reporting_cutover_schedule_authority_generation \
			REPORTING "$target_owner" >/dev/null
		reporting_cutover_require_telegram_topic_split "$target_owner"
		# The durable intent is written before either database is mutated. All
		# following checkpoints describe states that are safe to resume exactly.
		reporting_cutover_rewrite_scheduler_state rollback-intent
		step='rollback-intent'
	fi

	if [[ "$step" == 'rollback-intent' ]]; then
		core_owner="$(reporting_core_psql --tuples-only --no-align --command '
SELECT COALESCE((SELECT "daily_summary_owner" FROM "reporting_producer_state"
WHERE "id" = '"'"'singleton'"'"'), '"'"'missing'"'"');
')"
		target_owner="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT COALESCE((SELECT owner::TEXT FROM reporting.reporting_settings
WHERE id = 'daily-summary'), 'missing');
")"
		[[ "$core_owner" == 'REPORTING' &&
			( "$target_owner" == 'REPORTING' || "$target_owner" == 'CORE_SHADOW' ) ]] || {
			echo "Scheduler rollback intent found an unreconcilable owner pair: $core_owner|$target_owner" >&2
			return 1
		}
		reporting_cutover_schedule_authority_generation \
			REPORTING "$target_owner" >/dev/null
		# Restore the legacy Core scheduler time from the canonical reservation
		# while both schedulers are fenced. This transaction is idempotent.
		reporting_core_migration_psql --command '
BEGIN;
SET LOCAL lock_timeout = '"'"'30s'"'"';
SET LOCAL statement_timeout = '"'"'45s'"'"';
SELECT pg_advisory_xact_lock(hashtext('"'"'winwidget.reporting.daily-summary.owner.v1'"'"'));
SELECT "id" FROM "telegram_bot_settings"
WHERE "id" = '"'"'singleton'"'"' FOR UPDATE;
SELECT "daily_summary_schedule_time"
FROM "reporting_producer_state"
WHERE "id" = '"'"'singleton'"'"' FOR UPDATE;
UPDATE "telegram_bot_settings" settings
SET "daily_summary_time" = state."daily_summary_schedule_time",
    "updated_at" = clock_timestamp() AT TIME ZONE '"'"'UTC'"'"'
FROM "reporting_producer_state" state
WHERE settings."id" = '"'"'singleton'"'"'
  AND state."id" = '"'"'singleton'"'"'
  AND state."daily_summary_owner" = '"'"'REPORTING'"'"';
DO $schedule_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "reporting_producer_state" state
    JOIN "telegram_bot_settings" settings ON settings."id" = '"'"'singleton'"'"'
    WHERE state."id" = '"'"'singleton'"'"'
      AND state."daily_summary_owner" = '"'"'REPORTING'"'"'
      AND settings."daily_summary_time" = state."daily_summary_schedule_time"
  ) THEN
    RAISE EXCEPTION '"'"'Core Daily Summary schedule restoration failed'"'"';
  END IF;
END
$schedule_restore$;
COMMIT;
' >/dev/null
		# Restore the target to shadow first. Core stays stopped until a fresh
		# source snapshot has repaired changes ignored while Reporting was owner.
		reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --command "
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '45s';
SELECT id FROM reporting.reporting_settings
WHERE id = 'daily-summary' FOR UPDATE;
DO \$drain\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reporting.report_runs
    WHERE status IN (
      'PENDING'::reporting.\"ReportRunStatus\",
      'PROCESSING'::reporting.\"ReportRunStatus\",
      'WAITING_DELIVERY'::reporting.\"ReportRunStatus\"
    )
  ) OR EXISTS (
    SELECT 1 FROM reporting.outbox_events
    WHERE event_type = 'notification.daily-summary.telegram.requested.v1'
      AND status <> 'PUBLISHED'::reporting.\"ReportingOutboxStatus\"
  ) OR EXISTS (
    SELECT 1 FROM reporting.consumer_receipts
    WHERE consumer = 'reporting-delivery-outcome-v1'
      AND status IN (
        'PROCESSING'::reporting.\"ReportingConsumerReceiptStatus\",
        'RETRY_SCHEDULED'::reporting.\"ReportingConsumerReceiptStatus\"
      )
  ) THEN
    RAISE EXCEPTION 'Reporting Daily Summary work appeared before owner rollback';
  END IF;
END
\$drain\$;
UPDATE reporting.reporting_settings
SET owner = 'CORE_SHADOW'::reporting.\"ReportingOwner\",
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'daily-summary';
DO \$rollback\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reporting.reporting_settings
    WHERE id = 'daily-summary'
      AND owner = 'CORE_SHADOW'::reporting.\"ReportingOwner\"
  ) THEN
    RAISE EXCEPTION 'Reporting settings row is missing during scheduler rollback';
  END IF;
END
\$rollback\$;
COMMIT;
" >/dev/null
		reporting_cutover_require_target_daily_summary_drained
		reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		reporting_cutover_rewrite_scheduler_state rollback-target-shadowed
		step='rollback-target-shadowed'
	fi

	if [[ "$step" == 'rollback-target-shadowed' ]]; then
		reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		previous_snapshot="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT COALESCE((SELECT snapshot_id::TEXT FROM reporting.backfill_runs
WHERE status = 'VERIFIED'::reporting.\"ReportingBackfillStatus\"
ORDER BY verified_at DESC NULLS LAST LIMIT 1), 'none');
")"
		reporting_compose run --rm --no-deps \
			-e REPORTING_PROCESS_ROLE=backfill \
			--entrypoint node reporting-service dist/src/backfill/main.js
		result="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --field-separator='|' --command "
SELECT snapshot_id::TEXT, btrim(sha256)
FROM reporting.backfill_runs
WHERE status = 'VERIFIED'::reporting.\"ReportingBackfillStatus\"
  AND sha256 = expected_sha256
ORDER BY verified_at DESC NULLS LAST LIMIT 1;
")"
		IFS='|' read -r snapshot_id sha256 <<<"$result"
		[[ "$snapshot_id" =~ ^[0-9a-f-]{36}$ && "$snapshot_id" != "$previous_snapshot" &&
			"$sha256" =~ ^[0-9a-f]{64}$ ]] || {
			echo 'Scheduler rollback left Core stopped because the repair snapshot was not verified.' >&2
			return 1
		}
		reporting_cutover_rewrite_scheduler_state \
			rollback-repair-backfilled pending '' "$snapshot_id" "$sha256"
		step='rollback-repair-backfilled'
	fi

	if [[ "$step" == 'rollback-repair-backfilled' ]]; then
		snapshot_id="$(reporting_cutover_marker_value backfill_snapshot_id)"
		sha256="$(reporting_cutover_marker_value backfill_sha256)"
		result="$(reporting_database_psql REPORTING_DATABASE_URL --tuples-only --no-align --command "
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM reporting.backfill_runs
  WHERE snapshot_id = '$snapshot_id'::uuid
    AND status = 'VERIFIED'::reporting.\"ReportingBackfillStatus\"
    AND sha256 = '$sha256'
    AND expected_sha256 = '$sha256'
) THEN 'verified' ELSE 'invalid' END;
")"
		[[ "$result" == 'verified' ]] || {
			echo 'Durable scheduler rollback repair snapshot no longer verifies.' >&2
			return 1
		}
		core_owner="$(reporting_core_psql --tuples-only --no-align --command '
SELECT COALESCE((SELECT "daily_summary_owner" FROM "reporting_producer_state"
WHERE "id" = '"'"'singleton'"'"'), '"'"'missing'"'"');
')"
		case "$core_owner" in
		REPORTING)
			reporting_cutover_schedule_authority_generation REPORTING CORE_SHADOW >/dev/null
			;;
		CORE)
			reporting_cutover_schedule_authority_generation CORE CORE_SHADOW >/dev/null
			;;
		*)
			echo "Scheduler rollback checkpoint found an invalid Core owner: $core_owner" >&2
			return 1
			;;
		esac
		reporting_cutover_require_target_daily_summary_drained
		core_result="$(reporting_core_migration_psql --tuples-only --no-align --field-separator='|' <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('winwidget.reporting.daily-summary.owner.v1'));
SELECT "daily_summary_owner" FROM "reporting_producer_state"
WHERE "id" = 'singleton' FOR UPDATE;
UPDATE "reporting_producer_state"
SET "daily_summary_owner" = 'CORE',
    "daily_summary_switch_generation" = "daily_summary_switch_generation" + 1,
    "daily_summary_switched_at" = clock_timestamp() AT TIME ZONE 'UTC',
    "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE "id" = 'singleton' AND "daily_summary_owner" = 'REPORTING';
SELECT "daily_summary_owner", "daily_summary_switch_generation"::TEXT
FROM "reporting_producer_state" WHERE "id" = 'singleton';
COMMIT;
SQL
)"
		core_result="$(printf '%s\n' "$core_result" | grep -E '^CORE\|[1-9][0-9]*$' | tail -n 1)"
		[[ "$core_result" =~ ^CORE\|[1-9][0-9]*$ ]] || {
			echo 'Scheduler rollback repair snapshot is safe, but Core ownership was not restored.' >&2
			return 1
		}
		reporting_cutover_schedule_authority_generation CORE CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
		system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
		reporting_cutover_write_marker backfilled "$revision" "$system_identifier" \
			"$snapshot_id" "$sha256" pending pending pending pending pending pending pending \
			pending pending pending pending pending pending
		echo 'Daily Summary owner restored to Core after a verified repair snapshot. Re-run caught-up and shadow evidence before another switch.'
	fi
}

reporting_cutover_status() {
	reporting_cutover_validate_marker || {
		echo 'Reporting cutover marker is missing or invalid.' >&2
		return 1
	}
	cat "$REPORTING_CUTOVER_MARKER"
}

reporting_cutover_self_test() {
	local bootstrap_expected bootstrap_phase bootstrap_result bootstrap_state
	local claim_text dark_gateway_text drain_text evidence_text main_text rollback_text root marker revision
	local rollback_drain_text reporting_db_check_count notification_db_check_count
	local rollback_gate_count forward_projection_barrier_count claim_projection_barrier_count
	local cleanup_contract_text cleanup_topology_text complete_text evidence_actions_text validator_runtime_text
	local core_cleanup_backup_text
	local shadow_prepare_text shadow_runtime_text
	local projection_barrier_text
	local fenced_step fenced_marker stable_file stable_sha
	local cleanup_revision pre_cleanup_kinds post_cleanup_kinds
	local manifest_mutable_paths_actual mutable_paths_actual mutable_paths_expected
	reporting_cutover_self_test_projection_barrier_case() {
		[[ $# == 7 ]] || return 1
		local expected="$1" first_core="$2" second_core="$3"
		local queue_failure_call="$4" first_target="$5" second_target="$6"
		local fixture_root="$7"
		(
			local core_calls="$fixture_root/core-calls"
			local queue_calls="$fixture_root/queue-calls"
			local target_calls="$fixture_root/target-calls"
			: >"$core_calls"
			: >"$queue_calls"
			: >"$target_calls"
			reporting_cutover_marker_value() {
				case "$1" in
				phase) printf 'backfilled\n' ;;
				revision) printf '0123456789abcdef0123456789abcdef01234567\n' ;;
				*) return 1 ;;
				esac
			}
			reporting_require_core_producer_migration() { return 0; }
			reporting_require_core_producer_acl() { return 0; }
			reporting_require_outbox_publisher_ready() { return 0; }
			reporting_require_rabbitmq_topology() { return 0; }
			reporting_cutover_core_projection_barrier_state() {
				local call_count
				call_count="$(wc -c <"$core_calls" | tr -d '[:space:]')"
				printf x >>"$core_calls"
				if [[ "$call_count" == '0' ]]; then
					printf '%s\n' "$first_core"
				else
					printf '%s\n' "$second_core"
				fi
			}
			reporting_cutover_require_empty_projection_queues() {
				local call_count
				call_count="$(wc -c <"$queue_calls" | tr -d '[:space:]')"
				printf x >>"$queue_calls"
				[[ "$queue_failure_call" == '0' ||
					"$queue_failure_call" != "$((call_count + 1))" ]]
			}
			reporting_cutover_target_projection_barrier_state() {
				local call_count
				call_count="$(wc -c <"$target_calls" | tr -d '[:space:]')"
				printf x >>"$target_calls"
				if [[ "$call_count" == '0' ]]; then
					printf '%s\n' "$first_target"
				else
					printf '%s\n' "$second_target"
				fi
			}
			local actual='fail'
			if reporting_cutover_require_projection_barrier >/dev/null 2>&1; then
				actual='pass'
			fi
			[[ "$actual" == "$expected" ]] || return 1
			if [[ "$expected" == 'pass' ]]; then
				[[ "$(wc -c <"$core_calls" | tr -d '[:space:]')" == '2' &&
					"$(wc -c <"$queue_calls" | tr -d '[:space:]')" == '2' &&
					"$(wc -c <"$target_calls" | tr -d '[:space:]')" == '2' ]]
			fi
		)
	}
	root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-cutover.XXXXXX")"
	marker="$root/marker"
	revision='0123456789abcdef0123456789abcdef01234567'
	trap 'rm -rf -- "$root"' RETURN
	[[ "$REPORTING_EVIDENCE_ROOT" == "$APP_ROOT/deploy/backend/reporting-evidence" ]] || {
		echo 'Reporting cutover self-test accepted an ambient evidence archive path.' >&2
		return 1
	}
	(
		policy_calls="$root/route-policy-calls"
		reporting_cutover_marker_value() {
			[[ "$1" == 'route_evidence_sha256' ]] || return 1
			printf '%064d\n' 1
		}
		reporting_cutover_require_archived_evidence() { :; }
		reporting_cutover_evidence_path() { printf '%s\n' "$root/routes.json"; }
		reporting_cutover_require_archived_frontend_runtime_attestation() { :; }
		reporting_cutover_require_live_frontend_runtime() { :; }
		reporting_cutover_require_live_legacy_routes_retained() {
			printf 'retained:%s\n' "$1" >>"$policy_calls"
		}
		reporting_cutover_require_live_legacy_routes_absent() {
			printf 'absent:%s\n' "$1" >>"$policy_calls"
		}
		reporting_cutover_require_archived_route_runtime "$revision" "$revision"
		reporting_cutover_require_archived_route_runtime "$revision" \
			'89abcdef0123456789abcdef0123456789abcdef'
		[[ "$(cat "$policy_calls")" == \
			$'absent:0123456789abcdef0123456789abcdef01234567\nabsent:89abcdef0123456789abcdef0123456789abcdef' ]]
	) || {
		echo 'Reporting cutover self-test rejected the archived legacy route absence policy.' >&2
		return 1
	}
	stable_file="$root/stable-evidence.json"
	printf '{"version":1}\n' >"$stable_file"
	stable_sha="$(reporting_sha256_file "$stable_file")"
	reporting_cutover_require_stable_digest self-test "$stable_file" "$stable_sha"
	printf 'changed\n' >>"$stable_file"
	if reporting_cutover_require_stable_digest self-test \
		"$stable_file" "$stable_sha" >/dev/null 2>&1; then
		echo 'Reporting cutover self-test accepted evidence changed after validation.' >&2
		return 1
	fi
	local barrier_state='1|2|3|4|5|6|clear|ready'
	reporting_cutover_self_test_projection_barrier_case \
		pass "$barrier_state" "$barrier_state" 0 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail '1|2|3|4|5|clear|ready' "$barrier_state" 0 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail '1|2|x|4|5|6|clear|ready' "$barrier_state" 0 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail '1|2|3|4|5|6|pending|ready' "$barrier_state" 0 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail '1|2|3|4|5|6|clear|unsafe' "$barrier_state" 0 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail "$barrier_state" '1|2|3|4|5|7|clear|ready' 0 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail "$barrier_state" "$barrier_state" 1 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail "$barrier_state" "$barrier_state" 2 clear clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail "$barrier_state" "$barrier_state" 0 pending clear "$root"
	reporting_cutover_self_test_projection_barrier_case \
		fail "$barrier_state" "$barrier_state" 0 clear pending "$root"
	(
		local expected_checksum='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		local ledger_fixture topology_fixture
		reporting_cutover_core_cleanup_migration_name() {
			printf '20260801000000_remove_legacy_reporting_state\n'
		}
		reporting_cutover_core_cleanup_migration_checksum() {
			[[ "$1" == "$revision" &&
				"$2" == '20260801000000_remove_legacy_reporting_state' ]] || return 1
			printf '%s\n' "$expected_checksum"
		}
		reporting_settings_topology_mode() {
			[[ "$topology_fixture" != 'partial' ]] || return 1
			printf '%s\n' "$topology_fixture"
		}
		reporting_core_migration_psql() {
			[[ "$*" == *"checksum IS DISTINCT FROM '$expected_checksum'"* &&
				"$*" == *'finished_at IS NOT NULL AND rolled_back_at IS NULL'* &&
				"$*" == *'finished_at IS NULL AND rolled_back_at IS NULL'* ]] || return 1
			printf '%s\n' "$ledger_fixture"
		}
		topology_fixture='transition'
		ledger_fixture='0|0|0|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'pending' ]]
		# Exact-checksum rolled-back history produces the same active-ledger tuple
		# and is deliberately allowed before the one active attempt.
		ledger_fixture='0|0|1|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unfinished-transition' ]]
		topology_fixture='steady'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unfinished-steady' ]]
		ledger_fixture='0|1|0|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'applied' ]]
		topology_fixture='transition'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		ledger_fixture='1|0|0|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		ledger_fixture='0|2|0|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		ledger_fixture='0|0|2|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		ledger_fixture='0|1|1|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		ledger_fixture='0|0|0|unsafe'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		topology_fixture='steady'
		ledger_fixture='0|0|0|ready'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
		topology_fixture='partial'
		[[ "$(reporting_cutover_core_cleanup_migration_state "$revision")" == 'unsafe' ]]
	)
	(
		local migration_sha schema_sha row_anchor_sha row_content_sha sequence_sha zero_sha
		local fixture_expected_value mismatch_manifest fixture_revision
		fixture_revision="$revision"
		migration_sha="$(printf '%064x' 1)"
		schema_sha="$(printf '%064x' 2)"
		row_anchor_sha="$(printf '%064x' 3)"
		row_content_sha="$(printf '%064x' 4)"
		sequence_sha="$(printf '%064x' 5)"
		zero_sha="$(printf '%064x' 0)"
		fixture_expected_value="$migration_sha|$schema_sha"
		reporting_cutover_marker_value() {
			[[ "$1" == 'revision' ]] || return 1
			printf '%s\n' "$fixture_revision"
		}
		reporting_resolve_image_id_for_revision() {
			[[ "$1" == "$fixture_revision" ]] || return 1
			printf 'sha256:%064x\n' 6
		}
		reporting_run_isolated_node_validator() {
			printf '%s\n' "$fixture_expected_value"
		}
		reporting_core_migration_psql() {
			case "$*" in
			*'_prisma_migrations'*) printf 'migration|checksum\n' ;;
			*'information_schema.columns'*) printf 'table|column|1|text|NO\n' ;;
			*) return 1 ;;
			esac
		}
		reporting_sha256_file() {
			local manifest_name="${1##*/}"
			case "$manifest_name" in
			migrations.manifest) printf '%s\n' "$migration_sha" ;;
			schema.manifest) printf '%s\n' "$schema_sha" ;;
			rows.manifest) printf '%s\n' "$row_anchor_sha" ;;
			row-content.manifest) printf '%s\n' "$row_content_sha" ;;
			sequences.manifest) printf '%s\n' "$sequence_sha" ;;
			*) return 1 ;;
			esac
		}
		mismatch_manifest=''
		reporting_cutover_require_live_core_matches_backup_evidence \
			"$root/core-cleanup-backup.fixture.json" >/dev/null
		for mismatch_manifest in migrations.manifest schema.manifest; do
			case "$mismatch_manifest" in
			migrations.manifest)
				fixture_expected_value="$zero_sha|$schema_sha"
				;;
			schema.manifest)
				fixture_expected_value="$migration_sha|$zero_sha"
				;;
			esac
			if reporting_cutover_require_live_core_matches_backup_evidence \
				"$root/core-cleanup-backup.fixture.json" >/dev/null 2>&1; then
				echo "Reporting cutover self-test accepted a changed live Core $mismatch_manifest." >&2
				return 1
			fi
		done
		fixture_expected_value="$migration_sha|$schema_sha"
		reporting_cutover_require_live_core_matches_backup_evidence \
			"$root/core-cleanup-backup.fixture.json" >/dev/null
	)
	main_text="$(declare -f reporting_cutover_main)"
	local runtime_identity_text
	runtime_identity_text="$(declare -f reporting_cutover_export_pinned_runtime_identity)"
	evidence_text="$(declare -f reporting_cutover_validate_shadow_evidence reporting_cutover_validate_scheduler_evidence reporting_cutover_validate_gateway_manifest_value reporting_cutover_validate_route_evidence reporting_cutover_validate_restore_evidence)"
	evidence_actions_text="$(declare -f reporting_cutover_verify_shadow reporting_cutover_verify_scheduler reporting_cutover_verify_routes reporting_cutover_verify_restore reporting_cutover_stage_cleanup reporting_cutover_mark_source_cleaned reporting_cutover_verify_cleanup_restore reporting_cutover_complete)"
	shadow_prepare_text="$(declare -f reporting_cutover_prepare_shadow_evidence)"
	shadow_runtime_text="$(declare -f reporting_cutover_run_shadow_evidence_cli)"
	validator_runtime_text="$(declare -f reporting_resolve_image_id_for_revision reporting_run_isolated_node_validator)"
	cleanup_contract_text="$(declare -f reporting_cutover_validate_cleanup_contract reporting_cutover_require_cleanup_git_contract)"
	cleanup_migration_text="$(declare -f reporting_cutover_expected_cleanup_migration_sql reporting_cutover_require_exact_cleanup_migration)"
	cleanup_runtime_text="$(declare -f reporting_cutover_require_legacy_code_absent_from_image reporting_cutover_require_reporting_steady_runtime_contract reporting_cutover_require_cleanup_runtime_revision)"
	cleanup_topology_text="$(declare -f reporting_cutover_require_cleanup_legacy_drain_after_stop reporting_cutover_prepare_settings_topology_cleanup_after_stop)"
	core_cleanup_backup_text="$(declare -f reporting_cutover_core_content_manifest_sql reporting_cutover_core_migration_manifest_sql reporting_cutover_core_schema_manifest_sql reporting_cutover_core_row_anchor_manifest_sql reporting_cutover_core_sequence_manifest_sql reporting_cutover_core_backup_job_summary reporting_cutover_validate_core_cleanup_backup_evidence reporting_cutover_core_cleanup_migration_name reporting_cutover_core_cleanup_migration_checksum reporting_cutover_core_cleanup_migration_state reporting_cutover_require_core_cleanup_pending reporting_cutover_core_cleanup_resolve reporting_cutover_verify_core_cleanup_backup reporting_cutover_require_live_core_matches_backup_evidence reporting_cutover_require_core_cleanup_backup_archive_from_review reporting_cutover_require_core_cleanup_backup_from_review)"
	core_cleanup_resolve_text="$(declare -f reporting_cutover_core_cleanup_image_identity reporting_cutover_core_cleanup_stopped_exit_is_safe reporting_cutover_write_core_cleanup_stopped_writer_proof reporting_cutover_require_settings_topology_cleanup_converged_after_stop reporting_cutover_core_cleanup_resolve)"
	live_core_match_text="$(declare -f reporting_cutover_require_live_core_matches_backup_evidence)"
	legacy_state_text="$(declare -f reporting_cutover_require_legacy_core_state_absent)"
	route_runtime_text="$(declare -f reporting_cutover_validate_route_evidence reporting_cutover_route_evidence_identity reporting_cutover_validate_frontend_runtime_attestation reporting_cutover_require_live_frontend_runtime reporting_cutover_require_live_legacy_routes reporting_cutover_require_live_legacy_routes_retained reporting_cutover_require_live_legacy_routes_absent reporting_cutover_archive_frontend_runtime_attestation reporting_cutover_require_archived_frontend_runtime_attestation reporting_cutover_require_archived_route_runtime reporting_cutover_verify_routes)"
	complete_text="$(declare -f reporting_cutover_complete)"
	drain_text="$(declare -f reporting_cutover_require_legacy_daily_summary_drained)"
	claim_text="$(declare -f reporting_cutover_claim_scheduler_target)"
	projection_barrier_text="$(declare -f \
		reporting_cutover_core_projection_barrier_state \
		reporting_cutover_target_projection_barrier_state \
		reporting_cutover_require_projection_barrier)"
	rollback_drain_text="$(declare -f \
		reporting_cutover_require_reporting_runtime_stopped \
		reporting_cutover_validate_daily_summary_drain_values \
		reporting_cutover_reporting_daily_summary_database_state \
		reporting_cutover_notification_daily_summary_database_state \
		reporting_cutover_require_target_daily_summary_drained)"
	dark_gateway_text="$(declare -f reporting_cutover_require_dark_gateway_runtime)"
	rollback_text="$(declare -f reporting_cutover_rollback_scheduler)"
	reporting_db_check_count="$(printf '%s\n' "$rollback_drain_text" | awk \
		'/reporting_cutover_reporting_daily_summary_database_state/ { count += 1 } END { print count + 0 }')"
	notification_db_check_count="$(printf '%s\n' "$rollback_drain_text" | awk \
		'/reporting_cutover_notification_daily_summary_database_state/ { count += 1 } END { print count + 0 }')"
	rollback_gate_count="$(printf '%s\n' "$rollback_text" | awk \
		'/reporting_cutover_require_target_daily_summary_drained/ { count += 1 } END { print count + 0 }')"
	forward_projection_barrier_count="$(printf '%s\n' "$evidence_actions_text" | awk \
		'/reporting_cutover_require_projection_barrier/ { count += 1 } END { print count + 0 }')"
	claim_projection_barrier_count="$(printf '%s\n' "$claim_text" | awk \
		'/reporting_cutover_require_projection_barrier/ { count += 1 } END { print count + 0 }')"
	mutable_paths_actual="$(printf '%s\n' "${REPORTING_CLEANUP_MUTABLE_REPORTING_PATHS[@]}")"
	mutable_paths_expected=$'apps/reporting/src/messaging/reporting-messaging.constants.spec.ts\napps/reporting/src/messaging/reporting-messaging.constants.ts\napps/reporting/src/messaging/reporting-rabbitmq.service.spec.ts\napps/reporting/src/projections/projection.service.spec.ts\napps/reporting/src/projections/projection.service.ts\napps/reporting/src/projections/reporting-event.contract.spec.ts\napps/reporting/src/projections/reporting-event.contract.ts\napps/reporting/src/shadow-evidence/reporting-shadow-evidence.service.ts\napps/reporting/test/integration/reporting.integration.mjs'
	[[ "$mutable_paths_actual" == "$mutable_paths_expected" ]] || {
		echo 'Reporting cutover self-test found an unexpected mutable Reporting cleanup path set.' >&2
		return 1
	}
	manifest_mutable_paths_actual="$(printf '%s\n' "$cleanup_contract_text" | awk '
/^const modifiedReportingPaths = \[$/ { capture = 1; next }
capture && /^];$/ { exit }
capture {
  sub(/^[[:space:]]*"/, "")
  sub(/",?[[:space:]]*$/, "")
  print
}')"
	[[ "$manifest_mutable_paths_actual" == "$mutable_paths_expected" ]] || {
		echo 'Reporting cleanup manifest validator mutable path set is not exact.' >&2
		return 1
	}
	manifest_array_values() {
		local declaration="$1"
		printf '%s\n' "$cleanup_contract_text" | awk -v declaration="$declaration" '
$0 == "const " declaration " = [" { capture = 1; next }
capture && /^];$/ { exit }
capture {
  sub(/^[[:space:]]*"/, "")
  sub(/",?[[:space:]]*$/, "")
  print
}'
	}
	[[ "$(manifest_array_values modifiedCorePaths)" == \
		"$(printf '%s\n' "${REPORTING_CLEANUP_MUTABLE_CORE_PATHS[@]}")" &&
		"$(manifest_array_values modifiedControlPlanePaths)" == \
		"$(printf '%s\n' "${REPORTING_CLEANUP_MUTABLE_CONTROL_PLANE_PATHS[@]}")" &&
		"$(manifest_array_values addedControlPlanePaths)" == \
		"$(printf '%s\n' "${REPORTING_CLEANUP_ADDED_CONTROL_PLANE_PATHS[@]}")" ]] || {
		echo 'Reporting cleanup manifest validator Core/control-plane path sets are not exact.' >&2
		return 1
	}
	[[ "$main_text" == *'reporting_cutover_export_pinned_runtime_identity "$revision"'* &&
		"$main_text" == *'reporting_assert_no_ambient_compose_overrides'* &&
		"$main_text" == *'NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION'* &&
		"$main_text" == *'CAMPAIGNS_IMAGE CAMPAIGNS_REVISION'* &&
		"$main_text" == *'DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION'* &&
		"$main_text" == *'verify-core-cleanup-backup)'* &&
		"$main_text" == *'reporting_cutover_verify_core_cleanup_backup'* &&
		"$main_text" == *'prepare-core-cleanup-resolve)'* &&
		"$main_text" == *'reporting_cutover_core_cleanup_resolve prepare'* &&
		"$main_text" == *'resolve-core-cleanup-migration)'* &&
		"$main_text" == *'reporting_cutover_core_cleanup_resolve resolve'* &&
		"$main_text" == *'reporting_cutover_export_pinned_runtime_identity "$marker_revision"'* &&
		"$runtime_identity_text" == *'reporting_export_pinned_runtime_identity "$revision"'* &&
		"$runtime_identity_text" == *'DATABASE_RESTORE_REVISION="$revision"'* &&
		"$runtime_identity_text" == *'DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$revision"'* &&
		"$main_text" == *'stage-cleanup)'* &&
		"$main_text" == *'reporting_cutover_stage_cleanup'* &&
		"$main_text" == *'source-cleaned)'* &&
		"$main_text" == *'reporting_cutover_mark_source_cleaned'* &&
		"$main_text" == *'complete)'* &&
		"$main_text" == *'reporting_cutover_complete'* &&
		"$main_text" == *'prepare-shadow-evidence)'* &&
		"$main_text" == *'reporting_cutover_prepare_shadow_evidence'* &&
		"$evidence_text" == *'reporting_resolve_image_id_for_revision'* &&
		"$evidence_text" != *'reporting_get_env_value REPORTING_IMAGE'* &&
		"$evidence_text" != *'docker run'* &&
		"$validator_runtime_text" == *'org.opencontainers.image.revision'* &&
		"$validator_runtime_text" == *'--cap-drop ALL'* &&
		"$validator_runtime_text" == *'--security-opt no-new-privileges'* &&
		"$evidence_actions_text" == *'reporting_cutover_require_stable_digest shadow'* &&
		"$evidence_actions_text" == *'reporting_cutover_require_stable_digest completion'* &&
		"$shadow_prepare_text" == *'reporting_cutover_run_shadow_evidence_cli generate'* &&
		"$shadow_prepare_text" == *'reporting_cutover_run_shadow_evidence_cli verify'* &&
		"$shadow_prepare_text" == *'reporting_cutover_require_projection_barrier'* &&
		"$shadow_runtime_text" == *'REPORTING_DATABASE_URL="$backup_url"'* &&
		"$shadow_runtime_text" == *'REPORTING_IMAGE="$image_id"'* &&
		"$shadow_runtime_text" == *'-e REPORTING_DATABASE_URL'* &&
		"$shadow_runtime_text" != *'REPORTING_BACKUP_URL='* &&
		"$cleanup_contract_text" == *'diff-tree --no-commit-id --raw -r -z --no-renames'* &&
		"$cleanup_contract_text" == *'manifest.changedFiles'* &&
		"$cleanup_contract_text" == *'manifest.modifiedReportingPaths'* &&
		"$cleanup_contract_text" == *'manifest.modifiedCorePaths'* &&
		"$cleanup_contract_text" == *'manifest.modifiedControlPlanePaths'* &&
		"$cleanup_contract_text" == *'manifest.addedControlPlanePaths'* &&
		"$cleanup_contract_text" == *'changedFiles.some'* &&
		"$cleanup_contract_text" == *'REPORTING_CLEANUP_MUTABLE_CORE_PATHS'* &&
		"$cleanup_contract_text" == *'REPORTING_CLEANUP_MUTABLE_CONTROL_PLANE_PATHS'* &&
		"$cleanup_contract_text" == *'REPORTING_CLEANUP_ADDED_CONTROL_PLANE_PATHS'* &&
		"$cleanup_contract_text" == *'coreBackupEvidenceSha256'* &&
		"$cleanup_contract_text" == *'EXPECTED_CORE_BACKUP_SHA'* &&
		"$cleanup_contract_text" == *'REPORTING_CLEANUP_MUTABLE_REPORTING_PATHS'* &&
		"$cleanup_contract_text" == *'modified or removed immutable migration file'* &&
		"$cleanup_contract_text" == *'reporting_require_post_cleanup_revision_contract "$cleanup_revision"'* &&
		"$cleanup_contract_text" == *'reporting_cutover_require_exact_cleanup_migration'* &&
		"$cleanup_contract_text" == *'new_core_migration_count" == '\''1'\'''* &&
		"$cleanup_migration_text" == *'_remove_legacy_reporting_state'* &&
		"$cleanup_migration_text" == *'Legacy Reporting state is not drained'* &&
		"$cleanup_migration_text" == *'DROP COLUMN "daily_summary_last_sent_at"'* &&
		"$cleanup_runtime_text" == *'org.opencontainers.image.revision'* &&
		"$cleanup_runtime_text" == *'reporting_cutover_require_legacy_code_absent_from_image "$core_image_id"'* &&
		"$cleanup_runtime_text" == *'reporting_cutover_require_reporting_steady_runtime_contract'* &&
		"$cleanup_runtime_text" == *'REPORTING_ACCEPTED_ROUTING_KEYS.reportingSettings'* &&
		"$cleanup_runtime_text" == *'DELIVERY_OUTCOME_EVENT_TYPE !== deliveryOutcome'* &&
		"$cleanup_runtime_text" == *'REPORTING_ACCEPTED_ROUTING_KEYS.deliveryOutcome'* &&
		"$cleanup_runtime_text" == *'reporting.notification.delivery.outcome.v1'* &&
		"$cleanup_runtime_text" == *'/app/dist/src/statistics'* &&
		"$cleanup_runtime_text" == *'pathsContaining("daily-summary-delivery-telegram")'* &&
		"$cleanup_runtime_text" == *'JSON.stringify([])'* &&
		"$cleanup_runtime_text" == *'client.NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND'* &&
		"$cleanup_runtime_text" == *'expectedAdminKinds'* &&
		"$cleanup_runtime_text" == *'JSON.stringify(client.NOTIFICATION_DELIVERY_ADMIN_KINDS)'* &&
		"$cleanup_runtime_text" == *'/app/dist/src/messaging/notification-delivery-client.service.js'* &&
		"$cleanup_runtime_text" == *'pathsContaining("NOTIFICATION_DELIVERY_ADMIN_KINDS")'* &&
		"$cleanup_runtime_text" == *'/app/dist/src/messaging/messaging-admin.service.js'* &&
		"$cleanup_runtime_text" == *'daily-summary-job'* &&
		"$cleanup_topology_text" == *'reporting_cutover_require_target_daily_summary_drained'* &&
		"$cleanup_topology_text" == *'channel.unbindQueue'* &&
		"$cleanup_topology_text" == *'winwidget.reporting.settings.retry.$retry_index'* &&
		"$cleanup_topology_text" == *'REPORTING_OPERATIONAL_ROUTING_KEY'* &&
		"$core_cleanup_backup_text" == *'REPORTING_CORE_CLEANUP_BACKUP_JOB_ID'* &&
		"$core_cleanup_backup_text" == *'REPORTING_CORE_CLEANUP_BACKUP_MAX_AGE_SECONDS'* &&
		"$core_cleanup_backup_text" == *'winwidget-database-restore:git-$revision'* &&
		"$core_cleanup_backup_text" == *'--network none --read-only'* &&
		"$core_cleanup_backup_text" == *'--entrypoint pg_restore'* &&
		"$core_cleanup_backup_text" == *'core-cleanup-backup'* &&
		"$core_cleanup_backup_text" == *'createdAt < routeBoundary'* &&
		"$core_cleanup_backup_text" == *'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --data-checksums'* &&
		"$core_cleanup_backup_text" == *'COLLATE "C"'* &&
		"$core_cleanup_backup_text" == *'migrationManifestSha256'* &&
		"$core_cleanup_backup_text" == *'schemaManifestSha256'* &&
		"$core_cleanup_backup_text" == *'rowAnchorManifestSha256'* &&
		"$core_cleanup_backup_text" == *'rowContentManifestSha256'* &&
		"$core_cleanup_backup_text" == *'sequenceManifestSha256'* &&
		"$core_cleanup_backup_text" == *'to_jsonb(source_row)::TEXT'* &&
		"$core_cleanup_backup_text" == *'source_row.message_id = %L::UUID'* &&
		"$core_cleanup_backup_text" == *"source_row.payload ->> 'jobId' = %L"* &&
		"$core_cleanup_backup_text" == *"source_row.action = 'TELEGRAM_DATABASE_BACKUP_CREATE'"* &&
		"$core_cleanup_backup_text" == *'source_row.event_id = %L::UUID'* &&
		"$core_cleanup_backup_text" != *"tablename <> 'outbox_events'"* &&
		"$core_cleanup_backup_text" != *"tablename <> 'admin_event_logs'"* &&
		"$live_core_match_text" == *"compare_live_core_manifest 'migration manifest'"* &&
		"$live_core_match_text" == *"compare_live_core_manifest 'schema manifest'"* &&
		"$live_core_match_text" != *"compare_live_core_manifest 'row-anchor manifest'"* &&
		"$live_core_match_text" != *"compare_live_core_manifest 'row-content manifest'"* &&
		"$live_core_match_text" != *"compare_live_core_manifest 'sequence manifest'"* &&
		"$live_core_match_text" != *'rowAnchorManifestSha256'* &&
		"$live_core_match_text" != *'rowContentManifestSha256'* &&
		"$live_core_match_text" != *'sequenceManifestSha256'* &&
		"$live_core_match_text" != *'reporting_cutover_core_content_manifest_sql'* &&
		"$core_cleanup_backup_text" == *'reporting_cutover_require_live_core_matches_backup_evidence "$evidence" || return 1'* &&
		"$core_cleanup_backup_text" == *'cat-file blob'* &&
		"$core_cleanup_backup_text" == *'checksum IS DISTINCT FROM'*'$migration_checksum'* &&
		"$core_cleanup_backup_text" == *'finished_at IS NOT NULL AND rolled_back_at IS NULL'* &&
		"$core_cleanup_backup_text" == *'finished_at IS NULL AND rolled_back_at IS NULL'* &&
		"$core_cleanup_backup_text" == *"printf 'unfinished-transition\\n'"* &&
		"$core_cleanup_backup_text" == *"printf 'unfinished-steady\\n'"* &&
		"$core_cleanup_backup_text" != *'prisma migrate resolve'* &&
		"$core_cleanup_backup_text" == *'reporting_cutover_require_core_cleanup_pending'* &&
		"$core_cleanup_resolve_text" == *'resolve-core-cleanup:$original_revision:$cleanup_revision:$switch_generation:$state:$migration_name:$failed_migration_id:$migration_checksum:$core_image_digest:$image_migration_checksum:$ledger_proof_sha:$writer_proof_sha'* &&
		"$core_cleanup_resolve_text" == *'DATABASE_MIGRATION_URL_PRODUCTION'* &&
		"$core_cleanup_resolve_text" != *'DATABASE_URL_PRODUCTION'* &&
		"$core_cleanup_resolve_text" == *'winwidget-api:git-$cleanup_revision'* &&
		"$core_cleanup_resolve_text" == *'com.docker.compose.service=migrate'* &&
		"$core_cleanup_resolve_text" == *'--cap-drop ALL'* &&
		"$core_cleanup_resolve_text" == *'"--$resolution" "$migration_name"'* &&
		"$core_cleanup_resolve_text" == *'expected_post_state='\''pending'\'''* &&
		"$core_cleanup_resolve_text" == *'expected_post_state='\''applied'\'''* &&
		"$core_cleanup_resolve_text" == *'cleanupApiImageId'* &&
		"$core_cleanup_resolve_text" == *'imageMigrationChecksum'* &&
		"$core_cleanup_resolve_text" == *'State.ExitCode'* &&
		"$core_cleanup_resolve_text" == *'State.OOMKilled'* &&
		"$core_cleanup_resolve_text" == *'State.Error'* &&
		"$REPORTING_LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION" == '42c422ca4c2c3a8ce758a37773d6cb0e6b689db7' &&
		"$REPORTING_LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID" == 'sha256:e64d78b3dc511dde592641e979eb0b506b815f0e83c4eb943ac45b1780c3f554' &&
		"$core_cleanup_resolve_text" == *'writers.before-command.proof'* &&
		"$core_cleanup_resolve_text" == *'writers.after-command.proof'* &&
		"$core_cleanup_resolve_text" == *'resolve_rc=$?'* &&
		"$core_cleanup_resolve_text" == *'"version":2'* &&
		"$core_cleanup_resolve_text" == *'reporting_cutover_require_core_producer_continuity'* &&
		"$core_cleanup_resolve_text" == *'reporting_cutover_require_legacy_core_state_absent'* &&
		"$core_cleanup_resolve_text" == *'reporting_cutover_require_cleanup_legacy_drain_after_stop'* &&
		"$core_cleanup_resolve_text" == *'reporting_cutover_require_settings_topology_cleanup_converged_after_stop'* &&
		"$core_cleanup_resolve_text" == *'Core cleanup resolve ledger proof'* &&
		"$core_cleanup_resolve_text" == *'Core cleanup resolve stopped-writer proof'* &&
		"$core_cleanup_resolve_text" == *'same fresh verified backup/review'* &&
		"$core_cleanup_backup_text" == *'reporting_cutover_validate_core_cleanup_backup_evidence "$evidence" || return 1'* &&
		"$evidence_actions_text" == *'stage-cleanup:$revision:$cleanup_revision:$switch_generation:$core_sha:$review_sha:$manifest_sha'* &&
		"$evidence_actions_text" == *'Refreshing Core backup evidence cannot replace the pinned cleanup manifest'* &&
		"$legacy_state_text" == *'DAILY_TELEGRAM_SUMMARY'* &&
		"$legacy_state_text" == *'daily_summary_last_sent_period_start'* &&
		"$evidence_actions_text" == *'reporting_cutover_require_legacy_core_state_absent'* &&
		"$route_runtime_text" == *'frontendRuntimeAttestationSha256'* &&
		"$route_runtime_text" == *'frontendRuntimeSignatureSha256'* &&
		"$route_runtime_text" == *'frontendRuntimePublicKeySha256'* &&
		"$route_runtime_text" == *'frontendRuntimeChallenge'* &&
		"$route_runtime_text" == *'legacyStatisticsTombstoned'* &&
		"$route_runtime_text" == *'EXPECTED_LEGACY_POLICY'* &&
		"$route_runtime_text" == *'reporting_cutover_require_live_legacy_routes "$1" retained'* &&
		"$route_runtime_text" == *'reporting_cutover_require_live_legacy_routes "$1" absent'* &&
		"$route_runtime_text" == *'REPORTING_CUTOVER_ADMIN_ACCESS_TOKEN_FILE:-$APP_ROOT/deploy/backend/.reporting-cutover-admin-access-token'* &&
		"$route_runtime_text" == *'reporting_cutover_require_live_legacy_routes_absent "$runtime_revision"'* &&
		"$route_runtime_text" == *'reporting_cutover_require_live_legacy_routes_absent "$revision"'* &&
		"$route_runtime_text" != *'docker ps --no-trunc -q'* &&
		"$route_runtime_text" == *'Cross-VPS frontend runtime attestation, signature and public key must be absolute root-owned mode-600 regular files.'* &&
		"$route_runtime_text" == *'value.backendRevision !== process.env.EXPECTED_BACKEND_REVISION'* &&
		"$route_runtime_text" == *'value.switchGeneration !== process.env.EXPECTED_SWITCH_GENERATION'* &&
		"$route_runtime_text" == *'value.composeProject !== "winwidget"'* &&
		"$route_runtime_text" == *'value.contractScan !== true'* &&
		"$route_runtime_text" == *'value.challenge !== process.env.EXPECTED_CHALLENGE'* &&
		"$route_runtime_text" == *'openssl pkeyutl -verify'* &&
		"$route_runtime_text" == *'value.assetPath.split("/").includes("..")'* &&
		"$route_runtime_text" == *'Public frontend asset does not match the signed frontend runtime image.'* &&
		"$route_runtime_text" == *'ageMs > Number(process.env.MAX_AGE_SECONDS) * 1000'* &&
		"$route_runtime_text" == *'reporting_cutover_require_stable_digest frontend-runtime'* &&
		"$route_runtime_text" == *'reporting_cutover_archive_evidence frontend-runtime-attestation'* &&
		"$route_runtime_text" == *'reporting_cutover_require_archived_evidence'* &&
		"$route_runtime_text" == *'reporting_cutover_require_live_frontend_runtime "$evidence" "$revision" true'* &&
		"$complete_text" == *'reporting_cutover_require_post_cleanup_queue_topology'* ]] || {
		echo 'Reporting cutover self-test found an unsafe validator, evidence, cleanup or completion guard.' >&2
		return 1
	}
	[[ "$evidence_text" == *'"billing-payments", "/api/v1/payments"'* &&
		"$evidence_text" == *'"billing-subscriptions", "/api/v1/subscriptions"'* &&
		"$evidence_text" == *'"billing-tariff-prices", "/api/v1/tariff-prices"'* &&
		"$evidence_text" == *'"billing-affiliate", "/api/v1/affiliate"'* &&
		"$evidence_text" == *'route.upstreamUrl === "http://127.0.0.1:4800"'* &&
		"$evidence_text" == *'...(includeBilling ? billing : [])'* &&
		"$drain_text" == *'DAILY_TELEGRAM_SUMMARY'* &&
		"$drain_text" == *'"$base.retry-v2.$retry_index"'* &&
		"$drain_text" != *'"$base.retry.$retry_index"'* &&
		"$drain_text" == *'reporting_cutover_require_projection_barrier'* &&
		"$forward_projection_barrier_count" == '5' &&
		"$projection_barrier_text" == *"'identity.user.changed.v1'"* &&
		"$projection_barrier_text" == *"'billing.payment.changed.v1'"* &&
		"$projection_barrier_text" == *"'billing.subscription.changed.v1'"* &&
		"$projection_barrier_text" == *"'widgets.widget.changed.v1'"* &&
		"$projection_barrier_text" == *"'widgets.lead.changed.v1'"* &&
		"$projection_barrier_text" == *"'reporting.settings.changed.v1'"* &&
		"$projection_barrier_text" == *'"enabled" = TRUE'* &&
		"$projection_barrier_text" == *'"activated_at" IS NOT NULL'* &&
		"$projection_barrier_text" == *'jsonb_each_text(snapshot.watermarks)'* &&
		"$projection_barrier_text" == *'malformed_snapshot_watermark'* &&
		"$projection_barrier_text" == *'COALESCE(actual.source_sequence, 0) <> expected.source_sequence'* &&
		"$projection_barrier_text" == *'receipt.source_sequence = watermark.source_sequence'* &&
		"$projection_barrier_text" == *'reporting_require_core_producer_migration'* &&
		"$projection_barrier_text" == *'reporting_require_core_producer_acl'* &&
		"$projection_barrier_text" == *'reporting_require_outbox_publisher_ready "$active_revision"'* &&
		"$projection_barrier_text" == *'reporting_require_rabbitmq_topology'* &&
		"$projection_barrier_text" == *'"$second_state" == "$first_state"'* &&
		"$claim_projection_barrier_count" == '2' ]] || {
		echo 'Reporting cutover self-test found an incomplete projection or retry queue barrier.' >&2
		return 1
	}
	[[ "$rollback_drain_text" == *'Stop the main Reporting service before scheduler rollback'* &&
		"$rollback_drain_text" == *'Unable to verify that the Reporting runtime is stopped'* &&
		"$rollback_drain_text" == *'if ! container_id='* &&
		"$rollback_drain_text" == *"'PENDING'::reporting."* &&
		"$rollback_drain_text" == *"'WAITING_DELIVERY'::reporting."* &&
		"$rollback_drain_text" == *'ReportRunStatus'* &&
		"$rollback_drain_text" == *"'notification.daily-summary.telegram.requested.v1'"* &&
		"$rollback_drain_text" == *"'reporting-delivery-outcome-v1'"* &&
		"$rollback_drain_text" == *'NOTIFICATION_DELIVERY_DATABASE_URL'* &&
		"$rollback_drain_text" == *"'daily-summary-delivery-telegram'"* &&
		"$rollback_drain_text" == *"'notification.delivery.outcome.v1'"* &&
		"$rollback_drain_text" == *'rabbitmqctl --silent list_queues'* &&
		"$rollback_drain_text" != *'curl '* &&
		"$rollback_drain_text" == *'winwidget.notification.daily-summary.telegram.retry-v2.$retry_index'* &&
		"$rollback_drain_text" == *'winwidget.reporting.delivery-outcome.retry.$retry_index'* &&
		"$reporting_db_check_count" == '3' &&
		"$notification_db_check_count" == '3' ]] || {
		echo 'Reporting cutover self-test found an incomplete cross-database Daily Summary drain fence.' >&2
		return 1
	}
	[[ "$dark_gateway_text" == *'reporting_cutover_validate_gateway_manifest_value "$env_manifest" dark'* &&
		"$dark_gateway_text" == *'"$live_manifest" == "$env_manifest"'* &&
		"$rollback_text" == *'scheduler-switched)'* &&
		"$rollback_text" == *'"$route_evidence" == '\''pending'\'''* &&
		"$rollback_text" == *'reporting_cutover_require_dark_gateway_runtime'* &&
		"$rollback_text" == *'DO \$drain\$'* &&
		"$rollback_text" == *"'Reporting Daily Summary work appeared before owner rollback'"* &&
		"$rollback_gate_count" == '3' &&
		"$rollback_text" == *'reporting_cutover_write_marker backfilled'* ]] || {
		echo 'Reporting cutover self-test found an unsafe pre-route scheduler rollback path.' >&2
		return 1
	}
	reporting_cutover_validate_daily_summary_drain_values drained drained
	if reporting_cutover_validate_daily_summary_drain_values pending drained ||
		reporting_cutover_validate_daily_summary_drain_values drained pending; then
		echo 'Reporting cutover self-test accepted a partially drained scheduler rollback.' >&2
		return 1
	fi
	if (
		reporting_compose() { return 1; }
		reporting_cutover_require_reporting_runtime_stopped >/dev/null 2>&1
	); then
		echo 'Reporting cutover self-test accepted an unverifiable Reporting runtime fence.' >&2
		return 1
	fi
	(
		reporting_compose() { return 0; }
		reporting_cutover_require_reporting_runtime_stopped
	) || {
		echo 'Reporting cutover self-test rejected a confirmed stopped Reporting runtime.' >&2
		return 1
	}
	if (
		reporting_compose() { printf 'running-container\n'; }
		reporting_cutover_require_reporting_runtime_stopped >/dev/null 2>&1
	); then
		echo 'Reporting cutover self-test accepted a running Reporting runtime.' >&2
		return 1
	fi
	{
		printf 'version=1\nphase=preflight\nrevision=%s\n' "$revision"
		printf 'database_system_identifier=123456789\n'
		printf 'database_volume=%s\n' "$REPORTING_CANONICAL_POSTGRES_VOLUME"
		printf 'backfill_snapshot_id=pending\nbackfill_sha256=pending\n'
		printf 'shadow_evidence_sha256=pending\nscheduler_step=pending\n'
		printf 'scheduler_evidence_sha256=pending\n'
		printf 'route_evidence_sha256=pending\nrestore_evidence_sha256=pending\n'
		printf 'switch_generation=pending\n'
		printf 'cleanup_previous_revision=pending\ncleanup_revision=pending\n'
		printf 'cleanup_review_evidence_sha256=pending\n'
		printf 'cleanup_manifest_sha256=pending\ncleanup_restore_evidence_sha256=pending\n'
		printf 'source_cleanup_evidence_sha256=pending\n'
		printf 'completion_evidence_sha256=pending\n'
		printf 'updated_at=2026-07-31T00:00:00Z\n'
	} >"$marker"
	reporting_cutover_validate_marker_contents "$marker"
	REPORTING_CUTOVER_MARKER="$marker"
	# The static self-test also runs as an unprivileged developer. Production
	# ownership/mode checks remain in reporting_cutover_validate_marker; only
	# this temporary fixture substitutes the already-tested content validator.
	reporting_cutover_validate_marker() {
		reporting_cutover_validate_marker_contents "$REPORTING_CUTOVER_MARKER"
	}
	reporting_core_producer_bootstrap_state() {
		printf '%s\n' "$bootstrap_state"
	}
	for bootstrap_phase in absent preflight target-created roles-ready migrated producers-enabled; do
		case "$bootstrap_phase" in
		absent)
			REPORTING_CUTOVER_MARKER="$root/missing-marker"
			;;
		preflight)
			REPORTING_CUTOVER_MARKER="$marker"
			;;
		target-created | roles-ready | migrated | producers-enabled)
			sed "s/^phase=preflight$/phase=$bootstrap_phase/" \
				"$marker" >"$root/marker-$bootstrap_phase"
			REPORTING_CUTOVER_MARKER="$root/marker-$bootstrap_phase"
			;;
		esac
		for bootstrap_state in absent never-activated historical enabled; do
			bootstrap_expected='rejected'
			if [[ "$bootstrap_phase" != 'migrated' &&
				"$bootstrap_phase" != 'producers-enabled' &&
				( "$bootstrap_state" == 'absent' ||
					"$bootstrap_state" == 'never-activated' ) ]]; then
				bootstrap_expected='allowed'
			fi
			bootstrap_result='rejected'
			if reporting_cutover_allows_pre_audit_worker >/dev/null 2>&1; then
				bootstrap_result='allowed'
			fi
			if [[ "$bootstrap_result" != "$bootstrap_expected" ]]; then
				echo "Reporting audit bootstrap matrix failed: phase=$bootstrap_phase state=$bootstrap_state expected=$bootstrap_expected actual=$bootstrap_result." >&2
				return 1
			fi
		done
	done
	REPORTING_CUTOVER_MARKER="$marker"
	bootstrap_state='never-activated'
	reporting_cutover_worker_kinds_allowed current current pre-reporting
	reporting_cutover_worker_kinds_allowed pre-reporting current pre-reporting
	if reporting_cutover_worker_kinds_allowed missing-auto-renewal \
		current pre-reporting; then
		echo 'Reporting cutover self-test accepted a worker without auto-renewal.' >&2
		return 1
	fi
	if ! { [[ "$(reporting_cutover_runtime_scheduler_policy)" == 'disabled' &&
		"$(reporting_cutover_runtime_gateway_policy)" == 'dark' ]] &&
		reporting_cutover_scheduler_value_allowed disabled false &&
		! reporting_cutover_scheduler_value_allowed disabled true; }; then
		echo 'Reporting cutover self-test rejected the preflight runtime policy.' >&2
		return 1
	fi
	[[ "$(reporting_cutover_rollback_target_owner core-stopped)" == 'CORE_SHADOW' &&
		"$(reporting_cutover_rollback_target_owner target-owned)" == 'REPORTING' ]] || {
		echo 'Reporting cutover self-test rejected a valid scheduler rollback owner.' >&2
		return 1
	}
	if reporting_cutover_rollback_target_owner pending >/dev/null 2>&1; then
		echo 'Reporting cutover self-test accepted an invalid scheduler rollback step.' >&2
		return 1
	fi
	local chat_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	reporting_cutover_validate_telegram_topic_split_values \
		CORE_SHADOW "$chat_hash|2024" "$chat_hash|43|$chat_hash|2024"
	if reporting_cutover_validate_telegram_topic_split_values \
		CORE_SHADOW "$chat_hash|2024" "$chat_hash|2024|$chat_hash|2024"; then
		echo 'Reporting cutover self-test accepted one Telegram topic for both routes.' >&2
		return 1
	fi
	if reporting_cutover_validate_telegram_topic_split_values \
		CORE_SHADOW "$chat_hash|2024" \
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|43|$chat_hash|2024"; then
		echo 'Reporting cutover self-test accepted different Telegram chats.' >&2
		return 1
	fi
	if reporting_cutover_validate_telegram_topic_split_values \
		CORE_SHADOW "$chat_hash|2024" "$chat_hash|43|$chat_hash|2025"; then
		echo 'Reporting cutover self-test accepted a stale operational topic projection.' >&2
		return 1
	fi
	if reporting_cutover_validate_telegram_topic_split_values \
		CORE_SHADOW "$chat_hash|42" "$chat_hash|43|$chat_hash|42"; then
		echo 'Reporting cutover self-test accepted a non-canonical operational topic.' >&2
		return 1
	fi
	[[ "$(
		reporting_cutover_validate_schedule_authority_values \
			CORE CORE_SHADOW 'CORE|00:20|7' \
			'CORE_SHADOW|00:20|Europe/Moscow|0'
	)" == '7' ]]
	[[ "$(
		reporting_cutover_validate_schedule_authority_values \
			REPORTING REPORTING 'REPORTING|02:10|8' \
			'REPORTING|02:10|Europe/Moscow|8'
	)" == '8' ]]
	if reporting_cutover_validate_schedule_authority_values \
		REPORTING REPORTING 'REPORTING|02:10|8' \
		'REPORTING|02:11|Europe/Moscow|8' >/dev/null; then
		echo 'Reporting cutover self-test accepted different schedule times.' >&2
		return 1
	fi
	if reporting_cutover_validate_schedule_authority_values \
		REPORTING REPORTING 'REPORTING|02:10|8' \
		'REPORTING|02:10|Europe/Moscow|7' >/dev/null; then
		echo 'Reporting cutover self-test accepted a stale schedule generation.' >&2
		return 1
	fi
	if reporting_cutover_validate_schedule_authority_values \
		REPORTING REPORTING 'REPORTING|02:10|8' \
		'REPORTING|02:10|UTC|8' >/dev/null; then
		echo 'Reporting cutover self-test accepted a different schedule timezone.' >&2
		return 1
	fi
	reporting_cutover_validate_transition preflight target-created
	if reporting_cutover_validate_transition preflight roles-ready; then
		echo 'Reporting cutover self-test accepted a skipped phase.' >&2
		return 1
	fi
	printf 'unexpected=value\n' >>"$marker"
	if reporting_cutover_validate_marker_contents "$marker"; then
		echo 'Reporting cutover self-test accepted an unknown marker field.' >&2
		return 1
	fi
	sed -i.bak '/^unexpected=value$/d' "$marker"
	rm -f -- "$marker.bak"
	sed -i.bak \
		-e 's/^phase=preflight$/phase=shadow-verified/' \
		-e 's/^backfill_snapshot_id=pending$/backfill_snapshot_id=12345678-1234-4123-8123-123456789abc/' \
		-e 's/^backfill_sha256=pending$/backfill_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
		-e 's/^shadow_evidence_sha256=pending$/shadow_evidence_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' \
		-e 's/^scheduler_step=pending$/scheduler_step=target-owned/' \
		-e 's/^switch_generation=pending$/switch_generation=7/' \
		"$marker"
	rm -f -- "$marker.bak"
	if ! { [[ "$(reporting_cutover_runtime_scheduler_policy)" == 'transitional' &&
		"$(reporting_cutover_runtime_gateway_policy)" == 'dark' ]] &&
		reporting_cutover_scheduler_value_allowed transitional false &&
		reporting_cutover_scheduler_value_allowed transitional true; }; then
		echo 'Reporting cutover self-test rejected the owner hand-off policy.' >&2
		return 1
	fi
	for fenced_step in core-stopped target-claim-intent rollback-intent \
		rollback-target-shadowed rollback-repair-backfilled; do
		fenced_marker="$root/marker-$fenced_step"
		sed "s/^scheduler_step=target-owned$/scheduler_step=$fenced_step/" \
			"$marker" >"$fenced_marker"
		reporting_cutover_validate_marker_contents "$fenced_marker"
		REPORTING_CUTOVER_MARKER="$fenced_marker"
		if ! { [[ "$(reporting_cutover_runtime_scheduler_policy)" == 'fenced' ]] &&
			reporting_cutover_scheduler_value_allowed fenced false &&
			! reporting_cutover_scheduler_value_allowed fenced true; }; then
			echo "Reporting cutover self-test rejected fenced scheduler_step=$fenced_step." >&2
			return 1
		fi
	done
	fenced_marker="$root/marker-switch-intent"
	sed -e 's/^scheduler_step=target-owned$/scheduler_step=switch-intent/' \
		-e 's/^switch_generation=7$/switch_generation=pending/' \
		"$marker" >"$fenced_marker"
	reporting_cutover_validate_marker_contents "$fenced_marker"
	REPORTING_CUTOVER_MARKER="$fenced_marker"
	if ! { [[ "$(reporting_cutover_runtime_scheduler_policy)" == 'fenced' ]] &&
		reporting_cutover_scheduler_value_allowed fenced false &&
		! reporting_cutover_scheduler_value_allowed fenced true; }; then
		echo 'Reporting cutover self-test rejected fenced scheduler_step=switch-intent.' >&2
		return 1
	fi
	REPORTING_CUTOVER_MARKER="$marker"
	if reporting_cutover_allows_pre_audit_worker; then
		echo 'Reporting cutover self-test accepted a pre-audit worker after producer activation.' >&2
		return 1
	fi
	sed -i.bak \
		-e 's/^phase=shadow-verified$/phase=scheduler-switched/' \
		-e 's/^scheduler_evidence_sha256=pending$/scheduler_evidence_sha256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/' \
		"$marker"
	rm -f -- "$marker.bak"
	if ! { [[ "$(reporting_cutover_runtime_scheduler_policy)" == 'enabled' &&
		"$(reporting_cutover_runtime_gateway_policy)" == 'reporting' ]] &&
		reporting_cutover_scheduler_value_allowed enabled true &&
		! reporting_cutover_scheduler_value_allowed enabled false; }; then
		echo 'Reporting cutover self-test rejected the post-scheduler policy.' >&2
		return 1
	fi
	sed -i.bak \
		-e 's/^phase=scheduler-switched$/phase=routes-switched/' \
		-e 's/^route_evidence_sha256=pending$/route_evidence_sha256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/' \
		"$marker"
	rm -f -- "$marker.bak"
	reporting_cutover_validate_marker_contents "$marker"
	sed -i.bak \
		's/^restore_evidence_sha256=pending$/restore_evidence_sha256=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/' \
		"$marker"
	rm -f -- "$marker.bak"
	reporting_cutover_validate_marker_contents "$marker"
	sed 's/^phase=routes-switched$/phase=source-cleaned/' "$marker" >"$marker.invalid"
	if reporting_cutover_validate_marker_contents "$marker.invalid"; then
		echo 'Reporting cutover self-test accepted source cleanup without evidence.' >&2
		return 1
	fi
	cleanup_revision='89abcdef0123456789abcdef0123456789abcdef'
	sed \
		-e 's/^phase=routes-switched$/phase=cleanup-staged/' \
		-e "s/^cleanup_previous_revision=pending$/cleanup_previous_revision=$revision/" \
		-e "s/^cleanup_revision=pending$/cleanup_revision=$cleanup_revision/" \
		-e 's/^cleanup_review_evidence_sha256=pending$/cleanup_review_evidence_sha256=1111111111111111111111111111111111111111111111111111111111111111/' \
		-e 's/^cleanup_manifest_sha256=pending$/cleanup_manifest_sha256=2222222222222222222222222222222222222222222222222222222222222222/' \
		"$marker" >"$root/cleanup-marker"
	REPORTING_CUTOVER_MARKER="$root/cleanup-marker"
	reporting_cutover_validate_marker_contents "$REPORTING_CUTOVER_MARKER"
	pre_cleanup_kinds="$(reporting_normalize_integration_kinds \
		"$REPORTING_PRE_CLEANUP_INTEGRATION_WORKER_KINDS")"
	post_cleanup_kinds="$(reporting_normalize_integration_kinds \
		"$REPORTING_POST_CLEANUP_INTEGRATION_WORKER_KINDS")"
	reporting_cutover_worker_kinds_allowed \
		"$pre_cleanup_kinds" "$post_cleanup_kinds" pre-reporting
	if reporting_cutover_worker_kinds_allowed \
		unexpected "$post_cleanup_kinds" pre-reporting; then
		echo 'Reporting cleanup self-test accepted an unrelated integration-worker kind set.' >&2
		return 1
	fi
	sed \
		-e 's/^phase=cleanup-staged$/phase=source-cleaned/' \
		-e 's/^source_cleanup_evidence_sha256=pending$/source_cleanup_evidence_sha256=3333333333333333333333333333333333333333333333333333333333333333/' \
		"$REPORTING_CUTOVER_MARKER" >"$root/source-cleaned-marker"
	reporting_cutover_validate_marker_contents "$root/source-cleaned-marker"
	sed \
		-e 's/^phase=source-cleaned$/phase=complete/' \
		-e 's/^cleanup_restore_evidence_sha256=pending$/cleanup_restore_evidence_sha256=4444444444444444444444444444444444444444444444444444444444444444/' \
		-e 's/^completion_evidence_sha256=pending$/completion_evidence_sha256=5555555555555555555555555555555555555555555555555555555555555555/' \
		"$root/source-cleaned-marker" >"$root/complete-marker"
	reporting_cutover_validate_marker_contents "$root/complete-marker"
	trap - RETURN
	[[ "$root" == "${TMPDIR:-/tmp}/winwidget-reporting-cutover."* ]] || return 1
	rm -rf -- "$root"
	echo 'Reporting cutover phase ordering and marker contract verified.'
}

reporting_cutover_main() {
	local action="${1:-}" revision phase marker_revision cleanup_revision
	case "$action" in
	--self-test)
		[[ $# == 1 ]] || return 1
		reporting_cutover_self_test
		return
		;;
	status)
		[[ $# == 1 ]] || return 1
		reporting_cutover_status
		return
		;;
	initialize | backfill | caught-up | prepare-shadow-evidence | shadow-verified | \
		stop-core-scheduler | claim-scheduler | verify-scheduler | \
		routes-switched | restore-verified | rollback-routes | \
		rollback-scheduler | verify-core-cleanup-backup | stage-cleanup | \
		prepare-core-cleanup-resolve | resolve-core-cleanup-migration | source-cleaned | \
		cleanup-restore-verified | complete)
		[[ $# == 1 ]] || return 1
		;;
	advance)
		[[ $# == 2 ]] || return 1
		;;
	*)
		echo "Usage: EXPECTED_REVISION=<sha> $0 initialize | $0 advance target-created|roles-ready|migrated|producers-enabled | $0 backfill | $0 caught-up | $0 prepare-shadow-evidence | $0 shadow-verified | $0 stop-core-scheduler | $0 claim-scheduler | $0 verify-scheduler | $0 routes-switched | $0 restore-verified | $0 rollback-routes | $0 rollback-scheduler | $0 verify-core-cleanup-backup | $0 stage-cleanup | $0 prepare-core-cleanup-resolve | $0 resolve-core-cleanup-migration | $0 source-cleaned | $0 cleanup-restore-verified | $0 complete | $0 status | $0 --self-test" >&2
		return 1
		;;
	esac
	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting cutover lifecycle must run as root.' >&2
		return 1
	}
	revision="${EXPECTED_REVISION:-}"
	reporting_validate_production_files
	reporting_validate_exact_revision "$revision"
	reporting_cutover_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	acquire_production_deploy_lock "Reporting cutover $action"
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation \
		healthy-required "$REPORTING_ENV_FILE"
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
	if [[ "$action" != 'initialize' ]]; then
		reporting_cutover_validate_marker
		case "$action" in
		prepare-core-cleanup-resolve | resolve-core-cleanup-migration | \
		source-cleaned | cleanup-restore-verified | complete)
			[[ "$(reporting_cutover_marker_value cleanup_revision)" == "$revision" ]] || {
				echo 'Reporting cleanup action must run from the exact cleanup revision fixed in the durable marker.' >&2
				return 1
			}
			;;
		verify-core-cleanup-backup | stage-cleanup)
			marker_revision="$(reporting_cutover_marker_value revision)"
			if [[ "$(reporting_cutover_marker_value phase)" == 'cleanup-staged' ]]; then
				cleanup_revision="$(reporting_cutover_marker_value cleanup_revision)"
				[[ "$revision" == "$marker_revision" ||
					"$revision" == "$cleanup_revision" ]] || {
					echo 'Reporting cleanup evidence refresh must run from the original or exact staged cleanup revision.' >&2
					return 1
				}
			else
				[[ "$marker_revision" == "$revision" ]] || {
					echo 'Initial Reporting cleanup evidence must run from the original switched revision.' >&2
					return 1
				}
			fi
			if [[ "$revision" != "$marker_revision" ]]; then
				reporting_cutover_export_pinned_runtime_identity "$marker_revision"
			fi
			;;
		*)
			[[ "$(reporting_cutover_marker_value revision)" == "$revision" ]] || {
				echo 'Reporting cutover action must run from the original revision fixed in its durable marker.' >&2
				return 1
			}
			;;
		esac
		reporting_initialize_database_guard "Reporting cutover $action"
	fi
	case "$action" in
	initialize) reporting_cutover_initialize "$revision" ;;
	advance)
		[[ $# == 2 ]] || return 1
		phase="$2"
		case "$phase" in
		target-created)
			reporting_cutover_require_phase preflight
			reporting_cutover_verify_target_created
			;;
		roles-ready)
			reporting_cutover_require_phase target-created
			reporting_cutover_verify_roles_ready
			;;
		migrated)
			reporting_cutover_require_phase roles-ready
			reporting_cutover_verify_migrated
			;;
		producers-enabled)
			reporting_cutover_require_phase migrated
			reporting_cutover_verify_producers_enabled
			;;
		*) return 1 ;;
		esac
		;;
	backfill) reporting_cutover_run_backfill ;;
	caught-up) reporting_cutover_verify_caught_up ;;
	prepare-shadow-evidence) reporting_cutover_prepare_shadow_evidence ;;
	shadow-verified) reporting_cutover_verify_shadow ;;
	stop-core-scheduler) reporting_cutover_stop_core_scheduler ;;
	claim-scheduler) reporting_cutover_claim_scheduler_target ;;
	verify-scheduler) reporting_cutover_verify_scheduler ;;
	routes-switched) reporting_cutover_verify_routes ;;
	restore-verified) reporting_cutover_verify_restore ;;
	rollback-routes) reporting_cutover_rollback_routes ;;
	rollback-scheduler) reporting_cutover_rollback_scheduler ;;
	verify-core-cleanup-backup) reporting_cutover_verify_core_cleanup_backup ;;
	stage-cleanup) reporting_cutover_stage_cleanup ;;
	prepare-core-cleanup-resolve) reporting_cutover_core_cleanup_resolve prepare ;;
	resolve-core-cleanup-migration) reporting_cutover_core_cleanup_resolve resolve ;;
	source-cleaned) reporting_cutover_mark_source_cleaned ;;
	cleanup-restore-verified) reporting_cutover_verify_cleanup_restore ;;
	complete) reporting_cutover_complete ;;
	esac
	if [[ "$action" != 'initialize' ]]; then
		reporting_verify_database_lifecycle_unchanged
	fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	reporting_cutover_main "$@"
fi
