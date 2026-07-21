#!/usr/bin/env bash
# Load XAI_API_KEY (and friends) then exec a principles yarn script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

load_env_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      \#*|'') continue ;;
      XAI_API_KEY=*|OPENAI_API_KEY=*|ANTHROPIC_API_KEY=*|PRINCIPLES_*=*)
        key="${line%%=*}"
        val="${line#*=}"
        # strip surrounding quotes
        if [[ "$val" == \"*\" ]]; then val="${val:1:${#val}-2}"; fi
        if [[ "$val" == \'*\' ]]; then val="${val:1:${#val}-2}"; fi
        export "$key=$val"
        ;;
    esac
  done < "$f"
}

load_env_file "$ROOT/.env"
if [[ -z "${XAI_API_KEY:-}" ]]; then
  load_env_file "${ENGRAM_ENV:-/home/tait/Projects/engram/.env}"
fi

export PRINCIPLES_PROVIDER="${PRINCIPLES_PROVIDER:-xai}"
export PRINCIPLES_MODEL="${PRINCIPLES_MODEL:-grok-4.5}"

if [[ -z "${XAI_API_KEY:-}" && "${PRINCIPLES_PROVIDER}" =~ ^(xai|grok)$ ]]; then
  echo "error: XAI_API_KEY not found in $ROOT/.env or engram .env" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <yarn-script> [args...]"
  echo "  e.g. $0 generate-agents \"Build a lease reviewer\""
  exit 1
fi

script="$1"
shift
exec yarn "$script" "$@"
