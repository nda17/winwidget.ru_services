#!/usr/bin/env bash

CAMPAIGNS_DATABASE_CUTOVER_MARKER="${CAMPAIGNS_DATABASE_CUTOVER_MARKER:-${APP_ROOT:-/opt/winwidget}/deploy/backend/.campaigns-database-cutover-v1}"
CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER="${CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER:-${APP_ROOT:-/opt/winwidget}/deploy/backend/.campaigns-first-cutover-staged-v1}"
CAMPAIGNS_POSTGRES_SERVICE="campaigns-postgres"
CAMPAIGNS_CANONICAL_POSTGRES_IMAGE="postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
CAMPAIGNS_CANONICAL_POSTGRES_VOLUME="winwidget-campaigns-postgres-data"
CAMPAIGNS_CANONICAL_ADMIN_USER="winwidget_campaigns_admin"

campaigns_first_cutover_staged_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER"
}

validate_campaigns_first_cutover_staged_marker() {
	local marker="$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER"
	local mode owner

	[[ -f "$marker" && ! -L "$marker" ]] || return 1
	mode="$(stat -c '%a' "$marker" 2>/dev/null || true)"
	owner="$(stat -c '%u:%g' "$marker" 2>/dev/null || true)"
	[[ "$mode" == "600" && "$owner" == "0:0" ]] || return 1

	awk -F= '
		{
			if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=[^[:cntrl:]]*$/ ||
				($1 != "revision" && $1 != "switch_generation_seed" &&
				 $1 != "staged_at") ||
				seen[$1]++) invalid = 1
			value[$1] = substr($0, index($0, "=") + 1)
		}
		END {
			if (seen["revision"] != 1 ||
				seen["switch_generation_seed"] != 1 ||
				seen["staged_at"] != 1 ||
				length(value["revision"]) != 40 ||
				value["revision"] !~ /^[0-9a-f]+$/ ||
				value["switch_generation_seed"] !~ /^(0|[1-9][0-9]{0,17})$/ ||
				value["staged_at"] !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) {
				invalid = 1
			}
			exit(invalid ? 1 : 0)
		}
	' "$marker"
}

require_campaigns_first_cutover_staged_revision() {
	local expected_revision="$1"
	local staged_revision

	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo "Expected Campaigns staged revision is invalid." >&2
		return 1
	}
	validate_campaigns_first_cutover_staged_marker || {
		echo "A valid root-owned Campaigns first-cutover staged marker is required." >&2
		return 1
	}
	staged_revision="$(
		campaigns_first_cutover_staged_value revision
	)"
	[[ "$staged_revision" == "$expected_revision" ]] || {
		echo "Campaigns first-cutover revision is already staged as $staged_revision; refusing $expected_revision." >&2
		return 1
	}
}

write_campaigns_first_cutover_staged_marker() {
	local revision="$1"
	local requested_switch_generation_seed="${2-}"
	local marker="$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER"
	local marker_directory switch_generation_seed temporary_marker

	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo "Campaigns staged revision is invalid." >&2
		return 1
	}
	if [[ -e "$marker" || -L "$marker" ]]; then
		require_campaigns_first_cutover_staged_revision "$revision"
		switch_generation_seed="$(
			campaigns_first_cutover_staged_value switch_generation_seed
		)"
		[[ -z "$requested_switch_generation_seed" ||
			"$switch_generation_seed" == \
			"$requested_switch_generation_seed" ]] || {
			echo "Campaigns staged switch generation seed differs from the existing marker." >&2
			return 1
		}
		return
	fi
	switch_generation_seed="${requested_switch_generation_seed:-0}"
	[[ "$switch_generation_seed" =~ ^(0|[1-9][0-9]{0,17})$ ]] || {
		echo "Campaigns staged switch generation seed is invalid." >&2
		return 1
	}
	marker_directory="$(dirname "$marker")"
	[[ -d "$marker_directory" && ! -L "$marker_directory" ]] || {
		echo "Campaigns staged marker directory is missing or unsafe." >&2
		return 1
	}
	temporary_marker="$marker_directory/.campaigns-first-cutover-staged-v1.$$"
	[[ ! -e "$temporary_marker" && ! -L "$temporary_marker" ]] || {
		echo "Campaigns temporary staged marker already exists." >&2
		return 1
	}
	if ! {
		(
			umask 077
			{
				printf 'revision=%s\n' "$revision"
				printf 'switch_generation_seed=%s\n' "$switch_generation_seed"
				printf 'staged_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
			} >"$temporary_marker"
		) &&
			chown 0:0 "$temporary_marker" &&
			chmod 600 "$temporary_marker" &&
			mv -f "$temporary_marker" "$marker"
	}; then
		rm -f -- "$temporary_marker"
		echo "Failed to create the Campaigns staged marker." >&2
		return 1
	fi
	require_campaigns_first_cutover_staged_revision "$revision"
}

guard_campaigns_cutover_checkout_revision() {
	local expected_revision="$1"
	local cutover_phase cutover_revision

	[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo "Expected Campaigns checkout revision is invalid." >&2
		return 1
	}
	if [[ -e "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ||
		-L "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ]]; then
		validate_campaigns_database_cutover_marker || {
			echo "Campaigns database cutover marker is invalid." >&2
			return 1
		}
		cutover_phase="$(campaigns_database_marker_value phase)"
		if [[ "$cutover_phase" == "complete" ]]; then
			return
		fi
		cutover_revision="$(campaigns_database_marker_value revision)"
		[[ "$cutover_revision" == "$expected_revision" ]] || {
			echo "Campaigns cutover phase $cutover_phase is pinned to $cutover_revision; refusing checkout $expected_revision." >&2
			return 1
		}
		require_campaigns_first_cutover_staged_revision "$expected_revision"
		return
	fi
	if [[ -e "$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER" ||
		-L "$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER" ]]; then
		require_campaigns_first_cutover_staged_revision "$expected_revision"
	fi
}

campaigns_full_deploy_action() {
	local automatic_prod_push="$1"
	local cutover_phase="$2"

	[[ "$automatic_prod_push" == "true" ||
		"$automatic_prod_push" == "false" ]] || return 1
	case "$cutover_phase" in
	missing)
		if [[ "$automatic_prod_push" == "true" ]]; then
			printf 'stage\n'
		else
			printf 'block\n'
		fi
		;;
	complete)
		printf 'deploy\n'
		;;
	preflight | target-created | roles-ready | migrated | source-frozen | importing | copied | verified | switching | switched | forward-only | source-dropped)
		printf 'block\n'
		;;
	*)
		return 1
		;;
	esac
}

campaigns_database_marker_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
}

validate_campaigns_database_cutover_marker() {
	local marker="$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
	local mode owner

	[[ -f "$marker" && ! -L "$marker" ]] || return 1
	mode="$(stat -c '%a' "$marker" 2>/dev/null || true)"
	owner="$(stat -c '%u:%g' "$marker" 2>/dev/null || true)"
	[[ "$mode" == "600" && "$owner" == "0:0" ]] || return 1

	awk -F= \
		-v expected_volume="$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME" \
		-v expected_artifact_prefix="${APP_ROOT:-/opt/winwidget}/deploy/backend/campaigns-database-cutover." '
		function valid_hex(value, expected_length) {
			return length(value) == expected_length && value ~ /^[0-9a-f]+$/
		}
		function valid_hash(value) {
			return value == "pending" || valid_hex(value, 64)
		}
		function valid_image(value, empty_value) {
			return value == empty_value ||
				(substr(value, 1, 7) == "sha256:" &&
				 valid_hex(substr(value, 8), 64))
		}
		function valid_revision(value) {
			return value == "none" || valid_hex(value, 40)
		}
		function valid_timestamp(value) {
			return value ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/
		}
		function valid_base64_or_pending(value) {
			return value == "pending" ||
				value ~ /^[A-Za-z0-9+\/]+$/ ||
				value ~ /^[A-Za-z0-9+\/]+=$/ ||
				value ~ /^[A-Za-z0-9+\/]+==$/
		}
		BEGIN {
			allowed["phase"] = 1
			allowed["revision"] = 1
			allowed["cutover_started_at"] = 1
			allowed["source_schema_state"] = 1
			allowed["target_volume"] = 1
			allowed["artifact_directory"] = 1
			allowed["postgres_image_id"] = 1
			allowed["postgres_system_identifier"] = 1
			allowed["source_manifest_sha256"] = 1
			allowed["target_manifest_sha256"] = 1
			allowed["contract_migration_sha256"] = 1
			allowed["target_api_image_id"] = 1
			allowed["target_gateway_image_id"] = 1
			allowed["target_maintenance_image_id"] = 1
			allowed["target_notification_image_id"] = 1
			allowed["target_campaigns_image_id"] = 1
			allowed["switch_generation"] = 1
			allowed["telegram_audit_decision"] = 1
			allowed["telegram_audit_reference_sha256"] = 1
			allowed["restore_drill_reference_sha256"] = 1
			allowed["previous_image_id"] = 1
			allowed["previous_revision"] = 1
			allowed["previous_gateway_image_id"] = 1
			allowed["previous_gateway_routes_base64"] = 1
			allowed["previous_maintenance_image_id"] = 1
			allowed["previous_notification_image_id"] = 1
			allowed["rollback_maintenance_revision"] = 1
			allowed["rollback_notification_revision"] = 1
			allowed["updated_at"] = 1
		}
		{
			if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=[^[:cntrl:]]*$/ ||
				!allowed[$1] || seen[$1]++) invalid = 1
			value[$1] = substr($0, index($0, "=") + 1)
		}
		END {
			for (key in allowed) if (!seen[key]) invalid = 1
			if (value["phase"] !~ /^(preflight|target-created|roles-ready|migrated|source-frozen|importing|copied|verified|switching|switched|forward-only|source-dropped|complete)$/ ||
				!valid_hex(value["revision"], 40) ||
				!valid_timestamp(value["cutover_started_at"]) ||
				value["source_schema_state"] !~ /^(retained|dropped)$/ ||
				value["target_volume"] != expected_volume ||
				index(value["artifact_directory"], expected_artifact_prefix) != 1 ||
				value["artifact_directory"] !~ /^[A-Za-z0-9_./:-]+$/ ||
				!valid_image(value["postgres_image_id"], "pending") ||
				value["postgres_system_identifier"] !~ /^(pending|[0-9]+)$/ ||
				!valid_hash(value["source_manifest_sha256"]) ||
				!valid_hash(value["target_manifest_sha256"]) ||
				!valid_hex(value["contract_migration_sha256"], 64) ||
				!valid_image(value["target_api_image_id"], "pending") ||
				!valid_image(value["target_gateway_image_id"], "pending") ||
				!valid_image(value["target_maintenance_image_id"], "pending") ||
				!valid_image(value["target_notification_image_id"], "pending") ||
				!valid_image(value["target_campaigns_image_id"], "pending") ||
				value["switch_generation"] !~ /^(0|[1-9][0-9]*)$/ ||
				value["telegram_audit_decision"] !~ /^(pending|completed)$/ ||
				!(value["telegram_audit_reference_sha256"] == "pending" ||
				  valid_hex(value["telegram_audit_reference_sha256"], 64)) ||
				!(value["restore_drill_reference_sha256"] == "pending" ||
				  valid_hex(value["restore_drill_reference_sha256"], 64)) ||
				!valid_image(value["previous_image_id"], "none") ||
				!valid_revision(value["previous_revision"]) ||
				!valid_image(value["previous_gateway_image_id"], "none") ||
				!valid_base64_or_pending(value["previous_gateway_routes_base64"]) ||
				!valid_image(value["previous_maintenance_image_id"], "none") ||
				!valid_image(value["previous_notification_image_id"], "none") ||
				!valid_revision(value["rollback_maintenance_revision"]) ||
				!valid_revision(value["rollback_notification_revision"]) ||
				!valid_timestamp(value["updated_at"])) invalid = 1
			if (value["phase"] ~ /^(copied|verified|switching|switched|forward-only|source-dropped|complete)$/ &&
				(value["source_manifest_sha256"] == "pending" ||
				 value["target_manifest_sha256"] == "pending" ||
				 value["source_manifest_sha256"] != value["target_manifest_sha256"])) invalid = 1
			if (value["phase"] == "importing" &&
				value["source_manifest_sha256"] == "pending") invalid = 1
			if (value["phase"] != "preflight" &&
				(value["postgres_image_id"] == "pending" ||
				 value["postgres_system_identifier"] == "pending")) invalid = 1
			if (value["target_api_image_id"] == "pending" ||
				value["target_gateway_image_id"] == "pending" ||
				value["target_maintenance_image_id"] == "pending" ||
				value["target_notification_image_id"] == "pending" ||
				value["target_campaigns_image_id"] == "pending") invalid = 1
			if (value["phase"] ~ /^(source-dropped|complete)$/ &&
				(value["source_schema_state"] != "dropped" ||
				 value["switch_generation"] == "0" ||
				 value["telegram_audit_decision"] != "completed" ||
				 value["telegram_audit_reference_sha256"] == "pending" ||
				 value["restore_drill_reference_sha256"] == "pending")) invalid = 1
			if (value["phase"] ~ /^(switching|switched|forward-only|source-dropped|complete)$/ &&
				value["switch_generation"] == "0") invalid = 1
			if (value["phase"] == "switching" &&
				(value["telegram_audit_decision"] != "pending" ||
				 value["telegram_audit_reference_sha256"] != "pending" ||
				 value["restore_drill_reference_sha256"] != "pending")) invalid = 1
			if (value["phase"] !~ /^(source-dropped|complete)$/ &&
				value["source_schema_state"] != "retained") invalid = 1
			if (value["phase"] ~ /^(source-frozen|importing|copied|verified|switching|switched|forward-only|source-dropped|complete)$/ &&
				(value["previous_image_id"] == "none" ||
				 value["previous_revision"] == "none" ||
				 value["previous_gateway_image_id"] == "none" ||
				 value["previous_gateway_routes_base64"] == "pending" ||
				 value["previous_maintenance_image_id"] == "none" ||
				 value["previous_notification_image_id"] == "none" ||
				 value["rollback_maintenance_revision"] == "none" ||
				 value["rollback_notification_revision"] == "none")) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$marker"
}

assert_campaigns_database_postgres_identity() {
	local image port volume admin_user password_file

	image="$(get_env_value CAMPAIGNS_POSTGRES_IMAGE)"
	port="$(get_env_value CAMPAIGNS_POSTGRES_PORT)"
	volume="$(get_env_value CAMPAIGNS_POSTGRES_DATA_VOLUME)"
	admin_user="$(get_env_value CAMPAIGNS_POSTGRES_ADMIN_USER)"
	password_file="$(get_env_value CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE)"

	[[ "$image" == "$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" ]] || {
		echo "CAMPAIGNS_POSTGRES_IMAGE must use the reviewed PostgreSQL 18 digest." >&2
		return 1
	}
	[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] || {
		echo "CAMPAIGNS_POSTGRES_PORT must be a valid non-privileged loopback port." >&2
		return 1
	}
	[[ "$volume" == "$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME" ]] || {
		echo "CAMPAIGNS_POSTGRES_DATA_VOLUME must be $CAMPAIGNS_CANONICAL_POSTGRES_VOLUME." >&2
		return 1
	}
	[[ "$admin_user" == "$CAMPAIGNS_CANONICAL_ADMIN_USER" ]] || {
		echo "CAMPAIGNS_POSTGRES_ADMIN_USER must be $CAMPAIGNS_CANONICAL_ADMIN_USER." >&2
		return 1
	}
	[[ "$password_file" == "${APP_ROOT:-/opt/winwidget}/deploy/backend/.campaigns-postgres-admin-password" ]] || {
		echo "CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE must use the canonical deploy secret path." >&2
		return 1
	}
	[[ -f "$password_file" && ! -L "$password_file" ]] || {
		echo "Campaigns PostgreSQL admin password must be a regular non-symlink file." >&2
		return 1
	}
	[[ "$(stat -c '%a' "$password_file")" == "600" &&
		"$(stat -c '%u:%g' "$password_file")" == "0:0" ]] || {
		echo "Campaigns PostgreSQL admin password must be root-owned with mode 600." >&2
		return 1
	}
}

campaigns_database_libpq_url() {
	local key="$1"
	printf '%s' "$(get_env_value "$key")" |
		docker run --rm -i --network none \
			--entrypoint node "${CAMPAIGNS_IMAGE:?CAMPAIGNS_IMAGE is required}" \
			-e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
for (const key of [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "statement_cache_size",
]) {
  url.searchParams.delete(key);
}
process.stdout.write(url.toString());
'
}

campaigns_database_psql() {
	local key="$1"
	shift
	local command_status url
	local PGURL
	url="$(campaigns_database_libpq_url "$key")"
	PGURL="$url"
	export PGURL
	if docker run --rm -i --network host \
		-e PGURL \
		"$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" \
		sh -euc 'psql --no-psqlrc --set ON_ERROR_STOP=1 "$PGURL" "$@"' sh "$@"; then
		command_status=0
	else
		command_status="$?"
	fi
	unset PGURL
	return "$command_status"
}

verify_campaigns_database_access_boundaries() {
	local runtime_state migration_state backup_state
	runtime_state="$(
		campaigns_database_psql CAMPAIGNS_DATABASE_URL \
			--tuples-only --no-align --command '
SELECT CASE WHEN
	current_user = '"'"'winwidget_campaigns_runtime'"'"'
	AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user)
	AND NOT has_database_privilege(current_user, current_database(), '"'"'CREATE'"'"')
	AND NOT has_schema_privilege(current_user, '"'"'campaigns'"'"', '"'"'CREATE'"'"')
	AND NOT (
		has_table_privilege(current_user, '"'"'campaigns._prisma_migrations'"'"', '"'"'SELECT'"'"')
		OR has_table_privilege(current_user, '"'"'campaigns._prisma_migrations'"'"', '"'"'INSERT'"'"')
		OR has_table_privilege(current_user, '"'"'campaigns._prisma_migrations'"'"', '"'"'UPDATE'"'"')
		OR has_table_privilege(current_user, '"'"'campaigns._prisma_migrations'"'"', '"'"'DELETE'"'"')
	)
	AND NOT EXISTS (
		SELECT 1
		FROM pg_tables
		WHERE schemaname = '"'"'campaigns'"'"'
			AND tablename <> '"'"'_prisma_migrations'"'"'
			AND NOT (
				has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'SELECT'"'"')
				AND has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'INSERT'"'"')
				AND has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'UPDATE'"'"')
				AND has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'DELETE'"'"')
			)
	)
THEN '"'"'ok'"'"' ELSE '"'"'unsafe'"'"' END;
'
	)"
	[[ "$runtime_state" == "ok" ]] || {
		echo "Campaigns runtime database boundary is unsafe." >&2
		return 1
	}
	campaigns_database_psql CAMPAIGNS_DATABASE_URL --file - <<'SQL'
BEGIN;
INSERT INTO "campaigns"."campaigns" (
	"id", "actor_id", "idempotency_key", "subject", "message",
	"audience", "requested_channel", "updated_at"
) VALUES (
	'00000000-0000-4000-8000-000000000001',
	'deployment-acl-smoke',
	'00000000-0000-4000-8000-000000000002',
	'ACL smoke',
	'Campaigns runtime ACL smoke',
	'ALL',
	'EMAIL',
	CURRENT_TIMESTAMP
);
DELETE FROM "campaigns"."campaigns"
WHERE "id" = '00000000-0000-4000-8000-000000000001';
ROLLBACK;
SQL

	migration_state="$(
		campaigns_database_psql CAMPAIGNS_MIGRATION_DATABASE_URL \
			--tuples-only --no-align --command '
SELECT CASE WHEN
	current_user = '"'"'winwidget_campaigns_migration'"'"'
	AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user)
	AND NOT has_database_privilege(current_user, current_database(), '"'"'CREATE'"'"')
	AND has_schema_privilege(current_user, '"'"'campaigns'"'"', '"'"'CREATE'"'"')
THEN '"'"'ok'"'"' ELSE '"'"'unsafe'"'"' END;
'
	)"
	[[ "$migration_state" == "ok" ]] || {
		echo "Campaigns migration database boundary is unsafe." >&2
		return 1
	}
	campaigns_database_psql CAMPAIGNS_MIGRATION_DATABASE_URL --file - <<'SQL'
BEGIN;
CREATE TABLE "campaigns"."deployment_acl_smoke" ("id" INTEGER NOT NULL);
DROP TABLE "campaigns"."deployment_acl_smoke";
ROLLBACK;
SQL

	backup_state="$(
		campaigns_database_psql CAMPAIGNS_BACKUP_URL \
			--tuples-only --no-align --command '
SELECT CASE WHEN
	current_user = '"'"'winwidget_campaigns_backup'"'"'
	AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user)
	AND NOT has_database_privilege(current_user, current_database(), '"'"'CREATE'"'"')
	AND NOT has_schema_privilege(current_user, '"'"'campaigns'"'"', '"'"'CREATE'"'"')
	AND NOT EXISTS (
		SELECT 1
		FROM pg_tables
		WHERE schemaname = '"'"'campaigns'"'"'
			AND (
				NOT has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'SELECT'"'"')
				OR has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'INSERT'"'"')
				OR has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'UPDATE'"'"')
				OR has_table_privilege(current_user, format('"'"'%I.%I'"'"', schemaname, tablename), '"'"'DELETE'"'"')
			)
	)
THEN '"'"'ok'"'"' ELSE '"'"'unsafe'"'"' END;
'
	)"
	[[ "$backup_state" == "ok" ]] || {
		echo "Campaigns backup database boundary is unsafe." >&2
		return 1
	}
	campaigns_database_psql CAMPAIGNS_BACKUP_URL \
		--command 'SELECT count(*) FROM "campaigns"."_prisma_migrations";' \
		--command 'SELECT count(*) FROM "campaigns"."campaigns";' >/dev/null
	echo "Campaigns migration/runtime/backup database boundaries are verified."
}

create_campaigns_pre_migration_backup() {
	local revision="${CAMPAIGNS_REVISION:-unknown}"
	local backup_directory="${APP_ROOT:-/opt/winwidget}/deploy/backend/campaigns-migration-backups"
	local backup_name
	local command_status
	local backup_url
	local BACKUP_NAME PGURL
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
		echo "Campaigns pre-migration backup requires an exact revision." >&2
		return 1
	}
	if [[ -e "$backup_directory" || -L "$backup_directory" ]]; then
		[[ -d "$backup_directory" && ! -L "$backup_directory" ]] || {
			echo "Campaigns migration backup path is unsafe." >&2
			return 1
		}
	else
		mkdir -m 700 "$backup_directory"
	fi
	chown 0:0 "$backup_directory"
	chmod 700 "$backup_directory"
	backup_name="campaigns-pre-migration-${revision}-$(date -u +'%Y%m%dT%H%M%SZ')"
	backup_url="$(campaigns_database_libpq_url CAMPAIGNS_BACKUP_URL)"
	BACKUP_NAME="$backup_name"
	PGURL="$backup_url"
	export BACKUP_NAME PGURL
	if docker run --rm --network host --user 0:0 \
		-v "$backup_directory:/backup:rw" \
		-e PGURL \
		-e BACKUP_NAME \
		"$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" sh -euc '
pg_dump --format=custom --no-owner --no-acl \
	--schema=campaigns "$PGURL" --file="/backup/$BACKUP_NAME.dump"
pg_restore --list "/backup/$BACKUP_NAME.dump" \
	>"/backup/$BACKUP_NAME.restore-list"
test -s "/backup/$BACKUP_NAME.dump"
test -s "/backup/$BACKUP_NAME.restore-list"
chmod 600 \
	"/backup/$BACKUP_NAME.dump" \
	"/backup/$BACKUP_NAME.restore-list"
	'; then
		command_status=0
	else
		command_status="$?"
	fi
	unset BACKUP_NAME PGURL
	[[ "$command_status" == "0" ]] || return "$command_status"
	sha256sum "$backup_directory/$backup_name.dump" \
		>"$backup_directory/$backup_name.dump.sha256"
	chown 0:0 \
		"$backup_directory/$backup_name.dump" \
		"$backup_directory/$backup_name.restore-list" \
		"$backup_directory/$backup_name.dump.sha256"
	chmod 600 \
		"$backup_directory/$backup_name.dump" \
		"$backup_directory/$backup_name.restore-list" \
		"$backup_directory/$backup_name.dump.sha256"
	echo "Campaigns pre-migration backup verified: $backup_directory/$backup_name.dump"
}

campaigns_postgres_container_id() {
	compose_target --profile campaigns-database ps -a -q "$CAMPAIGNS_POSTGRES_SERVICE" 2>/dev/null || true
}

campaigns_postgres_system_identifier() {
	local container_id="$1"
	docker exec "$container_id" \
		psql --tuples-only --no-align \
			--username "$CAMPAIGNS_CANONICAL_ADMIN_USER" \
			--dbname postgres \
			--command "SELECT system_identifier FROM pg_control_system();" 2>/dev/null |
		tr -d '[:space:]'
}

verify_campaigns_postgres_container() {
	local expected_container_id="${1:-}"
	local expected_image_id="${2:-}"
	local expected_system_identifier="${3:-}"
	local container_id image_id image_ref health restart_count volume_mount port_binding
	local network_identity system_identifier configured_volume configured_port
	local marker_revision marker_started_at volume_cutover_identity

	container_id="$(campaigns_postgres_container_id)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
	[[ -z "$expected_container_id" || "$container_id" == "$expected_container_id" ]] ||
		return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
	configured_volume="$(get_env_value CAMPAIGNS_POSTGRES_DATA_VOLUME)"
	configured_port="$(get_env_value CAMPAIGNS_POSTGRES_PORT)"
	validate_campaigns_database_cutover_marker || return 1
	marker_revision="$(campaigns_database_marker_value revision)" || return 1
	marker_started_at="$(campaigns_database_marker_value cutover_started_at)" || return 1
	volume_cutover_identity="$(
		docker volume inspect "$configured_volume" \
			--format '{{printf "%s|%s|%s|%s" (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.cutover.revision") (index .Labels "com.winwidget.cutover.started-at")}}' \
			2>/dev/null || true
	)"
	volume_mount="$(
		docker inspect \
			--format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{printf "%s|%s|%s|%t" .Destination .Type .Name .RW}}{{end}}{{end}}' \
			"$container_id"
	)"
	port_binding="$(
		docker inspect \
			--format '{{with (index .NetworkSettings.Ports "5432/tcp")}}{{printf "%s|%s|%d" (index . 0).HostIp (index . 0).HostPort (len .)}}{{end}}' \
			"$container_id"
	)"
	network_identity="$(
		docker network inspect winwidget-campaigns-postgres \
			--format '{{printf "%s|%s|%t|%s|%s" .Driver .Scope .Internal (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose")}}' \
			2>/dev/null || true
	)"
	system_identifier="$(campaigns_postgres_system_identifier "$container_id")"

	[[ "$health" == "healthy" && "$restart_count" == "0" ]] || return 1
	[[ "$image_ref" == "$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" ]] || return 1
	[[ "$volume_cutover_identity" == "campaigns|postgres-data|$marker_revision|$marker_started_at" ]] ||
		return 1
	[[ "$volume_mount" == "/var/lib/postgresql|volume|$configured_volume|true" ]] ||
		return 1
	[[ "$port_binding" == "127.0.0.1|$configured_port|1" ]] || return 1
	[[ "$network_identity" == "bridge|local|false|campaigns|postgres-network" ]] ||
		return 1
	[[ "$system_identifier" =~ ^[0-9]+$ ]] || return 1
	[[ -z "$expected_image_id" || "$image_id" == "$expected_image_id" ]] || return 1
	[[ -z "$expected_system_identifier" ||
		"$system_identifier" == "$expected_system_identifier" ]] || return 1
}

initialize_campaigns_database_lifecycle_guard() {
	local operation="${1:-routine Campaigns deployment}"
	local marker_image_id marker_system_identifier

	assert_campaigns_database_postgres_identity || return 1
	validate_campaigns_database_cutover_marker || {
		echo "$operation requires a valid completed Campaigns database cutover marker." >&2
		return 1
	}
	[[ "$(campaigns_database_marker_value phase)" == "complete" ]] || {
		echo "$operation is blocked while Campaigns database cutover is incomplete." >&2
		return 1
	}
	marker_image_id="$(campaigns_database_marker_value postgres_image_id)"
	marker_system_identifier="$(
		campaigns_database_marker_value postgres_system_identifier
	)"

	CAMPAIGNS_GUARD_CONTAINER_ID="$(campaigns_postgres_container_id)"
	verify_campaigns_postgres_container \
		"$CAMPAIGNS_GUARD_CONTAINER_ID" \
		"$marker_image_id" \
		"$marker_system_identifier" || {
		echo "Campaigns PostgreSQL identity differs from the completed cutover marker." >&2
		return 1
	}
	CAMPAIGNS_GUARD_IMAGE_ID="$marker_image_id"
	CAMPAIGNS_GUARD_SYSTEM_IDENTIFIER="$marker_system_identifier"
}

verify_campaigns_database_lifecycle_unchanged() {
	verify_campaigns_postgres_container \
		"${CAMPAIGNS_GUARD_CONTAINER_ID:-}" \
		"${CAMPAIGNS_GUARD_IMAGE_ID:-}" \
		"${CAMPAIGNS_GUARD_SYSTEM_IDENTIFIER:-}" || {
		echo "Campaigns PostgreSQL container, volume or cluster identity changed during deployment." >&2
		return 1
	}
}

campaigns_lifecycle_self_test_write_cutover_marker() {
	local phase="$1"
	local revision="$2"
	local source_schema_state postgres_image_id postgres_system_identifier
	local source_manifest target_manifest telegram_decision telegram_reference
	local restore_reference previous_image previous_revision
	local previous_gateway_image previous_gateway_routes
	local previous_maintenance_image previous_notification_image
	local rollback_maintenance_revision rollback_notification_revision
	local switch_generation
	local target_api_image="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	local target_gateway_image="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	local target_maintenance_image="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	local target_notification_image="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	local target_campaigns_image="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	case "$phase" in
	preflight)
		source_schema_state="retained"
		postgres_image_id="pending"
		postgres_system_identifier="pending"
		source_manifest="pending"
		target_manifest="pending"
		telegram_decision="pending"
		telegram_reference="pending"
		restore_reference="pending"
		previous_image="none"
		previous_revision="none"
		previous_gateway_image="none"
		previous_gateway_routes="pending"
		previous_maintenance_image="none"
		previous_notification_image="none"
		rollback_maintenance_revision="none"
		rollback_notification_revision="none"
		switch_generation="0"
		;;
	switching)
		source_schema_state="retained"
		postgres_image_id="sha256:1111111111111111111111111111111111111111111111111111111111111111"
		postgres_system_identifier="123456789"
		source_manifest="2222222222222222222222222222222222222222222222222222222222222222"
		target_manifest="$source_manifest"
		telegram_decision="pending"
		telegram_reference="pending"
		restore_reference="pending"
		previous_image="sha256:5555555555555555555555555555555555555555555555555555555555555555"
		previous_revision="6666666666666666666666666666666666666666"
		previous_gateway_image="sha256:7777777777777777777777777777777777777777777777777777777777777777"
		previous_gateway_routes="YWJj"
		previous_maintenance_image="sha256:8888888888888888888888888888888888888888888888888888888888888888"
		previous_notification_image="sha256:9999999999999999999999999999999999999999999999999999999999999999"
		rollback_maintenance_revision="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		rollback_notification_revision="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		switch_generation="1"
		;;
	complete)
		source_schema_state="dropped"
		postgres_image_id="sha256:1111111111111111111111111111111111111111111111111111111111111111"
		postgres_system_identifier="123456789"
		source_manifest="2222222222222222222222222222222222222222222222222222222222222222"
		target_manifest="$source_manifest"
		telegram_decision="completed"
		telegram_reference="3333333333333333333333333333333333333333333333333333333333333333"
		restore_reference="4444444444444444444444444444444444444444444444444444444444444444"
		previous_image="sha256:5555555555555555555555555555555555555555555555555555555555555555"
		previous_revision="6666666666666666666666666666666666666666"
		previous_gateway_image="sha256:7777777777777777777777777777777777777777777777777777777777777777"
		previous_gateway_routes="YWJj"
		previous_maintenance_image="sha256:8888888888888888888888888888888888888888888888888888888888888888"
		previous_notification_image="sha256:9999999999999999999999999999999999999999999999999999999999999999"
		rollback_maintenance_revision="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		rollback_notification_revision="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		switch_generation="1"
		;;
	*)
		echo "Unsupported Campaigns lifecycle self-test phase: $phase" >&2
		return 1
		;;
	esac

	{
		printf 'phase=%s\n' "$phase"
		printf 'revision=%s\n' "$revision"
		printf 'cutover_started_at=2026-07-30T00:00:00Z\n'
		printf 'source_schema_state=%s\n' "$source_schema_state"
		printf 'target_volume=%s\n' "$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME"
		printf 'artifact_directory=%s/deploy/backend/campaigns-database-cutover.%s.self-test\n' \
			"$APP_ROOT" "$revision"
		printf 'postgres_image_id=%s\n' "$postgres_image_id"
		printf 'postgres_system_identifier=%s\n' "$postgres_system_identifier"
		printf 'source_manifest_sha256=%s\n' "$source_manifest"
		printf 'target_manifest_sha256=%s\n' "$target_manifest"
		printf 'contract_migration_sha256=%064d\n' 0
		printf 'target_api_image_id=%s\n' "$target_api_image"
		printf 'target_gateway_image_id=%s\n' "$target_gateway_image"
		printf 'target_maintenance_image_id=%s\n' "$target_maintenance_image"
		printf 'target_notification_image_id=%s\n' "$target_notification_image"
		printf 'target_campaigns_image_id=%s\n' "$target_campaigns_image"
		printf 'switch_generation=%s\n' "$switch_generation"
		printf 'telegram_audit_decision=%s\n' "$telegram_decision"
		printf 'telegram_audit_reference_sha256=%s\n' "$telegram_reference"
		printf 'restore_drill_reference_sha256=%s\n' "$restore_reference"
		printf 'previous_image_id=%s\n' "$previous_image"
		printf 'previous_revision=%s\n' "$previous_revision"
		printf 'previous_gateway_image_id=%s\n' "$previous_gateway_image"
		printf 'previous_gateway_routes_base64=%s\n' "$previous_gateway_routes"
		printf 'previous_maintenance_image_id=%s\n' "$previous_maintenance_image"
		printf 'previous_notification_image_id=%s\n' "$previous_notification_image"
		printf 'rollback_maintenance_revision=%s\n' "$rollback_maintenance_revision"
		printf 'rollback_notification_revision=%s\n' "$rollback_notification_revision"
		printf 'updated_at=2026-07-30T00:00:00Z\n'
	} >"$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
	chown 0:0 "$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
	chmod 600 "$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
}

campaigns_database_lifecycle_self_test() {
	local revision="0123456789abcdef0123456789abcdef01234567"
	local other_revision="89abcdef0123456789abcdef0123456789abcdef"
	local self_test_root
	local docker_option script_source secret_name secret_assignment secret_prefix

	[[ "$(id -u)" == "0" ]] || {
		echo "Campaigns lifecycle self-test must run as root in an isolated container." >&2
		return 1
	}
	script_source="$(<"${BASH_SOURCE[0]}")"
	for docker_option in -e --env; do
		for secret_name in PGURL PGPASSWORD; do
			for secret_prefix in \
				"$docker_option $secret_name" \
				"$docker_option \"$secret_name" \
				"$docker_option '$secret_name"; do
				secret_assignment="${secret_prefix}="
				[[ "$script_source" != *"$secret_assignment"* ]] || {
					echo "Campaigns lifecycle passes $secret_name through Docker CLI argv." >&2
					return 1
				}
			done
		done
	done
	[[ "$(campaigns_full_deploy_action true missing)" == "stage" &&
		"$(campaigns_full_deploy_action false missing)" == "block" &&
		"$(campaigns_full_deploy_action true preflight)" == "block" &&
		"$(campaigns_full_deploy_action true switching)" == "block" &&
		"$(campaigns_full_deploy_action false switched)" == "block" &&
		"$(campaigns_full_deploy_action true complete)" == "deploy" &&
		"$(campaigns_full_deploy_action false complete)" == "deploy" ]] || {
		echo "Campaigns full-deploy action classifier is unsafe." >&2
		return 1
	}
	if campaigns_full_deploy_action invalid complete >/dev/null 2>&1 ||
		campaigns_full_deploy_action false invalid >/dev/null 2>&1; then
		echo "Campaigns full-deploy action classifier accepted invalid input." >&2
		return 1
	fi
	self_test_root="$(mktemp -d /tmp/winwidget-campaigns-lifecycle.XXXXXX)"
	[[ "$self_test_root" == /tmp/winwidget-campaigns-lifecycle.* ]] || return 1
	APP_ROOT="$self_test_root"
	mkdir -p "$APP_ROOT/deploy/backend"
	CAMPAIGNS_DATABASE_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.campaigns-database-cutover-v1"
	CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER="$APP_ROOT/deploy/backend/.campaigns-first-cutover-staged-v1"

	guard_campaigns_cutover_checkout_revision "$revision"
	if require_campaigns_first_cutover_staged_revision "$revision" \
		>/dev/null 2>&1; then
		echo "Campaigns self-test accepted a missing staged marker." >&2
		return 1
	fi
	write_campaigns_first_cutover_staged_marker "$revision"
	require_campaigns_first_cutover_staged_revision "$revision"
	[[ "$(campaigns_first_cutover_staged_value switch_generation_seed)" == "0" ]] || {
		echo "Campaigns self-test staged an invalid initial switch generation seed." >&2
		return 1
	}
	if write_campaigns_first_cutover_staged_marker "$revision" 1 \
		>/dev/null 2>&1; then
		echo "Campaigns self-test changed an existing switch generation seed." >&2
		return 1
	fi
	guard_campaigns_cutover_checkout_revision "$revision"
	if guard_campaigns_cutover_checkout_revision "$other_revision" \
		>/dev/null 2>&1; then
		echo "Campaigns self-test accepted a different staged revision." >&2
		return 1
	fi

	printf 'unexpected=value\n' >>"$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER"
	if validate_campaigns_first_cutover_staged_marker; then
		echo "Campaigns self-test accepted an invalid staged marker." >&2
		return 1
	fi
	rm -f -- "$CAMPAIGNS_FIRST_CUTOVER_STAGED_MARKER"
	write_campaigns_first_cutover_staged_marker "$revision" 7
	write_campaigns_first_cutover_staged_marker "$revision"
	[[ "$(campaigns_first_cutover_staged_value switch_generation_seed)" == "7" ]] || {
		echo "Campaigns self-test did not retain an existing switch generation seed." >&2
		return 1
	}

	campaigns_lifecycle_self_test_write_cutover_marker preflight "$revision"
	validate_campaigns_database_cutover_marker
	guard_campaigns_cutover_checkout_revision "$revision"
	if guard_campaigns_cutover_checkout_revision "$other_revision" \
		>/dev/null 2>&1; then
		echo "Campaigns self-test changed revision during an incomplete cutover." >&2
		return 1
	fi

	campaigns_lifecycle_self_test_write_cutover_marker switching "$revision"
	validate_campaigns_database_cutover_marker
	guard_campaigns_cutover_checkout_revision "$revision"

	campaigns_lifecycle_self_test_write_cutover_marker complete "$revision"
	validate_campaigns_database_cutover_marker
	guard_campaigns_cutover_checkout_revision "$other_revision"
	if require_campaigns_first_cutover_staged_revision "$other_revision" \
		>/dev/null 2>&1; then
		echo "Campaigns direct cutover self-test accepted an unstaged revision." >&2
		return 1
	fi
	printf 'unexpected=value\n' >>"$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
	if validate_campaigns_database_cutover_marker; then
		echo "Campaigns self-test accepted an invalid lifecycle marker." >&2
		return 1
	fi

	rm -rf -- "$self_test_root"
	echo "Campaigns staged revision and lifecycle marker states verified"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--self-test)
		[[ $# == 1 ]] || {
			echo "Usage: $0 --self-test" >&2
			exit 1
		}
		campaigns_database_lifecycle_self_test
		;;
	--guard-checkout-revision)
		[[ $# == 2 ]] || {
			echo "Usage: $0 --guard-checkout-revision REVISION" >&2
			exit 1
		}
		guard_campaigns_cutover_checkout_revision "$2"
		;;
	--require-staged-revision)
		[[ $# == 2 ]] || {
			echo "Usage: $0 --require-staged-revision REVISION" >&2
			exit 1
		}
		require_campaigns_first_cutover_staged_revision "$2"
		;;
	*)
		echo "Usage: $0 --self-test | --guard-checkout-revision REVISION | --require-staged-revision REVISION" >&2
		exit 1
		;;
	esac
fi
