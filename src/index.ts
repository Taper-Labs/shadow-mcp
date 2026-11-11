// Command-line entry. In server mode stdout carries only MCP messages;
// diagnostics go to stderr.

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { missingVaultMessage, resolveVault } from './locate.js';
import { createServer } from './server.js';
import { buildIndex, createVaultStore } from './vault.js';
import { VERSION } from './version.js';

const USAGE = `Usage: shadow-mcp [--vault <path>] [--check] [--version] [--help]

A read-only MCP server (stdio) for the meetings Shadow saves in its Vault folder.

  --vault <path>  The Vault folder (Shadow → Settings → Meeting → Vault location).
                  Also read from the SHADOW_VAULT environment variable.
  --check         Print the Vault path and counts, then exit.
  --version       Print the version.
  --help          Print this help.
`;

interface Options {
  vault?: string;
  check: boolean;
  version: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false, version: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--vault') {
      const value = argv[i + 1];
      // An empty value is allowed: installers may substitute an unset setting.
      if (value === undefined) throw new Error('--vault needs a folder path.');
      options.vault = value;
      i += 1;
    } else if (arg.startsWith('--vault=')) {
      options.vault = arg.slice('--vault='.length);
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(): void {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const vaultOptions = { flag: options.vault, env: process.env['SHADOW_VAULT'] };
  const findVault = () => resolveVault(vaultOptions);
  const missingMessage = missingVaultMessage(vaultOptions);

  if (options.check) {
    const root = findVault();
    if (!root) {
      process.stdout.write(`${missingMessage}\n`);
      process.exitCode = 1;
      return;
    }
    const index = buildIndex(root);
    const transcripts = index.meetings.filter((meeting) => meeting.hasTranscript).length;
    process.stdout.write(
      `Vault: ${index.root}\nMeetings: ${index.meetings.length}\nPeople: ${index.people.length}\nTranscripts: ${transcripts}\n`,
    );
    return;
  }

  const store = createVaultStore({ resolveRoot: findVault });
  const initial = findVault();
  process.stderr.write(initial ? `shadow-mcp ${VERSION}: serving the Vault at ${initial}\n` : `shadow-mcp ${VERSION}: ${missingMessage}\n`);
  serveStdio(() => createServer(store, missingMessage), {
    onerror: (error) => process.stderr.write(`shadow-mcp: ${error.message}\n`),
  });
}

main();
