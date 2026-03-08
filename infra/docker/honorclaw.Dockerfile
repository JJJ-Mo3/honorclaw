# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
RUN pnpm build
RUN pnpm prune --prod

# Stage 2: Runtime
FROM node:22-alpine AS runtime

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

# PostgreSQL 16, Redis 7, and network tools
RUN apk add --no-cache \
    postgresql16 postgresql16-contrib \
    redis \
    iproute2 iptables ip6tables \
    su-exec curl bash socat \
    && mkdir -p /var/run/postgresql /var/run/redis /data

# Install pgvector extension
RUN apk add --no-cache --virtual .build-deps build-base postgresql16-dev git && \
    git clone --branch v0.7.0 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector && \
    cd /tmp/pgvector && make && make install && \
    rm -rf /tmp/pgvector && \
    apk del .build-deps

# Install Ollama (pre-built static binary, compatible with Alpine musl)
ARG OLLAMA_VERSION=0.6.2
RUN case "${TARGETARCH:-amd64}" in \
      amd64) OLLAMA_ARCH="amd64" ;; \
      arm64) OLLAMA_ARCH="arm64" ;; \
      *)     OLLAMA_ARCH="${TARGETARCH}" ;; \
    esac && \
    wget -qO /usr/local/bin/ollama \
      "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-${OLLAMA_ARCH}" && \
    chmod +x /usr/local/bin/ollama

# Copy application (owned by node user for privilege-dropped execution)
COPY --from=build --chown=node:node /app/packages /app/packages
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
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

ENTRYPOINT ["/entrypoint.sh"]
