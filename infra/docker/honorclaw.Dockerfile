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

# Stage 2: Runtime
FROM node:22-alpine AS honorclaw

# Map Docker TARGETARCH (amd64/arm64) to s6-overlay arch names (x86_64/aarch64)
ARG TARGETARCH
ARG S6_VERSION=3.1.6.2
RUN case "${TARGETARCH:-amd64}" in \
      amd64) S6_ARCH="x86_64" ;; \
      arm64) S6_ARCH="aarch64" ;; \
      *)     S6_ARCH="${TARGETARCH}" ;; \
    esac && \
    wget -qO /tmp/s6-overlay-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-noarch.tar.xz" && \
    wget -qO /tmp/s6-overlay-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" && \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz && \
    rm -f /tmp/s6-overlay-*.tar.xz

# PostgreSQL 18 (Alpine default), pgvector, Redis, and network tools
RUN apk add --no-cache \
    postgresql18 postgresql18-contrib postgresql-pgvector \
    redis \
    iproute2 iptables ip6tables \
    su-exec curl bash socat \
    && mkdir -p /var/run/postgresql /var/run/redis /data/postgres /data/redis \
    && chown postgres:postgres /var/run/postgresql /data/postgres \
    && chown redis:redis /var/run/redis /data/redis

# Install Ollama (latest release by default, override with --build-arg OLLAMA_VERSION=x.y.z)
ARG OLLAMA_VERSION=""
RUN case "${TARGETARCH:-amd64}" in \
      amd64) OLLAMA_ARCH="amd64" ;; \
      arm64) OLLAMA_ARCH="arm64" ;; \
      *)     OLLAMA_ARCH="${TARGETARCH}" ;; \
    esac && \
    if [ -z "${OLLAMA_VERSION}" ]; then \
      OLLAMA_VERSION=$(wget -qO- https://api.github.com/repos/ollama/ollama/releases/latest \
        | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/'); \
    fi && \
    echo "Installing Ollama v${OLLAMA_VERSION}" && \
    wget -qO /tmp/ollama.tgz \
      "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-${OLLAMA_ARCH}.tgz" && \
    tar -xzf /tmp/ollama.tgz -C /usr && \
    rm -f /tmp/ollama.tgz

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

# s6-overlay starts as root and drops privileges per-service via su-exec.
# The control-plane runs as the unprivileged 'node' user (see s6 run scripts).
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/entrypoint.sh"]
