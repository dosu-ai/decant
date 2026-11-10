import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HTMLBundle } from "bun";
import { createUiFiles, UI_DOCUMENT_HEADERS, type UiBuilder } from "../src/server/ui.ts";

function prebuiltBundle(): HTMLBundle {
  const root = mkdtempSync(join(tmpdir(), "decant-ui-"));
  const index = join(root, "index-abc.html");
  const script = join(root, "chunk-def.js");
  writeFileSync(index, '<!doctype html><script type="module" src="/chunk-def.js"></script>');
  writeFileSync(script, "export {};");
  const headers = (contentType: string) => ({ etag: "x", "content-type": contentType });
  return {
    index,
    files: [
      { path: index, loader: "html", isEntry: true, headers: headers("text/html;charset=utf-8") },
      {
        path: script,
        loader: "js",
        isEntry: true,
        headers: headers("text/javascript;charset=utf-8"),
      },
    ],
  };
}

function sourceBuild(generation: number): Awaited<ReturnType<UiBuilder>> {
  const name = `/chunk-${generation}.js`;
  return {
    document: {
      body: new Blob([`<script src="${name}"></script>`]),
      contentType: "text/html;charset=utf-8",
    },
    assets: new Map([
      [name, { body: new Blob([`/* ${generation} */`]), contentType: "text/javascript" }],
    ]),
  };
}

describe("UI files", () => {
  test("a compiled bundle's shell carries the framing headers and its assets nosniff", async () => {
    const ui = createUiFiles(prebuiltBundle(), () => {
      throw new Error("a prebuilt bundle must not be rebuilt");
    });

    const shell = await ui.document();
    for (const [name, value] of Object.entries(UI_DOCUMENT_HEADERS)) {
      expect(shell.headers.get(name)).toBe(value);
    }
    expect(shell.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(await shell.text()).toContain('src="/chunk-def.js"');

    const script = ui.asset("/chunk-def.js");
    expect(script?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script?.headers.get("content-type")).toBe("text/javascript;charset=utf-8");
    expect(await script?.text()).toBe("export {};");
    expect(ui.asset("/index-abc.html")).toBeNull();
    expect(ui.asset("/missing.js")).toBeNull();
  });

  test("a source run rebuilds per shell request and keeps the previous build's assets", async () => {
    let builds = 0;
    const ui = createUiFiles({ index: "/src/ui/index.html" }, async () => sourceBuild(++builds));

    expect(ui.asset("/chunk-1.js")).toBeNull();
    const [first, concurrent] = await Promise.all([ui.document(), ui.document()]);
    expect(builds).toBe(1);
    expect(await first.text()).toContain("/chunk-1.js");
    expect(await concurrent.text()).toContain("/chunk-1.js");

    await ui.document();
    await ui.document();
    expect(builds).toBe(3);
    expect(ui.asset("/chunk-3.js")).not.toBeNull();
    expect(ui.asset("/chunk-2.js")).not.toBeNull();
    expect(ui.asset("/chunk-1.js")).toBeNull();
  });
});
