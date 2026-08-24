#!/usr/bin/env bash

# Immutable release identity and Compose wrapper shared by Platform lifecycle tools.
# Values from the production env are passed to Compose without being printed.

set -Eeuo pipefail

platform_release_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

platform_release_validate_revision() {
	[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] ||
		platform_release_fail 'Platform release requires an exact 40-character Git revision.'
}

platform_release_validate_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] ||
		platform_release_fail "Platform release input is not a regular file: ${1:-missing}"
}

platform_read_env_value() {
	[[ $# -eq 2 && "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
	platform_release_validate_file "$1" || return 1
	awk -F= -v key="$2" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

platform_release_require_checkout() {
	[[ $# -eq 2 ]] || return 1
	local server_root="$1" revision="$2" actual
	platform_release_validate_revision "$revision" || return 1
	[[ -d "$server_root/.git" && ! -L "$server_root" ]] ||
		platform_release_fail 'Platform release checkout is missing or unsafe.' || return 1
	actual="$(git -C "$server_root" rev-parse HEAD)" || return 1
	[[ "$actual" == "$revision" ]] ||
		platform_release_fail "Platform release checkout revision differs from $revision." || return 1
	git -C "$server_root" diff --quiet --no-ext-diff HEAD -- ||
		platform_release_fail 'Platform production release refuses a dirty tracked worktree.' || return 1
	[[ -z "$(git -C "$server_root" ls-files --others --exclude-standard | sed -n '1p')" ]] ||
		platform_release_fail 'Platform production release refuses untracked files.'
}

platform_release_image() {
	platform_release_validate_revision "$1" || return 1
	printf 'winwidget-platform:git-%s\n' "$1"
}

platform_release_compose() {
	[[ $# -ge 4 ]] || return 1
	local revision="$1" env_file="$2" compose_file="$3"
	shift 3
	platform_release_validate_revision "$revision" || return 1
	platform_release_validate_file "$env_file" || return 1
	platform_release_validate_file "$compose_file" || return 1
	local platform_image app_version billing_image
	platform_image="$(platform_release_image "$revision")" || return 1
	app_version="${PLATFORM_RELEASE_APP_VERSION_OVERRIDE:-git-$revision}"
	billing_image="${PLATFORM_RELEASE_BILLING_IMAGE_OVERRIDE:-winwidget-billing:git-$revision}"
	[[ "$app_version" == "git-$revision" ||
		"$app_version" =~ ^cutover-$revision-g[1-9][0-9]{0,17}$ ]] ||
		platform_release_fail 'Platform Compose app image override is invalid.' || return 1
	[[ "$billing_image" == "winwidget-billing:git-$revision" ||
		"$billing_image" =~ ^winwidget-billing:cutover-$revision-g[1-9][0-9]{0,17}$ ]] ||
		platform_release_fail 'Platform Compose Billing image override is invalid.' || return 1
	env \
		APP_REVISION="$revision" \
		APP_VERSION="$app_version" \
		MAINTENANCE_REVISION="$revision" \
		DATABASE_RESTORE_REVISION="$revision" \
		NOTIFICATION_DELIVERY_REVISION="$revision" \
		NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$revision" \
		CAMPAIGNS_REVISION="$revision" \
		CAMPAIGNS_IMAGE="winwidget-campaigns:git-$revision" \
		REPORTING_REVISION="$revision" \
		REPORTING_IMAGE="winwidget-reporting:git-$revision" \
		WIDGETS_REVISION="$revision" \
		WIDGETS_IMAGE="winwidget-widgets:git-$revision" \
		BILLING_REVISION="$revision" \
		BILLING_IMAGE="$billing_image" \
		IDENTITY_REVISION="$revision" \
		IDENTITY_IMAGE="winwidget-identity:git-$revision" \
		PLATFORM_REVISION="$revision" \
		PLATFORM_IMAGE="$platform_image" \
		docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

platform_release_self_test() {
	local revision='0123456789abcdef0123456789abcdef01234567' source
	platform_release_validate_revision "$revision"
	[[ "$(platform_release_image "$revision")" == "winwidget-platform:git-$revision" ]]
	! platform_release_validate_revision latest >/dev/null 2>&1
	source="$(declare -f platform_release_compose platform_release_require_checkout)"
	[[ "$source" == *'docker compose --env-file'* &&
		"$source" == *'PLATFORM_RELEASE_APP_VERSION_OVERRIDE'* &&
		"$source" == *'PLATFORM_RELEASE_BILLING_IMAGE_OVERRIDE'* &&
		"$source" == *'cutover-$revision-g'* &&
		"$source" == *'PLATFORM_REVISION'* &&
		"$source" == *'PLATFORM_IMAGE'* &&
		"$source" == *'diff --quiet --no-ext-diff HEAD'* ]]
	printf 'platform_release_identity_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--self-test) platform_release_self_test ;;
	*) platform_release_fail 'Usage: platform-release-identity.sh --self-test' ;;
	esac
fi
