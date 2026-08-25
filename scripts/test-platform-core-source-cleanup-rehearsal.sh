#!/usr/bin/env bash

# Isolated contract and PostgreSQL 18 rehearsal for the future immutable
# Platform Core source cleanup migration. It never connects to production.

set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly PLATFORM_CLEANUP_REHEARSAL_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly PLATFORM_CLEANUP_REHEARSAL_MARKER_KEYS='version phase ownership_revision cleanup_revision production_env_sha256 compose_sha256 core_database_name core_database_system_identifier core_image_id billing_image_id frontend_validator_image_id database_restore_image_id generation migration migration_sha256 prisma_manifest_sha256 prisma_pre_ledger_sha256 prisma_post_ledger_sha256 first_complete_proof_sha256 snapshot_sha256 source_fingerprint source_high_watermark billing_offer_contract_version billing_offer_sequence_scope billing_offer_aggregate_version billing_offer_source_sequence billing_offer_fence_fingerprint frontend_revision frontend_origin_sha256 frontend_challenge frontend_attestation_sha256 frontend_signature_sha256 frontend_public_key_sha256 frontend_evidence_sha256 frontend_phase_evidence_chain_sha256 topology_scan_evidence_sha256 core_pre_backup_sha256 platform_pre_backup_sha256 pre_restore_evidence_sha256 soak_evidence_sha256 route_evidence_sha256 queue_evidence_sha256 outbox_evidence_sha256 pre_offsite_receipt_sha256 migration_rehearsal_evidence_sha256 core_post_backup_sha256 post_restore_evidence_sha256 post_offsite_receipt_sha256 completion_evidence_sha256 created_at updated_at'
PLATFORM_CLEANUP_REHEARSAL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly PLATFORM_CLEANUP_REHEARSAL_ROOT

platform_cleanup_rehearsal_fail() {
	printf 'platform_core_source_cleanup_rehearsal_error=%s\n' "$1" >&2
	return 1
}

platform_cleanup_rehearsal_sha256() {
	[[ $# -eq 1 ]] || return 1
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

platform_cleanup_rehearsal_promote_evidence() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" && ! -e "$2" && ! -L "$2" ]] || return 1
	chmod 600 "$1"
	sync -f "$1"
	mv -f -- "$1" "$2"
	sync -f "$(dirname -- "$2")"
}

platform_cleanup_rehearsal_node() {
	if command -v node >/dev/null 2>&1; then
		node "$@"
		return
	fi
	local image="${PLATFORM_CLEANUP_NODE_IMAGE:-}"
	[[ "$image" =~ ^sha256:[0-9a-f]{64}$ || "$image" =~ ^winwidget-api:git-[0-9a-f]{40}$ ]] ||
		platform_cleanup_rehearsal_fail 'Node is unavailable and PLATFORM_CLEANUP_NODE_IMAGE is not immutable.' || return 1
	platform_cleanup_rehearsal_assert_local_docker || return 1
	local argument mount_args=() rewritten=()
	for argument in "$@"; do
		if [[ "$argument" == /* && -e "$argument" ]]; then
			mount_args+=(--mount "type=bind,source=$argument,target=/inputs/$(basename -- "$argument"),readonly")
			rewritten+=("/inputs/$(basename -- "$argument")")
		else
			rewritten+=("$argument")
		fi
	done
	docker run --rm -i --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
		"${mount_args[@]}" --entrypoint node "$image" "${rewritten[@]}"
}

platform_cleanup_validate_migration() {
	[[ $# -eq 2 && "$1" == /* && -f "$1" && ! -L "$1" &&
		"$2" =~ ^[0-9a-f]{64}$ && ! "$2" =~ ^0+$ ]] || return 1
	[[ "$(platform_cleanup_rehearsal_sha256 "$1")" == "$2" ]] ||
		platform_cleanup_rehearsal_fail 'migration SHA-256 differs from the reviewed value.' || return 1
	platform_cleanup_rehearsal_node - "$1" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const normalized = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
	.replace(/\(\s+/g, '(')
	.replace(/\s+\)/g, ')')
  .trim();
const required = [
	"LOCK TABLE public.site_settings, public.legal_pages, public.home_page_content, public.platform_core_state, public.billing_source_aggregate_versions, public.outbox_events IN ACCESS EXCLUSIVE MODE",
  "current_setting('winwidget.platform_core_source_cleanup', true)",
  "current_setting('winwidget.platform_ownership_revision', true)",
	  "current_setting('winwidget.platform_cleanup_revision', true)",
	"'winwidget.platform_production_env_sha256'",
	"'winwidget.platform_compose_sha256'",
	"current_setting('winwidget.platform_core_database_name', true)",
	"current_setting('winwidget.platform_core_database_system_identifier', true)",
	  "current_setting('winwidget.platform_generation', true)",
	  "'winwidget.platform_first_complete_proof_sha256'",
	"'winwidget.platform_prisma_manifest_sha256'",
	"'winwidget.platform_prisma_pre_ledger_sha256'",
  "current_setting('winwidget.platform_snapshot_sha256', true)",
  "current_setting('winwidget.platform_source_fingerprint', true)",
	  "current_setting('winwidget.platform_source_high_watermark', true)",
	"current_setting('winwidget.platform_billing_offer_contract_version', true)",
	"current_setting('winwidget.platform_billing_offer_sequence_scope', true)",
	"current_setting('winwidget.platform_billing_offer_aggregate_version', true)",
	"current_setting('winwidget.platform_billing_offer_source_sequence', true)",
	"current_setting('winwidget.platform_billing_offer_fence_fingerprint', true)",
  "'winwidget.platform_core_pre_backup_sha256'",
  "'winwidget.platform_pre_backup_sha256'",
  "'winwidget.platform_pre_restore_evidence_sha256'",
  "'winwidget.platform_soak_evidence_sha256'",
  "'winwidget.platform_route_evidence_sha256'",
  "'winwidget.platform_queue_evidence_sha256'",
	  "'winwidget.platform_outbox_evidence_sha256'",
	"'winwidget.platform_frontend_evidence_sha256'",
	"'winwidget.platform_frontend_phase_evidence_chain_sha256'",
	"'winwidget.platform_topology_scan_evidence_sha256'",
	  "'winwidget.platform_pre_offsite_receipt_sha256'",
	  "current_setting('winwidget.platform_cleanup_migration_sha256', true)",
	"current_setting(evidence_setting, true)",
	"current_database() = current_setting('winwidget.platform_core_database_name', true)",
	"(pg_control_system()).system_identifier::TEXT = current_setting('winwidget.platform_core_database_system_identifier', true)",
	"= 'production-destructive-approved'",
	"source_inventory IS DISTINCT FROM '4|5|4|1|1|true'",
	"post_inventory IS DISTINCT FROM '0|0|0|0|0|true'",
	"current_setting('winwidget.platform_pristine_replay', true) = 'approved-nonproduction-replay'",
	"COALESCE(pristine_bootstrap, false)",
	"COALESCE(production_approved, false)",
	"state.ownership = 'CORE'::public.\"PlatformCoreOwnership\"",
	"state.generation = 0",
	"cursor.version = 1",
	"cursor.source_sequence > 0",
	"migration_name = '20260825000000_remove_legacy_platform_core_source'",
	"checksum = expected_migration_sha256",
	"finished_at IS NULL",
	"rolled_back_at IS NULL",
	"state.ownership = 'PLATFORM'::public.\"PlatformCoreOwnership\"",
	"NOT state.source_writes_enabled",
	"NOT state.legacy_routes_enabled",
	"state.generation::TEXT = current_setting('winwidget.platform_generation', true)",
	"state.prepared_revision = expected_ownership_revision",
	"state.source_revision = expected_ownership_revision",
	"state.ownership_revision = expected_ownership_revision",
	"state.source_snapshot_sha256 = current_setting('winwidget.platform_snapshot_sha256', true)",
	"state.source_fingerprint = current_setting('winwidget.platform_source_fingerprint', true)",
	"state.source_high_watermark::TEXT = current_setting('winwidget.platform_source_high_watermark', true)",
	"state.billing_offer_contract_version::TEXT = current_setting('winwidget.platform_billing_offer_contract_version', true)",
	"state.billing_offer_sequence_scope = current_setting('winwidget.platform_billing_offer_sequence_scope', true)",
	"state.billing_offer_aggregate_version::TEXT = current_setting('winwidget.platform_billing_offer_aggregate_version', true)",
	"state.billing_offer_source_sequence::TEXT = current_setting('winwidget.platform_billing_offer_source_sequence', true)",
	"state.billing_offer_fence_fingerprint = current_setting('winwidget.platform_billing_offer_fence_fingerprint', true)",
	"cursor.version::TEXT = current_setting('winwidget.platform_billing_offer_aggregate_version', true)",
	"cursor.source_sequence::TEXT = current_setting('winwidget.platform_billing_offer_source_sequence', true)",
	"state.fenced_at IS NOT NULL",
	"state.exported_at IS NOT NULL",
	"state.activated_at IS NOT NULL",
	"state.fenced_at <= state.exported_at",
	"state.exported_at <= state.activated_at",
	"status <> 'PUBLISHED'::public.\"OutboxEventStatus\"",
  "DROP TRIGGER \"platform_core_state_transition_guard\" ON public.platform_core_state",
  "DROP TRIGGER \"platform_site_settings_write_fence\" ON public.site_settings",
  "DROP TRIGGER \"platform_legal_pages_write_fence\" ON public.legal_pages",
  "DROP TRIGGER \"platform_home_page_content_write_fence\" ON public.home_page_content",
  "DROP TRIGGER \"billing_offer_projection\" ON public.legal_pages",
  "DROP FUNCTION public.platform_core_state_transition_guard()",
  "DROP FUNCTION public.platform_core_source_writes_enabled()",
  "DROP FUNCTION public.platform_assert_core_write_enabled()",
  "DROP FUNCTION public.billing_offer_projection_trigger()",
  "DELETE FROM public.billing_source_aggregate_versions",
	"WHERE aggregate_type = 'billing.offer' AND aggregate_id = 'offer'",
  "GET DIAGNOSTICS deleted_cursor_rows = ROW_COUNT",
	"deleted_cursor_rows <> 1",
  "DROP TABLE public.site_settings, public.legal_pages, public.home_page_content, public.platform_core_state RESTRICT",
  "DROP TYPE public.\"PlatformCoreOwnership\" RESTRICT",
  "to_regclass('public.billing_source_aggregate_versions')",
	"to_regclass('public.billing_core_state')",
	"to_regclass('public.billing_read_projection_versions')",
	"to_regclass('public.billing_subscription_read_projections')",
	"to_regclass('public.billing_payment_read_projections')",
	"to_regclass('public.billing_affiliate_read_projections')",
	"to_regclass('public.billing_settings_read_projection')",
	"to_regclass('public.billing_settings_compositions')",
  "to_regclass('public.billing_source_sequence')",
  "to_regprocedure('public.billing_record_source_event(text,text,text,text,jsonb,boolean)')",
  "to_regprocedure('public.billing_iso_timestamp(timestamp without time zone)')",
  "source_writes_enabled",
  "legacy_routes_enabled",
];
const missing = required.filter(token => !normalized.includes(token));
const forbidden = [
  /\bCASCADE\b/i,
  /\bIF\s+EXISTS\b/i,
  /\bSECURITY\s+DEFINER\b/i,
  /\bSET\s+ROLE\b/i,
  /DROP\s+TABLE\s+(?:ONLY\s+)?public\.billing_source_aggregate_versions/i,
  /DROP\s+SEQUENCE\s+(?:ONLY\s+)?public\.billing_source_sequence/i,
  /DROP\s+FUNCTION\s+public\.billing_record_source_event/i,
  /DROP\s+FUNCTION\s+public\.billing_iso_timestamp/i,
  /DELETE\s+FROM\s+public\.outbox_events/i,
  /DELETE\s+FROM\s+public\.integration_delivery_(?:receipts|failures)/i,
	/UPDATE\s+public\.(?:outbox_events|integration_delivery_(?:receipts|failures))/i,
	/\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO|TRUNCATE)\b/i,
	/\bDROP\s+(?:DATABASE|SCHEMA|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|EXTENSION|INDEX)\b/i,
	/\bALTER\s+(?:TABLE|TYPE|FUNCTION|ROLE|DATABASE)\b/i,
	/\bCREATE\s+(?:TABLE|TYPE|FUNCTION|TRIGGER|SCHEMA|EXTENSION|INDEX)\b/i,
];
const forbiddenMatch = forbidden.find(pattern => pattern.test(normalized));
if (missing.length || forbiddenMatch ||
	!/^BEGIN;\s/.test(normalized) || !/\sCOMMIT;$/.test(normalized) ||
	(normalized.match(/\bCOMMIT;/g) || []).length !== 1) {
	if (missing.length) console.error(`missing migration contract tokens: ${missing.join(' | ')}`);
	if (forbiddenMatch) console.error(`forbidden migration contract token: ${forbiddenMatch}`);
	process.exit(1);
}
const expectedDrops = {
	trigger: [
		'DROP TRIGGER "platform_core_state_transition_guard" ON public.platform_core_state;',
		'DROP TRIGGER "platform_site_settings_write_fence" ON public.site_settings;',
		'DROP TRIGGER "platform_legal_pages_write_fence" ON public.legal_pages;',
		'DROP TRIGGER "platform_home_page_content_write_fence" ON public.home_page_content;',
		'DROP TRIGGER "billing_offer_projection" ON public.legal_pages;',
	],
	function: [
		'DROP FUNCTION public.platform_core_state_transition_guard();',
		'DROP FUNCTION public.platform_core_source_writes_enabled();',
		'DROP FUNCTION public.platform_assert_core_write_enabled();',
		'DROP FUNCTION public.billing_offer_projection_trigger();',
	],
	table: [
		'DROP TABLE public.site_settings, public.legal_pages, public.home_page_content, public.platform_core_state RESTRICT;',
	],
	type: ['DROP TYPE public."PlatformCoreOwnership" RESTRICT;'],
};
const dropPatterns = {
	trigger: /\bDROP\s+TRIGGER\b[^;]*;/gi,
	function: /\bDROP\s+FUNCTION\b[^;]*;/gi,
	table: /\bDROP\s+TABLE\b[^;]*;/gi,
	type: /\bDROP\s+TYPE\b[^;]*;/gi,
};
for (const [kind, expected] of Object.entries(expectedDrops)) {
	const actual = normalized.match(dropPatterns[kind]) || [];
	if (actual.sort().join('|') !== [...expected].sort().join('|')) process.exit(1);
}
const deletes = normalized.match(/\bDELETE\s+FROM\b[^;]*;/gi) || [];
const expectedDelete = [
	"DELETE FROM public.billing_source_aggregate_versions WHERE aggregate_type = 'billing.offer' AND aggregate_id = 'offer';",
];
if (deletes.join('|') !== expectedDelete.join('|')) process.exit(1);
NODE
}

platform_cleanup_rehearsal_write_valid_contract() {
	[[ $# -eq 1 ]] || return 1
	local canonical
	canonical="$PLATFORM_CLEANUP_REHEARSAL_ROOT/prisma/migrations/20260825000000_remove_legacy_platform_core_source/migration.sql"
	[[ -f "$canonical" && ! -L "$canonical" ]] || return 1
	cp -- "$canonical" "$1"
}

platform_cleanup_rehearsal_self_test() (
	local directory valid tampered extra sha source
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	valid="$directory/valid.sql"
	tampered="$directory/tampered.sql"
	platform_cleanup_rehearsal_write_valid_contract "$valid"
	sha="$(platform_cleanup_rehearsal_sha256 "$valid")"
	platform_cleanup_validate_migration "$valid" "$sha"
	cp -- "$valid" "$tampered"
	printf '\nDROP TABLE public.billing_source_aggregate_versions CASCADE;\n' >>"$tampered"
	if platform_cleanup_validate_migration "$tampered" \
		"$(platform_cleanup_rehearsal_sha256 "$tampered")" >/dev/null 2>&1; then return 1; fi
	extra="$directory/extra.sql"
	awk '{ if ($0 == "COMMIT;") print "DROP TABLE public.unrelated RESTRICT;"; print }' "$valid" >"$extra"
	if platform_cleanup_validate_migration "$extra" \
		"$(platform_cleanup_rehearsal_sha256 "$extra")" >/dev/null 2>&1; then return 1; fi
	awk '{ gsub("aggregate_id = '\''offer'\''", "aggregate_id = '\''other'\''"); print }' "$valid" >"$tampered"
	if platform_cleanup_validate_migration "$tampered" \
		"$(platform_cleanup_rehearsal_sha256 "$tampered")" >/dev/null 2>&1; then return 1; fi
	awk '{ gsub("cursor.version::TEXT = current_setting", "cursor.version::TEXT <> current_setting"); print }' \
		"$valid" >"$tampered"
	if platform_cleanup_validate_migration "$tampered" \
		"$(platform_cleanup_rehearsal_sha256 "$tampered")" >/dev/null 2>&1; then return 1; fi
	source="$(<"${BASH_SOURCE[0]}")"
	[[ "$source" == *'platform_cleanup_rehearsal_assert_local_docker'* &&
		"$source" == *"'SHOW server_version_num;'"* &&
		"$source" == *'prisma/migrations/*/; do'* &&
		"$source" == *'migration_directory="${migration_directory%/}"'* &&
		"$source" != *'prisma/migrations/*; do'* &&
		"$source" == *'RESET "winwidget.platform_pristine_replay"'* &&
		"$source" == *'missing-GUC replay did not roll back exactly'* &&
		"$source" == *'GRANT CREATE ON SCHEMA public TO winwidget_migration'* &&
		"$source" == *'--role winwidget_migration'* &&
		"$source" == *'docker port "$container"'* &&
		"$source" == *'resources_removed_before_evidence=true'* &&
		"$source" == *'restored_prisma_ledger_exact=true'* &&
		"$source" == *"migration_name = '20260825000000_remove_legacy_platform_core_source'"* &&
		"$source" == *"to_regclass('public.billing_settings_compositions')"* &&
		"$source" == *'cursor.version=state.billing_offer_aggregate_version'* &&
		"$source" == *'cursor.source_sequence=state.billing_offer_source_sequence'* ]]
	printf 'platform_core_source_cleanup_rehearsal_self_test=passed\n'
)

platform_cleanup_rehearsal_assert_local_docker() {
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" &&
		"$(docker context show)" == default &&
		"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$(docker info --format '{{.OSType}}')" == linux ]] ||
		platform_cleanup_rehearsal_fail 'exact local Linux Docker endpoint unix:///var/run/docker.sock is required.'
}

platform_cleanup_rehearsal_validate_dump() {
	[[ $# -eq 1 && "$1" == /* && -f "$1" && ! -L "$1" && -s "$1" &&
		"$(head -c 5 "$1")" == PGDMP ]] || return 1
	docker run --rm --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 \
		--mount "type=bind,source=$1,target=/input.dump,readonly" \
		--entrypoint pg_restore "$PLATFORM_CLEANUP_REHEARSAL_POSTGRES_IMAGE" \
		--list /input.dump >/dev/null
}

platform_cleanup_rehearsal_marker_value() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" && "$2" =~ ^[a-z0-9_]+$ ]] || return 1
	awk -F= -v key="$2" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

platform_cleanup_rehearsal_validate_guard_marker() {
	[[ $# -eq 4 && "$4" =~ ^[0-9]{14}_remove_legacy_platform_core_source$ ]] || return 1
	local marker="$1" migration="$2" core_dump="$3" migration_name="$4" key value
	[[ -f "$marker" && ! -L "$marker" ]] || return 1
	awk -F= -v expected_order="$PLATFORM_CLEANUP_REHEARSAL_MARKER_KEYS" '
		BEGIN { expected = split(expected_order, order, " ") }
		$1 != order[NR] { exit 1 }
		{ seen[$1] += 1 }
		END {
			if (NR != expected) exit 1
			for (key in seen) if (seen[key] != 1) exit 1
		}
	' "$marker" || return 1
	[[ "$(platform_cleanup_rehearsal_marker_value "$marker" version)" == 2 &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" phase)" == sealing &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" migration)" == "$migration_name" &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" migration_sha256)" == "$migration" &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" core_pre_backup_sha256)" == "$core_dump" ]] || return 1
	for key in ownership_revision cleanup_revision frontend_revision; do
		value="$(platform_cleanup_rehearsal_marker_value "$marker" "$key")" || return 1
		[[ "$value" =~ ^[0-9a-f]{40}$ ]] || return 1
	done
	[[ "$(platform_cleanup_rehearsal_marker_value "$marker" ownership_revision)" != \
		"$(platform_cleanup_rehearsal_marker_value "$marker" cleanup_revision)" ]] || return 1
	for key in production_env_sha256 compose_sha256 migration_sha256 prisma_manifest_sha256 \
		prisma_pre_ledger_sha256 first_complete_proof_sha256 snapshot_sha256 source_fingerprint \
		billing_offer_fence_fingerprint frontend_origin_sha256 frontend_challenge \
		frontend_attestation_sha256 frontend_signature_sha256 frontend_public_key_sha256 \
		frontend_evidence_sha256 frontend_phase_evidence_chain_sha256 \
		topology_scan_evidence_sha256 core_pre_backup_sha256 \
		platform_pre_backup_sha256 pre_restore_evidence_sha256 soak_evidence_sha256 \
		route_evidence_sha256 queue_evidence_sha256 outbox_evidence_sha256 \
		pre_offsite_receipt_sha256; do
		value="$(platform_cleanup_rehearsal_marker_value "$marker" "$key")" || return 1
		[[ "$value" =~ ^[0-9a-f]{64}$ && ! "$value" =~ ^0+$ ]] || return 1
	done
	[[ "$(platform_cleanup_rehearsal_marker_value "$marker" core_database_name)" == default_db &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" core_database_system_identifier)" =~ ^[1-9][0-9]*$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" core_image_id)" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" billing_image_id)" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" frontend_validator_image_id)" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" database_restore_image_id)" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" generation)" =~ ^[1-9][0-9]{0,17}$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" source_high_watermark)" =~ ^[1-9][0-9]*$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_contract_version)" == 2 &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_sequence_scope)" == billing.offer:offer &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_aggregate_version)" =~ ^[1-9][0-9]*$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_source_sequence)" =~ ^[1-9][0-9]*$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" created_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
		"$(platform_cleanup_rehearsal_marker_value "$marker" updated_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	for key in prisma_post_ledger_sha256 migration_rehearsal_evidence_sha256 \
		core_post_backup_sha256 post_restore_evidence_sha256 \
		post_offsite_receipt_sha256 completion_evidence_sha256; do
		[[ "$(platform_cleanup_rehearsal_marker_value "$marker" "$key")" == pending ]] || return 1
	done
}

platform_cleanup_rehearsal_migrate_pre() (
	[[ $# -eq 7 ]] || return 1
	local core_dump="$1" migration="$2" expected_sha="$3" marker="$4" manifest="$5" pre_ledger="$6" evidence="$7"
	local directory container volume network password_file password restored_system production_system
	local marker_sha dump_sha manifest_sha ledger_sha pre_state post_state combined restored_ledger partial key value attempt
	platform_cleanup_validate_migration "$migration" "$expected_sha"
	platform_cleanup_rehearsal_assert_local_docker
	platform_cleanup_rehearsal_validate_dump "$core_dump"
	dump_sha="$(platform_cleanup_rehearsal_sha256 "$core_dump")"
	platform_cleanup_rehearsal_validate_guard_marker "$marker" "$expected_sha" "$dump_sha" \
		"$(basename -- "$(dirname -- "$migration")")"
	[[ "$manifest" == /* && -f "$manifest" && ! -L "$manifest" && -s "$manifest" &&
		"$pre_ledger" == /* && -f "$pre_ledger" && ! -L "$pre_ledger" && -s "$pre_ledger" ]] || return 1
	manifest_sha="$(platform_cleanup_rehearsal_sha256 "$manifest")"
	ledger_sha="$(platform_cleanup_rehearsal_sha256 "$pre_ledger")"
	[[ "$manifest_sha" == "$(platform_cleanup_rehearsal_marker_value "$marker" prisma_manifest_sha256)" &&
		"$ledger_sha" == "$(platform_cleanup_rehearsal_marker_value "$marker" prisma_pre_ledger_sha256)" ]] || return 1
	[[ "$evidence" == /* && ! -e "$evidence" && ! -L "$evidence" &&
		-d "$(dirname -- "$evidence")" && ! -L "$(dirname -- "$evidence")" ]] || return 1
	directory="$(realpath -- "$(mktemp -d "${TMPDIR:-/tmp}/platform-cleanup-migrate-pre.XXXXXX")")" || return 1
	container="platform-cleanup-migrate-pre-$$"
	volume="platform-cleanup-migrate-pre-data-$$"
	network="platform-cleanup-migrate-pre-net-$$"
	password_file="$directory/postgres-password"
	combined="$directory/exact-migration.sql"
	restored_ledger="$directory/restored-prisma-ledger.evidence"
	password="$(od -An -N24 -tx1 /dev/urandom | tr -d '[:space:]')"
	printf '%s' "$password" >"$password_file"
	chmod 600 "$password_file"
	cleanup_migrate_pre() {
		docker rm -f "$container" >/dev/null 2>&1 || true
		docker volume rm "$volume" >/dev/null 2>&1 || true
		docker network rm "$network" >/dev/null 2>&1 || true
		rm -f -- "$password_file" "$combined" "$restored_ledger"
		rmdir -- "$directory" 2>/dev/null || true
	}
	trap cleanup_migrate_pre EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	docker network create --internal "$network" >/dev/null
	[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|0' ]] || return 1
	docker volume create "$volume" >/dev/null
	docker run -d --name "$container" --network "$network" \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--mount "type=bind,source=$password_file,target=/run/secrets/postgres-password,readonly" \
		-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password -e POSTGRES_DB=default_db \
		"$PLATFORM_CLEANUP_REHEARSAL_POSTGRES_IMAGE" >/dev/null
	[[ -z "$(docker port "$container")" &&
		"$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container")" == "$network" ]] || return 1
	[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|1' ]] || return 1
	for ((attempt = 1; attempt <= 60; attempt++)); do
		if docker exec "$container" pg_isready -U postgres -d default_db >/dev/null 2>&1; then break; fi
		[[ "$attempt" -lt 60 ]] || platform_cleanup_rehearsal_fail 'migration rehearsal PostgreSQL 18 did not become ready.' || return 1
		sleep 1
	done
	[[ "$(docker exec "$container" psql --no-psqlrc -U postgres -d postgres -Atqc 'SHOW server_version_num;')" =~ ^18[0-9]{4}$ ]] ||
		platform_cleanup_rehearsal_fail 'migration rehearsal did not start PostgreSQL 18.' || return 1
	docker cp "$core_dump" "$container:/tmp/core.dump"
	docker exec "$container" psql --no-psqlrc -U postgres -d default_db \
		--set ON_ERROR_STOP=1 --command \
		'CREATE ROLE winwidget_migration LOGIN; GRANT CREATE ON SCHEMA public TO winwidget_migration;' >/dev/null
	docker exec "$container" pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
		--role winwidget_migration -U postgres -d default_db /tmp/core.dump >/dev/null
	docker exec "$container" psql --no-psqlrc -U postgres -d default_db -Atqc "
COPY (
	  SELECT id || '|' || migration_name || '|' || checksum || '|' ||
	    to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') || '|' ||
	    COALESCE(to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), '-') || '|' ||
	    COALESCE(to_char(rolled_back_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), '-') || '|' ||
	    applied_steps_count::text || '|' || encode(convert_to(COALESCE(logs, ''), 'UTF8'), 'hex')
	  FROM public._prisma_migrations
  ORDER BY migration_name COLLATE \"C\", started_at, id
) TO STDOUT;" >"$restored_ledger"
	cmp -s -- "$pre_ledger" "$restored_ledger" ||
		platform_cleanup_rehearsal_fail 'restored PRE snapshot Prisma ledger differs from its sealed full-ledger evidence.' || return 1
	restored_system="$(docker exec "$container" psql --no-psqlrc -U postgres -d postgres -Atqc 'SELECT system_identifier FROM pg_control_system();')"
	production_system="$(platform_cleanup_rehearsal_marker_value "$marker" core_database_system_identifier)"
	[[ "$restored_system" =~ ^[1-9][0-9]*$ && "$production_system" =~ ^[1-9][0-9]*$ &&
		"$restored_system" != "$production_system" ]] || return 1
	pre_state="$(docker exec "$container" psql --no-psqlrc -U postgres -d default_db -Atqc "
SELECT count(*) FROM public.platform_core_state state
WHERE state.id='singleton' AND state.ownership='PLATFORM'::public.\"PlatformCoreOwnership\"
  AND state.source_writes_enabled=FALSE AND state.legacy_routes_enabled=FALSE
  AND state.generation::text='$(platform_cleanup_rehearsal_marker_value "$marker" generation)'
  AND state.prepared_revision='$(platform_cleanup_rehearsal_marker_value "$marker" ownership_revision)'
  AND state.source_revision='$(platform_cleanup_rehearsal_marker_value "$marker" ownership_revision)'
  AND state.ownership_revision='$(platform_cleanup_rehearsal_marker_value "$marker" ownership_revision)'
  AND state.source_snapshot_sha256='$(platform_cleanup_rehearsal_marker_value "$marker" snapshot_sha256)'
  AND state.source_fingerprint='$(platform_cleanup_rehearsal_marker_value "$marker" source_fingerprint)'
  AND state.source_high_watermark::text='$(platform_cleanup_rehearsal_marker_value "$marker" source_high_watermark)'
  AND state.billing_offer_contract_version::text='$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_contract_version)'
  AND state.billing_offer_sequence_scope='$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_sequence_scope)'
  AND state.billing_offer_aggregate_version::text='$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_aggregate_version)'
  AND state.billing_offer_source_sequence::text='$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_source_sequence)'
  AND state.billing_offer_fence_fingerprint='$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_fence_fingerprint)'
  AND state.fenced_at IS NOT NULL AND state.exported_at IS NOT NULL AND state.activated_at IS NOT NULL
  AND state.fenced_at <= state.exported_at AND state.exported_at <= state.activated_at
  AND EXISTS (
    SELECT 1 FROM public.billing_source_aggregate_versions cursor
    WHERE cursor.aggregate_type='billing.offer' AND cursor.aggregate_id='offer'
      AND cursor.version=state.billing_offer_aggregate_version
      AND cursor.source_sequence=state.billing_offer_source_sequence
  );")"
	[[ "$pre_state" == 1 ]] || return 1
	declare -A settings=(
		[platform_core_source_cleanup]=production-destructive-approved
		[platform_ownership_revision]="$(platform_cleanup_rehearsal_marker_value "$marker" ownership_revision)"
		[platform_cleanup_revision]="$(platform_cleanup_rehearsal_marker_value "$marker" cleanup_revision)"
		[platform_production_env_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" production_env_sha256)"
		[platform_compose_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" compose_sha256)"
		[platform_core_database_name]=default_db
		[platform_core_database_system_identifier]="$restored_system"
		[platform_generation]="$(platform_cleanup_rehearsal_marker_value "$marker" generation)"
		[platform_first_complete_proof_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" first_complete_proof_sha256)"
		[platform_cleanup_migration_sha256]="$expected_sha"
		[platform_prisma_manifest_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" prisma_manifest_sha256)"
		[platform_prisma_pre_ledger_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" prisma_pre_ledger_sha256)"
		[platform_snapshot_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" snapshot_sha256)"
		[platform_source_fingerprint]="$(platform_cleanup_rehearsal_marker_value "$marker" source_fingerprint)"
		[platform_source_high_watermark]="$(platform_cleanup_rehearsal_marker_value "$marker" source_high_watermark)"
		[platform_billing_offer_contract_version]="$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_contract_version)"
		[platform_billing_offer_sequence_scope]="$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_sequence_scope)"
		[platform_billing_offer_aggregate_version]="$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_aggregate_version)"
		[platform_billing_offer_source_sequence]="$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_source_sequence)"
		[platform_billing_offer_fence_fingerprint]="$(platform_cleanup_rehearsal_marker_value "$marker" billing_offer_fence_fingerprint)"
		[platform_core_pre_backup_sha256]="$dump_sha"
		[platform_pre_backup_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" platform_pre_backup_sha256)"
		[platform_pre_restore_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" pre_restore_evidence_sha256)"
		[platform_soak_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" soak_evidence_sha256)"
		[platform_route_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" route_evidence_sha256)"
		[platform_queue_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" queue_evidence_sha256)"
		[platform_outbox_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" outbox_evidence_sha256)"
		[platform_frontend_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" frontend_evidence_sha256)"
		[platform_frontend_phase_evidence_chain_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" frontend_phase_evidence_chain_sha256)"
		[platform_topology_scan_evidence_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" topology_scan_evidence_sha256)"
		[platform_pre_offsite_receipt_sha256]="$(platform_cleanup_rehearsal_marker_value "$marker" pre_offsite_receipt_sha256)"
	)
	for key in "${!settings[@]}"; do
		value="${settings[$key]}"
		[[ "$key" =~ ^platform_[a-z0-9_]+$ && "$value" =~ ^[a-zA-Z0-9._:-]+$ ]] || return 1
		printf 'SET "winwidget.%s" TO '\''%s'\'';\n' "$key" "$value" >>"$combined"
	done
	cat "$migration" >>"$combined"
	docker cp "$combined" "$container:/tmp/exact-migration.sql"
	docker exec "$container" psql --no-psqlrc -U winwidget_migration -d default_db \
		--set ON_ERROR_STOP=1 --file /tmp/exact-migration.sql >/dev/null
	post_state="$(docker exec "$container" psql --no-psqlrc -U postgres -d default_db -Atqc "
SELECT
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('platform_core_state_transition_guard','platform_core_source_writes_enabled','platform_assert_core_write_enabled','billing_offer_projection_trigger'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='PlatformCoreOwnership')::text || '|' ||
 (SELECT count(*) FROM public.billing_source_aggregate_versions WHERE aggregate_type='billing.offer' AND aggregate_id='offer')::text || '|' ||
 (to_regclass('public.billing_source_aggregate_versions') IS NOT NULL AND to_regclass('public.billing_source_sequence') IS NOT NULL AND to_regprocedure('public.billing_record_source_event(text,text,text,text,jsonb,boolean)') IS NOT NULL AND to_regprocedure('public.billing_iso_timestamp(timestamp without time zone)') IS NOT NULL)::text;")"
	[[ "$post_state" == '0|0|0|0|0|true' ]] || return 1
	marker_sha="$(platform_cleanup_rehearsal_sha256 "$marker")"
	cleanup_migrate_pre
	trap - EXIT INT TERM
	[[ -z "$(docker ps -aq --filter "name=^/${container}$")" &&
		-z "$(docker volume ls -q --filter "name=^${volume}$")" &&
		-z "$(docker network ls -q --filter "name=^${network}$")" && ! -e "$directory" ]] || return 1
	partial="${evidence}.partial.$$"
	{
		printf 'version=1\naction=platform-core-cleanup-migration-rehearsal\nstatus=verified\n'
		printf 'ownership_revision=%s\ncleanup_revision=%s\nproduction_env_sha256=%s\ncompose_sha256=%s\n' \
			"$(platform_cleanup_rehearsal_marker_value "$marker" ownership_revision)" \
			"$(platform_cleanup_rehearsal_marker_value "$marker" cleanup_revision)" \
			"$(platform_cleanup_rehearsal_marker_value "$marker" production_env_sha256)" \
			"$(platform_cleanup_rehearsal_marker_value "$marker" compose_sha256)"
		printf 'core_database_name=default_db\ncore_database_system_identifier=%s\n' "$production_system"
		printf 'generation=%s\ncore_dump_sha256=%s\nmigration_sha256=%s\nmarker_sha256=%s\n' \
			"$(platform_cleanup_rehearsal_marker_value "$marker" generation)" "$dump_sha" "$expected_sha" "$marker_sha"
		printf 'prisma_manifest_sha256=%s\nprisma_pre_ledger_sha256=%s\nrestored_prisma_ledger_exact=true\n' \
			"$manifest_sha" "$ledger_sha"
		printf 'restored_system_identifier=%s\npre_source_state=exact-active\npost_source_state=%s\n' "$restored_system" "$post_state"
		printf 'postgres_major=18\nmigration_role=winwidget_migration\nexact_migration_applied=true\n'
		printf 'production_system_identifier_substituted_only_for_isolated_restore=true\n'
		printf 'internal_network=true\nno_host_ports=true\nresources_removed_before_evidence=true\nobserved_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$partial"
	platform_cleanup_rehearsal_promote_evidence "$partial" "$evidence"
	printf 'platform_core_source_cleanup_migration_rehearsal=passed\n'
)

platform_cleanup_rehearsal_restore_bundle() (
	[[ $# -ge 6 ]] || return 1
	local mode="$1" core_dump="$2" platform_dump='' evidence cleanup_revision ownership_revision generation fingerprint='' highwater='' production_env
	local source_core_database_name source_core_database_system_identifier compose_sha
	shift 2
	case "$mode" in
	pre)
		[[ $# -eq 11 ]] || return 1
		platform_dump="$1" evidence="$2" cleanup_revision="$3" ownership_revision="$4"
		generation="$5" fingerprint="$6" highwater="$7" production_env="$8"
		source_core_database_name="$9" source_core_database_system_identifier="${10}" compose_sha="${11}"
		;;
	post)
		[[ $# -eq 8 ]] || return 1
		evidence="$1" cleanup_revision="$2" ownership_revision="$3" generation="$4" production_env="$5"
		source_core_database_name="$6" source_core_database_system_identifier="$7" compose_sha="$8"
		;;
	*) return 1 ;;
	esac
	[[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ && "$ownership_revision" =~ ^[0-9a-f]{40}$ &&
		"$cleanup_revision" != "$ownership_revision" && "$generation" =~ ^[1-9][0-9]{0,17}$ &&
		"$production_env" =~ ^[0-9a-f]{64}$ && ! "$production_env" =~ ^0+$ ]] || return 1
	[[ "$source_core_database_name" == default_db && "$source_core_database_system_identifier" =~ ^[1-9][0-9]*$ ]] || return 1
	[[ "$compose_sha" =~ ^[0-9a-f]{64}$ && ! "$compose_sha" =~ ^0+$ ]] || return 1
	if [[ "$mode" == pre ]]; then
		[[ "$fingerprint" =~ ^[0-9a-f]{64}$ && "$highwater" =~ ^[1-9][0-9]*$ ]] || return 1
	fi
	[[ "$evidence" == /* && ! -e "$evidence" && ! -L "$evidence" &&
		-d "$(dirname -- "$evidence")" && ! -L "$(dirname -- "$evidence")" ]] || return 1
	platform_cleanup_rehearsal_assert_local_docker
	platform_cleanup_rehearsal_validate_dump "$core_dump"
	if [[ "$mode" == pre ]]; then platform_cleanup_rehearsal_validate_dump "$platform_dump"; fi

	local work suffix network core_container platform_container core_volume platform_volume
	local core_password_file platform_password_file core_password platform_password
	local core_system platform_system core_repeat platform_repeat core_repeat_sha platform_repeat_sha='pending'
	local core_catalog platform_catalog='pending' core_catalog_sha platform_catalog_sha='pending'
	local core_state platform_state='pending' core_dump_sha platform_dump_sha='pending'
	work="$(realpath -- "$(mktemp -d "${TMPDIR:-/tmp}/platform-cleanup-restore.XXXXXX")")" || return 1
	suffix="$$-$(basename -- "$work")"
	network="platform-cleanup-restore-$suffix"
	core_container="platform-cleanup-core-$suffix"
	platform_container="platform-cleanup-platform-$suffix"
	core_volume="platform-cleanup-core-data-$suffix"
	platform_volume="platform-cleanup-platform-data-$suffix"
	core_password_file="$work/core-password"
	platform_password_file="$work/platform-password"
	core_password="$(od -An -N24 -tx1 /dev/urandom | tr -d '[:space:]')"
	platform_password="$(od -An -N24 -tx1 /dev/urandom | tr -d '[:space:]')"
	printf '%s' "$core_password" >"$core_password_file"
	printf '%s' "$platform_password" >"$platform_password_file"
	chmod 600 "$core_password_file" "$platform_password_file"
	cleanup_bundle() {
		[[ "$core_container" == platform-cleanup-core-* && "$platform_container" == platform-cleanup-platform-* ]] || return 1
		docker rm -f "$core_container" "$platform_container" >/dev/null 2>&1 || true
		docker volume rm "$core_volume" "$platform_volume" >/dev/null 2>&1 || true
		docker network rm "$network" >/dev/null 2>&1 || true
		rm -f -- "$core_password_file" "$platform_password_file" "$core_repeat" "$platform_repeat"
		rmdir -- "$work" 2>/dev/null || true
	}
	trap cleanup_bundle EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	docker network create --internal "$network" >/dev/null
	[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|0' ]] || return 1
	docker volume create "$core_volume" >/dev/null
	docker run -d --name "$core_container" --network "$network" \
		--mount "type=volume,source=$core_volume,target=/var/lib/postgresql" \
		--mount "type=bind,source=$core_password_file,target=/run/secrets/postgres-password,readonly" \
		-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password -e POSTGRES_DB=default_db \
		"$PLATFORM_CLEANUP_REHEARSAL_POSTGRES_IMAGE" >/dev/null
	[[ -z "$(docker port "$core_container")" &&
		"$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$core_container")" == "$network" ]] || return 1
	if [[ "$mode" == pre ]]; then
		docker volume create "$platform_volume" >/dev/null
		docker run -d --name "$platform_container" --network "$network" \
			--mount "type=volume,source=$platform_volume,target=/var/lib/postgresql" \
			--mount "type=bind,source=$platform_password_file,target=/run/secrets/postgres-password,readonly" \
			-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password -e POSTGRES_DB=winwidget_platform \
			"$PLATFORM_CLEANUP_REHEARSAL_POSTGRES_IMAGE" >/dev/null
		[[ -z "$(docker port "$platform_container")" &&
			"$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$platform_container")" == "$network" ]] || return 1
	fi
	if [[ "$mode" == pre ]]; then
		[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|2' ]] || return 1
	else
		[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|1' ]] || return 1
	fi
	local attempt ready
	for ((attempt = 1; attempt <= 60; attempt++)); do
		ready=true
		docker exec "$core_container" pg_isready -U postgres -d default_db >/dev/null 2>&1 || ready=false
		if [[ "$mode" == pre ]]; then
			docker exec "$platform_container" pg_isready -U postgres -d winwidget_platform >/dev/null 2>&1 || ready=false
		fi
		[[ "$ready" == true ]] && break
		[[ "$attempt" -lt 60 ]] || platform_cleanup_rehearsal_fail 'restore PostgreSQL 18 did not become ready.' || return 1
		sleep 1
	done
	docker cp "$core_dump" "$core_container:/tmp/core.dump"
	docker exec "$core_container" pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
		-U postgres -d default_db /tmp/core.dump >/dev/null
	if [[ "$mode" == pre ]]; then
		docker cp "$platform_dump" "$platform_container:/tmp/platform.dump"
		docker exec "$platform_container" pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
			-U postgres -d winwidget_platform /tmp/platform.dump >/dev/null
	fi
	[[ "$(docker exec "$core_container" psql --no-psqlrc -U postgres -d postgres -Atqc 'SHOW server_version_num;')" =~ ^18[0-9]{4}$ ]] || return 1
	core_system="$(docker exec "$core_container" psql --no-psqlrc -U postgres -d postgres -Atqc 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$core_system" =~ ^[1-9][0-9]*$ && "$core_system" != "$source_core_database_system_identifier" ]] || return 1
	core_state="$(docker exec "$core_container" psql --no-psqlrc -U postgres -d default_db -Atqc "
SELECT
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
	 (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
	 (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('platform_core_state_transition_guard','platform_core_source_writes_enabled','platform_assert_core_write_enabled','billing_offer_projection_trigger'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='PlatformCoreOwnership')::text || '|' ||
 (SELECT count(*) FROM public.billing_source_aggregate_versions WHERE aggregate_type='billing.offer' AND aggregate_id='offer')::text || '|' ||
 (to_regclass('public.billing_source_aggregate_versions') IS NOT NULL AND to_regclass('public.billing_source_sequence') IS NOT NULL AND to_regprocedure('public.billing_record_source_event(text,text,text,text,jsonb,boolean)') IS NOT NULL AND to_regprocedure('public.billing_iso_timestamp(timestamp without time zone)') IS NOT NULL)::text;")" || return 1
	case "$mode:$core_state" in pre:4\|5\|4\|1\|1\|true | post:0\|0\|0\|0\|0\|true) ;; *) return 1 ;; esac
	if [[ "$mode" == pre ]]; then
		platform_system="$(docker exec "$platform_container" psql --no-psqlrc -U postgres -d postgres -Atqc 'SELECT system_identifier FROM pg_control_system();')"
		[[ "$platform_system" =~ ^[1-9][0-9]*$ && "$platform_system" != "$core_system" &&
			"$platform_system" != "$source_core_database_system_identifier" ]] || return 1
		platform_state="$(docker exec "$platform_container" psql --no-psqlrc -U postgres -d winwidget_platform -Atqc "
SELECT
 (SELECT count(*) FROM platform.service_identity WHERE id='singleton' AND phase='ACTIVE'::platform.\"ServiceDatabasePhase\" AND source_fingerprint='$fingerprint' AND source_high_watermark=$highwater)::text || '|' ||
 (SELECT count(*) FROM platform.billing_offer_producer_state WHERE id='offer' AND phase='ACTIVE'::platform.\"OfferProducerPhase\")::text || '|' ||
 (SELECT count(*) FROM platform.outbox_events WHERE status <> 'PUBLISHED'::platform.\"OutboxStatus\")::text || '|' ||
 ((SELECT current_semantic_fingerprint FROM platform.service_identity WHERE id='singleton') = platform.current_semantic_fingerprint())::text;")" || return 1
		[[ "$platform_state" == '1|1|0|true' ]] || return 1
	fi
	core_catalog="$(docker exec "$core_container" pg_dump -U postgres -d default_db --schema-only --no-owner --no-acl)"
	core_catalog_sha="$(printf '%s\n' "$core_catalog" | platform_cleanup_rehearsal_sha256 /dev/stdin)"
	core_repeat="$work/core-repeat.dump"
	docker exec "$core_container" pg_dump -U postgres -d default_db --format custom --compress=9 --no-owner --no-acl --file /tmp/core-repeat.dump
	docker cp "$core_container:/tmp/core-repeat.dump" "$core_repeat"
	core_repeat_sha="$(platform_cleanup_rehearsal_sha256 "$core_repeat")"
	if [[ "$mode" == pre ]]; then
		platform_catalog="$(docker exec "$platform_container" pg_dump -U postgres -d winwidget_platform --schema-only --no-owner --no-acl)"
		platform_catalog_sha="$(printf '%s\n' "$platform_catalog" | platform_cleanup_rehearsal_sha256 /dev/stdin)"
		platform_repeat="$work/platform-repeat.dump"
		docker exec "$platform_container" pg_dump -U postgres -d winwidget_platform --format custom --compress=9 --no-owner --no-acl --file /tmp/platform-repeat.dump
		docker cp "$platform_container:/tmp/platform-repeat.dump" "$platform_repeat"
		platform_repeat_sha="$(platform_cleanup_rehearsal_sha256 "$platform_repeat")"
	fi
	core_dump_sha="$(platform_cleanup_rehearsal_sha256 "$core_dump")"
	if [[ "$mode" == pre ]]; then platform_dump_sha="$(platform_cleanup_rehearsal_sha256 "$platform_dump")"; fi
	cleanup_bundle
	trap - EXIT INT TERM
	[[ -z "$(docker ps -aq --filter "name=^/${core_container}$")" &&
		-z "$(docker ps -aq --filter "name=^/${platform_container}$")" &&
		-z "$(docker volume ls -q --filter "name=^${core_volume}$")" &&
		-z "$(docker volume ls -q --filter "name=^${platform_volume}$")" &&
		-z "$(docker network ls -q --filter "name=^${network}$")" && ! -e "$work" ]] || return 1
	if [[ "$mode" == pre ]]; then
		[[ -z "$(docker ps -aq --filter "name=^/${platform_container}$")" && -z "$(docker volume ls -q --filter "name=^${platform_volume}$")" ]] || return 1
	fi
	local partial="${evidence}.partial.$$"
	{
		printf 'version=1\naction=platform-core-cleanup-%s-restore\nstatus=verified\n' "$mode"
		printf 'ownership_revision=%s\ncleanup_revision=%s\nproduction_env_sha256=%s\ngeneration=%s\n' \
			"$ownership_revision" "$cleanup_revision" "$production_env" "$generation"
		printf 'compose_sha256=%s\n' "$compose_sha"
		printf 'postgres_major=18\ncore_dump_sha256=%s\ncore_catalog_sha256=%s\ncore_repeat_dump_sha256=%s\n' "$core_dump_sha" "$core_catalog_sha" "$core_repeat_sha"
		printf 'core_database_name=%s\ncore_database_system_identifier=%s\n' \
			"$source_core_database_name" "$source_core_database_system_identifier"
		printf 'core_restored_system_identifier=%s\ncore_source_state=%s\n' "$core_system" "$core_state"
		if [[ "$mode" == pre ]]; then
			printf 'platform_dump_sha256=%s\nplatform_catalog_sha256=%s\nplatform_repeat_dump_sha256=%s\n' "$platform_dump_sha" "$platform_catalog_sha" "$platform_repeat_sha"
			printf 'platform_restored_system_identifier=%s\nplatform_state=%s\n' "$platform_system" "$platform_state"
		fi
		printf 'isolated_targets=true\ninternal_network=true\nno_host_ports=true\nresources_removed_before_evidence=true\nclean_restore=true\n'
		printf 'observed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$partial"
	platform_cleanup_rehearsal_promote_evidence "$partial" "$evidence"
	printf 'platform_core_source_cleanup_%s_restore=passed\n' "$mode"
)

platform_cleanup_rehearsal_postgres18() (
	[[ $# -eq 2 ]] || return 1
	local migration="$1" expected_sha="$2" directory password_file container volume network password
	local migration_directory migration_file migration_name migration_sha migration_id
	local migration_count=0 ledger_state post_state attempt missing_guc_error missing_guc_state
	platform_cleanup_validate_migration "$migration" "$expected_sha"
	platform_cleanup_rehearsal_assert_local_docker
	[[ "$migration" == "$PLATFORM_CLEANUP_REHEARSAL_ROOT/prisma/migrations/20260825000000_remove_legacy_platform_core_source/migration.sql" ]] ||
		platform_cleanup_rehearsal_fail 'PostgreSQL 18 replay requires the canonical cleanup migration path.' || return 1
	directory="$(realpath -- "$(mktemp -d "${TMPDIR:-/tmp}/platform-core-cleanup-pg18.XXXXXX")")" || return 1
	container="platform-core-cleanup-pg18-$$"
	volume="platform-core-cleanup-pg18-data-$$"
	network="platform-core-cleanup-pg18-net-$$"
	password_file="$directory/postgres-password"
	password="$(od -An -N24 -tx1 /dev/urandom | tr -d '[:space:]')"
	printf '%s' "$password" >"$password_file"
	chmod 600 "$password_file"
	# shellcheck disable=SC2329
	cleanup() {
		docker rm -f "$container" >/dev/null 2>&1 || true
		docker volume rm "$volume" >/dev/null 2>&1 || true
		docker network rm "$network" >/dev/null 2>&1 || true
		rm -f -- "$password_file"
		rmdir -- "$directory" 2>/dev/null || true
	}
	trap cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	docker network create --internal "$network" >/dev/null
	[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|0' ]] || return 1
	docker volume create "$volume" >/dev/null
	docker run -d --name "$container" --network "$network" --network-alias postgres \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--mount "type=bind,source=$password_file,target=/run/secrets/postgres-password,readonly" \
		-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
		-e POSTGRES_DB=platform_cleanup_replay "$PLATFORM_CLEANUP_REHEARSAL_POSTGRES_IMAGE" >/dev/null
	[[ -z "$(docker port "$container")" &&
		"$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container")" == "$network" ]] || return 1
	[[ "$(docker network inspect --format '{{.Internal}}|{{len .Containers}}' "$network")" == 'true|1' ]] || return 1
	for ((attempt = 1; attempt <= 60; attempt++)); do
		if docker exec "$container" pg_isready -U postgres -d platform_cleanup_replay >/dev/null 2>&1; then break; fi
		[[ "$attempt" -lt 60 ]] || platform_cleanup_rehearsal_fail 'PostgreSQL 18 did not become ready.' || return 1
		sleep 1
	done
	[[ "$(docker exec "$container" psql --no-psqlrc -U postgres -d postgres -Atqc 'SHOW server_version_num;')" =~ ^18[0-9]{4}$ ]] ||
		platform_cleanup_rehearsal_fail 'full migration replay did not start PostgreSQL 18.' || return 1
	docker exec "$container" psql --no-psqlrc -U postgres -d postgres \
		--set ON_ERROR_STOP=1 --command "
ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.campaigns_contract_cutover\" TO 'production-destructive-approved';
ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.campaigns_forward_boundary\" TO 'forward-only';
ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.campaigns_source_manifest_sha256\" TO '0000000000000000000000000000000000000000000000000000000000000000';
ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.campaigns_telegram_audit_decision\" TO 'completed';
ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.campaigns_telegram_audit_reference\" TO 'platform-cleanup-rehearsal';
ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.platform_pristine_replay\" TO 'approved-nonproduction-replay';
" >/dev/null
	docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_replay \
		--set ON_ERROR_STOP=1 --command '
CREATE TABLE public._prisma_migrations (
  id VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
);' >/dev/null
	for migration_directory in "$PLATFORM_CLEANUP_REHEARSAL_ROOT"/prisma/migrations/*/; do
		migration_directory="${migration_directory%/}"
		[[ -d "$migration_directory" && ! -L "$migration_directory" ]] || return 1
		migration_name="$(basename -- "$migration_directory")"
		[[ "$migration_name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || return 1
		migration_file="$migration_directory/migration.sql"
		[[ -f "$migration_file" && ! -L "$migration_file" ]] || return 1
		migration_sha="$(platform_cleanup_rehearsal_sha256 "$migration_file")"
		[[ "$migration_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
		if [[ "$migration_name" == '20260825000000_remove_legacy_platform_core_source' ]]; then
			docker exec "$container" psql --no-psqlrc -U postgres -d postgres \
				--set ON_ERROR_STOP=1 --command \
				'ALTER ROLE postgres IN DATABASE platform_cleanup_replay RESET "winwidget.platform_pristine_replay";' >/dev/null
			docker cp "$migration_file" "$container:/tmp/platform-cleanup-missing-guc.sql"
			if missing_guc_error="$(docker exec "$container" psql --no-psqlrc -U postgres \
				-d platform_cleanup_replay --set ON_ERROR_STOP=1 \
				--file /tmp/platform-cleanup-missing-guc.sql 2>&1)"; then
				platform_cleanup_rehearsal_fail 'full migration replay accepted a missing Platform pristine GUC.'
				return 1
			fi
			[[ "$missing_guc_error" == *'Platform Core source cleanup requires a completed, evidenced production cutover or an exact pristine non-production database'* ]] ||
				platform_cleanup_rehearsal_fail 'missing-GUC replay did not fail at the Platform approval guard.' || return 1
			missing_guc_state="$(docker exec "$container" psql --no-psqlrc -U postgres \
				-d platform_cleanup_replay -Atqc "
SELECT
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('platform_core_state_transition_guard','platform_core_source_writes_enabled','platform_assert_core_write_enabled','billing_offer_projection_trigger'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='PlatformCoreOwnership')::text || '|' ||
 (SELECT count(*) FROM public.billing_source_aggregate_versions WHERE aggregate_type='billing.offer' AND aggregate_id='offer')::text || '|' ||
 (SELECT count(*) = 1 FROM public.platform_core_state WHERE id='singleton' AND ownership='CORE'::public.\"PlatformCoreOwnership\" AND source_writes_enabled AND legacy_routes_enabled AND generation=0)::text;")"
			[[ "$missing_guc_state" == '4|5|4|1|1|true' ]] ||
				platform_cleanup_rehearsal_fail "missing-GUC replay did not roll back exactly: $missing_guc_state" || return 1
			docker exec "$container" psql --no-psqlrc -U postgres -d postgres \
				--set ON_ERROR_STOP=1 --command \
				"ALTER ROLE postgres IN DATABASE platform_cleanup_replay SET \"winwidget.platform_pristine_replay\" TO 'approved-nonproduction-replay';" >/dev/null
		fi
		migration_count=$((migration_count + 1))
		printf -v migration_id '00000000-0000-4000-8000-%012d' "$migration_count"
		docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_replay \
			--set ON_ERROR_STOP=1 --command \
			"INSERT INTO public._prisma_migrations (id, checksum, migration_name) VALUES ('$migration_id', '$migration_sha', '$migration_name');" >/dev/null
		docker cp "$migration_file" "$container:/tmp/current-migration.sql"
		docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_replay \
			--set ON_ERROR_STOP=1 --file /tmp/current-migration.sql >/dev/null
		docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_replay \
			--set ON_ERROR_STOP=1 --command \
			"UPDATE public._prisma_migrations SET finished_at=now(), applied_steps_count=1 WHERE id='$migration_id' AND finished_at IS NULL AND rolled_back_at IS NULL;" >/dev/null
	done
	[[ "$migration_count" -gt 1 ]] || return 1
	ledger_state="$(docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_replay -Atqc "
SELECT count(*)::text || '|' ||
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1)::text || '|' ||
       count(*) FILTER (
         WHERE migration_name = '20260825000000_remove_legacy_platform_core_source'
           AND checksum = '$expected_sha'
           AND finished_at IS NOT NULL
           AND rolled_back_at IS NULL
           AND applied_steps_count = 1
       )::text
FROM public._prisma_migrations;")"
	[[ "$ledger_state" == "$migration_count|$migration_count|1" ]] ||
		platform_cleanup_rehearsal_fail "full migration replay ledger is incomplete: $ledger_state" || return 1
	post_state="$(docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_replay -Atqc "
SELECT
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('site_settings','legal_pages','home_page_content','platform_core_state'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('platform_core_state_transition_guard','platform_core_source_writes_enabled','platform_assert_core_write_enabled','billing_offer_projection_trigger'))::text || '|' ||
 (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='PlatformCoreOwnership')::text || '|' ||
 (SELECT count(*) FROM public.billing_source_aggregate_versions WHERE aggregate_type='billing.offer' AND aggregate_id='offer')::text || '|' ||
 (to_regclass('public.billing_core_state') IS NOT NULL
  AND to_regclass('public.billing_source_aggregate_versions') IS NOT NULL
  AND to_regclass('public.billing_read_projection_versions') IS NOT NULL
  AND to_regclass('public.billing_subscription_read_projections') IS NOT NULL
  AND to_regclass('public.billing_payment_read_projections') IS NOT NULL
  AND to_regclass('public.billing_affiliate_read_projections') IS NOT NULL
  AND to_regclass('public.billing_settings_read_projection') IS NOT NULL
  AND to_regclass('public.billing_settings_compositions') IS NOT NULL
  AND to_regclass('public.billing_source_sequence') IS NOT NULL
  AND to_regprocedure('public.billing_record_source_event(text,text,text,text,jsonb,boolean)') IS NOT NULL
  AND to_regprocedure('public.billing_iso_timestamp(timestamp without time zone)') IS NOT NULL)::text;")"
	[[ "$post_state" == '0|0|0|0|0|true' ]] ||
		platform_cleanup_rehearsal_fail "full migration replay inventory is unsafe: $post_state" || return 1
	docker exec "$container" createdb --no-password -U postgres platform_cleanup_empty_guard
	docker cp "$migration" "$container:/tmp/platform-cleanup-only.sql"
	if docker exec "$container" psql --no-psqlrc -U postgres -d platform_cleanup_empty_guard \
		--set ON_ERROR_STOP=1 --file /tmp/platform-cleanup-only.sql >/dev/null 2>&1; then
		platform_cleanup_rehearsal_fail 'cleanup migration unexpectedly succeeded without the prerequisite migration tree.'
		return 1
	fi
	cleanup
	trap - EXIT INT TERM
	[[ -z "$(docker ps -aq --filter "name=^/${container}$")" &&
		-z "$(docker volume ls -q --filter "name=^${volume}$")" &&
		-z "$(docker network ls -q --filter "name=^${network}$")" && ! -e "$directory" ]] || return 1
	printf 'platform_core_source_cleanup_postgres18_full_replay=passed\n'
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--self-test)
		[[ $# -eq 1 ]] || exit 64
		platform_cleanup_rehearsal_self_test
		;;
	--validate-migration)
		[[ $# -eq 3 ]] || exit 64
		platform_cleanup_validate_migration "$2" "$3"
		;;
	--validate-dump)
		[[ $# -eq 2 ]] || exit 64
		platform_cleanup_rehearsal_assert_local_docker
		platform_cleanup_rehearsal_validate_dump "$2"
		;;
	--rehearse-pre)
		[[ $# -eq 8 ]] || exit 64
		platform_cleanup_rehearsal_migrate_pre "$2" "$3" "$4" "$5" "$6" "$7" "$8"
		;;
	--postgres18)
		[[ $# -eq 3 ]] || exit 64
		platform_cleanup_rehearsal_postgres18 "$2" "$3"
		;;
	--restore-pre)
		[[ $# -eq 13 ]] || exit 64
		platform_cleanup_rehearsal_restore_bundle pre "$2" "$3" "$4" "$5" \
			"$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "${13}"
		;;
	--restore-post)
		[[ $# -eq 10 ]] || exit 64
		platform_cleanup_rehearsal_restore_bundle post "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"
		;;
	*) platform_cleanup_rehearsal_fail 'Usage: test-platform-core-source-cleanup-rehearsal.sh --self-test|--validate-migration <file> <sha256>|--validate-dump <file>|--rehearse-pre <core-dump> <migration-file> <migration-sha256> <sealing-marker> <prisma-manifest> <prisma-pre-ledger> <evidence>|--postgres18 <file> <sha256>|--restore-pre <core-dump> <platform-dump> <evidence> <cleanup-revision> <ownership-revision> <generation> <fingerprint> <high-watermark> <production-env-sha256> <core-database-name> <core-system-identifier> <compose-sha256>|--restore-post <core-dump> <evidence> <cleanup-revision> <ownership-revision> <generation> <production-env-sha256> <core-database-name> <core-system-identifier> <compose-sha256>' ;;
	esac
fi
