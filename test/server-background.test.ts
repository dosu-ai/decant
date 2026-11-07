import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
): Promise<Response> {
  return handleRequest(
    new Request("http://127.0.0.1:3000/api/background", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    config,
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
