#!/usr/bin/env bash
# Tests supabase/schema.sql against a throwaway Postgres in Docker.
set -euo pipefail
cd "$(dirname "$0")"
NAME=inv-schema-test-$$
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=test postgres:17-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
until docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; do sleep 0.5; done
sleep 1
psql() { docker exec -i "$NAME" psql -U postgres -q -v ON_ERROR_STOP=1 "$@"; }
psql < supabase-stub.sql
psql < ../../supabase/schema.sql
psql < ../../supabase/schema.sql   # re-run must be safe
psql -t < schema.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
