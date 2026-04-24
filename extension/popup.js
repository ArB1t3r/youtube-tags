'use strict';

let state = { tags: [], channels: [], uiState: { activeTagFilters: [], showUnsorted: false, sidebarMode: 'default', hideShorts: true, hideLive: true, colCount: 4 } };

async function load() {
  return new Promise(resolve => {
    chrome.storage.local.get(['tags', 'channels', 'uiState'], d => {
      state.tags      = d.tags      || [];
      state.channels  = d.channels  || [];
      state.uiState   = { activeTagFilters: [], showUnsorted: false, sidebarMode: 'default', hideShorts: true, hideLive: true, colCount: 4, ...(d.uiState || {}) };
      resolve();
    });
  });
}

function sendBg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function render() {
  await load();

  // Unsorted banner
  const unsortedCount = state.channels.filter(c => !c.sorted).length;
  const banner = document.getElementById('unsorted-banner');
  if (unsortedCount > 0) {
    document.getElementById('unsorted-count').textContent = unsortedCount;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // Tag pills
  const list = document.getElementById('tag-list');
  if (!state.tags.length) {
    list.innerHTML = '<span class="muted">No tags yet. Create them in options.</span>';
  } else {
    const { activeTagFilters, showUnsorted } = state.uiState;
    list.innerHTML = state.tags.map(tag => {
      const active = activeTagFilters.includes(tag.id);
      return `<button class="tag-pill${active ? ' active' : ''}"
                data-id="${tag.id}"
                style="--tc:${tag.color}">
                ${esc(tag.name)}
              </button>`;
    }).join('');

    list.querySelectorAll('.tag-pill').forEach(btn => {
      btn.addEventListener('click', () => toggleTag(btn.dataset.id));
    });
  }

  // Sidebar mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.uiState.sidebarMode);
  });

  // Content filter toggles
  document.querySelectorAll('.toggle-switch').forEach(btn => {
    const key = btn.dataset.key;
    btn.classList.toggle('on', !!state.uiState[key]);
  });
}

async function toggleTag(tagId) {
  const ui = { ...state.uiState };
  const idx = ui.activeTagFilters.indexOf(tagId);
  if (idx >= 0) ui.activeTagFilters.splice(idx, 1);
  else { ui.activeTagFilters.push(tagId); ui.showUnsorted = false; }
  state.uiState = ui;
  await sendBg({ type: 'SET_UI_STATE', patch: ui });
  render();
}

// Wire up events
document.getElementById('open-options').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('go-unsorted')?.addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('clear-filters').addEventListener('click', async () => {
  const ui = { ...state.uiState, activeTagFilters: [], showUnsorted: false };
  state.uiState = ui;
  await sendBg({ type: 'SET_UI_STATE', patch: ui });
  render();
});

document.querySelector('.mode-row').addEventListener('click', async e => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode;
  const ui = { ...state.uiState, sidebarMode: mode };
  state.uiState = ui;
  await sendBg({ type: 'SET_UI_STATE', patch: ui });
  render();
});

document.querySelector('.toggle-row').addEventListener('click', async e => {
  const btn = e.target.closest('.toggle-switch');
  if (!btn) return;
  const key = btn.dataset.key;
  const ui = { ...state.uiState, [key]: !state.uiState[key] };
  state.uiState = ui;
  await sendBg({ type: 'SET_UI_STATE', patch: ui });
  render();
});

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

render();
