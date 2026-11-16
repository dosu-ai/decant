import openApiSource from "../docs/api/openapi.yaml";

interface OpenApiDocument {
  info: {
    version: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

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
