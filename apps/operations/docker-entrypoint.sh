#!/bin/sh
set -eu

readonly worker_role='worker'
readonly source_key_file='/run/secrets/database-backup-provenance-private-key-source'
readonly runtime_key_directory='/run/winwidget-operations-secrets'
readonly runtime_key_file='/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem'
readonly operations_uid='1001'
readonly operations_gid='1001'

if [ "$(id -u)" = '0' ]; then
	if [ "${OPERATIONS_PROCESS_ROLE:-}" != "$worker_role" ]; then
		echo 'Operations root entrypoint is allowed only for the maintenance worker.' >&2
		exit 1
	fi
	if [ "${DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE:-}" != "$runtime_key_file" ]; then
		echo 'Backup provenance runtime key path is invalid.' >&2
		exit 1
	fi
	if [ -L "$source_key_file" ] || [ ! -f "$source_key_file" ]; then
		echo 'Backup provenance source key must be a regular non-symlink file.' >&2
		exit 1
	fi
	if [ "$(stat -c '%u:%g:%a:%h:%F' -- "$source_key_file")" != '0:0:600:1:regular file' ]; then
		echo 'Backup provenance source key metadata is unsafe.' >&2
		exit 1
	fi

	install -d -o 0 -g "$operations_gid" -m 0710 "$runtime_key_directory"
	runtime_key_temporary="$runtime_key_directory/.database-backup-provenance-private-key.$$"
	trap 'rm -f -- "$runtime_key_temporary"' EXIT HUP INT TERM
	install -o 0 -g 0 -m 0600 \
		"$source_key_file" "$runtime_key_temporary"
	if ! cmp -s -- "$source_key_file" "$runtime_key_temporary"; then
		echo 'Backup provenance runtime key copy verification failed.' >&2
		exit 1
	fi
	chmod 0400 "$runtime_key_temporary"
	chown "$operations_uid:$operations_gid" "$runtime_key_temporary"
	mv -fT -- "$runtime_key_temporary" "$runtime_key_file"
	trap - EXIT HUP INT TERM
	if [ -L "$runtime_key_file" ] || \
		[ "$(stat -c '%u:%g:%a:%h:%F' -- "$runtime_key_file")" != '1001:1001:400:1:regular file' ]; then
		echo 'Backup provenance runtime key metadata is unsafe.' >&2
		exit 1
	fi

	exec gosu operations:nodejs "$@"
fi

if [ "$(id -u)" != "$operations_uid" ] || [ "$(id -g)" != "$operations_gid" ]; then
	echo 'Operations runtime must execute as the fixed non-root identity.' >&2
	exit 1
fi

exec "$@"
