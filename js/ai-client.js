/**
 * ai-client.js - ZetaTavern AI Integration
 * Constructs character-aware dynamic prompts and manages Gemini API calls with retries & timeouts.
 */

import { getState, updateState } from './state.js'; // ★ updateState のインポートを追加
import { getCharacter, getLoreByNameAndFranchise, saveLore, getCharacters } from './db.js';
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
const FULL_CHARACTER_CONTEXT_INTERVAL = 5;

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
  return completedModelTurns === 0 || completedModelTurns % FULL_CHARACTER_CONTEXT_INTERVAL === 0;
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
    historyTurnLimit: null,
    omittedTurns: 0
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
      historyTurnLimit: accumulator.historyTurnLimit,
      omittedTurns: accumulator.omittedTurns || 0,
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

async function applySessionLoreUpdate(args, story) {
  if (!story.session_lore) story.session_lore = { summary: '', key_events: [] };
  if (args.summary) {
    story.session_lore.summary = args.summary;
    story.session_lore.summary_source = 'ai';
  }
  if (args.key_events) {
    story.session_lore.key_events = mergeSessionLoreEvents(story.session_lore.key_events || [], args.key_events);
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
        if (!story.session_lore) story.session_lore = { summary: '', key_events: [] };
        const sessionNote = buildSessionLoreNote(entry, name, summary);
        story.session_lore.key_events = mergeSessionLoreEvents(story.session_lore.key_events || [], [sessionNote]);
        reroutedCount++;
      }
      continue;
    }

    if (shouldRouteWorldLoreEntryToSession(entry, existing, characterMatch)) {
      if (!story.session_lore) story.session_lore = { summary: '', key_events: [] };
      const sessionNote = buildSessionLoreNote(entry, name, summary);
      story.session_lore.key_events = mergeSessionLoreEvents(story.session_lore.key_events || [], [sessionNote]);
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
  instruction += `3. **誘導（ナッジ）によるテンポ管理**: 会話や場面の区切りでは、強制的なシーン切り替えではなく「窓の外は夕闇に染まっていた――」のように情景や空気感の変化を描写し、次へ進むべきタイミングをユーザーに誘導（提案）すること。\n`;
  instruction += `4. **判断の余白**: 一度の出力で事態を勝手に解決・完結させず、主人公が次のターンで介入・選択できる明確な「余白」を残した時点で出力を止める（ターンの制御）。\n\n`;
  // ★ ここに追加
  instruction += `5. **主人公の不可侵性（アンタッチャブル）**: 主人公の「セリフ」「行動」「思考」「感情」はすべてユーザーが決定する。AIが主人公の言動や判断を勝手に捏造・代行することは絶対に禁止する。\n`;
  instruction += `6. **ナレーターの視点制限（カメラ視点）**: 地の文は、外から観測可能な事実（情景、NPCの表情や行動など）のみを描写するカメラに徹すること。主人公の内心（何を考え、何を感じ、何を理解したか）を勝手に代弁・描写してはならない。「主人公は〇〇と理解した」「不快感はなかった」等の心理解釈は固く禁ずる。\n\n`;
  // ★ 追加：検索ツールの強制使用ルール
  instruction += `【重要：世界観の正確な描写と検索ツールの使用】\n`;
  instruction += `実在の作品名（アニメ、漫画等）をベースにした世界観の場合、安易にオリジナルの敵、魔法、地名、設定を捏造してはいけません。\n`;
  instruction += `登場人物、モンスター、専門用語などを物語に出す際は、**必ずGoogle検索ツールを使用して原作の正確な情報を取得・参照**し、原作に忠実な展開を行ってください。\n\n`;
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
      instruction += `※ このターンは軽量モードです。詳細なキャラクター設定全文は省略し、名前と要点のみを再掲します。口調や関係性は直近の文脈と過去のフル更新ターンを維持してください。\n\n`;
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
    instruction += `【これまでのストーリー進行・獲得フラグ（長期記憶）】\n`;
    if (story.session_lore.summary) {
      instruction += `・全体状況/あらすじ: ${story.session_lore.summary}\n`;
    }
    if (story.session_lore.key_events && story.session_lore.key_events.length > 0) {
      instruction += `・主要イベント・獲得フラグ:\n`;
      story.session_lore.key_events.forEach(ev => {
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

  instruction += `【ロア分類ルール】\n`;
  instruction += `- セッションロア: このセッションで起きた出来事、現在の進行状況、主人公との関係変化、今回の行動でのみ意味を持つ情報。\n`;
  instruction += `- セッションで新しく生まれたオリジナルキャラクター、今回限りの役職、即興の設定はセッションロア側に入れること。\n`;
  instruction += `- ワールドロア: 作品世界で安定している固有設定。地名、学校名、組織名、家名、居住地、制度、陣営、用語、世界のルールなど。\n`;
  instruction += `- ワールドロアの名称は日本語の代表表記で登録すること。英語併記や括弧つき併記はしないこと。例: Protection(加護) ではなく 加護。\n`;
  instruction += `- 一時的な出来事や関係の変動をワールドロアへ入れないこと。\n`;
  instruction += `- 逆に、作品全体で共有される安定設定をセッションロアの要点として消費しないこと。\n\n`;
  instruction += `- 大きな出来事、関係性の変化、新規オリジナル人物の登場があったターンでは、本文を書く前に update_session_lore を優先して呼ぶこと。\n`;
  instruction += `- update_world_lore は安定設定だけに使い、セッション情報の代用にしないこと。\n`;
  instruction += `- update_world_lore は「確定登録」ではなく「ワールドロア候補の提案」として扱われる。安定設定だと強く判断できるものだけを提案すること。\n\n`;

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

/** UIの思考レベル設定から、API送信用の Thinking Budget 数値を決定する */
function buildThinkingConfig(thinkingLevel, modelName) {
  const m = (modelName || '').toLowerCase();

  // Gemma 系や古い非対応モデルでは Thinking 要約を要求しない
  if (!m.includes('gemini') || m.includes('gemma') || m.includes('1.5') || (m.includes('2.0') && !m.includes('thinking'))) {
    return null;
  }

  if (thinkingLevel === 'none') {
    return null;
  }

  // Gemini 3 系は thinkingLevel を優先する
  if (/gemini-3(?:[.-]|$)/.test(m)) {
    let level = 'medium';
    if (thinkingLevel === 'minimal') {
      level = 'minimal';
    } else if (thinkingLevel === 'high') {
      level = 'high';
    }
    return {
      includeThoughts: true,
      thinkingLevel: level
    };
  }

  let budget = 1024; // Gemini 2.5 系の標準
  if (thinkingLevel === 'minimal') {
    budget = 512;
  } else if (thinkingLevel === 'high') {
    budget = 4096;
  }

  return {
    includeThoughts: true,
    thinkingBudget: budget
  };
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
  const historyTurnLimit = Number.isFinite(Number(appState.historyTurnLimit)) ? Number(appState.historyTurnLimit) : 10;
  const { selectedMessages, omittedTurns } = selectPromptMessages(story.messages || [], historyTurnLimit);
  usageAccumulator.historyTurnLimit = historyTurnLimit;
  usageAccumulator.omittedTurns = omittedTurns;
  const systemInstruction = await buildSystemInstruction(story, { omittedTurns, historyTurnLimit });

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
  const thinkingLevel = appState.thinkingLevel || 'standard';
  const thinkingConfig = buildThinkingConfig(thinkingLevel, modelName);
  if (thinkingConfig) {
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
      // ★ 変更：Google検索ツールを外し、Function Calling専用にする
      const tools = [];

      // update_session_lore ツールを追加定義 (AIがセッション情報を更新するためのツール)
      tools.push({
        functionDeclarations: [{
          name: 'update_session_lore',
          description: 'このセッション固有の進行記録を更新します。現在の状況、進行中のイベント、主人公との関係変化、今回の行動でのみ意味を持つ出来事、セッションで新しく生まれたオリジナルキャラクターや即興設定だけを記録してください。地名・組織名・作品世界の安定設定はここに入れません。',
          parameters: {
            type: 'OBJECT',
            properties: {
              summary: {
                type: 'STRING',
                description: '今までのストーリーのあらすじ、進行状況、または重要なマイルストーンの更新。'
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
                description: '発生した重要な事件や獲得したフラグ、オリジナルアイテム。',
                items: { type: 'STRING' }
              }
            }
          }
        }]
      });

      tools.push({
        functionDeclarations: [{
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
        }]
      });

      let currentContents = [...contents];
      let extracted = { text: null, thought: null };

      // ★ 追加：Function Calling 往復用のループ（AIがメモを更新して本文を書くまで最大3回まで往復する）
      for (let fcTurn = 0; fcTurn < 3; fcTurn++) {
        accumulatePromptDebug(usageAccumulator, {
          systemInstruction,
          contents: currentContents,
          tools
        });
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: currentContents,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig,
            tools,
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
          }),
          signal: attemptController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errMsg = errorData.error?.message || `HTTP status ${response.status}`;
          throw new Error(`Gemini API Error: ${errMsg}`);
        }

        const result = await response.json();
        addUsageMetadata(usageAccumulator, result?.usageMetadata);

        // Function Calling (update_session_lore) の呼び出し判定・実行
        const calls = result?.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || [];
        if (calls.length > 0) {
          try {
            const functionResponses = [];
            let storyChanged = false;

            for (const call of calls) {
              const name = call.functionCall.name;
              const args = call.functionCall.args || {};
              console.log(`[Function Call: ${name}]`, args);

              if (name === 'update_session_lore') {
                await applySessionLoreUpdate(args, story);
                storyChanged = true;
                functionResponses.push({
                  functionResponse: {
                    name,
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
                    response: {
                      result: 'success',
                      queuedCount: worldLoreResult.queuedCount,
                      reroutedCount: worldLoreResult.reroutedCount
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
            } else {
               currentContents.push(result.candidates[0].content);
               currentContents.push({
                 role: 'user',
                 parts: functionResponses
               });
               continue;
            }
          } catch (fcErr) {
            console.warn('[Function Call] Failed to execute lore update:', fcErr);
          }
        }

        // 関数呼び出しがない場合は通常通り本文を抽出して終了
        extracted = extractStoryTextAndThoughtFromApiResponse(result);
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
