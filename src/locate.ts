// Finding the Vault folder: --vault, then SHADOW_VAULT, then the folders the
// Shadow app uses by default. Read-only checks only.

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readVaultText } from './files.js';
import { parseFrontmatter } from './markdown.js';

export const NO_VAULT_MESSAGE =
  'No Shadow Vault was found, so open Shadow → Settings → Meeting → Vault location, copy that folder path and pass it with --vault (or set SHADOW_VAULT).';

/** The error for an explicit path that is not a Vault. */
export function notAVaultMessage(path: string): string {
  return `"${path}" is not a Shadow Vault folder. Open Shadow → Settings → Meeting → Vault location, copy that folder path and pass it with --vault (or set SHADOW_VAULT).`;
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasVaultGuide(root: string): boolean {
  return parseFrontmatter(readVaultText(root, 'SHADOW.md')).data.get('type')?.trim() === 'shadow-vault';
}

/** Looks for a meeting page under `rel` (inside the real `root`) without following symbolic links. */
function hasMeetingPage(root: string, rel: string, depth: number): boolean {
  if (depth > 6) return false;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      if (parseFrontmatter(readVaultText(root, child)).data.get('type')?.trim().toLowerCase() === 'meeting') return true;
    } else if (entry.isDirectory() && hasMeetingPage(root, child, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** A folder is a Vault when it holds a `SHADOW.md` guide or at least one meeting page under `Meetings/`. */
export function isVaultFolder(path: string): boolean {
  if (!isDirectory(path)) return false;
  try {
    const root = realpathSync(path);
    if (hasVaultGuide(root)) return true;
    return lstatSync(join(root, 'Meetings')).isDirectory() && hasMeetingPage(root, 'Meetings', 0);
  } catch {
    return false;
  }
}

function numberedSiblings(parent: string, baseName: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const numbered = names
    .filter((name) => name.startsWith(`${baseName} `) && /^\d+$/u.test(name.slice(baseName.length + 1)))
    .sort((a, b) => Number(a.slice(baseName.length + 1)) - Number(b.slice(baseName.length + 1)));
  return [join(parent, baseName), ...numbered.map((name) => join(parent, name))];
}

/** The app's default Vault folders: `~/Documents/Shadow`, then `Vault` in its Application Support data folder. */
export function defaultVaultCandidates(home = homedir()): string[] {
  const userData = join(home, 'Library', 'Application Support', 'Shadow', 'User Data');
  return [
    ...numberedSiblings(join(home, 'Documents'), 'Shadow'),
    ...numberedSiblings(userData, 'Vault'),
    ...numberedSiblings(userData, 'Shadow'),
  ];
}

/** A usable explicit value: trimmed, and not empty or an unfilled `${...}` client placeholder. */
function explicitValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !trimmed.includes('${') ? trimmed : undefined;
}

interface VaultOptions {
  flag?: string | undefined;
  env?: string | undefined;
  home?: string;
}

/** The absolute path given by `--vault` or `SHADOW_VAULT`, or undefined when neither is given. */
export function explicitVaultPath(options: VaultOptions): string | undefined {
  const explicit = explicitValue(options.flag) ?? explicitValue(options.env);
  return explicit ? resolve(expandHome(explicit)) : undefined;
}

/** The sentence to show when `resolveVault` finds nothing for these options. */
export function missingVaultMessage(options: VaultOptions): string {
  const explicit = explicitVaultPath(options);
  return explicit ? notAVaultMessage(explicit) : NO_VAULT_MESSAGE;
}

/**
 * The Vault root to use, or null. An explicit `--vault` or `SHADOW_VAULT`
 * is the only candidate when given, so a wrong path is reported instead of
 * silently serving another folder.
 */
export function resolveVault(options: VaultOptions): string | null {
  const explicit = explicitVaultPath(options);
  const candidates = explicit ? [explicit] : defaultVaultCandidates(options.home).map((candidate) => resolve(candidate));
  return candidates.find(isVaultFolder) ?? null;
}
