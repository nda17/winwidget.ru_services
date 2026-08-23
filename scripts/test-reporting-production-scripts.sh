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

(
	export APP_ROOT="$app_root"
	export REPORTING_LIFECYCLE_SOURCE_ROOT="$server_root"
	# shellcheck source=scripts/reporting-cutover-lifecycle.sh
	source "$script_directory/reporting-cutover-lifecycle.sh"
	# shellcheck source=scripts/identity-database-lifecycle.sh
	source "$script_directory/identity-database-lifecycle.sh"
	# shellcheck source=scripts/widgets-database-lifecycle.sh
	source "$script_directory/widgets-database-lifecycle.sh"
	reporting_widgets_ownership_marker_state() { printf 'active\n'; }
	current_worker_kinds="$(reporting_expected_integration_worker_kinds)"
	[[ "$current_worker_kinds" == "$IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" &&
		"$WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS" == \
			"$IDENTITY_STEADY_INTEGRATION_WORKER_KINDS" &&
		"$current_worker_kinds" == *'identity-admin-audit'* &&
		"$current_worker_kinds" != *'telegram-destination-unavailable'* ]]
	current_worker_kinds="$(reporting_normalize_integration_kinds "$current_worker_kinds")"
	reporting_cutover_worker_kinds_allowed \
		"$current_worker_kinds" "$current_worker_kinds" pre-reporting
) || {
	echo 'Post-Identity Notification Delivery worker ownership fixture failed.' >&2
	exit 1
}
printf 'reporting_identity_worker_ownership=passed\n'

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
	"$deploy_entrypoint_text" == *"'CORE_NOTIFICATION_DELIVERY_READINESS_KINDS',"* &&
	"$deploy_entrypoint_text" == *'prepare_reporting_outcome_route_cutover_after_stop'* &&
	"$deploy_entrypoint_text" == *'reporting.notification.delivery.outcome.v1'* &&
	"$deploy_entrypoint_text" == *'channel.unbindQueue('* &&
	"$deploy_entrypoint_text" == *'rabbitmqctl delete_queue'* &&
	"$deploy_entrypoint_text" == *'start_canonical_reporting_runtime "Reporting"'* ]] || {
	echo 'Full deployment is missing the Reporting credential or outcome-route gate.' >&2
	exit 1
}
reporting_start_function="$(
	sed -n '/^start_canonical_reporting_runtime()/,/^}/p' \
		"$script_directory/deploy-production.sh"
)"
reporting_finish_function="$(
	sed -n '/^finish_canonical_reporting_runtime()/,/^}/p' \
		"$script_directory/deploy-production.sh"
)"
reporting_diagnostics_function="$(
	sed -n '/^show_reporting_startup_diagnostics()/,/^}/p' \
		"$script_directory/deploy-production.sh"
)"
reporting_outcome_cutover_function="$(
	sed -n \
		'/^prepare_reporting_outcome_route_cutover_after_stop()/,/^routine_stop_services=/p' \
		"$script_directory/deploy-production.sh"
)"
reporting_routine_start_line="$(
	grep -n 'if ! start_canonical_reporting_runtime "Reporting"; then' \
		"$script_directory/deploy-production.sh" | cut -d: -f1
)"
reporting_routine_gateway_line="$(
	grep -n 'compose_target up -d --no-deps --force-recreate api-gateway' \
		"$script_directory/deploy-production.sh" | tail -1 | cut -d: -f1
)"
reporting_routine_finish_line="$(
	grep -n 'if ! finish_canonical_reporting_runtime "Reporting"; then' \
		"$script_directory/deploy-production.sh" | cut -d: -f1
)"
[[ "$reporting_start_function" == *'if ! compose_target up -d --no-deps --force-recreate reporting-service; then'* &&
	"$reporting_start_function" == *'show_reporting_startup_diagnostics'* &&
	"$reporting_finish_function" == *'if ! wait_for_cutover_revision'* &&
	"$reporting_finish_function" == *'show_reporting_startup_diagnostics'* &&
	"$reporting_finish_function" == *'provision_reporting_rabbitmq_topic_permissions "$reporting_user" steady'* &&
	"$reporting_diagnostics_function" == *'compose_target ps reporting-service rabbitmq'* &&
	"$reporting_diagnostics_function" == *'compose_target logs --tail=200 reporting-service'* &&
	"$reporting_outcome_cutover_function" == *'"$reporting_interrupted_routine_recovery" != '* &&
	"$reporting_outcome_cutover_function" == *'reporting_outcome_route_queues_are_empty true'* &&
	"$reporting_outcome_cutover_function" == *'"$queue" --if-empty --if-unused'* &&
	"$deploy_entrypoint_text" == *'detect_interrupted_reporting_outcome_deploy'* &&
	"$deploy_entrypoint_text" == *'reporting_interrupted_routine_recovery=true'* &&
	"$reporting_routine_start_line" =~ ^[0-9]+$ &&
	"$reporting_routine_gateway_line" =~ ^[0-9]+$ &&
	"$reporting_routine_finish_line" =~ ^[0-9]+$ &&
	"$reporting_routine_start_line" -lt "$reporting_routine_gateway_line" &&
	"$reporting_routine_gateway_line" -lt "$reporting_routine_finish_line" ]] || {
	echo 'Full deployment can strand canonical services on Reporting startup failure.' >&2
	exit 1
}
unset reporting_start_function reporting_finish_function
unset reporting_diagnostics_function reporting_outcome_cutover_function
unset reporting_routine_start_line
unset reporting_routine_gateway_line reporting_routine_finish_line
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
	echo 'Full deployment does not preflight and replace the canonical Reporting runtime safely.' >&2
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
deploy_controller_file="$server_root/.github/scripts/stage-or-deploy-backend.sh"
[[ -f "$deploy_controller_file" && ! -L "$deploy_controller_file" ]] || {
	echo 'Versioned production deploy controller is missing or unsafe.' >&2
	exit 1
}
deploy_remote_controller_file="$server_root/.github/scripts/stage-or-deploy-backend-remote.sh"
[[ -f "$deploy_remote_controller_file" && ! -L "$deploy_remote_controller_file" ]] || {
	echo 'Versioned production remote deploy controller is missing or unsafe.' >&2
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
deployment_exact_line_count() {
	local needle="$1"
	awk -v needle="$needle" '
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			sub(/[[:space:]]*$/, "", line)
			if (line == needle) count += 1
		}
		END { print count + 0 }
	' "$workflow_file" "$deploy_controller_file" "$deploy_remote_controller_file"
}

lifecycle_checkout_preflight_job="$(
	sed -n '/^  lifecycle_checkout_preflight:/,/^  verify:/p' "$workflow_file"
)"
verify_header="$(sed -n '/^  verify:/,/^    services:/p' "$workflow_file")"
deploy_job_header="$(
	sed -n '/^  deploy:/,$p' "$workflow_file"
)"
deploy_controller_checkout_line="$(
	grep -n -m1 -- '- name: Checkout deployment controller' "$workflow_file" | cut -d: -f1
)"
deploy_controller_run_line="$(
	grep -n -m1 -- 'run: bash .github/scripts/stage-or-deploy-backend.sh' "$workflow_file" | cut -d: -f1
)"
deploy_job="$deploy_job_header"$'\n'"$(sed 's/^/          /' "$deploy_controller_file")"$'\n'"$(sed 's/^/          /' "$deploy_remote_controller_file")"

[[
	"$(workflow_exact_line_count 'lifecycle_checkout_preflight:')" == '1' &&
	"$(workflow_exact_line_count 'verify:')" == '1' &&
	"$(workflow_exact_line_count 'deploy:')" == '1' &&
	"$(workflow_exact_line_count '- notification-delivery')" == '1' &&
	"$(workflow_exact_line_count '- campaigns')" == '1' &&
	"$(workflow_exact_line_count '- reporting')" == '1' &&
	"$(workflow_exact_line_count '- widgets')" == '1' &&
	"$lifecycle_checkout_preflight_job" == *'environment: production'* &&
	"$lifecycle_checkout_preflight_job" == *"(github.event_name == 'push' || github.event_name == 'workflow_dispatch')"* &&
	"$lifecycle_checkout_preflight_job" == *'guard_reporting_checkout_before_pull "$EXPECTED_REVISION"'* &&
	"$verify_header" == *'needs: lifecycle_checkout_preflight'* &&
	"$verify_header" == *"needs.lifecycle_checkout_preflight.result == 'success'"* &&
	"$deploy_job_header" == *'needs: verify'* &&
	"$deploy_job_header" == *'timeout-minutes: 90'* &&
	"$deploy_controller_checkout_line" =~ ^[0-9]+$ &&
	"$deploy_controller_run_line" =~ ^[0-9]+$ &&
	"$deploy_controller_checkout_line" -lt "$deploy_controller_run_line" &&
	"$((
		$(grep -Fc -- '-o ServerAliveInterval=15' "$workflow_file") +
			$(grep -Fc -- '-o ServerAliveInterval=15' "$deploy_controller_file")
	))" -ge 2 &&
	"$((
		$(grep -Fc -- '-o ServerAliveCountMax=4' "$workflow_file") +
			$(grep -Fc -- '-o ServerAliveCountMax=4' "$deploy_controller_file")
	))" -ge 2 &&
	"$((
		$(grep -Fc -- '-o TCPKeepAlive=yes' "$workflow_file") +
			$(grep -Fc -- '-o TCPKeepAlive=yes' "$deploy_controller_file")
	))" -ge 2 &&
	"$deploy_job" == *$'            notification-delivery)\n'* &&
	"$deploy_job" == *'bash scripts/deploy-notification-delivery-production.sh'* &&
	"$deploy_job" == *$'            campaigns)\n'* &&
	"$deploy_job" == *'bash scripts/deploy-campaigns-production.sh'* &&
	"$deploy_job" == *$'            reporting)\n'* &&
	"$deploy_job" == *'bash scripts/deploy-reporting-production.sh'* &&
	"$deploy_job" == *$'            widgets)\n'* &&
	"$deploy_job" == *'WIDGETS_FIRST_CUTOVER_APPROVED="$widgets_cutover_approved"'* &&
	"$deploy_job" == *'WIDGETS_FIRST_CUTOVER_CONFIRMATION="$WIDGETS_CUTOVER_CONFIRMATION"'* &&
	"$deploy_job" == *'if [[ "$WIDGETS_CUTOVER_CONFIRMATION" == '\''CUTOVER WIDGETS OWNERSHIP'\'' ]]; then'* &&
	"$deploy_job" == *'bash scripts/deploy-widgets-production.sh'*
]] || {
	echo 'Reporting is not wired through the common verified service deployment job.' >&2
	exit 1
}

for retired_line in \
	'- notification-delivery-database' \
	'- campaigns-database' \
	'campaigns_database_action:' \
	'notification-delivery-database:' \
	'campaigns-database:' \
	'- reporting-database' \
	'- reporting-cutover' \
	'reporting_database_action:' \
	'reporting_cutover_action:' \
	'reporting_core_backup_job_id:' \
	'reporting_cleanup_confirmation:' \
	'reporting_cleanup_resolve_confirmation:' \
	'reporting-database-status:' \
	'reporting-cutover-status:' \
	'reporting-cutover-verify-core-cleanup-backup:' \
	'reporting-cutover-resolve-core-cleanup:' \
	'reporting-cutover-stage-cleanup:' \
	'reporting-database:'; do
	[[ "$(deployment_exact_line_count "$retired_line")" == '0' ]] || {
		echo "Completed Reporting lifecycle action remains in the production workflow: $retired_line" >&2
		exit 1
	}
done
unset retired_line lifecycle_checkout_preflight_job verify_header deploy_job \
	deploy_job_header deploy_controller_file deploy_remote_controller_file \
	deploy_controller_checkout_line deploy_controller_run_line
printf 'reporting_steady_state_workflow=passed\n'

printf 'reporting_production_scripts=passed\n'
