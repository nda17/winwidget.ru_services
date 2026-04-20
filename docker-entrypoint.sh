#!/bin/sh
set -eu

mkdir -p /app/uploads

exec "$@"
