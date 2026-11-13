import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../src/config.ts";
import type { RequestContext } from "../src/server/context.ts";
import { handleRequest } from "../src/server.ts";
import type { CommandResult, ServiceOptions } from "../src/service.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-background-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
const config = { dbPath: join(workDir, "decant.db") } as Config;

function fakeService(env: Record<string, string> = {}): {
  options: ServiceOptions;
  calls: string[];
  run: (argv: string[]) => Promise<CommandResult>;
} {
  counter += 1;
  const calls: string[] = [];
  let loaded = false;
  const run = async (argv: string[]): Promise<CommandResult> => {
    calls.push(argv.join(" "));
    if (argv[1] === "print") {
      return loaded
        ? { code: 0, stdout: "\tstate = running\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "" };
    }
    if (argv[1] === "bootstrap") loaded = true;
    if (argv[1] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    run,
    options: {
      platform: "darwin",
      env,
      homeDir: join(workDir, `home-${counter}`),
      uid: 501,
      run,
      install: { channel: "installer", binaryPath: "/opt/test/decant" },
      execPath: "/opt/test/decant",
    },
  };
}

function post(
  body: unknown,
  context: RequestContext,
  headers: Record<string, string> = {},
  serverConfig: Config = config,
): Promise<Response> {
  return handleRequest(
    new Request("http://127.0.0.1:3000/api/background", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    serverConfig,
    context,
  );
}

const settle = () => Bun.sleep(400);

describe("/api/background", () => {
  test("turning it on from a terminal server hands off this server's port", async () => {
    const { options } = fakeService();
    let shutdowns = 0;
    const response = await post(
      { enabled: true },
      { service: options, boundPort: 3000, requestShutdown: () => shutdowns++ },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      installed: true,
      running: true,
      url: "http://127.0.0.1:3000",
      handoff: true,
      stopping: false,
    });
    // The server answers before it steps aside.
    expect(shutdowns).toBe(0);
    await settle();
    expect(shutdowns).toBe(1);
  });

  test("hands off a server started with a relative --db to the same archive", async () => {
    const { options } = fakeService();
    const response = await post(
      { enabled: true },
      { service: options, boundPort: 3000, requestShutdown: () => undefined },
      {},
      { dbPath: "relative-archive.db" } as Config,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { command: string[]; handoff: boolean };
    expect(body.handoff).toBe(true);
    expect(body.command[2]).toBe(resolve("relative-archive.db"));
    await settle();
  });

  test("does not hand off when nothing can stop this server", async () => {
    const { options } = fakeService();
    const response = await post({ enabled: true }, { service: options, boundPort: 3000 });
    expect(await response.json()).toMatchObject({ installed: true, handoff: false });
  });

  test("turning it off from inside the service answers before stopping itself", async () => {
    const { options, calls } = fakeService({ DECANT_SERVICE: "1" });
    await post({ enabled: true }, { service: options, boundPort: 3000 });
    calls.length = 0;
    const response = await post({ enabled: false }, { service: options, boundPort: 3000 });
    expect(await response.json()).toMatchObject({
      installed: false,
      current: true,
      stopping: true,
    });
    expect(calls.some((call) => call.includes("bootout"))).toBe(false);
    await settle();
    expect(calls).toContain("launchctl bootout gui/501/dev.dosu.decant");
  });

  test("only a loopback peer may change it", async () => {
    const { options } = fakeService();
    const response = await post(
      { enabled: true },
      {
        service: options,
        boundHostname: "0.0.0.0",
        remoteAddress: "192.168.1.20",
        trustedPeers: ["192.168.1.0/24"],
      },
      // Passes the general write guard, so the route's own check decides.
      { "sec-fetch-site": "same-origin" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden_remote" });
  });

  test("rejects anything but a single enabled boolean", async () => {
    const { options } = fakeService();
    for (const body of [{}, { enabled: "yes" }, { enabled: true, port: 1 }]) {
      const response = await post(body, { service: options });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
  });

  test("reports an archive or executable path with a control character as a conflict", async () => {
    const { options, calls } = fakeService();
    const unsafeDb = { dbPath: join(workDir, "a.db\nExecStartPre=/bin/false") } as Config;
    const db = await post({ enabled: true }, { service: options }, {}, unsafeDb);
    expect(db.status).toBe(409);
    expect(await db.json()).toMatchObject({
      code: "background_unsupported",
      error: expect.stringContaining("control character"),
    });

    const binary = "/opt/test/decant\nExecStartPre=/bin/false";
    const exec = await post(
      { enabled: true },
      {
        service: {
          ...options,
          install: { channel: "installer", binaryPath: binary },
          execPath: binary,
        },
      },
    );
    expect(exec.status).toBe(409);
    expect(await exec.json()).toMatchObject({ code: "background_unsupported" });
    expect(calls.some((call) => call.includes("bootstrap"))).toBe(false);
  });

  test("passes on the launchd error when launchd refuses a step", async () => {
    const { options, run: fallback } = fakeService();
    const run = async (argv: string[]): Promise<CommandResult> =>
      argv[1] === "bootstrap"
        ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
        : fallback(argv);
    const response = await post({ enabled: true }, { service: { ...options, run } });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "background_failed",
      error: expect.stringContaining("Bootstrap failed: 5: Input/output error"),
    });
  });

  test("keeps any other failure's details out of the response", async () => {
    const { options } = fakeService();
    for (const thrown of [
      new Error("EACCES: permission denied, open '/opt/test/private/unit.plist'"),
      "raw failure at /opt/test/private",
    ]) {
      const run = async (): Promise<CommandResult> => {
        throw thrown;
      };
      const response = await post({ enabled: true }, { service: { ...options, run } });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe("internal_error");
      expect(body.error).not.toContain("private");
    }
  });

  test("reports unsupported installs as a conflict", async () => {
    const { options } = fakeService();
    const response = await post(
      { enabled: true },
      { service: { ...options, install: { channel: "npx", binaryPath: null } } },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "background_unsupported" });
  });
});
