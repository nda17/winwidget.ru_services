#!/usr/bin/env bash

# Shared immutable release identity and safe Compose wrapper for Identity.
# The production env is only passed to Docker Compose and is never printed.

set -Eeuo pipefail

identity_release_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

identity_release_validate_revision() {
	[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] ||
		identity_release_fail 'Identity release requires an exact 40-character Git revision.'
}

identity_release_validate_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] ||
		identity_release_fail "Identity release input is not a regular file: ${1:-missing}"
}

identity_read_env_value() {
	[[ $# -eq 2 && "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
	identity_release_validate_file "$1" || return 1
	awk -F= -v key="$2" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

identity_release_require_checkout() {
	[[ $# -eq 2 ]] || return 1
	local server_root="$1" revision="$2" actual
	identity_release_validate_revision "$revision" || return 1
	[[ -d "$server_root/.git" && ! -L "$server_root" ]] ||
		identity_release_fail 'Identity release checkout is missing or unsafe.' || return 1
	actual="$(git -C "$server_root" rev-parse HEAD)" || return 1
	[[ "$actual" == "$revision" ]] ||
		identity_release_fail "Identity release checkout revision differs from $revision." || return 1
	git -C "$server_root" diff --quiet --no-ext-diff HEAD -- ||
		identity_release_fail 'Identity production release refuses a dirty tracked worktree.' || return 1
	[[ -z "$(git -C "$server_root" ls-files --others --exclude-standard | sed -n '1p')" ]] ||
		identity_release_fail 'Identity production release refuses untracked files.'
}

identity_release_image() {
	identity_release_validate_revision "$1" || return 1
	printf 'winwidget-identity:git-%s\n' "$1"
}

identity_release_compose() {
	[[ $# -ge 4 ]] || return 1
	local revision="$1" env_file="$2" compose_file="$3"
	shift 3
	identity_release_validate_revision "$revision" || return 1
	identity_release_validate_file "$env_file" || return 1
	identity_release_validate_file "$compose_file" || return 1
	local identity_image campaigns_image reporting_image widgets_image billing_image
	identity_image="$(identity_release_image "$revision")" || return 1
	campaigns_image="winwidget-campaigns:git-$revision"
	reporting_image="winwidget-reporting:git-$revision"
	widgets_image="winwidget-widgets:git-$revision"
	billing_image="winwidget-billing:git-$revision"
	env \
		APP_REVISION="$revision" \
		APP_VERSION="git-$revision" \
		MAINTENANCE_REVISION="$revision" \
		DATABASE_RESTORE_REVISION="$revision" \
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
		docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

identity_release_self_test() {
	local revision='0123456789abcdef0123456789abcdef01234567'
	identity_release_validate_revision "$revision"
	[[ "$(identity_release_image "$revision")" == "winwidget-identity:git-$revision" ]] ||
		return 1
	if identity_release_validate_revision latest >/dev/null 2>&1; then
		identity_release_fail 'Identity release self-test accepted a mutable revision.'
		return 1
	fi
	local source
	source="$(declare -f identity_release_compose identity_release_require_checkout)"
	[[ "$source" == *'docker compose --env-file'* &&
		"$source" == *'APP_VERSION="git-$revision"'* &&
		"$source" == *'CAMPAIGNS_REVISION'* &&
		"$source" == *'REPORTING_IMAGE'* &&
		"$source" == *'WIDGETS_IMAGE'* &&
		"$source" == *'BILLING_IMAGE'* &&
		"$source" == *'IDENTITY_REVISION'* &&
		"$source" == *'IDENTITY_IMAGE'* &&
		"$source" == *'diff --quiet --no-ext-diff HEAD'* ]] || return 1
	printf 'identity_release_identity_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--self-test) identity_release_self_test ;;
	*) identity_release_fail 'Usage: identity-release-identity.sh --self-test' ;;
	esac
fi
