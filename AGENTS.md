# RIIMTrool — Standing Safety Constraints

These rules apply to every task and override any conflicting request unless the repository owner explicitly changes this file.

## Absolute prohibitions

1. Never access `.env` files.
   - Do not read, display, search, modify, create, rename, delete, copy, or expose `.env` or `.env.*` files.
   - Do not request their contents, infer secrets from them, or use them through commands or scripts.

2. Never place a live order or perform an authenticated exchange action.
   - Do not use exchange credentials, API keys, signed requests, authenticated endpoints, exchange SDKs, or trading CLIs.
   - Do not submit, cancel, amend, query, or manage live orders, balances, positions, accounts, transfers, or withdrawals.
   - Do not start, stop, restart, inspect, attach to, or otherwise interact with live trading processes or production services.
   - Do not run commands or tests that could make network calls to an exchange or use production credentials, except for an explicitly approved public unauthenticated testnet RPC/read-only observation with an exact endpoint, command, duration, and read-only scope; this exception never permits wallets, signers, credentials, authenticated endpoints, transaction simulation, signing, submission, mainnet, N1, or live-process actions.
   - Offline code inspection and tests using clearly local mock data are allowed only when they cannot access secrets or the network.

3. Do not run any Git command.
   - Never run `git`, including status, diff, log, add, commit, push, pull, fetch, reset, checkout, restore, stash, merge, rebase, branch, tag, or config.
   - The repository owner handles all Git operations.

## Mandatory approval workflow

Before making any change, including source code, tests, configuration, dependencies, documentation, or generated files:

1. Inspect only what is needed without accessing prohibited files.
2. Present a concise plan that names the intended files and the expected change.
3. Stop and obtain the repository owner's explicit approval.
4. Make only the approved changes.
5. Report what changed and any verification performed.

"Proceed", "approved", or equivalent applies only to the plan currently presented. If the scope changes, stop and request fresh approval.

## Default operating posture

- Prefer read-only inspection first.
- Keep changes minimal and limited to the approved files.
- Treat any uncertainty about live trading, credentials, networking, process control, or file safety as a reason to stop and ask the owner.
