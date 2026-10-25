# Operations

How 23 & Us is deployed, backed up and restored.

## Automation at a glance

| Workflow | When | What |
|---|---|---|
| `CI` → `check` | every push and PR | typecheck, lint, unit + property tests, database security suite |
| `CI` → `migrate` | push to `main`, after `check` passes | applies pending migrations in `packages/db/supabase/migrations` to Supabase (no-op if none) |
| `Backup` | daily 02:17 UTC, or run manually | encrypted dump of roles, schema and data, kept 30 days as a workflow artifact |

Migrations are append-only. Never edit a migration that has reached `main`; add a new one.

## One-time setup: repository secrets

GitHub → **clogwyn/23-and-us** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add both:

### `SUPABASE_DB_URL`
1. Supabase dashboard → project **23 & Us** → **Connect** (top bar).
2. Choose **Session pooler**, not Direct. The direct host is IPv6-only on the Free plan and GitHub's runners can't reach it.
3. Copy the URI. It looks like
   `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`
4. Replace `[YOUR-PASSWORD]` with the database password (Project Settings → Database → reset it if you don't have it).
   If the password contains anything other than letters and digits, percent-encode those characters (`@` → `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`, `?` → `%3F`, `&` → `%26`, `%` → `%25`). Simplest: reset to a long letters-and-digits password.
5. Paste the full URI as the secret value.

### `BACKUP_PASSPHRASE`
A long random passphrase used to encrypt backups. **Store it in your password manager too — without it, backups cannot be opened.** Losing it is the same as having no backups.

### First run
1. Actions → **Backup** → **Run workflow**. Check it goes green and an artifact `db-backup-…` appears.
2. Merge anything to `main` (or Actions → **CI** → **Run workflow** on `main`) to apply the schema.

## Restore

You need: the artifact, the passphrase, and the target database's Session pooler URI. Restore into a **new** Supabase project when the original is lost or corrupted; never on top of live data.

```bash
# 1. Download the artifact from the Backup run (Actions → run → Artifacts), unzip it, then:
gpg --decrypt db-YYYY-MM-DDTHHMMZ.tar.gz.gpg > backup.tar.gz
mkdir restore && tar -C restore -xzf backup.tar.gz && cd restore

# 2. Load into the target project (Postgres 17 client).
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$TARGET_SESSION_POOLER_URI"
```

`session_replication_role = replica` suspends triggers during the data load, so version counters and guards don't fire on historical rows. After restoring, point the app's environment variables at the new project.

Rehearse this once against a scratch project. An untested backup is a hope, not a backup.

## Known gaps (Free plan)

- **Uploaded files are not yet backed up.** The database backup covers metadata, not the files themselves. Workflow artifacts are capped at 500 MB on a free private repo, which photos would exceed, so files need their own destination. Decide before relying on uploads.
- **Point-in-time recovery** doesn't exist on Free. The worst case is losing up to a day of changes.
- **Pausing.** Supabase pauses Free projects after a week of inactivity. The nightly backup connects to the database, but whether that counts as activity is Supabase's call; if the project pauses, unpause it from the dashboard. No data is lost.
- **One environment.** Free allows two active projects and both are in use, so there is no staging database. Migrations are tested against a throwaway Postgres in CI (`packages/db/test/run.sh`), which is Postgres 16 locally and in CI against Supabase's 17.
