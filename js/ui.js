/**
 * ui.js - ZetaTavern UI Rendering & DOM Events
 * Controls screen views, renders stories (novel / chat mode with per-character bubbles),
 * handles settings/character libraries, and parses AI-generated A/B/C options.
 */

import { getState, updateState, setActiveStory } from './state.js';
import * as db from './db.js';
import { sanitizeHTML, escapeHTML } from './sanitizer.js';
import { generateCharacterProfile, generateLoreProfileFromSearch, normalizeLoreEntryName } from './ai-client.js?v=20260614a';
import { isCharacterMatchingStory, getStoryScopedCharacters, getStoryCharacterIds, buildStoryCharacterRefs } from './story-characters.js';

// ====== AIディレクタープリセットデータ ======
export const DIRECTOR_PRESETS = {
  romcom_subtle: {
    label: "🌸 微炭酸ラブコメ",
    description: "感情の秘匿と繊細な距離感の変動を楽しむ日常系",
    params: { momentum: 40, autonomy: 80, worldTone: 10, backgroundTension: 0, romanticVisibility: 20, relationshipDrift: 60, intrusionRate: 0 }
  },
  dark_suspense: {
    label: "💀 ダークサスペンス",
    description: "常に死や裏切りの気配が漂う、不穏な群像劇",
    params: { momentum: 70, autonomy: 90, worldTone: 90, backgroundTension: 90, romanticVisibility: 10, relationshipDrift: 80, intrusionRate: 60 }
  },
  battle_shounen: {
    label: "🔥 異能バトル",
    description: "日常と非日常が交錯し、劇的な事件が連続する展開",
    params: { momentum: 85, autonomy: 60, worldTone: 50, backgroundTension: 50, romanticVisibility: 40, relationshipDrift: 40, intrusionRate: 90 }
  },
  cozy_slice_of_life: {
    label: "🍵 ほのぼの日常",
    description: "大きな事件は起きない、徹底的に平和で優しい世界",
    params: { momentum: 20, autonomy: 60, worldTone: 0, backgroundTension: 0, romanticVisibility: 30, relationshipDrift: 20, intrusionRate: 0 }
  }
};

const DIRECTOR_PARAMS = [
  { id: 'momentum', label: '展開の推進力', minLabel: '受動的・日常', maxLabel: '能動的・劇的' },
  { id: 'autonomy', label: 'NPCの自律性', minLabel: '主人公フォーカス', maxLabel: '独立した群像劇' },
  { id: 'worldTone', label: '世界の温度', minLabel: '優しい・甘め', maxLabel: 'シビア・残酷' },
  { id: 'backgroundTension', label: '不穏さ・緊張感', minLabel: '平和・安心', maxLabel: '常に張り詰める' },
  { id: 'romanticVisibility', label: '恋愛・好意の露出', minLabel: '秘匿・行間', maxLabel: '直接的・露骨' },
  { id: 'relationshipDrift', label: '関係性の変動幅', minLabel: '固定的・安定', maxLabel: '疑心暗鬼・急接近' },
  { id: 'intrusionRate', label: '非日常の侵入頻度', minLabel: '平穏な連続', maxLabel: '唐突な事件・異変' }
];
// ===========================================

const blobUrlCache = new Map();

function normalizeSessionLoreEventForDisplay(event) {
  if (typeof event === 'string') return event.trim();
  if (event == null) return '';
  if (typeof event === 'number' || typeof event === 'boolean') return String(event);
  if (typeof event === 'object') {
    const candidates = [event.text, event.summary, event.title, event.name, event.label, event.event];
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

function normalizeLoreSyncFranchises(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim() || '共通')
      .filter(Boolean)
  )];
}

function requestDropboxAutoSync(storyId = null, options = {}) {
  const hasExplicitScope =
    options.syncStory !== undefined ||
    options.syncLores !== undefined ||
    options.syncCharacters !== undefined;
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  window.dispatchEvent(new CustomEvent('dropbox-auto-sync-request', {
    detail: {
      storyId: storyId || null,
      forceFull: !!options.forceFull,
      syncStory: hasExplicitScope ? !!options.syncStory : !!storyId,
      syncLores: !!options.syncLores,
      syncCharacters: !!options.syncCharacters,
      characterIds: Array.isArray(options.characterIds) ? options.characterIds.filter(Boolean) : [],
      assetIds: Array.isArray(options.assetIds) ? options.assetIds.filter(Boolean) : [],
      loreFranchises: normalizeLoreSyncFranchises(options.loreFranchises)
    }
  }));
}

function createEmptySyncTombstones() {
  return {
    stories: {},
    characters: {},
    lores: {},
    assets: {}
  };
}

async function recordSyncTombstone(type, id, meta = {}) {
  if (!type || !id) return;
  const current = await db.getSetting('dropbox_sync_tombstones', createEmptySyncTombstones());
  const next = {
    stories: current?.stories && typeof current.stories === 'object' ? current.stories : {},
    characters: current?.characters && typeof current.characters === 'object' ? current.characters : {},
    lores: current?.lores && typeof current.lores === 'object' ? current.lores : {},
    assets: current?.assets && typeof current.assets === 'object' ? current.assets : {}
  };
  if (!next[type]) next[type] = {};
  next[type][id] = {
    deletedAt: Date.now(),
    ...meta
  };
  await db.saveSetting('dropbox_sync_tombstones', next);
}

function formatUsageNumber(value) {
  return Number(value || 0).toLocaleString('ja-JP');
}

function formatUsageTypeLabel(requestType) {
  const labels = {
    story: 'ストーリー生成',
    'character-search': 'キャラクター検索',
    'lore-search': 'ロア検索'
  };
  return labels[requestType] || requestType || 'API';
}

function formatToolCallLabel(name) {
  const labels = {
    search_character_library: 'キャラ検索',
    get_character_profile: 'キャラ詳細',
    search_lorebook: 'ロア検索',
    get_lore_entry: 'ロア詳細',
    search_web: 'Web検索',
    update_session_lore: 'セッション更新',
    update_world_lore: 'ワールド候補'
  };
  return labels[name] || name || 'tool';
}

function formatSearchProviderLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'google') return 'Google';
  if (normalized === 'tavily') return 'Tavily';
  if (normalized === 'duckduckgo') return 'DuckDuckGo';
  if (normalized === 'off') return 'OFF';
  return 'Auto';
}

export function renderApiUsagePanel() {
  const panel = document.getElementById('api-usage-panel');
  if (!panel) return;

  const { lastApiUsage, promptDebugEnabled } = getState();
  if (!promptDebugEnabled || !lastApiUsage) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const timestampText = new Date(lastApiUsage.timestamp || Date.now()).toLocaleTimeString('ja-JP');
  const chips = [
    `入力 ${formatUsageNumber(lastApiUsage.promptTokenCount)}`,
    `出力 ${formatUsageNumber(lastApiUsage.candidatesTokenCount)}`
  ];
  if (lastApiUsage.thoughtsTokenCount > 0) chips.push(`Thinking ${formatUsageNumber(lastApiUsage.thoughtsTokenCount)}`);
  if (lastApiUsage.totalTokenCount > 0) chips.push(`合計 ${formatUsageNumber(lastApiUsage.totalTokenCount)}`);
  if (lastApiUsage.requestCount > 1) chips.push(`API往復 ${formatUsageNumber(lastApiUsage.requestCount)}`);

  panel.innerHTML = `
    <div class="api-usage-panel-header">
      <span class="material-symbols-outlined">monitoring</span>
      <strong>直近のトークン使用量</strong>
      <span class="api-usage-panel-meta">${escapeHTML(formatUsageTypeLabel(lastApiUsage.requestType))} / ${escapeHTML(lastApiUsage.modelName || 'unknown')} / ${escapeHTML(timestampText)}</span>
    </div>
    <div class="api-usage-chip-row">
      ${chips.map(text => `<span class="api-usage-chip">${escapeHTML(text)}</span>`).join('')}
    </div>
    ${lastApiUsage.debug?.breakdown?.length ? `
      <details class="api-usage-debug-details">
        <summary>入力内訳デバッグ</summary>
        <div class="api-usage-debug-meta">
          <span>入力文字数 ${formatUsageNumber(lastApiUsage.debug.promptTotalChars)}</span>
          <span>System ${formatUsageNumber(lastApiUsage.debug.systemInstructionChars)}</span>
          <span>会話 ${formatUsageNumber(lastApiUsage.debug.conversationChars)}</span>
          <span>Schema ${formatUsageNumber(lastApiUsage.debug.toolSchemaChars)}</span>
          <span>Thinking ${escapeHTML(lastApiUsage.debug.thinkingConfigLabel || 'なし')}</span>
          <span>Web検索 ${escapeHTML(formatSearchProviderLabel(lastApiUsage.debug.searchProviderLabel || 'auto'))}</span>
          <span>Web検索 利用可能 ${lastApiUsage.debug.googleSearchAvailable ? 'ON' : 'OFF'}</span>
          <span>サーバーツール往復 ${formatUsageNumber(lastApiUsage.debug.serverToolRoundTrips || 0)}</span>
          <span>履歴圧縮 ${lastApiUsage.debug.historyCompressionEnabled === false ? 'OFF' : 'ON'}</span>
          <span>履歴制限 ${lastApiUsage.debug.historyCompressionEnabled === false || lastApiUsage.debug.historyTurnLimit === 0 ? '全履歴' : `${formatUsageNumber(lastApiUsage.debug.historyTurnLimit)}ターン`}</span>
          <span>省略 ${formatUsageNumber(lastApiUsage.debug.omittedTurns || 0)}ターン</span>
        </div>
        ${(lastApiUsage.debug.stageStatus?.search || lastApiUsage.debug.stageStatus?.synthesis) ? `
          <div class="api-usage-debug-meta">
            <span>処理段階</span>
          </div>
          <div class="api-usage-chip-row">
            ${['search', 'synthesis'].map(stageName => {
              const stage = lastApiUsage.debug.stageStatus?.[stageName];
              if (!stage) return '';
              const label = stageName === 'search' ? '検索段階' : '整形段階';
              const phase = stage.phase || 'unknown';
              const provider = stage.provider ? ` / ${formatSearchProviderLabel(stage.provider)}` : '';
              const model = stage.modelName ? ` / ${stage.modelName}` : '';
              const status = Number(stage.status || 0) > 0 ? ` / HTTP ${stage.status}` : '';
              const kind = stage.failureKind ? ` / ${stage.failureKind}` : '';
              const queryCount = Number(stage.groundingQueryCount || 0) > 0 ? ` / query ${formatUsageNumber(stage.groundingQueryCount)}` : '';
              const finishReason = stage.finishReason ? ` / finish ${stage.finishReason}` : '';
              const candidateCount = Number(stage.candidateCount || 0) > 0 ? ` / candidates ${formatUsageNumber(stage.candidateCount)}` : '';
              const rawText = Number(stage.rawTextLength || 0) > 0 ? ` / raw ${formatUsageNumber(stage.rawTextLength)}` : '';
              const extractedText = Number(stage.extractedTextLength || 0) > 0 ? ` / text ${formatUsageNumber(stage.extractedTextLength)}` : '';
              const groundingMeta = stage.hasGroundingMetadata ? ' / groundingMeta' : '';
              const serverTools = stage.hasServerToolParts ? ' / serverTools' : '';
              return `<span class="api-usage-chip">${escapeHTML(`${label}: ${phase}${provider}${model}${status}${kind}${queryCount}${candidateCount}${finishReason}${rawText}${extractedText}${groundingMeta}${serverTools}`)}</span>`;
            }).join('')}
          </div>
          ${['search', 'synthesis'].some(stageName => {
            const stage = lastApiUsage.debug.stageStatus?.[stageName];
            return stage?.message || (Array.isArray(stage?.partKinds) && stage.partKinds.length > 0);
          }) ? `
            <div class="api-usage-chip-row">
              ${['search', 'synthesis'].map(stageName => {
                const stage = lastApiUsage.debug.stageStatus?.[stageName];
                const parts = Array.isArray(stage?.partKinds) && stage.partKinds.length > 0
                  ? `${stageName === 'search' ? '検索' : '整形'} parts: ${stage.partKinds.join(', ')}`
                  : '';
                if (!stage?.message && !parts) return '';
                const label = stageName === 'search' ? '検索' : '整形';
                return `
                  ${stage?.message ? `<span class="api-usage-chip">${escapeHTML(`${label}: ${stage.message}`)}</span>` : ''}
                  ${parts ? `<span class="api-usage-chip">${escapeHTML(parts)}</span>` : ''}
                `;
              }).join('')}
            </div>
          ` : ''}
        ` : ''}
        ${lastApiUsage.debug.toolCalls?.length ? `
          <div class="api-usage-debug-meta">
            <span>参照/更新ツール ${formatUsageNumber(lastApiUsage.debug.toolCalls.reduce((sum, item) => sum + Number(item.count || 0), 0))}回</span>
          </div>
          <div class="api-usage-chip-row">
            ${lastApiUsage.debug.toolCalls.map(item => {
              const label = formatToolCallLabel(item.name);
              const preview = item.preview ? `: ${item.preview}` : '';
              const count = Number(item.count || 0) > 1 ? ` x${formatUsageNumber(item.count)}` : '';
              return `<span class="api-usage-chip">${escapeHTML(`${label}${preview}${count}`)}</span>`;
            }).join('')}
          </div>
        ` : `
          <div class="api-usage-debug-meta">
            <span>参照/更新ツール 0回</span>
          </div>
        `}
        ${lastApiUsage.debug.groundingQueries?.length ? `
          <div class="api-usage-debug-meta">
            <span>Google検索クエリ ${formatUsageNumber(lastApiUsage.debug.groundingQueries.length)}件</span>
          </div>
          <div class="api-usage-chip-row">
            ${lastApiUsage.debug.groundingQueries.map(query => `
              <span class="api-usage-chip">${escapeHTML(`検索: ${query}`)}</span>
            `).join('')}
          </div>
        ` : ''}
        ${lastApiUsage.debug.searchErrors?.length ? `
          <div class="api-usage-debug-meta">
            <span>検索失敗 ${formatUsageNumber(lastApiUsage.debug.searchErrors.reduce((sum, item) => sum + Number(item.count || 0), 0))}件</span>
          </div>
          <div class="api-usage-chip-row">
            ${lastApiUsage.debug.searchErrors.map(item => {
              const providerLabel = formatSearchProviderLabel(item.provider || 'auto');
              const preview = item.query ? `: ${item.query}` : '';
              const status = Number(item.status || 0) > 0 ? ` / HTTP ${item.status}` : '';
              const model = item.modelName ? ` / ${item.modelName}` : '';
              const stage = item.stage ? ` / ${item.stage}` : '';
              const kind = item.failureKind ? ` / ${item.failureKind}` : '';
              const count = Number(item.count || 0) > 1 ? ` x${formatUsageNumber(item.count)}` : '';
              return `<span class="api-usage-chip">${escapeHTML(`${providerLabel}${preview}${model}${status}${stage}${kind} - ${item.message || '検索失敗'}${count}`)}</span>`;
            }).join('')}
          </div>
        ` : ''}
        <div class="api-usage-debug-list">
          ${lastApiUsage.debug.breakdown.slice(0, 12).map(item => `
            <div class="api-usage-debug-row">
              <span class="api-usage-debug-label">${escapeHTML(item.label)}</span>
              <span class="api-usage-debug-value">${formatUsageNumber(item.chars)} chars / 推定 ${formatUsageNumber(item.estimatedPromptTokens)} tokens</span>
            </div>
          `).join('')}
        </div>
      </details>
    ` : ''}
  `;
  panel.classList.remove('hidden');
}

export async function getAvatarUrl(assetId) {
  if (!assetId) return 'assets/default-silhouette.png';
  if (blobUrlCache.has(assetId)) return blobUrlCache.get(assetId);
  try {
    const blob = await db.getAssetBlob(assetId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      blobUrlCache.set(assetId, url);
      return url;
    }
  } catch (err) {
    console.error('Error fetching asset blob for avatar:', err);
  }
  return 'assets/default-silhouette.png';
}

export function clearBlobUrlCache() {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
  blobUrlCache.clear();
}

function normalizeStoryImageBaseUrl(value) {
  return (value || '').trim().replace(/\/+$/, '');
}

function normalizeStoryImageTokenPart(value) {
  return (value || '').trim().replace(/^['"]|['"]$/g, '');
}

function hasImageFileExtension(value) {
  return /\.[a-z0-9]{2,5}$/i.test(value || '');
}

function parseStoryImageToken(rawValue) {
  const payload = normalizeStoryImageTokenPart(rawValue);
  if (!payload) return null;

  if (/^https?:\/\//i.test(payload)) {
    return { raw: payload, url: payload };
  }

  const parts = payload.split('|').map(normalizeStoryImageTokenPart).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { raw: payload, assetName: parts[0] };
  if (parts.length === 2) {
    return { raw: payload, characterName: parts[0], assetName: parts[1] };
  }

  return {
    raw: payload,
    characterName: parts[0],
    outfitName: parts[1],
    assetName: parts.slice(2).join('|')
  };
}

function parseStoryImageInstructionLine(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;

  const tokenMatch = trimmed.match(/^@img:\s*(.+)$/i);
  if (tokenMatch) {
    return parseStoryImageToken(tokenMatch[1]);
  }

  const htmlImgMatch = trimmed.match(/^<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>$/i);
  if (htmlImgMatch) {
    return parseStoryImageToken(htmlImgMatch[1]);
  }

  const markdownImgMatch = trimmed.match(/^!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)$/);
  if (markdownImgMatch) {
    return parseStoryImageToken(markdownImgMatch[1]);
  }

  return null;
}

function resolveStoryImageSpec(token, story) {
  if (!token) return null;

  if (token.url) {
    if (!/^https?:\/\//i.test(token.url)) return null;
    return {
      url: token.url,
      alt: token.characterName || token.assetName || 'story image'
    };
  }

  const baseUrl = normalizeStoryImageBaseUrl(story?.imageBaseUrl);
  const assetName = normalizeStoryImageTokenPart(token.assetName);
  if (!baseUrl || !assetName) return null;

  const outfitName = normalizeStoryImageTokenPart(token.outfitName || story?.imageDefaultOutfit);
  const fileName = hasImageFileExtension(assetName) ? assetName : `${assetName}.avif`;
  const urlParts = [baseUrl];
  if (token.characterName) urlParts.push(encodeURIComponent(token.characterName));
  if (outfitName) urlParts.push(encodeURIComponent(outfitName));
  urlParts.push(encodeURIComponent(fileName));

  return {
    url: urlParts.join('/'),
    alt: [token.characterName, outfitName, assetName].filter(Boolean).join(' ')
  };
}

function createStoryImageElement(token, story, className = 'story-inline-image') {
  const resolved = resolveStoryImageSpec(token, story);
  if (!resolved?.url) return null;

  const wrapper = document.createElement('div');
  wrapper.className = className;

  const img = document.createElement('img');
  img.src = resolved.url;
  img.alt = resolved.alt || 'story image';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => wrapper.remove();

  wrapper.appendChild(img);
  return wrapper;
}

function stripStoryImageTokenLines(text) {
  const tokens = [];
  const cleanedLines = [];
  for (const line of (text || '').split('\n')) {
    const token = parseStoryImageInstructionLine(line);
    if (token) {
      if (token) tokens.push(token);
      continue;
    }
    cleanedLines.push(line);
  }
  return {
    cleanedText: cleanedLines.join('\n').trim(),
    tokens
  };
}

export function parseChoices(text) {
  if (!text) return { bodyText: '', choices: [] };
  const choices = [];
  const choiceLineRegex = /^\s*(?:[-*・►▶▷>]\s*)?([A-CＡ-Ｃ])\s*[\.\):：）．、]\s*(.+?)\s*$/gm;
  const matches = [...text.matchAll(choiceLineRegex)];
  if (matches.length >= 2) {
    for (const match of matches) {
      const label = match[1].replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C');
      choices.push({ label, text: match[2].trim() });
    }
    const bodyText = text
      .replace(choiceLineRegex, '')
      .replace(/^\s*(?:#{1,6}\s*)?(?:[-=_─━]{3,}|選択肢|Choices?)\s*$/gmi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { bodyText, choices };
  }
  return { bodyText: text, choices: [] };
}

export function parseModelOutputToSegments(text) {
  if (!text) return [{ type: 'narration', text: '' }];
  const lines = text.split('\n');
  const segments = [];
  let currentDialogue = null;
  let narrationBuffer = [];
  let pendingImage = null;

  const consumePendingImage = () => {
    const image = pendingImage;
    pendingImage = null;
    return image;
  };

  const flushNarration = () => {
    const joined = narrationBuffer.join('\n').trim();
    if (joined) segments.push({ type: 'narration', text: joined, image: consumePendingImage() });
    narrationBuffer = [];
  };

  const flushDialogue = () => {
    if (currentDialogue && currentDialogue.lines.length > 0) {
      if (!currentDialogue.image) currentDialogue.image = consumePendingImage();
      segments.push(currentDialogue);
    }
    currentDialogue = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const token = parseStoryImageInstructionLine(trimmed);
    if (token) {
      if (token) pendingImage = token;
      continue;
    }

    // 【環境描写】の抽出
    const envMatch = trimmed.match(/^【(.+)】$/);
    if (envMatch) {
      flushNarration();
      flushDialogue();
      segments.push({ type: 'narration', text: `【${envMatch[1]}】`, image: consumePendingImage() });
      continue;
    }

    // **地の文** の抽出
    const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
    if (boldMatch) {
      flushNarration();
      flushDialogue();
      segments.push({ type: 'narration', text: boldMatch[1], image: consumePendingImage() });
      continue;
    }

    // 既存の *アクション* (過去ログ互換用)
    const isAction = /^\*(.+)\*$/.test(trimmed) || /^＊(.+)＊$/.test(trimmed);
    if (isAction && !boldMatch) {
      const actionText = trimmed.replace(/^\*|\*$/g, '').replace(/^＊|＊$/g, '').trim();
      if (currentDialogue) {
        currentDialogue.lines.push({ kind: 'action', text: actionText });
      } else {
        flushNarration();
        segments.push({ type: 'narration', text: `*${actionText}*`, image: consumePendingImage() });
      }
      continue;
    }

    // ★ 新・キャラクター行の検出 (台本形式 ＆ 過去ログ互換)
    let speaker = null;
    let action = null;
    let speech = null;

    const oldMatch = trimmed.match(/^\[([^\]]+)\]\s*(?:「([^」]+)」|(.+))$/);
    const newMatch = trimmed.match(/^([^「（\(\[:：\n]{1,30}?)(?:[（\(]([^）\)]+)[）\)])?[\s:：]*(?:「([^」]*)」)?$/);
    const fbMatch = trimmed.match(/^([^「]{1,30}?)「([^」]*)」?$/);

    if (oldMatch) {
      speaker = oldMatch[1].trim();
      speech = (oldMatch[2] || oldMatch[3] || '').trim();
    } else if (newMatch && (newMatch[2] || newMatch[3] !== undefined || /[:：]/.test(trimmed))) {
      speaker = newMatch[1].trim();
      action = newMatch[2] ? newMatch[2].trim() : null;
      speech = newMatch[3] !== undefined ? newMatch[3].trim() : null;
    } else if (fbMatch) {
      speaker = fbMatch[1].trim();
      speech = fbMatch[2].trim();
    }

    if (speaker && !['ナレーター', 'システム', '背景', 'ナレーション', '環境描写', '地の文'].includes(speaker)) {
      flushNarration();
      flushDialogue();
      currentDialogue = { type: 'dialogue', speaker: speaker, lines: [], image: consumePendingImage() };
      if (action) {
        currentDialogue.lines.push({ kind: 'action', text: action });
      }
      if (speech) {
        currentDialogue.lines.push({ kind: 'speech', text: `「${speech}」` });
      }
      flushDialogue();
      continue;
    }

    // 継続のセリフ行
    if (currentDialogue) {
      if (trimmed.startsWith('「') || trimmed.includes('「') || trimmed.endsWith('」')) {
        const cleaned = trimmed.replace(/^「|」$/g, '');
        currentDialogue.lines.push({ kind: 'speech', text: `「${cleaned}」` });
        continue;
      }
      flushDialogue();
    }

    // いずれにも当てはまらない場合はナレーションバッファへ
    narrationBuffer.push(line);
  }

  flushNarration();
  flushDialogue();
  if (pendingImage) {
    segments.push({ type: 'narration', text: '', image: consumePendingImage() });
  }
  return segments.length > 0 ? segments : [{ type: 'narration', text: text }];
}

async function buildDialogueMessageElement({
  speaker,
  avatarUrl,
  roleClass,
  speechLines = [],
  imageToken = null,
  story = null,
  messageIndex = null,
  editableSegment = null
}) {
  const msgEl = document.createElement('div');
  msgEl.className = `chat-message ${roleClass} chat-message-dialogue`;
  msgEl.dataset.speaker = speaker || '';
  msgEl.dataset.expression = 'default';

  let linesHTML = '';
  for (const line of speechLines) {
    if (line.kind === 'speech') {
      linesHTML += `<p class="chat-speech">${escapeHTML(line.text)}</p>`;
    } else if (line.kind === 'action') {
      linesHTML += `<p class="chat-action"><em>*${escapeHTML(line.text)}*</em></p>`;
    }
  }

  msgEl.innerHTML = `
    <div class="chat-avatar chat-avatar-portrait">
      <img src="${avatarUrl}" alt="${escapeHTML(speaker)}">
    </div>
    <div class="chat-content-wrapper chat-adv-panel">
      <div class="chat-panel-header">
        <span class="chat-sender-name">${escapeHTML(speaker)}</span>
      </div>
      <div class="chat-bubble chat-dialogue-body">
        ${linesHTML}
        ${editableSegment ? `
          <button class="segment-edit-btn" title="この台詞を編集" type="button">
            <span class="material-symbols-outlined" style="font-size:16px;">edit</span>
          </button>` : ''}
      </div>
    </div>
  `;

  const contentWrapper = msgEl.querySelector('.chat-content-wrapper');
  const bubbleEl = msgEl.querySelector('.chat-bubble');
  const editBtn = msgEl.querySelector('.segment-edit-btn');

  if (contentWrapper && imageToken) {
    const imageEl = createStoryImageElement(imageToken, story, 'story-inline-image story-inline-image-chat');
    if (imageEl) contentWrapper.insertBefore(imageEl, bubbleEl || null);
  }

  if (bubbleEl && editBtn && editableSegment && Number.isInteger(messageIndex)) {
    bubbleEl.addEventListener('mouseenter', () => editBtn.style.opacity = '1');
    bubbleEl.addEventListener('mouseleave', () => editBtn.style.opacity = '0');
    editBtn.onclick = () => showEditSegmentModal(messageIndex, editableSegment);
  }

  return msgEl;
}

async function buildUserNarrationMessageElement({
  senderName,
  avatarUrl,
  htmlContent,
  imageToken = null,
  story = null
}) {
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message user-role chat-message-dialogue';
  msgEl.dataset.speaker = senderName || '';
  msgEl.dataset.expression = 'default';
  msgEl.innerHTML = `
    <div class="chat-avatar chat-avatar-portrait"><img src="${avatarUrl}" alt="${escapeHTML(senderName)}"></div>
    <div class="chat-content-wrapper chat-adv-panel">
      <div class="chat-panel-header">
        <span class="chat-sender-name">${escapeHTML(senderName)}</span>
      </div>
      <div class="chat-bubble chat-dialogue-body">${htmlContent}</div>
    </div>
  `;

  if (imageToken) {
    const contentWrapper = msgEl.querySelector('.chat-content-wrapper');
    const bubbleEl = msgEl.querySelector('.chat-bubble');
    const imageEl = createStoryImageElement(imageToken, story, 'story-inline-image story-inline-image-chat');
    if (contentWrapper && imageEl) contentWrapper.insertBefore(imageEl, bubbleEl || null);
  }

  return msgEl;
}

function matchCharacterByName(speakerName, primaryCharacters = [], fallbackCharacters = []) {
  const characters = Array.isArray(primaryCharacters) ? primaryCharacters : [];
  const fallback = Array.isArray(fallbackCharacters) ? fallbackCharacters : [];
  if (!speakerName || (characters.length === 0 && fallback.length === 0)) return null;
  const normalised = speakerName.trim();
  let match = characters.find(c => c.name === normalised);
  if (match) return match;
  match = characters.find(c => c.name.includes(normalised) || normalised.includes(c.name));
  if (match) return match;
  match = fallback.find(c => c.name === normalised);
  if (match) return match;
  match = fallback.find(c => c.name.includes(normalised) || normalised.includes(c.name));
  if (match) return match;
  return null;
}

function getMentionQuery(textarea) {
  const caret = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, caret);
  const lineStart = Math.max(before.lastIndexOf('\n') + 1, 0);
  const line = before.slice(lineStart);
  const match = line.match(/(?:^|\s)(@:?\s*([^\s「」:：]*)?)$/);
  if (!match) return null;
  const token = match[1] || '@';
  return {
    query: (match[2] || '').trim(),
    start: caret - token.length,
    end: caret
  };
}

async function getMentionCandidates(query) {
  const { currentStory } = getState();
  const characters = await db.getCharacters();
  const storyIds = getStoryCharacterIds(currentStory, characters);
  const protagonist = currentStory?.protagonist?.name
    ? [{ name: currentStory.protagonist.name, avatarAssetId: currentStory.protagonist.avatarAssetId, isProtagonist: true }]
    : [];

  const sorted = [
    ...protagonist,
    ...characters
      .map(char => ({ ...char, inStory: storyIds.has(char.characterId) }))
      .sort((a, b) => Number(b.inStory) - Number(a.inStory) || (a.name || '').localeCompare(b.name || '', 'ja'))
  ];

  const normalizedQuery = query.toLowerCase();
  return sorted
    .filter(char => {
      const haystack = `${char.name || ''} ${char.category || ''} ${(char.tags || []).join(' ')}`.toLowerCase();
      return !normalizedQuery || haystack.includes(normalizedQuery);
    })
    .slice(0, 8);
}

export function bindMentionAutocomplete(textarea) {
  if (!textarea || textarea.dataset.mentionBound === 'true') return;
  textarea.dataset.mentionBound = 'true';

  const popup = document.createElement('div');
  popup.id = 'mention-autocomplete';
  popup.className = 'mention-autocomplete hidden';
  textarea.closest('.input-panel-wrapper')?.appendChild(popup);

  let activeQuery = null;

  const hide = () => {
    popup.classList.add('hidden');
    popup.innerHTML = '';
    activeQuery = null;
  };

  const insertMention = (name) => {
    if (!activeQuery) return;
    const before = textarea.value.slice(0, activeQuery.start);
    const after = textarea.value.slice(activeQuery.end);
    const insertion = `@:${name}`;
    textarea.value = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    hide();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const refresh = async () => {
    const query = getMentionQuery(textarea);
    if (!query) {
      hide();
      return;
    }
    activeQuery = query;
    const candidates = await getMentionCandidates(query.query);
    if (candidates.length === 0) {
      hide();
      return;
    }

    popup.innerHTML = '';
    for (const candidate of candidates) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mention-candidate';
      const avatarUrl = await getAvatarUrl(candidate.avatarAssetId);
      btn.innerHTML = `
        <img src="${avatarUrl}" alt="">
        <span>${escapeHTML(candidate.name || '名前なし')}</span>
        ${candidate.inStory || candidate.isProtagonist ? '<small>登場中</small>' : ''}
      `;
      btn.onclick = () => insertMention(candidate.name || '');
      popup.appendChild(btn);
    }
    popup.classList.remove('hidden');
  };

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('keyup', refresh);
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('blur', () => setTimeout(hide, 160));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
    if (e.key === 'Tab' && !popup.classList.contains('hidden')) {
      const first = popup.querySelector('.mention-candidate');
      if (first) {
        e.preventDefault();
        first.click();
      }
    }
  });
}

export async function renderStory() {
  const container = document.getElementById('story-viewport');
  if (!container) return;

  const appState = getState();
  const { currentStory, uiMode, isGenerating, autoscrollEnabled } = appState;

  if (!currentStory) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined">menu_book</span>
        <p>ストーリーを作成または選択してください</p>
        <button id="quick-create-story-btn" class="primary-btn">新規ストーリー作成</button>
      </div>
    `;
    const quickCreateBtn = document.getElementById('quick-create-story-btn');
    if (quickCreateBtn) {
      quickCreateBtn.onclick = () => {
        window.dispatchEvent(new CustomEvent('createNewStoryRequested'));
      };
    }
    return;
  }

  // ★ 追加：裏側でDOMを構築するための「仮想の箱（フラグメント）」を用意
  const fragment = document.createDocumentFragment();

  const messages = currentStory.messages || [];
  const lastMsg = messages[messages.length - 1];
  const lastIsModel = lastMsg && lastMsg.role === 'model';
  
  let parsedLast = { bodyText: '', choices: [] };
  if (lastIsModel) {
    parsedLast = parseChoices(lastMsg.content);
  }

  const allCharacters = uiMode === 'chat' ? await db.getCharacters() : [];
  const storyScopedCharacters = uiMode === 'chat' ? getStoryScopedCharacters(allCharacters, currentStory) : [];

for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;
    const isModel = msg.role === 'model';
    const textToRender = (isLast && isModel) ? parsedLast.bodyText : msg.content;

    // ★ msgWrapperの宣言は1回だけ！
    const msgWrapper = document.createElement('div');
    msgWrapper.className = 'message-wrapper';

    // ★ 思考（Thought）データが存在する場合は折りたたみUIを表示
    if (isModel && msg.thought) {
      const thoughtEl = document.createElement('div');
      thoughtEl.className = 'ai-thought-container';
      thoughtEl.style = "margin-bottom: 8px; font-size: 12px;";
      thoughtEl.innerHTML = `
        <details style="background: var(--bg-card, rgba(0,0,0,0.05)); border: 1px solid var(--border-color, rgba(0,0,0,0.1)); border-radius: 6px; padding: 4px 8px;">
          <summary style="cursor: pointer; font-weight: bold; color: var(--text-sub); display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 4px;">
              <span class="material-symbols-outlined" style="font-size: 16px;">psychology</span> 
              AIの思考プロセス (Thinking)
            </div>
          </summary>
          <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border-color, #ccc); color: var(--text-color, #666); white-space: pre-wrap; font-family: monospace;">
            <div style="display: flex; justify-content: flex-end; margin-bottom: 4px;">
              <button onclick="window.translateAiThought(this, ${i})" style="background: none; border: 1px solid var(--border-color, #ccc); border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; color: inherit;">
                <span class="material-symbols-outlined" style="font-size: 14px;">translate</span> 翻訳する
              </button>
            </div>
            <div class="ai-thought-content" data-original-text="${escapeHTML(msg.thought)}" data-translated="false">${escapeHTML(msg.thought)}</div>
          </div>
        </details>
      `;
      msgWrapper.appendChild(thoughtEl);
    }

    // ★ その次にcontentContainerを作る
    const contentContainer = document.createElement('div');
    contentContainer.className = 'message-content-container';

    if (uiMode === 'chat') {
      if (isModel) {
        const segments = parseModelOutputToSegments(textToRender);
        for (const seg of segments) {
          if (seg.type === 'narration') {
            const narEl = document.createElement('div');
            narEl.className = 'chat-message narration-role'; 
            let html = window.marked && typeof window.marked.parse === 'function' 
              ? sanitizeHTML(window.marked.parse(seg.text)) 
              : sanitizeHTML(seg.text.replace(/\n/g, '<br>'));
            narEl.innerHTML = `
              <div class="chat-avatar" style="visibility: hidden; flex-shrink: 0;"></div>
              <div class="chat-content-wrapper">
                <div class="narration-content">${html}</div>
              </div>
            `;
            if (seg.image) {
              const contentWrapper = narEl.querySelector('.chat-content-wrapper');
              const narrationContent = narEl.querySelector('.narration-content');
              const imageEl = createStoryImageElement(seg.image, currentStory, 'story-inline-image story-inline-image-narration');
              if (contentWrapper && imageEl) {
                contentWrapper.insertBefore(imageEl, narrationContent || null);
              }
            }
            contentContainer.appendChild(narEl);
          } else if (seg.type === 'dialogue') {
            const protagonistName = currentStory.protagonist?.name || '主人公';
            const isProtagonist = (seg.speaker === protagonistName || seg.speaker === '主人公');
            let avatarUrl = 'assets/default-silhouette.png';
            let roleClass = 'bot-role';

            if (isProtagonist) {
              roleClass = 'user-role';
              avatarUrl = await getAvatarUrl(currentStory.protagonist?.avatarAssetId);
            } else {
              const charMatch = matchCharacterByName(seg.speaker, storyScopedCharacters, allCharacters);
              if (charMatch) {
                avatarUrl = await getAvatarUrl(charMatch.avatarAssetId);
              }
            }
            const msgEl = await buildDialogueMessageElement({
              speaker: seg.speaker,
              avatarUrl,
              roleClass,
              speechLines: seg.lines,
              imageToken: seg.image,
              story: currentStory,
              messageIndex: i,
              editableSegment: seg
            });
            contentContainer.appendChild(msgEl);
          }
        }
      } else {
        // ★ 前回追加したユーザー入力の「@:キャラクター名」の分離処理
        const lines = textToRender.split('\n');
        const userSegments = [];
        let currentUserBuffer = [];
        let pendingUserImage = null;

        const consumeUserImage = () => {
          const image = pendingUserImage;
          pendingUserImage = null;
          return image;
        };

        const flushUser = () => {
          if (currentUserBuffer.length > 0) {
            const joined = currentUserBuffer.join('\n').trim();
            if (joined) userSegments.push({ type: 'user', text: joined, image: consumeUserImage() });
            currentUserBuffer = [];
          }
        };

 // 新形式の入力（動作の括弧を含む）に対応した正規表現
        const directiveRegex = /^@:\s*([^「（\(\[:：\n]+?)(?:[（\(]([^）\)]+)[）\)])?[\s:：]*(?:「([^」]*)」|(.+))?\s*$/;

        for (const line of lines) {
          const token = parseStoryImageInstructionLine(line);
          if (token) {
            if (token) pendingUserImage = token;
            continue;
          }
          const match = line.match(directiveRegex);
          if (match) {
            flushUser();
            const speaker = match[1].trim();
            const action = match[2] ? match[2].trim() : null;
            const speech = (match[3] ?? match[4] ?? '').trim();
            userSegments.push({ type: 'character', speaker, action, text: speech, image: consumeUserImage() });
          } else {
            currentUserBuffer.push(line);
          }
        }
        flushUser();
        if (pendingUserImage) userSegments.push({ type: 'user', text: '', image: consumeUserImage() });

        for (const seg of userSegments) {
          if (seg.type === 'character') {
            const charMatch = matchCharacterByName(seg.speaker, storyScopedCharacters, allCharacters);
            let avatarUrl = 'assets/default-silhouette.png';
            if (charMatch) {
              avatarUrl = await getAvatarUrl(charMatch.avatarAssetId);
            }
            const speechLines = [];
            if (seg.action) {
              speechLines.push({ kind: 'action', text: seg.action });
            }
            if (seg.text) {
              const displaySpeech = seg.text.startsWith('「') ? seg.text : `「${seg.text}」`;
              speechLines.push({ kind: 'speech', text: displaySpeech });
            }
            const msgEl = await buildDialogueMessageElement({
              speaker: seg.speaker,
              avatarUrl,
              roleClass: 'bot-role',
              speechLines,
              imageToken: seg.image,
              story: currentStory
            });
            contentContainer.appendChild(msgEl);
          } else {
            let avatarUrl = 'assets/default-silhouette.png';
            let senderName = currentStory.protagonist?.name || 'You';
            if (currentStory.protagonist) {
              avatarUrl = await getAvatarUrl(currentStory.protagonist.avatarAssetId);
            }
            let contentHTML = window.marked && typeof window.marked.parse === 'function'
              ? sanitizeHTML(window.marked.parse(seg.text))
              : sanitizeHTML(seg.text.replace(/\n/g, '<br>'));
            const msgEl = await buildUserNarrationMessageElement({
              senderName,
              avatarUrl,
              htmlContent: contentHTML,
              imageToken: seg.image,
              story: currentStory
            });
            contentContainer.appendChild(msgEl);
          }
        }
      }
    } else {
      const { cleanedText, tokens } = stripStoryImageTokenLines(textToRender);
      let contentHTML = window.marked && typeof window.marked.parse === 'function'
        ? sanitizeHTML(window.marked.parse(cleanedText))
        : sanitizeHTML(cleanedText.replace(/\n/g, '<br>'));
      const blockEl = document.createElement('div');
      blockEl.className = `novel-block ${isModel ? 'story-paragraph' : 'action-paragraph'}`;
      if (tokens.length > 0) {
        const imageStack = document.createElement('div');
        imageStack.className = 'novel-inline-image-stack';
        for (const token of tokens) {
          const imageEl = createStoryImageElement(token, currentStory, 'story-inline-image story-inline-image-novel');
          if (imageEl) imageStack.appendChild(imageEl);
        }
        if (imageStack.childElementCount > 0) blockEl.appendChild(imageStack);
      }
      const contentEl = document.createElement('div');
      if (!isModel) {
        const pName = currentStory.protagonist?.name || '主人公';
        contentEl.innerHTML = `<span class="novel-action-badge">${pName}の行動</span>${contentHTML}`;
      } else {
        contentEl.innerHTML = contentHTML;
      }
      blockEl.appendChild(contentEl);
      contentContainer.appendChild(blockEl);
    }

    msgWrapper.appendChild(contentContainer);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'chat-message-actions';
    let actionHtml = `
      <button class="action-icon-btn edit-msg-btn" title="メッセージ全体を編集">
        <span class="material-symbols-outlined" style="font-size:18px;">edit_note</span>
      </button>
      <button class="action-icon-btn delete-msg-btn" title="メッセージを削除">
        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
      </button>
    `;
    if (isModel && isLast) {
      actionHtml += `
        <button class="action-icon-btn regen-msg-btn" title="AIの応答を再生成">
          <span class="material-symbols-outlined" style="font-size:18px;">refresh</span>
        </button>
      `;
    }
    actionsEl.innerHTML = actionHtml;

    actionsEl.querySelector('.edit-msg-btn').onclick = () => showEditMessageModal(i);
    actionsEl.querySelector('.delete-msg-btn').onclick = async () => {
      if (confirm('このメッセージを削除しますか？')) {
        currentStory.messages.splice(i, 1);
        await db.saveStory(currentStory);
        const stories = await db.getStories();
        updateState({ stories });
        renderStory();
      }
    };
    if (isModel && isLast) {
      actionsEl.querySelector('.regen-msg-btn').onclick = () => {
        if (confirm('現在のAIの返答を破棄して、もう一度新しく生成し直しますか？')) {
          window.dispatchEvent(new CustomEvent('requestRegenerate', { detail: { retryOnly: false } }));
        }
      };
    }
    msgWrapper.appendChild(actionsEl);

    if (isModel && msg.usage && getState().promptDebugEnabled) {
      const usageEl = document.createElement('div');
      usageEl.className = 'message-usage-meta';
      const usageParts = [
        `入力 ${formatUsageNumber(msg.usage.promptTokenCount)}`,
        `出力 ${formatUsageNumber(msg.usage.candidatesTokenCount)}`
      ];
      if (msg.usage.thoughtsTokenCount > 0) usageParts.push(`Thinking ${formatUsageNumber(msg.usage.thoughtsTokenCount)}`);
      if (msg.usage.totalTokenCount > 0) usageParts.push(`合計 ${formatUsageNumber(msg.usage.totalTokenCount)}`);
      if (msg.usage.requestCount > 1) usageParts.push(`往復 ${formatUsageNumber(msg.usage.requestCount)}`);
      const toolCallSummary = Array.isArray(msg.usage.debug?.toolCalls) && msg.usage.debug.toolCalls.length > 0
        ? ` / 参照 ${msg.usage.debug.toolCalls.map(item => {
          const label = formatToolCallLabel(item.name);
          const count = Number(item.count || 0) > 1 ? `x${formatUsageNumber(item.count)}` : '';
          return `${label}${count}`;
        }).join(', ')}`
        : '';
      const groundingSummary = Array.isArray(msg.usage.debug?.groundingQueries) && msg.usage.debug.groundingQueries.length > 0
        ? ` / Google検索 ${formatUsageNumber(msg.usage.debug.groundingQueries.length)}件`
        : '';
      usageEl.textContent = `使用量: ${usageParts.join(' / ')}${toolCallSummary}${groundingSummary}`;
      msgWrapper.appendChild(usageEl);
    }

    // ★ 画面（container）ではなく、裏側の箱（fragment）に要素を追加する
    fragment.appendChild(msgWrapper);
  }

  if (isGenerating) {
    const loader = document.createElement('div');
    loader.className = 'story-loader';
    loader.style = "display: flex; flex-direction: column; align-items: center; gap: 8px;";
    loader.innerHTML = `
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
      <p class="loader-text">ストーリーを紡いでいます...</p>
      <button id="cancel-generation-btn" class="secondary-btn" style="padding: 4px 12px; font-size: 12px; cursor: pointer; border-radius: 4px; margin-top: 4px;">
        生成を停止する
      </button>
    `;
    const cancelBtn = loader.querySelector('#cancel-generation-btn');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        const { activeAbortController } = getState();
        if (activeAbortController) activeAbortController.abort();
      };
    }
    fragment.appendChild(loader);
  }

  if (!isGenerating && lastMsg && lastMsg.role === 'user') {
    const retryContainer = document.createElement('div');
    retryContainer.style = "text-align: center; margin: 16px 0;";
    retryContainer.innerHTML = `
      <button id="retry-generation-btn" class="primary-btn" style="display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 20px; border-radius: 20px; font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.15); cursor: pointer;">
        <span class="material-symbols-outlined" style="font-size:20px;">refresh</span> AIの応答を生成する (リトライ)
      </button>
    `;
    retryContainer.querySelector('#retry-generation-btn').onclick = () => {
      window.dispatchEvent(new CustomEvent('requestRegenerate', { detail: { retryOnly: true } }));
    };
    fragment.appendChild(retryContainer);
  }

  // =========================================================================
  // ★ ここですべての非同期処理が完了！
  // この瞬間の「ユーザーが実際に見ているスクロール位置」を正確に記憶する
  const previousScrollTop = container.scrollTop;

  // 画面をクリアし、裏側で作っておいた全要素を一瞬で流し込む
  container.innerHTML = '';
  container.appendChild(fragment);

  // 選択肢ボタンの描画
  renderChoiceButtons(parsedLast.choices);

  // ★ 最後にスクロール位置の調整
  if (autoscrollEnabled !== false) {
    container.scrollTop = container.scrollHeight;
  } else {
    // オフの場合は、画面が空になる直前に記憶した位置へ完璧に復元
    container.scrollTop = previousScrollTop;
  }
}

/**
 * チャット最上段・最下段へのジャンプボタンのイベント登録及び表示制御
 */
export function bindScrollJumpControls() {
  const container = document.getElementById('story-viewport');
  const jumpControls = document.getElementById('scroll-jump-controls');
  const topBtn = document.getElementById('scroll-top-btn');
  const bottomBtn = document.getElementById('scroll-bottom-btn');
  if (!container || !jumpControls) return;

  // スクロール状態を監視して、ある程度スクロールされたらジャンプボタンを表示
  container.addEventListener('scroll', () => {
    // 1画面分以上スクロールされているか、最下部から一定距離離れている場合に表示
    const threshold = 150;
    const isScrollable = container.scrollHeight > container.clientHeight;
    const isOffset = container.scrollTop > threshold || (container.scrollHeight - container.scrollTop - container.clientHeight) > threshold;
    
    if (isScrollable && isOffset) {
      jumpControls.classList.add('visible');
      jumpControls.classList.remove('hidden');
    } else {
      jumpControls.classList.remove('visible');
      jumpControls.classList.add('hidden');
    }
  });

  if (topBtn) {
    topBtn.onclick = () => {
      container.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  if (bottomBtn) {
    bottomBtn.onclick = () => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    };
  }
}

async function confirmLoreDeletion(loreName) {
  const skipKey = 'skip_confirm_delete_lore';
  const skipConfirm = await db.getSetting(skipKey, false);
  if (skipConfirm) return true;

  return new Promise(resolve => {
    let modal = document.getElementById('lore-delete-confirm-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'lore-delete-confirm-modal';
    modal.className = 'modal-wrapper';
    modal.style.zIndex = '6000';
    modal.innerHTML = `
      <div style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: min(92vw, 420px); border-radius: 8px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 14px; box-sizing: border-box;">
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <h3 style="margin: 0; font-size: 16px;">ロアを削除しますか？</h3>
          <p style="margin: 0; color: var(--text-sub); line-height: 1.6;">ロア「${escapeHTML(loreName || '名称未設定')}」を削除します。この操作は元に戻せません。</p>
        </div>
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-sub);">
          <input id="lore-delete-confirm-skip" type="checkbox">
          <span>次回以降この確認を表示しない</span>
        </label>
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="lore-delete-confirm-cancel" class="secondary-btn" type="button">キャンセル</button>
          <button id="lore-delete-confirm-ok" class="primary-btn" type="button">削除する</button>
        </div>
      </div>
    `;

    const close = async (confirmed) => {
      const skipChecked = modal.querySelector('#lore-delete-confirm-skip')?.checked;
      if (confirmed && skipChecked) {
        await db.saveSetting(skipKey, true);
      }
      modal.remove();
      resolve(confirmed);
    };

    modal.addEventListener('click', e => {
      if (e.target === modal) close(false);
    });

    modal.querySelector('#lore-delete-confirm-cancel')?.addEventListener('click', () => close(false));
    modal.querySelector('#lore-delete-confirm-ok')?.addEventListener('click', () => close(true));

    document.body.appendChild(modal);
  });
}

/**
 * キャラクターの吹き出し（セグメント）ごとの編集モーダルを表示する関数
 */
export async function showEditSegmentModal(msgIndex, seg) {
  const { currentStory } = getState();
  if (!currentStory || !currentStory.messages[msgIndex]) return;
  const msg = currentStory.messages[msgIndex];

  // 編集用のテキストを構築（スピーチとアクションを結合）
  let originalText = '';
  if (seg.type === 'dialogue') {
    originalText = seg.lines.map(l => {
      if (l.kind === 'speech') return l.text;
      if (l.kind === 'action') return `*${l.text}*`;
      return l.text;
    }).join('\n');
  } else {
    originalText = seg.text;
  }

  let modal = document.getElementById('segment-edit-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'segment-edit-modal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  modal.style.zIndex = '5000';

  modal.innerHTML = `
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 500px; border-radius: 8px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 12px; box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">${escapeHTML(seg.speaker || 'ナレーション')} の台詞を編集</h3>
      <textarea id="seg-edit-textarea" style="width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; font-family: inherit; font-size: 14px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit; line-height: 1.6;">${escapeHTML(originalText)}</textarea>
      
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
        <button id="seg-edit-full-btn" style="background: none; border: none; font-size: 12px; text-decoration: underline; color: var(--primary-color, #4a90e2); cursor: pointer; padding: 0;">メッセージ全体を編集する</button>
        <div style="display: flex; gap: 10px;">
          <button id="seg-edit-cancel-btn" class="secondary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">キャンセル</button>
          <button id="seg-edit-save-btn" class="primary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">変更を保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const textarea = modal.querySelector('#seg-edit-textarea');
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', autoResize);
  setTimeout(autoResize, 0);

  // キャンセル処理
  modal.querySelector('#seg-edit-cancel-btn').onclick = () => modal.remove();
  
  // 部分的な置換が難しい場合のための「全体編集への切り替え」
  modal.querySelector('#seg-edit-full-btn').onclick = () => {
    modal.remove();
    showEditMessageModal(msgIndex);
  };

  // 保存処理（テキストの一部置換を行う）
  modal.querySelector('#seg-edit-save-btn').onclick = async () => {
    const newText = textarea.value.trim();
    if (!newText) {
      alert('台詞を空にはできません。削除したい場合は「メッセージ全体を編集する」から行ってください。');
      return;
    }

    let updatedContent = msg.content;
    let replaceSuccess = false;

    // 元のテキスト内で該当箇所を探して置換する
    const firstLine = seg.type === 'dialogue' && seg.lines.length > 0 
      ? (seg.lines[0].kind === 'action' ? `*${seg.lines[0].text}*` : seg.lines[0].text) 
      : originalText;

    // パターン1: そのままの文字列でマッチする場合
    if (updatedContent.includes(firstLine)) {
      updatedContent = updatedContent.replace(firstLine, newText);
      // 複数行あった場合は、残りの古い行を削除して整合性をとる
      if (seg.type === 'dialogue' && seg.lines.length > 1) {
        for (let i = 1; i < seg.lines.length; i++) {
          const l = seg.lines[i];
          const target = l.kind === 'action' ? `*${l.text}*` : l.text;
          updatedContent = updatedContent.replace(target, '');
        }
      }
      replaceSuccess = true;
    } 
    // パターン2: [キャラクター名] 「セリフ」 の形式で生データが保存されている場合
    else {
      const formattedFallback = `[${seg.speaker}] ${firstLine}`;
      if (updatedContent.includes(formattedFallback)) {
        updatedContent = updatedContent.replace(formattedFallback, `[${seg.speaker}] ${newText}`);
        replaceSuccess = true;
      }
    }

    if (replaceSuccess) {
      // 連続する改行をきれいにする
      updatedContent = updatedContent.replace(/\n{3,}/g, '\n\n');
      
      currentStory.messages[msgIndex].content = updatedContent;
      await db.saveStory(currentStory);
      modal.remove();
      renderStory();
    } else {
      alert('テキストの置換箇所を特定できませんでした。AIの出力フォーマットが複雑なため、左下の「メッセージ全体を編集する」から修正を行ってください。');
    }
  };
}

/**
 * 過去のメッセージ内容を編集する専用モーダルダイアログ (自動拡張機能付き)
 */
export async function showEditMessageModal(msgIndex) {
  const { currentStory } = getState();
  if (!currentStory || !currentStory.messages[msgIndex]) return;
  const msg = currentStory.messages[msgIndex];

  let modal = document.getElementById('msg-edit-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'msg-edit-modal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  modal.style.zIndex = '5000';

  modal.innerHTML = `
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 600px; max-height: 90vh; border-radius: 8px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 12px; box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">メッセージの編集</h3>
      <div style="flex: 1; overflow-y: auto; padding-right: 4px;">
        <textarea id="msg-edit-textarea" style="width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; font-family: inherit; font-size: 14px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit; line-height: 1.6; overflow-y: hidden;">${escapeHTML(msg.content)}</textarea>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px;">
        <button id="msg-edit-cancel-btn" class="secondary-btn" style="padding: 8px 16px; border-radius: 4px; cursor: pointer;">キャンセル</button>
        <button id="msg-edit-save-btn" class="primary-btn" style="padding: 8px 16px; border-radius: 4px; cursor: pointer;">変更を保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const textarea = modal.querySelector('#msg-edit-textarea');
  // Auto-resizeロジック
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', autoResize);
  setTimeout(autoResize, 0); // 初期表示時に高さを合わせる

  modal.querySelector('#msg-edit-cancel-btn').onclick = () => modal.remove();
  modal.querySelector('#msg-edit-save-btn').onclick = async () => {
    const newContent = textarea.value.trim();
    if (newContent) {
      currentStory.messages[msgIndex].content = newContent;
      await db.saveStory(currentStory);
      modal.remove();
      renderStory();
    } else {
      alert('メッセージを空にはできません。削除したい場合はゴミ箱アイコンを使用してください。');
    }
  };
}

function renderChoiceButtons(choices) {
  const choicesContainer = document.getElementById('choices-container');
  if (!choicesContainer) return;

  choicesContainer.innerHTML = '';
  const { showChoices, isGenerating } = getState();
  
  if (!showChoices || choices.length === 0 || isGenerating) {
    choicesContainer.classList.add('hidden');
    return;
  }

  choicesContainer.classList.remove('hidden');
  choices.forEach(choice => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.innerHTML = `
      <span class="choice-label">${choice.label}</span>
      <span class="choice-text">${choice.text}</span>
    `;
    btn.onclick = () => {
      const textToSend = `${choice.label}. ${choice.text}`;
      window.dispatchEvent(new CustomEvent('submitUserAction', { detail: textToSend }));
    };
    choicesContainer.appendChild(btn);
  });
}

export async function renderSidebar() {
  const { currentStory } = getState();
  const sidebarEl = document.getElementById('story-sidebar');
  if (!sidebarEl) return;

  if (!currentStory) {
    sidebarEl.innerHTML = `<div class="sidebar-empty">ストーリーを選択するとステータスが表示されます</div>`;
    return;
  }

  const { protagonist, characterMemory, relationshipMemory } = currentStory;
  const pAvatarUrl = await getAvatarUrl(protagonist?.avatarAssetId);
  const allCharacters = await db.getCharacters();
  const characters = getStoryScopedCharacters(allCharacters, currentStory);
  currentStory.characters = buildStoryCharacterRefs(currentStory, allCharacters);
  const characterScopeNote = currentStory.tags?.length
    ? `ストーリータグ一致: ${currentStory.tags.join(', ')}`
    : 'タグ未設定のため、登録済みキャラクターをすべて対象にしています。';

  let html = `
    <div class="sidebar-section">
      <h4>主人公プロファイル</h4>
      <div class="sidebar-protagonist-card" style="cursor: pointer; transition: opacity 0.2s;" title="設定を編集" onmouseover="this.style.opacity=0.8" onmouseout="this.style.opacity=1">
        <img src="${pAvatarUrl}" class="sidebar-p-avatar" alt="Protagonist">
        <div class="sidebar-p-details">
          <strong id="sidebar-p-name">${escapeHTML(protagonist?.name || '主人公名なし')}</strong>
          <span class="sidebar-p-desc" title="${escapeHTML(protagonist?.description || '設定なし')}">
            ${escapeHTML(protagonist?.description || '詳細設定がありません。')}
          </span>
        </div>
      </div>
    </div>

    <div class="sidebar-section">
      <h4>登場キャラクター・関係メモ</h4>
      <p class="note">${escapeHTML(characterScopeNote)}</p>
      <div class="sidebar-characters-list">
  `;

  if (characters.length === 0) {
    html += `<p class="note">タグの一致するキャラクター、または登録されているキャラクターはいません。</p>`;
  } else {
    for (const char of characters) {
      const avatarUrl = await getAvatarUrl(char.avatarAssetId);
      const charMem = characterMemory?.[char.characterId] || {};
      const relMem = relationshipMemory?.[char.characterId] || { affinity: 50, notes: '' };

      html += `
        <div class="sidebar-char-row" data-char-id="${char.characterId}">
          <div class="char-role-header">
            <img src="${avatarUrl}" class="sidebar-c-avatar" alt="${char.name}">
            <div class="char-role-name">
              <strong>${escapeHTML(char.name)}</strong>
            </div>
          </div>
          
          <div class="char-role-body">
            <div class="form-row-compact">
              <label>好感度 (${relMem.affinity ?? 50})</label>
              <input type="range" class="char-affinity-range" data-char-id="${char.characterId}" min="0" max="100" value="${relMem.affinity ?? 50}">
            </div>
            <div class="form-row-compact">
              <label>キャラ状態</label>
              <input type="text" class="char-status-input" data-char-id="${char.characterId}" value="${escapeHTML(charMem.status || '')}" placeholder="例: 照れている、警戒中">
            </div>
            <div class="form-row-compact">
              <label>関係メモ</label>
              <input type="text" class="char-relation-notes-input" data-char-id="${char.characterId}" value="${escapeHTML(relMem.notes || '')}" placeholder="例: 秘密を共有している">
            </div>
          </div>
        </div>
      `;
    }
  }

  html += `</div></div>`;
  html += `
    <div class="sidebar-section sidebar-session-link-section">
      <h4>セッションロア</h4>
      <div class="sidebar-session-link-copy">
        進行状況や重要イベントはロアブックの「セッションロア」に集約しました。
      </div>
      <button id="open-session-lore-btn" class="sidebar-session-link-btn" type="button">
        <span class="material-symbols-outlined">history_edu</span>
        <span>セッションロアを開く</span>
      </button>
    </div>
  `;

  sidebarEl.innerHTML = html;
  bindSidebarEvents();
}

function bindSidebarEvents() {
  const { currentStory } = getState();
  if (!currentStory) return;

  const saveStateChanges = () => {
    db.saveStory(currentStory).then(async () => {
      const stories = await db.getStories();
      updateState({ stories });
      window.dispatchEvent(new CustomEvent('storyDataUpdated'));
    });
  };

  const pCard = document.querySelector('.sidebar-protagonist-card');
  if (pCard) pCard.onclick = () => showStorySettingsModal();
  const openSessionLoreBtn = document.getElementById('open-session-lore-btn');
  if (openSessionLoreBtn) {
    openSessionLoreBtn.onclick = () => {
      renderLorebook('session');
      updateState({ activeScreen: 'lorebook' });
    };
  }

  document.querySelectorAll('.char-affinity-range').forEach(range => {
    range.oninput = (e) => {
      const charId = e.target.dataset.charId;
      const val = parseInt(e.target.value);
      e.target.previousElementSibling.textContent = `好感度 (${val})`;
      if (!currentStory.relationshipMemory) currentStory.relationshipMemory = {};
      if (!currentStory.relationshipMemory[charId]) currentStory.relationshipMemory[charId] = { affinity: 50, notes: '' };
      currentStory.relationshipMemory[charId].affinity = val;
      saveStateChanges();
    };
  });

  document.querySelectorAll('.char-status-input').forEach(input => {
    input.oninput = (e) => {
      const charId = e.target.dataset.charId;
      if (!currentStory.characterMemory) currentStory.characterMemory = {};
      if (!currentStory.characterMemory[charId]) currentStory.characterMemory[charId] = { status: '', shortTermGoal: '', location: '' };
      currentStory.characterMemory[charId].status = e.target.value;
      saveStateChanges();
    };
  });

  document.querySelectorAll('.char-relation-notes-input').forEach(input => {
    input.oninput = (e) => {
      const charId = e.target.dataset.charId;
      if (!currentStory.relationshipMemory) currentStory.relationshipMemory = {};
      if (!currentStory.relationshipMemory[charId]) currentStory.relationshipMemory[charId] = { affinity: 50, notes: '' };
      currentStory.relationshipMemory[charId].notes = e.target.value;
      saveStateChanges();
    };
  });
}

export async function renderStoryList() {
  const container = document.getElementById('stories-list-container');
  if (!container) return;

  container.innerHTML = '';
  const stories = await db.getStories();
  const current = getState().currentStory;
  stories.sort((a, b) => b.timestamp - a.timestamp);

  if (current) {
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'primary-btn';
    settingsBtn.style = "width: 100%; padding: 8px; margin-bottom: 12px; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; box-sizing: border-box; border-radius: 6px;";
    settingsBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px;">settings</span>⚙️ 現在のストーリーを設定`;
    settingsBtn.onclick = () => {
      showStorySettingsModal();
      document.getElementById('mobile-drawer')?.classList.remove('open');
    };
    container.appendChild(settingsBtn);
  }

  stories.forEach(story => {
    const el = document.createElement('div');
    el.className = `story-list-item ${current && current.storyId === story.storyId ? 'active' : ''}`;
    el.innerHTML = `
      <div class="story-item-text" style="flex: 1; min-width: 0;">
        <span class="story-item-title">${escapeHTML(story.title || '無題のストーリー')}</span>
        <span class="story-item-meta">${story.messages?.length || 0} メッセージ</span>
      </div>
      <div class="story-item-actions" style="display: flex; gap: 4px; align-items: center; margin-left: 8px;">
        <button class="rename-story-btn" title="名前を変更" style="background: none; border: none; color: inherit; opacity: 0.6; cursor: pointer; padding: 4px; display: inline-flex; align-items: center;">
          <span class="material-symbols-outlined" style="font-size: 20px;">edit</span>
        </button>
        <button class="delete-story-btn" title="削除">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    `;
    
    el.onclick = (e) => {
      if (e.target.closest('.rename-story-btn')) {
        e.stopPropagation();
        const oldTitle = story.title || '新しいストーリー';
        const newTitle = prompt('ストーリーの名前を変更:', oldTitle);
        if (newTitle !== null && newTitle.trim() !== '') {
          story.title = newTitle.trim();
          db.saveStory(story).then(() => {
            if (current && current.storyId === story.storyId) setActiveStory(story);
            renderStoryList();
          });
        }
        return;
      }

      if (e.target.closest('.delete-story-btn')) {
        e.stopPropagation();
        if (confirm(`ストーリー「${story.title}」を削除しますか？`)) {
          recordSyncTombstone('stories', story.storyId, {
            title: story.title || '',
            franchise: story.franchise || ''
          }).then(() => db.deleteStory(story.storyId)).then(() => {
            if (current && current.storyId === story.storyId) setActiveStory(null);
            renderStoryList();
            requestDropboxAutoSync(null, { forceFull: true });
          });
        }
        return;
      }
      
      setActiveStory(story);
      renderStoryList();
      document.getElementById('mobile-drawer')?.classList.remove('open');
    };
    container.appendChild(el);
  });
}

export async function renderCharacterLibrary() {
  const container = document.getElementById('library-viewport');
  if (!container) return;

  container.innerHTML = '';
  const characters = await db.getCharacters();
  const searchInput = document.getElementById('library-search-input');
  const filterSelect = document.getElementById('library-filter-select');
  const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const filterMode = filterSelect ? filterSelect.value : 'all';
  const categories = new Set();
  characters.forEach(c => { if (c.category) categories.add(c.category); });

  if (filterSelect) {
    const currentVal = filterSelect.value;
    filterSelect.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'すべて';
    filterSelect.appendChild(optAll);

    const optInStory = document.createElement('option');
    optInStory.value = 'in-story';
    optInStory.textContent = '使用中のストーリーのみ';
    filterSelect.appendChild(optInStory);

    const { currentStory } = getState();
    if (currentStory && currentStory.tags && currentStory.tags.length > 0) {
      const optMatchingTags = document.createElement('option');
      optMatchingTags.value = 'matching-tags';
      optMatchingTags.textContent = `タグ一致 (${currentStory.tags.join(', ')})`;
      filterSelect.appendChild(optMatchingTags);
    }

    for (const cat of [...categories].sort()) {
      const opt = document.createElement('option');
      opt.value = `cat:${cat}`;
      opt.textContent = cat;
      filterSelect.appendChild(opt);
    }
    filterSelect.value = currentVal;
  }

  const { currentStory } = getState();
  const inStoryCharIds = getStoryCharacterIds(currentStory, characters);

  let filtered = characters;
  if (searchQuery) {
    filtered = filtered.filter(c =>
      c.name.toLowerCase().includes(searchQuery) ||
      (c.category || '').toLowerCase().includes(searchQuery) ||
      (c.personality || '').toLowerCase().includes(searchQuery) ||
      (c.tags || []).some(t => t.toLowerCase().includes(searchQuery))
    );
  }
  if (filterMode === 'in-story') {
    filtered = filtered.filter(c => inStoryCharIds.has(c.characterId));
  } else if (filterMode === 'matching-tags') {
    filtered = filtered.filter(c => isCharacterMatchingStory(c, currentStory));
  } else if (filterMode.startsWith('cat:')) {
    const catName = filterMode.slice(4);
    filtered = filtered.filter(c => c.category === catName);
  }

  const addCard = document.createElement('div');
  addCard.className = 'char-card add-card';
  addCard.innerHTML = `<span class="material-symbols-outlined add-icon">person_add</span><strong>新しいキャラクター</strong>`;
  addCard.onclick = () => showCharacterModal();
  container.appendChild(addCard);

  for (const char of filtered) {
    const card = document.createElement('div');
    card.className = 'char-card';
    const avatarUrl = await getAvatarUrl(char.avatarAssetId);
    
    let tagBadges = '';
    if (char.category) tagBadges += `<span class="char-card-tag">${escapeHTML(char.category)}</span>`;
    if (char.tags && char.tags.length > 0) {
      char.tags.forEach(t => {
        if (t !== char.category) tagBadges += `<span class="char-card-tag" style="background-color: var(--primary-light, #e1f5fe); color: var(--primary-dark, #0288d1);">${escapeHTML(t)}</span>`;
      });
    }

    card.innerHTML = `
      <div class="char-card-avatar-wrapper"><img src="${avatarUrl}" alt="${char.name}"></div>
      <div class="char-card-details">
        <strong>${escapeHTML(char.name)}</strong>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">${tagBadges}</div>
        <p class="char-card-personality" style="margin-top: 8px;">${escapeHTML(char.personality || '個性未設定')}</p>
      </div>
      <div class="char-card-actions">
        <button class="edit-char-btn" title="編集"><span class="material-symbols-outlined">edit</span></button>
        <button class="export-char-btn" title="エクスポート"><span class="material-symbols-outlined">upload</span></button>
        <button class="delete-char-btn" title="削除"><span class="material-symbols-outlined">delete</span></button>
      </div>
    `;

    card.querySelector('.edit-char-btn').onclick = (e) => { e.stopPropagation(); showCharacterModal(char); };
    card.querySelector('.export-char-btn').onclick = (e) => { e.stopPropagation(); exportCharacterJSON(char); };
    card.querySelector('.delete-char-btn').onclick = (e) => {
      e.stopPropagation();
      if (confirm(`キャラクター「${char.name}」を削除しますか？\n(紐付いているアバター画像も削除されます)`)) {
        recordSyncTombstone('characters', char.characterId, {
          name: char.name || '',
          category: char.category || ''
        }).then(async () => {
          if (char.avatarAssetId) {
            await recordSyncTombstone('assets', char.avatarAssetId, {
              label: `${char.name || 'character'} avatar`
            });
          }
          return db.deleteCharacter(char.characterId);
        }).then(async () => {
          const updatedChars = await db.getCharacters();
          updateState({ characters: updatedChars });
          renderCharacterLibrary();
          renderSidebar();
          requestDropboxAutoSync(null, { forceFull: true });
        });
      }
    };
    container.appendChild(card);
  }
}

export function cropImageToSquareBlob(file, zoomPercent, shiftX, shiftY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 300; 
      canvas.height = 300;
      const ctx = canvas.getContext('2d');
      const r = 300 / 200; 
      const scale = zoomPercent / 100;
      const aspect = img.width / img.height;
      let baseWidth, baseHeight;
      if (aspect > 1) { baseHeight = 200; baseWidth = 200 * aspect; }
      else { baseWidth = 200; baseHeight = 200 / aspect; }
      const drawWidth = baseWidth * scale * r;
      const drawHeight = baseHeight * scale * r;
      const drawX = (300 - drawWidth) / 2 + (shiftX * r);
      const drawY = (300 - drawHeight) / 2 + (shiftY * r);
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      canvas.toBlob((blob) => { resolve(blob); }, 'image/jpeg', 0.9);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = (err) => reject(err);
  });
}

export function showAvatarCropModal(file, onCropComplete) {
  let modal = document.getElementById('avatar-crop-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'avatar-crop-modal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  modal.style.zIndex = '4000';

  modal.innerHTML = `
    <div style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 380px; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">アバターの位置調整</h3>
      <div style="position: relative; width: 200px; height: 200px; margin: 0 auto; background: #eee; border: 1px solid #ccc; border-radius: 4px; overflow: hidden; display: flex; justify-content: center; align-items: center;">
        <img id="crop-modal-preview-img" style="position: absolute; transform-origin: center; max-width: none; max-height: none;" alt="Crop Preview">
        <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; box-shadow: inset 0 0 0 100px rgba(0,0,0,0.55); border-radius: 50%;"></div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <span style="font-size: 11px; min-width: 50px; font-weight: bold;">ズーム</span>
          <input type="range" id="crop-modal-zoom" min="100" max="300" value="100" style="flex: 1; cursor: pointer;">
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <span style="font-size: 11px; min-width: 50px; font-weight: bold;">左右位置</span>
          <input type="range" id="crop-modal-shift-x" min="-100" max="100" value="0" style="flex: 1; cursor: pointer;">
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <span style="font-size: 11px; min-width: 50px; font-weight: bold;">上下位置</span>
          <input type="range" id="crop-modal-shift-y" min="-100" max="100" value="0" style="flex: 1; cursor: pointer;">
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; border-top: 1px solid var(--border-color, #eee); padding-top: 12px;">
        <button id="crop-modal-cancel-btn" style="background: none; border: 1px solid var(--border-color, #ccc); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; color: inherit;">キャンセル</button>
        <button id="crop-modal-apply-btn" style="background: var(--primary-color, #4a90e2); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 12px;">決定</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const previewImg = modal.querySelector('#crop-modal-preview-img');
  const zoomSlider = modal.querySelector('#crop-modal-zoom');
  const shiftXSlider = modal.querySelector('#crop-modal-shift-x');
  const shiftYSlider = modal.querySelector('#crop-modal-shift-y');
  const cancelBtn = modal.querySelector('#crop-modal-cancel-btn');
  const applyBtn = modal.querySelector('#crop-modal-apply-btn');

  const imgUrl = URL.createObjectURL(file);
  previewImg.src = imgUrl;

  const updatePreview = () => {
    const z = zoomSlider.value;
    const x = shiftXSlider.value;
    const y = shiftYSlider.value;
    previewImg.style.transform = `scale(${z / 100}) translate(${x}px, ${y}px)`;
  };

  previewImg.onload = () => {
    const aspect = previewImg.naturalWidth / previewImg.naturalHeight;
    if (aspect > 1) { previewImg.style.height = '200px'; previewImg.style.width = `${200 * aspect}px`; }
    else { previewImg.style.width = '200px'; previewImg.style.height = `${200 / aspect}px`; }
    updatePreview();
  };

  zoomSlider.oninput = updatePreview;
  shiftXSlider.oninput = updatePreview;
  shiftYSlider.oninput = updatePreview;

  cancelBtn.onclick = () => { modal.remove(); URL.revokeObjectURL(imgUrl); };
  applyBtn.onclick = async () => {
    const z = parseFloat(zoomSlider.value);
    const x = parseFloat(shiftXSlider.value);
    const y = parseFloat(shiftYSlider.value);
    try {
      const croppedBlob = await cropImageToSquareBlob(file, z, x, y);
      onCropComplete(croppedBlob);
      modal.remove();
    } catch (e) {
      alert('画像の切り出しに失敗しました。');
    } finally {
      URL.revokeObjectURL(imgUrl);
    }
  };
}

export async function showCharacterModal(char = null) {
  const modal = document.getElementById('char-modal');
  if (!modal) return;

  const titleEl = document.getElementById('char-modal-title');
  const nameInput = document.getElementById('char-name-input');
  const categoryInput = document.getElementById('char-category-input');
  const descInput = document.getElementById('char-desc-input');
  const persInput = document.getElementById('char-pers-input');
  const exInput = document.getElementById('char-ex-input');
  const imgInput = document.getElementById('char-img-input');
  const previewImg = document.getElementById('char-img-preview');
  const saveBtn = document.getElementById('char-save-btn');

  let tagsInput = document.getElementById('char-tags-input');
  if (!tagsInput && categoryInput) {
    const parent = categoryInput.parentElement;
    const tagsRow = document.createElement('div');
    tagsRow.className = 'form-row';
    tagsRow.innerHTML = `<label>タグ (カンマ区切り)</label><input type="text" id="char-tags-input" placeholder="例: 五等分の花嫁, アニメ">`;
    parent.after(tagsRow);
    tagsInput = document.getElementById('char-tags-input');
  }
  // --- 追加開始：AI自動生成ボタンの設置と処理 ---
  let aiGenBtn = document.getElementById('char-ai-gen-btn');
  if (!aiGenBtn && tagsInput) {
    const btn = document.createElement('button');
    btn.id = 'char-ai-gen-btn';
    btn.type = 'button';
    btn.className = 'primary-btn';
    // 魔法っぽいグラデーションのボタンデザイン
    btn.style = "margin-top: 16px; margin-bottom: 8px; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; box-sizing: border-box; background: linear-gradient(135deg, #4a90e2, #9013fe); border: none;";
    btn.innerHTML = '<span class="material-symbols-outlined">travel_explore</span> ネット検索でプロフィールを自動生成';
    tagsInput.parentElement.after(btn);
    aiGenBtn = btn;
  }

  if (aiGenBtn) {
    aiGenBtn.onclick = async () => {
      const name = nameInput.value.trim();
      const cat = categoryInput ? categoryInput.value.trim() : '';
      if (!name) {
        alert('先に「キャラクター名」を入力してください。\n（カテゴリーも入力すると検索精度が上がります）');
        return;
      }
      if (!confirm(`「${name}」のプロフィールをネット検索で自動生成しますか？\n（現在入力されている内容は上書きされます。完了まで数十秒かかります）`)) return;

      const originalHtml = aiGenBtn.innerHTML;
      aiGenBtn.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">sync</span> 生成中 (数十秒かかります)...';
      aiGenBtn.disabled = true;

      try {
        const generated = await generateCharacterProfile(name, cat);
        if (generated) {
          // AIが返してきたJSONを各テキストエリアに流し込む
          if (generated.description) descInput.value = generated.description;
          if (generated.personality) persInput.value = generated.personality;
          if (generated.mes_example) exInput.value = generated.mes_example;
          if (generated.tags && Array.isArray(generated.tags)) {
            tagsInput.value = generated.tags.join(', ');
          }
          
          // 流し込んだ文字数に合わせて、テキストエリアの高さを自動で広げる
          [descInput, persInput, exInput].forEach(ta => {
            ta.style.height = 'auto';
            if (ta.scrollHeight > 0) ta.style.height = ta.scrollHeight + 'px';
          });
          
          alert('プロフィールの自動生成が完了しました！\n内容を確認・手直しし、問題なければ一番下の「保存」を押してください。');
        }
      } catch (err) {
        alert('生成に失敗しました: ' + err.message);
      } finally {
        // ボタンを元の状態に戻す
        aiGenBtn.innerHTML = originalHtml;
        aiGenBtn.disabled = false;
      }
    };
  }
  // --- 追加終了 ---
  let adjustBtn = document.getElementById('char-adjust-crop-btn');
  if (!adjustBtn && imgInput) {
    const parent = imgInput.parentElement;
    const btn = document.createElement('button');
    btn.id = 'char-adjust-crop-btn';
    btn.className = 'secondary-btn';
    btn.type = 'button';
    btn.style = "display: none; margin-top: 8px; font-size: 11px; padding: 4px 8px; width: 100%; box-sizing: border-box;";
    btn.textContent = '位置を再調整';
    parent.after(btn);
    adjustBtn = btn;
  }

  nameInput.value = char ? char.name : '';
  if (categoryInput) categoryInput.value = char ? char.category || '' : '';
  if (tagsInput) tagsInput.value = char && char.tags ? char.tags.join(', ') : '';
  descInput.value = char ? char.description || '' : '';
  persInput.value = char ? char.personality || '' : '';
  exInput.value = char ? char.mes_example || '' : '';
  imgInput.value = '';
  previewImg.style.transform = 'none'; 
  if (adjustBtn) adjustBtn.style.display = 'none'; 
  
  let currentAvatarAssetId = char ? char.avatarAssetId : '';
  previewImg.src = await getAvatarUrl(currentAvatarAssetId);
  titleEl.textContent = char ? 'キャラクター設定編集' : '新規キャラクター登録';

  let currentOriginalFile = null;
  let newFileBlob = null;

  imgInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      currentOriginalFile = file; 
      showAvatarCropModal(file, (croppedBlob) => {
        newFileBlob = croppedBlob;
        previewImg.src = URL.createObjectURL(croppedBlob); 
        if (adjustBtn) adjustBtn.style.display = 'inline-flex'; 
      });
    }
  };

  if (adjustBtn) {
    adjustBtn.onclick = () => {
      if (currentOriginalFile) {
        showAvatarCropModal(currentOriginalFile, (croppedBlob) => {
          newFileBlob = croppedBlob;
          previewImg.src = URL.createObjectURL(croppedBlob);
        });
      }
    };
  }

  saveBtn.onclick = async () => {
    if (!nameInput.value.trim()) { alert('キャラクター名を入力してください。'); return; }
    try {
      if (newFileBlob) {
        if (currentAvatarAssetId) await db.deleteAsset(currentAvatarAssetId);
        currentAvatarAssetId = await db.saveAsset(newFileBlob, 'image/jpeg');
      }
      const characterData = {
        characterId: char ? char.characterId : undefined,
        name: nameInput.value.trim(),
        category: categoryInput ? categoryInput.value.trim() : '',
        tags: tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t.length > 0) : [],
        avatarAssetId: currentAvatarAssetId,
        description: descInput.value.trim(),
        personality: persInput.value.trim(),
        mes_example: exInput.value.trim()
      };
      const savedCharacterId = await db.saveCharacter(characterData);
      const updatedChars = await db.getCharacters();
      updateState({ characters: updatedChars });
      modal.classList.add('hidden');
      renderCharacterLibrary();
      renderSidebar();
      requestDropboxAutoSync(null, {
        syncCharacters: true,
        characterIds: savedCharacterId ? [savedCharacterId] : [],
        assetIds: currentAvatarAssetId ? [currentAvatarAssetId] : []
      });
    } catch (err) {
      alert(`保存に失敗しました: ${err.message}`);
    }
  };

  modal.classList.remove('hidden');
}

async function exportCharacterJSON(char) {
  try {
    const exportObj = {
      spec: 'zetatavern-character', version: 1, name: char.name, category: char.category || '',
      tags: char.tags || [], description: char.description || '', personality: char.personality || '',
      mes_example: char.mes_example || '', avatarBase64: ''
    };
    if (char.avatarAssetId) {
      const blob = await db.getAssetBlob(char.avatarAssetId);
      if (blob) exportObj.avatarBase64 = await db.blobToBase64(blob);
    }
    const jsonStr = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${char.name}_card.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert(`エクスポートに失敗しました: ${err.message}`); }
}

function normalizeImportedTags(value, defaults = []) {
  if (Array.isArray(value)) {
    return value.map(tag => String(tag || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  return Array.isArray(defaults) ? defaults : [];
}

function normalizeImportedCharacterEntry(importObj, defaults = {}) {
  if (!importObj || typeof importObj !== 'object') {
    return null;
  }

  const defaultCategory = (defaults.category || '').trim();
  const defaultTags = Array.isArray(defaults.tags) ? defaults.tags : [];

  let charData = {
    name: '名称未設定',
    category: defaultCategory,
    tags: [...defaultTags],
    description: '',
    personality: '',
    mes_example: '',
    avatarBase64: ''
  };

  if (importObj.spec === 'zetatavern-character') {
    charData.name = importObj.name || charData.name;
    charData.category = importObj.category || charData.category;
    charData.tags = normalizeImportedTags(importObj.tags, charData.tags);
    charData.description = importObj.description || '';
    charData.personality = importObj.personality || '';
    charData.mes_example = importObj.mes_example || '';
    charData.avatarBase64 = importObj.avatarBase64 || '';
  } else if (importObj.spec === 'chara_card_v2' || importObj.spec === 'chara_card_v3') {
    const data = importObj.data || {};
    charData.name = data.name || charData.name;
    charData.category = data.category || data.first_mes_category || charData.category;
    charData.tags = normalizeImportedTags(data.tags, charData.tags);
    charData.description = data.description || '';

    let combinedPersonality = data.personality || '';
    if (data.system_prompt) combinedPersonality += `\n\n【システム設定】\n${data.system_prompt}`;
    if (data.creator_notes) combinedPersonality += `\n\n【クリエイターノート】\n${data.creator_notes}`;

    charData.personality = combinedPersonality.trim();
    charData.mes_example = data.mes_example || '';
  } else if (importObj.name && importObj.description !== undefined) {
    charData.name = importObj.name || charData.name;
    charData.category = importObj.category || charData.category;
    charData.tags = normalizeImportedTags(importObj.tags, charData.tags);
    charData.description = importObj.description || '';
    charData.personality = importObj.personality || '';
    charData.mes_example = importObj.mes_example || '';
    charData.avatarBase64 = importObj.avatarBase64 || '';
  } else {
    return null;
  }

  if (!charData.name || !String(charData.name).trim()) {
    return null;
  }

  charData.name = String(charData.name).trim();
  charData.category = String(charData.category || '').trim();
  charData.tags = normalizeImportedTags(charData.tags, []);
  charData.description = String(charData.description || '').trim();
  charData.personality = String(charData.personality || '').trim();
  charData.mes_example = String(charData.mes_example || '').trim();
  charData.avatarBase64 = String(charData.avatarBase64 || '').trim();
  return charData;
}

function extractCharacterEntriesFromImport(importObj, defaults = {}) {
  if (Array.isArray(importObj)) {
    return importObj.map(item => normalizeImportedCharacterEntry(item, defaults)).filter(Boolean);
  }

  if (!importObj || typeof importObj !== 'object') {
    throw new Error('JSON の形式が不正です。');
  }

  if ((importObj.spec === 'zetatavern-characterbook' || importObj.spec === 'zetatavern-characters') && Array.isArray(importObj.entries)) {
    return importObj.entries.map(item => normalizeImportedCharacterEntry(item, defaults)).filter(Boolean);
  }

  if (Array.isArray(importObj.entries)) {
    return importObj.entries.map(item => normalizeImportedCharacterEntry(item, defaults)).filter(Boolean);
  }

  const single = normalizeImportedCharacterEntry(importObj, defaults);
  return single ? [single] : [];
}

async function importCharacterEntries(entries, defaults = {}) {
  let importedCount = 0;
  let withAvatarCount = 0;
  const importedNames = [];
  const importedCharacterIds = [];
  const importedAssetIds = [];

  for (const entry of entries) {
    const tags = normalizeImportedTags(entry.tags, defaults.tags || []);
    const charData = {
      name: entry.name,
      category: defaults.forceCategory ? defaults.category : (entry.category || defaults.category || ''),
      tags: defaults.forceTags ? [...(defaults.tags || [])] : tags,
      description: entry.description || '',
      personality: entry.personality || '',
      mes_example: entry.mes_example || '',
      avatarAssetId: ''
    };

    if (entry.avatarBase64) {
      const blob = db.base64ToBlob(entry.avatarBase64);
      charData.avatarAssetId = await db.saveAsset(blob, blob.type);
      importedAssetIds.push(charData.avatarAssetId);
      withAvatarCount += 1;
    }

    const savedCharacterId = await db.saveCharacter(charData);
    importedCount += 1;
    importedCharacterIds.push(savedCharacterId);
    importedNames.push(charData.name);
  }

  const updatedChars = await db.getCharacters();
  updateState({ characters: updatedChars });
  renderCharacterLibrary();
  renderSidebar();
  requestDropboxAutoSync(null, {
    syncCharacters: true,
    characterIds: importedCharacterIds,
    assetIds: importedAssetIds
  });

  return { importedCount, withAvatarCount, importedNames };
}

function buildCharacterImportDefaults(options = {}) {
  const { currentStory } = getState();
  const storyFranchise = currentStory?.franchise || '';
  const category = (options.category ?? storyFranchise ?? '').trim();
  const tags = normalizeImportedTags(options.tags, category ? [category] : []);
  return {
    category,
    tags,
    forceCategory: !!options.forceCategory,
    forceTags: !!options.forceTags
  };
}

export async function importCharacterJSON(file) {
  try {
    const text = await file.text();
    const importObj = JSON.parse(text);
    const defaults = buildCharacterImportDefaults();
    const entries = extractCharacterEntriesFromImport(importObj, defaults);
    if (entries.length === 0) {
      throw new Error('キャラクターデータが見つかりませんでした。\n対応フォーマット: ZetaTavern, V2, V3, V1 JSON');
    }

    const result = await importCharacterEntries(entries, defaults);
    alert(`キャラクターを取り込みました。\n新規追加: ${result.importedCount}件\n画像付き: ${result.withAvatarCount}件\n\n対象: ${result.importedNames.slice(0, 10).join(' / ')}${result.importedNames.length > 10 ? ' ...' : ''}\n\n（※画像がない項目は、編集画面からアバターを手動設定できます）`);
  } catch (err) {
    alert(`取り込みに失敗しました:\n${err.message}\n\n※正しいキャラクターカードのJSONファイルを選択してください。`);
  }
}

export function showCharacterPasteModal() {
  let modal = document.getElementById('character-paste-modal');
  if (modal) modal.remove();

  const defaults = buildCharacterImportDefaults();

  modal = document.createElement('div');
  modal.id = 'character-paste-modal';
  modal.className = 'modal-wrapper';
  modal.style.zIndex = '5000';
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content" style="max-width: 720px; width: 92%;">
      <div class="modal-header">
        <h3>キャラクターJSONを貼り付け</h3>
        <button id="character-paste-close-btn" class="icon-btn-circle" type="button">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div class="lore-search-intro">
          <span class="material-symbols-outlined">content_paste_go</span>
          <p>外部AIが出力した <code>json</code> コードブロックを、そのまま貼り付けてキャラクター登録できます。</p>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label for="character-paste-category-input">既定のカテゴリ / 作品名</label>
            <input type="text" id="character-paste-category-input" value="${escapeHTML(defaults.category)}" placeholder="例: リゼロ">
          </div>
          <div class="form-group">
            <label for="character-paste-tags-input">既定のタグ</label>
            <input type="text" id="character-paste-tags-input" value="${escapeHTML((defaults.tags || []).join(', '))}" placeholder="例: リゼロ, ヒロイン">
          </div>
        </div>
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-sub);">
          <input id="character-paste-force-category-checkbox" type="checkbox">
          <span>貼り付け内容のカテゴリより、上のカテゴリ / タグを優先して登録する</span>
        </label>
        <div class="form-group">
          <label for="character-paste-textarea">貼り付け内容</label>
          <textarea id="character-paste-textarea" rows="16" style="width:100%; resize: vertical;" placeholder='jsonコード、またはコードブロックをそのまま貼り付け'></textarea>
        </div>
        <details style="font-size: 12px; color: var(--text-sub);">
          <summary>対応形式</summary>
          <div style="margin-top: 8px; line-height: 1.7;">
            <div>- <code>zetatavern-character</code></div>
            <div>- <code>chara_card_v2</code> / <code>chara_card_v3</code></div>
            <div>- 旧式 V1 形式</div>
            <div>- <code>entries</code> 配列つきの複数キャラ JSON</div>
            <div>- キャラ配列の直貼り</div>
          </div>
        </details>
      </div>
      <div class="modal-footer">
        <button id="character-paste-cancel-btn" class="secondary-btn" type="button">キャンセル</button>
        <button id="character-paste-submit-btn" class="primary-btn" type="button">取り込む</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector('#character-paste-close-btn')?.addEventListener('click', closeModal);
  modal.querySelector('#character-paste-cancel-btn')?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.classList.contains('modal-overlay')) closeModal();
  });

  const textarea = modal.querySelector('#character-paste-textarea');
  textarea?.focus();

  modal.querySelector('#character-paste-submit-btn')?.addEventListener('click', async () => {
    const rawText = textarea?.value || '';
    const jsonText = stripCodeFence(rawText);
    if (!jsonText) {
      alert('JSONコードを貼り付けてください。');
      return;
    }

    const category = modal.querySelector('#character-paste-category-input')?.value.trim() || '';
    const tags = normalizeImportedTags(modal.querySelector('#character-paste-tags-input')?.value || '', category ? [category] : []);
    const forceCategory = !!modal.querySelector('#character-paste-force-category-checkbox')?.checked;

    try {
      const parsed = JSON.parse(jsonText);
      const defaults = buildCharacterImportDefaults({ category, tags, forceCategory, forceTags: forceCategory });
      const entries = extractCharacterEntriesFromImport(parsed, defaults);
      if (entries.length === 0) {
        alert('取り込めるキャラクターデータが見つかりませんでした。name や entries を確認してください。');
        return;
      }

      const result = await importCharacterEntries(entries, defaults);
      closeModal();
      alert(`キャラクターを取り込みました。\n新規追加: ${result.importedCount}件\n画像付き: ${result.withAvatarCount}件\n\n対象: ${result.importedNames.slice(0, 10).join(' / ')}${result.importedNames.length > 10 ? ' ...' : ''}`);
    } catch (err) {
      alert(`貼り付け内容の取り込みに失敗しました:\n${err.message}\n\n※ コードブロック形式のままでも取り込めます。`);
    }
  });
}

export async function importLoreJSON(files) {
  const fileList = Array.from(files || []).filter(Boolean);
  if (fileList.length === 0) return;

  const defaults = buildLoreImportDefaults();

  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const importedNames = [];
  const touchedFranchises = new Set();

  try {
    for (const file of fileList) {
      const text = await file.text();
      const importObj = JSON.parse(text);
      const entries = extractLoreEntriesFromImport(importObj, defaults);

      if (entries.length === 0) {
        skippedCount += 1;
        continue;
      }

      const result = await importLoreEntries(entries, defaults);
      importedCount += result.importedCount;
      updatedCount += result.updatedCount;
      importedNames.push(...result.importedNames);
      for (const franchise of result.touchedFranchises || []) {
        touchedFranchises.add(franchise);
      }
    }

    await renderLorebook('world');
    requestDropboxAutoSync(null, {
      syncLores: true,
      loreFranchises: [...touchedFranchises]
    });

    const headline = importedCount || updatedCount
      ? `ロアを取り込みました。`
      : `取り込めるロアが見つかりませんでした。`;
    const details = [
      `新規追加: ${importedCount}件`,
      `上書き更新: ${updatedCount}件`,
      skippedCount ? `スキップ: ${skippedCount}ファイル` : '',
      importedNames.length ? `対象: ${importedNames.slice(0, 8).join(' / ')}${importedNames.length > 8 ? ' ...' : ''}` : ''
    ].filter(Boolean).join('\n');

    alert(`${headline}\n${details}\n\n対応形式:\n- zetatavern-lore\n- zetatavern-lorebook\n- entries 配列つきの汎用 JSON`);
  } catch (err) {
    alert(`ロアJSONの取り込みに失敗しました:\n${err.message}\n\n※ name / franchise / summary などを含む JSON を選択してください。`);
  }
}

export function showLorePasteModal() {
  let modal = document.getElementById('lore-paste-modal');
  if (modal) modal.remove();

  const { currentStory } = getState();
  const defaultFranchise = currentStory?.franchise || '';
  const defaultSearchContext = currentStory?.franchiseContext || currentStory?.franchise || '';

  modal = document.createElement('div');
  modal.id = 'lore-paste-modal';
  modal.className = 'modal-wrapper';
  modal.style.zIndex = '5000';
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content" style="max-width: 720px; width: 92%;">
      <div class="modal-header">
        <h3>ロアJSONを貼り付け</h3>
        <button id="lore-paste-close-btn" class="icon-btn-circle" type="button">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div class="lore-search-intro">
          <span class="material-symbols-outlined">content_paste_go</span>
          <p>外部AIが出力した <code>json</code> コードブロックを、そのまま貼り付けて取り込めます。</p>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label for="lore-paste-franchise-input">既定の作品名</label>
            <input type="text" id="lore-paste-franchise-input" value="${escapeHTML(defaultFranchise)}" placeholder="例: リゼロ">
          </div>
          <div class="form-group">
            <label for="lore-paste-search-context-input">検索用作品名・別名</label>
            <input type="text" id="lore-paste-search-context-input" value="${escapeHTML(defaultSearchContext)}" placeholder="例: Re:ゼロから始める異世界生活">
          </div>
        </div>
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-sub);">
          <input id="lore-paste-force-franchise-checkbox" type="checkbox">
          <span>貼り付け内容の作品名より、上の作品名を優先して登録する</span>
        </label>
        <div class="form-group">
          <label for="lore-paste-textarea">貼り付け内容</label>
          <textarea id="lore-paste-textarea" rows="16" style="width:100%; resize: vertical;" placeholder='jsonコード、またはコードブロックをそのまま貼り付け'></textarea>
        </div>
        <details style="font-size: 12px; color: var(--text-sub);">
          <summary>対応形式</summary>
          <div style="margin-top: 8px; line-height: 1.7;">
            <div>- <code>zetatavern-lore</code></div>
            <div>- <code>zetatavern-lorebook</code></div>
            <div>- <code>entries</code> 配列つきの JSON</div>
            <div>- ロア配列の直貼り</div>
            <div>- <code>type: "person"</code> は自動で登場人物に変換</div>
          </div>
        </details>
      </div>
      <div class="modal-footer">
        <button id="lore-paste-cancel-btn" class="secondary-btn" type="button">キャンセル</button>
        <button id="lore-paste-submit-btn" class="primary-btn" type="button">取り込む</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector('#lore-paste-close-btn')?.addEventListener('click', closeModal);
  modal.querySelector('#lore-paste-cancel-btn')?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.classList.contains('modal-overlay')) closeModal();
  });

  const textarea = modal.querySelector('#lore-paste-textarea');
  textarea?.focus();

  modal.querySelector('#lore-paste-submit-btn')?.addEventListener('click', async () => {
    const rawText = textarea?.value || '';
    const jsonText = stripCodeFence(rawText);
    if (!jsonText) {
      alert('JSONコードを貼り付けてください。');
      return;
    }

    const franchise = modal.querySelector('#lore-paste-franchise-input')?.value.trim() || '';
    const searchContext = modal.querySelector('#lore-paste-search-context-input')?.value.trim() || franchise;
    const forceFranchise = !!modal.querySelector('#lore-paste-force-franchise-checkbox')?.checked;

    try {
      const parsed = JSON.parse(jsonText);
      const defaults = buildLoreImportDefaults({ franchise, searchContext, forceFranchise });
      const entries = extractLoreEntriesFromImport(parsed, defaults);
      if (entries.length === 0) {
        alert('取り込めるロアが見つかりませんでした。name や entries を確認してください。');
        return;
      }

      const result = await importLoreEntries(entries, defaults);
      await renderLorebook('world');
      requestDropboxAutoSync(currentStory?.storyId || null, {
        syncLores: true,
        loreFranchises: result.touchedFranchises
      });
      closeModal();

      alert(`ロアを取り込みました。\n新規追加: ${result.importedCount}件\n上書き更新: ${result.updatedCount}件\n\n対象: ${result.importedNames.slice(0, 10).join(' / ')}${result.importedNames.length > 10 ? ' ...' : ''}`);
    } catch (err) {
      alert(`貼り付け内容の取り込みに失敗しました:\n${err.message}\n\n※ コードブロック形式のままでも取り込めます。`);
    }
  });
}

export async function showStorySettingsModal() {
  const { currentStory } = getState();
  if (!currentStory) return;

  let modal = document.getElementById('story-settings-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'story-settings-modal';
  
  const pAvatarUrl = await getAvatarUrl(currentStory.protagonist?.avatarAssetId);

  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  modal.style.zIndex = '3000';

  modal.innerHTML = `
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 550px; max-height: 85vh; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,0.15); overflow: hidden;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 10px; margin-bottom: 16px;">
        <h3 style="margin: 0;">ストーリー設定</h3>
        <button id="story-settings-close-btn" style="background: none; border: none; font-size: 24px; cursor: pointer; color: inherit;">&times;</button>
      </div>
      <div data-story-settings-scroll-body="true" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding-right: 4px;">
        <fieldset style="border: 1px solid var(--border-color, #ddd); padding: 12px; border-radius: 6px;">
          <legend style="padding: 0 6px; font-weight: bold; font-size: 13px;">主人公設定</legend>
          <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
            <div style="text-align: center;">
              <div style="width: 70px; height: 70px; border-radius: 50%; overflow: hidden; border: 2px solid var(--primary-color, #4a90e2); display: flex; justify-content: center; align-items: center; background: #eee;">
                <img id="story-p-avatar-preview" src="${pAvatarUrl}" style="display: block; width: 100%; height: 100%; object-fit: cover;" alt="Avatar">
              </div>
              <label for="story-p-avatar-input" style="font-size: 11px; cursor: pointer; color: var(--primary-color, #4a90e2); text-decoration: underline; display: block; margin-top: 4px;">画像を変更</label>
              <input type="file" id="story-p-avatar-input" accept="image/*" style="display: none;">
            </div>
            <div style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
              <label style="font-size: 11px; font-weight: bold;">名前</label>
              <input type="text" id="story-p-name-input" value="${escapeHTML(currentStory.protagonist?.name || '')}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
            </div>
          </div>
          <div id="story-p-adjust-btn-container" style="text-align: left; margin-bottom: 8px;"></div>
          <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 8px;">
            <label style="font-size: 11px; font-weight: bold;">詳細・性格・容姿</label>
            <textarea id="story-p-desc-input" rows="2" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; overflow-y: hidden; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">${escapeHTML(currentStory.protagonist?.description || '')}</textarea>
          </div>
        </fieldset>

        <fieldset style="border: 1px solid var(--border-color, #ddd); padding: 12px; border-radius: 6px; margin-top: 12px; margin-bottom: 12px;">
          <legend style="padding: 0 6px; font-weight: bold; font-size: 13px;">🎬 AIディレクター設定（演出傾向）</legend>
          
          <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px;">
            <label style="font-size: 12px; font-weight: bold;">プリセット (Preset)</label>
            <select id="director-preset-select" style="padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; background: var(--bg-input, transparent); color: inherit;">
              <option value="custom">⚙️ カスタム (手動調整)</option>
              ${Object.entries(DIRECTOR_PRESETS).map(([key, p]) => `<option value="${key}">${p.label}</option>`).join('')}
            </select>
            <div id="director-preset-desc" style="font-size: 11px; color: var(--text-sub); min-height: 14px;"></div>
          </div>

          <div id="director-sliders-container" style="display: flex; flex-direction: column; gap: 12px;">
            ${DIRECTOR_PARAMS.map(p => `
              <div style="display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: bold;">
                  <span>${p.label}</span>
                  <span id="val-${p.id}">50</span>
                </div>
                <input type="range" id="slider-${p.id}" class="director-slider" data-id="${p.id}" min="0" max="100" value="50">
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-sub);">
                  <span>${p.minLabel}</span><span>${p.maxLabel}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </fieldset>


        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">作品名タグ (Franchise)</label>
          <input type="text" id="story-franchise-modal-input" value="${escapeHTML(currentStory.franchise || '')}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">検索用作品名・別名</label>
          <input type="text" id="story-franchise-context-modal-input" value="${escapeHTML(currentStory.franchiseContext || '')}" placeholder="例: リゼロ / Re:ゼロから始める異世界生活" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">画像ベースURL</label>
          <input type="text" id="story-image-base-url-modal-input" value="${escapeHTML(currentStory.imageBaseUrl || '')}" placeholder="例: https://aquamarine-torte-953693.netlify.app" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">既定衣装名</label>
          <input type="text" id="story-image-default-outfit-modal-input" value="${escapeHTML(currentStory.imageDefaultOutfit || '')}" placeholder="例: 初期衣装" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">世界観設定・あらすじ</label>
          <textarea id="story-world-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; overflow-y: hidden; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">${escapeHTML(currentStory.worldPrompt || '')}</textarea>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーのタグ (カンマ区切り)</label>
          <input type="text" id="story-tags-input" value="${escapeHTML(currentStory.tags ? currentStory.tags.join(', ') : '')}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーテラーへの指示（執筆ルール）</label>
          <textarea id="story-prompt-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; overflow-y: hidden; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">${escapeHTML(currentStory.storytellerPrompt || '')}</textarea>
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; border-top: 1px solid var(--border-color, #eee); padding-top: 12px;">
        <button id="story-settings-cancel-btn" class="secondary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">キャンセル</button>
        <button id="story-settings-save-btn" class="primary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">設定を保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Auto-resize logic for settings textareas
  const textareas = modal.querySelectorAll('textarea');
  const modalScrollBody = modal.querySelector('[data-story-settings-scroll-body="true"]');
  textareas.forEach(ta => {
    const autoResize = () => {
      const previousScrollTop = modalScrollBody ? modalScrollBody.scrollTop : 0;
      const previousWindowScrollY = window.scrollY;
      ta.style.height = 'auto';
      if (ta.scrollHeight > 0) ta.style.height = ta.scrollHeight + 'px';
      if (modalScrollBody) modalScrollBody.scrollTop = previousScrollTop;
      if (window.scrollY !== previousWindowScrollY) {
        window.scrollTo(window.scrollX, previousWindowScrollY);
      }
    };
    ta.addEventListener('input', autoResize);
    setTimeout(autoResize, 0);
  });

  const closeBtn = modal.querySelector('#story-settings-close-btn');
  const cancelBtn = modal.querySelector('#story-settings-cancel-btn');
  const saveBtn = modal.querySelector('#story-settings-save-btn');
  const avatarInput = modal.querySelector('#story-p-avatar-input');
  const avatarPreview = modal.querySelector('#story-p-avatar-preview');
  const adjustBtnContainer = modal.querySelector('#story-p-adjust-btn-container');

  // --- ★ AIディレクターUIの連動処理 ---
  const presetSelect = modal.querySelector('#director-preset-select');
  const presetDesc = modal.querySelector('#director-preset-desc');
  const sliders = modal.querySelectorAll('.director-slider');
  
  // 現在の設定値を読み込む（なければデフォルトのラブコメ設定）
  const currentSettings = currentStory.directorSettings || DIRECTOR_PRESETS.romcom_subtle.params;
  
  // スライダーに初期値をセット
  sliders.forEach(slider => {
    const id = slider.dataset.id;
    slider.value = currentSettings[id] !== undefined ? currentSettings[id] : 50;
    modal.querySelector(`#val-${id}`).textContent = slider.value;
  });

  // プリセットが手動でいじられているか判定してセレクトボックスを合わせる
  const isMatchingPreset = Object.entries(DIRECTOR_PRESETS).find(([_, p]) => 
    Object.entries(p.params).every(([key, val]) => currentSettings[key] == val)
  );
  if (isMatchingPreset) {
    presetSelect.value = isMatchingPreset[0];
    presetDesc.textContent = isMatchingPreset[1].description;
  } else {
    presetSelect.value = 'custom';
    presetDesc.textContent = 'スライダーを手動で調整中...';
  }

  // スライダーを動かしたら「カスタム」に変更し、数値をリアルタイム更新
  sliders.forEach(slider => {
    slider.addEventListener('input', (e) => {
      modal.querySelector(`#val-${e.target.dataset.id}`).textContent = e.target.value;
      presetSelect.value = 'custom';
      presetDesc.textContent = 'スライダーを手動で調整中...';
    });
  });

  // プリセットを選んだら、スライダーの値を一斉に自動変更（スナップ）する
  presetSelect.addEventListener('change', (e) => {
    const presetKey = e.target.value;
    if (presetKey === 'custom') return;
    const pData = DIRECTOR_PRESETS[presetKey];
    presetDesc.textContent = pData.description;
    sliders.forEach(slider => {
      const id = slider.dataset.id;
      slider.value = pData.params[id];
      modal.querySelector(`#val-${id}`).textContent = slider.value;
    });
  });

  const closeModal = () => modal.remove();
  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;

  let newAvatarBlob = null;
  let currentOriginalFile = null;

  const adjustBtn = document.createElement('button');
  adjustBtn.id = 'story-p-adjust-crop-btn';
  adjustBtn.className = 'secondary-btn';
  adjustBtn.type = 'button';
  adjustBtn.style = "display: none; font-size: 11px; padding: 4px 8px; width: 100%; box-sizing: border-box;";
  adjustBtn.textContent = '位置を再調整';
  adjustBtnContainer.appendChild(adjustBtn);

  avatarInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      currentOriginalFile = file; 
      showAvatarCropModal(file, (croppedBlob) => {
        newAvatarBlob = croppedBlob;
        avatarPreview.src = URL.createObjectURL(croppedBlob);
        adjustBtn.style.display = 'inline-flex'; 
      });
    }
  };

  adjustBtn.onclick = () => {
    if (currentOriginalFile) {
      showAvatarCropModal(currentOriginalFile, (croppedBlob) => {
        newAvatarBlob = croppedBlob;
        avatarPreview.src = URL.createObjectURL(croppedBlob);
      });
    }
  };

saveBtn.onclick = async () => {
    const name = modal.querySelector('#story-p-name-input').value.trim();
    const desc = modal.querySelector('#story-p-desc-input').value.trim();
    const franchise = modal.querySelector('#story-franchise-modal-input').value.trim();
    const franchiseContext = modal.querySelector('#story-franchise-context-modal-input').value.trim();
    const imageBaseUrl = modal.querySelector('#story-image-base-url-modal-input').value.trim();
    const imageDefaultOutfit = modal.querySelector('#story-image-default-outfit-modal-input').value.trim();
    const world = modal.querySelector('#story-world-input').value.trim();
    const promptText = modal.querySelector('#story-prompt-input').value.trim();
    const tagsText = modal.querySelector('#story-tags-input').value.trim();
    
    // ★ スライダーの値をごっそり取得してJSON化
    const directorSettings = {};
    modal.querySelectorAll('.director-slider').forEach(slider => {
      directorSettings[slider.dataset.id] = parseInt(slider.value, 10);
    });

    try {
      let avatarAssetId = currentStory.protagonist?.avatarAssetId || '';
      if (newAvatarBlob) {
        if (avatarAssetId) await db.deleteAsset(avatarAssetId);
        avatarAssetId = await db.saveAsset(newAvatarBlob, 'image/jpeg');
      }

      currentStory.protagonist = { name: name || '主人公', description: desc, avatarAssetId: avatarAssetId };
      currentStory.franchise = franchise;
      currentStory.franchiseContext = franchiseContext;
      currentStory.imageBaseUrl = imageBaseUrl;
      currentStory.imageDefaultOutfit = imageDefaultOutfit;
      currentStory.worldPrompt = world;
      currentStory.storytellerPrompt = promptText;
      currentStory.tags = tagsText ? tagsText.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
      currentStory.characters = buildStoryCharacterRefs(currentStory, await db.getCharacters());
      
      // ★ 保存（前回のmomentumやworldToneは廃止し、これに統合）
      currentStory.directorSettings = directorSettings;

      await db.saveStory(currentStory);
      const updatedStories = await db.getStories();
      updateState({ stories: updatedStories });
      requestDropboxAutoSync(currentStory.storyId, {
        syncStory: true,
        assetIds: avatarAssetId ? [avatarAssetId] : []
      });
      closeModal();
      renderStoryList();
      renderSidebar();
      renderStory();
    } catch (err) {
      alert(`保存に失敗しました: ${err.message}`);
    }
  };
}

export function applyFontSize(size) {
  const numSize = parseFloat(size) || 15;
  const root = document.documentElement;
  root.style.setProperty('--chat-font-size', `${numSize}px`);
  root.style.setProperty('--narration-font-size', `${Math.max(10, numSize - 0.5)}px`);
  root.style.setProperty('--ui-font-size', `${Math.max(10, numSize - 2)}px`);
}

export function applyNarrationStyles(bgColor, textColor, opacityPercent) {
  const root = document.documentElement;
  let finalBg = bgColor || '#f3f5f8';
  if (opacityPercent !== undefined && finalBg.startsWith('#') && finalBg.length === 7) {
    const r = parseInt(finalBg.slice(1, 3), 16) || 243;
    const g = parseInt(finalBg.slice(3, 5), 16) || 245;
    const b = parseInt(finalBg.slice(5, 7), 16) || 248;
    finalBg = `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
  }
  root.style.setProperty('--narration-bg', finalBg);
  root.style.setProperty('--narration-text', textColor || '#323232');
}

// ★ 追加：Google無料翻訳APIを利用した簡易翻訳機能
window.translateAiThought = async (btnEl, msgIndex) => {
  const container = btnEl.closest('.ai-thought-container');
  const textEl = container.querySelector('.ai-thought-content');
  const originalText = textEl.dataset.originalText;
  
  if (textEl.dataset.translated === 'true') {
    // 既に翻訳済みの場合は元に戻す
    textEl.textContent = originalText;
    textEl.dataset.translated = 'false';
    btnEl.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">translate</span> 翻訳する';
    return;
  }

  btnEl.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px; animation: spin 1s linear infinite;">sync</span> 翻訳中...';
  btnEl.disabled = true;

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(originalText)}`;
    const res = await fetch(url);
    const data = await res.json();
    const translatedText = data[0].map(item => item[0]).join('');
    
    textEl.textContent = translatedText;
    textEl.dataset.translated = 'true';
    btnEl.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">history</span> 原文に戻す';
  } catch (e) {
    alert('翻訳に失敗しました。');
    btnEl.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">translate</span> 翻訳する';
  } finally {
    btnEl.disabled = false;
  }
};

const styleInject = document.createElement('style');
styleInject.textContent = `
  :root {
    --chat-font-size: 15px;
    --narration-font-size: 14.5px;
    --ui-font-size: 13px;
    --narration-bg: rgba(243, 245, 248, 0.8);
    --narration-text: #323232;
  }
  .chat-speech, .novel-block, .chat-bubble p { font-size: var(--chat-font-size) !important; }
  .narration-content, .chat-narration { font-size: var(--narration-font-size) !important; }
  .chat-sender-name, .novel-action-badge { font-size: var(--ui-font-size) !important; }
  .chat-narration { display: flex; justify-content: flex-start; width: 100%; box-sizing: border-box; margin: 14px 0 !important; }
  .narration-content { padding-left: 62px !important; padding-right: 16px !important; padding-top: 8px !important; padding-bottom: 8px !important; width: 100%; max-width: 82% !important; box-sizing: border-box !important; line-height: 1.75 !important; letter-spacing: 0.03em !important; color: var(--narration-text) !important; background-color: var(--narration-bg) !important; border-left: 4px solid var(--primary-color, #4a90e2) !important; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.01); }
  .narration-content p { margin: 0 !important; }
  .chat-bubble p { line-height: 1.65 !important; margin-bottom: 8px !important; }
  .chat-bubble p:last-child { margin-bottom: 0 !important; }
  
  /* メッセージアクションとラッパーのCSS設定 */
  .message-wrapper { position: relative; width: 100%; display: flex; flex-direction: column; }
  .message-content-container { width: 100%; }
  .chat-message-actions { position: absolute; top: 0px; right: 8px; display: none; gap: 4px; background: var(--bg-card, #fff); padding: 4px 6px; border-radius: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); border: 1px solid var(--border-color, #eee); z-index: 10; }
  .message-wrapper:hover .chat-message-actions { display: flex; }
  .action-icon-btn { background: none; border: none; cursor: pointer; color: var(--text-color, #333); opacity: 0.5; padding: 2px 4px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
  .action-icon-btn:hover { opacity: 1; color: var(--primary-color, #4a90e2); }

  @media (min-width: 1024px) {
    .timeline-container { max-width: 800px !important; margin: 0 auto !important; width: 100% !important; display: flex !important; flex-direction: column !important; box-sizing: border-box !important; }
    #story-viewport { border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)) !important; border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)) !important; }
  }
  @media (max-width: 1023px) {
    #story-viewport { padding: 12px 8px !important; }
    .chat-message { margin-bottom: 14px !important; gap: 10px !important; }
    .chat-avatar { width: 56px !important; height: 56px !important; border-radius: 10px !important; }
    .chat-content-wrapper { max-width: calc(100% - 66px) !important; }
    .chat-panel-header { min-height: 30px !important; padding: 7px 12px !important; }
    .chat-bubble { padding: 12px 12px 13px !important; max-width: 100% !important; }
    .narration-content { padding-left: 48px !important; max-width: 95% !important; font-size: 0.95em !important; }
    
    /* モバイル向けアクションボタンの常時薄表示対応 */
    .chat-message-actions { display: flex; opacity: 0.2; top: -8px; right: 0px; }
    .message-wrapper:active .chat-message-actions, .chat-message-actions:active { opacity: 1; }
  }
  @media (prefers-color-scheme: dark) {
    .chat-narration { color: rgba(225, 228, 232, 0.95) !important; background-color: rgba(30, 34, 42, 0.7) !important; border-left: 4px solid var(--primary-light, #64b5f6) !important; }
  }
    /* ★追加: テキストの折り返しと幅の計算を正常化する */
  .chat-content-wrapper {
    flex: 1;
    min-width: 0;
  }
  .chat-message-dialogue .chat-content-wrapper {
    flex: 0 1 auto !important;
    width: fit-content !important;
    max-width: min(100%, 680px) !important;
  }
  .chat-message-dialogue .chat-adv-panel {
    width: fit-content !important;
    min-width: min(240px, 100%) !important;
    max-width: 100% !important;
  }
  .chat-bubble p, .narration-content, .narration-content p, .chat-speech, .chat-action {
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    line-break: loose !important;
  }
`;
document.head.appendChild(styleInject);

// =========================================================================
// ロアブック画面のレンダリングと編集モーダル
// =========================================================================

// タイプ定義（ラベルとアイコン）
const LORE_TYPE_META = {
  character:    { label: '登場人物',       icon: 'person'        },
  location:     { label: '場所・地域',     icon: 'location_on'   },
  organization: { label: '組織・勢力',     icon: 'groups'        },
  term:         { label: '用語・世界観',   icon: 'book_2'        },
  event:        { label: '歴史・事件',     icon: 'event'         },
  item:         { label: 'アイテム・道具', icon: 'inventory_2'   },
};

const LORE_IMPORT_TYPE_VALUES = new Set(Object.keys(LORE_TYPE_META));
const LORE_IMPORT_TYPE_ALIASES = {
  person: 'character',
  people: 'character',
  human: 'character',
  人物: 'character',
  登場人物: 'character',
  character: 'character',
  place: 'location',
  area: 'location',
  region: 'location',
  地名: 'location',
  場所: 'location',
  location: 'location',
  faction: 'organization',
  group: 'organization',
  guild: 'organization',
  組織: 'organization',
  勢力: 'organization',
  organization: 'organization',
  world: 'term',
  lore: 'term',
  用語: 'term',
  世界観: 'term',
  term: 'term',
  history: 'event',
  incident: 'event',
  事件: 'event',
  歴史: 'event',
  event: 'event',
  artifact: 'item',
  tool: 'item',
  道具: 'item',
  アイテム: 'item',
  item: 'item'
};

function normalizeImportedLoreType(type) {
  const value = (type || '').trim().toLowerCase();
  const aliased = LORE_IMPORT_TYPE_ALIASES[value] || value;
  return LORE_IMPORT_TYPE_VALUES.has(aliased) ? aliased : 'term';
}

function resolveImportedLoreField(source, keys = []) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeImportedLoreEntry(rawEntry, defaults = {}) {
  const source = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
  const contentSource = source.content && typeof source.content === 'object' ? source.content : {};

  const rawName = resolveImportedLoreField(source, ['name', 'title', 'keyword', 'canonicalName', '名称', '名前']);
  const name = normalizeLoreEntryName(rawName);
  if (!name) return null;

  const franchise = resolveImportedLoreField(source, ['franchise', 'series', 'work', 'tag', '作品', '作品名']) ||
    defaults.franchise ||
    '共通';
  const searchContext = resolveImportedLoreField(source, ['searchContext', 'franchiseContext', 'context', '検索用作品名', '検索コンテキスト']) ||
    defaults.searchContext ||
    '';
  const summary = resolveImportedLoreField(contentSource, ['summary', 'overview', 'description', '概要', '説明']) ||
    resolveImportedLoreField(source, ['summary', 'overview', 'description', '概要', '説明']);
  const profile = resolveImportedLoreField(contentSource, ['profile', 'details', 'body', 'content', '詳細', '本文']) ||
    resolveImportedLoreField(source, ['profile', 'details', 'body', 'content', '詳細', '本文']);
  const speech = resolveImportedLoreField(contentSource, ['speech', 'tone', 'style', '口調', '話し方']) ||
    resolveImportedLoreField(source, ['speech', 'tone', 'style', '口調', '話し方']);
  const relationships = resolveImportedLoreField(contentSource, ['relationships', 'relations', '関係性', '関連']) ||
    resolveImportedLoreField(source, ['relationships', 'relations', '関係性', '関連']);

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id.trim() : undefined,
    franchise,
    searchContext,
    type: normalizeImportedLoreType(resolveImportedLoreField(source, ['type', 'category', 'loreType', '種類', 'カテゴリ'])),
    name,
    content: {
      summary,
      profile,
      speech,
      relationships
    },
    source: 'manual-import',
    verified: source.verified !== false,
    status: 'completed'
  };
}

function extractLoreEntriesFromImport(importObj, defaults = {}) {
  if (Array.isArray(importObj)) {
    return importObj.map(item => normalizeImportedLoreEntry(item, defaults)).filter(Boolean);
  }

  if (!importObj || typeof importObj !== 'object') {
    throw new Error('JSON の形式が不正です。');
  }

  if (importObj.spec === 'zetatavern-lorebook' && Array.isArray(importObj.entries)) {
    return importObj.entries.map(item => normalizeImportedLoreEntry(item, defaults)).filter(Boolean);
  }

  if (importObj.spec === 'zetatavern-lore') {
    const payload = importObj.entry && typeof importObj.entry === 'object' ? importObj.entry : importObj;
    const single = normalizeImportedLoreEntry(payload, defaults);
    return single ? [single] : [];
  }

  if (Array.isArray(importObj.entries)) {
    return importObj.entries.map(item => normalizeImportedLoreEntry(item, defaults)).filter(Boolean);
  }

  const single = normalizeImportedLoreEntry(importObj, defaults);
  return single ? [single] : [];
}

function stripCodeFence(text) {
  const raw = (text || '').trim();
  if (!raw) return '';

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : raw;
}

async function importLoreEntries(entries, defaults = {}) {
  let importedCount = 0;
  let updatedCount = 0;
  const importedNames = [];
  const touchedFranchises = new Set();

  for (const entry of entries) {
    const normalizedEntry = { ...entry };
    if (defaults.forceFranchise) {
      normalizedEntry.franchise = defaults.forceFranchise;
    }
    if (defaults.forceSearchContext) {
      normalizedEntry.searchContext = defaults.forceSearchContext;
    } else if (!normalizedEntry.searchContext && normalizedEntry.franchise) {
      normalizedEntry.searchContext = normalizedEntry.franchise;
    }

    const existing = await db.getLoreByNameAndFranchise(normalizedEntry.name, normalizedEntry.franchise);
    const itemToSave = existing
      ? {
        ...existing,
        ...normalizedEntry,
        id: existing.id,
        content: {
          summary: normalizedEntry.content?.summary || '',
          profile: normalizedEntry.content?.profile || '',
          speech: normalizedEntry.content?.speech || '',
          relationships: normalizedEntry.content?.relationships || ''
        }
      }
      : normalizedEntry;

    await db.saveLore(itemToSave);
    touchedFranchises.add(String(itemToSave.franchise || '共通').trim() || '共通');
    importedNames.push(normalizedEntry.name);
    if (existing) {
      updatedCount += 1;
    } else {
      importedCount += 1;
    }
  }

  return { importedCount, updatedCount, importedNames, touchedFranchises: [...touchedFranchises] };
}

function buildLoreExportEntries(lores = []) {
  return (Array.isArray(lores) ? lores : [])
    .filter(item => item?.name)
    .map(item => ({
      id: item.id,
      franchise: item.franchise || '共通',
      searchContext: item.searchContext || '',
      type: item.type || 'term',
      name: item.name,
      summary: item.content?.summary || '',
      profile: item.content?.profile || '',
      speech: item.content?.speech || '',
      relationships: item.content?.relationships || '',
      verified: item.verified !== false,
      source: item.source || 'manual',
      status: item.status || 'completed'
    }));
}

function downloadJsonExport(fileName, payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeExportFileName(value, fallback = 'lorebook') {
  const text = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

export async function showLoreExportModal() {
  let modal = document.getElementById('lore-export-modal');
  if (modal) modal.remove();

  const lores = await db.getWorldLores();
  const { currentStory } = getState();
  const grouped = new Map();
  for (const lore of lores) {
    const franchise = lore?.franchise || '共通';
    if (!grouped.has(franchise)) grouped.set(franchise, []);
    grouped.get(franchise).push(lore);
  }

  const currentFranchise = currentStory?.franchise || '';
  const currentCount = currentFranchise && grouped.has(currentFranchise)
    ? grouped.get(currentFranchise).length
    : 0;

  const rows = [...grouped.entries()]
    .sort((a, b) => {
      if (currentFranchise) {
        if (a[0] === currentFranchise) return -1;
        if (b[0] === currentFranchise) return 1;
      }
      return a[0].localeCompare(b[0], 'ja');
    })
    .map(([franchise, items]) => `
      <div class="lore-export-row">
        <div class="lore-export-row-main">
          <strong>${escapeHTML(franchise)}</strong>
          <span class="lore-candidate-chip">${items.length}件</span>
          ${currentFranchise && franchise === currentFranchise ? '<span class="lore-candidate-chip">現在の作品</span>' : ''}
        </div>
        <button class="secondary-btn lore-export-franchise-btn" type="button" data-franchise="${escapeHTML(franchise)}">
          書き出し
        </button>
      </div>
    `).join('');

  modal = document.createElement('div');
  modal.id = 'lore-export-modal';
  modal.className = 'modal-wrapper';
  modal.style.zIndex = '5000';
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content" style="max-width: 760px; width: 92%;">
      <div class="modal-header">
        <h3>ロアブックJSONを書き出し</h3>
        <button id="lore-export-close-btn" class="icon-btn-circle" type="button">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="modal-body" style="display:flex; flex-direction:column; gap: 14px;">
        <div class="lore-search-intro">
          <span class="material-symbols-outlined">archive</span>
          <p>分割同期の作業前バックアップ用に、ワールドロアを <code>zetatavern-lorebook</code> 形式でまとめて書き出せます。</p>
        </div>

        <div class="lore-export-actions">
          <button id="lore-export-all-btn" class="primary-btn" type="button">
            <span class="material-symbols-outlined">download</span>
            <span>全作品をまとめて書き出し</span>
          </button>
          ${currentFranchise ? `
            <button id="lore-export-current-btn" class="secondary-btn" type="button" ${currentCount === 0 ? 'disabled' : ''}>
              <span class="material-symbols-outlined">folder_zip</span>
              <span>現在の作品だけ書き出し</span>
            </button>
          ` : ''}
        </div>

        <div class="lore-export-list">
          ${rows || '<p style="opacity:0.7;">書き出せるワールドロアがまだありません。</p>'}
        </div>
      </div>
      <div class="modal-footer">
        <button id="lore-export-cancel-btn" class="secondary-btn" type="button">閉じる</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector('#lore-export-close-btn')?.addEventListener('click', closeModal);
  modal.querySelector('#lore-export-cancel-btn')?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.classList.contains('modal-overlay')) closeModal();
  });

  const exportEntries = (entries, franchiseLabel = '') => {
    const exportPayload = {
      spec: 'zetatavern-lorebook',
      version: 1,
      exportedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries: buildLoreExportEntries(entries)
    };
    const label = franchiseLabel ? sanitizeExportFileName(franchiseLabel, 'franchise') : 'all';
    downloadJsonExport(`lorebook_${label}.json`, exportPayload);
  };

  modal.querySelector('#lore-export-all-btn')?.addEventListener('click', () => {
    exportEntries(lores, 'all');
  });

  modal.querySelector('#lore-export-current-btn')?.addEventListener('click', () => {
    if (!currentFranchise || !grouped.has(currentFranchise)) return;
    exportEntries(grouped.get(currentFranchise), currentFranchise);
  });

  modal.querySelectorAll('.lore-export-franchise-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const franchise = btn.dataset.franchise || '';
      if (!franchise || !grouped.has(franchise)) return;
      exportEntries(grouped.get(franchise), franchise);
    });
  });
}

function buildLoreImportDefaults(options = {}) {
  const { currentStory } = getState();
  const franchise = (options.franchise ?? currentStory?.franchise ?? '').trim();
  const searchContext = (options.searchContext ?? currentStory?.franchiseContext ?? currentStory?.franchise ?? '').trim();
  return {
    franchise,
    searchContext,
    forceFranchise: options.forceFranchise ? franchise : '',
    forceSearchContext: options.forceFranchise ? searchContext : ''
  };
}

// 現在のロアブックタブモード
let currentLorebookMode = 'world';
let lorebookRenderVersion = 0;

/**
 * ロアブック画面のメインレンダラー。
 * @param {string|null} mode - 'world' | 'session' | null（現在のモードを維持）
 */
export async function renderLorebook(mode = null) {
  if (mode !== null) currentLorebookMode = mode;
  const renderVersion = ++lorebookRenderVersion;
  const container = document.getElementById('lorebook-viewport');
  if (!container) return;

  // タブUIのactive状態を更新
  const tabWorld = document.getElementById('lorebook-tab-world');
  const tabSession = document.getElementById('lorebook-tab-session');
  if (tabWorld) tabWorld.classList.toggle('active', currentLorebookMode === 'world');
  if (tabSession) tabSession.classList.toggle('active', currentLorebookMode === 'session');

  // 追加ボタン・フィルターバーの表示制御
  const addBtn = document.getElementById('lore-add-btn');
  const filtersRow = document.getElementById('lorebook-filters-row');
  if (currentLorebookMode === 'session') {
    if (addBtn) addBtn.style.display = 'none';
    if (filtersRow) filtersRow.style.display = 'none';
    await _renderSessionLore(container, renderVersion);
  } else {
    if (addBtn) addBtn.style.display = '';
    if (filtersRow) filtersRow.style.display = '';
    await _renderWorldLore(container, renderVersion);
  }
}

/**
 * 作品ロア（World Lore）を階層アコーディオンでレンダリングする。
 * フランチャイズ → ロアタイプ → 個別エントリーの階層構造。
 */
async function _renderWorldLore(container, renderVersion = 0) {
  const searchInput = document.getElementById('lore-search-input');
  const filterSelect = document.getElementById('lore-filter-select');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const filter = filterSelect ? filterSelect.value : 'all';
  const { currentStory } = getState();

  const allLore = await db.getWorldLores();
  if (renderVersion !== lorebookRenderVersion) return;
  const loreCandidates = Array.isArray(currentStory?.lore_candidates)
    ? currentStory.lore_candidates.filter(candidate => {
      const nameMatch = candidate.name && candidate.name.toLowerCase().includes(query);
      const summaryMatch = candidate.content?.summary && candidate.content.summary.toLowerCase().includes(query);
      const franchiseMatch = candidate.franchise && candidate.franchise.toLowerCase().includes(query);
      return !query || nameMatch || summaryMatch || franchiseMatch;
    })
    : [];

  // フィルタリング
  const filtered = allLore.filter(lore => {
    const nameMatch = lore.name && lore.name.toLowerCase().includes(query);
    const summaryMatch = lore.content?.summary && lore.content.summary.toLowerCase().includes(query);
    const franchiseMatch = lore.franchise && lore.franchise.toLowerCase().includes(query);
    const searchMatch = !query || nameMatch || summaryMatch || franchiseMatch;

    let statusMatch = true;
    if (filter === 'verified') statusMatch = lore.verified === true;
    else if (filter === 'unverified') statusMatch = lore.verified !== true;

    return searchMatch && statusMatch;
  });

  container.innerHTML = '';

  if (loreCandidates.length > 0) {
    container.appendChild(await _createLoreCandidateSection(loreCandidates, currentStory));
  }

  if (filtered.length === 0) {
    if (renderVersion !== lorebookRenderVersion) return;
    if (loreCandidates.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="material-symbols-outlined">auto_stories</span>
          <p>該当するロア設定が見つかりません</p>
          <p style="font-size:12px;opacity:0.6;">「新規ロア追加」ボタンから登録してください。</p>
        </div>`;
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <span class="material-symbols-outlined">inventory_2</span>
        <p>登録済みのワールドロアはまだありません</p>
        <p style="font-size:12px;opacity:0.6;">上の候補から採用するとここに追加されます。</p>`;
      container.appendChild(empty);
    }
    return;
  }

  // フランチャイズでグループ化（登録順を保ちながら出現順でソート）
  const franchiseMap = new Map();
  for (const lore of filtered) {
    const key = lore.franchise || '共通';
    if (!franchiseMap.has(key)) franchiseMap.set(key, []);
    franchiseMap.get(key).push(lore);
  }

  // 各フランチャイズのアコーディオンセクションを生成
  for (const [franchise, items] of franchiseMap) {
    if (renderVersion !== lorebookRenderVersion) return;
    const section = _createFranchiseSection(franchise, items);
    container.appendChild(section);
  }
}

async function _createLoreCandidateSection(candidates, currentStory) {
  const section = document.createElement('div');
  section.className = 'lore-candidate-section';

  const rowsHtml = candidates.map(candidate => {
    const meta = LORE_TYPE_META[candidate.type] || { label: candidate.type || '候補', icon: 'lightbulb' };
    return `
      <div class="lore-candidate-row" data-candidate-id="${escapeHTML(candidate.id)}">
        <div class="lore-candidate-main">
          <div class="lore-candidate-title-row">
            <span class="material-symbols-outlined lore-candidate-icon">${meta.icon}</span>
            <strong>${escapeHTML(candidate.name)}</strong>
            <span class="lore-candidate-chip">${escapeHTML(meta.label)}</span>
            <span class="lore-candidate-chip">${escapeHTML(candidate.franchise || '共通')}</span>
          </div>
          <p class="lore-candidate-summary">${escapeHTML(candidate.content?.summary || '候補の要約はありません。')}</p>
          ${candidate.content?.profile ? `<p class="lore-candidate-profile-preview">${escapeHTML(candidate.content.profile)}</p>` : ''}
        </div>
        <div class="lore-candidate-actions">
          <button class="secondary-btn lore-candidate-enrich-btn" type="button" data-id="${escapeHTML(candidate.id)}">
            詳細化
          </button>
          <button class="sidebar-session-link-btn lore-candidate-accept-btn" type="button" data-id="${escapeHTML(candidate.id)}">
            <span class="material-symbols-outlined">check</span>
            <span>採用</span>
          </button>
          <button class="secondary-btn lore-candidate-reject-btn" type="button" data-id="${escapeHTML(candidate.id)}">
            却下
          </button>
        </div>
      </div>`;
  }).join('');

  section.innerHTML = `
    <div class="lore-candidate-header">
      <div class="lore-candidate-heading">
        <span class="material-symbols-outlined">lightbulb</span>
        <h3>ロア候補</h3>
        <span class="lore-candidate-count">${candidates.length}件</span>
      </div>
      <div class="lore-candidate-toolbar">
        <p class="lore-candidate-help">内容を見てからワールドロアへ採用できます。会話からの自動追加は停止中です。</p>
        <button class="secondary-btn lore-candidate-clear-btn" type="button">一括却下</button>
      </div>
    </div>
    <div class="lore-candidate-list">${rowsHtml}</div>`;

  section.addEventListener('click', async e => {
    const clearBtn = e.target.closest('.lore-candidate-clear-btn');
    const enrichBtn = e.target.closest('.lore-candidate-enrich-btn');
    const acceptBtn = e.target.closest('.lore-candidate-accept-btn');
    const rejectBtn = e.target.closest('.lore-candidate-reject-btn');
    if (!clearBtn && !enrichBtn && !acceptBtn && !rejectBtn) return;
    if (!currentStory) return;

    if (clearBtn) {
      if (!confirm('ロア候補をすべて却下しますか？')) return;
      currentStory.lore_candidates = [];
      await db.saveStory(currentStory);
      const stories = await db.getStories();
      updateState({ stories });
      await renderLorebook('world');
      requestDropboxAutoSync(currentStory.storyId, { syncStory: true });
      return;
    }

    const candidateId = (enrichBtn || acceptBtn || rejectBtn).dataset.id;
    const allCandidates = Array.isArray(currentStory.lore_candidates) ? currentStory.lore_candidates : [];
    const candidate = allCandidates.find(item => item.id === candidateId);
    if (!candidate) return;

    if (enrichBtn) {
      showLoreEditModal(candidate, { fromCandidate: true });
      return;
    }

    if (acceptBtn) {
      await db.saveLore({
        franchise: candidate.franchise || '共通',
        type: candidate.type || 'term',
        name: candidate.name,
        content: {
          summary: candidate.content?.summary || '',
          profile: candidate.content?.profile || '',
          speech: candidate.content?.speech || '',
          relationships: candidate.content?.relationships || ''
        },
        source: candidate.source || 'story-derived',
        verified: false,
        status: 'completed'
      });
    }

    currentStory.lore_candidates = allCandidates.filter(item => item.id !== candidateId);
    await db.saveStory(currentStory);
    const stories = await db.getStories();
    updateState({ stories });
    await renderLorebook('world');
    requestDropboxAutoSync(currentStory.storyId, {
      syncStory: true,
      syncLores: !!acceptBtn,
      loreFranchises: acceptBtn ? [candidate.franchise || '共通'] : []
    });
  });

  return section;
}

/**
 * フランチャイズ単位のアコーディオンセクションDOMを生成する。
 * @param {string} franchise - フランチャイズ名
 * @param {Array} items - このフランチャイズのロアエントリー
 */
function _createFranchiseSection(franchise, items) {
  // タイプ別にグループ化
  const typeMap = new Map();
  for (const lore of items) {
    const t = lore.type || 'term';
    if (!typeMap.has(t)) typeMap.set(t, []);
    typeMap.get(t).push(lore);
  }

  // タイプグループのHTML生成
  const typeGroupsHTML = [...typeMap.entries()].map(([type, typeItems]) => {
    const meta = LORE_TYPE_META[type] || { label: type, icon: 'auto_stories' };
    const rowsHTML = typeItems.map(lore => {
      const isVerified = lore.verified === true;
      const verifiedIcon = isVerified
        ? `<span class="material-symbols-outlined" style="font-size:14px;color:var(--primary-color)" title="確認済み">verified</span>`
        : `<span class="material-symbols-outlined" style="font-size:14px;color:#ff9800" title="AI自動収集・未確認">warning</span>`;
      const summaryText = lore.content?.summary ? escapeHTML(lore.content.summary).substring(0, 80) + (lore.content.summary.length > 80 ? '…' : '') : '—';
      return `
        <div class="lore-item-row" data-lore-id="${escapeHTML(lore.id)}">
          <div class="lore-item-main">
            ${verifiedIcon}
            <span class="lore-item-name">${escapeHTML(lore.name)}</span>
            <span class="lore-item-summary">${summaryText}</span>
          </div>
          <div class="lore-item-actions">
            <button class="icon-btn-circle lore-edit-btn" title="編集" data-id="${escapeHTML(lore.id)}">
              <span class="material-symbols-outlined" style="font-size:18px">edit</span>
            </button>
            <button class="icon-btn-circle lore-delete-btn" title="削除" data-id="${escapeHTML(lore.id)}" data-name="${escapeHTML(lore.name)}" data-franchise="${escapeHTML(lore.franchise || '共通')}">
              <span class="material-symbols-outlined" style="font-size:18px">delete</span>
            </button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="lore-type-group">
        <div class="lore-type-header">
          <span class="material-symbols-outlined">${meta.icon}</span>
          <span>${escapeHTML(meta.label)}</span>
          <span class="lore-type-count">${typeItems.length}</span>
        </div>
        <div class="lore-type-items">${rowsHTML}</div>
      </div>`;
  }).join('');

  const section = document.createElement('div');
  section.className = 'lore-franchise-section';
  section.innerHTML = `
    <div class="lore-franchise-header">
      <span class="material-symbols-outlined lore-folder-icon">folder_open</span>
      <h3 class="lore-franchise-title">${escapeHTML(franchise)}</h3>
      <span class="lore-franchise-count">${items.length}件</span>
      <span class="material-symbols-outlined lore-chevron">expand_more</span>
    </div>
    <div class="lore-franchise-body">
      ${typeGroupsHTML}
    </div>`;

  // アコーディオン開閉
  section.querySelector('.lore-franchise-header').addEventListener('click', () => {
    const isCollapsed = section.classList.toggle('collapsed');
    const folderIcon = section.querySelector('.lore-folder-icon');
    if (folderIcon) folderIcon.textContent = isCollapsed ? 'folder' : 'folder_open';
  });

  // 編集・削除ボタンをイベント委譲でバインド
  section.addEventListener('click', async e => {
    const editBtn = e.target.closest('.lore-edit-btn');
    const deleteBtn = e.target.closest('.lore-delete-btn');
    if (editBtn) {
      const loreId = editBtn.dataset.id;
      const lore = await db.getLore(loreId);
      if (lore) showLoreEditModal(lore);
    } else if (deleteBtn) {
      const loreName = deleteBtn.dataset.name;
      const loreId = deleteBtn.dataset.id;
      const loreFranchise = deleteBtn.dataset.franchise || '共通';
      if (await confirmLoreDeletion(loreName)) {
        await recordSyncTombstone('lores', loreId, { name: loreName || '' });
        await db.deleteLore(loreId);
        renderLorebook();
        requestDropboxAutoSync(null, {
          forceFull: true,
          syncLores: true,
          loreFranchises: [loreFranchise]
        });
      }
    }
  });

  return section;
}

/**
 * セッションロア（現在のストーリー固有の進行状態）をレンダリングする。
 */
async function _renderSessionLore(container, renderVersion = 0) {
  const { getState } = await import('./state.js');
  const state = getState();
  const activeStory = state.currentStory;

  if (!activeStory) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined">play_circle</span>
        <p>アクティブなストーリーがありません</p>
        <p style="font-size:12px;opacity:0.6;">ストーリー画面でセッションを開始してください。</p>
      </div>`;
    return;
  }

  const sessionLore = {
    summary: '',
    summary_source: '',
    current_state: '',
    recent_turning_points: [],
    long_term_events: [],
    active_flags: [],
    open_threads: [],
    key_events: [],
    ...(activeStory.session_lore || {})
  };
  sessionLore.long_term_events = Array.isArray(sessionLore.long_term_events)
    ? sessionLore.long_term_events
    : (Array.isArray(sessionLore.key_events) ? sessionLore.key_events : []);
  sessionLore.active_flags = Array.isArray(sessionLore.active_flags)
    ? sessionLore.active_flags
    : (Array.isArray(sessionLore.open_threads) ? sessionLore.open_threads : []);
  const relationshipMemory = activeStory.relationshipMemory || {};

  // キャラクター名を取得するためにDBを参照
  const { getCharacters } = await import('./db.js');
  const allChars = await getCharacters();
  if (renderVersion !== lorebookRenderVersion) return;
  const charMap = Object.fromEntries(allChars.map(c => [c.characterId, c.name]));

  let html = `<div class="session-lore-panel">`;

  // ストーリータイトル
  html += `
    <div class="session-lore-story-badge">
      <span class="material-symbols-outlined">menu_book</span>
      <span>${escapeHTML(activeStory.title || '無題のストーリー')}</span>
    </div>`;

  // あらすじ・サマリー
  html += `
    <div class="session-lore-block">
      <div class="session-lore-block-header">
        <span class="material-symbols-outlined">summarize</span>
        <h4>ストーリーの進行状況</h4>
      </div>
      <div class="session-lore-block-body">
        <textarea id="session-lore-editor-summary" class="session-lore-textarea" rows="6" placeholder="AIの要約や、手動で整理したい進行メモをここにまとめられます。">${escapeHTML(sessionLore.summary || '')}</textarea>
        <div class="session-lore-actions">
          <button id="session-lore-save-summary-btn" class="sidebar-session-link-btn" type="button">
            <span class="material-symbols-outlined">save</span>
            <span>要約を保存</span>
          </button>
        </div>
      </div>
    </div>`;

  html += `
    <div class="session-lore-block">
      <div class="session-lore-block-header">
        <span class="material-symbols-outlined">my_location</span>
        <h4>現在の場面</h4>
      </div>
      <div class="session-lore-block-body">
        <textarea id="session-lore-editor-current-state" class="session-lore-textarea" rows="4" placeholder="主人公が今どこで、誰と、何をしている最中かを整理します。">${escapeHTML(sessionLore.current_state || '')}</textarea>
        <div class="session-lore-actions">
          <button id="session-lore-save-current-state-btn" class="sidebar-session-link-btn" type="button">
            <span class="material-symbols-outlined">save</span>
            <span>現在状況を保存</span>
          </button>
        </div>
      </div>
    </div>`;

  const activeFlags = Array.isArray(sessionLore.active_flags)
    ? sessionLore.active_flags.map(normalizeSessionLoreEventForDisplay).filter(Boolean)
    : [];
  html += `
    <div class="session-lore-block">
      <div class="session-lore-block-header">
        <span class="material-symbols-outlined">priority_high</span>
        <h4>未回収フラグ・伏線 (${activeFlags.length}件)</h4>
      </div>
      <div class="session-lore-block-body">`;
  if (activeFlags.length > 0) {
    html += `<ul class="session-event-list">${activeFlags.map((e, index) => `
      <li>
        <span class="session-event-text">${escapeHTML(e)}</span>
        <button class="session-open-thread-delete-btn" type="button" data-index="${index}" title="懸案を削除">
          <span class="material-symbols-outlined">close</span>
        </button>
      </li>
    `).join('')}</ul>`;
  } else {
    html += `<p style="opacity:0.5;">現在、未回収のフラグや伏線はありません。</p>`;
  }
  html += `
        <div class="session-lore-add-row">
          <input id="session-lore-new-open-thread-input" class="session-lore-input" type="text" placeholder="例: 王都へ向かう / 試練のため聖域へ向かう">
          <button id="session-lore-add-open-thread-btn" class="sidebar-session-link-btn" type="button">
            <span class="material-symbols-outlined">add</span>
            <span>追加</span>
          </button>
        </div>
      </div>
    </div>`;

  const turningPoints = Array.isArray(sessionLore.recent_turning_points)
    ? sessionLore.recent_turning_points.map(normalizeSessionLoreEventForDisplay).filter(Boolean)
    : [];
  html += `
    <div class="session-lore-block">
      <div class="session-lore-block-header">
        <span class="material-symbols-outlined">fork_right</span>
        <h4>最近の出来事 (${turningPoints.length}件)</h4>
      </div>
      <div class="session-lore-block-body">`;
  if (turningPoints.length > 0) {
    html += `<ul class="session-event-list">${turningPoints.map((e, index) => `
      <li>
        <span class="session-event-text">${escapeHTML(e)}</span>
        <button class="session-turning-point-delete-btn" type="button" data-index="${index}" title="転換点を削除">
          <span class="material-symbols-outlined">close</span>
        </button>
      </li>
    `).join('')}</ul>`;
  } else {
    html += `<p style="opacity:0.5;">まだ最近の出来事は記録されていません。</p>`;
  }
  html += `
        <div class="session-lore-add-row">
          <input id="session-lore-new-turning-point-input" class="session-lore-input" type="text" placeholder="例: 村へ移動中 / ダンス練習を見学した">
          <button id="session-lore-add-turning-point-btn" class="sidebar-session-link-btn" type="button">
            <span class="material-symbols-outlined">add</span>
            <span>追加</span>
          </button>
        </div>
      </div>
    </div>`;

  // 長期記憶イベント
  const longTermEvents = Array.isArray(sessionLore.long_term_events)
    ? sessionLore.long_term_events.map(normalizeSessionLoreEventForDisplay).filter(Boolean)
    : [];
  html += `
    <div class="session-lore-block">
      <div class="session-lore-block-header">
        <span class="material-symbols-outlined">event_note</span>
        <h4>長期記憶イベント (${longTermEvents.length}件)</h4>
      </div>
      <div class="session-lore-block-body">`;
  if (longTermEvents.length > 0) {
    html += `<ul class="session-event-list">${longTermEvents.map((e, index) => `
      <li>
        <span class="session-event-text">${escapeHTML(e)}</span>
        <button class="session-event-delete-btn" type="button" data-index="${index}" title="イベントを削除">
          <span class="material-symbols-outlined">close</span>
        </button>
      </li>
    `).join('')}</ul>`;
  } else {
    html += `<p style="opacity:0.5;">まだ長期記憶イベントは記録されていません。</p>`;
  }
  html += `
        <div class="session-lore-add-row">
          <input id="session-lore-new-event-input" class="session-lore-input" type="text" placeholder="例: オットーを野盗から救出し、同行することになった">
          <button id="session-lore-add-event-btn" class="sidebar-session-link-btn" type="button">
            <span class="material-symbols-outlined">add</span>
            <span>追加</span>
          </button>
        </div>
      </div>
    </div>`;

  // キャラクター関係性
  const relEntries = Object.entries(relationshipMemory);
  html += `
    <div class="session-lore-block">
      <div class="session-lore-block-header">
        <span class="material-symbols-outlined">favorite</span>
        <h4>キャラクター関係・好感度 (${relEntries.length}件)</h4>
      </div>
      <div class="session-lore-block-body">`;
  if (relEntries.length > 0) {
    html += relEntries.map(([charId, rel]) => {
      const name = charMap[charId] || charId;
      const affinity = rel.affinity ?? 50;
      const affinityColor = affinity >= 70 ? '#7c4dff' : affinity >= 40 ? '#2196f3' : '#f44336';
      const notes = rel.notes || '';
      return `
        <div class="session-rel-row">
          <div class="session-rel-header">
            <span class="material-symbols-outlined" style="font-size:16px;">person</span>
            <strong>${escapeHTML(name)}</strong>
            <div class="session-affinity-bar-wrap">
              <div class="session-affinity-bar" style="width:${affinity}%;background:${affinityColor};"></div>
            </div>
            <span class="session-affinity-value" style="color:${affinityColor};">${affinity}</span>
          </div>
          ${notes ? `<p class="session-rel-notes">${escapeHTML(notes)}</p>` : ''}
        </div>`;
    }).join('');
  } else {
    html += `<p style="opacity:0.5;">まだ関係性情報は記録されていません。</p>`;
  }
  html += `</div></div></div>`;

  if (renderVersion !== lorebookRenderVersion) return;
  container.innerHTML = html;

  const persistSessionLoreChanges = async () => {
    await db.saveStory(activeStory);
    const stories = await db.getStories();
    updateState({ stories });
    requestDropboxAutoSync(activeStory.storyId);
  };

  const ensureEditableSessionLore = () => {
    if (!activeStory.session_lore) {
      activeStory.session_lore = {
        summary: '',
        current_state: '',
        recent_turning_points: [],
        long_term_events: [],
        active_flags: [],
        open_threads: [],
        key_events: []
      };
    }
    if (!Array.isArray(activeStory.session_lore.recent_turning_points)) activeStory.session_lore.recent_turning_points = [];
    if (!Array.isArray(activeStory.session_lore.long_term_events)) {
      activeStory.session_lore.long_term_events = Array.isArray(activeStory.session_lore.key_events)
        ? [...activeStory.session_lore.key_events]
        : [];
    }
    if (!Array.isArray(activeStory.session_lore.active_flags)) {
      activeStory.session_lore.active_flags = Array.isArray(activeStory.session_lore.open_threads)
        ? [...activeStory.session_lore.open_threads]
        : [];
    }
    activeStory.session_lore.key_events = [...activeStory.session_lore.long_term_events];
    activeStory.session_lore.open_threads = [...activeStory.session_lore.active_flags];
  };

  const summaryInput = container.querySelector('#session-lore-editor-summary');
  const saveSummaryBtn = container.querySelector('#session-lore-save-summary-btn');
  if (saveSummaryBtn && summaryInput) {
    saveSummaryBtn.onclick = async () => {
      ensureEditableSessionLore();
      activeStory.session_lore.summary = summaryInput.value.trim();
      activeStory.session_lore.summary_source = 'manual';
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  }

  const currentStateInput = container.querySelector('#session-lore-editor-current-state');
  const saveCurrentStateBtn = container.querySelector('#session-lore-save-current-state-btn');
  if (saveCurrentStateBtn && currentStateInput) {
    saveCurrentStateBtn.onclick = async () => {
      ensureEditableSessionLore();
      activeStory.session_lore.current_state = currentStateInput.value.trim();
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  }

  const newEventInput = container.querySelector('#session-lore-new-event-input');
  const addEventBtn = container.querySelector('#session-lore-add-event-btn');
  if (addEventBtn && newEventInput) {
    addEventBtn.onclick = async () => {
      const value = newEventInput.value.trim();
      if (!value) return;
      ensureEditableSessionLore();
      const existingEvents = Array.isArray(activeStory.session_lore.long_term_events) ? activeStory.session_lore.long_term_events : [];
      activeStory.session_lore.long_term_events = Array.from(new Set([...existingEvents, value]));
      activeStory.session_lore.key_events = [...activeStory.session_lore.long_term_events];
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  }

  const newOpenThreadInput = container.querySelector('#session-lore-new-open-thread-input');
  const addOpenThreadBtn = container.querySelector('#session-lore-add-open-thread-btn');
  if (addOpenThreadBtn && newOpenThreadInput) {
    addOpenThreadBtn.onclick = async () => {
      const value = newOpenThreadInput.value.trim();
      if (!value) return;
      ensureEditableSessionLore();
      const existingItems = Array.isArray(activeStory.session_lore.active_flags) ? activeStory.session_lore.active_flags : [];
      activeStory.session_lore.active_flags = Array.from(new Set([...existingItems, value])).slice(0, 10);
      activeStory.session_lore.open_threads = [...activeStory.session_lore.active_flags];
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  }

  const newTurningPointInput = container.querySelector('#session-lore-new-turning-point-input');
  const addTurningPointBtn = container.querySelector('#session-lore-add-turning-point-btn');
  if (addTurningPointBtn && newTurningPointInput) {
    addTurningPointBtn.onclick = async () => {
      const value = newTurningPointInput.value.trim();
      if (!value) return;
      ensureEditableSessionLore();
      const existingItems = Array.isArray(activeStory.session_lore.recent_turning_points) ? activeStory.session_lore.recent_turning_points : [];
      activeStory.session_lore.recent_turning_points = Array.from(new Set([value, ...existingItems])).slice(0, 8);
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  }

  container.querySelectorAll('.session-event-delete-btn').forEach(button => {
    button.onclick = async () => {
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      ensureEditableSessionLore();
      if (!Array.isArray(activeStory.session_lore.long_term_events)) return;
      activeStory.session_lore.long_term_events.splice(index, 1);
      activeStory.session_lore.key_events = [...activeStory.session_lore.long_term_events];
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  });

  container.querySelectorAll('.session-open-thread-delete-btn').forEach(button => {
    button.onclick = async () => {
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      ensureEditableSessionLore();
      if (!Array.isArray(activeStory.session_lore.active_flags)) return;
      activeStory.session_lore.active_flags.splice(index, 1);
      activeStory.session_lore.open_threads = [...activeStory.session_lore.active_flags];
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  });

  container.querySelectorAll('.session-turning-point-delete-btn').forEach(button => {
    button.onclick = async () => {
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      if (!activeStory.session_lore || !Array.isArray(activeStory.session_lore.recent_turning_points)) return;
      activeStory.session_lore.recent_turning_points.splice(index, 1);
      await persistSessionLoreChanges();
      await renderLorebook('session');
    };
  });
}

export function showLoreEditModal(lore = null, options = {}) {
  let modal = document.getElementById('lore-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'lore-modal';
  modal.className = 'modal-wrapper';
  modal.style.zIndex = '5000';

  const isEdit = !!lore;
  const title = isEdit ? 'ロア設定の編集' : '新規ロアの作成';
  const { currentStory } = getState();
  
  const loreName = isEdit ? lore.name : '';
  const loreFranchise = isEdit ? lore.franchise : (currentStory?.franchise || '');
  const loreSearchContext = isEdit
    ? (lore.searchContext || currentStory?.franchiseContext || lore.franchise || '')
    : (currentStory?.franchiseContext || currentStory?.franchise || '');
  const loreType = isEdit ? lore.type : 'term';
  const loreVerified = isEdit ? lore.verified : true;

  const contentSummary = isEdit ? (lore.content?.summary || '') : '';
  const contentProfile = isEdit ? (lore.content?.profile || '') : '';
  const contentSpeech = isEdit ? (lore.content?.speech || '') : '';
  const contentRelationships = isEdit ? (lore.content?.relationships || '') : '';

  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content" style="max-width: 600px; width: 90%;">
      <div class="modal-header">
        <h3>${escapeHTML(title)}</h3>
        <button onclick="document.getElementById('lore-modal').remove()" class="icon-btn-circle">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        ${!isEdit ? `
          <div class="lore-search-intro">
            <span class="material-symbols-outlined">travel_explore</span>
            <p>ロア名と作品名を入れてから「ネット検索で詳細補完」を押すと、概要と詳細の下書きを作れます。</p>
          </div>
        ` : ''}
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label for="lore-name-input">名前/固有名詞 (必須)</label>
            <input type="text" id="lore-name-input" placeholder="例: エミリア" value="${escapeHTML(loreName)}">
          </div>
          <div class="form-group">
            <label for="lore-franchise-input">作品カテゴリ/Franchise</label>
            <input type="text" id="lore-franchise-input" placeholder="例: Re:ゼロ" value="${escapeHTML(loreFranchise)}">
          </div>
        </div>

        <div class="form-group">
          <label for="lore-search-context-input">検索用作品名・別名</label>
          <input type="text" id="lore-search-context-input" placeholder="例: リゼロ / Re:ゼロから始める異世界生活" value="${escapeHTML(loreSearchContext)}">
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: center;">
          <div class="form-group">
            <label for="lore-type-select">ロアの種類</label>
            <select id="lore-type-select" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid var(--border-color, #ccc); background: var(--bg-card, #fff); color: inherit;">
              <option value="character" ${loreType === 'character' ? 'selected' : ''}>登場人物 (character)</option>
              <option value="location" ${loreType === 'location' ? 'selected' : ''}>場所・地域 (location)</option>
              <option value="organization" ${loreType === 'organization' ? 'selected' : ''}>組織・勢力 (organization)</option>
              <option value="term" ${loreType === 'term' ? 'selected' : ''}>用語・世界観 (term)</option>
              <option value="event" ${loreType === 'event' ? 'selected' : ''}>歴史・事件 (event)</option>
              <option value="item" ${loreType === 'item' ? 'selected' : ''}>アイテム・道具 (item)</option>
            </select>
          </div>
          <div class="form-group-checkbox" style="margin-top: 16px;">
            <input type="checkbox" id="lore-verified-checkbox" ${loreVerified ? 'checked' : ''}>
            <label for="lore-verified-checkbox" style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
              <strong>確認済みにする</strong>
            </label>
          </div>
        </div>

        <button id="lore-ai-gen-btn" type="button" class="primary-btn" style="display:flex; align-items:center; justify-content:center; gap:6px;">
          <span class="material-symbols-outlined">travel_explore</span>
          ${isEdit ? 'ネット検索で詳細補完' : '検索して下書きを作成'}
        </button>

        <div class="form-group">
          <label for="lore-summary-textarea">概要・設定要約 (summary)</label>
          <textarea id="lore-summary-textarea" rows="3" placeholder="簡単な紹介文...">${escapeHTML(contentSummary)}</textarea>
        </div>

        <div class="form-group">
          <label for="lore-profile-textarea">プロフィール詳細 (profile)</label>
          <textarea id="lore-profile-textarea" rows="2" placeholder="容姿、性格、背景、能力など...">${escapeHTML(contentProfile)}</textarea>
        </div>

        <div class="form-group">
          <label for="lore-speech-textarea">口調や話し方の特徴 (speech)</label>
          <textarea id="lore-speech-textarea" rows="2" placeholder="口調サンプル、一人称/二人称など...">${escapeHTML(contentSpeech)}</textarea>
        </div>

        <div class="form-group">
          <label for="lore-relationships-textarea">人間関係・他者とのつながり (relationships)</label>
          <textarea id="lore-relationships-textarea" rows="2" placeholder="パック、スバル等の他キャラとの関係...">${escapeHTML(contentRelationships)}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button onclick="document.getElementById('lore-modal').remove()" class="secondary-btn">キャンセル</button>
        <button id="lore-save-submit-btn" class="primary-btn">保存する</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const enrichBtn = modal.querySelector('#lore-ai-gen-btn');
  if (enrichBtn) {
    enrichBtn.onclick = async () => {
      const name = modal.querySelector('#lore-name-input').value.trim();
      const franchise = modal.querySelector('#lore-franchise-input').value.trim();
      const searchContext = modal.querySelector('#lore-search-context-input').value.trim();
      if (!name) {
        alert('先にロア名を入力してください。');
        return;
      }

      const searchKey = searchContext || franchise || currentStory?.franchiseContext || currentStory?.franchise || '';
      if (!searchKey) {
        alert('検索精度のため、作品カテゴリか検索用作品名を入力してください。');
        return;
      }

      const originalHtml = enrichBtn.innerHTML;
      enrichBtn.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">sync</span> 補完中...';
      enrichBtn.disabled = true;

      try {
        const generated = await generateLoreProfileFromSearch(name, searchKey);
        if (generated?.shouldRegister === false) {
          alert(`ロアの深掘りに失敗しました。\n${generated.reason || '対象作品の安定設定として確認できませんでした。'}`);
          return;
        }

        if (generated.canonicalName) {
          modal.querySelector('#lore-name-input').value = generated.canonicalName;
        }
        if (generated.type) {
          modal.querySelector('#lore-type-select').value = generated.type;
        }
        modal.querySelector('#lore-summary-textarea').value = generated.summary || '';
        modal.querySelector('#lore-profile-textarea').value = generated.profile || '';
        modal.querySelector('#lore-speech-textarea').value = generated.speech || '';
        modal.querySelector('#lore-relationships-textarea').value = generated.relationships || '';
        alert('ロア候補の詳細補完が完了しました。内容を確認して保存してください。');
      } catch (err) {
        alert(`ロアの深掘りに失敗しました: ${err.message}`);
      } finally {
        enrichBtn.innerHTML = originalHtml;
        enrichBtn.disabled = false;
      }
    };
  }

  const saveBtn = modal.querySelector('#lore-save-submit-btn');
  saveBtn.onclick = async () => {
    const name = modal.querySelector('#lore-name-input').value.trim();
    const franchise = modal.querySelector('#lore-franchise-input').value.trim();
    const searchContext = modal.querySelector('#lore-search-context-input').value.trim();
    const type = modal.querySelector('#lore-type-select').value;
    const verified = modal.querySelector('#lore-verified-checkbox').checked;
    
    const summary = modal.querySelector('#lore-summary-textarea').value.trim();
    const profile = modal.querySelector('#lore-profile-textarea').value.trim();
    const speech = modal.querySelector('#lore-speech-textarea').value.trim();
    const relationships = modal.querySelector('#lore-relationships-textarea').value.trim();

    if (!name) {
      alert('名前・固有名詞を入力してください。');
      return;
    }

    const itemToSave = {
      id: lore ? lore.id : undefined,
      franchise: franchise || '共通',
      searchContext,
      type,
      name,
      content: {
        summary,
        profile,
        speech,
        relationships
      },
      source: lore ? lore.source : 'manual',
      verified,
      status: 'completed'
    };
    const previousFranchise = String(lore?.franchise || '').trim() || '共通';

    await db.saveLore(itemToSave);

    if (options.fromCandidate && currentStory && Array.isArray(currentStory.lore_candidates)) {
      currentStory.lore_candidates = currentStory.lore_candidates.filter(item => item.id !== lore?.id);
      await db.saveStory(currentStory);
      const stories = await db.getStories();
      updateState({ stories });
    }

    modal.remove();
    renderLorebook();
    requestDropboxAutoSync(currentStory?.storyId || null, {
      syncStory: !!options.fromCandidate && !!currentStory?.storyId,
      syncLores: true,
      loreFranchises: [...new Set([previousFranchise, itemToSave.franchise || '共通'])]
    });
  };
}
