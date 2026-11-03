import { spawnSync } from "node:child_process";
import {
  checkForUpdate,
  detectInstall,
  planUpdate,
  replaceBinary,
  reportedVersion,
  sameVersion,
  type UpdateStatus,
} from "../../update.ts";
import type { CliContext } from "../context.ts";

export function registerUpdateCommand(ctx: CliContext): void {
  ctx.program
    .command("update")
    .description("update Decant in place using the tool that installed it")
    .option("--check", "report whether a newer release exists without installing it")
    .action((commandOptions: { check?: boolean }) =>
      ctx.run(async () => {
        const deps = ctx.updateDeps;
        const env = ctx.env ?? process.env;
        const install = deps.install ?? detectInstall();
        // The user asked, so this contacts the registry even with checks off.
        const status = await checkForUpdate({
          env: ctx.env,
          homeDir: ctx.homeDir,
          install,
          current: deps.current,
          fetch: deps.fetch,
          now: deps.now,
          force: true,
        });
        // A failed check still returns the cached version, which is fine
        // for a nudge but too stale to install.
        if (status.error != null || status.latest == null) {
          ctx.io.writeErr(
            `error: could not check for updates: ${status.error ?? "no version found"}\n`,
          );
          return 1;
        }

        const plan = planUpdate(install, status.latest);
        if (commandOptions.check === true || !status.updateAvailable) {
          ctx.output({ ...status, updated: false }, () => renderStatus(status));
          return;
        }

        if (plan.kind === "manual") {
          ctx.output({ ...status, updated: false, instructions: plan.instructions }, () =>
            [
              `Decant ${label(status.latest)} is available (you have ${label(status.current)}).`,
              plan.instructions,
              "",
            ].join("\n"),
          );
          return;
        }

        const human = !ctx.isJson();
        if (plan.kind === "run") {
          if (human) {
            ctx.io.writeOut(
              `Updating Decant ${label(status.current)} to ${label(status.latest)}: ${plan.argv.join(" ")}\n`,
            );
          }
          const code = (deps.runCommand ?? runPackageManager)(plan.argv);
          if (code !== 0) {
            ctx.io.writeErr(`error: ${plan.argv[0]} exited with code ${code}\n`);
            return 1;
          }
          // brew says "already installed" and exits 0 when the tap is behind
          // npm, so the exit code alone does not prove the update landed.
          const installed = (deps.installedOnPath ?? installedOnPath)();
          if (installed != null && !sameVersion(installed.version, status.latest)) {
            ctx.io.writeErr(
              `error: ${plan.argv[0]} finished, but ${installed.path} reports ${installed.version ?? "no version"}, not ${status.latest}. ` +
                "New releases reach npm a few minutes before Homebrew, so try again shortly. " +
                "If another decant comes earlier on PATH, update that copy instead.\n",
            );
            return 1;
          }
        } else {
          if (human) {
            ctx.io.writeOut(`Downloading Decant ${label(status.latest)}...\n`);
          }
          await replaceBinary({
            binaryPath: plan.binaryPath,
            version: status.latest,
            baseUrl: env.DECANT_BASE_URL,
            fetch: deps.fetch,
          });
        }
        ctx.output(
          { ...status, updated: true },
          () => `Updated Decant to ${label(status.latest)}.\n`,
        );
      }),
    );
}

function renderStatus(status: UpdateStatus): string {
  if (status.channel === "source") {
    return `This is a source checkout (${status.current}). The latest release is ${label(status.latest)}.\n`;
  }
  if (!status.updateAvailable) {
    return `Decant ${label(status.current)} is up to date.\n`;
  }
  return `Decant ${label(status.latest)} is available (you have ${label(status.current)}). Run: ${status.command}\n`;
}

export function label(version: string | null): string {
  if (version == null || version === "dev" || version.startsWith("v")) {
    return version ?? "unknown";
  }
  return `v${version}`;
}

function installedOnPath(): { path: string; version: string | null } | null {
  const path = Bun.which("decant");
  return path == null ? null : { path, version: reportedVersion(path) };
}

// The package manager's progress goes to stderr so `--json` keeps stdout to
// one JSON document.
function runPackageManager(argv: string[]): number {
  const [bin, ...args] = argv;
  const result = spawnSync(bin ?? "", args, { stdio: ["inherit", 2, 2] });
  if (result.error != null) {
    throw new Error(`could not run ${bin}: ${result.error.message}`);
  }
  return result.status ?? 1;
}
