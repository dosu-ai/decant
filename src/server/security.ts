import type { RequestContext } from "./context.ts";
import { errorResponse } from "./http.ts";
import { isIpv4Loopback, isLoopbackPeer, isTrustedPeer, normalizeHost } from "./peers.ts";

export function validateLocalRequest(
  request: Request,
  url: URL,
  context: RequestContext,
): Response | null {
  if (!isProtectedPath(url.pathname)) {
    return null;
  }
  if (!isLoopbackHost(url.hostname)) {
    return errorResponse("forbidden_host", "forbidden host", {}, 403);
  }
  const boundToLoopback = isLoopbackHost(context.boundHostname ?? "127.0.0.1");
  if (
    !boundToLoopback &&
    !isLoopbackPeer(context.remoteAddress) &&
    !isTrustedPeer(context.remoteAddress, context.trustedPeers ?? [])
  ) {
    return errorResponse("forbidden_remote", "forbidden remote", {}, 403);
  }
  if (isMutatingMethod(request.method) && !isAllowedWriteRequest(request, url, boundToLoopback)) {
    return errorResponse("cross_origin_write", "cross-origin writes are forbidden", {}, 403);
  }
  return null;
}

function isProtectedPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isMutatingMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isAllowedWriteRequest(request: Request, url: URL, boundToLoopback: boolean): boolean {
  const origin = request.headers.get("origin");
  if (origin != null && !isSameAuthorityLoopbackOrigin(origin, request, url)) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (!boundToLoopback && origin == null && site == null) {
    return false;
  }
  return site == null || site === "same-origin" || site === "same-site" || site === "none";
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

// Any loopback port can host another dev server, so a loopback origin alone does
// not prove the page came from Decant. The Host header is compared rather than
// the bound port because port mappings such as `docker run -p 8080:3000` change
// what the browser sees without changing the Host/Origin pairing.
function isSameAuthorityLoopbackOrigin(origin: string, request: Request, url: URL): boolean {
  if (origin === "null") {
    return false;
  }
  const host = request.headers.get("host") ?? url.host;
  if (/[/?#@\\]/.test(host)) {
    return false;
  }
  let parsedOrigin: URL;
  let requested: URL;
  try {
    parsedOrigin = new URL(origin);
    requested = new URL(`${url.protocol}//${host}`);
  } catch {
    return false;
  }
  return isLoopbackHost(parsedOrigin.hostname) && authority(parsedOrigin) === authority(requested);
}

function authority(url: URL): string {
  return `${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol] || ""}`;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === "localhost" || normalized === "::1" || isIpv4Loopback(normalized);
}
