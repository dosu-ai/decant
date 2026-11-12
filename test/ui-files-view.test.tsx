import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_DATE_RANGE } from "../src/ui/date-range.ts";
import { FilesView } from "../src/ui/views/files.tsx";
import { readUiFile, sourceFrom, uiSourceFiles } from "./ui-source.ts";

describe("Files view requests", () => {
  test("opens on a loading state before its first response", () => {
    const html = renderToStaticMarkup(
      <FilesView
        dateBounds={null}
        dateRange={ALL_DATE_RANGE}
        onDateRangeChange={() => {}}
        reloadKey={0}
      />,
    );
    expect(html).toContain("Loading file activity");
    expect(html).not.toContain("No file activity");
  });

  test("only the Files view requests file activity", () => {
    // A page slice once loaded the default grouping too, so each visit sent
    // the same request twice.
    const callers = uiSourceFiles().filter((file) => readUiFile(file).includes("`/api/files?"));
    expect(callers).toEqual(["views/files.tsx"]);
    expect(readUiFile("views/files.tsx").match(/`\/api\/files\?/g)).toHaveLength(1);
  });

  test("reloads its table when the archive changes", () => {
    const view = sourceFrom(readUiFile("views/files.tsx"), "function FilesView(");
    expect(view).toContain("[dateRange, filesRetryKey, group, op, reloadKey]");
    const main = sourceFrom(readUiFile("main.tsx"), "<FilesView");
    expect(main.slice(0, main.indexOf("/>"))).toContain("reloadKey={actions.reloadKey}");
  });
});
