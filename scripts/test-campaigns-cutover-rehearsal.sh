#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SOURCE_ROOT="${CAMPAIGNS_REHEARSAL_SOURCE_ROOT:-$(
	cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
)}"
RUN_ID="${CAMPAIGNS_REHEARSAL_RUN_ID:-local}"
BASELINE_REF="${CAMPAIGNS_REHEARSAL_BASELINE_REF:-20b2de69c58f0a0aa5435c5d93eab24525a32a34}"
APP_ROOT="/tmp/winwidget-campaigns-cutover-rehearsal-$RUN_ID"
SERVER_ROOT="$APP_ROOT/winwidget.ru_server"
BASELINE_ROOT="$APP_ROOT/baseline"
ENV_FILE="$APP_ROOT/deploy/backend/.env.production"
SOURCE_COMPOSE_FILE="$SERVER_ROOT/deploy/docker-compose.prod.yml"
COMPOSE_FILE="$SERVER_ROOT/deploy/docker-compose.rehearsal.yml"
COMPOSE_WORKING_DIR="$SERVER_ROOT/deploy"
BASELINE_COMPOSE_OVERRIDE="$APP_ROOT/deploy/backend/campaigns-rehearsal-baseline.override.yml"
MARKER_FILE="$APP_ROOT/deploy/backend/.campaigns-database-cutover-v1"
CAMPAIGNS_VOLUME_IDENTITY_FILE="$APP_ROOT/deploy/backend/.campaigns-rehearsal-volume-identity"
AUDIT_CANONICAL_ROOT="/opt/winwidget"
AUDIT_BIND_MARKER="$APP_ROOT/deploy/backend/.campaigns-rehearsal-audit-bind"
AUDIT_MARKER_OVERLAY="$APP_ROOT/deploy/backend/.campaigns-rehearsal-audit-marker"
POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'

CORE_CONTAINER="winwidget-campaigns-rehearsal-core-$RUN_ID"
RESTORE_CONTAINER="winwidget-campaigns-rehearsal-restore-$RUN_ID"
CORE_VOLUME="winwidget-campaigns-rehearsal-core-data-$RUN_ID"
NOTIFICATION_VOLUME="winwidget-campaigns-rehearsal-notification-data-$RUN_ID"
RABBITMQ_VOLUME="winwidget-campaigns-rehearsal-rabbitmq-data-$RUN_ID"
CAMPAIGNS_VOLUME="winwidget-campaigns-postgres-data"
CORE_PORT=55431
NOTIFICATION_PORT=55432
CAMPAIGNS_PORT=55433

CORE_ADMIN_USER='winwidget_core_admin'
CORE_ADMIN_PASSWORD='rehearsal_core_admin_password_32'
CORE_RUNTIME_PASSWORD='rehearsal_core_runtime_password_32'
CORE_MIGRATION_PASSWORD='rehearsal_core_migration_password_32'
CORE_BACKUP_PASSWORD='rehearsal_core_backup_password_32'
NOTIFICATION_ADMIN_PASSWORD='rehearsal_notification_admin_password_32'
NOTIFICATION_RUNTIME_PASSWORD='rehearsal_notification_runtime_password_32'
NOTIFICATION_MIGRATION_PASSWORD='rehearsal_notification_migration_password_32'
NOTIFICATION_BACKUP_PASSWORD='rehearsal_notification_backup_password_32'
CAMPAIGNS_ADMIN_PASSWORD='rehearsal_campaigns_admin_password_32'
CAMPAIGNS_RUNTIME_PASSWORD='rehearsal_campaigns_runtime_password_32'
CAMPAIGNS_MIGRATION_PASSWORD='rehearsal_campaigns_migration_password_32'
CAMPAIGNS_BACKUP_PASSWORD='rehearsal_campaigns_backup_password_32'
RABBITMQ_ADMIN_PASSWORD='rehearsal_rabbitmq_admin_password_32'
RABBITMQ_MONITOR_PASSWORD='rehearsal_rabbitmq_monitor_password_32'
RABBITMQ_PUBLISHER_PASSWORD='rehearsal_rabbitmq_publisher_password_32'
RABBITMQ_INTEGRATION_PASSWORD='rehearsal_rabbitmq_integration_password_32'
RABBITMQ_MAINTENANCE_PASSWORD='rehearsal_rabbitmq_maintenance_password_32'
RABBITMQ_NOTIFICATION_PASSWORD='rehearsal_rabbitmq_notification_password_32'
RABBITMQ_CAMPAIGNS_PASSWORD='rehearsal_rabbitmq_campaigns_password_32'

LEGACY_GATEWAY_ROUTES='[{"id":"monolith","pathPrefix":"/api/v1","upstreamUrl":"http://127.0.0.1:4200","authPolicy":"optional","timeoutMs":60000}]'
TARGET_GATEWAY_ROUTES='[{"id":"campaigns","pathPrefix":"/api/v1/admin/campaigns","upstreamUrl":"http://127.0.0.1:4500","authPolicy":"required","timeoutMs":60000},{"id":"monolith","pathPrefix":"/api/v1","upstreamUrl":"http://127.0.0.1:4200","authPolicy":"optional","timeoutMs":60000}]'
LEGACY_INTEGRATION_KINDS='webhook,bitrix24,amo-crm,mailing-email,mailing-telegram,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,auto-renewal'
TARGET_INTEGRATION_KINDS='webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,auto-renewal'
LEGACY_MAILING_EMAIL_RATE=5
LEGACY_MAILING_TELEGRAM_RATE=10

BASELINE_TAG="campaigns-rehearsal-baseline-$RUN_ID"
TARGET_REVISION=""
BASELINE_REVISION=""
CAMPAIGNS_VOLUME_IDENTITY=""
CAMPAIGNS_SYSTEM_IDENTIFIER=""

fail() {
	echo "$1" >&2
	exit 1
}

source_git() {
	git -c "safe.directory=$SOURCE_ROOT" -C "$SOURCE_ROOT" "$@"
}

validate_rehearsal_paths() {
	local expected_root expected_name parent_root canonical_root
	[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] ||
		fail "CAMPAIGNS_REHEARSAL_RUN_ID must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$."
	[[ "$RUN_ID" != "." && "$RUN_ID" != ".." ]] ||
		fail "CAMPAIGNS_REHEARSAL_RUN_ID cannot be a path segment."
	expected_name="winwidget-campaigns-cutover-rehearsal-$RUN_ID"
	expected_root="/tmp/$expected_name"
	[[ "$APP_ROOT" == "$expected_root" &&
		"$(basename -- "$APP_ROOT")" == "$expected_name" ]] ||
		fail "Unsafe rehearsal app root: $APP_ROOT"
	parent_root="$(realpath -e -- "$(dirname -- "$APP_ROOT")")"
	[[ "$parent_root" == "/tmp" ]] ||
		fail "Rehearsal app root parent must resolve to /tmp."
	if [[ -e "$APP_ROOT" || -L "$APP_ROOT" ]]; then
		[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
			fail "Rehearsal app root must be a regular directory."
		canonical_root="$(realpath -e -- "$APP_ROOT")"
		[[ "$canonical_root" == "$expected_root" ]] ||
			fail "Rehearsal app root resolves outside its exact /tmp target."
	fi
}

assert_image_ref_absent() {
	local image_ref="$1"
	! docker image inspect "$image_ref" >/dev/null 2>&1 ||
		fail "Rehearsal image tag already exists: $image_ref"
}

assert_image_metadata() {
	local image_ref="$1"
	local expected_revision="$2"
	local expected_rehearsal_label="${3:-}"
	local revision rehearsal_label
	revision="$(
		docker image inspect "$image_ref" \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
	)"
	rehearsal_label="$(
		docker image inspect "$image_ref" \
			--format '{{index .Config.Labels "com.winwidget.rehearsal"}}'
	)"
	[[ "$revision" == "$expected_revision" ]] ||
		fail "Image $image_ref has unexpected revision metadata."
	if [[ -n "$expected_rehearsal_label" ]]; then
		[[ "$rehearsal_label" == "$expected_rehearsal_label" ]] ||
			fail "Image $image_ref is not owned by this rehearsal."
	fi
}

assert_target_image_set() {
	local image
	for image in \
		"winwidget-api:git-$TARGET_REVISION" \
		"winwidget-api-gateway:git-$TARGET_REVISION" \
		"winwidget-maintenance:git-$TARGET_REVISION" \
		"winwidget-notification-delivery:git-$TARGET_REVISION" \
		"winwidget-campaigns:git-$TARGET_REVISION"; do
		assert_image_metadata "$image" "$TARGET_REVISION"
	done
}

compose_target() {
	docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
			"$@"
}

compose_baseline() {
	compose_target -f "$BASELINE_COMPOSE_OVERRIDE" "$@"
}

marker_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$MARKER_FILE"
}

wait_for_container_health() {
	local container="$1"
	local attempt health
	for ((attempt = 1; attempt <= 90; attempt++)); do
		health="$(
			docker inspect \
				--format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
				"$container" 2>/dev/null || true
		)"
		[[ "$health" == "healthy" ]] && return
		sleep 1
	done
	fail "$container did not become healthy."
}

wait_for_revision() {
	local url="$1"
	local revision="$2"
	local attempt response
	for ((attempt = 1; attempt <= 90; attempt++)); do
		response="$(curl -fsS --max-time 3 "$url" 2>/dev/null || true)"
		if [[ "$response" == *"\"revision\":\"$revision\""* ||
			"$response" == *"\"revision\": \"$revision\""* ]]; then
			return
		fi
		sleep 1
	done
	fail "$url did not report revision $revision."
}

wait_for_url_ok() {
	local url="$1"
	local attempt
	for ((attempt = 1; attempt <= 90; attempt++)); do
		curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && return
		sleep 1
	done
	fail "$url did not become ready."
}

campaigns_volume_identity() {
	docker volume inspect "$CAMPAIGNS_VOLUME" \
		--format '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}'
}

record_campaigns_volume_identity() {
	local encoded_identity
	CAMPAIGNS_VOLUME_IDENTITY="$(campaigns_volume_identity)"
	[[ -n "$CAMPAIGNS_VOLUME_IDENTITY" &&
		"$CAMPAIGNS_VOLUME_IDENTITY" != *$'\n'* &&
		"$CAMPAIGNS_VOLUME_IDENTITY" != *$'\r'* ]] ||
		fail "Campaigns rehearsal volume identity is invalid."
	encoded_identity="$(
		printf '%s' "$CAMPAIGNS_VOLUME_IDENTITY" |
			base64 |
			tr -d '\n'
	)"
	[[ "$encoded_identity" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
		fail "Campaigns rehearsal volume identity could not be encoded."
	install -o 0 -g 0 -m 600 /dev/null \
		"$CAMPAIGNS_VOLUME_IDENTITY_FILE"
	printf 'run_id=%s\nidentity_base64=%s\n' \
		"$RUN_ID" "$encoded_identity" \
		>"$CAMPAIGNS_VOLUME_IDENTITY_FILE"
}

load_campaigns_volume_identity() {
	local run_line identity_line encoded_identity
	[[ -f "$CAMPAIGNS_VOLUME_IDENTITY_FILE" &&
		! -L "$CAMPAIGNS_VOLUME_IDENTITY_FILE" &&
		"$(stat -c '%u:%g:%a' "$CAMPAIGNS_VOLUME_IDENTITY_FILE")" == \
		"0:0:600" ]] ||
		fail "Campaigns rehearsal volume identity metadata is missing or unsafe."
	run_line="$(sed -n '1p' "$CAMPAIGNS_VOLUME_IDENTITY_FILE")"
	identity_line="$(sed -n '2p' "$CAMPAIGNS_VOLUME_IDENTITY_FILE")"
	[[ "$(wc -l <"$CAMPAIGNS_VOLUME_IDENTITY_FILE" | tr -d '[:space:]')" == \
		"2" &&
		"$run_line" == "run_id=$RUN_ID" &&
		"$identity_line" == identity_base64=* ]] ||
		fail "Campaigns rehearsal volume identity metadata is invalid."
	encoded_identity="${identity_line#identity_base64=}"
	[[ "$encoded_identity" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
		fail "Campaigns rehearsal volume identity encoding is invalid."
	CAMPAIGNS_VOLUME_IDENTITY="$(
		printf '%s' "$encoded_identity" | base64 --decode
	)" || fail "Campaigns rehearsal volume identity could not be decoded."
	[[ -n "$CAMPAIGNS_VOLUME_IDENTITY" &&
		"$CAMPAIGNS_VOLUME_IDENTITY" != *$'\n'* &&
		"$CAMPAIGNS_VOLUME_IDENTITY" != *$'\r'* ]] ||
		fail "Decoded Campaigns rehearsal volume identity is invalid."
}

assert_campaigns_volume_unchanged() {
	if [[ -z "$CAMPAIGNS_VOLUME_IDENTITY" ]]; then
		load_campaigns_volume_identity
	fi
	[[ "$(campaigns_volume_identity)" == "$CAMPAIGNS_VOLUME_IDENTITY" ]] ||
		fail "Campaigns external volume changed during rehearsal."
}

assert_no_existing_rehearsal_targets() {
	[[ ! -e "$APP_ROOT" ]] ||
		fail "Rehearsal app root already exists: $APP_ROOT"
	[[ ! -e "$AUDIT_CANONICAL_ROOT" && ! -L "$AUDIT_CANONICAL_ROOT" ]] ||
		fail "Canonical audit bind target already exists: $AUDIT_CANONICAL_ROOT"
	[[ -z "$(
		docker ps -aq \
			--filter label=com.docker.compose.project=winwidget
	)" ]] ||
		fail "Docker Compose project winwidget is already present."
	for container in "$CORE_CONTAINER" "$RESTORE_CONTAINER"; do
		! docker container inspect "$container" >/dev/null 2>&1 ||
			fail "Rehearsal container already exists: $container"
	done
	for volume in \
		"$CORE_VOLUME" \
		"$NOTIFICATION_VOLUME" \
		"$RABBITMQ_VOLUME" \
		"$CAMPAIGNS_VOLUME"; do
		! docker volume inspect "$volume" >/dev/null 2>&1 ||
			fail "Rehearsal volume target already exists: $volume"
	done
	for network in \
		winwidget-campaigns-postgres \
		winwidget-notification-delivery-postgres \
		winwidget_default; do
		! docker network inspect "$network" >/dev/null 2>&1 ||
			fail "Rehearsal network target already exists: $network"
	done
	local listeners
	listeners="$(ss -ltnH | awk '{ print $4 }')"
	for port in \
		4100 4200 4300 4401 4500 5672 15672 \
		"$CORE_PORT" "$NOTIFICATION_PORT" "$CAMPAIGNS_PORT"; do
		! grep -Eq "[:.]${port}$" <<<"$listeners" ||
			fail "Local rehearsal port is already in use: $port"
	done
	for image in \
		"winwidget-api:$BASELINE_TAG" \
		"winwidget-api-gateway:$BASELINE_TAG" \
		"winwidget-maintenance:$BASELINE_TAG" \
		"winwidget-notification-delivery:$BASELINE_TAG"; do
		assert_image_ref_absent "$image"
	done
}

assert_revision_image_tags_absent() {
	local revision="$1"
	for image in \
		"winwidget-api:git-$revision" \
		"winwidget-api-gateway:git-$revision" \
		"winwidget-maintenance:git-$revision" \
		"winwidget-notification-delivery:git-$revision" \
		"winwidget-campaigns:git-$revision" \
		"winwidget-api:campaigns-pre-$revision" \
		"winwidget-api-gateway:campaigns-pre-$revision" \
		"winwidget-maintenance:campaigns-pre-$revision" \
		"winwidget-notification-delivery:campaigns-pre-$revision"; do
		assert_image_ref_absent "$image"
	done
}

copy_worktree_snapshot() {
	mkdir -p "$APP_ROOT"
	BASELINE_REVISION="$(
		source_git rev-parse \
			--verify --end-of-options "${BASELINE_REF}^{commit}"
	)" || fail "Campaigns rehearsal baseline ref does not resolve: $BASELINE_REF"
	source_git merge-base --is-ancestor \
		"$BASELINE_REVISION" HEAD ||
		fail "Campaigns rehearsal baseline must be an ancestor of source HEAD."
	git -c "safe.directory=$SOURCE_ROOT" \
		clone --quiet --no-hardlinks "$SOURCE_ROOT" "$SERVER_ROOT"
	source_git diff --binary --no-ext-diff HEAD |
		git -C "$SERVER_ROOT" apply --binary
	source_git ls-files --others --exclude-standard -z |
		(
			cd "$SOURCE_ROOT"
			tar --null --files-from=- -cf -
		) |
		(
			cd "$SERVER_ROOT"
			tar -xf -
		)
	git -C "$SERVER_ROOT" add -A
	git -C "$SERVER_ROOT" config user.name 'WinWidget Cutover Rehearsal'
	git -C "$SERVER_ROOT" config user.email 'cutover-rehearsal@localhost'
	git -C "$SERVER_ROOT" commit --quiet --allow-empty \
		-m 'test: stage campaigns cutover rehearsal'
	git -C "$SERVER_ROOT" branch -M prod
	TARGET_REVISION="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
	[[ "$TARGET_REVISION" != "$BASELINE_REVISION" ]] ||
		fail "Target rehearsal revision must differ from the legacy baseline."
	mkdir -p "$APP_ROOT/deploy/backend"
	printf '%s\n' "$TARGET_REVISION" \
		>"$APP_ROOT/deploy/backend/.rehearsal-target-revision"

	git -c "safe.directory=$SOURCE_ROOT" \
		clone --quiet --no-hardlinks --no-checkout \
		"$SOURCE_ROOT" "$BASELINE_ROOT"
	git -C "$BASELINE_ROOT" checkout --quiet --detach "$BASELINE_REVISION"
	[[ "$(git -C "$BASELINE_ROOT" rev-parse HEAD)" == "$BASELINE_REVISION" ]] ||
		fail "Detached rehearsal baseline does not match $BASELINE_REF."
	[[ -f "$BASELINE_ROOT/src/mailing/mailing.service.ts" &&
		-f "$BASELINE_ROOT/prisma/migrations/20260724010000_add_async_mailing_campaigns/migration.sql" ]] ||
		fail "Baseline ref does not contain the legacy mailing implementation."
	git -C "$BASELINE_ROOT" grep -Fq 'model MailingCampaign' \
		-- prisma/schema.prisma ||
		fail "Baseline ref does not contain the legacy MailingCampaign schema."
	[[ ! -e "$BASELINE_ROOT/prisma/migrations/20260730010000_contract_extract_campaigns" &&
		! -e "$BASELINE_ROOT/apps/campaigns" ]] ||
		fail "Baseline ref already contains the Campaigns extraction contract."
	[[ -f "$SERVER_ROOT/prisma/migrations/20260730010000_contract_extract_campaigns/migration.sql" &&
		-f "$SERVER_ROOT/apps/campaigns/prisma/schema.prisma" ]] ||
		fail "Target snapshot does not contain the Campaigns extraction contract."
	assert_revision_image_tags_absent "$TARGET_REVISION"
}

write_rehearsal_compose_file() {
	local temporary="$COMPOSE_FILE.tmp.$$"
	local exclude_pattern='/deploy/docker-compose.rehearsal.yml'
	local expected_metadata_count actual_metadata_count
	[[ -f "$SOURCE_COMPOSE_FILE" && ! -L "$SOURCE_COMPOSE_FILE" &&
		! -e "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
		fail "Rehearsal Compose source or target path is unsafe."
	! grep -Eq '^  default:$' "$SOURCE_COMPOSE_FILE" ||
		fail "Rehearsal Compose label generator requires an implicit default network."

	awk \
		-v run_id="$RUN_ID" \
		-v app_root="$APP_ROOT" \
		-v config_file="$COMPOSE_FILE" \
		-v working_dir="$COMPOSE_WORKING_DIR" '
		function print_provenance(indent) {
			print indent "com.winwidget.rehearsal: \047" run_id "\047"
			print indent "com.winwidget.rehearsal.app-root: \047" app_root "\047"
			print indent "com.winwidget.rehearsal.config-file: \047" config_file "\047"
			print indent "com.winwidget.rehearsal.working-dir: \047" working_dir "\047"
		}
		function flush_service(    block_index, has_labels) {
			if (block_count == 0) return
			has_labels = 0
			for (block_index = 1; block_index <= block_count; block_index += 1) {
				if (block[block_index] == "    labels:") has_labels = 1
			}
			for (block_index = 1; block_index <= block_count; block_index += 1) {
				print block[block_index]
				if (block_index == 1 && !has_labels) {
					print "    labels:"
					print_provenance("      ")
				} else if (has_labels && block[block_index] == "    labels:") {
					print_provenance("      ")
				}
			}
			delete block
			block_count = 0
		}
		function flush_network(    block_index, has_labels) {
			if (block_count == 0) return
			has_labels = 0
			for (block_index = 1; block_index <= block_count; block_index += 1) {
				if (block[block_index] == "    labels:") has_labels = 1
			}
			for (block_index = 1; block_index <= block_count; block_index += 1) {
				print block[block_index]
				if (block_index == 1 && !has_labels) {
					print "    labels:"
					print_provenance("      ")
				} else if (has_labels && block[block_index] == "    labels:") {
					print_provenance("      ")
				}
			}
			delete block
			block_count = 0
		}
		$0 == "services:" {
			print
			section = "services"
			next
		}
		section == "services" && $0 == "volumes:" {
			flush_service()
			print
			section = "other"
			next
		}
		section == "services" {
			if ($0 ~ /^  [A-Za-z0-9][A-Za-z0-9_-]*:$/) {
				flush_service()
				block[++block_count] = $0
			} else if (block_count > 0) {
				block[++block_count] = $0
			} else {
				print
			}
			next
		}
		$0 == "networks:" {
			print
			section = "networks"
			next
		}
		section == "networks" && $0 == "secrets:" {
			flush_network()
			print "  default:"
			print "    labels:"
			print_provenance("      ")
			print
			section = "other"
			next
		}
		section == "networks" {
			if ($0 ~ /^  [A-Za-z0-9][A-Za-z0-9_-]*:$/) {
				flush_network()
				block[++block_count] = $0
			} else if (block_count > 0) {
				block[++block_count] = $0
			} else {
				print
			}
			next
		}
		{ print }
		END {
			if (section == "services") flush_service()
			if (section == "networks") flush_network()
		}
	' "$SOURCE_COMPOSE_FILE" >"$temporary" ||
		fail "Could not generate the rehearsal-owned Compose file."
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$COMPOSE_FILE"
	expected_metadata_count="$(
		awk '
			$0 == "services:" { section = "services"; next }
			$0 == "volumes:" { section = ""; next }
			$0 == "networks:" { section = "networks"; next }
			$0 == "secrets:" { section = ""; next }
			(section == "services" || section == "networks") &&
				/^  [A-Za-z0-9][A-Za-z0-9_-]*:$/ { count += 1 }
			END { print count + 1 }
		' "$SOURCE_COMPOSE_FILE"
	)"
	actual_metadata_count="$(
		grep -Fc "com.winwidget.rehearsal: '$RUN_ID'" "$COMPOSE_FILE"
	)"
	[[ "$actual_metadata_count" == "$expected_metadata_count" ]] ||
		fail "Rehearsal Compose file does not label every service and network."
	if ! grep -Fxq "$exclude_pattern" "$SERVER_ROOT/.git/info/exclude"; then
		printf '%s\n' "$exclude_pattern" >>"$SERVER_ROOT/.git/info/exclude"
	fi
	compose_target config --quiet ||
		fail "Generated rehearsal Compose file is invalid."
	[[ -z "$(git -C "$SERVER_ROOT" status --porcelain --untracked-files=all)" ]] ||
		fail "Generated rehearsal Compose metadata dirtied the protected checkout."
}

write_rehearsal_configuration() {
	local jwt_private jwt_jwks payment_key
	local -a jwt_material
	mkdir -p "$APP_ROOT/deploy/backend"
	mapfile -t jwt_material < <(
		docker run --rm --network none --entrypoint node node:20-alpine -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
});
const kid = "campaigns-rehearsal";
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicJwk = publicKey.export({ format: "jwk" });
publicJwk.kid = kid;
publicJwk.alg = "RS256";
publicJwk.use = "sig";
process.stdout.write(`${Buffer.from(privatePem).toString("base64")}\n`);
process.stdout.write(`${Buffer.from(JSON.stringify({ keys: [publicJwk] })).toString("base64")}\n`);
process.stdout.write(`${Buffer.alloc(32, 7).toString("base64")}\n`);
'
	)
	[[ ${#jwt_material[@]} -eq 3 ]] ||
		fail "Could not generate rehearsal JWT material."
	jwt_private="${jwt_material[0]}"
	jwt_jwks="${jwt_material[1]}"
	payment_key="${jwt_material[2]}"

	install -m 600 /dev/null \
		"$APP_ROOT/deploy/backend/.campaigns-postgres-admin-password"
	printf '%s\n' "$CAMPAIGNS_ADMIN_PASSWORD" \
		>"$APP_ROOT/deploy/backend/.campaigns-postgres-admin-password"
	install -m 600 /dev/null \
		"$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password"
	printf '%s\n' "$NOTIFICATION_ADMIN_PASSWORD" \
		>"$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password"

	local -a env_lines=(
		'MODE=production'
		"APP_VERSION=git-$TARGET_REVISION"
		"APP_REVISION=$TARGET_REVISION"
		"MAINTENANCE_REVISION=$TARGET_REVISION"
		"MAINTENANCE_IMAGE=winwidget-maintenance:git-$TARGET_REVISION"
		"NOTIFICATION_DELIVERY_REVISION=$TARGET_REVISION"
		"NOTIFICATION_DELIVERY_IMAGE=winwidget-notification-delivery:git-$TARGET_REVISION"
		"CAMPAIGNS_REVISION=$TARGET_REVISION"
		"CAMPAIGNS_IMAGE=winwidget-campaigns:git-$TARGET_REVISION"
		'COMPOSE_PROJECT_NAME=winwidget'
		"NOTIFICATION_DELIVERY_POSTGRES_IMAGE=$POSTGRES_IMAGE"
		"NOTIFICATION_DELIVERY_POSTGRES_PORT=$NOTIFICATION_PORT"
		"NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME=$NOTIFICATION_VOLUME"
		'NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER=winwidget_notification_delivery_admin'
		"NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE=$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password"
		"NOTIFICATION_DELIVERY_DATABASE_URL=postgresql://winwidget_notification_delivery_runtime:$NOTIFICATION_RUNTIME_PASSWORD@127.0.0.1:$NOTIFICATION_PORT/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable"
		"NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION=postgresql://winwidget_notification_delivery_migration:$NOTIFICATION_MIGRATION_PASSWORD@127.0.0.1:$NOTIFICATION_PORT/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable"
		"NOTIFICATION_DELIVERY_BACKUP_URL=postgresql://winwidget_notification_delivery_backup:$NOTIFICATION_BACKUP_PASSWORD@127.0.0.1:$NOTIFICATION_PORT/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable"
		"CAMPAIGNS_POSTGRES_IMAGE=$POSTGRES_IMAGE"
		"CAMPAIGNS_POSTGRES_PORT=$CAMPAIGNS_PORT"
		"CAMPAIGNS_POSTGRES_DATA_VOLUME=$CAMPAIGNS_VOLUME"
		'CAMPAIGNS_POSTGRES_ADMIN_USER=winwidget_campaigns_admin'
		"CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE=$APP_ROOT/deploy/backend/.campaigns-postgres-admin-password"
		"CAMPAIGNS_DATABASE_URL=postgresql://winwidget_campaigns_runtime:$CAMPAIGNS_RUNTIME_PASSWORD@127.0.0.1:$CAMPAIGNS_PORT/winwidget_campaigns?schema=campaigns&sslmode=disable"
		"CAMPAIGNS_MIGRATION_DATABASE_URL=postgresql://winwidget_campaigns_migration:$CAMPAIGNS_MIGRATION_PASSWORD@127.0.0.1:$CAMPAIGNS_PORT/winwidget_campaigns?schema=campaigns&sslmode=disable"
		"CAMPAIGNS_BACKUP_URL=postgresql://winwidget_campaigns_backup:$CAMPAIGNS_BACKUP_PASSWORD@127.0.0.1:$CAMPAIGNS_PORT/winwidget_campaigns?schema=campaigns&sslmode=disable"
		'CAMPAIGNS_PROCESS_ROLE=all'
		'CAMPAIGNS_LISTEN_HOST=127.0.0.1'
		'CAMPAIGNS_HEALTH_PORT=4500'
		'CAMPAIGNS_CORE_INTERNAL_BASE_URL=http://127.0.0.1:4200'
		'CAMPAIGNS_INTERNAL_TOKEN=rehearsal_campaigns_internal_token_32_chars'
		'CAMPAIGNS_INTERNAL_TIMEOUT_MS=10000'
		'CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE=500'
		'CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS=300000'
		'CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE=1000'
		'CAMPAIGNS_PREFETCH=10'
		'CAMPAIGNS_EMAIL_RATE_PER_SECOND=10'
		'CAMPAIGNS_TELEGRAM_RATE_PER_SECOND=5'
		'CAMPAIGNS_OUTBOX_BATCH_SIZE=50'
		'CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS=1000'
		'CAMPAIGNS_OUTBOX_RETENTION_DAYS=7'
		'CAMPAIGNS_TELEGRAM_AUDIT_DECISION=pending'
		'CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE='
		'CAMPAIGNS_RESTORE_DRILL_REFERENCE='
		"PORT=4200"
		'API_LISTEN_HOST=127.0.0.1'
		'TRUST_PROXY=loopback'
		'PRODUCTION_HOST=http://127.0.0.1:4200'
		'AUTH_COOKIE_DOMAIN='
		'TELEGRAM_WEBHOOK_HOST=http://127.0.0.1:4200'
		"DATABASE_URL_PRODUCTION=postgresql://winwidget_core_runtime:$CORE_RUNTIME_PASSWORD@127.0.0.1:$CORE_PORT/winwidget?schema=public&sslmode=disable"
		"DATABASE_MIGRATION_URL_PRODUCTION=postgresql://winwidget_core_migration:$CORE_MIGRATION_PASSWORD@127.0.0.1:$CORE_PORT/winwidget?schema=public&sslmode=disable"
		"MAINTENANCE_DATABASE_URL_PRODUCTION=postgresql://winwidget_core_runtime:$CORE_RUNTIME_PASSWORD@127.0.0.1:$CORE_PORT/winwidget?schema=public&sslmode=disable"
		"DATABASE_BACKUP_URL=postgresql://winwidget_core_backup:$CORE_BACKUP_PASSWORD@127.0.0.1:$CORE_PORT/winwidget?schema=public&sslmode=disable"
		"JWT_ACCESS_PRIVATE_KEY_BASE64=$jwt_private"
		"JWT_ACCESS_JWKS_BASE64=$jwt_jwks"
		'JWT_ACCESS_ACTIVE_KID=campaigns-rehearsal'
		'JWT_ISSUER=http://127.0.0.1:4200/auth'
		'JWT_AUDIENCE=http://127.0.0.1:4200'
		'JWT_ACCESS_TTL_SECONDS=900'
		'JWT_CLOCK_TOLERANCE_SECONDS=5'
		'GATEWAY_LISTEN_HOST=127.0.0.1'
		'GATEWAY_PORT=4100'
		"GATEWAY_ROUTES_JSON=$TARGET_GATEWAY_ROUTES"
		'CORS_ALLOWED_ORIGINS=http://127.0.0.1:3000'
		'JWT_JWKS_URL=http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json'
		'JWKS_FETCH_TIMEOUT_MS=3000'
		'JWKS_REFRESH_MIN_INTERVAL_MS=5000'
		'JWKS_CACHE_TTL_MS=300000'
		'JWKS_MAX_STALE_MS=3600000'
		'JWKS_MAX_BYTES=262144'
		'JWT_MAX_TOKEN_BYTES=16384'
		'GATEWAY_SHUTDOWN_GRACE_MS=10000'
		'RECAPTCHA_SECRET_KEY=rehearsal'
		'RECAPTCHA_CLIENT_URL=http://127.0.0.1:3000'
		'RECAPTCHA_ENABLED=false'
		'RECAPTCHA_MIN_SCORE=0.5'
		'SMTP_LOGIN=rehearsal@localhost'
		'SMTP_PASSWORD=rehearsal'
		'SMTP_SERVER=127.0.0.1'
		'SMTP_CONNECTION_TIMEOUT_MS=100'
		'SMTP_GREETING_TIMEOUT_MS=100'
		'SMTP_SOCKET_TIMEOUT_MS=100'
		'SMSAERO_EMAIL=rehearsal@localhost'
		'SMSAERO_API_KEY=rehearsal'
		'SMSAERO_SIGN=rehearsal'
		'GOOGLE_CLIENT_ID=rehearsal'
		'GOOGLE_CLIENT_SECRET=rehearsal'
		'GOOGLE_CALLBACK_URL=http://127.0.0.1:4200/api/v1/auth/google/redirect'
		'GITHUB_CLIENT_ID=rehearsal'
		'GITHUB_CLIENT_SECRET=rehearsal'
		'GITHUB_CALLBACK_URL=http://127.0.0.1:4200/api/v1/auth/github/redirect'
		'YANDEX_CLIENT_ID=rehearsal'
		'YANDEX_CLIENT_SECRET=rehearsal'
		'YANDEX_CALLBACK_URL=http://127.0.0.1:4200/api/v1/auth/yandex/redirect'
		'VK_CLIENT_ID=rehearsal'
		'VK_CLIENT_SECRET=rehearsal'
		'VK_SERVICE_TOKEN=rehearsal'
		'VK_CALLBACK_URL=http://127.0.0.1:4200/api/v1/auth/vk/redirect'
		'YOOKASSA_PRODUCTION_SHOP_ID=rehearsal'
		'YOOKASSA_PRODUCTION_SECRET_KEY=rehearsal'
		"PAYMENT_METHOD_ENCRYPTION_KEY=$payment_key"
		'TELEGRAM_INFO_BOT_TOKEN=100000001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
		'TELEGRAM_INFO_BOT_USERNAME=rehearsal_info_bot'
		'TELEGRAM_INFO_BOT_WEBHOOK_SECRET=rehearsal-info-secret'
		'TELEGRAM_AUTH_BOT_TOKEN=100000002:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
		'TELEGRAM_AUTH_BOT_USERNAME=rehearsal_auth_bot'
		'TELEGRAM_AUTH_BOT_WEBHOOK_SECRET=rehearsal-auth-secret'
		'TELEGRAM_SUPPORT_BOT_TOKEN=100000003:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
		'TELEGRAM_SUPPORT_BOT_USERNAME=rehearsal_support_bot'
		'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET=rehearsal-support-secret'
		'S3_ENDPOINT=http://127.0.0.1:9000'
		'S3_REGION=local'
		'S3_BUCKET=rehearsal'
		'S3_ACCESS_KEY_ID=rehearsal'
		'S3_SECRET_ACCESS_KEY=rehearsal'
		'S3_PUBLIC_BASE_URL=http://127.0.0.1:9000/rehearsal'
		'S3_KEY_PREFIX=rehearsal'
		'S3_FORCE_PATH_STYLE=true'
		"RABBITMQ_DATA_VOLUME=$RABBITMQ_VOLUME"
		'RABBITMQ_VHOST=winwidget'
		'RABBITMQ_ADMIN_USER=winwidget-admin'
		"RABBITMQ_ADMIN_PASSWORD=$RABBITMQ_ADMIN_PASSWORD"
		'RABBITMQ_MONITOR_USER=winwidget-monitor'
		"RABBITMQ_MONITOR_PASSWORD=$RABBITMQ_MONITOR_PASSWORD"
		"RABBITMQ_PUBLISHER_URL=amqp://winwidget-publisher:$RABBITMQ_PUBLISHER_PASSWORD@127.0.0.1:5672/winwidget"
		"RABBITMQ_INTEGRATION_WORKER_URL=amqp://winwidget-integration:$RABBITMQ_INTEGRATION_PASSWORD@127.0.0.1:5672/winwidget"
		"RABBITMQ_MAINTENANCE_WORKER_URL=amqp://winwidget-maintenance:$RABBITMQ_MAINTENANCE_PASSWORD@127.0.0.1:5672/winwidget"
		"RABBITMQ_NOTIFICATION_DELIVERY_URL=amqp://winwidget-notification-delivery:$RABBITMQ_NOTIFICATION_PASSWORD@127.0.0.1:5672/winwidget"
		"RABBITMQ_CAMPAIGNS_URL=amqp://winwidget-campaigns:$RABBITMQ_CAMPAIGNS_PASSWORD@127.0.0.1:5672/winwidget"
		'RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15672'
		'RABBITMQ_MAX_MESSAGE_BYTES=262144'
		'RABBITMQ_WORKER_PREFETCH=10'
		'OUTBOX_BATCH_SIZE=50'
		'OUTBOX_POLL_INTERVAL_MS=1000'
		'OUTBOX_RETENTION_DAYS=7'
		'MAINTENANCE_WORKER_PREFETCH=1'
		'MAINTENANCE_HEALTH_PORT=4300'
		'SCHEDULED_JOB_POLL_INTERVAL_MS=30000'
		'SCHEDULED_JOB_LEASE_MS=120000'
		'SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS=30000'
		"INTEGRATION_WORKER_KINDS=$TARGET_INTEGRATION_KINDS"
		'MAINTENANCE_WORKER_KINDS=database-backup'
		'NOTIFICATION_DELIVERY_INTERNAL_URL=http://127.0.0.1:4401/internal/notification-delivery'
		'NOTIFICATION_DELIVERY_INTERNAL_TOKEN=rehearsal_notification_internal_token_32_chars'
		'NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS=5000'
		'NOTIFICATION_DELIVERY_LISTEN_HOST=127.0.0.1'
		'NOTIFICATION_DELIVERY_HEALTH_PORT=4401'
		'NOTIFICATION_DELIVERY_PREFETCH=5'
		'NOTIFICATION_DELIVERY_KINDS=email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram'
		'NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS=90'
		'NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS=30'
		'MESSAGING_ALERTS_ENABLED=false'
		'MESSAGING_ACTIVITY_STALE_MS=300000'
		'MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD=100'
		'INTEGRATION_RECEIPT_RETENTION_DAYS=90'
		'INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS=30'
		'MAILING_EMAIL_RATE_PER_SECOND=5'
		'MAILING_TELEGRAM_RATE_PER_SECOND=10'
	)
	install -m 600 /dev/null "$ENV_FILE"
	printf '%s\n' "${env_lines[@]}" >"$ENV_FILE"
	install -m 600 /dev/null "$BASELINE_COMPOSE_OVERRIDE"
	printf '%s\n' \
		'services:' \
		'  integration-worker:' \
		'    environment:' \
		"      INTEGRATION_WORKER_KINDS: '$LEGACY_INTEGRATION_KINDS'" \
		"      MAILING_EMAIL_RATE_PER_SECOND: '$LEGACY_MAILING_EMAIL_RATE'" \
		"      MAILING_TELEGRAM_RATE_PER_SECOND: '$LEGACY_MAILING_TELEGRAM_RATE'" \
		>"$BASELINE_COMPOSE_OVERRIDE"
	write_rehearsal_compose_file
}

build_baseline_images() {
	docker build --quiet \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--build-arg "APP_REVISION=$BASELINE_REVISION" \
		-t "winwidget-api:$BASELINE_TAG" \
		"$BASELINE_ROOT"
	docker build --quiet \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--target maintenance-runner \
		--build-arg "APP_REVISION=$BASELINE_REVISION" \
		-t "winwidget-maintenance:$BASELINE_TAG" \
		"$BASELINE_ROOT"
	docker build --quiet \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--build-arg "APP_REVISION=$BASELINE_REVISION" \
		-t "winwidget-api-gateway:$BASELINE_TAG" \
		"$BASELINE_ROOT/apps/api-gateway"
	docker build --quiet \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--build-arg "APP_REVISION=$BASELINE_REVISION" \
		-t "winwidget-notification-delivery:$BASELINE_TAG" \
		"$BASELINE_ROOT/apps/notification-delivery"
	for image in \
		"winwidget-api:$BASELINE_TAG" \
		"winwidget-api-gateway:$BASELINE_TAG" \
		"winwidget-maintenance:$BASELINE_TAG" \
		"winwidget-notification-delivery:$BASELINE_TAG"; do
		assert_image_metadata "$image" "$BASELINE_REVISION" "$RUN_ID"
	done
}

create_rehearsal_volume() {
	local volume="$1"
	shift
	docker volume create \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--label "com.winwidget.rehearsal.app-root=$APP_ROOT" \
		--label "com.winwidget.rehearsal.config-file=$COMPOSE_FILE" \
		--label "com.winwidget.rehearsal.working-dir=$COMPOSE_WORKING_DIR" \
		"$@" \
		"$volume" >/dev/null
}

assert_rehearsal_volume_provenance() {
	local volume="$1"
	local provenance
	provenance="$(
		docker volume inspect "$volume" \
			--format '{{index .Labels "com.winwidget.rehearsal"}}|{{index .Labels "com.winwidget.rehearsal.app-root"}}|{{index .Labels "com.winwidget.rehearsal.config-file"}}|{{index .Labels "com.winwidget.rehearsal.working-dir"}}'
	)"
	[[ "$provenance" == \
		"$RUN_ID|$APP_ROOT|$COMPOSE_FILE|$COMPOSE_WORKING_DIR" ]] ||
		fail "Volume $volume is not owned by this exact rehearsal."
}

assert_campaigns_cleanup_volume_labels() {
	local labels expected_labels
	labels="$(
		docker volume inspect "$CAMPAIGNS_VOLUME" \
			--format '{{printf "%s|%s|%s|%s" (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.cutover.revision") (index .Labels "com.winwidget.cutover.started-at")}}'
	)"
	expected_labels="campaigns|postgres-data|$(marker_value revision)|$(marker_value cutover_started_at)"
	if [[ "$labels" == "$expected_labels" ]]; then
		return
	fi
	[[ "$labels" == "campaigns|postgres-data||" ]] ||
		fail "Campaigns rehearsal volume has unexpected role labels."
	load_campaigns_volume_identity
	assert_campaigns_volume_unchanged
}

start_datastores() {
	create_rehearsal_volume "$CORE_VOLUME"
	create_rehearsal_volume "$NOTIFICATION_VOLUME"
	create_rehearsal_volume "$RABBITMQ_VOLUME"
	docker run -d \
		--name "$CORE_CONTAINER" \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--label "com.winwidget.rehearsal.app-root=$APP_ROOT" \
		--label "com.winwidget.rehearsal.config-file=$COMPOSE_FILE" \
		--label "com.winwidget.rehearsal.working-dir=$COMPOSE_WORKING_DIR" \
		-e POSTGRES_DB=winwidget \
		-e "POSTGRES_USER=$CORE_ADMIN_USER" \
		-e "POSTGRES_PASSWORD=$CORE_ADMIN_PASSWORD" \
		-e PGDATA=/var/lib/postgresql/18/docker \
		-p "127.0.0.1:$CORE_PORT:5432" \
		-v "$CORE_VOLUME:/var/lib/postgresql" \
		--health-cmd "pg_isready --username $CORE_ADMIN_USER --dbname winwidget" \
		--health-interval 1s \
		--health-timeout 3s \
		--health-retries 60 \
		"$POSTGRES_IMAGE" >/dev/null
	wait_for_container_health "$CORE_CONTAINER"

	compose_target --profile notification-delivery-database \
		up -d notification-delivery-postgres
	wait_for_container_health "$(compose_target ps -q notification-delivery-postgres)"
	compose_target up -d rabbitmq
	wait_for_container_health "$(compose_target ps -q rabbitmq)"
}

provision_core_rehearsal_roles() {
	docker run --rm -i --network host \
		-e "PGPASSWORD=$CORE_ADMIN_PASSWORD" \
		"$POSTGRES_IMAGE" \
		psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port "$CORE_PORT" \
			--username "$CORE_ADMIN_USER" --dbname winwidget <<'SQL'
CREATE ROLE winwidget_core_runtime LOGIN
	PASSWORD 'rehearsal_core_runtime_password_32'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_core_migration LOGIN
	PASSWORD 'rehearsal_core_migration_password_32'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_core_backup LOGIN
	PASSWORD 'rehearsal_core_backup_password_32'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE winwidget OWNER TO winwidget_core_migration;
ALTER SCHEMA public OWNER TO winwidget_core_migration;
SELECT format('ALTER TABLE %I.%I OWNER TO winwidget_core_migration', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
\gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO winwidget_core_migration', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
\gexec
SELECT format('ALTER TYPE %I.%I OWNER TO winwidget_core_migration', n.nspname, t.typname)
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype = 'e'
\gexec
REVOKE ALL ON DATABASE winwidget FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget
	TO winwidget_core_runtime, winwidget_core_migration, winwidget_core_backup;
REVOKE CREATE ON DATABASE winwidget
	FROM winwidget_core_runtime, winwidget_core_backup;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO winwidget_core_runtime, winwidget_core_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
	TO winwidget_core_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
	TO winwidget_core_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO winwidget_core_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO winwidget_core_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_core_migration IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_core_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_core_migration IN SCHEMA public
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_core_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_core_migration IN SCHEMA public
	GRANT SELECT ON TABLES TO winwidget_core_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_core_migration IN SCHEMA public
	GRANT SELECT ON SEQUENCES TO winwidget_core_backup;
REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations
	FROM winwidget_core_runtime;
SQL
}

provision_notification_rehearsal_roles() {
	docker run --rm -i --network host \
		-e "PGPASSWORD=$NOTIFICATION_ADMIN_PASSWORD" \
		"$POSTGRES_IMAGE" \
		psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port "$NOTIFICATION_PORT" \
			--username winwidget_notification_delivery_admin \
			--dbname winwidget_notification_delivery <<'SQL'
CREATE ROLE winwidget_notification_delivery_runtime LOGIN
	PASSWORD 'rehearsal_notification_runtime_password_32'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_notification_delivery_migration LOGIN
	PASSWORD 'rehearsal_notification_migration_password_32'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE winwidget_notification_delivery_backup LOGIN
	PASSWORD 'rehearsal_notification_backup_password_32'
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE winwidget_notification_delivery
	OWNER TO winwidget_notification_delivery_migration;
ALTER SCHEMA notification_delivery
	OWNER TO winwidget_notification_delivery_migration;
SELECT format(
	'ALTER TABLE %I.%I OWNER TO winwidget_notification_delivery_migration',
	n.nspname,
	c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'notification_delivery' AND c.relkind IN ('r', 'p')
\gexec
SELECT format(
	'ALTER SEQUENCE %I.%I OWNER TO winwidget_notification_delivery_migration',
	n.nspname,
	c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'notification_delivery' AND c.relkind = 'S'
\gexec
SELECT format(
	'ALTER TYPE %I.%I OWNER TO winwidget_notification_delivery_migration',
	n.nspname,
	t.typname
)
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'notification_delivery' AND t.typtype = 'e'
\gexec
REVOKE ALL ON DATABASE winwidget_notification_delivery FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_notification_delivery
	TO winwidget_notification_delivery_runtime,
		winwidget_notification_delivery_migration,
		winwidget_notification_delivery_backup;
REVOKE CREATE ON DATABASE winwidget_notification_delivery
	FROM winwidget_notification_delivery_runtime,
		winwidget_notification_delivery_backup;
REVOKE ALL ON SCHEMA notification_delivery FROM PUBLIC;
GRANT USAGE ON SCHEMA notification_delivery
	TO winwidget_notification_delivery_runtime,
		winwidget_notification_delivery_backup;
GRANT SELECT, INSERT, UPDATE, DELETE
	ON ALL TABLES IN SCHEMA notification_delivery
	TO winwidget_notification_delivery_runtime;
GRANT USAGE, SELECT, UPDATE
	ON ALL SEQUENCES IN SCHEMA notification_delivery
	TO winwidget_notification_delivery_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA notification_delivery
	TO winwidget_notification_delivery_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA notification_delivery
	TO winwidget_notification_delivery_backup;
ALTER DEFAULT PRIVILEGES
	FOR ROLE winwidget_notification_delivery_migration
	IN SCHEMA notification_delivery
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
	TO winwidget_notification_delivery_runtime;
ALTER DEFAULT PRIVILEGES
	FOR ROLE winwidget_notification_delivery_migration
	IN SCHEMA notification_delivery
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES
	TO winwidget_notification_delivery_runtime;
ALTER DEFAULT PRIVILEGES
	FOR ROLE winwidget_notification_delivery_migration
	IN SCHEMA notification_delivery
	GRANT SELECT ON TABLES TO winwidget_notification_delivery_backup;
ALTER DEFAULT PRIVILEGES
	FOR ROLE winwidget_notification_delivery_migration
	IN SCHEMA notification_delivery
	GRANT SELECT ON SEQUENCES TO winwidget_notification_delivery_backup;
REVOKE ALL PRIVILEGES
	ON TABLE notification_delivery._prisma_migrations
	FROM winwidget_notification_delivery_runtime;
SQL
}

assert_rehearsal_database_role_boundaries() {
	local core_state notification_state
	core_state="$(
		docker run --rm --network host \
			-e "PGPASSWORD=$CORE_ADMIN_PASSWORD" \
			"$POSTGRES_IMAGE" \
			psql --no-psqlrc --tuples-only --no-align \
				--host 127.0.0.1 --port "$CORE_PORT" \
				--username "$CORE_ADMIN_USER" --dbname winwidget \
				--command "
SELECT
	(SELECT pg_get_userbyid(datdba) FROM pg_database
	 WHERE datname = current_database()) || '|' ||
	(SELECT pg_get_userbyid(relowner) FROM pg_class
	 WHERE oid = 'public.\"User\"'::regclass) || '|' ||
	(
		has_table_privilege('winwidget_core_runtime', 'public.\"User\"', 'SELECT')
		AND has_table_privilege('winwidget_core_runtime', 'public.\"User\"', 'INSERT')
		AND has_table_privilege('winwidget_core_runtime', 'public.\"User\"', 'UPDATE')
		AND has_table_privilege('winwidget_core_runtime', 'public.\"User\"', 'DELETE')
	) || '|' ||
	has_table_privilege(
		'winwidget_core_runtime', 'public._prisma_migrations', 'SELECT'
	) || '|' ||
	has_table_privilege(
		'winwidget_core_backup', 'public.\"User\"', 'SELECT'
	) || '|' ||
	has_table_privilege(
		'winwidget_core_backup', 'public.\"User\"', 'INSERT'
	);
"
	)"
	[[ "$core_state" == \
		'winwidget_core_migration|winwidget_core_migration|true|false|true|false' ]] ||
		fail "Core rehearsal role boundary is invalid: $core_state"
	notification_state="$(
		docker run --rm --network host \
			-e "PGPASSWORD=$NOTIFICATION_ADMIN_PASSWORD" \
			"$POSTGRES_IMAGE" \
			psql --no-psqlrc --tuples-only --no-align \
				--host 127.0.0.1 --port "$NOTIFICATION_PORT" \
				--username winwidget_notification_delivery_admin \
				--dbname winwidget_notification_delivery \
				--command "
SELECT
	(SELECT pg_get_userbyid(datdba) FROM pg_database
	 WHERE datname = current_database()) || '|' ||
	(SELECT pg_get_userbyid(relowner) FROM pg_class
	 WHERE oid = 'notification_delivery.delivery_receipts'::regclass) || '|' ||
	(
		has_table_privilege(
			'winwidget_notification_delivery_runtime',
			'notification_delivery.delivery_receipts',
			'SELECT'
		)
		AND has_table_privilege(
			'winwidget_notification_delivery_runtime',
			'notification_delivery.delivery_receipts',
			'INSERT'
		)
		AND has_table_privilege(
			'winwidget_notification_delivery_runtime',
			'notification_delivery.delivery_receipts',
			'UPDATE'
		)
		AND has_table_privilege(
			'winwidget_notification_delivery_runtime',
			'notification_delivery.delivery_receipts',
			'DELETE'
		)
	) || '|' ||
	has_table_privilege(
		'winwidget_notification_delivery_runtime',
		'notification_delivery._prisma_migrations',
		'SELECT'
	) || '|' ||
	has_table_privilege(
		'winwidget_notification_delivery_backup',
		'notification_delivery.delivery_receipts',
		'SELECT'
	) || '|' ||
	has_table_privilege(
		'winwidget_notification_delivery_backup',
		'notification_delivery.delivery_receipts',
		'INSERT'
	);
"
	)"
	[[ "$notification_state" == \
		'winwidget_notification_delivery_migration|winwidget_notification_delivery_migration|true|false|true|false' ]] ||
		fail "Notification Delivery rehearsal role boundary is invalid: $notification_state"
}

migrate_and_seed_datastores() {
	local core_url notification_url
	core_url="postgresql://$CORE_ADMIN_USER:$CORE_ADMIN_PASSWORD@127.0.0.1:$CORE_PORT/winwidget?schema=public&sslmode=disable"
	notification_url="postgresql://winwidget_notification_delivery_admin:$NOTIFICATION_ADMIN_PASSWORD@127.0.0.1:$NOTIFICATION_PORT/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable"
	docker run --rm --network host \
		-e "DATABASE_URL=$core_url" \
		--entrypoint ./node_modules/.bin/prisma \
		"winwidget-api:$BASELINE_TAG" \
		migrate deploy
	docker run --rm --network host \
		-e "NOTIFICATION_DELIVERY_DATABASE_URL=$notification_url" \
		--entrypoint ./node_modules/.bin/prisma \
		"winwidget-notification-delivery:$BASELINE_TAG" \
		migrate deploy --schema prisma/schema.prisma
	provision_core_rehearsal_roles
	provision_notification_rehearsal_roles

	docker run --rm -i --network host \
		-e "PGPASSWORD=$CORE_ADMIN_PASSWORD" \
		"$POSTGRES_IMAGE" \
		psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port "$CORE_PORT" \
			--username "$CORE_ADMIN_USER" --dbname winwidget <<'SQL'
INSERT INTO "User" ("id", "password", "rights", "updated_at")
VALUES (
	'campaign-rehearsal-admin',
	'not-a-real-password-hash',
	ARRAY['ADMIN', 'DEV']::"Role"[],
	CURRENT_TIMESTAMP
);

INSERT INTO "user_sessions" (
	"id", "user_id", "refresh_token_hash", "expires_at"
) VALUES (
	'30000000-0000-4000-8000-000000000001',
	'campaign-rehearsal-admin',
	'not-a-real-refresh-token-hash',
	CURRENT_TIMESTAMP + INTERVAL '1 day'
);

INSERT INTO "mailing_campaigns" (
	"id", "admin_id", "idempotency_key", "subject", "message",
	"audience", "requested_channel", "status", "recipient_count",
	"sent_count", "failed_count", "email_recipient_count",
	"telegram_recipient_count", "started_at", "completed_at", "updated_at"
) VALUES
(
	'10000000-0000-4000-8000-000000000001',
	'campaign-rehearsal-admin',
	'11000000-0000-4000-8000-000000000001',
	'Email rehearsal',
	'Completed email campaign',
	'ALL',
	'EMAIL',
	'COMPLETED',
	1,
	1,
	0,
	1,
	0,
	CURRENT_TIMESTAMP - INTERVAL '2 hours',
	CURRENT_TIMESTAMP - INTERVAL '1 hour',
	CURRENT_TIMESTAMP - INTERVAL '1 hour'
),
(
	'10000000-0000-4000-8000-000000000002',
	'campaign-rehearsal-admin',
	'11000000-0000-4000-8000-000000000002',
	'Telegram rehearsal',
	'Terminal Telegram campaign',
	'ACTIVE',
	'TELEGRAM',
	'PARTIAL_FAILED',
	1,
	0,
	1,
	0,
	1,
	CURRENT_TIMESTAMP - INTERVAL '2 hours',
	CURRENT_TIMESTAMP - INTERVAL '1 hour',
	CURRENT_TIMESTAMP - INTERVAL '1 hour'
);

INSERT INTO "mailing_deliveries" (
	"id", "campaign_id", "channel", "recipient", "status", "attempts",
	"last_error", "sent_at", "updated_at"
) VALUES
(
	'12000000-0000-4000-8000-000000000001',
	'10000000-0000-4000-8000-000000000001',
	'EMAIL',
	'rehearsal@example.test',
	'SENT',
	1,
	NULL,
	CURRENT_TIMESTAMP - INTERVAL '1 hour',
	CURRENT_TIMESTAMP - INTERVAL '1 hour'
),
(
	'12000000-0000-4000-8000-000000000002',
	'10000000-0000-4000-8000-000000000002',
	'TELEGRAM',
	'1000000001',
	'FAILED',
	3,
	'Rehearsal terminal provider failure',
	NULL,
	CURRENT_TIMESTAMP - INTERVAL '1 hour'
);

INSERT INTO "telegram_notification_channels" (
	"id", "user_id", "chat_id", "is_active", "connected_at",
	"disabled_at", "updated_at"
) VALUES (
	'campaign-rehearsal-telegram-channel',
	'campaign-rehearsal-admin',
	'1000000001',
	false,
	CURRENT_TIMESTAMP - INTERVAL '2 hours',
	CURRENT_TIMESTAMP - INTERVAL '50 minutes',
	CURRENT_TIMESTAMP - INTERVAL '50 minutes'
);

INSERT INTO "integration_delivery_failures" (
	"id", "event_id", "integration", "routing_key", "payload",
	"attempts", "last_error", "category", "normalized_code",
	"safe_reason", "http_status", "retryable", "classification_version",
	"first_failed_at", "failed_at", "updated_at"
) VALUES (
	'40000000-0000-4000-8000-000000000001',
	'41000000-0000-4000-8000-000000000001',
	'mailing-telegram',
	'mailing.telegram',
	jsonb_build_object(
		'campaignId', '10000000-0000-4000-8000-000000000002',
		'deliveryId', '12000000-0000-4000-8000-000000000002'
	),
	1,
	'Bad Request: unsupported parse_mode',
	'PERMANENT',
	'TELEGRAM_INVALID_MESSAGE',
	'Unsupported Telegram parse mode',
	400,
	false,
	1,
	CURRENT_TIMESTAMP - INTERVAL '45 minutes',
	CURRENT_TIMESTAMP - INTERVAL '40 minutes',
	CURRENT_TIMESTAMP - INTERVAL '40 minutes'
);
SQL
	docker run --rm -i --network host \
		-e "PGPASSWORD=$NOTIFICATION_ADMIN_PASSWORD" \
		"$POSTGRES_IMAGE" \
		psql --no-psqlrc --set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port "$NOTIFICATION_PORT" \
			--username winwidget_notification_delivery_admin \
			--dbname winwidget_notification_delivery <<'SQL'
INSERT INTO notification_delivery.delivery_failures (
	"id", "event_id", "consumer", "routing_key", "payload", "headers",
	"attempts", "last_error", "category", "normalized_code",
	"safe_reason", "http_status", "provider_code", "retryable",
	"classification_version", "first_failed_at", "failed_at", "updated_at"
) VALUES (
	'42000000-0000-4000-8000-000000000001',
	'43000000-0000-4000-8000-000000000001',
	'campaign-telegram',
	'campaign.delivery.telegram',
	'{"destination":{"telegramChatId":"1000000001"}}'::jsonb,
	'{}'::jsonb,
	1,
	'Forbidden: bot was blocked by the user',
	'PERMANENT',
	'TELEGRAM_BOT_BLOCKED',
	'Telegram bot was blocked',
	403,
	'bot_blocked',
	false,
	1,
	CURRENT_TIMESTAMP - INTERVAL '25 minutes',
	CURRENT_TIMESTAMP - INTERVAL '20 minutes',
	CURRENT_TIMESTAMP - INTERVAL '20 minutes'
);
SQL
	assert_rehearsal_database_role_boundaries
}

provision_rabbitmq_users() {
	local rabbitmq_container
	rabbitmq_container="$(compose_target ps -q rabbitmq)"
	local user password
	while IFS=$'\t' read -r user password; do
		docker exec "$rabbitmq_container" rabbitmqctl add_user "$user" "$password"
		docker exec "$rabbitmq_container" rabbitmqctl set_permissions \
			-p winwidget "$user" '.*' '.*' '.*'
	done <<EOF
winwidget-monitor	$RABBITMQ_MONITOR_PASSWORD
winwidget-publisher	$RABBITMQ_PUBLISHER_PASSWORD
winwidget-integration	$RABBITMQ_INTEGRATION_PASSWORD
winwidget-maintenance	$RABBITMQ_MAINTENANCE_PASSWORD
winwidget-notification-delivery	$RABBITMQ_NOTIFICATION_PASSWORD
winwidget-campaigns	$RABBITMQ_CAMPAIGNS_PASSWORD
EOF
	docker exec "$rabbitmq_container" rabbitmqctl set_user_tags \
		winwidget-monitor monitoring
}

start_baseline_runtime() {
	APP_VERSION="$BASELINE_TAG" \
	APP_REVISION="$BASELINE_REVISION" \
	MAINTENANCE_REVISION="$BASELINE_REVISION" \
	MAINTENANCE_IMAGE="winwidget-maintenance:$BASELINE_TAG" \
	NOTIFICATION_DELIVERY_REVISION="$BASELINE_REVISION" \
	NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:$BASELINE_TAG" \
	GATEWAY_ROUTES_JSON="$LEGACY_GATEWAY_ROUTES" \
	INTEGRATION_WORKER_KINDS="$LEGACY_INTEGRATION_KINDS" \
		compose_baseline up -d --no-build \
			rabbitmq \
			outbox-publisher
	local attempt rabbitmq_container queue_names
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running baseline RabbitMQ container is required."
	for ((attempt = 1; attempt <= 90; attempt++)); do
		queue_names="$(
			docker exec "$rabbitmq_container" \
				rabbitmqctl list_queues -p winwidget name \
				--no-table-headers 2>/dev/null ||
				true
		)"
		if grep -Fxq \
			'winwidget.maintenance.database-backup' \
			<<<"$queue_names"; then
			break
		fi
		if ((attempt == 90)); then
			docker logs --tail 100 \
				"$(compose_target ps -q outbox-publisher)" >&2 ||
				true
			fail "Baseline RabbitMQ topology did not become ready."
		fi
		sleep 1
	done
	APP_VERSION="$BASELINE_TAG" \
	APP_REVISION="$BASELINE_REVISION" \
	MAINTENANCE_REVISION="$BASELINE_REVISION" \
	MAINTENANCE_IMAGE="winwidget-maintenance:$BASELINE_TAG" \
	NOTIFICATION_DELIVERY_REVISION="$BASELINE_REVISION" \
	NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:$BASELINE_TAG" \
	GATEWAY_ROUTES_JSON="$LEGACY_GATEWAY_ROUTES" \
	INTEGRATION_WORKER_KINDS="$LEGACY_INTEGRATION_KINDS" \
		compose_baseline up -d --no-build \
			integration-worker \
			maintenance-worker \
			notification-delivery-worker \
			api \
			api-gateway
	wait_for_revision \
		http://127.0.0.1:4200/api/v1/health/ready \
		"$BASELINE_REVISION"
	wait_for_url_ok http://127.0.0.1:4100/health/ready
	[[ "$(
		docker image inspect "winwidget-api-gateway:$BASELINE_TAG" \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
	)" == "$BASELINE_REVISION" ]] ||
		fail "Baseline API Gateway image revision is invalid."
	wait_for_revision http://127.0.0.1:4300/health/ready "$BASELINE_REVISION"
	wait_for_revision http://127.0.0.1:4401/health/ready "$BASELINE_REVISION"
}

baseline_runtime_identity() {
	local service container_id
	for service in \
		api \
		api-gateway \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		rabbitmq \
		notification-delivery-postgres; do
		container_id="$(compose_target ps -q "$service")"
		[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
			fail "Exactly one baseline $service container is required."
		printf '%s=%s|%s|%s\n' \
			"$service" \
			"$container_id" \
			"$(docker inspect --format '{{.RestartCount}}' "$container_id")" \
			"$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
	done
}

stage_first_cutover_revision() {
	local identity_before identity_after staged_marker
	staged_marker="$APP_ROOT/deploy/backend/.campaigns-first-cutover-staged-v1"
	[[ ! -e "$staged_marker" && ! -L "$staged_marker" ]] ||
		fail "Campaigns staged marker exists before the staged-only deployment."
	! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
		fail "Campaigns volume exists before the staged-only deployment."
	identity_before="$(baseline_runtime_identity)"

	APP_ROOT="$APP_ROOT" \
	ENV_FILE="$ENV_FILE" \
	COMPOSE_FILE="$COMPOSE_FILE" \
	EXPECTED_REVISION="$TARGET_REVISION" \
	CAMPAIGNS_AUTOMATIC_PROD_PUSH=true \
		bash "$SERVER_ROOT/scripts/deploy-production.sh" \
			>"$APP_ROOT/stage-first-cutover-revision.log" 2>&1

	grep -Fq \
		"Campaigns first-cutover revision $TARGET_REVISION is staged on the VPS." \
		"$APP_ROOT/stage-first-cutover-revision.log" ||
		fail "Production deployment did not report the staged-only Campaigns path."
	APP_ROOT="$APP_ROOT" \
		bash "$SERVER_ROOT/scripts/campaigns-database-lifecycle.sh" \
			--require-staged-revision "$TARGET_REVISION"
	[[ -f "$staged_marker" && ! -L "$staged_marker" ]] ||
		fail "Campaigns staged marker is missing after the staged-only deployment."
	[[ "$(stat -c '%u:%a' "$staged_marker")" == "0:600" ]] ||
		fail "Campaigns staged marker must remain root-owned mode 600."
	! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
		fail "Staged-only deployment created the Campaigns volume."
	[[ -z "$(compose_target ps -q campaigns-postgres)" &&
		-z "$(compose_target ps -q campaigns-service)" ]] ||
		fail "Staged-only deployment started a Campaigns container."
	assert_revision_image_tags_absent "$TARGET_REVISION"
	identity_after="$(baseline_runtime_identity)"
	[[ "$identity_after" == "$identity_before" ]] ||
		fail "Staged-only deployment restarted the baseline runtime."
}

create_rehearsal_access_token() {
	local private_key token
	[[ "$(grep -c '^JWT_ACCESS_PRIVATE_KEY_BASE64=' "$ENV_FILE")" == "1" ]] ||
		fail "The rehearsal access-token private key is missing or duplicated."
	private_key="$(sed -n 's/^JWT_ACCESS_PRIVATE_KEY_BASE64=//p' "$ENV_FILE")"
	[[ -n "$private_key" ]] ||
		fail "The rehearsal access-token private key is empty."
	token="$(
		printf '%s' "$private_key" |
			docker run --rm -i --network none \
				--entrypoint node "winwidget-api:git-$TARGET_REVISION" -e '
const { readFileSync } = require("node:fs");
const { createSign, randomUUID } = require("node:crypto");
const privateKey = Buffer.from(
  readFileSync(0, "utf8").trim(),
  "base64",
).toString("utf8");
const issuedAt = Math.floor(Date.now() / 1000);
const encode = value =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const protectedHeader = encode({
  alg: "RS256",
  typ: "at+jwt",
  kid: "campaigns-rehearsal",
});
const payload = encode({
    iss: "http://127.0.0.1:4200/auth",
    aud: "http://127.0.0.1:4200",
    sub: "campaign-rehearsal-admin",
    sid: "30000000-0000-4000-8000-000000000001",
    roles: ["ADMIN", "DEV"],
    token_use: "access",
    jti: randomUUID(),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 900,
});
const signingInput = `${protectedHeader}.${payload}`;
const signature = createSign("RSA-SHA256")
  .update(signingInput)
  .end()
  .sign(privateKey)
  .toString("base64url");
process.stdout.write(`${signingInput}.${signature}`);
'
	)" || fail "Could not issue the isolated rehearsal access token."
	[[ -n "$token" && ${#token} -le 16384 &&
		"$token" != *[[:space:]]* && "$token" == *.*.* ]] ||
		fail "The isolated rehearsal access token is invalid."
	printf '%s' "$token"
}

run_cutover() {
	local action="$1"
	local failure_phase="${2:-}"
	local log_file="$APP_ROOT/$action-${failure_phase:-resume}.log"
	local gateway_write_token=""
	if [[ "$failure_phase" == "gateway-exposed" ]]; then
		gateway_write_token="$(create_rehearsal_access_token)"
	fi
	APP_ROOT="$APP_ROOT" \
	ENV_FILE="$ENV_FILE" \
	COMPOSE_FILE="$COMPOSE_FILE" \
	EXPECTED_REVISION="$TARGET_REVISION" \
	CAMPAIGNS_CUTOVER_HEALTHCHECK_ATTEMPTS=90 \
	CAMPAIGNS_CUTOVER_HEALTHCHECK_INTERVAL=1 \
	CAMPAIGNS_CUTOVER_REHEARSAL=true \
	CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID="$RUN_ID" \
	CAMPAIGNS_CUTOVER_REHEARSAL_FAIL_AFTER_PHASE="$failure_phase" \
	CAMPAIGNS_CUTOVER_REHEARSAL_GATEWAY_WRITE_TOKEN="$gateway_write_token" \
		bash "$SERVER_ROOT/scripts/cutover-campaigns-database-production.sh" \
			"$action" >"$log_file" 2>&1
}

restart_cutover_attempt() {
	local previous_generation="$1"
	local archived_cutover archived_staged checkpoint final_receipt log_file
	local final_receipt_sha previous_artifact_directory restart_receipt
	local staged_marker staged_marker_sha status
	previous_artifact_directory="$(marker_value artifact_directory)"
	archived_cutover="$previous_artifact_directory/restart-cutover-marker"
	archived_staged="$previous_artifact_directory/restart-staged-marker"
	final_receipt="$previous_artifact_directory/restart-receipt-final"
	restart_receipt="$APP_ROOT/deploy/backend/.campaigns-database-restart-v1"
	staged_marker="$APP_ROOT/deploy/backend/.campaigns-first-cutover-staged-v1"

	for checkpoint in \
		archived-cutover-marker \
		target-volume-removed \
		next-checkout \
		next-marker-staged \
		old-marker-removed \
		final-receipt; do
		log_file="$APP_ROOT/restart-cutover-$checkpoint.log"
		set +e
		APP_ROOT="$APP_ROOT" \
		ENV_FILE="$ENV_FILE" \
		COMPOSE_FILE="$COMPOSE_FILE" \
		EXPECTED_NEXT_REVISION="$TARGET_REVISION" \
		CAMPAIGNS_CUTOVER_REHEARSAL=true \
		CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID="$RUN_ID" \
		CAMPAIGNS_RESTART_REHEARSAL_FAIL_AFTER_CHECKPOINT="$checkpoint" \
			bash "$SERVER_ROOT/scripts/restart-campaigns-database-cutover-production.sh" \
				>"$log_file" 2>&1
		status=$?
		set -e
		[[ "$status" == "86" ]] ||
			fail "Campaigns restart checkpoint $checkpoint returned status $status."
		grep -Fq \
			"Campaigns restart rehearsal injected a failure at checkpoint=$checkpoint." \
			"$log_file" ||
			fail "Campaigns restart checkpoint $checkpoint was not reached."

		case "$checkpoint" in
		archived-cutover-marker)
			[[ -f "$MARKER_FILE" && -f "$staged_marker" &&
				-f "$archived_cutover" && ! -e "$archived_staged" &&
				! -e "$restart_receipt" ]] ||
				fail "Campaigns partial marker archive is not safely resumable."
			docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
				fail "Campaigns restart removed the target before durable validation."
			;;
		target-volume-removed)
			[[ "$(awk -F= '$1 == "status" { print $2 }' "$restart_receipt")" == \
				"validated" &&
				-f "$MARKER_FILE" && -f "$staged_marker" &&
				-f "$archived_cutover" && -f "$archived_staged" ]] ||
				fail "Campaigns target removal lost its validated restart receipt."
			! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
				fail "Campaigns target volume remains after the removal checkpoint."
			[[ -z "$(compose_target ps -a -q campaigns-postgres)" &&
				-z "$(compose_target ps -a -q campaigns-service)" ]] ||
				fail "Campaigns target container remains after the removal checkpoint."
			;;
		next-checkout)
			[[ "$(awk -F= '$1 == "status" { print $2 }' "$restart_receipt")" == \
				"target-removed" &&
				-f "$MARKER_FILE" && ! -e "$staged_marker" ]] ||
				fail "Campaigns next checkout checkpoint has an invalid marker state."
			;;
		next-marker-staged)
			[[ "$(awk -F= '$1 == "status" { print $2 }' "$restart_receipt")" == \
				"target-removed" &&
				-f "$MARKER_FILE" && -f "$staged_marker" &&
				"$(awk -F= '$1 == "switch_generation_seed" { print $2 }' \
					"$staged_marker")" == "$previous_generation" ]] ||
				fail "Campaigns next staged marker is not resumable."
			;;
		old-marker-removed)
			[[ "$(awk -F= '$1 == "status" { print $2 }' "$restart_receipt")" == \
				"new-staged" &&
				! -e "$MARKER_FILE" && -f "$staged_marker" ]] ||
				fail "Campaigns old marker removal is not resumable."
			;;
		final-receipt)
			[[ "$(awk -F= '$1 == "status" { print $2 }' "$restart_receipt")" == \
				"staged" &&
				-f "$final_receipt" ]] ||
				fail "Campaigns final restart receipt is not resumable."
			cmp -s "$restart_receipt" "$final_receipt" ||
				fail "Campaigns final restart receipt content changed."
			;;
		esac
	done

	APP_ROOT="$APP_ROOT" \
	ENV_FILE="$ENV_FILE" \
	COMPOSE_FILE="$COMPOSE_FILE" \
	EXPECTED_NEXT_REVISION="$TARGET_REVISION" \
	CAMPAIGNS_CUTOVER_REHEARSAL=true \
	CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID="$RUN_ID" \
		bash "$SERVER_ROOT/scripts/restart-campaigns-database-cutover-production.sh" \
			>"$APP_ROOT/restart-cutover-complete.log" 2>&1
	grep -Fq "was safely restarted for revision $TARGET_REVISION." \
		"$APP_ROOT/restart-cutover-complete.log" ||
		fail "Campaigns restart did not report its completed transition."
	final_receipt_sha="$(sha256sum "$final_receipt" | awk '{ print $1 }')"
	staged_marker_sha="$(sha256sum "$staged_marker" | awk '{ print $1 }')"

	APP_ROOT="$APP_ROOT" \
	ENV_FILE="$ENV_FILE" \
	COMPOSE_FILE="$COMPOSE_FILE" \
	EXPECTED_NEXT_REVISION="$TARGET_REVISION" \
	CAMPAIGNS_CUTOVER_REHEARSAL=true \
	CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID="$RUN_ID" \
		bash "$SERVER_ROOT/scripts/restart-campaigns-database-cutover-production.sh" \
			>"$APP_ROOT/restart-cutover-idempotent-repeat.log" 2>&1
	grep -Fq "Campaigns restart is already complete and ready for prepare." \
		"$APP_ROOT/restart-cutover-idempotent-repeat.log" ||
		fail "Campaigns completed restart was not idempotent."
	[[ "$(sha256sum "$final_receipt" | awk '{ print $1 }')" == \
			"$final_receipt_sha" &&
		"$(sha256sum "$staged_marker" | awk '{ print $1 }')" == \
			"$staged_marker_sha" ]] ||
		fail "Campaigns idempotent restart changed durable evidence."

	[[ ! -e "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] ||
		fail "Campaigns restart retained the abandoned cutover marker."
	[[ ! -e "$restart_receipt" && ! -L "$restart_receipt" ]] ||
		fail "Campaigns restart retained its active receipt after completion."
	APP_ROOT="$APP_ROOT" \
		bash "$SERVER_ROOT/scripts/campaigns-database-lifecycle.sh" \
			--require-staged-revision "$TARGET_REVISION"
	[[ "$(
		awk -F= '$1 == "switch_generation_seed" { print $2 }' \
			"$APP_ROOT/deploy/backend/.campaigns-first-cutover-staged-v1"
	)" == "$previous_generation" ]] ||
		fail "Campaigns restart did not preserve the switch generation seed."
	! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
		fail "Campaigns restart retained the abandoned target volume."
	[[ -z "$(compose_target ps -a -q campaigns-postgres)" &&
		-z "$(compose_target ps -a -q campaigns-service)" ]] ||
		fail "Campaigns restart retained an abandoned target container."
	[[ -f "$final_receipt" && ! -L "$final_receipt" &&
		"$(stat -c '%u:%g:%a' "$final_receipt")" == "0:0:600" ]] ||
		fail "Campaigns restart did not retain a safe audit receipt."
	[[ -f "$previous_artifact_directory/restart-cutover-marker" &&
		-f "$previous_artifact_directory/restart-staged-marker" ]] ||
		fail "Campaigns restart did not archive the abandoned markers."

	CAMPAIGNS_VOLUME_IDENTITY=""
	CAMPAIGNS_SYSTEM_IDENTIFIER=""
	rm -f -- "$CAMPAIGNS_VOLUME_IDENTITY_FILE"
	assert_baseline_runtime
}

campaigns_query() {
	local sql="$1"
	docker run --rm --network host \
		-e "PGPASSWORD=$CAMPAIGNS_MIGRATION_PASSWORD" \
		"$POSTGRES_IMAGE" \
		psql --no-psqlrc --tuples-only --no-align \
			--set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port "$CAMPAIGNS_PORT" \
			--username winwidget_campaigns_migration \
			--dbname winwidget_campaigns \
			--command "$sql"
}

core_query() {
	local sql="$1"
	docker run --rm --network host \
		-e "PGPASSWORD=$CORE_ADMIN_PASSWORD" \
		"$POSTGRES_IMAGE" \
		psql --no-psqlrc --tuples-only --no-align \
			--set ON_ERROR_STOP=1 \
			--host 127.0.0.1 --port "$CORE_PORT" \
			--username "$CORE_ADMIN_USER" --dbname winwidget \
			--command "$sql"
}

rehearsal_rollback_target_queue_names() {
	local base
	for base in \
		winwidget.campaigns.snapshot \
		winwidget.campaigns.delivery-outcome.v2; do
		printf '%s\n' \
			"$base" \
			"$base.dead-letter" \
			"$base.retry.1" \
			"$base.retry.2" \
			"$base.retry.3"
	done
	for base in \
		winwidget.admin.audit.campaigns.v1 \
		winwidget.notification.campaign.email.v2 \
		winwidget.notification.campaign.telegram.v2; do
		printf '%s\n' \
			"$base" \
			"$base.dead-letter" \
			"$base.retry-v2.1" \
			"$base.retry-v2.2" \
			"$base.retry-v2.3"
	done
}

assert_rollback_target_queues_absent() {
	local rabbitmq_container queue_names queue
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	queue_names="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p winwidget name
	)" || fail "Could not inspect RabbitMQ queues after Campaigns recovery."
	while IFS= read -r queue; do
		! grep -Fxq -- "$queue" <<<"$queue_names" ||
			fail "Rollback-owned Campaigns queue survived recovery: $queue"
	done < <(rehearsal_rollback_target_queue_names)
}

set_rehearsal_env_value() {
	local key="$1"
	local value="$2"
	local temporary="$ENV_FILE.tmp.$$"
	[[ "$key" =~ ^[A-Z][A-Z0-9_]*$ &&
		"$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
		fail "Unsafe rehearsal environment update."
	awk -F= -v key="$key" -v value="$value" '
		$1 == key {
			print key "=" value
			found += 1
			next
		}
		{ print }
		END { exit(found == 1 ? 0 : 1) }
	' "$ENV_FILE" >"$temporary" ||
		fail "Could not update exact rehearsal environment key: $key"
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$ENV_FILE"
}

mount_audit_canonical_root() {
	local artifact_directory canonical_artifact_directory temporary_overlay
	[[ ! -e "$AUDIT_CANONICAL_ROOT" && ! -L "$AUDIT_CANONICAL_ROOT" ]] ||
		fail "Canonical audit bind target is not empty."
	[[ ! -e "$AUDIT_MARKER_OVERLAY" && ! -L "$AUDIT_MARKER_OVERLAY" ]] ||
		fail "Canonical audit marker overlay already exists."
	artifact_directory="$(marker_value artifact_directory)"
	[[ "$artifact_directory" == "$APP_ROOT"/deploy/backend/campaigns-database-cutover.* &&
		-d "$artifact_directory" && ! -L "$artifact_directory" ]] ||
		fail "Rehearsal marker artifact directory is unsafe."
	canonical_artifact_directory="$AUDIT_CANONICAL_ROOT/${artifact_directory#"$APP_ROOT"/}"
	temporary_overlay="$AUDIT_MARKER_OVERLAY.tmp.$$"
	awk -F= -v canonical="$canonical_artifact_directory" '
		$1 == "artifact_directory" {
			print "artifact_directory=" canonical
			found += 1
			next
		}
		{ print }
		END { exit(found == 1 ? 0 : 1) }
	' "$MARKER_FILE" >"$temporary_overlay" ||
		fail "Could not create the canonical audit marker overlay."
	chown 0:0 "$temporary_overlay"
	chmod 600 "$temporary_overlay"
	mv -f "$temporary_overlay" "$AUDIT_MARKER_OVERLAY"
	install -d -o 0 -g 0 -m 700 "$AUDIT_CANONICAL_ROOT"
	install -o 0 -g 0 -m 600 /dev/null "$AUDIT_BIND_MARKER"
	printf '%s\n' "$RUN_ID" >"$AUDIT_BIND_MARKER"
	if ! mount --bind "$APP_ROOT" "$AUDIT_CANONICAL_ROOT"; then
		rm -f -- "$AUDIT_BIND_MARKER"
		rm -f -- "$AUDIT_MARKER_OVERLAY"
		rmdir -- "$AUDIT_CANONICAL_ROOT"
		fail "Could not bind the rehearsal root to the canonical audit path."
	fi
	if ! mount --bind \
		"$AUDIT_MARKER_OVERLAY" \
		"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-database-cutover-v1"; then
		umount "$AUDIT_CANONICAL_ROOT"
		rm -f -- "$AUDIT_BIND_MARKER" "$AUDIT_MARKER_OVERLAY"
		rmdir -- "$AUDIT_CANONICAL_ROOT"
		fail "Could not bind the canonical audit marker overlay."
	fi
	[[ "$(stat -c '%d:%i' "$AUDIT_CANONICAL_ROOT")" == \
			"$(stat -c '%d:%i' "$APP_ROOT")" &&
		"$(stat -c '%d:%i' \
			"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-database-cutover-v1")" == \
			"$(stat -c '%d:%i' "$AUDIT_MARKER_OVERLAY")" &&
		"$(<"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-rehearsal-audit-bind")" == \
			"$RUN_ID" ]] ||
		fail "Canonical audit bind identity is invalid."
}

unmount_audit_canonical_root() {
	if [[ ! -e "$AUDIT_BIND_MARKER" &&
		! -e "$AUDIT_MARKER_OVERLAY" &&
		! -e "$AUDIT_CANONICAL_ROOT" &&
		! -L "$AUDIT_CANONICAL_ROOT" ]]; then
		return 0
	fi
	[[ -f "$AUDIT_BIND_MARKER" && ! -L "$AUDIT_BIND_MARKER" &&
		"$(<"$AUDIT_BIND_MARKER")" == "$RUN_ID" ]] || {
		echo "Refusing to remove an unowned canonical audit bind." >&2
		return 1
	}
	if mountpoint -q "$AUDIT_CANONICAL_ROOT"; then
		if mountpoint -q \
			"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-database-cutover-v1"; then
			[[ -f "$AUDIT_MARKER_OVERLAY" &&
				! -L "$AUDIT_MARKER_OVERLAY" &&
				"$(stat -c '%u:%g:%a' "$AUDIT_MARKER_OVERLAY")" == "0:0:600" &&
				"$(stat -c '%d:%i' \
					"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-database-cutover-v1")" == \
					"$(stat -c '%d:%i' "$AUDIT_MARKER_OVERLAY")" ]] || {
				echo "Canonical audit marker overlay identity changed." >&2
				return 1
			}
			umount \
				"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-database-cutover-v1" ||
				return 1
		fi
		[[ "$(stat -c '%d:%i' "$AUDIT_CANONICAL_ROOT")" == \
			"$(stat -c '%d:%i' "$APP_ROOT")" &&
			"$(<"$AUDIT_CANONICAL_ROOT/deploy/backend/.campaigns-rehearsal-audit-bind")" == \
			"$RUN_ID" ]] || {
			echo "Canonical audit mount identity changed." >&2
			return 1
		}
		umount "$AUDIT_CANONICAL_ROOT" || return 1
	fi
	[[ -d "$AUDIT_CANONICAL_ROOT" && ! -L "$AUDIT_CANONICAL_ROOT" &&
		-z "$(find "$AUDIT_CANONICAL_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
		return 1
	rmdir -- "$AUDIT_CANONICAL_ROOT" || return 1
	rm -f -- "$AUDIT_BIND_MARKER" "$AUDIT_MARKER_OVERLAY"
}

run_telegram_audit_fixture() {
	local audit_log audit_status artifact_canonical artifact_directory
	local canonical_reference canonical_reference_body rehearsal_reference
	local audit_manifest_sha256
	local switch_generation evidence_prefix audit_decision
	switch_generation="$(marker_value switch_generation)"
	[[ "$switch_generation" =~ ^[1-9][0-9]*$ ]] ||
		fail "Legacy Telegram fixture requires a positive switch generation."
	evidence_prefix="switch-generation:${switch_generation}:"
	mount_audit_canonical_root
	audit_log="$APP_ROOT/telegram-audit-fixture-generation-$switch_generation.log"
	set +e
	env -u APP_ROOT -u ENV_FILE \
		EXPECTED_REVISION="$TARGET_REVISION" \
		bash "$AUDIT_CANONICAL_ROOT/winwidget.ru_server/scripts/audit-legacy-telegram-channels-production.sh" \
			>"$audit_log" 2>&1
	audit_status=$?
	set -e
	if ((audit_status != 0)); then
		tail -n 160 "$audit_log" >&2 || true
		fail "Legacy Telegram fixture audit failed with status $audit_status."
	fi
	artifact_canonical="$(
		sed -n 's/^Artifacts: //p' "$audit_log"
	)"
	canonical_reference="$(
		sed -n 's/^CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE=//p' "$audit_log"
	)"
	audit_decision="$(
		sed -n 's/^CAMPAIGNS_TELEGRAM_AUDIT_DECISION=//p' "$audit_log"
	)"
	canonical_reference_body="${canonical_reference#"$evidence_prefix"}"
	audit_manifest_sha256="${canonical_reference_body##*@sha256:}"
	[[ "$artifact_canonical" == "$AUDIT_CANONICAL_ROOT"/deploy/backend/campaigns-telegram-audit.* &&
		"$audit_decision" == "completed" &&
		"$canonical_reference" == "$evidence_prefix"* &&
		"$canonical_reference_body" == "$artifact_canonical"/SHA256SUMS@sha256:* &&
		"$audit_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		fail "Legacy Telegram audit did not report canonical artifacts."
	artifact_directory="$APP_ROOT/${artifact_canonical#"$AUDIT_CANONICAL_ROOT"/}"
	rehearsal_reference="${evidence_prefix}${APP_ROOT}/${canonical_reference_body#"$AUDIT_CANONICAL_ROOT"/}"
	[[ -d "$artifact_directory" && ! -L "$artifact_directory" ]] ||
		fail "Legacy Telegram audit artifact directory is missing."
	(
		cd "$artifact_directory"
		sha256sum --check SHA256SUMS
	) >/dev/null
	grep -Fxq 'status,completed_candidates_left_disabled' \
		"$artifact_directory/10-summary.csv" ||
		fail "Legacy Telegram fixture audit status is unexpected."
	grep -Fxq 'candidate_channel_count,1' \
		"$artifact_directory/10-summary.csv" ||
		fail "Legacy Telegram fixture candidate count is unexpected."
	grep -Fxq \
		'candidate_channel_with_later_permanent_evidence_count,1' \
		"$artifact_directory/10-summary.csv" ||
		fail "Legacy Telegram fixture correlation evidence is incomplete."
	if grep -R -Fq '1000000001' "$artifact_directory"; then
		fail "Legacy Telegram audit leaked a raw chat identifier."
	fi
	set_rehearsal_env_value CAMPAIGNS_TELEGRAM_AUDIT_DECISION completed
	set_rehearsal_env_value \
		CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE "$rehearsal_reference"
	unmount_audit_canonical_root ||
		fail "Could not remove the canonical audit bind after fixture audit."
}

assert_container_revision() {
	local service="$1"
	local expected_revision="$2"
	local expected_image="$3"
	local container_id image_id revision restart_count
	container_id="$(compose_target ps --status running -q "$service")"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
		fail "Exactly one running $service container is required."
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	revision="$(
		docker image inspect "$image_id" \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
	)"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	[[ "$image_id" == "$(docker image inspect "$expected_image" --format '{{.Id}}')" &&
		"$revision" == "$expected_revision" &&
		"$restart_count" == "0" ]] ||
		fail "$service runtime identity is invalid."
}

assert_campaigns_postgres_identity() {
	local postgres_id system_identifier marker_image_id
	postgres_id="$(compose_target ps --status running -q campaigns-postgres)"
	[[ -n "$postgres_id" && "$postgres_id" != *$'\n'* ]] ||
		fail "Exactly one running Campaigns PostgreSQL container is required."
	wait_for_container_health "$postgres_id"
	system_identifier="$(
		docker exec "$postgres_id" psql --tuples-only --no-align \
			--username winwidget_campaigns_admin \
			--dbname winwidget_campaigns \
			--command 'SELECT system_identifier FROM pg_control_system();'
	)"
	[[ "$system_identifier" =~ ^[0-9]+$ ]] ||
		fail "Campaigns PostgreSQL system identifier is invalid."
	marker_image_id="$(marker_value postgres_image_id)"
	[[ "$(docker inspect --format '{{.Image}}' "$postgres_id")" == "$marker_image_id" &&
		"$system_identifier" == "$(marker_value postgres_system_identifier)" ]] ||
		fail "Campaigns PostgreSQL identity differs from the durable marker."
	if [[ -z "$CAMPAIGNS_SYSTEM_IDENTIFIER" ]]; then
		CAMPAIGNS_SYSTEM_IDENTIFIER="$system_identifier"
	else
		[[ "$system_identifier" == "$CAMPAIGNS_SYSTEM_IDENTIFIER" ]] ||
			fail "Campaigns PostgreSQL system identifier changed."
	fi
	assert_campaigns_volume_unchanged
}

assert_campaigns_rabbitmq_ownership() {
	local attempt
	for ((attempt = 1; attempt <= 30; attempt++)); do
		if docker run --rm --network host \
			-e 'RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:15672' \
			-e 'RABBITMQ_VHOST=winwidget' \
			-e 'RABBITMQ_ADMIN_USER=winwidget-admin' \
			-e "RABBITMQ_ADMIN_PASSWORD=$RABBITMQ_ADMIN_PASSWORD" \
			-e 'EXPECTED_CAMPAIGNS_USER=winwidget-campaigns' \
			--entrypoint node "winwidget-api:git-$TARGET_REVISION" -e '
const baseUrl = process.env.RABBITMQ_MANAGEMENT_URL;
const vhost = process.env.RABBITMQ_VHOST;
const auth = `Basic ${Buffer.from(
  `${process.env.RABBITMQ_ADMIN_USER}:${process.env.RABBITMQ_ADMIN_PASSWORD}`,
).toString("base64")}`;
const request = async path => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const run = async () => {
  const connections = await request("/api/connections");
  const bySocket = new Map(connections.map(value => [value.name, value]));
  for (const base of [
    "winwidget.campaigns.snapshot",
    "winwidget.campaigns.delivery-outcome.v2",
  ]) {
    const queue = await request(
      `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(base)}`,
    );
    const consumers = queue.consumer_details ?? [];
    if (consumers.length !== 1) throw new Error(`${base}: consumer count`);
    const connection = bySocket.get(
      consumers[0]?.channel_details?.connection_name,
    );
    if (
      connection?.user !== process.env.EXPECTED_CAMPAIGNS_USER ||
      connection?.client_properties?.connection_name !==
        "winwidget-campaigns-service"
    ) throw new Error(`${base}: owner`);
    for (const suffix of [
      ".dead-letter",
      ".retry.1",
      ".retry.2",
      ".retry.3",
    ]) {
      const parking = await request(
        `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(
          `${base}${suffix}`,
        )}`,
      );
      if ((parking.consumer_details ?? []).length !== 0) {
        throw new Error(`${base}${suffix}: unexpected consumer`);
      }
    }
  }
};
run().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
' >/dev/null 2>&1; then
			return
		fi
		sleep 1
	done
	fail "Campaigns RabbitMQ exact consumer ownership did not stabilize."
}

assert_legacy_runtime_restored() {
	local gateway_id integration_id kinds
	gateway_id="$(compose_target ps --status running -q api-gateway)"
	integration_id="$(compose_target ps --status running -q integration-worker)"
	[[ -n "$gateway_id" && -n "$integration_id" ]] ||
		fail "Legacy runtime containers were not restored."
	[[ "$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$gateway_id" |
			sed -n 's/^GATEWAY_ROUTES_JSON=//p'
	)" == "$LEGACY_GATEWAY_ROUTES" ]] ||
		fail "Legacy Gateway route was not restored."
	kinds="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$integration_id" |
			sed -n 's/^INTEGRATION_WORKER_KINDS=//p'
	)"
	[[ ",$kinds," == *",mailing-email,"* &&
		",$kinds," == *",mailing-telegram,"* ]] ||
		fail "Legacy mailing handlers were not restored."
	[[ -z "$(compose_target ps --status running -q campaigns-service)" ]] ||
		fail "Campaigns service remained running after pre-forward rollback."
}

assert_baseline_runtime() {
	wait_for_revision \
		http://127.0.0.1:4200/api/v1/health/ready \
		"$BASELINE_REVISION"
	wait_for_url_ok http://127.0.0.1:4100/health/ready
	wait_for_revision http://127.0.0.1:4300/health/ready "$BASELINE_REVISION"
	wait_for_revision http://127.0.0.1:4401/health/ready "$BASELINE_REVISION"
	assert_container_revision api "$BASELINE_REVISION" \
		"winwidget-api:$BASELINE_TAG"
	assert_container_revision outbox-publisher "$BASELINE_REVISION" \
		"winwidget-api:$BASELINE_TAG"
	assert_container_revision integration-worker "$BASELINE_REVISION" \
		"winwidget-api:$BASELINE_TAG"
	assert_container_revision api-gateway "$BASELINE_REVISION" \
		"winwidget-api-gateway:$BASELINE_TAG"
	assert_container_revision maintenance-worker "$BASELINE_REVISION" \
		"winwidget-maintenance:$BASELINE_TAG"
	assert_container_revision notification-delivery-worker "$BASELINE_REVISION" \
		"winwidget-notification-delivery:$BASELINE_TAG"
	assert_legacy_runtime_restored
}

assert_internal_audience_boundary() {
	local status export_state
	status="$(
		curl -sS -o /dev/null -w '%{http_code}' \
			-X POST \
			-H 'Content-Type: application/json' \
			--data '{"schemaVersion":1,"channel":"EMAIL","audience":"ALL"}' \
			http://127.0.0.1:4200/internal/v1/campaigns/audience-export
	)"
	[[ "$status" == "401" ]] ||
		fail "Core internal audience export accepted a missing token."
	status="$(
		curl -sS -o /dev/null -w '%{http_code}' \
			-X POST \
			-H 'Content-Type: application/json' \
			-H 'x-winwidget-internal-token: invalid-rehearsal-token' \
			--data '{"schemaVersion":1,"channel":"EMAIL","audience":"ALL"}' \
			http://127.0.0.1:4200/internal/v1/campaigns/audience-export
	)"
	[[ "$status" == "401" ]] ||
		fail "Core internal audience export accepted an invalid token."
	status="$(
		curl -sS -o /dev/null -w '%{http_code}' \
			-X POST \
			-H 'Content-Type: application/json' \
			--data '{"schemaVersion":1,"channel":"EMAIL","audience":"ALL"}' \
			http://127.0.0.1:4100/internal/v1/campaigns/audience-export
	)"
	[[ "$status" == "404" ]] ||
		fail "API Gateway published the loopback-only Campaigns API."
	export_state="$(
		curl -fsS \
			-X POST \
			-H 'Content-Type: application/json' \
			-H 'x-winwidget-internal-token: rehearsal_campaigns_internal_token_32_chars' \
			--data '{"schemaVersion":1,"channel":"EMAIL","audience":"ALL"}' \
			http://127.0.0.1:4200/internal/v1/campaigns/audience-export
	)"
	[[ "$export_state" == *'"type":"snapshot"'* &&
		"$export_state" == *'"channel":"EMAIL"'* &&
		"$export_state" == *'"audience":"ALL"'* &&
		"$export_state" == *'"type":"complete"'* ]] ||
		fail "Authorized internal audience export did not complete."
}

assert_target_runtime() {
	local campaigns_id gateway_id integration_id gateway_routes kinds role
	for service in api outbox-publisher integration-worker; do
		assert_container_revision "$service" "$TARGET_REVISION" \
			"winwidget-api:git-$TARGET_REVISION"
	done
	assert_container_revision api-gateway "$TARGET_REVISION" \
		"winwidget-api-gateway:git-$TARGET_REVISION"
	assert_container_revision maintenance-worker "$TARGET_REVISION" \
		"winwidget-maintenance:git-$TARGET_REVISION"
	assert_container_revision notification-delivery-worker "$TARGET_REVISION" \
		"winwidget-notification-delivery:git-$TARGET_REVISION"
	assert_container_revision campaigns-service "$TARGET_REVISION" \
		"winwidget-campaigns:git-$TARGET_REVISION"
	campaigns_id="$(compose_target ps --status running -q campaigns-service)"
	role="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$campaigns_id" |
			sed -n 's/^CAMPAIGNS_PROCESS_ROLE=//p'
	)"
	[[ "$role" == "all" ]] ||
		fail "Campaigns runtime process role must be all."
	gateway_id="$(compose_target ps --status running -q api-gateway)"
	gateway_routes="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$gateway_id" |
			sed -n 's/^GATEWAY_ROUTES_JSON=//p'
	)"
	[[ "$gateway_routes" == "$TARGET_GATEWAY_ROUTES" ]] ||
		fail "Target Gateway routes are invalid."
	integration_id="$(compose_target ps --status running -q integration-worker)"
	kinds="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$integration_id" |
			sed -n 's/^INTEGRATION_WORKER_KINDS=//p'
	)"
	[[ ",$kinds," != *",mailing-email,"* &&
		",$kinds," != *",mailing-telegram,"* ]] ||
		fail "Legacy mailing consumers remained enabled after switch."
	assert_campaigns_rabbitmq_ownership
	assert_campaigns_postgres_identity
	[[ "$(curl -sS -o /dev/null -w '%{http_code}' \
		http://127.0.0.1:4100/api/v1/admin/campaigns)" == "401" ]] ||
		fail "Gateway did not reject an unauthenticated Campaigns request."
	assert_internal_audience_boundary
}

assert_phase_runtime() {
	local phase="$1"
	case "$phase" in
	preflight)
		! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
			fail "Campaigns volume exists at preflight."
		assert_target_image_set
		assert_baseline_runtime
		;;
	target-created | roles-ready | migrated | source-frozen | importing | copied | verified | switching)
		assert_campaigns_postgres_identity
		assert_baseline_runtime
		if [[ "$phase" == "roles-ready" ]]; then
			[[ "$(campaigns_query "
SELECT
	(SELECT count(*) FROM pg_roles
	 WHERE rolname IN (
		'winwidget_campaigns_runtime',
		'winwidget_campaigns_migration',
		'winwidget_campaigns_backup'
	)) || '|' ||
	(SELECT pg_get_userbyid(nspowner)
	 FROM pg_namespace WHERE nspname = 'campaigns');
")" == '3|winwidget_campaigns_migration' ]] ||
				fail "Campaigns roles/schema ownership is invalid."
		fi
		if [[ "$phase" =~ ^(migrated|source-frozen|importing|copied|verified|switching)$ ]]; then
			[[ "$(campaigns_query "
SELECT
	(SELECT count(*) FROM campaigns._prisma_migrations) || '|' ||
	(SELECT count(*) FROM information_schema.tables
	 WHERE table_schema = 'campaigns' AND table_type = 'BASE TABLE');
")" == '1|10' ]] ||
				fail "Campaigns migration structure is invalid."
		fi
		if [[ "$phase" == "copied" || "$phase" == "verified" ||
			"$phase" == "switching" ]]; then
			[[ "$(campaigns_query "
SELECT
	(SELECT count(*) FROM campaigns.campaigns) || '|' ||
	(SELECT count(*) FROM campaigns.audience_snapshots) || '|' ||
	(SELECT count(*) FROM campaigns.deliveries) || '|' ||
	(SELECT count(*) FROM campaigns.campaigns
	 WHERE id = '20000000-0000-4000-8000-000000000001');
")" == '2|2|2|0' ]] ||
				fail "Campaigns copied target data is invalid."
		fi
		;;
	switched | complete)
		assert_target_runtime
		;;
	forward-only | source-dropped)
		local service
		for service in \
			api \
			api-gateway \
			outbox-publisher \
			integration-worker \
			maintenance-worker \
			notification-delivery-worker \
			campaigns-service; do
			[[ -z "$(compose_target ps --status running -q "$service")" ]] ||
				fail "$service must remain frozen during forward recovery phase=$phase."
		done
		[[ -n "$(compose_target ps --status running -q rabbitmq)" ]] ||
			fail "RabbitMQ must remain running during forward recovery."
		assert_campaigns_postgres_identity
		;;
	*)
		fail "No rehearsal runtime assertion is defined for phase=$phase."
		;;
	esac
}

inject_partial_target_import() {
	campaigns_query "
INSERT INTO campaigns.campaigns (
	id, actor_id, idempotency_key, subject, message, audience,
	requested_channel, status, updated_at
) VALUES (
	'20000000-0000-4000-8000-000000000001',
	'partial-import-rehearsal',
	'21000000-0000-4000-8000-000000000001',
	'Partial import',
	'This row must be removed before the resumed import.',
	'ALL',
	'EMAIL',
	'FAILED',
	CURRENT_TIMESTAMP
);
" >/dev/null
	[[ "$(campaigns_query \
		"SELECT count(*) FROM campaigns.campaigns;")" == "1" ]] ||
		fail "Could not stage a partial Campaigns target import."
}

mutate_legacy_source_after_copy() {
	core_query "
UPDATE mailing_campaigns
SET message = 'Completed email campaign changed after copied',
	updated_at = CURRENT_TIMESTAMP
WHERE id = '10000000-0000-4000-8000-000000000001';
" >/dev/null
	[[ "$(core_query "
SELECT message
FROM mailing_campaigns
WHERE id = '10000000-0000-4000-8000-000000000001';
")" == 'Completed email campaign changed after copied' ]] ||
		fail "Could not stage the post-copy source mutation."
}

expect_switch_runtime_failure() {
	local status
	echo "Injecting Campaigns cutover failure during target runtime switch"
	set +e
	run_cutover prepare switch-runtime-started
	status=$?
	set -e
	if ((status != 86)); then
		tail -n 120 "$APP_ROOT/prepare-switch-runtime-started.log" >&2 || true
		fail "Expected switch-runtime-started exit 86, got $status."
	fi
	[[ "$(marker_value phase)" == "switching" ]] ||
		fail "Internal switch failure did not retain the recoverable switching phase."
	assert_baseline_runtime
	assert_campaigns_postgres_identity
}

expect_gateway_exposed_failure() {
	local status
	echo "Injecting Campaigns cutover failure after the new Gateway accepted a write"
	set +e
	run_cutover prepare gateway-exposed
	status=$?
	set -e
	if ((status != 86)); then
		tail -n 160 "$APP_ROOT/prepare-gateway-exposed.log" >&2 || true
		fail "Expected gateway-exposed exit 86, got $status."
	fi
	[[ "$(marker_value phase)" == "switching" ]] ||
		fail "Gateway-exposed failure did not retain the recoverable switching phase."
	assert_baseline_runtime
	assert_campaigns_postgres_identity
	[[ "$(campaigns_query "
SELECT
	(SELECT count(*) FROM campaigns.campaigns) || '|' ||
	(SELECT count(*) FROM campaigns.campaigns
	 WHERE idempotency_key = '22000000-0000-4000-8000-000000000001');
")" == '3|1' ]] ||
		fail "The Gateway-exposed rehearsal write did not remain in target for recovery."
}

expect_switch_recovery_failure() {
	local status
	echo "Injecting Campaigns cutover failure after exact switching recovery"
	set +e
	run_cutover prepare switch-recovered
	status=$?
	set -e
	if ((status != 86)); then
		tail -n 160 "$APP_ROOT/prepare-switch-recovered.log" >&2 || true
		fail "Expected switch-recovered exit 86, got $status."
	fi
	[[ "$(marker_value phase)" == "verified" ]] ||
		fail "Switch recovery did not return the durable marker to verified."
	assert_baseline_runtime
	assert_campaigns_postgres_identity
	assert_rollback_target_queues_absent
	[[ "$(campaigns_query "
SELECT
	(SELECT count(*) FROM campaigns.campaigns) || '|' ||
	(SELECT count(*) FROM campaigns.campaigns
	 WHERE idempotency_key = '22000000-0000-4000-8000-000000000001');
")" == '2|0' ]] ||
		fail "Interrupted Gateway target state survived exact switching recovery."
}

expect_phase_failure() {
	local action="$1"
	local phase="$2"
	local status
	echo "Injecting Campaigns cutover failure after phase=$phase"
	set +e
	run_cutover "$action" "$phase"
	status=$?
	set -e
	if ((status != 86)); then
		tail -n 120 "$APP_ROOT/$action-$phase.log" >&2 || true
		fail "Expected injected phase=$phase exit 86, got $status."
	fi
	[[ "$(marker_value phase)" == "$phase" ]] ||
		fail "Marker did not retain injected phase=$phase."
	if [[ "$phase" != "preflight" ]]; then
		if [[ -z "$CAMPAIGNS_VOLUME_IDENTITY" ]]; then
			assert_rehearsal_volume_provenance "$CAMPAIGNS_VOLUME"
			[[ "$(docker volume inspect "$CAMPAIGNS_VOLUME" \
				--format '{{printf "%s|%s|%s|%s" (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.cutover.revision") (index .Labels "com.winwidget.cutover.started-at")}}')" == \
				"campaigns|postgres-data|$TARGET_REVISION|$(marker_value cutover_started_at)" ]] ||
				fail "Campaigns volume created by cutover has unexpected role labels."
			record_campaigns_volume_identity
		else
			assert_campaigns_volume_unchanged
		fi
	fi
	assert_phase_runtime "$phase"
}

test_preexisting_campaigns_volume_guard() {
	local status
	create_rehearsal_volume "$CAMPAIGNS_VOLUME" \
		--label com.winwidget.owner=campaigns \
		--label com.winwidget.purpose=postgres-data
	set +e
	run_cutover prepare
	status=$?
	set -e
	((status != 0)) ||
		fail "Campaigns prepare accepted a pre-existing volume without exact cutover provenance."
	[[ "$(marker_value phase)" == "preflight" ]] ||
		fail "Rejected pre-existing Campaigns volume changed the cutover phase."
	assert_rehearsal_volume_provenance "$CAMPAIGNS_VOLUME"
	remove_validated_volume "$CAMPAIGNS_VOLUME"
}

test_incomplete_routine_deploy_guard() {
	local status
	! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
		fail "Campaigns volume exists before target-created."
	set +e
	APP_ROOT="$APP_ROOT" \
	ENV_FILE="$ENV_FILE" \
	COMPOSE_FILE="$COMPOSE_FILE" \
	EXPECTED_REVISION="$TARGET_REVISION" \
	CAMPAIGNS_HEALTHCHECK_ATTEMPTS=2 \
	CAMPAIGNS_HEALTHCHECK_INTERVAL=1 \
		bash "$SERVER_ROOT/scripts/deploy-campaigns-production.sh" \
			>"$APP_ROOT/routine-incomplete.log" 2>&1
	status=$?
	set -e
	((status != 0)) ||
		fail "Routine Campaigns deploy accepted an incomplete marker."
	grep -Fq 'blocked while Campaigns database cutover is incomplete' \
		"$APP_ROOT/routine-incomplete.log" ||
		fail "Routine Campaigns deploy failed for an unexpected reason."
	! docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1 ||
		fail "Blocked routine deploy created the Campaigns volume."
}

assert_seed_imported() {
	local state
	state="$(campaigns_query "
SELECT
	(SELECT count(*) FROM campaigns.campaigns) || '|' ||
	(SELECT count(*) FROM campaigns.deliveries) || '|' ||
	(SELECT count(*) FROM campaigns.audience_snapshots) || '|' ||
	(SELECT string_agg(channel::text, ',' ORDER BY channel::text)
	 FROM campaigns.deliveries) || '|' ||
	(SELECT message FROM campaigns.campaigns
	 WHERE id = '10000000-0000-4000-8000-000000000001') || '|' ||
	(SELECT count(*) FROM campaigns.campaigns
	 WHERE id = '20000000-0000-4000-8000-000000000001') || '|' ||
	(SELECT string_agg(audience::text, ',' ORDER BY id)
	 FROM campaigns.campaigns);
")"
	[[ "$state" == \
		'2|2|2|EMAIL,TELEGRAM|Completed email campaign changed after copied|0|ALL,ACTIVE_SUBSCRIPTION' ]] ||
		fail "Email/Telegram seed import is invalid: $state"
}

assert_source_tables_dropped() {
	local state
	state="$(
		docker run --rm --network host \
			-e "PGPASSWORD=$CORE_ADMIN_PASSWORD" \
			"$POSTGRES_IMAGE" \
			psql --no-psqlrc --tuples-only --no-align \
				--host 127.0.0.1 --port "$CORE_PORT" \
				--username "$CORE_ADMIN_USER" --dbname winwidget \
				--command "
SELECT
	to_regclass('public.mailing_campaigns') IS NULL AND
	to_regclass('public.mailing_deliveries') IS NULL;
"
	)"
	[[ "$state" == "t" ]] ||
		fail "Legacy Campaigns source tables still exist."
}

restore_campaigns_backup() {
	local artifact_directory dump_file restore_state structure_state acl_state
	local runtime_probe_status backup_write_status redump_file redump_sha256
	local switch_generation evidence_prefix
	switch_generation="$(marker_value switch_generation)"
	[[ "$switch_generation" =~ ^[1-9][0-9]*$ ]] ||
		fail "Campaigns restore drill requires a positive switch generation."
	evidence_prefix="switch-generation:${switch_generation}:"
	artifact_directory="$(marker_value artifact_directory)"
	dump_file="$artifact_directory/campaigns-verified.dump"
	[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" &&
		-f "$artifact_directory/campaigns-verified.restore-list" &&
		! -L "$artifact_directory/campaigns-verified.restore-list" &&
		-s "$artifact_directory/campaigns-verified.restore-list" &&
		-f "$dump_file.sha256" && ! -L "$dump_file.sha256" ]] ||
		fail "Verified pre-finalize Campaigns backup artifacts are missing."
	sha256sum --check "$dump_file.sha256" >/dev/null ||
		fail "Verified pre-finalize Campaigns backup checksum is invalid."
	docker run -d \
		--name "$RESTORE_CONTAINER" \
		--label "com.winwidget.rehearsal=$RUN_ID" \
		--label "com.winwidget.rehearsal.app-root=$APP_ROOT" \
		--label "com.winwidget.rehearsal.config-file=$COMPOSE_FILE" \
		--label "com.winwidget.rehearsal.working-dir=$COMPOSE_WORKING_DIR" \
		-e POSTGRES_PASSWORD=restore-rehearsal-password \
		--health-cmd 'pg_isready --username postgres --dbname postgres' \
		--health-interval 1s \
		--health-timeout 3s \
		--health-retries 60 \
		"$POSTGRES_IMAGE" >/dev/null
	wait_for_container_health "$RESTORE_CONTAINER"
	docker cp "$dump_file" "$RESTORE_CONTAINER:/tmp/campaigns.dump"
	docker exec "$RESTORE_CONTAINER" createdb \
		--username postgres winwidget_campaigns_restore
	docker exec "$RESTORE_CONTAINER" pg_restore \
		--username postgres \
		--dbname winwidget_campaigns_restore \
		--no-owner --no-acl \
		/tmp/campaigns.dump
	restore_state="$(
		docker exec "$RESTORE_CONTAINER" psql \
			--tuples-only --no-align \
			--username postgres \
			--dbname winwidget_campaigns_restore \
			--command "
SELECT
	(SELECT count(*) FROM campaigns.campaigns) || '|' ||
	(SELECT count(*) FROM campaigns.deliveries) || '|' ||
	(SELECT count(*) FROM campaigns._prisma_migrations);
"
	)"
	[[ "$restore_state" == '2|2|1' ]] ||
		fail "Restored Campaigns backup is invalid: $restore_state"
	structure_state="$(
		docker exec "$RESTORE_CONTAINER" psql \
			--tuples-only --no-align \
			--username postgres \
			--dbname winwidget_campaigns_restore \
			--command "
SELECT
	(SELECT count(*) FROM pg_constraint
	 WHERE connamespace = 'campaigns'::regnamespace
	   AND conname IN (
		'campaigns_content_check',
		'campaigns_counters_check',
		'audience_snapshots_campaign_id_fkey',
		'deliveries_campaign_id_fkey',
		'deliveries_snapshot_id_fkey'
	)) || '|' ||
	(SELECT count(*) FROM pg_indexes
	 WHERE schemaname = 'campaigns'
	   AND indexname IN (
		'campaigns_actor_idempotency_unique',
		'audience_snapshots_campaign_channel_unique',
		'deliveries_campaign_channel_destination_unique',
		'outbox_events_deduplication_key_unique',
		'consumer_receipts_event_consumer_unique'
	));
"
	)"
	[[ "$structure_state" == '5|5' ]] ||
		fail "Restored Campaigns constraints/indexes are invalid: $structure_state"

	docker exec -i "$RESTORE_CONTAINER" psql \
		--no-psqlrc --set ON_ERROR_STOP=1 \
		--username postgres \
		--dbname winwidget_campaigns_restore <<'SQL'
CREATE ROLE rehearsal_restore_runtime LOGIN PASSWORD 'restore_runtime_password_32';
CREATE ROLE rehearsal_restore_migration LOGIN PASSWORD 'restore_migration_password_32';
CREATE ROLE rehearsal_restore_backup LOGIN PASSWORD 'restore_backup_password_32';
REVOKE ALL ON DATABASE winwidget_campaigns_restore FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_campaigns_restore
	TO rehearsal_restore_runtime, rehearsal_restore_migration, rehearsal_restore_backup;
REVOKE CREATE ON DATABASE winwidget_campaigns_restore
	FROM rehearsal_restore_runtime, rehearsal_restore_migration, rehearsal_restore_backup;
ALTER SCHEMA campaigns OWNER TO rehearsal_restore_migration;
SELECT format(
	'ALTER TABLE %I.%I OWNER TO rehearsal_restore_migration',
	n.nspname,
	c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'campaigns'
	AND c.relkind IN ('r', 'p')
\gexec
SELECT format(
	'ALTER SEQUENCE %I.%I OWNER TO rehearsal_restore_migration',
	n.nspname,
	c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'campaigns'
	AND c.relkind = 'S'
\gexec
SELECT format(
	'ALTER TYPE %I.%I OWNER TO rehearsal_restore_migration',
	n.nspname,
	t.typname
)
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'campaigns'
	AND t.typtype = 'e'
\gexec
REVOKE ALL ON SCHEMA campaigns FROM PUBLIC;
GRANT USAGE ON SCHEMA campaigns
	TO rehearsal_restore_runtime, rehearsal_restore_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA campaigns
	TO rehearsal_restore_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA campaigns
	TO rehearsal_restore_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA campaigns TO rehearsal_restore_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA campaigns
	TO rehearsal_restore_backup;
ALTER DEFAULT PRIVILEGES
	FOR ROLE rehearsal_restore_migration IN SCHEMA campaigns
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
	TO rehearsal_restore_runtime;
ALTER DEFAULT PRIVILEGES
	FOR ROLE rehearsal_restore_migration IN SCHEMA campaigns
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES
	TO rehearsal_restore_runtime;
ALTER DEFAULT PRIVILEGES
	FOR ROLE rehearsal_restore_migration IN SCHEMA campaigns
	GRANT SELECT ON TABLES TO rehearsal_restore_backup;
ALTER DEFAULT PRIVILEGES
	FOR ROLE rehearsal_restore_migration IN SCHEMA campaigns
	GRANT SELECT ON SEQUENCES TO rehearsal_restore_backup;
REVOKE ALL PRIVILEGES ON TABLE campaigns._prisma_migrations
	FROM rehearsal_restore_runtime;
SQL
	acl_state="$(
		docker exec "$RESTORE_CONTAINER" psql \
			--tuples-only --no-align \
			--username postgres \
			--dbname winwidget_campaigns_restore \
			--command "
SELECT
	(SELECT pg_get_userbyid(nspowner)
	 FROM pg_namespace WHERE nspname = 'campaigns') || '|' ||
	(SELECT pg_get_userbyid(relowner)
	 FROM pg_class
	 WHERE oid = 'campaigns.campaigns'::regclass) || '|' ||
	has_database_privilege(
		'rehearsal_restore_runtime', current_database(), 'CREATE'
	) || '|' ||
	has_database_privilege(
		'rehearsal_restore_migration', current_database(), 'CREATE'
	) || '|' ||
	has_database_privilege(
		'rehearsal_restore_backup', current_database(), 'CREATE'
	) || '|' ||
	(
		SELECT NOT EXISTS (
			SELECT 1
			FROM aclexplode(
				COALESCE(n.nspacl, acldefault('n', n.nspowner))
			) AS acl
			WHERE acl.grantee = 0
				AND acl.privilege_type IN ('USAGE', 'CREATE')
		)
		FROM pg_namespace n
		WHERE n.nspname = 'campaigns'
	) || '|' ||
	has_schema_privilege(
		'rehearsal_restore_migration', 'campaigns', 'CREATE'
	) || '|' ||
	has_schema_privilege(
		'rehearsal_restore_runtime', 'campaigns', 'CREATE'
	) || '|' ||
	has_schema_privilege(
		'rehearsal_restore_backup', 'campaigns', 'CREATE'
	) || '|' ||
	(
		has_table_privilege(
			'rehearsal_restore_runtime', 'campaigns.campaigns', 'SELECT'
		) AND
		has_table_privilege(
			'rehearsal_restore_runtime', 'campaigns.campaigns', 'INSERT'
		) AND
		has_table_privilege(
			'rehearsal_restore_runtime', 'campaigns.campaigns', 'UPDATE'
		) AND
		has_table_privilege(
			'rehearsal_restore_runtime', 'campaigns.campaigns', 'DELETE'
		)
	) || '|' ||
	has_table_privilege(
		'rehearsal_restore_runtime',
		'campaigns._prisma_migrations',
		'SELECT'
	) || '|' ||
	has_table_privilege(
		'rehearsal_restore_backup',
		'campaigns.campaigns',
		'SELECT'
	) || '|' ||
	has_table_privilege(
		'rehearsal_restore_backup',
		'campaigns.campaigns',
		'INSERT'
	) || '|' ||
	(
		SELECT NOT EXISTS (
			SELECT 1
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'campaigns'
				AND c.relkind = 'S'
				AND (
					has_sequence_privilege(
						'rehearsal_restore_backup', c.oid, 'USAGE'
					)
					OR has_sequence_privilege(
						'rehearsal_restore_backup', c.oid, 'UPDATE'
					)
				)
		)
	);
"
	)"
	[[ "$acl_state" == \
		'rehearsal_restore_migration|rehearsal_restore_migration|false|false|false|true|true|false|false|true|false|true|false|true' ]] ||
		fail "Restored Campaigns ACL boundary is invalid: $acl_state"

	docker exec -e PGPASSWORD=restore_runtime_password_32 \
		"$RESTORE_CONTAINER" psql \
		--no-psqlrc --set ON_ERROR_STOP=1 \
		--username rehearsal_restore_runtime \
		--dbname winwidget_campaigns_restore \
		--command "
INSERT INTO campaigns.campaigns (
	id, actor_id, idempotency_key, subject, message, audience,
	requested_channel, status, updated_at
) VALUES (
	'30000000-0000-4000-8000-000000000001',
	'restore-runtime',
	'31000000-0000-4000-8000-000000000001',
	'Restore CRUD',
	'The restored runtime role can execute safe CRUD.',
	'ALL',
	'EMAIL',
	'FAILED',
	CURRENT_TIMESTAMP
);
UPDATE campaigns.campaigns
SET subject = 'Restore CRUD updated'
WHERE id = '30000000-0000-4000-8000-000000000001';
DELETE FROM campaigns.campaigns
WHERE id = '30000000-0000-4000-8000-000000000001';
" >/dev/null
	set +e
	docker exec -e PGPASSWORD=restore_runtime_password_32 \
		"$RESTORE_CONTAINER" psql \
		--no-psqlrc --username rehearsal_restore_runtime \
		--dbname winwidget_campaigns_restore \
		--command 'SELECT count(*) FROM campaigns._prisma_migrations;' \
		>/dev/null 2>&1
	runtime_probe_status=$?
	docker exec -e PGPASSWORD=restore_backup_password_32 \
		"$RESTORE_CONTAINER" psql \
		--no-psqlrc --username rehearsal_restore_backup \
		--dbname winwidget_campaigns_restore \
		--command "
INSERT INTO campaigns.campaigns (
	id, actor_id, idempotency_key, subject, message, audience,
	requested_channel, status, updated_at
) VALUES (
	'30000000-0000-4000-8000-000000000002',
	'restore-backup',
	'31000000-0000-4000-8000-000000000002',
	'Forbidden write',
	'The backup role must not be able to insert this row.',
	'ALL',
	'EMAIL',
	'FAILED',
	CURRENT_TIMESTAMP
);
" >/dev/null 2>&1
	backup_write_status=$?
	set -e
	((runtime_probe_status != 0 && backup_write_status != 0)) ||
		fail "Restored Campaigns role isolation is invalid."

	docker run --rm --network "container:$RESTORE_CONTAINER" \
		-e 'CAMPAIGNS_DATABASE_URL=postgresql://rehearsal_restore_runtime:restore_runtime_password_32@127.0.0.1:5432/winwidget_campaigns_restore?schema=campaigns&sslmode=disable' \
		--entrypoint node "winwidget-campaigns:git-$TARGET_REVISION" -e '
const { PrismaClient } = require("@prisma/campaigns-client");
const prisma = new PrismaClient();
const run = async () => {
  try {
    const count = await prisma.campaign.count();
    if (count !== 2) throw new Error(`unexpected restored count: ${count}`);
  } finally {
    await prisma.$disconnect();
  }
};
run().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
' >/dev/null

	docker exec "$RESTORE_CONTAINER" pg_dump \
		--username postgres \
		--dbname winwidget_campaigns_restore \
		--format custom --no-owner --no-acl \
		--schema campaigns \
		--file /tmp/campaigns-restored-redump.dump
	docker exec "$RESTORE_CONTAINER" sh -euc \
		'pg_restore --list /tmp/campaigns-restored-redump.dump >/tmp/campaigns-restored-redump.list; test -s /tmp/campaigns-restored-redump.list'
	redump_file="$artifact_directory/campaigns-restored-redump.dump"
	docker cp \
		"$RESTORE_CONTAINER:/tmp/campaigns-restored-redump.dump" \
		"$redump_file"
	chmod 600 "$redump_file"
	sha256sum "$redump_file" >"$redump_file.sha256"
	redump_sha256="$(
		sha256sum "$redump_file" |
			awk '{ print $1 }'
	)"
	[[ "$redump_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		fail "Restored Campaigns redump checksum is invalid."
	set_rehearsal_env_value \
		CAMPAIGNS_RESTORE_DRILL_REFERENCE \
		"${evidence_prefix}${redump_file}@sha256:$redump_sha256"
}

assert_post_cutover_backup() {
	local artifact_directory dump_file restore_list
	artifact_directory="$(marker_value artifact_directory)"
	dump_file="$artifact_directory/campaigns-post-cutover.dump"
	restore_list="$artifact_directory/campaigns-post-cutover.restore-list"
	[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" &&
		-f "$restore_list" && ! -L "$restore_list" && -s "$restore_list" &&
		-f "$dump_file.sha256" && ! -L "$dump_file.sha256" ]] ||
		fail "Campaigns post-cutover backup artifacts are missing."
	sha256sum --check "$dump_file.sha256" >/dev/null ||
		fail "Campaigns post-cutover backup checksum is invalid."
}

runtime_identity_without_campaigns() {
	local service container_id
	for service in \
		api \
		api-gateway \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		rabbitmq \
		campaigns-postgres \
		notification-delivery-postgres; do
		container_id="$(compose_target ps -q "$service")"
		printf '%s=%s|%s|%s\n' \
			"$service" \
			"$container_id" \
			"$(docker inspect --format '{{.RestartCount}}' "$container_id")" \
			"$(docker inspect --format '{{.State.StartedAt}}' "$container_id")"
	done
}

assert_campaigns_service_release() {
	local image="$1"
	local revision="$2"
	local container_id role
	assert_container_revision campaigns-service "$revision" "$image"
	container_id="$(compose_target ps --status running -q campaigns-service)"
	role="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$container_id" |
			sed -n 's/^CAMPAIGNS_PROCESS_ROLE=//p'
	)"
	[[ "$role" == "all" ]] ||
		fail "Campaigns release $revision does not run process role all."
	assert_campaigns_rabbitmq_ownership
	assert_campaigns_postgres_identity
}

deploy_and_rollback_schema_compatible_release() {
	local revision_b identity_before identity_after image_a image_b
	local image_a_id image_b_id
	local volume_before
	image_a="winwidget-campaigns:git-$TARGET_REVISION"
	image_a_id="$(docker image inspect "$image_a" --format '{{.Id}}')"
	git -C "$SERVER_ROOT" commit --quiet --allow-empty \
		-m 'test: schema-compatible Campaigns release'
	revision_b="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
	assert_image_ref_absent "winwidget-campaigns:git-$revision_b"
	identity_before="$(runtime_identity_without_campaigns)"
	volume_before="$(campaigns_volume_identity)"

	APP_ROOT="$APP_ROOT" \
	ENV_FILE="$ENV_FILE" \
	COMPOSE_FILE="$COMPOSE_FILE" \
	EXPECTED_REVISION="$revision_b" \
	CAMPAIGNS_HEALTHCHECK_ATTEMPTS=90 \
	CAMPAIGNS_HEALTHCHECK_INTERVAL=1 \
		bash "$SERVER_ROOT/scripts/deploy-campaigns-production.sh" \
			>"$APP_ROOT/routine-release-b.log" 2>&1
	image_b="winwidget-campaigns:git-$revision_b"
	wait_for_revision http://127.0.0.1:4500/health/ready "$revision_b"
	assert_image_metadata "$image_b" "$revision_b"
	image_b_id="$(docker image inspect "$image_b" --format '{{.Id}}')"
	[[ "$image_b_id" != "$image_a_id" ]] ||
		fail "Campaigns releases A and B unexpectedly share one image ID."
	assert_campaigns_service_release "$image_b" "$revision_b"
	identity_after="$(runtime_identity_without_campaigns)"
	[[ "$identity_after" == "$identity_before" ]] ||
		fail "Routine Campaigns deploy restarted another component."
	[[ "$(campaigns_volume_identity)" == "$volume_before" ]] ||
		fail "Routine Campaigns deploy changed the PostgreSQL volume."

	CAMPAIGNS_IMAGE="$image_a" \
	CAMPAIGNS_REVISION="$TARGET_REVISION" \
		compose_target up -d --no-deps --no-build --force-recreate \
			campaigns-service
	wait_for_revision http://127.0.0.1:4500/health/ready "$TARGET_REVISION"
	assert_campaigns_service_release "$image_a" "$TARGET_REVISION"
	[[ "$(runtime_identity_without_campaigns)" == "$identity_before" ]] ||
		fail "Campaigns B to A rollback restarted another component."

	CAMPAIGNS_IMAGE="$image_b" \
	CAMPAIGNS_REVISION="$revision_b" \
		compose_target up -d --no-deps --no-build --force-recreate \
			campaigns-service
	wait_for_revision http://127.0.0.1:4500/health/ready "$revision_b"
	assert_campaigns_service_release "$image_b" "$revision_b"
	[[ "$(runtime_identity_without_campaigns)" == "$identity_before" ]] ||
		fail "Campaigns A to B recovery restarted another component."
	[[ "$(campaigns_volume_identity)" == "$volume_before" ]] ||
		fail "Campaigns independent rollback changed the PostgreSQL volume."
}

CLEANUP_FAILED=false

cleanup_error() {
	echo "$1" >&2
	CLEANUP_FAILED=true
}

remove_owned_image() {
	local image_ref="$1"
	local expected_revision="$2"
	local require_rehearsal_label="$3"
	local revision rehearsal_label
	docker image inspect "$image_ref" >/dev/null 2>&1 || return 0
	revision="$(
		docker image inspect "$image_ref" \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
	)"
	rehearsal_label="$(
		docker image inspect "$image_ref" \
			--format '{{index .Config.Labels "com.winwidget.rehearsal"}}'
	)"
	if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ||
		"$revision" != "$expected_revision" ]]; then
		cleanup_error \
			"Refusing to delete image with unexpected revision: $image_ref"
		return
	fi
	if [[ "$require_rehearsal_label" == "true" &&
		"$rehearsal_label" != "$RUN_ID" ]]; then
		cleanup_error \
			"Refusing to delete image not labelled for this rehearsal: $image_ref"
		return
	fi
	if ! docker image rm "$image_ref" >/dev/null 2>&1 &&
		docker image inspect "$image_ref" >/dev/null 2>&1; then
		cleanup_error "Could not delete rehearsal image: $image_ref"
	fi
}

remove_validated_volume() {
	local volume="$1"
	if ! docker volume rm "$volume" >/dev/null 2>&1 &&
		docker volume inspect "$volume" >/dev/null 2>&1; then
		cleanup_error "Could not delete rehearsal volume: $volume"
	fi
}

remove_validated_container() {
	local container="$1"
	if ! docker rm -f "$container" >/dev/null 2>&1 &&
		docker container inspect "$container" >/dev/null 2>&1; then
		cleanup_error "Could not delete rehearsal container: $container"
	fi
}

remove_validated_network() {
	local network="$1"
	if ! docker network rm "$network" >/dev/null 2>&1 &&
		docker network inspect "$network" >/dev/null 2>&1; then
		cleanup_error "Could not delete rehearsal network: $network"
	fi
}

cleanup_rollback_compose_file=""

load_cleanup_rollback_compose_file() {
	local artifact_directory artifact_name expected_revision nullglob_was_set=false
	local -a rollback_candidates=()
	cleanup_rollback_compose_file=""
	expected_revision="$(
		sed -n '1p' "$APP_ROOT/deploy/backend/.rehearsal-target-revision"
	)"
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] ||
		fail "Campaigns rehearsal target revision is invalid."
	if [[ -e "$MARKER_FILE" || -L "$MARKER_FILE" ]]; then
		[[ -f "$MARKER_FILE" && ! -L "$MARKER_FILE" &&
			"$(stat -c '%u:%g:%a' "$MARKER_FILE")" == "0:0:600" ]] ||
			fail "Campaigns marker is unsafe; refusing rehearsal cleanup."
		artifact_directory="$(marker_value artifact_directory)" ||
			fail "Campaigns marker artifact directory is invalid."
	else
		if shopt -q nullglob; then
			nullglob_was_set=true
		fi
		shopt -s nullglob
		rollback_candidates=(
			"$APP_ROOT/deploy/backend/campaigns-database-cutover.$expected_revision."*/rollback-compose.json
		)
		[[ "$nullglob_was_set" == "true" ]] || shopt -u nullglob
		((${#rollback_candidates[@]} <= 1)) ||
			fail "Multiple Campaigns rollback Compose files exist without an active marker."
		((${#rollback_candidates[@]} == 1)) || return 0
		artifact_directory="$(dirname -- "${rollback_candidates[0]}")"
	fi
	artifact_name="$(basename -- "$artifact_directory")"
	[[ "$(dirname -- "$artifact_directory")" == "$APP_ROOT/deploy/backend" &&
		"$artifact_name" =~ ^campaigns-database-cutover\.$expected_revision\.[0-9]{8}T[0-9]{6}Z$ &&
		-d "$artifact_directory" && ! -L "$artifact_directory" &&
		"$(realpath -e -- "$artifact_directory")" == "$artifact_directory" &&
		"$(stat -c '%u:%g' "$artifact_directory")" == "0:0" ]] ||
		fail "Campaigns marker points outside the exact rehearsal artifact root."
	if [[ -e "$artifact_directory/rollback-compose.json" ||
		-L "$artifact_directory/rollback-compose.json" ]]; then
		[[ -f "$artifact_directory/rollback-compose.json" &&
			! -L "$artifact_directory/rollback-compose.json" &&
			"$(stat -c '%u:%g:%a' \
				"$artifact_directory/rollback-compose.json")" == "0:0:600" ]] ||
			fail "Campaigns rollback Compose file is unsafe."
		cleanup_rollback_compose_file="$artifact_directory/rollback-compose.json"
	fi
}

is_allowed_compose_config_files() {
	local config_files="$1"
	[[ "$config_files" == "$COMPOSE_FILE" ||
		"$config_files" == "$COMPOSE_FILE,$BASELINE_COMPOSE_OVERRIDE" ||
		(-n "$cleanup_rollback_compose_file" &&
			"$config_files" == \
			"$COMPOSE_FILE,$cleanup_rollback_compose_file") ]]
}

is_allowed_compose_service() {
	case "$1" in
		api | api-gateway | outbox-publisher | integration-worker | \
			maintenance-worker | notification-delivery-worker | \
			notification-delivery-postgres | notification-delivery-migrate | \
			campaigns-service | campaigns-postgres | campaigns-migrate | \
			rabbitmq | migrate)
			return 0
			;;
		*) return 1 ;;
	esac
}

assert_compose_container_cleanup_ownership() {
	local container="$1"
	local project config_files working_dir service provenance
	project="$(
		docker inspect \
			--format '{{index .Config.Labels "com.docker.compose.project"}}' \
			"$container"
	)"
	config_files="$(
		docker inspect \
			--format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
			"$container"
	)"
	working_dir="$(
		docker inspect \
			--format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
			"$container"
	)"
	service="$(
		docker inspect \
			--format '{{index .Config.Labels "com.docker.compose.service"}}' \
			"$container"
	)"
	provenance="$(
		docker inspect \
			--format '{{index .Config.Labels "com.winwidget.rehearsal"}}|{{index .Config.Labels "com.winwidget.rehearsal.app-root"}}|{{index .Config.Labels "com.winwidget.rehearsal.config-file"}}|{{index .Config.Labels "com.winwidget.rehearsal.working-dir"}}' \
			"$container"
	)"
	if ! [[ "$project" == "winwidget" &&
		"$working_dir" == "$COMPOSE_WORKING_DIR" &&
		"$working_dir" == "$APP_ROOT"/* &&
		"$config_files" == "$APP_ROOT"/* &&
		"$provenance" == \
		"$RUN_ID|$APP_ROOT|$COMPOSE_FILE|$COMPOSE_WORKING_DIR" ]] ||
		! is_allowed_compose_config_files "$config_files" ||
		! is_allowed_compose_service "$service"; then
		fail "Compose container $container is not owned by this exact rehearsal."
	fi
}

assert_compose_network_cleanup_ownership() {
	local network="$1"
	local expected_key project network_key provenance
	case "$network" in
		winwidget_default) expected_key=default ;;
		winwidget-campaigns-postgres) expected_key=campaigns-postgres ;;
		winwidget-notification-delivery-postgres)
			expected_key=notification-delivery-postgres
			;;
		*) fail "Unexpected WinWidget Compose network: $network" ;;
	esac
	project="$(
		docker network inspect "$network" \
			--format '{{index .Labels "com.docker.compose.project"}}'
	)"
	network_key="$(
		docker network inspect "$network" \
			--format '{{index .Labels "com.docker.compose.network"}}'
	)"
	provenance="$(
		docker network inspect "$network" \
			--format '{{index .Labels "com.winwidget.rehearsal"}}|{{index .Labels "com.winwidget.rehearsal.app-root"}}|{{index .Labels "com.winwidget.rehearsal.config-file"}}|{{index .Labels "com.winwidget.rehearsal.working-dir"}}'
	)"
	[[ "$project" == "winwidget" &&
		"$network_key" == "$expected_key" &&
		"$provenance" == \
		"$RUN_ID|$APP_ROOT|$COMPOSE_FILE|$COMPOSE_WORKING_DIR" ]] ||
		fail "Compose network $network is not owned by this exact rehearsal."
}

assert_standalone_container_cleanup_ownership() {
	local container="$1"
	local provenance
	provenance="$(
		docker inspect \
			--format '{{index .Config.Labels "com.winwidget.rehearsal"}}|{{index .Config.Labels "com.winwidget.rehearsal.app-root"}}|{{index .Config.Labels "com.winwidget.rehearsal.config-file"}}|{{index .Config.Labels "com.winwidget.rehearsal.working-dir"}}' \
			"$container"
	)"
	[[ "$provenance" == \
		"$RUN_ID|$APP_ROOT|$COMPOSE_FILE|$COMPOSE_WORKING_DIR" ]] ||
		fail "Container $container is not owned by this exact rehearsal."
}

validate_compose_cleanup_ownership() {
	local container network volume
	load_cleanup_rollback_compose_file
	while IFS= read -r container; do
		[[ -n "$container" ]] || continue
		assert_compose_container_cleanup_ownership "$container"
	done < <(
		docker ps -aq --filter label=com.docker.compose.project=winwidget
	)
	while IFS= read -r network; do
		[[ -n "$network" ]] || continue
		assert_compose_network_cleanup_ownership "$network"
	done < <(
		docker network ls -q \
			--filter label=com.docker.compose.project=winwidget |
			xargs -r docker network inspect --format '{{.Name}}'
	)
	for network in \
		winwidget-campaigns-postgres \
		winwidget-notification-delivery-postgres \
		winwidget_default; do
		docker network inspect "$network" >/dev/null 2>&1 || continue
		assert_compose_network_cleanup_ownership "$network"
	done
	for volume in \
		"$NOTIFICATION_VOLUME" \
		"$RABBITMQ_VOLUME"; do
		docker volume inspect "$volume" >/dev/null 2>&1 || continue
		assert_rehearsal_volume_provenance "$volume"
	done
	if docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1; then
		assert_rehearsal_volume_provenance "$CAMPAIGNS_VOLUME"
		load_campaigns_volume_identity
		assert_campaigns_volume_unchanged
		assert_campaigns_cleanup_volume_labels
	fi
}

cleanup_rehearsal() {
	local target_revision baseline_revision revision_b container volume
	local network
	validate_rehearsal_paths
	[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
		fail "Exact rehearsal app root is required for cleanup: $APP_ROOT"
	[[ "$(stat -c '%u:%a' "$APP_ROOT")" == "0:700" &&
		-f "$APP_ROOT/deploy/backend/.rehearsal-target-revision" &&
		! -L "$APP_ROOT/deploy/backend/.rehearsal-target-revision" &&
		"$(stat -c '%u:%a' \
			"$APP_ROOT/deploy/backend/.rehearsal-target-revision")" == \
		"0:600" &&
		-f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == "0:0:600" &&
		-f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" &&
		"$(stat -c '%u:%g:%a' "$COMPOSE_FILE")" == "0:0:600" &&
		-f "$SOURCE_COMPOSE_FILE" && ! -L "$SOURCE_COMPOSE_FILE" &&
		-d "$SERVER_ROOT/.git" && ! -L "$SERVER_ROOT" &&
		-d "$BASELINE_ROOT/.git" && ! -L "$BASELINE_ROOT" ]] ||
		fail "Rehearsal cleanup metadata is not root-owned and exact."
	target_revision="$(
		sed -n '1p' "$APP_ROOT/deploy/backend/.rehearsal-target-revision"
	)"
	baseline_revision="$(git -C "$BASELINE_ROOT" rev-parse HEAD)"
	revision_b="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
	[[ "$target_revision" =~ ^[0-9a-f]{40}$ &&
		"$baseline_revision" =~ ^[0-9a-f]{40}$ &&
		"$revision_b" =~ ^[0-9a-f]{40}$ ]] ||
		fail "Rehearsal revision metadata is incomplete; refusing cleanup."
	validate_compose_cleanup_ownership
	for container in "$CORE_CONTAINER" "$RESTORE_CONTAINER"; do
		docker container inspect "$container" >/dev/null 2>&1 || continue
		assert_standalone_container_cleanup_ownership "$container"
	done
	if docker volume inspect "$CORE_VOLUME" >/dev/null 2>&1; then
		assert_rehearsal_volume_provenance "$CORE_VOLUME"
	fi
	if ! unmount_audit_canonical_root; then
		cleanup_error "Could not remove the exact canonical audit bind."
	fi

	if ! compose_target \
		--profile notification-delivery-database \
		--profile campaigns-database \
		--profile notification-delivery-migration \
		--profile campaigns-migration \
		down --remove-orphans; then
		cleanup_error "Docker Compose rehearsal cleanup failed."
	fi

	while IFS= read -r container; do
		[[ -n "$container" ]] || continue
		assert_compose_container_cleanup_ownership "$container"
		remove_validated_container "$container"
	done < <(
		docker ps -aq --filter label=com.docker.compose.project=winwidget
	)

	for container in "$CORE_CONTAINER" "$RESTORE_CONTAINER"; do
		docker container inspect "$container" >/dev/null 2>&1 || continue
		assert_standalone_container_cleanup_ownership "$container"
		remove_validated_container "$container"
	done

	for volume in "$CORE_VOLUME" "$NOTIFICATION_VOLUME" "$RABBITMQ_VOLUME"; do
		docker volume inspect "$volume" >/dev/null 2>&1 || continue
		assert_rehearsal_volume_provenance "$volume"
		remove_validated_volume "$volume"
	done
	if docker volume inspect "$CAMPAIGNS_VOLUME" >/dev/null 2>&1; then
		assert_rehearsal_volume_provenance "$CAMPAIGNS_VOLUME"
		assert_campaigns_volume_unchanged
		assert_campaigns_cleanup_volume_labels
		remove_validated_volume "$CAMPAIGNS_VOLUME"
	fi

	for network in \
		winwidget-campaigns-postgres \
		winwidget-notification-delivery-postgres \
		winwidget_default; do
		docker network inspect "$network" >/dev/null 2>&1 || continue
		assert_compose_network_cleanup_ownership "$network"
		remove_validated_network "$network"
	done

	for image in \
		"winwidget-api:$BASELINE_TAG" \
		"winwidget-api-gateway:$BASELINE_TAG" \
		"winwidget-maintenance:$BASELINE_TAG" \
		"winwidget-notification-delivery:$BASELINE_TAG" \
		"winwidget-api:campaigns-pre-$target_revision" \
		"winwidget-api-gateway:campaigns-pre-$target_revision" \
		"winwidget-maintenance:campaigns-pre-$target_revision" \
		"winwidget-notification-delivery:campaigns-pre-$target_revision"; do
		remove_owned_image "$image" "$baseline_revision" true
	done
	for image in \
		"winwidget-api:git-$target_revision" \
		"winwidget-api-gateway:git-$target_revision" \
		"winwidget-maintenance:git-$target_revision" \
		"winwidget-notification-delivery:git-$target_revision" \
		"winwidget-campaigns:git-$target_revision"; do
		remove_owned_image "$image" "$target_revision" false
	done
	if [[ "$revision_b" != "$target_revision" ]]; then
		remove_owned_image \
			"winwidget-campaigns:git-$revision_b" "$revision_b" false
	fi

	[[ -z "$(docker ps -aq \
		--filter label=com.docker.compose.project=winwidget)" ]] ||
		cleanup_error "WinWidget rehearsal Compose containers remain."
	for container in "$CORE_CONTAINER" "$RESTORE_CONTAINER"; do
		! docker container inspect "$container" >/dev/null 2>&1 ||
			cleanup_error "Rehearsal container remains: $container"
	done
	for volume in \
		"$CORE_VOLUME" "$NOTIFICATION_VOLUME" "$RABBITMQ_VOLUME" \
		"$CAMPAIGNS_VOLUME"; do
		! docker volume inspect "$volume" >/dev/null 2>&1 ||
			cleanup_error "Rehearsal volume remains: $volume"
	done
	for network in \
		winwidget-campaigns-postgres \
		winwidget-notification-delivery-postgres \
		winwidget_default; do
		! docker network inspect "$network" >/dev/null 2>&1 ||
			cleanup_error "Rehearsal network remains: $network"
	done
	for image in \
		"winwidget-api:$BASELINE_TAG" \
		"winwidget-api-gateway:$BASELINE_TAG" \
		"winwidget-maintenance:$BASELINE_TAG" \
		"winwidget-notification-delivery:$BASELINE_TAG" \
		"winwidget-api:campaigns-pre-$target_revision" \
		"winwidget-api-gateway:campaigns-pre-$target_revision" \
		"winwidget-maintenance:campaigns-pre-$target_revision" \
		"winwidget-notification-delivery:campaigns-pre-$target_revision" \
		"winwidget-api:git-$target_revision" \
		"winwidget-api-gateway:git-$target_revision" \
		"winwidget-maintenance:git-$target_revision" \
		"winwidget-notification-delivery:git-$target_revision" \
		"winwidget-campaigns:git-$target_revision"; do
		! docker image inspect "$image" >/dev/null 2>&1 ||
			cleanup_error "Rehearsal image remains: $image"
	done
	if [[ "$revision_b" != "$target_revision" ]]; then
		! docker image inspect \
			"winwidget-campaigns:git-$revision_b" >/dev/null 2>&1 ||
			cleanup_error \
				"Rehearsal image remains: winwidget-campaigns:git-$revision_b"
	fi
	[[ ! -e "$AUDIT_CANONICAL_ROOT" && ! -L "$AUDIT_CANONICAL_ROOT" ]] ||
		cleanup_error "Canonical rehearsal audit bind target remains."
	[[ "$CLEANUP_FAILED" == "false" ]] ||
		fail "Campaigns rehearsal cleanup was incomplete; $APP_ROOT was retained."
	validate_rehearsal_paths
	rm -rf -- "$APP_ROOT"
	[[ ! -e "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
		fail "Rehearsal app root remains after exact cleanup."
}

run_rehearsal() {
	local previous_switch_generation
	validate_rehearsal_paths
	[[ "$(id -u)" == "0" ]] ||
		fail "Campaigns cutover rehearsal must run as root inside Colima."
	[[ "$(uname -s)" == "Linux" ]] ||
		fail "Campaigns cutover rehearsal requires a Linux environment."
	[[ "$(docker info --format '{{.Name}}')" == "colima" ]] ||
		fail "Campaigns cutover rehearsal is restricted to the local Colima daemon."
	SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")" ||
		fail "Campaigns rehearsal source root does not exist."
	[[ -d "$SOURCE_ROOT/.git" && ! -L "$SOURCE_ROOT" ]] ||
		fail "Campaigns rehearsal source root is not a Git checkout."
	assert_no_existing_rehearsal_targets
	copy_worktree_snapshot
	write_rehearsal_configuration
	build_baseline_images
	start_datastores
	migrate_and_seed_datastores
	provision_rabbitmq_users
	start_baseline_runtime

	stage_first_cutover_revision
	expect_phase_failure prepare preflight
	test_incomplete_routine_deploy_guard
	test_preexisting_campaigns_volume_guard
	expect_phase_failure prepare target-created
	expect_phase_failure prepare roles-ready
	expect_phase_failure prepare migrated
	expect_phase_failure prepare source-frozen
	expect_phase_failure prepare importing
	inject_partial_target_import
	expect_phase_failure prepare copied
	mutate_legacy_source_after_copy
	expect_phase_failure prepare verified
	expect_phase_failure prepare switching
	expect_switch_runtime_failure
	expect_gateway_exposed_failure
	expect_switch_recovery_failure
	expect_phase_failure prepare switched
	[[ "$(campaigns_query "
SELECT
	(SELECT count(*) FROM campaigns.campaigns) || '|' ||
	(SELECT count(*) FROM campaigns.campaigns
	 WHERE idempotency_key = '22000000-0000-4000-8000-000000000001');
")" == '2|0' ]] ||
		fail "Interrupted Gateway target state survived the switching recovery."
	assert_seed_imported
	run_telegram_audit_fixture
	run_cutover prepare
	run_cutover rollback
	[[ "$(marker_value phase)" == "verified" ]] ||
		fail "Pre-forward rollback did not return marker to verified."
	assert_legacy_runtime_restored
	assert_rollback_target_queues_absent
	assert_campaigns_volume_unchanged
	previous_switch_generation="$(marker_value switch_generation)"
	restart_cutover_attempt "$previous_switch_generation"
	set_rehearsal_env_value CAMPAIGNS_TELEGRAM_AUDIT_DECISION pending
	set_rehearsal_env_value CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE ''
	set_rehearsal_env_value CAMPAIGNS_RESTORE_DRILL_REFERENCE ''
	expect_phase_failure prepare switched
	[[ "$(marker_value switch_generation)" == \
		"$((previous_switch_generation + 1))" ]] ||
		fail "Restarted Campaigns cutover did not advance switch_generation."
	run_telegram_audit_fixture
	restore_campaigns_backup

	expect_phase_failure finalize forward-only
	expect_phase_failure finalize source-dropped
	assert_source_tables_dropped
	expect_phase_failure finalize complete
	run_cutover finalize
	[[ "$(marker_value phase)" == "complete" &&
		"$(marker_value source_schema_state)" == "dropped" ]] ||
		fail "Campaigns cutover did not finish with the complete dropped marker."
	assert_campaigns_volume_unchanged
	assert_post_cutover_backup
	deploy_and_rollback_schema_compatible_release
	unmount_audit_canonical_root ||
		fail "Could not remove the canonical audit bind after rehearsal."
	echo "Campaigns full cutover rehearsal passed for run $RUN_ID."
}

case "${1:-run}" in
run)
	run_rehearsal
	;;
cleanup)
	validate_rehearsal_paths
	[[ "$(id -u)" == "0" ]] ||
		fail "Campaigns rehearsal cleanup must run as root inside Colima."
	[[ "$(uname -s)" == "Linux" ]] ||
		fail "Campaigns rehearsal cleanup requires a Linux environment."
	[[ "$(docker info --format '{{.Name}}')" == "colima" ]] ||
		fail "Campaigns rehearsal cleanup is restricted to local Colima."
	cleanup_rehearsal
	;;
*)
	fail "Usage: $0 run|cleanup"
	;;
esac
