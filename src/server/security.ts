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
  if (isMutatingMethod(request.method) && !isAllowedWriteRequest(request, boundToLoopback)) {
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

function isAllowedWriteRequest(request: Request, boundToLoopback: boolean): boolean {
  const origin = request.headers.get("origin");
  if (origin != null && !isLoopbackOrigin(origin)) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (!boundToLoopback && origin == null && site == null) {
    return false;
  }
  return site == null || site === "same-origin" || site === "same-site" || site === "none";
}

function isLoopbackOrigin(origin: string): boolean {
  if (origin === "null") {
    return false;
  }
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === "localhost" || normalized === "::1" || isIpv4Loopback(normalized);
}
