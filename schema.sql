CREATE TABLE IF NOT EXISTS families (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id   INTEGER REFERENCES families(id),
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_accounts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    email             TEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    email_verified_at TEXT,
    last_login_at     TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('bank', 'loan', 'shares', 'investment_group')),
    institution TEXT,
    currency    TEXT NOT NULL DEFAULT 'USD',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_details (
    account_id          INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    interest_rate       REAL NOT NULL DEFAULT 0,
    remaining_tenure    INTEGER NOT NULL DEFAULT 0,
    monthly_emi         REAL NOT NULL DEFAULT 0,
    remaining_principal REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS share_details (
    account_id          INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    stock_name          TEXT,
    exchange            TEXT,
    stock_code          TEXT,
    quantity            REAL NOT NULL DEFAULT 0,
    last_price          REAL,
    last_price_currency TEXT,
    last_fetched        TEXT
);

CREATE TABLE IF NOT EXISTS balance_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    amount         REAL NOT NULL,
    note           TEXT,
    recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS buckets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    target          REAL,
    color           TEXT DEFAULT '#6366f1',
    allocation_type TEXT NOT NULL DEFAULT 'manual'
                        CHECK(allocation_type IN ('auto', 'manual')),
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS bucket_allocations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    balance_entry_id INTEGER NOT NULL REFERENCES balance_entries(id) ON DELETE CASCADE,
    bucket_id        INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    amount           REAL NOT NULL,
    UNIQUE(balance_entry_id, bucket_id)
);

CREATE TABLE IF NOT EXISTS otp_challenges (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT NOT NULL,
    purpose           TEXT NOT NULL,
    code_hash         TEXT NOT NULL,
    payload           TEXT,
    expires_at        TEXT NOT NULL,
    resend_allowed_at TEXT NOT NULL,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    consumed_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS local_otp_outbox (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id      INTEGER REFERENCES otp_challenges(id) ON DELETE CASCADE,
    email             TEXT NOT NULL,
    purpose           TEXT NOT NULL,
    code_plain        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    resend_allowed_at TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    txn_type        TEXT    NOT NULL CHECK(txn_type IN ('credit','debit','intra')),
    amount          REAL    NOT NULL CHECK(amount > 0),
    from_account_id INTEGER REFERENCES accounts(id),
    to_account_id   INTEGER REFERENCES accounts(id),
    counterparty    TEXT,
    note            TEXT,
    recorded_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
