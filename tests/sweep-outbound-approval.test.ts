/**
 * Outbound-approval guard for the exhaustive-sweep skill (#722).
 *
 * `skills/spotify-exhaustive-feature-sweep/SKILL.md` reads as a procedure, not
 * a menu. Before this guard it authorised a class of actions that leave the
 * machine — `gh issue create` in a batch, `git worktree add` plus a push and a
 * pull request, and a `setsid nohup ... &` loop that keeps spending the user's
 * Spotify app quota after the turn ends — with no approval gate anywhere in the
 * document and `Completion:` lines that read as mandated outcomes. On OpenClaw,
 * where a skill is loaded verbatim, that is a one-command path to irreversible
 * outbound action, and the detached half outlives the session that started it.
 *
 * **What makes this a test and not a grep.** The central assertion is
 * structural and runs in both directions:
 *
 *   - forward — every procedure step whose text performs a gated action must
 *     itself carry a `[Gated: ...]` marker naming that gate. Removing the gate
 *     from a step fails the test even though the top-level gate section still
 *     exists, which is the shape a documentation-only fix takes;
 *   - backward — every gate the document's own table declares must be enforced
 *     by at least one step, so the table cannot drift into an aspirational list
 *     that nothing obeys.
 *
 * A test that only asserted "the file contains the word approval" would pass
 * against the pre-fix file if the word appeared once in an unrelated sentence.
 * The remaining assertions are the parts of the issue's acceptance criteria
 * that a structural check cannot express: that the detached launch is adjacent
 * to its kill command, that probe files default out of the checkout, and that
 * the skill never tells an agent to relax a server-side confirmation gate.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_REL = 'skills/spotify-exhaustive-feature-sweep/SKILL.md';
const SKILL = readFileSync(path.join(ROOT, SKILL_REL), 'utf8');

/** Everything from `## Heading` to the next `## ` heading of the same level. */
function section(heading: string): string {
  const start = SKILL.search(new RegExp(`^## ${heading}$`, 'm'));
  assert.notEqual(start, -1, `${SKILL_REL} has no "## ${heading}" section`);
  const rest = SKILL.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return SKILL.slice(start, end === -1 ? undefined : start + 5 + end);
}

/** Prose with its line wraps rejoined, so a phrase split across two lines is one match. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The numbered procedure steps, as `number -> text`. */
function procedureSteps(): Map<number, string> {
  const procedure = section('Procedure');
  const steps = new Map<number, string>();
  const starts = [...procedure.matchAll(/^(\d+)\. /gm)];
  for (const [i, match] of starts.entries()) {
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index! : procedure.length;
    steps.set(Number(match[1]), procedure.slice(bodyStart, bodyEnd));
  }
  return steps;
}

/** The gate ids a step declares, read from its own `[Gated: G1, G2]` marker. */
function declaredGates(stepText: string): string[] {
  const marker = /\[[^\]]*\bGated:\s*([^\]]*)\]/.exec(stepText);
  return marker ? marker[1].split(',').map(id => id.trim()).filter(Boolean) : [];
}

/**
 * The outbound actions a step performs, and the gate each belongs to.
 *
 * These are *writes* only. `gh pr list`, `gh issue list`, `gh pr view` and
 * `gh issue view` are how the workflow reads the tracker, and step 2 and step 10
 * are entitled to call them without asking. A detector that matched `gh` alone
 * would flag those reads and force a meaningless gate on them.
 *
 * `git push --dry-run` / `git push -n` are previews, not pushes: the gate
 * section requires them *instead of* the real command, so they are stripped
 * before the scan rather than excluded by a pattern that a reword could
 * outwit.
 */
const OUTBOUND_ACTIONS: Array<{ gate: string; what: string; pattern: RegExp }> = [
  { gate: 'G1', what: 'creates issues with `gh issue create`', pattern: /\bgh\s+issue\s+create\b/ },
  {
    gate: 'G2',
    what: 'writes to a tracker (`gh pr|issue create|comment|edit|review|close|…`)',
    pattern: /\bgh\s+(?:pr|issue)\s+(?:create|comment|edit|review|close|reopen|transfer|merge|label)\b/,
  },
  { gate: 'G3', what: 'pushes to a remote', pattern: /\bgit\s+push\b/ },
  { gate: 'G4', what: 'creates a worktree or branch for a dispatched worker', pattern: /\bgit\s+worktree\s+add\b/ },
  {
    gate: 'G5',
    what: 'starts a detached or background process',
    pattern: /\bsetsid\b|\bnohup\b|\bscreen\b|\btmux\b|\bdisown\b/,
  },
];

/** A step with its preview forms of a gated action removed. */
function withoutPreviews(stepText: string): string {
  return stepText
    .replace(/git\s+push\s+(?:--dry-run|-n)\b/g, 'git push PREVIEW')
    .replace(/`git push \(equivalently `git push -n`\)`/g, 'git push PREVIEW');
}

describe('exhaustive-sweep skill gates its outbound writes (#722)', () => {
  it('declares a gate for every outbound action, and each gate is enforced', () => {
    const gateSection = section('Outbound approval gate');
    const steps = procedureSteps();

    // Backward: the table may not declare a gate that no step enforces.
    const declaredInTable = [...gateSection.matchAll(/^\|\s*(G\d+)\s*\|/gm)].map(m => m[1]);
    assert.ok(
      declaredInTable.length >= 5,
      `the gate table declares only ${declaredInTable.length} gate(s); the sweep has more outbound ` +
        'actions than that (issues, tracker writes, pushes, worktree dispatch, detached launch)',
    );

    const enforced = new Set<string>();
    for (const [number, text] of steps) {
      for (const id of declaredGates(text)) enforced.add(id);
    }

    const unenforced = declaredInTable.filter(id => !enforced.has(id));
    assert.deepEqual(
      unenforced,
      [],
      'these gates are declared in the gate table but no procedure step carries the matching ' +
        `[Gated: ...] marker, so nothing enforces them: ${unenforced.join(', ')}`,
    );

    // Forward: a step that performs a gated action must gate that action itself.
    const ungated: string[] = [];
    for (const [number, text] of steps) {
      const gates = declaredGates(text);
      const body = withoutPreviews(text);
      for (const action of OUTBOUND_ACTIONS) {
        if (!action.pattern.test(body)) continue;
        if (gates.includes(action.gate)) continue;
        ungated.push(`step ${number} ${action.what} but does not declare [Gated: ${action.gate}]`);
      }
    }

    assert.deepEqual(
      ungated,
      [],
      'these procedure steps perform an outbound action with no gate in their own block — the ' +
        `top-level gate section does not reach them:\n${ungated.join('\n')}`,
    );

    // The procedure is not the only prose an agent reads. `When to Use`, the
    // gate markers' siblings, and `References` all ship in the same file, and
    // the References list already names `scripts/sweep-loop.sh` and the tracked
    // `memory/live-sweep-report.json` — one stray command appended there would
    // be a real outbound path that no step-level marker could reach. Any gated
    // command appearing outside the procedure is caught here instead.
    const outsideProcedure = SKILL
      .replace(section('Outbound approval gate'), '')
      .replace(section('Procedure'), '');
    const stray: string[] = [];
    for (const action of OUTBOUND_ACTIONS) {
      if (action.pattern.test(withoutPreviews(outsideProcedure))) {
        stray.push(action.what);
      }
    }

    assert.deepEqual(
      stray,
      [],
      'these outbound commands appear outside the gated Procedure — in the header, the ' +
        `Guardrails, or References — where no [Gated: ...] marker can reach them: ${stray.join(', ')}`,
    );
  });

  it('says a gate is only met by an explicit answer in the running session', () => {
    const gate = section('Outbound approval gate');

    assert.match(
      flat(gate),
      /not\*{0,2}\s+approval|is \*\*not\*\* approval/i,
      'the gate section must state that plans, ship lists, and prior approvals are not approval',
    );
    assert.match(
      flat(gate),
      /in the session that is\s+running/i,
      'the gate section must tie the approval to the session that is running',
    );
    assert.match(
      flat(gate),
      /what to ask, one question per topic/i,
      'the gate section must tell the agent to ask about channel and identity separately',
    );
  });

  it('requires both a channel and an identity answer, and defaults the identity', () => {
    const gate = section('Outbound approval gate');

    assert.match(
      flat(gate),
      /\*\*channel\.\*\*|\*\*Channel\.\*\*/,
      'the gate section must ask which channel to use',
    );
    assert.match(
      flat(gate),
      /\*\*identity\.\*\*|\*\*Identity\.\*\*/,
      'the gate section must ask whose identity acts',
    );
    // The house pattern: external sends default to the assistant identity and
    // the owner's identity is opt-in, rather than the reverse.
    assert.match(
      flat(gate),
      /default to the assistant identity/i,
      'external sends must default to the assistant identity',
    );
    assert.match(
      flat(gate),
      /opt-?in/i,
      "the repository owner's own identity must be opt-in, not the default",
    );
    assert.match(
      flat(gate),
      /gh auth status/,
      'the agent must be told to check which account `gh` would actually act as',
    );
    // Attribution: a send made as the owner says so in the body.
    assert.match(
      flat(gate),
      /behalf/i,
      'a gated send made with the owner\'s identity must say so in the body',
    );
  });

  it('requires a preview before the real command', () => {
    const gate = section('Outbound approval gate');

    assert.match(
      flat(gate),
      /preview/i,
      'the gate section must require a preview before the real command',
    );
    assert.match(
      flat(gate),
      /git push --dry-run|--dry-run/,
      'a push must be previewed with --dry-run before the real push',
    );

    // Step 8's preview is the acceptance criterion for the issue-filing path.
    const step8 = procedureSteps().get(8) ?? '';
    assert.match(
      flat(step8),
      /preview/i,
      'step 8 must preview the issues instead of filing straight from the ship list',
    );
    assert.match(
      flat(step8),
      /\/tmp\/exhaust-issues-preview\.md/,
      'step 8 must write the proposed issue bodies to a preview file under /tmp',
    );
  });

  it('does not let one approval cover a session, a scope change, or a loop pass', () => {
    const gate = section('Outbound approval gate');
    const carry = gate.slice(gate.search(/^### What approval does not carry to$/m));
    assert.notEqual(
      gate.search(/^### What approval does not carry to$/m),
      -1,
      'the gate section needs a "what approval does not carry to" clause',
    );

    for (const [pattern, what] of [
      [/session ends, restarts|end, restarts|restarts, is compacted|compacted/i, 'a session boundary'],
      [/scope change|changes the channel, identity, count, base branch, or budget/i, 'a scope change'],
      [/loop, retry, or resumed batch|retries,|resumed batch/i, 'a loop, retry, or resumed batch'],
      [/worker other than the one the human answered|dispatched/i, 'a dispatched worker'],
    ] as const) {
      assert.match(carry, pattern, `the non-carry clause must cover ${what}`);
    }

    // The re-entry case is the one the issue calls out: a detached loop that
    // files issues or opens PRs on a later pass has laundered its approval.
    assert.match(
      flat(carry),
      /not a licence for the\s+actions inside it|no.*inherits that approval/i,
      'the clause must say an approved loop does not approve the actions inside it',
    );

    // Step 12 repeats it at the point of use, not only in the preamble.
    const step12 = procedureSteps().get(12) ?? '';
    assert.match(
      flat(step12),
      /not a licence for later passes|asks? (?:the human )?again/i,
      'step 12 must state that a resumed or re-launched loop re-asks rather than reusing its approval',
    );
  });

  it('puts the kill command next to the detached launch, and gates the launch', () => {
    const step12 = procedureSteps().get(12) ?? '';

    const launch = step12.search(/setsid/);
    assert.notEqual(launch, -1, 'step 12 must still document the detached launch');

    const kill = step12.search(/\bkill\s+-TERM|\bpkill\b/);
    assert.notEqual(kill, -1, 'step 12 must give the exact command that stops the detached loop');
    assert.ok(
      kill > launch,
      'the kill command must come after the launch it stops, not in a different section',
    );
    // The launch names the pid it will run under, so the kill has a target.
    assert.match(
      step12.slice(launch, kill + 400),
      /\$!|SWEEP_PID/,
      'the launch must record the pid so the stop command has a target',
    );

    assert.match(
      flat(step12),
      /only after\s+the human approves/i,
      'the detached launch must be gated on an explicit approval, not offered as a default',
    );
  });

  it('keeps probe files out of the repository working tree by default', () => {
    const step11 = procedureSteps().get(11) ?? '';

    assert.doesNotMatch(
      flat(step11),
      /write (?:auditable )?probe files under `scripts\/`/i,
      'step 11 must not tell an agent to write probe files into scripts/',
    );
    assert.match(
      flat(step11),
      /`\/tmp\/[a-z0-9.-]*probe[a-z0-9.-]*\.mjs`/i,
      'step 11 must default probe files to a /tmp path',
    );
    assert.match(
      flat(step11),
      /working tree dirty/i,
      'step 11 must say a sweep does not leave the checkout dirty as a side effect',
    );
  });

  it('leaves the server-side confirmation gates alone', () => {
    const guardrails = section('Guardrails');

    assert.match(
      flat(guardrails),
      /requiredConfirmationRefusal[\s\S]{0,200}fail(?:s|ing)? closed/i,
      'the guardrails must restate that requiredConfirmationRefusal fails closed',
    );
    assert.match(
      flat(guardrails),
      /SPOTIFY_MCP_CONFIRM=never/,
      'the guardrails must name SPOTIFY_MCP_CONFIRM=never as the only sanctioned bypass',
    );
    assert.match(
      flat(guardrails),
      /without an explicit human approval/i,
      'the guardrails must carry a blanket "never … without explicit human approval" rule',
    );
  });
});
