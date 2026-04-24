// YouTube Tags — background service worker

'use strict';

importScripts('lib/supabase.js', 'lib/ai.js');

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  dispatch(msg).then(respond).catch(err => respond({ error: err.message }));
  return true;
});

async function dispatch(msg) {
  switch (msg.type) {
    case 'CONFIGURE_SUPABASE':    return configureSupabase(msg.url, msg.anonKey);
    case 'CONFIGURE_AI':          return configureAI(msg.provider, msg.model, msg.apiKey);
    case 'SYNC':                  return syncAll();
    case 'GET_ALL_DATA':          return getAllData();

    case 'CREATE_TAG':            return createTag(msg.name, msg.color);
    case 'UPDATE_TAG':            return updateTag(msg.id, msg.name, msg.color);
    case 'DELETE_TAG':            return deleteTag(msg.id);

    case 'ASSIGN_TAGS':           return assignTags(msg.channelId, msg.tagIds);
    case 'MARK_SORTED':           return markSorted(msg.channelId);
    case 'DELETE_CHANNEL':        return deleteChannel(msg.channelId);

    case 'DETECT_CHANNELS':       return detectChannels(msg.channels);
    case 'RECORD_WATCH':          return recordWatch(msg.channel, msg.videoId);
    case 'UPDATE_FEED_SEEN':      return updateFeedSeen(msg.channels);

    case 'GET_WATCH_COUNTS':      return getWatchCounts(msg.periodDays);
    case 'RESET_WATCH_STATS':     return resetWatchStats();
    case 'SUGGEST_TAGS':          return suggestForChannel(msg.channelId);
    case 'SUGGEST_TAGS_BATCH':    return suggestBatch();

    case 'SET_UI_STATE':          return setUIState(msg.patch);
    case 'OPEN_OPTIONS':
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
      return { ok: true };

    default: throw new Error('Unknown message: ' + msg.type);
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
async function withDB(fn) {
  try {
    const db = await getSupabase();
    return await fn(db);
  } catch (err) {
    if (!err.message.includes('not configured')) {
      console.warn('[YT-Nav] Supabase:', err.message);
    }
    return null;
  }
}

async function configureSupabase(url, anonKey) {
  await chromeSet({ supabaseUrl: url, supabaseAnonKey: anonKey });
  resetSupabaseClient();
  await withDB(db => db.userId); // triggers init
  await syncAll();
  return { ok: true };
}

async function syncAll() {
  return withDB(async db => {
    const [tags, rawChannels, channelTagRows, statsRows] = await Promise.all([
      db.select('tags', { order: 'created_at.asc' }),
      db.select('channels', { order: 'created_at.asc' }),
      db.select('channel_tags', { select: 'channel_id,tag_id' }),
      db.select('channel_stats')
    ]);

    const tagsByChannel = {};
    for (const row of (channelTagRows || [])) {
      (tagsByChannel[row.channel_id] = tagsByChannel[row.channel_id] || []).push(row.tag_id);
    }

    const channels = (rawChannels || []).map(c => ({
      ...c, tagIds: tagsByChannel[c.id] || []
    }));

    const channelStats = {};
    for (const s of (statsRows || [])) channelStats[s.channel_id] = s;

    await chromeSet({ tags: tags || [], channels, channelStats });
    return { ok: true };
  });
}

async function getAllData() {
  return chromeGet(['tags', 'channels', 'channelStats', 'aiProvider', 'aiModel', 'supabaseUrl', 'uiState', 'watchPeriodDays']);
}


// ---------------------------------------------------------------------------
// Tag CRUD
// ---------------------------------------------------------------------------
async function createTag(name, color) {
  const { tags = [] } = await chromeGet(['tags']);
  const tempId = 'tmp_' + Date.now();
  await chromeSet({ tags: [...tags, { id: tempId, name, color, created_at: new Date().toISOString() }] });
  await withDB(async db => {
    await db.insert('tags', { name, color, user_id: db.userId });
    await syncAll();
  });
  return { ok: true };
}

async function updateTag(id, name, color) {
  const { tags = [] } = await chromeGet(['tags']);
  await chromeSet({ tags: tags.map(t => t.id === id ? { ...t, name, color } : t) });
  await withDB(db => db.update('tags', { id }, { name, color }));
  return { ok: true };
}

async function deleteTag(id) {
  const { tags = [], channels = [] } = await chromeGet(['tags', 'channels']);
  await chromeSet({
    tags: tags.filter(t => t.id !== id),
    channels: channels.map(c => ({ ...c, tagIds: (c.tagIds || []).filter(tid => tid !== id) }))
  });
  await withDB(db => db.delete('tags', { id }));
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
      // Enrich existing channel without touching sorted / tagIds
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
        id:            'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2),
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

  if (added) {
    await withDB(async db => {
      const newRows = merged
        .filter(ch => ch.id?.startsWith('tmp_'))
        .map(ch => ({
          user_id:       db.userId,
          yt_channel_id: ch.yt_channel_id,
          name:          ch.name,
          handle:        ch.handle,
          thumbnail:     ch.thumbnail,
          description:   ch.description,
          sorted:        false
        }));
      if (newRows.length) await db.upsert('channels', newRows);
      await syncAll();
    });
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
  await withDB(async db => {
    await db.delete('channel_tags', { channel_id: channelId });
    if (tagIds.length) {
      await db.insert('channel_tags', tagIds.map(tag_id => ({ channel_id: channelId, tag_id })));
    }
    await db.update('channels', { id: channelId }, { sorted: tagIds.length > 0 });
  });
  return { ok: true };
}

async function markSorted(channelId) {
  const { channels = [] } = await chromeGet(['channels']);
  await chromeSet({ channels: channels.map(c => c.id === channelId ? { ...c, sorted: true } : c) });
  await withDB(db => db.update('channels', { id: channelId }, { sorted: true }));
  return { ok: true };
}

async function deleteChannel(channelId) {
  const { channels = [] } = await chromeGet(['channels']);
  await chromeSet({ channels: channels.filter(c => c.id !== channelId) });
  await withDB(db => db.delete('channels', { id: channelId }));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Watch tracking
// ---------------------------------------------------------------------------
async function recordWatch(channel, videoId) {
  const { channels = [], channelStats = {}, watchLog = [] } = await chromeGet(['channels', 'channelStats', 'watchLog']);

  // Deduplicate: skip if this video was already counted
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

  // Append to watch log (keep last 5000 entries)
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

  await withDB(async db => {
    const existing = await db.select('channel_stats', { channel_id: `eq.${ch.id}` });
    if (existing?.length) {
      await db.update('channel_stats', { channel_id: ch.id }, {
        watch_count: (existing[0].watch_count || 0) + 1, last_watched_at: now
      });
    } else {
      await db.insert('channel_stats', { channel_id: ch.id, user_id: db.userId, watch_count: 1, last_watched_at: now });
    }
  });

  return { ok: true };
}

async function getWatchCounts(periodDays) {
  const { channelStats = {}, watchLog = [] } = await chromeGet(['channelStats', 'watchLog']);
  if (!periodDays || periodDays === 0) {
    // All time — use channelStats directly
    return { counts: channelStats };
  }
  // Time-filtered counts from watchLog
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
  await withDB(async db => {
    // Truncate channel_stats table for this user
    try { await db.delete('channel_stats', {}); } catch (_) {}
  });
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

// ---------------------------------------------------------------------------
// Periodic Supabase sync
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'sync') syncAll(); });
chrome.alarms.create('sync', { periodInMinutes: 5 });
