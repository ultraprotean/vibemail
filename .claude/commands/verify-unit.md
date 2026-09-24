---
description: Run the build-unit verification gate (tsc, tests, scope). Report only.
argument-hint: <unit 1-7>
allowed-tools: Bash(npx tsc --noEmit), Bash(npm test), Bash(git diff --name-only), Bash(git ls-files --others --exclude-standard)
---

Verify BUILD_SEQUENCE.md unit **$ARGUMENTS** for the server logic session.

## Rules

- **Report only.** Do not edit, create, or delete any file. Do not fix failures, re-run with changes, or propose code. A one-line diagnosis per failure is allowed.
- Run exactly the four commands listed below, nothing else.
- If `$ARGUMENTS` is not a single integer from 1 to 7, print `Usage: /verify-unit <unit 1-7>` and stop without running any checks.

## Check 1 — Types

Run `npx tsc --noEmit`.

- Exit 0 → **PASS**.
- Otherwise → **FAIL**. List every error as `file:line — TSxxxx message`.

## Check 2 — Tests

Run `npm test`.

- Report the passed, failed, and skipped counts from the Jest summary.
- For each failing test, list the test name and the first line of its error.
- **PASS** only if failed = 0 and skipped = 0 (unit 7's gate requires zero skipped tests).
- If Jest reports "No tests found": **PASS (N/A)** when the unit is 1, since unit 1's gate is `tsc` only. For units 2–7 it is a **FAIL**.

## Check 3 — Scope

Run `git diff --name-only` (modified tracked files) and `git ls-files --others --exclude-standard` (new untracked files). Merge the results, marking each file `M` or `?`.

Classify every file against the scope map below:

- **Forbidden:** anything under `migrations/`, `supabase/`, or top-level `types/` (owned by the schema session), or any `.env` file other than `.env.example`. The check fails, and each forbidden file is called out explicitly.
- **In scope:** the file matches the "always allowed" list or the current unit's paths.
- **Unexpected:** matches neither. The check fails.

No changed files at all counts as a PASS.

### Scope map

<!-- Update these paths once unit 1 settles the real directory layout. -->

- **Always allowed:** `CONTRACT.md`, `CLAUDE.md`, `BUILD_SEQUENCE.md` (spec amendments), `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.*.json`, `jest.config.*`, `.env.example`, `.claude/commands/**`, `docs/**` (API collection and guides), `src/shared/**` (shared error envelope and types)
- **Unit 1: provider abstraction interface.** `src/types/**` (provider interface), `src/providers/*` (interface files, not `src/providers/gmail/`), `src/db/**` (persistence interface)
- **Unit 2: Gmail OAuth and token persistence.** `src/providers/gmail/**`, `src/db/**` (user store interface + Supabase impl), `src/types/**` (interface amendments), `src/auth/**` (JWT), `src/crypto/**` (token encrypt/decrypt), `tests/**`
- **Unit 3: sync and read layer.** `src/providers/gmail/**`, `src/db/**` (message store), `src/types/**` (interface amendments), `src/sync/**`, `tests/**`
- **Unit 4: Pub/Sub webhook receiver.** `src/webhook/**`, `src/providers/gmail/**` (history, mailbox), `src/db/**` (store additions), `tests/**`
- **Unit 5: send layer and read state.** `src/providers/gmail/**`, `src/send/**`, `src/read-state/**`, `src/db/**` (store additions), `src/types/**` (interface amendments), `tests/**`
- **Unit 6: Vercel API entry points.** `api/**`, `vercel.json`, `vercel.ts`, `src/http/**` (handlers, envelope, CORS, cookies), `src/auth/**` (JWT), `src/config.ts`, `src/db/**` (store additions), `src/providers/gmail/**` (auth error split), `tests/**`
- **Unit 7: integration tests.** `tests/**`

## Report format

```
Unit <N> verification

| Check     | Result | Summary                       |
|-----------|--------|-------------------------------|
| 1 Types   | PASS   | tsc exited 0                  |
| 2 Tests   | FAIL   | 12 passed, 1 failed, 0 skipped|
| 3 Scope   | PASS   | 4 files, all in scope         |
```

Then give details **only for failed checks**: the type errors, the failing tests, and the unexpected or forbidden files. For Check 3, always list every changed file with its `M`/`?` marker and classification.

End with exactly one line:

- `UNIT <N> VERIFIED` if all three checks pass, or
- `UNIT <N> FAILED`, followed by a bullet list of each specific failure.
