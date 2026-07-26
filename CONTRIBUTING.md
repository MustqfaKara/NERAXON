# Contributing to NERAXON

Contributions are welcome through issues and pull requests.

## Development

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm install`.
3. Keep credentials in macOS Keychain or ignored local environment files.
4. Make a scoped change with tests for behavioral logic.
5. Run the quality checks before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Pull Requests

- Explain the problem and the behavior changed.
- Include verification steps and relevant screenshots for interface changes.
- Do not commit API keys, private keys, Telegram sessions, databases, logs, or wallet history.
- Preserve network-scoped position ownership, idempotency, risk controls, and local-only defaults.
- Never weaken live-trading safeguards without documenting the reason and consequences.

## Financial Safety

Changes that affect signing, execution, position sizing, fees, slippage, reconciliation, or PnL require focused tests. Contributors must use their own test accounts and funds and are responsible for independently reviewing live-trading risk.
