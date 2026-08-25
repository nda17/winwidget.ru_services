#!/usr/bin/env bash

# Complete, filtered Docker Compose identity for Billing lifecycle commands.
# This file is sourced by the deploy/cutover scripts and is also executable for
# its zero-dependency self-test.

BILLING_RELEASE_IDENTITY_KEYS=(
	APP_REVISION
	APP_VERSION
	MAINTENANCE_REVISION
	MAINTENANCE_IMAGE
	DATABASE_RESTORE_REVISION
	DATABASE_RESTORE_IMAGE
	NOTIFICATION_DELIVERY_REVISION
	NOTIFICATION_DELIVERY_IMAGE
	CAMPAIGNS_REVISION
	CAMPAIGNS_IMAGE
	REPORTING_REVISION
	REPORTING_IMAGE
	WIDGETS_REVISION
	WIDGETS_IMAGE
	BILLING_REVISION
	BILLING_IMAGE
)

# Production hosts intentionally run Docker only. Keep inline lifecycle
# validators available without installing a second, untracked host runtime.
# Every forwarded environment variable is named explicitly; file access is
# limited to reviewed evidence paths and individual read-only inputs.
BILLING_RELEASE_NODE_ENV_KEYS=(
	BASE_DATABASE_URL BASE_REHEARSAL_URL BILLING_ALLOW_RETIRED_ABSENT
	BILLING_CLEANUP_BILLING_BACKUP
	BILLING_CLEANUP_CORE_BACKUP BILLING_CLEANUP_GENERATION
	BILLING_CLEANUP_OFFSITE_RECEIPT BILLING_CLEANUP_PREVIOUS_REVISION
	BILLING_CLEANUP_QUEUE_DRAIN BILLING_CLEANUP_RESTORE_EVIDENCE
	BILLING_CLEANUP_RETENTION_REFERENCE BILLING_CLEANUP_REVISION
	BILLING_CLEANUP_SNAPSHOT BILLING_CLEANUP_STOPPED_WRITERS
	BILLING_DATABASE_ID BILLING_DATABASE_ID_VALUE BILLING_EXPECT_ACTIVE
	BILLING_PREVIOUS_REVISION BILLING_PROJECTION_SHA BILLING_QUEUE_MANIFEST
	BILLING_RESTORE BILLING_ROUTE_SHA BILLING_SHA BILLING_SNAPSHOT_SHA
	BILLING_SOURCE BILLING_SYSTEM_ID BILLING_WRITER_MANIFEST CAPTURED_AT
	CLEANUP_MIGRATION CLEANUP_REVISION CLEANUP_URL COMPLETION_FILE
	COMPLETION_REVISION CORE_RESTORE CORE_SHA CORE_SOURCE CORE_STATE
	CORE_SYSTEM_ID DATABASE_RESTORE_GUARD_HEALTH DATABASE_RESTORE_GUARD_MOUNTS
	DATABASE_RESTORE_GUARD_TMPFS
	DEPLOY_FILE DIRECTORY EXPECTED_CLEANUP_STATE
	EXPECTED_GENERATION EXPECTED_KIND EXPECTED_POST_SHA EXPECTED_REVISION
	EXPECTED_ROLE EXPECTED_SNAPSHOT EXPECTED_VOLUME FIELD GATEWAY_ROUTES
	MIGRATIONS_ROOT MIGRATION_LEDGER_ROWS MIGRATION_MANIFEST_JSON
	MIGRATION_SOURCE OPTIONS_URL OWNERSHIP_GENERATION POST_RECEIPT_SHA
	OPERATIONS_BACKUP_URL OPERATIONS_CLEANUP_SQL OPERATIONS_CORE_STATUS
	OPERATIONS_CUTOVER_SOURCE OPERATIONS_DATABASE_URL OPERATIONS_ENV_KEY
	OPERATIONS_ENV_PATH OPERATIONS_EXPECTED_KINDS OPERATIONS_EXPECTED_REVISION
	OPERATIONS_EXPECTED_ROLE OPERATIONS_EXPORT_JSON OPERATIONS_HEALTH_JSON
	OPERATIONS_PLATFORM_LEDGER_STATE OPERATIONS_PREP_LEDGER_STATE
	OPERATIONS_PRISMA_LEDGER OPERATIONS_PRISMA_MANIFEST
	OPERATIONS_MIGRATION_DATABASE_URL OPERATIONS_QUEUE_MODE
	OPERATIONS_QUEUE_SNAPSHOT OPERATIONS_TARGET_STATUS
	POST_RESTORE_SHA POST_SHA PREVIOUS_REVISION PRE_RECEIPT_SHA
	PROJECTION_EVIDENCE QUEUE_FILE QUEUE_LISTING
	RABBITMQ_BINDING_DESTINATIONS RABBITMQ_CONTAINER_ID RABBITMQ_IMAGE_ID
	RABBITMQ_QUEUE_NAMES RABBITMQ_RESTART_COUNT RABBITMQ_STARTED_AT
	RABBITMQ_VHOST_VALUE RECEIPT_FILE REHEARSAL_OPTIONS RESTORE_FILE
	RESTORE_KIND RESTORE_REVISION RETIRED_TOPOLOGY_SHA ROUTE_EVIDENCE
	RUNNER_SOURCE SOURCE_SNAPSHOT VERIFIED_AT WRITER_FILE WRITER_RECORDS
)
BILLING_RELEASE_NODE_FILE_ENV_KEYS=(
	BILLING_QUEUE_MANIFEST BILLING_WRITER_MANIFEST COMPLETION_FILE DEPLOY_FILE
	DIRECTORY MIGRATIONS_ROOT OPERATIONS_ENV_PATH QUEUE_FILE RECEIPT_FILE
	RESTORE_FILE WRITER_FILE
)
BILLING_RELEASE_NODE_HOST_BINARY="$(type -P node 2>/dev/null || true)"
BILLING_RELEASE_NODE_IMAGE_ID=''
BILLING_RELEASE_NODE_IMAGE_REVISION=''
BILLING_RELEASE_NODE_CONTAINER_ID=''

billing_release_host_node_available() {
	local app_root="${APP_ROOT:-/opt/winwidget}" production_env
	production_env="$app_root/deploy/backend/.env.production"
	if [[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' &&
		-f "$production_env" && ! -L "$production_env" &&
		"$(stat -c '%u:%g:%a' "$production_env" 2>/dev/null)" == '0:0:600' ]]; then
		return 1
	fi
	[[ -n "$BILLING_RELEASE_NODE_HOST_BINARY" &&
		-x "$BILLING_RELEASE_NODE_HOST_BINARY" &&
		! -L "$BILLING_RELEASE_NODE_HOST_BINARY" ]]
}

billing_release_marker_value_for_node_runtime() {
	[[ $# -eq 2 && "$2" =~ ^[a-z_]+$ && -f "$1" && ! -L "$1" ]] || return 1
	[[ "$(stat -c '%u:%g:%a' "$1" 2>/dev/null)" == '0:0:600' ]] || return 1
	awk -F= -v key="$2" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

billing_release_git_checkout_is_safe() {
	[[ $# -eq 1 && "$1" == /* && -d "$1" && ! -L "$1" &&
		-e "$1/.git" && ! -L "$1/.git" ]] || return 1
	[[ "$(git -C "$1" rev-parse --is-inside-work-tree 2>/dev/null)" == 'true' ]]
}

billing_release_node_revision_is_allowed() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local revision="$1" source_root="$2" candidate marker key value
	billing_release_git_checkout_is_safe "$source_root" || return 1
	for candidate in \
		"${EXPECTED_REVISION:-}" \
		"$(git -C "$source_root" rev-parse HEAD 2>/dev/null || true)"; do
		[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || continue
		[[ "$revision" == "$candidate" ]] && return 0
		git -C "$source_root" merge-base --is-ancestor "$revision" "$candidate" \
			2>/dev/null && return 0
	done
	for marker in \
		"${APP_ROOT:-/opt/winwidget}/deploy/backend/.billing-database-lifecycle-v1" \
		"${APP_ROOT:-/opt/winwidget}/deploy/backend/.billing-cutover-v1" \
		"${APP_ROOT:-/opt/winwidget}/deploy/backend/.billing-core-source-cleanup-v1"; do
		if [[ ! -e "$marker" && ! -L "$marker" ]]; then
			continue
		fi
		[[ -f "$marker" && ! -L "$marker" ]] || return 1
		for key in ownership_revision cleanup_revision revision previous_revision; do
			value="$(billing_release_marker_value_for_node_runtime "$marker" "$key" 2>/dev/null || true)"
			[[ "$value" =~ ^[0-9a-f]{40}$ ]] || continue
			[[ "$revision" == "$value" ]] && return 0
		done
	done
	return 1
}

billing_release_prepare_node_runtime() {
	billing_release_host_node_available && return 0
	[[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' &&
		-z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] || return 1
	local docker_binary
	docker_binary="$(type -P docker 2>/dev/null || true)"
	[[ -n "$docker_binary" && "$docker_binary" == /* &&
		"$docker_binary" =~ ^/[A-Za-z0-9._/@:+-]+$ &&
		-f "$docker_binary" && ! -L "$docker_binary" && -x "$docker_binary" ]] || return 1
	[[ "$("$docker_binary" context show)" == 'default' &&
		"$("$docker_binary" context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$("$docker_binary" info --format '{{.OSType}}')" == 'linux' ]] || return 1
	local source_root container metadata project service oneoff status running
	local restart_count image image_id image_revision image_user app_revision
	local container_revision
	source_root="${server_root:-${SERVER_ROOT:-${APP_ROOT:-/opt/winwidget}/winwidget.ru_server}}"
	billing_release_git_checkout_is_safe "$source_root" || return 1
	if [[ -n "$BILLING_RELEASE_NODE_IMAGE_ID" ]]; then
		[[ "$BILLING_RELEASE_NODE_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ &&
			"$BILLING_RELEASE_NODE_IMAGE_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
		image_id="$("$docker_binary" image inspect --format '{{.Id}}' \
			"$BILLING_RELEASE_NODE_IMAGE_ID")" || return 1
		image_revision="$("$docker_binary" image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$BILLING_RELEASE_NODE_IMAGE_ID")" || return 1
		image_user="$("$docker_binary" image inspect --format '{{.Config.User}}' \
			"$BILLING_RELEASE_NODE_IMAGE_ID")" || return 1
		[[ "$image_id" == "$BILLING_RELEASE_NODE_IMAGE_ID" &&
			"$image_revision" == "$BILLING_RELEASE_NODE_IMAGE_REVISION" &&
			"$image_user" == 'nestjs' ]] || return 1
		return
	fi
	container="$("$docker_binary" ps --all --quiet --no-trunc \
		--filter 'label=com.docker.compose.project=winwidget' \
		--filter 'label=com.docker.compose.service=maintenance-worker' \
		--filter 'label=com.docker.compose.oneoff=False')" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	metadata="$("$docker_binary" inspect --format \
		'{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Image}}' \
		"$container")" || return 1
	IFS='|' read -r project service oneoff status running restart_count \
		container_revision image <<<"$metadata"
	app_revision="$("$docker_binary" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '
			$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 }
			END { exit(found == 1 ? 0 : 1) }
	')" || return 1
	[[ "$project" == 'winwidget' && "$service" == 'maintenance-worker' &&
		"$oneoff" =~ ^[Ff]alse$ && "$status" =~ ^(running|exited)$ &&
		( "$running" == 'true' || "$running" == 'false' ) &&
		"$restart_count" == '0' && "$container_revision" =~ ^[0-9a-f]{40}$ &&
		"$image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	[[ ( "$status" == 'running' && "$running" == 'true' ) ||
		( "$status" == 'exited' && "$running" == 'false' ) ]] || return 1
	image_id="$("$docker_binary" image inspect --format '{{.Id}}' "$image")" || return 1
	image_revision="$("$docker_binary" image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	image_user="$("$docker_binary" image inspect --format '{{.Config.User}}' "$image")" || return 1
	[[ "$image_id" == "$image" && "$image_revision" =~ ^[0-9a-f]{40}$ &&
		"$container_revision" == "$image_revision" &&
		"$app_revision" == "$image_revision" && "$image_user" == 'nestjs' ]] || return 1
	billing_release_node_revision_is_allowed "$image_revision" "$source_root" || return 1
	BILLING_RELEASE_NODE_IMAGE_ID="$image_id"
	BILLING_RELEASE_NODE_IMAGE_REVISION="$image_revision"
	BILLING_RELEASE_NODE_CONTAINER_ID="$container"
}

billing_release_node_path_is_safe() {
	[[ $# -eq 1 && "$1" == /* && "$1" =~ ^/[A-Za-z0-9._/@:+-]+$ &&
		"/$1/" != *'/../'* && "/$1/" != *'/./'* && "$1" != *'//'* ]]
}

billing_release_node_existing_path_is_safe() {
	[[ $# -eq 1 ]] || return 1
	local path="$1" canonical
	billing_release_node_path_is_safe "$path" || return 1
	[[ ( -f "$path" || -d "$path" ) && ! -L "$path" ]] || return 1
	if [[ -d "$path" ]]; then
		canonical="$(cd -- "$path" && pwd -P)" || return 1
	else
		canonical="$(cd -- "$(dirname -- "$path")" && pwd -P)/$(basename -- "$path")" || return 1
	fi
	[[ "$canonical" == "$path" ]]
}

billing_release_node_path_within() {
	[[ $# -eq 2 && ( "$1" == "$2" || "$1" == "$2/"* ) ]]
}

billing_release_node_input_path_is_allowed() {
	[[ $# -eq 3 ]] || return 1
	local path="$1" app_root="$2" source_root="$3"
	billing_release_node_existing_path_is_safe "$path" || return 1
	if [[ "$path" == "$source_root/prisma/migrations" ]]; then
		[[ -d "$path" ]]
		return
	fi
	if [[ "$path" == "$app_root/deploy/backend/.env.production" ]]; then
		[[ -f "$path" && "$(stat -c '%u:%g:%a:%h' "$path")" == '0:0:600:1' ]]
		return
	fi
	if billing_release_node_path_within "$path" \
		"$app_root/deploy/backend/billing-core-source-cleanup"; then
		[[ -f "$path" || ( -d "$path" &&
			"$(stat -c '%u:%g:%a' "$path")" == '0:0:700' ) ]]
		return
	fi
	[[ -f "$path" && "$path" =~ ^/root/winwidget-billing-[A-Za-z0-9._+-]+\.json$ ]]
}

billing_release_node_docker() (
	local read_stdin=false
	if [[ "${1:-}" == '--billing-release-read-stdin' ]]; then
		read_stdin=true
		shift
	fi
	[[ $# -ge 1 ]] || return 1
	billing_release_prepare_node_runtime || return 1
	local app_root cleanup_root path variable argument mapped index existing docker_binary
	local cleanup_needed=false
	local -a original_args=() mapped_args=() referenced_paths=() host_paths=()
	local -a container_paths=() docker_args=()
	app_root="${APP_ROOT:-/opt/winwidget}"
	docker_binary="$(type -P docker 2>/dev/null || true)"
	[[ -n "$docker_binary" && -f "$docker_binary" && ! -L "$docker_binary" &&
		-x "$docker_binary" ]] || return 1
	cleanup_root="$app_root/deploy/backend/billing-core-source-cleanup"
	original_args=("$@")
	for argument in "${original_args[@]}"; do
		[[ "$argument" == /* ]] && referenced_paths+=("$argument")
	done
	for variable in "${BILLING_RELEASE_NODE_FILE_ENV_KEYS[@]}"; do
		path="${!variable:-}"
		[[ -n "$path" ]] || continue
		[[ "$path" == /* ]] || return 1
		referenced_paths+=("$path")
	done
	if ((${#referenced_paths[@]})); then
	for path in "${referenced_paths[@]}"; do
		billing_release_node_path_is_safe "$path" || return 1
		if [[ "$path" == "$cleanup_root" ]]; then
			cleanup_needed=true
			continue
		fi
		billing_release_node_input_path_is_allowed "$path" "$app_root" \
			"${server_root:-${SERVER_ROOT:-$app_root/winwidget.ru_server}}" || return 1
		if ((${#host_paths[@]})); then
		for existing in "${host_paths[@]}"; do
			[[ "$existing" == "$path" ]] && continue 2
		done
		fi
		host_paths+=("$path")
		container_paths+=("/billing-node-input-${#container_paths[@]}")
	done
	fi
	if [[ "$cleanup_needed" == 'true' ]]; then
		billing_release_node_existing_path_is_safe "$cleanup_root" || return 1
		[[ "$(stat -c '%u:%g:%a' "$cleanup_root")" == '0:0:700' ]] || return 1
		host_paths+=("$cleanup_root")
		container_paths+=('/billing-node-cleanup')
	fi
	docker_args=(
		run --rm --network none --read-only --cap-drop ALL
		--pids-limit 64 --cpus 1 --memory 512m --memory-swap 512m
		--log-driver none --user 0:0 --security-opt no-new-privileges
		--entrypoint node
	)
	if [[ "$read_stdin" == 'true' ]]; then
		docker_args+=(--interactive)
	fi
	if ((${#host_paths[@]})); then
	for index in "${!host_paths[@]}"; do
		path="${host_paths[$index]}"
		mapped="${container_paths[$index]}"
		docker_args+=(--mount "type=bind,source=$path,target=$mapped,readonly")
	done
	fi
	for argument in "${original_args[@]}"; do
		mapped="$argument"
		if [[ "$argument" == /* ]]; then
			if ((${#host_paths[@]})); then
			for index in "${!host_paths[@]}"; do
				path="${host_paths[$index]}"
				if billing_release_node_path_within "$argument" "$path"; then
					mapped="${container_paths[$index]}${argument#$path}"
					break
				fi
			done
			fi
		fi
		mapped_args+=("$mapped")
	done
	for variable in "${BILLING_RELEASE_NODE_ENV_KEYS[@]}"; do
		[[ -n "${!variable+x}" ]] || continue
		if ((${#host_paths[@]})); then
		for index in "${!host_paths[@]}"; do
			path="${host_paths[$index]}"
			if billing_release_node_path_within "${!variable}" "$path"; then
				printf -v "$variable" '%s' "${container_paths[$index]}${!variable#$path}"
				break
			fi
		done
		fi
		export "${variable?}"
		docker_args+=(--env "$variable")
	done
	"$docker_binary" "${docker_args[@]}" \
		"$BILLING_RELEASE_NODE_IMAGE_ID" "${mapped_args[@]}"
)

billing_release_node() {
	[[ $# -ge 1 ]] || return 1
	if billing_release_host_node_available; then
		"$BILLING_RELEASE_NODE_HOST_BINARY" "$@"
		return
	fi
	billing_release_prepare_node_runtime || return 1
	if [[ "$1" == '-' ]]; then
		billing_release_node_docker --billing-release-read-stdin "$@"
	else
		billing_release_node_docker "$@"
	fi
}

billing_release_node_stdin() {
	[[ $# -ge 2 && "$1" == '-e' ]] || return 1
	if billing_release_host_node_available; then
		"$BILLING_RELEASE_NODE_HOST_BINARY" "$@"
		return
	fi
	billing_release_prepare_node_runtime || return 1
	billing_release_node_docker --billing-release-read-stdin "$@"
}

billing_release_node_runtime_self_test() (
	local original_host_binary="$BILLING_RELEASE_NODE_HOST_BINARY" revision source_root
	local expected_image output log log_file output_file
	local safe_input fixture_directory mock_directory real_bash real_git
	local checkout_revision predecessor_revision
	expected_image="sha256:$(printf '1%.0s' {1..64})"
	revision='0123456789abcdef0123456789abcdef01234567'
	source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
	checkout_revision="$(git -C "$source_root" rev-parse HEAD 2>/dev/null || true)"
	predecessor_revision="$(git -C "$source_root" rev-parse HEAD^ 2>/dev/null || true)"
	if [[ "$checkout_revision" =~ ^[0-9a-f]{40}$ &&
		"$predecessor_revision" =~ ^[0-9a-f]{40}$ ]]; then
		EXPECTED_REVISION="$checkout_revision"
		billing_release_node_revision_is_allowed "$predecessor_revision" "$source_root" ||
			return 1
	fi
	BILLING_RELEASE_NODE_HOST_BINARY=''
	BILLING_RELEASE_NODE_IMAGE_ID=''
	BILLING_RELEASE_NODE_IMAGE_REVISION=''
	BILLING_RELEASE_NODE_CONTAINER_ID=''
	EXPECTED_REVISION="$revision"
	fixture_directory="$(mktemp -d "${TMPDIR:-/tmp}/billing-node-runtime-fixture.XXXXXX")"
	fixture_directory="$(cd -- "$fixture_directory" && pwd -P)"
	APP_ROOT="$fixture_directory"
	server_root="$source_root"
	mkdir -p "$APP_ROOT/deploy/backend/billing-core-source-cleanup/test-g2"
	chmod 700 "$APP_ROOT/deploy/backend/billing-core-source-cleanup" \
		"$APP_ROOT/deploy/backend/billing-core-source-cleanup/test-g2"
	safe_input="$APP_ROOT/deploy/backend/billing-core-source-cleanup/test-g2/node-runtime-evidence.json"
	printf '{}\n' >"$safe_input"
	log_file="$(mktemp "${TMPDIR:-/tmp}/billing-node-runtime-log.XXXXXX")"
	output_file="$(mktemp "${TMPDIR:-/tmp}/billing-node-runtime-output.XXXXXX")"
	mock_directory="$(mktemp -d "${TMPDIR:-/tmp}/billing-node-runtime-bin.XXXXXX")"
	mock_directory="$(cd -- "$mock_directory" && pwd -P)"
	real_bash="$(type -P bash)"
	real_git="$(type -P git)"
	trap 'rm -f -- "$log_file" "$output_file" "$safe_input" "$mock_directory/docker" "$mock_directory/id" "$mock_directory/uname"; rmdir -- "$APP_ROOT/deploy/backend/billing-core-source-cleanup/test-g2" "$APP_ROOT/deploy/backend/billing-core-source-cleanup" "$APP_ROOT/deploy/backend" "$APP_ROOT/deploy" "$APP_ROOT" "$mock_directory"' EXIT
	cat >"$mock_directory/id" <<'MOCK'
#!/usr/bin/env bash
[[ "$1" == '-u' ]] && printf '0\n'
MOCK
	cat >"$mock_directory/uname" <<'MOCK'
#!/usr/bin/env bash
[[ "$1" == '-s' ]] && printf 'Linux\n'
MOCK
	cat >"$mock_directory/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$BILLING_NODE_TEST_LOG"
case "$1 $2" in
'context show') printf 'default\n' ;;
'context inspect') printf 'unix:///var/run/docker.sock\n' ;;
'info --format') printf 'linux\n' ;;
'ps --all') printf '%064d\n' 2 ;;
'inspect --format')
	if [[ "$3" == *'.State.Status'* ]]; then
		printf 'winwidget|maintenance-worker|False|running|true|0|%s|%s\n' \
			"$BILLING_NODE_TEST_REVISION" "$BILLING_NODE_TEST_IMAGE"
	elif [[ "$3" == *'.Config.Env'* ]]; then
		printf 'APP_REVISION=%s\n' "$BILLING_NODE_TEST_REVISION"
	else
		exit 1
	fi
	;;
'image inspect')
	if [[ "$4" == '{{.Id}}' ]]; then
		printf '%s\n' "$BILLING_NODE_TEST_IMAGE"
	elif [[ "$4" == *'org.opencontainers.image.revision'* ]]; then
		printf '%s\n' "$BILLING_NODE_TEST_REVISION"
	elif [[ "$4" == '{{.Config.User}}' ]]; then
		printf 'nestjs\n'
	else
		exit 1
	fi
	;;
run\ --rm*)
	if [[ "$*" == *' --interactive '* && "${*: -1}" == '-' ]]; then
		printf 'heredoc-ok'
	elif [[ "$*" == *' --interactive '* ]]; then
		cat
	elif [[ -n "${FIELD:-}" ]]; then
		printf '%s' "$FIELD"
	else
		printf '%s' "${RECEIPT_FILE:-}"
	fi
	;;
*) exit 1 ;;
esac
MOCK
	chmod 700 "$mock_directory/docker" "$mock_directory/id" "$mock_directory/uname"
	export BILLING_NODE_TEST_LOG="$log_file" BILLING_NODE_TEST_IMAGE="$expected_image"
	export BILLING_NODE_TEST_REVISION="$revision"
	PATH="$mock_directory:$(dirname -- "$real_bash"):$(dirname -- "$real_git"):/usr/bin:/bin"
	DATABASE_RESTORE_GUARD_TMPFS='{}' FIELD=protocol billing_release_node -e \
		'process.stdout.write(process.env.FIELD)' >"$output_file"
	output="$(<"$output_file")"
	[[ "$output" == 'protocol' ]] || return 1
	[[ "$(printf 'stdin-ok' | billing_release_node_stdin -e \
		'process.stdout.write(require("node:fs").readFileSync(0, "utf8"))')" == \
		'stdin-ok' ]] || return 1
	[[ "$(billing_release_node_stdin -e \
		'process.stdout.write(require("node:fs").readFileSync(0, "utf8"))' \
		<<<'heredoc-ok')" == 'heredoc-ok' ]] || return 1
	[[ "$(billing_release_node - <<'NODE'
process.stdout.write('heredoc-ok');
NODE
	)" == 'heredoc-ok' ]] || return 1
	: >"$output_file"
	RECEIPT_FILE="$safe_input" EXPECTED_KIND=pre billing_release_node -e \
		'process.stdout.write(process.env.RECEIPT_FILE)' >"$output_file"
	output="$(<"$output_file")"
	[[ "$output" == '/billing-node-input-0' ]] || return 1
	! billing_release_node >/dev/null 2>&1
	! billing_release_node_stdin >/dev/null 2>&1
	log="$(<"$log_file")"
	[[ "$log" == *'run --rm --network none --read-only --cap-drop ALL'* &&
		"$log" == *' --interactive '* &&
		"$log" == *'--pids-limit 64 --cpus 1 --memory 512m --memory-swap 512m'* &&
		"$log" == *'--log-driver none'* &&
		"$log" == *'--security-opt no-new-privileges --entrypoint node'* &&
		"$log" == *'--env FIELD'* && "$log" == *'--env RECEIPT_FILE'* &&
		"$log" == *'--env EXPECTED_KIND'* &&
		"$log" == *'--env DATABASE_RESTORE_GUARD_TMPFS'* &&
		"$(awk '$1 == "run" && /--interactive/ { count += 1 } END { print count + 0 }' \
			"$log_file")" == '3' &&
		"$(awk '$1 == "run" && /--interactive/ && $NF == "-" { count += 1 } \
			END { print count + 0 }' "$log_file")" == '1' &&
		"$(awk '$1 == "run" && !/--interactive/ { count += 1 } END { print count + 0 }' \
			"$log_file")" == '2' &&
		"$log" == *"type=bind,source=$safe_input,target=/billing-node-input-0,readonly"* &&
		"$(awk '$1 == "ps" && $2 == "--all" { count += 1 } END { print count + 0 }' \
			"$log_file")" == '1' ]] || return 1
	[[ "$BILLING_RELEASE_NODE_CONTAINER_ID" == "$(printf '%064d' 2)" ]] || return 1
	RECEIPT_FILE="$source_root/package.json" \
		! billing_release_node -e 'process.exit(0)' >/dev/null 2>&1
	BILLING_RELEASE_NODE_IMAGE_ID='sha256:short'
	! billing_release_prepare_node_runtime >/dev/null 2>&1
	BILLING_RELEASE_NODE_HOST_BINARY='/missing/node'
	BILLING_RELEASE_NODE_IMAGE_ID=''
	BILLING_RELEASE_NODE_IMAGE_REVISION=''
	BILLING_RELEASE_NODE_CONTAINER_ID=''
	FIELD=schema billing_release_node -e \
		'process.stdout.write(process.env.FIELD)' >"$output_file"
	[[ "$(<"$output_file")" == 'schema' ]] || return 1
	BILLING_RELEASE_NODE_HOST_BINARY="$original_host_binary"
)

billing_release_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

billing_release_validate_revision() {
	[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] ||
		billing_release_fail \
			'Billing release identity requires an exact lowercase 40-character Git SHA.'
}

billing_release_identity_value() {
	local key="${1:-}" revision="${2:-}"
	billing_release_validate_revision "$revision" || return 1
	case "$key" in
	APP_REVISION | MAINTENANCE_REVISION | DATABASE_RESTORE_REVISION | \
		NOTIFICATION_DELIVERY_REVISION | CAMPAIGNS_REVISION | REPORTING_REVISION | \
		WIDGETS_REVISION | BILLING_REVISION)
		printf '%s' "$revision"
		;;
	APP_VERSION) printf 'git-%s' "$revision" ;;
	MAINTENANCE_IMAGE) printf 'winwidget-maintenance:git-%s' "$revision" ;;
	DATABASE_RESTORE_IMAGE)
		printf 'winwidget-database-restore:git-%s' "$revision"
		;;
	NOTIFICATION_DELIVERY_IMAGE)
		printf 'winwidget-notification-delivery:git-%s' "$revision"
		;;
	CAMPAIGNS_IMAGE) printf 'winwidget-campaigns:git-%s' "$revision" ;;
	REPORTING_IMAGE) printf 'winwidget-reporting:git-%s' "$revision" ;;
	WIDGETS_IMAGE) printf 'winwidget-widgets:git-%s' "$revision" ;;
	BILLING_IMAGE) printf 'winwidget-billing:git-%s' "$revision" ;;
	*) billing_release_fail "Unknown Billing release identity key: $key" ;;
	esac
}

billing_release_validate_paths() {
	local env_file="${1:-}" compose_file="${2:-}"
	[[ "$env_file" == /* && -f "$env_file" && ! -L "$env_file" ]] ||
		billing_release_fail \
			'Billing Compose requires an absolute regular non-symlink env file.'
	[[ "$compose_file" == /* && -f "$compose_file" && ! -L "$compose_file" ]] ||
		billing_release_fail \
			'Billing Compose requires an absolute regular non-symlink Compose file.'
	if [[ "${BILLING_REQUIRE_ROOT_OWNED_ENV:-false}" == 'true' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$env_file")" == '0:0:600' ]] ||
			billing_release_fail \
				'Production Billing env file must be root-owned with mode 600.'
	fi
}

billing_release_reject_ambient_compose_controls() {
	local key
	for key in COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME \
		COMPOSE_PATH_SEPARATOR COMPOSE_IGNORE_ORPHANS COMPOSE_REMOVE_ORPHANS \
		DOCKER_CONTEXT DOCKER_HOST; do
		if printenv "$key" >/dev/null 2>&1; then
			billing_release_fail \
				"Ambient production Compose override is forbidden: $key"
			return 1
		fi
	done
}

billing_compose() {
	[[ $# -ge 4 ]] || {
		billing_release_fail \
			'Usage: billing_compose REVISION ENV_FILE COMPOSE_FILE COMPOSE_ARGS...'
		return 1
	}
	local revision="$1" env_file="$2" compose_file="$3" key value
	local -a clean_environment
	shift 3
	billing_release_validate_revision "$revision" || return 1
	billing_release_validate_paths "$env_file" "$compose_file" || return 1
	billing_release_reject_ambient_compose_controls || return 1
	clean_environment=(
		env -i
		"PATH=$PATH"
		'COMPOSE_PROJECT_NAME=winwidget'
	)
	for key in "${BILLING_RELEASE_IDENTITY_KEYS[@]}"; do
		value="$(billing_release_identity_value "$key" "$revision")" || return 1
		clean_environment+=("$key=$value")
	done
	"${clean_environment[@]}" docker compose \
		--project-name winwidget \
		--env-file "$env_file" \
		-f "$compose_file" \
		"$@"
}

billing_compose_config_all_profiles() {
	[[ $# -eq 3 ]] || return 1
	local revision="$1" env_file="$2" compose_file="$3"
	billing_compose "$revision" "$env_file" "$compose_file" \
		--profile notification-delivery-database \
		--profile campaigns-database \
		--profile reporting-database \
		--profile widgets-database \
		--profile billing-database \
		--profile migration \
		--profile notification-delivery-migration \
		--profile campaigns-migration \
		--profile reporting-migration \
		--profile widgets-migration \
		--profile billing-migration \
		config --quiet
}

billing_read_env_value() {
	[[ $# -eq 2 && "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
	local env_file="$1" key="$2"
	billing_release_validate_paths "$env_file" \
		"${BILLING_COMPOSE_FILE_FOR_ENV_VALIDATION:-${COMPOSE_FILE:-/dev/null}}" \
		2>/dev/null || {
		[[ "$env_file" == /* && -f "$env_file" && ! -L "$env_file" ]] || return 1
	}
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$env_file"
}

billing_normalize_libpq_url_value() {
	[[ $# -eq 1 ]] || return 1
	printf '%s\n' "$1" | billing_release_node_stdin -e '
		const fs = require("node:fs");
		const raw = fs.readFileSync(0, "utf8");
		if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) process.exit(1);
		let url;
		try { url = new URL(raw.slice(0, -1)); } catch { process.exit(1); }
		if (!["postgresql:", "postgres:"].includes(url.protocol)) process.exit(1);
		for (const key of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) {
			url.searchParams.delete(key);
		}
		process.stdout.write(url.toString());
	'
}

billing_libpq_url_from_env() {
	[[ $# -eq 2 ]] || return 1
	local value
	value="$(billing_read_env_value "$1" "$2")" || return 1
	billing_normalize_libpq_url_value "$value"
}

billing_release_identity_self_test() {
	local revision='0123456789abcdef0123456789abcdef01234567' key value source
	billing_release_validate_revision "$revision"
	if billing_release_validate_revision short >/dev/null 2>&1; then
		billing_release_fail 'Billing release self-test accepted a short revision.'
		return 1
	fi
	for key in "${BILLING_RELEASE_IDENTITY_KEYS[@]}"; do
		value="$(billing_release_identity_value "$key" "$revision")" || return 1
		[[ -n "$value" && "$value" == *"$revision"* ]] || return 1
	done
	[[ "$(billing_normalize_libpq_url_value \
		'postgresql://runtime:password@127.0.0.1:55437/winwidget_billing?schema=billing&connection_limit=5&sslmode=require')" == \
		'postgresql://runtime:password@127.0.0.1:55437/winwidget_billing?sslmode=require' ]] || return 1
	source="$(declare -f billing_compose billing_compose_config_all_profiles)"
	[[ "$source" == *'env -i'* &&
		"$source" == *'--project-name winwidget'* &&
		"$source" == *'--profile billing-database'* &&
		"$source" == *'--profile billing-migration'* &&
		"$source" == *'config --quiet'* ]] || return 1
	(
		export COMPOSE_PROFILES=billing-database
		if billing_release_reject_ambient_compose_controls >/dev/null 2>&1; then
			exit 1
		fi
	)
	billing_release_node_runtime_self_test || return 1
	printf 'billing_release_identity_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -Eeuo pipefail
	case "${1:-}" in
	--self-test) billing_release_identity_self_test ;;
	*) billing_release_fail 'Usage: billing-release-identity.sh --self-test' ;;
	esac
fi
