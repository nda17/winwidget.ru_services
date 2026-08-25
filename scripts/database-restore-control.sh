#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

database_restore_control_fail() {
	echo "$1" >&2
	return 1
}

database_restore_control_validate_target() {
	case "$1" in
	notification-delivery | campaigns | reporting | widgets | billing | identity | platform | support) return 0 ;;
	*)
		database_restore_control_fail \
			'Unsupported database restore target.'
		;;
	esac
}

database_restore_control_validate_reference() {
	local name="$1"
	local value="$2"
	local size

	[[ -n "$value" && "$value" != [[:space:]]* &&
		"$value" != *[[:space:]] && "$value" != *$'\n'* &&
		"$value" != *$'\r'* ]] || {
		database_restore_control_fail \
			"$name must be a non-empty exact reference without surrounding whitespace."
		return 1
	}
	size="$(LC_ALL=C printf '%s' "$value" | wc -c | tr -d '[:space:]')"
	[[ "$size" =~ ^[0-9]+$ && "$size" -le 512 ]] || {
		database_restore_control_fail "$name must not exceed 512 bytes."
		return 1
	}
	if LC_ALL=C printf '%s' "$value" | grep -q '[[:cntrl:]]'; then
		database_restore_control_fail "$name contains control characters."
		return 1
	fi
}

database_restore_control_validate_wait_seconds() {
	local value="$1"

	[[ "$value" =~ ^[0-9]+$ && "$value" -ge 60 && "$value" -le 900 ]] || {
		database_restore_control_fail \
			'DATABASE_RESTORE_WAIT_SECONDS must be between 60 and 900.'
		return 1
	}
}

database_restore_control_self_test() {
	database_restore_control_validate_target notification-delivery
	database_restore_control_validate_target campaigns
	database_restore_control_validate_target reporting
	database_restore_control_validate_target widgets
	database_restore_control_validate_target billing
	database_restore_control_validate_target identity
	database_restore_control_validate_target platform
	database_restore_control_validate_target support
	if database_restore_control_validate_target unknown >/dev/null 2>&1; then
		database_restore_control_fail \
			'Database restore control self-test accepted an unknown target.'
		return 1
	fi
	database_restore_control_validate_reference \
		DATABASE_RESTORE_EVIDENCE exact-sha-rehearsal-evidence
	database_restore_control_validate_reference \
		DATABASE_RESTORE_INCIDENT incident-2024
	for invalid_reference in '' ' leading' 'trailing ' $'line\nbreak'; do
		if database_restore_control_validate_reference \
			DATABASE_RESTORE_EVIDENCE "$invalid_reference" >/dev/null 2>&1; then
			database_restore_control_fail \
				'Database restore control self-test accepted an invalid reference.'
			return 1
		fi
	done
	database_restore_control_validate_wait_seconds 60
	database_restore_control_validate_wait_seconds 900
	if database_restore_control_validate_wait_seconds 59 >/dev/null 2>&1 ||
		database_restore_control_validate_wait_seconds 901 >/dev/null 2>&1; then
		database_restore_control_fail \
			'Database restore control self-test accepted an unsafe wait interval.'
		return 1
	fi
	echo 'database_restore_control_self_test=passed'
}

database_restore_control_expire() {
	local app_root="${APP_ROOT:-/opt/winwidget}"
	local server_root="$app_root/winwidget.ru_server"
	local env_file="${ENV_FILE:-$app_root/deploy/backend/.env.production}"
	local compose_file="${COMPOSE_FILE:-$server_root/deploy/docker-compose.prod.yml}"
	local marker="$app_root/deploy/backend/.database-restore-control-v1"
	local lock_file="$app_root/deploy/backend/.production-deploy.lock"
	local expected_revision="${EXPECTED_REVISION:-}"
	local job_id="${DATABASE_RESTORE_CONTROL_JOB_ID:-}"
	local expires_epoch="${DATABASE_RESTORE_CONTROL_EXPIRES_EPOCH:-}"
	local delay watchdog_lock_fd container_id container_state env_snapshot

	[[ "$(id -u)" == '0' && "$expected_revision" =~ ^[0-9a-f]{40}$ &&
		"$job_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$expires_epoch" =~ ^[0-9]+$ ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog received invalid identity.'
	delay=$((expires_epoch - $(date +%s) + 5))
	if ((delay > 0)); then
		sleep "$delay"
	fi
	[[ -e "$marker" || -L "$marker" ]] || return 0
	[[ -f "$marker" && ! -L "$marker" &&
		"$(stat -c '%u:%g:%a' "$marker")" == '0:0:600' ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog found an unsafe control marker.'

	exec {watchdog_lock_fd}>"$lock_file"
	flock --exclusive "$watchdog_lock_fd"
	[[ -e "$marker" || -L "$marker" ]] || return 0
	[[ -f "$marker" && ! -L "$marker" &&
		"$(grep -Ec "^revision=$expected_revision$" "$marker")" == '1' &&
		"$(grep -Ec "^job_id=$job_id$" "$marker")" == '1' ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog marker identity changed.'
	[[ -d "$server_root" && ! -L "$server_root" &&
		-f "$env_file" && ! -L "$env_file" &&
		-f "$compose_file" && ! -L "$compose_file" ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog paths are missing or unsafe.'
	cd "$server_root" ||
		database_restore_control_fail \
			'Database restore expiry watchdog could not enter the backend checkout.'
	[[ "$(git branch --show-current)" == 'prod' &&
		"$(git rev-parse HEAD)" == "$expected_revision" &&
		-z "$(git status --porcelain --untracked-files=all)" ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog requires the clean exact prod revision.'

	# shellcheck source=scripts/database-restore-production-guard.sh
	source "$server_root/scripts/database-restore-production-guard.sh"
	database_restore_guard_validate_env_file "$env_file"
	DATABASE_RESTORE_PRODUCTION_ENABLED=false \
		DATABASE_RESTORE_PRODUCTION_PERMIT='' \
		APP_REVISION="$expected_revision" \
		APP_VERSION="git-$expected_revision" \
		docker compose --project-name winwidget --env-file "$env_file" \
			-f "$compose_file" up -d --no-deps --force-recreate api >/dev/null
	container_id="$(
		docker compose --project-name winwidget --env-file "$env_file" \
			-f "$compose_file" ps -a -q api
	)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog could not resolve the reset API.'
	container_state="$(docker inspect --format \
		'{{.State.Running}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$container_id")"
	[[ "$container_state" == "true|$expected_revision" ]] ||
		database_restore_control_fail \
			'Database restore expiry watchdog did not start the exact API revision.'
	env_snapshot="$(database_restore_guard_container_env "$container_id")"
	database_restore_guard_validate_exact_env_value \
		"$env_snapshot" APP_REVISION "$expected_revision"
	database_restore_guard_validate_exact_env_value \
		"$env_snapshot" DATABASE_RESTORE_PRODUCTION_ENABLED false
	database_restore_guard_validate_exact_env_value \
		"$env_snapshot" DATABASE_RESTORE_PRODUCTION_PERMIT ''
	rm -f -- "$marker"
}

database_restore_control_run() {
	local app_root="${APP_ROOT:-/opt/winwidget}"
	local server_root="$app_root/winwidget.ru_server"
	local env_file="${ENV_FILE:-$app_root/deploy/backend/.env.production}"
	local compose_file="${COMPOSE_FILE:-$server_root/deploy/docker-compose.prod.yml}"
	local marker="$app_root/deploy/backend/.database-restore-control-v1"
	local expected_revision="${EXPECTED_REVISION:-}"
	local target="${DATABASE_RESTORE_TARGET:-}"
	local evidence="${DATABASE_RESTORE_EVIDENCE:-}"
	local incident="${DATABASE_RESTORE_INCIDENT:-}"
	local wait_seconds="${DATABASE_RESTORE_WAIT_SECONDS:-600}"
	local permit_ttl_seconds
	local api_container_id worker_container_id
	local api_snapshot worker_snapshot
	local actual_id name project service replica owner purpose image_id revision
	local running health
	local permit_output permit_base64 permit
	local job_id expires_at expires_epoch
	local deploy_lock_fd watchdog_pid
	local gate_opened=false marker_created=false close_succeeded=false
	local confirmed=false deadline now

	[[ "$(id -u)" == '0' ]] ||
		database_restore_control_fail \
			'Database restore production control must run as root.'
	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] ||
		database_restore_control_fail \
			'EXPECTED_REVISION must be an exact 40-character Git revision.'
	database_restore_control_validate_target "$target"
	database_restore_control_validate_reference \
		DATABASE_RESTORE_EVIDENCE "$evidence"
	[[ "$evidence" == *"$expected_revision"* ]] ||
		database_restore_control_fail \
			'DATABASE_RESTORE_EVIDENCE must pin EXPECTED_REVISION.'
	database_restore_control_validate_reference \
		DATABASE_RESTORE_INCIDENT "$incident"
	database_restore_control_validate_wait_seconds "$wait_seconds"
	permit_ttl_seconds=$((wait_seconds + 120))

	[[ -d "$server_root" && ! -L "$server_root" &&
		-f "$env_file" && ! -L "$env_file" &&
		-f "$compose_file" && ! -L "$compose_file" ]] ||
		database_restore_control_fail \
			'Database restore production paths are missing or unsafe.'
	cd "$server_root" ||
		database_restore_control_fail \
			'Database restore control could not enter the backend checkout.'
	[[ "$(git branch --show-current)" == 'prod' &&
		"$(git rev-parse HEAD)" == "$expected_revision" &&
		-z "$(git status --porcelain --untracked-files=all)" ]] ||
		database_restore_control_fail \
			'Database restore control requires the clean exact prod revision.'
	[[ "$(git hash-object scripts/database-restore-control.sh)" == "$(git rev-parse 'HEAD:scripts/database-restore-control.sh')" ]] ||
		database_restore_control_fail \
			'Database restore control script differs from the checked-out revision.'

	# shellcheck source=scripts/production-deploy-lock.sh
	source "$server_root/scripts/production-deploy-lock.sh"
	acquire_production_deploy_lock 'database restore production control'
	# shellcheck source=scripts/database-restore-production-guard.sh
	source "$server_root/scripts/database-restore-production-guard.sh"
	database_restore_guard_assert_before_mutation healthy-required "$env_file"

	api_container_id="$(database_restore_guard_resolve_singleton api true)"
	worker_container_id="$(
		database_restore_guard_resolve_singleton database-restore-worker true
	)"
	api_snapshot="$(database_restore_guard_container_snapshot "$api_container_id")"
	worker_snapshot="$(
		database_restore_guard_container_snapshot "$worker_container_id"
	)"
	IFS='|' read -r actual_id name project service replica owner purpose image_id \
		revision running health <<<"$api_snapshot"
	: "$name" "$replica" "$owner" "$purpose" "$image_id"
	[[ "$actual_id" == "$api_container_id" && "$project" == 'winwidget' &&
		"$service" == 'api' && "$revision" == "$expected_revision" &&
		"$running" == 'true' && "$health" == 'healthy' ]] ||
		database_restore_control_fail \
			'Live API is not healthy on the exact approved revision.'
	IFS='|' read -r actual_id name project service replica owner purpose image_id \
		revision running health <<<"$worker_snapshot"
	: "$name" "$replica" "$owner" "$purpose" "$image_id"
	[[ "$actual_id" == "$worker_container_id" && "$project" == 'winwidget' &&
		"$service" == 'database-restore-worker' &&
		"$revision" == "$expected_revision" && "$running" == 'true' &&
		"$health" == 'healthy' ]] ||
		database_restore_control_fail \
			'Live database restore worker is not healthy on the exact approved revision.'

	permit_output="$(
		docker exec -i \
			-e "DATABASE_RESTORE_CONTROL_TARGET=$target" \
			-e "DATABASE_RESTORE_CONTROL_EVIDENCE=$evidence" \
			-e "DATABASE_RESTORE_CONTROL_INCIDENT=$incident" \
			-e "DATABASE_RESTORE_CONTROL_TTL_SECONDS=$permit_ttl_seconds" \
			"$api_container_id" node - <<'NODE'
const crypto = require('node:crypto');
const {
  DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
  signDatabaseRestoreProductionPermit,
} = require('/app/dist/src/dev-tools/database-restore-queue.contract.js');

const jobId = crypto.randomUUID();
const expiresAt = new Date(
  Date.now() + Number(process.env.DATABASE_RESTORE_CONTROL_TTL_SECONDS) * 1000,
).toISOString();
const permit = signDatabaseRestoreProductionPermit(
  {
    version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
    kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT',
    appRevision: process.env.APP_REVISION,
    target: process.env.DATABASE_RESTORE_CONTROL_TARGET,
    jobId,
    expiresAt,
    runId: `database-restore-control-${jobId}`,
    evidence: process.env.DATABASE_RESTORE_CONTROL_EVIDENCE,
    incident: process.env.DATABASE_RESTORE_CONTROL_INCIDENT,
  },
  process.env.DATABASE_RESTORE_QUEUE_SECRET,
);

process.stdout.write(
  `${jobId}\n${expiresAt}\n${Buffer.from(JSON.stringify(permit)).toString('base64')}\n`,
);
NODE
	)"
	job_id="$(printf '%s\n' "$permit_output" | sed -n '1p')"
	expires_at="$(printf '%s\n' "$permit_output" | sed -n '2p')"
	permit_base64="$(printf '%s\n' "$permit_output" | sed -n '3p')"
	[[ "$job_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$expires_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T &&
		-n "$permit_base64" ]] ||
		database_restore_control_fail \
			'Database restore control could not generate an exact signed permit.'
	permit="$(printf '%s' "$permit_base64" | base64 --decode)" ||
		database_restore_control_fail \
			'Database restore control generated an invalid permit transport.'
	expires_epoch="$(date -d "$expires_at" +%s)" ||
		database_restore_control_fail \
			'Database restore control generated an invalid permit expiry.'
	[[ "$expires_epoch" =~ ^[0-9]+$ && "$expires_epoch" -gt "$(date +%s)" ]] ||
		database_restore_control_fail \
			'Database restore control generated an already expired permit.'
	unset permit_output permit_base64

	compose_api() {
		docker compose --project-name winwidget --env-file "$env_file" \
			-f "$compose_file" "$@"
	}

	recreate_api() {
		local enabled="$1"
		local production_permit="$2"

		DATABASE_RESTORE_PRODUCTION_ENABLED="$enabled" \
			DATABASE_RESTORE_PRODUCTION_PERMIT="$production_permit" \
			APP_REVISION="$expected_revision" \
			APP_VERSION="git-$expected_revision" \
			docker compose --project-name winwidget --env-file "$env_file" \
				-f "$compose_file" up -d --no-deps --force-recreate api
	}

	wait_for_api() {
		local container_id state

		for _ in {1..45}; do
			container_id="$(compose_api ps -a -q api 2>/dev/null || true)"
			if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
				state="$(docker inspect --format \
					'{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' \
					"$container_id" 2>/dev/null || true)"
				if [[ "$state" == "true|healthy|$expected_revision" ]]; then
					printf '%s\n' "$container_id"
					return 0
				fi
			fi
			sleep 2
		done
		database_restore_control_fail \
			'API did not become healthy on the exact approved revision.'
	}

	resolve_reset_api() {
		local container_id state

		for _ in {1..15}; do
			container_id="$(compose_api ps -a -q api 2>/dev/null || true)"
			if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
				state="$(docker inspect --format \
					'{{.State.Running}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' \
					"$container_id" 2>/dev/null || true)"
				if [[ "$state" == "true|$expected_revision" ]]; then
					printf '%s\n' "$container_id"
					return 0
				fi
			fi
			sleep 1
		done
		database_restore_control_fail \
			'API reset container was not recreated on the exact approved revision.'
	}

	close_control() {
		local reset_container_id reset_env

		if [[ "$gate_opened" == 'true' ]]; then
			if recreate_api false '' >/dev/null &&
				reset_container_id="$(resolve_reset_api)" &&
				reset_env="$(
					database_restore_guard_container_env "$reset_container_id"
				)" &&
				database_restore_guard_validate_exact_env_value \
					"$reset_env" APP_REVISION "$expected_revision" &&
				database_restore_guard_validate_exact_env_value \
					"$reset_env" DATABASE_RESTORE_PRODUCTION_ENABLED false &&
				database_restore_guard_validate_exact_env_value \
					"$reset_env" DATABASE_RESTORE_PRODUCTION_PERMIT ''; then
				close_succeeded=true
			else
				database_restore_control_fail \
					'CRITICAL: API restore gate could not be reset to false/empty.'
				return 1
			fi
		else
			close_succeeded=true
		fi

		if [[ "$marker_created" == 'true' && "$close_succeeded" == 'true' ]]; then
			[[ -f "$marker" && ! -L "$marker" &&
				"$(grep -Ec "^job_id=$job_id$" "$marker")" == '1' ]] || {
				database_restore_control_fail \
					'Database restore control marker identity changed; it was not removed.'
				return 1
			}
			rm -f -- "$marker"
			marker_created=false
		fi
	}

	on_exit() {
		local exit_code=$?

		trap - EXIT INT TERM HUP
		if ! close_control; then
			exit_code=1
		fi
		unset permit
		exit "$exit_code"
	}
	trap on_exit EXIT
	trap 'exit 130' INT TERM HUP

	(
		set -o noclobber
		printf 'version=1\nrevision=%s\ntarget=%s\njob_id=%s\nexpires_at=%s\n' \
			"$expected_revision" "$target" "$job_id" "$expires_at" >"$marker"
	) 2>/dev/null ||
		database_restore_control_fail \
			'Another database restore control marker already exists.'
	marker_created=true
	chown 0:0 "$marker"
	chmod 600 "$marker"
	deploy_lock_fd="$PRODUCTION_DEPLOY_LOCK_FD"
	[[ "$deploy_lock_fd" =~ ^[0-9]+$ ]] ||
		database_restore_control_fail \
			'Database restore production lock descriptor is invalid.'
	(
		# The descriptor number is validated above; the watchdog must not
		# inherit the main process lock while it sleeps until permit expiry.
		# shellcheck disable=SC2294
		eval "exec ${deploy_lock_fd}>&-"
		unset PRODUCTION_DEPLOY_LOCK_FD WINWIDGET_PRODUCTION_DEPLOY_LOCK_HELD
		exec nohup env \
			APP_ROOT="$app_root" \
			EXPECTED_REVISION="$expected_revision" \
			DATABASE_RESTORE_CONTROL_JOB_ID="$job_id" \
			DATABASE_RESTORE_CONTROL_EXPIRES_EPOCH="$expires_epoch" \
			bash "$server_root/scripts/database-restore-control.sh" --expire
	) >/dev/null 2>&1 &
	watchdog_pid=$!
	sleep 1
	kill -0 "$watchdog_pid" 2>/dev/null ||
		database_restore_control_fail \
			'Database restore expiry watchdog did not start.'

	gate_opened=true
	recreate_api true "$permit" >/dev/null
	api_container_id="$(wait_for_api)"

	docker exec -i "$api_container_id" node - \
		"$target" "$job_id" "$expires_at" <<'NODE'
const {
  parseAndVerifyDatabaseRestoreProductionPermit,
} = require('/app/dist/src/dev-tools/database-restore-queue.contract.js');

const [target, jobId, expiresAt] = process.argv.slice(2);
if (process.env.DATABASE_RESTORE_PRODUCTION_ENABLED !== 'true') process.exit(1);
const permit = parseAndVerifyDatabaseRestoreProductionPermit(
  process.env.DATABASE_RESTORE_PRODUCTION_PERMIT,
  process.env.DATABASE_RESTORE_QUEUE_SECRET,
);
if (
  permit.appRevision !== process.env.APP_REVISION ||
  permit.target !== target ||
  permit.jobId !== jobId ||
  permit.expiresAt !== expiresAt
) process.exit(1);
NODE

	echo 'Database restore control window is open.'
	echo "target=$target"
	echo "job_id=$job_id"
	echo "expires_at=$expires_at"
	echo 'Open or reload the admin database page, upload the exact .dump and submit once.'
	echo 'The workflow is waiting for the signed publish receipt; routine deploys are blocked.'

	deadline=$((SECONDS + wait_seconds))
	while ((SECONDS < deadline)); do
		if docker exec -i "$worker_container_id" node - \
			"$target" "$job_id" "$expected_revision" >/dev/null 2>&1 <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {
  parseAndVerifyDatabaseRestoreProductionPermit,
  parseAndVerifyDatabaseRestorePublishReceipt,
} = require('/app/dist/src/dev-tools/database-restore-queue.contract.js');

const [target, jobId, revision] = process.argv.slice(2);
const root = process.env.DATABASE_RESTORE_STORAGE_DIR;
const secret = process.env.DATABASE_RESTORE_QUEUE_SECRET;
const consumed = parseAndVerifyDatabaseRestoreProductionPermit(
  fs.readFileSync(path.join(root, 'permits', `${jobId}.consumed.json`), 'utf8'),
  secret,
);
const receipt = parseAndVerifyDatabaseRestorePublishReceipt(
  fs.readFileSync(path.join(root, 'receipts', `${jobId}.json`), 'utf8'),
  secret,
);
if (
  consumed.target !== target || consumed.jobId !== jobId ||
  consumed.appRevision !== revision || receipt.target !== target ||
  receipt.jobId !== jobId || receipt.appRevision !== revision ||
  receipt.permitSignature !== consumed.signature ||
  receipt.permitExpiresAt !== consumed.expiresAt ||
  receipt.manifestStatus !== 'QUEUED'
) process.exit(1);
NODE
		then
			confirmed=true
			break
		fi
		now="$(date +%s)"
		if ((now >= expires_epoch)); then
			break
		fi
		sleep 2
	done

	[[ "$confirmed" == 'true' ]] ||
		database_restore_control_fail \
			'Database restore permit expired or timed out before exact publication confirmation.'
	echo "database_restore_publication_confirmed=$job_id"
	close_control
	trap - EXIT INT TERM HUP
	unset permit
	echo 'database_restore_control_gate=disabled'
}

case "${1:-}" in
--run)
	[[ "$#" -eq 1 ]] || {
		echo 'Database restore control --run does not accept arguments.' >&2
		exit 1
	}
	database_restore_control_run
	;;
--self-test)
	[[ "$#" -eq 1 ]] || {
		echo 'Database restore control --self-test does not accept arguments.' >&2
		exit 1
	}
	database_restore_control_self_test
	;;
--expire)
	[[ "$#" -eq 1 ]] || {
		echo 'Database restore control --expire does not accept arguments.' >&2
		exit 1
	}
	database_restore_control_expire
	;;
*)
	echo 'Usage: database-restore-control.sh --run | --self-test | --expire' >&2
	exit 1
	;;
esac
