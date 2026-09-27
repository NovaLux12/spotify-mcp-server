# Compliance: brand marks, attribution, and identification

Scope of this page: what this repository may and may not put in front of a
user, and what it must say when it displays Spotify content. It covers
[#698](https://github.com/NovaLux12/spotify-mcp-server/issues/698).

It also carries the product-name decision and the non-affiliation notice
wording that [#705](https://github.com/NovaLux12/spotify-mcp-server/issues/705)
landed here, under [Naming decision (2026-09-18)](#naming-decision-2026-09-18)
and [The non-affiliation notice](#the-non-affiliation-notice). #705 covered the
non-affiliation half of the MCP `initialize` `instructions` string;
[#690](https://github.com/NovaLux12/spotify-mcp-server/issues/690) still owns
the host-guidance half. Whoever lands it should **extend this page** rather
than create a competing one, and should extend `SERVER_INSTRUCTIONS` in
`src/index.ts` — leaving the notice in `src/branding.ts` where it is — rather
than author a second one.

## The two rules, and why both survive

This is an **unofficial** third-party client. It is easy to over-apply the
first rule and accidentally commit the second breach.

**Rule 1 — do not ship a third party's mark.** Spotify's
[Branding Guidelines](https://developer.spotify.com/branding-guidelines)
state: *"Your logo should not include, or look similar to the Spotify logo or
any of its brand elements (e.g. Spotify Green, the circle, and the waves)."*
Recomposing the mark — the same arcs, the same green, drawn from circles and
curves — is a modification, and the guidelines are categorical about those:
*"Its orientation, color, and composition should remain as indicated in this
document — there are no exceptions."*

**Rule 2 — do remove the required attribution.** Developer Policy Sec. II.4.a
makes attribution mandatory wherever Spotify Content is displayed, and the
Branding Guidelines extend it to metadata: *"If you use any Spotify metadata
(including artist, album and track names, album artwork, and audio playback) it
must always be accompanied by the Spotify brand."*

So this project keeps plain-text references to Spotify, `spotify:` URIs,
`open.spotify.com` links, the `SPOTIFY_*` environment variables, and the API's
own field names — those describe the platform being integrated, which is the
entire point of the project. It ships no mark.

## What "the mark" means here, concretely

Each rule below names the surface it applies to, because the guard's scopes
differ: the colour and geometry rules read both `assets/` and `src/`, the
wordmark rule reads `assets/` only, and the `User-Agent` rule reads `src/` only.
A `Spotify` literal in prose inside `src/` is required by Rule 2, so the
wordmark rule deliberately does not look there.

| Prohibited | Where | Why |
|---|---|---|
| `#1DB954` / `#1ED760` (Spotify Green, any casing or notation, including the `rgb(29,185,84)` spelling) | `assets/` and `src/` | Named outright as a restricted brand element. |
| The circle, or the waves arcs, redrawn / recoloured / partial | `assets/` and `src/` | Modification; no exceptions. |
| `Spotify`, `stats.fm`, `Last.fm` or `Discogs` set as artwork — a rendered `<text>` node | `assets/` only | Wordmark reproduction. |
| A vendored copy of any official logo file | `assets/` is where one would land; the guard pins two specific paths | This is an MIT repository; the mark is not ours to sublicense. `assets/logo.svg` and `assets/attribution-strip.svg` are named in the test and must not come back. |

`tests/third-party-marks-guard.test.ts` enforces this by scanning the source
tree. It is a source scan rather than a behavioural assertion because a mark
has no runtime behaviour to assert on — the defect is a literal in a file, and
a behavioural test can only cover the files its author happened to think to
load.

Two limits of the scan are worth stating rather than leaving for someone to
discover. The wordmark rule matches a service name as a text literal; it has no
geometry rule, so a hand-drawn substitute that spells no name — a bar chart or a
dot chain standing in for a wordmark — passes. And the waves rule matches three
stacked single-curve paths in one `<g>`, which is the Spotify waves specifically,
not a general "resembles the mark" test. Neither gap is a licence: the rules
above stand on their own, and the guard is a backstop rather than the policy.

`assets/` does not currently exist in this tree, and the guard tolerates that —
`filesUnder` returns an empty list for a missing directory. Every assets-scoped
rule above therefore matches zero files today, and would start matching the
moment an `assets/` directory appears.

## Visual attribution: reference it, do not redraw it

If a host renders images and needs to attribute Spotify visually, the correct
move is to **reference the official full logo by URL, unmodified**, from the
[Branding Guidelines](https://developer.spotify.com/branding-guidelines).
Do not draw it, and do not commit a copy of it into this repository — the
asset is Spotify's, and vendoring it into an MIT-licensed tree is a second
problem on top of the first.

The rules that apply to that reference, per the Branding Guidelines:

- **Use the full logo — icon plus wordmark.** *"You should always use our full
  logo (icon + wordmark)."* The icon-only exception is narrow and does not
  apply here: *"We do allow using only our icon if it's featured as an app icon
  on the app screen of a device."* A README, a web page, or a rendered tool
  result is not a device app screen.
- **Minimum size.** The full logo *"should never be smaller than 70px in
  digital or 20mm in print."* The icon alone is *"never smaller than 21px in
  digital or 6mm in print."*
- **Exclusion zone.** *"The exclusion zone is equal to half the height of the
  icon."* Keep the logo isolated from competing visual elements and out of
  low-contrast areas.
- **No modification.** Do not rotate, recolour, restyle, stretch, or recompose
  it, and do not fill the lines of the logo.

Text-only hosts do not need any of this: the attribution requirement is met in
prose, not with a picture. A host that renders images must apply the rules
above on its own surface; this repository supplies the policy, not the pixels.

## Outbound `User-Agent`

Every request to a third-party service carries a `User-Agent`. Naming that
service in ours is not free.

stats.fm's Terms Sec. 7.1(g) forbids using their *"name, logo or trademarks
without our prior written consent"*, and Sec. 4.3 asserts those rights. There
is no recorded consent for this project. The value sent by
`src/lib/statsfm-client.ts` is therefore:

```
spotify-mcp (+https://github.com/NovaLux12/spotify-mcp-server)
```

That is this project's own name plus a contact URL, per the convention in
RFC 9110 §10.1.5 for a user agent that has nobody to complain to otherwise. It
carries no third-party product token. An earlier value, `spotify-mcp/statsfm`,
advertised a third party's name on every outbound request and also misdescribed
the client: the caller is this server, not stats.fm.

Naming the upstream service buys nothing operationally — stats.fm's own
response headers are on every reply regardless — and it costs a term. There is
no version suffix, because reading `package.json` for one means a relative path
that is correct from `src/lib/` and wrong from `dist/lib/`, and a user agent
that throws because a path is off by one directory is worse than one without a
version.

The guard asserts the shape, not just the absence: any `user-agent` value
under `src/` must match `product-name (+https://contact-url)`, and must not
contain a third-party service token.

## Naming decision (2026-09-18)

This project is called **SpotifyMCP** in the README heading, "Spotify MCP" in
`server.json`'s `title`, and `@novalux12/spotify-mcp` on npm. The name begins
with "Spot". Spotify's Developer Policy Sec. VI.2 says of an SDA's name: *"the
name should not begin with 'Spot' or be confusing in sound or spelling to
Spotify. Unless you have applicable permissions, don't imply any endorsement,
tie-in, co-branding or promotion by Spotify."* Developer Terms Sec. IV.2.c.ii
lists "using Spotify Marks as part of the name of your company or service"
among breaches, and Sec. IX.7 forbids suggesting endorsement.

That is a real exposure and it is not a misreading. It is recorded here with
its reasoning and its date so that the next maintainer inherits a decision
rather than an accident.

**Option A — rename.** Move to a neutral product name and carry "for Spotify"
as a descriptor, so the name itself is clean and only the description names the
platform. It is the option that removes the exposure. It is not a rename of a
string: it touches `README.md`, `SPEC.md`, `ARCHITECTURE.md`, `CLAUDE.md`,
every `docs/` page, both `skills/*/SKILL.md`, `server.json`'s `title`, and
`package.json` — plus every place a user, a directory, a blog post or a
support answer has already recorded the old name, which is not in the
repository and does not update when a file does.

**Option B — keep the name, accept the risk.** Ship v2 under the current name
and make the non-affiliation disclosure unconditional, so the residual risk is
"a third-party project whose name resembles the platform it integrates" rather
than "a project that could be mistaken for an official integration".

**Decision: Option B, for v2. Decided 2026-09-18.**

The reasoning, in the order it actually mattered:

1. **Option A's cost is concentrated in exactly the places nobody updates.**
   The repository is the cheap part, and it is not the expensive part: the
   published npm name, the MCP Registry entry, the installation instructions
   already pasted into other people's configuration files, and the ecosystem's
   memory of this project are the expensive part, and none of them update when
   a file does. A rename resolves the ambiguity for a reader who has *not* met
   the project and does nothing for one who has, who is left holding an npm
   install that no longer matches the name in their host config.
2. **The exposure is about implication, not about the literal.** Sec. VI.2's
   operative clause is *"unless you have applicable permissions, don't imply
   any endorsement, tie-in, co-branding or promotion"*. A name that resembles
   the platform is the weak half of that test; the strong half is whether a
   reader can be left thinking Spotify ships, reviews, or blesses this. Option
   B can neutralise the strong half completely, on every surface, forever.
3. **The "for Spotify" form was not obviously better.** A neutral name plus a
   "for Spotify" descriptor still says "Spotify" in the same position a
   browser tab reads it, and trades a name Spotify's policy names for one it
   does not — an argument about which rule we are not breaching, not about
   whether anyone is misled.

**What is accepted, stated plainly.** The name *does* begin with "Spot", which
is what Policy Sec. VI.2 asks it not to; that exposure is accepted knowingly and
is not mitigated by argument. It is not a Spotify mark, and it is used
nominatively to describe the platform integrated. `server.json`'s `name`
(`io.github.NovaLux12/spotify-mcp-server`) and the npm scope
(`@novalux12/spotify-mcp`) stay: those are machine identifiers, not display
names, and the fully-qualified npm name begins with the scope rather than with
"Spot". No Spotify wordmark, logo, or brand element is used — see above, and
`tests/third-party-marks-guard.test.ts`.

**What makes this decision defensible is the compensating control, not the
argument.** If the notice below is ever absent from a surface, this page is
wrong and the decision should be reopened. The notice is the load-bearing
part of Option B, which is why it is a single exported constant, why the
surfaces that must carry it are enumerated, and why
`tests/branding-notice-guard.test.ts` fails when one drops it.

**Re-check trigger.** Re-evaluate the name against the current text of Policy
Sec. VI.2 **before** any of the following goes live:

- the app is listed in an MCP directory, marketplace, or registry beyond the
  canonical `server.json` entry;
- the app is promoted, sponsored, featured, or otherwise distributed by a third
  party;
- a paid tier, Sponsorship, or Verified Partner conversation with Spotify
  starts — that conversation can supply the *"applicable permissions"* Sec.
  VI.2 carves out, and it changes the analysis entirely;
- Spotify publishes a change to Sec. VI.2 or to the Branding Guidelines that
  names this pattern explicitly.

An ordinary release is not a trigger; a new distribution channel is. The
checklist in [`docs/distribution.md`](distribution.md#claim-checklist) carries
the same trigger at the point where someone is about to add a channel.

## The non-affiliation notice

The wording lives in exactly one place, `src/branding.ts`, and every surface
reads it from there:

| Constant | Text | Where it is used |
|---|---|---|
| `NON_AFFILIATION_NOTICE` | `Independent, unofficial project. Not affiliated with, endorsed by, or sponsored by Spotify.` | The `spotify-mcp doctor` CLI banner on its own; the first sentence of `BRANDING_NOTICE` everywhere else |
| `TRADEMARK_NOTICE` | `"Spotify" is a trademark of Spotify AB; this project is not a Spotify product.` | Folded into `BRANDING_NOTICE` — no surface carries it alone |
| `BRANDING_NOTICE` | the two sentences joined | The MCP `initialize` `instructions` string, the `--help` banner, and the `spotify_doctor` prose header |
| `SHORT_NON_AFFILIATION_NOTICE` | `Not affiliated with Spotify.` | The 100-character-capped metadata surfaces, via `CANONICAL_DESCRIPTION` |

**Why there are two forms, and why that is not drift.** The MCP Registry caps
`ServerDetail.description` at 100 characters (`maxLength` in the `$schema`
pinned by `server.json`), and five surfaces have to fit that budget: the
`server.json` description, the `package.json` description, the README
one-liner, and both blurbs in `docs/distribution.md`. They are all filled from
one sentence, `CANONICAL_DESCRIPTION` in `tests/registry-meta.test.ts` (#655),
whose tail is `SHORT_NON_AFFILIATION_NOTICE`. The cap is the only reason the
short form exists; every surface with room carries the long form.

The two are tied together from both sides so they cannot quietly diverge:
`tests/registry-meta.test.ts` fails if the canonical sentence stops ending with
the short form, and `tests/branding-notice-guard.test.ts` fails if any shipped
description stops ending with it, or if the long form stops opening by denying
official status and stops denying endorsement and sponsorship. Shortening the
long form to the short form's claim is a change, not a wording tweak.

**The surfaces the notice must reach**, and why each one is on the list:

| Surface | Form | Why it is one |
|---|---|---|
| `README.md` H1 one-liner | short | First thing a reader sees; above the fold, and paired with the Developer Terms link in the footer |
| `package.json` `description` | short | What npm renders on the package page |
| `server.json` `description` | short | What the MCP Registry renders to every host that browses it |
| `docs/distribution.md` blurbs | short | The copy a directory listing or marketplace card is pasted from |
| MCP `initialize` `instructions` | long | **The only surface a host-only agent sees.** An OpenClaw session with no shell, no repository and no README gets the tool list and this string and nothing else |
| `spotify-mcp --help` | long | What a user reads when deciding whether this is an official integration |
| `spotify-mcp doctor` banner | long | The output users paste into bug threads and issue reports |
| `spotify_doctor` prose header | long | The agent-facing identity line, rendered by the same function the CLI uses so the two cannot disagree |
| `NOTICE`, `CONTRIBUTING.md`, `PRIVACY.md`, `END_USER_AGREEMENT.md` | prose | Legal/provenance surfaces, worded for those documents rather than for a first-glance reader; each already says it |

**Deliberately not carrying the notice**, so a future maintainer does not read
the absence as an oversight:

- `SECURITY.md` and `CODE_OF_CONDUCT.md` are GitHub-only surfaces reached by
  someone who is already in the repository. They are a candidate for a future
  pass, not a gap in this one.
- `--version` prints exactly one machine-readable line, asserted byte-exact by
  `tests/index-cli.test.ts`. Adding a sentence to it would break every script
  that parses it. A version string is not a place a reader forms an impression
  of the project.
- The one hosted directory this repository once shipped a manifest for is not a
  surface to add a notice to. That manifest was retired deliberately in #710,
  `tests/distribution-channel-guard.test.ts` fails if it comes back, and the
  recorded posture is in [`docs/distribution.md`](distribution.md). A
  non-affiliation notice is not a reason to resurrect a retired channel.

**How this is enforced.** `tests/branding-notice-guard.test.ts` spawns the real
server over stdio and reads the `initialize` response's `instructions` back,
so it fails if `src/index.ts` stops passing the constant — not merely if a
document stops containing the words. The same file renders the doctor prose,
invokes `--help` and the CLI doctor, and compares every metadata and document
surface against the exported constants.

## Derived listening analytics: the policy and the interpretation

*Added for [#695](https://github.com/NovaLux12/spotify-mcp-server/issues/695).
This section states a rule the Server follows, the interpretation it relies on,
and where the line between the two was drawn.*

### The rule, quoted

Spotify's
[Developer Policy](https://developer.spotify.com/policy), **Sec. III
"Some prohibited applications", item 13**, retrieved 2026-09-27:

> Do not analyze the Spotify Content or the Spotify Service for any purpose,
> including without limitation, creating new or derived listenership metrics,
> benchmarking, functionality, usage statistics, user metrics, or building
> profiles of users, including for the purpose of targeting them with
> advertising or marketing.

The clause the issue that prompted this section was written against is the
tail of that sentence. The sentence does not only forbid profiling *other*
people for advertising: it opens with "for any purpose", and the list that
follows names derived listenership metrics on its own. Read literally, it
reaches a local computation over one person's own history.

### The interpretation the project relies on

This project reads Sec. III.13 as aimed at **analysis that produces a metric
about someone for someone else's purpose** — a score, segment, benchmark or
profile that a party other than the listener uses, most obviously to target
them. Under that reading, a personal client computing a summary of the
authenticated user's own `/me/top/*` and `/me/player/recently-played` responses
and showing the result to that same user is not what the clause describes.

**That reading is arguable, and it has not been adjudicated by anyone but
this project.** It is recorded here rather than asserted as settled, and the
gate below is the acknowledgement that it might be wrong. Specifically, the
project relies on four properties holding, and each of them is a fact about the
implementation rather than about the policy:

1. **The inputs are the account's own.** Every one of the withheld tools reads
   `/me/top/*` and `/me/player/recently-played` — endpoints Spotify scopes to
   the token holder. No third party's listening data is available to this
   server, so no cross-user metric can be built from it.
2. **The computation is local and in-process.** Scores and histograms are
   computed in the server process from data it just fetched. Nothing derived is
   transmitted anywhere, and no derived value is sent to a third party.
3. **No profile is persisted.** The tools return a value for the call and
   compute nothing that outlives it. There is no derived-metrics store on disk,
   so there is no user profile to accumulate. (The local sidecars that do exist
   — mutation history, receipts, search history, taste feedback — record
   *actions and calls*, not listening metrics, and are documented separately in
   [`PRIVACY.md`](../PRIVACY.md).)
4. **The output goes to the listener.** There is no multi-tenant deployment
   mode, no export-of-users feature, and no benchmarking of one account against
   another. The audience for every one of these payloads is the person whose
   data produced it.

If any of those four stopped being true, the interpretation would stop applying
and the correct response would be removal rather than opt-in.

### Where the line was drawn, and the gate

The line is drawn on the **output**, not on the module or on the data source.
A tool is withheld when what it returns is a *derived* metric — a histogram, a
bucket, a ratio, a score, or a behavioural profile. A tool that re-presents what
Spotify itself returned is not withheld, however much it reformats it, because
it adds no measurement that was not already in the API's answer.

**The eleven withheld tools** register only when
`SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS` is set, and are otherwise absent from
`tools/list`:

| Tool | Module | What it derives |
|---|---|---|
| `discovery_ratio` | `swarm3_analytics.ts` | Share of recently-played tracks absent from your top tracks |
| `listening_clock` | `swarm3_analytics.ts` | 24-bucket hour-of-day histogram, daypart totals, peak and quietest hour |
| `listening_clock_heatmap` | `swarm3_analytics.ts` | Weekday × hour heatmap with a peak cell |
| `artist_listening_clock` | `swarm3_analytics.ts` | Hour-of-day profile for one artist |
| `mood_bucket_report` | `swarm3_analytics.ts` | Daypart × familiarity segmentation |
| `weekday_listening_report` | `swarm3_analytics.ts` | Per-weekday plays, unique tracks/artists, busiest day |
| `weekly_rotation_report` | `swarm3_analytics.ts` | Day-by-day rotation and first-heard-this-window tracks |
| `binge_detector_report` | `swarm3_analytics.ts` | Artists exceeding a repeat-play threshold, ranked by intensity |
| `listening_recap_brief` | `swarm3_analytics.ts` | Composite of peak hour, busiest weekday and discovery ratio |
| `listening_report` | `analytics.ts` | Era histogram, discovery ratio, repeat overlap, hour-of-day buckets |
| `listening_heatmap` | `libraryanalytics.ts` | 168 hourly slots with peak and least hour |

**What stays registered** is everything that re-presents Spotify's own answer.
`get_top_tracks`, `get_top_artists` and `get_recently_played` were never in
scope — they live outside the three modules the gate is applied to, and they are
named here because they are the ungated re-presentation of the same data. The
rest are the tools those three modules still register:
`top_artists_by_range`, `taste_shift_report`,
`listening_streaks`, `top_artist_ranking_delta`, `top_track_ranking_delta`,
`top_artist_leaderboard`, `top_track_leaderboard`, `artist_velocity_report`,
`track_rotation_report`, `repeat_listener_report`, `listening_streak_report`,
`top_genre_census`, `deep_dive_report`, `session_length_report`,
`listening_gaps_report`, `listening_consistency_score`,
`era_preference_report`, `listening_history_export`,
`library_coverage_report`, `library_growth_report` and
`genre_trends_over_time`.

That split is a judgement, and two of its edges are worth naming rather than
burying. `era_preference_report` is **not** withheld even though it compares a
decade mix: it answers "of what you have been playing, which eras appear", with
no population to compare you against. `listening_history_export` is **not**
withheld because it is the raw ordered history, which is what an operator needs
in order to compute the withheld figures locally and decide for themselves —
that is the alternative path the issue raised, and shipping it ungated is what
makes that path real.

### Why the default is off, and what "off" means

Sec. III.13 is arguable, and an arguable rule is not a licence to pick the
permissive reading silently. If the interpretation above is wrong, the exposure
is worst for the people who never considered the question — and that is
everyone who installs the package and sets nothing. So **the default is the
non-analytics path for every operator who has not made the decision
explicitly.** The tools that could expose the project to Sec. III.13 are the
ones a user must ask for by name, with the flag, having read this section.

"Off" means the eleven tools are **not registered at all**. That is a
deliberate choice over the alternative of registering them and returning an
empty payload, which would be the worse of the two: a caller would read "no
listening at 3am" out of a gate that is actually switched off, and this
project's own rule — *if a lookup fails, say so, and never guess* — applies to
a disabled lookup as much as to a failed one. An absent tool cannot be
misread as an answer. The cost is that `tools/list` does not advertise the
capability, so the server says so on stderr at startup, in the
`spotify-mcp doctor` configuration block, and in the `surface` row of
`spotify_doctor` (`derived_analytics=false`).

An unrecognised value for the flag — anything that is not `1`, `true`, `yes` or
`on` — leaves the analytics **off** and prints a warning naming the accepted
spellings. It never reads as true, and it never fails the startup: the default
is already the safe path, and taking a working host offline over a typo in an
opt-in flag would be a worse failure than the one it prevents.

### How this is enforced

- `src/derivedanalytics.ts` holds the withheld-name list and the gate, and its
  header states the rule, the interpretation and why the list is safe to keep
  by hand.
- `tests/derived-analytics-gate.test.ts` asserts the classification is **total
  and disjoint** — every tool the three modules register with the opt-in on must
  be either withheld or named as retained, so a new derived tool cannot ship
  registered by default without a decision being recorded.
- `tests/analytics-optin-registry.test.ts` drives the real server over stdio
  with the flag unset, `1`, and a value naming no boolean, and checks what
  reaches `tools/list` in each case.
- `scripts/surface-census.mjs` **measures** the withheld set — it registers
  every module twice and diffs the two name sets — rather than reading it from
  a list, so the documentation gate and the registry pin cannot drift from the
  source of truth.
- `docs/configuration.md` carries the operator-facing form of all of this.

## Provenance

`NOTICE` records that this project is an independent implementation, and that
Spotify Content, the Spotify Platform, and Spotify marks are not licensed by
it and remain subject to
[Spotify's own terms](https://developer.spotify.com/terms) and the
[third-party notices](https://developer.spotify.com/third-party-licenses).
That statement is why the marks are absent from the repository and why they
must stay absent.

---

Quotations above are from <https://developer.spotify.com/branding-guidelines>,
<https://developer.spotify.com/terms> and
<https://developer.spotify.com/policy>, retrieved 2026-09-27. Those pages
change without notice; if a rule here stops matching them, the page is stale,
not the rule.
