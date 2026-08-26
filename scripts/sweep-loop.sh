#!/usr/bin/env bash
# Quota-paced live sweep: runs the gauntlet in spaced batches until every
# registered tool is recorded. Resume-aware (FAILs are retried on later
# batches; PASS/GATED/SKIP entries are kept).
#
#   BATCH=40 INTERVAL=1800 scripts/sweep-loop.sh
#
# Env: BATCH (calls per run, default 40), INTERVAL (seconds between batches,
# default 1800), REPORT (cumulative report path, default
# memory/live-sweep-report.json), MAX_BATCHES (hard stop, default 30).
set -u
cd "$(dirname "$0")/.."
BATCH="${BATCH:-40}"
INTERVAL="${INTERVAL:-1800}"
REPORT="${REPORT:-memory/live-sweep-report.json}"
MAX_BATCHES="${MAX_BATCHES:-30}"
mkdir -p memory

for i in $(seq 1 "$MAX_BATCHES"); do
  echo "=== sweep batch $i/$MAX_BATCHES ($(date -u +%FT%TZ)) — report: $REPORT ==="
  out=$(node scripts/live-gauntlet.mjs --batch="$BATCH" --resume="$REPORT" --report="$REPORT" 2>&1)
  code=$?
  echo "$out" | tail -25
  if echo "$out" | grep -q "SWEEP_COMPLETE"; then
    echo "SWEEP DONE after $i batches"
    exit 0
  fi
  if echo "$out" | grep -q "QUOTA_WALL"; then
    WAIT=$(( INTERVAL * 2 ))
    echo "batch $i: quota wall detected — backing off ${WAIT}s"
  else
    WAIT=$INTERVAL
    echo "batch $i exit=$code; sleeping ${WAIT}s before next batch"
  fi
  sleep "$WAIT"
done
echo "MAX_BATCHES ($MAX_BATCHES) reached — run again later to continue"
exit 1