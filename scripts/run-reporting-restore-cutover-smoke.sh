#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
readonly REPORTING_RESTORE_SERVER_ROOT="$APP_ROOT/winwidget.ru_server"
readonly REPORTING_RESTORE_DEFAULT_CUTOVER_SCRIPT="$REPORTING_RESTORE_SERVER_ROOT/scripts/reporting-cutover-lifecycle.sh"
readonly REPORTING_RESTORE_DEFAULT_EVIDENCE="$APP_ROOT/deploy/backend/reporting-restore-evidence-v1.json"
readonly REPORTING_CLEANUP_RESTORE_DEFAULT_EVIDENCE="$APP_ROOT/deploy/backend/reporting-cleanup-restore-evidence-v1.json"
readonly REPORTING_RESTORE_MAX_SECONDS='3600'

reporting_restore_stat_mode_before_source() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

reporting_restore_stat_owner_before_source() {
	stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

reporting_restore_resolve_cutover_script() {
	local override="${REPORTING_CUTOVER_LIFECYCLE_SCRIPT:-}"
	if [[ -z "$override" ]]; then
		printf '%s\n' "$REPORTING_RESTORE_DEFAULT_CUTOVER_SCRIPT"
		return
	fi
	[[ "$override" == /* && "$override" != *$'\n'* &&
		-f "$override" && ! -L "$override" &&
		"$(reporting_restore_stat_owner_before_source "$override")" == '0:0' &&
		"$(reporting_restore_stat_mode_before_source "$override")" == '600' ]] || {
		echo 'REPORTING_CUTOVER_LIFECYCLE_SCRIPT must be an absolute root-owned mode-600 regular non-symlink file.' >&2
		return 1
	}
	printf '%s\n' "$override"
}

reporting_restore_fail() {
	echo "$*" >&2
	return 1
}

reporting_restore_sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

reporting_restore_validate_external_receipt() {
	local receipt="${1:-}" LC_ALL=C
	[[ -n "$receipt" && ${#receipt} -le 512 &&
		"$receipt" != *[[:cntrl:]]* ]]
}

reporting_restore_normalize_schema_stream() {
	sed -E \
		-e '/^-- Dumped from database version /d' \
		-e '/^-- Dumped by pg_dump version /d' \
		-e '/^\\(un)?restrict /d'
}

reporting_restore_cleanup() {
	local status=$?
	trap - EXIT INT TERM
	if [[ -n "${restore_container:-}" ]]; then
		local container_id labels
		container_id="$(docker ps -a -q --filter "name=^/${restore_container}$" 2>/dev/null || true)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			labels="$(docker inspect --format '{{printf "%s|%s|%s|%s" (index .Config.Labels "com.winwidget.owner") (index .Config.Labels "com.winwidget.purpose") (index .Config.Labels "com.winwidget.revision") (index .Config.Labels "com.winwidget.switch-generation")}}' "$container_id" 2>/dev/null || true)"
			if [[ "$labels" == "reporting|restore-cutover-smoke|${revision:-}|${switch_generation:-}" ]]; then
				docker rm -f -- "$container_id" >/dev/null 2>&1 || status=1
			else
				echo 'Refusing to remove a restore container whose ownership labels differ.' >&2
				status=1
			fi
		fi
	fi
	if [[ -n "${evidence_stage:-}" &&
		"$(dirname -- "$evidence_stage")" == "$APP_ROOT/deploy/backend" &&
		"$(basename -- "$evidence_stage")" =~ ^\.[a-zA-Z0-9._-]+\.json\.[1-9][0-9]*$ &&
		-f "$evidence_stage" && ! -L "$evidence_stage" &&
		"$(reporting_stat_owner "$evidence_stage" 2>/dev/null || true)" == '0:0' &&
		"$(reporting_stat_mode "$evidence_stage" 2>/dev/null || true)" == '600' ]]; then
		rm -f -- "$evidence_stage"
	fi
	if [[ -n "${work_root:-}" &&
		"$work_root" == "${TMPDIR:-/tmp}/winwidget-reporting-restore."* &&
		-d "$work_root" && ! -L "$work_root" ]]; then
		rm -f -- \
			"$work_root/reporting.dump" \
			"$work_root/reporting.restore-list" \
			"$work_root/restored.schema" \
			"$work_root/redump.schema" \
			"$work_root/restored.rows" \
			"$work_root/redump.rows" \
			"$work_root/restored.sequences" \
			"$work_root/redump.sequences" \
			"$work_root/reporting-redump.dump" \
			"$work_root/reporting-redump.restore-list" \
			"$work_root/evidence.json"
		rmdir -- "$work_root" 2>/dev/null || status=1
	fi
	exit "$status"
}

reporting_restore_wait_healthy() {
	local container="$1" attempt health
	for ((attempt = 1; attempt <= 60; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return 0
		if [[ "$health" == 'unhealthy' ]]; then
			docker logs "$container" >&2 || true
			return 1
		fi
		sleep 2
	done
	docker logs "$container" >&2 || true
	return 1
}

reporting_restore_psql() {
	local database="$1"
	shift
	docker exec "$restore_container" psql --no-psqlrc --set ON_ERROR_STOP=1 \
		--username postgres --dbname "$database" "$@"
}

reporting_restore_table_list() {
	local database="$1"
	reporting_restore_psql "$database" --quiet --tuples-only --no-align \
		--command "SELECT tablename FROM pg_tables WHERE schemaname = 'reporting' ORDER BY tablename COLLATE \"C\";"
}

reporting_restore_row_manifest() {
	local database="$1" output="$2" tables table row_count row_sha
	tables="$(reporting_restore_table_list "$database")" || return 1
	[[ -n "$tables" ]] || return 1
	: >"$output"
	while IFS= read -r table; do
		[[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || return 1
		row_count="$(reporting_restore_psql "$database" --quiet --tuples-only --no-align \
			--command "SELECT count(*) FROM reporting.\"$table\";")"
		[[ "$row_count" =~ ^[0-9]+$ ]] || return 1
		row_sha="$({
			reporting_restore_psql "$database" --quiet --tuples-only --no-align \
				--command "COPY (SELECT md5(to_jsonb(source_row)::text) FROM reporting.\"$table\" AS source_row ORDER BY md5(to_jsonb(source_row)::text) COLLATE \"C\") TO STDOUT;"
		} | if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | awk '{ print $1 }')"
		[[ "$row_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
		printf '%s|%s|%s\n' "$table" "$row_count" "$row_sha" >>"$output"
	done <<<"$tables"
	[[ -s "$output" ]]
}

reporting_restore_sequence_manifest() {
	local database="$1" output="$2" sequences sequence state
	sequences="$(reporting_restore_psql "$database" --quiet --tuples-only --no-align \
		--command "SELECT sequencename FROM pg_sequences WHERE schemaname = 'reporting' ORDER BY sequencename COLLATE \"C\";")" || return 1
	: >"$output"
	[[ -n "$sequences" ]] || return 0
	while IFS= read -r sequence; do
		[[ "$sequence" =~ ^[a-z_][a-z0-9_]*$ ]] || return 1
		state="$(reporting_restore_psql "$database" --quiet --tuples-only --no-align \
			--command "SELECT last_value::text || '|' || is_called::text FROM reporting.\"$sequence\";")"
		[[ "$state" =~ ^-?[0-9]+\|(t|f)$ ]] || return 1
		printf '%s|%s\n' "$sequence" "$state" >>"$output"
	done <<<"$sequences"
}

reporting_restore_schema_manifest() {
	local database="$1" output="$2"
	docker exec "$restore_container" pg_dump \
		--username postgres --dbname "$database" \
		--format plain --schema-only --no-owner --no-acl --schema reporting |
		reporting_restore_normalize_schema_stream >"$output"
	[[ -s "$output" ]]
}

reporting_restore_verify_expected_tables() {
	local database="$1" actual expected
	actual="$(reporting_restore_table_list "$database")"
	expected="$({
		printf '%s\n' \
			_prisma_migrations \
			backfill_runs \
			billing_payment_facts \
			billing_subscription_projections \
			consumer_failures \
			consumer_receipts \
			heartbeats \
			identity_user_projections \
			lead_facts \
			outbox_events \
			projection_receipts \
			projection_watermarks \
			report_runs \
			reporting_settings \
			widget_projections
	} | LC_ALL=C sort)"
	[[ "$actual" == "$expected" ]]
}

reporting_restore_verify_migrations() {
	local database="$1" expected actual invalid
	expected="$(find "$REPORTING_RESTORE_SERVER_ROOT/apps/reporting/prisma/migrations" \
		-mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort)"
	[[ -n "$expected" ]] || return 1
	actual="$(reporting_restore_psql "$database" --quiet --tuples-only --no-align \
		--command 'SELECT migration_name FROM reporting._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name COLLATE "C";')"
	invalid="$(reporting_restore_psql "$database" --quiet --tuples-only --no-align \
		--command 'SELECT count(*) FROM reporting._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;')"
	[[ "$actual" == "$expected" && "$invalid" == '0' ]]
}

reporting_restore_verify_invariants() {
	local database="$1" state
	state="$(reporting_restore_psql "$database" --quiet --tuples-only --no-align \
		--command '
SELECT CASE WHEN
  (SELECT count(*) FROM pg_namespace WHERE nspname = '\''reporting'\'') = 1
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = '\''reporting'\''::regnamespace AND NOT convalidated
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.projection_receipts
    WHERE aggregate_version < 0 OR source_sequence < 0
      OR state_hash !~ '\''^[0-9a-f]{64}$'\''
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.projection_watermarks
    WHERE aggregate_version < 0 OR source_sequence < 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.reporting_settings
    WHERE schedule_authority_generation < 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM reporting.report_runs WHERE period_end <= period_start
  )
THEN '\''ok'\'' ELSE '\''unsafe'\'' END;')"
	[[ "$state" == 'ok' ]]
}

reporting_restore_runtime_crud() {
	local database="$1"
	reporting_restore_psql "$database" --quiet --command '
BEGIN;
CREATE ROLE winwidget_reporting_runtime_restore_smoke
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
GRANT USAGE ON SCHEMA reporting TO winwidget_reporting_runtime_restore_smoke;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.heartbeats
  TO winwidget_reporting_runtime_restore_smoke;
SET LOCAL ROLE winwidget_reporting_runtime_restore_smoke;
INSERT INTO reporting.heartbeats (
  id, role, instance_id, metadata, last_seen_at, created_at, updated_at
) VALUES (
  '\''00000000-0000-4000-8000-000000000099'\'',
  '\''restore-smoke'\'', '\''isolated'\'', '\''{"stage":"inserted"}'\''::jsonb,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
DO $runtime_crud$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reporting.heartbeats
    WHERE id = '\''00000000-0000-4000-8000-000000000099'\''
      AND metadata = '\''{"stage":"inserted"}'\''::jsonb
  ) THEN
    RAISE EXCEPTION '\''Reporting restore read smoke failed'\'';
  END IF;
END
$runtime_crud$;
UPDATE reporting.heartbeats SET metadata = '\''{"stage":"updated"}'\''::jsonb
WHERE id = '\''00000000-0000-4000-8000-000000000099'\'';
DO $runtime_crud$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reporting.heartbeats
    WHERE id = '\''00000000-0000-4000-8000-000000000099'\''
      AND metadata = '\''{"stage":"updated"}'\''::jsonb
  ) THEN
    RAISE EXCEPTION '\''Reporting restore update smoke failed'\'';
  END IF;
END
$runtime_crud$;
DELETE FROM reporting.heartbeats
WHERE id = '\''00000000-0000-4000-8000-000000000099'\'';
DO $runtime_crud$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reporting.heartbeats
    WHERE id = '\''00000000-0000-4000-8000-000000000099'\''
  ) THEN
    RAISE EXCEPTION '\''Reporting restore delete smoke failed'\'';
  END IF;
END
$runtime_crud$;
ROLLBACK;'
}

reporting_restore_self_test_cleanup() {
	local root="${reporting_restore_self_test_root:-}"
	[[ "$root" == "${TMPDIR:-/tmp}/winwidget-reporting-restore-self-test."* &&
		-d "$root" && ! -L "$root" ]] || return 0
	rm -f -- "$root/schema" "$root/input"
	rmdir -- "$root" 2>/dev/null || true
}

reporting_restore_self_test() {
	local test_root normalized source_text forbidden_marker_function
	test_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-restore-self-test.XXXXXX")"
	reporting_restore_self_test_root="$test_root"
	trap reporting_restore_self_test_cleanup EXIT
	printf '%s\n' \
		'-- Dumped from database version 18.0' \
		'-- Dumped by pg_dump version 18.0' \
		'\restrict random' \
		'CREATE SCHEMA reporting;' \
		'\unrestrict random' >"$test_root/input"
	reporting_restore_normalize_schema_stream <"$test_root/input" >"$test_root/schema"
	normalized="$(cat "$test_root/schema")"
	[[ "$normalized" == 'CREATE SCHEMA reporting;' ]] ||
		reporting_restore_fail 'Reporting restore schema normalization self-test failed.'
	reporting_restore_validate_external_receipt 'telegram:reporting-backup:message-1' ||
		reporting_restore_fail 'Reporting restore receipt positive self-test failed.'
	if reporting_restore_validate_external_receipt '' ||
		reporting_restore_validate_external_receipt $'unsafe\nreceipt'; then
		reporting_restore_fail 'Reporting restore receipt negative self-test failed.'
	fi
	source_text="$(<"${BASH_SOURCE[0]}")"
	forbidden_marker_function='reporting_cutover_write_''marker'
	[[ "$source_text" == *'pg_dump'* &&
		"$source_text" == *'pg_restore'* &&
		"$source_text" == *'--network none'* &&
		"$source_text" == *'--tmpfs /var/lib/postgresql'* &&
		"$source_text" == *'reporting_restore_runtime_crud'* &&
		"$source_text" == *'reporting_restore_verify_migrations'* &&
		"$source_text" == *'reporting_restore_verify_invariants'* &&
		"$source_text" == *'REPORTING_RESTORE_MODE'* &&
		"$source_text" == *'REPORTING_CUTOVER_LIFECYCLE_SCRIPT'* &&
		"$source_text" == *'reporting_restore_resolve_cutover_script'* &&
		"$source_text" == *'reporting_restore_stat_owner_before_source'* &&
		"$source_text" == *'reporting_restore_stat_mode_before_source'* &&
		"$source_text" == *"== '0:0'"* &&
		"$source_text" == *"== '600'"* &&
		"$source_text" == *'! -L "$override"'* &&
		"$source_text" == *'cleanup-restore:$revision:$switch_generation:$evidence_sha'* &&
		"$source_text" != *"$forbidden_marker_function"* ]] ||
		reporting_restore_fail 'Reporting restore runner static self-test failed.'
	trap - EXIT
	rm -f -- "$test_root/schema" "$test_root/input"
	rmdir -- "$test_root"
	reporting_restore_self_test_root=''
	echo 'Reporting real-dump isolated restore runner self-test passed.'
}

reporting_restore_main() {
	local reporting_restore_cutover_script
	[[ $# == 0 ]] || {
		if [[ $# == 1 && "$1" == '--self-test' ]]; then
			reporting_restore_self_test
			return
		fi
		echo "Usage: EXPECTED_REVISION=<sha> REPORTING_RESTORE_MODE=initial|post-cleanup REPORTING_RESTORE_EXTERNAL_RECEIPT=<receipt> $0 | $0 --self-test" >&2
		return 1
	}
	[[ "$(id -u)" == '0' ]] || reporting_restore_fail 'Reporting restore cutover smoke must run as root.'
	reporting_restore_cutover_script="$(reporting_restore_resolve_cutover_script)"
	[[ -f "$reporting_restore_cutover_script" && ! -L "$reporting_restore_cutover_script" ]] ||
		reporting_restore_fail 'Tracked Reporting cutover lifecycle is missing or unsafe.'

	# shellcheck source=scripts/reporting-cutover-lifecycle.sh
	source "$reporting_restore_cutover_script"

	revision="${EXPECTED_REVISION:-}"
	restore_mode="${REPORTING_RESTORE_MODE:-initial}"
	external_receipt="${REPORTING_RESTORE_EXTERNAL_RECEIPT:-}"
	case "$restore_mode" in
	initial)
		evidence_file="${REPORTING_RESTORE_EVIDENCE_FILE:-$REPORTING_RESTORE_DEFAULT_EVIDENCE}"
		;;
	post-cleanup)
		evidence_file="${REPORTING_CLEANUP_RESTORE_EVIDENCE_FILE:-$REPORTING_CLEANUP_RESTORE_DEFAULT_EVIDENCE}"
		;;
	*)
		reporting_restore_fail 'REPORTING_RESTORE_MODE must be initial or post-cleanup.'
		;;
	esac
	reporting_restore_validate_external_receipt "$external_receipt" ||
		reporting_restore_fail 'REPORTING_RESTORE_EXTERNAL_RECEIPT must satisfy the existing Reporting evidence contract.'
	[[ "$(dirname -- "$evidence_file")" == "$APP_ROOT/deploy/backend" &&
		"$(basename -- "$evidence_file")" =~ ^[a-zA-Z0-9._-]+\.json$ ]] ||
		reporting_restore_fail 'Reporting restore evidence must be a direct JSON child of the protected backend deploy directory.'
	[[ ! -e "$evidence_file" && ! -L "$evidence_file" ]] ||
		reporting_restore_fail 'Reporting restore evidence already exists; refusing to overwrite it.'

	reporting_validate_production_files
	reporting_validate_exact_revision "$revision"
	reporting_cutover_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	acquire_production_deploy_lock 'Reporting real-dump isolated restore smoke'
	reporting_cutover_validate_marker
	if [[ "$restore_mode" == 'initial' ]]; then
		[[ "$(reporting_cutover_marker_value revision)" == "$revision" ]] ||
			reporting_restore_fail 'Reporting restore smoke revision differs from the durable cutover marker.'
		reporting_cutover_require_phase routes-switched
		[[ "$(reporting_cutover_marker_value restore_evidence_sha256)" == 'pending' ]] ||
			reporting_restore_fail 'Reporting restore evidence is already fixed in the durable marker.'
	else
		original_revision="$(reporting_cutover_marker_value revision)"
		[[ "$(reporting_cutover_marker_value cleanup_revision)" == "$revision" ]] ||
			reporting_restore_fail 'Post-cleanup restore revision differs from the durable cleanup revision.'
		reporting_cutover_require_phase source-cleaned
		[[ "$(reporting_cutover_marker_value restore_evidence_sha256)" =~ ^[0-9a-f]{64}$ &&
			"$(reporting_cutover_marker_value source_cleanup_evidence_sha256)" =~ ^[0-9a-f]{64}$ &&
			"$(reporting_cutover_marker_value cleanup_restore_evidence_sha256)" == 'pending' ]] ||
			reporting_restore_fail 'Post-cleanup restore prerequisites are incomplete or evidence is already fixed.'
		reporting_cutover_require_cleanup_git_contract "$original_revision" "$revision"
		reporting_cutover_require_cleanup_runtime_revision "$revision"
		reporting_cutover_require_forward_scheduler_ready
		reporting_cutover_require_core_producer_continuity
		reporting_cutover_require_legacy_core_state_absent
		reporting_cutover_require_projection_barrier
		reporting_cutover_require_post_cleanup_queue_topology
	fi
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	system_identifier="$(reporting_cutover_marker_value database_system_identifier)"
	reporting_cutover_require_switch_generation REPORTING "$switch_generation"
	reporting_initialize_database_guard 'Reporting real-dump isolated restore smoke'
	reporting_validate_root_owned_directory "$(dirname -- "$evidence_file")" ||
		reporting_restore_fail 'Reporting restore evidence directory is unsafe.'

	started_epoch="$(date +%s)"
	work_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-restore.XXXXXX")"
	chmod 700 "$work_root"
	trap reporting_restore_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	restore_container="winwidget-reporting-restore-${switch_generation}-$$"
	[[ "$restore_container" =~ ^winwidget-reporting-restore-[1-9][0-9]*-[1-9][0-9]*$ ]] ||
		reporting_restore_fail 'Generated restore container name is invalid.'
	[[ -z "$(docker ps -a -q --filter 'label=com.winwidget.purpose=restore-cutover-smoke')" ]] ||
		reporting_restore_fail 'A stale Reporting restore-cutover-smoke container already exists.'

	backup_url="$(reporting_libpq_url REPORTING_BACKUP_URL)"
	PGURL="$backup_url" docker run --rm --network host --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 256m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
		--mount "type=bind,source=$work_root,target=/evidence" \
		-e PGURL "$REPORTING_CANONICAL_POSTGRES_IMAGE" sh -euc '
pg_dump --format=custom --compress=6 --no-owner --no-acl --no-password \
  --schema=reporting "$PGURL" --file=/evidence/reporting.dump
pg_restore --list /evidence/reporting.dump >/evidence/reporting.restore-list
test -s /evidence/reporting.dump
test -s /evidence/reporting.restore-list
chmod 600 /evidence/reporting.dump /evidence/reporting.restore-list
'
	unset backup_url
	dump_sha="$(reporting_restore_sha256_file "$work_root/reporting.dump")"
	[[ "$dump_sha" =~ ^[0-9a-f]{64}$ ]] || reporting_restore_fail 'Reporting dump SHA-256 is invalid.'

	docker run -d \
		--name "$restore_container" \
		--network none \
		--read-only \
		--init \
		--security-opt no-new-privileges \
		--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE \
		--cap-add FOWNER --cap-add SETGID --cap-add SETUID \
		--pids-limit 128 --memory 768m --cpus 1.0 \
		--tmpfs /var/lib/postgresql:rw,nosuid,nodev,size=768m \
		--tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
		--mount "type=bind,source=$work_root/reporting.dump,target=/evidence/reporting.dump,readonly" \
		--label com.winwidget.owner=reporting \
		--label com.winwidget.purpose=restore-cutover-smoke \
		--label "com.winwidget.revision=$revision" \
		--label "com.winwidget.switch-generation=$switch_generation" \
		-e POSTGRES_DB=postgres \
		-e POSTGRES_USER=postgres \
		-e POSTGRES_HOST_AUTH_METHOD=trust \
		-e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 \
		-e POSTGRES_INITDB_ARGS='--locale=C.UTF-8 --encoding=UTF8 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd 'pg_isready --username postgres --dbname postgres' \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$REPORTING_CANONICAL_POSTGRES_IMAGE" >/dev/null
	reporting_restore_wait_healthy "$restore_container"

	container_identity="$(docker inspect --format '{{.HostConfig.NetworkMode}}|{{.Config.Image}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{.State.Health.Status}}|{{.RestartCount}}' "$restore_container")"
	[[ "$container_identity" == "none|$REPORTING_CANONICAL_POSTGRES_IMAGE|reporting|restore-cutover-smoke|healthy|0" ]] ||
		reporting_restore_fail 'Isolated Reporting restore container identity is unsafe.'
	[[ -z "$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$restore_container")" ]] ||
		reporting_restore_fail 'Isolated Reporting restore unexpectedly uses a Docker volume.'
	restored_system_identifier="$(reporting_restore_psql postgres --quiet --tuples-only --no-align \
		--command 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$restored_system_identifier" =~ ^[0-9]+$ &&
		"$restored_system_identifier" != "$system_identifier" ]] ||
		reporting_restore_fail 'Restore target is not a distinct PostgreSQL cluster.'
	[[ "$(reporting_restore_psql postgres --quiet --tuples-only --no-align \
		--command 'SHOW server_version_num;')" =~ ^18[0-9]{4}$ ]] ||
		reporting_restore_fail 'Restore target is not PostgreSQL 18.'
	[[ "$(reporting_restore_psql postgres --quiet --tuples-only --no-align \
		--command 'SHOW data_checksums;')" == 'on' ]] ||
		reporting_restore_fail 'Restore target data checksums are disabled.'

	reporting_restore_psql postgres --command 'CREATE DATABASE winwidget_reporting_restore WITH TEMPLATE template0;'
	docker exec "$restore_container" pg_restore --exit-on-error --single-transaction \
		--no-owner --no-acl --username postgres --dbname winwidget_reporting_restore \
		/evidence/reporting.dump
	reporting_restore_verify_expected_tables winwidget_reporting_restore
	reporting_restore_verify_migrations winwidget_reporting_restore
	reporting_restore_verify_invariants winwidget_reporting_restore
	reporting_restore_runtime_crud winwidget_reporting_restore
	reporting_restore_schema_manifest winwidget_reporting_restore "$work_root/restored.schema"
	reporting_restore_row_manifest winwidget_reporting_restore "$work_root/restored.rows"
	reporting_restore_sequence_manifest winwidget_reporting_restore "$work_root/restored.sequences"

	docker exec "$restore_container" pg_dump \
		--username postgres --dbname winwidget_reporting_restore \
		--format custom --compress=6 --no-owner --no-acl --schema reporting \
		--file /tmp/reporting-redump.dump
	docker exec "$restore_container" pg_restore --list /tmp/reporting-redump.dump \
		>"$work_root/reporting-redump.restore-list"
	docker cp "$restore_container:/tmp/reporting-redump.dump" \
		"$work_root/reporting-redump.dump" >/dev/null
	[[ -s "$work_root/reporting-redump.dump" &&
		-s "$work_root/reporting-redump.restore-list" ]] ||
		reporting_restore_fail 'Reporting restored database redump is empty.'
	reporting_restore_psql postgres --command 'CREATE DATABASE winwidget_reporting_redump WITH TEMPLATE template0;'
	docker cp "$work_root/reporting-redump.dump" "$restore_container:/tmp/reporting-redump-copy.dump"
	docker exec "$restore_container" pg_restore --exit-on-error --single-transaction \
		--no-owner --no-acl --username postgres --dbname winwidget_reporting_redump \
		/tmp/reporting-redump-copy.dump
	reporting_restore_verify_expected_tables winwidget_reporting_redump
	reporting_restore_verify_migrations winwidget_reporting_redump
	reporting_restore_verify_invariants winwidget_reporting_redump
	reporting_restore_schema_manifest winwidget_reporting_redump "$work_root/redump.schema"
	reporting_restore_row_manifest winwidget_reporting_redump "$work_root/redump.rows"
	reporting_restore_sequence_manifest winwidget_reporting_redump "$work_root/redump.sequences"
	cmp -s "$work_root/restored.schema" "$work_root/redump.schema" ||
		reporting_restore_fail 'Reporting schema differs after restore and redump.'
	cmp -s "$work_root/restored.rows" "$work_root/redump.rows" ||
		reporting_restore_fail 'Reporting rows differ after restore and redump.'
	cmp -s "$work_root/restored.sequences" "$work_root/redump.sequences" ||
		reporting_restore_fail 'Reporting sequences differ after restore and redump.'

	container_id="$(docker ps -a -q --filter "name=^/${restore_container}$")"
	docker rm -f -- "$container_id" >/dev/null
	restore_container=''
	reporting_verify_database_lifecycle_unchanged
	completed_epoch="$(date +%s)"
	((completed_epoch >= started_epoch &&
		completed_epoch - started_epoch <= REPORTING_RESTORE_MAX_SECONDS)) ||
		reporting_restore_fail 'Reporting isolated restore exceeded the bounded one-hour evidence window.'

	restored_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	reporting_image_id="$(reporting_resolve_image_id_for_revision "$revision")"
	# The JavaScript program is intentionally passed literally to Node in the
	# isolated image; shell expansion here would corrupt the evidence payload.
	# shellcheck disable=SC2016
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		-e "EXPECTED_REVISION=$revision" \
		-e "EXPECTED_SYSTEM_IDENTIFIER=$system_identifier" \
		-e "EXPECTED_SWITCH_GENERATION=$switch_generation" \
		-e "DUMP_SHA256=$dump_sha" \
		-e "EXTERNAL_RECEIPT=$external_receipt" \
		-e "RESTORED_AT=$restored_at" \
		--entrypoint node "$reporting_image_id" -e '
const value = {
  version: 1,
  revision: process.env.EXPECTED_REVISION,
  databaseSystemIdentifier: process.env.EXPECTED_SYSTEM_IDENTIFIER,
  switchGeneration: process.env.EXPECTED_SWITCH_GENERATION,
  dumpSha256: process.env.DUMP_SHA256,
  externalReceipt: process.env.EXTERNAL_RECEIPT,
  restoredAt: process.env.RESTORED_AT,
  checks: {
    isolatedTarget: true,
    migrations: true,
    tables: true,
    sequences: true,
    rows: true,
    invariants: true,
    runtimeCrud: true,
    backupRedump: true,
  },
};
process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
' >"$work_root/evidence.json"
	chown 0:0 "$work_root/evidence.json"
	chmod 600 "$work_root/evidence.json"
	reporting_cutover_validate_restore_evidence \
		"$work_root/evidence.json" "$revision" "$system_identifier" "$switch_generation"
	evidence_stage="$(dirname -- "$evidence_file")/.$(basename -- "$evidence_file").$$"
	[[ ! -e "$evidence_stage" && ! -L "$evidence_stage" ]] ||
		reporting_restore_fail 'Reporting restore evidence staging path already exists.'
	install -o root -g root -m 600 "$work_root/evidence.json" "$evidence_stage"
	reporting_cutover_validate_restore_evidence \
		"$evidence_stage" "$revision" "$system_identifier" "$switch_generation"
	evidence_sha="$(reporting_restore_sha256_file "$evidence_stage")"
	[[ "$evidence_sha" =~ ^[0-9a-f]{64}$ ]] ||
		reporting_restore_fail 'Reporting restore evidence SHA-256 is invalid.'
	mv -n "$evidence_stage" "$evidence_file"
	[[ ! -e "$evidence_stage" && ! -L "$evidence_stage" ]] ||
		reporting_restore_fail 'Reporting restore evidence destination appeared concurrently.'
	evidence_stage=''
	reporting_cutover_validate_restore_evidence \
		"$evidence_file" "$revision" "$system_identifier" "$switch_generation"
	[[ "$(reporting_restore_sha256_file "$evidence_file")" == "$evidence_sha" ]] ||
		reporting_restore_fail 'Reporting restore evidence changed during publication.'
	echo "Reporting real dump restored and redumped in isolated PostgreSQL 18. Evidence: $evidence_file"
	echo "Evidence sha256=$evidence_sha"
	if [[ "$restore_mode" == 'initial' ]]; then
		echo "Set REPORTING_RESTORE_EVIDENCE_FILE=$evidence_file"
		echo "Set CONFIRM_REPORTING_RESTORE_VERIFIED=restore:$revision:$switch_generation:$evidence_sha"
	else
		echo "Set REPORTING_CLEANUP_RESTORE_EVIDENCE_FILE=$evidence_file"
		echo "Set CONFIRM_REPORTING_CLEANUP_RESTORE_VERIFIED=cleanup-restore:$revision:$switch_generation:$evidence_sha"
	fi
}

reporting_restore_main "$@"
