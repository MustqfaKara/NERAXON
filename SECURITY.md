# Security Policy

## Reporting a Vulnerability

Do not disclose exploitable vulnerabilities, leaked credentials, or wallet details in a public issue.

Report security concerns privately through GitHub Security Advisories for this repository. Include the affected version, reproduction steps, impact, and a proposed mitigation when possible.

## Scope

High-priority reports include:

- Private-key or API-credential exposure
- Unauthorized order submission
- Authentication or same-origin bypasses
- Incorrect network or source-wallet attribution
- Replay, duplicate-order, or idempotency failures
- Risk-limit, circuit-breaker, or reconciliation bypasses

## Operator Responsibilities

NERAXON is local-first software that can submit irreversible financial transactions. Operators must keep the dashboard bound to localhost, store signing keys in macOS Keychain, maintain the live-trading kill switch, verify dependencies, and use balances they can afford to lose.

If a credential may have been exposed, revoke or rotate it immediately. Do not rely on deleting it from the latest Git commit because it may remain in repository history.
