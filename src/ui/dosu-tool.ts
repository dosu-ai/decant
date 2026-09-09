import { isDosuServer } from "../dosu.ts";
import { classifyTool } from "../tools.ts";

export function isDosuToolName(toolName: string | null | undefined): boolean {
  if (toolName == null) {
    return false;
  }
  return isDosuServer(classifyTool(toolName).mcpServer);
}

export function dosuToolDisplayName(toolName: string | null | undefined): string {
  if (toolName == null || toolName === "") {
    return "Dosu tool";
  }
  return classifyTool(toolName).baseName || toolName;
}
