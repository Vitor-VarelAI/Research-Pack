#!/usr/bin/env bash
set -euo pipefail

DRAFT_FILE="${1:-}"
OUT_DIR="${2:-data/lint-runs/$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ -z "$DRAFT_FILE" || ! -f "$DRAFT_FILE" ]]; then
  echo "Usage: scripts/content-qa.sh <draft-file> [out-dir]" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
cp "$DRAFT_FILE" "$OUT_DIR/draft.md"

run_fact_check() {
  local out="$OUT_DIR/fact-check.json"
  echo "==> fact check gate: deepseek" >&2
  if scripts/fact-check.sh "$DRAFT_FILE" deepseek > "$out"; then
    echo "saved $out" >&2
  else
    echo "FAILED fact check; partial output at $out" >&2
    return 1
  fi
}

run_lint() {
  local provider="$1"
  local out="$OUT_DIR/${provider}.json"
  echo "==> editorial lint: $provider" >&2
  if scripts/editorial-lint.sh "$DRAFT_FILE" "$provider" > "$out"; then
    echo "saved $out" >&2
  else
    echo "FAILED $provider lint; partial output at $out" >&2
    return 1
  fi
}

run_fact_check
run_lint deepseek
run_lint zai

if [[ -n "${HF_TOKEN:-}" ]]; then
  echo "==> PT-PT lint: EuroLLM/HF" >&2
  if scripts/ptpt-lint.sh "$DRAFT_FILE" > "$OUT_DIR/ptpt.json"; then
    echo "saved $OUT_DIR/ptpt.json" >&2
  else
    echo "PT-PT lint failed; see provider/HF availability" >&2
  fi
else
  cat > "$OUT_DIR/ptpt.skipped.txt" <<'MSG'
PT-PT lint skipped: HF_TOKEN not set or provider unavailable.
Current fallback: main agent does final PT-PT pass manually using AGENTS.md checklist.
MSG
fi

cat > "$OUT_DIR/README.md" <<MSG
# Content QA Run

Draft: ./draft.md

Outputs:
- ./fact-check.json — minimum 3-link source gate
- ./deepseek.json — default structural/editorial lint
- ./zai.json — adversarial second opinion
- ./ptpt.json — PT-PT lint if HF_TOKEN/provider available
- ./ptpt.skipped.txt — reason if skipped

Next step: main agent applies only valid patches, rejecting worker patches that violate house rules.
MSG

echo "$OUT_DIR"
