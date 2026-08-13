#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-$(cd -- "$SOURCE_ROOT/.." && pwd -P)}"
# shellcheck source=scripts/billing-database-lifecycle.sh
source "$SOURCE_ROOT/scripts/billing-database-lifecycle.sh"

readonly POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly MIGRATION_NAME='20260813000000_remove_legacy_billing_core_source'
RUN_ID="${CORE_CLEANUP_REHEARSAL_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
RESOURCE_PREFIX="winwidget-billing-core-cleanup-$RUN_ID"
CORE_CONTAINER="$RESOURCE_PREFIX-core"
BILLING_CONTAINER="$RESOURCE_PREFIX-billing"
CORE_VOLUME="$RESOURCE_PREFIX-core-data"
BILLING_VOLUME="$RESOURCE_PREFIX-billing-data"
ADMIN_USER='winwidget_cleanup_restore_admin'
ADMIN_PASSWORD="$(openssl rand -hex 24)"
MIGRATION_PASSWORD="$(openssl rand -hex 24)"
TEMP_ROOT=''
TEMP_PARENT=''
CREATED_CORE_CONTAINER=false
CREATED_BILLING_CONTAINER=false
CREATED_CORE_VOLUME=false
CREATED_BILLING_VOLUME=false

readonly -a TARGET_TABLES=(
	payments payment_receipts subscriptions subscription_history
	subscription_expiry_reminders auto_renewals auto_renewal_consent_events
	tariff_prices affiliate_referrals
)
readonly -a LEGACY_SETTINGS_COLUMNS=(
	payment_enabled auto_renewal_signup_enabled auto_renewal_charges_enabled
	auto_renewal_charges_enabled_at affiliate_program_enabled affiliate_cashback_percent
)

fail() {
	printf 'billing_core_cleanup_rehearsal_error=%s\n' "$1" >&2
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
	local status=$? basename parent
	trap - EXIT INT TERM
	if [[ "$CREATED_CORE_CONTAINER" == 'true' ]]; then
		docker rm -f "$CORE_CONTAINER" >/dev/null 2>&1 || true
	fi
	if [[ "$CREATED_BILLING_CONTAINER" == 'true' ]]; then
		docker rm -f "$BILLING_CONTAINER" >/dev/null 2>&1 || true
	fi
	if [[ "$CREATED_CORE_VOLUME" == 'true' ]]; then
		docker volume rm "$CORE_VOLUME" >/dev/null 2>&1 || true
	fi
	if [[ "$CREATED_BILLING_VOLUME" == 'true' ]]; then
		docker volume rm "$BILLING_VOLUME" >/dev/null 2>&1 || true
	fi
	if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" ]]; then
		parent="$(dirname -- "$TEMP_ROOT")"
		basename="$(basename -- "$TEMP_ROOT")"
		if [[ "$parent" == "$TEMP_PARENT" && "$basename" == "billing-core-cleanup-$RUN_ID."?????? ]]; then
			rm -rf -- "$TEMP_ROOT"
		else
			printf 'billing_core_cleanup_rehearsal_warning=unsafe_temp_cleanup_skipped\n' >&2
		fi
	fi
	exit "$status"
}

create_temp_root() {
	local owner
	[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$ ]] || fail 'unsafe rehearsal run ID'
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		TEMP_PARENT="$SOURCE_ROOT"
	else
		TEMP_PARENT='/tmp'
	fi
	TEMP_ROOT="$(mktemp -d "$TEMP_PARENT/billing-core-cleanup-$RUN_ID.XXXXXX")"
	owner="$(billing_core_source_cleanup_stat_owner "$TEMP_ROOT")"
	[[ -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" && "${owner%%:*}" == "$(id -u)" &&
		"$(billing_core_source_cleanup_stat_mode "$TEMP_ROOT")" == '700' ]] ||
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
	local container="$1" attempt health
	for ((attempt = 1; attempt <= 60; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return 0
		[[ "$health" == 'unhealthy' ]] && return 1
		sleep 2
	done
	return 1
}

create_postgres() {
	local container="$1" volume="$2" database="$3" purpose="$4"
	[[ -z "$(docker ps -aq --filter "name=^/${container}$")" ]] || fail "container exists: $container"
	[[ -z "$(docker volume ls -q --filter "name=^${volume}$")" ]] || fail "volume exists: $volume"
	docker volume create --label com.winwidget.owner=billing \
		--label "com.winwidget.purpose=$purpose" \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" "$volume" >/dev/null
	if [[ "$container" == "$CORE_CONTAINER" ]]; then
		CREATED_CORE_VOLUME=true
	else
		CREATED_BILLING_VOLUME=true
	fi
	docker run --detach --name "$container" \
		--label com.winwidget.owner=billing --label "com.winwidget.purpose=$purpose" \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		-e "POSTGRES_DB=$database" -e "POSTGRES_USER=$ADMIN_USER" \
		-e "POSTGRES_PASSWORD=$ADMIN_PASSWORD" \
		-e 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		-e PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd "pg_isready --username $ADMIN_USER --dbname $database" \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$POSTGRES_IMAGE" >/dev/null
	if [[ "$container" == "$CORE_CONTAINER" ]]; then
		CREATED_CORE_CONTAINER=true
	else
		CREATED_BILLING_CONTAINER=true
	fi
	wait_for_postgres "$container" || fail "PostgreSQL did not become healthy: $purpose"
}

query() {
	local container="$1" database="$2" sql="$3"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$container" \
		psql --no-psqlrc --no-password --tuples-only --no-align --set ON_ERROR_STOP=1 \
			--username "$ADMIN_USER" --dbname "$database" --command "$sql"
}

query_database() {
	local database="$1" sql="$2"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CORE_CONTAINER" \
		psql --no-psqlrc --no-password --tuples-only --no-align --set ON_ERROR_STOP=1 \
			--username "$ADMIN_USER" --dbname "$database" --command "$sql"
}

apply_sql_file() {
	local database="$1" file="$2"
	docker exec --interactive -e "PGPASSWORD=$ADMIN_PASSWORD" "$CORE_CONTAINER" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --username "$ADMIN_USER" \
			--dbname "$database" <"$file"
}

connection_url() {
	local port="$1" database="$2" user="$3" password="$4" options="${5:-}"
	BASE_REHEARSAL_URL="postgresql://$user:$password@127.0.0.1:$port/$database?schema=public&sslmode=disable" \
		REHEARSAL_OPTIONS="$options" billing_release_node - <<'NODE'
const url = new URL(process.env.BASE_REHEARSAL_URL);
if (process.env.REHEARSAL_OPTIONS) url.searchParams.set('options', process.env.REHEARSAL_OPTIONS);
process.stdout.write(url.toString().replace(/([?&]options=)([^&#]*)/, (_, prefix, value) =>
  `${prefix}${value.replace(/\+/g, '%20')}`));
NODE
}

database_url() {
	connection_url "$1" "$2" "$ADMIN_USER" "$ADMIN_PASSWORD" "${3:-}"
}

copy_migrations_without_cleanup() {
	local destination="$1" migration
	mkdir "$destination" "$destination/migrations"
	cp "$SOURCE_ROOT/prisma/schema.prisma" "$destination/schema.prisma"
	for migration in "$SOURCE_ROOT"/prisma/migrations/*; do
		[[ -d "$migration" ]] || continue
		[[ "$(basename -- "$migration")" == "$MIGRATION_NAME" ]] && continue
		cp -R "$migration" "$destination/migrations/"
	done
}

restore_dump() {
	local container="$1" database="$2" dump="$3"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$container" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --username "$ADMIN_USER" \
			--dbname "$database" --command 'DROP SCHEMA public CASCADE;' >/dev/null
	docker run --rm --network "container:$container" -e "PGPASSWORD=$ADMIN_PASSWORD" \
		--mount "type=bind,source=$(dirname -- "$dump"),target=/input,readonly" \
		"$POSTGRES_IMAGE" pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
			--host 127.0.0.1 --username "$ADMIN_USER" --dbname "$database" \
			"/input/$(basename -- "$dump")" >/dev/null
}

target_table_count() {
	local container="$1" database="$2"
	query "$container" "$database" "
SELECT count(*) FROM unnest(ARRAY[
  'payments','payment_receipts','subscriptions','subscription_history',
  'subscription_expiry_reminders','auto_renewals','auto_renewal_consent_events',
  'tariff_prices','affiliate_referrals'
]) AS target(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;
"
}

legacy_settings_count() {
	local container="$1" database="$2"
	query "$container" "$database" "
SELECT count(*) FROM pg_catalog.pg_attribute
WHERE attrelid = 'public.site_settings'::regclass AND attnum > 0 AND NOT attisdropped
  AND attname = ANY(ARRAY[
    'payment_enabled','auto_renewal_signup_enabled','auto_renewal_charges_enabled',
    'auto_renewal_charges_enabled_at','affiliate_program_enabled','affiliate_cashback_percent'
  ]);
"
}

verify_core_dump() {
	local kind="$1" dump expected_sha source_system expected_state restore_system migration_sha
	local evidence revision previous generation database_id redump
	dump="${CORE_CLEANUP_REHEARSAL_CORE_DUMP_FILE:-}"
	expected_sha="${CORE_CLEANUP_REHEARSAL_CORE_SHA256:-}"
	source_system="${CORE_CLEANUP_REHEARSAL_CORE_SYSTEM_IDENTIFIER:-}"
	evidence="${CORE_CLEANUP_REHEARSAL_EVIDENCE_FILE:-}"
	revision="${CORE_CLEANUP_REHEARSAL_REVISION:-}"
	previous="${CORE_CLEANUP_REHEARSAL_PREVIOUS_REVISION:-}"
	generation="${CORE_CLEANUP_REHEARSAL_GENERATION:-}"
	database_id="${CORE_CLEANUP_REHEARSAL_BILLING_DATABASE_ID:-11111111-1111-4111-8111-111111111111}"
	expected_state="$([[ "$kind" == 'pre' ]] && printf 'present' || printf 'absent')"
	[[ "$dump" == /* && -f "$dump" && ! -L "$dump" && -s "$dump" &&
		"$expected_sha" =~ ^[0-9a-f]{64}$ && "$source_system" =~ ^[1-9][0-9]*$ &&
		"$evidence" == /* && "$revision" =~ ^[0-9a-f]{40}$ &&
		"$previous" =~ ^[0-9a-f]{40}$ && "$revision" != "$previous" && "$generation" == '2' ]] ||
		fail 'invalid Core dump verification inputs'
	[[ "$(sha256_file "$dump")" == "$expected_sha" ]] || fail 'Core dump SHA-256 mismatch'
	create_temp_root
	create_postgres "$CORE_CONTAINER" "$CORE_VOLUME" default_db core-clean-restore
	restore_system="$(query "$CORE_CONTAINER" default_db 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$restore_system" =~ ^[1-9][0-9]*$ && "$restore_system" != "$source_system" ]] ||
		fail 'Core clean restore is not physically independent'
	restore_dump "$CORE_CONTAINER" default_db "$dump"
	if [[ "$expected_state" == 'present' ]]; then
		[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '9' &&
			"$(legacy_settings_count "$CORE_CONTAINER" default_db)" == '6' ]] ||
			fail 'pre-cleanup Core restore lost legacy Billing source'
	else
		[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '0' &&
			"$(legacy_settings_count "$CORE_CONTAINER" default_db)" == '0' ]] ||
			fail 'post-cleanup Core restore contains legacy Billing source'
		migration_sha="$(sha256_file "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql")"
		[[ "$(query "$CORE_CONTAINER" default_db "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME' AND checksum='$migration_sha' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")" == '1' ]] ||
			fail 'post-cleanup Core restore lacks exact applied migration ledger'
	fi
	redump="$TEMP_ROOT/core-redump.dump"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CORE_CONTAINER" pg_dump --format=custom \
		--no-owner --no-privileges --no-password --username "$ADMIN_USER" \
		--dbname default_db >"$redump"
	[[ -s "$redump" ]] || fail 'restored Core cannot be dumped again'
	if [[ "$kind" == 'post' ]]; then
		write_restore_evidence post "$evidence" "$revision" "$previous" "$generation" \
			"$expected_sha" '' "$source_system" "$restore_system" '' '' "$database_id"
	fi
}

write_restore_evidence() {
	[[ $# -eq 12 ]] || return 1
	local kind="$1" destination="$2" revision="$3" previous="$4" generation="$5"
	local core_sha="$6" billing_sha="$7" core_source="$8" core_restore="$9"
	local billing_source="${10}" billing_restore="${11}" database_id="${12:-}"
	local verified_at partial
	verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	partial="$destination.partial"
	[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'restore evidence already exists'
	rm -f -- "$partial"
	RESTORE_KIND="$kind" RESTORE_REVISION="$revision" PREVIOUS_REVISION="$previous" \
		OWNERSHIP_GENERATION="$generation" CORE_SHA="$core_sha" BILLING_SHA="$billing_sha" \
		CORE_SOURCE="$core_source" CORE_RESTORE="$core_restore" BILLING_SOURCE="$billing_source" \
		BILLING_RESTORE="$billing_restore" BILLING_DATABASE_ID="$database_id" \
		VERIFIED_AT="$verified_at" billing_release_node - <<'NODE' >"$partial"
const pre = process.env.RESTORE_KIND === 'pre';
const value = {
  schemaVersion: 1,
  action: `billing-core-source-cleanup-${process.env.RESTORE_KIND}-restore`,
  status: 'passed',
  previousRevision: process.env.PREVIOUS_REVISION,
  cleanupRevision: process.env.RESTORE_REVISION,
  ownershipGeneration: Number(process.env.OWNERSHIP_GENERATION),
  core: {
    dumpSha256: process.env.CORE_SHA,
    sourceSystemIdentifier: process.env.CORE_SOURCE,
    restoreSystemIdentifier: process.env.CORE_RESTORE,
    legacySourceState: pre ? 'present' : 'absent',
    migrationState: pre ? 'pending' : 'applied',
  },
  checks: {
    cleanPostgreSQL18: true,
    physicalIndependence: true,
    dumpReadable: true,
    exactLegacySourceState: true,
    redumpReadable: true,
  },
  verifiedAt: process.env.VERIFIED_AT,
};
if (pre) value.billing = {
  dumpSha256: process.env.BILLING_SHA,
  sourceSystemIdentifier: process.env.BILLING_SOURCE,
  restoreSystemIdentifier: process.env.BILLING_RESTORE,
  databaseId: process.env.BILLING_DATABASE_ID,
  phase: 'ACTIVE',
  ownershipGeneration: 2,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
	chmod 600 "$partial"
	mv -- "$partial" "$destination"
}

verify_dumps() {
	local core_dump billing_dump core_sha billing_sha core_source billing_source evidence
	local revision previous generation database_id core_restore billing_restore billing_identity redump
	core_dump="${CORE_CLEANUP_REHEARSAL_CORE_DUMP_FILE:-}"
	billing_dump="${CORE_CLEANUP_REHEARSAL_BILLING_DUMP_FILE:-}"
	core_sha="${CORE_CLEANUP_REHEARSAL_CORE_SHA256:-}"
	billing_sha="${CORE_CLEANUP_REHEARSAL_BILLING_SHA256:-}"
	core_source="${CORE_CLEANUP_REHEARSAL_CORE_SYSTEM_IDENTIFIER:-}"
	billing_source="${CORE_CLEANUP_REHEARSAL_BILLING_SYSTEM_IDENTIFIER:-}"
	evidence="${CORE_CLEANUP_REHEARSAL_EVIDENCE_FILE:-}"
	revision="${CORE_CLEANUP_REHEARSAL_REVISION:-}"
	previous="${CORE_CLEANUP_REHEARSAL_PREVIOUS_REVISION:-}"
	generation="${CORE_CLEANUP_REHEARSAL_GENERATION:-}"
	database_id="${CORE_CLEANUP_REHEARSAL_BILLING_DATABASE_ID:-}"
	[[ "$core_dump" == /* && "$billing_dump" == /* && -f "$core_dump" && -f "$billing_dump" &&
		! -L "$core_dump" && ! -L "$billing_dump" && -s "$core_dump" && -s "$billing_dump" &&
		"$core_sha" =~ ^[0-9a-f]{64}$ && "$billing_sha" =~ ^[0-9a-f]{64}$ &&
		"$core_source" =~ ^[1-9][0-9]*$ && "$billing_source" =~ ^[1-9][0-9]*$ &&
		"$core_source" != "$billing_source" && "$revision" =~ ^[0-9a-f]{40}$ &&
		"$previous" =~ ^[0-9a-f]{40}$ && "$revision" != "$previous" && "$generation" == '2' &&
		"$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$evidence" == /* ]] || fail 'invalid pre-cleanup dump verification inputs'
	[[ "$(sha256_file "$core_dump")" == "$core_sha" && "$(sha256_file "$billing_dump")" == "$billing_sha" ]] ||
		fail 'pre-cleanup dump SHA-256 mismatch'
	create_temp_root
	create_postgres "$CORE_CONTAINER" "$CORE_VOLUME" default_db core-clean-restore
	create_postgres "$BILLING_CONTAINER" "$BILLING_VOLUME" winwidget_billing billing-clean-restore
	core_restore="$(query "$CORE_CONTAINER" default_db 'SELECT system_identifier FROM pg_control_system();')"
	billing_restore="$(query "$BILLING_CONTAINER" winwidget_billing 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$core_restore" =~ ^[1-9][0-9]*$ && "$billing_restore" =~ ^[1-9][0-9]*$ &&
		"$core_restore" != "$core_source" && "$billing_restore" != "$billing_source" &&
		"$core_restore" != "$billing_restore" ]] || fail 'clean restores are not physically independent'
	restore_dump "$CORE_CONTAINER" default_db "$core_dump"
	restore_dump "$BILLING_CONTAINER" winwidget_billing "$billing_dump"
	[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '9' &&
		"$(legacy_settings_count "$CORE_CONTAINER" default_db)" == '6' ]] ||
		fail 'pre-cleanup Core restore lost legacy source'
	billing_identity="$(query "$BILLING_CONTAINER" winwidget_billing "SELECT database_id::text || '|' || phase::text || '|' || ownership_generation::text FROM billing.service_identity WHERE id='singleton' AND service_name='billing-service';")"
	[[ "$billing_identity" == "$database_id|ACTIVE|2" ]] || fail 'Billing clean restore lost active generation-2 identity'
	redump="$TEMP_ROOT/billing-redump.dump"
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$BILLING_CONTAINER" pg_dump --format=custom \
		--no-owner --no-privileges --no-password --username "$ADMIN_USER" \
		--dbname winwidget_billing >"$redump"
	[[ -s "$redump" ]] || fail 'restored Billing database cannot be dumped again'
	write_restore_evidence pre "$evidence" "$revision" "$previous" "$generation" \
		"$core_sha" "$billing_sha" "$core_source" "$core_restore" \
		"$billing_source" "$billing_restore" "$database_id"
	printf 'billing_core_cleanup_pre_restore=passed\n'
}

rehearse_migration() {
	local port base_url migration_base_url approved_url wrong_url migrations_root
	local previous wrong_previous revision before after migration_sha legacy_options
	local -a hashes=()
	local lock_log writer_log writer_pid attempt visible
	assert_local_docker
	create_temp_root
	create_postgres "$CORE_CONTAINER" "$CORE_VOLUME" default_db core-migration-rehearsal
	port="$(docker port "$CORE_CONTAINER" 5432/tcp 2>/dev/null | awk -F: 'END { print $NF }' || true)"
	if [[ ! "$port" =~ ^[0-9]+$ ]]; then
		# The production restore mode does not publish a port; recreate only this
		# isolated rehearsal container with an ephemeral loopback port.
		docker rm -f "$CORE_CONTAINER" >/dev/null
		CREATED_CORE_CONTAINER=false
		docker run --detach --name "$CORE_CONTAINER" \
			--label com.winwidget.owner=billing --label com.winwidget.purpose=core-migration-rehearsal \
			--label "com.winwidget.rehearsal.run-id=$RUN_ID" --publish 127.0.0.1::5432 \
			--mount "type=volume,source=$CORE_VOLUME,target=/var/lib/postgresql" \
			-e POSTGRES_DB=default_db -e "POSTGRES_USER=$ADMIN_USER" \
			-e "POSTGRES_PASSWORD=$ADMIN_PASSWORD" -e PGDATA=/var/lib/postgresql/18/docker \
			--health-cmd "pg_isready --username $ADMIN_USER --dbname default_db" \
			--health-interval 2s --health-timeout 3s --health-retries 60 "$POSTGRES_IMAGE" >/dev/null
		CREATED_CORE_CONTAINER=true
		wait_for_postgres "$CORE_CONTAINER" || fail 'rehearsal PostgreSQL restart failed'
		port="$(docker port "$CORE_CONTAINER" 5432/tcp | awk -F: 'END { print $NF }')"
	fi
	[[ "$port" =~ ^[0-9]+$ ]] || fail 'rehearsal PostgreSQL port is invalid'
	# Historical Campaigns extraction migrations intentionally fail closed during
	# routine deploys. Mirror the established cleanup rehearsal approval so this
	# Billing harness can replay the full tracked baseline before its own boundary.
	legacy_options='-c winwidget.campaigns_contract_cutover=production-destructive-approved -c winwidget.campaigns_forward_boundary=forward-only -c winwidget.campaigns_source_manifest_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -c winwidget.campaigns_telegram_audit_decision=completed -c winwidget.campaigns_telegram_audit_reference=billing-core-cleanup-rehearsal'
	base_url="$(database_url "$port" default_db "$legacy_options")"
	migrations_root="$TEMP_ROOT/prisma-before-cleanup"
	copy_migrations_without_cleanup "$migrations_root"
	DATABASE_URL="$base_url" pnpm exec prisma migrate deploy --schema "$migrations_root/schema.prisma" >/dev/null
	query_database default_db "
DO \$\$
BEGIN
  IF to_regrole('gen_user') IS NULL THEN
    CREATE ROLE gen_user LOGIN PASSWORD '$MIGRATION_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF to_regrole('winwidget_api_runtime') IS NULL THEN CREATE ROLE winwidget_api_runtime NOLOGIN; END IF;
  IF to_regrole('winwidget_maintenance') IS NULL THEN CREATE ROLE winwidget_maintenance NOLOGIN; END IF;
  IF to_regrole('winwidget_backup') IS NULL THEN CREATE ROLE winwidget_backup NOLOGIN; END IF;
END
\$\$;
INSERT INTO public.site_settings (id, updated_at) VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;
DO \$\$
DECLARE generated_count INTEGER;
BEGIN
  SELECT count(*) INTO generated_count
  FROM public.outbox_events
  WHERE event_type = 'billing.settings.source.changed.v1'
    AND status = 'PENDING'::public.\"OutboxEventStatus\";
  IF generated_count <> 1 THEN
    RAISE EXCEPTION 'Expected one generated settings-source Outbox row; found %', generated_count;
  END IF;
  UPDATE public.outbox_events
  SET status='PUBLISHED'::public.\"OutboxEventStatus\", published_at=CURRENT_TIMESTAMP,
      locked_at=NULL, locked_by=NULL, updated_at=CURRENT_TIMESTAMP
  WHERE event_type='billing.settings.source.changed.v1';
  GET DIAGNOSTICS generated_count = ROW_COUNT;
  IF generated_count <> 1 THEN
    RAISE EXCEPTION 'Expected to publish one settings-source Outbox row; changed %', generated_count;
  END IF;
END
\$\$;
" >/dev/null
	# First prove a pristine replay through every tracked migration.
	docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CORE_CONTAINER" createdb \
		--username "$ADMIN_USER" pristine_bootstrap
	DATABASE_URL="$(database_url "$port" pristine_bootstrap "$legacy_options")" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	[[ "$(target_table_count "$CORE_CONTAINER" pristine_bootstrap)" == '0' &&
		"$(legacy_settings_count "$CORE_CONTAINER" pristine_bootstrap)" == '0' ]] ||
		fail 'pristine bootstrap did not reach the cleanup schema'
	previous='1111111111111111111111111111111111111111'
	wrong_previous='3333333333333333333333333333333333333333'
	revision='2222222222222222222222222222222222222222'
	for character in a b c d e f 1 2; do hashes+=("$(printf "$character%.0s" {1..64})"); done
	query_database default_db "
UPDATE public.billing_core_state
SET ownership='BILLING'::public.\"BillingCoreOwnership\",
    source_producers_enabled=FALSE, legacy_routes_enabled=FALSE,
    scheduler_enabled=FALSE, legacy_consumer_enabled=FALSE,
    projection_consumer_enabled=TRUE, generation=2,
    prepared_revision='$previous', ownership_revision='$previous',
    activated_at=CURRENT_TIMESTAMP
WHERE id='singleton';
ALTER SCHEMA public OWNER TO gen_user;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO winwidget_api_runtime, winwidget_maintenance, winwidget_backup;
DO \$\$
DECLARE object_record RECORD;
BEGIN
  FOR object_record IN
    SELECT namespace.nspname, relation.relname, relation.relkind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','S')
  LOOP
    IF object_record.relkind='S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO gen_user', object_record.nspname, object_record.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO gen_user', object_record.nspname, object_record.relname);
    END IF;
  END LOOP;
  FOR object_record IN
    SELECT namespace.nspname, type_definition.typname
    FROM pg_catalog.pg_type AS type_definition
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=type_definition.typnamespace
    WHERE namespace.nspname='public' AND type_definition.typtype='e'
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO gen_user', object_record.nspname, object_record.typname);
  END LOOP;
  FOR object_record IN
    SELECT function_definition.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=function_definition.pronamespace
    WHERE namespace.nspname='public' AND function_definition.prokind='f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO gen_user', object_record.signature);
  END LOOP;
END
\$\$;
" >/dev/null
	for relation in "${TARGET_TABLES[@]}"; do
		query_database default_db "GRANT ALL PRIVILEGES ON TABLE public.\"$relation\" TO PUBLIC, winwidget_api_runtime, winwidget_maintenance; GRANT SELECT ON TABLE public.\"$relation\" TO winwidget_backup;" >/dev/null
	done
	query_database default_db "GRANT EXECUTE ON FUNCTION
  public.billing_assert_legacy_table_write_enabled(),
  public.billing_assert_legacy_settings_write_enabled(),
  public.billing_settings_projection_trigger(),
  public.reporting_payment_projection_trigger(),
  public.reporting_subscription_projection_trigger()
TO PUBLIC, winwidget_api_runtime, winwidget_maintenance, winwidget_backup;" >/dev/null
	migration_base_url="$(connection_url "$port" default_db gen_user "$MIGRATION_PASSWORD")"
	# Missing and wrong evidence execute the exact migration transaction and may
	# not change either schema or populated rows.
	before="$(target_table_count "$CORE_CONTAINER" default_db)|$(legacy_settings_count "$CORE_CONTAINER" default_db)"
	if apply_sql_file default_db "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql" >/dev/null 2>&1; then
		fail 'cleanup migration accepted missing evidence'
	fi
	after="$(target_table_count "$CORE_CONTAINER" default_db)|$(legacy_settings_count "$CORE_CONTAINER" default_db)"
	[[ "$after" == "$before" ]] || fail 'missing-evidence cleanup attempt mutated the schema'
	wrong_url="$(billing_core_source_cleanup_migration_url "$migration_base_url" 2 "$wrong_previous" "$revision" \
		"${hashes[0]}" "${hashes[1]}" "${hashes[2]}" "${hashes[3]}" \
		"${hashes[4]}" "${hashes[5]}" "${hashes[6]}" "${hashes[7]}")" ||
		fail 'could not build wrong-evidence cleanup URL'
	if DATABASE_URL="$wrong_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null 2>&1; then
		fail 'cleanup migration accepted an ownership revision from the wrong evidence boundary'
	fi
	after="$(target_table_count "$CORE_CONTAINER" default_db)|$(legacy_settings_count "$CORE_CONTAINER" default_db)"
	[[ "$after" == "$before" ]] || fail 'wrong-evidence cleanup attempt mutated the schema'
	DATABASE_URL="$migration_base_url" pnpm exec prisma migrate resolve --rolled-back "$MIGRATION_NAME" \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	approved_url="$(billing_core_source_cleanup_migration_url "$migration_base_url" 2 "$previous" "$revision" \
		"${hashes[0]}" "${hashes[1]}" "${hashes[2]}" "${hashes[3]}" \
		"${hashes[4]}" "${hashes[5]}" "${hashes[6]}" "${hashes[7]}")" ||
		fail 'could not build exact 14-GUC cleanup URL'
	# An unresolved failure must roll the whole transaction back even with all
	# evidence settings present.
	query_database default_db "INSERT INTO public.integration_delivery_failures
  (id,event_id,integration,routing_key,payload,attempts,last_error,failed_at,created_at,updated_at,
   category,normalized_code,safe_reason,retryable,classification_version,first_failed_at)
VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  'auto-renewal','test','{}',1,'test',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
  'TRANSIENT','test','test',TRUE,1,CURRENT_TIMESTAMP);" >/dev/null
	if DATABASE_URL="$approved_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null 2>&1; then
		fail 'approved cleanup accepted unresolved delivery failure'
	fi
	[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '9' ]] ||
		fail 'failed approved cleanup mutated legacy source'
	[[ "$(query_database default_db "SELECT has_table_privilege('winwidget_api_runtime','public.payments','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('winwidget_maintenance','public.payments','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('winwidget_backup','public.payments','SELECT') AND has_function_privilege('winwidget_api_runtime','public.billing_assert_legacy_table_write_enabled()','EXECUTE') AND has_function_privilege('winwidget_maintenance','public.billing_assert_legacy_settings_write_enabled()','EXECUTE') AND has_function_privilege('winwidget_backup','public.reporting_subscription_projection_trigger()','EXECUTE');")" == 't' ]] ||
		fail 'failed approved cleanup did not roll back its ACL convergence'
	query_database default_db "UPDATE public.integration_delivery_failures SET resolved_at=CURRENT_TIMESTAMP, resolution='DELIVERED', active_retry_token=NULL WHERE id='11111111-1111-4111-8111-111111111111';" >/dev/null
	DATABASE_URL="$migration_base_url" pnpm exec prisma migrate resolve --rolled-back "$MIGRATION_NAME" \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	# The second delivery drain family is independently guarded for active
	# PROCESSING/RETRY_SCHEDULED receipts.
	query_database default_db "INSERT INTO public.integration_delivery_receipts
  (id,event_id,integration,status,locked_at,delivered_at,retry_attempt,retry_available_at,retry_token,created_at)
VALUES ('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666',
  'notification-delivery-outcome','PROCESSING',CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP);" >/dev/null
	if DATABASE_URL="$approved_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null 2>&1; then
		fail 'approved cleanup accepted an active delivery receipt'
	fi
	[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '9' ]] ||
		fail 'active-receipt cleanup attempt mutated legacy source'
	DATABASE_URL="$migration_base_url" pnpm exec prisma migrate resolve --rolled-back "$MIGRATION_NAME" \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	query_database default_db "UPDATE public.integration_delivery_receipts SET status='DELIVERED', delivered_at=CURRENT_TIMESTAMP, retry_attempt=NULL, retry_available_at=NULL, retry_token=NULL WHERE id='55555555-5555-4555-8555-555555555555';" >/dev/null
	# Racing writer: the migration must wait for its ACCESS EXCLUSIVE lock and
	# then roll back when the committed race makes a drain guard non-zero.
	lock_log="$TEMP_ROOT/lock.log"
	writer_log="$TEMP_ROOT/writer.log"
	(
		docker exec -e "PGPASSWORD=$ADMIN_PASSWORD" "$CORE_CONTAINER" psql --no-psqlrc \
			--set ON_ERROR_STOP=1 --username "$ADMIN_USER" --dbname default_db --command \
			"BEGIN; LOCK TABLE public.integration_delivery_failures IN ROW EXCLUSIVE MODE; SELECT pg_sleep(3); INSERT INTO public.integration_delivery_failures (id,event_id,integration,routing_key,payload,attempts,last_error,failed_at,created_at,updated_at,category,normalized_code,safe_reason,retryable,classification_version,first_failed_at) VALUES ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','notification-delivery-outcome','test','{}',1,'test',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'TRANSIENT','test','test',TRUE,1,CURRENT_TIMESTAMP); COMMIT;"
	) >"$writer_log" 2>&1 &
	writer_pid=$!
	visible=false
	for ((attempt = 1; attempt <= 40; attempt++)); do
		if [[ "$(query_database default_db "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE 'BEGIN; LOCK TABLE public.integration_delivery_failures%' AND query LIKE '%pg_sleep(3)%' AND state='active';")" == '1' ]]; then
			visible=true
			break
		fi
		sleep 0.1
	done
	[[ "$visible" == 'true' ]] || fail 'racing writer did not hold the migration relation'
	if DATABASE_URL="$approved_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >"$lock_log" 2>&1; then
		wait "$writer_pid" || true
		fail 'racing writer crossed the cleanup guard'
	fi
	wait "$writer_pid" || fail 'racing writer fixture failed'
	[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '9' ]] ||
		fail 'racing-writer cleanup attempt mutated legacy source'
	query_database default_db "UPDATE public.integration_delivery_failures SET resolved_at=CURRENT_TIMESTAMP, resolution='DELIVERED', active_retry_token=NULL WHERE id='33333333-3333-4333-8333-333333333333';" >/dev/null
	# Resolve the racing attempt exactly as production, then the approved
	# populated path must remove only legacy data.
	while [[ "$(query_database default_db "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME' AND finished_at IS NULL AND rolled_back_at IS NULL;")" != '0' ]]; do
		DATABASE_URL="$migration_base_url" pnpm exec prisma migrate resolve --rolled-back "$MIGRATION_NAME" \
			--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	done
	[[ "$(query_database default_db "SELECT count(*) FROM public.outbox_events WHERE event_type IN ('billing.settings.source.changed.v1','billing.payment.changed.v1','billing.subscription.changed.v1','notification.subscription-expiry.email.requested.v1','notification.subscription-expiry.telegram.requested.v1','payment.auto-renewal.charge.requested.v1','payment.notification.telegram.requested.v1','payment.succeeded.v1') AND status <> 'PUBLISHED'::public.\"OutboxEventStatus\";")" == '0' ]] ||
		fail 'legacy Billing Outbox fixture is not drained before approved cleanup'
	DATABASE_URL="$approved_url" pnpm exec prisma migrate deploy \
		--schema "$SOURCE_ROOT/prisma/schema.prisma" >/dev/null
	[[ "$(target_table_count "$CORE_CONTAINER" default_db)" == '0' &&
		"$(legacy_settings_count "$CORE_CONTAINER" default_db)" == '0' ]] ||
		fail 'approved populated cleanup did not remove exact legacy source'
	[[ "$(query_database default_db "SELECT count(*) FROM public.integration_delivery_failures WHERE id IN ('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333');")" == '2' ]] ||
		fail 'approved cleanup changed retained Core integration state'
	[[ "$(query_database default_db "SELECT count(*) FROM public.integration_delivery_receipts WHERE id='55555555-5555-4555-8555-555555555555' AND status='DELIVERED'::public.\"IntegrationDeliveryReceiptStatus\" AND delivered_at IS NOT NULL;")" == '1' ]] ||
		fail 'approved cleanup changed retained Core delivery receipt state'
	migration_sha="$(sha256_file "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql")"
	[[ "$(query_database default_db "SELECT count(*) FROM public.\"_prisma_migrations\" WHERE migration_name='$MIGRATION_NAME' AND checksum='$migration_sha' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")" == '1' ]] ||
		fail 'approved cleanup lacks the exact successful migration ledger'
	[[ "$(query_database default_db "SELECT count(*) FROM unnest(ARRAY['public.billing_core_state_transition_guard()','public.billing_core_source_producers_enabled()','public.billing_core_ownership_active()','public.billing_iso_timestamp(timestamp without time zone)','public.billing_record_source_event(text,text,text,text,jsonb,boolean)','public.billing_emit_identity_projection(text,boolean)','public.billing_identity_user_projection_trigger()','public.billing_identity_auth_projection_trigger()','public.billing_identity_telegram_projection_trigger()','public.billing_notification_routing_projection_trigger()','public.billing_offer_projection_trigger()']) AS retained(signature) JOIN pg_catalog.pg_proc AS function_definition ON function_definition.oid=to_regprocedure(retained.signature) JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid=function_definition.proowner WHERE owner_role.rolname='gen_user';")" == '11' ]] ||
		fail 'approved cleanup removed or changed ownership of a retained producer function'
	[[ "$(query_database default_db "SELECT count(*) FROM pg_catalog.pg_proc AS function_definition JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=function_definition.pronamespace WHERE namespace.nspname='public' AND function_definition.proname IN ('billing_assert_legacy_table_write_enabled','billing_assert_legacy_settings_write_enabled','billing_settings_projection_trigger','reporting_payment_projection_trigger','reporting_subscription_projection_trigger');")" == '0' ]] ||
		fail 'approved cleanup retained an obsolete function ACL surface'
	[[ "$(query_database default_db "SELECT count(*) FROM pg_catalog.pg_class AS relation JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid=relation.relowner WHERE namespace.nspname='public' AND relation.relname IN ('site_settings','_prisma_migrations') AND owner_role.rolname='gen_user';")" == '2' ]] ||
		fail 'approved cleanup changed the exact migration ownership boundary'
	[[ "$(query_database default_db "SELECT count(*) FROM public.billing_core_state WHERE id='singleton' AND ownership='BILLING'::public.\"BillingCoreOwnership\" AND generation=2 AND NOT source_producers_enabled AND NOT legacy_routes_enabled AND NOT scheduler_enabled AND NOT legacy_consumer_enabled AND projection_consumer_enabled;")" == '1' ]] ||
		fail 'approved cleanup changed Billing ownership state'
	printf 'billing_core_cleanup_production_migration=passed\n'
}

self_test() {
	local character source deploy migration options count
	local -a hashes=()
	for character in a b c d e f 1 2; do hashes+=("$(printf "$character%.0s" {1..64})"); done
	[[ "${#TARGET_TABLES[@]}" == '9' && "${#LEGACY_SETTINGS_COLUMNS[@]}" == '6' ]]
	[[ "$(printf '%s\n' "${TARGET_TABLES[@]}" | sort -u | wc -l | tr -d '[:space:]')" == '9' ]]
	[[ -f "$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql" ]]
	migration="$(<"$SOURCE_ROOT/prisma/migrations/$MIGRATION_NAME/migration.sql")"
	for option in billing_core_source_cleanup billing_ownership_phase billing_ownership_generation \
		billing_ownership_revision billing_cleanup_revision billing_source_snapshot_sha256 \
		billing_core_backup_sha256 billing_backup_sha256 billing_restore_evidence_sha256 \
		billing_offsite_receipt_sha256 billing_queue_drain_evidence_sha256 \
		billing_stopped_writers_evidence_sha256 billing_retention_decision billing_retention_reference; do
		[[ "$migration" == *"winwidget.$option"* ]] || fail "migration GUC missing: $option"
	done
	count="$(MIGRATION_SOURCE="$migration" billing_release_node -e '
const keys = [...process.env.MIGRATION_SOURCE.matchAll(/winwidget\.(billing_[a-z0-9_]+)/g)].map(match => match[1]);
process.stdout.write(String(new Set(keys).size));
')"
	[[ "$count" == '14' ]] || fail 'migration must reference exactly 14 cleanup GUCs'
	[[ "$migration" == *"'auto-renewal',"* && "$migration" == *"'notification-delivery-outcome'"* ]]
	[[ "$(billing_core_source_cleanup_recovery_action present pending)" == 'restore-exact' &&
		"$(billing_core_source_cleanup_recovery_action present unfinished)" == 'restore-exact' &&
		"$(billing_core_source_cleanup_recovery_action absent unfinished)" == 'forward-only' &&
		"$(billing_core_source_cleanup_recovery_action absent applied)" == 'forward-only' &&
		"$(billing_core_source_cleanup_recovery_action partial unfinished)" == 'halt' ]]
	options="$(billing_core_source_cleanup_migration_url \
		'postgresql://user:pass@127.0.0.1:5432/default_db?schema=public' 2 \
		'1111111111111111111111111111111111111111' '2222222222222222222222222222222222222222' \
		"${hashes[0]}" "${hashes[1]}" "${hashes[2]}" "${hashes[3]}" \
		"${hashes[4]}" "${hashes[5]}" "${hashes[6]}" "${hashes[7]}")"
	OPTIONS_URL="$options" billing_release_node - <<'NODE'
const url = new URL(process.env.OPTIONS_URL);
const options = url.searchParams.get('options') || '';
const pairs = [...options.matchAll(/-c winwidget\.([a-z0-9_]+)=([^ ]+)/g)]
  .map(match => [match[1], match[2]]);
const values = new Map(pairs);
const expected = new Map([
  ['billing_source_snapshot_sha256', 'a'.repeat(64)],
  ['billing_core_backup_sha256', 'b'.repeat(64)],
  ['billing_backup_sha256', 'c'.repeat(64)],
  ['billing_restore_evidence_sha256', 'd'.repeat(64)],
  ['billing_offsite_receipt_sha256', 'e'.repeat(64)],
  ['billing_queue_drain_evidence_sha256', 'f'.repeat(64)],
  ['billing_stopped_writers_evidence_sha256', '1'.repeat(64)],
  ['billing_retention_reference', '2'.repeat(64)],
]);
if (pairs.length !== 14 || values.size !== 14) process.exit(1);
for (const [key, value] of expected) if (values.get(key) !== value) process.exit(1);
NODE
	deploy="$(<"$SOURCE_ROOT/scripts/deploy-production.sh")"
	for token in 'present|unfinished' 'resolve --rolled-back' 'absent|unfinished' \
		'resolve --applied' 'billing_core_cleanup_delete_retired_outcome_queues' \
		'billing_core_cleanup_require_stopped_queue_boundary true' \
		'billing_core_cleanup_validate_staged_manifests'; do
		[[ "$deploy" == *"$token"* ]] || fail "deploy recovery regression token missing: $token"
	done
	[[ "$deploy" == *"item.consumers !== 0"* ]] || fail 'deploy manifest does not require all staged consumers zero'
	DEPLOY_FILE="$SOURCE_ROOT/scripts/deploy-production.sh" node <<'NODE'
const source = require('node:fs').readFileSync(process.env.DEPLOY_FILE, 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) process.exit(1);
  return source.slice(from, to);
};
const queue = section('billing_core_cleanup_require_stopped_queue_boundary() {',
  'billing_core_cleanup_delete_retired_outcome_queues() {');
const retire = section('billing_core_cleanup_delete_retired_outcome_queues() {',
  'billing_core_cleanup_require_retired_outcome_absent() {');
const recovery = section('recover_billing_core_cleanup_stop_on_exit() {',
  'stop_routine_topology_for_core_migration() {');
const migration = section("if [[ \"$billing_core_cleanup_runtime_deploy\" == 'true' ]]; then",
  "elif [[ \"$reporting_cleanup_runtime_deploy\" == 'true' &&");
for (const token of [
  'process.env.BILLING_ALLOW_RETIRED_ABSENT === "true"',
  'if (values[2] !== 0) process.exit(1)',
  'else if (values.some(value => value !== 0)) process.exit(1)',
  'present.length === retired.length ? "present" : "partial"',
]) if (!queue.includes(token)) process.exit(1);
if (!retire.includes("retired_state === 'partial'") &&
    (!retire.includes("retired_state=\"$(billing_core_cleanup_require_stopped_queue_boundary true)\"") ||
     !retire.includes("for queue in"))) process.exit(1);
for (const token of [
  "'present|unfinished'", 'migrate resolve --rolled-back',
  "'absent|unfinished'", 'migrate resolve --applied',
  "billing_core_cleanup_migration_state\" =~ ^(pending|rolled-back)$",
]) if (!migration.includes(token)) process.exit(1);
if (!recovery.includes('sealed SHA A writers remain stopped for an exact retry') ||
    recovery.includes('restore_routine_containers_after_failed_stop') ||
    recovery.includes('docker start') || recovery.includes('compose_target up')) process.exit(1);
if (!source.includes("\"$reporting_cleanup_runtime_deploy\" != 'true' &&\n\t\t\t\t\"$billing_core_cleanup_runtime_deploy\" != 'true'")) process.exit(1);
NODE
	source="$(<"$SOURCE_ROOT/scripts/cleanup-billing-core-source-production.sh")"
	[[ "$source" == *"exact SHA A writers remain intentionally stopped"* &&
		"$source" == *'validate_live_broker_from_queue_evidence'* &&
		"$source" == *'--status|--self-test|--stage|--seal-offsite|--run|--complete-offsite'* &&
		"$source" == *'restop_stage_writers_after_failed_recovery'* &&
		"$source" == *'unbound artifacts were archived and the recovery manifest was retained'* &&
		"$source" != *'purge_completed_raw_evidence'* ]]
	printf 'billing_core_cleanup_rehearsal_self_test=passed\n'
}

case "${1:-}" in
--verify-dumps)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	trap cleanup EXIT INT TERM
	verify_dumps
	;;
--verify-core-dump)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	trap cleanup EXIT INT TERM
	verify_core_dump post
	printf 'billing_core_cleanup_post_restore=passed\n'
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
	echo 'Usage: test-billing-core-source-cleanup-rehearsal.sh --self-test|--rehearsal|--verify-dumps|--verify-core-dump' >&2
	exit 64
	;;
esac
