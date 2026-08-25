#!/usr/bin/env bash

CORE_POSTGRES_CONTAINER="winwidget-core-postgres-temporary"
CORE_POSTGRES_IMAGE="postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
CORE_POSTGRES_IMAGE_ID="sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
CORE_POSTGRES_DATA_VOLUME="winwidget-core-postgres-temporary-data"
CORE_POSTGRES_PORT="55434"
CORE_POSTGRES_DATABASE="default_db"
CORE_POSTGRES_ADMIN_USER="winwidget_core_admin"
CORE_POSTGRES_ADMIN_PASSWORD_FILE="${APP_ROOT:?APP_ROOT is required}/deploy/backend/.core-postgres-temporary-admin-password"
CORE_POSTGRES_SYSTEM_IDENTIFIER="7668360958158979115"
CORE_POSTGRES_DATA_DIRECTORY="/var/lib/postgresql/18/docker"

core_database_env_value() {
	local key="$1"

	awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			if (name != key) next

			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)
			print value
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "${ENV_FILE:?ENV_FILE is required}"
}

assert_core_database_url_boundaries() {
	local key
	local expected_user
	local value
	local prefix
	local suffix
	local password

	while IFS='|' read -r key expected_user; do
		value="$(core_database_env_value "$key")" || {
			echo "$key must exist exactly once in $ENV_FILE." >&2
			return 1
		}
		prefix="postgresql://$expected_user:"
		suffix="@127.0.0.1:$CORE_POSTGRES_PORT/$CORE_POSTGRES_DATABASE?schema=public&sslmode=disable"
		if [[ "$value" != "$prefix"*"$suffix" ]]; then
			echo "$key must target the verified temporary core PostgreSQL boundary." >&2
			return 1
		fi
		password="${value#"$prefix"}"
		password="${password%"$suffix"}"
		if [[ -z "$password" ||
			"$password" == *"@"* ||
			"$password" == *" "* ||
			"$password" == *$'\t'* ||
			"$password" == *$'\r'* ||
			"$password" == *$'\n'* ]]; then
			echo "$key must contain a non-empty URL-encoded password." >&2
			return 1
		fi
	done <<'EOF'
DATABASE_URL_PRODUCTION|winwidget_api_runtime
DATABASE_MIGRATION_URL_PRODUCTION|gen_user
MAINTENANCE_DATABASE_URL_PRODUCTION|winwidget_maintenance
EOF

	echo "Core runtime, migration and maintenance URL boundaries verified."
}

assert_core_database_postgres_identity() {
	local container_id
	local container_identity
	local expected_container_identity
	local data_mount
	local secret_mount
	local port_binding
	local container_env
	local expected_env
	local expected_env_count
	local volume_identity
	local attached_containers
	local control_data
	local system_identifier
	local cluster_state
	local checksum_version

	container_id="$(
		docker inspect --format '{{.Id}}' \
			"$CORE_POSTGRES_CONTAINER" 2>/dev/null || true
	)"
	if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
		echo "Verified temporary core PostgreSQL container is missing." >&2
		return 1
	fi

	container_identity="$(
		docker inspect --format \
			'{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.HostConfig.RestartPolicy.Name}}|{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{index .Config.Labels "com.winwidget.cleanup-after"}}|{{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{end}}' \
			"$container_id"
	)"
	expected_container_identity="running|healthy|unless-stopped|$CORE_POSTGRES_IMAGE|$CORE_POSTGRES_IMAGE_ID|core-monolith|temporary-postgres|monolith-removal|"
	if [[ "$container_identity" != "$expected_container_identity" ]]; then
		echo "Temporary core PostgreSQL container identity is unsafe." >&2
		return 1
	fi

	data_mount="$(
		docker inspect --format \
			'{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' \
			"$container_id"
	)"
	if [[ "$data_mount" != "volume|$CORE_POSTGRES_DATA_VOLUME|true" ]]; then
		echo "Temporary core PostgreSQL data mount is unsafe." >&2
		return 1
	fi

	secret_mount="$(
		docker inspect --format \
			'{{range .Mounts}}{{if eq .Destination "/run/secrets/core-postgres-admin-password"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' \
			"$container_id"
	)"
	if [[ "$secret_mount" != "bind|$CORE_POSTGRES_ADMIN_PASSWORD_FILE|false" ]]; then
		echo "Temporary core PostgreSQL admin-secret mount is unsafe." >&2
		return 1
	fi
	if [[ ! -f "$CORE_POSTGRES_ADMIN_PASSWORD_FILE" ||
		-L "$CORE_POSTGRES_ADMIN_PASSWORD_FILE" ||
		"$(stat -c '%a|%U:%G' "$CORE_POSTGRES_ADMIN_PASSWORD_FILE")" != "600|root:root" ]]; then
		echo "Temporary core PostgreSQL admin-secret file is unsafe." >&2
		return 1
	fi

	port_binding="$(docker port "$container_id" 5432/tcp 2>/dev/null || true)"
	if [[ "$port_binding" != "127.0.0.1:$CORE_POSTGRES_PORT" ]]; then
		echo "Temporary core PostgreSQL must expose only the canonical loopback port." >&2
		return 1
	fi

	container_env="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$container_id"
	)"
	for expected_env in \
		"POSTGRES_DB=$CORE_POSTGRES_DATABASE" \
		"POSTGRES_USER=$CORE_POSTGRES_ADMIN_USER" \
		"POSTGRES_PASSWORD_FILE=/run/secrets/core-postgres-admin-password" \
		"PGDATA=$CORE_POSTGRES_DATA_DIRECTORY" \
		"POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums"; do
		expected_env_count="$(
			grep -Fxc -- "$expected_env" <<<"$container_env" || true
		)"
		if [[ "$expected_env_count" != "1" ]]; then
			echo "Temporary core PostgreSQL environment identity is unsafe." >&2
			return 1
		fi
	done

	volume_identity="$(
		docker volume inspect --format \
			'{{.Driver}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}|{{index .Labels "com.winwidget.cleanup-after"}}' \
			"$CORE_POSTGRES_DATA_VOLUME" 2>/dev/null || true
	)"
	if [[ "$volume_identity" != "local|core-monolith|temporary-postgres|monolith-removal" ]]; then
		echo "Temporary core PostgreSQL volume identity is unsafe." >&2
		return 1
	fi
	attached_containers="$(
		docker ps -a \
			--filter "volume=$CORE_POSTGRES_DATA_VOLUME" \
			--format '{{.Names}}'
	)"
	if [[ "$attached_containers" != "$CORE_POSTGRES_CONTAINER" ]]; then
		echo "Temporary core PostgreSQL volume attachment is ambiguous." >&2
		return 1
	fi

	control_data="$(
		docker exec "$container_id" \
			pg_controldata "$CORE_POSTGRES_DATA_DIRECTORY"
	)" || {
		echo "Temporary core PostgreSQL control data is unavailable." >&2
		return 1
	}
	system_identifier="$(
		awk -F: '/Database system identifier/ {
			gsub(/[[:space:]]/, "", $2)
			print $2
		}' <<<"$control_data"
	)"
	cluster_state="$(
		awk -F: '/Database cluster state/ {
			sub(/^[[:space:]]*/, "", $2)
			sub(/[[:space:]]*$/, "", $2)
			print $2
		}' <<<"$control_data"
	)"
	checksum_version="$(
		awk -F: '/Data page checksum version/ {
			gsub(/[[:space:]]/, "", $2)
			print $2
		}' <<<"$control_data"
	)"
	if [[ "$system_identifier" != "$CORE_POSTGRES_SYSTEM_IDENTIFIER" ||
		"$cluster_state" != "in production" ||
		"$checksum_version" != "1" ]]; then
		echo "Temporary core PostgreSQL cluster fingerprint is unsafe." >&2
		return 1
	fi
	if ! docker exec "$container_id" pg_isready --quiet \
		--host 127.0.0.1 \
		--username "$CORE_POSTGRES_ADMIN_USER" \
		--dbname "$CORE_POSTGRES_DATABASE"; then
		echo "Temporary core PostgreSQL is not accepting connections." >&2
		return 1
	fi

	echo "Temporary core PostgreSQL container, volume and cluster fingerprint verified."
}

assert_core_database_production_boundary() {
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
}
