/**
 * The `instructions` string a host receives in the `initialize` response
 * (#690), built on the non-affiliation notice #705 put there.
 *
 * ## Why this is its own module and not a string in `src/index.ts`
 *
 * Two reasons, and the second is the one that bites.
 *
 * The first is reuse: the same guidance is wanted by the CLI's own agent
 * surfaces and by anything else that has to describe the server to an agent
 * that has not read the README. A literal in `index.ts` can only be read by
 * importing `index.ts`, which *starts a server* — a side effect no doc
 * generator and no test wants.
 *
 * The second is testability. A test that asserts "the guidance reaches the
 * wire" has to read the guidance from somewhere, and the honest place to read
 * it from is the module that owns it. Inlining the text in `index.ts` forces
 * every such assertion to spawn a process, which is right for the one test
 * that must check the wire and wrong for the rest.
 *
 * ## The non-affiliation notice is a prefix, deliberately
 *
 * `BRANDING_NOTICE` leads this string verbatim, imported from
 * `src/branding.ts` rather than re-typed. #705 established that the
 * `initialize` response is the one surface a host-only agent sees — no
 * README, no npm page, no repository — and the project name begins with
 * "Spot", so the notice is the sentence that has to be there for the naming
 * decision to be defensible.
 *
 * Leading with it rather than trailing it is the load-bearing choice. A host
 * that trims or summarises a long string keeps the start, and #705's whole
 * argument is that the notice must not be skippable; guidance in front would
 * demote the disclosure to a paragraph at the end of a prompt. Leading also
 * keeps `tests/branding-notice-guard.test.ts` a cheap `startsWith` instead of
 * an `includes` that a later edit could satisfy with the sentence buried
 * mid-paragraph.
 *
 * ## What is deliberately NOT in here
 *
 * - **A tool count.** `toolset_report` returns the live registered count, and
 *   a number written into this string is a number that goes stale the moment
 *   anyone adds a tool. #997 and #803 are both about this server reporting a
 *   value it did not measure; a hardcoded count in a string every host reads
 *   is the same defect wearing a different hat. Point the host at
 *   `toolset_report` instead, which is measured at call time.
 * - **Anything account-specific or credential-shaped.** This string is sent
 *   to whoever launched the process. `tests/credential-doc-guard.test.ts`
 *   (#699) guards the docs against credential-shaped text; the runtime
 *   surface needs the same discipline, so nothing here names a token file, a
 *   client id, or a scope value.
 * - **Non-ASCII.** Hosts render this in terminals, logs and system prompts
 *   with widely varying fonts and encodings. A smart quote or an arrow turns
 *   a guidance line into a mojibake line in somebody's agent context, and the
 *   `ASCII` guard in the test is what stops that being a silent regression.
 * - **Spotify marks.** Plain-text attribution only — no logo, no wordmark, no
 *   styling. `tests/third-party-marks-guard.test.ts` (#698) is the
 *   authority on that boundary.
 */

import { BRANDING_NOTICE } from './branding.js';

/** The one-liner on what this server is. Names the account it acts as. */
const SCOPE =
  'Spotify Web API tools for the account you authenticated as.';

const DISCOVERY =
  'Unsure which tool to call? find_tool searches the live registry, inspect_tool returns one tool\'s input '
  + 'schema, toolset_report shows the active toolsets and tool count. Use these first.';

const DRY_RUN =
  'dry_run: most mutating tools default it to true, so an omitted dry_run previews and dry_run: false '
  + 'commits. Playback tools (play, pause, skip_next, set_volume, queue, scenes) default to false and commit '
  + "when omitted; pass dry_run: true to preview. Read each tool's inputSchema for its default.";

const TOOLSETS =
  'SPOTIFY_MCP_TOOLSETS trims the surface (unset = curated default, "all" = everything) and '
  + 'SPOTIFY_MCP_READONLY hides every write tool. A tool you cannot see may be trimmed, not missing.';

const RECEIPTS =
  'A write returns a receipt id for undo. Receipts are session-scoped and in memory, so an id from an '
  + 'earlier session is gone.';

/**
 * The assembled instructions string.
 *
 * Newline-separated rather than prose paragraphs: a host that folds or
 * re-wraps text keeps one idea per line, and the discovery and `dry_run`
 * lines are the two an agent needs to have read before its first tool call.
 *
 * Assembled here from named parts rather than written as one literal so a
 * test can assert on a part (`DISCOVERY`) and so the byte budget in the test
 * is measured against the same string the wire carries.
 *
 * `BRANDING_NOTICE` leads. #705 put the notice in this response and its own
 * doc comment frames the notice as the sentence an unaffiliated reader must
 * not be able to miss; guidance in front of it would demote the disclosure to
 * a paragraph a host may trim. It costs nothing to lead with it, and it keeps
 * `tests/branding-notice-guard.test.ts`'s assertion a cheap `startsWith`.
 */
export const SERVER_INSTRUCTIONS = [
  BRANDING_NOTICE,
  SCOPE,
  DISCOVERY,
  DRY_RUN,
  TOOLSETS,
  RECEIPTS,
].join('\n\n');
