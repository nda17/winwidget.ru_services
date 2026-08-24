#!/usr/bin/env bash

# Shared immutable release identity and safe Compose wrapper for Support.
# The production env is only passed to Docker Compose and is never printed.

set -Eeuo pipefail

support_release_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

support_release_validate_revision() {
	[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] ||
		support_release_fail 'Support release requires an exact 40-character Git revision.'
}

support_release_validate_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] ||
		support_release_fail "Support release input is not a regular file: ${1:-missing}"
}

support_release_require_local_docker() {
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] ||
		support_release_fail 'Ambient Docker endpoint overrides are forbidden.' || return 1
	[[ "$(docker context show)" == 'default' &&
		"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == \
		'unix:///var/run/docker.sock' &&
		"$(docker info --format '{{.OSType}}')" == 'linux' ]] ||
		support_release_fail 'The canonical local production Docker daemon is required.'
}

support_read_env_value() {
	[[ $# -eq 2 && "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
	support_release_validate_file "$1" || return 1
	awk -F= -v key="$2" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

support_release_require_checkout() {
	[[ $# -eq 2 ]] || return 1
	local server_root="$1" revision="$2" actual
	support_release_validate_revision "$revision" || return 1
	[[ -d "$server_root/.git" && ! -L "$server_root" ]] ||
		support_release_fail 'Support release checkout is missing or unsafe.' || return 1
	actual="$(git -C "$server_root" rev-parse HEAD)" || return 1
	[[ "$actual" == "$revision" ]] ||
		support_release_fail "Support release checkout revision differs from $revision." || return 1
	git -C "$server_root" diff --quiet --no-ext-diff HEAD -- ||
		support_release_fail 'Support production release refuses a dirty tracked worktree.' || return 1
	[[ -z "$(git -C "$server_root" ls-files --others --exclude-standard | sed -n '1p')" ]] ||
		support_release_fail 'Support production release refuses untracked files.'
}

support_release_image() {
	support_release_validate_revision "$1" || return 1
	printf 'winwidget-support:git-%s\n' "$1"
}

support_release_compose() {
	[[ $# -ge 4 ]] || return 1
	local revision="$1" env_file="$2" compose_file="$3"
	shift 3
	support_release_validate_revision "$revision" || return 1
	support_release_validate_file "$env_file" || return 1
	support_release_validate_file "$compose_file" || return 1
	local support_image notification_delivery_image campaigns_image
	local reporting_image widgets_image billing_image identity_image platform_image
	support_image="$(support_release_image "$revision")" || return 1
	notification_delivery_image="winwidget-notification-delivery:git-$revision"
	campaigns_image="winwidget-campaigns:git-$revision"
	reporting_image="winwidget-reporting:git-$revision"
	widgets_image="winwidget-widgets:git-$revision"
	billing_image="winwidget-billing:git-$revision"
	identity_image="winwidget-identity:git-$revision"
	platform_image="winwidget-platform:git-$revision"
	env \
		APP_REVISION="$revision" \
		APP_VERSION="git-$revision" \
		MAINTENANCE_REVISION="$revision" \
		DATABASE_RESTORE_REVISION="$revision" \
		NOTIFICATION_DELIVERY_REVISION="$revision" \
		NOTIFICATION_DELIVERY_IMAGE="$notification_delivery_image" \
		CAMPAIGNS_REVISION="$revision" \
		CAMPAIGNS_IMAGE="$campaigns_image" \
		REPORTING_REVISION="$revision" \
		REPORTING_IMAGE="$reporting_image" \
		WIDGETS_REVISION="$revision" \
		WIDGETS_IMAGE="$widgets_image" \
		BILLING_REVISION="$revision" \
		BILLING_IMAGE="$billing_image" \
		IDENTITY_REVISION="$revision" \
		IDENTITY_IMAGE="$identity_image" \
		PLATFORM_REVISION="$revision" \
		PLATFORM_IMAGE="$platform_image" \
		SUPPORT_REVISION="$revision" \
		SUPPORT_IMAGE="$support_image" \
		docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

support_release_self_test() {
	local revision='0123456789abcdef0123456789abcdef01234567'
	support_release_validate_revision "$revision"
	[[ "$(support_release_image "$revision")" == "winwidget-support:git-$revision" ]] ||
		return 1
	if support_release_validate_revision latest >/dev/null 2>&1; then
		support_release_fail 'Support release self-test accepted a mutable revision.'
		return 1
	fi
	local source app_version_contract='APP_VERSION="git-$revision"'
	source="$(declare -f support_release_compose support_release_require_checkout \
		support_release_require_local_docker)"
	[[ "$source" == *'docker compose --env-file'* &&
		"$source" == *"$app_version_contract"* &&
		"$source" == *'NOTIFICATION_DELIVERY_IMAGE'* &&
		"$source" == *'CAMPAIGNS_IMAGE'* &&
		"$source" == *'REPORTING_IMAGE'* &&
		"$source" == *'WIDGETS_IMAGE'* &&
		"$source" == *'BILLING_IMAGE'* &&
		"$source" == *'IDENTITY_IMAGE'* &&
		"$source" == *'PLATFORM_IMAGE'* &&
		"$source" == *'SUPPORT_REVISION'* &&
		"$source" == *'SUPPORT_IMAGE'* &&
		"$source" == *'diff --quiet --no-ext-diff HEAD'* &&
		"$source" == *'unix:///var/run/docker.sock'* ]] || return 1
	printf 'support_release_identity_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--self-test) support_release_self_test ;;
	*) support_release_fail 'Usage: support-release-identity.sh --self-test' ;;
	esac
fi
