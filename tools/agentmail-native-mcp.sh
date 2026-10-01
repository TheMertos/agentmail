#!/usr/bin/env bash
# Native AgentMail MCP launcher. Runs node directly. Does not start sync or IMAP IDLE.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=agentmail-hermes-profile.sh
source "${SCRIPT_DIR}/agentmail-hermes-profile.sh"

service_mode=0
profile_arg=""
if [[ "${1:-}" == "--service" ]]; then
  service_mode=1
  profile_arg="${2:-}"
elif [[ $# -gt 0 ]]; then
  profile_arg="${1}"
fi

if [[ -n "${AGENTMAIL_SERVICE_MODE:-}" && "${AGENTMAIL_SERVICE_MODE}" != "native" ]]; then
  echo "native launcher refuses AGENTMAIL_SERVICE_MODE=${AGENTMAIL_SERVICE_MODE}" >&2
  exit 1
fi

principal=""
if [[ -n "${HERMES_HOME:-}" ]]; then
  derived="$(derive_principal_from_hermes_home "${HERMES_HOME}")"
  if [[ -n "${profile_arg}" && "${profile_arg}" != "${derived}" ]]; then
    echo "profile does not match HERMES_HOME" >&2
    exit 1
  fi
  principal="${derived}"
else
  principal="${profile_arg:-${AGENTMAIL_PROFILE:-}}"
fi

if ! validate_agentmail_profile_name "${principal}"; then
  echo "invalid profile name" >&2
  exit 1
fi

if [[ -z "${SECRET_FABRIC_URL:-}" ]]; then
  echo "SECRET_FABRIC_URL is required" >&2
  exit 1
fi
if [[ -z "${SECRET_FABRIC_API_TOKEN:-}" ]]; then
  echo "SECRET_FABRIC_API_TOKEN is required" >&2
  exit 1
fi
if [[ -z "${HOME:-}" && -z "${XDG_DATA_HOME:-}" ]]; then
  echo "HOME or XDG_DATA_HOME is required" >&2
  exit 1
fi

data_root="${XDG_DATA_HOME:-${HOME}/.local/share}/agentmail/${principal}"
umask 077
mkdir -p "${data_root}/outgoing"

export AGENTMAIL_SERVICE_MODE=native
export AGENTMAIL_PROFILE="${principal}"
export AGENTMAIL_PRINCIPAL="${principal}"
export SECRET_FABRIC_PRINCIPAL="${principal}"
export AGENTMAIL_DB_PATH="${data_root}/agentmail.db"
export AGENTMAIL_SYNC_INTERVAL_SECONDS="${AGENTMAIL_SYNC_INTERVAL_SECONDS:-300}"
export AGENTMAIL_LOG_LEVEL="${AGENTMAIL_LOG_LEVEL:-info}"
export AGENTMAIL_TRANSPORT=stdio
if [[ -z "${AGENTMAIL_ATTACHMENT_ROOTS:-}" ]]; then
  export AGENTMAIL_ATTACHMENT_ROOTS="${data_root}/outgoing"
fi
if [[ "${service_mode}" -eq 1 ]]; then
  export AGENTMAIL_NATIVE_HOLD=1
else
  unset AGENTMAIL_NATIVE_HOLD || true
fi

# systemd user units ship a system PATH and do not see the user Node install.
if ! command -v node >/dev/null 2>&1 && [[ -n "${HOME:-}" ]]; then
  node_prefix=""
  if [[ -d "${HOME}/.local/bin" ]]; then
    node_prefix="${HOME}/.local/bin"
  fi
  if [[ -d "${HOME}/.hermes/node/bin" ]]; then
    node_prefix="${node_prefix:+${node_prefix}:}${HOME}/.hermes/node/bin"
  fi
  if [[ -n "${node_prefix}" ]]; then
    export PATH="${node_prefix}${PATH:+:${PATH}}"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

cd "${REPO_ROOT}"
exec node src/mcp/server.mjs
