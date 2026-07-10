#!/usr/bin/env bash
set -euo pipefail

DRAFT_FILE="${1:-}"
OUT_DIR="${2:-data/lint-runs/$(date -u +%Y%m%dT%H%M%SZ)}"

# Source sufficiency gate.
#
# This is a SOURCE SUFFICIENCY GATE, not a full factual-verification system.
# It only checks whether enough valid source anchors exist before downstream
# diagnosis/editorial linters may run. It does not verify whether individual
# claims are true.
#
# Test seams (local mocks only, no paid providers):
#   SOURCE_GATE_RESULT_FILE  Path to a pre-existing source-gate result JSON.
#                            When set, the fact-check LLM call is skipped and
#                            this file is used as the gate output directly.
#   SCRAPE_AGENT_BIN         Override the scrape-agent binary used to validate
#                            the gate JSON against the Zod schema. Defaults to
#                            `node dist/cli.js` (or `npm run dev --` in dev).
if [[ -z "$DRAFT_FILE" || ! -f "$DRAFT_FILE" ]]; then
  echo "Usage: scripts/content-qa.sh <draft-file> [out-dir]" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
cp "$DRAFT_FILE" "$OUT_DIR/draft.md"

resolve_scrape_agent_bin() {
  if [[ -n "${SCRAPE_AGENT_BIN:-}" ]]; then
    printf '%s' "$SCRAPE_AGENT_BIN"
  elif [[ -f dist/cli.js ]]; then
    printf 'node dist/cli.js'
  else
    printf 'npm run dev --silent --'
  fi
}

run_source_gate() {
  local gate_file="${SOURCE_GATE_RESULT_FILE:-$OUT_DIR/fact-check.json}"

  if [[ -n "${SOURCE_GATE_RESULT_FILE:-}" ]]; then
    echo "==> source gate: using pre-existing result $SOURCE_GATE_RESULT_FILE" >&2
    cp "$SOURCE_GATE_RESULT_FILE" "$OUT_DIR/fact-check.json"
  else
    echo "==> source gate: deepseek (source sufficiency gate)" >&2
    if ! scripts/fact-check.sh "$DRAFT_FILE" deepseek > "$gate_file"; then
      echo "FAILED source gate fact-check; partial output at $gate_file" >&2
      return 1
    fi
  fi

  echo "==> source gate: validating JSON + schema + pass/diagnosisAllowed" >&2
  local bin
  bin="$(resolve_scrape_agent_bin)"

  # Validate JSON, schema, pass, and diagnosisAllowed in one call.
  # source-gate --validate throws on: invalid JSON, schema failure, pass:false,
  # or diagnosisAllowed:false. Because of `set -e`, a non-zero exit propagates.
  if ! $bin source-gate --validate "$OUT_DIR/fact-check.json" > "$OUT_DIR/source-gate-validated.json" 2> "$OUT_DIR/source-gate-error.txt"; then
    echo "FAILED source gate validation. Gate blocked downstream linters." >&2
    echo "--- validation error ---" >&2
    cat "$OUT_DIR/source-gate-error.txt" >&2
    echo "-------------------------" >&2
    echo "Source gate did not approve. Downstream linters will not run." >&2
    return 1
  fi

  echo "source gate PASSED; downstream linters may run." >&2
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

# Run the source sufficiency gate first. If it blocks, do NOT run linters.
run_source_gate

# Gate approved — run downstream linters.
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

Source gate (runs first, blocks linters if it fails):
- ./fact-check.json — source sufficiency gate output (minimum 3 anchors, 4 for sensitive topics)
- ./source-gate-validated.json — validated gate result (schema + pass + diagnosisAllowed)
- ./source-gate-error.txt — validation error if the gate blocked

Outputs (only run if the source gate approved):
- ./deepseek.json — default structural/editorial lint
- ./zai.json — adversarial second opinion
- ./ptpt.json — PT-PT lint if HF_TOKEN/provider available
- ./ptpt.skipped.txt — reason if skipped

Next step: main agent applies only valid patches, rejecting worker patches that violate house rules.
MSG

echo "$OUT_DIR"
