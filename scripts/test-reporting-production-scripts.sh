#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
server_root="$(cd -- "$script_directory/.." && pwd -P)"
app_root="$(cd -- "$server_root/.." && pwd -P)"

scripts=(
	"$script_directory/database-restore-production-guard.sh"
	"$script_directory/reporting-database-lifecycle.sh"
	"$script_directory/deploy-reporting-production.sh"
	"$script_directory/reporting-producer-lifecycle.sh"
	"$script_directory/reporting-cutover-lifecycle.sh"
	"$script_directory/generate-reporting-frontend-runtime-attestation.sh"
	"$script_directory/run-reporting-scheduler-cutover-smoke.sh"
	"$script_directory/run-reporting-route-cutover-smoke.sh"
	"$script_directory/run-reporting-restore-cutover-smoke.sh"
	"$script_directory/test-reporting-cutover-rehearsal.sh"
)

for script in "${scripts[@]}"; do
	[[ -f "$script" && ! -L "$script" ]] || {
		echo "Reporting production script is missing or unsafe: $script" >&2
		exit 1
	}
	bash -n "$script"
done
APP_ROOT="$app_root" \
	bash "$script_directory/database-restore-production-guard.sh" --self-test
printf 'database_restore_production_guard=passed\n'

for deployment_entrypoint in \
	"$script_directory/deploy-production.sh" \
	"$script_directory/deploy-notification-delivery-production.sh"; do
	bash -n "$deployment_entrypoint"
	entrypoint_text="$(<"$deployment_entrypoint")"
	[[ "$entrypoint_text" == *'source "$server_root/scripts/reporting-cutover-lifecycle.sh"'* &&
		"$entrypoint_text" == *'reporting_expected_integration_worker_kinds'* &&
		"$entrypoint_text" == *'pre_reporting_'* &&
		"$entrypoint_text" == *'reporting_cutover_worker_kinds_allowed'* ]] || {
		echo "Reporting audit-consumer bootstrap guard is missing from $deployment_entrypoint." >&2
		exit 1
	}
done
unset deployment_entrypoint entrypoint_text
printf 'reporting_audit_consumer_bootstrap_entrypoints=passed\n'

for deployment_entrypoint in \
	"$script_directory/deploy-maintenance-production.sh" \
	"$script_directory/deploy-notification-delivery-production.sh" \
	"$script_directory/deploy-campaigns-production.sh"; do
	entrypoint_text="$(<"$deployment_entrypoint")"
	[[ "$entrypoint_text" == *'source "$server_root/scripts/reporting-cutover-lifecycle.sh"'* &&
		"$entrypoint_text" == *'reporting_guard_before_checkout_revision "$deploy_revision"'* ]] || {
		echo "Reporting active-revision guard is missing from $deployment_entrypoint." >&2
		exit 1
	}
done
unset deployment_entrypoint entrypoint_text
printf 'reporting_active_revision_entrypoints=passed\n'

deploy_entrypoint_text="$(<"$script_directory/deploy-production.sh")"
[[ "$deploy_entrypoint_text" == *'reporting_validate_preflight_secret_isolation'* &&
	"$deploy_entrypoint_text" == *'reporting_transition_cleanup_integration_worker_env "$deploy_revision"'* &&
	"$deploy_entrypoint_text" == *'CORE_NOTIFICATION_DELIVERY_READINESS_KINDS=$(reporting_expected_core_notification_delivery_kinds)'* &&
	"$deploy_entrypoint_text" == *"'CORE_NOTIFICATION_DELIVERY_READINESS_KINDS',"* ]] || {
	echo 'Full deployment is missing the Reporting credential isolation gate.' >&2
	exit 1
}
reporting_runtime_guard="$(
	sed -n '/^verify_active_reporting_runtime()/,/^}/p' \
		"$script_directory/deploy-production.sh"
)"
reporting_runtime_capture_line="$(
	grep -n '^reporting_runtime_container_before=' \
		"$script_directory/deploy-production.sh" | cut -d: -f1
)"
notification_migration_line="$(
	grep -n '^verify_notification_delivery_migration_boundary$' \
		"$script_directory/deploy-production.sh" | cut -d: -f1
)"
[[ "$reporting_runtime_guard" == *'Reporting container identity changed during a full deployment.'* &&
	"$reporting_runtime_guard" == *'Reporting image identity changed during a full deployment.'* &&
	"$reporting_runtime_guard" == *'merge-base --is-ancestor'* &&
	"$reporting_runtime_guard" == *'"$app_revision" == "$image_revision"'* &&
	"$reporting_runtime_guard" == *'"$image_revision" "$REPORTING_REVISION"'* &&
	"$reporting_runtime_guard" != *'"$image_revision" == "$REPORTING_REVISION"'* &&
	"$reporting_runtime_capture_line" =~ ^[0-9]+$ &&
	"$notification_migration_line" =~ ^[0-9]+$ &&
	"$reporting_runtime_capture_line" -lt "$notification_migration_line" ]] || {
	echo 'Full deployment does not preserve and preflight the independent Reporting runtime identity.' >&2
	exit 1
}
unset reporting_runtime_guard reporting_runtime_capture_line notification_migration_line
unset deploy_entrypoint_text

lifecycle_script="$script_directory/reporting-database-lifecycle.sh"
lifecycle_text="$(<"$lifecycle_script")"
[[ "$lifecycle_text" == *'REPORTING_ENV_FILE="$REPORTING_APP_ROOT/deploy/backend/.env.production"'* &&
	"$lifecycle_text" == *'REPORTING_COMPOSE_FILE="$REPORTING_APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml"'* &&
	"$lifecycle_text" == *'REPORTING_DATABASE_MARKER="$REPORTING_APP_ROOT/deploy/backend/.reporting-database-lifecycle-v1"'* &&
	"$lifecycle_text" == *'REPORTING_FIRST_ROLLOUT_STAGED_MARKER="$REPORTING_APP_ROOT/deploy/backend/.reporting-first-rollout-staged-v1"'* &&
	"$lifecycle_text" != *'${ENV_FILE:-'* &&
	"$lifecycle_text" != *'${COMPOSE_FILE:-'* &&
	"$lifecycle_text" != *'${REPORTING_DATABASE_MARKER:-'* &&
	"$lifecycle_text" != *'${REPORTING_FIRST_ROLLOUT_STAGED_MARKER:-'* &&
	"$lifecycle_text" == *'reporting_transition_cleanup_integration_worker_env()'* &&
	"$lifecycle_text" == *'REPORTING_POST_CLEANUP_CORE_NOTIFICATION_DELIVERY_KINDS'* ]] || {
	echo 'Reporting lifecycle production paths are ambient-overridable.' >&2
	exit 1
}
ENV_FILE=/unsafe COMPOSE_FILE=/unsafe \
	REPORTING_DATABASE_MARKER=/unsafe \
	REPORTING_FIRST_ROLLOUT_STAGED_MARKER=/unsafe \
	APP_ROOT="$app_root" bash "$lifecycle_script" --self-test
unset lifecycle_script lifecycle_text
APP_ROOT="$app_root" bash "$script_directory/deploy-reporting-production.sh" --self-test
reporting_provision_source="$(
	sed -n '/^reporting_provision_initial_rabbitmq_user()/,/^}/p' \
		"$script_directory/deploy-reporting-production.sh"
)"
reporting_container_guard_line="$(printf '%s\n' "$reporting_provision_source" | grep -n 'ps -a -q reporting-service' | cut -d: -f1)"
reporting_exchange_guard_line="$(printf '%s\n' "$reporting_provision_source" | grep -n 'Shared Reporting RabbitMQ exchanges must exist' | cut -d: -f1)"
reporting_password_mutation_line="$(printf '%s\n' "$reporting_provision_source" | grep -n 'rabbitmqctl change_password' | cut -d: -f1)"
[[ "$reporting_container_guard_line" =~ ^[0-9]+$ &&
	"$reporting_exchange_guard_line" =~ ^[0-9]+$ &&
	"$reporting_password_mutation_line" =~ ^[0-9]+$ &&
	"$reporting_container_guard_line" -lt "$reporting_exchange_guard_line" &&
	"$reporting_exchange_guard_line" -lt "$reporting_password_mutation_line" ]] || {
	echo 'Initial Reporting RabbitMQ provisioning can mutate before container/exchange guards.' >&2
	exit 1
}
unset reporting_provision_source reporting_container_guard_line \
	reporting_exchange_guard_line reporting_password_mutation_line
printf 'reporting_rabbitmq_provisioning_order=passed\n'
reporting_topic_read_pattern='reporting\.(settings|core-operational-routing)\.changed\.v1'
standalone_permission_count="$(
	grep -Fc -- "$reporting_topic_read_pattern" \
		"$script_directory/deploy-reporting-production.sh"
)"
full_deploy_permission_count="$(
	grep -Fc -- "$reporting_topic_read_pattern" \
		"$script_directory/deploy-production.sh"
)"
ci_permission_count="$(
	grep -Fc -- "$reporting_topic_read_pattern" \
		"$server_root/.github/workflows/deploy-production.yml"
)"
[[ "$standalone_permission_count" -ge 2 &&
	"$full_deploy_permission_count" -ge 1 &&
	"$ci_permission_count" -ge 2 ]] || {
	echo 'Reporting operational-routing topic is missing from runtime or verification permissions.' >&2
	exit 1
}
unset reporting_topic_read_pattern standalone_permission_count \
	full_deploy_permission_count ci_permission_count
printf 'reporting_operational_routing_topic_permissions=passed\n'
APP_ROOT="$app_root" bash "$script_directory/reporting-producer-lifecycle.sh" --self-test
APP_ROOT="$app_root" bash "$script_directory/reporting-cutover-lifecycle.sh" --self-test
bash "$script_directory/generate-reporting-frontend-runtime-attestation.sh" --self-test
APP_ROOT="$app_root" \
	bash "$script_directory/run-reporting-scheduler-cutover-smoke.sh" --self-test
APP_ROOT="$app_root" \
	bash "$script_directory/run-reporting-route-cutover-smoke.sh" --self-test
APP_ROOT="$app_root" \
	bash "$script_directory/run-reporting-restore-cutover-smoke.sh" --self-test
bash "$script_directory/test-reporting-cutover-rehearsal.sh" --self-test

schedule_authority_service="$server_root/src/reporting-internal/reporting-schedule-authority.service.ts"
reporting_settings_service="$server_root/apps/reporting/src/settings/daily-summary-settings.service.ts"
reporting_scheduler_service="$server_root/apps/reporting/src/daily-summary/daily-summary-scheduler.service.ts"
telegram_service="$server_root/src/telegram-bot/telegram-bot.service.ts"
cutover_text="$(<"$script_directory/reporting-cutover-lifecycle.sh")"
[[ -f "$schedule_authority_service" &&
	"$(<"$schedule_authority_service")" == *'FOR UPDATE'* &&
	"$(<"$schedule_authority_service")" == *'ensureReportingBackupScheduleSeparated'* &&
	"$(<"$schedule_authority_service")" == *'REPORTING_DAILY_SUMMARY_SCHEDULE_REJECTED'* &&
	"$(<"$reporting_settings_service")" == *'scheduleGeneration'* &&
	"$(<"$reporting_settings_service")" == *'expectedScheduleGeneration'* &&
	"$(<"$reporting_settings_service")" == *'reserveDailySummarySchedulePolicy'* &&
	"$(<"$reporting_settings_service")" == *'confirmDailySummarySchedulePolicy'* &&
	"$(<"$reporting_scheduler_service")" == *'getSchedulerSettings()'* &&
	"$(<"$telegram_service")" == *'dailySummaryPolicyReservationGeneration'* &&
	"$(<"$telegram_service")" == *'ensureReportingBackupScheduleSeparated'* &&
	"$(<"$telegram_service")" != *'ensureDailySummaryBackupScheduleSeparated'* &&
	"$cutover_text" == *'reporting_cutover_schedule_authority_generation REPORTING REPORTING'* &&
	-f "$server_root/prisma/migrations/20260731030000_add_reporting_schedule_authority/migration.sql" &&
	-f "$server_root/apps/reporting/prisma/migrations/20260731020000_add_schedule_authority_generation/migration.sql" ]] || {
	echo 'Reporting/Core schedule authority is not wired through API, scheduler, migrations and cutover.' >&2
	exit 1
}
unset schedule_authority_service reporting_settings_service \
	reporting_scheduler_service telegram_service cutover_text
printf 'reporting_schedule_authority=passed\n'

workflow_file="$server_root/.github/workflows/deploy-production.yml"
[[ -f "$workflow_file" && ! -L "$workflow_file" ]] || {
	echo 'Production workflow is missing or unsafe.' >&2
	exit 1
}
package_file="$server_root/package.json"
[[ -f "$package_file" && ! -L "$package_file" &&
	"$(<"$package_file")" == *'"test:reporting-cutover-rehearsal": "bash scripts/test-reporting-cutover-rehearsal.sh"'* ]] || {
	echo 'Reusable Reporting cutover rehearsal command is missing.' >&2
	exit 1
}
workflow_text="$(<"$workflow_file")"
[[ "$(grep -Fc 'scripts/test-reporting-cutover-rehearsal.sh' "$workflow_file")" -ge 3 &&
	"$workflow_text" == *'bash scripts/test-reporting-cutover-rehearsal.sh --self-test'* ]] || {
	echo 'Reporting cutover rehearsal is missing from workflow syntax, shellcheck or static execution gates.' >&2
	exit 1
}
unset package_file workflow_text
printf 'reporting_cutover_rehearsal_workflow=passed\n'
workflow_exact_line_count() {
	local needle="$1"
	awk -v needle="$needle" '
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			sub(/[[:space:]]*$/, "", line)
			if (line == needle) count += 1
		}
		END { print count + 0 }
	' "$workflow_file"
}
fixed_substring_count() {
	local value="$1" needle="$2" remainder count=0
	[[ -n "$needle" ]] || return 1
	remainder="$value"
	while [[ "$remainder" == *"$needle"* ]]; do
		remainder="${remainder#*"$needle"}"
		count=$((count + 1))
	done
	printf '%s\n' "$count"
}
compact_workflow_text() {
	awk '
		{
			line = $0
			gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
			if (length(line) > 0) {
				if (printed) printf " "
				printf "%s", line
				printed = 1
			}
		}
		END { print "" }
	'
}
workflow_job_line() {
	local job="$1"
	awk -v needle="$job" '
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			sub(/[[:space:]]*$/, "", line)
			if (line == needle) {
				print NR
				exit
			}
		}
	' "$workflow_file"
}
lifecycle_checkout_preflight_job="$(sed -n '/^  lifecycle_checkout_preflight:/,/^  verify:/p' "$workflow_file")"
verify_header="$(sed -n '/^  verify:/,/^    services:/p' "$workflow_file")"
lifecycle_checkout_preflight_line="$(workflow_job_line 'lifecycle_checkout_preflight:')"
verify_job_line="$(workflow_job_line 'verify:')"
lifecycle_checkout_preflight_compact="$(printf '%s\n' "$lifecycle_checkout_preflight_job" | compact_workflow_text)"
verify_header_compact="$(printf '%s\n' "$verify_header" | compact_workflow_text)"
recovery_exclusion="!(github.event_name == 'workflow_dispatch' && inputs.deploy_target == 'reporting-cutover' && (inputs.reporting_cutover_action == 'status' || inputs.reporting_cutover_action == 'prepare-core-cleanup-resolve' || inputs.reporting_cutover_action == 'resolve-core-cleanup-migration'))"
[[ "$(workflow_exact_line_count 'lifecycle_checkout_preflight:')" == '1' &&
	"$(workflow_exact_line_count 'reporting_env_preflight:')" == '0' &&
	"$(workflow_exact_line_count 'verify:')" == '1' &&
	"$lifecycle_checkout_preflight_line" =~ ^[0-9]+$ &&
	"$verify_job_line" =~ ^[0-9]+$ &&
	"$lifecycle_checkout_preflight_line" -lt "$verify_job_line" &&
	"$lifecycle_checkout_preflight_job" == *'environment: production'* &&
	"$lifecycle_checkout_preflight_job" == *"(github.event_name == 'push' || github.event_name == 'workflow_dispatch')"* &&
	"$lifecycle_checkout_preflight_job" == *"inputs.reporting_database_action == 'status'"* &&
	"$lifecycle_checkout_preflight_job" == *"inputs.reporting_cutover_action == 'prepare-core-cleanup-resolve'"* &&
	"$lifecycle_checkout_preflight_job" == *"inputs.reporting_cutover_action == 'resolve-core-cleanup-migration'"* &&
	"$lifecycle_checkout_preflight_job" == *'guard_campaigns_checkout_before_pull "$current_revision"'* &&
	"$lifecycle_checkout_preflight_job" == *'guard_reporting_checkout_before_pull "$EXPECTED_REVISION"'* &&
	"$lifecycle_checkout_preflight_job" == *"AUTOMATIC_PROD_PUSH: \${{ github.event_name == 'push' && 'true' || 'false' }}"* &&
	"$lifecycle_checkout_preflight_job" == *'if [[ "$AUTOMATIC_PROD_PUSH" != "true" ||'* &&
	"$lifecycle_checkout_preflight_job" == *'"$current_revision" == "$EXPECTED_REVISION" ]]; then'* &&
	"$lifecycle_checkout_preflight_job" == *'Automatic push will verify before the deploy job evaluates the active Reporting revision guard.'* &&
	"$lifecycle_checkout_preflight_job" == *'local guard_action="${2:---guard-before-fetch-revision}"'* &&
	"$lifecycle_checkout_preflight_job" != *'git fetch '* &&
	"$lifecycle_checkout_preflight_job" != *'git checkout '* &&
	"$lifecycle_checkout_preflight_job" != *'git merge '* &&
	"$lifecycle_checkout_preflight_job" != *'docker '* &&
	"$lifecycle_checkout_preflight_job" == *'Validate Reporting production env before full verify'* &&
	"$lifecycle_checkout_preflight_job" == *"inputs.deploy_target == 'reporting-database'"* &&
	"$lifecycle_checkout_preflight_job" == *"inputs.reporting_database_action == 'prepare'"* &&
	"$lifecycle_checkout_preflight_job" == *"github.ref == 'refs/heads/prod'"* &&
	"$lifecycle_checkout_preflight_job" == *'"$(git rev-parse HEAD)" == "$EXPECTED_REVISION"'* &&
	"$lifecycle_checkout_preflight_job" == *'git status --porcelain --untracked-files=all'* &&
	"$lifecycle_checkout_preflight_job" == *'git hash-object "$tracked_file"'* &&
	"$lifecycle_checkout_preflight_job" == *'unset ENV_FILE COMPOSE_FILE REPORTING_DATABASE_MARKER'* &&
	"$lifecycle_checkout_preflight_job" == *'DATABASE_ACTION: ${{ inputs.reporting_database_action }}'* &&
	"$lifecycle_checkout_preflight_job" == *'preflight-env "$DATABASE_ACTION"'* &&
	"$verify_header" == *'needs: lifecycle_checkout_preflight'* &&
	"$verify_header" != *'reporting_env_preflight'* &&
	"$verify_header" == *'!cancelled()'* &&
	"$verify_header" == *"needs.lifecycle_checkout_preflight.result == 'success'"* &&
	"$verify_header" == *"inputs.reporting_database_action == 'status'"* &&
	"$verify_header" == *"inputs.reporting_cutover_action == 'status'"* &&
	"$verify_header" == *"inputs.reporting_cutover_action == 'prepare-core-cleanup-resolve'"* &&
	"$verify_header" == *"inputs.reporting_cutover_action == 'resolve-core-cleanup-migration'"* &&
	"$lifecycle_checkout_preflight_compact" == *"$recovery_exclusion"* &&
	"$verify_header_compact" == *"$recovery_exclusion"* &&
	"$(workflow_exact_line_count 'local guard_action="${2:---guard-before-fetch-revision}"')" == '6' &&
	"$(workflow_exact_line_count '"$guard_action" "$expected_revision"')" == '6' &&
	"$(grep -Fc 'unset ENV_FILE COMPOSE_FILE REPORTING_DATABASE_MARKER' "$workflow_file")" == '3' ]] || {
	echo 'Reporting protected env preflight is not an immutable fail-fast dependency of verify.' >&2
	exit 1
}
unset lifecycle_checkout_preflight_job verify_header \
	lifecycle_checkout_preflight_line verify_job_line \
	lifecycle_checkout_preflight_compact verify_header_compact recovery_exclusion
printf 'reporting_protected_env_preflight=passed\n'

reporting_status_job="$(sed -n '/^  reporting-database-status:/,/^  reporting-cutover-status:/p' "$workflow_file")"
[[ "$reporting_status_job" == *"inputs.reporting_database_action == 'status'"* &&
	"$reporting_status_job" == *'git status --porcelain --untracked-files=all'* &&
	"$reporting_status_job" == *'git hash-object "$lifecycle_script"'* &&
	"$reporting_status_job" == *'bash "$lifecycle_script" status'* &&
	"$reporting_status_job" != *'needs: verify'* &&
	"$reporting_status_job" != *'git fetch '* &&
	"$reporting_status_job" != *'git checkout '* &&
	"$reporting_status_job" != *'git merge '* &&
	"$reporting_status_job" != *'preflight-env'* &&
	"$reporting_status_job" != *' compose build '* ]] || {
	echo 'Reporting protected status path is not isolated from checkout, build and full verify.' >&2
	exit 1
}
unset reporting_status_job
printf 'reporting_protected_status=passed\n'

reporting_cutover_status_job="$(sed -n '/^  reporting-cutover-status:/,/^  reporting-cutover-verify-core-cleanup-backup:/p' "$workflow_file")"
[[ "$reporting_cutover_status_job" == *"inputs.reporting_cutover_action == 'status'"* &&
	"$reporting_cutover_status_job" == *'git status --porcelain --untracked-files=all'* &&
	"$reporting_cutover_status_job" == *'git hash-object "$lifecycle_script"'* &&
	"$reporting_cutover_status_job" == *'bash "$lifecycle_script" status'* &&
	"$reporting_cutover_status_job" != *'needs: verify'* &&
	"$reporting_cutover_status_job" != *'git fetch '* &&
	"$reporting_cutover_status_job" != *'git checkout '* &&
	"$reporting_cutover_status_job" != *'git merge '* &&
	"$reporting_cutover_status_job" != *'docker '* ]] || {
	echo 'Reporting cutover status is not an isolated trusted read-only action.' >&2
	exit 1
}
unset reporting_cutover_status_job
printf 'reporting_cutover_status=passed\n'

reporting_core_backup_job_line="$(workflow_job_line 'reporting-cutover-verify-core-cleanup-backup:')"
reporting_cleanup_resolve_job_line="$(workflow_job_line 'reporting-cutover-resolve-core-cleanup:')"
reporting_cleanup_stage_job_line="$(workflow_job_line 'reporting-cutover-stage-cleanup:')"
reporting_database_job_line="$(workflow_job_line 'reporting-database:')"
[[ "$(workflow_exact_line_count 'reporting-cutover-verify-core-cleanup-backup:')" == '1' &&
	"$(workflow_exact_line_count 'reporting-cutover-resolve-core-cleanup:')" == '1' &&
	"$(workflow_exact_line_count 'reporting-cutover-stage-cleanup:')" == '1' &&
	"$(workflow_exact_line_count 'reporting-database:')" == '1' &&
	"$reporting_core_backup_job_line" =~ ^[0-9]+$ &&
	"$reporting_cleanup_resolve_job_line" =~ ^[0-9]+$ &&
	"$reporting_cleanup_stage_job_line" =~ ^[0-9]+$ &&
	"$reporting_database_job_line" =~ ^[0-9]+$ &&
	"$reporting_core_backup_job_line" -lt "$reporting_cleanup_resolve_job_line" &&
	"$reporting_cleanup_resolve_job_line" -lt "$reporting_cleanup_stage_job_line" &&
	"$reporting_cleanup_stage_job_line" -lt "$reporting_database_job_line" ]] || {
	echo 'Reporting cleanup workflow job boundaries are missing, duplicated or out of order.' >&2
	exit 1
}
unset reporting_core_backup_job_line reporting_cleanup_resolve_job_line \
	reporting_cleanup_stage_job_line reporting_database_job_line

reporting_core_backup_job="$(sed -n '/^  reporting-cutover-verify-core-cleanup-backup:/,/^  reporting-cutover-resolve-core-cleanup:/p' "$workflow_file")"
[[ "$reporting_core_backup_job" == *'needs: verify'* &&
	"$reporting_core_backup_job" == *"inputs.reporting_cutover_action == 'verify-core-cleanup-backup'"* &&
	"$reporting_core_backup_job" == *'inputs.reporting_core_backup_job_id'* &&
	"$reporting_core_backup_job" == *'REPORTING_CORE_CLEANUP_BACKUP_JOB_ID="$BACKUP_JOB_ID"'* &&
	"$reporting_core_backup_job" == *'bash "$lifecycle_script" verify-core-cleanup-backup'* &&
	"$reporting_core_backup_job" == *'scripts/reporting-producer-lifecycle.sh'* &&
	"$reporting_core_backup_job" == *'scripts/core-database-production-guard.sh'* &&
	"$reporting_core_backup_job" == *'"$(git rev-parse HEAD)" == "$current_revision"'* &&
	"$reporting_core_backup_job" != *'git fetch '* &&
	"$reporting_core_backup_job" != *'git checkout '* &&
	"$reporting_core_backup_job" != *'git merge '* ]] || {
	echo 'Core cleanup backup workflow is not pinned to the exact durable job and current lifecycle.' >&2
	exit 1
}
unset reporting_core_backup_job
printf 'reporting_core_cleanup_backup_workflow=passed\n'

reporting_cleanup_resolve_job="$(sed -n '/^  reporting-cutover-resolve-core-cleanup:/,/^  reporting-cutover-stage-cleanup:/p' "$workflow_file")"
reporting_cleanup_resolve_job_compact="$(printf '%s\n' "$reporting_cleanup_resolve_job" | compact_workflow_text)"
cleanup_resolve_token_regex='^resolve-core-cleanup:[0-9a-f]{40}:[0-9a-f]{40}:[1-9][0-9]*:unfinished-(transition|steady):[0-9]{14}_remove_legacy_reporting_state:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}$'
cleanup_resolve_final_checkout_guard='[[ "$(git rev-parse HEAD)" == "$current_revision" && -z "$(git status --porcelain --untracked-files=all)" ]] || {'
[[ "$reporting_cleanup_resolve_job" != *$'\n    needs:'* &&
	"$reporting_cleanup_resolve_job" == *"github.event_name == 'workflow_dispatch'"* &&
	"$reporting_cleanup_resolve_job" == *"inputs.deploy_target == 'reporting-cutover'"* &&
	"$reporting_cleanup_resolve_job" == *"github.ref == 'refs/heads/prod'"* &&
	"$reporting_cleanup_resolve_job" == *'environment: production'* &&
	"$reporting_cleanup_resolve_job" == *"inputs.reporting_cutover_action == 'prepare-core-cleanup-resolve'"* &&
	"$reporting_cleanup_resolve_job" == *"inputs.reporting_cutover_action == 'resolve-core-cleanup-migration'"* &&
	"$reporting_cleanup_resolve_job" == *'CLEANUP_CONFIRMATION: ${{ inputs.reporting_cleanup_resolve_confirmation }}'* &&
	"$reporting_cleanup_resolve_job" == *'"$(id -u)" == '\''0'\'''* &&
	"$reporting_cleanup_resolve_job" == *'"$current_revision" =~ ^[0-9a-f]{40}$'* &&
	"$reporting_cleanup_resolve_job" == *'"$(git branch --show-current)" == '\''prod'\'''* &&
	"$reporting_cleanup_resolve_job" == *'lifecycle_script="scripts/reporting-cutover-lifecycle.sh"'* &&
	"$reporting_cleanup_resolve_job" == *'scripts/reporting-producer-lifecycle.sh'* &&
	"$reporting_cleanup_resolve_job" == *'scripts/reporting-database-lifecycle.sh'* &&
	"$reporting_cleanup_resolve_job" == *'scripts/production-deploy-lock.sh'* &&
	"$reporting_cleanup_resolve_job" == *'scripts/core-database-production-guard.sh'* &&
	"$reporting_cleanup_resolve_job" == *'deploy/docker-compose.prod.yml'* &&
	"$reporting_cleanup_resolve_job" == *'[[ -f "$tracked_file" && ! -L "$tracked_file" ]]'* &&
	"$reporting_cleanup_resolve_job" == *'tracked_blob="$(git rev-parse --verify "HEAD:$tracked_file")"'* &&
	"$reporting_cleanup_resolve_job" == *'git hash-object "$tracked_file"'* &&
	"$reporting_cleanup_resolve_job" == *'export CONFIRM_REPORTING_CORE_CLEANUP_RESOLVE="$cleanup_confirmation"'* &&
	"$reporting_cleanup_resolve_job" == *'bash "$lifecycle_script" "$CLEANUP_ACTION"'* &&
	"$reporting_cleanup_resolve_job" == *'confirmation_b64="$(printf '\''%s'\'' "$CLEANUP_CONFIRMATION" | base64 -w 0)"'* &&
	"$reporting_cleanup_resolve_job" == *"CONFIRMATION_B64='\$confirmation_b64'"* &&
	"$reporting_cleanup_resolve_job" == *'printf '\''%s'\'' "$CONFIRMATION_B64" | base64 --decode'* &&
	"$reporting_cleanup_resolve_job" == *'[[ -z "$CONFIRMATION_B64" ]] || exit 1'* &&
	"$(fixed_substring_count "$reporting_cleanup_resolve_job" "$cleanup_resolve_token_regex")" == '2' &&
	"$reporting_cleanup_resolve_job_compact" == *"$cleanup_resolve_final_checkout_guard"* &&
	"$reporting_cleanup_resolve_job" != *'git fetch '* &&
	"$reporting_cleanup_resolve_job" != *'git checkout '* &&
	"$reporting_cleanup_resolve_job" != *'git merge '* &&
	"$reporting_cleanup_resolve_job" != *'github.sha'* &&
	"$reporting_cleanup_resolve_job" != *'EXPECTED_CLEANUP_REVISION'* &&
	"$reporting_cleanup_resolve_job" != *'migrate resolve'* &&
	"$reporting_cleanup_resolve_job" != *'prisma migrate resolve'* &&
	"$reporting_cleanup_resolve_job" != *'build '* &&
	"$reporting_cleanup_resolve_job" != *'docker build '* &&
	"$reporting_cleanup_resolve_job" != *'docker compose build '* &&
	"$reporting_cleanup_resolve_job" != *'reporting_compose build '* ]] || {
	echo 'Core cleanup migration resolve workflow is not pinned to the exact reviewed proof and current lifecycle.' >&2
	exit 1
}
unset reporting_cleanup_resolve_job reporting_cleanup_resolve_job_compact \
	cleanup_resolve_token_regex cleanup_resolve_final_checkout_guard
printf 'reporting_core_cleanup_resolve_workflow=passed\n'

reporting_cleanup_stage_job="$(sed -n '/^  reporting-cutover-stage-cleanup:/,/^  reporting-database:/p' "$workflow_file")"
cleanup_stage_line() {
	local needle="$1"
	printf '%s\n' "$reporting_cleanup_stage_job" | awk -v needle="$needle" '
		index($0, needle) { print NR; exit }
	'
}
cleanup_lock_line="$(cleanup_stage_line 'acquire_production_deploy_lock "Reporting cleanup revision staging"')"
cleanup_pre_fetch_line="$(cleanup_stage_line '--guard-before-fetch-revision "$CLEANUP_REVISION"')"
cleanup_fetch_line="$(cleanup_stage_line 'git fetch origin prod')"
cleanup_exact_fetch_line="$(cleanup_stage_line '"$fetched_revision" == "$CLEANUP_REVISION"')"
cleanup_worktree_line="$(cleanup_stage_line 'git worktree add --detach "$candidate_root" "$CLEANUP_REVISION"')"
cleanup_source_line="$(cleanup_stage_line 'REPORTING_LIFECYCLE_SOURCE_ROOT="$candidate_root"')"
cleanup_action_line="$(cleanup_stage_line 'bash "$candidate_root/$cutover_lifecycle_script" stage-cleanup')"
cleanup_post_fetch_line="$(cleanup_stage_line '--guard-before-checkout-revision "$CLEANUP_REVISION"')"
[[ "$reporting_cleanup_stage_job" == *'needs: verify'* &&
	"$reporting_cleanup_stage_job" == *'stage-cleanup:[0-9a-f]{40}:[0-9a-f]{40}:[0-9]+:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}'* &&
	"$reporting_cleanup_stage_job" == *'REPORTING_CLEANUP_REVIEW_FILE="$review_file"'* &&
	"$reporting_cleanup_stage_job" == *'REPORTING_CLEANUP_MANIFEST_FILE="$manifest_file"'* &&
	"$reporting_cleanup_stage_job" == *'scripts/reporting-producer-lifecycle.sh'* &&
	"$reporting_cleanup_stage_job" == *'scripts/core-database-production-guard.sh'* &&
	"$reporting_cleanup_stage_job" == *'git worktree remove --force "$candidate_root"'* &&
	"$reporting_cleanup_stage_job" == *'hash-object --no-filters "$candidate_file"'* &&
	"$reporting_cleanup_stage_job" == *'"$(git rev-parse HEAD)" == "$current_revision"'* &&
	"$reporting_cleanup_stage_job" != *'git checkout '* &&
	"$reporting_cleanup_stage_job" != *'git merge --ff-only'* &&
	"$cleanup_lock_line" =~ ^[0-9]+$ && "$cleanup_pre_fetch_line" =~ ^[0-9]+$ &&
	"$cleanup_fetch_line" =~ ^[0-9]+$ && "$cleanup_exact_fetch_line" =~ ^[0-9]+$ &&
	"$cleanup_worktree_line" =~ ^[0-9]+$ && "$cleanup_source_line" =~ ^[0-9]+$ &&
	"$cleanup_action_line" =~ ^[0-9]+$ && "$cleanup_post_fetch_line" =~ ^[0-9]+$ &&
	"$cleanup_lock_line" -lt "$cleanup_pre_fetch_line" &&
	"$cleanup_pre_fetch_line" -lt "$cleanup_fetch_line" &&
	"$cleanup_fetch_line" -lt "$cleanup_exact_fetch_line" &&
	"$cleanup_exact_fetch_line" -lt "$cleanup_worktree_line" &&
	"$cleanup_worktree_line" -lt "$cleanup_source_line" &&
	"$cleanup_source_line" -lt "$cleanup_action_line" &&
	"$cleanup_action_line" -lt "$cleanup_post_fetch_line" ]] || {
	echo 'Reporting cleanup staging is not pinned under lock before any separate checkout.' >&2
	exit 1
}
unset reporting_cleanup_stage_job
printf 'reporting_cleanup_stage_workflow=passed\n'

reporting_database_job="$(sed -n '/^  reporting-database:/,$p' "$workflow_file")"
workflow_line() {
	local needle="$1"
	printf '%s\n' "$reporting_database_job" | awk -v needle="$needle" '
		index($0, needle) { print NR; exit }
	'
}
lock_line="$(workflow_line 'acquire_production_deploy_lock "Reporting database $DATABASE_ACTION"')"
lock_trust_line="$(workflow_line 'git rev-parse --verify "$EXPECTED_REVISION:$lock_script"')"
checkout_line="$(workflow_line 'checkout_verified_reporting_revision "$EXPECTED_REVISION"')"
pre_fetch_guard_line="$(workflow_line 'guard_reporting_checkout_before_pull "$expected_revision"')"
fetch_line="$(workflow_line 'git fetch origin prod')"
post_fetch_guard_line="$(workflow_line '"$expected_revision" --guard-before-checkout-revision')"
tracked_recheck_line="$(workflow_line 'git rev-parse --verify "$EXPECTED_REVISION:$tracked_file"')"
build_line="$(workflow_line 'build reporting-service')"
preflight_line="$(workflow_line 'bash "$lifecycle_script" preflight-env "$DATABASE_ACTION"')"
lifecycle_line="$(workflow_line 'bash "$lifecycle_script" "$DATABASE_ACTION"')"
[[ "$reporting_database_job" == *'git hash-object "$lock_script"'* &&
	"$reporting_database_job" == *"inputs.reporting_database_action == 'prepare'"* &&
	"$reporting_database_job" == *'unset ENV_FILE COMPOSE_FILE REPORTING_DATABASE_MARKER'* &&
	"$reporting_database_job" == *'export DATABASE_RESTORE_REVISION="$EXPECTED_REVISION"'* &&
	"$reporting_database_job" == *'export DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$EXPECTED_REVISION"'* &&
	"$lock_trust_line" =~ ^[0-9]+$ && "$lock_line" =~ ^[0-9]+$ &&
	"$checkout_line" =~ ^[0-9]+$ && "$pre_fetch_guard_line" =~ ^[0-9]+$ &&
	"$fetch_line" =~ ^[0-9]+$ && "$post_fetch_guard_line" =~ ^[0-9]+$ &&
	"$tracked_recheck_line" =~ ^[0-9]+$ &&
	"$preflight_line" =~ ^[0-9]+$ && "$build_line" =~ ^[0-9]+$ &&
	"$lifecycle_line" =~ ^[0-9]+$ &&
	"$lock_trust_line" -lt "$lock_line" &&
	"$lock_line" -lt "$pre_fetch_guard_line" &&
	"$pre_fetch_guard_line" -lt "$fetch_line" &&
	"$fetch_line" -lt "$post_fetch_guard_line" &&
	"$lock_line" -lt "$checkout_line" &&
	"$checkout_line" -lt "$tracked_recheck_line" &&
	"$tracked_recheck_line" -lt "$preflight_line" &&
	"$checkout_line" -lt "$build_line" &&
	"$checkout_line" -lt "$preflight_line" && "$preflight_line" -lt "$build_line" &&
	"$build_line" -lt "$lifecycle_line" ]] || {
	echo 'Reporting database workflow does not hold the production lock across checkout, build and lifecycle.' >&2
	exit 1
}
unset reporting_database_job
printf 'reporting_workflow_lock_order=passed\n'

printf 'reporting_production_scripts=passed\n'
