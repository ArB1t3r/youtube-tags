'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = { tags: [], channels: [], channelStats: {}, aiProvider: 'openai', aiModel: null, supabaseUrl: '' };
let activeFilter = 'all';
let searchQuery  = '';
let modalChannel = null;
let selectedTagIds = [];

const DEFAULT_COLORS = [
  '#3ea6ff', '#f44336', '#ff9800', '#ffeb3b', '#4caf50',
  '#00bcd4', '#9c27b0', '#e91e63', '#8bc34a', '#607d8b'
];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  await loadState();
  setupNav();
  setupSubscriptionsTab();
  setupTagsTab();
  setupSettingsTab();
  setupModal();
  setupBatchUI();
  renderAll();
}

async function loadState() {
  const data = await sendBg({ type: 'GET_ALL_DATA' });
  if (data && !data.error) {
    state.tags         = data.tags         || [];
    state.channels     = data.channels     || [];
    state.channelStats = data.channelStats || {};
    state.aiProvider   = data.aiProvider   || 'openai';
    state.aiModel      = data.aiModel      || null;
    state.supabaseUrl  = data.supabaseUrl  || '';
  }
}

function renderAll() {
  renderChannelList();
  renderTagFilters();
  renderTagsFull();
  updateBadges();
}

// ---------------------------------------------------------------------------
// Nav tabs
// ---------------------------------------------------------------------------
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// SUBSCRIPTIONS TAB
// ---------------------------------------------------------------------------
function setupSubscriptionsTab() {
  document.getElementById('ch-search').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    renderChannelList();
  });

  document.getElementById('ch-filters').addEventListener('click', e => {
    const pill = e.target.closest('[data-filter]');
    if (!pill) return;
    activeFilter = pill.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    renderChannelList();
  });

  document.getElementById('sync-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-btn');
    const before = (state.channels || []).length;
    btn.textContent = '↻ Opening…';
    btn.disabled = true;

    // Open YouTube channels page — content script will auto-scroll & detect
    chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels', active: true });

    // Poll for new channels
    let stableRounds = 0;
    let lastCount = before;
    const poll = setInterval(async () => {
      await loadState();
      const now = (state.channels || []).length;
      btn.textContent = `↻ Detecting… (${now})`;
      if (now === lastCount) {
        stableRounds++;
        if (stableRounds >= 5) {
          clearInterval(poll);
          btn.disabled = false;
          const added = now - before;
          btn.textContent = '↻ Sync Channels';
          renderAll();
          if (added > 0) alert(`Done! ${added} new channel(s) detected.`);
          else alert('Done! No new channels found.');
        }
      } else {
        stableRounds = 0;
        lastCount = now;
      }
    }, 2000);
  });

  document.getElementById('suggest-all-btn').addEventListener('click', runSuggestAll);
}

function getFilteredChannels() {
  let list = [...state.channels];
  if (activeFilter === 'unsorted') list = list.filter(c => !c.sorted);
  else if (activeFilter === 'skipped') list = list.filter(c => c.sorted && !(c.tagIds || []).length);
  else if (activeFilter !== 'all')  list = list.filter(c => (c.tagIds || []).includes(activeFilter));
  if (searchQuery) list = list.filter(c => c.name.toLowerCase().includes(searchQuery));
  list.sort((a, b) => {
    if (!a.sorted && b.sorted) return -1;
    if (a.sorted && !b.sorted) return 1;
    return a.name.localeCompare(b.name);
  });
  return list;
}

function renderChannelList() {
  const list = getFilteredChannels();
  const el   = document.getElementById('channel-list');
  if (!list.length) { el.innerHTML = '<span class="muted">No channels match this filter.</span>'; return; }

  el.innerHTML = list.map(ch => {
    const tags       = (ch.tagIds || []).map(tid => state.tags.find(t => t.id === tid)).filter(Boolean);
    const watchCount = state.channelStats[ch.id]?.watch_count || 0;
    return `<div class="channel-row${ch.sorted ? '' : ' unsorted'}" data-id="${ch.id}">
      ${ch.thumbnail
        ? `<img class="ch-thumb" src="${ch.thumbnail}" alt="">`
        : '<div class="ch-thumb-placeholder"></div>'}
      <div class="ch-info">
        <div class="ch-name">${esc(ch.name)}
          ${!ch.sorted ? '<span class="badge-unsorted">unsorted</span>' : ''}
        </div>
        ${ch.handle ? `<div class="ch-handle">${esc(ch.handle)}</div>` : ''}
      </div>
      <div class="ch-tags">
        ${tags.map(t => `<span class="tag-chip" style="--tc:${t.color}">${esc(t.name)}</span>`).join('')}
        ${!tags.length ? '<span class="no-tags">no tags</span>' : ''}
      </div>
      <div class="ch-stats">${watchCount > 0 ? `<span class="watch-count">▶ ${watchCount}</span>` : ''}</div>
      <div class="ch-actions">
        <button class="btn btn-ghost btn-sm edit-tags-btn" data-id="${ch.id}">Edit Tags</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.edit-tags-btn').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.id));
  });
}

function renderTagFilters() {
  const pills = document.getElementById('tag-filter-pills');
  pills.innerHTML = state.tags.map(tag => {
    const count = state.channels.filter(c => (c.tagIds || []).includes(tag.id)).length;
    return `<button class="filter-pill${activeFilter === tag.id ? ' active' : ''}"
              data-filter="${tag.id}" style="--tc:${tag.color}">
              ${esc(tag.name)} <span class="count-badge">${count || ''}</span></button>`;
  }).join('');
  pills.querySelectorAll('[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      activeFilter = pill.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      renderChannelList();
    });
  });
}

function updateBadges() {
  const allCount = state.channels.length;
  const unsortedCount = state.channels.filter(c => !c.sorted).length;
  const skippedCount = state.channels.filter(c => c.sorted && !(c.tagIds || []).length).length;

  document.getElementById('all-count-badge').textContent = allCount || '';
  document.getElementById('unsorted-count-badge').textContent = unsortedCount || '';
  document.getElementById('skipped-count-badge').textContent = skippedCount || '';
}

// ---------------------------------------------------------------------------
// BATCH SUGGEST (10 channels per batch)
// ---------------------------------------------------------------------------
const BATCH_SIZE = 10;
let batchQueue = [];
let batchCancelled = false;

async function runSuggestAll() {
  await loadState();
  const unsorted = state.channels.filter(c => !c.sorted);
  if (!unsorted.length) { alert('No unsorted channels.'); return; }

  batchQueue = [...unsorted];
  batchCancelled = false;
  document.getElementById('batch-overlay').classList.remove('hidden');
  document.getElementById('batch-actions').classList.add('hidden');
  document.getElementById('batch-results').innerHTML = '';

  await runNextBatch();
}

async function runNextBatch() {
  if (batchCancelled || !batchQueue.length) { finishBatch(); return; }

  const chunk = batchQueue.splice(0, BATCH_SIZE);
  const total = chunk.length;
  const progressFill = document.getElementById('batch-progress-fill');
  const progressText = document.getElementById('batch-progress-text');
  const resultsEl    = document.getElementById('batch-results');

  progressFill.style.width = '0%';
  progressText.textContent = `Suggesting 0 / ${total}…`;
  resultsEl.innerHTML = '';

  const batchData = []; // { channel, suggestions, error }

  for (let i = 0; i < chunk.length; i++) {
    if (batchCancelled) break;
    const ch = chunk[i];
    progressText.textContent = `Suggesting ${i + 1} / ${total}… (${esc(ch.name)})`;
    progressFill.style.width = `${((i + 1) / total) * 100}%`;

    let suggestions = [], error = null;
    try {
      const res = await sendBg({ type: 'SUGGEST_TAGS', channelId: ch.id });
      if (res?.error) error = res.error;
      else suggestions = res?.suggestions || [];
    } catch (e) { error = e.message; }

    batchData.push({ channel: ch, suggestions, error });
  }

  if (batchCancelled) { finishBatch(); return; }

  progressText.textContent = `Done — ${batchData.length} channels. Review below:`;
  progressFill.style.width = '100%';

  // Render results
  resultsEl.innerHTML = batchData.map((item, idx) => {
    const { channel, suggestions, error } = item;
    const suggestedTags = suggestions
      .map(name => state.tags.find(t => t.name === name))
      .filter(Boolean);

    const chUrl = channel.handle
      ? `https://www.youtube.com/@${channel.handle.replace('@', '')}`
      : channel.yt_channel_id
        ? `https://www.youtube.com/channel/${channel.yt_channel_id}`
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(channel.name)}`;

    if (error) {
      return `<div class="batch-row" data-idx="${idx}">
        <div class="batch-ch-info">
          ${channel.thumbnail ? `<img class="batch-ch-thumb" src="${channel.thumbnail}">` : '<div class="batch-ch-thumb batch-ch-placeholder"></div>'}
          <a class="batch-ch-name batch-ch-link" href="${chUrl}" target="_blank" title="Open channel in new tab">${esc(channel.name)}</a>
        </div>
        <div class="batch-error">Error: ${esc(error)}</div>
      </div>`;
    }

    const suggestedIds = new Set(suggestedTags.map(t => t.id));

    const tagChips = suggestedTags.length
      ? suggestedTags.map(t => `<span class="tag-chip batch-tag" data-tag-id="${t.id}" data-idx="${idx}" style="--tc:${t.color}">${esc(t.name)}</span>`).join('')
      : '<span class="muted">No suggestions</span>';

    const editChecklist = state.tags.map(t => {
      const checked = suggestedIds.has(t.id);
      return `<label class="batch-check-item">
        <input type="checkbox" value="${t.id}"${checked ? ' checked' : ''}>
        <span class="check-swatch" style="background:${t.color}"></span>
        ${esc(t.name)}
      </label>`;
    }).join('');

    return `<div class="batch-row" data-idx="${idx}" data-channel-id="${channel.id}">
      <div class="batch-row-main">
        <div class="batch-ch-info">
          ${channel.thumbnail ? `<img class="batch-ch-thumb" src="${channel.thumbnail}">` : '<div class="batch-ch-thumb batch-ch-placeholder"></div>'}
          <a class="batch-ch-name batch-ch-link" href="${chUrl}" target="_blank" title="Open channel in new tab">${esc(channel.name)}</a>
        </div>
        <div class="batch-tags">${tagChips}</div>
        <div class="batch-row-actions">
          <button class="btn btn-ghost btn-sm batch-edit-row" data-idx="${idx}">Edit</button>
          <button class="btn btn-primary btn-sm batch-accept-row" data-idx="${idx}">Accept</button>
          <button class="btn btn-ghost btn-sm batch-skip-row" data-idx="${idx}">Skip</button>
        </div>
      </div>
      <div class="batch-edit-panel hidden" data-idx="${idx}">
        <div class="batch-checklist">${editChecklist}</div>
        <button class="btn btn-primary btn-sm batch-edit-done" data-idx="${idx}">Done</button>
      </div>
    </div>`;
  }).join('');

  // Store batch data for accept actions
  resultsEl._batchData = batchData;

  // Edit button toggles checklist panel
  resultsEl.querySelectorAll('.batch-edit-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = resultsEl.querySelector(`.batch-edit-panel[data-idx="${btn.dataset.idx}"]`);
      panel?.classList.toggle('hidden');
    });
  });

  // Done button in edit panel: update tag chips from checkboxes and close
  resultsEl.querySelectorAll('.batch-edit-done').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      const row = resultsEl.querySelector(`.batch-row[data-idx="${idx}"]`);
      const panel = row.querySelector('.batch-edit-panel');
      const tagsDiv = row.querySelector('.batch-tags');

      // Rebuild chips from checked boxes
      const checkedIds = [...panel.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
      if (checkedIds.length) {
        tagsDiv.innerHTML = checkedIds.map(id => {
          const t = state.tags.find(tg => tg.id === id);
          return t ? `<span class="tag-chip batch-tag" data-tag-id="${t.id}" style="--tc:${t.color}">${esc(t.name)}</span>` : '';
        }).join('');
      } else {
        tagsDiv.innerHTML = '<span class="muted">No tags selected</span>';
      }
      panel.classList.add('hidden');
    });
  });

  // Individual accept/skip
  resultsEl.querySelectorAll('.batch-accept-row').forEach(btn => {
    btn.addEventListener('click', () => acceptBatchRow(btn.dataset.idx));
  });
  resultsEl.querySelectorAll('.batch-skip-row').forEach(btn => {
    btn.addEventListener('click', () => skipBatchRow(btn.dataset.idx));
  });

  // Show action buttons
  const actionsEl = document.getElementById('batch-actions');
  actionsEl.classList.remove('hidden');
  document.getElementById('batch-next').classList.toggle('hidden', batchQueue.length === 0);
  document.getElementById('batch-accept-all').textContent = 'Accept All';
}

async function acceptBatchRow(idx) {
  const resultsEl = document.getElementById('batch-results');
  const batchData = resultsEl._batchData;
  if (!batchData?.[idx]) return;

  const { channel } = batchData[idx];
  const row = resultsEl.querySelector(`.batch-row[data-idx="${idx}"]`);
  if (!row || row.classList.contains('batch-row-done')) return;

  // Read from edit panel checkboxes (source of truth)
  const tagIds = [...row.querySelectorAll('.batch-edit-panel input[type=checkbox]:checked')].map(cb => cb.value);

  await sendBg({ type: 'ASSIGN_TAGS', channelId: channel.id, tagIds });
  row.classList.add('batch-row-done');
  row.querySelector('.batch-row-actions').innerHTML = '<span class="batch-done-label">✓ Saved</span>';
}

async function skipBatchRow(idx) {
  const resultsEl = document.getElementById('batch-results');
  const batchData = resultsEl._batchData;
  if (!batchData?.[idx]) return;

  const { channel } = batchData[idx];
  const row = resultsEl.querySelector(`.batch-row[data-idx="${idx}"]`);
  if (!row || row.classList.contains('batch-row-done')) return;

  await sendBg({ type: 'MARK_SORTED', channelId: channel.id });
  row.classList.add('batch-row-done', 'batch-row-skipped');
  row.querySelector('.batch-row-actions').innerHTML = '<span class="muted">Skipped</span>';
}

async function acceptAllBatchRows() {
  const resultsEl = document.getElementById('batch-results');
  const rows = resultsEl.querySelectorAll('.batch-row:not(.batch-row-done)');
  for (const row of rows) {
    await acceptBatchRow(row.dataset.idx);
  }
}

function finishBatch() {
  document.getElementById('batch-overlay').classList.add('hidden');
  batchCancelled = false;
  batchQueue = [];
  loadState().then(() => renderAll());
}

function setupBatchUI() {
  document.getElementById('batch-cancel').addEventListener('click', () => {
    batchCancelled = true;
    finishBatch();
  });
  document.getElementById('batch-accept-all').addEventListener('click', async () => {
    const btn = document.getElementById('batch-accept-all');
    btn.textContent = 'Saving…'; btn.disabled = true;
    await acceptAllBatchRows();
    btn.disabled = false; btn.textContent = 'Accept All';
    await loadState(); renderAll();
  });
  document.getElementById('batch-next').addEventListener('click', async () => {
    await loadState();
    // Remove channels already sorted from queue
    batchQueue = batchQueue.filter(ch => {
      const fresh = state.channels.find(c => c.id === ch.id);
      return fresh && !fresh.sorted;
    });
    await runNextBatch();
  });
  document.getElementById('batch-done').addEventListener('click', finishBatch);
}

// ---------------------------------------------------------------------------
// TAGS TAB
// ---------------------------------------------------------------------------
function setupTagsTab() {
  const colorInput = document.getElementById('new-tag-color');
  const swatchBox  = document.getElementById('color-swatches');

  // Render swatches
  swatchBox.innerHTML = DEFAULT_COLORS.map(c =>
    `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join('');

  function selectColor(hex) {
    colorInput.value = hex;
    swatchBox.querySelectorAll('.color-swatch').forEach(s =>
      s.classList.toggle('active', s.dataset.color === hex)
    );
  }

  swatchBox.addEventListener('click', e => {
    const sw = e.target.closest('.color-swatch');
    if (sw) selectColor(sw.dataset.color);
  });
  colorInput.addEventListener('input', () => {
    swatchBox.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  });

  document.getElementById('new-tag-btn').addEventListener('click', () => {
    document.getElementById('new-tag-form').classList.remove('hidden');
    selectColor(getLeastUsedColor());
    document.getElementById('new-tag-name').value = '';
    document.getElementById('new-tag-name').focus();
  });
  document.getElementById('cancel-tag-btn').addEventListener('click', () => {
    document.getElementById('new-tag-form').classList.add('hidden');
    document.getElementById('new-tag-name').value = '';
  });
  document.getElementById('save-tag-btn').addEventListener('click', saveNewTag);
  document.getElementById('new-tag-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveNewTag(); });
}

function getLeastUsedColor() {
  const usageCount = {};
  for (const c of DEFAULT_COLORS) usageCount[c] = 0;
  for (const tag of state.tags) {
    const norm = tag.color?.toLowerCase();
    if (norm in usageCount) usageCount[norm]++;
  }
  let best = DEFAULT_COLORS[0], min = Infinity;
  for (const c of DEFAULT_COLORS) {
    if (usageCount[c] < min) { min = usageCount[c]; best = c; }
  }
  return best;
}

async function saveNewTag() {
  const name  = document.getElementById('new-tag-name').value.trim();
  const color = document.getElementById('new-tag-color').value;
  if (!name) return;
  if (state.tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    alert('A tag with this name already exists.'); return;
  }
  await sendBg({ type: 'CREATE_TAG', name, color });
  await loadState();
  document.getElementById('new-tag-form').classList.add('hidden');
  document.getElementById('new-tag-name').value = '';
  renderAll();
}

function renderTagsFull() {
  const el = document.getElementById('tag-list-full');
  if (!state.tags.length) { el.innerHTML = '<span class="muted">No tags yet.</span>'; return; }
  el.innerHTML = state.tags.map(tag => {
    const count = state.channels.filter(c => (c.tagIds || []).includes(tag.id)).length;
    return `<div class="tag-row" data-id="${tag.id}">
      <div class="tag-swatch" style="background:${tag.color}"></div>
      <div class="tag-name-edit">
        <input class="tag-name-input" value="${esc(tag.name)}" maxlength="40">
      </div>
      <input type="color" class="tag-color-input" value="${tag.color}">
      <span class="tag-channel-count">${count} channel${count !== 1 ? 's' : ''}</span>
      <button class="btn btn-ghost btn-sm save-tag-row-btn" data-id="${tag.id}">Save</button>
      <button class="btn btn-danger btn-sm delete-tag-btn" data-id="${tag.id}">Delete</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.tag-row').forEach(row => {
    row.querySelector('.tag-color-input').addEventListener('input', e => {
      row.querySelector('.tag-swatch').style.background = e.target.value;
    });
  });
  el.querySelectorAll('.save-tag-row-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row   = btn.closest('.tag-row');
      const name  = row.querySelector('.tag-name-input').value.trim();
      const color = row.querySelector('.tag-color-input').value;
      if (!name) return;
      await sendBg({ type: 'UPDATE_TAG', id: btn.dataset.id, name, color });
      await loadState(); renderAll();
    });
  });
  el.querySelectorAll('.delete-tag-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tag = state.tags.find(t => t.id === btn.dataset.id);
      if (!confirm(`Delete tag "${tag?.name}"? It will be removed from all channels.`)) return;
      await sendBg({ type: 'DELETE_TAG', id: btn.dataset.id });
      await loadState(); renderAll();
    });
  });
}

// ---------------------------------------------------------------------------
// SETTINGS TAB
// ---------------------------------------------------------------------------
function setupSettingsTab() {
  // Pre-fill from storage
  chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey', 'aiProvider', 'aiModel', 'aiApiKey', 'watchPeriodDays'], d => {
    if (d.supabaseUrl)     document.getElementById('sb-url').value  = d.supabaseUrl;
    if (d.supabaseAnonKey) document.getElementById('sb-key').value  = d.supabaseAnonKey;
    if (d.aiApiKey)        document.getElementById('ai-key').value  = d.aiApiKey;

    // Set model selector
    if (d.aiProvider && d.aiModel) {
      const val = `${d.aiProvider}:${d.aiModel}`;
      const sel = document.getElementById('ai-model');
      if ([...sel.options].some(o => o.value === val)) sel.value = val;
    }

    // Set watch period selector
    const periodSel = document.getElementById('watch-period');
    if (d.watchPeriodDays != null) periodSel.value = String(d.watchPeriodDays);
  });

  // Save Supabase
  document.getElementById('save-supabase-btn').addEventListener('click', async () => {
    const url  = document.getElementById('sb-url').value.trim();
    const key  = document.getElementById('sb-key').value.trim();
    const stat = document.getElementById('sb-status');
    if (!url || !key) { stat.textContent = 'Both fields required.'; return; }
    stat.textContent = 'Connecting…';
    const res = await sendBg({ type: 'CONFIGURE_SUPABASE', url, anonKey: key });
    stat.textContent = res?.ok ? '✓ Connected' : '✗ ' + (res?.error || 'Failed');
    if (res?.ok) { await loadState(); renderAll(); }
  });

  // Save AI
  document.getElementById('save-ai-btn').addEventListener('click', async () => {
    const modelId = document.getElementById('ai-model').value;
    const [provider, ...modelParts] = modelId.split(':');
    const model  = modelParts.join(':');
    const apiKey = document.getElementById('ai-key').value.trim();
    const stat   = document.getElementById('ai-status');
    if (!apiKey) { stat.textContent = 'API key required.'; return; }
    await sendBg({ type: 'CONFIGURE_AI', provider, model, apiKey });
    stat.textContent = '✓ Saved';
    setTimeout(() => { stat.textContent = ''; }, 2000);
  });

  // Save watch period
  document.getElementById('save-watch-period-btn').addEventListener('click', async () => {
    const days = parseInt(document.getElementById('watch-period').value, 10);
    await chrome.storage.local.set({ watchPeriodDays: days });
    const stat = document.getElementById('watch-period-status');
    stat.textContent = '✓ Saved';
    setTimeout(() => { stat.textContent = ''; }, 2000);
  });

  // Reset watch stats
  document.getElementById('reset-watch-btn').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to reset ALL watch counts? This cannot be undone.')) return;
    const btn = document.getElementById('reset-watch-btn');
    btn.textContent = 'Resetting…'; btn.disabled = true;
    await sendBg({ type: 'RESET_WATCH_STATS' });
    btn.disabled = false; btn.textContent = 'Reset All Watch Counts';
    await loadState(); renderAll();
    alert('All watch counts have been reset.');
  });

  document.getElementById('reset-channels-btn').addEventListener('click', async () => {
    if (!confirm('This will clear ALL detected channels. Your tags will be kept. Continue?')) return;
    const btn = document.getElementById('reset-channels-btn');
    btn.textContent = 'Resetting…'; btn.disabled = true;
    await sendBg({ type: 'RESET_CHANNELS' });
    btn.disabled = false; btn.textContent = 'Reset All Channels';
    await loadState(); renderAll();
    alert('All channels cleared. Browse YouTube to re-detect them.');
  });
}

// ---------------------------------------------------------------------------
// MODAL
// ---------------------------------------------------------------------------
function setupModal() {
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-ai-btn').addEventListener('click', runAISuggest);
  document.getElementById('modal-save-btn').addEventListener('click', async () => {
    if (!modalChannel) return;
    await sendBg({ type: 'ASSIGN_TAGS', channelId: modalChannel.id, tagIds: selectedTagIds });
    await loadState(); renderAll(); closeModal();
  });
  document.getElementById('modal-skip-btn').addEventListener('click', async () => {
    if (!modalChannel) return;
    await sendBg({ type: 'MARK_SORTED', channelId: modalChannel.id });
    await loadState(); renderAll(); closeModal();
  });
}

function openModal(channelId) {
  modalChannel   = state.channels.find(c => c.id === channelId);
  if (!modalChannel) return;
  selectedTagIds = [...(modalChannel.tagIds || [])];
  document.getElementById('modal-title').textContent = 'Tags for ' + modalChannel.name;
  document.getElementById('modal-ai-suggestions').classList.add('hidden');
  renderModalCheckboxes();
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function openModalWithSuggestions(channelId, suggestions) {
  return new Promise(resolve => {
    openModal(channelId);
    showSuggestions(suggestions);
    const cleanup = () => resolve();
    ['modal-save-btn', 'modal-skip-btn', 'modal-close'].forEach(id => {
      document.getElementById(id).addEventListener('click', cleanup, { once: true });
    });
  });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  modalChannel = null;
}

function renderModalCheckboxes() {
  const el = document.getElementById('modal-tag-checkboxes');
  if (!state.tags.length) {
    el.innerHTML = '<span class="muted">No tags yet. Create them in the Tags tab.</span>';
    return;
  }
  el.innerHTML = state.tags.map(tag => {
    const checked = selectedTagIds.includes(tag.id);
    return `<label class="check-row">
      <input type="checkbox" value="${tag.id}"${checked ? ' checked' : ''}>
      <span class="check-swatch" style="background:${tag.color}"></span>
      ${esc(tag.name)}
    </label>`;
  }).join('');
  el.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) { if (!selectedTagIds.includes(cb.value)) selectedTagIds.push(cb.value); }
      else selectedTagIds = selectedTagIds.filter(id => id !== cb.value);
    });
  });
}

async function runAISuggest() {
  if (!modalChannel) return;
  const btn = document.getElementById('modal-ai-btn');
  btn.textContent = '✨ Thinking…'; btn.disabled = true;
  const res = await sendBg({ type: 'SUGGEST_TAGS', channelId: modalChannel.id });
  btn.disabled = false; btn.textContent = '✨ Suggest Tags';
  if (res?.error) { alert('AI error: ' + res.error); return; }
  showSuggestions(res?.suggestions || []);
}

function showSuggestions(suggestions) {
  const box   = document.getElementById('modal-ai-suggestions');
  const pills = document.getElementById('suggestion-pills');
  if (!suggestions.length) {
    pills.innerHTML = '<span class="muted">No matching tags suggested.</span>';
    box.classList.remove('hidden'); return;
  }
  pills.innerHTML = suggestions.map(name => {
    const tag    = state.tags.find(t => t.name === name);
    if (!tag) return '';
    const already = selectedTagIds.includes(tag.id);
    return `<button class="suggest-pill${already ? ' added' : ''}"
                     data-tag-id="${tag.id}" style="--tc:${tag.color}">
              ${already ? '✓ ' : '+ '}${esc(tag.name)}</button>`;
  }).join('');
  box.classList.remove('hidden');
  pills.querySelectorAll('.suggest-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tagId = pill.dataset.tagId;
      if (!selectedTagIds.includes(tagId)) {
        selectedTagIds.push(tagId);
        pill.classList.add('added');
        pill.textContent = '✓ ' + (state.tags.find(t => t.id === tagId)?.name || '');
        const cb = document.querySelector(`#modal-tag-checkboxes input[value="${tagId}"]`);
        if (cb) cb.checked = true;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sendBg(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(r || null)); }
    catch (e) { resolve({ error: e.message }); }
  });
}
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

boot();
