# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS build

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY npm ./npm
COPY scripts ./scripts
COPY src ./src
COPY docs/api/openapi.yaml ./docs/api/openapi.yaml

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

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

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
# The archive is served without credentials and the `Host` header is forgeable
# by any non-browser client, so the peer's source address is the only real
# boundary. Ship no peer allowlist: a baked-in CIDR handed the whole archive to
# every address in it, including sibling containers on the same bridge. Instead
# opt in to one derived address -- this container's own bridge gateway, which is
# where the runtime's port publisher forwards `-p` host traffic from -- and only
# when decant can prove the default route is a container veth to an on-link
# gateway inside 172.16.0.0/12. Shapes that fail that proof (`--network host`,
# macvlan/ipvlan, bridges outside that range) trust nobody beyond loopback until
# the operator sets DECANT_TRUSTED_PEERS, which replaces this default entirely.
# Set DECANT_TRUST_DEFAULT_GATEWAY=0 to turn the derivation off outright.
ENV DECANT_TRUST_DEFAULT_GATEWAY=1

VOLUME ["/var/lib/decant"]
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/decant"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3000", "--no-fs-watch", "--interval-ms", "45000"]
