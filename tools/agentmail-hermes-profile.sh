#!/usr/bin/env bash
# Shared Hermes profile → AgentMail principal naming (fail closed).

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

# Validate a profile/principal name.
# @param $1 profile name
validate_agentmail_profile_name() {
  local name="${1:-}"
  [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

# Fill empty SECRET_FABRIC_URL, SECRET_FABRIC_API_TOKEN, and CREDENTIAL_CACHE_KEY from the profile env file.
# Non-empty inherited values are kept. Secret values are never printed.
# @param $1 profile name
# @param $2 config directory name under ~/.config
load_missing_secret_fabric_env() {
  local profile="${1:?profile required}"
  local app="${2:?app required}"
  if [[ -n "${SECRET_FABRIC_URL:-}" && -n "${SECRET_FABRIC_API_TOKEN:-}" && -n "${CREDENTIAL_CACHE_KEY:-}" ]]; then
    return 0
  fi
  if [[ -z "${HOME:-}" && -z "${XDG_CONFIG_HOME:-}" ]]; then
    return 0
  fi
  local env_file="${XDG_CONFIG_HOME:-${HOME}/.config}/${app}/${profile}.env"
  if [[ ! -e "${env_file}" ]]; then
    return 0
  fi
  if [[ ! -f "${env_file}" || ! -r "${env_file}" ]]; then
    echo "cannot read SecretFabric env file" >&2
    return 1
  fi
  local line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "invalid SecretFabric env file" >&2
      return 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "${key}" in
      SECRET_FABRIC_URL|SECRET_FABRIC_API_TOKEN|CREDENTIAL_CACHE_KEY)
        if [[ -z "${!key:-}" && -n "${value}" ]]; then
          printf -v "${key}" '%s' "${value}"
          export "${key}"
        fi
        ;;
    esac
  done < "${env_file}"
}
