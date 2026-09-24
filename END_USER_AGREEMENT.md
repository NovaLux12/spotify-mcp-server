# End User Agreement

This End User Agreement (**Agreement**) applies when you install, configure, or use the `spotify-mcp` server (the **Server**) through an MCP host. This is a plain-language operational agreement, not legal advice, and it does not replace the [Spotify Developer Terms](https://developer.spotify.com/terms), the [Spotify Developer Policy](https://developer.spotify.com/policy), or any other agreement with Spotify. Read those current terms before using the Server.

By installing or using the Server, you agree to these terms on behalf of yourself and any organization you represent. If you do not agree, do not install or use the Server. The Server has no separate click-through registration screen, so installation/use is the acceptance mechanism available in an MCP deployment.

## 1. No warranty or representation for Spotify

The Server, its maintainer, and its distributors make no warranty, representation, or promise on behalf of Spotify. To the fullest extent permitted by law, the Server, Spotify Platform, Spotify Service, and Spotify Content are provided **“as is” and “as available,”** without implied warranties, including merchantability, fitness for a particular purpose, and non-infringement. Spotify does not warrant that the Spotify Platform, Spotify Service, Spotify Content, API results, availability, playback, or error behavior will meet your requirements, be uninterrupted, timely, secure, error-free, accurate, reliable, or consistent with expectations.

You are responsible for deciding whether a tool result is suitable for your use. Do not treat a 403, 404, 429, stale result, or other API response as a Spotify warranty or guarantee.

## 2. No modification or derivative works

You must not modify, edit, alter, create derivative works of, republish, or otherwise adapt the Spotify Platform, Spotify Service, or Spotify Content except to the limited extent expressly allowed by applicable law and Spotify's current terms. The Server's own code is separately licensed under the project [MIT License](LICENSE); that license does not grant any rights in Spotify Content or the Spotify Platform. You may use the Server only for authorized, personal API operations and must not use it to circumvent Spotify privacy features, geographic restrictions, access controls, quotas, or other restrictions.

You must not use the Spotify Platform or Spotify Content to train a machine-learning or AI model, ingest Spotify Content into one, or create unrelated user/listener profiles, advertising audiences, benchmarks, or derived listenership metrics. A host that sends tool results to an LLM must apply its own authorized retention, access, and no-training controls; this Agreement does not claim to control that host.

## 3. No reverse engineering

To the fullest extent allowed by law, you must not decompile, reverse-engineer, disassemble, or otherwise reduce the Spotify Platform, Spotify Service, Spotify Content, or any client library to source code or another human-perceivable form. You also must not remove or alter copyright, trademark, attribution, rights-management, or other notices in Spotify material.

## 4. Your product and responsibility

You are solely responsible for your Server configuration, prompts, tools, integrations, exports, local files, accounts, and any product or service you offer to users. You must obtain any permissions, registrations, scopes, notices, and legal rights required for your use. You must protect OAuth credentials and local stores, restrict access to your users' data, and stop or delete data when the user disconnects or requests erasure.

The Server and its maintainer are not responsible for Spotify's service, content, availability, account decisions, API errors, or third-party services. To the fullest extent permitted by law, the Server maintainer and distributors disclaim liability for third-party services and Spotify-side failures, including service interruption, access denial, quota/rate limits, content changes, or loss of data. Your sole remedy for dissatisfaction with the Spotify Platform or Spotify Service is to stop using the Spotify Platform, subject to non-waivable rights that applicable law does not permit to be waived.

## 5. Spotify third-party beneficiary

Spotify AB and its applicable corporate affiliates are intended third-party beneficiaries of this Agreement and of the [Privacy Notice](PRIVACY.md). They are entitled to directly enforce this Agreement and the Privacy Notice, including the terms protecting Spotify Content, Spotify Personal Data, privacy choices, and deletion obligations. Nothing in this Agreement grants Spotify or any other third party any ownership of the Server's own code.
Spotify is a third-party beneficiary of this end user license agreement and privacy policy and is entitled to directly enforce this end user license agreement.

## 6. Data, exports, and agent context

The Server may store tokens and user-requested local sidecars, backups, snapshots, exports, and history at the paths described in [PRIVACY.md](PRIVACY.md). The Server does not operate a hosted account service. Tool results returned to an MCP host may enter an LLM or agent context; the host and its provider control that processing. Keep only the data needed for the purpose, do not include credentials in prompts, and delete local and host copies when the purpose ends or a user disconnects.

The Server's third-party `statsfm_*` tools send the supplied stats.fm user ID and query parameters to `api.stats.fm`; they do not send Spotify tokens or Spotify API response bodies to stats.fm. See the stats.fm terms and privacy links in [PRIVACY.md](PRIVACY.md). stats.fm is independent of Spotify and this project.

## 7. Attribution and non-affiliation

The Server is not affiliated with, sponsored by, endorsed by, or operated by Spotify AB. Do not imply a partnership, sponsorship, endorsement, or affiliation without Spotify's written permission. When displaying Spotify Content, follow Spotify's current branding and attribution requirements, including attributing content as supplied and made available by Spotify and linking applicable metadata or artwork to the relevant Spotify content or playlist where required. Do not offer Spotify metadata, cover art, or previews as a standalone product.

## 8. Security incidents and termination

Report suspected vulnerabilities through the process in [SECURITY.md](SECURITY.md). A suspected Security Incident involving Spotify Personal Data must be reported to Spotify at `security@spotify.com` without undue delay and in any event within 24 hours of awareness or reasonable suspicion, as required by the Spotify Developer Terms. This 24-hour notification deadline is not a retention period: stop access and delete local and host copies promptly when required. On account disconnection, stop requesting and processing that account's Spotify Personal Data and delete applicable local copies within the deadline required by the current Spotify terms; on termination, cease use and delete Spotify Content as required.

If you do not comply with this Agreement or Spotify's terms, your access and permission to use the Server may be suspended or ended. Sections concerning disclaimers, responsibility, third-party rights, deletion, and accrued rights survive termination to the extent permitted by law.

## 9. Contact and updates

For questions about this Agreement, use the repository's public issue or security channels as appropriate. The operator of a particular MCP deployment is responsible for its own support and privacy requests. This Agreement may be updated with the Server; the current repository copy applies to the version you use. Nothing in this document is legal advice or a promise that a particular law will enforce a particular clause.
