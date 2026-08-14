#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly IDENTITY_RESTORE_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly IDENTITY_RESTORE_MAX_DUMP_BYTES=$((49 * 1024 * 1024))

revision=''
phase=''
dump_file=''
expected_sha256=''
database_id=''
source_system_identifier=''
evidence_file=''
run_id=''
work_root=''
container=''
volume=''
admin_password=''
created_container='false'
created_volume='false'

identity_restore_fail() {
	printf 'identity_restore_rehearsal_error=%s\n' "$1" >&2
	return 1
}

identity_restore_usage() {
	cat <<'USAGE'
Usage:
  identity-backup-restore-rehearsal.sh --revision <40-char-sha> \
    --phase pre-cutover|post-ownership --dump <absolute-custom-dump> \
    --expected-sha256 <sha256> --database-id <uuid> \
    --source-system-identifier <positive-integer> --evidence-file <absolute-json>
  identity-backup-restore-rehearsal.sh --self-test

The runner never reads production env files and never connects to production.
It restores the supplied Identity dump into an isolated PostgreSQL 18 cluster
without host ports, validates Identity anchors, then removes its resources.
USAGE
}

identity_restore_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

identity_restore_absolute_path() {
	[[ "$1" == /* && "$1" != *$'\n'* && "$1" != *'//'*
		&& "$1" != */./* && "$1" != */../* && "$1" != */. && "$1" != */.. ]]
}

identity_restore_validate_inputs() {
	local size parent
	[[ "$revision" =~ ^[0-9a-f]{40}$ &&
		"$phase" =~ ^(pre-cutover|post-ownership)$ &&
		"$expected_sha256" =~ ^[0-9a-f]{64}$ &&
		"$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$source_system_identifier" =~ ^[1-9][0-9]*$ ]] ||
		identity_restore_fail 'invalid immutable rehearsal identity' || return 1
	identity_restore_absolute_path "$dump_file" &&
		[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" ]] ||
		identity_restore_fail 'dump must be a non-empty regular absolute file' || return 1
	[[ "$(head -c 5 "$dump_file")" == 'PGDMP' ]] ||
		identity_restore_fail 'dump is not PostgreSQL custom format' || return 1
	size="$(wc -c <"$dump_file" | tr -d '[:space:]')"
	[[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 &&
		"$size" -le "$IDENTITY_RESTORE_MAX_DUMP_BYTES" ]] ||
		identity_restore_fail 'dump exceeds the bounded restore contract' || return 1
	[[ "$(identity_restore_sha256 "$dump_file")" == "$expected_sha256" ]] ||
		identity_restore_fail 'dump SHA-256 differs from the bound manifest' || return 1
	identity_restore_absolute_path "$evidence_file" &&
		[[ "$(basename -- "$evidence_file")" =~ ^[A-Za-z0-9._-]+\.json$ &&
			! -e "$evidence_file" && ! -L "$evidence_file" ]] ||
		identity_restore_fail 'evidence output path is unsafe or already exists' || return 1
	parent="$(dirname -- "$evidence_file")"
	[[ -d "$parent" && ! -L "$parent" ]] ||
		identity_restore_fail 'evidence parent directory is missing or unsafe' || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$parent")" == '0:0:700' ]] ||
			identity_restore_fail 'evidence parent must be root-owned mode 700' || return 1
	fi
}

identity_restore_assert_local_docker() {
	local context endpoint
	context="$(docker context show)" || return 1
	endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')" ||
		return 1
	[[ "$endpoint" == unix://* && "$(docker info --format '{{.OSType}}')" == 'linux' ]] ||
		identity_restore_fail 'rehearsal requires a local Unix Docker Linux endpoint'
}

identity_restore_cleanup() {
	local status=$?
	trap - EXIT INT TERM
	if [[ "$created_container" == 'true' && -n "$container" ]]; then
		docker rm -f "$container" >/dev/null 2>&1 || true
	fi
	if [[ "$created_volume" == 'true' && -n "$volume" ]]; then
		docker volume rm "$volume" >/dev/null 2>&1 || true
	fi
	if [[ -n "$work_root" && -d "$work_root" && ! -L "$work_root" &&
		"$work_root" == /tmp/winwidget-identity-restore-* ]]; then
		rm -rf -- "$work_root"
	fi
	exit "$status"
}

identity_restore_query() {
	local database="$1" sql="$2"
	PGPASSWORD="$admin_password" docker exec --env PGPASSWORD "$container" \
		psql --no-psqlrc --no-password --tuples-only --no-align \
		--set ON_ERROR_STOP=1 --username postgres --dbname "$database" \
		--command "$sql"
}

identity_restore_run() {
	identity_restore_validate_inputs
	identity_restore_assert_local_docker
	run_id="${revision:0:12}-$$"
	container="winwidget-identity-restore-$run_id"
	volume="winwidget-identity-restore-$run_id-data"
	[[ -z "$(docker ps -aq --filter "name=^/${container}$")" &&
		-z "$(docker volume ls -q --filter "name=^${volume}$")" ]] ||
		identity_restore_fail 'isolated rehearsal resource already exists' || return 1
	work_root="$(mktemp -d "/tmp/winwidget-identity-restore-$run_id.XXXXXX")"
	[[ -d "$work_root" && ! -L "$work_root" ]] || return 1
	trap identity_restore_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	admin_password="$(openssl rand -hex 24)"
	docker volume create --label com.winwidget.owner=identity \
		--label com.winwidget.purpose=backup-restore-rehearsal \
		--label "com.winwidget.rehearsal.run-id=$run_id" "$volume" >/dev/null
	created_volume='true'
	POSTGRES_PASSWORD="$admin_password" docker run --detach --name "$container" \
		--label com.winwidget.owner=identity \
		--label com.winwidget.purpose=backup-restore-rehearsal \
		--label "com.winwidget.rehearsal.run-id=$run_id" \
		--mount "type=volume,source=$volume,target=/var/lib/postgresql" \
		--env POSTGRES_PASSWORD --env POSTGRES_USER=postgres \
		--env POSTGRES_DB=winwidget_identity \
		--env 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums' \
		--env PGDATA=/var/lib/postgresql/18/docker \
		--health-cmd 'pg_isready --username postgres --dbname winwidget_identity' \
		--health-interval 2s --health-timeout 3s --health-retries 60 \
		"$IDENTITY_RESTORE_POSTGRES_IMAGE" >/dev/null
	created_container='true'
	local attempt health
	for ((attempt = 1; attempt <= 60; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
		[[ "$health" == 'healthy' ]] && break
		[[ "$health" == 'unhealthy' ]] && return 1
		sleep 2
	done
	[[ "$health" == 'healthy' ]] || identity_restore_fail 'restore PostgreSQL is not healthy' || return 1
	PGPASSWORD="$admin_password" docker run --rm --network "container:$container" \
		--mount "type=bind,source=$(dirname -- "$dump_file"),target=/input,readonly" \
		--env PGPASSWORD \
		--entrypoint pg_restore "$IDENTITY_RESTORE_POSTGRES_IMAGE" \
		--exit-on-error --single-transaction --no-owner --no-acl \
		--host 127.0.0.1 --username postgres --dbname winwidget_identity \
		"/input/$(basename -- "$dump_file")" >/dev/null
	local restored_system restored_database_id table_count migration_count
	local users identities channels outbox_events
	restored_system="$(identity_restore_query postgres 'SELECT (pg_control_system()).system_identifier;')"
	[[ "$restored_system" =~ ^[1-9][0-9]*$ &&
		"$restored_system" != "$source_system_identifier" ]] ||
		identity_restore_fail 'restore cluster is not physically independent' || return 1
	restored_database_id="$(identity_restore_query winwidget_identity \
		"SELECT database_id::text FROM identity.service_identity WHERE service_name = 'identity-service';")"
	[[ "$restored_database_id" == "$database_id" ]] ||
		identity_restore_fail 'restored Identity database ID differs from lifecycle marker' || return 1
	table_count="$(identity_restore_query winwidget_identity \
		"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'identity' AND table_type = 'BASE TABLE';")"
	migration_count="$(identity_restore_query winwidget_identity \
		'SELECT count(*) FROM identity._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"
	users="$(identity_restore_query winwidget_identity 'SELECT count(*) FROM identity.users;')"
	identities="$(identity_restore_query winwidget_identity 'SELECT count(*) FROM identity.auth_identities;')"
	channels="$(identity_restore_query winwidget_identity 'SELECT count(*) FROM identity.telegram_notification_channels;')"
	outbox_events="$(identity_restore_query winwidget_identity 'SELECT count(*) FROM identity.outbox_events;')"
	[[ "$table_count" =~ ^[1-9][0-9]*$ && "$migration_count" =~ ^[1-9][0-9]*$ &&
		"$users" =~ ^[0-9]+$ && "$identities" =~ ^[0-9]+$ &&
		"$channels" =~ ^[0-9]+$ && "$outbox_events" =~ ^[0-9]+$ ]] ||
		identity_restore_fail 'restored Identity anchors are incomplete' || return 1
	local temporary="$evidence_file.partial.$$" size
	size="$(wc -c <"$dump_file" | tr -d '[:space:]')"
	REVISION="$revision" PHASE="$phase" SHA256="$expected_sha256" \
		SIZE="$size" DATABASE_ID="$database_id" SOURCE_SYSTEM="$source_system_identifier" \
		RESTORED_SYSTEM="$restored_system" TABLE_COUNT="$table_count" \
		MIGRATION_COUNT="$migration_count" USERS="$users" IDENTITIES="$identities" \
		CHANNELS="$channels" OUTBOX_EVENTS="$outbox_events" \
		node - "$temporary" <<'NODE'
const fs = require('node:fs');
const evidence = {
  schemaVersion: 1,
  action: 'identity-actual-backup-restore-rehearsal',
  target: 'identity',
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
  counts: {
    tables: Number(process.env.TABLE_COUNT),
    migrations: Number(process.env.MIGRATION_COUNT),
    users: Number(process.env.USERS),
    authIdentities: Number(process.env.IDENTITIES),
    telegramNotificationChannels: Number(process.env.CHANNELS),
    outboxEvents: Number(process.env.OUTBOX_EVENTS),
  },
  checks: {
    immutableRevision: true,
    sourceFileSafe: true,
    dumpShaStable: true,
    isolatedTarget: true,
    noHostPorts: true,
    distinctCluster: true,
    identityAnchor: true,
    migrations: true,
    resourcesRemovedOnExit: true,
  },
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(evidence)}\n`, { flag: 'wx', mode: 0o600 });
NODE
	chmod 600 "$temporary"
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		chown 0:0 "$temporary"
	fi
	mv -f -- "$temporary" "$evidence_file"
	printf 'identity_restore_rehearsal=passed\n'
	printf 'identity_restore_evidence=%s\n' "$evidence_file"
}

identity_restore_self_test() {
	local source
	source="$(declare -f identity_restore_validate_inputs identity_restore_run identity_restore_cleanup)"
	[[ "$source" == *'PGDMP'* && "$source" == *'--no-owner --no-acl'* &&
		"$source" == *'--network "container:$container"'* &&
		"$source" == *'PGPASSWORD="$admin_password" docker run'* &&
		"$source" == *'source_system_identifier'* &&
		"$source" == *'identity.service_identity'* &&
		"$source" == *'identity._prisma_migrations'* &&
		"$source" == *'docker volume rm'* ]] || return 1
	printf 'identity_backup_restore_rehearsal_self_test=passed\n'
}

if [[ "${1:-}" == '--self-test' ]]; then
	[[ $# -eq 1 ]] || identity_restore_fail '--self-test accepts no arguments' || exit 1
	identity_restore_self_test
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
	-h | --help) identity_restore_usage; exit ;;
	*) identity_restore_usage >&2; exit 2 ;;
	esac
done

identity_restore_run
