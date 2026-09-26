/**
 * `--import` entry that installs the module-load recorder (#906).
 *
 * Pass the destination through the environment so the test controls it:
 *   SPOTIFY_MCP_MODULE_LOAD_RECORD=/path/to/record.txt
 */
import { register } from 'node:module';

const recordFile = process.env.SPOTIFY_MCP_MODULE_LOAD_RECORD;
if (!recordFile) {
  throw new Error('SPOTIFY_MCP_MODULE_LOAD_RECORD must point at a file to append module URLs to');
}
register('./module-load-recorder.mjs', import.meta.url, { data: { recordFile } });
