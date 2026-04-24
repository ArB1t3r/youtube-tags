// YouTube Tags — background service worker

'use strict';

importScripts('lib/ai.js');

// ---------------------------------------------------------------------------
// Chrome storage helpers
// ---------------------------------------------------------------------------
function chromeGet(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}
function chromeSet(data) {
  return new Promise(r => chrome.storage.local.set(data, r));
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  dispatch(msg).then(respond).catch(err => respond({ error: err.message }));
  return true;
});

async function dispatch(msg) {
  switch (msg.type) {
    case 'CONFIGURE_AI':          return configureAI(msg.provider, msg.model, msg.apiKey);
    case 'GET_ALL_DATA':          return getAllData();

    case 'CREATE_TAG':            return createTag(msg.name, msg.color);
    case 'UPDATE_TAG':            return updateTag(msg.id, msg.name, msg.color);
    case 'DELETE_TAG':            return deleteTag(msg.id);

    case 'ASSIGN_TAGS':           return assignTags(msg.channelId, msg.tagIds);
    case 'MARK_SORTED':           return markSorted(msg.channelId);
    case 'DELETE_CHANNEL':        return deleteChannel(msg.channelId);

    case 'DETECT_CHANNELS':       return detectChannels(msg.channels);
    case 'RESET_CHANNELS':        return resetChannels();
    case 'RECORD_WATCH':          return recordWatch(msg.channel, msg.videoId);
    case 'UPDATE_FEED_SEEN':      return updateFeedSeen(msg.channels);

    case 'GET_WATCH_COUNTS':      return getWatchCounts(msg.periodDays);
    case 'RESET_WATCH_STATS':     return resetWatchStats();
    case 'SUGGEST_TAGS':          return suggestForChannel(msg.channelId);
    case 'SUGGEST_TAGS_BATCH':    return suggestBatch();

    case 'SET_UI_STATE':          return setUIState(msg.patch);
    case 'EXPORT_DATA':           return exportData();
    case 'IMPORT_DATA':           return importData(msg.data);
    case 'OPEN_OPTIONS':
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
      return { ok: true };

    default: throw new Error('Unknown message: ' + msg.type);
  }
}

async function getAllData() {
  return chromeGet(['tags', 'channels', 'channelStats', 'aiProvider', 'aiModel', 'uiState', 'watchPeriodDays']);
}

// ---------------------------------------------------------------------------
// Tag CRUD
// ---------------------------------------------------------------------------
async function createTag(name, color) {
  const { tags = [] } = await chromeGet(['tags']);
  const id = 'tag_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  await chromeSet({ tags: [...tags, { id, name, color, created_at: new Date().toISOString() }] });
  return { ok: true };
}

async function updateTag(id, name, color) {
  const { tags = [] } = await chromeGet(['tags']);
  await chromeSet({ tags: tags.map(t => t.id === id ? { ...t, name, color } : t) });
  return { ok: true };
}

async function deleteTag(id) {
  const { tags = [], channels = [] } = await chromeGet(['tags', 'channels']);
  await chromeSet({
    tags: tags.filter(t => t.id !== id),
    channels: channels.map(c => ({ ...c, tagIds: (c.tagIds || []).filter(tid => tid !== id) }))
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Channel operations
// ---------------------------------------------------------------------------
const SYSTEM_CHANNELS = new Set([
  'your videos', 'your movies', 'your clips', 'music', 'live',
  'gaming', 'sports', 'learning', 'fashion & beauty', 'news',
  'movies & tv', 'courses', 'podcasts',
]);

async function detectChannels(incoming) {
  if (!incoming?.length) return { ok: true, added: 0, enriched: 0 };
  incoming = incoming.filter(c => !SYSTEM_CHANNELS.has((c.name || '').toLowerCase()));
  if (!incoming.length) return { ok: true, added: 0, enriched: 0 };
  const { channels = [] } = await chromeGet(['channels']);

  const now = new Date().toISOString();
  const merged = [...channels];
  let added = 0, enriched = 0;

  for (const c of incoming) {
    const idx = merged.findIndex(existing =>
      (c.yt_channel_id && existing.yt_channel_id === c.yt_channel_id) ||
      (c.handle && existing.handle === c.handle) ||
      existing.name === c.name
    );

    if (idx >= 0) {
      const prev = merged[idx];
      const updated = {
        ...prev,
        yt_channel_id: c.yt_channel_id || prev.yt_channel_id,
        handle:        c.handle         || prev.handle,
        thumbnail:     c.thumbnail      || prev.thumbnail,
        description:   c.description    || prev.description
      };
      if (JSON.stringify(updated) !== JSON.stringify(prev)) {
        merged[idx] = updated;
        enriched++;
      }
    } else {
      merged.push({
        id:            'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        yt_channel_id: c.yt_channel_id || null,
        name:          c.name,
        handle:        c.handle || null,
        thumbnail:     c.thumbnail || null,
        description:   c.description || null,
        sorted:        false,
        tagIds:        [],
        created_at:    now
      });
      added++;
    }
  }

  if (added || enriched) {
    await chromeSet({ channels: merged });
  }

  return { ok: true, added, enriched };
}

async function assignTags(channelId, tagIds) {
  const { channels = [] } = await chromeGet(['channels']);
  await chromeSet({
    channels: channels.map(c =>
      c.id === channelId ? { ...c, tagIds, sorted: tagIds.length > 0 } : c
    )
  });
  return { ok: true };
}

async function markSorted(channelId) {
  const { channels = [] } = await chromeGet(['channels']);
  await chromeSet({ channels: channels.map(c => c.id === channelId ? { ...c, sorted: true } : c) });
  return { ok: true };
}

async function deleteChannel(channelId) {
  const { channels = [] } = await chromeGet(['channels']);
  await chromeSet({ channels: channels.filter(c => c.id !== channelId) });
  return { ok: true };
}

async function resetChannels() {
  await chromeSet({ channels: [], channelStats: {}, watchLog: [] });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Watch tracking
// ---------------------------------------------------------------------------
async function recordWatch(channel, videoId) {
  const { channels = [], channelStats = {}, watchLog = [] } = await chromeGet(['channels', 'channelStats', 'watchLog']);

  if (videoId && watchLog.some(e => e.videoId === videoId)) return { ok: true, duplicate: true };

  let ch = channels.find(c =>
    (c.yt_channel_id && c.yt_channel_id === channel.yt_channel_id) ||
    (c.handle && channel.handle && c.handle === channel.handle) ||
    c.name === channel.name
  );

  if (!ch) {
    await detectChannels([channel]);
    const { channels: updated } = await chromeGet(['channels']);
    ch = updated.find(c => c.name === channel.name);
  }
  if (!ch) return { ok: false };

  const now = new Date().toISOString();
  const cur = channelStats[ch.id] || { watch_count: 0 };

  const newLog = videoId
    ? [...watchLog, { videoId, channelId: ch.id, at: now }].slice(-5000)
    : watchLog;

  await chromeSet({
    watchLog: newLog,
    channelStats: {
      ...channelStats,
      [ch.id]: { ...cur, channel_id: ch.id, watch_count: (cur.watch_count || 0) + 1, last_watched_at: now }
    }
  });

  return { ok: true };
}

async function getWatchCounts(periodDays) {
  const { channelStats = {}, watchLog = [] } = await chromeGet(['channelStats', 'watchLog']);
  if (!periodDays || periodDays === 0) {
    return { counts: channelStats };
  }
  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();
  const counts = {};
  for (const entry of watchLog) {
    if (entry.at >= cutoff) {
      counts[entry.channelId] = (counts[entry.channelId] || 0) + 1;
    }
  }
  return { counts };
}

async function resetWatchStats() {
  await chromeSet({ channelStats: {}, watchLog: [] });
  return { ok: true };
}

async function updateFeedSeen(channels) {
  if (!channels?.length) return { ok: true };
  const { channels: stored = [], channelStats = {} } = await chromeGet(['channels', 'channelStats']);
  const now = new Date().toISOString();
  const updatedStats = { ...channelStats };

  for (const c of channels) {
    const match = stored.find(s =>
      (s.yt_channel_id && s.yt_channel_id === c.yt_channel_id) || s.name === c.name
    );
    if (match) {
      updatedStats[match.id] = { ...(updatedStats[match.id] || {}), last_seen_in_feed_at: now };
    }
  }
  await chromeSet({ channelStats: updatedStats });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// AI suggestions
// ---------------------------------------------------------------------------
async function suggestForChannel(channelId) {
  const { channels = [], tags = [], aiProvider, aiModel, aiApiKey } = await chromeGet(
    ['channels', 'tags', 'aiProvider', 'aiModel', 'aiApiKey']
  );
  if (!aiApiKey) throw new Error('AI API key not configured. Go to options → Settings.');
  if (!tags.length) throw new Error('Create at least one tag first.');

  const channel = channels.find(c => c.id === channelId);
  if (!channel) throw new Error('Channel not found.');

  const names = await suggestTags(channel, tags, channels, {
    provider: aiProvider || 'openai',
    model: aiModel,
    apiKey: aiApiKey
  });
  return { suggestions: names };
}

async function suggestBatch() {
  const { channels = [], tags = [], aiProvider, aiModel, aiApiKey } = await chromeGet(
    ['channels', 'tags', 'aiProvider', 'aiModel', 'aiApiKey']
  );
  if (!aiApiKey) throw new Error('AI API key not configured.');
  if (!tags.length) throw new Error('Create at least one tag first.');

  const unsorted = channels.filter(c => !c.sorted);
  const results = {};

  for (const channel of unsorted) {
    try {
      const names = await suggestTags(channel, tags, channels, {
        provider: aiProvider || 'openai',
        model: aiModel,
        apiKey: aiApiKey
      });
      results[channel.id] = { suggestions: names, error: null };
    } catch (err) {
      results[channel.id] = { suggestions: [], error: err.message };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { results };
}

async function configureAI(provider, model, apiKey) {
  await chromeSet({ aiProvider: provider, aiModel: model, aiApiKey: apiKey });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------
async function exportData() {
  const data = await chromeGet(['tags', 'channels', 'channelStats', 'watchLog', 'uiState', 'aiProvider', 'aiModel', 'watchPeriodDays']);
  return { ok: true, data };
}

async function importData(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid data');
  const allowed = ['tags', 'channels', 'channelStats', 'watchLog', 'uiState', 'aiProvider', 'aiModel', 'watchPeriodDays'];
  const toSet = {};
  for (const key of allowed) {
    if (data[key] !== undefined) toSet[key] = data[key];
  }
  await chromeSet(toSet);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------
async function setUIState(patch) {
  const { uiState = {} } = await chromeGet(['uiState']);
  await chromeSet({ uiState: { ...uiState, ...patch } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Install / update events
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
