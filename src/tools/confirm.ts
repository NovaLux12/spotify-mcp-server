/**
 * Elicitation-gated confirmation for destructive playlist operations (#111 item 5).
 *
 * Destructive bulk mutations ask the human operator to confirm via MCP
 * elicitation before touching Spotify. Callers that require confirmation use
 * requiredConfirmationRefusal(), which fails closed when the client cannot
 * prompt; SPOTIFY_MCP_CONFIRM=never is the explicit automation bypass. A
 * prompt that fails mid-flight is always a refusal, never a silent proceed.
 */

// Gates used by callers: removals at this scale can silently gut a playlist;
// full replacements rewrite every item.
export const REMOVE_ELICIT_THRESHOLD = 10;
export const REPLACE_ELICIT_THRESHOLD = 50;

/** The object that actually owns elicitation — see elicitHost(). */
interface ElicitHost {
  elicitInput(request: {
    message: string;
    requestedSchema: Record<string, unknown>;
  }): Promise<unknown>;
  getClientCapabilities?(): { elicitation?: unknown } | undefined;
}

/**
 * Resolve the elicitation-capable object: MCP keeps both `elicitInput` and
 * `getClientCapabilities` on the inner `Server` that `McpServer` exposes as
 * `.server`. Probing the wrapper for them always missed, silently disabling
 * every gate (#684).
 *
 * Duck-typed on purpose: the SDK class and test doubles differ nominally, so
 * the members we call are validated at runtime. Returns null when the host
 * cannot prompt, so callers never re-check.
 */
function elicitHost(server: unknown): ElicitHost | null {
  if (typeof server !== 'object' || server === null) return null;
  const inner: unknown = 'server' in server ? server.server : server;
  if (typeof inner !== 'object' || inner === null) return null;
  const host = inner as ElicitHost;
  return typeof host.elicitInput === 'function' ? host : null;
}

/**
 * True when the connected client advertised the elicitation capability AND the
 * resolved host can prompt.
 *
 * Elicitation is advertised BY THE CLIENT during initialization — the
 * accessor is `server.server.getClientCapabilities()`. An earlier revision
 * read the server's own declared capabilities here, which are never set,
 * silently disabling prompting in production; the InMemoryTransport
 * integration test catches that failure mode.
 */
export function supportsElicitation(server: unknown): boolean {
  const host = elicitHost(server);
  if (!host) return false;
  try {
    return Boolean(host.getClientCapabilities?.()?.elicitation);
  } catch {
    return false; // A throwing accessor is not a capability claim.
  }
}

/** Deterministic shared confirmation text for destructive operations. */
export function describeConfirmation(kind: string, target: string, changes: string[]): string {
  const lines = changes.map((c) => `- ${c}`);
  return [`About to ${kind} "${target}":`, ...lines, '', 'Proceed?'].join('\n');
}

export type ElicitVerdict =
  /** Human explicitly accepted. */
  | 'confirmed'
  /** Human declined or cancelled the prompt. */
  | 'declined'
  /** No client capability (or SPOTIFY_MCP_CONFIRM=never) — proceed unprompted. */
  | 'unsupported'
  /** The prompt itself failed on the wire — callers MUST refuse (#684). */
  | 'error';

interface ElicitResultShape {
  action?: string;
  content?: { confirm?: unknown };
}

function isElicitResult(value: unknown): value is ElicitResultShape {
  return typeof value === 'object' && value !== null && 'action' in value;
}

export interface ElicitRefusal {
  /** Why the operation stopped, for structured results. */
  reason: 'declined' | 'elicitation_failed' | 'confirmation_unavailable';
  /** Human text to return as the tool result. */
  message: string;
  /** Structured content to return as the tool result. */
  payload: { ok: false; cancelled: true; reason?: 'elicitation_failed' | 'confirmation_unavailable' };
}

/**
 * Guard for a gate verdict: the refusal a caller must return, or null when the
 * operation may proceed.
 *
 * 'declined' and 'error' both stop the write; only 'unsupported' (the client
 * never advertised elicitation, or SPOTIFY_MCP_CONFIRM=never) proceeds
 * unprompted, since there was never a human to ask.
 */
export function refusalFor(verdict: ElicitVerdict): ElicitRefusal | null {
  if (verdict === 'declined') {
    return {
      reason: 'declined',
      message: 'Cancelled — nothing was changed.',
      payload: { ok: false, cancelled: true },
    };
  }
  if (verdict === 'error') {
    return {
      reason: 'elicitation_failed',
      message: 'Elicitation failed on the wire — refusing to proceed; nothing was changed.',
      payload: { ok: false, cancelled: true, reason: 'elicitation_failed' },
    };
  }
  return null;
}

/**
 * Guard a write that requires explicit confirmation. Only `confirmed` proceeds;
 * an unsupported client is refused unless the operator deliberately disabled
 * confirmation entirely with SPOTIFY_MCP_CONFIRM=never.
 */
export function requiredConfirmationRefusal(verdict: ElicitVerdict): ElicitRefusal | null {
  if (verdict === 'confirmed') return null;
  if (verdict === 'unsupported' && process.env.SPOTIFY_MCP_CONFIRM === 'never') return null;
  if (verdict === 'declined') return refusalFor(verdict);
  if (verdict === 'unsupported') {
    return {
      reason: 'confirmation_unavailable',
      message: 'Confirmation is unavailable — refusing to proceed; nothing was changed.',
      payload: { ok: false, cancelled: true, reason: 'confirmation_unavailable' },
    };
  }
  if (verdict === 'error') {
    return {
      reason: 'elicitation_failed',
      message: 'Elicitation failed on the wire — refusing to proceed; nothing was changed.',
      payload: { ok: false, cancelled: true, reason: 'elicitation_failed' },
    };
  }
  // ElicitVerdict is a closed union and every member is handled above, so this
  // is the fail-closed default rather than a reachable branch: a fifth verdict
  // must refuse loudly, never fall through to a vaguer message.
  return {
    reason: 'elicitation_failed',
    message: 'Confirmation could not be established; refusing to proceed; nothing was changed.',
    payload: { ok: false, cancelled: true, reason: 'elicitation_failed' },
  };
}

/**
 * Ask the user to confirm a destructive operation.
 * Returns 'confirmed' only on explicit accept + confirm=true.
 */
export async function confirmViaElicitation(
  server: unknown,
  opts: { message: string; confirmLabel?: string },
): Promise<ElicitVerdict> {
  // Escape hatch: automation/readonly contexts never prompt.
  if (process.env.SPOTIFY_MCP_CONFIRM === 'never') return 'unsupported';
  const host = elicitHost(server);
  // Already resolved: the capability probe reads the same object we'll call.
  if (!host || !supportsElicitation(host)) return 'unsupported';

  try {
    const result = await host.elicitInput({
      message: opts.message,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', title: opts.confirmLabel ?? 'Confirm' },
        },
        required: ['confirm'],
      },
    });

    if (!isElicitResult(result)) return 'declined';
    return result.action === 'accept' && result.content?.confirm === true
      ? 'confirmed'
      : 'declined';
  } catch {
    // The prompt was attempted and failed — a dead gate must not become an
    // ungated write (#684). Callers refuse on 'error'.
    return 'error';
  }
}
