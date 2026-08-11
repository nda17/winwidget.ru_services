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
billing_route_env_candidate="$billing_artifact_root/backend-env-with-billing-routes.candidate"
billing_route_env_sync_evidence="$APP_ROOT/deploy/backend/.billing-route-env-sync-v1.json"
billing_pre_backup_manifest="$billing_artifact_root/pre-cutover-backups.json"
billing_core_backup="$billing_artifact_root/core-pre-billing-cutover.dump"
billing_service_backup="$billing_artifact_root/billing-pre-ownership.dump"
billing_post_backup="$billing_artifact_root/billing-post-ownership.dump"
billing_legacy_error_contract="$billing_artifact_root/legacy-error-contract.json"
billing_direct_error_contract="$billing_artifact_root/billing-error-contract.json"
billing_gateway_error_contract="$billing_artifact_root/gateway-error-contract.json"
billing_auto_renewal_core_evidence="$billing_artifact_root/auto-renewal-core-owner.json"
billing_auto_renewal_detached_evidence="$billing_artifact_root/auto-renewal-detached.json"
billing_auto_renewal_billing_evidence="$billing_artifact_root/auto-renewal-billing-owner.json"
billing_cutover_active_stage=''
billing_cutover_publisher_recovery_active='false'
billing_cutover_legacy_publisher_id=''

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

billing_cutover_require_artifact_root() {
	if [[ ! -e "$billing_artifact_root" && ! -L "$billing_artifact_root" ]]; then
		mkdir -m 700 "$billing_artifact_root"
		chown 0:0 "$billing_artifact_root"
	fi
	[[ -d "$billing_artifact_root" && ! -L "$billing_artifact_root" &&
		"$(stat -c '%u:%g:%a' "$billing_artifact_root")" == '0:0:700' ]] ||
		billing_cutover_fail \
			'Billing cutover evidence directory must be root-owned mode 700.'
}

billing_cutover_validate_evidence_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" &&
		"$(stat -c '%u:%g:%a' "$1")" == '0:0:600' && -s "$1" ]] ||
		billing_cutover_fail "Billing evidence file is unsafe or empty: $1"
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
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 !~ /^(version|phase|revision|cleanup_revision|generation|database_id|snapshot_sha256|projection_sha256|route_sha256|updated_at)$/) invalid = 1
		}
		END {
			for (key in count) if (count[key] != 1) invalid = 1
			if (NR != 10 || value["version"] != "1" ||
				value["phase"] !~ /^(prepared|source-frozen|imported|projection-synced|forward-only|active|complete|aborted)$/ ||
				!hex(value["revision"], 40) ||
				!(value["cleanup_revision"] == "pending" || hex(value["cleanup_revision"], 40)) ||
				value["generation"] !~ /^[1-9][0-9]*$/ ||
				value["database_id"] !~ /^[0-9a-f-]{36}$/ ||
				!(value["snapshot_sha256"] == "pending" || hex(value["snapshot_sha256"], 64)) ||
				!(value["projection_sha256"] == "pending" || hex(value["projection_sha256"], 64)) ||
				!(value["route_sha256"] == "pending" || hex(value["route_sha256"], 64)) ||
				length(value["updated_at"]) != 20) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$billing_cutover_marker"
}

billing_cutover_write_marker() {
	[[ $# -eq 8 ]] || return 1
	local temporary="$APP_ROOT/deploy/backend/.billing-cutover-v1.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	(umask 077; {
		printf 'version=1\n'
		printf 'phase=%s\n' "$1"
		printf 'revision=%s\n' "$2"
		printf 'cleanup_revision=%s\n' "$3"
		printf 'generation=%s\n' "$4"
		printf 'database_id=%s\n' "$5"
		printf 'snapshot_sha256=%s\n' "$6"
		printf 'projection_sha256=%s\n' "$7"
		printf 'route_sha256=%s\n' "$8"
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
	phase="$(billing_database_current_phase)" || return 1
	[[ "$phase" != 'forward-only' ||
		"${BILLING_FIRST_CUTOVER_APPROVED:-false}" == 'true' ]] ||
		billing_cutover_fail 'Forward recovery remains manual-only.'
}

billing_cutover_validate_restore_drill() {
	local evidence
	evidence="$(billing_read_env_value "$ENV_FILE" BILLING_RESTORE_DRILL_EVIDENCE_FILE)"
	[[ "$evidence" == /* ]] || return 1
	billing_cutover_validate_evidence_file "$evidence" || return 1
	EXPECTED_REVISION="$EXPECTED_REVISION" node - "$evidence" <<'NODE'
const fs = require('node:fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  document.target !== 'billing' ||
  document.status !== 'passed' ||
  document.postgresMajor !== 18 ||
  document.revision !== process.env.EXPECTED_REVISION ||
  !/^[0-9a-f]{64}$/.test(document.dumpSha256 || '')
) process.exit(1);
NODE
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

billing_cutover_build_candidate_images() {
	local core_image billing_image core_id core_revision core_user
	core_image="winwidget-api:git-$EXPECTED_REVISION"
	billing_image="$(billing_release_identity_value BILLING_IMAGE "$EXPECTED_REVISION")"
	billing_compose_config_all_profiles "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE"
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull --provenance=false api billing-api
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
		--profile migration run --rm -T --no-deps --no-build \
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
		--profile migration run --rm -T --no-deps --no-build \
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
		--profile migration run --rm -T --no-deps --no-build migrate
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
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
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

billing_cutover_create_pre_backups() {
	local core_sha billing_sha temporary
	billing_cutover_create_backup DATABASE_BACKUP_URL public \
		"$billing_core_backup" core
	billing_cutover_create_backup BILLING_BACKUP_URL billing \
		"$billing_service_backup" billing
	core_sha="$(billing_cutover_sha256 "$billing_core_backup")"
	billing_sha="$(billing_cutover_sha256 "$billing_service_backup")"
	temporary="$billing_pre_backup_manifest.$$"
	(umask 077; {
		printf '{"version":1,"revision":"%s","generation":%s,' \
			"$EXPECTED_REVISION" "$(billing_cutover_marker_value generation)"
		printf '"coreDumpSha256":"%s","billingDumpSha256":"%s"}\n' \
			"$core_sha" "$billing_sha"
	} >"$temporary")
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$billing_pre_backup_manifest"
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

billing_cutover_write_route_manifest() {
	local temporary_env="$billing_route_env_candidate.$$"
	local temporary_manifest="$billing_route_manifest.$$"
	[[ ! -e "$temporary_env" && ! -L "$temporary_env" &&
		! -e "$temporary_manifest" && ! -L "$temporary_manifest" ]] || return 1
	node - "$ENV_FILE" "$temporary_env" "$temporary_manifest" <<'NODE'
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
	mv -f "$temporary_manifest" "$billing_route_manifest"
	mv -f "$temporary_env" "$billing_route_env_candidate"
	[[ "$(stat -c '%u:%g:%a' "$billing_route_env_candidate")" == \
		'0:0:600' ]] || return 1
	billing_cutover_validate_evidence_file "$billing_route_manifest"
	billing_compose_config_all_profiles "$EXPECTED_REVISION" \
		"$billing_route_env_candidate" "$COMPOSE_FILE"
	printf 'billing_route_env_candidate_sha256=%s\n' \
		"$(billing_cutover_sha256 "$billing_route_env_candidate")"
}

billing_cutover_routes_are_legacy() {
	local routes
	routes="$(billing_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
	printf '%s\n' "$routes" | node -e '
const fs = require("node:fs");
const routes = JSON.parse(fs.readFileSync(0, "utf8"));
const prefixes = ["/api/v1/payments", "/api/v1/subscriptions", "/api/v1/tariff-prices", "/api/v1/affiliate"];
if (!Array.isArray(routes) || prefixes.some(prefix => routes.some(route => route.pathPrefix === prefix))) process.exit(1);
if (!routes.some(route => route.pathPrefix === "/api/v1" && route.upstreamUrl === "http://127.0.0.1:4200")) process.exit(1);
'
}

billing_cutover_routes_are_desired() {
	local routes
	routes="$(billing_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
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

billing_cutover_validate_route_env_sync() {
	billing_cutover_validate_evidence_file "$billing_route_env_candidate" || return 1
	billing_cutover_validate_evidence_file "$billing_route_manifest" || return 1
	billing_cutover_validate_evidence_file "$billing_route_env_sync_evidence" || return 1
	billing_cutover_routes_are_desired || return 1
	local current_sha candidate_sha manifest_sha
	current_sha="$(billing_cutover_sha256 "$ENV_FILE")"
	candidate_sha="$(billing_cutover_sha256 "$billing_route_env_candidate")"
	manifest_sha="$(billing_cutover_sha256 "$billing_route_manifest")"
	[[ "$current_sha" == "$candidate_sha" ]] ||
		billing_cutover_fail \
			'Production Billing route env differs from the staged full-file candidate.' || return 1
	EXPECTED_REVISION="$EXPECTED_REVISION" \
	EXPECTED_GENERATION="$(billing_cutover_marker_value generation)" \
	EXPECTED_ENV_SHA="$current_sha" EXPECTED_MANIFEST_SHA="$manifest_sha" \
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
  evidence.localSourceSha256 !== evidence.serverSourceSha256 ||
  evidence.localCandidateSha256 !== process.env.EXPECTED_ENV_SHA ||
  evidence.uploadedServerSha256 !== process.env.EXPECTED_ENV_SHA ||
  evidence.roundTripLocalSha256 !== process.env.EXPECTED_ENV_SHA ||
  evidence.routeManifestSha256 !== process.env.EXPECTED_MANIFEST_SHA ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(evidence.observedAt || '')
) process.exit(1);
NODE
	billing_compose_config_all_profiles "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE"
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

billing_cutover_update_phase() {
	[[ $# -eq 4 ]] || return 1
	local phase="$1" snapshot_sha="$2" projection_sha="$3" route_sha="$4"
	local cleanup_revision generation database_id pre_backup_sha post_backup_sha
	local restore_evidence restore_sha
	cleanup_revision="$(billing_database_marker_value cleanup_revision)"
	generation="$(billing_cutover_marker_value generation)"
	database_id="$(billing_database_marker_value database_id)"
	pre_backup_sha="$(billing_database_marker_value pre_backup_sha256)"
	post_backup_sha="$(billing_database_marker_value post_backup_sha256)"
	if [[ -f "$billing_pre_backup_manifest" && ! -L "$billing_pre_backup_manifest" ]]; then
		pre_backup_sha="$(billing_cutover_sha256 "$billing_pre_backup_manifest")"
	fi
	if [[ -f "$billing_post_backup" && ! -L "$billing_post_backup" ]]; then
		post_backup_sha="$(billing_cutover_sha256 "$billing_post_backup")"
	fi
	restore_evidence="$(billing_read_env_value "$ENV_FILE" \
		BILLING_RESTORE_DRILL_EVIDENCE_FILE)"
	restore_sha="$(billing_cutover_sha256 "$restore_evidence")"
	billing_database_transition_allowed \
		"$(billing_database_current_phase)" "$phase" ||
		billing_cutover_fail \
			"Invalid Billing lifecycle phase transition to $phase." || return 1
	billing_database_write_marker "$phase" "$EXPECTED_REVISION" \
		"$cleanup_revision" "$database_id" \
		"$(billing_database_marker_value database_system_identifier)" \
		"$(billing_database_marker_value database_volume)" \
		"$(billing_database_marker_value postgres_image_id)" \
		"$generation" "$snapshot_sha" "$pre_backup_sha" "$post_backup_sha" \
		"$restore_sha" "$projection_sha" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	billing_cutover_write_marker "$phase" "$EXPECTED_REVISION" \
		"$cleanup_revision" "$generation" "$database_id" "$snapshot_sha" \
		"$projection_sha" "$route_sha"
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
		[[ "$(billing_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
			"$(billing_cutover_marker_value database_id)" == "$database_id" ]] ||
			billing_cutover_fail 'Existing Billing marker identity changed.' || return 1
		generation="$(billing_cutover_marker_value generation)"
		if [[ "$marker_phase" == 'aborted' ]]; then
			generation="$((generation + 1))"
		fi
		billing_cutover_write_marker prepared "$EXPECTED_REVISION" \
			"$(billing_cutover_marker_value cleanup_revision)" \
			"$generation" "$database_id" \
			pending pending pending
	else
		billing_cutover_write_marker prepared "$EXPECTED_REVISION" pending 1 \
			"$database_id" pending pending pending
	fi
	billing_cutover_update_phase prepared pending pending pending
}

billing_cutover_reconcile_marker() {
	local database_phase cutover_phase
	database_phase="$(billing_database_current_phase)" || return 1
	[[ "$database_phase" != 'absent' ]] || return 1
	billing_cutover_validate_marker || return 1
	[[ "$(billing_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(billing_cutover_marker_value database_id)" == \
		"$(billing_database_marker_value database_id)" &&
		"$(billing_cutover_marker_value generation)" == \
		"$(billing_database_marker_value switch_generation)" ]] ||
		billing_cutover_fail 'Billing lifecycle and cutover marker identities differ.' ||
		return 1
	cutover_phase="$(billing_cutover_marker_value phase)"
	if [[ "$cutover_phase" != "$database_phase" ]]; then
		billing_cutover_write_marker "$database_phase" "$EXPECTED_REVISION" \
			"$(billing_database_marker_value cleanup_revision)" \
			"$(billing_database_marker_value switch_generation)" \
			"$(billing_database_marker_value database_id)" \
			"$(billing_database_marker_value snapshot_sha256)" \
			"$(billing_database_marker_value projection_evidence_sha256)" \
			"$(billing_cutover_marker_value route_sha256)"
	fi
}

billing_cutover_prepare() {
	local phase generation
	billing_cutover_require_environment
	billing_cutover_validate_restore_drill ||
		billing_cutover_fail 'Billing PG18 restore-drill evidence is invalid.' || return 1
	acquire_production_deploy_lock 'Billing cutover prepare'
	billing_cutover_build_candidate_images
	phase="$(billing_database_current_phase)"
	case "$phase" in
	absent | aborted | preparing | prepared) billing_database_prepare ;;
	*) billing_cutover_fail "Billing prepare is not allowed from phase=$phase." || return 1 ;;
	esac
	billing_cutover_provision_rabbit
	env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
		EXPECTED_REVISION="$EXPECTED_REVISION" BILLING_DEPLOY_SKIP_BUILD=true \
		bash "$server_root/scripts/deploy-billing-production.sh" --deploy
	billing_cutover_verify_dark_source_topology
	billing_cutover_install_core_expand_migration
	billing_cutover_require_artifact_root
	billing_cutover_initialize_marker
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
	billing_cutover_routes_are_legacy ||
		billing_cutover_fail \
			'Billing route env must remain legacy while staging the synced candidate.' ||
		return 1
	billing_cutover_write_route_manifest
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
	generation="$(billing_cutover_marker_value generation)"
	phase="$(billing_database_current_phase)"
	if [[ "$phase" == 'prepared' ]]; then
		billing_cutover_validate_route_env_sync ||
			billing_cutover_fail \
				'Billing route env two-copy sync evidence is missing or invalid.' || return 1
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
		billing_cutover_create_pre_backups
		snapshot_sha="$(billing_cutover_sha256 "$billing_snapshot_file")"
		billing_cutover_update_phase imported "$snapshot_sha" pending pending
		phase='imported'
	fi
	if [[ "$phase" == 'imported' ]]; then
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
			EXPECTED_REVISION="$EXPECTED_REVISION" \
			bash "$server_root/scripts/deploy-billing-production.sh" --deploy
		billing_cutover_wait_auto_renewal_ownership 1 \
			winwidget-billing-worker winwidget-billing-worker billing-owner \
			"$billing_auto_renewal_billing_evidence" "$handoff_redeliver"
		billing_cutover_validate_route_env_sync
		route_sha="$(billing_cutover_sha256 "$billing_route_manifest")"
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate api-gateway
		billing_cutover_wait_gateway
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
		billing_cutover_run_billing_cli complete "$billing_completion_evidence" \
			--revision "$EXPECTED_REVISION" --generation "$generation"
		billing_cutover_validate_billing_transition \
			"$billing_completion_evidence" complete COMPLETE
		billing_cutover_update_phase complete \
			"$(billing_database_marker_value snapshot_sha256)" \
			"$(billing_database_marker_value projection_evidence_sha256)" \
			"$(billing_cutover_marker_value route_sha256)"
	fi
	printf 'billing_cutover_phase=%s\n' "$(billing_database_current_phase)"
}

billing_cutover_abort() {
	local phase generation
	billing_cutover_require_environment
	[[ "${BILLING_ABORT_CONFIRMATION:-}" == 'ABORT BILLING CUTOVER' ]] ||
		billing_cutover_fail 'Billing abort requires the exact manual confirmation.' ||
		return 1
	acquire_production_deploy_lock 'Billing cutover abort'
	billing_cutover_reconcile_marker
	phase="$(billing_database_current_phase)"
	case "$phase" in
	prepared | source-frozen | imported | projection-synced) ;;
	*) billing_cutover_fail \
		"Billing abort is forbidden from phase=$phase." || return 1 ;;
	esac
	billing_cutover_routes_are_legacy ||
		billing_cutover_fail 'Billing abort is forbidden after the route switch.' ||
		return 1
	generation="$(billing_cutover_marker_value generation)"
	billing_cutover_run_core_cli abort "$billing_core_abort_evidence" \
		--revision "$EXPECTED_REVISION" --generation "$generation"
	billing_cutover_validate_core_abort_state "$billing_core_abort_evidence"
	billing_database_abort
	billing_cutover_write_marker aborted "$EXPECTED_REVISION" \
		"$(billing_database_marker_value cleanup_revision)" "$generation" \
		"$(billing_database_marker_value database_id)" \
		"$(billing_database_marker_value snapshot_sha256)" \
		"$(billing_database_marker_value projection_evidence_sha256)" pending
	printf 'billing_cutover_phase=aborted\n'
}

billing_cutover_forward_recovery() {
	local phase
	billing_cutover_require_environment
	billing_cutover_reconcile_marker
	phase="$(billing_database_current_phase)"
	case "$phase" in
	forward-only | active) billing_cutover_run ;;
	*) billing_cutover_fail \
		"Forward recovery requires phase=forward-only|active; phase=$phase." ;;
	esac
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
	billing_cutover_reconcile_marker
	[[ "$(billing_database_current_phase)" == 'complete' &&
		"$cleanup_revision" != "$EXPECTED_REVISION" ]] ||
		billing_cutover_fail \
			'Cleanup revision can be staged only after complete and must be SHA B.' ||
		return 1
	acquire_production_deploy_lock 'Billing cleanup revision staging'
	billing_database_write_marker complete "$EXPECTED_REVISION" \
		"$cleanup_revision" "$(billing_database_marker_value database_id)" \
		"$(billing_database_marker_value database_system_identifier)" \
		"$(billing_database_marker_value database_volume)" \
		"$(billing_database_marker_value postgres_image_id)" \
		"$(billing_database_marker_value switch_generation)" \
		"$(billing_database_marker_value snapshot_sha256)" \
		"$(billing_database_marker_value pre_backup_sha256)" \
		"$(billing_database_marker_value post_backup_sha256)" \
		"$(billing_database_marker_value restore_evidence_sha256)" \
		"$(billing_database_marker_value projection_evidence_sha256)" \
		"$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	billing_cutover_write_marker complete "$EXPECTED_REVISION" \
		"$cleanup_revision" "$(billing_cutover_marker_value generation)" \
		"$(billing_cutover_marker_value database_id)" \
		"$(billing_cutover_marker_value snapshot_sha256)" \
		"$(billing_cutover_marker_value projection_sha256)" \
		"$(billing_cutover_marker_value route_sha256)"
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

billing_cutover_self_test() {
	local source forbidden_business_publish
	local forbidden_env_replace rollout_source handoff_source permission_source
	source="$(<"$server_root/scripts/billing-cutover-production.sh")"
	rollout_source="$(declare -f billing_cutover_prepare \
		billing_cutover_install_core_expand_migration \
		billing_cutover_recover_core_publisher)"
	handoff_source="$(declare -f billing_cutover_run)"
	permission_source="$(declare -f \
		billing_cutover_restrict_core_integration_permissions)"
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
		"$source" == *'ABORT BILLING CUTOVER'* &&
		"$source" == *'STAGE BILLING CLEANUP REVISION'* ]] || return 1
	[[ "$permission_source" == *'rabbitmqctl set_permissions'* &&
		"$permission_source" == *'list_user_permissions'* &&
		"$permission_source" != *'change_password'* &&
		"$permission_source" != *'clear_permissions'* &&
		"$permission_source" != *'RABBITMQ_PROVISION_PASSWORD'* ]] || return 1
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
  "billing_cutover_build_candidate_images",
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
  "--profile migration run --rm -T --no-deps --no-build migrate",
  "up -d --no-deps --no-build --force-recreate outbox-publisher",
  "billing_cutover_wait_core_outbox billing-source",
]);
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
  "billing_cutover_start_dark_source_worker",
  "billing_cutover_stop_source_worker_for_snapshot",
  "billing_cutover_run_core_snapshot_export",
  "billing_cutover_run_billing_snapshot_cli import-frozen",
  "billing_cutover_run_billing_snapshot_cli verify-import",
  "billing_cutover_start_dark_source_worker",
  "billing_cutover_wait_core_outbox billing-source",
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
]);
'
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
