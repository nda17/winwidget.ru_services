#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
server_root="$(cd "$script_dir/.." && pwd -P)"
control_script="$server_root/scripts/identity-production-env-control.sh"
fixture_parent="${TMPDIR:-/tmp}"
fixture_root="$(mktemp -d "$fixture_parent/winwidget-identity-env-recovery.XXXXXX")"
fixture_root="$(cd "$fixture_root" && pwd -P)"
[[ -d "$fixture_root" && ! -L "$fixture_root" &&
	"$(basename -- "$fixture_root")" =~ ^winwidget-identity-env-recovery\.[A-Za-z0-9]{6}$ ]] || exit 1

cleanup_fixture() {
	[[ -n "${fixture_root:-}" && -d "$fixture_root" && ! -L "$fixture_root" &&
		"$(basename -- "$fixture_root")" =~ ^winwidget-identity-env-recovery\.[A-Za-z0-9]{6}$ ]] || return 1
	rm -rf -- "$fixture_root"
}
trap cleanup_fixture EXIT

load_control() {
	# shellcheck source=scripts/identity-production-env-control.sh
	source "$control_script"
	identity_env_require_root() { :; }
	stat() {
		if [[ "${1:-}" == '-c' ]]; then
			printf '0:0:600\n'
			return
		fi
		command stat "$@"
	}
	chown() { :; }
	install() {
		[[ "$1:$2:$3:$4:$5:$6" == '-o:0:-g:0:-m:600' ]] || return 1
		command /usr/bin/install -m 600 "$7" "$8"
	}
}

configure_fixture() {
	local root="$1"
	APP_ROOT="$root"
	ENV_FILE="$root/deploy/backend/.env.production"
	EXPECTED_REVISION='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	IDENTITY_ENV_EXPECTED_SHA256=''
	identity_env_marker="$root/deploy/backend/.identity-production-env-v1"
	identity_env_marker_temporary="${identity_env_marker}.tmp"
	identity_env_admin_password_file="$root/deploy/backend/.identity-postgres-admin-password"
	identity_env_admin_password_temporary="$root/deploy/backend/.identity-postgres-admin-password.bootstrap-tmp"
	identity_env_bootstrap_source="$root/deploy/backend/.identity-production-env-bootstrap-source-v1"
	identity_env_bootstrap_journal="$root/deploy/backend/.identity-production-env-bootstrap-journal-v1"
	identity_env_bootstrap_candidate="$root/deploy/backend/.identity-production-env-bootstrap-candidate-v1"
	identity_env_bootstrap_candidate_temporary="${identity_env_bootstrap_candidate}.tmp"
	identity_env_bootstrap_rollback_temporary="${ENV_FILE}.identity-bootstrap-rollback"
	identity_env_bootstrap_source_temporary="${identity_env_bootstrap_source}.tmp"
	identity_env_bootstrap_journal_temporary="${identity_env_bootstrap_journal}.tmp"
	identity_database_marker="$root/deploy/backend/.identity-database-lifecycle-v1"
	identity_cutover_marker="$root/deploy/backend/.identity-cutover-v1"
	identity_cleanup_marker="$root/deploy/backend/.identity-core-cleanup-v1"
	mkdir -p "$root/deploy/backend"
	printf '%s\n' \
		'JWT_JWKS_URL=http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json' \
		'GATEWAY_ROUTES_JSON=[{"id":"monolith","pathPrefix":"/api/v1","upstreamUrl":"http://127.0.0.1:4200"}]' >"$ENV_FILE"
	chmod 600 "$ENV_FILE"
}

create_export_certificate() {
	local root="$1" export_id="$2"
	certificate="$root/deploy/backend/.identity-env-export-certificate-$export_id.pem"
	private_key="$root/deploy/backend/export-private.pem"
	openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=fixture' \
		-keyout "$private_key" -out "$certificate" >/dev/null 2>&1
	chmod 600 "$private_key" "$certificate"
	IDENTITY_ENV_EXPORT_CERTIFICATE_FILE="$certificate"
	IDENTITY_ENV_EXPORT_FILE="$root/deploy/backend/.identity-production-env-$export_id.p7m"
}

run_normal_and_export_boundaries() (
	load_control
	local root="$fixture_root/normal"
	configure_fixture "$root"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	identity_env_bootstrap >/dev/null
	[[ -f "$identity_env_marker" && -f "$identity_env_admin_password_file" &&
		! -e "$identity_env_bootstrap_source" &&
		! -e "$identity_env_bootstrap_journal" &&
		! -e "$identity_env_bootstrap_candidate" ]]

	create_export_certificate "$root" '123-1'
	identity_env_export_candidate_encrypted >/dev/null
	[[ -s "$IDENTITY_ENV_EXPORT_FILE" &&
		"$(tr -d '\r\n' <"${IDENTITY_ENV_EXPORT_FILE}.env-sha256")" == \
		"$(identity_env_sha256 "$ENV_FILE")" ]]
	rm -f -- "$IDENTITY_ENV_EXPORT_FILE" "${IDENTITY_ENV_EXPORT_FILE}.env-sha256"
	ln -s /dev/null "${IDENTITY_ENV_EXPORT_FILE}.env-sha256"
	if identity_env_export_candidate_encrypted >/dev/null 2>&1; then
		return 1
	fi
	[[ ! -e "$IDENTITY_ENV_EXPORT_FILE" ]]
	rm -f -- "${IDENTITY_ENV_EXPORT_FILE}.env-sha256"
	ln -s /dev/null "${IDENTITY_ENV_EXPORT_FILE}.partial"
	if identity_env_export_candidate_encrypted >/dev/null 2>&1; then
		return 1
	fi
	[[ ! -e "$IDENTITY_ENV_EXPORT_FILE" &&
		! -e "${IDENTITY_ENV_EXPORT_FILE}.env-sha256" ]]
	rm -f -- "${IDENTITY_ENV_EXPORT_FILE}.partial"

	local export_status=0 mv_failure_seen=0
	mv() {
		local argument last=''
		for argument in "$@"; do last="$argument"; done
		if [[ "$last" == "${IDENTITY_ENV_EXPORT_FILE}.env-sha256" ]]; then
			mv_failure_seen=1
			return 91
		fi
		command mv "$@"
	}
	identity_env_export_candidate_encrypted >/dev/null 2>&1 || export_status=$?
	unset -f mv
	[[ "$mv_failure_seen:$export_status" == '1:1' ]]
	[[ -z "$(trap -p RETURN)" ]]
	[[ ! -e "$IDENTITY_ENV_EXPORT_FILE" &&
		! -e "${IDENTITY_ENV_EXPORT_FILE}.env-sha256" &&
		! -e "${IDENTITY_ENV_EXPORT_FILE}.partial" &&
		! -e "${IDENTITY_ENV_EXPORT_FILE}.env-sha256.partial" ]]

	IDENTITY_ENV_ROLLBACK_CONFIRMATION='ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'
	if identity_env_rollback_incomplete_bootstrap >/dev/null 2>&1; then
		return 1
	fi
)

run_source_protection_resume() (
	load_control
	local root="$fixture_root/source-resume" original_writer
	configure_fixture "$root"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	original_writer="$(declare -f identity_env_write_bootstrap_journal)"
	identity_env_write_bootstrap_journal() { return 92; }
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	eval "$original_writer"
	[[ -f "$identity_env_bootstrap_source" &&
		! -e "$identity_env_bootstrap_journal" &&
		! -e "$identity_env_admin_password_file" ]]
	identity_env_bootstrap >/dev/null
	[[ -f "$identity_env_marker" &&
		! -e "$identity_env_bootstrap_source" &&
		! -e "$identity_env_bootstrap_journal" ]]
)

run_crash_after_env_move() (
	load_control
	local root="$fixture_root/crash-env" original_writer
	configure_fixture "$root"
	cp "$ENV_FILE" "$root/source.expected"
	chmod 600 "$root/source.expected"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	original_writer="$(declare -f identity_env_write_marker)"
	identity_env_write_marker() { return 93; }
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	eval "$original_writer"
	[[ ! -e "$identity_env_marker" && -f "$identity_env_bootstrap_source" &&
		-f "$identity_env_bootstrap_journal" &&
		-f "$identity_env_admin_password_file" ]]
	IDENTITY_ENV_ROLLBACK_CONFIRMATION='ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'
	identity_env_rollback_incomplete_bootstrap >/dev/null
	cmp -s "$ENV_FILE" "$root/source.expected"
	[[ ! -e "$identity_env_bootstrap_source" &&
		! -e "$identity_env_bootstrap_journal" &&
		! -e "$identity_env_admin_password_file" ]]
)

run_marker_finalize_resume() (
	load_control
	local root="$fixture_root/marker-resume" original_finalize
	configure_fixture "$root"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	original_finalize="$(declare -f identity_env_finalize_bootstrap_journal)"
	identity_env_finalize_bootstrap_journal() { return 94; }
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	eval "$original_finalize"
	[[ -f "$identity_env_marker" && -f "$identity_env_bootstrap_source" &&
		-f "$identity_env_bootstrap_journal" ]]
	identity_env_bootstrap >/dev/null
	[[ -f "$identity_env_marker" &&
		! -e "$identity_env_bootstrap_source" &&
		! -e "$identity_env_bootstrap_journal" ]]
)

run_admin_and_candidate_crash_rollbacks() (
	load_control
	local root="$fixture_root/crash-admin" original_generator
	original_generator="$(declare -f identity_env_node_generate)"
	configure_fixture "$root"
	cp "$ENV_FILE" "$root/source.expected"
	chmod 600 "$root/source.expected"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	identity_env_node_generate() { return 95; }
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	eval "$original_generator"
	[[ -f "$identity_env_bootstrap_source" &&
		-f "$identity_env_bootstrap_journal" &&
		-f "$identity_env_admin_password_file" ]]
	IDENTITY_ENV_ROLLBACK_CONFIRMATION='ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'
	identity_env_rollback_incomplete_bootstrap >/dev/null
	cmp -s "$ENV_FILE" "$root/source.expected"

	root="$fixture_root/crash-candidate"
	configure_fixture "$root"
	cp "$ENV_FILE" "$root/source.expected"
	chmod 600 "$root/source.expected"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	identity_env_node_generate() {
		printf 'partial\n' >"$2"
		chmod 600 "$2"
		return 96
	}
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	eval "$original_generator"
	[[ -f "$identity_env_bootstrap_candidate_temporary" &&
		! -e "$identity_env_marker" ]]
	IDENTITY_ENV_ROLLBACK_CONFIRMATION='ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'
	identity_env_rollback_incomplete_bootstrap >/dev/null
	cmp -s "$ENV_FILE" "$root/source.expected"
	[[ ! -e "$identity_env_bootstrap_candidate_temporary" &&
		! -e "$identity_env_admin_password_file" ]]
)

run_conditional_and_command_failures() (
	load_control
	local root="$fixture_root/validator-negatives"
	configure_fixture "$root"
	printf '%064d\n' 0 >"$identity_env_admin_password_file"
	chmod 600 "$identity_env_admin_password_file"
	if identity_env_assert_candidate >/dev/null 2>&1; then return 1; fi
	stat() {
		if [[ "${1:-}" == '-c' ]]; then printf '0:0:644\n'; return; fi
		command stat "$@"
	}
	if identity_env_require_file >/dev/null 2>&1; then return 1; fi
	stat() {
		if [[ "${1:-}" == '-c' ]]; then printf '0:0:600\n'; return; fi
		command stat "$@"
	}
	chmod() { return 97; }
	if identity_env_write_bootstrap_journal \
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
		>/dev/null 2>&1; then return 1; fi
	unset -f chmod
	date() { return 98; }
	if identity_env_write_bootstrap_journal \
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
		>/dev/null 2>&1; then return 1; fi
	unset -f date
	[[ ! -e "$identity_env_bootstrap_journal" ]]

	root="$fixture_root/openssl-failure"
	configure_fixture "$root"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	openssl() { return 99; }
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	unset -f openssl
	[[ -f "$identity_env_bootstrap_source" &&
		-f "$identity_env_bootstrap_journal" &&
		! -e "$identity_env_admin_password_file" ]]
	IDENTITY_ENV_ROLLBACK_CONFIRMATION='ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'
	identity_env_rollback_incomplete_bootstrap >/dev/null
)

run_docker_node_fallback_contract() (
	load_control
	local root="$fixture_root/docker-node" fake_docker docker_log host_node original_stat
	local container_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	local second_container_id='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
	local image_id='sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
	local identity_revision_check_calls=0
	configure_fixture "$root"
	EXPECTED_REVISION="$(git -C "$server_root" rev-parse HEAD)"
	identity_env_node_revision_is_allowed "$EXPECTED_REVISION" "$server_root"
	mkdir -p "$APP_ROOT/winwidget.ru_server/.git"
	host_node="$(command -v node)"
	fake_docker="$root/fake-docker"
	docker_log="$root/docker-arguments.log"
	cat >"$fake_docker" <<'DOCKER'
#!/bin/bash
set -eu
{
	printf 'CALL\n'
	for argument in "$@"; do printf 'ARG=%s\n' "$argument"; done
} >>"$IDENTITY_NODE_DOCKER_LOG"
case "${1:-}:${2:-}" in
context:show)
	printf 'default\n'
	;;
context:inspect)
	printf 'unix:///var/run/docker.sock\n'
	;;
info:--format)
	printf 'linux\n'
	;;
ps:--quiet)
	printf '%s\n' "$IDENTITY_NODE_FAKE_CONTAINER_ID"
	if [[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'multiple' ]]; then
		printf '%s\n' "$IDENTITY_NODE_FAKE_SECOND_CONTAINER_ID"
	fi
	;;
inspect:--format)
	if [[ "${3:-}" == *'.Config.Env'* ]]; then
		if [[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'app-revision' ]]; then
			printf 'APP_REVISION=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n'
		elif [[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'untrusted-revision' ]]; then
			printf 'APP_REVISION=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n'
		else
			printf 'APP_REVISION=%s\n' "$IDENTITY_NODE_FAKE_REVISION"
		fi
	else
		health='healthy'
		restarts='0'
		container_revision="$IDENTITY_NODE_FAKE_REVISION"
		[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'unhealthy' ]] && health='unhealthy'
		[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'restarted' ]] && restarts='1'
		[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'container-revision' ]] && \
			container_revision='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
		[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'untrusted-revision' ]] && \
			container_revision='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
		printf 'winwidget|maintenance-worker|False|running|true|%s|%s|%s|%s\n' \
			"$health" "$restarts" "$container_revision" "$IDENTITY_NODE_FAKE_IMAGE_ID"
	fi
	;;
image:inspect)
	user='nestjs'
	image_revision="$IDENTITY_NODE_FAKE_REVISION"
	[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'wrong-user' ]] && user='root'
	[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'image-revision' ]] && \
		image_revision='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
	[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'untrusted-revision' ]] && \
		image_revision='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
	image_id="$IDENTITY_NODE_FAKE_IMAGE_ID"
	[[ "${IDENTITY_NODE_FAKE_CASE:-}" == 'image-id-mismatch' ]] && \
		image_id='sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
	printf '%s|%s|%s\n' "$image_id" "$image_revision" "$user"
	;;
run:--rm)
	[[ "${IDENTITY_NODE_FAKE_CASE:-}" != 'run-failure' ]] || exit 73
	source_path=''
	target_path=''
	after_image='false'
	node_arguments=()
	for argument in "$@"; do
		if [[ "$after_image" == 'true' ]]; then
			node_arguments+=("$argument")
		elif [[ "$argument" == "$IDENTITY_NODE_FAKE_IMAGE_ID" ]]; then
			after_image='true'
		fi
		case "$argument" in
		type=bind,source=*,target=/tmp/identity-env-source,readonly)
			source_path="${argument#type=bind,source=}"
			source_path="${source_path%,target=/tmp/identity-env-source,readonly}"
			;;
		type=bind,source=*,target=/tmp/identity-env-candidate)
			target_path="${argument#type=bind,source=}"
			target_path="${target_path%,target=/tmp/identity-env-candidate}"
			;;
		esac
	done
	[[ -n "$source_path" ]]
	if [[ -n "$target_path" ]]; then
		[[ "${#node_arguments[@]}" == '3' && "${node_arguments[0]}" == '-' &&
			"${node_arguments[1]}" == '/tmp/identity-env-source' &&
			"${node_arguments[2]}" == '/tmp/identity-env-candidate' ]]
		exec "$IDENTITY_NODE_HOST_BINARY" - "$source_path" "$target_path"
	fi
	[[ "${#node_arguments[@]}" == '2' && "${node_arguments[0]}" == '-' &&
		"${node_arguments[1]}" == '/tmp/identity-env-source' ]]
	exec "$IDENTITY_NODE_HOST_BINARY" - "$source_path"
	;;
*)
	exit 74
	;;
esac
DOCKER
	chmod 700 "$fake_docker"
	: >"$docker_log"
	chmod 600 "$docker_log"
	export IDENTITY_NODE_DOCKER_LOG="$docker_log"
	export IDENTITY_NODE_HOST_BINARY="$host_node"
	export IDENTITY_NODE_FAKE_CONTAINER_ID="$container_id"
	export IDENTITY_NODE_FAKE_SECOND_CONTAINER_ID="$second_container_id"
	export IDENTITY_NODE_FAKE_IMAGE_ID="$image_id"
	export IDENTITY_NODE_FAKE_REVISION="$EXPECTED_REVISION"
	export IDENTITY_NODE_FAKE_CASE=''
	export IDENTITY_NODE_SECRET_SENTINEL='must-not-enter-docker-arguments'
	identity_env_docker_binary() { printf '%s\n' "$fake_docker"; }
	identity_env_host_node_available() { return 1; }
	identity_env_node_revision_is_allowed() {
		identity_revision_check_calls=$((identity_revision_check_calls + 1))
		[[ "$1" == "$EXPECTED_REVISION" && "$2" == "$APP_ROOT/winwidget.ru_server" ]]
	}
	id() { [[ "${1:-}" == '-u' ]] && printf '0\n'; }
	uname() { [[ "${1:-}" == '-s' ]] && printf 'Linux\n'; }

	IDENTITY_EXPECTED_REVISION="$EXPECTED_REVISION" \
	IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image" \
	IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds" \
	IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file" \
		identity_env_node_validate "$ENV_FILE" <<'NODE'
const { readFileSync } = require('node:fs');
if (!readFileSync(process.argv[2], 'utf8').includes('JWT_JWKS_URL=')) process.exit(1);
NODE
	(
		set -o noclobber
		: >"$identity_env_bootstrap_candidate_temporary"
	)
	chmod 600 "$identity_env_bootstrap_candidate_temporary"
	IDENTITY_EXPECTED_REVISION="$EXPECTED_REVISION" \
	IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image" \
	IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds" \
	IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file" \
		identity_env_node_generate "$ENV_FILE" "$identity_env_bootstrap_candidate_temporary" <<'NODE'
const { closeSync, constants, openSync, writeFileSync } = require('node:fs');
const fd = openSync(process.argv[3], constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
writeFileSync(fd, 'docker-node-fallback=passed\n', 'utf8');
closeSync(fd);
NODE
	[[ "$(tr -d '\r\n' <"$identity_env_bootstrap_candidate_temporary")" == 'docker-node-fallback=passed' ]]
	[[ "$identity_revision_check_calls" == '2' ]]
	for required_argument in \
		'ARG=--rm' 'ARG=--interactive' 'ARG=--pull' 'ARG=never' \
		'ARG=--network' 'ARG=none' 'ARG=--read-only' 'ARG=--cap-drop' \
		'ARG=ALL' 'ARG=--pids-limit' 'ARG=64' 'ARG=--cpus' 'ARG=1' \
		'ARG=--memory' 'ARG=512m' 'ARG=--memory-swap' 'ARG=512m' \
		'ARG=--log-driver' 'ARG=--user' 'ARG=0:0' 'ARG=--security-opt' \
		'ARG=no-new-privileges' 'ARG=--entrypoint' 'ARG=node' "ARG=$image_id"; do
		grep -Fxq "$required_argument" "$docker_log"
	done
	[[ "$(grep -Fxc "ARG=type=bind,source=$ENV_FILE,target=/tmp/identity-env-source,readonly" \
		"$docker_log")" == '2' ]]
	[[ "$(grep -Fxc "ARG=type=bind,source=$identity_env_bootstrap_candidate_temporary,target=/tmp/identity-env-candidate" \
		"$docker_log")" == '1' ]]
	for env_name in IDENTITY_EXPECTED_REVISION IDENTITY_EXPECTED_POSTGRES_IMAGE \
		IDENTITY_EXPECTED_INTEGRATION_KINDS IDENTITY_EXPECTED_ADMIN_FILE; do
		[[ "$(grep -Fxc "ARG=$env_name" "$docker_log")" == '2' ]]
	done
	[[ "$(grep -Fxc 'ARG=--env' "$docker_log")" == '8' ]]
	! grep -Fq 'IDENTITY_NODE_SECRET_SENTINEL' "$docker_log"

	for negative_case in multiple unhealthy restarted app-revision \
		container-revision wrong-user image-revision image-id-mismatch \
		untrusted-revision; do
		IDENTITY_NODE_FAKE_CASE="$negative_case"
		identity_env_node_image_id=''
		if identity_env_prepare_node_runtime >/dev/null 2>&1; then return 1; fi
	done
	IDENTITY_NODE_FAKE_CASE='run-failure'
	identity_env_node_image_id=''
	if IDENTITY_EXPECTED_REVISION="$EXPECTED_REVISION" \
		IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image" \
		IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds" \
		IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file" \
		identity_env_node_validate "$ENV_FILE" >/dev/null 2>&1 <<'NODE'
process.exit(0);
NODE
	then
		return 1
	fi
	IDENTITY_NODE_FAKE_CASE=''
	DOCKER_HOST='tcp://example.invalid:2376'
	if identity_env_prepare_node_runtime >/dev/null 2>&1; then return 1; fi
	unset DOCKER_HOST
	ln -s "$ENV_FILE" "$identity_env_bootstrap_candidate"
	if identity_env_node_validate "$identity_env_bootstrap_candidate" \
		</dev/null >/dev/null 2>&1; then return 1; fi
	rm -f -- "$identity_env_bootstrap_candidate"
	printf 'outside\n' >"$root/outside.env"
	chmod 600 "$root/outside.env"
	if identity_env_node_validate "$root/outside.env" \
		</dev/null >/dev/null 2>&1; then return 1; fi
	original_stat="$(declare -f stat)"
	stat() {
		if [[ "${1:-}" == '-c' && "${3:-}" == "$ENV_FILE" ]]; then
			printf '0:0:644\n'
			return
		fi
		command stat "$@"
	}
	if identity_env_node_validate "$ENV_FILE" \
		</dev/null >/dev/null 2>&1; then return 1; fi
	eval "$original_stat"
)

for recovery_case in \
	run_normal_and_export_boundaries \
	run_source_protection_resume \
	run_crash_after_env_move \
	run_marker_finalize_resume \
	run_admin_and_candidate_crash_rollbacks \
	run_conditional_and_command_failures \
	run_docker_node_fallback_contract; do
	printf 'identity_production_env_recovery_case=%s\n' "$recovery_case"
	"$recovery_case"
done
printf 'identity_production_env_recovery_test=passed\n'
