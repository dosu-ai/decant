import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");

type Token = { name: string; hex: string };

const correct = (name: string): string =>
  name.replace("-switch-switc-active", "-switch-switch-active");

function flatten(theme: "Light" | "Dark"): Token[] {
  const tree = JSON.parse(readFileSync(join(root, "themes", `${theme}.tokens.json`), "utf8"));
  const colours = new Map<string, string>();
  const aliases = new Map<string, string>();

  const walk = (node: unknown, path: string[]): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.$type === "color") {
      const name = correct(`--${path.join("-")}`);
      const value = record.$value;
      if (typeof value === "string") {
        aliases.set(name, correct(`--${value.replace(/[{}]/g, "").split(".").join("-")}`));
        return;
      }
      const colour = value as { hex?: string; alpha?: number };
      if (colour?.hex) {
        const alpha = colour.alpha ?? 1;
        const suffix =
          alpha >= 1
            ? ""
            : Math.round(alpha * 255)
                .toString(16)
                .padStart(2, "0");
        colours.set(name, `${colour.hex.toLowerCase()}${suffix}`);
      }
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (!key.startsWith("$")) {
        walk(child, [...path, key]);
      }
    }
  };
  walk(tree, []);

  for (const [name, target] of aliases) {
    const resolved = colours.get(target);
    expect(resolved, `${name} aliases ${target}, which the export does not define`).toBeDefined();
    colours.set(name, resolved as string);
  }
  return [...colours].map(([name, hex]) => ({ name, hex }));
}

function blockAfter(marker: string, closer: string): string {
  const start = styles.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf(closer, start + marker.length);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

const lightBlock = blockAfter(":root {\n  color-scheme: light;", "\n}");
const darkBlock = blockAfter('[data-theme="dark"] {\n  color-scheme: dark;', "\n}");

function tokenValue(name: string, block: string): string | undefined {
  return new RegExp(`^\\s*${name}:\\s*([^;]+);`, "im").exec(block)?.[1]?.trim();
}

type Rgba = { r: number; g: number; b: number; a: number };

function parseColour(value: string): Rgba | undefined {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
      a: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(
    value.trim(),
  );
  if (!rgba) {
    return undefined;
  }
  return {
    r: Number(rgba[1]),
    g: Number(rgba[2]),
    b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

function sameColour(a: Rgba, b: Rgba): boolean {
  if (a.a === 0 && b.a === 0) {
    return true;
  }
  return (
    Math.abs(a.r - b.r) <= 1 &&
    Math.abs(a.g - b.g) <= 1 &&
    Math.abs(a.b - b.b) <= 1 &&
    Math.abs(a.a - b.a) <= 1 / 255
  );
}

type ThemeName = "Light" | "Dark";
const THEMES: Array<[ThemeName, string]> = [
  ["Light", lightBlock],
  ["Dark", darkBlock],
];

const DEVIATIONS: Record<string, { instead: string; because: string }> = {
  "Light/--effects-focus-ring": {
    instead: "var(--sky-700)",
    because:
      "the exported sky/400 measures 1.60:1 against the light surfaces and WCAG 2.2 " +
      "1.4.11 requires 3:1 for a focus indicator. sky/700 measures 4.44:1. Dark keeps " +
      "the exported value, which measures 7.06:1 there.",
  },
};

describe("Figma token parity", () => {
  test("the exports are vendored and cover the same variables", () => {
    const [light, dark] = [flatten("Light"), flatten("Dark")];
    expect(light.length).toBeGreaterThan(60);
    expect(new Set(dark.map((token) => token.name))).toEqual(
      new Set(light.map((token) => token.name)),
    );
  });

  test.each(THEMES)("%s declares every variable in the export", (name, block) => {
    const missing = flatten(name)
      .map((token) => token.name)
      .filter((token) => tokenValue(token, block) === undefined);
    expect(missing).toEqual([]);
  });

  test.each(THEMES)("%s aliases resolve to the exported colour", (name, block) => {
    const primitives = blockAfter(":root {\n  --alpha-light-00:", "\n}");
    const wrong: string[] = [];
    for (const token of flatten(name)) {
      const declared = tokenValue(token.name, block);
      if (declared === undefined || DEVIATIONS[`${name}/${token.name}`]) {
        continue;
      }
      let resolved: string | undefined = declared;
      for (let hop = 0; hop < 8; hop++) {
        const target: string | undefined = /^var\((--[a-z0-9-]+)\)$/.exec(resolved ?? "")?.[1];
        if (!target) {
          break;
        }
        resolved = tokenValue(target, primitives) ?? tokenValue(target, block);
      }
      const actual = parseColour(resolved ?? "");
      const expected = parseColour(token.hex);
      if (!actual || !expected) {
        wrong.push(`${token.name}: unparseable (${resolved})`);
        continue;
      }
      if (!sameColour(actual, expected)) {
        wrong.push(`${token.name}: ${resolved} != ${token.hex}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test.each(THEMES)("%s chart literals match the tokens they duplicate", (name, block) => {
    const exported = new Map(flatten(name).map((token) => [token.name, token.hex]));
    const sourced: Array<[string, string]> = [
      ["--fg", "--fg-primary"],
      ["--muted", "--fg-secondary"],
      ["--faint", "--fg-tertiary"],
      ["--line", "--border-default"],
      ["--accent", "--fg-brand"],
      ["--success", "--fg-status-success"],
      ["--warning", "--fg-status-warning"],
    ];
    for (const [literal, source] of sourced) {
      const actual = parseColour(tokenValue(literal, block) ?? "");
      const expected = parseColour(exported.get(source) ?? "");
      expect(actual, `${literal} is unparseable`).toBeDefined();
      expect(expected, `${source} missing from the ${name} export`).toBeDefined();
      expect(
        sameColour(actual as Rgba, expected as Rgba),
        `${literal} (${tokenValue(literal, block)}) has drifted from ${source} (${exported.get(source)})`,
      ).toBe(true);
    }

    const card = parseColour(exported.get("--bg-card") ?? "") as Rgba;
    const page = parseColour(exported.get("--bg-primary") ?? "") as Rgba;
    const surface = parseColour(tokenValue("--surface", block) ?? "") as Rgba;
    expect(card).toBeDefined();
    expect(page).toBeDefined();
    expect(surface).toBeDefined();
    const composited = {
      r: card.r * card.a + page.r * (1 - card.a),
      g: card.g * card.a + page.g * (1 - card.a),
      b: card.b * card.a + page.b * (1 - card.a),
      a: 1,
    };
    expect(
      sameColour(surface, composited),
      `--surface (${tokenValue("--surface", block)}) is not bg/card over bg/primary`,
    ).toBe(true);
  });

  test("the radius scale matches the Figma export", () => {
    for (const [name, value] of [
      ["--radius-none", "0px"],
      ["--radius-2xs", "2px"],
      ["--radius-xs", "4px"],
      ["--radius-sm", "6px"],
      ["--radius-md", "8px"],
      ["--radius-lg", "12px"],
      ["--radius-xl", "16px"],
      ["--radius-2xl", "24px"],
      ["--radius-3xl", "28px"],
      ["--radius-full", "9999px"],
    ] as const) {
      expect(new RegExp(`^\\s*${name}:\\s*${value};`, "m").test(styles)).toBe(true);
    }
  });

  test("no radius is left as a bare pixel literal", () => {
    const literals = [...styles.matchAll(/border(?:-\w+)*-radius:\s*([^;]+);/g)]
      .map((match) => match[1] ?? "")
      .filter((value) => /\d+px/.test(value));
    expect(literals).toEqual([]);
  });

  test("each deliberate deviation remains explicit", () => {
    expect(Object.keys(DEVIATIONS)).toHaveLength(1);
    for (const [key, deviation] of Object.entries(DEVIATIONS)) {
      const [theme, token] = key.split("/") as [ThemeName, string];
      const block = theme === "Light" ? lightBlock : darkBlock;
      expect(tokenValue(token, block), `${key} should be ${deviation.instead}`).toBe(
        deviation.instead,
      );
      expect(deviation.because.length).toBeGreaterThan(40);
    }
  });

  test("every font-size is on the type scale", () => {
    const allowed = new Set(["12px", "13px", "14px", "16px", "20px", "28px"]);
    const offScale = [...styles.matchAll(/font-size:\s*([^;]+);/g)]
      .map((match) => (match[1] ?? "").trim())
      .filter(
        (value) =>
          !allowed.has(value) && value !== "var(--text-micro-size)" && !/^[\d.]+em$/.test(value),
      );
    expect(offScale).toEqual([]);
  });

  test("every font-weight is one of the three named weights", () => {
    const withoutFontFace = styles.replace(/@font-face \{[^}]*\}/g, "");
    const bare = [...withoutFontFace.matchAll(/font-weight:\s*([^;]+);/g)]
      .map((match) => (match[1] ?? "").trim())
      .filter((value) => !/^var\(--font-weight-(regular|medium|strong)\)$/.test(value));
    expect(bare).toEqual([]);
    const faces = [...styles.matchAll(/@font-face \{[^}]*\}/g)].map((match) => match[0]);
    expect(faces).toHaveLength(3);
    for (const face of faces) {
      expect(face).toMatch(/font-weight: \d+;/);
    }
  });

  test("uppercase labels use the design's mono tracking", () => {
    const emTracking = [...styles.matchAll(/letter-spacing:\s*([\d.]+em);/g)].map(
      (match) => match[1],
    );
    expect(emTracking).toEqual([]);
  });

  test("no design-system token is left unwired without a reason", () => {
    const completeRamps =
      /^--(space|text|radius|alpha|zinc|sky|green|red|orange|lime|cyan|blue|indigo|violet|fuchsia|pink|brand|amber|bw|font)-/;
    const expectedOrphans: Record<string, string> = {
      "--bg-components-checkbox-checkbox": "app has no checkbox",
      "--bg-components-checkbox-checkbox-active": "app has no checkbox",
      "--bg-components-checkbox-checkbox-active-hover": "app has no checkbox",
      "--bg-components-checkbox-checkbox-disabled": "app has no checkbox",
      "--bg-components-switch-switch": "app has no switch",
      "--bg-components-switch-switch-active": "app has no switch",
      "--bg-components-switch-switch-active-disabled": "app has no switch",
      "--bg-components-switch-switch-active-hover": "app has no switch",
      "--bg-components-switch-switch-disabled": "app has no switch",
      "--bg-components-switch-switch-handle": "app has no switch",
      "--bg-components-switch-switch-handle-disabled": "app has no switch",
      "--bg-components-switch-switch-hover": "app has no switch",
      "--shadow-switch-handle": "app has no switch",
      "--bg-components-badge-blue": "hue not mapped to an app tone",
      "--bg-components-badge-blue-accent": "hue not mapped to an app tone",
      "--bg-components-badge-green": "hue not mapped to an app tone",
      "--bg-components-badge-green-accent": "hue not mapped to an app tone",
      "--bg-components-badge-pink": "hue not mapped to an app tone",
      "--bg-components-badge-pink-accent": "hue not mapped to an app tone",
      "--bg-components-badge-violet": "hue not mapped to an app tone",
      "--bg-components-badge-violet-accent": "hue not mapped to an app tone",
      "--bg-components-ghost-ghost": "the transparent ghost base; nothing needs to name it",
      "--border-brand": "used in the designed screens; not attributable to an app element yet",
      "--border-inverted": "no inverted-edge element",
      "--border-white": "no white-edge element",
      "--fg-brand": "the app reaches --accent, which the parity test pins to it",
      "--fg-inverted":
        "pure inverted ink; the one place that wanted it (the primary button label) " +
        "takes fg/inverted-secondary, as the designed screen does",
      "--fg-status-success": "the app reaches --success, pinned to this by parity",
      "--fg-status-warning": "the app reaches --warning, pinned to this by parity",
      "--ease-in-out":
        "for on-screen movement; the only movement here is the drawer, on --ease-drawer",
      "--claude-strong": "reserved brand pair",
    };

    const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = [...withoutComments.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(
      (match) => match[1] as string,
    );
    const used = new Set(
      [...withoutComments.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1] as string),
    );
    const orphans = [...new Set(declared)]
      .filter((token) => !used.has(token) && !completeRamps.test(token))
      .sort();

    expect(orphans).toEqual(Object.keys(expectedOrphans).sort());
  });

  test("no var() names a token that is never declared", () => {
    const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = new Set(
      [...withoutComments.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] as string),
    );
    declared.add("--depth");
    const undeclared = [
      ...new Set(
        [...withoutComments.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1] as string),
      ),
    ]
      .filter((token) => !declared.has(token))
      .sort();
    expect(undeclared).toEqual([]);
  });

  test("durations and easings come from the motion tokens", () => {
    const timings = [...styles.matchAll(/transition:([^;]+);/g)]
      .map((match) => match[1] ?? "")
      .filter((value) => /\d+(?:\.\d+)?m?s/.test(value));
    expect(timings).toEqual([]);
    expect(styles).not.toMatch(/transition[^;]*cubic-bezier\(/);
  });
});
