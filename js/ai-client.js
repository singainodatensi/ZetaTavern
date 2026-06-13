/**
 * ai-client.js - ZetaTavern AI Integration
 * Constructs character-aware dynamic prompts and manages Gemini API calls with retries & timeouts.
 */

import { getState, updateState } from './state.js'; // ★ updateState のインポートを追加
import { getCharacter, getLore, getLoreByNameAndFranchise, getWorldLores, saveLore, saveStory, getCharacters } from './db.js';
import { getStoryScopedCharacters } from './story-characters.js';

async function getCharactersList() {
  try {
    return await getCharacters();
  } catch (e) {
    return [];
  }
}

function normalizeLoreKey(value) {
  return (value || '').trim().toLowerCase();
}

function isCharacterInFranchise(character, franchise) {
  const normalizedFranchise = normalizeLoreKey(franchise);
  if (!normalizedFranchise) return true;

  const category = normalizeLoreKey(character?.category);
  const tags = Array.isArray(character?.tags) ? character.tags.map(normalizeLoreKey) : [];
  if (category || tags.length > 0) {
    return category === normalizedFranchise || tags.includes(normalizedFranchise);
  }

  // If the character has no franchise metadata, treat an exact name hit as a conflict.
  return true;
}

function hasCharacterLoreConflict(lore, characters, franchise) {
  const loreName = normalizeLoreKey(lore?.name);
  if (!loreName || !Array.isArray(characters)) return false;

  return characters.some(character =>
    normalizeLoreKey(character?.name) === loreName &&
    isCharacterInFranchise(character, franchise)
  );
}

const DEFAULT_SEARCH_MODEL_NAME = 'gemini-2.5-flash-lite';
const MAX_SEARCH_WEB_CALLS_PER_TURN = 1;
const webSearchCooldownUntilByProvider = {
  google: 0,
  tavily: 0
};
const WEB_SEARCH_PROVIDER_OPTIONS = new Set(['auto', 'tavily', 'google', 'duckduckgo', 'off']);

function selectSearchCapableModel(modelName) {
  const requested = (modelName || '').trim();
  if (!requested) return DEFAULT_SEARCH_MODEL_NAME;

  const normalized = requested.toLowerCase();
  if (normalized.includes('gemini')) {
    return requested;
  }

  return DEFAULT_SEARCH_MODEL_NAME;
}

function resolveSearchModelName(appState) {
  const preferred = (appState?.searchModelName || '').trim();
  if (preferred) return selectSearchCapableModel(preferred);
  return selectSearchCapableModel(appState?.modelName || DEFAULT_SEARCH_MODEL_NAME);
}

function normalizeWebSearchProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return WEB_SEARCH_PROVIDER_OPTIONS.has(normalized) ? normalized : 'auto';
}

function getWebSearchProviderLabel(value) {
  const normalized = normalizeWebSearchProvider(value);
  if (normalized === 'tavily') return 'Tavily';
  if (normalized === 'google') return 'Google';
  if (normalized === 'duckduckgo') return 'DuckDuckGo';
  if (normalized === 'off') return 'OFF';
  return 'Auto';
}

function getWebSearchCooldownRemainingMs(provider) {
  const until = Number(webSearchCooldownUntilByProvider?.[provider] || 0);
  return Math.max(0, until - Date.now());
}

function setWebSearchCooldown(provider, durationMs = 5 * 60 * 1000) {
  if (!provider || !Number.isFinite(durationMs) || durationMs <= 0) return;
  webSearchCooldownUntilByProvider[provider] = Date.now() + durationMs;
}

function parseJsonObjectFromModelText(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  const jsonMatch = source.match(/\`\`\`json\s*(\{[\s\S]*?\})\s*\`\`\`/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (_) {
      return null;
    }
  }
  try {
    return JSON.parse(source);
  } catch (_) {
    return null;
  }
}

function ensureSearchMemory(story) {
  if (!story || !Array.isArray(story.search_memory)) {
    if (story) story.search_memory = [];
    return story?.search_memory || [];
  }
  return story.search_memory;
}

function normalizeSearchTopicKey(value) {
  return normalizeLoreEntryName(String(value || '').trim()).toLowerCase();
}

function buildSearchMemoryIdentity(entry = {}) {
  return JSON.stringify({
    topicKey: normalizeSearchTopicKey(entry.topicKey || ''),
    query: normalizeSearchText(entry.query || ''),
    franchise: normalizeLoreKey(entry.franchise || '')
  });
}

function findSearchMemoryMatch(story, { topicKey = '', query = '', franchise = '' } = {}) {
  const normalizedTopicKey = normalizeSearchTopicKey(topicKey);
  const normalizedQuery = normalizeSearchText(query);
  const normalizedFranchise = normalizeLoreKey(franchise);
  const memory = ensureSearchMemory(story);

  return memory.find(entry => {
    const sameFranchise = !normalizedFranchise || normalizeLoreKey(entry.franchise || '') === normalizedFranchise;
    if (!sameFranchise) return false;
    if (normalizedTopicKey && normalizeSearchTopicKey(entry.topicKey || '') === normalizedTopicKey) return true;
    if (normalizedQuery && normalizeSearchText(entry.query || '') === normalizedQuery) return true;
    return false;
  }) || null;
}

function upsertSearchMemoryEntry(story, entry = {}) {
  const memory = ensureSearchMemory(story);
  const normalizedEntry = {
    id: entry.id || crypto.randomUUID(),
    topicKey: normalizeLoreEntryName(entry.topicKey || entry.query || ''),
    query: String(entry.query || '').trim(),
    purpose: String(entry.purpose || '').trim(),
    franchise: String(entry.franchise || '').trim(),
    provider: String(entry.provider || '').trim(),
    sceneGoal: String(entry.sceneGoal || '').trim(),
    summary: String(entry.summary || entry.text || '').trim().slice(0, 1400),
    source: String(entry.source || 'search_web').trim() || 'search_web',
    createdAt: Number(entry.createdAt || Date.now()),
    updatedAt: Date.now()
  };

  const existingIndex = memory.findIndex(item =>
    buildSearchMemoryIdentity(item) === buildSearchMemoryIdentity(normalizedEntry)
  );

  if (existingIndex >= 0) {
    memory[existingIndex] = {
      ...memory[existingIndex],
      ...normalizedEntry,
      id: memory[existingIndex].id || normalizedEntry.id,
      createdAt: memory[existingIndex].createdAt || normalizedEntry.createdAt
    };
  } else {
    memory.unshift(normalizedEntry);
  }

  story.search_memory = memory
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 12);
  return story.search_memory[0];
}

function buildSearchMemoryInstructionBlock(story) {
  const memory = ensureSearchMemory(story);
  if (memory.length === 0) return '';

  let block = `【検索メモ (Search Memory)】\n`;
  block += `- 既に確認済みの外部情報。まずここを参照し、同じ主題をむやみに再検索しないこと。\n`;
  for (const entry of memory.slice(0, 5)) {
    block += `・${entry.topicKey || entry.query}`;
    if (entry.franchise) block += ` [${entry.franchise}]`;
    if (entry.sceneGoal) block += ` <用途: ${entry.sceneGoal}>`;
    block += `\n`;
    if (entry.summary) {
      block += `  ${entry.summary}\n`;
    }
  }
  block += `\n`;
  return block;
}

function buildCompactCharacterHint(character) {
  const cues = [];
  if (character?.personality) cues.push(character.personality.trim().replace(/\s+/g, ' ').slice(0, 80));
  if (character?.description && cues.length === 0) cues.push(character.description.trim().replace(/\s+/g, ' ').slice(0, 60));
  return cues.filter(Boolean).join(' / ');
}

function shouldSendFullCharacterProfiles(story) {
  const completedModelTurns = Array.isArray(story?.messages)
    ? story.messages.filter(message => message?.role === 'model').length
    : 0;
  return completedModelTurns === 0;
}

function chunkMessagesByUserTurn(messages = []) {
  const chunks = [];
  let currentChunk = [];

  for (const message of messages) {
    if (message?.role === 'user' && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
    currentChunk.push(message);
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function selectPromptMessages(messages = [], turnLimit = 0) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { selectedMessages: [], omittedTurns: 0 };
  }

  const normalizedTurnLimit = Number.isFinite(Number(turnLimit)) ? Number(turnLimit) : 0;
  if (normalizedTurnLimit <= 0) {
    return { selectedMessages: [...messages], omittedTurns: 0 };
  }

  const chunks = chunkMessagesByUserTurn(messages);
  if (chunks.length <= normalizedTurnLimit) {
    return { selectedMessages: [...messages], omittedTurns: 0 };
  }

  const keptChunks = chunks.slice(-normalizedTurnLimit);
  return {
    selectedMessages: keptChunks.flat(),
    omittedTurns: chunks.length - keptChunks.length
  };
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNonEmpty(values = []) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function tokenizeSearchQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];

  const parts = raw
    .split(/[\s,、。・/\\|!！?？"'`]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);

  return uniqueNonEmpty([raw, ...parts]);
}

function scoreSearchableText(text, tokens) {
  const haystack = normalizeSearchText(text);
  if (!haystack || !Array.isArray(tokens) || tokens.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    const needle = normalizeSearchText(token);
    if (!needle) continue;
    if (haystack === needle) {
      score += 120;
    } else if (haystack.startsWith(needle)) {
      score += 60;
    } else if (haystack.includes(needle)) {
      score += 24;
    }
  }
  return score;
}

const PROACTIVE_REFERENCE_STOPWORDS = new Set([
  '主人公', '世界', '物語', '会話', '状況', '設定', '関係', '人物', 'キャラクター',
  '場所', '情報', '内容', '話', '今回', '次', '今', 'さっき', '感じ', 'ところ',
  '相手', '自分', '普通', '一般', '説明', '詳細', '名前', '存在', '仲間',
  '講義', '授業', '自宅', '家', '部屋', '学校', '先生', '好き', '恋愛', '放課後',
  '時間', '今日', '明日', '昨日', '仕事', '生活', '会場', '現場'
]);

const KNOWN_WORLD_SEARCH_TERMS = new Set([
  'ギルド', '王選', '白鯨', '魔女教', '騎士団', '商会', '陣営', '精霊', '加護',
  '屋敷', '学園', '学院', '教会', '王都', '王国', '依頼', '討伐', '護衛'
]);

function normalizeLoreType(type) {
  const allowed = new Set(['character', 'location', 'organization', 'term', 'event', 'item']);
  return allowed.has(type) ? type : 'term';
}

function stripLoreCitations(text) {
  return (text || '')
    .replace(/\s*\[(?:\d+\s*(?:,\s*\d+\s*)*)\]/g, '')
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\s*[,，]\s*[^\]]+\]/g, '')
    .replace(/出典[:：][^\n。]*/g, '')
    .replace(/参考[:：][^\n。]*/g, '');
}

function normalizeLoreWritingTone(text) {
  let value = (text || '').trim();
  if (!value) return '';

  value = value
    .replace(/この[^\n。]*について(?:は|を)?/g, '')
    .replace(/ユーザーに対しての説明[^。\n]*。?/g, '')
    .replace(/検索結果によると/g, '')
    .replace(/原作では/g, '')
    .replace(/とされています/g, 'とされる')
    .replace(/といわれています/g, 'といわれる')
    .replace(/となっています/g, 'となっている')
    .replace(/されています/g, 'されている')
    .replace(/していました/g, 'していた')
    .replace(/していきます/g, 'していく')
    .replace(/できます/g, 'できる')
    .replace(/挙げられます/g, '挙げられる')
    .replace(/見られます/g, '見られる')
    .replace(/存在します/g, '存在する')
    .replace(/該当します/g, '該当する')
    .replace(/意味します/g, '意味する')
    .replace(/示します/g, '示す')
    .replace(/指します/g, '指す')
    .replace(/表します/g, '表す')
    .replace(/担います/g, '担う')
    .replace(/果たします/g, '果たす')
    .replace(/持ちます/g, '持つ')
    .replace(/使います/g, '使う')
    .replace(/できます。/g, 'できる。')
    .replace(/です。/g, 'である。')
    .replace(/です、/g, 'であり、')
    .replace(/です$/g, 'である');

  value = value
    .replace(/\s+/g, ' ')
    .replace(/([。！？])\1+/g, '$1')
    .replace(/^[、。\s]+|[、。\s]+$/g, '')
    .trim();

  return value;
}

function sanitizeLoreText(text) {
  const stripped = stripLoreCitations(text);
  return normalizeLoreWritingTone(stripped);
}

function hasJapaneseText(value) {
  return /[\u3040-\u30ff\u4e00-\u9faf々ー]/.test(value || '');
}

function isMostlyJapaneseLabel(value) {
  return /^[\u3040-\u30ff\u4e00-\u9faf々ー・\s]+$/.test((value || '').trim());
}

export function normalizeLoreEntryName(name) {
  const raw = (name || '').trim();
  if (!raw) return '';

  const candidates = new Set([raw]);
  const parenMatches = raw.matchAll(/[\(（]([^\)）]+)[\)）]/g);
  for (const match of parenMatches) {
    candidates.add((match[1] || '').trim());
  }

  raw.split(/[\/|｜:,：]/).forEach(part => candidates.add((part || '').trim()));
  const withoutParens = raw.replace(/\s*[\(（][^\)）]+[\)）]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutParens) candidates.add(withoutParens);

  const cleaned = [...candidates]
    .map(value => value.replace(/^[\s"'「『・]+|[\s"'」』・]+$/g, '').trim())
    .map(value => value.replace(/という(?:特例|制度|存在|立場|仕組み|概念).*$/u, '').trim())
    .map(value => value.replace(/の(?:特例|制度|存在|立場|仕組み|概念)$/u, '').trim())
    .filter(Boolean);

  const japaneseOnly = cleaned.filter(isMostlyJapaneseLabel);
  if (japaneseOnly.length > 0) {
    return japaneseOnly.sort((a, b) => a.length - b.length)[0];
  }

  const japaneseMixed = cleaned.filter(hasJapaneseText);
  if (japaneseMixed.length > 0) {
    return japaneseMixed.sort((a, b) => a.length - b.length)[0];
  }

  return raw;
}

const GENERIC_WORLD_LORE_NAMES = new Set([
  '放課後', '学校', '教室', '廊下', '校舎', '部屋', '自宅', '街', '町', '都市', '世界',
  '一日', '今日', '明日', '昨日', '時間', '朝', '昼', '夜', '夕方',
  '勉強', '会話', '行動', '反応', '気持ち', '感情', '雰囲気', '状況', '関係',
  '生命体', '知的生命体', '人間', '少女', '少年', '男子', '女子', '生徒', '先生',
  'アクセサリー', 'スマホ', 'バッグ', 'ノート', 'イベント', 'フラグ', 'メモ',
  'アイテム', '解呪アイテム', '魔法アイテム', '道具', '武器',
  'カテゴリー', 'カテゴリ', '多様性', 'テーブル', 'フォーク',
  '金', '物資', '情報', '金・物資・情報', 'タイミング'
]);

const WORLD_LORE_NAME_SUFFIX_HINTS = [
  '高校', '学園', '学院', '学校', '大学', '寮', '邸', '屋敷', '城', '宮',
  '王国', '帝国', '連邦', '共和国', '公国', '領', '都', '市', '町', '村',
  '家', '組', '団', '隊', '軍', '教', '教会', '商会', '会社', '部',
  '陣営', '騎士団', '魔法', '加護', '魔女', '試験', '選', '編'
];

const WORLD_LORE_NAME_PART_HINTS = [
  '魔女教', '王選', '屋敷', '学園', '高校', '学院', '商会', '騎士団', '寮',
  'マンション', 'アパート', 'ホテル', 'カフェ', '喫茶', '神殿', '聖域'
];

const WORLD_LORE_TERM_HINTS = [
  '呪い', '加護', '権能', '精霊術', '魔法', '魔鉱石', '福音書', '祝福'
];

const WORLD_LORE_BLOCKED_PATTERNS = [
  /以上$/, /以下$/, /未満$/, /以外$/, /ごと$/, /達$/, /たち$/, /ら$/,
  /頑張$/, /普通$/, /みたい$/, /っぽい$/, /的$/, /用$/, /向け$/
];

export function isLikelyWorldLoreName(name, type = 'term') {
  const value = normalizeLoreEntryName(name).replace(/\s+/g, '');
  if (!value || value.length < 2) return false;
  if (/^[0-9０-９]+$/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9 _-]*$/.test(value)) return false;
  if (GENERIC_WORLD_LORE_NAMES.has(value)) return false;
  if (WORLD_LORE_BLOCKED_PATTERNS.some(pattern => pattern.test(value))) return false;

  const katakanaOnly = /^[\u30A0-\u30FFー・]+$/.test(value);
  const kanjiOnly = /^[\u4E00-\u9FAF々]+$/.test(value);
  const hasJapanese = hasJapaneseText(value);
  const hasHint =
    WORLD_LORE_NAME_SUFFIX_HINTS.some(suffix => value.endsWith(suffix)) ||
    WORLD_LORE_NAME_PART_HINTS.some(part => value.includes(part));
  const isKnownTerm = WORLD_LORE_TERM_HINTS.includes(value);

  if (type === 'character') {
    return hasJapanese && !GENERIC_WORLD_LORE_NAMES.has(value);
  }

  if (isKnownTerm) return true;
  if (hasHint) return true;
  if (katakanaOnly) return value.length >= 3;
  if (kanjiOnly) return value.length >= 2 && value.length <= 4;
  if (hasJapanese && /[・=＝]/.test(value)) return true;

  return false;
}

const SESSION_SPECIFIC_WORLD_LORE_PATTERNS = [
  /オリジナルキャラクター|オリキャラ/i,
  /このセッション|セッション限定|今回限り|今回だけ/i,
  /即興|臨時|仮設|一時的/i,
  /主人公(?:との|に対する|用の|専用|が|は)/,
  /ユーザー(?:との|が|は)/,
  /好感度|関係性メモ/i,
  /今日|さっき|先ほど|今この場|その場で/i,
  /ここで出会/i,
  /新しく(?:作った|設立した|結成した|雇った|名乗った)/i,
  /現在(?:の|は)?(?:拠点|同行|所属|状況)/i
];

function isSessionSpecificLoreText(text) {
  const value = (text || '').trim();
  if (!value) return false;
  return SESSION_SPECIFIC_WORLD_LORE_PATTERNS.some(pattern => pattern.test(value));
}

function buildSessionLoreNote(entry, name, summary) {
  const type = normalizeLoreType((entry?.type || '').trim());
  const details = (entry?.details || '').trim();
  const prefix = type === 'character' ? 'オリジナルキャラクター' : 'セッション設定';
  return details
    ? `${prefix}: ${name} - ${summary} / ${details}`
    : `${prefix}: ${name} - ${summary}`;
}

function isSameLoreCandidate(candidate, franchise, type, name) {
  return normalizeLoreKey(candidate?.franchise) === normalizeLoreKey(franchise) &&
    normalizeLoreType(candidate?.type || '') === type &&
    normalizeLoreKey(candidate?.name) === normalizeLoreKey(name);
}

function createUsageAccumulator(requestType, modelName) {
  return {
    requestType,
    modelName,
    requestCount: 0,
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    toolUsePromptTokenCount: 0,
    cachedContentTokenCount: 0,
    totalTokenCount: 0,
    thinkingConfigLabel: '',
    historyCompressionEnabled: true,
    historyTurnLimit: null,
    omittedTurns: 0,
      toolCalls: [],
      groundingQueries: [],
      googleSearchAvailable: false,
      serverToolRoundTrips: 0,
      searchProviderLabel: '',
      searchErrors: []
  };
}

function addUsageMetadata(accumulator, usageMetadata) {
  if (!accumulator || !usageMetadata) return accumulator;
  accumulator.requestCount += 1;
  accumulator.promptTokenCount += Number(usageMetadata.promptTokenCount || 0);
  accumulator.candidatesTokenCount += Number(usageMetadata.candidatesTokenCount || 0);
  accumulator.thoughtsTokenCount += Number(usageMetadata.thoughtsTokenCount || 0);
  accumulator.toolUsePromptTokenCount += Number(usageMetadata.toolUsePromptTokenCount || 0);
  accumulator.cachedContentTokenCount += Number(usageMetadata.cachedContentTokenCount || 0);
  accumulator.totalTokenCount += Number(usageMetadata.totalTokenCount || 0);
  return accumulator;
}

function publishUsageSnapshot(accumulator) {
  if (!accumulator || accumulator.requestCount <= 0) return null;
  const promptTotalChars = Number(accumulator.debug?.promptTotalChars || 0);
  const promptTokenCount = Number(accumulator.promptTokenCount || 0);
  let debug = null;

  if (accumulator.debug) {
    const breakdown = Object.entries(accumulator.debug.sections || {})
      .map(([label, chars]) => ({
        label,
        chars,
        estimatedPromptTokens: promptTotalChars > 0 && promptTokenCount > 0
          ? Math.round((chars / promptTotalChars) * promptTokenCount)
          : 0
      }))
      .sort((a, b) => b.chars - a.chars);

    debug = {
      promptTotalChars,
      systemInstructionChars: accumulator.debug.systemInstructionChars || 0,
      conversationChars: accumulator.debug.conversationChars || 0,
      toolSchemaChars: accumulator.debug.toolSchemaChars || 0,
      userMessageChars: accumulator.debug.userMessageChars || 0,
      modelMessageChars: accumulator.debug.modelMessageChars || 0,
      functionResponseChars: accumulator.debug.functionResponseChars || 0,
      thinkingConfigLabel: accumulator.thinkingConfigLabel || '',
      historyCompressionEnabled: accumulator.historyCompressionEnabled !== false,
      historyTurnLimit: accumulator.historyTurnLimit,
      omittedTurns: accumulator.omittedTurns || 0,
      toolCalls: Array.isArray(accumulator.toolCalls) ? accumulator.toolCalls : [],
      groundingQueries: Array.isArray(accumulator.groundingQueries) ? accumulator.groundingQueries : [],
      searchErrors: Array.isArray(accumulator.searchErrors) ? accumulator.searchErrors : [],
      googleSearchAvailable: accumulator.googleSearchAvailable === true,
      serverToolRoundTrips: Number(accumulator.serverToolRoundTrips || 0),
      searchProviderLabel: accumulator.searchProviderLabel || '',
      breakdown
    };
  }

  const snapshot = {
    ...accumulator,
    debug,
    timestamp: Date.now()
  };
  const state = getState();
  const history = Array.isArray(state.apiUsageHistory) ? state.apiUsageHistory : [];
  updateState({
    lastApiUsage: snapshot,
    apiUsageHistory: [snapshot, ...history].slice(0, 20)
  });
  if (state.promptDebugEnabled) {
    console.log(`[AI Usage][${snapshot.requestType}]`, snapshot);
  }
  return snapshot;
}

function buildToolCallPreview(args = {}) {
  const candidates = [
    args?.query,
    args?.name,
    args?.characterName,
    args?.franchise,
    args?.type,
    args?.characterId,
    args?.loreId
  ];
  const preview = candidates.find(value => typeof value === 'string' && value.trim());
  return preview ? preview.trim().slice(0, 60) : '';
}

function recordToolCall(accumulator, name, args = {}) {
  if (!accumulator || !name) return;
  if (!Array.isArray(accumulator.toolCalls)) {
    accumulator.toolCalls = [];
  }

  const existing = accumulator.toolCalls.find(item =>
    item?.name === name && item?.preview === buildToolCallPreview(args)
  );
  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    return;
  }

  accumulator.toolCalls.push({
    name,
    preview: buildToolCallPreview(args),
    count: 1
  });
}

function recordSearchError(accumulator, {
  provider = '',
  query = '',
  message = '',
  code = ''
} = {}) {
  if (!accumulator || !message) return;
  if (!Array.isArray(accumulator.searchErrors)) {
    accumulator.searchErrors = [];
  }

  const normalizedProvider = normalizeWebSearchProvider(provider || 'auto');
  const normalizedQuery = String(query || '').trim().slice(0, 80);
  const normalizedMessage = String(message || '').trim().slice(0, 180);
  const normalizedCode = String(code || '').trim().slice(0, 40);
  const existing = accumulator.searchErrors.find(item =>
    item?.provider === normalizedProvider &&
    item?.query === normalizedQuery &&
    item?.message === normalizedMessage
  );
  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    return;
  }

  accumulator.searchErrors.push({
    provider: normalizedProvider,
    query: normalizedQuery,
    message: normalizedMessage,
    code: normalizedCode,
    count: 1
  });
}

function recordGroundingMetadata(accumulator, groundingMetadata) {
  if (!accumulator || !groundingMetadata) return;
  if (!Array.isArray(accumulator.groundingQueries)) {
    accumulator.groundingQueries = [];
  }

  const queries = Array.isArray(groundingMetadata?.webSearchQueries)
    ? groundingMetadata.webSearchQueries
    : [];

  for (const rawQuery of queries) {
    const query = String(rawQuery || '').trim();
    if (!query) continue;
    if (!accumulator.groundingQueries.includes(query)) {
      accumulator.groundingQueries.push(query);
    }
  }
}

function hasServerToolParts(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(part => part?.toolCall || part?.toolResponse);
}

function stringifyDebugPart(part) {
  if (!part) return '';
  if (typeof part.text === 'string') return part.text;
  try {
    return JSON.stringify(part);
  } catch (_) {
    return '';
  }
}

function collectInstructionSections(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sections = [];
  let currentLabel = '導入・基本方針';
  let buffer = [];

  const flush = () => {
    const chunk = buffer.join('\n').trim();
    if (!chunk) return;
    sections.push({ label: currentLabel, chars: chunk.length });
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^【(.+?)】$/);
    if (headingMatch) {
      flush();
      currentLabel = headingMatch[1];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function ensureDebugAccumulator(accumulator) {
  if (!accumulator.debug) {
    accumulator.debug = {
      promptTotalChars: 0,
      systemInstructionChars: 0,
      conversationChars: 0,
      toolSchemaChars: 0,
      userMessageChars: 0,
      modelMessageChars: 0,
      functionResponseChars: 0,
      sections: {}
    };
  }
  return accumulator.debug;
}

function addDebugSection(debug, label, chars) {
  if (!chars) return;
  debug.sections[label] = (debug.sections[label] || 0) + chars;
}

function accumulatePromptDebug(accumulator, { systemInstruction = '', contents = [], tools = [] } = {}) {
  const debug = ensureDebugAccumulator(accumulator);

  const systemSections = collectInstructionSections(systemInstruction);
  let systemChars = 0;
  for (const section of systemSections) {
    systemChars += section.chars;
    addDebugSection(debug, `System: ${section.label}`, section.chars);
  }
  debug.systemInstructionChars += systemChars;

  let conversationChars = 0;
  let userChars = 0;
  let modelChars = 0;
  let functionResponseChars = 0;
  for (const item of contents) {
    const role = item?.role === 'model' ? 'model' : 'user';
    const parts = Array.isArray(item?.parts) ? item.parts : [];
    let itemChars = 0;
    let containsFunctionResponse = false;
    for (const part of parts) {
      const text = stringifyDebugPart(part);
      const len = text.length;
      if (part?.functionResponse) containsFunctionResponse = true;
      itemChars += len;
    }
    conversationChars += itemChars;
    if (containsFunctionResponse) {
      functionResponseChars += itemChars;
      addDebugSection(debug, '会話履歴: Function Response', itemChars);
      continue;
    }
    if (role === 'model') {
      modelChars += itemChars;
      addDebugSection(debug, '会話履歴: AIメッセージ', itemChars);
    } else {
      userChars += itemChars;
      addDebugSection(debug, '会話履歴: ユーザーメッセージ', itemChars);
    }
  }
  debug.conversationChars += conversationChars;
  debug.userMessageChars += userChars;
  debug.modelMessageChars += modelChars;
  debug.functionResponseChars += functionResponseChars;

  let toolSchemaChars = 0;
  if (Array.isArray(tools) && tools.length > 0) {
    try {
      toolSchemaChars = JSON.stringify(tools).length;
    } catch (_) {
      toolSchemaChars = 0;
    }
  }
  debug.toolSchemaChars += toolSchemaChars;
  addDebugSection(debug, 'Function Schema', toolSchemaChars);

  debug.promptTotalChars += systemChars + conversationChars + toolSchemaChars;
}

function shouldRouteWorldLoreEntryToSession(entry, existing, characterMatch) {
  const type = normalizeLoreType((entry?.type || '').trim());
  const combined = [
    entry?.name,
    entry?.summary,
    entry?.details,
    entry?.speech,
    entry?.relationships
  ].filter(Boolean).join(' ');

  if (type === 'character' && !characterMatch && !existing) {
    return true;
  }

  if (!existing && isSessionSpecificLoreText(combined)) {
    return true;
  }

  return false;
}

function resolveStoryFranchise(story, characters = []) {
  const direct = (story?.franchise || '').trim();
  if (direct) return direct;

  const firstStoryTag = Array.isArray(story?.tags)
    ? story.tags.map(tag => (tag || '').trim()).find(Boolean)
    : '';
  if (firstStoryTag) return firstStoryTag;

  const attachedIds = new Set((story?.characters || []).map(ref => ref.characterId));
  const counts = new Map();
  for (const character of characters) {
    if (!attachedIds.has(character.characterId)) continue;
    const values = [];
    if (character.category) values.push(character.category);
    if (Array.isArray(character.tags)) values.push(...character.tags);
    for (const rawValue of values) {
      const value = (rawValue || '').trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }

  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function buildCharacterSearchCorpus(character) {
  return [
    character?.name,
    character?.category,
    ...(Array.isArray(character?.tags) ? character.tags : []),
    character?.description,
    character?.personality,
    character?.mes_example
  ].filter(Boolean).join('\n');
}

function buildLoreSearchCorpus(lore) {
  return [
    lore?.name,
    lore?.type,
    lore?.franchise,
    lore?.searchContext,
    lore?.content?.summary,
    lore?.content?.profile,
    lore?.content?.speech,
    lore?.content?.relationships
  ].filter(Boolean).join('\n');
}

function toCharacterSearchResult(character, score = 0) {
  return {
    characterId: character.characterId,
    name: character.name || '',
    category: character.category || '',
    tags: Array.isArray(character.tags) ? character.tags : [],
    summary: buildCompactCharacterHint(character),
    score
  };
}

function toLoreSearchResult(lore, score = 0) {
  return {
    loreId: lore.id,
    name: lore.name || '',
    type: lore.type || 'term',
    franchise: lore.franchise || '',
    summary: lore?.content?.summary || '',
    score
  };
}

async function searchCharacterLibraryForStory(story, args = {}) {
  const query = String(args?.query || args?.characterName || '').trim();
  if (!query) {
    return { found: false, query: '', results: [], message: 'query is required' };
  }

  const allCharacters = await getCharactersList();
  const scopedCharacters = getStoryScopedCharacters(allCharacters, story);
  const primaryPool = scopedCharacters.length > 0 ? scopedCharacters : allCharacters;
  const fallbackPool = scopedCharacters.length > 0 ? allCharacters.filter(character => !primaryPool.some(item => item.characterId === character.characterId)) : [];
  const tokens = tokenizeSearchQuery(query);

  const rankCharacter = character => {
    const score =
      scoreSearchableText(character?.name, tokens) * 2 +
      scoreSearchableText(character?.category, tokens) +
      scoreSearchableText((character?.tags || []).join(' '), tokens) +
      scoreSearchableText(buildCharacterSearchCorpus(character), tokens);
    return { character, score };
  };

  const primaryMatches = primaryPool
    .map(rankCharacter)
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const fallbackMatches = fallbackPool
    .map(rankCharacter)
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const ranked = uniqueNonEmpty([
    ...primaryMatches.map(item => item.character.characterId),
    ...fallbackMatches.map(item => item.character.characterId)
  ]).map(characterId => {
    const hit = primaryMatches.find(item => item.character.characterId === characterId)
      || fallbackMatches.find(item => item.character.characterId === characterId);
    return hit;
  }).filter(Boolean);

  return {
    found: ranked.length > 0,
    query,
    scope: scopedCharacters.length > 0 ? 'story-first' : 'global',
    results: ranked.slice(0, 5).map(item => toCharacterSearchResult(item.character, item.score))
  };
}

async function getCharacterProfileForStory(story, args = {}) {
  const characterId = String(args?.characterId || '').trim();
  const characterName = String(args?.characterName || args?.name || '').trim();

  let character = characterId ? await getCharacter(characterId) : null;
  if (!character && characterName) {
    const searchResult = await searchCharacterLibraryForStory(story, { query: characterName });
    character = searchResult.results?.[0]?.characterId ? await getCharacter(searchResult.results[0].characterId) : null;
  }

  if (!character) {
    return {
      found: false,
      query: characterName || characterId,
      character: null
    };
  }

  return {
    found: true,
    character: {
      characterId: character.characterId,
      name: character.name || '',
      category: character.category || '',
      tags: Array.isArray(character.tags) ? character.tags : [],
      description: character.description || '',
      personality: character.personality || '',
      mes_example: character.mes_example || ''
    }
  };
}

function getLoreFranchiseBonus(lore, franchise) {
  const normalizedLoreFranchise = normalizeLoreKey(lore?.franchise);
  const normalizedFranchise = normalizeLoreKey(franchise);
  if (!normalizedLoreFranchise || !normalizedFranchise) return 0;
  return normalizedLoreFranchise === normalizedFranchise ? 80 : 0;
}

async function searchLorebookForStory(story, args = {}) {
  const query = String(args?.query || args?.name || '').trim();
  if (!query) {
    return { found: false, query: '', results: [], message: 'query is required' };
  }

  const requestedType = String(args?.type || '').trim().toLowerCase();
  const allLores = (await getWorldLores()).filter(lore => lore && lore.status === 'completed');
  const storyFranchise = String(args?.franchise || story?.franchise || '').trim();
  const tokens = tokenizeSearchQuery(query);

  let ranked = allLores
    .filter(lore => !requestedType || normalizeLoreType(lore.type) === normalizeLoreType(requestedType))
    .map(lore => {
      const score =
        scoreSearchableText(lore?.name, tokens) * 3 +
        scoreSearchableText(buildLoreSearchCorpus(lore), tokens) +
        getLoreFranchiseBonus(lore, storyFranchise);
      return { lore, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (storyFranchise && ranked.length === 0) {
    ranked = allLores
      .map(lore => ({
        lore,
        score:
          scoreSearchableText(lore?.name, tokens) * 3 +
          scoreSearchableText(buildLoreSearchCorpus(lore), tokens)
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  return {
    found: ranked.length > 0,
    query,
    franchise: storyFranchise,
    results: ranked.slice(0, 5).map(item => toLoreSearchResult(item.lore, item.score))
  };
}

async function getLoreEntryForStory(story, args = {}) {
  const loreId = String(args?.loreId || '').trim();
  const name = String(args?.name || args?.query || '').trim();
  const franchise = String(args?.franchise || story?.franchise || '').trim();

  let lore = loreId ? await getLore(loreId) : null;
  if (!lore && name) {
    lore = await getLoreByNameAndFranchise(name, franchise);
  }
  if (!lore && name) {
    const searchResult = await searchLorebookForStory(story, { query: name, franchise });
    lore = searchResult.results?.[0]?.loreId ? await getLore(searchResult.results[0].loreId) : null;
  }

  if (!lore) {
    return {
      found: false,
      query: name || loreId,
      lore: null
    };
  }

  return {
    found: true,
    lore: {
      loreId: lore.id,
      name: lore.name || '',
      type: lore.type || 'term',
      franchise: lore.franchise || '',
      searchContext: lore.searchContext || '',
      summary: lore?.content?.summary || '',
      profile: lore?.content?.profile || '',
      speech: lore?.content?.speech || '',
      relationships: lore?.content?.relationships || ''
    }
  };
}

function extractReferenceCandidatesFromText(text) {
  const words = new Set();
  const source = String(text || '');
  if (!source.trim()) return [];

  const katakana = source.match(/[\u30a0-\u30ffー]{2,20}/g) || [];
  const kanji = source.match(/[\u4e00-\u9faf]{2,12}/g) || [];
  const english = source.match(/[A-Z][a-zA-Z0-9:_-]{2,20}/g) || [];

  for (const rawWord of [...katakana, ...kanji, ...english]) {
    const word = normalizeLoreEntryName(rawWord).trim();
    if (!word || word.length < 2) continue;
    if (PROACTIVE_REFERENCE_STOPWORDS.has(word)) continue;
    words.add(word);
  }

  return Array.from(words);
}

function isLikelyGenericSearchTerm(term) {
  const value = normalizeLoreEntryName(term);
  if (!value) return true;
  if (PROACTIVE_REFERENCE_STOPWORDS.has(value)) return true;
  if (/^[\u3040-\u309fー]+$/.test(value)) return true;
  if (/^(それ|これ|あれ|どれ|ここ|そこ|あそこ|誰|何|どこ|いつ|なに|みんな|お前ら)$/.test(value)) return true;
  if (/^[\u4e00-\u9faf]{1,2}$/.test(value) && !KNOWN_WORLD_SEARCH_TERMS.has(value)) return true;
  return false;
}

function collectKnownWorldSearchTerms(text) {
  const source = String(text || '');
  const hits = [];
  for (const term of KNOWN_WORLD_SEARCH_TERMS) {
    if (source.includes(term)) {
      hits.push(term);
    }
  }
  return hits;
}

function filterSearchPlanningTerms(terms = []) {
  return uniqueNonEmpty(terms).filter(term => !isLikelyGenericSearchTerm(term));
}

function collectStoryScopedSearchAnchors(story, text) {
  const source = String(text || '');
  if (!source || !story) return [];

  const stateCharacters = Array.isArray(getState().characters) ? getState().characters : [];
  const scopedCharacters = getStoryScopedCharacters(stateCharacters, story);
  const anchors = [];

  for (const character of scopedCharacters) {
    const name = String(character?.name || '').trim();
    if (name && source.includes(name)) {
      anchors.push(name);
    }
  }

  for (const tag of Array.isArray(story?.tags) ? story.tags : []) {
    const value = String(tag || '').trim();
    if (value && source.includes(value)) {
      anchors.push(value);
    }
  }

  return uniqueNonEmpty(anchors);
}

function collectStoryReferenceCandidates(story, scopedCharacters = []) {
  const candidates = new Set();
  const messages = Array.isArray(story?.messages) ? story.messages : [];
  const recentMessages = messages.slice(-3);

  for (const message of recentMessages) {
    for (const term of extractReferenceCandidatesFromText(message?.content || message?.aiContent || '')) {
      candidates.add(term);
    }
  }

  const recentText = recentMessages
    .map(message => `${message?.content || ''}\n${message?.aiContent || ''}`)
    .join('\n');

  for (const character of scopedCharacters) {
    const name = String(character?.name || '').trim();
    if (!name) continue;
    if (recentText.includes(name)) {
      candidates.add(name);
    }
  }

  return Array.from(candidates).slice(0, 8);
}

function shouldEnableGoogleSearchForStory(story, systemInstruction, googleSearchEnabled) {
  if (!googleSearchEnabled) return false;
  if (/ローカル未解決候補:/.test(systemInstruction)) return true;

  const franchise = String(story?.franchise || '').trim();
  if (franchise) return true;

  const tags = Array.isArray(story?.tags)
    ? story.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  if (tags.length > 0) return true;

  return false;
}

function isStrongCharacterHit(searchResult, query) {
  const top = searchResult?.results?.[0];
  if (!top) return false;
  const normalizedQuery = normalizeLoreKey(query);
  const normalizedName = normalizeLoreKey(top.name);
  return normalizedName === normalizedQuery || Number(top.score || 0) >= 120;
}

function isStrongLoreHit(searchResult, query) {
  const top = searchResult?.results?.[0];
  if (!top) return false;
  const normalizedQuery = normalizeLoreKey(query);
  const normalizedName = normalizeLoreKey(top.name);
  return normalizedName === normalizedQuery || Number(top.score || 0) >= 120;
}

async function buildProactiveReferenceMemo(story, scopedCharacters, allCharacters, options = {}) {
  const referenceTerms = collectStoryReferenceCandidates(story, scopedCharacters);
  if (referenceTerms.length === 0) {
    return '';
  }

  const prefetchedCharacters = [];
  const prefetchedLores = [];
  const unresolvedTerms = [];

  for (const term of referenceTerms) {
    const characterSearch = await searchCharacterLibraryForStory(story, { query: term });
    if (isStrongCharacterHit(characterSearch, term)) {
      const characterId = characterSearch.results?.[0]?.characterId;
      const character = characterId ? await getCharacter(characterId) : null;
      if (character && !prefetchedCharacters.some(item => item.characterId === character.characterId)) {
        prefetchedCharacters.push(character);
        continue;
      }
    }

    const loreSearch = await searchLorebookForStory(story, { query: term });
    if (isStrongLoreHit(loreSearch, term)) {
      const loreId = loreSearch.results?.[0]?.loreId;
      const lore = loreId ? await getLore(loreId) : null;
      if (lore && !prefetchedLores.some(item => item.id === lore.id)) {
        prefetchedLores.push(lore);
        continue;
      }
    }

    unresolvedTerms.push(term);
  }

  if (prefetchedCharacters.length === 0 && prefetchedLores.length === 0 && unresolvedTerms.length === 0) {
    return '';
  }

  let block = `【事前参照メモ】\n`;
  block += `- 直近の会話から、次の固有名詞候補が見えている: ${referenceTerms.join(' / ')}\n`;
  block += `- これらは本文を書き始める前に確認すべき候補であり、周辺人物・所属・拠点・陣営の取りこぼしを減らすために使うこと。\n`;

  if (prefetchedCharacters.length > 0) {
    block += `- 事前取得できた人物:\n`;
    for (const character of prefetchedCharacters.slice(0, 3)) {
      const compactHint = buildCompactCharacterHint(character);
      block += `  ・${character.name}`;
      if (character.category) block += ` [${character.category}]`;
      if (compactHint) block += `: ${compactHint}`;
      block += `\n`;
    }
  }

  if (prefetchedLores.length > 0) {
    block += `- 事前取得できたロア:\n`;
    for (const lore of prefetchedLores.slice(0, 4)) {
      const hasConflict = lore.type === 'character' && hasCharacterLoreConflict(lore, allCharacters, story?.franchise || '');
      block += `  ・${lore.name} (${lore.type || '設定'})`;
      if (lore.content?.summary) block += `: ${lore.content.summary}`;
      if (hasConflict) block += ` ※演技はキャラクターライブラリ優先`;
      block += `\n`;
    }
  }

  if (unresolvedTerms.length > 0) {
    block += `- ローカル未解決候補: ${unresolvedTerms.join(' / ')}\n`;
    if (options.googleSearchEnabled) {
      block += `- ローカル未解決候補が原作キャラ・組織・地名・種族・陣営に関わる場合、本文を書く前に Google Search で確認すること。\n`;
      block += `- 特に原作キャラを出す場合は、同行者・陣営・拠点・代表的な関係者を確認し、場面に必要なら自然に同席させること。\n`;
    }
  }

  block += `\n`;
  return block;
}

function normalizeSessionLoreEvent(event) {
  if (typeof event === 'string') return event.trim();
  if (event == null) return '';
  if (typeof event === 'number' || typeof event === 'boolean') return String(event);
  if (typeof event === 'object') {
    const candidates = [
      event.text,
      event.summary,
      event.title,
      event.name,
      event.label,
      event.event
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    try {
      return JSON.stringify(event);
    } catch (_) {
      return '';
    }
  }
  return '';
}

function mergeSessionLoreEvents(existingEvents = [], nextEvents = []) {
  const merged = [...existingEvents, ...nextEvents]
    .map(normalizeSessionLoreEvent)
    .filter(Boolean);
  return Array.from(new Set(merged));
}

function normalizeSessionLoreList(items = [], limit = 12) {
  return Array.from(new Set((Array.isArray(items) ? items : [])
    .map(normalizeSessionLoreEvent)
    .filter(Boolean))).slice(0, limit);
}

function createEmptySessionLore() {
  return {
    summary: '',
    summary_source: '',
    current_state: '',
    open_threads: [],
    recent_turning_points: [],
    key_events: []
  };
}

function ensureSessionLoreStructure(story) {
  if (!story) return createEmptySessionLore();
  const sessionLore = story.session_lore && typeof story.session_lore === 'object'
    ? story.session_lore
    : {};
  story.session_lore = {
    ...createEmptySessionLore(),
    ...sessionLore,
    open_threads: normalizeSessionLoreList(sessionLore.open_threads || [], 10),
    recent_turning_points: normalizeSessionLoreList(sessionLore.recent_turning_points || [], 8),
    key_events: normalizeSessionLoreList(sessionLore.key_events || [], 20)
  };
  return story.session_lore;
}

async function applySessionLoreUpdate(args, story) {
  const sessionLore = ensureSessionLoreStructure(story);
  if (args.summary) {
    sessionLore.summary = args.summary;
    sessionLore.summary_source = 'ai';
  }
  if (args.current_state) {
    sessionLore.current_state = String(args.current_state || '').trim();
  }
  if (args.open_threads) {
    sessionLore.open_threads = normalizeSessionLoreList(args.open_threads, 10);
  }
  if (args.recent_turning_points) {
    sessionLore.recent_turning_points = normalizeSessionLoreList(args.recent_turning_points, 8);
  }
  if (args.key_events) {
    sessionLore.key_events = mergeSessionLoreEvents(sessionLore.key_events || [], args.key_events).slice(-20);
  }
  if (args.affinity_updates) {
    if (!story.relationshipMemory) story.relationshipMemory = {};
    const characters = await getCharactersList();
    for (const update of args.affinity_updates) {
      const charMatch = characters.find(c => c.name === update.characterName);
      if (charMatch) {
        story.relationshipMemory[charMatch.characterId] = {
          affinity: update.affinity,
          notes: update.notes || ''
        };
      }
    }
  }
}

async function applyWorldLoreUpdate(args, story) {
  const entries = Array.isArray(args?.entries) ? args.entries : [];
  if (entries.length === 0) return { queuedCount: 0, reroutedCount: 0 };

  const characters = await getCharactersList();
  const franchise = resolveStoryFranchise(story, characters);
  if (!franchise) return { queuedCount: 0, reroutedCount: 0 };

  if (!Array.isArray(story.lore_candidates)) story.lore_candidates = [];

  let queuedCount = 0;
  let reroutedCount = 0;
  for (const entry of entries) {
    const name = normalizeLoreEntryName(entry?.name);
    const summary = (entry?.summary || '').trim();
    if (!name || !summary) continue;

    const type = normalizeLoreType((entry?.type || '').trim());
    const existing = await getLoreByNameAndFranchise(name, franchise);
    const characterMatch = characters.find(c => normalizeLoreKey(c.name) === normalizeLoreKey(name));

    if (!existing && !isLikelyWorldLoreName(name, type)) {
      if (shouldRouteWorldLoreEntryToSession(entry, existing, characterMatch)) {
        const sessionLore = ensureSessionLoreStructure(story);
        const sessionNote = buildSessionLoreNote(entry, name, summary);
        sessionLore.key_events = mergeSessionLoreEvents(sessionLore.key_events || [], [sessionNote]).slice(-20);
        reroutedCount++;
      }
      continue;
    }

    if (shouldRouteWorldLoreEntryToSession(entry, existing, characterMatch)) {
      const sessionLore = ensureSessionLoreStructure(story);
      const sessionNote = buildSessionLoreNote(entry, name, summary);
      sessionLore.key_events = mergeSessionLoreEvents(sessionLore.key_events || [], [sessionNote]).slice(-20);
      reroutedCount++;
      continue;
    }

    if (type === 'character' && hasCharacterLoreConflict({ name }, characters, franchise)) {
      continue;
    }
    if (existing?.verified === true) {
      continue;
    }

    if (existing) {
      continue;
    }

    const candidate = {
      id: crypto.randomUUID(),
      franchise,
      type,
      name,
      content: {
        summary,
        profile: (entry?.details || '').trim(),
        speech: (entry?.speech || '').trim(),
        relationships: (entry?.relationships || '').trim()
      },
      source: 'story-derived',
      createdAt: Date.now()
    };

    const existingCandidateIndex = story.lore_candidates.findIndex(item =>
      isSameLoreCandidate(item, franchise, type, name)
    );

    if (existingCandidateIndex >= 0) {
      story.lore_candidates[existingCandidateIndex] = {
        ...story.lore_candidates[existingCandidateIndex],
        ...candidate,
        id: story.lore_candidates[existingCandidateIndex].id,
        createdAt: story.lore_candidates[existingCandidateIndex].createdAt || candidate.createdAt,
        updatedAt: Date.now()
      };
    } else {
      story.lore_candidates.push(candidate);
    }
    queuedCount++;
  }

  return { queuedCount, reroutedCount };
}

/**
 * Builds the comprehensive System Instruction for the Gemini API.
 * Combines storyteller rules, world prompts, protagonist info, scoped characters,
 * short-term memories, and relationships.
 */
export async function buildSystemInstruction(story, options = {}) {
  if (!story) return '';
  const allCharacters = await getCharactersList();
  const webSearchEnabled = options.googleSearchEnabled === true;
  const gemmaThinkEnabled = options.gemmaThinkEnabled === true;

  // ★ momentum と worldTone を取り出すように追加
  const { storytellerPrompt, worldPrompt, protagonist, characterMemory, relationshipMemory, momentum, worldTone } = story;
  const showChoices = getState().showChoices;

  // 1. Core Role and Instructions (固定のエンジン哲学)
  let instruction = `# 役割\n`;
  instruction += `あなたは卓越したゲームマスターであり、物語の演出家です。\n`;
  instruction += `以下の【GM哲学】、【演出モジュール】、および登録された【登場人物】に従い、インタラクティブな群像劇を展開してください。\n\n`;

  instruction += `【出力形式（厳守・最優先）】\n`;
  instruction += `- プレイヤーに見せるのは**日本語の物語本文**（と選択肢）だけ。メタな思考過程や英語は一切出力しない。\n`;
  instruction += `- 執筆ルールの文字数目安に従い、本文を十分な長さで書く。\n\n`;

  if ((story.imageBaseUrl || '').trim()) {
    instruction += `【画像表示トークンのルール】\n`;
    instruction += `- 画像を表示したい本文の直前に、制御行として \`@img:キャラクター名|衣装名|ファイル名\` を1行だけ出力できます。\n`;
    instruction += `- 例: \`@img:四葉|初期衣装|表情微笑\`\n`;
    if ((story.imageDefaultOutfit || '').trim()) {
      instruction += `- 衣装名を省略したい場合は既定衣装「${story.imageDefaultOutfit}」が使われますが、可能な限り明示してください。\n`;
    }
    instruction += `- ファイル名に拡張子がない場合は .avif として扱われます。\n`;
    instruction += `- 画像トークンは本文ではなく表示用の制御行です。許可されたキャラクター・衣装・表情だけを使い、分からない場合は出力しないでください。\n\n`;
  }

  instruction += `【重要：チャットUI表示のための記述フォーマット】\n`;
  instruction += `UI側で発言者と描写を分離して吹き出し描画を行うため、物語本文は以下の「台本形式」の記法ルールを**絶対に厳守**してください。\n`;
  instruction += `1. **キャラクターの行動・発言**:\n`;
  instruction += `   必ず \`キャラクター名（動作や表情など）:「セリフ内容」\` の形式で1行ずつ記述してください。主人公（${protagonist?.name || '主人公'}）の場合も同様です。\n`;
  instruction += `   - セリフのみの場合: \`キャラクター名:「セリフ」\`\n`;
  instruction += `   - セリフがなく動作のみの場合: \`キャラクター名（動作）\`\n`;
  instruction += `   （例: \`中野四葉（勢いよく立ち上がる）:「終わりました！」\` または \`上杉風太郎（深くため息をつく）\`）\n`;
  instruction += `2. **環境描写・状況説明**: 必ず \`【】\` で囲んで記述してください。例: \`【放課後の図書室。夕日が窓から差し込んでいる。】\`\n`;
  instruction += `3. **心理描写・地の文**: 必ず \`**\` で囲んで記述してください。例: \`**彼の平穏な放課後は、今日も遠い。**\`\n\n`;

  // === 新設：GM哲学（コア思想・固定） ===
  instruction += `【GMとしての基本哲学（絶対ルール）】\n`;
  instruction += `1. **行動の尊重と世界の抵抗**: ユーザーの行動（試み）は肯定し見せ場を作るが、成功や結果は安易に保証しない。世界や敵は自らの法則で抵抗する。\n`;
  instruction += `2. **NPCの生気と群像劇**: 世界は停止しない。NPCは自律し、主人公の指示待ち人形にならず、自らの感情と行動原理で動く。NPC同士の会話や対立も描くこと。\n`;
  instruction += `3. **世界の自律進行**: NPC、周囲の状況、外部イベント、場面の空気は、主人公の入力待ちで不自然に停止させず、自然な流れとして進行させてよい。毎ターン「どうしますか？」と確認して止めるより、状況を半歩前へ動かした状態で出力を終えることを優先する。\n`;
  instruction += `4. **主人公の主導権**: 主人公の重要な選択、明確なセリフ、感情や意思決定の断定はユーザーを優先し、AIが勝手に確定しないこと。ただし、場面を成立させるための受動的な流れや周囲の進行まで過剰に停止しないこと。\n`;
  instruction += `5. **テンポ優先の進行**: 毎ターン確認や催促で終えるのではなく、NPCの反応、場面の変化、出来事の進行を通じて、物語が自然に前へ進む出力を優先すること。主人公の介入余地は残してよいが、それを理由に世界全体を停止させてはならない。\n`;
  instruction += `6. **ナレーターの視点制限（カメラ視点）**: 地の文は、外から観測可能な事実（情景、NPCの表情や行動など）を中心に描写すること。主人公の内心（何を考え、何を感じ、何を理解したか）を勝手に代弁・描写してはならない。「主人公は〇〇と理解した」「不快感はなかった」等の心理解釈は固く禁ずる。\n\n`;
  instruction += `【重要：世界観の正確な描写と参照ツールの使い分け】\n`;
  instruction += `実在の作品名（アニメ、漫画等）をベースにした世界観の場合、安易にオリジナルの敵、魔法、地名、設定を捏造してはいけません。\n`;
  instruction += `キャラクターライブラリやロアブックに登録済みの内容は、必要になった時に参照ツールで検索・取得してから使ってください。\n`;
  instruction += `- 人物情報は search_character_library / get_character_profile を優先して使うこと。\n`;
  instruction += `- 世界設定や用語は search_lorebook / get_lore_entry を優先して使うこと。\n`;
  instruction += `- ローカル参照で不足する場合は search_web を使い、原作設定や周辺人物、所属、拠点、制度を確認すること。\n`;
  instruction += `- search_web がクォータ制限や一時エラーで失敗した場合、その内部事情をユーザーへ説明せず、分かる範囲だけで保守的に描写を続けること。\n`;
  instruction += `- ローカル参照で見つからない内容だけ、モデル自身の既知知識を慎重に使うこと。\n`;
  instruction += `- 不確かな固有設定を断定せず、確証のない場合は曖昧な言い切りを避けること。\n\n`;
  if (webSearchEnabled) {
    instruction += `【Web検索の使用ルール】\n`;
    instruction += `- このターンでは Web検索を利用できます。必要なら search_web を使ってください。\n`;
    instruction += `- 現在のストーリーで原作キャラ・組織・地名・種族・制度を扱う際、ローカル参照だけで不足するなら Web検索で補完すること。\n`;
    instruction += `- 特に「ある人物を場に出した時に、通常なら同席・同行・所属している関係者がいるか」を確認し、必要なら自然に描写へ反映すること。\n`;
    instruction += `- ユーザーが明示的に聞いていなくても、場面の整合性に必要なら検索してよい。\n\n`;
  }
  // === 新設：AIディレクターモジュール（パラメータの翻訳） ===
  const curSettings = story.directorSettings || { momentum: 40, autonomy: 80, worldTone: 10, backgroundTension: 0, romanticVisibility: 20, relationshipDrift: 60, intrusionRate: 0 };

  instruction += `【演出モジュール（現在のセッション設定）】\n`;

  // 1. Momentum (展開の推進力)
  instruction += `■ 展開の推進力: `;
  if (curSettings.momentum >= 70) {
    instruction += `[劇的・能動的] AIの裁量で積極的にアクシデント、ハプニング、対立を発生させ、物語を停滞させずユーザーに行動を迫ること。\n`;
  } else if (curSettings.momentum <= 30) {
    instruction += `[日常・受動的] ユーザーの行動を待ち、日常や会話の解像度を上げることに注力。AIから急激な場面転換や事件は起こさないこと。\n`;
  } else {
    instruction += `[標準的] 基本はユーザーの行動に応じるが、物語が完全に停滞した時のみ、軽い変化やイベントを起こすこと。\n`;
  }

  // 2. World Tone (世界の温度)
  instruction += `■ 世界の温度: `;
  if (curSettings.worldTone <= 30) {
    instruction += `[優しい・甘め] NPCは基本的に好意的・寛容であり、失敗しても致命的な結果にはならない。安心感を与える空気感を維持すること。\n`;
  } else if (curSettings.worldTone >= 70) {
    instruction += `[シビア・残酷] 世界はユーザーに冷酷である。NPCの裏切り、理不尽な暴力、致命的な失敗が起こり得る。甘い選択には厳しい代償で応じること。\n`;
  } else {
    instruction += `[現実的] 現実的な因果関係。好意には好意で、敵対には敵対で世界が妥当なリアクションを返すこと。\n`;
  }

  // 3. Autonomy (NPCの自律性)
  instruction += `■ NPCの自律性: `;
  if (curSettings.autonomy >= 70) {
    instruction += `[独立した群像劇] NPCは主人公の指示待ちにならず、独自の行動原理で動く。NPC同士の会話、意見の対立、主人公の知らない場所での行動も積極的に描くこと。\n`;
  } else if (curSettings.autonomy <= 30) {
    instruction += `[主人公フォーカス] NPCは主に主人公に向けてアクションを行い、主人公の行動に対するリアクションを中心に描写すること。\n`;
  } else {
    instruction += `[標準的] 基本は主人公との関係を中心に描くが、時折NPC独自の意思や行動も見せること。\n`;
  }

  // 4. Background Tension (不穏さ)
  if (curSettings.backgroundTension >= 70) {
    instruction += `■ 不穏さ: 画面の端々に、不穏な空気、見えない悪意、あるいは説明のつかない違和感を常に漂わせること。\n`;
  } else if (curSettings.backgroundTension <= 30) {
    instruction += `■ 不穏さ: 緊迫感はなく、徹底的に平和で安心できる空気感をベースとすること。\n`;
  }

  // 5. Romantic Visibility (恋愛・好意の露出)
  instruction += `■ 恋愛・好意の露出: `;
  if (curSettings.romanticVisibility <= 30) {
    instruction += `[秘匿・行間] 好意や恋愛感情は直接言葉に出さず、視線の泳ぎ、僅かな焦り、距離感の躊躇いなど、秘匿された感情として繊細に描写すること。\n`;
  } else if (curSettings.romanticVisibility >= 70) {
    instruction += `[直接的・露骨] 好意や感情は隠さず、直接的な言葉や大胆なスキンシップとして明確に表現すること。\n`;
  } else {
    instruction += `[自然な表現] 状況や親密度に応じて、自然な形で好意や感情を表現すること。\n`;
  }

  // 6. Relationship Drift (関係性の変動)
  if (curSettings.relationshipDrift >= 70) {
    instruction += `■ 関係性の変動: キャラクター同士の好感度や信頼関係は固定ではない。ちょっとしたすれ違いで疑心暗鬼になったり急接近したりと、関係性をダイナミックに揺さぶること。\n`;
  }

  // 7. Intrusion Rate (非日常の侵入)
  if (curSettings.intrusionRate >= 70) {
    instruction += `■ 非日常の侵入: 平和な日常描写の最中であっても、唐突に非日常（敵の襲撃、異変、事件のトリガー）を侵入させ、空気を一変させること。\n`;
  }
  instruction += `\n`;
  // 既存のストーリーテラープロンプト（ユーザーが書いたローカルルール）
  if (storytellerPrompt) {
    instruction += `【追加のローカルルール（独自設定）】\n${storytellerPrompt}\n\n`;
  }

  // 選択肢の提示ルール
  if (showChoices) {
    instruction += `【選択肢の提示ルール】\n`;
    instruction += `応答の末尾に、必ずストーリーを次の展開に進めるための選択肢を以下の【A/B/C形式】で出力してください。それ以外の形式は禁止します。\n`;
    instruction += `──────────────\n`;
    instruction += `► A.（関係を進める・能動的な行動やセリフ）\n`;
    instruction += `► B.（様子を見る・保留する行動やセリフ）\n`;
    instruction += `► C.（意外性のある・場を動かす行動やセリフ）\n`;
    instruction += `──────────────\n\n`;
  } else {
    instruction += `【選択肢の提示ルール】\n`;
    instruction += `応答の末尾に選択肢（► A, B, C）を提示しないでください。ストーリーの描写のみで終了してください。\n\n`;
  }

  // 2. World Concept Settings (以降は元のコードのまま)
  instruction += `【世界観設定・あらすじ】\n`;
  // ... 以下既存のコードが続く ...
  instruction += `${worldPrompt || '特に設定されていません。一般的な日常世界です。'}\n\n`;

  // 3. Protagonist Settings
  if (protagonist) {
    instruction += `【主人公設定】\n`;
    instruction += `・名前: ${protagonist.name || '主人公'}\n`;
    if (protagonist.description) {
      instruction += `・詳細・容姿・性格:\n${protagonist.description}\n`;
    }
    instruction += `\n`;
  }

  // 4. Character roster / specifications
  const includeFullCharacterProfiles = shouldSendFullCharacterProfiles(story);
  instruction += `【登場人物・キャラクター設定】\n`;
  const scopedCharacters = getStoryScopedCharacters(allCharacters, story);
  if (scopedCharacters.length > 0) {
    if (includeFullCharacterProfiles) {
      instruction += `※ このターンはキャラクター設定のフル更新ターンです。各人物の詳細設定と口調サンプルを再確認してから描写してください。\n\n`;
      for (const char of scopedCharacters) {
        instruction += `■ ${char.name}\n`;
        instruction += `・詳細設定・容姿: ${char.description || '特になし'}\n`;
        instruction += `・性格・特徴: ${char.personality || '特になし'}\n`;
        if (char.mes_example) {
          instruction += `・台詞・口調サンプル:\n${char.mes_example}\n`;
        }
        instruction += `\n`;
      }
    } else {
      instruction += `※ このターンは軽量モードです。詳細なキャラクター設定全文は省略し、名前と要点のみを再掲します。必要な人物の詳細は search_character_library / get_character_profile で取得してから描写してください。\n\n`;
      for (const char of scopedCharacters) {
        const compactHint = buildCompactCharacterHint(char);
        instruction += `・${char.name}`;
        if (compactHint) {
          instruction += `: ${compactHint}`;
        }
        instruction += `\n`;
      }
      instruction += `\n`;
    }
  } else {
    instruction += `登録されている登場人物はいません。\n\n`;
  }

  instruction += `【情報の優先順位ルール】\n`;
  instruction += `・キャラクターライブラリに登録された人物の口調、一人称、二人称、性格、台詞例は、同名のロアブック情報より常に優先すること。\n`;
  instruction += `・ロアブック内の人物情報は、所属、立場、背景、関係性などの補助資料として扱い、口調や演技の上書きには使わないこと。\n\n`;

  // 5. Dynamic memories (short-term states & relationships)
  let memoryStr = '';
  if (characterMemory && typeof characterMemory === 'object') {
    for (const [charId, mem] of Object.entries(characterMemory)) {
      const char = await getCharacter(charId);
      if (!char || !mem) continue;
      memoryStr += `・${char.name}の状況: ${mem.status || '特になし'}, 短期目標: ${mem.shortTermGoal || 'なし'}, 位置: ${mem.location || '未設定'}\n`;
      if (mem.notes) {
        memoryStr += `  (メモ: ${mem.notes})\n`;
      }
    }
  }
  if (memoryStr) {
    instruction += `【登場人物の個別状態・短期記憶】\n${memoryStr}\n`;
  }

  let relationStr = '';
  if (relationshipMemory && typeof relationshipMemory === 'object') {
    for (const [charId, rel] of Object.entries(relationshipMemory)) {
      const char = await getCharacter(charId);
      if (!char || !rel) continue;
      relationStr += `・${char.name}との関係性 (好感度: ${rel.affinity ?? 50}/100): ${rel.notes || '特になし'}\n`;
    }
  }
  if (relationStr) {
    instruction += `【主人公と各人物の関係性記憶】\n${relationStr}\n`;
  }

  // 6.5 Session Lore (長期あらすじとフラグ記録)
  if (story.session_lore) {
    const sessionLore = ensureSessionLoreStructure(story);
    instruction += `【これまでのストーリー進行・獲得フラグ（長期記憶）】\n`;
    if (sessionLore.summary) {
      instruction += `・全体状況/あらすじ: ${sessionLore.summary}\n`;
    }
    if (sessionLore.current_state) {
      instruction += `・現在の場面: ${sessionLore.current_state}\n`;
    }
    if (sessionLore.open_threads && sessionLore.open_threads.length > 0) {
      instruction += `・未解決の懸案:\n`;
      sessionLore.open_threads.forEach(item => {
        instruction += `  - ${item}\n`;
      });
    }
    if (sessionLore.recent_turning_points && sessionLore.recent_turning_points.length > 0) {
      instruction += `・最近の転換点:\n`;
      sessionLore.recent_turning_points.forEach(item => {
        instruction += `  - ${item}\n`;
      });
    }
    if (sessionLore.key_events && sessionLore.key_events.length > 0) {
      instruction += `・主要イベント・獲得フラグ:\n`;
      sessionLore.key_events.forEach(ev => {
        instruction += `  - ${ev}\n`;
      });
    }
    instruction += `\n`;
  }

  if ((options.omittedTurns || 0) > 0) {
    instruction += `【会話履歴の圧縮】\n`;
    instruction += `・古い会話 ${options.omittedTurns} ターン分は直接送信していない。必要な前提は上記のセッションロア要約と関係記憶を優先して参照すること。\n`;
    instruction += `・直近の会話だけを細かく参照し、それ以前の流れは要約ベースで一貫性を維持すること。\n\n`;
  }

  const searchMemoryBlock = buildSearchMemoryInstructionBlock(story);
  if (searchMemoryBlock) {
    instruction += searchMemoryBlock;
  }

  instruction += `【ロア分類ルール】\n`;
  instruction += `- セッションロア: このセッションで起きた出来事、現在の進行状況、主人公との関係変化、今回の行動でのみ意味を持つ情報。\n`;
  instruction += `- セッションで新しく生まれたオリジナルキャラクター、今回限りの役職、即興の設定はセッションロア側に入れること。\n`;
  instruction += `- ワールドロア: 作品世界で安定している固有設定。地名、学校名、組織名、家名、居住地、制度、陣営、用語、世界のルールなど。\n`;
  instruction += `- ワールドロアの名称は日本語の代表表記で登録すること。英語併記や括弧つき併記はしないこと。例: Protection(加護) ではなく 加護。\n`;
  instruction += `- 一時的な出来事や関係の変動をワールドロアへ入れないこと。\n`;
  instruction += `- 逆に、作品全体で共有される安定設定をセッションロアの要点として消費しないこと。\n\n`;
  instruction += `- 大きな出来事、関係性の変化、新規オリジナル人物の登場があったターンでは、本文を書く前に update_session_lore を優先して呼ぶこと。\n`;
  instruction += `- update_session_lore.summary は、履歴圧縮後でも単独で状況が通じる正式な進行要約として扱うこと。主人公が今どこで何をしているか、誰とどんな状態か、未解決の懸案は何かまで分かるように更新すること。\n`;
  instruction += `- update_session_lore.key_events は補助メモであり、summary の代わりにはしない。summary だけでも大筋を復元できるようにすること。\n`;
  instruction += `- update_world_lore は安定設定だけに使い、セッション情報の代用にしないこと。\n`;
  instruction += `- update_world_lore は「確定登録」ではなく「ワールドロア候補の提案」として扱われる。安定設定だと強く判断できるものだけを提案すること。\n\n`;
  instruction += `【検索と展開設計のルール】\n`;
  instruction += `- 原作世界を舞台にする場合、本文を書く前に「この場面を作品固有の展開にするために何を確認すべきか」を1〜2歩先まで考えること。\n`;
  instruction += `- ユーザーが明示的に検索を要求していなくても、組織、制度、拠点、同行者、商会、依頼、敵対勢力、進行中事件、地元の常識などが場面に関わるなら自発的に参照・検索してよい。\n`;
  instruction += `- まずキャラクターライブラリ、ロアブック、検索メモを確認し、足りない時だけ search_web を使うこと。\n`;
  instruction += `- 汎用ファンタジーの代用品で埋めず、作品固有の候補を優先すること。例: 商会、屋敷、陣営、魔獣、学校、騎士団、地域勢力。\n`;
  instruction += `- すでに検索メモにある主題は再検索せず、その情報を使って場面を肉付けすること。\n\n`;

  // ==========================================
  // RAG: 固有名詞の抽出とロアブックの注入
  // ==========================================
  const detectedKeywords = extractKeywordsForLore(story);
  if (detectedKeywords.length > 0) {
    const matchedLores = [];
    const franchise = story.franchise || '';

    // DBから完全/部分一致するロアを取得
    for (const keyword of detectedKeywords) {
      try {
        const lore = await getLoreByNameAndFranchise(keyword, franchise);
        if (lore && lore.status === 'completed' && !matchedLores.some(l => l.id === lore.id)) {
          matchedLores.push(lore);
        }
      } catch (e) {
        console.warn(`Error querying lore for ${keyword}:`, e);
      }
    }

  if (matchedLores.length > 0) {
      // 関連度スコアリング (簡易的にキーワード一致数または順序で評価)
      // 制限：最大5件、かつ合計最大4000文字
      const MAX_LORE_ITEMS = 5;
      const MAX_LORE_CHARS = 4000;

      let injectedCount = 0;
      let totalChars = 0;
      let loreInstruction = `【関連設定・ロア情報 (Reference Lore)】\n`;

      for (const lore of matchedLores) {
        if (injectedCount >= MAX_LORE_ITEMS) break;
        const hasConflict = lore.type === 'character' && hasCharacterLoreConflict(lore, allCharacters, franchise);

        let loreBlock = `■ ${lore.name} (${lore.type || '設定'})\n`;
        if (lore.content?.summary) loreBlock += `・概要: ${lore.content.summary}\n`;
        if (lore.content?.profile) loreBlock += `・詳細プロフィール: ${lore.content.profile}\n`;
        if (hasConflict) {
          loreBlock += `・注記: この人物の口調・話し方・人格表現はキャラクターライブラリ設定を優先すること。\n`;
        } else if (lore.content?.speech) {
          loreBlock += `・口調・特徴: ${lore.content.speech}\n`;
        }
        if (lore.content?.relationships) loreBlock += `・関係性: ${lore.content.relationships}\n`;
        loreBlock += `\n`;

        if (totalChars + loreBlock.length > MAX_LORE_CHARS) {
          // 残りの枠に入る分だけ部分的に入れるか、安全のため足切りする
          const remainingSpace = MAX_LORE_CHARS - totalChars;
          if (remainingSpace > 100) {
            loreInstruction += loreBlock.substring(0, remainingSpace) + `... [以下文字数制限のため省略]\n\n`;
            totalChars = MAX_LORE_CHARS;
          }
          break;
        }

        loreInstruction += loreBlock;
        totalChars += loreBlock.length;
        injectedCount++;
      }

      if (injectedCount > 0) {
        instruction += `\n${loreInstruction}`;
      }
    }
  }

  const proactiveReferenceMemo = await buildProactiveReferenceMemo(story, scopedCharacters, allCharacters, {
    googleSearchEnabled: webSearchEnabled
  });
  if (proactiveReferenceMemo) {
    instruction += `\n${proactiveReferenceMemo}`;
  }

  if (gemmaThinkEnabled) {
    return `<|think|>\n${instruction}`;
  }
  return instruction;
}

/**
 * 簡易固有名詞抽出ロジック
 * ユーザー入力や直近メッセージ、シーン情報から漢字、カタカナ、英数字単語をキーワードとして切り出す
 */
function extractKeywordsForLore(story) {
  const wordsSet = new Set();
  const textSource = [];

  // 直近2メッセージのテキストを追加
  const msgs = story.messages || [];
  const startIdx = Math.max(0, msgs.length - 2);
  for (let i = startIdx; i < msgs.length; i++) {
    textSource.push(msgs[i].content);
  }

  const combinedText = textSource.join('\n');

  // カタカナ・漢字（2文字以上）、および大文字英単語などを抽出する簡易的な正規表現
  const matchesKatakana = combinedText.match(/[\u30a0-\u30ffー]{2,15}/g) || [];
  const matchesKanji = combinedText.match(/[\u4e00-\u9faf]{2,10}/g) || [];
  const matchesEnglish = combinedText.match(/[A-Z][a-zA-Z]{2,15}/g) || [];

  [...matchesKatakana, ...matchesKanji, ...matchesEnglish].forEach(word => {
    // 一般名詞や助詞、不要な言葉のフィルタリング（文字長などの簡易フィルタ）
    const w = word.trim();
    if (w && w.length >= 2) {
      wordsSet.add(w);
    }
  });

  return Array.from(wordsSet);
}

/** 行に十分な日本語が含まれるか */
function hasSignificantJapanese(str) {
  if (!str) return false;
  const cjk = (str.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
  return cjk >= 6 || (str.length > 0 && cjk / str.length > 0.12);
}

/**
 * 思考漏れ（英語の計画メモ等）が本文に混ざったときの救済フィルタ
 */
export function stripLeakedThinkingText(text) {
  if (!text || typeof text !== 'string') return text;

  let working = text.trim();

  const draftMatch = working.match(/Drafting the scene:\s*/i);
  if (draftMatch) {
    working = working.slice(working.indexOf(draftMatch[0]) + draftMatch[0].length).trim();
  }

  const metaLine =
    /^(User input:|Context:|Setting:|Goal:|Visuals?:|Action:|Encounter:|Let's |Third[- ]person|Show, don't|Avoid direct|Strict adherence|No meta|Maybe |Actually |Who\?|Describe the|Introduce the|Yuki has|End with)/i;

  const lines = working.split('\n');
  let storyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (storyStart === i) storyStart = i + 1;
      continue;
    }
    if (/^---+$/.test(line) || metaLine.test(line)) {
      storyStart = i + 1;
      continue;
    }
    if (hasSignificantJapanese(line)) {
      storyStart = i;
      break;
    }
    if (/^[A-Za-z0-9\s,.:;'"!?()[\]\-–—]+$/.test(line) && line.length > 12) {
      storyStart = i + 1;
      continue;
    }
    break;
  }

  const stripped = lines.slice(storyStart).join('\n').trim();
  return stripped.length >= 40 ? stripped : working;
}

function extractLeakedThinkingAndStory(text) {
  if (!text || typeof text !== 'string') return { thought: null, text };

  const working = text.trim();
  const lines = working.split('\n');
  const metaLine =
    /^(User input:|Context:|Setting:|Goal:|Visuals?:|Action:|Encounter:|Let's |Third[- ]person|Show, don't|Avoid direct|Strict adherence|No meta|Maybe |Actually |Who\?|Describe the|Introduce the|Drafting the scene:|The user wants|Current Situation:|\* )/i;

  let storyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (storyStart === i) storyStart = i + 1;
      continue;
    }
    if (/^---+$/.test(line) || metaLine.test(line)) {
      storyStart = i + 1;
      continue;
    }
    if (hasSignificantJapanese(line)) {
      storyStart = i;
      break;
    }
    if (/^[A-Za-z0-9\s,.:;'"!?()[\]\-–—/*]+$/.test(line) && line.length > 12) {
      storyStart = i + 1;
      continue;
    }
    break;
  }

  const thought = lines.slice(0, storyStart).join('\n').trim();
  const storyText = lines.slice(storyStart).join('\n').trim();
  if (storyText.length >= 40 && thought.length >= 20) {
    return { thought, text: storyText };
  }
  return { thought: null, text: stripLeakedThinkingText(working) };
}

/**
 * API レスポンスから物語本文だけを取り出す（thought パートを除外）
 */
export function extractStoryTextAndThoughtFromApiResponse(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return { text: null, thought: null };

  let storyChunks = [];
  let thoughtChunks = [];

  for (const part of parts) {
    const t = part?.text;
    if (!t) continue;
    if (part.thought === true) {
      thoughtChunks.push(t);
    } else {
      storyChunks.push(t);
    }
  }

  const storyText = storyChunks.length > 0 ? stripLeakedThinkingText(storyChunks.join('\n\n').trim()) : null;
  // もしthoughtフラグがなく混ざっているモデル（2.5 Flash等）へのフォールバック
  if (!storyText && thoughtChunks.length === 0) {
    const full = parts.map(p => p.text).filter(Boolean).join('\n\n').trim();
    return extractLeakedThinkingAndStory(full);
  }

  if (storyText && thoughtChunks.length === 0) {
    const full = parts.map(p => p.text).filter(Boolean).join('\n\n').trim();
    const leaked = extractLeakedThinkingAndStory(full);
    if (leaked.thought && leaked.text) {
      return leaked;
    }
  }

  return { text: storyText, thought: thoughtChunks.join('\n\n').trim() };
}

function getThinkingSupportForModel(modelName = '') {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (normalized.includes('gemma-4')) {
    return { kind: 'gemma4' };
  }
  if (!normalized.includes('gemini') || normalized.includes('gemma') || normalized.includes('1.5')) {
    return { kind: 'unsupported' };
  }
  if (/gemini-3(?:[.-]|$)/.test(normalized)) {
    return { kind: 'gemini3' };
  }
  if (/gemini-2\.5(?:[.-]|$)/.test(normalized)) {
    return {
      kind: 'gemini25',
      isPro: normalized.includes('pro')
    };
  }
  return { kind: 'unsupported' };
}

function supportsCombinedGoogleSearch(modelName = '') {
  const normalized = String(modelName || '').trim().toLowerCase();
  return normalized.includes('gemini-3');
}

function shouldUseServerSideGoogleSearchForStory() {
  // Story generation currently prefers the explicit search_web function.
  // This keeps search traffic predictable and avoids stacking:
  // prepass search + server-side tool circulation + client-side search_web.
  return false;
}

function collectUnresolvedReferenceTerms(systemInstruction = '') {
  const match = String(systemInstruction || '').match(/ローカル未解決候補:\s*([^\n]+)/);
  if (!match) return [];
  return match[1]
    .split('/')
    .map(term => normalizeLoreEntryName(term))
    .filter(Boolean)
    .slice(0, 8);
}

function buildGoogleSearchGroundingPrompt(story, unresolvedTerms = [], recentMessages = []) {
  const franchise = String(story?.franchise || '').trim();
  const tags = Array.isArray(story?.tags)
    ? story.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  const latestUserMessage = [...recentMessages].reverse().find(message => message?.role === 'user');
  const latestText = String(latestUserMessage?.content || '').trim();

  let prompt = `あなたは物語生成の前に事実確認を行う下調べ担当です。\n`;
  prompt += `Google Search を使い、日本語で短い確認メモだけを返してください。\n`;
  prompt += `推測で埋めず、検索で裏を取れた内容だけを書くこと。\n`;
  prompt += `会話本文は書かず、箇条書きのみで返すこと。\n`;
  prompt += `キャラクターを確認した場合は、必要に応じて同行者・所属陣営・拠点・関係者も補ってください。\n`;
  if (franchise) {
    prompt += `作品タグ: ${franchise}\n`;
  }
  if (tags.length > 0) {
    prompt += `補助タグ: ${tags.join(', ')}\n`;
  }
  if (unresolvedTerms.length > 0) {
    prompt += `優先確認対象: ${unresolvedTerms.join(' / ')}\n`;
  }
  if (latestText) {
    prompt += `直近のユーザー入力: ${latestText}\n`;
  }
  prompt += `\n出力形式:\n`;
  prompt += `- 確認メモ1\n`;
  prompt += `- 確認メモ2\n`;
  return prompt;
}

async function fetchGoogleSearchGroundingMemo({
  url,
  story,
  systemInstruction,
  selectedMessages,
  generationConfig,
  attemptController,
  usageAccumulator
}) {
  const unresolvedTerms = collectUnresolvedReferenceTerms(systemInstruction);
  if (unresolvedTerms.length === 0) {
    return '';
  }

  const prompt = buildGoogleSearchGroundingPrompt(story, unresolvedTerms, selectedMessages);
  const searchGenerationConfig = {
    ...generationConfig,
    temperature: 0.2,
    maxOutputTokens: 1024
  };

  accumulatePromptDebug(usageAccumulator, {
    systemInstruction: '',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }]
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: searchGenerationConfig,
      tools: [{ googleSearch: {} }],
      toolConfig: {
        includeServerSideToolInvocations: true
      }
    }),
    signal: attemptController.signal
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errMsg = errorData.error?.message || `HTTP status ${response.status}`;
    throw new Error(`Google Search grounding failed: ${errMsg}`);
  }

  const result = await response.json();
  addUsageMetadata(usageAccumulator, result?.usageMetadata);
  recordGroundingMetadata(usageAccumulator, result?.candidates?.[0]?.groundingMetadata);
  if (hasServerToolParts(result)) {
    usageAccumulator.serverToolRoundTrips = Number(usageAccumulator.serverToolRoundTrips || 0) + 1;
  }

  const extracted = extractStoryTextAndThoughtFromApiResponse(result);
  const memo = String(extracted?.text || '').trim();
  if (!memo) {
    return '';
  }

  return `【Google Search 事前確認メモ】\n${memo}\n\n`;
}

function isServerSideGoogleSearchEnabledForTurn(story, systemInstruction, modelName) {
  if (!shouldUseServerSideGoogleSearchForStory()) return false;
  if (!supportsCombinedGoogleSearch(modelName)) return false;
  return shouldEnableGoogleSearchForStory(story, systemInstruction, true);
}

function buildStructuredSearchMemoPrompt(providerLabel, query, purpose, franchise) {
  let prompt = `あなたは物語生成を支援する検索アシスタントです。\n`;
  prompt += `${providerLabel} を使い、日本語で簡潔な事実確認メモを返してください。\n`;
  prompt += `推測は禁止。検索で裏が取れた内容だけを書くこと。\n`;
  prompt += `説明口調ではなく、設定資料メモの文体で返すこと。\n`;
  prompt += `対象語: ${query}\n`;
  if (franchise) {
    prompt += `作品・文脈: ${franchise}\n`;
  }
  if (purpose) {
    prompt += `確認目的: ${purpose}\n`;
  }
  prompt += `\n出力形式:\n`;
  prompt += `概要: 1〜3文\n`;
  prompt += `補足:\n- 箇条書き1\n- 箇条書き2\n`;
  return prompt;
}

function buildSearchPlanningPrompt(story, selectedMessages = []) {
  const franchise = String(story?.franchise || '').trim();
  const franchiseContext = String(story?.franchiseContext || '').trim();
  const latestUserMessage = [...selectedMessages].reverse().find(message => message?.role === 'user');
  const latestText = String(latestUserMessage?.content || '').trim();
  const recentDialogue = selectedMessages
    .slice(-6)
    .map(message => `${message?.role === 'user' ? 'USER' : 'MODEL'}: ${String(message?.aiContent || message?.content || '').trim()}`)
    .join('\n')
    .slice(-2200);
  const searchMemory = ensureSearchMemory(story)
    .slice(0, 6)
    .map(entry => `- ${entry.topicKey || entry.query}${entry.sceneGoal ? ` <${entry.sceneGoal}>` : ''}`)
    .join('\n');

  return `
あなたはユーザー体感型ストーリーのための「検索計画プランナー」です。
次の本文を書く前に、原作ならではの世界観・組織・同行者・拠点・制度・事件進行を自然に反映させるため、外部Web検索が必要かを判定してください。
検索が不要なら無理に探さず、必要な場合だけ1件に絞ってください。

作品タグ: ${franchise || '未設定'}
検索用別名: ${franchiseContext || 'なし'}
最新のユーザー入力: ${latestText || 'なし'}

直近の会話:
${recentDialogue || 'なし'}

既存の検索メモ:
${searchMemory || 'なし'}

判断ルール:
- 作品固有の制度・組織・拠点・依頼文化・陣営・同行者・敵対勢力・原作イベント進行を描くと場面が豊かになるなら検索候補にする。
- ユーザーが明示的に質問していなくても、次の展開に必要なら検索してよい。
- ただし、既存の検索メモで十分なら needsSearch を false にする。
- 一般名詞だけをそのまま調べるのではなく、作品名と目的を含む具体的な検索語にする。
- 人物なら「同行者」「所属」「拠点」、制度なら「依頼」「商会」「騎士団」など、次の場面に必要な観点を query に含める。

JSONのみを返してください:
{
  "needsSearch": true,
  "topicKey": "エミリア陣営",
  "query": "エミリア Re:ゼロから始める異世界生活 同行者 陣営 拠点",
  "purpose": "場面に自然に同席しうる人物と拠点を把握する",
  "sceneGoal": "次の場面を原作らしい人間関係で肉付けする",
  "reason": "ユーザーは人物紹介ではなく場面進行をしているが、同行者を知らないと原作らしさが弱くなる"
}

検索が不要なら次を返してください:
{
  "needsSearch": false,
  "topicKey": "",
  "query": "",
  "purpose": "",
  "sceneGoal": "",
  "reason": "既存メモとローカル情報で十分"
}
`.trim();
}

function shouldUseExternalProviderPlanning(provider, tavilyApiKey = '') {
  const normalizedProvider = normalizeWebSearchProvider(provider);
  if (normalizedProvider === 'tavily') return true;
  if (normalizedProvider === 'duckduckgo') return true;
  if (normalizedProvider === 'auto' && String(tavilyApiKey || '').trim()) return true;
  return false;
}

function buildExternalProviderSearchPlan(story, selectedMessages = []) {
  const latestUserMessage = [...selectedMessages].reverse().find(message => message?.role === 'user');
  const latestText = String(latestUserMessage?.content || '').trim();
  if (!latestText) return null;

  const franchise = String(story?.franchise || '').trim();
  const franchiseContext = String(story?.franchiseContext || '').trim();
  const searchContext = franchiseContext || franchise;
  if (!searchContext) return null;

  const scopedAnchors = collectStoryScopedSearchAnchors(story, latestText);
  const knownWorldTerms = collectKnownWorldSearchTerms(latestText);
  const candidateTerms = filterSearchPlanningTerms([
    ...scopedAnchors,
    ...knownWorldTerms,
    ...extractReferenceCandidatesFromText(latestText).filter(Boolean)
  ]);
  const searchHintPattern = /(教えて|とは|って|誰|どこ|何|なに|どういう|詳細|説明|調べ|検索|依頼|護衛|討伐|商会|騎士団|屋敷|学園|学校|王都|王選|陣営|魔女教|精霊|加護|白鯨|ギルド)/;
  const hasStrongAnchor = scopedAnchors.length > 0 || knownWorldTerms.length > 0;
  const shouldSearch = (candidateTerms.length > 0 && searchHintPattern.test(latestText) && hasStrongAnchor)
    || candidateTerms.some(term => KNOWN_WORLD_SEARCH_TERMS.has(term));
  if (!shouldSearch) return null;

  const topicKey = normalizeLoreEntryName(candidateTerms[0] || '').slice(0, 60);
  const queryHead = candidateTerms.slice(0, 2).join(' ');
  if (!queryHead) return null;
  const query = [queryHead, searchContext].filter(Boolean).join(' ').trim();
  if (!query) return null;

  const isQuestion = /(教えて|とは|って|誰|どこ|何|なに|どういう|詳細|説明|調べ|検索)/.test(latestText);
  return {
    topicKey: topicKey || latestText.slice(0, 40),
    query,
    purpose: isQuestion
      ? 'ユーザーが話題にした固有要素の事実確認'
      : '次の場面で作品固有の制度・人物・拠点を自然に出すための確認',
    sceneGoal: isQuestion
      ? '会話中の質問に世界観準拠で答える'
      : '次の展開を作品固有の要素で肉付けする',
    reason: '外部検索プロバイダ利用時のローカル検索計画',
    franchise: searchContext
  };
}

async function planProactiveStorySearch(story, selectedMessages = [], usageAccumulator = null) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();
  const tavilyApiKey = String(appState.tavilyApiKey || '').trim();
  const provider = normalizeWebSearchProvider(appState.webSearchProvider);
  if (!apiKey || provider === 'off') return null;

  const hasFranchiseContext = Boolean(
    String(story?.franchise || '').trim() ||
    String(story?.franchiseContext || '').trim() ||
    (Array.isArray(story?.tags) && story.tags.some(tag => String(tag || '').trim()))
  );
  if (!hasFranchiseContext) return null;

  const latestUserMessage = [...selectedMessages].reverse().find(message => message?.role === 'user');
  if (!latestUserMessage?.content) return null;

  if (shouldUseExternalProviderPlanning(provider, tavilyApiKey)) {
    return buildExternalProviderSearchPlan(story, selectedMessages);
  }

  const modelName = resolveSearchModelName(appState);
  const prompt = buildSearchPlanningPrompt(story, selectedMessages);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  if (usageAccumulator) {
    accumulatePromptDebug(usageAccumulator, {
      systemInstruction: '',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: []
    });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 512
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    recordSearchError(usageAccumulator, {
      provider,
      query: latestUserMessage?.content || '',
      code: `planner:${response.status}`,
      message: errorData.error?.message || `検索計画の生成に失敗しました (${response.status})`
    });
    return null;
  }

  const result = await response.json().catch(() => null);
  if (usageAccumulator && result) {
    addUsageMetadata(usageAccumulator, result?.usageMetadata);
  }
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return null;
  const text = parts.filter(part => !part?.thought).map(part => part?.text || '').join('\n').trim();
  const parsed = parseJsonObjectFromModelText(text);
  if (!parsed || parsed.needsSearch !== true) return null;

  return {
    topicKey: normalizeLoreEntryName(parsed.topicKey || parsed.query || ''),
    query: String(parsed.query || '').trim(),
    purpose: String(parsed.purpose || '').trim(),
    sceneGoal: String(parsed.sceneGoal || '').trim(),
    reason: String(parsed.reason || '').trim(),
    franchise: String(story?.franchise || '').trim() || String(story?.franchiseContext || '').trim()
  };
}

async function maybePrimeStorySearchMemory(story, selectedMessages = [], usageAccumulator = null) {
  const plan = await planProactiveStorySearch(story, selectedMessages, usageAccumulator);
  if (!plan?.query) return null;

  if (findSearchMemoryMatch(story, plan)) {
    return { reused: true, plan };
  }

  const characterSearch = await searchCharacterLibraryForStory(story, { query: plan.topicKey || plan.query });
  if (isStrongCharacterHit(characterSearch, plan.topicKey || plan.query)) {
    return { reused: true, local: 'character', plan };
  }

  const loreSearch = await searchLorebookForStory(story, { query: plan.topicKey || plan.query, franchise: plan.franchise || story?.franchise || '' });
  if (isStrongLoreHit(loreSearch, plan.topicKey || plan.query)) {
    return { reused: true, local: 'lore', plan };
  }

  recordToolCall(usageAccumulator, 'search_web', {
    query: plan.query,
    franchise: plan.franchise,
    purpose: plan.purpose
  });
  const result = await searchWebForStory(story, {
    query: plan.query,
    purpose: plan.purpose,
    franchise: plan.franchise,
    topicKey: plan.topicKey,
    sceneGoal: plan.sceneGoal,
    source: 'planner'
  }, usageAccumulator, null);

  if (result?.found) {
    await saveStory(story);
  }
  return { result, plan };
}

function buildTavilySummary(payload, query, franchise) {
  const answer = String(payload?.answer || '').trim();
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, 3) : [];
  const lines = [];

  if (answer) {
    lines.push(`概要: ${answer}`);
  } else if (results.length > 0) {
    const lead = [String(results[0]?.title || '').trim(), String(results[0]?.content || '').trim()]
      .filter(Boolean)
      .join(' - ')
      .slice(0, 220);
    if (lead) {
      lines.push(`概要: ${lead}`);
    }
  } else {
    lines.push(`概要: ${[query, franchise].filter(Boolean).join(' / ')}`);
  }

  if (results.length > 0) {
    lines.push('補足:');
    for (const item of results) {
      const snippet = [String(item?.title || '').trim(), String(item?.content || '').trim()]
        .filter(Boolean)
        .join(' - ')
        .replace(/\s+/g, ' ')
        .slice(0, 220);
      if (snippet) {
        lines.push(`- ${snippet}`);
      }
    }
  }

  return lines.join('\n').trim().slice(0, 1400);
}

async function runTavilyLookup({ apiKey, query, purpose, franchise }) {
  const searchQuery = [query, franchise].filter(Boolean).join(' ');
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: searchQuery,
      topic: 'general',
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
      include_usage: true
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData?.detail ||
      errorData?.message ||
      errorData?.error ||
      `HTTP status ${response.status}`;
    const quotaLike = isQuotaLikeApiError(response.status, message);
    if (quotaLike) {
      setWebSearchCooldown('tavily');
    }
    return {
      provider: 'tavily',
      found: false,
      rateLimited: quotaLike,
      message
    };
  }

  const payload = await response.json().catch(() => null);
  const text = buildTavilySummary(payload, query, franchise);
  return {
    provider: 'tavily',
    found: Boolean(text),
    modelName: '',
    text,
    groundingQueries: [],
    usageCredits: Number(payload?.usage?.credits || 0),
    message: text ? '' : 'Tavily から十分な要約を取得できませんでした。'
  };
}

async function runGoogleSearchLookup({
  apiKey,
  modelName,
  query,
  purpose,
  franchise,
  usageAccumulator
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const prompt = buildStructuredSearchMemoPrompt('Google Search', query, purpose, franchise);

  if (usageAccumulator) {
    accumulatePromptDebug(usageAccumulator, {
      systemInstruction: '',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }]
    });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 1024
      },
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.error?.message || `HTTP status ${response.status}`;
    const quotaLike = isQuotaLikeApiError(response.status, message);
    if (quotaLike) {
      setWebSearchCooldown('google');
    }
    return {
      provider: 'google',
      found: false,
      rateLimited: quotaLike,
      message
    };
  }

  const result = await response.json();
  if (usageAccumulator) {
    addUsageMetadata(usageAccumulator, result?.usageMetadata);
    recordGroundingMetadata(usageAccumulator, result?.candidates?.[0]?.groundingMetadata);
    if (hasServerToolParts(result)) {
      usageAccumulator.serverToolRoundTrips = Number(usageAccumulator.serverToolRoundTrips || 0) + 1;
    }
  }

  const extracted = extractStoryTextAndThoughtFromApiResponse(result);
  const text = String(extracted?.text || '').trim();
  return {
    provider: 'google',
    found: Boolean(text),
    modelName,
    text,
    groundingQueries: Array.isArray(result?.candidates?.[0]?.groundingMetadata?.webSearchQueries)
      ? result.candidates[0].groundingMetadata.webSearchQueries
      : [],
    message: text ? '' : 'Google Search から有効な本文を取得できませんでした。'
  };
}

function flattenDuckDuckGoRelatedTopics(relatedTopics = []) {
  const flat = [];
  for (const topic of Array.isArray(relatedTopics) ? relatedTopics : []) {
    if (Array.isArray(topic?.Topics)) {
      for (const nested of topic.Topics) {
        flat.push(nested);
      }
    } else {
      flat.push(topic);
    }
  }
  return flat;
}

function buildDuckDuckGoSummary(payload, query, franchise) {
  const heading = String(payload?.Heading || query || '').trim();
  const abstractText = String(payload?.AbstractText || '').trim();
  const definition = String(payload?.Definition || '').trim();
  const answer = String(payload?.Answer || '').trim();
  const related = flattenDuckDuckGoRelatedTopics(payload?.RelatedTopics).slice(0, 3);

  const lines = [];
  if (heading || franchise) {
    lines.push(`概要: ${[heading, franchise].filter(Boolean).join(' / ')}`);
  }
  if (abstractText) {
    lines.push(abstractText);
  } else if (definition) {
    lines.push(definition);
  } else if (answer) {
    lines.push(answer);
  }

  if (related.length > 0) {
    lines.push('補足:');
    for (const topic of related) {
      const text = String(topic?.Text || '').trim();
      if (text) {
        lines.push(`- ${text}`);
      }
    }
  }

  return lines.join('\n').trim();
}

async function runDuckDuckGoLookup({ query, franchise }) {
  const searchQuery = [query, franchise].filter(Boolean).join(' ');
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json&no_html=1&skip_disambig=1&t=ZetaTavern`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    return {
      provider: 'duckduckgo',
      found: false,
      message: `HTTP status ${response.status}`
    };
  }

  const payload = await response.json();
  const text = buildDuckDuckGoSummary(payload, query, franchise);
  return {
    provider: 'duckduckgo',
    found: Boolean(text),
    text,
    modelName: '',
    groundingQueries: [],
    message: text ? '' : 'DuckDuckGo から十分な要約を取得できませんでした。'
  };
}

async function searchWebForStory(story, args = {}, usageAccumulator = null, searchState = null) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();
  const tavilyApiKey = String(appState.tavilyApiKey || '').trim();
  const query = String(args?.query || '').trim();
  const purpose = String(args?.purpose || '').trim();
  const franchise = String(args?.franchise || story?.franchise || '').trim();
  const provider = normalizeWebSearchProvider(appState.webSearchProvider);
  const cacheKey = JSON.stringify({
    provider,
    query: normalizeLoreEntryName(query),
    purpose: normalizeLoreEntryName(purpose),
    franchise: normalizeLoreEntryName(franchise)
  });

  if (!apiKey) {
    return { found: false, query, message: 'APIキーが設定されていません。' };
  }
  if (!query) {
    return { found: false, query: '', message: 'query is required' };
  }
  if (provider === 'off') {
    return {
      found: false,
      query,
      purpose,
      franchise,
      provider,
      message: 'Web検索は設定でOFFになっています。'
    };
  }
  if (searchState?.cache?.has(cacheKey)) {
    return searchState.cache.get(cacheKey);
  }
  if (searchState) {
    const usedCalls = Number(searchState.usedCalls || 0);
    if (usedCalls >= MAX_SEARCH_WEB_CALLS_PER_TURN) {
      return {
        found: false,
        query,
        purpose,
        franchise,
        deferred: true,
        message: `このターンの Web検索は ${MAX_SEARCH_WEB_CALLS_PER_TURN} 回までに制限されています。`
      };
    }
    searchState.usedCalls = usedCalls + 1;
  }

  const modelName = resolveSearchModelName(appState);
  const runProviderLookup = async (providerName) => {
    if (providerName === 'tavily') {
      if (!tavilyApiKey) {
        return {
          provider: 'tavily',
          found: false,
          message: 'Tavily APIキーが未設定です。'
        };
      }
      const cooldownMs = getWebSearchCooldownRemainingMs('tavily');
      if (cooldownMs > 0) {
        return {
          provider: 'tavily',
          found: false,
          rateLimited: true,
          retryAfterMs: cooldownMs,
          message: 'Tavily は一時的にクォータ制限中です。'
        };
      }
      return runTavilyLookup({
        apiKey: tavilyApiKey,
        query,
        purpose,
        franchise
      });
    }
    if (providerName === 'google') {
      const cooldownMs = getWebSearchCooldownRemainingMs('google');
      if (cooldownMs > 0) {
        return {
          provider: 'google',
          found: false,
          rateLimited: true,
          retryAfterMs: cooldownMs,
          message: 'Google Search は一時的にクォータ制限中です。'
        };
      }
      return runGoogleSearchLookup({
        apiKey,
        modelName,
        query,
        purpose,
        franchise,
        usageAccumulator
      });
    }
    return runDuckDuckGoLookup({ query, franchise });
  };

  const providerOrder = provider === 'auto'
    ? [tavilyApiKey ? 'tavily' : '', 'google', 'duckduckgo'].filter(Boolean)
    : [provider];
  let result = null;

  for (const providerName of providerOrder) {
    const attempt = await runProviderLookup(providerName);
    if (attempt?.found) {
      result = attempt;
      break;
    }
    if (attempt?.message) {
      recordSearchError(usageAccumulator, {
        provider: providerName,
        query,
        code: attempt?.rateLimited ? 'rate_limited' : '',
        message: attempt.message
      });
    }
    result = attempt;
    if (provider !== 'auto') {
      break;
    }
  }

  const normalizedResult = {
    ...result,
    found: result?.found === true,
    query,
    purpose,
    franchise,
    provider: result?.provider || provider
  };
  if (story && normalizedResult.found && normalizedResult.text) {
    upsertSearchMemoryEntry(story, {
      topicKey: args?.topicKey || query,
      query,
      purpose,
      franchise,
      provider: normalizedResult.provider,
      sceneGoal: args?.sceneGoal || '',
      summary: normalizedResult.text,
      source: args?.source || 'search_web'
    });
  }
  if (searchState?.cache) {
    searchState.cache.set(cacheKey, normalizedResult);
  }
  return normalizedResult;
}

function isQuotaLikeApiError(status, message = '') {
  const normalized = String(message || '').toLowerCase();
  if (status === 429) return true;
  return normalized.includes('quota') ||
    normalized.includes('rate limit') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('resource_exhausted');
}

function normalizeGemini3ThinkingLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'none') return 'minimal';
  if (normalized === 'standard') return 'medium';
  if (['minimal', 'low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'medium';
}

function normalizeGemini25ThinkingPreset(value, modelName = '') {
  const support = getThinkingSupportForModel(modelName);
  const normalized = String(value || '').trim().toLowerCase();
  let preset = 'balanced';

  if (normalized === 'none') {
    preset = 'off';
  } else if (normalized === 'standard' || normalized === 'medium') {
    preset = 'balanced';
  } else if (['off', 'dynamic', 'minimal', 'balanced', 'high'].includes(normalized)) {
    preset = normalized;
  } else if (normalized === 'low') {
    preset = 'minimal';
  }

  if (support.kind === 'gemini25' && support.isPro && preset === 'off') {
    return 'dynamic';
  }
  return preset;
}

function normalizeGemmaThinkingEnabled(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['off', 'false', '0', 'disabled'].includes(normalized)) return false;
  return Boolean(value === '' ? true : value);
}

function buildThinkingConfig(modelName, appState) {
  const support = getThinkingSupportForModel(modelName);
  if (support.kind === 'unsupported') {
    return null;
  }

  if (support.kind === 'gemma4') {
    return {
      gemmaThinkEnabled: normalizeGemmaThinkingEnabled(appState.gemmaThinkingEnabled)
    };
  }

  if (support.kind === 'gemini3') {
    const level = normalizeGemini3ThinkingLevel(appState.thinkingLevelGemini3 || appState.thinkingLevel);
    return {
      includeThoughts: true,
      thinkingLevel: level
    };
  }

  const preset = normalizeGemini25ThinkingPreset(appState.thinkingBudgetPresetGemini25 || appState.thinkingLevel, modelName);
  let budget = 1024;
  if (preset === 'off') {
    budget = 0;
  } else if (preset === 'dynamic') {
    budget = -1;
  } else if (preset === 'minimal') {
    budget = 512;
  } else if (preset === 'high') {
    budget = 4096;
  }

  return {
    includeThoughts: true,
    thinkingBudget: budget
  };
}

function describeThinkingConfig(config) {
  if (!config) return 'なし';
  if (typeof config.gemmaThinkEnabled === 'boolean') {
    return config.gemmaThinkEnabled ? 'Gemma <|think|>: ON' : 'Gemma <|think|>: OFF';
  }
  if (config.thinkingLevel) return `Level: ${config.thinkingLevel}`;
  if (typeof config.thinkingBudget === 'number') {
    if (config.thinkingBudget === -1) return 'Budget: Dynamic';
    return `Budget: ${config.thinkingBudget}`;
  }
  return 'あり';
}

/**
 * Sends messages to Gemini API.
 * Supports timeout, retries, and manual stop.
 */
export async function generateStoryResponse(story) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  // --- 設定から値を取得（なければ安全なデフォルト値を使用） ---
  const parsedTimeout = parseInt(appState.apiTimeout, 10);
  const parsedRetries = parseInt(appState.apiRetries, 10);
  const timeoutSeconds = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 60;
  const maxRetries = Number.isFinite(parsedRetries) && parsedRetries > 0 ? parsedRetries : 1;

  const modelName = appState.modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const usageAccumulator = createUsageAccumulator('story', modelName);
  const webSearchProvider = normalizeWebSearchProvider(appState.webSearchProvider);
  const googleSearchEnabled = webSearchProvider !== 'off';
  usageAccumulator.searchProviderLabel = getWebSearchProviderLabel(webSearchProvider);
  const historyCompressionEnabled = appState.historyCompressionEnabled !== false;
  const configuredHistoryTurnLimit = Number.isFinite(Number(appState.historyTurnLimit)) ? Number(appState.historyTurnLimit) : 10;
  const effectiveHistoryTurnLimit = historyCompressionEnabled ? configuredHistoryTurnLimit : 0;
  const { selectedMessages, omittedTurns } = selectPromptMessages(story.messages || [], effectiveHistoryTurnLimit);
  usageAccumulator.historyCompressionEnabled = historyCompressionEnabled;
  usageAccumulator.historyTurnLimit = effectiveHistoryTurnLimit;
  usageAccumulator.omittedTurns = omittedTurns;

  await maybePrimeStorySearchMemory(story, selectedMessages, usageAccumulator);

  const systemInstruction = await buildSystemInstruction(story, {
    omittedTurns,
    historyTurnLimit: effectiveHistoryTurnLimit,
    googleSearchEnabled,
    gemmaThinkEnabled: normalizeGemmaThinkingEnabled(appState.gemmaThinkingEnabled)
  });
  const shouldOfferGoogleSearchForTurn = isServerSideGoogleSearchEnabledForTurn(story, systemInstruction, modelName);
  usageAccumulator.googleSearchAvailable = googleSearchEnabled;
  let runtimeSystemInstruction = systemInstruction;

  // Map messages to Gemini API formats: { role: 'user' | 'model', parts: [{ text: string }] }
  const contents = selectedMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.aiContent || msg.content }]
  }));

  const generationConfig = {
    temperature: 0.9,
    topP: 0.95,
    maxOutputTokens: 8192
  };

  // ★ モデル名も一緒に渡して、非対応モデルならエラーを回避する
  const thinkingConfig = buildThinkingConfig(modelName, appState);
  usageAccumulator.thinkingConfigLabel = describeThinkingConfig(thinkingConfig);
  if (thinkingConfig && typeof thinkingConfig.gemmaThinkEnabled !== 'boolean') {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  // 手動キャンセル用のメイン AbortController
  const mainController = new AbortController();
  updateState({ activeAbortController: mainController });

  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;

    // このアテンプト専用の AbortController
    const attemptController = new AbortController();

    const onMainAbort = () => attemptController.abort();
    mainController.signal.addEventListener('abort', onMainAbort);

    const timeoutId = setTimeout(() => {
      attemptController.abort();
    }, timeoutSeconds * 1000);

  try {
      // ローカル参照と更新用の Function Calling 定義群
      const functionDeclarations = [{
        name: 'search_character_library',
        description: '現在のストーリーに関連するキャラクターライブラリを検索し、候補一覧を返します。人物名、呼び方、作品タグ、特徴語から検索できます。',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: '調べたい人物名または特徴語。例: エミリア, ロズワール邸のメイド'
            }
          },
          required: ['query']
        }
      }, {
        name: 'get_character_profile',
        description: 'キャラクターライブラリから特定人物の詳細設定を取得します。search_character_library の結果を受けて使ってください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            characterId: {
              type: 'STRING',
              description: 'キャラクターID。search_character_library の結果から渡します。'
            },
            characterName: {
              type: 'STRING',
              description: '人物名。IDがない場合の補助。'
            }
          }
        }
      }, {
        name: 'search_lorebook',
        description: 'ワールドロアを検索し、該当しそうな設定候補を返します。地名、組織、制度、用語、事件、人物設定補助などに使えます。',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: '調べたい用語。例: 白鯨, 王選, ロズワール邸'
            },
            type: {
              type: 'STRING',
              description: '必要なら絞り込み。character, location, organization, term, event, item のいずれか。'
            },
            franchise: {
              type: 'STRING',
              description: '作品タグ。省略時は現在のストーリーの franchise を優先します。'
            }
          },
          required: ['query']
        }
      }, {
        name: 'get_lore_entry',
        description: 'ワールドロアから特定項目の詳細本文を取得します。search_lorebook の候補を受けて使ってください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            loreId: {
              type: 'STRING',
              description: 'ロアID。search_lorebook の結果から渡します。'
            },
            name: {
              type: 'STRING',
              description: 'ロア名。IDがない場合の補助。'
            },
            franchise: {
              type: 'STRING',
              description: '作品タグ。省略時は現在のストーリーの franchise を優先します。'
            }
          }
        }
      }, {
        name: 'search_web',
        description: 'Google Search を使って外部情報を確認します。ローカルのキャラクターライブラリやロアブックで不足する原作設定、周辺人物、所属、拠点、制度、時事的な事実確認に使ってください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: '検索クエリ。人物名や用語名だけで曖昧なら作品名も含める。例: エミリア Re:ゼロから始める異世界生活 陣営'
            },
            purpose: {
              type: 'STRING',
              description: '何を確認したいか。例: 同行者、所属陣営、拠点、制度の要点'
            },
            franchise: {
              type: 'STRING',
              description: '作品タグ。省略時は現在のストーリーの franchise を優先します。'
            }
          },
          required: ['query']
        }
      }, {
        name: 'update_session_lore',
        description: 'このセッション固有の進行記録を更新します。現在の状況、進行中のイベント、主人公との関係変化、今回の行動でのみ意味を持つ出来事、セッションで新しく生まれたオリジナルキャラクターや即興設定だけを記録してください。地名・組織名・作品世界の安定設定はここに入れません。',
        parameters: {
          type: 'OBJECT',
          properties: {
            summary: {
              type: 'STRING',
              description: '履歴圧縮後でも意味が通る「現在状況の要約」。2〜4文程度で、主人公が今どこで何をしているか、誰とどういう状態か、未解決の懸案は何かが単独で分かるように書く。単なる一行感想や単発イベント名ではなく、後から読んだAIが流れを復元できる粒度にする。'
            },
            current_state: {
              type: 'STRING',
              description: '現在の場面を1〜2文で要約。主人公が今どこで、誰と、何をしている最中かを簡潔に書く。'
            },
            open_threads: {
              type: 'ARRAY',
              description: '未解決の懸案、保留中の約束、今後回収すべき火種の一覧。解決済みの話題は含めない。',
              items: { type: 'STRING' }
            },
            recent_turning_points: {
              type: 'ARRAY',
              description: '最近起きた転換点や状況変化の一覧。直近数件に絞る。',
              items: { type: 'STRING' }
            },
            affinity_updates: {
              type: 'ARRAY',
              description: '登場人物と主人公の関係性の変更・好感度の更新リスト。',
              items: {
                type: 'OBJECT',
                properties: {
                  characterName: { type: 'STRING', description: '登場人物の名前（例: エミリア）' },
                  affinity: { type: 'INTEGER', description: '新しい好感度スコア (0-100)' },
                  notes: { type: 'STRING', description: '関係性の特徴や特記事項。' }
                },
                required: ['characterName', 'affinity']
              }
            },
            key_events: {
              type: 'ARRAY',
              description: '発生した重要な事件や獲得したフラグ、オリジナルアイテム。summary を支える箇条書きメモであり、summary の代わりにはしない。',
              items: { type: 'STRING' }
            }
          },
          required: ['summary']
        }
      }, {
        name: 'update_world_lore',
        description: '作品世界で安定している設定をワールドロア候補として提案します。地名、学校名、組織名、家名、居住地、制度、世界ルール、陣営、固有用語など、セッションをまたいでも有効な情報だけを扱います。名称は日本語の代表表記だけを使い、英語併記や括弧つき併記は避けてください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            entries: {
              type: 'ARRAY',
              description: '安定設定として保存したいワールドロア項目の一覧。',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'ロア項目名。例: 旭高校、ペンタゴン、王選、集英組' },
                  type: { type: 'STRING', description: 'character, location, organization, term, event, item のいずれか。' },
                  summary: { type: 'STRING', description: '一言で分かる概要。短く具体的に。' },
                  details: { type: 'STRING', description: '必要なら補足説明。任意。' },
                  speech: { type: 'STRING', description: '人物や組織の口調・特徴など。任意。' },
                  relationships: { type: 'STRING', description: '他項目との恒常的な関係。任意。' }
                },
                required: ['name', 'type', 'summary']
              }
            }
          },
          required: ['entries']
        }
      }];

      const tools = [];
      if (shouldOfferGoogleSearchForTurn) {
        tools.push({ googleSearch: {} });
      }
      if (functionDeclarations.length > 0) {
        tools.push({ functionDeclarations });
      }

      if (shouldOfferGoogleSearchForTurn) {
        try {
          const groundingMemo = await fetchGoogleSearchGroundingMemo({
            url,
            story,
            systemInstruction: runtimeSystemInstruction,
            selectedMessages,
            generationConfig,
            attemptController,
            usageAccumulator
          });
          if (groundingMemo) {
            runtimeSystemInstruction += `\n${groundingMemo}`;
          }
        } catch (groundingErr) {
          console.warn('[AI] Google Search grounding prepass failed. Continuing without injected memo.', groundingErr);
        }
      }

      let currentContents = [...contents];
      let extracted = { text: null, thought: null };
      const searchState = {
        usedCalls: 0,
        cache: new Map()
      };

      // ★ 追加：Function Calling 往復用のループ（AIがメモを更新して本文を書くまで最大3回まで往復する）
      for (let fcTurn = 0; fcTurn < 3; fcTurn++) {
        let googleSearchAllowedForRequest = shouldOfferGoogleSearchForTurn;
        let result = null;

        for (let requestVariant = 0; requestVariant < 2; requestVariant++) {
          const activeTools = googleSearchAllowedForRequest
            ? tools
            : tools.filter(tool => !tool.googleSearch);

          accumulatePromptDebug(usageAccumulator, {
            systemInstruction: runtimeSystemInstruction,
            contents: currentContents,
            tools: activeTools
          });
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: currentContents,
              systemInstruction: { parts: [{ text: runtimeSystemInstruction }] },
              generationConfig,
              tools: activeTools,
              toolConfig: googleSearchAllowedForRequest
                ? {
                  functionCallingConfig: { mode: 'VALIDATED' },
                  includeServerSideToolInvocations: true
                }
                : {
                  functionCallingConfig: { mode: 'AUTO' }
                }
            }),
            signal: attemptController.signal
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errMsg = errorData.error?.message || `HTTP status ${response.status}`;

            if (googleSearchAllowedForRequest && isQuotaLikeApiError(response.status, errMsg)) {
              console.warn('[AI] Google Search tool request hit quota-like error. Retrying without googleSearch.', errMsg);
              googleSearchAllowedForRequest = false;
              continue;
            }

            throw new Error(`Gemini API Error: ${errMsg}`);
          }

          result = await response.json();
          break;
        }

        if (!result) {
          throw new Error('Gemini API Error: response was empty after retry.');
        }

        addUsageMetadata(usageAccumulator, result?.usageMetadata);
        recordGroundingMetadata(usageAccumulator, result?.candidates?.[0]?.groundingMetadata);
        const hasBuiltInToolActivity = hasServerToolParts(result);
        if (hasBuiltInToolActivity) {
          usageAccumulator.serverToolRoundTrips = Number(usageAccumulator.serverToolRoundTrips || 0) + 1;
        }

        // Function Calling (update_session_lore) の呼び出し判定・実行
        const calls = result?.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];
        if (calls.length > 0) {
          try {
            const functionResponses = [];
            let storyChanged = false;

            for (const call of calls) {
              const name = call.functionCall.name;
              const args = call.functionCall.args || {};
              const functionCallId = call.functionCall.id;
              console.log(`[Function Call: ${name}]`, args);
              recordToolCall(usageAccumulator, name, args);

              if (name === 'search_character_library') {
                const result = await searchCharacterLibraryForStory(story, args);
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: result
                  }
                });
              } else if (name === 'get_character_profile') {
                const result = await getCharacterProfileForStory(story, args);
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: result
                  }
                });
              } else if (name === 'search_lorebook') {
                const result = await searchLorebookForStory(story, args);
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: result
                  }
                });
              } else if (name === 'get_lore_entry') {
                const result = await getLoreEntryForStory(story, args);
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: result
                  }
                });
              } else if (name === 'search_web') {
                const result = await searchWebForStory(story, args, usageAccumulator, searchState);
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: result
                  }
                });
              } else if (name === 'update_session_lore') {
                await applySessionLoreUpdate(args, story);
                storyChanged = true;
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: { result: 'success' }
                  }
                });
              } else if (name === 'update_world_lore') {
                const worldLoreResult = await applyWorldLoreUpdate(args, story);
                if (worldLoreResult.reroutedCount > 0 || worldLoreResult.queuedCount > 0) {
                  storyChanged = true;
                }
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: {
                      result: 'success',
                      queuedCount: worldLoreResult.queuedCount,
                      reroutedCount: worldLoreResult.reroutedCount
                    }
                  }
                });
              } else {
                functionResponses.push({
                  functionResponse: {
                    name,
                    id: functionCallId,
                    response: {
                      result: 'error',
                      message: `Unknown function: ${name}`
                    }
                  }
                });
              }
            }

            if (storyChanged) {
              import('./db.js').then(async db => {
                await db.saveStory(story);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                  setTimeout(() => {
                    const sidebarTab = document.getElementById('story-sidebar');
                    if (sidebarTab) {
                      import('./ui.js').then(ui => ui.renderSidebar());
                    }
                  }, 100);
                }
              });
            }

            const tmpExtracted = extractStoryTextAndThoughtFromApiResponse(result);
            if (tmpExtracted.text) {
              extracted = tmpExtracted;
              break;
            }

            currentContents.push(result.candidates[0].content);
            currentContents.push({
              role: 'user',
              parts: functionResponses
            });
            continue;
          } catch (fcErr) {
            console.warn('[Function Call] Failed to execute lore update:', fcErr);
          }
        }

        // 関数呼び出しがない場合は通常通り本文を抽出して終了
        extracted = extractStoryTextAndThoughtFromApiResponse(result);
        if (!extracted.text && hasBuiltInToolActivity && result?.candidates?.[0]?.content) {
          currentContents.push(result.candidates[0].content);
          continue;
        }
        break; 
      } // for loop end

      clearTimeout(timeoutId);
      mainController.signal.removeEventListener('abort', onMainAbort);

      if (!extracted.text) {
        throw new Error('有効なテキストが得られませんでした。');
      }

      updateState({ activeAbortController: null });
      const usage = publishUsageSnapshot(usageAccumulator);
      return { ...extracted, usage };

    } catch (err) {
      clearTimeout(timeoutId);
      mainController.signal.removeEventListener('abort', onMainAbort);

      if (mainController.signal.aborted) {
        updateState({ activeAbortController: null });
        throw new Error('ユーザーにより生成が中止されました。');
      }

      console.warn(`API call attempt ${attempt} failed:`, err);

      if (attempt >= maxRetries) {
        updateState({ activeAbortController: null });
        throw err;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  updateState({ activeAbortController: null });
  throw new Error('AI応答の生成が開始されませんでした。リトライ回数の設定を確認してください。');
}

/**
 * Fallback to read API key from localStorage if not in memory state.
 */
async function getApiKeyFromStorage() {
  return localStorage.getItem('zetatavern_api_key') || '';
}
/**
 * キャラクタープロフィールをGoogle検索経由で自動生成し、JSONで返す関数
 */
export async function generateCharacterProfile(name, category) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  const prompt = `
# キャラクタープロフィール生成 指示書

## 概要
このタスクは、単なるキャラクター解説記事を作るものではない。
目的は、AIによるロールプレイ・会話生成・人格再現を行うための「構造化キャラクターデータ」を生成することである。

対象キャラクター名: ${name}
${category ? `対象作品 / カテゴリー: ${category}` : ''}

生成するプロフィールは、以下の用途で利用される。
* AIチャット / キャラクターロールプレイ / シナリオ生成 / 会話生成 / 感情シミュレーション
そのため、単なる設定紹介ではなく、「どのように話すか」「何を嫌うか」「どう感情変化するか」「どんな人間関係を持つか」を重視して記述すること。

---

# 情報収集ルール
## 優先参照順位
1. 公式サイト  2. 原作  3. 信頼性の高いWiki  4. インタビュー・設定資料集  5. その他Web情報
## 禁止事項
以下を事実として扱わないこと： 二次創作設定 / ネタ画像・ミーム / Fanon（ファン解釈） / 明確な根拠のない考察 / AIの推測のみで補完した情報
## 情報不足時
不明な情報は無理に埋めず、「不明」「作中で明言なし」と記載する。

---
（以下、要求する出力内容の項目。これらを元に後のJSONを作成すること）
1. 基本プロファイル (Identity & Visuals)
年齢・役割、外見的特徴、性格タグ（5〜10個）、表の性格、裏の性格/本音、キャラクター崩壊になりやすい要素（過剰なデレなどAIが誤りやすい点）

2. 話し方と口調 (Speech Patterns)
一人称/二人称、口癖・語尾、トーン、会話テンポ、NGワード、NG行動

3. 代表的なセリフ集 (Dialogue Examples)
状況A：初対面で敵対している時 / 状況B：戦闘中・能力使用時 / 状況C：照れ・好意を隠している時 / 状況D：日常会話 / 状況E：パニック / 状況F：怒り / 状況G：弱みを見せる時
※各状況ごとに、感情・相手との距離感・実際のセリフをセットで記述。

4. 人間関係と行動原理 (Relationships & Motivation)
主人公への態度（時系列変化）、ユーザーへの適応方針（AIチャット時の立場）、関連人物との関係性、行動原理、恐れているもの

5. 特記事項 (Trivia & Deep Lore)
好物・趣味・弱点、日常習慣、感情トリガー、重要キーワード（3つ以上）

---

# 最終出力フォーマット（厳守）
上記の分析結果を踏まえ、システムに登録するためのデータを以下の JSON フォーマットで出力してください。Markdownのコードブロック（\`\`\`json ... \`\`\`）で囲むこと。必ず以下のキーを持つJSONオブジェクト1つを出力してください。

\`\`\`json
{
  "description": "【1. 基本プロファイル】【5. 特記事項】の内容をまとめた詳細な文章。",
  "personality": "【4. 人間関係と行動原理】の内容（行動原理、恐れているもの、関係性など）、および性格の詳細をまとめた文章。",
  "mes_example": "【2. 話し方と口調】【3. 代表的なセリフ集】を詳細にまとめた文章。セリフは必ず [キャラクター名] 「セリフ」 の形式を含めること。",
  "tags": ["特徴1", "特徴2", "特徴3"]
}
\`\`\`
`;

  const requestedModelName = appState.searchModelName || appState.modelName || DEFAULT_SEARCH_MODEL_NAME;
  const modelName = resolveSearchModelName(appState);
  const usageAccumulator = createUsageAccumulator('character-search', modelName);
  if (modelName !== requestedModelName) {
    console.log(`[Character Search] Switched model from ${requestedModelName} to ${modelName} for googleSearch support.`);
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  // 検索用のツールをONにし、JSON生成のため少しだけ温度を低め(0.7)に設定
  const generationConfig = { temperature: 0.7, topP: 0.9, maxOutputTokens: 8192 };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP status ${response.status}`);
  }

  const result = await response.json();
  addUsageMetadata(usageAccumulator, result?.usageMetadata);
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error('APIから有効なテキストが返されませんでした。');

  // thought（思考）部分を除外し、出力テキストだけを結合
  const text = parts.filter(p => !p.thought).map(p => p.text).join('\n').trim();

  // ```json の中身だけを正規表現でくり抜く
  const jsonMatch = text.match(/\`\`\`json\s*(\{[\s\S]*?\})\s*\`\`\`/);
  let parsed = null;

  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[1]); } catch (e) { }
  } else {
    try { parsed = JSON.parse(text); } catch (e) { }
  }

  if (!parsed) {
    console.error('AI Raw Response:', text);
    throw new Error('AIが正しいJSON形式で出力しませんでした。');
  }

  publishUsageSnapshot(usageAccumulator);
  return parsed;
}

/**
 * 原作知識・固有名詞をGoogle検索経由で要約収集し、構造化JSONで返す関数
 */
export async function generateLoreProfileFromSearch(name, franchise) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  const prompt = `
# 世界観設定 / 固有名詞ロアデータ生成 指示書

対象ワード: ${name}
対象作品・コンテキスト: ${franchise}

このワードについてGoogle検索を用いて原作の正確な設定情報を収集し、ZetaTavernロアブック用の構造化データを作成してください。
検索時は必ず「対象ワード」と「対象作品・コンテキスト」を組み合わせ、どの作品の何を調べるかを明確にしてください。
安易な捏造や無関係な作品の別単語との混同を避け、正確な原作知識を要約してください。
検索で原作の安定設定として確認できない場合、あるいはこのワードがセッション限定の出来事・オリジナルキャラクター・即興設定だと判断した場合は、登録しないでください。
普通名詞や一般語は登録禁止です。時間帯、日常行動、抽象概念、汎用アイテム名などは除外してください。

出力は以下のJSONフォーマット（Markdownの \`\`\`json ... \`\`\` コードブロックで囲む）で返してください。

\`\`\`json
{
  "shouldRegister": true,
  "canonicalName": "加護",
  "type": "character", // character, location, organization, term, event, item のいずれか一つ
  "summary": "【概要・設定要約】100文字〜200文字程度の簡単な紹介・定義文。",
  "profile": "【プロフィール詳細】外見、性格、戦闘能力、役割などの詳細な設定テキスト。",
  "speech": "【口調や特徴】セリフや話し方の傾向、一人称/二人称、特徴的な口癖など（もしあれば記載、なければ空欄）。",
  "relationships": "【人間関係・他者とのつながり】原作における他の主要キャラクターたちとのつながりや関係性（もしあれば記載、なければ空欄）。",
  "reason": ""
}
\`\`\`

ルール:
- canonicalName には日本語の代表表記だけを書くこと。英語名や括弧つき併記は禁止。
- 原作上の安定設定として確認できない場合は shouldRegister を false にし、summary 等は空欄で reason に理由を書くこと。
- セッション固有情報やオリジナルキャラクターを原作設定として捏造してはいけません。
- 次のような一般語は shouldRegister を false にしてください: 放課後, アクセサリー, 知的生命体, 勉強, 会話。
- 検索対象が曖昧なら、対象作品・コンテキストを優先して判定してください。例: 「白鯨」だけでなく「Re:ゼロから始める異世界生活 の 白鯨」として扱うこと。
- summary / profile / speech / relationships には引用番号や脚注表記（[1], [1, 2] など）を書かないこと。
- summary / profile / speech / relationships はユーザーへの説明文ではなく、ロアブックにそのまま保存できる設定文として書くこと。
- 文体は簡潔で硬めの常体に統一すること。基本は「〜である」「〜とされる」「〜を指す」などを使い、「〜です」「〜となっています」は避けること。
`;

  const requestedModelName = appState.searchModelName || appState.modelName || DEFAULT_SEARCH_MODEL_NAME;
  const searchModelName = resolveSearchModelName(appState);
  const usageAccumulator = createUsageAccumulator('lore-search', searchModelName);
  if (searchModelName !== requestedModelName) {
    console.log(`[Lore Search] Switched model from ${requestedModelName} to ${searchModelName} for googleSearch support.`);
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${searchModelName}:generateContent?key=${apiKey}`;
  const generationConfig = { temperature: 0.5, topP: 0.9, maxOutputTokens: 4096 };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP status ${response.status}`);
  }

  const result = await response.json();
  addUsageMetadata(usageAccumulator, result?.usageMetadata);
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error('APIから有効なテキストが返されませんでした。');

  const text = parts.filter(p => !p.thought).map(p => p.text).join('\n').trim();
  const jsonMatch = text.match(/\`\`\`json\s*(\{[\s\S]*?\})\s*\`\`\`/);
  let parsed = null;

  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[1]); } catch (e) { }
  } else {
    try { parsed = JSON.parse(text); } catch (e) { }
  }

  if (!parsed) {
    console.error('AI Raw Response:', text);
    throw new Error('AIが正しいJSON形式で出力しませんでした。');
  }

  publishUsageSnapshot(usageAccumulator);
  return {
    shouldRegister: parsed.shouldRegister !== false,
    canonicalName: normalizeLoreEntryName(parsed.canonicalName || name),
    type: normalizeLoreType((parsed.type || '').trim()),
    summary: sanitizeLoreText(parsed.summary || ''),
    profile: sanitizeLoreText(parsed.profile || ''),
    speech: sanitizeLoreText(parsed.speech || ''),
    relationships: sanitizeLoreText(parsed.relationships || ''),
    reason: stripLoreCitations(parsed.reason || '').trim()
  };
}
