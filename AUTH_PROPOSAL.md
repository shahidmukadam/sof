# Authentication Implementation Proposal: State of Finance

## 1. Executive Summary

This proposal adds multi-user authentication to the State of Finance personal finance tracker running at localhost:5050. The implementation introduces Sign Up, Sign In, and Forgot Password (OTP-based) flows while preserving a **shared household data model** — all authenticated users (currently the owner and Fatima) see and operate on the same financial data. A `created_by` audit field will be added to accounts and balance entries so it's always clear who added what.

---

## 2. Current State

- Flask backend (`app.py`) with no authentication middleware
- Single-page frontend (`templates/index.html`) with Tailwind CSS dark theme
- SQLite database (`finance.db`) with no user table
- All data is globally accessible with no session or identity concept
- Running at `localhost:5050`

---

## 3. Goals & Non-Goals

**In Scope**
- Secure the app with email/password authentication
- Support multiple users sharing a single household dataset (no data siloing)
- OTP-based password reset via email
- `created_by` audit trail on accounts and balance entries
- Server-side session management via Flask

**Out of Scope (this iteration)**
- Role-based access control
- Family user type with Admin/Member sub-roles (→ Backlog)
- Email invitation system (→ Backlog)
- OAuth / social login
- Mobile app support

---

## 4. User Roles

### Phase 1–2: Current

| Role | Description |
|------|-------------|
| `standard` | Default for all users. Full read/write access to all shared household data. |

### Phase 3 (Backlog — do not implement yet)

| Role | Description |
|------|-------------|
| `family_admin` | Can manage members, invite by email, delete entries |
| `family_member` | Can view and add entries; cannot delete or manage users |

---

## 5. Auth Flow Descriptions

### 5.1 Sign Up
1. User navigates to `/auth/signup`
2. Submits: email, password, confirm password, display name (optional)
3. Backend validates:
   - Valid email format
   - Password ≥ 8 characters
   - Passwords match
   - Email not already registered (return 409 if duplicate)
4. Password hashed with `werkzeug.security.generate_password_hash` (pbkdf2:sha256)
5. User record inserted → `role = 'standard'`
6. Session created: `session['user_id']` set
7. Redirect to `/`

### 5.2 Sign In
1. User navigates to `/auth/login`
2. Submits: email + password
3. Backend fetches user by email, verifies with `check_password_hash`
4. On success → set `session['user_id']`, redirect to `/`
5. On failure → return 401, show generic error ("Invalid email or password")
   - No indication of whether email exists (prevents enumeration)

### 5.3 Forgot Password (OTP Flow)

```
[Step 1 — Request OTP]
  User enters email
    → Backend checks email exists (silently succeeds even if not, to prevent enumeration)
    → Generates 6-digit OTP via secrets.randbelow(1000000)
    → Stores SHA-256 hash of OTP in otp_tokens (expires in 10 min)
    → Sends plain OTP to user's email via Gmail SMTP
    → Frontend shows OTP input form

[Step 2 — Verify OTP]
  User enters 6-digit OTP
    → Backend finds unexpired, unused token matching email + hash(OTP)
    → Marks token used = 1
    → Stores reset_allowed = True in session (short-lived)
    → Frontend shows new password form

[Step 3 — Set New Password]
  User enters new password + confirm
    → Backend verifies session has reset_allowed flag
    → Validates passwords match and meet requirements
    → Updates users.password_hash
    → Clears all OTP tokens for that email
    → Clears reset_allowed from session
    → Redirects to /auth/login with success toast
```

---

## 6. Data Model Changes

### New Table: `users`

```sql
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT,
    role          TEXT    NOT NULL DEFAULT 'standard'
                  CHECK(role IN ('standard', 'family_admin', 'family_member')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### New Table: `otp_tokens`

```sql
CREATE TABLE otp_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL,
    otp_hash    TEXT    NOT NULL,   -- SHA-256 hash of the 6-digit code
    expires_at  TEXT    NOT NULL,   -- datetime string, 10 min from creation
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_otp_email ON otp_tokens (email);
```

### Existing Tables — Audit Columns

```sql
-- Add to accounts
ALTER TABLE accounts ADD COLUMN created_by INTEGER REFERENCES users(id);

-- Add to balance_entries
ALTER TABLE balance_entries ADD COLUMN created_by INTEGER REFERENCES users(id);
```

> `created_by` is nullable so existing rows remain valid after migration.

---

## 7. New API Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/auth/signup` | — | HTML page |
| `POST` | `/auth/signup` | `email`, `password`, `confirm_password`, `display_name?` | 302 → `/` or 400 JSON |
| `GET` | `/auth/login` | — | HTML page |
| `POST` | `/auth/login` | `email`, `password` | 302 → `/` or 401 JSON |
| `POST` | `/auth/logout` | — | 302 → `/auth/login` |
| `GET` | `/auth/forgot-password` | — | HTML page |
| `POST` | `/auth/forgot-password/request` | `email` | 200 `{ok: true}` |
| `POST` | `/auth/forgot-password/verify` | `email`, `otp_code` | 200 `{ok: true}` or 400 |
| `POST` | `/auth/forgot-password/reset` | `new_password`, `confirm_password` | 302 → `/auth/login` or 400 |

**All existing `/api/*` endpoints** gain a `@login_required` guard — return `401 {error: "Unauthenticated"}` if `session['user_id']` is absent.

**Write endpoints** (`POST`, `PATCH`, `DELETE`) will stamp `created_by = session['user_id']` on new records.

---

## 8. New UI Screens

All screens share the existing Tailwind dark theme (`bg-slate-900`, `text-slate-100`).

### 8.1 Sign Up (`/auth/signup`)
- Display name (optional text input)
- Email (type=email, required)
- Password (type=password, ≥ 8 chars)
- Confirm Password (type=password)
- "Create Account" submit button
- Inline mismatch error before submit
- Link → "Already have an account? Sign In"

### 8.2 Sign In (`/auth/login`)
- Email (type=email)
- Password (type=password)
- "Sign In" button
- Error banner on failed login (generic message)
- Link → "Forgot password?"
- Link → "Create an account"

### 8.3 Forgot Password (`/auth/forgot-password`)

Single page, three conditional steps (JS-driven transitions — no page reloads):

**Step 1 — Email**
- Email input + "Send Code" button
- On success: slide to Step 2

**Step 2 — Verify Code**
- Message: *"A 6-digit code was sent to [email]"*
- 6-digit OTP input (type=number, maxlength=6)
- "Verify" button
- "Resend Code" link (disabled for 60 s after send)
- On success: slide to Step 3

**Step 3 — New Password**
- New Password + Confirm Password inputs
- "Reset Password" button
- On success: redirect to Sign In with green toast: *"Password updated — please sign in"*

### 8.4 Main App Header (existing, modified)
- Add user avatar / display name pill (top-right)
- "Sign Out" button

### 8.5 Balance Entry & Account Creation (existing, modified)
- Show "Added by [display_name]" on hover/detail in history views

---

## 9. Security Considerations

### Password Hashing
```python
from werkzeug.security import generate_password_hash, check_password_hash

hash   = generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)
valid  = check_password_hash(hash, submitted_password)
```

### OTP Hashing
```python
import hashlib, secrets

raw_otp  = str(secrets.randbelow(1_000_000)).zfill(6)
otp_hash = hashlib.sha256(raw_otp.encode()).hexdigest()
```

### OTP Rules
- Expire after **10 minutes**
- Marked `used = 1` immediately on verification
- All prior OTPs for an email are purged when a new one is requested
- Max 3 OTP requests per email per 15 minutes (count rows in `otp_tokens`)

### Session Config
```python
app.config.update(
    SECRET_KEY                = os.environ['SECRET_KEY'],          # 32-byte random hex
    SESSION_COOKIE_HTTPONLY   = True,
    SESSION_COOKIE_SAMESITE   = 'Lax',
    PERMANENT_SESSION_LIFETIME = timedelta(days=7),
)
```

### Rate Limiting (flask-limiter)
- `POST /auth/login` → 5 attempts / IP / 5 min
- `POST /auth/forgot-password/request` → 3 requests / email / 15 min

### CSRF
- `flask-wtf` CSRFProtect on all forms
- JSON API endpoints check `Content-Type: application/json` + session

---

## 10. Email Delivery

Python `smtplib` with Gmail SMTP. Gmail requires an **App Password** (not your account password) when 2FA is on.

**Environment variables (`.env`):**
```
SECRET_KEY=<32-byte hex string>
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_USERNAME=your@gmail.com
MAIL_PASSWORD=your_gmail_app_password
MAIL_FROM=State of Finance <your@gmail.com>
```

**`utils/email.py`:**
```python
import smtplib, os
from email.mime.text import MIMEText

def send_otp_email(to_email: str, otp_code: str):
    body = (
        f"Your State of Finance password reset code is:\n\n"
        f"  {otp_code}\n\n"
        f"This code expires in 10 minutes. If you didn't request this, ignore this email."
    )
    msg = MIMEText(body)
    msg["Subject"] = "Password Reset Code — State of Finance"
    msg["From"]    = os.environ["MAIL_FROM"]
    msg["To"]      = to_email

    with smtplib.SMTP(os.environ["MAIL_HOST"], int(os.environ["MAIL_PORT"])) as smtp:
        smtp.ehlo()
        smtp.starttls()
        smtp.login(os.environ["MAIL_USERNAME"], os.environ["MAIL_PASSWORD"])
        smtp.sendmail(msg["From"], [to_email], msg.as_string())
```

---

## 11. Implementation Phases

### Phase 1 — Core Auth (Est. 3–4 days)
- [ ] Schema migration: `users` + `otp_tokens` tables, `created_by` columns
- [ ] `@login_required` decorator on all `/api/*` routes
- [ ] Signup and login endpoints + HTML screens
- [ ] Logout endpoint
- [ ] Flask session configuration
- [ ] Seed script (`seed_users.py`) to create owner + Fatima accounts
- [ ] App header: display name + sign-out button

### Phase 2 — Forgot Password & Hardening (Est. 2–3 days)
- [ ] OTP generation, hashing, and storage
- [ ] Gmail SMTP integration via `utils/email.py`
- [ ] Forgot Password 3-step UI flow
- [ ] OTP verify and password reset endpoints
- [ ] Rate limiting (`flask-limiter`)
- [ ] CSRF protection (`flask-wtf`)
- [ ] `.env` setup and `SECRET_KEY` from environment

### Phase 3 — Family User Type (Backlog)
- See Backlog section

---

## 12. Backlog Items

### BACKLOG-001 · Family User Type & Roles
**Priority:** Low | **Complexity:** Medium

Add a `family` account mode where one user acts as admin and can invite additional family members with restricted permissions.

**Schema additions:**
```sql
-- family_id groups users together
ALTER TABLE users ADD COLUMN family_id INTEGER REFERENCES families(id);

CREATE TABLE families (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Role behaviour:**
- `family_admin` — full permissions; can invite/remove members; can change member roles
- `family_member` — can view all data and add entries; cannot delete accounts/entries; cannot access user management panel

**`role` column CHECK update:**
```sql
CHECK(role IN ('standard', 'family_admin', 'family_member'))
```
*(Already included in the Phase 1 `users` schema above for forward compatibility.)*

---

### BACKLOG-002 · Email Invite System for Family Members
**Priority:** Low | **Complexity:** Low-Medium
**Depends on:** BACKLOG-001

Family Admin sends invite → signed token emailed → invitee signs up with locked email field → automatically joined to the family group.

```sql
CREATE TABLE invite_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    family_id  INTEGER NOT NULL REFERENCES families(id),
    token      TEXT    NOT NULL UNIQUE,   -- UUID
    expires_at TEXT    NOT NULL,          -- 48 hours
    accepted   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

## 13. Files to Create / Modify

### New Files
```
auth/
  __init__.py          Flask Blueprint registration
  routes.py            signup, login, logout, forgot-password endpoints

utils/
  __init__.py
  email.py             Gmail SMTP OTP delivery
  auth.py              login_required decorator, generate_otp, hash_otp

migrations/
  003_add_users_otp.sql        CREATE TABLE users, otp_tokens
  004_add_created_by.sql       ALTER TABLE accounts / balance_entries

seed_users.py           One-time script: creates owner + Fatima accounts
.env.example            Template for required environment variables
requirements_auth.txt   flask-session, flask-limiter, flask-wtf, python-dotenv
```

### Modified Files
```
app.py                  Register auth blueprint; load .env; session config
templates/index.html    Header: display name, sign-out button; created_by in history
templates/auth/
  login.html            Sign In screen
  signup.html           Sign Up screen
  forgot_password.html  3-step forgot password screen
static/app.js           Handle 401 → redirect to /auth/login; created_by display
```

---

*Proposal version 1.0 · 2026-03-27*
