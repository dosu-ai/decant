export type ToolCallStatus = {
  icon: "check" | "minus" | "x";
  label: "Error" | "OK" | "Unknown";
  title: string | null;
  tone: "danger" | "neutral" | "success";
};

export function toolCallStatus(isError: boolean | null): ToolCallStatus {
  if (isError === true) {
    return { icon: "x", label: "Error", title: null, tone: "danger" };
  }
  if (isError === false) {
    return { icon: "check", label: "OK", title: null, tone: "success" };
  }
  return {
    icon: "minus",
    label: "Unknown",
    title: "The archive can't determine whether this call failed.",
    tone: "neutral",
  };
}
