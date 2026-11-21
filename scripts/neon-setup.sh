#!/usr/bin/env bash
# One-shot database setup for Neon. Run on a machine that can reach your Neon database (needs psql and pnpm).
#   neon env pull            # writes DATABASE_URL_UNPOOLED into .env.local
#   bash scripts/neon-setup.sh
# It: creates the four roles with fresh random passwords, applies every migration as the owner role, and writes the three
# connection strings the app needs to .env.neon (git-ignored, mode 600). It never prints a password or a connection string.
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL="$(grep -E '^DATABASE_URL_UNPOOLED=' .env.local | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$ADMIN_URL" ] || { echo "DATABASE_URL_UNPOOLED not found in .env.local. Run: neon env pull" >&2; exit 1; }
case "$ADMIN_URL" in *-pooler*) echo "That is the pooled URL. Use the direct (unpooled) one." >&2; exit 1;; esac
pw() { openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40; }
OWNER_PW="$(pw)"; APP_PW="$(pw)"; WORKER_PW="$(pw)"
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v worker_pw="$WORKER_PW" -f scripts/bootstrap-neon.sql >/dev/null
# Build role URLs by swapping the credentials in the admin URL.
rest="${ADMIN_URL#*@}"; scheme="${ADMIN_URL%%://*}"
url() { printf '%s://%s:%s@%s' "$scheme" "$1" "$2" "$rest"; }
umask 177
{
  echo "DATABASE_OWNER_URL=$(url taxops_owner "$OWNER_PW")"
  echo "DATABASE_URL=$(url taxops_app "$APP_PW")"
  echo "WORKER_DATABASE_URL=$(url taxops_worker "$WORKER_PW")"
} > .env.neon
DATABASE_OWNER_URL="$(grep '^DATABASE_OWNER_URL=' .env.neon | cut -d= -f2-)" pnpm db:migrate
echo "Done. Roles created, migrations applied. Connection strings are in .env.neon (keep it secret; do not commit)."
echo "Next: pnpm tenant:create (load .env.neon first), see docs/deploy-neon.md step 4."
