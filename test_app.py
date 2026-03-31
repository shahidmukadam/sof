"""
test_app.py — State of Finance · comprehensive unit tests

Covers:
  - Assets CRUD (bank, loan, shares, investment_group)
  - Loan account details and automatic balance entries
  - Shares account details, price fetching, and refresh
  - Balance entries (create, list, delete, ordering)
  - Bucket CRUD and allocation type validation
  - Manual bucket allocation rules and edge cases
  - Auto allocation logic (fill, partial, priority, re-run idempotency)
  - Net worth summary (totals, breakdown, unallocated cash)
  - Timeline summary (intervals, date filters, carry-forward)
  - Exchange rates endpoint (live + fallback)

Run with:
    python run_tests.py
"""

import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from werkzeug.security import generate_password_hash

# ── Bootstrap: redirect the app to a fresh temp DB before importing ──────────
_DB_FILE = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
_DB_FILE.close()

import app as _mod                                          # noqa: E402
_mod.DB_PATH = _DB_FILE.name

from app import app as _flask_app, init_db, migrate_db      # noqa: E402

# ── Deterministic mock values used across all shares tests ───────────────────
#   price=500 INR, qty=10 shares, rate=100 INR/USD  →  value = 50 USD
_PRICE    = 500.0
_CURRENCY = 'INR'
_TICKER   = 'TESTCO.NS'
_RATES    = {'AED': 4.0, 'INR': 100.0, 'USD': 1.0}

# ── Test auth credentials ─────────────────────────────────────────────────────
_TEST_EMAIL    = 'testuser@example.com'
_TEST_PASSWORD = 'testpassword123'


# ── Module-level DB lifecycle ─────────────────────────────────────────────────

def setUpModule():
    init_db()
    migrate_db()
    _flask_app.config['TESTING'] = True

    # Create a test family, user, and auth account for all tests
    pw_hash = generate_password_hash(_TEST_PASSWORD, method='pbkdf2:sha256:600000')
    with sqlite3.connect(_DB_FILE.name) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.execute(
            "INSERT INTO families (name, created_at) VALUES ('Test Household', datetime('now'))"
        )
        family_id = cur.lastrowid
        cur = conn.execute(
            "INSERT INTO users (name, family_id, created_at) VALUES ('TestUser', ?, datetime('now'))",
            (family_id,)
        )
        user_id = cur.lastrowid
        conn.execute("""
            INSERT INTO auth_accounts
                (user_id, email, password_hash, email_verified_at, last_login_at,
                 is_active, created_at, updated_at)
            VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, datetime('now'), datetime('now'))
        """, (user_id, _TEST_EMAIL, pw_hash))
        conn.commit()


def tearDownModule():
    try:
        os.unlink(_DB_FILE.name)
    except OSError:
        pass


def _reset_db():
    """Delete all financial rows between tests (FK-safe order, preserves auth)."""
    with sqlite3.connect(_DB_FILE.name) as conn:
        conn.executescript("""
            DELETE FROM bucket_allocations;
            DELETE FROM balance_entries;
            DELETE FROM transactions;
            DELETE FROM share_details;
            DELETE FROM loan_details;
            DELETE FROM buckets;
            DELETE FROM accounts;
        """)


# ── Shared base class ─────────────────────────────────────────────────────────

class _Base(unittest.TestCase):

    def setUp(self):
        self.c = _flask_app.test_client()
        _reset_db()
        # Authenticate — all protected endpoints require a valid session
        r = self.c.post('/api/auth/signin',
                        data=json.dumps({'email': _TEST_EMAIL, 'password': _TEST_PASSWORD}),
                        content_type='application/json')
        assert r.status_code == 200, f'Test login failed: {r.data}'

    # ── HTTP wrappers ─────────────────────────────────────────────────────────
    def _post(self, url, body):
        return self.c.post(url, data=json.dumps(body),
                           content_type='application/json')

    def _patch(self, url, body):
        return self.c.patch(url, data=json.dumps(body),
                            content_type='application/json')

    def _get(self, url):
        return self.c.get(url)

    def _delete(self, url):
        return self.c.delete(url)

    def _j(self, resp):
        return json.loads(resp.data)

    # ── Asset factories ───────────────────────────────────────────────────────
    def _bank(self, name='Savings', institution='Test Bank'):
        return self._j(self._post('/api/accounts',
                                  {'name': name, 'type': 'bank',
                                   'institution': institution}))

    def _investment(self, name='Portfolio'):
        return self._j(self._post('/api/accounts',
                                  {'name': name, 'type': 'investment_group'}))

    def _loan(self, name='Home Loan', principal=10000.0, emi=500.0,
              rate=8.5, tenure=24):
        return self._j(self._post('/api/accounts', {
            'name': name, 'type': 'loan',
            'interest_rate': rate, 'remaining_tenure': tenure,
            'monthly_emi': emi, 'remaining_principal': principal,
        }))

    def _shares(self, name='TESTCO', exchange='NSE', code='TESTCO', qty=10):
        with patch.object(_mod, '_fetch_stock_price',
                          return_value=(_PRICE, _CURRENCY, _TICKER)), \
             patch.object(_mod, '_fetch_usd_rates', return_value=_RATES):
            r = self._post('/api/accounts', {
                'name': name, 'type': 'shares',
                'stock_name': 'Test Company Ltd',
                'exchange': exchange, 'stock_code': code, 'quantity': qty,
            })
        return self._j(r)

    def _bucket(self, name='Emergency Fund', target=5000.0,
                allocation_type='manual', color='#6366f1'):
        return self._j(self._post('/api/buckets',
                                  {'name': name, 'target': target,
                                   'color': color,
                                   'allocation_type': allocation_type}))

    def _entry(self, account_id, amount, allocations=None,
               note='', recorded_at=None):
        body = {'account_id': account_id, 'amount': amount, 'note': note}
        if allocations:
            body['allocations'] = allocations
        if recorded_at:
            body['recorded_at'] = recorded_at
        return self._j(self._post('/api/balances', body))

    def _net_worth(self):
        return self._j(self._get('/api/summary/net-worth'))


# =============================================================================
# 1 · Assets CRUD
# =============================================================================

class TestAssetsCRUD(_Base):
    """Basic create / read / update / delete for all four asset types."""

    def test_create_bank_account_returns_201_status_code(self):
        r = self._post('/api/accounts',
                       {'name': 'ENBD', 'type': 'bank', 'institution': 'Emirates NBD'})
        self.assertEqual(201, r.status_code)

    def test_create_bank_account_response_contains_id_name_type(self):
        acc = self._bank('ENBD Savings')
        self.assertIn('id', acc)
        self.assertEqual('ENBD Savings', acc['name'])
        self.assertEqual('bank', acc['type'])

    def test_create_investment_group_stores_correct_type(self):
        acc = self._investment('Vanguard Portfolio')
        self.assertEqual('investment_group', acc['type'])

    def test_list_accounts_returns_all_active_assets(self):
        self._bank('Bank A')
        self._bank('Bank B')
        self._investment('Fund C')
        accounts = self._j(self._get('/api/accounts'))
        names = {a['name'] for a in accounts}
        self.assertIn('Bank A', names)
        self.assertIn('Bank B', names)
        self.assertIn('Fund C', names)

    def test_newly_created_account_increases_list_count_by_one(self):
        before = len(self._j(self._get('/api/accounts')))
        self._bank('New Account')
        after = len(self._j(self._get('/api/accounts')))
        self.assertEqual(before + 1, after)

    def test_soft_deleted_account_absent_from_accounts_list(self):
        acc = self._bank('Temp Account')
        self._delete(f'/api/accounts/{acc["id"]}')
        ids = [a['id'] for a in self._j(self._get('/api/accounts'))]
        self.assertNotIn(acc['id'], ids)

    def test_patch_account_name_reflects_new_value_in_response(self):
        acc = self._bank('Old Name')
        r = self._patch(f'/api/accounts/{acc["id"]}', {'name': 'New Name'})
        self.assertEqual(200, r.status_code)
        self.assertEqual('New Name', self._j(r)['name'])

    def test_patch_institution_does_not_change_account_type(self):
        acc = self._bank('Savings', institution='Old Bank')
        self._patch(f'/api/accounts/{acc["id"]}', {'institution': 'New Bank'})
        updated = next(a for a in self._j(self._get('/api/accounts'))
                       if a['id'] == acc['id'])
        self.assertEqual('bank', updated['type'])
        self.assertEqual('New Bank', updated['institution'])

    def test_delete_account_returns_ok_true(self):
        acc = self._bank()
        r = self._delete(f'/api/accounts/{acc["id"]}')
        self.assertEqual(200, r.status_code)
        self.assertTrue(self._j(r)['ok'])

    def test_list_accounts_response_includes_loan_detail_columns(self):
        loan = self._loan(rate=9.5, tenure=36)
        accounts = self._j(self._get('/api/accounts'))
        match = next(a for a in accounts if a['id'] == loan['id'])
        self.assertIn('interest_rate', match)
        self.assertIn('remaining_tenure', match)

    def test_list_accounts_response_includes_share_detail_columns(self):
        s = self._shares()
        accounts = self._j(self._get('/api/accounts'))
        match = next(a for a in accounts if a['id'] == s['id'])
        self.assertIn('exchange', match)
        self.assertIn('stock_code', match)
        self.assertIn('quantity', match)


# =============================================================================
# 2 · Loan Account Details
# =============================================================================

class TestLoanAccountDetails(_Base):
    """Loan-specific fields and the automatic balance-entry creation rules."""

    def test_create_loan_stores_interest_rate_tenure_emi_principal(self):
        loan = self._loan(rate=9.5, tenure=36, emi=1200.0, principal=50000.0)
        self.assertAlmostEqual(9.5,     loan['interest_rate'],       places=4)
        self.assertEqual(36,            loan['remaining_tenure'])
        self.assertAlmostEqual(1200.0,  loan['monthly_emi'],          places=2)
        self.assertAlmostEqual(50000.0, loan['remaining_principal'],  places=2)

    def test_create_loan_with_nonzero_principal_auto_creates_negative_balance_entry(self):
        loan = self._loan(principal=20000.0)
        entries = self._j(self._get(f'/api/balances?account_id={loan["id"]}'))
        self.assertEqual(1, len(entries))
        self.assertAlmostEqual(-20000.0, entries[0]['amount'], places=2)

    def test_create_loan_balance_entry_has_initial_principal_note(self):
        loan = self._loan(principal=20000.0)
        entries = self._j(self._get(f'/api/balances?account_id={loan["id"]}'))
        self.assertIn('principal', entries[0]['note'].lower())

    def test_create_loan_with_zero_principal_creates_no_balance_entry(self):
        loan = self._j(self._post('/api/accounts', {
            'name': 'Zero Loan', 'type': 'loan',
            'interest_rate': 5.0, 'remaining_tenure': 12,
            'monthly_emi': 0.0, 'remaining_principal': 0.0,
        }))
        entries = self._j(self._get(f'/api/balances?account_id={loan["id"]}'))
        self.assertEqual(0, len(entries))

    def test_update_loan_principal_creates_additional_negative_balance_entry(self):
        loan = self._loan(principal=10000.0)
        initial_count = len(self._j(self._get(f'/api/balances?account_id={loan["id"]}')))
        self._patch(f'/api/accounts/{loan["id"]}', {'remaining_principal': 8000.0})
        entries = self._j(self._get(f'/api/balances?account_id={loan["id"]}'))
        self.assertEqual(initial_count + 1, len(entries))

    def test_update_loan_principal_new_entry_amount_is_negated(self):
        loan = self._loan(principal=10000.0)
        self._patch(f'/api/accounts/{loan["id"]}', {'remaining_principal': 8000.0})
        entries = self._j(self._get(f'/api/balances?account_id={loan["id"]}'))
        # Sort by id DESC — auto-increment guarantees the newest entry has the highest id
        latest = sorted(entries, key=lambda e: e['id'], reverse=True)[0]
        self.assertAlmostEqual(-8000.0, latest['amount'], places=2)

    def test_update_loan_interest_rate_only_does_not_create_new_balance_entry(self):
        loan = self._loan(principal=10000.0)
        initial_count = len(self._j(self._get(f'/api/balances?account_id={loan["id"]}')))
        self._patch(f'/api/accounts/{loan["id"]}', {'interest_rate': 7.0})
        entries = self._j(self._get(f'/api/balances?account_id={loan["id"]}'))
        self.assertEqual(initial_count, len(entries))

    def test_loan_shows_as_negative_amount_in_net_worth_by_type_breakdown(self):
        bank = self._bank()
        self._entry(bank['id'], 10000.0)
        self._loan(principal=5000.0)
        nw = self._net_worth()
        self.assertIn('loan', nw['by_type'])
        self.assertLess(nw['by_type']['loan'], 0)


# =============================================================================
# 3 · Shares Account Details
# =============================================================================

class TestSharesAccountDetails(_Base):
    """Share-specific fields, automatic price fetching, and the refresh endpoint."""

    def test_create_shares_stores_exchange_stock_code_and_quantity(self):
        s = self._shares(exchange='NSE', code='RELIANCE', qty=50)
        self.assertEqual('NSE',       s['exchange'])
        self.assertEqual('RELIANCE',  s['stock_code'])
        self.assertEqual(50,          s['quantity'])

    def test_create_shares_uppercases_stock_code_before_storing(self):
        with patch.object(_mod, '_fetch_stock_price',
                          return_value=(_PRICE, _CURRENCY, _TICKER)), \
             patch.object(_mod, '_fetch_usd_rates', return_value=_RATES):
            s = self._j(self._post('/api/accounts', {
                'name': 'Reliance', 'type': 'shares',
                'exchange': 'NSE', 'stock_code': 'reliance', 'quantity': 10,
            }))
        self.assertEqual('RELIANCE', s['stock_code'])

    def test_create_shares_returns_201_status_code(self):
        with patch.object(_mod, '_fetch_stock_price',
                          return_value=(_PRICE, _CURRENCY, _TICKER)), \
             patch.object(_mod, '_fetch_usd_rates', return_value=_RATES):
            r = self._post('/api/accounts', {
                'name': 'EMAAR', 'type': 'shares',
                'exchange': 'DFM', 'stock_code': 'EMAAR', 'quantity': 100,
            })
        self.assertEqual(201, r.status_code)

    def test_create_shares_auto_fetches_price_and_creates_balance_entry(self):
        # 500 INR × 10 shares / 100 INR per USD = 50 USD
        s = self._shares(qty=10)
        entries = self._j(self._get(f'/api/balances?account_id={s["id"]}'))
        self.assertEqual(1, len(entries))
        self.assertAlmostEqual(50.0, entries[0]['amount'], places=2)

    def test_create_shares_stores_fetched_price_and_currency_in_share_details(self):
        s = self._shares(qty=5)
        self.assertAlmostEqual(_PRICE,    s['last_price'],          places=2)
        self.assertEqual(_CURRENCY,       s['last_price_currency'])

    def test_create_shares_succeeds_and_returns_201_even_when_price_fetch_fails(self):
        with patch.object(_mod, '_fetch_stock_price',
                          side_effect=ValueError('Connection timeout')):
            r = self._post('/api/accounts', {
                'name': 'Unreachable', 'type': 'shares',
                'exchange': 'DFM', 'stock_code': 'EMAAR', 'quantity': 10,
            })
        self.assertEqual(201, r.status_code)

    def test_create_shares_includes_price_fetch_error_in_response_when_fetch_fails(self):
        with patch.object(_mod, '_fetch_stock_price',
                          side_effect=ValueError('Connection timeout')):
            data = self._j(self._post('/api/accounts', {
                'name': 'Unreachable', 'type': 'shares',
                'exchange': 'DFM', 'stock_code': 'EMAAR', 'quantity': 10,
            }))
        self.assertIn('error', data.get('_price_fetch', {}))

    def test_create_shares_creates_no_balance_entry_when_price_fetch_fails(self):
        with patch.object(_mod, '_fetch_stock_price',
                          side_effect=ValueError('Connection timeout')):
            s = self._j(self._post('/api/accounts', {
                'name': 'Unreachable', 'type': 'shares',
                'exchange': 'DFM', 'stock_code': 'EMAAR', 'quantity': 10,
            }))
        entries = self._j(self._get(f'/api/balances?account_id={s["id"]}'))
        self.assertEqual(0, len(entries))

    def test_refresh_price_endpoint_returns_ok_true_with_price_fields(self):
        s = self._shares(qty=10)
        with patch.object(_mod, '_fetch_stock_price',
                          return_value=(600.0, 'INR', 'TESTCO.NS')), \
             patch.object(_mod, '_fetch_usd_rates', return_value=_RATES):
            r = self._post(f'/api/accounts/{s["id"]}/refresh-price', {})
        result = self._j(r)
        self.assertEqual(200, r.status_code)
        self.assertTrue(result['ok'])
        self.assertIn('price', result)
        self.assertIn('value_usd', result)

    def test_refresh_price_creates_new_balance_entry_with_updated_value(self):
        s = self._shares(qty=10)
        initial_count = len(self._j(self._get(f'/api/balances?account_id={s["id"]}')))
        with patch.object(_mod, '_fetch_stock_price',
                          return_value=(600.0, 'INR', 'TESTCO.NS')), \
             patch.object(_mod, '_fetch_usd_rates', return_value=_RATES):
            self._post(f'/api/accounts/{s["id"]}/refresh-price', {})
        entries = self._j(self._get(f'/api/balances?account_id={s["id"]}'))
        self.assertEqual(initial_count + 1, len(entries))
        # Sort by id DESC — auto-increment guarantees the newest entry has the highest id
        latest = sorted(entries, key=lambda e: e['id'], reverse=True)[0]
        # 600 INR × 10 / 100 = 60 USD
        self.assertAlmostEqual(60.0, latest['amount'], places=2)

    def test_refresh_price_on_bank_account_returns_400(self):
        bank = self._bank()
        r = self._post(f'/api/accounts/{bank["id"]}/refresh-price', {})
        self.assertEqual(400, r.status_code)

    def test_refresh_price_failure_returns_502_with_error_message(self):
        s = self._shares(qty=10)
        with patch.object(_mod, '_fetch_stock_price',
                          side_effect=ValueError('Market closed')):
            r = self._post(f'/api/accounts/{s["id"]}/refresh-price', {})
        self.assertEqual(502, r.status_code)
        self.assertFalse(self._j(r)['ok'])


# =============================================================================
# 4 · Balance Entries
# =============================================================================

class TestBalanceEntries(_Base):
    """Creating, listing, and deleting timestamped balance entries."""

    def test_create_balance_entry_returns_201_status_code(self):
        acc = self._bank()
        r = self._post('/api/balances', {'account_id': acc['id'], 'amount': 1000.0})
        self.assertEqual(201, r.status_code)

    def test_create_balance_entry_stores_exact_amount(self):
        acc = self._bank()
        entry = self._entry(acc['id'], 2500.75)
        self.assertAlmostEqual(2500.75, entry['amount'], places=2)

    def test_create_balance_entry_stores_note_text(self):
        acc = self._bank()
        entry = self._entry(acc['id'], 1000.0, note='Monthly snapshot')
        self.assertEqual('Monthly snapshot', entry['note'])

    def test_create_balance_entry_with_explicit_date_stores_that_date(self):
        acc = self._bank()
        entry = self._entry(acc['id'], 1000.0, recorded_at='2024-06-15T10:00:00')
        self.assertIn('2024-06-15', entry['recorded_at'])

    def test_list_balances_for_account_id_returns_only_that_accounts_entries(self):
        acc_a = self._bank('Account A')
        acc_b = self._bank('Account B')
        self._entry(acc_a['id'], 1000.0)
        self._entry(acc_a['id'], 1100.0)
        self._entry(acc_b['id'], 500.0)
        entries_a = self._j(self._get(f'/api/balances?account_id={acc_a["id"]}'))
        self.assertEqual(2, len(entries_a))
        for e in entries_a:
            self.assertEqual(acc_a['id'], e['account_id'])

    def test_list_balances_returns_entries_in_descending_recorded_at_order(self):
        acc = self._bank()
        self._entry(acc['id'], 1000.0, recorded_at='2024-01-01T10:00:00')
        self._entry(acc['id'], 3000.0, recorded_at='2024-03-01T10:00:00')
        self._entry(acc['id'], 2000.0, recorded_at='2024-02-01T10:00:00')
        entries = self._j(self._get(f'/api/balances?account_id={acc["id"]}'))
        amounts = [e['amount'] for e in entries]
        self.assertEqual([3000.0, 2000.0, 1000.0], amounts)

    def test_delete_balance_entry_removes_it_from_subsequent_list(self):
        acc = self._bank()
        entry = self._entry(acc['id'], 1000.0)
        self._delete(f'/api/balances/{entry["id"]}')
        entries = self._j(self._get(f'/api/balances?account_id={acc["id"]}'))
        self.assertEqual(0, len(entries))

    def test_create_balance_for_soft_deleted_account_returns_404(self):
        acc = self._bank()
        self._delete(f'/api/accounts/{acc["id"]}')
        r = self._post('/api/balances', {'account_id': acc['id'], 'amount': 500.0})
        self.assertEqual(404, r.status_code)

    def test_create_balance_for_nonexistent_account_id_returns_404(self):
        r = self._post('/api/balances', {'account_id': 99999, 'amount': 500.0})
        self.assertEqual(404, r.status_code)


# =============================================================================
# 5 · Buckets CRUD
# =============================================================================

class TestBucketsCRUD(_Base):
    """Creating, reading, updating, and deleting financial goal buckets."""

    def test_create_manual_bucket_returns_201_status_code(self):
        r = self._post('/api/buckets',
                       {'name': 'Vacation', 'target': 3000.0,
                        'allocation_type': 'manual', 'color': '#f59e0b'})
        self.assertEqual(201, r.status_code)

    def test_create_auto_bucket_stores_allocation_type_as_auto(self):
        b = self._bucket('Emergency Fund', allocation_type='auto')
        self.assertEqual('auto', b['allocation_type'])

    def test_create_bucket_stores_target_amount_and_color(self):
        b = self._bucket('Vacation', target=2500.0, color='#ec4899')
        self.assertAlmostEqual(2500.0, b['target'], places=2)
        self.assertEqual('#ec4899', b['color'])

    def test_create_bucket_without_allocation_type_defaults_to_manual(self):
        b = self._j(self._post('/api/buckets',
                               {'name': 'Default Bucket', 'target': 1000.0}))
        self.assertEqual('manual', b['allocation_type'])

    def test_create_bucket_without_color_defaults_to_indigo_hex(self):
        b = self._j(self._post('/api/buckets',
                               {'name': 'No Color', 'target': 500.0,
                                'allocation_type': 'manual'}))
        self.assertEqual('#6366f1', b['color'])

    def test_create_bucket_with_invalid_allocation_type_returns_400(self):
        r = self._post('/api/buckets',
                       {'name': 'Bad Bucket', 'allocation_type': 'weekly'})
        self.assertEqual(400, r.status_code)

    def test_patch_bucket_target_reflects_new_value(self):
        b = self._bucket('Emergency Fund', target=1000.0)
        r = self._patch(f'/api/buckets/{b["id"]}', {'target': 5000.0})
        self.assertEqual(200, r.status_code)
        self.assertAlmostEqual(5000.0, self._j(r)['target'], places=2)

    def test_patch_bucket_invalid_allocation_type_returns_400(self):
        b = self._bucket('Fund')
        r = self._patch(f'/api/buckets/{b["id"]}',
                        {'allocation_type': 'quarterly'})
        self.assertEqual(400, r.status_code)

    def test_delete_bucket_removes_it_from_list(self):
        b = self._bucket('Temp Bucket')
        self._delete(f'/api/buckets/{b["id"]}')
        ids = [x['id'] for x in self._j(self._get('/api/buckets'))]
        self.assertNotIn(b['id'], ids)

    def test_list_buckets_returns_all_created_buckets(self):
        self._bucket('Bucket A')
        self._bucket('Bucket B')
        self._bucket('Bucket C', allocation_type='auto')
        self.assertEqual(3, len(self._j(self._get('/api/buckets'))))


# =============================================================================
# 6 · Manual Bucket Allocation Rules
# =============================================================================

class TestManualBucketAllocationRules(_Base):
    """Validation rules enforced when linking balance entries to manual buckets."""

    def test_manual_allocation_stored_with_balance_entry_and_shows_in_bucket_summary(self):
        bank = self._bank()
        bucket = self._bucket('Vacation', target=2000.0, allocation_type='manual')
        self._entry(bank['id'], 5000.0,
                    allocations=[{'bucket_id': bucket['id'], 'amount': 1500.0}])
        summaries = self._j(self._get('/api/summary/buckets'))
        b = next(x for x in summaries if x['id'] == bucket['id'])
        self.assertAlmostEqual(1500.0, b['allocated'], places=2)

    def test_allocation_amount_exceeding_entry_balance_returns_400(self):
        bank = self._bank()
        bucket = self._bucket('Goal', allocation_type='manual')
        r = self._post('/api/balances', {
            'account_id': bank['id'], 'amount': 1000.0,
            'allocations': [{'bucket_id': bucket['id'], 'amount': 2000.0}],
        })
        self.assertEqual(400, r.status_code)

    def test_allocation_exactly_equal_to_balance_is_accepted(self):
        bank = self._bank()
        bucket = self._bucket('Goal', allocation_type='manual')
        r = self._post('/api/balances', {
            'account_id': bank['id'], 'amount': 1000.0,
            'allocations': [{'bucket_id': bucket['id'], 'amount': 1000.0}],
        })
        self.assertEqual(201, r.status_code)

    def test_negative_allocation_amount_returns_400(self):
        bank = self._bank()
        bucket = self._bucket('Goal', allocation_type='manual')
        r = self._post('/api/balances', {
            'account_id': bank['id'], 'amount': 1000.0,
            'allocations': [{'bucket_id': bucket['id'], 'amount': -50.0}],
        })
        self.assertEqual(400, r.status_code)

    def test_manual_allocation_to_auto_bucket_returns_400(self):
        bank = self._bank()
        auto_bucket = self._bucket('Auto Goal', allocation_type='auto')
        r = self._post('/api/balances', {
            'account_id': bank['id'], 'amount': 5000.0,
            'allocations': [{'bucket_id': auto_bucket['id'], 'amount': 1000.0}],
        })
        self.assertEqual(400, r.status_code)
        self.assertIn('auto', self._j(r)['error'].lower())

    def test_bucket_allocation_on_non_bank_account_returns_400(self):
        inv = self._investment()
        bucket = self._bucket('Goal', allocation_type='manual')
        r = self._post('/api/balances', {
            'account_id': inv['id'], 'amount': 5000.0,
            'allocations': [{'bucket_id': bucket['id'], 'amount': 1000.0}],
        })
        self.assertEqual(400, r.status_code)

    def test_allocation_to_nonexistent_bucket_id_returns_400(self):
        bank = self._bank()
        r = self._post('/api/balances', {
            'account_id': bank['id'], 'amount': 5000.0,
            'allocations': [{'bucket_id': 99999, 'amount': 1000.0}],
        })
        self.assertEqual(400, r.status_code)


# =============================================================================
# 7 · Auto Allocation Logic
# =============================================================================

class TestAutoAllocation(_Base):
    """Auto-allocation fills auto-buckets from bank cash in priority order."""

    def test_auto_allocate_fills_single_bucket_to_full_target_when_funds_sufficient(self):
        bank = self._bank()
        self._entry(bank['id'], 5000.0)
        self._bucket('Emergency Fund', target=2000.0, allocation_type='auto')
        result = self._j(self._post('/api/buckets/auto-allocate', {}))
        self.assertTrue(result['ok'])
        self.assertAlmostEqual(2000.0, result['buckets'][0]['allocated'], places=2)
        self.assertTrue(result['buckets'][0]['fulfilled'])

    def test_auto_allocate_partially_fills_bucket_when_bank_balance_is_insufficient(self):
        bank = self._bank()
        self._entry(bank['id'], 800.0)
        self._bucket('Emergency Fund', target=2000.0, allocation_type='auto')
        result = self._j(self._post('/api/buckets/auto-allocate', {}))
        self.assertTrue(result['ok'])
        self.assertAlmostEqual(800.0, result['buckets'][0]['allocated'], places=2)
        self.assertFalse(result['buckets'][0]['fulfilled'])
        self.assertAlmostEqual(1200.0, result['shortage'], places=2)

    def test_auto_allocate_fills_buckets_alphabetically_when_sort_order_is_equal(self):
        bank = self._bank()
        self._entry(bank['id'], 3000.0)
        self._bucket('Bucket A', target=2000.0, allocation_type='auto')
        self._bucket('Bucket B', target=2000.0, allocation_type='auto')
        result = self._j(self._post('/api/buckets/auto-allocate', {}))
        by_name = {b['name']: b for b in result['buckets']}
        self.assertAlmostEqual(2000.0, by_name['Bucket A']['allocated'], places=2)
        self.assertAlmostEqual(1000.0, by_name['Bucket B']['allocated'], places=2)

    def test_auto_allocate_deducts_manual_allocations_before_distributing(self):
        bank = self._bank()
        manual_bucket = self._bucket('Manual Goal', target=500.0, allocation_type='manual')
        # Add entry with 300 manually allocated; effective available = 2000 - 300 = 1700
        self._entry(bank['id'], 2000.0,
                    allocations=[{'bucket_id': manual_bucket['id'], 'amount': 300.0}])
        auto_bucket = self._bucket('Auto Goal', target=2000.0, allocation_type='auto')
        result = self._j(self._post('/api/buckets/auto-allocate', {}))
        self.assertAlmostEqual(1700.0, result['buckets'][0]['allocated'], places=2)

    def test_auto_allocate_clears_and_redoes_previous_auto_allocations_on_second_run(self):
        bank = self._bank()
        self._entry(bank['id'], 5000.0)
        self._bucket('Goal', target=2000.0, allocation_type='auto')
        self._post('/api/buckets/auto-allocate', {})         # first run
        result = self._j(self._post('/api/buckets/auto-allocate', {}))  # second run
        # Should still be 2000, not 4000
        self.assertAlmostEqual(2000.0, result['buckets'][0]['allocated'], places=2)

    def test_auto_allocate_spreads_across_multiple_bank_accounts(self):
        bank_a = self._bank('Bank A')
        bank_b = self._bank('Bank B')
        self._entry(bank_a['id'], 500.0)
        self._entry(bank_b['id'], 500.0)
        self._bucket('Goal', target=800.0, allocation_type='auto')
        result = self._j(self._post('/api/buckets/auto-allocate', {}))
        self.assertAlmostEqual(800.0, result['buckets'][0]['allocated'], places=2)

    def test_auto_allocate_skips_bucket_with_no_target_and_reports_shortage(self):
        bank = self._bank()
        self._entry(bank['id'], 5000.0)
        self._j(self._post('/api/buckets', {
            'name': 'No Target', 'allocation_type': 'auto',
            'color': '#6366f1',
        }))
        result = self._j(self._post('/api/buckets/auto-allocate', {}))
        self.assertFalse(result['ok'])

    def test_auto_allocate_returns_400_when_no_auto_buckets_are_configured(self):
        bank = self._bank()
        self._entry(bank['id'], 5000.0)
        self._bucket('Manual Only', target=1000.0, allocation_type='manual')
        r = self._post('/api/buckets/auto-allocate', {})
        self.assertEqual(400, r.status_code)
        self.assertFalse(self._j(r)['ok'])

    def test_auto_allocate_returns_400_when_no_bank_balance_entries_exist(self):
        self._bank()   # account with no entries
        self._bucket('Goal', target=1000.0, allocation_type='auto')
        r = self._post('/api/buckets/auto-allocate', {})
        self.assertEqual(400, r.status_code)

    def test_auto_allocate_triggered_automatically_when_bank_entry_added_and_auto_buckets_exist(self):
        bank = self._bank()
        self._bucket('Goal', target=1000.0, allocation_type='auto')
        entry = self._entry(bank['id'], 3000.0)
        self.assertIn('_auto_allocate', entry)
        self.assertTrue(entry['_auto_allocate']['buckets'][0]['fulfilled'])

    def test_auto_allocate_not_triggered_automatically_when_no_auto_buckets_exist(self):
        bank = self._bank()
        self._bucket('Manual Only', target=1000.0, allocation_type='manual')
        entry = self._entry(bank['id'], 3000.0)
        self.assertNotIn('_auto_allocate', entry)


# =============================================================================
# 8 · Net Worth Summary
# =============================================================================

class TestNetWorthSummary(_Base):
    """GET /api/summary/net-worth — totals, breakdowns, and unallocated cash."""

    def test_net_worth_is_zero_when_no_balance_entries_exist(self):
        self._bank()
        nw = self._net_worth()
        self.assertAlmostEqual(0.0, nw['total'], places=2)

    def test_net_worth_sums_latest_entry_for_each_account(self):
        acc_a = self._bank('A')
        acc_b = self._bank('B')
        self._entry(acc_a['id'], 3000.0)
        self._entry(acc_b['id'], 2000.0)
        nw = self._net_worth()
        self.assertAlmostEqual(5000.0, nw['total'], places=2)

    def test_net_worth_uses_only_latest_entry_not_sum_of_all_entries(self):
        acc = self._bank()
        self._entry(acc['id'], 1000.0, recorded_at='2024-01-01T10:00:00')
        self._entry(acc['id'], 2000.0, recorded_at='2024-02-01T10:00:00')
        nw = self._net_worth()
        # Should be 2000 (most recent), not 3000 (sum of both)
        self.assertAlmostEqual(2000.0, nw['total'], places=2)

    def test_net_worth_breaks_down_total_by_asset_type(self):
        bank = self._bank()
        inv = self._investment()
        self._entry(bank['id'], 3000.0)
        self._entry(inv['id'], 7000.0)
        nw = self._net_worth()
        self.assertAlmostEqual(3000.0, nw['by_type']['bank'],             places=2)
        self.assertAlmostEqual(7000.0, nw['by_type']['investment_group'], places=2)

    def test_loan_principal_reduces_total_net_worth(self):
        bank = self._bank()
        self._entry(bank['id'], 10000.0)
        self._loan(principal=3000.0)
        nw = self._net_worth()
        self.assertAlmostEqual(7000.0, nw['total'], places=2)

    def test_soft_deleted_account_excluded_from_net_worth_total(self):
        acc_a = self._bank('Keep')
        acc_b = self._bank('Delete')
        self._entry(acc_a['id'], 5000.0)
        self._entry(acc_b['id'], 3000.0)
        self._delete(f'/api/accounts/{acc_b["id"]}')
        nw = self._net_worth()
        self.assertAlmostEqual(5000.0, nw['total'], places=2)

    def test_unallocated_cash_equals_full_bank_balance_when_no_allocations(self):
        bank = self._bank()
        self._entry(bank['id'], 5000.0)
        nw = self._net_worth()
        self.assertAlmostEqual(5000.0, nw['unallocated_cash'], places=2)

    def test_unallocated_cash_is_bank_balance_minus_all_bucket_allocations(self):
        bank = self._bank()
        bucket = self._bucket('Goal', target=2000.0, allocation_type='manual')
        self._entry(bank['id'], 5000.0,
                    allocations=[{'bucket_id': bucket['id'], 'amount': 2000.0}])
        nw = self._net_worth()
        self.assertAlmostEqual(3000.0, nw['unallocated_cash'], places=2)

    def test_account_with_no_balance_entries_contributes_nothing_to_net_worth(self):
        self._bank('No Entries')
        nw = self._net_worth()
        self.assertAlmostEqual(0.0, nw['total'], places=2)
        self.assertEqual({}, nw['by_type'])


# =============================================================================
# 9 · Timeline Summary
# =============================================================================

class TestTimelineSummary(_Base):
    """GET /api/summary/timeline — period labels, filters, and dataset structure."""

    def test_timeline_month_interval_labels_use_yyyy_mm_format(self):
        acc = self._bank()
        self._entry(acc['id'], 1000.0, recorded_at='2024-01-15T10:00:00')
        self._entry(acc['id'], 1200.0, recorded_at='2024-03-15T10:00:00')
        data = self._j(self._get('/api/summary/timeline?interval=month'))
        self.assertIn('2024-01', data['labels'])
        self.assertIn('2024-03', data['labels'])

    def test_timeline_day_interval_labels_use_yyyy_mm_dd_format(self):
        acc = self._bank()
        self._entry(acc['id'], 1000.0, recorded_at='2024-05-10T10:00:00')
        data = self._j(self._get('/api/summary/timeline?interval=day'))
        self.assertIn('2024-05-10', data['labels'])

    def test_timeline_net_worth_line_sums_all_account_values_for_same_period(self):
        acc_a = self._bank('A')
        acc_b = self._bank('B')
        self._entry(acc_a['id'], 3000.0, recorded_at='2024-06-01T10:00:00')
        self._entry(acc_b['id'], 2000.0, recorded_at='2024-06-01T10:00:00')
        data = self._j(self._get('/api/summary/timeline?interval=month'))
        jun_idx = data['labels'].index('2024-06')
        self.assertAlmostEqual(5000.0, data['net_worth'][jun_idx], places=2)

    def test_timeline_date_from_filter_excludes_entries_before_that_date(self):
        acc = self._bank()
        self._entry(acc['id'], 1000.0, recorded_at='2023-12-01T10:00:00')
        self._entry(acc['id'], 2000.0, recorded_at='2024-06-01T10:00:00')
        data = self._j(self._get('/api/summary/timeline?interval=month&from=2024-01-01'))
        self.assertNotIn('2023-12', data['labels'])
        self.assertIn('2024-06',   data['labels'])

    def test_timeline_date_to_filter_excludes_entries_after_that_date(self):
        acc = self._bank()
        self._entry(acc['id'], 1000.0, recorded_at='2024-01-01T10:00:00')
        self._entry(acc['id'], 2000.0, recorded_at='2024-12-01T10:00:00')
        data = self._j(self._get('/api/summary/timeline?interval=month&to=2024-06-30'))
        self.assertIn('2024-01',    data['labels'])
        self.assertNotIn('2024-12', data['labels'])

    def test_timeline_empty_database_returns_empty_labels_and_datasets(self):
        data = self._j(self._get('/api/summary/timeline?interval=month'))
        self.assertEqual([], data['labels'])
        self.assertEqual([], data['datasets'])
        self.assertEqual([], data['net_worth'])

    def test_timeline_datasets_contain_one_entry_per_active_account(self):
        acc_a = self._bank('A')
        acc_b = self._bank('B')
        self._entry(acc_a['id'], 1000.0, recorded_at='2024-01-01T10:00:00')
        self._entry(acc_b['id'], 2000.0, recorded_at='2024-01-01T10:00:00')
        data = self._j(self._get('/api/summary/timeline?interval=month'))
        dataset_names = {ds['name'] for ds in data['datasets']}
        self.assertIn('A', dataset_names)
        self.assertIn('B', dataset_names)


# =============================================================================
# 10 · Exchange Rates Endpoint
# =============================================================================

class TestExchangeRates(_Base):
    """GET /api/rates — live fetch and graceful fallback."""

    def test_rates_endpoint_returns_200_with_aed_and_inr_keys(self):
        r = self._get('/api/rates')
        self.assertEqual(200, r.status_code)
        data = self._j(r)
        self.assertIn('rates', data)
        self.assertIn('AED', data['rates'])
        self.assertIn('INR', data['rates'])

    def test_rates_are_positive_numbers(self):
        data = self._j(self._get('/api/rates'))
        self.assertGreater(data['rates']['AED'], 0)
        self.assertGreater(data['rates']['INR'], 0)

    def test_rates_endpoint_returns_valid_fallback_when_external_api_unavailable(self):
        with patch('urllib.request.urlopen',
                   side_effect=ConnectionError('Network unavailable')):
            r = self._get('/api/rates')
        self.assertEqual(200, r.status_code)
        data = self._j(r)
        self.assertGreater(data['rates']['AED'], 0)
        self.assertGreater(data['rates']['INR'], 0)

    def test_rates_endpoint_includes_base_currency_field(self):
        data = self._j(self._get('/api/rates'))
        self.assertIn('base', data)


# =============================================================================
# 11 · Internal Helper Functions
# =============================================================================

class TestInternalHelpers(_Base):
    """Direct tests of pure business-logic helpers (no HTTP layer)."""

    def test_normalize_allocation_type_accepts_auto(self):
        result = _mod._normalize_bucket_allocation_type('auto')
        self.assertEqual('auto', result)

    def test_normalize_allocation_type_accepts_manual(self):
        result = _mod._normalize_bucket_allocation_type('manual')
        self.assertEqual('manual', result)

    def test_normalize_allocation_type_defaults_none_to_manual(self):
        result = _mod._normalize_bucket_allocation_type(None)
        self.assertEqual('manual', result)

    def test_normalize_allocation_type_raises_for_unknown_value(self):
        with self.assertRaises(ValueError):
            _mod._normalize_bucket_allocation_type('weekly')

    def test_extract_exchange_price_finds_lastradeprice_field(self):
        rows = [{'id': 'EMAAR', 'lastradeprice': 3.45}]
        price, currency, code = _mod._extract_exchange_price(
            rows, 'EMAAR', 'DFM', 'AED')
        self.assertAlmostEqual(3.45, price, places=4)

    def test_extract_exchange_price_falls_back_to_closingprice_when_lastrade_missing(self):
        rows = [{'id': 'EMAAR', 'lastradeprice': None, 'closingprice': 3.50}]
        price, currency, code = _mod._extract_exchange_price(
            rows, 'EMAAR', 'DFM', 'AED')
        self.assertAlmostEqual(3.50, price, places=4)

    def test_extract_exchange_price_is_case_insensitive_for_ticker_matching(self):
        rows = [{'id': 'emaar', 'lastradeprice': 3.45}]
        price, _, _ = _mod._extract_exchange_price(
            rows, 'EMAAR', 'DFM', 'AED')
        self.assertAlmostEqual(3.45, price, places=4)

    def test_extract_exchange_price_raises_when_ticker_not_found_in_rows(self):
        rows = [{'id': 'ALDAR', 'lastradeprice': 2.10}]
        with self.assertRaises(ValueError):
            _mod._extract_exchange_price(rows, 'EMAAR', 'DFM', 'AED')

    def test_extract_exchange_price_raises_when_all_price_fields_are_none(self):
        rows = [{'id': 'EMAAR', 'lastradeprice': None, 'closingprice': None,
                 'close': None, 'referenceprice': None,
                 'lastTradePrice': None, 'referencePrice': None}]
        with self.assertRaises(ValueError):
            _mod._extract_exchange_price(rows, 'EMAAR', 'DFM', 'AED')

    def test_fetch_usd_rates_returns_fallback_dict_when_network_fails(self):
        with patch('urllib.request.urlopen',
                   side_effect=Exception('Network error')):
            rates = _mod._fetch_usd_rates()
        self.assertIn('AED', rates)
        self.assertIn('INR', rates)
        self.assertIn('USD', rates)
        self.assertGreater(rates['AED'], 0)
        self.assertGreater(rates['INR'], 0)

    def test_has_auto_buckets_returns_false_when_no_buckets_exist(self):
        from app import get_db
        with _flask_app.app_context():
            db = get_db()
            user_id = db.execute(
                "SELECT id FROM users WHERE name='TestUser' LIMIT 1"
            ).fetchone()['id']
            result = _mod._has_auto_buckets(db, user_id)
        self.assertFalse(result)

    def test_has_auto_buckets_returns_true_when_at_least_one_auto_bucket_exists(self):
        self._bucket('Auto Goal', target=1000.0, allocation_type='auto')
        from app import get_db
        with _flask_app.app_context():
            db = get_db()
            user_id = db.execute(
                "SELECT id FROM users WHERE name='TestUser' LIMIT 1"
            ).fetchone()['id']
            result = _mod._has_auto_buckets(db, user_id)
        self.assertTrue(result)


# =============================================================================
# 12 · Transactions
# =============================================================================

class TestTransactions(_Base):
    """Tests for credit, debit, and intra transaction types."""

    # ── helpers ───────────────────────────────────────────────────────────────

    def _txn(self, txn_type, amount, from_id=None, to_id=None,
             counterparty=None, note=None):
        body = {'txn_type': txn_type, 'amount': amount}
        if from_id:
            body['from_account_id'] = from_id
        if to_id:
            body['to_account_id'] = to_id
        if counterparty:
            body['counterparty'] = counterparty
        if note:
            body['note'] = note
        return self._post('/api/transactions', body)

    def _latest_balance(self, account_id):
        entries = self._j(self._get(f'/api/balances?account_id={account_id}'))
        if not entries:
            return None
        # Use max id to break timestamp ties reliably
        return sorted(entries, key=lambda e: e['id'], reverse=True)[0]['amount']

    # ── credit ────────────────────────────────────────────────────────────────

    def test_credit_transaction_returns_201(self):
        bank = self._bank()
        r = self._txn('credit', 1000, to_id=bank['id'], counterparty='Salary')
        self.assertEqual(201, r.status_code)

    def test_credit_increases_account_balance_from_zero(self):
        bank = self._bank()
        self._txn('credit', 1000, to_id=bank['id'], counterparty='Salary')
        self.assertAlmostEqual(1000.0, self._latest_balance(bank['id']), places=6)

    def test_credit_accumulates_on_existing_balance(self):
        bank = self._bank()
        self._entry(bank['id'], 500)
        self._txn('credit', 300, to_id=bank['id'], counterparty='Bonus')
        self.assertAlmostEqual(800.0, self._latest_balance(bank['id']), places=6)

    def test_credit_without_destination_account_returns_400(self):
        r = self._txn('credit', 100, counterparty='Test')
        self.assertEqual(400, r.status_code)

    def test_credit_creates_balance_entry_linked_to_transaction(self):
        bank = self._bank()
        txn_resp = self._j(self._txn('credit', 200, to_id=bank['id'], counterparty='Income'))
        entries = self._j(self._get(f'/api/balances?account_id={bank["id"]}'))
        self.assertTrue(any(e.get('transaction_id') == txn_resp['id'] for e in entries))

    # ── debit ─────────────────────────────────────────────────────────────────

    def test_debit_transaction_returns_201(self):
        bank = self._bank()
        self._entry(bank['id'], 1000)
        r = self._txn('debit', 200, from_id=bank['id'], counterparty='DEWA')
        self.assertEqual(201, r.status_code)

    def test_debit_decreases_account_balance(self):
        bank = self._bank()
        self._entry(bank['id'], 1000)
        self._txn('debit', 300, from_id=bank['id'], counterparty='Rent')
        self.assertAlmostEqual(700.0, self._latest_balance(bank['id']), places=6)

    def test_debit_exceeding_balance_returns_400(self):
        bank = self._bank()
        self._entry(bank['id'], 500)
        r = self._txn('debit', 600, from_id=bank['id'], counterparty='Overspend')
        self.assertEqual(400, r.status_code)

    def test_debit_without_source_account_returns_400(self):
        r = self._txn('debit', 100, counterparty='Test')
        self.assertEqual(400, r.status_code)

    def test_debit_exact_balance_is_allowed(self):
        bank = self._bank()
        self._entry(bank['id'], 500)
        r = self._txn('debit', 500, from_id=bank['id'], counterparty='Full Withdrawal')
        self.assertEqual(201, r.status_code)
        self.assertAlmostEqual(0.0, self._latest_balance(bank['id']), places=6)

    # ── intra ─────────────────────────────────────────────────────────────────

    def test_intra_transfer_returns_201(self):
        bank = self._bank()
        inv = self._investment()
        self._entry(bank['id'], 2000)
        r = self._txn('intra', 500, from_id=bank['id'], to_id=inv['id'])
        self.assertEqual(201, r.status_code)

    def test_intra_reduces_source_and_increases_destination(self):
        bank = self._bank()
        inv = self._investment()
        self._entry(bank['id'], 2000)
        self._entry(inv['id'], 0)
        self._txn('intra', 500, from_id=bank['id'], to_id=inv['id'])
        self.assertAlmostEqual(1500.0, self._latest_balance(bank['id']), places=6)
        self.assertAlmostEqual(500.0, self._latest_balance(inv['id']), places=6)

    def test_intra_exceeding_source_balance_returns_400(self):
        bank = self._bank()
        inv = self._investment()
        self._entry(bank['id'], 100)
        r = self._txn('intra', 200, from_id=bank['id'], to_id=inv['id'])
        self.assertEqual(400, r.status_code)

    def test_intra_same_account_returns_400(self):
        bank = self._bank()
        self._entry(bank['id'], 500)
        r = self._txn('intra', 100, from_id=bank['id'], to_id=bank['id'])
        self.assertEqual(400, r.status_code)

    def test_intra_creates_two_balance_entries(self):
        bank = self._bank()
        inv = self._investment()
        self._entry(bank['id'], 1000)
        self._entry(inv['id'], 0)
        txn = self._j(self._txn('intra', 400, from_id=bank['id'], to_id=inv['id']))
        bank_entries = self._j(self._get(f'/api/balances?account_id={bank["id"]}'))
        inv_entries = self._j(self._get(f'/api/balances?account_id={inv["id"]}'))
        self.assertTrue(any(e.get('transaction_id') == txn['id'] for e in bank_entries))
        self.assertTrue(any(e.get('transaction_id') == txn['id'] for e in inv_entries))

    # ── list & delete ─────────────────────────────────────────────────────────

    def test_list_transactions_returns_created_transaction(self):
        bank = self._bank()
        self._txn('credit', 500, to_id=bank['id'], counterparty='Test Income')
        txns = self._j(self._get('/api/transactions'))
        self.assertEqual(1, len(txns))
        self.assertEqual('credit', txns[0]['txn_type'])

    def test_list_transactions_ordered_most_recent_first(self):
        bank = self._bank()
        self._txn('credit', 100, to_id=bank['id'], counterparty='A',
                  note='first')
        self._txn('credit', 200, to_id=bank['id'], counterparty='B',
                  note='second')
        txns = self._j(self._get('/api/transactions'))
        self.assertGreaterEqual(txns[0]['id'], txns[1]['id'])

    def test_delete_transaction_removes_it_from_list(self):
        bank = self._bank()
        txn = self._j(self._txn('credit', 100, to_id=bank['id'], counterparty='C'))
        self._delete(f'/api/transactions/{txn["id"]}')
        txns = self._j(self._get('/api/transactions'))
        self.assertEqual(0, len(txns))

    def test_delete_transaction_removes_linked_balance_entries(self):
        bank = self._bank()
        txn = self._j(self._txn('credit', 100, to_id=bank['id'], counterparty='C'))
        self._delete(f'/api/transactions/{txn["id"]}')
        entries = self._j(self._get(f'/api/balances?account_id={bank["id"]}'))
        self.assertEqual(0, len(entries))

    def test_delete_nonexistent_transaction_returns_404(self):
        r = self._delete('/api/transactions/9999')
        self.assertEqual(404, r.status_code)

    def test_invalid_txn_type_returns_400(self):
        bank = self._bank()
        r = self._txn('wire', 100, to_id=bank['id'])
        self.assertEqual(400, r.status_code)

    def test_zero_amount_returns_400(self):
        bank = self._bank()
        r = self._txn('credit', 0, to_id=bank['id'], counterparty='Test')
        self.assertEqual(400, r.status_code)

    # ── bucket carry-forward (regression) ────────────────────────────────────

    def test_credit_transaction_carries_forward_manual_bucket_allocations(self):
        """Manual bucket allocations from previous entry must survive a credit transaction."""
        bank = self._bank()
        bucket = self._bucket('Emergency Fund', target=2000.0)
        # Establish a balance entry with a manual bucket allocation
        self._entry(bank['id'], 5000, allocations=[{'bucket_id': bucket['id'], 'amount': 1000}])
        # Credit adds more money — the existing allocation should be preserved
        self._txn('credit', 500, to_id=bank['id'], counterparty='Bonus')
        # Fetch the new latest balance entry's allocations
        import sqlite3
        with sqlite3.connect(_DB_FILE.name) as conn:
            conn.row_factory = sqlite3.Row
            entry = conn.execute(
                "SELECT id FROM balance_entries WHERE account_id=? ORDER BY id DESC LIMIT 1",
                (bank['id'],)
            ).fetchone()
            alloc = conn.execute(
                "SELECT amount FROM bucket_allocations WHERE balance_entry_id=? AND bucket_id=?",
                (entry['id'], bucket['id'])
            ).fetchone()
        self.assertIsNotNone(alloc, 'Bucket allocation was lost after credit transaction')
        self.assertAlmostEqual(1000.0, float(alloc['amount']), places=4)

    def test_debit_transaction_carries_forward_manual_bucket_allocations(self):
        """Manual bucket allocations must survive a debit transaction when balance permits."""
        bank = self._bank()
        bucket = self._bucket('Vacation', target=3000.0)
        self._entry(bank['id'], 4000, allocations=[{'bucket_id': bucket['id'], 'amount': 500}])
        # Debit 1000 — new balance 3000 — 500 allocation still fits
        self._txn('debit', 1000, from_id=bank['id'], counterparty='Rent')
        import sqlite3
        with sqlite3.connect(_DB_FILE.name) as conn:
            conn.row_factory = sqlite3.Row
            entry = conn.execute(
                "SELECT id FROM balance_entries WHERE account_id=? ORDER BY id DESC LIMIT 1",
                (bank['id'],)
            ).fetchone()
            alloc = conn.execute(
                "SELECT amount FROM bucket_allocations WHERE balance_entry_id=? AND bucket_id=?",
                (entry['id'], bucket['id'])
            ).fetchone()
        self.assertIsNotNone(alloc, 'Bucket allocation was lost after debit transaction')
        self.assertAlmostEqual(500.0, float(alloc['amount']), places=4)

    def test_debit_transaction_scales_down_allocations_when_balance_too_low(self):
        """If new balance < total allocations after a debit, allocations are scaled proportionally."""
        bank = self._bank()
        b1 = self._bucket('Fund A', target=5000.0)
        b2 = self._bucket('Fund B', target=5000.0)
        # 1000 balance, 400 allocated to b1, 400 to b2 = 800 total
        self._entry(bank['id'], 1000, allocations=[
            {'bucket_id': b1['id'], 'amount': 400},
            {'bucket_id': b2['id'], 'amount': 400},
        ])
        # Debit 600 → new balance 400 → total alloc 800 > 400, must scale to 50 %
        self._txn('debit', 600, from_id=bank['id'], counterparty='Payment')
        import sqlite3
        with sqlite3.connect(_DB_FILE.name) as conn:
            conn.row_factory = sqlite3.Row
            entry = conn.execute(
                "SELECT id FROM balance_entries WHERE account_id=? ORDER BY id DESC LIMIT 1",
                (bank['id'],)
            ).fetchone()
            rows = conn.execute(
                "SELECT bucket_id, amount FROM bucket_allocations WHERE balance_entry_id=?",
                (entry['id'],)
            ).fetchall()
        total = sum(float(r['amount']) for r in rows)
        # Total allocations must not exceed the new balance of 400
        self.assertLessEqual(total, 400.0 + 1e-6)
        # Each individual allocation must be roughly halved
        for r in rows:
            self.assertAlmostEqual(200.0, float(r['amount']), delta=1.0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
