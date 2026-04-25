#!/bin/sh
set -eu

mode="$(printf '%s' "${MODE:-development}" | tr '[:upper:]' '[:lower:]')"

case "$mode" in
	production)
		database_url_key="DATABASE_URL_PRODUCTION"
		database_url="${DATABASE_URL_PRODUCTION:-}"
		;;
	development)
		database_url_key="DATABASE_URL_DEVELOPMENT"
		database_url="${DATABASE_URL_DEVELOPMENT:-}"
		;;
	*)
		echo "Unsupported MODE: $mode. Expected development or production." >&2
		exit 1
		;;
esac

if [ -z "$database_url" ] || [ "$database_url" = "change_me" ]; then
	echo "Database URL is missing for MODE=$mode. Set $database_url_key." >&2
	exit 1
fi

export DATABASE_URL="$database_url"
echo "Using $database_url_key for database connection."

mkdir -p /app/uploads

exec "$@"
