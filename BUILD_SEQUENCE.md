# VibeMail Engine — Build Sequence

Atomic build order for the VibeMail Engine, per the contracts and sequencing rule in [CONTRACT.md](CONTRACT.md). Each unit lists what it is and the single check that verifies it before moving to the next unit.

## Units

1. **Provider abstraction interface** — TypeScript compiles clean and the interface defines all required methods.
2. **Gmail OAuth layer with token persistence listener** — OAuth completes, tokens are stored, refresh works without mismatch.
3. **Sync and read layer** — initial sync fetches 50 messages and objects match the contract model.
4. **Pub/Sub webhook receiver and watch renewal** — a notification fetches the correct delta through history ID.
5. **Send layer** — a message sends successfully through Gmail for an authenticated user.
6. **Vercel API function entry points** — every endpoint in CONTRACT.md §6 responds correctly in local preview.
7. **Integration tests** — the full suite passes with no skipped tests against live Supabase.

