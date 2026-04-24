// AI tag suggestion helpers
// Supports OpenAI (including o-series reasoning models) and Anthropic.

'use strict';

const AI_MODELS = {
  openai: [
    { id: 'gpt-5.4',      label: 'GPT-5.4 (frontier, most capable)' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (fast)' },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano (cheapest)' },
    { id: 'gpt-4.1',      label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { id: 'o4-mini',      label: 'o4-mini (fast reasoning)' },
    { id: 'o3',           label: 'o3 (advanced reasoning)' }
  ],
  anthropic: [
    { id: 'claude-opus-4-6',          label: 'Claude Opus 4.6 (most powerful)' },
    { id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6 (balanced)' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast)' }
  ]
};

const DEFAULT_MODEL = { openai: 'gpt-5.4-mini', anthropic: 'claude-haiku-4-5-20251001' };

/**
 * @param {object} channel      - { name, handle, description }
 * @param {Array}  allTags      - [{ id, name }]
 * @param {Array}  allChannels  - [{ name, tagIds }]
 * @param {object} cfg          - { provider, model, apiKey }
 * @returns {Promise<string[]>} matched tag names
 */
async function suggestTags(channel, allTags, allChannels, cfg) {
  if (!cfg.apiKey) throw new Error('AI API key not set');
  if (!allTags.length) throw new Error('No tags exist yet');

  const model = cfg.model || DEFAULT_MODEL[cfg.provider] || 'gpt-4.1-mini';
  const prompt = buildPrompt(channel, allTags, allChannels);

  let text;
  if (cfg.provider === 'openai') {
    text = await callOpenAI(prompt, cfg.apiKey, model);
  } else if (cfg.provider === 'anthropic') {
    text = await callAnthropic(prompt, cfg.apiKey, model);
  } else {
    throw new Error('Unknown AI provider: ' + cfg.provider);
  }

  return parseResponse(text, allTags);
}

function buildPrompt(channel, allTags, allChannels) {
  const tagLines = allTags.map(tag => {
    const examples = allChannels
      .filter(c => c.tagIds && c.tagIds.includes(tag.id))
      .slice(0, 5)
      .map(c => c.name);
    const exStr = examples.length ? ` (e.g. ${examples.join(', ')})` : '';
    return `- ${tag.name}${exStr}`;
  });

  return `You are helping categorize YouTube channels into user-defined tags.

Available tags:
${tagLines.join('\n')}

Channel to categorize:
- Name: ${channel.name}${channel.handle ? `\n- Handle: ${channel.handle}` : ''}${channel.description ? `\n- Description: ${channel.description.slice(0, 800)}` : ''}

Which of the available tags best match this channel?
Reply with ONLY the matching tag names, one per line. If none match, reply with the word: none
Do NOT invent new tags. Only use names from the list above.`;
}

async function callOpenAI(prompt, apiKey, model) {
  // o-series and gpt-5+ models use max_completion_tokens instead of max_tokens
  const useCompletionTokens = /^o\d/.test(model) || /^gpt-5/.test(model);
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }]
  };
  if (useCompletionTokens) {
    body.max_completion_tokens = 300;
  } else {
    body.max_tokens = 200;
    body.temperature = 0.2;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `OpenAI ${res.status}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function callAnthropic(prompt, apiKey, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `Anthropic ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

function parseResponse(text, allTags) {
  if (text.toLowerCase().trim() === 'none') return [];
  const validNames = new Set(allTags.map(t => t.name.toLowerCase()));
  return text
    .split('\n')
    .map(l => l.replace(/^[-*•\d.]\s*/, '').replace(/^"(.*)"$/, '$1').trim())
    .filter(l => l && validNames.has(l.toLowerCase()))
    .map(l => allTags.find(t => t.name.toLowerCase() === l.toLowerCase())?.name)
    .filter(Boolean);
}
