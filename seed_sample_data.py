#!/usr/bin/env python3
"""Seed a fresh State of Finance database with demo data."""

from datetime import timedelta
import sys

from app import (
    DB_BACKEND,
    DB_PATH,
    _auto_allocate_buckets,
    _dt_str,
    _execute_transaction,
    _hash_password,
    _utc_now,
    app,
    get_db,
    init_db,
    migrate_db,
)

DEMO_PASSWORD = "DemoPass!123"
DEMO_USERS = [
    {"name": "Aaliyah", "email": "aaliyah.demo@example.com"},
    {"name": "Hassan", "email": "hassan.demo@example.com"},
]
NON_EMPTY_TABLES = ("users", "accounts", "balance_entries", "buckets", "transactions")


def insert_row(db, query, params):
    cur = db.execute(query, params)
    return int(cur.lastrowid)


def table_count(db, table_name):
    row = db.execute(f"SELECT COUNT(*) AS c FROM {table_name}").fetchone()
    return int(row["c"] or 0)


def ensure_empty_database(db):
    populated = {table: table_count(db, table) for table in NON_EMPTY_TABLES}
    if any(populated.values()):
        details = ", ".join(f"{table}={count}" for table, count in populated.items())
        raise RuntimeError(
            "Refusing to seed sample data into a non-empty database. "
            f"Current counts: {details}"
        )


def seed_demo_data(db):
    now = _utc_now()

    def ts(days_ago):
        return _dt_str(now - timedelta(days=days_ago))

    family_id = insert_row(
        db,
        "INSERT INTO families (name, created_at) VALUES (?, ?)",
        ("Demo Household", ts(90)),
    )

    user_ids = {}
    for offset, user in enumerate(DEMO_USERS, start=1):
        created_at = ts(90 - offset)
        user_id = insert_row(
            db,
            "INSERT INTO users (name, family_id, created_at) VALUES (?,?,?)",
            (user["name"], family_id, created_at),
        )
        user_ids[user["name"]] = user_id
        insert_row(
            db,
            """
            INSERT INTO auth_accounts (
                user_id, email, password_hash, email_verified_at, last_login_at, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?)
            """,
            (
                user_id,
                user["email"],
                _hash_password(DEMO_PASSWORD),
                created_at,
                created_at,
                created_at,
                created_at,
            ),
        )

    aaliyah_id = user_ids["Aaliyah"]
    hassan_id = user_ids["Hassan"]

    main_savings_id = insert_row(
        db,
        "INSERT INTO accounts (user_id, name, type, institution, created_at) VALUES (?,?,?,?,?)",
        (aaliyah_id, "Main Savings", "bank", "Emirates NBD", ts(60)),
    )
    india_equity_id = insert_row(
        db,
        "INSERT INTO accounts (user_id, name, type, institution, created_at) VALUES (?,?,?,?,?)",
        (aaliyah_id, "India Equity Basket", "investment_group", "Groww", ts(58)),
    )
    adnoc_shares_id = insert_row(
        db,
        "INSERT INTO accounts (user_id, name, type, institution, created_at) VALUES (?,?,?,?,?)",
        (aaliyah_id, "ADNOC Distribution", "shares", "ADX", ts(57)),
    )
    salary_account_id = insert_row(
        db,
        "INSERT INTO accounts (user_id, name, type, institution, created_at) VALUES (?,?,?,?,?)",
        (hassan_id, "Salary Account", "bank", "Mashreq", ts(55)),
    )
    retirement_etf_id = insert_row(
        db,
        "INSERT INTO accounts (user_id, name, type, institution, created_at) VALUES (?,?,?,?,?)",
        (hassan_id, "Retirement ETF", "investment_group", "Interactive Brokers", ts(55)),
    )
    home_mortgage_id = insert_row(
        db,
        "INSERT INTO accounts (user_id, name, type, institution, created_at) VALUES (?,?,?,?,?)",
        (hassan_id, "Home Mortgage", "loan", "Dubai Islamic Bank", ts(54)),
    )

    db.execute(
        """
        INSERT INTO share_details (
            account_id, stock_name, exchange, stock_code, quantity,
            purchase_price, purchase_price_currency,
            last_price, last_price_currency, last_fetched
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        (adnoc_shares_id, "ADNOC Distribution", "ADX", "ADNOCDIST", 1800, 12.40, "AED", 13.87, "AED", ts(12)),
    )
    db.execute(
        """
        INSERT INTO loan_details (
            account_id, interest_rate, remaining_tenure, monthly_emi, remaining_principal
        ) VALUES (?,?,?,?,?)
        """,
        (home_mortgage_id, 4.1, 178, 1735, 25000),
    )

    aaliyah_bank_entry_id = insert_row(
        db,
        "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
        (main_savings_id, 18000, "Opening balance", ts(45)),
    )
    insert_row(
        db,
        "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
        (india_equity_id, 12000, "Opening portfolio valuation", ts(44)),
    )
    insert_row(
        db,
        "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
        (adnoc_shares_id, 6800, "Opening market value", ts(43)),
    )
    insert_row(
        db,
        "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
        (salary_account_id, 9000, "Opening balance", ts(40)),
    )
    insert_row(
        db,
        "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
        (retirement_etf_id, 15000, "Opening portfolio valuation", ts(40)),
    )
    insert_row(
        db,
        "INSERT INTO balance_entries (account_id, amount, note, recorded_at) VALUES (?,?,?,?)",
        (home_mortgage_id, -25000, "Initial principal", ts(39)),
    )

    emergency_fund_id = insert_row(
        db,
        """
        INSERT INTO buckets (user_id, name, target, color, allocation_type, sort_order, created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
        (aaliyah_id, "Emergency Fund", 12000, "#10b981", "manual", 1, ts(42)),
    )
    holiday_bucket_id = insert_row(
        db,
        """
        INSERT INTO buckets (user_id, name, target, color, allocation_type, sort_order, created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
        (aaliyah_id, "Dubai Holiday", 4000, "#f59e0b", "manual", 2, ts(42)),
    )
    school_fees_id = insert_row(
        db,
        """
        INSERT INTO buckets (user_id, name, target, color, allocation_type, sort_order, created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
        (hassan_id, "School Fees", 5000, "#3b82f6", "auto", 1, ts(38)),
    )
    car_upgrade_id = insert_row(
        db,
        """
        INSERT INTO buckets (user_id, name, target, color, allocation_type, sort_order, created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
        (hassan_id, "Car Upgrade", 4000, "#8b5cf6", "auto", 2, ts(38)),
    )

    db.execute(
        "INSERT INTO bucket_allocations (balance_entry_id, bucket_id, amount) VALUES (?,?,?)",
        (aaliyah_bank_entry_id, emergency_fund_id, 7000),
    )
    db.execute(
        "INSERT INTO bucket_allocations (balance_entry_id, bucket_id, amount) VALUES (?,?,?)",
        (aaliyah_bank_entry_id, holiday_bucket_id, 2500),
    )

    _execute_transaction(
        db,
        aaliyah_id,
        "credit",
        3500,
        to_account_id=main_savings_id,
        counterparty="Acme FZ-LLC",
        note="Monthly salary",
        recorded_at=ts(20),
    )
    _execute_transaction(
        db,
        aaliyah_id,
        "debit",
        650,
        from_account_id=main_savings_id,
        counterparty="Spinneys",
        note="Weekly groceries",
        recorded_at=ts(7),
    )
    _execute_transaction(
        db,
        hassan_id,
        "credit",
        3000,
        to_account_id=salary_account_id,
        counterparty="Northstar Technologies",
        note="Consulting payout",
        recorded_at=ts(15),
    )
    _execute_transaction(
        db,
        hassan_id,
        "intra",
        2000,
        from_account_id=salary_account_id,
        to_account_id=retirement_etf_id,
        note="ETF contribution",
        recorded_at=ts(10),
    )
    _auto_allocate_buckets(db, hassan_id)

    return {
        "family_id": family_id,
        "users": len(DEMO_USERS),
        "accounts": table_count(db, "accounts"),
        "buckets": table_count(db, "buckets"),
        "transactions": table_count(db, "transactions"),
        "balance_entries": table_count(db, "balance_entries"),
        "manual_bucket_ids": [emergency_fund_id, holiday_bucket_id],
        "auto_bucket_ids": [school_fees_id, car_upgrade_id],
    }


def main():
    init_db()
    migrate_db()

    with app.app_context():
        db = get_db()
        try:
            ensure_empty_database(db)
            summary = seed_demo_data(db)
            db.commit()
        except Exception as exc:
            db.rollback()
            print(f"Sample seed failed: {exc}", file=sys.stderr)
            return 1

    print("Sample data seeded successfully.")
    print(f"Backend: {DB_BACKEND}")
    if DB_BACKEND == "postgres":
        print("Database: configured via DATABASE_URL")
    else:
        print(f"Database: {DB_PATH}")
    print("Demo sign-in credentials:")
    for user in DEMO_USERS:
        print(f"- {user['email']} / {DEMO_PASSWORD}")
    print(
        "Seeded rows: "
        f"{summary['users']} users, "
        f"{summary['accounts']} accounts, "
        f"{summary['buckets']} buckets, "
        f"{summary['transactions']} transactions, "
        f"{summary['balance_entries']} balance entries."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
