#!/usr/bin/env bash
set -euo pipefail

instance="${HERMES_INSTANCE_NAME:-}"
instance="${instance#"${instance%%[![:space:]]*}"}"
instance="${instance%"${instance##*[![:space:]]}"}"
if [[ -z "${instance}" ]]; then
  echo "HERMES_INSTANCE_NAME is required" >&2
  exit 1
fi

exec docker exec -i \
  -e "AGENTMAIL_PRINCIPAL=${instance}" \
  -e "SECRET_FABRIC_PRINCIPAL=${instance}" \
  agentmail node src/mcp/server.mjs
