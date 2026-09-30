#!/usr/bin/env bash
# MCP security contract:
# The principal is derived only from inherited HERMES_HOME.
# Host paths are rejected by attachment upload and are never read.
# attachment_upload returns metadata only.
# Approval is required before message_send.
# mail_account_register does not overwrite an existing account, secretRef, or connection.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agentmail-hermes-profile.sh
source "${SCRIPT_DIR}/agentmail-hermes-profile.sh"

principal="$(derive_principal_from_hermes_home "${HERMES_HOME:-}")"
container="$(agentmail_container_name_for_principal "${principal}")"

if ! docker container inspect "${container}" >/dev/null 2>&1; then
  echo "AgentMail container not found: ${container} (provision profile with tools/provision-agentmail-profile.sh)" >&2
  exit 1
fi

exec docker exec -i \
  -e "AGENTMAIL_PRINCIPAL=${principal}" \
  -e "SECRET_FABRIC_PRINCIPAL=${principal}" \
  "${container}" node src/mcp/server.mjs
