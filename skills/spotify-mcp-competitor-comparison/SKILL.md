---
name: "spotify-mcp-competitor-comparison"
description: "Answer \"is our MCP standard/conformant\" or \"do others offer more\" questions with in-repo protocol evidence, then web research"
---

# Spotify MCP Competitor Comparison

Answer "is our MCP really standard / do others offer more" or "are we better than X" questions with in-repo evidence first, then web research. Never assert conformance from memory — the repo holds the proof.

## Steps

1. Verify protocol conformance in-repo before any web search.
   - Read SPEC.md §2 (Transport, Stack) and §4.0.2 (MCP server wiring) for SDK version, transport, and primitive registration.
   - Grep src/ for the primitive surface: `server.tool(` / `server.prompt(` / `server.resource(` counts, and `structuredContent`, progress-notification usage. `structuredContent` emission lives in src/shaping.ts plus tools like playlistmisc.ts, searchhistory.ts, queueops.ts.
   - Cite tests/mcp.smoke.test.ts: it spawns the real entry over stdio and speaks raw newline-delimited JSON-RPC (initialize / tools/list / prompts/list / resources/list), so protocol conformance is tested, not assumed.
   - Read current tool/prompt/resource counts from CHANGELOG or `grep -rn "server\.tool\|registerTool" src --include="*.ts" | wc -l` with typed-search factory correction (545 - 1 + 7 = 551) / live `tools/list` — they drift between releases (e.g., 551 tools as of v1.27.1 vs 550 in CHANGELOG at ee814a2); never hardcode counts from an older answer.
   - Criterion: every protocol claim (SDK, transport, primitive counts, spec features) is backed by a file/line you inspected this turn.

2. State optional spec features the server lacks as optional, not gaps.
   - Fixed checklist: stdio-only transport (no HTTP/SSE/Streamable), no server-side OAuth 2.0 dynamic client registration (PKCE CLI flow instead), no `completions/complete`, no roots/sampling.
   - Criterion: the answer lists gaps only from this checklist and marks each as an optional spec feature, not a conformance failure.

3. Survey the landscape with web_search.
   - Query patterns: "<author> spotify-mcp npm tools", "most popular spotify mcp server stars", "<repo> spotify mcp".
   - Tabulate each competitor's tool count or documented scope from search snippets/docs (e.g., SpotifyMCP2 docs state "eight tools").
   - Check whether an official Spotify-published MCP server exists before claiming absence; if you find only community servers, say so explicitly.
   - Criterion: every competitor row cites a source from search results plus a tool count or documented scope; the "official server exists?" claim is verified, not assumed.

4. Answer with an evidence table, capability separate from delivery mode.
   - Table: competitor scale vs ours, each row sourced.
   - Delivery-mode differences (hosted remotes like Zapier/Composio/@open-mcp proxies: no local install but fewer tools and third-party token custody) go in their own section, never conflated with capability.
   - Include the honest caveat: "standard in the wild" usually means small community servers; ours is conformant but atypical in scale.
   - Criterion: capability claims and delivery-mode claims appear in separate sections, both backed by steps 1-3.
