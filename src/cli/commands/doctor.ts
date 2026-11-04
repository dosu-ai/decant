import { CUSTOM_PATH, collectDoctorReport, type DoctorReport } from "../../doctor.ts";
import type { CliContext } from "../context.ts";
import { label } from "./update.ts";

export function registerDoctorCommand(ctx: CliContext): void {
  ctx.program
    .command("doctor")
    .description("print a redacted environment report to paste into a bug report")
    .action(() =>
      ctx.run(() => {
        const report = collectDoctorReport(ctx.resolve(), {
          env: ctx.env,
          homeDir: ctx.homeDir,
          install: ctx.updateDeps.install,
        });
        ctx.output(report, () => renderDoctor(report));
      }),
    );
}

export function renderDoctor(report: DoctorReport): string {
  const row = (name: string, value: string): string => `${name.padEnd(16)}${value}\n`;
  const archive = report.archive;
  const archiveSessions = Object.entries(archive.sessions)
    .map(([tool, n]) => `${tool} ${n}`)
    .join(", ");
  let archiveLine = `${archive.path} `;
  if (!archive.exists) {
    archiveLine += "(not created yet)";
  } else if (archive.error != null) {
    archiveLine += `(unreadable: ${archive.error})`;
  } else {
    archiveLine += `(${archive.size_bytes ?? 0} bytes${archiveSessions === "" ? "" : `; ${archiveSessions}`})`;
  }

  const lines = [
    row("decant", `${label(report.decant_version)} (${report.install_channel})`),
    row("platform", `${report.platform}, ${report.os_release}, Bun ${report.bun_version}`),
    row(
      "schema",
      `archive ${report.archive.schema_version == null ? "none" : `v${report.archive.schema_version}`}, ` +
        `supported v${report.supported_schema_version}, ingest revision ${report.ingest_pipeline_revision}`,
    ),
    row("update check", report.update_check ? "on" : "off"),
    row("archive", archiveLine),
    "sources\n",
    ...report.sources.map(
      (source) =>
        `  ${source.tool.padEnd(14)}${source.roots.join(", ").padEnd(28)}` +
        `${source.exists ? `${source.found} found` : "not found"}\n`,
    ),
  ];
  if (report.discovery_error != null) {
    lines.push(row("discovery", `failed: ${report.discovery_error}`));
  }
  if (report.discovery_warnings.length > 0) {
    lines.push(row("warnings", report.discovery_warnings.join(", ")));
  }
  lines.push(row("env", report.env.length === 0 ? "none set" : report.env.join(", ")));
  lines.push(
    `\nNo transcript content is included. Paths outside your home directory show as ${CUSTOM_PATH}.\n`,
  );
  return lines.join("");
}
