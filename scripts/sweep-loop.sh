#!/usr/bin/env bash
# Quota-paced live sweep: runs the gauntlet in spaced batches until every
# registered tool is recorded. Resume-aware (FAILs are retried on later
# batches; PASS/GATED/SKIP entries are kept).
#
#   BATCH=40 INTERVAL=1800 scripts/sweep-loop.sh
#
# Env:
#   BATCH        calls per run. Integer >= 1 (default 40). Values above 50 are
#                clamped to 50, the largest page the Web API honours. Read as
#                decimal, so a leading zero is not octal: BATCH=010 is 10.
#   INTERVAL     seconds between batches. Integer 0-86400 (default 1800).
#   REPORT       cumulative report path (default memory/live-sweep-report.json).
#                Must be a non-empty single-line path. It is never written in
#                place: each batch stages into a temp file in the same
#                directory, and that file is renamed over the report only once
#                it parses as JSON — so no partial JSON is ever observable at
#                the path, and a run killed mid-write keeps the last report.
#   MAX_BATCHES  hard stop. Integer 1-10000 (default 30).
#
# Concurrency: one loop at a time per report directory, enforced with a
# .sweep-loop.lock directory holding the owner's pid. A second invocation
# refuses to start; a lock whose owner is gone is reclaimed. The lock and the
# staging file are released by traps on every exit path.
#
# Exit codes:
#   0  every registered tool is recorded (SWEEP_COMPLETE)
#   2  bad input — a knob was not an integer or was out of range; node never
#      started, so a usage error can never be mistaken for a sweep failure
#   3  MAX_BATCHES reached with every batch accounted for; the sweep is
#      incomplete but resumable — re-run the same command later and it
#      continues from the report
#   4  another sweep loop already holds the lock for this report
#   5  the gauntlet failed to deliver a report: three batches running died
#      mid-write or exited non-zero without reaching any of the gauntlet's own
#      end-of-batch, quota-wall or completion paths — or the run hit
#      MAX_BATCHES with at least one such batch, which is a failure rather than
#      a pause, so automation is never told to re-run a sweep that keeps
#      crashing
set -euo pipefail
cd "$(dirname "$0")/.."

BATCH="${BATCH:-40}"
INTERVAL="${INTERVAL:-1800}"
# ${REPORT-…}, not ${REPORT:-…}: an exported-but-empty REPORT (or REPORT=$SOME
# unset variable) is an operator mistake to reject, not an instruction to sweep
# onto the git-tracked default — and the empty-path guard below can only fire
# if the substitution is unset-only.
REPORT="${REPORT-memory/live-sweep-report.json}"
MAX_BATCHES="${MAX_BATCHES:-30}"

BATCH_MAX=50          # largest page the Web API honours
INTERVAL_MAX=86400
MAX_BATCHES_MAX=10000

usage() {
  cat >&2 <<'USAGE'
usage: BATCH=40 INTERVAL=1800 MAX_BATCHES=30 REPORT=path scripts/sweep-loop.sh

  BATCH        integer >= 1     calls per run (default 40, clamped to 50, decimal)
  INTERVAL     integer 0-86400  seconds between batches (default 1800)
  MAX_BATCHES  integer 1-10000  batches before a resumable stop (default 30)
  REPORT       non-empty path   cumulative report (default memory/live-sweep-report.json)

exit codes: 0 sweep complete, 2 bad input, 3 max batches reached with nothing
lost (resumable), 4 lock held by another loop, 5 a batch failed to record a report
USAGE
}

bad_input() {
  printf 'sweep-loop: %s\n\n' "$1" >&2
  usage
  exit 2
}

# A knob is only ever handed to $(( )) or to the gauntlet's own integer
# parsing, so anything that is not a plain non-negative integer is rejected
# here rather than surfacing later as an arithmetic or NaN failure.
require_int() {
  local name=$1 raw=$2 min=$3 max=$4
  [[ $raw =~ ^[0-9]+$ ]] || bad_input "$name must be a whole number, got '$raw'"

  # Leading zeros are stripped before any arithmetic. bash reads them as octal,
  # and $(( 099 )) is a parse *error*, not a comparison — raised inside the
  # (( )) below, where set -e cannot see it, so both checks are skipped and the
  # raw knob reaches the gauntlet, whose parseInt(_, 10) turns 099 into 99.
  local digits=$raw
  while [[ ${#digits} -gt 1 && $digits == 0* ]]; do digits=${digits#0}; done

  # Compared as text first, so a digit string too long for bash's 64-bit
  # arithmetic is clamped rather than wrapping into a plausible in-range value.
  local value
  if (( ${#digits} > ${#max} )); then
    printf 'sweep-loop: %s=%s is above the supported maximum %d — clamping\n' \
      "$name" "$raw" "$max" >&2
    printf -v "$name" '%d' "$max"
    return 0
  fi

  value=$(( 10#$digits ))
  if (( value < min )); then
    bad_input "$name must be at least $min, got '$raw'"
  fi
  if (( value > max )); then
    printf 'sweep-loop: %s=%s is above the supported maximum %d — clamping\n' \
      "$name" "$raw" "$max" >&2
    value=$max
  fi
  # What the gauntlet receives is decimal, so its parseInt(_, 10) cannot
  # re-read a zero-padded string as a different number.
  printf -v "$name" '%d' "$value"
}

require_int BATCH "$BATCH" 1 "$BATCH_MAX"
require_int INTERVAL "$INTERVAL" 0 "$INTERVAL_MAX"
require_int MAX_BATCHES "$MAX_BATCHES" 1 "$MAX_BATCHES_MAX"

[[ -n $REPORT ]] || bad_input 'REPORT must not be empty'
[[ $REPORT != *$'\n'* && $REPORT != *$'\r'* ]] || bad_input "REPORT must be a single line, got '$REPORT'"
[[ $REPORT != */ ]] || bad_input "REPORT must be a file path, got '$REPORT'"
[[ ! -d $REPORT ]] || bad_input "REPORT is an existing directory: '$REPORT'"

REPORT_DIR=${REPORT%/*}
if [[ $REPORT_DIR == "$REPORT" ]]; then REPORT_DIR=.; fi
# A root-level path strips to nothing, which mkdir would read as an empty
# operand: the report directory of /report.json is /.
[[ -n $REPORT_DIR ]] || REPORT_DIR=/
mkdir -p -- "$REPORT_DIR"

# ---- one loop at a time ------------------------------------------------
# mkdir is atomic, so the lock needs no helper binary. A lock whose owner is
# gone is a crash artefact, not a live loop, and is reclaimed.
LOCK="${REPORT_DIR%/}/.sweep-loop.lock"
LOCK_HELD=0
lock_owner=unknown

acquire_lock() {
  if mkdir -- "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK/pid"
    return 0
  fi
  local owner=''
  if [[ -f $LOCK/pid ]]; then owner=$(cat -- "$LOCK/pid" 2>/dev/null || true); fi
  if [[ $owner =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
    printf 'sweep-loop: reclaiming the lock left by dead pid %s\n' "$owner" >&2
    rm -rf -- "$LOCK"
    if mkdir -- "$LOCK" 2>/dev/null; then
      printf '%s\n' "$$" >"$LOCK/pid"
      return 0
    fi
    # Lost the reclaim race: a live loop is holding the lock now, so the pid
    # read before the rm is stale and must not be the one reported.
    owner=''
    if [[ -f $LOCK/pid ]]; then owner=$(cat -- "$LOCK/pid" 2>/dev/null || true); fi
  fi
  if [[ $owner =~ ^[0-9]+$ ]]; then lock_owner=$owner; fi
  return 1
}

if ! acquire_lock; then
  printf 'sweep-loop: another sweep loop (pid %s) already holds %s — refusing to start\n' \
    "$lock_owner" "$LOCK" >&2
  exit 4
fi
LOCK_HELD=1

WORKDIR=$(mktemp -d)
STAGED=''

cleanup() {
  local code=$?
  if [[ -n $STAGED && -e $STAGED ]]; then rm -f -- "$STAGED"; fi
  rm -rf -- "$WORKDIR"
  if (( LOCK_HELD == 1 )) && [[ $(cat -- "$LOCK/pid" 2>/dev/null || true) == "$$" ]]; then
    rm -rf -- "$LOCK"
  fi
  return "$code"
}
trap cleanup EXIT
trap 'printf "sweep-loop: interrupted — the report was left at its last complete batch\n" >&2; exit 130' INT
trap 'printf "sweep-loop: terminated — the report was left at its last complete batch\n" >&2; exit 143' TERM

# ---- batches -----------------------------------------------------------
hard_failures=0

for i in $(seq 1 "$MAX_BATCHES"); do
  batch_failed=0
  echo "=== sweep batch $i/$MAX_BATCHES ($(date -u +%FT%TZ)) — report: $REPORT ==="
  # Staged next to the report so the final mv is a same-filesystem rename, and
  # so a run killed mid-write leaves the previous report untouched.
  STAGED=$(mktemp -- "${REPORT_DIR%/}/.${REPORT##*/}.tmp.XXXXXX")
  batch_log="$WORKDIR/batch.$i.log"
  set +e
  # Streamed through tee so a long batch is visible while it runs instead of
  # appearing all at once when node exits.
  node scripts/live-gauntlet.mjs --batch="$BATCH" --resume="$REPORT" --report="$STAGED" 2>&1 \
    | tee "$batch_log"
  code=${PIPESTATUS[0]}
  set -e

  if grep -q 'SWEEP_COMPLETE' "$batch_log"; then
    echo "SWEEP DONE after $i batches"
    exit 0
  fi

  # The gauntlet announces the end of a batch *before* it writes the report,
  # and that write is a single writeFileSync — so a process killed mid-write
  # leaves a non-empty but truncated staging file with a clean-looking log.
  # Only a file that parses is published; the mv is a same-filesystem rename,
  # so a reader sees either the whole previous report or the whole new one.
  if [[ -s $STAGED ]] && node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' -- "$STAGED" 2>/dev/null; then
    # mktemp creates 0600 and mv keeps the mode, which would narrow the
    # published report below what the gauntlet's in-place writeFileSync left.
    chmod 0644 -- "$STAGED"
    mv -f -- "$STAGED" "$REPORT"
    STAGED=''
  else
    if [[ -s $STAGED ]]; then
      echo "batch $i: gauntlet died mid-write — its partial report is discarded, the last complete one is kept" >&2
      batch_failed=1
    else
      echo "batch $i: gauntlet wrote no report — keeping the last complete one" >&2
    fi
    rm -f -- "$STAGED"
    STAGED=''
  fi

  # Reaching the end of a batch, a quota wall or completion is the gauntlet's
  # own contract; a non-zero exit with none of those means the process died,
  # and three of those is a failure rather than a slow sweep. A batch that
  # already failed above is not counted again: "failed N batches running" has
  # to mean N batches, or the threshold trips half as early as the header says.
  if (( batch_failed == 0 )) && (( code != 0 )) && ! grep -q 'batch run finished' "$batch_log"; then
    batch_failed=1
  fi
  if (( batch_failed == 1 )); then
    hard_failures=$(( hard_failures + 1 ))
  fi
  if (( hard_failures >= 3 )); then
    printf 'sweep-loop: the gauntlet failed %d batches running without recording a batch (last exit=%d); the report is unchanged\n' \
      "$hard_failures" "$code" >&2
    tail -25 "$batch_log" >&2
    exit 5
  fi

  # A run that ends at MAX_BATCHES having lost a batch is not a resumable
  # pause: re-running would re-drive a gauntlet that is already failing, and
  # 3 would tell automation to do exactly that. No completion marker was seen
  # above, so 5 is the honest code whatever MAX_BATCHES was.
  if (( i == MAX_BATCHES )) && (( hard_failures > 0 )); then
    printf 'sweep-loop: MAX_BATCHES (%d) reached with %d batch(es) running that failed to record one — exiting 5, not 3, so a crash is not read as a resumable stop; the report is unchanged\n' \
      "$MAX_BATCHES" "$hard_failures" >&2
    tail -25 "$batch_log" >&2
    exit 5
  fi

  if grep -q 'QUOTA_WALL' "$batch_log"; then
    WAIT=$(( INTERVAL * 2 ))
    echo "batch $i: quota wall detected — backing off ${WAIT}s"
  else
    WAIT=$INTERVAL
    echo "batch $i exit=$code; sleeping ${WAIT}s before next batch"
  fi

  if (( i < MAX_BATCHES )); then
    sleep "$WAIT"
  fi
done

echo "MAX_BATCHES ($MAX_BATCHES) reached — run again later to continue"
exit 3
