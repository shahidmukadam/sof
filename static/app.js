const state = {
  session: null,
  accounts: [],
  buckets: [],
  bucketSummary: [],
  transactions: [],
  editingAccountId: null,
  editingBucketId: null,
  allocatingBucketId: null,
  manualAllocateContext: null,
  selectedScope: 'me',
  currency: 'AED',
  rates: { AED: 3.6725, INR: 83.5 },
  netWorthSummary: null,
  authTab: 'signin',
  otpPreview: null,
  otpTimer: null,
  txnType: 'credit',
};

const charts = {};
const fmtCache = {};

class ApiError extends Error {
  constructor(message, data, status) {
    super(message);
    this.data = data || {};
    this.status = status;
  }
}

function getFmt(currency) {
  if (!fmtCache[currency]) {
    fmtCache[currency] = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'INR' ? 0 : 2,
    });
  }
  return fmtCache[currency];
}

function money(v) {
  if (v === null || v === undefined) return '—';
  const converted = v * (state.rates[state.currency] || 1);
  return getFmt(state.currency).format(converted);
}

function moneyInputValue(v) {
  if (v === null || v === undefined) return '';
  const converted = v * (state.rates[state.currency] || 1);
  return Number(converted).toLocaleString('en-US', {
    minimumFractionDigits: state.currency === 'INR' ? 0 : 2,
    maximumFractionDigits: state.currency === 'INR' ? 0 : 2,
  });
}

function toUSD(v) {
  return v / (state.rates[state.currency] || 1);
}

function toUSDWithCurrency(v, currency) {
  if (!currency || currency === 'USD') return v;
  return v / (state.rates[currency] || 1);
}

function modalCurrencySymbol(currency) {
  return { AED: 'AED', INR: '₹', USD: '$' }[currency] || currency;
}

function currencySymbol() {
  return { AED: 'AED', INR: '₹' }[state.currency] || state.currency;
}

function typeLabel(t) {
  return {
    bank: 'Bank Account',
    loan: 'Loan Account',
    shares: 'Shares',
    investment_group: 'Investment Group',
  }[t] || t;
}

function dateStr(iso) {
  if (!iso) return '';
  const text = String(iso).replace(' ', 'T');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function nowLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    throw new ApiError(parsed?.error || parsed?.message || text, parsed || {}, res.status);
  }
  return res.json();
}

function bucketAllocationType(b) {
  return b?.allocation_type || 'manual';
}

function bucketTypeLabel(type) {
  if (type === 'mixed') return 'Mixed';
  return type === 'auto' ? 'Auto Allocate' : 'Manual Allocate';
}

function bucketTypeClass(type) {
  if (type === 'mixed') return 'bg-slate-500/20 text-slate-300';
  return type === 'auto'
    ? 'bg-indigo-500/15 text-indigo-300'
    : 'bg-amber-500/15 text-amber-300';
}

function isAllUsersView() {
  return state.selectedScope === 'all';
}

function requireSingleUserSelection(message = 'Switch to My Profile to edit data.') {
  if (isAllUsersView()) {
    alert(message);
    return false;
  }
  return true;
}

function withScopeQuery(path, extra = {}) {
  const params = new URLSearchParams();
  params.set('scope', state.selectedScope);
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, value);
    }
  });
  return `${path}?${params.toString()}`;
}

function formatUserBadgeLabel(count) {
  return count > 1 ? `${count} users` : '1 user';
}

function mergeAccountsForView(accounts) {
  if (!isAllUsersView()) return accounts;
  const groups = new Map();

  const pushUnique = (set, value) => {
    if (value !== null && value !== undefined && value !== '') set.add(String(value));
  };

  accounts.forEach(acc => {
    const key = `${acc.type}::${acc.name.trim().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: acc.name,
        type: acc.type,
        institution: acc.institution || '',
        user_name: acc.user_name,
        _merged_count: 1,
        _institutions: new Set(acc.institution ? [acc.institution] : []),
        interest_rate: acc.interest_rate,
        remaining_tenure: acc.remaining_tenure,
        monthly_emi: acc.monthly_emi || 0,
        remaining_principal: acc.remaining_principal || 0,
        stock_name: acc.stock_name || '',
        exchange: acc.exchange || '',
        stock_code: acc.stock_code || '',
        quantity: acc.quantity || 0,
        last_price: acc.last_price,
        last_price_currency: acc.last_price_currency || '',
        last_fetched: acc.last_fetched || null,
        _interest_rates: new Set(acc.interest_rate != null ? [String(acc.interest_rate)] : []),
        _tenures: new Set(acc.remaining_tenure != null ? [String(acc.remaining_tenure)] : []),
        _stock_names: new Set(acc.stock_name ? [acc.stock_name] : []),
        _exchanges: new Set(acc.exchange ? [acc.exchange] : []),
        _stock_codes: new Set(acc.stock_code ? [acc.stock_code] : []),
        _last_prices: new Set(acc.last_price != null ? [String(acc.last_price)] : []),
        _last_price_currencies: new Set(acc.last_price_currency ? [acc.last_price_currency] : []),
      });
      return;
    }

    const current = groups.get(key);
    current._merged_count += 1;
    pushUnique(current._institutions, acc.institution);
    pushUnique(current._interest_rates, acc.interest_rate != null ? acc.interest_rate : null);
    pushUnique(current._tenures, acc.remaining_tenure != null ? acc.remaining_tenure : null);
    pushUnique(current._stock_names, acc.stock_name);
    pushUnique(current._exchanges, acc.exchange);
    pushUnique(current._stock_codes, acc.stock_code);
    pushUnique(current._last_prices, acc.last_price != null ? acc.last_price : null);
    pushUnique(current._last_price_currencies, acc.last_price_currency);
    current.monthly_emi = (current.monthly_emi || 0) + (acc.monthly_emi || 0);
    current.remaining_principal = (current.remaining_principal || 0) + (acc.remaining_principal || 0);
    current.quantity = (current.quantity || 0) + (acc.quantity || 0);
    if (acc.last_fetched && (!current.last_fetched || acc.last_fetched > current.last_fetched)) {
      current.last_fetched = acc.last_fetched;
    }
  });

  return Array.from(groups.values()).map(acc => {
    const oneOrBlank = set => set.size === 1 ? Array.from(set)[0] : '';
    return {
      ...acc,
      institution: Array.from(acc._institutions).join(', '),
      user_name: formatUserBadgeLabel(acc._merged_count),
      interest_rate: oneOrBlank(acc._interest_rates),
      remaining_tenure: oneOrBlank(acc._tenures),
      stock_name: oneOrBlank(acc._stock_names) || (acc._stock_names.size > 1 ? 'Multiple holdings' : ''),
      exchange: oneOrBlank(acc._exchanges) || (acc._exchanges.size > 1 ? 'Multiple' : ''),
      stock_code: oneOrBlank(acc._stock_codes) || (acc._stock_codes.size > 1 ? 'Multiple' : ''),
      last_price: acc._last_prices.size === 1 ? Number(Array.from(acc._last_prices)[0]) : null,
      last_price_currency: oneOrBlank(acc._last_price_currencies),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeBucketsForView(buckets) {
  if (!isAllUsersView()) return buckets;
  const groups = new Map();

  buckets.forEach(bucket => {
    const key = bucket.name.trim().toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        id: `merged:${key}`,
        name: bucket.name,
        target: bucket.target || 0,
        color: bucket.color || '#6366f1',
        allocation_type: bucketAllocationType(bucket),
        sort_order: bucket.sort_order || 0,
        _merged_count: 1,
      });
      return;
    }

    const current = groups.get(key);
    current.target = (current.target || 0) + (bucket.target || 0);
    current.sort_order = Math.min(current.sort_order, bucket.sort_order || 0);
    current._merged_count += 1;
    if (current.allocation_type !== bucketAllocationType(bucket)) {
      current.allocation_type = 'mixed';
    }
  });

  return Array.from(groups.values()).sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.name.localeCompare(b.name);
  });
}

function getBucketSummaryForView(bucket) {
  if (!state.bucketSummary?.length || !bucket) return null;
  if (isAllUsersView()) {
    return state.bucketSummary.find(item => item.name.trim().toLowerCase() === bucket.name.trim().toLowerCase()) || null;
  }
  return state.bucketSummary.find(item => item.id === bucket.id) || null;
}

function getManualBuckets() {
  return state.buckets.filter(b => bucketAllocationType(b) === 'manual');
}

function getSelectedEntryAccount() {
  const accountId = parseInt(document.getElementById('entAccount')?.value);
  return state.accounts.find(a => a.id === accountId) || null;
}

function getEntryAllocatableBuckets() {
  const account = getSelectedEntryAccount();
  if (!account || account.type !== 'bank') return [];
  return getManualBuckets();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
  if (id === 'manualAllocateModal') {
    state.allocatingBucketId = null;
    state.manualAllocateContext = null;
    const amountInput = document.getElementById('manualAllocAmount');
    const errorEl = document.getElementById('manualAllocError');
    if (amountInput) amountInput.value = '';
    if (errorEl) errorEl.textContent = '';
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('hidden');
}

function switchTab(name) {
  ['dashboard', 'accounts', 'buckets', 'timeline', 'transactions'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== name);
    document.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === name);
  });
  if (name === 'timeline') loadTimeline();
  if (name === 'transactions') loadTransactions();
}

function setAppVisibility(isLoggedIn) {
  document.getElementById('authShell').classList.toggle('hidden', isLoggedIn);
  document.getElementById('appShell').classList.toggle('hidden', !isLoggedIn);
}

function updateSessionUi() {
  const label = document.getElementById('sessionUserName');
  if (!label) return;
  if (!state.session?.user) {
    label.textContent = '';
    return;
  }
  label.textContent = `${state.session.user.name} · ${state.session.user.email}`;
}

function updateReadOnlyUi() {
  const disabled = isAllUsersView();
  const toggleButton = (id, title) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = disabled;
    btn.classList.toggle('opacity-60', disabled);
    btn.classList.toggle('cursor-not-allowed', disabled);
    btn.title = disabled ? title : '';
  };

  toggleButton('mainAddEntryBtn', 'Switch to My Profile to create or edit data.');
  toggleButton('addAssetBtn', 'Switch to My Profile to create or edit data.');
  toggleButton('addBucketBtn', 'Switch to My Profile to create or edit data.');
  toggleButton('autoAllocateBtn', 'Switch to My Profile to create or edit data.');
  toggleButton('addTransactionBtn', 'Switch to My Profile to create or edit data.');
}

function clearAuthStatus() {
  const el = document.getElementById('authStatus');
  el.className = 'hidden rounded-xl border px-4 py-3 text-sm mb-5';
  el.textContent = '';
}

function setAuthStatus(message, type = 'info') {
  const el = document.getElementById('authStatus');
  const classes = {
    info: 'border-slate-600 bg-slate-700/60 text-slate-200',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    error: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  };
  el.className = `rounded-xl border px-4 py-3 text-sm mb-5 ${classes[type] || classes.info}`;
  el.textContent = message;
}

function switchAuthTab(tab) {
  state.authTab = tab;
  ['signin', 'signup', 'activate', 'forgot'].forEach(name => {
    document.getElementById(`authPanel-${name}`).classList.toggle('hidden', name !== tab);
    document.querySelector(`[data-auth-tab="${name}"]`).classList.toggle('active', name === tab);
  });
  clearAuthStatus();
}

function clearOtpPreview() {
  if (state.otpTimer) {
    clearInterval(state.otpTimer);
    state.otpTimer = null;
  }
  state.otpPreview = null;
  document.getElementById('localOtpPanel').classList.add('hidden');
  document.getElementById('localOtpEmpty').classList.remove('hidden');
}

function renderOtpPreview(delivery, title = '') {
  if (state.otpTimer) {
    clearInterval(state.otpTimer);
    state.otpTimer = null;
  }

  if (!delivery) {
    clearOtpPreview();
    return;
  }

  state.otpPreview = { ...delivery, title };
  document.getElementById('localOtpEmpty').classList.add('hidden');
  document.getElementById('localOtpPanel').classList.remove('hidden');
  document.getElementById('localOtpTitle').textContent = title || 'Latest OTP';
  document.getElementById('localOtpMeta').textContent = `${delivery.email} · expires ${dateStr(delivery.expires_at)}`;
  document.getElementById('localOtpCode').textContent = delivery.code || '------';

  const tick = () => {
    const resendAt = new Date(String(delivery.resend_allowed_at).replace(' ', 'T'));
    const expireAt = new Date(String(delivery.expires_at).replace(' ', 'T'));
    const now = new Date();
    const resendMs = resendAt.getTime() - now.getTime();
    const expireMs = expireAt.getTime() - now.getTime();
    const resendText = resendMs > 0
      ? `Resend available in ${Math.ceil(resendMs / 1000)}s`
      : 'You can request a new OTP now.';
    const expireText = expireMs > 0
      ? `Code expires in ${Math.ceil(expireMs / 60000)} min`
      : 'Code has expired.';
    document.getElementById('localOtpCountdown').textContent = `${resendText} ${expireText}`;
  };

  tick();
  state.otpTimer = setInterval(tick, 1000);
}

function revealOtpSection(sectionId, resendBtnId) {
  document.getElementById(sectionId).classList.remove('hidden');
  document.getElementById(resendBtnId).classList.remove('hidden');
}

function setSessionPayload(payload) {
  state.session = payload?.logged_in ? payload : null;
  state.selectedScope = 'me';
  document.getElementById('scopeSelect').value = state.selectedScope;
  updateSessionUi();
  updateReadOnlyUi();
}

async function loadActivationProfiles() {
  const rows = await api('/api/auth/available-profiles');
  const select = document.getElementById('activateProfileSelect');
  if (!rows.length) {
    select.innerHTML = '<option value="">No profiles available</option>';
    return;
  }
  select.innerHTML = [
    '<option value="">Select profile</option>',
    ...rows.map(row => `<option value="${row.id}">${row.name}</option>`),
  ].join('');
}

async function signIn() {
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    clearAuthStatus();
    const result = await api('/api/auth/signin', 'POST', { email, password });
    await handleAuthenticated(result);
  } catch (e) {
    setAuthStatus(e.message, 'error');
  }
}

async function startSignUp() {
  const name = document.getElementById('signUpName').value.trim();
  const email = document.getElementById('signUpEmail').value.trim();
  const password = document.getElementById('signUpPassword').value;
  try {
    clearAuthStatus();
    const result = await api('/api/auth/signup/start', 'POST', { name, email, password });
    revealOtpSection('signUpOtpSection', 'signUpResendBtn');
    renderOtpPreview(result.delivery, 'Sign up OTP');
    setAuthStatus('OTP created locally. Use the code from the local inbox to finish sign up.', 'success');
  } catch (e) {
    if (e.data?.delivery) {
      revealOtpSection('signUpOtpSection', 'signUpResendBtn');
      renderOtpPreview(e.data.delivery, 'Sign up OTP');
    }
    setAuthStatus(e.message, 'error');
  }
}

async function verifySignUp() {
  const email = document.getElementById('signUpEmail').value.trim();
  const code = document.getElementById('signUpCode').value.trim();
  try {
    clearAuthStatus();
    const result = await api('/api/auth/signup/verify', 'POST', { email, code });
    await handleAuthenticated(result);
  } catch (e) {
    setAuthStatus(e.message, 'error');
  }
}

async function startActivateExisting() {
  const user_id = parseInt(document.getElementById('activateProfileSelect').value);
  const email = document.getElementById('activateEmail').value.trim();
  const password = document.getElementById('activatePassword').value;
  try {
    clearAuthStatus();
    const result = await api('/api/auth/activate-existing/start', 'POST', { user_id, email, password });
    revealOtpSection('activateOtpSection', 'activateResendBtn');
    renderOtpPreview(result.delivery, `${result.profile_name} activation OTP`);
    setAuthStatus('OTP created locally. Use the code from the local inbox to activate this profile.', 'success');
  } catch (e) {
    if (e.data?.delivery) {
      revealOtpSection('activateOtpSection', 'activateResendBtn');
      renderOtpPreview(e.data.delivery, 'Profile activation OTP');
    }
    setAuthStatus(e.message, 'error');
  }
}

async function verifyActivateExisting() {
  const email = document.getElementById('activateEmail').value.trim();
  const code = document.getElementById('activateCode').value.trim();
  try {
    clearAuthStatus();
    const result = await api('/api/auth/activate-existing/verify', 'POST', { email, code });
    await handleAuthenticated(result);
  } catch (e) {
    setAuthStatus(e.message, 'error');
  }
}

async function startForgotPassword() {
  const email = document.getElementById('forgotEmail').value.trim();
  try {
    clearAuthStatus();
    const result = await api('/api/auth/forgot-password/start', 'POST', { email });
    revealOtpSection('forgotOtpSection', 'forgotResendBtn');
    renderOtpPreview(result.delivery, 'Password reset OTP');
    setAuthStatus('OTP created locally. Use the code from the local inbox to reset the password.', 'success');
  } catch (e) {
    if (e.data?.delivery) {
      revealOtpSection('forgotOtpSection', 'forgotResendBtn');
      renderOtpPreview(e.data.delivery, 'Password reset OTP');
    }
    setAuthStatus(e.message, 'error');
  }
}

async function verifyForgotPassword() {
  const email = document.getElementById('forgotEmail').value.trim();
  const code = document.getElementById('forgotCode').value.trim();
  const new_password = document.getElementById('forgotPassword').value;
  try {
    clearAuthStatus();
    await api('/api/auth/forgot-password/verify', 'POST', { email, code, new_password });
    switchAuthTab('signin');
    document.getElementById('signInEmail').value = email;
    document.getElementById('signInPassword').value = '';
    setAuthStatus('Password reset. Sign in with the new password.', 'success');
  } catch (e) {
    setAuthStatus(e.message, 'error');
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', 'POST');
  } catch {}

  state.session = null;
  state.accounts = [];
  state.buckets = [];
  state.bucketSummary = [];
  state.selectedScope = 'me';
  ['accountModal', 'bucketModal', 'entryModal', 'manualAllocateModal', 'historyModal'].forEach(closeModal);
  setAppVisibility(false);
  clearOtpPreview();
  updateSessionUi();
  await loadActivationProfiles();
  switchAuthTab('signin');
}

async function handleAuthenticated(sessionPayload) {
  setSessionPayload(sessionPayload);
  setAppVisibility(true);
  clearOtpPreview();
  updateCurrencyLabels();
  await fetchRates();
  updateCurrencyLabels();
  await Promise.all([loadAccounts(), loadBuckets()]);
  await loadDashboard();
  if (!document.getElementById('tab-timeline').classList.contains('hidden')) {
    await loadTimeline();
  }
  _maybeStartOnboarding();
}

async function checkSession() {
  const payload = await api('/api/auth/session');
  if (payload.logged_in) {
    await handleAuthenticated(payload);
  } else {
    setAppVisibility(false);
    await loadActivationProfiles();
    switchAuthTab('signin');
  }
}

async function onScopeChange() {
  state.selectedScope = document.getElementById('scopeSelect').value;
  updateReadOnlyUi();
  ['accountModal', 'bucketModal', 'entryModal', 'manualAllocateModal', 'historyModal'].forEach(closeModal);
  await Promise.all([loadAccounts(), loadBuckets()]);
  await loadDashboard();
  if (!document.getElementById('tab-timeline').classList.contains('hidden')) {
    await loadTimeline();
  }
}

async function loadDashboard() {
  const [nw, buckets, recent] = await Promise.all([
    api(withScopeQuery('/api/summary/net-worth')),
    api(withScopeQuery('/api/summary/buckets')),
    api(withScopeQuery('/api/balances')),
  ]);
  state.netWorthSummary = nw;
  state.bucketSummary = buckets;

  document.getElementById('netWorthTotal').textContent = money(nw.total);
  document.getElementById('unallocatedCashTotal').textContent = money(nw.unallocated_cash || 0);

  const typeTextColors = {
    bank: 'text-emerald-400',
    loan: 'text-orange-400',
    shares: 'text-indigo-400',
    investment_group: 'text-blue-400',
  };
  const breakdown = document.getElementById('byTypeBreakdown');
  breakdown.innerHTML = Object.entries(nw.by_type).map(([type, amt]) => `
    <div class="bg-slate-700/50 rounded-lg p-3">
      <p class="text-xs text-slate-400">${typeLabel(type)}</p>
      <p class="text-lg font-semibold ${typeTextColors[type] || 'text-slate-300'}">${money(amt)}</p>
    </div>
  `).join('');

  if (Object.keys(nw.by_type).length) {
    const colorMap = { bank: '#10b981', loan: '#f97316', shares: '#6366f1', investment_group: '#3b82f6' };
    const colors = Object.keys(nw.by_type).map(t => colorMap[t] || '#6366f1');
    drawDonut('donutChart', Object.values(nw.by_type), Object.keys(nw.by_type).map(t => typeLabel(t)), colors);
  }

  const bucketDiv = document.getElementById('bucketSummary');
  const bucketEmpty = document.getElementById('bucketEmpty');
  if (!buckets.length) {
    bucketDiv.innerHTML = '';
    bucketEmpty.classList.remove('hidden');
  } else {
    bucketEmpty.classList.add('hidden');
    bucketDiv.innerHTML = buckets.map(b => {
      const pct = b.target ? Math.min(100, (b.allocated / b.target) * 100) : null;
      const status = pct === null ? 'text-slate-400' : pct >= 100 ? 'text-emerald-400' : pct >= 50 ? 'text-amber-400' : 'text-rose-400';
      return `
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm flex items-center gap-2">
              <span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${b.color}"></span>
              ${b.name}
              <span class="text-[11px] px-2 py-0.5 rounded-full ${bucketTypeClass(bucketAllocationType(b))}">${bucketTypeLabel(bucketAllocationType(b))}</span>
            </span>
            <span class="text-sm ${status}">
              ${money(b.allocated)}${b.target ? ` / ${money(b.target)}` : ''}
            </span>
          </div>
          ${b.target ? `
          <div class="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div class="h-full rounded-full progress-bar" style="width:${pct}%;background:${b.color}"></div>
          </div>` : ''}
        </div>
      `;
    }).join('');
  }

  const recentDiv = document.getElementById('recentEntries');
  const recentEmpty = document.getElementById('recentEmpty');
  const top = recent.slice(0, 8);
  if (!top.length) {
    recentDiv.innerHTML = '';
    recentEmpty.classList.remove('hidden');
  } else {
    recentEmpty.classList.add('hidden');
    recentDiv.innerHTML = top.map(e => `
      <div class="flex items-center justify-between py-2 border-b border-slate-700 last:border-0">
        <div>
          <span class="text-sm font-medium">${isAllUsersView() && e.user_name ? `${e.user_name} · ${e.account_name}` : e.account_name}</span>
          ${e.note ? `<span class="text-xs text-slate-400 ml-2">${e.note}</span>` : ''}
        </div>
        <div class="text-right">
          <span class="text-sm font-semibold">${money(e.amount)}</span>
          <span class="text-xs text-slate-400 ml-2">${dateStr(e.recorded_at)}</span>
        </div>
      </div>
    `).join('');
  }

  document.getElementById('lastUpdated').textContent = recent.length
    ? `Last updated: ${dateStr(recent[0].recorded_at)}`
    : '';

  renderBuckets();
}

function drawDonut(canvasId, data, labels, colors) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.label}: ${money(ctx.raw)}` },
        },
      },
      cutout: '65%',
    },
  });
}

async function loadAccounts() {
  const rows = await api(withScopeQuery('/api/accounts'));
  state.accounts = mergeAccountsForView(rows);
  renderAccounts();
}

function renderAccounts() {
  const list = document.getElementById('accountsList');
  const empty = document.getElementById('accountsEmpty');
  const readOnly = isAllUsersView();
  if (!state.accounts.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const typeColors = {
    bank: 'bg-emerald-500/20 text-emerald-400',
    loan: 'bg-orange-500/20 text-orange-400',
    shares: 'bg-indigo-500/20 text-indigo-400',
    investment_group: 'bg-blue-500/20 text-blue-400',
  };
  list.innerHTML = state.accounts.map(a => {
    const isLoan = a.type === 'loan';
    const isShares = a.type === 'shares';
    const metaLine = readOnly
      ? [
          a.institution || (isShares && a.stock_name ? a.stock_name : ''),
          a.user_name ? `Merged across ${a.user_name}` : '',
        ].filter(Boolean).join(' · ')
      : (a.institution || (isShares && a.stock_name ? a.stock_name : ''));

    const loanMeta = isLoan ? `
      <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>Rate: <span class="text-orange-300">${a.interest_rate ?? '—'}% p.a.</span></span>
        <span>Tenure: <span class="text-orange-300">${a.remaining_tenure ?? '—'} mo</span></span>
        <span>EMI: <span class="text-orange-300">${a.monthly_emi != null ? money(a.monthly_emi) : '—'}</span></span>
        <span>Principal: <span class="text-orange-300">${a.remaining_principal != null ? money(a.remaining_principal) : '—'}</span></span>
      </div>` : '';

    const sharesMeta = isShares ? `
      <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>Exchange: <span class="text-indigo-300">${a.exchange || '—'}</span></span>
        <span>Ticker: <span class="text-indigo-300">${a.stock_code || '—'}</span></span>
        <span>Qty: <span class="text-indigo-300">${a.quantity != null ? Number(a.quantity).toLocaleString() : '—'} shares</span></span>
        <span>Price: <span class="text-indigo-300">${a.last_price != null
          ? `${a.last_price_currency} ${Number(a.last_price).toLocaleString(undefined, { maximumFractionDigits: 4 })}`
          : 'Not fetched yet'}</span></span>
        ${a.last_fetched ? `<span class="col-span-2 text-slate-500">Updated: ${dateStr(a.last_fetched)}</span>` : ''}
      </div>` : '';

    const cardBorder = isLoan ? 'border border-orange-500/20' : isShares ? 'border border-indigo-500/20' : '';
    return `
      <div class="bg-slate-800 rounded-xl px-5 py-4 ${cardBorder}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div>
              <p class="font-medium">${a.name}</p>
              <p class="text-xs text-slate-400">${metaLine}</p>
            </div>
            <span class="text-xs px-2 py-0.5 rounded-full ${typeColors[a.type] || 'bg-slate-500/20 text-slate-400'}">${typeLabel(a.type)}</span>
          </div>
          ${readOnly ? `
          <div class="text-xs text-slate-500 px-3 py-1.5 rounded-lg bg-slate-900/40 border border-slate-700/70">View only</div>` : `
          <div class="flex items-center gap-2">
            <button onclick="viewHistory(${a.id}, '${a.name.replace(/'/g, "\\'")}')" class="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">History</button>
            ${isShares ? `<button data-refresh="${a.id}" onclick="refreshPrice(${a.id})" class="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">↻ Price</button>` : ''}
            ${(!isLoan && !isShares) ? `<button onclick="openAddEntry(${a.id})" class="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">+ Entry</button>` : ''}
            <button onclick="openAccountModal(${a.id})" class="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Edit</button>
            <button onclick="deleteAccount(${a.id})" class="text-xs text-rose-400 hover:text-rose-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Delete</button>
          </div>`}
        </div>
        ${loanMeta}${sharesMeta}
      </div>
    `;
  }).join('');
}

function onAccTypeChange() {
  const type = document.getElementById('accType').value;
  document.getElementById('loanFields').classList.toggle('hidden', type !== 'loan');
  document.getElementById('shareFields').classList.toggle('hidden', type !== 'shares');
}

function openAccountModal(id = null) {
  if (!requireSingleUserSelection()) return;
  state.editingAccountId = id;
  document.getElementById('accountModalTitle').textContent = id ? 'Edit Asset' : 'Add Asset';
  if (id) {
    const acc = state.accounts.find(a => a.id === id);
    if (!acc) return;
    document.getElementById('accName').value = acc.name;
    document.getElementById('accType').value = acc.type;
    document.getElementById('accInstitution').value = acc.institution || '';
    const isLoan = acc.type === 'loan';
    const isShares = acc.type === 'shares';
    document.getElementById('loanFields').classList.toggle('hidden', !isLoan);
    document.getElementById('shareFields').classList.toggle('hidden', !isShares);
    if (isLoan) {
      document.getElementById('loanRate').value = acc.interest_rate ?? '';
      document.getElementById('loanTenure').value = acc.remaining_tenure ?? '';
      const loanCurrSel = document.getElementById('loanAmountCurrency');
      if (loanCurrSel) loanCurrSel.value = state.currency;
      const rate = state.rates[state.currency] || 1;
      document.getElementById('loanEMI').value = acc.monthly_emi ? (acc.monthly_emi * rate).toFixed(2) : '';
      document.getElementById('loanPrincipal').value = acc.remaining_principal ? (acc.remaining_principal * rate).toFixed(2) : '';
    }
    if (isShares) {
      document.getElementById('shareStockName').value = acc.stock_name || '';
      document.getElementById('shareExchange').value = acc.exchange || 'DFM';
      document.getElementById('shareStockCode').value = acc.stock_code || '';
      document.getElementById('shareQty').value = acc.quantity ?? '';
    }
  } else {
    document.getElementById('accName').value = '';
    document.getElementById('accType').value = 'bank';
    document.getElementById('accInstitution').value = '';
    document.getElementById('loanFields').classList.add('hidden');
    document.getElementById('shareFields').classList.add('hidden');
    ['loanRate', 'loanTenure', 'loanEMI', 'loanPrincipal', 'shareStockName', 'shareStockCode', 'shareQty'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('shareExchange').value = 'DFM';
    const loanCurrSel = document.getElementById('loanAmountCurrency');
    if (loanCurrSel) loanCurrSel.value = state.currency;
  }
  updateCurrencyLabels();
  openModal('accountModal');
  setTimeout(() => document.getElementById('accName').focus(), 50);
}

async function saveAccount() {
  if (!requireSingleUserSelection()) return;
  const name = document.getElementById('accName').value.trim();
  const type = document.getElementById('accType').value;
  const institution = document.getElementById('accInstitution').value.trim();
  if (!name) return;

  const payload = { name, type, institution };
  if (type === 'loan') {
    const loanCurrency = document.getElementById('loanAmountCurrency')?.value || state.currency;
    payload.interest_rate = parseFloat(document.getElementById('loanRate').value) || 0;
    payload.remaining_tenure = parseInt(document.getElementById('loanTenure').value) || 0;
    payload.monthly_emi = toUSDWithCurrency(parseFloat(document.getElementById('loanEMI').value) || 0, loanCurrency);
    payload.remaining_principal = toUSDWithCurrency(parseFloat(document.getElementById('loanPrincipal').value) || 0, loanCurrency);
  }
  if (type === 'shares') {
    payload.stock_name = document.getElementById('shareStockName').value.trim();
    payload.exchange = document.getElementById('shareExchange').value;
    payload.stock_code = document.getElementById('shareStockCode').value.trim().toUpperCase();
    payload.quantity = parseFloat(document.getElementById('shareQty').value) || 0;
  }

  let result;
  if (state.editingAccountId) {
    result = await api(`/api/accounts/${state.editingAccountId}`, 'PATCH', payload);
  } else {
    result = await api('/api/accounts', 'POST', payload);
  }
  closeModal('accountModal');
  if (result._price_fetch?.error) {
    alert(`Asset saved, but stock price could not be fetched:\n${result._price_fetch.error}\n\nUse ↻ Refresh to retry.`);
  }
  await loadAccounts();
  await loadDashboard();
}

async function refreshPrice(accountId) {
  const btn = document.querySelector(`[data-refresh="${accountId}"]`);
  if (btn) {
    btn.textContent = '…';
    btn.disabled = true;
  }
  try {
    const res = await api(`/api/accounts/${accountId}/refresh-price`, 'POST');
    if (!res.ok) throw new Error(res.error || 'Unknown error');
    await loadAccounts();
    await loadDashboard();
  } catch (e) {
    alert(`Price refresh failed:\n${e.message}`);
    if (btn) {
      btn.textContent = '↻ Price';
      btn.disabled = false;
    }
  }
}

async function deleteAccount(id) {
  if (!requireSingleUserSelection()) return;
  if (!confirm('Remove this asset?')) return;
  await api(`/api/accounts/${id}`, 'DELETE');
  await loadAccounts();
  await loadDashboard();
}

async function viewHistory(accountId, name) {
  if (!requireSingleUserSelection('Switch to My Profile to view account history.')) return;
  const entries = await api(withScopeQuery('/api/balances', { account_id: accountId }));
  document.getElementById('historyModalTitle').textContent = `${name} — History`;
  const list = document.getElementById('historyList');
  if (!entries.length) {
    list.innerHTML = '<p class="text-slate-500 text-sm">No entries yet.</p>';
  } else {
    list.innerHTML = entries.map(e => `
      <div class="flex items-center justify-between py-3 border-b border-slate-700 last:border-0">
        <div>
          <p class="text-sm font-semibold">${money(e.amount)}</p>
          ${e.note ? `<p class="text-xs text-slate-400">${e.note}</p>` : ''}
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-slate-400">${dateStr(e.recorded_at)}</span>
          <button onclick="deleteEntry(${e.id})" class="text-rose-400 hover:text-rose-300 text-xs">Delete</button>
        </div>
      </div>
    `).join('');
  }
  openModal('historyModal');
}

async function deleteEntry(id) {
  if (!requireSingleUserSelection()) return;
  if (!confirm('Delete this entry?')) return;
  await api(`/api/balances/${id}`, 'DELETE');
  closeModal('historyModal');
  await loadDashboard();
}

async function loadBuckets() {
  const rows = await api(withScopeQuery('/api/buckets'));
  state.buckets = mergeBucketsForView(rows);
  renderBuckets();
}

function renderBuckets() {
  const list = document.getElementById('bucketsList');
  const empty = document.getElementById('bucketsEmpty');
  const readOnly = isAllUsersView();
  if (!state.buckets.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = state.buckets.map(b => {
    const summary = getBucketSummaryForView(b);
    const allocated = summary?.allocated ?? 0;
    const target = summary?.target ?? b.target ?? 0;
    const pct = target ? Math.min(100, (allocated / target) * 100) : null;
    const mergedLabel = readOnly && b._merged_count ? `Merged across ${formatUserBadgeLabel(b._merged_count)}` : '';
    return `
      <div class="bg-slate-800 rounded-xl px-5 py-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <span class="inline-block w-3 h-3 rounded-full" style="background:${b.color}"></span>
            <div>
              <p class="font-medium flex items-center gap-2">
                <span>${b.name}</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full ${bucketTypeClass(bucketAllocationType(b))}">${bucketTypeLabel(bucketAllocationType(b))}</span>
              </p>
              <p class="text-xs text-slate-400">
                ${target ? `Allocated ${money(allocated)} of ${money(target)}` : `Allocated ${money(allocated)}`}
                ${mergedLabel ? ` · ${mergedLabel}` : ''}
              </p>
            </div>
          </div>
          ${readOnly ? `
          <div class="text-xs text-slate-500 px-3 py-1.5 rounded-lg bg-slate-900/40 border border-slate-700/70">View only</div>` : `
          <div class="flex items-center gap-2">
            <button onclick="openBucketAllocate(${b.id})" class="text-xs text-emerald-400 hover:text-emerald-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Allocate</button>
            <button onclick="openBucketModal(${b.id})" class="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Edit</button>
            <button onclick="deleteBucket(${b.id})" class="text-xs text-rose-400 hover:text-rose-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Delete</button>
          </div>`}
        </div>
        ${pct !== null ? `
        <div class="mt-3 h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div class="h-full rounded-full progress-bar" style="width:${pct}%;background:${b.color}"></div>
        </div>` : ''}
      </div>
    `;
  }).join('');
}

function openBucketModal(id = null) {
  if (!requireSingleUserSelection()) return;
  state.editingBucketId = id;
  document.getElementById('bucketModalTitle').textContent = id ? 'Edit Bucket' : 'Add Bucket';
  if (id) {
    const b = state.buckets.find(x => x.id === id);
    if (!b) return;
    document.getElementById('bktName').value = b.name;
    document.getElementById('bktTarget').value = b.target ? (b.target * (state.rates[state.currency] || 1)).toFixed(2) : '';
    document.getElementById('bktColor').value = b.color || '#6366f1';
    document.getElementById('bktAllocationType').value = bucketAllocationType(b);
  } else {
    document.getElementById('bktName').value = '';
    document.getElementById('bktTarget').value = '';
    document.getElementById('bktColor').value = '#6366f1';
    document.getElementById('bktAllocationType').value = 'manual';
  }
  updateCurrencyLabels();
  openModal('bucketModal');
  setTimeout(() => document.getElementById('bktName').focus(), 50);
}

async function saveBucket() {
  if (!requireSingleUserSelection()) return;
  const name = document.getElementById('bktName').value.trim();
  const rawTarget = parseFloat(document.getElementById('bktTarget').value) || null;
  const target = rawTarget ? toUSD(rawTarget) : null;
  const color = document.getElementById('bktColor').value;
  const allocation_type = document.getElementById('bktAllocationType').value;
  if (!name) return;
  if (state.editingBucketId) {
    await api(`/api/buckets/${state.editingBucketId}`, 'PATCH', { name, target, color, allocation_type });
  } else {
    await api('/api/buckets', 'POST', { name, target, color, allocation_type });
  }
  closeModal('bucketModal');
  await loadBuckets();
  await loadDashboard();
}

async function deleteBucket(id) {
  if (!requireSingleUserSelection()) return;
  if (!confirm('Delete this bucket?')) return;
  await api(`/api/buckets/${id}`, 'DELETE');
  await loadBuckets();
  await loadDashboard();
}

async function autoAllocateBuckets() {
  if (!requireSingleUserSelection()) return;
  const autoBuckets = state.buckets.filter(b => bucketAllocationType(b) === 'auto');
  if (!autoBuckets.length) {
    alert('No auto-allocate buckets found.\nEdit a bucket and switch its Allocate Type to Auto Allocate first.');
    return;
  }

  const btn = document.querySelector('[data-auto-allocate-btn]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Allocating...';
  }

  try {
    const result = await api('/api/buckets/auto-allocate', 'POST');
    await loadBuckets();
    await loadDashboard();

    const fullyFunded = result.buckets.filter(b => b.fulfilled).length;
    const partiallyFunded = result.buckets.filter(b => !b.fulfilled && b.allocated > 0).length;
    const unfunded = result.buckets.filter(b => b.allocated <= 0).length;
    const lines = [
      'Auto allocation updated.',
      `Allocated ${money(result.auto_allocated_total)} from bank accounts.`,
      `${fullyFunded} bucket(s) fully funded${partiallyFunded ? `, ${partiallyFunded} partially funded` : ''}${unfunded ? `, ${unfunded} not funded` : ''}.`,
    ];
    if (result.shortage > 0) lines.push(`Shortfall: ${money(result.shortage)}.`);
    if (result.skipped_buckets.length) lines.push(`Skipped (no target): ${result.skipped_buckets.join(', ')}.`);
    alert(lines.join('\n'));
  } catch (e) {
    alert(`Auto allocation failed:\n${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Allocate';
    }
  }
}

async function openBucketAllocate(id) {
  if (!requireSingleUserSelection('Switch to My Profile to allocate bucket funds.')) return;
  const bucket = state.buckets.find(x => x.id === id);
  if (!bucket) return;

  if (bucketAllocationType(bucket) === 'auto') {
    await autoAllocateBuckets();
    return;
  }

  const [nw, summary] = await Promise.all([
    api(withScopeQuery('/api/summary/net-worth')),
    api(withScopeQuery('/api/summary/buckets')),
  ]);
  state.netWorthSummary = nw;
  state.bucketSummary = summary;
  state.allocatingBucketId = id;
  state.manualAllocateContext = {
    unallocated_cash: nw.unallocated_cash || 0,
    current_allocated: summary.find(x => x.id === id)?.allocated || 0,
  };

  renderManualAllocateModal(true);
  openModal('manualAllocateModal');
  setTimeout(() => document.getElementById('manualAllocAmount').focus(), 50);
}

function renderManualAllocateModal(resetAmount = false) {
  const bucket = state.buckets.find(x => x.id === state.allocatingBucketId);
  const context = state.manualAllocateContext;
  if (!bucket || !context) return;

  document.getElementById('manualAllocateModalTitle').textContent = `Allocate to ${bucket.name}`;
  document.getElementById('manualAllocCurrentHint').textContent = `Currently allocated: ${money(context.current_allocated)}.`;
  document.getElementById('manualAllocAvailable').value = moneyInputValue(context.unallocated_cash);

  const amountInput = document.getElementById('manualAllocAmount');
  const maxDisplay = (context.unallocated_cash || 0) * (state.rates[state.currency] || 1);
  amountInput.max = maxDisplay.toFixed(2);
  if (resetAmount) amountInput.value = '';

  updateManualAllocateValidation();
}

function updateManualAllocateValidation() {
  const amountInput = document.getElementById('manualAllocAmount');
  const saveBtn = document.getElementById('manualAllocSaveBtn');
  const errorEl = document.getElementById('manualAllocError');
  if (!amountInput || !saveBtn || !errorEl) return;

  const availableUsd = state.manualAllocateContext?.unallocated_cash || 0;
  const availableDisplay = availableUsd * (state.rates[state.currency] || 1);
  const rawAmount = parseFloat(amountInput.value);

  let error = '';
  if (!state.allocatingBucketId) {
    error = 'No bucket selected.';
  } else if (availableDisplay <= 0) {
    error = 'No unallocated fund is available right now.';
  } else if (amountInput.value && rawAmount <= 0) {
    error = 'Enter an amount greater than zero.';
  } else if (!Number.isNaN(rawAmount) && rawAmount - availableDisplay > 1e-9) {
    error = 'Allocation amount cannot exceed the current unallocated fund.';
  }

  errorEl.textContent = error;
  saveBtn.disabled = !!error || !amountInput.value;
  saveBtn.classList.toggle('opacity-60', saveBtn.disabled);
  saveBtn.classList.toggle('cursor-not-allowed', saveBtn.disabled);
}

async function saveManualBucketAllocation() {
  const bucketId = state.allocatingBucketId;
  const rawAmount = parseFloat(document.getElementById('manualAllocAmount').value);
  if (!bucketId || Number.isNaN(rawAmount) || rawAmount <= 0) return;

  const availableDisplay = (state.manualAllocateContext?.unallocated_cash || 0) * (state.rates[state.currency] || 1);
  if (rawAmount - availableDisplay > 1e-9) {
    updateManualAllocateValidation();
    return;
  }

  const btn = document.getElementById('manualAllocSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Allocating...';

  try {
    await api(`/api/buckets/${bucketId}/allocate`, 'POST', { amount: toUSD(rawAmount) });
    closeModal('manualAllocateModal');
    await loadDashboard();
  } catch (e) {
    alert(`Manual allocation failed:\n${e.message}`);
  } finally {
    btn.textContent = 'Allocate';
    if (state.allocatingBucketId) {
      updateManualAllocateValidation();
    } else {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  }
}

function openAddEntry(accountId = null) {
  if (!requireSingleUserSelection()) return;
  const sel = document.getElementById('entAccount');
  const manualAssets = state.accounts.filter(a => a.type !== 'loan' && a.type !== 'shares');
  sel.innerHTML = manualAssets.map(a => `<option value="${a.id}" ${a.id == accountId ? 'selected' : ''}>${a.name} (${typeLabel(a.type)})</option>`).join('');
  if (!manualAssets.length) {
    alert('Add a Bank Account or Investment Group asset first.\n(Shares are tracked automatically via price refresh.)');
    switchTab('accounts');
    return;
  }

  document.getElementById('entAmount').value = '';
  document.getElementById('entDate').value = nowLocal();
  document.getElementById('entNote').value = '';
  document.getElementById('allocRemaining').textContent = '';
  const entCurrSel = document.getElementById('entAmountCurrency');
  if (entCurrSel) entCurrSel.value = state.currency;
  onEntryAccountChange();
  openModal('entryModal');
  setTimeout(() => document.getElementById('entAmount').focus(), 50);
}

function onEntryAccountChange() {
  const allocSection = document.getElementById('allocSection');
  const allocRows = document.getElementById('allocRows');
  const manualBuckets = getEntryAllocatableBuckets();
  const selectedAccount = getSelectedEntryAccount();
  const existingValues = Object.fromEntries(
    Array.from(allocRows.querySelectorAll('input[id^="alloc_"]')).map(input => [input.id.replace('alloc_', ''), input.value])
  );

  document.getElementById('allocRemaining').textContent = '';

  if (!selectedAccount || selectedAccount.type !== 'bank') {
    allocSection.classList.add('hidden');
    allocRows.innerHTML = '';
    return;
  }

  allocSection.classList.remove('hidden');
  if (!manualBuckets.length) {
    allocRows.innerHTML = '<p class="text-xs text-slate-500">No manual-allocate buckets yet.</p>';
    return;
  }

  const modalCur = document.getElementById('entAmountCurrency')?.value || state.currency;
  const sym = modalCurrencySymbol(modalCur);
  allocRows.innerHTML = manualBuckets.map(b => `
    <div class="flex items-center gap-2">
      <span class="inline-block w-2 h-2 rounded-full" style="background:${b.color}"></span>
      <span class="text-sm flex-1">${b.name}</span>
      <div class="relative">
        <span class="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">${sym}</span>
        <input type="number" step="0.01" placeholder="0.00"
          id="alloc_${b.id}"
          value="${existingValues[b.id] || ''}"
          oninput="updateAllocRemaining()"
          class="w-32 bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500" />
      </div>
    </div>
  `).join('');
}

function updateAllocRemaining() {
  const total = parseFloat(document.getElementById('entAmount').value) || 0;
  const allocated = getEntryAllocatableBuckets().reduce((sum, b) => sum + (parseFloat(document.getElementById(`alloc_${b.id}`)?.value) || 0), 0);
  const remaining = total - allocated;
  const el = document.getElementById('allocRemaining');
  if (total === 0) {
    el.textContent = '';
    return;
  }
  const entCur = document.getElementById('entAmountCurrency')?.value || state.currency;
  el.textContent = `${getFmt(entCur).format(remaining)} unallocated`;
  el.className = `text-xs ${Math.abs(remaining) < 0.01 ? 'text-emerald-400' : 'text-amber-400'}`;
}

async function saveEntry() {
  if (!requireSingleUserSelection()) return;
  const account_id = parseInt(document.getElementById('entAccount').value);
  const rawAmount = parseFloat(document.getElementById('entAmount').value);
  if (!account_id || Number.isNaN(rawAmount)) return;

  const entryCurrency = document.getElementById('entAmountCurrency')?.value || state.currency;
  const amount = toUSDWithCurrency(rawAmount, entryCurrency);
  const recorded_at = document.getElementById('entDate').value;
  const note = document.getElementById('entNote').value.trim();
  const allocations = getEntryAllocatableBuckets()
    .map(b => ({
      bucket_id: b.id,
      amount: toUSDWithCurrency(parseFloat(document.getElementById(`alloc_${b.id}`)?.value) || 0, entryCurrency),
    }))
    .filter(a => a.amount > 0);

  await api('/api/balances', 'POST', { account_id, amount, recorded_at, note, allocations });
  closeModal('entryModal');
  await loadDashboard();
}

async function loadTimeline() {
  const interval = document.getElementById('tlInterval').value;
  const from = document.getElementById('tlFrom').value;
  const to = document.getElementById('tlTo').value;

  const data = await api(withScopeQuery('/api/summary/timeline', { interval, from, to }));
  const empty = document.getElementById('tlEmpty');
  if (!data.labels.length) {
    empty.classList.remove('hidden');
    if (charts.timelineChart) {
      charts.timelineChart.destroy();
      delete charts.timelineChart;
    }
    return;
  }
  empty.classList.add('hidden');

  const accountColors = ['#6366f1', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4', '#84cc16'];
  const datasets = data.datasets.map((ds, i) => ({
    label: ds.name,
    data: ds.data,
    borderColor: accountColors[i % accountColors.length],
    backgroundColor: `${accountColors[i % accountColors.length]}20`,
    tension: 0.3,
    fill: false,
    pointRadius: data.labels.length < 20 ? 4 : 2,
    borderWidth: 2,
  }));

  datasets.push({
    label: 'Net Worth',
    data: data.net_worth,
    borderColor: '#ffffff',
    backgroundColor: '#ffffff10',
    tension: 0.3,
    fill: false,
    borderWidth: 3,
    pointRadius: data.labels.length < 20 ? 5 : 2,
    borderDash: [],
  });

  const ctx = document.getElementById('timelineChart').getContext('2d');
  if (charts.timelineChart) charts.timelineChart.destroy();
  charts.timelineChart = new Chart(ctx, {
    type: 'line',
    data: { labels: data.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#94a3b8', boxWidth: 12, padding: 16 },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${money(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
        y: {
          ticks: {
            color: '#64748b',
            callback: v => {
              if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(0) + 'k';
              return '$' + v;
            },
          },
          grid: { color: '#1e293b' },
        },
      },
    },
  });
}

function clearTimelineFilters() {
  document.getElementById('tlFrom').value = '';
  document.getElementById('tlTo').value = '';
  document.getElementById('tlInterval').value = 'month';
  loadTimeline();
}

async function fetchRates() {
  try {
    const data = await api('/api/rates');
    state.rates = data.rates;
    const rate = data.rates[state.currency];
    const symbols = { AED: 'د.إ', INR: '₹' };
    const label = document.getElementById('rateLabel');
    if (data.date) {
      label.textContent = `1 USD = ${symbols[state.currency]}${rate.toFixed(4)} · ${data.date}`;
    } else {
      label.textContent = `1 USD = ${symbols[state.currency]}${rate.toFixed(4)} (fallback)`;
    }
  } catch (e) {
    console.warn('Rate fetch failed', e);
  }
}

function updateCurrencyLabels() {
  const sym = currencySymbol();
  // Bucket modal target (still uses static prefix)
  const bktLbl = document.getElementById('bktTargetLabel');
  if (bktLbl) bktLbl.textContent = `Target Amount (${sym}, optional)`;
  const bktPfx = document.getElementById('bktTargetPrefix');
  if (bktPfx) bktPfx.textContent = sym;
  // Manual allocate modal (still uses static prefix)
  const manualAvailLbl = document.getElementById('manualAllocAvailableLabel');
  if (manualAvailLbl) manualAvailLbl.textContent = `Unallocated Fund (${sym})`;
  const manualAvailPfx = document.getElementById('manualAllocAvailablePrefix');
  if (manualAvailPfx) manualAvailPfx.textContent = sym;
  const manualAmtLbl = document.getElementById('manualAllocAmountLabel');
  if (manualAmtLbl) manualAmtLbl.textContent = `Allocate Amount (${sym})`;
  const manualAmtPfx = document.getElementById('manualAllocAmountPrefix');
  if (manualAmtPfx) manualAmtPfx.textContent = sym;

  if (!document.getElementById('entryModal').classList.contains('hidden')) {
    onEntryAccountChange();
    updateAllocRemaining();
  }
  if (!document.getElementById('manualAllocateModal').classList.contains('hidden')) {
    renderManualAllocateModal(false);
  }
}

function setCurrency(c) {
  state.currency = c;
  document.querySelectorAll('.currency-btn').forEach(btn => {
    const isActive = btn.id === `btn-${c}`;
    btn.classList.toggle('bg-slate-600', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('text-slate-400', !isActive);
  });
  const symbols = { AED: 'د.إ', INR: '₹' };
  const rate = state.rates[c];
  const label = document.getElementById('rateLabel');
  const existing = label.textContent;
  label.textContent = existing.replace(/[د.إ₹][^\s·]+/, `${symbols[c]}${rate.toFixed(4)}`);
  updateCurrencyLabels();
  if (state.session?.logged_in) {
    loadDashboard();
  }
}

// ── Transactions ──────────────────────────────────────────────

async function loadTransactions() {
  try {
    const data = await api(withScopeQuery('/api/transactions'));
    state.transactions = data;
    renderTransactions();
  } catch (e) {
    console.error('loadTransactions', e);
  }
}

function txnTypeLabel(t) {
  return { credit: 'Credit', debit: 'Debit', intra: 'Transfer' }[t] || t;
}

function txnTypeClass(t) {
  return {
    credit: 'bg-emerald-500/15 text-emerald-300',
    debit: 'bg-rose-500/15 text-rose-300',
    intra: 'bg-blue-500/15 text-blue-300',
  }[t] || 'bg-slate-500/20 text-slate-300';
}

function renderTransactions() {
  const list = document.getElementById('transactionsList');
  const empty = document.getElementById('transactionsEmpty');
  if (!list) return;

  if (!state.transactions.length) {
    list.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  list.innerHTML = state.transactions.map(txn => {
    const fromName = txn.from_account_name || txn.counterparty || '—';
    const toName = txn.to_account_name || txn.counterparty || '—';
    let flowHtml = '';
    if (txn.txn_type === 'credit') {
      flowHtml = `<span class="text-slate-400">${txn.counterparty || 'External'}</span> → <span class="text-white font-medium">${toName}</span>`;
    } else if (txn.txn_type === 'debit') {
      flowHtml = `<span class="text-white font-medium">${fromName}</span> → <span class="text-slate-400">${txn.counterparty || 'External'}</span>`;
    } else {
      flowHtml = `<span class="text-white font-medium">${txn.from_account_name || '—'}</span> → <span class="text-white font-medium">${txn.to_account_name || '—'}</span>`;
    }

    const amtClass = txn.txn_type === 'debit' ? 'text-rose-300' : 'text-emerald-300';
    const amtPrefix = txn.txn_type === 'debit' ? '−' : '+';
    const deleteBtn = !isAllUsersView()
      ? `<button onclick="deleteTransaction(${txn.id})" class="ml-3 text-slate-500 hover:text-rose-400 text-xs transition-colors">Delete</button>`
      : '';

    return `
      <div class="bg-slate-700/50 rounded-xl px-4 py-3 flex items-center gap-3">
        <span class="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${txnTypeClass(txn.txn_type)}">${txnTypeLabel(txn.txn_type)}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm">${flowHtml}</div>
          ${txn.note ? `<p class="text-xs text-slate-400 truncate mt-0.5">${txn.note}</p>` : ''}
        </div>
        <div class="text-right shrink-0">
          <p class="text-sm font-semibold ${amtClass}">${amtPrefix}${money(txn.amount)}</p>
          <p class="text-xs text-slate-500">${dateStr(txn.recorded_at)}</p>
        </div>
        ${deleteBtn}
      </div>
    `;
  }).join('');
}

function setTxnType(type) {
  state.txnType = type;

  // Update button styles
  ['credit', 'debit', 'intra'].forEach(t => {
    const btn = document.getElementById(`txnType${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (!btn) return;
    const active = t === type;
    btn.classList.toggle('bg-indigo-600', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('border-indigo-500', active);
    btn.classList.toggle('bg-slate-700', !active);
    btn.classList.toggle('text-slate-300', !active);
    btn.classList.toggle('border-slate-600', !active);
  });

  // Show/hide rows based on type
  const fromRow = document.getElementById('txnFromRow');
  const toRow = document.getElementById('txnToRow');
  const counterpartyRow = document.getElementById('txnCounterpartyRow');
  const counterpartyLabel = document.getElementById('txnCounterpartyLabel');

  if (type === 'credit') {
    fromRow?.classList.add('hidden');
    toRow?.classList.remove('hidden');
    counterpartyRow?.classList.remove('hidden');
    if (counterpartyLabel) counterpartyLabel.textContent = 'Source / Counterparty (e.g. Employer)';
  } else if (type === 'debit') {
    fromRow?.classList.remove('hidden');
    toRow?.classList.add('hidden');
    counterpartyRow?.classList.remove('hidden');
    if (counterpartyLabel) counterpartyLabel.textContent = 'Payee / Counterparty (e.g. DEWA)';
  } else {
    fromRow?.classList.remove('hidden');
    toRow?.classList.remove('hidden');
    counterpartyRow?.classList.add('hidden');
  }
}

function populateTxnAccountSelects() {
  const myAccounts = state.accounts.filter(a => !isAllUsersView() || a);
  const opts = myAccounts
    .filter(a => typeof a.id === 'number') // skip merged entries from all-users view
    .map(a => `<option value="${a.id}">${a.name} (${typeLabel(a.type)})</option>`)
    .join('');

  const fromSel = document.getElementById('txnFrom');
  const toSel = document.getElementById('txnTo');
  if (fromSel) fromSel.innerHTML = `<option value="">— select account —</option>${opts}`;
  if (toSel) toSel.innerHTML = `<option value="">— select account —</option>${opts}`;
}

function openTransactionModal() {
  if (!requireSingleUserSelection()) return;
  // Reset
  document.getElementById('txnCounterparty').value = '';
  document.getElementById('txnAmount').value = '';
  document.getElementById('txnNote').value = '';
  document.getElementById('txnDate').value = nowLocal();
  document.getElementById('txnError').textContent = '';

  // Default currency dropdown to current global currency
  const txnCurrSel = document.getElementById('txnAmountCurrency');
  if (txnCurrSel) txnCurrSel.value = state.currency;

  populateTxnAccountSelects();
  setTxnType('credit'); // default to credit
  openModal('transactionModal');
}

async function saveTransaction() {
  const type = state.txnType;
  const amountDisplay = parseFloat(document.getElementById('txnAmount').value) || 0;
  const txnCurrency = document.getElementById('txnAmountCurrency')?.value || state.currency;
  const amountUSD = toUSDWithCurrency(amountDisplay, txnCurrency);
  const counterparty = document.getElementById('txnCounterparty').value.trim();
  const note = document.getElementById('txnNote').value.trim();
  const dateVal = document.getElementById('txnDate').value;
  const errorEl = document.getElementById('txnError');
  errorEl.textContent = '';

  let from_account_id = null;
  let to_account_id = null;

  if (type === 'credit') {
    to_account_id = parseInt(document.getElementById('txnTo').value) || null;
    if (!to_account_id) { errorEl.textContent = 'Select a destination account.'; return; }
    if (!counterparty) { errorEl.textContent = 'Enter a source or counterparty.'; return; }
  } else if (type === 'debit') {
    from_account_id = parseInt(document.getElementById('txnFrom').value) || null;
    if (!from_account_id) { errorEl.textContent = 'Select a source account.'; return; }
    if (!counterparty) { errorEl.textContent = 'Enter a payee or counterparty.'; return; }
  } else {
    from_account_id = parseInt(document.getElementById('txnFrom').value) || null;
    to_account_id = parseInt(document.getElementById('txnTo').value) || null;
    if (!from_account_id) { errorEl.textContent = 'Select a source account.'; return; }
    if (!to_account_id) { errorEl.textContent = 'Select a destination account.'; return; }
    if (from_account_id === to_account_id) { errorEl.textContent = 'Source and destination must differ.'; return; }
  }

  if (!amountUSD || amountUSD <= 0) { errorEl.textContent = 'Enter a valid amount greater than zero.'; return; }

  try {
    await api('/api/transactions', 'POST', {
      txn_type: type,
      amount: amountUSD,
      from_account_id,
      to_account_id,
      counterparty: counterparty || null,
      note: note || null,
      recorded_at: dateVal ? dateVal.replace('T', ' ') : null,
    });
    closeModal('transactionModal');
    await Promise.all([loadTransactions(), loadData()]);
  } catch (e) {
    errorEl.textContent = e.message || 'Failed to save transaction.';
  }
}

async function deleteTransaction(id) {
  if (!confirm('Delete this transaction? This will also remove its associated balance entries.')) return;
  try {
    await api(`/api/transactions/${id}`, 'DELETE');
    await Promise.all([loadTransactions(), loadData()]);
  } catch (e) {
    alert(e.message || 'Failed to delete transaction.');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['accountModal', 'bucketModal', 'entryModal', 'manualAllocateModal', 'historyModal'].forEach(closeModal);
  }
});

['accountModal', 'bucketModal', 'entryModal', 'manualAllocateModal', 'historyModal'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', e => {
    if (e.target === el) closeModal(id);
  });
});

document.getElementById('signInPassword').addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
document.getElementById('signUpCode').addEventListener('keydown', e => { if (e.key === 'Enter') verifySignUp(); });
document.getElementById('activateCode').addEventListener('keydown', e => { if (e.key === 'Enter') verifyActivateExisting(); });
document.getElementById('forgotCode').addEventListener('keydown', e => { if (e.key === 'Enter') verifyForgotPassword(); });
document.getElementById('accInstitution').addEventListener('keydown', e => { if (e.key === 'Enter') saveAccount(); });
document.getElementById('bktTarget').addEventListener('keydown', e => { if (e.key === 'Enter') saveBucket(); });
document.getElementById('manualAllocAmount').addEventListener('keydown', e => { if (e.key === 'Enter') saveManualBucketAllocation(); });

async function init() {
  switchAuthTab('signin');
  await checkSession();
}

init();

// ══════════════════════════════════════════════════════════════════════════════
// Onboarding / Coach Marks
// ══════════════════════════════════════════════════════════════════════════════

const _ONBOARDING_KEY = 'sof_onboarding_v1';

// Each step: { tab, target (CSS selector|null), placement, title, desc, isLast }
const COACH_STEPS = [
  {
    tab: 'dashboard',
    target: null,
    placement: 'center',
    title: '👋 Welcome to State of Finance',
    desc: 'Your personal wealth tracker — built for families managing assets across UAE and India.\n\nThis two-minute tour walks you through every feature. You can skip at any time.',
  },
  {
    tab: 'dashboard',
    target: '#currencyToggleGroup',
    placement: 'bottom',
    title: '💱 Currency Toggle',
    desc: 'Switch between AED (UAE Dirham) and INR (Indian Rupee). Every amount across the entire app — balances, buckets, transactions — instantly converts using live exchange rates.',
  },
  {
    tab: 'dashboard',
    target: '#scopeSelect',
    placement: 'bottom',
    title: '👥 Personal vs Family View',
    desc: '"My Profile" shows only your own assets and buckets.\n\n"All Users" merges your entire family\'s data into one combined household view — perfect for a whole-family financial snapshot.',
  },
  {
    tab: 'dashboard',
    target: '#netWorthTotal',
    placement: 'bottom',
    title: '💰 Total Net Worth',
    desc: 'Your net worth at a glance — sum of all bank balances, investments, and shares, minus outstanding loan principals. Updates automatically whenever you add a balance entry.',
  },
  {
    tab: 'dashboard',
    target: '#unallocatedCashTotal',
    placement: 'bottom',
    title: '🏦 Unallocated Cash',
    desc: 'The portion of your bank balance not yet assigned to any goal bucket. This is your "free" money. Assign it to buckets to give every dirham a purpose.',
  },
  {
    tab: 'dashboard',
    target: '#byTypeBreakdown',
    placement: 'top',
    title: '📊 Asset Type Breakdown',
    desc: 'See how your wealth is spread across Banks, Investments, Shares, and how much you owe on Loans. Great for spotting imbalances in your asset allocation.',
  },
  {
    tab: 'dashboard',
    target: '#bucketSummary',
    placement: 'top',
    title: '🎯 Bucket Progress',
    desc: 'Each bucket represents a financial goal (Emergency Fund, School Fees, Vacation…). The progress bar shows allocated vs target. Green = fully funded. Amber = partially funded.',
  },
  {
    tab: 'dashboard',
    target: '#recentEntries',
    placement: 'top',
    title: '📋 Recent Balance Entries',
    desc: 'The latest balance snapshots recorded across all your assets. State of Finance is snapshot-based — add an entry whenever a balance changes to keep your net worth accurate.',
  },
  {
    tab: 'dashboard',
    target: '#mainAddEntryBtn',
    placement: 'bottom',
    title: '➕ Add Balance Entry',
    desc: 'Record a point-in-time snapshot of any asset\'s balance. For bank accounts you can also split the balance across bucket goals right here. Pick your currency per entry.',
  },
  {
    tab: 'accounts',
    target: '[data-tab="accounts"]',
    placement: 'bottom',
    title: '🏛️ Assets Tab',
    desc: 'Everything you own (or owe) lives here. Four asset types:\n\n• Bank Account — savings or current accounts\n• Loan — mortgage or debt (tracked as negative)\n• Shares — stocks with live price auto-fetch\n• Investment Group — mutual funds, crypto, portfolios',
  },
  {
    tab: 'accounts',
    target: '#addAssetBtn',
    placement: 'bottom',
    title: '+ Add Asset',
    desc: 'Tap here to create a new asset. For Shares, just enter the stock code and exchange — the latest market price is fetched automatically. Use ↻ Refresh on the card to update anytime.',
  },
  {
    tab: 'buckets',
    target: '[data-tab="buckets"]',
    placement: 'bottom',
    title: '🪣 Buckets Tab',
    desc: 'Buckets are named savings goals or reserves — Emergency Fund, Vacation, School Fees, Car Down-payment. Money allocated to buckets is "spoken for" and subtracted from your free cash.',
  },
  {
    tab: 'buckets',
    target: '#addBucketBtn',
    placement: 'bottom',
    title: '+ Add Bucket',
    desc: 'Create a bucket with a name, target amount, and color. Choose the allocation type:\n\n• Manual — you allocate exactly how much\n• Auto — filled automatically from bank cash when you click Allocate',
  },
  {
    tab: 'buckets',
    target: '#autoAllocateBtn',
    placement: 'bottom',
    title: '⚡ Auto Allocate',
    desc: 'Fills all Auto-type buckets from available bank cash in priority order (sort order on each bucket). Run this right after recording a salary credit to instantly fund your goals.',
  },
  {
    tab: 'transactions',
    target: '[data-tab="transactions"]',
    placement: 'bottom',
    title: '💸 Transactions Tab',
    desc: 'Record every money movement — income, expenses, and transfers. Transactions automatically update the affected asset balances, so you don\'t need to manually add a balance entry.',
  },
  {
    tab: 'transactions',
    target: '#addTransactionBtn',
    placement: 'bottom',
    title: '+ New Transaction — 3 Types',
    desc: '• Credit — money in (salary, rental income). Choose the destination account and counterparty name.\n\n• Debit — money out (DEWA, rent, groceries). Blocked automatically if the amount exceeds the account balance.\n\n• Transfer — move money between your own assets (bank → investment account).',
  },
  {
    tab: 'timeline',
    target: '[data-tab="timeline"]',
    placement: 'bottom',
    title: '📈 Timeline',
    desc: 'View your net worth and individual asset trends over time. Group by Day, Week, or Month. Filter by date range to zoom into any period. Hover chart lines to see exact values.',
  },
  {
    tab: 'dashboard',
    target: null,
    placement: 'center',
    title: '🎉 You\'re all set!',
    desc: 'Start by adding your first asset → record a balance entry → create some buckets → track transactions.\n\nClick the ? button in the top bar anytime to replay this tour.',
    isLast: true,
  },
];

let _coachStep = 0;

function startOnboarding() {
  _coachStep = 0;
  document.getElementById('coachOverlay').classList.remove('hidden');
  _showCoachStep(0);
}

function skipOnboarding() {
  document.getElementById('coachOverlay').classList.add('hidden');
  localStorage.setItem(_ONBOARDING_KEY, '1');
  // Return to dashboard
  switchTab('dashboard');
}

function nextCoachStep() {
  if (_coachStep >= COACH_STEPS.length - 1) {
    skipOnboarding();
    return;
  }
  _coachStep++;
  _showCoachStep(_coachStep);
}

function prevCoachStep() {
  if (_coachStep <= 0) return;
  _coachStep--;
  _showCoachStep(_coachStep);
}

function _showCoachStep(index) {
  const step = COACH_STEPS[index];
  // Switch tab first, then position after DOM settles
  if (step.tab) switchTab(step.tab);
  const delay = step.tab ? 160 : 0;
  setTimeout(() => _renderCoachStep(step, index), delay);
}

function _renderCoachStep(step, index) {
  const total = COACH_STEPS.length;
  const overlay  = document.getElementById('coachOverlay');
  const spotlight = document.getElementById('coachSpotlight');
  const card     = document.getElementById('coachCard');
  const arrow    = document.getElementById('coachArrow');

  // ── Content ───────────────────────────────────────────────────────────────
  document.getElementById('coachStepLabel').textContent = `Step ${index + 1} of ${total}`;
  document.getElementById('coachTitle').textContent = step.title;
  document.getElementById('coachDesc').textContent = step.desc;

  // Progress dots
  const dots = document.getElementById('coachDots');
  dots.innerHTML = Array.from({ length: total }, (_, i) => {
    const active = i === index;
    const done   = i < index;
    return `<span class="inline-block rounded-full transition-all duration-200"
      style="width:${active ? 20 : 6}px; height:6px;
             background:${active ? '#6366f1' : done ? '#4f46e5' : '#374151'}"></span>`;
  }).join('');

  // Prev / Next buttons
  const prevBtn = document.getElementById('coachPrev');
  const nextBtn = document.getElementById('coachNext');
  prevBtn.classList.toggle('invisible', index === 0);
  nextBtn.textContent = step.isLast ? '🎉 Finish' : 'Next →';

  arrow.classList.add('hidden');

  // ── Center mode (no target) ───────────────────────────────────────────────
  if (!step.target) {
    overlay.style.background = 'rgba(0,0,0,0.80)';
    spotlight.classList.add('hidden');
    card.style.position = 'fixed';
    card.style.top  = '50%';
    card.style.left = '50%';
    card.style.transform = 'translate(-50%, -50%)';
    return;
  }

  // ── Spotlight mode ────────────────────────────────────────────────────────
  overlay.style.background = 'transparent';
  overlay.style.pointerEvents = 'none'; // let spotlight div intercept
  card.style.transform = '';

  const targetEl = document.querySelector(step.target);
  if (!targetEl) {
    // Target not in DOM (e.g. empty lists) — skip gracefully
    nextCoachStep();
    return;
  }

  // Scroll target into view smoothly
  targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const PAD = 8;
  const CARD_W = 340;
  const CARD_H = card.offsetHeight || 240;
  const GAP    = 14;

  const r  = targetEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Position spotlight
  spotlight.classList.remove('hidden');
  spotlight.style.top    = `${r.top    - PAD}px`;
  spotlight.style.left   = `${r.left   - PAD}px`;
  spotlight.style.width  = `${r.width  + PAD * 2}px`;
  spotlight.style.height = `${r.height + PAD * 2}px`;
  spotlight.style.pointerEvents = 'none';

  // Position card
  const pl = step.placement || 'bottom';
  let top, left;

  if (pl === 'bottom') {
    top  = r.bottom + PAD + GAP;
    left = r.left + r.width / 2 - CARD_W / 2;
  } else if (pl === 'top') {
    top  = r.top - PAD - CARD_H - GAP;
    left = r.left + r.width / 2 - CARD_W / 2;
  } else if (pl === 'right') {
    top  = r.top + r.height / 2 - CARD_H / 2;
    left = r.right + PAD + GAP;
  } else {
    top  = r.top + r.height / 2 - CARD_H / 2;
    left = r.left - PAD - CARD_W - GAP;
  }

  // Clamp to viewport with margin
  const M = 12;
  left = Math.max(M, Math.min(left, vw - CARD_W - M));
  top  = Math.max(M, Math.min(top,  vh - CARD_H - M));

  card.style.position = 'fixed';
  card.style.top  = `${top}px`;
  card.style.left = `${left}px`;

  // Re-enable pointer events on the overlay (clicks on dark area are swallowed)
  overlay.style.pointerEvents = 'auto';
  card.style.pointerEvents = 'auto';
  spotlight.style.pointerEvents = 'none';
}

// ── Auto-start for first-time users ──────────────────────────────────────────
// Called from checkSession() after a successful login
function _maybeStartOnboarding() {
  if (!localStorage.getItem(_ONBOARDING_KEY)) {
    setTimeout(startOnboarding, 600);
  }
}

// Close coach marks with Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('coachOverlay').classList.contains('hidden')) {
    skipOnboarding();
  }
});
