#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PLATFORM_DATABASE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
readonly PLATFORM_DATABASE_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly PLATFORM_DATABASE_POSTGRES_VOLUME='winwidget-platform-postgres-data'
readonly PLATFORM_DATABASE_APP_ROOT='/opt/winwidget'
readonly platform_database_marker="$APP_ROOT/deploy/backend/.platform-database-lifecycle-v1"
platform_database_docker_binary=''

# shellcheck source=scripts/platform-release-identity.sh
declare -F platform_release_compose >/dev/null ||
	source "$PLATFORM_DATABASE_ROOT/scripts/platform-release-identity.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
declare -F database_restore_guard_assert_before_mutation >/dev/null ||
	source "$PLATFORM_DATABASE_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
declare -F acquire_production_deploy_lock >/dev/null ||
	source "$PLATFORM_DATABASE_ROOT/scripts/production-deploy-lock.sh"

platform_database_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

platform_database_require_root() {
	[[ "$(id -u)" == 0 ]] ||
		platform_database_fail 'Platform database lifecycle must run as root.'
}

platform_database_private_directory_mode_allowed() {
	[[ $# -eq 1 && "$1" =~ ^[0-7]{3,4}$ ]] &&
		(( (8#$1 & 0022) == 0 ))
}

platform_database_require_marker_path() {
	[[ -z "${PLATFORM_DATABASE_MARKER+x}" && "$APP_ROOT" == "$PLATFORM_DATABASE_APP_ROOT" &&
		"$ENV_FILE" == "$APP_ROOT/deploy/backend/.env.production" &&
		"$SERVER_ROOT" == "$APP_ROOT/winwidget.ru_server" &&
		"$COMPOSE_FILE" == "$SERVER_ROOT/deploy/docker-compose.prod.yml" &&
		"$platform_database_marker" == "$APP_ROOT/deploy/backend/.platform-database-lifecycle-v1" ]] ||
		platform_database_fail 'Platform database lifecycle paths are not the canonical production paths.' || return 1
	local directory canonical metadata owner group mode
	directory="$(dirname -- "$platform_database_marker")"
	[[ -d "$directory" && ! -L "$directory" ]] ||
		platform_database_fail 'Platform database marker directory is missing or unsafe.' || return 1
	canonical="$(realpath -e -- "$directory")" || return 1
	[[ "$canonical" == "$directory" ]] ||
		platform_database_fail 'Platform database marker directory is not canonical.' || return 1
	if [[ "$(uname -s)" == Linux ]]; then
		metadata="$(stat -c '%u:%g:%a' "$directory")" || return 1
		IFS=: read -r owner group mode <<<"$metadata"
		[[ "$owner" == 0 && "$group" == 0 ]] || return 1
		platform_database_private_directory_mode_allowed "$mode" ||
			platform_database_fail 'Platform database marker directory is writable outside root.' || return 1
	fi
}

platform_database_require_local_docker() {
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" &&
		-z "${DOCKER_CONFIG+x}" && -z "${DOCKER_TLS_VERIFY+x}" &&
		-z "${DOCKER_CERT_PATH+x}" && -z "${DOCKER_API_VERSION+x}" ]] ||
		platform_database_fail 'Platform lifecycle refuses ambient Docker endpoint overrides.' || return 1
	local docker_binary
	docker_binary="$(type -P docker 2>/dev/null || true)"
	[[ -n "$docker_binary" && "$docker_binary" == /* &&
		"$docker_binary" =~ ^/[A-Za-z0-9._/@:+-]+$ && -f "$docker_binary" &&
		! -L "$docker_binary" && -x "$docker_binary" ]] ||
		platform_database_fail 'Platform lifecycle requires a trusted Docker CLI binary.' || return 1
	[[ "$("$docker_binary" context show)" == default &&
		"$("$docker_binary" context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$("$docker_binary" info --format '{{.OSType}}')" == linux ]] ||
		platform_database_fail 'Platform lifecycle requires the local Linux Docker socket.' || return 1
	platform_database_docker_binary="$docker_binary"
}

platform_database_docker() {
	[[ -n "$platform_database_docker_binary" ]] ||
		platform_database_require_local_docker || return 1
	"$platform_database_docker_binary" "$@"
}

platform_database_require_no_ambient_env_overrides() {
	local key
	while IFS= read -r key; do
		[[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
		case "$key" in
		APP_ROOT | ENV_FILE | SERVER_ROOT | EXPECTED_REVISION | PLATFORM_ABORT_CONFIRMATION | \
			PLATFORM_CONFIRMATION | PLATFORM_ACTION | WINWIDGET_PRODUCTION_DEPLOY_LOCK_HELD | \
			PRODUCTION_DEPLOY_LOCK_FD | PRODUCTION_DEPLOY_LOCK_FILE) continue ;;
		esac
		if awk -F= -v expected="$key" '$1 == expected { found = 1 } END { exit(found ? 0 : 1) }' \
			"$ENV_FILE"; then
			platform_database_fail "Ambient environment overrides production env key: $key"
			return 1
		fi
	done < <(compgen -e)
}

platform_database_require_inputs() {
	platform_release_validate_revision "$EXPECTED_REVISION" || return 1
	platform_release_validate_file "$ENV_FILE" || return 1
	platform_release_validate_file "$COMPOSE_FILE" || return 1
	platform_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION" || return 1
	platform_database_require_marker_path || return 1
	platform_database_require_no_ambient_env_overrides || return 1
	platform_database_require_local_docker || return 1
	[[ "${PRODUCTION_DEPLOY_LOCK_FILE:-$APP_ROOT/deploy/backend/.production-deploy.lock}" == \
		"$APP_ROOT/deploy/backend/.production-deploy.lock" ]] ||
		platform_database_fail 'Platform lifecycle requires the canonical shared production lock.' || return 1
	local key platform_core_token
	for key in PLATFORM_POSTGRES_IMAGE PLATFORM_POSTGRES_PORT \
		PLATFORM_POSTGRES_DATA_VOLUME PLATFORM_POSTGRES_ADMIN_USER \
		PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE PLATFORM_DATABASE_URL \
		PLATFORM_MIGRATION_DATABASE_URL PLATFORM_BACKUP_URL \
		PLATFORM_API_PORT PLATFORM_OUTBOX_PUBLISHER_PORT \
		PLATFORM_INTERNAL_BASE_URL PLATFORM_CORE_TOKEN PLATFORM_INTERNAL_TIMEOUT_MS \
		PLATFORM_OUTBOX_BATCH_SIZE PLATFORM_OUTBOX_POLL_INTERVAL_MS \
		PLATFORM_OUTBOX_RETENTION_DAYS \
		IDENTITY_INTERNAL_BASE_URL IDENTITY_PLATFORM_TOKEN \
		RABBITMQ_PLATFORM_PUBLISHER_URL GATEWAY_ROUTES_JSON COMPOSE_PROJECT_NAME; do
		[[ -n "$(platform_read_env_value "$ENV_FILE" "$key")" ]] ||
			platform_database_fail "Platform database env key is missing: $key" || return 1
	done
	[[ "$(platform_read_env_value "$ENV_FILE" PLATFORM_POSTGRES_IMAGE)" == "$PLATFORM_DATABASE_POSTGRES_IMAGE" &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_POSTGRES_DATA_VOLUME)" == "$PLATFORM_DATABASE_POSTGRES_VOLUME" &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_POSTGRES_PORT)" == 55439 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_POSTGRES_ADMIN_USER)" == winwidget_platform_admin &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_API_PORT)" == 5000 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_OUTBOX_PUBLISHER_PORT)" == 5001 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_INTERNAL_BASE_URL)" == http://127.0.0.1:5000 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_INTERNAL_TIMEOUT_MS)" == 5000 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_OUTBOX_BATCH_SIZE)" == 50 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_OUTBOX_POLL_INTERVAL_MS)" == 1000 &&
		"$(platform_read_env_value "$ENV_FILE" PLATFORM_OUTBOX_RETENTION_DAYS)" == 7 &&
		"$(platform_read_env_value "$ENV_FILE" COMPOSE_PROJECT_NAME)" == winwidget ]] ||
		platform_database_fail 'Platform PostgreSQL, loopback boundary, settings, volume, or project differ from the canonical release contract.' || return 1
	platform_core_token="$(platform_read_env_value "$ENV_FILE" PLATFORM_CORE_TOKEN)" || return 1
	[[ ${#platform_core_token} -ge 32 && "$platform_core_token" != change_me* &&
		"$platform_core_token" != change-me* && "$platform_core_token" != ci_* &&
		"$platform_core_token" != "$(platform_read_env_value "$ENV_FILE" IDENTITY_PLATFORM_TOKEN)" ]] ||
		platform_database_fail 'Platform Core credential is missing, placeholder, or not audience-scoped.'
}

platform_database_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ && -f "$platform_database_marker" &&
		! -L "$platform_database_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$platform_database_marker"
}

platform_database_validate_marker() {
	platform_database_require_marker_path || return 1
	[[ -f "$platform_database_marker" && ! -L "$platform_database_marker" ]] || return 1
	if [[ "$(uname -s)" == Linux ]]; then
		[[ "$(stat -c '%u:%g:%a' "$platform_database_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= -v expected_volume="$PLATFORM_DATABASE_POSTGRES_VOLUME" '
		$1 !~ /^(version|phase|revision|generation|volume|image_id|database_id|database_system_identifier|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != 9 || seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] !~ /^(preparing|prepared|aborted|active|complete)$/ ||
				seen["revision"] != 1 || value["revision"] !~ /^[0-9a-f]{40}$/ ||
				seen["generation"] != 1 || value["generation"] !~ /^[1-9][0-9]{0,17}$/ ||
				seen["volume"] != 1 || value["volume"] != expected_volume ||
				seen["image_id"] != 1 || value["image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["database_id"] != 1 || value["database_id"] !~ /^(pending|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/ ||
				seen["database_system_identifier"] != 1 || value["database_system_identifier"] !~ /^(pending|[1-9][0-9]*)$/ ||
				seen["updated_at"] != 1 || length(value["updated_at"]) != 20 ||
				value["updated_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) exit 1
			if ((value["database_id"] == "pending") != (value["database_system_identifier"] == "pending")) exit 1
			if (value["phase"] ~ /^(prepared|active|complete)$/ &&
				value["database_id"] == "pending") exit 1
		}
	' "$platform_database_marker"
}

platform_database_current_phase() {
	platform_database_require_marker_path || return 1
	if [[ ! -e "$platform_database_marker" && ! -L "$platform_database_marker" ]]; then
		printf 'absent\n'
		return
	fi
	platform_database_validate_marker || return 1
	platform_database_marker_value phase
}

platform_database_transition_allowed() {
	case "$1:$2" in
	absent:preparing | preparing:preparing | preparing:prepared | prepared:prepared | \
		preparing:aborted | prepared:aborted | prepared:active | active:active | \
		active:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

platform_database_write_marker() {
	[[ $# -eq 7 && "$3" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	local phase="$1" revision="$2" generation="$3" volume="$4" image_id="$5"
	local database_id="$6" system_id="$7"
	local current current_generation current_revision temporary directory
	platform_database_require_marker_path || return 1
	if [[ ! -e "$platform_database_marker" && ! -L "$platform_database_marker" ]]; then
		current=absent
	else
		current="$(platform_database_current_phase)" ||
			platform_database_fail 'Existing Platform database marker is invalid; refusing to treat it as absent.' || return 1
	fi
	platform_database_transition_allowed "$current" "$phase" ||
		platform_database_fail "Unsafe Platform database transition: $current -> $phase" || return 1
	if [[ "$current" == absent ]]; then
		[[ "$phase" == preparing && "$generation" == 1 ]] ||
			platform_database_fail 'The first Platform database attempt must use generation=1.' || return 1
	else
		current_generation="$(platform_database_marker_value generation)" || return 1
		current_revision="$(platform_database_marker_value revision)" || return 1
		[[ "$revision" == "$current_revision" && "$generation" == "$current_generation" ]] ||
			platform_database_fail 'Platform database revision/generation changed within an attempt.' || return 1
	fi
	directory="$(dirname -- "$platform_database_marker")"
	temporary="$(mktemp "$directory/.platform-database-lifecycle-v1.tmp.XXXXXX")" || return 1
	if ! {
		printf 'version=1\nphase=%s\nrevision=%s\ngeneration=%s\nvolume=%s\nimage_id=%s\n' \
			"$phase" "$revision" "$generation" "$volume" "$image_id"
		printf 'database_id=%s\ndatabase_system_identifier=%s\nupdated_at=%s\n' \
			"$database_id" "$system_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	if ! chmod 600 "$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] && ! chown 0:0 "$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	if ! sync -f "$temporary" || ! mv -f -- "$temporary" "$platform_database_marker" ||
		! sync -f "$directory" || ! platform_database_validate_marker; then
		rm -f -- "$temporary"
		return 1
	fi
}

platform_database_marker_revision_for_release() {
	[[ $# -eq 1 && "$1" =~ ^(preparing|prepared|aborted|active|complete)$ ]] || return 1
	local phase="$1" marker_revision
	marker_revision="$(platform_database_marker_value revision)" || return 1
	[[ "$marker_revision" =~ ^[0-9a-f]{40}$ ]] ||
		platform_database_fail 'Platform database marker revision is malformed.' || return 1
	if [[ "$marker_revision" != "$EXPECTED_REVISION" ]]; then
		[[ "$phase" == complete ]] ||
			platform_database_fail 'Platform database lifecycle revision may advance only after completion.' || return 1
		git -C "$SERVER_ROOT" merge-base --is-ancestor \
			"$marker_revision" "$EXPECTED_REVISION" ||
			platform_database_fail 'Platform database marker revision is not an ancestor of the release.' || return 1
	fi
	printf '%s\n' "$marker_revision"
}

platform_database_url_parser_image() {
	local phase image image_id metadata marker_revision
	if [[ -n "${PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID:-}" ]]; then
		image_id="$PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID"
		[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
			platform_database_fail 'Platform URL parser Core image ID is malformed.' || return 1
		metadata="$(platform_database_docker image inspect --format \
			'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
			"$image_id")" || return 1
		[[ "$metadata" == "$image_id|$EXPECTED_REVISION|nestjs" ]] ||
			platform_database_fail 'Platform URL parser Core image metadata is invalid.' || return 1
		printf '%s\n' "$image_id"
		return
	fi
	phase="$(platform_database_current_phase)" || return 1
	if [[ "$phase" == absent ]]; then
		image="$(platform_release_image "$EXPECTED_REVISION")" || return 1
		image_id="$(platform_database_docker image inspect --format '{{.Id}}' "$image")" || return 1
		platform_database_verify_release_image "$image_id" "$image" || return 1
	else
		marker_revision="$(platform_database_marker_revision_for_release "$phase")" || return 1
		image_id="$(platform_database_marker_value image_id)" || return 1
		platform_database_verify_exact_image_id_for_revision \
			"$image_id" "$marker_revision" || return 1
	fi
	printf '%s\n' "$image_id"
}

platform_database_url_field() {
	[[ $# -eq 2 && "$2" =~ ^(protocol|username|password|hostname|port|database|schema)$ ]] || return 1
	local value image_id PLATFORM_PARSE_URL
	value="$(platform_read_env_value "$ENV_FILE" "$1")" || return 1
	image_id="$(platform_database_url_parser_image)" || return 1
	PLATFORM_PARSE_URL="$value"
	export PLATFORM_PARSE_URL
	platform_database_docker run --rm --network none --log-driver none \
		--env PLATFORM_PARSE_URL --entrypoint node "$image_id" -e '
try {
  const input = process.env.PLATFORM_PARSE_URL;
  if (!input) process.exit(1);
  const parsed = new URL(input);
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
} catch {
  process.exit(1);
}
' "$2"
}

platform_database_validate_urls() {
	local contract key role
	for contract in \
		'PLATFORM_DATABASE_URL:winwidget_platform_runtime' \
		'PLATFORM_MIGRATION_DATABASE_URL:winwidget_platform_migration' \
		'PLATFORM_BACKUP_URL:winwidget_platform_backup'; do
		key="${contract%%:*}"
		role="${contract#*:}"
		[[ "$(platform_database_url_field "$key" protocol)" == postgresql: &&
			"$(platform_database_url_field "$key" username)" == "$role" &&
			"$(platform_database_url_field "$key" hostname)" == 127.0.0.1 &&
			"$(platform_database_url_field "$key" port)" == 55439 &&
			"$(platform_database_url_field "$key" database)" == winwidget_platform &&
			"$(platform_database_url_field "$key" schema)" == platform ]] ||
			platform_database_fail "Platform URL contract failed: $key" || return 1
	done
}

platform_database_verify_exact_image_id_for_revision() {
	[[ $# -eq 2 && "$1" =~ ^sha256:[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{40}$ ]] || return 1
	local expected_id="$1" expected_revision="$2" metadata
	metadata="$(platform_database_docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.title"}}' \
		"$expected_id")" || return 1
	[[ "$metadata" == "$expected_id|$expected_revision|platform|winwidget-platform" ]] ||
		platform_database_fail 'Platform image metadata differs from the pinned lifecycle marker.'
}

platform_database_verify_exact_image_id() {
	[[ $# -eq 1 ]] || return 1
	platform_database_verify_exact_image_id_for_revision "$1" "$EXPECTED_REVISION"
}

platform_database_verify_release_image() {
	[[ $# -eq 2 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local expected_id="$1" image="$2"
	platform_database_verify_exact_image_id "$expected_id" || return 1
	[[ "$(platform_database_docker image inspect --format '{{.Id}}' "$image")" == "$expected_id" ]] ||
		platform_database_fail 'Platform release tag differs from the validated image ID.'
}

platform_database_verify_volume() {
	local metadata
	metadata="$(platform_database_docker volume inspect --format \
		'{{.Driver}}|{{.Scope}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' \
		"$PLATFORM_DATABASE_POSTGRES_VOLUME")" || return 1
	[[ "$metadata" == 'local|local|platform|postgres-data' ]] ||
		platform_database_fail 'Platform PostgreSQL volume identity is unsafe.'
}

platform_database_container_id() {
	local ids
	ids="$(platform_database_docker ps --quiet --no-trunc \
		--filter 'label=com.docker.compose.project=winwidget' \
		--filter 'label=com.docker.compose.service=platform-postgres' \
		--filter 'label=com.docker.compose.oneoff=False')" || return 1
	[[ "$ids" =~ ^[0-9a-f]{64}$ ]] ||
		platform_database_fail 'Canonical Platform PostgreSQL container is missing or ambiguous.' || return 1
	printf '%s\n' "$ids"
}

platform_database_verify_postgres_container() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local container_id="$1" postgres_image_id metadata published
	postgres_image_id="$(platform_database_docker image inspect --format '{{.Id}}' \
		"$PLATFORM_DATABASE_POSTGRES_IMAGE")" || return 1
	[[ "$postgres_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}:{{.Name}}{{end}}{{end}}' \
		"$container_id")" || return 1
	[[ "$metadata" == "winwidget|platform-postgres|False|platform|postgres|$PLATFORM_DATABASE_POSTGRES_IMAGE|$postgres_image_id|running|true|healthy|volume:$PLATFORM_DATABASE_POSTGRES_VOLUME" ]] ||
		platform_database_fail 'Running Platform PostgreSQL container identity is unsafe.' || return 1
	published="$(platform_database_docker port "$container_id" 5432/tcp)" || return 1
	[[ "$published" == '127.0.0.1:55439' ]] ||
		platform_database_fail 'Platform PostgreSQL is not bound to the canonical loopback port.'
}

platform_database_admin_password_file() {
	local admin_file
	admin_file="$(platform_read_env_value "$ENV_FILE" PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE)" || return 1
	[[ "$admin_file" == /* && -f "$admin_file" && ! -L "$admin_file" ]] ||
		platform_database_fail 'Platform PostgreSQL admin password file is unsafe.' || return 1
	if [[ "$(uname -s)" == Linux ]]; then
		[[ "$(stat -c '%u:%g:%a' "$admin_file")" == '0:0:600' ]] ||
			platform_database_fail 'Platform PostgreSQL admin password file ownership is unsafe.' || return 1
	fi
	printf '%s\n' "$admin_file"
}

platform_database_read_actual_identity() {
	local container_id admin_file actual PGPASSWORD
	container_id="$(platform_database_container_id)" || return 1
	platform_database_verify_volume || return 1
	platform_database_verify_postgres_container "$container_id" || return 1
	admin_file="$(platform_database_admin_password_file)" || return 1
	PGPASSWORD="$(tr -d '\r\n' <"$admin_file")"
	[[ -n "$PGPASSWORD" ]] || return 1
	export PGPASSWORD
	actual="$(platform_database_docker exec --env PGPASSWORD "$container_id" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --tuples-only --no-align \
		--username winwidget_platform_admin --dbname winwidget_platform --command \
		"SELECT database_id::text || '|' || (pg_control_system()).system_identifier::text
		 FROM platform.service_identity
		 WHERE id = 'singleton' AND service_name = 'platform-service';")" || {
		unset PGPASSWORD
		return 1
	}
	unset PGPASSWORD
	[[ "$actual" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\|[1-9][0-9]*$ ]] ||
		platform_database_fail 'Actual Platform database identity is missing or malformed.' || return 1
	printf '%s\n' "$actual"
}

# Public fail-closed identity guard used by cutover and routine deploy scripts.
platform_database_assert_marker_identity() {
	platform_database_require_root || return 1
	platform_release_validate_file "$ENV_FILE" || return 1
	platform_database_require_marker_path || return 1
	platform_database_require_local_docker || return 1
	platform_database_validate_marker || return 1
	local database_id system_identifier actual
	database_id="$(platform_database_marker_value database_id)" || return 1
	system_identifier="$(platform_database_marker_value database_system_identifier)" || return 1
	[[ "$database_id" != pending && "$system_identifier" != pending ]] ||
		platform_database_fail 'Platform database marker identity is not bound.' || return 1
	actual="$(platform_database_read_actual_identity)" || return 1
	[[ "$actual" == "$database_id|$system_identifier" ]] ||
		platform_database_fail 'Actual Platform database identity differs from the durable marker.'
}

platform_database_assert_bound_marker_identity() {
	platform_database_validate_marker || return 1
	if [[ "$(platform_database_marker_value database_id)" == pending ]]; then
		return
	fi
	platform_database_assert_marker_identity
}

platform_database_validate_clean_shadow() {
	[[ $# -eq 1 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local image_id="$1" PLATFORM_DATABASE_URL
	PLATFORM_DATABASE_URL="$(platform_read_env_value "$ENV_FILE" PLATFORM_MIGRATION_DATABASE_URL)" || return 1
	export PLATFORM_DATABASE_URL
	platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 128 \
		--env PLATFORM_DATABASE_URL --entrypoint node "$image_id" \
		dist/src/cutover/main.js validate-shadow >/dev/null
}

platform_database_assert_pre_cutover_runtime_stopped() {
	local running
	running="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q platform-api platform-outbox-publisher)" || return 1
	[[ -z "$running" ]] ||
		platform_database_fail 'Platform runtime must remain stopped until ownership cutover has a durable marker.'
}

platform_database_stop_pre_cutover_runtime() {
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop -t 90 platform-api platform-outbox-publisher >/dev/null || return 1
	platform_database_assert_pre_cutover_runtime_stopped
}

platform_database_prepare() {
	platform_database_require_root || return 1
	platform_database_require_inputs || return 1
	acquire_production_deploy_lock 'Platform database prepare' || return 1
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	local phase generation volume image image_id admin_file PGPASSWORD
	local MIGRATION_PASSWORD RUNTIME_PASSWORD BACKUP_PASSWORD container_id
	local database_id system_identifier acl_state actual marker_database_id marker_system_identifier
	local identity_table_exists
	phase="$(platform_database_current_phase)" || return 1
	case "$phase" in
	aborted)
		platform_database_fail 'Restarting an aborted Platform attempt is disabled pending explicit approval.'
		return 1
		;;
	absent | preparing | prepared) ;; *)
		platform_database_fail "Platform prepare is forbidden from phase=$phase."; return 1 ;; esac
	# A resumed prepare may inherit a candidate started by an older interrupted
	# implementation. Stop it before the first release mutation and seal the
	# prepared database marker only after rechecking that it is still stopped.
	platform_database_stop_pre_cutover_runtime || return 1
	volume="$PLATFORM_DATABASE_POSTGRES_VOLUME"
	image="$(platform_release_image "$EXPECTED_REVISION")"
	generation=1
	marker_database_id=pending
	marker_system_identifier=pending
	case "$phase" in
	absent)
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			build --pull platform-api || return 1
		image_id="$(platform_database_docker image inspect --format '{{.Id}}' "$image")" || return 1
		platform_database_verify_release_image "$image_id" "$image" || return 1
		platform_database_write_marker preparing "$EXPECTED_REVISION" "$generation" "$volume" "$image_id" \
			"$marker_database_id" "$marker_system_identifier" || return 1
		;;
	preparing | prepared)
		[[ "$(platform_database_marker_value revision)" == "$EXPECTED_REVISION" &&
			"$(platform_database_marker_value volume)" == "$volume" ]] ||
			platform_database_fail 'Resumed Platform marker differs from the requested release.' || return 1
		image_id="$(platform_database_marker_value image_id)" || return 1
		platform_database_verify_release_image "$image_id" "$image" || return 1
		generation="$(platform_database_marker_value generation)" || return 1
		marker_database_id="$(platform_database_marker_value database_id)"
		marker_system_identifier="$(platform_database_marker_value database_system_identifier)"
		;;
	esac
	platform_database_validate_urls || return 1
	if platform_database_docker volume inspect "$volume" >/dev/null 2>&1; then
		platform_database_verify_volume || return 1
	else
		[[ "$marker_database_id" == pending ]] ||
			platform_database_fail 'Bound Platform database volume is missing.' || return 1
		platform_database_docker volume create --label com.winwidget.owner=platform \
			--label com.winwidget.purpose=postgres-data "$volume" >/dev/null || return 1
		platform_database_verify_volume || return 1
	fi
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile platform-database up -d --no-build platform-postgres || return 1
	for _ in {1..60}; do
		container_id="$(platform_database_docker ps --quiet --no-trunc \
			--filter 'label=com.docker.compose.project=winwidget' \
			--filter 'label=com.docker.compose.service=platform-postgres' \
			--filter 'label=com.docker.compose.oneoff=False')" || return 1
		[[ "$container_id" =~ ^[0-9a-f]{64}$ &&
			"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" == healthy ]] && break
		sleep 2
	done
	container_id="$(platform_database_container_id)" || return 1
	platform_database_verify_postgres_container "$container_id" || return 1
	platform_database_assert_bound_marker_identity || return 1
	admin_file="$(platform_database_admin_password_file)" || return 1
	PGPASSWORD="$(tr -d '\r\n' <"$admin_file")"
	[[ -n "$PGPASSWORD" ]] || return 1
	export PGPASSWORD
	if [[ "$marker_database_id" == pending ]]; then
		identity_table_exists="$(platform_database_docker exec --env PGPASSWORD \
			"$container_id" psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
			--tuples-only --no-align --username winwidget_platform_admin \
			--dbname winwidget_platform --command \
			"SELECT to_regclass('platform.service_identity') IS NOT NULL;")" || return 1
		case "$identity_table_exists" in
		t)
			actual="$(platform_database_read_actual_identity)" || return 1
			marker_database_id="${actual%%|*}"
			marker_system_identifier="${actual#*|}"
			platform_database_write_marker preparing "$EXPECTED_REVISION" "$generation" "$volume" \
				"$image_id" "$marker_database_id" "$marker_system_identifier" || return 1
			;;
		f) ;;
		*) platform_database_fail 'Platform service identity existence probe is invalid.'; return 1 ;;
		esac
	fi
	MIGRATION_PASSWORD="$(platform_database_url_field PLATFORM_MIGRATION_DATABASE_URL password)"
	RUNTIME_PASSWORD="$(platform_database_url_field PLATFORM_DATABASE_URL password)"
	BACKUP_PASSWORD="$(platform_database_url_field PLATFORM_BACKUP_URL password)"
	export MIGRATION_PASSWORD RUNTIME_PASSWORD BACKUP_PASSWORD
	platform_database_docker exec --interactive --env PGPASSWORD \
		--env MIGRATION_PASSWORD --env RUNTIME_PASSWORD --env BACKUP_PASSWORD "$container_id" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
		--username winwidget_platform_admin --dbname postgres <<'SQL' || return 1
\getenv MIGRATION_PASSWORD MIGRATION_PASSWORD
\getenv RUNTIME_PASSWORD RUNTIME_PASSWORD
\getenv BACKUP_PASSWORD BACKUP_PASSWORD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_platform_migration', :'MIGRATION_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_platform_migration') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_platform_runtime', :'RUNTIME_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_platform_runtime') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_platform_backup', :'BACKUP_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_platform_backup') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L', 'winwidget_platform_migration', :'MIGRATION_PASSWORD', 'infinity') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L', 'winwidget_platform_runtime', :'RUNTIME_PASSWORD', 'infinity') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL %L', 'winwidget_platform_backup', :'BACKUP_PASSWORD', 'infinity') \gexec
ALTER ROLE winwidget_platform_migration RESET ALL;
ALTER ROLE winwidget_platform_runtime RESET ALL;
ALTER ROLE winwidget_platform_backup RESET ALL;
DO $$
DECLARE membership RECORD;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members links
    JOIN pg_roles granted ON granted.oid = links.roleid
    JOIN pg_roles member ON member.oid = links.member
    WHERE member.rolname IN (
      'winwidget_platform_migration',
      'winwidget_platform_runtime',
      'winwidget_platform_backup'
    )
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
  END LOOP;
END $$;
GRANT pg_signal_backend TO winwidget_platform_admin;
GRANT winwidget_platform_migration, winwidget_platform_runtime, winwidget_platform_backup TO winwidget_platform_admin;
REVOKE ALL ON DATABASE winwidget_platform FROM PUBLIC;
REVOKE ALL ON DATABASE winwidget_platform FROM winwidget_platform_migration, winwidget_platform_runtime, winwidget_platform_backup;
GRANT CONNECT ON DATABASE winwidget_platform TO winwidget_platform_migration, winwidget_platform_runtime, winwidget_platform_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_platform FROM winwidget_platform_migration, winwidget_platform_runtime, winwidget_platform_backup;
\connect winwidget_platform
CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION winwidget_platform_migration;
ALTER SCHEMA platform OWNER TO winwidget_platform_migration;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA platform TO winwidget_platform_migration;
GRANT USAGE ON SCHEMA platform TO winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform REVOKE ALL ON TABLES FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT SELECT ON TABLES TO winwidget_platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT SELECT ON TABLES TO winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT SELECT ON SEQUENCES TO winwidget_platform_backup;
SQL
	unset PGPASSWORD MIGRATION_PASSWORD RUNTIME_PASSWORD BACKUP_PASSWORD
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile platform-migration run --rm --no-deps platform-migrate || return 1
	actual="$(platform_database_read_actual_identity)" || return 1
	if [[ "$marker_database_id" == pending ]]; then
		marker_database_id="${actual%%|*}"
		marker_system_identifier="${actual#*|}"
		platform_database_write_marker preparing "$EXPECTED_REVISION" "$generation" "$volume" "$image_id" \
			"$marker_database_id" "$marker_system_identifier" || return 1
	else
		[[ "$actual" == "$marker_database_id|$marker_system_identifier" ]] ||
			platform_database_fail 'Platform database identity changed while migrations ran.' || return 1
	fi
	PGPASSWORD="$(tr -d '\r\n' <"$admin_file")"
	[[ -n "$PGPASSWORD" ]] || return 1
	export PGPASSWORD
	platform_database_docker exec --interactive --env PGPASSWORD "$container_id" psql --no-psqlrc \
		--no-password --set ON_ERROR_STOP=1 --username winwidget_platform_admin \
		--dbname winwidget_platform <<'SQL' || return 1
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA platform TO winwidget_platform_migration;
REVOKE CREATE ON SCHEMA platform FROM winwidget_platform_runtime, winwidget_platform_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA platform FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
GRANT EXECUTE ON FUNCTION platform.current_semantic_fingerprint() TO winwidget_platform_runtime;
GRANT EXECUTE ON FUNCTION platform.refresh_current_semantic_fingerprint(TEXT) TO winwidget_platform_runtime;
REVOKE ALL ON FUNCTION platform.enforce_current_semantic_fingerprint() FROM PUBLIC, winwidget_platform_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA platform TO winwidget_platform_runtime;
GRANT UPDATE ON TABLE platform.site_settings, platform.home_page_content TO winwidget_platform_runtime;
GRANT INSERT, UPDATE ON TABLE platform.legal_pages, platform.source_sequences, platform.outbox_events TO winwidget_platform_runtime;
GRANT UPDATE (current_aggregate_version, current_source_sequence, updated_at)
  ON TABLE platform.billing_offer_producer_state TO winwidget_platform_runtime;
GRANT UPDATE (current_semantic_fingerprint, updated_at)
  ON TABLE platform.service_identity TO winwidget_platform_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA platform TO winwidget_platform_runtime;
REVOKE ALL ON TABLE platform._prisma_migrations FROM winwidget_platform_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA platform TO winwidget_platform_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA platform TO winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform REVOKE ALL ON TABLES FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_platform_runtime, winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT SELECT ON TABLES TO winwidget_platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT SELECT ON TABLES TO winwidget_platform_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_platform_migration IN SCHEMA platform GRANT SELECT ON SEQUENCES TO winwidget_platform_backup;
SQL
	acl_state="$(platform_database_docker exec --env PGPASSWORD "$container_id" psql --no-psqlrc \
		--no-password --tuples-only --no-align --username winwidget_platform_admin \
		--dbname winwidget_platform --command "
		SELECT current_database() = 'winwidget_platform'
		  AND current_setting('server_version_num')::integer / 10000 = 18
		  AND current_setting('data_checksums') = 'on'
		  AND (SELECT count(*) = 3 AND bool_and(
		    rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
		    AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
		    AND rolconnlimit = -1 AND rolvaliduntil = 'infinity'::timestamptz
		    AND rolconfig IS NULL)
		    FROM pg_roles WHERE rolname IN (
		      'winwidget_platform_migration', 'winwidget_platform_runtime',
		      'winwidget_platform_backup'))
		  AND NOT EXISTS (
		    SELECT 1 FROM pg_auth_members links JOIN pg_roles member ON member.oid = links.member
		    WHERE member.rolname IN (
		      'winwidget_platform_migration', 'winwidget_platform_runtime',
		      'winwidget_platform_backup'))
		  AND has_schema_privilege('winwidget_platform_migration', 'platform', 'CREATE')
		  AND NOT has_schema_privilege('winwidget_platform_runtime', 'platform', 'CREATE')
			  AND NOT has_database_privilege('winwidget_platform_runtime', current_database(), 'CREATE')
			  AND NOT has_database_privilege('winwidget_platform_runtime', current_database(), 'TEMPORARY')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.site_settings', 'UPDATE')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.site_settings', 'INSERT')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.site_settings', 'DELETE')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.home_page_content', 'UPDATE')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.home_page_content', 'INSERT')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.home_page_content', 'DELETE')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.legal_pages', 'INSERT')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.legal_pages', 'UPDATE')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.legal_pages', 'DELETE')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.source_sequences', 'INSERT')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.source_sequences', 'UPDATE')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.source_sequences', 'DELETE')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.service_identity', 'SELECT')
		  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.service_identity', 'INSERT')
		  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.service_identity', 'UPDATE')
		  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.service_identity', 'DELETE')
		  AND has_column_privilege('winwidget_platform_runtime', 'platform.service_identity', 'current_semantic_fingerprint', 'UPDATE')
		  AND has_column_privilege('winwidget_platform_runtime', 'platform.service_identity', 'updated_at', 'UPDATE')
		  AND NOT has_column_privilege('winwidget_platform_runtime', 'platform.service_identity', 'phase', 'UPDATE')
		  AND has_function_privilege('winwidget_platform_runtime', 'platform.current_semantic_fingerprint()', 'EXECUTE')
		  AND has_function_privilege('winwidget_platform_runtime', 'platform.refresh_current_semantic_fingerprint(text)', 'EXECUTE')
		  AND NOT has_function_privilege('winwidget_platform_runtime', 'platform.enforce_current_semantic_fingerprint()', 'EXECUTE')
		  AND has_table_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'SELECT')
		  AND has_column_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'current_aggregate_version', 'UPDATE')
		  AND has_column_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'current_source_sequence', 'UPDATE')
			  AND has_column_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'updated_at', 'UPDATE')
			  AND NOT has_column_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'phase', 'UPDATE')
			  AND NOT has_column_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'producer_contract_version', 'UPDATE')
			  AND NOT has_column_privilege('winwidget_platform_runtime', 'platform.billing_offer_producer_state', 'source_sequence_scope', 'UPDATE')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.outbox_events', 'INSERT')
			  AND has_table_privilege('winwidget_platform_runtime', 'platform.outbox_events', 'UPDATE')
			  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform.outbox_events', 'DELETE')
		  AND NOT has_table_privilege('winwidget_platform_runtime', 'platform._prisma_migrations', 'SELECT')
		  AND has_table_privilege('winwidget_platform_backup', 'platform.service_identity', 'SELECT')
		  AND NOT has_table_privilege('winwidget_platform_backup', 'platform.outbox_events', 'INSERT')
		  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'platform.service_identity'::regclass
		    AND tgname = 'service_identity_lifecycle_guard' AND tgenabled = 'O' AND NOT tgisinternal)
			  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'platform.billing_offer_producer_state'::regclass
			    AND tgname = 'billing_offer_producer_lifecycle_guard' AND tgenabled = 'O' AND NOT tgisinternal)
			  AND NOT EXISTS (
			    SELECT 1
			    FROM (VALUES
			      ('service_identity', 'service_identity_semantic_fingerprint_guard'),
			      ('source_sequences', 'source_sequences_semantic_fingerprint_guard'),
			      ('site_settings', 'site_settings_semantic_fingerprint_guard'),
			      ('legal_pages', 'legal_pages_semantic_fingerprint_guard'),
			      ('home_page_content', 'home_page_content_semantic_fingerprint_guard'),
			      ('billing_offer_producer_state', 'billing_offer_producer_semantic_fingerprint_guard')
			    ) AS expected(table_name, trigger_name)
			    LEFT JOIN pg_class relation
			      ON relation.oid = format('platform.%I', expected.table_name)::regclass
			    LEFT JOIN pg_trigger trigger_entry
			      ON trigger_entry.tgrelid = relation.oid
			     AND trigger_entry.tgname = expected.trigger_name
			    LEFT JOIN pg_constraint constraint_entry
			      ON constraint_entry.oid = trigger_entry.tgconstraint
			    WHERE trigger_entry.oid IS NULL
			       OR constraint_entry.oid IS NULL
			       OR trigger_entry.tgenabled <> 'O'
			       OR trigger_entry.tgisinternal
			       OR trigger_entry.tgtype <> 29
			       OR trigger_entry.tgconstraint = 0
			       OR NOT trigger_entry.tgdeferrable
			       OR NOT trigger_entry.tginitdeferred
			       OR trigger_entry.tgfoid <> 'platform.enforce_current_semantic_fingerprint()'::regprocedure
			       OR constraint_entry.contype <> 't'
			       OR constraint_entry.conname <> expected.trigger_name
			       OR constraint_entry.connamespace <> 'platform'::regnamespace
			       OR constraint_entry.conrelid <> relation.oid
			       OR NOT constraint_entry.condeferrable
			       OR NOT constraint_entry.condeferred)
			  AND (SELECT count(*) FROM pg_trigger
			       WHERE tgfoid = 'platform.enforce_current_semantic_fingerprint()'::regprocedure) = 6;")"
	unset PGPASSWORD
	[[ "$acl_state" == t ]] ||
		platform_database_fail 'Platform PostgreSQL role, ACL, or trigger verification failed.' || return 1
	actual="$(platform_database_read_actual_identity)" || return 1
	database_id="${actual%%|*}"
	system_identifier="${actual#*|}"
	[[ "$marker_database_id" == pending ||
		"$actual" == "$marker_database_id|$marker_system_identifier" ]] ||
		platform_database_fail 'Resumed Platform database identity changed during preparation.' || return 1
	platform_database_validate_clean_shadow "$image_id" ||
		platform_database_fail 'Platform target is not an exact clean SHADOW database.' || return 1
	platform_database_assert_pre_cutover_runtime_stopped || return 1
	platform_database_write_marker prepared "$EXPECTED_REVISION" "$generation" "$volume" "$image_id" "$database_id" "$system_identifier"
	printf 'platform_database_phase=prepared\n'
}

platform_database_advance() {
	[[ $# -eq 1 && "$1" =~ ^(active|complete)$ ]] || return 1
	platform_database_validate_marker || return 1
	[[ "$(platform_database_marker_value revision)" == "$EXPECTED_REVISION" ]] || return 1
	platform_database_assert_marker_identity || return 1
	platform_database_write_marker "$1" "$EXPECTED_REVISION" \
		"$(platform_database_marker_value generation)" \
		"$(platform_database_marker_value volume)" "$(platform_database_marker_value image_id)" \
		"$(platform_database_marker_value database_id)" \
		"$(platform_database_marker_value database_system_identifier)"
}

platform_database_abort_prepare() {
	platform_database_require_root || return 1
	platform_database_require_inputs || return 1
	acquire_production_deploy_lock 'Platform database abort' || return 1
	[[ "${PLATFORM_ABORT_CONFIRMATION:-}" == 'ABORT PLATFORM PREPARE' ]] ||
		platform_database_fail 'Platform abort requires exact confirmation.' || return 1
	local phase
	phase="$(platform_database_current_phase)"
	case "$phase" in preparing | prepared) ;; active | complete)
		platform_database_fail 'Platform ownership is forward-only after activation.'; return 1 ;; *) return 1 ;; esac
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	platform_database_assert_bound_marker_identity || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop -t 90 platform-api platform-outbox-publisher || return 1
	[[ -z "$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q platform-api platform-outbox-publisher)" ]] ||
		platform_database_fail 'Platform runtime is still running after abort stop.' || return 1
	platform_database_write_marker aborted "$EXPECTED_REVISION" \
		"$(platform_database_marker_value generation)" \
		"$(platform_database_marker_value volume)" "$(platform_database_marker_value image_id)" \
		"$(platform_database_marker_value database_id)" \
		"$(platform_database_marker_value database_system_identifier)"
	printf 'platform_database_phase=aborted\n'
}

platform_database_status() {
	local phase
	phase="$(platform_database_current_phase)" || return 1
	printf 'platform_database_phase=%s\n' "$phase"
	if [[ "$phase" != absent ]]; then
		printf 'platform_database_revision=%s\n' "$(platform_database_marker_value revision)"
		printf 'platform_database_generation=%s\n' "$(platform_database_marker_value generation)"
		printf 'platform_database_volume=%s\n' "$(platform_database_marker_value volume)"
	fi
}

platform_database_guard_checkout_revision() {
	[[ "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local phase candidate="$1"
	phase="$(platform_database_current_phase)" || return 1
	[[ "$phase" == absent ]] && return
	platform_database_checkout_revision_allowed "$phase" \
		"$(platform_database_marker_value revision)" "$candidate"
}

platform_database_checkout_revision_allowed() {
	[[ $# -eq 3 && "$1" =~ ^(preparing|prepared|aborted|active|complete)$ &&
		"$2" =~ ^[0-9a-f]{40}$ && "$3" =~ ^[0-9a-f]{40}$ ]] || return 1
	case "$1" in preparing | prepared | active)
		[[ "$3" == "$2" ]] ;;
	aborted)
		[[ "$3" == "$2" ]] ;;
	complete) return 0 ;; *) return 1 ;; esac
}

platform_database_self_test() {
	platform_database_transition_allowed absent preparing
	platform_database_transition_allowed preparing prepared
	platform_database_transition_allowed prepared aborted
	platform_database_transition_allowed prepared active
	platform_database_transition_allowed active complete
	if platform_database_transition_allowed aborted preparing; then return 1; fi
	platform_database_private_directory_mode_allowed 700
	platform_database_private_directory_mode_allowed 0755
	if platform_database_private_directory_mode_allowed 770; then return 1; fi
	if platform_database_private_directory_mode_allowed 0707; then return 1; fi
	if platform_database_private_directory_mode_allowed 777; then return 1; fi
	if platform_database_transition_allowed active aborted; then return 1; fi
	if platform_database_checkout_revision_allowed aborted \
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then return 1; fi
	platform_database_checkout_revision_allowed aborted \
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
	if platform_database_checkout_revision_allowed prepared \
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then return 1; fi
	if PLATFORM_CONFIRMATION='REBIND ABORTED PLATFORM ATTEMPT' \
		platform_database_checkout_revision_allowed aborted \
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then return 1; fi
	local source prepare_source stop_source
	prepare_source="$(declare -f platform_database_prepare)"
	stop_source="$(declare -f platform_database_assert_pre_cutover_runtime_stopped \
		platform_database_stop_pre_cutover_runtime)"
	source="$(declare -f platform_database_require_inputs platform_database_require_local_docker \
		platform_database_marker_revision_for_release platform_database_url_parser_image \
		platform_database_url_field platform_database_verify_exact_image_id_for_revision \
		platform_database_verify_exact_image_id platform_database_verify_release_image \
		platform_database_read_actual_identity \
		platform_database_private_directory_mode_allowed \
		platform_database_write_marker platform_database_prepare \
		platform_database_checkout_revision_allowed \
		platform_database_abort_prepare platform_database_assert_marker_identity \
		platform_database_validate_clean_shadow \
		platform_database_assert_pre_cutover_runtime_stopped \
		platform_database_stop_pre_cutover_runtime)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *"acquire_production_deploy_lock 'Platform database prepare'"* &&
		"$source" == *"acquire_production_deploy_lock 'Platform database abort'"* &&
		"$source" == *'unix:///var/run/docker.sock'* &&
		"$source" == *'Existing Platform database marker is invalid'* &&
		"$source" == *'Restarting an aborted Platform attempt is disabled pending explicit approval.'* &&
		"$source" == *"Restarting an aborted Platform attempt is disabled pending explicit approval."*"build --pull platform-api"* &&
		"$source" == *'sync -f'* && "$source" == *'platform-migrate'* &&
		"$source" == *'export PLATFORM_PARSE_URL'* &&
		"$source" == *'--env PLATFORM_PARSE_URL'* &&
		"$source" != *'--env "PLATFORM_PARSE_URL=$value"'* &&
		"$source" == *'PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID'* &&
		"$source" == *'$image_id|$EXPECTED_REVISION|nestjs'* &&
		"$source" == *'[[ "$phase" == complete ]]'* &&
		"$source" == *'merge-base --is-ancestor'*'platform_database_verify_exact_image_id_for_revision'* &&
		"$source" == *'try {'*'const parsed = new URL(input);'*'} catch {'* &&
		"$source" == *'export PLATFORM_DATABASE_URL'* &&
		"$source" == *'--env PLATFORM_DATABASE_URL'* &&
		"$source" != *'--env "PLATFORM_DATABASE_URL='* &&
		"$source" == *'--env PGPASSWORD'* &&
		"$source" != *'-e "PGPASSWORD='* &&
		"$source" != *'--env "PGPASSWORD='* &&
		"$source" == *'--env MIGRATION_PASSWORD'* &&
		"$source" == *'--env RUNTIME_PASSWORD'* &&
		"$source" == *'--env BACKUP_PASSWORD'* &&
		"$source" == *'\getenv MIGRATION_PASSWORD MIGRATION_PASSWORD'* &&
		"$source" == *'\getenv RUNTIME_PASSWORD RUNTIME_PASSWORD'* &&
		"$source" == *'\getenv BACKUP_PASSWORD BACKUP_PASSWORD'* &&
		"$source" != *'--set "MIGRATION_PASSWORD='* &&
		"$source" != *'--set "RUNTIME_PASSWORD='* &&
		"$source" != *'--set "BACKUP_PASSWORD='* &&
		"$source" == *'platform_database_verify_exact_image_id "$image_id"'* &&
		"$source" == *'platform_database_marker_value image_id'* &&
		"$source" == *'REVOKE ALL ON ALL FUNCTIONS'* &&
		"$source" == *'platform.current_semantic_fingerprint()'* &&
		"$source" == *'platform.refresh_current_semantic_fingerprint(TEXT)'* &&
		"$source" == *'REVOKE ALL ON FUNCTION platform.enforce_current_semantic_fingerprint()'* &&
		"$source" == *'GRANT UPDATE (current_semantic_fingerprint, updated_at)'* &&
		"$source" == *'trigger_entry.tgconstraint = 0'* &&
		"$source" == *'trigger_entry.tgdeferrable'* &&
		"$source" == *'trigger_entry.tginitdeferred'* &&
		"$source" == *"constraint_entry.contype <> 't'"* &&
		"$source" == *"platform.enforce_current_semantic_fingerprint()'::regprocedure"* &&
		"$source" == *'producer_contract_version'* &&
		"$source" == *'source_sequence_scope'* &&
		"$source" == *'validate-shadow'* &&
		"$source" == *'forward-only after activation'* &&
		"$stop_source" == *'stop -t 90 platform-api platform-outbox-publisher'* &&
		"$stop_source" == *'ps --status running -q platform-api platform-outbox-publisher'* &&
		"$prepare_source" == *'platform_database_stop_pre_cutover_runtime'*'build --pull platform-api'* &&
		"$prepare_source" == *'platform_database_validate_clean_shadow'*'platform_database_assert_pre_cutover_runtime_stopped'*'platform_database_write_marker prepared'* &&
		"$prepare_source" != *'up -d --no-build --no-deps --force-recreate platform-api'* &&
		"$prepare_source" != *'http://127.0.0.1:5000/health/ready'* ]]
	local EXPECTED_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
	local platform_database_self_test_image_id platform_database_self_test_retagged_id
	local platform_database_self_test_core_image_id
	platform_database_self_test_image_id="sha256:$(printf 'a%.0s' {1..64})"
	platform_database_self_test_retagged_id="sha256:$(printf 'b%.0s' {1..64})"
	platform_database_self_test_core_image_id="sha256:$(printf 'c%.0s' {1..64})"
	local platform_database_self_test_image='winwidget-platform:self-test'
	local platform_database_self_test_image_mode=valid
	local platform_database_self_test_image_revision="$EXPECTED_REVISION"
	platform_database_docker() {
		[[ "$1 $2 $3" == 'image inspect --format' ]] || return 1
		local target argument
		for argument in "$@"; do target="$argument"; done
		case "$platform_database_self_test_image_mode:$target" in
		valid:"$platform_database_self_test_image_id" | retag:"$platform_database_self_test_image_id")
			printf '%s|%s|platform|winwidget-platform\n' \
				"$platform_database_self_test_image_id" "$platform_database_self_test_image_revision"
			;;
		core-valid:"$platform_database_self_test_core_image_id")
			printf '%s|%s|nestjs\n' \
				"$platform_database_self_test_core_image_id" "$EXPECTED_REVISION"
			;;
		core-invalid:"$platform_database_self_test_core_image_id")
			printf '%s|wrong-revision|root\n' "$platform_database_self_test_core_image_id"
			;;
		invalid:"$platform_database_self_test_image_id")
			printf '%s|wrong-revision|root|wrong-title\n' "$platform_database_self_test_image_id"
			;;
		retag:"$platform_database_self_test_image")
			printf '%s\n' "$platform_database_self_test_retagged_id"
			;;
		*) return 1 ;;
		esac
	}
	platform_database_verify_exact_image_id "$platform_database_self_test_image_id"
	platform_database_self_test_image_mode=invalid
	if platform_database_verify_exact_image_id "$platform_database_self_test_image_id" \
		>/dev/null 2>&1; then return 1; fi
	platform_database_self_test_image_mode=retag
	if platform_database_verify_release_image "$platform_database_self_test_image_id" \
		"$platform_database_self_test_image" >/dev/null 2>&1; then return 1; fi
	PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID="$platform_database_self_test_core_image_id"
	export PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID
	platform_database_self_test_image_mode=core-valid
	[[ "$(platform_database_url_parser_image)" == "$platform_database_self_test_core_image_id" ]]
	platform_database_self_test_image_mode=core-invalid
	if platform_database_url_parser_image >/dev/null 2>&1; then return 1; fi
	unset PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID
	platform_database_self_test_image_mode=valid
	platform_database_current_phase() {
		printf '%s\n' prepared
	}
	platform_database_marker_value() {
		case "$1" in
		revision) printf '%s\n' "$EXPECTED_REVISION" ;;
		image_id) printf '%s\n' "$platform_database_self_test_image_id" ;;
		*) return 1 ;;
		esac
	}
	platform_release_image() {
		return 1
	}
	[[ "$(platform_database_url_parser_image)" == "$platform_database_self_test_image_id" ]]
	(
		local fixture_marker_revision=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
		platform_database_self_test_image_revision="$fixture_marker_revision"
		platform_database_current_phase() {
			printf '%s\n' complete
		}
		platform_database_marker_value() {
			case "$1" in
			revision) printf '%s\n' "$fixture_marker_revision" ;;
			image_id) printf '%s\n' "$platform_database_self_test_image_id" ;;
			*) return 1 ;;
			esac
		}
		git() {
			[[ "$1" == -C && "$2" == "$SERVER_ROOT" && "$3" == merge-base &&
				"$4" == --is-ancestor && "$5" == "$fixture_marker_revision" &&
				"$6" == "$EXPECTED_REVISION" ]]
		}
		[[ "$(platform_database_url_parser_image)" == "$platform_database_self_test_image_id" ]]
		platform_database_self_test_image_revision="$EXPECTED_REVISION"
		if platform_database_url_parser_image >/dev/null 2>&1; then
			return 1
		fi
		for fixture_phase in preparing prepared active aborted; do
			if platform_database_marker_revision_for_release "$fixture_phase" \
				>/dev/null 2>&1; then
				return 1
			fi
		done
	)
	(
		local fixture_marker_revision=cccccccccccccccccccccccccccccccccccccccc
		platform_database_marker_value() {
			[[ "$1" == revision ]] || return 1
			printf '%s\n' "$fixture_marker_revision"
		}
		git() { return 1; }
		if platform_database_marker_revision_for_release complete >/dev/null 2>&1; then
			return 1
		fi
	)

	local platform_database_self_test_url='postgresql://winwidget_platform_runtime:self-test-secret@127.0.0.1:55439/winwidget_platform?schema=platform'
	platform_read_env_value() {
		printf '%s\n' "$platform_database_self_test_url"
	}
	platform_database_url_parser_image() {
		printf '%s\n' "$platform_database_self_test_image_id"
	}
	platform_database_docker() {
		local argument previous='' program=''
		[[ "$*" == *'--env PLATFORM_PARSE_URL'* &&
			"${PLATFORM_PARSE_URL:-}" == "$platform_database_self_test_url" ]] || return 1
		for argument in "$@"; do
			[[ "$argument" != "$platform_database_self_test_url" ]] || return 1
			if [[ "$previous" == -e ]]; then
				program="$argument"
			fi
			previous="$argument"
		done
		[[ -n "$program" ]] || return 1
		node -e "$program" "${@: -1}"
	}
	[[ "$(platform_database_url_field PLATFORM_DATABASE_URL username)" == \
		winwidget_platform_runtime ]]
	platform_database_self_test_url='postgresql://winwidget_platform_runtime:self-test-secret@['
	local platform_database_self_test_parser_error
	if platform_database_self_test_parser_error="$(
		platform_database_url_field PLATFORM_DATABASE_URL username 2>&1
	)"; then return 1; fi
	[[ -z "$platform_database_self_test_parser_error" ]]
	local platform_database_self_test_migration_url='postgresql://migration:self-test-migration-secret@127.0.0.1:55439/winwidget_platform?schema=platform'
	platform_read_env_value() {
		printf '%s\n' "$platform_database_self_test_migration_url"
	}
	platform_database_docker() {
		local argument
		[[ "$*" == *'--env PLATFORM_DATABASE_URL'* &&
			"${PLATFORM_DATABASE_URL:-}" == "$platform_database_self_test_migration_url" ]] || return 1
		for argument in "$@"; do
			[[ "$argument" != "$platform_database_self_test_migration_url" ]] || return 1
		done
	}
	platform_database_validate_clean_shadow "$platform_database_self_test_image_id"
	local platform_database_self_test_runtime_state=stopped
	platform_release_compose() {
		case "$*" in
		*'stop -t 90 platform-api platform-outbox-publisher'*) return 0 ;;
		*'ps --status running -q platform-api platform-outbox-publisher'*)
			[[ "$platform_database_self_test_runtime_state" == stopped ]] || printf 'running-container\n'
			;;
		*) return 1 ;;
		esac
	}
	platform_database_stop_pre_cutover_runtime
	platform_database_self_test_runtime_state=running
	if platform_database_assert_pre_cutover_runtime_stopped >/dev/null 2>&1; then
		return 1
	fi
	printf 'platform_database_lifecycle_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--prepare) platform_database_prepare ;;
	--abort-prepare) platform_database_abort_prepare ;;
	--status) platform_database_status ;;
	--self-test) platform_database_self_test ;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ $# -eq 2 ]] || exit 1
		platform_database_guard_checkout_revision "$2"
		;;
	*) platform_database_fail 'Usage: platform-database-lifecycle.sh --prepare|--abort-prepare|--status|--self-test|--guard-before-fetch-revision <sha>|--guard-before-checkout-revision <sha>' ;;
	esac
fi
