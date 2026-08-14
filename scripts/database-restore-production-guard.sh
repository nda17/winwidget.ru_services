#!/usr/bin/env bash

# Shared read-only gate for routine production changes. Restore execution has a
# separate reviewed control path; deploy and lifecycle scripts must only run
# while that path is disabled and its durable state is quiescent.

database_restore_guard_fail() {
	echo "$1" >&2
	return 1
}

database_restore_guard_validate_env_file() {
	local env_file="$1"

	[[ -f "$env_file" && ! -L "$env_file" ]] || {
		database_restore_guard_fail \
			'Database restore guard requires a regular non-symlink production env file.'
		return 1
	}
	LC_ALL=C awk '
		/^[[:space:]]*(export[[:space:]]+)?DATABASE_RESTORE_PRODUCTION_ENABLED[[:space:]]*=/ {
			enabled_count += 1
			if ($0 == "DATABASE_RESTORE_PRODUCTION_ENABLED=false") enabled_valid += 1
		}
		/^[[:space:]]*(export[[:space:]]+)?DATABASE_RESTORE_PRODUCTION_PERMIT[[:space:]]*=/ {
			permit_count += 1
			if ($0 == "DATABASE_RESTORE_PRODUCTION_PERMIT=") permit_valid += 1
		}
		END {
			exit(enabled_count == 1 && enabled_valid == 1 &&
				permit_count == 1 && permit_valid == 1 ? 0 : 1)
		}
	' "$env_file" || {
		database_restore_guard_fail \
			'Routine production changes require exact DATABASE_RESTORE_PRODUCTION_ENABLED=false and an empty DATABASE_RESTORE_PRODUCTION_PERMIT.'
		return 1
	}
}

database_restore_guard_validate_terminal_evidence_directory() {
	local directory_path="$1"
	local evidence_kind="$2"
	local entries entry file_name

	if [[ ! -e "$directory_path" && ! -L "$directory_path" ]]; then
		return 0
	fi
	[[ -d "$directory_path" && ! -L "$directory_path" ]] || {
		database_restore_guard_fail \
			"Database restore $evidence_kind directory is unsafe."
		return 1
	}
	if ! entries="$(
		find "$directory_path" -mindepth 1 -maxdepth 1 -print 2>/dev/null
	)"; then
		database_restore_guard_fail \
			"Database restore $evidence_kind directory cannot be inspected."
		return 1
	fi
	while IFS= read -r entry; do
		[[ -n "$entry" ]] || continue
		file_name="${entry##*/}"
		if [[ "$evidence_kind" == 'permit' &&
			"$file_name" == 'active.json' ]]; then
			database_restore_guard_fail \
				'Database restore active production permit blocks routine production changes.'
			return 1
		fi
		[[ -f "$entry" && ! -L "$entry" ]] || {
			database_restore_guard_fail \
				"Database restore $evidence_kind artifact is unsafe: $file_name"
			return 1
		}
		case "$evidence_kind" in
		permit)
			[[ "$file_name" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.consumed\.json$ ]] || {
				database_restore_guard_fail \
					"Unexpected database restore permit artifact blocks routine production changes: $file_name"
				return 1
			}
			;;
		receipt)
			[[ "$file_name" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$ ]] || {
				database_restore_guard_fail \
					"Unexpected database restore publish receipt blocks routine production changes: $file_name"
				return 1
			}
			;;
		*) return 1 ;;
		esac
	done <<<"$entries"
}

database_restore_guard_validate_quiescent_state() {
	local app_root="$1"
	local control_marker storage_path directory active_entry

	case "$app_root" in
	/*)
		[[ "$app_root" != '/' ]] || {
			database_restore_guard_fail 'Database restore guard APP_ROOT is not scoped.'
			return 1
		}
		;;
	*)
		database_restore_guard_fail 'Database restore guard APP_ROOT must be absolute.'
		return 1
		;;
	esac
	control_marker="$app_root/deploy/backend/.database-restore-control-v1"
	storage_path="$app_root/deploy/backend/database-restores"

	if [[ -e "$control_marker" || -L "$control_marker" ]]; then
		database_restore_guard_fail \
			'Database restore control marker is present; routine production changes are blocked.'
		return 1
	fi
	if [[ ! -e "$storage_path" && ! -L "$storage_path" ]]; then
		return 0
	fi
	[[ -d "$storage_path" && ! -L "$storage_path" ]] || {
		database_restore_guard_fail \
			'Database restore storage is not a regular scoped directory.'
		return 1
	}

	for directory in queued processing locks gates fences; do
		if [[ ! -e "$storage_path/$directory" &&
			! -L "$storage_path/$directory" ]]; then
			continue
		fi
		[[ -d "$storage_path/$directory" &&
			! -L "$storage_path/$directory" ]] || {
			database_restore_guard_fail \
				"Database restore state directory is unsafe: $directory"
			return 1
		}
		if ! active_entry="$(
			find "$storage_path/$directory" -mindepth 1 -maxdepth 1 \
				-print -quit 2>/dev/null
		)"; then
			database_restore_guard_fail \
				"Database restore state directory cannot be inspected: $directory"
			return 1
		fi
		if [[ -n "$active_entry" ]]; then
			database_restore_guard_fail \
				"Routine production changes are blocked by database restore state in $directory."
			return 1
		fi
	done

	# A claimed production permit is active state. Per-job consumed permits and
	# publish receipts are immutable terminal audit evidence and must not freeze
	# every later routine deployment.
	database_restore_guard_validate_terminal_evidence_directory \
		"$storage_path/permits" permit || return 1
	database_restore_guard_validate_terminal_evidence_directory \
		"$storage_path/receipts" receipt || return 1
}

database_restore_guard_list_owned_container_ids() {
	local service="$1"
	docker ps -a --no-trunc \
		--filter 'label=com.docker.compose.project=winwidget' \
		--filter "label=com.docker.compose.service=$service" \
		--format '{{.ID}}'
}

database_restore_guard_container_snapshot() {
	local container_id="$1"
	docker inspect --format \
		'{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.container-number"}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
		"$container_id"
}

database_restore_guard_container_env() {
	local container_id="$1"
	docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container_id"
}

database_restore_guard_image_revision() {
	local image_id="$1"
	docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$image_id"
}

database_restore_guard_require_docker_cli() {
	command -v docker >/dev/null 2>&1
}

database_restore_guard_validate_exact_env_value() {
	local env_snapshot="$1"
	local key="$2"
	local expected="$3"

	printf '%s\n' "$env_snapshot" | LC_ALL=C awk -F= \
		-v key="$key" -v expected="$expected" '
		$1 == key {
			count += 1
			value = substr($0, index($0, "=") + 1)
		}
		END { exit(count == 1 && value == expected ? 0 : 1) }
	'
}

database_restore_guard_resolve_singleton() {
	local service="$1"
	local required="$2"
	local container_ids

	database_restore_guard_require_docker_cli || {
		database_restore_guard_fail \
			'Database restore guard requires the Docker CLI.'
		return 1
	}
	if ! container_ids="$(
		database_restore_guard_list_owned_container_ids "$service"
	)"; then
		database_restore_guard_fail \
			"Database restore guard could not list the owned $service container."
		return 1
	fi
	if [[ -z "$container_ids" ]]; then
		if [[ "$required" == 'true' ]]; then
			database_restore_guard_fail \
				"Database restore guard requires exactly one owned $service container."
			return 1
		fi
		return 2
	fi
	if [[ "$container_ids" == *$'\n'* ||
		! "$container_ids" =~ ^[0-9a-f]{64}$ ]]; then
		database_restore_guard_fail \
			"Database restore guard found an ambiguous owned $service container set."
		return 1
	fi
	printf '%s\n' "$container_ids"
}

database_restore_guard_has_env_key() {
	local env_snapshot="$1"
	local key="$2"

	printf '%s\n' "$env_snapshot" | LC_ALL=C awk -F= -v key="$key" '
		$1 == key { count += 1 }
		END { exit(count > 0 ? 0 : 1) }
	'
}

database_restore_guard_validate_live_api() {
	local worker_mode="${1:-healthy-required}"
	local worker_present="${2:-unknown}"
	local container_id resolve_status snapshot env_snapshot image_revision
	local actual_id name project service replica owner purpose image_id
	local container_revision running health

	if container_id="$(
		database_restore_guard_resolve_singleton api false
	)"; then
		:
	else
		resolve_status=$?
		[[ "$resolve_status" == '2' ]] && return 0
		return "$resolve_status"
	fi
	if ! snapshot="$(database_restore_guard_container_snapshot "$container_id")" ||
		! env_snapshot="$(database_restore_guard_container_env "$container_id")"; then
		database_restore_guard_fail \
			'Database restore guard could not inspect the owned API container.'
		return 1
	fi
	IFS='|' read -r actual_id name project service replica owner purpose image_id \
		container_revision running health <<<"$snapshot"
	: "$owner" "$purpose" "$running" "$health"
	[[ "$actual_id" == "$container_id" &&
		"$name" == '/winwidget-api-1' &&
		"$project" == 'winwidget' && "$service" == 'api' &&
		"$replica" == '1' &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$container_revision" =~ ^[0-9a-f]{40}$ ]] || {
		database_restore_guard_fail \
			'Database restore guard rejected the API container identity.'
		return 1
	}
	if ! image_revision="$(
		database_restore_guard_image_revision "$image_id"
	)"; then
		database_restore_guard_fail \
			'Database restore guard could not inspect the API image revision.'
		return 1
	fi
	[[ "$image_revision" == "$container_revision" ]] || {
		database_restore_guard_fail \
			'Database restore guard found mismatched API image revisions.'
		return 1
	}
	database_restore_guard_validate_exact_env_value \
		"$env_snapshot" APP_REVISION "$container_revision" || {
		database_restore_guard_fail \
			'Database restore guard found an invalid API APP_REVISION.'
		return 1
	}
	if ! database_restore_guard_validate_exact_env_value \
		"$env_snapshot" DATABASE_RESTORE_PRODUCTION_ENABLED false; then
		if database_restore_guard_has_env_key \
			"$env_snapshot" DATABASE_RESTORE_PRODUCTION_ENABLED; then
			database_restore_guard_fail \
				'Live API contains an invalid, duplicate or enabled DATABASE_RESTORE_PRODUCTION_ENABLED value.'
			return 1
		fi
		if [[ "$worker_mode" == 'identity-if-present' &&
			"$worker_present" == 'false' ]]; then
			# Narrow first-rollout bootstrap: the legacy API cannot create a restore
			# job because no restore worker exists, while the env file and durable
			# state have already been proven disabled and quiescent.
			return 0
		fi
		database_restore_guard_fail \
			'Live API is missing DATABASE_RESTORE_PRODUCTION_ENABLED=false outside the legacy bootstrap state.'
		return 1
	fi
	if database_restore_guard_validate_exact_env_value \
		"$env_snapshot" DATABASE_RESTORE_PRODUCTION_PERMIT ''; then
		return 0
	fi
	if database_restore_guard_has_env_key \
		"$env_snapshot" DATABASE_RESTORE_PRODUCTION_PERMIT; then
		database_restore_guard_fail \
			'Live API contains a non-empty or duplicate DATABASE_RESTORE_PRODUCTION_PERMIT value.'
		return 1
	fi
	if [[ "$worker_mode" == 'identity-if-present' &&
		"$worker_present" == 'false' ]]; then
		return 0
	fi
	database_restore_guard_fail \
		'Live API is missing an empty DATABASE_RESTORE_PRODUCTION_PERMIT outside the legacy bootstrap state.'
	return 1
}

database_restore_guard_validate_worker() {
	local mode="$1"
	local required=false require_health=false
	local container_id resolve_status snapshot env_snapshot image_revision
	local actual_id name project service replica owner purpose image_id
	local container_revision running health

	DATABASE_RESTORE_GUARD_WORKER_PRESENT=unknown
	case "$mode" in
	identity-if-present)
		;;
	healthy-if-present)
		require_health=true
		;;
	healthy-required)
		required=true
		require_health=true
		;;
	*)
		database_restore_guard_fail \
			"Unsupported database restore worker guard mode: $mode"
		return 1
		;;
	esac
	if container_id="$(
		database_restore_guard_resolve_singleton database-restore-worker "$required"
	)"; then
		:
	else
		resolve_status=$?
		if [[ "$resolve_status" == '2' ]]; then
			DATABASE_RESTORE_GUARD_WORKER_PRESENT=false
			return 0
		fi
		return "$resolve_status"
	fi
	DATABASE_RESTORE_GUARD_WORKER_PRESENT=true
	if ! snapshot="$(database_restore_guard_container_snapshot "$container_id")" ||
		! env_snapshot="$(database_restore_guard_container_env "$container_id")"; then
		database_restore_guard_fail \
			'Database restore guard could not inspect the restore worker.'
		return 1
	fi
	IFS='|' read -r actual_id name project service replica owner purpose image_id \
		container_revision running health <<<"$snapshot"
	[[ "$actual_id" == "$container_id" &&
		"$name" == '/winwidget-database-restore-worker-1' &&
		"$project" == 'winwidget' &&
		"$service" == 'database-restore-worker' && "$replica" == '1' &&
		"$owner" == 'maintenance' &&
		"$purpose" == 'database-restore-worker' &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$container_revision" =~ ^[0-9a-f]{40}$ ]] || {
		database_restore_guard_fail \
			'Database restore guard rejected the restore worker identity.'
		return 1
	}
	if ! image_revision="$(
		database_restore_guard_image_revision "$image_id"
	)"; then
		database_restore_guard_fail \
			'Database restore guard could not inspect the restore worker image revision.'
		return 1
	fi
	[[ "$image_revision" == "$container_revision" ]] || {
		database_restore_guard_fail \
			'Database restore guard found mismatched restore worker image revisions.'
		return 1
	}
	database_restore_guard_validate_exact_env_value \
		"$env_snapshot" APP_REVISION "$container_revision" || {
		database_restore_guard_fail \
			'Database restore worker APP_REVISION does not match its exact image revision.'
		return 1
	}
	if [[ "$require_health" == 'true' &&
		( "$running" != 'true' || "$health" != 'healthy' ) ]]; then
		database_restore_guard_fail \
			'Database restore worker must be running and healthy before this production mutation.'
		return 1
	fi
}

database_restore_guard_assert() {
	local worker_mode="$1"
	local env_file="$2"
	local app_root="${APP_ROOT:-/opt/winwidget}"

	database_restore_guard_validate_env_file "$env_file" || return 1
	database_restore_guard_validate_quiescent_state "$app_root" || return 1
	database_restore_guard_validate_worker "$worker_mode" || return 1
	database_restore_guard_validate_live_api \
		"$worker_mode" "$DATABASE_RESTORE_GUARD_WORKER_PRESENT" || return 1
}

database_restore_guard_assert_before_checkout() {
	local app_root="${APP_ROOT:-/opt/winwidget}"
	local env_file="${1:-${ENV_FILE:-$app_root/deploy/backend/.env.production}}"

	database_restore_guard_assert identity-if-present "$env_file" || return 1
}

database_restore_guard_assert_before_mutation() {
	local worker_mode="${1:-healthy-required}"
	local app_root="${APP_ROOT:-/opt/winwidget}"
	local env_file="${2:-${ENV_FILE:-$app_root/deploy/backend/.env.production}}"

	database_restore_guard_assert "$worker_mode" "$env_file" || return 1
}

database_restore_guard_static_integration_self_test() {
	local script_directory server_root script script_text
	local scripts_with_mutation_guard

	script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
	server_root="$(cd -- "$script_directory/.." && pwd -P)"
	scripts_with_mutation_guard=(
		scripts/database-restore-control.sh
		scripts/deploy-production.sh
		scripts/deploy-maintenance-production.sh
		scripts/deploy-notification-delivery-production.sh
		scripts/deploy-campaigns-production.sh
		scripts/deploy-reporting-production.sh
		scripts/notification-delivery-database-lifecycle.sh
		scripts/campaigns-database-lifecycle.sh
		scripts/reporting-database-lifecycle.sh
		scripts/reporting-cutover-lifecycle.sh
		scripts/billing-database-lifecycle.sh
		scripts/deploy-billing-production.sh
		scripts/billing-cutover-production.sh
	)
	for script in "${scripts_with_mutation_guard[@]}"; do
		[[ -f "$server_root/$script" && ! -L "$server_root/$script" ]] || {
			database_restore_guard_fail \
				"Database restore guard integration target is missing or unsafe: $script"
			return 1
		}
		script_text="$(<"$server_root/$script")"
		[[ "$script_text" == *'database-restore-production-guard.sh'* &&
			"$script_text" == *'database_restore_guard_assert_before_mutation'* ]] || {
			database_restore_guard_fail \
				"Database restore mutation guard is not wired into $script."
			return 1
		}
	done
	script_text="$(<"$server_root/scripts/reporting-database-lifecycle.sh")"
	[[ "$script_text" == *'database_restore_guard_assert_before_checkout'* &&
		"$script_text" == *'--guard-before-fetch-revision'* &&
		"$script_text" == *'--guard-before-checkout-revision'* ]] || {
		database_restore_guard_fail \
			'Database restore guard is missing from the production fetch/checkout gate.'
		return 1
	}
}

database_restore_guard_self_test() {
	local root env_file storage_path directory
	local self_test_revision self_test_container_id self_test_image_id
	local test_worker_health

	root="$(
		mktemp -d "${TMPDIR:-/tmp}/winwidget-database-restore-guard.XXXXXX"
	)"
	trap 'rm -rf -- "$root"' RETURN
	env_file="$root/.env.production"
	storage_path="$root/deploy/backend/database-restores"
	mkdir -p \
		"$storage_path"/{queued,processing,locks,gates,fences,permits,receipts}
	printf '%s\n' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT=' >"$env_file"
	database_restore_guard_validate_env_file "$env_file"
	database_restore_guard_validate_quiescent_state "$root"

	for directory in queued processing locks gates fences; do
		printf 'active\n' >"$storage_path/$directory/self-test"
		if database_restore_guard_validate_quiescent_state "$root" \
			>/dev/null 2>&1; then
			database_restore_guard_fail \
				"Database restore guard self-test accepted active $directory state."
			return 1
		fi
		rm -f -- "$storage_path/$directory/self-test"
	done
	ln -s missing "$root/deploy/backend/.database-restore-control-v1"
	if database_restore_guard_validate_quiescent_state "$root" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted a control-marker symlink.'
		return 1
	fi
	rm -f -- "$root/deploy/backend/.database-restore-control-v1"
	printf 'active\n' >"$storage_path/permits/active.json"
	if database_restore_guard_validate_quiescent_state "$root" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted an active production permit.'
		return 1
	fi
	rm -f -- "$storage_path/permits/active.json"
	printf 'consumed\n' \
		>"$storage_path/permits/01234567-89ab-4def-8123-456789abcdef.consumed.json"
	printf 'receipt\n' \
		>"$storage_path/receipts/01234567-89ab-4def-8123-456789abcdef.json"
	database_restore_guard_validate_quiescent_state "$root"
	printf 'unexpected\n' >"$storage_path/permits/unexpected.json"
	if database_restore_guard_validate_quiescent_state "$root" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted an unknown permit artifact.'
		return 1
	fi
	rm -f -- "$storage_path/permits/unexpected.json"

	printf '%s\n' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=true' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT=' >"$env_file"
	if database_restore_guard_validate_env_file "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted enabled restore.'
		return 1
	fi
	printf '%s\n' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT=' >"$env_file"
	if database_restore_guard_validate_env_file "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted duplicate restore flags.'
		return 1
	fi
	printf '%s\n' \
		' DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT=' >"$env_file"
	if database_restore_guard_validate_env_file "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted a non-literal restore flag.'
		return 1
	fi
	printf '%s\n' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'export DATABASE_RESTORE_PRODUCTION_ENABLED=true' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT=' >"$env_file"
	if database_restore_guard_validate_env_file "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted an exported duplicate restore flag.'
		return 1
	fi
	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED=false' >"$env_file"
	if database_restore_guard_validate_env_file "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted a missing routine permit reset.'
		return 1
	fi
	printf '%s\n' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT={"active":true}' >"$env_file"
	if database_restore_guard_validate_env_file "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted a persisted one-shot permit.'
		return 1
	fi
	printf '%s\n' \
		'DATABASE_RESTORE_PRODUCTION_ENABLED=false' \
		'DATABASE_RESTORE_PRODUCTION_PERMIT=' >"$env_file"
	(
		database_restore_guard_validate_env_file() { return 1; }
		database_restore_guard_validate_quiescent_state() { return 0; }
		database_restore_guard_validate_live_api() { return 0; }
		database_restore_guard_validate_worker() { return 0; }
		if database_restore_guard_assert identity-if-present "$env_file"; then
			database_restore_guard_fail \
				'Database restore guard self-test masked an early validator failure.'
			return 1
		fi
	) || return 1

	self_test_revision='0123456789abcdef0123456789abcdef01234567'
	self_test_container_id="$(printf '%064d' 1)"
	self_test_image_id="sha256:$(printf '%064d' 2)"
	test_worker_health=healthy
	database_restore_guard_require_docker_cli() { return 0; }
	database_restore_guard_list_owned_container_ids() {
		printf '%s\n' "$self_test_container_id"
	}
	database_restore_guard_container_snapshot() {
		case "$1" in
		"$self_test_container_id")
			printf '%s\n' \
				"$self_test_container_id|/winwidget-database-restore-worker-1|winwidget|database-restore-worker|1|maintenance|database-restore-worker|$self_test_image_id|$self_test_revision|true|$test_worker_health"
			;;
		*) return 1 ;;
		esac
	}
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\n' "$self_test_revision"
	}
	database_restore_guard_image_revision() {
		printf '%s\n' "$self_test_revision"
	}
	database_restore_guard_validate_worker healthy-required
	test_worker_health=unhealthy
	if database_restore_guard_validate_worker healthy-required \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted an unhealthy required worker.'
		return 1
	fi
	database_restore_guard_validate_worker identity-if-present

	database_restore_guard_container_snapshot() {
		printf '%s\n' \
			"$self_test_container_id|/winwidget-api-1|winwidget|api|1|||$self_test_image_id|$self_test_revision|true|healthy"
	}
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\nDATABASE_RESTORE_PRODUCTION_ENABLED=false\nDATABASE_RESTORE_PRODUCTION_PERMIT=\n' \
			"$self_test_revision"
	}
	database_restore_guard_validate_live_api healthy-required true
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\nDATABASE_RESTORE_PRODUCTION_ENABLED=false\nDATABASE_RESTORE_PRODUCTION_PERMIT={"active":true}\n' \
			"$self_test_revision"
	}
	if database_restore_guard_validate_live_api healthy-required true \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted a live API one-shot permit during routine deploy.'
		return 1
	fi
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\nDATABASE_RESTORE_PRODUCTION_ENABLED=true\nDATABASE_RESTORE_PRODUCTION_PERMIT=\n' \
			"$self_test_revision"
	}
	if database_restore_guard_validate_live_api identity-if-present false \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted live API restore enablement during bootstrap.'
		return 1
	fi
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\n' "$self_test_revision"
	}
	database_restore_guard_validate_live_api identity-if-present false
	if database_restore_guard_validate_live_api identity-if-present true \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted a legacy API after the restore worker appeared.'
		return 1
	fi
	if database_restore_guard_validate_live_api healthy-required false \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test widened the legacy API exception beyond bootstrap mode.'
		return 1
	fi
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\nDATABASE_RESTORE_PRODUCTION_ENABLED=false\nDATABASE_RESTORE_PRODUCTION_ENABLED=false\nDATABASE_RESTORE_PRODUCTION_PERMIT=\n' \
			"$self_test_revision"
	}
	if database_restore_guard_validate_live_api identity-if-present false \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted duplicate live API restore flags.'
		return 1
	fi
	database_restore_guard_list_owned_container_ids() {
		case "$1" in
		api) printf '%s\n' "$self_test_container_id" ;;
		database-restore-worker) return 0 ;;
		*) return 1 ;;
		esac
	}
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\n' "$self_test_revision"
	}
	APP_ROOT="$root" \
		database_restore_guard_assert identity-if-present "$env_file"
	if APP_ROOT="$root" \
		database_restore_guard_assert healthy-required "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted legacy bootstrap in healthy-required mode.'
		return 1
	fi
	database_restore_guard_container_env() {
		printf 'APP_REVISION=%s\nDATABASE_RESTORE_PRODUCTION_ENABLED=true\nDATABASE_RESTORE_PRODUCTION_PERMIT=\n' \
			"$self_test_revision"
	}
	if APP_ROOT="$root" \
		database_restore_guard_assert identity-if-present "$env_file" \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted enabled live API in aggregate bootstrap.'
		return 1
	fi
	database_restore_guard_list_owned_container_ids() {
		printf '%s\n%s\n' \
			"$self_test_container_id" "$(printf '%064d' 3)"
	}
	if database_restore_guard_validate_worker identity-if-present \
		>/dev/null 2>&1; then
		database_restore_guard_fail \
			'Database restore guard self-test accepted multiple workers.'
		return 1
	fi

	database_restore_guard_static_integration_self_test
	trap - RETURN
	[[ "$root" == "${TMPDIR:-/tmp}/winwidget-database-restore-guard."* ]] ||
		return 1
	rm -rf -- "$root"
	echo 'Database restore production guard fail-closed checks passed.'
}

database_restore_guard_main() {
	set -Eeuo pipefail
	case "${1:-}" in
	--before-checkout)
		[[ $# == 1 ]] || return 1
		database_restore_guard_assert_before_checkout \
			"${ENV_FILE:-${APP_ROOT:-/opt/winwidget}/deploy/backend/.env.production}"
		;;
	--before-mutation)
		[[ $# == 2 ]] || return 1
		database_restore_guard_assert_before_mutation "$2"
		;;
	--self-test)
		[[ $# == 1 ]] || return 1
		database_restore_guard_self_test
		;;
	*)
		echo "Usage: $0 --before-checkout | $0 --before-mutation identity-if-present|healthy-if-present|healthy-required | $0 --self-test" >&2
		return 1
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	database_restore_guard_main "$@"
fi
