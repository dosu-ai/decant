export type ToolCallStatus = {
  icon: "check" | "minus" | "x";
  label: "Completed" | "Error" | "No result" | "OK" | "Unknown";
  title: string | null;
  tone: "danger" | "neutral" | "success";
};

export function toolCallStatus(isError: boolean | null, hasResult: boolean | null): ToolCallStatus {
  if (isError === true) {
    return { icon: "x", label: "Error", title: null, tone: "danger" };
  }
  if (isError === false) {
    return { icon: "check", label: "OK", title: null, tone: "success" };
  }
  if (hasResult === true) {
    return {
      icon: "check",
      label: "Completed",
      title: "A result was recorded, but the source did not classify it as success or error.",
      tone: "neutral",
    };
  }
  if (hasResult === false) {
    return {
      icon: "minus",
      label: "No result",
      title: "No result was recorded for this call.",
      tone: "neutral",
    };
  }
  return {
    icon: "minus",
    label: "Unknown",
    title: "This legacy record does not say whether the call produced a result.",
    tone: "neutral",
  };
}
