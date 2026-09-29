#!/usr/bin/env bun
import { log, requireEnv, runMain, warning } from "./actions.ts";
import { releaseVersion } from "./validate.ts";

export function manifestUrl(version: string): string {
  return `https://ghcr.io/v2/dosu-ai/decant/manifests/${version}`;
}

export function ghcrVisibility(
  status: number,
  version: string,
): { public: boolean; message: string } {
  if (status === 200) {
    return { public: true, message: "anonymous pull works (HTTP 200) — package is public" };
  }
  return {
    public: false,
    message: `ghcr.io/dosu-ai/decant:${version} is not anonymously pullable (HTTP ${status}). A GHCR package is private on first push and there is no API to change it. Set it to public once, by hand: https://github.com/orgs/dosu-ai/packages/container/decant/settings -> Danger Zone -> Change visibility. This is a one-time action; later releases inherit it.`,
  };
}

async function main(): Promise<void> {
  const version = releaseVersion(requireEnv("VERSION"));
  const response = await fetch(manifestUrl(version), { redirect: "manual" });
  const visibility = ghcrVisibility(response.status, version);
  if (visibility.public) {
    log(visibility.message);
  } else {
    warning(visibility.message);
  }
}

if (import.meta.main) {
  runMain(main);
}
