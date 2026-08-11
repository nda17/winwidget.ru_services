#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

readonly BILLING_RESTORE_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly BILLING_RESTORE_PURPOSE='actual-backup-restore-rehearsal'
readonly BILLING_RESTORE_MAX_DUMP_BYTES=$((49 * 1024 * 1024))
BILLING_RESTORE_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly BILLING_RESTORE_SCRIPT_ROOT

revision=''
phase=''
core_pre_dump=''
billing_pre_dump=''
billing_post_dump=''
pre_manifest_file=''
pre_evidence_file=''
evidence_file=''
work_root=''
evidence_stage=''
run_id=''
cleanup_complete='false'
synthetic_source_container=''
synthetic_restore_container=''
core_pre_path=''
core_pre_sha=''
core_pre_size=''
core_pre_toc_sha=''
billing_pre_path=''
billing_pre_sha=''
billing_pre_size=''
billing_pre_toc_sha=''
billing_post_path=''
billing_post_sha=''
billing_post_size=''
billing_post_toc_sha=''
core_pre_container=''
core_pre_system_id=''
core_pre_table_count=''
core_pre_table_sha=''
core_pre_row_sha=''
core_pre_migration_count=''
core_pre_migration_sha=''
billing_pre_container=''
billing_pre_system_id=''
billing_pre_table_count=''
billing_pre_table_sha=''
billing_pre_row_sha=''
billing_pre_migration_count=''
billing_pre_migration_sha=''
billing_post_container=''
billing_post_system_id=''
billing_post_table_count=''
billing_post_table_sha=''
billing_post_row_sha=''
billing_post_migration_count=''
billing_post_migration_sha=''
declare -a created_containers=()
declare -a created_volumes=()

billing_restore_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

billing_restore_usage() {
	cat <<'USAGE'
Usage:
  billing-backup-restore-rehearsal.sh \
    --revision <40-char-git-sha> --phase pre-cutover \
    --core-pre-dump <absolute-path> --billing-pre-dump <absolute-path> \
    --pre-manifest-file <absolute-path> --evidence-file <absolute-path>

  billing-backup-restore-rehearsal.sh \
    --revision <40-char-git-sha> --phase post-ownership \
    --billing-pre-dump <absolute-path> --billing-post-dump <absolute-path> \
    --pre-manifest-file <absolute-path> --pre-evidence-file <absolute-path> \
    --evidence-file <absolute-path>

  billing-backup-restore-rehearsal.sh \
    --revision <40-char-git-sha> --phase synthetic \
    --evidence-file <absolute-path>

  billing-backup-restore-rehearsal.sh --self-test

The runner only reads explicitly supplied dump/manifest/evidence files. It
never reads production env files or connects to a production database.
USAGE
}

billing_restore_sha256() {
	sha256sum "$1" | awk '{ print $1 }'
}

billing_restore_absolute_path() {
	[[ "$1" == /* && "$1" != *$'\n'* && "$1" != *'//'*
		&& "$1" != */./* && "$1" != */../* && "$1" != */. && "$1" != */.. ]]
}

billing_restore_validate_input_file() {
	local path="$1"
	billing_restore_absolute_path "$path" || return 1
	[[ -f "$path" && ! -L "$path" && -s "$path"
		&& "$(stat -c '%u:%g:%a' "$path")" == '0:0:600' ]]
}

billing_restore_validate_output_path() {
	local path="$1" directory mode
	billing_restore_absolute_path "$path" || return 1
	[[ "$(basename -- "$path")" =~ ^[A-Za-z0-9._-]+\.json$
		&& ! -e "$path" && ! -L "$path" ]] || return 1
	directory="$(dirname -- "$path")"
	[[ -d "$directory" && ! -L "$directory" ]] || return 1
	[[ "$(stat -c '%u:%g' "$directory")" == '0:0' ]] || return 1
	mode="$(stat -c '%a' "$directory")"
	[[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
	(( (8#$mode & 0022) == 0 ))
}

billing_restore_stream_synthetic_dump() {
	[[ $# -eq 2 ]] || return 1
	local container="$1" destination="$2" stage
	[[ -n "$container" && -n "$work_root" && "$destination" == "$work_root/"* \
		&& ! -e "$destination" && ! -L "$destination" ]] || return 1
	stage="$(mktemp "$work_root/.billing-synthetic-dump.XXXXXX")"
	if ! docker exec "$container" pg_dump --host 127.0.0.1 \
		--username winwidget_billing_backup \
		--dbname winwidget_billing --format custom --compress=9 --no-owner \
		--no-acl --schema billing >"$stage"; then
		rm -f -- "$stage"
		return 1
	fi
	if [[ ! -s "$stage" ]]; then
		rm -f -- "$stage"
		return 1
	fi
	chmod 600 "$stage"
	mv -n -- "$stage" "$destination"
	[[ ! -e "$stage" && ! -L "$stage" && -s "$destination" ]]
}

billing_restore_stream_synthetic_restore() {
	[[ $# -eq 2 ]] || return 1
	local container="$1" source="$2"
	[[ -n "$container" && -f "$source" && ! -L "$source" && -s "$source" ]] || return 1
	docker exec -i "$container" pg_restore --exit-on-error \
		--single-transaction --no-owner --no-acl --role winwidget_billing_migration \
		--username postgres --dbname winwidget_billing <"$source" >/dev/null
}

billing_restore_phase_contract() {
	case "$phase" in
	pre-cutover)
		[[ -n "$core_pre_dump" && -n "$billing_pre_dump"
			&& -z "$billing_post_dump" && -n "$pre_manifest_file"
			&& -z "$pre_evidence_file" && -n "$evidence_file" ]]
		;;
	post-ownership)
		[[ -z "$core_pre_dump" && -n "$billing_pre_dump"
			&& -n "$billing_post_dump" && -n "$pre_manifest_file"
			&& -n "$pre_evidence_file" && -n "$evidence_file" ]]
		;;
	synthetic)
		[[ -z "$core_pre_dump" && -z "$billing_pre_dump"
			&& -z "$billing_post_dump" && -z "$pre_manifest_file"
			&& -z "$pre_evidence_file" && -n "$evidence_file" ]]
		;;
	*) return 1 ;;
	esac
}

billing_restore_manifest_generation() {
	[[ $# -eq 9 ]] || return 1
	REVISION="$2" CORE_IMAGE_ID="$3" BILLING_IMAGE_ID="$4" \
		CORE_SHA="$5" CORE_SIZE="$6" BILLING_SHA="$7" BILLING_SIZE="$8" \
		node - "$1" "$9" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const requireCoreDump = process.argv[3] === 'true';
const integer = input => Number.isSafeInteger(input) && input > 0;
if (
  value.version !== 2 || value.revision !== process.env.REVISION ||
  !integer(value.generation) || value.coreImageId !== process.env.CORE_IMAGE_ID ||
  value.billingImageId !== process.env.BILLING_IMAGE_ID ||
  value.billingDumpSha256 !== process.env.BILLING_SHA ||
  String(value.billingDumpSizeBytes) !== process.env.BILLING_SIZE ||
  (requireCoreDump && (value.coreDumpSha256 !== process.env.CORE_SHA ||
    String(value.coreDumpSizeBytes) !== process.env.CORE_SIZE))
) process.exit(1);
process.stdout.write(String(value.generation));
NODE
}

billing_restore_validate_pre_evidence() {
	[[ $# -eq 6 ]] || return 1
	REVISION="$2" GENERATION="$3" BILLING_PRE_SHA="$4" \
		CORE_IMAGE_ID="$5" BILLING_IMAGE_ID="$6" node - "$1" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const checkKeys = [
  'sourceFilesSafe', 'dumpShaStable', 'manifestBinding', 'toc',
  'releaseImages', 'isolatedTargets', 'noHostPorts', 'distinctClusters',
  'migrations', 'anchors', 'acl', 'coreBillingParity', 'relationships',
  'continuity', 'resourcesRemoved',
].sort();
if (
  value.schemaVersion !== 1 ||
  value.action !== 'billing-actual-backup-restore-rehearsal' ||
  value.target !== 'billing' || value.status !== 'passed' ||
  value.postgresMajor !== 18 || value.phase !== 'pre-cutover' ||
  value.revision !== process.env.REVISION ||
  String(value.generation) !== process.env.GENERATION ||
  value.dumps?.billingPre?.sha256 !== process.env.BILLING_PRE_SHA ||
  value.images?.core?.imageId !== process.env.CORE_IMAGE_ID ||
  value.images?.billing?.imageId !== process.env.BILLING_IMAGE_ID ||
  !value.checks || Object.keys(value.checks).sort().join('|') !== checkKeys.join('|') ||
  checkKeys.some(key => value.checks[key] !== true)
) process.exit(1);
NODE
}

billing_restore_self_test() {
	local source_text saved_phase saved_core saved_pre saved_post
	local saved_manifest saved_evidence saved_pre_evidence
	local forbidden_env_file forbidden_docker_pull forbidden_docker_cp test_root generation_value
	saved_phase="$phase"
	saved_core="$core_pre_dump"
	saved_pre="$billing_pre_dump"
	saved_post="$billing_post_dump"
	saved_manifest="$pre_manifest_file"
	saved_pre_evidence="$pre_evidence_file"
	saved_evidence="$evidence_file"
	phase='pre-cutover'
	core_pre_dump='/tmp/core.dump'
	billing_pre_dump='/tmp/billing-pre.dump'
	billing_post_dump=''
	pre_manifest_file='/tmp/manifest.json'
	pre_evidence_file=''
	evidence_file='/tmp/pre.json'
	billing_restore_phase_contract || return 1
	phase='post-ownership'
	core_pre_dump=''
	billing_post_dump='/tmp/billing-post.dump'
	pre_evidence_file='/tmp/pre.json'
	evidence_file='/tmp/post.json'
	billing_restore_phase_contract || return 1
	core_pre_dump='/tmp/forbidden.dump'
	if billing_restore_phase_contract; then return 1; fi
	phase='synthetic'
	core_pre_dump=''
	billing_pre_dump=''
	billing_post_dump=''
	pre_manifest_file=''
	pre_evidence_file=''
	evidence_file='/tmp/synthetic.json'
	billing_restore_phase_contract || return 1
	phase="$saved_phase"
	core_pre_dump="$saved_core"
	billing_pre_dump="$saved_pre"
	billing_post_dump="$saved_post"
	pre_manifest_file="$saved_manifest"
	pre_evidence_file="$saved_pre_evidence"
	evidence_file="$saved_evidence"
	billing_restore_absolute_path '/tmp/evidence.json' || return 1
	if billing_restore_absolute_path '../evidence.json'; then return 1; fi
	command -v node >/dev/null 2>&1 || return 1
	test_root="$(mktemp -d "${TMPDIR:-/tmp}/billing-restore-self-test.XXXXXX")"
	node - "$test_root/manifest.json" "$test_root/pre.json" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  version: 2, revision: 'a'.repeat(40), generation: 1,
  coreImageId: `sha256:${'b'.repeat(64)}`,
  billingImageId: `sha256:${'c'.repeat(64)}`,
  coreDumpSha256: 'd'.repeat(64), coreDumpSizeBytes: 11,
  billingDumpSha256: 'e'.repeat(64), billingDumpSizeBytes: 12,
}));
fs.writeFileSync(process.argv[3], JSON.stringify({
  schemaVersion: 1, action: 'billing-actual-backup-restore-rehearsal',
  target: 'billing', status: 'passed', postgresMajor: 18,
  phase: 'pre-cutover', revision: 'a'.repeat(40), generation: 1,
  dumps: { billingPre: { sha256: 'e'.repeat(64) } },
  images: {
    core: { imageId: `sha256:${'b'.repeat(64)}` },
    billing: { imageId: `sha256:${'c'.repeat(64)}` },
  },
  checks: Object.fromEntries([
    'sourceFilesSafe','dumpShaStable','manifestBinding','toc','releaseImages',
    'isolatedTargets','noHostPorts','distinctClusters','migrations','anchors',
    'acl','coreBillingParity','relationships','continuity','resourcesRemoved',
  ].map(key => [key, true])),
}));
NODE
	generation_value="$(billing_restore_manifest_generation "$test_root/manifest.json" \
		"$(printf 'a%.0s' {1..40})" "sha256:$(printf 'b%.0s' {1..64})" \
		"sha256:$(printf 'c%.0s' {1..64})" "$(printf 'd%.0s' {1..64})" 11 \
		"$(printf 'e%.0s' {1..64})" 12 true)" || return 1
	[[ "$generation_value" == '1' ]] || return 1
	if billing_restore_manifest_generation "$test_root/manifest.json" \
		"$(printf 'a%.0s' {1..40})" "sha256:$(printf 'f%.0s' {1..64})" \
		"sha256:$(printf 'c%.0s' {1..64})" "$(printf 'd%.0s' {1..64})" 11 \
		"$(printf 'e%.0s' {1..64})" 12 true >/dev/null 2>&1; then return 1; fi
	billing_restore_validate_pre_evidence "$test_root/pre.json" \
		"$(printf 'a%.0s' {1..40})" 1 "$(printf 'e%.0s' {1..64})" \
		"sha256:$(printf 'b%.0s' {1..64})" "sha256:$(printf 'c%.0s' {1..64})" || return 1
	if billing_restore_validate_pre_evidence "$test_root/pre.json" \
		"$(printf 'a%.0s' {1..40})" 1 "$(printf 'f%.0s' {1..64})" \
		"sha256:$(printf 'b%.0s' {1..64})" "sha256:$(printf 'c%.0s' {1..64})" \
		>/dev/null 2>&1; then return 1; fi
	(
		work_root="$test_root"
		docker() {
			[[ "$1" == exec ]] || return 1
			if [[ "${2:-}" == '-i' ]]; then
				cat >"$test_root/restored.dump"
				return
			fi
			printf 'PGDMPsynthetic-stream-regression'
		}
		billing_restore_stream_synthetic_dump synthetic-source "$test_root/streamed.dump" || return 1
		billing_restore_stream_synthetic_restore synthetic-restore "$test_root/streamed.dump" || return 1
		cmp -s "$test_root/streamed.dump" "$test_root/restored.dump" || return 1
	)
	rm -f -- "$test_root/manifest.json" "$test_root/pre.json" \
		"$test_root/streamed.dump" "$test_root/restored.dump"
	rmdir -- "$test_root"
	source_text="$(<"${BASH_SOURCE[0]}")"
	forbidden_env_file='.env.''production'
	forbidden_docker_pull='docker ''pull'
	forbidden_docker_cp='docker ''cp'
	forbidden_port_bindings_json='{{json ''.HostConfig.PortBindings}}'
	[[ "$source_text" == *'--network none'* \
		&& "$source_text" == *'{{len .HostConfig.PortBindings}}'* \
		&& "$source_text" == *'{{.HostConfig.PublishAllPorts}}'* \
		&& "$source_text" == *'{{.Type}}|{{.Name}}|{{.RW}}'* \
		&& "$source_text" != *"$forbidden_port_bindings_json"* \
		&& "$source_text" == *'com.winwidget.rehearsal.run-id'* \
		&& "$source_text" == *'billing_restore_cleanup_resources'* \
		&& "$source_text" == *'--pre-manifest-file'* \
		&& "$source_text" == *'--pre-evidence-file'* \
		&& "$source_text" == *'winwidget-api:git-$revision'* \
		&& "$source_text" == *'winwidget-billing:git-$revision'* \
		&& "$source_text" == *'runner_tracked_blob'* \
		&& "$source_text" == *'runner_worktree_blob'* \
		&& "$source_text" == *'billing_restore_run_synthetic'* \
		&& "$source_text" == *'billing_restore_stream_synthetic_dump'* \
		&& "$source_text" == *'billing_restore_stream_synthetic_restore'* \
		&& "$source_text" == *'billing_restore_verify_migration_ledger'* \
		&& "$source_text" == *'billing_restore_verify_core_acl'* \
		&& "$source_text" == *'billing_restore_verify_billing_acl'* \
		&& "$source_text" == *'ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration'* \
		&& "$source_text" == *'CREATE FUNCTION billing.$probe_function()'* \
		&& "$source_text" == *'has_function_privilege'* \
		&& "$source_text" == *'billing_restore_verify_billing_invariants'* \
		&& "$source_text" == *'billing_restore_verify_core_billing_parity'* \
		&& "$source_text" == *'billing_restore_verify_pre_post_continuity'* \
		&& "$source_text" != *"$forbidden_docker_pull"* \
		&& "$source_text" != *"$forbidden_docker_cp"* \
		&& "$source_text" != *"$forbidden_env_file"* ]] || return 1
	printf 'billing_backup_restore_rehearsal_self_test=passed\n'
}

if [[ "${1:-}" == '--self-test' ]]; then
	[[ $# -eq 1 ]] || billing_restore_fail '--self-test accepts no other arguments.'
	billing_restore_self_test
	exit
fi

while (($# > 0)); do
	case "$1" in
	--revision) revision="${2:-}"; shift 2 ;;
	--phase) phase="${2:-}"; shift 2 ;;
	--core-pre-dump) core_pre_dump="${2:-}"; shift 2 ;;
	--billing-pre-dump) billing_pre_dump="${2:-}"; shift 2 ;;
	--billing-post-dump) billing_post_dump="${2:-}"; shift 2 ;;
	--pre-manifest-file) pre_manifest_file="${2:-}"; shift 2 ;;
	--pre-evidence-file) pre_evidence_file="${2:-}"; shift 2 ;;
	--evidence-file) evidence_file="${2:-}"; shift 2 ;;
	--help | -h) billing_restore_usage; exit ;;
	*) billing_restore_usage >&2; billing_restore_fail "Unknown argument: $1" ;;
	esac
done

[[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
	billing_restore_fail 'An exact lowercase 40-character Git revision is required.'
billing_restore_phase_contract || {
	billing_restore_usage >&2
	billing_restore_fail 'The phase-specific restore rehearsal arguments are incomplete or mixed.'
}

for command_name in docker node git sha256sum awk stat install mktemp grep rm \
	rmdir chmod chown dirname basename date uname id sleep head wc sort cmp comm \
	find tr mv; do
	command -v "$command_name" >/dev/null 2>&1 ||
		billing_restore_fail "Missing required command: $command_name"
done

[[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' ]] ||
	billing_restore_fail 'The actual-backup restore rehearsal requires root on Linux.'
[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] ||
	billing_restore_fail 'Ambient Docker endpoint overrides are forbidden.'
[[ "$(docker context show)" == 'default'
	&& "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock'
	&& "$(docker info --format '{{.OSType}}')" == 'linux' ]] ||
	billing_restore_fail 'A local Linux Docker daemon on the default Unix socket is required.'

unset DATABASE_URL DATABASE_MIGRATION_URL_PRODUCTION DATABASE_BACKUP_URL \
	BILLING_DATABASE_URL BILLING_MIGRATION_DATABASE_URL BILLING_BACKUP_URL \
	PGPASSWORD PGHOST PGPORT PGUSER PGDATABASE

[[ "$(git -C "$BILLING_RESTORE_SCRIPT_ROOT" rev-parse --verify HEAD)" == "$revision" ]] ||
	billing_restore_fail 'The restore runner checkout is not the exact candidate revision.'
runner_tracked_blob="$(git -C "$BILLING_RESTORE_SCRIPT_ROOT" rev-parse \
	"HEAD:scripts/$(basename -- "${BASH_SOURCE[0]}")")" ||
	billing_restore_fail 'The restore runner is not tracked by the candidate revision.'
runner_worktree_blob="$(git hash-object "${BASH_SOURCE[0]}")"
[[ "$runner_tracked_blob" =~ ^[0-9a-f]{40}$
	&& "$runner_worktree_blob" == "$runner_tracked_blob" ]] ||
	billing_restore_fail 'The executing restore runner differs from the exact tracked candidate blob.'

billing_image_ref="winwidget-billing:git-$revision"
billing_image_id="$(docker image inspect --format '{{.Id}}' "$billing_image_ref")" ||
	billing_restore_fail 'The exact Billing candidate image is unavailable.'
postgres_image_id="$(docker image inspect --format '{{.Id}}' "$BILLING_RESTORE_POSTGRES_IMAGE")" ||
	billing_restore_fail 'The digest-pinned PostgreSQL 18 image must already exist locally.'
billing_image_identity="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' "$billing_image_ref")"
[[ "$billing_image_id" =~ ^sha256:[0-9a-f]{64}$ && "$billing_image_identity" == "$revision|billing" ]] ||
	billing_restore_fail 'The Billing candidate image revision or runtime user is invalid.'
[[ "$postgres_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
	billing_restore_fail 'The PostgreSQL image ID is invalid.'

core_image_ref=''
core_image_id=''
if [[ "$phase" != 'synthetic' ]]; then
	core_image_ref="winwidget-api:git-$revision"
	core_image_id="$(docker image inspect --format '{{.Id}}' "$core_image_ref")" ||
		billing_restore_fail 'The exact Core candidate image is unavailable.'
	core_image_identity="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' "$core_image_ref")"
	[[ "$core_image_id" =~ ^sha256:[0-9a-f]{64}$ && "$core_image_identity" == "$revision|nestjs" ]] ||
		billing_restore_fail 'The Core candidate image revision or runtime user is invalid.'
fi

billing_restore_validate_output_path "$evidence_file" ||
	billing_restore_fail 'The evidence output path is unsafe or already exists.'
if [[ "$phase" != 'synthetic' ]]; then
	billing_restore_validate_input_file "$pre_manifest_file" ||
		billing_restore_fail 'The pre-cutover backup manifest must be a root-owned mode-600 regular file.'
	if [[ "$phase" == 'post-ownership' ]]; then
		billing_restore_validate_input_file "$pre_evidence_file" ||
			billing_restore_fail 'The PRE restore evidence is unsafe.'
	fi
	for dump_path in "$core_pre_dump" "$billing_pre_dump" "$billing_post_dump"; do
		[[ -z "$dump_path" ]] && continue
		billing_restore_validate_input_file "$dump_path" ||
			billing_restore_fail 'Every dump must be an explicit root-owned mode-600 regular file.'
	done
fi

started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

run_id="${revision:0:8}-${phase//[^a-z]/-}-$(date -u +%s)-$$"
work_root="$(mktemp -d "/var/tmp/winwidget-billing-restore.$run_id.XXXXXX")"
chown 0:0 "$work_root"
chmod 700 "$work_root"

billing_restore_resource_identity() {
	local kind="$1" name="$2"
	if [[ "$kind" == 'container' ]]; then
		docker inspect --format '{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{index .Config.Labels "com.winwidget.rehearsal.run-id"}}|{{index .Config.Labels "com.winwidget.revision"}}|{{index .Config.Labels "com.winwidget.phase"}}' "$name" 2>/dev/null
	else
		docker volume inspect --format '{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}|{{index .Labels "com.winwidget.rehearsal.run-id"}}|{{index .Labels "com.winwidget.revision"}}|{{index .Labels "com.winwidget.phase"}}' "$name" 2>/dev/null
	fi
}

billing_restore_cleanup_resources() {
	local status=0 name expected
	expected="billing|$BILLING_RESTORE_PURPOSE|$run_id|$revision|$phase"
	set +e
	for name in "${created_containers[@]}"; do
		if [[ "$(billing_restore_resource_identity container "$name")" == "$expected" ]]; then
			docker rm --force --volumes -- "$name" >/dev/null 2>&1 || status=1
		else
			printf 'Refusing to remove a restore container with mismatched labels: %s\n' "$name" >&2
			status=1
		fi
	done
	for name in "${created_volumes[@]}"; do
		if [[ "$(billing_restore_resource_identity volume "$name")" == "$expected" ]]; then
			docker volume rm -- "$name" >/dev/null 2>&1 || status=1
		else
			printf 'Refusing to remove a restore volume with mismatched labels: %s\n' "$name" >&2
			status=1
		fi
	done
	if docker ps -aq --filter "label=com.winwidget.rehearsal.run-id=$run_id" | grep -q .; then status=1; fi
	if docker volume ls -q --filter "label=com.winwidget.rehearsal.run-id=$run_id" | grep -q .; then status=1; fi
	set -e
	return "$status"
}

billing_restore_cleanup() {
	local exit_code=$? cleanup_status=0
	trap - EXIT INT TERM
	if [[ "$cleanup_complete" != 'true' ]]; then
		billing_restore_cleanup_resources || cleanup_status=1
	fi
	if [[ -n "$work_root" && "$work_root" == /var/tmp/winwidget-billing-restore.*
		&& -d "$work_root" && ! -L "$work_root" ]]; then
		rm -f -- "$work_root"/*
		rmdir -- "$work_root" 2>/dev/null || cleanup_status=1
	fi
	if [[ -n "$evidence_stage" && -f "$evidence_stage" && ! -L "$evidence_stage"
		&& "$(dirname -- "$evidence_stage")" == "$(dirname -- "$evidence_file")" ]]; then
		rm -f -- "$evidence_stage" || cleanup_status=1
	fi
	if [[ "$exit_code" == '0' && "$cleanup_status" != '0' ]]; then exit_code=1; fi
	exit "$exit_code"
}
trap billing_restore_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

billing_restore_wait_healthy() {
	local container="$1" attempt health
	for attempt in {1..60}; do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return 0
		[[ "$health" != 'unhealthy' ]] || break
		sleep 2
	done
	billing_restore_fail \
		"Restore PostgreSQL did not become healthy after $attempt attempts: $container"
}

billing_restore_query() {
	local container="$1" database="$2" query="$3"
	docker exec "$container" psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
		--tuples-only --no-align --host 127.0.0.1 --username postgres \
		--dbname "$database" --command "$query"
}

billing_restore_query_as() {
	local container="$1" database="$2" role="$3" query="$4"
	docker exec "$container" psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
		--tuples-only --no-align --host 127.0.0.1 --username "$role" \
		--dbname "$database" --command "$query"
}

billing_restore_synthetic_start_postgres() {
	local key="$1" container volume identity mount_name
	container="winwidget-billing-restore-${run_id}-${key}"
	volume="winwidget-billing-restore-data-${run_id}-${key}"
	! docker inspect "$container" >/dev/null 2>&1 ||
		billing_restore_fail "Synthetic container already exists: $container"
	! docker volume inspect "$volume" >/dev/null 2>&1 ||
		billing_restore_fail "Synthetic volume already exists: $volume"
	docker volume create \
		--label com.winwidget.owner=billing \
		--label "com.winwidget.purpose=$BILLING_RESTORE_PURPOSE" \
		--label "com.winwidget.rehearsal.run-id=$run_id" \
		--label "com.winwidget.revision=$revision" \
		--label "com.winwidget.phase=$phase" "$volume" >/dev/null
	created_volumes+=("$volume")
	docker run --detach --name "$container" --network none --read-only --init \
		--security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN \
		--cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
		--pids-limit 160 --memory 768m --cpus 1.0 --restart no \
		--tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--label com.winwidget.owner=billing \
		--label "com.winwidget.purpose=$BILLING_RESTORE_PURPOSE" \
		--label "com.winwidget.rehearsal.run-id=$run_id" \
		--label "com.winwidget.revision=$revision" \
		--label "com.winwidget.phase=$phase" \
		-e POSTGRES_DB=winwidget_billing -e POSTGRES_USER=postgres \
		-e POSTGRES_HOST_AUTH_METHOD=trust \
		-e 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd 'pg_isready --username postgres --dbname winwidget_billing' \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$BILLING_RESTORE_POSTGRES_IMAGE" >/dev/null
	created_containers+=("$container")
	billing_restore_wait_healthy "$container"
	identity="$(billing_restore_resource_identity container "$container")"
	[[ "$identity" == "billing|$BILLING_RESTORE_PURPOSE|$run_id|$revision|$phase"
		&& "$(docker inspect --format '{{.HostConfig.NetworkMode}}|{{.HostConfig.PublishAllPorts}}|{{len .HostConfig.PortBindings}}|{{.Image}}' "$container")" == "none|false|0|$postgres_image_id" ]] ||
		billing_restore_fail "Synthetic target isolation is invalid: $key"
	mount_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$container")"
	[[ "$mount_name" == "volume|$volume|true" ]] ||
		billing_restore_fail "Synthetic target volume is invalid: $key"
	printf -v "synthetic_${key}_container" '%s' "$container"
}

billing_restore_synthetic_provision_roles() {
	local container="$1"
	billing_restore_query "$container" winwidget_billing '
CREATE ROLE winwidget_billing_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_billing_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_billing_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CREATE ON DATABASE winwidget_billing TO winwidget_billing_migration;
REVOKE ALL ON DATABASE winwidget_billing FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_billing TO winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;
' >/dev/null
}

billing_restore_synthetic_finalize_acl() {
	local container="$1"
	billing_restore_query "$container" winwidget_billing '
ALTER SCHEMA billing OWNER TO winwidget_billing_migration;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA billing TO winwidget_billing_migration;
GRANT USAGE ON SCHEMA billing TO winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA billing FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA billing FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA billing FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing TO winwidget_billing_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO winwidget_billing_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_backup;
REVOKE ALL ON TABLE billing._prisma_migrations FROM winwidget_billing_runtime;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_billing FROM winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing REVOKE ALL ON TABLES FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT SELECT ON TABLES TO winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT SELECT ON SEQUENCES TO winwidget_billing_backup;
' >/dev/null
}

billing_restore_run_synthetic() {
	local migration_name migration_file migration_checksum image_migration_checksum
	local migration_url sentinel source_system_id restore_system_id database_id
	local dump_path dump_sha runner_sha observed_at acl_state
	migration_name='20260811000000_init_billing'
	migration_file="$BILLING_RESTORE_SCRIPT_ROOT/apps/billing/prisma/migrations/$migration_name/migration.sql"
	[[ -f "$migration_file" && ! -L "$migration_file" ]] ||
		billing_restore_fail 'The tracked Billing initial migration is unavailable.'
	migration_checksum="$(billing_restore_sha256 "$migration_file")"
	image_migration_checksum="$(docker run --rm --network none --read-only \
		--cap-drop ALL --security-opt no-new-privileges --entrypoint node \
		"$billing_image_id" -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
process.stdout.write(createHash("sha256").update(readFileSync("prisma/migrations/20260811000000_init_billing/migration.sql")).digest("hex"));
')"
	[[ "$migration_checksum" =~ ^[0-9a-f]{64}$
		&& "$image_migration_checksum" == "$migration_checksum" ]] ||
		billing_restore_fail 'The candidate image Billing migration differs from the tracked migration.'

	billing_restore_synthetic_start_postgres source
	billing_restore_synthetic_start_postgres restore
	billing_restore_synthetic_provision_roles "$synthetic_source_container"
	billing_restore_synthetic_provision_roles "$synthetic_restore_container"
	billing_restore_query "$synthetic_source_container" winwidget_billing '
CREATE SCHEMA billing AUTHORIZATION winwidget_billing_migration;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA billing TO winwidget_billing_migration;
' >/dev/null
	migration_url='postgresql://winwidget_billing_migration@127.0.0.1:5432/winwidget_billing?schema=billing&sslmode=disable'
	docker run --rm --network "container:$synthetic_source_container" \
		--read-only --cap-drop ALL --security-opt no-new-privileges \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
		-e "BILLING_DATABASE_URL=$migration_url" -e "APP_REVISION=$revision" \
		--entrypoint ./node_modules/.bin/prisma "$billing_image_id" \
		migrate deploy --schema prisma/schema.prisma >/dev/null
	unset migration_url
	billing_restore_synthetic_finalize_acl "$synthetic_source_container"
	sentinel="synthetic-$run_id"
	billing_restore_query "$synthetic_source_container" winwidget_billing \
		"INSERT INTO billing.source_sequences (id, next_value, updated_at) VALUES ('$sentinel', 42, CURRENT_TIMESTAMP);" >/dev/null
	source_system_id="$(billing_restore_query "$synthetic_source_container" winwidget_billing 'SELECT system_identifier FROM pg_control_system();')"
	database_id="$(billing_restore_query "$synthetic_source_container" winwidget_billing "SELECT database_id::text FROM billing.service_identity WHERE id = 'singleton' AND service_name = 'billing-service' AND phase = 'SHADOW' AND ownership_generation = 0;")"
	[[ "$source_system_id" =~ ^[1-9][0-9]*$ && "$database_id" =~ ^[0-9a-f-]{36}$ ]] ||
		billing_restore_fail 'Synthetic source anchors are invalid.'

	dump_path="$work_root/billing-synthetic.dump"
	billing_restore_stream_synthetic_dump "$synthetic_source_container" "$dump_path" ||
		billing_restore_fail 'Synthetic Billing dump stream failed.'
	chown 0:0 "$dump_path"
	chmod 600 "$dump_path"
	dump_sha="$(billing_restore_sha256 "$dump_path")"
	[[ -s "$dump_path" && "$dump_sha" =~ ^[0-9a-f]{64}$ ]] ||
		billing_restore_fail 'Synthetic Billing dump is invalid.'
	docker run --rm --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges \
		--mount "type=bind,source=$dump_path,target=/input.dump,readonly" \
		--entrypoint pg_restore "$postgres_image_id" --list /input.dump >/dev/null
	billing_restore_stream_synthetic_restore "$synthetic_restore_container" "$dump_path" ||
		billing_restore_fail 'Synthetic Billing restore stream failed.'
	billing_restore_synthetic_finalize_acl "$synthetic_restore_container"
	restore_system_id="$(billing_restore_query "$synthetic_restore_container" winwidget_billing 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$restore_system_id" =~ ^[1-9][0-9]*$ && "$restore_system_id" != "$source_system_id" ]] ||
		billing_restore_fail 'Synthetic restore did not use a distinct PostgreSQL cluster.'
	[[ "$(billing_restore_query "$synthetic_restore_container" winwidget_billing "SELECT count(*) FROM billing.service_identity WHERE id = 'singleton' AND database_id = '$database_id'::uuid;")" == '1'
		&& "$(billing_restore_query "$synthetic_restore_container" winwidget_billing "SELECT count(*) FROM billing.source_sequences WHERE id = '$sentinel' AND next_value = 42;")" == '1'
		&& "$(billing_restore_query "$synthetic_restore_container" winwidget_billing "SELECT count(*) FROM billing._prisma_migrations WHERE migration_name = '$migration_name' AND checksum = '$migration_checksum' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")" == '1' ]] ||
		billing_restore_fail 'Synthetic restore lost migration or durable data anchors.'
	acl_state="$(billing_restore_query "$synthetic_restore_container" winwidget_billing "SELECT NOT has_schema_privilege('winwidget_billing_runtime','billing','CREATE'), NOT has_table_privilege('winwidget_billing_runtime','billing._prisma_migrations','SELECT'), has_table_privilege('winwidget_billing_backup','billing._prisma_migrations','SELECT'), NOT has_table_privilege('winwidget_billing_backup','billing.source_sequences','INSERT');")"
	[[ "$acl_state" == 't|t|t|t' ]] ||
		billing_restore_fail 'Synthetic restored Billing ACL contract is invalid.'

	billing_restore_cleanup_resources ||
		billing_restore_fail 'Synthetic exact-labelled resources were not removed cleanly.'
	created_containers=()
	created_volumes=()
	cleanup_complete='true'
	runner_sha="$(billing_restore_sha256 "${BASH_SOURCE[0]}")"
	observed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	evidence_stage="$(mktemp "$(dirname -- "$evidence_file")/.billing-synthetic-restore-evidence.XXXXXX")"
	RUNNER_REVISION="$revision" RUNNER_SHA="$runner_sha" DUMP_SHA="$dump_sha" \
		POSTGRES_IMAGE_ID="$postgres_image_id" BILLING_IMAGE_ID="$billing_image_id" \
		MIGRATION_CHECKSUM="$migration_checksum" SOURCE_SYSTEM_ID="$source_system_id" \
		RESTORE_SYSTEM_ID="$restore_system_id" DATABASE_ID="$database_id" \
		OBSERVED_AT="$observed_at" node - "$evidence_stage" "$BILLING_RESTORE_POSTGRES_IMAGE" \
		"$billing_image_ref" "$migration_name" <<'NODE'
const fs = require('node:fs');
const [destination, postgresImage, billingImage, migrationName] = process.argv.slice(2);
const value = {
  schemaVersion: 1,
  action: 'billing-independent-restore-drill',
  target: 'billing',
  status: 'passed',
  postgresMajor: 18,
  revision: process.env.RUNNER_REVISION,
  dumpSha256: process.env.DUMP_SHA,
  postgresImage,
  postgresImageId: process.env.POSTGRES_IMAGE_ID,
  billingImage,
  billingImageId: process.env.BILLING_IMAGE_ID,
  migrationName,
  migrationChecksum: process.env.MIGRATION_CHECKSUM,
  sourceSystemIdentifier: process.env.SOURCE_SYSTEM_ID,
  restoreSystemIdentifier: process.env.RESTORE_SYSTEM_ID,
  databaseId: process.env.DATABASE_ID,
  networkInternal: true,
  hostPortsPublished: false,
  runnerRevision: process.env.RUNNER_REVISION,
  runnerSha256: process.env.RUNNER_SHA,
  observedAt: process.env.OBSERVED_AT,
};
fs.writeFileSync(destination, `${JSON.stringify(value)}\n`, { mode: 0o600 });
NODE
	chown 0:0 "$evidence_stage"
	chmod 600 "$evidence_stage"
	mv -n -- "$evidence_stage" "$evidence_file"
	[[ ! -e "$evidence_stage" && ! -L "$evidence_stage" ]] ||
		billing_restore_fail 'Synthetic evidence destination appeared concurrently.'
	evidence_stage=''
	[[ -f "$evidence_file" && ! -L "$evidence_file"
		&& "$(stat -c '%u:%g:%a' "$evidence_file")" == '0:0:600' ]] ||
		billing_restore_fail 'Final synthetic restore evidence is unsafe.'
	printf 'billing_backup_restore_rehearsal_phase=synthetic\n'
	printf 'billing_backup_restore_rehearsal=passed\n'
	printf 'billing_restore_evidence=%s\n' "$evidence_file"
	printf 'billing_restore_evidence_sha256=%s\n' "$(billing_restore_sha256 "$evidence_file")"
}

if [[ "$phase" == 'synthetic' ]]; then
	billing_restore_run_synthetic
	exit
fi

billing_restore_stage_dump() {
	local key="$1" source="$2" schema="$3" destination size before after staged toc
	destination="$work_root/$key.dump"
	before="$(billing_restore_sha256 "$source")"
	install -o root -g root -m 600 "$source" "$destination"
	after="$(billing_restore_sha256 "$source")"
	staged="$(billing_restore_sha256 "$destination")"
	[[ "$before" == "$after" && "$before" == "$staged" && "$before" =~ ^[0-9a-f]{64}$ ]] ||
		billing_restore_fail "Dump changed while being staged: $key"
	[[ "$(head -c 5 "$destination")" == 'PGDMP' ]] ||
		billing_restore_fail "Dump is not PostgreSQL custom format: $key"
	size="$(wc -c <"$destination" | tr -d '[:space:]')"
	[[ "$size" =~ ^[1-9][0-9]*$ && "$size" -le "$BILLING_RESTORE_MAX_DUMP_BYTES" ]] ||
		billing_restore_fail "Dump size is outside the bounded contract: $key"
	toc="$work_root/$key.toc"
	docker run --rm --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges \
		--mount "type=bind,source=$destination,target=/input.dump,readonly" \
		--entrypoint pg_restore "$postgres_image_id" --list /input.dump >"$toc"
	[[ -s "$toc" && "$(awk '$4 == "SCHEMA" && $5 == "-" { print $6 }' "$toc")" == "$schema" ]] ||
		billing_restore_fail "Dump TOC does not contain exactly schema $schema: $key"
	printf -v "${key//-/_}_path" '%s' "$destination"
	printf -v "${key//-/_}_sha" '%s' "$staged"
	printf -v "${key//-/_}_size" '%s' "$size"
	printf -v "${key//-/_}_toc_sha" '%s' "$(billing_restore_sha256 "$toc")"
}

if [[ "$phase" == 'pre-cutover' ]]; then
	billing_restore_stage_dump core_pre "$core_pre_dump" public
	billing_restore_stage_dump billing_pre "$billing_pre_dump" billing
else
	billing_restore_stage_dump billing_pre "$billing_pre_dump" billing
	billing_restore_stage_dump billing_post "$billing_post_dump" billing
fi

manifest_values="$(billing_restore_manifest_generation "$pre_manifest_file" \
	"$revision" "$core_image_id" "$billing_image_id" "${core_pre_sha:-}" \
	"${core_pre_size:-0}" "$billing_pre_sha" "$billing_pre_size" \
	"$([[ "$phase" == 'pre-cutover' ]] && printf true || printf false)")" ||
	billing_restore_fail 'The version-2 pre-cutover manifest does not bind the exact dumps and images.'
[[ "$manifest_values" =~ ^[1-9][0-9]*$ ]] || billing_restore_fail 'Backup manifest generation is invalid.'
generation="$manifest_values"

billing_restore_start_target() {
	local key="$1" dump_path="$2" schema="$3" container volume identity mount_name
	container="winwidget-billing-restore-${run_id}-${key//_/-}"
	volume="winwidget-billing-restore-data-${run_id}-${key//_/-}"
	! docker inspect "$container" >/dev/null 2>&1 || billing_restore_fail "Restore container already exists: $container"
	! docker volume inspect "$volume" >/dev/null 2>&1 || billing_restore_fail "Restore volume already exists: $volume"
	docker volume create \
		--label com.winwidget.owner=billing \
		--label "com.winwidget.purpose=$BILLING_RESTORE_PURPOSE" \
		--label "com.winwidget.rehearsal.run-id=$run_id" \
		--label "com.winwidget.revision=$revision" \
		--label "com.winwidget.phase=$phase" "$volume" >/dev/null
	created_volumes+=("$volume")
	docker run --detach --name "$container" --network none --read-only --init \
		--security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN \
		--cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
		--pids-limit 160 --memory 768m --cpus 1.0 --restart no \
		--tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--mount "type=bind,source=$dump_path,target=/restore/input.dump,readonly" \
		--label com.winwidget.owner=billing \
		--label "com.winwidget.purpose=$BILLING_RESTORE_PURPOSE" \
		--label "com.winwidget.rehearsal.run-id=$run_id" \
		--label "com.winwidget.revision=$revision" \
		--label "com.winwidget.phase=$phase" \
		-e POSTGRES_DB=postgres -e POSTGRES_USER=postgres \
		-e POSTGRES_HOST_AUTH_METHOD=trust \
		-e 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd 'pg_isready --username postgres --dbname postgres' \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$BILLING_RESTORE_POSTGRES_IMAGE" >/dev/null
	created_containers+=("$container")
	billing_restore_wait_healthy "$container"
	identity="$(billing_restore_resource_identity container "$container")"
	[[ "$identity" == "billing|$BILLING_RESTORE_PURPOSE|$run_id|$revision|$phase"
		&& "$(docker inspect --format '{{.HostConfig.NetworkMode}}|{{.HostConfig.PublishAllPorts}}|{{len .HostConfig.PortBindings}}|{{.Image}}' "$container")" == "none|false|0|$postgres_image_id" ]] ||
		billing_restore_fail "Restore target isolation is invalid: $key"
	mount_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$container")"
	[[ "$mount_name" == "volume|$volume|true" ]] || billing_restore_fail "Restore target volume is invalid: $key"
	billing_restore_query "$container" postgres 'CREATE DATABASE restore_db WITH TEMPLATE template0;' >/dev/null
	if [[ "$schema" == 'public' ]]; then
		billing_restore_query "$container" restore_db 'DROP SCHEMA public CASCADE;' >/dev/null
		docker exec "$container" pg_restore --exit-on-error --single-transaction \
			--no-owner --no-acl --username postgres --dbname restore_db /restore/input.dump >/dev/null
		billing_restore_query "$container" restore_db 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;' >/dev/null
	else
		billing_restore_query "$container" postgres "CREATE ROLE winwidget_billing_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; CREATE ROLE winwidget_billing_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; CREATE ROLE winwidget_billing_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT CREATE ON DATABASE restore_db TO winwidget_billing_migration;" >/dev/null
		docker exec "$container" pg_restore --exit-on-error --single-transaction \
			--no-owner --no-acl --role winwidget_billing_migration \
			--username postgres --dbname restore_db /restore/input.dump >/dev/null
		billing_restore_query "$container" restore_db '
REVOKE ALL ON DATABASE restore_db FROM PUBLIC;
GRANT CONNECT ON DATABASE restore_db TO winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE CREATE, TEMPORARY ON DATABASE restore_db FROM winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA billing TO winwidget_billing_migration;
GRANT USAGE ON SCHEMA billing TO winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA billing FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA billing FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA billing FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing TO winwidget_billing_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO winwidget_billing_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_backup;
REVOKE ALL ON TABLE billing._prisma_migrations FROM winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing REVOKE ALL ON TABLES FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT SELECT ON TABLES TO winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing GRANT SELECT ON SEQUENCES TO winwidget_billing_backup;
' >/dev/null
	fi
	printf -v "${key}_container" '%s' "$container"
}

if [[ "$phase" == 'pre-cutover' ]]; then
	billing_restore_start_target core_pre "$core_pre_path" public
	billing_restore_start_target billing_pre "$billing_pre_path" billing
else
	billing_restore_start_target billing_pre "$billing_pre_path" billing
	billing_restore_start_target billing_post "$billing_post_path" billing
fi

billing_restore_collect_metrics() {
	local key="$1" schema="$2" container table_count table_manifest row_manifest migration_count migration_manifest system_identifier
	eval "container=\${${key}_container}"
	system_identifier="$(billing_restore_query "$container" restore_db 'SELECT system_identifier FROM pg_control_system();')"
	table_count="$(billing_restore_query "$container" restore_db "SELECT count(*) FROM information_schema.tables WHERE table_schema = '$schema' AND table_type = 'BASE TABLE';")"
	table_manifest="$(billing_restore_query "$container" restore_db "COPY (SELECT table_name FROM information_schema.tables WHERE table_schema = '$schema' AND table_type = 'BASE TABLE' ORDER BY table_name COLLATE \"C\") TO STDOUT;" | sha256sum | awk '{print $1}')"
	row_manifest="$(billing_restore_query "$container" restore_db "COPY (SELECT table_name || '|' || (xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = '$schema' AND table_type = 'BASE TABLE' ORDER BY table_name COLLATE \"C\") TO STDOUT;" | sha256sum | awk '{print $1}')"
	migration_count="$(billing_restore_query "$container" restore_db "SELECT count(*) FROM $schema.\"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
	migration_manifest="$(billing_restore_query "$container" restore_db "COPY (SELECT migration_name || '|' || checksum FROM $schema.\"_prisma_migrations\" ORDER BY migration_name COLLATE \"C\") TO STDOUT;" | sha256sum | awk '{print $1}')"
	[[ "$system_identifier" =~ ^[1-9][0-9]*$ && "$table_count" =~ ^[1-9][0-9]*$ \
		&& "$migration_count" =~ ^[1-9][0-9]*$ && "$table_manifest" =~ ^[0-9a-f]{64}$ \
		&& "$row_manifest" =~ ^[0-9a-f]{64}$ && "$migration_manifest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf -v "${key}_system_id" '%s' "$system_identifier"
	printf -v "${key}_table_count" '%s' "$table_count"
	printf -v "${key}_table_sha" '%s' "$table_manifest"
	printf -v "${key}_row_sha" '%s' "$row_manifest"
	printf -v "${key}_migration_count" '%s' "$migration_count"
	printf -v "${key}_migration_sha" '%s' "$migration_manifest"
}

billing_restore_verify_migration_ledger() {
	local key="$1" schema="$2" migration_root="$3" image_id="$4"
	local container expected actual image invalid directory name checksum
	eval "container=\${${key}_container}"
	expected="$work_root/$key.migrations.expected"
	actual="$work_root/$key.migrations.actual"
	image="$work_root/$key.migrations.image"
	: >"$expected"
	while IFS= read -r directory; do
		name="$(basename -- "$directory")"
		[[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ && -f "$directory/migration.sql"
			&& ! -L "$directory/migration.sql" ]] ||
			billing_restore_fail "Tracked migration is unsafe: $directory"
		checksum="$(billing_restore_sha256 "$directory/migration.sql")"
		[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
		printf '%s|%s\n' "$name" "$checksum" >>"$expected"
	done < <(find "$migration_root" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)
	[[ -s "$expected" ]] || billing_restore_fail "No tracked migrations exist for $key."
	billing_restore_query "$container" restore_db \
		"COPY (SELECT migration_name || '|' || checksum FROM $schema.\"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name COLLATE \"C\") TO STDOUT;" >"$actual"
	invalid="$(billing_restore_query "$container" restore_db \
		"SELECT count(*) FROM $schema.\"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR applied_steps_count < 1;")"
	[[ "$invalid" == '0' ]] ||
		billing_restore_fail "Restored migration ledger contains a failed row: $key"
	cmp -s "$expected" "$actual" ||
		billing_restore_fail "Restored migration ledger differs from tracked migrations: $key"
	docker run --rm --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges --entrypoint sh "$image_id" -euc '
root="$1"
find "$root" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort |
while IFS= read -r directory; do
  name="$(basename "$directory")"
  checksum="$(sha256sum "$directory/migration.sql" | awk "{ print \\$1 }")"
  printf "%s|%s\\n" "$name" "$checksum"
done
' sh prisma/migrations >"$image"
	cmp -s "$expected" "$image" ||
		billing_restore_fail "Candidate image migration set differs from the tracked checkout: $key"
}

billing_restore_verify_core_acl() {
	local container="$1" state
	state="$(billing_restore_query "$container" restore_db "SELECT NOT has_schema_privilege('public','public','CREATE'), (SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'postgres') FROM pg_namespace WHERE nspname = 'public');")"
	[[ "$state" == 't|t' ]] ||
		billing_restore_fail 'Restored Core public-schema ACL/owner contract is invalid.'
}

billing_restore_verify_billing_acl() {
	local container="$1" state owner_drift probe_id probe_suffix
	local probe_table probe_sequence probe_function default_state
	state="$(billing_restore_query "$container" restore_db "
SELECT
  (SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'winwidget_billing_migration') FROM pg_namespace WHERE nspname = 'billing'),
  NOT has_schema_privilege('PUBLIC','billing','USAGE'),
  NOT has_schema_privilege('winwidget_billing_runtime','billing','CREATE'),
  NOT has_database_privilege('winwidget_billing_runtime',current_database(),'CREATE'),
  has_table_privilege('winwidget_billing_runtime','billing.source_sequences','SELECT,INSERT,UPDATE,DELETE'),
  NOT has_table_privilege('winwidget_billing_runtime','billing._prisma_migrations','SELECT'),
  has_table_privilege('winwidget_billing_backup','billing._prisma_migrations','SELECT'),
  has_table_privilege('winwidget_billing_backup','billing.service_identity','SELECT'),
  NOT has_table_privilege('winwidget_billing_backup','billing.source_sequences','INSERT,UPDATE,DELETE'),
  NOT has_schema_privilege('winwidget_billing_backup','billing','CREATE');")"
	[[ "$state" == 't|t|t|t|t|t|t|t|t|t' ]] ||
		billing_restore_fail 'Restored Billing role privilege contract is invalid.'
	owner_drift="$(billing_restore_query "$container" restore_db "
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'billing' AND c.relkind IN ('r','p','v','m','S','f')
     AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'winwidget_billing_migration')) +
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'billing'
     AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = 'winwidget_billing_migration')) +
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'billing' AND t.typrelid = 0
     AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = 'winwidget_billing_migration'));")"
	[[ "$owner_drift" == '0' ]] ||
		billing_restore_fail 'Restored Billing object ownership differs from the migration role.'
	probe_id="acl-probe-$run_id"
	billing_restore_query_as "$container" restore_db winwidget_billing_runtime \
		"BEGIN; INSERT INTO billing.source_sequences (id,next_value,updated_at) VALUES ('$probe_id',1,CURRENT_TIMESTAMP); UPDATE billing.source_sequences SET next_value=2 WHERE id='$probe_id'; DELETE FROM billing.source_sequences WHERE id='$probe_id'; ROLLBACK;" >/dev/null
	if billing_restore_query_as "$container" restore_db winwidget_billing_runtime \
		'SELECT count(*) FROM billing._prisma_migrations;' >/dev/null 2>&1; then
		billing_restore_fail 'Restored Billing runtime role can read the migration ledger.'
	fi
	if billing_restore_query_as "$container" restore_db winwidget_billing_backup \
		"INSERT INTO billing.source_sequences (id,next_value,updated_at) VALUES ('backup-write-$run_id',1,CURRENT_TIMESTAMP);" >/dev/null 2>&1; then
		billing_restore_fail 'Restored Billing backup role can mutate data.'
	fi
	billing_restore_query_as "$container" restore_db winwidget_billing_backup \
		'SELECT count(*) FROM billing._prisma_migrations; SELECT count(*) FROM billing.service_identity;' >/dev/null
	probe_suffix="${revision:0:8}_$$"
	[[ "$probe_suffix" =~ ^[0-9a-f]{8}_[0-9]+$ ]] || return 1
	probe_table="__restore_acl_table_$probe_suffix"
	probe_sequence="__restore_acl_sequence_$probe_suffix"
	probe_function="__restore_acl_function_$probe_suffix"
	default_state="$(billing_restore_query "$container" restore_db "
BEGIN;
SET LOCAL ROLE winwidget_billing_migration;
CREATE TABLE billing.$probe_table (id bigint PRIMARY KEY);
CREATE SEQUENCE billing.$probe_sequence;
CREATE FUNCTION billing.$probe_function() RETURNS integer
  LANGUAGE sql IMMUTABLE AS 'SELECT 1';
RESET ROLE;
SELECT
  has_table_privilege('winwidget_billing_runtime','billing.$probe_table','SELECT'),
  has_table_privilege('winwidget_billing_runtime','billing.$probe_table','INSERT'),
  has_table_privilege('winwidget_billing_runtime','billing.$probe_table','UPDATE'),
  has_table_privilege('winwidget_billing_runtime','billing.$probe_table','DELETE'),
  has_table_privilege('winwidget_billing_backup','billing.$probe_table','SELECT'),
  NOT has_table_privilege('winwidget_billing_backup','billing.$probe_table','INSERT'),
  NOT has_table_privilege('winwidget_billing_backup','billing.$probe_table','UPDATE'),
  NOT has_table_privilege('winwidget_billing_backup','billing.$probe_table','DELETE'),
  has_sequence_privilege('winwidget_billing_runtime','billing.$probe_sequence','USAGE'),
  has_sequence_privilege('winwidget_billing_runtime','billing.$probe_sequence','SELECT'),
  has_sequence_privilege('winwidget_billing_runtime','billing.$probe_sequence','UPDATE'),
  has_sequence_privilege('winwidget_billing_backup','billing.$probe_sequence','SELECT'),
  NOT has_sequence_privilege('winwidget_billing_backup','billing.$probe_sequence','USAGE'),
  NOT has_sequence_privilege('winwidget_billing_backup','billing.$probe_sequence','UPDATE'),
  NOT has_function_privilege('winwidget_billing_runtime','billing.$probe_function()','EXECUTE'),
  NOT has_function_privilege('winwidget_billing_backup','billing.$probe_function()','EXECUTE');
ROLLBACK;")"
	[[ "$default_state" == 't|t|t|t|t|t|t|t|t|t|t|t|t|t|t|t' ]] ||
		billing_restore_fail 'Restored Billing default-privilege contract is invalid.'
}

billing_restore_verify_billing_invariants() {
	local container="$1" relationship_violations continuity_violations actual expected
	relationship_violations="$(billing_restore_query "$container" restore_db "
SELECT
  (SELECT count(*) FROM billing.payments p LEFT JOIN billing.identity_contact_projections i ON i.user_id=p.user_id WHERE i.user_id IS NULL) +
  (SELECT count(*) FROM billing.payment_receipts r LEFT JOIN billing.payments p ON p.id=r.payment_id WHERE p.id IS NULL) +
  (SELECT count(*) FROM billing.subscriptions s LEFT JOIN billing.identity_contact_projections i ON i.user_id=s.user_id WHERE i.user_id IS NULL) +
  (SELECT count(*) FROM billing.subscription_history h LEFT JOIN billing.subscriptions s ON s.id=h.subscription_id WHERE h.subscription_id IS NOT NULL AND s.id IS NULL) +
  (SELECT count(*) FROM billing.subscription_expiry_reminders r LEFT JOIN billing.subscriptions s ON s.id=r.subscription_id WHERE s.id IS NULL) +
  (SELECT count(*) FROM billing.auto_renewals a LEFT JOIN billing.identity_contact_projections i ON i.user_id=a.user_id WHERE i.user_id IS NULL) +
  (SELECT count(*) FROM billing.auto_renewal_consent_events c LEFT JOIN billing.auto_renewals a ON a.id=c.auto_renewal_id WHERE a.id IS NULL) +
  (SELECT count(*) FROM billing.affiliate_referrals a LEFT JOIN billing.identity_contact_projections r ON r.user_id=a.referrer_id LEFT JOIN billing.identity_contact_projections u ON u.user_id=a.referred_user_id WHERE r.user_id IS NULL OR u.user_id IS NULL) +
  (SELECT count(*) FROM billing.affiliate_referrals a LEFT JOIN billing.payments p ON p.id=a.first_payment_id WHERE a.first_payment_id IS NOT NULL AND p.id IS NULL) +
  (SELECT count(*) FROM billing.integration_delivery_failures f LEFT JOIN billing.integration_delivery_receipts r ON r.event_id=f.event_id AND r.integration=f.integration WHERE f.integration='auto-renewal-charge' AND r.id IS NULL);")"
	[[ "$relationship_violations" == '0' ]] ||
		billing_restore_fail 'Restored Billing relationships contain violations.'
	continuity_violations="$(billing_restore_query "$container" restore_db "
WITH high_water AS (
  SELECT GREATEST(
    COALESCE((SELECT max(source_sequence) FROM billing.payments),0),
    COALESCE((SELECT max(source_sequence) FROM billing.subscriptions),0),
    COALESCE((SELECT max(source_sequence) FROM billing.identity_contact_projections),0),
    COALESCE((SELECT max(source_sequence) FROM billing.notification_routing_projections),0),
    COALESCE((SELECT max(source_sequence) FROM billing.settings),0),
    COALESCE((SELECT max(source_sequence) FROM billing.offer_projections),0)
  ) AS value
)
SELECT
  (SELECT count(*) FROM billing.payments WHERE aggregate_version < 1 OR source_sequence < 1) +
  (SELECT count(*) FROM billing.subscriptions WHERE aggregate_version < 1 OR source_sequence < 1) +
  (SELECT count(*) FROM billing.identity_contact_projections WHERE projection_version < 1 OR source_sequence < 1) +
  (SELECT count(*) FROM billing.notification_routing_projections WHERE projection_version < 1 OR source_sequence < 1) +
  (SELECT count(*) FROM billing.settings WHERE aggregate_version < 1 OR source_sequence < 1) +
  (SELECT count(*) FROM billing.offer_projections WHERE projection_version < 1 OR source_sequence < 1) +
  CASE WHEN (SELECT count(*) FROM billing.source_sequences WHERE id='billing') <> 1 THEN 1 ELSE 0 END +
  CASE WHEN (SELECT next_value FROM billing.source_sequences WHERE id='billing') <= (SELECT value FROM high_water) THEN 1 ELSE 0 END;")"
	[[ "$continuity_violations" == '0' ]] ||
		billing_restore_fail 'Restored Billing source-version continuity is invalid.'
	expected="$work_root/billing.tables.expected"
	actual="$work_root/billing.tables.$container.actual"
	printf '%s\n' \
		_prisma_migrations affiliate_referrals auto_renewal_consent_events \
		auto_renewals billing_ownership_marker command_receipts \
		identity_contact_projections integration_delivery_failures \
		integration_delivery_receipts notification_routing_projections \
		offer_projections outbox_events payment_receipts payments \
		provider_operations scheduled_runs service_identity settings \
		source_sequences subscription_expiry_reminders subscription_history \
		subscriptions tariff_prices | LC_ALL=C sort >"$expected"
	billing_restore_query "$container" restore_db \
		'COPY (SELECT table_name FROM information_schema.tables WHERE table_schema='\''billing'\'' AND table_type='\''BASE TABLE'\'' ORDER BY table_name COLLATE "C") TO STDOUT;' >"$actual"
	cmp -s "$expected" "$actual" ||
		billing_restore_fail 'Restored Billing table set differs from the candidate schema.'
}

billing_restore_identity_digest() {
	local container="$1" relation="$2" expression="$3" predicate="$4" count digest
	count="$(billing_restore_query "$container" restore_db "SELECT count(*) FROM $relation WHERE $predicate;")"
	digest="$(billing_restore_query "$container" restore_db \
		"COPY (SELECT md5(($expression)::text) FROM $relation WHERE $predicate ORDER BY md5(($expression)::text) COLLATE \"C\") TO STDOUT;" | sha256sum | awk '{ print $1 }')"
	[[ "$count" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s|%s\n' "$count" "$digest"
}

billing_restore_verify_core_billing_parity() {
	local core="$1" billing="$2" entry name core_relation core_key core_where
	local billing_relation billing_key billing_where core_value billing_value
	local -a entries=(
		'payments|public.payments|id|TRUE|billing.payments|id|TRUE'
		'paymentReceipts|public.payment_receipts|id|TRUE|billing.payment_receipts|id|TRUE'
		'subscriptions|public.subscriptions|id|TRUE|billing.subscriptions|id|TRUE'
		'subscriptionHistory|public.subscription_history|id|TRUE|billing.subscription_history|id|TRUE'
		'subscriptionExpiryReminders|public.subscription_expiry_reminders|id|TRUE|billing.subscription_expiry_reminders|id|TRUE'
		'autoRenewals|public.auto_renewals|id|TRUE|billing.auto_renewals|id|TRUE'
		'autoRenewalConsentEvents|public.auto_renewal_consent_events|id|TRUE|billing.auto_renewal_consent_events|id|TRUE'
		'tariffPrices|public.tariff_prices|id|TRUE|billing.tariff_prices|id|TRUE'
		'affiliateReferrals|public.affiliate_referrals|id|TRUE|billing.affiliate_referrals|id|TRUE'
		'identity|public."User"|id|TRUE|billing.identity_contact_projections|user_id|TRUE'
		'notificationRouting|public.telegram_bot_settings|id|TRUE|billing.notification_routing_projections|id|TRUE'
		'integrationFailures|public.integration_delivery_failures|id|integration='\''auto-renewal'\''|billing.integration_delivery_failures|id|integration='\''auto-renewal-charge'\'''
		'integrationReceipts|public.integration_delivery_receipts|id|integration='\''auto-renewal'\''|billing.integration_delivery_receipts|id|integration='\''auto-renewal-charge'\'''
	)
	for entry in "${entries[@]}"; do
		IFS='|' read -r name core_relation core_key core_where billing_relation billing_key billing_where <<<"$entry"
		core_value="$(billing_restore_identity_digest "$core" "$core_relation" "$core_key" "$core_where")"
		billing_value="$(billing_restore_identity_digest "$billing" "$billing_relation" "$billing_key" "$billing_where")"
		[[ "$core_value" == "$billing_value" ]] ||
			billing_restore_fail "Core/Billing PRE identity parity failed: $name"
	done
	[[ "$(billing_restore_query "$core" restore_db "SELECT count(*) FROM public.site_settings WHERE id='singleton';")" == '1'
		&& "$(billing_restore_query "$billing" restore_db "SELECT count(*) FROM billing.settings WHERE id='singleton';")" == '1'
		&& "$(billing_restore_query "$core" restore_db "SELECT count(*) FROM public.legal_pages WHERE slug='oferta';")" == '1'
		&& "$(billing_restore_query "$billing" restore_db "SELECT count(*) FROM billing.offer_projections WHERE id='offer';")" == '1' ]] ||
		billing_restore_fail 'Core/Billing PRE settings or offer parity failed.'
}

billing_restore_verify_pre_post_continuity() {
	local pre="$1" post="$2" entry name relation key predicate pre_file post_file
	local pre_count post_count missing
	local -a entries=(
		'payments|billing.payments|id|TRUE'
		'paymentReceipts|billing.payment_receipts|id|TRUE'
		'subscriptions|billing.subscriptions|id|TRUE'
		'subscriptionHistory|billing.subscription_history|id|TRUE'
		'subscriptionExpiryReminders|billing.subscription_expiry_reminders|id|TRUE'
		'autoRenewals|billing.auto_renewals|id|TRUE'
		'autoRenewalConsentEvents|billing.auto_renewal_consent_events|id|TRUE'
		'tariffPrices|billing.tariff_prices|id|TRUE'
		'affiliateReferrals|billing.affiliate_referrals|id|TRUE'
		'identity|billing.identity_contact_projections|user_id|TRUE'
		'notificationRouting|billing.notification_routing_projections|id|TRUE'
		'offer|billing.offer_projections|id|TRUE'
		'settings|billing.settings|id|TRUE'
		'integrationFailures|billing.integration_delivery_failures|id|integration='\''auto-renewal-charge'\'''
		'integrationReceipts|billing.integration_delivery_receipts|id|integration='\''auto-renewal-charge'\'''
	)
	for entry in "${entries[@]}"; do
		IFS='|' read -r name relation key predicate <<<"$entry"
		pre_file="$work_root/post-continuity.$name.pre"
		post_file="$work_root/post-continuity.$name.post"
		billing_restore_query "$pre" restore_db \
			"COPY (SELECT md5(($key)::text) FROM $relation WHERE $predicate ORDER BY md5(($key)::text) COLLATE \"C\") TO STDOUT;" >"$pre_file"
		billing_restore_query "$post" restore_db \
			"COPY (SELECT md5(($key)::text) FROM $relation WHERE $predicate ORDER BY md5(($key)::text) COLLATE \"C\") TO STDOUT;" >"$post_file"
		pre_count="$(wc -l <"$pre_file" | tr -d '[:space:]')"
		post_count="$(wc -l <"$post_file" | tr -d '[:space:]')"
		missing="$(comm -23 "$pre_file" "$post_file" | wc -l | tr -d '[:space:]')"
		[[ "$pre_count" =~ ^[0-9]+$ && "$post_count" =~ ^[0-9]+$
			&& "$post_count" -ge "$pre_count" && "$missing" == '0' ]] ||
			billing_restore_fail "Billing POST lost a PRE canonical identity: $name"
	done
}

if [[ "$phase" == 'pre-cutover' ]]; then
	billing_restore_collect_metrics core_pre public
	billing_restore_collect_metrics billing_pre billing
	billing_restore_verify_migration_ledger core_pre public \
		"$BILLING_RESTORE_SCRIPT_ROOT/prisma/migrations" "$core_image_id"
	billing_restore_verify_migration_ledger billing_pre billing \
		"$BILLING_RESTORE_SCRIPT_ROOT/apps/billing/prisma/migrations" "$billing_image_id"
	billing_restore_verify_core_acl "$core_pre_container"
	billing_restore_verify_billing_acl "$billing_pre_container"
	billing_restore_verify_billing_invariants "$billing_pre_container"
	[[ "$core_pre_system_id" != "$billing_pre_system_id" ]] || billing_restore_fail 'PRE restores did not use distinct clusters.'
	core_anchor="$(billing_restore_query "$core_pre_container" restore_db "SELECT ownership::text || '|' || generation::text || '|' || prepared_revision || '|' || source_producers_enabled::text || '|' || legacy_routes_enabled::text || '|' || scheduler_enabled::text || '|' || legacy_consumer_enabled::text || '|' || projection_consumer_enabled::text FROM public.billing_core_state WHERE id = 'singleton';")"
	[[ "$core_anchor" == "CORE|$generation|$revision|false|true|false|false|true" ]] || billing_restore_fail 'The restored Core PRE ownership anchor is invalid.'
	billing_anchor="$(billing_restore_query "$billing_pre_container" restore_db "SELECT i.database_id::text || '|' || i.phase::text || '|' || m.phase::text || '|' || m.generation::text || '|' || m.prepared_revision || '|' || m.source_fingerprint FROM billing.service_identity i JOIN billing.billing_ownership_marker m ON m.id = 'singleton' WHERE i.id = 'singleton';")"
	IFS='|' read -r billing_database_id billing_database_phase billing_ownership anchor_generation anchor_revision source_fingerprint <<<"$billing_anchor"
	[[ "$billing_database_id" =~ ^[0-9a-f-]{36}$ && "$billing_database_phase" == 'IMPORTED' \
		&& "$billing_ownership" == 'PREPARED' && "$anchor_generation" == "$generation" \
		&& "$anchor_revision" == "$revision" && "$source_fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
		billing_restore_fail 'The restored Billing PRE ownership anchor is invalid.'
	billing_restore_verify_core_billing_parity "$core_pre_container" \
		"$billing_pre_container"
else
	billing_restore_collect_metrics billing_pre billing
	billing_restore_collect_metrics billing_post billing
	billing_restore_verify_migration_ledger billing_pre billing \
		"$BILLING_RESTORE_SCRIPT_ROOT/apps/billing/prisma/migrations" "$billing_image_id"
	billing_restore_verify_migration_ledger billing_post billing \
		"$BILLING_RESTORE_SCRIPT_ROOT/apps/billing/prisma/migrations" "$billing_image_id"
	billing_restore_verify_billing_acl "$billing_pre_container"
	billing_restore_verify_billing_acl "$billing_post_container"
	billing_restore_verify_billing_invariants "$billing_pre_container"
	billing_restore_verify_billing_invariants "$billing_post_container"
	billing_restore_verify_pre_post_continuity "$billing_pre_container" \
		"$billing_post_container"
	[[ "$billing_pre_system_id" != "$billing_post_system_id" ]] || billing_restore_fail 'POST restores did not use distinct clusters.'
	pre_anchor="$(billing_restore_query "$billing_pre_container" restore_db "SELECT i.database_id::text || '|' || i.phase::text || '|' || m.phase::text || '|' || m.generation::text || '|' || m.prepared_revision || '|' || m.source_fingerprint FROM billing.service_identity i JOIN billing.billing_ownership_marker m ON m.id = 'singleton' WHERE i.id = 'singleton';")"
	post_anchor="$(billing_restore_query "$billing_post_container" restore_db "SELECT i.database_id::text || '|' || i.phase::text || '|' || m.phase::text || '|' || m.generation::text || '|' || m.prepared_revision || '|' || m.source_fingerprint FROM billing.service_identity i JOIN billing.billing_ownership_marker m ON m.id = 'singleton' WHERE i.id = 'singleton';")"
	IFS='|' read -r billing_database_id billing_pre_database_phase billing_pre_ownership anchor_generation anchor_revision source_fingerprint <<<"$pre_anchor"
	IFS='|' read -r post_database_id billing_post_database_phase billing_post_ownership post_generation post_revision post_fingerprint <<<"$post_anchor"
	[[ "$billing_database_id" == "$post_database_id" && "$billing_database_id" =~ ^[0-9a-f-]{36}$ \
		&& "$billing_pre_database_phase" == 'IMPORTED' && "$billing_pre_ownership" == 'PREPARED' \
		&& "$billing_post_database_phase" == 'ACTIVE' && "$billing_post_ownership" == 'ACTIVE' \
		&& "$anchor_generation" == "$generation" && "$post_generation" == "$generation" \
		&& "$anchor_revision" == "$revision" && "$post_revision" == "$revision" \
		&& "$source_fingerprint" == "$post_fingerprint" && "$source_fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
		billing_restore_fail 'The restored Billing PRE/POST ownership anchors are inconsistent.'
	billing_restore_validate_pre_evidence "$pre_evidence_file" "$revision" \
		"$generation" "$billing_pre_sha" "$core_image_id" "$billing_image_id" ||
		billing_restore_fail 'POST restore is not bound to the exact successful PRE evidence.'
	pre_evidence_sha="$(billing_restore_sha256 "$pre_evidence_file")"
fi

billing_restore_cleanup_resources || billing_restore_fail 'Exact-labelled restore resources were not removed cleanly.'
created_containers=()
created_volumes=()
cleanup_complete='true'
completed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

evidence_stage="$(mktemp "$(dirname -- "$evidence_file")/.billing-actual-restore-evidence.XXXXXX")"
chown 0:0 "$evidence_stage"
chmod 600 "$evidence_stage"

export EVIDENCE_PHASE="$phase" EVIDENCE_REVISION="$revision" EVIDENCE_GENERATION="$generation"
export CORE_IMAGE_REF="$core_image_ref" CORE_IMAGE_ID="$core_image_id"
export BILLING_IMAGE_REF="$billing_image_ref" BILLING_IMAGE_ID="$billing_image_id"
export POSTGRES_IMAGE_REF="$BILLING_RESTORE_POSTGRES_IMAGE" POSTGRES_IMAGE_ID="$postgres_image_id"
export BILLING_DATABASE_ID="$billing_database_id" SOURCE_FINGERPRINT="$source_fingerprint"
export STARTED_AT="$started_at" COMPLETED_AT="$completed_at"
export CORE_PRE_SHA="${core_pre_sha:-}" CORE_PRE_SIZE="${core_pre_size:-}" CORE_PRE_TOC_SHA="${core_pre_toc_sha:-}"
export BILLING_PRE_SHA="$billing_pre_sha" BILLING_PRE_SIZE="$billing_pre_size" BILLING_PRE_TOC_SHA="$billing_pre_toc_sha"
export BILLING_POST_SHA="${billing_post_sha:-}" BILLING_POST_SIZE="${billing_post_size:-}" BILLING_POST_TOC_SHA="${billing_post_toc_sha:-}"
export PRE_EVIDENCE_SHA="${pre_evidence_sha:-}"
export CORE_PRE_SYSTEM_ID="${core_pre_system_id:-}" CORE_PRE_TABLE_COUNT="${core_pre_table_count:-}" CORE_PRE_TABLE_SHA="${core_pre_table_sha:-}" CORE_PRE_ROW_SHA="${core_pre_row_sha:-}" CORE_PRE_MIGRATION_COUNT="${core_pre_migration_count:-}" CORE_PRE_MIGRATION_SHA="${core_pre_migration_sha:-}"
export BILLING_PRE_SYSTEM_ID="$billing_pre_system_id" BILLING_PRE_TABLE_COUNT="$billing_pre_table_count" BILLING_PRE_TABLE_SHA="$billing_pre_table_sha" BILLING_PRE_ROW_SHA="$billing_pre_row_sha" BILLING_PRE_MIGRATION_COUNT="$billing_pre_migration_count" BILLING_PRE_MIGRATION_SHA="$billing_pre_migration_sha"
export BILLING_POST_SYSTEM_ID="${billing_post_system_id:-}" BILLING_POST_TABLE_COUNT="${billing_post_table_count:-}" BILLING_POST_TABLE_SHA="${billing_post_table_sha:-}" BILLING_POST_ROW_SHA="${billing_post_row_sha:-}" BILLING_POST_MIGRATION_COUNT="${billing_post_migration_count:-}" BILLING_POST_MIGRATION_SHA="${billing_post_migration_sha:-}"
export CORE_OWNERSHIP="${core_anchor%%|*}" BILLING_PRE_OWNERSHIP="${billing_pre_ownership:-}" BILLING_POST_OWNERSHIP="${billing_post_ownership:-}"
export BILLING_PRE_DB_PHASE="${billing_database_phase:-${billing_pre_database_phase:-}}" BILLING_POST_DB_PHASE="${billing_post_database_phase:-}"

node - "$evidence_stage" <<'NODE'
const fs = require('node:fs');
const metric = prefix => ({
  systemIdentifier: process.env[`${prefix}_SYSTEM_ID`],
  tableCount: Number(process.env[`${prefix}_TABLE_COUNT`]),
  tableManifestSha256: process.env[`${prefix}_TABLE_SHA`],
  rowManifestSha256: process.env[`${prefix}_ROW_SHA`],
  migrationCount: Number(process.env[`${prefix}_MIGRATION_COUNT`]),
  migrationLedgerSha256: process.env[`${prefix}_MIGRATION_SHA`],
});
const dump = prefix => ({
  sha256: process.env[`${prefix}_SHA`],
  sizeBytes: Number(process.env[`${prefix}_SIZE`]),
  tocSha256: process.env[`${prefix}_TOC_SHA`],
});
const pre = process.env.EVIDENCE_PHASE === 'pre-cutover';
const value = {
  schemaVersion: 1,
  action: 'billing-actual-backup-restore-rehearsal',
  target: 'billing',
  status: 'passed',
  postgresMajor: 18,
  phase: process.env.EVIDENCE_PHASE,
  revision: process.env.EVIDENCE_REVISION,
  generation: Number(process.env.EVIDENCE_GENERATION),
  images: {
    core: { ref: process.env.CORE_IMAGE_REF, imageId: process.env.CORE_IMAGE_ID, revision: process.env.EVIDENCE_REVISION, user: 'nestjs' },
    billing: { ref: process.env.BILLING_IMAGE_REF, imageId: process.env.BILLING_IMAGE_ID, revision: process.env.EVIDENCE_REVISION, user: 'billing' },
    postgres: { ref: process.env.POSTGRES_IMAGE_REF, imageId: process.env.POSTGRES_IMAGE_ID, major: 18 },
  },
  dumps: pre ? { corePre: dump('CORE_PRE'), billingPre: dump('BILLING_PRE') }
    : { billingPre: dump('BILLING_PRE'), billingPost: dump('BILLING_POST') },
  restores: pre ? { corePre: metric('CORE_PRE'), billingPre: metric('BILLING_PRE') }
    : { billingPre: metric('BILLING_PRE'), billingPost: metric('BILLING_POST') },
  anchors: pre ? {
    billingDatabaseId: process.env.BILLING_DATABASE_ID,
    sourceFingerprint: process.env.SOURCE_FINGERPRINT,
    coreOwnership: process.env.CORE_OWNERSHIP,
    billingOwnership: process.env.BILLING_PRE_OWNERSHIP,
    billingDatabasePhase: process.env.BILLING_PRE_DB_PHASE,
    coreRestoreSystemIdentifier: process.env.CORE_PRE_SYSTEM_ID,
    billingPreRestoreSystemIdentifier: process.env.BILLING_PRE_SYSTEM_ID,
  } : {
    billingDatabaseId: process.env.BILLING_DATABASE_ID,
    sourceFingerprint: process.env.SOURCE_FINGERPRINT,
    billingPreOwnership: process.env.BILLING_PRE_OWNERSHIP,
    billingPostOwnership: process.env.BILLING_POST_OWNERSHIP,
    billingPreDatabasePhase: process.env.BILLING_PRE_DB_PHASE,
    billingPostDatabasePhase: process.env.BILLING_POST_DB_PHASE,
    billingPreRestoreSystemIdentifier: process.env.BILLING_PRE_SYSTEM_ID,
    billingPostRestoreSystemIdentifier: process.env.BILLING_POST_SYSTEM_ID,
  },
  checks: pre ? {
    sourceFilesSafe: true, dumpShaStable: true, manifestBinding: true, toc: true,
    releaseImages: true, isolatedTargets: true, noHostPorts: true,
    distinctClusters: true, migrations: true, anchors: true, acl: true,
    coreBillingParity: true, relationships: true, continuity: true,
    resourcesRemoved: true,
  } : {
    sourceFilesSafe: true, dumpShaStable: true, manifestBinding: true, toc: true,
    releaseImages: true, isolatedTargets: true, noHostPorts: true,
    distinctClusters: true, migrations: true, anchors: true, acl: true,
    preEvidenceBinding: true, prePostContinuity: true, relationships: true,
    continuity: true, resourcesRemoved: true,
  },
  ...(pre ? {} : { preEvidenceSha256: process.env.PRE_EVIDENCE_SHA }),
  startedAt: process.env.STARTED_AT,
  completedAt: process.env.COMPLETED_AT,
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(value)}\n`, { mode: 0o600 });
NODE

chown 0:0 "$evidence_stage"
chmod 600 "$evidence_stage"
mv -n -- "$evidence_stage" "$evidence_file"
[[ ! -e "$evidence_stage" && ! -L "$evidence_stage" ]] ||
	billing_restore_fail 'Evidence destination appeared concurrently.'
evidence_stage=''
[[ -f "$evidence_file" && ! -L "$evidence_file"
	&& "$(stat -c '%u:%g:%a' "$evidence_file")" == '0:0:600' ]] ||
	billing_restore_fail 'Final restore evidence is unsafe.'
evidence_sha="$(billing_restore_sha256 "$evidence_file")"

printf 'billing_backup_restore_rehearsal_phase=%s\n' "$phase"
printf 'billing_backup_restore_rehearsal=passed\n'
printf 'billing_restore_evidence=%s\n' "$evidence_file"
printf 'billing_restore_evidence_sha256=%s\n' "$evidence_sha"
