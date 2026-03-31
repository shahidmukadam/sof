# State of Finance

`State of Finance` is a small Flask personal-finance dashboard for tracking net worth over time. It supports SQLite for local development and PostgreSQL for hosted deployments.

It supports:

- Manual assets such as bank accounts and investment groups
- Loan accounts with principal, EMI, tenure, and interest metadata
- Share holdings with automatic price refresh from exchange feeds or Yahoo Finance
- Bucket-based allocation of balance entries to goals
- Net-worth snapshots, recent activity, and a timeline chart
- Display currency switching between `AED` and `INR`
- Local email/password authentication with OTP-based sign-up, activation, and password reset

All persisted money values are stored in `USD`. The frontend converts values into the selected display currency.

## Tech Stack

- Backend: Flask, SQLite/PostgreSQL, `urllib.request`
- Frontend: server-rendered HTML, Tailwind via CDN, plain JavaScript
- Charts: Chart.js via CDN
- Database: SQLite via `finance.db` locally, PostgreSQL via `DATABASE_URL` or `SOF_DATABASE_URL`
- Local secret: `secret.key` or `SOF_SECRET_KEY`

## File Layout

- [app.py](app.py): Flask app, database setup, migrations, API routes, stock/rate fetchers
- [schema.sql](schema.sql): base SQLite schema
- [schema_postgres.sql](schema_postgres.sql): PostgreSQL schema for hosted deployments
- [templates/index.html](templates/index.html): single-page shell and modal markup
- [static/app.js](static/app.js): client-side state, rendering, modal flows, API calls, charts
- [requirements.txt](requirements.txt): Python dependency list
- `secret.key`: locally generated Flask session secret, created on first startup and gitignored
- [render.yaml](render.yaml): optional Render Blueprint for a web service plus Render Postgres

## How The App Works

The app is effectively a single-page dashboard:

1. `GET /` serves [templates/index.html](templates/index.html).
2. On startup, [static/app.js](static/app.js) checks `/api/auth/session`.
3. Logged-out users stay in the auth shell and use sign-in, sign-up, activate-existing, or forgot-password flows.
4. Logged-in users move into the finance app, which then loads rates, accounts, buckets, and summary data for the selected read scope.
5. UI actions call JSON API endpoints under `/api/...`.
6. The backend reads and writes the configured database directly and returns JSON rows as plain dictionaries.

There is still no background worker, ORM, or build step.

## Core Concepts

### 1. Users, Families, And Auth

The finance profile model is now session-driven.

- Each account and bucket belongs to a finance `user`
- Each finance `user` belongs to a `family`
- Login credentials live in `auth_accounts`, not on the finance profile row
- A clean install starts with no users or finance data
- New sign-ups create a brand-new finance profile and a brand-new isolated family
- `Activate Existing` is only used when older local data already created finance profiles without auth accounts
- After login, the header offers `My Profile`, `All Users`, and `Logout`
- `All Users` is read-only and aggregates only the signed-in user’s family

Scope behavior:

- `My Profile`: read/write the signed-in user’s own data
- `All Users`: merged read-only view for the current family
- Protected writes always use `current_finance_user_id()` from session and ignore the current scope

Merge behavior in `All Users`:

- dashboard totals are summed across users in the current family
- accounts are merged when `name + type` match
- buckets are merged when bucket names match
- timeline datasets are merged when `name + type` match
- a newly signed-up user sees only themselves in `All Users` until family invite flows exist later

### 2. Assets

Assets live in the `accounts` table and use this taxonomy:

- `bank`
- `loan`
- `shares`
- `investment_group`

Behavior by type:

- `bank`: manual balance entries
- `investment_group`: manual balance entries
- `loan`: metadata is stored in `loan_details`; principal is also inserted as a negative balance entry
- `shares`: share metadata is stored in `share_details`; market value is auto-fetched and inserted as a balance entry

Soft delete is used for assets: deleting an account sets `is_active = 0`.

### 3. Balance Entries

`balance_entries` is the source of truth for all time-series value tracking.

Each row is a snapshot-like value for one account at one point in time. Summary queries usually take the latest entry per active account.

Important implications:

- Net worth is based on the latest balance entry for each active account
- Timeline views forward-fill each account’s last known value across later periods
- Loan balances are expected to be negative
- Share balances are generated from `last_price * quantity`, converted to USD

### 4. Buckets

Buckets are user-defined goals or categories, such as an emergency fund or vacation.

They are not separate balances. Instead, a balance entry can optionally allocate portions of its amount into one or more buckets via `bucket_allocations`.

Each bucket now has an `allocation_type`:

- `manual`: funded only when the user manually allocates part of a bank balance entry
- `auto`: funded by the Buckets tab `Allocate` action using the latest active bank-account balances

The Buckets tab also exposes an `Allocate` action on each bucket card:

- for `manual` buckets, it opens a dialog that shows read-only unallocated fund and lets the user add an allocation amount
- for `auto` buckets, it refreshes auto allocation using the same exchange-wide auto-allocation flow

Bucket summaries only sum allocations from the latest balance entry of each active account, not every historical allocation ever recorded.

Auto allocation works on the current snapshot only:

- it looks only at active `bank` accounts
- it preserves existing manual bucket allocations on those latest bank entries
- it clears and recalculates only the `auto` bucket allocations on those latest bank entries
- it funds auto buckets in bucket sort order until available bank cash runs out
- saving a new manual bank balance entry automatically refreshes the latest auto-allocation snapshot so auto buckets do not disappear
- saving a new bank balance entry also carries forward the previous latest manual bucket allocations for that same account unless the user changes them

### 5. Display Currency

The UI can display values in `AED` or `INR`, but storage remains USD.

Frontend conversion rules:

- When displaying money: `stored_usd * selected_rate`
- When saving user input: `entered_value / selected_rate`

Rates come from `/api/rates`, backed by `https://open.er-api.com/v6/latest/USD`, with hardcoded fallback values.

## Database Model

Defined in [schema.sql](schema.sql) for SQLite and [schema_postgres.sql](schema_postgres.sql) for PostgreSQL.

### `users`

Finance profile table.

Key columns:

- `id`
- `family_id`
- `name`
- `created_at`

### `families`

Groups finance profiles for `All Users` aggregation.

Key columns:

- `id`
- `name`
- `created_at`

### `auth_accounts`

Login table linked one-to-one with finance profiles.

Key columns:

- `user_id`
- `email`
- `password_hash`
- `email_verified_at`
- `last_login_at`
- `is_active`
- `created_at`
- `updated_at`

### `accounts`

Primary asset table.

Key columns:

- `id`
- `user_id`
- `name`
- `type`
- `institution`
- `currency`
- `is_active`
- `created_at`

Note: `currency` exists in schema but is not actively used by the current UI or API flows. The app assumes USD storage globally.

### `loan_details`

One-to-one extension for loan accounts.

Key columns:

- `interest_rate`
- `remaining_tenure`
- `monthly_emi`
- `remaining_principal`

### `share_details`

One-to-one extension for share accounts.

Key columns:

- `stock_name`
- `exchange`
- `stock_code`
- `quantity`
- `last_price`
- `last_price_currency`
- `last_fetched`

### `balance_entries`

Stores account values over time.

Key columns:

- `account_id`
- `amount`
- `note`
- `recorded_at`

### `buckets`

Stores bucket metadata.

Key columns:

- `user_id`
- `name`
- `target`
- `color`
- `allocation_type`
- `sort_order`

### `bucket_allocations`

Join table from balance entries to buckets.

Key columns:

- `balance_entry_id`
- `bucket_id`
- `amount`

### `otp_challenges`

Stores OTP verification state for local sign-up, activation, and password reset.

Key columns:

- `email`
- `purpose`
- `code_hash`
- `payload`
- `expires_at`
- `resend_allowed_at`
- `attempt_count`
- `consumed_at`

### `local_otp_outbox`

Local-only OTP delivery log used by the in-app inbox panel.

Key columns:

- `challenge_id`
- `email`
- `purpose`
- `code_plain`
- `expires_at`
- `resend_allowed_at`
- `created_at`

## Backend Architecture

### Database lifecycle

In [app.py](app.py):

- `get_db()` creates one database connection per request and selects SQLite or PostgreSQL from environment configuration
- `close_db()` closes that connection on teardown
- `init_db()` runs [schema.sql](schema.sql) or [schema_postgres.sql](schema_postgres.sql) based on the active backend
- `migrate_db()` applies idempotent schema evolution for older SQLite databases
- `_load_secret_key()` creates `secret.key` on first startup with a 32-byte hex secret and reuses it on later starts

### Migrations currently handled in code

`migrate_db()` upgrades older databases by:

- adding `loan` support to the old account type constraint
- migrating old types into the newer asset taxonomy
- creating `loan_details` if missing
- creating `share_details` if missing
- creating the `users` table if missing
- creating `families`, `auth_accounts`, `otp_challenges`, and `local_otp_outbox`
- attaching legacy users to household families when `family_id` is missing
- preserving a legacy shared household when an older local database contains two unassigned users
- backfilling legacy accounts and buckets onto a generic `Primary` owner only when an older pre-user database needs it
- adding `buckets.allocation_type` with a default of `manual`
- rebuilding buckets so bucket names are unique per user

### Authentication and OTP

Auth helpers live in [app.py](app.py) and enforce all protected ownership checks from session state.

- `_current_auth_account()` resolves the signed-in auth row plus finance user and family
- `current_finance_user_id()` is the only source of truth for protected writes
- `current_family_id()` is used for `All Users` reads
- OTPs are local-only, six digits, expire after 10 minutes, and are invalidated after 3 failed attempts
- resend is rate-limited with `resend_allowed_at`
- successful sign-in stores a persistent Flask session so login survives app restarts until logout

### Stock pricing

Share price refresh logic lives in:

- `_fetch_stock_price()`
- `_fetch_usd_rates()`
- `_auto_price_and_entry()`

Supported exchange mappings are defined in `EXCHANGE_MAP` and currently cover:

- `NSE`
- `BSE`
- `DFM`
- `ADX`
- `NASDAQ Dubai`

When a shares asset is created, updated, or manually refreshed:

1. For `DFM`, the app bootstraps a browser-like session against `marketwatch.dfm.ae` and reads quote data from DFM's own market-watch feed.
2. For `ADX`, the app uses the same exchange-first flow against ADX's site and falls back to a delayed ADX quote page source if ADX blocks the server-side request.
3. For the remaining exchanges, it resolves the Yahoo Finance ticker suffix and fetches `regularMarketPrice` from Yahoo Finance.
4. It converts the market value to USD.
5. It updates `share_details.last_price*`.
6. It inserts a new `balance_entries` row with a note like `Auto: ...`.

If price fetching fails on create or update, the asset is still saved and the frontend shows an alert.

## Frontend Architecture

[static/app.js](static/app.js) manages everything client-side.

### Global state

The `state` object tracks:

- `session`
- `accounts`
- `buckets`
- current edit target ids
- selected auth tab
- selected read scope
- local OTP preview
- selected display currency
- current AED/INR rates

### Tabs

The UI has four tabs:

- `Dashboard`
- `Assets`
- `Buckets`
- `Timeline`

The timeline data is only loaded when the timeline tab is opened.

Before those tabs become visible, the auth shell handles:

- `Sign In`
- `Sign Up`
- `Activate Existing`
- `Forgot Password`

### Modal flows

There are modals for:

- Add/Edit Asset
- Add/Edit Bucket
- Add Balance Entry
- Manual Bucket Allocate
- Account History

The frontend uses direct DOM manipulation rather than a component framework.

### Charts

Chart.js is used for:

- a donut chart on the dashboard for latest net worth by asset type
- a line chart on the timeline page for per-account series plus total net worth

## API Reference

### Page route

- `GET /`: serve the app shell

### Auth

- `GET /api/auth/session`: current login/session payload
- `GET /api/auth/available-profiles`: unclaimed finance profiles for activation
- `GET /api/auth/local-otp-outbox`: latest local OTP delivery for an email + purpose
- `POST /api/auth/signin`: sign in with email + password
- `POST /api/auth/signup/start`: create a local sign-up OTP challenge
- `POST /api/auth/signup/verify`: verify OTP, create finance profile, create auth account, and sign in
- `POST /api/auth/activate-existing/start`: start claiming an existing finance profile created by older migrated local data
- `POST /api/auth/activate-existing/verify`: verify OTP, link auth account to that profile, and sign in
- `POST /api/auth/forgot-password/start`: create a password-reset OTP challenge
- `POST /api/auth/forgot-password/verify`: verify OTP and replace the password
- `POST /api/auth/logout`: clear the session

### Users

- `GET /api/users`: list users in the signed-in user’s current family

### Accounts

- `GET /api/accounts`: list active accounts with joined loan/share details
- `POST /api/accounts`: create an account
- `PATCH /api/accounts/<aid>`: update account fields and optional loan/share details
- `POST /api/accounts/<aid>/refresh-price`: refresh market price for a shares asset
- `DELETE /api/accounts/<aid>`: soft-delete an account

Notes:

- `GET /api/accounts` accepts `scope=me|all`
- `scope=all` is a read-only family aggregate
- `POST /api/accounts` ignores scope and writes to the signed-in user from session
- Creating a loan with principal inserts an initial negative balance entry
- Updating `remaining_principal` inserts another negative balance entry labeled `Principal update`
- Creating or editing shares triggers an automatic price fetch attempt

### Balance entries

- `GET /api/balances`: list recent balance entries, optionally filtered by `account_id`
- `GET /api/balances/latest`: latest entry per active account
- `POST /api/balances`: create a balance entry and optional bucket allocations
- `DELETE /api/balances/<bid>`: delete a balance entry

Notes:

- `GET /api/balances` and `GET /api/balances/latest` accept `scope=me|all`
- Manual entry creation is blocked in the UI for `loan` and `shares`
- Bucket allocations are only accepted for `bank` accounts
- Only `manual` buckets from the signed-in user can be assigned in `POST /api/balances`
- New `bank` snapshots inherit the previous latest manual bucket allocations for that account
- Saving a `bank` balance entry also re-applies current `auto` bucket allocations onto the latest bank snapshot

### Buckets

- `GET /api/buckets`: list buckets
- `POST /api/buckets`: create a bucket
- `PATCH /api/buckets/<bid>`: update bucket fields
- `POST /api/buckets/<bid>/allocate`: add manual allocation to a single manual bucket from current unallocated cash
- `POST /api/buckets/auto-allocate`: recalculate all `auto` bucket allocations from current bank balances
- `DELETE /api/buckets/<bid>`: delete a bucket

Notes:

- `GET /api/buckets` accepts `scope=me|all`
- all bucket writes use the signed-in user from session
- manual bucket allocation is blocked for `auto` buckets and for `All Users` mode in the UI

### Summaries

- `GET /api/summary/net-worth`: latest total net worth, grouped totals by account type, and unallocated cash calculated as latest `bank` balances minus latest `loan` balances minus current bank-bucket allocations
- `GET /api/summary/buckets`: bucket allocations using only each account’s latest balance entry
- `GET /api/summary/timeline`: time-series data grouped by `day`, `week`, or `month`

Notes:

- all summary endpoints accept `scope=me|all`
- `scope=all` merges matching account or bucket names across the signed-in user’s family only

### Rates

- `GET /api/rates`: fetch AED and INR conversion rates from a USD base, with fallback

## Timeline Semantics

The timeline endpoint does more than just aggregate raw rows.

For each active account:

1. Entries are grouped into day, week, or month periods in Python from each entry timestamp.
2. If multiple entries exist in the same period, the last row encountered for that period wins.
3. Missing later periods are forward-filled with the previous known value.
4. Net worth is computed as the sum of all account series at each period.

This means the chart behaves like a continuous net-worth history rather than showing only sparse entry dates.

## Data Flow Examples

### Creating a bank account and adding a balance

1. User creates a `bank` asset.
2. The account is stored in `accounts`.
3. User adds a balance entry.
4. The value is converted from display currency to USD in the browser.
5. The backend stores the value in `balance_entries`.
6. If the account is a `bank`, the previous latest manual bucket allocations for that account are carried forward unless the user changed them in this new entry.
7. If auto buckets exist, auto allocation is immediately recalculated against the latest bank snapshots.
8. Dashboard summaries now include that account’s latest entry.

### Auto-allocating buckets from bank cash

1. User marks one or more buckets as `Auto Allocate`.
2. User clicks `Allocate` on the Buckets tab.
3. The backend finds the latest balance entry for each active `bank` account.
4. Existing `manual` bucket allocations on those latest bank entries are left untouched.
5. Existing `auto` allocations on those latest bank entries are removed and recalculated.
6. Auto buckets are funded from total available bank cash, in bucket order, until targets are met or cash runs out.
7. The dashboard bucket summary updates immediately because it already reads from each account’s latest entry.

### Manually allocating a bucket

1. User clicks `Allocate` on a `Manual Allocate` bucket card.
2. The dialog shows current unallocated fund as read-only.
3. User enters an amount that cannot exceed current unallocated fund.
4. The backend adds that amount to the bucket across the latest active bank-account snapshots.
5. Unallocated cash decreases and the bucket summary updates immediately.

### Creating a loan

1. User creates a `loan` asset and enters principal/EMI metadata.
2. The account is stored in `accounts`.
3. Loan details are stored in `loan_details`.
4. If `remaining_principal` is provided, a negative balance entry is inserted automatically.
5. Net worth decreases by that principal amount.

### Creating a shares asset

1. User creates a `shares` asset with exchange, ticker, and quantity.
2. The account is stored in `accounts`.
3. Share metadata is stored in `share_details`.
4. The backend attempts to fetch the current price.
5. If successful, the latest price is saved and a balance entry is created from `price * quantity`.
6. If unsuccessful, the asset still exists but has no balance until a later successful refresh.

## Running The App

Install dependencies:

```bash
pip install -r requirements.txt
```

Start the server:

```bash
python app.py
```

The app runs on `http://127.0.0.1:5050`.

On startup, the app:

- uses `SOF_SECRET_KEY` when provided, otherwise creates `secret.key` if it does not already exist
- ensures the database schema exists
- applies in-code migrations
- starts Flask in debug mode

Optional runtime environment variables:

- `DATABASE_URL`: PostgreSQL connection string for hosted deployments
- `SOF_DATABASE_URL`: alternate name for the PostgreSQL connection string
- `SOF_DATA_DIR`: base directory for persisted app data such as `finance.db` and `secret.key`
- `SOF_DB_PATH`: explicit SQLite file path, overrides `SOF_DATA_DIR`
- `SOF_SECRET_KEY`: explicit Flask secret value, preferred for hosted deployments
- `SOF_SECRET_KEY_PATH`: explicit secret-key file path when not using `SOF_SECRET_KEY`

## Deploying On Render

Recommended Render setup is a web service plus Render Postgres. The app switches to PostgreSQL automatically when `DATABASE_URL` is set.

Manual setup for Render free tier:

1. Push this repo to GitHub.
2. In Render, create a new `Postgres` service.
3. Choose the `Free` Postgres plan if you are testing or using a hobby deployment.
4. In Render, create a new `Web Service` from the same repo.
5. Choose:
   - Runtime: `Python 3`
   - Instance type: `Free` or higher
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn --workers 1 --threads 4 wsgi:application`
   - Health check path: `/healthz`
6. Add environment variables on the web service:
   - `DATABASE_URL`: the connection string from your Render Postgres instance
   - `SOF_SECRET_KEY`: a generated random secret
7. Deploy the web service.

The optional [render.yaml](render.yaml) describes the same architecture for teams that use Render Blueprints.

- installing dependencies with `pip install -r requirements.txt`
- starting the app with `gunicorn --workers 1 --threads 4 wsgi:application`
- reading the database connection string from `DATABASE_URL`
- exposing a lightweight health check at `/healthz`

Important Render notes:

- Render free web services spin down after inactivity and use an ephemeral local filesystem, so PostgreSQL is the right place to persist data.
- Render free Postgres is suitable for testing and hobby use, but Render documents that free Postgres instances expire 30 days after creation.

## Current Constraints And Quirks

- Network calls to exchange-rate and stock-price APIs happen synchronously during requests.
- OTP delivery is local-only; the app shows the latest code in an in-app inbox instead of sending real email.
- The test suite is an in-repo `unittest` suite run via `python run_tests.py`.
- A deployment package should not include `finance.db` or `secret.key`; those are only for local SQLite-backed runs.
- The UI prevents manual entries for loans and shares, but the backend route does not validate asset type.
- Timeline y-axis tick labels are hardcoded with `$`, even though the app displays AED/INR elsewhere.
- The frontend only rerenders the dashboard when currency changes; assets, buckets, and open modals can show stale formatting until reopened or reloaded.
- The stylesheet includes `@apply` inside a plain `<style>` block, which Tailwind CDN does not process. The `.tab-btn.active` rule therefore does not currently work as written.

## Suggested Areas For Future Improvement

- Add onboarding flow for creating the first user profile
- Add user-management flow for creating, renaming, deleting, and inviting profiles
- Add real email delivery for OTP
- Add role types: `standard`, `family`, `family_admin`, `family_member`
- Add tests around summary, timeline, and migration behavior
- Move external API fetches behind a service layer with retries/caching
- Enforce backend validation for asset-specific entry rules
- Add README screenshots or sample seed data
- Split the frontend script into modules as the UI grows
- Formalize migrations instead of embedding schema rewrites in app startup
