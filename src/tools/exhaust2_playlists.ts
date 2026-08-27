/**
 * exhaust2 playlists slice — feature swarm v1.24.0.
 *
 * Owned by the fix/exhaust2-playlists builder. All tools in this slice are
 * registered here and nowhere else. Slice issue set: see GitHub issues
 * #332-#429 (exhaust2 swarm). Empty until the builder populates it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';

export function registerExhaust2PlaylistsTools(_server: McpServer, _client: SpotifyClient): void {
  // Populated by the exhaust2 playlists builder — do not register other slices here.
}
