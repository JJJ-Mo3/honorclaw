#!/bin/bash
set -euo pipefail

# ── Function definitions ────────────────────────────────────────────────

setup_agent_namespace() {
  REDIS_HOST="127.0.0.1"
  if [ -n "${REDIS_URL:-}" ]; then
    REDIS_HOST=$(echo "$REDIS_URL" | sed 's|.*@\(.*\):.*|\1|')
  fi

  # Create network namespace
  ip netns add agent-ns 2>/dev/null || true

  # veth pair
  ip link add veth-host type veth peer name veth-agent 2>/dev/null || true
  ip link set veth-agent netns agent-ns
  ip addr add 10.100.0.1/30 dev veth-host 2>/dev/null || true
  ip link set veth-host up

  ip netns exec agent-ns ip addr add 10.100.0.2/30 dev veth-agent
  ip netns exec agent-ns ip link set veth-agent up
  ip netns exec agent-ns ip link set lo up

  # DNAT: agent -> 10.100.0.1:6379 -> Redis
  iptables -t nat -A PREROUTING -i veth-host -p tcp --dport 6379 -j DNAT \
    --to-destination "${REDIS_HOST}:6379" 2>/dev/null || true
  iptables -A FORWARD -i veth-host -p tcp --dport 6379 -j ACCEPT 2>/dev/null || true

  # Agent namespace: allow only Redis, block everything else
  ip netns exec agent-ns iptables -A OUTPUT -d 10.100.0.1 -p tcp --dport 6379 -j ACCEPT
  ip netns exec agent-ns iptables -A OUTPUT -d 127.0.0.1 -j ACCEPT
  ip netns exec agent-ns iptables -A OUTPUT -j DROP

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
export AGENT_ISOLATION_MODE=${AGENT_ISOLATION_MODE:-namespace}

if [ "$AGENT_ISOLATION_MODE" = "namespace" ]; then
  setup_agent_namespace
fi

# Hand off to s6 as PID 1
exec /init
