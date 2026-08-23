/* ── Doom AI Cinema Studio · app.js ─────────────────────────────────── */
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
let lastWorks = [];
let pollTimer = null;

let state = {
  tab: 'text',
  textModel: null, textOpts: {}, textSearch: '',
  imageModel: null, imageOpts: {}, imageSearch: '', imageB64: null,
  wf: null, wfInputs: {},
  eff: null, effB64: null,
  activeModal: null,
};

// Sample prompts
const TEXT_SAMPLES = [
  'A cinematic shot of a lone astronaut on a glowing alien desert at dusk, volumetric light, 35mm film.',
  'Hyperrealistic cybernetic dragon breathing blue plasma flame, 8K, dramatic lighting.',
  'Slow-motion parrot flying through a misty rainforest canopy lit by sunbeams.',
  'Futuristic sports car drifting on a wet neon-lit Tokyo highway at midnight.',
  'Ancient steampunk clockwork city coming to life in golden sunlight.',
  'Underwater tracking shot of bioluminescent jellyfish in deep obsidian waters.',
];
const IMG_SAMPLES = [
  'Slowly zoom out, gentle camera pan right, subject turns to face the camera.',
  'Dramatic upward tilt with dust particles drifting in volumetric light.',
  'Smooth orbit shot around the subject, subtle depth-of-field shift.',
  'Cinematic steadycam forward movement, wind moves background elements.',
];

// ── API helper ───────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  if (KEY) headers['x-api-key'] = KEY;

  const res = await fetch('/api' + path, { ...opts, headers });
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

// ── Auth & Session Management ──────────────────────────────────
async function initSession() {
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
    const planName = currentUser.plan ? currentUser.plan.toUpperCase() : 'FREE';
    $('#userDisplay').textContent = `${currentUser.email} (${currentUser.credits || 0}c)`;
    $('#creditPill').textContent = `⚡ ${currentUser.credits || 0} credits`;
    if ($('#tierBadge')) {
      $('#tierBadge').textContent = `${planName} TIER`;
      $('#tierBadge').style.display = 'inline-block';
    }
  } else if (KEY) {
    $('#userDisplay').textContent = KEY.slice(0, 22) + '…';
    if ($('#tierBadge')) $('#tierBadge').style.display = 'none';
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

// ── Auth Form Handlers ─────────────────────────────────────────
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

$('#enterBtn').onclick = () => {
  const k = $('#keyInput').value.trim();
  if (!k.startsWith('master-')) { toast('Key must start with "master-"', 'err'); return; }
  KEY = k;
  localStorage.setItem(STORE_KEY, k);
  enterStudio();
};
$('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#enterBtn').click(); });
$('#logoutBtn').onclick = logout;

// ── Load Catalog ──────────────────────────────────────────────
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

// ── Media helper ──────────────────────────────────────────────
function getMediaHtml(item) {
  const vid = item.video_url || '';
  const img = item.webp_url || item.thumbnail || item.video_home || item.video_detail || '';
  if (vid) {
    return `<video src="${vid}" autoplay loop muted playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover"
      onerror="if('${img}')this.outerHTML='<img src=\\'${img}\\' style=\\'width:100%;height:100%;object-fit:cover\\' referrerpolicy=\\'no-referrer\\'>'"
    ></video>`;
  }
  if (img) return `<img src="${img}" referrerpolicy="no-referrer" loading="lazy" style="width:100%;height:100%;object-fit:cover">`;
  return `<div style="width:100%;height:100%;background:var(--surface);display:grid;place-items:center;color:var(--accent);font-size:22px">🎬</div>`;
}

// ── Model List Render ──────────────────────────────────────────
function renderModels(kind) {
  const raw = kind === 'text' ? (models.textToVideo || []) : (models.imageToVideo || []);
  const query = (kind === 'text' ? state.textSearch : state.imageSearch).toLowerCase();
  const list = raw.filter((m) => (m.title + ' ' + (m.subtitle || '')).toLowerCase().includes(query));
  const el = kind === 'text' ? $('#textModels') : $('#imageModels');
  el.innerHTML = '';

  if (!list.length) {
    el.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:13px">No models found</div>`;
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
      <div class="info">
        <div class="t"><span class="chk">✓</span>${m.title}</div>
        <div class="s">${m.subtitle || ''}</div>
      </div>
      <div class="cost">${cost}c</div>`;

    card.onclick = () => {
      if (kind === 'text') { state.textModel = m; state.textOpts = {}; }
      else { state.imageModel = m; state.imageOpts = {}; }
      el.querySelectorAll('.mcard').forEach((x) => x.classList.remove('sel'));
      card.classList.add('sel');
      renderOptions(kind);
    };
    el.appendChild(card);
    if (i === 0 && !curSel) card.click();
  });
}

function renderOptions(kind) {
  const m = kind === 'text' ? state.textModel : state.imageModel;
  const cont = kind === 'text' ? $('#textOpts') : $('#imageOpts');
  if (!m?.inputs) { cont.innerHTML = ''; return; }
  const opts = kind === 'text' ? state.textOpts : state.imageOpts;
  const inp = m.inputs;
  let html = '';

  if (inp.aspect_ratio) {
    opts.aspect_ratio = opts.aspect_ratio || inp.aspect_ratio[0];
    html += `<label>Aspect ratio</label><div class="opts">${inp.aspect_ratio.map((a) =>
      `<div class="opt ${opts.aspect_ratio === a ? 'on' : ''}" data-k="aspect_ratio" data-v="${a}">${a}</div>`).join('')}</div>`;
  }
  if (inp.duration_options) {
    opts.duration = opts.duration || inp.duration_options[0];
    html += `<label>Duration</label><div class="opts">${inp.duration_options.map((d) =>
      `<div class="opt ${opts.duration === d ? 'on' : ''}" data-k="duration" data-v="${d}">${d}s</div>`).join('')}</div>`;
  }

  cont.innerHTML = html;
  cont.querySelectorAll('.opt').forEach((o) => o.onclick = () => {
    opts[o.dataset.k] = isNaN(o.dataset.v) ? o.dataset.v : Number(o.dataset.v);
    renderOptions(kind);
  });
}

// ── Workflows & Effects ────────────────────────────────────────
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
        <div class="btn-sel">⚡ Click to Select →</div>
      </div>`;
    fc.onclick = () => {
      state.wf = featured; state.wfInputs = {};
      grid.querySelectorAll('.wf').forEach((x) => x.classList.remove('sel'));
      fc.classList.add('sel');
      renderCinOpts();
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
  const cont = $('#cinOpts');
  if (!w) { cont.innerHTML = ''; return; }
  const style = w.input_style || 'only_image';
  let html = '';
  if (style.includes('image')) {
    const n = (style.startsWith('two') || style.startsWith('prompt_two')) ? 2 : 1;
    for (let i = 1; i <= n; i++) {
      html += `<label>${(w.image_labels && w.image_labels[i - 1]) || 'Source Image ' + i}</label>
               <div class="drop" id="wfDrop${i}"><div class="ico">📁</div>Click or drop image</div>`;
    }
  }
  if (style.includes('prompt')) {
    html += `<label>${w.prompt_label || 'Prompt'}</label>
             <textarea id="wfPrompt" placeholder="${w.placeholder_text || 'Describe your scene...'}"></textarea>`;
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
    };
    grid.appendChild(el);
    if (i === 0 && !state.eff) setTimeout(() => el.click(), 50);
  });
}

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
  };
  r.readAsDataURL(file);
}

async function uploadImage(b64) {
  if (!b64) return null;
  const r = await api('/upload', { method: 'POST', body: JSON.stringify({ base64Image: b64 }) });
  return r.imageUrl || r.url;
}

// ── Generate ──────────────────────────────────────────────────
async function generate() {
  const btn = $('#genBtn');
  btn.disabled = true;
  const orig = btn.innerHTML;
  try {
    const tab = state.tab;
    let body;

    if (tab === 'text') {
      if (!state.textModel) throw new Error('Select a model first');
      const p = $('#textPrompt').value.trim();
      if (!p) throw new Error('Write a prompt for your video');
      body = { type: 'text', model: state.textModel.workflow_name, prompt: p, ...state.textOpts };
    } else if (tab === 'image') {
      if (!state.imageModel) throw new Error('Select a model first');
      if (!state.imageB64) throw new Error('Upload an image first');
      const p = $('#imgPrompt').value.trim();
      if (!p) throw new Error('Write a motion prompt');
      btn.innerHTML = '⏳ Uploading image…';
      const url = await uploadImage(state.imageB64);
      body = { type: 'image', model: state.imageModel.workflow_name, image_input: url, prompt: p, ...state.imageOpts };
    } else if (tab === 'cinematic') {
      if (!state.wf) throw new Error('Select a cinema template');
      const w = state.wf;
      const style = w.input_style || '';
      btn.innerHTML = '⏳ Uploading image(s)…';
      const inputs = {};
      if (style.includes('image')) {
        const n = (style.startsWith('two') || style.startsWith('prompt_two')) ? 2 : 1;
        for (let i = 1; i <= n; i++) {
          if (state.wfInputs['img' + i]) inputs['image_input' + (i > 1 ? i : '')] = await uploadImage(state.wfInputs['img' + i]);
        }
      }
      if (style.includes('prompt') && $('#wfPrompt')) inputs.prompt = $('#wfPrompt').value.trim();
      body = { type: 'template', workflow_id: w.workflow_id, workflow_name: w.workflow_name, input_style: style, ...inputs };
    } else if (tab === 'effects') {
      if (!state.eff) throw new Error('Select an effect');
      if (!state.effB64) throw new Error('Upload a source image');
      btn.innerHTML = '⏳ Uploading image…';
      const url = await uploadImage(state.effB64);
      body = { type: 'effect', workflow_id: state.eff.workflow_id, workflow_name: state.eff.workflow_name, input_style: state.eff.input_style || 'only_image', image_input: url };
    }

    btn.innerHTML = '⏳ Queueing generation…';
    const res = await api('/generate', { method: 'POST', body: JSON.stringify(body) });
    toast('✓ Video generation queued!', 'ok');
    
    // Refresh user credits if returned
    if (currentUser && res.creditCostDeducted) {
      currentUser.credits = Math.max(0, (currentUser.credits || 0) - res.creditCostDeducted);
      updateUserUI();
    }
    fetchWorks();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ── Works / Gallery ───────────────────────────────────────────
async function fetchWorks() {
  try {
    const r = await api('/works');
    if (r.credit !== undefined && currentUser) {
      currentUser.credits = r.credit;
      updateUserUI();
    } else if (r.credit !== undefined) {
      $('#creditPill').textContent = `⚡ ${(r.credit || 0).toFixed(0)} credits`;
    }
    const works = r.works || [];
    const sig = JSON.stringify(works.map((w) => w.status + w.link));
    if (sig !== fetchWorks._last) { fetchWorks._last = sig; renderGallery(works); lastWorks = works; }
  } catch { }
}
fetchWorks._last = '';

function renderGallery(works) {
  const g = $('#gallery');
  const empty = $('#emptyState');
  if ($('#pagination')) $('#pagination').innerHTML = '';

  if (!works.length) {
    g.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  g.innerHTML = '';
  works.forEach((w) => {
    const card = document.createElement('div');
    card.className = 'vcard';
    const isReady = w.status === 'ready' && w.link;
    const isError = w.status === 'error' || w.error;
    const model = (w.model || w.workflowId || 'video').replace(/[-_]/g, ' ');
    const prompt = w.userPrompt || w.error || (w.type || '').replace(/-/g, ' ');

    card.innerHTML = `
      <div class="vthumb">
        ${isReady
        ? `<video src="${w.link}" preload="metadata" muted></video>`
        : `<div class="skel"></div>${!isError ? '<div class="ph"><div class="ring"></div></div>' : ''}`}
        <span class="badge ${w.status || 'processing'}">${w.status || 'queued'}</span>
      </div>
      <div class="vmeta">
        <div class="vt">${model}</div>
        <div class="vp">${prompt}</div>
        ${isReady ? `
          <div class="vact">
            <button class="ply">▶ Play</button>
            <a class="dl" href="${w.link}" download target="_blank">⬇ Save</a>
          </div>` : ''}
      </div>`;

    if (isReady) card.querySelector('.ply').onclick = () => openModal(w.link, prompt);
    g.appendChild(card);
  });
}

function startPolling() {
  fetchWorks();
  pollTimer = setInterval(fetchWorks, 8000);
}

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
  if (state.tab === 'text') { $('#textPrompt').value = m.prompt; }
  else if (state.tab === 'image') { $('#imgPrompt').value = m.prompt; }
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

$$('.tab').forEach((t) => t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  state.tab = t.dataset.tab;
  ['text', 'image', 'cinematic', 'effects'].forEach((p) =>
    $('#pane-' + p).classList.toggle('hidden', p !== state.tab)
  );
});

$('#textModelSearch').oninput = (e) => { state.textSearch = e.target.value; renderModels('text'); };
$('#imageModelSearch').oninput = (e) => { state.imageSearch = e.target.value; renderModels('image'); };

$('#randTextBtn').onclick = () => { $('#textPrompt').value = TEXT_SAMPLES[Math.floor(Math.random() * TEXT_SAMPLES.length)]; };
$('#randImgBtn').onclick = () => { $('#imgPrompt').value = IMG_SAMPLES[Math.floor(Math.random() * IMG_SAMPLES.length)]; };

$('#genBtn').onclick = generate;
$('#refreshBtn').onclick = () => { fetchWorks._last = ''; fetchWorks(); toast('Gallery refreshed', 'ok'); };

setupDrop($('#imgDrop'), (b64) => { state.imageB64 = b64; });
setupDrop($('#effDrop'), (b64) => { state.effB64 = b64; });

// Initialize Auth & Session on page start
initSession();
