#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-telegram-cutover-v1"
HEALTHCHECK_ATTEMPTS="${NOTIFICATION_DELIVERY_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${NOTIFICATION_DELIVERY_HEALTHCHECK_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "Notification Delivery deployment"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/reporting-cutover-lifecycle.sh
source "$server_root/scripts/reporting-cutover-lifecycle.sh"
recreate_started=false
rollout_verified=false
previous_image_ref=""
previous_image_id=""
previous_revision=""
previous_restart_count=""
health_port=""

compose_target() {
	docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		"$@"
}

verify_notification_delivery_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$NOTIFICATION_DELIVERY_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/main.js",
	"prisma/schema.prisma",
]) {
	fs.accessSync(required);
}
require("@prisma/notification-delivery-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/messaging/notification-delivery-client.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(
			`Notification Delivery image contains monolith artifact: ${forbidden}`,
		);
	}
}
process.stdout.write("Standalone Notification Delivery image artifact verified\n");
'
}

verify_notification_delivery_worker() {
	local expected_image_id="$1"
	local expected_revision="$2"
	local expected_restart_count="${3:-0}"
	local attempt
	local container_id
	local health_status
	local response
	local image_id
	local image_revision
	local restart_count

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(
			compose_target ps --status running -q notification-delivery-worker \
				2>/dev/null || true
		)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health_status="$(
				docker inspect \
					--format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$health_status" == "healthy" ]]; then
				response="$(
					curl -fs \
						--connect-timeout 2 \
						--max-time 5 \
						"http://127.0.0.1:$health_port/health/ready" \
						2>/dev/null || true
				)"
				if printf '%s' "$response" |
					grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$expected_revision\""; then
					image_id="$(
						docker inspect --format '{{ .Image }}' "$container_id"
					)"
					image_revision="$(
						docker image inspect \
							--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
							"$image_id"
					)"
					restart_count="$(
						docker inspect --format '{{ .RestartCount }}' "$container_id"
					)"

					[[ "$image_id" == "$expected_image_id" ]] || return 1
					[[ "$image_revision" == "$expected_revision" ]] || return 1
					[[ "$restart_count" == "$expected_restart_count" ]] || return 1
					return 0
				fi
			fi
		fi

		sleep "$HEALTHCHECK_INTERVAL"
	done

	return 1
}

verify_notification_delivery_runtime_crud() {
	compose_target run --rm --no-deps \
		--entrypoint node \
		notification-delivery-worker \
		-e '
const { randomUUID } = require("node:crypto");
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});
const instanceId = `deployment-smoke-${randomUUID()}`;

prisma
	.$transaction(async transaction => {
		const grants = await transaction.$queryRawUnsafe(`
			SELECT
				tablename,
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$insert$INSERT$insert$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$update$UPDATE$update$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$delete$DELETE$delete$
				) AS allowed
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
				AND tablename <> $migrations$_prisma_migrations$migrations$
		`);
		if (
			!Array.isArray(grants) ||
			grants.length === 0 ||
			grants.some(grant => grant.allowed !== true)
		) {
			throw new Error("runtime CRUD grants are incomplete");
		}
		const migrationTablePrivileges = await transaction.$queryRawUnsafe(`
			SELECT (
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$insert$INSERT$insert$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$update$UPDATE$update$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$delete$DELETE$delete$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$truncate$TRUNCATE$truncate$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$references$REFERENCES$references$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$trigger$TRIGGER$trigger$
				)
			) AS allowed
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
				AND tablename = $migrations$_prisma_migrations$migrations$
		`);
		if (
			migrationTablePrivileges.length !== 1 ||
			migrationTablePrivileges[0]?.allowed !== false
		) {
			throw new Error(
				"runtime role must not access the Prisma migration history table",
			);
		}
		const privilegeRows = await transaction.$queryRawUnsafe(`
			SELECT
				roles.rolsuper AS role_super,
				roles.rolcreatedb AS role_create_database,
				roles.rolcreaterole AS role_create_role,
				pg_get_userbyid(databases.datdba) = current_user AS database_owner,
				pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
				has_database_privilege(
					current_user,
					current_database(),
					$privilege$CREATE$privilege$
				) AS database_create,
				has_schema_privilege(
					current_user,
					$schema$notification_delivery$schema$,
					$privilege$CREATE$privilege$
				) AS schema_create
			FROM pg_roles AS roles
			JOIN pg_database AS databases
				ON databases.datname = current_database()
			JOIN pg_namespace AS namespaces
				ON namespaces.nspname = $schema$notification_delivery$schema$
			WHERE roles.rolname = current_user
		`);
		const privilege = privilegeRows[0];
		if (
			privilegeRows.length !== 1 ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== false ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== false
		) {
			throw new Error("runtime role has unsafe PostgreSQL privileges");
		}
		const foreignTablePrivileges = await transaction.$queryRawUnsafe(`
			SELECT schemaname, tablename
			FROM pg_tables
			WHERE schemaname <> $schema$notification_delivery$schema$
				AND schemaname NOT IN (
					$catalog$pg_catalog$catalog$,
					$information$information_schema$information$
				)
				AND (
					has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$select$SELECT$select$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$insert$INSERT$insert$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$update$UPDATE$update$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$delete$DELETE$delete$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$truncate$TRUNCATE$truncate$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$references$REFERENCES$references$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$trigger$TRIGGER$trigger$
					)
				)
		`);
		if (
			!Array.isArray(foreignTablePrivileges) ||
			foreignTablePrivileges.length > 0
		) {
			throw new Error(
				"runtime role has table privileges outside notification_delivery",
			);
		}
		const foreignSchemaCreatePrivileges =
			await transaction.$queryRawUnsafe(`
				SELECT namespaces.nspname
				FROM pg_namespace AS namespaces
				WHERE namespaces.nspname <> $schema$notification_delivery$schema$
					AND namespaces.nspname <> $information$information_schema$information$
					AND left(namespaces.nspname, 3) <> $system$pg_$system$
					AND has_schema_privilege(
						current_user,
						namespaces.oid,
						$privilege$CREATE$privilege$
					)
			`);
		if (
			!Array.isArray(foreignSchemaCreatePrivileges) ||
			foreignSchemaCreatePrivileges.length > 0
		) {
			throw new Error(
				"runtime role has CREATE on a schema outside notification_delivery",
			);
		}
		await transaction.notificationDeliveryHeartbeat.create({
			data: {
				service: "deployment-runtime-crud-smoke",
				instanceId,
				metadata: { phase: "created" },
			},
		});
		const created =
			await transaction.notificationDeliveryHeartbeat.findUnique({
				where: {
					service_instanceId: {
						service: "deployment-runtime-crud-smoke",
						instanceId,
					},
				},
			});
		if (!created) throw new Error("runtime SELECT did not return the smoke row");
		await transaction.notificationDeliveryHeartbeat.update({
			where: {
				service_instanceId: {
					service: "deployment-runtime-crud-smoke",
					instanceId,
				},
			},
			data: { metadata: { phase: "updated" } },
		});
		await transaction.notificationDeliveryHeartbeat.delete({
			where: {
				service_instanceId: {
					service: "deployment-runtime-crud-smoke",
					instanceId,
				},
			},
		});
	})
	.then(() => {
		process.stdout.write(
			"Notification delivery runtime CRUD permissions verified\n",
		);
	})
	.catch(() => {
		process.stderr.write(
			"Notification delivery runtime role failed the CRUD permissions smoke\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
	'
}

verify_notification_delivery_migration_boundary() {
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps \
		--entrypoint node \
		notification-delivery-migrate \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

prisma
	.$queryRawUnsafe(`
		SELECT
			roles.rolsuper AS role_super,
			roles.rolcreatedb AS role_create_database,
			roles.rolcreaterole AS role_create_role,
			pg_get_userbyid(databases.datdba) = current_user AS database_owner,
			pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
			has_database_privilege(
				current_user,
				current_database(),
				$privilege$CREATE$privilege$
			) AS database_create,
			has_schema_privilege(
				current_user,
				$schema$notification_delivery$schema$,
				$privilege$CREATE$privilege$
			) AS schema_create
		FROM pg_roles AS roles
		JOIN pg_database AS databases
			ON databases.datname = current_database()
		JOIN pg_namespace AS namespaces
			ON namespaces.nspname = $schema$notification_delivery$schema$
		WHERE roles.rolname = current_user
	`)
	.then(rows => {
		const privilege = rows[0];
		if (
			rows.length !== 1 ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== true ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== true
		) {
			throw new Error("migration role has unsafe PostgreSQL privileges");
		}
		process.stdout.write(
			"Notification delivery migration role boundary verified\n",
		);
	})
	.catch(() => {
		process.stderr.write(
			"Notification delivery migration role failed its privilege boundary smoke\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

verify_notification_delivery_control_smoke() {
	local expected_revision="$1"

	compose_target exec -T \
		-e "EXPECTED_NOTIFICATION_DELIVERY_REVISION=$expected_revision" \
		api node -e '
const { randomUUID } = require("node:crypto");
const {
	NotificationDeliveryClientService,
	NotificationDeliveryInternalApiError,
} = require("./dist/src/messaging/notification-delivery-client.service.js");

const fail = message => {
	throw new Error(message);
};
const expectValidationFailure = async (operation, label) => {
	try {
		await operation();
	} catch (error) {
		if (
			error instanceof NotificationDeliveryInternalApiError &&
			error.statusCode === 400
		) {
			return;
		}
		throw error;
	}
	fail(`${label} did not preserve its validation contract`);
};
const run = async () => {
	const healthResponse = await fetch("http://127.0.0.1:4401/health/ready", {
		redirect: "error",
		signal: AbortSignal.timeout(5000),
	});
	if (!healthResponse.ok) {
		await healthResponse.body?.cancel();
		fail(`Notification delivery readiness returned HTTP ${healthResponse.status}`);
	}
	const health = await healthResponse.json();
	if (
		health?.status !== "ready" ||
		health?.service !== "notification-delivery-worker" ||
		health?.revision !== process.env.EXPECTED_NOTIFICATION_DELIVERY_REVISION
	) {
		fail("Notification delivery readiness contract or revision is invalid");
	}

	const configService = {
		get: key => process.env[key],
	};
	const client = new NotificationDeliveryClientService(configService);
	await client.getOverview();
	await client.getFailures(1, 1, {});
	const validationId = randomUUID();
	await expectValidationFailure(
		() => client.retryFailure(validationId, ""),
		"retry endpoint",
	);
	await expectValidationFailure(
		() =>
			client.closeFailure(
				validationId,
				"deployment-control-smoke",
				"x",
			),
		"close endpoint",
	);
};

run()
	.then(() => {
		process.stdout.write(
			"Notification delivery authenticated control contract verified\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery control contract smoke failed"}\n`,
		);
		process.exitCode = 1;
	});
	'
}

verify_notification_consumer_ownership() {
	local expected_user

	expected_user="$(
		get_env_value RABBITMQ_NOTIFICATION_DELIVERY_URL |
			docker run --rm -i --network none \
				--entrypoint node \
				"$NOTIFICATION_DELIVERY_IMAGE" \
				-e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8").trim());
const username = decodeURIComponent(url.username);
if (!username) process.exit(1);
process.stdout.write(username);
'
	)"

	compose_target exec -T \
		-e "EXPECTED_NOTIFICATION_RABBITMQ_USER=$expected_user" \
		api node -e '
const {
	MESSAGING_QUEUE_NAMES,
} = require("./dist/src/messaging/messaging.constants.js");

const fail = message => {
	throw new Error(message);
};
const run = async () => {
	const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL.replace(/\/$/, "");
	const vhost = process.env.RABBITMQ_VHOST;
	const authorization = `Basic ${Buffer.from(
		`${process.env.RABBITMQ_MONITOR_USER}:${process.env.RABBITMQ_MONITOR_PASSWORD}`,
	).toString("base64")}`;
	const expectedUser = process.env.EXPECTED_NOTIFICATION_RABBITMQ_USER;
	if (!expectedUser) fail("notification RabbitMQ user is invalid");

	const response = await fetch(`${baseUrl}/api/connections`, {
		headers: { Authorization: authorization },
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		fail(`RabbitMQ connections returned HTTP ${response.status}`);
	}
	const connections = await response.json();
	if (!Array.isArray(connections)) fail("RabbitMQ connections are invalid");
	const bySocketName = new Map(
		connections.map(connection => [connection.name, connection]),
	);

	for (const kind of [
		"email",
		"telegram",
		"payment-email",
		"payment-telegram",
		"limit-email",
		"limit-telegram",
		"campaign-email",
		"campaign-telegram",
		"daily-summary-delivery-telegram",
		"subscription-expiry-email",
		"subscription-expiry-telegram",
	]) {
		const baseQueue = MESSAGING_QUEUE_NAMES[kind];
		for (const queue of [baseQueue, `${baseQueue}.dead-letter`]) {
			const queueResponse = await fetch(
				`${baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(
					queue,
				)}`,
				{
					headers: { Authorization: authorization },
					signal: AbortSignal.timeout(5000),
				},
			);
			if (!queueResponse.ok) {
				await queueResponse.body?.cancel();
				fail(`RabbitMQ queue ${queue} returned HTTP ${queueResponse.status}`);
			}
			const state = await queueResponse.json();
			const consumers = Array.isArray(state?.consumer_details)
				? state.consumer_details
				: [];
			if (consumers.length !== 1) {
				fail(`RabbitMQ queue ${queue} must have exactly one consumer`);
			}
			const socketName =
				consumers[0]?.channel_details?.connection_name;
			const connection = bySocketName.get(socketName);
			if (
				connection?.user !== expectedUser ||
				connection?.client_properties?.connection_name !==
					"winwidget-notification-delivery-worker"
			) {
				fail(`RabbitMQ queue ${queue} has an unexpected owner`);
			}
		}
	}
};

run()
	.then(() => {
		process.stdout.write(
			"Notification delivery RabbitMQ consumer ownership verified\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "RabbitMQ consumer ownership verification failed"}\n`,
		);
		process.exitCode = 1;
	});
'
}

rollback_previous_notification_delivery_worker() {
	local attempt

	export NOTIFICATION_DELIVERY_IMAGE="$previous_image_ref"
	export NOTIFICATION_DELIVERY_REVISION="$previous_revision"
	export APP_REVISION="$previous_revision"
	export APP_VERSION="git-$previous_revision"

	if ! docker image inspect "$previous_image_id" >/dev/null 2>&1; then
		echo "Previous notification delivery image is no longer available; rollback failed." >&2
		return 1
	fi
	if ! compose_target up \
		-d \
		--no-deps \
		--force-recreate \
		notification-delivery-worker; then
		echo "Previous notification delivery image could not be recreated." >&2
		return 1
	fi
	if ! verify_notification_delivery_worker \
		"$previous_image_id" \
		"$previous_revision"; then
		echo "Previous notification delivery worker did not recover to healthy state." >&2
		return 1
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_notification_consumer_ownership; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Previous notification delivery worker did not recover exact RabbitMQ ownership." >&2
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	return 0
}

handle_exit() {
	local status=$?
	local rollback_status

	trap - EXIT INT TERM
	if ((status == 0)); then
		return
	fi
	if [[ "$recreate_started" != "true" || "$rollout_verified" == "true" ]]; then
		exit "$status"
	fi

	echo "Notification delivery rollout failed after recreate; restoring previous image." >&2
	set +e
	rollback_previous_notification_delivery_worker
	rollback_status=$?
	if ((rollback_status == 0)); then
		echo "Previous notification delivery image was restored and is healthy." >&2
	else
		echo "CRITICAL: automatic notification delivery rollback failed." >&2
	fi
	exit "$status"
}

trap handle_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$APP_ROOT"

if [[ ! -d "$server_root/.git" ]]; then
	echo "Backend checkout was not found." >&2
	exit 1
fi

deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
if [[ "$deploy_revision" != "$expected_revision" ]]; then
	echo "Notification delivery deployment revision does not match EXPECTED_REVISION." >&2
	exit 1
fi

dirty_files="$(
	git -C "$server_root" status --porcelain --untracked-files=all
)"
if [[ -n "$dirty_files" ]]; then
	echo "Backend deployment checkout is not clean:" >&2
	echo "$dirty_files" >&2
	exit 1
fi
reporting_guard_before_checkout_revision "$deploy_revision" || {
	echo 'Notification Delivery deployment revision conflicts with the active Reporting lifecycle.' >&2
	exit 1
}
source "$server_root/scripts/notification-delivery-database-lifecycle.sh"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Backend production env file was not found." >&2
	exit 1
fi
env_mode="$(stat -c '%a' "$ENV_FILE")"
if [[ "$env_mode" != "600" ]]; then
	echo "Backend production env file mode must be exactly 600." >&2
	exit 1
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Backend production Compose file was not found." >&2
	exit 1
fi

# database-restore-production-guard: before-mutation
database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"

duplicate_env_keys="$(
	awk '
		/^[[:space:]]*(#|$)/ { next }
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			if (line !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next

			name = line
			sub(/[[:space:]]*=.*/, "", name)
			count[name] += 1
		}
		END {
			for (name in count) {
				if (count[name] > 1) print name
			}
		}
	' "$ENV_FILE" | LC_ALL=C sort
)"
if [[ -n "$duplicate_env_keys" ]]; then
	echo "Duplicate environment keys are not allowed:" >&2
	echo "$duplicate_env_keys" >&2
	exit 1
fi

require_env_key() {
	local key="$1"

	if ! awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)

			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)

			if (name == key &&
				value != "" &&
				value !~ /^(change_me|XYZXYZXYZ)/) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "Missing required production env key: $key" >&2
		exit 1
	fi
}

get_env_value() {
	local key="$1"

	awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)

			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)

			if (name == key) {
				print value
				found = 1
				exit
			}
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"
}

get_env_value_or_default() {
	local key="$1"
	local fallback="$2"
	local value

	value="$(get_env_value "$key" || true)"
	printf '%s' "${value:-$fallback}"
}

normalize_csv() {
	tr ',' '\n' <<<"$1" |
		sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		sed '/^$/d' |
		LC_ALL=C sort -u |
		paste -sd, -
}

container_env_value() {
	local container_id="$1"
	local key="$2"

	docker inspect --format '{{ range .Config.Env }}{{ println . }}{{ end }}' \
		"$container_id" |
		awk -F= -v key="$key" '
			$1 == key {
				sub(/^[^=]*=/, "")
				print
				found = 1
				exit
			}
			END { exit(found ? 0 : 1) }
		'
}

validate_notification_cutover_marker() {
	local marker_path="${1:-$NOTIFICATION_DELIVERY_CUTOVER_MARKER}"
	local marker_mode
	local marker_owner

	if [[ ! -f "$marker_path" ||
		-L "$marker_path" ]]; then
		return 1
	fi
	marker_mode="$(stat -c '%a' "$marker_path")"
	marker_owner="$(stat -c '%u' "$marker_path")"
	if [[ "$marker_mode" != "600" ||
		"$marker_owner" != "$(id -u)" ]]; then
		return 1
	fi
	awk '
		NR == 1 && $0 ~ /^revision=[0-9a-f]{40}$/ { revision = 1; next }
		NR == 2 &&
			$0 ~ /^created_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/ {
			created = 1
			next
		}
		{ invalid = 1 }
		END {
			exit(revision && created && NR == 2 && !invalid ? 0 : 1)
		}
	' "$marker_path"
}

assert_live_env_matches() {
	local container_id="$1"
	local container_key="$2"
	local expected_value="$3"
	local live_value

	live_value="$(
		container_env_value "$container_id" "$container_key" || true
	)"
	if [[ "$live_value" != "$expected_value" ]]; then
		echo "Live $container_key differs from the candidate production configuration." >&2
		echo "Credential, token, endpoint and shared runtime configuration changes require the full deployment target." >&2
		exit 1
	fi
}

validate_notification_database_urls() {
	local parser_image="$1"
	local notification_database_cutover_active=true
	local runtime_url
	local migration_url
	local backup_url

	runtime_url="$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)"
	migration_url="$(
		get_env_value NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
	)"
	backup_url="$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)"

	if ! printf '%s\n%s\n%s\n' "$runtime_url" "$migration_url" "$backup_url" |
		docker run --rm -i --network none \
			-e "NOTIFICATION_DATABASE_CUTOVER_ACTIVE=$notification_database_cutover_active" \
			-e "NOTIFICATION_DATABASE_TARGET_PORT=$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)" \
			--entrypoint node \
			"$parser_image" \
			-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};
const input = readFileSync(0, "utf8");
const lines = input.endsWith("\n")
	? input.slice(0, -1).split("\n")
	: input.split("\n");
if (lines.length !== 3 || lines.some(value => !value)) {
	fail("Notification delivery PostgreSQL URLs are missing or contain a newline");
}
const parse = (value, label) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`${label} is not a valid URL`);
	}
	if (!["postgres:", "postgresql:"].includes(url.protocol)) {
		fail(`${label} must use postgres or postgresql`);
	}
	if (
		!url.hostname ||
		!url.username ||
		!url.password ||
		url.hash ||
		(url.port && !/^[0-9]+$/.test(url.port))
	) {
		fail(`${label} must contain explicit credentials, host and a valid port`);
	}
	let username;
	let database;
	try {
		username = decodeURIComponent(url.username);
		database = decodeURIComponent(url.pathname.slice(1));
	} catch {
		fail(`${label} contains invalid percent-encoding`);
	}
	if (
		!username ||
		!/^[A-Za-z0-9._-]+$/.test(username) ||
		!database ||
		database.includes("/")
	) {
		fail(`${label} contains an invalid role or database name`);
	}
	const schemas = url.searchParams.getAll("schema");
	if (
		schemas.length !== 1 ||
		schemas[0] !== "notification_delivery"
	) {
		fail(`${label} must contain exactly schema=notification_delivery`);
	}
	const ssl = [...url.searchParams.entries()]
		.filter(([key]) => {
			const normalized = key.toLowerCase();
			return (
				normalized.startsWith("ssl") ||
				normalized === "channel_binding"
			);
		})
		.map(([key, entryValue]) => [
			key.toLowerCase(),
			entryValue,
		])
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? leftValue.localeCompare(rightValue)
				: leftKey.localeCompare(rightKey),
		);
	return {
		protocol: url.protocol,
		host: url.hostname.toLowerCase(),
		port: url.port || "5432",
		database,
		username,
		ssl: JSON.stringify(ssl),
	};
};
const runtime = parse(lines[0], "NOTIFICATION_DELIVERY_DATABASE_URL");
const migration = parse(
	lines[1],
	"NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION",
);
const backup = parse(lines[2], "NOTIFICATION_DELIVERY_BACKUP_URL");
const targetPort = process.env.NOTIFICATION_DATABASE_TARGET_PORT;
const cutoverActive =
	process.env.NOTIFICATION_DATABASE_CUTOVER_ACTIVE === "true";
const targetsCanonicalEndpoint =
	runtime.host === "127.0.0.1" && runtime.port === targetPort;
const targetsLocalEndpoint =
	["127.0.0.1", "localhost", "[::1]"].includes(runtime.host) &&
	runtime.port === targetPort;
const targetsLocalDatabase =
	targetsCanonicalEndpoint &&
	runtime.database === "winwidget_notification_delivery";
if (cutoverActive && !targetsLocalDatabase) {
	fail(
		"After database cutover, Notification delivery PostgreSQL URLs must target 127.0.0.1, the canonical port and database winwidget_notification_delivery",
	);
}
if (
	cutoverActive &&
	runtime.ssl !== JSON.stringify([["sslmode", "disable"]])
) {
	fail(
		"After database cutover, Notification delivery PostgreSQL URLs must contain exactly sslmode=disable",
	);
}
if (
	!cutoverActive &&
	(
		targetsLocalEndpoint ||
		runtime.database === "winwidget_notification_delivery"
	)
) {
	fail(
		"The local Notification Delivery database cannot be selected before the durable database cutover marker",
	);
}
for (const candidate of [migration, backup]) {
	for (const key of ["protocol", "host", "port", "database", "ssl"]) {
		if (runtime[key] === candidate[key]) continue;
		fail(
			"Notification delivery runtime, migration and backup URLs must target the same protocol, host, port, database and SSL settings",
		);
	}
}
if (new Set([runtime.username, migration.username, backup.username]).size !== 3) {
	fail(
		"Notification delivery runtime, migration and backup URLs must use distinct roles",
	);
}
process.stdout.write("Notification delivery PostgreSQL URL structure validated\n");
'; then
		exit 1
	fi
}

require_env_exact_list() {
	local key="$1"
	local expected="$2"
	local value
	local normalized
	local normalized_expected

	value="$(get_env_value "$key" || true)"
	normalized="$(
		tr ',' '\n' <<<"$value" |
			sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
			sed '/^$/d' |
			sort -u |
			paste -sd, -
	)"
	normalized_expected="$(
		tr ',' '\n' <<<"$expected" |
			sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
			sed '/^$/d' |
			sort -u |
			paste -sd, -
	)"
	if [[ "$normalized" != "$normalized_expected" ]]; then
		echo "$key must contain exactly: $expected" >&2
		exit 1
	fi
}

for key in \
	MODE \
	COMPOSE_PROJECT_NAME \
	NOTIFICATION_DELIVERY_DATABASE_URL \
	NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION \
	NOTIFICATION_DELIVERY_BACKUP_URL \
	NOTIFICATION_DELIVERY_POSTGRES_IMAGE \
	NOTIFICATION_DELIVERY_POSTGRES_PORT \
	NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME \
	NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER \
	NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE \
	RABBITMQ_NOTIFICATION_DELIVERY_URL \
	RABBITMQ_INTEGRATION_WORKER_URL \
	RABBITMQ_MANAGEMENT_URL \
	RABBITMQ_MONITOR_USER \
	RABBITMQ_MONITOR_PASSWORD \
	RABBITMQ_VHOST \
	SMTP_SERVER \
	SMTP_LOGIN \
	SMTP_PASSWORD \
	SMTP_CONNECTION_TIMEOUT_MS \
	SMTP_GREETING_TIMEOUT_MS \
	SMTP_SOCKET_TIMEOUT_MS \
	TELEGRAM_INFO_BOT_TOKEN \
	NOTIFICATION_DELIVERY_INTERNAL_URL \
	NOTIFICATION_DELIVERY_INTERNAL_TOKEN \
	NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS \
	NOTIFICATION_DELIVERY_LISTEN_HOST \
	NOTIFICATION_DELIVERY_HEALTH_PORT \
	NOTIFICATION_DELIVERY_PREFETCH \
	NOTIFICATION_DELIVERY_KINDS; do
	require_env_key "$key"
done

if [[ "$(get_env_value MODE)" != "production" ]]; then
	echo "Notification delivery rollout requires MODE=production." >&2
	exit 1
fi
if [[ "$(get_env_value COMPOSE_PROJECT_NAME)" != "winwidget" ]]; then
	echo "Notification delivery rollout requires COMPOSE_PROJECT_NAME=winwidget." >&2
	exit 1
fi
assert_notification_database_postgres_identity
if [[ "$(get_env_value RABBITMQ_MANAGEMENT_URL)" != "http://127.0.0.1:15672" ]]; then
	echo "RABBITMQ_MANAGEMENT_URL must use the loopback production endpoint." >&2
	exit 1
fi
if [[ "$(get_env_value RABBITMQ_VHOST)" != "winwidget" ]]; then
	echo "RABBITMQ_VHOST must be winwidget." >&2
	exit 1
fi
rabbitmq_monitor_password="$(get_env_value RABBITMQ_MONITOR_PASSWORD)"
if [[ ${#rabbitmq_monitor_password} -lt 32 ]]; then
	echo "RABBITMQ_MONITOR_PASSWORD must contain at least 32 characters." >&2
	exit 1
fi

health_port="$(get_env_value NOTIFICATION_DELIVERY_HEALTH_PORT)"
if [[ "$health_port" != "4401" ]]; then
	echo "NOTIFICATION_DELIVERY_HEALTH_PORT must be 4401." >&2
	exit 1
fi
if [[ "$(get_env_value NOTIFICATION_DELIVERY_LISTEN_HOST)" != "127.0.0.1" ]]; then
	echo "NOTIFICATION_DELIVERY_LISTEN_HOST must be 127.0.0.1." >&2
	exit 1
fi
notification_delivery_internal_token="$(
	get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN
)"
if [[ "$notification_delivery_internal_token" == "XYZXYZXYZ" ||
	"$notification_delivery_internal_token" == change_me* ||
	${#notification_delivery_internal_token} -lt 32 ]]; then
	echo "NOTIFICATION_DELIVERY_INTERNAL_TOKEN must be a non-placeholder value of at least 32 characters." >&2
	exit 1
fi
notification_delivery_prefetch="$(
	get_env_value NOTIFICATION_DELIVERY_PREFETCH
)"
if [[ ! "$notification_delivery_prefetch" =~ ^[1-9][0-9]*$ ]] ||
	((notification_delivery_prefetch > 100)); then
	echo "NOTIFICATION_DELIVERY_PREFETCH must be between 1 and 100." >&2
	exit 1
fi
for smtp_timeout_key in \
	SMTP_CONNECTION_TIMEOUT_MS \
	SMTP_GREETING_TIMEOUT_MS \
	SMTP_SOCKET_TIMEOUT_MS; do
	smtp_timeout_value="$(get_env_value "$smtp_timeout_key")"
	if [[ ! "$smtp_timeout_value" =~ ^[0-9]+$ ]] ||
		((smtp_timeout_value < 1000 || smtp_timeout_value > 60000)); then
		echo "$smtp_timeout_key must be between 1000 and 60000." >&2
		exit 1
	fi
done
notification_delivery_internal_timeout_ms="$(
	get_env_value NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS
)"
if [[ ! "$notification_delivery_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
	((notification_delivery_internal_timeout_ms < 500 ||
		notification_delivery_internal_timeout_ms > 30000)); then
	echo "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS must be between 500 and 30000." >&2
	exit 1
fi
if [[ "$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_URL)" != "http://127.0.0.1:4401/internal/notification-delivery" ]]; then
	echo "NOTIFICATION_DELIVERY_INTERNAL_URL must use the loopback notification delivery endpoint." >&2
	exit 1
fi
require_env_exact_list \
	"NOTIFICATION_DELIVERY_KINDS" \
	"email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram"
if [[ ! "$HEALTHCHECK_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
	echo "NOTIFICATION_DELIVERY_HEALTHCHECK_ATTEMPTS must be a positive integer." >&2
	exit 1
fi
if [[ ! "$HEALTHCHECK_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
	echo "NOTIFICATION_DELIVERY_HEALTHCHECK_INTERVAL must be a positive integer." >&2
	exit 1
fi

ambient_compose_overrides=()
while IFS= read -r key; do
	[[ -n "$key" ]] || continue
	case "$key" in
		APP_REVISION | APP_VERSION | COMPOSE_PROJECT_NAME | NOTIFICATION_DELIVERY_IMAGE | NOTIFICATION_DELIVERY_REVISION)
			continue
			;;
	esac
	if printenv "$key" >/dev/null 2>&1; then
		ambient_compose_overrides+=("$key")
	fi
done < <(
	LC_ALL=C grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" |
		sed 's/^${//' |
		LC_ALL=C sort -u
)
if ((${#ambient_compose_overrides[@]} > 0)); then
	echo "Unset shell variables that would override the production env file:" >&2
	printf '%s\n' "${ambient_compose_overrides[@]}" >&2
	exit 1
fi

export COMPOSE_PROJECT_NAME=winwidget
export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"
export NOTIFICATION_DELIVERY_REVISION="$deploy_revision"
export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$deploy_revision"

initialize_notification_database_lifecycle_guard \
	false \
	"a service-only rollout"

compose_target \
	--profile notification-delivery-migration \
	config --quiet

if ! validate_notification_cutover_marker \
	"$NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER" ||
	! validate_notification_cutover_marker; then
	echo "Both durable Notification Delivery ownership markers are required for a service-only rollout." >&2
	echo "Use the full deployment target to complete or recover an ownership cutover." >&2
	exit 1
fi

live_integration_container_id="$(
	compose_target ps --status running -q integration-worker 2>/dev/null || true
)"
if [[ -z "$live_integration_container_id" ||
	"$live_integration_container_id" == *$'\n'* ]]; then
	echo "Exactly one running integration worker is required to verify post-cutover ownership." >&2
	exit 1
fi
live_integration_kinds="$(
	container_env_value \
		"$live_integration_container_id" \
		INTEGRATION_WORKER_KINDS || true
)"
live_integration_kinds_normalized="$(normalize_csv "$live_integration_kinds")"
current_integration_kinds_normalized="$(
	normalize_csv "$(reporting_expected_integration_worker_kinds)"
)"
pre_reporting_integration_kinds_normalized="$(
	normalize_csv "webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,auto-renewal"
)"
if [[ "$live_integration_kinds_normalized" == "$pre_reporting_integration_kinds_normalized" ]]; then
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
fi
if ! reporting_cutover_worker_kinds_allowed \
	"$live_integration_kinds_normalized" \
	"$current_integration_kinds_normalized" \
	"$pre_reporting_integration_kinds_normalized"; then
	echo "The live integration worker does not match the safe Reporting bootstrap boundary." >&2
	echo "Use the full deployment target to repair topology ownership." >&2
	exit 1
fi
if [[ "$live_integration_kinds_normalized" != "$current_integration_kinds_normalized" ]]; then
	echo 'Allowing the pre-Reporting integration worker only for its one-way audit-consumer bootstrap.'
fi

previous_container_id="$(
	compose_target ps --status running -q notification-delivery-worker
)"
if [[ -z "$previous_container_id" || "$previous_container_id" == *$'\n'* ]]; then
	echo "Exactly one running notification-delivery-worker is required before a service-only rollout." >&2
	echo "Use the full deployment to establish both Notification Delivery cutover markers." >&2
	exit 1
fi

previous_image_ref="$(
	docker inspect --format '{{ .Config.Image }}' "$previous_container_id"
)"
previous_image_id="$(
	docker inspect --format '{{ .Image }}' "$previous_container_id"
)"
previous_restart_count="$(
	docker inspect --format '{{ .RestartCount }}' "$previous_container_id"
)"
previous_revision="$(
	docker image inspect \
		--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
		"$previous_image_id"
)"
if [[ -z "$previous_image_ref" ||
	-z "$previous_image_id" ||
	! "$previous_restart_count" =~ ^[0-9]+$ ]]; then
	echo "Previous notification delivery image could not be resolved." >&2
	exit 1
fi
if [[ ! "$previous_revision" =~ ^[0-9a-f]{40}$ ]]; then
	echo "Previous notification delivery image has no exact Git revision label." >&2
	exit 1
fi

validate_notification_database_urls "$previous_image_id"

api_container_id="$(
	compose_target ps --status running -q api 2>/dev/null || true
)"
if [[ -z "$api_container_id" || "$api_container_id" == *$'\n'* ]]; then
	echo "Exactly one running API container is required to validate service-only configuration compatibility." >&2
	exit 1
fi

assert_live_env_matches \
	"$previous_container_id" \
	NOTIFICATION_DELIVERY_DATABASE_URL \
	"$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)"
assert_live_env_matches \
	"$previous_container_id" \
	RABBITMQ_URL \
	"$(get_env_value RABBITMQ_NOTIFICATION_DELIVERY_URL)"
for service_env_key in \
	SMTP_SERVER \
	SMTP_LOGIN \
	SMTP_PASSWORD \
	SMTP_CONNECTION_TIMEOUT_MS \
	SMTP_GREETING_TIMEOUT_MS \
	SMTP_SOCKET_TIMEOUT_MS \
	TELEGRAM_INFO_BOT_TOKEN \
	NOTIFICATION_DELIVERY_INTERNAL_TOKEN \
	NOTIFICATION_DELIVERY_LISTEN_HOST \
	NOTIFICATION_DELIVERY_HEALTH_PORT \
	NOTIFICATION_DELIVERY_PREFETCH \
	NOTIFICATION_DELIVERY_KINDS; do
	assert_live_env_matches \
		"$previous_container_id" \
		"$service_env_key" \
		"$(get_env_value "$service_env_key")"
done
assert_live_env_matches \
	"$previous_container_id" \
	RABBITMQ_MAX_MESSAGE_BYTES \
	"$(get_env_value_or_default RABBITMQ_MAX_MESSAGE_BYTES 262144)"
assert_live_env_matches \
	"$previous_container_id" \
	NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS \
	"$(get_env_value_or_default NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS 90)"
assert_live_env_matches \
	"$previous_container_id" \
	NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS \
	"$(get_env_value_or_default NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS 30)"
assert_live_env_matches \
	"$previous_container_id" \
	RABBITMQ_CONNECTION_NAME \
	"winwidget-notification-delivery-worker"
assert_live_env_matches \
	"$previous_container_id" \
	MESSAGING_SERVICE_NAME \
	"notification-delivery-worker"
assert_live_env_matches \
	"$live_integration_container_id" \
	RABBITMQ_URL \
	"$(get_env_value RABBITMQ_INTEGRATION_WORKER_URL)"
assert_live_env_matches \
	"$api_container_id" \
	NOTIFICATION_DELIVERY_INTERNAL_URL \
	"$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_URL)"
assert_live_env_matches \
	"$api_container_id" \
	NOTIFICATION_DELIVERY_INTERNAL_TOKEN \
	"$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN)"
assert_live_env_matches \
	"$api_container_id" \
	NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS \
	"$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS)"
for api_rabbitmq_key in \
	RABBITMQ_MANAGEMENT_URL \
	RABBITMQ_MONITOR_USER \
	RABBITMQ_MONITOR_PASSWORD \
	RABBITMQ_VHOST; do
	assert_live_env_matches \
		"$api_container_id" \
		"$api_rabbitmq_key" \
		"$(get_env_value "$api_rabbitmq_key")"
done

if [[ "$previous_image_ref" == "$NOTIFICATION_DELIVERY_IMAGE" ]]; then
	previous_image_hash="${previous_image_id#sha256:}"
	previous_image_ref="winwidget-notification-delivery:rollback-${previous_revision:0:12}-${previous_image_hash:0:12}"
	docker image tag "$previous_image_id" "$previous_image_ref"
fi
if ! git -C "$server_root" merge-base --is-ancestor \
	"$previous_revision" "$deploy_revision"; then
	echo "Previous notification delivery revision is not an ancestor of the candidate." >&2
	echo "Use the full baseline deployment instead of a service-only rollout." >&2
	exit 1
fi

disallowed_service_only_changes=()
while IFS= read -r changed_file; do
	[[ -n "$changed_file" ]] || continue
	case "$changed_file" in
		apps/notification-delivery/src/notification-delivery/control/* | \
			apps/notification-delivery/src/notification-delivery/notification-delivery-contract.ts | \
			apps/notification-delivery/src/messaging/delivery-event.types.ts | \
			apps/notification-delivery/src/messaging/messaging-event-contract.ts | \
			apps/notification-delivery/src/messaging/messaging.constants.ts)
			disallowed_service_only_changes+=("$changed_file")
			;;
		apps/notification-delivery/src/* | \
			apps/notification-delivery/emails/* | \
			apps/notification-delivery/test/* | \
			apps/notification-delivery/.dockerignore | \
			apps/notification-delivery/.eslintrc.cjs | \
			apps/notification-delivery/.gitignore | \
			apps/notification-delivery/.prettierignore | \
			apps/notification-delivery/prisma/schema.prisma | \
			apps/notification-delivery/prisma/migrations/* | \
			apps/notification-delivery/Dockerfile | \
			apps/notification-delivery/package.json | \
			apps/notification-delivery/pnpm-lock.yaml | \
			apps/notification-delivery/nest-cli.json | \
			apps/notification-delivery/tsconfig*.json | \
			scripts/deploy-notification-delivery-production.sh)
			;;
		*)
			disallowed_service_only_changes+=("$changed_file")
			;;
	esac
done < <(
	git -C "$server_root" diff --name-only \
		"$previous_revision" "$deploy_revision"
)
if ((${#disallowed_service_only_changes[@]} > 0)); then
	echo "Notification-delivery-only rollout is restricted to implementation-only service changes and this rollout script." >&2
	echo "Shared client, control-contract, RabbitMQ, Compose, dependency or monolith changes require the full deployment target:" >&2
	printf '%s\n' "${disallowed_service_only_changes[@]}" >&2
	exit 1
fi

notification_schema_changed=false
new_notification_migrations=()
while IFS=$'\t' read -r change_status changed_file; do
	[[ -n "$change_status" ]] || continue
	if [[ "$change_status" != "A" || "$changed_file" != *.sql ]]; then
		echo "Service-only schema rollout cannot modify, rename or delete an existing notification migration: $changed_file" >&2
		exit 1
	fi
	new_notification_migrations+=("$changed_file")
done < <(
	git -C "$server_root" diff --name-status \
		"$previous_revision" "$deploy_revision" -- \
		apps/notification-delivery/prisma/migrations
)
if git -C "$server_root" diff --quiet \
	"$previous_revision" "$deploy_revision" -- \
	apps/notification-delivery/prisma/schema.prisma; then
	notification_schema_changed=false
else
	notification_schema_changed=true
fi
if [[ "$notification_schema_changed" == "true" ||
	${#new_notification_migrations[@]} -gt 0 ]]; then
	echo "Notification schema and migration changes require the full deployment target." >&2
	echo "Service-only rollback is allowed only when the database contract is unchanged." >&2
	exit 1
fi
if ! verify_notification_delivery_worker \
	"$previous_image_id" \
	"$previous_revision" \
	"$previous_restart_count"; then
	echo "Current notification delivery worker is not a healthy rollback target." >&2
	exit 1
fi

echo "Building notification delivery image for revision $deploy_revision."
compose_target build notification-delivery-worker

candidate_image_id="$(
	docker image inspect --format '{{ .Id }}' "$NOTIFICATION_DELIVERY_IMAGE"
)"
candidate_image_revision="$(
	docker image inspect \
		--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
		"$candidate_image_id"
)"
if [[ "$candidate_image_revision" != "$deploy_revision" ]]; then
	echo "Candidate notification delivery image revision label is invalid." >&2
	exit 1
fi
verify_notification_delivery_image_artifact

echo "Verifying the unchanged notification delivery schema before worker recreate."
verify_notification_delivery_migration_boundary
compose_target \
	--profile notification-delivery-migration \
	run --rm --no-deps notification-delivery-migrate \
	migrate status \
	--schema prisma/schema.prisma
verify_notification_delivery_runtime_crud

recreate_started=true
compose_target up \
	-d \
	--no-deps \
	--force-recreate \
	notification-delivery-worker

if ! verify_notification_delivery_worker \
	"$candidate_image_id" \
	"$deploy_revision"; then
	echo "Candidate notification delivery worker did not pass rollout verification." >&2
	exit 1
fi
verify_notification_delivery_control_smoke "$deploy_revision"

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if verify_notification_consumer_ownership; then
		break
	fi
	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Candidate notification delivery worker did not acquire exact RabbitMQ queue ownership." >&2
		exit 1
	fi
	sleep "$HEALTHCHECK_INTERVAL"
done

verify_notification_database_lifecycle_unchanged \
	"the service-only rollout" \
	"complete"
rollout_verified=true
echo "Notification delivery worker rollout verified for revision $deploy_revision."
