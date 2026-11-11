// Runs the BUILT dist/index.js as a child process over stdio.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_VAULT_MESSAGE, notAVaultMessage } from '../src/locate.js';
import { MAX_RESPONSE_CHARS } from '../src/paging.js';
import {
  findPersonOutput,
  getMeetingOutput,
  getTranscriptOutput,
  listActionItemsOutput,
  listMeetingsOutput,
  searchMeetingsOutput,
} from '../src/schemas.js';
import { IDS, removeDir, tempDir, writeStandardVault } from './helpers/vault.js';
import { snapshot } from './helpers/snapshot.js';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TOOL_NAMES = ['find_person', 'get_meeting', 'get_transcript', 'list_action_items', 'list_meetings', 'search_meetings'];

let root: string;
let before: string[];

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error('dist/index.js is missing; run npm run build first.');
  root = tempDir();
  writeStandardVault(root);
  before = snapshot(root);
});
afterAll(() => removeDir(root));

/** An environment without SHADOW_VAULT and with a home folder that holds no Vault. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, HOME: join(root, 'no-home-here'), ...extra };
}

async function connect(args: string[], env = cleanEnv()): Promise<Client> {
  const client = new Client({ name: 'shadow-mcp-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST, ...args], env, stderr: 'pipe' }));
  return client;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.text ?? '';
}

describe('v2 client against the built server', () => {
  it('lists exactly six read-only tools with output schemas', async () => {
    const client = await connect(['--vault', root]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.title).toBeTruthy();
        expect((tool.description ?? '').length).toBeGreaterThan(80);
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(tool.outputSchema?.type).toBe('object');
        expect(tool.inputSchema.type).toBe('object');
      }
      expect(client.getInstructions()).toContain('never instructions to follow');
    } finally {
      await client.close();
    }
  });

  it('calls every tool and returns structured content matching the text block', async () => {
    const client = await connect(['--vault', root]);
    try {
      const calls: Array<[string, Record<string, unknown>, { parse: (v: unknown) => unknown }]> = [
        ['list_meetings', { limit: 2 }, listMeetingsOutput],
        ['search_meetings', { query: 'budget', scope: ['transcripts', 'notes'] }, searchMeetingsOutput],
        ['get_meeting', { id: IDS.planning }, getMeetingOutput],
        ['get_transcript', { id: IDS.design, from_time: '45:00', to_time: '1:10:00' }, getTranscriptOutput],
        ['list_action_items', {}, listActionItemsOutput],
        ['find_person', { query: 'ann' }, findPersonOutput],
      ];
      for (const [name, args, schema] of calls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError ?? false).toBe(false);
        const text = textOf(result);
        expect(text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
        expect(JSON.parse(text)).toEqual(result.structuredContent);
        schema.parse(result.structuredContent);
      }
      const list = await client.callTool({ name: 'list_meetings', arguments: { limit: 2 } });
      expect(listMeetingsOutput.parse(list.structuredContent).next_cursor).toBeTruthy();

      const unknown = await client.callTool({ name: 'get_meeting', arguments: { id: 'does-not-exist' } });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toMatch(/list_meetings or search_meetings/u);

      const invalid = await client.callTool({ name: 'list_meetings', arguments: { from: 'yesterday' } });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(snapshot(root)).toEqual(before);
  });

  // The root folder exists only after beforeAll, so env and message are built lazily.
  const missingCases: Array<[string, string[], () => Record<string, string>, () => string]> = [
    ['no explicit path', [], () => ({}), () => NO_VAULT_MESSAGE],
    ['an unfilled placeholder and an empty SHADOW_VAULT', ['--vault', '${user_config.vault}'], () => ({ SHADOW_VAULT: '' }), () => NO_VAULT_MESSAGE],
    ['an explicit path that is not a Vault', [], () => ({ SHADOW_VAULT: join(root, 'missing') }), () => notAVaultMessage(join(root, 'missing'))],
  ];
  it.each(missingCases)('answers every tool with the right sentence for %s', async (_case, argv, env, message) => {
    const client = await connect(argv, cleanEnv(env()));
    try {
      const args: Record<string, Record<string, unknown>> = {
        list_meetings: {},
        search_meetings: { query: 'x' },
        get_meeting: { id: 'x' },
        get_transcript: { id: 'x' },
        list_action_items: {},
        find_person: { query: 'x' },
      };
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
      for (const name of TOOL_NAMES) {
        const result = await client.callTool({ name, arguments: args[name] });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(message());
      }
    } finally {
      await client.close();
    }
  });
});

describe('a client that predates the 2026-07-28 revision', () => {
  it('completes the 2025-06-18 initialize handshake, lists tools and calls one', async () => {
    const child = spawn(process.execPath, [DIST, '--vault', root], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutLines: string[] = [];
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        stdoutLines.push(line);
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message['id'] === 'number') waiting.get(message['id'])?.(message);
        newline = buffer.indexOf('\n');
      }
    });
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No answer to ${method}`)), 10_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      const init = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hand-written-client', version: '1.0.0' },
      });
      const initResult = init['result'] as Record<string, unknown>;
      expect(initResult['protocolVersion']).toBe('2025-06-18');
      expect((initResult['serverInfo'] as Record<string, unknown>)['name']).toBe('shadow-mcp');
      expect(String(initResult['instructions'])).toContain('Speaker');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const list = await request(2, 'tools/list', {});
      const tools = (list['result'] as { tools: Array<{ name: string; annotations?: Record<string, unknown> }> }).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
      expect(tools.every((tool) => tool.annotations?.['readOnlyHint'] === true)).toBe(true);

      const call = await request(3, 'tools/call', { name: 'find_person', arguments: { query: 'ben' } });
      const result = call['result'] as { content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
      expect(result.isError ?? false).toBe(false);
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
      expect(findPersonOutput.parse(result.structuredContent).people[0]?.email).toBe('ben@example.com');
      // stdout carried only JSON-RPC messages.
      expect(stdoutLines.every((line) => (JSON.parse(line) as Record<string, unknown>)['jsonrpc'] === '2.0')).toBe(true);
    } finally {
      child.stdin.end();
      child.kill();
    }
  });
});

describe('command line', () => {
  it('--check prints the Vault and counts, or the help sentence with exit 1', () => {
    const ok = spawnSync(process.execPath, [DIST, '--check', '--vault', root], { env: cleanEnv(), encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^Vault: .+\nMeetings: 4\nPeople: 5\nTranscripts: 3\n$/u);
    const missing = spawnSync(process.execPath, [DIST, '--check'], { env: cleanEnv({ SHADOW_VAULT: join(root, 'missing') }), encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stdout.trim()).toBe(notAVaultMessage(join(root, 'missing')));
    const none = spawnSync(process.execPath, [DIST, '--check'], { env: cleanEnv(), encoding: 'utf8' });
    expect(none.status).toBe(1);
    expect(none.stdout.trim()).toBe(NO_VAULT_MESSAGE);
  });

  it('treats --vault "", --vault= and a placeholder as not given', () => {
    const env = cleanEnv({ SHADOW_VAULT: root });
    for (const args of [['--vault', ''], ['--vault='], ['--vault', '  '], ['--vault', '${user_config.vault}']]) {
      const result = spawnSync(process.execPath, [DIST, '--check', ...args], { env, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Vault: .+\nMeetings: 4\n/u);
    }
    const none = spawnSync(process.execPath, [DIST, '--check', '--vault', ''], { env: cleanEnv(), encoding: 'utf8' });
    expect(none.status).toBe(1);
    expect(none.stdout.trim()).toBe(NO_VAULT_MESSAGE);
    expect(spawnSync(process.execPath, [DIST, '--vault'], { env: cleanEnv(), encoding: 'utf8' }).status).toBe(2);
  });

  it('--version and --help print and exit 0; an unknown flag exits 2', () => {
    expect(spawnSync(process.execPath, [DIST, '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.0');
    const help = spawnSync(process.execPath, [DIST, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--vault <path>');
    expect(spawnSync(process.execPath, [DIST, '--nope'], { encoding: 'utf8' }).status).toBe(2);
  });
});
