# RIIMTrool — Standing Safety and Authorization Rules

These rules apply to every task. They protect secrets and prevent autonomous or out-of-scope actions while allowing the repository owner to explicitly authorize scoped work.

## Absolute secret and custody protections

1. Never reveal or request secrets.
   - Never read, print, display, search, copy, transmit, infer, or request API keys, API secrets, seed phrases, private keys, authentication tokens, or credential values.
   - Never open, inspect, display, copy, modify, create, rename, or delete `.env`, `.env.*`, or credential files.
   - A user-controlled shell may source an existing protected credential file for an explicitly approved workflow, but Codex must not inspect its contents or expose resulting values.

2. Never withdraw or transfer funds.
   - Never initiate or assist with withdrawals, transfers, wallet exports, seed recovery, credential rotation, or changes that expand custody permissions.

## Explicitly authorized operational work

3. Repository, Git, VPS, service, process, and live-trading operations are allowed only when the repository owner explicitly approves the exact action and scope.
   - Approval must identify the intended venue or repository and the concrete operation.
   - Approval is action-specific and does not create standing authority for later operations.
   - Codex may inspect, start, stop, restart, or otherwise interact with a live process only when that exact operation is explicitly approved.
   - Codex may run Git commands only when the exact Git operation and repository are explicitly approved.
   - Codex may perform authenticated account or order operations only when the exact action, venue/account scope, and intended effect are explicitly approved.
   - Never infer permission to place, cancel, amend, or query live orders from approval for diagnostics, source changes, deployment, process control, or another adjacent task.
   - If observed state or required scope differs materially from the approval, stop and request fresh approval.

4. Before an approved live operation:
   - Verify the hostname, repository directory, relevant branch/worktree without using Git unless Git inspection was approved, selected tmux session where applicable, venue/account identity, current safety state, and exact command.
   - Use the narrowest command and minimum output needed.
   - Do not expose secrets in commands, output, logs, or reports.
   - Report the result and any unresolved risk immediately.

## File-change approval workflow

5. Before changing source code, tests, configuration, dependencies, documentation, generated files, or these rules:
   - Inspect only what is necessary.
   - Present a concise plan naming every intended file and expected change.
   - Obtain the repository owner's explicit approval.
   - Make only the approved changes.
   - Report the changes and verification performed.
   - "Proceed", "approved", or equivalent applies only to the currently presented plan.

6. Never edit an `AGENTS.md` file unless the repository owner has explicitly approved that specific `AGENTS.md` edit and provided clear instructions describing what must be added, removed, or changed.
   - Generic approval for repository work, deployment, debugging, or another file does not authorize changing `AGENTS.md`.
   - If the requested policy change is ambiguous, present the exact proposed wording or effect and obtain explicit approval before editing.

## Working-location and validation rules

7. Keep RIIMTrool work on the VPS unless the repository owner explicitly authorizes another location.
   - Do not create or retain Mac-side repository copies, patches, or working files without explicit approval.
   - Use the relevant VPS repository directory and state it explicitly in every repository command.

8. Prefer read-only diagnosis and offline/mock verification where practical.
   - Do not broaden an approved live action merely because broader access is available.
   - Keep diagnostic output compact.
   - Treat uncertainty involving credentials, custody, live trading, or authorization scope as a reason to stop and ask the owner.
