#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
BILLING_DRAIN_SECONDS="${BILLING_DRAIN_SECONDS:-12}"

server_root="$APP_ROOT/winwidget.ru_server"
billing_cutover_marker="$APP_ROOT/deploy/backend/.billing-cutover-v1"
billing_artifact_root="$APP_ROOT/deploy/backend/billing-cutover-artifacts"
billing_artifact_archive_root="$APP_ROOT/deploy/backend/billing-cutover-artifact-archive"
billing_snapshot_file="$billing_artifact_root/core-frozen-snapshot-v1.json"
billing_core_prepare_evidence="$billing_artifact_root/core-prepare.json"
billing_core_abort_evidence="$billing_artifact_root/core-abort.json"
billing_import_evidence="$billing_artifact_root/billing-import.json"
billing_import_verify_evidence="$billing_artifact_root/billing-import-verify.json"
billing_seed_evidence="$billing_artifact_root/billing-core-read-seed.json"
billing_service_status_evidence="$billing_artifact_root/billing-status-before-activate.json"
billing_projection_evidence="$billing_artifact_root/core-projection-lag-zero.json"
billing_core_activation_evidence="$billing_artifact_root/core-activation.json"
billing_service_activation_evidence="$billing_artifact_root/billing-activation.json"
billing_completion_evidence="$billing_artifact_root/billing-completion.json"
billing_core_status_evidence="$billing_artifact_root/core-status.json"
billing_route_manifest="$billing_artifact_root/gateway-routes-billing.json"
billing_route_env_legacy_snapshot="$billing_artifact_root/backend-env-before-billing-routes"
billing_route_env_candidate="$billing_artifact_root/backend-env-with-billing-routes.candidate"
billing_route_env_sync_evidence="$APP_ROOT/deploy/backend/.billing-route-env-sync-v1.json"
billing_route_env_rollback_evidence="$APP_ROOT/deploy/backend/.billing-route-env-rollback-sync-v1.json"
billing_pre_backup_manifest="$billing_artifact_root/pre-cutover-backups.json"
billing_core_backup="$billing_artifact_root/core-pre-billing-cutover.dump"
billing_service_backup="$billing_artifact_root/billing-pre-ownership.dump"
billing_post_backup="$billing_artifact_root/billing-post-ownership.dump"
billing_pre_restore_evidence="$billing_artifact_root/pre-actual-restore-evidence.json"
billing_post_restore_evidence="$billing_artifact_root/post-actual-restore-evidence.json"
billing_pre_offsite_receipt="$billing_artifact_root/pre-offsite-receipt.json"
billing_post_offsite_receipt="$billing_artifact_root/post-offsite-receipt.json"
billing_restore_rehearsal_script="$server_root/scripts/billing-backup-restore-rehearsal.sh"
billing_legacy_error_contract="$billing_artifact_root/legacy-error-contract.json"
billing_direct_error_contract="$billing_artifact_root/billing-error-contract.json"
billing_gateway_error_contract="$billing_artifact_root/gateway-error-contract.json"
billing_auto_renewal_core_evidence="$billing_artifact_root/auto-renewal-core-owner.json"
billing_auto_renewal_detached_evidence="$billing_artifact_root/auto-renewal-detached.json"
billing_auto_renewal_billing_evidence="$billing_artifact_root/auto-renewal-billing-owner.json"
billing_cutover_active_stage=''
billing_cutover_publisher_recovery_active='false'
billing_cutover_legacy_publisher_id=''
billing_cutover_core_image_id=''
billing_cutover_billing_image_id=''
billing_cutover_next_pre_restore_sha=''
billing_cutover_next_pre_receipt_sha=''
billing_cutover_next_post_restore_sha=''
billing_cutover_next_post_receipt_sha=''

readonly billing_cutover_confirmation='CUTOVER BILLING OWNERSHIP'
readonly billing_core_cli='dist/src/billing-core-cutover-main.js'
readonly billing_service_cli='dist/src/cutover-main.js'
readonly billing_core_expand_migration='20260811000000_prepare_billing_service_ownership'
readonly billing_worker_configure_pattern='^winwidget\.(billing\.(retry|dead-letter)|billing\.(identity|notification-routing|settings-source|trial|referral|offer|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$'
readonly billing_worker_write_pattern='^winwidget\.(billing\.(retry|dead-letter)|billing\.(identity|notification-routing|settings-source|trial|referral|offer|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$'
readonly billing_worker_read_pattern='^winwidget\.(events|billing\.(retry|dead-letter)|billing\.(identity|notification-routing|settings-source|trial|referral|offer|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$'
readonly billing_publisher_write_pattern='^winwidget\.(events|billing\.(retry|dead-letter))$'
readonly billing_worker_topic_read_pattern='^(billing\.identity\.changed\.v1|billing\.notification-routing\.changed\.v1|billing\.settings\.source\.changed\.v1|billing\.trial\.requested\.v1|billing\.referral\.requested\.v1|billing\.offer\.changed\.v1|billing\.lifecycle-repair\.requested\.v1|payment\.auto-renewal\.charge\.requested\.v1|notification\.delivery\.outcome\.v1)$'
readonly billing_publisher_topic_write_pattern='^(payment\.succeeded\.v1|payment\.notification\.telegram\.requested\.v1|payment\.auto-renewal\.charge\.requested\.v1|notification\.subscription-expiry\.(email|telegram)\.requested\.v1|billing\.(payment|subscription)(\.details)?\.changed\.v1|billing\.(affiliate|settings)\.changed\.v1|admin\.audit\.billing\.v1)$'
readonly core_integration_write_pattern='^(winwidget\.retry|winwidget\.dead-letter)$'
readonly core_integration_post_billing_read_pattern='^winwidget\.(admin\.audit\.(campaigns|reporting|widgets|billing)\.v1|core\.billing\.(payment-details|subscription-details|affiliate|settings)\.v1|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'

# shellcheck source=scripts/billing-release-identity.sh
source "$server_root/scripts/billing-release-identity.sh"
# shellcheck source=scripts/billing-database-lifecycle.sh
source "$server_root/scripts/billing-database-lifecycle.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/deploy-billing-production.sh
source "$server_root/scripts/deploy-billing-production.sh"

billing_cutover_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

billing_cutover_cleanup_active_stage() {
	local stage="$billing_cutover_active_stage"
	[[ -n "$stage" ]] || return 0
	case "$stage" in
	"$billing_artifact_root"/.cli-stage.* | \
		"$billing_artifact_root"/.snapshot-stage.*) ;;
	*) return 1 ;;
	esac
	[[ -d "$stage" && ! -L "$stage" ]] || {
		billing_cutover_active_stage=''
		return 0
	}
	rm -f -- "$stage/input.json" "$stage/output.json"
	rmdir "$stage"
	billing_cutover_active_stage=''
}

billing_cutover_on_exit() {
	local status=$?
	set +e
	billing_cutover_cleanup_active_stage
	if [[ "$billing_cutover_publisher_recovery_active" == 'true' ]] &&
		declare -F billing_cutover_recover_core_publisher >/dev/null; then
		billing_cutover_recover_core_publisher
	fi
	exit "$status"
}

trap billing_cutover_on_exit EXIT

billing_cutover_sha256() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	sha256sum "$1" | awk '{print $1}'
}

billing_cutover_validate_private_directory() {
	[[ $# -eq 1 && -d "$1" && ! -L "$1" &&
		"$(stat -c '%u:%g:%a' "$1")" == '0:0:700' ]]
}

billing_cutover_ensure_private_directory() {
	[[ $# -eq 1 ]] || return 1
	if [[ ! -e "$1" && ! -L "$1" ]]; then
		mkdir -m 700 "$1"
		chown 0:0 "$1"
	fi
	billing_cutover_validate_private_directory "$1"
}

billing_cutover_require_artifact_root() {
	billing_cutover_ensure_private_directory "$billing_artifact_root" ||
		billing_cutover_fail \
			'Billing cutover evidence directory must be root-owned mode 700.'
}

billing_cutover_directory_is_empty() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_private_directory "$1" || return 1
	[[ -z "$(ls -A -- "$1")" ]]
}

billing_cutover_validate_archive_contents() {
	[[ $# -eq 1 ]] || return 1
	local directory="$1" entry name
	billing_cutover_validate_private_directory "$directory" || return 1
	for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
		[[ -e "$entry" || -L "$entry" ]] || continue
		name="$(basename -- "$entry")"
		case "$name" in
		artifacts | route-env-sync.json | route-env-rollback-sync.json) ;;
		*) return 1 ;;
		esac
	done
}

billing_cutover_archive_aborted_generation() {
	[[ $# -eq 1 && "$1" =~ ^[1-9][0-9]*$ ]] || return 1
	local generation="$1" archive artifacts_archive route_archive
	local rollback_archive
	[[ "$(billing_cutover_marker_value phase)" == 'aborted' &&
		"$(billing_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(billing_cutover_marker_value generation)" == "$generation" ]] ||
		return 1
	billing_cutover_ensure_private_directory "$billing_artifact_archive_root" ||
		return 1
	archive="$billing_artifact_archive_root/revision-${EXPECTED_REVISION}-generation-${generation}-aborted"
	billing_cutover_ensure_private_directory "$archive" || return 1
	billing_cutover_validate_archive_contents "$archive" || return 1
	artifacts_archive="$archive/artifacts"
	if [[ -e "$billing_artifact_root" || -L "$billing_artifact_root" ]]; then
		billing_cutover_validate_private_directory "$billing_artifact_root" || return 1
		if [[ -e "$artifacts_archive" || -L "$artifacts_archive" ]]; then
			billing_cutover_validate_private_directory "$artifacts_archive" || return 1
			billing_cutover_directory_is_empty "$billing_artifact_root" ||
				billing_cutover_fail \
					'Fresh Billing artifacts appeared after the aborted generation was archived.' ||
				return 1
		else
			mv -- "$billing_artifact_root" "$artifacts_archive"
			billing_cutover_validate_private_directory "$artifacts_archive" || return 1
		fi
	fi
	route_archive="$archive/route-env-sync.json"
	if [[ -e "$billing_route_env_sync_evidence" ||
		-L "$billing_route_env_sync_evidence" ]]; then
		billing_cutover_validate_evidence_file "$billing_route_env_sync_evidence" ||
			return 1
		[[ ! -e "$route_archive" && ! -L "$route_archive" ]] ||
			billing_cutover_fail \
				'Aborted Billing route evidence already has an archive copy.' || return 1
		mv -- "$billing_route_env_sync_evidence" "$route_archive"
		billing_cutover_validate_evidence_file "$route_archive" || return 1
	elif [[ -e "$route_archive" || -L "$route_archive" ]]; then
		billing_cutover_validate_evidence_file "$route_archive" || return 1
	fi
	rollback_archive="$archive/route-env-rollback-sync.json"
	if [[ -e "$billing_route_env_rollback_evidence" ||
		-L "$billing_route_env_rollback_evidence" ]]; then
		billing_cutover_validate_evidence_file \
			"$billing_route_env_rollback_evidence" || return 1
		[[ ! -e "$rollback_archive" && ! -L "$rollback_archive" ]] ||
			billing_cutover_fail \
				'Aborted Billing route rollback evidence already has an archive copy.' ||
			return 1
		mv -- "$billing_route_env_rollback_evidence" "$rollback_archive"
		billing_cutover_validate_evidence_file "$rollback_archive" || return 1
	elif [[ -e "$rollback_archive" || -L "$rollback_archive" ]]; then
		billing_cutover_validate_evidence_file "$rollback_archive" || return 1
	fi
	billing_cutover_validate_archive_contents "$archive" || return 1
	billing_cutover_require_artifact_root
	printf 'billing_aborted_artifacts_archive=%s\n' "$archive"
}

billing_cutover_validate_evidence_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" &&
		"$(stat -c '%u:%g:%a' "$1")" == '0:0:600' && -s "$1" ]] ||
		billing_cutover_fail "Billing evidence file is unsafe or empty: $1"
}

billing_cutover_validate_partial_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" &&
		"$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]] ||
		billing_cutover_fail "Billing partial file is unsafe: $1"
}

billing_cutover_marker_value() {
	[[ $# -eq 1 && -f "$billing_cutover_marker" &&
		! -L "$billing_cutover_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$billing_cutover_marker"
}

billing_cutover_validate_marker() {
	[[ -f "$billing_cutover_marker" && ! -L "$billing_cutover_marker" &&
		"$(stat -c '%u:%g:%a' "$billing_cutover_marker")" == '0:0:600' ]] || return 1
	awk -F= '
		function hex(value, size) { return length(value) == size && value ~ /^[0-9a-f]+$/ }
		function timestamp(value) {
			return length(value) == 20 && value ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
		}
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 !~ /^(version|phase|revision|cleanup_revision|generation|database_id|core_image_id|billing_image_id|snapshot_sha256|projection_sha256|route_sha256|pre_restore_evidence_sha256|pre_offsite_receipt_sha256|post_restore_evidence_sha256|post_offsite_receipt_sha256|updated_at)$/) invalid = 1
		}
		END {
			for (key in count) if (count[key] != 1) invalid = 1
			if (NR != 16 || value["version"] != "2" ||
				value["phase"] !~ /^(prepared|source-frozen|imported|pre-backups-created|pre-restore-verified|projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete|aborted)$/ ||
				!hex(value["revision"], 40) ||
				!(value["cleanup_revision"] == "pending" || hex(value["cleanup_revision"], 40)) ||
				value["generation"] !~ /^[1-9][0-9]*$/ ||
				value["database_id"] !~ /^[0-9a-f-]{36}$/ ||
				value["core_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["billing_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				!(value["snapshot_sha256"] == "pending" || hex(value["snapshot_sha256"], 64)) ||
				!(value["projection_sha256"] == "pending" || hex(value["projection_sha256"], 64)) ||
				!(value["route_sha256"] == "pending" || hex(value["route_sha256"], 64)) ||
				!(value["pre_restore_evidence_sha256"] == "pending" || hex(value["pre_restore_evidence_sha256"], 64)) ||
				!(value["pre_offsite_receipt_sha256"] == "pending" || hex(value["pre_offsite_receipt_sha256"], 64)) ||
				!(value["post_restore_evidence_sha256"] == "pending" || hex(value["post_restore_evidence_sha256"], 64)) ||
				!(value["post_offsite_receipt_sha256"] == "pending" || hex(value["post_offsite_receipt_sha256"], 64)) ||
				!timestamp(value["updated_at"])) invalid = 1
			if (value["phase"] ~ /^(pre-restore-verified|projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete)$/ &&
				(!hex(value["pre_restore_evidence_sha256"], 64) ||
				 !hex(value["pre_offsite_receipt_sha256"], 64))) invalid = 1
			if (value["phase"] ~ /^(post-restore-verified|complete)$/ &&
				(!hex(value["post_restore_evidence_sha256"], 64) ||
				 !hex(value["post_offsite_receipt_sha256"], 64))) invalid = 1
			if (value["phase"] ~ /^(active|post-backup-created|post-restore-verified|complete)$/ &&
				!hex(value["route_sha256"], 64)) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$billing_cutover_marker"
}

billing_cutover_write_marker() {
	[[ $# -eq 14 ]] || return 1
	local temporary="$APP_ROOT/deploy/backend/.billing-cutover-v2.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	(umask 077; {
		printf 'version=2\n'
		printf 'phase=%s\n' "$1"
		printf 'revision=%s\n' "$2"
		printf 'cleanup_revision=%s\n' "$3"
		printf 'generation=%s\n' "$4"
		printf 'database_id=%s\n' "$5"
		printf 'core_image_id=%s\n' "$6"
		printf 'billing_image_id=%s\n' "$7"
		printf 'snapshot_sha256=%s\n' "$8"
		printf 'projection_sha256=%s\n' "$9"
		printf 'route_sha256=%s\n' "${10}"
		printf 'pre_restore_evidence_sha256=%s\n' "${11}"
		printf 'pre_offsite_receipt_sha256=%s\n' "${12}"
		printf 'post_restore_evidence_sha256=%s\n' "${13}"
		printf 'post_offsite_receipt_sha256=%s\n' "${14}"
		printf 'updated_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	} >"$temporary")
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$billing_cutover_marker"
	billing_cutover_validate_marker
}

billing_cutover_current_phase() {
	if [[ ! -e "$billing_cutover_marker" && ! -L "$billing_cutover_marker" ]]; then
		printf 'absent\n'
		return
	fi
	billing_cutover_validate_marker || return 1
	billing_cutover_marker_value phase
}

billing_cutover_require_environment() {
	local key value phase
	billing_database_require_root
	billing_database_require_exact_checkout
	billing_database_require_env_contract
	billing_database_validate_urls
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	for key in DATABASE_MIGRATION_URL_PRODUCTION GATEWAY_ROUTES_JSON \
		RABBITMQ_VHOST RABBITMQ_BILLING_WORKER_URL \
		RABBITMQ_BILLING_PUBLISHER_URL RABBITMQ_INTEGRATION_WORKER_URL \
		RABBITMQ_MANAGEMENT_URL RABBITMQ_MONITOR_USER \
		RABBITMQ_MONITOR_PASSWORD BILLING_INTERNAL_TOKEN \
		BILLING_RESTORE_DRILL_EVIDENCE_FILE; do
		value="$(billing_read_env_value "$ENV_FILE" "$key")" ||
			billing_cutover_fail "Missing or duplicate production env key: $key" ||
			return 1
		[[ -n "$value" && "$value" != change_me* && "$value" != XYZXYZXYZ* ]] ||
			billing_cutover_fail "Production env key is empty or a placeholder: $key" ||
			return 1
	done
	[[ "$BILLING_DRAIN_SECONDS" =~ ^(10|11|12|13|14|15)$ ]] ||
		billing_cutover_fail 'BILLING_DRAIN_SECONDS must be bounded to 10-15 seconds.' ||
		return 1
	[[ -f "$billing_restore_rehearsal_script" &&
		! -L "$billing_restore_rehearsal_script" ]] ||
		billing_cutover_fail 'Billing backup restore rehearsal runner is unavailable.' ||
		return 1
	phase="$(billing_database_current_phase)" || return 1
	case "$phase" in
	forward-only | active | post-backup-created | post-restore-verified)
		[[ "${BILLING_FIRST_CUTOVER_APPROVED:-false}" == 'true' ]] ||
			billing_cutover_fail 'Forward recovery remains manual-only.'
		;;
	esac
}

billing_cutover_validate_restore_drill() {
	[[ "$billing_cutover_billing_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local evidence postgres_image_id runner_sha migration_sha
	evidence="$(billing_read_env_value "$ENV_FILE" BILLING_RESTORE_DRILL_EVIDENCE_FILE)"
	[[ "$evidence" == "$APP_ROOT/deploy/backend/.billing-restore-drill-evidence-v1.json" ]] ||
		return 1
	billing_cutover_validate_evidence_file "$evidence" || return 1
	postgres_image_id="$(docker image inspect --format '{{.Id}}' \
		"$billing_postgres_image")" || return 1
	runner_sha="$(billing_cutover_sha256 "$billing_restore_rehearsal_script")" ||
		return 1
	migration_sha="$(billing_cutover_sha256 \
		"$server_root/apps/billing/prisma/migrations/20260811000000_init_billing/migration.sql")" ||
		return 1
	EXPECTED_REVISION="$EXPECTED_REVISION" \
		EXPECTED_BILLING_IMAGE_ID="$billing_cutover_billing_image_id" \
		EXPECTED_POSTGRES_IMAGE="$billing_postgres_image" \
		EXPECTED_POSTGRES_IMAGE_ID="$postgres_image_id" \
		EXPECTED_RUNNER_SHA="$runner_sha" EXPECTED_MIGRATION_SHA="$migration_sha" \
		node - "$evidence" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const exactKeys = [
  'schemaVersion', 'action', 'target', 'status', 'postgresMajor', 'revision',
  'dumpSha256', 'postgresImage', 'postgresImageId', 'billingImage',
  'billingImageId', 'migrationName', 'migrationChecksum',
  'sourceSystemIdentifier', 'restoreSystemIdentifier', 'databaseId',
  'networkInternal', 'hostPortsPublished', 'runnerRevision', 'runnerSha256',
  'observedAt',
].sort();
if (
	!document || Array.isArray(document) ||
	Object.keys(document).sort().join('|') !== exactKeys.join('|') ||
	document.schemaVersion !== 1 ||
	document.action !== 'billing-independent-restore-drill' ||
  document.target !== 'billing' ||
  document.status !== 'passed' ||
  document.postgresMajor !== 18 ||
  document.revision !== process.env.EXPECTED_REVISION ||
	document.billingImage !== `winwidget-billing:git-${process.env.EXPECTED_REVISION}` ||
	document.billingImageId !== process.env.EXPECTED_BILLING_IMAGE_ID ||
	!/^[0-9a-f]{64}$/.test(document.dumpSha256 || '') ||
	document.postgresImage !== process.env.EXPECTED_POSTGRES_IMAGE ||
	document.postgresImageId !== process.env.EXPECTED_POSTGRES_IMAGE_ID ||
	!/^sha256:[0-9a-f]{64}$/.test(document.postgresImageId || '') ||
	document.migrationName !== '20260811000000_init_billing' ||
	document.migrationChecksum !== process.env.EXPECTED_MIGRATION_SHA ||
	!/^\d+$/.test(String(document.sourceSystemIdentifier || '')) ||
	!/^\d+$/.test(String(document.restoreSystemIdentifier || '')) ||
	String(document.sourceSystemIdentifier) === String(document.restoreSystemIdentifier) ||
	!/^[0-9a-f-]{36}$/.test(document.databaseId || '') ||
	document.runnerRevision !== process.env.EXPECTED_REVISION ||
	document.runnerSha256 !== process.env.EXPECTED_RUNNER_SHA ||
	!/^[0-9a-f]{64}$/.test(document.runnerSha256 || '') ||
	!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(document.observedAt || '') ||
	document.networkInternal !== true || document.hostPortsPublished !== false
) process.exit(1);
NODE
}

billing_cutover_ensure_restore_drill() {
	local evidence
	evidence="$(billing_read_env_value "$ENV_FILE" BILLING_RESTORE_DRILL_EVIDENCE_FILE)" ||
		return 1
	[[ "$evidence" == "$APP_ROOT/deploy/backend/.billing-restore-drill-evidence-v1.json" ]] ||
		return 1
	if [[ ! -e "$evidence" && ! -L "$evidence" ]]; then
		bash "$billing_restore_rehearsal_script" --revision "$EXPECTED_REVISION" \
			--phase synthetic --evidence-file "$evidence"
	fi
	billing_cutover_validate_restore_drill
}

billing_cutover_require_cli_uid() {
	local core_uid core_gid billing_uid billing_gid
	core_uid="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps --entrypoint id migrate -u | \
		tail -n 1)"
	core_gid="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps --entrypoint id migrate -g | \
		tail -n 1)"
	billing_uid="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile billing-migration run --rm -T --no-deps --entrypoint id \
		billing-migrate -u | tail -n 1)"
	billing_gid="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile billing-migration run --rm -T --no-deps --entrypoint id \
		billing-migrate -g | tail -n 1)"
	[[ "$core_uid:$core_gid:$billing_uid:$billing_gid" == \
		'1001:1001:1001:1001' ]] ||
		billing_cutover_fail 'Core and Billing cutover CLIs must run as uid:gid 1001:1001.'
}

billing_cutover_run_cli() {
	[[ $# -ge 6 ]] || return 1
	local profile="$1" service="$2" artifact="$3" action="$4" destination="$5"
	local input_file="$6" stage output_name
	shift 6
	billing_cutover_require_artifact_root
	stage="$(mktemp -d "$billing_artifact_root/.cli-stage.XXXXXX")"
	billing_cutover_active_stage="$stage"
	chown 0:1001 "$stage"
	chmod 730 "$stage"
	output_name='output.json'
	if [[ "$input_file" != 'none' ]]; then
		billing_cutover_validate_evidence_file "$input_file" || return 1
		cp "$input_file" "$stage/input.json"
		chown 0:1001 "$stage/input.json"
		chmod 640 "$stage/input.json"
	fi
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile "$profile" run --rm -T --no-deps \
		--volume "$stage:/cutover" --entrypoint node "$service" \
		"$artifact" "$action" "$@"
	[[ -f "$stage/$output_name" && ! -L "$stage/$output_name" &&
		-s "$stage/$output_name" ]] ||
		billing_cutover_fail "Cutover CLI did not create evidence for action=$action." ||
		return 1
	chown 0:0 "$stage/$output_name"
	chmod 600 "$stage/$output_name"
	mv -f "$stage/$output_name" "$destination"
	if [[ -e "$stage/input.json" ]]; then
		rm -f -- "$stage/input.json"
	fi
	rmdir "$stage"
	billing_cutover_active_stage=''
	billing_cutover_validate_evidence_file "$destination"
}

billing_cutover_run_core_cli() {
	[[ $# -ge 2 ]] || return 1
	local action="$1" destination="$2"
	shift 2
	billing_cutover_run_cli migration migrate "$billing_core_cli" "$action" \
		"$destination" none "$@" --evidence-file /cutover/output.json
}

billing_cutover_run_billing_cli() {
	[[ $# -ge 2 ]] || return 1
	local action="$1" destination="$2"
	shift 2
	billing_cutover_run_cli billing-migration billing-migrate \
		"$billing_service_cli" "$action" "$destination" none "$@" \
		--evidence-file /cutover/output.json
}

billing_cutover_run_billing_snapshot_cli() {
	[[ $# -ge 2 ]] || return 1
	local action="$1" destination="$2"
	shift 2
	billing_cutover_run_cli billing-migration billing-migrate \
		"$billing_service_cli" "$action" "$destination" \
		"$billing_snapshot_file" "$@" --snapshot-file /cutover/input.json \
		--evidence-file /cutover/output.json
}

billing_cutover_run_core_snapshot_export() {
	local stage
	billing_cutover_require_artifact_root
	stage="$(mktemp -d "$billing_artifact_root/.snapshot-stage.XXXXXX")"
	billing_cutover_active_stage="$stage"
	chown 0:1001 "$stage"
	chmod 730 "$stage"
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps \
		--volume "$stage:/cutover" --entrypoint node migrate \
		"$billing_core_cli" freeze-export --revision "$EXPECTED_REVISION" \
		--generation "$(billing_cutover_marker_value generation)" \
		--snapshot-file /cutover/output.json
	[[ -f "$stage/output.json" && ! -L "$stage/output.json" &&
		-s "$stage/output.json" ]] ||
		billing_cutover_fail 'Core frozen exporter did not create the snapshot.' ||
		return 1
	chown 0:0 "$stage/output.json"
	chmod 600 "$stage/output.json"
	mv -f "$stage/output.json" "$billing_snapshot_file"
	rmdir "$stage"
	billing_cutover_active_stage=''
	billing_cutover_validate_evidence_file "$billing_snapshot_file"
}

billing_cutover_validate_json_identity() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_evidence_file "$1" || return 1
	EXPECTED_REVISION="$EXPECTED_REVISION" \
	EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
		node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  document.revision !== process.env.EXPECTED_REVISION ||
  String(document.generation) !== process.env.EXPECTED_GENERATION
) process.exit(1);
NODE
}

billing_cutover_validate_frozen_snapshot() {
	billing_cutover_validate_json_identity "$billing_snapshot_file" || return 1
	node - "$billing_snapshot_file" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const topLevelKeys = [
  'schemaVersion', 'action', 'revision', 'generation', 'frozenAt',
  'sourceCutoff', 'sourceFingerprint', 'coreState', 'continuity',
  'identity', 'notificationRouting', 'settings', 'offer', 'payments',
  'paymentReceipts', 'subscriptions', 'subscriptionHistory',
  'subscriptionExpiryReminders', 'autoRenewals',
  'autoRenewalConsentEvents', 'tariffPrices', 'affiliateReferrals',
  'integrationDeliveryFailures', 'integrationDeliveryReceipts',
].sort();
const arrays = [
  'identity', 'notificationRouting', 'payments', 'paymentReceipts',
  'subscriptions', 'subscriptionHistory', 'subscriptionExpiryReminders',
  'autoRenewals', 'autoRenewalConsentEvents', 'tariffPrices',
  'affiliateReferrals', 'integrationDeliveryFailures',
  'integrationDeliveryReceipts',
];
const countKeys = [...arrays, 'settings', 'offer'];
const counts = document.continuity?.entityCounts;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const exactKeys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
};
const stateKeys = [
  'id', 'ownership', 'sourceProducersEnabled', 'legacyRoutesEnabled',
  'schedulerEnabled', 'legacyConsumerEnabled', 'projectionConsumerEnabled',
  'generation', 'preparedRevision', 'ownershipRevision', 'activatedAt',
  'updatedAt',
];
const state = document.coreState;
const continuityKeys = [
  'reportingHighWater', 'billingHighWater', 'maxHighWater',
  'nextSourceSequence', 'entityCounts', 'reportingAggregateVersions',
  'billingAggregateVersions',
];
const failureKeys = [
  'id', 'eventId', 'integration', 'routingKey', 'payload', 'attempts',
  'lastError', 'category', 'normalizedCode', 'safeReason', 'httpStatus',
  'providerCode', 'retryable', 'classificationVersion', 'firstFailedAt',
  'failedAt', 'retryingAt', 'activeRetryToken', 'resolvedAt', 'resolution',
  'resolutionComment', 'resolvedById', 'createdAt', 'updatedAt',
];
const receiptKeys = [
  'id', 'eventId', 'integration', 'status', 'lockedAt', 'deliveredAt',
  'retryAttempt', 'retryAvailableAt', 'retryToken', 'createdAt',
];
const uniquePairs = rows => {
  const pairs = rows.map(row => `${row.eventId}\0${row.integration}`);
  return new Set(pairs).size === pairs.length;
};
if (
  document.schemaVersion !== 1 || document.action !== 'freeze-export' ||
  !exactKeys(document, topLevelKeys) ||
  !iso(document.frozenAt) || !iso(document.sourceCutoff) ||
  !/^[0-9a-f]{64}$/.test(document.sourceFingerprint || '') ||
  !exactKeys(state, stateKeys) || state.id !== 'singleton' ||
  state.ownership !== 'CORE' || state.sourceProducersEnabled !== false ||
  state.legacyRoutesEnabled !== true || state.schedulerEnabled !== false ||
  state.legacyConsumerEnabled !== false ||
  state.projectionConsumerEnabled !== true ||
  state.generation !== String(document.generation) ||
  state.preparedRevision !== document.revision ||
  state.ownershipRevision !== null || state.activatedAt !== null ||
  !iso(state.updatedAt) ||
  !exactKeys(document.continuity, continuityKeys) ||
  !counts || typeof counts !== 'object' || Array.isArray(counts) ||
  Object.keys(counts).length !== countKeys.length ||
  countKeys.some(key => !nonnegative(counts[key])) ||
  arrays.some(key => !Array.isArray(document[key]) ||
    counts[key] !== document[key].length) ||
  !document.settings || !document.offer ||
  counts.settings !== 1 || counts.offer !== 1 ||
  document.integrationDeliveryFailures.some(row =>
    !exactKeys(row, failureKeys) || !uuid(row.id) || !uuid(row.eventId) ||
    row.integration !== 'auto-renewal' || row.retryingAt !== null ||
    row.activeRetryToken !== null || !iso(row.failedAt) ||
    !iso(row.createdAt) || !iso(row.updatedAt)) ||
  !uniquePairs(document.integrationDeliveryFailures) ||
  document.integrationDeliveryReceipts.some(row =>
    !exactKeys(row, receiptKeys) || !uuid(row.id) || !uuid(row.eventId) ||
    row.integration !== 'auto-renewal' || row.status === 'PROCESSING' ||
    !iso(row.lockedAt) || !iso(row.createdAt)) ||
  !uniquePairs(document.integrationDeliveryReceipts)
) process.exit(1);
NODE
}

billing_cutover_validate_core_prepared_state() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = document.coreState;
if (
  document.schemaVersion !== 1 || document.action !== 'prepare' ||
  !state || state.id !== 'singleton' || state.ownership !== 'CORE' ||
  state.sourceProducersEnabled !== true ||
  state.legacyRoutesEnabled !== true || state.schedulerEnabled !== true ||
  state.legacyConsumerEnabled !== true ||
  state.projectionConsumerEnabled !== true ||
  state.generation !== String(document.generation) ||
  state.preparedRevision !== document.revision ||
  state.ownershipRevision !== null || state.activatedAt !== null
) process.exit(1);
NODE
}

billing_cutover_validate_core_abort_state() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = document.coreState;
if (
  document.schemaVersion !== 1 || document.action !== 'abort' ||
  !state || state.id !== 'singleton' || state.ownership !== 'CORE' ||
  state.sourceProducersEnabled !== true ||
  state.legacyRoutesEnabled !== true || state.schedulerEnabled !== true ||
  state.legacyConsumerEnabled !== true ||
  state.projectionConsumerEnabled !== true ||
  state.generation !== String(document.generation) ||
  state.preparedRevision !== null || state.ownershipRevision !== null ||
  state.activatedAt !== null
) process.exit(1);
NODE
}

billing_cutover_validate_import_evidence() {
	[[ $# -eq 2 ]] || return 1
	local file="$1" action="$2"
	billing_cutover_validate_json_identity "$file" || return 1
	EXPECTED_ACTION="$action" node - "$file" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const canonical = [
  'payments', 'paymentReceipts', 'subscriptions', 'subscriptionHistory',
  'subscriptionExpiryReminders', 'autoRenewals',
  'autoRenewalConsentEvents', 'tariffPrices', 'affiliateReferrals',
  'identity', 'notificationRouting', 'offer', 'settings',
  'integrationDeliveryFailures', 'integrationDeliveryReceipts',
];
const baseCounts = [...canonical, 'pendingOutbox', 'providerOperationsInFlight'];
const verify = process.env.EXPECTED_ACTION === 'verify-import';
const verifiedShape = verify ||
  Object.hasOwn(document.counts || {}, 'relationshipViolations') ||
  Object.hasOwn(document.counts || {}, 'continuityViolations');
const expectedCounts = verifiedShape
  ? [...baseCounts, 'relationshipViolations', 'continuityViolations']
  : baseCounts;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
if (
  document.schemaVersion !== 1 || document.service !== 'billing-service' ||
  document.action !== process.env.EXPECTED_ACTION || document.status !== 'ok' ||
  document.ownership?.phase !== 'PREPARED' ||
  !/^[0-9a-f]{64}$/.test(document.sourceFingerprint || '') ||
  !document.counts || typeof document.counts !== 'object' ||
  Object.keys(document.counts).length !== expectedCounts.length ||
  expectedCounts.some(key => !nonnegative(document.counts[key])) ||
  document.counts.offer !== 1 || document.counts.settings !== 1 ||
  (verifiedShape && (document.counts.relationshipViolations !== 0 ||
    document.counts.continuityViolations !== 0)) ||
  !document.eventTypes || Object.keys(document.eventTypes).length !== 0
) process.exit(1);
if (verifiedShape) {
  if (!document.tableFingerprints ||
      Object.keys(document.tableFingerprints).length !== canonical.length ||
      canonical.some(key => !/^[0-9a-f]{64}$/.test(
        document.tableFingerprints[key] || '',
      ))) process.exit(1);
} else if (document.tableFingerprints !== undefined) {
  if (Object.keys(document.tableFingerprints).length !== canonical.length ||
      canonical.some(key => !/^[0-9a-f]{64}$/.test(
        document.tableFingerprints[key] || '',
      ))) process.exit(1);
}
NODE
}

billing_cutover_validate_projection_evidence() {
	billing_cutover_validate_json_identity "$billing_projection_evidence" || return 1
	node - "$billing_projection_evidence" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const required = [
  'billing.payment.details.changed.v1',
  'billing.subscription.details.changed.v1',
  'billing.affiliate.changed.v1',
  'billing.settings.changed.v1',
];
const detailKeys = [
  'legacyPayments',
  'projectedPayments',
  'paymentIdLag',
  'paymentVersionLag',
  'legacySubscriptions',
  'projectedSubscriptions',
  'subscriptionIdLag',
  'subscriptionVersionLag',
  'legacyAffiliates',
  'projectedAffiliates',
  'affiliateIdLag',
  'affiliateVersionLag',
  'legacySettings',
  'projectedSettings',
  'settingsIdLag',
  'settingsVersionLag',
];
const eventTypes = Array.isArray(document.eventTypes)
  ? document.eventTypes
  : [];
const details = document.details;
if (
  document.schemaVersion !== 1 ||
  document.action !== 'projection-lag' ||
  document.lag !== 0 ||
  eventTypes.length !== required.length ||
  new Set(eventTypes).size !== required.length ||
  required.some(eventType => !eventTypes.includes(eventType)) ||
  !details || typeof details !== 'object' || Array.isArray(details) ||
  Object.keys(details).length !== detailKeys.length ||
  detailKeys.some(key => !/^(0|[1-9][0-9]*)$/.test(details[key]))
) process.exit(1);
NODE
}

billing_cutover_validate_seed_evidence() {
	billing_cutover_validate_json_identity "$billing_seed_evidence" || return 1
	node - "$billing_seed_evidence" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const required = [
  'billing.payment.details.changed.v1',
  'billing.subscription.details.changed.v1',
  'billing.affiliate.changed.v1',
  'billing.settings.changed.v1',
];
const isCount = value => Number.isSafeInteger(value) && value >= 0;
if (
  document.schemaVersion !== 1 ||
  document.service !== 'billing-service' ||
  document.action !== 'seed-core-read-events' ||
  document.status !== 'ok' ||
  !document.eventTypes || typeof document.eventTypes !== 'object' ||
  Array.isArray(document.eventTypes) ||
  Object.keys(document.eventTypes).length !== required.length ||
  required.some(eventType => {
    const counts = document.eventTypes[eventType];
    return !counts || !isCount(counts.sourceRows) ||
      !isCount(counts.eventsEnqueued) ||
      counts.sourceRows !== counts.eventsEnqueued;
  }) ||
  document.eventTypes['billing.settings.changed.v1'].sourceRows !== 1 ||
  document.eventTypes['billing.settings.changed.v1'].eventsEnqueued !== 1 ||
  !document.counts || !isCount(document.counts.pendingOutbox) ||
  !isCount(document.counts.seedPendingOutboxAtCommit)
) process.exit(1);
const seeded = required.reduce(
  (total, eventType) => total + document.eventTypes[eventType].eventsEnqueued,
  0,
);
if (
  document.counts.seedPendingOutboxAtCommit !== seeded ||
  document.counts.pendingOutbox > seeded
) process.exit(1);
NODE
}

billing_cutover_validate_billing_status_before_activate() {
	billing_cutover_validate_json_identity "$billing_service_status_evidence" ||
		return 1
	node - "$billing_service_status_evidence" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  document.schemaVersion !== 1 ||
  document.service !== 'billing-service' ||
  document.action !== 'status' ||
  document.status !== 'ok' ||
  document.ownership?.phase !== 'PREPARED' ||
  document.ownership.generation !== String(document.generation) ||
  document.ownership.preparedRevision !== document.revision ||
  document.ownership.ownershipRevision !== null ||
  document.ownership.cleanupRevision !== null ||
  !document.counts ||
  document.counts.pendingOutbox !== 0 ||
  !Number.isSafeInteger(document.counts.providerOperationsInFlight) ||
  document.counts.providerOperationsInFlight !== 0
) process.exit(1);
NODE
}

billing_cutover_validate_billing_transition() {
	[[ $# -eq 3 ]] || return 1
	local file="$1" expected_action="$2" expected_phase="$3"
	billing_cutover_validate_json_identity "$file" || return 1
	EXPECTED_ACTION="$expected_action" EXPECTED_PHASE="$expected_phase" \
		node - "$file" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ownership = document.ownership;
const active = process.env.EXPECTED_PHASE === 'ACTIVE';
if (
  document.schemaVersion !== 1 || document.service !== 'billing-service' ||
  document.action !== process.env.EXPECTED_ACTION || document.status !== 'ok' ||
  !ownership || ownership.phase !== process.env.EXPECTED_PHASE ||
  ownership.generation !== String(document.generation) ||
  ownership.preparedRevision !== document.revision ||
  ownership.ownershipRevision !== document.revision ||
  (active ? ownership.cleanupRevision !== null :
    ownership.cleanupRevision !== document.revision) ||
  !document.counts ||
  !Number.isSafeInteger(document.counts.pendingOutbox) ||
  !Number.isSafeInteger(document.counts.providerOperationsInFlight) ||
  (active && (document.counts.pendingOutbox !== 0 ||
    document.counts.providerOperationsInFlight !== 0)) ||
  !document.eventTypes || Object.keys(document.eventTypes).length !== 0
) process.exit(1);
NODE
}

billing_cutover_validate_billing_completed_status() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ownership = document.ownership;
if (
  document.schemaVersion !== 1 || document.service !== 'billing-service' ||
  document.action !== 'status' || document.status !== 'ok' ||
  !ownership || ownership.phase !== 'COMPLETE' ||
  ownership.generation !== String(document.generation) ||
  ownership.preparedRevision !== document.revision ||
  ownership.ownershipRevision !== document.revision ||
  ownership.cleanupRevision !== document.revision ||
  !document.counts || !Number.isSafeInteger(document.counts.pendingOutbox) ||
  !Number.isSafeInteger(document.counts.providerOperationsInFlight) ||
  !document.eventTypes || Object.keys(document.eventTypes).length !== 0
) process.exit(1);
NODE
}

billing_cutover_wait_seed_outbox() {
	local attempt
	for ((attempt = 1; attempt <= 120; attempt++)); do
		billing_cutover_run_billing_cli status \
			"$billing_service_status_evidence"
		if billing_cutover_validate_billing_status_before_activate; then
			return 0
		fi
		sleep 1
	done
	billing_cutover_fail \
		'Billing seed Outbox or provider-operation gate did not become quiescent.'
}

billing_cutover_wait_projection_lag_zero() {
	[[ $# -eq 1 ]] || return 1
	local generation="$1" attempt
	for ((attempt = 1; attempt <= 120; attempt++)); do
		billing_cutover_run_core_cli projection-lag \
			"$billing_projection_evidence" --revision "$EXPECTED_REVISION" \
			--generation "$generation"
		if billing_cutover_validate_projection_evidence; then
			return 0
		fi
		sleep 1
	done
	billing_cutover_fail \
		'Core Billing read projections did not reach exact lag zero.'
}

billing_cutover_validate_core_active_state() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = document.coreState;
const projectionTypes = [
  'billing.payment.details.changed.v1',
  'billing.subscription.details.changed.v1',
  'billing.affiliate.changed.v1',
  'billing.settings.changed.v1',
];
if (
  document.schemaVersion !== 1 ||
  !['status', 'activate'].includes(document.action) ||
  !state || state.id !== 'singleton' ||
  state.ownership !== 'BILLING' ||
  state.sourceProducersEnabled !== false ||
  state.legacyRoutesEnabled !== false ||
  state.schedulerEnabled !== false ||
  state.legacyConsumerEnabled !== false ||
  state.projectionConsumerEnabled !== true ||
  state.generation !== String(document.generation) ||
  state.preparedRevision !== document.revision ||
  state.ownershipRevision !== document.revision ||
  !state.activatedAt || !Number.isFinite(Date.parse(state.activatedAt)) ||
  (document.action === 'activate' && (
    document.lag !== 0 || !Array.isArray(document.eventTypes) ||
    document.eventTypes.length !== projectionTypes.length ||
    new Set(document.eventTypes).size !== projectionTypes.length ||
    projectionTypes.some(eventType => !document.eventTypes.includes(eventType))
  ))
) process.exit(1);
NODE
}

billing_cutover_core_ownership() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  document.schemaVersion !== 1 || document.action !== 'status' ||
  !document.coreState || document.coreState.id !== 'singleton' ||
  !['CORE', 'BILLING'].includes(document.coreState.ownership)
) process.exit(1);
process.stdout.write(document.coreState.ownership);
NODE
}

billing_cutover_billing_ownership_phase() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const phase = document.ownership?.phase;
if (
  document.schemaVersion !== 1 || document.service !== 'billing-service' ||
  document.action !== 'status' || document.status !== 'ok' ||
  !['PREPARED', 'ACTIVE', 'COMPLETE'].includes(phase)
) process.exit(1);
process.stdout.write(phase);
NODE
}

billing_cutover_parse_rabbit_url() {
	[[ $# -eq 2 ]] || return 1
	local raw
	raw="$(billing_read_env_value "$ENV_FILE" "$1")" || return 1
	printf '%s\n' "$raw" | EXPECTED_USER="$2" node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) process.exit(1);
let url;
try { url = new URL(raw.slice(0, -1)); } catch { process.exit(1); }
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const vhost = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (
  url.protocol !== "amqp:" || user !== process.env.EXPECTED_USER ||
  password.length < 32 || /[\0\r\n]/.test(password) ||
  url.hostname !== "127.0.0.1" || url.port !== "5672" ||
  vhost !== "winwidget" || url.search || url.hash
) process.exit(1);
process.stdout.write(`${user}\n${password}\n${vhost}`);
'
}

billing_cutover_rabbit_user() {
	[[ $# -eq 1 ]] || return 1
	local raw
	raw="$(billing_read_env_value "$ENV_FILE" "$1")" || return 1
	printf '%s\n' "$raw" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) process.exit(1);
let url;
try { url = new URL(raw.slice(0, -1)); } catch { process.exit(1); }
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const vhost = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (
  url.protocol !== "amqp:" || !/^[A-Za-z0-9._-]+$/.test(user) ||
  password.length < 32 || /[\0\r\n]/.test(password) ||
  url.hostname !== "127.0.0.1" || url.port !== "5672" ||
  vhost !== "winwidget" || url.search || url.hash
) process.exit(1);
process.stdout.write(user);
'
}

billing_cutover_provision_rabbit_user() {
	[[ $# -eq 7 ]] || return 1
	local container_id="$1" user="$2" password="$3" vhost="$4"
	local configure="$5" write="$6" read="$7"
	docker exec \
		-e "RABBITMQ_PROVISION_USER=$user" \
		-e "RABBITMQ_PROVISION_PASSWORD=$password" \
		-e "RABBITMQ_PROVISION_VHOST=$vhost" \
		-e "RABBITMQ_CONFIGURE_PATTERN=$configure" \
		-e "RABBITMQ_WRITE_PATTERN=$write" \
		-e "RABBITMQ_READ_PATTERN=$read" \
		"$container_id" sh -euc '
if rabbitmqctl list_users --silent | awk -v user="$RABBITMQ_PROVISION_USER" "\$1 == user { found=1 } END { exit(found ? 0 : 1) }"; then
  rabbitmqctl change_password "$RABBITMQ_PROVISION_USER" "$RABBITMQ_PROVISION_PASSWORD"
else
  rabbitmqctl add_user "$RABBITMQ_PROVISION_USER" "$RABBITMQ_PROVISION_PASSWORD"
fi
rabbitmqctl clear_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_PROVISION_USER" >/dev/null 2>&1 || true
rabbitmqctl set_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_PROVISION_USER" \
  "$RABBITMQ_CONFIGURE_PATTERN" "$RABBITMQ_WRITE_PATTERN" "$RABBITMQ_READ_PATTERN"
' >/dev/null
}

billing_cutover_provision_rabbit() {
	local container_id worker_credentials publisher_credentials
	local worker_user worker_password worker_vhost
	local publisher_user publisher_password publisher_vhost
	local -a worker_parts publisher_parts
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		billing_cutover_fail 'Exactly one healthy RabbitMQ container is required.' ||
		return 1
	worker_credentials="$(billing_cutover_parse_rabbit_url \
		RABBITMQ_BILLING_WORKER_URL winwidget-billing-worker)" || return 1
	publisher_credentials="$(billing_cutover_parse_rabbit_url \
		RABBITMQ_BILLING_PUBLISHER_URL winwidget-billing-publisher)" || return 1
	mapfile -t worker_parts <<<"$worker_credentials"
	mapfile -t publisher_parts <<<"$publisher_credentials"
	[[ ${#worker_parts[@]} -eq 3 && ${#publisher_parts[@]} -eq 3 ]] || return 1
	worker_user="${worker_parts[0]}"
	worker_password="${worker_parts[1]}"
	worker_vhost="${worker_parts[2]}"
	publisher_user="${publisher_parts[0]}"
	publisher_password="${publisher_parts[1]}"
	publisher_vhost="${publisher_parts[2]}"
	[[ "$worker_password" != "$publisher_password" &&
		"$worker_vhost" == "$publisher_vhost" ]] ||
		billing_cutover_fail 'Billing RabbitMQ identities must use distinct credentials.' ||
		return 1
	billing_cutover_provision_rabbit_user "$container_id" "$worker_user" \
		"$worker_password" "$worker_vhost" "$billing_worker_configure_pattern" \
		"$billing_worker_write_pattern" "$billing_worker_read_pattern"
	billing_cutover_provision_rabbit_user "$container_id" "$publisher_user" \
		"$publisher_password" "$publisher_vhost" '^$' \
		"$billing_publisher_write_pattern" '^$'
	docker exec "$container_id" rabbitmqctl set_topic_permissions \
		-p "$worker_vhost" "$worker_user" winwidget.events '^$' \
		"$billing_worker_topic_read_pattern" >/dev/null
	docker exec "$container_id" rabbitmqctl set_topic_permissions \
		-p "$publisher_vhost" "$publisher_user" winwidget.events \
		"$billing_publisher_topic_write_pattern" '^$' >/dev/null
	unset worker_password publisher_password worker_credentials publisher_credentials
}

billing_cutover_restrict_core_integration_permissions() {
	local container_id user vhost listing
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		billing_cutover_fail 'Exactly one healthy RabbitMQ container is required.' ||
		return 1
	user="$(billing_cutover_rabbit_user RABBITMQ_INTEGRATION_WORKER_URL)" ||
		return 1
	[[ "$user" == 'winwidget-integration' ]] || return 1
	vhost="$(billing_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$vhost" == 'winwidget' ]] || return 1
	docker exec \
		-e "RABBITMQ_PERMISSION_USER=$user" \
		-e "RABBITMQ_PERMISSION_VHOST=$vhost" \
		-e "RABBITMQ_PERMISSION_WRITE=$core_integration_write_pattern" \
		-e "RABBITMQ_PERMISSION_READ=$core_integration_post_billing_read_pattern" \
		"$container_id" sh -euc '
rabbitmqctl set_permissions -p "$RABBITMQ_PERMISSION_VHOST" \
  "$RABBITMQ_PERMISSION_USER" "^$" "$RABBITMQ_PERMISSION_WRITE" \
  "$RABBITMQ_PERMISSION_READ"
' >/dev/null
	listing="$(docker exec "$container_id" rabbitmqctl --silent \
		list_user_permissions "$user")" || return 1
	printf '%s\n' "$listing" | \
		EXPECTED_VHOST="$vhost" \
		EXPECTED_WRITE="$core_integration_write_pattern" \
		EXPECTED_READ="$core_integration_post_billing_read_pattern" \
		node -e '
const fs = require("node:fs");
const rows = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean)
  .map(line => line.trim().split(/\s+/));
if (
  rows.length !== 1 || rows[0].length !== 4 ||
  rows[0][0] !== process.env.EXPECTED_VHOST || rows[0][1] !== "^$" ||
  rows[0][2] !== process.env.EXPECTED_WRITE ||
  rows[0][3] !== process.env.EXPECTED_READ
) process.exit(1);
' || billing_cutover_fail \
		'Core integration RabbitMQ permissions were not narrowed after Billing ownership.'
	unset listing
}

billing_cutover_verify_candidate_images() {
	local core_image billing_image core_id core_revision core_user
	core_image="winwidget-api:git-$EXPECTED_REVISION"
	billing_image="$(billing_release_identity_value BILLING_IMAGE "$EXPECTED_REVISION")"
	billing_compose_config_all_profiles "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE"
	billing_deploy_verify_image "$billing_image"
	core_id="$(docker image inspect --format '{{.Id}}' "$core_image")"
	core_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$core_image")"
	core_user="$(docker image inspect --format '{{.Config.User}}' "$core_image")"
	[[ "$core_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$core_revision" == "$EXPECTED_REVISION" &&
		-n "$core_user" && "$core_user" != '0' && "$core_user" != 'root' ]] ||
		billing_cutover_fail \
			'Core candidate image must be immutable, revision-labelled and non-root.' ||
			return 1
	billing_cutover_core_image_id="$core_id"
	billing_cutover_billing_image_id="$billing_deploy_image_id"
	[[ "$billing_cutover_billing_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
		return 1
	docker run --rm --network none --entrypoint node "$core_image" -e '
const fs = require("node:fs");
for (const path of [
  "dist/src/outbox-publisher-main.js",
  "dist/src/billing-core-cutover-main.js",
  "prisma/schema.prisma",
]) fs.accessSync(path);
' >/dev/null
	docker run --rm --network none --entrypoint node "$billing_image" -e '
const fs = require("node:fs");
for (const path of [
  "dist/src/main.js",
  "dist/src/cutover-main.js",
  "prisma/schema.prisma",
]) fs.accessSync(path);
' >/dev/null
}

billing_cutover_build_candidate_images() {
	billing_compose_config_all_profiles "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE"
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull --provenance=false api billing-api
	billing_cutover_verify_candidate_images
}

billing_cutover_verify_dark_source_topology() {
	local container_id vhost listing
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		billing_cutover_fail 'RabbitMQ is not running for Billing source topology.' ||
		return 1
	vhost="$(billing_read_env_value "$ENV_FILE" RABBITMQ_VHOST)"
	[[ "$vhost" == 'winwidget' ]] || return 1
	listing="$(docker exec "$container_id" rabbitmqctl --silent list_queues \
		-p "$vhost" name consumers messages_ready messages_unacknowledged)" ||
		return 1
	printf '%s\n' "$listing" | node -e '
const fs = require("node:fs");
const rows = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const queues = new Map(rows.map(([name, consumers, ready, unacked]) => [
  name,
  { consumers: Number(consumers), ready: Number(ready), unacked: Number(unacked) },
]));
const source = [
  "winwidget.billing.identity.v1",
  "winwidget.billing.notification-routing.v1",
  "winwidget.billing.settings-source.v1",
  "winwidget.billing.trial.v1",
  "winwidget.billing.referral.v1",
  "winwidget.billing.offer.v1",
  "winwidget.billing.lifecycle-repair.v1",
];
const active = [
  "winwidget.payment.auto-renewal",
  "winwidget.billing.notification-delivery-outcome",
];
const all = [...source, ...active];
for (const queue of all) {
  for (const suffix of ["", ".retry.1", ".retry.2", ".retry.3", ".dead-letter"])
    if (!queues.has(`${queue}${suffix}`)) process.exit(1);
}
if (source.some(queue => queues.get(queue).consumers !== 1)) process.exit(1);
if (queues.get("winwidget.billing.notification-delivery-outcome").consumers !== 0)
  process.exit(1);
' || billing_cutover_fail \
		'Billing dark worker source queues/consumers are not exact.'
}

billing_cutover_source_consumers_are() {
	[[ $# -eq 1 && "$1" =~ ^(0|1)$ ]] || return 1
	local container_id vhost expected="$1"
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	vhost="$(billing_read_env_value "$ENV_FILE" RABBITMQ_VHOST)"
	docker exec "$container_id" rabbitmqctl --silent list_queues -p "$vhost" \
		name consumers | EXPECTED_CONSUMERS="$expected" node -e '
const fs = require("node:fs");
const rows = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const queues = new Map(rows.map(([name, consumers]) => [name, Number(consumers)]));
const source = [
  "winwidget.billing.identity.v1",
  "winwidget.billing.notification-routing.v1",
  "winwidget.billing.settings-source.v1",
  "winwidget.billing.trial.v1",
  "winwidget.billing.referral.v1",
  "winwidget.billing.offer.v1",
  "winwidget.billing.lifecycle-repair.v1",
];
const expected = Number(process.env.EXPECTED_CONSUMERS);
for (const queue of source) {
  if (queues.get(queue) !== expected) process.exit(1);
  for (const suffix of [".retry.1", ".retry.2", ".retry.3", ".dead-letter"])
    if (queues.get(`${queue}${suffix}`) !== 0) process.exit(1);
}
'
}

billing_cutover_wait_source_consumers() {
	[[ $# -eq 1 ]] || return 1
	local attempt
	for ((attempt = 1; attempt <= 60; attempt++)); do
		billing_cutover_source_consumers_are "$1" && return 0
		sleep 1
	done
	billing_cutover_fail \
		"Billing source consumers did not reach exact count=$1 on every queue."
}

billing_cutover_stop_source_worker_for_snapshot() {
	billing_cutover_wait_core_outbox billing-source
	local attempt
	for ((attempt = 1; attempt <= 60; attempt++)); do
		billing_cutover_source_queues_are_drained && break
		sleep 1
	done
	((attempt <= 60)) || billing_cutover_fail \
		'Billing source queues did not drain before the frozen snapshot.' || return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop -t 90 billing-worker >/dev/null
	billing_cutover_wait_source_consumers 0
}

billing_cutover_start_dark_source_worker() {
	if billing_cutover_source_consumers_are 1; then
		return 0
	fi
	billing_cutover_source_consumers_are 0 ||
		billing_cutover_fail \
			'Billing source queues have a partial/competing consumer set.' || return 1
	env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
		EXPECTED_REVISION="$EXPECTED_REVISION" BILLING_DEPLOY_SKIP_BUILD=true \
		bash "$server_root/scripts/deploy-billing-production.sh" --deploy
	billing_cutover_verify_dark_source_topology
}

billing_cutover_core_source_producers() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_json_identity "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  document.schemaVersion !== 1 || document.action !== 'status' ||
  !document.coreState ||
  typeof document.coreState.sourceProducersEnabled !== 'boolean'
) process.exit(1);
process.stdout.write(String(document.coreState.sourceProducersEnabled));
NODE
}

billing_cutover_source_queues_are_drained() {
	local container_id vhost
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	vhost="$(billing_read_env_value "$ENV_FILE" RABBITMQ_VHOST)"
	docker exec "$container_id" rabbitmqctl --silent list_queues -p "$vhost" \
		name consumers messages_ready messages_unacknowledged | node -e '
const fs = require("node:fs");
const rows = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const queues = new Map(rows.map(([name, consumers, ready, unacked]) => [
  name,
  { consumers: Number(consumers), ready: Number(ready), unacked: Number(unacked) },
]));
const source = [
  "winwidget.billing.identity.v1",
  "winwidget.billing.notification-routing.v1",
  "winwidget.billing.settings-source.v1",
  "winwidget.billing.trial.v1",
  "winwidget.billing.referral.v1",
  "winwidget.billing.offer.v1",
  "winwidget.billing.lifecycle-repair.v1",
];
for (const queue of source) {
  if (queues.get(queue)?.consumers !== 1) process.exit(1);
  for (const suffix of ["", ".retry.1", ".retry.2", ".retry.3", ".dead-letter"]) {
    const state = queues.get(`${queue}${suffix}`);
    if (!state || state.ready !== 0 || state.unacked !== 0) process.exit(1);
  }
}
'
}

billing_cutover_capture_auto_renewal_ownership() {
	[[ $# -eq 6 ]] || return 1
	local expected_consumers="$1" expected_connection="$2" expected_user="$3"
	local evidence_stage="$4" destination="$5" expected_redeliver="$6"
	local management_url monitor_user monitor_password evidence temporary image
	management_url="$(billing_read_env_value "$ENV_FILE" RABBITMQ_MANAGEMENT_URL)"
	monitor_user="$(billing_read_env_value "$ENV_FILE" RABBITMQ_MONITOR_USER)"
	monitor_password="$(billing_read_env_value "$ENV_FILE" RABBITMQ_MONITOR_PASSWORD)"
	[[ "$management_url" == 'http://127.0.0.1:15672' &&
		"$expected_consumers" =~ ^(0|1)$ &&
		"$monitor_user" =~ ^[A-Za-z0-9._-]+$ &&
		${#monitor_password} -ge 32 ]] || return 1
	image="winwidget-api:git-$EXPECTED_REVISION"
	export RABBITMQ_MANAGEMENT_URL="$management_url"
	export RABBITMQ_MONITOR_USER="$monitor_user"
	export RABBITMQ_MONITOR_PASSWORD="$monitor_password"
	export RABBITMQ_EXPECTED_CONSUMERS="$expected_consumers"
	export RABBITMQ_EXPECTED_CONNECTION="$expected_connection"
	export RABBITMQ_EXPECTED_USER="$expected_user"
	export RABBITMQ_EVIDENCE_STAGE="$evidence_stage"
	export RABBITMQ_EXPECTED_REDELIVER="$expected_redeliver"
	evidence="$(docker run --rm --network host \
		-e RABBITMQ_MANAGEMENT_URL -e RABBITMQ_MONITOR_USER \
		-e RABBITMQ_MONITOR_PASSWORD -e RABBITMQ_EXPECTED_CONSUMERS \
		-e RABBITMQ_EXPECTED_CONNECTION -e RABBITMQ_EXPECTED_USER \
		-e RABBITMQ_EVIDENCE_STAGE -e RABBITMQ_EXPECTED_REDELIVER \
		--entrypoint node "$image" -e '
const queueName = "winwidget.payment.auto-renewal";
const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL;
const vhost = "winwidget";
const authorization = `Basic ${Buffer.from(
  `${process.env.RABBITMQ_MONITOR_USER}:${process.env.RABBITMQ_MONITOR_PASSWORD}`,
).toString("base64")}`;
const request = async path => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`RabbitMQ Management HTTP ${response.status}`);
  }
  return response.json();
};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const run = async () => {
  const [connections, queue] = await Promise.all([
    request("/api/connections"),
    request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueName)}`),
  ]);
  if (!Array.isArray(connections) || !queue || typeof queue !== "object") {
    throw new Error("RabbitMQ Management response is invalid");
  }
  const bySocket = new Map(connections.map(connection => [connection.name, connection]));
  const consumers = Array.isArray(queue.consumer_details)
    ? queue.consumer_details
    : [];
  const expectedConsumers = Number(process.env.RABBITMQ_EXPECTED_CONSUMERS);
  if (consumers.length !== expectedConsumers) {
    throw new Error("Auto-renewal consumer count is not at the ownership gate");
  }
  const owners = consumers.map(consumer => {
    const connection = bySocket.get(consumer?.channel_details?.connection_name);
    return {
      user: connection?.user ?? null,
      connectionName: connection?.client_properties?.connection_name ?? null,
    };
  });
  if (expectedConsumers === 1 && (
    owners[0]?.user !== process.env.RABBITMQ_EXPECTED_USER ||
    owners[0]?.connectionName !== process.env.RABBITMQ_EXPECTED_CONNECTION
  )) throw new Error("Auto-renewal consumer owner is not exact");
  const messagesReady = queue.messages_ready;
  const messagesUnacknowledged = queue.messages_unacknowledged;
  const redeliver = queue.message_stats?.redeliver ?? 0;
  if (!integer(messagesReady) || !integer(messagesUnacknowledged) ||
      !integer(redeliver) || messagesUnacknowledged !== 0) {
    throw new Error("Auto-renewal queue is not quiescent");
  }
  const expectedRedeliver = process.env.RABBITMQ_EXPECTED_REDELIVER;
  if (expectedRedeliver && Number(expectedRedeliver) !== redeliver) {
    throw new Error("Auto-renewal handoff caused a redelivery");
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    queue: queueName,
    stage: process.env.RABBITMQ_EVIDENCE_STAGE,
    consumers: consumers.length,
    messagesReady,
    messagesUnacknowledged,
    redeliver,
    owners,
    observedAt: new Date().toISOString(),
  }));
};
run().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
')" || {
		unset RABBITMQ_MANAGEMENT_URL RABBITMQ_MONITOR_USER \
			RABBITMQ_MONITOR_PASSWORD RABBITMQ_EXPECTED_CONSUMERS \
			RABBITMQ_EXPECTED_CONNECTION RABBITMQ_EXPECTED_USER \
			RABBITMQ_EVIDENCE_STAGE RABBITMQ_EXPECTED_REDELIVER
		return 1
	}
	unset RABBITMQ_MANAGEMENT_URL RABBITMQ_MONITOR_USER \
		RABBITMQ_MONITOR_PASSWORD RABBITMQ_EXPECTED_CONSUMERS \
		RABBITMQ_EXPECTED_CONNECTION RABBITMQ_EXPECTED_USER \
		RABBITMQ_EVIDENCE_STAGE RABBITMQ_EXPECTED_REDELIVER
	billing_cutover_require_artifact_root
	temporary="$destination.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	(umask 077; printf '%s\n' "$evidence" >"$temporary")
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$destination"
	billing_cutover_validate_evidence_file "$destination"
}

billing_cutover_wait_auto_renewal_ownership() {
	[[ $# -eq 6 ]] || return 1
	local attempt
	for ((attempt = 1; attempt <= 60; attempt++)); do
		if billing_cutover_capture_auto_renewal_ownership "$@" 2>/dev/null; then
			return 0
		fi
		sleep 1
	done
	billing_cutover_fail \
		'RabbitMQ auto-renewal consumer ownership did not reach the required safe state.'
}

billing_cutover_auto_renewal_redeliver() {
	[[ $# -eq 1 ]] || return 1
	billing_cutover_validate_evidence_file "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Number.isSafeInteger(evidence.redeliver) || evidence.redeliver < 0) process.exit(1);
process.stdout.write(String(evidence.redeliver));
NODE
}

billing_cutover_core_migration_state() {
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps \
		--entrypoint node migrate -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const migration = process.argv[1];
void prisma.$queryRawUnsafe(`
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,
    COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished
  FROM "_prisma_migrations"
  WHERE migration_name = $1
`, migration).then(([row]) => {
  if (row.total === 0) process.stdout.write("pending");
  else if (row.total === 1 && row.applied === 1) process.stdout.write("applied");
  else if (row.total === 1 && row.unfinished === 1) process.stdout.write("unfinished");
  else process.stdout.write("unsafe");
}).finally(() => prisma.$disconnect());
' "$billing_core_expand_migration" | tail -n 1
}

billing_cutover_core_outbox_state() {
	[[ $# -eq 1 && "$1" =~ ^(global|billing-source)$ ]] || return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps \
		--entrypoint node migrate -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const sourceOnly = process.argv[1] === "billing-source";
	const filter = sourceOnly ? `AND "event_type" IN (
	  $event$billing.identity.changed.v1$event$,
	  $event$billing.notification-routing.changed.v1$event$,
	  $event$billing.settings.source.changed.v1$event$,
	  $event$billing.offer.changed.v1$event$,
	  $event$billing.trial.requested.v1$event$,
	  $event$billing.referral.requested.v1$event$,
	  $event$billing.lifecycle-repair.requested.v1$event$
	)` : "";
	void prisma.$queryRawUnsafe(`
	  SELECT
	    COUNT(*) FILTER (WHERE "status"::text = $status$FAILED$status$)::int AS failed,
	    COUNT(*) FILTER (WHERE "status"::text = $status$PUBLISHING$status$)::int AS publishing,
	    COUNT(*) FILTER (WHERE "status"::text = $status$PENDING$status$)::int AS pending,
	    COUNT(*) FILTER (
      WHERE "status"::text = $status$PENDING$status$
        AND "available_at" <= CURRENT_TIMESTAMP
    )::int AS due
  FROM "outbox_events"
  WHERE TRUE ${filter}
	`).then(([row]) => process.stdout.write(`${row.failed}|${row.publishing}|${row.pending}|${row.due}`))
  .finally(() => prisma.$disconnect());
' "$1" | tail -n 1
}

billing_cutover_wait_core_outbox() {
	[[ $# -eq 1 && "$1" =~ ^(global|billing-source)$ ]] || return 1
	local mode="$1" attempt state failed publishing pending due
	for ((attempt = 1; attempt <= 60; attempt++)); do
		state="$(billing_cutover_core_outbox_state "$mode" 2>/dev/null || true)"
		IFS='|' read -r failed publishing pending due <<<"$state"
		if [[ "$failed" == '0' && "$publishing" == '0' &&
			"$pending" == '0' && "$due" == '0' ]]; then
			return 0
		fi
		sleep 1
	done
	billing_cutover_fail "Core Outbox did not drain safely for mode=$mode."
}

billing_cutover_verify_candidate_core_publisher() {
	local attempt container_id image_id image_revision restart_count command
	for ((attempt = 1; attempt <= 60; attempt++)); do
		container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
			"$COMPOSE_FILE" ps --status running -q outbox-publisher \
			2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
			image_revision="$(docker image inspect --format \
				'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
				"$image_id")"
			restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
			command="$(docker inspect --format '{{json .Config.Cmd}}' "$container_id")"
			if [[ "$image_revision" == "$EXPECTED_REVISION" &&
				"$restart_count" == '0' &&
				"$command" == '["node","dist/src/outbox-publisher-main.js"]' ]]; then
				return 0
			fi
		fi
		sleep 1
	done
	billing_cutover_fail 'Candidate Core Outbox publisher failed exact revision verification.'
}

billing_cutover_recover_core_publisher() {
	local migration_state container_id
	migration_state="$(billing_cutover_core_migration_state 2>/dev/null || \
		printf 'unsafe')"
	case "$migration_state" in
	pending)
		container_id="$billing_cutover_legacy_publisher_id"
		if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
				"$COMPOSE_FILE" ps -a -q outbox-publisher 2>/dev/null || true)"
		fi
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] &&
			docker start "$container_id" >/dev/null; then
			printf 'billing_core_publisher_recovery=legacy-restarted\n' >&2
		else
			printf 'CRITICAL: pending Billing Core migration has no recoverable legacy publisher.\n' >&2
		fi
		;;
	applied)
		if billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate outbox-publisher \
			>/dev/null 2>&1; then
			printf 'billing_core_publisher_recovery=candidate-started\n' >&2
		else
			printf 'CRITICAL: Billing Core migration is applied but candidate publisher could not start.\n' >&2
		fi
		;;
	*)
		printf 'CRITICAL: Billing Core migration state is ambiguous; publisher remains fail-closed.\n' >&2
		;;
	esac
}

billing_cutover_install_core_expand_migration() {
	local migration_state container_id stopped_state attempt state publishing
	migration_state="$(billing_cutover_core_migration_state)" || return 1
	case "$migration_state" in
	applied)
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate outbox-publisher
		billing_cutover_verify_candidate_core_publisher
		billing_cutover_wait_core_outbox billing-source
		for ((attempt = 1; attempt <= 60; attempt++)); do
			billing_cutover_source_queues_are_drained && return 0
			sleep 1
		done
		billing_cutover_fail 'Billing source queues did not drain after Core migration recovery.'
		return 1
		;;
	pending) ;;
	unfinished | unsafe)
		billing_cutover_fail \
			"Billing Core expand migration requires manual ledger reconciliation: state=$migration_state."
		return 1
		;;
	*) return 1 ;;
	esac
	billing_cutover_wait_core_outbox global
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q outbox-publisher)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		billing_cutover_fail 'A running legacy Core publisher is required before migration.' ||
		return 1
	billing_cutover_legacy_publisher_id="$container_id"
	billing_cutover_publisher_recovery_active='true'
	docker stop --time 30 "$container_id" >/dev/null
	stopped_state="$(docker inspect --format \
		'{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' \
		"$container_id")"
	[[ "$stopped_state" == 'exited|0|false|' ||
		"$stopped_state" == 'exited|143|false|' ]] ||
		billing_cutover_fail 'Legacy Core publisher did not stop cleanly.' || return 1
	[[ "$(billing_cutover_core_migration_state)" == 'pending' ]] ||
		billing_cutover_fail 'Core migration state changed before the guarded command.' ||
		return 1
	state="$(billing_cutover_core_outbox_state global)"
	IFS='|' read -r _ publishing _ _ <<<"$state"
	[[ "$publishing" == '0' ]] ||
		billing_cutover_fail 'Core Outbox retains a publishing claim after publisher stop.' ||
		return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps migrate
	[[ "$(billing_cutover_core_migration_state)" == 'applied' ]] ||
		billing_cutover_fail 'Billing Core expand migration did not reach applied.' ||
		return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate outbox-publisher
	billing_cutover_verify_candidate_core_publisher
	billing_cutover_wait_core_outbox billing-source
	for ((attempt = 1; attempt <= 60; attempt++)); do
		if billing_cutover_source_queues_are_drained; then
			billing_cutover_publisher_recovery_active='false'
			return 0
		fi
		sleep 1
	done
	billing_cutover_fail 'Billing source queues did not drain after publisher replacement.'
}

billing_cutover_create_backup() {
	[[ $# -eq 4 ]] || return 1
	local url_key="$1" schema="$2" destination="$3" label="$4"
	local partial="$destination.partial" size
	if [[ -e "$destination" || -L "$destination" ]]; then
		billing_cutover_validate_evidence_file "$destination" || return 1
		[[ "$(head -c 5 "$destination")" == 'PGDMP' ]] ||
			billing_cutover_fail \
				"Existing maintenance backup is not a custom PostgreSQL dump: $label" ||
			return 1
		size="$(wc -c <"$destination" | tr -d '[:space:]')"
		[[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 &&
			"$size" -le $((49 * 1024 * 1024)) ]] ||
			billing_cutover_fail \
				"Existing maintenance backup is outside the bounded size: $label" ||
			return 1
		return 0
	fi
	if [[ -e "$partial" || -L "$partial" ]]; then
		billing_cutover_validate_partial_file "$partial" || return 1
		rm -f -- "$partial"
	fi
	(umask 077; billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps --entrypoint sh maintenance-worker \
		-euc 'url_key="$1"; schema="$2"; database_url="$(printenv "$url_key")"; test -n "$database_url"; export PGDATABASE="$database_url"; unset database_url; exec pg_dump --format=custom --compress=6 --no-owner --no-acl --no-password --schema "$schema"' \
		sh "$url_key" "$schema" >"$partial")
	[[ "$(head -c 5 "$partial")" == 'PGDMP' ]] ||
		billing_cutover_fail "Maintenance backup is not a custom PostgreSQL dump: $label" ||
		return 1
	size="$(wc -c <"$partial" | tr -d '[:space:]')"
	[[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 &&
		"$size" -le $((49 * 1024 * 1024)) ]] ||
		billing_cutover_fail "Maintenance backup is outside the bounded size: $label" ||
		return 1
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -f "$partial" "$destination"
	billing_cutover_validate_evidence_file "$destination"
}

billing_cutover_promote_import_partial() {
	[[ $# -eq 3 ]] || return 1
	local source="$1" partial="$2" destination="$3" source_sha
	[[ ! -e "$destination" && ! -L "$destination" ]] || return 1
	source_sha="$(billing_cutover_sha256 "$source")" || return 1
	if [[ -e "$partial" || -L "$partial" ]]; then
		billing_cutover_validate_partial_file "$partial" || return 1
		if [[ "$(billing_cutover_sha256 "$partial")" != "$source_sha" ]]; then
			rm -f -- "$partial"
		fi
	fi
	if [[ ! -e "$partial" && ! -L "$partial" ]]; then
		cp -- "$source" "$partial"
		chown 0:0 "$partial"
		chmod 600 "$partial"
	fi
	[[ "$(billing_cutover_sha256 "$partial")" == "$source_sha" ]] || return 1
	mv -f -- "$partial" "$destination"
}

billing_cutover_create_pre_backups() {
	local core_sha billing_sha core_size billing_size temporary
	billing_cutover_create_backup DATABASE_BACKUP_URL public \
		"$billing_core_backup" core
	billing_cutover_create_backup BILLING_BACKUP_URL billing \
		"$billing_service_backup" billing
	core_sha="$(billing_cutover_sha256 "$billing_core_backup")"
	billing_sha="$(billing_cutover_sha256 "$billing_service_backup")"
	core_size="$(wc -c <"$billing_core_backup" | tr -d '[:space:]')"
	billing_size="$(wc -c <"$billing_service_backup" | tr -d '[:space:]')"
	if [[ -e "$billing_pre_backup_manifest" || -L "$billing_pre_backup_manifest" ]]; then
		billing_cutover_validate_evidence_file "$billing_pre_backup_manifest" || return 1
		EXPECTED_REVISION="$EXPECTED_REVISION" \
			EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
			EXPECTED_CORE_IMAGE_ID="$(billing_database_marker_value core_image_id)" \
			EXPECTED_BILLING_IMAGE_ID="$(billing_database_marker_value billing_image_id)" \
			EXPECTED_CORE_SHA="$core_sha" EXPECTED_BILLING_SHA="$billing_sha" \
			EXPECTED_CORE_SIZE="$core_size" EXPECTED_BILLING_SIZE="$billing_size" \
			node - "$billing_pre_backup_manifest" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const exact = ['billingDumpSha256', 'billingDumpSizeBytes', 'billingImageId',
  'coreDumpSha256', 'coreDumpSizeBytes', 'coreImageId', 'generation',
  'revision', 'version'];
if (!value || Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== exact.sort().join('|') ||
    value.version !== 2 || value.revision !== process.env.EXPECTED_REVISION ||
    String(value.generation) !== process.env.EXPECTED_GENERATION ||
    value.coreImageId !== process.env.EXPECTED_CORE_IMAGE_ID ||
    value.billingImageId !== process.env.EXPECTED_BILLING_IMAGE_ID ||
    value.coreDumpSha256 !== process.env.EXPECTED_CORE_SHA ||
    value.billingDumpSha256 !== process.env.EXPECTED_BILLING_SHA ||
    String(value.coreDumpSizeBytes) !== process.env.EXPECTED_CORE_SIZE ||
    String(value.billingDumpSizeBytes) !== process.env.EXPECTED_BILLING_SIZE) process.exit(1);
NODE
		return
	fi
	temporary="$billing_pre_backup_manifest.$$"
	(umask 077; {
		printf '{"version":2,"revision":"%s","generation":%s,' \
			"$EXPECTED_REVISION" "$(billing_cutover_marker_value generation)"
		printf '"coreImageId":"%s","billingImageId":"%s",' \
			"$(billing_database_marker_value core_image_id)" \
			"$(billing_database_marker_value billing_image_id)"
		printf '"coreDumpSha256":"%s","coreDumpSizeBytes":%s,' \
			"$core_sha" "$core_size"
		printf '"billingDumpSha256":"%s","billingDumpSizeBytes":%s}\n' \
			"$billing_sha" "$billing_size"
	} >"$temporary")
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$billing_pre_backup_manifest"
}

billing_cutover_validate_actual_restore_evidence() {
	[[ $# -eq 2 ]] || return 1
	local evidence="$1" phase="$2" core_sha billing_pre_sha billing_post_sha
	local core_size billing_pre_size billing_post_size previous_evidence=''
	[[ "$phase" =~ ^(pre-cutover|post-ownership)$ ]] || return 1
	billing_cutover_validate_evidence_file "$evidence" || return 1
	billing_cutover_validate_frozen_snapshot || return 1
	billing_cutover_validate_evidence_file "$billing_pre_backup_manifest" || return 1
	billing_cutover_validate_evidence_file "$billing_core_backup" || return 1
	billing_cutover_validate_evidence_file "$billing_service_backup" || return 1
	core_sha="$(billing_cutover_sha256 "$billing_core_backup")" || return 1
	billing_pre_sha="$(billing_cutover_sha256 "$billing_service_backup")" || return 1
	core_size="$(wc -c <"$billing_core_backup" | tr -d '[:space:]')"
	billing_pre_size="$(wc -c <"$billing_service_backup" | tr -d '[:space:]')"
	if [[ "$phase" == 'post-ownership' ]]; then
		billing_cutover_validate_evidence_file "$billing_post_backup" || return 1
		billing_cutover_validate_actual_restore_evidence \
			"$billing_pre_restore_evidence" pre-cutover || return 1
		billing_post_sha="$(billing_cutover_sha256 "$billing_post_backup")" || return 1
		billing_post_size="$(wc -c <"$billing_post_backup" | tr -d '[:space:]')"
		previous_evidence="$billing_pre_restore_evidence"
	else
		billing_post_sha='pending'
		billing_post_size='0'
	fi
	EVIDENCE_FILE="$evidence" SNAPSHOT_FILE="$billing_snapshot_file" \
		MANIFEST_FILE="$billing_pre_backup_manifest" \
		PREVIOUS_EVIDENCE_FILE="$previous_evidence" \
		EXPECTED_PHASE="$phase" EXPECTED_REVISION="$EXPECTED_REVISION" \
		EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
		EXPECTED_DATABASE_ID="$(billing_database_marker_value database_id)" \
		EXPECTED_DATABASE_SYSTEM_ID="$(billing_database_marker_value database_system_identifier)" \
		EXPECTED_CORE_IMAGE_ID="$(billing_database_marker_value core_image_id)" \
		EXPECTED_BILLING_IMAGE_ID="$(billing_database_marker_value billing_image_id)" \
		EXPECTED_POSTGRES_IMAGE_ID="$(billing_database_marker_value postgres_image_id)" \
		EXPECTED_POSTGRES_IMAGE="$billing_postgres_image" \
		EXPECTED_CORE_SHA="$core_sha" EXPECTED_CORE_SIZE="$core_size" \
		EXPECTED_BILLING_PRE_SHA="$billing_pre_sha" \
		EXPECTED_BILLING_PRE_SIZE="$billing_pre_size" \
		EXPECTED_BILLING_POST_SHA="$billing_post_sha" \
		EXPECTED_BILLING_POST_SIZE="$billing_post_size" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const parse = path => {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { process.exit(1); }
};
const value = parse(process.env.EVIDENCE_FILE);
const snapshot = parse(process.env.SNAPSHOT_FILE);
const manifest = parse(process.env.MANIFEST_FILE);
const previous = process.env.PREVIOUS_EVIDENCE_FILE
  ? parse(process.env.PREVIOUS_EVIDENCE_FILE)
  : null;
const exact = (object, keys) => object && typeof object === 'object' &&
  !Array.isArray(object) && Object.keys(object).sort().join('|') ===
    [...keys].sort().join('|');
const sha = input => /^[0-9a-f]{64}$/.test(input || '');
const imageId = input => /^sha256:[0-9a-f]{64}$/.test(input || '');
const positiveInteger = input => Number.isSafeInteger(input) && input > 0;
const systemIdentifier = input => /^[1-9][0-9]*$/.test(String(input ?? ''));
const timestamp = input => typeof input === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input) &&
  Number.isFinite(Date.parse(input));
const dump = input => exact(input, ['sha256', 'sizeBytes', 'tocSha256']) &&
  sha(input.sha256) && positiveInteger(input.sizeBytes) && sha(input.tocSha256);
const restore = input => exact(input, [
  'systemIdentifier', 'tableCount', 'tableManifestSha256',
  'rowManifestSha256', 'migrationCount', 'migrationLedgerSha256',
]) && systemIdentifier(input.systemIdentifier) && positiveInteger(input.tableCount) &&
  sha(input.tableManifestSha256) && sha(input.rowManifestSha256) &&
  positiveInteger(input.migrationCount) && sha(input.migrationLedgerSha256);
const allTrue = (input, keys) => exact(input, keys) &&
  keys.every(key => input[key] === true);
const topKeys = [
  'schemaVersion', 'action', 'target', 'status', 'postgresMajor', 'phase',
  'revision', 'generation', 'images', 'dumps', 'restores', 'anchors',
  'checks', 'startedAt', 'completedAt',
];
if (process.env.EXPECTED_PHASE === 'post-ownership') {
  topKeys.push('preEvidenceSha256');
}
const commonChecks = [
  'sourceFilesSafe', 'dumpShaStable', 'manifestBinding', 'toc',
  'releaseImages', 'isolatedTargets', 'noHostPorts', 'distinctClusters',
  'migrations', 'anchors', 'acl', 'relationships', 'continuity',
  'resourcesRemoved',
];
if (
  !exact(value, topKeys) || value.schemaVersion !== 1 ||
  value.action !== 'billing-actual-backup-restore-rehearsal' ||
  value.target !== 'billing' || value.status !== 'passed' ||
  value.postgresMajor !== 18 || value.phase !== process.env.EXPECTED_PHASE ||
  value.revision !== process.env.EXPECTED_REVISION ||
  String(value.generation) !== process.env.EXPECTED_GENERATION ||
  !timestamp(value.startedAt) || !timestamp(value.completedAt) ||
  Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
  !exact(value.images, ['core', 'billing', 'postgres']) ||
  !exact(value.images.core, ['ref', 'imageId', 'revision', 'user']) ||
  value.images.core.ref !== `winwidget-api:git-${process.env.EXPECTED_REVISION}` ||
  value.images.core.imageId !== process.env.EXPECTED_CORE_IMAGE_ID ||
  value.images.core.revision !== process.env.EXPECTED_REVISION ||
  value.images.core.user !== 'nestjs' ||
  !exact(value.images.billing, ['ref', 'imageId', 'revision', 'user']) ||
  value.images.billing.ref !== `winwidget-billing:git-${process.env.EXPECTED_REVISION}` ||
  value.images.billing.imageId !== process.env.EXPECTED_BILLING_IMAGE_ID ||
  value.images.billing.revision !== process.env.EXPECTED_REVISION ||
  value.images.billing.user !== 'billing' ||
  !exact(value.images.postgres, ['ref', 'imageId', 'major']) ||
  value.images.postgres.ref !== process.env.EXPECTED_POSTGRES_IMAGE ||
  value.images.postgres.imageId !== process.env.EXPECTED_POSTGRES_IMAGE_ID ||
  value.images.postgres.major !== 18 ||
  !imageId(value.images.core.imageId) || !imageId(value.images.billing.imageId) ||
  !imageId(value.images.postgres.imageId) ||
  !exact(manifest, [
    'version', 'revision', 'generation', 'coreImageId', 'billingImageId',
    'coreDumpSha256', 'coreDumpSizeBytes', 'billingDumpSha256',
    'billingDumpSizeBytes',
  ]) || manifest.version !== 2 ||
  manifest.revision !== process.env.EXPECTED_REVISION ||
  String(manifest.generation) !== process.env.EXPECTED_GENERATION ||
  manifest.coreImageId !== process.env.EXPECTED_CORE_IMAGE_ID ||
  manifest.billingImageId !== process.env.EXPECTED_BILLING_IMAGE_ID ||
  manifest.coreDumpSha256 !== process.env.EXPECTED_CORE_SHA ||
  String(manifest.coreDumpSizeBytes) !== process.env.EXPECTED_CORE_SIZE ||
  manifest.billingDumpSha256 !== process.env.EXPECTED_BILLING_PRE_SHA ||
  String(manifest.billingDumpSizeBytes) !== process.env.EXPECTED_BILLING_PRE_SIZE ||
  !sha(snapshot.sourceFingerprint) ||
  !exact(snapshot.coreState, Object.keys(snapshot.coreState || {})) ||
  snapshot.coreState.ownership !== 'CORE'
) process.exit(1);
if (process.env.EXPECTED_PHASE === 'pre-cutover') {
  const checks = [...commonChecks, 'coreBillingParity'];
  if (
    !exact(value.dumps, ['corePre', 'billingPre']) ||
    !dump(value.dumps.corePre) || !dump(value.dumps.billingPre) ||
    value.dumps.corePre.sha256 !== process.env.EXPECTED_CORE_SHA ||
    String(value.dumps.corePre.sizeBytes) !== process.env.EXPECTED_CORE_SIZE ||
    value.dumps.billingPre.sha256 !== process.env.EXPECTED_BILLING_PRE_SHA ||
    String(value.dumps.billingPre.sizeBytes) !== process.env.EXPECTED_BILLING_PRE_SIZE ||
    !exact(value.restores, ['corePre', 'billingPre']) ||
    !restore(value.restores.corePre) || !restore(value.restores.billingPre) ||
    !exact(value.anchors, [
      'billingDatabaseId', 'sourceFingerprint', 'coreOwnership',
      'billingOwnership', 'billingDatabasePhase',
      'coreRestoreSystemIdentifier', 'billingPreRestoreSystemIdentifier',
    ]) || value.anchors.billingDatabaseId !== process.env.EXPECTED_DATABASE_ID ||
    value.anchors.sourceFingerprint !== snapshot.sourceFingerprint ||
    value.anchors.coreOwnership !== 'CORE' ||
    value.anchors.billingOwnership !== 'PREPARED' ||
    value.anchors.billingDatabasePhase !== 'IMPORTED' ||
    String(value.anchors.coreRestoreSystemIdentifier) !==
      String(value.restores.corePre.systemIdentifier) ||
    String(value.anchors.billingPreRestoreSystemIdentifier) !==
      String(value.restores.billingPre.systemIdentifier) ||
    new Set([
      String(value.restores.corePre.systemIdentifier),
      String(value.restores.billingPre.systemIdentifier),
      process.env.EXPECTED_DATABASE_SYSTEM_ID,
    ]).size !== 3 || !allTrue(value.checks, checks)
  ) process.exit(1);
} else {
  const checks = [...commonChecks, 'preEvidenceBinding', 'prePostContinuity'];
  if (
    !previous || previous.phase !== 'pre-cutover' ||
    previous.revision !== process.env.EXPECTED_REVISION ||
    String(previous.generation) !== process.env.EXPECTED_GENERATION ||
    previous.dumps?.billingPre?.sha256 !== process.env.EXPECTED_BILLING_PRE_SHA ||
    previous.images?.core?.imageId !== process.env.EXPECTED_CORE_IMAGE_ID ||
    previous.images?.billing?.imageId !== process.env.EXPECTED_BILLING_IMAGE_ID ||
    previous.anchors?.sourceFingerprint !== snapshot.sourceFingerprint ||
    value.preEvidenceSha256 !== crypto.createHash('sha256')
      .update(fs.readFileSync(process.env.PREVIOUS_EVIDENCE_FILE)).digest('hex') ||
    !exact(value.dumps, ['billingPre', 'billingPost']) ||
    !dump(value.dumps.billingPre) || !dump(value.dumps.billingPost) ||
    value.dumps.billingPre.sha256 !== process.env.EXPECTED_BILLING_PRE_SHA ||
    String(value.dumps.billingPre.sizeBytes) !== process.env.EXPECTED_BILLING_PRE_SIZE ||
    value.dumps.billingPost.sha256 !== process.env.EXPECTED_BILLING_POST_SHA ||
    String(value.dumps.billingPost.sizeBytes) !== process.env.EXPECTED_BILLING_POST_SIZE ||
    !exact(value.restores, ['billingPre', 'billingPost']) ||
    !restore(value.restores.billingPre) || !restore(value.restores.billingPost) ||
    !exact(value.anchors, [
      'billingDatabaseId', 'sourceFingerprint', 'billingPreOwnership',
      'billingPostOwnership', 'billingPreDatabasePhase',
      'billingPostDatabasePhase', 'billingPreRestoreSystemIdentifier',
      'billingPostRestoreSystemIdentifier',
    ]) || value.anchors.billingDatabaseId !== process.env.EXPECTED_DATABASE_ID ||
    value.anchors.sourceFingerprint !== snapshot.sourceFingerprint ||
    value.anchors.billingPreOwnership !== 'PREPARED' ||
    value.anchors.billingPostOwnership !== 'ACTIVE' ||
    value.anchors.billingPreDatabasePhase !== 'IMPORTED' ||
    value.anchors.billingPostDatabasePhase !== 'ACTIVE' ||
    String(value.anchors.billingPreRestoreSystemIdentifier) !==
      String(value.restores.billingPre.systemIdentifier) ||
    String(value.anchors.billingPostRestoreSystemIdentifier) !==
      String(value.restores.billingPost.systemIdentifier) ||
    new Set([
      String(value.restores.billingPre.systemIdentifier),
      String(value.restores.billingPost.systemIdentifier),
      String(previous.restores?.corePre?.systemIdentifier),
      String(previous.restores?.billingPre?.systemIdentifier),
      process.env.EXPECTED_DATABASE_SYSTEM_ID,
    ]).size !== 5 || !allTrue(value.checks, checks)
  ) process.exit(1);
}
NODE
}

billing_cutover_offsite_reference_is_safe() {
	[[ $# -eq 2 ]] || return 1
	local provider="$1" reference="$2"
	case "$provider" in
	operator-managed-macos)
		[[ "$reference" =~ ^macos-offsite:[A-Za-z0-9][A-Za-z0-9._:@+-]{7,239}$ ]]
		;;
	s3-compatible)
		[[ "$reference" =~ ^s3-offsite:[A-Za-z0-9][A-Za-z0-9._:/@+-]{7,239}$ ]]
		;;
	telegram-document)
		[[ "$reference" =~ ^telegram-document:[A-Za-z0-9][A-Za-z0-9._:@+-]{7,239}$ ]]
		;;
	*) return 1 ;;
	esac
}

billing_cutover_validate_offsite_receipt() {
	[[ $# -eq 2 ]] || return 1
	local receipt="$1" kind="$2" expected_names metadata provider reference
	local sha256 size_bytes name artifact actual_sha actual_size
	[[ "$kind" =~ ^(pre-cutover|post-ownership)$ ]] || return 1
	billing_cutover_validate_evidence_file "$receipt" || return 1
	if [[ "$kind" == 'pre-cutover' ]]; then
		expected_names="$(basename "$billing_core_backup"),$(basename "$billing_service_backup"),$(basename "$billing_pre_backup_manifest"),$(basename "$billing_pre_restore_evidence")"
	else
		expected_names="$(basename "$billing_post_backup"),$(basename "$billing_post_restore_evidence")"
	fi
	metadata="$(
		RECEIPT_FILE="$receipt" EXPECTED_KIND="$kind" \
			EXPECTED_REVISION="$EXPECTED_REVISION" \
			EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
			EXPECTED_NAMES="$expected_names" node <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, 'utf8')); }
catch { process.exit(1); }
const exact = (object, keys) => object && typeof object === 'object' &&
  !Array.isArray(object) && Object.keys(object).sort().join('|') === [...keys].sort().join('|');
if (!exact(value, ['version', 'status', 'kind', 'revision', 'generation',
    'provider', 'providerReference', 'artifacts', 'verifiedAt']) ||
    value.version !== 1 || value.status !== 'verified' ||
    value.kind !== process.env.EXPECTED_KIND ||
    value.revision !== process.env.EXPECTED_REVISION ||
    String(value.generation) !== process.env.EXPECTED_GENERATION ||
    typeof value.provider !== 'string' || typeof value.providerReference !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt || '') ||
    !Array.isArray(value.artifacts)) process.exit(1);
const expectedNames = process.env.EXPECTED_NAMES.split(',').sort();
const names = value.artifacts.map(item => item?.name).sort();
if (names.join('|') !== expectedNames.join('|')) process.exit(1);
for (const item of value.artifacts) {
  if (!exact(item, ['name', 'sha256', 'sizeBytes']) ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) process.exit(1);
}
process.stdout.write(`${value.provider}\t${value.providerReference}\n`);
for (const item of [...value.artifacts].sort((a, b) => a.name.localeCompare(b.name)))
  process.stdout.write(`${item.sha256}\t${item.sizeBytes}\t${item.name}\n`);
NODE
	)" || return 1
	IFS=$'\t' read -r provider reference <<<"$(printf '%s\n' "$metadata" | head -n 1)"
	billing_cutover_offsite_reference_is_safe "$provider" "$reference" || return 1
	while IFS=$'\t' read -r sha256 size_bytes name; do
		case "$name" in
		"$(basename "$billing_core_backup")") artifact="$billing_core_backup" ;;
		"$(basename "$billing_service_backup")") artifact="$billing_service_backup" ;;
		"$(basename "$billing_pre_backup_manifest")") artifact="$billing_pre_backup_manifest" ;;
		"$(basename "$billing_pre_restore_evidence")") artifact="$billing_pre_restore_evidence" ;;
		"$(basename "$billing_post_backup")") artifact="$billing_post_backup" ;;
		"$(basename "$billing_post_restore_evidence")") artifact="$billing_post_restore_evidence" ;;
		*) return 1 ;;
		esac
		billing_cutover_validate_evidence_file "$artifact" || return 1
		actual_sha="$(billing_cutover_sha256 "$artifact")"
		actual_size="$(wc -c <"$artifact" | tr -d '[:space:]')"
		[[ "$actual_sha" == "$sha256" && "$actual_size" == "$size_bytes" ]] ||
			return 1
	done < <(printf '%s\n' "$metadata" | tail -n +2)
}

billing_cutover_import_offsite_receipt() {
	[[ $# -eq 1 ]] || return 1
	local kind="$1" generation source destination source_sha partial
	generation="$(billing_cutover_marker_value generation)" || return 1
	case "$kind" in
	pre-cutover)
		source="/root/winwidget-billing-pre-offsite-${EXPECTED_REVISION}-g${generation}.json"
		destination="$billing_pre_offsite_receipt"
		;;
	post-ownership)
		source="/root/winwidget-billing-post-offsite-${EXPECTED_REVISION}-g${generation}.json"
		destination="$billing_post_offsite_receipt"
		;;
	*) return 1 ;;
	esac
	billing_cutover_validate_offsite_receipt "$source" "$kind" || return 1
	source_sha="$(billing_cutover_sha256 "$source")" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		billing_cutover_validate_offsite_receipt "$destination" "$kind" || return 1
		[[ "$(billing_cutover_sha256 "$destination")" == "$source_sha" ]] || return 1
	else
		partial="$destination.partial"
		billing_cutover_promote_import_partial \
			"$source" "$partial" "$destination" || return 1
	fi
	billing_cutover_validate_offsite_receipt "$destination" "$kind" || return 1
	printf '%s' "$source_sha"
}

billing_cutover_import_actual_restore_evidence() {
	[[ $# -eq 1 ]] || return 1
	local phase="$1" generation source destination source_sha partial
	generation="$(billing_cutover_marker_value generation)" || return 1
	case "$phase" in
	pre-cutover)
		source="/root/winwidget-billing-pre-restore-${EXPECTED_REVISION}-g${generation}.json"
		destination="$billing_pre_restore_evidence"
		;;
	post-ownership)
		source="/root/winwidget-billing-post-restore-${EXPECTED_REVISION}-g${generation}.json"
		destination="$billing_post_restore_evidence"
		;;
	*) return 1 ;;
	esac
	billing_cutover_validate_actual_restore_evidence "$source" "$phase" || return 1
	source_sha="$(billing_cutover_sha256 "$source")" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		billing_cutover_validate_actual_restore_evidence \
			"$destination" "$phase" || return 1
		[[ "$(billing_cutover_sha256 "$destination")" == "$source_sha" ]] ||
			return 1
	else
		partial="$destination.partial"
		billing_cutover_promote_import_partial \
			"$source" "$partial" "$destination" || return 1
	fi
	billing_cutover_validate_actual_restore_evidence \
		"$destination" "$phase" || return 1
	printf '%s' "$source_sha"
}

billing_cutover_require_actual_restore_gate() {
	[[ $# -eq 1 ]] || return 1
	local phase="$1" restore_sha receipt_sha
	case "$phase" in
	pre-cutover)
		[[ "$(billing_database_current_phase)" == 'pre-backups-created' &&
			"$(billing_database_marker_value pre_restore_evidence_sha256)" == \
			'pending' &&
			"$(billing_database_marker_value pre_offsite_receipt_sha256)" == \
			'pending' ]] || return 1
		restore_sha="$(billing_cutover_import_actual_restore_evidence "$phase")" ||
			return 1
		receipt_sha="$(billing_cutover_import_offsite_receipt "$phase")" ||
			return 1
		billing_cutover_next_pre_restore_sha="$restore_sha"
		billing_cutover_next_pre_receipt_sha="$receipt_sha"
		;;
	post-ownership)
		[[ "$(billing_database_current_phase)" == 'post-backup-created' &&
			"$(billing_database_marker_value post_restore_evidence_sha256)" == \
			'pending' &&
			"$(billing_database_marker_value post_offsite_receipt_sha256)" == \
			'pending' ]] || return 1
		restore_sha="$(billing_cutover_import_actual_restore_evidence "$phase")" ||
			return 1
		receipt_sha="$(billing_cutover_import_offsite_receipt "$phase")" ||
			return 1
		billing_cutover_next_post_restore_sha="$restore_sha"
		billing_cutover_next_post_receipt_sha="$receipt_sha"
		;;
	*) return 1 ;;
	esac
	printf 'billing_restore_gate_phase=%s\n' "$phase"
	printf 'billing_restore_evidence_sha256=%s\n' "$restore_sha"
	printf 'billing_offsite_receipt_sha256=%s\n' "$receipt_sha"
}

billing_cutover_capture_error_contract() {
	[[ $# -eq 2 ]] || return 1
	local base_url="$1" destination="$2" temporary="$2.$$"
	BASE_URL="$base_url" node - "$temporary" <<'NODE'
const fs = require('node:fs');
const destination = process.argv[2];
const checks = [
  ['GET', '/api/v1/payments/pending', 'auth'],
  ['GET', '/api/v1/subscriptions/me', 'auth'],
  ['GET', '/api/v1/tariff-prices', 'public'],
  ['GET', '/api/v1/affiliate/public-settings', 'public'],
];
void (async () => {
  const result = [];
  for (const [method, path, kind] of checks) {
    const response = await fetch(`${process.env.BASE_URL}${path}`, {
      method,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const contentType = String(response.headers.get('content-type') || '').split(';')[0];
    const item = { method, path, kind, status: response.status, contentType };
    if (kind === 'auth') {
      const body = await response.json();
      item.error = {
        statusCode: body.statusCode,
        message: body.message,
        error: body.error,
      };
    } else {
      await response.arrayBuffer();
    }
    result.push(item);
  }
  fs.writeFileSync(destination, `${JSON.stringify({ version: 1, checks: result })}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
})().catch(() => process.exit(1));
NODE
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$destination"
	billing_cutover_validate_evidence_file "$destination"
}

billing_cutover_compare_error_contracts() {
	[[ $# -eq 2 ]] || return 1
	node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const left = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const right = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (JSON.stringify(left) !== JSON.stringify(right)) process.exit(1);
NODE
}

billing_cutover_routes_file_is_legacy() {
	[[ $# -eq 1 ]] || return 1
	local routes
	routes="$(billing_read_env_value "$1" GATEWAY_ROUTES_JSON)" || return 1
	printf '%s\n' "$routes" | node -e '
const fs = require("node:fs");
const routes = JSON.parse(fs.readFileSync(0, "utf8"));
const prefixes = ["/api/v1/payments", "/api/v1/subscriptions", "/api/v1/tariff-prices", "/api/v1/affiliate"];
if (!Array.isArray(routes) || prefixes.some(prefix => routes.some(route => route.pathPrefix === prefix))) process.exit(1);
if (!routes.some(route => route.pathPrefix === "/api/v1" && route.upstreamUrl === "http://127.0.0.1:4200")) process.exit(1);
'
}

billing_cutover_routes_file_is_desired() {
	[[ $# -eq 1 ]] || return 1
	local routes
	routes="$(billing_read_env_value "$1" GATEWAY_ROUTES_JSON)" || return 1
	printf '%s\n' "$routes" | node -e '
const fs = require("node:fs");
const routes = JSON.parse(fs.readFileSync(0, "utf8"));
const expected = [
  ["/api/v1/payments", "billing-payments"],
  ["/api/v1/subscriptions", "billing-subscriptions"],
  ["/api/v1/tariff-prices", "billing-tariff-prices"],
  ["/api/v1/affiliate", "billing-affiliate"],
];
if (!Array.isArray(routes)) process.exit(1);
for (const [pathPrefix, id] of expected) {
  const matches = routes.filter(route => route?.pathPrefix === pathPrefix);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify({
    id,
    pathPrefix,
    upstreamUrl: "http://127.0.0.1:4800",
    authPolicy: "optional",
    timeoutMs: 30000,
  })) process.exit(1);
}
if (!routes.some(route => route?.pathPrefix === "/api/v1" &&
    route.upstreamUrl === "http://127.0.0.1:4200")) process.exit(1);
if (routes.some(route => route?.pathPrefix === "/api/v1/site-settings" &&
    route.upstreamUrl === "http://127.0.0.1:4800")) process.exit(1);
'
}

billing_cutover_capture_legacy_route_env() {
	local temporary="$billing_route_env_legacy_snapshot.$$"
	if [[ -e "$billing_route_env_legacy_snapshot" ||
		-L "$billing_route_env_legacy_snapshot" ]]; then
		billing_cutover_validate_evidence_file \
			"$billing_route_env_legacy_snapshot" || return 1
		billing_cutover_routes_file_is_legacy \
			"$billing_route_env_legacy_snapshot" || return 1
		if billing_cutover_routes_file_is_legacy "$ENV_FILE"; then
			[[ "$(billing_cutover_sha256 "$ENV_FILE")" == \
				"$(billing_cutover_sha256 "$billing_route_env_legacy_snapshot")" ]] ||
				billing_cutover_fail \
					'Production legacy env differs from the immutable Billing route snapshot.' ||
				return 1
		fi
		return 0
	fi
	billing_cutover_routes_file_is_legacy "$ENV_FILE" ||
		billing_cutover_fail \
			'Billing legacy route snapshot can only be created from legacy routes.' ||
		return 1
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	(umask 077; cp -- "$ENV_FILE" "$temporary")
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -- "$temporary" "$billing_route_env_legacy_snapshot"
	billing_cutover_validate_evidence_file "$billing_route_env_legacy_snapshot"
}

billing_cutover_write_route_manifest() {
	local temporary_env="$billing_artifact_root/.backend-env-with-billing-routes.partial"
	local temporary_manifest="$billing_artifact_root/.gateway-routes-billing.partial"
	local temporary
	for temporary in "$temporary_env" "$temporary_manifest"; do
		if [[ -e "$temporary" || -L "$temporary" ]]; then
			billing_cutover_validate_partial_file "$temporary" ||
				billing_cutover_fail 'Unsafe partial Billing route artifact.' ||
				return 1
			rm -f -- "$temporary"
		fi
	done
	billing_cutover_validate_evidence_file \
		"$billing_route_env_legacy_snapshot" || return 1
	billing_cutover_routes_file_is_legacy \
		"$billing_route_env_legacy_snapshot" || return 1
	node - "$billing_route_env_legacy_snapshot" "$temporary_env" \
		"$temporary_manifest" <<'NODE'
const fs = require('node:fs');
const [source, destination, manifestPath] = process.argv.slice(2);
const raw = fs.readFileSync(source, 'utf8');
const lines = raw.split('\n');
const indexes = [];
for (let index = 0; index < lines.length; index += 1) {
  if (lines[index].startsWith('GATEWAY_ROUTES_JSON=')) indexes.push(index);
}
if (indexes.length !== 1) process.exit(1);
const index = indexes[0];
const current = JSON.parse(lines[index].slice('GATEWAY_ROUTES_JSON='.length));
if (!Array.isArray(current)) process.exit(1);
const prefixes = [
  ['/api/v1/payments', 'billing-payments'],
  ['/api/v1/subscriptions', 'billing-subscriptions'],
  ['/api/v1/tariff-prices', 'billing-tariff-prices'],
  ['/api/v1/affiliate', 'billing-affiliate'],
];
const desired = prefixes.map(([pathPrefix, id]) => ({
  id,
  pathPrefix,
  upstreamUrl: 'http://127.0.0.1:4800',
  authPolicy: 'optional',
  timeoutMs: 30000,
}));
for (const route of current) {
  if (!route || typeof route !== 'object') process.exit(1);
  const match = desired.find(candidate => candidate.pathPrefix === route.pathPrefix);
  if (match && JSON.stringify(route) !== JSON.stringify(match)) process.exit(1);
}
const retained = current.filter(route => !prefixes.some(([prefix]) => route.pathPrefix === prefix));
if (!retained.some(route => route.pathPrefix === '/api/v1' && route.upstreamUrl === 'http://127.0.0.1:4200')) process.exit(1);
const next = [...desired, ...retained];
lines[index] = `GATEWAY_ROUTES_JSON=${JSON.stringify(next)}`;
fs.writeFileSync(destination, lines.join('\n'), { mode: 0o600, flag: 'wx' });
fs.writeFileSync(manifestPath, `${JSON.stringify(desired)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chown 0:0 "$temporary_env" "$temporary_manifest"
	chmod 600 "$temporary_env" "$temporary_manifest"
	if [[ -e "$billing_route_manifest" || -L "$billing_route_manifest" ]]; then
		billing_cutover_validate_evidence_file "$billing_route_manifest" &&
			[[ "$(billing_cutover_sha256 "$billing_route_manifest")" == \
				"$(billing_cutover_sha256 "$temporary_manifest")" ]] || {
				rm -f -- "$temporary_env" "$temporary_manifest"
				billing_cutover_fail \
					'Existing Billing route manifest differs from the immutable legacy snapshot.'
				return 1
			}
		rm -f -- "$temporary_manifest"
	else
		mv -- "$temporary_manifest" "$billing_route_manifest"
	fi
	if [[ -e "$billing_route_env_candidate" ||
		-L "$billing_route_env_candidate" ]]; then
		billing_cutover_validate_evidence_file "$billing_route_env_candidate" &&
			[[ "$(billing_cutover_sha256 "$billing_route_env_candidate")" == \
				"$(billing_cutover_sha256 "$temporary_env")" ]] || {
				rm -f -- "$temporary_env"
				billing_cutover_fail \
					'Existing Billing route env candidate differs from the immutable legacy snapshot.'
				return 1
			}
		rm -f -- "$temporary_env"
	else
		mv -- "$temporary_env" "$billing_route_env_candidate"
	fi
	[[ "$(stat -c '%u:%g:%a' "$billing_route_env_candidate")" == \
		'0:0:600' ]] || return 1
	billing_cutover_validate_evidence_file "$billing_route_manifest"
	billing_compose_config_all_profiles "$EXPECTED_REVISION" \
		"$billing_route_env_candidate" "$COMPOSE_FILE"
	printf 'billing_route_env_candidate_sha256=%s\n' \
		"$(billing_cutover_sha256 "$billing_route_env_candidate")"
}

billing_cutover_validate_route_artifacts() {
	billing_cutover_validate_evidence_file \
		"$billing_route_env_legacy_snapshot" || return 1
	billing_cutover_validate_evidence_file "$billing_route_env_candidate" || return 1
	billing_cutover_validate_evidence_file "$billing_route_manifest" || return 1
	billing_cutover_routes_file_is_legacy \
		"$billing_route_env_legacy_snapshot" || return 1
	billing_cutover_routes_file_is_desired "$billing_route_env_candidate" || return 1
	node - "$billing_route_env_legacy_snapshot" "$billing_route_env_candidate" \
		"$billing_route_manifest" <<'NODE'
const fs = require('node:fs');
const [legacyPath, candidatePath, manifestPath] = process.argv.slice(2);
const legacyLines = fs.readFileSync(legacyPath, 'utf8').split('\n');
const candidateLines = fs.readFileSync(candidatePath, 'utf8').split('\n');
if (legacyLines.length !== candidateLines.length) process.exit(1);
const indexes = lines => lines.flatMap((line, index) =>
  line.startsWith('GATEWAY_ROUTES_JSON=') ? [index] : []);
const legacyIndexes = indexes(legacyLines);
const candidateIndexes = indexes(candidateLines);
if (legacyIndexes.length !== 1 || candidateIndexes.length !== 1 ||
    legacyIndexes[0] !== candidateIndexes[0]) process.exit(1);
const routeIndex = legacyIndexes[0];
for (let index = 0; index < legacyLines.length; index += 1) {
  if (index !== routeIndex && legacyLines[index] !== candidateLines[index]) process.exit(1);
}
const legacy = JSON.parse(legacyLines[routeIndex].slice('GATEWAY_ROUTES_JSON='.length));
const candidate = JSON.parse(candidateLines[routeIndex].slice('GATEWAY_ROUTES_JSON='.length));
const prefixes = [
  ['/api/v1/payments', 'billing-payments'],
  ['/api/v1/subscriptions', 'billing-subscriptions'],
  ['/api/v1/tariff-prices', 'billing-tariff-prices'],
  ['/api/v1/affiliate', 'billing-affiliate'],
];
const desired = prefixes.map(([pathPrefix, id]) => ({
  id, pathPrefix, upstreamUrl: 'http://127.0.0.1:4800',
  authPolicy: 'optional', timeoutMs: 30000,
}));
const retained = legacy.filter(route =>
  !prefixes.some(([prefix]) => route?.pathPrefix === prefix));
if (JSON.stringify(candidate) !== JSON.stringify([...desired, ...retained])) process.exit(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (JSON.stringify(manifest) !== JSON.stringify(desired)) process.exit(1);
NODE
	billing_compose_config_all_profiles "$EXPECTED_REVISION" \
		"$billing_route_env_candidate" "$COMPOSE_FILE"
}

billing_cutover_prepare_route_artifacts() {
	billing_cutover_capture_legacy_route_env || return 1
	if [[ ! -e "$billing_route_env_candidate" ||
		-L "$billing_route_env_candidate" ||
		! -e "$billing_route_manifest" || -L "$billing_route_manifest" ]]; then
		billing_cutover_write_route_manifest || return 1
	fi
	billing_cutover_validate_route_artifacts
}

billing_cutover_routes_are_legacy() {
	billing_cutover_routes_file_is_legacy "$ENV_FILE"
}

billing_cutover_routes_are_desired() {
	billing_cutover_routes_file_is_desired "$ENV_FILE"
}

billing_cutover_gateway_routes_are_legacy() {
	local container_id
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q api-gateway)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	docker inspect "$container_id" | node -e '
const fs = require("node:fs");
const documents = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(documents) || documents.length !== 1) process.exit(1);
const entry = documents[0].Config.Env.find(value =>
  value.startsWith("GATEWAY_ROUTES_JSON="));
if (!entry) process.exit(1);
const routes = JSON.parse(entry.slice("GATEWAY_ROUTES_JSON=".length));
const prefixes = [
  "/api/v1/payments",
  "/api/v1/subscriptions",
  "/api/v1/tariff-prices",
  "/api/v1/affiliate",
];
if (!Array.isArray(routes) ||
    prefixes.some(prefix => routes.some(route => route?.pathPrefix === prefix)) ||
    !routes.some(route => route?.pathPrefix === "/api/v1" &&
      route.upstreamUrl === "http://127.0.0.1:4200")) process.exit(1);
'
}

billing_cutover_gateway_routes_are_desired() {
	local container_id
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q api-gateway)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	docker inspect "$container_id" | node -e '
const fs = require("node:fs");
const documents = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(documents) || documents.length !== 1) process.exit(1);
const entries = documents[0].Config.Env.filter(value =>
  value.startsWith("GATEWAY_ROUTES_JSON="));
if (entries.length !== 1) process.exit(1);
const routes = JSON.parse(entries[0].slice("GATEWAY_ROUTES_JSON=".length));
const expected = [
  ["/api/v1/payments", "billing-payments"],
  ["/api/v1/subscriptions", "billing-subscriptions"],
  ["/api/v1/tariff-prices", "billing-tariff-prices"],
  ["/api/v1/affiliate", "billing-affiliate"],
];
if (!Array.isArray(routes)) process.exit(1);
for (const [pathPrefix, id] of expected) {
  const matches = routes.filter(route => route?.pathPrefix === pathPrefix);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify({
    id,
    pathPrefix,
    upstreamUrl: "http://127.0.0.1:4800",
    authPolicy: "optional",
    timeoutMs: 30000,
  })) process.exit(1);
}
if (!routes.some(route => route?.pathPrefix === "/api/v1" &&
    route.upstreamUrl === "http://127.0.0.1:4200")) process.exit(1);
if (routes.some(route => route?.pathPrefix === "/api/v1/site-settings" &&
    route.upstreamUrl === "http://127.0.0.1:4800")) process.exit(1);
'
}

billing_cutover_validate_route_env_sync_evidence() {
	billing_cutover_validate_route_artifacts || return 1
	billing_cutover_validate_evidence_file "$billing_route_env_sync_evidence" || return 1
	local candidate_sha legacy_sha manifest_sha
	candidate_sha="$(billing_cutover_sha256 "$billing_route_env_candidate")"
	legacy_sha="$(billing_cutover_sha256 "$billing_route_env_legacy_snapshot")"
	manifest_sha="$(billing_cutover_sha256 "$billing_route_manifest")"
	EXPECTED_REVISION="$EXPECTED_REVISION" \
	EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
	EXPECTED_LEGACY_SHA="$legacy_sha" EXPECTED_ENV_SHA="$candidate_sha" \
	EXPECTED_MANIFEST_SHA="$manifest_sha" \
		node - "$billing_route_env_sync_evidence" <<'NODE'
const fs = require('node:fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hex = value => /^[0-9a-f]{64}$/.test(value || '');
if (
  evidence.schemaVersion !== 1 || evidence.action !== 'billing-route-env-sync' ||
  evidence.status !== 'passed' ||
  evidence.revision !== process.env.EXPECTED_REVISION ||
  String(evidence.generation) !== process.env.EXPECTED_GENERATION ||
  !hex(evidence.localSourceSha256) ||
  evidence.localSourceSha256 !== process.env.EXPECTED_LEGACY_SHA ||
  evidence.serverSourceSha256 !== process.env.EXPECTED_LEGACY_SHA ||
  evidence.localCandidateSha256 !== process.env.EXPECTED_ENV_SHA ||
  evidence.uploadedServerSha256 !== process.env.EXPECTED_ENV_SHA ||
  evidence.roundTripLocalSha256 !== process.env.EXPECTED_ENV_SHA ||
  evidence.routeManifestSha256 !== process.env.EXPECTED_MANIFEST_SHA ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(evidence.observedAt || '')
) process.exit(1);
NODE
}

billing_cutover_validate_route_env_sync() {
	billing_cutover_validate_route_env_sync_evidence || return 1
	billing_cutover_routes_are_desired || return 1
	[[ "$(billing_cutover_sha256 "$ENV_FILE")" == \
		"$(billing_cutover_sha256 "$billing_route_env_candidate")" ]] ||
		billing_cutover_fail \
			'Production Billing route env differs from the staged full-file candidate.' ||
		return 1
	billing_compose_config_all_profiles "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE"
}

billing_cutover_validate_route_env_rollback_sync() {
	[[ $# -eq 1 && "$1" =~ ^(recorded|unrecorded)$ ]] || return 1
	local sync_state="$1"
	if [[ "$sync_state" == 'recorded' ]]; then
		billing_cutover_validate_route_env_sync_evidence || return 1
	else
		[[ ! -e "$billing_route_env_sync_evidence" &&
			! -L "$billing_route_env_sync_evidence" ]] || return 1
	fi
	billing_cutover_validate_evidence_file \
		"$billing_route_env_rollback_evidence" || return 1
	billing_cutover_routes_are_legacy || return 1
	local candidate_sha current_sha legacy_sha
	candidate_sha="$(billing_cutover_sha256 "$billing_route_env_candidate")"
	legacy_sha="$(billing_cutover_sha256 "$billing_route_env_legacy_snapshot")"
	current_sha="$(billing_cutover_sha256 "$ENV_FILE")"
	[[ "$current_sha" == "$legacy_sha" ]] || return 1
	EXPECTED_REVISION="$EXPECTED_REVISION" \
	EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
	EXPECTED_CANDIDATE_SHA="$candidate_sha" EXPECTED_LEGACY_SHA="$legacy_sha" \
		node - "$billing_route_env_rollback_evidence" <<'NODE'
const fs = require('node:fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const exact = [
  'schemaVersion', 'action', 'status', 'revision', 'generation',
  'desiredCandidateSha256', 'localSourceSha256', 'serverSourceSha256',
  'legacyEnvSha256', 'uploadedServerSha256', 'roundTripLocalSha256',
  'observedAt',
].sort();
const hex = value => /^[0-9a-f]{64}$/.test(value || '');
const allowedSource = value =>
  [process.env.EXPECTED_CANDIDATE_SHA, process.env.EXPECTED_LEGACY_SHA].includes(value);
if (
  !evidence || Array.isArray(evidence) ||
  Object.keys(evidence).sort().join('|') !== exact.join('|') ||
  evidence.schemaVersion !== 1 ||
  evidence.action !== 'billing-route-env-rollback-sync' ||
  evidence.status !== 'passed' ||
  evidence.revision !== process.env.EXPECTED_REVISION ||
  String(evidence.generation) !== process.env.EXPECTED_GENERATION ||
  !hex(evidence.desiredCandidateSha256) ||
  evidence.desiredCandidateSha256 !== process.env.EXPECTED_CANDIDATE_SHA ||
  !allowedSource(evidence.localSourceSha256) ||
  !allowedSource(evidence.serverSourceSha256) ||
  evidence.legacyEnvSha256 !== process.env.EXPECTED_LEGACY_SHA ||
  evidence.uploadedServerSha256 !== process.env.EXPECTED_LEGACY_SHA ||
  evidence.roundTripLocalSha256 !== process.env.EXPECTED_LEGACY_SHA ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(evidence.observedAt || '')
) process.exit(1);
NODE
	billing_compose_config_all_profiles "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE"
}

billing_cutover_require_abort_route_state() {
	[[ $# -eq 1 ]] || return 1
	local phase="$1"
	billing_cutover_gateway_routes_are_legacy ||
		billing_cutover_fail \
			'Billing abort requires the running Gateway to remain on legacy routes.' ||
		return 1
	billing_cutover_validate_route_artifacts || return 1
	if ! billing_cutover_routes_are_legacy ||
		[[ "$(billing_cutover_sha256 "$ENV_FILE")" != \
			"$(billing_cutover_sha256 "$billing_route_env_legacy_snapshot")" ]]; then
		printf 'billing_route_env_rollback_snapshot=%s\n' \
			"$billing_route_env_legacy_snapshot"
		printf 'billing_route_env_rollback_evidence=%s\n' \
			"$billing_route_env_rollback_evidence"
		billing_cutover_fail \
			'Billing abort requires a verified two-copy rollback to the legacy env snapshot.'
		return 1
	fi
	if [[ ! -e "$billing_route_env_sync_evidence" &&
		! -L "$billing_route_env_sync_evidence" ]]; then
		[[ "$phase" =~ ^(prepared|aborted)$ ]] ||
			billing_cutover_fail \
				'Billing forward route sync evidence is missing outside prepared phase.' ||
			return 1
		billing_cutover_validate_route_env_rollback_sync unrecorded ||
			billing_cutover_fail \
				'Billing no-op two-copy legacy env receipt is missing or invalid.'
		return
	fi
	billing_cutover_validate_route_env_rollback_sync recorded ||
		billing_cutover_fail \
			'Billing route rollback sync evidence is missing or invalid.'
}

billing_cutover_wait_gateway() {
	local attempt container_id health
	for attempt in {1..60}; do
		container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
			"$COMPOSE_FILE" ps --status running -q api-gateway 2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			health="$(docker inspect --format \
				'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
				"$container_id" 2>/dev/null || true)"
			[[ "$health" != 'healthy' ]] || return 0
		fi
		sleep 2
	done
	billing_cutover_fail 'Gateway did not become healthy after the Billing route switch.'
}

billing_cutover_require_active_runtime() {
	local image_id redeliver
	image_id="$(billing_database_marker_value billing_image_id)" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	billing_database_require_pinned_candidate_images || return 1
	billing_deploy_verify_service billing-api api 4800 "$image_id" || return 1
	billing_deploy_verify_service billing-scheduler scheduler 4801 "$image_id" || return 1
	billing_deploy_verify_service billing-worker worker 4802 "$image_id" || return 1
	billing_deploy_verify_service \
		billing-outbox-publisher outbox-publisher 4803 "$image_id" || return 1
	billing_cutover_validate_route_env_sync || return 1
	[[ "$(billing_cutover_marker_value route_sha256)" == \
		"$(billing_cutover_sha256 "$billing_route_env_sync_evidence")" ]] ||
		billing_cutover_fail \
			'Durable Billing route evidence hash differs from the synced route receipt.' ||
		return 1
	billing_cutover_wait_gateway || return 1
	billing_cutover_gateway_routes_are_desired ||
		billing_cutover_fail \
			'Running Gateway does not expose the exact Billing route manifest.' ||
		return 1
	billing_cutover_validate_evidence_file "$billing_direct_error_contract" || return 1
	billing_cutover_capture_error_contract http://127.0.0.1:4100 \
		"$billing_gateway_error_contract"
	billing_cutover_compare_error_contracts "$billing_direct_error_contract" \
		"$billing_gateway_error_contract" ||
		billing_cutover_fail \
			'Gateway Billing error contract drifted during post-ownership recovery.' ||
		return 1
	billing_cutover_validate_evidence_file \
		"$billing_auto_renewal_billing_evidence" || return 1
	redeliver="$(billing_cutover_auto_renewal_redeliver \
		"$billing_auto_renewal_billing_evidence")" || return 1
	billing_cutover_wait_auto_renewal_ownership 1 \
		winwidget-billing-worker winwidget-billing-worker billing-owner \
		"$billing_auto_renewal_billing_evidence" "$redeliver"
}

billing_cutover_update_phase() {
	[[ $# -eq 4 ]] || return 1
	local phase="$1" snapshot_sha="$2" projection_sha="$3" route_sha="$4"
	local cleanup_revision generation database_id pre_backup_sha post_backup_sha
	local restore_evidence restore_sha core_image_id billing_image_id
	local pre_restore_sha pre_receipt_sha post_restore_sha post_receipt_sha
	cleanup_revision="$(billing_database_marker_value cleanup_revision)"
	generation="$(billing_cutover_marker_value generation)"
	database_id="$(billing_database_marker_value database_id)"
	core_image_id="$(billing_database_marker_value core_image_id)"
	billing_image_id="$(billing_database_marker_value billing_image_id)"
	pre_backup_sha="$(billing_database_marker_value pre_backup_sha256)"
	post_backup_sha="$(billing_database_marker_value post_backup_sha256)"
	restore_sha="$(billing_database_marker_value restore_evidence_sha256)"
	pre_restore_sha="$(billing_database_marker_value pre_restore_evidence_sha256)"
	pre_receipt_sha="$(billing_database_marker_value pre_offsite_receipt_sha256)"
	post_restore_sha="$(billing_database_marker_value post_restore_evidence_sha256)"
	post_receipt_sha="$(billing_database_marker_value post_offsite_receipt_sha256)"
	if [[ "$phase" == 'prepared' ]]; then
		[[ "$billing_cutover_core_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$billing_cutover_billing_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
			return 1
		core_image_id="$billing_cutover_core_image_id"
		billing_image_id="$billing_cutover_billing_image_id"
		restore_evidence="$(billing_read_env_value "$ENV_FILE" \
			BILLING_RESTORE_DRILL_EVIDENCE_FILE)"
		restore_sha="$(billing_cutover_sha256 "$restore_evidence")"
	fi
	if [[ "$phase" == 'pre-backups-created' ]]; then
		billing_cutover_validate_evidence_file "$billing_pre_backup_manifest" || return 1
		pre_backup_sha="$(billing_cutover_sha256 "$billing_pre_backup_manifest")"
	fi
	if [[ "$phase" == 'post-backup-created' ]]; then
		billing_cutover_validate_evidence_file "$billing_post_backup" || return 1
		post_backup_sha="$(billing_cutover_sha256 "$billing_post_backup")"
	fi
	[[ -z "$billing_cutover_next_pre_restore_sha" ]] ||
		pre_restore_sha="$billing_cutover_next_pre_restore_sha"
	[[ -z "$billing_cutover_next_pre_receipt_sha" ]] ||
		pre_receipt_sha="$billing_cutover_next_pre_receipt_sha"
	[[ -z "$billing_cutover_next_post_restore_sha" ]] ||
		post_restore_sha="$billing_cutover_next_post_restore_sha"
	[[ -z "$billing_cutover_next_post_receipt_sha" ]] ||
		post_receipt_sha="$billing_cutover_next_post_receipt_sha"
	billing_database_transition_allowed \
		"$(billing_database_current_phase)" "$phase" ||
		billing_cutover_fail \
			"Invalid Billing lifecycle phase transition to $phase." || return 1
	billing_database_write_marker "$phase" "$EXPECTED_REVISION" \
		"$cleanup_revision" "$database_id" \
		"$(billing_database_marker_value database_system_identifier)" \
		"$(billing_database_marker_value database_volume)" \
		"$(billing_database_marker_value postgres_image_id)" \
		"$core_image_id" "$billing_image_id" "$generation" "$snapshot_sha" \
		"$pre_backup_sha" "$post_backup_sha" "$restore_sha" \
		"$pre_restore_sha" "$pre_receipt_sha" \
		"$post_restore_sha" "$post_receipt_sha" "$projection_sha" "$route_sha" \
		"$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	billing_cutover_write_marker "$phase" "$EXPECTED_REVISION" \
		"$cleanup_revision" "$generation" "$database_id" \
		"$core_image_id" "$billing_image_id" "$snapshot_sha" \
		"$projection_sha" "$route_sha" "$pre_restore_sha" "$pre_receipt_sha" \
		"$post_restore_sha" "$post_receipt_sha"
}

billing_cutover_initialize_marker() {
	local phase database_id marker_phase generation
	phase="$(billing_database_current_phase)" || return 1
	[[ "$phase" == 'prepared' ]] || return 1
	database_id="$(billing_database_marker_value database_id)"
	if [[ -e "$billing_cutover_marker" || -L "$billing_cutover_marker" ]]; then
		billing_cutover_validate_marker || return 1
		marker_phase="$(billing_cutover_marker_value phase)"
		case "$marker_phase" in
		aborted | prepared) ;;
		*) billing_cutover_fail \
			'Existing Billing cutover marker is not re-preparable.' || return 1 ;;
		esac
		[[ "$(billing_cutover_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
			billing_cutover_fail 'Existing Billing marker revision changed.' || return 1
		if [[ "$marker_phase" == 'prepared' ]]; then
			[[ "$(billing_cutover_marker_value database_id)" == "$database_id" ]] ||
				billing_cutover_fail 'Prepared Billing database identity changed.' ||
				return 1
		else
			[[ "$(billing_cutover_marker_value database_id)" != "$database_id" ]] ||
				billing_cutover_fail \
					'Aborted Billing reprepare did not create a clean database identity.' ||
				return 1
		fi
		generation="$(billing_cutover_marker_value generation)"
		if [[ "$marker_phase" == 'aborted' ]]; then
			billing_cutover_archive_aborted_generation "$generation"
			generation="$((generation + 1))"
		fi
		billing_cutover_write_marker prepared "$EXPECTED_REVISION" \
			"$(billing_cutover_marker_value cleanup_revision)" \
			"$generation" "$database_id" \
			"$billing_cutover_core_image_id" \
			"$billing_cutover_billing_image_id" \
			pending pending pending pending pending pending pending
	else
		billing_cutover_write_marker prepared "$EXPECTED_REVISION" pending 1 \
			"$database_id" "$billing_cutover_core_image_id" \
			"$billing_cutover_billing_image_id" \
			pending pending pending pending pending pending pending
	fi
	billing_cutover_update_phase prepared pending pending pending
}

billing_cutover_reconcile_marker() {
	local database_phase cutover_phase database_cleanup cutover_cleanup
	local cleanup_repair='false'
	database_phase="$(billing_database_current_phase)" || return 1
	[[ "$database_phase" != 'absent' ]] || return 1
	billing_cutover_validate_marker || return 1
	cutover_phase="$(billing_cutover_marker_value phase)" || return 1
	database_cleanup="$(billing_database_marker_value cleanup_revision)" || return 1
	cutover_cleanup="$(billing_cutover_marker_value cleanup_revision)" || return 1
	[[ "$(billing_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(billing_cutover_marker_value database_id)" == \
		"$(billing_database_marker_value database_id)" &&
		"$(billing_cutover_marker_value generation)" == \
		"$(billing_database_marker_value switch_generation)" &&
		"$(billing_cutover_marker_value core_image_id)" == \
		"$(billing_database_marker_value core_image_id)" &&
		"$(billing_cutover_marker_value billing_image_id)" == \
		"$(billing_database_marker_value billing_image_id)" ]] ||
		billing_cutover_fail 'Billing lifecycle and cutover marker identities differ.' ||
		return 1
	if [[ "$cutover_cleanup" == "$database_cleanup" ]]; then
		:
	elif [[ "$cutover_cleanup" == 'pending' &&
		"$database_cleanup" =~ ^[0-9a-f]{40}$ &&
		"$database_cleanup" != "$EXPECTED_REVISION" &&
		"$database_phase" == 'complete' && "$cutover_phase" == 'complete' ]]; then
		cleanup_repair='true'
	else
		billing_cutover_fail \
			'Billing cleanup revision differs between durable markers.' || return 1
	fi
	if [[ "$cutover_phase" == "$database_phase" ]]; then
		[[ "$(billing_cutover_marker_value route_sha256)" == \
			"$(billing_database_marker_value route_evidence_sha256)" &&
			"$(billing_cutover_marker_value pre_restore_evidence_sha256)" == \
			"$(billing_database_marker_value pre_restore_evidence_sha256)" &&
			"$(billing_cutover_marker_value pre_offsite_receipt_sha256)" == \
			"$(billing_database_marker_value pre_offsite_receipt_sha256)" &&
			"$(billing_cutover_marker_value post_restore_evidence_sha256)" == \
			"$(billing_database_marker_value post_restore_evidence_sha256)" &&
			"$(billing_cutover_marker_value post_offsite_receipt_sha256)" == \
			"$(billing_database_marker_value post_offsite_receipt_sha256)" ]] ||
			billing_cutover_fail 'Billing lifecycle evidence hashes differ between markers.' ||
			return 1
		if [[ "$cleanup_repair" == 'true' ]]; then
			billing_cutover_write_marker complete "$EXPECTED_REVISION" \
				"$database_cleanup" \
				"$(billing_database_marker_value switch_generation)" \
				"$(billing_database_marker_value database_id)" \
				"$(billing_database_marker_value core_image_id)" \
				"$(billing_database_marker_value billing_image_id)" \
				"$(billing_database_marker_value snapshot_sha256)" \
				"$(billing_database_marker_value projection_evidence_sha256)" \
				"$(billing_database_marker_value route_evidence_sha256)" \
				"$(billing_database_marker_value pre_restore_evidence_sha256)" \
				"$(billing_database_marker_value pre_offsite_receipt_sha256)" \
				"$(billing_database_marker_value post_restore_evidence_sha256)" \
				"$(billing_database_marker_value post_offsite_receipt_sha256)"
		fi
	else
		[[ "$cleanup_repair" == 'false' ]] || return 1
		billing_cutover_write_marker "$database_phase" "$EXPECTED_REVISION" \
			"$(billing_database_marker_value cleanup_revision)" \
			"$(billing_database_marker_value switch_generation)" \
			"$(billing_database_marker_value database_id)" \
			"$(billing_database_marker_value core_image_id)" \
			"$(billing_database_marker_value billing_image_id)" \
			"$(billing_database_marker_value snapshot_sha256)" \
			"$(billing_database_marker_value projection_evidence_sha256)" \
			"$(billing_database_marker_value route_evidence_sha256)" \
			"$(billing_database_marker_value pre_restore_evidence_sha256)" \
			"$(billing_database_marker_value pre_offsite_receipt_sha256)" \
			"$(billing_database_marker_value post_restore_evidence_sha256)" \
			"$(billing_database_marker_value post_offsite_receipt_sha256)"
	fi
}

billing_cutover_prepare() {
	local phase generation core_image_id billing_image_id
	billing_cutover_require_environment
	acquire_production_deploy_lock 'Billing cutover prepare'
	phase="$(billing_database_current_phase)" || return 1
	case "$phase" in
	absent | aborted | preparing | prepared) ;;
	*) billing_cutover_fail "Billing prepare is not allowed from phase=$phase." || return 1 ;;
	esac
	if [[ "$phase" == 'prepared' ]] && billing_cutover_routes_are_desired; then
		billing_cutover_reconcile_marker
		billing_cutover_core_image_id="$(billing_database_marker_value core_image_id)"
		billing_cutover_billing_image_id="$(billing_database_marker_value billing_image_id)"
		billing_database_require_pinned_candidate_images
		billing_cutover_validate_restore_drill
		billing_cutover_validate_route_env_sync
		billing_cutover_gateway_routes_are_legacy ||
			billing_cutover_fail \
				'Running Gateway changed Billing routes before source freeze.' ||
			return 1
		billing_cutover_verify_dark_source_topology
		printf 'billing_cutover_phase=prepared\n'
		return 0
	fi
	billing_cutover_routes_are_legacy ||
		billing_cutover_fail \
			'Billing prepare requires canonical production env to use legacy routes.' ||
		return 1
	billing_cutover_gateway_routes_are_legacy ||
		billing_cutover_fail \
			'Billing prepare requires the running Gateway to use legacy routes.' ||
		return 1
	core_image_id="$(billing_database_marker_value core_image_id 2>/dev/null || true)"
	billing_image_id="$(billing_database_marker_value billing_image_id 2>/dev/null || true)"
	if [[ "$phase" != 'absent' &&
		"$core_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$billing_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		billing_cutover_core_image_id="$core_image_id"
		billing_cutover_billing_image_id="$billing_image_id"
		billing_database_require_pinned_candidate_images
	elif billing_cutover_verify_candidate_images 2>/dev/null; then
		:
	else
		billing_cutover_build_candidate_images
	fi
	billing_cutover_ensure_restore_drill ||
		billing_cutover_fail \
			'Billing PG18 restore-drill evidence is not bound to the built image.' ||
		return 1
	if [[ "$phase" != 'prepared' ]]; then
		BILLING_CANDIDATE_CORE_IMAGE_ID="$billing_cutover_core_image_id" \
		BILLING_CANDIDATE_BILLING_IMAGE_ID="$billing_cutover_billing_image_id" \
			billing_database_prepare
	fi
	billing_cutover_require_artifact_root
	billing_cutover_initialize_marker
	billing_database_require_pinned_candidate_images
	billing_cutover_prepare_route_artifacts
	billing_cutover_provision_rabbit
	env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
		EXPECTED_REVISION="$EXPECTED_REVISION" BILLING_DEPLOY_SKIP_BUILD=true \
		bash "$server_root/scripts/deploy-billing-production.sh" --deploy
	billing_cutover_verify_dark_source_topology
	billing_cutover_install_core_expand_migration
	billing_cutover_require_cli_uid
	generation="$(billing_cutover_marker_value generation)"
	billing_cutover_run_core_cli prepare "$billing_core_prepare_evidence" \
		--revision "$EXPECTED_REVISION" --generation "$generation"
	billing_cutover_validate_core_prepared_state "$billing_core_prepare_evidence"
	billing_cutover_capture_error_contract http://127.0.0.1:4100 \
		"$billing_legacy_error_contract"
	billing_cutover_capture_error_contract http://127.0.0.1:4800 \
		"$billing_direct_error_contract"
	billing_cutover_compare_error_contracts "$billing_legacy_error_contract" \
		"$billing_direct_error_contract" ||
		billing_cutover_fail \
			'Billing direct error contract differs from the legacy Gateway contract.'
	billing_cutover_prepare_route_artifacts
	printf 'billing_cutover_phase=prepared\n'
}

billing_cutover_require_manual_confirmation() {
	[[ "${BILLING_AUTOMATIC_PROD_PUSH:-false}" == 'false' &&
		"${BILLING_FIRST_CUTOVER_APPROVED:-false}" == 'true' &&
		"${BILLING_FIRST_CUTOVER_CONFIRMATION:-}" == \
		"$billing_cutover_confirmation" ]] ||
		billing_cutover_fail \
			'Billing ownership cutover requires the exact manual confirmation.'
}

billing_cutover_run() {
	local phase generation snapshot_sha projection_sha route_sha
	local core_ownership core_source_producers billing_ownership
	local handoff_redeliver integration_user
	billing_cutover_require_environment
	billing_cutover_require_manual_confirmation
	acquire_production_deploy_lock 'Billing ownership cutover'
	billing_cutover_reconcile_marker
	billing_database_require_pinned_candidate_images
	billing_cutover_require_artifact_root
	generation="$(billing_cutover_marker_value generation)"
	phase="$(billing_database_current_phase)"
	case "$phase" in
	prepared | source-frozen | imported | pre-backups-created | \
		pre-restore-verified | projection-synced)
		billing_cutover_validate_route_env_sync ||
			billing_cutover_fail \
				'Billing pre-forward recovery requires the synced desired route env.' ||
			return 1
		billing_cutover_gateway_routes_are_legacy ||
			billing_cutover_fail \
				'Running Gateway activated Billing routes before the forward boundary.' ||
			return 1
		;;
	active | post-backup-created | post-restore-verified)
		billing_cutover_require_active_runtime ||
			billing_cutover_fail \
				'Billing active runtime drifted during the restore/offsite pause.' ||
			return 1
		;;
	esac
	if [[ "$phase" == 'prepared' ]]; then
		billing_cutover_gateway_routes_are_legacy ||
			billing_cutover_fail \
				'Running Gateway changed Billing routes before source freeze.' || return 1
		billing_cutover_run_core_cli status "$billing_core_status_evidence" \
			--revision "$EXPECTED_REVISION" --generation "$generation"
		core_source_producers="$(billing_cutover_core_source_producers \
			"$billing_core_status_evidence")"
		case "$core_source_producers" in
		true)
			billing_cutover_start_dark_source_worker
			billing_cutover_stop_source_worker_for_snapshot
			;;
		false)
			billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
				stop -t 90 billing-worker >/dev/null
			billing_cutover_wait_source_consumers 0
			;;
		*) billing_cutover_fail 'Core source-producer status is invalid.' || return 1 ;;
		esac
		billing_cutover_run_core_snapshot_export
		billing_cutover_validate_frozen_snapshot
		for ((drain_second = 0; drain_second < BILLING_DRAIN_SECONDS; drain_second++)); do
			sleep 1
		done
		snapshot_sha="$(billing_cutover_sha256 "$billing_snapshot_file")"
		billing_cutover_update_phase source-frozen "$snapshot_sha" pending pending
		phase='source-frozen'
	fi
	if [[ "$phase" == 'source-frozen' ]]; then
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop -t 90 billing-worker >/dev/null
		billing_cutover_wait_source_consumers 0
		billing_cutover_run_billing_snapshot_cli import-frozen \
			"$billing_import_evidence" --revision "$EXPECTED_REVISION" \
			--generation "$generation"
		billing_cutover_validate_import_evidence \
			"$billing_import_evidence" import-frozen
		billing_cutover_run_billing_snapshot_cli verify-import \
			"$billing_import_verify_evidence" --revision "$EXPECTED_REVISION" \
			--generation "$generation"
		billing_cutover_validate_import_evidence \
			"$billing_import_verify_evidence" verify-import
		billing_cutover_start_dark_source_worker
		billing_cutover_wait_core_outbox billing-source
		for ((source_drain_attempt = 1; source_drain_attempt <= 60; \
			source_drain_attempt++)); do
			billing_cutover_source_queues_are_drained && break
			sleep 1
		done
		((source_drain_attempt <= 60)) || billing_cutover_fail \
			'Billing source queues did not drain after verified frozen import.' || return 1
		snapshot_sha="$(billing_cutover_sha256 "$billing_snapshot_file")"
		billing_cutover_update_phase imported "$snapshot_sha" pending pending
		phase='imported'
	fi
	if [[ "$phase" == 'imported' ]]; then
		billing_cutover_create_pre_backups
		snapshot_sha="$(billing_database_marker_value snapshot_sha256)"
		billing_cutover_update_phase pre-backups-created "$snapshot_sha" \
			pending pending
		printf 'billing_cutover_phase=pre-backups-created\n'
		printf 'billing_restore_required=pre-cutover\n'
		printf 'billing_restore_evidence_import=%s\n' \
			"/root/winwidget-billing-pre-restore-${EXPECTED_REVISION}-g${generation}.json"
		printf 'billing_offsite_receipt_import=%s\n' \
			"/root/winwidget-billing-pre-offsite-${EXPECTED_REVISION}-g${generation}.json"
		return 0
	fi
	if [[ "$phase" == 'pre-backups-created' ]]; then
		billing_cutover_require_actual_restore_gate pre-cutover
		billing_cutover_update_phase pre-restore-verified \
			"$(billing_database_marker_value snapshot_sha256)" pending pending
		phase='pre-restore-verified'
	fi
	if [[ "$phase" == 'pre-restore-verified' ]]; then
		billing_cutover_run_billing_cli seed-core-read-events \
			"$billing_seed_evidence" --revision "$EXPECTED_REVISION" \
			--generation "$generation"
		billing_cutover_validate_seed_evidence
		billing_cutover_wait_seed_outbox
		billing_cutover_wait_projection_lag_zero "$generation"
		snapshot_sha="$(billing_cutover_sha256 "$billing_snapshot_file")"
		projection_sha="$(billing_cutover_sha256 "$billing_projection_evidence")"
		billing_cutover_update_phase projection-synced "$snapshot_sha" \
			"$projection_sha" pending
		phase='projection-synced'
	fi
	if [[ "$phase" == 'projection-synced' ]]; then
		billing_cutover_run_billing_cli status \
			"$billing_service_status_evidence"
		billing_cutover_validate_billing_status_before_activate
		billing_cutover_run_core_cli status "$billing_core_status_evidence" \
			--revision "$EXPECTED_REVISION" --generation "$generation"
		core_ownership="$(billing_cutover_core_ownership \
			"$billing_core_status_evidence")"
		case "$core_ownership" in
		CORE)
			integration_user="$(billing_cutover_rabbit_user \
				RABBITMQ_INTEGRATION_WORKER_URL)"
			billing_cutover_wait_auto_renewal_ownership 1 \
				winwidget-integration-worker "$integration_user" \
				core-owner "$billing_auto_renewal_core_evidence" ''
			handoff_redeliver="$(billing_cutover_auto_renewal_redeliver \
				"$billing_auto_renewal_core_evidence")"
			billing_cutover_run_core_cli activate \
				"$billing_core_activation_evidence" \
				--revision "$EXPECTED_REVISION" --generation "$generation"
			billing_cutover_validate_core_active_state \
				"$billing_core_activation_evidence"
			;;
		BILLING)
			billing_cutover_validate_core_active_state \
				"$billing_core_status_evidence"
			handoff_redeliver="$(billing_cutover_auto_renewal_redeliver \
				"$billing_auto_renewal_core_evidence")"
			;;
		*) billing_cutover_fail 'Core Billing ownership state is invalid.' || return 1 ;;
		esac
		billing_cutover_wait_auto_renewal_ownership 0 '' '' detached \
			"$billing_auto_renewal_detached_evidence" "$handoff_redeliver"
		snapshot_sha="$(billing_cutover_sha256 "$billing_snapshot_file")"
		projection_sha="$(billing_cutover_sha256 "$billing_projection_evidence")"
		billing_cutover_update_phase forward-only "$snapshot_sha" \
			"$projection_sha" pending
		phase='forward-only'
	fi
	if [[ "$phase" == 'forward-only' ]]; then
		billing_cutover_restrict_core_integration_permissions
		handoff_redeliver="$(billing_cutover_auto_renewal_redeliver \
			"$billing_auto_renewal_core_evidence")"
		billing_cutover_wait_auto_renewal_ownership 0 '' '' detached \
			"$billing_auto_renewal_detached_evidence" "$handoff_redeliver"
		billing_cutover_run_billing_cli status \
			"$billing_service_status_evidence"
		billing_cutover_validate_billing_status_before_activate
		billing_ownership="$(billing_cutover_billing_ownership_phase \
			"$billing_service_status_evidence")"
		case "$billing_ownership" in
		PREPARED)
			billing_cutover_run_billing_cli activate \
				"$billing_service_activation_evidence" \
				--revision "$EXPECTED_REVISION" --generation "$generation"
			billing_cutover_validate_billing_transition \
				"$billing_service_activation_evidence" activate ACTIVE
			;;
		ACTIVE) ;;
		*) billing_cutover_fail \
			'Billing service is not in an activatable forward-recovery phase.' || return 1 ;;
		esac
		env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
			EXPECTED_REVISION="$EXPECTED_REVISION" BILLING_DEPLOY_SKIP_BUILD=true \
			bash "$server_root/scripts/deploy-billing-production.sh" --deploy
		billing_cutover_wait_auto_renewal_ownership 1 \
			winwidget-billing-worker winwidget-billing-worker billing-owner \
			"$billing_auto_renewal_billing_evidence" "$handoff_redeliver"
		billing_cutover_validate_route_env_sync
		route_sha="$(billing_cutover_sha256 "$billing_route_env_sync_evidence")"
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate api-gateway
		billing_cutover_wait_gateway
		billing_cutover_gateway_routes_are_desired ||
			billing_cutover_fail \
				'Running Gateway did not activate the exact Billing route manifest.' ||
			return 1
		billing_cutover_capture_error_contract http://127.0.0.1:4100 \
			"$billing_gateway_error_contract"
		billing_cutover_compare_error_contracts "$billing_direct_error_contract" \
			"$billing_gateway_error_contract" ||
			billing_cutover_fail \
				'Gateway Billing error contract changed during the route switch.' || return 1
		billing_cutover_run_core_cli status "$billing_core_status_evidence" \
			--revision "$EXPECTED_REVISION" --generation "$generation"
		billing_cutover_validate_core_active_state "$billing_core_status_evidence"
		snapshot_sha="$(billing_cutover_sha256 "$billing_snapshot_file")"
		projection_sha="$(billing_cutover_sha256 "$billing_projection_evidence")"
		billing_cutover_update_phase active "$snapshot_sha" "$projection_sha" \
			"$route_sha"
		phase='active'
	fi
	if [[ "$phase" == 'active' ]]; then
		billing_cutover_create_backup BILLING_BACKUP_URL billing \
			"$billing_post_backup" billing-post-ownership
		billing_cutover_update_phase post-backup-created \
			"$(billing_database_marker_value snapshot_sha256)" \
			"$(billing_database_marker_value projection_evidence_sha256)" \
			"$(billing_cutover_marker_value route_sha256)"
		printf 'billing_cutover_phase=post-backup-created\n'
		printf 'billing_restore_required=post-ownership\n'
		printf 'billing_restore_evidence_import=%s\n' \
			"/root/winwidget-billing-post-restore-${EXPECTED_REVISION}-g${generation}.json"
		printf 'billing_offsite_receipt_import=%s\n' \
			"/root/winwidget-billing-post-offsite-${EXPECTED_REVISION}-g${generation}.json"
		return 0
	fi
	if [[ "$phase" == 'post-backup-created' ]]; then
		billing_cutover_require_actual_restore_gate post-ownership
		billing_cutover_update_phase post-restore-verified \
			"$(billing_database_marker_value snapshot_sha256)" \
			"$(billing_database_marker_value projection_evidence_sha256)" \
			"$(billing_cutover_marker_value route_sha256)"
		phase='post-restore-verified'
	fi
	if [[ "$phase" == 'post-restore-verified' ]]; then
		billing_cutover_run_billing_cli status "$billing_service_status_evidence"
		billing_ownership="$(billing_cutover_billing_ownership_phase \
			"$billing_service_status_evidence")"
		case "$billing_ownership" in
		ACTIVE)
			billing_cutover_run_billing_cli complete "$billing_completion_evidence" \
				--revision "$EXPECTED_REVISION" --generation "$generation"
			billing_cutover_validate_billing_transition \
				"$billing_completion_evidence" complete COMPLETE
			;;
		COMPLETE)
			billing_cutover_validate_billing_completed_status \
				"$billing_service_status_evidence"
			;;
		*) billing_cutover_fail \
			'Post-restore forward recovery requires ACTIVE or COMPLETE Billing ownership.' ||
			return 1 ;;
		esac
		billing_cutover_update_phase complete \
			"$(billing_database_marker_value snapshot_sha256)" \
			"$(billing_database_marker_value projection_evidence_sha256)" \
			"$(billing_cutover_marker_value route_sha256)"
	fi
	printf 'billing_cutover_phase=%s\n' "$(billing_database_current_phase)"
}

billing_cutover_abort() {
	local phase generation core_ownership
	billing_cutover_require_environment
	[[ "${BILLING_ABORT_CONFIRMATION:-}" == 'ABORT BILLING CUTOVER' ]] ||
		billing_cutover_fail 'Billing abort requires the exact manual confirmation.' ||
		return 1
	acquire_production_deploy_lock 'Billing cutover abort'
	billing_cutover_reconcile_marker
	billing_database_require_pinned_candidate_images
	phase="$(billing_database_current_phase)"
	case "$phase" in
	prepared | source-frozen | imported | pre-backups-created | \
		pre-restore-verified | projection-synced | aborted) ;;
	*) billing_cutover_fail \
		"Billing abort is forbidden from phase=$phase." || return 1 ;;
	esac
	generation="$(billing_cutover_marker_value generation)"
	billing_cutover_run_core_cli status "$billing_core_status_evidence" \
		--revision "$EXPECTED_REVISION" --generation "$generation"
	core_ownership="$(billing_cutover_core_ownership \
		"$billing_core_status_evidence")" || return 1
	[[ "$core_ownership" == 'CORE' ]] ||
		billing_cutover_fail \
			'Core already owns Billing forward-only; keep desired routes and resume cutover.' ||
		return 1
	billing_cutover_require_abort_route_state "$phase" || return 1
	if [[ "$phase" == 'aborted' ]]; then
		billing_database_require_runtime_stopped || return 1
		printf 'billing_cutover_phase=aborted\n'
		return 0
	fi
	billing_cutover_run_core_cli abort "$billing_core_abort_evidence" \
		--revision "$EXPECTED_REVISION" --generation "$generation"
	billing_cutover_validate_core_abort_state "$billing_core_abort_evidence"
	billing_database_abort
	billing_cutover_write_marker aborted "$EXPECTED_REVISION" \
		"$(billing_database_marker_value cleanup_revision)" "$generation" \
		"$(billing_database_marker_value database_id)" \
		"$(billing_database_marker_value core_image_id)" \
		"$(billing_database_marker_value billing_image_id)" \
		"$(billing_database_marker_value snapshot_sha256)" \
		"$(billing_database_marker_value projection_evidence_sha256)" pending \
		"$(billing_database_marker_value pre_restore_evidence_sha256)" \
		"$(billing_database_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_database_marker_value post_restore_evidence_sha256)" \
		"$(billing_database_marker_value post_offsite_receipt_sha256)"
	printf 'billing_cutover_phase=aborted\n'
}

billing_cutover_forward_recovery() {
	local phase
	billing_cutover_require_environment
	billing_cutover_reconcile_marker
	phase="$(billing_database_current_phase)"
	case "$phase" in
	forward-only | active | post-backup-created | post-restore-verified)
		billing_cutover_run
		;;
	*) billing_cutover_fail \
		"Forward recovery requires a forward-only Billing phase; phase=$phase." ;;
	esac
}

billing_cutover_require_cleanup_revision_stage() {
	[[ $# -eq 1 ]] || return 1
	local requested="$1" database_cleanup cutover_cleanup
	billing_release_validate_revision "$requested" || return 1
	database_cleanup="$(billing_database_marker_value cleanup_revision)" || return 1
	cutover_cleanup="$(billing_cutover_marker_value cleanup_revision)" || return 1
	[[ "$database_cleanup" == "$cutover_cleanup" &&
		( "$database_cleanup" == 'pending' ||
			"$database_cleanup" == "$requested" ) ]] ||
		billing_cutover_fail \
			'Billing cleanup revision is immutable once it has been staged.'
}

billing_cutover_stage_cleanup_revision() {
	[[ $# -eq 1 ]] || return 1
	local cleanup_revision="$1"
	billing_cutover_require_environment
	billing_release_validate_revision "$cleanup_revision"
	[[ "${BILLING_CLEANUP_STAGE_CONFIRMATION:-}" == \
		'STAGE BILLING CLEANUP REVISION' ]] ||
		billing_cutover_fail 'Billing cleanup SHA staging requires exact confirmation.' ||
		return 1
	acquire_production_deploy_lock 'Billing cleanup revision staging'
	billing_cutover_reconcile_marker
	billing_cutover_require_cleanup_revision_stage "$cleanup_revision" || return 1
	[[ "$(billing_database_current_phase)" == 'complete' &&
		"$cleanup_revision" != "$EXPECTED_REVISION" ]] ||
		billing_cutover_fail \
			'Cleanup revision can be staged only after complete and must be SHA B.' ||
		return 1
	billing_database_write_marker complete "$EXPECTED_REVISION" \
		"$cleanup_revision" "$(billing_database_marker_value database_id)" \
		"$(billing_database_marker_value database_system_identifier)" \
		"$(billing_database_marker_value database_volume)" \
		"$(billing_database_marker_value postgres_image_id)" \
		"$(billing_database_marker_value core_image_id)" \
		"$(billing_database_marker_value billing_image_id)" \
		"$(billing_database_marker_value switch_generation)" \
		"$(billing_database_marker_value snapshot_sha256)" \
		"$(billing_database_marker_value pre_backup_sha256)" \
		"$(billing_database_marker_value post_backup_sha256)" \
		"$(billing_database_marker_value restore_evidence_sha256)" \
		"$(billing_database_marker_value pre_restore_evidence_sha256)" \
		"$(billing_database_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_database_marker_value post_restore_evidence_sha256)" \
		"$(billing_database_marker_value post_offsite_receipt_sha256)" \
		"$(billing_database_marker_value projection_evidence_sha256)" \
		"$(billing_database_marker_value route_evidence_sha256)" \
		"$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	billing_cutover_write_marker complete "$EXPECTED_REVISION" \
		"$cleanup_revision" "$(billing_cutover_marker_value generation)" \
		"$(billing_cutover_marker_value database_id)" \
		"$(billing_database_marker_value core_image_id)" \
		"$(billing_database_marker_value billing_image_id)" \
		"$(billing_cutover_marker_value snapshot_sha256)" \
		"$(billing_cutover_marker_value projection_sha256)" \
		"$(billing_cutover_marker_value route_sha256)" \
		"$(billing_database_marker_value pre_restore_evidence_sha256)" \
		"$(billing_database_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_database_marker_value post_restore_evidence_sha256)" \
		"$(billing_database_marker_value post_offsite_receipt_sha256)"
	printf 'billing_cleanup_revision_staged=%s\n' "$cleanup_revision"
}

billing_cutover_status() {
	local phase
	phase="$(billing_cutover_current_phase)" || return 1
	printf 'billing_cutover_phase=%s\n' "$phase"
	if [[ "$phase" != 'absent' ]]; then
		printf 'billing_cutover_revision=%s\n' \
			"$(billing_cutover_marker_value revision)"
		printf 'billing_cutover_generation=%s\n' \
			"$(billing_cutover_marker_value generation)"
	fi
}

billing_cutover_actual_restore_validator_self_test() (
	local directory revision core_image_id billing_image_id postgres_image_id
	directory="$(mktemp -d "${TMPDIR:-/tmp}/billing-restore-validator.XXXXXX")"
	trap 'rm -f -- "$directory"/*; rmdir -- "$directory"' EXIT
	revision="$(printf 'a%.0s' {1..40})"
	core_image_id="sha256:$(printf '1%.0s' {1..64})"
	billing_image_id="sha256:$(printf '2%.0s' {1..64})"
	postgres_image_id="sha256:$(printf '3%.0s' {1..64})"
	EXPECTED_REVISION="$revision"
	billing_snapshot_file="$directory/snapshot.json"
	billing_pre_backup_manifest="$directory/manifest.json"
	billing_core_backup="$directory/core.dump"
	billing_service_backup="$directory/billing-pre.dump"
	billing_post_backup="$directory/billing-post.dump"
	billing_pre_restore_evidence="$directory/pre.json"
	billing_post_restore_evidence="$directory/post.json"
	printf 'core-dump-fixture\n' >"$billing_core_backup"
	printf 'billing-pre-dump-fixture\n' >"$billing_service_backup"
	printf 'billing-post-dump-fixture\n' >"$billing_post_backup"
	REVISION="$revision" CORE_IMAGE_ID="$core_image_id" \
		BILLING_IMAGE_ID="$billing_image_id" POSTGRES_IMAGE_ID="$postgres_image_id" \
		POSTGRES_IMAGE="$billing_postgres_image" DIRECTORY="$directory" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const directory = process.env.DIRECTORY;
const digest = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const size = path => fs.statSync(path).size;
const revision = process.env.REVISION;
const fingerprint = 'd'.repeat(64);
const metric = systemIdentifier => ({
  systemIdentifier,
  tableCount: 1,
  tableManifestSha256: '4'.repeat(64),
  rowManifestSha256: '5'.repeat(64),
  migrationCount: 1,
  migrationLedgerSha256: '6'.repeat(64),
});
const dump = path => ({
  sha256: digest(path),
  sizeBytes: size(path),
  tocSha256: '7'.repeat(64),
});
const images = {
  core: {
    ref: `winwidget-api:git-${revision}`,
    imageId: process.env.CORE_IMAGE_ID,
    revision,
    user: 'nestjs',
  },
  billing: {
    ref: `winwidget-billing:git-${revision}`,
    imageId: process.env.BILLING_IMAGE_ID,
    revision,
    user: 'billing',
  },
  postgres: {
    ref: process.env.POSTGRES_IMAGE,
    imageId: process.env.POSTGRES_IMAGE_ID,
    major: 18,
  },
};
const commonChecks = {
  sourceFilesSafe: true,
  dumpShaStable: true,
  manifestBinding: true,
  toc: true,
  releaseImages: true,
  isolatedTargets: true,
  noHostPorts: true,
  distinctClusters: true,
  migrations: true,
  anchors: true,
  acl: true,
  relationships: true,
  continuity: true,
  resourcesRemoved: true,
};
const base = phase => ({
  schemaVersion: 1,
  action: 'billing-actual-backup-restore-rehearsal',
  target: 'billing',
  status: 'passed',
  postgresMajor: 18,
  phase,
  revision,
  generation: 1,
  images,
  startedAt: '2026-08-11T00:00:00Z',
  completedAt: '2026-08-11T00:01:00Z',
});
const coreDump = `${directory}/core.dump`;
const billingPreDump = `${directory}/billing-pre.dump`;
const billingPostDump = `${directory}/billing-post.dump`;
fs.writeFileSync(`${directory}/snapshot.json`, JSON.stringify({
  sourceFingerprint: fingerprint,
  coreState: { ownership: 'CORE' },
}));
fs.writeFileSync(`${directory}/manifest.json`, JSON.stringify({
  version: 2,
  revision,
  generation: 1,
  coreImageId: process.env.CORE_IMAGE_ID,
  billingImageId: process.env.BILLING_IMAGE_ID,
  coreDumpSha256: digest(coreDump),
  coreDumpSizeBytes: size(coreDump),
  billingDumpSha256: digest(billingPreDump),
  billingDumpSizeBytes: size(billingPreDump),
}));
const pre = {
  ...base('pre-cutover'),
  dumps: { corePre: dump(coreDump), billingPre: dump(billingPreDump) },
  restores: { corePre: metric('1001'), billingPre: metric('1002') },
  anchors: {
    billingDatabaseId: '11111111-1111-4111-8111-111111111111',
    sourceFingerprint: fingerprint,
    coreOwnership: 'CORE',
    billingOwnership: 'PREPARED',
    billingDatabasePhase: 'IMPORTED',
    coreRestoreSystemIdentifier: '1001',
    billingPreRestoreSystemIdentifier: '1002',
  },
  checks: { ...commonChecks, coreBillingParity: true },
};
fs.writeFileSync(`${directory}/pre.json`, JSON.stringify(pre));
const post = {
  ...base('post-ownership'),
  dumps: { billingPre: dump(billingPreDump), billingPost: dump(billingPostDump) },
  restores: { billingPre: metric('2001'), billingPost: metric('2002') },
  anchors: {
    billingDatabaseId: '11111111-1111-4111-8111-111111111111',
    sourceFingerprint: fingerprint,
    billingPreOwnership: 'PREPARED',
    billingPostOwnership: 'ACTIVE',
    billingPreDatabasePhase: 'IMPORTED',
    billingPostDatabasePhase: 'ACTIVE',
    billingPreRestoreSystemIdentifier: '2001',
    billingPostRestoreSystemIdentifier: '2002',
  },
  checks: {
    ...commonChecks,
    preEvidenceBinding: true,
    prePostContinuity: true,
  },
  preEvidenceSha256: digest(`${directory}/pre.json`),
};
fs.writeFileSync(`${directory}/post.json`, JSON.stringify(post));
fs.writeFileSync(`${directory}/pre-bad.json`, JSON.stringify({
  ...pre,
  images: {
    ...pre.images,
    core: { ...pre.images.core, imageId: process.env.BILLING_IMAGE_ID },
  },
}));
fs.writeFileSync(`${directory}/post-bad.json`, JSON.stringify({
  ...post,
  preEvidenceSha256: '0'.repeat(64),
}));
NODE
	chmod 600 "$directory"/*
	billing_cutover_validate_evidence_file() { [[ -f "$1" && ! -L "$1" && -s "$1" ]]; }
	billing_cutover_validate_frozen_snapshot() { return 0; }
	billing_cutover_marker_value() {
		[[ "$1" == 'generation' ]] && printf '1\n'
	}
	billing_database_marker_value() {
		case "$1" in
		database_id) printf '11111111-1111-4111-8111-111111111111\n' ;;
		database_system_identifier) printf '999\n' ;;
		core_image_id) printf '%s\n' "$core_image_id" ;;
		billing_image_id) printf '%s\n' "$billing_image_id" ;;
		postgres_image_id) printf '%s\n' "$postgres_image_id" ;;
		*) return 1 ;;
		esac
	}
	billing_cutover_validate_actual_restore_evidence \
		"$billing_pre_restore_evidence" pre-cutover
	if billing_cutover_validate_actual_restore_evidence \
		"$directory/pre-bad.json" pre-cutover; then
		return 1
	fi
	billing_cutover_validate_actual_restore_evidence \
		"$billing_post_restore_evidence" post-ownership
	if billing_cutover_validate_actual_restore_evidence \
		"$directory/post-bad.json" post-ownership; then
		return 1
	fi
)

billing_cutover_route_rollback_self_test() (
	local directory revision generation legacy_sha candidate_sha manifest_sha
	directory="$(mktemp -d /tmp/billing-route-rollback-self-test.XXXXXX)"
	revision="$(printf '7%.0s' {1..40})"
	generation='9'
	EXPECTED_REVISION="$revision"
	billing_route_env_legacy_snapshot="$directory/legacy.env"
	billing_route_env_candidate="$directory/candidate.env"
	billing_route_manifest="$directory/manifest.json"
	billing_route_env_sync_evidence="$directory/forward.json"
	billing_route_env_rollback_evidence="$directory/rollback.json"
	billing_artifact_root="$directory"
	COMPOSE_FILE="$directory/compose.yml"
	printf '%s\n' \
		'MODE=production' \
		'GATEWAY_ROUTES_JSON=[{"id":"core","pathPrefix":"/api/v1","upstreamUrl":"http://127.0.0.1:4200","authPolicy":"optional","timeoutMs":30000}]' \
		'UNCHANGED=value' >"$billing_route_env_legacy_snapshot"
	node - "$billing_route_env_legacy_snapshot" "$billing_route_env_candidate" \
		"$billing_route_manifest" <<'NODE'
const fs = require('node:fs');
const [legacyPath, candidatePath, manifestPath] = process.argv.slice(2);
const lines = fs.readFileSync(legacyPath, 'utf8').split('\n');
const index = lines.findIndex(line => line.startsWith('GATEWAY_ROUTES_JSON='));
const legacy = JSON.parse(lines[index].slice('GATEWAY_ROUTES_JSON='.length));
const desired = [
  ['/api/v1/payments', 'billing-payments'],
  ['/api/v1/subscriptions', 'billing-subscriptions'],
  ['/api/v1/tariff-prices', 'billing-tariff-prices'],
  ['/api/v1/affiliate', 'billing-affiliate'],
].map(([pathPrefix, id]) => ({
  id, pathPrefix, upstreamUrl: 'http://127.0.0.1:4800',
  authPolicy: 'optional', timeoutMs: 30000,
}));
lines[index] = `GATEWAY_ROUTES_JSON=${JSON.stringify([...desired, ...legacy])}`;
fs.writeFileSync(candidatePath, lines.join('\n'));
fs.writeFileSync(manifestPath, `${JSON.stringify(desired)}\n`);
NODE
	billing_cutover_validate_evidence_file() {
		[[ -f "$1" && ! -L "$1" && -s "$1" ]]
	}
	billing_compose_config_all_profiles() { return 0; }
	billing_cutover_marker_value() {
		[[ "$1" == 'generation' ]] || return 1
		printf '%s\n' "$generation"
	}
	billing_cutover_gateway_routes_are_legacy() { return 0; }
	billing_cutover_fail() { return 1; }
	billing_cutover_validate_route_artifacts
	chown() { return 0; }
	stat() { printf '0:0:600\n'; }
	rm -f -- "$billing_route_env_candidate"
	billing_cutover_write_route_manifest >/dev/null
	billing_cutover_validate_route_artifacts
	rm -f -- "$billing_route_manifest"
	billing_cutover_write_route_manifest >/dev/null
	billing_cutover_validate_route_artifacts
	legacy_sha="$(billing_cutover_sha256 "$billing_route_env_legacy_snapshot")"
	candidate_sha="$(billing_cutover_sha256 "$billing_route_env_candidate")"
	manifest_sha="$(billing_cutover_sha256 "$billing_route_manifest")"
	REVISION="$revision" GENERATION="$generation" LEGACY_SHA="$legacy_sha" \
	CANDIDATE_SHA="$candidate_sha" MANIFEST_SHA="$manifest_sha" \
		node - "$billing_route_env_sync_evidence" \
		"$billing_route_env_rollback_evidence" <<'NODE'
const fs = require('node:fs');
const base = {
  schemaVersion: 1,
  status: 'passed',
  revision: process.env.REVISION,
  generation: Number(process.env.GENERATION),
  observedAt: '2026-08-11T00:00:00Z',
};
fs.writeFileSync(process.argv[2], JSON.stringify({
  ...base,
  action: 'billing-route-env-sync',
  localSourceSha256: process.env.LEGACY_SHA,
  serverSourceSha256: process.env.LEGACY_SHA,
  localCandidateSha256: process.env.CANDIDATE_SHA,
  uploadedServerSha256: process.env.CANDIDATE_SHA,
  roundTripLocalSha256: process.env.CANDIDATE_SHA,
  routeManifestSha256: process.env.MANIFEST_SHA,
}));
fs.writeFileSync(process.argv[3], JSON.stringify({
  ...base,
  action: 'billing-route-env-rollback-sync',
  desiredCandidateSha256: process.env.CANDIDATE_SHA,
  localSourceSha256: process.env.CANDIDATE_SHA,
  serverSourceSha256: process.env.CANDIDATE_SHA,
  legacyEnvSha256: process.env.LEGACY_SHA,
  uploadedServerSha256: process.env.LEGACY_SHA,
  roundTripLocalSha256: process.env.LEGACY_SHA,
}));
NODE
	ENV_FILE="$billing_route_env_candidate"
	billing_cutover_validate_route_env_sync
	ENV_FILE="$billing_route_env_legacy_snapshot"
	billing_cutover_validate_route_env_rollback_sync recorded
	billing_cutover_require_abort_route_state source-frozen
	generation='10'
	if billing_cutover_validate_route_env_rollback_sync recorded; then return 1; fi
	generation='9'
	rm -f -- "$billing_route_env_sync_evidence"
	billing_cutover_validate_route_env_rollback_sync unrecorded
	billing_cutover_require_abort_route_state prepared
	rm -f -- "$billing_route_env_rollback_evidence"
	if billing_cutover_require_abort_route_state prepared; then return 1; fi
	rm -f -- "$billing_route_env_legacy_snapshot" \
		"$billing_route_env_candidate" "$billing_route_manifest" \
		"$billing_route_env_sync_evidence"
	rmdir -- "$directory"
)

billing_cutover_partial_recovery_self_test() (
	local directory source destination partial
	directory="$(mktemp -d /tmp/billing-partial-recovery-self-test.XXXXXX)"
	source="$directory/source.json"
	destination="$directory/destination.json"
	partial="$destination.partial"
	printf 'trusted-source\n' >"$source"
	chown() { return 0; }
	stat() { printf '0:0:600\n'; }
	billing_cutover_validate_evidence_file() {
		[[ -f "$1" && ! -L "$1" && -s "$1" ]]
	}
	billing_cutover_fail() { return 1; }
	: >"$partial"
	billing_cutover_promote_import_partial "$source" "$partial" "$destination"
	[[ "$(<"$destination")" == 'trusted-source' ]]
	rm -f -- "$destination"
	cp -- "$source" "$partial"
	billing_cutover_promote_import_partial "$source" "$partial" "$destination"
	[[ "$(<"$destination")" == 'trusted-source' ]]
	rm -f -- "$destination"
	ln -s "$source" "$partial"
	if billing_cutover_promote_import_partial \
		"$source" "$partial" "$destination"; then return 1; fi
	[[ -L "$partial" && ! -e "$destination" ]]
	rm -f -- "$partial"
	ENV_FILE="$directory/env" COMPOSE_FILE="$directory/compose.yml"
	EXPECTED_REVISION="$(printf '8%.0s' {1..40})"
	billing_compose() { printf 'PGDMPsynthetic-backup'; }
	destination="$directory/backup.dump"
	partial="$destination.partial"
	: >"$partial"
	billing_cutover_create_backup TEST_URL public "$destination" synthetic
	[[ "$(<"$destination")" == 'PGDMPsynthetic-backup' ]]
	rm -f -- "$source" "$destination"
	rmdir -- "$directory"
)

billing_cutover_reprepare_identity_self_test() (
	local directory old_database_id new_database_id marker_database_id
	local archived_generation='' written_identity='' updated='false'
	directory="$(mktemp -d /tmp/billing-reprepare-identity-self-test.XXXXXX)"
	billing_cutover_marker="$directory/marker"
	: >"$billing_cutover_marker"
	EXPECTED_REVISION="$(printf '9%.0s' {1..40})"
	old_database_id='11111111-1111-4111-8111-111111111111'
	new_database_id='22222222-2222-4222-8222-222222222222'
	marker_database_id="$old_database_id"
	billing_cutover_core_image_id="sha256:$(printf 'a%.0s' {1..64})"
	billing_cutover_billing_image_id="sha256:$(printf 'b%.0s' {1..64})"
	billing_database_current_phase() { printf 'prepared\n'; }
	billing_database_marker_value() {
		[[ "$1" == 'database_id' ]] || return 1
		printf '%s\n' "$new_database_id"
	}
	billing_cutover_validate_marker() { return 0; }
	billing_cutover_marker_value() {
		case "$1" in
		phase) printf 'aborted\n' ;;
		revision) printf '%s\n' "$EXPECTED_REVISION" ;;
		database_id) printf '%s\n' "$marker_database_id" ;;
		generation) printf '3\n' ;;
		cleanup_revision) printf 'pending\n' ;;
		*) return 1 ;;
		esac
	}
	billing_cutover_archive_aborted_generation() {
		archived_generation="$1"
	}
	billing_cutover_write_marker() {
		written_identity="$1|$4|$5"
	}
	billing_cutover_update_phase() {
		[[ "$1|$2|$3|$4" == 'prepared|pending|pending|pending' ]]
		updated='true'
	}
	billing_cutover_fail() { return 1; }
	billing_cutover_initialize_marker
	[[ "$archived_generation" == '3' &&
		"$written_identity" == "prepared|4|$new_database_id" &&
		"$updated" == 'true' ]]
	marker_database_id="$new_database_id"
	archived_generation=''
	if billing_cutover_initialize_marker; then return 1; fi
	[[ -z "$archived_generation" ]]
	rm -f -- "$billing_cutover_marker"
	rmdir -- "$directory"
)

billing_cutover_self_test() {
	local source forbidden_business_publish
	local forbidden_env_replace rollout_source handoff_source permission_source
	local restore_gate_source recovery_source synthetic_source reconcile_source
	local initialize_source cleanup_stage_source active_runtime_source abort_source
	source="$(<"$server_root/scripts/billing-cutover-production.sh")"
	rollout_source="$(declare -f billing_cutover_prepare \
		billing_cutover_install_core_expand_migration \
		billing_cutover_recover_core_publisher)"
	handoff_source="$(declare -f billing_cutover_run)"
	permission_source="$(declare -f \
		billing_cutover_restrict_core_integration_permissions)"
	restore_gate_source="$(declare -f \
		billing_cutover_import_actual_restore_evidence \
		billing_cutover_require_actual_restore_gate)"
	recovery_source="$(declare -f billing_cutover_forward_recovery)"
	synthetic_source="$(declare -f billing_cutover_validate_restore_drill \
		billing_cutover_ensure_restore_drill)"
	reconcile_source="$(declare -f billing_cutover_reconcile_marker \
		billing_cutover_update_phase)"
	initialize_source="$(declare -f billing_cutover_initialize_marker)"
	cleanup_stage_source="$(declare -f \
		billing_cutover_require_cleanup_revision_stage \
		billing_cutover_stage_cleanup_revision)"
	active_runtime_source="$(declare -f billing_cutover_require_active_runtime)"
	abort_source="$(declare -f billing_cutover_abort \
		billing_cutover_require_abort_route_state \
		billing_cutover_validate_route_env_rollback_sync)"
	forbidden_business_publish="rabbitmqadmin $(printf publish)"
	forbidden_env_replace="mv -f \"\$temporary_env\" \"\$ENV_FILE\""
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'--profile migration'* &&
		"$source" == *'--profile billing-migration'* &&
		"$source" == *'billing-migrate'* &&
		"$source" == *'dist/src/billing-core-cutover-main.js'* &&
		"$source" == *'dist/src/cutover-main.js'* &&
		"$source" == *'freeze-export'* &&
		"$source" == *'seed-core-read-events'* &&
		"$source" == *'billing.payment.details.changed.v1'* &&
		"$source" == *'billing.subscription.details.changed.v1'* &&
		"$source" == *'billing.affiliate.changed.v1'* &&
		"$source" == *'billing.settings.changed.v1'* &&
		"$source" == *'projectionConsumerEnabled !== true'* &&
		"$source" == *'/api/v1/tariff-prices'* &&
		"$source" == *'RABBITMQ_BILLING_WORKER_URL'* &&
		"$source" == *'RABBITMQ_BILLING_PUBLISHER_URL'* &&
		"$source" == *'winwidget.billing.settings-source.v1'* &&
		"$source" == *'winwidget.billing.offer.v1'* &&
		"$source" == *'billing_cutover_wait_source_consumers 0'* &&
		"$source" == *'stop -t 90 billing-worker'* &&
		"$source" == *'winwidget.payment.auto-renewal'* &&
		"$source" == *'/api/queues/'* &&
		"$source" == *'RABBITMQ_MONITOR_PASSWORD'* &&
		"$source" == *'billing-route-env-sync'* &&
		"$source" == *'localCandidateSha256'* &&
		"$source" == *'billing_cutover_gateway_routes_are_legacy'* &&
		"$source" == *'backend-env-with-billing-routes.candidate'* &&
		"$source" == *'winwidget-integration-worker'* &&
		"$source" == *'winwidget-billing-worker'* &&
		"$source" == *'core_integration_post_billing_read_pattern'* &&
		"$source" == *'list_user_permissions'* &&
		"$source" != *"$forbidden_business_publish"* &&
		"$source" != *"$forbidden_env_replace"* &&
		"$source" == *'notification.subscription-expiry'* &&
		"$source" == *'BILLING_DRAIN_SECONDS'* &&
		"$source" == *'20260811000000_prepare_billing_service_ownership'* &&
		"$source" == *'billing-source'* &&
		"$source" == *'providerOperationsInFlight'* &&
		"$source" == *'billing-backup-restore-rehearsal.sh'* &&
		"$source" == *'winwidget-billing-pre-restore-'* &&
		"$source" == *'winwidget-billing-post-restore-'* &&
		"$source" == *'winwidget-billing-pre-offsite-'* &&
		"$source" == *'winwidget-billing-post-offsite-'* &&
		"$source" == *'billing_database_require_pinned_candidate_images'* &&
		"$source" == *'BILLING_DEPLOY_SKIP_BUILD=true'* &&
		"$source" == *'ABORT BILLING CUTOVER'* &&
		"$source" == *'STAGE BILLING CLEANUP REVISION'* ]] || return 1
	[[ "$permission_source" == *'rabbitmqctl set_permissions'* &&
		"$permission_source" == *'list_user_permissions'* &&
		"$permission_source" != *'change_password'* &&
		"$permission_source" != *'clear_permissions'* &&
		"$permission_source" != *'RABBITMQ_PROVISION_PASSWORD'* ]] || return 1
	[[ "$restore_gate_source" == *'billing_cutover_validate_actual_restore_evidence'* &&
		"$restore_gate_source" == *'billing_cutover_import_offsite_receipt'* &&
		"$restore_gate_source" == *'pre-backups-created'* &&
		"$restore_gate_source" == *'post-backup-created'* &&
		"$restore_gate_source" == *'pending'* ]] || return 1
	[[ "$synthetic_source" == *'--phase synthetic'* &&
		"$synthetic_source" == *'runnerRevision'* &&
		"$synthetic_source" == *'runnerSha256'* &&
		"$synthetic_source" == *'EXPECTED_RUNNER_SHA'* &&
		"$synthetic_source" == *'.billing-restore-drill-evidence-v1.json'* ]] ||
		return 1
	[[ "$reconcile_source" == *'route_evidence_sha256'* &&
		"$reconcile_source" == *'billing_database_write_marker'* ]] || return 1
	[[ "$initialize_source" == *'billing_cutover_archive_aborted_generation "$generation"'* ]] ||
		return 1
	[[ "$cleanup_stage_source" == *'Billing cleanup revision is immutable once it has been staged.'* &&
		"$cleanup_stage_source" == *"acquire_production_deploy_lock 'Billing cleanup revision staging'"* ]] ||
		return 1
	[[ "$active_runtime_source" == *'billing_deploy_verify_service billing-scheduler scheduler 4801'* &&
		"$active_runtime_source" == *'billing_cutover_validate_route_env_sync'* &&
		"$active_runtime_source" == *'billing_cutover_wait_gateway'* &&
		"$active_runtime_source" == *'billing_cutover_gateway_routes_are_desired'* &&
		"$active_runtime_source" == *'billing_route_env_sync_evidence'* &&
		"$active_runtime_source" == *'billing_cutover_compare_error_contracts'* &&
		"$active_runtime_source" == *'billing_cutover_wait_auto_renewal_ownership 1'* ]] ||
		return 1
	printf '%s' "$abort_source" | node -e '
const fs = require("node:fs");
const source = fs.readFileSync(0, "utf8");
const ordered = [
  "billing_cutover_run_core_cli status",
  "billing_cutover_core_ownership",
  "core_ownership\" == '\''CORE'\''",
  "billing_cutover_require_abort_route_state",
  "billing_cutover_run_core_cli abort",
];
let cursor = -1;
for (const needle of ordered) {
  const next = source.indexOf(needle, cursor + 1);
  if (next < 0 || next <= cursor) process.exit(1);
  cursor = next;
}
for (const required of [
  "billing-route-env-rollback-sync",
  "billing_cutover_gateway_routes_are_legacy",
  "billing_route_env_legacy_snapshot",
  "billing_route_env_sync_evidence",
]) if (!source.includes(required)) process.exit(1);
'
	[[ "$recovery_source" == *'forward-only | active | post-backup-created | post-restore-verified'* ]] ||
		return 1
	printf '%s' "$rollout_source" | node -e '
const fs = require("node:fs");
const source = fs.readFileSync(0, "utf8");
const ordered = needles => {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    if (next < 0 || next <= cursor) process.exit(1);
    cursor = next;
  }
};
ordered([
  "phase=\"$(billing_database_current_phase)\"",
  "Billing prepare is not allowed from phase=",
  "billing_cutover_build_candidate_images",
  "billing_cutover_ensure_restore_drill",
  "billing_database_prepare",
  "billing_cutover_provision_rabbit",
  "deploy-billing-production.sh",
  "billing_cutover_verify_dark_source_topology",
  "billing_cutover_install_core_expand_migration",
  "billing_cutover_run_core_cli prepare",
]);
ordered([
  "billing_cutover_wait_core_outbox global",
  "docker stop --time 30",
  "--profile migration run --rm -T --no-deps migrate",
  "up -d --no-deps --no-build --force-recreate outbox-publisher",
  "billing_cutover_wait_core_outbox billing-source",
]);
if (source.includes("run --rm -T --no-deps --no-build")) process.exit(1);
for (const required of [
  "pending)",
  "docker start",
  "applied)",
  "candidate-started",
  "publisher remains fail-closed",
]) if (!source.includes(required)) process.exit(1);
'
	printf '%s' "$handoff_source" | node -e '
const fs = require("node:fs");
const source = fs.readFileSync(0, "utf8");
const ordered = needles => {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    if (next < 0 || next <= cursor) process.exit(1);
    cursor = next;
  }
};
ordered([
  "billing_cutover_gateway_routes_are_legacy",
  "billing_cutover_start_dark_source_worker",
  "billing_cutover_stop_source_worker_for_snapshot",
  "billing_cutover_run_core_snapshot_export",
  "billing_cutover_run_billing_snapshot_cli import-frozen",
  "billing_cutover_run_billing_snapshot_cli verify-import",
  "billing_cutover_start_dark_source_worker",
  "billing_cutover_wait_core_outbox billing-source",
  "billing_cutover_create_pre_backups",
  "billing_cutover_update_phase pre-backups-created",
  "billing_cutover_require_actual_restore_gate pre-cutover",
  "billing_cutover_update_phase pre-restore-verified",
  "billing_cutover_run_billing_cli seed-core-read-events",
]);
ordered([
  "winwidget-integration-worker",
  "billing_cutover_run_core_cli activate",
  "billing_auto_renewal_detached_evidence",
  "billing_cutover_restrict_core_integration_permissions",
  "billing_cutover_run_billing_cli activate",
  "deploy-billing-production.sh",
  "winwidget-billing-worker",
  "billing_cutover_validate_route_env_sync",
  "force-recreate api-gateway",
  "billing_cutover_gateway_routes_are_desired",
]);
ordered([
  "billing_cutover_require_active_runtime",
  "billing_cutover_create_backup BILLING_BACKUP_URL billing",
  "billing_cutover_update_phase post-backup-created",
  "billing_cutover_require_actual_restore_gate post-ownership",
  "billing_cutover_update_phase post-restore-verified",
  "billing_cutover_run_billing_cli complete",
  "billing_cutover_update_phase complete",
]);
'
	(
		local marker_sha route_sha image_sha
		marker_sha="$(printf 'a%.0s' {1..64})"
		route_sha="$(printf 'b%.0s' {1..64})"
		image_sha="sha256:$(printf 'c%.0s' {1..64})"
		billing_database_marker_value() {
			case "$1" in
			cleanup_revision) printf 'pending\n' ;;
			database_id) printf '11111111-1111-4111-8111-111111111111\n' ;;
			database_system_identifier) printf '123456789\n' ;;
			database_volume) printf 'winwidget-billing-postgres-data\n' ;;
			postgres_image_id | core_image_id | billing_image_id)
				printf '%s\n' "$image_sha"
				;;
			switch_generation) printf '1\n' ;;
			*) printf '%s\n' "$marker_sha" ;;
			esac
		}
		billing_cutover_marker_value() {
			case "$1" in
			generation) printf '1\n' ;;
			*) printf '%s\n' "$marker_sha" ;;
			esac
		}
		billing_database_current_phase() { printf 'forward-only\n'; }
		billing_database_transition_allowed() { return 0; }
		billing_database_write_marker() {
			[[ $# -eq 21 && "$1" == 'active' && "${20}" == "$route_sha" ]]
		}
		billing_cutover_write_marker() {
			[[ $# -eq 14 && "$1" == 'active' && "${10}" == "$route_sha" ]]
		}
		billing_cutover_update_phase active "$marker_sha" "$marker_sha" \
			"$route_sha"
	) || return 1
	(
		local requested other database_cleanup_value cutover_cleanup_value
		requested="$(printf 'd%.0s' {1..40})"
		other="$(printf 'e%.0s' {1..40})"
		database_cleanup_value='pending'
		cutover_cleanup_value='pending'
		billing_release_validate_revision() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
		billing_database_marker_value() {
			[[ "$1" == 'cleanup_revision' ]] || return 1
			printf '%s\n' "$database_cleanup_value"
		}
		billing_cutover_marker_value() {
			[[ "$1" == 'cleanup_revision' ]] || return 1
			printf '%s\n' "$cutover_cleanup_value"
		}
		billing_cutover_fail() { return 1; }
		billing_cutover_require_cleanup_revision_stage "$requested"
		database_cleanup_value="$requested"
		cutover_cleanup_value="$requested"
		billing_cutover_require_cleanup_revision_stage "$requested"
		database_cleanup_value="$other"
		cutover_cleanup_value="$other"
		if billing_cutover_require_cleanup_revision_stage "$requested"; then
			return 1
		fi
		database_cleanup_value='pending'
		cutover_cleanup_value="$requested"
		if billing_cutover_require_cleanup_revision_stage "$requested"; then
			return 1
		fi
	) || return 1
	(
		local revision cleanup database_cleanup_value cutover_cleanup_value
		local marker_sha image_sha repaired_cleanup=''
		revision="$(printf 'a%.0s' {1..40})"
		cleanup="$(printf 'b%.0s' {1..40})"
		marker_sha="$(printf 'c%.0s' {1..64})"
		image_sha="sha256:$(printf 'd%.0s' {1..64})"
		EXPECTED_REVISION="$revision"
		database_cleanup_value="$cleanup"
		cutover_cleanup_value='pending'
		billing_database_current_phase() { printf 'complete\n'; }
		billing_cutover_validate_marker() { return 0; }
		billing_cutover_marker_value() {
			case "$1" in
			phase) printf 'complete\n' ;;
			revision) printf '%s\n' "$revision" ;;
			cleanup_revision) printf '%s\n' "$cutover_cleanup_value" ;;
			generation) printf '1\n' ;;
			database_id) printf '11111111-1111-4111-8111-111111111111\n' ;;
			core_image_id | billing_image_id) printf '%s\n' "$image_sha" ;;
			*) printf '%s\n' "$marker_sha" ;;
			esac
		}
		billing_database_marker_value() {
			case "$1" in
			cleanup_revision) printf '%s\n' "$database_cleanup_value" ;;
			switch_generation) printf '1\n' ;;
			database_id) printf '11111111-1111-4111-8111-111111111111\n' ;;
			core_image_id | billing_image_id) printf '%s\n' "$image_sha" ;;
			*) printf '%s\n' "$marker_sha" ;;
			esac
		}
		billing_cutover_write_marker() {
			[[ $# -eq 14 && "$1" == 'complete' ]]
			repaired_cleanup="$3"
		}
		billing_cutover_fail() { return 1; }
		billing_cutover_reconcile_marker
		[[ "$repaired_cleanup" == "$cleanup" ]]
		database_cleanup_value='pending'
		cutover_cleanup_value="$cleanup"
		if billing_cutover_reconcile_marker; then return 1; fi
	) || return 1
	(
		local test_root archive generation='3'
		test_root="$(mktemp -d /tmp/billing-cutover-archive-self-test.XXXXXX)"
		billing_artifact_root="$test_root/artifacts"
		billing_artifact_archive_root="$test_root/archive-root"
		billing_route_env_sync_evidence="$test_root/route.json"
		billing_route_env_rollback_evidence="$test_root/rollback.json"
		EXPECTED_REVISION="$(printf 'f%.0s' {1..40})"
		mkdir -m 700 "$billing_artifact_root"
		printf 'old-artifact\n' >"$billing_artifact_root/proof.txt"
		printf 'old-route\n' >"$billing_route_env_sync_evidence"
		printf 'old-rollback\n' >"$billing_route_env_rollback_evidence"
		billing_cutover_marker_value() {
			case "$1" in
			phase) printf 'aborted\n' ;;
			revision) printf '%s\n' "$EXPECTED_REVISION" ;;
			generation) printf '%s\n' "$generation" ;;
			*) return 1 ;;
			esac
		}
		billing_cutover_validate_private_directory() {
			[[ -d "$1" && ! -L "$1" ]]
		}
		billing_cutover_ensure_private_directory() {
			[[ -e "$1" || -L "$1" ]] || mkdir -m 700 "$1"
			billing_cutover_validate_private_directory "$1"
		}
		billing_cutover_validate_evidence_file() {
			[[ -f "$1" && ! -L "$1" && -s "$1" ]]
		}
		billing_cutover_require_artifact_root() {
			billing_cutover_ensure_private_directory "$billing_artifact_root"
		}
		billing_cutover_fail() { return 1; }
		billing_cutover_archive_aborted_generation "$generation" >/dev/null
		archive="$billing_artifact_archive_root/revision-${EXPECTED_REVISION}-generation-${generation}-aborted"
		[[ "$(<"$archive/artifacts/proof.txt")" == 'old-artifact' &&
			"$(<"$archive/route-env-sync.json")" == 'old-route' &&
			"$(<"$archive/route-env-rollback-sync.json")" == 'old-rollback' ]]
		billing_cutover_directory_is_empty "$billing_artifact_root"
		billing_cutover_archive_aborted_generation "$generation" >/dev/null
		printf 'fresh-collision\n' >"$billing_artifact_root/collision.txt"
		if billing_cutover_archive_aborted_generation "$generation" >/dev/null 2>&1; then
			return 1
		fi
		[[ "$(<"$billing_artifact_root/collision.txt")" == 'fresh-collision' &&
			"$(<"$archive/artifacts/proof.txt")" == 'old-artifact' ]]
		rm -f -- "$billing_artifact_root/collision.txt" \
			"$archive/artifacts/proof.txt" "$archive/route-env-sync.json" \
			"$archive/route-env-rollback-sync.json"
		rmdir -- "$billing_artifact_root" "$archive/artifacts" "$archive" \
			"$billing_artifact_archive_root" "$test_root"
	) || return 1
	billing_cutover_actual_restore_validator_self_test || return 1
	billing_cutover_route_rollback_self_test || return 1
	billing_cutover_partial_recovery_self_test || return 1
	billing_cutover_reprepare_identity_self_test || return 1
	printf 'billing_cutover_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--prepare) billing_cutover_prepare ;;
	--cutover) billing_cutover_run ;;
	--abort) billing_cutover_abort ;;
	--forward-recovery) billing_cutover_forward_recovery ;;
	--stage-cleanup-revision)
		[[ $# -eq 2 ]] || billing_cutover_fail 'Cleanup SHA argument is required.'
		billing_cutover_stage_cleanup_revision "$2"
		;;
	--status) billing_cutover_status ;;
	--self-test) billing_cutover_self_test ;;
	*) billing_cutover_fail \
		'Usage: billing-cutover-production.sh --prepare|--cutover|--abort|--forward-recovery|--stage-cleanup-revision SHA|--status|--self-test' ;;
	esac
fi
