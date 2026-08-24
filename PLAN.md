# MCP v2 Migration Plan

## Goal

Upgrade the proxy to the MCP TypeScript SDK v2 and make it work reliably with modern and legacy MCP clients and upstream servers, including `rmcp`.

## Compatibility strategy

- Keep the compact gateway interface as the default client-facing surface:
  - `discover_tools`
  - `execute_tool`
  - `batch_execute`
- Do not rely on client-name detection or assume native Tool Search support.
- Keep allow/deny filtering, vector search, routing, statistics, logging, and reconnect behavior.
- Negotiate the upstream MCP protocol automatically and fall back to legacy clients/servers.
- Preserve legacy HTTP and stdio compatibility during migration.

## Migration steps

1. Inspect `package.json`, lockfiles, TypeScript configuration, and all MCP imports.
2. Replace the monolithic `@modelcontextprotocol/sdk` dependency with:
   - `@modelcontextprotocol/client`
   - `@modelcontextprotocol/server`
   - `@modelcontextprotocol/core`
   - `@modelcontextprotocol/node` for Node HTTP transport support
   - `@modelcontextprotocol/express` for Express integration
3. Update all imports from the v1 package to their v2 package locations.
4. Update the upstream `Client` to use:

   ```ts
   versionNegotiation: { mode: "auto" }
   ```

   This should prefer the modern stateless protocol and fall back to the legacy handshake.

5. Update proxy server startup and transports to the v2 serving APIs while retaining legacy compatibility.
6. Ensure `tools/list` exposes only the compact gateway tools by default, so all agent clients remain supported.
7. Ensure `ALLOW_TOOLS` and `DENY_TOOLS` apply before indexing and execution.
8. Add or update tests for:
   - legacy MCP upstreams
   - modern MCP upstreams
   - `rmcp` stdio upstreams
   - proxy stdio clients
   - proxy Streamable HTTP clients
   - reconnect and tool-list change notifications
   - filtered tools and unauthorized execution attempts
9. Remove the v1 dependency only after no source files import it.
10. Run type checking, tests, and a production build.

## Acceptance criteria

- No source import references `@modelcontextprotocol/sdk`.
- The proxy starts in both stdio and HTTP modes.
- Existing clients continue to connect.
- Modern clients can negotiate MCP `2026-07-28` where supported.
- Older clients and `rmcp` servers continue through fallback negotiation.
- Agents receive a small, stable tool surface instead of every upstream schema.
- Tool search, execution, filtering, metrics, and reconnect behavior remain functional.

## Important limitation

Native client-side Tool Search is not a standard MCP capability. The proxy therefore keeps its own compact discovery gateway as the universal default rather than guessing which clients support native Tool Search.
