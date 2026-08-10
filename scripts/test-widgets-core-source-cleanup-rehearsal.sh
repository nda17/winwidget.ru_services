#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/widgets-database-lifecycle.sh
source "$SOURCE_ROOT/scripts/widgets-database-lifecycle.sh"
POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
MIGRATION_NAME='20260810000000_remove_legacy_widgets_core_source'
RUN_ID="${CORE_CLEANUP_REHEARSAL_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
RESOURCE_PREFIX="winwidget-widgets-core-cleanup-$RUN_ID"
CONTAINER="$RESOURCE_PREFIX-postgres"
VOLUME="$RESOURCE_PREFIX-data"
ADMIN_USER='winwidget_cleanup_restore_admin'
ADMIN_PASSWORD="$(openssl rand -hex 24)"
TEMP_ROOT=''
CREATED_CONTAINER=false
CREATED_VOLUME=false
TARGET_TABLES=(
	widgets quizzes callbacks countdown_timers stop_offers online_consultants
	calculators leads quiz_leads callback_leads countdown_timer_leads
	stop_offer_leads online_consultant_leads calculator_leads
	widget_config_revisions widget_runtime_presence widget_runtime_daily_metrics
	widget_runtime_daily_step_metrics
)

fail() {
	echo "widgets_core_cleanup_rehearsal_error=$1" >&2
	exit 1
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

cleanup() {
	local exit_code=$?
	local temp_basename temp_parent
	trap - EXIT INT TERM
	if [[ "$CREATED_CONTAINER" == 'true' ]]; then
		docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	fi
	if [[ "$CREATED_VOLUME" == 'true' ]]; then
		docker volume rm "$VOLUME" >/dev/null 2>&1 || true
	fi
	if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" ]]; then
		temp_parent="$(dirname -- "$TEMP_ROOT")"
		temp_basename="$(basename -- "$TEMP_ROOT")"
		if [[ "$temp_parent" == '/tmp' &&
			"$temp_basename" == "widgets-core-cleanup-$RUN_ID."?????? ]]; then
			rm -rf -- "$TEMP_ROOT"
		else
			echo 'widgets_core_cleanup_rehearsal_warning=unsafe_temp_cleanup_skipped' >&2
		fi
	fi
	exit "$exit_code"
}

create_temp_root() {
	[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]] ||
		fail 'CORE_CLEANUP_REHEARSAL_RUN_ID is unsafe'
	TEMP_ROOT="$(mktemp -d "/tmp/widgets-core-cleanup-${RUN_ID}.XXXXXX")"
	[[ -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" &&
		"$(widgets_lifecycle_stat_owner "$TEMP_ROOT")" == "$(id -u):$(id -g)" &&
		"$(widgets_lifecycle_stat_mode "$TEMP_ROOT")" == '700' ]] ||
		fail 'rehearsal temporary directory is unsafe'
}

assert_local_docker() {
	local context endpoint
	context="$(docker context show)" || fail 'Docker context is unavailable'
	endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')" ||
		fail 'Docker endpoint is unavailable'
	[[ "$endpoint" == unix://* ]] || fail 'only a local Unix Docker endpoint is allowed'
	[[ "$(docker info --format '{{.OSType}}')" == 'linux' ]] || fail 'Docker Linux is required'
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

query() {
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" \
		psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
			--username "$ADMIN_USER" --dbname default_db --command "$1"
}

verify_dump() {
	local dump_file expected_sha source_system_identifier expected_state actual_sha
	local restore_system_identifier present_count migration_checksum migration_file redump
	dump_file="${CORE_CLEANUP_REHEARSAL_DUMP_FILE:-}"
	expected_sha="${CORE_CLEANUP_REHEARSAL_EXPECTED_SHA256:-}"
	source_system_identifier="${CORE_CLEANUP_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER:-}"
	expected_state="${CORE_CLEANUP_REHEARSAL_EXPECTED_SOURCE_STATE:-}"
	[[ "$dump_file" == /* && -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" ]] ||
		fail 'dump must be a non-empty absolute regular file'
	[[ "$expected_sha" =~ ^[0-9a-f]{64}$ && "$source_system_identifier" =~ ^[1-9][0-9]*$ &&
		"$expected_state" =~ ^(present|absent)$ ]] || fail 'dump verification inputs are invalid'
	actual_sha="$(sha256_file "$dump_file")"
	[[ "$actual_sha" == "$expected_sha" ]] || fail 'dump SHA-256 mismatch'
	assert_local_docker
	[[ -z "$(docker ps -aq --filter "name=^/${CONTAINER}$")" ]] || fail 'rehearsal container already exists'
	[[ -z "$(docker volume ls -q --filter "name=^${VOLUME}$")" ]] || fail 'rehearsal volume already exists'
	create_temp_root
	docker volume create \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=core-source-cleanup-restore \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		"$VOLUME" >/dev/null
	CREATED_VOLUME=true
	docker run --detach --name "$CONTAINER" \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=core-source-cleanup-restore \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		--mount "type=volume,source=$VOLUME,target=/var/lib/postgresql" \
		-e POSTGRES_DB=default_db -e "POSTGRES_USER=$ADMIN_USER" \
		-e "POSTGRES_PASSWORD=$ADMIN_PASSWORD" \
		-e 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd "pg_isready --username $ADMIN_USER --dbname default_db" \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$POSTGRES_IMAGE" >/dev/null
	CREATED_CONTAINER=true
	wait_for_postgres || fail 'restore PostgreSQL did not become healthy'
	restore_system_identifier="$(query 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$restore_system_identifier" =~ ^[1-9][0-9]*$ &&
		"$restore_system_identifier" != "$source_system_identifier" ]] ||
		fail 'restore cluster is not physically independent'
	query 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
	docker run --rm --network "container:$CONTAINER" \
		-e "PGPASSWORD=$ADMIN_PASSWORD" \
		--mount "type=bind,source=$(dirname "$dump_file"),target=/input,readonly" \
		"$POSTGRES_IMAGE" pg_restore --exit-on-error --single-transaction \
			--no-owner --no-acl --host 127.0.0.1 --username "$ADMIN_USER" \
			--dbname default_db "/input/$(basename "$dump_file")" >/dev/null
	present_count="$(query "
SELECT count(*) FROM unnest(ARRAY[
  'widgets','quizzes','callbacks','countdown_timers','stop_offers',
  'online_consultants','calculators','leads','quiz_leads','callback_leads',
  'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
  'calculator_leads','widget_config_revisions','widget_runtime_presence',
  'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
]) AS target(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;
")"
	if [[ "$expected_state" == 'present' ]]; then
		[[ "$present_count" == '18' ]] || fail 'pre-cleanup dump lost a legacy source relation'
	else
		[[ "$present_count" == '0' ]] || fail 'post-cleanup dump restored a legacy source relation'
		migration_file="$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql"
		migration_checksum="$(sha256_file "$migration_file")"
		[[ "$(query "
SELECT count(*) FROM public.\"_prisma_migrations\"
WHERE migration_name = '$MIGRATION_NAME'
  AND checksum = '$migration_checksum'
  AND finished_at IS NOT NULL
  AND rolled_back_at IS NULL;
")" == '1' ]] || fail 'post-cleanup dump lacks the exact applied migration ledger'
	fi
	redump="$TEMP_ROOT/redump.dump"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" \
		pg_dump --format=custom --no-owner --no-privileges --no-password \
			--username "$ADMIN_USER" --dbname default_db >"$redump"
	[[ -s "$redump" ]] || fail 'restored database could not be dumped again'
	pg_restore --list "$redump" >/dev/null 2>&1 ||
		docker run --rm --network none \
			--mount "type=bind,source=$TEMP_ROOT,target=/work,readonly" \
			"$POSTGRES_IMAGE" pg_restore --list /work/redump.dump >/dev/null
	printf 'core_cleanup_dump_restore_system_identifier=%s\n' "$restore_system_identifier"
	printf 'widgets_core_cleanup_dump_restore=passed\n'
}

self_test() {
	[[ "${#TARGET_TABLES[@]}" == '18' ]]
	[[ "$(printf '%s\n' "${TARGET_TABLES[@]}" | LC_ALL=C sort -u | wc -l | tr -d '[:space:]')" == '18' ]]
	[[ -f "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql" ]]
	[[ "$(sha256_file "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql")" =~ ^[0-9a-f]{64}$ ]]
	printf 'widgets_core_cleanup_rehearsal_self_test=passed\n'
}

rehearse_migration() {
	local port database_url approved_database_url bootstrap_url migrations_root
	local migration_directory marker_sha legacy_options present_count
	assert_local_docker
	[[ -z "$(docker ps -aq --filter "name=^/${CONTAINER}$")" ]] || fail 'rehearsal container already exists'
	[[ -z "$(docker volume ls -q --filter "name=^${VOLUME}$")" ]] || fail 'rehearsal volume already exists'
	create_temp_root
	docker volume create \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=core-source-cleanup-migration \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		"$VOLUME" >/dev/null
	CREATED_VOLUME=true
	docker run --detach --name "$CONTAINER" \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=core-source-cleanup-migration \
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
	wait_for_postgres || fail 'migration PostgreSQL did not become healthy'
	port="$(docker port "$CONTAINER" 5432/tcp | awk -F: 'END { print $NF }')"
	[[ "$port" =~ ^[0-9]+$ ]] || fail 'migration PostgreSQL port is invalid'
	legacy_options='-c%20winwidget.campaigns_contract_cutover%3Dproduction-destructive-approved%20-c%20winwidget.campaigns_forward_boundary%3Dforward-only%20-c%20winwidget.campaigns_source_manifest_sha256%3Dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb%20-c%20winwidget.campaigns_telegram_audit_decision%3Dcompleted%20-c%20winwidget.campaigns_telegram_audit_reference%3Dwidgets-core-cleanup-rehearsal'
	database_url="postgresql://$ADMIN_USER:$ADMIN_PASSWORD@127.0.0.1:$port/default_db?schema=public&sslmode=disable&options=$legacy_options"
	migrations_root="$TEMP_ROOT/prisma"
	mkdir "$migrations_root" "$migrations_root/migrations"
	cp "$SOURCE_ROOT/prisma/schema.prisma" "$migrations_root/schema.prisma"
	for migration_directory in "$SOURCE_ROOT"/prisma/migrations/*; do
		[[ -d "$migration_directory" ]] || continue
		[[ "$(basename -- "$migration_directory")" == "$MIGRATION_NAME" ]] && continue
		cp -R "$migration_directory" "$migrations_root/migrations/"
	done
	DATABASE_URL="$database_url" pnpm exec prisma migrate deploy \
		--schema "$migrations_root/schema.prisma"
	query "
DO \$\$
BEGIN
  IF to_regrole('gen_user') IS NULL THEN
    CREATE ROLE gen_user NOLOGIN;
  END IF;
  IF to_regrole('winwidget_api_runtime') IS NULL THEN
    CREATE ROLE winwidget_api_runtime LOGIN;
  END IF;
  IF to_regrole('winwidget_maintenance') IS NULL THEN
    CREATE ROLE winwidget_maintenance LOGIN;
  END IF;
  IF to_regrole('winwidget_backup') IS NULL THEN
    CREATE ROLE winwidget_backup LOGIN;
  END IF;
END
\$\$;
DO \$\$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO gen_user', relation_name);
  END LOOP;
END
\$\$;
INSERT INTO public.\"User\" (id, password, updated_at)
VALUES ('widgets-cleanup-rehearsal-user', 'not-a-real-password', now());
INSERT INTO public.widget_runtime_presence
  (id, widget_type, widget_id, install_domain, runtime_version, published_version, updated_at)
VALUES
  ('widgets-cleanup-rehearsal-presence', 'wheel', 'widgets-cleanup-rehearsal-widget',
   'example.test', 'rehearsal', 1, now());
DO \$\$
DECLARE relation_name text;
DECLARE trigger_name text;
BEGIN
  FOR relation_name, trigger_name IN
    SELECT relation.relname, trigger.tgname
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY(ARRAY[
        'widgets','quizzes','callbacks','countdown_timers','stop_offers',
        'online_consultants','calculators','leads','quiz_leads','callback_leads',
        'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
        'calculator_leads','widget_config_revisions','widget_runtime_presence',
        'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
      ])
      AND NOT trigger.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', trigger_name, relation_name);
  END LOOP;
END
\$\$;
DROP FUNCTION IF EXISTS public.reporting_widget_projection_trigger();
DROP FUNCTION IF EXISTS public.reporting_lead_projection_trigger();
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, winwidget_api_runtime, winwidget_maintenance;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO winwidget_backup;
" >/dev/null
	# Exercise the migration guard directly for the expected rejection. Prisma
	# records failed migrations in its ledger; that would make this negative
	# assertion alter the state that the following approved deploy is meant to
	# verify. psql still executes the exact tracked migration transaction and
	# proves that every destructive statement rolls back without evidence.
	if docker exec --interactive -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" \
		psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$ADMIN_USER" \
			--dbname default_db \
			<"$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql" \
			>/dev/null 2>&1; then
		fail 'production cleanup migration accepted missing evidence settings'
	fi
	present_count="$(query "SELECT count(*) FROM unnest(ARRAY[
  'widgets','quizzes','callbacks','countdown_timers','stop_offers',
  'online_consultants','calculators','leads','quiz_leads','callback_leads',
  'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
  'calculator_leads','widget_config_revisions','widget_runtime_presence',
  'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
]) AS target(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;")"
	[[ "$present_count" == '18' ]] || fail 'failed cleanup attempt changed the source schema'
	marker_sha="$(printf 'a%.0s' {1..64})"
	approved_database_url="$(widgets_core_source_cleanup_migration_url \
		"$database_url" 1 "$marker_sha" "$marker_sha" "$marker_sha" "$marker_sha")" ||
		fail 'cleanup migration URL could not be built'
	if ! DATABASE_URL="$approved_database_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma"; then
		docker logs "$CONTAINER" 2>&1 |
			awk '/ERROR:|DETAIL:|CONTEXT:/' |
			tail -n 20 >&2 || true
		fail 'approved cleanup migration failed'
	fi
	[[ "$(query "SELECT count(*) FROM unnest(ARRAY[
  'widgets','quizzes','callbacks','countdown_timers','stop_offers',
  'online_consultants','calculators','leads','quiz_leads','callback_leads',
  'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
  'calculator_leads','widget_config_revisions','widget_runtime_presence',
  'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
]) AS target(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;")" == '0' ]] ||
		fail 'approved cleanup did not remove exactly the legacy source'
	[[ "$(query "SELECT count(*) FROM public.\"User\" WHERE id = 'widgets-cleanup-rehearsal-user';")" == '1' ]] ||
		fail 'approved cleanup changed unrelated Core data'
	DATABASE_URL="$database_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" \
		createdb --username "$ADMIN_USER" clean_bootstrap
	bootstrap_url="postgresql://$ADMIN_USER:$ADMIN_PASSWORD@127.0.0.1:$port/clean_bootstrap?schema=public&sslmode=disable&options=$legacy_options"
	DATABASE_URL="$bootstrap_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	[[ "$(docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CONTAINER" psql --no-psqlrc \
		--tuples-only --no-align --set ON_ERROR_STOP=1 --username "$ADMIN_USER" \
		--dbname clean_bootstrap --command "SELECT count(*) FROM unnest(ARRAY[
  'widgets','quizzes','callbacks','countdown_timers','stop_offers',
  'online_consultants','calculators','leads','quiz_leads','callback_leads',
  'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
  'calculator_leads','widget_config_revisions','widget_runtime_presence',
  'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
]) AS target(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;")" == '0' ]] ||
		fail 'pristine bootstrap did not reach the post-cleanup schema'
	printf 'widgets_core_cleanup_production_migration=passed\n'
}

case "${1:-}" in
--verify-dump)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	trap cleanup EXIT INT TERM
	verify_dump
	;;
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
	echo 'Usage: test-widgets-core-source-cleanup-rehearsal.sh --verify-dump|--rehearsal|--self-test' >&2
	exit 64
	;;
esac
