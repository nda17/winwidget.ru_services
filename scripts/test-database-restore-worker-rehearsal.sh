#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
RUN_ID="${DATABASE_RESTORE_REHEARSAL_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
RESOURCE_PREFIX="winwidget-database-restore-rehearsal-$RUN_ID"
HOST_OS="$(uname -s)"
if [[ "$HOST_OS" == 'Darwin' ]]; then
	STATE_ROOT="$(cd "$SOURCE_ROOT/.." && pwd -P)"
else
	STATE_ROOT="$(cd /tmp && pwd -P)"
fi
APP_ROOT="$STATE_ROOT/$RESOURCE_PREFIX"
PG_CONTAINER="$RESOURCE_PREFIX-postgres"
WORKER_CONTAINER="$RESOURCE_PREFIX-worker"
UTILITY_CONTAINER="$RESOURCE_PREFIX-utility"
PG_VOLUME="$RESOURCE_PREFIX-postgres-data"
RESTORE_VOLUME="$RESOURCE_PREFIX-restore-storage"
RUNNER_IMAGE="winwidget-database-restore-rehearsal:$RUN_ID"
OWNER_LABEL='com.winwidget.rehearsal=database-restore-worker'
RUN_LABEL="com.winwidget.rehearsal.run-id=$RUN_ID"
STORAGE_PATH='/var/lib/winwidget-rehearsal/database-restores'
COMMAND_AUDIT_PATH="$STORAGE_PATH/command-audit.log"
QUEUE_SECRET='winwidget-database-restore-rehearsal-queue-secret-2026'
REQUESTED_BY='database-restore-rehearsal-dev'
MAX_UPLOAD_BYTES=$((49 * 1024 * 1024))
CORE_PORT=55434
NOTIFICATION_PORT=55432
CAMPAIGNS_PORT=55433
REPORTING_PORT=55435
WIDGETS_PORT=55436
BILLING_PORT=55437
IDENTITY_PORT=55438
PLATFORM_PORT=55439
SUPPORT_PORT=55440
OPERATIONS_PORT=55441
REVISION=''
HEAD_REVISION=''
SOURCE_HASH=''
SOURCE_STATE=''
DOCKER_BINARY=''
DOCKER_CONTEXT_NAME=''
DOCKER_CONTEXT_ENDPOINT=''
DOCKER_DAEMON_ID=''
CLEANUP_ARMED=0

BOOTSTRAP_PASSWORD='rehearsal_bootstrap_password_2026'
CORE_MIGRATION_PASSWORD='rehearsal_core_migration_password_2026'
NOTIFICATION_ADMIN_PASSWORD='rehearsal_notification_admin_password_2026'
NOTIFICATION_MIGRATION_PASSWORD='rehearsal_notification_migration_password_2026'
NOTIFICATION_RUNTIME_PASSWORD='rehearsal_notification_runtime_password_2026'
NOTIFICATION_BACKUP_PASSWORD='rehearsal_notification_backup_password_2026'
CAMPAIGNS_ADMIN_PASSWORD='rehearsal_campaigns_admin_password_2026'
CAMPAIGNS_MIGRATION_PASSWORD='rehearsal_campaigns_migration_password_2026'
CAMPAIGNS_RUNTIME_PASSWORD='rehearsal_campaigns_runtime_password_2026'
CAMPAIGNS_BACKUP_PASSWORD='rehearsal_campaigns_backup_password_2026'
REPORTING_ADMIN_PASSWORD='rehearsal_reporting_admin_password_2026'
REPORTING_MIGRATION_PASSWORD='rehearsal_reporting_migration_password_2026'
REPORTING_RUNTIME_PASSWORD='rehearsal_reporting_runtime_password_2026'
REPORTING_BACKUP_PASSWORD='rehearsal_reporting_backup_password_2026'
WIDGETS_ADMIN_PASSWORD='rehearsal_widgets_admin_password_2026'
WIDGETS_MIGRATION_PASSWORD='rehearsal_widgets_migration_password_2026'
WIDGETS_RUNTIME_PASSWORD='rehearsal_widgets_runtime_password_2026'
WIDGETS_BACKUP_PASSWORD='rehearsal_widgets_backup_password_2026'
BILLING_ADMIN_PASSWORD='rehearsal_billing_admin_password_2026'
BILLING_MIGRATION_PASSWORD='rehearsal_billing_migration_password_2026'
BILLING_RUNTIME_PASSWORD='rehearsal_billing_runtime_password_2026'
BILLING_BACKUP_PASSWORD='rehearsal_billing_backup_password_2026'
IDENTITY_ADMIN_PASSWORD='rehearsal_identity_admin_password_2026'
IDENTITY_MIGRATION_PASSWORD='rehearsal_identity_migration_password_2026'
IDENTITY_RUNTIME_PASSWORD='rehearsal_identity_runtime_password_2026'
IDENTITY_BACKUP_PASSWORD='rehearsal_identity_backup_password_2026'
PLATFORM_ADMIN_PASSWORD='rehearsal_platform_admin_password_2026'
PLATFORM_MIGRATION_PASSWORD='rehearsal_platform_migration_password_2026'
PLATFORM_RUNTIME_PASSWORD='rehearsal_platform_runtime_password_2026'
PLATFORM_BACKUP_PASSWORD='rehearsal_platform_backup_password_2026'
SUPPORT_ADMIN_PASSWORD='rehearsal_support_admin_password_2026'
SUPPORT_MIGRATION_PASSWORD='rehearsal_support_migration_password_2026'
SUPPORT_RUNTIME_PASSWORD='rehearsal_support_runtime_password_2026'
SUPPORT_BACKUP_PASSWORD='rehearsal_support_backup_password_2026'
OPERATIONS_ADMIN_PASSWORD='rehearsal_operations_admin_password_2026'
OPERATIONS_MIGRATION_PASSWORD='rehearsal_operations_migration_password_2026'
OPERATIONS_RUNTIME_PASSWORD='rehearsal_operations_runtime_password_2026'
OPERATIONS_BACKUP_PASSWORD='rehearsal_operations_backup_password_2026'

fail() {
	printf 'database_restore_rehearsal_error=%s\n' "$1" >&2
	exit 1
}

status() {
	printf 'database_restore_rehearsal_%s=passed\n' "$1"
}

file_size_bytes() {
	local size
	size="$(wc -c <"$1" | tr -d '[:space:]')"
	[[ "$size" =~ ^[0-9]+$ ]] || fail "cannot determine file size: $1"
	printf '%s' "$size"
}

sha256_file() {
	local checksum
	if command -v sha256sum >/dev/null 2>&1; then
		checksum="$(sha256sum "$1" | awk '{print $1}')"
	elif command -v shasum >/dev/null 2>&1; then
		checksum="$(shasum -a 256 "$1" | awk '{print $1}')"
	else
		fail 'sha256sum or shasum is required'
	fi
	[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || fail "cannot calculate SHA-256: $1"
	printf '%s' "$checksum"
}

sha256_stream() {
	local checksum
	if command -v sha256sum >/dev/null 2>&1; then
		checksum="$(sha256sum | awk '{print $1}')"
	elif command -v shasum >/dev/null 2>&1; then
		checksum="$(shasum -a 256 | awk '{print $1}')"
	else
		fail 'sha256sum or shasum is required'
	fi
	[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || fail 'cannot calculate source SHA-256'
	printf '%s' "$checksum"
}

portable_file_mode() {
	if [[ "$HOST_OS" == 'Darwin' ]]; then
		stat -f '%Lp' "$1"
	else
		stat -c '%a' "$1"
	fi
}

calculate_source_hash() {
	local head_revision="$1" relative_path mode checksum link_target
	{
		printf 'head\0%s\0tracked-diff\0' "$head_revision"
		git -C "$SOURCE_ROOT" diff --binary --full-index --no-ext-diff --no-textconv HEAD --
		printf '\0untracked-files\0'
		while IFS= read -r -d '' relative_path; do
			printf 'path\0%s\0' "$relative_path"
			if [[ -L "$SOURCE_ROOT/$relative_path" ]]; then
				link_target="$(readlink "$SOURCE_ROOT/$relative_path")"
				printf 'symlink\0%s\0' "$link_target"
			elif [[ -f "$SOURCE_ROOT/$relative_path" ]]; then
				mode="$(portable_file_mode "$SOURCE_ROOT/$relative_path")"
				checksum="$(sha256_file "$SOURCE_ROOT/$relative_path")"
				printf 'file\0%s\0%s\0' "$mode" "$checksum"
			else
				fail "unsupported untracked source entry: $relative_path"
			fi
		done < <(git -C "$SOURCE_ROOT" ls-files --others --exclude-standard -z)
	} | sha256_stream
}

source_state() {
	local first_untracked
	if ! git -C "$SOURCE_ROOT" diff --quiet --no-ext-diff HEAD --; then
		printf 'dirty'
		return
	fi
	first_untracked="$(git -C "$SOURCE_ROOT" ls-files --others --exclude-standard | sed -n '1p')"
	if [[ -n "$first_untracked" ]]; then
		printf 'dirty'
	else
		printf 'clean'
	fi
}

resolve_source_provenance() {
	HEAD_REVISION="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
	[[ "$HEAD_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail 'checkout revision is invalid'
	SOURCE_STATE="$(source_state)"
	SOURCE_HASH="$(calculate_source_hash "$HEAD_REVISION")"
	if [[ "$SOURCE_STATE" == 'clean' ]]; then
		REVISION="$HEAD_REVISION"
	else
		REVISION="${SOURCE_HASH:0:40}"
	fi
	[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || fail 'source revision is invalid'
}

assert_source_provenance_unchanged() {
	local current_head current_state current_hash
	current_head="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
	current_state="$(source_state)"
	current_hash="$(calculate_source_hash "$current_head")"
	[[ "$current_head" == "$HEAD_REVISION" &&
		"$current_state" == "$SOURCE_STATE" &&
		"$current_hash" == "$SOURCE_HASH" ]] ||
		fail 'source tree changed while the rehearsal image was being built'
}

target_database() {
	case "$1" in
	notification-delivery) printf 'winwidget_notification_delivery' ;;
	campaigns) printf 'winwidget_campaigns' ;;
	reporting) printf 'winwidget_reporting' ;;
	widgets) printf 'winwidget_widgets' ;;
	billing) printf 'winwidget_billing' ;;
	identity) printf 'winwidget_identity' ;;
	platform) printf 'winwidget_platform' ;;
	support) printf 'winwidget_support' ;;
	operations) printf 'winwidget_operations' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_schema() {
	case "$1" in
	notification-delivery) printf 'notification_delivery' ;;
	campaigns) printf 'campaigns' ;;
	reporting) printf 'reporting' ;;
	widgets) printf 'widgets' ;;
	billing) printf 'billing' ;;
	identity) printf 'identity' ;;
	platform) printf 'platform' ;;
	support) printf 'support' ;;
	operations) printf 'operations' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_admin_role() {
	case "$1" in
	notification-delivery) printf 'winwidget_notification_delivery_admin' ;;
	campaigns) printf 'winwidget_campaigns_admin' ;;
	reporting) printf 'winwidget_reporting_admin' ;;
	widgets) printf 'winwidget_widgets_admin' ;;
	billing) printf 'winwidget_billing_admin' ;;
	identity) printf 'winwidget_identity_admin' ;;
	platform) printf 'winwidget_platform_admin' ;;
	support) printf 'winwidget_support_admin' ;;
	operations) printf 'winwidget_operations_admin' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_migration_role() {
	case "$1" in
	notification-delivery) printf 'winwidget_notification_delivery_migration' ;;
	campaigns) printf 'winwidget_campaigns_migration' ;;
	reporting) printf 'winwidget_reporting_migration' ;;
	widgets) printf 'winwidget_widgets_migration' ;;
	billing) printf 'winwidget_billing_migration' ;;
	identity) printf 'winwidget_identity_migration' ;;
	platform) printf 'winwidget_platform_migration' ;;
	support) printf 'winwidget_support_migration' ;;
	operations) printf 'winwidget_operations_migration' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_runtime_role() {
	case "$1" in
	notification-delivery) printf 'winwidget_notification_delivery_runtime' ;;
	campaigns) printf 'winwidget_campaigns_runtime' ;;
	reporting) printf 'winwidget_reporting_runtime' ;;
	widgets) printf 'winwidget_widgets_runtime' ;;
	billing) printf 'winwidget_billing_runtime' ;;
	identity) printf 'winwidget_identity_runtime' ;;
	platform) printf 'winwidget_platform_runtime' ;;
	support) printf 'winwidget_support_runtime' ;;
	operations) printf 'winwidget_operations_runtime' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_backup_role() {
	case "$1" in
	notification-delivery) printf 'winwidget_notification_delivery_backup' ;;
	campaigns) printf 'winwidget_campaigns_backup' ;;
	reporting) printf 'winwidget_reporting_backup' ;;
	widgets) printf 'winwidget_widgets_backup' ;;
	billing) printf 'winwidget_billing_backup' ;;
	identity) printf 'winwidget_identity_backup' ;;
	platform) printf 'winwidget_platform_backup' ;;
	support) printf 'winwidget_support_backup' ;;
	operations) printf 'winwidget_operations_backup' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_port() {
	case "$1" in
	notification-delivery) printf '%s' "$NOTIFICATION_PORT" ;;
	campaigns) printf '%s' "$CAMPAIGNS_PORT" ;;
	reporting) printf '%s' "$REPORTING_PORT" ;;
	widgets) printf '%s' "$WIDGETS_PORT" ;;
	billing) printf '%s' "$BILLING_PORT" ;;
	identity) printf '%s' "$IDENTITY_PORT" ;;
	platform) printf '%s' "$PLATFORM_PORT" ;;
	support) printf '%s' "$SUPPORT_PORT" ;;
	operations) printf '%s' "$OPERATIONS_PORT" ;;
	*) fail "unknown target $1" ;;
	esac
}

target_confirmation() {
	case "$1" in
	notification-delivery) printf 'ВОССТАНОВИТЬ NOTIFICATION DELIVERY' ;;
	campaigns) printf 'ВОССТАНОВИТЬ CAMPAIGNS' ;;
	reporting) printf 'ВОССТАНОВИТЬ REPORTING' ;;
	widgets) printf 'ВОССТАНОВИТЬ WIDGETS' ;;
	billing) printf 'ВОССТАНОВИТЬ BILLING' ;;
	identity) printf 'ВОССТАНОВИТЬ IDENTITY' ;;
	platform) printf 'ВОССТАНОВИТЬ PLATFORM' ;;
	support) printf 'ВОССТАНОВИТЬ SUPPORT' ;;
	operations) printf 'ВОССТАНОВИТЬ OPERATIONS' ;;
	*) fail "unknown target $1" ;;
	esac
}

target_admin_password() {
	case "$1" in
	notification-delivery) printf '%s' "$NOTIFICATION_ADMIN_PASSWORD" ;;
	campaigns) printf '%s' "$CAMPAIGNS_ADMIN_PASSWORD" ;;
	reporting) printf '%s' "$REPORTING_ADMIN_PASSWORD" ;;
	widgets) printf '%s' "$WIDGETS_ADMIN_PASSWORD" ;;
	billing) printf '%s' "$BILLING_ADMIN_PASSWORD" ;;
	identity) printf '%s' "$IDENTITY_ADMIN_PASSWORD" ;;
	platform) printf '%s' "$PLATFORM_ADMIN_PASSWORD" ;;
	support) printf '%s' "$SUPPORT_ADMIN_PASSWORD" ;;
	operations) printf '%s' "$OPERATIONS_ADMIN_PASSWORD" ;;
	*) fail "unknown target $1" ;;
	esac
}

target_migration_password() {
	case "$1" in
	notification-delivery) printf '%s' "$NOTIFICATION_MIGRATION_PASSWORD" ;;
	campaigns) printf '%s' "$CAMPAIGNS_MIGRATION_PASSWORD" ;;
	reporting) printf '%s' "$REPORTING_MIGRATION_PASSWORD" ;;
	widgets) printf '%s' "$WIDGETS_MIGRATION_PASSWORD" ;;
	billing) printf '%s' "$BILLING_MIGRATION_PASSWORD" ;;
	identity) printf '%s' "$IDENTITY_MIGRATION_PASSWORD" ;;
	platform) printf '%s' "$PLATFORM_MIGRATION_PASSWORD" ;;
	support) printf '%s' "$SUPPORT_MIGRATION_PASSWORD" ;;
	operations) printf '%s' "$OPERATIONS_MIGRATION_PASSWORD" ;;
	*) fail "unknown target $1" ;;
	esac
}

target_runtime_password() {
	case "$1" in
	notification-delivery) printf '%s' "$NOTIFICATION_RUNTIME_PASSWORD" ;;
	campaigns) printf '%s' "$CAMPAIGNS_RUNTIME_PASSWORD" ;;
	reporting) printf '%s' "$REPORTING_RUNTIME_PASSWORD" ;;
	widgets) printf '%s' "$WIDGETS_RUNTIME_PASSWORD" ;;
	billing) printf '%s' "$BILLING_RUNTIME_PASSWORD" ;;
	identity) printf '%s' "$IDENTITY_RUNTIME_PASSWORD" ;;
	platform) printf '%s' "$PLATFORM_RUNTIME_PASSWORD" ;;
	support) printf '%s' "$SUPPORT_RUNTIME_PASSWORD" ;;
	operations) printf '%s' "$OPERATIONS_RUNTIME_PASSWORD" ;;
	*) fail "unknown target $1" ;;
	esac
}

target_backup_password() {
	case "$1" in
	notification-delivery) printf '%s' "$NOTIFICATION_BACKUP_PASSWORD" ;;
	campaigns) printf '%s' "$CAMPAIGNS_BACKUP_PASSWORD" ;;
	reporting) printf '%s' "$REPORTING_BACKUP_PASSWORD" ;;
	widgets) printf '%s' "$WIDGETS_BACKUP_PASSWORD" ;;
	billing) printf '%s' "$BILLING_BACKUP_PASSWORD" ;;
	identity) printf '%s' "$IDENTITY_BACKUP_PASSWORD" ;;
	platform) printf '%s' "$PLATFORM_BACKUP_PASSWORD" ;;
	support) printf '%s' "$SUPPORT_BACKUP_PASSWORD" ;;
	operations) printf '%s' "$OPERATIONS_BACKUP_PASSWORD" ;;
	*) fail "unknown target $1" ;;
	esac
}

target_migrations_directory() {
	case "$1" in
	notification-delivery) printf '%s/apps/notification-delivery/prisma/migrations' "$SOURCE_ROOT" ;;
	campaigns) printf '%s/apps/campaigns/prisma/migrations' "$SOURCE_ROOT" ;;
	reporting) printf '%s/apps/reporting/prisma/migrations' "$SOURCE_ROOT" ;;
	widgets) printf '%s/apps/widgets/prisma/migrations' "$SOURCE_ROOT" ;;
	billing) printf '%s/apps/billing/prisma/migrations' "$SOURCE_ROOT" ;;
	identity) printf '%s/apps/identity/prisma/migrations' "$SOURCE_ROOT" ;;
	platform) printf '%s/apps/platform/prisma/migrations' "$SOURCE_ROOT" ;;
	support) printf '%s/apps/support/prisma/migrations' "$SOURCE_ROOT" ;;
	operations) printf '%s/apps/operations/prisma/migrations' "$SOURCE_ROOT" ;;
	*) fail "unknown target $1" ;;
	esac
}

target_application_roles_sql() {
	case "$1" in
	notification-delivery) printf "'winwidget_notification_delivery_migration','winwidget_notification_delivery_runtime','winwidget_notification_delivery_backup'" ;;
	campaigns) printf "'winwidget_campaigns_migration','winwidget_campaigns_runtime','winwidget_campaigns_backup'" ;;
	reporting) printf "'winwidget_reporting_migration','winwidget_reporting_runtime','winwidget_reporting_backup'" ;;
	widgets) printf "'winwidget_widgets_migration','winwidget_widgets_runtime','winwidget_widgets_backup'" ;;
	billing) printf "'winwidget_billing_migration','winwidget_billing_runtime','winwidget_billing_backup'" ;;
	identity) printf "'winwidget_identity_migration','winwidget_identity_runtime','winwidget_identity_backup'" ;;
	platform) printf "'winwidget_platform_migration','winwidget_platform_runtime','winwidget_platform_backup'" ;;
	support) printf "'winwidget_support_migration','winwidget_support_runtime','winwidget_support_backup'" ;;
	operations) printf "'winwidget_operations_migration','winwidget_operations_runtime','winwidget_operations_backup'" ;;
	*) fail "unknown target $1" ;;
	esac
}

validate_static_inputs() {
	[[ "$RUN_ID" =~ ^[a-z0-9][a-z0-9_.-]{0,47}$ ]] ||
		fail 'DATABASE_RESTORE_REHEARSAL_RUN_ID must use 1-48 lowercase safe characters'
	[[ "$RUN_ID" != '.' && "$RUN_ID" != '..' ]] || fail 'unsafe rehearsal run id'
	case "$HOST_OS" in
	Linux)
		[[ "$STATE_ROOT" == '/tmp' ]] ||
			fail 'Linux rehearsal state root must resolve to /tmp'
		;;
	Darwin)
		[[ "$STATE_ROOT" == "$(cd "$SOURCE_ROOT/.." && pwd -P)" ]] ||
			fail 'macOS rehearsal state root escaped the shared workspace'
		;;
	*) fail 'unsupported rehearsal host operating system' ;;
	esac
	[[ "$APP_ROOT" == "$STATE_ROOT/winwidget-database-restore-rehearsal-$RUN_ID" ]] ||
		fail 'rehearsal root escaped its exact local namespace'
	[[ "$POSTGRES_IMAGE" =~ ^postgres:18-bookworm@sha256:[0-9a-f]{64}$ ]] ||
		fail 'PostgreSQL image must be an immutable PostgreSQL 18 digest'
	[[ -f "$SOURCE_ROOT/Dockerfile" && -f "$SOURCE_ROOT/database-restore-entrypoint.sh" ]] ||
		fail 'database restore build inputs are missing'
	for target in notification-delivery campaigns reporting widgets billing identity platform support operations; do
		[[ -d "$(target_migrations_directory "$target")" ]] ||
			fail "migration directory is missing for $target"
	done
}

self_test() {
	local source forbidden_env_file forbidden_database_url forbidden_server_root
	local forbidden_restore_storage forbidden_command_audit_env
	local raw_worker_exec
	local broad_system_cleanup broad_volume_cleanup broad_container_cleanup
	validate_static_inputs
	source="$(<"$SCRIPT_PATH")"
	forbidden_env_file=".env.$(printf production)"
	forbidden_database_url="DATABASE_URL_$(printf PRODUCTION)"
	forbidden_server_root="/opt/$(printf winwidget)"
	forbidden_restore_storage="/var/lib/winwidget/$(printf database-restores)"
	forbidden_command_audit_env="DATABASE_RESTORE_COMMAND_AUDIT_$(printf PATH)"
	raw_worker_exec="docker exec \"\$WORKER_$(printf CONTAINER)\""
	broad_system_cleanup="docker system $(printf prune)"
	broad_volume_cleanup="docker volume $(printf prune)"
	broad_container_cleanup="docker container $(printf prune)"
	[[ "$source" == *'DATABASE_RESTORE_PRODUCTION_ENABLED=true'* &&
		"$source" == *'MODE=production'* &&
		"$source" == *'DatabaseRestoreQueueService'* &&
		"$source" == *'DATABASE_RESTORE_PRODUCTION_PERMIT'* &&
		"$source" == *'parseAndVerifyDatabaseRestorePublishReceipt'* &&
		"$source" == *'receipt_pending_zero_postgres_commands'* &&
		"$source" == *'COMMAND_AUDIT_PATH="$STORAGE_PATH/command-audit.log"'* &&
		"$source" == *'docker exec --user 1001:1001 "$WORKER_CONTAINER"'* &&
		"$source" == *'exact_publication_retry'* &&
		"$source" == *'publication_grace_no_spurious_orphan'* &&
		"$source" == *'locks/global.lock'* &&
		"$source" == *'DUMP_TARGET_MISMATCH'* &&
		"$source" == *'FAILED_FENCED'* &&
		"$source" == *'SAFETY_CREATED'* &&
		"$source" == *"application_name = 'winwidget-database-restore-worker'"* &&
		"$source" == *"query LIKE '%restore_rehearsal_slow%'"* &&
		"$source" == *"{{.State.Paused}}"* &&
		"$source" == *'--cap-add KILL'* &&
		"$source" == *'safety_backup_restore_'* &&
		"$source" == *'identity_core_source_removed'* &&
		"$source" == *'platform_rehearsal_contract'* &&
		"$source" == *'platform_cleanup_terminal_contract'* &&
		"$source" == *'winwidget.platform_pristine_replay%3Dapproved-nonproduction-replay'* &&
		"$source" == *"DATABASE_RESTORE_PLATFORM_PORT=\"\$PLATFORM_PORT\""* &&
		"$source" == *'DATABASE_RESTORE_PLATFORM_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/platform-admin-password'* &&
		"$source" == *"platform) printf 'ВОССТАНОВИТЬ PLATFORM'"* &&
		"$source" == *"platform) printf '%s/apps/platform/prisma/migrations'"* &&
		"$source" == *"VALUES ('canonical', 'baseline-platform')"* &&
			"$source" == *'producer_contract_version'* &&
			"$source" == *'source_sequence_scope'* &&
		"$source" == *'expected_platform_core_acl'* &&
		"$source" == *'run_successful_restore platform'* &&
		"$source" == *'independent_catalog_acl_matrix'* &&
		"$source" == *"relation.relname <> ALL(ARRAY['_prisma_migrations', 'operations_ownership_state'])"* &&
		"$source" == *'future_function_default_acl_'* &&
		"$source" == *'pg_default_acl'* &&
		"$source" == *'backup_reconnect_dump'* &&
		"$source" == *"DATABASE_RESTORE_SUPPORT_PORT=\"\$SUPPORT_PORT\""* &&
		"$source" == *'DATABASE_RESTORE_SUPPORT_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/support-admin-password'* &&
		"$source" == *"support) printf 'ВОССТАНОВИТЬ SUPPORT'"* &&
		"$source" == *"support) printf '%s/apps/support/prisma/migrations'"* &&
		"$source" == *"VALUES ('canonical', 'baseline-support')"* &&
		"$source" == *'run_successful_restore support'* &&
		"$source" == *"DATABASE_RESTORE_OPERATIONS_PORT=\"\$OPERATIONS_PORT\""* &&
		"$source" == *'DATABASE_RESTORE_OPERATIONS_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/operations-admin-password'* &&
		"$source" == *"operations) printf 'ВОССТАНОВИТЬ OPERATIONS'"* &&
		"$source" == *"operations) printf '%s/apps/operations/prisma/migrations'"* &&
		"$source" == *"VALUES ('canonical', 'baseline-operations')"* &&
		"$source" == *"SET \"phase\" = 'ACTIVE'::operations.\"OperationsDatabasePhase\""* &&
		"$source" == *'run_successful_restore operations'* &&
		"$source" == *'database_restore_'* &&
		"$source" == *'docker() {'* &&
		"$source" == *'--context "$DOCKER_CONTEXT_NAME"'* &&
		"$source" == *'unix:///var/run/docker.sock'* &&
		"$source" == *'/.colima/default/docker.sock'* &&
		"$source" == *'com.winwidget.rehearsal.source-state'* &&
		"$source" == *'com.winwidget.rehearsal.source-sha256'* &&
		"$source" == *'linux_bind_visibility'* ]] ||
		fail 'static rehearsal contract is incomplete'
	[[ "$source" != *"$forbidden_command_audit_env"* &&
		"$source" != *"$raw_worker_exec"* &&
		"$source" != *"$forbidden_env_file"* &&
		"$source" != *"$forbidden_database_url"* &&
		"$source" != *"$forbidden_server_root"* &&
		"$source" != *"$forbidden_restore_storage"* &&
		"$source" != *"$broad_system_cleanup"* &&
		"$source" != *"$broad_volume_cleanup"* &&
		"$source" != *"$broad_container_cleanup"* ]] ||
		fail 'rehearsal contains a production-env or broad-cleanup reference'
	resolve_source_provenance
	assert_source_provenance_unchanged
	[[ "$SOURCE_HASH" =~ ^[0-9a-f]{64}$ && "$REVISION" =~ ^[0-9a-f]{40}$ ]] ||
		fail 'source provenance self-test is invalid'
	if [[ "$SOURCE_STATE" == 'clean' ]]; then
		[[ "$REVISION" == "$HEAD_REVISION" ]] ||
			fail 'clean source provenance must use the exact HEAD revision'
	else
		[[ "$SOURCE_STATE" == 'dirty' && "$REVISION" == "${SOURCE_HASH:0:40}" ]] ||
			fail 'dirty source provenance must use the deterministic source hash'
	fi
	status 'self_test'
}

docker_guard_error() {
	printf 'database_restore_rehearsal_error=%s\n' "$1" >&2
	return 1
}

pinned_docker_identity_matches() {
	local observed_endpoint observed_daemon_id
	[[ -n "$DOCKER_BINARY" && -n "$DOCKER_CONTEXT_NAME" &&
		-n "$DOCKER_CONTEXT_ENDPOINT" && -n "$DOCKER_DAEMON_ID" ]] ||
		{
			docker_guard_error 'local Docker identity was not initialized'
			return 1
		}
	observed_endpoint="$(
		"$DOCKER_BINARY" context inspect "$DOCKER_CONTEXT_NAME" \
			--format '{{(index .Endpoints "docker").Host}}' 2>/dev/null
	)" || {
		docker_guard_error 'cannot re-read the pinned Docker context endpoint'
		return 1
	}
	[[ "$observed_endpoint" == "$DOCKER_CONTEXT_ENDPOINT" ]] ||
		{
			docker_guard_error 'pinned Docker context endpoint changed during rehearsal'
			return 1
		}
	observed_daemon_id="$(
		"$DOCKER_BINARY" --context "$DOCKER_CONTEXT_NAME" info \
			--format '{{.ID}}' 2>/dev/null
	)" || {
		docker_guard_error 'cannot re-read the pinned Docker daemon identity'
		return 1
	}
	[[ "$observed_daemon_id" == "$DOCKER_DAEMON_ID" ]] ||
		{
			docker_guard_error 'pinned Docker daemon identity changed during rehearsal'
			return 1
		}
}

docker() {
	pinned_docker_identity_matches || return 1
	"$DOCKER_BINARY" --context "$DOCKER_CONTEXT_NAME" "$@"
}

worker_exec() {
	docker exec --user 1001:1001 "$WORKER_CONTAINER" "$@"
}

container_is_owned() {
	local container="$1" owner run
	owner="$(docker inspect --format '{{index .Config.Labels "com.winwidget.rehearsal"}}' "$container" 2>/dev/null || true)"
	run="$(docker inspect --format '{{index .Config.Labels "com.winwidget.rehearsal.run-id"}}' "$container" 2>/dev/null || true)"
	[[ "$owner" == 'database-restore-worker' && "$run" == "$RUN_ID" ]]
}

volume_is_owned() {
	local volume="$1" owner run
	owner="$(docker volume inspect --format '{{index .Labels "com.winwidget.rehearsal"}}' "$volume" 2>/dev/null || true)"
	run="$(docker volume inspect --format '{{index .Labels "com.winwidget.rehearsal.run-id"}}' "$volume" 2>/dev/null || true)"
	[[ "$owner" == 'database-restore-worker' && "$run" == "$RUN_ID" ]]
}

image_is_owned() {
	local image="$1" owner run
	owner="$(docker image inspect --format '{{index .Config.Labels "com.winwidget.rehearsal"}}' "$image" 2>/dev/null || true)"
	run="$(docker image inspect --format '{{index .Config.Labels "com.winwidget.rehearsal.run-id"}}' "$image" 2>/dev/null || true)"
	[[ "$owner" == 'database-restore-worker' && "$run" == "$RUN_ID" ]]
}

cleanup() {
	local original_status=$? cleanup_status=0 resource
	trap - EXIT INT TERM
	set +e
	if [[ "$CLEANUP_ARMED" == '1' ]] && ! pinned_docker_identity_matches; then
		printf 'Refusing Docker cleanup because the pinned local daemon identity changed\n' >&2
		cleanup_status=1
	elif [[ "$CLEANUP_ARMED" == '1' ]]; then
		for resource in "$UTILITY_CONTAINER" "$WORKER_CONTAINER" "$PG_CONTAINER"; do
			if docker container inspect "$resource" >/dev/null 2>&1; then
				if container_is_owned "$resource"; then
					docker rm -f "$resource" >/dev/null 2>&1 || cleanup_status=1
				else
					printf 'Refusing to remove unowned container %s\n' "$resource" >&2
					cleanup_status=1
				fi
			fi
			done
		for resource in "$RESTORE_VOLUME" "$PG_VOLUME"; do
			if docker volume inspect "$resource" >/dev/null 2>&1; then
				if volume_is_owned "$resource"; then
					docker volume rm "$resource" >/dev/null 2>&1 || cleanup_status=1
				else
					printf 'Refusing to remove unowned volume %s\n' "$resource" >&2
					cleanup_status=1
				fi
			fi
			done
		if docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1; then
			if image_is_owned "$RUNNER_IMAGE"; then
				docker image rm "$RUNNER_IMAGE" >/dev/null 2>&1 || cleanup_status=1
			else
				printf 'Refusing to remove unowned image %s\n' "$RUNNER_IMAGE" >&2
				cleanup_status=1
			fi
		fi
	fi
	if [[ -d "$APP_ROOT" && ! -L "$APP_ROOT" &&
		"$(cd "$(dirname "$APP_ROOT")" && pwd -P)" == "$STATE_ROOT" &&
		"$(basename "$APP_ROOT")" == "$RESOURCE_PREFIX" ]]; then
		rm -rf -- "$APP_ROOT" || cleanup_status=1
	fi
	if [[ "$original_status" == '0' && "$cleanup_status" != '0' ]]; then
		exit 1
	fi
	exit "$original_status"
}

assert_local_docker() {
	local context endpoint socket_path os_type daemon_id user_home expected_endpoint uid
	[[ "$HOST_OS" == 'Linux' || "$HOST_OS" == 'Darwin' ]] ||
		fail 'full rehearsal requires Linux or macOS with the local colima context'
	DOCKER_BINARY="$(type -P docker || true)"
	[[ -n "$DOCKER_BINARY" && -x "$DOCKER_BINARY" ]] || fail 'docker is required'
	[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_TLS_VERIFY:-}" &&
		-z "${DOCKER_CONTEXT:-}" && -z "${DOCKER_CERT_PATH:-}" ]] ||
		fail 'Docker connection override variables must be unset for local rehearsal'
	context="$("$DOCKER_BINARY" context show 2>/dev/null)" ||
		fail 'cannot resolve the current Docker context'
	[[ "$context" =~ ^[A-Za-z0-9_.-]+$ ]] || fail 'Docker context name is unsafe'
	endpoint="$(
		"$DOCKER_BINARY" context inspect "$context" \
			--format '{{(index .Endpoints "docker").Host}}' 2>/dev/null
	)" || fail 'cannot inspect the current Docker context'
	if [[ "$HOST_OS" == 'Darwin' ]]; then
		user_home="$(cd && pwd -P)"
		expected_endpoint="unix://$user_home/.colima/default/docker.sock"
		[[ "$context" == 'colima' && "$endpoint" == "$expected_endpoint" ]] ||
			fail "macOS rehearsal requires context colima at $expected_endpoint"
	else
		uid="$(id -u)"
		case "$context|$endpoint" in
		'default|unix:///var/run/docker.sock') ;;
		"rootless|unix:///run/user/$uid/docker.sock") ;;
		*) fail 'Linux rehearsal requires the exact default or rootless local Docker socket' ;;
		esac
	fi
	socket_path="${endpoint#unix://}"
	[[ "$socket_path" == /* && -S "$socket_path" ]] ||
		fail 'pinned Docker endpoint is not an existing local Unix socket'
	"$DOCKER_BINARY" --context "$context" version >/dev/null 2>&1 ||
		fail 'local Docker daemon is unavailable'
	os_type="$("$DOCKER_BINARY" --context "$context" info --format '{{.OSType}}')"
	[[ "$os_type" == 'linux' ]] || fail 'Docker daemon must run Linux containers'
	daemon_id="$("$DOCKER_BINARY" --context "$context" info --format '{{.ID}}')"
	[[ "$daemon_id" =~ ^[A-Za-z0-9][A-Za-z0-9:._-]{5,255}$ ]] ||
		fail 'Docker daemon returned an invalid identity'
	DOCKER_CONTEXT_NAME="$context"
	DOCKER_CONTEXT_ENDPOINT="$endpoint"
	DOCKER_DAEMON_ID="$daemon_id"
	pinned_docker_identity_matches || fail 'Docker locality identity check failed'
	status 'local_docker_context'
}

assert_resources_absent() {
	local resource
	[[ ! -e "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
		fail "rehearsal root already exists: $APP_ROOT"
	for resource in "$PG_CONTAINER" "$WORKER_CONTAINER" "$UTILITY_CONTAINER"; do
		! docker container inspect "$resource" >/dev/null 2>&1 ||
			fail "container already exists: $resource"
	done
	for resource in "$PG_VOLUME" "$RESTORE_VOLUME"; do
		! docker volume inspect "$resource" >/dev/null 2>&1 ||
			fail "volume already exists: $resource"
	done
	! docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 ||
		fail "image already exists: $RUNNER_IMAGE"
	if command -v ss >/dev/null 2>&1; then
		for port in "$CORE_PORT" "$NOTIFICATION_PORT" "$CAMPAIGNS_PORT" "$REPORTING_PORT" "$WIDGETS_PORT" "$BILLING_PORT" "$IDENTITY_PORT" "$PLATFORM_PORT" "$SUPPORT_PORT" "$OPERATIONS_PORT"; do
			! ss -H -ltn | awk '{print $4}' | grep -Eq "(^|:)$port$" ||
				fail "canonical rehearsal port is already in use: $port"
		done
	elif command -v lsof >/dev/null 2>&1; then
		for port in "$CORE_PORT" "$NOTIFICATION_PORT" "$CAMPAIGNS_PORT" "$REPORTING_PORT" "$WIDGETS_PORT" "$BILLING_PORT" "$IDENTITY_PORT" "$PLATFORM_PORT" "$SUPPORT_PORT" "$OPERATIONS_PORT"; do
			! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 ||
				fail "canonical rehearsal port is already in use: $port"
		done
	fi
}

utility_run() {
	! docker container inspect "$UTILITY_CONTAINER" >/dev/null 2>&1 ||
		fail "utility container is already present: $UTILITY_CONTAINER"
	docker run --rm \
		--name "$UTILITY_CONTAINER" \
		--label "$OWNER_LABEL" \
		--label "$RUN_LABEL" \
		"$@"
}

build_runner_image() {
	resolve_source_provenance
	docker build \
		--target database-restore-runner \
		--build-arg "APP_REVISION=$REVISION" \
		--label "$OWNER_LABEL" \
		--label "$RUN_LABEL" \
		--label "com.winwidget.rehearsal.head-revision=$HEAD_REVISION" \
		--label "com.winwidget.rehearsal.source-sha256=$SOURCE_HASH" \
		--label "com.winwidget.rehearsal.source-state=$SOURCE_STATE" \
		--tag "$RUNNER_IMAGE" \
		"$SOURCE_ROOT"
	assert_source_provenance_unchanged
	image_is_owned "$RUNNER_IMAGE" || fail 'runner image ownership labels are missing'
	[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$RUNNER_IMAGE")" == "$REVISION" ]] ||
		fail 'runner image revision is not pinned to the source provenance'
	[[ "$(docker image inspect --format '{{index .Config.Labels "com.winwidget.rehearsal.head-revision"}}' "$RUNNER_IMAGE")" == "$HEAD_REVISION" &&
		"$(docker image inspect --format '{{index .Config.Labels "com.winwidget.rehearsal.source-sha256"}}' "$RUNNER_IMAGE")" == "$SOURCE_HASH" &&
		"$(docker image inspect --format '{{index .Config.Labels "com.winwidget.rehearsal.source-state"}}' "$RUNNER_IMAGE")" == "$SOURCE_STATE" ]] ||
		fail 'runner image source provenance labels are invalid'
	status 'runner_image'
}

write_secret_files() {
	local command_name
	mkdir -p "$APP_ROOT/secrets" "$APP_ROOT/dumps" "$APP_ROOT/wrappers"
	chmod 700 "$APP_ROOT" "$APP_ROOT/secrets"
	chmod 755 "$APP_ROOT/dumps" "$APP_ROOT/wrappers"
	printf '%s' "$BOOTSTRAP_PASSWORD" >"$APP_ROOT/secrets/postgres-bootstrap"
	printf '%s' "$NOTIFICATION_ADMIN_PASSWORD" >"$APP_ROOT/secrets/notification-admin"
	printf '%s' "$CAMPAIGNS_ADMIN_PASSWORD" >"$APP_ROOT/secrets/campaigns-admin"
	printf '%s' "$REPORTING_ADMIN_PASSWORD" >"$APP_ROOT/secrets/reporting-admin"
	printf '%s' "$WIDGETS_ADMIN_PASSWORD" >"$APP_ROOT/secrets/widgets-admin"
	printf '%s' "$BILLING_ADMIN_PASSWORD" >"$APP_ROOT/secrets/billing-admin"
	printf '%s' "$IDENTITY_ADMIN_PASSWORD" >"$APP_ROOT/secrets/identity-admin"
	printf '%s' "$PLATFORM_ADMIN_PASSWORD" >"$APP_ROOT/secrets/platform-admin"
	printf '%s' "$SUPPORT_ADMIN_PASSWORD" >"$APP_ROOT/secrets/support-admin"
	printf '%s' "$OPERATIONS_ADMIN_PASSWORD" >"$APP_ROOT/secrets/operations-admin"
	chmod 0444 "$APP_ROOT"/secrets/*
	for command_name in pg_dump pg_restore psql; do
		cat >"$APP_ROOT/wrappers/$command_name" <<SH
#!/bin/sh
set -eu
command_name="\${0##*/}"
printf '%s\n' "\$command_name" >>"$COMMAND_AUDIT_PATH"
exec "/usr/bin/\$command_name" "\$@"
SH
		chmod 0555 "$APP_ROOT/wrappers/$command_name"
	done
}

verify_linux_bind_visibility() {
	local probe_path="$APP_ROOT/dumps/.linux-bind-probe"
	printf '%s' "$RUN_ID" >"$probe_path"
	chmod 0444 "$probe_path"
	utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=bind,source=$probe_path,target=/run/rehearsal-bind-probe,readonly" \
		--entrypoint sh \
		"$POSTGRES_IMAGE" \
		-euc 'test "$(cat /run/rehearsal-bind-probe)" = "$1"' sh "$RUN_ID"
	rm -f -- "$probe_path"
	status 'linux_bind_visibility'
}

create_volumes_and_storage() {
	docker volume create --label "$OWNER_LABEL" --label "$RUN_LABEL" "$PG_VOLUME" >/dev/null
	docker volume create --label "$OWNER_LABEL" --label "$RUN_LABEL" "$RESTORE_VOLUME" >/dev/null
	volume_is_owned "$PG_VOLUME" && volume_is_owned "$RESTORE_VOLUME" ||
		fail 'rehearsal volume labels are invalid'
	utility_run \
		--network none \
		--user 0:0 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore" \
		--entrypoint sh \
		"$RUNNER_IMAGE" \
		-euc 'mkdir -p /restore; chown 1001:1001 /restore; chmod 700 /restore'
}

wait_for_postgres() {
	local attempt health
	for ((attempt = 1; attempt <= 120; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$PG_CONTAINER" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return
		sleep 1
	done
	fail 'PostgreSQL 18 rehearsal container did not become healthy'
}

start_postgres() {
	local bindings expected_bindings server_state
	docker run -d \
		--name "$PG_CONTAINER" \
		--label "$OWNER_LABEL" \
		--label "$RUN_LABEL" \
		--mount "type=volume,source=$PG_VOLUME,target=/var/lib/postgresql" \
		--mount "type=bind,source=$APP_ROOT/secrets/postgres-bootstrap,target=/run/secrets/postgres-bootstrap,readonly" \
		-e POSTGRES_DB=postgres \
		-e POSTGRES_USER=winwidget_restore_rehearsal_bootstrap \
		-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-bootstrap \
		-e 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		-p "127.0.0.1:$CORE_PORT:5432" \
		-p "127.0.0.1:$NOTIFICATION_PORT:5432" \
		-p "127.0.0.1:$CAMPAIGNS_PORT:5432" \
		-p "127.0.0.1:$REPORTING_PORT:5432" \
		-p "127.0.0.1:$WIDGETS_PORT:5432" \
		-p "127.0.0.1:$BILLING_PORT:5432" \
		-p "127.0.0.1:$IDENTITY_PORT:5432" \
		-p "127.0.0.1:$PLATFORM_PORT:5432" \
		-p "127.0.0.1:$SUPPORT_PORT:5432" \
		-p "127.0.0.1:$OPERATIONS_PORT:5432" \
		--health-cmd 'pg_isready --username winwidget_restore_rehearsal_bootstrap --dbname postgres' \
		--health-interval 1s \
		--health-timeout 3s \
		--health-retries 120 \
		"$POSTGRES_IMAGE" >/dev/null
	container_is_owned "$PG_CONTAINER" || fail 'PostgreSQL container labels are invalid'
	wait_for_postgres
	[[ "$(docker inspect --format '{{.Config.Image}}' "$PG_CONTAINER")" == "$POSTGRES_IMAGE" ]] ||
		fail 'PostgreSQL container did not use the pinned digest'
	bindings="$(docker port "$PG_CONTAINER" 5432/tcp | sort)"
	expected_bindings="$(printf '127.0.0.1:%s\n' \
		"$NOTIFICATION_PORT" "$CAMPAIGNS_PORT" "$CORE_PORT" "$REPORTING_PORT" "$WIDGETS_PORT" "$BILLING_PORT" "$IDENTITY_PORT" "$PLATFORM_PORT" "$SUPPORT_PORT" "$OPERATIONS_PORT" | sort)"
	[[ "$bindings" == "$expected_bindings" ]] ||
		fail 'PostgreSQL rehearsal ports are not exact loopback bindings'
	server_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
		--command "SELECT current_setting('server_version_num')::int / 10000 || '|' || current_setting('data_checksums') || '|' || (pg_control_system()).system_identifier;")"
	[[ "$server_state" =~ ^18\|on\|[0-9]+$ ]] ||
		fail 'PostgreSQL server version, checksums or identity is invalid'
	status 'postgresql_18'
}

provision_roles_and_databases() {
	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres <<'SQL'
CREATE ROLE winwidget_core_admin LOGIN PASSWORD 'rehearsal_core_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_notification_delivery_admin LOGIN PASSWORD 'rehearsal_notification_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_campaigns_admin LOGIN PASSWORD 'rehearsal_campaigns_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_reporting_admin LOGIN PASSWORD 'rehearsal_reporting_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_widgets_admin LOGIN PASSWORD 'rehearsal_widgets_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_billing_admin LOGIN PASSWORD 'rehearsal_billing_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_identity_admin LOGIN PASSWORD 'rehearsal_identity_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_platform_admin LOGIN PASSWORD 'rehearsal_platform_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_support_admin LOGIN PASSWORD 'rehearsal_support_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_operations_admin LOGIN PASSWORD 'rehearsal_operations_admin_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE gen_user LOGIN PASSWORD 'rehearsal_core_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_api_runtime LOGIN PASSWORD 'rehearsal_core_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_maintenance LOGIN PASSWORD 'rehearsal_core_maintenance_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_backup LOGIN PASSWORD 'rehearsal_core_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE winwidget_notification_delivery_migration LOGIN PASSWORD 'rehearsal_notification_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_notification_delivery_runtime LOGIN PASSWORD 'rehearsal_notification_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_notification_delivery_backup LOGIN PASSWORD 'rehearsal_notification_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE winwidget_campaigns_migration LOGIN PASSWORD 'rehearsal_campaigns_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_campaigns_runtime LOGIN PASSWORD 'rehearsal_campaigns_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_campaigns_backup LOGIN PASSWORD 'rehearsal_campaigns_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE winwidget_reporting_migration LOGIN PASSWORD 'rehearsal_reporting_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_reporting_runtime LOGIN PASSWORD 'rehearsal_reporting_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_reporting_backup LOGIN PASSWORD 'rehearsal_reporting_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE winwidget_widgets_migration LOGIN PASSWORD 'rehearsal_widgets_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_widgets_runtime LOGIN PASSWORD 'rehearsal_widgets_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_widgets_backup LOGIN PASSWORD 'rehearsal_widgets_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_billing_migration LOGIN PASSWORD 'rehearsal_billing_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_billing_runtime LOGIN PASSWORD 'rehearsal_billing_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_billing_backup LOGIN PASSWORD 'rehearsal_billing_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_identity_migration LOGIN PASSWORD 'rehearsal_identity_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_identity_runtime LOGIN PASSWORD 'rehearsal_identity_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_identity_backup LOGIN PASSWORD 'rehearsal_identity_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_platform_migration LOGIN PASSWORD 'rehearsal_platform_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_platform_runtime LOGIN PASSWORD 'rehearsal_platform_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_platform_backup LOGIN PASSWORD 'rehearsal_platform_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_support_migration LOGIN PASSWORD 'rehearsal_support_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_support_runtime LOGIN PASSWORD 'rehearsal_support_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_support_backup LOGIN PASSWORD 'rehearsal_support_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_operations_migration LOGIN PASSWORD 'rehearsal_operations_migration_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_operations_runtime LOGIN PASSWORD 'rehearsal_operations_runtime_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE winwidget_operations_backup LOGIN PASSWORD 'rehearsal_operations_backup_password_2026'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT pg_signal_backend TO winwidget_core_admin, winwidget_notification_delivery_admin,
	winwidget_campaigns_admin, winwidget_reporting_admin, winwidget_widgets_admin,
	winwidget_billing_admin, winwidget_identity_admin, winwidget_platform_admin,
	winwidget_support_admin, winwidget_operations_admin;
GRANT gen_user, winwidget_api_runtime, winwidget_maintenance, winwidget_backup
	TO winwidget_core_admin;
GRANT winwidget_notification_delivery_migration, winwidget_notification_delivery_runtime,
	winwidget_notification_delivery_backup TO winwidget_notification_delivery_admin;
GRANT winwidget_campaigns_migration, winwidget_campaigns_runtime,
	winwidget_campaigns_backup TO winwidget_campaigns_admin;
GRANT winwidget_reporting_migration, winwidget_reporting_runtime,
	winwidget_reporting_backup TO winwidget_reporting_admin;
GRANT winwidget_widgets_migration, winwidget_widgets_runtime,
	winwidget_widgets_backup TO winwidget_widgets_admin;
GRANT winwidget_billing_migration, winwidget_billing_runtime,
	winwidget_billing_backup TO winwidget_billing_admin;
GRANT winwidget_identity_migration, winwidget_identity_runtime,
	winwidget_identity_backup TO winwidget_identity_admin;
GRANT winwidget_platform_migration, winwidget_platform_runtime,
	winwidget_platform_backup TO winwidget_platform_admin;
GRANT winwidget_support_migration, winwidget_support_runtime,
	winwidget_support_backup TO winwidget_support_admin;
GRANT winwidget_operations_migration, winwidget_operations_runtime,
	winwidget_operations_backup TO winwidget_operations_admin;

CREATE DATABASE default_db OWNER winwidget_core_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_notification_delivery OWNER winwidget_notification_delivery_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_campaigns OWNER winwidget_campaigns_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_reporting OWNER winwidget_reporting_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_widgets OWNER winwidget_widgets_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_billing OWNER winwidget_billing_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_identity OWNER winwidget_identity_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_platform OWNER winwidget_platform_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_support OWNER winwidget_support_admin TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE winwidget_operations OWNER winwidget_operations_admin TEMPLATE template0 ENCODING 'UTF8';

\connect default_db
ALTER SCHEMA public OWNER TO gen_user;
REVOKE ALL ON DATABASE default_db FROM PUBLIC;
GRANT CONNECT ON DATABASE default_db TO gen_user, winwidget_api_runtime, winwidget_maintenance, winwidget_backup;
REVOKE CREATE, TEMPORARY ON DATABASE default_db FROM gen_user, winwidget_api_runtime, winwidget_maintenance, winwidget_backup;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO gen_user;

\connect winwidget_notification_delivery
CREATE SCHEMA notification_delivery AUTHORIZATION winwidget_notification_delivery_migration;
REVOKE ALL ON DATABASE winwidget_notification_delivery FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_notification_delivery TO winwidget_notification_delivery_migration,
	winwidget_notification_delivery_runtime, winwidget_notification_delivery_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_notification_delivery FROM winwidget_notification_delivery_migration,
	winwidget_notification_delivery_runtime, winwidget_notification_delivery_backup;
REVOKE ALL ON SCHEMA notification_delivery FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA notification_delivery TO winwidget_notification_delivery_migration;

\connect winwidget_campaigns
CREATE SCHEMA campaigns AUTHORIZATION winwidget_campaigns_migration;
REVOKE ALL ON DATABASE winwidget_campaigns FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_campaigns TO winwidget_campaigns_migration,
	winwidget_campaigns_runtime, winwidget_campaigns_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_campaigns FROM winwidget_campaigns_migration,
	winwidget_campaigns_runtime, winwidget_campaigns_backup;
REVOKE ALL ON SCHEMA campaigns FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA campaigns TO winwidget_campaigns_migration;

\connect winwidget_reporting
CREATE SCHEMA reporting AUTHORIZATION winwidget_reporting_migration;
REVOKE ALL ON DATABASE winwidget_reporting FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_reporting TO winwidget_reporting_migration,
	winwidget_reporting_runtime, winwidget_reporting_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_reporting FROM winwidget_reporting_migration,
	winwidget_reporting_runtime, winwidget_reporting_backup;
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA reporting TO winwidget_reporting_migration;

\connect winwidget_widgets
CREATE SCHEMA widgets AUTHORIZATION winwidget_widgets_migration;
REVOKE ALL ON DATABASE winwidget_widgets FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_widgets TO winwidget_widgets_migration,
	winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_widgets FROM winwidget_widgets_migration,
	winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE ALL ON SCHEMA widgets FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA widgets TO winwidget_widgets_migration;

\connect winwidget_billing
CREATE SCHEMA billing AUTHORIZATION winwidget_billing_migration;
REVOKE ALL ON DATABASE winwidget_billing FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_billing TO winwidget_billing_migration,
	winwidget_billing_runtime, winwidget_billing_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_billing FROM winwidget_billing_migration,
	winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA billing TO winwidget_billing_migration;

\connect winwidget_identity
CREATE SCHEMA identity AUTHORIZATION winwidget_identity_migration;
REVOKE ALL ON DATABASE winwidget_identity FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_identity TO winwidget_identity_migration,
	winwidget_identity_runtime, winwidget_identity_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_identity FROM winwidget_identity_migration,
	winwidget_identity_runtime, winwidget_identity_backup;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA identity TO winwidget_identity_migration;

\connect winwidget_platform
CREATE SCHEMA platform AUTHORIZATION winwidget_platform_migration;
REVOKE ALL ON DATABASE winwidget_platform FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_platform TO winwidget_platform_migration,
	winwidget_platform_runtime, winwidget_platform_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_platform FROM winwidget_platform_migration,
	winwidget_platform_runtime, winwidget_platform_backup;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA platform TO winwidget_platform_migration;

\connect winwidget_support
CREATE SCHEMA support AUTHORIZATION winwidget_support_migration;
REVOKE ALL ON DATABASE winwidget_support FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_support TO winwidget_support_migration,
	winwidget_support_runtime, winwidget_support_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_support FROM winwidget_support_migration,
	winwidget_support_runtime, winwidget_support_backup;
REVOKE ALL ON SCHEMA support FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA support TO winwidget_support_migration;

\connect winwidget_operations
CREATE SCHEMA operations AUTHORIZATION winwidget_operations_migration;
REVOKE ALL ON DATABASE winwidget_operations FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_operations TO winwidget_operations_migration,
	winwidget_operations_runtime, winwidget_operations_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_operations FROM winwidget_operations_migration,
	winwidget_operations_runtime, winwidget_operations_backup;
REVOKE ALL ON SCHEMA operations FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA operations TO winwidget_operations_migration;
SQL
	status 'roles_and_databases'
}

verify_cluster_boundaries() {
	local role_state database_state
	role_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
		--command "
WITH expected_roles(role_name, is_admin) AS (
  VALUES
    ('winwidget_core_admin', true),
    ('winwidget_notification_delivery_admin', true),
    ('winwidget_campaigns_admin', true),
    ('winwidget_reporting_admin', true),
	('winwidget_widgets_admin', true),
	('winwidget_billing_admin', true),
	('winwidget_identity_admin', true),
	('winwidget_platform_admin', true),
	('winwidget_support_admin', true),
	('winwidget_operations_admin', true),
    ('gen_user', false),
    ('winwidget_api_runtime', false),
    ('winwidget_maintenance', false),
    ('winwidget_backup', false),
    ('winwidget_notification_delivery_migration', false),
    ('winwidget_notification_delivery_runtime', false),
    ('winwidget_notification_delivery_backup', false),
    ('winwidget_campaigns_migration', false),
    ('winwidget_campaigns_runtime', false),
    ('winwidget_campaigns_backup', false),
    ('winwidget_reporting_migration', false),
    ('winwidget_reporting_runtime', false),
	('winwidget_reporting_backup', false),
	('winwidget_widgets_migration', false),
	('winwidget_widgets_runtime', false),
	('winwidget_widgets_backup', false),
	('winwidget_billing_migration', false),
	('winwidget_billing_runtime', false),
	('winwidget_billing_backup', false),
	('winwidget_identity_migration', false),
	('winwidget_identity_runtime', false),
	('winwidget_identity_backup', false),
	('winwidget_platform_migration', false),
	('winwidget_platform_runtime', false),
	('winwidget_platform_backup', false),
	('winwidget_support_migration', false),
	('winwidget_support_runtime', false),
	('winwidget_support_backup', false),
	('winwidget_operations_migration', false),
	('winwidget_operations_runtime', false),
	('winwidget_operations_backup', false)
),
expected_memberships(member_name, role_name) AS (
  VALUES
    ('winwidget_core_admin', 'pg_signal_backend'),
    ('winwidget_core_admin', 'gen_user'),
    ('winwidget_core_admin', 'winwidget_api_runtime'),
    ('winwidget_core_admin', 'winwidget_maintenance'),
    ('winwidget_core_admin', 'winwidget_backup'),
    ('winwidget_notification_delivery_admin', 'pg_signal_backend'),
    ('winwidget_notification_delivery_admin', 'winwidget_notification_delivery_migration'),
    ('winwidget_notification_delivery_admin', 'winwidget_notification_delivery_runtime'),
    ('winwidget_notification_delivery_admin', 'winwidget_notification_delivery_backup'),
    ('winwidget_campaigns_admin', 'pg_signal_backend'),
    ('winwidget_campaigns_admin', 'winwidget_campaigns_migration'),
    ('winwidget_campaigns_admin', 'winwidget_campaigns_runtime'),
    ('winwidget_campaigns_admin', 'winwidget_campaigns_backup'),
    ('winwidget_reporting_admin', 'pg_signal_backend'),
    ('winwidget_reporting_admin', 'winwidget_reporting_migration'),
    ('winwidget_reporting_admin', 'winwidget_reporting_runtime'),
	('winwidget_reporting_admin', 'winwidget_reporting_backup'),
	('winwidget_widgets_admin', 'pg_signal_backend'),
	('winwidget_widgets_admin', 'winwidget_widgets_migration'),
	('winwidget_widgets_admin', 'winwidget_widgets_runtime'),
	('winwidget_widgets_admin', 'winwidget_widgets_backup'),
	('winwidget_billing_admin', 'pg_signal_backend'),
	('winwidget_billing_admin', 'winwidget_billing_migration'),
	('winwidget_billing_admin', 'winwidget_billing_runtime'),
	('winwidget_billing_admin', 'winwidget_billing_backup'),
	('winwidget_identity_admin', 'pg_signal_backend'),
	('winwidget_identity_admin', 'winwidget_identity_migration'),
	('winwidget_identity_admin', 'winwidget_identity_runtime'),
	('winwidget_identity_admin', 'winwidget_identity_backup'),
	('winwidget_platform_admin', 'pg_signal_backend'),
	('winwidget_platform_admin', 'winwidget_platform_migration'),
	('winwidget_platform_admin', 'winwidget_platform_runtime'),
	('winwidget_platform_admin', 'winwidget_platform_backup'),
	('winwidget_support_admin', 'pg_signal_backend'),
	('winwidget_support_admin', 'winwidget_support_migration'),
	('winwidget_support_admin', 'winwidget_support_runtime'),
	('winwidget_support_admin', 'winwidget_support_backup'),
	('winwidget_operations_admin', 'pg_signal_backend'),
	('winwidget_operations_admin', 'winwidget_operations_migration'),
	('winwidget_operations_admin', 'winwidget_operations_runtime'),
	('winwidget_operations_admin', 'winwidget_operations_backup')
),
actual_memberships AS (
  SELECT member.rolname AS member_name, granted.rolname AS role_name
  FROM pg_auth_members membership
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles granted ON granted.oid = membership.roleid
  WHERE member.rolname IN (SELECT role_name FROM expected_roles)
)
SELECT
  (SELECT count(*) FROM expected_roles) = 41
  AND NOT EXISTS (
    SELECT 1
    FROM expected_roles expected
    LEFT JOIN pg_roles role_state ON role_state.rolname = expected.role_name
    WHERE role_state.oid IS NULL
       OR NOT role_state.rolcanlogin
       OR role_state.rolsuper
       OR role_state.rolcreatedb
       OR role_state.rolcreaterole
       OR role_state.rolreplication
       OR role_state.rolbypassrls
       OR role_state.rolinherit <> expected.is_admin
  )
  AND NOT EXISTS (
    SELECT member_name, role_name FROM expected_memberships
    EXCEPT
    SELECT member_name, role_name FROM actual_memberships
  )
  AND NOT EXISTS (
    SELECT member_name, role_name FROM actual_memberships
    EXCEPT
    SELECT member_name, role_name FROM expected_memberships
  );")"
	[[ "$role_state" == 't' ]] || fail 'rehearsal role attributes or memberships are not exact'

	database_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
		--command "
WITH expected(database_name, owner_name) AS (
  VALUES
    ('default_db', 'winwidget_core_admin'),
    ('winwidget_notification_delivery', 'winwidget_notification_delivery_admin'),
    ('winwidget_campaigns', 'winwidget_campaigns_admin'),
	('winwidget_reporting', 'winwidget_reporting_admin'),
	('winwidget_widgets', 'winwidget_widgets_admin'),
	('winwidget_billing', 'winwidget_billing_admin'),
	('winwidget_identity', 'winwidget_identity_admin'),
	('winwidget_platform', 'winwidget_platform_admin'),
	('winwidget_support', 'winwidget_support_admin'),
	('winwidget_operations', 'winwidget_operations_admin')
)
SELECT count(*) = 10
  AND bool_and(database_state.datallowconn)
  AND bool_and(pg_encoding_to_char(database_state.encoding) = 'UTF8')
  AND bool_and(owner_state.rolname = expected.owner_name)
FROM expected
JOIN pg_database database_state ON database_state.datname = expected.database_name
JOIN pg_roles owner_state ON owner_state.oid = database_state.datdba;")"
	[[ "$database_state" == 't' ]] || fail 'canonical rehearsal databases are missing or misowned'
	status 'cluster_boundaries'
}

run_core_prisma_migration() {
	local url
	url="postgresql://gen_user:$CORE_MIGRATION_PASSWORD@127.0.0.1:$CORE_PORT/default_db?schema=public&sslmode=disable&options=-c%20winwidget.campaigns_contract_cutover%3Dproduction-destructive-approved%20-c%20winwidget.campaigns_forward_boundary%3Dforward-only%20-c%20winwidget.campaigns_source_manifest_sha256%3D0000000000000000000000000000000000000000000000000000000000000000%20-c%20winwidget.campaigns_telegram_audit_decision%3Dcompleted%20-c%20winwidget.campaigns_telegram_audit_reference%3Drestore-rehearsal%20-c%20winwidget.platform_pristine_replay%3Dapproved-nonproduction-replay"
	utility_run \
		--network host \
		-e "DATABASE_URL=$url" \
		--entrypoint ./node_modules/.bin/prisma \
		"$RUNNER_IMAGE" \
		migrate deploy --schema prisma/schema.prisma
	unset url
}

run_prisma_migration() {
	local target="$1" database port role password env_key schema_path url
	database="$(target_database "$target")"
	port="$(target_port "$target")"
	role="$(target_migration_role "$target")"
	password="$(target_migration_password "$target")"
	case "$target" in
	notification-delivery)
		env_key='NOTIFICATION_DELIVERY_DATABASE_URL'
		schema_path='apps/notification-delivery/prisma/schema.prisma'
		;;
	campaigns)
		env_key='CAMPAIGNS_DATABASE_URL'
		schema_path='apps/campaigns/prisma/schema.prisma'
		;;
	reporting)
		env_key='REPORTING_DATABASE_URL'
		schema_path='apps/reporting/prisma/schema.prisma'
		;;
	widgets)
		env_key='WIDGETS_DATABASE_URL'
		schema_path='apps/widgets/prisma/schema.prisma'
		;;
	billing)
		env_key='BILLING_DATABASE_URL'
		schema_path='apps/billing/prisma/schema.prisma'
		;;
	identity)
		env_key='IDENTITY_DATABASE_URL'
		schema_path='apps/identity/prisma/schema.prisma'
		;;
	platform)
		env_key='PLATFORM_DATABASE_URL'
		schema_path='apps/platform/prisma/schema.prisma'
		;;
	support)
		env_key='SUPPORT_DATABASE_URL'
		schema_path='apps/support/prisma/schema.prisma'
		;;
	operations)
		env_key='OPERATIONS_DATABASE_URL'
		schema_path='apps/operations/prisma/schema.prisma'
		;;
	*) fail "unknown migration target $target" ;;
	esac
	url="postgresql://$role:$password@127.0.0.1:$port/$database?schema=$(target_schema "$target")&sslmode=disable"
	utility_run \
		--network host \
		-e "$env_key=$url" \
		--entrypoint ./node_modules/.bin/prisma \
		"$RUNNER_IMAGE" \
		migrate deploy --schema "$schema_path"
	unset url password
}

apply_migrations() {
	local target
	run_core_prisma_migration
	for target in notification-delivery campaigns reporting widgets billing identity platform support operations; do
		run_prisma_migration "$target"
	done
	status 'prisma_migrations'
}

assert_identity_core_source_removed() {
	local state
	state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
		--command "
SELECT
	  NOT EXISTS (
	    SELECT 1
	    FROM unnest(ARRAY[
	      'User', 'auth_identities', 'telegram_notification_channels',
	      'user_sessions', 'verification_challenges', 'identity_core_source_state'
	    ]::text[]) AS legacy(relation_name)
	    WHERE to_regclass(format('public.%I', legacy.relation_name)) IS NOT NULL
	  )
	  AND NOT EXISTS (
	    SELECT 1
	    FROM unnest(ARRAY[
	      'recaptcha_enabled', 'google_auth_enabled', 'yandex_auth_enabled',
	      'github_auth_enabled', 'vk_auth_enabled', 'telegram_auth_enabled'
	    ]::text[]) AS legacy(column_name)
		    JOIN pg_attribute attribute_state
		      ON attribute_state.attrelid = to_regclass('public.site_settings')
	     AND attribute_state.attname = legacy.column_name
	     AND attribute_state.attnum > 0
	     AND NOT attribute_state.attisdropped
	  )
	  AND NOT EXISTS (
	    SELECT 1
	    FROM unnest(ARRAY[
	      'public.reporting_emit_user_projection(text,boolean)',
	      'public.reporting_user_projection_trigger()',
	      'public.reporting_auth_identity_projection_trigger()',
	      'public.billing_emit_identity_projection(text,boolean)',
	      'public.billing_identity_user_projection_trigger()',
	      'public.billing_identity_auth_projection_trigger()',
	      'public.billing_identity_telegram_projection_trigger()',
	      'public.identity_core_source_is_open()',
	      'public.lock_identity_core_source_open()',
	      'public.reject_fenced_identity_core_source_write()',
	      'public.reject_fenced_identity_auth_settings_write()',
	      'public.fence_identity_core_source(text)',
	      'public.unfence_identity_core_source(text)'
	    ]::text[]) AS legacy(signature)
	    WHERE to_regprocedure(legacy.signature) IS NOT NULL
	  );")"
	[[ "$state" == 't' ]] || fail 'legacy Identity Core source state or functions remain'
	status 'identity_core_source_removed'
}

seed_markers_and_acl() {
	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db <<'SQL'
GRANT USAGE ON SCHEMA public TO winwidget_api_runtime, winwidget_maintenance, winwidget_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO winwidget_api_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO winwidget_api_runtime;
REVOKE ALL ON TABLE public._prisma_migrations FROM winwidget_api_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO winwidget_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO winwidget_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_notification_delivery <<'SQL'
SET ROLE winwidget_notification_delivery_migration;
CREATE TABLE notification_delivery.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO notification_delivery.restore_rehearsal_marker (id, value)
VALUES ('canonical', 'baseline-notification-delivery');
RESET ROLE;
GRANT USAGE ON SCHEMA notification_delivery TO winwidget_notification_delivery_runtime, winwidget_notification_delivery_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notification_delivery TO winwidget_notification_delivery_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA notification_delivery TO winwidget_notification_delivery_runtime;
REVOKE ALL ON TABLE notification_delivery._prisma_migrations FROM winwidget_notification_delivery_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA notification_delivery TO winwidget_notification_delivery_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA notification_delivery TO winwidget_notification_delivery_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_campaigns <<'SQL'
SET ROLE winwidget_campaigns_migration;
CREATE TABLE campaigns.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO campaigns.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-campaigns');
RESET ROLE;
GRANT USAGE ON SCHEMA campaigns TO winwidget_campaigns_runtime, winwidget_campaigns_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA campaigns TO winwidget_campaigns_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA campaigns TO winwidget_campaigns_runtime;
REVOKE ALL ON TABLE campaigns._prisma_migrations FROM winwidget_campaigns_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA campaigns TO winwidget_campaigns_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA campaigns TO winwidget_campaigns_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_reporting <<'SQL'
SET ROLE winwidget_reporting_migration;
CREATE TABLE reporting.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO reporting.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-reporting');
RESET ROLE;
GRANT USAGE ON SCHEMA reporting TO winwidget_reporting_runtime, winwidget_reporting_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reporting TO winwidget_reporting_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA reporting TO winwidget_reporting_runtime;
REVOKE ALL ON TABLE reporting._prisma_migrations FROM winwidget_reporting_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO winwidget_reporting_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA reporting TO winwidget_reporting_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_widgets <<'SQL'
SET ROLE winwidget_widgets_migration;
CREATE TABLE widgets.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO widgets.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-widgets');
RESET ROLE;
GRANT USAGE ON SCHEMA widgets TO winwidget_widgets_runtime, winwidget_widgets_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA widgets TO winwidget_widgets_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA widgets TO winwidget_widgets_runtime;
REVOKE ALL ON TABLE widgets._prisma_migrations FROM winwidget_widgets_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA widgets TO winwidget_widgets_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA widgets TO winwidget_widgets_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_billing <<'SQL'
SET ROLE winwidget_billing_migration;
CREATE TABLE billing.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO billing.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-billing');
RESET ROLE;
GRANT USAGE ON SCHEMA billing TO winwidget_billing_runtime, winwidget_billing_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing TO winwidget_billing_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_runtime;
REVOKE ALL ON TABLE billing._prisma_migrations FROM winwidget_billing_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO winwidget_billing_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_identity <<'SQL'
SET ROLE winwidget_identity_migration;
CREATE TABLE identity.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO identity.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-identity');
RESET ROLE;
GRANT USAGE ON SCHEMA identity TO winwidget_identity_runtime, winwidget_identity_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO winwidget_identity_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA identity TO winwidget_identity_runtime;
REVOKE ALL ON TABLE identity._prisma_migrations FROM winwidget_identity_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA identity TO winwidget_identity_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA identity TO winwidget_identity_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_platform <<'SQL'
SET ROLE winwidget_platform_migration;
CREATE TABLE platform.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO platform.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-platform');
RESET ROLE;
GRANT USAGE ON SCHEMA platform TO winwidget_platform_runtime, winwidget_platform_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO winwidget_platform_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA platform TO winwidget_platform_runtime;
REVOKE ALL ON TABLE platform._prisma_migrations FROM winwidget_platform_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA platform TO winwidget_platform_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA platform TO winwidget_platform_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_support <<'SQL'
SET ROLE winwidget_support_migration;
CREATE TABLE support.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO support.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-support');
RESET ROLE;
GRANT USAGE ON SCHEMA support TO winwidget_support_runtime, winwidget_support_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA support TO winwidget_support_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA support TO winwidget_support_runtime;
REVOKE ALL ON TABLE support._prisma_migrations FROM winwidget_support_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA support TO winwidget_support_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA support TO winwidget_support_backup;
SQL

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_operations <<'SQL'
SET ROLE winwidget_operations_migration;
CREATE TABLE operations.restore_rehearsal_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO operations.restore_rehearsal_marker (id, value) VALUES ('canonical', 'baseline-operations');
UPDATE operations.operations_ownership_state
SET "phase" = 'IMPORTED'::operations."OperationsDatabasePhase",
    "source_revision" = repeat('a', 40),
    "source_snapshot_sha256" = repeat('b', 64),
    "source_note_count" = 0,
    "source_event_count" = 0,
    "imported_at" = CURRENT_TIMESTAMP;
UPDATE operations.operations_ownership_state
SET "phase" = 'ACTIVE'::operations."OperationsDatabasePhase",
    "activated_at" = CURRENT_TIMESTAMP;
RESET ROLE;
GRANT USAGE ON SCHEMA operations TO winwidget_operations_runtime, winwidget_operations_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA operations TO winwidget_operations_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA operations TO winwidget_operations_runtime;
REVOKE ALL ON TABLE operations._prisma_migrations FROM winwidget_operations_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA operations TO winwidget_operations_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA operations TO winwidget_operations_backup;
SQL
	status 'markers_and_backup_acl'
}

assert_platform_rehearsal_contract() {
	local core_state platform_state terminal_cleanup_state
	terminal_cleanup_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
		--command "
SELECT
  (SELECT count(*) = 1
   FROM public._prisma_migrations
   WHERE migration_name = '20260825000000_remove_legacy_platform_core_source'
     AND finished_at IS NOT NULL
     AND rolled_back_at IS NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'site_settings', 'legal_pages', 'home_page_content', 'platform_core_state'
    ]::text[]) AS legacy(relation_name)
    WHERE to_regclass(format('public.%I', legacy.relation_name)) IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname IN (
        'platform_core_state_transition_guard',
        'platform_core_source_writes_enabled',
        'platform_assert_core_write_enabled',
        'billing_offer_projection_trigger'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type type_entry
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = type_entry.typnamespace
    WHERE namespace.nspname = 'public'
      AND type_entry.typname = 'PlatformCoreOwnership'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.billing_source_aggregate_versions
    WHERE aggregate_type = 'billing.offer'
      AND aggregate_id = 'offer'
  );")"
	if [[ "$terminal_cleanup_state" == 't' ]]; then
		platform_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
			--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_platform \
			--command "
SELECT
  (SELECT count(*) = 1
   FROM platform.service_identity
   WHERE id = 'singleton'
     AND service_name = 'platform-service'
     AND phase = 'SHADOW'::platform.\"ServiceDatabasePhase\"
     AND ownership_generation = 0
     AND source_fingerprint IS NULL
     AND source_snapshot_sha256 IS NULL
     AND source_snapshot_counts IS NULL
     AND source_high_watermark IS NULL
     AND imported_at IS NULL
     AND activated_at IS NULL)
  AND (SELECT count(*) = 1 AND min(next_value) = 1
       FROM platform.source_sequences
       WHERE id = 'platform')
  AND (SELECT count(*) = 1
       FROM platform.billing_offer_producer_state
       WHERE id = 'offer'
         AND phase = 'BLOCKED'::platform.\"OfferProducerPhase\"
         AND producer_contract_version IS NULL
         AND source_sequence_scope IS NULL
         AND imported_aggregate_version IS NULL
         AND imported_source_sequence IS NULL
         AND current_aggregate_version IS NULL
         AND current_source_sequence IS NULL
         AND source_fence_fingerprint IS NULL
         AND imported_at IS NULL
         AND activated_at IS NULL);")"
		[[ "$platform_state" == 't' ]] ||
			fail 'Platform terminal cleanup or service-owned baseline contract is invalid'
		status 'platform_cleanup_terminal_contract'
		return
	fi
	core_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
		--command "
WITH expected_platform_core_acl(grantee, privilege_type, is_grantable) AS (
	  VALUES
	    (to_regrole('winwidget_api_runtime')::oid, 'SELECT'::text, false),
	    (to_regrole('winwidget_maintenance')::oid, 'SELECT'::text, false),
    (to_regrole('winwidget_backup')::oid, 'SELECT'::text, false)
),
actual_platform_core_acl AS (
  SELECT privilege.grantee, privilege.privilege_type, privilege.is_grantable
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  CROSS JOIN LATERAL aclexplode(
    COALESCE(relation.relacl, acldefault('r', relation.relowner))
  ) privilege
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'platform_core_state'
    AND privilege.grantee <> relation.relowner
)
SELECT
  (SELECT count(*) = 1
   FROM public.platform_core_state
   WHERE id = 'singleton'
     AND ownership = 'CORE'::public.\"PlatformCoreOwnership\"
     AND source_writes_enabled
     AND legacy_routes_enabled
	     AND generation = 0
	     AND prepared_revision IS NULL
	     AND source_revision IS NULL
	     AND ownership_revision IS NULL
	     AND source_fingerprint IS NULL
	     AND source_snapshot_sha256 IS NULL
	     AND source_high_watermark IS NULL
	     AND billing_offer_contract_version IS NULL
	     AND billing_offer_sequence_scope IS NULL
	     AND billing_offer_aggregate_version IS NULL
	     AND billing_offer_source_sequence IS NULL
	     AND billing_offer_fence_fingerprint IS NULL
	     AND fenced_at IS NULL
	     AND exported_at IS NULL
	     AND activated_at IS NULL)
  AND NOT EXISTS (
    (SELECT * FROM expected_platform_core_acl EXCEPT SELECT * FROM actual_platform_core_acl)
    UNION ALL
    (SELECT * FROM actual_platform_core_acl EXCEPT SELECT * FROM expected_platform_core_acl)
  )
  AND has_function_privilege(
    'winwidget_api_runtime', 'public.platform_core_source_writes_enabled()', 'EXECUTE'
  )
  AND has_function_privilege(
    'winwidget_api_runtime', 'public.platform_assert_core_write_enabled()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'winwidget_maintenance', 'public.platform_core_source_writes_enabled()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'winwidget_backup', 'public.platform_core_source_writes_enabled()', 'EXECUTE'
  );")"
	platform_state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_platform \
		--command "
SELECT
  (SELECT count(*) = 1
   FROM platform.service_identity
   WHERE id = 'singleton'
     AND phase = 'SHADOW'::platform.\"ServiceDatabasePhase\"
     AND source_fingerprint IS NULL
     AND source_snapshot_sha256 IS NULL
     AND source_snapshot_counts IS NULL
     AND source_high_watermark IS NULL
     AND imported_at IS NULL
     AND activated_at IS NULL)
  AND (SELECT next_value = 1 FROM platform.source_sequences WHERE id = 'platform')
  AND (SELECT count(*) = 1
       FROM platform.billing_offer_producer_state
       WHERE id = 'offer'
         AND phase = 'BLOCKED'::platform.\"OfferProducerPhase\"
         AND producer_contract_version IS NULL
         AND source_sequence_scope IS NULL
         AND imported_aggregate_version IS NULL
         AND imported_source_sequence IS NULL
         AND current_aggregate_version IS NULL
         AND current_source_sequence IS NULL
         AND source_fence_fingerprint IS NULL
         AND imported_at IS NULL
         AND activated_at IS NULL)
  AND EXISTS (
    SELECT 1
    FROM pg_attribute attribute_state
    WHERE attribute_state.attrelid = 'platform.billing_offer_producer_state'::regclass
      AND attribute_state.attname = 'producer_contract_version'
      AND attribute_state.atttypid = 'int4'::regtype
      AND attribute_state.attnum > 0
      AND NOT attribute_state.attisdropped
	  )
	  AND EXISTS (
	    SELECT 1
	    FROM pg_attribute attribute_state
	    WHERE attribute_state.attrelid = 'platform.billing_offer_producer_state'::regclass
	      AND attribute_state.attname = 'source_sequence_scope'
	      AND attribute_state.atttypid = 'text'::regtype
	      AND attribute_state.attnum > 0
	      AND NOT attribute_state.attisdropped
	  )
	  AND NOT EXISTS (
	    SELECT 1
	    FROM pg_attribute attribute_state
	    WHERE attribute_state.attrelid = 'platform.billing_offer_producer_state'::regclass
	      AND attribute_state.attname IN ('producer_high_water', 'source_offer_sequence')
	      AND attribute_state.attnum > 0
	      AND NOT attribute_state.attisdropped
	  );")"
	[[ "$core_state" == 't' && "$platform_state" == 't' ]] ||
		fail 'Platform rehearsal state, scoped offer cursor, or Core ACL contract is invalid'
	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db <<'SQL'
BEGIN;
UPDATE public.platform_core_state
SET prepared_revision = repeat('a', 40);
UPDATE public.platform_core_state
SET source_writes_enabled = FALSE,
    billing_offer_contract_version = 2,
    billing_offer_sequence_scope = 'billing.offer:offer',
    billing_offer_aggregate_version = 41,
    billing_offer_source_sequence = 870,
    billing_offer_fence_fingerprint = repeat('b', 64),
    fenced_at = CURRENT_TIMESTAMP;
DO $probe$
DECLARE rejected_constraint TEXT;
BEGIN
    BEGIN
        UPDATE public.platform_core_state
        SET source_revision = repeat('a', 40)
        WHERE id = 'singleton';
        RAISE EXCEPTION 'partial Platform export anchor was accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
        IF rejected_constraint <> 'platform_core_state_export_anchor_check' THEN
            RAISE;
        END IF;
    END;
END
$probe$;
UPDATE public.platform_core_state
SET source_revision = repeat('a', 40),
    source_fingerprint = repeat('c', 64),
    source_snapshot_sha256 = repeat('d', 64),
    source_high_watermark = 6,
    exported_at = CURRENT_TIMESTAMP;
DO $probe$
BEGIN
    BEGIN
        UPDATE public.platform_core_state
        SET source_snapshot_sha256 = repeat('e', 64)
        WHERE id = 'singleton';
        RAISE EXCEPTION 'durable Platform export anchor tampering was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        IF SQLERRM NOT LIKE '%durable export anchors are immutable%' THEN
            RAISE;
        END IF;
    END;
END
$probe$;
UPDATE public.platform_core_state
SET source_writes_enabled = TRUE,
    prepared_revision = NULL,
    source_revision = NULL,
    source_fingerprint = NULL,
    source_snapshot_sha256 = NULL,
    source_high_watermark = NULL,
    billing_offer_contract_version = NULL,
    billing_offer_sequence_scope = NULL,
    billing_offer_aggregate_version = NULL,
    billing_offer_source_sequence = NULL,
    billing_offer_fence_fingerprint = NULL,
    fenced_at = NULL,
    exported_at = NULL;
DO $probe$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.platform_core_state
        WHERE id = 'singleton'
          AND source_writes_enabled
          AND prepared_revision IS NULL
          AND source_revision IS NULL
          AND source_fingerprint IS NULL
          AND source_snapshot_sha256 IS NULL
          AND source_high_watermark IS NULL
          AND billing_offer_contract_version IS NULL
          AND billing_offer_sequence_scope IS NULL
          AND billing_offer_aggregate_version IS NULL
          AND billing_offer_source_sequence IS NULL
          AND billing_offer_fence_fingerprint IS NULL
          AND fenced_at IS NULL
          AND exported_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Platform abort did not atomically clear pre-activation anchors';
    END IF;
END
$probe$;
ROLLBACK;
SQL
	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_platform <<'SQL'
BEGIN;
DO $probe$
DECLARE rejected_constraint TEXT;
BEGIN
    BEGIN
        UPDATE platform.billing_offer_producer_state
        SET phase = 'IMPORTED',
            producer_contract_version = 1,
            source_sequence_scope = 'billing',
            imported_aggregate_version = 41,
            imported_source_sequence = 870,
            source_fence_fingerprint = repeat('a', 64),
            imported_at = CURRENT_TIMESTAMP
        WHERE id = 'offer';
        RAISE EXCEPTION 'retired Billing offer v1 producer contract was accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
        IF rejected_constraint NOT IN (
            'billing_offer_producer_versions_check',
            'billing_offer_producer_phase_check'
        ) THEN
            RAISE;
        END IF;
    END;
END
$probe$;
UPDATE platform.billing_offer_producer_state
SET phase = 'IMPORTED',
    producer_contract_version = 2,
    source_sequence_scope = 'billing.offer:offer',
    imported_aggregate_version = 41,
    imported_source_sequence = 870,
    source_fence_fingerprint = repeat('a', 64),
    imported_at = CURRENT_TIMESTAMP;
UPDATE platform.billing_offer_producer_state
SET phase = 'ACTIVE',
    current_aggregate_version = imported_aggregate_version,
    current_source_sequence = imported_source_sequence,
    activated_at = CURRENT_TIMESTAMP;
DO $probe$
BEGIN
    BEGIN
        UPDATE platform.billing_offer_producer_state
        SET current_aggregate_version = 42,
            current_source_sequence = 872
        WHERE id = 'offer';
        RAISE EXCEPTION 'Billing offer scoped cursors advanced out of lockstep';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM NOT LIKE '%cursors must advance once in lockstep%' THEN
            RAISE;
        END IF;
    END;
END
$probe$;
UPDATE platform.billing_offer_producer_state
SET current_aggregate_version = 42,
    current_source_sequence = 871;
ROLLBACK;
SQL
	status 'platform_rehearsal_contract'
}

assert_billing_core_writer_fences() {
	local stale_log="$APP_ROOT/billing-stale-writer.log"
	local writer_pid writer_visible stale_amount attempt source_removed
	source_removed="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
		--command "SELECT bool_and(to_regclass(format('public.%I', relation_name)) IS NULL) FROM unnest(ARRAY['payments','payment_receipts','subscriptions','subscription_history','subscription_expiry_reminders','auto_renewals','auto_renewal_consent_events','tariff_prices','affiliate_referrals']) AS source(relation_name);")"
	if [[ "$source_removed" == 't' ]]; then
		status 'billing_core_source_removed'
		return
	fi
	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db <<'SQL'
INSERT INTO public."User" ("id", "password", "rights", "updated_at")
VALUES ('billing-fence-referred-user', 'not-a-real-password-hash', ARRAY['USER']::public."Role"[], CURRENT_TIMESTAMP);
INSERT INTO public."payments" (
    "id", "user_id", "amount", "checkout_expires_at", "updated_at"
) VALUES (
    'billing-fence-payment', 'database-restore-rehearsal-dev', '100.00',
    CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
);
INSERT INTO public."subscriptions" ("id", "user_id", "updated_at")
VALUES ('billing-fence-subscription', 'database-restore-rehearsal-dev', CURRENT_TIMESTAMP);
INSERT INTO public."affiliate_referrals" (
    "id", "referrer_id", "referred_user_id", "updated_at"
) VALUES (
    'billing-fence-affiliate', 'database-restore-rehearsal-dev',
    'billing-fence-referred-user', CURRENT_TIMESTAMP
);
INSERT INTO public."site_settings" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

UPDATE public."payments"
SET "amount" = '101.00', "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'billing-fence-payment';
UPDATE public."subscriptions"
SET "leads_this_period" = 1, "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'billing-fence-subscription';
UPDATE public."affiliate_referrals"
SET "status" = "status", "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'billing-fence-affiliate';
UPDATE public."tariff_prices"
SET "amount" = "amount" + 1, "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'easy_monthly';

UPDATE public."billing_core_state"
SET "source_producers_enabled" = FALSE,
    "scheduler_enabled" = FALSE,
    "legacy_consumer_enabled" = FALSE,
    "projection_consumer_enabled" = TRUE,
    "prepared_revision" = repeat('a', 40),
    "generation" = 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'singleton';

DO $$
BEGIN
    BEGIN
        UPDATE public."payments" SET "amount" = 'blocked' WHERE "id" = 'billing-fence-payment';
        RAISE EXCEPTION 'frozen payment write unexpectedly succeeded';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    BEGIN
        UPDATE public."subscriptions" SET "leads_this_period" = 2 WHERE "id" = 'billing-fence-subscription';
        RAISE EXCEPTION 'frozen subscription write unexpectedly succeeded';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    BEGIN
        UPDATE public."affiliate_referrals" SET "status" = "status" WHERE "id" = 'billing-fence-affiliate';
        RAISE EXCEPTION 'frozen affiliate write unexpectedly succeeded';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    BEGIN
        UPDATE public."tariff_prices" SET "amount" = "amount" + 1 WHERE "id" = 'easy_monthly';
        RAISE EXCEPTION 'frozen tariff write unexpectedly succeeded';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
END;
$$;

UPDATE public."site_settings"
SET "banner_enabled" = TRUE,
    "banner_text" = 'billing-fence-core-banner',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'singleton';
DO $$
BEGIN
    BEGIN
        UPDATE public."site_settings"
        SET "payment_enabled" = NOT "payment_enabled"
        WHERE "id" = 'singleton';
        RAISE EXCEPTION 'frozen Billing settings write unexpectedly succeeded';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
END;
$$;

UPDATE public."billing_core_state"
SET "source_producers_enabled" = TRUE,
    "scheduler_enabled" = TRUE,
    "legacy_consumer_enabled" = TRUE,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'singleton';
UPDATE public."payments"
SET "amount" = '102.00', "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'billing-fence-payment';
SQL

	(
		docker exec -e PGAPPNAME=billing-stale-writer-rehearsal \
			"$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
			--command "BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT count(*) FROM public.\"payments\"; SELECT pg_sleep(4); UPDATE public.\"payments\" SET \"amount\" = 'stale-writer-crossed' WHERE \"id\" = 'billing-fence-payment'; COMMIT;"
	) >"$stale_log" 2>&1 &
	writer_pid=$!
	writer_visible='false'
	for ((attempt = 1; attempt <= 50; attempt++)); do
		if [[ "$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
			--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
			--command "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'billing-stale-writer-rehearsal' AND wait_event = 'PgSleep';")" == '1' ]]; then
			writer_visible='true'
			break
		fi
		sleep 0.1
	done
	[[ "$writer_visible" == 'true' ]] || {
		wait "$writer_pid" || true
		fail 'stale Serializable Billing writer did not reach its pre-freeze snapshot'
	}
	docker exec "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
		--command "UPDATE public.\"billing_core_state\" SET \"source_producers_enabled\" = FALSE, \"scheduler_enabled\" = FALSE, \"legacy_consumer_enabled\" = FALSE, \"updated_at\" = CURRENT_TIMESTAMP WHERE \"id\" = 'singleton';" >/dev/null
	if wait "$writer_pid"; then
		fail 'stale Serializable Billing writer crossed the frozen snapshot'
	fi
	stale_amount="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db \
		--command "SELECT \"amount\" FROM public.\"payments\" WHERE \"id\" = 'billing-fence-payment';")"
	[[ "$stale_amount" == '102.00' ]] ||
		fail 'stale Serializable Billing writer changed the frozen source row'
	rm -f -- "$stale_log"

	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname default_db <<'SQL'
UPDATE public."billing_core_state"
SET "source_producers_enabled" = TRUE,
    "scheduler_enabled" = TRUE,
    "legacy_consumer_enabled" = TRUE,
    "prepared_revision" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'singleton';
UPDATE public."tariff_prices"
SET "amount" = 990, "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'easy_monthly';
UPDATE public."site_settings"
SET "banner_enabled" = FALSE,
    "banner_text" = '',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'singleton';
DELETE FROM public."affiliate_referrals" WHERE "id" = 'billing-fence-affiliate';
DELETE FROM public."subscriptions" WHERE "id" = 'billing-fence-subscription';
DELETE FROM public."payments" WHERE "id" = 'billing-fence-payment';
DELETE FROM public."User" WHERE "id" = 'billing-fence-referred-user';
SQL
	status 'billing_core_writer_fences'
}

create_target_dump() {
	local target="$1" output_name="${2:-$1.dump}" database schema role password dump_path size
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	role="$(target_backup_role "$target")"
	password="$(target_backup_password "$target")"
	dump_path="$APP_ROOT/dumps/$output_name"
	docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		pg_dump --format=custom --compress=6 --no-owner --no-acl --no-password \
			--host 127.0.0.1 --port 5432 --username "$role" \
			--schema "$schema" "$database" >"$dump_path"
	chmod 0444 "$dump_path"
	size="$(file_size_bytes "$dump_path")"
	[[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 && "$size" -le "$MAX_UPLOAD_BYTES" ]] ||
		fail "dump size is outside the queue contract for $target"
	utility_run \
		--network none \
		--mount "type=bind,source=$APP_ROOT/dumps,target=/dumps,readonly" \
		--entrypoint pg_restore \
		"$RUNNER_IMAGE" --list "/dumps/$output_name" >/dev/null
	unset password
}

create_baseline_dumps() {
	local target
	for target in support notification-delivery campaigns reporting widgets billing identity platform operations; do
		create_target_dump "$target"
	done
	status 'custom_dumps'
}

marker_value() {
	local target="$1" database schema
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname "$database" \
		--command "SELECT value FROM \"$schema\".restore_rehearsal_marker WHERE id = 'canonical';"
}

assert_marker() {
	local target="$1" expected="$2" actual
	actual="$(marker_value "$target")"
	[[ "$actual" == "$expected" ]] ||
		fail "marker mismatch for $target: expected $expected, got $actual"
}

assert_marker_matrix() {
	assert_marker support "$1"
	assert_marker notification-delivery "$2"
	assert_marker campaigns "$3"
	assert_marker reporting "$4"
	assert_marker widgets "$5"
	assert_marker billing "$6"
	assert_marker identity "$7"
	assert_marker platform "$8"
	assert_marker operations "$9"
}

mutate_markers() {
	local target database schema
	for target in support notification-delivery campaigns reporting widgets billing identity platform operations; do
		database="$(target_database "$target")"
		schema="$(target_schema "$target")"
		docker exec "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--username winwidget_restore_rehearsal_bootstrap --dbname "$database" \
			--command "UPDATE \"$schema\".restore_rehearsal_marker SET value = 'mutated-$target' WHERE id = 'canonical';" >/dev/null
	done
	assert_marker_matrix 'mutated-support' 'mutated-notification-delivery' 'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	status 'live_mutation'
}

publish_job() {
	local target="$1" dump_name="$2" confirmation job_id
	confirmation="$(target_confirmation "$target")"
	job_id="$(utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore" \
		--mount "type=bind,source=$APP_ROOT/dumps,target=/dumps,readonly" \
		-e MODE=production \
		-e DATABASE_RESTORE_PRODUCTION_ENABLED=true \
		-e APP_REVISION="$REVISION" \
		-e DATABASE_RESTORE_STORAGE_DIR=/restore \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		--entrypoint node \
		"$RUNNER_IMAGE" -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseRestoreQueueService } = require("/app/dist/src/dev-tools/database-restore-queue.service.js");
const {
  DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
  parseAndVerifyDatabaseRestoreGlobalGate,
  parseAndVerifyDatabaseRestoreProductionPermit,
  parseAndVerifyDatabaseRestorePublishReceipt,
  signDatabaseRestoreProductionPermit
} = require("/app/dist/src/dev-tools/database-restore-queue.contract.js");
const [dumpPath, target, confirmation, requestedBy] = process.argv.slice(1);
const buffer = fs.readFileSync(dumpPath);
const service = new DatabaseRestoreQueueService();
const jobId = crypto.randomUUID();
const permit = signDatabaseRestoreProductionPermit({
  version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
  kind: "DATABASE_RESTORE_PRODUCTION_PERMIT",
  appRevision: process.env.APP_REVISION,
  target,
  jobId,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  runId: `database-restore-rehearsal-${jobId}`,
  evidence: `four-target-rehearsal-${target}`,
  incident: "2024"
}, process.env.DATABASE_RESTORE_QUEUE_SECRET);
process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = JSON.stringify(permit);
service.enqueue(
  target,
  { buffer, size: buffer.length, originalname: `rehearsal-${target}.dump` },
  confirmation,
  requestedBy,
  async job => {
    if (job.target !== target || job.status !== "QUEUED" || !job.canCancel) {
      throw new Error("queue beforePublish contract mismatch");
    }
  },
  jobId,
  async publication => {
    if (
      publication.job.jobId !== jobId ||
      publication.job.target !== target ||
      publication.manifestStatus !== "QUEUED" ||
      publication.productionPermit?.permitSignature !== permit.signature
    ) {
      throw new Error("queue afterPublish contract mismatch");
    }
    return { auditEventId: `database_restore_publish_${jobId}` };
  }
).then(job => {
  if (job.jobId !== jobId || !job.publicationConfirmed) {
    throw new Error("queue did not return a publication-confirmed exact job");
  }
  const receipt = parseAndVerifyDatabaseRestorePublishReceipt(
    fs.readFileSync(path.join("/restore", "receipts", `${jobId}.json`), "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  const consumed = parseAndVerifyDatabaseRestoreProductionPermit(
    fs.readFileSync(path.join("/restore", "permits", `${jobId}.consumed.json`), "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  const globalGate = parseAndVerifyDatabaseRestoreGlobalGate(
    fs.readFileSync(path.join("/restore", "locks", "global.lock"), "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  if (
    receipt.jobId !== jobId ||
    receipt.target !== target ||
    receipt.permitSignature !== permit.signature ||
    consumed.signature !== permit.signature ||
    globalGate.jobId !== jobId ||
    globalGate.target !== target ||
    fs.existsSync(path.join("/restore", "permits", "active.json"))
  ) {
    throw new Error("one-shot production publication artifacts are inconsistent");
  }
  process.stdout.write(job.jobId);
}).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
' "/dumps/$dump_name" "$target" "$confirmation" "$REQUESTED_BY")"
	[[ "$job_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
		fail "queue returned an invalid job id for $target"
	printf '%s' "$job_id"
}

publish_job_without_receipt() {
	local target="$1" dump_name="$2" confirmation job_id
	confirmation="$(target_confirmation "$target")"
	job_id="$(utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore" \
		--mount "type=bind,source=$APP_ROOT/dumps,target=/dumps,readonly" \
		-e MODE=production \
		-e DATABASE_RESTORE_PRODUCTION_ENABLED=true \
		-e APP_REVISION="$REVISION" \
		-e DATABASE_RESTORE_STORAGE_DIR=/restore \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		--entrypoint node \
		"$RUNNER_IMAGE" -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseRestoreQueueService } = require("/app/dist/src/dev-tools/database-restore-queue.service.js");
const {
  DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
  parseAndVerifyDatabaseRestoreGlobalGate,
  parseAndVerifyDatabaseRestoreProductionPermit,
  signDatabaseRestoreProductionPermit
} = require("/app/dist/src/dev-tools/database-restore-queue.contract.js");
const [dumpPath, target, confirmation, requestedBy] = process.argv.slice(1);
const buffer = fs.readFileSync(dumpPath);
const service = new DatabaseRestoreQueueService();
const jobId = crypto.randomUUID();
const permit = signDatabaseRestoreProductionPermit({
  version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
  kind: "DATABASE_RESTORE_PRODUCTION_PERMIT",
  appRevision: process.env.APP_REVISION,
  target,
  jobId,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  runId: `database-restore-crash-boundary-${jobId}`,
  evidence: "manifest-durable-receipt-missing",
  incident: "2024"
}, process.env.DATABASE_RESTORE_QUEUE_SECRET);
process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = JSON.stringify(permit);
(async () => {
  let publicationError = null;
  try {
    await service.enqueue(
      target,
      { buffer, size: buffer.length, originalname: `rehearsal-${target}.dump` },
      confirmation,
      requestedBy,
      async () => undefined,
      jobId,
      async () => {
        throw new Error("simulated afterPublish receipt failure");
      }
    );
  } catch (error) {
    publicationError = error;
  }
  if (publicationError?.message !== "simulated afterPublish receipt failure") {
    throw publicationError || new Error("missing simulated publication failure");
  }
  const job = await service.getJob(jobId);
  const active = parseAndVerifyDatabaseRestoreProductionPermit(
    fs.readFileSync(path.join("/restore", "permits", "active.json"), "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  const globalGate = parseAndVerifyDatabaseRestoreGlobalGate(
    fs.readFileSync(path.join("/restore", "locks", "global.lock"), "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  if (
    job.status !== "QUEUED" ||
    job.publicationConfirmed ||
    active.signature !== permit.signature ||
    globalGate.jobId !== jobId ||
    fs.existsSync(path.join("/restore", "receipts", `${jobId}.json`))
  ) {
    throw new Error("receipt-failure crash boundary is inconsistent");
  }
  process.stdout.write(jobId);
})().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
' "/dumps/$dump_name" "$target" "$confirmation" "$REQUESTED_BY")"
	[[ "$job_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
		fail 'receipt-failure queue returned an invalid job id'
	printf '%s' "$job_id"
}

retry_job_publication() {
	local job_id="$1" target="$2" dump_name="$3" confirmation result
	confirmation="$(target_confirmation "$target")"
	result="$(utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore" \
		--mount "type=bind,source=$APP_ROOT/dumps,target=/dumps,readonly" \
		-e MODE=production \
		-e DATABASE_RESTORE_PRODUCTION_ENABLED=true \
		-e APP_REVISION="$REVISION" \
		-e DATABASE_RESTORE_STORAGE_DIR=/restore \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		--entrypoint node \
		"$RUNNER_IMAGE" -e '
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseRestoreQueueService } = require("/app/dist/src/dev-tools/database-restore-queue.service.js");
const {
  parseAndVerifyDatabaseRestoreProductionPermit,
  parseAndVerifyDatabaseRestorePublishReceipt
} = require("/app/dist/src/dev-tools/database-restore-queue.contract.js");
const [dumpPath, target, confirmation, requestedBy, jobId] = process.argv.slice(1);
const buffer = fs.readFileSync(dumpPath);
const activePath = path.join("/restore", "permits", "active.json");
const rawPermit = fs.readFileSync(activePath, "utf8");
const permit = parseAndVerifyDatabaseRestoreProductionPermit(
  rawPermit,
  process.env.DATABASE_RESTORE_QUEUE_SECRET
);
process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = rawPermit.trim();
const service = new DatabaseRestoreQueueService();
service.enqueue(
  target,
  { buffer, size: buffer.length, originalname: `rehearsal-${target}.dump` },
  confirmation,
  requestedBy,
  async () => {
    throw new Error("exact publication retry unexpectedly repeated beforePublish");
  },
  jobId,
  async publication => {
    if (publication.productionPermit?.permitSignature !== permit.signature) {
      throw new Error("exact publication retry lost its permit identity");
    }
    return { auditEventId: `database_restore_publish_${jobId}` };
  }
).then(job => {
  const receipt = parseAndVerifyDatabaseRestorePublishReceipt(
    fs.readFileSync(path.join("/restore", "receipts", `${jobId}.json`), "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  if (
    job.jobId !== jobId ||
    !job.publicationConfirmed ||
    receipt.permitSignature !== permit.signature ||
    fs.existsSync(activePath)
  ) {
    throw new Error("exact publication retry was not durably confirmed");
  }
  process.stdout.write(job.jobId);
}).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
' "/dumps/$dump_name" "$target" "$confirmation" "$REQUESTED_BY" "$job_id")"
	[[ "$result" == "$job_id" ]] || fail 'exact publication retry returned another job id'
}

cancel_job() {
	local job_id="$1" result
	result="$(utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore" \
		-e MODE=production \
		-e DATABASE_RESTORE_PRODUCTION_ENABLED=true \
		-e DATABASE_RESTORE_STORAGE_DIR=/restore \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		--entrypoint node \
		"$RUNNER_IMAGE" -e '
const { DatabaseRestoreQueueService } = require("/app/dist/src/dev-tools/database-restore-queue.service.js");
const jobId = process.argv[1];
const service = new DatabaseRestoreQueueService();
service.cancel(jobId, async job => {
  if (job.jobId !== jobId || !job.cancellationPending || job.canCancel) {
    throw new Error("queue cancellation reservation contract mismatch");
  }
}).then(job => {
  if (!job.cancellationRequested) throw new Error("cancellation was not durably requested");
  process.stdout.write(job.jobId);
}).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
' "$job_id")"
	[[ "$result" == "$job_id" ]] || fail 'queued cancellation returned another job'
}

start_worker() {
	docker run -d \
		--name "$WORKER_CONTAINER" \
		--label "$OWNER_LABEL" \
		--label "$RUN_LABEL" \
		--network host \
		--read-only \
		--init \
		--stop-timeout 45 \
		--security-opt no-new-privileges:true \
		--cap-drop ALL \
		--cap-add CHOWN \
		--cap-add KILL \
		--cap-add SETGID \
		--cap-add SETUID \
		--mount "type=volume,source=$RESTORE_VOLUME,target=$STORAGE_PATH" \
		--mount "type=bind,source=$APP_ROOT/secrets/notification-admin,target=/run/secrets/database-restore-notification-delivery-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/campaigns-admin,target=/run/secrets/database-restore-campaigns-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/reporting-admin,target=/run/secrets/database-restore-reporting-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/widgets-admin,target=/run/secrets/database-restore-widgets-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/billing-admin,target=/run/secrets/database-restore-billing-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/identity-admin,target=/run/secrets/database-restore-identity-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/platform-admin,target=/run/secrets/database-restore-platform-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/support-admin,target=/run/secrets/database-restore-support-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/secrets/operations-admin,target=/run/secrets/database-restore-operations-admin-password,readonly" \
		--mount "type=bind,source=$APP_ROOT/wrappers,target=/rehearsal-bin,readonly" \
		--tmpfs /run/database-restore-secrets:rw,noexec,nosuid,nodev,size=64k,mode=0700 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777 \
		-e APP_REVISION="$REVISION" \
		-e NODE_ENV=production \
		-e MODE=production \
		-e PATH=/rehearsal-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
		-e DATABASE_RESTORE_STORAGE_DIR="$STORAGE_PATH" \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		-e DATABASE_RESTORE_POLL_INTERVAL_MS=250 \
		-e DATABASE_RESTORE_COMMAND_TIMEOUT_MS=1800000 \
		-e DATABASE_RESTORE_MIGRATIONS_ROOT=/app \
		-e DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT="$NOTIFICATION_PORT" \
		-e DATABASE_RESTORE_CAMPAIGNS_PORT="$CAMPAIGNS_PORT" \
		-e DATABASE_RESTORE_REPORTING_PORT="$REPORTING_PORT" \
		-e DATABASE_RESTORE_WIDGETS_PORT="$WIDGETS_PORT" \
		-e DATABASE_RESTORE_BILLING_PORT="$BILLING_PORT" \
		-e DATABASE_RESTORE_IDENTITY_PORT="$IDENTITY_PORT" \
		-e DATABASE_RESTORE_PLATFORM_PORT="$PLATFORM_PORT" \
		-e DATABASE_RESTORE_SUPPORT_PORT="$SUPPORT_PORT" \
		-e DATABASE_RESTORE_OPERATIONS_PORT="$OPERATIONS_PORT" \
		-e DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/notification-delivery-admin-password \
		-e DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/campaigns-admin-password \
		-e DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/reporting-admin-password \
		-e DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/widgets-admin-password \
		-e DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/billing-admin-password \
		-e DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/identity-admin-password \
		-e DATABASE_RESTORE_PLATFORM_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/platform-admin-password \
		-e DATABASE_RESTORE_SUPPORT_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/support-admin-password \
		-e DATABASE_RESTORE_OPERATIONS_ADMIN_PASSWORD_FILE=/run/database-restore-secrets/operations-admin-password \
		"$RUNNER_IMAGE" >/dev/null
	container_is_owned "$WORKER_CONTAINER" || fail 'worker labels are invalid'
	local attempt
	for ((attempt = 1; attempt <= 120; attempt++)); do
		if worker_exec test -f "$STORAGE_PATH/worker-ready.json" 2>/dev/null; then
			status 'worker_ready'
			return
		fi
		if [[ "$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || true)" != 'true' ]]; then
			docker inspect --format 'database_restore_rehearsal_worker_state=exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' \
				"$WORKER_CONTAINER" >&2 || true
			docker logs --tail 200 "$WORKER_CONTAINER" >&2 || true
			fail 'database restore worker exited before readiness'
		fi
		sleep 1
	done
	fail 'database restore worker did not become ready'
}

clear_worker_command_audit() {
	worker_exec sh -euc ': >"$1"' sh \
		"$COMMAND_AUDIT_PATH"
}

assert_worker_command_audit_empty() {
	if ! worker_exec test ! -s \
		"$COMMAND_AUDIT_PATH"; then
		worker_exec cat \
			"$COMMAND_AUDIT_PATH" >&2 || true
		fail 'worker executed a PostgreSQL command before publication receipt'
	fi
}

wait_job_settled() {
	local job_id="$1" target="$2" attempt
	for ((attempt = 1; attempt <= 2400; attempt++)); do
		if worker_exec test -f "$STORAGE_PATH/terminal/$job_id.json" 2>/dev/null &&
			worker_exec test ! -e "$STORAGE_PATH/locks/$target.lock" 2>/dev/null &&
			worker_exec test ! -e "$STORAGE_PATH/locks/global.lock" 2>/dev/null; then
			return
		fi
		[[ "$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || true)" == 'true' ]] ||
			fail "worker exited while waiting for job $job_id"
		sleep 0.25
	done
	fail "job did not settle: $job_id"
}

verify_terminal() {
	local job_id="$1" target="$2" expected_status="$3" expected_error="${4:-}"
	utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore,readonly" \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		--entrypoint node \
		"$RUNNER_IMAGE" -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  parseAndVerifyDatabaseRestoreGlobalGate,
  parseAndVerifyDatabaseRestoreJobManifest,
  parseAndVerifyDatabaseRestoreTargetLock
} = require("/app/dist/src/dev-tools/database-restore-queue.contract.js");
const [jobId, target, expectedStatus, expectedError] = process.argv.slice(1);
const root = "/restore";
const manifest = parseAndVerifyDatabaseRestoreJobManifest(
  fs.readFileSync(path.join(root, "terminal", `${jobId}.json`), "utf8"),
  process.env.DATABASE_RESTORE_QUEUE_SECRET
);
if (manifest.jobId !== jobId || manifest.target !== target || manifest.status !== expectedStatus) {
  throw new Error("terminal identity or status mismatch");
}
if (expectedError && manifest.error?.code !== expectedError) {
  throw new Error("terminal error code mismatch");
}
if (expectedStatus === "SUCCEEDED") {
  if (manifest.error !== null || !manifest.result?.restoredAt || !manifest.result?.verifiedAt) {
    throw new Error("successful terminal result is incomplete");
  }
}
if (expectedStatus === "CANCELLED" && (manifest.error !== null || manifest.result !== null)) {
  throw new Error("cancelled terminal result is incoherent");
}
if (expectedError === "DUMP_TARGET_MISMATCH" && manifest.result !== null) {
  throw new Error("target mismatch crossed the safety-backup boundary");
}
if (manifest.result) {
  const safetyName = manifest.result.safetyBackupFileName;
  if (path.basename(safetyName) !== safetyName) throw new Error("unsafe safety backup name");
  const safety = fs.readFileSync(path.join(root, "terminal", safetyName));
  const sha256 = crypto.createHash("sha256").update(safety).digest("hex");
  if (sha256 !== manifest.result.safetyBackupSha256) {
    throw new Error("safety backup checksum mismatch");
  }
} else if (expectedStatus === "SUCCEEDED") {
  throw new Error("successful restore has no safety backup");
}
const lockPath = path.join(root, "locks", `${target}.lock`);
const globalGatePath = path.join(root, "locks", "global.lock");
const fencePath = path.join(root, "fences", `${target}.json`);
const uploadPath = path.join(root, "uploads", `${jobId}.dump`);
for (const artifact of [
  path.join(root, "queued", `${jobId}.json`),
  path.join(root, "processing", `${jobId}.json`),
  path.join(root, "processing", `${jobId}.state`),
  path.join(root, "processing", `${jobId}.publication`)
]) {
  if (fs.existsSync(artifact)) throw new Error(`terminal job retained ${artifact}`);
}
if (expectedStatus === "FAILED_FENCED") {
  if (fs.existsSync(path.join(root, "worker-ready.json"))) {
    throw new Error("stopped worker retained its readiness marker");
  }
  const lock = parseAndVerifyDatabaseRestoreTargetLock(
    fs.readFileSync(lockPath, "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  const fence = parseAndVerifyDatabaseRestoreTargetLock(
    fs.readFileSync(fencePath, "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  const globalGate = parseAndVerifyDatabaseRestoreGlobalGate(
    fs.readFileSync(globalGatePath, "utf8"),
    process.env.DATABASE_RESTORE_QUEUE_SECRET
  );
  if (
    lock.jobId !== jobId ||
    fence.jobId !== jobId ||
    globalGate.jobId !== jobId ||
    lock.target !== target ||
    fence.target !== target ||
    globalGate.target !== target
  ) {
    throw new Error("FAILED_FENCED lock or fence identity mismatch");
  }
  const uploadSha = crypto.createHash("sha256").update(fs.readFileSync(uploadPath)).digest("hex");
  if (uploadSha !== manifest.sha256) throw new Error("FAILED_FENCED upload checksum mismatch");
} else {
  const completedArtifacts = [
    lockPath,
    globalGatePath,
    fencePath,
    uploadPath,
    path.join(root, "processing", `safety-${jobId}.dump`),
    ...(expectedStatus === "SUCCEEDED"
      ? []
      : [path.join(root, "terminal", `safety-${jobId}.dump`)]),
    ...["cancellable", "cancel-pending", "cancelled", "destructive"].map(
      suffix => path.join(root, "gates", `${jobId}.${suffix}`)
    )
  ];
  for (const artifact of completedArtifacts) {
    if (fs.existsSync(artifact)) throw new Error(`completed job retained ${artifact}`);
  }
}
process.stdout.write(manifest.sha256);
' "$job_id" "$target" "$expected_status" "$expected_error"
}

verify_safety_backup_restore() {
	local job_id="$1" target="$2" expected_marker="$3"
	local schema admin port password safety_name scratch_database marker
	schema="$(target_schema "$target")"
	admin="$(target_admin_role "$target")"
	port="$(target_port "$target")"
	password="$(target_admin_password "$target")"
	safety_name="safety-$job_id.dump"
	scratch_database='winwidget_restore_rehearsal_scratch'

	utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore,readonly" \
		--entrypoint pg_restore \
		"$RUNNER_IMAGE" --list "/restore/terminal/$safety_name" >/dev/null

	docker exec "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
		--command "CREATE DATABASE \"$scratch_database\" OWNER \"$admin\" TEMPLATE template0 ENCODING 'UTF8';" >/dev/null
	utility_run \
		--network host \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore,readonly" \
		-e "PGPASSWORD=$password" \
		--entrypoint pg_restore \
		"$RUNNER_IMAGE" \
		--exit-on-error \
		--single-transaction \
		--clean \
		--if-exists \
		--no-owner \
		--no-privileges \
		--no-password \
		--host 127.0.0.1 \
		--port "$port" \
		--username "$admin" \
		--dbname "$scratch_database" \
		"/restore/terminal/$safety_name"
	marker="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname "$scratch_database" \
		--command "SELECT value FROM \"$schema\".restore_rehearsal_marker WHERE id = 'canonical';")"
	[[ "$marker" == "$expected_marker" ]] ||
		fail "safety backup marker mismatch for $target: expected $expected_marker, got $marker"
	docker exec "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
		--command "DROP DATABASE \"$scratch_database\";" >/dev/null
	unset password
	status "safety_backup_restore_${target//-/_}"
}

verify_migration_ledger() {
	local target="$1" database schema directory expected='' actual migration_dir name checksum
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	directory="$(target_migrations_directory "$target")"
	for migration_dir in "$directory"/*; do
		[[ -d "$migration_dir" && -f "$migration_dir/migration.sql" ]] || continue
		name="$(basename "$migration_dir")"
		[[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || continue
		checksum="$(sha256_file "$migration_dir/migration.sql")"
		expected+="$name|$checksum"$'\n'
	done
	expected="${expected%$'\n'}"
	actual="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname "$database" \
		--command "SELECT migration_name || '|' || checksum FROM \"$schema\"._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;")"
	[[ -n "$expected" && "$actual" == "$expected" ]] ||
		fail "Prisma migration ledger mismatch for $target"
}

verify_independent_catalog_acl_matrix() {
	local target="$1" database schema admin migration runtime backup roles_sql state
	local runtime_writable_table_predicate
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	admin="$(target_admin_role "$target")"
	migration="$(target_migration_role "$target")"
	runtime="$(target_runtime_role "$target")"
	backup="$(target_backup_role "$target")"
	roles_sql="$(target_application_roles_sql "$target")"
	if [[ "$target" == operations ]]; then
		runtime_writable_table_predicate="relation.relname <> ALL(ARRAY['_prisma_migrations', 'operations_ownership_state'])"
	else
		runtime_writable_table_predicate="relation.relname <> '_prisma_migrations'"
	fi
	state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname "$database" \
		--command "
WITH settings AS (
  SELECT
    d.oid AS database_oid,
    d.datdba AS database_owner,
    n.oid AS schema_oid,
    n.nspowner AS schema_owner,
    to_regrole('$admin')::oid AS admin_oid,
    to_regrole('$migration')::oid AS migration_oid,
    to_regrole('$runtime')::oid AS runtime_oid,
    to_regrole('$backup')::oid AS backup_oid
  FROM pg_database d
  JOIN pg_namespace n ON n.nspname = '$schema'
  WHERE d.datname = current_database()
),
all_relations AS (
  SELECT c.oid, c.relname, c.relkind, c.relowner, c.relacl
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '$schema'
),
table_relations AS (
  SELECT * FROM all_relations WHERE relkind IN ('r', 'p', 'v', 'm', 'f')
),
sequence_relations AS (
  SELECT * FROM all_relations WHERE relkind = 'S'
),
routines AS (
  SELECT p.oid, p.proowner, p.proacl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = '$schema'
),
expected_database_acl AS (
  SELECT s.database_oid AS object_oid, role_state.oid AS grantee,
    'CONNECT'::text AS privilege_type, false AS is_grantable
  FROM settings s
  JOIN pg_roles role_state ON role_state.rolname IN ($roles_sql)
),
actual_database_acl AS (
  SELECT d.oid AS object_oid, privilege.grantee, privilege.privilege_type,
    privilege.is_grantable
  FROM pg_database d
  CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) privilege
  WHERE d.datname = current_database()
    AND privilege.grantee <> d.datdba
),
expected_schema_acl AS (
  SELECT s.schema_oid AS object_oid, s.runtime_oid AS grantee,
    'USAGE'::text AS privilege_type, false AS is_grantable FROM settings s
  UNION ALL
  SELECT s.schema_oid, s.backup_oid, 'USAGE', false FROM settings s
),
actual_schema_acl AS (
  SELECT n.oid AS object_oid, privilege.grantee, privilege.privilege_type,
    privilege.is_grantable
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) privilege
  WHERE n.nspname = '$schema'
    AND privilege.grantee <> n.nspowner
),
expected_relation_acl AS (
  SELECT relation.oid AS object_oid, s.runtime_oid AS grantee,
    'SELECT'::text AS privilege_type, false AS is_grantable
  FROM table_relations relation
  CROSS JOIN settings s
  WHERE relation.relname <> '_prisma_migrations'
  UNION ALL
  SELECT relation.oid, s.runtime_oid,
    privilege.privilege_type, false
  FROM table_relations relation
  CROSS JOIN settings s
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) privilege(privilege_type)
  WHERE $runtime_writable_table_predicate
  UNION ALL
  SELECT relation.oid, s.backup_oid, 'SELECT', false
  FROM table_relations relation CROSS JOIN settings s
),
actual_relation_acl AS (
  SELECT relation.oid AS object_oid, privilege.grantee,
    privilege.privilege_type, privilege.is_grantable
  FROM table_relations relation
  CROSS JOIN LATERAL aclexplode(
    COALESCE(relation.relacl, acldefault('r', relation.relowner))
  ) privilege
  WHERE privilege.grantee <> relation.relowner
),
expected_sequence_acl AS (
  SELECT sequence.oid AS object_oid, s.runtime_oid AS grantee,
    privilege.privilege_type, false AS is_grantable
  FROM sequence_relations sequence
  CROSS JOIN settings s
  CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) privilege(privilege_type)
  UNION ALL
  SELECT sequence.oid, s.backup_oid, 'SELECT', false
  FROM sequence_relations sequence CROSS JOIN settings s
),
actual_sequence_acl AS (
  SELECT sequence.oid AS object_oid, privilege.grantee,
    privilege.privilege_type, privilege.is_grantable
  FROM sequence_relations sequence
  CROSS JOIN LATERAL aclexplode(
    COALESCE(sequence.relacl, acldefault('S', sequence.relowner))
  ) privilege
  WHERE privilege.grantee <> sequence.relowner
),
expected_function_signatures AS (
  SELECT signature, to_regprocedure(signature) AS object_oid
  FROM unnest(ARRAY[]::text[]) expected(signature)
),
expected_function_acl AS (
  SELECT expected.object_oid, s.runtime_oid AS grantee,
    'EXECUTE'::text AS privilege_type, false AS is_grantable
  FROM expected_function_signatures expected
  CROSS JOIN settings s
  WHERE expected.object_oid IS NOT NULL
),
actual_function_acl AS (
  SELECT routine.oid AS object_oid, privilege.grantee,
    privilege.privilege_type, privilege.is_grantable
  FROM routines routine
  CROSS JOIN LATERAL aclexplode(
    COALESCE(routine.proacl, acldefault('f', routine.proowner))
  ) privilege
  WHERE privilege.grantee <> routine.proowner
),
expected_default_acl AS (
  SELECT s.migration_oid AS owner_oid, 'r'::text AS object_type,
    s.runtime_oid AS grantee, privilege.privilege_type, false AS is_grantable
  FROM settings s
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) privilege(privilege_type)
  UNION ALL
  SELECT s.migration_oid, 'r', s.backup_oid, 'SELECT', false FROM settings s
  UNION ALL
  SELECT s.migration_oid, 'S', s.runtime_oid, privilege.privilege_type, false
  FROM settings s
  CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) privilege(privilege_type)
  UNION ALL
  SELECT s.migration_oid, 'S', s.backup_oid, 'SELECT', false FROM settings s
),
actual_default_acl AS (
  SELECT defaults.defaclrole AS owner_oid,
    defaults.defaclobjtype::text AS object_type, privilege.grantee,
    privilege.privilege_type, privilege.is_grantable
  FROM pg_default_acl defaults
  CROSS JOIN settings s
  CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
  WHERE defaults.defaclnamespace = s.schema_oid
    AND privilege.grantee <> defaults.defaclrole
),
checks AS (
  SELECT
  EXISTS (SELECT 1 FROM settings) AS settings_present,
  NOT EXISTS (
    SELECT 1 FROM settings
    WHERE database_owner <> admin_oid OR schema_owner <> migration_oid
  ) AS database_schema_owners_exact,
  NOT EXISTS (
    SELECT 1 FROM all_relations relation CROSS JOIN settings s
    WHERE relation.relowner <> s.migration_oid
  ) AS relation_owners_exact,
  NOT EXISTS (
    SELECT 1 FROM routines routine CROSS JOIN settings s
    WHERE routine.proowner <> s.migration_oid
  ) AS routine_owners_exact,
  NOT EXISTS (
    SELECT 1
    FROM pg_type type_state
    JOIN pg_namespace n ON n.oid = type_state.typnamespace
    CROSS JOIN settings s
    WHERE n.nspname = '$schema'
      AND type_state.typtype IN ('d', 'e')
      AND type_state.typowner <> s.migration_oid
  ) AS type_owners_exact,
  NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute_state
    JOIN table_relations relation ON relation.oid = attribute_state.attrelid
    CROSS JOIN LATERAL aclexplode(attribute_state.attacl) privilege
    WHERE attribute_state.attnum > 0
      AND NOT attribute_state.attisdropped
      AND privilege.grantee <> relation.relowner
  ) AS column_acl_exact,
  NOT EXISTS (
    SELECT 1 FROM expected_function_signatures WHERE object_oid IS NULL
  ) AS required_functions_present,
  NOT EXISTS (
    (
      SELECT expected.object_type
      FROM (VALUES ('r'::text), ('S'::text)) expected(object_type)
      EXCEPT
      SELECT DISTINCT defaults.defaclobjtype::text
      FROM pg_default_acl defaults CROSS JOIN settings s
      WHERE defaults.defaclnamespace = s.schema_oid
        AND defaults.defaclrole = s.migration_oid
    )
    UNION ALL
    (
      SELECT DISTINCT defaults.defaclobjtype::text
      FROM pg_default_acl defaults CROSS JOIN settings s
      WHERE defaults.defaclnamespace = s.schema_oid
        AND defaults.defaclrole = s.migration_oid
      EXCEPT
      SELECT expected.object_type
      FROM (VALUES ('r'::text), ('S'::text)) expected(object_type)
    )
  ) AS default_acl_object_types_exact,
  NOT EXISTS (
    SELECT 1 FROM pg_default_acl defaults CROSS JOIN settings s
    WHERE defaults.defaclnamespace = s.schema_oid
      AND defaults.defaclrole <> s.migration_oid
  ) AS default_acl_owner_exact,
  (
    SELECT count(*) = 1
      AND bool_and(
        privilege.grantor = s.migration_oid
        AND privilege.grantee = s.migration_oid
        AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable
      )
    FROM settings s
    JOIN pg_default_acl defaults
      ON defaults.defaclrole = s.migration_oid
     AND defaults.defaclnamespace = 0
     AND defaults.defaclobjtype = 'f'
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
  ) AS global_function_default_acl_exact,
  NOT EXISTS (
    (SELECT * FROM expected_database_acl EXCEPT SELECT * FROM actual_database_acl)
    UNION ALL
    (SELECT * FROM actual_database_acl EXCEPT SELECT * FROM expected_database_acl)
  ) AS database_acl_exact,
  NOT EXISTS (
    (SELECT * FROM expected_schema_acl EXCEPT SELECT * FROM actual_schema_acl)
    UNION ALL
    (SELECT * FROM actual_schema_acl EXCEPT SELECT * FROM expected_schema_acl)
  ) AS schema_acl_exact,
  NOT EXISTS (
    (SELECT * FROM expected_relation_acl EXCEPT SELECT * FROM actual_relation_acl)
    UNION ALL
    (SELECT * FROM actual_relation_acl EXCEPT SELECT * FROM expected_relation_acl)
  ) AS relation_acl_exact,
  NOT EXISTS (
    (SELECT * FROM expected_sequence_acl EXCEPT SELECT * FROM actual_sequence_acl)
    UNION ALL
    (SELECT * FROM actual_sequence_acl EXCEPT SELECT * FROM expected_sequence_acl)
  ) AS sequence_acl_exact,
  NOT EXISTS (
    (SELECT * FROM expected_function_acl EXCEPT SELECT * FROM actual_function_acl)
    UNION ALL
    (SELECT * FROM actual_function_acl EXCEPT SELECT * FROM expected_function_acl)
  ) AS function_acl_exact,
  NOT EXISTS (
    (SELECT * FROM expected_default_acl EXCEPT SELECT * FROM actual_default_acl)
    UNION ALL
    (SELECT * FROM actual_default_acl EXCEPT SELECT * FROM expected_default_acl)
  ) AS default_acl_exact
)
SELECT CASE
  WHEN settings_present
    AND database_schema_owners_exact
    AND relation_owners_exact
    AND routine_owners_exact
    AND type_owners_exact
    AND column_acl_exact
    AND required_functions_present
    AND default_acl_object_types_exact
    AND default_acl_owner_exact
    AND global_function_default_acl_exact
    AND database_acl_exact
    AND schema_acl_exact
    AND relation_acl_exact
    AND sequence_acl_exact
    AND function_acl_exact
    AND default_acl_exact
  THEN 't'
  ELSE to_jsonb(checks)::text
END
FROM checks;")"
	[[ "$state" == 't' ]] ||
		fail "independent catalog ownership/ACL matrix mismatch for $target: $state"
	status "independent_catalog_acl_matrix_${target//-/_}"
}

verify_future_function_default_acl() {
	local target="$1" database schema migration password state
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	migration="$(target_migration_role "$target")"
	password="$(target_migration_password "$target")"
	docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port 5432 --username "$migration" --dbname "$database" \
			--command "CREATE FUNCTION \"$schema\".database_restore_default_acl_probe() RETURNS INTEGER LANGUAGE SQL AS 'SELECT 1';" >/dev/null
	state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname "$database" \
		--command "
SELECT pg_get_userbyid(routine.proowner) || '|' || NOT EXISTS (
  SELECT 1
  FROM aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) privilege
  WHERE privilege.grantee <> routine.proowner
)
FROM pg_proc routine
WHERE routine.oid = to_regprocedure('$schema.database_restore_default_acl_probe()');")"
	docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port 5432 --username "$migration" --dbname "$database" \
			--command "DROP FUNCTION \"$schema\".database_restore_default_acl_probe();" >/dev/null
	unset password
	[[ "$state" == "$migration|true" ]] ||
		fail "future function default ACL mismatch for $target: $state"
	status "future_function_default_acl_${target//-/_}"
}

verify_backup_reconnect_and_dump() {
	local target="$1" database schema backup password state
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	backup="$(target_backup_role "$target")"
	password="$(target_backup_password "$target")"
	state="$(docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		psql --no-psqlrc --no-password --tuples-only --no-align \
			--host 127.0.0.1 --port 5432 --username "$backup" --dbname "$database" \
			--command "SELECT current_user || '|' || value FROM \"$schema\".restore_rehearsal_marker WHERE id = 'canonical';")"
	[[ "$state" == "$backup|baseline-$target" ]] ||
		fail "backup role cannot reconnect/read after restore for $target: $state"
	unset password
	create_target_dump "$target" "post-restore-$target.dump"
	status "backup_reconnect_dump_${target//-/_}"
}

verify_acl_and_reconnect() {
	local target="$1" database schema admin migration runtime backup roles_sql state password
	database="$(target_database "$target")"
	schema="$(target_schema "$target")"
	admin="$(target_admin_role "$target")"
	migration="$(target_migration_role "$target")"
	runtime="$(target_runtime_role "$target")"
	backup="$(target_backup_role "$target")"
	roles_sql="$(target_application_roles_sql "$target")"
	state="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname "$database" \
		--command "
SELECT
  (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) || '|' ||
  (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '$schema') || '|' ||
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = '\"$schema\".restore_rehearsal_marker'::regclass) || '|' ||
  (NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[$roles_sql]) role_name
    WHERE NOT has_database_privilege(role_name, current_database(), 'CONNECT')
       OR has_database_privilege(role_name, current_database(), 'CREATE')
       OR has_database_privilege(role_name, current_database(), 'TEMPORARY')
  )) || '|' ||
  (NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[$roles_sql]) role_name
    CROSS JOIN unnest(ARRAY['default_db','winwidget_notification_delivery','winwidget_campaigns','winwidget_reporting','winwidget_widgets','winwidget_billing','winwidget_identity','winwidget_platform','winwidget_support','winwidget_operations']) database_name
    WHERE database_name <> current_database()
      AND has_database_privilege(role_name, database_name, 'CONNECT')
  )) || '|' ||
  has_schema_privilege('$runtime', '$schema', 'USAGE') || '|' ||
  has_schema_privilege('$runtime', '$schema', 'CREATE') || '|' ||
  has_table_privilege('$runtime', '\"$schema\".restore_rehearsal_marker', 'SELECT') || '|' ||
  has_table_privilege('$runtime', '\"$schema\".restore_rehearsal_marker', 'INSERT') || '|' ||
  has_table_privilege('$runtime', '\"$schema\"._prisma_migrations', 'SELECT') || '|' ||
  has_table_privilege('$backup', '\"$schema\".restore_rehearsal_marker', 'SELECT') || '|' ||
  has_table_privilege('$backup', '\"$schema\".restore_rehearsal_marker', 'INSERT') || '|' ||
  (NOT EXISTS (
    SELECT 1 FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) privilege
    WHERE d.datname = current_database() AND privilege.grantee = 0 AND privilege.privilege_type = 'CONNECT'
  ));")"
	[[ "$state" == "$admin|$migration|$migration|true|true|true|false|true|true|false|true|false|true" ]] ||
		fail "ACL boundary mismatch for $target: $state"
	password="$(target_runtime_password "$target")"
	docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		psql --no-psqlrc --no-password --tuples-only --no-align \
			--host 127.0.0.1 --port 5432 --username "$runtime" --dbname "$database" \
			--command 'SELECT 1;' >/dev/null || fail "runtime role cannot reconnect to $target"
	unset password
	verify_independent_catalog_acl_matrix "$target"
	verify_future_function_default_acl "$target"
	verify_backup_reconnect_and_dump "$target"
	verify_migration_ledger "$target"
}

run_successful_restore() {
	local target="$1" job_id
	job_id="$(publish_job "$target" "$target.dump")"
	wait_job_settled "$job_id" "$target"
	verify_terminal "$job_id" "$target" SUCCEEDED >/dev/null
	verify_safety_backup_restore "$job_id" "$target" "mutated-$target"
	assert_marker "$target" "baseline-$target"
	verify_acl_and_reconnect "$target"
	status "restore_${target//-/_}"
}

run_queued_cancellation() {
	local job_id
	job_id="$(publish_job reporting reporting.dump)"
	cancel_job "$job_id"
	start_worker
	wait_job_settled "$job_id" reporting
	verify_terminal "$job_id" reporting CANCELLED >/dev/null
	assert_marker_matrix 'mutated-support' 'mutated-notification-delivery' 'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	status 'queued_cancellation'
}

run_publication_crash_boundary() {
	local job_id
	clear_worker_command_audit
	job_id="$(publish_job_without_receipt notification-delivery campaigns.dump)"
	sleep 2
	worker_exec test -f \
		"$STORAGE_PATH/queued/$job_id.json" ||
		fail 'receipt-pending manifest left the queued directory'
	worker_exec test -f \
		"$STORAGE_PATH/locks/notification-delivery.lock" ||
		fail 'receipt-pending target lock is missing'
	worker_exec test -f \
		"$STORAGE_PATH/locks/global.lock" ||
		fail 'receipt-pending global gate is missing'
	worker_exec test ! -e \
		"$STORAGE_PATH/receipts/$job_id.json" ||
		fail 'receipt-pending job unexpectedly has a receipt'
	worker_exec test ! -e \
		"$STORAGE_PATH/processing/$job_id.json" ||
		fail 'receipt-pending job entered processing'
	worker_exec test ! -e \
		"$STORAGE_PATH/fences/notification-delivery.json" ||
		fail 'receipt-pending job fenced its database'
	assert_worker_command_audit_empty
	assert_marker_matrix 'mutated-support' 'mutated-notification-delivery' \
		'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	status 'receipt_pending_zero_postgres_commands'

	retry_job_publication "$job_id" notification-delivery campaigns.dump
	wait_job_settled "$job_id" notification-delivery
	verify_terminal "$job_id" notification-delivery FAILED \
		DUMP_TARGET_MISMATCH >/dev/null
	assert_marker_matrix 'mutated-support' 'mutated-notification-delivery' \
		'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	status 'exact_publication_retry'
}

run_target_mismatch() {
	local job_id
	job_id="$(publish_job notification-delivery campaigns.dump)"
	wait_job_settled "$job_id" notification-delivery
	verify_terminal "$job_id" notification-delivery FAILED DUMP_TARGET_MISMATCH >/dev/null
	assert_marker_matrix 'mutated-support' 'mutated-notification-delivery' 'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	status 'target_mismatch_pre_destructive'
}

prepare_failure_dump() {
	docker exec -i "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_campaigns <<'SQL'
SET ROLE winwidget_campaigns_migration;
CREATE TABLE campaigns.restore_rehearsal_slow (
	id INTEGER PRIMARY KEY,
	payload TEXT NOT NULL
);
INSERT INTO campaigns.restore_rehearsal_slow (id, payload)
SELECT value, 'restore-rehearsal-payload'
FROM generate_series(1, 5000000) AS value;
RESET ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns.restore_rehearsal_slow TO winwidget_campaigns_runtime;
GRANT SELECT ON campaigns.restore_rehearsal_slow TO winwidget_campaigns_backup;
SQL
	create_target_dump campaigns campaigns-failure.dump
	docker exec "$PG_CONTAINER" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username winwidget_restore_rehearsal_bootstrap --dbname winwidget_campaigns \
		--command "UPDATE campaigns.restore_rehearsal_marker SET value = 'failure-mutated-campaigns' WHERE id = 'canonical';" >/dev/null
}

verify_live_fence_identity() {
	local job_id="$1"
	utility_run \
		--network none \
		--user 1001:1001 \
		--mount "type=volume,source=$RESTORE_VOLUME,target=/restore,readonly" \
		-e "DATABASE_RESTORE_QUEUE_SECRET=$QUEUE_SECRET" \
		--entrypoint node \
		"$RUNNER_IMAGE" -e '
const fs = require("node:fs");
const { parseAndVerifyDatabaseRestoreTargetLock } = require("/app/dist/src/dev-tools/database-restore-queue.contract.js");
const jobId = process.argv[1];
const fence = parseAndVerifyDatabaseRestoreTargetLock(
  fs.readFileSync("/restore/fences/campaigns.json", "utf8"),
  process.env.DATABASE_RESTORE_QUEUE_SECRET
);
if (fence.jobId !== jobId || fence.target !== "campaigns") throw new Error("live fence identity mismatch");
' "$job_id"
}

wait_for_signed_safety_created() {
	local job_id="$1" target="$2" attempt checkpoint running
	for ((attempt = 1; attempt <= 2400; attempt++)); do
		checkpoint="$(worker_exec node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const { canonicalDatabaseRestoreJson } = require("/app/dist/src/dev-tools/database-restore-queue.contract.js");
const [jobId, target] = process.argv.slice(1);
const progressPath = `/var/lib/winwidget-rehearsal/database-restores/processing/${jobId}.state`;
let progress;
try {
  progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stdout.write("waiting");
    process.exit(0);
  }
  throw error;
}
const { signature, ...payload } = progress;
if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) {
  throw new Error("restore progress signature is malformed");
}
const expected = crypto
  .createHmac("sha256", process.env.DATABASE_RESTORE_QUEUE_SECRET)
  .update(canonicalDatabaseRestoreJson(payload))
  .digest();
const actual = Buffer.from(signature, "hex");
if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
  throw new Error("restore progress signature is invalid");
}
if (progress.jobId !== jobId || progress.target !== target) {
  throw new Error("restore progress identity mismatch");
}
if (["FENCING", "FENCED"].includes(progress.phase)) {
  process.stdout.write("waiting");
  process.exit(0);
}
if (
  progress.phase !== "SAFETY_CREATED" ||
  progress.safetyBackupFileName !== `safety-${jobId}.dump` ||
  !/^[0-9a-f]{64}$/.test(progress.safetyBackupSha256 || "") ||
  progress.restoredAt !== null ||
  progress.verifiedAt !== null
) {
  throw new Error(`restore progress passed the SAFETY_CREATED checkpoint: ${progress.phase}`);
}
process.stdout.write("ready");
' "$job_id" "$target")" || fail "signed SAFETY_CREATED checkpoint is invalid for $job_id"
		case "$checkpoint" in
		ready)
			status 'signed_safety_created'
			return
			;;
		waiting) ;;
		*) fail "unexpected SAFETY_CREATED checkpoint result for $job_id: $checkpoint" ;;
		esac
		running="$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
		[[ "$running" == 'true' ]] || fail 'worker exited before SAFETY_CREATED checkpoint'
		worker_exec test ! -f "$STORAGE_PATH/terminal/$job_id.json" ||
			fail 'restore reached terminal state before SAFETY_CREATED checkpoint'
		sleep 0.05
	done
	fail "signed SAFETY_CREATED checkpoint did not become visible for $job_id"
}

pause_worker_during_active_pg_restore() {
	local job_id="$1" target="$2" database admin attempt active running terminal_summary
	database="$(target_database "$target")"
	admin="$(target_admin_role "$target")"
	for ((attempt = 1; attempt <= 2400; attempt++)); do
		active="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
			--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
			--command "SELECT count(*) = 1 FROM pg_stat_activity WHERE datname = '$database' AND usename = '$admin' AND application_name = 'winwidget-database-restore-worker' AND state = 'active' AND query LIKE '%restore_rehearsal_slow%';")"
		if [[ "$active" == 't' ]]; then
			docker pause "$WORKER_CONTAINER" >/dev/null
			status 'active_pg_restore_paused'
			return
		fi
		running="$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
		[[ "$running" == 'true' ]] || fail 'worker exited before active pg_restore checkpoint'
		if worker_exec test -f "$STORAGE_PATH/terminal/$job_id.json"; then
			terminal_summary="$(worker_exec node -e '
const fs = require("node:fs");
const jobId = process.argv[1];
const terminal = JSON.parse(fs.readFileSync(
  `/var/lib/winwidget-rehearsal/database-restores/terminal/${jobId}.json`,
  "utf8"
));
process.stdout.write([
  terminal.status || "missing-status",
  terminal.error?.stage || "no-stage",
  terminal.error?.code || "no-code"
].join("|"));
' "$job_id")"
			fail "restore reached terminal state before active pg_restore checkpoint: $terminal_summary"
		fi
		sleep 0.02
	done
	fail 'could not pause worker during active pg_restore'
}

run_failed_fenced_shutdown() {
	local job_id attempt closed running paused password shutdown_state terminal_dump_sha256
	prepare_failure_dump
	job_id="$(publish_job campaigns campaigns-failure.dump)"
	wait_for_signed_safety_created "$job_id" campaigns
	pause_worker_during_active_pg_restore "$job_id" campaigns
	verify_live_fence_identity "$job_id"
	closed="$(docker exec "$PG_CONTAINER" psql --no-psqlrc --tuples-only --no-align \
		--username winwidget_restore_rehearsal_bootstrap --dbname postgres \
		--command "SELECT NOT has_database_privilege('winwidget_campaigns_runtime','winwidget_campaigns','CONNECT');")"
	[[ "$closed" == 't' ]] || fail 'Campaigns runtime CONNECT was restored during active pg_restore'
	password="$(target_runtime_password campaigns)"
	if docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		psql --no-psqlrc --no-password --host 127.0.0.1 --port 5432 \
			--username winwidget_campaigns_runtime --dbname winwidget_campaigns \
			--command 'SELECT 1;' >/dev/null 2>&1; then
		fail 'Campaigns runtime CONNECT remained open at the fenced-stop checkpoint'
	fi
	unset password
	if docker kill --signal TERM "$WORKER_CONTAINER" >/dev/null 2>&1; then
		paused="$(docker inspect --format '{{.State.Paused}}' "$WORKER_CONTAINER")"
		case "$paused" in
		true) docker unpause "$WORKER_CONTAINER" >/dev/null ;;
		false) ;;
		*) fail "worker pause state is invalid after queued SIGTERM: $paused" ;;
		esac
	else
		paused="$(docker inspect --format '{{.State.Paused}}' "$WORKER_CONTAINER")"
		[[ "$paused" == 'true' ]] ||
			fail "worker rejected SIGTERM outside the paused state: $paused"
		docker unpause "$WORKER_CONTAINER" >/dev/null
		docker kill --signal TERM "$WORKER_CONTAINER" >/dev/null
	fi
	for ((attempt = 1; attempt <= 180; attempt++)); do
		running="$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
		[[ "$running" == 'false' ]] && break
		sleep 0.5
	done
	[[ "$running" == 'false' ]] || fail 'worker did not stop gracefully after SIGTERM'
	shutdown_state="$(docker inspect --format '{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.Error}}' "$WORKER_CONTAINER")"
	if ! terminal_dump_sha256="$(verify_terminal "$job_id" campaigns FAILED_FENCED)"; then
		printf 'database_restore_rehearsal_failed_fenced_job=job_id=%s,target=campaigns,expected_status=FAILED_FENCED,shutdown_state=%s\n' \
			"$job_id" "$shutdown_state" >&2
		docker logs --tail 200 "$WORKER_CONTAINER" >&2 || true
		fail "FAILED_FENCED terminal verification failed after worker shutdown: $shutdown_state"
	fi
	if [[ "$shutdown_state" != 'false|0|' && "$shutdown_state" != 'false|143|' ]]; then
		printf 'database_restore_rehearsal_failed_fenced_job=job_id=%s,target=campaigns,status=FAILED_FENCED,dump_sha256=%s,shutdown_state=%s\n' \
			"$job_id" "$terminal_dump_sha256" "$shutdown_state" >&2
		docker logs --tail 200 "$WORKER_CONTAINER" >&2 || true
		fail "worker shutdown was not graceful: $shutdown_state"
	fi
	verify_safety_backup_restore "$job_id" campaigns 'failure-mutated-campaigns'
	password="$(target_runtime_password campaigns)"
	if docker exec -e "PGPASSWORD=$password" "$PG_CONTAINER" \
		psql --no-psqlrc --no-password --host 127.0.0.1 --port 5432 \
			--username winwidget_campaigns_runtime --dbname winwidget_campaigns \
			--command 'SELECT 1;' >/dev/null 2>&1; then
		fail 'FAILED_FENCED database was reopened unexpectedly'
	fi
	unset password
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' \
		'failure-mutated-campaigns' 'baseline-reporting' 'baseline-widgets' 'baseline-billing' 'baseline-identity' 'baseline-platform' 'baseline-operations'
	status 'graceful_failed_fenced_shutdown'
}

assert_no_spurious_publication_orphan_log() {
	local worker_logs
	worker_logs="$(docker logs "$WORKER_CONTAINER" 2>&1)" ||
		fail 'database restore worker logs are unavailable'
	[[ "$worker_logs" != *'Orphan database restore global gate requires manual reconciliation'* ]] ||
		fail 'normal queue publication produced a spurious orphan global-gate error'
	status 'publication_grace_no_spurious_orphan'
}

main() {
	validate_static_inputs
	assert_local_docker
	assert_resources_absent
	CLEANUP_ARMED=1
	trap cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	mkdir "$APP_ROOT"
	write_secret_files
	verify_linux_bind_visibility
	build_runner_image
	create_volumes_and_storage
	start_postgres
	provision_roles_and_databases
	verify_cluster_boundaries
	apply_migrations
	assert_identity_core_source_removed
	seed_markers_and_acl
	assert_platform_rehearsal_contract
	assert_billing_core_writer_fences
	create_baseline_dumps
	mutate_markers
	run_queued_cancellation
	run_publication_crash_boundary
	run_target_mismatch

	assert_marker_matrix 'mutated-support' 'mutated-notification-delivery' 'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore support
	assert_marker_matrix 'baseline-support' 'mutated-notification-delivery' 'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore notification-delivery
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'mutated-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore campaigns
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'mutated-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore reporting
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'baseline-reporting' 'mutated-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore widgets
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'baseline-reporting' 'baseline-widgets' 'mutated-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore billing
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'baseline-reporting' 'baseline-widgets' 'baseline-billing' 'mutated-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore identity
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'baseline-reporting' 'baseline-widgets' 'baseline-billing' 'baseline-identity' 'mutated-platform' 'mutated-operations'
	run_successful_restore platform
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'baseline-reporting' 'baseline-widgets' 'baseline-billing' 'baseline-identity' 'baseline-platform' 'mutated-operations'
	run_successful_restore operations
	assert_marker_matrix 'baseline-support' 'baseline-notification-delivery' 'baseline-campaigns' 'baseline-reporting' 'baseline-widgets' 'baseline-billing' 'baseline-identity' 'baseline-platform' 'baseline-operations'
	status 'sequential_isolation'

	run_failed_fenced_shutdown
	assert_no_spurious_publication_orphan_log
	status 'complete'
}

case "${1:-}" in
'') main ;;
--self-test) self_test ;;
--help)
	printf 'Usage: %s [--self-test]\n' "$(basename "$0")"
	;;
*) fail 'only --self-test and --help are accepted' ;;
esac
