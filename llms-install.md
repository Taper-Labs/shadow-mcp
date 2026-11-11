# Installing shadow-mcp (for AI agents)

`shadow-mcp` is a local stdio MCP server. It needs macOS, Node.js 20 or later, and the Shadow Mac app with a Vault folder. It needs no API key, account or environment variable.

1. Add this server to the MCP client's configuration:

   ```json
   {
     "mcpServers": {
       "shadow": {
         "command": "npx",
         "args": ["-y", "shadow-mcp"]
       }
     }
   }
   ```

2. Check that it found the user's Vault:

   ```bash
   npx -y shadow-mcp --check
   ```

   It prints the Vault path and the number of meetings. If it prints "No Shadow Vault was found", ask the user for the folder shown in Shadow under Settings → Meeting → Vault location and add it to the arguments:

   ```json
   "args": ["-y", "shadow-mcp", "--vault", "/path/to/the/vault"]
   ```

3. The server exposes six read-only tools: `list_meetings`, `search_meetings`, `get_meeting`, `get_transcript`, `list_action_items`, `find_person`. Call `list_meetings` with no arguments to confirm it works.
