# The `spotify-mcp` CLI

Five subcommands beyond the server itself: `tools`, `call`, `watch`, `export`
and `init`. They exist because the questions they answer — *what does this
installation actually do under my environment?* — are answerable without a
model in the loop, and answering them any other way would be answering them
wrongly.

**The four session subcommands are MCP clients, not a second call path.**
`tools`, `call`, `watch` and `export` build *this* server through the same two
functions `startMcpServer` calls (`resolveServerScope` and `buildMcpServer`) and
speak to it over an in-memory transport. So:

- the surface `spotify-mcp tools` prints is the surface a host gets, after the
  toolset, read-only, granted-scope and opt-in gates — not a table in a
  document that drifts from the code;
- a `call` runs the same zod validation, the same closed input-schema boundary,
  the same `structuredContent.error` envelope and the same confirmation gates a
  host's call runs. A bug only a CLI caller could hit is a bug in the MCP path,
  which is where it belongs.

`init` is the exception: it needs no registry, so it opens none. Booting 500+
tools to answer a question about a config file would make the fastest command
the slowest.

## Exit codes

Every subcommand returns one of three, and the distinction is load-bearing:

| Code | Meaning |
|------|---------|
| `0` | The work ran and succeeded. |
| `1` | The work ran and **failed** — a refusal, a 403, a validation error, an export the tool would not write. The server's own `kind` / `reason` / `fix` are printed. |
| `2` | The **invocation** was wrong and nothing was sent to Spotify — a bad flag, malformed JSON, an unknown tool name, a missing client id, a profile name the server would refuse. |

"Your arguments are wrong" and "Spotify said no" are different mistakes, and a
script needs to tell them apart. A CLI path that swallows an error and exits 0
is a defect, not a convenience.

## `--profile` is read once, by the dispatcher

`--profile <name>` names the **account** — which token file the client loads —
so it means the same thing to `tools`, `call`, `watch` and `export`, and it is
lifted out of `argv` once, before the session is opened, rather than parsed four
times. Its value is validated by the same `activeProfile()` that
`spotify-mcp auth --profile` uses, so the two cannot disagree about what a legal
account name is; a name that would become a path (`../escape`, `..`) is refused
at exit 2 before the registry boots.

The token file itself comes from `getTokenFile()`, so the documented precedence
is the one in force:

```
SPOTIFY_MCP_TOKEN_FILE  >  --profile  >  SPOTIFY_MCP_PROFILE  >  the default file
```

An explicit `SPOTIFY_MCP_TOKEN_FILE` therefore outranks `--profile` here exactly
as it does in `auth`. That precedence is asserted, not described: a test reads
the client's own `tokenFile` back after a session is built each way, so a change
that quietly sent one account's token on a request meant for another would fail
rather than pass.

## `spotify-mcp tools`

Prints the tool surface this installation registers *right now*.

```console
$ spotify-mcp tools --filter now_playing
spotify-mcp tools — 1 of 128 registered
toolsets: core, resources, prompts

get_now_playing
    module     playback
    markers    read,idempotent
    quota      not declared in the description
```

| Flag | Effect |
|------|--------|
| `--json` | Emit the whole report as JSON |
| `--filter <text>` | Only tools whose name contains `<text>` (case-insensitive) |
| `--module <key>` | Only tools registered by one manifest module |
| `--profile <name>` | Act on a named account profile (see above) |
| `--help` | Usage |

Each row carries four facts, read from three different places on purpose:

- `read_only` / `destructive` / `idempotent` come from the tool's own
  `annotations` on the wire — this is what a host sees.
- `module` / `registration_key` come from the registrar manifest, not from the
  wire. There is no wire field for them and this command did not invent one; a
  tool that appears in `tools/list` with no manifest owner is reported as such
  rather than dropped, because an invisible tool is the failure this command
  exists to make visible.
- `quota` is the `Quota:` clause from the tool's live description. **A
  description that declares no quota sentence reports `null`, not `""`, `"none"`
  or `0`.** "This description declares no quota" and "this tool makes no
  quota'd calls" are different claims and only the first is knowable from a
  description. The same fact appears in `notes` so the text output is not the
  only place it is recorded.

The count is the number of rows `tools/list` actually returned. It is not a
manifest length and not a number typed into a document.

## `spotify-mcp call`

```console
$ spotify-mcp call get_playlist --args '{"playlist_id":"37i9dQZF1DXcBWIGoYBM5M"}'
```

| Flag | Effect |
|------|--------|
| `--args '<json>'` | Object of arguments, as a JSON string (default `{}`) |
| `--dry-run` | Set the tool's **own** `dry_run` parameter to true |
| `--json` | Emit the raw MCP result as JSON |

### `--dry-run` is a request, not a promise

Many tools take a `dry_run` parameter and many cannot. This command does **not**
inject `dry_run: true` into a tool that does not declare it and then report
success — an injected flag on a tool that ignores it would print a full
destructive run under a `--dry-run` banner. Instead it checks the tool's live
`inputSchema` first:

- declares `dry_run` → send `dry_run: true`;
- does not → **exit 2, before any request**, naming the tool and a read-only
  alternative where one is obvious.

### Confirmation gates still apply

The CLI advertises the MCP elicitation capability **only when stdin is a TTY**.
That is the property `src/tools/confirm.ts` reads, and it is why a scripted
`spotify-mcp call save_to_library …` takes the existing fail-closed refusal
rather than waving a destructive write through: nobody is there to answer, and
nothing advertises that someone could be.

There is deliberately **no `--yes` flag**. The only sanctioned bypass is
`SPOTIFY_MCP_CONFIRM=never`, which already works through the unchanged MCP path.
A second flag here would be a second mechanism that could drift from the first.

## `spotify-mcp watch`

Polls one surface and prints only what changed.

```console
$ spotify-mcp watch --tool get_now_playing --interval 5 --count 12
```

| Flag | Effect |
|------|--------|
| `--tool <name>` | Poll this tool (default `get_now_playing`) |
| `--resource <uri>` | Poll this `spotify://` resource instead — mutually exclusive with `--tool` |
| `--args '<json>'` | Arguments for the tool |
| `--interval <secs>` | Seconds between polls (default 5, minimum 1) |
| `--count <n>` | Stop after n polls; `0` (the default) runs until Ctrl-C |
| `--json` | One JSON object per poll, plus a summary object |
| `--tolerate-errors` | Keep polling after an error instead of stopping |
| `--profile <name>` | Act on a named account profile (see above) |

### What the ETag story actually is

Conditional requests are real and shipped — `GetOptions.onNotModified`, the
`ValidatorStore`, the `If-None-Match` header, 304-before-`!res.ok` handling —
but **no MCP resource uses them.** The only production call sites that do are
`get_now_playing` and `get_currently_playing`, and they report a revalidated
read as `unchanged: true` in `structuredContent` so a watch loop can branch on
it.

So the loop does two different things and says which, on every run:

- a **tool** target that publishes `unchanged` gets the real ETag path;
- a **resource** target has no ETag surface, so the loop compares the payload it
  got and says so.

`change_detection` is **measured across the polls that ran**, never assumed from
the target's name: `etag` (every poll carried the signal), `mixed` (some did) or
`payload-diff` (none did). A command that hard-coded `etag` for a resource URI
would report an ETag it never received.

### Output and failure

The first poll always prints — it is the baseline the diffs are against, and a
loop whose first output is silence has told the user nothing. After that a poll
prints only when the payload differs. `--json` emits one object per poll either
way, so a scripted consumer sees every poll and can tell a quiet poll from a
dead loop.

The client already retries 429 and 5xx internally with backoff and
`Retry-After`, so an error that reaches the loop has survived that. The first
error is printed in full and ends the run with **exit 1**.
`--tolerate-errors` keeps going and is the opt-in for a user who would rather sit
through a flaky network; the exit code stays 1 either way, because the flag
changes how long the run lasts, not whether a failure happened.

## `spotify-mcp export`

```console
$ spotify-mcp export --kind playlist --playlist 37i9dQZF1DXcBWIGoYBM5M --out road-trip.m3u
```

| Flag | Effect |
|------|--------|
| `--kind library` | Export the saved library (all five collections) |
| `--kind playlist` | Export **one** playlist, named by `--playlist` |
| `--out <path>` | Destination, relative to the configured output root |
| `--format <fmt>` | library: `json` (default) or `csv`; playlist: `m3u` (default) or `csv` |
| `--playlist <id>` | Required for `--kind playlist` |
| `--overwrite` | Replace an existing file (refused by default) |
| `--json` | Emit the tool's result as JSON |
| `--profile <name>` | Act on a named account profile (see above) |

`--kind playlists` is **refused** with an explanation. No tool exports every
playlist, and treating the plural as the singular would export a playlist the
user did not name.

### Output confinement is the tool's, not this command's

`--out` is passed straight through to `export_library_json` / `export_playlist`,
and each of those resolves and confines a caller-supplied destination to a
configured root — `~/.spotify-mcp/portability` for the library,
`~/.spotify-mcp/exports` for a playlist, unless
`SPOTIFY_MCP_PORTABILITY_DIR` / `SPOTIFY_MCP_EXPORT_DIR` move them. A path that
resolves outside the root fails here, with the tool's own message, at exit 1.
There is no second path-resolution implementation in the CLI that could be more
permissive than the one the MCP surface uses.

### Truncation is reported, never smoothed over

Both exporters walk with a cap and can come back truncated. The CLI surfaces
`truncated` / `fetch_truncated` / `cap_reached` on the success path, because an
export that silently wrote 500 of 9,000 tracks reads as a complete backup until
the day it is needed.

## `spotify-mcp init`

Writes a host configuration, with the token path and the default command
resolved from the same functions the server reads.

```console
$ spotify-mcp init --host openclaw --verify
```

| Flag | Effect |
|------|--------|
| `--host <name>` | `openclaw`, `generic` or `claude-code` |
| `--out <file>` | Where to write (default: the host's own path) |
| `--client-id <id>` | The client id to embed (default: `$SPOTIFY_CLIENT_ID`) |
| `--token-file <path>` | Token file to embed (default: the resolved one) |
| `--toolset <spec>` | Toolset to embed (default: the curated surface) |
| `--command <cmd>` | The command the config runs |
| `--verify` | Start this installation once with the written env and report |
| `--force` | Replace an existing entry |
| `--print` | Write to stdout instead of a file |

The variable is **`SPOTIFY_CLIENT_ID`**, with no `SPOTIFY_MCP_` prefix — the
deliberate exception to this project's own prefix convention, and a generated
config that got it wrong would fail on a name nothing else uses.

If no client id is available, `init` **fails with exit 2 and writes nothing**,
printing the configuration it would have written. It does not write
`"your_client_id_here"` into a file the user will launch: a config that starts
far enough to look right and then fails on the first call is worse than one that
refuses to be written.

### Merging, not clobbering

The `openclaw` target is the user's whole `openclaw.json`, not a fragment this
project owns. `init` reads it, sets `mcp.servers.spotify`, and writes it back
with every other key byte-identical. A file that exists and is not parseable JSON
is refused rather than replaced, and an existing `mcp.servers.spotify` is refused
without `--force`; `--force` says in its own output which entry it replaced.

### What `--verify` does and does not prove

It starts **this** installation's entry point as a child with the env block the
config carries and completes a real MCP `initialize` handshake. That proves the
variable names and the command line are right — the thing this command can get
wrong. It does **not** prove the published package resolves from npm, and it
touches no network: a host with no Spotify token still initializes, which is
correct.

## Related

- [docs/configuration.md](configuration.md) — every environment variable
- [docs/faq.md](faq.md) — auth, Premium, 403s, headless, tokens
- [docs/distribution.md](distribution.md) — hosting configuration by hand
