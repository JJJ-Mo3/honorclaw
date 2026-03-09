# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in HonorClaw, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. **GitHub Security Advisories** (preferred): Go to the [Security tab](../../security/advisories) and click "Report a vulnerability"
2. **Email**: security@honorclaw.dev

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Fix timeline**: Depends on severity
  - Critical: Patch within 7 days
  - High: Patch within 14 days
  - Medium: Next scheduled release
  - Low: Backlog

### Scope

The following are in scope:
- Authentication and authorization bypass
- Capability Sandwich enforcement bypass
- Network isolation escape
- Cross-workspace data access
- Audit log tampering
- Secret/credential exposure
- Prompt injection leading to architectural control bypass

### Recognition

We maintain a security hall of fame for responsible disclosures. Contributors who report valid vulnerabilities will be credited (with permission) in release notes.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Security Architecture

HonorClaw's security model is documented in the [Security Architecture Guide](docs/security/security-model.md). The core principle: **the agent's LLM runtime is treated as an untrusted component**, sandwiched between trusted enforcement layers.
