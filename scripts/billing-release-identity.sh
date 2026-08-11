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
	printf '%s\n' "$1" | node -e '
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
	printf 'billing_release_identity_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -Eeuo pipefail
	case "${1:-}" in
	--self-test) billing_release_identity_self_test ;;
	*) billing_release_fail 'Usage: billing-release-identity.sh --self-test' ;;
	esac
fi
