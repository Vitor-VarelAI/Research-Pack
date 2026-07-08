#!/usr/bin/env bash
set -euo pipefail

DRAFT_FILE="${1:-}"
MODEL="${HF_MODEL:-utter-project/EuroLLM-22B-Instruct-2512:publicai}"

if [[ -z "$DRAFT_FILE" || ! -f "$DRAFT_FILE" ]]; then
  echo "Usage: scripts/ptpt-lint.sh <draft-file>" >&2
  exit 2
fi

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "Missing HF_TOKEN. Export it first: export HF_TOKEN='hf_...'" >&2
  exit 2
fi

SYSTEM_PROMPT="$(cat "$(dirname "$0")/../prompts/ptpt-lint.md")"
USER_TEXT="$(cat "$DRAFT_FILE")"

python3 - "$MODEL" "$SYSTEM_PROMPT" "$USER_TEXT" <<'PY'
import json
import os
import sys
import urllib.request

model, system_prompt, user_text = sys.argv[1], sys.argv[2], sys.argv[3]
token = os.environ["HF_TOKEN"]

payload = {
    "model": model,
    "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text},
    ],
    "temperature": 0.1,
    "max_tokens": 1200,
}

req = urllib.request.Request(
    "https://router.huggingface.co/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=180) as response:
        body = json.loads(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    print(error.read().decode("utf-8", errors="replace"), file=sys.stderr)
    raise SystemExit(error.code)

print(body["choices"][0]["message"]["content"])
PY
