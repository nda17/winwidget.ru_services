#!/usr/bin/env bash

# Shared single-VPS deployment lock. Source this file and call
# acquire_production_deploy_lock before any Docker build/up/migrate operation.
# The fixed inherited descriptor lets an explicitly nested deployment reuse the
# same lock without attempting a second flock on a different open file.

acquire_production_deploy_lock() {
	local operation="${1:-production deployment}"
	local lock_file="${PRODUCTION_DEPLOY_LOCK_FILE:-${APP_ROOT:-/opt/winwidget}/deploy/backend/.production-deploy.lock}"
	local descriptor_path=""
	local descriptor_target=""

	if [[ "${PRODUCTION_DEPLOY_LOCK_FD:-}" =~ ^[0-9]+$ ]]; then
		descriptor_path="/proc/$$/fd/$PRODUCTION_DEPLOY_LOCK_FD"
	fi
	if [[ -n "$descriptor_path" && -e "$descriptor_path" ]]; then
		descriptor_target="$(readlink "$descriptor_path" 2>/dev/null || true)"
	fi
	if [[ "${WINWIDGET_PRODUCTION_DEPLOY_LOCK_HELD:-}" == "$lock_file" &&
		"$descriptor_target" == "$lock_file" ]]; then
		return
	fi

	mkdir -p "$(dirname "$lock_file")"
	exec {PRODUCTION_DEPLOY_LOCK_FD}>"$lock_file"
	chown 0:0 "$lock_file"
	chmod 600 "$lock_file"
	if ! flock -n "$PRODUCTION_DEPLOY_LOCK_FD"; then
		echo "Another production deployment holds $lock_file; refusing to start $operation." >&2
		exit 1
	fi

	export WINWIDGET_PRODUCTION_DEPLOY_LOCK_HELD="$lock_file"
	export PRODUCTION_DEPLOY_LOCK_FD
}
