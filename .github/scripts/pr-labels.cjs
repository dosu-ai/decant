// Size and area labels for pull requests, applied by .github/workflows/pr-labels.yml.
// The labels give a reviewer context at a glance; nothing gates on them.

// Tests, fixtures, goldens, and the lockfile are excluded from the size of a
// mixed pull request, so adding coverage does not make a change look riskier.
const NON_CODE = [/^test\//, /^fixtures\//, /^bun\.lock$/];

const SIZE_LABELS = [
  { name: "size:XS", max: 9, color: "0e8a16", range: "0-9" },
  { name: "size:S", max: 29, color: "5ebd3e", range: "10-29" },
  { name: "size:M", max: 99, color: "fbca04", range: "30-99" },
  { name: "size:L", max: 499, color: "fe7d37", range: "100-499" },
  { name: "size:XL", max: 999, color: "d93f0b", range: "500-999" },
  { name: "size:XXL", max: Number.POSITIVE_INFINITY, color: "b60205", range: "1,000+" },
].map((label) => ({
  ...label,
  description: `${label.range} changed lines, not counting tests, fixtures, or bun.lock in mixed pull requests.`,
}));

const AREA_LABELS = [
  {
    name: "area: sources",
    description: "Source parsers, discovery, and ingest.",
    paths: [/^src\/sources\//, /^src\/ingest\.ts$/, /^fixtures\//, /^docs\/adding-a-source\.md$/],
  },
  {
    name: "area: cost",
    description: "Model pricing and cost estimates.",
    paths: [/^src\/cost\.ts$/, /^docs\/pricing\.md$/],
  },
  {
    name: "area: schema",
    description: "Archive schema, migrations, and the ingest pipeline revision.",
    paths: [/^src\/db\.ts$/, /^src\/schema\.sql$/, /^src\/schema-manifest\.ts$/],
  },
  {
    name: "area: api",
    description: "The local API served by decant serve.",
    paths: [/^src\/server(\.ts|\/)/, /^src\/route-paths\.ts$/, /^docs\/api\//],
  },
  { name: "area: ui", description: "The web UI.", paths: [/^src\/ui\//] },
  { name: "area: cli", description: "CLI commands and output.", paths: [/^src\/cli(\.ts|\/)/] },
  {
    name: "area: distribution",
    description: "npm, Homebrew, Docker, the installer, and releases.",
    paths: [
      /^npm\//,
      /^packaging\//,
      /^install\.sh$/,
      /^Dockerfile$/,
      /^scripts\/(build-|dist-check|distribution|release)/,
      /^docs\/distribution\.md$/,
    ],
  },
  { name: "area: ci", description: "GitHub workflows and repository automation.", paths: [/^\.github\//] },
];

const AREA_COLOR = "c5def5";

function isNonCode(path) {
  return NON_CODE.some((pattern) => pattern.test(path));
}

/** files: [{ filename, additions, deletions }] as returned by pulls.listFiles. */
function effectiveLines(files) {
  const code = files.filter((file) => !isNonCode(file.filename));
  const counted = code.length > 0 ? code : files;
  return counted.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

function sizeLabel(files) {
  const lines = effectiveLines(files);
  return SIZE_LABELS.find((label) => lines <= label.max);
}

function areaLabels(files) {
  return AREA_LABELS.filter((area) =>
    files.some((file) => area.paths.some((pattern) => pattern.test(file.filename))),
  );
}

module.exports = { AREA_COLOR, AREA_LABELS, SIZE_LABELS, areaLabels, effectiveLines, sizeLabel };
