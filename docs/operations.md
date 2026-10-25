# Operations

How 23 & Us is deployed, backed up and restored.

## Automation at a glance

| Workflow | When | What |
|---|---|---|
| `CI` → `check` | every push and PR | typecheck, lint, unit + property tests, database security suite, production build of the app |
| `CI` → `integration` | every push and PR | starts a full local Supabase in Docker, applies all migrations, tests saving/loading, household separation, invites and storage |
| `CI` → `migrate` | push to `main`, after both pass | applies pending migrations in `packages/db/supabase/migrations` to Supabase (no-op if none) |
| Vercel | every push | builds the app; `main` is the live site, other branches get preview links |
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

### First run (in this order)
1. Merge to `main` (or Actions → **CI** → **Run workflow** on `main`). The `migrate` job applies the schema; check it's green.
2. Actions → **Backup** → **Run workflow**. Check it goes green and an artifact `db-backup-…` appears. (Before step 1 it fails on purpose: it refuses to store a backup with no tables in it.)

## Hosting on Vercel (one-time)

1. vercel.com → **Sign up** → **Continue with GitHub** (Hobby plan, free).
2. **Add New… → Project** → import **clogwyn/23-and-us**. If it isn't listed, choose *Adjust GitHub App permissions* and grant access to that one repository.
3. On the configure screen:
   - **Root Directory**: `apps/web` (click *Edit*). Framework preset becomes **Next.js** automatically.
   - **Environment Variables** — add both, from Supabase → project **23 & Us** → **Connect** → *App Frameworks* → *Next.js* (or Project Settings → API Keys):
     - `NEXT_PUBLIC_SUPABASE_URL` = `https://<project-ref>.supabase.co`
     - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the **publishable** key (`sb_publishable_…`). If you only see legacy keys, use the **anon** key. Never the secret / service_role key.
4. **Deploy**. Note the URL it gives you, e.g. `https://23-and-us.vercel.app`.

Both values are public by design (they end up in the browser); the database's row-level security is what protects your data.

## Sign-in emails (one-time, in Supabase)

**Authentication → URL Configuration**
- **Site URL**: your Vercel URL, e.g. `https://23-and-us.vercel.app`
- **Redirect URLs**: add `https://23-and-us.vercel.app/**` and, for branch previews, `https://*-clogwyn.vercel.app/**`

**Authentication → Emails → Magic Link** — replace the body so the link works when the email is opened on a different device, and the 6-digit code is included:

```html
<h2>Sign in to 23 &amp; Us</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email">Sign in</a></p>
<p>Or enter this code: <strong>{{ .Token }}</strong></p>
<p>If you didn't ask for this, ignore this email.</p>
```

Supabase's built-in email sender is rate-limited to a few emails per hour. Sessions last a long time, so two people rarely notice; if it becomes a problem, add a custom SMTP sender (Authentication → Emails → SMTP settings).

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

- **Uploaded files are not yet backed up.** The database backup covers which files exist and where, not the files themselves. Photos are compressed on upload (about 300–500 KB each), but workflow artifacts are capped at 500 MB on a free private repo, so file backups need their own destination once uploads approach ~400 MB.
- **Point-in-time recovery** doesn't exist on Free. The worst case is losing up to a day of changes.
- **Pausing.** Supabase pauses Free projects after a week of inactivity. The nightly backup connects to the database, but whether that counts as activity is Supabase's call; if the project pauses, unpause it from the dashboard. No data is lost.
- **One environment.** Free allows two active projects and both are in use, so there is no staging database. Migrations are tested against a throwaway Postgres in CI (`packages/db/test/run.sh`), which is Postgres 16 locally and in CI against Supabase's 17.
