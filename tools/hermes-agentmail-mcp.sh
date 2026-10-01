#!/usr/bin/env bash
# MCP security contract:
# The principal is derived only from inherited HERMES_HOME.
# Host paths are rejected unless filePath resolves inside an approved attachment root.
# Arbitrary paths and paths from mail content are rejected and never read.
# attachment_upload returns metadata only.
# Approval is required before message_send.
# mail_account_register does not overwrite an existing account, secretRef, or connection.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agentmail-hermes-profile.sh
source "${SCRIPT_DIR}/agentmail-hermes-profile.sh"

derive_principal_from_hermes_home "${HERMES_HOME:-}" >/dev/null
exec "${SCRIPT_DIR}/agentmail-native-mcp.sh"
