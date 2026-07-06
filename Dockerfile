# syntax=docker/dockerfile:1.7

# Builder tag must match .bun-version — CI asserts this (single source of truth
# for the Bun toolchain; the pin is load-bearing for macOS binary integrity too).
FROM oven/bun:1.3.9-slim AS build

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY npm ./npm
COPY scripts ./scripts
COPY src ./src

RUN bun install --frozen-lockfile

ARG TARGETPLATFORM
ARG DECANT_VERSION=0.0.0-dev
RUN case "${TARGETPLATFORM}" in \
      "linux/amd64") DECANT_TARGET="linux-x64" ;; \
      "linux/arm64") DECANT_TARGET="linux-arm64" ;; \
      *) echo "unsupported Docker target platform: ${TARGETPLATFORM}" >&2; exit 1 ;; \
    esac; \
    bun run scripts/build-binaries.ts --target "${DECANT_TARGET}" --out-dir /tmp/decant-bin --version "${DECANT_VERSION}"; \
    cp "/tmp/decant-bin/${DECANT_TARGET}/decant" /usr/local/bin/decant

# Runtime base pinned by digest for reproducibility; Dependabot maintains the
# digest (multi-arch OCI index digest for debian:bookworm-slim).
FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df AS runtime

RUN groupadd --system decant \
    && useradd --system --gid decant --home-dir /var/lib/decant --create-home decant \
    && mkdir -p /var/lib/decant /sources/claude /sources/codex \
    && chown -R decant:decant /var/lib/decant /sources

COPY --from=build /usr/local/bin/decant /usr/local/bin/decant

USER decant
WORKDIR /var/lib/decant

ENV DECANT_DB=/var/lib/decant/decant.db
ENV DECANT_CLAUDE_DIR=/sources/claude
ENV DECANT_CODEX_DIR=/sources/codex
ENV DECANT_TRUSTED_PEERS=172.16.0.0/12

VOLUME ["/var/lib/decant"]
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/decant"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3000", "--no-fs-watch", "--interval-ms", "45000"]
