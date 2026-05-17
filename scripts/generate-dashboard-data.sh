#!/usr/bin/env bash
# generate-dashboard-data.sh
# Writes / updates dashboard-data.json after every CI scan.
#
# Usage:
#   bash scripts/generate-dashboard-data.sh <violation_count> <files_scanned>
#
# Environment (supplied automatically by GitHub Actions):
#   GITHUB_REPOSITORY  — e.g. "acme/design-system"
#   GITHUB_REF_NAME    — e.g. "main"

set -euo pipefail

VIOLATIONS="${1:-0}"
FILES_SCANNED="${2:-0}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
WEEK=$(date -u +"%G-W%V")
REPOSITORY="${GITHUB_REPOSITORY:-local}"
BRANCH="${GITHUB_REF_NAME:-main}"

# ── Read current counts ─────────────────────────────────────────────────────
EXCEPTION_COUNT=0
if [ -f token-exceptions.json ]; then
  EXCEPTION_COUNT=$(jq '. | length' token-exceptions.json 2>/dev/null || echo 0)
fi

PENDING_COUNT=0
if [ -f pending-tokens.json ]; then
  PENDING_COUNT=$(jq '. | length' pending-tokens.json 2>/dev/null || echo 0)
fi

# ── Compliance: 100 minus 3 points per violation, floor 0 ──────────────────
COMPLIANCE=$(( 100 - VIOLATIONS * 3 ))
if [ "$COMPLIANCE" -lt 0 ];   then COMPLIANCE=0;   fi
if [ "$COMPLIANCE" -gt 100 ]; then COMPLIANCE=100; fi

# ── Update weekly trend (keep last 8 weeks) ─────────────────────────────────
EXISTING_TREND="[]"
if [ -f dashboard-data.json ]; then
  EXISTING_TREND=$(jq '.weekly_trend // []' dashboard-data.json 2>/dev/null || echo "[]")
fi

NEW_ENTRY=$(jq -n \
  --arg week "$WEEK" \
  --argjson compliance "$COMPLIANCE" \
  --argjson violations "$VIOLATIONS" \
  '{ week: $week, compliance: $compliance, violations: $violations }')

UPDATED_TREND=$(echo "$EXISTING_TREND" | jq \
  --argjson entry "$NEW_ENTRY" \
  '. + [$entry] | unique_by(.week) | sort_by(.week) | .[-8:]')

# ── Write dashboard-data.json ───────────────────────────────────────────────
jq -n \
  --arg      ts         "$TIMESTAMP" \
  --arg      repo       "$REPOSITORY" \
  --arg      branch     "$BRANCH" \
  --argjson  files      "$FILES_SCANNED" \
  --argjson  violations "$VIOLATIONS" \
  --argjson  exceptions "$EXCEPTION_COUNT" \
  --argjson  pending    "$PENDING_COUNT" \
  --argjson  compliance "$COMPLIANCE" \
  --argjson  trend      "$UPDATED_TREND" \
  '{
    generated_at:  $ts,
    repository:    $repo,
    branch:        $branch,
    scan_summary: {
      files_scanned:     $files,
      violations_found:  $violations,
      exceptions_logged: $exceptions,
      pending_tokens:    $pending,
      compliance_rate:   $compliance
    },
    weekly_trend: $trend
  }' > dashboard-data.json

echo "dashboard-data.json written — compliance: ${COMPLIANCE}%, violations: ${VIOLATIONS}, files: ${FILES_SCANNED}"
