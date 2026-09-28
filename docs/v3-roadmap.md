# The road to 3.0

<!-- BEGIN:generated v3-headline -->
Measured on this branch, just now: a default 3.0 session puts **128 tools** in front of the model — 146,360 bytes of schema — drawn from **559** this server knows how to register. The other 431 are one environment variable away, waiting behind `SPOTIFY_MCP_TOOLSETS` alongside **28** resource templates and **14** prompts.
<!-- END:generated v3-headline -->

3.0 is not a feature release with a bugfix chaser attached. It is the release
where the open issue list goes to zero.

That is a strange thing for a changelog to promise, so let me be precise about
what it means, because "we fixed everything" is a sentence projects say and
rarely a sentence they mean. Here it means the backlog — every epic, every issue
filed under one, every contradiction we found while auditing ourselves — is
closed before the tag is cut. Not deferred to a 3.1. Not relabelled
"won't-fix". Closed, with the closing linked to the code that closed it.

The reason that promise is makeable is that most of the backlog was not a list
of bugs. It was a list of places where this server told you something it had not
actually checked.

## One idea underneath all of it

Almost every issue in the tracker is a variant of a single bug, wearing a
different hat: **a value that could not be read was reported as a value.**

A stats.fm friend on a throttled or private account had their failed stream
lookup recorded as zero streams, so the chart cheerfully informed the reader
that this person had never listened to anything. Five call sites sent a volume
field under a name Spotify does not accept, the write was rejected, and where
the error was swallowed the tool reported a volume that was never applied. A
field typed as a string arrived as `undefined` and the payload carried on
regardless.

None of those were hard bugs. All of them were a server being confidently
wrong, which is the only genuinely dangerous kind of wrong — a loud failure you
can retry, a quiet one you cannot.

3.0's whole character is the decision to **say so when it does not know.**
Exclude the row, name the reason, count it in the summary, never invent a
plausible number to fill the gap.

## What it is made of

The backlog is organised as a set of epics, and they are worth reading as a
list of the ways this server used to be wrong. They still carry `(v2)` in their
titles, because the repository renamed the v2 cycle to 3.0 partway through and
the labels outlived the rename; read them as 3.0's scope, which is what they are:

- **Kill the 153k-token tool payload.** A model does not read a tool list, it
  pays for one. Every schema byte is rent. The default surface was curated
  down and the rest moved behind an environment variable, and the number above
  is regenerated from the live registry so you can see what you are actually
  being charged.
- **Tool contracts — naming, params, defaults, pagination.** This is where
  almost all the breaking changes live, and the theme is that a name that means
  two things is a bug even when both meanings are individually reasonable.
- **MCP protocol surface.** Annotations, output schemas, lazy exposure.
- **Client stability, rate limits and caching.** Honour `Retry-After`. Back off
  exponentially. Never retry in a tight loop.
- **Local file and data safety.** Which files exist, which of them hold
  anything sensitive, and what erases them. A `logout` that reports a clean
  sweep while leaving your account registry on disk is worse than one that
  fails, because it is confidently reassuring.
- **Auth, tokens and the read-only guarantee.** Minimum scopes by default;
  mutation scopes are something you opt into rather than inherit.
- **Test and CI trust.** A test that cannot fail is worse than no test, because
  it buys you the feeling of coverage. Assertions that live in a branch which
  never executes, and expected values recomputed from the same fields the code
  under test reads, are decoration wearing a green tick.
- **Architecture and code hygiene**, **performance and context economics**,
  **compliance, privacy and brand**, **agent workflows**, and the meta-epic
  that sequences all of it.

The live list is the issue tracker. This page deliberately does not transcribe
it, because a copied list is a list that starts lying the moment somebody fixes
something.

## The part where 3.0 deletes features

Worth stating plainly, because it is unusual and it is not a retreat.

In February 2026 Spotify removed a large batch of Web API endpoints. Among them
were the batch reads for albums, artists, episodes, shows and audiobooks, the
artist top-tracks endpoint, the follow/unfollow writes, and the playlist track
routes. Following an artist, specifically, is no longer expressible at all —
`PUT /me/library` takes track, album, episode, show, audiobook, user and
playlist URIs, but not `spotify:artist:`, so the write half of follow has no
migration target. The read half did, cleanly.

So 3.0 removes tools. Not because they were badly built, but because the thing
they talked to stopped existing. Wrapping them in graceful-403 handlers would
have been worse: a removed endpoint returns an error that a tolerant wrapper
converts into a soft, confident, wrong answer — which is the exact disease this
release exists to cure.

## What changes for you

- **Destructive bulk writes fail closed.** If the client cannot ask for
  confirmation, the server refuses. It does not proceed hopefully. For
  headless automation there is one deliberate bypass, and its value has to be
  spelled exactly.
- **The 2.0 playlist input spellings go away in 3.0.** They are still callable
  through the 2.1 line; sending one after the upgrade is refused before any
  Spotify request, with an error that names both what you sent and what to
  send instead. The README's upgrade section has the per-tool migration table,
  because each tool declared exactly one alias pair and there is no single
  spelling that was right everywhere.
- **Unknown arguments are rejected** rather than ignored, so a renamed
  parameter fails loudly instead of quietly doing nothing.
- **A smaller default surface.** Fewer tools in the context window; the rest
  are one environment variable away.

Run the doctor tool after upgrading. It reports the registered surface, the
gates that hid modules, and your granted scopes in one call.

## Why any of this is worth believing

Because this repository is audited by its own CI, and it is unusually honest
about the ways that audit can be fooled.

Documentation counts are not typed by hand — they are generated from the live
registry and a stale one fails the build. Schema budgets are measured per
module, and breaching one fails **server startup**, not just the test run, so
you cannot ship a payload that quietly doubled. Hand-written prose is pinned by
content hash, so a paragraph cannot vanish without the diff saying so. Every
behaviour change ships with a regression test that was demonstrated to fail
without the fix.

The interesting part is not that those gates exist. It is that three separate
gates in this repo confidently misdiagnosed their own failures, and each time
the fix was to go read the code rather than believe the message. A gate that
reports a plausible reason is not the same thing as a gate that reports the
truth, and this release is as much about the second thing as the first.

## After the merge

3.0 closes the backlog. It does not end the project, and the honest position on
everything past it is that nothing is scheduled until this lands. Watch the
tracker for what comes next.

---

Questions about migrating? [docs/faq.md](faq.md) covers auth, Premium, 403s and
headless operation. The full tool contract is in [SPEC.md](../SPEC.md).
