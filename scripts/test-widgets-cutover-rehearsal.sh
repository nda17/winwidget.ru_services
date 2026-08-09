#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

server_root="${WIDGETS_REHEARSAL_SOURCE_ROOT:-$(
	cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
)}"
readonly postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly mode="${1:---rehearsal}"
readonly run_id="${WIDGETS_REHEARSAL_RUN_ID:-local}"
system_tmp_root="$(cd /tmp && pwd -P)"
readonly system_tmp_root
readonly artifact_root="$system_tmp_root/winwidget-widgets-cutover-rehearsal-$run_id"
readonly dump_file="$artifact_root/widgets-exact.dump"
readonly source_container="winwidget-widgets-rehearsal-source-$run_id"
readonly restore_container="winwidget-widgets-rehearsal-restore-$run_id"
readonly source_volume="winwidget-widgets-rehearsal-source-data-$run_id"
readonly restore_volume="winwidget-widgets-rehearsal-restore-data-$run_id"
readonly rehearsal_network="winwidget-widgets-rehearsal-$run_id"
readonly admin_user='winwidget_widgets_admin'
readonly admin_password='widgets_rehearsal_admin_password_32'
readonly migration_password='widgets_rehearsal_migration_password_32'
readonly runtime_password='widgets_rehearsal_runtime_password_32'
readonly backup_password='widgets_rehearsal_backup_password_32'

# shellcheck source=scripts/widgets-database-lifecycle.sh
source "$server_root/scripts/widgets-database-lifecycle.sh"

source_created=false
restore_created=false
source_volume_created=false
restore_volume_created=false
network_created=false

fail() {
	echo "$1" >&2
	exit 1
}

validate_contract() {
	local cutover_script cutover_text snapshot_exporter snapshot_exporter_text
	[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$ &&
		"$run_id" != '.' && "$run_id" != '..' ]] ||
		fail 'WIDGETS_REHEARSAL_RUN_ID is unsafe.'
	[[ "$system_tmp_root" == "$(cd /tmp && pwd -P)" &&
		"$artifact_root" == "$system_tmp_root/winwidget-widgets-cutover-rehearsal-$run_id" &&
		"$(dirname "$artifact_root")" == "$system_tmp_root" ]] ||
		fail 'Widgets rehearsal artifact root is unsafe.'
	[[ -f "$server_root/apps/widgets/prisma/schema.prisma" &&
		-f "$server_root/apps/widgets/prisma/migrations/20260804000000_init_widgets/migration.sql" ]] ||
		fail 'Widgets Prisma migration foundation is missing.'
	cutover_script="$server_root/scripts/widgets-cutover-production.sh"
	[[ -f "$cutover_script" && ! -L "$cutover_script" ]] ||
		fail 'Widgets production cutover script is missing or unsafe.'
	cutover_text="$(<"$cutover_script")"
	[[ "$(grep -Fc -- '.dead-letter|1' "$cutover_script")" == '3' &&
		"$(grep -Fc -- '.dead-letter|0' "$cutover_script")" == '0' &&
		"$cutover_text" == *'wait_for_widgets_source_drain pre-fence'* &&
		"$cutover_text" == *'wait_for_widgets_source_drain post-fence'* &&
		"$cutover_text" == *"wait_for_url_ready 'http://127.0.0.1:4100/health/ready'"* &&
		"$cutover_text" == *'verify_running_service_revision api-gateway "$deploy_revision"'* &&
		"$cutover_text" == *'Widgets source drain blocker scope=provider'* ]] ||
		fail 'Widgets source drain consumer and observability contract is incomplete.'
	snapshot_exporter="$server_root/scripts/export-widgets-cutover-snapshot.mjs"
	[[ -f "$snapshot_exporter" && ! -L "$snapshot_exporter" ]] ||
		fail 'Widgets snapshot exporter is missing or unsafe.'
	snapshot_exporter_text="$(<"$snapshot_exporter")"
	[[ "$snapshot_exporter_text" == *'sourceOccurredAt: sourceExportedAt'* &&
		"$snapshot_exporter_text" == *'.filter(Boolean)'* &&
		"$snapshot_exporter_text" == *"version: '0'"* &&
		"$snapshot_exporter_text" == *"sourceSequence: '0'"* ]] ||
		fail 'Widgets historical projection snapshot baseline contract is incomplete.'
	node "$snapshot_exporter" --self-test >/dev/null
	case "$mode" in
	--self-test | --rehearsal | --verify-dump) ;;
	*) fail 'Usage: test-widgets-cutover-rehearsal.sh [--self-test|--rehearsal|--verify-dump]' ;;
	esac
}

assert_local_docker_context() {
	local docker_host
	docker_host="$(docker context inspect "$(docker context show)" \
		--format '{{.Endpoints.docker.Host}}')"
	[[ "$docker_host" == unix://* ]] ||
		fail 'Widgets rehearsal refuses a remote Docker context.'
}

cleanup() {
	local exit_status="$?"
	local cleanup_failed=false
	trap - EXIT
	set +e
	if [[ "$source_created" == 'true' ]]; then
		[[ "$(docker inspect --format '{{index .Config.Labels "com.winwidget.rehearsal"}}' "$source_container" 2>/dev/null)" == "$run_id" ]] &&
			docker container rm --force "$source_container" >/dev/null || cleanup_failed=true
	fi
	if [[ "$restore_created" == 'true' ]]; then
		[[ "$(docker inspect --format '{{index .Config.Labels "com.winwidget.rehearsal"}}' "$restore_container" 2>/dev/null)" == "$run_id" ]] &&
			docker container rm --force "$restore_container" >/dev/null || cleanup_failed=true
	fi
	if [[ "$source_volume_created" == 'true' ]]; then
		[[ "$(docker volume inspect --format '{{index .Labels "com.winwidget.rehearsal"}}' "$source_volume" 2>/dev/null)" == "$run_id" ]] &&
			docker volume rm "$source_volume" >/dev/null || cleanup_failed=true
	fi
	if [[ "$restore_volume_created" == 'true' ]]; then
		[[ "$(docker volume inspect --format '{{index .Labels "com.winwidget.rehearsal"}}' "$restore_volume" 2>/dev/null)" == "$run_id" ]] &&
			docker volume rm "$restore_volume" >/dev/null || cleanup_failed=true
	fi
	if [[ "$network_created" == 'true' ]]; then
		[[ "$(docker network inspect --format '{{index .Labels "com.winwidget.rehearsal"}}' "$rehearsal_network" 2>/dev/null)" == "$run_id" ]] &&
			docker network rm "$rehearsal_network" >/dev/null || cleanup_failed=true
	fi
	if [[ -d "$artifact_root" && ! -L "$artifact_root" ]]; then
		rm -rf -- "$artifact_root"
	fi
	[[ "$cleanup_failed" == 'false' ]] || exit_status=1
	exit "$exit_status"
}

wait_for_postgres() {
	local container="$1"
	local attempt health
	for ((attempt = 1; attempt <= 60; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return 0
		[[ "$health" != 'unhealthy' ]] || return 1
		sleep 1
	done
	return 1
}

create_volume() {
	local volume="$1"
	docker volume create \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=cutover-restore-rehearsal \
		--label "com.winwidget.rehearsal=$run_id" \
		"$volume" >/dev/null
}

start_postgres() {
	local container="$1"
	local volume="$2"
	local publish_port="${3:-false}"
	local -a network_args=(--network "$rehearsal_network")
	if [[ "$publish_port" == 'true' ]]; then
		network_args+=(--publish '127.0.0.1::5432')
	fi
	docker run --detach \
		--name "$container" \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=cutover-restore-rehearsal \
		--label "com.winwidget.rehearsal=$run_id" \
		"${network_args[@]}" \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--env POSTGRES_DB=winwidget_widgets \
		--env "POSTGRES_USER=$admin_user" \
		--env "POSTGRES_PASSWORD=$admin_password" \
		--env 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		--env PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd "pg_isready --username $admin_user --dbname winwidget_widgets" \
		--health-interval 2s --health-timeout 3s --health-retries 30 \
		"$postgres_image" >/dev/null
	if [[ "$container" == "$source_container" ]]; then
		source_created=true
	else
		restore_created=true
	fi
	wait_for_postgres "$container" || fail "PostgreSQL did not become healthy: $container"
}

source_system_identifier() {
	docker exec "$source_container" psql --no-psqlrc --tuples-only --no-align \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets \
		--command 'SELECT system_identifier FROM pg_control_system();'
}

prepare_source_database() {
	local source_port migration_url
	docker exec -i "$source_container" psql --no-psqlrc --quiet \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets <<SQL
REVOKE ALL ON DATABASE winwidget_widgets FROM PUBLIC;
CREATE ROLE winwidget_widgets_migration LOGIN PASSWORD '$migration_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_widgets_runtime LOGIN PASSWORD '$runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_widgets_backup LOGIN PASSWORD '$backup_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE winwidget_widgets TO
  winwidget_widgets_migration, winwidget_widgets_runtime, winwidget_widgets_backup;
CREATE SCHEMA widgets AUTHORIZATION winwidget_widgets_migration;
REVOKE ALL ON SCHEMA widgets FROM PUBLIC;
GRANT USAGE ON SCHEMA widgets TO winwidget_widgets_runtime, winwidget_widgets_backup;
SQL
	source_port="$(docker port "$source_container" 5432/tcp | sed -n '1s/.*://p')"
	[[ "$source_port" =~ ^[0-9]{2,5}$ ]] || fail 'Could not resolve the local source PostgreSQL port.'
	migration_url="postgresql://winwidget_widgets_migration:$migration_password@127.0.0.1:$source_port/winwidget_widgets?schema=widgets&sslmode=disable"
	WIDGETS_DATABASE_URL="$migration_url" \
		pnpm --dir "$server_root/apps/widgets" run prisma:migrate:deploy >/dev/null

	docker exec -i "$source_container" psql --no-psqlrc --quiet \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets <<'SQL'
REVOKE ALL ON ALL TABLES IN SCHEMA widgets
  FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA widgets
  FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA widgets
  TO winwidget_widgets_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA widgets
  TO winwidget_widgets_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA widgets TO winwidget_widgets_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA widgets TO winwidget_widgets_backup;
REVOKE ALL ON TABLE widgets._prisma_migrations FROM winwidget_widgets_runtime;
INSERT INTO widgets.heartbeats
  (id, role, instance_id, metadata, last_seen_at, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000087', 'all',
   'isolated-cutover-rehearsal', '{"rehearsal":true}'::jsonb,
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
UPDATE widgets.service_identity
SET source_database_fingerprint = repeat('a', 64),
    source_exported_at = CURRENT_TIMESTAMP,
    source_snapshot_sha256 = repeat('b', 64),
    source_snapshot_counts = '{}'::jsonb,
    source_reporting_high_water = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'widgets-service';
UPDATE widgets.service_identity
SET handoff_started_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'widgets-service';
UPDATE widgets.service_identity
SET ownership_generation = 1,
    ownership_activated_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'widgets-service';
DO $verify$
BEGIN
  IF has_table_privilege(
    'winwidget_widgets_runtime', 'widgets._prisma_migrations', 'SELECT'
  ) OR NOT has_table_privilege(
    'winwidget_widgets_backup', 'widgets._prisma_migrations', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Widgets migration ledger ACL is not dump-safe';
  END IF;
END
$verify$;
SQL
}

verify_core_write_fence_behavior() {
	local table_name
	{
		printf 'BEGIN;\n'
		printf '%s\n' \
			'CREATE ROLE winwidget_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;' \
			'GRANT USAGE ON SCHEMA public TO winwidget_api_runtime;'
		for table_name in "${WIDGETS_CANONICAL_CORE_TABLES[@]}"; do
			printf 'CREATE TABLE public.%s (id INTEGER NOT NULL);\n' "$table_name"
			printf 'INSERT INTO public.%s (id) VALUES (1);\n' "$table_name"
			printf 'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.%s TO winwidget_api_runtime;\n' "$table_name"
		done
		printf '%s\n' \
			'CREATE TABLE public.non_widgets_write_probe (id INTEGER NOT NULL);' \
			'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.non_widgets_write_probe TO winwidget_api_runtime;' \
			'COMMIT;'
	} | docker exec -i "$source_container" psql --no-psqlrc --quiet \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets

	widgets_core_write_fence_install_sql |
		docker exec -i "$source_container" psql --no-psqlrc --quiet \
			--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets
	widgets_core_write_fence_install_sql |
		docker exec -i "$source_container" psql --no-psqlrc --quiet \
			--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets

	docker exec -i "$source_container" psql --no-psqlrc --quiet \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets <<'SQL'
SET ROLE winwidget_api_runtime;
SELECT count(*) FROM public.non_widgets_write_probe;
INSERT INTO public.non_widgets_write_probe (id) VALUES (1);
UPDATE public.non_widgets_write_probe SET id = id;
DELETE FROM public.non_widgets_write_probe WHERE false;
TRUNCATE TABLE public.non_widgets_write_probe;
DO $behavior$
DECLARE
  relation_name TEXT;
  operation TEXT;
  error_message TEXT;
  error_detail TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', relation_name);
    FOREACH operation IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      BEGIN
        CASE operation
          WHEN 'INSERT' THEN
            EXECUTE format('INSERT INTO public.%I (id) VALUES (2)', relation_name);
          WHEN 'UPDATE' THEN
            EXECUTE format('UPDATE public.%I SET id = id', relation_name);
          WHEN 'DELETE' THEN
            EXECUTE format('DELETE FROM public.%I WHERE false', relation_name);
          WHEN 'TRUNCATE' THEN
            EXECUTE format('TRUNCATE TABLE public.%I', relation_name);
        END CASE;
        RAISE EXCEPTION 'Widgets write fence allowed % on %', operation, relation_name;
      EXCEPTION
        WHEN SQLSTATE '55000' THEN
          GET STACKED DIAGNOSTICS
            error_message = MESSAGE_TEXT,
            error_detail = PG_EXCEPTION_DETAIL;
          IF error_message <> 'Widgets ownership cutover write fence is active' OR
             error_detail <> format('public.%s', relation_name) THEN
            RAISE EXCEPTION 'Unexpected Widgets write-fence error for % on %',
              operation, relation_name;
          END IF;
      END;
    END LOOP;
  END LOOP;
END
$behavior$;
RESET ROLE;
SQL

	widgets_core_write_fence_remove_sql |
		docker exec -i "$source_container" psql --no-psqlrc --quiet \
			--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets
	widgets_core_write_fence_remove_sql |
		docker exec -i "$source_container" psql --no-psqlrc --quiet \
			--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets

	{
		printf '%s\n' 'BEGIN;' 'SET ROLE winwidget_api_runtime;'
		for table_name in "${WIDGETS_CANONICAL_CORE_TABLES[@]}"; do
			printf 'INSERT INTO public.%s (id) VALUES (2);\n' "$table_name"
			printf 'UPDATE public.%s SET id = id;\n' "$table_name"
			printf 'DELETE FROM public.%s WHERE id = 2;\n' "$table_name"
			printf 'TRUNCATE TABLE public.%s;\n' "$table_name"
		done
		printf '%s\n' 'RESET ROLE;' 'COMMIT;'
		for table_name in "${WIDGETS_CANONICAL_CORE_TABLES[@]}"; do
			printf 'DROP TABLE public.%s;\n' "$table_name"
		done
		printf '%s\n' \
			'DROP TABLE public.non_widgets_write_probe;' \
			'REVOKE USAGE ON SCHEMA public FROM winwidget_api_runtime;' \
			'DROP ROLE winwidget_api_runtime;'
	} | docker exec -i "$source_container" psql --no-psqlrc --quiet \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets
	echo 'Widgets Core write fence behavior verified against PostgreSQL 18.'
}

create_source_dump() {
	docker exec -e "PGPASSWORD=$backup_password" "$source_container" \
		pg_dump --host 127.0.0.1 --username winwidget_widgets_backup \
			--dbname winwidget_widgets --format custom --no-owner --no-acl \
			--schema widgets >"$dump_file"
	chmod 600 "$dump_file"
	[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" ]] ||
		fail 'Widgets rehearsal dump was not created.'
	docker run --rm --network none --interactive \
		--entrypoint pg_restore "$postgres_image" \
		--list <"$dump_file" >/dev/null
}

verify_dump_in_isolated_postgres() {
	local input_dump="$1"
	local expected_sha="$2"
	local source_identifier="${3:-}"
	local actual_sha restore_identifier restored_catalog restored_state
	[[ -f "$input_dump" && ! -L "$input_dump" && -s "$input_dump" ]] ||
		fail 'Widgets exact dump is missing or unsafe.'
	actual_sha="$(sha256sum "$input_dump" | awk '{ print $1 }')"
	[[ "$actual_sha" == "$expected_sha" && "$actual_sha" =~ ^[0-9a-f]{64}$ ]] ||
		fail 'Widgets exact dump SHA-256 does not match the approved evidence.'

	create_volume "$restore_volume"
	restore_volume_created=true
	start_postgres "$restore_container" "$restore_volume"
	docker cp "$input_dump" "$restore_container:/tmp/widgets-exact.dump" >/dev/null
	docker exec "$restore_container" pg_restore --list /tmp/widgets-exact.dump >/dev/null
	docker exec "$restore_container" pg_restore \
		--exit-on-error --single-transaction --no-owner --no-acl \
		--username "$admin_user" --dbname winwidget_widgets \
		/tmp/widgets-exact.dump >/dev/null
	restored_state="$(docker exec "$restore_container" psql --no-psqlrc \
		--tuples-only --no-align --set ON_ERROR_STOP=1 \
		--username "$admin_user" --dbname winwidget_widgets --command \
		"SELECT
		  (SELECT count(*) FROM widgets._prisma_migrations WHERE finished_at IS NOT NULL) || '|' ||
		  (SELECT count(*) FROM widgets.service_identity
		   WHERE id = 'widgets-service'
		     AND handoff_started_at IS NOT NULL
		     AND ownership_activated_at IS NOT NULL
		     AND ownership_generation = 1) || '|' ||
		  (SELECT count(*) FROM information_schema.columns
		   WHERE table_schema = 'widgets' AND table_name = 'service_identity'
		     AND column_name = 'handoff_started_at') || '|' ||
		  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'widgets');")"
	[[ "$restored_state" =~ ^[1-9][0-9]*\|1\|1\|[1-9][0-9]*$ ]] ||
		fail 'Isolated PostgreSQL 18 restore is missing migration or durable handoff identity state.'
	restored_catalog="$(docker exec "$restore_container" psql --no-psqlrc \
		--tuples-only --no-align --set ON_ERROR_STOP=1 \
		--username "$admin_user" --dbname winwidget_widgets --command \
		"SELECT
		  (SELECT count(*) FROM information_schema.table_constraints
		   WHERE constraint_schema = 'widgets') || '|' ||
		  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'widgets');")"
	[[ "$restored_catalog" =~ ^[1-9][0-9]*\|[1-9][0-9]*$ ]] ||
		fail 'Isolated PostgreSQL 18 restore is missing constraints or indexes.'

	docker exec -i "$restore_container" psql --no-psqlrc --quiet \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets <<SQL
CREATE ROLE winwidget_widgets_runtime LOGIN PASSWORD '$runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_widgets_backup LOGIN PASSWORD '$backup_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE winwidget_widgets TO
  winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE ALL ON SCHEMA widgets FROM PUBLIC;
GRANT USAGE ON SCHEMA widgets TO
  winwidget_widgets_runtime, winwidget_widgets_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA widgets
  TO winwidget_widgets_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA widgets
  TO winwidget_widgets_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA widgets TO winwidget_widgets_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA widgets TO winwidget_widgets_backup;
REVOKE ALL ON TABLE widgets._prisma_migrations FROM winwidget_widgets_runtime;
SQL
	docker exec -e "PGPASSWORD=$runtime_password" "$restore_container" \
		psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 \
		--username winwidget_widgets_runtime --dbname winwidget_widgets \
		--command "INSERT INTO widgets.heartbeats
		  (id, role, instance_id, metadata, last_seen_at, created_at, updated_at)
		  VALUES ('00000000-0000-4000-8000-000000000088', 'api',
		    'restore-runtime-crud', '{\"restoreCrud\":true}'::jsonb,
		    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
		  UPDATE widgets.heartbeats SET role = 'all'
		  WHERE id = '00000000-0000-4000-8000-000000000088';
		  DELETE FROM widgets.heartbeats
		  WHERE id = '00000000-0000-4000-8000-000000000088';" >/dev/null
	if docker exec -e "PGPASSWORD=$runtime_password" "$restore_container" \
		psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 \
		--username winwidget_widgets_runtime --dbname winwidget_widgets \
		--command 'SELECT count(*) FROM widgets._prisma_migrations;' \
		>/dev/null 2>&1; then
		fail 'Restored Widgets runtime can read the Prisma migration ledger.'
	fi
	docker exec -e "PGPASSWORD=$backup_password" "$restore_container" \
		psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 \
		--username winwidget_widgets_backup --dbname winwidget_widgets \
		--command 'SELECT count(*) FROM widgets._prisma_migrations;
		  SELECT count(*) FROM widgets.service_identity;' >/dev/null
	if docker exec -e "PGPASSWORD=$backup_password" "$restore_container" \
		psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 \
		--username winwidget_widgets_backup --dbname winwidget_widgets \
		--command "DELETE FROM widgets.heartbeats
		  WHERE id = '00000000-0000-4000-8000-000000000087';" \
		>/dev/null 2>&1; then
		fail 'Restored Widgets backup role can mutate runtime data.'
	fi
	docker exec -e "PGPASSWORD=$backup_password" "$restore_container" \
		pg_dump --host 127.0.0.1 --username winwidget_widgets_backup \
			--dbname winwidget_widgets --format custom --no-owner --no-acl \
			--schema widgets --file /tmp/widgets-restore-redump.dump
	docker exec "$restore_container" test -s /tmp/widgets-restore-redump.dump
	docker exec "$restore_container" \
		pg_restore --list /tmp/widgets-restore-redump.dump >/dev/null
	restore_identifier="$(docker exec "$restore_container" psql --no-psqlrc \
		--tuples-only --no-align --set ON_ERROR_STOP=1 \
		--username "$admin_user" --dbname winwidget_widgets \
		--command 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$restore_identifier" =~ ^[0-9]+$ ]] || fail 'Restore PostgreSQL system identifier is invalid.'
	if [[ -n "$source_identifier" ]]; then
		[[ "$source_identifier" =~ ^[0-9]+$ && "$restore_identifier" != "$source_identifier" ]] ||
			fail 'Restore gate did not use an isolated PostgreSQL cluster.'
	fi
	printf 'widgets_restore_dump_sha256=%s\n' "$actual_sha"
	echo 'Widgets exact dump restored into a clean isolated PostgreSQL 18 cluster.'
}

verify_rabbitmq_cutover_contract() {
	local projection_queues projection_bindings transition_listing target_listing
	local partial_transition_listing polluted_listing
	local projection_ready=false
	local forward_only=false
	local legacy_worker_stopped=false
	local legacy_core_topology_owner_stopped=false
	local core_topology_owner_restarted=false

	projection_queues=$'winwidget.widgets.identity-user\t0\t0\t0\nwinwidget.widgets.billing-subscription\t0\t0\t0'
	projection_bindings=$'winwidget.events\twinwidget.widgets.identity-user\tidentity.user.changed.v1\nwinwidget.events\twinwidget.widgets.billing-subscription\tbilling.subscription.changed.v1'
	! widgets_cutover_projection_boundary_is_safe "$projection_ready" ||
		fail 'RabbitMQ rehearsal opened the snapshot boundary before projection topology.'
	widgets_rabbitmq_projection_topology_is_ready \
		"$projection_queues" "$projection_bindings" ||
		fail 'RabbitMQ rehearsal projection fixture is invalid.'
	projection_ready=true
	widgets_cutover_projection_boundary_is_safe "$projection_ready" ||
		fail 'RabbitMQ rehearsal did not open the snapshot boundary after projection topology.'

	transition_listing="$({
		widgets_canonical_provider_target_queue_names
		widgets_canonical_provider_legacy_queue_names
	} | LC_ALL=C sort -u | awk '{ print $0 "\t0\t0\t0" }')"
	! widgets_rabbitmq_provider_namespace_is_exact "$transition_listing" ||
		fail 'RabbitMQ rehearsal accepted the mixed legacy/Widgets provider namespace.'
	widgets_rabbitmq_provider_transition_is_drained "$transition_listing" ||
		fail 'RabbitMQ rehearsal rejected the complete safe transition namespace.'
	partial_transition_listing="$(widgets_canonical_provider_target_queue_names |
		awk '$0 != "winwidget.lead-integration.webhook.retry.1" { print $0 "\t0\t0\t0" }')"$'\nwinwidget.lead-integration.bitrix24.retry-v2.2\t0\t0\t0'
	widgets_rabbitmq_provider_transition_is_drained "$partial_transition_listing" ||
		fail 'RabbitMQ rehearsal rejected a safe resumable partial target cleanup namespace.'
	! widgets_cutover_provider_replacement_is_safe \
		"$forward_only" "$legacy_worker_stopped" \
		"$legacy_core_topology_owner_stopped" ||
		fail 'RabbitMQ rehearsal allowed provider replacement before forward-only.'
	forward_only=true
	legacy_worker_stopped=true
	legacy_core_topology_owner_stopped=true
	widgets_cutover_provider_replacement_is_safe \
		"$forward_only" "$legacy_worker_stopped" \
		"$legacy_core_topology_owner_stopped" ||
		fail 'RabbitMQ rehearsal rejected safe provider replacement.'
	target_listing="$(widgets_canonical_provider_target_queue_names |
		awk '{ print $0 "\t0\t0\t0" }')"
	widgets_rabbitmq_provider_namespace_is_exact "$target_listing" ||
		fail 'RabbitMQ rehearsal replacement did not produce the exact Widgets provider namespace.'
	! widgets_cutover_post_publisher_namespace_is_safe \
		"$forward_only" "$core_topology_owner_restarted" "$target_listing" ||
		fail 'RabbitMQ rehearsal accepted namespace evidence before Core publisher restart.'
	core_topology_owner_restarted=true
	widgets_cutover_post_publisher_namespace_is_safe \
		"$forward_only" "$core_topology_owner_restarted" "$target_listing" ||
		fail 'RabbitMQ rehearsal rejected the exact namespace after Core publisher restart.'
	polluted_listing="$target_listing"$'\nwinwidget.lead-integration.amo-crm.retry-v2.3\t0\t0\t0'
	! widgets_cutover_post_publisher_namespace_is_safe \
		"$forward_only" "$core_topology_owner_restarted" "$polluted_listing" ||
		fail 'RabbitMQ rehearsal did not detect Core publisher provider namespace regression.'
	echo 'Widgets RabbitMQ projection-before-snapshot and post-publisher exact namespace fixture passed.'
}

run_rehearsal() {
	local source_identifier dump_sha
	[[ ! -e "$artifact_root" && ! -L "$artifact_root" ]] ||
		fail 'Widgets rehearsal artifact root already exists.'
	install -d -m 700 "$artifact_root"
	docker network create \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=cutover-restore-rehearsal \
		--label "com.winwidget.rehearsal=$run_id" \
		"$rehearsal_network" >/dev/null
	network_created=true
	create_volume "$source_volume"
	source_volume_created=true
	start_postgres "$source_container" "$source_volume" true
	prepare_source_database
	verify_core_write_fence_behavior
	source_identifier="$(source_system_identifier)"
	[[ "$source_identifier" =~ ^[0-9]+$ ]] || fail 'Source PostgreSQL system identifier is invalid.'
	verify_rabbitmq_cutover_contract
	create_source_dump
	dump_sha="$(sha256sum "$dump_file" | awk '{ print $1 }')"
	verify_dump_in_isolated_postgres "$dump_file" "$dump_sha" "$source_identifier"
}

run_verify_dump() {
	local input_dump="${WIDGETS_REHEARSAL_DUMP_FILE:-}"
	local expected_sha="${WIDGETS_REHEARSAL_EXPECTED_SHA256:-}"
	local source_identifier="${WIDGETS_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER:-}"
	[[ "$input_dump" == /* && "$expected_sha" =~ ^[0-9a-f]{64}$ &&
		"$source_identifier" =~ ^[0-9]+$ ]] ||
		fail 'Verify-dump mode requires an absolute dump path, SHA-256, and source system identifier.'
	[[ ! -e "$artifact_root" && ! -L "$artifact_root" ]] ||
		fail 'Widgets restore verification artifact root already exists.'
	install -d -m 700 "$artifact_root"
	docker network create \
		--label com.winwidget.owner=widgets \
		--label com.winwidget.purpose=cutover-restore-rehearsal \
		--label "com.winwidget.rehearsal=$run_id" \
		"$rehearsal_network" >/dev/null
	network_created=true
	verify_dump_in_isolated_postgres "$input_dump" "$expected_sha" "$source_identifier"
}

validate_contract
if [[ "$mode" == '--self-test' ]]; then
	[[ "$postgres_image" == postgres:18-bookworm@sha256:* ]] ||
		fail 'Widgets rehearsal PostgreSQL image is not digest-pinned PG18.'
	widgets_lifecycle_self_test >/dev/null
	verify_rabbitmq_cutover_contract >/dev/null
	echo 'Widgets isolated PostgreSQL 18 rehearsal contract self-test passed.'
	exit 0
fi

assert_local_docker_context
trap cleanup EXIT
if [[ "$mode" == '--verify-dump' ]]; then
	run_verify_dump
else
	run_rehearsal
fi
