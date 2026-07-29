#!/usr/bin/env bash

# Shared fail-closed lifecycle guard for routine production rollouts.
# The database cutover script is the only owner allowed to create or replace
# the Notification Delivery PostgreSQL container and its persistent volume.

NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER="${NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.notification-delivery-database-cutover-v1}"
notification_database_cutover_active=false
notification_database_phase_before=""
notification_database_container_id_before=""
notification_database_container_snapshot_before=""
notification_database_volume_snapshot_before=""
notification_database_secret_snapshot_before=""

notification_database_marker_value() {
	local key="$1"

	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER"
}

validate_notification_database_cutover_marker() {
	local marker_mode
	local marker_owner
	local expected_port
	local expected_volume
	local expected_image

	[[ -f "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER" &&
		! -L "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER" ]] ||
		return 1
	marker_mode="$(
		stat -c '%a' "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER"
	)"
	marker_owner="$(
		stat -c '%u:%g' "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER"
	)"
	[[ "$marker_mode" == "600" && "$marker_owner" == "0:0" ]] ||
		return 1

	expected_port="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)"
	expected_volume="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
	)"
	expected_image="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_IMAGE)"
	awk -F= \
		-v target_port="$expected_port" \
		-v target_volume="$expected_volume" \
		-v postgres_image="$expected_image" '
		function valid_hash(value) {
			return value == "pending" || value ~ /^[0-9a-f]{64}$/
		}
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 != "version" &&
				$1 != "phase" &&
				$1 != "source_schema_state" &&
				$1 != "source_database" &&
				$1 != "source_endpoint_sha256" &&
				$1 != "source_system_identifier" &&
				$1 != "source_database_oid" &&
				$1 != "source_admin_audit_access_preexisting" &&
				$1 != "target_database" &&
				$1 != "target_host" &&
				$1 != "target_port" &&
				$1 != "target_volume" &&
				$1 != "postgres_image" &&
				$1 != "postgres_image_id" &&
				$1 != "postgres_system_identifier" &&
				$1 != "worker_image_id" &&
				$1 != "revision" &&
				$1 != "dump_sha256" &&
				$1 != "source_schema_sha256" &&
				$1 != "source_manifest_sha256" &&
				$1 != "target_manifest_sha256" &&
				$1 != "updated_at") invalid = 1
		}
		END {
			for (key in count) {
				if (count[key] != 1) invalid = 1
			}
			if (NR != 22 ||
				value["version"] != "7" ||
				value["phase"] !~ /^(preparing|restoring|prepared|forward_only|complete)$/ ||
				value["source_schema_state"] !~ /^(retained|dropped)$/ ||
				value["source_database"] !~ /^[A-Za-z_][A-Za-z0-9_]*$/ ||
				value["source_database"] == "winwidget_notification_delivery" ||
				value["source_endpoint_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["source_system_identifier"] !~ /^[0-9]+$/ ||
				value["source_database_oid"] !~ /^[0-9]+$/ ||
				value["source_admin_audit_access_preexisting"] !~ /^(true|false)$/ ||
				value["target_database"] != "winwidget_notification_delivery" ||
				value["target_host"] != "127.0.0.1" ||
				value["target_port"] != target_port ||
				value["target_volume"] != target_volume ||
				value["postgres_image"] != postgres_image ||
				value["postgres_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["postgres_system_identifier"] !~ /^[0-9]+$/ ||
				value["worker_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["revision"] !~ /^[0-9a-f]{40}$/ ||
				!valid_hash(value["dump_sha256"]) ||
				!valid_hash(value["source_schema_sha256"]) ||
				!valid_hash(value["source_manifest_sha256"]) ||
				!valid_hash(value["target_manifest_sha256"]) ||
				value["updated_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) invalid = 1
			if (value["phase"] ~ /^(prepared|forward_only|complete)$/ &&
				(value["dump_sha256"] == "pending" ||
					value["source_schema_sha256"] == "pending" ||
					value["source_manifest_sha256"] == "pending" ||
					value["target_manifest_sha256"] == "pending" ||
					value["target_manifest_sha256"] != value["source_manifest_sha256"])) invalid = 1
			if ((value["phase"] == "complete" && value["source_schema_state"] != "dropped") ||
				(value["phase"] != "complete" && value["source_schema_state"] != "retained")) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER"
}

assert_notification_database_postgres_identity() {
	if [[ "$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_IMAGE)" != "postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296" ||
		"$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)" != "55432" ||
		"$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME)" != "winwidget-notification-delivery-postgres-data" ||
		"$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER)" != "winwidget_notification_delivery_admin" ||
		"$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE)" != "$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password" ]]; then
		echo "Notification Delivery PostgreSQL production identity does not match the canonical image, port, volume, admin role or secret path." >&2
		return 1
	fi
}

notification_database_volume_snapshot() {
	local volume_name="$1"

	docker volume inspect --format \
		'{{ .Name }}|{{ .Driver }}|{{ .Scope }}|{{ .Mountpoint }}|{{ json .Options }}|{{ json .Labels }}|{{ .CreatedAt }}' \
		"$volume_name"
}

notification_database_container_snapshot() {
	local container_id="$1"

	docker inspect --format \
		'{{ .Id }}|{{ .Image }}|{{ .Created }}|{{ .State.StartedAt }}|{{ .RestartCount }}' \
		"$container_id"
}

verify_canonical_notification_database() {
	local expected_container_id="${1:-}"
	local expected_image
	local expected_port
	local expected_volume
	local expected_project
	local container_id
	local project_label
	local service_label
	local running
	local health
	local image_ref
	local volume_mount
	local port_binding
	local volume_owner
	local volume_purpose
	local volume_driver
	local volume_scope
	local attached_container_ids
	local owner_label
	local purpose_label
	local network_attachment
	local network_identity
	local network_container_ids
	local observed_image_id
	local marker_image_id
	local marker_system_identifier
	local identity
	local identity_database
	local identity_user
	local identity_major
	local identity_checksums
	local identity_data_directory
	local observed_system_identifier
	local admin_user
	local pgdata_env

	expected_image="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_IMAGE)"
	expected_port="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)"
	expected_volume="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
	)"
	expected_project="$(get_env_value COMPOSE_PROJECT_NAME)"
	admin_user="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER)"
	docker volume inspect "$expected_volume" >/dev/null 2>&1 || {
		echo "Notification Delivery PostgreSQL volume is missing: $expected_volume" >&2
		return 1
	}
	container_id="$(
		compose_target \
			--profile notification-delivery-database \
			ps -a -q notification-delivery-postgres \
			2>/dev/null || true
	)"
	if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
		echo "Exactly one canonical Notification Delivery PostgreSQL container is required after database cutover." >&2
		return 1
	fi
	if [[ -n "$expected_container_id" &&
		"$container_id" != "$expected_container_id" ]]; then
		echo "Routine rollout replaced the Notification Delivery PostgreSQL container." >&2
		return 1
	fi

	project_label="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.docker.compose.project" }}' \
			"$container_id"
	)"
	service_label="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.docker.compose.service" }}' \
			"$container_id"
	)"
	running="$(docker inspect --format '{{ .State.Running }}' "$container_id")"
	health="$(
		docker inspect --format \
			'{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' \
			"$container_id"
	)"
	image_ref="$(docker inspect --format '{{ .Config.Image }}' "$container_id")"
	observed_image_id="$(
		docker inspect --format '{{ .Image }}' "$container_id"
	)"
	owner_label="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.winwidget.owner" }}' \
			"$container_id"
	)"
	purpose_label="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.winwidget.purpose" }}' \
			"$container_id"
	)"
	pgdata_env="$(
		docker inspect --format '{{ range .Config.Env }}{{ println . }}{{ end }}' \
			"$container_id" |
			awk -F= '
				$1 == "PGDATA" {
					sub(/^[^=]*=/, "")
					print
					found += 1
				}
				END { exit(found == 1 ? 0 : 1) }
			'
	)"
	network_attachment="$(
		docker inspect --format \
			'{{ range $name, $_ := .NetworkSettings.Networks }}{{ println $name }}{{ end }}' \
			"$container_id"
	)"
	network_identity="$(
		docker network inspect \
			--format '{{ .Driver }}|{{ .Scope }}|{{ .Internal }}|{{ index .Labels "com.winwidget.owner" }}|{{ index .Labels "com.winwidget.purpose" }}' \
			"$network_attachment"
	)"
	network_container_ids="$(
		docker network inspect \
			--format '{{ range $id, $_ := .Containers }}{{ println $id }}{{ end }}' \
			"$network_attachment"
	)"
	volume_mount="$(
		docker inspect --format \
			'{{ range .Mounts }}{{ printf "%s|%s|%s|%t\n" .Destination .Type .Name .RW }}{{ end }}' \
			"$container_id" |
			awk -F'|' '$1 == "/var/lib/postgresql" || index($1, "/var/lib/postgresql/") == 1'
	)"
	port_binding="$(
		docker inspect --format \
			'{{ range $port, $bindings := .NetworkSettings.Ports }}{{ if eq $port "5432/tcp" }}{{ range $bindings }}{{ .HostIp }}|{{ .HostPort }}{{ "\n" }}{{ end }}{{ end }}{{ end }}' \
			"$container_id"
	)"
	volume_owner="$(
		docker volume inspect --format \
			'{{ index .Labels "com.winwidget.owner" }}' \
			"$expected_volume"
	)"
	volume_purpose="$(
		docker volume inspect --format \
			'{{ index .Labels "com.winwidget.purpose" }}' \
			"$expected_volume"
	)"
	volume_driver="$(
		docker volume inspect --format '{{ .Driver }}' "$expected_volume"
	)"
	volume_scope="$(
		docker volume inspect --format '{{ .Scope }}' "$expected_volume"
	)"
	attached_container_ids="$(
		docker ps -a --no-trunc \
			--filter "volume=$expected_volume" \
			--format '{{.ID}}'
	)"
	identity="$(
		docker exec "$container_id" \
			psql \
			--username "$admin_user" \
			--dbname postgres \
			--set ON_ERROR_STOP=1 \
			--quiet \
			--tuples-only \
			--no-align \
			--field-separator '|' \
			--command "
				SELECT
					current_database(),
					current_user,
					current_setting('server_version_num')::integer / 10000,
					current_setting('data_checksums'),
					current_setting('data_directory'),
					system_identifier
				FROM pg_control_system();
			"
	)" || {
		echo "Canonical Notification Delivery PostgreSQL identity query failed." >&2
		return 1
	}
	IFS='|' read -r \
		identity_database \
		identity_user \
		identity_major \
		identity_checksums \
		identity_data_directory \
		observed_system_identifier <<<"$identity"
	marker_image_id="$(
		notification_database_marker_value postgres_image_id
	)"
	marker_system_identifier="$(
		notification_database_marker_value postgres_system_identifier
	)"
	if [[ "$project_label" != "$expected_project" ||
		"$service_label" != "notification-delivery-postgres" ||
		"$running" != "true" ||
		"$health" != "healthy" ||
		"$image_ref" != "$expected_image" ||
		! "$observed_image_id" =~ ^sha256:[0-9a-f]{64}$ ||
		"$observed_image_id" != "$marker_image_id" ||
		"$owner_label" != "notification-delivery" ||
		"$purpose_label" != "postgres" ||
		"$pgdata_env" != "/var/lib/postgresql/18/docker" ||
		"$network_attachment" != "winwidget-notification-delivery-postgres" ||
		"$network_identity" != "bridge|local|true|notification-delivery|postgres-network" ||
		"$network_container_ids" != "$container_id" ||
		"$volume_mount" != "/var/lib/postgresql|volume|$expected_volume|true" ||
		"$port_binding" != "127.0.0.1|$expected_port" ||
		"$volume_owner" != "notification-delivery" ||
		"$volume_purpose" != "postgres-data" ||
		"$volume_driver" != "local" ||
		"$volume_scope" != "local" ||
		"$identity_database" != "postgres" ||
		"$identity_user" != "$admin_user" ||
		"$identity_major" != "18" ||
		"$identity_checksums" != "on" ||
		"$identity_data_directory" != "/var/lib/postgresql/18/docker" ||
		! "$observed_system_identifier" =~ ^[0-9]+$ ||
		"$observed_system_identifier" != "$marker_system_identifier" ||
		"$attached_container_ids" != "$container_id" ]]; then
		echo "Canonical Notification Delivery PostgreSQL container or volume invariant failed." >&2
		return 1
	fi

	printf '%s\n' "$container_id"
}

notification_database_secret_snapshot() {
	local secret_file
	local secret_value
	local secret_hash

	secret_file="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE
	)"
	[[ -f "$secret_file" && ! -L "$secret_file" &&
		"$(stat -c '%a' "$secret_file")" == "600" &&
		"$(stat -c '%u:%g' "$secret_file")" == "0:0" &&
		"$(awk 'END { print NR }' "$secret_file")" == "1" ]] ||
		return 1
	secret_value="$(tr -d '\r\n' <"$secret_file")"
	[[ "$secret_value" =~ ^[0-9a-f]{64}$ ]] || return 1
	secret_hash="$(sha256sum "$secret_file" | awk '{ print $1 }')"
	[[ "$secret_hash" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s|%s|%s\n' \
		"$(stat -c '%a:%u:%g:%s' "$secret_file")" \
		"$secret_hash" \
		"$secret_file"
}

initialize_notification_database_lifecycle_guard() {
	local allow_forward_only="$1"
	local rollout_label="$2"
	local phase
	local volume_name

	if [[ ! -e "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER" &&
		! -L "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER" ]]; then
		return
	fi
	if ! validate_notification_database_cutover_marker; then
		echo "Notification Delivery database cutover marker is invalid." >&2
		exit 1
	fi
	phase="$(notification_database_marker_value phase)"
	notification_database_phase_before="$phase"
	case "$phase" in
		complete)
			;;
		forward_only)
			if [[ "$allow_forward_only" != "true" ]]; then
				echo "Notification Delivery database cutover is in phase forward_only; after the required full deploy and both backups, rerun the database cutover target to finish it before $rollout_label." >&2
				exit 1
			fi
			;;
		*)
			echo "Notification Delivery database cutover is still in phase $phase; finish or recover it before $rollout_label." >&2
			exit 1
			;;
	esac

	notification_database_cutover_active=true
	notification_database_container_id_before="$(
		verify_canonical_notification_database
	)"
	notification_database_container_snapshot_before="$(
		notification_database_container_snapshot \
			"$notification_database_container_id_before"
	)"
	volume_name="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
	)"
	notification_database_volume_snapshot_before="$(
		notification_database_volume_snapshot "$volume_name"
	)"
	notification_database_secret_snapshot_before="$(
		notification_database_secret_snapshot
	)" || {
		echo "Notification Delivery PostgreSQL admin secret is missing or invalid." >&2
		exit 1
	}
}

assert_notification_database_backup_target_url() {
	local api_container_id
	local parser_image
	local backup_url
	local expected_port

	if [[ "$notification_database_cutover_active" != "true" ]]; then
		return
	fi
	api_container_id="$(
		compose_target ps --status running -q api 2>/dev/null || true
	)"
	if [[ -z "$api_container_id" || "$api_container_id" == *$'\n'* ]]; then
		echo "Exactly one running API container is required to validate the Notification Delivery backup target." >&2
		exit 1
	fi
	parser_image="$(
		docker inspect --format '{{ .Image }}' "$api_container_id"
	)"
	if [[ ! "$parser_image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		echo "The live API image for isolated Notification Delivery backup URL validation could not be resolved." >&2
		exit 1
	fi
	backup_url="$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)"
	expected_port="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)"

	if ! printf '%s\n' "$backup_url" |
		docker run --rm -i --network none \
			-e "TARGET_PORT=$expected_port" \
			--entrypoint node \
			"$parser_image" \
			-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};
const input = readFileSync(0, "utf8");
if (!input.endsWith("\n") || input.slice(0, -1).includes("\n")) {
	fail("NOTIFICATION_DELIVERY_BACKUP_URL is missing or contains a newline");
}

let url;
try {
	url = new URL(input.slice(0, -1));
} catch {
	fail("NOTIFICATION_DELIVERY_BACKUP_URL is not a valid URL");
}
if (
	!["postgres:", "postgresql:"].includes(url.protocol) ||
	!url.username ||
	!url.password ||
	url.hostname !== "127.0.0.1" ||
	(url.port || "5432") !== process.env.TARGET_PORT ||
	url.hash
) {
	fail(
		"After database cutover, NOTIFICATION_DELIVERY_BACKUP_URL must use explicit credentials and the canonical local PostgreSQL endpoint",
	);
}

let username;
let password;
let database;
try {
	username = decodeURIComponent(url.username);
	password = decodeURIComponent(url.password);
	database = decodeURIComponent(url.pathname.slice(1));
} catch {
	fail("NOTIFICATION_DELIVERY_BACKUP_URL contains invalid percent-encoding");
}
if (
	username !== "winwidget_notification_delivery_backup" ||
	!/^[^\u0000-\u001f\u007f]+$/.test(password) ||
	database !== "winwidget_notification_delivery"
) {
	fail(
		"NOTIFICATION_DELIVERY_BACKUP_URL must use the canonical backup role, a valid password and the target database",
	);
}

const schemas = url.searchParams.getAll("schema");
if (schemas.length !== 1 || schemas[0] !== "notification_delivery") {
	fail(
		"NOTIFICATION_DELIVERY_BACKUP_URL must contain exactly schema=notification_delivery",
	);
}
const tls = [...url.searchParams.entries()]
	.filter(([key]) => {
		const normalized = key.toLowerCase();
		return normalized.startsWith("ssl") || normalized === "channel_binding";
	})
	.map(([key, value]) => [key.toLowerCase(), value])
	.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
		leftKey === rightKey
			? leftValue.localeCompare(rightValue)
			: leftKey.localeCompare(rightKey),
	);
if (JSON.stringify(tls) !== JSON.stringify([["sslmode", "disable"]])) {
	fail(
		"After database cutover, NOTIFICATION_DELIVERY_BACKUP_URL must contain exactly sslmode=disable",
	);
}
process.stdout.write(
	"Notification Delivery maintenance backup target URL validated\n",
);
'; then
		exit 1
	fi
}

verify_notification_database_lifecycle_unchanged() {
	local rollout_label="$1"
	local expected_phase="$2"
	local phase
	local volume_name
	local container_snapshot_after
	local volume_snapshot_after
	local secret_snapshot_after

	if [[ "$notification_database_cutover_active" != "true" ]]; then
		if [[ -e "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER" ||
			-L "$NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER" ]]; then
			echo "Notification Delivery database cutover marker appeared during $rollout_label." >&2
			exit 1
		fi
		return
	fi
	validate_notification_database_cutover_marker || {
		echo "Notification Delivery database cutover marker became invalid during $rollout_label." >&2
		exit 1
	}
	phase="$(notification_database_marker_value phase)"
	if [[ "$phase" != "$expected_phase" ]]; then
		echo "Notification Delivery database cutover phase changed unexpectedly during $rollout_label: expected $expected_phase, got $phase." >&2
		exit 1
	fi
	verify_canonical_notification_database \
		"$notification_database_container_id_before" >/dev/null
	container_snapshot_after="$(
		notification_database_container_snapshot \
			"$notification_database_container_id_before"
	)"
	if [[ "$container_snapshot_after" != "$notification_database_container_snapshot_before" ]]; then
		echo "$rollout_label stopped, restarted or changed the Notification Delivery PostgreSQL container." >&2
		exit 1
	fi
	volume_name="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
	)"
	volume_snapshot_after="$(
		notification_database_volume_snapshot "$volume_name"
	)"
	if [[ "$volume_snapshot_after" != "$notification_database_volume_snapshot_before" ]]; then
		echo "$rollout_label changed the Notification Delivery PostgreSQL volume." >&2
		exit 1
	fi
	secret_snapshot_after="$(
		notification_database_secret_snapshot
	)" || {
		echo "Notification Delivery PostgreSQL admin secret became invalid during $rollout_label." >&2
		exit 1
	}
	if [[ "$secret_snapshot_after" != "$notification_database_secret_snapshot_before" ]]; then
		echo "$rollout_label changed the Notification Delivery PostgreSQL admin secret." >&2
		exit 1
	fi
}
