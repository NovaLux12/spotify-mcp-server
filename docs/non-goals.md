# v2 non-goals

What this server has decided **not** to do, why, and what it offers instead.

The one-line version lives in [SPEC.md §1](../SPEC.md#1-goals--non-goals) and is
mirrored in the [README](../README.md#what-this-server-is-not). This file is the
decision record behind those lines: what each non-goal covers, the evidence it
rests on, and the alternative a reader who wanted the feature should reach for
instead. A proposal that contradicts one of these needs a decision recorded
here, not a pull request that quietly re-opens it.

**Renames live elsewhere.** This file records *decisions* — what was declined,
impossible or prohibited, and why. The names 3.0 retired, what replaced each
one, and the one operation with **no** replacement at all are catalogued in
[docs/migration-v3.md](migration-v3.md), whose tables are generated from the
runtime constants so a rename and the error a caller hits cannot disagree. A
reader looking for "what do I send instead" wants that page; a reader looking
for "why was this never built" wants this one.

**How to read an entry.** A non-goal is *impossible* — Spotify or the MCP
specification does not offer it — *declined* — it is available and this project
chose not to ship it — or *prohibited*, where a term of service is the reason
and the repository already promises the same thing in its own agreement. The
"Why" line says which, and the "Sources" line names the file, issue or URL it
rests on rather than restating the claim as an assertion. Every entry names an
alternative: a non-goal with nothing on the other side of it is a dead end for
the reader who wanted it.

**What this file deliberately does not contain.** No tool counts, no payload
byte figures, no line numbers. Those are measurements, they are generated, and
`tests/non-goals.test.ts` fails if one is typed into prose here — it is the test
that holds this line for the one page that carries no generated block, while
`tests/doc-figures.test.ts` holds it for the pages that do. Where a size or a
count matters to a decision, this document points at the generated table that
carries it.

## Still open, deliberately not decided here

Two questions this document touches are owned by other issues, and a reader
should not read a decision into their absence:

- **Default registration of the stats.fm families.**
  [#607](https://github.com/NovaLux12/spotify-mcp-server/issues/607) owns it. The
  non-goal below is a *second* upstream, not stats.fm, which is disclosed today.
- **Multiple accounts on one machine.**
  [#602](https://github.com/NovaLux12/spotify-mcp-server/issues/602) owns it. The
  non-goal below is *shared identity across users*, not running your own two
  accounts in two profiles.

---

### Audio streaming, audio analysis, and offline playback

**Not.** No tool returns audio bytes, and none calls the audio-features or
audio-analysis endpoints. No cache of audio is kept, so there is no offline
playback: starting playback always needs a live device and a live call.

**Why.** *Impossible.* The Web API serves catalog, library and player metadata,
not audio, and the analysis endpoints belong to a class this project has never
wrapped: `AGENTS.md` §2 records them as blocked for post-November 2024 app
registrations,
[CONTRIBUTING.md](../CONTRIBUTING.md#scope-policy-no-new-wrappers-for-removed-or-gated-endpoints)
lists them under "no shipped tool calls these paths", and the README's
registration-gated table — generated from `GATED_FAMILIES` — contains neither.
Absence of a tool is the honest answer: there is no request to make and no 403
to explain.

**Instead.** Metadata and control: `play_on` and the rest of the playback family
drive a real device, and the listening reports are computed from the account's
own play history. A persistent offline *read* layer is a roadmap candidate, not
a non-goal — see [#578](https://github.com/NovaLux12/spotify-mcp-server/issues/578)
roadmap item 6 — so do not read this entry as a rejection of it.

**Sources.** `AGENTS.md` §2 (the curated record of blocked and removed
endpoints); `CONTRIBUTING.md` § "Scope policy"; `src/gating.ts`; the
registration-gated table in `README.md`, which is generated from that array.

---

### A web UI, a dashboard, or an MCP UI surface

**Not.** No HTML surface, no bundled asset server, no MCP UI/App resources, and
no server-rendered page. Nothing listens on a port to serve a UI.

**Why.** *Declined.* The server is a local child process: the only transport it
builds is a stdio one, and no listener exists to serve anything. (The one port
it ever opens is the loopback OAuth callback during `auth`, which takes one
redirect and closes.) Every registered resource URI is a `spotify://` read path,
so there is no UI resource surface either. Building a UI would turn a local
process into a network service and pull in the hosting question this project has
declined separately.

**Instead.** `spotify_doctor` diagnoses the server from the CLI and from inside a
session; MCP resources are the zero-tool-call read path (`spotify://me/top/tracks`
and the rest of that family); and every tool result carries a structured payload
a host can render however it likes. Anything a dashboard would show is reachable
through a tool or a resource today.

**Sources.** `src/index.ts` (the stdio transport construction);
`npm run count:tools`, whose census output lists the resource URIs and would
name a UI resource if one existed.

---

### Multi-tenant or hosted operation

**Not.** One server process serves one user's credentials. This is not a hosted
service: no operator runs it for other people, there is no per-caller identity,
no account pooling, and no billing, quota or tenancy surface.

**Why.** *Declined, and load-bearing.* The OAuth redirect URI must resolve to a
loopback host — `src/auth.ts` throws on anything else when the redirect is
resolved — so a hosted deployment cannot complete a login without a design this
project has not built. Tokens live in one per-process file, and the transport
added by
[#599](https://github.com/NovaLux12/spotify-mcp-server/issues/599) is scoped as
single-user by design, explicitly so that it does not land against this entry.

**Instead.** A user who needs several accounts runs one process per account, via
`--profile` or `SPOTIFY_MCP_PROFILE`. Remote *access* to your own single account
is a separate question, and [#599](https://github.com/NovaLux12/spotify-mcp-server/issues/599)
now ships an answer to it: an opt-in Streamable HTTP transport
(`SPOTIFY_MCP_TRANSPORT=http`) with a pre-provisioned bearer token, loopback by
default. That is *access*, not *tenancy* — one user, one process, one account,
one token, and no per-caller identity anywhere in the design. What it does not
do is the thing this entry rules out: there is no account pooling, no per-caller
authorization, and no way for one deployment to serve several people. The
resource-server OAuth design that would be needed for that remains unbuilt, and
the loopback redirect check above is still the reason a hosted process cannot
finish a Spotify login on its own.

**Sources.** `src/auth.ts` (the loopback redirect check); `src/http.ts` (the
per-session `McpServer` and `SpotifyClient`, and the single shared bearer token
every session authenticates with); the threat model in
[`docs/configuration.md`](configuration.md) § "Streamable HTTP transport
(opt-in)", which names multi-user hosting as out of scope.

---

### Sharing one user's credentials across users

**Not.** The server never brokers, pools, forwards or accepts a caller's
Spotify credentials. There is no mode in which one process holds tokens for more
than the account it authenticated, and no way for a caller to pass a token in.

**Why.** *Declined.* This is the credential half of the hosting entry above, and
it is the one that matters for a shared deployment: a server that can hold
several people's tokens cannot answer "whose library did this call touch?". The
multi-account work on the roadmap
([#602](https://github.com/NovaLux12/spotify-mcp-server/issues/602)) is scoped to
one process, one acting account at a time, with the acting account reported back
— it is not an identity pool, and reading it as one would be a scope change.

**Instead.** Profiles, as above. The client secret is never used or requested:
the flow is Authorization Code with PKCE, so a Client ID is the only credential
involved, and the [privacy notice](../PRIVACY.md) describes what is stored and
where.

**Sources.** `src/auth.ts` (PKCE flow, per-profile token paths);
[PRIVACY.md](../PRIVACY.md#local-stores-and-paths) § "Local stores and paths"; the scope statement in
[#602](https://github.com/NovaLux12/spotify-mcp-server/issues/602).

---

### Lyrics

**Not.** No tool retrieves, stores or returns lyrics.

**Why.** *Impossible.* Spotify's public API has no lyrics endpoint, so there is
nothing to call. The shipped search tool for remembered phrases carries the same
disclosure in its own description, so an agent that asks is told at the point of
use rather than after a failed call.

**Instead.** `lyric_snippet_search` finds candidate tracks from a remembered
phrase or a title fragment, and ranks exact title matches first. It matches
against track metadata, which is what the API exposes.

**Sources.** `AGENTS.md` §2 ("Lyrics endpoints — not available via the Web API");
the production description of `lyric_snippet_search`.

---

### The Spotify Connect SDK and native client integration

**Not.** No Connect control, no device enrolment or management beyond what the
Web API exposes, and no native module. This is not a replacement for a Spotify
client.

**Why.** *Impossible.* The Web API is the only surface this server speaks. No
tool calls a Connect control path, and there is no Spotify SDK in the dependency
list — the server makes Web API calls, so the SDK it depends on is the MCP one.

**Instead.** The device-aware playback family does what the Web API does expose:
`get_devices` and `compare_devices` read what is available, `transfer_playback`
moves playback between them — one tool for the whole family since #848, with
`switch_device` and `handoff` forwarding to it rather than registered beside it
(#848) — and `play_on` starts it.

**Sources.** `src/index.ts` and the tool modules — no Connect path is called;
`package.json` (the only runtime dependencies are the MCP SDK, `open` and `zod`).

---

### Voice control

**Not.** No voice interface, no audio input path, and no speech or transcription
feature. A request arrives as a JSON-RPC call or a host prompt, and nothing in
the tool surface accepts audio.

**Why.** *Declined.* Capturing and transcribing audio is a different product with
a different consent surface, and it is not something a local stdio process can
offer without becoming the thing it currently is not. This entry records a
project decision, not a platform limitation: the roadmap raised it as an explicit
non-goal to write down, and this is that line.

**Instead.** The host's own voice layer, if it has one, transcribes and then calls
this server with ordinary text. Nothing here needs to change for that to work.

**Sources.** The explicit non-goals item in
[#578](https://github.com/NovaLux12/spotify-mcp-server/issues/578) (roadmap item
12). This project has not independently verified the Developer Policy section
that issue cites, so no section number is restated here; the code claim — no
audio input path — is verifiable in `src/`.

---

### Training a model on Spotify data, or exporting derived profiles

**Not.** No training, fine-tuning, embedding index, model artifact or evaluation
benchmark is built from Spotify content. No derived listening profile leaves the
machine, and none is sold, shared or published.

**Why.** *Prohibited, and already promised.* The project's
[End User Agreement](../END_USER_AGREEMENT.md) states the rule in the Terms'
vocabulary: you must not use the Spotify Platform or Spotify Content to train a
machine-learning or AI model, ingest Spotify Content into one, or create
unrelated user/listener profiles, advertising audiences, benchmarks, or derived
listenership metrics. `AGENTS.md` §1 carries the short form of the same rule
("do not use the API to train machine learning models on Spotify data") and links
the Terms. So this entry records a commitment the repository already makes, not
a constraint invented here.

**Instead.** On-device reporting over your own history, and a local read cache.
The reports are computed in your process from your data and stay there; what is
stored, where, and for how long is in
[PRIVACY.md](../PRIVACY.md#local-stores-and-paths) § "Local stores and paths". Note the limit of that
promise: a host that forwards tool results to a model provider is making that
choice under its own policy, and the privacy notice says so rather than claiming
control it does not have.

**Sources.** [END_USER_AGREEMENT.md](../END_USER_AGREEMENT.md) (the clause
quoted above); Spotify's
[Developer Terms](https://developer.spotify.com/terms) as linked from
`AGENTS.md` §1;
[PRIVACY.md](../PRIVACY.md#security-and-content-limits) § "Security and content limits"
and § "How Spotify data reaches an LLM or agent".

---

### A second third-party upstream, ad-tech, or monetization egress

**Not.** stats.fm is the only non-Spotify API this server calls. There is no
telemetry, no analytics SDK, no advertising or data-broker transfer, and no
route by which Spotify content reaches a third party for any purpose beyond the
stats.fm reads the user asked for.

**Why.** *Declined, on a rule that is easy to state and easy to erode.* Every new
upstream is a new recipient that has to be disclosed before it ships, not after.
The privacy notice already names its recipients and closes the door on the rest
explicitly; the compliance page keeps a third party's name out of the outbound
request so the server never announces a service relationship it does not have.

**Instead.** The stats.fm tools, documented in
[docs/statsfm.md](statsfm.md) and disclosed in
[PRIVACY.md](../PRIVACY.md#network-recipients-and-transfers) § "stats.fm (third party)" — including that the tools
send a stats.fm identifier and query parameters, and never a Spotify token or a
Spotify response body. A genuinely new upstream is a
[PRIVACY.md](../PRIVACY.md) and [docs/compliance.md](compliance.md) change first
and a code change second, not the other way round.

**Sources.** [PRIVACY.md](../PRIVACY.md#network-recipients-and-transfers) § "Network recipients and transfers";
[docs/compliance.md](compliance.md) § "Outbound `User-Agent`".

---

### Working around Spotify's own controls

**Not.** No stream ripping or audio capture, no circumvention of quota, regional
or access controls, and no attempt to make a denied endpoint answer. The server
does not stand in for a client's access controls.

**Why.** *Prohibited, and already the shipped behaviour for the cases that
exist.* A registration-gated endpoint answers 403 on that registration whatever
the user does, so the only choices are to explain it or to work around it. This
project chose to explain it, and that choice is load-bearing across the surface:
the wrappers stay registered, read a documented replacement where one exists,
and return a plain-English reason instead of a raw error.

**Instead.** The plain-English 403, the generated
[registration-gated table](../README.md#registration-gated-endpoints) showing
which families are affected and why, `spotify_doctor` for the state of your own
registration, and — where a replacement exists — the tool that reads it. A
regional limit is stated up front rather than discovered: audiobooks are gated by
Spotify to a named set of countries, and the README says so.

**Sources.** [PRIVACY.md](../PRIVACY.md#security-and-content-limits) § "Security and content limits";
[CONTRIBUTING.md](../CONTRIBUTING.md#scope-policy-no-new-wrappers-for-removed-or-gated-endpoints);
`AGENTS.md` §2; `src/gating.ts`, which is the authoritative classifier and the
source of the generated README table.

---

## Maintaining this list

- A scope question is answered here or in
  [SPEC.md §1](../SPEC.md#1-goals--non-goals), not in an issue thread. An issue
  records that a question was asked; this file records the answer.
- Every entry keeps three parts — what is not done, why, and what is offered
  instead. Dropping the third part is a regression: it turns a decision into a
  dead end.
- Where the "Why" is *impossible*, re-check the source before editing the claim.
  Spotify has removed endpoint families within months of this repository last
  calling one operational, so an "impossible" line is a dated fact and needs its
  citation as much as a code comment does.
- `tests/non-goals.test.ts` asserts that the SPEC §1 list and the README's list
  are this file's headings, exactly and in both directions, that every entry
  keeps all four parts, that both index pages link here, and that no figure has
  been typed into the prose.
