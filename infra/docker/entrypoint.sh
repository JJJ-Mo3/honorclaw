#!/bin/bash
set -euo pipefail

# ── Function definitions ────────────────────────────────────────────────

setup_agent_namespace() {
  REDIS_HOST="127.0.0.1"
  if [ -n "${REDIS_URL:-}" ]; then
    REDIS_HOST=$(echo "$REDIS_URL" | sed 's|.*@\(.*\):.*|\1|')
  fi

  # Create network namespace
  ip netns add agent-ns 2>/dev/null || return 1

  # veth pair
  ip link add veth-host type veth peer name veth-agent 2>/dev/null || return 1
  ip link set veth-agent netns agent-ns || return 1
  ip addr add 10.100.0.1/30 dev veth-host 2>/dev/null || true
  ip link set veth-host up

  ip netns exec agent-ns ip addr add 10.100.0.2/30 dev veth-agent || return 1
  ip netns exec agent-ns ip link set veth-agent up || return 1
  ip netns exec agent-ns ip link set lo up || return 1

  # DNAT: agent -> 10.100.0.1:6379 -> Redis
  iptables -t nat -A PREROUTING -i veth-host -p tcp --dport 6379 -j DNAT \
    --to-destination "${REDIS_HOST}:6379" 2>/dev/null || true
  iptables -A FORWARD -i veth-host -p tcp --dport 6379 -j ACCEPT 2>/dev/null || true

  # Agent namespace: allow only Redis, block everything else
  ip netns exec agent-ns iptables -A OUTPUT -d 10.100.0.1 -p tcp --dport 6379 -j ACCEPT || return 1
  ip netns exec agent-ns iptables -A OUTPUT -d 127.0.0.1 -j ACCEPT || return 1
  ip netns exec agent-ns iptables -A OUTPUT -j DROP || return 1

  echo "agent-ns" > /tmp/agent-netns-name
  echo "10.100.0.1" > /tmp/agent-redis-proxy-ip
  echo "Agent network namespace created"
}

# ── Main logic ──────────────────────────────────────────────────────────

# If running in "init" mode: interactive setup, then exit
if [ "${1:-}" = "init" ]; then
  shift
  exec node /app/packages/cli/dist/cli.js init "$@"
fi

# Embedded or external databases?
if [ -n "${POSTGRES_URL:-}" ]; then
  echo "Using external PostgreSQL: ${POSTGRES_URL%%@*}@***"
  touch /tmp/skip-embedded-postgres
fi
if [ -n "${REDIS_URL:-}" ]; then
  echo "Using external Redis"
  touch /tmp/skip-embedded-redis
  touch /tmp/skip-redis-proxy
fi

# Agent isolation mode: namespace (default) or container (--security full)
# In docker-compose mode (external DBs via URLs), skip namespace setup since
# Docker networks already provide isolation between containers.
export AGENT_ISOLATION_MODE=${AGENT_ISOLATION_MODE:-namespace}

if [ "$AGENT_ISOLATION_MODE" = "namespace" ]; then
  if setup_agent_namespace; then
    echo "Agent namespace isolation enabled"
  else
    echo "WARNING: Could not create agent namespace (missing NET_ADMIN or kernel support). Continuing without namespace isolation."
  fi
fi

# Hand off to s6 as PID 1
exec /init
