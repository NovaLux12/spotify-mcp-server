# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

Older release lines are not maintained; please upgrade to the latest 1.0.x before reporting.

## Reporting a vulnerability

**Preferred: GitHub private vulnerability reporting.** Use the repository's *Security* tab → *Report a vulnerability* (private advisory). This keeps the report confidential end-to-end.

If private reporting is unavailable to you, contact [@NovaLux12](https://github.com/NovaLux12) directly by opening a **private** GitHub issue or discussion marked as security-related — but prefer the Security tab above all.

Please do **not** open a public issue for security problems.

### What is explicitly in scope

Reports involving **stored Spotify credentials or OAuth flows are always in scope**, including but not limited to:

- Exposure or leakage of the token cache at `~/.spotify-mcp/tokens.json` (e.g. wrong file permissions, world-readable storage, accidental logging of tokens)
- Weaknesses in the Authorization Code with PKCE flow implementation (state validation, redirect handling, code exchange)
- Token refresh logic leaking access or refresh tokens into logs, errors, or child processes
- Headless (`SPOTIFY_HEADLESS=1`) paste-flow weaknesses that could leak authorization codes
- Anything that could let another local user or process obtain Spotify tokens

### Response expectations

We respond to valid reports on a **best-effort basis** — typically within a few days, though this is a personal project maintained in spare time and no formal SLA is guaranteed. We will acknowledge receipt, work with you to understand the issue, and coordinate disclosure timing. Credit is given in the fix release unless you prefer otherwise.

## Out of scope

- Premium-required errors, market gating, or endpoint deprecation failures from Spotify itself (these are documented limitations, not vulnerabilities)
- Issues requiring a compromised local machine beyond ordinary same-user access
- Social engineering of Spotify account holders
