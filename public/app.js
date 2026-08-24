/* ── Doom AI Cinema Studio · app.js v3.1 ─────────────────────────────── */
/* Modular UI: Independent collapsible drawers for Model, Ratio, Duration, Quality, Media */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TOKEN_KEY = 'doom_token';
const STORE_KEY = 'neon_key';

let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
let KEY = localStorage.getItem(STORE_KEY) || '';
let currentUser = null;

// ── Pay-As-You-Go Model Rates (Credits per video) ─────────────────────────
const MODEL_RATES = {
  pixverse:    { default: 25, starter: 25, creator: 20, studio: 15 },
  hailuo:      { default: 40, starter: 40, creator: 30, studio: 25 },
  kling_pro:   { default: 50, starter: 50, creator: 40, studio: 30 },
  grok:        { default: 50, starter: 50, creator: 40, studio: 30 },
  wan:         { default: 100, starter: 100, creator: 75, studio: 55 },
  veo_fast:    { default: 120, starter: 120, creator: 95, studio: 70 },
  veo:         { default: 125, starter: 125, creator: 100, studio: 75 },
  kling:       { default: 125, starter: 125, creator: 100, studio: 75 },
  sora:        { default: 125, starter: 125, creator: 100, studio: 75 },
  seedance:    { default: 140, starter: 140, creator: 100, studio: 75 },
};

function getModelCost(modelTitle = '') {
  const m = String(modelTitle).toLowerCase();
  const tier = currentUser?.plan || 'starter';
  let rateKey = 'veo';

  if (m.includes('pixverse')) rateKey = 'pixverse';
  else if (m.includes('hailuo') || m.includes('minimax')) rateKey = 'hailuo';
  else if (m.includes('kling') && m.includes('pro')) rateKey = 'kling_pro';
  else if (m.includes('grok')) rateKey = 'grok';
  else if (m.includes('wan')) rateKey = 'wan';
  else if (m.includes('veo') && m.includes('fast')) rateKey = 'veo_fast';
  else if (m.includes('veo')) rateKey = 'veo';
  else if (m.includes('kling')) rateKey = 'kling';
  else if (m.includes('sora')) rateKey = 'sora';
  else if (m.includes('seedance')) rateKey = 'seedance';

  const rates = MODEL_RATES[rateKey] || MODEL_RATES.veo;
  return rates[tier] || rates.starter || rates.default;
}

// ── State ─────────────────────────────────────────────────────
let models = { textToVideo: [], imageToVideo: [] };
let workflows = [];
let effects = [];
let pollTimer = null;
let activeDrawerId = null;

let state = {
  tab: 'text',
  textModel: null, textOpts: {}, textSearch: '',
  imageModel: null, imageOpts: {}, imageSearch: '', imageB64: null,
  wf: null, wfInputs: {},
  eff: null, effB64: null,
  activeModal: null,
};

// ── API helper ───────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  if (KEY) headers['x-api-key'] = KEY;

  const res = await fetch('/api' + path, { credentials: 'same-origin', ...opts, headers });
  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

// ── Toast notifications ────────────────────────────────────────
const toast = (msg, type = '') => {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 260); }, 3400);
};

// ══════════════════════════════════════════════════════════
// AUTH & SESSION
// ══════════════════════════════════════════════════════════

async function initSession() {
  if (location.hash && location.hash.includes('access_token')) {
    try {
      const params = new URLSearchParams(location.hash.substring(1));
      const accessToken = params.get('access_token');
      if (accessToken) {
        const payloadB64 = accessToken.split('.')[1];
        const payloadJson = decodeURIComponent(atob(payloadB64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
        const payload = JSON.parse(payloadJson);
        const userEmail = payload.email;
        const userName = payload.user_metadata?.full_name || payload.user_metadata?.name || userEmail?.split('@')[0] || '';

        if (userEmail) {
          const data = await api('/auth/google', {
            method: 'POST',
            body: JSON.stringify({ email: userEmail, name: userName }),
          });
          TOKEN = data.token;
          currentUser = data.user;
          localStorage.setItem(TOKEN_KEY, TOKEN);
          history.replaceState(null, '', location.pathname);
          toast('✓ Signed in with Google! 50 bonus credits.', 'ok');
          enterStudio();
          return;
        }
      }
    } catch (e) {
      console.error('Google OAuth callback hash parse error:', e);
    }
  }

  if (TOKEN) {
    try {
      const data = await api('/auth/me');
      currentUser = data.user;
      enterStudio();
      return;
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      TOKEN = '';
    }
  }
  if (KEY) {
    enterStudio();
  }
}

function enterStudio() {
  $('#gate').classList.add('hidden');
  $('#app').classList.add('show');
  updateUserUI();
  loadAll();
  startPolling();
}

function updateUserUI() {
  if (currentUser) {
    const credits = currentUser.credits || 0;
    const planName = currentUser.plan ? currentUser.plan.toUpperCase() : 'FREE';
    const email = currentUser.email || '';
    const name = currentUser.name || email.split('@')[0] || 'User';
    const initials = name.slice(0, 2).toUpperCase();

    $('#navCreditCount').textContent = credits;
    $('#navCredits').style.display = 'inline-flex';
    $('#navBuyBtn').style.display = 'inline-flex';
    $('#navProfileBtn').style.display = 'flex';
    $('#navUserName').textContent = name;

    if (currentUser.avatar_url) {
      $('#navAvatar').innerHTML = `<img src="${currentUser.avatar_url}" alt="${name}">`;
      $('#pdAvatar').innerHTML = `<img src="${currentUser.avatar_url}" alt="${name}">`;
    } else {
      $('#navAvatar').textContent = initials;
      $('#pdAvatar').textContent = initials;
    }

    $('#pdName').textContent = name;
    $('#pdEmail').textContent = email;
    $('#pdTier').textContent = planName;
    $('#pdCredits').textContent = credits;

    updateModelChipUI();
  } else if (KEY) {
    $('#navCredits').style.display = 'none';
    $('#navBuyBtn').style.display = 'inline-flex';
    $('#navProfileBtn').style.display = 'flex';
    $('#navUserName').textContent = 'API Key';
    $('#navAvatar').textContent = '🔑';
    $('#pdName').textContent = 'Master Key';
    $('#pdEmail').textContent = KEY.slice(0, 22) + '…';
    $('#pdTier').textContent = 'API';
  }
}

function updateModelChipUI() {
  const tab = state.tab;
  let modelName = 'Select Model';

  if (tab === 'text' && state.textModel) {
    modelName = state.textModel.title || 'Text Model';
  } else if (tab === 'image' && state.imageModel) {
    modelName = state.imageModel.title || 'Image Model';
  } else if (tab === 'cinematic') {
    modelName = state.wf?.title || 'Cinema Template';
  } else if (tab === 'effects') {
    modelName = state.eff?.title || 'Effect Template';
  }

  if ($('#chipModelVal')) $('#chipModelVal').textContent = modelName;

  // Toggle media chip for image / cinematic / effects modes
  const isMediaMode = tab === 'image' || tab === 'effects' || (tab === 'cinematic' && state.wf?.input_style?.includes('image'));
  if ($('#chipMedia')) {
    $('#chipMedia').classList.toggle('hidden', !isMediaMode);
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STORE_KEY);
  TOKEN = '';
  KEY = '';
  currentUser = null;
  clearInterval(pollTimer);
  pollTimer = null;
  location.reload();
}

// ══════════════════════════════════════════════════════════
// AUTH FORM HANDLERS
// ══════════════════════════════════════════════════════════

if ($('#tabAuthLogin')) {
  $('#tabAuthLogin').onclick = () => {
    $('#tabAuthLogin').classList.add('active');
    $('#tabAuthSignup').classList.remove('active');
    $('#authTitle').textContent = 'Sign in to Doom AI';
    $('#formAuthLogin').classList.remove('hidden');
    $('#formAuthSignup').classList.add('hidden');
  };
  $('#tabAuthSignup').onclick = () => {
    $('#tabAuthSignup').classList.add('active');
    $('#tabAuthLogin').classList.remove('active');
    $('#authTitle').textContent = 'Create Free Account';
    $('#formAuthSignup').classList.remove('hidden');
    $('#formAuthLogin').classList.add('hidden');
  };
}

if ($('#loginSubmitBtn')) {
  $('#loginSubmitBtn').onclick = async () => {
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPass').value.trim();
    if (!email || !password) { toast('Email and password required', 'err'); return; }
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      TOKEN = data.token;
      currentUser = data.user;
      localStorage.setItem(TOKEN_KEY, TOKEN);
      toast('✓ Welcome back!', 'ok');
      enterStudio();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

if ($('#signupSubmitBtn')) {
  $('#signupSubmitBtn').onclick = async () => {
    const email = $('#signupEmail').value.trim();
    const password = $('#signupPass').value.trim();
    if (!email || !password) { toast('Email and password required', 'err'); return; }
    try {
      const data = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
      TOKEN = data.token;
      currentUser = data.user;
      localStorage.setItem(TOKEN_KEY, TOKEN);
      toast('✓ Account created! 50 bonus credits added.', 'ok');
      enterStudio();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

if ($('#googleAuthBtn')) {
  $('#googleAuthBtn').onclick = () => {
    const supabaseUrl = 'https://ouwucsjpnjnyjmpeayqb.supabase.co';
    const redirectUrl = encodeURIComponent(window.location.origin + '/studio');
    window.location.href = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${redirectUrl}`;
  };
}

$('#enterBtn').onclick = () => {
  const k = $('#keyInput').value.trim();
  if (!k.startsWith('master-')) { toast('Key must start with "master-"', 'err'); return; }
  KEY = k;
  localStorage.setItem(STORE_KEY, k);
  enterStudio();
};
$('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#enterBtn').click(); });
$('#logoutBtn').onclick = logout;

// ══════════════════════════════════════════════════════════
// PROFILE DROPDOWN
// ══════════════════════════════════════════════════════════

$('#navProfileBtn').onclick = (e) => {
  e.stopPropagation();
  closeAllDrawers();
  $('#profileDropdown').classList.toggle('show');
};

document.addEventListener('click', (e) => {
  const dd = $('#profileDropdown');
  if (dd && dd.classList.contains('show') && !dd.contains(e.target) && !$('#navProfileBtn').contains(e.target)) {
    dd.classList.remove('show');
  }

  // Close open drawer when clicking outside composer
  if (activeDrawerId && !e.target.closest('.composer-inner')) {
    closeAllDrawers();
  }
});

// ══════════════════════════════════════════════════════════
// INDEPENDENT COLLAPSIBLE DRAWERS TOGGLE LOGIC
// ══════════════════════════════════════════════════════════

function closeAllDrawers() {
  $$('.drawer-panel').forEach(d => d.classList.remove('open'));
  $$('.ctrl-chip').forEach(c => c.classList.remove('active'));
  activeDrawerId = null;
}

function toggleDrawer(targetDrawerId, triggeringChip) {
  const targetDrawer = $('#' + targetDrawerId);
  if (!targetDrawer) return;

  const isOpen = targetDrawer.classList.contains('open');
  closeAllDrawers();

  if (!isOpen) {
    targetDrawer.classList.add('open');
    if (triggeringChip) triggeringChip.classList.add('active');
    activeDrawerId = targetDrawerId;
  }
}

$$('.ctrl-chip').forEach(chip => {
  chip.onclick = (e) => {
    e.stopPropagation();
    const drawerId = chip.dataset.drawer;
    toggleDrawer(drawerId, chip);
  };
});

// Mode/Tab Switching inside Model Drawer
$$('.cfg-tab').forEach((t) => t.onclick = () => {
  $$('.cfg-tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  state.tab = t.dataset.tab;
  ['text', 'image', 'cinematic', 'effects'].forEach((p) =>
    $('#pane-' + p).classList.toggle('hidden', p !== state.tab)
  );
  renderOptions(state.tab);
  updateModelChipUI();
});

// ══════════════════════════════════════════════════════════
// CATALOG & OPTIONS RENDER
// ══════════════════════════════════════════════════════════

async function loadAll() {
  try {
    const [m, w, e] = await Promise.all([
      api('/models'),
      api('/workflows').catch(() => ({ data: [] })),
      api('/effects').catch(() => ({ data: [] })),
    ]);
    models = m || { textToVideo: [], imageToVideo: [] };
    workflows = flatItems(w.data);
    effects = flatItems(e.data);
    renderModels('text');
    renderModels('image');
    renderWorkflows();
    renderEffects();
  } catch (err) {
    toast('Failed to load catalog: ' + err.message, 'err');
  }
}

function flatItems(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap((s) =>
    Object.values(s || {})
      .filter((v) => v && Array.isArray(v.items))
      .flatMap((v) => v.items)
  );
}

function getMediaHtml(item) {
  const vid = item.video_url || '';
  const img = item.webp_url || item.thumbnail || item.video_home || item.video_detail || '';
  if (vid) {
    return `<video src="${vid}" autoplay loop muted playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover"
      onerror="if('${img}')this.outerHTML='<img src=\\'${img}\\' style=\\'width:100%;height:100%;object-fit:cover\\' referrerpolicy=\\'no-referrer\\'>'"></video>`;
  }
  if (img) return `<img src="${img}" referrerpolicy="no-referrer" loading="lazy" style="width:100%;height:100%;object-fit:cover">`;
  return `<div style="width:100%;height:100%;background:var(--surface);display:grid;place-items:center;color:var(--accent);font-size:22px">🎬</div>`;
}

function renderModels(kind) {
  const raw = kind === 'text' ? (models.textToVideo || []) : (models.imageToVideo || []);
  const query = (kind === 'text' ? state.textSearch : state.imageSearch).toLowerCase();
  const list = raw.filter((m) => (m.title + ' ' + (m.subtitle || '')).toLowerCase().includes(query));
  const el = kind === 'text' ? $('#textModels') : $('#imageModels');
  el.innerHTML = '';

  if (!list.length) {
    el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:12px">No models found</div>`;
    return;
  }

  list.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'mcard';
    const curSel = kind === 'text' ? state.textModel : state.imageModel;
    if (curSel?.workflow_name === m.workflow_name) card.classList.add('sel');

    const cost = getModelCost(m.title || m.workflow_name);
    const icon = m.icon || '';

    card.innerHTML = `
      <div class="mimg">${icon ? `<img src="${icon}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : '🎥'}</div>
      <div class="minfo">
        <div class="mt"><span class="chk">✓</span>${m.title}</div>
        <div class="ms">${m.subtitle || ''}</div>
      </div>
      <div class="mcost">${cost}c</div>`;

    card.onclick = () => {
      if (kind === 'text') { state.textModel = m; state.textOpts = {}; }
      else { state.imageModel = m; state.imageOpts = {}; }
      el.querySelectorAll('.mcard').forEach((x) => x.classList.remove('sel'));
      card.classList.add('sel');
      renderOptions(kind);
      updateModelChipUI();
    };
    el.appendChild(card);
    if (i === 0 && !curSel) card.click();
  });
}

function renderOptions(kind) {
  const m = kind === 'text' ? state.textModel : state.imageModel;
  const opts = kind === 'text' ? state.textOpts : state.imageOpts;
  const inp = m?.inputs || {};

  // 1. Aspect Ratio
  const ratioBox = $('#optsRatio');
  if (inp.aspect_ratio && Array.isArray(inp.aspect_ratio) && inp.aspect_ratio.length > 0) {
    opts.aspect_ratio = opts.aspect_ratio || inp.aspect_ratio[0];
    $('#chipRatio').classList.remove('hidden');
    $('#chipRatioVal').textContent = opts.aspect_ratio;

    ratioBox.innerHTML = inp.aspect_ratio.map((a) =>
      `<div class="opt-pill ${opts.aspect_ratio === a ? 'on' : ''}" data-k="aspect_ratio" data-v="${a}">${a}</div>`
    ).join('');

    ratioBox.querySelectorAll('.opt-pill').forEach(o => {
      o.onclick = () => {
        opts.aspect_ratio = o.dataset.v;
        $('#chipRatioVal').textContent = o.dataset.v;
        renderOptions(kind);
      };
    });
  } else {
    $('#chipRatio').classList.add('hidden');
  }

  // 2. Duration
  const durBox = $('#optsDuration');
  if (inp.duration_options && Array.isArray(inp.duration_options) && inp.duration_options.length > 0) {
    opts.duration = opts.duration || inp.duration_options[0];
    $('#chipDuration').classList.remove('hidden');
    $('#chipDurationVal').textContent = opts.duration + 's';

    durBox.innerHTML = inp.duration_options.map((d) =>
      `<div class="opt-pill ${opts.duration == d ? 'on' : ''}" data-k="duration" data-v="${d}">${d}s</div>`
    ).join('');

    durBox.querySelectorAll('.opt-pill').forEach(o => {
      o.onclick = () => {
        opts.duration = Number(o.dataset.v);
        $('#chipDurationVal').textContent = o.dataset.v + 's';
        renderOptions(kind);
      };
    });
  } else {
    $('#chipDuration').classList.add('hidden');
  }

  // 3. Quality
  const qList = inp.quality_options || inp.quality;
  const qualityBox = $('#optsQuality');
  if (qList && Array.isArray(qList) && qList.length > 0) {
    opts.quality = opts.quality || qList[0];
    $('#chipQuality').classList.remove('hidden');
    $('#chipQualityVal').textContent = opts.quality;

    qualityBox.innerHTML = qList.map((q) =>
      `<div class="opt-pill ${opts.quality === q ? 'on' : ''}" data-k="quality" data-v="${q}">${q}</div>`
    ).join('');

    qualityBox.querySelectorAll('.opt-pill').forEach(o => {
      o.onclick = () => {
        opts.quality = o.dataset.v;
        $('#chipQualityVal').textContent = o.dataset.v;
        renderOptions(kind);
      };
    });
  } else {
    $('#chipQuality').classList.add('hidden');
  }
}

// ── Cinema Workflows & Effects Render ────────────────────────────────────────
function renderWorkflows() {
  const featCont = $('#featuredScene');
  const grid = $('#wfGrid');
  featCont.innerHTML = '';
  grid.innerHTML = '';

  const featured = workflows.find((w) =>
    (w.workflow_name || '').includes('create_your_scene') ||
    (w.title || '').toLowerCase().includes('create your scene')
  );

  if (featured) {
    const fc = document.createElement('div');
    fc.className = 'featured-card';
    fc.innerHTML = `
      <div class="featured-badge">🔥 FEATURED</div>
      <div class="featured-media">${getMediaHtml(featured)}</div>
      <div class="featured-info">
        <h4>🎬 ${featured.title}</h4>
        <p>${featured.subtitle || 'Direct your own scene with custom images.'}</p>
      </div>`;
    fc.onclick = () => {
      state.wf = featured; state.wfInputs = {};
      grid.querySelectorAll('.wf').forEach((x) => x.classList.remove('sel'));
      fc.classList.add('sel');
      renderCinOpts();
      updateModelChipUI();
    };
    featCont.appendChild(fc);
  }

  workflows.forEach((w) => {
    const el = document.createElement('div');
    el.className = 'wf';
    if (state.wf?.workflow_id === w.workflow_id) el.classList.add('sel');
    el.innerHTML = `${getMediaHtml(w)}<div class="cap">${w.title}</div>`;
    el.onclick = () => {
      state.wf = w; state.wfInputs = {};
      grid.querySelectorAll('.wf').forEach((x) => x.classList.remove('sel'));
      if (featCont.firstElementChild) featCont.firstElementChild.classList.remove('sel');
      el.classList.add('sel');
      renderCinOpts();
      updateModelChipUI();
    };
    grid.appendChild(el);
  });

  if (!state.wf) {
    if (featured && featCont.firstElementChild) featCont.firstElementChild.click();
    else if (grid.firstElementChild) grid.firstElementChild.click();
  }
}

function renderCinOpts() {
  const w = state.wf;
  const cont = $('#mediaDrawerBody');
  if (!w) { cont.innerHTML = ''; return; }
  const style = w.input_style || 'only_image';
  let html = '';
  if (style.includes('image')) {
    const n = (style.startsWith('two') || style.startsWith('prompt_two')) ? 2 : 1;
    for (let i = 1; i <= n; i++) {
      html += `<div class="drawer-title" style="margin-top:6px">${(w.image_labels && w.image_labels[i - 1]) || 'Source Image ' + i}</div>
               <div class="cfg-drop" id="wfDrop${i}"><div class="ico">📁</div>Click or drop image</div>`;
    }
  }
  if (style.includes('prompt')) {
    html += `<div class="drawer-title" style="margin-top:10px">${w.prompt_label || 'Template Prompt'}</div>
             <textarea class="cfg-textarea" id="wfPrompt" placeholder="${w.placeholder_text || 'Describe your scene...'}"></textarea>`;
  }
  cont.innerHTML = html;
  for (let i = 1; i <= 2; i++) {
    const d = cont.querySelector('#wfDrop' + i);
    if (d) setupDrop(d, (b64) => { state.wfInputs['img' + i] = b64; });
  }
}

function renderEffects() {
  const grid = $('#effGrid');
  grid.innerHTML = '';
  effects.forEach((e, i) => {
    const el = document.createElement('div');
    el.className = 'wf';
    if (state.eff?.workflow_id === e.workflow_id) el.classList.add('sel');
    el.innerHTML = `${getMediaHtml(e)}<div class="cap">${e.title}</div>`;
    el.onclick = () => {
      state.eff = e;
      grid.querySelectorAll('.wf').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      updateModelChipUI();
    };
    grid.appendChild(el);
    if (i === 0 && !state.eff) setTimeout(() => el.click(), 50);
  });
}

// ── File Upload / Drop ────────────────────────────────────────
function setupDrop(el, cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
  el.appendChild(inp);
  el.onclick = (e) => { if (e.target.tagName !== 'BUTTON') inp.click(); };
  inp.onchange = () => fileToB64(inp.files[0], cb, el);
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag'); };
  el.ondragleave = () => el.classList.remove('drag');
  el.ondrop = (e) => { e.preventDefault(); el.classList.remove('drag'); fileToB64(e.dataTransfer.files[0], cb, el); };
}

function fileToB64(file, cb, el) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    const b64 = r.result.split(',')[1];
    cb(b64);
    el.innerHTML = `<img src="${r.result}"><button class="clear" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,.7);border:none;color:#fff;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:14px;display:grid;place-items:center">×</button>`;
    el.style.position = 'relative';
    el.querySelector('.clear').onclick = (e) => { e.stopPropagation(); cb(null); el.innerHTML = '<div class="ico">📁</div>Click or drop image'; el.style.position = ''; };
    if ($('#chipMediaVal')) $('#chipMediaVal').textContent = 'Image Attached ✓';
  };
  r.readAsDataURL(file);
}

async function uploadImage(b64) {
  if (!b64) return null;
  const r = await api('/upload', { method: 'POST', body: JSON.stringify({ base64Image: b64 }) });
  return r.imageUrl || r.url;
}

// ══════════════════════════════════════════════════════════
// GENERATE
// ══════════════════════════════════════════════════════════

async function generate() {
  const btn = $('#genBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  closeAllDrawers();

  try {
    const tab = state.tab;
    let body;
    const promptText = $('#mainPrompt').value.trim();

    if (tab === 'text') {
      if (!state.textModel) throw new Error('Click Model chip and select a model first');
      if (!promptText) throw new Error('Write a prompt for your video');
      body = { type: 'text', model: state.textModel.workflow_name, prompt: promptText, ...state.textOpts };
    } else if (tab === 'image') {
      if (!state.imageModel) throw new Error('Click Model chip and select a model first');
      if (!state.imageB64) throw new Error('Click Upload Image chip and attach an image first');
      if (!promptText) throw new Error('Write a motion prompt');
      const url = await uploadImage(state.imageB64);
      body = { type: 'image', model: state.imageModel.workflow_name, image_input: url, prompt: promptText, ...state.imageOpts };
    } else if (tab === 'cinematic') {
      if (!state.wf) throw new Error('Click Model chip and select a cinema template');
      const w = state.wf;
      const style = w.input_style || '';
      const inputs = {};
      if (style.includes('image')) {
        const n = (style.startsWith('two') || style.startsWith('prompt_two')) ? 2 : 1;
        for (let i = 1; i <= n; i++) {
          if (state.wfInputs['img' + i]) inputs['image_input' + (i > 1 ? i : '')] = await uploadImage(state.wfInputs['img' + i]);
        }
      }
      if (style.includes('prompt') && $('#wfPrompt')) inputs.prompt = $('#wfPrompt').value.trim();
      if (!inputs.prompt && promptText) inputs.prompt = promptText;
      body = { type: 'template', workflow_id: w.workflow_id, workflow_name: w.workflow_name, input_style: style, ...inputs };
    } else if (tab === 'effects') {
      if (!state.eff) throw new Error('Click Model chip and select an effect');
      if (!state.effB64) throw new Error('Click Upload Image chip and attach an image first');
      const url = await uploadImage(state.effB64);
      body = { type: 'effect', workflow_id: state.eff.workflow_id, workflow_name: state.eff.workflow_name, input_style: state.eff.input_style || 'only_image', image_input: url };
    }

    const res = await api('/generate', { method: 'POST', body: JSON.stringify(body) });
    toast('✓ Video generation queued!', 'ok');

    if (currentUser && res.creditCostDeducted) {
      currentUser.credits = Math.max(0, (currentUser.credits || 0) - res.creditCostDeducted);
      updateUserUI();
    }
    fetchWorks();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// ══════════════════════════════════════════════════════════
// WORKS / GALLERY FEED
// ══════════════════════════════════════════════════════════

async function fetchWorks() {
  try {
    const r = await api('/works');
    if (r.credit !== undefined && currentUser) {
      currentUser.credits = r.credit;
      updateUserUI();
    } else if (r.credit !== undefined) {
      $('#navCreditCount').textContent = (r.credit || 0).toFixed(0);
    }
    const works = r.works || [];
    const sig = JSON.stringify(works.map((w) => w.status + w.link));
    if (sig !== fetchWorks._last) { fetchWorks._last = sig; renderFeed(works); }
  } catch { }
}
fetchWorks._last = '';

function renderFeed(works) {
  const feed = $('#feed');
  const empty = $('#emptyState');

  feed.querySelectorAll('.gen-card').forEach(c => c.remove());

  if (!works.length) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  works.forEach((w) => {
    const card = document.createElement('div');
    card.className = 'gen-card';
    const isReady = w.status === 'ready' && w.link;
    const isError = w.status === 'error' || w.error;
    const model = (w.model || w.workflowId || 'video').replace(/[-_]/g, ' ');
    const prompt = w.userPrompt || w.error || (w.type || '').replace(/-/g, ' ');

    let statusClass = 'processing';
    if (isReady) statusClass = 'ready';
    else if (isError) statusClass = 'error';
    else if (w.status === 'queued') statusClass = 'queued';

    card.innerHTML = `
      <div class="gc-header">
        <div class="gc-model-icon">🎬</div>
        <div class="gc-model-name">${model}</div>
        <span class="gc-status ${statusClass}">${w.status || 'queued'}</span>
      </div>
      ${isReady ? `
        <div class="gc-media">
          <video src="${w.link}" preload="metadata" muted></video>
          <div class="gc-play-overlay"><div class="gc-play-circle">▶</div></div>
        </div>
      ` : `
        <div class="gc-shimmer">
          ${!isError ? `<div class="ring-wrap"><div class="ring"></div><div class="ring-text">Generating...</div></div>` : `<div class="ring-wrap"><div style="font-size:24px;margin-bottom:6px">⚠️</div><div class="ring-text">Generation failed</div></div>`}
        </div>
      `}
      ${prompt ? `<div class="gc-prompt">${prompt}</div>` : ''}
      ${isReady ? `
        <div class="gc-actions">
          <button class="gc-act primary gc-play-btn">▶ Play</button>
          <a class="gc-act secondary" href="${w.link}" download target="_blank">⬇ Save</a>
          <button class="gc-act secondary gc-copy-btn">📋 Copy Link</button>
        </div>
      ` : ''}`;

    if (isReady) {
      const mediaEl = card.querySelector('.gc-media');
      const playBtn = card.querySelector('.gc-play-btn');
      const copyBtn = card.querySelector('.gc-copy-btn');
      if (mediaEl) mediaEl.onclick = () => openModal(w.link, prompt);
      if (playBtn) playBtn.onclick = () => openModal(w.link, prompt);
      if (copyBtn) copyBtn.onclick = () => { navigator.clipboard.writeText(w.link); toast('Link copied ✓', 'ok'); };
    }
    feed.appendChild(card);
  });

  feed.scrollTop = feed.scrollHeight;
}

function startPolling() {
  fetchWorks();
  pollTimer = setInterval(fetchWorks, 8000);
}

// ══════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════

function openModal(url, prompt) {
  state.activeModal = { url, prompt };
  $('#modalVideo').src = url;
  $('#modalDlBtn').href = url;
  $('#modal').classList.add('show');
}
function closeModal() {
  $('#modal').classList.remove('show');
  $('#modalVideo').pause();
  $('#modalVideo').src = '';
  state.activeModal = null;
}

$('#modalClose').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

$('#modalRegenBtn').onclick = () => {
  const m = state.activeModal;
  if (!m?.prompt) { toast('No prompt on this video', 'err'); return; }
  $('#mainPrompt').value = m.prompt;
  if (typeof autoResize === 'function') autoResize($('#mainPrompt'));
  closeModal();
  toast('Prompt loaded — generating…', 'ok');
  generate();
};
$('#modalCopyLink').onclick = () => {
  if (state.activeModal?.url) { navigator.clipboard.writeText(state.activeModal.url); toast('Link copied ✓', 'ok'); }
};
$('#modalCopyPrompt').onclick = () => {
  if (state.activeModal?.prompt) { navigator.clipboard.writeText(state.activeModal.prompt); toast('Prompt copied ✓', 'ok'); }
};

// ══════════════════════════════════════════════════════════
// RANDOM PROMPTS FEATURE
// ══════════════════════════════════════════════════════════

const RANDOM_PROMPTS = [
  'A cinematic shot of a lone astronaut walking on a glowing alien desert at dusk, volumetric light, 35mm film.',
  'Hyperrealistic cybernetic dragon breathing blue plasma flame over futuristic neon city, 8K, dramatic lighting.',
  'Slow-motion parrot flying through a misty rainforest canopy illuminated by golden sunbeams.',
  'Futuristic sports car drifting on a wet neon-lit Tokyo highway at midnight, rain reflections, anamorphic lens.',
  'Ancient steampunk clockwork city coming to life as gears turn in golden sunset light.',
  'Underwater tracking shot of bioluminescent jellyfish floating gracefully in deep obsidian waters.',
  'Epic cinematic camera tilt up of a mystical floating castle above storm clouds, thunder and lightning flashes.',
  'Close-up macro shot of a glowing mechanical hummingbird sipping nectar from an iridescent crystal flower.',
  'Photorealistic slow motion ocean wave breaking at sunset with fiery orange and magenta colors.',
  'Cyberpunk samurai standing on a skyscraper rooftop in a torrential downpour, glowing katana blade.',
  'Majestic snow leopard running through powdered snow in the Himalayan mountains, 4k ultra-high frame rate.',
  'Mystical forest pathway illuminated by floating glowing blue lotus blossoms at midnight.'
];

function setRandomPrompt() {
  const prompt = RANDOM_PROMPTS[Math.floor(Math.random() * RANDOM_PROMPTS.length)];
  const input = $('#mainPrompt');
  if (input) {
    input.value = prompt;
    if (typeof autoResize === 'function') autoResize(input);
    input.focus();
    toast('✨ Loaded random prompt!', 'ok');
  }
}

// ══════════════════════════════════════════════════════════
// SEARCH & INPUT EVENTS
// ══════════════════════════════════════════════════════════

$('#textModelSearch').oninput = (e) => { state.textSearch = e.target.value; renderModels('text'); };
$('#imageModelSearch').oninput = (e) => { state.imageSearch = e.target.value; renderModels('image'); };

$('#genBtn').onclick = generate;

if ($('#randomBtn')) $('#randomBtn').onclick = setRandomPrompt;
if ($('#chipRandom')) $('#chipRandom').onclick = (e) => { e.stopPropagation(); closeAllDrawers(); setRandomPrompt(); };

$('#mainPrompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    generate();
  }
});

setupDrop($('#imgDrop'), (b64) => { state.imageB64 = b64; });

// ── Initialize ────────────────────────────────────────────────
initSession();
