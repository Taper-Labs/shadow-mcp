# Shadow Meetings

Gives Claude read-only access to the meetings [Shadow](https://www.shadow.do) saves as Markdown on your Mac. Shadow is a Mac meeting-notes app; you need it installed, with at least one recorded meeting.

## What you can ask

- "What did I promise Acme in our calls since January?"
- "Find the meeting where we talked about the pricing change and quote what was said."
- "List my open action items from last week's meetings."
- "When did I last meet Dana, and what did we decide?"

## Tools

| Tool | What it does |
| --- | --- |
| `list_meetings` | Lists meetings, newest first, by date range or attendee |
| `search_meetings` | Finds meetings by words in titles, notes and transcripts |
| `get_meeting` | Reads one meeting: details, attendees and notes |
| `get_transcript` | Reads a meeting's transcript, with speakers and times |
| `list_action_items` | Collects the Action Items sections of meeting notes |
| `find_person` | Finds a person and the meetings they attended |

## What this plugin runs, sends and fetches

- It starts one local MCP server with `npx -y shadow-mcp@0.1.0`. The first start downloads that exact version of the `shadow-mcp` package from the npm registry. Source: <https://github.com/Taper-Labs/shadow-mcp>.
- The server reads Markdown files in your Shadow Vault folder (`Meetings/`, `People/` and `SHADOW.md`). It never writes, renames or deletes anything.
- The server makes no network requests and has no telemetry. It needs no account or API key.
- What Claude reads through these tools becomes part of your conversation, like any other text you give Claude.

## Setup

The plugin looks for your Vault in Shadow's default location (`~/Documents/Shadow`). If you chose another folder in Shadow under Settings → Meeting → Vault location, set that folder as the plugin's "Shadow Vault folder" option.

Requires macOS, the Shadow app, and Node.js 20 or later.

## License

[MIT](LICENSE)
