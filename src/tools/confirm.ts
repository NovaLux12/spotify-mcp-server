/**
 * Elicitation-gated confirmation for destructive playlist operations (#111 item 5).
 *
 * Destructive bulk mutations ask the human operator to confirm via MCP
 * elicitation before touching Spotify. Environments without elicitation
 * support (or with SPOTIFY_MCP_CONFIRM=never) skip prompting entirely so
 * automation/readonly contexts are never blocked.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Gates used by callers: removals at this scale can silently gut a playlist;
// full replacements rewrite every item.
export const REMOVE_ELICIT_THRESHOLD = 10;
export const REPLACE_ELICIT_THRESHOLD = 50;

interface ElicitCapableServer {
  server: {
    getClientCapabilities?: () => { elicitation?: unknown } | undefined;
  };
  elicitInput: (request: {
    message: string;
    requestedSchema: Record<string, unknown>;
  }) => Promise<unknown>;
}

/**
 * True when the connected client advertised the elicitation capability.
 *
 * Elicitation is advertised BY THE CLIENT during initialization — the
 * accessor is `server.server.getClientCapabilities()` on the inner Server.
 * An earlier revision read the server's own declared capabilities here,
 * which are never set, silently disabling prompting in production; the
 * InMemoryTransport integration test catches that failure mode.
 */
export function supportsElicitation(server: unknown): boolean {
  if (typeof server !== 'object' || server === null) return false;
  try {
    const inner = (server as ElicitCapableServer).server;
    const caps =
      typeof inner?.getClientCapabilities === 'function'
        ? inner.getClientCapabilities()
        : undefined;
    return Boolean(caps?.elicitation);
  } catch {
    return false;
  }
}

/** Deterministic shared confirmation text for destructive operations. */
export function describeConfirmation(kind: string, target: string, changes: string[]): string {
  const lines = changes.map((c) => `- ${c}`);
  return [`About to ${kind} "${target}":`, ...lines, '', 'Proceed?'].join('\n');
}

type ElicitVerdict = 'confirmed' | 'declined' | 'unsupported';

interface ElicitResultShape {
  action?: string;
  content?: { confirm?: unknown };
}

function isElicitResult(value: unknown): value is ElicitResultShape {
  return typeof value === 'object' && value !== null && 'action' in value;
}

/**
 * Ask the user to confirm a destructive operation.
 * Returns 'confirmed' only on explicit accept + confirm=true; anything else
 * (decline, cancel, missing capability, transport error) is treated as not
 * confirmed. 'unsupported' means the caller should proceed without prompting.
 */
export async function confirmViaElicitation(
  server: unknown,
  opts: { message: string; confirmLabel?: string },
): Promise<ElicitVerdict> {
  // Escape hatch: automation/readonly contexts never prompt.
  if (process.env.SPOTIFY_MCP_CONFIRM === 'never') return 'unsupported';
  if (
    !supportsElicitation(server) ||
    typeof server !== 'object' ||
    server === null ||
    !('elicitInput' in server)
  ) {
    return 'unsupported';
  }

  try {
    const result = await (server as ElicitCapableServer).elicitInput({
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
    // Client without elicitation support errors on elicitInput — degrade to
    // unprompted operation rather than failing the tool call.
    return 'unsupported';
  }
}
