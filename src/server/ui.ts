import { dirname } from "node:path";
import type { BuildArtifact, HTMLBundle } from "bun";

/** Sent with every UI document. The SPA can delete sessions, change settings,
 * and register a login item, and a click inside a cross-origin frame reaches
 * the API as a same-origin request that the write guard cannot tell apart from
 * a real one. Browsers must therefore refuse to frame the page at all.
 * `frame-ancestors` is the only CSP directive here because a source run's
 * bundle comes from Bun's bundler, whose output is not pinned by this file; a
 * script policy that rejected it would blank the UI. */
export const UI_DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

interface UiFile {
  body: Blob;
  contentType: string;
}

interface UiBuild {
  document: UiFile;
  /** Keyed by request path, e.g. `/chunk-abc123.js`. */
  assets: ReadonlyMap<string, UiFile>;
}

export type UiBuilder = (entrypoint: string) => Promise<UiBuild>;

export interface UiFiles {
  /** The SPA shell, served for every UI route. */
  document(): Promise<Response>;
  /** A bundled script, stylesheet, or image the shell links, or null. */
  asset(pathname: string): Response | null;
}

/** Serves the UI bundle with security headers. Bun's own HTMLBundle route has
 * no way to add response headers, so Decant serves the bundle's files itself.
 * A compiled binary carries prebuilt files. A source run bundles the HTML
 * entrypoint on each document request, as Bun's development server did, so a
 * reload still picks up UI edits. */
export function createUiFiles(bundle: HTMLBundle, build: UiBuilder = buildUi): UiFiles {
  let current: UiBuild | null = bundle.files == null ? null : prebuiltUi(bundle);
  const prebuilt = current != null;
  // A page loaded just before a rebuild still requests the chunks it links, so
  // the previous build's assets stay reachable for one more generation.
  let previous: UiBuild | null = null;
  let pending: Promise<UiBuild> | null = null;

  const latest = (): Promise<UiBuild> => {
    if (prebuilt && current != null) {
      return Promise.resolve(current);
    }
    pending ??= build(bundle.index)
      .then((next) => {
        previous = current;
        current = next;
        return next;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    async document() {
      const { document } = await latest();
      return fileResponse(document, { ...UI_DOCUMENT_HEADERS, "cache-control": "no-cache" });
    },
    asset(pathname) {
      const file = current?.assets.get(pathname) ?? previous?.assets.get(pathname);
      if (file == null) {
        return null;
      }
      // Bundled asset names carry a content hash, so a cached copy never goes stale.
      return fileResponse(file, {
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=31536000, immutable",
      });
    },
  };
}

function fileResponse(file: UiFile, headers: Record<string, string>): Response {
  return new Response(file.body, { headers: { ...headers, "content-type": file.contentType } });
}

function prebuiltUi(bundle: HTMLBundle): UiBuild {
  // Prebuilt paths sit under the compiled binary's virtual root next to the
  // shell, and the shell links them from the site root.
  const root = dirname(bundle.index);
  let document: UiFile | null = null;
  const assets = new Map<string, UiFile>();
  for (const output of bundle.files ?? []) {
    const file = { body: Bun.file(output.path), contentType: output.headers["content-type"] };
    if (output.path === bundle.index) {
      document = file;
    } else {
      assets.set(output.path.slice(root.length), file);
    }
  }
  if (document == null) {
    throw new Error(`prebuilt UI bundle is missing its HTML shell ${bundle.index}`);
  }
  return { document, assets };
}

async function buildUi(entrypoint: string): Promise<UiBuild> {
  // publicPath "/" makes the shell link assets from the site root, matching a
  // compiled binary, so deep routes such as /sessions/42 resolve them.
  const result = await Bun.build({ entrypoints: [entrypoint], target: "browser", publicPath: "/" });
  return fromArtifacts(result.outputs);
}

function fromArtifacts(outputs: BuildArtifact[]): UiBuild {
  let document: UiFile | null = null;
  const assets = new Map<string, UiFile>();
  for (const output of outputs) {
    const file = { body: output, contentType: output.type };
    if (output.kind === "entry-point" && output.path.endsWith(".html")) {
      document = file;
    } else {
      assets.set(output.path.replace(/^\.\//, "/"), file);
    }
  }
  if (document == null) {
    throw new Error("UI build produced no HTML shell");
  }
  return { document, assets };
}
