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
import { registerUsersTools } from './tools/users.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'spotify-mcp',
    version,
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
  registerUsersTools(server, client);
  registerResources(server, client);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const HELP = `spotify-mcp — MCP server for the Spotify Web API

Usage:
  spotify-mcp            Start the MCP server over stdio (this is the default)
  spotify-mcp auth       Run the OAuth PKCE flow and save tokens
  spotify-mcp --help     Show this message
  spotify-mcp --version  Print the version

Environment:
  SPOTIFY_CLIENT_ID        Required (from developer.spotify.com dashboard)
  SPOTIFY_HEADLESS         Set to 1 for browserless paste-flow auth
  SPOTIFY_MCP_TOKEN_FILE   Token file override (default ~/.spotify-mcp/tokens.json)
`;
 const command = process.argv[2];
 
if (command === '--help' || command === '-h') {
  console.log(HELP);
} else if (command === '--version' || command === '-v') {
  const { createRequire } = await import('node:module');
  console.log('spotify-mcp ' + createRequire(import.meta.url)('../package.json').version);
} else if (command === 'auth') {
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
