import openApiSource from "../docs/api/openapi.yaml";

interface OpenApiDocument {
  info: {
    version: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Return the embedded local API contract with the running build's version.
 *
 * Bun resolves the YAML import at build time, so native binaries and packaged
 * launchers do not depend on a repository checkout or runtime docs directory.
 */
export function openApiDocument(version: string): OpenApiDocument {
  const source = openApiSource as OpenApiDocument;
  return {
    ...source,
    info: {
      ...source.info,
      version,
    },
  };
}
