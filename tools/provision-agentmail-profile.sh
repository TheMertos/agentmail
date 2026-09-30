#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <profile-name>" >&2
  echo "Creates or starts an isolated AgentMail stack: container agentmail-<profile>, volume agentmail-<profile>-data." >&2
  echo "Requires SECRET_FABRIC_URL and SECRET_FABRIC_API_TOKEN in the operator environment (not passed on the command line)." >&2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

profile="${1:-}"
if [[ -z "${profile}" ]]; then
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=agentmail-hermes-profile.sh
source "${SCRIPT_DIR}/agentmail-hermes-profile.sh"

if ! validate_agentmail_profile_name "${profile}"; then
  echo "invalid profile name (expected ^[A-Za-z0-9][A-Za-z0-9._-]*$): ${profile}" >&2
  exit 1
fi

if [[ -z "${SECRET_FABRIC_URL:-}" ]]; then
  echo "SECRET_FABRIC_URL is required in the operator environment" >&2
  exit 1
fi
if [[ -z "${SECRET_FABRIC_API_TOKEN:-}" ]]; then
  echo "SECRET_FABRIC_API_TOKEN is required in the operator environment" >&2
  exit 1
fi

export_agentmail_compose_names "${profile}"
export AGENTMAIL_PROFILE="${profile}"
project="$(agentmail_compose_project_for_principal "${profile}")"

cd "${REPO_ROOT}"
exec docker compose \
  --project-name "${project}" \
  up -d --build
