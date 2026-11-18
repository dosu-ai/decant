import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncButton } from "../src/ui/sync-button.tsx";

const topbar = (busy: boolean, label: "Sync" | "Update") =>
  renderToStaticMarkup(
    <SyncButton
      ariaLabel="Sync session logs"
      busy={busy}
      label={label}
      labels={["Sync", "Update"]}
      onClick={() => {}}
      update={label === "Update"}
    />,
  );

test("a busy sync button keeps its label so the button does not shrink", () => {
  const html = renderToStaticMarkup(
    <SyncButton ariaLabel="Re-sync session logs" busy label="Re-sync" onClick={() => {}} />,
  );
  expect(html).toContain('<span data-active="true">Re-sync</span>');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("disabled");
  expect(html).toContain("is-syncing");
});

test("the topbar button lays out every label in each state so its width never changes", () => {
  for (const html of [topbar(false, "Sync"), topbar(true, "Sync"), topbar(false, "Update")]) {
    expect(html).toContain(">Sync</span>");
    expect(html).toContain(">Update</span>");
  }
  expect(topbar(false, "Update")).toContain('<span data-active="true">Update</span>');
  expect(topbar(false, "Update")).toContain("has-update");
  expect(topbar(false, "Sync")).not.toContain("has-update");
});

test("phone widths show the topbar sync button as an icon so the topbar does not overflow", () => {
  const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8");
  const phone = styles.slice(styles.indexOf("@media (max-width: 767px) {"));
  expect(phone.slice(0, phone.indexOf("\n}\n"))).toMatch(
    /\.topbar \.sync-button-label \{\s*display: none;/,
  );
});
