/**
 * Rendered-row attribution and the link back to Spotify (#696).
 *
 * ## What the policy actually requires
 *
 * Two clauses, and the second is the one that costs a tool result its shape.
 *
 * - Developer Policy Sec. II.4.a — "If you display any Spotify Content you
 *   must clearly attribute the content as being supplied and made available by
 *   Spotify." That is a footer, and the wording lives in `src/branding.ts`
 *   beside the non-affiliation notices because it is the same kind of thing:
 *   a sentence this project must not spell two ways.
 * - Sec. II.4.b — the displayed metadata must link back to the applicable
 *   album / content / playlist. That is per-row, and a `spotify:` URI is not a
 *   link: `spotify:track:0VjI…` is an internal handle, not something a user can
 *   open, and an agent that reads the row cannot hand the reader a way through
 *   to the thing it was told about.
 *
 * ## Why this is a boundary and not sixty edits
 *
 * Every row renderer in this server is a module-local string template, and
 * there are roughly sixty modules. Editing them is not an option twice: the
 * second time it is sixty edits that can disagree. `src/index.ts` already
 * installs five cross-cutting boundaries that wrap every registered tool
 * callback (`installTruncationBoundary` shapes the payload, `installActingAccountBoundary`
 * stamps the account, …), and this installs beside them. One wrapper, one
 * implementation, and the sixty modules inherit it — which is the property that
 * keeps the next module from shipping uncredited rows.
 *
 * ## Resources are the second surface, and they were missed first
 *
 * The boundary shipped covering tools, because a tool is what #696 was about.
 * MCP Resources are the other way a host reaches rendered Spotify metadata —
 * the registry advertises 17 fixed resources and 28 resource templates, and a
 * host reading `spotify://me/top/tracks` names no tool at all — and their ~26
 * render sites in `src/resources/` emit the same `| URI: <uri>` rows the tool
 * path had been fixing. `installResourceAttributionBoundary` closes that, on
 * the same terms, by wrapping `server.resource` / `server.registerResource`.
 *
 * The argument that made it a defect rather than a scope decision is the
 * documentation: §5.17 and `docs/compliance.md` state the obligation as met,
 * and a reader who had just been told how the link-back requirement is
 * discharged had no way to learn that a third of the read surface discharged
 * nothing. A gap that is merely unfixed is a bug; a gap the contract does not
 * mention is documentation drifting from behaviour, which is the shape #696 was
 * filed about one MCP surface over.
 *
 * ## What is deliberately NOT done
 *
 * - **`structuredContent` is not touched.** The machine-readable payload keeps
 *   the bare `spotify:` URI, because that is what a programmatic consumer
 *   matches on, and rewriting it would break every caller for the benefit of a
 *   human who is reading the text block. The two channels differ on purpose:
 *   the text block gains a link, the structured one does not.
 * - **A `json` text block is left alone, whole.** `response_format: 'json'`
 *   promises "the raw API payload as JSON text" (SPEC §5) and the truncation
 *   boundary goes out of its way to keep that text parseable — "It needs no
 *   appended note: … the text stays valid JSON". Appending a footer or an
 *   inline link to a JSON document breaks `JSON.parse` for every host that
 *   relies on the promise, and it would make the payload no longer the API's
 *   response. The link-back requirement is still met in `json` mode, and by
 *   something better than a reconstruction: the raw payload carries Spotify's
 *   own `external_urls.spotify` for every entity, which is the canonical link,
 *   straight from the source. See `attributeText` for the test that pins this.
 * - **An `isError` result carries no footer.** A validation refusal names this
 *   project's own schema; a "no active device" line names a local state. The
 *   footer on those says nothing true and teaches a reader to stop seeing it,
 *   which is how an attribution that appears on everything stops being
 *   attribution. It goes on results, which is to say on rendered content.
 * - **A URI this module cannot resolve gets no link, and is not modified.**
 *   Not a shortened id, not a guessed kind, not a best-effort path. The
 *   `spotify:` token is left byte-for-byte alone, which is the #803 rule one
 *   field over: a value that could not be read is never replaced by a
 *   plausible-looking one.
 */
import { CONTENT_ATTRIBUTION_NOTICE } from './branding.js';
import { attributionEnv } from './config.js';
import { classifySpotifyReference, type SpotifyReferenceKind } from './refs.js';

/**
 * The share-URL path segment per entity kind.
 *
 * Keyed off `SPOTIFY_REFERENCE_KINDS` rather than a free-standing list, and
 * `satisfies` makes a missing or extra member a compile error — which is what
 * stops a new reference kind shipping without the question being asked. The
 * segment is the kind name itself, which is the shape the tree already
 * publishes: `src/tools/catalog.ts` describes its entity-id arguments as
 * "`open.spotify.com/${referenceKind}` URLs", and `src/refs.ts` parses
 * `open.spotify.com/<kind>/<id>` as a share URL for every kind in its own
 * vocabulary. `playlist` and `show` are additionally built by hand in
 * `src/tools/portability.ts` and `src/tools/exhaust2_misc.ts`.
 *
 * `chapter` is absent because it is not a reference kind — a chapter has no
 * Spotify URI of its own, only an id inside its audiobook, so there is no
 * `spotify:chapter:` token for this to be asked about.
 */
const WEB_URL_SEGMENT: Readonly<Record<SpotifyReferenceKind, string>> = {
  track: 'track',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  show: 'show',
  episode: 'episode',
  audiobook: 'audiobook',
  user: 'user',
};

/**
 * A `spotify:<kind>:<id>` token inside rendered text.
 *
 * The id character class is the one `src/refs.ts` validates against
 * (`SPOTIFY_ID_RE`, base62) rather than "anything up to the next space". A
 * looser class would swallow the sentence punctuation after a URI and then
 * fail to resolve, which reads as a silently dropped link; a tight one stops
 * at the id, so a URI at the end of a sentence resolves and a following `.`
 * stays a full stop. A `user` id containing `.`, `-`, `_` or `~` is truncated
 * by this token and therefore not linked — stated here rather than hidden,
 * because it is the one kind whose id charset is wider than the others.
 */
const URI_TOKEN = /spotify:([A-Za-z][A-Za-z0-9]*):([A-Za-z0-9]+)/g;

/** A share URL already present in the text, so this pass does not add a second. */
const WEB_URL_PRESENT = /https:\/\/open\.spotify\.com\/([a-z]+)\/([A-Za-z0-9]+)/g;

/**
 * The canonical `open.spotify.com` link for a Spotify URI, or `null` when the
 * input is not one this server is willing to turn into a link.
 *
 * Validation goes through `classifySpotifyReference`, the single Spotify URI
 * grammar in `src/refs.ts` — a second regex here would be a second definition
 * of what a Spotify URI is, and the two would disagree about exactly the inputs
 * that matter (a short id, an unknown kind). `null` therefore covers all of:
 * malformed URI, unknown kind, and an id that is not a real entity id. The
 * caller leaves the token alone on `null`; it never substitutes a guess.
 */
export function spotifyWebUrl(uri: string): string | null {
  const parsed = classifySpotifyReference(uri);
  if (!parsed.valid || !parsed.kind || !parsed.id) return null;
  return `https://open.spotify.com/${WEB_URL_SEGMENT[parsed.kind]}/${parsed.id}`;
}

/**
 * Append the link to every `spotify:` URI in one rendered line.
 *
 * Each URL is emitted immediately after the URI it belongs to, in parentheses,
 * rather than collected into one group at the end of the line. That is the
 * choice that keeps the line honest: a batch summary carries three URIs on one
 * line, and a trailing list of three URLs next to a list of three URIs is a
 * correspondence only the reader can reconstruct. Inline, the pairing needs no
 * inference at all.
 *
 * `alreadyLinked` is the set of `<kind>/<id>` pairs the text already points at,
 * computed once per result by `linkifyRows`. A tool that renders the link
 * itself keeps its own spelling and gains no second copy — including one
 * carrying Spotify's `?si=` share parameter, which reads as the same entity
 * rather than as a different URL string. Rewriting that to a canonical form
 * would be worse than a duplicate: the parameter is the caller's tracking
 * token, and dropping it is a change nobody asked for.
 */
function linkifyLine(line: string, alreadyLinked: Set<string>): string {
  let out = '';
  let cursor = 0;
  for (const match of line.matchAll(URI_TOKEN)) {
    const uri = match[0];
    const kind = match[1] as string;
    const id = match[2] as string;
    const url = spotifyWebUrl(uri);
    // Two reasons to stop here, and neither is a guess: the token is not a URI
    // we can resolve, or the line already links to this exact entity.
    if (url === null || alreadyLinked.has(`${kind}/${id}`)) continue;
    out += line.slice(cursor, match.index) + `${uri} (${url})`;
    cursor = match.index + uri.length;
    alreadyLinked.add(`${kind}/${id}`);
  }
  return out + line.slice(cursor);
}

/**
 * Add the link-back to every rendered row in a text block.
 *
 * Idempotent by construction: a pair that has been linked once is recorded, so
 * a second pass emits nothing. That matters because the boundary is installed
 * once per session but the text is produced once per call, and a wrapper that
 * were ever applied twice — by a future boundary, or by a host that re-enters
 * the tool — must not stack copies.
 */
export function linkifyRows(text: string): string {
  const alreadyLinked = new Set<string>();
  for (const match of text.matchAll(WEB_URL_PRESENT)) alreadyLinked.add(`${match[1]}/${match[2]}`);
  return text
    .split('\n')
    .map((line) => linkifyLine(line, alreadyLinked))
    .join('\n');
}

/**
 * Append the attribution footer, once, on its own line.
 *
 * "Once" is checked rather than assumed: the text is split into lines and the
 * footer compared against each trimmed one, so a handler that already emitted
 * it — or a wrapper that runs twice — does not stack a second copy. The
 * comparison is against the whole trimmed line, not a substring, so a result
 * that merely *mentions* the phrase in a track title is not mistaken for one
 * that carries the footer.
 */
export function withAttributionFooter(text: string): string {
  const alreadyPresent = text
    .split('\n')
    .some((line) => line.trim() === CONTENT_ATTRIBUTION_NOTICE);
  if (alreadyPresent) return text;
  return `${text.replace(/\s+$/, '')}\n\n${CONTENT_ATTRIBUTION_NOTICE}`;
}

/**
 * The whole text-block transformation, in one pure function.
 *
 * The JSON check is the first thing it does and it is a *parse*, not the
 * `^\s*[{[]` prefix sniff `src/shaping.ts` uses to decide whether a JSON
 * attempt is worth making. Here the question is not "might this be JSON" but
 * "is this a document a host will parse", and the honest answer needs the parse:
 * a prose row that happens to open with a brace must still be attributed, and a
 * JSON document that does not need rewriting must come back byte-identical.
 *
 * Kept pure and separate from the boundary so the documented behaviour can be
 * driven directly by a test without standing up a server, and so the two
 * properties — the footer, and the rows — can be asserted apart from the
 * wrapper that happens to apply them.
 */
export function attributeText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object') return text;
  return withAttributionFooter(linkifyRows(text));
}

/**
 * The cross-cutting boundary (#696). Wraps every registered tool callback and
 * attributes the finished result.
 *
 * The same two-method wrap as the other boundaries, for the same reason: the
 * SDK accepts `tool(name, description, schema, cb)` with or without the
 * description, so the callback is the LAST argument of `tool` and index 2 of
 * `registerTool`. Hard-coding either index is how a boundary installs and does
 * nothing.
 *
 * It mutates nothing: a new result object is built with a new content array and
 * a new text block, so a caller holding the pre-attribution result is unaffected
 * and the decoration cannot leak into a second call.
 *
 * Returns the input by identity when there is nothing to attribute, which is
 * the common case for an error result, a result with no text block, and every
 * result at all once `SPOTIFY_MCP_ATTRIBUTION` is off.
 */
export function installAttributionBoundary(server: object): void {
  const enabled = attributionEnv();
  const api = server as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const originalTool = api.tool.bind(server);
  const originalRegisterTool = api.registerTool.bind(server);

  const remember = (name: string, args: unknown[], callbackIndex: number): void => {
    if (!enabled || typeof args[callbackIndex] !== 'function') return;
    const callback = args[callbackIndex] as (...callArgs: unknown[]) => unknown;
    args[callbackIndex] = async (...callArgs: unknown[]) => attributeResult(await callback(...callArgs));
  };

  api.tool = (...args: unknown[]) => {
    remember(String(args[0]), args, args.length - 1);
    return originalTool(...args);
  };
  api.registerTool = (...args: unknown[]) => {
    remember(String(args[0]), args, 2);
    return originalRegisterTool(...args);
  };
}

/**
 * Attribute one finished tool result, or return it unchanged.
 *
 * The three refusals are the ones `attributeText`'s header names, applied here
 * where the result envelope is visible: an error result, a result with no
 * string text block, and a `json` payload. The first text block is the one
 * decorated; a result carrying several is not a shape this server produces, and
 * rewriting all of them would put a footer on a second copy of a payload.
 */
export function attributeResult(result: unknown): unknown {
  if (result == null || typeof result !== 'object') return result;
  const record = result as { isError?: unknown; content?: unknown };
  if (record.isError === true) return result;
  if (!Array.isArray(record.content)) return result;
  const index = record.content.findIndex(
    (block) => block != null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string',
  );
  if (index < 0) return result;
  const block = record.content[index] as { text: string };
  const text = attributeText(block.text);
  if (text === block.text) return result;
  const content = [...record.content];
  content[index] = { ...block, text };
  return { ...record, content };
}

/**
 * The property that marks a resource read as reporting state rather than
 * Spotify Content.
 *
 * MCP Resources were the one read surface this boundary did not reach when
 * #696 landed, and the reason is structural rather than deliberate:
 * `installAttributionBoundary` wraps `server.tool` and `server.registerTool`,
 * and a resource registers through `server.resource` instead. Roughly 26 render
 * sites in `src/resources/` emit `| URI: <uri>` rows — the same row shape the
 * tool path had been fixing — on a surface a host reaches without naming a
 * single tool. The policy obligation does not care which MCP method produced
 * the bytes: Developer Policy Sec. II.4.a says *if you display any Spotify
 * Content*, and a resource read displays Spotify Content.
 *
 * ## Why the wrap transfers unchanged
 *
 * Verified against the installed SDK (`@modelcontextprotocol/sdk` 1.30.0,
 * `dist/esm/server/mcp.js`) rather than assumed, because "assume the tool
 * pattern transfers" is precisely what would have produced a boundary that
 * installed and did nothing:
 *
 * - `resource(name, uriOrTemplate, ...rest)` shifts off a leading metadata
 *   object and then takes `rest[0]` as the read callback — so the callback is
 *   the LAST argument, the same `args.length - 1` position `tool` uses.
 * - `registerResource(name, uriOrTemplate, config, readCallback)` takes it last
 *   too, so the deprecated `resource` and its replacement agree on the index.
 * - The `resources/read` handler dispatches through the callback that was
 *   stored at registration: `return resource.readCallback(uri, extra)` for a
 *   fixed resource and `template.readCallback(uri, variables, extra)` for a
 *   template. Replacing the callback in the argument list BEFORE handing the
 *   arguments to the original therefore intercepts every read.
 *
 * ## Why the gate result is marked rather than sniffed
 *
 * `gatedResourceResult` in `src/resources/index.ts` answers a 403/404/429 with
 * prose — a resource label and a status, e.g. "top-tracks is unavailable in
 * this market or OAuth scope (404)". It displays no track name, no album, no
 * artist and no `spotify:` URI. A footer on it says nothing true, and this
 * module's own reasoning for withholding the footer from an `isError` tool
 * result applies word for word: a footer that appears on everything is a footer
 * a reader learns to skip.
 *
 * The exemption is therefore DECLARED at the point that knows the answer, and
 * read back here as a flag, rather than recovered by matching the prose. A
 * string comparison against the two known sentences would be the summary-as-
 * contract failure this repository has shipped before: reword the message and
 * the gate silently starts printing "Music data supplied by Spotify." under an
 * HTTP status line.
 *
 * The flag is a SYMBOL, and that is load-bearing rather than stylistic. The
 * obvious string key does not work: `ReadResourceResultSchema` is a loose
 * object, so `attributionNonContent: true` survives validation and is serialized
 * to the host as an undocumented response field — verified, not assumed. A
 * symbol key is dropped twice over: the schema rebuilds the object from its
 * known string keys, and `JSON.stringify` ignores symbol keys entirely. The
 * signal is therefore internal by construction, and stays internal even if the
 * boundary is disabled, because the marker is set by the renderer rather than
 * removed by the wrapper.
 */
const NON_CONTENT = Symbol('spotifyMcp.attributionNonContent');

/**
 * Mark a finished resource result as reporting state rather than Spotify
 * Content, so the boundary leaves it byte-identical.
 *
 * Returns `T`, not a widened type: the marker is not part of the response
 * contract, so exposing it in the return type would invite a caller to branch
 * on it. `markNonContent(text(uri, detail))` keeps `ReadResourceResult`, and
 * nothing downstream has to re-assert what it already had.
 */
export function markNonContent<T extends object>(result: T): T {
  return { ...result, [NON_CONTENT]: true };
}

/**
 * Whether one entry of a resource `contents` array is rendered prose this
 * boundary should decorate.
 *
 * The `application/json` test is STRUCTURAL, where the tool path had to fall
 * back to a parse. A resource read declares its own format on every content
 * entry (`json()` in `src/resources/index.ts` sets `mimeType:
 * 'application/json'` for the `?format=json` variant), so the honest question
 * is not "might this text happen to parse" but "did the renderer say this is
 * the raw payload". The same promise §5.17 records for tools holds here: the
 * Sec. II.4.b link-back is met by Spotify's own `external_urls` inside the
 * payload, and a footer appended to a JSON document would break `JSON.parse`
 * for every host that relies on it.
 *
 * A blob entry carries no `text` and is left alone for the same reason an
 * `isError` tool result is: there is nothing rendered to attribute.
 */
function isAttributableContent(entry: unknown): entry is { text: string } {
  if (entry == null || typeof entry !== 'object') return false;
  const record = entry as { text?: unknown; mimeType?: unknown };
  if (typeof record.text !== 'string') return false;
  if (record.mimeType === 'application/json') return false;
  return true;
}

/**
 * The resource text transform — the same two steps as `attributeText`, without
 * its JSON probe, because the resource envelope already answered the question.
 *
 * `attributeText` decides "is this a document a host will parse?" by parsing,
 * because a tool result's only evidence of `response_format: 'json'` is the
 * text itself. A resource read does not have that problem: every entry declares
 * its own `mimeType`, and `json()` in `src/resources/index.ts` sets
 * `application/json` on exactly the `?format=json` variant. So the decision is
 * made once, on the declared type, in `isAttributableContent` — and reaching
 * this function already means the renderer said "this is prose".
 *
 * The difference is observable, and it is the reason this is not a redundant
 * copy of `attributeText`: prose that happens to BE valid JSON is still prose.
 * A `text/plain` entry whose body is `{"a":1}` gains the footer and the links
 * here, while `attributeText` would have returned it byte-identical because it
 * parsed. Trusting the declared format over a guess is the same rule the
 * "prose that merely opens with a brace" test states, taken one level up: the
 * renderer knows what it rendered, and a parse is only a fallback for a surface
 * that does not say.
 */
export function attributeResourceText(text: string): string {
  return withAttributionFooter(linkifyRows(text));
}

/**
 * Attribute one finished resource read, or return it unchanged.
 *
 * The envelope differs from a tool result in the one way that matters: a
 * resource returns `contents`, not `content`, and its entries are
 * `{ uri, text, mimeType }` with no `type` discriminator. A `findIndex` on
 * `type === 'text'` finds nothing here, which is the mechanical reason a
 * naive reuse of `attributeResult` would install cleanly and attribute nothing
 * — the same silent-no-op failure mode this file's header warns about.
 *
 * The first attributable entry is the one decorated, matching `attributeResult`.
 * A read returning several is not a shape `src/resources/` produces (both
 * `text()` and `json()` return exactly one), and rewriting all of them would
 * put a second copy of a payload behind the first.
 */
export function attributeResourceResult(result: unknown): unknown {
  if (result == null || typeof result !== 'object') return result;
  const record = result as { contents?: unknown; [NON_CONTENT]?: unknown };
  if (record[NON_CONTENT] === true) return result;
  if (!Array.isArray(record.contents)) return result;
  const index = record.contents.findIndex(isAttributableContent);
  if (index < 0) return result;
  const block = record.contents[index] as { text: string };
  const text = attributeResourceText(block.text);
  if (text === block.text) return result;
  const contents = [...record.contents];
  contents[index] = { ...block, text };
  return { ...record, contents };
}

/**
 * The resource half of the cross-cutting boundary (#696). Wraps every
 * registered resource read callback and attributes the finished contents.
 *
 * A separate installer rather than a third method folded into
 * `installAttributionBoundary`, for two reasons. §5.17's contract is already
 * written against the tool methods and is pinned by `tests/attribution.test.ts`;
 * widening that function in place would change a landed contract's meaning
 * without changing its tests, which is how a boundary stops being the thing its
 * documentation says it is. And the two surfaces have genuinely different
 * envelopes and different exemptions — a resource has no `isError` flag and no
 * `response_format`, but it does have a `?format=json` variant it declares
 * structurally — so one function serving both would need a dispatch table where
 * two named entry points state the difference.
 *
 * Both methods are wrapped because the SDK offers both and the tree uses the
 * deprecated one: `src/resources/index.ts` and `src/resources/templates.ts` call
 * `server.resource(...)` at all four registration sites, and a boundary that
 * covered only `registerResource` would cover nothing at all. Both take the
 * callback last, so both use the same `args.length - 1` position.
 */
export function installResourceAttributionBoundary(server: object): void {
  const enabled = attributionEnv();
  const api = server as {
    resource: (...args: unknown[]) => unknown;
    registerResource: (...args: unknown[]) => unknown;
  };
  const originalResource = api.resource.bind(server);
  const originalRegisterResource = api.registerResource.bind(server);

  const remember = (args: unknown[]): void => {
    if (!enabled) return;
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] !== 'function') return;
    const callback = args[callbackIndex] as (...callArgs: unknown[]) => unknown;
    args[callbackIndex] = async (...callArgs: unknown[]) =>
      attributeResourceResult(await callback(...callArgs));
  };

  api.resource = (...args: unknown[]) => {
    remember(args);
    return originalResource(...args);
  };
  api.registerResource = (...args: unknown[]) => {
    remember(args);
    return originalRegisterResource(...args);
  };
}
