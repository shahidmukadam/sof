# State of Finance — Developer Guide

A complete reference for anyone who wants to understand, modify, or extend the codebase.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [How to Run Locally](#2-how-to-run-locally)
3. [Architecture Overview](#3-architecture-overview)
4. [Database Schema](#4-database-schema)
5. [Key Calculations](#5-key-calculations)
6. [Adding a New Feature](#6-adding-a-new-feature)
7. [Encryption](#7-encryption)
8. [Currency Handling](#8-currency-handling)
9. [Metals (Gold & Silver)](#9-metals-gold--silver)
10. [Zakaat Calculator](#10-zakaat-calculator)
11. [Frontend Guide](#11-frontend-guide)
12. [Building the Mac Package](#12-building-the-mac-package)
13. [Deploying to Render + Neon](#13-deploying-to-render--neon)
14. [Common Customisations](#14-common-customisations)

---

## 1. Project Structure

```
state-of-finance/
│
├── app.py                    ← All backend logic (Flask routes + helpers)
├── mac_launcher.py           ← Mac desktop launcher (Tkinter + Werkzeug)
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
├── requirements.txt          ← Python dependencies
├── render.yaml               ← Render deployment config
├── migrate_to_postgres.py    ← One-time SQLite → PostgreSQL data migration
└── DEVELOPER_GUIDE.md        ← This file
```

---

## 2. How to Run Locally

### Prerequisites
- Python 3.10 or later
- pip / pip3

### Setup

```bash
cd state-of-finance

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate        # Mac/Linux
# .venv\Scripts\activate         # Windows

# Install dependencies
pip3 install -r requirements.txt

# Run the app
python3 app.py
```

The app starts at **http://127.0.0.1:5050/**

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `SOF_DATA_DIR` | project root | Where `finance.db` is stored |
| `SOF_DB_PATH` | `$SOF_DATA_DIR/finance.db` | Override database path |
| `DATABASE_URL` | *(none)* | PostgreSQL connection string — switches backend to Postgres |
| `SOF_SECRET_KEY` | auto-generated | Flask session secret |
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

**Key design decision:** A `PostgresCompatConnection` wrapper in `app.py` makes psycopg3 behave like sqlite3 — same `?` placeholders, same `row['column']` access, same `.lastrowid`. All business logic is written once and works on both backends.

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
| `accounts` | Assets: `bank`, `loan`, `shares`, `investment_group`, `metal` |
| `loan_details` | Extra fields for loan accounts (rate, tenure, EMI, principal) |
| `share_details` | Stock code, exchange, quantity, prices for shares |
| `metal_details` | Metal type, holding type, grams for metal accounts |
| `balance_entries` | Every balance snapshot for every account (amount stored as TEXT) |
| `buckets` | Savings goals / budget categories |
| `bucket_allocations` | How much of a balance entry is in each bucket (amount as TEXT) |
| `transactions` | Credits, debits, internal transfers |
| `zakat_settings` | Per-user Zakaat configuration and manual grams inputs |
| `otp_challenges` | OTP codes for signup / password reset |
| `local_otp_outbox` | OTP delivery queue (local mode — no email server needed) |

### Why `balance_entries.amount` is TEXT

Amounts are stored as TEXT (not REAL/DOUBLE) to support Fernet encryption.
When `SOF_ENCRYPTION_KEY` is set, amounts are ciphertext strings like `gAAAAA...`.
When no key is set, amounts are stored as plain numeric strings like `"12345.67"`.
Use `_dec_num(row['amount'])` to always get a `float`, regardless of encryption state.

### Adding a column to an existing table

1. Add the column to **`schema.sql`** (for new installs)
2. Add the column to **`schema_postgres.sql`** (for new Render deployments)
3. Add a migration in **`migrate_db()`** inside `app.py`:

**SQLite** (add column — preferred, no rebuild needed):
```python
# Inside the `with sqlite3.connect(DB_PATH) as conn:` block
cols = {row[1] for row in conn.execute("PRAGMA table_info(your_table)").fetchall()}
if 'your_new_column' not in cols:
    conn.execute("ALTER TABLE your_table ADD COLUMN your_new_column TEXT")
```

**SQLite** (change column type — requires full table rebuild):
```python
# IMPORTANT: commit any pending transaction first, then disable FKs
conn.commit()
conn.execute("PRAGMA foreign_keys = OFF")
conn.execute("CREATE TABLE your_table_new (...)")
conn.execute("INSERT INTO your_table_new SELECT col1, col2 FROM your_table")
conn.execute("DROP TABLE your_table")
conn.execute("ALTER TABLE your_table_new RENAME TO your_table")
conn.commit()
conn.execute("PRAGMA foreign_keys = ON")
# ⚠️ Always commit + disable FKs together.
# SQLite 3.26+ automatically updates FK references in child tables when a
# parent is renamed — if FKs are ON during DROP, cascade deletes will wipe
# child rows.
```

**PostgreSQL**:
```python
# Inside the `if DB_BACKEND == 'postgres':` block
conn.execute("ALTER TABLE your_table ADD COLUMN IF NOT EXISTS your_new_column TEXT")
```

---

## 5. Key Calculations

### Net Worth

**File:** `app.py` — function `net_worth()`

```python
# For every account's latest balance entry:
usd_amount = _currency_to_usd(_dec_num(r['amount']), r['currency'], rates=rates)
total += usd_amount
```

Loans are included (as negative values since their balance entries are negative).
To exclude loans: add `"a.type != 'loan'"` to the WHERE clause.

---

### Cash Position / Unallocated Cash

**Function:** `_cash_position_summary()`

```
unallocated_cash = bank_cash_total - abs(loan_total) - allocated_to_buckets
```

- `bank_cash_total` — sum of latest balance entries for all bank accounts (USD)
- `loan_total` — sum of absolute loan balances (subtracted)
- `allocated_to_buckets` — total bucket allocations across all bank entries

---

### Loan EMI Breakdown

**Function:** route `pay_loan_emi()`

```python
monthly_rate        = annual_rate / 12 / 100
interest_component  = round(principal * monthly_rate, 2)
principal_component = round(max(emi - interest_component, 0), 2)
new_principal       = round(max(principal - principal_component, 0), 2)
new_tenure          = tenure - 1
```

To add a penalty, add it to `interest_component` before computing `principal_component`.

---

### Share Market Value

**Function:** `_auto_price_and_entry()`

```python
value_native = price * quantity                   # in exchange currency
value_stored = convert_to_account_currency(...)   # then convert to account currency
db.execute("INSERT INTO balance_entries ...")       # stored encrypted if key is set
```

- Price fetched live from Yahoo Finance (ticker `STOCK.NS`, `STOCK.DU`, etc.)
- Exchange → currency mapping in `EXCHANGE_MAP`

---

### Metal Value (Gold & Silver)

**Function:** `_auto_price_metal_account()`

```python
price_usd_per_g = metals['gold_per_gram']   # or silver_per_gram
value_usd       = quantity_grams * price_usd_per_g
value_native    = convert_to_account_currency(value_usd, 'USD', account_currency)
```

- Prices fetched from Yahoo Finance: `GC=F` (gold futures), `SI=F` (silver futures)
- Converted from USD/troy oz → USD/gram using `TROY_OZ_TO_GRAMS = 31.1035`
- Cached daily in `_metals_cache`
- Fallback prices used if Yahoo Finance is unavailable

---

### Zakaat Calculation

**Function:** route `zakat_summary()`

```
Net Zakatable = Cash + Stocks×rate + Gold(investable) + Silver + Business + Receivables + Pension
              − Loan deductions (EMI × 12)

Zakat Due = Net Zakatable × 2.5%   (only if Net Zakatable ≥ Nisab)
```

- **Nisab (Gold):** 87.48g × live gold price
- **Nisab (Silver):** 612.36g × live silver price
- **Stocks rate:** 25% (trading portfolio) or 100% (full value)
- **Loan deduction:** `monthly_emi × 12` for all active loans
- **Gold grams:** auto-summed from `metal_details` accounts + manual entry in `zakat_settings`
- **Jewellery grams:** auto-summed from metal accounts with `holding_type='jewellery'`; deducted from total gold before Zakaat calculation

All values returned in the user's display currency via `_fetch_usd_rates()`.

---

### Currency Conversion

**Functions:** `_currency_to_usd()`, `_convert_currency_amount()`

```python
def _currency_to_usd(amount, currency, rates=None):
    rate = current_rates.get(currency, 1.0)
    return float(amount) / rate
```

Exchange rates fetched once per day from `open.er-api.com`, cached in `_rates_cache`.

**To add a new currency (e.g. GBP):**

1. Add to `ALLOWED_CURRENCIES`:
```python
ALLOWED_CURRENCIES = {'AED', 'INR', 'USD', 'GBP'}
```

2. Update `_fetch_usd_rates()` to include GBP in the rates dict.

3. Add a toggle button in `static/app.js` (search for `setCurrency`).

---

### Bucket Allocation Logic

**Manual allocation:** `_allocate_manual_bucket()`
Adds a user-specified amount to a bucket on the account's latest balance entry.

**Auto allocation:** `_auto_allocate_buckets()`
Fills each auto-bucket up to its target from unallocated cash, in bucket order.

To change auto-allocation ordering (e.g. fill smallest buckets first):
```python
# In _auto_allocate_buckets(), change the SQL sort:
ORDER BY target ASC, sort_order, name
```

---

## 6. Adding a New Feature

### Backend — new API route

```python
@app.route('/api/your-feature', methods=['GET'])
@login_required
def your_feature():
    db = get_db()
    user_id = current_finance_user_id()
    # ... logic ...
    return jsonify({'ok': True, 'data': result})
```

- `@login_required` returns 401 if not logged in
- `get_db()` returns a connection (SQLite or PostgreSQL, transparently)
- `current_finance_user_id()` returns the logged-in user's finance profile ID

### Frontend — calling the route

```javascript
const result = await api('/api/your-feature');             // GET
const result = await api('/api/your-feature', 'POST', {key: value}); // POST
```

`api()` handles authentication, JSON parsing, and error throwing automatically.

### Adding a new tab

1. Add a nav button in `templates/index.html` with `data-tab="yourtab"` and `onclick="switchTab('yourtab')"`
2. Add `<section id="tab-yourtab" class="hidden">` in `main`
3. Add `'yourtab'` to the tabs array in `switchTab()` in `app.js`
4. Add `if (name === 'yourtab') loadYourTab()` in `switchTab()`
5. Write `loadYourTab()` and `renderYourTab()` functions in `app.js`

### Adding a new account type

1. Add the type string to the CHECK constraint in `accounts` (migration required — see §4)
2. Add a `your_type_details` table if extra metadata is needed
3. Update `_ACCOUNT_SELECT` to LEFT JOIN the new details table
4. Update `_serialize_account_row()` to handle the new type
5. Update `create_account()` and `update_account()` routes
6. Add the option in the `accType` select in `index.html`
7. Add a show/hide section in `onAccTypeChange()` in `app.js`
8. Update `saveAccount()` to include the new payload fields
9. Update `renderAccountCard()`, `typeLabel()`, section groupings and color maps

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
_enc(value)       # encrypt before writing to DB — pass-through if key not set
_dec(value)       # decrypt text field read from DB — pass-through if key not set
_dec_num(value)   # decrypt numeric field, returns float — pass-through if key not set
```

### Key derivation

The passphrase is hashed with SHA-256 and base64-encoded to produce a valid 32-byte Fernet key:
```python
key_bytes  = hashlib.sha256(passphrase.encode()).digest()
fernet_key = base64.urlsafe_b64encode(key_bytes)
```

### Fallback behaviour

`_dec()` catches `InvalidToken` exceptions and returns the original value.
This means legacy plaintext rows continue to work — the startup migration
(`_encrypt_existing_data_sqlite` / `_encrypt_existing_data_postgres`) encrypts
them idempotently on next startup.

### SQL aggregation with encrypted amounts

You **cannot** use `SUM(amount)` in SQL when amounts are encrypted TEXT.
Always fetch individual rows and sum in Python:

```python
rows = db.execute("SELECT amount FROM balance_entries WHERE ...").fetchall()
total = sum(_dec_num(r['amount']) or 0 for r in rows)
```

### Changing the encryption key

**Warning:** Changing the key makes all existing encrypted data unreadable.
Rotation requires decrypting all data first, changing the key, then re-encrypting.

---

## 8. Currency Handling

### Storage vs. display

- **Storage:** amounts are stored in the account's native currency (AED for DFM accounts, INR for NSE accounts, etc.)
- **Display:** the frontend converts everything to the user's chosen display currency (AED / INR / USD) using `money(usdValue)` or `moneyFromStored(amount, nativeCurrency)`

### The `_ACCOUNT_SELECT` template

```sql
SELECT a.*,
       ld.interest_rate, ld.remaining_tenure, ld.monthly_emi, ld.remaining_principal,
       sd.stock_name, sd.exchange, sd.stock_code, sd.quantity, ...
       md.metal_type, md.holding_type, md.quantity_grams,
       (SELECT be.amount FROM balance_entries be
        WHERE be.account_id = a.id ORDER BY be.id DESC LIMIT 1) AS latest_balance
FROM accounts a
JOIN users u ON u.id = a.user_id
LEFT JOIN loan_details ld ON ld.account_id = a.id
LEFT JOIN share_details sd ON sd.account_id = a.id
LEFT JOIN metal_details md ON md.account_id = a.id
```

`latest_balance` is the encrypted amount in native currency. Decrypted and converted in `_serialize_account_row()`.

---

## 9. Metals (Gold & Silver)

### Account type: `metal`

Metal accounts work like shares — the balance is auto-calculated from quantity × live price.

**`metal_details` table:**

| Column | Type | Description |
|---|---|---|
| `account_id` | INTEGER | FK to accounts |
| `metal_type` | TEXT | `'gold'` or `'silver'` |
| `holding_type` | TEXT | `'jewellery'`, `'digital_gold'`, `'physical'` (null for silver) |
| `quantity_grams` | REAL | Weight in grams |

### Price fetching

```python
def _fetch_metals_usd():
    # Yahoo Finance tickers: GC=F (gold), SI=F (silver)
    # Price is in USD per troy oz → divide by 31.1035 for USD per gram
    # Cached daily in _metals_cache
    # Fallback: gold $97/g, silver $1.05/g if Yahoo Finance fails
```

### Auto-pricing

On account create/update and on ↻ Refresh:
```python
def _auto_price_metal_account(db, account_id):
    price_usd_per_g = metals['gold_per_gram']  # or silver_per_gram
    value_usd       = grams * price_usd_per_g
    value_native    = _convert_currency_amount(value_usd, 'USD', account_currency)
    # Inserts a new balance_entry with the calculated value
```

### Zakaat integration

Metal accounts feed automatically into the Zakaat summary:
- Gold grams: all `metal_type='gold'` accounts
- Jewellery grams: `metal_type='gold'` AND `holding_type='jewellery'`
- Silver grams: all `metal_type='silver'` accounts

Any grams entered manually in `zakat_settings` are added on top.

### To change the fallback prices

In `app.py`, find `_fetch_metals_usd()`:
```python
fallback = {
    'gold_per_gram':   97.0,    # ← change these
    'silver_per_gram': 1.05,
    'gold_per_oz':     3018.0,
    'silver_per_oz':   32.65,
}
```

### To add a new metal type (e.g. Platinum)

1. Add `'platinum'` to the CHECK in `metal_details` (migration required)
2. Add a Yahoo Finance ticker in `_fetch_metals_usd()` (e.g. `PL=F`)
3. Add `platinum_per_gram` to the metals dict
4. Handle the new type in `_auto_price_metal_account()`
5. Add a UI button in `index.html` and `setMetalType()` in `app.js`

---

## 10. Zakaat Calculator

### Settings (`zakat_settings` table per user)

| Column | Default | Description |
|---|---|---|
| `hawl_date` | null | Date one lunar year of ownership started |
| `nisab_standard` | `'gold'` | `'gold'` (87.48g) or `'silver'` (612.36g) |
| `stocks_rate` | `0.25` | `0.25` (25%) or `1.0` (100%) |
| `gold_grams` | 0 | Manual gold grams (added to metal accounts) |
| `gold_jewellery_grams` | 0 | Manual jewellery grams (added to metal jewellery) |
| `silver_grams` | 0 | Manual silver grams (added to metal accounts) |
| `business_goods` | 0 | Business inventory value in display currency |
| `receivables` | 0 | Money owed to user in display currency |
| `pension` | 0 | Accessible pension/retirement in display currency |

### API endpoints

| Method | URL | Description |
|---|---|---|
| `GET` | `/api/zakat/settings` | Returns current settings |
| `PATCH` | `/api/zakat/settings` | Updates one or more settings fields |
| `GET` | `/api/zakat/summary` | Full Zakaat calculation with live prices |

### To change the Nisab thresholds

In `app.py`, near `_fetch_metals_usd()`:
```python
GOLD_NISAB_GRAMS   = 87.48    # ← change here
SILVER_NISAB_GRAMS = 612.36   # ← change here
```

### To change the Zakaat rate (currently 2.5%)

In `zakat_summary()`:
```python
zakat_due_usd = net_zakatable_usd * 0.025   # ← change 0.025
```

### To add a new zakatable asset category

1. Add a column to `zakat_settings` (migration)
2. Include it in `_get_or_create_zakat_settings()` INSERT defaults
3. Add it to the PATCH validation in `update_zakat_settings()`
4. Sum it into `total_assets_usd` in `zakat_summary()`
5. Add an input field in the Zakaat frontend tab (`loadZakat()` / `renderZakat()` in `app.js`)

---

## 11. Frontend Guide

The entire frontend is a single-page app in **`static/app.js`** (vanilla JS, no framework).

### Key functions

| Function | What it does |
|---|---|
| `loadData()` | Fires all API calls in parallel, populates `state`, calls render functions |
| `renderAccounts()` | Renders the Assets tab with section groupings |
| `renderBuckets()` | Renders the Buckets tab |
| `_renderDashboard()` | Renders the Dashboard tab from cached state |
| `loadZakat()` | Fetches Zakaat settings + summary, calls `renderZakat()` |
| `renderZakat()` | Renders the full Zakaat tab UI |
| `setCurrency(c)` | Switches display currency, re-renders from state (no API call) |
| `money(v)` | Formats a USD value in the current display currency |
| `moneyFromStored(v, nativeCurrency)` | Formats a native-currency value in display currency |
| `api(url, method, body)` | Fetch wrapper — handles auth, JSON, errors |
| `switchTab(name)` | Shows/hides tabs and triggers load functions |

### Global state object

```javascript
const state = {
    accounts: [],        // from /api/accounts
    buckets: [],         // from /api/buckets
    netWorthSummary: {}, // from /api/summary/net-worth
    bucketSummary: [],   // from /api/summary/buckets
    rates: {},           // from /api/rates
    currency: 'AED',     // current display currency
    session: {},         // from /api/auth/session
    scope: 'me',         // 'me' or 'all' (family scope)
    collapsedAssetSections: {},  // which type sections are collapsed
    expandedAccounts: {},        // which account cards are expanded
};
```

### Account card rendering

`renderAccountCard(account, { readOnly, typeColors })` in `app.js` builds each card.
- Type badge uses `typeLabel(type)` for standard types, `metalLabel(account)` for metals
- Footer buttons: `+ Entry`, `History`, `Details` for bank/loan/shares; `↻ Refresh Price` for metal/shares; `Edit`, `Delete` for all
- Section grouping order: Bank → Shares → Investment → **Metals** → Loans

### Type color map (update when adding types)

```javascript
const typeColors = {
    bank:             'bg-emerald-500/20 text-emerald-400',
    loan:             'bg-orange-500/20 text-orange-400',
    shares:           'bg-indigo-500/20 text-indigo-400',
    investment_group: 'bg-blue-500/20 text-blue-400',
    metal:            'bg-yellow-500/20 text-yellow-400',   // ← added
};
```

---

## 12. Building the Mac Package

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
4. Packages the `.app` and user README into `dist/StateOfFinance-mac.zip`

### Output

```
dist/
├── StateOfFinance.app        ← the macOS app bundle (~24 MB)
└── StateOfFinance-mac.zip    ← distributable archive (share this)
```

### Data storage (Mac app)

```
~/Library/Application Support/State of Finance/
    finance.db     ← your data
    secret.key     ← Flask session secret (auto-generated)
```

### First-launch Gatekeeper bypass

Right-click → Open → Open (on first launch only).

### Apple Silicon vs Intel

The build is native to the machine it's built on. For a universal binary:
```python
# In mac/StateOfFinance-mac.spec:
target_arch='universal2'
```

---

## 13. Deploying to Render + Neon

### One-time setup

1. Create a free account at [neon.tech](https://neon.tech) and create a project.
   Copy the `postgresql://...` connection string.

2. Create a free account at [render.com](https://render.com). Connect your GitHub repo.

3. In the Render dashboard, add these environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your Neon connection string |
| `SOF_SECRET_KEY` | Any random 32+ character string |
| `SESSION_COOKIE_SECURE` | `true` |
| `SOF_ENCRYPTION_KEY` | Any passphrase (enables field encryption) |

4. Deploy. Render uses `render.yaml` for configuration.

### Migrating local data to the cloud

```bash
python3 migrate_to_postgres.py "postgresql://your-neon-connection-string"
```

This exports your local SQLite data and imports it to PostgreSQL in dependency order.

### Cloud vs. local feature parity

All features work identically on both backends **except:**
- `local_otp_outbox` (OTP inbox panel) — only visible in local mode, not on Render
- `SOF_ENCRYPTION_KEY` must be set on Render to encrypt data at the database level

---

## 14. Common Customisations

### Change the default display currency

In `app.py`, find:
```python
"ALTER TABLE users ADD COLUMN default_currency TEXT NOT NULL DEFAULT 'AED'"
```
Change `'AED'` to `'USD'` or `'INR'`.

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

Add your exchange, e.g.:
```python
'LSE': {'suffix': '.L', 'currency': 'GBP'},
```

Then add GBP to `ALLOWED_CURRENCIES` and `_fetch_usd_rates()`.

---

### Change the session lifetime

```python
# In app.py:
app.permanent_session_lifetime = timedelta(days=180)  # ← change this
```

---

### Change OTP expiry or attempt limits

```python
# Near the top of app.py:
OTP_TTL_MINUTES    = 10    # how long a code is valid
OTP_RESEND_SECONDS = 60    # minimum gap before requesting a new code
OTP_MAX_ATTEMPTS   = 3     # wrong guesses before the code is invalidated
```

---

### Disable OTP (single-user local setup)

OTP codes appear in the app at the local OTP inbox panel — no email server required.
For a single-user setup you can pre-create a user directly in the database and skip OTP.

---

### Change metal price fallbacks

If Yahoo Finance is unavailable, these values are used:
```python
# In _fetch_metals_usd() in app.py:
fallback = {
    'gold_per_gram':   97.0,
    'silver_per_gram': 1.05,
    'gold_per_oz':     3018.0,
    'silver_per_oz':   32.65,
}
```

---

### Change Zakaat nisab thresholds or rate

```python
# In app.py, near _fetch_metals_usd():
GOLD_NISAB_GRAMS   = 87.48    # grams of gold for nisab
SILVER_NISAB_GRAMS = 612.36   # grams of silver for nisab

# In zakat_summary() route:
zakat_due_usd = net_zakatable_usd * 0.025   # 2.5% rate
```

---

## Questions?

The codebase is intentionally kept in as few files as possible — `app.py` and `app.js` — so everything is easy to find and change. Search for a function name or route path and you'll land in the right place.
