#!/usr/bin/env bash
set -euo pipefail

DRAFT_FILE="${1:-}"
PROVIDER="${2:-deepseek}"
MODEL="${3:-}"

if [[ -z "$DRAFT_FILE" || ! -f "$DRAFT_FILE" ]]; then
  echo "Usage: scripts/fact-check.sh <research-or-draft-file> [deepseek|zai] [model]" >&2
  exit 2
fi

case "$PROVIDER" in
  deepseek)
    MODEL="${MODEL:-deepseek-v4-flash}"
    ;;
  zai)
    MODEL="${MODEL:-glm-5.2}"
    ;;
  *)
    echo "Unknown provider: $PROVIDER" >&2
    exit 2
    ;;
esac

PROMPT_FILE="$(dirname "$0")/../prompts/fact-check.md"
PROMPT="$(cat "$PROMPT_FILE" "$DRAFT_FILE")"

pi --provider "$PROVIDER" --model "$MODEL" --no-session --no-tools -p "$PROMPT"
