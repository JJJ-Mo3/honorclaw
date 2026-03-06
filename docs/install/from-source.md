# Build from Source

## Overview

This guide covers building HonorClaw from source. Useful for:

- Contributing to HonorClaw
- Running unreleased features
- Custom modifications
- Environments that require building from audited source

---

## Prerequisites

| Requirement | Version |
|------------|---------|
| Node.js | 22+ |
| pnpm | 10+ |
| Docker | 24+ |
| Git | 2.30+ |

## Clone the Repository

```bash
git clone https://github.com/honorclaw/honorclaw.git
cd honorclaw
```

## Install Dependencies

```bash
pnpm install
```

## Build All Packages

```bash
pnpm build
```

This builds:
- `packages/core` — Shared types and schemas
- `packages/control-plane` — API server and policy engine
- `packages/cli` — Command-line interface
- `packages/tools/*` — Tool implementations

## Run Tests

```bash
# All tests
pnpm test

# Security tests only
pnpm vitest run tests/security/

# Watch mode
pnpm vitest
```

## Run in Development Mode

```bash
# Start dependencies (PostgreSQL, Redis, Ollama)
docker compose -f infra/docker/docker-compose.security-full.yml up -d postgres redis ollama

# Run control plane in dev mode
cd packages/control-plane
pnpm dev
```

The control plane will start on `http://localhost:3000` with hot-reload.

## Build Docker Images

```bash
# Build the main image
docker build -f infra/docker/honorclaw.Dockerfile -t honorclaw/honorclaw:dev .

# Build with a specific target
docker build -f infra/docker/honorclaw.Dockerfile --target agent-runtime -t honorclaw/agent-runtime:dev .
```

## Build CLI Binary

```bash
# Build the CLI
cd packages/cli
pnpm build

# Run directly
node dist/cli.js --help

# Or link globally for development
pnpm link --global
honorclaw --help
```

## Type Checking

```bash
pnpm typecheck
```

## Linting

```bash
pnpm lint
```

## Formatting

```bash
# Check
pnpm format:check

# Fix
pnpm format
```

---

## Project Structure

```
honorclaw/
  packages/
    core/               # Shared types, schemas, provider interfaces
    control-plane/      # Fastify API server, policy engine, guardrails
    cli/                # Commander.js CLI
    tools/              # Tool implementations (web-search, file-ops, etc.)
  infra/
    docker/             # Dockerfiles, Compose files, s6 configs
    kubernetes/         # K8s manifests, Falco rules, OPA policies
  tests/
    security/           # Security test suite
  config/               # Configuration templates
  scripts/              # Utility scripts
  examples/             # Example agent manifests
  docs/                 # Documentation
```

---

## Making Changes

### Adding a New Tool

1. Create `packages/tools/my-tool/`
2. Implement the tool interface from `@honorclaw/core`
3. Add parameter schemas
4. Add to the tool registry in `packages/control-plane/src/tools/registry.ts`
5. Write tests
6. Update the Dockerfile

### Modifying Guardrail Patterns

1. Edit patterns in `packages/control-plane/src/guardrails/`
2. Add corresponding tests in `tests/security/`
3. Bump the pattern version number

### Adding an OPA Policy

1. Create `infra/kubernetes/policies/my-policy.rego`
2. Add tests in `infra/kubernetes/policies/tests/`
3. Document in the security model docs

---

## Troubleshooting

### "Module not found" errors

Ensure all packages are built:
```bash
pnpm build
```

### TypeScript errors after pulling

Clean and rebuild:
```bash
pnpm clean
pnpm install
pnpm build
```

### Docker build fails

Check that the Dockerfile context is the repo root:
```bash
docker build -f infra/docker/honorclaw.Dockerfile -t honorclaw:dev .
```
