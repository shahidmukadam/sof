"""
Migrate data from local SQLite (finance.db) to a PostgreSQL database.

Usage:
    pip install psycopg[binary]
    python3 migrate_to_postgres.py "postgresql://user:pass@host/dbname?sslmode=require"

Run this ONCE after setting up your Neon database.
The target database must already have tables created (wsgi.py does this on first deploy,
or run: DATABASE_URL="..." python3 -c "from app import init_db, migrate_db; init_db(); migrate_db()")
"""

import sys
import sqlite3
import psycopg
from psycopg.rows import dict_row

TABLES_IN_ORDER = [
    'families',
    'users',
    'auth_accounts',
    'accounts',
    'loan_details',
    'share_details',
    'buckets',
    'otp_challenges',
    'local_otp_outbox',
    'transactions',
    'balance_entries',
    'bucket_allocations',
]

def migrate(pg_url: str, sqlite_path: str = 'finance.db'):
    print(f'Reading from SQLite: {sqlite_path}')
    sq = sqlite3.connect(sqlite_path)
    sq.row_factory = sqlite3.Row

    pg_url_fixed = pg_url
    if pg_url_fixed.startswith('postgres://'):
        pg_url_fixed = 'postgresql://' + pg_url_fixed[len('postgres://'):]

    print(f'Connecting to Postgres...')
    pg = psycopg.connect(pg_url_fixed, row_factory=dict_row)

    total_rows = 0
    with pg.transaction():
        # Disable FK checks during import
        pg.execute('SET session_replication_role = replica')

        for table in TABLES_IN_ORDER:
            rows = sq.execute(f'SELECT * FROM {table}').fetchall()
            if not rows:
                print(f'  {table}: 0 rows (skipped)')
                continue

            cols = list(rows[0].keys())
            col_list = ', '.join(f'"{c}"' for c in cols)
            placeholders = ', '.join(f'%({c})s' for c in cols)
            sql = f'INSERT INTO {table} ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING'

            batch = [dict(r) for r in rows]
            pg.executemany(sql, batch)
            print(f'  {table}: {len(batch)} rows migrated')
            total_rows += len(batch)

        # Reset sequences to max id in each table so future inserts don't collide
        for table in TABLES_IN_ORDER:
            try:
                pg.execute(f"""
                    SELECT setval(
                        pg_get_serial_sequence('{table}', 'id'),
                        COALESCE((SELECT MAX(id) FROM {table}), 1)
                    )
                """)
            except Exception:
                pass  # Table may not have an id sequence (e.g. loan_details)

        pg.execute('SET session_replication_role = DEFAULT')

    pg.commit()
    print(f'\nDone. {total_rows} total rows migrated to Postgres.')
    sq.close()
    pg.close()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    migrate(sys.argv[1])
