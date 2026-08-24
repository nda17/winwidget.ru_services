#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

PLATFORM_RESTORE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly PLATFORM_RESTORE_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly PLATFORM_RESTORE_MAX_DUMP_BYTES=$((49 * 1024 * 1024))

revision=''
phase=''
dump_file=''
expected_sha256=''
database_id=''
source_system_identifier=''
evidence_file=''
node_image_id=''
work_root=''
container=''
volume=''
admin_password=''
created_container='false'
created_volume='false'
platform_restore_docker_binary=''
evidence_temporary=''

platform_restore_fail() {
	printf 'platform_restore_rehearsal_error=%s\n' "$1" >&2
	return 1
}

platform_restore_usage() {
	printf '%s\n' \
		'Usage: platform-backup-restore-rehearsal.sh --revision <sha> --phase imported|active' \
		'  --dump <absolute-custom-dump> --expected-sha256 <sha256> --database-id <uuid>' \
		'  --source-system-identifier <integer> --evidence-file <absolute-json>' \
		'  --node-image-id <sha256-image-id>' \
		'  platform-backup-restore-rehearsal.sh --self-test'
}

platform_restore_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

platform_restore_absolute_path() {
	[[ "$1" == /* && "$1" != *$'\n'* && "$1" != *'//'*
		&& "$1" != */./* && "$1" != */../* && "$1" != */. && "$1" != */.. ]]
}

platform_restore_private_metadata_allowed() {
	[[ $# -eq 2 && "$1" =~ ^(600|700)$ &&
		"$2" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]] || return 1
	local owner group mode
	IFS=: read -r owner group mode <<<"$2"
	[[ "$owner" == 0 && "$group" == 0 && "$mode" == "$1" ]]
}

platform_restore_require_private_directory() {
	[[ $# -eq 1 ]] || return 1
	local directory="$1" canonical metadata
	platform_restore_absolute_path "$directory" &&
		[[ -d "$directory" && ! -L "$directory" ]] || return 1
	canonical="$(realpath -- "$directory")" || return 1
	[[ "$canonical" == "$directory" ]] || return 1
	if [[ "$(uname -s)" == Linux ]]; then
		metadata="$(stat -c '%u:%g:%a' "$directory")" || return 1
		platform_restore_private_metadata_allowed 700 "$metadata" || return 1
	fi
}

platform_restore_require_private_input_file() {
	[[ $# -eq 1 ]] || return 1
	local file="$1" canonical metadata
	platform_restore_absolute_path "$file" &&
		[[ -f "$file" && ! -L "$file" && -s "$file" ]] || return 1
	platform_restore_require_private_directory "$(dirname -- "$file")" || return 1
	canonical="$(realpath -- "$file")" || return 1
	[[ "$canonical" == "$file" ]] || return 1
	if [[ "$(uname -s)" == Linux ]]; then
		metadata="$(stat -c '%u:%g:%a' "$file")" || return 1
		platform_restore_private_metadata_allowed 600 "$metadata" || return 1
	fi
}

platform_restore_require_private_output_path() {
	[[ $# -eq 1 ]] || return 1
	local output="$1"
	platform_restore_absolute_path "$output" || return 1
	[[ "$(basename -- "$output")" =~ ^[A-Za-z0-9._-]+\.json$ &&
		! -e "$output" && ! -L "$output" ]] || return 1
	platform_restore_require_private_directory "$(dirname -- "$output")"
}

platform_restore_validate_inputs() {
	local size
	[[ "$(id -u)" == 0 ]] ||
		platform_restore_fail 'restore rehearsal must run as root' || return 1
	[[ "$revision" =~ ^[0-9a-f]{40}$ && "$phase" =~ ^(imported|active)$ &&
		"$expected_sha256" =~ ^[0-9a-f]{64}$ &&
		"$node_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$source_system_identifier" =~ ^[1-9][0-9]*$ ]] ||
		platform_restore_fail 'invalid immutable rehearsal identity' || return 1
	[[ "$(basename -- "$dump_file")" =~ ^[A-Za-z0-9._-]+\.dump$ ]] &&
		platform_restore_require_private_input_file "$dump_file" ||
		platform_restore_fail 'dump must be a non-empty regular absolute file' || return 1
	[[ "$(head -c 5 "$dump_file")" == 'PGDMP' ]] ||
		platform_restore_fail 'dump is not PostgreSQL custom format' || return 1
	size="$(wc -c <"$dump_file" | tr -d '[:space:]')"
	[[ "$size" =~ ^[0-9]+$ && "$size" -le "$PLATFORM_RESTORE_MAX_DUMP_BYTES" ]] ||
		platform_restore_fail 'dump exceeds the bounded restore contract' || return 1
	[[ "$(platform_restore_sha256 "$dump_file")" == "$expected_sha256" ]] ||
		platform_restore_fail 'dump SHA-256 differs from the bound manifest' || return 1
	platform_restore_require_private_output_path "$evidence_file" ||
		platform_restore_fail 'evidence output path is unsafe or already exists' || return 1
}

platform_restore_assert_local_docker() {
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" &&
		-z "${DOCKER_CONFIG+x}" && -z "${DOCKER_TLS_VERIFY+x}" &&
		-z "${DOCKER_CERT_PATH+x}" && -z "${DOCKER_API_VERSION+x}" ]] ||
		platform_restore_fail 'rehearsal refuses ambient Docker endpoint overrides' || return 1
	local docker_binary
	docker_binary="$(type -P docker 2>/dev/null || true)"
	[[ -n "$docker_binary" && "$docker_binary" == /* && -f "$docker_binary" &&
		! -L "$docker_binary" && -x "$docker_binary" ]] ||
		platform_restore_fail 'rehearsal requires a trusted Docker CLI binary' || return 1
	[[ "$("$docker_binary" context show)" == default &&
		"$("$docker_binary" context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$("$docker_binary" info --format '{{.OSType}}')" == linux ]] ||
		platform_restore_fail 'rehearsal requires the local Linux Docker socket' || return 1
	platform_restore_docker_binary="$docker_binary"
}

platform_restore_docker() {
	[[ -n "$platform_restore_docker_binary" ]] ||
		platform_restore_assert_local_docker || return 1
	"$platform_restore_docker_binary" "$@"
}

platform_restore_prepare_node_runtime() {
	local metadata image_id image_revision image_user image_title
	metadata="$(platform_restore_docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.title"}}' \
		"$node_image_id")" ||
		platform_restore_fail 'revision-pinned Platform image is unavailable' || return 1
	IFS='|' read -r image_id image_revision image_user image_title <<<"$metadata"
	[[ "$image_id" == "$node_image_id" && "$image_revision" == "$revision" &&
		"$image_user" == platform && "$image_title" == winwidget-platform &&
		"$(git -C "$PLATFORM_RESTORE_ROOT" rev-parse HEAD)" == "$revision" ]] ||
		platform_restore_fail 'Platform image identity is unsafe or revision-mismatched'
}

platform_restore_remove_resources() {
	if [[ -n "$evidence_temporary" ]]; then
		local evidence_parent evidence_prefix
		evidence_parent="$(dirname -- "$evidence_file")"
		evidence_prefix="$evidence_parent/.$(basename -- "$evidence_file").partial."
		if [[ "$evidence_temporary" == "$evidence_prefix"* &&
			-f "$evidence_temporary" && ! -L "$evidence_temporary" ]]; then
			rm -f -- "$evidence_temporary"
		fi
		evidence_temporary=''
	fi
	if [[ "$created_container" == true && -n "$container" ]]; then
		platform_restore_docker rm -f "$container" >/dev/null 2>&1 || true
		if [[ -z "$(platform_restore_docker ps -aq --filter "name=^/${container}$")" ]]; then
			created_container='false'
		fi
	fi
	if [[ "$created_volume" == true && -n "$volume" ]]; then
		platform_restore_docker volume rm "$volume" >/dev/null 2>&1 || true
		if [[ -z "$(platform_restore_docker volume ls -q --filter "name=^${volume}$")" ]]; then
			created_volume='false'
		fi
	fi
	if [[ -n "$work_root" && -d "$work_root" && ! -L "$work_root" &&
		"$work_root" == /tmp/winwidget-platform-restore-* ]]; then
		rm -rf -- "$work_root"
	fi
	[[ -z "$container" || -z "$(platform_restore_docker ps -aq --filter "name=^/${container}$")" ]] &&
		[[ -z "$volume" || -z "$(platform_restore_docker volume ls -q --filter "name=^${volume}$")" ]]
}

platform_restore_cleanup() {
	local status=$?
	trap - EXIT INT TERM
	platform_restore_remove_resources || true
	exit "$status"
}

platform_restore_path_self_test() {
	local temporary_root test_root input_link input_file output_file result=0
	temporary_root="$(realpath -- /tmp)" || return 1
	test_root="$(mktemp -d "$temporary_root/winwidget-platform-path-self-test.XXXXXX")" || return 1
	input_file="$test_root/probe.dump"
	input_link="$test_root/probe-link.dump"
	output_file="$test_root/evidence.json"
	chmod 700 "$test_root" || result=1
	printf 'PGDMPprobe\n' >"$input_file" || result=1
	chmod 600 "$input_file" || result=1
	ln -s "$input_file" "$input_link" || result=1

	platform_restore_absolute_path "$input_file" || result=1
	if platform_restore_absolute_path "$test_root/../unsafe.dump"; then result=1; fi
	platform_restore_private_metadata_allowed 700 0:0:700 || result=1
	platform_restore_private_metadata_allowed 600 0:0:600 || result=1
	if platform_restore_private_metadata_allowed 700 1000:0:700; then result=1; fi
	if platform_restore_private_metadata_allowed 700 0:1000:700; then result=1; fi
	if platform_restore_private_metadata_allowed 700 0:0:755; then result=1; fi
	if platform_restore_private_metadata_allowed 600 0:0:644; then result=1; fi
	if platform_restore_require_private_input_file "$input_link"; then result=1; fi
	if [[ "$(uname -s)" != Linux || "$(id -u)" == 0 ]]; then
		platform_restore_require_private_directory "$test_root" || result=1
		platform_restore_require_private_input_file "$input_file" || result=1
		platform_restore_require_private_output_path "$output_file" || result=1
		if [[ "$(uname -s)" == Linux ]]; then
			chmod 755 "$test_root" || result=1
			if platform_restore_require_private_directory "$test_root"; then result=1; fi
			chmod 700 "$test_root" || result=1
			chmod 644 "$input_file" || result=1
			if platform_restore_require_private_input_file "$input_file"; then result=1; fi
			chmod 600 "$input_file" || result=1
		fi
	fi
	ln -s missing-evidence-target "$output_file" || result=1
	if platform_restore_require_private_output_path "$output_file"; then result=1; fi

	rm -f -- "$input_link" "$input_file" "$output_file"
	rmdir -- "$test_root"
	((result == 0))
}

platform_restore_query() {
	local database="$1" sql="$2"
	PGPASSWORD="$admin_password" platform_restore_docker exec --env PGPASSWORD "$container" \
		psql --no-psqlrc --no-password --tuples-only --no-align \
		--set ON_ERROR_STOP=1 --username postgres --dbname "$database" --command "$sql"
}

platform_restore_query_stdin() {
	local database="$1"
	PGPASSWORD="$admin_password" platform_restore_docker exec --interactive \
		--env PGPASSWORD "$container" \
		psql --no-psqlrc --no-password --tuples-only --no-align \
		--set ON_ERROR_STOP=1 --username postgres --dbname "$database"
}

platform_restore_assert_semantic_guard_catalog() {
	local catalog_state
	catalog_state="$(platform_restore_query_stdin winwidget_platform <<'SQL'
WITH expected(table_name, trigger_name) AS (
    VALUES
        ('service_identity', 'service_identity_semantic_fingerprint_guard'),
        ('source_sequences', 'source_sequences_semantic_fingerprint_guard'),
        ('site_settings', 'site_settings_semantic_fingerprint_guard'),
        ('legal_pages', 'legal_pages_semantic_fingerprint_guard'),
        ('home_page_content', 'home_page_content_semantic_fingerprint_guard'),
        ('billing_offer_producer_state', 'billing_offer_producer_semantic_fingerprint_guard')
), catalog AS (
    SELECT
        expected.table_name,
        expected.trigger_name,
        relation.oid AS relation_oid,
        trigger_entry.*,
        constraint_entry.oid AS constraint_oid,
        constraint_entry.contype,
        constraint_entry.conname,
        constraint_entry.connamespace,
        constraint_entry.conrelid,
        constraint_entry.condeferrable,
        constraint_entry.condeferred
    FROM expected
    LEFT JOIN pg_class relation
      ON relation.oid = format('platform.%I', expected.table_name)::regclass
    LEFT JOIN pg_trigger trigger_entry
      ON trigger_entry.tgrelid = relation.oid
     AND trigger_entry.tgname = expected.trigger_name
    LEFT JOIN pg_constraint constraint_entry
      ON constraint_entry.oid = trigger_entry.tgconstraint
)
SELECT count(*) = 6
   AND bool_and(
        oid IS NOT NULL
        AND tgenabled = 'O'
        AND NOT tgisinternal
        AND tgtype = 29
        AND tgconstraint <> 0
        AND constraint_oid IS NOT NULL
        AND tgdeferrable
        AND tginitdeferred
        AND tgfoid = 'platform.enforce_current_semantic_fingerprint()'::regprocedure
        AND contype = 't'
        AND conname = trigger_name
        AND connamespace = 'platform'::regnamespace
        AND conrelid = relation_oid
        AND condeferrable
        AND condeferred
    )
   AND (SELECT count(*) FROM pg_trigger
        WHERE tgfoid = 'platform.enforce_current_semantic_fingerprint()'::regprocedure) = 6
FROM catalog;
SQL
)"
	[[ "$catalog_state" == t ]] ||
		platform_restore_fail 'Platform semantic constraint-trigger catalog is not exact' || return 1
}

platform_restore_assert_positive_high_watermark_constraint() {
	local output
	if output="$(platform_restore_query winwidget_platform '
CREATE TEMP TABLE platform_service_identity_constraint_probe
    (LIKE platform.service_identity INCLUDING CONSTRAINTS);
INSERT INTO platform_service_identity_constraint_probe (
    id,
    service_name,
    database_id,
    phase,
    ownership_generation,
    source_fingerprint,
    source_snapshot_sha256,
    source_snapshot_counts,
    source_high_watermark,
    current_semantic_fingerprint,
    imported_at,
    activated_at,
    created_at,
    updated_at
) VALUES (
    $probe$singleton$probe$,
    $probe$platform-service$probe$,
    $probe$11111111-1111-4111-8111-111111111111$probe$,
    $probe$ACTIVE$probe$,
    1,
    repeat($probe$a$probe$, 64),
    repeat($probe$b$probe$, 64),
    jsonb_build_object(
        $probe$siteSettings$probe$, 1,
        $probe$legalPages$probe$, 4,
        $probe$homePageContent$probe$, 1
    ),
    0,
    repeat($probe$c$probe$, 64),
    CURRENT_TIMESTAMP - make_interval(secs => 1),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);' 2>&1)"; then
		platform_restore_fail 'Platform ownership constraint accepted a zero source high-watermark'
		return 1
	fi
	[[ "$output" == *'service_identity_source_check'* ]] ||
		platform_restore_fail 'Platform ownership zero-watermark probe failed outside its source constraint' || return 1
}

platform_restore_assert_current_semantic_fingerprint_contract() {
	local persisted recomputed after_probes
	persisted="$(platform_restore_query winwidget_platform \
		"SELECT current_semantic_fingerprint FROM platform.service_identity WHERE id = 'singleton';")"
	recomputed="$(platform_restore_query winwidget_platform \
		'SELECT platform.current_semantic_fingerprint();')"
	[[ "$persisted" =~ ^[0-9a-f]{64}$ && "$persisted" == "$recomputed" ]] ||
		platform_restore_fail 'restored Platform current semantic fingerprint is stale' || return 1

	platform_restore_query_stdin winwidget_platform >/dev/null <<'SQL'
DO $semantic_guard$
DECLARE
    probe RECORD;
    before_rows JSONB;
    after_rows JSONB;
    before_persisted TEXT;
    after_persisted TEXT;
    before_recomputed TEXT;
    after_recomputed TEXT;
    actual_state TEXT;
    actual_constraint TEXT;
    rollback_marker TEXT;
BEGIN
    FOR probe IN
        SELECT * FROM (VALUES
            (
                'service_identity',
                $mutation$UPDATE platform.service_identity
                    SET updated_at = updated_at + interval '1 millisecond'
                    WHERE id = 'singleton'$mutation$
            ),
            (
                'source_sequences',
                $mutation$UPDATE platform.source_sequences
                    SET next_value = next_value + 1,
                        updated_at = updated_at + interval '1 millisecond'
                    WHERE id = 'platform'$mutation$
            ),
            (
                'site_settings',
                $mutation$UPDATE platform.site_settings
                    SET snowflake_enabled = NOT snowflake_enabled,
                        aggregate_version = aggregate_version + 1,
                        source_sequence = source_sequence + 1,
                        updated_at = updated_at + interval '1 millisecond'
                    WHERE id = 'singleton'$mutation$
            ),
            (
                'legal_pages',
                $mutation$UPDATE platform.legal_pages
                    SET content = CASE WHEN content = '' THEN 'guard-probe' ELSE '' END,
                        aggregate_version = aggregate_version + 1,
                        source_sequence = source_sequence + 1,
                        updated_at = updated_at + interval '1 millisecond'
                    WHERE slug = 'personal-policy'$mutation$
            ),
            (
                'home_page_content',
                $mutation$UPDATE platform.home_page_content
                    SET content = CASE
                            WHEN content = '{"guardProbe":true}'::jsonb THEN '{}'::jsonb
                            ELSE '{"guardProbe":true}'::jsonb
                        END,
                        aggregate_version = aggregate_version + 1,
                        source_sequence = source_sequence + 1,
                        updated_at = updated_at + interval '1 millisecond'
                    WHERE id = 'singleton'$mutation$
            ),
            (
                'billing_offer_producer_state',
                $mutation$UPDATE platform.billing_offer_producer_state
                    SET phase = CASE
                            WHEN phase = 'BLOCKED' THEN 'IMPORTED'::platform."OfferProducerPhase"
                            ELSE 'ACTIVE'::platform."OfferProducerPhase"
                        END,
                        producer_contract_version = CASE WHEN phase = 'BLOCKED' THEN 2 ELSE producer_contract_version END,
                        source_sequence_scope = CASE WHEN phase = 'BLOCKED' THEN 'billing.offer:offer' ELSE source_sequence_scope END,
                        imported_aggregate_version = CASE WHEN phase = 'BLOCKED' THEN 1 ELSE imported_aggregate_version END,
                        imported_source_sequence = CASE WHEN phase = 'BLOCKED' THEN 1 ELSE imported_source_sequence END,
                        current_aggregate_version = CASE
                            WHEN phase = 'ACTIVE' THEN current_aggregate_version + 1
                            WHEN phase = 'IMPORTED' THEN imported_aggregate_version
                            ELSE NULL
                        END,
                        current_source_sequence = CASE
                            WHEN phase = 'ACTIVE' THEN current_source_sequence + 1
                            WHEN phase = 'IMPORTED' THEN imported_source_sequence
                            ELSE NULL
                        END,
                        source_fence_fingerprint = CASE WHEN phase = 'BLOCKED' THEN repeat('a', 64) ELSE source_fence_fingerprint END,
                        imported_at = CASE WHEN phase = 'BLOCKED' THEN CURRENT_TIMESTAMP ELSE imported_at END,
                        activated_at = CASE
                            WHEN phase = 'IMPORTED' THEN GREATEST(imported_at, LOCALTIMESTAMP)
                            ELSE activated_at
                        END,
                        updated_at = updated_at + interval '1 millisecond'
                    WHERE id = 'offer'$mutation$
            )
        ) AS probes(table_name, mutation_sql)
    LOOP
        EXECUTE format(
            'SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY to_jsonb(row_value)::text), ''[]''::jsonb) FROM platform.%I row_value',
            probe.table_name
        ) INTO before_rows;
        SELECT current_semantic_fingerprint INTO before_persisted
        FROM platform.service_identity WHERE id = 'singleton';
        before_recomputed := platform.current_semantic_fingerprint();
        IF before_persisted IS DISTINCT FROM before_recomputed THEN
            RAISE EXCEPTION 'Platform fingerprint drifted before the % partial probe', probe.table_name;
        END IF;

        BEGIN
            EXECUTE probe.mutation_sql;
            SET CONSTRAINTS ALL IMMEDIATE;
            RAISE EXCEPTION USING
                ERRCODE = 'P0001',
                MESSAGE = format('unguarded %s mutation was accepted', probe.table_name);
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS
                actual_state = RETURNED_SQLSTATE,
                actual_constraint = CONSTRAINT_NAME;
            IF actual_state <> '23514'
                OR actual_constraint <> 'platform_current_semantic_fingerprint_guard' THEN
                RAISE EXCEPTION
                    'unguarded % mutation failed with SQLSTATE % / constraint %, expected 23514 / platform_current_semantic_fingerprint_guard',
                    probe.table_name, actual_state, COALESCE(actual_constraint, '<null>');
            END IF;
        END;
        SET CONSTRAINTS ALL DEFERRED;

        EXECUTE format(
            'SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY to_jsonb(row_value)::text), ''[]''::jsonb) FROM platform.%I row_value',
            probe.table_name
        ) INTO after_rows;
        SELECT current_semantic_fingerprint INTO after_persisted
        FROM platform.service_identity WHERE id = 'singleton';
        after_recomputed := platform.current_semantic_fingerprint();
        IF after_rows IS DISTINCT FROM before_rows
            OR after_persisted IS DISTINCT FROM before_persisted
            OR after_recomputed IS DISTINCT FROM before_recomputed THEN
            RAISE EXCEPTION 'rejected % partial probe left database drift', probe.table_name;
        END IF;

        BEGIN
            EXECUTE probe.mutation_sql;
            PERFORM platform.refresh_current_semantic_fingerprint(
                platform.current_semantic_fingerprint()
            );
            SET CONSTRAINTS ALL IMMEDIATE;
            SELECT current_semantic_fingerprint INTO after_persisted
            FROM platform.service_identity WHERE id = 'singleton';
            after_recomputed := platform.current_semantic_fingerprint();
            IF after_persisted IS DISTINCT FROM after_recomputed THEN
                RAISE EXCEPTION 'coherent % mutation left a stale semantic fingerprint', probe.table_name;
            END IF;
            RAISE EXCEPTION USING
                ERRCODE = 'P0002',
                MESSAGE = 'rollback coherent semantic guard probe';
        EXCEPTION WHEN SQLSTATE 'P0002' THEN
            GET STACKED DIAGNOSTICS rollback_marker = MESSAGE_TEXT;
            IF rollback_marker <> 'rollback coherent semantic guard probe' THEN
                RAISE EXCEPTION 'unexpected coherent-probe rollback marker';
            END IF;
        END;
        SET CONSTRAINTS ALL DEFERRED;

        EXECUTE format(
            'SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY to_jsonb(row_value)::text), ''[]''::jsonb) FROM platform.%I row_value',
            probe.table_name
        ) INTO after_rows;
        SELECT current_semantic_fingerprint INTO after_persisted
        FROM platform.service_identity WHERE id = 'singleton';
        after_recomputed := platform.current_semantic_fingerprint();
        IF after_rows IS DISTINCT FROM before_rows
            OR after_persisted IS DISTINCT FROM before_persisted
            OR after_recomputed IS DISTINCT FROM before_recomputed THEN
            RAISE EXCEPTION 'coherent % probe rollback left database drift', probe.table_name;
        END IF;
    END LOOP;
END
$semantic_guard$;
SQL

	after_probes="$(platform_restore_query winwidget_platform \
		"SELECT current_semantic_fingerprint FROM platform.service_identity WHERE id = 'singleton';")"
	[[ "$after_probes" == "$persisted" ]] ||
		platform_restore_fail 'Platform semantic fingerprint probes were not rolled back' || return 1
}

platform_restore_run() {
	platform_restore_validate_inputs
	platform_restore_assert_local_docker
	platform_restore_prepare_node_runtime
	local run_id="${revision:0:12}-$$" attempt health
	container="winwidget-platform-restore-$run_id"
	volume="winwidget-platform-restore-$run_id-data"
	[[ -z "$(platform_restore_docker ps -aq --filter "name=^/${container}$")" &&
		-z "$(platform_restore_docker volume ls -q --filter "name=^${volume}$")" ]] ||
		platform_restore_fail 'isolated rehearsal resource already exists' || return 1
	work_root="$(mktemp -d "/tmp/winwidget-platform-restore-$run_id.XXXXXX")"
	trap platform_restore_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	admin_password="$(openssl rand -hex 24)"
	platform_restore_docker volume create --label com.winwidget.owner=platform \
		--label com.winwidget.purpose=backup-restore-rehearsal "$volume" >/dev/null
	created_volume='true'
	POSTGRES_PASSWORD="$admin_password" platform_restore_docker run --detach --name "$container" \
		--label com.winwidget.owner=platform \
		--label com.winwidget.purpose=backup-restore-rehearsal \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--env POSTGRES_PASSWORD --env POSTGRES_USER=postgres \
		--env POSTGRES_DB=winwidget_platform \
		--env 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		--env PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd 'pg_isready --username postgres --dbname winwidget_platform' \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$PLATFORM_RESTORE_POSTGRES_IMAGE" >/dev/null
	created_container='true'
	for ((attempt = 1; attempt <= 60; attempt++)); do
		health="$(platform_restore_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
		[[ "$health" == healthy ]] && break
		[[ "$health" == unhealthy ]] && return 1
		sleep 2
	done
	[[ "$health" == healthy ]] || platform_restore_fail 'restore PostgreSQL is not healthy' || return 1
	PGPASSWORD="$admin_password" platform_restore_docker run --rm --network "container:$container" \
		--mount "type=bind,source=$(dirname -- "$dump_file"),target=/input,readonly" \
		--env PGPASSWORD --entrypoint pg_restore "$PLATFORM_RESTORE_POSTGRES_IMAGE" \
		--exit-on-error --single-transaction --no-owner --no-acl \
		--host 127.0.0.1 --username postgres --dbname winwidget_platform \
		"/input/$(basename -- "$dump_file")" >/dev/null

	local restored_system restored_database_id table_count migration_count
	local identity_phase offer_phase source_high_watermark site_count legal_count home_count outbox_count
	local table_manifest index_manifest migration_manifest expected_migration_checksum
	local repeat_dump repeat_list repeat_list_sha256
	restored_system="$(platform_restore_query postgres 'SELECT (pg_control_system()).system_identifier;')"
	[[ "$restored_system" =~ ^[1-9][0-9]*$ && "$restored_system" != "$source_system_identifier" ]] ||
		platform_restore_fail 'restore cluster is not physically independent' || return 1
	restored_database_id="$(platform_restore_query winwidget_platform \
		"SELECT database_id::text FROM platform.service_identity WHERE service_name = 'platform-service';")"
	[[ "$restored_database_id" == "$database_id" ]] ||
		platform_restore_fail 'restored Platform database ID differs from lifecycle marker' || return 1
	table_count="$(platform_restore_query winwidget_platform \
		"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'platform' AND table_type = 'BASE TABLE';")"
	migration_count="$(platform_restore_query winwidget_platform \
		'SELECT count(*) FROM platform._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"
	identity_phase="$(platform_restore_query winwidget_platform \
		"SELECT phase::text FROM platform.service_identity WHERE id = 'singleton';")"
	offer_phase="$(platform_restore_query winwidget_platform \
		"SELECT phase::text FROM platform.billing_offer_producer_state WHERE id = 'offer';")"
	source_high_watermark="$(platform_restore_query winwidget_platform \
		"SELECT source_high_watermark::text FROM platform.service_identity WHERE id = 'singleton';")"
	site_count="$(platform_restore_query winwidget_platform 'SELECT count(*) FROM platform.site_settings;')"
	legal_count="$(platform_restore_query winwidget_platform 'SELECT count(*) FROM platform.legal_pages;')"
	home_count="$(platform_restore_query winwidget_platform 'SELECT count(*) FROM platform.home_page_content;')"
	outbox_count="$(platform_restore_query winwidget_platform 'SELECT count(*) FROM platform.outbox_events;')"
	table_manifest="$(platform_restore_query winwidget_platform \
		"SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'platform' AND table_type = 'BASE TABLE';")"
	index_manifest="$(platform_restore_query winwidget_platform \
		"SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'platform';")"
	expected_migration_checksum="$(platform_restore_sha256 \
		"$PLATFORM_RESTORE_ROOT/apps/platform/prisma/migrations/20260823000000_init_platform/migration.sql")"
	migration_manifest="$(platform_restore_query winwidget_platform \
		"SELECT migration_name || '|' || checksum FROM platform._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;")"
	[[ "$table_count" == 8 && "$migration_count" == 1 &&
		"$site_count" == 1 && "$legal_count" == 4 && "$home_count" == 1 &&
		"$outbox_count" == 0 &&
		"$table_manifest" == '_prisma_migrations,billing_offer_producer_state,home_page_content,legal_pages,outbox_events,service_identity,site_settings,source_sequences' &&
		"$index_manifest" == '_prisma_migrations_pkey,billing_offer_producer_state_pkey,home_page_content_pkey,legal_pages_pkey,outbox_events_deduplication_key_key,outbox_events_event_id_key,outbox_events_pkey,outbox_events_retention_idx,outbox_events_status_available_at_idx,service_identity_pkey,site_settings_pkey,source_sequences_pkey' &&
		"$migration_manifest" == "20260823000000_init_platform|$expected_migration_checksum" ]] ||
		platform_restore_fail 'restored Platform anchors are incomplete' || return 1
	case "$phase" in
	imported) [[ "$identity_phase|$offer_phase" == 'SHADOW|IMPORTED' ]] ;;
	active) [[ "$identity_phase|$offer_phase" == 'ACTIVE|ACTIVE' ]] ;;
	esac || platform_restore_fail 'restored Platform ownership phase is inconsistent' || return 1
	[[ "$source_high_watermark" =~ ^[1-9][0-9]*$ ]] ||
		platform_restore_fail 'restored Platform source high-watermark is not positive' || return 1
	platform_restore_assert_positive_high_watermark_constraint
	platform_restore_assert_semantic_guard_catalog
	platform_restore_assert_current_semantic_fingerprint_contract
	repeat_dump="$work_root/platform-repeat.dump"
	PGPASSWORD="$admin_password" platform_restore_docker exec --env PGPASSWORD "$container" \
		pg_dump --host 127.0.0.1 --username postgres --dbname winwidget_platform \
		--format custom --compress=9 --no-owner --no-acl --schema platform \
		--file /tmp/platform-repeat.dump
	platform_restore_docker cp "$container:/tmp/platform-repeat.dump" "$repeat_dump"
	[[ -s "$repeat_dump" && "$(head -c 5 "$repeat_dump")" == PGDMP ]] ||
		platform_restore_fail 'repeat dump is not a valid PostgreSQL custom archive' || return 1
	repeat_list="$(platform_restore_docker run --rm --network none \
		--mount "type=bind,source=$repeat_dump,target=/repeat.dump,readonly" \
		--entrypoint pg_restore "$PLATFORM_RESTORE_POSTGRES_IMAGE" --list /repeat.dump)"
	[[ "$repeat_list" == *'TABLE DATA platform'* &&
		"$repeat_list" == *'TABLE platform service_identity'* ]] ||
		platform_restore_fail 'repeat dump catalog is incomplete' || return 1
	repeat_list_sha256="$(printf '%s\n' "$repeat_list" | platform_restore_sha256 /dev/stdin)"
	unset repeat_list
	[[ "$repeat_list_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1

	platform_restore_remove_resources ||
		platform_restore_fail 'isolated rehearsal resources were not removed before evidence' || return 1
	local evidence_parent evidence_name size
	evidence_parent="$(dirname -- "$evidence_file")"
	evidence_name="$(basename -- "$evidence_file")"
	size="$(wc -c <"$dump_file" | tr -d '[:space:]')"
	evidence_temporary="$(mktemp "$evidence_parent/.${evidence_name}.partial.XXXXXX")"
	chmod 600 "$evidence_temporary"
	if [[ "$(uname -s)" == Linux ]]; then
		chown 0:0 "$evidence_temporary"
	fi
	REVISION="$revision" PHASE="$phase" SHA256="$expected_sha256" SIZE="$size" \
		DATABASE_ID="$database_id" SOURCE_SYSTEM="$source_system_identifier" \
		RESTORED_SYSTEM="$restored_system" TABLE_COUNT="$table_count" \
		MIGRATION_COUNT="$migration_count" SITE_COUNT="$site_count" \
		LEGAL_COUNT="$legal_count" HOME_COUNT="$home_count" OUTBOX_COUNT="$outbox_count" \
		MIGRATION_CHECKSUM="$expected_migration_checksum" \
		CATALOG_SHA256="$(printf '%s\n%s\n' "$table_manifest" "$index_manifest" | platform_restore_sha256 /dev/stdin)" \
		REPEAT_LIST_SHA256="$repeat_list_sha256" \
		platform_restore_docker run --rm --interactive --pull never --network none --read-only \
			--cap-drop ALL --pids-limit 64 --cpus 1 --memory 256m --memory-swap 256m \
			--log-driver none --user 0:0 --security-opt no-new-privileges \
			--mount "type=bind,source=$evidence_temporary,target=/evidence.json" \
			--env REVISION --env PHASE --env SHA256 --env SIZE --env DATABASE_ID \
			--env SOURCE_SYSTEM --env RESTORED_SYSTEM --env TABLE_COUNT \
			--env MIGRATION_COUNT --env SITE_COUNT --env LEGAL_COUNT \
			--env HOME_COUNT --env OUTBOX_COUNT \
			--env MIGRATION_CHECKSUM --env CATALOG_SHA256 --env REPEAT_LIST_SHA256 \
			--entrypoint node "$node_image_id" \
			- /evidence.json <<'NODE'
const { closeSync, constants, fsyncSync, openSync, writeFileSync } = require('node:fs');
const evidence = {
  schemaVersion: 1,
  action: 'platform-actual-backup-restore-rehearsal',
  target: 'platform',
  status: 'passed',
  phase: process.env.PHASE,
  revision: process.env.REVISION,
  postgresMajor: 18,
  dump: { sha256: process.env.SHA256, sizeBytes: Number(process.env.SIZE) },
  identity: {
    databaseId: process.env.DATABASE_ID,
    sourceSystemIdentifier: process.env.SOURCE_SYSTEM,
    restoredSystemIdentifier: process.env.RESTORED_SYSTEM,
  },
  catalog: {
    migrationChecksum: process.env.MIGRATION_CHECKSUM,
    catalogSha256: process.env.CATALOG_SHA256,
    repeatArchiveListSha256: process.env.REPEAT_LIST_SHA256,
  },
  counts: {
    tables: Number(process.env.TABLE_COUNT),
    migrations: Number(process.env.MIGRATION_COUNT),
    siteSettings: Number(process.env.SITE_COUNT),
    legalPages: Number(process.env.LEGAL_COUNT),
    homePageContent: Number(process.env.HOME_COUNT),
    outboxEvents: Number(process.env.OUTBOX_COUNT),
  },
  checks: {
    immutableRevision: true,
    dumpShaStable: true,
    isolatedTarget: true,
    noHostPorts: true,
    distinctCluster: true,
    ownershipAnchors: true,
    positiveSourceHighWatermark: true,
    currentSemanticFingerprint: true,
    legitimateMutationRefreshAtomic: true,
    unrefreshedMutationDetectedByRecompute: true,
    outboxEmpty: true,
    migrationChecksumExact: true,
    catalogExact: true,
    repeatDumpReadable: true,
    resourcesRemovedBeforeEvidence: true,
    canonicalArtifactPaths: true,
    privateArtifactOwnership: true,
    noSymlinkArtifacts: true,
    fileAndParentFsync: true,
  },
  completedAt: new Date().toISOString(),
};
const descriptor = openSync(process.argv[2], constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
try {
  writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`, 'utf8');
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
NODE
	platform_restore_require_private_input_file "$evidence_temporary" || return 1
	platform_restore_require_private_output_path "$evidence_file" || return 1
	sync -f "$evidence_temporary"
	mv -- "$evidence_temporary" "$evidence_file"
	evidence_temporary=''
	platform_restore_require_private_input_file "$evidence_file" || return 1
	sync -f "$evidence_file"
	sync -f "$evidence_parent"
	printf 'platform_restore_rehearsal=passed\n'
	printf 'platform_restore_evidence=%s\n' "$evidence_file"
}

platform_restore_self_test() {
	local source
	source="$(declare -f platform_restore_validate_inputs platform_restore_run \
		platform_restore_private_metadata_allowed \
		platform_restore_require_private_directory platform_restore_require_private_input_file \
		platform_restore_require_private_output_path platform_restore_remove_resources \
		platform_restore_assert_positive_high_watermark_constraint \
		platform_restore_assert_semantic_guard_catalog \
		platform_restore_assert_current_semantic_fingerprint_contract platform_restore_cleanup)"
	[[ "$source" == *'PGDMP'* && "$source" == *'--no-owner --no-acl'* &&
		"$source" == *'--network "container:$container"'* &&
		"$source" == *'realpath --'* && "$source" == *'mktemp'* &&
		"$source" == *'sync -f "$evidence_temporary"'* &&
		"$source" == *'sync -f "$evidence_parent"'* &&
		"$source" == *'canonicalArtifactPaths'* &&
		"$source" == *'privateArtifactOwnership'* &&
		"$source" == *'noSymlinkArtifacts'* &&
		"$source" == *'fileAndParentFsync'* &&
		"$source" == *'platform.service_identity'* &&
		"$source" == *'service_identity_source_check'* &&
		"$source" == *'platform.refresh_current_semantic_fingerprint'* &&
		"$source" == *'SET CONSTRAINTS ALL IMMEDIATE'* &&
		"$source" == *'RETURNED_SQLSTATE'* &&
		"$source" == *'CONSTRAINT_NAME'* &&
		"$source" == *"actual_state <> '23514'"* &&
		"$source" == *"actual_constraint <> 'platform_current_semantic_fingerprint_guard'"* &&
		"$source" == *'trigger_entry.tgconstraint'* &&
		"$source" == *'AND tgdeferrable'* &&
		"$source" == *'AND tginitdeferred'* &&
		"$source" == *'rejected % partial probe left database drift'* &&
		"$source" == *'coherent % probe rollback left database drift'* &&
		"$source" == *'platform.billing_offer_producer_state'* &&
		"$source" == *'platform_restore_docker volume rm'* ]] || return 1
	platform_restore_path_self_test || return 1
	printf 'platform_backup_restore_rehearsal_self_test=passed\n'
}

if [[ "${1:-}" == --self-test ]]; then
	[[ $# -eq 1 ]] || exit 1
	platform_restore_self_test
	exit
fi

while (($#)); do
	case "$1" in
	--revision) revision="${2:-}"; shift 2 ;;
	--phase) phase="${2:-}"; shift 2 ;;
	--dump) dump_file="${2:-}"; shift 2 ;;
	--expected-sha256) expected_sha256="${2:-}"; shift 2 ;;
	--database-id) database_id="${2:-}"; shift 2 ;;
	--source-system-identifier) source_system_identifier="${2:-}"; shift 2 ;;
	--evidence-file) evidence_file="${2:-}"; shift 2 ;;
	--node-image-id) node_image_id="${2:-}"; shift 2 ;;
	-h | --help) platform_restore_usage; exit ;;
	*) platform_restore_usage >&2; exit 2 ;;
	esac
done

platform_restore_run
