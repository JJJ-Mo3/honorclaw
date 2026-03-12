<p align="center">
  <img src="assets/logo.png" alt="HonorClaw" width="120" />
</p>

# Contributing to HonorClaw

Thank you for your interest in contributing. HonorClaw is an enterprise-grade AI agent platform where security is architectural, not behavioral.

## Development Setup

```bash
# Prerequisites
# - Node.js >= 22
# - pnpm >= 10
# - Docker Engine >= 24

# Clone and install
git clone https://github.com/JJJ-Mo3/honorclaw.git
cd honorclaw
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Start development server
make dev
```

## Project Structure

```
packages/
  core/              — Shared types, schemas, provider interfaces (zero deps)
  agent-runtime/     — UNTRUSTED agent loop (core + ioredis + pino)
  control-plane/     — TRUSTED orchestrator (core + providers)
  rag/               — RAG pipeline (chunking, embeddings, vector store)
  web-ui/            — React SPA (Vite)
  cli/               — CLI tool (Commander.js)
  providers/         — Provider implementations
  channels/          — Channel adapters (Slack, Teams, Discord, etc.)
infra/
  docker/            — Dockerfiles, s6 configs, compose files
  helm/              — Helm chart for Kubernetes
  terraform/         — Terraform modules for cloud deployment
  kubernetes/        — Falco rules, OPA policies
```

## Dependency Rules

These are strictly enforced:

- `core` has ZERO honorclaw dependencies
- `agent-runtime` depends on `core` only
- `providers/*` depend on `core` only
- `control-plane` depends on `core` + providers (injected)
- `channels/*` depend on `core` only

## Contribution Workflow

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run `pnpm build && pnpm test`
5. Sign your commits (DCO sign-off required):
   ```
   git commit -s -m "feat: add my feature"
   ```
6. Open a pull request against `main`

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `chore:` — maintenance tasks

## Security

**DO NOT** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## Code of Conduct

Be respectful, constructive, and professional. We're all here to build something useful.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
