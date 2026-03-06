#!/bin/bash
set -euo pipefail
echo "Testing HonorClaw network isolation..."

MODE=${AGENT_ISOLATION_MODE:-namespace}

if [ "$MODE" = "namespace" ]; then
  # Agent namespace: no default route, no internet, Redis reachable
  docker exec honorclaw ip netns exec agent-ns ip route \
    | grep -q "default" && echo "✗ FAIL: agent namespace has default route" || echo "✓ PASS: no default route"

  docker exec honorclaw ip netns exec agent-ns ping -c1 -W2 1.1.1.1 2>&1 \
    | grep -q "Unreachable\|100% packet loss" && echo "✓ PASS: no internet" || echo "✗ FAIL: internet reachable"

  docker exec honorclaw ip netns exec agent-ns nc -z -w2 10.100.0.1 6379 \
    && echo "✓ PASS: Redis reachable via proxy" || echo "✗ FAIL: Redis not reachable"
else
  docker compose -f infra/docker/docker-compose.security-full.yml exec agent-runtime \
    sh -c "wget -q --timeout=3 http://1.1.1.1 2>&1" \
    && echo "✗ FAIL: internet reachable" || echo "✓ PASS: no internet"
fi

echo "Test complete."
