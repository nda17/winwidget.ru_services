#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
server_root="$APP_ROOT/winwidget.ru_server"
readonly REPORTING_SCHEDULER_SMOKE_SNAPSHOT="${REPORTING_SCHEDULER_SMOKE_SNAPSHOT:-$APP_ROOT/deploy/backend/.reporting-scheduler-cutover-smoke-v1}"
readonly REPORTING_SCHEDULER_SMOKE_EVIDENCE="${REPORTING_SCHEDULER_SMOKE_EVIDENCE:-$APP_ROOT/deploy/backend/reporting-scheduler-evidence-v1.json}"
readonly REPORTING_SCHEDULER_SMOKE_TOPIC_ID='1521'
readonly REPORTING_SCHEDULER_SMOKE_ATTEMPTS='30'
readonly REPORTING_SCHEDULER_SMOKE_INTERVAL_SECONDS='10'

# shellcheck source=scripts/reporting-cutover-lifecycle.sh
source "$server_root/scripts/reporting-cutover-lifecycle.sh"

reporting_scheduler_smoke_require_safe_file() {
	local path="$1"
	[[ "$path" == /* && -f "$path" && ! -L "$path" &&
		"$(reporting_stat_owner "$path")" == '0:0' &&
		"$(reporting_stat_mode "$path")" == '600' ]]
}

reporting_scheduler_smoke_snapshot_value() {
	local key="$1"
	sed -n "s/^${key}=//p" "$REPORTING_SCHEDULER_SMOKE_SNAPSHOT"
}

reporting_scheduler_smoke_write_snapshot() {
	local revision="$1" switch_generation="$2" original_epoch="$3"
	local triggered_epoch="$4" period_key="$5" destination_chat_id="$6"
	local schedule_generation="$7" temporary
	temporary="${REPORTING_SCHEDULER_SMOKE_SNAPSHOT}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! {
		(umask 077; {
			printf 'version=2\n'
			printf 'revision=%s\n' "$revision"
			printf 'switch_generation=%s\n' "$switch_generation"
			printf 'telegram_topic_id=%s\n' "$REPORTING_SCHEDULER_SMOKE_TOPIC_ID"
			printf 'destination_chat_id=%s\n' "$destination_chat_id"
			printf 'schedule_authority_generation=%s\n' "$schedule_generation"
			printf 'original_last_successful_epoch=%s\n' "$original_epoch"
			printf 'triggered_last_successful_epoch=%s\n' "$triggered_epoch"
			printf 'period_key=%s\n' "$period_key"
			printf 'prepared_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
		} >"$temporary") &&
			chown 0:0 "$temporary" && chmod 600 "$temporary" &&
			mv "$temporary" "$REPORTING_SCHEDULER_SMOKE_SNAPSHOT"
	}; then
		rm -f -- "$temporary"
		return 1
	fi
}

reporting_scheduler_smoke_prepare_snapshot() {
	local result revision="$1" switch_generation="$2"
	result="$(reporting_database_psql REPORTING_DATABASE_URL \
		--tuples-only --no-align --field-separator='|' --command "
WITH current AS (
  SELECT *,
    (
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE timezone) - INTERVAL '1 day'
    ) AT TIME ZONE timezone AS expected_period_start
  FROM reporting.reporting_settings
  WHERE id = 'daily-summary'
)
SELECT
  extract(epoch FROM last_successful_period_start)::BIGINT AS original_epoch,
  extract(epoch FROM last_successful_period_start - INTERVAL '1 day')::BIGINT AS triggered_epoch,
  timezone || ':' || to_char(
    expected_period_start AT TIME ZONE timezone,
    'YYYY-MM-DD'
  ) AS period_key,
  destination_chat_id,
  schedule_authority_generation::TEXT
FROM current
WHERE owner = 'REPORTING'::reporting.\"ReportingOwner\"
    AND enabled = TRUE
    AND destination_chat_id IS NOT NULL
    AND message_thread_id = $REPORTING_SCHEDULER_SMOKE_TOPIC_ID
    AND timezone = 'Europe/Moscow'
    AND schedule_policy_change_id IS NULL
    AND last_successful_period_start = expected_period_start
    AND (CURRENT_TIMESTAMP AT TIME ZONE timezone)::TIME >= schedule_time::TIME
    AND EXISTS (
      SELECT 1 FROM reporting.heartbeats
      WHERE role IN ('all', 'scheduler')
        AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
    )
    AND NOT EXISTS (SELECT 1 FROM reporting.report_runs)
    AND NOT EXISTS (SELECT 1 FROM reporting.outbox_events);
")" || return 1
	result="$(printf '%s\n' "$result" | grep -E '^[0-9]+\|[0-9]+\|Europe/Moscow:[0-9]{4}-[0-9]{2}-[0-9]{2}\|-?[0-9]+\|[0-9]+$' || true)"
	[[ -n "$result" && "$result" != *$'\n'* ]] || {
		echo 'Reporting scheduler smoke preparation preconditions changed; no marker was shifted.' >&2
		return 1
	}
	local original_epoch triggered_epoch period_key destination_chat_id
	local schedule_generation
	IFS='|' read -r original_epoch triggered_epoch period_key \
		destination_chat_id schedule_generation <<<"$result"
	[[ "$original_epoch" =~ ^[0-9]+$ && "$triggered_epoch" =~ ^[0-9]+$ &&
		$((original_epoch - triggered_epoch)) -eq 86400 &&
		"$destination_chat_id" =~ ^-?[0-9]+$ &&
		"$schedule_generation" =~ ^[0-9]+$ ]] || return 1
	reporting_scheduler_smoke_write_snapshot "$revision" "$switch_generation" \
		"$original_epoch" "$triggered_epoch" "$period_key" \
		"$destination_chat_id" "$schedule_generation"
}

reporting_scheduler_smoke_apply_shift() {
	local original_epoch triggered_epoch period_key destination_chat_id
	local schedule_generation result current_epoch total_runs selected_runs
	local total_outbox selected_outbox
	original_epoch="$(reporting_scheduler_smoke_snapshot_value original_last_successful_epoch)"
	triggered_epoch="$(reporting_scheduler_smoke_snapshot_value triggered_last_successful_epoch)"
	period_key="$(reporting_scheduler_smoke_snapshot_value period_key)"
	destination_chat_id="$(reporting_scheduler_smoke_snapshot_value destination_chat_id)"
	schedule_generation="$(reporting_scheduler_smoke_snapshot_value schedule_authority_generation)"
	result="$(reporting_database_psql REPORTING_MIGRATION_DATABASE_URL \
		--tuples-only --no-align --field-separator='|' --command "
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('winwidget.reporting.daily-summary.owner.v1'));
WITH locked AS (
  SELECT *,
    (
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE timezone) - INTERVAL '1 day'
    ) AT TIME ZONE timezone AS expected_period_start
  FROM reporting.reporting_settings
  WHERE id = 'daily-summary'
  FOR UPDATE
), changed AS (
  UPDATE reporting.reporting_settings settings
  SET last_successful_period_start = locked.last_successful_period_start - INTERVAL '1 day',
      updated_at = CURRENT_TIMESTAMP
  FROM locked
  WHERE settings.id = locked.id
    AND locked.owner = 'REPORTING'::reporting.\"ReportingOwner\"
    AND locked.enabled = TRUE
    AND locked.destination_chat_id = '$destination_chat_id'
    AND locked.message_thread_id = $REPORTING_SCHEDULER_SMOKE_TOPIC_ID
    AND locked.timezone = 'Europe/Moscow'
    AND locked.schedule_authority_generation = $schedule_generation
    AND locked.schedule_policy_change_id IS NULL
    AND extract(epoch FROM locked.last_successful_period_start)::BIGINT = $original_epoch
    AND locked.last_successful_period_start = locked.expected_period_start
    AND (CURRENT_TIMESTAMP AT TIME ZONE locked.timezone)::TIME >= locked.schedule_time::TIME
    AND EXISTS (
      SELECT 1 FROM reporting.heartbeats
      WHERE role IN ('all', 'scheduler')
        AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '30 seconds'
    )
    AND NOT EXISTS (SELECT 1 FROM reporting.report_runs)
    AND NOT EXISTS (SELECT 1 FROM reporting.outbox_events)
  RETURNING extract(epoch FROM settings.last_successful_period_start)::BIGINT
)
SELECT * FROM changed;
COMMIT;
")" || true
	result="$(printf '%s\n' "$result" | grep -E '^[0-9]+$' || true)"
	if [[ -n "$result" ]]; then
		[[ "$result" == "$triggered_epoch" ]] || return 1
		return 0
	fi
	result="$(reporting_database_psql REPORTING_DATABASE_URL \
		--tuples-only --no-align --field-separator='|' --command "
WITH selected_run AS (
  SELECT * FROM reporting.report_runs
  WHERE period_key = '$period_key'
    AND extract(epoch FROM period_start)::BIGINT = $original_epoch
    AND timezone = 'Europe/Moscow'
    AND destination_chat_id = '$destination_chat_id'
    AND message_thread_id = $REPORTING_SCHEDULER_SMOKE_TOPIC_ID
), selected_outbox AS (
  SELECT outbox.* FROM reporting.outbox_events outbox
  JOIN selected_run run ON run.id = outbox.message_id
  WHERE outbox.event_type = 'notification.daily-summary.telegram.requested.v1'
    AND outbox.payload #>> '{reference,id}' = run.id::TEXT
    AND outbox.payload #>> '{destination,telegramChatId}' = '$destination_chat_id'
    AND outbox.payload #>> '{destination,messageThreadId}' = '$REPORTING_SCHEDULER_SMOKE_TOPIC_ID'
)
SELECT
  extract(epoch FROM last_successful_period_start)::BIGINT::TEXT,
  (SELECT count(*) FROM reporting.report_runs)::TEXT,
  (SELECT count(*) FROM selected_run)::TEXT,
  (SELECT count(*) FROM reporting.outbox_events)::TEXT,
  (SELECT count(*) FROM selected_outbox)::TEXT
FROM reporting.reporting_settings
WHERE id = 'daily-summary';
")" || return 1
	[[ -n "$result" && "$result" != *$'\n'* ]] || return 1
	IFS='|' read -r current_epoch total_runs selected_runs total_outbox \
		selected_outbox <<<"$result"
	if [[ "$current_epoch" == "$triggered_epoch" ]]; then
		[[ "$total_runs" =~ ^[01]$ && "$selected_runs" =~ ^[01]$ &&
			"$total_runs" == "$selected_runs" && "$total_outbox" =~ ^[01]$ &&
			"$total_outbox" == "$selected_outbox" ]]
		return
	fi
	[[ "$current_epoch" == "$original_epoch" && "$total_runs" == '1' &&
		"$selected_runs" == '1' && "$total_outbox" == '1' &&
		"$selected_outbox" == '1' ]]
}

reporting_scheduler_smoke_require_snapshot() {
	local revision="$1" switch_generation="$2" version snapshot_revision
	local snapshot_generation topic destination_chat_id schedule_generation
	local original_epoch triggered_epoch period_key prepared_at keys
	reporting_scheduler_smoke_require_safe_file \
		"$REPORTING_SCHEDULER_SMOKE_SNAPSHOT" || return 1
	keys="$(sed 's/=.*//' "$REPORTING_SCHEDULER_SMOKE_SNAPSHOT")"
	version="$(reporting_scheduler_smoke_snapshot_value version)"
	snapshot_revision="$(reporting_scheduler_smoke_snapshot_value revision)"
	snapshot_generation="$(reporting_scheduler_smoke_snapshot_value switch_generation)"
	topic="$(reporting_scheduler_smoke_snapshot_value telegram_topic_id)"
	destination_chat_id="$(reporting_scheduler_smoke_snapshot_value destination_chat_id)"
	schedule_generation="$(reporting_scheduler_smoke_snapshot_value schedule_authority_generation)"
	original_epoch="$(reporting_scheduler_smoke_snapshot_value original_last_successful_epoch)"
	triggered_epoch="$(reporting_scheduler_smoke_snapshot_value triggered_last_successful_epoch)"
	period_key="$(reporting_scheduler_smoke_snapshot_value period_key)"
	prepared_at="$(reporting_scheduler_smoke_snapshot_value prepared_at)"
	[[ "$keys" == $'version\nrevision\nswitch_generation\ntelegram_topic_id\ndestination_chat_id\nschedule_authority_generation\noriginal_last_successful_epoch\ntriggered_last_successful_epoch\nperiod_key\nprepared_at' &&
		"$version" == '2' && "$snapshot_revision" == "$revision" &&
		"$snapshot_generation" == "$switch_generation" &&
		"$topic" == "$REPORTING_SCHEDULER_SMOKE_TOPIC_ID" &&
		"$destination_chat_id" =~ ^-?[0-9]+$ &&
		"$schedule_generation" =~ ^[0-9]+$ &&
		"$original_epoch" =~ ^[0-9]+$ && "$triggered_epoch" =~ ^[0-9]+$ &&
		$((original_epoch - triggered_epoch)) -eq 86400 &&
		"$period_key" =~ ^Europe/Moscow:[0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
		"$prepared_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

reporting_scheduler_smoke_terminal_state() {
	local period_key="$1" original_epoch="$2" destination_chat_id="$3"
	local result run_id
	result="$(reporting_database_psql REPORTING_DATABASE_URL \
		--tuples-only --no-align --field-separator='|' --command "
WITH selected_run AS (
  SELECT * FROM reporting.report_runs
  WHERE period_key = '$period_key'
    AND extract(epoch FROM period_start)::BIGINT = $original_epoch
    AND timezone = 'Europe/Moscow'
    AND destination_chat_id = '$destination_chat_id'
    AND message_thread_id = $REPORTING_SCHEDULER_SMOKE_TOPIC_ID
), selected_outbox AS (
  SELECT outbox.* FROM reporting.outbox_events outbox
  JOIN selected_run run ON run.id = outbox.message_id
  WHERE outbox.event_type = 'notification.daily-summary.telegram.requested.v1'
    AND outbox.payload #>> '{reference,id}' = run.id::TEXT
    AND outbox.payload #>> '{destination,telegramChatId}' = '$destination_chat_id'
    AND outbox.payload #>> '{destination,messageThreadId}' = '$REPORTING_SCHEDULER_SMOKE_TOPIC_ID'
)
SELECT
  (SELECT count(*) FROM reporting.report_runs)::TEXT,
  (SELECT count(*) FROM selected_run)::TEXT,
  COALESCE((SELECT id::TEXT FROM selected_run), '-'),
  COALESCE((SELECT status::TEXT FROM selected_run), '-'),
  COALESCE((SELECT checkpoint FROM selected_run), '-'),
  (SELECT count(*) FROM reporting.outbox_events)::TEXT,
  (SELECT count(*) FROM selected_outbox)::TEXT,
  COALESCE((SELECT status::TEXT FROM selected_outbox), '-'),
  COALESCE((SELECT extract(epoch FROM last_successful_period_start)::BIGINT::TEXT
    FROM reporting.reporting_settings WHERE id = 'daily-summary'), '-');
")" || return 1
	[[ -n "$result" && "$result" != *$'\n'* ]] || return 1
	local total_runs selected_runs status checkpoint total_outbox selected_outbox
	local outbox_status successful_epoch
	IFS='|' read -r total_runs selected_runs run_id status checkpoint total_outbox \
		selected_outbox outbox_status successful_epoch <<<"$result"
	[[ "$total_runs" == '1' && "$selected_runs" == '1' &&
		"$run_id" =~ ^[0-9a-f-]{36}$ && "$status" == 'COMPLETED' &&
		"$checkpoint" == 'DELIVERY_CONFIRMED' && "$total_outbox" == '1' &&
		"$selected_outbox" == '1' && "$outbox_status" == 'PUBLISHED' &&
		"$successful_epoch" == "$original_epoch" ]] || return 2
	result="$(reporting_database_psql NOTIFICATION_DELIVERY_DATABASE_URL \
		--tuples-only --no-align --field-separator='|' --command "
SELECT
  count(*)::TEXT,
  COALESCE(min(status::TEXT), '-'),
  count(*) FILTER (WHERE delivered_at IS NOT NULL)::TEXT,
  (SELECT count(*)::TEXT FROM notification_delivery.delivery_failures
    WHERE event_id = '$run_id'::UUID
      AND consumer = 'daily-summary-delivery-telegram'
      AND resolved_at IS NULL)
FROM notification_delivery.delivery_receipts
WHERE event_id = '$run_id'::UUID
  AND consumer = 'daily-summary-delivery-telegram';
")" || return 1
	[[ "$result" == '1|DELIVERED|1|0' ]] || return 2
	printf '%s\n' "$run_id"
}

reporting_scheduler_smoke_write_evidence() {
	local revision="$1" switch_generation="$2" period_key="$3" image_id
	local temporary
	image_id="$(reporting_resolve_image_id_for_revision "$revision")" || return 1
	temporary="${REPORTING_SCHEDULER_SMOKE_EVIDENCE}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	docker run --rm --network none --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		-e "REVISION=$revision" -e "SWITCH_GENERATION=$switch_generation" \
		-e "PERIOD_KEY=$period_key" \
		--entrypoint node "$image_id" -e '
const value = {
  version: 1,
  revision: process.env.REVISION,
  switchGeneration: process.env.SWITCH_GENERATION,
  periodKey: process.env.PERIOD_KEY,
  reportRunCount: 1,
  notificationOutboxCount: 1,
  reportRunStatus: "COMPLETED",
  deliveryStatus: "DELIVERED",
  verifiedAt: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(value)}\n`);
' >"$temporary"
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv "$temporary" "$REPORTING_SCHEDULER_SMOKE_EVIDENCE"
}

reporting_scheduler_smoke_main() {
	local revision switch_generation phase step confirmation original_epoch
	local period_key attempt run_id evidence_sha
	local destination_chat_id
	[[ "$(id -u)" == '0' ]] || return 1
	revision="${EXPECTED_REVISION:-}"
	reporting_validate_production_files
	reporting_validate_exact_revision "$revision"
	reporting_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	acquire_production_deploy_lock 'Reporting scheduler cutover smoke'
	database_restore_guard_assert_before_mutation healthy-required "$REPORTING_ENV_FILE"
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
	reporting_cutover_validate_marker
	phase="$(reporting_cutover_marker_value phase)"
	step="$(reporting_cutover_marker_value scheduler_step)"
	[[ "$phase" == 'shadow-verified' && "$step" == 'target-owned' &&
		"$(reporting_cutover_marker_value revision)" == "$revision" &&
		"$(reporting_cutover_marker_value scheduler_evidence_sha256)" == 'pending' ]] || {
		echo 'Reporting scheduler smoke requires shadow-verified/target-owned with pending evidence.' >&2
		return 1
	}
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	confirmation="${CONFIRM_REPORTING_DUPLICATE_DAILY_SUMMARY:-}"
	[[ "$confirmation" == "duplicate-daily-summary:$revision:$switch_generation:telegram-topic-$REPORTING_SCHEDULER_SMOKE_TOPIC_ID" ]] || {
		echo "Set CONFIRM_REPORTING_DUPLICATE_DAILY_SUMMARY=duplicate-daily-summary:$revision:$switch_generation:telegram-topic-$REPORTING_SCHEDULER_SMOKE_TOPIC_ID only after explicit approval of one duplicate production Telegram summary." >&2
		return 1
	}
	reporting_initialize_database_guard 'Reporting scheduler cutover smoke'
	reporting_cutover_require_forward_scheduler_ready
	reporting_require_rabbitmq_topology
	[[ "$(reporting_cutover_notification_daily_summary_database_state)" == 'drained' ]] || {
		echo 'Notification Delivery Daily Summary state must be drained before the one-shot smoke.' >&2
		return 1
	}
	if [[ ! -e "$REPORTING_SCHEDULER_SMOKE_SNAPSHOT" &&
		! -L "$REPORTING_SCHEDULER_SMOKE_SNAPSHOT" ]]; then
		reporting_scheduler_smoke_prepare_snapshot "$revision" "$switch_generation"
	fi
	reporting_scheduler_smoke_require_snapshot "$revision" "$switch_generation"
	reporting_scheduler_smoke_apply_shift
	original_epoch="$(reporting_scheduler_smoke_snapshot_value original_last_successful_epoch)"
	period_key="$(reporting_scheduler_smoke_snapshot_value period_key)"
	destination_chat_id="$(reporting_scheduler_smoke_snapshot_value destination_chat_id)"
	run_id=''
	for ((attempt = 1; attempt <= REPORTING_SCHEDULER_SMOKE_ATTEMPTS; attempt++)); do
		if run_id="$(reporting_scheduler_smoke_terminal_state \
			"$period_key" "$original_epoch" "$destination_chat_id")"; then
			break
		fi
		sleep "$REPORTING_SCHEDULER_SMOKE_INTERVAL_SECONDS"
	done
	[[ "$run_id" =~ ^[0-9a-f-]{36}$ ]] || {
		echo 'The one-shot Reporting scheduler smoke did not reach exactly one terminal delivered run.' >&2
		return 1
	}
	[[ "$(reporting_cutover_reporting_daily_summary_database_state)" == 'drained' &&
		"$(reporting_cutover_notification_daily_summary_database_state)" == 'drained' ]] || {
		echo 'Reporting or Notification Delivery did not drain after the one-shot scheduler smoke.' >&2
		return 1
	}
	reporting_scheduler_smoke_write_evidence \
		"$revision" "$switch_generation" "$period_key"
	reporting_scheduler_smoke_require_safe_file "$REPORTING_SCHEDULER_SMOKE_EVIDENCE"
	reporting_cutover_validate_scheduler_evidence \
		"$REPORTING_SCHEDULER_SMOKE_EVIDENCE" "$revision" "$switch_generation"
	evidence_sha="$(reporting_sha256_file "$REPORTING_SCHEDULER_SMOKE_EVIDENCE")"
	REPORTING_SCHEDULER_EVIDENCE_FILE="$REPORTING_SCHEDULER_SMOKE_EVIDENCE"
	CONFIRM_REPORTING_SCHEDULER_VERIFIED="scheduler:$revision:$switch_generation:$evidence_sha"
	export REPORTING_SCHEDULER_EVIDENCE_FILE CONFIRM_REPORTING_SCHEDULER_VERIFIED
	reporting_cutover_verify_scheduler
	reporting_verify_database_lifecycle_unchanged
	echo "Reporting scheduler cutover smoke completed run_id=$run_id evidence_sha256=$evidence_sha."
}

reporting_scheduler_smoke_self_test() {
	local source_text
	source_text="$(declare -f reporting_scheduler_smoke_prepare_snapshot reporting_scheduler_smoke_apply_shift reporting_scheduler_smoke_terminal_state reporting_scheduler_smoke_main)"
	[[ "$source_text" == *'duplicate-daily-summary:$revision:$switch_generation:telegram-topic-$REPORTING_SCHEDULER_SMOKE_TOPIC_ID'* &&
		"$source_text" == *'pg_advisory_xact_lock'* &&
		"$source_text" == *'reporting_scheduler_smoke_write_snapshot "$revision" "$switch_generation"'* &&
		"$source_text" == *'schedule_authority_generation = $schedule_generation'* &&
		"$source_text" == *'last_successful_period_start - INTERVAL '\''1 day'\'''* &&
		"$source_text" == *'last_successful_period_start = locked.last_successful_period_start - INTERVAL '\''1 day'\'''* &&
		"$source_text" == *'NOT EXISTS (SELECT 1 FROM reporting.report_runs)'* &&
		"$source_text" == *'NOT EXISTS (SELECT 1 FROM reporting.outbox_events)'* &&
		"$source_text" == *'message_thread_id = $REPORTING_SCHEDULER_SMOKE_TOPIC_ID'* &&
		"$source_text" == *"destination_chat_id = '\$destination_chat_id'"* &&
		"$source_text" == *"outbox.payload #>> '{destination,telegramChatId}' = '\$destination_chat_id'"* &&
		"$source_text" == *'status" == '\''COMPLETED'\'''* &&
		"$source_text" == *'checkpoint" == '\''DELIVERY_CONFIRMED'\'''* &&
		"$source_text" == *"result\" == '1|DELIVERED|1|0'"* &&
		"$source_text" == *'reporting_cutover_verify_scheduler'* &&
		"$source_text" != *'rabbitmqadmin publish'* &&
		"$source_text" != *'rabbitmqctl publish'* ]] || {
		echo 'Reporting scheduler cutover smoke self-test found an unsafe one-shot contract.' >&2
		return 1
	}
	echo 'Reporting scheduler one-shot cutover smoke contracts passed.'
}

case "${1:-}" in
--self-test)
	[[ $# == 1 ]] || exit 1
	reporting_scheduler_smoke_self_test
	;;
'')
	[[ $# == 0 ]] || exit 1
	reporting_scheduler_smoke_main
	;;
*)
	echo "Usage: $0 [--self-test]" >&2
	exit 1
	;;
esac
