const state = {
  session: null,
  accounts: [],
  buckets: [],
  bucketSummary: [],
  transactions: [],
  collapsedAssetSections: {},
  editingAccountId: null,
  editingBucketId: null,
  allocatingBucketId: null,
  manualAllocateContext: null,
  expandedAccounts: {},
  accountActivity: {},
  accountActivityLoading: {},
  accountActivityError: {},
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
const SHARE_EXCHANGE_CURRENCIES = {
  DFM: 'AED',
  ADX: 'AED',
  'NASDAQ Dubai': 'USD',
  NSE: 'INR',
  BSE: 'INR',
};
const FEATURE_ANNOUNCEMENT_VERSION = 'zakaat_metals_v1';
const FEATURE_ANNOUNCEMENT_KEY_PREFIX = `sof_feature_announcement_${FEATURE_ANNOUNCEMENT_VERSION}`;

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

function moneyInCurrency(v, currency, { minimumFractionDigits = 0, maximumFractionDigits } = {}) {
  if (v === null || v === undefined || v === '') return '—';
  const digits = maximumFractionDigits ?? (currency === 'INR' ? 0 : 2);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits,
    maximumFractionDigits: digits,
  }).format(Number(v));
}

function moneyFromStored(v, currency, usdValue = null, options = {}) {
  if (v === null || v === undefined || v === '') return '—';
  if (currency) {
    const converted = convertAmount(Number(v), currency, state.currency);
    return moneyInCurrency(converted, state.currency, options);
  }
  if (usdValue !== null && usdValue !== undefined) {
    return money(usdValue);
  }
  return moneyInCurrency(Number(v), state.currency, options);
}

function signedMoney(v) {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${money(Math.abs(v))}`;
}

function signedMoneyFromStored(v, currency, usdValue = null, options = {}) {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const normalizedUsd = usdValue === null || usdValue === undefined ? null : Math.abs(usdValue);
  return `${sign}${moneyFromStored(Math.abs(v), currency, normalizedUsd, options)}`;
}

function signedPercent(v, fractionDigits = 1) {
  if (v === null || v === undefined) return '';
  const sign = v > 0 ? '+' : '';
  return `${sign}${Number(v).toFixed(fractionDigits)}%`;
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

function shareExchangeCurrency(exchange) {
  return SHARE_EXCHANGE_CURRENCIES[exchange] || 'USD';
}

function convertAmount(v, fromCurrency, toCurrency) {
  if (v === null || v === undefined || v === '') return 0;
  const usd = toUSDWithCurrency(Number(v), fromCurrency || 'USD');
  if (!toCurrency || toCurrency === 'USD') return usd;
  return usd * (state.rates[toCurrency] || 1);
}

function typeLabel(t) {
  return {
    bank: 'Bank Account',
    loan: 'Loan Account',
    shares: 'Shares',
    investment_group: 'Investment Group',
    metal: 'Metals',
  }[t] || 'Other';
}

function metalLabel(account) {
  const mt = (account.metal_type || 'gold');
  const ht = account.holding_type;
  const htLabel = { jewellery: 'Jewellery', digital_gold: 'Digital Gold', physical: 'Physical' }[ht] || '';
  return mt === 'gold'
    ? `🥇 Gold${htLabel ? ' — ' + htLabel : ''}`
    : '🥈 Silver';
}

function dateStr(iso) {
  if (!iso) return '';
  const text = String(iso).replace(' ', 'T');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateHtml(iso) {
  return escapeHtml(dateStr(iso));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeColor(value, fallback = '#6366f1') {
  const text = String(value ?? '').trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text) ? text : fallback;
}

function setSelectOptions(select, options) {
  if (!select) return;
  select.replaceChildren(...options.map(({ value, label, selected = false }) => {
    const option = document.createElement('option');
    option.value = String(value ?? '');
    option.textContent = String(label ?? '');
    option.selected = !!selected;
    return option;
  }));
}

function getOrCreateChartTooltip(chart) {
  const tooltipId = `chart-tooltip-${chart.canvas.id || 'default'}`;
  let el = document.getElementById(tooltipId);
  if (el) return el;

  el = document.createElement('div');
  el.id = tooltipId;
  el.className = 'fixed z-50 pointer-events-none rounded-xl border border-slate-700 bg-slate-900/95 px-3 py-2 shadow-2xl backdrop-blur-sm transition-opacity duration-75';
  el.style.opacity = '0';
  el.style.maxWidth = '320px';
  el.style.left = '0px';
  el.style.top = '0px';
  document.body.appendChild(el);
  return el;
}

function makeExternalTooltipHandler({ showTitle = true } = {}) {
  return ({ chart, tooltip }) => {
    const el = getOrCreateChartTooltip(chart);
    if (!tooltip || tooltip.opacity === 0) {
      el.style.opacity = '0';
      return;
    }

    const titleHtml = showTitle && tooltip.title?.length
      ? `<div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">${tooltip.title.map(escapeHtml).join('<br>')}</div>`
      : '';

    const bodyItems = tooltip.body || [];
    const labelColors = tooltip.labelColors || [];
    const bodyHtml = bodyItems.map((item, index) => {
      const lines = (item.lines || []).map(line => escapeHtml(String(line).trimStart())).join('<br>');
      const color = safeColor(labelColors[index]?.backgroundColor, '#94a3b8');
      return `
        <div class="flex items-start gap-2 text-xs text-slate-100">
          <span class="mt-1 inline-block h-2 w-2 shrink-0 rounded-full" style="background:${color}"></span>
          <div>${lines}</div>
        </div>
      `;
    }).join('');

    el.innerHTML = `${titleHtml}${bodyHtml}`;
    el.style.opacity = '1';

    const rect = chart.canvas.getBoundingClientRect();
    const padding = 12;
    const preferredRight = rect.left + tooltip.caretX + 16;
    const preferredLeft = rect.left + tooltip.caretX - el.offsetWidth - 16;
    let left = preferredRight;
    if (left + el.offsetWidth > window.innerWidth - padding) left = preferredLeft;
    if (left < padding) left = padding;

    let top = rect.top + tooltip.caretY - (el.offsetHeight / 2);
    if (top + el.offsetHeight > window.innerHeight - padding) {
      top = window.innerHeight - el.offsetHeight - padding;
    }
    if (top < padding) top = padding;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
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
        currency: acc.currency || 'USD',
        user_name: acc.user_name,
        _merged_count: 1,
        _institutions: new Set(acc.institution ? [acc.institution] : []),
        _currencies: new Set(acc.currency ? [acc.currency] : []),
        interest_rate: acc.interest_rate,
        remaining_tenure: acc.remaining_tenure,
        monthly_emi: acc.monthly_emi || 0,
        monthly_emi_usd: acc.monthly_emi_usd ?? null,
        remaining_principal: acc.remaining_principal || 0,
        remaining_principal_usd: acc.remaining_principal_usd ?? null,
        monthly_emi_native: acc.monthly_emi_native ?? null,
        remaining_principal_native: acc.remaining_principal_native ?? null,
        stock_name: acc.stock_name || '',
        exchange: acc.exchange || '',
        stock_code: acc.stock_code || '',
        quantity: acc.quantity || 0,
        latest_balance: acc.latest_balance ?? null,
        latest_balance_usd: acc.latest_balance_usd ?? null,
        latest_balance_native: acc.latest_balance_native ?? null,
        purchase_price: acc.purchase_price,
        purchase_price_currency: acc.purchase_price_currency || '',
        last_price: acc.last_price,
        last_price_currency: acc.last_price_currency || '',
        last_fetched: acc.last_fetched || null,
        cost_basis_total: acc.cost_basis_total ?? null,
        cost_basis_total_usd: acc.cost_basis_total_usd ?? null,
        unrealized_gain_loss: acc.unrealized_gain_loss ?? null,
        unrealized_gain_loss_usd: acc.unrealized_gain_loss_usd ?? null,
        _interest_rates: new Set(acc.interest_rate != null ? [String(acc.interest_rate)] : []),
        _tenures: new Set(acc.remaining_tenure != null ? [String(acc.remaining_tenure)] : []),
        _stock_names: new Set(acc.stock_name ? [acc.stock_name] : []),
        _exchanges: new Set(acc.exchange ? [acc.exchange] : []),
        _stock_codes: new Set(acc.stock_code ? [acc.stock_code] : []),
        _purchase_prices: new Set(acc.purchase_price != null ? [String(acc.purchase_price)] : []),
        _purchase_price_currencies: new Set(acc.purchase_price_currency ? [acc.purchase_price_currency] : []),
        _last_prices: new Set(acc.last_price != null ? [String(acc.last_price)] : []),
        _last_price_currencies: new Set(acc.last_price_currency ? [acc.last_price_currency] : []),
      });
      return;
    }

    const current = groups.get(key);
    current._merged_count += 1;
    pushUnique(current._institutions, acc.institution);
    pushUnique(current._currencies, acc.currency);
    pushUnique(current._interest_rates, acc.interest_rate != null ? acc.interest_rate : null);
    pushUnique(current._tenures, acc.remaining_tenure != null ? acc.remaining_tenure : null);
    pushUnique(current._stock_names, acc.stock_name);
    pushUnique(current._exchanges, acc.exchange);
    pushUnique(current._stock_codes, acc.stock_code);
    pushUnique(current._purchase_prices, acc.purchase_price != null ? acc.purchase_price : null);
    pushUnique(current._purchase_price_currencies, acc.purchase_price_currency);
    pushUnique(current._last_prices, acc.last_price != null ? acc.last_price : null);
    pushUnique(current._last_price_currencies, acc.last_price_currency);
    current.monthly_emi = (current.monthly_emi || 0) + (acc.monthly_emi || 0);
    if (acc.monthly_emi_usd != null) {
      current.monthly_emi_usd = (current.monthly_emi_usd || 0) + acc.monthly_emi_usd;
    }
    current.remaining_principal = (current.remaining_principal || 0) + (acc.remaining_principal || 0);
    if (acc.remaining_principal_usd != null) {
      current.remaining_principal_usd = (current.remaining_principal_usd || 0) + acc.remaining_principal_usd;
    }
    current.quantity = (current.quantity || 0) + (acc.quantity || 0);
    if (acc.latest_balance != null) {
      current.latest_balance = (current.latest_balance || 0) + acc.latest_balance;
    }
    if (acc.latest_balance_usd != null) {
      current.latest_balance_usd = (current.latest_balance_usd || 0) + acc.latest_balance_usd;
    }
    if (acc.cost_basis_total != null) {
      current.cost_basis_total = (current.cost_basis_total || 0) + acc.cost_basis_total;
    }
    if (acc.cost_basis_total_usd != null) {
      current.cost_basis_total_usd = (current.cost_basis_total_usd || 0) + acc.cost_basis_total_usd;
    }
    if (acc.unrealized_gain_loss != null) {
      current.unrealized_gain_loss = (current.unrealized_gain_loss || 0) + acc.unrealized_gain_loss;
    }
    if (acc.unrealized_gain_loss_usd != null) {
      current.unrealized_gain_loss_usd = (current.unrealized_gain_loss_usd || 0) + acc.unrealized_gain_loss_usd;
    }
    if (acc.last_fetched && (!current.last_fetched || acc.last_fetched > current.last_fetched)) {
      current.last_fetched = acc.last_fetched;
    }
  });

  return Array.from(groups.values()).map(acc => {
    const oneOrBlank = set => set.size === 1 ? Array.from(set)[0] : '';
    return {
      ...acc,
      institution: Array.from(acc._institutions).join(', '),
      currency: oneOrBlank(acc._currencies) || '',
      user_name: formatUserBadgeLabel(acc._merged_count),
      interest_rate: oneOrBlank(acc._interest_rates),
      remaining_tenure: oneOrBlank(acc._tenures),
      stock_name: oneOrBlank(acc._stock_names) || (acc._stock_names.size > 1 ? 'Multiple holdings' : ''),
      exchange: oneOrBlank(acc._exchanges) || (acc._exchanges.size > 1 ? 'Multiple' : ''),
      stock_code: oneOrBlank(acc._stock_codes) || (acc._stock_codes.size > 1 ? 'Multiple' : ''),
      purchase_price: acc._purchase_prices.size === 1 ? Number(Array.from(acc._purchase_prices)[0]) : null,
      purchase_price_currency: oneOrBlank(acc._purchase_price_currencies),
      last_price: acc._last_prices.size === 1 ? Number(Array.from(acc._last_prices)[0]) : null,
      last_price_currency: oneOrBlank(acc._last_price_currencies),
      latest_balance: acc.latest_balance,
      latest_balance_usd: acc.latest_balance_usd,
      monthly_emi_usd: acc.monthly_emi_usd,
      remaining_principal_usd: acc.remaining_principal_usd,
      cost_basis_total: acc.type === 'shares' ? acc.cost_basis_total : null,
      cost_basis_total_usd: acc.type === 'shares' ? acc.cost_basis_total_usd : null,
      unrealized_gain_loss: acc.type === 'shares' ? acc.unrealized_gain_loss : null,
      unrealized_gain_loss_usd: acc.type === 'shares' ? acc.unrealized_gain_loss_usd : null,
      unrealized_gain_loss_pct: acc.type === 'shares' && acc.cost_basis_total
        ? (acc.unrealized_gain_loss || 0) / acc.cost_basis_total * 100
        : null,
      is_profitable: acc.type === 'shares' && acc.unrealized_gain_loss != null
        ? acc.unrealized_gain_loss > 0
        : null,
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

function getAccountById(accountId) {
  return state.accounts.find(a => Number(a.id) === Number(accountId)) || null;
}

function getSelectedEntryAccount() {
  const accountId = parseInt(document.getElementById('entAccount')?.value);
  return getAccountById(accountId);
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
  ['dashboard', 'accounts', 'buckets', 'timeline', 'transactions', 'zakat'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== name);
    document.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === name);
  });
  if (name === 'timeline') loadTimeline();
  if (name === 'transactions') loadTransactions();
  if (name === 'zakat') loadZakat();
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
  // Apply user's saved default currency on login
  if (state.session?.user?.default_currency) {
    state.currency = ['AED', 'INR', 'USD'].includes(state.session.user.default_currency)
      ? state.session.user.default_currency
      : 'AED';
    // Sync toggle buttons without triggering a save
    document.querySelectorAll('.currency-btn').forEach(btn => {
      const isActive = btn.id === `btn-${state.currency}`;
      btn.classList.toggle('bg-slate-600', isActive);
      btn.classList.toggle('text-white', isActive);
      btn.classList.toggle('text-slate-400', !isActive);
    });
  }
  updateSessionUi();
  updateReadOnlyUi();
}

async function loadActivationProfiles() {
  const rows = await api('/api/auth/available-profiles');
  const select = document.getElementById('activateProfileSelect');
  if (!rows.length) {
    setSelectOptions(select, [{ value: '', label: 'No profiles available' }]);
    return;
  }
  setSelectOptions(select, [
    { value: '', label: 'Select profile' },
    ...rows.map(row => ({ value: row.id, label: row.name || '' })),
  ]);
}

async function signIn() {
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    clearAuthStatus();
    const result = await api('/api/auth/signin', 'POST', { email, password });
    await handleAuthenticated(result, { announceNewFeatures: true });
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

async function handleAuthenticated(sessionPayload, options = {}) {
  setSessionPayload(sessionPayload);
  setAppVisibility(true);
  clearOtpPreview();
  updateCurrencyLabels();
  try {
    await fetchRates();
    updateCurrencyLabels();
    await loadData();
    const announcedFeatures = options.announceNewFeatures
      ? maybeShowNewFeatureAnnouncement()
      : false;
    if (!announcedFeatures) _maybeStartOnboarding();
  } catch (e) {
    console.error('handleAuthenticated', e);
    alert(`The dashboard could not finish loading.\n${e.message || e}`);
  }
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
  await loadData();
}

async function loadDashboard() {
  const [nw, buckets, recent] = await Promise.all([
    api(withScopeQuery('/api/summary/net-worth')),
    api(withScopeQuery('/api/summary/buckets')),
    api(withScopeQuery('/api/balances')),
  ]);
  state.netWorthSummary = nw;
  state.bucketSummary = buckets;
  await _renderDashboard(nw, buckets, recent);
}

async function _renderDashboard(nw, buckets, recent) {

  document.getElementById('netWorthTotal').textContent = money(nw.total);
  document.getElementById('unallocatedCashTotal').textContent = money(nw.unallocated_cash || 0);

  const typeTextColors = {
    bank: 'text-emerald-400',
    loan: 'text-orange-400',
    shares: 'text-indigo-400',
    investment_group: 'text-blue-400',
    metal: 'text-yellow-400',
  };
  const breakdown = document.getElementById('byTypeBreakdown');
  breakdown.innerHTML = Object.entries(nw.by_type).map(([type, amt]) => `
    <div class="bg-slate-700/50 rounded-lg p-3">
      <p class="text-xs text-slate-400">${escapeHtml(typeLabel(type))}</p>
      <p class="text-lg font-semibold ${typeTextColors[type] || 'text-slate-300'}">${money(amt)}</p>
    </div>
  `).join('');

  if (Object.keys(nw.by_type).length) {
    const colorMap = { bank: '#10b981', loan: '#f97316', shares: '#6366f1', investment_group: '#3b82f6', metal: '#eab308' };
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
      const bucketColor = safeColor(b.color);
      const bucketName = escapeHtml(b.name);
      return `
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm flex items-center gap-2">
              <span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${bucketColor}"></span>
              ${bucketName}
              <span class="text-[11px] px-2 py-0.5 rounded-full ${bucketTypeClass(bucketAllocationType(b))}">${bucketTypeLabel(bucketAllocationType(b))}</span>
            </span>
            <span class="text-sm ${status}">
              ${money(b.allocated)}${b.target ? ` / ${money(b.target)}` : ''}
            </span>
          </div>
          ${b.target ? `
          <div class="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div class="h-full rounded-full progress-bar" style="width:${pct}%;background:${bucketColor}"></div>
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
    recentDiv.innerHTML = top.map(e => {
      const accountName = escapeHtml(e.account_name || '');
      const userName = escapeHtml(e.user_name || '');
      const entryTitle = isAllUsersView() && e.user_name ? `${userName} · ${accountName}` : accountName;
      const noteHtml = e.note ? `<span class="text-xs text-slate-400 ml-2">${escapeHtml(e.note)}</span>` : '';
      return `
        <div class="flex items-center justify-between py-2 border-b border-slate-700 last:border-0">
          <div>
            <span class="text-sm font-medium">${entryTitle}</span>
            ${noteHtml}
          </div>
          <div class="text-right">
            <span class="text-sm font-semibold">${moneyFromStored(e.amount, e.amount_currency, e.amount_usd)}</span>
            <span class="text-xs text-slate-400 ml-2">${dateHtml(e.recorded_at)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('lastUpdated').textContent = recent.length
    ? `Last updated: ${dateStr(recent[0].recorded_at)}`
    : '';

  renderBuckets();
}

async function loadData() {
  // Fire all independent requests in a single parallel wave
  const timelineVisible = !document.getElementById('tab-timeline').classList.contains('hidden');
  const requests = [
    api(withScopeQuery('/api/accounts')),
    api(withScopeQuery('/api/buckets')),
    api(withScopeQuery('/api/summary/net-worth')),
    api(withScopeQuery('/api/summary/buckets')),
    api(withScopeQuery('/api/balances')),
    timelineVisible ? api(withScopeQuery('/api/summary/timeline')) : Promise.resolve(null),
  ];
  const [accountRows, bucketRows, nw, bucketSummary, recent, timelineData] = await Promise.all(requests);

  // Hydrate state
  state.accounts = mergeAccountsForView(accountRows);
  state.buckets = mergeBucketsForView(bucketRows);
  state.netWorthSummary = nw;
  state.bucketSummary = bucketSummary;

  // Render everything
  renderAccounts();
  renderBuckets();
  await _renderDashboard(nw, bucketSummary, recent);
  if (timelineVisible && timelineData) {
    _renderTimeline(timelineData);
  }
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
          enabled: false,
          external: makeExternalTooltipHandler({ showTitle: false }),
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

function compactAssetSubtitle(account, readOnly = false) {
  const parts = [];
  if (account.institution) {
    parts.push(account.institution);
  } else if (account.type === 'shares' && account.stock_name) {
    parts.push(account.stock_name);
  }
  if (readOnly && account.user_name) {
    parts.push(`Merged across ${account.user_name}`);
  }
  return parts.join(' · ');
}

function shareBalanceClassName(account) {
  if (account.unrealized_gain_loss > 0 || account.is_profitable === true) {
    return 'text-emerald-300';
  }
  if (account.unrealized_gain_loss < 0 || account.is_profitable === false) {
    return 'text-rose-300';
  }
  return 'text-slate-300';
}

function accountBalancePresentation(account) {
  if (account.type === 'loan' && account.remaining_principal != null) {
    return {
      label: 'outstanding',
      className: 'text-orange-300',
      value: moneyFromStored(
        Math.abs(account.remaining_principal),
        account.currency,
        account.remaining_principal_usd != null ? Math.abs(account.remaining_principal_usd) : null,
      ),
    };
  }
  if (account.type === 'shares' && account.latest_balance != null) {
    return {
      label: 'market value',
      className: shareBalanceClassName(account),
      value: moneyFromStored(account.latest_balance, account.currency, account.latest_balance_usd),
    };
  }
  if (account.latest_balance != null) {
    return {
      label: 'balance',
      className: account.latest_balance < 0 ? 'text-rose-300' : 'text-emerald-300',
      value: moneyFromStored(account.latest_balance, account.currency, account.latest_balance_usd),
    };
  }
  return {
    label: account.type === 'shares' ? 'market value' : 'balance',
    className: 'text-slate-300',
    value: '—',
  };
}

function accountSectionTotalUsd(account) {
  if (account.type === 'loan' && account.remaining_principal != null) {
    if (account.remaining_principal_usd != null) return Math.abs(account.remaining_principal_usd);
    return Math.abs(toUSDWithCurrency(account.remaining_principal, account.currency || 'USD'));
  }
  if (account.type === 'shares' && account.latest_balance != null) {
    if (account.latest_balance_usd != null) return account.latest_balance_usd;
    return toUSDWithCurrency(account.latest_balance, account.currency || 'USD');
  }
  if (account.latest_balance != null) {
    if (account.latest_balance_usd != null) return account.latest_balance_usd;
    return toUSDWithCurrency(account.latest_balance, account.currency || 'USD');
  }
  return 0;
}

function assetSectionSummary(sectionType, accounts) {
  const totalUsd = accounts.reduce((sum, account) => sum + accountSectionTotalUsd(account), 0);
  const labelMap = {
    bank: 'Total balance',
    investment_group: 'Total balance',
    shares: 'Total market value',
    loan: 'Total outstanding',
    metal: 'Total value',
  };
  const classMap = {
    bank: 'text-emerald-300',
    investment_group: 'text-blue-300',
    shares: 'text-indigo-300',
    loan: 'text-orange-300',
    metal: 'text-yellow-300',
  };
  return {
    label: labelMap[sectionType] || 'Total',
    className: classMap[sectionType] || 'text-slate-200',
    value: money(totalUsd),
  };
}

function formatAccountTransactionPreview(txn, accountId) {
  const accountNum = Number(accountId);
  const isSource = Number(txn.from_account_id) === accountNum;
  const isDestination = Number(txn.to_account_id) === accountNum;

  let amount = txn.amount;
  let currency = 'USD';
  let direction = 'in';
  let title = txn.counterparty || 'External';

  if (txn.txn_type === 'credit') {
    amount = txn.destination_amount ?? txn.amount;
    currency = txn.destination_currency || 'USD';
    direction = 'in';
    title = txn.counterparty ? `From ${txn.counterparty}` : 'Incoming credit';
  } else if (txn.txn_type === 'debit') {
    amount = txn.source_amount ?? txn.amount;
    currency = txn.source_currency || 'USD';
    direction = 'out';
    title = txn.counterparty ? `To ${txn.counterparty}` : 'Outgoing debit';
  } else if (isSource) {
    amount = txn.source_amount ?? txn.amount;
    currency = txn.source_currency || 'USD';
    direction = 'out';
    title = `Transfer to ${txn.to_account_name || 'account'}`;
  } else if (isDestination) {
    amount = txn.destination_amount ?? txn.amount;
    currency = txn.destination_currency || 'USD';
    direction = 'in';
    title = `Transfer from ${txn.from_account_name || 'account'}`;
  }

  return {
    className: direction === 'out' ? 'text-rose-300' : 'text-emerald-300',
    amountText: `${direction === 'out' ? '−' : '+'}${moneyInCurrency(amount, currency)}`,
    title,
  };
}

function renderExpandedAssetDetails(account, { readOnly = false, accountKey, numericAccountId }) {
  const isLoan = account.type === 'loan';
  const isShares = account.type === 'shares';
  const isBank = account.type === 'bank' && Number.isFinite(numericAccountId);
  if (!isLoan && !isShares && !isBank) {
    return '';
  }

  if (isBank) {
    const preview = state.accountActivity[accountKey] || [];
    const isLoading = !!state.accountActivityLoading[accountKey];
    const error = state.accountActivityError[accountKey];
    const activityHtml = isLoading
      ? '<p class="text-sm text-slate-400">Loading recent transactions...</p>'
      : error
        ? `<p class="text-sm text-rose-300">${escapeHtml(error)}</p>`
        : preview.length
          ? preview.map(txn => {
              const row = formatAccountTransactionPreview(txn, numericAccountId);
              const noteHtml = txn.note ? `<p class="text-[11px] text-slate-500 truncate">${escapeHtml(txn.note)}</p>` : '';
              return `
                <div class="flex items-center justify-between gap-3 rounded-lg bg-slate-900/40 px-3 py-2">
                  <div class="min-w-0">
                    <p class="text-sm text-slate-200 truncate">${escapeHtml(row.title)}</p>
                    ${noteHtml}
                  </div>
                  <div class="shrink-0 text-right">
                    <p class="text-sm font-semibold ${row.className}">${escapeHtml(row.amountText)}</p>
                    <p class="text-[11px] text-slate-500">${dateHtml(txn.recorded_at)}</p>
                  </div>
                </div>
              `;
            }).join('')
          : '<p class="text-sm text-slate-400">No transactions yet. Balance updates still appear in History.</p>';

    return `
      <div class="border-t border-slate-700/80 bg-slate-950/40 px-5 py-4">
        <div class="rounded-xl border border-slate-700/70 bg-slate-900/45 p-4 shadow-inner shadow-slate-950/30">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div>
              <p class="text-[11px] uppercase tracking-[0.24em] text-emerald-300/80">Recent Transactions</p>
              <p class="text-xs text-slate-500">Latest activity for this bank account.</p>
            </div>
            ${readOnly ? '' : `<button onclick="openAddEntry(${numericAccountId})" class="text-xs text-indigo-300 hover:text-white px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">+ Entry</button>`}
          </div>
          <div class="space-y-2">${activityHtml}</div>
        </div>
      </div>
    `;
  }

  if (isLoan) {
    return `
      <div class="border-t border-slate-700/80 bg-slate-950/40 px-5 py-4">
        <div class="rounded-xl border border-orange-500/20 bg-orange-500/6 p-4 shadow-inner shadow-slate-950/30">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div>
              <p class="text-[11px] uppercase tracking-[0.24em] text-orange-300/80">Loan Details</p>
              <p class="text-xs text-slate-500">Expanded repayment information.</p>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-slate-300">
            <div>Native Currency</div>
            <div class="text-right text-orange-200">${escapeHtml(account.currency || 'USD')}</div>
            <div>Interest Rate</div>
            <div class="text-right text-orange-200">${escapeHtml(account.interest_rate ?? '—')}% p.a.</div>
            <div>Remaining Tenure</div>
            <div class="text-right text-orange-200">${escapeHtml(account.remaining_tenure ?? '—')} months</div>
            <div>Monthly EMI</div>
            <div class="text-right text-orange-200">${account.monthly_emi != null ? moneyFromStored(account.monthly_emi, account.currency, account.monthly_emi_usd) : '—'}</div>
            <div>Outstanding Principal</div>
            <div class="text-right text-orange-200">${account.remaining_principal != null ? moneyFromStored(account.remaining_principal, account.currency, account.remaining_principal_usd) : '—'}</div>
          </div>
        </div>
      </div>
    `;
  }

  const profitClass = account.unrealized_gain_loss > 0
    ? 'text-emerald-300'
    : account.unrealized_gain_loss < 0
      ? 'text-rose-300'
      : 'text-slate-300';
  const profitText = account.unrealized_gain_loss != null
    ? signedMoneyFromStored(account.unrealized_gain_loss, account.currency || account.purchase_price_currency, account.unrealized_gain_loss_usd)
    : '—';
  const profitPct = account.unrealized_gain_loss_pct != null ? ` (${escapeHtml(signedPercent(account.unrealized_gain_loss_pct))})` : '';

  return `
    <div class="border-t border-slate-700/80 bg-slate-950/40 px-5 py-4">
      <div class="rounded-xl border border-indigo-500/20 bg-indigo-500/6 p-4 shadow-inner shadow-slate-950/30">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <p class="text-[11px] uppercase tracking-[0.24em] text-indigo-300/80">Share Details</p>
            <p class="text-xs text-slate-500">Holding and performance information.</p>
          </div>
          ${readOnly ? '' : `<button data-refresh="${numericAccountId}" onclick="refreshPrice(${numericAccountId})" class="text-xs text-indigo-300 hover:text-white px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">↻ Refresh Price</button>`}
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-slate-300">
          <div>Exchange</div>
          <div class="text-right text-indigo-200">${escapeHtml(account.exchange || '—')}</div>
          <div>Ticker</div>
          <div class="text-right text-indigo-200">${escapeHtml(account.stock_code || '—')}</div>
          <div>Quantity</div>
          <div class="text-right text-indigo-200">${account.quantity != null ? escapeHtml(Number(account.quantity).toLocaleString()) : '—'} shares</div>
          <div>Purchase Price</div>
          <div class="text-right text-indigo-200">${account.purchase_price != null ? moneyFromStored(account.purchase_price, account.purchase_price_currency || shareExchangeCurrency(account.exchange), null, { maximumFractionDigits: 4 }) : '—'}</div>
          <div>Cost Basis</div>
          <div class="text-right text-indigo-200">${account.cost_basis_total != null ? moneyFromStored(account.cost_basis_total, account.currency || account.purchase_price_currency, account.cost_basis_total_usd) : '—'}</div>
          <div>Current Price</div>
          <div class="text-right text-indigo-200">${account.last_price != null ? moneyFromStored(account.last_price, account.last_price_currency || shareExchangeCurrency(account.exchange), null, { maximumFractionDigits: 4 }) : '—'}</div>
          <div>P/L</div>
          <div class="text-right ${profitClass}">${profitText}${profitPct}</div>
          <div>Last Updated</div>
          <div class="text-right text-indigo-200">${account.last_fetched ? dateHtml(account.last_fetched) : '—'}</div>
        </div>
      </div>
    </div>
  `;
}

async function loadAccountActivity(accountId, { force = false } = {}) {
  const numericAccountId = Number(accountId);
  if (!Number.isFinite(numericAccountId)) return;
  const key = String(accountId);
  if (!force && (state.accountActivityLoading[key] || state.accountActivity[key])) return;
  state.accountActivityLoading[key] = true;
  delete state.accountActivityError[key];
  renderAccounts();
  try {
    state.accountActivity[key] = await api(withScopeQuery('/api/transactions', {
      account_id: numericAccountId,
      limit: 5,
    }));
  } catch (e) {
    state.accountActivityError[key] = e.message || 'Could not load recent transactions.';
    state.accountActivity[key] = [];
  } finally {
    state.accountActivityLoading[key] = false;
    renderAccounts();
  }
}

async function toggleAccountDetails(accountId) {
  const key = String(accountId);
  state.expandedAccounts[key] = !state.expandedAccounts[key];
  renderAccounts();
  if (!state.expandedAccounts[key]) return;
  const account = state.accounts.find(item => String(item.id) === key);
  if (account?.type === 'bank') {
    await loadAccountActivity(accountId);
  }
}

function toggleAssetSection(sectionType) {
  state.collapsedAssetSections[sectionType] = !state.collapsedAssetSections[sectionType];
  renderAccounts();
}

function renderAccountCard(account, { readOnly, typeColors }) {
  const accountKey = String(account.id);
  const accountId = Number(account.id);
  const isLoan = account.type === 'loan';
  const isShares = account.type === 'shares';
  const isMetal = account.type === 'metal';
  const balance = accountBalancePresentation(account);
  const canExpand = !readOnly && (account.type === 'bank' || account.type === 'loan' || account.type === 'shares');
  const isExpanded = canExpand && !!state.expandedAccounts[accountKey];
  const subtitle = compactAssetSubtitle(account, readOnly);
  const nativeCurrency = escapeHtml(account.currency || (isShares ? (account.purchase_price_currency || shareExchangeCurrency(account.exchange)) : 'Mixed'));
  const accountName = escapeHtml(account.name);
  const subtitleHtml = subtitle ? `<p class="mt-1 text-xs text-slate-400">${escapeHtml(subtitle)}</p>` : '';
  const expandedHtml = isExpanded
    ? renderExpandedAssetDetails(account, { readOnly, accountKey, numericAccountId: accountId })
    : '';

  return `
    <div class="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-800 shadow-lg shadow-slate-950/20">
      <div class="px-5 py-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <p class="font-medium">${accountName}</p>
              <span class="text-xs px-2 py-0.5 rounded-full ${typeColors[account.type] || 'bg-slate-500/20 text-slate-400'}">${isMetal ? escapeHtml(metalLabel(account)) : escapeHtml(typeLabel(account.type))}</span>
            </div>
            ${subtitleHtml}
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              ${!isMetal ? `<span>Native: <span class="text-slate-300">${nativeCurrency}</span></span>` : ''}
              ${isMetal && account.quantity_grams != null ? `<span>Quantity: <span class="text-slate-300">${Number(account.quantity_grams).toLocaleString()}g</span></span>` : ''}
              ${account.type === 'shares' && account.stock_code ? `<span>Ticker: <span class="text-slate-300">${escapeHtml(account.stock_code)}</span></span>` : ''}
              ${account.type === 'loan' && account.remaining_tenure != null ? `<span>Tenure: <span class="text-slate-300">${escapeHtml(account.remaining_tenure)} mo</span></span>` : ''}
            </div>
          </div>
          <div class="shrink-0 text-right">
            <p class="text-sm font-semibold ${balance.className}">${balance.value}</p>
            <p class="text-xs text-slate-500">${escapeHtml(balance.label)}</p>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/70 bg-slate-900/35 px-5 py-3">
        <div class="text-[11px] uppercase tracking-[0.2em] text-slate-500">
          ${canExpand ? (isExpanded ? 'Expanded details' : 'Compact overview') : 'Compact overview'}
        </div>
        ${readOnly ? `
          <div class="text-xs text-slate-500 px-3 py-1.5 rounded-lg bg-slate-900/50 border border-slate-700/70">View only</div>` : `
          <div class="flex flex-wrap items-center gap-2">
            ${!isMetal ? `<button onclick="openAddEntry(${accountId})" class="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">+ Entry</button>` : ''}
            ${!isMetal ? `<button onclick="viewHistory(${accountId})" class="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">History</button>` : ''}
            ${isLoan ? `<button id="emi-btn-${accountId}" onclick="applyEmi(${accountId})" class="text-xs text-orange-300 hover:text-white px-3 py-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-700 transition-colors">Pay EMI</button>` : ''}
            ${isMetal ? `<button data-refresh="${accountId}" onclick="refreshPrice(${accountId})" class="text-xs text-yellow-300 hover:text-white px-3 py-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-700 transition-colors">↻ Refresh Price</button>` : ''}
            ${canExpand ? `<button onclick='toggleAccountDetails(${JSON.stringify(accountKey)})' class="text-xs text-slate-300 hover:text-white px-3 py-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-700 transition-colors">${isExpanded ? 'Hide details' : 'Details'}</button>` : ''}
            <button onclick="openAccountModal(${accountId})" class="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Edit</button>
            <button onclick="deleteAccount(${accountId})" class="text-xs text-rose-400 hover:text-rose-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Delete</button>
          </div>`}
      </div>
      ${expandedHtml}
    </div>
  `;
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
    metal: 'bg-yellow-500/20 text-yellow-400',
  };
  const sections = [
    { type: 'bank', title: 'Bank Accounts', accent: 'text-emerald-300' },
    { type: 'shares', title: 'Shares', accent: 'text-indigo-300' },
    { type: 'investment_group', title: 'Investment Accounts', accent: 'text-blue-300' },
    { type: 'metal', title: 'Metals', accent: 'text-yellow-300' },
    { type: 'loan', title: 'Loans', accent: 'text-orange-300' },
  ];

  list.innerHTML = sections
    .map(section => {
      const accounts = state.accounts.filter(account => account.type === section.type);
      if (!accounts.length) return '';
      const isCollapsed = !!state.collapsedAssetSections[section.type];
      const summary = assetSectionSummary(section.type, accounts);
      const cards = accounts
        .map(account => renderAccountCard(account, { readOnly, typeColors }))
        .join('');
      const countLabel = `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`;
      return `
        <section class="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900/35 shadow-lg shadow-slate-950/20">
          <button
            type="button"
            onclick='toggleAssetSection(${JSON.stringify(section.type)})'
            class="w-full flex items-center justify-between gap-3 px-4 py-4 text-left transition-colors ${isCollapsed ? 'bg-slate-800/78 hover:bg-slate-800/95' : 'border-b border-slate-700/80 bg-slate-800/95'}"
            aria-expanded="${isCollapsed ? 'false' : 'true'}"
          >
            <div>
              <h3 class="text-sm font-semibold uppercase tracking-[0.24em] ${section.accent}">${escapeHtml(section.title)}</h3>
              <p class="text-xs text-slate-500">${countLabel}</p>
            </div>
            <div class="flex items-center gap-3">
              ${isCollapsed ? `
                <div class="text-right">
                  <p class="text-sm font-semibold ${summary.className}">${summary.value}</p>
                  <p class="text-[11px] text-slate-500">${escapeHtml(summary.label)}</p>
                </div>
              ` : ''}
              <span class="text-xs text-slate-500">${isCollapsed ? 'Expand' : 'Collapse'}</span>
              <span class="text-lg leading-none text-slate-400">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
            </div>
          </button>
          ${isCollapsed ? '' : `<div class="bg-slate-950/45 px-3 py-3"><div class="space-y-2">${cards}</div></div>`}
        </section>
      `;
    })
    .filter(Boolean)
    .join('');
}

function onAccTypeChange() {
  const type = document.getElementById('accType').value;
  document.getElementById('accCurrencyRow').classList.toggle('hidden', type === 'shares' || type === 'metal');
  document.getElementById('loanFields').classList.toggle('hidden', type !== 'loan');
  document.getElementById('shareFields').classList.toggle('hidden', type !== 'shares');
  document.getElementById('metalFields').classList.toggle('hidden', type !== 'metal');
  if (type === 'shares') syncShareDefaultsFromExchange();
}

function setMetalType(type) {
  document.getElementById('metalType').value = type;
  const isGold = type === 'gold';
  document.getElementById('metalGoldBtn').className =
    'px-5 py-1.5 rounded-md text-sm font-medium transition-colors ' +
    (isGold ? 'bg-yellow-500/20 text-yellow-300' : 'text-slate-400 hover:text-white');
  document.getElementById('metalSilverBtn').className =
    'px-5 py-1.5 rounded-md text-sm font-medium transition-colors ' +
    (!isGold ? 'bg-slate-400/20 text-slate-200' : 'text-slate-400 hover:text-white');
  // Show/hide holding type row (only relevant for gold)
  document.getElementById('metalHoldingRow').classList.toggle('hidden', !isGold);
}

function setMetalHolding(type) {
  document.getElementById('metalHolding').value = type;
  const map = {
    jewellery:   'metalHoldingJewellery',
    digital_gold: 'metalHoldingDigital',
    physical:    'metalHoldingPhysical',
  };
  Object.entries(map).forEach(([key, btnId]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const active = key === type;
    btn.className = 'px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors ' +
      (active
        ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-200'
        : 'border-slate-600 text-slate-400 hover:text-white');
  });
}

function syncShareDefaultsFromExchange(force = false) {
  const exchangeSelect = document.getElementById('shareExchange');
  const currencySelect = document.getElementById('sharePurchasePriceCurrency');
  if (!exchangeSelect || !currencySelect) return;
  if (force || currencySelect.value !== shareExchangeCurrency(exchangeSelect.value)) {
    currencySelect.value = shareExchangeCurrency(exchangeSelect.value);
  }
  const accountCurrencySelect = document.getElementById('accCurrency');
  if (accountCurrencySelect && document.getElementById('accType')?.value === 'shares') {
    accountCurrencySelect.value = currencySelect.value;
  }
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
    document.getElementById('accCurrency').value = acc.currency || 'USD';
    const isLoan = acc.type === 'loan';
    const isShares = acc.type === 'shares';
    const isMetal = acc.type === 'metal';
    document.getElementById('accCurrencyRow').classList.toggle('hidden', isShares || isMetal);
    document.getElementById('loanFields').classList.toggle('hidden', !isLoan);
    document.getElementById('shareFields').classList.toggle('hidden', !isShares);
    document.getElementById('metalFields').classList.toggle('hidden', !isMetal);
    if (isLoan) {
      document.getElementById('loanRate').value = acc.interest_rate ?? '';
      document.getElementById('loanTenure').value = acc.remaining_tenure ?? '';
      document.getElementById('loanEMI').value = acc.monthly_emi_native ?? '';
      document.getElementById('loanPrincipal').value = acc.remaining_principal_native ?? '';
    }
    if (isShares) {
      document.getElementById('shareStockName').value = acc.stock_name || '';
      document.getElementById('shareExchange').value = acc.exchange || 'DFM';
      document.getElementById('shareStockCode').value = acc.stock_code || '';
      document.getElementById('shareQty').value = acc.quantity ?? '';
      document.getElementById('sharePurchasePrice').value = acc.purchase_price ?? '';
      const sharePurchaseCurrency = document.getElementById('sharePurchasePriceCurrency');
      if (sharePurchaseCurrency) {
        const currency = acc.purchase_price_currency || shareExchangeCurrency(acc.exchange);
        sharePurchaseCurrency.value = currency;
      }
    }
    if (isMetal) {
      setMetalType(acc.metal_type || 'gold');
      setMetalHolding(acc.holding_type || 'jewellery');
      document.getElementById('metalGrams').value = acc.quantity_grams ?? '';
    }
  } else {
    document.getElementById('accName').value = '';
    document.getElementById('accType').value = 'bank';
    document.getElementById('accInstitution').value = '';
    document.getElementById('accCurrency').value = state.currency;
    document.getElementById('accCurrencyRow').classList.remove('hidden');
    document.getElementById('loanFields').classList.add('hidden');
    document.getElementById('shareFields').classList.add('hidden');
    document.getElementById('metalFields').classList.add('hidden');
    ['loanRate', 'loanTenure', 'loanEMI', 'loanPrincipal', 'shareStockName', 'shareStockCode', 'shareQty', 'sharePurchasePrice', 'metalGrams'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('shareExchange').value = 'DFM';
    setMetalType('gold');
    setMetalHolding('jewellery');
    const sharePurchaseCurrency = document.getElementById('sharePurchasePriceCurrency');
    if (sharePurchaseCurrency) {
      syncShareDefaultsFromExchange(true);
    }
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
  const saveBtn = document.getElementById('accountSaveBtn');

  const payload = { name, type, institution };
  if (type !== 'shares' && type !== 'metal') payload.currency = document.getElementById('accCurrency').value;
  if (type === 'loan') {
    payload.interest_rate = parseFloat(document.getElementById('loanRate').value) || 0;
    payload.remaining_tenure = parseInt(document.getElementById('loanTenure').value) || 0;
    payload.monthly_emi = parseFloat(document.getElementById('loanEMI').value) || 0;
    payload.remaining_principal = parseFloat(document.getElementById('loanPrincipal').value) || 0;
  }
  if (type === 'shares') {
    const purchasePriceInput = document.getElementById('sharePurchasePrice').value.trim();
    if (!purchasePriceInput) {
      alert('Purchase price is required for shares.');
      return;
    }
    payload.stock_name = document.getElementById('shareStockName').value.trim();
    payload.exchange = document.getElementById('shareExchange').value;
    payload.stock_code = document.getElementById('shareStockCode').value.trim().toUpperCase();
    payload.quantity = parseFloat(document.getElementById('shareQty').value) || 0;
    payload.purchase_price = parseFloat(purchasePriceInput);
    payload.purchase_price_currency = shareExchangeCurrency(payload.exchange);
  }
  if (type === 'metal') {
    const grams = parseFloat(document.getElementById('metalGrams').value) || 0;
    if (!grams) { alert('Please enter the quantity in grams.'); return; }
    payload.metal_type = document.getElementById('metalType').value;
    payload.holding_type = payload.metal_type === 'gold'
      ? document.getElementById('metalHolding').value
      : null;
    payload.quantity_grams = grams;
    payload.currency = state.currency; // use display currency
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }
  try {
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
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
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

async function applyEmi(accountId) {
  const btn = document.getElementById(`emi-btn-${accountId}`);
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const res = await api(`/api/accounts/${accountId}/apply-emi`, 'POST');
    if (!res.ok) throw new Error(res.error || 'Unknown error');
    // Update account in state directly so re-render is instant
    const idx = state.accounts.findIndex(a => a.id === accountId);
    if (idx !== -1) state.accounts[idx] = res.account;
    renderAccounts();
    await loadDashboard();
    const tenure = res.new_tenure;
    const msg = tenure <= 0
      ? `🎉 Loan fully paid off!`
      : `EMI applied.\n• Principal paid: ${moneyFromStored(res.principal_paid, res.account?.currency)}\n• Interest: ${moneyFromStored(res.interest, res.account?.currency)}\n• Outstanding: ${moneyFromStored(res.new_principal, res.account?.currency)}\n• Months remaining: ${tenure}`;
    alert(msg);
  } catch (e) {
    alert(`EMI failed:\n${e.message}`);
    if (btn) { btn.textContent = 'Pay EMI'; btn.disabled = false; }
  }
}

async function deleteAccount(id) {
  if (!requireSingleUserSelection()) return;
  if (!confirm('Remove this asset?')) return;
  await api(`/api/accounts/${id}`, 'DELETE');
  await loadAccounts();
  await loadDashboard();
}

async function viewHistory(accountId) {
  if (!requireSingleUserSelection('Switch to My Profile to view account history.')) return;
  const entries = await api(withScopeQuery('/api/balances', { account_id: accountId }));
  const account = state.accounts.find(item => Number(item.id) === Number(accountId));
  document.getElementById('historyModalTitle').textContent = `${account?.name || 'Account'} — History`;
  const list = document.getElementById('historyList');
  if (!entries.length) {
    list.innerHTML = '<p class="text-slate-500 text-sm">No entries yet.</p>';
  } else {
      list.innerHTML = entries.map(e => {
      const noteHtml = e.note ? `<p class="text-xs text-slate-400">${escapeHtml(e.note)}</p>` : '';
      return `
        <div class="flex items-center justify-between py-3 border-b border-slate-700 last:border-0">
          <div>
            <p class="text-sm font-semibold">${moneyFromStored(e.amount, e.amount_currency, e.amount_usd)}</p>
            ${noteHtml}
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-slate-400">${dateHtml(e.recorded_at)}</span>
            <button onclick="deleteEntry(${Number(e.id)})" class="text-rose-400 hover:text-rose-300 text-xs">Delete</button>
          </div>
        </div>
      `;
    }).join('');
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
    const bucketId = Number(b.id);
    const summary = getBucketSummaryForView(b);
    const allocated = summary?.allocated ?? 0;
    const target = summary?.target ?? b.target ?? 0;
    const pct = target ? Math.min(100, (allocated / target) * 100) : null;
    const mergedLabel = readOnly && b._merged_count ? `Merged across ${formatUserBadgeLabel(b._merged_count)}` : '';
    const bucketColor = safeColor(b.color);
    const bucketName = escapeHtml(b.name);
    return `
      <div class="bg-slate-800 rounded-xl px-5 py-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <span class="inline-block w-3 h-3 rounded-full" style="background:${bucketColor}"></span>
            <div>
              <p class="font-medium flex items-center gap-2">
                <span>${bucketName}</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full ${bucketTypeClass(bucketAllocationType(b))}">${bucketTypeLabel(bucketAllocationType(b))}</span>
              </p>
              <p class="text-xs text-slate-400">
                ${target ? `Allocated ${money(allocated)} of ${money(target)}` : `Allocated ${money(allocated)}`}
                ${mergedLabel ? ` · ${escapeHtml(mergedLabel)}` : ''}
              </p>
            </div>
          </div>
          ${readOnly ? `
          <div class="text-xs text-slate-500 px-3 py-1.5 rounded-lg bg-slate-900/40 border border-slate-700/70">View only</div>` : `
          <div class="flex items-center gap-2">
            <button onclick="openBucketAllocate(${bucketId})" class="text-xs text-emerald-400 hover:text-emerald-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Allocate</button>
            <button onclick="openBucketModal(${bucketId})" class="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Edit</button>
            <button onclick="deleteBucket(${bucketId})" class="text-xs text-rose-400 hover:text-rose-300 px-3 py-1.5 rounded-lg hover:bg-slate-700 transition-colors">Delete</button>
          </div>`}
        </div>
        ${pct !== null ? `
        <div class="mt-3 h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div class="h-full rounded-full progress-bar" style="width:${pct}%;background:${bucketColor}"></div>
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
  setSelectOptions(sel, manualAssets.map(a => ({
    value: a.id,
    label: `${a.name} (${typeLabel(a.type)})`,
    selected: a.id == accountId,
  })));
  if (!manualAssets.length) {
    alert('Add a Bank Account or Investment Group asset first.\n(Shares are tracked automatically via price refresh.)');
    switchTab('accounts');
    return;
  }

  document.getElementById('entAmount').value = '';
  document.getElementById('entDate').value = nowLocal();
  document.getElementById('entNote').value = '';
  document.getElementById('allocRemaining').textContent = '';
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
  const entCurrSel = document.getElementById('entAmountCurrency');
  if (entCurrSel) {
    entCurrSel.value = selectedAccount?.currency || state.currency;
  }

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
      <span class="inline-block w-2 h-2 rounded-full" style="background:${safeColor(b.color)}"></span>
      <span class="text-sm flex-1">${escapeHtml(b.name)}</span>
      <div class="relative">
        <span class="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">${sym}</span>
        <input type="number" step="0.01" placeholder="0.00"
          id="alloc_${b.id}"
          value="${escapeHtml(existingValues[b.id] || '')}"
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
  const account = getAccountById(account_id);
  if (!account) return;

  const entryCurrency = account.currency || document.getElementById('entAmountCurrency')?.value || state.currency;
  const amount = rawAmount;
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
          enabled: false,
          external: makeExternalTooltipHandler(),
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

let _ratesFetchedAt = 0;
const _RATES_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchRates(force = false) {
  const now = Date.now();
  if (!force && _ratesFetchedAt && (now - _ratesFetchedAt) < _RATES_TTL_MS) return;
  try {
    const data = await api('/api/rates');
    state.rates = { ...data.rates, USD: 1 };
    _ratesFetchedAt = Date.now();
    const rate = state.rates[state.currency] || 1;
    const symbols = { AED: 'د.إ', INR: '₹', USD: '$' };
    const label = document.getElementById('rateLabel');
    if (!label) return;
    if (data.date) {
      label.textContent = `1 USD = ${symbols[state.currency]}${rate.toFixed(4)} · ${data.date}`;
    } else {
      label.textContent = `1 USD = ${symbols[state.currency]}${rate.toFixed(4)} (fallback)`;
    }
  } catch (e) {
    console.warn('Rate fetch failed', e);
  }
}

// Silently refresh rates every 10 minutes while the app is open
setInterval(() => {
  if (state.session?.logged_in) fetchRates();
}, _RATES_TTL_MS);

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

let _currencyDebounceTimer = null;
function setCurrency(c) {
  state.currency = c;
  document.querySelectorAll('.currency-btn').forEach(btn => {
    const isActive = btn.id === `btn-${c}`;
    btn.classList.toggle('bg-slate-600', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('text-slate-400', !isActive);
  });
  const symbols = { AED: 'د.إ', INR: '₹', USD: '$' };
  const rate = state.rates[c] || 1;
  const label = document.getElementById('rateLabel');
  if (label) {
    const existing = label.textContent;
    if (existing) {
      label.textContent = existing.replace(/[^\s]+(?=\s(?:·|\(fallback\))|$)/, `${symbols[c]}${rate.toFixed(4)}`);
    }
  }
  updateCurrencyLabels();
  renderAccounts();

  // Re-render dashboard purely from cached state — no server call needed
  if (state.netWorthSummary && state.bucketSummary) {
    document.getElementById('netWorthTotal').textContent = money(state.netWorthSummary.total);
    document.getElementById('unallocatedCashTotal').textContent = money(state.netWorthSummary.unallocated_cash || 0);
    // Re-render bucket summary bars with new currency
    if (state.bucketSummary.length) {
      renderBuckets();
    }
  }

  if (state.session?.logged_in) {
    // Persist default currency preference with debounce
    clearTimeout(_currencyDebounceTimer);
    _currencyDebounceTimer = setTimeout(() => {
      api('/api/user/preferences', 'PATCH', { default_currency: c }).catch(() => {});
      if (state.session?.user) state.session.user.default_currency = c;
    }, 400);
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
  return { credit: 'Credit', debit: 'Debit', intra: 'Transfer' }[t] || 'Other';
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
    const txnId = Number(txn.id);
    const fromName = escapeHtml(txn.from_account_name || txn.counterparty || '—');
    const toName = escapeHtml(txn.to_account_name || txn.counterparty || '—');
    const counterparty = escapeHtml(txn.counterparty || 'External');
    let flowHtml = '';
    if (txn.txn_type === 'credit') {
      flowHtml = `<span class="text-slate-400">${counterparty}</span> → <span class="text-white font-medium">${toName}</span>`;
    } else if (txn.txn_type === 'debit') {
      flowHtml = `<span class="text-white font-medium">${fromName}</span> → <span class="text-slate-400">${counterparty}</span>`;
    } else {
      flowHtml = `<span class="text-white font-medium">${fromName}</span> → <span class="text-white font-medium">${toName}</span>`;
    }

    const amtClass = txn.txn_type === 'debit' ? 'text-rose-300' : 'text-emerald-300';
    const amtPrefix = txn.txn_type === 'debit' ? '−' : '+';
    const deleteBtn = !isAllUsersView()
      ? `<button onclick="deleteTransaction(${txnId})" class="ml-3 text-slate-500 hover:text-rose-400 text-xs transition-colors">Delete</button>`
      : '';
    const noteHtml = txn.note ? `<p class="text-xs text-slate-400 truncate mt-0.5">${escapeHtml(txn.note)}</p>` : '';
    const primaryAmount = txn.txn_type === 'credit'
      ? (txn.destination_amount != null ? `${amtPrefix}${moneyInCurrency(txn.destination_amount, txn.destination_currency || 'USD')}` : `${amtPrefix}${money(txn.amount)}`)
      : txn.txn_type === 'debit'
        ? (txn.source_amount != null ? `${amtPrefix}${moneyInCurrency(txn.source_amount, txn.source_currency || 'USD')}` : `${amtPrefix}${money(txn.amount)}`)
        : (txn.source_amount != null && txn.destination_amount != null
          ? `${moneyInCurrency(txn.source_amount, txn.source_currency || 'USD')} → ${moneyInCurrency(txn.destination_amount, txn.destination_currency || 'USD')}`
          : money(txn.amount));
    const secondaryAmount = txn.txn_type === 'intra' && txn.fx_rate && txn.source_currency && txn.destination_currency && txn.source_currency !== txn.destination_currency
      ? `FX ${Number(txn.fx_rate).toFixed(4)} ${txn.destination_currency} / ${txn.source_currency}`
      : (txn.amount != null ? `~ ${money(txn.amount)}` : '');

    return `
      <div class="bg-slate-700/50 rounded-xl px-4 py-3 flex items-center gap-3">
        <span class="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${txnTypeClass(txn.txn_type)}">${escapeHtml(txnTypeLabel(txn.txn_type))}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm">${flowHtml}</div>
          ${noteHtml}
        </div>
        <div class="text-right shrink-0">
          <p class="text-sm font-semibold ${amtClass}">${escapeHtml(primaryAmount)}</p>
          ${secondaryAmount ? `<p class="text-[11px] text-slate-500">${escapeHtml(secondaryAmount)}</p>` : ''}
          <p class="text-xs text-slate-500">${dateHtml(txn.recorded_at)}</p>
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
  onTransactionAccountChange();
}

function populateTxnAccountSelects() {
  const myAccounts = state.accounts.filter(a => !isAllUsersView() || a);
  const options = myAccounts
    .filter(a => typeof a.id === 'number') // skip merged entries from all-users view
    .map(a => ({ value: a.id, label: `${a.name} (${typeLabel(a.type)} · ${a.currency || 'USD'})` }));

  const fromSel = document.getElementById('txnFrom');
  const toSel = document.getElementById('txnTo');
  if (fromSel) setSelectOptions(fromSel, [{ value: '', label: '— select account —' }, ...options]);
  if (toSel) setSelectOptions(toSel, [{ value: '', label: '— select account —' }, ...options]);
}

function onTransactionAccountChange() {
  const type = state.txnType;
  const fromAccount = getAccountById(parseInt(document.getElementById('txnFrom')?.value));
  const toAccount = getAccountById(parseInt(document.getElementById('txnTo')?.value));
  const txnCurrSel = document.getElementById('txnAmountCurrency');
  const fxSection = document.getElementById('txnFxSection');
  const fxRateInput = document.getElementById('txnFxRate');
  const fxHint = document.getElementById('txnFxHint');

  if (type === 'credit' && txnCurrSel) {
    txnCurrSel.value = toAccount?.currency || state.currency;
  } else if ((type === 'debit' || type === 'intra') && txnCurrSel) {
    txnCurrSel.value = fromAccount?.currency || state.currency;
  }

  const showFx = type === 'intra'
    && fromAccount
    && toAccount
    && fromAccount.currency
    && toAccount.currency
    && fromAccount.currency !== toAccount.currency;

  if (fxSection) fxSection.classList.toggle('hidden', !showFx);
  if (showFx && fxRateInput) {
    fxRateInput.value = (state.rates[toAccount.currency] / (state.rates[fromAccount.currency] || 1)).toFixed(6);
    if (fxHint) fxHint.textContent = `1 ${fromAccount.currency} = ${fxRateInput.value} ${toAccount.currency}`;
  } else if (fxHint) {
    fxHint.textContent = '';
  }
  updateTransactionFxPreview();
}

function updateTransactionFxPreview() {
  const preview = document.getElementById('txnFxPreview');
  const fxSection = document.getElementById('txnFxSection');
  if (!preview || !fxSection || fxSection.classList.contains('hidden')) {
    if (preview) preview.textContent = '';
    return;
  }
  const fromAccount = getAccountById(parseInt(document.getElementById('txnFrom')?.value));
  const toAccount = getAccountById(parseInt(document.getElementById('txnTo')?.value));
  const amount = parseFloat(document.getElementById('txnAmount')?.value) || 0;
  const fxRate = parseFloat(document.getElementById('txnFxRate')?.value) || 0;
  if (!fromAccount || !toAccount || !amount || !fxRate) {
    preview.textContent = '';
    return;
  }
  preview.textContent = `${moneyInCurrency(amount, fromAccount.currency)} -> ${moneyInCurrency(amount * fxRate, toAccount.currency)}`;
}

function openTransactionModal() {
  if (!requireSingleUserSelection()) return;
  // Reset
  document.getElementById('txnCounterparty').value = '';
  document.getElementById('txnAmount').value = '';
  document.getElementById('txnNote').value = '';
  document.getElementById('txnDate').value = nowLocal();
  document.getElementById('txnError').textContent = '';
  document.getElementById('txnFxRate').value = '';
  document.getElementById('txnFxHint').textContent = '';
  document.getElementById('txnFxPreview').textContent = '';

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

  if (!amountDisplay || amountDisplay <= 0) { errorEl.textContent = 'Enter a valid amount greater than zero.'; return; }

  const fromAccount = from_account_id ? getAccountById(from_account_id) : null;
  const toAccount = to_account_id ? getAccountById(to_account_id) : null;
  const showFx = type === 'intra' && fromAccount && toAccount && fromAccount.currency !== toAccount.currency;
  let fxRate = null;
  if (showFx) {
    fxRate = parseFloat(document.getElementById('txnFxRate').value) || 0;
    if (!fxRate || fxRate <= 0) {
      errorEl.textContent = 'Enter a valid FX rate.';
      return;
    }
  }

  try {
    await api('/api/transactions', 'POST', {
      txn_type: type,
      amount: amountDisplay,
      from_account_id,
      to_account_id,
      fx_rate: fxRate,
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

const _ONBOARDING_KEY = 'sof_onboarding_v2';

function _getStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function _setStoredValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function _featureAnnouncementKey() {
  const userId = state.session?.user?.id || 'guest';
  return `${FEATURE_ANNOUNCEMENT_KEY_PREFIX}_${userId}`;
}

function _markFeatureAnnouncementSeen() {
  _setStoredValue(_featureAnnouncementKey(), new Date().toISOString());
}

function maybeShowNewFeatureAnnouncement() {
  if (_getStoredValue(_featureAnnouncementKey())) return false;

  alert([
    'New features in State of Finance',
    '',
    '1. Zakaat page: calculate the Zakaat due from your cash, shares, gold, silver, deductions, Hawl date, and Nisab standard.',
    '',
    '2. Metals as assets: add gold and silver holdings from the Assets page. Gold can be Jewellery, Digital Gold, or Physical, and silver is tracked by grams.',
    '',
    'A short coach tour will highlight where to find these updates.'
  ].join('\n'));

  _markFeatureAnnouncementSeen();
  setTimeout(startFeatureCoachMarks, 350);
  return true;
}

// Each step: { tab, target (CSS selector|null), placement, title, desc, isLast }
const COACH_STEPS = [
  {
    tab: 'dashboard',
    target: null,
    placement: 'center',
    title: '👋 Welcome to State of Finance',
    desc: 'Your personal wealth tracker for households managing cash, investments, shares, metals, and loans across currencies.\n\nThis quick tour walks through the current workflows, including the new Zakaat calculator and gold/silver asset tracking. You can skip at any time.',
  },
  {
    tab: 'dashboard',
    target: '#currencyToggleGroup',
    placement: 'bottom',
    title: '💱 Set Your Default Currency',
    desc: 'Switch between AED, INR, and USD at any time. The dashboard, bucket targets, and summaries all re-render instantly in your chosen display currency.\n\nYour selection is saved to your profile, and the rate label beside it shows the latest conversion snapshot the app is using.',
  },
  {
    tab: 'dashboard',
    target: '#scopeSelect',
    placement: 'bottom',
    title: '👥 Personal vs Family View',
    desc: '"My Profile" is your editable workspace for creating assets, buckets, entries, and transactions.\n\n"All Users" rolls matching family data into a merged household view. It is intentionally read-only, so add/edit/delete buttons dim until you switch back to My Profile.',
  },
  {
    tab: 'dashboard',
    target: '#netWorthTotal',
    placement: 'bottom',
    title: '💰 Total Net Worth',
    desc: 'This is your latest household snapshot: bank balances, investment groups, and current share market values, minus outstanding loan principal.\n\nIt refreshes when you save balance entries, post transactions, apply EMI payments, or refresh share prices.',
  },
  {
    tab: 'dashboard',
    target: '#unallocatedCashTotal',
    placement: 'bottom',
    title: '🏦 Unallocated Cash',
    desc: 'This is the portion of current bank cash that is not already assigned to buckets.\n\nManual bucket allocation and Auto Allocate both pull from this pool, so it is the fastest way to see how much cash is still free for new goals.',
  },
  {
    tab: 'dashboard',
    target: '#byTypeBreakdown',
    placement: 'top',
    title: '📊 Asset Type Breakdown',
    desc: 'See how your wealth is split across Bank Accounts, Investment Accounts, Shares, Metals, and Loans.\n\nUse this to spot concentration, debt drag, or whether most of your net worth is sitting as cash instead of being allocated deliberately.',
  },
  {
    tab: 'dashboard',
    target: '#bucketSummary',
    placement: 'top',
    title: '🎯 Bucket Allocation Snapshot',
    desc: 'This dashboard block shows each goal\'s current funding progress and whether it is Manual Allocate or Auto Allocate.\n\nIt is the quickest way to check which goals are full, which still need cash, and how your latest bank balances are being spoken for.',
  },
  {
    tab: 'dashboard',
    target: '#recentEntries',
    placement: 'top',
    title: '📋 Recent Balance Entries',
    desc: 'This is the audit trail behind your net worth: manual balance snapshots plus balance entries that transactions create automatically behind the scenes.\n\nIf a number looks unexpected, this list is the first place to check what changed and when.',
  },
  {
    tab: 'dashboard',
    target: '#mainAddEntryBtn',
    placement: 'bottom',
    title: '➕ Add Balance Entry',
    desc: 'Use this for manual snapshots on Bank Accounts and Investment Accounts.\n\nIf you pick a bank account, the form can also split part of that balance into Manual Allocate buckets. The amount always uses the selected asset\'s native currency, not a free-form per-entry currency.',
  },
  {
    tab: 'accounts',
    target: '[data-tab="accounts"]',
    placement: 'bottom',
    title: '🏛️ Assets Tab',
    desc: 'Everything you own or owe lives here, grouped by type: Bank Accounts, Shares, Investment Accounts, Metals, and Loans.\n\nIn All Users mode, matching family assets are merged into view-only cards so you can review household totals without editing anyone else\'s data.',
  },
  {
    tab: 'accounts',
    target: '#addAssetBtn',
    placement: 'bottom',
    title: '+ Add Asset',
    desc: 'Create a bank account, investment account, share holding, metal holding, or loan here.\n\nShares capture exchange, ticker, quantity, and purchase price before the latest market price is fetched on save. Loans store EMI, tenure, interest rate, and remaining principal.',
  },
  {
    tab: 'accounts',
    target: '#addAssetBtn',
    placement: 'bottom',
    title: '🥇 New: Gold And Silver Assets',
    desc: 'Choose Metals from the asset type menu to add gold or silver holdings by grams.\n\nGold supports Jewellery, Digital Gold, and Physical holdings. Silver is tracked by grams. The app fetches metal prices and creates the current asset value automatically.',
  },
  {
    tab: 'accounts',
    target: '#accountsList',
    placement: 'top',
    title: '🧾 Asset Cards And Details',
    desc: 'Each asset card keeps the quick actions together: add an entry, open History, edit, or delete.\n\nUse Details to expand deeper context. Bank accounts reveal recent transactions, loans show repayment data and Pay EMI, and shares show P/L plus Refresh Price.',
  },
  {
    tab: 'buckets',
    target: '[data-tab="buckets"]',
    placement: 'bottom',
    title: '🪣 Buckets Tab',
    desc: 'Buckets are your named reserves or goals: Emergency Fund, School Fees, Travel, Taxes, and more.\n\nThe tag on each bucket tells you whether it expects manual funding or participates in the automatic allocation workflow.',
  },
  {
    tab: 'buckets',
    target: '#addBucketBtn',
    placement: 'bottom',
    title: '+ Add Bucket',
    desc: 'Create a bucket with a name, target, color, and allocation type.\n\nManual Allocate buckets are funded intentionally by you. Auto Allocate buckets are recalculated from current bank cash whenever you run the Allocate action.',
  },
  {
    tab: 'buckets',
    target: '#autoAllocateBtn',
    placement: 'bottom',
    title: '⚡ Auto Allocate',
    desc: 'This recalculates every Auto Allocate bucket from your latest bank balances in one shot.\n\nIt is especially useful after a salary credit or a fresh bank snapshot, because it refreshes goal funding without touching Manual Allocate buckets.',
  },
  {
    tab: 'buckets',
    target: '#bucketsList',
    placement: 'top',
    title: '🎯 Bucket Actions',
    desc: 'Use Allocate on a Manual Allocate bucket to move some of today\'s unallocated cash into that goal.\n\nIf the bucket is Auto Allocate, the same button reruns the automatic allocation logic instead. In All Users mode, this area stays view-only.',
  },
  {
    tab: 'transactions',
    target: '[data-tab="transactions"]',
    placement: 'bottom',
    title: '💸 Transactions Tab',
    desc: 'Transactions are the fastest way to keep balances current when money is actually moving.\n\nCredits, debits, and transfers automatically create the linked balance changes for you, so totals and recent entries stay in sync without separate manual snapshots.',
  },
  {
    tab: 'transactions',
    target: '#addTransactionBtn',
    placement: 'bottom',
    title: '+ New Transaction — 3 Types',
    desc: '• Credit puts money into one of your accounts and records the source or counterparty.\n\n• Debit removes money and blocks overspending when the source balance is too low.\n\n• Transfer moves money between your own assets, and when the two accounts use different currencies the form opens an FX rate field with a live conversion preview.',
  },
  {
    tab: 'transactions',
    target: '#transactionsList',
    placement: 'top',
    title: '📄 Transaction History',
    desc: 'Each row shows the actual money flow plus native amounts on the source and destination sides.\n\nCross-currency transfers add an FX line for quick review. Delete only appears in My Profile because removing a transaction also removes its linked balance updates.',
  },
  {
    tab: 'timeline',
    target: '[data-tab="timeline"]',
    placement: 'bottom',
    title: '📈 Timeline',
    desc: 'This tab turns your latest balance history into trends over time.\n\nYou can inspect both the total net worth line and the individual assets contributing to it, which makes it useful for spotting jumps after entries, transfers, market moves, or loan payments.',
  },
  {
    tab: 'timeline',
    target: '#timelineFiltersCard',
    placement: 'bottom',
    title: '🗓️ Timeline Filters',
    desc: 'Use Interval plus From and To to zoom in on salary cycles, quarter-end snapshots, or a single trip or goal period.\n\nClear resets the view back to the default monthly roll-up.',
  },
  {
    tab: 'timeline',
    target: '#timelineChart',
    placement: 'top',
    title: '📉 Trend Lines',
    desc: 'The white line is total net worth. The colored lines are the individual assets behind it.\n\nHover the chart to inspect exact values. Periods with no new update keep the last known balance so the trend stays readable between entries.',
  },
  {
    tab: 'zakat',
    target: '[data-tab="zakat"]',
    placement: 'bottom',
    title: '🕌 New: Zakaat Page',
    desc: 'Open Zakaat to calculate the Zakaat due from your tracked cash, shares, gold, silver, and loan deductions.\n\nYou can set Hawl start date, choose the gold or silver Nisab standard, adjust the stock zakatable rate, and add extra holdings such as receivables or business inventory.',
  },
  {
    tab: 'zakat',
    target: '#tab-zakat',
    placement: 'top',
    title: '💚 Zakaat Due Summary',
    desc: 'The summary shows total zakatable assets, deductions, Nisab value, eligibility, and the final 2.5% Zakaat due.\n\nGold and silver saved as asset holdings are pulled into this page automatically, while the manual inputs cover anything you have not added as an asset yet.',
  },
  {
    tab: 'dashboard',
    target: null,
    placement: 'center',
    title: '🎉 You\'re all set!',
    desc: 'A good first run is: add an asset → record a balance → create buckets → start using transactions for day-to-day movement.\n\nUse the ? button in the top bar anytime you want to replay this refreshed tour.',
    isLast: true,
  },
];

function _prepareFeatureCoachSurface(surface = 'default') {
  if (surface !== 'metal-modal') {
    closeModal('accountModal');
    return;
  }

  if (document.getElementById('accountModal')?.classList.contains('hidden')) {
    openAccountModal();
  }

  const typeSelect = document.getElementById('accType');
  if (typeSelect) {
    typeSelect.value = 'metal';
    onAccTypeChange();
  }
  setMetalType('gold');
  setMetalHolding('physical');
}

const FEATURE_COACH_STEPS = [
  {
    tab: 'dashboard',
    target: null,
    placement: 'center',
    title: '✨ What\'s New',
    desc: 'Two new finance workflows are now available: a Zakaat page for calculating due Zakaat, and Metals as assets for adding gold and silver holdings.\n\nThis short coach tour shows where they live.',
    beforeShow: () => _prepareFeatureCoachSurface(),
  },
  {
    tab: 'zakat',
    target: '[data-tab="zakat"]',
    placement: 'bottom',
    title: '🕌 Zakaat Calculator',
    desc: 'The Zakaat page calculates due Zakaat using your cash, shares, gold, silver, deductions, Hawl date, and Nisab settings.\n\nIt keeps the calculation visible so you can review both eligibility and the final 2.5% amount.',
    beforeShow: () => _prepareFeatureCoachSurface(),
  },
  {
    tab: 'accounts',
    target: '#addAssetBtn',
    placement: 'bottom',
    title: '🥇 Add Metals From Assets',
    desc: 'Use Add Asset to create a Metals holding. For now, the platform supports gold and silver assets.',
    beforeShow: () => _prepareFeatureCoachSurface(),
  },
  {
    tab: 'accounts',
    target: '#accType',
    placement: 'right',
    title: 'Select Metals',
    desc: 'In the asset type list, choose Metals (Gold / Silver). That reveals the metal-specific inputs in the same Add Asset form.',
    beforeShow: () => _prepareFeatureCoachSurface('metal-modal'),
  },
  {
    tab: 'accounts',
    target: '#metalFields',
    placement: 'right',
    title: 'Gold And Silver Details',
    desc: 'Pick gold or silver, enter the quantity in grams, and save. Gold can be marked as Jewellery, Digital Gold, or Physical.\n\nThe saved metal asset is valued from live metal prices and is also included in the Zakaat calculation.',
    beforeShow: () => _prepareFeatureCoachSurface('metal-modal'),
    isLast: true,
  },
];

let _coachStep = 0;
let _activeCoachSteps = COACH_STEPS;
let _activeCoachMode = 'onboarding';

function startCoachTour(steps = COACH_STEPS, mode = 'onboarding') {
  _activeCoachSteps = steps;
  _activeCoachMode = mode;
  _coachStep = 0;
  document.getElementById('coachOverlay').classList.remove('hidden');
  _showCoachStep(0);
}

function startOnboarding() {
  startCoachTour(COACH_STEPS, 'onboarding');
}

function startFeatureCoachMarks() {
  startCoachTour(FEATURE_COACH_STEPS, 'features');
}

function skipOnboarding() {
  document.getElementById('coachOverlay').classList.add('hidden');
  if (_activeCoachMode === 'onboarding') _setStoredValue(_ONBOARDING_KEY, '1');
  if (_activeCoachMode === 'features') {
    _markFeatureAnnouncementSeen();
    closeModal('accountModal');
  }
  _activeCoachSteps = COACH_STEPS;
  _activeCoachMode = 'onboarding';
  // Return to dashboard
  switchTab('dashboard');
}

function nextCoachStep() {
  if (_coachStep >= _activeCoachSteps.length - 1) {
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
  const step = _activeCoachSteps[index];
  if (!step) {
    skipOnboarding();
    return;
  }
  // Switch tab first, then position after DOM settles
  if (step.tab) switchTab(step.tab);
  if (typeof step.beforeShow === 'function') step.beforeShow();
  const delay = step.tab || step.beforeShow ? 180 : 0;
  setTimeout(() => _renderCoachStep(step, index), delay);
}

function _renderCoachStep(step, index) {
  const total = _activeCoachSteps.length;
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
  if (!_getStoredValue(_ONBOARDING_KEY)) {
    setTimeout(startOnboarding, 600);
  }
}

// ── Zakaat ────────────────────────────────────────────────────────────────────

let _zakatSaveTimer = null;

async function loadZakat() {
  const container = document.getElementById('tab-zakat');
  if (!container) return;
  container.innerHTML = `<div class="text-slate-500 text-sm py-8 text-center">Loading Zakaat data…</div>`;

  try {
    const [settings, summary] = await Promise.all([
      api('/api/zakat/settings'),
      api('/api/zakat/summary'),
    ]);
    renderZakat(settings, summary);
  } catch (e) {
    container.innerHTML = `<div class="text-rose-400 text-sm py-8 text-center">Failed to load Zakaat data: ${e.message}</div>`;
  }
}

function renderZakat(settings, summary) {
  const container = document.getElementById('tab-zakat');
  if (!container) return;

  const cur = summary.currency || 'AED';
  const fmt = (v) => moneyInCurrency(v, cur);
  const nisabGold   = summary.nisab_standard === 'gold';
  const stocks100   = summary.stocks_rate >= 0.99;
  const hawlOk      = summary.hawl_status === 'due';

  const eligibleBadge = summary.eligible
    ? `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 text-xs font-semibold">✓ Eligible for Zakaat</span>`
    : `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-700 text-slate-400 text-xs font-semibold">✗ Below Nisab — Not Eligible</span>`;

  const hawlBadge = hawlOk
    ? `<span class="text-xs text-emerald-400">✓ Hawl completed</span>`
    : summary.hawl_status === 'soon'
      ? `<span class="text-xs text-amber-400">⏳ Hawl in ${summary.days_until_hawl} days</span>`
      : summary.hawl_date
        ? `<span class="text-xs text-slate-400">📅 Hawl in ${summary.days_until_hawl} days</span>`
        : `<span class="text-xs text-slate-500">Hawl date not set</span>`;

  container.innerHTML = `
    <!-- Settings card -->
    <div class="bg-slate-800 rounded-xl p-5 mb-5">
      <h2 class="text-sm font-medium text-slate-400 mb-4 uppercase tracking-wide">Zakaat Settings</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-5">

        <!-- Hawl date -->
        <div>
          <label class="text-xs text-slate-400 block mb-1">Hawl Start Date</label>
          <input id="zakatHawlDate" type="date" value="${settings.hawl_date || ''}"
            class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
            onchange="saveZakatSetting('hawl_date', this.value)" />
          <p class="text-xs text-slate-500 mt-1">One lunar year (354 days) must pass for Zakaat to be due.</p>
        </div>

        <!-- Nisab standard toggle -->
        <div>
          <label class="text-xs text-slate-400 block mb-2">Nisab Standard</label>
          <div class="bg-slate-700 rounded-lg p-0.5 flex w-fit">
            <button id="nisabGoldBtn" onclick="setNisabStandard('gold')"
              class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${nisabGold ? 'bg-yellow-500/20 text-yellow-300' : 'text-slate-400 hover:text-white'}">
              🥇 Gold
            </button>
            <button id="nisabSilverBtn" onclick="setNisabStandard('silver')"
              class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${!nisabGold ? 'bg-slate-500/30 text-slate-200' : 'text-slate-400 hover:text-white'}">
              🥈 Silver
            </button>
          </div>
          <p class="text-xs text-slate-500 mt-1">
            ${nisabGold
              ? `Gold: 87.48g — Nisab ≈ ${fmt(summary.nisab_value)}`
              : `Silver: 612.36g — Nisab ≈ ${fmt(summary.nisab_value)}`}
          </p>
        </div>

        <!-- Stocks rate toggle -->
        <div>
          <label class="text-xs text-slate-400 block mb-2">Zakatable Stocks Rate</label>
          <div class="bg-slate-700 rounded-lg p-0.5 flex w-fit">
            <button id="stocks25Btn" onclick="setStocksRate(0.25)"
              class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${!stocks100 ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-white'}">
              25%
            </button>
            <button id="stocks100Btn" onclick="setStocksRate(1.0)"
              class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${stocks100 ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-white'}">
              100%
            </button>
          </div>
          <p class="text-xs text-slate-500 mt-1">
            ${stocks100 ? 'Full stock value is zakatable.' : '25% of stock value (for trading portfolios).'}
          </p>
        </div>
      </div>
    </div>

    <!-- Two-column layout: Inputs + Auto-pulled -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">

      <!-- Manual inputs card -->
      <div class="bg-slate-800 rounded-xl p-5">
        <h2 class="text-sm font-medium text-slate-400 mb-4 uppercase tracking-wide">Your Holdings</h2>
        <div class="space-y-4">

          <!-- Gold grams -->
          <div>
            <label class="text-xs text-slate-400 block mb-1">Total Gold (grams)</label>
            <input id="zakatGoldGrams" type="number" min="0" step="0.1"
              value="${settings.gold_grams || 0}"
              class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              onchange="saveZakatSetting('gold_grams', parseFloat(this.value)||0)" />
          </div>

          <!-- Jewellery grams -->
          <div>
            <label class="text-xs text-slate-400 block mb-1">
              Of which Personal Jewellery (grams)
              <span class="text-slate-500 ml-1 font-normal">— deducted from total gold</span>
            </label>
            <input id="zakatJewelleryGrams" type="number" min="0" step="0.1"
              value="${settings.gold_jewellery_grams || 0}"
              class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              onchange="saveZakatSetting('gold_jewellery_grams', parseFloat(this.value)||0)" />
            <p class="text-xs text-slate-500 mt-1">
              Investable gold: ${summary.gold_investable_grams || 0}g
              × ${fmt(summary.gold_price_per_gram)}/g = ${fmt(summary.assets.gold)}
            </p>
          </div>

          <!-- Silver grams -->
          <div>
            <label class="text-xs text-slate-400 block mb-1">Silver (grams)</label>
            <input id="zakatSilverGrams" type="number" min="0" step="0.1"
              value="${settings.silver_grams || 0}"
              class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              onchange="saveZakatSetting('silver_grams', parseFloat(this.value)||0)" />
            <p class="text-xs text-slate-500 mt-1">
              ${summary.silver_grams || 0}g × ${fmt(summary.silver_price_per_gram)}/g = ${fmt(summary.assets.silver)}
            </p>
          </div>

          <!-- Business goods -->
          <div>
            <label class="text-xs text-slate-400 block mb-1">Business Goods / Inventory (${cur})</label>
            <input id="zakatBusinessGoods" type="number" min="0" step="0.01"
              value="${settings.business_goods || 0}"
              class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              onchange="saveZakatSetting('business_goods', parseFloat(this.value)||0)" />
          </div>

          <!-- Receivables -->
          <div>
            <label class="text-xs text-slate-400 block mb-1">Money Owed to You / Receivables (${cur})</label>
            <input id="zakatReceivables" type="number" min="0" step="0.01"
              value="${settings.receivables || 0}"
              class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              onchange="saveZakatSetting('receivables', parseFloat(this.value)||0)" />
          </div>

          <!-- Pension -->
          <div>
            <label class="text-xs text-slate-400 block mb-1">Accessible Pension / Retirement (${cur})</label>
            <input id="zakatPension" type="number" min="0" step="0.01"
              value="${settings.pension || 0}"
              class="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              onchange="saveZakatSetting('pension', parseFloat(this.value)||0)" />
          </div>
        </div>
      </div>

      <!-- Auto-pulled data card -->
      <div class="bg-slate-800 rounded-xl p-5">
        <h2 class="text-sm font-medium text-slate-400 mb-4 uppercase tracking-wide">From Your Accounts</h2>
        <div class="space-y-3">

          <div class="flex items-center justify-between py-3 border-b border-slate-700">
            <div>
              <p class="text-sm text-slate-200">Cash &amp; Savings</p>
              <p class="text-xs text-slate-500 mt-0.5">Sum of all bank account balances</p>
            </div>
            <span class="text-sm font-semibold text-white">${fmt(summary.assets.cash)}</span>
          </div>

          <div class="flex items-center justify-between py-3 border-b border-slate-700">
            <div>
              <p class="text-sm text-slate-200">Stocks &amp; Shares</p>
              <p class="text-xs text-slate-500 mt-0.5">
                Full value ${fmt(summary.assets.stocks_full)} × ${Math.round((summary.stocks_rate||0.25)*100)}% rate
              </p>
            </div>
            <span class="text-sm font-semibold text-white">${fmt(summary.assets.stocks)}</span>
          </div>

          <div class="flex items-center justify-between py-3 border-b border-slate-700">
            <div>
              <p class="text-sm text-slate-200 text-rose-300">Loan Deduction</p>
              <p class="text-xs text-slate-500 mt-0.5">Annual EMI payments (EMI × 12)</p>
            </div>
            <span class="text-sm font-semibold text-rose-300">−${fmt(summary.deductions.loans)}</span>
          </div>

          <!-- Metal prices info -->
          <div class="rounded-xl border border-slate-700 bg-slate-900/40 px-4 py-3 mt-2">
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Live Metal Prices (USD/gram)</p>
            <div class="flex gap-6">
              <div>
                <p class="text-xs text-slate-500">Gold</p>
                <p class="text-sm text-yellow-300 font-medium">$${(summary.gold_price_per_gram||0).toFixed(2)}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500">Silver</p>
                <p class="text-sm text-slate-200 font-medium">$${(summary.silver_price_per_gram||0).toFixed(2)}</p>
              </div>
            </div>
            <p class="text-xs text-slate-600 mt-2">Prices cached daily from Yahoo Finance. Fallback prices used if unavailable.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Summary card -->
    <div class="bg-slate-800 rounded-xl p-6 mb-5">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-sm font-medium text-slate-400 uppercase tracking-wide">Zakaat Summary</h2>
        <div class="flex items-center gap-3">
          ${hawlBadge}
          ${eligibleBadge}
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div class="bg-slate-900/50 rounded-xl p-4">
          <p class="text-xs text-slate-500 mb-1">Total Assets</p>
          <p class="text-lg font-semibold text-white">${fmt(summary.assets.total)}</p>
        </div>
        <div class="bg-slate-900/50 rounded-xl p-4">
          <p class="text-xs text-slate-500 mb-1">Loan Deductions</p>
          <p class="text-lg font-semibold text-rose-300">${fmt(summary.deductions.total)}</p>
        </div>
        <div class="bg-slate-900/50 rounded-xl p-4">
          <p class="text-xs text-slate-500 mb-1">Net Zakatable</p>
          <p class="text-lg font-semibold text-white">${fmt(summary.net_zakatable)}</p>
        </div>
        <div class="bg-slate-900/50 rounded-xl p-4">
          <p class="text-xs text-slate-500 mb-1">Nisab (${nisabGold ? 'Gold' : 'Silver'})</p>
          <p class="text-lg font-semibold text-white">${fmt(summary.nisab_value)}</p>
        </div>
      </div>

      <div class="border-t border-slate-700 pt-5 flex items-center justify-between">
        <div>
          <p class="text-sm text-slate-400">Zakaat Due <span class="text-slate-500 text-xs ml-1">(2.5% of net zakatable wealth)</span></p>
          ${!summary.eligible ? `<p class="text-xs text-slate-500 mt-1">Net zakatable is below the nisab threshold — no Zakaat due.</p>` : ''}
        </div>
        <p class="text-3xl font-bold ${summary.eligible ? 'text-emerald-300' : 'text-slate-500'}">
          ${summary.eligible ? fmt(summary.zakat_due) : fmt(0)}
        </p>
      </div>
    </div>

    <!-- Assets breakdown table -->
    <div class="bg-slate-800 rounded-xl p-5">
      <h2 class="text-sm font-medium text-slate-400 mb-4 uppercase tracking-wide">Full Asset Breakdown</h2>
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-slate-500 border-b border-slate-700">
            <th class="pb-2 font-medium">Category</th>
            <th class="pb-2 font-medium text-right">Amount (${cur})</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-700/50">
          ${[
            ['Cash & Savings', summary.assets.cash, false],
            [`Stocks (${Math.round((summary.stocks_rate||0.25)*100)}% rate)`, summary.assets.stocks, false],
            ['Gold (investable)', summary.assets.gold, false],
            ['Silver', summary.assets.silver, false],
            ['Business Goods', summary.assets.business, false],
            ['Receivables', summary.assets.receivables, false],
            ['Pension', summary.assets.pension, false],
          ].filter(([,v]) => v > 0).map(([label, val]) =>
            `<tr><td class="py-2.5 text-slate-300">${label}</td><td class="py-2.5 text-right text-white font-medium">${fmt(val)}</td></tr>`
          ).join('')}
          <tr class="border-t border-slate-600">
            <td class="pt-3 pb-2.5 text-slate-200 font-semibold">Total Assets</td>
            <td class="pt-3 pb-2.5 text-right text-white font-bold">${fmt(summary.assets.total)}</td>
          </tr>
          <tr>
            <td class="py-2.5 text-rose-300">Loan Deductions (EMI × 12)</td>
            <td class="py-2.5 text-right text-rose-300 font-medium">−${fmt(summary.deductions.loans)}</td>
          </tr>
          <tr class="border-t-2 border-indigo-500/40">
            <td class="pt-3 pb-2.5 text-slate-100 font-bold">Net Zakatable Wealth</td>
            <td class="pt-3 pb-2.5 text-right text-white font-bold text-base">${fmt(summary.net_zakatable)}</td>
          </tr>
          ${summary.eligible ? `
          <tr class="bg-emerald-500/5">
            <td class="py-3 text-emerald-300 font-bold">Zakaat Due (2.5%)</td>
            <td class="py-3 text-right text-emerald-300 font-bold text-lg">${fmt(summary.zakat_due)}</td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>
  `;
}

function setNisabStandard(standard) {
  saveZakatSetting('nisab_standard', standard, true);
}

function setStocksRate(rate) {
  saveZakatSetting('stocks_rate', rate, true);
}

async function saveZakatSetting(key, value, reloadNow = false) {
  try {
    await api('/api/zakat/settings', 'PATCH', { [key]: value });
    if (reloadNow) {
      loadZakat();
    } else {
      // Debounce reload for input fields
      clearTimeout(_zakatSaveTimer);
      _zakatSaveTimer = setTimeout(loadZakat, 800);
    }
  } catch (e) {
    console.error('Failed to save zakat setting:', e);
  }
}

// Close coach marks with Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('coachOverlay').classList.contains('hidden')) {
    skipOnboarding();
  }
});
