---
name: "spotify-mcp-competitor-comparison"
description: "Answer \"is our MCP standard/conformant\" or \"do others offer more\" questions with in-repo protocol evidence, then web research"
---

# Spotify MCP Competitor Comparison

Answer "is our MCP really standard / do others offer more" or "are we better
than X" questions with current in-repo and live-protocol evidence first, then
web research. Never assert conformance or inventory from memory.

<!-- BEGIN:generated surface-census -->
Current default production baseline: **610 tools**, **16 fixed resources**, **33 resource templates**, and **14 prompts**. Regenerate with `npm run count:tools -- --write`; never substitute historical prose.
<!-- END:generated surface-census -->

## Steps

1. Establish the current protocol surface.
   - Read `package.json` for the MCP SDK dependency and the scripts/entry
     surface; read `src/index.ts` for the actual transport and tool/resource/
     prompt registration gates.
   - Treat `SPEC.md` as design/history, not a count source. Static registration
     searches miss factories, inline registrations, scope gates, and toolset
     trimming.
   - Connect to the current server and record the live results of
     `tools/list`, `resources/list`, `resources/templates/list`, and
     `prompts/list`. For tools, `toolset_report.structuredContent`
     exposes `registered_tools`, `active_toolsets`, and `active_modules`.
   - Cite `tests/mcp.smoke.test.ts`: it starts the real stdio entry and
     exchanges newline-delimited JSON-RPC for initialize and primitive lists.
   - Criterion: every count and primitive claim names the live request or
     source file inspected for this comparison. Never copy a count from
     `CHANGELOG.md`, `SPEC.md`, or an earlier answer.

2. Re-audit optional or unsupported protocol features from current source.
   Put the proof beside every claim:

   | Claim | Current proof to inspect |
   |---|---|
   | stdio transport | `src/index.ts` imports and connects `StdioServerTransport`; no HTTP/SSE server entry is wired there |
   | OAuth is Authorization Code + PKCE, not server-side dynamic client registration | `src/auth.ts` builds an authorization request with `code_challenge_method=S256` and exchanges `authorization_code` plus `code_verifier` |
   | resource argument completion is present | `src/resources/templates.ts` attaches `complete.id` to the bare `spotify://show/{id}` and `spotify://episode/{id}` templates; `tests/resources.templates.test.ts` exercises their suggesters |
   | no roots/sampling feature is exposed | Search `src/` for roots and sampling handlers and confirm no implementation; describe these as client capabilities that this server does not consume, not as a conformance failure |

   For completion, verify the protocol path rather than inferring it from
   template registration. With a connected MCP client, call `client.complete`
   using a `ref/resource` URI of `spotify://show/{id}` or
   `spotify://episode/{id}`, argument name `id`, and an empty value. The
   suggesters read the first saved-library IDs from `/me/shows` or
   `/me/episodes` (up to ten); an unavailable library or failed request returns
   an empty list. The query-string twins do not carry completion callbacks.
   Do not claim completion for the artist, album, track, or playlist templates.

   Criterion: absent optional features are labeled optional differences, and
   every remaining claim has a named file, live request, or source search. A
   missing optional feature is not a protocol-conformance failure.

3. Survey the landscape with `web_search`.
   - Query patterns: "<author> spotify-mcp npm tools", "most popular spotify
     mcp server stars", and "<repo> spotify mcp".
   - Tabulate each competitor's documented tool count or scope from current
     search results, primary docs, or its repository. Do not turn a historical
     snippet into a current count.
   - Check whether Spotify publishes an official MCP server before claiming
     absence; if the evidence shows only community servers, say exactly that.
   - Criterion: every competitor row cites a current source plus a tool count
     or documented scope, and the official-server claim is verified.

4. Answer with evidence separated by capability and delivery mode.
   - Show live scale versus competitors in one table, with each row sourced.
   - Put hosted remotes and proxies (for example, the services verified in
     Step 3) in a delivery-mode section: no local install, but third-party
     token custody and a different tool surface.
   - State the useful caveat without overclaiming: community MCP servers vary
     widely, so protocol conformance and feature scale are separate questions.
   - Criterion: capability and delivery claims are in separate sections and
     both trace to Steps 1-3.
