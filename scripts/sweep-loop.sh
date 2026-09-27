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
# refuses to start; a lock whose owner is gone is reclaimed, and so is one that
# names no owner at all — the shape a loop killed between creating the lock and
# recording its pid leaves behind. The reclaim waits briefly for a losing
# competitor to name itself first, so "no owner" means wreckage rather than a
# loop that is mid-acquire. The lock and the staging file are released by traps
# on every exit path, including a signal, which is honoured at once even during
# the inter-batch pause.
#
# Exit codes:
#   0  every registered tool is recorded (SWEEP_COMPLETE)
#   2  bad input — a knob was not an integer or was out of range; node never
#      started, so a usage error can never be mistaken for a sweep failure
#   3  MAX_BATCHES reached with every batch accounted for; the sweep is
#      incomplete but resumable — re-run the same command later and it
#      continues from the report
#   4  another sweep loop already holds the lock for this report
#   5  the run did not produce a trustworthy sweep. One of two causes, and the
#      message names which: a batch died mid-write or exited non-zero without
#      reaching any of the gauntlet's own end-of-batch, quota-wall or
#      completion paths (three of those, or MAX_BATCHES with at least one, is a
#      failure rather than a pause); or the gauntlet recorded a mutation proof
#      that blocks — MUTATIONS_DETECTED or UNVERIFIED — which fails the batch it
#      happened in immediately, because a detected mutation is a fact about the
#      account, not a transient to retry
#
#      Either way the report is left at its last complete batch.
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
lost (resumable), 4 lock held by another loop, 5 a batch lost its report, or the
gauntlet recorded a mutation proof that blocks
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
# How long a lock that names nobody is given to name somebody before it is
# treated as wreckage. The acquire window being waited out is a mkdir and a
# write — microseconds — so this is orders of magnitude of headroom, and it is
# the only thing standing between a crash artefact and reclaiming a live loop.
LOCK_OWNER_GRACE_SECONDS=2

# The pid a lock claims, or a non-zero return when it claims none. Both halves
# of the write are needed: a lock left by a loop killed between the mkdir and
# the write has no pid file, and one interrupted mid-write has a truncated one.
lock_owner_pid() {
  local raw=''
  if [[ -f $LOCK/pid ]]; then raw=$(cat -- "$LOCK/pid" 2>/dev/null || true); fi
  [[ $raw =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$raw"
}

acquire_lock() {
  if mkdir -- "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK/pid"
    return 0
  fi

  # A competitor that won this mkdir writes its pid a moment later, so a lock
  # naming nobody is not yet proof of a crash. Give it the grace period to
  # identify itself before concluding the lock is wreckage.
  local owner='' waited=0
  while :; do
    if owner=$(lock_owner_pid); then break; fi
    (( waited < LOCK_OWNER_GRACE_SECONDS )) || break
    sleep 1
    waited=$(( waited + 1 ))
  done

  if [[ -z $owner ]] || ! kill -0 "$owner" 2>/dev/null; then
    if [[ -n $owner ]]; then
      printf 'sweep-loop: reclaiming the lock left by dead pid %s\n' "$owner" >&2
    else
      printf 'sweep-loop: reclaiming %s — it names no owner, which is what a killed loop leaves behind\n' \
        "$LOCK" >&2
    fi
    rm -rf -- "$LOCK"
    if mkdir -- "$LOCK" 2>/dev/null; then
      printf '%s\n' "$$" >"$LOCK/pid"
      return 0
    fi
    # Lost the reclaim race: a live loop is holding the lock now, so the pid
    # read before the rm is stale and must not be the one reported.
    owner=$(lock_owner_pid || true)
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
SLEEPER_PID=''

# Every step is `|| true`. This runs under `set -e`, where one failing rm used
# to abort the function partway: the lock stayed on disk — outliving the run
# that leaked it, which is the failure the lock exists to prevent — and the
# script's exit status was replaced by the rm's, so a finished sweep reported
# itself as a failure. Releasing the lock is the last thing this does and it
# does it whatever the earlier steps did.
cleanup() {
  local code=$?
  if [[ -n $STAGED ]] && [[ -e $STAGED ]]; then rm -f -- "$STAGED" || true; fi
  rm -rf -- "$WORKDIR" || true
  if (( LOCK_HELD == 1 )) && [[ $(cat -- "$LOCK/pid" 2>/dev/null || true) == "$$" ]]; then
    rm -rf -- "$LOCK" || true
  fi
  return "$code"
}

on_signal() {
  local what=$1 code=$2
  # A pause puts its sleep in the background; SIGKILL cannot be trapped, so
  # without this an operator's escalating kill chain leaves the sleep behind.
  if [[ -n $SLEEPER_PID ]]; then kill "$SLEEPER_PID" 2>/dev/null || true; fi
  printf 'sweep-loop: %s — the report was left at its last complete batch\n' "$what" >&2
  exit "$code"
}

# The inter-batch pause runs its sleep as a background job and waits on that.
# bash services a trap only between commands, so a foreground `sleep` was not
# interruptible: a signal landing during a pause waited the pause out — up to
# INTERVAL seconds, or twice that after a quota wall — and the only way out was
# kill -9, which runs no trap either and so leaked the lock.
pause() {
  local secs=$1
  sleep "$secs" &
  SLEEPER_PID=$!
  wait "$SLEEPER_PID" || true
  SLEEPER_PID=''
}

trap cleanup EXIT
trap 'on_signal interrupted 130' INT
trap 'on_signal terminated 143' TERM

# ---- batches -----------------------------------------------------------
hard_failures=0
# Why this run's last failing batch failed. "no report" is the crash case; a
# blocking proof names itself. Both exit-5 summaries below used to say "without
# recording a batch", which stopped being true the moment a batch could fail
# *with* a report published — a blocking mutation proof fails a batch that wrote
# and published its report perfectly well. A summary that cannot describe the
# failure it is summarising is the same defect as the guard that produced it.
last_failure='no report'

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

  # The gauntlet's last word on a batch. On the completion path it prints
  # SWEEP_COMPLETE and exits `proofBlocksExit(completeProof) ? 1 : 0`
  # (live-gauntlet.mjs), so SWEEP_COMPLETE with a non-zero exit is a sweep that
  # recorded every tool and still cannot claim the account was left alone.
  # #1346 was only the batch-side of this: the completion path read the marker
  # and reported "SWEEP DONE" without ever looking at the exit status, so a
  # cumulative MUTATIONS_DETECTED on the final batch of a sweep was announced as
  # a clean finish.
  proof_status=$(sed -n 's/^mutation proof: //p' "$batch_log" | tail -n 1)
  banner_state=absent
  if grep -q 'batch run finished' "$batch_log"; then banner_state=present; fi

  if grep -q 'SWEEP_COMPLETE' "$batch_log"; then
    if (( code != 0 )); then
      printf 'sweep-loop: the gauntlet reported SWEEP_COMPLETE but exited %d — every tool is recorded and its mutation proof (%s) does not allow a claim, so this is not a clean sweep; the report is left at its last complete batch\n' \
        "$code" "${proof_status:-none}" >&2
      tail -25 "$batch_log" >&2
      exit 5
    fi
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

  # Both exit-5 messages below used to end "the report is unchanged", which is
  # only true while no batch of the run has published. A flaky sweep loses one
  # batch among good ones — the ordinary case — so the claim contradicts the
  # very artifact the script exists to protect. "Left at its last complete
  # batch" is the invariant the staging-and-rename above actually holds, and it
  # stays true whether or not a batch published during the run.
  #
  # #1346: the guard used to be `code != 0 && ! grep -q 'batch run finished'`,
  # which asked the banner to stand in for the exit status. The banner is
  # printed *before* the report is written, so it is present on every batch
  # that got that far — the condition evaluated false for every completed batch
  # whatever it exited with, and a completed batch that caught a tool mutating
  # state during what it believed was a dry run was recorded as a success. The
  # exit status is the signal; the banner is diagnostic context and is named in
  # the message instead of deciding anything.
  #
  # A non-zero exit is not unconditionally a failed batch, and treating it as
  # one would be a second wrong verdict in the other direction. The gauntlet
  # exits 1 for `counts.FAIL || proofBlocksExit(proof)`, so exit 1 covers a
  # tool FAIL — a quota wall, a gated endpoint — which published its report and
  # is retried by --resume on a later batch. That is the ordinary product of a
  # sweep and is what exit 3 ("resumable") means; counting it would let one
  # bad batch trip the three-batch threshold and stop a healthy run. What is
  # not ordinary is a mutation proof that blocks, so the proof line is read
  # directly: MUTATIONS_DETECTED and UNVERIFIED are the two statuses the
  # gauntlet itself refuses to exit 0 on, and either one fails the batch
  # immediately rather than accumulating toward a threshold — a detected
  # mutation is a fact about the account, not a transient to retry.
  case ${proof_status:-} in
    MUTATIONS_DETECTED|UNVERIFIED)
      printf 'batch %d: the gauntlet exited %d and recorded mutation proof %s — it completed the batch (%s) and still could not show the account was left alone, so the batch is a failure, not a resumable pause\n' \
        "$i" "$code" "$proof_status" "$banner_state" >&2
      batch_failed=1
      last_failure="mutation proof $proof_status"
      ;;
  esac

  # Reaching the end of a batch, a quota wall or completion is the gauntlet's
  # own contract; a non-zero exit with none of those means the process died,
  # and three of those is a failure rather than a slow sweep. A batch that
  # already failed above is not counted again: "failed N batches running" has
  # to mean N batches, or the threshold trips half as early as the header says.
  #
  # Two ways to have exited non-zero without a verdict to read, and neither may
  # be reported as a resumable pause just because the banner was printed. The
  # banner means "reached the end of a batch", which is progress, not a verdict
  # — the proof line is the verdict, and it is rendered *after* the banner. A
  # non-zero exit with no proof line is a process killed between the two.
  if (( batch_failed == 0 )) && (( code != 0 )); then
    if [[ $banner_state == absent ]]; then
      printf 'batch %d: the gauntlet exited %d without reaching the end of a batch (no "batch run finished" line) — the process died before it recorded a verdict\n' \
        "$i" "$code" >&2
      batch_failed=1
      last_failure='no report'
    elif [[ -z ${proof_status:-} ]]; then
      printf 'batch %d: the gauntlet exited %d and printed its end-of-batch banner (%s) but no "mutation proof:" line — it died between the two, so it recorded no verdict on whether the account was left alone\n' \
        "$i" "$code" "$banner_state" >&2
      batch_failed=1
      last_failure='no mutation proof'
    fi
  fi
  if (( batch_failed == 1 )); then
    hard_failures=$(( hard_failures + 1 ))
  fi
  if (( hard_failures >= 3 )); then
    printf 'sweep-loop: the gauntlet failed %d batches running (last exit=%d, last failure: %s); the report is left at its last complete batch\n' \
      "$hard_failures" "$code" "$last_failure" >&2
    tail -25 "$batch_log" >&2
    exit 5
  fi

  # A run that ends at MAX_BATCHES having lost a batch is not a resumable
  # pause: re-running would re-drive a gauntlet that is already failing, and
  # 3 would tell automation to do exactly that. No completion marker was seen
  # above, so 5 is the honest code whatever MAX_BATCHES was. "failed to record
  # one" would also be the wrong summary once a batch can fail with a report
  # published, so the cause is named.
  if (( i == MAX_BATCHES )) && (( hard_failures > 0 )); then
    printf 'sweep-loop: MAX_BATCHES (%d) reached with %d batch(es) running that failed (last failure: %s) — exiting 5, not 3, so a crash is not read as a resumable stop; the report is left at its last complete batch\n' \
      "$MAX_BATCHES" "$hard_failures" "$last_failure" >&2
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
    pause "$WAIT"
  fi
done

echo "MAX_BATCHES ($MAX_BATCHES) reached — run again later to continue"
exit 3
