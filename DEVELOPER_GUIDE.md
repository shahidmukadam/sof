# State of Finance — Developer Guide

A complete reference for anyone who wants to understand, modify, or extend the codebase.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [How to Run Locally](#2-how-to-run-locally)
3. [Architecture Overview](#3-architecture-overview)
4. [Database Schema](#4-database-schema)
5. [Key Calculations — Where to Find and Change Them](#5-key-calculations)
6. [Adding a New Feature](#6-adding-a-new-feature)
7. [Encryption — How It Works](#7-encryption)
8. [Currency Handling](#8-currency-handling)
9. [Frontend (app.js) Guide](#9-frontend-guide)
10. [Building the Mac Package](#10-building-the-mac-package)
11. [Deploying to Render + Neon](#11-deploying-to-render--neon)
12. [Common Customisations](#12-common-customisations)

---

## 1. Project Structure

```
state-of-finance/
│
├── app.py                    ← All backend logic (Flask routes + helpers)
├── mac_launcher.py           ← Mac desktop launcher (Tkinter + Werkzeug)
├── windows_launcher.py       ← Windows desktop launcher
├── wsgi.py                   ← Production WSGI entry point (Render/Gunicorn)
│
├── schema.sql                ← SQLite schema (local / Mac app)
├── schema_postgres.sql       ← PostgreSQL schema (Render/Neon)
│
├── static/
│   └── app.js                ← Entire frontend (vanilla JS SPA)
│
├── templates/
│   └── index.html            ← Single HTML shell (loads app.js)
│
├── mac/
│   ├── build_mac_package.sh  ← One-command Mac build script
│   ├── StateOfFinance-mac.spec ← PyInstaller config for .app bundle
│   └── README-mac-package.txt ← End-user README (bundled in zip)
│
├── windows/
│   ├── build_windows_package.ps1
│   ├── StateOfFinance.spec
│   └── README-windows-package.txt
│
├── requirements.txt          ← Python dependencies
├── render.yaml               ← Render deployment config
└── migrate_to_postgres.py    ← One-time SQLite → PostgreSQL data migration
```

---

## 2. How to Run Locally

### Prerequisites
- Python 3.10 or later
- pip

### Setup

```bash
# Clone or download the project
cd state-of-finance

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate        # Mac/Linux
# .venv\Scripts\activate         # Windows

# Install dependencies
pip install -r requirements.txt

# Run the app
python3 app.py
```

The app starts at **http://127.0.0.1:5050/**

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `SOF_DATA_DIR` | project root | Where `finance.db` and `secret.key` are stored |
| `SOF_DB_PATH` | `$SOF_DATA_DIR/finance.db` | Override database path |
| `DATABASE_URL` | *(none)* | PostgreSQL connection string — switches backend to Postgres |
| `SOF_SECRET_KEY` | auto-generated file | Flask session secret |
| `SOF_ENCRYPTION_KEY` | *(none)* | Passphrase for application-level field encryption |
| `SESSION_COOKIE_SECURE` | `0` | Set to `true` in production (HTTPS only) |

---

## 3. Architecture Overview

```
Browser (app.js SPA)
      │  JSON API calls
      ▼
Flask (app.py)          ← All routes, business logic, helpers
      │
      ├── SQLite (local)   via sqlite3 + custom dict_row wrapper
      └── PostgreSQL       via psycopg3 + PostgresCompatConnection wrapper
```

**Key design decision:** A `PostgresCompatConnection` wrapper class in `app.py` makes psycopg3 behave like sqlite3 — same `?` placeholders, same `row['column']` access, same `.lastrowid`. This means all business logic is written once and works on both backends.

**Backend selection** is automatic:
```python
DB_BACKEND = 'postgres' if DATABASE_URL else 'sqlite'
```

---

## 4. Database Schema

### Core tables

| Table | Purpose |
|---|---|
| `families` | Optional grouping of users |
| `users` | Finance users (one per auth account) |
| `auth_accounts` | Login credentials (email + bcrypt hash) |
| `accounts` | Assets: `bank`, `loan`, `shares`, `investment_group` |
| `loan_details` | Extra fields for loan accounts |
| `share_details` | Stock code, exchange, quantity, prices |
| `balance_entries` | Every balance snapshot for every account |
| `buckets` | Savings goals / budget categories |
| `bucket_allocations` | How much of a balance entry is in each bucket |
| `transactions` | Credits, debits, internal transfers |
| `otp_challenges` | OTP codes for signup / password reset |
| `local_otp_outbox` | OTP delivery queue (local mode — no email server) |

### Adding a column to an existing table

1. Add the column to **`schema.sql`** (for new installs)
2. Add the column to **`schema_postgres.sql`** (for new Render deployments)
3. Add a migration in **`migrate_db()`** inside `app.py`:

For SQLite:
```python
# Inside the `with sqlite3.connect(DB_PATH) as conn:` block
cols = {row[1] for row in conn.execute("PRAGMA table_info(your_table)").fetchall()}
if 'your_new_column' not in cols:
    conn.execute("ALTER TABLE your_table ADD COLUMN your_new_column TEXT")
```

For PostgreSQL:
```python
# Inside the `if DB_BACKEND == 'postgres':` block
conn.execute("""
    ALTER TABLE your_table
    ADD COLUMN IF NOT EXISTS your_new_column TEXT
""")
```

---

## 5. Key Calculations

### Net Worth

**File:** `app.py`
**Function:** `net_worth()` (~line 3108)

```python
# For every account's latest balance entry:
usd_amount = _currency_to_usd(_dec_num(r['amount']), r['currency'], rates=rates)
total += usd_amount
```

To change what's included in net worth (e.g. exclude loans):
```python
# Add a filter to the WHERE clause:
where = [
    "a.is_active=1",
    "a.type != 'loan'",    # ← add this to exclude loans
    ...
]
```

---

### Cash Position / Unallocated Cash

**Function:** `_cash_position_summary()` (~line 1840)

```python
unallocated_cash = bank_cash_total - loan_total - allocated_total
```

- `bank_cash_total` — sum of latest balance entries for all bank accounts (in USD)
- `loan_total` — sum of absolute values of latest loan balances (in USD)
- `allocated_total` — total bucket allocations across all bank entries

---

### Loan EMI Breakdown

**Function:** `pay_loan_emi()` route (~line 2860)

```python
monthly_rate       = annual_rate / 12 / 100
interest_component = round(principal * monthly_rate, 2)
principal_component = round(max(emi - interest_component, 0), 2)
new_principal      = round(max(principal - principal_component, 0), 2)
new_tenure         = tenure - 1
```

To change the rounding precision, change the `round(..., 2)` calls.
To add a penalty or fee, add it to `interest_component` before calculating `principal_component`.

---

### Share Market Value

**Function:** `_auto_price_and_entry()` (~line 1614)

```python
value_native = _convert_currency_amount(price * qty, currency, native_currency)
```

- `price` — fetched live from Yahoo Finance / DFM / ADX
- `qty` — from `share_details.quantity`
- `currency` — native currency of the exchange (INR for NSE/BSE, AED for DFM/ADX)
- `value_native` — converted to the account's own currency

The result is stored as a `balance_entry`. The `latest_balance` on the account reflects this.

---

### Currency Conversion

**Function:** `_currency_to_usd()` and `_convert_currency_amount()` (~line 316)

```python
def _currency_to_usd(amount, currency, rates=None):
    rate = current_rates.get(normalized, 1.0)
    return float(amount) / rate
```

Exchange rates are fetched once per day from `open.er-api.com` and cached in memory (`_rates_cache`).

**To add a new currency (e.g. GBP):**

1. Add to `ALLOWED_CURRENCIES`:
```python
ALLOWED_CURRENCIES = {'AED', 'INR', 'USD', 'GBP'}   # ← add GBP
```

2. Update `_fetch_usd_rates()` to fetch GBP:
```python
rates = {
    'AED': data['rates']['AED'],
    'INR': data['rates']['INR'],
    'GBP': data['rates']['GBP'],   # ← add this
    'USD': 1.0
}
```

3. Add the toggle button in `static/app.js` (search for `setCurrency`).

---

### Bucket Allocation Logic

**Manual allocation:** `_allocate_manual_bucket()` (~line 1901)
Distributes a user-specified amount across bank entries, largest balance first.

**Auto allocation:** `_auto_allocate_buckets()` (~line 1944)
Fills each bucket up to its `target` amount from available unallocated cash, in bucket order.

To change the ordering of auto-allocation (e.g. fill smaller buckets first):
```python
# In _auto_allocate_buckets(), change the SQL sort:
ORDER BY target ASC, sort_order, name   -- ← smallest target first
```

---

## 6. Adding a New Feature

### Backend — new API route

All routes live in `app.py`. Follow this pattern:

```python
@app.route('/api/your-feature', methods=['GET'])
@login_required
def your_feature():
    db = get_db()
    user_id = current_finance_user_id()
    # ... your logic ...
    return jsonify({'ok': True, 'data': result})
```

`@login_required` automatically returns a 401 if the user is not logged in.
`get_db()` returns a database connection (SQLite or PostgreSQL, transparently).
`current_finance_user_id()` returns the logged-in user's finance profile ID.

### Frontend — calling the new route

In `static/app.js`, use the `api()` helper:

```javascript
const result = await api('/api/your-feature');
```

`api(url, method='GET', body=null)` handles authentication, JSON parsing, and error throwing automatically.

---

## 7. Encryption

**Controlled by:** `SOF_ENCRYPTION_KEY` environment variable.

When set, these fields are stored as Fernet ciphertext in the database:

| Table | Encrypted columns |
|---|---|
| `balance_entries` | `amount`, `note` |
| `bucket_allocations` | `amount` |
| `accounts` | `name`, `institution` |
| `buckets` | `name`, `target` |
| `transactions` | `counterparty`, `note` |

### Helper functions

```python
_enc(value)       # encrypt before writing to DB
_dec(value)       # decrypt text field read from DB
_dec_num(value)   # decrypt numeric field (returns float)
```

All three are **safe to call even when encryption is disabled** — they pass through the value unchanged.

### Fallback behaviour

If a value cannot be decrypted (e.g. legacy plaintext data from before the key was set), `_dec()` returns the original value unchanged. This means you can enable encryption on an existing database and the startup migration (`_encrypt_existing_data_sqlite`) will encrypt the old rows automatically.

### Changing the encryption key

**Warning:** Changing the key will make all existing encrypted data unreadable.

If you must rotate the key:
1. Decrypt all data using the old key first (run `_encrypt_existing_data_sqlite` with the old key to confirm all data is encrypted, then write a script to decrypt everything).
2. Change `SOF_ENCRYPTION_KEY`.
3. Re-run the app — the startup migration will re-encrypt everything with the new key.

---

## 8. Currency Handling

### Display currency vs. storage currency

- **Storage:** all numeric values are stored in the account's own native currency (e.g. a DFM account stores in AED, an NSE account stores in INR).
- **Display:** the frontend converts everything to the user's chosen display currency (AED / INR / USD) using live rates fetched once per day.

### The `_ACCOUNT_SELECT` template

The shared SQL template in `app.py` (line ~194) fetches the latest balance entry inline:

```sql
(SELECT be.amount FROM balance_entries be
 WHERE be.account_id = a.id
 ORDER BY be.id DESC LIMIT 1) AS latest_balance
```

This `latest_balance` is in the account's native currency. It is converted to USD in `_serialize_account_row()` via `_currency_to_usd()`.

---

## 9. Frontend Guide

The entire frontend is a single-page app in **`static/app.js`** (vanilla JS, no framework).

### Key functions

| Function | What it does |
|---|---|
| `loadData()` | Fires all 5 API calls in parallel, populates `state`, calls render functions |
| `renderAccounts()` | Renders the Assets tab — all account cards |
| `renderBuckets()` | Renders the Buckets tab |
| `_renderDashboard()` | Renders the Dashboard tab from cached state |
| `setCurrency(c)` | Switches display currency, re-renders from state (no server call) |
| `money(v)` | Formats a USD number in the current display currency |
| `api(url, method, body)` | Fetch wrapper — handles auth, JSON, errors |
| `openAddEntry(accountId)` | Opens the balance entry modal for a specific account |

### Global state object

```javascript
const state = {
    accounts: [],        // serialized account rows from /api/accounts
    buckets: [],         // from /api/buckets
    netWorthSummary: {}, // from /api/summary/net-worth
    bucketSummary: [],   // from /api/summary/buckets
    rates: {},           // from /api/rates (cached 10 min in browser)
    currency: 'AED',     // current display currency
    session: {},         // from /api/auth/session
    scope: 'me',         // 'me' or 'all' (family scope)
};
```

### Adding a new tab

1. Add a tab button in `templates/index.html`
2. Add a `<div id="tab-yourname" class="hidden">` section
3. Add a tab switch case in the `switchTab()` function in `app.js`
4. Add a render function `renderYourTab()`

---

## 10. Building the Mac Package

### Prerequisites

- macOS (Intel or Apple Silicon)
- Python 3.10+

### Build steps

```bash
# From the project root:
chmod +x mac/build_mac_package.sh
./mac/build_mac_package.sh
```

The script:
1. Creates a fresh virtual environment
2. Installs Flask, Werkzeug, cryptography, PyInstaller
3. Runs PyInstaller with `mac/StateOfFinance-mac.spec`
4. Packages the resulting `.app` and the user README into `dist/StateOfFinance-mac.zip`

### Output

```
dist/
├── StateOfFinance.app        ← the macOS app bundle
└── StateOfFinance-mac.zip    ← distributable archive (share this)
```

### Apple Silicon vs Intel

The build produces a native binary for whichever Mac you build on.
To build a universal binary (runs on both), set `target_arch` in the spec file:

```python
# In mac/StateOfFinance-mac.spec:
target_arch='universal2'   # requires both architectures to be available
```

### Code signing (optional)

To remove the "unidentified developer" warning, sign the app:

```bash
codesign --deep --force --sign "Developer ID Application: Your Name (XXXXXXXXXX)" \
    dist/StateOfFinance.app
```

---

## 11. Deploying to Render + Neon

### One-time setup

1. Create a free account at [neon.tech](https://neon.tech) and create a project.
   Copy the `postgresql://...` connection string.

2. Create a free account at [render.com](https://render.com).
   Connect your GitHub repo.

3. In the Render dashboard, add these environment variables:
   - `DATABASE_URL` — your Neon connection string
   - `SOF_SECRET_KEY` — any random 32+ character string
   - `SESSION_COOKIE_SECURE` — `true`
   - `SOF_ENCRYPTION_KEY` — any passphrase (enables field encryption)

4. Deploy. Render uses `render.yaml` for configuration.

### Migrating local data to the cloud

```bash
python3 migrate_to_postgres.py "postgresql://your-neon-connection-string"
```

This exports your local SQLite data and imports it to PostgreSQL in the correct dependency order.

---

## 12. Common Customisations

### Change the default currency

In `app.py`, find:
```python
"ALTER TABLE users ADD COLUMN default_currency TEXT NOT NULL DEFAULT 'AED'"
```
Change `'AED'` to `'USD'` or `'INR'`.

Also update the signup flow default in `_session_payload()` if needed.

---

### Add a new stock exchange

In `app.py`, find `EXCHANGE_MAP`:

```python
EXCHANGE_MAP = {
    'NSE':  {'suffix': '.NS', 'currency': 'INR'},
    'BSE':  {'suffix': '.BO', 'currency': 'INR'},
    'DFM':  {'suffix': '.DU', 'currency': 'AED'},
    'ADX':  {'suffix': '.AD', 'currency': 'AED'},
    'NASDAQ Dubai': {'suffix': '.DI', 'currency': 'USD'},
}
```

Add your exchange:
```python
'LSE': {'suffix': '.L', 'currency': 'GBP'},   # London Stock Exchange
```

Then add `'GBP'` to `ALLOWED_CURRENCIES` and `_fetch_usd_rates()` as described in [section 5](#currency-conversion).

---

### Change the session lifetime

In `app.py`:
```python
app.permanent_session_lifetime = timedelta(days=180)  # ← change this
```

---

### Change OTP expiry or attempt limits

In `app.py`, near the top:
```python
OTP_TTL_MINUTES   = 10    # how long a code is valid
OTP_RESEND_SECONDS = 60   # minimum gap before requesting a new code
OTP_MAX_ATTEMPTS  = 3     # wrong guesses before the code is invalidated
```

---

### Disable the OTP / signup flow

For a purely personal single-user setup, you can pre-create a user directly in the database and skip OTP entirely. The local OTP codes appear in the app at `/api/auth/local-otp-outbox` — no email server is required.

---

## Questions?

Open an issue or reach out. The codebase is intentionally kept in as few files as possible — `app.py` and `app.js` — so everything is easy to find and change.
