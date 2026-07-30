#!/usr/bin/env bash

CAMPAIGNS_CONTRACT_MIGRATION_NAME="20260730010000_contract_extract_campaigns"

campaigns_contract_migration_file() {
	printf '%s/prisma/migrations/%s/migration.sql\n' \
		"${server_root:?server_root is required}" \
		"$CAMPAIGNS_CONTRACT_MIGRATION_NAME"
}

campaigns_contract_migration_checksum() {
	sha256sum "$(campaigns_contract_migration_file)" | awk '{ print $1 }'
}

campaigns_contract_migration_state() {
	docker run --rm --network host \
		--env-file "${ENV_FILE:?ENV_FILE is required}" \
		-e "CAMPAIGNS_CONTRACT_MIGRATION_NAME=$CAMPAIGNS_CONTRACT_MIGRATION_NAME" \
		--entrypoint node \
		"winwidget-api:${APP_VERSION:?APP_VERSION is required}" \
		-e '
const { PrismaClient } = require("@prisma/client");
const name = process.env.CAMPAIGNS_CONTRACT_MIGRATION_NAME;
const url = process.env.DATABASE_MIGRATION_URL_PRODUCTION;
if (!name || !url) throw new Error("Campaigns contract migration guard is not configured");
const prisma = new PrismaClient({ datasources: { db: { url } } });
prisma.$queryRawUnsafe(
  `SELECT migration_name, checksum, finished_at, rolled_back_at
   FROM "_prisma_migrations"
   WHERE migration_name = $1
   ORDER BY started_at DESC`,
  name,
).then(rows => {
  if (rows.length === 0) return process.stdout.write("pending\n");
  if (rows.length !== 1) return process.stdout.write("invalid\n");
  const row = rows[0];
  if (row.rolled_back_at) return process.stdout.write("rolled-back\n");
  if (!row.finished_at) return process.stdout.write("failed\n");
  process.stdout.write(`applied:${row.checksum}\n`);
}).finally(() => prisma.$disconnect());
'
}

campaigns_contract_state_allows_routine() {
	local state="$1"
	local expected_checksum="$2"
	[[ "$state" == "applied:$expected_checksum" ]]
}

assert_campaigns_contract_migration_applied_for_routine_deploy() {
	local expected_checksum state
	expected_checksum="$(campaigns_contract_migration_checksum)"
	state="$(campaigns_contract_migration_state)"
	case "$state" in
	"applied:$expected_checksum")
		return
	;;
	pending)
		echo "Routine deployment is blocked before Prisma: the Campaigns contract migration is pending." >&2
		echo "Run the reviewed Campaigns cutover and production-destructive finalize jobs." >&2
		return 1
	;;
	failed)
		echo "Campaigns contract migration has a failed Prisma row; refusing automatic resolve." >&2
		return 1
	;;
	rolled-back)
		echo "Campaigns contract migration was marked rolled back; manual review is required." >&2
		return 1
	;;
	*)
		echo "Campaigns contract migration state or checksum is invalid: $state" >&2
		return 1
	;;
	esac
}

assert_campaigns_contract_migration_clean_pending() {
	local state
	state="$(campaigns_contract_migration_state)"
	[[ "$state" == "pending" ]] || {
		echo "Production-destructive finalize requires one clean pending Campaigns contract migration; got $state." >&2
		return 1
	}
}

campaigns_contract_guard_self_test() {
	local expected="abc"
	local state
	for state in pending failed rolled-back invalid "applied:def"; do
		if campaigns_contract_state_allows_routine "$state" "$expected"; then
			echo "Campaigns routine guard accepted unsafe state: $state" >&2
			return 1
		fi
	done
	campaigns_contract_state_allows_routine "applied:$expected" "$expected"
	printf 'Campaigns contract guard state classifier verified\n'
}

if [[ "${1:-}" == "--self-test" ]]; then
	campaigns_contract_guard_self_test
fi
