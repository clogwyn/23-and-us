# 23 & Us — working rules for AI agents

## Git (always, every session)
- `main` holds working builds only. Never commit WIP to `main`.
- Work on a feature branch: `feat/<module>-<short-desc>`, `fix/...`, `chore/...`.
- Commit early as `wip: ...` on the branch; push at every stopping point or device switch.
- Squash-merge to `main` only when `pnpm check` passes.

## Architecture boundaries (enforced by ESLint — do not weaken the rules)
- `packages/domain` — leaf: types, Zod schemas, money/date/predecessor-code utils. No internal deps.
- `packages/scheduler` — pure CPM engine. Depends on `@23andus/domain` only. No I/O, no framework.
- `packages/db` — SQL migrations (source of truth), seed, generated types.
- `apps/web/src/ui` — design-system primitives; imports nothing from `features/`.
- `apps/web/src/features/<module>` — feature slices. Cross-feature use only via the module's `index.ts`.

## Conventions
- Money: integer pence (`Pence`), gross (inc. VAT). Never floats.
- Dates: `DayDate` = ISO `YYYY-MM-DD` string. Durations in whole days. Calendar is injected (`Calendar` interface).
- Engine-owned task columns (`early_*`, `late_*`, `total_float`, `is_critical`, `computed_at`) are written only by the scheduler pipeline.
- Every new table carries `household_id` and an RLS policy.
- `pnpm check` must pass before merge.
