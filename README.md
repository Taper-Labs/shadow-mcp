# shadow-mcp

**A local, read-only MCP server for the meetings [Shadow](https://www.shadow.do) saves on your Mac.** Shadow is a Mac meeting-notes app that records calls without a bot, transcribes them on your Mac and saves every meeting as Markdown in a folder you own (the Vault). `shadow-mcp` lets Claude, Cursor, Codex and other MCP clients search and read that folder.

- Runs on your Mac over stdio. No account, no sign-in, no API key.
- Read-only. It never writes, renames or deletes a file.
- Makes no network requests and has no telemetry.
- Every meeting on every Shadow plan, with no history limit.

You need the Shadow Mac app (Apple Silicon, macOS 14.2 or later) with at least one recorded meeting. Download it at [shadow.do/download](https://www.shadow.do/download).

## Install

### Claude Desktop

Download [`shadow-mcp.mcpb`](https://github.com/Taper-Labs/shadow-mcp/releases/latest/download/shadow-mcp.mcpb), open it, and choose your Vault folder. Claude Desktop runs it with its built-in Node.js, so there is nothing else to install.

### Claude Code

```bash
claude mcp add shadow -- npx -y shadow-mcp
```

Or as a plugin:

```
/plugin marketplace add Taper-Labs/shadow-mcp
/plugin install shadow-meetings@shadow
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "shadow": { "command": "npx", "args": ["-y", "shadow-mcp"] } } }
```

### Codex

```bash
codex mcp add shadow -- npx -y shadow-mcp
```

### Any other MCP client

Run `npx -y shadow-mcp` as a stdio server. The `npx` routes need Node.js 20 or later.

## Where the Vault is

`shadow-mcp` looks for the Vault in Shadow's default locations, starting with `~/Documents/Shadow`. If you chose another folder in Shadow (Settings → Meeting → Vault location), pass it:

```bash
npx -y shadow-mcp --vault "/path/to/your/vault"
```

The `SHADOW_VAULT` environment variable does the same. To see what the server found:

```bash
npx -y shadow-mcp --check
```

It prints the Vault path and the number of meetings, people and transcripts.

## Tools

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `list_meetings` | Lists meetings, newest first, with title, date, times, attendees and which notes exist | `from`, `to`, `person`, `limit` |
| `search_meetings` | Finds meetings by words in titles, notes and transcripts; returns matching lines with speaker and time | `query`, `from`, `to`, `person`, `scope` |
| `get_meeting` | Reads one meeting: details, attendees, speaker assignments and its notes | `id`, `material` |
| `get_transcript` | Reads a meeting's transcript as written, in pages | `id`, `from_time`, `to_time` |
| `list_action_items` | Collects the "Action Items" section of each meeting's notes | `from`, `to`, `person`, `heading` |
| `find_person` | Finds a person by name or email, with their meetings | `query` |

Dates are `YYYY-MM-DD`. Results that are too long come in pages; pass `next_cursor` back as `cursor` to continue. A long list of attendees is shortened to fit, and `attendee_count` gives the exact number. Very long titles and names are shortened and end in `…`.

Shadow writes notes in the meeting's language, so a non-English meeting's "Action Items" heading is translated; when `list_action_items` finds notes without the heading, it returns the headings those notes use in `headings_seen` so the agent can ask again with the right one.

Things to ask once it is connected:

- "What did I promise Acme in our calls since January, and what is still open?"
- "Find the meeting where we discussed the pricing change and quote what was said."
- "List the action items from last week's meetings."
- "When did I last meet Dana, and what did we decide?"

## What it reads

Only `Meetings/`, `People/` and `SHADOW.md` inside the Vault: meeting pages, transcripts, and the Markdown notes next to them (Meeting Notes, Meeting Outline and other Skill results). It does not read audio or screenshots, and it skips `Unsynced Files/`, `Archived Vaults/`, hidden folders and symbolic links. A hard link is read like any other file. Transcripts over 4 MB (about 70 hours of speech) and other files over 2 MB are not read: `get_transcript` says the transcript is too large, search skips it, and such a note is listed with its size only.

Transcripts, attendees and search work on Shadow's Free plan. AI notes and action items exist for the meetings where Shadow Plus wrote them.

## Privacy and security

- The server sends nothing anywhere. It answers the MCP client that started it, on your Mac.
- What your agent reads through these tools goes to that agent's own AI provider, as with any file you give it. That includes what other people said in your meetings.
- Meeting text can contain sentences that read like instructions. The server tells the client to treat transcripts and notes as content, and every tool is read-only, but review what an agent does after it reads a meeting you do not trust.
- Tools take meeting ids and names, never file paths, and the server never follows a symbolic link out of the Vault.

## Troubleshooting

- **"No Shadow Vault was found"**: open Shadow → Settings → Meeting → Vault location, copy the path, and pass it with `--vault`.
- **macOS asks whether the app may access your Documents folder (or iCloud Drive)**: allow it. The request comes from the app that runs the server, such as Claude or your terminal.
- **A meeting is missing its notes or transcript**: if the Vault is in a cloud drive, the file may not be downloaded to this Mac yet. Open the meeting folder in Finder once.
- **No Vault folder at all**: the Vault arrived in Shadow 2.3. Update Shadow.

## Development

```bash
npm install
npm run build    # type check, then bundle to dist/index.js
npm test         # unit and integration tests
npm run lint
npm run bench    # 1,000 synthetic meetings: index and search timings
npm run pack:mcpb  # build shadow-mcp.mcpb for Claude Desktop
```

Tests write synthetic Vaults in temporary folders and never touch a real one.

## Support

Open an issue in this repository or email support@shadow.do.

## License

[MIT](LICENSE)
