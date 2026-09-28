/**
 * Pins `TZ` for the test suite, on every platform, without a shell.
 *
 * #1629. `ci.yml` declares `TZ: UTC` in the job's `env:`, so CI's result is a
 * property of the code rather than of the runner's clock. This is the same
 * invariant for a developer's own machine, where the zone is whatever their
 * laptop is set to.
 *
 * ## Why this is a module and not `TZ=UTC npm test`
 *
 * The obvious spelling is a shell prefix, and it is wrong for this repository.
 * The README documents Windows install paths (Command Prompt and PowerShell
 * separately), and npm runs scripts through `cmd.exe` there, where `TZ=UTC npm
 * test` is not an assignment but the literal string `TZ=UTC` followed by a
 * command named `TZ=UTC` that does not exist. Adding `cross-env` would fix the
 * syntax and add a dependency to a package that currently has three runtime
 * dependencies and no dev tooling beyond `tsx`/`typescript` — a real cost for
 * one environment variable.
 *
 * `--env-file` was measured and does not work either: it only supplies a value
 * for a variable that is *unset*, so a developer who already exports `TZ` still
 * runs in their own zone. A pin has to overwrite, not default.
 *
 * ## Why `--import` and not `TZ` in the parent
 *
 * `node --test` runs each test file in a child process, so setting `TZ` in the
 * shell that launched node would reach them anyway — but only by way of a shell
 * prefix, which is the thing being avoided. `--import` runs this module in every
 * process node starts, parent and child, before any test file is loaded.
 *
 * ## Why `=` and not `??=`
 *
 * A default would let an ambient `TZ` win, which is the failure this exists to
 * remove: a developer in UTC+14 would get a green run that CI never reproduces.
 * Overwriting is the point. The two suites that assert timezone-independence
 * (`tools.swarm3analytics`, `tools.libraryanalytics`) assign `process.env.TZ`
 * themselves and restore it, so they are unaffected — they are testing the
 * handling, not inheriting an ambient value.
 */

/** The zone every supported runner and developer machine agrees on. */
const PINNED = 'UTC';

process.env.TZ = PINNED;

// Assigned, not defaulted, on purpose — see the note above. Exported so a
// reader (and `knip`, which is configured to treat `scripts/*.mjs` as entry
// points) can see this module has a use beyond its side effect.
export const PINNED_TIMEZONE = PINNED;
