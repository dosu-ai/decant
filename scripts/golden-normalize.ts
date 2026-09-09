export function stripGoldenVolatility(
  value: unknown,
  decantVersion: string,
  key: string | null = null,
): unknown {
  if (typeof value === "string") {
    if ((key === "version" || key === "generated_with") && value === decantVersion) {
      return "0.0.0-dev";
    }
    if (key === "artifact") {
      return value.replaceAll(`Decant ${decantVersion}`, "Decant 0.0.0-dev");
    }
    if (key === "href") {
      return value.replace(/^\/sessions\/\d+(?=#message-\d+$)/, "/sessions/<ID>");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => stripGoldenVolatility(child, decantVersion));
  }
  if (value != null && typeof value === "object") {
    const volatileKeys = new Set(["id", "session_id", "block_id"]);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([childKey]) => !volatileKeys.has(childKey))
        .map(([childKey, child]) => [
          childKey,
          stripGoldenVolatility(child, decantVersion, childKey),
        ]),
    );
  }
  return value;
}
