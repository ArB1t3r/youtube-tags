// YouTube Tags — content script
// Reads from chrome.storage.local only. All writes go through background.js.

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = {
  tags: [],
  channels: [],
  channelStats: {},
  watchPeriodDays: 0, // 0 = all time
  filteredWatchCounts: null, // time-filtered counts (null = use channelStats)
  uiState: {
    activeTagFilters: [],
    showUnsorted: false,
    sidebarMode: 'default',
    hideShorts: true,
    hideLive: true,
    colCount: 4
  }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    await loadState();
    interceptLogoClicks();
    handleRoute();
    setupStorageListener();
    setupSubscribeDetection();
  } catch {
    // Extension context invalidated (e.g. after reload) — ignore silently
  }
}

// Intercept YouTube logo clicks — go to subscriptions directly, no flash
function interceptLogoClicks() {
  document.addEventListener('click', e => {
    if (state.uiState.autoRedirect === false) return;
    const link = e.target.closest('a#logo, a[href="/"], ytd-topbar-logo-renderer a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href === '/' || href === '' || href === 'https://www.youtube.com/') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      history.pushState(null, '', '/feed/subscriptions');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.location.href = '/feed/subscriptions';
    }
  }, true);
}

function loadState() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['tags', 'channels', 'channelStats', 'uiState', 'watchPeriodDays'], d => {
        if (chrome.runtime.lastError) { resolve(); return; }
        state.tags         = d.tags         || [];
        state.channels     = d.channels     || [];
        state.channelStats = d.channelStats || {};
        state.watchPeriodDays = d.watchPeriodDays || 0;
        state.uiState = {
          activeTagFilters: [], showUnsorted: false,
          sidebarMode: 'default', hideShorts: true, hideLive: true, colCount: 4,
          ...(d.uiState || {})
        };
        // Load time-filtered watch counts if period is set
        if (state.watchPeriodDays > 0) {
          sendBg({ type: 'GET_WATCH_COUNTS', periodDays: state.watchPeriodDays }).then(res => {
            state.filteredWatchCounts = res?.counts || null;
            resolve();
          });
        } else {
          state.filteredWatchCounts = null;
          resolve();
        }
      });
    } catch { resolve(); }
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
function handleRoute() {
  const path = location.pathname;

  if ((path === '/' || path === '') && state.uiState.autoRedirect !== false) {
    location.replace('/feed/subscriptions');
    return;
  }

  if (path === '/feed/subscriptions') {
    setupFeedPage();
  }

  if (path === '/watch') {
    setupWatchPage();
  }

  if (path === '/feed/channels') {
    setupChannelsPage();
  }

  setupSidebar();
}

// ---------------------------------------------------------------------------
// SUBSCRIPTION FEED
// ---------------------------------------------------------------------------
let feedObserver = null;
let feedDebounce = null;

function setupFeedPage() {
  document.getElementById('yn-filter-bar')?.remove();

  waitFor('ytd-rich-grid-renderer, ytd-section-list-renderer', container => {
    injectFilterBar(container);
    applyColumnCount(state.uiState.colCount || 4);

    const contents = container.querySelector('#contents') || container;
    hideUnwantedSections();
    applyFeedFilter();
    detectFeedChannels();
    // Re-check after metadata text loads asynchronously
    setTimeout(hideUnwantedSections, 800);
    setTimeout(hideUnwantedSections, 2000);
    // Re-check filter after channel metadata lazy-loads
    setTimeout(applyFeedFilter, 600);
    setTimeout(applyFeedFilter, 1500);

    if (feedObserver) feedObserver.disconnect();
    feedObserver = new MutationObserver(() => {
      // Debounce to prevent rapid hide-load-hide cycles with YouTube's infinite scroll
      clearTimeout(feedDebounce);
      feedDebounce = setTimeout(() => {
        hideUnwantedSections();
        applyFeedFilter();
        detectFeedChannels();
        setTimeout(hideUnwantedSections, 800);
        // Re-check filter for items whose channel metadata loaded late
        setTimeout(applyFeedFilter, 600);
      }, 300);
    });
    feedObserver.observe(contents, { childList: true, subtree: true });
  });
}

// ---------------------------------------------------------------------------
// Column count — CSS injection
// ---------------------------------------------------------------------------
function applyColumnCount(n) {
  let el = document.getElementById('yn-col-style');
  if (!el) {
    el = document.createElement('style');
    el.id = 'yn-col-style';
    document.head.appendChild(el);
  }
  const pct = (100 / n).toFixed(4);
  // Scale font sizes proportionally — keep titles fully readable
  const titleSize = Math.max(10, 16 - (n - 3) * 1.0).toFixed(1);
  const metaSize  = Math.max(9, 12 - (n - 3) * 0.5).toFixed(1);
  // YouTube uses --ytd-rich-grid-items-per-row on both the renderer and :root.
  // We must override all levels and also remove any min-width YouTube sets.
  el.textContent = `
    :root {
      --ytd-rich-grid-items-per-row: ${n} !important;
    }
    ytd-rich-grid-renderer {
      --ytd-rich-grid-items-per-row: ${n} !important;
    }
    ytd-rich-grid-renderer #contents {
      --ytd-rich-grid-items-per-row: ${n} !important;
    }
    ytd-rich-grid-renderer ytd-rich-item-renderer {
      min-width: 0 !important;
    }
    ytd-rich-grid-renderer ytd-rich-item-renderer ytd-rich-grid-media {
      width: 100% !important;
      max-width: 100% !important;
    }

    /* ── Force full titles: override every layer in the title chain ── */
    ytd-rich-grid-renderer ytd-rich-item-renderer #details,
    ytd-rich-grid-renderer ytd-rich-item-renderer #meta,
    ytd-rich-grid-renderer ytd-rich-item-renderer #video-title-link,
    ytd-rich-grid-renderer ytd-rich-item-renderer h3.ytd-rich-grid-media,
    ytd-rich-grid-renderer ytd-rich-item-renderer h3 {
      overflow: visible !important;
      max-height: none !important;
      -webkit-line-clamp: unset !important;
      -webkit-box-orient: unset !important;
      display: block !important;
      text-overflow: unset !important;
    }
    ytd-rich-grid-renderer ytd-rich-item-renderer #video-title,
    ytd-rich-grid-renderer ytd-rich-item-renderer yt-formatted-string#video-title,
    ytd-rich-grid-renderer ytd-rich-item-renderer a#video-title-link yt-formatted-string {
      font-size: ${titleSize}px !important;
      line-height: 1.4 !important;
      max-height: none !important;
      -webkit-line-clamp: unset !important;
      -webkit-box-orient: unset !important;
      display: block !important;
      overflow: visible !important;
      text-overflow: unset !important;
      white-space: normal !important;
      word-break: break-word !important;
    }

    /* ── Metadata text ── */
    ytd-rich-grid-renderer ytd-rich-item-renderer #metadata,
    ytd-rich-grid-renderer ytd-rich-item-renderer #metadata-line,
    ytd-rich-grid-renderer ytd-rich-item-renderer #channel-name,
    ytd-rich-grid-renderer ytd-rich-item-renderer ytd-channel-name,
    ytd-rich-grid-renderer ytd-rich-item-renderer .ytd-channel-name {
      font-size: ${metaSize}px !important;
    }
  `;
}

// ---------------------------------------------------------------------------
// Section hiding — "Most relevant", Shorts, Livestream shelves
// ---------------------------------------------------------------------------
function hideUnwantedSections() {
  const { hideShorts, hideLive } = state.uiState;

  document.querySelectorAll('ytd-rich-section-renderer').forEach(section => {
    const titleEl  = section.querySelector('#title-text, #title, ytd-rich-shelf-renderer #title-text');
    const text     = (titleEl?.textContent || '').trim().toLowerCase();
    const isShorts = text.includes('short') || !!section.querySelector('ytd-reel-item-renderer, [is-shorts]');
    const isRelev  = text.includes('most relevant') || text.includes('relevant');
    const isLive   = text.includes('live') || text.includes('streaming');

    if (isRelev || (isShorts && hideShorts) || (isLive && hideLive)) {
      section.style.setProperty('display', 'none', 'important');
    }
  });

  document.querySelectorAll('ytd-rich-shelf-renderer').forEach(shelf => {
    const text     = (shelf.querySelector('#title-text, #title')?.textContent || '').trim().toLowerCase();
    const isShorts = text.includes('short') || !!shelf.querySelector('ytd-reel-item-renderer') || shelf.hasAttribute('is-shorts');
    const isRelev  = text.includes('most relevant') || text.includes('relevant');
    if ((isShorts && hideShorts) || isRelev) {
      shelf.style.setProperty('display', 'none', 'important');
    }
  });

  document.querySelectorAll('ytd-rich-item-renderer').forEach(item => {
    if (item.hasAttribute('data-yn-tag-hidden')) return;
    const isShort = hideShorts && (item.querySelector('[overlay-style="SHORTS"], ytd-reel-item-renderer'));
    let isLive = false;
    if (hideLive) {
      if (item.querySelector('[overlay-style="LIVE"], [overlay-style="UPCOMING"]')) {
        isLive = true;
      } else {
        const allText = item.innerText.toLowerCase();
        if (allText.includes('streamed') || allText.includes('streaming')) {
          isLive = true;
        }
      }
    }
    if (isShort || isLive) {
      item.setAttribute('data-yn-hidden', '1');
    }
  });
}

// ---------------------------------------------------------------------------
// Filter bar (tag pills + column slider)
// ---------------------------------------------------------------------------
function injectFilterBar(container) {
  if (document.getElementById('yn-filter-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'yn-filter-bar';
  bar.innerHTML = renderFilterBar();
  container.parentNode.insertBefore(bar, container);
  bindFilterBar(bar);
}

function renderFilterBar() {
  const { activeTagFilters, showUnsorted, colCount = 4 } = state.uiState;
  const showAll       = !activeTagFilters.length && !showUnsorted;
  const unsortedCount = state.channels.filter(c => !c.sorted).length;

  let pills = `<button class="yn-pill${showAll ? ' active' : ''}" data-filter="all">All</button>`;
  for (const tag of state.tags) {
    const active = activeTagFilters.includes(tag.id);
    pills += `<button class="yn-pill${active ? ' active' : ''}" data-filter="tag:${tag.id}" style="--tc:${tag.color}">${esc(tag.name)}</button>`;
  }
  if (unsortedCount > 0) {
    pills += `<button class="yn-pill yn-unsorted${showUnsorted ? ' active' : ''}" data-filter="unsorted">Unsorted <span class="yn-badge">${unsortedCount}</span></button>`;
  }

  return `
    <div class="yn-bar-row">
      <span class="yn-label">Filter:</span>
      ${pills}
      <div class="yn-col-ctrl">
        <span class="yn-col-icon" title="Videos per row">⊞</span>
        <input type="range" id="yn-col-slider" min="3" max="8" step="1" value="${colCount}" class="yn-col-slider">
        <span id="yn-col-val" class="yn-col-val">${colCount}</span>
      </div>
      <a href="#" id="yn-manage-link" class="yn-manage-link">⚙ Manage</a>
    </div>`;
}

function bindFilterBar(bar) {
  bar.addEventListener('click', e => {
    const pill = e.target.closest('[data-filter]');
    if (!pill) return;
    const f  = pill.dataset.filter;
    const ui = { ...state.uiState };
    if (f === 'all') {
      ui.activeTagFilters = []; ui.showUnsorted = false;
    } else if (f === 'unsorted') {
      ui.showUnsorted = !ui.showUnsorted;
      if (ui.showUnsorted) ui.activeTagFilters = [];
    } else {
      const tagId = f.replace('tag:', '');
      ui.showUnsorted = false;
      const idx = ui.activeTagFilters.indexOf(tagId);
      if (idx >= 0) ui.activeTagFilters.splice(idx, 1);
      else ui.activeTagFilters.push(tagId);
    }
    state.uiState = ui;
    sendBg({ type: 'SET_UI_STATE', patch: ui });
    updateFilterPills(bar);
    applyFeedFilter();
  });

  bar.querySelector('#yn-manage-link')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    sendBg({ type: 'OPEN_OPTIONS' });
  });

  const slider = bar.querySelector('#yn-col-slider');
  const valEl  = bar.querySelector('#yn-col-val');
  slider?.addEventListener('input', () => {
    const n = parseInt(slider.value);
    if (valEl) valEl.textContent = n;
    state.uiState = { ...state.uiState, colCount: n };
    sendBg({ type: 'SET_UI_STATE', patch: { colCount: n } });
    applyColumnCount(n);
  });
}

// Lightweight pill update — toggle classes only, no DOM rebuild
function updateFilterPills(bar) {
  const { activeTagFilters, showUnsorted } = state.uiState;
  const showAll = !activeTagFilters.length && !showUnsorted;
  bar.querySelectorAll('[data-filter]').forEach(pill => {
    const f = pill.dataset.filter;
    let active = false;
    if (f === 'all')            active = showAll;
    else if (f === 'unsorted')  active = showUnsorted;
    else                        active = activeTagFilters.includes(f.replace('tag:', ''));
    pill.classList.toggle('active', active);
  });
}

function refreshFilterBar() {
  const bar = document.getElementById('yn-filter-bar');
  if (!bar) return;
  bar.innerHTML = renderFilterBar();
  bindFilterBar(bar);
}

// ---------------------------------------------------------------------------
// Video tag filtering (NO detectFeedChannels here — called separately)
// ---------------------------------------------------------------------------
function applyFeedFilter() {
  const { activeTagFilters, showUnsorted } = state.uiState;
  const showAll = !activeTagFilters.length && !showUnsorted;

  // Toggle a marker on the grid so CSS can apply grid-aware hiding
  const grid = document.querySelector('ytd-rich-grid-renderer');
  if (grid) grid.toggleAttribute('data-yn-filtering', !showAll);

  document.querySelectorAll('ytd-rich-item-renderer').forEach(item => {
    if (item.hasAttribute('data-yn-hidden')) return;

    if (showAll) {
      item.removeAttribute('data-yn-tag-hidden');
      return;
    }

    // If channel metadata hasn't loaded yet, skip — will be re-checked later
    const link = item.querySelector('ytd-channel-name a, #channel-name a, a.yt-simple-endpoint[href*="/@"], a.yt-simple-endpoint[href*="/channel/"]');
    if (!link) return;

    const ch = resolveChannel(link.href, link.textContent.trim());
    let visible = false;
    if (showUnsorted) visible = !ch || !ch.sorted;
    else if (ch)       visible = activeTagFilters.some(tid => (ch.tagIds || []).includes(tid));

    if (visible) {
      item.removeAttribute('data-yn-tag-hidden');
    } else {
      item.setAttribute('data-yn-tag-hidden', '1');
    }
  });
}

function detectFeedChannels() {
  const found = [];
  document.querySelectorAll('ytd-rich-item-renderer ytd-channel-name a, ytd-rich-item-renderer #channel-name a').forEach(a => {
    const ch = parseChannelLink(a);
    if (ch) found.push(ch);
  });
  if (found.length) {
    const deduped = uniqueChannels(found);
    sendBg({ type: 'DETECT_CHANNELS', channels: deduped });
    sendBg({ type: 'UPDATE_FEED_SEEN', channels: deduped });
  }
}

// ---------------------------------------------------------------------------
// CHANNELS PAGE — /feed/channels — bulk detect all subscriptions
// ---------------------------------------------------------------------------
let channelsPageObserver = null;
let channelsPageScrollTimer = null;

function setupChannelsPage() {
  waitFor('ytd-section-list-renderer, ytd-browse[page-subtype="channels"]', () => {
    detectChannelsPage();
    autoScrollChannelsPage();

    // Observe for new channels loading as user/auto scrolls
    const container = document.querySelector('ytd-section-list-renderer #contents')
      || document.querySelector('ytd-browse[page-subtype="channels"]');
    if (container) {
      if (channelsPageObserver) channelsPageObserver.disconnect();
      channelsPageObserver = new MutationObserver(() => detectChannelsPage());
      channelsPageObserver.observe(container, { childList: true, subtree: true });
    }
  });
}

function detectChannelsPage() {
  const found = [];
  // Iterate over each channel renderer once (not individual links)
  document.querySelectorAll('ytd-channel-renderer, ytd-grid-channel-renderer').forEach(renderer => {
    // Get the primary channel link (the one with the channel name text)
    const link = renderer.querySelector('a#main-link[href*="/@"], a#main-link[href*="/channel/"]')
      || renderer.querySelector('#channel-info a[href*="/@"], #channel-info a[href*="/channel/"]')
      || renderer.querySelector('a[href*="/@"], a[href*="/channel/"]');
    if (!link) return;

    const href = link.href || '';
    const idM = href.match(/\/channel\/(UC[\w-]+)/);
    const hM  = href.match(/\/@([\w.-]+)/);

    // Get channel name from the dedicated title element, not link textContent
    const nameEl = renderer.querySelector('#channel-name #text, #channel-name yt-formatted-string, yt-formatted-string#text');
    const name = nameEl?.textContent?.trim()
      || renderer.querySelector('#channel-name')?.textContent?.trim()
      || '';
    if (!name) return;

    const img = renderer.querySelector('yt-img-shadow img, img#img');
    found.push({
      yt_channel_id: idM?.[1] || null,
      handle: hM ? '@' + hM[1] : null,
      name,
      thumbnail: img?.src || null
    });
  });
  if (found.length) {
    sendBg({ type: 'DETECT_CHANNELS', channels: uniqueChannels(found) });
  }
}

function autoScrollChannelsPage() {
  // Auto-scroll to load all channels, stop when no new content appears
  let lastCount = 0;
  let stableRounds = 0;

  channelsPageScrollTimer = setInterval(() => {
    const items = document.querySelectorAll(
      'ytd-channel-renderer, ytd-grid-channel-renderer'
    );
    const currentCount = items.length;

    if (currentCount === lastCount) {
      stableRounds++;
      if (stableRounds >= 3) {
        // No new channels for 3 rounds — done
        clearInterval(channelsPageScrollTimer);
        channelsPageScrollTimer = null;
        detectChannelsPage(); // final pass
        return;
      }
    } else {
      stableRounds = 0;
      lastCount = currentCount;
    }

    // Scroll to bottom to trigger YouTube's lazy loading
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, 1000);
}

// ---------------------------------------------------------------------------
// WATCH PAGE — track view + quick tag bar under channel info
// ---------------------------------------------------------------------------
let lastRecordedVideoId = null;

function setupWatchPage() {
  waitFor('ytd-video-owner-renderer, #owner ytd-channel-name a', ownerRoot => {
    const link = ownerRoot.querySelector?.('a[href*="/@"], a[href*="/channel/"]')
      || (ownerRoot.matches?.('a') ? ownerRoot : null);
    if (!link) return;

    const chInfo = parseChannelLink(link);
    if (chInfo) {
      // Only count each unique video once — extract video ID from URL
      const videoId = new URLSearchParams(location.search).get('v');
      if (videoId && videoId !== lastRecordedVideoId) {
        lastRecordedVideoId = videoId;
        sendBg({ type: 'RECORD_WATCH', channel: chInfo, videoId });
      }
      sendBg({ type: 'DETECT_CHANNELS', channels: [chInfo] });
    }
    injectWatchTags(ownerRoot, chInfo);
  });
}

function injectWatchTags(ownerRoot, channelInfo) {
  document.getElementById('yn-watch-tags')?.remove();
  const channel = channelInfo
    ? resolveChannel(
        channelInfo.yt_channel_id ? `/channel/${channelInfo.yt_channel_id}` : `/@${(channelInfo.handle || '').replace('@', '')}`,
        channelInfo.name || ''
      )
    : null;

  const bar = document.createElement('div');
  bar.id = 'yn-watch-tags';
  bar.innerHTML = renderWatchTags(channel);

  // Try to inject into YouTube's action buttons row (next to Share, Ask, etc.)
  const actionsRow = document.querySelector('#actions #top-level-buttons-computed')
    || document.querySelector('#actions ytd-menu-renderer #top-level-buttons-computed')
    || document.querySelector('#actions ytd-menu-renderer');
  if (actionsRow) {
    actionsRow.prepend(bar);
  } else {
    const target = ownerRoot.closest('#owner') || ownerRoot.closest('ytd-video-owner-renderer') || ownerRoot;
    target.after(bar);
  }
  attachWatchTagEvents(bar, channel);
}

function renderWatchTags(channel) {
  const tags = channel
    ? (channel.tagIds || []).map(tid => state.tags.find(t => t.id === tid)).filter(Boolean)
    : [];

  const chipsHtml = tags.length
    ? tags.map(t => `<span class="yn-wt-chip" style="--tc:${t.color}">${esc(t.name)}</span>`).join('')
    : `<span class="yn-wt-none">${channel ? 'no tags' : 'not tracked yet'}</span>`;

  const menuHtml = state.tags.length
    ? state.tags.map(t => {
        const checked = channel && (channel.tagIds || []).includes(t.id);
        return `<label class="yn-wt-item">
          <input type="checkbox" value="${t.id}"${checked ? ' checked' : ''}>
          <span class="yn-wt-swatch" style="background:${t.color}"></span>
          ${esc(t.name)}
        </label>`;
      }).join('')
    : '<span class="yn-wt-empty">Create tags in options first.</span>';

  return `<div class="yn-wt-inner">
    <div class="yn-wt-chips" id="yn-wt-chips">${chipsHtml}</div>
    <div class="yn-wt-edit-wrap">
      <button class="yn-wt-btn" id="yn-wt-toggle">
        <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor"><path d="M200-200h57l391-391-57-57-391 391v57Zm-40 40v-117l529-529 117 117-529 529H160Zm640-594-46-46 46 46Zm-109 63-28-29 57 57-29-28Z"/></svg>
        Tags
      </button>
      <div class="yn-wt-menu hidden" id="yn-wt-menu">
        <div class="yn-wt-menu-items">${menuHtml}</div>
        ${channel ? `<div class="yn-wt-menu-footer"><button class="yn-wt-save" id="yn-wt-save">Save</button></div>` : ''}
      </div>
    </div>
  </div>`;
}

function attachWatchTagEvents(bar, channel) {
  const menu = bar.querySelector('#yn-wt-menu');
  const toggle = bar.querySelector('#yn-wt-toggle');

  function positionMenu() {
    if (!toggle || !menu) return;
    const rect = toggle.getBoundingClientRect();
    menu.style.top  = (rect.bottom + 8) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
  }

  toggle?.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (menu) {
      const willShow = menu.classList.contains('hidden');
      menu.classList.toggle('hidden');
      if (willShow) positionMenu();
    }
  }, true);
  document.addEventListener('click', e => {
    if (!bar.contains(e.target) && !menu?.contains(e.target)) menu?.classList.add('hidden');
  });

  bar.querySelector('#yn-wt-save')?.addEventListener('click', async () => {
    if (!channel) return;
    const checked = [...(menu?.querySelectorAll('input:checked') || [])].map(cb => cb.value);
    await sendBg({ type: 'ASSIGN_TAGS', channelId: channel.id, tagIds: checked });
    channel.tagIds = checked;
    const chips = bar.querySelector('#yn-wt-chips');
    const tags  = checked.map(tid => state.tags.find(t => t.id === tid)).filter(Boolean);
    if (chips) {
      chips.innerHTML = tags.length
        ? tags.map(t => `<span class="yn-wt-chip" style="--tc:${t.color}">${esc(t.name)}</span>`).join('')
        : '<span class="yn-wt-none">no tags</span>';
    }
    menu?.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// SIDEBAR — custom rendered subscription list
// ---------------------------------------------------------------------------
// Instead of reordering YouTube's DOM (which its framework fights),
// we scrape channel data from the original entries, hide them,
// and render our own sorted list.

let sidebarObserver  = null;
let sidebarDebounce  = null;
let sidebarScraped   = []; // [{ name, href, thumbnail, hasNew }]

function setupSidebar() {
  waitFor(
    'ytd-guide-entry-renderer a[href*="/@"], ytd-guide-entry-renderer a[href*="/channel/"]',
    () => {
      const section = findSubsSection();
      if (!section) return;

      // Mark section so CSS can hide original entries
      section.setAttribute('data-yn-sidebar', '');

      expandSidebarSubscriptions(section);

      // Scrape after short delay for expansion to finish
      setTimeout(() => {
        scrapeSidebar(section);
        renderCustomSidebar(section);
        startSidebarObserver(section);
      }, 800);
    }
  );
}

function expandSidebarSubscriptions(section) {
  const expander = section?.querySelector(
    'ytd-guide-collapsible-entry-renderer #expander-item'
  );
  if (expander && !expander.closest('ytd-guide-collapsible-entry-renderer')?.hasAttribute('expanded')) {
    expander.click();
  }
}

function findSubsSection() {
  for (const section of document.querySelectorAll('ytd-guide-section-renderer')) {
    if (section.querySelector('ytd-guide-entry-renderer a[href*="/@"], ytd-guide-entry-renderer a[href*="/channel/"]')) {
      return section;
    }
  }
  return null;
}

const SIDEBAR_BLOCKLIST = new Set([
  'your videos', 'your movies', 'your clips', 'music', 'live',
  'gaming', 'sports', 'learning', 'fashion & beauty', 'news',
  'movies & tv', 'courses', 'podcasts',
]);

function scrapeSidebar(section) {
  if (!section) return;
  const newData = [];
  section.querySelectorAll('ytd-guide-entry-renderer').forEach(entry => {
    const a = entry.querySelector('a[href*="/@"], a[href*="/channel/"]');
    if (!a) return;
    const name = entry.querySelector('#guide-entry-title, yt-formatted-string')?.textContent?.trim() || '';
    if (SIDEBAR_BLOCKLIST.has(name.toLowerCase())) return;
    const href = a.getAttribute('href') || '';
    const img  = entry.querySelector('yt-img-shadow img, img.guide-icon, img');
    const thumbnail = img?.src || '';

    // Detect "new videos" indicator
    const countEl   = entry.querySelector('#count, yt-formatted-string[id="count"]');
    const countText = countEl?.textContent?.trim();
    let hasNew = !!(countText && countText !== '0');
    // Also check for dot/badge indicators
    if (!hasNew) hasNew = !!entry.querySelector(
      '.guide-notification-dot, [class*="notification"], yt-icon-badge'
    );

    if (name && href) newData.push({ name, href, thumbnail, hasNew });
  });

  // Only update if we found channels (avoid clearing on transient empty state)
  if (newData.length) {
    sidebarScraped = newData;

    // Send scraped channels to background for storage
    const channels = newData.map(d => {
      const fullHref = d.href.startsWith('http') ? d.href : 'https://www.youtube.com' + d.href;
      const idM  = fullHref.match(/\/channel\/(UC[\w-]+)/);
      const hM   = fullHref.match(/\/@([\w.-]+)/);
      return {
        yt_channel_id: idM?.[1] || null,
        handle: hM ? '@' + hM[1] : null,
        name: d.name,
        thumbnail: d.thumbnail || null
      };
    }).filter(c => c.name);
    if (channels.length) sendBg({ type: 'DETECT_CHANNELS', channels: uniqueChannels(channels) });
  }
}

function renderCustomSidebar(section) {
  if (!section) return;

  // Inject sort controls if not present
  if (!section.querySelector('#yn-sort-controls')) {
    const mode = state.uiState.sidebarMode;
    const ctrl = document.createElement('div');
    ctrl.id = 'yn-sort-controls';
    ctrl.innerHTML = `
      <button class="yn-sort-btn${mode === 'watched' ? ' active' : ''}" data-mode="watched"
              title="Most watched channels first">▼ Most Watched</button>
      <button class="yn-sort-btn${mode === 'new' ? ' active' : ''}" data-mode="new"
              title="Channels with new videos first">● New First</button>`;
    section.insertBefore(ctrl, section.firstChild);

    ctrl.addEventListener('click', e => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      const newMode = state.uiState.sidebarMode === btn.dataset.mode ? 'default' : btn.dataset.mode;
      state.uiState = { ...state.uiState, sidebarMode: newMode };
      sendBg({ type: 'SET_UI_STATE', patch: { sidebarMode: newMode } });
      ctrl.querySelectorAll('.yn-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === newMode));
      renderSidebarList();
    });
  }

  renderSidebarList();
}

function renderSidebarList() {
  const section = findSubsSection();
  if (!section) return;

  // Get or create list container
  let list = document.getElementById('yn-sidebar-list');
  if (!list) {
    list = document.createElement('div');
    list.id = 'yn-sidebar-list';
    section.appendChild(list);
  }

  // Sort channels
  const mode = state.uiState.sidebarMode;
  let sorted = [...sidebarScraped];
  if (mode === 'new') {
    sorted.sort((a, b) => (b.hasNew ? 1 : 0) - (a.hasNew ? 1 : 0));
  } else if (mode === 'watched') {
    sorted.sort((a, b) => getWatchCountByHref(b.href) - getWatchCountByHref(a.href));
  }

  list.innerHTML = sorted.map(ch => {
    const active = location.pathname === ch.href;
    return `<a class="yn-sb-item${active ? ' active' : ''}${ch.hasNew ? ' has-new' : ''}" href="${esc(ch.href)}" title="${esc(ch.name)}">
      ${ch.thumbnail
        ? `<img class="yn-sb-avatar" src="${esc(ch.thumbnail)}" alt="" loading="lazy">`
        : '<div class="yn-sb-avatar yn-sb-avatar-placeholder"></div>'}
      <span class="yn-sb-name">${esc(ch.name)}</span>
      ${ch.hasNew ? '<span class="yn-sb-dot"></span>' : ''}
    </a>`;
  }).join('');
}

function getWatchCountByHref(href) {
  const fullHref = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
  const idM  = fullHref.match(/\/channel\/(UC[\w-]+)/);
  const hM   = fullHref.match(/\/@([\w.-]+)/);
  const ytId   = idM?.[1];
  const handle = hM ? '@' + hM[1] : null;
  const ch = state.channels.find(c =>
    (ytId   && c.yt_channel_id === ytId) ||
    (handle && c.handle        === handle)
  );
  if (!ch) return 0;
  // Use time-filtered counts if available, otherwise all-time
  if (state.filteredWatchCounts) return state.filteredWatchCounts[ch.id] || 0;
  return state.channelStats[ch.id]?.watch_count || 0;
}

function startSidebarObserver(section) {
  if (sidebarObserver) sidebarObserver.disconnect();
  sidebarObserver = new MutationObserver(mutations => {
    // Ignore mutations from our own elements
    const onlyOurs = mutations.every(m =>
      m.target.closest('#yn-sidebar-list') || m.target.closest('#yn-sort-controls')
    );
    if (onlyOurs) return;

    clearTimeout(sidebarDebounce);
    sidebarDebounce = setTimeout(() => {
      scrapeSidebar(section);
      renderSidebarList();
    }, 1000);
  });
  sidebarObserver.observe(section, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Storage change listener — debounced, avoids feedback loops
// ---------------------------------------------------------------------------
let storageRefreshTimer = null;

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Update local state immediately
    if (changes.tags)         state.tags         = changes.tags.newValue         || [];
    if (changes.channels)     state.channels     = changes.channels.newValue     || [];
    if (changes.channelStats) state.channelStats = changes.channelStats.newValue || {};
    if (changes.uiState)      state.uiState      = { ...state.uiState, ...(changes.uiState.newValue || {}) };

    // Debounce UI refresh to avoid rapid rebuilds
    clearTimeout(storageRefreshTimer);
    storageRefreshTimer = setTimeout(() => {
      if (location.pathname === '/feed/subscriptions') {
        // Only rebuild filter bar if tags changed (new/deleted/renamed)
        if (changes.tags) refreshFilterBar();
        else {
          const bar = document.getElementById('yn-filter-bar');
          if (bar) updateFilterPills(bar);
        }
        hideUnwantedSections();
        applyFeedFilter();
        if (changes.uiState?.newValue?.colCount !== undefined) {
          applyColumnCount(changes.uiState.newValue.colCount);
        }
      }

      if (location.pathname === '/watch' && (changes.tags || changes.channels)) {
        const link = document.querySelector(
          'ytd-video-owner-renderer a[href*="/@"], ytd-video-owner-renderer a[href*="/channel/"]'
        );
        if (link) {
          const chInfo  = parseChannelLink(link);
          const channel = chInfo ? resolveChannel(link.href, chInfo.name) : null;
          const bar     = document.getElementById('yn-watch-tags');
          if (bar) { bar.innerHTML = renderWatchTags(channel); attachWatchTagEvents(bar, channel); }
        }
      }

      // Re-render sidebar list if stats or mode changed
      if (changes.channelStats || changes.uiState) {
        // Sync sidebar sort button active states when mode changes (e.g. from popup)
        const ctrl = document.getElementById('yn-sort-controls');
        if (ctrl) {
          const mode = state.uiState.sidebarMode;
          ctrl.querySelectorAll('.yn-sort-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.mode === mode)
          );
        }
        renderSidebarList();
      }
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// SPA navigation
// ---------------------------------------------------------------------------
document.addEventListener('yt-navigate-finish', () => {
  document.getElementById('yn-watch-tags')?.remove();
  // Stop channels page auto-scroll if navigating away
  if (channelsPageScrollTimer) { clearInterval(channelsPageScrollTimer); channelsPageScrollTimer = null; }
  if (channelsPageObserver) { channelsPageObserver.disconnect(); channelsPageObserver = null; }
  loadState().then(handleRoute);
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function parseChannelLink(el) {
  const href = el?.href || '';
  const name = el?.textContent?.trim() || '';
  if (!href && !name) return null;
  const idM = href.match(/\/channel\/(UC[\w-]+)/);
  const hM  = href.match(/\/@([\w.-]+)/);
  return { yt_channel_id: idM?.[1] || null, handle: hM ? '@' + hM[1] : null, name };
}

function resolveChannel(href, name) {
  const idM = href?.match(/\/channel\/(UC[\w-]+)/);
  const hM  = href?.match(/\/@([\w.-]+)/);
  const ytId   = idM?.[1];
  const handle = hM ? '@' + hM[1] : null;
  return state.channels.find(c =>
    (ytId   && c.yt_channel_id === ytId)  ||
    (handle && c.handle        === handle) ||
    (name   && c.name          === name)
  ) || null;
}

function uniqueChannels(arr) {
  const seen = new Set();
  return arr.filter(c => {
    const key = c.yt_channel_id || c.handle || c.name;
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function waitFor(selector, cb, timeout = 15000) {
  const el = document.querySelector(selector);
  if (el) { cb(el); return; }
  const start = Date.now();
  const mo = new MutationObserver(() => {
    const found = document.querySelector(selector);
    if (found)                          { mo.disconnect(); cb(found); }
    else if (Date.now() - start > timeout) mo.disconnect();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

function sendBg(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(r || null)); } catch { resolve(null); }
  });
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// SUBSCRIBE DETECTION — prompt user to tag newly subscribed channels
// ---------------------------------------------------------------------------
function setupSubscribeDetection() {
  // Don't run if user opted out
  if (state.uiState.disableSubscribePrompt) return;

  document.addEventListener('click', e => {
    if (state.uiState.disableSubscribePrompt) return;

    // YouTube subscribe buttons
    const subBtn = e.target.closest('ytd-subscribe-button-renderer button, tp-yt-paper-button.ytd-subscribe-button-renderer, button.yt-spec-button-shape-next[aria-label*="Subscribe"]');
    if (!subBtn) return;

    // Only trigger for "Subscribe" (not already subscribed / unsubscribe)
    const label = subBtn.getAttribute('aria-label') || subBtn.textContent || '';
    if (label.toLowerCase().includes('unsubscribe') || label.toLowerCase().includes('subscribed')) return;

    // Grab channel info from the current page
    const link = document.querySelector(
      'ytd-video-owner-renderer a[href*="/@"], ytd-video-owner-renderer a[href*="/channel/"], ytd-channel-name a[href*="/@"]'
    );
    if (!link) return;

    const chInfo = parseChannelLink(link);
    if (!chInfo || !chInfo.name) return;

    // Wait a moment for YouTube to process the subscription
    setTimeout(() => {
      sendBg({ type: 'DETECT_CHANNELS', channels: [chInfo] }).then(() => {
        // Reload state to get the newly added channel
        loadState().then(() => {
          const ch = resolveChannel(link.href, chInfo.name);
          if (ch) showSubscribeTagPopup(ch);
        });
      });
    }, 800);
  }, true);
}

function showSubscribeTagPopup(channel) {
  // Remove any existing popup
  document.getElementById('yn-sub-popup')?.remove();

  if (!state.tags.length) return;

  const popup = document.createElement('div');
  popup.id = 'yn-sub-popup';

  const tagsHtml = state.tags.map(t => {
    const checked = (channel.tagIds || []).includes(t.id);
    return `<label class="yn-sub-tag">
      <input type="checkbox" value="${t.id}"${checked ? ' checked' : ''}>
      <span class="yn-sub-swatch" style="background:${t.color}"></span>
      ${esc(t.name)}
    </label>`;
  }).join('');

  popup.innerHTML = `
    <div class="yn-sub-header">
      <span class="yn-sub-title">Tag <strong>${esc(channel.name)}</strong></span>
      <button class="yn-sub-close" id="yn-sub-close">&times;</button>
    </div>
    <div class="yn-sub-tags">${tagsHtml}</div>
    <div class="yn-sub-footer">
      <button class="yn-sub-save" id="yn-sub-save">Save</button>
      <button class="yn-sub-skip" id="yn-sub-skip">Skip</button>
      <label class="yn-sub-opt-out">
        <input type="checkbox" id="yn-sub-disable">
        Don't ask again
      </label>
    </div>
  `;
  document.body.appendChild(popup);

  // Close
  const close = () => popup.remove();
  popup.querySelector('#yn-sub-close').addEventListener('click', close);
  popup.querySelector('#yn-sub-skip').addEventListener('click', close);

  // Save
  popup.querySelector('#yn-sub-save').addEventListener('click', async () => {
    const checked = [...popup.querySelectorAll('.yn-sub-tags input:checked')].map(cb => cb.value);
    if (checked.length) {
      await sendBg({ type: 'ASSIGN_TAGS', channelId: channel.id, tagIds: checked });
    }
    close();
  });

  // Don't ask again
  popup.querySelector('#yn-sub-disable').addEventListener('change', async (e) => {
    if (e.target.checked) {
      state.uiState = { ...state.uiState, disableSubscribePrompt: true };
      await sendBg({ type: 'SET_UI_STATE', patch: { disableSubscribePrompt: true } });
      close();
    }
  });

  // Auto-dismiss after 15 seconds
  setTimeout(() => { if (document.body.contains(popup)) close(); }, 15000);
}

boot();
