// Builds shadow-mcp.mcpb, the one-file bundle Claude Desktop installs.
// Run `npm run pack:mcpb`, which builds dist/index.js first.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stage = `${root}build/mcpb`;
const output = `${root}shadow-mcp.mcpb`;

const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const manifest = JSON.parse(readFileSync(`${root}manifest.json`, 'utf8'));
if (manifest.version !== version) {
  throw new Error(`manifest.json is ${manifest.version} but package.json is ${version}; make them match.`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(`${stage}/server`, { recursive: true });
writeFileSync(`${stage}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(`${root}dist/index.js`, `${stage}/server/index.js`);
cpSync(`${root}assets/icon.png`, `${stage}/icon.png`);
cpSync(`${root}LICENSE`, `${stage}/LICENSE`);

rmSync(output, { force: true });
execFileSync(`${root}node_modules/.bin/mcpb`, ['pack', stage, output], { stdio: 'inherit' });
rmSync(`${root}build`, { recursive: true, force: true });
