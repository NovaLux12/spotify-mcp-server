/**
 * Credential-hygiene guard (#699).
 *
 * Spotify's Developer Terms (Sec. VI.1.a) define the Client ID as a Security
 * Code, and Sec. VI.1.c/d forbid disclosing it. Shipping instructions that ask
 * a user to paste that value into an LLM conversation therefore pushes a
 * credential into a third party's transcript, shell history, and context
 * window. This guard fails if that pattern returns to README.md, the skills, or
 * the docs, and if the doctor skill goes back to telling an agent to perform a
 * client-credentials exchange (this server is PKCE-only and never uses
 * SPOTIFY_CLIENT_SECRET).
 *
 * The assertions below target the concrete recurrence — a "paste here" slot for
 * the client ID, and a `grant_type=client_credentials` / Basic-auth recipe —
 * rather than merely checking that a file lacks the word "secret".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DOCTOR_SKILL = 'skills/spotify-mcp-doctor/SKILL.md';

function readDoc(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function markdownFilesIn(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk(relativeDir);
  return out.sort();
}

/** Every prose surface an agent may read before configuring the server. */
function guardedDocs(): Array<{ file: string; text: string }> {
  const files = [
    'README.md',
    ...markdownFilesIn('skills'),
    ...markdownFilesIn('docs'),
  ];
  return files.map(file => ({ file, text: readDoc(file) }));
}

/** Slice the README's "Paste this to your agent" onboarding block. */
function readmeAgentBlock(text: string): string {
  const start = text.search(/^> ### .*Paste this to your agent.*$/m);
  assert.notEqual(start, -1, 'README.md no longer has a "Paste this to your agent" block');
  const rest = text.slice(start);
  const end = rest.search(/^---$/m);
  assert.notEqual(end, -1, 'README agent block is not terminated by a horizontal rule');
  return rest.slice(0, end);
}

/**
 * Split Markdown into sentence-sized statements. Line-wrapped prose is
 * rejoined first so a prohibitive sentence split across two lines ("...never
 * sends or / reads a client secret...") is judged as one statement, and each
 * list bullet stays its own statement. Fenced blocks are left intact on
 * purpose: a credential recipe is most likely to hide inside one. Abbreviations
 * that end in a period are masked so "Sec. VI.1.a" is not a sentence break.
 */
function statements(text: string): string[] {
  const SENTINEL = '@DOT@';
  const masked = text.replace(/\b(Sec|Art|ex|e\.g|i\.e|vs)\./gi, `$1${SENTINEL}`);
  const out: string[] = [];
  for (const block of masked.split(/\n{2,}/)) {
    for (const bullet of block.split(/\n(?=\s*[-*>]|\s*\d+\.\s)/)) {
      const joined = bullet.replace(/\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!joined) continue;
      for (const sentence of joined.split(/(?<=[.!?:])\s+(?=[A-Z*`#([])/)) {
        if (sentence.trim()) out.push(sentence.trim().split(SENTINEL).join('.'));
      }
    }
  }
  return out;
}

const SECRET_MENTION = /client[\s_-]*secrets?/i;

/**
 * A client secret may be named only in a statement that tells the reader it is
 * unused/unwanted. These markers make an explanatory mention explicit; a
 * statement that names a secret with none of them is an instruction to go get
 * one.
 */
const EXPLANATORY_MARKERS = [
  /\bnot\s+(?:used|supported|needed|required)\b/i,
  /\bno\s+client\s+secret\b/i,
  /\bnever\b/i,
  /\bdo\s+not\b/i,
  /\bignored\b/i,
  /\bremove\s+it\b/i,
  /\bwithout\s+(?:a\s+)?secret\b/i,
  /\bredact/i,
  /\bconfidentiality\b/i,
];

describe('credential hygiene in shipped instructions (#699)', () => {
  const docs = guardedDocs();

  it('README onboarding block offers no slot for pasting a credential', () => {
    const block = readmeAgentBlock(readDoc('README.md'));

    // The literal slots shipped before the fix.
    assert.doesNotMatch(
      block,
      /<paste[\s_-]*(?:here|it)\b/i,
      'README agent block still contains a "<paste here>" placeholder for a credential',
    );
    assert.doesNotMatch(
      block,
      /(?:my|your)\s+spotify\s+client\s+id\s*:/i,
      'README agent block still ends with a "My Spotify Client ID:" paste slot',
    );
    assert.doesNotMatch(
      block,
      /SPOTIFY_CLIENT_ID\s*=\s*[<$"'{]/,
      'README agent block still exports SPOTIFY_CLIENT_ID from a value the user pastes into chat',
    );
    assert.doesNotMatch(
      block,
      /client\s+id\s+i\s+paste/i,
      'README agent block still invites the user to paste a Client ID back to the agent',
    );
  });

  it('README onboarding block warns against pasting credentials and routes the ID out of the transcript', () => {
    const block = readmeAgentBlock(readDoc('README.md'));

    assert.match(
      block,
      /never\s+paste[^.\n]*credential/i,
      'README agent block is missing an adjacent "never paste your credentials" warning',
    );
    assert.match(
      block,
      /developer\.spotify\.com\/terms/,
      'README agent block must link the Spotify Developer Terms that define the Client ID as a Security Code',
    );
    assert.match(
      block,
      /\.env|host\s+(?:config|configuration)/i,
      'README agent block must point at a non-conversational place to set SPOTIFY_CLIENT_ID',
    );
    assert.match(
      block,
      /spotify_doctor|get_me/,
      'README agent block must verify the install with an MCP tool instead of echoing the credential',
    );
  });

  it('no skill or doc instructs a client-credentials exchange', () => {
    const forbidden: Array<[RegExp, string]> = [
      [/grant_type=client_credentials/i, 'a client_credentials grant body'],
      [/authorization\s*:\s*basic/i, 'an Authorization: Basic header'],
      [/base64\s*\(\s*client_id/i, 'a base64(client_id:...) credential encoder'],
      [/client[\s_-]*credentials\s+(?:grant|flow|exchange)/i, 'a client-credentials exchange instruction'],
      [/needs?\s+the\s+dashboard\s+secret/i, 'an instruction to fetch the dashboard client secret'],
    ];

    for (const { file, text } of docs) {
      for (const [pattern, what] of forbidden) {
        assert.doesNotMatch(text, pattern, `${file} still documents ${what}`);
      }
    }
  });

  it('the doctor skill documents the expected 401 from the unauthenticated probe', () => {
    const doctor = readDoc(DOCTOR_SKILL);
    const probeStart = doctor.search(/## Probe 3/);
    assert.notEqual(probeStart, -1, `${DOCTOR_SKILL} has no Probe 3 section`);
    const unauthProbe = doctor.slice(probeStart, doctor.search(/## Probe 4/));

    assert.match(
      unauthProbe,
      /401/,
      `${DOCTOR_SKILL} Probe 3 must state that the unauthenticated probe returns 401`,
    );
    assert.match(
      unauthProbe,
      /expected/i,
      `${DOCTOR_SKILL} Probe 3 must mark 401 as the expected result so agents do not debug it`,
    );
    assert.match(
      unauthProbe,
      /unauthenticated/i,
      `${DOCTOR_SKILL} Probe 3 must keep the unauthenticated reachability probe`,
    );
  });

  it('a client secret is only ever named in an explanatory, prohibitive sentence', () => {
    const offenders: string[] = [];

    for (const { file, text } of docs) {
      for (const statement of statements(text)) {
        if (!SECRET_MENTION.test(statement)) continue;
        if (EXPLANATORY_MARKERS.some(marker => marker.test(statement))) continue;
        offenders.push(`${file}: ${statement}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'These statements name a client secret without telling the reader it is unused:\n' +
        offenders.join('\n'),
    );
  });
});
