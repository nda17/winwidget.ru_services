#!/bin/sh

set -eu

umask 077

secret_target_directory='/run/database-restore-secrets'
singleton_lock_exit_code=75
singleton_lock_file_name='.database-restore-worker.singleton.lock'

fail() {
	echo "$1" >&2
	exit 1
}

restore_storage_directory="${DATABASE_RESTORE_STORAGE_DIR:-}"
case "$restore_storage_directory" in
/*)
	;;
*)
	fail 'DATABASE_RESTORE_STORAGE_DIR must be an absolute scoped path'
	;;
esac
if [ "$restore_storage_directory" = '/' ] ||
	[ ! -d "$restore_storage_directory" ] ||
	[ -L "$restore_storage_directory" ]; then
	fail 'DATABASE_RESTORE_STORAGE_DIR must be an existing scoped regular directory'
fi

singleton_lock_path="$restore_storage_directory/$singleton_lock_file_name"

copy_secret() {
	secret_source="$1"
	secret_target="$2"

	if [ ! -f "$secret_source" ] || [ -L "$secret_source" ]; then
		echo "Database restore admin secret is missing or unsafe: $secret_source" >&2
		exit 1
	fi

	secret_size="$(wc -c <"$secret_source" | tr -d '[:space:]')"
	case "$secret_size" in
	'' | *[!0-9]*)
		echo "Database restore admin secret size is invalid: $secret_source" >&2
		exit 1
		;;
	esac
	if [ "$secret_size" -lt 1 ] || [ "$secret_size" -gt 4096 ]; then
		echo "Database restore admin secret has an unsafe size: $secret_source" >&2
		exit 1
	fi

	cp "$secret_source" "$secret_target"
	chmod 400 "$secret_target"
	chown nestjs:nodejs "$secret_target"
}

if [ "${1:-}" = '--singleton-self-test' ]; then
	if [ "$#" -ne 1 ]; then
		fail 'Database restore singleton self-test does not accept arguments'
	fi
	self_test_seconds="${DATABASE_RESTORE_SINGLETON_SELF_TEST_SECONDS:-30}"
	case "$self_test_seconds" in
	'' | *[!0-9]*)
		fail 'DATABASE_RESTORE_SINGLETON_SELF_TEST_SECONDS must be an integer'
		;;
	esac
	if [ "$self_test_seconds" -lt 1 ] || [ "$self_test_seconds" -gt 60 ]; then
		fail 'DATABASE_RESTORE_SINGLETON_SELF_TEST_SECONDS must be between 1 and 60'
	fi
	set -- node -e '
		const seconds = Number(process.env.DATABASE_RESTORE_SINGLETON_SELF_TEST_SECONDS);
		process.on("SIGTERM", () => process.exit(143));
		process.stdout.write("database-restore-singleton-lock-acquired\n");
		setTimeout(() => process.exit(0), seconds * 1000);
	'
else
	mkdir -p "$secret_target_directory"
	chmod 700 "$secret_target_directory"

	copy_secret \
		'/run/secrets/database-restore-core-admin-password' \
		"$secret_target_directory/core-admin-password"
	copy_secret \
		'/run/secrets/database-restore-notification-delivery-admin-password' \
		"$secret_target_directory/notification-delivery-admin-password"
	copy_secret \
		'/run/secrets/database-restore-campaigns-admin-password' \
		"$secret_target_directory/campaigns-admin-password"
	copy_secret \
		'/run/secrets/database-restore-reporting-admin-password' \
		"$secret_target_directory/reporting-admin-password"
	copy_secret \
		'/run/secrets/database-restore-widgets-admin-password' \
		"$secret_target_directory/widgets-admin-password"
	copy_secret \
		'/run/secrets/database-restore-billing-admin-password' \
		"$secret_target_directory/billing-admin-password"
	chown nestjs:nodejs "$secret_target_directory"
fi

if ! su-exec nestjs:nodejs sh -eu -c '
	storage_directory="$1"
	lock_path="$2"
	[ -d "$storage_directory" ] &&
		[ ! -L "$storage_directory" ] &&
		[ -w "$storage_directory" ] &&
		[ -x "$storage_directory" ] || exit 1
	[ ! -L "$lock_path" ] || exit 1
	if [ -e "$lock_path" ]; then
		[ -f "$lock_path" ] && [ -r "$lock_path" ] || exit 1
	fi
' sh "$restore_storage_directory" "$singleton_lock_path"; then
	fail "Database restore singleton lock is unsafe or inaccessible: $singleton_lock_path"
fi

exec su-exec nestjs:nodejs flock \
	--exclusive \
	--nonblock \
	--conflict-exit-code "$singleton_lock_exit_code" \
	--no-fork \
	"$singleton_lock_path" \
	"$@"
