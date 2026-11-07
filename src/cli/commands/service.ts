import { DEFAULT_SERVE_PORT } from "../../serve-defaults.ts";
import {
  installService,
  type ServiceStatus,
  ServiceUnavailableError,
  serviceStatus,
  uninstallService,
} from "../../service.ts";
import type { CliContext } from "../context.ts";
import { parseInteger } from "../parse.ts";

export function registerServiceCommands(ctx: CliContext): void {
  const service = ctx.program
    .command("service")
    .description("run Decant in the background: start it at login and keep it running");

  service
    .command("status", { isDefault: true })
    .description("report whether the background service is installed and running")
    .action(() =>
      ctx.run(async () => {
        const status = await serviceStatus(ctx.serviceOptions);
        ctx.output(status, () => renderStatus(status));
      }),
    );

  service
    .command("install")
    .description("start Decant at login and now, serving the UI and syncing in the background")
    .option("--port <n>", "port the service serves the UI on", parseInteger, DEFAULT_SERVE_PORT)
    .action((commandOptions: { port?: number }) =>
      ctx.run(async () => {
        const config = ctx.resolve();
        try {
          const status = await installService(
            { dbPath: config.dbPath, port: commandOptions.port ?? DEFAULT_SERVE_PORT },
            ctx.serviceOptions,
          );
          ctx.output(status, () =>
            [
              `Decant now runs in the background at ${status.url ?? "its configured port"}.`,
              "It starts when you log in. A `decant serve` already using that port keeps it until it stops.",
              "Stop it with: decant service uninstall",
            ].join("\n"),
          );
        } catch (error) {
          if (error instanceof ServiceUnavailableError) {
            ctx.io.writeErr(`error: ${error.message}\n`);
            return 1;
          }
          throw error;
        }
      }),
    );

  service
    .command("uninstall")
    .description("stop the background service and stop starting it at login")
    .action(() =>
      ctx.run(async () => {
        const status = await uninstallService(ctx.serviceOptions);
        ctx.output(status, () =>
          status.running
            ? "Removed the login item, but the service is still running. Check `decant service status`."
            : "Decant no longer runs in the background. Run `decant` to start it by hand.",
        );
      }),
    );
}

function renderStatus(status: ServiceStatus): string {
  if (!status.supported) {
    return `Background service: unavailable. ${status.reason ?? ""}`.trimEnd();
  }
  const state = status.running ? "running" : status.installed ? "installed, not running" : "off";
  const lines = [`Background service: ${state} (${status.manager})`];
  if (status.url != null && status.installed) {
    lines.push(`  URL:       ${status.url}`);
  }
  if (status.unitPath != null && status.installed) {
    lines.push(`  Unit file: ${status.unitPath}`);
  }
  if (!status.installed) {
    lines.push("  Turn it on with: decant service install");
  }
  return lines.join("\n");
}
