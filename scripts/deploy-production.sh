#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/v1/health/deployment}"
PUBLIC_HEALTHCHECK_URL="${PUBLIC_HEALTHCHECK_URL:-https://api.winwidget.ru/api/v1/health/deployment}"
READINESS_URL="${READINESS_URL:-http://127.0.0.1:4200/api/v1/health/ready}"
GATEWAY_READINESS_URL="${GATEWAY_READINESS_URL:-http://127.0.0.1:4100/health/ready}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"

cd "$APP_ROOT"

server_root="$APP_ROOT/winwidget.ru_server"
deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
if [[ "$deploy_revision" != "$expected_revision" ]]; then
	echo "Deployment revision mismatch: expected $expected_revision, got $deploy_revision" >&2
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

export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"

echo "Deploying backend revision: $APP_REVISION"
echo "Building backend image: winwidget-api:$APP_VERSION"
echo "Building gateway image: winwidget-api-gateway:$APP_VERSION"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Backend env file not found: $ENV_FILE" >&2
	exit 1
fi

env_mode="$(stat -c '%a' "$ENV_FILE")"
env_group_digit="${env_mode: -2:1}"
env_other_digit="${env_mode: -1}"
if ((10#$env_group_digit != 0 || 10#$env_other_digit != 0)); then
	echo "Backend env file must not be accessible by group or others: $ENV_FILE (mode $env_mode)" >&2
	echo "Run: chmod 600 $ENV_FILE" >&2
	exit 1
fi

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
	echo "Duplicate environment keys are not allowed in $ENV_FILE:" >&2
	echo "$duplicate_env_keys" >&2
	exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Backend Compose file not found: $COMPOSE_FILE" >&2
	exit 1
fi

ambient_compose_overrides=()
while IFS= read -r key; do
	[[ -n "$key" ]] || continue
	case "$key" in
		APP_REVISION | APP_VERSION)
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
	echo "Unset shell variables that would override $ENV_FILE in Docker Compose:" >&2
	printf '%s\n' "${ambient_compose_overrides[@]}" >&2
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

			if (name == key && value != "" && value !~ /^change_me/) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "Missing required $key in $ENV_FILE" >&2
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
		echo "$key in $ENV_FILE must contain exactly: $expected" >&2
		exit 1
	fi
}

mode="$(get_env_value "MODE" || true)"
mode="${mode:-production}"
mode="${mode,,}"

for key in \
	JWT_ACCESS_PRIVATE_KEY_BASE64 \
	JWT_ACCESS_JWKS_BASE64 \
	JWT_ACCESS_ACTIVE_KID \
	JWT_ISSUER \
	JWT_AUDIENCE \
	JWT_ACCESS_TTL_SECONDS \
	JWT_CLOCK_TOLERANCE_SECONDS \
	GATEWAY_LISTEN_HOST \
	GATEWAY_PORT \
	API_UPSTREAM_URL \
	CORS_ALLOWED_ORIGINS \
	JWT_JWKS_URL; do
	require_env_key "$key"
done

if awk -F= '
	/^[[:space:]]*JWT_SECRET[[:space:]]*=/ { found = 1 }
	END { exit(found ? 0 : 1) }
' "$ENV_FILE"; then
	echo "Legacy JWT_SECRET must be removed from $ENV_FILE" >&2
	exit 1
fi

case "$mode" in
	production)
		require_env_key "DATABASE_URL_PRODUCTION"
		require_env_key "PRODUCTION_HOST"
		require_env_key "AUTH_COOKIE_DOMAIN"
		require_env_key "COMPOSE_PROJECT_NAME"
		require_env_key "RABBITMQ_DATA_VOLUME"
		require_env_key "RABBITMQ_ADMIN_USER"
		require_env_key "RABBITMQ_ADMIN_PASSWORD"
		require_env_key "RABBITMQ_LEGACY_USER"
		require_env_key "RABBITMQ_MONITOR_USER"
		require_env_key "RABBITMQ_MONITOR_PASSWORD"
		require_env_key "RABBITMQ_PUBLISHER_URL"
		require_env_key "RABBITMQ_INTEGRATION_WORKER_URL"
		require_env_key "RABBITMQ_MAINTENANCE_WORKER_URL"
		require_env_key "MAINTENANCE_WORKER_PREFETCH"
		require_env_key "SCHEDULED_JOB_POLL_INTERVAL_MS"
		require_env_key "SCHEDULED_JOB_LEASE_MS"
		require_env_key "SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS"
		require_env_key "INTEGRATION_WORKER_KINDS"
		require_env_key "MAINTENANCE_WORKER_KINDS"
		require_env_exact_list \
			"INTEGRATION_WORKER_KINDS" \
			"email,webhook,telegram,bitrix24,amo-crm,payment-email,payment-telegram,mailing-email,mailing-telegram,limit-email,limit-telegram,daily-summary-telegram"
		require_env_exact_list \
			"MAINTENANCE_WORKER_KINDS" \
			"database-backup"
		require_env_key "YOOKASSA_PRODUCTION_SHOP_ID"
		require_env_key "YOOKASSA_PRODUCTION_SECRET_KEY"
		require_env_key "PORT"
		require_env_key "API_LISTEN_HOST"
		require_env_key "TRUST_PROXY"
		require_env_exact_list \
			"CORS_ALLOWED_ORIGINS" \
			"https://winwidget.ru,https://www.winwidget.ru"
		if [[ "$(get_env_value PORT)" != "4200" ]]; then
			echo "Production PORT must be 4200" >&2
			exit 1
		fi
		if [[ "$(get_env_value API_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production API_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value TRUST_PROXY)" != "loopback" ]]; then
			echo "Production TRUST_PROXY must be loopback" >&2
			exit 1
		fi
		if [[ "$(get_env_value PRODUCTION_HOST)" != "https://api.winwidget.ru" ]]; then
			echo "Production PRODUCTION_HOST must be https://api.winwidget.ru" >&2
			exit 1
		fi
		if [[ "$(get_env_value AUTH_COOKIE_DOMAIN)" != ".winwidget.ru" ]]; then
			echo "Production AUTH_COOKIE_DOMAIN must be .winwidget.ru so Next.js middleware and API share the refresh cookie" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_ISSUER)" != "https://api.winwidget.ru/auth" ]]; then
			echo "Production JWT_ISSUER must be https://api.winwidget.ru/auth" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_AUDIENCE)" != "https://api.winwidget.ru" ]]; then
			echo "Production JWT_AUDIENCE must be https://api.winwidget.ru" >&2
			exit 1
		fi
		if [[ "$(get_env_value GATEWAY_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production GATEWAY_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value GATEWAY_PORT)" != "4100" ]]; then
			echo "Production GATEWAY_PORT must be 4100" >&2
			exit 1
		fi
		if [[ "$(get_env_value API_UPSTREAM_URL)" != "http://127.0.0.1:4200" ]]; then
			echo "Production API_UPSTREAM_URL must be http://127.0.0.1:4200" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_JWKS_URL)" != "http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json" ]]; then
			echo "Production JWT_JWKS_URL must use the loopback Auth endpoint" >&2
			exit 1
		fi
		for oauth_provider in google github yandex vk; do
			oauth_key="$(
				printf '%s' "$oauth_provider" |
					tr '[:lower:]' '[:upper:]'
			)_CALLBACK_URL"
			expected_oauth_callback="https://api.winwidget.ru/api/v1/auth/$oauth_provider/redirect"
			require_env_key "$oauth_key"
			if [[ "$(get_env_value "$oauth_key")" != "$expected_oauth_callback" ]]; then
				echo "$oauth_key must be $expected_oauth_callback" >&2
				exit 1
			fi
		done
		;;
	development)
		require_env_key "DATABASE_URL_DEVELOPMENT"
		require_env_key "YOOKASSA_SHOP_ID"
		require_env_key "YOOKASSA_SECRET_KEY"
		;;
	*)
		echo "Unsupported MODE in $ENV_FILE: $mode. Expected development or production." >&2
		exit 1
		;;
esac

jwt_access_ttl_seconds="$(get_env_value JWT_ACCESS_TTL_SECONDS)"
jwt_clock_tolerance_seconds="$(get_env_value JWT_CLOCK_TOLERANCE_SECONDS)"
if [[ ! "$jwt_access_ttl_seconds" =~ ^[0-9]+$ ]] ||
	((jwt_access_ttl_seconds < 300 || jwt_access_ttl_seconds > 1800)); then
	echo "JWT_ACCESS_TTL_SECONDS must be between 300 and 1800" >&2
	exit 1
fi
if [[ ! "$jwt_clock_tolerance_seconds" =~ ^[0-9]+$ ]] ||
	((jwt_clock_tolerance_seconds < 0 || jwt_clock_tolerance_seconds > 60)); then
	echo "JWT_CLOCK_TOLERANCE_SECONDS must be between 0 and 60" >&2
	exit 1
fi

target_project="$(get_env_value "COMPOSE_PROJECT_NAME" || true)"
if [[ "$target_project" != "winwidget" ]]; then
	echo "COMPOSE_PROJECT_NAME must be winwidget, got: ${target_project:-empty}" >&2
	exit 1
fi
rabbitmq_vhost="$(get_env_value "RABBITMQ_VHOST" || true)"
if [[ "$rabbitmq_vhost" != "winwidget" ]]; then
	echo "RABBITMQ_VHOST must be winwidget, got: ${rabbitmq_vhost:-empty}" >&2
	exit 1
fi
rabbitmq_data_volume="$(get_env_value "RABBITMQ_DATA_VOLUME" || true)"
if ! docker volume inspect "$rabbitmq_data_volume" >/dev/null 2>&1; then
	echo "Verified RabbitMQ volume does not exist: $rabbitmq_data_volume" >&2
	echo "Determine the current /var/lib/rabbitmq volume before deployment; do not create a replacement blindly." >&2
	exit 1
fi
export COMPOSE_PROJECT_NAME="$target_project"
export RABBITMQ_DATA_VOLUME="$rabbitmq_data_volume"

rabbitmq_container_ids="$(
	docker ps -a \
		--filter label=com.docker.compose.service=rabbitmq \
		--format '{{.ID}}'
)"
legacy_project="$target_project"
matched_rabbitmq_containers=0
matched_rabbitmq_container_id=""
while IFS= read -r container_id; do
	[[ -n "$container_id" ]] || continue
	mounted_volume="$(
		docker inspect --format \
			'{{ range .Mounts }}{{ if eq .Destination "/var/lib/rabbitmq" }}{{ .Name }}{{ end }}{{ end }}' \
			"$container_id"
	)"
	if [[ "$mounted_volume" != "$rabbitmq_data_volume" ]]; then
		continue
	fi
	matched_rabbitmq_containers=$((matched_rabbitmq_containers + 1))
	matched_rabbitmq_container_id="$container_id"
	legacy_project="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.docker.compose.project" }}' \
			"$container_id"
	)"
done <<<"$rabbitmq_container_ids"
if ((matched_rabbitmq_containers > 1)); then
	echo "More than one RabbitMQ container uses volume $rabbitmq_data_volume" >&2
	exit 1
fi
if [[ -z "$legacy_project" ]]; then
	echo "Could not determine the existing RabbitMQ Compose project" >&2
	exit 1
fi

compose_target() {
	docker compose --project-name "$target_project" \
		--env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_legacy() {
	docker compose --project-name "$legacy_project" \
		--env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_target config --quiet
compose_target build api api-gateway

docker run --rm --network none \
	--env-file "$ENV_FILE" \
	--entrypoint node \
	"winwidget-api:$APP_VERSION" \
	-e '
const {
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
	verify,
} = require("node:crypto");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let privateKey;
let jwks;
try {
	privateKey = createPrivateKey(
		Buffer.from(process.env.JWT_ACCESS_PRIVATE_KEY_BASE64 || "", "base64"),
	);
	jwks = JSON.parse(
		Buffer.from(process.env.JWT_ACCESS_JWKS_BASE64 || "", "base64").toString(
			"utf8",
		),
	);
} catch {
	fail("JWT key material is malformed");
}

if (
	privateKey.type !== "private" ||
	privateKey.asymmetricKeyType !== "rsa" ||
	(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072
) {
	fail("JWT private key must be an RSA key of at least 3072 bits");
}
if (!Array.isArray(jwks?.keys) || !jwks.keys.length) {
	fail("JWT JWKS must contain at least one public key");
}

const keyIds = new Set();
for (const key of jwks.keys) {
	if (
		!key ||
		key.kty !== "RSA" ||
		key.use !== "sig" ||
		key.alg !== "RS256" ||
		typeof key.kid !== "string" ||
		!key.kid ||
		typeof key.n !== "string" ||
		typeof key.e !== "string" ||
		["d", "p", "q", "dp", "dq", "qi", "oth"].some(name => name in key)
	) {
		fail("JWT JWKS contains an invalid or private key");
	}
	if (keyIds.has(key.kid)) fail("JWT JWKS contains a duplicate kid");
	keyIds.add(key.kid);
}

const activeKid = process.env.JWT_ACCESS_ACTIVE_KID;
const activeJwk = jwks.keys.find(key => key.kid === activeKid);
if (!activeJwk) fail("JWT active kid is missing from JWKS");

let publicKey;
try {
	publicKey = createPublicKey({ key: activeJwk, format: "jwk" });
} catch {
	fail("JWT active public JWK is malformed");
}
if ((publicKey.asymmetricKeyDetails?.modulusLength || 0) < 3072) {
	fail("JWT active public key must be at least 3072 bits");
}

const challenge = randomBytes(64);
const signature = sign("sha256", challenge, privateKey);
if (!verify("sha256", challenge, publicKey, signature)) {
	fail("JWT private key does not match the active public JWK");
}

process.stdout.write(`JWT RS256 keyset validated for kid ${activeKid}\n`);
'

rabbitmq_admin_user="$(get_env_value "RABBITMQ_ADMIN_USER")"
rabbitmq_admin_password="$(get_env_value "RABBITMQ_ADMIN_PASSWORD")"
rabbitmq_legacy_user="$(get_env_value "RABBITMQ_LEGACY_USER")"
rabbitmq_monitor_user="$(get_env_value "RABBITMQ_MONITOR_USER")"
rabbitmq_monitor_password="$(get_env_value "RABBITMQ_MONITOR_PASSWORD")"
previous_shared_user="$(get_env_value "RABBITMQ_USER" || true)"
if [[ -n "$previous_shared_user" &&
	"$previous_shared_user" != "change_me" &&
	"$previous_shared_user" != "$rabbitmq_legacy_user" ]]; then
	echo "RABBITMQ_LEGACY_USER must match the previous RABBITMQ_USER during cutover" >&2
	exit 1
fi

validate_rabbitmq_username() {
	local variable_name="$1"
	local username="$2"

	if [[ ! "$username" =~ ^[A-Za-z0-9._-]+$ ]]; then
		echo "$variable_name must contain only letters, digits, dot, underscore or hyphen" >&2
		exit 1
	fi
}

validate_rabbitmq_username "RABBITMQ_ADMIN_USER" "$rabbitmq_admin_user"
validate_rabbitmq_username "RABBITMQ_LEGACY_USER" "$rabbitmq_legacy_user"
validate_rabbitmq_username "RABBITMQ_MONITOR_USER" "$rabbitmq_monitor_user"
if [[ ! "$rabbitmq_vhost" =~ ^[A-Za-z0-9._/-]+$ ]]; then
	echo "RABBITMQ_VHOST contains unsupported characters" >&2
	exit 1
fi
if [[ "$rabbitmq_admin_password" == change_me* ||
	"$rabbitmq_monitor_password" == change_me* ||
	${#rabbitmq_admin_password} -lt 32 ||
	${#rabbitmq_monitor_password} -lt 32 ]]; then
	echo "RabbitMQ admin and monitor passwords must be non-example values of at least 32 characters" >&2
	exit 1
fi

parse_rabbitmq_service_url() {
	local variable_name="$1"
	local url_value
	local parsed
	local encoded_user
	local encoded_password
	local encoded_vhost

	url_value="$(get_env_value "$variable_name")"
	if ! parsed="$(
		printf '%s' "$url_value" |
			docker run --rm -i --network none \
				--entrypoint node \
				-e "RABBITMQ_EXPECTED_VHOST=$rabbitmq_vhost" \
				"winwidget-api:$APP_VERSION" \
				-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let url;
try {
	url = new URL(readFileSync(0, "utf8"));
} catch {
	fail("RabbitMQ service URL is invalid");
}

if (url.protocol !== "amqp:") {
	fail("RabbitMQ service URL must use amqp for the local production broker");
}
if (!url.hostname || url.search || url.hash) {
	fail("RabbitMQ service URL must contain a host and no query or fragment");
}
if (url.hostname !== "127.0.0.1" || (url.port && url.port !== "5672")) {
	fail("RabbitMQ service URL must target 127.0.0.1:5672");
}

let username;
let password;
let vhost;
try {
	username = decodeURIComponent(url.username);
	password = decodeURIComponent(url.password);
	vhost = decodeURIComponent(url.pathname.slice(1));
} catch {
	fail("RabbitMQ service URL contains invalid percent-encoding");
}

if (!/^[A-Za-z0-9._-]+$/.test(username)) {
	fail("RabbitMQ service username contains unsupported characters");
}
if (
	password.length < 32 ||
	password.startsWith("change_me") ||
	/[\0\r\n]/.test(password)
) {
	fail("RabbitMQ service password is missing or unsafe");
}
if (vhost !== process.env.RABBITMQ_EXPECTED_VHOST) {
	fail("RabbitMQ service URL vhost does not match RABBITMQ_VHOST");
}

for (const value of [username, password, vhost]) {
	process.stdout.write(`${Buffer.from(value).toString("base64")}\n`);
}
'
	)"; then
		echo "$variable_name is invalid" >&2
		exit 1
	fi

	encoded_user="$(sed -n '1p' <<<"$parsed")"
	encoded_password="$(sed -n '2p' <<<"$parsed")"
	encoded_vhost="$(sed -n '3p' <<<"$parsed")"
	if [[ -z "$encoded_user" || -z "$encoded_password" || -z "$encoded_vhost" ]]; then
		echo "$variable_name could not be parsed safely" >&2
		exit 1
	fi

	printf '%s\n%s\n%s\n' \
		"$encoded_user" "$encoded_password" "$encoded_vhost"
}

publisher_credentials="$(parse_rabbitmq_service_url "RABBITMQ_PUBLISHER_URL")"
integration_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_INTEGRATION_WORKER_URL"
)"
maintenance_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_MAINTENANCE_WORKER_URL"
)"

publisher_user="$(
	printf '%s' "$(sed -n '1p' <<<"$publisher_credentials")" | base64 --decode
)"
publisher_password_base64="$(sed -n '2p' <<<"$publisher_credentials")"
integration_user="$(
	printf '%s' "$(sed -n '1p' <<<"$integration_credentials")" | base64 --decode
)"
integration_password_base64="$(sed -n '2p' <<<"$integration_credentials")"
maintenance_user="$(
	printf '%s' "$(sed -n '1p' <<<"$maintenance_credentials")" | base64 --decode
)"
maintenance_password_base64="$(sed -n '2p' <<<"$maintenance_credentials")"
rabbitmq_admin_password_base64="$(
	printf '%s' "$rabbitmq_admin_password" | base64 | tr -d '\n'
)"
rabbitmq_monitor_password_base64="$(
	printf '%s' "$rabbitmq_monitor_password" | base64 | tr -d '\n'
)"

service_users=(
	"$rabbitmq_admin_user"
	"$rabbitmq_monitor_user"
	"$publisher_user"
	"$integration_user"
	"$maintenance_user"
)
for ((left = 0; left < ${#service_users[@]}; left++)); do
	if [[ "$rabbitmq_legacy_user" == "${service_users[$left]}" ]]; then
		echo "RABBITMQ_LEGACY_USER must differ from all current RabbitMQ users" >&2
		exit 1
	fi
	for ((right = left + 1; right < ${#service_users[@]}; right++)); do
		if [[ "${service_users[$left]}" == "${service_users[$right]}" ]]; then
			echo "RabbitMQ admin, monitor and service URLs must use distinct users" >&2
			exit 1
		fi
	done
done

if [[ -n "$matched_rabbitmq_container_id" ]]; then
	rabbitmq_is_running="$(
		docker inspect --format '{{ .State.Running }}' \
			"$matched_rabbitmq_container_id"
	)"
	if [[ "$rabbitmq_is_running" != "true" ]]; then
		docker start "$matched_rabbitmq_container_id" >/dev/null
	fi
	provisioning_rabbitmq_container_id="$matched_rabbitmq_container_id"
else
	compose_target up -d rabbitmq
	provisioning_rabbitmq_container_id="$(compose_target ps -q rabbitmq)"
fi

if [[ -z "$provisioning_rabbitmq_container_id" ]]; then
	echo "RabbitMQ container for service-user provisioning was not found" >&2
	exit 1
fi

for ((attempt = 1; attempt <= 30; attempt++)); do
	if docker exec "$provisioning_rabbitmq_container_id" \
		rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
		break
	fi
	if ((attempt == 30)); then
		echo "RabbitMQ did not become ready for service-user provisioning" >&2
		exit 1
	fi
	sleep 2
done

RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	docker exec \
		-e RABBITMQ_PROVISION_VHOST \
		"$provisioning_rabbitmq_container_id" \
		sh -ec '
if ! rabbitmqctl --silent list_vhosts name |
	grep -Fqx -- "$RABBITMQ_PROVISION_VHOST"; then
	rabbitmqctl add_vhost "$RABBITMQ_PROVISION_VHOST"
fi
'

unexpected_broad_users="$(
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_ADMIN_USER="$rabbitmq_admin_user" \
	RABBITMQ_PROVISION_LEGACY_USER="$rabbitmq_legacy_user" \
		docker exec \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_PROVISION_ADMIN_USER \
			-e RABBITMQ_PROVISION_LEGACY_USER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
rabbitmqctl --silent list_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" user configure write read |
awk -v admin="$RABBITMQ_PROVISION_ADMIN_USER" \
	-v legacy="$RABBITMQ_PROVISION_LEGACY_USER" \
	'\''NR == 1 && $1 == "user" { next }
	$2 == ".*" && $3 == ".*" && $4 == ".*" &&
		$1 != admin && $1 != legacy { print $1 }'\''
'
)"
if [[ -n "$unexpected_broad_users" ]]; then
	echo "Unexpected broad RabbitMQ user(s) on vhost $rabbitmq_vhost:" >&2
	echo "$unexpected_broad_users" >&2
	echo "Verify RABBITMQ_LEGACY_USER before deployment" >&2
	exit 1
fi

provision_rabbitmq_user() {
	local username="$1"
	local password_base64="$2"
	local configure_pattern="$3"
	local write_pattern="$4"
	local read_pattern="$5"
	local tag="$6"

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_PASSWORD_BASE64="$password_base64" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_CONFIGURE="$configure_pattern" \
	RABBITMQ_PROVISION_WRITE="$write_pattern" \
	RABBITMQ_PROVISION_READ="$read_pattern" \
	RABBITMQ_PROVISION_TAG="$tag" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_PASSWORD_BASE64 \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_PROVISION_CONFIGURE \
			-e RABBITMQ_PROVISION_WRITE \
			-e RABBITMQ_PROVISION_READ \
			-e RABBITMQ_PROVISION_TAG \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
password="$(printf "%s" "$RABBITMQ_PROVISION_PASSWORD_BASE64" | base64 -d)"
if rabbitmqctl --silent list_users |
	cut -f1 |
	grep -Fqx -- "$RABBITMQ_PROVISION_USER"; then
	rabbitmqctl change_password "$RABBITMQ_PROVISION_USER" "$password"
else
	rabbitmqctl add_user "$RABBITMQ_PROVISION_USER" "$password"
fi

while IFS= read -r other_vhost; do
	if [ "$other_vhost" != "$RABBITMQ_PROVISION_VHOST" ]; then
		rabbitmqctl clear_permissions \
			-p "$other_vhost" "$RABBITMQ_PROVISION_USER"
	fi
done <<EOF
$(rabbitmqctl --silent list_vhosts name)
EOF

rabbitmqctl set_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"$RABBITMQ_PROVISION_CONFIGURE" \
	"$RABBITMQ_PROVISION_WRITE" \
	"$RABBITMQ_PROVISION_READ"
if [ -n "$RABBITMQ_PROVISION_TAG" ]; then
	rabbitmqctl set_user_tags \
		"$RABBITMQ_PROVISION_USER" "$RABBITMQ_PROVISION_TAG"
else
	rabbitmqctl set_user_tags "$RABBITMQ_PROVISION_USER"
fi
rabbitmqctl authenticate_user "$RABBITMQ_PROVISION_USER" "$password"
unset password
'
}

provision_rabbitmq_user \
	"$rabbitmq_admin_user" \
	"$rabbitmq_admin_password_base64" \
	'.*' \
	'.*' \
	'.*' \
	'administrator'
provision_rabbitmq_user \
	"$publisher_user" \
	"$publisher_password_base64" \
	'^winwidget\..*' \
	'^winwidget\..*' \
	'^winwidget\..*' \
	''
provision_rabbitmq_user \
	"$integration_user" \
	"$integration_password_base64" \
	'^$' \
	'^(winwidget\.retry|winwidget\.dead-letter)$' \
	'^winwidget\.(lead-integration|payment-notification|mailing|limit-notification|report)\..*' \
	''
provision_rabbitmq_user \
	"$maintenance_user" \
	"$maintenance_password_base64" \
	'^$' \
	'^(winwidget\.retry|winwidget\.dead-letter)$' \
	'^winwidget\.maintenance\..*' \
	''
provision_rabbitmq_user \
	"$rabbitmq_monitor_user" \
	"$rabbitmq_monitor_password_base64" \
	'^$' \
	'^$' \
	'^$' \
	'monitoring'

echo "RabbitMQ admin/service users and least-privilege permissions are verified"

compose_legacy stop api-gateway api outbox-publisher integration-worker maintenance-worker
compose_target --profile migration run --rm migrate
if [[ "$legacy_project" != "$target_project" ]]; then
	compose_legacy stop rabbitmq
fi
compose_target up -d rabbitmq
messaging_readiness_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
compose_target up -d --force-recreate outbox-publisher
compose_target up -d --force-recreate integration-worker maintenance-worker
compose_target up -d --force-recreate api
compose_target up -d --force-recreate api-gateway

show_api_diagnostics() {
	echo "API deployment diagnostics:"
	compose_target \
		ps api-gateway api outbox-publisher integration-worker maintenance-worker rabbitmq || true
	compose_target \
		logs --tail=100 api-gateway api outbox-publisher integration-worker maintenance-worker rabbitmq || true
	echo "Processes listening on ports 4100 and 4200:"
	ss -ltnp '( sport = :4100 or sport = :4200 )' || true
}

ensure_required_services_running() {
	local service
	local container_id
	for service in rabbitmq api api-gateway outbox-publisher integration-worker maintenance-worker; do
		container_id="$(
			compose_target ps --status running -q "$service"
		)"
		if [[ -z "$container_id" ]]; then
			echo "Required service is not running: $service" >&2
			show_api_diagnostics
			exit 1
		fi
	done
}

check_deployment_revision() {
	local url="$1"
	local response
	response="$(
		curl -fsS --connect-timeout 3 --max-time 5 \
			-H 'Cache-Control: no-cache' "$url" || true
	)"

	if [[ "$response" == *"\"revision\":\"$APP_REVISION\""* ]]; then
		return 0
	fi

	if [[ -n "$response" ]]; then
		echo "Unexpected deployment health response from $url: $response"
	fi
	return 1
}

check_messaging_readiness() {
	compose_target exec -T \
		-e "MESSAGING_READINESS_STARTED_AT=$messaging_readiness_started_at" \
		-e "INTEGRATION_WORKER_KINDS=$(get_env_value INTEGRATION_WORKER_KINDS)" \
		-e "MAINTENANCE_WORKER_KINDS=$(get_env_value MAINTENANCE_WORKER_KINDS)" \
		api node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const {
	INTEGRATION_KINDS,
	MAINTENANCE_KINDS,
	MESSAGING_QUEUE_NAMES
} = require('./dist/src/messaging/messaging.constants.js');

class ReadinessError extends Error {}

const requiredServices = [
	'outbox-publisher',
	'integration-worker',
	'maintenance-worker'
];

const parseEnabledKinds = (name, supportedKinds) => {
	const value = process.env[name] || '';
	const kinds = value
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
	const invalid = kinds.filter(kind => !supportedKinds.includes(kind));
	if (!kinds.length || invalid.length) {
		throw new ReadinessError(
			invalid.length
				? `${name} has unsupported values: ${invalid.join(', ')}`
				: `${name} is empty`
		);
	}
	return [...new Set(kinds)];
};

const run = async () => {
	const mode = (process.env.MODE || 'production').trim().toLowerCase();
	const databaseUrl =
		mode === 'production'
			? process.env.DATABASE_URL_PRODUCTION
			: process.env.DATABASE_URL_DEVELOPMENT;
	if (!databaseUrl) {
		throw new ReadinessError('Messaging readiness database URL is missing');
	}

	const startedAt = Date.parse(
		process.env.MESSAGING_READINESS_STARTED_AT || ''
	);
	if (!Number.isFinite(startedAt)) {
		throw new ReadinessError('Messaging readiness timestamp is invalid');
	}
	const requiredKinds = [
		...parseEnabledKinds('INTEGRATION_WORKER_KINDS', INTEGRATION_KINDS),
		...parseEnabledKinds('MAINTENANCE_WORKER_KINDS', MAINTENANCE_KINDS)
	];
	const requiredQueues = requiredKinds.flatMap(kind => {
		const queue = MESSAGING_QUEUE_NAMES[kind];
		if (!queue) {
			throw new ReadinessError(`RabbitMQ queue is unknown for ${kind}`);
		}
		return [queue, `${queue}.dead-letter`];
	});
	const freshAfter = new Date(Math.max(startedAt, Date.now() - 30_000));
	const prisma = new PrismaClient({
		datasources: { db: { url: databaseUrl } }
	});

	try {
		const heartbeats = await prisma.messagingHeartbeat.findMany({
			where: {
				service: { in: requiredServices },
				lastSeenAt: { gte: freshAfter }
			},
			select: { service: true }
		});
		const activeServices = new Set(heartbeats.map(item => item.service));
		const missingServices = requiredServices.filter(
			service => !activeServices.has(service)
		);
		if (missingServices.length) {
			throw new ReadinessError(
				`Missing fresh heartbeat: ${missingServices.join(', ')}`
			);
		}

		const baseUrl = (
			process.env.RABBITMQ_MANAGEMENT_URL || 'http://127.0.0.1:15672'
		).replace(/\/$/, '');
		const user = process.env.RABBITMQ_MONITOR_USER;
		const password = process.env.RABBITMQ_MONITOR_PASSWORD;
		const vhost = process.env.RABBITMQ_VHOST || 'winwidget';
		if (!user || !password) {
			throw new ReadinessError(
				'RabbitMQ management credentials are missing'
			);
		}
			const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString(
				'base64'
			)}`;
			const nodesResponse = await fetch(`${baseUrl}/api/nodes`, {
				headers: { Authorization: authorization },
				signal: AbortSignal.timeout(4000)
			});
			if (!nodesResponse.ok) {
				await nodesResponse.body?.cancel();
				throw new ReadinessError(
					`RabbitMQ nodes returned HTTP ${nodesResponse.status}`
				);
			}
			const nodes = await nodesResponse.json();
			if (
				!Array.isArray(nodes) ||
				!nodes.length ||
				nodes.some(
					node =>
						node.running === false ||
						node.mem_alarm === true ||
						node.disk_free_alarm === true ||
						(Array.isArray(node.partitions) &&
							node.partitions.length > 0)
				)
			) {
				throw new ReadinessError(
					'RabbitMQ node is stopped or reports an alarm/partition'
				);
			}

			for (const queue of requiredQueues) {
			let response;
			try {
				response = await fetch(
					`${baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`,
					{
						headers: { Authorization: authorization },
						signal: AbortSignal.timeout(4000)
					}
				);
			} catch {
				throw new ReadinessError(
					`RabbitMQ queue check failed: ${queue}`
				);
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new ReadinessError(
					`RabbitMQ queue ${queue} returned HTTP ${response.status}`
				);
			}
			const state = await response.json();
			if (!Number.isInteger(state.consumers) || state.consumers < 1) {
				throw new ReadinessError(
					`RabbitMQ queue has no consumers: ${queue}`
				);
			}
		}
	} finally {
		await prisma.$disconnect();
	}
};

run()
	.then(() => {
		process.stdout.write(
			'Messaging heartbeats and RabbitMQ consumers are ready\n'
		);
	})
	.catch(error => {
		const message =
			error instanceof ReadinessError
				? error.message
				: 'Messaging readiness could not query PostgreSQL or RabbitMQ';
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
NODE
}

ensure_required_services_running

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend revision healthcheck failed: $HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$PUBLIC_HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Public backend revision healthcheck failed: $PUBLIC_HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend readiness check failed: $READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$GATEWAY_READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "API Gateway readiness check failed: $GATEWAY_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_messaging_readiness; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Messaging readiness check failed"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

ensure_required_services_running

for service in api-gateway api outbox-publisher integration-worker maintenance-worker; do
	container_id="$(
		compose_target ps -q "$service"
	)"
	image_revision="$(
		docker inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$container_id"
	)"
	if [[ "$image_revision" != "$APP_REVISION" ]]; then
		echo "$service image revision mismatch: expected $APP_REVISION, got $image_revision"
		show_api_diagnostics
		exit 1
	fi

	restart_count="$(
		docker inspect --format '{{ .RestartCount }}' "$container_id"
	)"
	if [[ "$restart_count" != "0" ]]; then
		echo "$service restarted during deployment: restartCount=$restart_count"
		show_api_diagnostics
		exit 1
	fi
done

retire_rabbitmq_legacy_user() {
	local rabbitmq_container_id

	rabbitmq_container_id="$(compose_target ps --status running -q rabbitmq)"
	if [[ -z "$rabbitmq_container_id" ]]; then
		echo "RabbitMQ is not running; legacy user was not retired" >&2
		exit 1
	fi

	RABBITMQ_PROVISION_LEGACY_USER="$rabbitmq_legacy_user" \
		docker exec \
			-e RABBITMQ_PROVISION_LEGACY_USER \
			"$rabbitmq_container_id" \
			sh -ec '
if rabbitmqctl --silent list_users |
	cut -f1 |
	grep -Fqx -- "$RABBITMQ_PROVISION_LEGACY_USER"; then
	rabbitmqctl delete_user "$RABBITMQ_PROVISION_LEGACY_USER"
fi
'
}

retire_rabbitmq_legacy_user

echo "Backend revision verified locally and publicly: $APP_REVISION"
echo "RabbitMQ legacy user is absent after the verified cutover"

compose_target ps \
	api-gateway api outbox-publisher integration-worker maintenance-worker rabbitmq
