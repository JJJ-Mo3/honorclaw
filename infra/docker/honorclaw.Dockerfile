# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages/ packages/
ENV CI=true
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
RUN pnpm build

# Stage 1b: Production dependencies only (clean install without devDependencies)
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/ packages/
ENV CI=true
RUN pnpm install --frozen-lockfile --prod 2>/dev/null || pnpm install --prod

# Stage 1c: Ollama binary from official image (glibc-based)
FROM ollama/ollama:latest AS ollama-src

# Stage 2: Runtime (Debian slim for native glibc — required by Ollama)
FROM node:22-slim AS honorclaw

# Map Docker TARGETARCH (amd64/arm64) to s6-overlay arch names (x86_64/aarch64)
ARG TARGETARCH
ARG S6_VERSION=3.1.6.2
RUN case "${TARGETARCH:-amd64}" in \
      amd64) S6_ARCH="x86_64" ;; \
      arm64) S6_ARCH="aarch64" ;; \
      *)     S6_ARCH="${TARGETARCH}" ;; \
    esac && \
    apt-get update && apt-get install -y --no-install-recommends wget xz-utils ca-certificates && \
    wget -qO /tmp/s6-overlay-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-noarch.tar.xz" && \
    wget -qO /tmp/s6-overlay-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" && \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz && \
    rm -f /tmp/s6-overlay-*.tar.xz

# Add PostgreSQL Global Development Group repository (provides PG 16 + pgvector)
RUN apt-get update && apt-get install -y --no-install-recommends gnupg && \
    echo "deb http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list && \
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor > /etc/apt/trusted.gpg.d/pgdg.gpg && \
    apt-get update

# PostgreSQL 16, pgvector, Redis, and network tools
RUN apt-get install -y --no-install-recommends \
    postgresql-16 postgresql-16-pgvector \
    redis-server \
    iproute2 iptables \
    gosu curl socat \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/postgresql /var/run/redis /data/postgres /data/redis \
    && chown postgres:postgres /var/run/postgresql /data/postgres \
    && chown redis:redis /var/run/redis /data/redis

# Ensure PostgreSQL 16 binaries (initdb, pg_ctl, postgres) are on PATH
ENV PATH="/usr/lib/postgresql/16/bin:${PATH}"

# Copy Ollama binary from the official image (pre-built for the correct arch)
COPY --from=ollama-src /bin/ollama /usr/bin/ollama

# Copy built application code and production-only dependencies
COPY --from=build --chown=node:node /app/packages /app/packages
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json

# Config template (provides sane defaults for the embedded single-container setup)
COPY config/honorclaw.yaml.template /data/honorclaw.yaml

# Skill bundles (available at runtime for `honorclaw skills install`)
COPY honorclaw-skills/ /app/honorclaw-skills/

# s6 service definitions
COPY infra/docker/s6/ /etc/s6-overlay/
COPY infra/docker/entrypoint.sh /entrypoint.sh
COPY infra/docker/seccomp-agent.json /etc/honorclaw/seccomp-agent.json
RUN chmod +x /entrypoint.sh && \
    find /etc/s6-overlay/s6-rc.d -name run -exec chmod +x {} \; && \
    find /etc/s6-overlay/s6-rc.d -name finish -exec chmod +x {} \;

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost:3000/health/ready || exit 1

# s6-overlay starts as root and drops privileges per-service via gosu.
# The control-plane runs as the unprivileged 'node' user (see s6 run scripts).
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/entrypoint.sh"]
