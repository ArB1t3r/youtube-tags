// YouTube Tags — welcome / onboarding wizard

'use strict';

// ── Default tags ──────────────────────────────────────────────────────────────
const DEFAULT_TAGS = [
  { name: 'Must Watch',    color: '#ff4e45' },
  { name: 'Entertainment', color: '#f4a832' },
  { name: 'Educational',   color: '#4caf50' },
  { name: 'Gaming',        color: '#9c27b0' },
  { name: 'Music',         color: '#3ea6ff' },
];

let pendingTags = DEFAULT_TAGS.map(t => ({ ...t }));
let currentStep = 1;
let channelPollTimer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendBg(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(r || null)); } catch { resolve(null); }
  });
}

// ── Step navigation ───────────────────────────────────────────────────────────
function goToStep(n) {
  currentStep = n;
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', +s.dataset.step === n));
  document.querySelectorAll('.dot').forEach(d => {
    const dn = +d.dataset.dot;
    d.classList.toggle('active', dn === n);
    d.classList.toggle('done', dn < n);
  });

  // Start/stop channel polling
  if (n === 3) startChannelPolling();
  else stopChannelPolling();

  // Populate done summary
  if (n === 6) populateSummary();
}

document.addEventListener('click', e => {
  const next = e.target.closest('[data-next]');
  if (next) {
    const n = +next.dataset.next;
    // If leaving step 2 → save tags first
    if (currentStep === 2 && n === 3) {
      saveTags().then(() => goToStep(n));
      return;
    }
    goToStep(n);
  }
  const prev = e.target.closest('[data-prev]');
  if (prev) goToStep(+prev.dataset.prev);
});

// ── Step 2: Tag editor ────────────────────────────────────────────────────────
function renderTags() {
  const list = document.getElementById('default-tags');
  list.innerHTML = pendingTags.map((t, i) => `
    <div class="tag-item" data-idx="${i}">
      <span class="tag-swatch" style="background:${t.color}"></span>
      <span class="tag-item-name">${esc(t.name)}</span>
      <button class="tag-remove" data-remove="${i}" title="Remove">&times;</button>
    </div>
  `).join('');
}

document.addEventListener('click', e => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    pendingTags.splice(+rm.dataset.remove, 1);
    renderTags();
  }
});

document.getElementById('add-tag-btn').addEventListener('click', () => {
  const input = document.getElementById('new-tag-input');
  const color = document.getElementById('new-tag-color');
  const name = input.value.trim();
  if (!name) return;
  if (pendingTags.some(t => t.name.toLowerCase() === name.toLowerCase())) return;
  pendingTags.push({ name, color: color.value });
  input.value = '';
  renderTags();
});

document.getElementById('new-tag-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-tag-btn').click();
});

async function saveTags() {
  // Check existing tags to avoid duplicates
  const data = await sendBg({ type: 'GET_ALL_DATA' });
  const existing = (data?.tags || []).map(t => t.name.toLowerCase());

  for (const t of pendingTags) {
    if (!existing.includes(t.name.toLowerCase())) {
      await sendBg({ type: 'CREATE_TAG', name: t.name, color: t.color });
    }
  }
}

// ── Step 3: Channel detection polling ─────────────────────────────────────────
document.getElementById('open-youtube-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels' });
});

function startChannelPolling() {
  updateChannelCount();
  channelPollTimer = setInterval(updateChannelCount, 2000);
}

function stopChannelPolling() {
  if (channelPollTimer) { clearInterval(channelPollTimer); channelPollTimer = null; }
}

async function updateChannelCount() {
  const data = await sendBg({ type: 'GET_ALL_DATA' });
  const count = (data?.channels || []).length;
  document.getElementById('channel-count').textContent = count;
  const dot = document.querySelector('#detect-status .status-dot');
  dot.classList.toggle('active', count > 0);
}

// ── Step 5: AI API key ────────────────────────────────────────────────────────
document.getElementById('save-ai-btn').addEventListener('click', async () => {
  const modelVal = document.getElementById('ai-model').value;
  const apiKey = document.getElementById('ai-key').value.trim();
  const status = document.getElementById('ai-status');
  const finishBtn = document.getElementById('skip-or-finish');

  if (!apiKey) {
    status.textContent = 'Please enter an API key.';
    status.className = 'status-text error';
    return;
  }

  const [provider, model] = modelVal.split(':');
  await sendBg({ type: 'CONFIGURE_AI', provider, model, apiKey });

  status.textContent = 'Saved!';
  status.className = 'status-text success';
  finishBtn.textContent = 'Finish';
});

// ── Step 6: Summary ───────────────────────────────────────────────────────────
async function populateSummary() {
  const data = await sendBg({ type: 'GET_ALL_DATA' });
  const tagCount = (data?.tags || []).length;
  const chCount = (data?.channels || []).length;
  const hasAI = !!data?.aiModel;

  document.getElementById('done-summary').innerHTML = `
    <div class="done-stat"><div class="num">${tagCount}</div><div class="label">Tags created</div></div>
    <div class="done-stat"><div class="num">${chCount}</div><div class="label">Channels detected</div></div>
    <div class="done-stat"><div class="num">${hasAI ? 'On' : 'Off'}</div><div class="label">AI suggestions</div></div>
  `;
}

document.getElementById('open-youtube-final').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.youtube.com' });
  window.close();
});

document.getElementById('open-options-final').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Init ──────────────────────────────────────────────────────────────────────
renderTags();
