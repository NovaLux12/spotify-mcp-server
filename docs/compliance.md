# Compliance: brand marks, attribution, and identification

Scope of this page: what this repository may and may not put in front of a
user, and what it must say when it displays Spotify content. It covers
[#698](https://github.com/NovaLux12/spotify-mcp-server/issues/698).

It does **not** cover the product-name decision, the non-affiliation notice
wording, or the `initialize` handshake — those belong to
[#705](https://github.com/NovaLux12/spotify-mcp-server/issues/705) and
[#690](https://github.com/NovaLux12/spotify-mcp-server/issues/690) and are
expected to land in this same file. Whoever lands second should extend this
page rather than create a competing one.

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

In any file under `assets/` or any source file under `src/`:

| Prohibited | Why |
|---|---|
| `#1DB954` / `#1ED760` (Spotify Green, any casing or notation) | Named outright as a restricted brand element. |
| The circle, or the waves arcs, redrawn / recoloured / partial | Modification; no exceptions. |
| `Spotify`, `stats.fm` or `Last.fm` set as artwork — a rendered `<text>` node, or a bar-chart or dot-chain glyph standing in for a wordmark | Wordmark reproduction. |
| A vendored copy of any official logo file | This is an MIT repository; the mark is not ours to sublicense. |

`tests/third-party-marks-guard.test.ts` enforces this by scanning the source
tree. It is a source scan rather than a behavioural assertion because a mark
has no runtime behaviour to assert on — the defect is a literal in a file, and
a behavioural test can only cover the files its author happened to think to
load.

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

## Provenance

`NOTICE` records that this project is an independent implementation, and that
Spotify Content, the Spotify Platform, and Spotify marks are not licensed by
it and remain subject to
[Spotify's own terms](https://developer.spotify.com/terms) and the
[third-party notices](https://developer.spotify.com/third-party-licenses).
That statement is why the marks are absent from the repository and why they
must stay absent.

---

Quotations above are from <https://developer.spotify.com/branding-guidelines>
and <https://developer.spotify.com/terms>, retrieved 2026-09-27. Those pages
change without notice; if a rule here stops matching them, the page is stale,
not the rule.
