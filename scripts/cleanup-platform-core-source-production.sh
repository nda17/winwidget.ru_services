#!/usr/bin/env bash

# Forward-only removal of the frozen Platform source from Core. This script is
# intentionally not wired into the routine deploy workflow: the cleanup is a
# separately reviewed post-cutover action with its own immutable revision,
# evidence, off-VPS receipts and exact operator confirmation.

set -Eeuo pipefail
umask 077
export LC_ALL=C
# Sourced lifecycle scripts intentionally share EXPECTED_REVISION.
# shellcheck disable=SC2031

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION="${PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION:-}"
PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256:-}"
PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256:-}"
PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_FILE="${PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_FILE:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256:-}"
PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS="${PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS:-900}"
PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION="${PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ORIGIN="${PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ORIGIN:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE="${PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256:-}"
PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256="${PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256:-}"
platform_cleanup_marker="${PLATFORM_CORE_SOURCE_CLEANUP_MARKER:-$APP_ROOT/deploy/backend/.platform-core-source-cleanup-v1}"
platform_cleanup_evidence_parent="${PLATFORM_CORE_SOURCE_CLEANUP_EVIDENCE_ROOT:-$APP_ROOT/deploy/backend/.production-evidence/platform-core-source-cleanup}"
readonly PLATFORM_CORE_SOURCE_CLEANUP_CONFIRMATION_TEXT='DROP LEGACY PLATFORM CORE SOURCE'
readonly PLATFORM_CORE_SOURCE_CLEANUP_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly PLATFORM_CORE_SOURCE_CLEANUP_PRE_RECEIPT_PREFIX='/root/winwidget-platform-core-source-cleanup-pre-offsite'
readonly PLATFORM_CORE_SOURCE_CLEANUP_POST_RECEIPT_PREFIX='/root/winwidget-platform-core-source-cleanup-post-offsite'
readonly -a PLATFORM_CORE_SOURCE_RELATIONS=(
	public.site_settings
	public.legal_pages
	public.home_page_content
	public.platform_core_state
)
readonly -a PLATFORM_CORE_SOURCE_TRIGGERS=(
	'platform_core_state:platform_core_state_transition_guard'
	'site_settings:platform_site_settings_write_fence'
	'legal_pages:platform_legal_pages_write_fence'
	'home_page_content:platform_home_page_content_write_fence'
	'legal_pages:billing_offer_projection'
)
readonly -a PLATFORM_CORE_SOURCE_FUNCTIONS=(
	'public.platform_core_state_transition_guard()'
	'public.platform_core_source_writes_enabled()'
	'public.platform_assert_core_write_enabled()'
	'public.billing_offer_projection_trigger()'
)
readonly -a PLATFORM_CORE_RETAINED_BILLING_SEAM=(
	public.billing_core_state
	public.billing_source_aggregate_versions
	public.billing_read_projection_versions
	public.billing_subscription_read_projections
	public.billing_payment_read_projections
	public.billing_affiliate_read_projections
	public.billing_settings_read_projection
	public.billing_settings_compositions
	public.billing_source_sequence
	'public.billing_record_source_event(text,text,text,text,jsonb,boolean)'
	'public.billing_iso_timestamp(timestamp without time zone)'
)
readonly -a PLATFORM_CORE_DIRECT_ROUTES=(
	'/api/v1/site-settings'
	'/api/v1/legal-pages'
	'/api/v1/legal-pages/oferta'
	'/api/v1/home-page-content'
)
readonly -a PLATFORM_OWNER_ROUTE_CONTRACT=(
	'platform-site-settings|/api/v1/site-settings|http://127.0.0.1:5000|optional|60000'
	'platform-legal-pages|/api/v1/legal-pages|http://127.0.0.1:5000|optional|60000'
	'platform-home-page-content|/api/v1/home-page-content|http://127.0.0.1:5000|optional|60000'
)
readonly -a PLATFORM_CREDENTIALS_FORBIDDEN_IN_CORE=(
	PLATFORM_DATABASE_URL
	PLATFORM_MIGRATION_DATABASE_URL
	PLATFORM_BACKUP_URL
	PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE
	DATABASE_RESTORE_PLATFORM_ADMIN_PASSWORD_FILE
	IDENTITY_PLATFORM_TOKEN
	RABBITMQ_PLATFORM_PUBLISHER_URL
	PLATFORM_CORE_DATABASE_URL
)
readonly -a PLATFORM_CORE_RUNTIME_ROLES=(
	api
	outbox-publisher
	integration-worker
)
readonly -a PLATFORM_CLEANUP_MARKER_KEYS=(
	version phase ownership_revision cleanup_revision production_env_sha256
	compose_sha256 core_database_name core_database_system_identifier
	core_image_id billing_image_id frontend_validator_image_id
	database_restore_image_id generation migration migration_sha256
	prisma_manifest_sha256 prisma_pre_ledger_sha256 prisma_post_ledger_sha256
	first_complete_proof_sha256 snapshot_sha256 source_fingerprint
	source_high_watermark billing_offer_contract_version
	billing_offer_sequence_scope billing_offer_aggregate_version
	billing_offer_source_sequence billing_offer_fence_fingerprint
	frontend_revision frontend_origin_sha256 frontend_challenge
	frontend_attestation_sha256 frontend_signature_sha256
	frontend_public_key_sha256 frontend_evidence_sha256
	frontend_phase_evidence_chain_sha256
	topology_scan_evidence_sha256 core_pre_backup_sha256
	platform_pre_backup_sha256 pre_restore_evidence_sha256 soak_evidence_sha256
	route_evidence_sha256 queue_evidence_sha256 outbox_evidence_sha256
	pre_offsite_receipt_sha256 migration_rehearsal_evidence_sha256
	core_post_backup_sha256 post_restore_evidence_sha256
	post_offsite_receipt_sha256 completion_evidence_sha256 created_at updated_at
)
readonly -a PLATFORM_CLEANUP_NODE_ENV=(
	BASE_URL
	COMPLETED_AT
	SOAK_SECONDS
	RECEIPT_PHASE
	RECEIPT_REVISION
	RECEIPT_GENERATION
	CORE_PRE_SHA
	PLATFORM_PRE_SHA
	PRE_RESTORE_SHA
	SOAK_SHA
	ROUTE_SHA
	QUEUE_SHA
	OUTBOX_SHA
	FIRST_COMPLETE_PROOF_SHA
	MIGRATION_SHA
	PRE_RECEIPT_SHA
	POST_RECEIPT_SHA
	CORE_POST_SHA
	POST_RESTORE_SHA
	PRODUCTION_ENV_SHA
	OWNERSHIP_REVISION
	CLEANUP_REVISION
	GENERATION
	SNAPSHOT_SHA
	SOURCE_FINGERPRINT
	SOURCE_HIGH_WATERMARK
	COMPOSE_SHA
	CORE_DATABASE_NAME
	CORE_DATABASE_SYSTEM_IDENTIFIER
	BILLING_OFFER_CONTRACT_VERSION
	BILLING_OFFER_SEQUENCE_SCOPE
	BILLING_OFFER_AGGREGATE_VERSION
	BILLING_OFFER_SOURCE_SEQUENCE
	BILLING_OFFER_FENCE_FINGERPRINT
	PRISMA_MANIFEST_SHA
	PRISMA_PRE_LEDGER_SHA
	PRISMA_POST_LEDGER_SHA
	FRONTEND_REVISION
	FRONTEND_ORIGIN_SHA
	FRONTEND_CHALLENGE
	FRONTEND_ATTESTATION_SHA
	FRONTEND_SIGNATURE_SHA
	FRONTEND_PUBLIC_KEY_SHA
	FRONTEND_EVIDENCE_SHA
	FRONTEND_PHASE_CHAIN_SHA
	TOPOLOGY_SCAN_EVIDENCE_SHA
	MIGRATION_REHEARSAL_SHA
	URL_VALUE
	ROUTES_VALUE
)

platform_cleanup_fail() {
	printf 'platform_core_source_cleanup_error=%s\n' "$1" >&2
	return 1
}

platform_cleanup_sha256() {
	[[ $# -eq 1 ]] || return 1
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

platform_cleanup_load_dependencies() {
	# shellcheck source=scripts/platform-release-identity.sh
	declare -F platform_release_compose >/dev/null ||
		source "$SERVER_ROOT/scripts/platform-release-identity.sh"
	# shellcheck source=scripts/platform-database-lifecycle.sh
	declare -F platform_database_current_phase >/dev/null ||
		source "$SERVER_ROOT/scripts/platform-database-lifecycle.sh"
	# shellcheck source=scripts/platform-cutover-production.sh
	declare -F platform_cutover_current_phase >/dev/null ||
		source "$SERVER_ROOT/scripts/platform-cutover-production.sh"
	# shellcheck source=scripts/database-restore-production-guard.sh
	declare -F database_restore_guard_assert_before_mutation >/dev/null ||
		source "$SERVER_ROOT/scripts/database-restore-production-guard.sh"
	# shellcheck source=scripts/production-deploy-lock.sh
	declare -F acquire_production_deploy_lock >/dev/null ||
		source "$SERVER_ROOT/scripts/production-deploy-lock.sh"
}

platform_cleanup_node() {
	if command -v node >/dev/null 2>&1; then
		node "$@"
		return
	fi
	local image argument key
	local -a mounts=() rewritten=() environment=()
	image="$(platform_cutover_marker_value image_id)" || return 1
	[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	for argument in "$@"; do
		if [[ "$argument" == /* && -e "$argument" ]]; then
			mounts+=(--mount "type=bind,source=$argument,target=/inputs/$(basename -- "$argument"),readonly")
			rewritten+=("/inputs/$(basename -- "$argument")")
		else
			rewritten+=("$argument")
		fi
	done
	for key in "${PLATFORM_CLEANUP_NODE_ENV[@]}"; do
		if declare -p "$key" >/dev/null 2>&1; then environment+=(--env "$key"); fi
	done
	docker run --rm -i --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
		"${mounts[@]}" "${environment[@]}" --entrypoint node "$image" "${rewritten[@]}"
}

platform_cleanup_transition_allowed() {
	case "$1:$2" in
	absent:preparing | preparing:preparing | preparing:staged | \
		staged:staged | staged:sealing | sealing:sealing | sealing:sealed | \
		sealed:sealed | sealed:forward-only | forward-only:forward-only | \
		forward-only:migrating | migrating:migrating | migrating:applied | \
		applied:applied | applied:verifying | verifying:verifying | \
		verifying:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

platform_cleanup_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ ]] || return 1
	platform_cleanup_validate_marker || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$platform_cleanup_marker"
}

platform_cleanup_validate_marker() {
	[[ $# -le 1 ]] || return 1
	local marker_file="${1:-$platform_cleanup_marker}"
	[[ -f "$marker_file" && ! -L "$marker_file" ]] || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		[[ "$(stat -c '%u:%g:%a' "$marker_file")" == '0:0:600' ]] || return 1
	fi
	awk -F= -v expected="${#PLATFORM_CLEANUP_MARKER_KEYS[@]}" \
		-v expected_order="${PLATFORM_CLEANUP_MARKER_KEYS[*]}" '
		BEGIN { split(expected_order, order, " ") }
		$1 != order[NR] { exit 1 }
		$1 !~ /^(version|phase|ownership_revision|cleanup_revision|production_env_sha256|compose_sha256|core_database_name|core_database_system_identifier|core_image_id|billing_image_id|frontend_validator_image_id|database_restore_image_id|generation|migration|migration_sha256|prisma_manifest_sha256|prisma_pre_ledger_sha256|prisma_post_ledger_sha256|first_complete_proof_sha256|snapshot_sha256|source_fingerprint|source_high_watermark|billing_offer_contract_version|billing_offer_sequence_scope|billing_offer_aggregate_version|billing_offer_source_sequence|billing_offer_fence_fingerprint|frontend_revision|frontend_origin_sha256|frontend_challenge|frontend_attestation_sha256|frontend_signature_sha256|frontend_public_key_sha256|frontend_evidence_sha256|frontend_phase_evidence_chain_sha256|topology_scan_evidence_sha256|core_pre_backup_sha256|platform_pre_backup_sha256|pre_restore_evidence_sha256|soak_evidence_sha256|route_evidence_sha256|queue_evidence_sha256|outbox_evidence_sha256|pre_offsite_receipt_sha256|migration_rehearsal_evidence_sha256|core_post_backup_sha256|post_restore_evidence_sha256|post_offsite_receipt_sha256|completion_evidence_sha256|created_at|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != expected || seen["version"] != 1 || value["version"] != "2" ||
				seen["phase"] != 1 || value["phase"] !~ /^(preparing|staged|sealing|sealed|forward-only|migrating|applied|verifying|complete)$/ ||
				value["ownership_revision"] !~ /^[0-9a-f]{40}$/ ||
				value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
				value["ownership_revision"] == value["cleanup_revision"] ||
				value["core_database_name"] != "default_db" ||
				value["core_database_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				value["core_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["billing_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["frontend_validator_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["database_restore_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["generation"] !~ /^[1-9][0-9]{0,17}$/ ||
				value["migration"] !~ /^[0-9]{14}_remove_legacy_platform_core_source$/ ||
				value["source_high_watermark"] !~ /^[1-9][0-9]*$/ ||
				value["billing_offer_contract_version"] != "2" ||
				value["billing_offer_sequence_scope"] != "billing.offer:offer" ||
				value["billing_offer_aggregate_version"] !~ /^[1-9][0-9]*$/ ||
				value["billing_offer_source_sequence"] !~ /^[1-9][0-9]*$/ ||
				value["frontend_revision"] !~ /^[0-9a-f]{40}$/ ||
				value["frontend_challenge"] !~ /^[0-9a-f]{64}$/ ||
				value["created_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/ ||
				value["updated_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) exit 1
			for (key in value) if (key ~ /_sha256$/ && value[key] !~ /^(pending|[0-9a-f]{64})$/) exit 1
			for (key in value) if (key ~ /_sha256$/ && value[key] ~ /^0+$/) exit 1
			for (key in value) if (key ~ /^(production_env_sha256|compose_sha256|snapshot_sha256|source_fingerprint|migration_sha256|first_complete_proof_sha256|billing_offer_fence_fingerprint|frontend_origin_sha256|frontend_attestation_sha256|frontend_signature_sha256|frontend_public_key_sha256)$/ && value[key] !~ /^[0-9a-f]{64}$/) exit 1
			if (value["phase"] !~ /^preparing$/) {
				for (key in value) if (key ~ /^(prisma_manifest_sha256|prisma_pre_ledger_sha256|frontend_evidence_sha256|frontend_phase_evidence_chain_sha256|topology_scan_evidence_sha256|core_pre_backup_sha256|platform_pre_backup_sha256|pre_restore_evidence_sha256|soak_evidence_sha256|route_evidence_sha256|queue_evidence_sha256|outbox_evidence_sha256)$/ && value[key] !~ /^[0-9a-f]{64}$/) exit 1
			}
			if (value["phase"] ~ /^(sealed|forward-only|migrating|applied|verifying|complete)$/ &&
				(value["pre_offsite_receipt_sha256"] !~ /^[0-9a-f]{64}$/ ||
				 value["migration_rehearsal_evidence_sha256"] !~ /^[0-9a-f]{64}$/)) exit 1
			if (value["phase"] ~ /^(applied|verifying|complete)$/ &&
				(value["core_post_backup_sha256"] !~ /^[0-9a-f]{64}$/ ||
				 value["post_restore_evidence_sha256"] !~ /^[0-9a-f]{64}$/ ||
				 value["prisma_post_ledger_sha256"] !~ /^[0-9a-f]{64}$/)) exit 1
			if (value["phase"] == "complete" &&
				(value["post_offsite_receipt_sha256"] !~ /^[0-9a-f]{64}$/ ||
				 value["completion_evidence_sha256"] !~ /^[0-9a-f]{64}$/)) exit 1
		}
	' "$marker_file"
}

platform_cleanup_current_phase() {
	if [[ ! -e "$platform_cleanup_marker" && ! -L "$platform_cleanup_marker" ]]; then
		printf 'absent\n'
		return
	fi
	platform_cleanup_validate_marker || return 1
	platform_cleanup_marker_value phase
}

platform_cleanup_commit_marker_candidate() {
	[[ $# -eq 3 ]] || return 1
	local destination="$1" phase="$2" candidate="$3" current='absent' directory
	directory="$(dirname -- "$destination")"
	if [[ -e "$destination" || -L "$destination" ]]; then
		[[ "$destination" == "$platform_cleanup_marker" ]] || return 1
		current="$(platform_cleanup_current_phase)" || return 1
	fi
	platform_cleanup_transition_allowed "$current" "$phase" ||
		platform_cleanup_fail "unsafe cleanup transition: $current -> $phase" || return 1
	[[ "$candidate" == "$directory"/.platform-core-source-cleanup-v1.tmp.* &&
		-f "$candidate" && ! -L "$candidate" ]] || return 1
	chmod 600 "$candidate"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$candidate"; fi
	platform_cleanup_validate_marker "$candidate" || { rm -f -- "$candidate"; return 1; }
	sync -f "$candidate"
	mv -f -- "$candidate" "$destination"
	sync -f "$directory"
	platform_cleanup_validate_marker
}

platform_cleanup_initialize_marker() {
	[[ $# -ge 4 && $(( ($# - 2) % 2 )) -eq 0 ]] || return 1
	local destination="$1" phase="$2" key value now directory candidate index update_count=0
	local -a update_keys=() update_values=()
	shift 2
	directory="$(dirname -- "$destination")"
	[[ -d "$directory" && ! -L "$directory" ]] || return 1
	while (( $# > 0 )); do
		key="$1"; value="$2"; shift 2
		[[ " ${PLATFORM_CLEANUP_MARKER_KEYS[*]} " == *" $key "* && -n "$value" &&
			"$value" != *$'\n'* && "$value" != *=* ]] || return 1
		for ((index = 0; index < update_count; index++)); do [[ "${update_keys[$index]}" != "$key" ]] || return 1; done
		update_keys[$update_count]="$key"; update_values[$update_count]="$value"; ((update_count += 1))
	done
	now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	candidate="$(mktemp "$directory/.platform-core-source-cleanup-v1.tmp.XXXXXX")" || return 1
	for key in "${PLATFORM_CLEANUP_MARKER_KEYS[@]}"; do
		case "$key" in version) value=2 ;; phase) value="$phase" ;; created_at | updated_at) value="$now" ;; *) value=pending ;; esac
		for ((index = 0; index < update_count; index++)); do
			if [[ "${update_keys[$index]}" == "$key" ]]; then value="${update_values[$index]}"; break; fi
		done
		printf '%s=%s\n' "$key" "$value" >>"$candidate"
	done
	platform_cleanup_commit_marker_candidate "$destination" "$phase" "$candidate"
}

platform_cleanup_update_marker() {
	[[ $# -ge 1 && $(( ($# - 1) % 2 )) -eq 0 ]] || return 1
	local phase="$1" key value current_value index directory candidate update_count=0
	local current_phase frontend_evidence
	local -a update_keys=() update_values=()
	shift
	platform_cleanup_validate_marker || return 1
	current_phase="$(platform_cleanup_marker_value phase)" || return 1
	frontend_evidence="$(platform_cleanup_marker_value frontend_evidence_sha256)" || return 1
	while (( $# > 0 )); do
		key="$1"; value="$2"; shift 2
		[[ " ${PLATFORM_CLEANUP_MARKER_KEYS[*]} " == *" $key "* && "$key" != version && "$key" != phase &&
			"$key" != created_at && "$key" != updated_at && -n "$value" &&
			"$value" != pending && "$value" != *$'\n'* && "$value" != *=* ]] || return 1
		current_value="$(awk -F= -v expected="$key" '$1 == expected { print substr($0, index($0, "=") + 1) }' \
			"$platform_cleanup_marker")" || return 1
		if [[ "$current_value" != pending && "$current_value" != "$value" ]]; then
			[[ ( "$current_phase" == preparing && "$phase" == preparing &&
				"$frontend_evidence" == pending &&
				"$key" =~ ^frontend_(challenge|attestation_sha256|signature_sha256)$ ) ||
				( "$current_phase" == "$phase" && "$key" == frontend_phase_evidence_chain_sha256 &&
					"$current_value" =~ ^[0-9a-f]{64}$ && "$value" =~ ^[0-9a-f]{64}$ ) ]] || return 1
		fi
		for ((index = 0; index < update_count; index++)); do [[ "${update_keys[$index]}" != "$key" ]] || return 1; done
		update_keys[$update_count]="$key"; update_values[$update_count]="$value"; ((update_count += 1))
	done
	directory="$(dirname -- "$platform_cleanup_marker")"
	candidate="$(mktemp "$directory/.platform-core-source-cleanup-v1.tmp.XXXXXX")" || return 1
	for key in "${PLATFORM_CLEANUP_MARKER_KEYS[@]}"; do
		case "$key" in
		version) value=2 ;;
		phase) value="$phase" ;;
		updated_at) value="$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
		*) value="$(awk -F= -v expected="$key" '$1 == expected { print substr($0, index($0, "=") + 1) }' "$platform_cleanup_marker")" ;;
		esac
		for ((index = 0; index < update_count; index++)); do
			if [[ "${update_keys[$index]}" == "$key" ]]; then value="${update_values[$index]}"; break; fi
		done
		printf '%s=%s\n' "$key" "$value" >>"$candidate"
	done
	platform_cleanup_commit_marker_candidate "$platform_cleanup_marker" "$phase" "$candidate"
}

platform_cleanup_validate_private_directory() {
	[[ $# -eq 1 && "$1" == /* && -d "$1" && ! -L "$1" && "$(realpath -- "$1")" == "$1" ]] || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:700' ]] || return 1
	fi
}

platform_cleanup_validate_private_file() {
	[[ $# -eq 1 && "$1" == /* && -f "$1" && ! -L "$1" && -s "$1" ]] || return 1
	platform_cleanup_validate_private_directory "$(dirname -- "$1")" || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]] || return 1
	fi
}

platform_cleanup_require_env_identity() {
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ &&
		! "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" =~ ^0+$ ]] ||
		platform_cleanup_fail 'reviewed canonical production env SHA-256 is required.' || return 1
	platform_cleanup_validate_private_file "$ENV_FILE" ||
		platform_cleanup_fail 'canonical production env is not a private regular file.' || return 1
	[[ "$(platform_cleanup_sha256 "$ENV_FILE")" == "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" ]] ||
		platform_cleanup_fail 'canonical production env differs from its reviewed SHA-256.'
}

platform_cleanup_require_compose_identity() {
	local canonical="$SERVER_ROOT/deploy/docker-compose.prod.yml" revision_sha
	[[ "$COMPOSE_FILE" == "$canonical" && -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" &&
		"$(realpath -- "$COMPOSE_FILE")" == "$canonical" &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ &&
		! "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" =~ ^0+$ ]] ||
		platform_cleanup_fail 'exact canonical Compose path and reviewed SHA-256 are required.' || return 1
	git -C "$SERVER_ROOT" ls-files --error-unmatch deploy/docker-compose.prod.yml >/dev/null || return 1
	revision_sha="$(git -C "$SERVER_ROOT" show "$EXPECTED_REVISION:deploy/docker-compose.prod.yml" |
		platform_cleanup_sha256 /dev/stdin)" || return 1
	[[ "$revision_sha" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" &&
		"$(platform_cleanup_sha256 "$COMPOSE_FILE")" == "$revision_sha" ]] ||
		platform_cleanup_fail 'canonical Compose file differs from the reviewed immutable revision.'
}

platform_cleanup_require_frontend_attestation_inputs() {
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" =~ ^[0-9a-f]{64}$ &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" =~ ^[0-9a-f]{64}$ &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" =~ ^[0-9a-f]{64}$ &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		platform_cleanup_fail 'exact signed frontend attestation identity and SHA-256 pins are required.' || return 1
	FRONTEND_ORIGIN="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ORIGIN" platform_cleanup_node -e '
let value;
try { value = new URL(process.env.FRONTEND_ORIGIN || ""); } catch { process.exit(1); }
if (value.protocol !== "https:" || value.origin !== process.env.FRONTEND_ORIGIN ||
    value.href !== `${value.origin}/` || value.username || value.password ||
    value.search || value.hash) process.exit(1);
' || platform_cleanup_fail 'frontend attestation origin must be one canonical HTTPS origin.'
}

platform_cleanup_frontend_origin_sha256() {
	printf '%s' "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ORIGIN" | platform_cleanup_sha256 /dev/stdin
}

platform_cleanup_prepare_private_directory() {
	local directory="$1" parent
	parent="$(dirname -- "$directory")"
	if [[ ! -e "$parent" && ! -L "$parent" ]]; then
		mkdir -p -- "$parent"
		chmod 700 "$parent"
		if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$parent"; fi
	fi
	platform_cleanup_validate_private_directory "$parent" || return 1
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then
		mkdir -- "$directory"
		chmod 700 "$directory"
		if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$directory"; fi
		sync -f "$parent"
	fi
	platform_cleanup_validate_private_directory "$directory"
}

platform_cleanup_evidence_directory() {
	local revision="$1" generation="$2"
	[[ "$revision" =~ ^[0-9a-f]{40}$ && "$generation" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	printf '%s/%s-generation-%s\n' "$platform_cleanup_evidence_parent" "$revision" "$generation"
}

platform_cleanup_require_confirmation() {
	[[ "${PLATFORM_CORE_SOURCE_CLEANUP_CONFIRMATION:-}" == "$PLATFORM_CORE_SOURCE_CLEANUP_CONFIRMATION_TEXT" ]] ||
		platform_cleanup_fail "set the exact confirmation: $PLATFORM_CORE_SOURCE_CLEANUP_CONFIRMATION_TEXT"
}

platform_cleanup_require_checkout() {
	[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
		platform_cleanup_fail 'EXPECTED_REVISION must be an immutable 40-character SHA.' || return 1
	platform_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION"
	[[ "$(git -C "$SERVER_ROOT" branch --show-current)" == prod ]] ||
		platform_cleanup_fail 'cleanup requires the protected prod branch.' || return 1
}

platform_cleanup_require_production_context() {
	[[ "$(id -u)" == 0 && "$(uname -s)" == Linux ]] ||
		platform_cleanup_fail 'production cleanup requires root on Linux.' || return 1
	[[ "$ENV_FILE" == "$APP_ROOT/deploy/backend/.env.production" &&
		"$(realpath -- "$ENV_FILE")" == "$ENV_FILE" && -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		platform_cleanup_fail 'backend production env must be root-owned mode 600.' || return 1
	platform_cleanup_require_env_identity || return 1
	platform_database_require_no_ambient_env_overrides || return 1
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" &&
		"$(docker context show)" == default &&
		"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$(docker info --format '{{.OSType}}')" == linux ]] ||
		platform_cleanup_fail 'canonical local production Docker daemon is required.' || return 1
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
}

platform_cleanup_require_complete_cutover() {
	[[ "$(platform_cutover_current_phase)" == complete &&
		"$(platform_database_current_phase)" == complete ]] ||
		platform_cleanup_fail 'Platform cutover and database markers must both be complete.' || return 1
	platform_cutover_validate_marker
	platform_database_validate_marker
	local ownership_revision
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	[[ "$ownership_revision" == "$(platform_database_marker_value revision)" &&
		"$(platform_cutover_marker_value generation)" == "$(platform_database_marker_value generation)" ]] ||
		platform_cleanup_fail 'Platform complete markers disagree.' || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$ownership_revision" "$EXPECTED_REVISION" ||
		platform_cleanup_fail 'cleanup revision must descend from Platform ownership.' || return 1
}

platform_cleanup_require_first_complete_proof() {
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_FILE" == /* &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256" =~ ^[0-9a-f]{64}$ &&
		! "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256" =~ ^0+$ ]] ||
		platform_cleanup_fail 'explicit first-COMPLETE proof file and reviewed SHA-256 are required.' || return 1
	platform_cleanup_validate_private_file "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_FILE" ||
		platform_cleanup_fail 'first-COMPLETE proof is not a private immutable artifact.' || return 1
	[[ "$(platform_cleanup_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_FILE")" == "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256" ]] ||
		platform_cleanup_fail 'first-COMPLETE proof differs from its reviewed SHA-256.'
}

platform_cleanup_require_soak() {
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS" =~ ^[0-9]+$ &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS" -ge 900 &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS" -le 86400 ]] ||
		platform_cleanup_fail 'cleanup soak must be between 900 and 86400 seconds.' || return 1
	local completed_at
	completed_at="$(platform_cutover_marker_value updated_at)" || return 1
	COMPLETED_AT="$completed_at" SOAK_SECONDS="$PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS" platform_cleanup_node -e '
const completed = Date.parse(process.env.COMPLETED_AT || "");
const soak = Number(process.env.SOAK_SECONDS) * 1000;
if (!Number.isFinite(completed) || !Number.isSafeInteger(soak) ||
    completed > Date.now() || Date.now() - completed < soak) process.exit(1);
' || platform_cleanup_fail 'Platform complete marker has not satisfied the cleanup soak.'
}

platform_cleanup_migration_file() {
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION" =~ ^[0-9]{14}_remove_legacy_platform_core_source$ ]] || return 1
	printf '%s/prisma/migrations/%s/migration.sql\n' "$SERVER_ROOT" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION"
}

platform_cleanup_expected_changed_migrations() {
	printf '%s\n' \
		'prisma/migrations/20260824020000_prepare_support_service_ownership/migration.sql' \
		"prisma/migrations/$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION/migration.sql"
}

platform_cleanup_changed_migrations_are_exact() {
	[[ $# -eq 1 ]] || return 1
	[[ "$1" == "$(platform_cleanup_expected_changed_migrations)" ]]
}

platform_cleanup_require_migration_contract() {
	local file changed_migrations ownership_revision
	file="$(platform_cleanup_migration_file)" ||
		platform_cleanup_fail 'exact Platform Core cleanup migration name is required.' || return 1
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
		! "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" =~ ^0+$ &&
		-f "$file" && ! -L "$file" &&
		"$(platform_cleanup_sha256 "$file")" == "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" ]] ||
		platform_cleanup_fail 'reviewed Platform Core cleanup migration SHA-256 is required.' || return 1
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	changed_migrations="$(git -C "$SERVER_ROOT" diff --name-only "$ownership_revision" "$EXPECTED_REVISION" -- prisma/migrations | LC_ALL=C sort)"
	platform_cleanup_changed_migrations_are_exact "$changed_migrations" ||
		platform_cleanup_fail 'cleanup revision must contain only the already-applied Support prepare and reviewed Platform cleanup migrations.' || return 1
	bash "$SERVER_ROOT/scripts/test-platform-core-source-cleanup-rehearsal.sh" \
		--validate-migration "$file" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256"
}

platform_cleanup_prepare_prisma_manifest() {
	[[ $# -eq 1 && "$1" == /* ]] || return 1
	local destination="$1" directory temporary migration_directory migration_file name count expected_line
	directory="$(dirname -- "$destination")"
	platform_cleanup_validate_private_directory "$directory" || return 1
	temporary="$(mktemp "$directory/.prisma-manifest.partial.XXXXXX")" || return 1
	for migration_directory in "$SERVER_ROOT"/prisma/migrations/*; do
		[[ -d "$migration_directory" && ! -L "$migration_directory" ]] || { rm -f -- "$temporary"; return 1; }
		name="$(basename -- "$migration_directory")"
		[[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || { rm -f -- "$temporary"; return 1; }
		migration_file="$migration_directory/migration.sql"
		[[ -f "$migration_file" && ! -L "$migration_file" ]] || { rm -f -- "$temporary"; return 1; }
		count="$(find "$migration_directory" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')"
		[[ "$count" == 1 ]] || { rm -f -- "$temporary"; return 1; }
		printf '%s|%s\n' "$name" "$(platform_cleanup_sha256 "$migration_file")" >>"$temporary"
	done
	LC_ALL=C sort -o "$temporary" "$temporary"
	[[ -s "$temporary" && "$(cut -d'|' -f1 "$temporary" | uniq -d | wc -l | tr -d '[:space:]')" == 0 ]] || {
		rm -f -- "$temporary"; return 1;
	}
	expected_line="$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION|$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256"
	[[ "$(grep -Fxc "$expected_line" "$temporary")" == 1 ]] || { rm -f -- "$temporary"; return 1; }
	if [[ -e "$destination" || -L "$destination" ]]; then
		platform_cleanup_validate_private_file "$destination" || { rm -f -- "$temporary"; return 1; }
		cmp -s -- "$temporary" "$destination" || { rm -f -- "$temporary"; return 1; }
		rm -f -- "$temporary"
	else
		platform_cleanup_promote_evidence "$temporary" "$destination" || return 1
	fi
	platform_cleanup_sha256 "$destination"
}

platform_cleanup_validate_prisma_ledger() {
	[[ $# -eq 3 && "$3" =~ ^(pre|failed-pre|unrecorded-post|post)$ ]] || return 1
	local manifest="$1" ledger="$2" mode="$3"
	platform_cleanup_validate_private_file "$manifest" || return 1
	platform_cleanup_validate_private_file "$ledger" || return 1
	platform_cleanup_node - "$manifest" "$ledger" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION" "$mode" <<'NODE'
const fs = require('node:fs');
const [manifestPath, ledgerPath, candidate, mode] = process.argv.slice(2);
const hex = value => /^[0-9a-f]{64}$/.test(value);
const manifestRows = fs.readFileSync(manifestPath, 'utf8').trim().split(/\n/).map(row => row.split('|'));
const ledgerText = fs.readFileSync(ledgerPath, 'utf8').trim();
const ledgerRows = ledgerText ? ledgerText.split(/\n/).map(row => row.split('|')) : [];
const expected = new Map();
let previousManifest = '';
for (const row of manifestRows) {
	  if (row.length !== 2 || !/^[0-9]{14}_[a-z0-9_]+$/.test(row[0]) || !hex(row[1]) || expected.has(row[0]) ||
	      (previousManifest && row[0] <= previousManifest)) process.exit(1);
	  expected.set(row[0], row[1]);
	  previousManifest = row[0];
}
if (!expected.has(candidate) || !['pre', 'failed-pre', 'unrecorded-post', 'post'].includes(mode)) process.exit(1);
const grouped = new Map([...expected.keys()].map(name => [name, []]));
const ids = new Set();
let previousLedger = '';
for (const row of ledgerRows) {
	  if (row.length !== 8) process.exit(1);
	  const [id, name, checksum, started, finished, rolledBack, stepsValue, logsHex] = row;
	  const timestamp = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
	  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || ids.has(id) || !expected.has(name) || checksum !== expected.get(name) ||
	      !timestamp(started) || (finished !== '-' && !timestamp(finished)) || (rolledBack !== '-' && !timestamp(rolledBack)) ||
	      !/^\d+$/.test(stepsValue) || !/^[0-9a-f]*$/.test(logsHex)) process.exit(1);
	  const ordering = `${name}|${started}|${id}`;
	  if (previousLedger && ordering <= previousLedger) process.exit(1);
	  previousLedger = ordering;
	  ids.add(id);
	  const state = rolledBack !== '-' ? (finished === '-' ? 'rolled-back' : 'unsafe') : (finished === '-' ? 'pending' : 'applied');
	  grouped.get(name).push({state, steps: BigInt(stepsValue)});
}
	for (const [name, rows] of grouped) {
	  const applied = rows.filter(row => row.state === 'applied');
	  const pending = rows.filter(row => row.state === 'pending' || row.state === 'unsafe');
	  if (applied.some(row => row.steps < 1n) || (name !== candidate && pending.length)) process.exit(1);
	  if (name === candidate) {
	    const unfinished = rows.filter(row => row.state === 'pending' || row.state === 'unsafe');
	    if (mode === 'pre' && (applied.length !== 0 || unfinished.length !== 0)) process.exit(1);
	    if (mode === 'failed-pre' && (applied.length !== 0 || unfinished.length !== 1 || unfinished[0].state !== 'pending')) process.exit(1);
	    if (mode === 'unrecorded-post' && (applied.length !== 0 || unfinished.length > 1 || unfinished.some(row => row.state !== 'pending'))) process.exit(1);
	    if (mode === 'post' && (applied.length !== 1 || unfinished.length !== 0)) process.exit(1);
	  } else if (applied.length !== 1) process.exit(1);
	}
NODE
}

platform_cleanup_capture_prisma_ledger() {
	[[ $# -eq 3 && "$3" =~ ^(pre|failed-pre|unrecorded-post|post)$ ]] || return 1
	local manifest="$1" destination="$2" mode="$3" directory temporary
	directory="$(dirname -- "$destination")"
	platform_cleanup_validate_private_directory "$directory" || return 1
	temporary="$(mktemp "$directory/.prisma-ledger-$mode.partial.XXXXXX")" || return 1
	if ! platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
COPY (
	  SELECT id || '|' || migration_name || '|' || checksum || '|' ||
	    to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') || '|' ||
	    COALESCE(to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), '-') || '|' ||
	    COALESCE(to_char(rolled_back_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), '-') || '|' ||
	    applied_steps_count::text || '|' || encode(convert_to(COALESCE(logs, ''), 'UTF8'), 'hex')
	  FROM public._prisma_migrations
  ORDER BY migration_name COLLATE \"C\", started_at, id
) TO STDOUT;" >"$temporary"; then
		rm -f -- "$temporary"; return 1
	fi
	chmod 600 "$temporary"
	platform_cleanup_validate_prisma_ledger "$manifest" "$temporary" "$mode" || { rm -f -- "$temporary"; return 1; }
	if [[ -e "$destination" || -L "$destination" ]]; then
		platform_cleanup_validate_private_file "$destination" || { rm -f -- "$temporary"; return 1; }
		cmp -s -- "$temporary" "$destination" || { rm -f -- "$temporary"; return 1; }
		rm -f -- "$temporary"
	else
		platform_cleanup_promote_evidence "$temporary" "$destination" || return 1
	fi
	platform_cleanup_sha256 "$destination"
}

platform_cleanup_validate_live_prisma_ledger() (
	[[ $# -eq 2 && "$2" =~ ^(pre|failed-pre|unrecorded-post|post)$ ]] || return 1
	local manifest="$1" mode="$2" parent temporary
	parent="$(dirname -- "$manifest")"
	platform_cleanup_validate_private_directory "$parent" || return 1
	temporary="$(mktemp -d "$parent/.live-prisma-ledger.XXXXXX")" || return 1
	chmod 700 "$temporary"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$temporary"; fi
	trap 'rm -rf -- "$temporary"' EXIT INT TERM
	platform_cleanup_capture_prisma_ledger "$manifest" "$temporary/ledger.evidence" "$mode" >/dev/null
)

platform_cleanup_grep_no_match() {
	local grep_result
	if grep "$@" >/dev/null; then
		return 1
	else
		grep_result=$?
	fi
	[[ "$grep_result" == 1 ]]
}

platform_cleanup_runtime_source_has_no_match() {
	[[ $# -ge 2 ]] || return 1
	local pattern="$1" root
	shift
	for root in "$@"; do
		[[ -d "$root" && ! -L "$root" && -r "$root" ]] || return 1
	done
	platform_cleanup_grep_no_match -rEn \
		--include='*.ts' --include='*.js' --include='*.mjs' --include='*.cjs' \
		--exclude='*.spec.*' --exclude='*.test.*' \
		"$pattern" "$@"
}

platform_cleanup_assert_cleanup_source_retired() {
	local path
	local -a runtime_source_roots=("$SERVER_ROOT/src")
	for path in src/site-settings src/legal-pages src/home-page-content src/platform-boundary; do
		[[ ! -e "$SERVER_ROOT/$path" && ! -L "$SERVER_ROOT/$path" ]] ||
			platform_cleanup_fail "cleanup revision still contains Core Platform source: $path" || return 1
	done
	for path in SiteSettings PlatformCoreState LegalPage HomePageContent PlatformCoreOwnership; do
		! grep -Eq "^(model|enum)[[:space:]]+$path([[:space:]]|$)" "$SERVER_ROOT/prisma/schema.prisma" ||
			platform_cleanup_fail "cleanup Prisma schema still exposes $path" || return 1
	done
	grep -Fq 'model BillingSourceAggregateVersion' "$SERVER_ROOT/prisma/schema.prisma" ||
		platform_cleanup_fail 'shared Billing source aggregate model must be retained.' || return 1
	platform_cleanup_grep_no_match -En \
		'SiteSettingsModule|LegalPagesModule|HomePageContentModule|PlatformBoundaryModule' \
		"$SERVER_ROOT/src/app.module.ts" ||
		platform_cleanup_fail 'Core AppModule still registers retired Platform modules.' || return 1
	platform_cleanup_runtime_source_has_no_match \
		'prisma\.(siteSettings|legalPage|homePageContent|platformCoreState)([^[:alnum:]_]|$)|@(Controller|All|Delete|Get|Head|Options|Patch|Post|Put|Search)\(.*(site-settings|legal-pages|home-page-content)|/api/v1/(site-settings|legal-pages|home-page-content)' \
		"$SERVER_ROOT/src" ||
		platform_cleanup_fail 'cleanup revision still contains a legacy Core Platform read/write path.' || return 1
	for path in "$SERVER_ROOT"/apps/*/src; do
		[[ -d "$path" && ! -L "$path" ]] && runtime_source_roots+=("$path")
	done
	platform_cleanup_runtime_source_has_no_match \
		'billing\.settings\.source\.changed\.v1|billing-settings-source|winwidget\.billing\.settings-source\.v1' \
		"${runtime_source_roots[@]}" ||
		platform_cleanup_fail 'cleanup revision still produces or consumes the legacy Billing settings-source event.' || return 1
	platform_cleanup_runtime_source_has_no_match \
		"@Patch\\(['\"]settings['\"]\\)|[[:space:]]updateSettings\\(" \
		"$SERVER_ROOT/apps/billing/src/http" "$SERVER_ROOT/apps/billing/src/domain" ||
		platform_cleanup_fail 'Billing internal update-settings second-writer route remains in the cleanup revision.'
}

platform_cleanup_database_url_field() {
	[[ $# -eq 2 && "$2" =~ ^(protocol|username|password|hostname|port|database|schema)$ ]] || return 1
	local value field="$2"
	value="$(platform_read_env_value "$ENV_FILE" "$1")" || return 1
	URL_VALUE="$value" platform_cleanup_node -e '
let parsed;
try { parsed = new URL(process.env.URL_VALUE || ""); } catch { process.exit(1); }
const values = {
  protocol: parsed.protocol,
  username: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  hostname: parsed.hostname,
  port: parsed.port,
  database: parsed.pathname.slice(1),
  schema: parsed.searchParams.get("schema") || "",
};
const value = values[process.argv[1]];
if (!value || /[\u0000-\u001f\u007f]/.test(value)) process.exit(1);
process.stdout.write(value);
' "$field"
}

platform_cleanup_query() {
	[[ $# -eq 2 && "$1" =~ ^(DATABASE_MIGRATION_URL_PRODUCTION|DATABASE_BACKUP_URL|PLATFORM_BACKUP_URL)$ ]] || return 1
	local url_key="$1" sql="$2" username password hostname port database
	username="$(platform_cleanup_database_url_field "$url_key" username)" || return 1
	password="$(platform_cleanup_database_url_field "$url_key" password)" || return 1
	hostname="$(platform_cleanup_database_url_field "$url_key" hostname)" || return 1
	port="$(platform_cleanup_database_url_field "$url_key" port)" || return 1
	database="$(platform_cleanup_database_url_field "$url_key" database)" || return 1
	PGPASSWORD="$password" platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 --env PGPASSWORD \
		--entrypoint psql "$PLATFORM_CORE_SOURCE_CLEANUP_POSTGRES_IMAGE" --no-psqlrc \
		--no-password --tuples-only --no-align --set ON_ERROR_STOP=1 \
		--host "$hostname" --port "$port" --username "$username" \
		--dbname "$database" --command "$sql"
	unset password
}

platform_cleanup_database_identities_match() {
	[[ $# -eq 2 && "$1" =~ ^default_db\|[1-9][0-9]*$ && "$1" == "$2" ]]
}

platform_cleanup_core_database_identity() {
	local identity
	identity="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION \
		"SELECT current_database() || '|' || (pg_control_system()).system_identifier::text;")" || return 1
	[[ "$identity" =~ ^default_db\|[1-9][0-9]*$ ]] || return 1
	printf '%s\n' "$identity"
}

platform_cleanup_assert_core_database_identity() {
	local migration_identity backup_identity
	platform_cutover_assert_core_database_urls_match ||
		platform_cleanup_fail 'Core runtime and backup database identities differ.' || return 1
	migration_identity="$(platform_cleanup_core_database_identity)" || return 1
	backup_identity="$(platform_cleanup_query DATABASE_BACKUP_URL \
		"SELECT current_database() || '|' || (pg_control_system()).system_identifier::text;")" || return 1
	platform_cleanup_database_identities_match "$migration_identity" "$backup_identity" ||
		platform_cleanup_fail 'Core migration and backup URLs do not identify the exact same default_db cluster.'
}

platform_cleanup_assert_targets_unchanged() {
	platform_cleanup_require_env_identity || return 1
	platform_cleanup_require_compose_identity || return 1
	platform_cleanup_assert_core_database_identity || return 1
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		local identity database_name system_identifier
		identity="$(platform_cleanup_core_database_identity)" || return 1
		IFS='|' read -r database_name system_identifier <<<"$identity"
		[[ "$database_name" == "$(platform_cleanup_marker_value core_database_name)" &&
			"$system_identifier" == "$(platform_cleanup_marker_value core_database_system_identifier)" &&
			"$(platform_cleanup_marker_value production_env_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" &&
			"$(platform_cleanup_marker_value compose_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" ]] ||
			platform_cleanup_fail 'destructive Core database or canonical deployment identity changed.'
	fi
}

platform_cleanup_core_ownership_anchor() {
	local ownership_revision generation snapshot fingerprint highwater result
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	generation="$(platform_cutover_marker_value generation)" || return 1
	snapshot="$(platform_cutover_marker_value snapshot_sha256)" || return 1
	fingerprint="$(platform_cutover_marker_value source_fingerprint)" || return 1
	highwater="$(platform_cutover_marker_value source_high_watermark)" || return 1
	[[ "$ownership_revision" =~ ^[0-9a-f]{40}$ && "$generation" =~ ^[1-9][0-9]{0,17}$ &&
		"$snapshot" =~ ^[0-9a-f]{64}$ && "$fingerprint" =~ ^[0-9a-f]{64}$ &&
		"$highwater" =~ ^[1-9][0-9]*$ ]] || return 1
	result="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT state.generation::text || '|' || state.billing_offer_contract_version::text || '|' ||
  state.billing_offer_sequence_scope || '|' || state.billing_offer_aggregate_version::text || '|' ||
  state.billing_offer_source_sequence::text || '|' || state.billing_offer_fence_fingerprint
FROM public.platform_core_state state
WHERE state.id='singleton' AND state.ownership='PLATFORM'::public.\"PlatformCoreOwnership\"
  AND state.source_writes_enabled=FALSE AND state.legacy_routes_enabled=FALSE
  AND state.generation=$generation
  AND state.prepared_revision='$ownership_revision' AND state.source_revision='$ownership_revision'
  AND state.ownership_revision='$ownership_revision'
  AND state.source_snapshot_sha256='$snapshot' AND state.source_fingerprint='$fingerprint'
  AND state.source_high_watermark=$highwater
  AND state.billing_offer_contract_version=2
  AND state.billing_offer_sequence_scope='billing.offer:offer'
  AND state.billing_offer_aggregate_version > 0 AND state.billing_offer_source_sequence > 0
  AND state.billing_offer_fence_fingerprint ~ '^[0-9a-f]{64}$'
  AND state.fenced_at IS NOT NULL AND state.exported_at IS NOT NULL AND state.activated_at IS NOT NULL
  AND state.fenced_at <= state.exported_at AND state.exported_at <= state.activated_at
  AND EXISTS (
    SELECT 1 FROM public.billing_source_aggregate_versions cursor
    WHERE cursor.aggregate_type='billing.offer' AND cursor.aggregate_id='offer'
      AND cursor.version=state.billing_offer_aggregate_version
      AND cursor.source_sequence=state.billing_offer_source_sequence
  );")" || return 1
	[[ "$result" =~ ^[1-9][0-9]*\|2\|billing\.offer:offer\|[1-9][0-9]*\|[1-9][0-9]*\|[0-9a-f]{64}$ &&
		"${result%%|*}" == "$generation" ]] ||
		platform_cleanup_fail 'exact active Core ownership row and Billing fence differ from cutover markers.' || return 1
	printf '%s\n' "$result"
}

platform_cleanup_source_state() {
	local inventory
	inventory="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT
  COALESCE((SELECT string_agg(c.relname, ',' ORDER BY c.relname COLLATE \"C\") FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state')), '') || '~' ||
  COALESCE((SELECT string_agg(c.relname || ':' || t.tgname, ',' ORDER BY (c.relname || ':' || t.tgname) COLLATE \"C\")
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
      AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state')), '') || '~' ||
  COALESCE((SELECT string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text COLLATE \"C\")
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname IN ('platform_core_state_transition_guard','platform_core_source_writes_enabled','platform_assert_core_write_enabled','billing_offer_projection_trigger')), '') || '~' ||
  (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='PlatformCoreOwnership')::text || '~' ||
  (SELECT count(*) FROM public.billing_source_aggregate_versions
    WHERE aggregate_type='billing.offer' AND aggregate_id='offer')::text;")" || return 1
	case "$inventory" in
	'home_page_content,legal_pages,platform_core_state,site_settings~home_page_content:platform_home_page_content_write_fence,legal_pages:billing_offer_projection,legal_pages:platform_legal_pages_write_fence,platform_core_state:platform_core_state_transition_guard,site_settings:platform_site_settings_write_fence~billing_offer_projection_trigger(),platform_assert_core_write_enabled(),platform_core_source_writes_enabled(),platform_core_state_transition_guard()~1~1') printf 'present\n' ;;
	'~~~0~0') printf 'absent\n' ;;
	*) printf 'unsafe\n' ;;
	esac
}

platform_cleanup_assert_retained_billing_seam() {
	local result
	result="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT (to_regclass('public.billing_source_aggregate_versions') IS NOT NULL
	AND to_regclass('public.billing_core_state') IS NOT NULL
	AND to_regclass('public.billing_read_projection_versions') IS NOT NULL
	AND to_regclass('public.billing_subscription_read_projections') IS NOT NULL
	AND to_regclass('public.billing_payment_read_projections') IS NOT NULL
	AND to_regclass('public.billing_affiliate_read_projections') IS NOT NULL
	AND to_regclass('public.billing_settings_read_projection') IS NOT NULL
	AND to_regclass('public.billing_settings_compositions') IS NOT NULL
  AND to_regclass('public.billing_source_sequence') IS NOT NULL
  AND to_regprocedure('public.billing_record_source_event(text,text,text,text,jsonb,boolean)') IS NOT NULL
  AND to_regprocedure('public.billing_iso_timestamp(timestamp without time zone)') IS NOT NULL)::text;")" || return 1
	[[ "$result" == t ]] || platform_cleanup_fail 'retained shared Billing seam is incomplete.'
}

platform_cleanup_migration_state() {
	local result total applied pending rolled_back wrong
	result="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*)::text || '|' ||
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND checksum='$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256')::text || '|' ||
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::text || '|' ||
  count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::text || '|' ||
  count(*) FILTER (WHERE checksum <> '$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256')::text
FROM public._prisma_migrations
WHERE migration_name='$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION';")" || return 1
	IFS='|' read -r total applied pending rolled_back wrong <<<"$result"
	[[ "$total" =~ ^[0-9]+$ && "$applied" =~ ^[0-9]+$ && "$pending" =~ ^[0-9]+$ &&
		"$rolled_back" =~ ^[0-9]+$ && "$wrong" == 0 ]] || { printf 'unsafe\n'; return; }
	if (( total == 0 && applied == 0 && pending == 0 && rolled_back == 0 )); then
		printf 'pending\n'
	elif (( applied == 0 && pending == 1 && rolled_back + 1 == total )); then
		printf 'failed\n'
	elif (( total > 0 && applied == 0 && pending == 0 && rolled_back == total )); then
		printf 'rolled-back\n'
	elif (( applied == 1 && pending == 0 && rolled_back + 1 == total )); then
		printf 'applied\n'
	else
		printf 'unsafe\n'
	fi
}

platform_cleanup_inventory() {
	printf 'relations=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_CORE_SOURCE_RELATIONS[*]}")"
	printf 'triggers=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_CORE_SOURCE_TRIGGERS[*]}")"
	printf 'functions=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_CORE_SOURCE_FUNCTIONS[*]}")"
	printf 'type=public.PlatformCoreOwnership\n'
	printf 'cursor_row=public.billing_source_aggregate_versions:billing.offer:offer\n'
	printf 'retained_billing_seam=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_CORE_RETAINED_BILLING_SEAM[*]}")"
	printf 'core_routes=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_CORE_DIRECT_ROUTES[*]}")"
	printf 'gateway_routes=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_OWNER_ROUTE_CONTRACT[*]}")"
	printf 'legacy_billing_settings_source_queue_family=winwidget.billing.settings-source.v1\n'
	printf 'legacy_billing_internal_route=PATCH:/internal/v1/billing/settings\n'
	printf 'credentials_removed_from_core_api=%s\n' "$(IFS=,; printf '%s' "${PLATFORM_CREDENTIALS_FORBIDDEN_IN_CORE[*]}")"
	printf 'global_platform_credentials=retained_and_owner_scoped\n'
	printf 'production_env=private_file_reviewed_sha256_required\n'
	printf 'core_database_identity=runtime_equals_migration_equals_backup\n'
}

platform_cleanup_validate_evidence() {
	[[ $# -eq 4 && "$2" =~ ^[a-z0-9-]+$ && "$3" =~ ^[0-9a-f]{40}$ &&
		"$4" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	platform_cleanup_validate_private_file "$1" || return 1
	local database_name system_identifier live_database_name live_system_identifier identity compose_sha ownership_revision expected_order
	case "$2" in
	platform-core-cleanup-soak)
		expected_order='version action status ownership_revision cleanup_revision generation production_env_sha256 compose_sha256 core_database_name core_database_system_identifier minimum_soak_seconds cutover_completed_at platform_api_container_id platform_api_image_id platform_api_started_at platform_outbox_publisher_container_id platform_outbox_publisher_image_id platform_outbox_publisher_started_at observed_at'
		;;
	platform-core-cleanup-routes)
		expected_order='version action status ownership_revision cleanup_revision generation production_env_sha256 compose_sha256 core_database_name core_database_system_identifier site_settings_response_sha256 site_settings_gateway_owner legal_pages_response_sha256 legal_pages_gateway_owner legal_pages_oferta_response_sha256 legal_pages_oferta_gateway_owner home_page_content_response_sha256 home_page_content_gateway_owner core_site_settings_status core_legal_pages_status core_legal_pages_oferta_status core_home_page_content_status observed_at'
		;;
	platform-core-cleanup-queues)
		expected_order='version action status ownership_revision cleanup_revision generation production_env_sha256 compose_sha256 core_database_name core_database_system_identifier legacy_billing_offer_v1_queues legacy_billing_settings_source_queues legacy_billing_settings_source_bindings billing_offer_v2_queues platform_admin_audit_queues messages_ready messages_unacknowledged queue_listing_sha256 observed_at'
		;;
	platform-core-cleanup-outbox)
		expected_order='version action status ownership_revision cleanup_revision generation production_env_sha256 compose_sha256 core_database_name core_database_system_identifier core_unpublished_platform_events core_active_platform_receipts core_unresolved_platform_failures platform_unpublished_outbox legacy_billing_offer_cursor_rows observed_at'
		;;
	platform-core-cleanup-frontend)
		expected_order='version action status ownership_revision cleanup_revision generation production_env_sha256 compose_sha256 core_database_name core_database_system_identifier frontend_revision frontend_origin_sha256 frontend_challenge frontend_attestation_sha256 frontend_signature_sha256 frontend_public_key_sha256 validator_output_sha256 signed_runtime_attestation_valid public_payment_binding_valid observed_at'
		;;
	platform-core-cleanup-topology)
		expected_order='version action status ownership_revision cleanup_revision generation production_env_sha256 compose_sha256 core_database_name core_database_system_identifier canonical_compose_sha256 rendered_compose_sha256 deployment_manifest_sha256 legacy_runtime_references core_platform_credentials observed_at'
		;;
	platform-core-cleanup-pre-restore)
		expected_order='version action status ownership_revision cleanup_revision production_env_sha256 generation compose_sha256 postgres_major core_dump_sha256 core_catalog_sha256 core_repeat_dump_sha256 core_database_name core_database_system_identifier core_restored_system_identifier core_source_state platform_dump_sha256 platform_catalog_sha256 platform_repeat_dump_sha256 platform_restored_system_identifier platform_state isolated_targets internal_network no_host_ports resources_removed_before_evidence clean_restore observed_at'
		;;
	platform-core-cleanup-post-restore)
		expected_order='version action status ownership_revision cleanup_revision production_env_sha256 generation compose_sha256 postgres_major core_dump_sha256 core_catalog_sha256 core_repeat_dump_sha256 core_database_name core_database_system_identifier core_restored_system_identifier core_source_state isolated_targets internal_network no_host_ports resources_removed_before_evidence clean_restore observed_at'
		;;
	platform-core-cleanup-migration-rehearsal)
		expected_order='version action status ownership_revision cleanup_revision production_env_sha256 compose_sha256 core_database_name core_database_system_identifier generation core_dump_sha256 migration_sha256 marker_sha256 prisma_manifest_sha256 prisma_pre_ledger_sha256 restored_prisma_ledger_exact restored_system_identifier pre_source_state post_source_state postgres_major migration_role exact_migration_applied production_system_identifier_substituted_only_for_isolated_restore internal_network no_host_ports resources_removed_before_evidence observed_at'
		;;
		platform-core-cleanup-complete)
			expected_order='version action status ownership_revision cleanup_revision production_env_sha256 compose_sha256 core_database_name core_database_system_identifier generation snapshot_sha256 source_fingerprint source_high_watermark billing_offer_contract_version billing_offer_sequence_scope billing_offer_aggregate_version billing_offer_source_sequence billing_offer_fence_fingerprint first_complete_proof_sha256 migration_sha256 prisma_manifest_sha256 prisma_pre_ledger_sha256 prisma_post_ledger_sha256 migration_rehearsal_evidence_sha256 frontend_evidence_sha256 frontend_phase_evidence_chain_sha256 topology_scan_evidence_sha256 core_pre_backup_sha256 platform_pre_backup_sha256 pre_restore_evidence_sha256 soak_evidence_sha256 route_evidence_sha256 queue_evidence_sha256 outbox_evidence_sha256 pre_offsite_receipt_sha256 post_offsite_receipt_sha256 core_post_backup_sha256 post_restore_evidence_sha256 legacy_source_absent migration_applied platform_owner_active no_dual_read_write legacy_settings_source_topology_absent clean_restore all_core_role_credentials_absent signed_frontend_attestation_valid prisma_ledger_exact observed_at'
		;;
	*) return 1 ;;
	esac
	identity="$(platform_cleanup_core_database_identity)" || return 1
	IFS='|' read -r live_database_name live_system_identifier <<<"$identity"
	database_name="$live_database_name"
	system_identifier="$live_system_identifier"
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	compose_sha="$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256"
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		database_name="$(platform_cleanup_marker_value core_database_name)" || return 1
		system_identifier="$(platform_cleanup_marker_value core_database_system_identifier)" || return 1
		[[ "$live_database_name" == "$database_name" && "$live_system_identifier" == "$system_identifier" ]] ||
			platform_cleanup_fail 'live Core database identity differs from cleanup evidence journal.' || return 1
		compose_sha="$(platform_cleanup_marker_value compose_sha256)" || return 1
	fi
	awk -F= -v action="$2" -v revision="$3" -v generation="$4" \
		-v production_env_sha256="$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
		-v compose_sha256="$compose_sha" -v database_name="$database_name" \
		-v system_identifier="$system_identifier" -v ownership_revision="$ownership_revision" \
		-v expected_order="$expected_order" '
		BEGIN { expected = split(expected_order, order, " ") }
		$1 != order[NR] { exit 1 }
		$1 !~ /^[a-z][a-z0-9_]*$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != expected) exit 1
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["version"] != "1" || value["action"] != action ||
				value["status"] != "verified" || value["cleanup_revision"] != revision ||
					value["ownership_revision"] != ownership_revision ||
					value["generation"] != generation ||
					value["production_env_sha256"] != production_env_sha256 ||
					value["compose_sha256"] != compose_sha256 ||
					value["core_database_name"] != database_name ||
					value["core_database_system_identifier"] != system_identifier ||
					value["observed_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) exit 1
		}
	' "$1"
}

platform_cleanup_print_evidence_identity() {
	local database_name system_identifier live_database_name live_system_identifier identity
	identity="$(platform_cleanup_core_database_identity)" || return 1
	IFS='|' read -r live_database_name live_system_identifier <<<"$identity"
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		database_name="$(platform_cleanup_marker_value core_database_name)" || return 1
		system_identifier="$(platform_cleanup_marker_value core_database_system_identifier)" || return 1
		[[ "$live_database_name" == "$database_name" && "$live_system_identifier" == "$system_identifier" ]] ||
			platform_cleanup_fail 'live Core database identity differs from cleanup journal.' || return 1
		printf 'production_env_sha256=%s\ncompose_sha256=%s\n' \
			"$(platform_cleanup_marker_value production_env_sha256)" \
			"$(platform_cleanup_marker_value compose_sha256)"
	else
		database_name="$live_database_name"
		system_identifier="$live_system_identifier"
		printf 'production_env_sha256=%s\ncompose_sha256=%s\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
			"$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256"
	fi
	printf 'core_database_name=%s\ncore_database_system_identifier=%s\n' \
		"$database_name" "$system_identifier"
}

platform_cleanup_promote_evidence() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" && ! -e "$2" && ! -L "$2" ]] || return 1
	chmod 600 "$1"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$1"; fi
	sync -f "$1"
	mv -f -- "$1" "$2"
	sync -f "$(dirname -- "$2")"
}

platform_cleanup_assert_soaked_runtime() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" partial="${1}.partial.$$" ownership_revision generation image_id
	local spec service port container metadata started_at observed_at completed_at
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	generation="$(platform_cutover_marker_value generation)" || return 1
	image_id="$(platform_cutover_marker_value image_id)" || return 1
	completed_at="$(platform_cutover_marker_value updated_at)" || return 1
	observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	{
		printf 'version=1\naction=platform-core-cleanup-soak\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\ngeneration=%s\n' \
			"$ownership_revision" "$EXPECTED_REVISION" "$generation"
		platform_cleanup_print_evidence_identity
		printf 'minimum_soak_seconds=%s\ncutover_completed_at=%s\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS" "$completed_at"
		for spec in platform-api:5000 platform-outbox-publisher:5001; do
			service="${spec%%:*}"
			port="${spec##*:}"
			container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q "$service")" || return 1
			[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
			metadata="$(docker inspect --format '{{.Image}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}' "$container")" || return 1
			IFS='|' read -r runtime_image restart_count health started_at <<<"$metadata"
			[[ "$runtime_image" == "$image_id" && "$restart_count" == 0 && "$health" == healthy ]] ||
				platform_cleanup_fail "$service is not the zero-restart ownership runtime." || return 1
			COMPLETED_AT="$completed_at" STARTED_AT="$started_at" OBSERVED_AT="$observed_at" \
				SOAK_SECONDS="$PLATFORM_CORE_SOURCE_CLEANUP_SOAK_SECONDS" \
				docker run --rm --network none --read-only --cap-drop ALL \
					--security-opt no-new-privileges --pids-limit 32 \
					--env COMPLETED_AT --env STARTED_AT --env OBSERVED_AT --env SOAK_SECONDS \
					--entrypoint node "$image_id" -e '
const complete = Date.parse(process.env.COMPLETED_AT || "");
const started = Date.parse(process.env.STARTED_AT || "");
const observed = Date.parse(process.env.OBSERVED_AT || "");
const soak = Number(process.env.SOAK_SECONDS) * 1000;
if (![complete, started, observed].every(Number.isFinite) || !Number.isSafeInteger(soak) ||
    observed - complete < soak || observed - started < soak || started > observed) process.exit(1);
' || platform_cleanup_fail "$service was recreated inside the soak window." || return 1
			curl -fsS --connect-timeout 3 --max-time 10 "http://127.0.0.1:$port/health/ready" >/dev/null
			printf '%s_container_id=%s\n%s_image_id=%s\n%s_started_at=%s\n' \
				"${service//-/_}" "$container" "${service//-/_}" "$runtime_image" \
				"${service//-/_}" "$started_at"
		done
		printf 'observed_at=%s\n' "$observed_at"
	} >"$partial"
	platform_cleanup_promote_evidence "$partial" "$destination"
	platform_cleanup_validate_evidence "$destination" platform-core-cleanup-soak \
		"$EXPECTED_REVISION" "$generation"
}

platform_cleanup_response_sha() {
	local url="$1" body
	body="$(mktemp "${TMPDIR:-/tmp}/platform-cleanup-response.XXXXXX")" || return 1
	if ! curl -fsS --connect-timeout 3 --max-time 15 "$url" >"$body"; then
		rm -f -- "$body"
		return 1
	fi
	platform_cleanup_sha256 "$body"
	rm -f -- "$body"
}

platform_cleanup_assert_gateway_contract() {
	local routes
	routes="$(platform_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
	ROUTES_VALUE="$routes" platform_cleanup_node -e '
let routes;
try { routes = JSON.parse(process.env.ROUTES_VALUE || ""); } catch { process.exit(1); }
if (!Array.isArray(routes)) process.exit(1);
const expected = [
  ["platform-site-settings", "/api/v1/site-settings", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-legal-pages", "/api/v1/legal-pages", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-home-page-content", "/api/v1/home-page-content", "http://127.0.0.1:5000", "optional", 60000],
];
const prefixes = new Set(expected.map(item => item[1]));
const actual = routes.filter(route => prefixes.has(route?.pathPrefix));
if (actual.length !== expected.length) process.exit(1);
for (const [id, pathPrefix, upstreamUrl, authPolicy, timeoutMs] of expected) {
  const matches = actual.filter(route => route.id === id && route.pathPrefix === pathPrefix);
  if (matches.length !== 1) process.exit(1);
  const route = matches[0];
  if (route.upstreamUrl !== upstreamUrl || route.authPolicy !== authPolicy || route.timeoutMs !== timeoutMs) process.exit(1);
}
'
}

platform_cleanup_assert_gateway_runtime_current() {
	local ownership_revision container image image_id metadata
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q api-gateway)" || return 1
	image="winwidget-api-gateway:git-$ownership_revision"
	image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
	metadata="$(docker inspect --format '{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container")" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$metadata" == "$image_id|running|true|healthy|0|winwidget|api-gateway" ]] ||
		platform_cleanup_fail 'current ownership Gateway runtime identity is not exact.'
}

platform_cleanup_assert_routes() {
	[[ $# -ge 1 && $# -le 2 && "${2:-running}" =~ ^(running|stopped)$ ]] || return 1
	local destination="$1" core_mode="${2:-running}" partial="${1}.partial.$$" generation image_id path path_key status
	local direct_sha gateway_sha public_sha headers owner
	generation="$(platform_cutover_marker_value generation)" || return 1
	image_id="$(platform_cutover_marker_value image_id)" || return 1
	platform_cutover_validate_gateway_manifest "$image_id"
	platform_cleanup_assert_gateway_contract
	platform_cleanup_assert_gateway_runtime_current
	if [[ "$core_mode" == running ]]; then
		platform_cleanup_assert_retirement_runtime
	else
		platform_cleanup_assert_core_services_stopped
	fi
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	{
		printf 'version=1\naction=platform-core-cleanup-routes\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\ngeneration=%s\n' \
			"$(platform_cutover_marker_value revision)" "$EXPECTED_REVISION" "$generation"
		platform_cleanup_print_evidence_identity
		for path in site-settings legal-pages legal-pages/oferta home-page-content; do
			path_key="$(tr '/-' '__' <<<"$path" | tr -d '\n')"
			direct_sha="$(platform_cleanup_response_sha "http://127.0.0.1:5000/api/v1/$path")" || return 1
			gateway_sha="$(platform_cleanup_response_sha "http://127.0.0.1:4100/api/v1/$path")" || return 1
			public_sha="$(platform_cleanup_response_sha "https://api.winwidget.ru/api/v1/$path")" || return 1
			[[ "$direct_sha" == "$gateway_sha" && "$gateway_sha" == "$public_sha" ]] ||
				platform_cleanup_fail "Platform route parity failed for $path." || return 1
			headers="$(curl -fsS -D - -o /dev/null --connect-timeout 3 --max-time 10 "http://127.0.0.1:4100/api/v1/$path")" || return 1
			owner="$(awk -F: 'tolower($1)=="x-winwidget-service" { value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print tolower(value); count += 1 } END { if (count != 1) exit 1 }' <<<"$headers")" || return 1
			[[ "$owner" == platform ]] || return 1
			printf '%s_response_sha256=%s\n%s_gateway_owner=platform\n' \
				"$path_key" "$direct_sha" "$path_key"
		done
		for path in "${PLATFORM_CORE_DIRECT_ROUTES[@]}"; do
			status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 "http://127.0.0.1:4200$path" || true)"
			[[ "$core_mode:$status" =~ ^(running:(404|410)|stopped:000)$ ]] ||
				platform_cleanup_fail "legacy direct Core route remains reachable: $path status=$status" || return 1
			printf 'core_%s_status=%s\n' "$(tr '/-' '__' <<<"${path#/api/v1/}" | tr -d '\n')" "$status"
		done
		printf 'observed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$partial"
	platform_cleanup_promote_evidence "$partial" "$destination"
	platform_cleanup_validate_evidence "$destination" platform-core-cleanup-routes \
		"$EXPECTED_REVISION" "$generation"
}

platform_cleanup_assert_credential_scope() {
	local core platform_api platform_publisher key service
	platform_api="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q platform-api)" || return 1
	platform_publisher="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q platform-outbox-publisher)" || return 1
	[[ "$platform_api" =~ ^[0-9a-f]{64}$ && "$platform_publisher" =~ ^[0-9a-f]{64}$ ]] || return 1
	local core_keys api_keys publisher_keys
	api_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$platform_api" | awk -F= '{print $1}' | LC_ALL=C sort -u)" || return 1
	publisher_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$platform_publisher" | awk -F= '{print $1}' | LC_ALL=C sort -u)" || return 1
	for service in "${PLATFORM_CORE_RUNTIME_ROLES[@]}"; do
		core="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --all -q "$service")" || return 1
		[[ "$core" =~ ^[0-9a-f]{64}$ ]] || return 1
		core_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$core" |
			awk -F= '{print $1}' | LC_ALL=C sort -u)" || return 1
		for key in "${PLATFORM_CREDENTIALS_FORBIDDEN_IN_CORE[@]}"; do
			! grep -Fxq "$key" <<<"$core_keys" ||
				platform_cleanup_fail "Core $service still receives Platform-owned credential $key." || return 1
		done
	done
	for key in PLATFORM_DATABASE_URL IDENTITY_PLATFORM_TOKEN; do
		grep -Fxq "$key" <<<"$api_keys" || return 1
	done
	for key in PLATFORM_DATABASE_URL RABBITMQ_URL; do
		grep -Fxq "$key" <<<"$publisher_keys" || return 1
	done
}

platform_cleanup_validate_frontend_evidence() {
	[[ $# -eq 1 ]] || return 1
	local generation
	generation="$(platform_cutover_marker_value generation)" || return 1
	platform_cleanup_validate_evidence "$1" platform-core-cleanup-frontend "$EXPECTED_REVISION" "$generation" || return 1
	awk -F= \
		-v frontend_revision="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" \
		-v origin_sha="$(platform_cleanup_frontend_origin_sha256)" \
		-v challenge="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
		-v attestation="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
		-v signature="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
		-v public_key="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" '
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["frontend_revision"] != frontend_revision ||
				value["frontend_origin_sha256"] != origin_sha || value["frontend_challenge"] != challenge ||
				value["frontend_attestation_sha256"] != attestation ||
				value["frontend_signature_sha256"] != signature ||
				value["frontend_public_key_sha256"] != public_key ||
				value["signed_runtime_attestation_valid"] != "true" ||
				value["public_payment_binding_valid"] != "true" ||
				value["validator_output_sha256"] !~ /^[0-9a-f]{64}$/) exit 1
		}
	' "$1"
}

platform_cleanup_validate_bound_frontend_evidence() {
	[[ $# -eq 1 ]] || return 1
	local generation expected_sha
	generation="$(platform_cutover_marker_value generation)" || return 1
	expected_sha="$(platform_cleanup_marker_value frontend_evidence_sha256)" || return 1
	[[ "$expected_sha" =~ ^[0-9a-f]{64}$ &&
		"$(platform_cleanup_sha256 "$1")" == "$expected_sha" ]] || return 1
	platform_cleanup_validate_evidence "$1" platform-core-cleanup-frontend "$EXPECTED_REVISION" "$generation" || return 1
	awk -F= \
		-v frontend_revision="$(platform_cleanup_marker_value frontend_revision)" \
		-v origin_sha="$(platform_cleanup_marker_value frontend_origin_sha256)" \
		-v challenge="$(platform_cleanup_marker_value frontend_challenge)" \
		-v attestation="$(platform_cleanup_marker_value frontend_attestation_sha256)" \
		-v signature="$(platform_cleanup_marker_value frontend_signature_sha256)" \
		-v public_key="$(platform_cleanup_marker_value frontend_public_key_sha256)" '
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["frontend_revision"] != frontend_revision ||
				value["frontend_origin_sha256"] != origin_sha || value["frontend_challenge"] != challenge ||
				value["frontend_attestation_sha256"] != attestation ||
				value["frontend_signature_sha256"] != signature ||
				value["frontend_public_key_sha256"] != public_key ||
				value["signed_runtime_attestation_valid"] != "true" ||
				value["public_payment_binding_valid"] != "true" ||
				value["validator_output_sha256"] !~ /^[0-9a-f]{64}$/) exit 1
		}
	' "$1"
}

platform_cleanup_require_stable_frontend_identity() {
	platform_cleanup_validate_marker || return 1
	[[ "$(platform_cleanup_marker_value frontend_revision)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" &&
		"$(platform_cleanup_marker_value frontend_origin_sha256)" == "$(platform_cleanup_frontend_origin_sha256)" &&
		"$(platform_cleanup_marker_value frontend_public_key_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" ]] ||
		platform_cleanup_fail 'cleanup frontend revision, origin or trusted key differs from the immutable staged identity.'
}

platform_cleanup_validate_frontend_phase_chain() {
	[[ $# -eq 1 ]] || return 1
	platform_cleanup_validate_private_file "$1" || return 1
	platform_cleanup_node - "$1" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
if (!source.endsWith('\n')) process.exit(1);
const lines = source.slice(0, -1).split('\n');
if (lines[0] !== 'version=1') process.exit(1);
let prefix = 'version=1\n';
const challenges = new Set();
const attestations = new Set();
const signatures = new Set();
let last = ['0', '-', '-', '-', '-', '-', crypto.createHash('sha256').update(prefix).digest('hex')];
for (let index = 1; index < lines.length; index += 1) {
  const row = lines[index].split('\t');
  if (row.length !== 7 || row[0] !== String(index) ||
      !['seal', 'run', 'forward-recovery', 'verify'].includes(row[1]) ||
      !/^[0-9a-f]{64}$/.test(row[2]) || !/^[0-9a-f]{64}$/.test(row[3]) ||
      !/^[0-9a-f]{64}$/.test(row[4]) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row[5]) ||
      !/^[0-9a-f]{64}$/.test(row[6]) ||
      row[6] !== crypto.createHash('sha256').update(prefix).digest('hex') ||
      challenges.has(row[2]) || attestations.has(row[3]) || signatures.has(row[4])) process.exit(1);
  challenges.add(row[2]); attestations.add(row[3]); signatures.add(row[4]);
  prefix += `${lines[index]}\n`;
  last = row;
}
process.stdout.write(`${lines.length - 1}|${last.join('|')}`);
NODE
}

platform_cleanup_frontend_phase_chain_contains_sha() {
	[[ $# -eq 3 && "$2" =~ ^[0-9a-f]{64}$ && "$3" =~ ^(seal|run|forward-recovery|verify)$ ]] || return 1
	platform_cleanup_validate_frontend_phase_chain "$1" >/dev/null || return 1
	platform_cleanup_node - "$1" "$2" "$3" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [file, expectedSha, expectedAction] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
let prefix = `${lines[0]}\n`;
let found = false;
for (let index = 1; index < lines.length; index += 1) {
  prefix += `${lines[index]}\n`;
  const row = lines[index].split('\t');
  if (crypto.createHash('sha256').update(prefix).digest('hex') === expectedSha &&
      row[1] === expectedAction) found = true;
}
if (!found) process.exit(1);
NODE
}

platform_cleanup_initialize_frontend_phase_chain() {
	[[ $# -eq 1 ]] || return 1
	local chain="$1/frontend-phase-evidence.chain" candidate
	platform_cleanup_validate_private_directory "$1" || return 1
	if [[ ! -e "$chain" && ! -L "$chain" ]]; then
		candidate="$(mktemp "$1/.frontend-phase-evidence.XXXXXX")" || return 1
		printf 'version=1\n' >"$candidate"
		platform_cleanup_promote_evidence "$candidate" "$chain" || return 1
	fi
	platform_cleanup_validate_frontend_phase_chain "$chain" >/dev/null || return 1
	platform_cleanup_sha256 "$chain"
}

platform_cleanup_record_fresh_frontend_phase_evidence() {
	[[ $# -eq 2 && "$1" =~ ^(seal|run|forward-recovery|verify)$ ]] || return 1
	local action="$1" directory="$2" chain="$2/frontend-phase-evidence.chain"
	local state count last_sequence last_action last_challenge last_attestation last_signature
	local last_validated_at last_previous marker_sha actual_sha phase candidate next validated_at
	platform_cleanup_require_stable_frontend_identity || return 1
	# Validate age, signature, exact public runtime and immutable stable identity
	# before reconciling or consuming this action-specific challenge.
	platform_cleanup_attest_current_frontend_runtime "$directory" || return 1
	state="$(platform_cleanup_validate_frontend_phase_chain "$chain")" || return 1
	IFS='|' read -r count last_sequence last_action last_challenge last_attestation \
		last_signature last_validated_at last_previous <<<"$state"
	[[ "$count" =~ ^[0-9]+$ && "$last_sequence" =~ ^[0-9]+$ &&
		( "$last_validated_at" == - ||
			"$last_validated_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ) ]] || return 1
	actual_sha="$(platform_cleanup_sha256 "$chain")" || return 1
	marker_sha="$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)" || return 1
	phase="$(platform_cleanup_marker_value phase)" || return 1
	if [[ "$actual_sha" != "$marker_sha" ]]; then
		# Only one fully written trailing entry may be adopted after an interruption
		# between durable chain replacement and atomic marker replacement.
		[[ "$count" -gt 0 && "$last_previous" == "$marker_sha" ]] ||
			platform_cleanup_fail 'frontend phase evidence chain differs from its cleanup marker.' || return 1
		platform_cleanup_update_marker "$phase" frontend_phase_evidence_chain_sha256 "$actual_sha" || return 1
		marker_sha="$actual_sha"
	fi
	[[ "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" != "$(platform_cleanup_marker_value frontend_challenge)" &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" != "$(platform_cleanup_marker_value frontend_attestation_sha256)" &&
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" != "$(platform_cleanup_marker_value frontend_signature_sha256)" ]] ||
		platform_cleanup_fail 'fresh frontend phase evidence replays the immutable staged attestation.' || return 1
	if awk -F='\t' \
		-v challenge="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
		-v attestation="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
		-v signature="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
		'NR > 1 && ($3 == challenge || $4 == attestation || $5 == signature) { found += 1 } END { exit(found ? 0 : 1) }' \
		"$chain"; then
		[[ "$last_action" == "$action" &&
			"$last_challenge" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" &&
			"$last_attestation" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" &&
			"$last_signature" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" ]] ||
			platform_cleanup_fail 'frontend phase challenge or signed artifact replay was rejected.' || return 1
		# Exact same fresh receipt is an idempotent retry of the same action.
		return 0
	fi
	next=$((count + 1))
	validated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	candidate="$(mktemp "$directory/.frontend-phase-evidence.XXXXXX")" || return 1
	cp -- "$chain" "$candidate"
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$next" "$action" \
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
		"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
		"$validated_at" "$marker_sha" >>"$candidate"
	chmod 600 "$candidate"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$candidate"; fi
	platform_cleanup_validate_frontend_phase_chain "$candidate" >/dev/null || { rm -f -- "$candidate"; return 1; }
	sync -f "$candidate"
	mv -fT -- "$candidate" "$chain"
	sync -f "$chain"
	sync -f "$directory"
	actual_sha="$(platform_cleanup_sha256 "$chain")" || return 1
	platform_cleanup_update_marker "$phase" frontend_phase_evidence_chain_sha256 "$actual_sha" || return 1
	[[ "$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)" == "$actual_sha" ]]
}

platform_cleanup_attest_frontend_runtime() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" directory raw candidate raw_sha generation validator_image_id
	directory="$(dirname -- "$destination")"
	platform_cleanup_validate_private_directory "$directory" || return 1
	platform_cleanup_require_frontend_attestation_inputs || return 1
	validator_image_id="$(platform_cleanup_candidate_frontend_validator_image_id)" || return 1
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		[[ "$validator_image_id" == "$(platform_cleanup_marker_value frontend_validator_image_id)" ]] || return 1
	fi
	raw="$(mktemp "$directory/.frontend-attestation-output.XXXXXX")" || return 1
	candidate="$(mktemp "$directory/.frontend-attestation-evidence.XXXXXX")" || { rm -f -- "$raw"; return 1; }
	if ! PLATFORM_BACKEND_REVISION="$EXPECTED_REVISION" \
		PLATFORM_FRONTEND_REVISION="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" \
		PLATFORM_CUTOVER_GENERATION="$(platform_cutover_marker_value generation)" \
		PLATFORM_FRONTEND_RUNTIME_CHALLENGE="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
		PLATFORM_FRONTEND_ORIGIN="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ORIGIN" \
		PLATFORM_FRONTEND_EXPECTED_ATTESTATION_SHA256="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
		PLATFORM_FRONTEND_EXPECTED_SIGNATURE_SHA256="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
		PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" \
		PLATFORM_FRONTEND_ATTESTATION_VALIDATOR_IMAGE="$validator_image_id" \
		PLATFORM_FRONTEND_ATTESTATION_MAX_AGE_SECONDS=600 \
		bash "$SERVER_ROOT/scripts/platform-frontend-runtime-attestation.sh" --validate >"$raw"; then
		rm -f -- "$raw" "$candidate"; return 1
	fi
	awk -F= \
		-v frontend_revision="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" \
		-v frontend_origin="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ORIGIN" \
		-v frontend_challenge="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
		-v attestation_sha="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
		-v signature_sha="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
		-v public_key_sha="$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" '
		$1 !~ /^(platform_frontend_runtime_attestation|platform_frontend_revision|platform_frontend_origin|platform_frontend_runtime_challenge|platform_frontend_runtime_build_id|platform_frontend_runtime_attestation_sha256|platform_frontend_runtime_signature_sha256|platform_frontend_runtime_trusted_public_key_sha256|platform_frontend_runtime_build_manifest_sha256|platform_frontend_runtime_payment_asset_path|platform_frontend_runtime_payment_asset_sha256|platform_frontend_runtime_local_payment_html_sha256|platform_frontend_runtime_public_payment_html_sha256|platform_frontend_runtime_payment_executable_graph_sha256|platform_frontend_runtime_verified_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != 15) exit 1
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["platform_frontend_runtime_attestation"] != "valid" ||
				value["platform_frontend_revision"] != frontend_revision ||
				value["platform_frontend_origin"] != frontend_origin ||
				value["platform_frontend_runtime_challenge"] != frontend_challenge ||
				value["platform_frontend_runtime_attestation_sha256"] != attestation_sha ||
				value["platform_frontend_runtime_signature_sha256"] != signature_sha ||
				value["platform_frontend_runtime_trusted_public_key_sha256"] != public_key_sha ||
				value["platform_frontend_runtime_build_id"] !~ /^[A-Za-z0-9._-]+$/ ||
				value["platform_frontend_runtime_build_manifest_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_frontend_runtime_payment_asset_path"] !~ /^\/[A-Za-z0-9._~!$&()*+,;=:@%\/-]+$/ ||
				value["platform_frontend_runtime_payment_asset_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_frontend_runtime_local_payment_html_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_frontend_runtime_public_payment_html_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_frontend_runtime_payment_executable_graph_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_frontend_runtime_verified_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) exit 1
		}
	' "$raw" || { rm -f -- "$raw" "$candidate"; return 1; }
	raw_sha="$(platform_cleanup_sha256 "$raw")" || { rm -f -- "$raw" "$candidate"; return 1; }
	generation="$(platform_cutover_marker_value generation)" || { rm -f -- "$raw" "$candidate"; return 1; }
	{
		printf 'version=1\naction=platform-core-cleanup-frontend\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\ngeneration=%s\n' \
			"$(platform_cutover_marker_value revision)" "$EXPECTED_REVISION" "$generation"
		platform_cleanup_print_evidence_identity
		printf 'frontend_revision=%s\nfrontend_origin_sha256=%s\nfrontend_challenge=%s\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" \
			"$(platform_cleanup_frontend_origin_sha256)" \
			"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE"
		printf 'frontend_attestation_sha256=%s\nfrontend_signature_sha256=%s\nfrontend_public_key_sha256=%s\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
			"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
			"$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256"
		printf 'validator_output_sha256=%s\nsigned_runtime_attestation_valid=true\npublic_payment_binding_valid=true\n' "$raw_sha"
		printf 'observed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$candidate"
	rm -f -- "$raw"
	if [[ -e "$destination" || -L "$destination" ]]; then
		platform_cleanup_validate_frontend_evidence "$destination" || { rm -f -- "$candidate"; return 1; }
		# observed_at may differ; every identity and the signed validator output must remain exact.
		awk -F= '$1 != "observed_at" { print }' "$candidate" >"${candidate}.stable"
		awk -F= '$1 != "observed_at" { print }' "$destination" >"${candidate}.existing"
		cmp -s -- "${candidate}.stable" "${candidate}.existing" || {
			rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"; return 1;
		}
		rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"
	else
		platform_cleanup_promote_evidence "$candidate" "$destination" || return 1
	fi
	platform_cleanup_validate_frontend_evidence "$destination"
}

platform_cleanup_attest_current_frontend_runtime() (
	[[ $# -eq 1 ]] || return 1
	local parent="$1" directory evidence
	platform_cleanup_validate_private_directory "$parent" || return 1
	directory="$(mktemp -d "$parent/.frontend-live-attestation.XXXXXX")" || return 1
	chmod 700 "$directory"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$directory"; fi
	evidence="$directory/evidence"
	trap 'rm -f -- "$evidence"; rmdir -- "$directory" 2>/dev/null || true' EXIT INT TERM
	platform_cleanup_attest_frontend_runtime "$evidence" || return 1
	platform_cleanup_validate_frontend_evidence "$evidence"
)

platform_cleanup_attest_or_revalidate_frontend_runtime() (
	[[ $# -eq 1 ]] || return 1
	local destination="$1" parent bound_sha candidate_directory candidate
	parent="$(dirname -- "$destination")"
	bound_sha="$(platform_cleanup_marker_value frontend_evidence_sha256)" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		if [[ "$bound_sha" == pending ]]; then
			platform_cleanup_validate_private_file "$destination" || return 1
			candidate_directory="$(mktemp -d "$parent/.frontend-rebind.XXXXXX")" || return 1
			chmod 700 "$candidate_directory"
			if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$candidate_directory"; fi
			candidate="$candidate_directory/evidence"
			trap 'rm -f -- "$candidate"; rmdir -- "$candidate_directory" 2>/dev/null || true' EXIT INT TERM
			platform_cleanup_attest_frontend_runtime "$candidate" || return 1
			mv -f -- "$candidate" "$destination"
			sync -f "$destination"
			sync -f "$parent"
			rmdir -- "$candidate_directory"
			trap - EXIT INT TERM
			platform_cleanup_validate_frontend_evidence "$destination"
		else
			platform_cleanup_validate_bound_frontend_evidence "$destination" || return 1
			platform_cleanup_attest_current_frontend_runtime "$parent"
		fi
	else
		[[ "$bound_sha" == pending ]] || return 1
		platform_cleanup_attest_frontend_runtime "$destination"
	fi
)

platform_cleanup_validate_topology_evidence() {
	[[ $# -eq 1 ]] || return 1
	local generation
	generation="$(platform_cutover_marker_value generation)" || return 1
	platform_cleanup_validate_evidence "$1" platform-core-cleanup-topology "$EXPECTED_REVISION" "$generation" || return 1
	awk -F= -v compose_sha="$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" '
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["canonical_compose_sha256"] != compose_sha ||
				value["rendered_compose_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["deployment_manifest_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["legacy_runtime_references"] != "0" ||
				value["core_platform_credentials"] != "0") exit 1
		}
	' "$1"
}

platform_cleanup_validate_rendered_topology() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	platform_cleanup_node - "$1" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const forbidden = new Set(['PLATFORM_DATABASE_URL','PLATFORM_MIGRATION_DATABASE_URL','PLATFORM_BACKUP_URL','PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE','DATABASE_RESTORE_PLATFORM_ADMIN_PASSWORD_FILE','IDENTITY_PLATFORM_TOKEN','RABBITMQ_PLATFORM_PUBLISHER_URL','PLATFORM_CORE_DATABASE_URL']);
const retiredRuntime = /billing\.settings\.source\.changed\.v1|winwidget\.billing\.settings-source\.v1|billing-settings-source|src\/(site-settings|legal-pages|home-page-content|platform-boundary)/;
const retiredCoreRoute = /\/api\/v1\/(site-settings|legal-pages|home-page-content)(?:[/?#"']|$)/;
const services = value.services || {};
if (!services || typeof services !== 'object' || Array.isArray(services)) process.exit(1);
for (const service of Object.values(services)) {
  if (!service || typeof service !== 'object' || retiredRuntime.test(JSON.stringify(service))) process.exit(1);
}
for (const name of ['api','outbox-publisher','integration-worker']) {
  const service = services[name];
  if (!service) process.exit(1);
  const environment = Array.isArray(service.environment)
    ? Object.fromEntries(service.environment.map(item => [String(item).split('=', 1)[0], item]))
    : (service.environment || {});
  if ([...forbidden].some(key => Object.hasOwn(environment, key))) process.exit(1);
  if (retiredCoreRoute.test(JSON.stringify(service))) process.exit(1);
}
NODE
}

platform_cleanup_scan_deployment_topology() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" directory rendered manifest candidate path rendered_sha manifest_sha generation
	local -a deployment_paths=()
	directory="$(dirname -- "$destination")"
	platform_cleanup_validate_private_directory "$directory" || return 1
	rendered="$(mktemp "$directory/.compose-rendered.XXXXXX")" || return 1
	manifest="$(mktemp "$directory/.deployment-manifest.XXXXXX")" || { rm -f -- "$rendered"; return 1; }
	candidate="$(mktemp "$directory/.topology-evidence.XXXXXX")" || { rm -f -- "$rendered" "$manifest"; return 1; }
	if ! platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" config --format json >"$rendered"; then
		rm -f -- "$rendered" "$manifest" "$candidate"; return 1
	fi
	platform_cleanup_validate_rendered_topology "$rendered" || {
		rm -f -- "$rendered" "$manifest" "$candidate"; return 1;
	}
	mapfile -t deployment_paths < <(git -C "$SERVER_ROOT" ls-files \
		deploy .github Dockerfile .dockerignore .env.example ':(glob)apps/**/Dockerfile*' \
		scripts/deploy-production.sh \
		scripts/deploy-platform-production.sh scripts/platform-release-identity.sh | LC_ALL=C sort)
	(( ${#deployment_paths[@]} > 0 )) || { rm -f -- "$rendered" "$manifest" "$candidate"; return 1; }
	for path in "${!deployment_paths[@]}"; do deployment_paths[$path]="$SERVER_ROOT/${deployment_paths[$path]}"; done
	# The rendered Compose model is the executable deployment surface. The
	# tracked deployment manifest is integrity evidence only; controller tests
	# and negative guards are deliberately not interpreted as live topology.
	for path in "${deployment_paths[@]}"; do
		[[ "$path" != *$'\n'* && -f "$path" && ! -L "$path" ]] || {
			rm -f -- "$rendered" "$manifest" "$candidate"; return 1;
		}
		printf '%s|%s\n' "${path#"$SERVER_ROOT/"}" "$(platform_cleanup_sha256 "$path")" >>"$manifest"
	done
	[[ -s "$manifest" ]] || { rm -f -- "$rendered" "$manifest" "$candidate"; return 1; }
	rendered_sha="$(platform_cleanup_sha256 "$rendered")"
	manifest_sha="$(platform_cleanup_sha256 "$manifest")"
	generation="$(platform_cutover_marker_value generation)" || { rm -f -- "$rendered" "$manifest" "$candidate"; return 1; }
	{
		printf 'version=1\naction=platform-core-cleanup-topology\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\ngeneration=%s\n' \
			"$(platform_cutover_marker_value revision)" "$EXPECTED_REVISION" "$generation"
		platform_cleanup_print_evidence_identity
		printf 'canonical_compose_sha256=%s\nrendered_compose_sha256=%s\ndeployment_manifest_sha256=%s\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" "$rendered_sha" "$manifest_sha"
		printf 'legacy_runtime_references=0\ncore_platform_credentials=0\nobserved_at=%s\n' \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$candidate"
	rm -f -- "$rendered" "$manifest"
	if [[ -e "$destination" || -L "$destination" ]]; then
		platform_cleanup_validate_topology_evidence "$destination" || { rm -f -- "$candidate"; return 1; }
		awk -F= '$1 != "observed_at" { print }' "$candidate" >"${candidate}.stable"
		awk -F= '$1 != "observed_at" { print }' "$destination" >"${candidate}.existing"
		cmp -s -- "${candidate}.stable" "${candidate}.existing" || {
			rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"; return 1;
		}
		rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"
	else
		platform_cleanup_promote_evidence "$candidate" "$destination" || return 1
	fi
	platform_cleanup_validate_topology_evidence "$destination"
}

platform_cleanup_queue_listing() {
	local container vhost
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget ]] || return 1
	docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers | LC_ALL=C sort
}

platform_cleanup_validate_queue_listing() {
	awk '
		$1 ~ /^winwidget\.billing\.offer\.v1(\.retry\.[123]|\.dead-letter)?$/ { legacy += 1 }
		$1 ~ /^winwidget\.billing\.settings-source\.v1(\.retry\.[123]|\.dead-letter)?$/ { legacy += 1 }
		$1 ~ /^winwidget\.billing\.offer\.v1/ &&
			$1 !~ /^winwidget\.billing\.offer\.v1(\.retry\.[123]|\.dead-letter)?$/ { bad += 1 }
		$1 ~ /^winwidget\.billing\.settings-source\.v1/ &&
			$1 !~ /^winwidget\.billing\.settings-source\.v1(\.retry\.[123]|\.dead-letter)?$/ { bad += 1 }
		$1 ~ /^winwidget\.billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?$/ {
			v2 += 1; if ($2 != "true" || $3 != 0 || $4 != 0) bad += 1;
			if (($1 == "winwidget.billing.offer.v2" && $5 != 1) || ($1 != "winwidget.billing.offer.v2" && $5 != 0)) bad += 1
		}
		$1 ~ /^winwidget\.billing\.offer\.v2/ &&
			$1 !~ /^winwidget\.billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?$/ { bad += 1 }
		$1 ~ /^winwidget\.admin\.audit\.platform\.v1(\.retry-v2\.[123]|\.dead-letter)?$/ {
			audit += 1; if ($2 != "true" || $3 != 0 || $4 != 0) bad += 1;
			if (($1 == "winwidget.admin.audit.platform.v1" && $5 != 1) || ($1 != "winwidget.admin.audit.platform.v1" && $5 != 0)) bad += 1
		}
		$1 ~ /^winwidget\.admin\.audit\.platform\.v1/ &&
			$1 !~ /^winwidget\.admin\.audit\.platform\.v1(\.retry-v2\.[123]|\.dead-letter)?$/ { bad += 1 }
		END { exit(legacy == 0 && v2 == 5 && audit == 5 && bad == 0 ? 0 : 1) }
	'
}

platform_cleanup_assert_legacy_settings_source_bindings_absent() {
	local container vhost listing
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget ]] || return 1
	listing="$(docker exec "$container" rabbitmqctl --silent list_bindings -p "$vhost" \
		source_name destination_name destination_kind routing_key)" || return 1
	! awk '$1 ~ /billing\.settings-source/ || $2 ~ /billing\.settings-source/ || $4 == "billing.settings.source.changed.v1" { found=1 } END { exit(found ? 0 : 1) }' \
		<<<"$listing"
}

platform_cleanup_retire_legacy_settings_source_topology() {
	local container vhost listing queue
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget ]] || return 1
	listing="$(docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers)" || return 1
	awk '
		$1 ~ /^winwidget\.billing\.settings-source\.v1(\.retry\.[123]|\.dead-letter)?$/ {
			seen[$1] += 1
			if ($2 != "true" || $3 != 0 || $4 != 0 || $5 != 0) invalid = 1
		}
		$1 ~ /^winwidget\.billing\.settings-source\.v1/ &&
			$1 !~ /^winwidget\.billing\.settings-source\.v1(\.retry\.[123]|\.dead-letter)?$/ { invalid = 1 }
		END { for (queue in seen) if (seen[queue] != 1) invalid = 1; exit(invalid ? 1 : 0) }
	' <<<"$listing" || platform_cleanup_fail 'legacy Billing settings-source queues are not safely retirable.' || return 1
	for queue in winwidget.billing.settings-source.v1 \
		winwidget.billing.settings-source.v1.retry.1 \
		winwidget.billing.settings-source.v1.retry.2 \
		winwidget.billing.settings-source.v1.retry.3 \
		winwidget.billing.settings-source.v1.dead-letter; do
		if awk -v queue="$queue" '$1 == queue { found += 1 } END { exit(found == 1 ? 0 : 1) }' <<<"$listing"; then
			docker exec "$container" rabbitmqctl --silent delete_queue -p "$vhost" "$queue" \
				--if-empty --if-unused >/dev/null || return 1
		fi
	done
	platform_cleanup_assert_legacy_settings_source_bindings_absent
}

platform_cleanup_assert_queues() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" partial="${1}.partial.$$" listing generation listing_sha
	generation="$(platform_cutover_marker_value generation)" || return 1
	listing="$(platform_cleanup_queue_listing)" || return 1
	platform_cleanup_validate_queue_listing <<<"$listing" ||
		platform_cleanup_fail 'Platform exact queues are not empty and uniquely owned.' || return 1
	platform_cleanup_assert_legacy_settings_source_bindings_absent ||
		platform_cleanup_fail 'legacy Billing settings-source binding family remains.' || return 1
	listing_sha="$(printf '%s\n' "$listing" | platform_cleanup_sha256 /dev/stdin)" || return 1
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	{
		printf 'version=1\naction=platform-core-cleanup-queues\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\ngeneration=%s\n' \
			"$(platform_cutover_marker_value revision)" "$EXPECTED_REVISION" "$generation"
		platform_cleanup_print_evidence_identity
		printf 'legacy_billing_offer_v1_queues=0\nlegacy_billing_settings_source_queues=0\nlegacy_billing_settings_source_bindings=0\nbilling_offer_v2_queues=5\nplatform_admin_audit_queues=5\n'
		printf 'messages_ready=0\nmessages_unacknowledged=0\nqueue_listing_sha256=%s\n' "$listing_sha"
		printf 'observed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$partial"
	platform_cleanup_promote_evidence "$partial" "$destination"
	platform_cleanup_validate_evidence "$destination" platform-core-cleanup-queues \
		"$EXPECTED_REVISION" "$generation"
}

platform_cleanup_assert_outbox() {
	[[ $# -eq 2 && "$2" =~ ^[01]$ ]] || return 1
	local destination="$1" expected_cursor="$2" partial="${1}.partial.$$" generation core_state platform_state
	generation="$(platform_cutover_marker_value generation)" || return 1
	core_state="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT
 (SELECT count(*) FROM public.outbox_events WHERE status <> 'PUBLISHED'::public.\"OutboxEventStatus\" AND
	   (event_type IN ('billing.offer.changed.v1','billing.settings.source.changed.v1','platform.settings.changed.v1','platform.legal-page.changed.v1','platform.home-page-content.changed.v1') OR
    (event_type='admin.audit.event.v1' AND routing_key='admin.audit.platform.v1')))::text || '|' ||
	 (SELECT count(*) FROM public.integration_delivery_receipts WHERE integration IN ('platform-admin-audit','billing-settings-source') AND status IN
   ('PROCESSING'::public.\"IntegrationDeliveryReceiptStatus\",'RETRY_SCHEDULED'::public.\"IntegrationDeliveryReceiptStatus\"))::text || '|' ||
	 (SELECT count(*) FROM public.integration_delivery_failures WHERE integration IN ('platform-admin-audit','billing-settings-source') AND resolved_at IS NULL)::text || '|' ||
 (SELECT count(*) FROM public.billing_source_aggregate_versions WHERE aggregate_type='billing.offer' AND aggregate_id='offer')::text;")" || return 1
	platform_state="$(platform_cleanup_query PLATFORM_BACKUP_URL "
SELECT
 (SELECT count(*) FROM platform.outbox_events WHERE status <> 'PUBLISHED'::platform.\"OutboxStatus\")::text || '|' ||
 (SELECT count(*) FROM platform.service_identity WHERE id='singleton' AND phase='ACTIVE'::platform.\"ServiceDatabasePhase\")::text || '|' ||
 (SELECT count(*) FROM platform.billing_offer_producer_state WHERE id='offer' AND phase='ACTIVE'::platform.\"OfferProducerPhase\")::text;")" || return 1
	[[ "$core_state" == "0|0|0|$expected_cursor" && "$platform_state" == '0|1|1' ]] ||
		platform_cleanup_fail "Platform durable drain is incomplete: core=$core_state platform=$platform_state" || return 1
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	{
		printf 'version=1\naction=platform-core-cleanup-outbox\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\ngeneration=%s\n' \
			"$(platform_cutover_marker_value revision)" "$EXPECTED_REVISION" "$generation"
		platform_cleanup_print_evidence_identity
		printf 'core_unpublished_platform_events=0\ncore_active_platform_receipts=0\ncore_unresolved_platform_failures=0\n'
		printf 'platform_unpublished_outbox=0\nlegacy_billing_offer_cursor_rows=%s\n' "$expected_cursor"
		printf 'observed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$partial"
	platform_cleanup_promote_evidence "$partial" "$destination"
	platform_cleanup_validate_evidence "$destination" platform-core-cleanup-outbox \
		"$EXPECTED_REVISION" "$generation"
}

platform_cleanup_dump() {
	[[ $# -eq 4 ]] || return 1
	local url_key="$1" schema="$2" output="$3" expected="$4" directory temporary
	local username password hostname port database existing
	[[ "$url_key" =~ ^(DATABASE_BACKUP_URL|PLATFORM_BACKUP_URL)$ &&
		"$schema" =~ ^(public|platform)$ && "$output" == /* &&
		"$expected" =~ ^(pending|[0-9a-f]{64})$ ]] || return 1
	directory="$(dirname -- "$output")"
	platform_cleanup_validate_private_directory "$directory" || return 1
	if [[ -f "$output" && ! -L "$output" ]]; then
		platform_cleanup_validate_private_file "$output" || return 1
		existing="$(platform_cleanup_sha256 "$output")" || return 1
		if [[ "$expected" == pending ]]; then
			bash "$SERVER_ROOT/scripts/test-platform-core-source-cleanup-rehearsal.sh" \
				--validate-dump "$output" ||
				platform_cleanup_fail 'existing cleanup dump cannot be safely adopted.' || return 1
		else
			[[ "$existing" == "$expected" ]] ||
				platform_cleanup_fail 'refusing a changed cleanup dump.' || return 1
		fi
		printf '%s\n' "$existing"
		return
	fi
	[[ ! -e "$output" && ! -L "$output" ]] || return 1
	username="$(platform_cleanup_database_url_field "$url_key" username)" || return 1
	password="$(platform_cleanup_database_url_field "$url_key" password)" || return 1
	hostname="$(platform_cleanup_database_url_field "$url_key" hostname)" || return 1
	port="$(platform_cleanup_database_url_field "$url_key" port)" || return 1
	database="$(platform_cleanup_database_url_field "$url_key" database)" || return 1
	temporary="$(mktemp "$directory/.$(basename -- "$output").partial.XXXXXX")" || return 1
	if ! PGPASSWORD="$password" platform_database_docker run --rm --network host --env PGPASSWORD \
		--mount "type=bind,source=$directory,target=/output" --entrypoint pg_dump \
		"$PLATFORM_CORE_SOURCE_CLEANUP_POSTGRES_IMAGE" --host "$hostname" --port "$port" \
		--username "$username" --dbname "$database" --format custom --compress=9 \
		--no-owner --no-acl --schema "$schema" --file "/output/$(basename -- "$temporary")"; then
		rm -f -- "$temporary"
		unset password
		return 1
	fi
	unset password
	[[ -s "$temporary" && "$(head -c 5 "$temporary")" == PGDMP ]] || {
		rm -f -- "$temporary"; return 1;
	}
	chmod 600 "$temporary"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$temporary"; fi
	sync -f "$temporary"
	[[ ! -e "$output" && ! -L "$output" ]] || { rm -f -- "$temporary"; return 1; }
	ln -- "$temporary" "$output"
	rm -f -- "$temporary"
	sync -f "$output"
	sync -f "$directory"
	platform_cleanup_validate_private_file "$output" || return 1
	platform_cleanup_sha256 "$output"
}

platform_cleanup_restore_pre() {
	[[ $# -eq 3 ]] || return 1
	bash "$SERVER_ROOT/scripts/test-platform-core-source-cleanup-rehearsal.sh" \
		--restore-pre "$1" "$2" "$3" "$EXPECTED_REVISION" \
		"$(platform_cutover_marker_value revision)" \
		"$(platform_cutover_marker_value generation)" \
		"$(platform_cutover_marker_value source_fingerprint)" \
		"$(platform_cutover_marker_value source_high_watermark)" \
		"$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
		"$(platform_cleanup_marker_value core_database_name)" \
		"$(platform_cleanup_marker_value core_database_system_identifier)" \
		"$(platform_cleanup_marker_value compose_sha256)"
}

platform_cleanup_restore_post() {
	[[ $# -eq 2 ]] || return 1
	bash "$SERVER_ROOT/scripts/test-platform-core-source-cleanup-rehearsal.sh" \
		--restore-post "$1" "$2" "$EXPECTED_REVISION" \
		"$(platform_cutover_marker_value revision)" \
		"$(platform_cutover_marker_value generation)" \
		"$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
		"$(platform_cleanup_marker_value core_database_name)" \
		"$(platform_cleanup_marker_value core_database_system_identifier)" \
		"$(platform_cleanup_marker_value compose_sha256)"
}

platform_cleanup_validate_migration_rehearsal() {
	[[ $# -ge 1 && $# -le 2 && ( -z "${2:-}" || "${2:-}" =~ ^[0-9a-f]{64}$ ) ]] || return 1
	local generation expected_marker_sha="${2:-}"
	generation="$(platform_cleanup_marker_value generation)" || return 1
	platform_cleanup_validate_evidence "$1" platform-core-cleanup-migration-rehearsal \
		"$EXPECTED_REVISION" "$generation" || return 1
	awk -F= \
		-v dump="$(platform_cleanup_marker_value core_pre_backup_sha256)" \
		-v migration="$(platform_cleanup_marker_value migration_sha256)" \
		-v manifest="$(platform_cleanup_marker_value prisma_manifest_sha256)" \
		-v ledger="$(platform_cleanup_marker_value prisma_pre_ledger_sha256)" \
		-v source_system="$(platform_cleanup_marker_value core_database_system_identifier)" \
		-v expected_marker_sha="$expected_marker_sha" '
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["core_dump_sha256"] != dump || value["migration_sha256"] != migration ||
				value["postgres_major"] != "18" || value["pre_source_state"] != "exact-active" ||
				value["post_source_state"] != "0|0|0|0|0|true" ||
				value["exact_migration_applied"] != "true" ||
				value["migration_role"] != "winwidget_migration" ||
				value["prisma_manifest_sha256"] != manifest ||
				value["prisma_pre_ledger_sha256"] != ledger ||
				value["restored_prisma_ledger_exact"] != "true" ||
				value["production_system_identifier_substituted_only_for_isolated_restore"] != "true" ||
				value["internal_network"] != "true" || value["no_host_ports"] != "true" ||
				value["resources_removed_before_evidence"] != "true" ||
				value["restored_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				value["restored_system_identifier"] == source_system ||
				value["marker_sha256"] !~ /^[0-9a-f]{64}$/ ||
				(expected_marker_sha != "" && value["marker_sha256"] != expected_marker_sha)) exit 1
		}
	' "$1"
}

platform_cleanup_rehearse_migration() {
	[[ $# -eq 1 ]] || return 1
	local directory="$1" destination candidate migration_file marker_sha
	platform_cleanup_validate_private_directory "$directory" || return 1
	destination="$directory/migration-rehearsal.evidence"
	candidate="$directory/.migration-rehearsal-candidate.$$"
	migration_file="$(platform_cleanup_migration_file)" || return 1
	marker_sha="$(platform_cleanup_sha256 "$platform_cleanup_marker")" || return 1
	[[ ! -e "$candidate" && ! -L "$candidate" ]] || return 1
	if ! bash "$SERVER_ROOT/scripts/test-platform-core-source-cleanup-rehearsal.sh" \
		--rehearse-pre "$directory/core-pre-cleanup.dump" "$migration_file" \
		"$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" "$platform_cleanup_marker" \
		"$directory/prisma-manifest.evidence" "$directory/prisma-ledger-pre.evidence" "$candidate"; then
		rm -f -- "$candidate"; return 1
	fi
	platform_cleanup_validate_migration_rehearsal "$candidate" "$marker_sha" || { rm -f -- "$candidate"; return 1; }
	if [[ -e "$destination" || -L "$destination" ]]; then
		platform_cleanup_validate_migration_rehearsal "$destination" || { rm -f -- "$candidate"; return 1; }
		awk -F= '$1 !~ /^(observed_at|restored_system_identifier)$/ { print }' "$candidate" >"${candidate}.stable"
		awk -F= '$1 !~ /^(observed_at|restored_system_identifier)$/ { print }' "$destination" >"${candidate}.existing"
		cmp -s -- "${candidate}.stable" "${candidate}.existing" || {
			rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"; return 1;
		}
		rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"
	else
		platform_cleanup_promote_evidence "$candidate" "$destination" || return 1
	fi
	platform_cleanup_sha256 "$destination"
}

platform_cleanup_require_artifact() {
	[[ $# -eq 2 && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	platform_cleanup_validate_private_file "$1" && [[ "$(platform_cleanup_sha256 "$1")" == "$2" ]]
}

platform_cleanup_validate_offsite_receipt() {
	[[ $# -eq 3 && "$2" =~ ^(pre|post)$ ]] || return 1
	local receipt="$1" phase="$2" directory="$3" generation revision
	platform_cleanup_validate_private_file "$receipt" || return 1
	platform_cleanup_validate_private_directory "$directory" || return 1
	generation="$(platform_cleanup_marker_value generation)" || return 1
	revision="$(platform_cleanup_marker_value cleanup_revision)" || return 1
	RECEIPT_PHASE="$phase" RECEIPT_REVISION="$revision" RECEIPT_GENERATION="$generation" \
		CORE_PRE_SHA="$(platform_cleanup_marker_value core_pre_backup_sha256)" \
		PLATFORM_PRE_SHA="$(platform_cleanup_marker_value platform_pre_backup_sha256)" \
		PRE_RESTORE_SHA="$(platform_cleanup_marker_value pre_restore_evidence_sha256)" \
		SOAK_SHA="$(platform_cleanup_marker_value soak_evidence_sha256)" \
		ROUTE_SHA="$(platform_cleanup_marker_value route_evidence_sha256)" \
		QUEUE_SHA="$(platform_cleanup_marker_value queue_evidence_sha256)" \
		OUTBOX_SHA="$(platform_cleanup_marker_value outbox_evidence_sha256)" \
		FIRST_COMPLETE_PROOF_SHA="$(platform_cleanup_marker_value first_complete_proof_sha256)" \
		MIGRATION_SHA="$(platform_cleanup_marker_value migration_sha256)" \
		PRE_RECEIPT_SHA="$(platform_cleanup_marker_value pre_offsite_receipt_sha256)" \
		CORE_POST_SHA="$(platform_cleanup_marker_value core_post_backup_sha256)" \
		POST_RESTORE_SHA="$(platform_cleanup_marker_value post_restore_evidence_sha256)" \
		PRODUCTION_ENV_SHA="$(platform_cleanup_marker_value production_env_sha256)" \
		COMPOSE_SHA="$(platform_cleanup_marker_value compose_sha256)" \
		CORE_DATABASE_NAME="$(platform_cleanup_marker_value core_database_name)" \
		CORE_DATABASE_SYSTEM_IDENTIFIER="$(platform_cleanup_marker_value core_database_system_identifier)" \
		OWNERSHIP_REVISION="$(platform_cleanup_marker_value ownership_revision)" \
		SNAPSHOT_SHA="$(platform_cleanup_marker_value snapshot_sha256)" \
		SOURCE_FINGERPRINT="$(platform_cleanup_marker_value source_fingerprint)" \
		SOURCE_HIGH_WATERMARK="$(platform_cleanup_marker_value source_high_watermark)" \
		BILLING_OFFER_CONTRACT_VERSION="$(platform_cleanup_marker_value billing_offer_contract_version)" \
		BILLING_OFFER_SEQUENCE_SCOPE="$(platform_cleanup_marker_value billing_offer_sequence_scope)" \
		BILLING_OFFER_AGGREGATE_VERSION="$(platform_cleanup_marker_value billing_offer_aggregate_version)" \
		BILLING_OFFER_SOURCE_SEQUENCE="$(platform_cleanup_marker_value billing_offer_source_sequence)" \
		BILLING_OFFER_FENCE_FINGERPRINT="$(platform_cleanup_marker_value billing_offer_fence_fingerprint)" \
		PRISMA_MANIFEST_SHA="$(platform_cleanup_marker_value prisma_manifest_sha256)" \
		PRISMA_PRE_LEDGER_SHA="$(platform_cleanup_marker_value prisma_pre_ledger_sha256)" \
		PRISMA_POST_LEDGER_SHA="$(platform_cleanup_marker_value prisma_post_ledger_sha256)" \
		FRONTEND_EVIDENCE_SHA="$(platform_cleanup_marker_value frontend_evidence_sha256)" \
		TOPOLOGY_SCAN_EVIDENCE_SHA="$(platform_cleanup_marker_value topology_scan_evidence_sha256)" \
		MIGRATION_REHEARSAL_SHA="$(platform_cleanup_marker_value migration_rehearsal_evidence_sha256)" \
		platform_cleanup_node - "$receipt" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
const pairs = rows.map(row => {
  const at = row.indexOf('='); if (at < 1) throw new Error(); return [row.slice(0, at), row.slice(at + 1)];
});
const value = Object.fromEntries(pairs);
const exact = process.env.RECEIPT_PHASE === 'pre'
	  ? ['version','action','provider','reference','ownership_revision','cleanup_revision','production_env_sha256','compose_sha256','core_database_name','core_database_system_identifier','generation','snapshot_sha256','source_fingerprint','source_high_watermark','billing_offer_contract_version','billing_offer_sequence_scope','billing_offer_aggregate_version','billing_offer_source_sequence','billing_offer_fence_fingerprint','migration_sha256','prisma_manifest_sha256','prisma_pre_ledger_sha256','frontend_evidence_sha256','topology_scan_evidence_sha256','first_complete_proof_sha256','core_pre_backup_sha256','platform_pre_backup_sha256','pre_restore_evidence_sha256','soak_evidence_sha256','route_evidence_sha256','queue_evidence_sha256','outbox_evidence_sha256','verified_at']
	  : ['version','action','provider','reference','ownership_revision','cleanup_revision','production_env_sha256','compose_sha256','core_database_name','core_database_system_identifier','generation','snapshot_sha256','source_fingerprint','source_high_watermark','billing_offer_contract_version','billing_offer_sequence_scope','billing_offer_aggregate_version','billing_offer_source_sequence','billing_offer_fence_fingerprint','migration_sha256','prisma_manifest_sha256','prisma_pre_ledger_sha256','prisma_post_ledger_sha256','migration_rehearsal_evidence_sha256','pre_offsite_receipt_sha256','core_post_backup_sha256','post_restore_evidence_sha256','verified_at'];
if (pairs.length !== exact.length || Object.keys(value).length !== exact.length ||
    Object.keys(value).sort().join('|') !== exact.sort().join('|') || value.version !== '1' ||
    value.action !== `platform-core-source-cleanup-${process.env.RECEIPT_PHASE}-offsite` ||
	    value.cleanup_revision !== process.env.RECEIPT_REVISION || value.production_env_sha256 !== process.env.PRODUCTION_ENV_SHA ||
	    value.compose_sha256 !== process.env.COMPOSE_SHA || value.core_database_name !== process.env.CORE_DATABASE_NAME ||
	    value.core_database_system_identifier !== process.env.CORE_DATABASE_SYSTEM_IDENTIFIER ||
	    value.ownership_revision !== process.env.OWNERSHIP_REVISION || value.snapshot_sha256 !== process.env.SNAPSHOT_SHA ||
	    value.source_fingerprint !== process.env.SOURCE_FINGERPRINT || value.source_high_watermark !== process.env.SOURCE_HIGH_WATERMARK ||
	    value.billing_offer_contract_version !== process.env.BILLING_OFFER_CONTRACT_VERSION ||
	    value.billing_offer_sequence_scope !== process.env.BILLING_OFFER_SEQUENCE_SCOPE ||
	    value.billing_offer_aggregate_version !== process.env.BILLING_OFFER_AGGREGATE_VERSION ||
	    value.billing_offer_source_sequence !== process.env.BILLING_OFFER_SOURCE_SEQUENCE ||
	    value.billing_offer_fence_fingerprint !== process.env.BILLING_OFFER_FENCE_FINGERPRINT ||
	    value.prisma_manifest_sha256 !== process.env.PRISMA_MANIFEST_SHA || value.prisma_pre_ledger_sha256 !== process.env.PRISMA_PRE_LEDGER_SHA ||
	    value.generation !== process.env.RECEIPT_GENERATION ||
    !['operator-managed-macos','encrypted-object-storage'].includes(value.provider) ||
    !/^(macos-offsite|object-storage):[A-Za-z0-9._:/-]{8,240}$/.test(value.reference || '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verified_at || '')) process.exit(1);
if (process.env.RECEIPT_PHASE === 'pre' &&
    (value.core_pre_backup_sha256 !== process.env.CORE_PRE_SHA || value.platform_pre_backup_sha256 !== process.env.PLATFORM_PRE_SHA ||
     value.pre_restore_evidence_sha256 !== process.env.PRE_RESTORE_SHA || value.soak_evidence_sha256 !== process.env.SOAK_SHA ||
     value.route_evidence_sha256 !== process.env.ROUTE_SHA || value.queue_evidence_sha256 !== process.env.QUEUE_SHA ||
	     value.outbox_evidence_sha256 !== process.env.OUTBOX_SHA || value.first_complete_proof_sha256 !== process.env.FIRST_COMPLETE_PROOF_SHA ||
	     value.frontend_evidence_sha256 !== process.env.FRONTEND_EVIDENCE_SHA ||
	     value.topology_scan_evidence_sha256 !== process.env.TOPOLOGY_SCAN_EVIDENCE_SHA ||
	     value.migration_sha256 !== process.env.MIGRATION_SHA)) process.exit(1);
if (process.env.RECEIPT_PHASE === 'post' &&
	    (value.core_post_backup_sha256 !== process.env.CORE_POST_SHA || value.post_restore_evidence_sha256 !== process.env.POST_RESTORE_SHA ||
	     value.pre_offsite_receipt_sha256 !== process.env.PRE_RECEIPT_SHA || value.migration_sha256 !== process.env.MIGRATION_SHA ||
	     value.prisma_post_ledger_sha256 !== process.env.PRISMA_POST_LEDGER_SHA ||
	     value.migration_rehearsal_evidence_sha256 !== process.env.MIGRATION_REHEARSAL_SHA)) process.exit(1);
NODE
}

platform_cleanup_assert_core_frozen() {
	local anchor generation contract scope aggregate sequence fence
	anchor="$(platform_cleanup_core_ownership_anchor)" || return 1
	IFS='|' read -r generation contract scope aggregate sequence fence <<<"$anchor"
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		[[ "$generation" == "$(platform_cleanup_marker_value generation)" &&
			"$contract" == "$(platform_cleanup_marker_value billing_offer_contract_version)" &&
			"$scope" == "$(platform_cleanup_marker_value billing_offer_sequence_scope)" &&
			"$aggregate" == "$(platform_cleanup_marker_value billing_offer_aggregate_version)" &&
			"$sequence" == "$(platform_cleanup_marker_value billing_offer_source_sequence)" &&
			"$fence" == "$(platform_cleanup_marker_value billing_offer_fence_fingerprint)" ]] ||
			platform_cleanup_fail 'Core ownership or Billing fence no longer matches the cleanup journal.'
	fi
}

platform_cleanup_assert_core_runtime_revision() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{40}$ && "$2" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local revision="$1" expected_image_id="$2" actual_image_id service container metadata app_revision
	actual_image_id="$(docker image inspect --format '{{.Id}}' "winwidget-api:git-$revision")" || return 1
	[[ "$actual_image_id" == "$expected_image_id" ]] || return 1
	for service in api outbox-publisher integration-worker; do
		container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q "$service")" || return 1
		[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
		metadata="$(docker inspect --format '{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' "$container")" || return 1
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
			awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
		[[ "$metadata" == "$expected_image_id|$revision|running|true|0|winwidget|$service|False|nestjs" &&
			"$app_revision" == "$revision" ]] ||
			platform_cleanup_fail "Core $service runtime does not match immutable revision $revision." || return 1
	done
	curl -fsS --connect-timeout 3 --max-time 10 http://127.0.0.1:4200/api/v1/health/ready >/dev/null
}

platform_cleanup_assert_core_services_stopped() {
	local running sessions
	running="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api outbox-publisher integration-worker)" || return 1
	[[ -z "$running" ]] || platform_cleanup_fail 'legacy Core processes are still running.' || return 1
	for _ in {1..60}; do
		sessions="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION \
			"SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid <> pg_backend_pid() AND datname=current_database() AND usename='winwidget_api_runtime';")" || return 1
		[[ "$sessions" == 0 ]] && return
		sleep 1
	done
	platform_cleanup_fail 'legacy Core database sessions did not drain.'
}

platform_cleanup_candidate_image_id() {
	platform_cutover_assert_core_image || return 1
	docker image inspect --format '{{.Id}}' "winwidget-api:git-$EXPECTED_REVISION"
}

platform_cleanup_candidate_billing_image_id() {
	platform_cutover_assert_billing_worker_image || return 1
	docker image inspect --format '{{.Id}}' "winwidget-billing:git-$EXPECTED_REVISION"
}

platform_cleanup_candidate_frontend_validator_image_id() {
	local image="winwidget-platform:git-$EXPECTED_REVISION" image_id metadata
	image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
		"$image_id")" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|platform" ]] ||
		platform_cleanup_fail 'frontend attestation validator image is not the exact cleanup revision.' || return 1
	printf '%s\n' "$image_id"
}

platform_cleanup_candidate_database_restore_image_id() {
	local image="winwidget-database-restore:git-$EXPECTED_REVISION" image_id metadata app_revision
	image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
		"$image_id")" || return 1
	app_revision="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image_id" |
		awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|root" && "$app_revision" == "$EXPECTED_REVISION" ]] ||
		platform_cleanup_fail 'database restore image is not the exact cleanup revision.' || return 1
	printf '%s\n' "$image_id"
}

platform_cleanup_assert_database_restore_runtime() {
	local image_id container metadata app_revision
	image_id="$(platform_cleanup_candidate_database_restore_image_id)" || return 1
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		[[ "$image_id" == "$(platform_cleanup_marker_value database_restore_image_id)" ]] || return 1
	fi
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q database-restore-worker)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	metadata="$(docker inspect --format \
		'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{.Config.User}}' \
		"$container")" || return 1
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
		awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|running|true|healthy|0|winwidget|database-restore-worker|False|maintenance|database-restore-worker|root" &&
		"$app_revision" == "$EXPECTED_REVISION" ]] ||
		platform_cleanup_fail 'database restore worker runtime is not the exact healthy cleanup revision.'
}

platform_cleanup_recreate_database_restore_runtime() {
	platform_cleanup_candidate_database_restore_image_id >/dev/null || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate database-restore-worker || return 1
	for _ in {1..60}; do
		if platform_cleanup_assert_database_restore_runtime >/dev/null 2>&1; then return 0; fi
		sleep 2
	done
	platform_cleanup_assert_database_restore_runtime
}

platform_cleanup_assert_retirement_runtime() {
	local core_image billing_image validator_image service container metadata app_revision port
	core_image="$(platform_cleanup_candidate_image_id)" || return 1
	billing_image="$(platform_cleanup_candidate_billing_image_id)" || return 1
	validator_image="$(platform_cleanup_candidate_frontend_validator_image_id)" || return 1
	if [[ -e "$platform_cleanup_marker" || -L "$platform_cleanup_marker" ]]; then
		platform_cleanup_validate_marker || return 1
		[[ "$core_image" == "$(platform_cleanup_marker_value core_image_id)" &&
			"$billing_image" == "$(platform_cleanup_marker_value billing_image_id)" &&
			"$validator_image" == "$(platform_cleanup_marker_value frontend_validator_image_id)" ]] || return 1
	fi
	platform_cleanup_assert_core_runtime_revision "$EXPECTED_REVISION" "$core_image" || return 1
	platform_cutover_assert_billing_api_candidate >/dev/null || return 1
	platform_cutover_assert_billing_worker_candidate || return 1
	platform_cutover_assert_integration_worker_candidate || return 1
	for service in billing-scheduler billing-outbox-publisher; do
		container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q "$service")" || return 1
		[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
		metadata="$(docker inspect --format '{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' "$container")" || return 1
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
			awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
		[[ "$metadata" == "$billing_image|$EXPECTED_REVISION|running|true|healthy|0|winwidget|$service|False|billing" &&
			"$app_revision" == "$EXPECTED_REVISION" ]] || return 1
		case "$service" in billing-scheduler) port=4801 ;; billing-outbox-publisher) port=4803 ;; esac
		curl -fsS --connect-timeout 3 --max-time 10 "http://127.0.0.1:$port/health/ready" >/dev/null || return 1
	done
	platform_cleanup_assert_database_restore_runtime || return 1
	platform_cleanup_assert_credential_scope
}

platform_cleanup_require_platform_owner_baseline() {
	platform_cleanup_require_complete_cutover
	platform_cutover_cli target verify >/dev/null ||
		platform_cleanup_fail 'current Platform target no longer verifies ACTIVE ownership.' || return 1
	platform_cutover_assert_platform_runtime platform-api api 5000 || return 1
	platform_cutover_assert_platform_runtime platform-outbox-publisher outbox-publisher 5001 || return 1
	platform_cleanup_assert_gateway_contract || return 1
	platform_cleanup_assert_gateway_runtime_current || return 1
	return 0
}

platform_cleanup_require_active_owner() {
	platform_cleanup_require_platform_owner_baseline || return 1
	platform_cleanup_assert_retirement_runtime
}

platform_cleanup_require_common_base() {
	platform_cleanup_load_dependencies
	platform_cleanup_require_production_context
	platform_cleanup_require_checkout
	platform_cleanup_require_compose_identity
	platform_cleanup_require_frontend_attestation_inputs
	platform_cleanup_assert_core_database_identity
	platform_cleanup_require_complete_cutover
	platform_cleanup_require_first_complete_proof
	platform_cleanup_require_soak
	platform_cleanup_require_migration_contract
	platform_cleanup_assert_cleanup_source_retired
	platform_cleanup_require_platform_owner_baseline
	[[ "$(platform_cleanup_marker_value_if_present 2>/dev/null || true)" != invalid ]] || return 1
}

platform_cleanup_require_common() {
	platform_cleanup_require_common_base || return 1
	platform_cleanup_assert_retirement_runtime
}

platform_cleanup_marker_value_if_present() {
	if [[ ! -e "$platform_cleanup_marker" && ! -L "$platform_cleanup_marker" ]]; then
		printf 'absent\n'
		return
	fi
	platform_cleanup_validate_marker || { printf 'invalid\n'; return 1; }
	platform_cleanup_marker_value phase
}

platform_cleanup_validate_restore_evidence() {
	[[ $# -eq 3 && "$2" =~ ^(pre|post)$ ]] || return 1
	local file="$1" mode="$2" generation
	[[ -d "$3" && ! -L "$3" ]] || return 1
	generation="$(platform_cutover_marker_value generation)" || return 1
	platform_cleanup_validate_evidence "$file" "platform-core-cleanup-$mode-restore" "$EXPECTED_REVISION" "$generation" || return 1
	awk -F= -v mode="$mode" \
		-v expected_core_dump="$(if [[ "$mode" == pre ]]; then platform_cleanup_marker_value core_pre_backup_sha256; else platform_cleanup_marker_value core_post_backup_sha256; fi)" \
		-v expected_platform_dump="$(platform_cleanup_marker_value platform_pre_backup_sha256)" \
		-v expected_database_name="$(platform_cleanup_marker_value core_database_name)" \
		-v expected_system_identifier="$(platform_cleanup_marker_value core_database_system_identifier)" '
		{ value[$1] = substr($0, index($0, "=") + 1); seen[$1] += 1 }
		END {
			for (key in seen) if (seen[key] != 1) exit 1
			if (value["postgres_major"] != "18" || value["clean_restore"] != "true" ||
				value["isolated_targets"] != "true" || value["internal_network"] != "true" || value["no_host_ports"] != "true" ||
				value["resources_removed_before_evidence"] != "true" ||
				value["core_dump_sha256"] != expected_core_dump ||
				value["core_catalog_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["core_repeat_dump_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["core_database_name"] != expected_database_name ||
				value["core_database_system_identifier"] != expected_system_identifier ||
				value["core_restored_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				value["core_restored_system_identifier"] == expected_system_identifier) exit 1
			if (mode == "pre" && (value["core_source_state"] != "4|5|4|1|1|true" ||
				value["platform_dump_sha256"] != expected_platform_dump ||
				value["platform_catalog_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_repeat_dump_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["platform_restored_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				value["platform_restored_system_identifier"] == expected_system_identifier ||
				value["platform_restored_system_identifier"] == value["core_restored_system_identifier"] ||
				value["platform_state"] != "1|1|0|true")) exit 1
			if (mode == "post" && value["core_source_state"] != "0|0|0|0|0|true") exit 1
		}
	' "$file"
}

platform_cleanup_require_journal_identity() {
	platform_cleanup_validate_marker || return 1
	local identity database_name system_identifier anchor generation contract scope aggregate sequence fence frontend_evidence
	identity="$(platform_cleanup_core_database_identity)" || return 1
	IFS='|' read -r database_name system_identifier <<<"$identity"
	anchor="$(platform_cleanup_core_ownership_anchor)" || return 1
	IFS='|' read -r generation contract scope aggregate sequence fence <<<"$anchor"
	[[ "$(platform_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" &&
		"$(platform_cleanup_marker_value ownership_revision)" == "$(platform_cutover_marker_value revision)" &&
		"$(platform_cleanup_marker_value production_env_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" &&
		"$(platform_cleanup_marker_value compose_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" &&
		"$(platform_cleanup_marker_value core_database_name)" == "$database_name" &&
		"$(platform_cleanup_marker_value core_database_system_identifier)" == "$system_identifier" &&
		"$(platform_cleanup_marker_value generation)" == "$generation" &&
		"$(platform_cleanup_marker_value snapshot_sha256)" == "$(platform_cutover_marker_value snapshot_sha256)" &&
		"$(platform_cleanup_marker_value source_fingerprint)" == "$(platform_cutover_marker_value source_fingerprint)" &&
		"$(platform_cleanup_marker_value source_high_watermark)" == "$(platform_cutover_marker_value source_high_watermark)" &&
		"$(platform_cleanup_marker_value billing_offer_contract_version)" == "$contract" &&
		"$(platform_cleanup_marker_value billing_offer_sequence_scope)" == "$scope" &&
		"$(platform_cleanup_marker_value billing_offer_aggregate_version)" == "$aggregate" &&
		"$(platform_cleanup_marker_value billing_offer_source_sequence)" == "$sequence" &&
		"$(platform_cleanup_marker_value billing_offer_fence_fingerprint)" == "$fence" ]] ||
		platform_cleanup_fail 'cleanup journal identity differs from the exact live ownership/deployment boundary.' || return 1
	platform_cleanup_require_stable_frontend_identity || return 1
	frontend_evidence="$(platform_cleanup_marker_value frontend_evidence_sha256)" || return 1
	if [[ "$frontend_evidence" == pending ]]; then
		[[ "$(platform_cleanup_marker_value frontend_revision)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" &&
			"$(platform_cleanup_marker_value frontend_origin_sha256)" == "$(platform_cleanup_frontend_origin_sha256)" &&
			"$(platform_cleanup_marker_value frontend_challenge)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" &&
			"$(platform_cleanup_marker_value frontend_attestation_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" &&
			"$(platform_cleanup_marker_value frontend_signature_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" &&
			"$(platform_cleanup_marker_value frontend_public_key_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" ]] ||
			platform_cleanup_fail 'pending cleanup frontend identity differs from the current signed attestation.'
	fi
}

platform_cleanup_require_bound_pre_evidence() {
	platform_cleanup_validate_marker || return 1
	local revision generation directory key file expected phase actual_image actual_billing_image
	local actual_validator_image actual_database_restore_image
	revision="$(platform_cleanup_marker_value cleanup_revision)" || return 1
	generation="$(platform_cleanup_marker_value generation)" || return 1
	phase="$(platform_cleanup_marker_value phase)" || return 1
	[[ "$revision" == "$EXPECTED_REVISION" &&
		"$(platform_cleanup_marker_value ownership_revision)" == "$(platform_cutover_marker_value revision)" &&
		"$(platform_cleanup_marker_value production_env_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" &&
		"$(platform_cleanup_sha256 "$ENV_FILE")" == "$(platform_cleanup_marker_value production_env_sha256)" &&
		"$(platform_cleanup_marker_value compose_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" &&
		"$(platform_cleanup_sha256 "$COMPOSE_FILE")" == "$(platform_cleanup_marker_value compose_sha256)" &&
		"$generation" == "$(platform_cutover_marker_value generation)" &&
		"$(platform_cleanup_marker_value first_complete_proof_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256" &&
		"$(platform_cleanup_marker_value snapshot_sha256)" == "$(platform_cutover_marker_value snapshot_sha256)" &&
		"$(platform_cleanup_marker_value source_fingerprint)" == "$(platform_cutover_marker_value source_fingerprint)" &&
		"$(platform_cleanup_marker_value source_high_watermark)" == "$(platform_cutover_marker_value source_high_watermark)" ]] || return 1
	directory="$(platform_cleanup_evidence_directory "$revision" "$generation")" || return 1
	platform_cleanup_validate_private_directory "$directory" || return 1
	platform_cleanup_require_artifact "$directory/first-complete-proof.evidence" \
		"$(platform_cleanup_marker_value first_complete_proof_sha256)" || return 1
	for key in prisma_manifest_sha256 prisma_pre_ledger_sha256 frontend_evidence_sha256 \
		topology_scan_evidence_sha256 core_pre_backup_sha256 platform_pre_backup_sha256 \
		pre_restore_evidence_sha256 soak_evidence_sha256 route_evidence_sha256 \
		queue_evidence_sha256 outbox_evidence_sha256; do
		case "$key" in
		prisma_manifest_sha256) file="$directory/prisma-manifest.evidence" ;;
		prisma_pre_ledger_sha256) file="$directory/prisma-ledger-pre.evidence" ;;
		frontend_evidence_sha256) file="$directory/frontend-attestation.evidence" ;;
		topology_scan_evidence_sha256) file="$directory/topology-scan.evidence" ;;
		core_pre_backup_sha256) file="$directory/core-pre-cleanup.dump" ;;
		platform_pre_backup_sha256) file="$directory/platform-pre-cleanup.dump" ;;
		pre_restore_evidence_sha256) file="$directory/pre-restore.evidence" ;;
		soak_evidence_sha256) file="$directory/soak.evidence" ;;
		route_evidence_sha256) file="$directory/routes.evidence" ;;
		queue_evidence_sha256) file="$directory/queues.evidence" ;;
		outbox_evidence_sha256) file="$directory/outbox.evidence" ;;
		esac
		expected="$(platform_cleanup_marker_value "$key")" || return 1
		platform_cleanup_require_artifact "$file" "$expected" || return 1
	done
	platform_cleanup_validate_bound_frontend_evidence \
		"$directory/frontend-attestation.evidence" || return 1
	platform_cleanup_require_artifact "$directory/frontend-phase-evidence.chain" \
		"$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)" || return 1
	platform_cleanup_validate_frontend_phase_chain \
		"$directory/frontend-phase-evidence.chain" >/dev/null || return 1
	[[ "$(head -c 5 "$directory/core-pre-cleanup.dump")" == PGDMP &&
		"$(head -c 5 "$directory/platform-pre-cleanup.dump")" == PGDMP ]] || return 1
	platform_cleanup_validate_evidence "$directory/soak.evidence" platform-core-cleanup-soak "$revision" "$generation" || return 1
	platform_cleanup_validate_evidence "$directory/routes.evidence" platform-core-cleanup-routes "$revision" "$generation" || return 1
	platform_cleanup_validate_evidence "$directory/queues.evidence" platform-core-cleanup-queues "$revision" "$generation" || return 1
	platform_cleanup_validate_evidence "$directory/outbox.evidence" platform-core-cleanup-outbox "$revision" "$generation" || return 1
	platform_cleanup_validate_restore_evidence "$directory/pre-restore.evidence" pre "$directory" || return 1
	platform_cleanup_validate_prisma_ledger "$directory/prisma-manifest.evidence" \
		"$directory/prisma-ledger-pre.evidence" pre || return 1
	platform_cleanup_require_stable_frontend_identity || return 1
	platform_cleanup_validate_topology_evidence "$directory/topology-scan.evidence" || return 1
	actual_image="$(platform_cleanup_candidate_image_id)" || return 1
	actual_billing_image="$(platform_cleanup_candidate_billing_image_id)" || return 1
	actual_validator_image="$(platform_cleanup_candidate_frontend_validator_image_id)" || return 1
	actual_database_restore_image="$(platform_cleanup_candidate_database_restore_image_id)" || return 1
	[[ "$actual_image" == "$(platform_cleanup_marker_value core_image_id)" &&
		"$actual_billing_image" == "$(platform_cleanup_marker_value billing_image_id)" &&
		"$actual_validator_image" == "$(platform_cleanup_marker_value frontend_validator_image_id)" &&
		"$actual_database_restore_image" == "$(platform_cleanup_marker_value database_restore_image_id)" ]] || return 1
	if [[ "$phase" =~ ^(sealed|forward-only|migrating|applied|verifying|complete)$ ]]; then
		platform_cleanup_require_artifact "$directory/pre-offsite-receipt.evidence" \
			"$(platform_cleanup_marker_value pre_offsite_receipt_sha256)" || return 1
		platform_cleanup_validate_offsite_receipt "$directory/pre-offsite-receipt.evidence" pre "$directory" || return 1
		platform_cleanup_require_artifact "$directory/migration-rehearsal.evidence" \
			"$(platform_cleanup_marker_value migration_rehearsal_evidence_sha256)" || return 1
		platform_cleanup_validate_migration_rehearsal "$directory/migration-rehearsal.evidence" || return 1
	fi
}

platform_cleanup_require_bound_post_evidence() {
	platform_cleanup_require_bound_pre_evidence || return 1
	local directory revision generation
	revision="$(platform_cleanup_marker_value cleanup_revision)" || return 1
	generation="$(platform_cleanup_marker_value generation)" || return 1
	directory="$(platform_cleanup_evidence_directory "$revision" "$generation")" || return 1
	platform_cleanup_require_artifact "$directory/core-post-cleanup.dump" \
		"$(platform_cleanup_marker_value core_post_backup_sha256)" || return 1
	[[ "$(head -c 5 "$directory/core-post-cleanup.dump")" == PGDMP ]] || return 1
	platform_cleanup_require_artifact "$directory/post-restore.evidence" \
		"$(platform_cleanup_marker_value post_restore_evidence_sha256)" || return 1
	platform_cleanup_validate_restore_evidence "$directory/post-restore.evidence" post "$directory" || return 1
	platform_cleanup_require_artifact "$directory/prisma-ledger-post.evidence" \
		"$(platform_cleanup_marker_value prisma_post_ledger_sha256)" || return 1
	platform_cleanup_validate_prisma_ledger "$directory/prisma-manifest.evidence" \
		"$directory/prisma-ledger-post.evidence" post
}

platform_cleanup_migration_guc_sql() {
	[[ $# -eq 1 && "$1" =~ ^(set|reset)$ ]] || return 1
	local mode="$1" setting name value sql=''
	local -a settings=(
		"winwidget.platform_core_source_cleanup=production-destructive-approved"
		"winwidget.platform_ownership_revision=$(platform_cleanup_marker_value ownership_revision)"
		"winwidget.platform_cleanup_revision=$(platform_cleanup_marker_value cleanup_revision)"
		"winwidget.platform_production_env_sha256=$(platform_cleanup_marker_value production_env_sha256)"
		"winwidget.platform_compose_sha256=$(platform_cleanup_marker_value compose_sha256)"
		"winwidget.platform_core_database_name=$(platform_cleanup_marker_value core_database_name)"
		"winwidget.platform_core_database_system_identifier=$(platform_cleanup_marker_value core_database_system_identifier)"
		"winwidget.platform_generation=$(platform_cleanup_marker_value generation)"
		"winwidget.platform_first_complete_proof_sha256=$(platform_cleanup_marker_value first_complete_proof_sha256)"
		"winwidget.platform_cleanup_migration_sha256=$(platform_cleanup_marker_value migration_sha256)"
		"winwidget.platform_prisma_manifest_sha256=$(platform_cleanup_marker_value prisma_manifest_sha256)"
		"winwidget.platform_prisma_pre_ledger_sha256=$(platform_cleanup_marker_value prisma_pre_ledger_sha256)"
		"winwidget.platform_snapshot_sha256=$(platform_cleanup_marker_value snapshot_sha256)"
		"winwidget.platform_source_fingerprint=$(platform_cleanup_marker_value source_fingerprint)"
		"winwidget.platform_source_high_watermark=$(platform_cleanup_marker_value source_high_watermark)"
		"winwidget.platform_billing_offer_contract_version=$(platform_cleanup_marker_value billing_offer_contract_version)"
		"winwidget.platform_billing_offer_sequence_scope=$(platform_cleanup_marker_value billing_offer_sequence_scope)"
		"winwidget.platform_billing_offer_aggregate_version=$(platform_cleanup_marker_value billing_offer_aggregate_version)"
		"winwidget.platform_billing_offer_source_sequence=$(platform_cleanup_marker_value billing_offer_source_sequence)"
		"winwidget.platform_billing_offer_fence_fingerprint=$(platform_cleanup_marker_value billing_offer_fence_fingerprint)"
		"winwidget.platform_core_pre_backup_sha256=$(platform_cleanup_marker_value core_pre_backup_sha256)"
		"winwidget.platform_pre_backup_sha256=$(platform_cleanup_marker_value platform_pre_backup_sha256)"
		"winwidget.platform_pre_restore_evidence_sha256=$(platform_cleanup_marker_value pre_restore_evidence_sha256)"
		"winwidget.platform_soak_evidence_sha256=$(platform_cleanup_marker_value soak_evidence_sha256)"
		"winwidget.platform_route_evidence_sha256=$(platform_cleanup_marker_value route_evidence_sha256)"
		"winwidget.platform_queue_evidence_sha256=$(platform_cleanup_marker_value queue_evidence_sha256)"
		"winwidget.platform_outbox_evidence_sha256=$(platform_cleanup_marker_value outbox_evidence_sha256)"
		"winwidget.platform_frontend_evidence_sha256=$(platform_cleanup_marker_value frontend_evidence_sha256)"
		"winwidget.platform_frontend_phase_evidence_chain_sha256=$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)"
		"winwidget.platform_topology_scan_evidence_sha256=$(platform_cleanup_marker_value topology_scan_evidence_sha256)"
		"winwidget.platform_pre_offsite_receipt_sha256=$(platform_cleanup_marker_value pre_offsite_receipt_sha256)"
	)
	for setting in "${settings[@]}"; do
		name="${setting%%=*}"
		value="${setting#*=}"
		[[ "$name" =~ ^winwidget\.[a-z0-9_]+$ && "$value" =~ ^[a-zA-Z0-9._:-]+$ ]] || return 1
		if [[ "$mode" == set ]]; then
			sql+="ALTER ROLE winwidget_migration IN DATABASE default_db SET \"$name\" TO '$value';"
		else
			sql+="ALTER ROLE winwidget_migration IN DATABASE default_db RESET \"$name\";"
		fi
	done
	printf '%s\n' "$sql"
}

platform_cleanup_configure_migration_gucs() {
	[[ $# -eq 1 && "$1" =~ ^(set|reset)$ ]] || return 1
	[[ "$(platform_cleanup_database_url_field DATABASE_MIGRATION_URL_PRODUCTION username)" == winwidget_migration &&
		"$(platform_cleanup_database_url_field DATABASE_MIGRATION_URL_PRODUCTION database)" == default_db ]] || return 1
	local sql
	sql="$(platform_cleanup_migration_guc_sql "$1")" || return 1
	platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "$sql" >/dev/null
	if [[ "$1" == set ]]; then
		[[ "$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT current_setting('winwidget.platform_core_source_cleanup', true) || '|' ||
 current_setting('winwidget.platform_ownership_revision', true) || '|' ||
	 current_setting('winwidget.platform_cleanup_revision', true) || '|' ||
	 current_setting('winwidget.platform_production_env_sha256', true) || '|' ||
	 current_setting('winwidget.platform_compose_sha256', true) || '|' ||
	 current_setting('winwidget.platform_core_database_name', true) || '|' ||
	 current_setting('winwidget.platform_core_database_system_identifier', true) || '|' ||
	 current_setting('winwidget.platform_generation', true) || '|' ||
	 current_setting('winwidget.platform_first_complete_proof_sha256', true) || '|' ||
	 current_setting('winwidget.platform_cleanup_migration_sha256', true) || '|' ||
	 current_setting('winwidget.platform_prisma_manifest_sha256', true) || '|' ||
	 current_setting('winwidget.platform_prisma_pre_ledger_sha256', true) || '|' ||
	 current_setting('winwidget.platform_snapshot_sha256', true) || '|' ||
	 current_setting('winwidget.platform_source_fingerprint', true) || '|' ||
	 current_setting('winwidget.platform_source_high_watermark', true) || '|' ||
	 current_setting('winwidget.platform_billing_offer_contract_version', true) || '|' ||
	 current_setting('winwidget.platform_billing_offer_sequence_scope', true) || '|' ||
	 current_setting('winwidget.platform_billing_offer_aggregate_version', true) || '|' ||
	 current_setting('winwidget.platform_billing_offer_source_sequence', true) || '|' ||
	 current_setting('winwidget.platform_billing_offer_fence_fingerprint', true) || '|' ||
	 current_setting('winwidget.platform_core_pre_backup_sha256', true) || '|' ||
 current_setting('winwidget.platform_pre_backup_sha256', true) || '|' ||
 current_setting('winwidget.platform_pre_restore_evidence_sha256', true) || '|' ||
 current_setting('winwidget.platform_soak_evidence_sha256', true) || '|' ||
 current_setting('winwidget.platform_route_evidence_sha256', true) || '|' ||
	 current_setting('winwidget.platform_queue_evidence_sha256', true) || '|' ||
	 current_setting('winwidget.platform_outbox_evidence_sha256', true) || '|' ||
	 current_setting('winwidget.platform_frontend_evidence_sha256', true) || '|' ||
	 current_setting('winwidget.platform_frontend_phase_evidence_chain_sha256', true) || '|' ||
	 current_setting('winwidget.platform_topology_scan_evidence_sha256', true) || '|' ||
	 current_setting('winwidget.platform_pre_offsite_receipt_sha256', true);")" == \
			"production-destructive-approved|$(platform_cleanup_marker_value ownership_revision)|$(platform_cleanup_marker_value cleanup_revision)|$(platform_cleanup_marker_value production_env_sha256)|$(platform_cleanup_marker_value compose_sha256)|$(platform_cleanup_marker_value core_database_name)|$(platform_cleanup_marker_value core_database_system_identifier)|$(platform_cleanup_marker_value generation)|$(platform_cleanup_marker_value first_complete_proof_sha256)|$(platform_cleanup_marker_value migration_sha256)|$(platform_cleanup_marker_value prisma_manifest_sha256)|$(platform_cleanup_marker_value prisma_pre_ledger_sha256)|$(platform_cleanup_marker_value snapshot_sha256)|$(platform_cleanup_marker_value source_fingerprint)|$(platform_cleanup_marker_value source_high_watermark)|$(platform_cleanup_marker_value billing_offer_contract_version)|$(platform_cleanup_marker_value billing_offer_sequence_scope)|$(platform_cleanup_marker_value billing_offer_aggregate_version)|$(platform_cleanup_marker_value billing_offer_source_sequence)|$(platform_cleanup_marker_value billing_offer_fence_fingerprint)|$(platform_cleanup_marker_value core_pre_backup_sha256)|$(platform_cleanup_marker_value platform_pre_backup_sha256)|$(platform_cleanup_marker_value pre_restore_evidence_sha256)|$(platform_cleanup_marker_value soak_evidence_sha256)|$(platform_cleanup_marker_value route_evidence_sha256)|$(platform_cleanup_marker_value queue_evidence_sha256)|$(platform_cleanup_marker_value outbox_evidence_sha256)|$(platform_cleanup_marker_value frontend_evidence_sha256)|$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)|$(platform_cleanup_marker_value topology_scan_evidence_sha256)|$(platform_cleanup_marker_value pre_offsite_receipt_sha256)" ]]
	else
		[[ "$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*) FROM pg_catalog.pg_db_role_setting setting
JOIN pg_catalog.pg_roles role ON role.oid=setting.setrole
JOIN pg_catalog.pg_database database ON database.oid=setting.setdatabase
CROSS JOIN LATERAL unnest(setting.setconfig) config
WHERE role.rolname='winwidget_migration' AND database.datname='default_db'
  AND config LIKE 'winwidget.platform_%';")" == 0 ]]
	fi
}

platform_cleanup_apply_migration() (
	local migration_state="$1" result=0
	[[ "$migration_state" =~ ^(pending|rolled-back)$ ]] || return 1
	platform_cleanup_configure_migration_gucs reset || return 1
	trap 'status=$?; trap - EXIT INT TERM; if ! platform_cleanup_configure_migration_gucs reset >/dev/null 2>&1; then printf "platform_core_source_cleanup_error=migration guard settings could not be reset\n" >&2; exit 1; fi; exit "$status"' EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	platform_cleanup_configure_migration_gucs set || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps migrate || result=$?
	platform_cleanup_configure_migration_gucs reset || return 1
	trap - EXIT INT TERM
	return "$result"
)

platform_cleanup_copy_evidence() {
	[[ $# -eq 2 && "$1" == /* && "$2" == /* ]] || return 1
	local source="$1" destination="$2" partial="${2}.partial.$$"
	platform_cleanup_validate_private_file "$source" || return 1
	[[ ! -e "$destination" && ! -L "$destination" && ! -e "$partial" && ! -L "$partial" ]] || return 1
	cp -- "$source" "$partial"
	platform_cleanup_promote_evidence "$partial" "$destination"
}

platform_cleanup_validate_live_boundary() (
	[[ $# -ge 1 && $# -le 2 && "$1" =~ ^[01]$ && "${2:-running}" =~ ^(running|stopped)$ ]] || return 1
	local expected_cursor="$1" core_mode="${2:-running}" temporary
	temporary="$(realpath -- "$(mktemp -d)")" || return 1
	chmod 700 "$temporary"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$temporary"; fi
	trap 'rm -rf -- "$temporary"' EXIT INT TERM
	platform_cleanup_assert_routes "$temporary/routes.evidence" "$core_mode" || return 1
	platform_cleanup_assert_queues "$temporary/queues.evidence" || return 1
	platform_cleanup_assert_outbox "$temporary/outbox.evidence" "$expected_cursor"
)

platform_cleanup_generate_or_adopt_live_evidence() {
	[[ $# -ge 3 ]] || return 1
	local destination="$1" action="$2" generator="$3" directory candidate_directory candidate generation
	shift 3
	directory="$(dirname -- "$destination")"
	platform_cleanup_validate_private_directory "$directory" || return 1
	candidate_directory="$(mktemp -d "$directory/.${action}.candidate.XXXXXX")" || return 1
	chmod 700 "$candidate_directory"
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then chown 0:0 "$candidate_directory"; fi
	candidate="$candidate_directory/evidence"
	"$generator" "$candidate" "$@" || { rm -f -- "$candidate"; rmdir -- "$candidate_directory"; return 1; }
	generation="$(platform_cutover_marker_value generation)" || { rm -f -- "$candidate"; rmdir -- "$candidate_directory"; return 1; }
	platform_cleanup_validate_evidence "$candidate" "$action" "$EXPECTED_REVISION" "$generation" || {
		rm -f -- "$candidate"; rmdir -- "$candidate_directory"; return 1;
	}
	if [[ -e "$destination" || -L "$destination" ]]; then
		platform_cleanup_validate_evidence "$destination" "$action" "$EXPECTED_REVISION" "$generation" || {
			rm -f -- "$candidate"; rmdir -- "$candidate_directory"; return 1;
		}
		awk -F= '$1 != "observed_at" { print }' "$candidate" >"${candidate}.stable"
		awk -F= '$1 != "observed_at" { print }' "$destination" >"${candidate}.existing"
		cmp -s -- "${candidate}.stable" "${candidate}.existing" || {
			rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"; rmdir -- "$candidate_directory"; return 1;
		}
		rm -f -- "$candidate" "${candidate}.stable" "${candidate}.existing"
	else
		platform_cleanup_promote_evidence "$candidate" "$destination" || return 1
	fi
	rmdir -- "$candidate_directory"
	platform_cleanup_sha256 "$destination"
}

platform_cleanup_stage() {
	platform_cleanup_require_confirmation
	platform_cleanup_load_dependencies
	platform_cleanup_require_production_context
	platform_cleanup_require_checkout
	platform_cleanup_require_compose_identity
	platform_cleanup_require_frontend_attestation_inputs
	platform_cleanup_assert_core_database_identity
	platform_cleanup_require_complete_cutover
	platform_cleanup_require_first_complete_proof
	platform_cleanup_require_soak
	platform_cleanup_require_migration_contract
	platform_cleanup_assert_cleanup_source_retired
	platform_cleanup_require_platform_owner_baseline
	acquire_production_deploy_lock 'Platform Core source cleanup stage'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	platform_cleanup_assert_targets_unchanged
	local phase source_state migration_state generation ownership_revision directory
	local core_image billing_image core_pre_sha platform_pre_sha restore_sha soak_sha route_sha queue_sha outbox_sha
	local manifest_sha pre_ledger_sha frontend_sha frontend_chain_sha topology_sha identity database_name system_identifier
	local validator_image database_restore_image
	local anchor contract scope aggregate sequence fence first_proof_destination
	phase="$(platform_cleanup_marker_value_if_present)" || return 1
	case "$phase" in absent | preparing | staged) ;; *) platform_cleanup_fail "cleanup stage is unavailable from phase=$phase"; return 1 ;; esac
	source_state="$(platform_cleanup_source_state)" || return 1
	migration_state="$(platform_cleanup_migration_state)" || return 1
	[[ "$source_state" == present && "$migration_state" =~ ^(pending|rolled-back)$ ]] ||
		platform_cleanup_fail "cleanup source is not stageable: source=$source_state migration=$migration_state" || return 1
	platform_cleanup_assert_core_frozen || return 1
	generation="$(platform_cutover_marker_value generation)" || return 1
	ownership_revision="$(platform_cutover_marker_value revision)" || return 1
	directory="$(platform_cleanup_evidence_directory "$EXPECTED_REVISION" "$generation")" || return 1
	if [[ "$phase" == staged ]]; then
		platform_cleanup_require_common || return 1
		platform_cleanup_require_bound_pre_evidence || return 1
		platform_cleanup_validate_live_boundary 1 || return 1
		printf 'platform_core_source_cleanup_phase=staged\n'
		printf 'pre_offsite_receipt_required=%s-%s-g%s.evidence\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_PRE_RECEIPT_PREFIX" "$EXPECTED_REVISION" "$generation"
		return
	fi
	if [[ "$phase" == absent ]]; then
		[[ ! -e "$directory" && ! -L "$directory" ]] ||
			platform_cleanup_fail 'unbound cleanup evidence directory already exists.' || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			--profile migration config --quiet || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			build --pull --provenance=false api billing-api platform-api database-restore-worker || return 1
		core_image="$(platform_cleanup_candidate_image_id)" || return 1
		billing_image="$(platform_cleanup_candidate_billing_image_id)" || return 1
		validator_image="$(platform_cleanup_candidate_frontend_validator_image_id)" || return 1
		database_restore_image="$(platform_cleanup_candidate_database_restore_image_id)" || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate \
			api outbox-publisher integration-worker billing-api billing-scheduler \
			billing-worker billing-outbox-publisher database-restore-worker || return 1
		for _ in {1..60}; do
			if platform_cleanup_assert_retirement_runtime >/dev/null 2>&1; then break; fi
			sleep 2
		done
		platform_cleanup_assert_retirement_runtime || return 1
		identity="$(platform_cleanup_core_database_identity)" || return 1
		IFS='|' read -r database_name system_identifier <<<"$identity"
		anchor="$(platform_cleanup_core_ownership_anchor)" || return 1
		IFS='|' read -r generation contract scope aggregate sequence fence <<<"$anchor"
		platform_cleanup_initialize_marker "$platform_cleanup_marker" preparing \
			ownership_revision "$ownership_revision" cleanup_revision "$EXPECTED_REVISION" \
			production_env_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
			compose_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" \
			core_database_name "$database_name" core_database_system_identifier "$system_identifier" \
			core_image_id "$core_image" billing_image_id "$billing_image" \
			frontend_validator_image_id "$validator_image" \
			database_restore_image_id "$database_restore_image" generation "$generation" \
			migration "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION" \
			migration_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" \
			first_complete_proof_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256" \
			snapshot_sha256 "$(platform_cutover_marker_value snapshot_sha256)" \
			source_fingerprint "$(platform_cutover_marker_value source_fingerprint)" \
			source_high_watermark "$(platform_cutover_marker_value source_high_watermark)" \
			billing_offer_contract_version "$contract" billing_offer_sequence_scope "$scope" \
			billing_offer_aggregate_version "$aggregate" billing_offer_source_sequence "$sequence" \
			billing_offer_fence_fingerprint "$fence" \
			frontend_revision "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" \
			frontend_origin_sha256 "$(platform_cleanup_frontend_origin_sha256)" \
			frontend_challenge "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
			frontend_attestation_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
			frontend_signature_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
			frontend_public_key_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" || return 1
		phase=preparing
	else
		platform_cleanup_require_common_base || return 1
		if [[ "$(platform_cleanup_marker_value frontend_evidence_sha256)" == pending ]]; then
			platform_cleanup_update_marker preparing \
				frontend_revision "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_REVISION" \
				frontend_origin_sha256 "$(platform_cleanup_frontend_origin_sha256)" \
				frontend_challenge "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_RUNTIME_CHALLENGE" \
				frontend_attestation_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_ATTESTATION_SHA256" \
				frontend_signature_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_SIGNATURE_SHA256" \
				frontend_public_key_sha256 "$PLATFORM_CORE_SOURCE_CLEANUP_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" || return 1
		fi
		platform_cleanup_require_journal_identity || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build \
			api outbox-publisher integration-worker billing-api billing-scheduler \
			billing-worker billing-outbox-publisher database-restore-worker || return 1
		for _ in {1..60}; do
			if platform_cleanup_assert_retirement_runtime >/dev/null 2>&1; then break; fi
			sleep 2
		done
		platform_cleanup_assert_retirement_runtime || return 1
	fi
	platform_cleanup_prepare_private_directory "$directory" || return 1
	platform_cleanup_assert_targets_unchanged || return 1
	platform_cleanup_assert_core_frozen || return 1
	first_proof_destination="$directory/first-complete-proof.evidence"
	if [[ -e "$first_proof_destination" || -L "$first_proof_destination" ]]; then
		platform_cleanup_require_artifact "$first_proof_destination" \
			"$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_SHA256" || return 1
	else
		platform_cleanup_copy_evidence "$PLATFORM_CORE_SOURCE_CLEANUP_FIRST_COMPLETE_PROOF_FILE" \
			"$first_proof_destination" || return 1
	fi
	manifest_sha="$(platform_cleanup_prepare_prisma_manifest "$directory/prisma-manifest.evidence")" || return 1
	pre_ledger_sha="$(platform_cleanup_capture_prisma_ledger "$directory/prisma-manifest.evidence" \
		"$directory/prisma-ledger-pre.evidence" pre)" || return 1
	frontend_sha="$(platform_cleanup_attest_or_revalidate_frontend_runtime "$directory/frontend-attestation.evidence" && \
		platform_cleanup_sha256 "$directory/frontend-attestation.evidence")" || return 1
	frontend_chain_sha="$(platform_cleanup_initialize_frontend_phase_chain "$directory")" || return 1
	topology_sha="$(platform_cleanup_scan_deployment_topology "$directory/topology-scan.evidence" && \
		platform_cleanup_sha256 "$directory/topology-scan.evidence")" || return 1
	platform_cleanup_update_marker preparing \
		prisma_manifest_sha256 "$manifest_sha" prisma_pre_ledger_sha256 "$pre_ledger_sha" \
		frontend_evidence_sha256 "$frontend_sha" \
		frontend_phase_evidence_chain_sha256 "$frontend_chain_sha" \
		topology_scan_evidence_sha256 "$topology_sha" || return 1
	# The signed frontend/runtime and rendered deployment scans are both durable
	# and bound before any RabbitMQ topology is deleted.
	platform_cleanup_attest_or_revalidate_frontend_runtime "$directory/frontend-attestation.evidence" || return 1
	platform_cleanup_validate_topology_evidence "$directory/topology-scan.evidence" || return 1
	platform_cleanup_assert_credential_scope || return 1
	platform_cleanup_retire_legacy_settings_source_topology || return 1
	platform_cleanup_assert_legacy_settings_source_bindings_absent || return 1
	soak_sha="$(platform_cleanup_generate_or_adopt_live_evidence "$directory/soak.evidence" \
		platform-core-cleanup-soak platform_cleanup_assert_soaked_runtime)" || return 1
	route_sha="$(platform_cleanup_generate_or_adopt_live_evidence "$directory/routes.evidence" \
		platform-core-cleanup-routes platform_cleanup_assert_routes)" || return 1
	queue_sha="$(platform_cleanup_generate_or_adopt_live_evidence "$directory/queues.evidence" \
		platform-core-cleanup-queues platform_cleanup_assert_queues)" || return 1
	outbox_sha="$(platform_cleanup_generate_or_adopt_live_evidence "$directory/outbox.evidence" \
		platform-core-cleanup-outbox platform_cleanup_assert_outbox 1)" || return 1
	core_pre_sha="$(platform_cleanup_dump DATABASE_BACKUP_URL public "$directory/core-pre-cleanup.dump" pending)" || return 1
	platform_pre_sha="$(platform_cleanup_dump PLATFORM_BACKUP_URL platform "$directory/platform-pre-cleanup.dump" pending)" || return 1
	platform_cleanup_update_marker preparing \
		core_pre_backup_sha256 "$core_pre_sha" platform_pre_backup_sha256 "$platform_pre_sha" \
		soak_evidence_sha256 "$soak_sha" route_evidence_sha256 "$route_sha" \
		queue_evidence_sha256 "$queue_sha" outbox_evidence_sha256 "$outbox_sha" || return 1
	if [[ -e "$directory/pre-restore.evidence" || -L "$directory/pre-restore.evidence" ]]; then
		platform_cleanup_validate_restore_evidence "$directory/pre-restore.evidence" pre "$directory" || return 1
	else
		platform_cleanup_restore_pre "$directory/core-pre-cleanup.dump" "$directory/platform-pre-cleanup.dump" \
			"$directory/pre-restore.evidence" || return 1
	fi
	restore_sha="$(platform_cleanup_sha256 "$directory/pre-restore.evidence")" || return 1
	platform_cleanup_update_marker staged pre_restore_evidence_sha256 "$restore_sha" || return 1
	platform_cleanup_require_bound_pre_evidence || return 1
	printf 'platform_core_source_cleanup_phase=staged\n'
	printf 'pre_offsite_receipt_required=%s-%s-g%s.evidence\n' \
		"$PLATFORM_CORE_SOURCE_CLEANUP_PRE_RECEIPT_PREFIX" "$EXPECTED_REVISION" "$generation"
}

platform_cleanup_seal() {
	platform_cleanup_require_confirmation
	platform_cleanup_require_common_base
	acquire_production_deploy_lock 'Platform Core source cleanup seal'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	local phase generation directory receipt_source receipt_destination receipt_sha rehearsal_sha
	phase="$(platform_cleanup_current_phase)" || return 1
	[[ "$phase" =~ ^(staged|sealing|sealed)$ ]] || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build \
		api outbox-publisher integration-worker billing-api billing-scheduler \
		billing-worker billing-outbox-publisher database-restore-worker || return 1
	for _ in {1..60}; do
		if platform_cleanup_assert_retirement_runtime >/dev/null 2>&1; then break; fi
		sleep 2
	done
	platform_cleanup_assert_retirement_runtime || return 1
	platform_cleanup_assert_targets_unchanged
	generation="$(platform_cleanup_marker_value generation)" || return 1
	directory="$(platform_cleanup_evidence_directory "$EXPECTED_REVISION" "$generation")" || return 1
	platform_cleanup_record_fresh_frontend_phase_evidence seal "$directory" || return 1
	platform_cleanup_require_bound_pre_evidence || return 1
	[[ "$(platform_cleanup_source_state)" == present &&
		"$(platform_cleanup_migration_state)" =~ ^(pending|rolled-back)$ ]] || return 1
	platform_cleanup_assert_core_frozen || return 1
	if [[ "$phase" == sealed ]]; then
		printf 'platform_core_source_cleanup_phase=sealed\n'
		return
	fi
	platform_cleanup_validate_live_boundary 1 || return 1
	platform_cleanup_capture_prisma_ledger "$directory/prisma-manifest.evidence" \
		"$directory/prisma-ledger-pre.evidence" pre >/dev/null || return 1
	if [[ "$phase" == staged ]]; then
		platform_cleanup_update_marker sealing || return 1
		phase=sealing
	fi
	receipt_source="$PLATFORM_CORE_SOURCE_CLEANUP_PRE_RECEIPT_PREFIX-$EXPECTED_REVISION-g$generation.evidence"
	receipt_destination="$directory/pre-offsite-receipt.evidence"
	platform_cleanup_validate_offsite_receipt "$receipt_source" pre "$directory" || return 1
	if [[ -e "$receipt_destination" || -L "$receipt_destination" ]]; then
		platform_cleanup_validate_offsite_receipt "$receipt_destination" pre "$directory" || return 1
		[[ "$(platform_cleanup_sha256 "$receipt_source")" == "$(platform_cleanup_sha256 "$receipt_destination")" ]] || return 1
	else
		platform_cleanup_copy_evidence "$receipt_source" "$receipt_destination" || return 1
	fi
	receipt_sha="$(platform_cleanup_sha256 "$receipt_destination")" || return 1
	platform_cleanup_update_marker sealing pre_offsite_receipt_sha256 "$receipt_sha" || return 1
	rehearsal_sha="$(platform_cleanup_rehearse_migration "$directory")" || return 1
	platform_cleanup_update_marker sealed migration_rehearsal_evidence_sha256 "$rehearsal_sha" || return 1
	platform_cleanup_require_bound_pre_evidence || return 1
	printf 'platform_core_source_cleanup_phase=sealed\n'
}

platform_cleanup_recheck_destructive_preconditions() {
	[[ $# -eq 3 && "$2" =~ ^(running|stopped)$ && "$3" =~ ^(exact|compatible|failed)$ ]] || return 1
	local directory="$1" core_mode="$2" ledger_mode="$3"
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	platform_cleanup_assert_targets_unchanged || return 1
	platform_cleanup_require_bound_pre_evidence || return 1
	platform_cleanup_assert_cleanup_source_retired || return 1
	if [[ "$core_mode" == running ]]; then
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build api outbox-publisher integration-worker || return 1
		for _ in {1..60}; do
			if platform_cleanup_assert_retirement_runtime >/dev/null 2>&1; then break; fi
			sleep 2
		done
		platform_cleanup_assert_retirement_runtime || return 1
	else
		platform_cleanup_assert_core_services_stopped || return 1
		platform_cleanup_assert_database_restore_runtime || return 1
	fi
	platform_cleanup_assert_core_frozen || return 1
	case "$ledger_mode" in
	exact)
		platform_cleanup_capture_prisma_ledger "$directory/prisma-manifest.evidence" \
			"$directory/prisma-ledger-pre.evidence" pre >/dev/null || return 1
		;;
	compatible)
		platform_cleanup_validate_live_prisma_ledger "$directory/prisma-manifest.evidence" pre || return 1
		;;
	failed)
		platform_cleanup_validate_live_prisma_ledger "$directory/prisma-manifest.evidence" failed-pre || return 1
		;;
	esac
	# Re-run the signed validator and the exact deployment render immediately
	# before DDL; merely trusting the staged files would not detect later drift.
	platform_cleanup_attest_current_frontend_runtime "$directory" || return 1
	platform_cleanup_scan_deployment_topology "$directory/topology-scan.evidence" || return 1
	platform_cleanup_assert_credential_scope || return 1
	platform_cleanup_assert_legacy_settings_source_bindings_absent || return 1
	platform_cleanup_validate_live_boundary 1 "$core_mode"
}

platform_cleanup_execute_forward() {
	[[ $# -eq 1 && "$1" =~ ^(run|recovery)$ ]] || return 1
	local action="$1" phase source_state migration_state generation directory ledger_mode frontend_action
	local core_post_sha post_restore_sha post_ledger_sha expected_post_sha
	platform_cleanup_require_confirmation
	platform_cleanup_require_common_base
	acquire_production_deploy_lock 'Platform Core source cleanup forward execution'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	platform_cleanup_assert_targets_unchanged
	phase="$(platform_cleanup_current_phase)" || return 1
	if [[ "$action" == run ]]; then
		[[ "$phase" == sealed ]] ||
			platform_cleanup_fail "--run requires phase=sealed; current phase=$phase" || return 1
	else
		[[ "$phase" =~ ^(forward-only|migrating|applied)$ ]] ||
			platform_cleanup_fail "--forward-recovery requires phase=forward-only|migrating|applied; current phase=$phase" || return 1
	fi
	generation="$(platform_cleanup_marker_value generation)" || return 1
	directory="$(platform_cleanup_evidence_directory "$EXPECTED_REVISION" "$generation")" || return 1
	frontend_action=run
	[[ "$action" == run ]] || frontend_action=forward-recovery
	platform_cleanup_record_fresh_frontend_phase_evidence "$frontend_action" "$directory" || return 1
	platform_cleanup_require_bound_pre_evidence || return 1
	# Recreate the exact cleanup-revision restore runner while the deploy lock is
	# held. The destructive precondition re-runs the quiescence guard after this
	# replacement and immediately before Core stop/DDL.
	platform_cleanup_recreate_database_restore_runtime || return 1
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	platform_cleanup_configure_migration_gucs reset || return 1
	source_state="$(platform_cleanup_source_state)" || return 1
	migration_state="$(platform_cleanup_migration_state)" || return 1
	case "$phase:$source_state:$migration_state" in
	sealed:present:pending | sealed:present:rolled-back)
		platform_cleanup_recheck_destructive_preconditions "$directory" running exact || return 1
		platform_cleanup_update_marker forward-only || return 1
		phase=forward-only
		;;
	forward-only:present:pending | forward-only:present:rolled-back | \
		migrating:present:pending | migrating:present:failed | migrating:present:rolled-back | \
		migrating:absent:failed | migrating:absent:rolled-back | migrating:absent:applied | \
		applied:absent:applied) ;;
		*) platform_cleanup_fail "unsafe forward cleanup state: phase=$phase source=$source_state migration=$migration_state"; return 1 ;;
	esac
	if [[ "$phase" == applied ]]; then
		platform_cleanup_require_bound_post_evidence || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate api outbox-publisher integration-worker || return 1
		for _ in {1..60}; do
			if platform_cleanup_assert_retirement_runtime >/dev/null 2>&1; then break; fi
			sleep 2
		done
		platform_cleanup_assert_retirement_runtime || return 1
		platform_cleanup_assert_targets_unchanged || return 1
		platform_cleanup_validate_live_boundary 0 || return 1
		printf 'platform_core_source_cleanup_phase=applied\n'
		printf 'post_offsite_receipt_required=%s-%s-g%s.evidence\n' \
			"$PLATFORM_CORE_SOURCE_CLEANUP_POST_RECEIPT_PREFIX" "$EXPECTED_REVISION" "$generation"
		return
	fi
	if [[ "$source_state" == present ]]; then
		case "$phase:$migration_state" in
		forward-only:pending | forward-only:rolled-back | migrating:pending) ledger_mode=exact ;;
		migrating:rolled-back) ledger_mode=compatible ;;
		migrating:failed) ledger_mode=failed ;;
		*) platform_cleanup_fail "unsafe retry state before DDL: phase=$phase migration=$migration_state"; return 1 ;;
		esac
		platform_cleanup_recheck_destructive_preconditions "$directory" running "$ledger_mode" || return 1
		database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop --timeout 90 api outbox-publisher integration-worker || return 1
		platform_cleanup_recheck_destructive_preconditions "$directory" stopped "$ledger_mode" || return 1
		if [[ "$phase" == forward-only ]]; then
			platform_cleanup_update_marker migrating || return 1
			phase=migrating
		fi
		if [[ "$migration_state" == failed ]]; then
			database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
			platform_cleanup_assert_database_restore_runtime || return 1
			platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
				--profile migration run --rm -T --no-deps migrate migrate resolve \
				--rolled-back "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION" || return 1
			[[ "$(platform_cleanup_migration_state)" == rolled-back ]] || return 1
			platform_cleanup_recheck_destructive_preconditions "$directory" stopped compatible || return 1
			migration_state=rolled-back
		fi
		database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
		platform_cleanup_assert_database_restore_runtime || return 1
		platform_cleanup_apply_migration "$migration_state" ||
			platform_cleanup_fail 'cleanup migration failed; recovery remains phase=migrating.' || return 1
	else
		[[ "$phase" == migrating && "$migration_state" =~ ^(failed|rolled-back|applied)$ ]] ||
			platform_cleanup_fail "unsafe post-DDL recovery state: phase=$phase migration=$migration_state" || return 1
		database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop --timeout 90 api outbox-publisher integration-worker || return 1
		platform_cleanup_assert_core_services_stopped || return 1
	fi
	platform_cleanup_configure_migration_gucs reset || return 1
	platform_cleanup_assert_targets_unchanged || return 1
	[[ "$(platform_cleanup_source_state)" == absent ]] || return 1
	platform_cleanup_assert_retained_billing_seam || return 1
	platform_cleanup_assert_database_restore_runtime || return 1
	platform_cleanup_attest_current_frontend_runtime "$directory" || return 1
	platform_cleanup_scan_deployment_topology "$directory/topology-scan.evidence" || return 1
	platform_cleanup_assert_credential_scope || return 1
	platform_cleanup_validate_live_boundary 0 stopped || return 1
	migration_state="$(platform_cleanup_migration_state)" || return 1
	if [[ "$migration_state" =~ ^(failed|rolled-back)$ ]]; then
		platform_cleanup_validate_live_prisma_ledger "$directory/prisma-manifest.evidence" unrecorded-post || return 1
		database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
		platform_cleanup_assert_database_restore_runtime || return 1
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			--profile migration run --rm -T --no-deps migrate migrate resolve \
			--applied "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION" || return 1
	fi
	[[ "$(platform_cleanup_migration_state)" == applied ]] || return 1
	post_ledger_sha="$(platform_cleanup_capture_prisma_ledger "$directory/prisma-manifest.evidence" \
		"$directory/prisma-ledger-post.evidence" post)" || return 1
	platform_cleanup_update_marker migrating prisma_post_ledger_sha256 "$post_ledger_sha" || return 1
	expected_post_sha="$(platform_cleanup_marker_value core_post_backup_sha256)" || return 1
	core_post_sha="$(platform_cleanup_dump DATABASE_BACKUP_URL public "$directory/core-post-cleanup.dump" "$expected_post_sha")" || return 1
	platform_cleanup_update_marker migrating core_post_backup_sha256 "$core_post_sha" || return 1
	if [[ -e "$directory/post-restore.evidence" || -L "$directory/post-restore.evidence" ]]; then
		platform_cleanup_validate_restore_evidence "$directory/post-restore.evidence" post "$directory" || return 1
	else
		platform_cleanup_restore_post "$directory/core-post-cleanup.dump" "$directory/post-restore.evidence" || return 1
	fi
	post_restore_sha="$(platform_cleanup_sha256 "$directory/post-restore.evidence")" || return 1
	platform_cleanup_update_marker applied post_restore_evidence_sha256 "$post_restore_sha" || return 1
	platform_cleanup_require_bound_post_evidence || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate api outbox-publisher integration-worker || return 1
	for _ in {1..60}; do
		if platform_cleanup_assert_retirement_runtime >/dev/null 2>&1; then break; fi
		sleep 2
	done
	platform_cleanup_assert_retirement_runtime || return 1
	platform_cleanup_assert_targets_unchanged || return 1
	platform_cleanup_validate_live_boundary 0 || return 1
	printf 'platform_core_source_cleanup_phase=applied\n'
	printf 'post_offsite_receipt_required=%s-%s-g%s.evidence\n' \
		"$PLATFORM_CORE_SOURCE_CLEANUP_POST_RECEIPT_PREFIX" "$EXPECTED_REVISION" "$generation"
}

platform_cleanup_run() {
	platform_cleanup_execute_forward run
}

platform_cleanup_forward_recovery() {
	platform_cleanup_execute_forward recovery
}

platform_cleanup_write_completion_evidence() {
	[[ $# -eq 3 ]] || return 1
	local destination="$1" post_receipt_sha="$2" observed_at="$3" partial="${1}.partial.$$"
	[[ "$post_receipt_sha" =~ ^[0-9a-f]{64}$ && "$observed_at" =~ ^[0-9TZ:.-]+$ &&
		! -e "$destination" && ! -L "$destination" ]] || return 1
	{
		printf 'version=1\naction=platform-core-cleanup-complete\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\nproduction_env_sha256=%s\ncompose_sha256=%s\n' \
			"$(platform_cleanup_marker_value ownership_revision)" "$EXPECTED_REVISION" \
			"$(platform_cleanup_marker_value production_env_sha256)" \
			"$(platform_cleanup_marker_value compose_sha256)"
		printf 'core_database_name=%s\ncore_database_system_identifier=%s\ngeneration=%s\n' \
			"$(platform_cleanup_marker_value core_database_name)" \
			"$(platform_cleanup_marker_value core_database_system_identifier)" \
			"$(platform_cleanup_marker_value generation)"
		printf 'snapshot_sha256=%s\nsource_fingerprint=%s\nsource_high_watermark=%s\n' \
			"$(platform_cleanup_marker_value snapshot_sha256)" \
			"$(platform_cleanup_marker_value source_fingerprint)" \
			"$(platform_cleanup_marker_value source_high_watermark)"
		printf 'billing_offer_contract_version=%s\nbilling_offer_sequence_scope=%s\n' \
			"$(platform_cleanup_marker_value billing_offer_contract_version)" \
			"$(platform_cleanup_marker_value billing_offer_sequence_scope)"
		printf 'billing_offer_aggregate_version=%s\nbilling_offer_source_sequence=%s\nbilling_offer_fence_fingerprint=%s\n' \
			"$(platform_cleanup_marker_value billing_offer_aggregate_version)" \
			"$(platform_cleanup_marker_value billing_offer_source_sequence)" \
			"$(platform_cleanup_marker_value billing_offer_fence_fingerprint)"
		printf 'first_complete_proof_sha256=%s\nmigration_sha256=%s\nprisma_manifest_sha256=%s\n' \
			"$(platform_cleanup_marker_value first_complete_proof_sha256)" \
			"$(platform_cleanup_marker_value migration_sha256)" \
			"$(platform_cleanup_marker_value prisma_manifest_sha256)"
		printf 'prisma_pre_ledger_sha256=%s\nprisma_post_ledger_sha256=%s\nmigration_rehearsal_evidence_sha256=%s\n' \
			"$(platform_cleanup_marker_value prisma_pre_ledger_sha256)" \
			"$(platform_cleanup_marker_value prisma_post_ledger_sha256)" \
			"$(platform_cleanup_marker_value migration_rehearsal_evidence_sha256)"
		printf 'frontend_evidence_sha256=%s\nfrontend_phase_evidence_chain_sha256=%s\ntopology_scan_evidence_sha256=%s\n' \
			"$(platform_cleanup_marker_value frontend_evidence_sha256)" \
			"$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)" \
			"$(platform_cleanup_marker_value topology_scan_evidence_sha256)"
		printf 'core_pre_backup_sha256=%s\nplatform_pre_backup_sha256=%s\npre_restore_evidence_sha256=%s\n' \
			"$(platform_cleanup_marker_value core_pre_backup_sha256)" \
			"$(platform_cleanup_marker_value platform_pre_backup_sha256)" \
			"$(platform_cleanup_marker_value pre_restore_evidence_sha256)"
		printf 'soak_evidence_sha256=%s\nroute_evidence_sha256=%s\nqueue_evidence_sha256=%s\noutbox_evidence_sha256=%s\n' \
			"$(platform_cleanup_marker_value soak_evidence_sha256)" \
			"$(platform_cleanup_marker_value route_evidence_sha256)" \
			"$(platform_cleanup_marker_value queue_evidence_sha256)" \
			"$(platform_cleanup_marker_value outbox_evidence_sha256)"
		printf 'pre_offsite_receipt_sha256=%s\npost_offsite_receipt_sha256=%s\n' \
			"$(platform_cleanup_marker_value pre_offsite_receipt_sha256)" "$post_receipt_sha"
		printf 'core_post_backup_sha256=%s\npost_restore_evidence_sha256=%s\n' \
			"$(platform_cleanup_marker_value core_post_backup_sha256)" \
			"$(platform_cleanup_marker_value post_restore_evidence_sha256)"
		printf 'legacy_source_absent=true\nmigration_applied=true\nplatform_owner_active=true\n'
		printf 'no_dual_read_write=true\nlegacy_settings_source_topology_absent=true\nclean_restore=true\n'
		printf 'all_core_role_credentials_absent=true\nsigned_frontend_attestation_valid=true\nprisma_ledger_exact=true\n'
		printf 'observed_at=%s\n' "$observed_at"
	} >"$partial"
	platform_cleanup_promote_evidence "$partial" "$destination"
}

platform_cleanup_validate_completion_evidence() {
	[[ $# -eq 1 ]] || return 1
	local file="$1" generation directory completion_chain_sha
	generation="$(platform_cleanup_marker_value generation)" || return 1
	platform_cleanup_validate_evidence "$file" platform-core-cleanup-complete "$EXPECTED_REVISION" "$generation" || return 1
	directory="$(dirname -- "$file")"
	completion_chain_sha="$(awk -F= '
		$1 == "frontend_phase_evidence_chain_sha256" { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$file")" || return 1
	[[ "$completion_chain_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	platform_cleanup_require_artifact "$directory/frontend-phase-evidence.chain" \
		"$(platform_cleanup_marker_value frontend_phase_evidence_chain_sha256)" || return 1
	platform_cleanup_frontend_phase_chain_contains_sha \
		"$directory/frontend-phase-evidence.chain" "$completion_chain_sha" verify || return 1
	OWNERSHIP_REVISION="$(platform_cleanup_marker_value ownership_revision)" \
		CLEANUP_REVISION="$(platform_cleanup_marker_value cleanup_revision)" \
		PRODUCTION_ENV_SHA="$(platform_cleanup_marker_value production_env_sha256)" \
		COMPOSE_SHA="$(platform_cleanup_marker_value compose_sha256)" \
		CORE_DATABASE_NAME="$(platform_cleanup_marker_value core_database_name)" \
		CORE_DATABASE_SYSTEM_IDENTIFIER="$(platform_cleanup_marker_value core_database_system_identifier)" \
		GENERATION="$generation" SNAPSHOT_SHA="$(platform_cleanup_marker_value snapshot_sha256)" \
		SOURCE_FINGERPRINT="$(platform_cleanup_marker_value source_fingerprint)" \
		SOURCE_HIGH_WATERMARK="$(platform_cleanup_marker_value source_high_watermark)" \
		BILLING_OFFER_CONTRACT_VERSION="$(platform_cleanup_marker_value billing_offer_contract_version)" \
		BILLING_OFFER_SEQUENCE_SCOPE="$(platform_cleanup_marker_value billing_offer_sequence_scope)" \
		BILLING_OFFER_AGGREGATE_VERSION="$(platform_cleanup_marker_value billing_offer_aggregate_version)" \
		BILLING_OFFER_SOURCE_SEQUENCE="$(platform_cleanup_marker_value billing_offer_source_sequence)" \
		BILLING_OFFER_FENCE_FINGERPRINT="$(platform_cleanup_marker_value billing_offer_fence_fingerprint)" \
		FIRST_COMPLETE_PROOF_SHA="$(platform_cleanup_marker_value first_complete_proof_sha256)" \
		MIGRATION_SHA="$(platform_cleanup_marker_value migration_sha256)" \
		PRISMA_MANIFEST_SHA="$(platform_cleanup_marker_value prisma_manifest_sha256)" \
		PRISMA_PRE_LEDGER_SHA="$(platform_cleanup_marker_value prisma_pre_ledger_sha256)" \
		PRISMA_POST_LEDGER_SHA="$(platform_cleanup_marker_value prisma_post_ledger_sha256)" \
		MIGRATION_REHEARSAL_SHA="$(platform_cleanup_marker_value migration_rehearsal_evidence_sha256)" \
		FRONTEND_EVIDENCE_SHA="$(platform_cleanup_marker_value frontend_evidence_sha256)" \
		FRONTEND_PHASE_CHAIN_SHA="$completion_chain_sha" \
		TOPOLOGY_SCAN_EVIDENCE_SHA="$(platform_cleanup_marker_value topology_scan_evidence_sha256)" \
		CORE_PRE_SHA="$(platform_cleanup_marker_value core_pre_backup_sha256)" \
		PLATFORM_PRE_SHA="$(platform_cleanup_marker_value platform_pre_backup_sha256)" \
		PRE_RESTORE_SHA="$(platform_cleanup_marker_value pre_restore_evidence_sha256)" \
		SOAK_SHA="$(platform_cleanup_marker_value soak_evidence_sha256)" \
		ROUTE_SHA="$(platform_cleanup_marker_value route_evidence_sha256)" \
		QUEUE_SHA="$(platform_cleanup_marker_value queue_evidence_sha256)" \
		OUTBOX_SHA="$(platform_cleanup_marker_value outbox_evidence_sha256)" \
		PRE_RECEIPT_SHA="$(platform_cleanup_marker_value pre_offsite_receipt_sha256)" \
		POST_RECEIPT_SHA="$(platform_cleanup_marker_value post_offsite_receipt_sha256)" \
		CORE_POST_SHA="$(platform_cleanup_marker_value core_post_backup_sha256)" \
		POST_RESTORE_SHA="$(platform_cleanup_marker_value post_restore_evidence_sha256)" \
		platform_cleanup_node - "$file" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
const pairs = rows.map(row => { const at = row.indexOf('='); if (at < 1) process.exit(1); return [row.slice(0, at), row.slice(at + 1)]; });
const value = Object.fromEntries(pairs);
const expected = {
  version: '1', action: 'platform-core-cleanup-complete', status: 'verified',
  ownership_revision: process.env.OWNERSHIP_REVISION, cleanup_revision: process.env.CLEANUP_REVISION,
  production_env_sha256: process.env.PRODUCTION_ENV_SHA, compose_sha256: process.env.COMPOSE_SHA,
  core_database_name: process.env.CORE_DATABASE_NAME, core_database_system_identifier: process.env.CORE_DATABASE_SYSTEM_IDENTIFIER,
  generation: process.env.GENERATION, snapshot_sha256: process.env.SNAPSHOT_SHA,
  source_fingerprint: process.env.SOURCE_FINGERPRINT, source_high_watermark: process.env.SOURCE_HIGH_WATERMARK,
  billing_offer_contract_version: process.env.BILLING_OFFER_CONTRACT_VERSION,
  billing_offer_sequence_scope: process.env.BILLING_OFFER_SEQUENCE_SCOPE,
  billing_offer_aggregate_version: process.env.BILLING_OFFER_AGGREGATE_VERSION,
  billing_offer_source_sequence: process.env.BILLING_OFFER_SOURCE_SEQUENCE,
  billing_offer_fence_fingerprint: process.env.BILLING_OFFER_FENCE_FINGERPRINT,
  first_complete_proof_sha256: process.env.FIRST_COMPLETE_PROOF_SHA, migration_sha256: process.env.MIGRATION_SHA,
  prisma_manifest_sha256: process.env.PRISMA_MANIFEST_SHA, prisma_pre_ledger_sha256: process.env.PRISMA_PRE_LEDGER_SHA,
  prisma_post_ledger_sha256: process.env.PRISMA_POST_LEDGER_SHA,
	  migration_rehearsal_evidence_sha256: process.env.MIGRATION_REHEARSAL_SHA,
	  frontend_evidence_sha256: process.env.FRONTEND_EVIDENCE_SHA,
	  frontend_phase_evidence_chain_sha256: process.env.FRONTEND_PHASE_CHAIN_SHA,
	  topology_scan_evidence_sha256: process.env.TOPOLOGY_SCAN_EVIDENCE_SHA,
  core_pre_backup_sha256: process.env.CORE_PRE_SHA, platform_pre_backup_sha256: process.env.PLATFORM_PRE_SHA,
  pre_restore_evidence_sha256: process.env.PRE_RESTORE_SHA, soak_evidence_sha256: process.env.SOAK_SHA,
  route_evidence_sha256: process.env.ROUTE_SHA, queue_evidence_sha256: process.env.QUEUE_SHA,
  outbox_evidence_sha256: process.env.OUTBOX_SHA, pre_offsite_receipt_sha256: process.env.PRE_RECEIPT_SHA,
  post_offsite_receipt_sha256: process.env.POST_RECEIPT_SHA, core_post_backup_sha256: process.env.CORE_POST_SHA,
  post_restore_evidence_sha256: process.env.POST_RESTORE_SHA,
  legacy_source_absent: 'true', migration_applied: 'true', platform_owner_active: 'true', no_dual_read_write: 'true',
  legacy_settings_source_topology_absent: 'true', clean_restore: 'true', all_core_role_credentials_absent: 'true',
  signed_frontend_attestation_valid: 'true', prisma_ledger_exact: 'true',
};
if (pairs.length !== Object.keys(value).length || Object.keys(value).length !== Object.keys(expected).length + 1 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.observed_at || '')) process.exit(1);
for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) process.exit(1);
for (const key of Object.keys(value)) if (key !== 'observed_at' && !Object.hasOwn(expected, key)) process.exit(1);
NODE
}

platform_cleanup_verify() {
	platform_cleanup_require_confirmation
	platform_cleanup_require_common
	acquire_production_deploy_lock 'Platform Core source cleanup verification'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	platform_cleanup_assert_targets_unchanged
	local phase generation directory receipt_source receipt_destination receipt_sha completion completion_sha
	phase="$(platform_cleanup_current_phase)" || return 1
	[[ "$phase" =~ ^(applied|verifying|complete)$ ]] || return 1
	[[ "$(platform_cleanup_source_state)" == absent &&
		"$(platform_cleanup_migration_state)" == applied ]] || return 1
	platform_cleanup_assert_retained_billing_seam || return 1
	generation="$(platform_cleanup_marker_value generation)" || return 1
	directory="$(platform_cleanup_evidence_directory "$EXPECTED_REVISION" "$generation")" || return 1
	platform_cleanup_record_fresh_frontend_phase_evidence verify "$directory" || return 1
	platform_cleanup_require_bound_post_evidence || return 1
	platform_cleanup_capture_prisma_ledger "$directory/prisma-manifest.evidence" \
		"$directory/prisma-ledger-post.evidence" post >/dev/null || return 1
	platform_cleanup_scan_deployment_topology "$directory/topology-scan.evidence" || return 1
	platform_cleanup_validate_live_boundary 0 || return 1
	if [[ "$phase" == complete ]]; then
		platform_cleanup_require_artifact "$directory/post-offsite-receipt.evidence" \
			"$(platform_cleanup_marker_value post_offsite_receipt_sha256)" || return 1
		platform_cleanup_validate_offsite_receipt "$directory/post-offsite-receipt.evidence" post "$directory" || return 1
		platform_cleanup_require_artifact "$directory/completion.evidence" \
			"$(platform_cleanup_marker_value completion_evidence_sha256)" || return 1
		platform_cleanup_validate_completion_evidence "$directory/completion.evidence" || return 1
		printf 'platform_core_source_cleanup_phase=complete\n'
		return
	fi
	if [[ "$phase" == applied ]]; then
		platform_cleanup_update_marker verifying || return 1
		phase=verifying
	fi
	receipt_source="$PLATFORM_CORE_SOURCE_CLEANUP_POST_RECEIPT_PREFIX-$EXPECTED_REVISION-g$generation.evidence"
	receipt_destination="$directory/post-offsite-receipt.evidence"
	if [[ "$(platform_cleanup_marker_value post_offsite_receipt_sha256)" == pending ]]; then
		platform_cleanup_validate_offsite_receipt "$receipt_source" post "$directory" || return 1
		if [[ -e "$receipt_destination" || -L "$receipt_destination" ]]; then
			platform_cleanup_validate_offsite_receipt "$receipt_destination" post "$directory" || return 1
			[[ "$(platform_cleanup_sha256 "$receipt_source")" == "$(platform_cleanup_sha256 "$receipt_destination")" ]] || return 1
		else
			platform_cleanup_copy_evidence "$receipt_source" "$receipt_destination" || return 1
		fi
	else
		platform_cleanup_require_artifact "$receipt_destination" \
			"$(platform_cleanup_marker_value post_offsite_receipt_sha256)" || return 1
		platform_cleanup_validate_offsite_receipt "$receipt_destination" post "$directory" || return 1
		if [[ -e "$receipt_source" || -L "$receipt_source" ]]; then
			platform_cleanup_validate_offsite_receipt "$receipt_source" post "$directory" || return 1
			[[ "$(platform_cleanup_sha256 "$receipt_source")" == "$(platform_cleanup_sha256 "$receipt_destination")" ]] || return 1
		fi
	fi
	receipt_sha="$(platform_cleanup_sha256 "$receipt_destination")" || return 1
	platform_cleanup_update_marker verifying post_offsite_receipt_sha256 "$receipt_sha" || return 1
	completion="$directory/completion.evidence"
	if [[ -e "$completion" || -L "$completion" ]]; then
		platform_cleanup_validate_completion_evidence "$completion" || return 1
	else
		platform_cleanup_write_completion_evidence "$completion" "$receipt_sha" \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
	fi
	completion_sha="$(platform_cleanup_sha256 "$completion")" || return 1
	platform_cleanup_update_marker complete completion_evidence_sha256 "$completion_sha" || return 1
	platform_cleanup_validate_completion_evidence "$completion" || return 1
	printf 'platform_core_source_cleanup_phase=complete\n'
}

platform_cleanup_status() {
	local phase
	phase="$(platform_cleanup_marker_value_if_present)" || return 1
	printf 'platform_core_source_cleanup_phase=%s\n' "$phase"
	if [[ "$phase" != absent ]]; then
		printf 'platform_core_source_cleanup_revision=%s\n' "$(platform_cleanup_marker_value cleanup_revision)"
		printf 'platform_core_source_cleanup_ownership_revision=%s\n' "$(platform_cleanup_marker_value ownership_revision)"
		printf 'platform_core_source_cleanup_generation=%s\n' "$(platform_cleanup_marker_value generation)"
		printf 'platform_core_source_cleanup_production_env_sha256=%s\n' \
			"$(platform_cleanup_marker_value production_env_sha256)"
		printf 'platform_core_source_cleanup_first_complete_proof_sha256=%s\n' \
			"$(platform_cleanup_marker_value first_complete_proof_sha256)"
	fi
}

platform_cleanup_self_test() (
	local directory now revision ownership generation sha env_sha image marker set_sql reset_sql valid_queues source
	local manifest ledger completion completion_sha tampered candidate old_migration uuid1 uuid2
	local expected_changed_migrations
	local chain chain_sha next_chain_sha chain_previous challenge attestation signature
	local grep_fixture grep_root retirement_source topology_valid topology_invalid
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	grep_fixture="$directory/runtime-source.ts"
	printf 'const retained = true;\n' >"$grep_fixture"
	platform_cleanup_grep_no_match -En 'retired' "$grep_fixture"
	if platform_cleanup_grep_no_match -En 'retained' "$grep_fixture"; then return 1; fi
	if platform_cleanup_grep_no_match -En 'retired' "$directory/missing.ts" >/dev/null 2>&1; then return 1; fi
	grep_root="$directory/runtime-source"
	mkdir -p "$grep_root/nested"
	printf 'const retired = true;\n' >"$grep_root/nested/excluded.spec.ts"
	printf 'const retired = true;\n' >"$grep_root/nested/excluded.test.js"
	printf 'const retired = true;\n' >"$grep_root/nested/excluded.txt"
	platform_cleanup_runtime_source_has_no_match 'retired' "$grep_root"
	printf 'const retired = true;\n' >"$grep_root/nested/runtime.ts"
	if platform_cleanup_runtime_source_has_no_match 'retired' "$grep_root"; then return 1; fi
	if platform_cleanup_runtime_source_has_no_match 'retired' "$directory/missing-runtime" >/dev/null 2>&1; then return 1; fi
	ENV_FILE="$directory/.env.production"
	printf 'SELF_TEST=value\n' >"$ENV_FILE"
	chmod 600 "$ENV_FILE"
	env_sha="$(platform_cleanup_sha256 "$ENV_FILE")"
	PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256="$env_sha"
	platform_cleanup_require_env_identity
	printf 'SELF_TEST=changed\n' >"$ENV_FILE"
	if platform_cleanup_require_env_identity >/dev/null 2>&1; then return 1; fi
	printf 'SELF_TEST=value\n' >"$ENV_FILE"
	platform_cleanup_require_env_identity
	topology_valid="$directory/rendered-valid.json"
	topology_invalid="$directory/rendered-invalid.json"
	printf '%s\n' '{"services":{"api":{"environment":{"APP_REVISION":"revision"}},"outbox-publisher":{"environment":{}},"integration-worker":{"environment":[]},"gateway":{"command":["proxy","/api/v1/site-settings"]},"platform-api":{"environment":{"PUBLIC_ROUTE":"/api/v1/legal-pages"}}}}' >"$topology_valid"
	chmod 600 "$topology_valid"
	platform_cleanup_validate_rendered_topology "$topology_valid"
	printf '%s\n' '{"services":{"api":{"command":["serve","/api/v1/site-settings"]},"outbox-publisher":{},"integration-worker":{}}}' >"$topology_invalid"
	chmod 600 "$topology_invalid"
	if platform_cleanup_validate_rendered_topology "$topology_invalid" >/dev/null 2>&1; then return 1; fi
	printf '%s\n' '{"services":{"api":{},"outbox-publisher":{"command":["publish","billing.settings.source.changed.v1"]},"integration-worker":{}}}' >"$topology_invalid"
	if platform_cleanup_validate_rendered_topology "$topology_invalid" >/dev/null 2>&1; then return 1; fi
	printf '%s\n' '{"services":{"api":{"environment":{"PLATFORM_DATABASE_URL":"redacted"}},"outbox-publisher":{},"integration-worker":{}}}' >"$topology_invalid"
	if platform_cleanup_validate_rendered_topology "$topology_invalid" >/dev/null 2>&1; then return 1; fi
	printf '%s\n' '{"services":{"api":{},"outbox-publisher":{},"integration-worker":{},"worker":{"volumes":["./src/site-settings:/runtime"]}}}' >"$topology_invalid"
	if platform_cleanup_validate_rendered_topology "$topology_invalid" >/dev/null 2>&1; then return 1; fi
	platform_cleanup_database_identities_match 'default_db|123' 'default_db|123'
	if platform_cleanup_database_identities_match 'default_db|123' 'default_db|124'; then return 1; fi
	if platform_cleanup_database_identities_match 'other_db|123' 'other_db|123'; then return 1; fi
	platform_cleanup_marker="$directory/marker"
	revision='0123456789abcdef0123456789abcdef01234567'
	ownership='89abcdef0123456789abcdef0123456789abcdef'
	generation=1
	sha="$(printf 'a%.0s' {1..64})"
	image="sha256:$sha"
	now='2026-08-24T00:00:00Z'
	EXPECTED_REVISION="$revision"
	PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION='20260825000000_remove_legacy_platform_core_source'
	PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256="$sha"
	platform_cleanup_transition_allowed absent preparing
	platform_cleanup_transition_allowed preparing staged
	platform_cleanup_transition_allowed staged sealing
	platform_cleanup_transition_allowed sealing sealed
	platform_cleanup_transition_allowed sealed forward-only
	platform_cleanup_transition_allowed forward-only migrating
	platform_cleanup_transition_allowed migrating applied
	platform_cleanup_transition_allowed applied verifying
	platform_cleanup_transition_allowed verifying complete
	if platform_cleanup_transition_allowed absent staged ||
		platform_cleanup_transition_allowed staged sealed ||
		platform_cleanup_transition_allowed sealed applied; then return 1; fi
	platform_cleanup_initialize_marker "$platform_cleanup_marker" preparing \
		ownership_revision "$ownership" cleanup_revision "$revision" \
		production_env_sha256 "$env_sha" compose_sha256 "$sha" \
		core_database_name default_db core_database_system_identifier 123 \
		core_image_id "$image" billing_image_id "$image" \
		frontend_validator_image_id "$image" database_restore_image_id "$image" generation "$generation" \
		migration "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION" migration_sha256 "$sha" \
		first_complete_proof_sha256 "$sha" snapshot_sha256 "$sha" source_fingerprint "$sha" \
		source_high_watermark 1 billing_offer_contract_version 2 \
		billing_offer_sequence_scope billing.offer:offer billing_offer_aggregate_version 1 \
		billing_offer_source_sequence 1 billing_offer_fence_fingerprint "$sha" \
		frontend_revision "$ownership" frontend_origin_sha256 "$sha" frontend_challenge "$sha" \
		frontend_attestation_sha256 "$sha" frontend_signature_sha256 "$sha" \
		frontend_public_key_sha256 "$sha"
	if platform_cleanup_update_marker preparing \
		frontend_revision "$revision" frontend_origin_sha256 "$env_sha" \
		frontend_public_key_sha256 "$env_sha" >/dev/null 2>&1; then return 1; fi
	platform_cleanup_update_marker preparing \
		frontend_challenge "$env_sha" frontend_attestation_sha256 "$env_sha" \
		frontend_signature_sha256 "$env_sha"
	[[ "$(platform_cleanup_marker_value frontend_revision)" == "$ownership" &&
		"$(platform_cleanup_marker_value frontend_origin_sha256)" == "$sha" &&
		"$(platform_cleanup_marker_value frontend_public_key_sha256)" == "$sha" &&
		"$(platform_cleanup_marker_value frontend_attestation_sha256)" == "$env_sha" ]]
	chain="$directory/frontend-phase-evidence.chain"
	printf 'version=1\n' >"$chain"
	chmod 600 "$chain"
	chain_previous="$(platform_cleanup_sha256 "$chain")"
	challenge="$(printf 'b%.0s' {1..64})"
	attestation="$(printf 'c%.0s' {1..64})"
	signature="$(printf 'd%.0s' {1..64})"
	printf '1\tverify\t%s\t%s\t%s\t%s\t%s\n' \
		"$challenge" "$attestation" "$signature" "$now" "$chain_previous" >>"$chain"
	platform_cleanup_validate_frontend_phase_chain "$chain" >/dev/null
	chain_sha="$(platform_cleanup_sha256 "$chain")"
	platform_cleanup_frontend_phase_chain_contains_sha "$chain" "$chain_sha" verify
	candidate="$directory/frontend-phase-duplicate.chain"
	cp -- "$chain" "$candidate"
	printf '2\tseal\t%s\t%s\t%s\t%s\t%s\n' \
		"$challenge" "$(printf 'e%.0s' {1..64})" "$(printf 'f%.0s' {1..64})" \
		"$now" "$chain_sha" >>"$candidate"
	chmod 600 "$candidate"
	if platform_cleanup_validate_frontend_phase_chain "$candidate" >/dev/null 2>&1; then return 1; fi
	rm -f -- "$candidate"
	platform_cleanup_update_marker preparing \
		prisma_manifest_sha256 "$sha" prisma_pre_ledger_sha256 "$sha" \
		frontend_evidence_sha256 "$sha" frontend_phase_evidence_chain_sha256 "$chain_sha" \
		topology_scan_evidence_sha256 "$sha" \
		core_pre_backup_sha256 "$sha" platform_pre_backup_sha256 "$sha" \
		pre_restore_evidence_sha256 "$sha" soak_evidence_sha256 "$sha" \
		route_evidence_sha256 "$sha" queue_evidence_sha256 "$sha" outbox_evidence_sha256 "$sha"
	if platform_cleanup_update_marker preparing \
		frontend_revision "$ownership" frontend_origin_sha256 "$sha" \
		frontend_challenge "$sha" frontend_attestation_sha256 "$sha" \
		frontend_signature_sha256 "$sha" frontend_public_key_sha256 "$sha" \
		>/dev/null 2>&1; then return 1; fi
	if platform_cleanup_update_marker preparing prisma_manifest_sha256 "$env_sha" >/dev/null 2>&1; then return 1; fi
	if platform_cleanup_update_marker preparing prisma_post_ledger_sha256 pending >/dev/null 2>&1; then return 1; fi
	platform_cleanup_update_marker staged
	platform_cleanup_update_marker sealing pre_offsite_receipt_sha256 "$sha"
	platform_cleanup_update_marker sealed migration_rehearsal_evidence_sha256 "$sha"
	platform_cleanup_update_marker forward-only
	platform_cleanup_update_marker migrating prisma_post_ledger_sha256 "$sha" core_post_backup_sha256 "$sha"
	platform_cleanup_update_marker applied post_restore_evidence_sha256 "$sha"
	platform_cleanup_update_marker verifying post_offsite_receipt_sha256 "$sha"
	platform_cleanup_core_database_identity() { printf 'default_db|123\n'; }
	platform_cutover_marker_value() { [[ "$1" == revision ]] && printf '%s\n' "$ownership"; }
	completion="$directory/completion.evidence"
	platform_cleanup_write_completion_evidence "$completion" "$sha" "$now"
	platform_cleanup_validate_completion_evidence "$completion"
	tampered="$directory/completion-tampered.evidence"
	cp -- "$completion" "$tampered"
	printf 'unexpected=true\n' >>"$tampered"
	if platform_cleanup_validate_completion_evidence "$tampered" >/dev/null 2>&1; then return 1; fi
	completion_sha="$(platform_cleanup_sha256 "$completion")"
	platform_cleanup_update_marker complete completion_evidence_sha256 "$completion_sha"
	[[ "$(platform_cleanup_current_phase)" == complete ]]
	printf '2\tverify\t%s\t%s\t%s\t%s\t%s\n' \
		"$(printf 'e%.0s' {1..64})" "$(printf 'f%.0s' {1..64})" \
		"$(printf '1%.0s' {1..64})" "$now" "$chain_sha" >>"$chain"
	platform_cleanup_validate_frontend_phase_chain "$chain" >/dev/null
	next_chain_sha="$(platform_cleanup_sha256 "$chain")"
	platform_cleanup_update_marker complete frontend_phase_evidence_chain_sha256 "$next_chain_sha"
	platform_cleanup_validate_completion_evidence "$completion"
	marker="$(<"$platform_cleanup_marker")"
	[[ "$marker" == *'pre_offsite_receipt_sha256='"$sha"* &&
		"$marker" == *'completion_evidence_sha256='"$completion_sha"* ]]
	candidate="$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION"
	expected_changed_migrations="$(platform_cleanup_expected_changed_migrations)"
	platform_cleanup_changed_migrations_are_exact "$expected_changed_migrations"
	if platform_cleanup_changed_migrations_are_exact \
		"prisma/migrations/$candidate/migration.sql"; then return 1; fi
	if platform_cleanup_changed_migrations_are_exact \
		"$expected_changed_migrations
prisma/migrations/20260824030000_prepare_operations_service_ownership/migration.sql"; then return 1; fi
	old_migration='20260101000000_base'
	uuid1='00000000-0000-4000-8000-000000000001'
	uuid2='00000000-0000-4000-8000-000000000002'
	manifest="$directory/prisma-manifest.evidence"
	ledger="$directory/prisma-ledger.evidence"
	printf '%s|%s\n%s|%s\n' "$old_migration" "$sha" "$candidate" "$sha" >"$manifest"
	printf '%s|%s|%s|2026-08-24T00:00:00.000000Z|2026-08-24T00:00:01.000000Z|-|1|\n' \
		"$uuid1" "$old_migration" "$sha" >"$ledger"
	chmod 600 "$manifest" "$ledger"
	platform_cleanup_validate_prisma_ledger "$manifest" "$ledger" pre
	printf '%s|%s|%s|2026-08-24T00:00:02.000000Z|-|-|0|00\n' \
		"$uuid2" "$candidate" "$sha" >>"$ledger"
	platform_cleanup_validate_prisma_ledger "$manifest" "$ledger" failed-pre
	if platform_cleanup_validate_prisma_ledger "$manifest" "$ledger" pre >/dev/null 2>&1; then return 1; fi
	printf '%s|%s|%s|2026-08-24T00:00:00.000000Z|-|-|0|\n' \
		"$uuid1" "$old_migration" "$sha" >"$ledger"
	if platform_cleanup_validate_prisma_ledger "$manifest" "$ledger" failed-pre >/dev/null 2>&1; then return 1; fi
	printf '%s|%s|%s|2026-08-24T00:00:00.000000Z|2026-08-24T00:00:01.000000Z|-|1|\n' \
		"$uuid1" "$old_migration" "$sha" >"$ledger"
	printf '%s|%s|%s|2026-08-24T00:00:02.000000Z|2026-08-24T00:00:03.000000Z|-|1|\n' \
		"$uuid2" "$candidate" "$sha" >>"$ledger"
	platform_cleanup_validate_prisma_ledger "$manifest" "$ledger" post
	set_sql="$(platform_cleanup_migration_guc_sql set)"
	reset_sql="$(platform_cleanup_migration_guc_sql reset)"
	[[ "$(awk -F';' '{ for (i = 1; i <= NF; i += 1) if ($i ~ /^ALTER ROLE winwidget_migration IN DATABASE default_db SET /) count += 1 } END { print count + 0 }' <<<"$set_sql")" == 31 &&
		"$(awk -F';' '{ for (i = 1; i <= NF; i += 1) if ($i ~ /^ALTER ROLE winwidget_migration IN DATABASE default_db RESET /) count += 1 } END { print count + 0 }' <<<"$reset_sql")" == 31 &&
		"$set_sql" == *'SET "winwidget.platform_production_env_sha256"'* &&
		"$set_sql" == *'SET "winwidget.platform_core_database_system_identifier"'* &&
		"$set_sql" == *'SET "winwidget.platform_billing_offer_fence_fingerprint"'* &&
		"$set_sql" == *'SET "winwidget.platform_prisma_pre_ledger_sha256"'* &&
		"$set_sql" == *'SET "winwidget.platform_frontend_phase_evidence_chain_sha256"'* &&
		"$set_sql" == *'SET "winwidget.platform_first_complete_proof_sha256"'* &&
		"$set_sql" == *'SET "winwidget.platform_pre_offsite_receipt_sha256"'* &&
		"$set_sql" != *'platform_migration_rehearsal_evidence_sha256'* ]]
	valid_queues=$'winwidget.billing.offer.v2 true 0 0 1\nwinwidget.billing.offer.v2.retry.1 true 0 0 0\nwinwidget.billing.offer.v2.retry.2 true 0 0 0\nwinwidget.billing.offer.v2.retry.3 true 0 0 0\nwinwidget.billing.offer.v2.dead-letter true 0 0 0\nwinwidget.admin.audit.platform.v1 true 0 0 1\nwinwidget.admin.audit.platform.v1.retry-v2.1 true 0 0 0\nwinwidget.admin.audit.platform.v1.retry-v2.2 true 0 0 0\nwinwidget.admin.audit.platform.v1.retry-v2.3 true 0 0 0\nwinwidget.admin.audit.platform.v1.dead-letter true 0 0 0'
	platform_cleanup_validate_queue_listing <<<"$valid_queues"
	if platform_cleanup_validate_queue_listing <<<"$valid_queues
winwidget.billing.settings-source.v1 true 0 0 0"; then return 1; fi
	if platform_cleanup_validate_queue_listing <<<"$valid_queues
winwidget.billing.offer.v2.unexpected true 0 0 0"; then return 1; fi
	source="$(<"${BASH_SOURCE[0]}")"
	retirement_source="$(declare -f platform_cleanup_assert_cleanup_source_retired)"
	[[ "$source" == *'DROP LEGACY PLATFORM CORE SOURCE'* &&
		"$source" == *'--stage|--seal|--run|--verify|--forward-recovery'* &&
		"$source" == *'billing_offer_projection_trigger()'* &&
		"$source" == *'billing_source_aggregate_versions'* &&
		"$source" == *'billing_source_sequence'* &&
		"$source" == *'cursor.version=state.billing_offer_aggregate_version'* &&
		"$source" == *'cursor.source_sequence=state.billing_offer_source_sequence'* &&
		"$source" == *'platform_cleanup_assert_retirement_runtime'* &&
		"$source" == *'platform_cutover_assert_integration_worker_candidate'* &&
		"$source" == *'platform_cleanup_recheck_destructive_preconditions'* &&
		"$source" == *'platform_cleanup_attest_frontend_runtime'* &&
		"$source" == *'platform_cleanup_validate_bound_frontend_evidence'* &&
		"$source" == *'platform_cleanup_attest_current_frontend_runtime'* &&
		"$source" == *'platform_cleanup_record_fresh_frontend_phase_evidence'* &&
		"$source" == *'platform_cleanup_frontend_phase_chain_contains_sha'* &&
		"$source" == *'platform_cleanup_recreate_database_restore_runtime'* &&
		"$source" == *'frontend_evidence" == pending'* &&
		"$source" == *'platform_cleanup_scan_deployment_topology'* &&
		"$source" == *'prisma-ledger-post.evidence'* &&
		"$source" == *'--applied "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION"'* &&
		"$source" != *'platform_cleanup_assert_first_ownership_has_no_second_writer'* &&
		"$source" == *'platform_core_source_cleanup'* &&
		"$retirement_source" == *'platform_cleanup_grep_no_match'* &&
		"$retirement_source" == *'platform_cleanup_runtime_source_has_no_match'* ]]
	printf 'platform_core_source_cleanup_self_test=passed\n'
)

# The production actions are appended below the contract/state helpers so the
# script can be sourced by the isolated rehearsal without running a CLI.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--inventory) platform_cleanup_inventory ;;
	--self-test) platform_cleanup_self_test ;;
	--stage) [[ $# -eq 1 ]] || exit 64; platform_cleanup_stage ;;
	--seal) [[ $# -eq 1 ]] || exit 64; platform_cleanup_seal ;;
	--run) [[ $# -eq 1 ]] || exit 64; platform_cleanup_run ;;
	--verify) [[ $# -eq 1 ]] || exit 64; platform_cleanup_verify ;;
	--forward-recovery) [[ $# -eq 1 ]] || exit 64; platform_cleanup_forward_recovery ;;
	--status) [[ $# -eq 1 ]] || exit 64; platform_cleanup_status ;;
	*) platform_cleanup_fail 'Usage: cleanup-platform-core-source-production.sh --inventory|--self-test|--stage|--seal|--run|--verify|--forward-recovery|--status' ;;
	esac
fi
