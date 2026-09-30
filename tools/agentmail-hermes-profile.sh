#!/usr/bin/env bash
# Shared Hermes profile → AgentMail principal/container naming (fail closed).

# Derive canonical AgentMail principal from inherited HERMES_HOME.
# @param $1 HERMES_HOME value
# @stdout principal name
derive_principal_from_hermes_home() {
  local home="${1:-}"
  home="${home#"${home%%[![:space:]]*}"}"
  home="${home%"${home##*[![:space:]]}"}"
  while [[ "${home}" == */ && "${home}" != "/" ]]; do
    home="${home%/}"
  done
  if [[ -z "${home}" ]]; then
    echo "HERMES_HOME is required" >&2
    return 1
  fi

  local principal=""
  if [[ "${home}" =~ ^(.+)/\.hermes/profiles/([^/]+)$ ]]; then
    principal="${BASH_REMATCH[2]}"
  elif [[ "${home}" =~ ^(.+)/\.hermes$ ]]; then
    principal="default"
  else
    echo "cannot derive principal from HERMES_HOME (expected .../.hermes or .../.hermes/profiles/<name>)" >&2
    return 1
  fi

  if ! validate_agentmail_profile_name "${principal}"; then
    echo "derived principal contains invalid characters" >&2
    return 1
  fi

  printf '%s' "${principal}"
}

# Validate a profile/principal name for Docker resource naming.
# @param $1 profile name
validate_agentmail_profile_name() {
  local name="${1:-}"
  [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

# Docker container name for an AgentMail profile principal.
# @param $1 principal
# @stdout container name
agentmail_container_name_for_principal() {
  local principal="${1:?principal required}"
  printf 'agentmail-%s' "${principal}"
}

# Docker named volume for an AgentMail profile principal.
# @param $1 principal
# @stdout volume name
agentmail_volume_name_for_principal() {
  local principal="${1:?principal required}"
  printf 'agentmail-%s-data' "${principal}"
}

# Compose project name for an AgentMail profile principal.
# @param $1 principal
# @stdout project name
agentmail_compose_project_for_principal() {
  local principal="${1:?principal required}"
  printf 'agentmail-%s' "${principal}"
}

# Export compose env vars for a profile principal (container + volume names).
# @param $1 principal
export_agentmail_compose_names() {
  local principal="${1:?principal required}"
  export AGENTMAIL_CONTAINER_NAME
  export AGENTMAIL_VOLUME_NAME
  AGENTMAIL_CONTAINER_NAME="$(agentmail_container_name_for_principal "${principal}")"
  AGENTMAIL_VOLUME_NAME="$(agentmail_volume_name_for_principal "${principal}")"
}
