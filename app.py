import hashlib
import http.cookiejar
import json as _json
import os
import re
import secrets
import sqlite3
import urllib.request
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

try:
    import psycopg
    from psycopg.rows import dict_row as pg_dict_row
except ImportError:
    psycopg = None
    pg_dict_row = None

APP_DIR = os.path.dirname(__file__)
DATA_DIR = os.environ.get('SOF_DATA_DIR', APP_DIR)
DB_PATH = os.environ.get('SOF_DB_PATH', os.path.join(DATA_DIR, 'finance.db'))
SECRET_KEY_PATH = os.environ.get('SOF_SECRET_KEY_PATH', os.path.join(DATA_DIR, 'secret.key'))
DATABASE_URL = os.environ.get('DATABASE_URL') or os.environ.get('SOF_DATABASE_URL') or ''
if DATABASE_URL.startswith('postgres://'):
    DATABASE_URL = 'postgresql://' + DATABASE_URL[len('postgres://'):]
DB_BACKEND = 'postgres' if DATABASE_URL else 'sqlite'
BUCKET_ALLOCATION_TYPES = {'auto', 'manual'}
OTP_PURPOSES = {'signup', 'activate_existing', 'reset_password'}
OTP_TTL_MINUTES = 10
OTP_RESEND_SECONDS = 60
OTP_MAX_ATTEMPTS = 3
READ_SCOPES = {'me', 'all'}
PASSWORD_HASH_METHOD = 'pbkdf2:sha256:600000'
_POSTGRES_RETURNING_ID_TABLES = {
    'families',
    'users',
    'auth_accounts',
    'accounts',
    'balance_entries',
    'buckets',
    'bucket_allocations',
    'otp_challenges',
    'local_otp_outbox',
    'transactions',
}


class PostgresCompatCursor:
    def __init__(self, cursor, prefetched_rows=None, lastrowid=None):
        self._cursor = cursor
        self._prefetched_rows = list(prefetched_rows or [])
        self.lastrowid = lastrowid

    def fetchone(self):
        if self._prefetched_rows:
            return self._prefetched_rows.pop(0)
        return self._cursor.fetchone()

    def fetchall(self):
        rows = list(self._prefetched_rows)
        self._prefetched_rows.clear()
        rows.extend(self._cursor.fetchall())
        return rows

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class PostgresCompatConnection:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, query, params=None):
        sql, capture_lastrowid = _rewrite_query_for_postgres(query)
        args = None if params is None else tuple(params)
        cursor = self._conn.execute(sql) if args is None else self._conn.execute(sql, args)

        prefetched_rows = []
        lastrowid = None
        if capture_lastrowid:
            row = cursor.fetchone()
            if row is not None:
                prefetched_rows.append(row)
                if isinstance(row, dict):
                    lastrowid = row.get('id')
                else:
                    lastrowid = row[0]

        return PostgresCompatCursor(cursor, prefetched_rows=prefetched_rows, lastrowid=lastrowid)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __getattr__(self, name):
        return getattr(self._conn, name)


def _ensure_parent_dir(path):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _postgres_now_text_sql():
    return """to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS')"""


def _rewrite_query_for_postgres(query):
    sql = query
    capture_lastrowid = False

    match = re.match(r'\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\b', sql, re.IGNORECASE)
    if match and 'RETURNING' not in sql.upper():
        table = match.group(1).lower()
        if table in _POSTGRES_RETURNING_ID_TABLES:
            sql = sql.rstrip() + ' RETURNING id'
            capture_lastrowid = True

    sql = sql.replace('?', '%s')
    sql = sql.replace("datetime('now')", _postgres_now_text_sql())
    return sql, capture_lastrowid


def _connect_postgres():
    if psycopg is None or pg_dict_row is None:
        raise RuntimeError('PostgreSQL support requires psycopg. Install dependencies from requirements.txt.')
    conn = psycopg.connect(DATABASE_URL, row_factory=pg_dict_row)
    return PostgresCompatConnection(conn)


def _execute_sql_script(conn, script):
    statements = [statement.strip() for statement in script.split(';') if statement.strip()]
    for statement in statements:
        conn.execute(statement)


def _load_secret_key():
    env_secret = (os.environ.get('SOF_SECRET_KEY') or '').strip()
    if env_secret:
        return env_secret

    _ensure_parent_dir(SECRET_KEY_PATH)
    if os.path.exists(SECRET_KEY_PATH):
        with open(SECRET_KEY_PATH, 'r', encoding='utf-8') as f:
            key = f.read().strip()
        if key:
            return key

    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, 'w', encoding='utf-8') as f:
        f.write(key)
    return key


app = Flask(__name__)
app.secret_key = _load_secret_key()
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.permanent_session_lifetime = timedelta(days=180)
application = app

# Yahoo Finance suffix + native currency per exchange
EXCHANGE_MAP = {
    'NSE': {'suffix': '.NS', 'currency': 'INR'},
    'BSE': {'suffix': '.BO', 'currency': 'INR'},
    'DFM': {'suffix': '.DU', 'currency': 'AED'},
    'ADX': {'suffix': '.AD', 'currency': 'AED'},
    'NASDAQ Dubai': {'suffix': '.DI', 'currency': 'USD'},
}
ALLOWED_CURRENCIES = {'AED', 'INR', 'USD'}

# Reusable full-account SELECT (includes loan + share details)
_ACCOUNT_SELECT = """
    SELECT a.*,
           u.name AS user_name,
           ld.interest_rate, ld.remaining_tenure, ld.monthly_emi, ld.remaining_principal,
           sd.stock_name, sd.exchange, sd.stock_code, sd.quantity,
           sd.purchase_price, sd.purchase_price_currency,
           sd.last_price, sd.last_price_currency, sd.last_fetched,
           (SELECT be.amount FROM balance_entries be WHERE be.account_id = a.id ORDER BY be.id DESC LIMIT 1) AS latest_balance
    FROM accounts a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN loan_details ld ON ld.account_id = a.id
    LEFT JOIN share_details sd ON sd.account_id = a.id
"""


def _utc_now():
    return datetime.utcnow().replace(microsecond=0)


def _dt_str(value):
    return value.replace(microsecond=0).isoformat()


def _dt_or_none(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.replace(microsecond=0)
    text = str(value).strip().replace(' ', 'T')
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _period_label(value, interval):
    dt = _dt_or_none(value)
    if not dt:
        return None
    if interval == 'day':
        return dt.strftime('%Y-%m-%d')
    if interval == 'week':
        return dt.strftime('%Y-W%W')
    return dt.strftime('%Y-%m')


def _share_native_currency(exchange, fallback='USD'):
    return EXCHANGE_MAP.get((exchange or '').strip(), {}).get('currency', fallback)


def _share_exchange_currency_case_sql(column='exchange'):
    clauses = [
        f"WHEN '{exchange}' THEN '{meta['currency']}'"
        for exchange, meta in EXCHANGE_MAP.items()
    ]
    return f"CASE {column} {' '.join(clauses)} ELSE 'USD' END"


def _normalize_currency(value, field_name='currency', required=False, default='USD'):
    currency = str(value or '').upper().strip()
    if not currency:
        if required:
            raise ValueError(f'{field_name} is required')
        return default
    if currency not in ALLOWED_CURRENCIES:
        raise ValueError(f'{field_name} must be one of {", ".join(sorted(ALLOWED_CURRENCIES))}')
    return currency


def _coerce_non_negative_number(value, field_name, required=False, default=0.0):
    if value in (None, ''):
        if required:
            raise ValueError(f'{field_name} is required')
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'{field_name} must be a number')
    if number < 0:
        raise ValueError(f'{field_name} cannot be negative')
    return number


def _coerce_share_payload(data, existing=None, partial=False):
    existing = dict(existing or {})
    payload = {
        'stock_name': str(
            data.get('stock_name', existing.get('stock_name') if partial else '') or ''
        ).strip(),
        'exchange': str(
            data.get('exchange', existing.get('exchange') if partial else '') or ''
        ).strip(),
        'stock_code': str(
            data.get('stock_code', existing.get('stock_code') if partial else '') or ''
        ).upper().strip(),
        'quantity': _coerce_non_negative_number(
            data.get('quantity', existing.get('quantity') if partial else 0),
            'quantity',
            default=0.0,
        ),
        'purchase_price': _coerce_non_negative_number(
            data.get('purchase_price', existing.get('purchase_price') if partial else None),
            'purchase_price',
            required=True,
        ),
        'purchase_price_currency': _normalize_currency(
            data.get(
                'purchase_price_currency',
                existing.get('purchase_price_currency') if partial else None,
            ),
            field_name='purchase_price_currency',
            required=True,
        ),
    }
    payload['purchase_price_currency'] = _share_native_currency(
        payload['exchange'],
        fallback=payload['purchase_price_currency'],
    )
    return payload


def _currency_to_usd(amount, currency, rates=None):
    if amount is None:
        return None
    current_rates = rates or _fetch_usd_rates()
    normalized = _normalize_currency(currency, default='USD')
    rate = current_rates.get(normalized, 1.0) or 1.0
    return float(amount) / rate


def _convert_currency_amount(amount, from_currency, to_currency, rates=None):
    if amount is None:
        return None
    normalized_to = _normalize_currency(to_currency, default='USD')
    usd_value = _currency_to_usd(amount, from_currency, rates=rates)
    if normalized_to == 'USD':
        return usd_value
    current_rates = rates or _fetch_usd_rates()
    return usd_value * (current_rates.get(normalized_to, 1.0) or 1.0)


def _account_currency(account_row, fallback='USD'):
    return _normalize_currency(
        account_row['currency'] if account_row and 'currency' in account_row.keys() else fallback,
        default=fallback,
    )


def _serialize_balance_row(row, rates=None):
    data = dict(row)
    account_currency = _normalize_currency(data.get('account_currency') or data.get('currency'), default='USD')
    native_amount = data.get('amount')
    data['amount_native'] = native_amount
    data['amount_currency'] = account_currency
    if native_amount is not None:
        data['amount_usd'] = _currency_to_usd(native_amount, account_currency, rates=rates)
    else:
        data['amount_usd'] = None
    return data


def _serialize_balance_rows(rows):
    rows = list(rows)
    needs_rates = any(row['amount'] is not None for row in rows)
    rates = _fetch_usd_rates() if needs_rates else None
    return [_serialize_balance_row(row, rates=rates) for row in rows]


def _serialize_transaction_row(row, rates=None):
    data = dict(row)
    if data.get('source_amount') is not None and data.get('source_currency'):
        data['source_amount_usd'] = _currency_to_usd(data['source_amount'], data['source_currency'], rates=rates)
    else:
        data['source_amount_usd'] = None
    if data.get('destination_amount') is not None and data.get('destination_currency'):
        data['destination_amount_usd'] = _currency_to_usd(
            data['destination_amount'],
            data['destination_currency'],
            rates=rates,
        )
    else:
        data['destination_amount_usd'] = None
    return data


def _serialize_transaction_rows(rows):
    rows = list(rows)
    needs_rates = any(
        (row['source_amount'] is not None and row['source_currency'])
        or (row['destination_amount'] is not None and row['destination_currency'])
        for row in rows
    )
    rates = _fetch_usd_rates() if needs_rates else None
    return [_serialize_transaction_row(row, rates=rates) for row in rows]


def _convert_account_currency_storage(db, account_id, old_currency, new_currency, account_type=None, rates=None,
                                      skip_loan_details=False):
    normalized_old = _normalize_currency(old_currency, default='USD')
    normalized_new = _normalize_currency(new_currency, default='USD')
    if normalized_old == normalized_new:
        return

    current_rates = rates or _fetch_usd_rates()

    balance_rows = db.execute(
        "SELECT id, amount FROM balance_entries WHERE account_id=?",
        (account_id,)
    ).fetchall()
    for row in balance_rows:
        converted = _convert_currency_amount(row['amount'], normalized_old, normalized_new, rates=current_rates)
        db.execute("UPDATE balance_entries SET amount=? WHERE id=?", (converted, row['id']))

    if account_type == 'loan' and not skip_loan_details:
        loan = db.execute("""
            SELECT monthly_emi, remaining_principal
            FROM loan_details
            WHERE account_id=?
        """, (account_id,)).fetchone()
        if loan:
            db.execute("""
                UPDATE loan_details
                SET monthly_emi=?, remaining_principal=?
                WHERE account_id=?
            """, (
                _convert_currency_amount(loan['monthly_emi'], normalized_old, normalized_new, rates=current_rates),
                _convert_currency_amount(loan['remaining_principal'], normalized_old, normalized_new, rates=current_rates),
                account_id,
            ))


def _revalue_share_from_cached_price(db, account_id, recorded_at=None):
    share = db.execute("""
        SELECT quantity, last_price, last_price_currency
        FROM share_details
        WHERE account_id=?
    """, (account_id,)).fetchone()
    account = db.execute("SELECT currency FROM accounts WHERE id=?", (account_id,)).fetchone()
    if not share or share['last_price'] is None or not account:
        return None

    native_currency = _account_currency(account)
    valuation = _convert_currency_amount(
        float(share['last_price']) * float(share['quantity'] or 0),
        _normalize_currency(share['last_price_currency'], default=native_currency),
        native_currency,
    )
    note = (
        f'Cached price valuation @ {_normalize_currency(share["last_price_currency"], default=native_currency)} '
        f'{float(share["last_price"]):,.4f} × {float(share["quantity"] or 0):g}'
    )
    if recorded_at:
        db.execute(
            "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
            (account_id, valuation, note, recorded_at)
        )
    else:
        db.execute(
            "INSERT INTO balance_entries (account_id, amount, note) VALUES (?,?,?)",
            (account_id, valuation, note)
        )
    return {
        'price': float(share['last_price']),
        'currency': native_currency,
        'value_native': valuation,
        'value_usd': _currency_to_usd(valuation, native_currency),
        'source': 'cached',
    }


def _serialize_account_row(row, rates=None):
    data = dict(row)
    data['cost_basis_total'] = None
    data['cost_basis_total_usd'] = None
    data['unrealized_gain_loss'] = None
    data['unrealized_gain_loss_usd'] = None
    data['unrealized_gain_loss_pct'] = None
    data['is_profitable'] = None
    account_currency = _normalize_currency(data.get('currency'), default='USD')
    data['currency'] = account_currency

    if data.get('latest_balance') is not None:
        data['latest_balance_native'] = data['latest_balance']
        data['latest_balance_currency'] = account_currency
        data['latest_balance_usd'] = _currency_to_usd(data['latest_balance'], account_currency, rates=rates)
    else:
        data['latest_balance_native'] = None
        data['latest_balance_currency'] = account_currency
        data['latest_balance_usd'] = None

    for field in ('monthly_emi', 'remaining_principal'):
        native_value = data.get(field)
        native_key = f'{field}_native'
        currency_key = f'{field}_currency'
        usd_key = f'{field}_usd'
        data[native_key] = native_value
        data[currency_key] = account_currency
        if native_value is not None:
            data[usd_key] = _currency_to_usd(native_value, account_currency, rates=rates)
        else:
            data[usd_key] = None

    if data.get('type') != 'shares':
        return data

    purchase_price = data.get('purchase_price')
    quantity = float(data.get('quantity') or 0)
    purchase_currency = _normalize_currency(
        data.get('purchase_price_currency'),
        default=_share_native_currency(data.get('exchange')),
    )
    data['purchase_price_currency'] = purchase_currency

    if purchase_price is None:
        return data

    cost_basis_total = _convert_currency_amount(
        float(purchase_price) * quantity,
        purchase_currency,
        account_currency,
        rates=rates,
    )
    data['cost_basis_total'] = cost_basis_total
    data['cost_basis_total_usd'] = _currency_to_usd(cost_basis_total, account_currency, rates=rates)

    current_value = data.get('latest_balance')
    if current_value is None and data.get('last_price') is not None:
        market_currency = _normalize_currency(
            data.get('last_price_currency'),
            default=_share_native_currency(data.get('exchange')),
        )
        current_value = _convert_currency_amount(
            float(data['last_price']) * quantity,
            market_currency,
            account_currency,
            rates=rates,
        )

    if current_value is None:
        return data

    gain = float(current_value) - cost_basis_total
    data['unrealized_gain_loss'] = gain
    data['unrealized_gain_loss_usd'] = _currency_to_usd(gain, account_currency, rates=rates)
    if cost_basis_total:
        data['unrealized_gain_loss_pct'] = (gain / cost_basis_total) * 100
    data['is_profitable'] = gain > 0
    return data


def _serialize_account_rows(rows):
    rows = list(rows)
    needs_rates = any(
        row['latest_balance'] is not None
        or row['monthly_emi'] is not None
        or row['remaining_principal'] is not None
        or (
            row['type'] == 'shares' and (
                row['purchase_price'] is not None or row['last_price'] is not None
            )
        )
        for row in rows
    )
    rates = _fetch_usd_rates() if needs_rates else None
    return [_serialize_account_row(row, rates=rates) for row in rows]


def _normalize_email(value):
    return (value or '').strip().lower()


def _hash_otp(code):
    return hashlib.sha256(code.encode('utf-8')).hexdigest()


def _hash_password(password):
    return generate_password_hash(password, method=PASSWORD_HASH_METHOD)


def _json_error(message, status=400, **extra):
    payload = {'ok': False, 'error': message}
    payload.update(extra)
    return jsonify(payload), status


def get_db():
    if 'db' not in g:
        if DB_BACKEND == 'postgres':
            g.db = _connect_postgres()
        else:
            _ensure_parent_dir(DB_PATH)
            g.db = sqlite3.connect(DB_PATH)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys = ON")
            g.db.execute("PRAGMA journal_mode = WAL")
            g.db.execute("PRAGMA cache_size = -16000")   # 16 MB page cache
            g.db.execute("PRAGMA temp_store = MEMORY")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop('db', None)
    if db:
        db.close()


def init_db():
    schema_name = 'schema_postgres.sql' if DB_BACKEND == 'postgres' else 'schema.sql'
    schema = os.path.join(APP_DIR, schema_name)
    with open(schema, 'r', encoding='utf-8') as f:
        script = f.read()

    if DB_BACKEND == 'postgres':
        conn = _connect_postgres()
        try:
            _execute_sql_script(conn, script)
            conn.commit()
        finally:
            conn.close()
        return

    _ensure_parent_dir(DB_PATH)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(script)


def migrate_db():
    """Idempotent migrations for existing databases."""
    if DB_BACKEND == 'postgres':
        conn = _connect_postgres()
        try:
            conn.execute("""
                ALTER TABLE share_details
                ADD COLUMN IF NOT EXISTS purchase_price DOUBLE PRECISION NOT NULL DEFAULT 0
            """)
            conn.execute("""
                ALTER TABLE share_details
                ADD COLUMN IF NOT EXISTS purchase_price_currency TEXT NOT NULL DEFAULT 'USD'
            """)
            conn.execute(f"""
                UPDATE share_details
                SET purchase_price = COALESCE(last_price, 0)
                WHERE purchase_price IS NULL
                   OR (purchase_price = 0 AND last_price IS NOT NULL)
            """)
            conn.execute(f"""
                UPDATE share_details
                SET purchase_price_currency = COALESCE(
                    NULLIF(BTRIM(purchase_price_currency), ''),
                    NULLIF(BTRIM(last_price_currency), ''),
                    {_share_exchange_currency_case_sql('exchange')}
                )
                WHERE purchase_price_currency IS NULL
                   OR BTRIM(purchase_price_currency) = ''
            """)
            conn.execute("""
                ALTER TABLE transactions
                ADD COLUMN IF NOT EXISTS source_amount DOUBLE PRECISION
            """)
            conn.execute("""
                ALTER TABLE transactions
                ADD COLUMN IF NOT EXISTS source_currency TEXT
            """)
            conn.execute("""
                ALTER TABLE transactions
                ADD COLUMN IF NOT EXISTS destination_amount DOUBLE PRECISION
            """)
            conn.execute("""
                ALTER TABLE transactions
                ADD COLUMN IF NOT EXISTS destination_currency TEXT
            """)
            conn.execute("""
                ALTER TABLE transactions
                ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION
            """)
            conn.commit()
        finally:
            conn.close()
        return

    _ensure_parent_dir(DB_PATH)
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS families (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)

        user_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()
        }
        if 'family_id' not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN family_id INTEGER REFERENCES families(id)")

        def ensure_legacy_owner():
            existing = conn.execute(
                "SELECT id FROM users ORDER BY id LIMIT 1"
            ).fetchone()
            if existing:
                return existing['id']

            cur = conn.execute(
                "INSERT INTO users (name, created_at) VALUES (?, ?)",
                ('Primary', _dt_str(_utc_now()))
            )
            return cur.lastrowid

        # Migration 1: add 'loan' to the old accounts CHECK constraint.
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'"
        ).fetchone()
        if row and row[0] and "'loan'" not in row[0]:
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.executescript("""
                CREATE TABLE accounts_v2 (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT NOT NULL,
                    type        TEXT NOT NULL
                                CHECK(type IN ('bank','investment','credit','other','loan')),
                    institution TEXT,
                    currency    TEXT NOT NULL DEFAULT 'USD',
                    is_active   INTEGER NOT NULL DEFAULT 1,
                    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO accounts_v2 SELECT * FROM accounts;
                DROP TABLE accounts;
                ALTER TABLE accounts_v2 RENAME TO accounts;
            """)
            conn.execute("PRAGMA foreign_keys = ON")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS loan_details (
                account_id          INTEGER PRIMARY KEY
                                    REFERENCES accounts(id) ON DELETE CASCADE,
                interest_rate       REAL NOT NULL DEFAULT 0,
                remaining_tenure    INTEGER NOT NULL DEFAULT 0,
                monthly_emi         REAL NOT NULL DEFAULT 0,
                remaining_principal REAL NOT NULL DEFAULT 0
            )
        """)

        # Migration 2: normalize asset taxonomy.
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'"
        ).fetchone()
        if row and row[0] and 'investment_group' not in row[0]:
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.executescript("""
                CREATE TABLE accounts_v3 (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT NOT NULL,
                    type        TEXT NOT NULL
                                CHECK(type IN ('bank','loan','shares','investment_group')),
                    institution TEXT,
                    currency    TEXT NOT NULL DEFAULT 'USD',
                    is_active   INTEGER NOT NULL DEFAULT 1,
                    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO accounts_v3
                    SELECT id, name,
                        CASE type
                            WHEN 'investment' THEN 'investment_group'
                            WHEN 'credit'     THEN 'bank'
                            WHEN 'other'      THEN 'bank'
                            ELSE type
                        END,
                        institution, currency, is_active, created_at
                    FROM accounts;
                DROP TABLE accounts;
                ALTER TABLE accounts_v3 RENAME TO accounts;
            """)
            conn.execute("PRAGMA foreign_keys = ON")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS share_details (
                account_id          INTEGER PRIMARY KEY
                                    REFERENCES accounts(id) ON DELETE CASCADE,
                stock_name          TEXT,
                exchange            TEXT,
                stock_code          TEXT,
                quantity            REAL NOT NULL DEFAULT 0,
                purchase_price      REAL NOT NULL DEFAULT 0,
                purchase_price_currency TEXT NOT NULL DEFAULT 'USD',
                last_price          REAL,
                last_price_currency TEXT,
                last_fetched        TEXT
            )
        """)
        share_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(share_details)").fetchall()
        }
        if 'purchase_price' not in share_cols:
            conn.execute(
                "ALTER TABLE share_details ADD COLUMN purchase_price REAL NOT NULL DEFAULT 0"
            )
        if 'purchase_price_currency' not in share_cols:
            conn.execute(
                "ALTER TABLE share_details ADD COLUMN purchase_price_currency TEXT NOT NULL DEFAULT 'USD'"
            )
        conn.execute(f"""
            UPDATE share_details
            SET purchase_price = COALESCE(last_price, 0)
            WHERE purchase_price IS NULL
               OR (purchase_price = 0 AND last_price IS NOT NULL)
        """)
        conn.execute(f"""
            UPDATE share_details
            SET purchase_price_currency = COALESCE(
                NULLIF(TRIM(purchase_price_currency), ''),
                NULLIF(TRIM(last_price_currency), ''),
                {_share_exchange_currency_case_sql('exchange')}
            )
            WHERE purchase_price_currency IS NULL
               OR TRIM(purchase_price_currency) = ''
        """)

        # Migration 3: add accounts.user_id and assign legacy data to a primary owner.
        account_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()
        }
        legacy_owner_id = None
        if 'user_id' not in account_cols:
            legacy_owner_id = ensure_legacy_owner()
            conn.execute("ALTER TABLE accounts ADD COLUMN user_id INTEGER")
        elif conn.execute(
            "SELECT COUNT(*) AS c FROM accounts WHERE user_id IS NULL"
        ).fetchone()['c']:
            legacy_owner_id = ensure_legacy_owner()
        if legacy_owner_id is not None:
            conn.execute(
                "UPDATE accounts SET user_id=? WHERE user_id IS NULL",
                (legacy_owner_id,)
            )

        # Migration 4: rebuild buckets for user ownership + allocation type.
        bucket_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(buckets)").fetchall()
        }
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='buckets'"
        ).fetchone()
        bucket_sql = row[0] if row else ''
        needs_bucket_rebuild = (
            'user_id' not in bucket_cols
            or 'allocation_type' not in bucket_cols
            or 'UNIQUE(user_id, name)' not in bucket_sql
        )
        if needs_bucket_rebuild:
            if legacy_owner_id is None and (
                'user_id' not in bucket_cols
                or conn.execute(
                    "SELECT COUNT(*) AS c FROM buckets WHERE user_id IS NULL"
                ).fetchone()['c']
            ):
                legacy_owner_id = ensure_legacy_owner()
            user_expr = 'COALESCE(user_id, ?)' if 'user_id' in bucket_cols else '?'
            allocation_expr = (
                "COALESCE(allocation_type, 'manual')"
                if 'allocation_type' in bucket_cols else "'manual'"
            )
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.executescript("""
                CREATE TABLE buckets_v2 (
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
            """)
            conn.execute(
                f"""
                INSERT INTO buckets_v2
                    (id, user_id, name, target, color, allocation_type, sort_order, created_at)
                SELECT id, {user_expr}, name, target, color, {allocation_expr}, sort_order, created_at
                FROM buckets
                """,
                (legacy_owner_id,)
            )
            conn.executescript("""
                DROP TABLE buckets;
                ALTER TABLE buckets_v2 RENAME TO buckets;
            """)
            conn.execute("PRAGMA foreign_keys = ON")
        else:
            conn.execute(
                "UPDATE buckets SET allocation_type='manual' WHERE allocation_type IS NULL OR allocation_type=''"
            )
            if legacy_owner_id is None and conn.execute(
                "SELECT COUNT(*) AS c FROM buckets WHERE user_id IS NULL"
            ).fetchone()['c']:
                legacy_owner_id = ensure_legacy_owner()
            if legacy_owner_id is not None:
                conn.execute(
                    "UPDATE buckets SET user_id=? WHERE user_id IS NULL",
                    (legacy_owner_id,)
                )

        orphan_users = conn.execute(
            "SELECT id, name FROM users WHERE family_id IS NULL ORDER BY id"
        ).fetchall()
        total_users = conn.execute(
            "SELECT COUNT(*) AS c FROM users"
        ).fetchone()['c']

        # Preserve the old shared-household shape for legacy two-user databases.
        if len(orphan_users) == 2 and total_users == 2:
            cur = conn.execute(
                "INSERT INTO families (name, created_at) VALUES (?, ?)",
                ('Legacy Shared Household', _dt_str(_utc_now()))
            )
            legacy_family_id = cur.lastrowid
            for row in orphan_users:
                conn.execute(
                    "UPDATE users SET family_id=? WHERE id=? AND family_id IS NULL",
                    (legacy_family_id, row['id'])
                )
            orphan_users = conn.execute(
                "SELECT id, name FROM users WHERE family_id IS NULL ORDER BY id"
            ).fetchall()

        for row in orphan_users:
            cur = conn.execute(
                "INSERT INTO families (name, created_at) VALUES (?, ?)",
                (f"{row['name']} Household", _dt_str(_utc_now()))
            )
            conn.execute(
                "UPDATE users SET family_id=? WHERE id=?",
                (cur.lastrowid, row['id'])
            )

        conn.execute("""
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
            )
        """)

        conn.execute("""
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
            )
        """)
        otp_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(otp_challenges)").fetchall()
        }
        if 'payload' not in otp_cols:
            conn.execute("ALTER TABLE otp_challenges ADD COLUMN payload TEXT")
        if 'resend_allowed_at' not in otp_cols:
            conn.execute("ALTER TABLE otp_challenges ADD COLUMN resend_allowed_at TEXT")
            now = _dt_str(_utc_now())
            conn.execute(
                "UPDATE otp_challenges SET resend_allowed_at = COALESCE(resend_allowed_at, expires_at, ?)",
                (now,)
            )

        conn.execute("""
            CREATE TABLE IF NOT EXISTS local_otp_outbox (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                challenge_id      INTEGER REFERENCES otp_challenges(id) ON DELETE CASCADE,
                email             TEXT NOT NULL,
                purpose           TEXT NOT NULL,
                code_plain        TEXT NOT NULL,
                expires_at        TEXT NOT NULL,
                resend_allowed_at TEXT NOT NULL,
                created_at        TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        outbox_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(local_otp_outbox)").fetchall()
        }
        if 'challenge_id' not in outbox_cols:
            conn.execute("ALTER TABLE local_otp_outbox ADD COLUMN challenge_id INTEGER")
        if 'purpose' not in outbox_cols:
            conn.execute("ALTER TABLE local_otp_outbox ADD COLUMN purpose TEXT")
            conn.execute(
                "UPDATE local_otp_outbox SET purpose = COALESCE(purpose, 'signup')"
            )
        if 'resend_allowed_at' not in outbox_cols:
            conn.execute("ALTER TABLE local_otp_outbox ADD COLUMN resend_allowed_at TEXT")
            conn.execute(
                "UPDATE local_otp_outbox SET resend_allowed_at = COALESCE(resend_allowed_at, expires_at)"
            )

        # Migration 5: transactions table and transaction_id on balance_entries
        conn.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id         INTEGER NOT NULL REFERENCES users(id),
                txn_type        TEXT    NOT NULL CHECK(txn_type IN ('credit','debit','intra')),
                amount          REAL    NOT NULL CHECK(amount > 0),
                source_amount   REAL,
                source_currency TEXT,
                destination_amount REAL,
                destination_currency TEXT,
                fx_rate         REAL,
                from_account_id INTEGER REFERENCES accounts(id),
                to_account_id   INTEGER REFERENCES accounts(id),
                counterparty    TEXT,
                note            TEXT,
                recorded_at     TEXT    NOT NULL DEFAULT (datetime('now')),
                created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        txn_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(transactions)").fetchall()
        }
        if 'source_amount' not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN source_amount REAL")
        if 'source_currency' not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN source_currency TEXT")
        if 'destination_amount' not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN destination_amount REAL")
        if 'destination_currency' not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN destination_currency TEXT")
        if 'fx_rate' not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN fx_rate REAL")
        be_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(balance_entries)").fetchall()
        }
        if 'transaction_id' not in be_cols:
            conn.execute(
                "ALTER TABLE balance_entries ADD COLUMN transaction_id INTEGER "
                "REFERENCES transactions(id) ON DELETE SET NULL"
            )

        # Migration 6: default_currency preference on users
        user_cols = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        if 'default_currency' not in user_cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN default_currency TEXT NOT NULL DEFAULT 'AED'"
            )

        # Migration 7: performance indexes
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_be_account_id
            ON balance_entries (account_id, id DESC)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_be_account_recorded_at
            ON balance_entries (account_id, recorded_at DESC)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_user_active
            ON accounts (user_id, is_active)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_bucket_alloc_entry
            ON bucket_allocations (balance_entry_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_bucket_alloc_bucket
            ON bucket_allocations (bucket_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_users_family
            ON users (family_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_transactions_user
            ON transactions (user_id, recorded_at DESC)
        """)

        conn.commit()


def _parse_scope(value):
    scope = (value or 'me').strip().lower()
    if scope not in READ_SCOPES:
        raise ValueError('scope must be me or all')
    return scope


def _request_scope():
    return _parse_scope(request.args.get('scope', 'me'))


def _current_auth_account():
    if hasattr(g, 'current_auth_account'):
        return g.current_auth_account

    auth_account_id = session.get('auth_account_id')
    if not auth_account_id:
        g.current_auth_account = None
        return None

    row = get_db().execute("""
        SELECT aa.id AS auth_account_id,
               aa.email,
               aa.is_active,
               u.id AS user_id,
               u.name AS user_name,
               u.family_id,
               f.name AS family_name
        FROM auth_accounts aa
        JOIN users u ON u.id = aa.user_id
        LEFT JOIN families f ON f.id = u.family_id
        WHERE aa.id = ?
    """, (auth_account_id,)).fetchone()

    if not row or not row['is_active']:
        session.clear()
        g.current_auth_account = None
        return None

    g.current_auth_account = dict(row)
    return g.current_auth_account


def current_finance_user_id():
    auth = _current_auth_account()
    if not auth:
        raise PermissionError('Authentication required')
    return int(auth['user_id'])


def current_family_id():
    auth = _current_auth_account()
    if not auth:
        raise PermissionError('Authentication required')
    return int(auth['family_id'])


def _scope_filters(scope):
    if scope == 'all':
        return None, current_family_id()
    return current_finance_user_id(), None


def _append_owner_filter(where, params, alias='a', user_id=None, family_id=None):
    if user_id is not None:
        where.append(f"{alias}.user_id = ?")
        params.append(user_id)
    elif family_id is not None:
        where.append(f"{alias}.user_id IN (SELECT id FROM users WHERE family_id = ?)")
        params.append(family_id)


def _ensure_user_exists(db, user_id):
    row = db.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        raise ValueError('User not found')
    return user_id


def _ensure_family_exists(db, family_id):
    row = db.execute("SELECT id FROM families WHERE id=?", (family_id,)).fetchone()
    if not row:
        raise ValueError('Family not found')
    return family_id


def _owned_account(db, account_id, include_inactive=False):
    query = "SELECT id, user_id, name, type, institution, currency, is_active FROM accounts WHERE id=? AND user_id=?"
    params = [account_id, current_finance_user_id()]
    if not include_inactive:
        query += " AND is_active=1"
    return db.execute(query, params).fetchone()


def _owned_bucket(db, bucket_id):
    return db.execute(
        "SELECT id, user_id, name, allocation_type FROM buckets WHERE id=? AND user_id=?",
        (bucket_id, current_finance_user_id())
    ).fetchone()


def _owned_balance_entry(db, balance_entry_id):
    return db.execute("""
        SELECT be.id, be.account_id
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        WHERE be.id = ? AND a.user_id = ?
    """, (balance_entry_id, current_finance_user_id())).fetchone()


def _merge_bucket_rows(rows):
    merged = {}
    for row in rows:
        data = dict(row)
        key = data['name'].strip().lower()
        current = merged.get(key)
        if not current:
            merged[key] = {
                'id': data.get('id'),
                'name': data['name'],
                'target': float(data.get('target') or 0),
                'allocated': float(data.get('allocated') or 0),
                'color': data.get('color') or '#6366f1',
                'allocation_type': data.get('allocation_type') or 'manual',
                'sort_order': data.get('sort_order') or 0,
                'user_count': 1,
            }
            continue

        current['target'] += float(data.get('target') or 0)
        current['allocated'] += float(data.get('allocated') or 0)
        current['user_count'] += 1
        current['sort_order'] = min(current['sort_order'], data.get('sort_order') or 0)
        if current['allocation_type'] != (data.get('allocation_type') or 'manual'):
            current['allocation_type'] = 'mixed'

    return sorted(merged.values(), key=lambda item: (item['sort_order'], item['name'].lower()))


def _session_payload(db, auth=None):
    auth = auth or _current_auth_account()
    if not auth:
        return {'ok': True, 'logged_in': False}

    family_count = db.execute(
        "SELECT COUNT(*) AS c FROM users WHERE family_id=?",
        (auth['family_id'],)
    ).fetchone()['c']
    user_row = db.execute(
        "SELECT default_currency FROM users WHERE id=?", (auth['user_id'],)
    ).fetchone()
    default_currency = (user_row['default_currency'] if user_row else None) or 'AED'
    return {
        'ok': True,
        'logged_in': True,
        'user': {
            'id': auth['user_id'],
            'name': auth['user_name'],
            'email': auth['email'],
            'family_id': auth['family_id'],
            'family_name': auth['family_name'],
            'family_member_count': family_count,
            'default_currency': default_currency,
        },
        'available_scopes': ['me', 'all'],
    }


def _sign_in_auth_account(auth_account_id):
    session.clear()
    session['auth_account_id'] = int(auth_account_id)
    session.permanent = True


def _generate_otp_code():
    return f"{secrets.randbelow(1_000_000):06d}"


def _challenge_delivery_payload(row):
    if not row:
        return None
    return {
        'challenge_id': row['challenge_id'],
        'email': row['email'],
        'purpose': row['purpose'],
        'code': row['code_plain'],
        'expires_at': row['expires_at'],
        'resend_allowed_at': row['resend_allowed_at'],
        'created_at': row['created_at'],
    }


def _latest_outbox_entry(db, email, purpose):
    return db.execute("""
        SELECT challenge_id, email, purpose, code_plain, expires_at, resend_allowed_at, created_at
        FROM local_otp_outbox
        WHERE email = ? AND purpose = ?
        ORDER BY id DESC
        LIMIT 1
    """, (email, purpose)).fetchone()


def _issue_otp_challenge(db, email, purpose, payload=None):
    if purpose not in OTP_PURPOSES:
        raise ValueError('Invalid OTP purpose')

    email = _normalize_email(email)
    now = _utc_now()

    active = db.execute("""
        SELECT *
        FROM otp_challenges
        WHERE email = ? AND purpose = ? AND consumed_at IS NULL
        ORDER BY id DESC
        LIMIT 1
    """, (email, purpose)).fetchone()

    if active:
        resend_allowed_at = _dt_or_none(active['resend_allowed_at'])
        expires_at = _dt_or_none(active['expires_at'])
        if expires_at and expires_at > now and resend_allowed_at and resend_allowed_at > now:
            delivery = _challenge_delivery_payload(_latest_outbox_entry(db, email, purpose))
            raise RuntimeError({
                'message': 'Please wait before requesting another OTP.',
                'status': 429,
                'resend_allowed_at': active['resend_allowed_at'],
                'delivery': delivery,
            })

    now_str = _dt_str(now)
    db.execute("""
        UPDATE otp_challenges
        SET consumed_at = COALESCE(consumed_at, ?)
        WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    """, (now_str, email, purpose))

    code = _generate_otp_code()
    expires_at = _dt_str(now + timedelta(minutes=OTP_TTL_MINUTES))
    resend_allowed_at = _dt_str(now + timedelta(seconds=OTP_RESEND_SECONDS))
    payload_json = _json.dumps(payload or {})
    cur = db.execute("""
        INSERT INTO otp_challenges (
            email, purpose, code_hash, payload, expires_at, resend_allowed_at, created_at
        ) VALUES (?,?,?,?,?,?,?)
    """, (
        email,
        purpose,
        _hash_otp(code),
        payload_json,
        expires_at,
        resend_allowed_at,
        now_str,
    ))
    challenge_id = cur.lastrowid
    db.execute("""
        INSERT INTO local_otp_outbox (
            challenge_id, email, purpose, code_plain, expires_at, resend_allowed_at, created_at
        ) VALUES (?,?,?,?,?,?,?)
    """, (
        challenge_id,
        email,
        purpose,
        code,
        expires_at,
        resend_allowed_at,
        now_str,
    ))

    delivery = _challenge_delivery_payload(_latest_outbox_entry(db, email, purpose))
    return {
        'challenge_id': challenge_id,
        'email': email,
        'purpose': purpose,
        'delivery': delivery,
    }


def _verify_otp_challenge(db, email, purpose, code):
    email = _normalize_email(email)
    challenge = db.execute("""
        SELECT *
        FROM otp_challenges
        WHERE email = ? AND purpose = ? AND consumed_at IS NULL
        ORDER BY id DESC
        LIMIT 1
    """, (email, purpose)).fetchone()
    if not challenge:
        raise ValueError('No active OTP challenge found. Request a new code.')

    now = _utc_now()
    expires_at = _dt_or_none(challenge['expires_at'])
    if not expires_at or expires_at <= now:
        db.execute(
            "UPDATE otp_challenges SET consumed_at=? WHERE id=?",
            (_dt_str(now), challenge['id'])
        )
        raise ValueError('OTP has expired. Request a new code.')

    if _hash_otp((code or '').strip()) != challenge['code_hash']:
        attempts = int(challenge['attempt_count'] or 0) + 1
        consumed_at = _dt_str(now) if attempts >= OTP_MAX_ATTEMPTS else None
        db.execute("""
            UPDATE otp_challenges
            SET attempt_count = ?, consumed_at = COALESCE(?, consumed_at)
            WHERE id = ?
        """, (attempts, consumed_at, challenge['id']))
        if attempts >= OTP_MAX_ATTEMPTS:
            raise ValueError('OTP invalidated after 3 failed attempts. Request a new code.')
        remaining = OTP_MAX_ATTEMPTS - attempts
        raise ValueError(f'Invalid OTP. {remaining} attempt(s) remaining.')

    db.execute(
        "UPDATE otp_challenges SET consumed_at=? WHERE id=?",
        (_dt_str(now), challenge['id'])
    )
    payload = {}
    if challenge['payload']:
        try:
            payload = _json.loads(challenge['payload'])
        except Exception:
            payload = {}
    return {
        'id': challenge['id'],
        'email': challenge['email'],
        'purpose': challenge['purpose'],
        'payload': payload,
    }


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            current_finance_user_id()
        except PermissionError as e:
            return _json_error(str(e), 401)
        return fn(*args, **kwargs)
    return wrapper


def _make_family_name(base_name):
    clean = (base_name or 'My').strip()
    return f'{clean} Household'


# Stock-price helpers

# Rate cache: (rates_dict, fetched_date_str)  — refreshed once per calendar day
_rates_cache: tuple = (None, None)

def _fetch_usd_rates():
    global _rates_cache
    cached_rates, cached_date = _rates_cache
    today = datetime.utcnow().strftime('%Y-%m-%d')
    if cached_rates and cached_date == today:
        return cached_rates
    try:
        url = 'https://open.er-api.com/v6/latest/USD'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = _json.loads(resp.read())
        rates = {'AED': data['rates']['AED'], 'INR': data['rates']['INR'], 'USD': 1.0}
        _rates_cache = (rates, today)
        return rates
    except Exception:
        fallback = {'AED': 3.6725, 'INR': 83.5, 'USD': 1.0}
        # Cache fallback too so we don't hammer the API on repeated failures
        _rates_cache = (fallback, today)
        return fallback


def _fetch_stock_price(exchange, stock_code):
    if exchange == 'DFM':
        return _fetch_dfm_stock_price(stock_code)
    if exchange == 'ADX':
        return _fetch_adx_stock_price(stock_code)
    return _fetch_yahoo_stock_price(exchange, stock_code)


def _fetch_yahoo_stock_price(exchange, stock_code):
    info = EXCHANGE_MAP.get(exchange, {})
    suffix = info.get('suffix', '')
    ticker = stock_code.upper().strip() + suffix
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = _json.loads(resp.read())
    result = data['chart']['result']
    if not result:
        raise ValueError(f'No data for ticker {ticker}')
    meta = result[0]['meta']
    price = meta['regularMarketPrice']
    currency = meta.get('currency', info.get('currency', 'USD'))
    return price, currency, ticker


def _exchange_feed_payload():
    return [{
        'id': 'codex-quote',
        'command': 'stocks',
        'data': [{'id': 'id', 'value': ''}],
    }]


def _fetch_exchange_site_rows(home_url, api_url):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    common_headers = {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }

    bootstrap_req = urllib.request.Request(home_url, headers=common_headers)
    with opener.open(bootstrap_req, timeout=10) as resp:
        bootstrap_body = resp.read().decode('utf-8', errors='ignore')
    if 'blocked' in bootstrap_body.lower() and 'cloudflare' in bootstrap_body.lower():
        raise ValueError('Exchange site blocked the quote request')

    payload = _json.dumps(_exchange_feed_payload()).encode('utf-8')
    feed_req = urllib.request.Request(
        api_url,
        data=payload,
        headers={
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Referer': home_url,
        },
    )
    with opener.open(feed_req, timeout=12) as resp:
        data = _json.loads(resp.read())

    if not isinstance(data, list) or not data:
        raise ValueError('Unexpected exchange quote response')

    rows = data[0].get('data')
    if not isinstance(rows, list):
        raise ValueError('Exchange quote payload did not include securities data')
    return rows


def _extract_exchange_price(rows, stock_code, exchange, currency):
    code = stock_code.upper().strip()
    for row in rows:
        row_code = str(row.get('id', '')).upper().strip()
        if row_code != code:
            continue

        candidates = (
            row.get('lastradeprice'),
            row.get('lastTradePrice'),
            row.get('closingprice'),
            row.get('close'),
            row.get('referenceprice'),
            row.get('referencePrice'),
        )
        for value in candidates:
            if value is None:
                continue
            try:
                price = float(value)
            except (TypeError, ValueError):
                continue
            if price > 0:
                return price, currency, code
        raise ValueError(f'No positive market price found for {code} on {exchange}')

    raise ValueError(f'No data for ticker {code} on {exchange}')


def _fetch_dfm_stock_price(stock_code):
    rows = _fetch_exchange_site_rows(
        'https://marketwatch.dfm.ae/',
        'https://marketwatch.dfm.ae/api/fetch',
    )
    return _extract_exchange_price(rows, stock_code, 'DFM', 'AED')


def _fetch_adx_stock_price(stock_code):
    try:
        rows = _fetch_exchange_site_rows(
            'https://www.adx.ae/en/all-equities',
            'https://www.adx.ae/api/fetch',
        )
        return _extract_exchange_price(rows, stock_code, 'ADX', 'AED')
    except Exception:
        return _fetch_adx_stockanalysis_price(stock_code)


def _fetch_adx_stockanalysis_price(stock_code):
    code = stock_code.upper().strip()
    url = f'https://stockanalysis.com/quote/adx/{code}/'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })
    with urllib.request.urlopen(req, timeout=12) as resp:
        html = resp.read().decode('utf-8', errors='ignore')

    quote_match = re.search(r'quote:\{(.*?)\},archived:', html, re.DOTALL)
    if not quote_match:
        raise ValueError(f'No fallback quote block found for {code}')

    quote_blob = quote_match.group(1)
    price_match = re.search(r'\bp:([+-]?(?:\d+(?:\.\d+)?|\.\d+))\b', quote_blob)
    if not price_match:
        raise ValueError(f'No fallback price found for {code}')

    currency_match = re.search(r'curr:\{main:"([A-Z]+)"', html)
    currency = currency_match.group(1) if currency_match else 'AED'
    return float(price_match.group(1)), currency, code


def _auto_price_and_entry(db, account_id):
    sd = db.execute(
        "SELECT exchange, stock_code, quantity FROM share_details WHERE account_id=?",
        (account_id,)
    ).fetchone()
    if not sd or not sd['stock_code'] or not sd['exchange']:
        raise ValueError('Stock code and exchange are required')

    price, currency, ticker = _fetch_stock_price(sd['exchange'], sd['stock_code'])
    qty = sd['quantity'] or 0
    account = db.execute("SELECT currency FROM accounts WHERE id=?", (account_id,)).fetchone()
    native_currency = _account_currency(account or {'currency': currency}, fallback=currency)
    value_native = _convert_currency_amount(price * qty, currency, native_currency)
    value_usd = _currency_to_usd(value_native, native_currency)

    db.execute("""
        UPDATE share_details
        SET last_price=?, last_price_currency=?, last_fetched=?
        WHERE account_id=?
    """, (price, currency, _dt_str(_utc_now()), account_id))

    db.execute(
        "INSERT INTO balance_entries (account_id, amount, note) VALUES (?,?,?)",
        (account_id, value_native, f'Auto: {ticker} @ {currency} {price:,.4f} × {qty}')
    )
    return {
        'price': price,
        'currency': currency,
        'account_currency': native_currency,
        'value_native': value_native,
        'value_usd': value_usd,
        'ticker': ticker,
    }


def _normalize_bucket_allocation_type(value):
    allocation_type = (value or 'manual').strip().lower()
    if allocation_type not in BUCKET_ALLOCATION_TYPES:
        raise ValueError('allocation_type must be auto or manual')
    return allocation_type


def _latest_bank_entries(db, user_id=None, family_id=None):
    where = [
        "a.is_active = 1",
        "a.type = 'bank'",
        """be.id = (
              SELECT id FROM balance_entries b2
              WHERE b2.account_id = be.account_id
              ORDER BY recorded_at DESC LIMIT 1
          )""",
    ]
    params = []
    _append_owner_filter(where, params, alias='a', user_id=user_id, family_id=family_id)

    rows = db.execute(f"""
        SELECT be.id AS balance_entry_id,
               be.account_id,
               a.name AS account_name,
               a.currency AS account_currency,
               be.amount,
               COALESCE(SUM(ba.amount), 0) AS total_allocated,
               COALESCE(SUM(CASE WHEN b.allocation_type = 'manual' THEN ba.amount ELSE 0 END), 0) AS manual_allocated
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        LEFT JOIN bucket_allocations ba ON ba.balance_entry_id = be.id
        LEFT JOIN buckets b ON b.id = ba.bucket_id
        WHERE {" AND ".join(where)}
        GROUP BY be.id, be.account_id, a.name, a.currency, be.amount
    """, params).fetchall()
    rates = _fetch_usd_rates()
    result = []
    for row in rows:
        item = dict(row)
        item['amount_usd'] = _currency_to_usd(item['amount'], item['account_currency'], rates=rates)
        result.append(item)
    return sorted(result, key=lambda item: (-item['amount_usd'], item['account_name'].lower()))


def _has_auto_buckets(db, user_id):
    row = db.execute(
        "SELECT 1 FROM buckets WHERE allocation_type='auto' AND user_id=? LIMIT 1",
        (user_id,)
    ).fetchone()
    return bool(row)


def _latest_manual_allocations_for_account(db, account_id):
    rows = db.execute("""
        SELECT ba.bucket_id, ba.amount
        FROM bucket_allocations ba
        JOIN buckets b ON b.id = ba.bucket_id
        WHERE ba.balance_entry_id = (
            SELECT id
            FROM balance_entries
            WHERE account_id = ?
            ORDER BY id DESC LIMIT 1
        )
          AND b.allocation_type = 'manual'
    """, (account_id,)).fetchall()
    return {
        int(row['bucket_id']): float(row['amount'] or 0)
        for row in rows
        if float(row['amount'] or 0) > 0
    }


def _cash_position_summary(db, user_id=None, family_id=None, rates=None):
    rates = rates or _fetch_usd_rates()
    latest_banks = _latest_bank_entries(db, user_id=user_id, family_id=family_id)
    bank_cash_total = sum(
        _currency_to_usd(row['amount'], row['account_currency'], rates=rates)
        for row in latest_banks
    )
    allocated_total = sum(float(row['total_allocated'] or 0) for row in latest_banks)

    params = []
    where = [
        "a.is_active = 1",
        "a.type = 'loan'",
        """be.id = (
              SELECT id FROM balance_entries b2
              WHERE b2.account_id = be.account_id
              ORDER BY id DESC LIMIT 1
          )""",
    ]
    _append_owner_filter(where, params, alias='a', user_id=user_id, family_id=family_id)
    loan_rows = db.execute(f"""
        SELECT be.amount, a.currency
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        WHERE {" AND ".join(where)}
    """, params).fetchall()
    loan_total = sum(
        abs(_currency_to_usd(row['amount'], row['currency'], rates=rates))
        for row in loan_rows
    )
    return {
        'bank_cash_total': bank_cash_total,
        'loan_total': loan_total,
        'allocated_total': allocated_total,
        'unallocated_cash': max(0.0, bank_cash_total - loan_total - allocated_total),
    }


def _latest_bucket_allocated_total(db, bucket_id):
    row = db.execute("""
        SELECT COALESCE(SUM(ba.amount), 0) AS allocated
        FROM bucket_allocations ba
        JOIN balance_entries be ON be.id = ba.balance_entry_id
        JOIN accounts a ON a.id = be.account_id
        WHERE ba.bucket_id = ?
          AND a.is_active = 1
          AND be.id = (
              SELECT id FROM balance_entries b2
              WHERE b2.account_id = be.account_id
              ORDER BY recorded_at DESC LIMIT 1
          )
    """, (bucket_id,)).fetchone()
    return float(row['allocated'] or 0)


def _allocate_manual_bucket(db, bucket_id, amount):
    if amount <= 0:
        raise ValueError('Allocation amount must be greater than zero')

    bucket = _owned_bucket(db, bucket_id)
    if not bucket:
        raise ValueError('Bucket not found')
    if bucket['allocation_type'] != 'manual':
        raise ValueError('Only manual-allocate buckets can be allocated from this dialog')

    bucket_user_id = bucket['user_id']
    funds = _cash_position_summary(db, user_id=bucket_user_id)
    if amount - funds['unallocated_cash'] > 1e-9:
        raise ValueError('Allocation amount cannot exceed the current unallocated fund')

    latest_entries = [dict(row) for row in _latest_bank_entries(db, user_id=bucket_user_id)]
    if not latest_entries:
        raise ValueError('Add a balance entry to at least one bank account before allocating')

    remaining = amount
    accounts_used = 0
    for entry in latest_entries:
        if remaining <= 1e-9:
            break

        available = max(0.0, float(entry['amount_usd'] or 0) - float(entry['total_allocated'] or 0))
        if available <= 1e-9:
            continue

        allocated = min(available, remaining)
        db.execute("""
            INSERT INTO bucket_allocations (balance_entry_id, bucket_id, amount)
            VALUES (?,?,?)
            ON CONFLICT(balance_entry_id, bucket_id) DO UPDATE SET
                amount = bucket_allocations.amount + excluded.amount
        """, (entry['balance_entry_id'], bucket_id, allocated))
        entry['total_allocated'] = float(entry['total_allocated'] or 0) + allocated
        remaining -= allocated
        accounts_used += 1

    if remaining > 1e-6:
        raise ValueError('Not enough unallocated bank funds are available for this allocation')

    updated_funds = _cash_position_summary(db, user_id=bucket_user_id)
    return {
        'bucket_id': bucket['id'],
        'bucket_name': bucket['name'],
        'allocated_amount': amount,
        'bucket_total_allocated': _latest_bucket_allocated_total(db, bucket_id),
        'accounts_used': accounts_used,
        'unallocated_cash': updated_funds['unallocated_cash'],
    }


def _auto_allocate_buckets(db, user_id):
    auto_buckets = db.execute("""
        SELECT id, name, target
        FROM buckets
        WHERE allocation_type = 'auto' AND user_id = ?
        ORDER BY sort_order, name
    """, (user_id,)).fetchall()
    if not auto_buckets:
        raise ValueError('No auto-allocate buckets found')

    allocatable_buckets = []
    skipped_buckets = []
    for bucket in auto_buckets:
        target = float(bucket['target'] or 0)
        if target <= 0:
            skipped_buckets.append(bucket['name'])
            continue
        allocatable_buckets.append({
            'id': bucket['id'],
            'name': bucket['name'],
            'target': target,
        })
    if not allocatable_buckets:
        raise ValueError('Auto-allocate buckets need a target amount before they can be allocated')

    latest_entries = [dict(row) for row in _latest_bank_entries(db, user_id=user_id)]
    if not latest_entries:
        raise ValueError('Add a balance entry to at least one bank account before allocating')

    auto_bucket_ids = [bucket['id'] for bucket in allocatable_buckets]
    latest_entry_ids = [entry['balance_entry_id'] for entry in latest_entries]
    if auto_bucket_ids and latest_entry_ids:
        db.execute(
            f"""
            DELETE FROM bucket_allocations
            WHERE balance_entry_id IN ({','.join('?' for _ in latest_entry_ids)})
              AND bucket_id IN ({','.join('?' for _ in auto_bucket_ids)})
            """,
            (*latest_entry_ids, *auto_bucket_ids)
        )

    manual_total = sum(float(entry['manual_allocated'] or 0) for entry in latest_entries)
    bank_cash_total = sum(float(entry['amount_usd'] or 0) for entry in latest_entries)
    total_available = max(0.0, bank_cash_total - manual_total)

    entries = []
    for entry in latest_entries:
        available = max(0.0, float(entry['amount_usd'] or 0) - float(entry['manual_allocated'] or 0))
        entries.append({
            'balance_entry_id': entry['balance_entry_id'],
            'account_id': entry['account_id'],
            'account_name': entry['account_name'],
            'available': available,
        })

    remaining_pool = total_available
    planned_allocations = []
    bucket_results = []

    for bucket in allocatable_buckets:
        bucket_needed = min(bucket['target'], remaining_pool)
        bucket_allocated = 0.0

        for entry in entries:
            if bucket_needed <= 1e-9:
                break
            if entry['available'] <= 1e-9:
                continue

            amount = min(entry['available'], bucket_needed)
            if amount <= 1e-9:
                continue

            planned_allocations.append((entry['balance_entry_id'], bucket['id'], amount))
            entry['available'] -= amount
            bucket_needed -= amount
            bucket_allocated += amount

        remaining_pool = max(0.0, remaining_pool - bucket_allocated)
        bucket_results.append({
            'id': bucket['id'],
            'name': bucket['name'],
            'target': bucket['target'],
            'allocated': bucket_allocated,
            'fulfilled': bucket_allocated + 1e-9 >= bucket['target'],
        })

    for balance_entry_id, bucket_id, amount in planned_allocations:
        db.execute(
            "INSERT INTO bucket_allocations (balance_entry_id, bucket_id, amount) VALUES (?,?,?)",
            (balance_entry_id, bucket_id, amount)
        )

    total_required = sum(bucket['target'] for bucket in allocatable_buckets)
    total_allocated = sum(result['allocated'] for result in bucket_results)
    shortage = max(0.0, total_required - total_allocated)

    return {
        'auto_bucket_count': len(allocatable_buckets),
        'accounts_used': sum(
            1 for entry in latest_entries
            if float(entry['amount_usd'] or 0) > 0
        ),
        'bank_cash_total': bank_cash_total,
        'manual_allocated_total': manual_total,
        'auto_allocated_total': total_allocated,
        'remaining_cash_total': max(0.0, bank_cash_total - manual_total - total_allocated),
        'shortage': shortage,
        'skipped_buckets': skipped_buckets,
        'buckets': bucket_results,
    }


def _get_latest_balance(db, account_id):
    """Return the most recent balance amount for an account, or 0 if none."""
    row = db.execute(
        "SELECT amount FROM balance_entries WHERE account_id=? ORDER BY id DESC LIMIT 1",
        (account_id,)
    ).fetchone()
    return float(row['amount']) if row else 0.0


def _create_txn_balance_entry(db, account_id, amount, txn_id, note, recorded_at=None):
    """Insert a balance entry linked to a transaction, carrying forward manual bucket allocations.

    IMPORTANT: previous allocations are fetched BEFORE the INSERT so that
    _latest_manual_allocations_for_account does not accidentally pick up the
    newly-created (empty) entry instead of the old one.
    """
    acc_row = db.execute("SELECT type, currency FROM accounts WHERE id=?", (account_id,)).fetchone()

    # Capture previous manual allocations before the new entry exists in the DB
    prev_allocs = {}
    if acc_row and acc_row['type'] == 'bank' and amount >= 0:
        prev_allocs = _latest_manual_allocations_for_account(db, account_id)
        total_alloc = sum(prev_allocs.values())
        current_amount_usd = _currency_to_usd(amount, acc_row['currency'])
        if total_alloc > current_amount_usd + 1e-9:
            # Scale proportionally so allocations never exceed the new balance
            factor = current_amount_usd / total_alloc if total_alloc > 0 else 0
            prev_allocs = {k: v * factor for k, v in prev_allocs.items()}

    if recorded_at:
        cur = db.execute(
            "INSERT INTO balance_entries (account_id, amount, note, transaction_id, recorded_at) "
            "VALUES (?,?,?,?,?)",
            (account_id, amount, note, txn_id, recorded_at)
        )
    else:
        cur = db.execute(
            "INSERT INTO balance_entries (account_id, amount, note, transaction_id) VALUES (?,?,?,?)",
            (account_id, amount, note, txn_id)
        )
    entry_id = cur.lastrowid

    for bucket_id, alloc_amount in prev_allocs.items():
        if alloc_amount > 1e-9:
            db.execute(
                "INSERT INTO bucket_allocations (balance_entry_id, bucket_id, amount) VALUES (?,?,?)",
                (entry_id, bucket_id, alloc_amount)
            )
    return entry_id


def _execute_transaction(db, user_id, txn_type, amount,
                         from_account_id=None, to_account_id=None,
                         counterparty=None, note=None, recorded_at=None,
                         fx_rate=None):
    """Execute a financial transaction and create corresponding balance entries.

    credit: external money in → to_account balance increases in destination native currency
    debit:  money out → from_account balance decreases in source native currency
    intra:  transfer → from_account decreases in source native currency,
            to_account increases in destination native currency via fx_rate
    """
    if txn_type not in ('credit', 'debit', 'intra'):
        raise ValueError('Transaction type must be credit, debit, or intra')
    if amount <= 0:
        raise ValueError('Transaction amount must be greater than zero')

    now = _dt_str(_utc_now())
    amount = float(amount)
    txn_amount_usd = None
    source_amount = None
    source_currency = None
    destination_amount = None
    destination_currency = None
    normalized_fx_rate = None

    if txn_type == 'credit':
        if not to_account_id:
            raise ValueError('Credit transaction requires a destination account')
        acc = db.execute(
            "SELECT id, type, currency FROM accounts WHERE id=? AND user_id=? AND is_active=1",
            (to_account_id, user_id)
        ).fetchone()
        if not acc:
            raise ValueError('Destination account not found')
        old_balance = _get_latest_balance(db, to_account_id)
        new_balance = old_balance + amount
        destination_amount = amount
        destination_currency = _account_currency(acc)
        txn_amount_usd = _currency_to_usd(destination_amount, destination_currency)

    elif txn_type == 'debit':
        if not from_account_id:
            raise ValueError('Debit transaction requires a source account')
        acc = db.execute(
            "SELECT id, type, currency FROM accounts WHERE id=? AND user_id=? AND is_active=1",
            (from_account_id, user_id)
        ).fetchone()
        if not acc:
            raise ValueError('Source account not found')
        old_balance = _get_latest_balance(db, from_account_id)
        if amount - old_balance > 1e-9:
            raise ValueError(
                f'Insufficient balance. Current balance is '
                f'{old_balance:.2f} {acc["currency"]}; tried to debit {amount:.2f} {acc["currency"]}.'
            )
        new_balance = old_balance - amount
        source_amount = amount
        source_currency = _account_currency(acc)
        txn_amount_usd = _currency_to_usd(source_amount, source_currency)

    else:  # intra
        if not from_account_id:
            raise ValueError('Intra transaction requires a source account')
        if not to_account_id:
            raise ValueError('Intra transaction requires a destination account')
        if from_account_id == to_account_id:
            raise ValueError('Source and destination accounts must be different')
        from_acc = db.execute(
            "SELECT id, type, name, currency FROM accounts WHERE id=? AND user_id=? AND is_active=1",
            (from_account_id, user_id)
        ).fetchone()
        if not from_acc:
            raise ValueError('Source account not found')
        to_acc = db.execute(
            "SELECT id, type, name, currency FROM accounts WHERE id=? AND user_id=? AND is_active=1",
            (to_account_id, user_id)
        ).fetchone()
        if not to_acc:
            raise ValueError('Destination account not found')
        old_from = _get_latest_balance(db, from_account_id)
        if amount - old_from > 1e-9:
            raise ValueError(
                f'Insufficient balance. Current balance is '
                f'{old_from:.2f} {from_acc["currency"]}; tried to transfer {amount:.2f} {from_acc["currency"]}.'
            )
        old_to = _get_latest_balance(db, to_account_id)
        source_amount = amount
        source_currency = _account_currency(from_acc)
        destination_currency = _account_currency(to_acc)
        if source_currency == destination_currency:
            normalized_fx_rate = 1.0
            destination_amount = source_amount
        else:
            try:
                normalized_fx_rate = float(fx_rate or 0)
            except (TypeError, ValueError):
                raise ValueError('FX rate must be a number')
            if normalized_fx_rate <= 0:
                raise ValueError('FX rate must be greater than zero')
            destination_amount = source_amount * normalized_fx_rate
        txn_amount_usd = _currency_to_usd(source_amount, source_currency)

    cur = db.execute("""
        INSERT INTO transactions
            (user_id, txn_type, amount, source_amount, source_currency,
             destination_amount, destination_currency, fx_rate,
             from_account_id, to_account_id, counterparty, note, recorded_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        user_id, txn_type, txn_amount_usd,
        source_amount, source_currency,
        destination_amount, destination_currency, normalized_fx_rate,
        from_account_id, to_account_id,
        counterparty, note,
        recorded_at or now, now
    ))
    txn_id = cur.lastrowid

    if txn_type == 'credit':
        entry_note = f"Credit: {counterparty or 'External'}" + (f' — {note}' if note else '')
        _create_txn_balance_entry(db, to_account_id, new_balance, txn_id, entry_note, recorded_at)
        if acc['type'] == 'bank' and _has_auto_buckets(db, user_id):
            _auto_allocate_buckets(db, user_id)

    elif txn_type == 'debit':
        entry_note = f"Debit: {counterparty or 'External'}" + (f' — {note}' if note else '')
        _create_txn_balance_entry(db, from_account_id, new_balance, txn_id, entry_note, recorded_at)
        if acc['type'] == 'bank' and _has_auto_buckets(db, user_id):
            _auto_allocate_buckets(db, user_id)

    else:  # intra
        new_from = old_from - source_amount
        new_to = old_to + destination_amount
        from_note = f"Transfer out → {to_acc['name']}" + (f' — {note}' if note else '')
        to_note = f"Transfer in ← {from_acc['name']}" + (f' — {note}' if note else '')
        _create_txn_balance_entry(db, from_account_id, new_from, txn_id, from_note, recorded_at)
        _create_txn_balance_entry(db, to_account_id, new_to, txn_id, to_note, recorded_at)
        if (from_acc['type'] == 'bank' or to_acc['type'] == 'bank') and _has_auto_buckets(db, user_id):
            _auto_allocate_buckets(db, user_id)

    return txn_id


# Frontend shell

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/healthz')
def healthz():
    return jsonify({'ok': True})


# Auth API

@app.route('/api/auth/session', methods=['GET'])
def auth_session():
    return jsonify(_session_payload(get_db()))


@app.route('/api/auth/available-profiles', methods=['GET'])
def available_profiles():
    rows = get_db().execute("""
        SELECT u.id, u.name
        FROM users u
        LEFT JOIN auth_accounts aa ON aa.user_id = u.id
        WHERE aa.id IS NULL
        ORDER BY u.name, u.id
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/auth/local-otp-outbox', methods=['GET'])
def latest_local_otp_outbox():
    email = _normalize_email(request.args.get('email'))
    purpose = (request.args.get('purpose') or '').strip()
    if not email or purpose not in OTP_PURPOSES:
        return _json_error('email and purpose are required', 400)
    row = _latest_outbox_entry(get_db(), email, purpose)
    return jsonify({'ok': True, 'delivery': _challenge_delivery_payload(row)})


@app.route('/api/auth/signin', methods=['POST'])
def signin():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    email = _normalize_email(payload.get('email'))
    password = payload.get('password') or ''
    if not email or not password:
        return _json_error('Email and password are required', 400)

    row = db.execute("""
        SELECT aa.id AS auth_account_id,
               aa.password_hash,
               aa.is_active
        FROM auth_accounts aa
        WHERE aa.email = ?
    """, (email,)).fetchone()
    if not row or not row['is_active'] or not check_password_hash(row['password_hash'], password):
        return _json_error('Invalid email or password', 401)

    now = _dt_str(_utc_now())
    db.execute(
        "UPDATE auth_accounts SET last_login_at=?, updated_at=? WHERE id=?",
        (now, now, row['auth_account_id'])
    )
    db.commit()
    _sign_in_auth_account(row['auth_account_id'])
    return jsonify(_session_payload(db))


@app.route('/api/auth/signup/start', methods=['POST'])
def signup_start():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    name = (payload.get('name') or '').strip()
    email = _normalize_email(payload.get('email'))
    password = payload.get('password') or ''

    if not name:
        return _json_error('Name is required', 400)
    if not email:
        return _json_error('Email is required', 400)
    if len(password) < 8:
        return _json_error('Password must be at least 8 characters', 400)

    existing_auth = db.execute(
        "SELECT 1 FROM auth_accounts WHERE email=? LIMIT 1",
        (email,)
    ).fetchone()
    if existing_auth:
        return _json_error('That email is already registered', 400)

    existing_user = db.execute(
        "SELECT 1 FROM users WHERE name=? LIMIT 1",
        (name,)
    ).fetchone()
    if existing_user:
        return _json_error('That profile name already exists. Choose a different name or activate the existing profile.', 400)

    try:
        result = _issue_otp_challenge(db, email, 'signup', {
            'name': name,
            'password_hash': _hash_password(password),
        })
        db.commit()
        return jsonify({'ok': True, **result})
    except RuntimeError as e:
        db.rollback()
        data = e.args[0]
        return _json_error(
            data['message'],
            data.get('status', 429),
            resend_allowed_at=data.get('resend_allowed_at'),
            delivery=data.get('delivery'),
        )


@app.route('/api/auth/signup/verify', methods=['POST'])
def signup_verify():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    email = _normalize_email(payload.get('email'))
    code = (payload.get('code') or '').strip()
    if not email or not code:
        return _json_error('Email and OTP are required', 400)

    try:
        challenge = _verify_otp_challenge(db, email, 'signup', code)
    except ValueError as e:
        db.commit()
        return _json_error(str(e), 400)

    db.commit()

    try:
        data = challenge['payload']
        name = (data.get('name') or '').strip()
        password_hash = data.get('password_hash')
        if not name or not password_hash:
            raise ValueError('The signup challenge is incomplete. Request a new code.')

        if db.execute("SELECT 1 FROM auth_accounts WHERE email=? LIMIT 1", (email,)).fetchone():
            raise ValueError('That email is already registered')
        if db.execute("SELECT 1 FROM users WHERE name=? LIMIT 1", (name,)).fetchone():
            raise ValueError('That profile name already exists. Choose a different name or activate the existing profile.')

        now = _dt_str(_utc_now())
        family_cur = db.execute(
            "INSERT INTO families (name, created_at) VALUES (?, ?)",
            (_make_family_name(name), now)
        )
        family_id = family_cur.lastrowid
        user_cur = db.execute(
            "INSERT INTO users (name, family_id, created_at) VALUES (?,?,?)",
            (name, family_id, now)
        )
        user_id = user_cur.lastrowid
        auth_cur = db.execute("""
            INSERT INTO auth_accounts (
                user_id, email, password_hash, email_verified_at, last_login_at, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?)
        """, (user_id, email, password_hash, now, now, now, now))
        db.commit()
        _sign_in_auth_account(auth_cur.lastrowid)
        return jsonify(_session_payload(db))
    except ValueError as e:
        db.rollback()
        return _json_error(str(e), 400)


@app.route('/api/auth/activate-existing/start', methods=['POST'])
def activate_existing_start():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    try:
        user_id = int(payload.get('user_id'))
    except (TypeError, ValueError):
        return _json_error('Select an existing profile', 400)

    email = _normalize_email(payload.get('email'))
    password = payload.get('password') or ''
    if not email:
        return _json_error('Email is required', 400)
    if len(password) < 8:
        return _json_error('Password must be at least 8 characters', 400)

    user = db.execute("SELECT id, name FROM users WHERE id=?", (user_id,)).fetchone()
    if not user:
        return _json_error('Profile not found', 404)
    existing_auth = db.execute("SELECT 1 FROM auth_accounts WHERE user_id=? LIMIT 1", (user_id,)).fetchone()
    if existing_auth:
        return _json_error('That profile is already activated. Sign in instead.', 400)
    if db.execute("SELECT 1 FROM auth_accounts WHERE email=? LIMIT 1", (email,)).fetchone():
        return _json_error('That email is already registered', 400)

    try:
        result = _issue_otp_challenge(db, email, 'activate_existing', {
            'user_id': user_id,
            'password_hash': _hash_password(password),
        })
        db.commit()
        return jsonify({'ok': True, **result, 'profile_name': user['name']})
    except RuntimeError as e:
        db.rollback()
        data = e.args[0]
        return _json_error(
            data['message'],
            data.get('status', 429),
            resend_allowed_at=data.get('resend_allowed_at'),
            delivery=data.get('delivery'),
        )


@app.route('/api/auth/activate-existing/verify', methods=['POST'])
def activate_existing_verify():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    email = _normalize_email(payload.get('email'))
    code = (payload.get('code') or '').strip()
    if not email or not code:
        return _json_error('Email and OTP are required', 400)

    try:
        challenge = _verify_otp_challenge(db, email, 'activate_existing', code)
    except ValueError as e:
        db.commit()
        return _json_error(str(e), 400)

    db.commit()

    try:
        data = challenge['payload']
        user_id = int(data.get('user_id'))
        password_hash = data.get('password_hash')
        if not password_hash:
            raise ValueError('The activation challenge is incomplete. Request a new code.')

        user = db.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone()
        if not user:
            raise ValueError('Profile not found')
        if db.execute("SELECT 1 FROM auth_accounts WHERE user_id=? LIMIT 1", (user_id,)).fetchone():
            raise ValueError('That profile is already activated. Sign in instead.')
        if db.execute("SELECT 1 FROM auth_accounts WHERE email=? LIMIT 1", (email,)).fetchone():
            raise ValueError('That email is already registered')

        now = _dt_str(_utc_now())
        cur = db.execute("""
            INSERT INTO auth_accounts (
                user_id, email, password_hash, email_verified_at, last_login_at, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?)
        """, (user_id, email, password_hash, now, now, now, now))
        db.commit()
        _sign_in_auth_account(cur.lastrowid)
        return jsonify(_session_payload(db))
    except ValueError as e:
        db.rollback()
        return _json_error(str(e), 400)


@app.route('/api/auth/forgot-password/start', methods=['POST'])
def forgot_password_start():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    email = _normalize_email(payload.get('email'))
    if not email:
        return _json_error('Email is required', 400)
    existing_auth = db.execute("SELECT 1 FROM auth_accounts WHERE email=? LIMIT 1", (email,)).fetchone()
    if not existing_auth:
        return _json_error('No account was found for that email', 404)

    try:
        result = _issue_otp_challenge(db, email, 'reset_password', {})
        db.commit()
        return jsonify({'ok': True, **result})
    except RuntimeError as e:
        db.rollback()
        data = e.args[0]
        return _json_error(
            data['message'],
            data.get('status', 429),
            resend_allowed_at=data.get('resend_allowed_at'),
            delivery=data.get('delivery'),
        )


@app.route('/api/auth/forgot-password/verify', methods=['POST'])
def forgot_password_verify():
    db = get_db()
    payload = request.get_json(silent=True) or {}
    email = _normalize_email(payload.get('email'))
    code = (payload.get('code') or '').strip()
    new_password = payload.get('new_password') or ''
    if not email or not code:
        return _json_error('Email and OTP are required', 400)
    if len(new_password) < 8:
        return _json_error('Password must be at least 8 characters', 400)

    try:
        _verify_otp_challenge(db, email, 'reset_password', code)
    except ValueError as e:
        db.commit()
        return _json_error(str(e), 400)

    db.commit()

    try:
        auth = db.execute("""
            SELECT id AS auth_account_id
            FROM auth_accounts
            WHERE email = ? AND is_active = 1
        """, (email,)).fetchone()
        if not auth:
            raise ValueError('No account was found for that email')

        now = _dt_str(_utc_now())
        db.execute("""
            UPDATE auth_accounts
            SET password_hash=?, updated_at=?
            WHERE id=?
        """, (_hash_password(new_password), now, auth['auth_account_id']))
        db.commit()
        return jsonify({'ok': True, 'message': 'Password reset. You can sign in now.'})
    except ValueError as e:
        db.rollback()
        return _json_error(str(e), 400)


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True, 'logged_in': False})


@app.route('/api/user/preferences', methods=['PATCH'])
@login_required
def update_user_preferences():
    d = request.get_json(silent=True) or {}
    user_id = current_finance_user_id()
    db = get_db()
    if 'default_currency' in d:
        try:
            currency = _normalize_currency(d['default_currency'], field_name='default_currency', required=True)
        except ValueError as e:
            return _json_error(str(e), 400)
        db.execute(
            "UPDATE users SET default_currency=? WHERE id=?",
            (currency, user_id)
        )
        db.commit()
    return jsonify({'ok': True})


# Accounts / Assets

@app.route('/api/users', methods=['GET'])
@login_required
def list_users():
    rows = get_db().execute("""
        SELECT id, name, created_at
        FROM users
        WHERE family_id = ?
        ORDER BY id
    """, (current_family_id(),)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/accounts', methods=['GET'])
@login_required
def list_accounts():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    user_id, family_id = _scope_filters(scope)
    db = get_db()
    params = []
    where = ["a.is_active=1"]
    _append_owner_filter(where, params, alias='a', user_id=user_id, family_id=family_id)
    query = _ACCOUNT_SELECT + " WHERE " + " AND ".join(where) + " ORDER BY a.name, a.id"
    rows = db.execute(query, params).fetchall()
    return jsonify(_serialize_account_rows(rows))


@app.route('/api/accounts', methods=['POST'])
@login_required
def create_account():
    d = request.get_json(silent=True) or {}
    db = get_db()
    user_id = current_finance_user_id()
    share_payload = None
    account_currency = _normalize_currency(d.get('currency'), default='USD')
    if d.get('type') == 'shares':
        try:
            share_payload = _coerce_share_payload(d)
        except ValueError as e:
            return _json_error(str(e), 400)
        account_currency = _share_native_currency(share_payload['exchange'])
    cur = db.execute(
        "INSERT INTO accounts (user_id, name, type, institution, currency) VALUES (?,?,?,?,?)",
        (user_id, d['name'], d['type'], d.get('institution', ''), account_currency)
    )
    account_id = cur.lastrowid
    price_info = None

    if d['type'] == 'loan':
        ir = d.get('interest_rate', 0) or 0
        ten = d.get('remaining_tenure', 0) or 0
        emi = d.get('monthly_emi', 0) or 0
        prin = d.get('remaining_principal', 0) or 0
        db.execute("""
            INSERT INTO loan_details
                (account_id, interest_rate, remaining_tenure, monthly_emi, remaining_principal)
            VALUES (?,?,?,?,?)
        """, (account_id, ir, ten, emi, prin))
        if prin:
            db.execute(
                "INSERT INTO balance_entries (account_id, amount, note) VALUES (?,?,?)",
                (account_id, -abs(prin), 'Initial principal')
            )

    elif d['type'] == 'shares':
        db.execute("""
            INSERT INTO share_details (
                account_id, stock_name, exchange, stock_code, quantity,
                purchase_price, purchase_price_currency
            )
            VALUES (?,?,?,?,?,?,?)
        """, (
            account_id,
            share_payload['stock_name'],
            share_payload['exchange'],
            share_payload['stock_code'],
            share_payload['quantity'],
            share_payload['purchase_price'],
            share_payload['purchase_price_currency'],
        ))
        db.commit()
        try:
            price_info = _auto_price_and_entry(db, account_id)
        except Exception as e:
            price_info = {'error': str(e)}

    db.commit()
    row = db.execute(_ACCOUNT_SELECT + " WHERE a.id=?", (account_id,)).fetchone()
    result = _serialize_account_row(row, rates=_fetch_usd_rates())
    if price_info:
        result['_price_fetch'] = price_info
    return jsonify(result), 201


@app.route('/api/accounts/<int:aid>', methods=['PATCH'])
@login_required
def update_account(aid):
    d = request.get_json(silent=True) or {}
    db = get_db()
    account = _owned_account(db, aid)
    if not account:
        return _json_error('Account not found', 404)
    old_currency = _account_currency(account)

    fields = {k: v for k, v in d.items() if k in ('name', 'type', 'institution')}
    target_type = fields.get('type', account['type'])
    if fields:
        set_clause = ', '.join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE accounts SET {set_clause} WHERE id=?", (*fields.values(), aid))

    loan_keys = {'interest_rate', 'remaining_tenure', 'monthly_emi', 'remaining_principal'}
    loan_fields = {k: v for k, v in d.items() if k in loan_keys}
    if loan_fields:
        db.execute("""
            INSERT INTO loan_details (account_id, interest_rate, remaining_tenure,
                                      monthly_emi, remaining_principal)
            VALUES (:account_id, :ir, :ten, :emi, :prin)
            ON CONFLICT(account_id) DO UPDATE SET
                interest_rate       = excluded.interest_rate,
                remaining_tenure    = excluded.remaining_tenure,
                monthly_emi         = excluded.monthly_emi,
                remaining_principal = excluded.remaining_principal
        """, {
            'account_id': aid,
            'ir': loan_fields.get('interest_rate', 0) or 0,
            'ten': loan_fields.get('remaining_tenure', 0) or 0,
            'emi': loan_fields.get('monthly_emi', 0) or 0,
            'prin': loan_fields.get('remaining_principal', 0) or 0,
        })
        if 'remaining_principal' in loan_fields and loan_fields['remaining_principal']:
            db.execute(
                "INSERT INTO balance_entries (account_id, amount, note) VALUES (?,?,?)",
                (aid, -abs(loan_fields['remaining_principal']), 'Principal update')
            )

    share_keys = {'stock_name', 'exchange', 'stock_code', 'quantity', 'purchase_price', 'purchase_price_currency'}
    share_fields = {k: v for k, v in d.items() if k in share_keys}
    price_info = None
    if share_fields and target_type != 'shares':
        return _json_error('Share details can only be set on shares assets', 400)

    new_currency = old_currency
    if share_fields or (target_type == 'shares' and account['type'] != 'shares'):
        existing_share = db.execute("""
            SELECT stock_name, exchange, stock_code, quantity, purchase_price, purchase_price_currency
            FROM share_details
            WHERE account_id=?
        """, (aid,)).fetchone()
        try:
            share_payload = _coerce_share_payload(
                d,
                existing=dict(existing_share) if existing_share else None,
                partial=bool(existing_share),
            )
        except ValueError as e:
            return _json_error(str(e), 400)
        new_currency = _share_native_currency(share_payload['exchange'])
        db.execute("""
            INSERT INTO share_details (
                account_id, stock_name, exchange, stock_code, quantity,
                purchase_price, purchase_price_currency
            )
            VALUES (:account_id, :sn, :ex, :sc, :qty, :pp, :ppc)
            ON CONFLICT(account_id) DO UPDATE SET
                stock_name = excluded.stock_name,
                exchange   = excluded.exchange,
                stock_code = excluded.stock_code,
                quantity   = excluded.quantity,
                purchase_price = excluded.purchase_price,
                purchase_price_currency = excluded.purchase_price_currency
        """, {
            'account_id': aid,
            'sn': share_payload['stock_name'],
            'ex': share_payload['exchange'],
            'sc': share_payload['stock_code'],
            'qty': share_payload['quantity'],
            'pp': share_payload['purchase_price'],
            'ppc': share_payload['purchase_price_currency'],
        })
    elif 'currency' in d:
        try:
            new_currency = _normalize_currency(d.get('currency'), field_name='currency', required=True)
        except ValueError as e:
            return _json_error(str(e), 400)

    if target_type != 'shares' and 'currency' in d and not share_fields:
        fields['currency'] = new_currency
        db.execute("UPDATE accounts SET currency=? WHERE id=?", (new_currency, aid))

    if target_type == 'shares':
        db.execute("UPDATE accounts SET currency=? WHERE id=?", (new_currency, aid))

    if new_currency != old_currency:
        _convert_account_currency_storage(
            db,
            aid,
            old_currency,
            new_currency,
            account_type=target_type,
            skip_loan_details=bool(loan_fields),
        )

    should_remote_refresh = bool({'exchange', 'stock_code'} & share_fields.keys())
    should_cached_revalue = 'quantity' in share_fields and not should_remote_refresh
    if should_remote_refresh:
        db.commit()
        try:
            price_info = _auto_price_and_entry(db, aid)
        except Exception as e:
            price_info = {'error': str(e)}
    elif should_cached_revalue:
        cached = _revalue_share_from_cached_price(db, aid)
        if cached:
            price_info = cached

    db.commit()
    row = db.execute(_ACCOUNT_SELECT + " WHERE a.id=?", (aid,)).fetchone()
    result = _serialize_account_row(row, rates=_fetch_usd_rates())
    if price_info:
        result['_price_fetch'] = price_info
    return jsonify(result)


@app.route('/api/accounts/<int:aid>/refresh-price', methods=['POST'])
@login_required
def refresh_stock_price(aid):
    db = get_db()
    acc = _owned_account(db, aid)
    if not acc or acc['type'] != 'shares':
        return _json_error('Not a shares asset', 400)
    try:
        info = _auto_price_and_entry(db, aid)
        db.commit()
        row = db.execute(_ACCOUNT_SELECT + " WHERE a.id=?", (aid,)).fetchone()
        return jsonify({**info, 'ok': True, 'account': _serialize_account_row(row, rates=_fetch_usd_rates())})
    except Exception as e:
        return _json_error(str(e), 502)


@app.route('/api/accounts/<int:aid>/apply-emi', methods=['POST'])
@login_required
def apply_loan_emi(aid):
    db = get_db()
    account = _owned_account(db, aid)
    if not account or account['type'] != 'loan':
        return _json_error('Not a loan account', 400)

    ld = db.execute(
        "SELECT interest_rate, remaining_tenure, monthly_emi, remaining_principal FROM loan_details WHERE account_id=?",
        (aid,)
    ).fetchone()
    if not ld:
        return _json_error('Loan details not found', 400)

    principal  = float(ld['remaining_principal'] or 0)
    emi        = float(ld['monthly_emi'] or 0)
    tenure     = int(ld['remaining_tenure'] or 0)
    annual_rate = float(ld['interest_rate'] or 0)

    if tenure <= 0:
        return _json_error('Loan is already fully paid off', 400)
    if emi <= 0:
        return _json_error('Monthly EMI is not set', 400)

    monthly_rate      = annual_rate / 12 / 100
    interest_component = round(principal * monthly_rate, 2)
    principal_component = round(max(emi - interest_component, 0), 2)
    new_principal      = round(max(principal - principal_component, 0), 2)
    new_tenure         = tenure - 1

    db.execute(
        "UPDATE loan_details SET remaining_principal=?, remaining_tenure=? WHERE account_id=?",
        (new_principal, new_tenure, aid)
    )
    note = (
        f'EMI payment — principal {_fmt_amount(principal_component)}, '
        f'interest {_fmt_amount(interest_component)}'
        + (' (LOAN CLOSED)' if new_principal <= 0 else f', {new_tenure} months remaining')
    )
    db.execute(
        "INSERT INTO balance_entries (account_id, amount, note) VALUES (?,?,?)",
        (aid, -new_principal, note)
    )
    db.commit()

    row = db.execute(_ACCOUNT_SELECT + " WHERE a.id=?", (aid,)).fetchone()
    return jsonify({
        'ok': True,
        'emi': emi,
        'interest': interest_component,
        'principal_paid': principal_component,
        'new_principal': new_principal,
        'new_tenure': new_tenure,
        'account': _serialize_account_row(row, rates=_fetch_usd_rates()),
    })


def _fmt_amount(v):
    return f'{v:,.2f}'


@app.route('/api/accounts/<int:aid>', methods=['DELETE'])
@login_required
def delete_account(aid):
    db = get_db()
    account = _owned_account(db, aid)
    if not account:
        return _json_error('Account not found', 404)
    db.execute("UPDATE accounts SET is_active=0 WHERE id=?", (aid,))
    db.commit()
    return jsonify({'ok': True})


# Balance Entries

@app.route('/api/balances', methods=['GET'])
@login_required
def list_balances():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    account_id = request.args.get('account_id')
    user_id, family_id = _scope_filters(scope)
    query = """
        SELECT be.*, a.name AS account_name, a.type AS account_type, a.currency AS account_currency, u.name AS user_name
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        JOIN users u ON u.id = a.user_id
        WHERE a.is_active=1
    """
    params = []
    if account_id:
        query += " AND be.account_id=?"
        params.append(account_id)
    filters = []
    filter_params = []
    _append_owner_filter(filters, filter_params, alias='a', user_id=user_id, family_id=family_id)
    if filters:
        query += " AND " + " AND ".join(filters)
        params.extend(filter_params)
    query += " ORDER BY be.recorded_at DESC LIMIT 200"
    rows = get_db().execute(query, params).fetchall()
    return jsonify(_serialize_balance_rows(rows))


@app.route('/api/balances/latest', methods=['GET'])
@login_required
def latest_balances():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    user_id, family_id = _scope_filters(scope)
    params = []
    query = """
        SELECT be.*, a.name AS account_name, a.type AS account_type, a.currency AS account_currency, u.name AS user_name
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        JOIN users u ON u.id = a.user_id
        WHERE a.is_active=1
          AND be.id = (
              SELECT id FROM balance_entries b2
              WHERE b2.account_id = be.account_id
              ORDER BY recorded_at DESC LIMIT 1
          )
    """
    filters = []
    _append_owner_filter(filters, params, alias='a', user_id=user_id, family_id=family_id)
    if filters:
        query += " AND " + " AND ".join(filters)
    query += " ORDER BY a.name"
    rows = get_db().execute(query, params).fetchall()
    return jsonify(_serialize_balance_rows(rows))


@app.route('/api/balances', methods=['POST'])
@login_required
def create_balance():
    d = request.get_json(silent=True) or {}
    db = get_db()
    account = _owned_account(db, d.get('account_id'))
    if not account:
        return _json_error('Account not found', 404)

    allocations = d.get('allocations', [])
    requested_allocations = []
    for alloc in allocations:
        amount = float(alloc.get('amount', 0) or 0)
        if amount < 0:
            return _json_error('Bucket allocation amounts cannot be negative', 400)
        requested_allocations.append({
            'bucket_id': int(alloc['bucket_id']),
            'amount': amount,
        })

    if requested_allocations and account['type'] != 'bank':
        return _json_error('Bucket allocations are only supported for bank accounts', 400)

    if requested_allocations:
        bucket_ids = sorted({alloc['bucket_id'] for alloc in requested_allocations})
        bucket_rows = db.execute(
            f"""
            SELECT id, allocation_type
            FROM buckets
            WHERE user_id = ?
              AND id IN ({','.join('?' for _ in bucket_ids)})
            """,
            (current_finance_user_id(), *bucket_ids)
        ).fetchall()
        if len(bucket_rows) != len(bucket_ids):
            return _json_error('One or more buckets could not be found for this user', 400)
        non_manual = [row['id'] for row in bucket_rows if row['allocation_type'] != 'manual']
        if non_manual:
            return _json_error('Auto-allocate buckets cannot be assigned manually', 400)

    effective_manual_allocations = {}
    if account['type'] == 'bank':
        effective_manual_allocations = _latest_manual_allocations_for_account(db, account['id'])
        for alloc in requested_allocations:
            if alloc['amount'] > 0:
                effective_manual_allocations[alloc['bucket_id']] = alloc['amount']
            else:
                effective_manual_allocations.pop(alloc['bucket_id'], None)

        total_allocated = sum(effective_manual_allocations.values())
        amount_native = float(d['amount'])
        amount_usd = _currency_to_usd(amount_native, account['currency'])
        if amount_native >= 0 and total_allocated - amount_usd > 1e-9:
            return _json_error(
                'Manual bucket allocations from the latest snapshot exceed this bank balance. Update the manual bucket amounts for this entry.',
                400
            )

    positive_allocations = [
        {'bucket_id': bucket_id, 'amount': amount}
        for bucket_id, amount in effective_manual_allocations.items()
        if amount > 0
    ]

    recorded_at = d.get('recorded_at') or None
    if recorded_at:
        cur = db.execute(
            "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
            (d['account_id'], d['amount'], d.get('note', ''), recorded_at)
        )
    else:
        cur = db.execute(
            "INSERT INTO balance_entries (account_id, amount, note) VALUES (?,?,?)",
            (d['account_id'], d['amount'], d.get('note', ''))
        )
    entry_id = cur.lastrowid
    for alloc in positive_allocations:
        db.execute(
            "INSERT INTO bucket_allocations (balance_entry_id, bucket_id, amount) VALUES (?,?,?)",
            (entry_id, alloc['bucket_id'], alloc['amount'])
        )

    auto_allocation_result = None
    if account['type'] == 'bank' and _has_auto_buckets(db, current_finance_user_id()):
        auto_allocation_result = _auto_allocate_buckets(db, current_finance_user_id())

    db.commit()
    row = db.execute("""
        SELECT be.*, a.name AS account_name, a.currency AS account_currency
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        WHERE be.id=?
    """, (entry_id,)).fetchone()
    result = _serialize_balance_row(row, rates=_fetch_usd_rates())
    if auto_allocation_result:
        result['_auto_allocate'] = auto_allocation_result
    return jsonify(result), 201


@app.route('/api/balances/<int:bid>', methods=['DELETE'])
@login_required
def delete_balance(bid):
    db = get_db()
    entry = _owned_balance_entry(db, bid)
    if not entry:
        return _json_error('Balance entry not found', 404)
    db.execute("DELETE FROM balance_entries WHERE id=?", (bid,))
    db.commit()
    return jsonify({'ok': True})


# Buckets

@app.route('/api/buckets', methods=['GET'])
@login_required
def list_buckets():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    user_id, family_id = _scope_filters(scope)
    db = get_db()
    params = []
    query = """
        SELECT b.*, u.name AS user_name
        FROM buckets b
        JOIN users u ON u.id = b.user_id
    """
    filters = []
    _append_owner_filter(filters, params, alias='b', user_id=user_id, family_id=family_id)
    if filters:
        query += " WHERE " + " AND ".join(filters)
    query += " ORDER BY b.sort_order, b.name"
    rows = db.execute(query, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/buckets', methods=['POST'])
@login_required
def create_bucket():
    d = request.get_json(silent=True) or {}
    db = get_db()
    try:
        allocation_type = _normalize_bucket_allocation_type(d.get('allocation_type'))
    except ValueError as e:
        return _json_error(str(e), 400)

    cur = db.execute(
        "INSERT INTO buckets (user_id, name, target, color, allocation_type) VALUES (?,?,?,?,?)",
        (current_finance_user_id(), d['name'], d.get('target'), d.get('color', '#6366f1'), allocation_type)
    )
    db.commit()
    row = db.execute("""
        SELECT b.*, u.name AS user_name
        FROM buckets b
        JOIN users u ON u.id = b.user_id
        WHERE b.id=?
    """, (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route('/api/buckets/<int:bid>', methods=['PATCH'])
@login_required
def update_bucket(bid):
    d = request.get_json(silent=True) or {}
    db = get_db()
    bucket = _owned_bucket(db, bid)
    if not bucket:
        return _json_error('Bucket not found', 404)

    fields = {k: v for k, v in d.items() if k in ('name', 'target', 'color', 'sort_order')}
    if 'allocation_type' in d:
        try:
            fields['allocation_type'] = _normalize_bucket_allocation_type(d.get('allocation_type'))
        except ValueError as e:
            return _json_error(str(e), 400)
    if fields:
        set_clause = ', '.join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE buckets SET {set_clause} WHERE id=?", (*fields.values(), bid))
        db.commit()
    row = db.execute("""
        SELECT b.*, u.name AS user_name
        FROM buckets b
        JOIN users u ON u.id = b.user_id
        WHERE b.id=?
    """, (bid,)).fetchone()
    return jsonify(dict(row))


@app.route('/api/buckets/auto-allocate', methods=['POST'])
@login_required
def auto_allocate_buckets():
    db = get_db()
    try:
        result = _auto_allocate_buckets(db, current_finance_user_id())
        db.commit()
        return jsonify({'ok': True, **result})
    except ValueError as e:
        db.rollback()
        return _json_error(str(e), 400)


@app.route('/api/buckets/<int:bid>/allocate', methods=['POST'])
@login_required
def manual_allocate_bucket(bid):
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        amount = float(d.get('amount', 0) or 0)
    except (TypeError, ValueError):
        return _json_error('Allocation amount must be a number', 400)

    try:
        result = _allocate_manual_bucket(db, bid, amount)
        db.commit()
        return jsonify({'ok': True, **result})
    except ValueError as e:
        db.rollback()
        return _json_error(str(e), 400)


@app.route('/api/buckets/<int:bid>', methods=['DELETE'])
@login_required
def delete_bucket(bid):
    db = get_db()
    bucket = _owned_bucket(db, bid)
    if not bucket:
        return _json_error('Bucket not found', 404)
    db.execute("DELETE FROM buckets WHERE id=?", (bid,))
    db.commit()
    return jsonify({'ok': True})


# Summary

@app.route('/api/summary/net-worth', methods=['GET'])
@login_required
def net_worth():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    user_id, family_id = _scope_filters(scope)
    db = get_db()
    params = []
    where = [
        "a.is_active=1",
        """be.id = (
              SELECT id FROM balance_entries b2
              WHERE b2.account_id = be.account_id
              ORDER BY id DESC LIMIT 1
          )""",
    ]
    _append_owner_filter(where, params, alias='a', user_id=user_id, family_id=family_id)
    rows = db.execute(f"""
        SELECT be.amount, a.type, a.currency
        FROM balance_entries be
        JOIN accounts a ON a.id = be.account_id
        WHERE {" AND ".join(where)}
    """, params).fetchall()
    rates = _fetch_usd_rates()   # single call — cached daily
    total = 0.0
    by_type = {}
    for r in rows:
        usd_amount = _currency_to_usd(r['amount'], r['currency'], rates=rates)
        total += usd_amount
        by_type[r['type']] = by_type.get(r['type'], 0) + usd_amount

    funds = _cash_position_summary(db, user_id=user_id, family_id=family_id, rates=rates)
    return jsonify({'total': total, 'by_type': by_type, 'unallocated_cash': funds['unallocated_cash']})


@app.route('/api/summary/buckets', methods=['GET'])
@login_required
def bucket_summary():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    user_id, family_id = _scope_filters(scope)
    db = get_db()
    params = []
    query = "SELECT * FROM buckets"
    filters = []
    _append_owner_filter(filters, params, alias='buckets', user_id=user_id, family_id=family_id)
    if filters:
        query += " WHERE " + " AND ".join(filters)
    query += " ORDER BY sort_order, name"
    buckets = db.execute(query, params).fetchall()

    # Single aggregation query for all bucket allocations (replaces N+1 loop)
    alloc_filters = [
        "a.is_active = 1",
        """be.id = (
            SELECT id FROM balance_entries b2
            WHERE b2.account_id = be.account_id
            ORDER BY id DESC LIMIT 1
        )""",
    ]
    alloc_params = []
    _append_owner_filter(alloc_filters, alloc_params, alias='a', user_id=user_id, family_id=family_id)
    alloc_rows = db.execute(f"""
        SELECT ba.bucket_id, COALESCE(SUM(ba.amount), 0) AS allocated
        FROM bucket_allocations ba
        JOIN balance_entries be ON be.id = ba.balance_entry_id
        JOIN accounts a ON a.id = be.account_id
        WHERE {" AND ".join(alloc_filters)}
        GROUP BY ba.bucket_id
    """, alloc_params).fetchall()
    allocated_by_bucket = {row['bucket_id']: row['allocated'] for row in alloc_rows}

    results = []
    for b in buckets:
        d = dict(b)
        d['allocated'] = allocated_by_bucket.get(b['id'], 0.0)
        results.append(d)

    if scope == 'all':
        return jsonify(_merge_bucket_rows(results))
    return jsonify(results)


@app.route('/api/summary/timeline', methods=['GET'])
@login_required
def timeline():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    interval = request.args.get('interval', 'month')
    date_from = request.args.get('from', '')
    date_to = request.args.get('to', '')

    user_id, family_id = _scope_filters(scope)
    db = get_db()
    params_accounts = []
    accounts_query = "SELECT id, user_id, name, type, currency FROM accounts WHERE is_active=1"
    filters = []
    _append_owner_filter(filters, params_accounts, alias='accounts', user_id=user_id, family_id=family_id)
    if filters:
        accounts_query += " AND " + " AND ".join(filters)
    accounts_query += " ORDER BY name"
    accounts = db.execute(accounts_query, params_accounts).fetchall()

    where = ""
    params_base = []
    if date_from:
        where += " AND be.recorded_at >= ?"
        params_base.append(date_from)
    if date_to:
        where += " AND be.recorded_at <= ?"
        params_base.append(date_to + 'T23:59:59')

    all_periods = set()
    account_series = []

    rates = _fetch_usd_rates()   # single call — cached daily

    # Single query fetching all balance entries for all user accounts at once
    if accounts:
        acc_ids = [a['id'] for a in accounts]
        placeholders = ','.join('?' * len(acc_ids))
        all_entries = db.execute(f"""
            SELECT be.account_id, be.recorded_at, be.amount
            FROM balance_entries be
            WHERE be.account_id IN ({placeholders}) {where}
            ORDER BY be.account_id, be.recorded_at
        """, (*acc_ids, *params_base)).fetchall()
    else:
        all_entries = []

    # Group entries by account_id
    from collections import defaultdict
    entries_by_account = defaultdict(list)
    for row in all_entries:
        entries_by_account[row['account_id']].append(row)

    acc_map = {a['id']: dict(a) for a in accounts}
    for acc in accounts:
        rows = entries_by_account[acc['id']]
        period_map = {}
        for r in rows:
            period = _period_label(r['recorded_at'], interval)
            if period is None:
                continue
            period_map[period] = _currency_to_usd(r['amount'], acc['currency'], rates=rates)
        all_periods.update(period_map.keys())
        account_series.append({'account': dict(acc), 'data': period_map})

    labels = sorted(all_periods)
    datasets = []
    net_worth_map = {p: 0 for p in labels}

    for series in account_series:
        data = []
        last = None
        for p in labels:
            val = series['data'].get(p, last)
            last = val
            data.append(val)
            if val is not None:
                net_worth_map[p] = net_worth_map.get(p, 0) + val
        datasets.append({
            'account_id': series['account']['id'],
            'name': series['account']['name'],
            'type': series['account']['type'],
            'data': data,
        })

    if scope == 'all':
        merged = {}
        for ds in datasets:
            key = (ds['name'].strip().lower(), ds['type'])
            current = merged.get(key)
            if not current:
                merged[key] = {
                    'account_id': None,
                    'name': ds['name'],
                    'type': ds['type'],
                    'data': [value or 0 for value in ds['data']],
                }
                continue
            current['data'] = [
                (left or 0) + (right or 0)
                for left, right in zip(current['data'], ds['data'])
            ]
        datasets = sorted(merged.values(), key=lambda item: (item['type'], item['name'].lower()))

    net_series = [net_worth_map.get(p) for p in labels]
    return jsonify({'labels': labels, 'datasets': datasets, 'net_worth': net_series})


# Transactions

@app.route('/api/transactions', methods=['GET'])
@login_required
def list_transactions():
    try:
        scope = _request_scope()
    except ValueError as e:
        return _json_error(str(e), 400)

    user_id, family_id = _scope_filters(scope)
    db = get_db()
    where = []
    params = []
    if user_id is not None:
        where.append("t.user_id = ?")
        params.append(user_id)
    elif family_id is not None:
        where.append("t.user_id IN (SELECT id FROM users WHERE family_id = ?)")
        params.append(family_id)

    query = """
        SELECT t.*,
               u.name AS user_name,
               fa.name AS from_account_name,
               ta.name AS to_account_name
        FROM transactions t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN accounts fa ON fa.id = t.from_account_id
        LEFT JOIN accounts ta ON ta.id = t.to_account_id
    """
    if where:
        query += " WHERE " + " AND ".join(where)
    query += " ORDER BY t.recorded_at DESC, t.id DESC LIMIT 200"
    rows = db.execute(query, params).fetchall()
    return jsonify(_serialize_transaction_rows(rows))


@app.route('/api/transactions', methods=['POST'])
@login_required
def create_transaction():
    d = request.get_json(silent=True) or {}
    db = get_db()
    user_id = current_finance_user_id()

    txn_type = (d.get('txn_type') or '').strip().lower()
    try:
        amount = float(d.get('amount') or 0)
    except (TypeError, ValueError):
        return _json_error('Amount must be a number', 400)

    from_account_id = d.get('from_account_id') or None
    to_account_id = d.get('to_account_id') or None
    counterparty = (d.get('counterparty') or '').strip() or None
    note = (d.get('note') or '').strip() or None
    recorded_at = d.get('recorded_at') or None
    fx_rate = d.get('fx_rate')

    try:
        if from_account_id is not None:
            from_account_id = int(from_account_id)
        if to_account_id is not None:
            to_account_id = int(to_account_id)
    except (TypeError, ValueError):
        return _json_error('Invalid account ID', 400)

    try:
        txn_id = _execute_transaction(
            db, user_id, txn_type, amount,
            from_account_id=from_account_id,
            to_account_id=to_account_id,
            counterparty=counterparty,
            note=note,
            recorded_at=recorded_at,
            fx_rate=fx_rate,
        )
        db.commit()
    except ValueError as e:
        db.rollback()
        return _json_error(str(e), 400)

    row = db.execute("""
        SELECT t.*,
               u.name AS user_name,
               fa.name AS from_account_name,
               ta.name AS to_account_name
        FROM transactions t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN accounts fa ON fa.id = t.from_account_id
        LEFT JOIN accounts ta ON ta.id = t.to_account_id
        WHERE t.id = ?
    """, (txn_id,)).fetchone()
    return jsonify(_serialize_transaction_row(row, rates=_fetch_usd_rates())), 201


@app.route('/api/transactions/<int:tid>', methods=['DELETE'])
@login_required
def delete_transaction(tid):
    db = get_db()
    user_id = current_finance_user_id()
    txn = db.execute(
        "SELECT id FROM transactions WHERE id=? AND user_id=?",
        (tid, user_id)
    ).fetchone()
    if not txn:
        return _json_error('Transaction not found', 404)
    # Explicitly delete linked balance entries before removing the transaction
    # (SQLite ALTER TABLE cannot change FK ON DELETE behaviour, so we do it manually)
    db.execute("DELETE FROM balance_entries WHERE transaction_id=?", (tid,))
    db.execute("DELETE FROM transactions WHERE id=?", (tid,))
    db.commit()
    return jsonify({'ok': True})


# Exchange Rates

@app.route('/api/rates', methods=['GET'])
def exchange_rates():
    try:
        url = 'https://open.er-api.com/v6/latest/USD'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = _json.loads(resp.read())
        rates = {'AED': data['rates']['AED'], 'INR': data['rates']['INR']}
        date = data.get('time_last_update_utc', '')[:16]
        return jsonify({'rates': rates, 'date': date, 'base': 'USD'})
    except Exception as e:
        return jsonify({
            'rates': {'AED': 3.6725, 'INR': 83.5},
            'date': None,
            'base': 'USD',
            'error': str(e),
        })


if __name__ == '__main__':
    init_db()
    migrate_db()
    app.run(debug=True, port=5050)
