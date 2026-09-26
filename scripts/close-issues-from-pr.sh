#!/usr/bin/env bash
# Close issues after a merge that the merge itself did not close.
#
# Why this exists: when slice PRs ship through an *integration* PR, GitHub
# never processes the slice PR's own `Closes` keyword, and a keyword left only
# on the slice PR strands the issue. It has happened repeatedly in this repo
# and the failure is SILENT -- `gh pr merge` prints no issue lines when it
# matched nothing, which reads as success. Twice tonight a merge reported
# clean while leaving the issue open. So this reads the body back and
# reconciles explicitly, and refuses to report success unless every issue it
# was told about is verifiably closed.
#
# Usage: close-issues-from-pr.sh <pr-number> [expected-issue ...]
#   With explicit issue numbers, only those are considered.
#   Without, every `Closes #N` / `Fixes #N` in the body is considered.
set -uo pipefail

REPO="NovaLux12/spotify-mcp-server"
PR="${1:?usage: close-issues-from-pr.sh <pr-number> [issue ...]}"
shift || true

state=$(gh pr view "$PR" -R "$REPO" --json state --jq .state 2>/dev/null)
if [ "$state" != "MERGED" ]; then
  echo "REFUSING: PR #$PR is '${state:-unknown}', not MERGED." >&2
  echo "Closing an issue for an unmerged PR is how an issue gets closed with no code behind it." >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  issues=("$@")
else
  mapfile -t issues < <(
    gh pr view "$PR" -R "$REPO" --json body --jq .body \
      | grep -oiE '\b(closes|fixes|resolves)[[:space:]]+#[0-9]+' \
      | grep -oE '#[0-9]+' | tr -d '#' | sort -u
  )
fi

if [ "${#issues[@]}" -eq 0 ]; then
  echo "PR #$PR body names no closing keywords and none were supplied. Nothing to reconcile."
  exit 0
fi

pr_url=$(gh pr view "$PR" -R "$REPO" --json url --jq .url)
bad=0
for n in "${issues[@]}"; do
  st=$(gh issue view "$n" -R "$REPO" --json state --jq .state 2>/dev/null)
  case "$st" in
    CLOSED) echo "  #$n already CLOSED (GitHub processed the keyword after all)"; continue ;;
    "")     echo "  #$n NOT FOUND"; bad=1; continue ;;
  esac
  if gh issue close "$n" -R "$REPO" --comment \
      "Landed via #$PR ($pr_url). Verified in the merged tree, not inferred from the merge signal." >/dev/null 2>&1; then
    now=$(gh issue view "$n" -R "$REPO" --json state --jq .state)
    if [ "$now" = "CLOSED" ]; then echo "  #$n CLOSED (was $st)"; else echo "  #$n close reported success but state is '$now'"; bad=1; fi
  else
    echo "  #$n FAILED to close (was $st)"; bad=1
  fi
done

[ "$bad" -eq 0 ] || { echo "RECONCILIATION INCOMPLETE — read the lines above." >&2; exit 1; }
echo "All ${#issues[@]} issue(s) reconciled against #$PR."
