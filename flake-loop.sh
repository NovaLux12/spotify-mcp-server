#!/bin/bash
# #1130 reproduction loop. Keeps EVERY log: the whole point of the issue is
# that the previous capture loop discarded the log that would have named the
# failing assertion. A green run is not evidence the flake is gone.
cd /home/jack/wt/flake1130
LOGDIR=/home/jack/wt/flake1130/logs
mkdir -p "$LOGDIR"
echo "start $(date -u +%FT%TZ)" > "$LOGDIR/summary.txt"
for i in $(seq 1 20); do
  npm test > "$LOGDIR/run$i.log" 2>&1
  fails=$(sed -n 's/^. fail \([0-9][0-9]*\)$/\1/p' "$LOGDIR/run$i.log" | tail -1)
  passes=$(sed -n 's/^. pass \([0-9][0-9]*\)$/\1/p' "$LOGDIR/run$i.log" | tail -1)
  echo "run $i: pass=$passes fail=${fails:-?}" | tee -a "$LOGDIR/summary.txt"
done
echo "done $(date -u +%FT%TZ)" >> "$LOGDIR/summary.txt"
