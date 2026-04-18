#!/bin/sh
set -eu

mkdir -p /app/uploads

if [ -d /app/uploads-seed ]; then
	cp -rn /app/uploads-seed/. /app/uploads/
fi

exec "$@"
