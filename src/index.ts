import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow } from './auth.js';
import { SpotifyClient } from './client.js';
import { registerPlaybackTools } from './tools/playback.js';
import { registerSearchTools } from './tools/search.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerPersonalizationTools } from './tools/personalization.js';
import { registerLibraryTools } from './tools/library.js';
import { registerFollowingTools } from './tools/following.js';
import { registerAudiobookTools } from './tools/audiobooks.js';
import { registerPlaylistTools } from './tools/playlists.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'spotify-mcp',
    version: '1.0.0',
  });

  const client = new SpotifyClient();

  registerPlaybackTools(server, client);
  registerSearchTools(server, client);
  registerCatalogTools(server, client);
  registerPersonalizationTools(server, client);
  registerLibraryTools(server, client);
  registerFollowingTools(server, client);
  registerAudiobookTools(server, client);
  registerPlaylistTools(server, client);
  registerResources(server, client);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const command = process.argv[2];

if (command === 'auth') {
  runAuthFlow().catch((err: unknown) => {
    console.error('Auth failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  startMcpServer().catch((err: unknown) => {
    console.error('Server error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
