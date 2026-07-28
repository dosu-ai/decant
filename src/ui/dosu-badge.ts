export interface DosuEvidence {
  directCalls: number;
  treeCalls: number;
}

export function dosuBadgeVisualLabel(compact: boolean): "Dosu" | "Optimized by Dosu" {
  return compact ? "Dosu" : "Optimized by Dosu";
}

export function dosuNestedCalls(evidence: DosuEvidence): number {
  return Math.max(0, evidence.treeCalls - evidence.directCalls);
}

export function dosuBadgeAriaLabel(evidence: DosuEvidence): string {
  const calls = Math.max(0, evidence.treeCalls);
  return `Optimized by Dosu; Dosu MCP used ${calls} ${calls === 1 ? "time" : "times"}`;
}

export function dosuEvidenceSummary(evidence: DosuEvidence): string {
  const tree = Math.max(0, evidence.treeCalls);
  const direct = Math.max(0, evidence.directCalls);
  const nested = dosuNestedCalls(evidence);
  return `${tree} verified tool ${tree === 1 ? "call" : "calls"} across this session tree · ${direct} direct · ${nested} nested · aggregate only`;
}
