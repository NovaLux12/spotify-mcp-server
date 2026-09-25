# Security Policy

## Supported versions

Only the latest published 1.30.x line receives security fixes. The current
package metadata is 1.30.1; older release lines, including the former 1.0.x
line, are unsupported. Upgrade to the latest 1.30.x release before reporting a
problem. This is a rolling policy: when a newer minor line is published, this
section should be updated with that line rather than retaining a stale table.

## Reporting a vulnerability

**Preferred: GitHub private vulnerability reporting.** Use the repository's
*Security* tab → *Report a vulnerability* (private advisory). This keeps the
report confidential end-to-end.

If private reporting is unavailable to you, contact [@NovaLux12](https://github.com/NovaLux12)
directly by opening a **private** GitHub issue or discussion marked as
security-related — but prefer the Security tab above all.

Please do **not** open a public issue for security problems.

### What is explicitly in scope

Reports involving **stored Spotify credentials, Spotify Personal Data, or OAuth
flows are always in scope**, including but not limited to:

- Exposure or leakage of the token cache at `~/.spotify-mcp/tokens.json` or a
  profile/override token file (for example, wrong file permissions,
  world-readable storage, or accidental logging of tokens)
- Weaknesses in the Authorization Code with PKCE flow implementation (state
  validation, redirect handling, or code exchange)
- Token refresh logic leaking access or refresh tokens into logs, errors, or
  child processes
- Headless (`SPOTIFY_HEADLESS=1`) paste-flow weaknesses that could leak
  authorization codes
- Anything that could let another local user or process obtain Spotify tokens
- Unprotected local stores, exports, backups, snapshots, history, or tool
  results that expose Spotify Personal Data

## Regulatory and third-party notifications

If you become aware of, or reasonably suspect, a Security Incident in which
Spotify Personal Data has been or may have been lost, damaged, or subjected to
unauthorized access, notify Spotify at **security@spotify.com** without undue
delay and, in any event, within **24 hours**. This is the Spotify Developer
Terms Appendix A notification duty; it is a 24-hour clock for reporting a
suspected incident, not permission to retain data for 24 hours. Stop access and
delete local and host copies as soon as required (see [PRIVACY.md](PRIVACY.md)).

Notify affected users without undue delay, identifying the relevant data
categories (tokens, account identifiers, library/listening data, exports, or
other Spotify Content), likely consequences, and mitigation steps. Preserve a
record of the incident, detection, affected categories, recipients, and
mitigation, and cooperate with Spotify and affected users as reasonably needed.

Suggested Spotify notification template:

```
Subject: Suspected Spotify Personal Data Security Incident — [Server/version]

We are reporting a suspected Security Incident involving [Server/version].
We became aware at [UTC time] that [brief facts and data categories] may have
been [lost/damaged/accessed without authorization].

Containment and mitigation: [actions taken].
Contact: [name, role, email, timezone].
```

Do not include access tokens, refresh tokens, raw authorization codes, or
unnecessary user data in an email or public report.

The current Spotify Developer Terms also require deletion of Spotify Content
when the applicable agreement terminates and deletion of applicable Spotify
Personal Data after account disconnection (currently within five days). Those
deletion duties are separate from the 24-hour Spotify notification deadline.

### Response expectations

We respond to valid reports on a **best-effort basis** — typically within a
few days, though this is a personal project maintained in spare time and no
formal SLA is guaranteed. We will acknowledge receipt, work with you to
understand the issue, and coordinate disclosure timing. Credit is given in the
fix release unless you prefer otherwise.

## Out of scope

- Premium-required errors, market gating, or endpoint deprecation failures from
  Spotify itself (these are documented limitations, not vulnerabilities)
- Issues requiring a compromised local machine beyond ordinary same-user access
- Social engineering of Spotify account holders

See [PRIVACY.md](PRIVACY.md) for local data paths, deletion controls, and the
same incident-notification commitment.
