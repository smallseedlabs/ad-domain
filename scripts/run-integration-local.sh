#!/bin/sh
# Isolated Postgres + Redis for ad-domain integration tests.
# Does not reuse sibling Hub/Context/Memory containers or host 5432/6379.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ADS_POSTGRES_PASSWORD="${ADS_POSTGRES_PASSWORD:-local-ads-test-only}"
docker compose up -d
i=0
while [ "$i" -lt 30 ]; do
  docker compose exec -T postgres pg_isready -U ads -d ad_domain >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done
export NODE_ENV=test
export ADS_TEST_DATABASE_URL="postgres://ads:${ADS_POSTGRES_PASSWORD}@127.0.0.1:55436/ad_domain"
export ADS_TEST_REDIS_URL="redis://127.0.0.1:56381"
export AUDIT_PUBLISHER=log
npm run test:integration
echo "integration containers left running on 127.0.0.1:55436 / 56381; docker compose down to stop"
