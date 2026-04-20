CREATE TABLE IF NOT EXISTS families (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
    id               BIGSERIAL PRIMARY KEY,
    family_id        BIGINT REFERENCES families(id),
    name             TEXT NOT NULL UNIQUE,
    default_currency TEXT NOT NULL DEFAULT 'AED',
    created_at       TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS auth_accounts (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    email             TEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    email_verified_at TEXT,
    last_login_at     TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS'),
    updated_at        TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS accounts (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('bank', 'loan', 'shares', 'investment_group')),
    institution TEXT,
    currency    TEXT NOT NULL DEFAULT 'USD',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS loan_details (
    account_id          BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    interest_rate       DOUBLE PRECISION NOT NULL DEFAULT 0,
    remaining_tenure    INTEGER NOT NULL DEFAULT 0,
    monthly_emi         DOUBLE PRECISION NOT NULL DEFAULT 0,
    remaining_principal DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS share_details (
    account_id          BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    stock_name          TEXT,
    exchange            TEXT,
    stock_code          TEXT,
    quantity            DOUBLE PRECISION NOT NULL DEFAULT 0,
    purchase_price      DOUBLE PRECISION NOT NULL DEFAULT 0,
    purchase_price_currency TEXT NOT NULL DEFAULT 'USD',
    last_price          DOUBLE PRECISION,
    last_price_currency TEXT,
    last_fetched        TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    txn_type        TEXT NOT NULL CHECK(txn_type IN ('credit', 'debit', 'intra')),
    amount          DOUBLE PRECISION NOT NULL CHECK(amount > 0),
    source_amount   DOUBLE PRECISION,
    source_currency TEXT,
    destination_amount DOUBLE PRECISION,
    destination_currency TEXT,
    fx_rate         DOUBLE PRECISION,
    from_account_id BIGINT REFERENCES accounts(id),
    to_account_id   BIGINT REFERENCES accounts(id),
    counterparty    TEXT,
    note            TEXT,
    recorded_at     TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS'),
    created_at      TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS balance_entries (
    id             BIGSERIAL PRIMARY KEY,
    account_id     BIGINT NOT NULL REFERENCES accounts(id),
    amount         TEXT NOT NULL DEFAULT '0',
    note           TEXT,
    recorded_at    TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS'),
    transaction_id BIGINT REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS buckets (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    target          DOUBLE PRECISION,
    color           TEXT DEFAULT '#6366f1',
    allocation_type TEXT NOT NULL DEFAULT 'manual'
                        CHECK(allocation_type IN ('auto', 'manual')),
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS'),
    UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS bucket_allocations (
    id               BIGSERIAL PRIMARY KEY,
    balance_entry_id BIGINT NOT NULL REFERENCES balance_entries(id) ON DELETE CASCADE,
    bucket_id        BIGINT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    amount           TEXT NOT NULL,
    UNIQUE(balance_entry_id, bucket_id)
);

CREATE TABLE IF NOT EXISTS otp_challenges (
    id                BIGSERIAL PRIMARY KEY,
    email             TEXT NOT NULL,
    purpose           TEXT NOT NULL,
    code_hash         TEXT NOT NULL,
    payload           TEXT,
    expires_at        TEXT NOT NULL,
    resend_allowed_at TEXT NOT NULL,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    consumed_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS local_otp_outbox (
    id                BIGSERIAL PRIMARY KEY,
    challenge_id      BIGINT REFERENCES otp_challenges(id) ON DELETE CASCADE,
    email             TEXT NOT NULL,
    purpose           TEXT NOT NULL,
    code_plain        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    resend_allowed_at TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS zakat_settings (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    hawl_date            TEXT,
    nisab_standard       TEXT NOT NULL DEFAULT 'gold',
    stocks_rate          DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    gold_grams           DOUBLE PRECISION NOT NULL DEFAULT 0,
    gold_jewellery_grams DOUBLE PRECISION NOT NULL DEFAULT 0,
    silver_grams         DOUBLE PRECISION NOT NULL DEFAULT 0,
    business_goods       DOUBLE PRECISION NOT NULL DEFAULT 0,
    receivables          DOUBLE PRECISION NOT NULL DEFAULT 0,
    pension              DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS'),
    updated_at           TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')
);
