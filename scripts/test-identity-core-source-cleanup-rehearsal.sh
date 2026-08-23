#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-$(cd -- "$SOURCE_ROOT/.." && pwd -P)}"
# shellcheck source=scripts/cleanup-identity-core-source-production.sh
source "$SOURCE_ROOT/scripts/cleanup-identity-core-source-production.sh"

readonly POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly MIGRATION_NAME='20260815000000_remove_legacy_identity_core_source'
RUN_ID="${CORE_CLEANUP_REHEARSAL_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
RESOURCE_PREFIX="winwidget-identity-core-cleanup-$RUN_ID"
CONTAINER="$RESOURCE_PREFIX-postgres"
VOLUME="$RESOURCE_PREFIX-data"
ADMIN_USER='winwidget_identity_cleanup_admin'
ADMIN_PASSWORD="$(openssl rand -hex 24)"
MIGRATION_PASSWORD="$(openssl rand -hex 24)"
TEMP_ROOT=''
TEMP_PARENT=''
CREATED_CONTAINER=false
CREATED_VOLUME=false

readonly OWNERSHIP_REVISION='1111111111111111111111111111111111111111'
readonly WRONG_OWNERSHIP_REVISION='3333333333333333333333333333333333333333'
readonly CLEANUP_REVISION='2222222222222222222222222222222222222222'
readonly ZERO_SHA256='0000000000000000000000000000000000000000000000000000000000000000'
readonly CORE_BACKUP_SHA256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly IDENTITY_BACKUP_SHA256='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly RESTORE_EVIDENCE_SHA256='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
readonly QUEUE_EVIDENCE_SHA256='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
readonly STOPPED_WRITERS_SHA256='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
readonly SOAK_EVIDENCE_SHA256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

readonly -a TARGET_TABLES=(
	User auth_identities telegram_notification_channels user_sessions
	verification_challenges identity_core_source_state
)
readonly -a TARGET_ENUMS=(
	Role UserStatus AuthIdentityType VerificationChallengeType
	VerificationChallengePurpose
)
readonly -a AUTH_SETTINGS_COLUMNS=(
	recaptcha_enabled google_auth_enabled yandex_auth_enabled github_auth_enabled
	vk_auth_enabled telegram_auth_enabled
)
readonly -a TARGET_FUNCTIONS=(
	'public.reporting_emit_user_projection(text,boolean)'
	'public.reporting_user_projection_trigger()'
	'public.reporting_auth_identity_projection_trigger()'
	'public.billing_emit_identity_projection(text,boolean)'
	'public.billing_identity_user_projection_trigger()'
	'public.billing_identity_auth_projection_trigger()'
	'public.billing_identity_telegram_projection_trigger()'
	'public.identity_core_source_is_open()'
	'public.lock_identity_core_source_open()'
	'public.reject_fenced_identity_core_source_write()'
	'public.reject_fenced_identity_auth_settings_write()'
	'public.fence_identity_core_source(text)'
	'public.unfence_identity_core_source(text)'
)
readonly -a TARGET_TRIGGERS=(
	'User:reporting_user_projection'
	'User:billing_identity_user_projection'
	'User:identity_core_source_write_fence'
	'auth_identities:reporting_auth_identity_projection'
	'auth_identities:billing_identity_auth_projection'
	'auth_identities:identity_core_source_write_fence'
	'telegram_notification_channels:billing_identity_telegram_projection'
	'telegram_notification_channels:identity_core_source_write_fence'
	'user_sessions:identity_core_source_write_fence'
	'verification_challenges:identity_core_source_write_fence'
	'site_settings:identity_core_auth_settings_write_fence'
)

fail() {
	printf 'identity_core_cleanup_rehearsal_error=%s\n' "$1" >&2
	exit 1
}

report_unexpected_error() {
	local line="$1" status="$2" frame
	printf 'identity_core_cleanup_rehearsal_unexpected_error_line=%s status=%s\n' \
		"$line" "$status" >&2
	for frame in 0 1 2 3; do
		caller "$frame" >&2 || break
	done
	return "$status"
}

trap 'report_unexpected_error "$LINENO" "$?"' ERR

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

stat_owner() {
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		stat -f '%u:%g' "$1"
	else
		stat -c '%u:%g' "$1"
	fi
}

stat_mode() {
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		stat -f '%Lp' "$1"
	else
		stat -c '%a' "$1"
	fi
}

cleanup() {
	local status=$? basename parent
	trap - EXIT INT TERM
	if [[ "$CREATED_CONTAINER" == 'true' ]]; then
		docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	fi
	if [[ "$CREATED_VOLUME" == 'true' ]]; then
		docker volume rm "$VOLUME" >/dev/null 2>&1 || true
	fi
	if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" ]]; then
		parent="$(dirname -- "$TEMP_ROOT")"
		basename="$(basename -- "$TEMP_ROOT")"
		if [[ "$parent" == "$TEMP_PARENT" &&
			"$basename" == "identity-core-cleanup-$RUN_ID."?????? ]]; then
			rm -rf -- "$TEMP_ROOT"
		else
			printf 'identity_core_cleanup_rehearsal_warning=unsafe_temp_cleanup_skipped\n' >&2
		fi
	fi
	exit "$status"
}

create_temp_root() {
	local owner
	[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$ ]] ||
		fail 'unsafe rehearsal run ID'
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		TEMP_PARENT="$SOURCE_ROOT"
	else
		TEMP_PARENT='/tmp'
	fi
	TEMP_ROOT="$(mktemp -d "$TEMP_PARENT/identity-core-cleanup-$RUN_ID.XXXXXX")"
	owner="$(stat_owner "$TEMP_ROOT")"
	[[ -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" &&
		"$owner" == "$(id -u):$(id -g)" &&
		"$(stat_mode "$TEMP_ROOT")" == '700' ]] ||
		fail 'unsafe rehearsal temporary directory'
}

assert_local_docker() {
	local context endpoint
	context="$(docker context show)" || fail 'Docker context is unavailable'
	endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')" ||
		fail 'Docker endpoint is unavailable'
	[[ "$endpoint" == unix://* && "$(docker info --format '{{.OSType}}')" == 'linux' ]] ||
		fail 'only a local Unix Docker Linux endpoint is allowed'
}

wait_for_postgres() {
	local attempt health
	for ((attempt = 1; attempt <= 60; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return 0
		[[ "$health" == 'unhealthy' ]] && return 1
		sleep 2
	done
	return 1
}

create_postgres() {
	[[ -z "$(docker ps -aq --filter "name=^/${CONTAINER}$")" ]] ||
		fail 'rehearsal container already exists'
	[[ -z "$(docker volume ls -q --filter "name=^${VOLUME}$")" ]] ||
		fail 'rehearsal volume already exists'
	docker volume create --label com.winwidget.owner=identity \
		--label com.winwidget.purpose=core-source-cleanup-rehearsal \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" "$VOLUME" >/dev/null
	CREATED_VOLUME=true
	docker run --detach --name "$CONTAINER" \
		--label com.winwidget.owner=identity \
		--label com.winwidget.purpose=core-source-cleanup-rehearsal \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		--publish 127.0.0.1::5432 \
		--mount "type=volume,source=$VOLUME,target=/var/lib/postgresql" \
		-e POSTGRES_DB=default_db -e "POSTGRES_USER=$ADMIN_USER" \
		-e "POSTGRES_PASSWORD=$ADMIN_PASSWORD" \
		-e 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd "pg_isready --username $ADMIN_USER --dbname default_db" \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$POSTGRES_IMAGE" >/dev/null
	CREATED_CONTAINER=true
	wait_for_postgres || fail 'PostgreSQL 18 did not become healthy'
}

query_database() {
	local database="$1" sql="$2"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" \
		psql --no-psqlrc --no-password --tuples-only --no-align \
			--set ON_ERROR_STOP=1 --username "$ADMIN_USER" --dbname "$database" \
			--command "$sql"
}

connection_url() {
	local port="$1" database="$2" user="$3" password="$4" options="${5:-}"
	REHEARSAL_BASE_URL="postgresql://$user:$password@127.0.0.1:$port/$database?schema=public&sslmode=disable" \
		REHEARSAL_OPTIONS="$options" node <<'NODE'
const url = new URL(process.env.REHEARSAL_BASE_URL);
if (process.env.REHEARSAL_OPTIONS) {
  url.searchParams.set('options', process.env.REHEARSAL_OPTIONS);
}
process.stdout.write(url.toString().replace(
  /([?&]options=)([^&#]*)/,
  (_, prefix, value) => `${prefix}${value.replace(/\+/g, '%20')}`,
));
NODE
}

copy_migrations_before_cleanup() {
	local destination="$1" directory name
	mkdir -p "$destination/migrations"
	cp "$SOURCE_ROOT/prisma/schema.prisma" "$destination/schema.prisma"
	for directory in "$SOURCE_ROOT"/prisma/migrations/*; do
		[[ -d "$directory" ]] || continue
		name="$(basename -- "$directory")"
		[[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] ||
			fail 'tracked migration directory name is invalid'
		[[ "$name" < "$MIGRATION_NAME" ]] || continue
		cp -R "$directory" "$destination/migrations/"
	done
}

identity_guc_options() {
	[[ $# -eq 9 ]] || return 1
	printf '%s' \
		"-c winwidget.identity_core_source_cleanup=production-destructive-approved" \
		" -c winwidget.identity_ownership_phase=complete" \
		" -c winwidget.identity_ownership_revision=$1" \
		" -c winwidget.identity_cleanup_revision=$2" \
		" -c winwidget.identity_cleanup_migration_sha256=$3" \
		" -c winwidget.identity_core_backup_sha256=$4" \
		" -c winwidget.identity_backup_sha256=$5" \
		" -c winwidget.identity_restore_evidence_sha256=$6" \
		" -c winwidget.identity_queue_drain_evidence_sha256=$7" \
		" -c winwidget.identity_stopped_writers_evidence_sha256=$8" \
		" -c winwidget.identity_soak_evidence_sha256=$9"
}

apply_cleanup_sql() {
	local options="$1"
	local -a environment=(-e "PGPASSWORD=$MIGRATION_PASSWORD")
	[[ -z "$options" ]] || environment+=(-e "PGOPTIONS=$options")
	docker exec --interactive "${environment[@]}" "$CONTAINER" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
			--username gen_user --dbname default_db \
		<"$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql"
}

target_table_count() {
	local database="$1"
	query_database "$database" "
SELECT count(*) FROM unnest(ARRAY[
  'User','auth_identities','telegram_notification_channels','user_sessions',
  'verification_challenges','identity_core_source_state'
]) AS target(name)
WHERE to_regclass(format('public.%I', target.name)) IS NOT NULL;
"
}

target_enum_count() {
	local database="$1"
	query_database "$database" "
SELECT count(*) FROM unnest(ARRAY[
  'Role','UserStatus','AuthIdentityType','VerificationChallengeType',
  'VerificationChallengePurpose'
]) AS target(name)
WHERE to_regtype(format('public.%I', target.name)) IS NOT NULL;
"
}

auth_settings_column_count() {
	local database="$1"
	query_database "$database" "
SELECT count(*)
FROM pg_catalog.pg_attribute attribute
WHERE attribute.attrelid='public.site_settings'::regclass
  AND attribute.attname=ANY(ARRAY[
    'recaptcha_enabled','google_auth_enabled','yandex_auth_enabled',
    'github_auth_enabled','vk_auth_enabled','telegram_auth_enabled'
  ])
  AND attribute.attnum > 0 AND NOT attribute.attisdropped;
"
}

target_function_count() {
	local database="$1"
	query_database "$database" "
SELECT count(*) FROM unnest(ARRAY[
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
]) AS target(signature)
WHERE to_regprocedure(target.signature) IS NOT NULL;
"
}

target_trigger_count() {
	local database="$1"
	query_database "$database" "
SELECT count(*)
FROM pg_catalog.pg_trigger trigger
JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND NOT trigger.tgisinternal
  AND format('%s:%s', relation.relname, trigger.tgname)=ANY(ARRAY[
    'User:reporting_user_projection',
    'User:billing_identity_user_projection',
    'User:identity_core_source_write_fence',
    'auth_identities:reporting_auth_identity_projection',
    'auth_identities:billing_identity_auth_projection',
    'auth_identities:identity_core_source_write_fence',
    'telegram_notification_channels:billing_identity_telegram_projection',
    'telegram_notification_channels:identity_core_source_write_fence',
    'user_sessions:identity_core_source_write_fence',
    'verification_challenges:identity_core_source_write_fence',
    'site_settings:identity_core_auth_settings_write_fence'
  ]);
"
}

assert_pre_cleanup_contract() {
	[[ "$(target_table_count default_db)" == '6' ]] || fail 'pre-cleanup table set is not exact'
	[[ "$(target_enum_count default_db)" == '5' ]] || fail 'pre-cleanup enum set is not exact'
	[[ "$(auth_settings_column_count default_db)" == '6' ]] || fail 'pre-cleanup auth settings are not exact'
	[[ "$(target_function_count default_db)" == '13' ]] || fail 'pre-cleanup function set is incomplete'
	[[ "$(target_trigger_count default_db)" == '11' ]] || fail 'pre-cleanup trigger set is incomplete'
	[[ "$(query_database default_db "
SELECT count(*)
FROM pg_catalog.pg_proc routine
JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace
WHERE namespace.nspname='public' AND (
  starts_with(routine.proname,'billing_identity_')
  OR (starts_with(routine.proname,'reporting_') AND position('identity' IN routine.proname)>0)
  OR starts_with(routine.proname,'identity_core_')
  OR starts_with(routine.proname,'reject_fenced_identity_')
  OR starts_with(routine.proname,'lock_identity_core_source')
  OR starts_with(routine.proname,'fence_identity_core_source')
  OR starts_with(routine.proname,'unfence_identity_core_source')
  OR starts_with(routine.proname,'reporting_emit_user_projection')
  OR starts_with(routine.proname,'reporting_user_projection')
  OR starts_with(routine.proname,'billing_emit_identity_projection')
);
")" == '13' ]] || fail 'pre-cleanup function boundary contains unexpected functions'
	[[ "$(query_database default_db "
SELECT count(*)
FROM pg_catalog.pg_trigger trigger
JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND NOT trigger.tgisinternal AND (
  relation.relname=ANY(ARRAY[
    'User','auth_identities','telegram_notification_channels','user_sessions',
    'verification_challenges','identity_core_source_state'
  ]) OR (relation.relname='site_settings' AND trigger.tgname LIKE 'identity_core_%')
);
")" == '11' ]] || fail 'pre-cleanup trigger boundary contains unexpected triggers'
}

pre_cleanup_fingerprint() {
	local migration_sha="$1"
	query_database default_db "
SELECT md5(jsonb_build_object(
  'users',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb) FROM public.\"User\" value),
  'identities',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb) FROM public.auth_identities value),
  'telegram',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb) FROM public.telegram_notification_channels value),
  'sessions',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb) FROM public.user_sessions value),
  'challenges',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb) FROM public.verification_challenges value),
  'settings',(SELECT to_jsonb(value) FROM public.site_settings value WHERE id='singleton'),
  'identity_state',(SELECT to_jsonb(value) FROM public.identity_core_source_state value WHERE id='singleton'),
  'reporting_state',(SELECT to_jsonb(value) FROM public.reporting_producer_state value WHERE id='singleton'),
  'billing_state',(SELECT to_jsonb(value) FROM public.billing_core_state value WHERE id='singleton'),
  'outbox',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb) FROM public.outbox_events value),
  'ledger',(SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value.id),'[]'::jsonb)
    FROM public.\"_prisma_migrations\" value
    WHERE migration_name='$MIGRATION_NAME' AND checksum='$migration_sha')
)::text);
"
}

assert_exact_unfinished_ledger() {
	local migration_sha="$1"
	[[ "$(query_database default_db "
SELECT count(*) FROM public.\"_prisma_migrations\"
WHERE migration_name='$MIGRATION_NAME' AND checksum='$migration_sha'
  AND finished_at IS NULL AND rolled_back_at IS NULL;
")" == '1' ]] || fail 'exact unfinished Identity cleanup ledger is missing'
}

resume_ledger_state() {
	local database="$1" migration_sha="$2"
	query_database "$database" "
WITH target AS (
  SELECT checksum,finished_at,rolled_back_at,logs
  FROM public.\"_prisma_migrations\"
  WHERE migration_name='$MIGRATION_NAME'
), classified AS (
  SELECT
    count(*) FILTER (WHERE checksum <> '$migration_sha') AS mismatched,
    count(*) FILTER (WHERE checksum = '$migration_sha'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
    count(*) FILTER (WHERE checksum = '$migration_sha'
      AND finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished,
    count(*) FILTER (WHERE checksum = '$migration_sha'
      AND finished_at IS NULL AND rolled_back_at IS NOT NULL) AS rolled_back,
    count(*) FILTER (WHERE checksum = '$migration_sha') AS exact
  FROM target
)
SELECT CASE
  WHEN mismatched=0 AND applied=1 AND unfinished=0
    AND applied+unfinished+rolled_back=exact
  THEN 'applied'
  ELSE 'unsafe'
END
FROM classified;
"
}

assert_rejected_unchanged() {
	local name="$1" options="$2" fingerprint="$3" migration_sha="$4"
	if apply_cleanup_sql "$options" >/dev/null 2>&1; then
		fail "$name evidence unexpectedly applied the cleanup migration"
	fi
	assert_pre_cleanup_contract
	assert_exact_unfinished_ledger "$migration_sha"
	[[ "$(pre_cleanup_fingerprint "$migration_sha")" == "$fingerprint" ]] ||
		fail "$name evidence changed the pre-cleanup database"
}

assert_post_cleanup_contract() {
	local database="$1" fixture_mode="$2" migration_sha="$3"
	[[ "$(target_table_count "$database")" == '0' ]] || fail 'a legacy Identity table remains'
	[[ "$(target_enum_count "$database")" == '0' ]] || fail 'a legacy Identity enum remains'
	[[ "$(auth_settings_column_count "$database")" == '0' ]] || fail 'a legacy Identity auth setting remains'
	[[ "$(target_function_count "$database")" == '0' ]] || fail 'a legacy Identity/Reporting/Billing function remains'
	[[ "$(target_trigger_count "$database")" == '0' ]] || fail 'a legacy Identity/Reporting/Billing trigger remains'
	[[ "$(query_database "$database" "
SELECT count(*) FROM unnest(ARRAY[
  'site_settings','telegram_bot_settings','legal_pages','notes','admin_event_logs',
  'outbox_events','reporting_producer_state','billing_core_state'
]) AS required(name)
WHERE to_regclass(format('public.%I', required.name)) IS NOT NULL;
")" == '8' ]] || fail 'a retained Core relation is missing'
	[[ "$(query_database "$database" "
SELECT count(*) FROM unnest(ARRAY[
  'public.reporting_producers_enabled()',
  'public.reporting_iso_timestamp(timestamp without time zone)',
  'public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)',
  'public.reporting_settings_projection_trigger()',
  'public.billing_core_state_transition_guard()',
  'public.billing_core_source_producers_enabled()',
  'public.billing_core_ownership_active()',
  'public.billing_iso_timestamp(timestamp without time zone)',
  'public.billing_record_source_event(text,text,text,text,jsonb,boolean)',
  'public.billing_notification_routing_projection_trigger()',
  'public.billing_offer_projection_trigger()'
]) AS required(signature)
WHERE to_regprocedure(required.signature) IS NOT NULL;
")" == '11' ]] || fail 'a retained Core producer function is missing'
	[[ "$(query_database "$database" "
SELECT count(*)
FROM pg_catalog.pg_trigger trigger
JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE namespace.nspname='public' AND NOT trigger.tgisinternal
  AND format('%s:%s',relation.relname,trigger.tgname)=ANY(ARRAY[
    'telegram_bot_settings:reporting_settings_projection',
    'billing_core_state:billing_core_state_transition_guard',
    'telegram_bot_settings:billing_notification_routing_projection',
    'legal_pages:billing_offer_projection'
  ]);
")" == '4' ]] || fail 'a retained Core producer trigger is missing'
	[[ "$(query_database "$database" "
SELECT count(*) FROM public.\"_prisma_migrations\"
WHERE migration_name='$MIGRATION_NAME' AND checksum='$migration_sha'
  AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
")" == '1' ]] || fail 'exact applied Identity cleanup ledger is missing'
	[[ "$(resume_ledger_state "$database" "$migration_sha")" == 'applied' ]] ||
		fail 'Identity cleanup resume ledger is not exact'
	if [[ "$fixture_mode" == 'populated' ]]; then
		[[ "$(query_database "$database" "
SELECT count(*) FROM public.site_settings
WHERE id='singleton' AND banner_enabled AND banner_text='identity cleanup retained'
  AND snowflake_enabled;
")" == '1' ]] || fail 'cleanup changed retained site settings data'
		[[ "$(query_database "$database" "
SELECT
  (SELECT count(*) FROM public.legal_pages WHERE slug='identity-cleanup-retained' AND content='retained')
  + (SELECT count(*) FROM public.notes WHERE id='identity-cleanup-retained' AND text='retained' AND NOT done)
  + (SELECT count(*) FROM public.outbox_events WHERE id='77777777-7777-4777-8777-777777777777'
      AND event_type='core.rehearsal.retained.v1' AND status='PUBLISHED'::public.\"OutboxEventStatus\");
")" == '3' ]] || fail 'cleanup changed retained platform fixture data'
		[[ "$(query_database "$database" "
SELECT count(*) FROM public.reporting_producer_state
WHERE id='singleton' AND enabled AND daily_summary_owner='REPORTING'
  AND daily_summary_switch_generation=1 AND daily_summary_switched_at IS NOT NULL;
")" == '1' ]] || fail 'cleanup changed Reporting ownership state'
		[[ "$(query_database "$database" "
SELECT count(*) FROM public.billing_core_state
WHERE id='singleton' AND ownership='BILLING'::public.\"BillingCoreOwnership\"
  AND NOT source_producers_enabled AND NOT legacy_routes_enabled
  AND NOT scheduler_enabled AND NOT legacy_consumer_enabled
  AND projection_consumer_enabled AND generation=2
  AND prepared_revision=ownership_revision AND activated_at IS NOT NULL;
")" == '1' ]] || fail 'cleanup changed Billing ownership state'
	fi
}

seed_production_boundary() {
	local migration_sha="$1"
	query_database default_db "
DO \$\$
BEGIN
  CREATE ROLE gen_user LOGIN PASSWORD '$MIGRATION_PASSWORD'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE winwidget_api_runtime NOLOGIN;
  CREATE ROLE winwidget_maintenance NOLOGIN;
  CREATE ROLE winwidget_backup NOLOGIN;
END
\$\$;
ALTER SCHEMA public OWNER TO gen_user;
DO \$\$
DECLARE object_record RECORD;
BEGIN
  FOR object_record IN
    SELECT namespace.nspname, relation.relname, relation.relkind
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','S')
  LOOP
    IF object_record.relkind='S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO gen_user',object_record.nspname,object_record.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO gen_user',object_record.nspname,object_record.relname);
    END IF;
  END LOOP;
  FOR object_record IN
    SELECT namespace.nspname, type_definition.typname
    FROM pg_catalog.pg_type type_definition
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type_definition.typnamespace
    WHERE namespace.nspname='public' AND type_definition.typtype='e'
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO gen_user',object_record.nspname,object_record.typname);
  END LOOP;
  FOR object_record IN
    SELECT routine.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname='public' AND routine.prokind='f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO gen_user',object_record.signature);
  END LOOP;
END
\$\$;
UPDATE public.reporting_producer_state
SET enabled=TRUE, activated_at=CURRENT_TIMESTAMP,
    daily_summary_owner='REPORTING', daily_summary_switch_generation=1,
    daily_summary_switched_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
WHERE id='singleton';
INSERT INTO public.site_settings
  (id,banner_enabled,banner_text,snowflake_enabled,recaptcha_enabled,
   google_auth_enabled,yandex_auth_enabled,github_auth_enabled,vk_auth_enabled,
   telegram_auth_enabled,updated_at)
VALUES
  ('singleton',TRUE,'identity cleanup retained',TRUE,FALSE,TRUE,FALSE,TRUE,TRUE,FALSE,CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE SET
  banner_enabled=EXCLUDED.banner_enabled,banner_text=EXCLUDED.banner_text,
  snowflake_enabled=EXCLUDED.snowflake_enabled,recaptcha_enabled=EXCLUDED.recaptcha_enabled,
  google_auth_enabled=EXCLUDED.google_auth_enabled,yandex_auth_enabled=EXCLUDED.yandex_auth_enabled,
  github_auth_enabled=EXCLUDED.github_auth_enabled,vk_auth_enabled=EXCLUDED.vk_auth_enabled,
  telegram_auth_enabled=EXCLUDED.telegram_auth_enabled,updated_at=CURRENT_TIMESTAMP;
INSERT INTO public.legal_pages (slug,content,updated_at)
VALUES ('identity-cleanup-retained','retained',CURRENT_TIMESTAMP);
INSERT INTO public.notes (id,text,done,updated_at)
VALUES ('identity-cleanup-retained','retained',FALSE,CURRENT_TIMESTAMP);
INSERT INTO public.\"User\" (id,name,password,updated_at)
VALUES ('identity-cleanup-user','Identity Rehearsal','not-a-real-password',CURRENT_TIMESTAMP);
INSERT INTO public.auth_identities (id,user_id,type,value,verified_at,updated_at)
VALUES ('identity-cleanup-auth','identity-cleanup-user','EMAIL'::public.\"AuthIdentityType\",
  'identity-cleanup@example.test',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO public.telegram_notification_channels
  (id,user_id,chat_id,telegram_user_id,username,updated_at)
VALUES ('identity-cleanup-telegram','identity-cleanup-user','100001','200001',
  'identity_cleanup',CURRENT_TIMESTAMP);
INSERT INTO public.user_sessions
  (id,user_id,refresh_token_hash,user_agent,ip_address,expires_at)
VALUES ('identity-cleanup-session','identity-cleanup-user','not-a-real-refresh-hash',
  'rehearsal','127.0.0.1',CURRENT_TIMESTAMP + INTERVAL '1 day');
INSERT INTO public.verification_challenges
  (id,user_id,type,purpose,value,code_hash,expires_at,updated_at)
VALUES ('identity-cleanup-challenge','identity-cleanup-user',
  'EMAIL'::public.\"VerificationChallengeType\",
  'REGISTER'::public.\"VerificationChallengePurpose\",'identity-cleanup@example.test',
  'not-a-real-code-hash',CURRENT_TIMESTAMP + INTERVAL '10 minutes',CURRENT_TIMESTAMP);
UPDATE public.outbox_events
SET status='PUBLISHED'::public.\"OutboxEventStatus\",published_at=CURRENT_TIMESTAMP,
    locked_at=NULL,locked_by=NULL,updated_at=CURRENT_TIMESTAMP
WHERE event_type IN ('identity.user.changed.v1','billing.identity.changed.v1');
INSERT INTO public.outbox_events
  (id,event_type,routing_key,payload,status,published_at,updated_at)
VALUES ('77777777-7777-4777-8777-777777777777','core.rehearsal.retained.v1',
  'core.rehearsal.retained.v1','{\"retained\":true}'::jsonb,
  'PUBLISHED'::public.\"OutboxEventStatus\",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
UPDATE public.billing_core_state
SET ownership='BILLING'::public.\"BillingCoreOwnership\",
    source_producers_enabled=FALSE,legacy_routes_enabled=FALSE,
    scheduler_enabled=FALSE,legacy_consumer_enabled=FALSE,
    projection_consumer_enabled=TRUE,generation=2,
    prepared_revision='$OWNERSHIP_REVISION',ownership_revision='$OWNERSHIP_REVISION',
    activated_at=CURRENT_TIMESTAMP
WHERE id='singleton';
SELECT count(*) FROM public.fence_identity_core_source('$OWNERSHIP_REVISION');
" >/dev/null
	for relation in "${TARGET_TABLES[@]}"; do
		query_database default_db "
REVOKE ALL ON TABLE public.\"$relation\" FROM PUBLIC,winwidget_api_runtime,winwidget_maintenance,winwidget_backup;
GRANT SELECT ON TABLE public.\"$relation\" TO winwidget_backup;
" >/dev/null
	done
	query_database default_db "
INSERT INTO public.\"_prisma_migrations\"
  (id,checksum,migration_name,started_at,applied_steps_count)
VALUES ('99999999-9999-4999-8999-999999999999','$migration_sha',
  '$MIGRATION_NAME',CURRENT_TIMESTAMP,0);
REVOKE ALL ON TABLE public.\"_prisma_migrations\"
FROM PUBLIC,winwidget_api_runtime,winwidget_maintenance,winwidget_backup;
" >/dev/null
}

self_test() {
	local migration_file migration_sha base_url approved_url source
	migration_file="$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql"
	[[ -f "$migration_file" && ! -L "$migration_file" ]]
	migration_sha="$(sha256_file "$migration_file")"
	[[ "$migration_sha" =~ ^[0-9a-f]{64}$ ]]
	[[ "${#TARGET_TABLES[@]}" == '6' && "${#TARGET_ENUMS[@]}" == '5' &&
		"${#AUTH_SETTINGS_COLUMNS[@]}" == '6' && "${#TARGET_FUNCTIONS[@]}" == '13' &&
		"${#TARGET_TRIGGERS[@]}" == '11' ]]
	base_url='postgresql://self-test:password@127.0.0.1:5432/default_db?schema=public&options=-c%20existing.setting%3Dretained'
	approved_url="$(identity_cleanup_build_migration_url "$base_url" \
		"$OWNERSHIP_REVISION" "$CLEANUP_REVISION" "$migration_sha" \
		"$CORE_BACKUP_SHA256" "$IDENTITY_BACKUP_SHA256" "$RESTORE_EVIDENCE_SHA256" \
		"$QUEUE_EVIDENCE_SHA256" "$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256")"
	APPROVED_URL="$approved_url" node <<'NODE'
const url = new URL(process.env.APPROVED_URL);
const options = url.searchParams.get('options') || '';
const settings = [...options.matchAll(/(?:^|\s)-c\s+([^=\s]+)=([^\s]+)/g)];
const identity = settings.filter(match => match[1].startsWith('winwidget.identity_'));
if (settings.length !== 12 || identity.length !== 11 ||
    !settings.some(match => match[1] === 'existing.setting' && match[2] === 'retained') ||
    new Set(identity.map(match => match[1])).size !== 11) process.exit(1);
NODE
	! identity_cleanup_build_migration_url "$base_url" "$OWNERSHIP_REVISION" \
		"$OWNERSHIP_REVISION" "$migration_sha" "$CORE_BACKUP_SHA256" \
		"$IDENTITY_BACKUP_SHA256" "$RESTORE_EVIDENCE_SHA256" "$QUEUE_EVIDENCE_SHA256" \
		"$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256" >/dev/null 2>&1
	! identity_cleanup_build_migration_url "$base_url" "$OWNERSHIP_REVISION" \
		"$CLEANUP_REVISION" "$ZERO_SHA256" "$CORE_BACKUP_SHA256" \
		"$IDENTITY_BACKUP_SHA256" "$RESTORE_EVIDENCE_SHA256" "$QUEUE_EVIDENCE_SHA256" \
		"$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256" >/dev/null 2>&1
	for source in \
		winwidget.identity_core_source_cleanup winwidget.identity_ownership_phase \
		winwidget.identity_ownership_revision winwidget.identity_cleanup_revision \
		winwidget.identity_cleanup_migration_sha256 winwidget.identity_core_backup_sha256 \
		winwidget.identity_backup_sha256 winwidget.identity_restore_evidence_sha256 \
		winwidget.identity_queue_drain_evidence_sha256 \
		winwidget.identity_stopped_writers_evidence_sha256 winwidget.identity_soak_evidence_sha256; do
		grep -Fq -- "$source" "$migration_file"
	done
	source="$(declare -f rehearse_migration seed_production_boundary \
		identity_cleanup_source_state assert_rejected_unchanged \
		assert_post_cleanup_contract resume_ledger_state)"
	[[ "$source" == *'missing evidence'* && "$source" == *'wrong revision evidence'* &&
		"$source" == *'zero hash evidence'* && "$source" == *'equal revision evidence'* &&
		"$source" == *'Core runtime role unexpectedly read the Prisma migration ledger'* &&
		"$source" == *'DATABASE_MIGRATION_URL_PRODUCTION'* &&
		"$source" != *'process.env.DATABASE_URL_PRODUCTION'* &&
		"$source" == *'wrong-checksum resume ledger'* &&
		"$source" == *'duplicate-finished resume ledger'* &&
		"$source" == *'migrate resolve --rolled-back'* &&
		"$source" == *'pristine_bootstrap'* ]]
	printf 'identity_core_cleanup_rehearsal_self_test=passed\n'
}

rehearse_migration() {
	local port migrations_root migration_sha legacy_options admin_url migration_base_url
	local approved_url fingerprint wrong_options zero_options equal_options applied_fingerprint
	local applied_ledger_rows pristine_url pristine_ledger_rows source_state_env source_state
	printf 'identity_core_cleanup_rehearsal_phase=local_docker\n'
	assert_local_docker
	pnpm exec prisma --version >/dev/null 2>&1 ||
		fail 'Prisma CLI is unavailable; install the frozen root dependencies first'
	printf 'identity_core_cleanup_rehearsal_phase=temp_root\n'
	create_temp_root
	printf 'identity_core_cleanup_rehearsal_phase=postgres\n'
	create_postgres
	printf 'identity_core_cleanup_rehearsal_phase=seed\n'
	port="$(docker port "$CONTAINER" 5432/tcp | awk -F: 'END { print $NF }')"
	[[ "$port" =~ ^[0-9]+$ ]] || fail 'rehearsal PostgreSQL port is invalid'
	migrations_root="$TEMP_ROOT/prisma"
	copy_migrations_before_cleanup "$migrations_root"
	legacy_options='-c winwidget.campaigns_contract_cutover=production-destructive-approved -c winwidget.campaigns_forward_boundary=forward-only -c winwidget.campaigns_source_manifest_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -c winwidget.campaigns_telegram_audit_decision=completed -c winwidget.campaigns_telegram_audit_reference=identity-core-cleanup-rehearsal'
	admin_url="$(connection_url "$port" default_db "$ADMIN_USER" "$ADMIN_PASSWORD" "$legacy_options")"
	DATABASE_URL="$admin_url" pnpm exec prisma migrate deploy \
		--schema "$migrations_root/schema.prisma" >/dev/null
	[[ "$(query_database default_db "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name >= '$MIGRATION_NAME';")" == '0' ]] ||
		fail 'pre-cleanup migration prefix contains the target or a later migration'
	migration_sha="$(sha256_file "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql")"
	seed_production_boundary "$migration_sha"
	if query_database default_db '
SET ROLE winwidget_api_runtime;
SELECT count(*) FROM public."_prisma_migrations";
' >/dev/null 2>&1; then
		fail 'Core runtime role unexpectedly read the Prisma migration ledger'
	fi
	migration_base_url="$(connection_url "$port" default_db gen_user "$MIGRATION_PASSWORD" "$legacy_options")"
	source_state_env="$TEMP_ROOT/source-state.env"
	printf 'DATABASE_MIGRATION_URL_PRODUCTION=%s\nCORE_POSTGRES_IMAGE=%s\n' \
		"$migration_base_url" "$POSTGRES_IMAGE" >"$source_state_env"
	chmod 600 "$source_state_env"
	source_state="$(ENV_FILE="$source_state_env" EXPECTED_REVISION="$CLEANUP_REVISION" \
		IDENTITY_CORE_CLEANUP_MIGRATION="$MIGRATION_NAME" \
		IDENTITY_CORE_CLEANUP_MIGRATION_SHA256="$migration_sha" \
		identity_cleanup_source_state)" || fail 'migration-role source-state inspection failed before cleanup'
	[[ "$source_state" == 'present|failed' ]] ||
		fail 'migration-role source-state inspection misclassified the fenced source'
	cp -R "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME" "$migrations_root/migrations/"
	assert_pre_cleanup_contract
	assert_exact_unfinished_ledger "$migration_sha"
	[[ "$(query_database default_db "
SELECT count(*) FROM public.outbox_events
WHERE event_type IN ('identity.user.changed.v1','billing.identity.changed.v1')
  AND status <> 'PUBLISHED'::public.\"OutboxEventStatus\";
")" == '0' ]] || fail 'Identity producer Outbox is not drained'
	fingerprint="$(pre_cleanup_fingerprint "$migration_sha")"
	assert_rejected_unchanged 'missing evidence' '' "$fingerprint" "$migration_sha"
	wrong_options="$(identity_guc_options "$WRONG_OWNERSHIP_REVISION" "$CLEANUP_REVISION" \
		"$migration_sha" "$CORE_BACKUP_SHA256" "$IDENTITY_BACKUP_SHA256" \
		"$RESTORE_EVIDENCE_SHA256" "$QUEUE_EVIDENCE_SHA256" \
		"$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256")"
	assert_rejected_unchanged 'wrong revision evidence' "$wrong_options" "$fingerprint" "$migration_sha"
	zero_options="$(identity_guc_options "$OWNERSHIP_REVISION" "$CLEANUP_REVISION" \
		"$ZERO_SHA256" "$CORE_BACKUP_SHA256" "$IDENTITY_BACKUP_SHA256" \
		"$RESTORE_EVIDENCE_SHA256" "$QUEUE_EVIDENCE_SHA256" \
		"$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256")"
	assert_rejected_unchanged 'zero hash evidence' "$zero_options" "$fingerprint" "$migration_sha"
	equal_options="$(identity_guc_options "$OWNERSHIP_REVISION" "$OWNERSHIP_REVISION" \
		"$migration_sha" "$CORE_BACKUP_SHA256" "$IDENTITY_BACKUP_SHA256" \
		"$RESTORE_EVIDENCE_SHA256" "$QUEUE_EVIDENCE_SHA256" \
		"$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256")"
	assert_rejected_unchanged 'equal revision evidence' "$equal_options" "$fingerprint" "$migration_sha"
	DATABASE_URL="$migration_base_url" pnpm exec prisma migrate resolve \
		--rolled-back "$MIGRATION_NAME" --schema "$migrations_root/schema.prisma" >/dev/null
	[[ "$(query_database default_db "
SELECT count(*) FROM public.\"_prisma_migrations\"
WHERE migration_name='$MIGRATION_NAME' AND checksum='$migration_sha'
  AND finished_at IS NULL AND rolled_back_at IS NOT NULL;
")" == '1' ]] || fail 'failed Identity cleanup retry was not marked rolled back'
	approved_url="$(identity_cleanup_build_migration_url "$migration_base_url" \
		"$OWNERSHIP_REVISION" "$CLEANUP_REVISION" "$migration_sha" \
		"$CORE_BACKUP_SHA256" "$IDENTITY_BACKUP_SHA256" "$RESTORE_EVIDENCE_SHA256" \
		"$QUEUE_EVIDENCE_SHA256" "$STOPPED_WRITERS_SHA256" "$SOAK_EVIDENCE_SHA256")" ||
		fail 'could not build exact 11-GUC cleanup URL'
	DATABASE_URL="$approved_url" pnpm exec prisma migrate deploy \
		--schema "$migrations_root/schema.prisma" >/dev/null
	assert_post_cleanup_contract default_db populated "$migration_sha"
	source_state="$(ENV_FILE="$source_state_env" EXPECTED_REVISION="$CLEANUP_REVISION" \
		IDENTITY_CORE_CLEANUP_MIGRATION="$MIGRATION_NAME" \
		IDENTITY_CORE_CLEANUP_MIGRATION_SHA256="$migration_sha" \
		identity_cleanup_source_state)" || fail 'migration-role source-state inspection failed after cleanup'
	[[ "$source_state" == 'absent|applied' ]] ||
		fail 'migration-role source-state inspection misclassified the cleaned source'
	query_database default_db "
INSERT INTO public.\"_prisma_migrations\"
  (id,checksum,finished_at,migration_name,started_at,applied_steps_count)
VALUES ('88888888-8888-4888-8888-888888888888','$ZERO_SHA256',CURRENT_TIMESTAMP,
  '$MIGRATION_NAME',CURRENT_TIMESTAMP,1);
" >/dev/null
	[[ "$(resume_ledger_state default_db "$migration_sha")" == 'unsafe' ]] ||
		fail 'wrong-checksum resume ledger was accepted'
	query_database default_db "
UPDATE public.\"_prisma_migrations\" SET checksum='$migration_sha'
WHERE id='88888888-8888-4888-8888-888888888888';
" >/dev/null
	[[ "$(resume_ledger_state default_db "$migration_sha")" == 'unsafe' ]] ||
		fail 'duplicate-finished resume ledger was accepted'
	query_database default_db "
DELETE FROM public.\"_prisma_migrations\"
WHERE id='88888888-8888-4888-8888-888888888888';
" >/dev/null
	[[ "$(resume_ledger_state default_db "$migration_sha")" == 'applied' ]] ||
		fail 'exact resume ledger did not recover after removing drift'
	applied_fingerprint="$(query_database default_db "
SELECT md5(jsonb_build_object(
  'settings',(SELECT to_jsonb(value) FROM public.site_settings value WHERE id='singleton'),
  'reporting',(SELECT to_jsonb(value) FROM public.reporting_producer_state value WHERE id='singleton'),
  'billing',(SELECT to_jsonb(value) FROM public.billing_core_state value WHERE id='singleton'),
  'outbox',(SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id) FROM public.outbox_events value),
  'ledger',(SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id) FROM public.\"_prisma_migrations\" value
    WHERE migration_name='$MIGRATION_NAME')
)::text);
")"
	applied_ledger_rows="$(query_database default_db "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME';")"
	DATABASE_URL="$migration_base_url" pnpm exec prisma migrate deploy \
		--schema "$migrations_root/schema.prisma" >/dev/null
	assert_post_cleanup_contract default_db populated "$migration_sha"
	[[ "$(query_database default_db "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME';")" == "$applied_ledger_rows" &&
		"$(query_database default_db "
SELECT md5(jsonb_build_object(
  'settings',(SELECT to_jsonb(value) FROM public.site_settings value WHERE id='singleton'),
  'reporting',(SELECT to_jsonb(value) FROM public.reporting_producer_state value WHERE id='singleton'),
  'billing',(SELECT to_jsonb(value) FROM public.billing_core_state value WHERE id='singleton'),
  'outbox',(SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id) FROM public.outbox_events value),
  'ledger',(SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id) FROM public.\"_prisma_migrations\" value
    WHERE migration_name='$MIGRATION_NAME')
)::text);
")" == "$applied_fingerprint" ]] || fail 'applied migration retry was not idempotent'
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" \
		createdb --username "$ADMIN_USER" pristine_bootstrap
	pristine_url="$(connection_url "$port" pristine_bootstrap "$ADMIN_USER" "$ADMIN_PASSWORD" "$legacy_options")"
	DATABASE_URL="$pristine_url" pnpm exec prisma migrate deploy \
		--schema "$migrations_root/schema.prisma" >/dev/null
	assert_post_cleanup_contract pristine_bootstrap pristine "$migration_sha"
	pristine_ledger_rows="$(query_database pristine_bootstrap "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME';")"
	DATABASE_URL="$pristine_url" pnpm exec prisma migrate deploy \
		--schema "$migrations_root/schema.prisma" >/dev/null
	assert_post_cleanup_contract pristine_bootstrap pristine "$migration_sha"
	[[ "$(query_database pristine_bootstrap "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME';")" == "$pristine_ledger_rows" ]] ||
		fail 'pristine migration replay was not idempotent'
	printf 'identity_core_cleanup_production_migration=passed\n'
}

case "${1:-}" in
--self-test)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	self_test
	;;
--rehearsal)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	trap cleanup EXIT INT TERM
	rehearse_migration
	;;
*)
	printf 'Usage: test-identity-core-source-cleanup-rehearsal.sh --self-test|--rehearsal\n' >&2
	exit 64
	;;
esac
