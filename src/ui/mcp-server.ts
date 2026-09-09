/** MCP server display names, shared with `recommendations.ts` so the Insights
 * cards and the Tools & MCP tables name a server the same way. The logic lives
 * in `src/mcp-names.ts`; this keeps `main.tsx` importing from `./` like the
 * rest of the UI. */
export {
  formatMcpServer,
  mcpServerLabel,
  mcpServerLabels,
  mcpServerOrigin,
} from "../mcp-names.ts";
