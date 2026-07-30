#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
EXPECTED_NEXT_REVISION="${EXPECTED_NEXT_REVISION:-}"

server_root="$APP_ROOT/winwidget.ru_server"
marker_directory="$APP_ROOT/deploy/backend"
cutover_marker="$marker_directory/.campaigns-database-cutover-v1"
staged_marker="$marker_directory/.campaigns-first-cutover-staged-v1"
restart_receipt="$marker_directory/.campaigns-database-restart-v1"

restart_status=""
old_revision=""
next_revision=""
artifact_directory=""
target_volume=""
switch_generation_seed=""
cutover_marker_sha256=""
staged_marker_sha256=""
restart_started_at=""

fail() {
	echo "$1" >&2
	exit 1
}

encode_text_base64() {
	printf '%s' "$1" | base64 | tr -d '\n'
}

run_self_test() {
	local fixture='{"routes":[]}'
	[[ "$(encode_text_base64 "$fixture")" == \
		"eyJyb3V0ZXMiOltdfQ==" ]] ||
		fail "Campaigns restart Base64 encoding changed the exact text fixture."
	[[ "$(encode_text_base64 "$fixture")" != \
		"eyJyb3V0ZXMiOltdfQo=" ]] ||
		fail "Campaigns restart Base64 encoding retained a trailing newline."
	echo "Campaigns restart self-test passed."
}

validate_context() {
	local rehearsal="${CAMPAIGNS_CUTOVER_REHEARSAL:-}"
	local run_id="${CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID:-}"
	local failure_checkpoint="${CAMPAIGNS_RESTART_REHEARSAL_FAIL_AFTER_CHECKPOINT:-}"
	local expected_root="/opt/winwidget"
	local expected_compose="$server_root/deploy/docker-compose.prod.yml"
	local canonical_root

	if [[ "$rehearsal" == "true" ]]; then
		[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ &&
			"$run_id" != "." && "$run_id" != ".." ]] ||
			fail "Campaigns restart rehearsal run ID is missing or invalid."
		expected_root="/tmp/winwidget-campaigns-cutover-rehearsal-$run_id"
		expected_compose="$server_root/deploy/docker-compose.rehearsal.yml"
		case "$failure_checkpoint" in
		"" | archived-cutover-marker | target-volume-removed | next-checkout | next-marker-staged | old-marker-removed | final-receipt) ;;
		*)
			fail "Unknown Campaigns restart rehearsal checkpoint: $failure_checkpoint"
			;;
		esac
	elif [[ -n "$rehearsal" || -n "$run_id" ]]; then
		fail "Campaigns restart rehearsal controls are invalid."
	elif [[ -n "$failure_checkpoint" ]]; then
		fail "Campaigns restart failure injection is allowed only in rehearsal."
	fi

	canonical_root="$(realpath -e -- "$APP_ROOT" 2>/dev/null)" ||
		fail "Campaigns restart app root does not exist."
	[[ "$(id -u)" == "0" && "$(uname -s)" == "Linux" ]] ||
		fail "Campaigns restart must run as root on Linux."
	[[ "$APP_ROOT" == "$expected_root" &&
		"$canonical_root" == "$expected_root" &&
		-d "$APP_ROOT" && ! -L "$APP_ROOT" &&
		"$ENV_FILE" == "$marker_directory/.env.production" &&
		"$COMPOSE_FILE" == "$expected_compose" ]] ||
		fail "Campaigns restart paths are outside the reviewed deployment boundary."
	[[ "$EXPECTED_NEXT_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
		fail "EXPECTED_NEXT_REVISION must be an exact 40-character Git SHA."
}

restart_rehearsal_checkpoint() {
	local checkpoint="$1"
	[[ "${CAMPAIGNS_RESTART_REHEARSAL_FAIL_AFTER_CHECKPOINT:-}" == \
		"$checkpoint" ]] || return 0
	echo "Campaigns restart rehearsal injected a failure at checkpoint=$checkpoint." >&2
	return 86
}

assert_tracked_file() {
	local relative_path="$1"
	local path="$server_root/$relative_path"
	local tracked_blob actual_blob

	[[ -f "$path" && ! -L "$path" ]] ||
		fail "Tracked deployment file is missing or unsafe: $relative_path"
	tracked_blob="$(
		git -C "$server_root" rev-parse --verify "HEAD:$relative_path"
	)" || fail "Deployment file is not tracked at HEAD: $relative_path"
	actual_blob="$(git -C "$server_root" hash-object "$path")"
	[[ "$actual_blob" == "$tracked_blob" ]] ||
		fail "Deployment file differs from the checked-out revision: $relative_path"
}

file_value() {
	local file="$1"
	local key="$2"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$file"
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
				found += 1
			}
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$ENV_FILE"
}

compose_target() {
	docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		"$@"
}

container_env_value() {
	local container_id="$1"
	local key="$2"
	docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container_id" |
		sed -n "s/^${key}=//p"
}

validate_restart_receipt() {
	[[ -f "$restart_receipt" && ! -L "$restart_receipt" &&
		"$(stat -c '%u:%g:%a' "$restart_receipt")" == "0:0:600" ]] ||
		return 1
	awk -F= '
		BEGIN {
			allowed["status"] = 1
			allowed["old_revision"] = 1
			allowed["next_revision"] = 1
			allowed["artifact_directory"] = 1
			allowed["target_volume"] = 1
			allowed["switch_generation_seed"] = 1
			allowed["cutover_marker_sha256"] = 1
			allowed["staged_marker_sha256"] = 1
			allowed["restart_started_at"] = 1
			allowed["updated_at"] = 1
		}
		{
			if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=[^[:cntrl:]]*$/ ||
				!allowed[$1] || seen[$1]++) invalid = 1
			value[$1] = substr($0, index($0, "=") + 1)
		}
		END {
			for (key in allowed) if (seen[key] != 1) invalid = 1
			if (value["status"] !~ /^(validated|target-removed|new-staged|staged)$/ ||
				length(value["old_revision"]) != 40 ||
				value["old_revision"] !~ /^[0-9a-f]+$/ ||
				length(value["next_revision"]) != 40 ||
				value["next_revision"] !~ /^[0-9a-f]+$/ ||
				value["target_volume"] != "winwidget-campaigns-postgres-data" ||
				value["switch_generation_seed"] !~ /^[1-9][0-9]{0,17}$/ ||
				length(value["cutover_marker_sha256"]) != 64 ||
				value["cutover_marker_sha256"] !~ /^[0-9a-f]+$/ ||
				length(value["staged_marker_sha256"]) != 64 ||
				value["staged_marker_sha256"] !~ /^[0-9a-f]+$/ ||
				value["restart_started_at"] !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/ ||
				value["updated_at"] !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) {
				invalid = 1
			}
			exit(invalid ? 1 : 0)
		}
	' "$restart_receipt"
}

load_restart_receipt() {
	validate_restart_receipt ||
		fail "Campaigns restart receipt is missing or invalid."
	restart_status="$(file_value "$restart_receipt" status)"
	old_revision="$(file_value "$restart_receipt" old_revision)"
	next_revision="$(file_value "$restart_receipt" next_revision)"
	artifact_directory="$(file_value "$restart_receipt" artifact_directory)"
	target_volume="$(file_value "$restart_receipt" target_volume)"
	switch_generation_seed="$(
		file_value "$restart_receipt" switch_generation_seed
	)"
	cutover_marker_sha256="$(
		file_value "$restart_receipt" cutover_marker_sha256
	)"
	staged_marker_sha256="$(
		file_value "$restart_receipt" staged_marker_sha256
	)"
	restart_started_at="$(file_value "$restart_receipt" restart_started_at)"
	[[ "$next_revision" == "$EXPECTED_NEXT_REVISION" ]] ||
		fail "Campaigns restart receipt belongs to another next revision."
	validate_archived_markers
}

write_restart_receipt() {
	local status="$1"
	local temporary_receipt="$marker_directory/.campaigns-database-restart-v1.$$"
	{
		printf 'status=%s\n' "$status"
		printf 'old_revision=%s\n' "$old_revision"
		printf 'next_revision=%s\n' "$next_revision"
		printf 'artifact_directory=%s\n' "$artifact_directory"
		printf 'target_volume=%s\n' "$target_volume"
		printf 'switch_generation_seed=%s\n' "$switch_generation_seed"
		printf 'cutover_marker_sha256=%s\n' "$cutover_marker_sha256"
		printf 'staged_marker_sha256=%s\n' "$staged_marker_sha256"
		printf 'restart_started_at=%s\n' "$restart_started_at"
		printf 'updated_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	} >"$temporary_receipt"
	chown 0:0 "$temporary_receipt"
	chmod 600 "$temporary_receipt"
	mv -f "$temporary_receipt" "$restart_receipt"
	restart_status="$status"
	validate_restart_receipt ||
		fail "Campaigns restart receipt failed its own validation."
}

validate_artifact_directory() {
	local canonical_artifact
	canonical_artifact="$(realpath -e -- "$artifact_directory" 2>/dev/null)" ||
		fail "Campaigns cutover artifact directory is missing."
	[[ "$artifact_directory" == \
			"$marker_directory/campaigns-database-cutover.$old_revision."* &&
		"$canonical_artifact" == "$artifact_directory" &&
		-d "$artifact_directory" && ! -L "$artifact_directory" &&
		"$(stat -c '%u:%g:%a' "$artifact_directory")" == "0:0:700" ]] ||
		fail "Campaigns cutover artifact directory is unsafe."
}

validate_archived_markers() {
	local archived_cutover="$artifact_directory/restart-cutover-marker"
	local archived_staged="$artifact_directory/restart-staged-marker"
	validate_artifact_directory
	for marker in "$archived_cutover" "$archived_staged"; do
		[[ -f "$marker" && ! -L "$marker" &&
			"$(stat -c '%u:%g:%a' "$marker")" == "0:0:600" ]] ||
			fail "Archived Campaigns restart marker is missing or unsafe."
	done
	[[ "$(sha256sum "$archived_cutover" | awk '{ print $1 }')" == \
			"$cutover_marker_sha256" &&
		"$(sha256sum "$archived_staged" | awk '{ print $1 }')" == \
			"$staged_marker_sha256" ]] ||
		fail "Archived Campaigns restart marker checksum changed."
}

archive_active_markers() {
	local archived_cutover="$artifact_directory/restart-cutover-marker"
	local archived_staged="$artifact_directory/restart-staged-marker"
	local source_marker archived_marker
	while IFS='|' read -r source_marker archived_marker; do
		if [[ -e "$archived_marker" || -L "$archived_marker" ]]; then
			[[ -f "$archived_marker" && ! -L "$archived_marker" &&
				"$(stat -c '%u:%g:%a' "$archived_marker")" == "0:0:600" ]] &&
				cmp -s "$source_marker" "$archived_marker" ||
					fail "Existing Campaigns restart archive differs from the active marker."
		else
			install -o 0 -g 0 -m 600 "$source_marker" "$archived_marker"
		fi
		if [[ "$archived_marker" == "$archived_cutover" ]]; then
			restart_rehearsal_checkpoint archived-cutover-marker
		fi
	done <<EOF
$cutover_marker|$archived_cutover
$staged_marker|$archived_staged
EOF
	cutover_marker_sha256="$(
		sha256sum "$archived_cutover" | awk '{ print $1 }'
	)"
	staged_marker_sha256="$(
		sha256sum "$archived_staged" | awk '{ print $1 }'
	)"
	validate_archived_markers
}

verify_running_service() {
	local service="$1"
	local expected_image_id="$2"
	local expected_revision="$3"
	local container_id image_id image_revision restart_count
	container_id="$(
		compose_target ps --status running -q "$service" 2>/dev/null || true
	)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
		fail "Exactly one running legacy $service container is required."
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(
		docker image inspect \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image_id"
	)"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	[[ "$image_id" == "$expected_image_id" &&
		"$image_revision" == "$expected_revision" &&
		"$restart_count" == "0" ]] ||
		fail "Legacy $service runtime identity differs from the rollback marker."
	printf '%s' "$container_id"
}

wait_for_revision() {
	local url="$1"
	local expected_revision="$2"
	local response
	response="$(curl -fsS --connect-timeout 2 --max-time 5 "$url")" ||
		fail "Legacy runtime health request failed: $url"
	[[ -z "$expected_revision" ||
		"$response" == *"\"revision\":\"$expected_revision\""* ||
		"$response" == *"\"revision\": \"$expected_revision\""* ]] ||
		fail "Legacy runtime health revision is invalid: $url"
}

target_queue_names() {
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

assert_target_queues_absent() {
	local rabbitmq_container vhost queue_names queue
	rabbitmq_container="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	vhost="$(get_env_value RABBITMQ_VHOST)" ||
		fail "RABBITMQ_VHOST is missing or duplicated."
	queue_names="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p "$vhost" name
	)" || fail "Could not inspect RabbitMQ after Campaigns rollback."
	while IFS= read -r queue; do
		! grep -Fxq -- "$queue" <<<"$queue_names" ||
			fail "Rollback-owned Campaigns queue still exists: $queue"
	done < <(target_queue_names)
}

assert_legacy_source_present() {
	local source_url source_state
	source_url="$(get_env_value DATABASE_BACKUP_URL)" ||
		fail "DATABASE_BACKUP_URL is missing or duplicated."
	(
		export PGURL="$source_url"
		source_state="$(
			docker run --rm -i --network host \
				-e PGURL \
				"$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" \
				sh -euc '
psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
  "$PGURL" --command "
SELECT CASE WHEN
  to_regclass('\''public.mailing_campaigns'\'') IS NOT NULL
  AND to_regclass('\''public.mailing_deliveries'\'') IS NOT NULL
THEN '\''present'\'' ELSE '\''missing'\'' END;
"
'
		)"
		[[ "$source_state" == "present" ]]
	) || fail "Legacy Campaigns source tables are not available after rollback."
}

assert_legacy_runtime() {
	local marker_file="$1"
	local previous_image_id previous_revision previous_gateway_image_id
	local previous_maintenance_image_id previous_notification_image_id
	local maintenance_revision notification_revision gateway_routes_base64
	local gateway_routes_json api_id gateway_id integration_id integration_kinds

	previous_image_id="$(file_value "$marker_file" previous_image_id)"
	previous_revision="$(file_value "$marker_file" previous_revision)"
	previous_gateway_image_id="$(
		file_value "$marker_file" previous_gateway_image_id
	)"
	previous_maintenance_image_id="$(
		file_value "$marker_file" previous_maintenance_image_id
	)"
	previous_notification_image_id="$(
		file_value "$marker_file" previous_notification_image_id
	)"
	maintenance_revision="$(
		file_value "$marker_file" rollback_maintenance_revision
	)"
	notification_revision="$(
		file_value "$marker_file" rollback_notification_revision
	)"
	gateway_routes_base64="$(
		file_value "$marker_file" previous_gateway_routes_base64
	)"

	api_id="$(
		verify_running_service api "$previous_image_id" "$previous_revision"
	)"
	gateway_id="$(
		verify_running_service \
			api-gateway "$previous_gateway_image_id" "$previous_revision"
	)"
	verify_running_service \
		outbox-publisher "$previous_image_id" "$previous_revision" >/dev/null
	integration_id="$(
		verify_running_service \
			integration-worker "$previous_image_id" "$previous_revision"
	)"
	verify_running_service \
		maintenance-worker \
		"$previous_maintenance_image_id" \
		"$maintenance_revision" >/dev/null
	verify_running_service \
		notification-delivery-worker \
		"$previous_notification_image_id" \
		"$notification_revision" >/dev/null

	gateway_routes_json="$(
		container_env_value "$gateway_id" GATEWAY_ROUTES_JSON
	)"
	[[ "$(encode_text_base64 "$gateway_routes_json")" == \
		"$gateway_routes_base64" ]] ||
		fail "Legacy API Gateway route manifest was not restored."
	integration_kinds="$(
		container_env_value "$integration_id" INTEGRATION_WORKER_KINDS
	)"
	[[ ",$integration_kinds," == *",mailing-email,"* &&
		",$integration_kinds," == *",mailing-telegram,"* ]] ||
		fail "Legacy integration worker does not own both mailing consumers."
	[[ -z "$(
		compose_target ps --status running -q campaigns-service \
			2>/dev/null || true
	)" ]] || fail "Campaigns service is still running after rollback."

	wait_for_revision \
		http://127.0.0.1:4200/api/v1/health/ready \
		"$previous_revision"
	wait_for_revision http://127.0.0.1:4100/health/ready ""
	wait_for_revision http://127.0.0.1:4300/health/ready "$maintenance_revision"
	wait_for_revision \
		http://127.0.0.1:4401/health/ready \
		"$notification_revision"
	[[ -n "$api_id" ]]
	assert_target_queues_absent
	assert_legacy_source_present
}

prepare_initial_restart() {
	local current_revision phase source_schema_state marker_revision
	local marker_target_volume marker_artifact

	[[ ! -e "$restart_receipt" && ! -L "$restart_receipt" ]] ||
		fail "Campaigns restart receipt already exists."
	validate_campaigns_database_cutover_marker ||
		fail "Campaigns cutover marker is invalid."
	validate_campaigns_first_cutover_staged_marker ||
		fail "Campaigns staged marker is invalid."

	phase="$(campaigns_database_marker_value phase)"
	source_schema_state="$(
		campaigns_database_marker_value source_schema_state
	)"
	marker_revision="$(campaigns_database_marker_value revision)"
	marker_target_volume="$(campaigns_database_marker_value target_volume)"
	marker_artifact="$(campaigns_database_marker_value artifact_directory)"
	current_revision="$(git -C "$server_root" rev-parse HEAD)"
	[[ "$phase" == "verified" && "$source_schema_state" == "retained" ]] ||
		fail "Campaigns restart requires rollback-complete phase=verified with retained source."
	[[ "$current_revision" == "$marker_revision" ]] ||
		fail "Campaigns restart checkout differs from the cutover revision."
	if [[ "${CAMPAIGNS_CUTOVER_REHEARSAL:-}" != "true" ]]; then
		git -C "$server_root" cat-file -e \
			"$EXPECTED_NEXT_REVISION^{commit}" 2>/dev/null ||
			fail "Campaigns next revision was not fetched before restart."
		git -C "$server_root" merge-base --is-ancestor \
			"$marker_revision" "$EXPECTED_NEXT_REVISION" ||
			fail "Campaigns next revision is not a fast-forward of the active cutover revision."
	fi
	require_campaigns_first_cutover_staged_revision "$marker_revision" ||
		fail "Campaigns staged revision differs from the cutover marker."
	[[ "$EXPECTED_NEXT_REVISION" != "$marker_revision" ||
		"${CAMPAIGNS_CUTOVER_REHEARSAL:-}" == "true" ]] ||
		fail "Campaigns restart requires a different next production revision."
	[[ "$marker_target_volume" == "$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME" ]] ||
		fail "Campaigns restart target volume is not canonical."

	old_revision="$marker_revision"
	next_revision="$EXPECTED_NEXT_REVISION"
	artifact_directory="$marker_artifact"
	target_volume="$marker_target_volume"
	switch_generation_seed="$(
		campaigns_database_marker_value switch_generation
	)"
	[[ "$switch_generation_seed" =~ ^[1-9][0-9]{0,17}$ ]] ||
		fail "Campaigns restart requires a positive switch generation."
	restart_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	validate_artifact_directory
	assert_campaigns_database_postgres_identity ||
		fail "Campaigns PostgreSQL production identity is invalid."
	verify_campaigns_postgres_container \
		"" \
		"$(campaigns_database_marker_value postgres_image_id)" \
		"$(campaigns_database_marker_value postgres_system_identifier)" ||
		fail "Campaigns PostgreSQL does not match the rollback marker."
	assert_legacy_runtime "$cutover_marker"
	archive_active_markers
	write_restart_receipt validated
}

remove_target_state() {
	local marker_file="$artifact_directory/restart-cutover-marker"
	local expected_postgres_image expected_campaigns_image cutover_started_at
	local volume_identity postgres_id campaigns_id attached

	expected_postgres_image="$(file_value "$marker_file" postgres_image_id)"
	expected_campaigns_image="$(file_value "$marker_file" target_campaigns_image_id)"
	cutover_started_at="$(file_value "$marker_file" cutover_started_at)"
	campaigns_id="$(
		compose_target ps -a -q campaigns-service 2>/dev/null || true
	)"
	if [[ -n "$campaigns_id" ]]; then
		[[ "$campaigns_id" != *$'\n'* &&
			"$(docker inspect --format '{{.State.Running}}' "$campaigns_id")" == \
				"false" &&
			"$(docker inspect --format '{{.Image}}' "$campaigns_id")" == \
				"$expected_campaigns_image" ]] ||
			fail "Stopped Campaigns service container identity is invalid."
		docker rm "$campaigns_id" >/dev/null
	fi

	postgres_id="$(
		compose_target --profile campaigns-database ps -a -q campaigns-postgres \
			2>/dev/null || true
	)"
	if ! docker volume inspect "$target_volume" >/dev/null 2>&1; then
		[[ -z "$postgres_id" ]] ||
			fail "Campaigns PostgreSQL container exists without its target volume."
		restart_rehearsal_checkpoint target-volume-removed
		write_restart_receipt target-removed
		return
	fi
	volume_identity="$(
		docker volume inspect "$target_volume" \
			--format '{{printf "%s|%s|%s|%s" (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.cutover.revision") (index .Labels "com.winwidget.cutover.started-at")}}'
	)"
	[[ "$volume_identity" == \
		"campaigns|postgres-data|$old_revision|$cutover_started_at" ]] ||
		fail "Campaigns target volume provenance is invalid."
	if [[ -n "$postgres_id" ]]; then
		[[ "$postgres_id" != *$'\n'* &&
			"$(docker inspect --format '{{.Image}}' "$postgres_id")" == \
				"$expected_postgres_image" &&
			"$(docker inspect \
				--format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' \
				"$postgres_id")" == "$target_volume" ]] ||
			fail "Campaigns PostgreSQL container identity is invalid."
		if [[ "$(docker inspect --format '{{.State.Running}}' "$postgres_id")" == \
			"true" ]]; then
			docker stop --time 60 "$postgres_id" >/dev/null
		fi
		docker rm "$postgres_id" >/dev/null
	fi

	attached="$(
		docker ps -aq --filter "volume=$target_volume"
	)"
	[[ -z "$attached" ]] ||
		fail "Another container still uses the Campaigns target volume."
	docker volume rm "$target_volume" >/dev/null
	! docker volume inspect "$target_volume" >/dev/null 2>&1 ||
		fail "Campaigns target volume still exists after exact removal."
	restart_rehearsal_checkpoint target-volume-removed
	write_restart_receipt target-removed
}

finish_restart_receipt() {
	local final_receipt="$artifact_directory/restart-receipt-final"
	if [[ "$restart_status" != "staged" ]]; then
		write_restart_receipt staged
	fi
	if [[ -e "$final_receipt" || -L "$final_receipt" ]]; then
		[[ -f "$final_receipt" && ! -L "$final_receipt" &&
			"$(stat -c '%u:%g:%a' "$final_receipt")" == "0:0:600" ]] ||
			fail "Final Campaigns restart receipt is unsafe or inconsistent."
		cmp -s "$final_receipt" "$restart_receipt" ||
			fail "Final Campaigns restart receipt is inconsistent."
	else
		install -o 0 -g 0 -m 600 "$restart_receipt" "$final_receipt"
	fi
	restart_rehearsal_checkpoint final-receipt
	rm -f -- "$restart_receipt"
	echo "Campaigns cutover attempt $old_revision was safely restarted for revision $next_revision."
}

stage_next_revision() {
	[[ "$restart_status" == "target-removed" ]] ||
		fail "Campaigns restart is not ready to stage the next revision."
	[[ -f "$cutover_marker" && ! -L "$cutover_marker" &&
		"$(sha256sum "$cutover_marker" | awk '{ print $1 }')" == \
			"$cutover_marker_sha256" ]] ||
		fail "Old Campaigns cutover marker must remain active while staging."
	if [[ -e "$staged_marker" || -L "$staged_marker" ]]; then
		if [[ -f "$staged_marker" && ! -L "$staged_marker" &&
			"$(sha256sum "$staged_marker" | awk '{ print $1 }')" == \
				"$staged_marker_sha256" ]]; then
			rm -f -- "$staged_marker"
		else
			# A resumed run may already have created the next staged marker.
			[[ -f "$staged_marker" && ! -L "$staged_marker" &&
				"$(stat -c '%u:%g:%a' "$staged_marker")" == "0:0:600" &&
				"$(file_value "$staged_marker" revision)" == "$next_revision" ]] ||
				fail "Unexpected Campaigns staged marker appeared during restart."
		fi
	fi
	! docker volume inspect "$target_volume" >/dev/null 2>&1 ||
		fail "Campaigns target volume unexpectedly reappeared before staging."

	if [[ "${CAMPAIGNS_CUTOVER_REHEARSAL:-}" != "true" ]]; then
		git -C "$server_root" checkout prod
		git -C "$server_root" merge --ff-only "$next_revision"
		[[ "$(git -C "$server_root" rev-parse HEAD)" == "$next_revision" ]] ||
			fail "Campaigns next revision checkout failed."
		[[ -z "$(
			git -C "$server_root" status --porcelain --untracked-files=all
		)" ]] || fail "Backend checkout is dirty after Campaigns restart."
	fi
	restart_rehearsal_checkpoint next-checkout

	# Reload the lifecycle implementation from the reviewed next revision.
	# shellcheck source=scripts/campaigns-database-lifecycle.sh
	source "$server_root/scripts/campaigns-database-lifecycle.sh"
	write_campaigns_first_cutover_staged_marker \
		"$next_revision" \
		"$switch_generation_seed"
	require_campaigns_first_cutover_staged_revision "$next_revision"
	[[ "$(campaigns_first_cutover_staged_value switch_generation_seed)" == \
		"$switch_generation_seed" ]] ||
		fail "Campaigns next staged marker lost the switch generation seed."
	restart_rehearsal_checkpoint next-marker-staged
	write_restart_receipt new-staged
}

finish_active_markers() {
	[[ "$restart_status" == "new-staged" ]] ||
		fail "Campaigns restart is not ready to release the old cutover marker."
	require_campaigns_first_cutover_staged_revision "$next_revision"
	[[ "$(campaigns_first_cutover_staged_value switch_generation_seed)" == \
		"$switch_generation_seed" ]] ||
		fail "Campaigns staged switch generation seed changed."
	if [[ -e "$cutover_marker" || -L "$cutover_marker" ]]; then
		[[ -f "$cutover_marker" && ! -L "$cutover_marker" &&
			"$(sha256sum "$cutover_marker" | awk '{ print $1 }')" == \
				"$cutover_marker_sha256" ]] ||
			fail "Old Campaigns cutover marker changed during restart."
		rm -f -- "$cutover_marker"
	fi
	[[ ! -e "$cutover_marker" && ! -L "$cutover_marker" ]] ||
		fail "Old Campaigns cutover marker remains after new staging."
	restart_rehearsal_checkpoint old-marker-removed
	! docker volume inspect "$target_volume" >/dev/null 2>&1 ||
		fail "Campaigns target volume exists after restart."
	assert_legacy_runtime "$artifact_directory/restart-cutover-marker"
	assert_target_queues_absent
	finish_restart_receipt
}

recognize_completed_restart() {
	local root_receipt="$restart_receipt"
	local candidate matched_receipt=""
	local matched_count=0 current_revision active_phase

	for candidate in \
		"$marker_directory"/campaigns-database-cutover.*/restart-receipt-final; do
		[[ -e "$candidate" || -L "$candidate" ]] || continue
		restart_receipt="$candidate"
		if validate_restart_receipt &&
			[[ "$(file_value "$candidate" status)" == "staged" &&
				"$(file_value "$candidate" next_revision)" == \
				"$EXPECTED_NEXT_REVISION" ]]; then
			matched_receipt="$candidate"
			((matched_count += 1))
		fi
	done
	restart_receipt="$root_receipt"
	((matched_count > 0)) || return 1
	[[ "$matched_count" == "1" ]] ||
		fail "Multiple completed Campaigns restart receipts target the same revision."
	restart_receipt="$matched_receipt"
	load_restart_receipt
	current_revision="$(git -C "$server_root" rev-parse HEAD)"
	[[ "$restart_status" == "staged" &&
		"$current_revision" == "$next_revision" ]] ||
		fail "Completed Campaigns restart receipt differs from the current checkout."

	if [[ -e "$cutover_marker" || -L "$cutover_marker" ]]; then
		validate_campaigns_database_cutover_marker ||
			fail "Campaigns lifecycle marker is invalid after completed restart."
		active_phase="$(campaigns_database_marker_value phase)"
		[[ "$(campaigns_database_marker_value revision)" == "$next_revision" &&
			"$(campaigns_database_marker_value switch_generation)" -ge \
				"$switch_generation_seed" ]] ||
			fail "Campaigns lifecycle does not continue the completed restart."
		if [[ "$active_phase" != "complete" ]]; then
			require_campaigns_first_cutover_staged_revision "$next_revision"
			[[ "$(campaigns_first_cutover_staged_value switch_generation_seed)" == \
				"$switch_generation_seed" ]] ||
				fail "Campaigns staged seed changed after the completed restart."
		fi
		echo "Campaigns restart is already complete; lifecycle phase=$active_phase."
		return 0
	fi

	require_campaigns_first_cutover_staged_revision "$next_revision"
	[[ "$(campaigns_first_cutover_staged_value switch_generation_seed)" == \
		"$switch_generation_seed" ]] ||
		fail "Completed Campaigns restart staged seed changed."
	! docker volume inspect "$target_volume" >/dev/null 2>&1 ||
		fail "Campaigns target volume exists before the restarted prepare."
	assert_legacy_runtime "$artifact_directory/restart-cutover-marker"
	assert_target_queues_absent
	echo "Campaigns restart is already complete and ready for prepare."
}

if [[ "${1:-}" == "--self-test" ]]; then
	[[ "$#" == "1" ]] ||
		fail "Usage: $0 --self-test"
	run_self_test
	exit 0
fi
[[ "$#" == "0" ]] ||
	fail "Usage: $0 [--self-test]"

validate_context
for tracked_file in \
	scripts/production-deploy-lock.sh \
	scripts/campaigns-database-lifecycle.sh \
	scripts/cutover-campaigns-database-production.sh \
	deploy/docker-compose.prod.yml; do
	if [[ "${CAMPAIGNS_CUTOVER_REHEARSAL:-}" == "true" &&
		"$tracked_file" == "deploy/docker-compose.prod.yml" ]]; then
		continue
	fi
	assert_tracked_file "$tracked_file"
done
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
	"$(stat -c '%u:%g:%a' "$ENV_FILE")" == "0:0:600" ]] ||
	fail "Production env file is missing or unsafe."
[[ -z "$(
	git -C "$server_root" status --porcelain --untracked-files=all
)" ]] || fail "Backend checkout must be clean before Campaigns restart."

# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "Campaigns database restart"
# shellcheck source=scripts/campaigns-database-lifecycle.sh
source "$server_root/scripts/campaigns-database-lifecycle.sh"

if [[ -e "$restart_receipt" || -L "$restart_receipt" ]]; then
	load_restart_receipt
elif recognize_completed_restart; then
	exit 0
else
	[[ -e "$cutover_marker" && ! -L "$cutover_marker" &&
		-e "$staged_marker" && ! -L "$staged_marker" ]] ||
		fail "Campaigns restart requires both active lifecycle markers."
	prepare_initial_restart
fi

if [[ "$restart_status" == "validated" ]]; then
	remove_target_state
fi
if [[ "$restart_status" == "target-removed" ]]; then
	assert_legacy_runtime "$artifact_directory/restart-cutover-marker"
	assert_target_queues_absent
	stage_next_revision
fi
if [[ "$restart_status" == "new-staged" ]]; then
	finish_active_markers
elif [[ "$restart_status" == "staged" ]]; then
	finish_restart_receipt
else
	fail "Campaigns restart state is invalid."
fi
