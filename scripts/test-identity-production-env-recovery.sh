#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
server_root="$(cd "$script_dir/.." && pwd -P)"
control_script="$server_root/scripts/identity-production-env-control.sh"
fixture_parent="${TMPDIR:-/tmp}"
fixture_root="$(mktemp -d "$fixture_parent/winwidget-identity-env-recovery.XXXXXX")"
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
	local root="$fixture_root/crash-admin"
	configure_fixture "$root"
	cp "$ENV_FILE" "$root/source.expected"
	chmod 600 "$root/source.expected"
	IDENTITY_ENV_EXPECTED_SHA256="$(identity_env_sha256 "$ENV_FILE")"
	node() { return 95; }
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	unset -f node
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
	node() {
		printf 'partial\n' >"$3"
		chmod 600 "$3"
		return 96
	}
	if identity_env_bootstrap >/dev/null 2>&1; then return 1; fi
	unset -f node
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

for recovery_case in \
	run_normal_and_export_boundaries \
	run_source_protection_resume \
	run_crash_after_env_move \
	run_marker_finalize_resume \
	run_admin_and_candidate_crash_rollbacks \
	run_conditional_and_command_failures; do
	printf 'identity_production_env_recovery_case=%s\n' "$recovery_case"
	"$recovery_case"
done
printf 'identity_production_env_recovery_test=passed\n'
