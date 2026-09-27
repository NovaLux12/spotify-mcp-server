/**
 * Purpose + provenance for a write that stored Spotify data drives (#708).
 *
 * The Terms ask for purpose-specific consent when locally persisted Spotify
 * Content is used to drive an action against the account. Before this module
 * the write-back tools captured only an operational "Proceed?" — the prompt
 * said what would change, and `restore_library_snapshot` already published the
 * source path and the snapshot date in its payload, but nothing recorded WHAT
 * USE the data was being put to, and nothing recorded whether a human had
 * confirmed anything at all.
 *
 * Three rules shaped this module, each learned from a shipped failure:
 *
 * 1. A record that cannot be true is worse than no record (#803/#830 class: a
 *    correctly named field that lies about its value). The consent state is
 *    not a boolean, because a write frequently happens with no human in the
 *    loop: below a threshold no prompt is issued at all, and
 *    SPOTIFY_MCP_CONFIRM=never makes `confirmViaElicitation` return
 *    'unsupported' so the guard lets the write through. A flat
 *    `confirmed: true` written in either case would be a fabrication wearing a
 *    compliance label. `not_requested` therefore carries the reason it was not
 *    requested, `bypassed` names the escape hatch that let it through, and
 *    `declined` records that a human was asked and said no.
 *
 * 2. Never manufacture provenance. `created` is the instant the FILE DECLARES
 *    and `null` when it declares none — file mtime is not provenance, because
 *    copying a file resets it, so an mtime would be an unverifiable timestamp
 *    presented as one. The type below makes a declared date and a reason for
 *    its absence mutually exclusive, so a caller cannot ship an undated source
 *    without saying why.
 *
 * 3. The prompt and the stored record are built from the same fragments
 *    (`provenanceFacts`), so the words a human approved and the words an audit
 *    later reads cannot drift apart. The note is the prompt's facts plus the
 *    consent outcome; the prompt is the same facts laid out to be read.
 *
 * Purpose is recorded as the OPERATION this server performs, not the caller's
 * reason for wanting it. The server cannot observe why somebody is restoring a
 * snapshot, and a plausible invented motive would be worse than an honest one:
 * it would read as an answer. The operation is knowable, and it is what the
 * record says.
 */
import type { ElicitVerdict } from './confirm.js';

/**
 * What kind of local artifact the data came from. Named so an audit can tell a
 * library snapshot from a user-authored document without parsing a path.
 */
export type StoredDataKind =
  | 'library_snapshot'
  | 'playlist_snapshot'
  | 'import_document'
  | 'library_sidecar';

/**
 * The local artifact a write is reading from.
 *
 * The `created` half is a union on purpose: a source either declares an instant
 * (and names the field it was read from) or declares none (and says why). There
 * is no third shape in which a date is absent and nothing is said about it,
 * because that is the case where a plausible value would be invented.
 */
export type StoredDataSource = {
  kind: StoredDataKind;
  /**
   * Resolved file the data was read from, or null when there is no file — an
   * inline document has a body but no provenance path, and recording
   * `'inline content'` in a field typed as a path would be a lie about the
   * type.
   */
  path: string | null;
  /** Rows this operation considers from the file. Counted from the file, never estimated. */
  items: number;
  /**
   * Further files from the same stored set that this write also reads. A
   * two-snapshot merge has no single source, and a record naming only one of
   * the two would let a reader believe the other was never read.
   */
  related_paths?: readonly string[];
} & (
    | { created: string; created_field: string; missing_date_reason?: never }
    | { created: null; created_field?: never; missing_date_reason: string }
  );

/**
 * What, if anything, a human was asked before this write went out.
 *
 * `not_requested` and `bypassed` are not failure states — they are the truthful
 * description of the two common paths where the write was not individually
 * approved — but they are materially different from `confirmed`, and `declined`
 * is materially different again: it is the record's answer to "was this asked
 * about?", and an audit needs to tell an approved write from a rejected one.
 */
export type ConsentState =
  | { state: 'confirmed' }
  | { state: 'declined' }
  | { state: 'not_requested'; because: string }
  | { state: 'bypassed'; via: 'SPOTIFY_MCP_CONFIRM=never' };

/** The reasons `requiredConfirmationRefusal` refuses for. */
export type RefusalReason = 'declined' | 'elicitation_failed' | 'confirmation_unavailable';

/**
 * The consent state a gate actually produced, from the guard's own verdict and
 * refusal rather than from a fresh read of the environment.
 *
 * Reading the refusal first is what keeps this honest. An `'unsupported'`
 * verdict means two different things depending on what happened next: the
 * guard let the write through (SPOTIFY_MCP_CONFIRM=never — genuinely a
 * bypass), or it refused the write for `confirmation_unavailable` (the host
 * cannot prompt — no prompt happened and nothing was written). Re-deriving
 * that from the environment instead of from the guard's decision is how a
 * refused write would end up recorded as a bypass.
 */
export function consentAfterGate(
  verdict: ElicitVerdict | null,
  opts: { refusalReason?: RefusalReason; notRequestedBecause: string },
): ConsentState {
  if (opts.refusalReason === 'declined') return { state: 'declined' };
  if (opts.refusalReason === 'elicitation_failed') {
    return { state: 'not_requested', because: 'the confirmation prompt failed on the wire' };
  }
  if (opts.refusalReason === 'confirmation_unavailable') {
    return { state: 'not_requested', because: 'the connected host cannot prompt for confirmation' };
  }
  if (verdict === 'confirmed') return { state: 'confirmed' };
  if (verdict === 'unsupported') return { state: 'bypassed', via: 'SPOTIFY_MCP_CONFIRM=never' };
  if (verdict === 'declined' || verdict === 'error') {
    return { state: 'not_requested', because: 'the confirmation prompt did not return an answer' };
  }
  return { state: 'not_requested', because: opts.notRequestedBecause };
}

/** A write's source, its stated use, and what was confirmed. */
export interface WriteProvenance {
  source: StoredDataSource;
  /** The operation, phrased as what this server does with the data. */
  purpose: string;
  consent: ConsentState;
}

/** A creation instant a file declares, or the reason it declares none. */
export type DeclaredDate =
  | { created: string; created_field: string }
  | { created: null; missing_date_reason: string };

/**
 * Read a creation instant the way a stored file DECLARES one.
 *
 * `container` is the object holding the field and `field` is its key — `_meta`
 * with `created` for a library backup, `_meta` with `taken_at` for a playlist
 * snapshot, the document root with `exported_at` for a sidecar. `label` is how
 * the field is NAMED in a message, so the reason says `_meta.created` rather
 * than a bare `created`. The three ways of having no date (no container, no
 * key, a value that is not a date string) get three different reasons, because
 * the remedy differs and one blanket message would hide which of the three it
 * was.
 *
 * Nothing here falls back to the filesystem. A copy resets mtime, so an mtime
 * is not a date the file declares about itself — it is a date the filesystem
 * guesses about a path.
 */
export function declaredCreationDate(container: unknown, field: string, label = field): DeclaredDate {
  if (typeof container !== 'object' || container === null) {
    return { created: null, missing_date_reason: `the file carries no ${label} to read` };
  }
  const value = (container as Record<string, unknown>)[field];
  if (value === undefined) {
    return { created: null, missing_date_reason: `the file's ${label} is absent` };
  }
  if (typeof value !== 'string' || value.length === 0) {
    return { created: null, missing_date_reason: `the file's ${label} is not a date string` };
  }
  return { created: value, created_field: label };
}

/** The four facts, formatted once, for the prompt and the record to share. */
export interface ProvenanceFacts {
  source: string;
  date: string;
  items: string;
  purpose: string;
}

/**
 * Format the facts. Both `provenancePromptLines` and `provenanceNote` render
 * these and nothing else, which is what keeps the approved words and the
 * recorded words identical.
 */
export function provenanceFacts(p: Pick<WriteProvenance, 'source' | 'purpose'>): ProvenanceFacts {
  const s = p.source;
  const related = s.related_paths ?? [];
  return {
    source: [
      s.path === null ? 'inline document (no file on disk)' : `local file ${s.path}`,
      ...related.map((r) => `local file ${r}`),
    ].join(' and '),
    date:
      s.created !== null
        ? `${s.created} (the file's own ${s.created_field})`
        : `NOT STATED BY THE FILE — ${s.missing_date_reason}`,
    items: `${s.items} item(s) in scope`,
    purpose: p.purpose,
  };
}

/**
 * Prompt block. Says what the data is, where it came from, when the file says
 * it was taken, how much of it is in play, and the one use being made of it.
 *
 * Deliberately carries no consent sentence: this text is shown *before* the
 * decision, so any claim about what was confirmed here would be false.
 */
export function provenancePromptLines(p: Pick<WriteProvenance, 'source' | 'purpose'>): string[] {
  const f = provenanceFacts(p);
  return [
    `STORED SPOTIFY DATA — source: ${f.source}`,
    `  date: ${f.date}`,
    `  ${f.items}`,
    `USE: ${f.purpose}. This stored data is used for this write only and for no other purpose.`,
  ];
}

/** One clause saying what was — or was not — confirmed, in the caller's terms. */
function consentClause(consent: ConsentState): string {
  if (consent.state === 'confirmed') {
    return 'A human confirmed this use in the prompt shown to them.';
  }
  if (consent.state === 'declined') {
    return 'A human was asked and declined — this stored data was NOT written back.';
  }
  if (consent.state === 'bypassed') {
    return `NO HUMAN WAS ASKED — this write went ahead unprompted because ${consent.via} is set.`;
  }
  return `NO HUMAN WAS ASKED — ${consent.because}. This use was not individually approved.`;
}

/**
 * The stored record: the prompt's own facts plus the consent outcome, as one
 * sentence. This is what lands in `structuredContent.consent_note`, and the
 * same words go into PRIVACY.md so the documented limitation and the prompt
 * cannot describe different behaviour.
 */
export function provenanceNote(p: WriteProvenance): string {
  const f = provenanceFacts(p);
  return (
    `Stored Spotify data — source: ${f.source}; date: ${f.date}; ${f.items}. ` +
    `Use: ${f.purpose}. This stored data is used for this write only and for no other purpose. ` +
    consentClause(p.consent)
  );
}

/**
 * The structured half, published beside `consent_note` so a caller can branch
 * on the consent state instead of parsing the sentence, and can see the source
 * fields without re-reading the file.
 *
 * `purpose` is the same operation string the note and the prompt carry — the
 * use is a recorded fact about this write, not a caller-facing switch, and it
 * is what the Terms ask the record to carry. What is deliberately NOT here is a
 * caller-supplied purpose: the server cannot observe one, and a parameter
 * defaulting to a plausible motive would be the fabricated answer the header
 * warns about.
 */
export function provenancePayload(p: WriteProvenance): Record<string, unknown> {
  const s = p.source;
  return {
    source_kind: s.kind,
    source_path: s.path,
    ...((s.related_paths ?? []).length > 0 ? { source_related_paths: [...(s.related_paths ?? [])] } : {}),
    source_created: s.created,
    source_created_field: s.created === null ? null : s.created_field,
    source_missing_date_reason: s.created === null ? s.missing_date_reason : null,
    source_items: s.items,
    purpose: p.purpose,
    consent: p.consent,
  };
}

/**
 * What a tool result carries: the sentence and the fields, together. Every
 * call site spreads this in rather than assembling the two halves, so a result
 * can never have one without the other.
 */
export function consentFields(p: WriteProvenance): { consent_note: string; provenance: Record<string, unknown> } {
  return { consent_note: provenanceNote(p), provenance: provenancePayload(p) };
}
