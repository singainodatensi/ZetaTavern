/**
 * app.js - ZetaTavern Application Entry Point
 * Handles application boot, DOM events wiring, messaging pipeline, and protagonist updates.
 */

import { getState, updateState, setActiveStory, subscribe } from './state.js';
import * as db from './db.js';
import * as ui from './ui.js?v=20260628a';
import { generateStoryResponse, generateLoreProfileFromSearch, generateStorySummary, generateSessionChapterSummary, countUserTurnChunks, normalizeLoreEntryName, isLikelyWorldLoreName } from './ai-client.js?v=20260628a';
import * as dropbox from './dropbox.js?v=20260628a';
import { buildStoryCharacterRefs } from './story-characters.js';

// Default Storyteller instructions preset matching the Storyteller rules
const DEFAULT_STORYTELLER_PROMPT =   `・三人称視点で描写し、キャラクター同士のテンポの良い会話（台詞）と、動き・仕草（動作・情景描写）を中心に物語を進行させてください。\n` +
    `・「語るな、見せろ（Show, don't tell）」を厳守してください。キャラクターの感情を「嬉しい」「怒る」などと地の文で直接説明せず、声のトーン、視線、間（ま）、仕草、セリフの選び方で生き生きと表現してください。\n` +
    `・各登場人物は、主人公や他のキャラクターの話し方に影響（汚染・伝染）されず、固有の一人称・二人称・敬語レベル・語尾を厳格に維持して発言させてください。\n` +
    `・一度の出力で事態を勝手に解決・完結させず、主人公（ユーザー）が次のターンで介入（発言や行動の選択）できる明確な「判断の余白」を残した時点で物語の記述を終了してください。`;

// Default World settings template
const DEFAULT_WORLD_PROMPT = `【世界観】\n現代の高校を舞台にした日常系ラブコメの世界。\n\n【状況】\n主人公は平凡な男子高校生。ある日、隣の席に学校一の美少女が座ることになり……`;
const DEFAULT_SESSION_SUMMARY_PROMPT = `あなたはプロの編集者です。以下の会話履歴を、第三者の視点から見た物語の「あらすじ」として要約してください。
「承知しました」等のAIとしての応答は不要です。要約文のみ出力して下さい。

【最重要ルール】
- プロットの維持: 物語の重要な転換点、登場人物の重要な決断、新しい事実の判明、伏線となりうる発言は、絶対に省略しないでください。
- 客観的な記述: 「主人公は〜した。」「〇〇は〜と感じた。」のように、キャラクターの行動と感情を客観的に記述してください。
- 情報の取捨選択: 日常的な挨拶や、物語の進行に直接関係のない会話は省略してください。
- 時系列の維持: 出来事が起こった順番を正確に保ってください。
- 継続性の維持: 誰が誰とどう出会ったか、なぜ同行しているのか、今後どこへ向かうのかが失われないようにしてください。
- 未回収要素の保持: 約束、保留案件、未解決の懸案、今後回収すべき話題があれば明示してください。

最終的な出力は、このあらすじを初めて読む人でも、これまでの物語の流れを正確に理解できるような形式にしてください。`;
const SESSION_SUMMARY_RECENT_SEGMENT_LIMIT = 2;
const DROPBOX_REMOTE_MANIFEST_SNAPSHOT_KEY = 'dropbox_remote_manifest_snapshot';

let hasBooted = false;
let isSyncInProgress = false; // 同期の多重実行を防ぐ排他ガードフラグ
let isDropboxAutoSyncRunning = false;
let pendingDropboxAutoSync = null;
let hasDropboxAutoSyncEventBinding = false;
let activeDropboxSyncLabel = '';
let dropboxSyncChain = Promise.resolve();
let syncStatusUpdateToken = 0;
const sessionSummaryInFlight = new Set();
const TURN_INTERVAL_OPTIONS = [10, 20, 30, 40];

function isDropboxSyncBusy() {
  return !!(isSyncInProgress || isDropboxAutoSyncRunning || activeDropboxSyncLabel || pendingDropboxAutoSync);
}

async function runExclusiveDropboxSync(label, task) {
  const waitForPrevious = dropboxSyncChain;
  let releaseCurrent = null;
  dropboxSyncChain = new Promise(resolve => {
    releaseCurrent = resolve;
  });

  if (activeDropboxSyncLabel) {
    console.log(`[Dropbox] ${label} は ${activeDropboxSyncLabel} の完了待ちです...`);
  }

  await waitForPrevious;
  activeDropboxSyncLabel = label;
  isSyncInProgress = true;

  try {
    return await task();
  } finally {
    activeDropboxSyncLabel = '';
    isSyncInProgress = false;
    releaseCurrent?.();
  }
}

function normalizeTurnIntervalChoice(value, fallback = 10) {
  const rawValue = Number(value);
  if (!Number.isFinite(rawValue)) return fallback;
  if (TURN_INTERVAL_OPTIONS.includes(rawValue)) return rawValue;
  if (rawValue <= TURN_INTERVAL_OPTIONS[0]) return TURN_INTERVAL_OPTIONS[0];
  if (rawValue >= TURN_INTERVAL_OPTIONS[TURN_INTERVAL_OPTIONS.length - 1]) {
    return TURN_INTERVAL_OPTIONS[TURN_INTERVAL_OPTIONS.length - 1];
  }

  let nearest = TURN_INTERVAL_OPTIONS[0];
  let smallestDiff = Math.abs(rawValue - nearest);
  for (const option of TURN_INTERVAL_OPTIONS.slice(1)) {
    const diff = Math.abs(rawValue - option);
    if (diff < smallestDiff) {
      nearest = option;
      smallestDiff = diff;
    }
  }
  return nearest;
}

function createEmptySessionLore() {
  return {
    summary: '',
    summary_segments: [],
    summary_source: '',
    summary_checkpoint_turn: 0,
    last_summary_at: 0,
    last_summary_status: '',
    last_summary_error: '',
    last_summary_mode: '',
    current_state: '',
    recent_turning_points: [],
    long_term_events: [],
    active_flags: [],
    open_threads: [],
    key_events: []
  };
}

function normalizeStoryPlanList(items = [], limit = 8) {
  const source = Array.isArray(items)
    ? items
    : String(items || '').split(/\r?\n|,/);
  return Array.from(new Set(source
    .map(item => String(item || '').trim())
    .filter(Boolean))).slice(0, limit);
}

function createEmptyStoryPlan() {
  return {
    short_term: [],
    mid_term: [],
    long_term: [],
    research_needs: [],
    updatedAt: 0
  };
}

function ensureStoryPlanStructure(story) {
  if (!story) return createEmptyStoryPlan();
  const plan = story.story_plan && typeof story.story_plan === 'object'
    ? story.story_plan
    : {};
  story.story_plan = {
    ...createEmptyStoryPlan(),
    ...plan,
    short_term: normalizeStoryPlanList(plan.short_term, 8),
    mid_term: normalizeStoryPlanList(plan.mid_term, 8),
    long_term: normalizeStoryPlanList(plan.long_term, 8),
    research_needs: normalizeStoryPlanList(plan.research_needs, 10),
    updatedAt: Number.isFinite(Number(plan.updatedAt)) ? Number(plan.updatedAt) : 0
  };
  return story.story_plan;
}

function createSessionSummarySegment({
  type = 'segment',
  startTurn = 1,
  endTurn = 1,
  summary = '',
  source = '',
  createdAt = Date.now()
} = {}) {
  const text = String(summary || '').trim();
  if (!text) return null;
  const fromTurn = Math.max(1, Number(startTurn || 1));
  const toTurn = Math.max(fromTurn, Number(endTurn || fromTurn));
  return {
    type: type === 'chapter' ? 'chapter' : 'segment',
    startTurn: fromTurn,
    endTurn: toTurn,
    summary: text,
    source: String(source || '').trim(),
    createdAt: Number(createdAt || Date.now()),
    updatedAt: Date.now()
  };
}

function parseSessionSummarySegmentsFromText(summaryText = '', checkpointTurn = 0, source = '') {
  const raw = String(summaryText || '').trim();
  if (!raw) return [];

  const segments = [];
  const regex = /【第(\d+)(?:〜(\d+))?ターン(章)?要約】\n([\s\S]*?)(?=\n\n【第\d+(?:〜\d+)?ターン(?:章)?要約】|$)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const startTurn = Number(match[1] || 1);
    const endTurn = Number(match[2] || match[1] || startTurn);
    const type = match[3] ? 'chapter' : 'segment';
    const summary = String(match[4] || '').trim();
    const segment = createSessionSummarySegment({ type, startTurn, endTurn, summary, source });
    if (segment) segments.push(segment);
  }

  if (segments.length > 0) return segments;

  const fallbackEndTurn = Math.max(1, Number(checkpointTurn || 1));
  const fallbackType = String(source || '').trim() === 'manual' ? 'segment' : 'chapter';
  return [
    createSessionSummarySegment({
      type: fallbackType,
      startTurn: 1,
      endTurn: fallbackEndTurn,
      summary: raw,
      source
    })
  ].filter(Boolean);
}

function normalizeSessionSummarySegments(sessionLore = {}) {
  if (Array.isArray(sessionLore.summary_segments) && sessionLore.summary_segments.length > 0) {
    return sessionLore.summary_segments
      .map(segment => createSessionSummarySegment(segment))
      .filter(Boolean)
      .sort((a, b) => Number(a.startTurn || 0) - Number(b.startTurn || 0));
  }

  return parseSessionSummarySegmentsFromText(
    sessionLore.summary || '',
    sessionLore.summary_checkpoint_turn || 0,
    sessionLore.summary_source || ''
  );
}

function renderSessionSummarySegments(segments = []) {
  return segments
    .map(segment => {
      const fromTurn = Math.max(1, Number(segment.startTurn || 1));
      const toTurn = Math.max(fromTurn, Number(segment.endTurn || fromTurn));
      const label = segment.type === 'chapter'
        ? `【第${fromTurn}〜${toTurn}ターン章要約】`
        : (fromTurn === toTurn
          ? `【第${fromTurn}ターン要約】`
          : `【第${fromTurn}〜${toTurn}ターン要約】`);
      return `${label}\n${String(segment.summary || '').trim()}`;
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function ensureSessionLoreStructure(story) {
  if (!story) return createEmptySessionLore();
  const sessionLore = story.session_lore && typeof story.session_lore === 'object'
    ? story.session_lore
    : {};
  story.session_lore = {
    ...createEmptySessionLore(),
    ...sessionLore,
    summary_checkpoint_turn: Number.isFinite(Number(sessionLore.summary_checkpoint_turn))
      ? Number(sessionLore.summary_checkpoint_turn)
      : 0,
    last_summary_at: Number.isFinite(Number(sessionLore.last_summary_at))
      ? Number(sessionLore.last_summary_at)
      : 0,
    last_summary_status: String(sessionLore.last_summary_status || '').trim(),
    last_summary_error: String(sessionLore.last_summary_error || '').trim(),
    last_summary_mode: String(sessionLore.last_summary_mode || '').trim(),
    recent_turning_points: Array.isArray(sessionLore.recent_turning_points) ? sessionLore.recent_turning_points : [],
    long_term_events: Array.isArray(sessionLore.long_term_events)
      ? sessionLore.long_term_events
      : (Array.isArray(sessionLore.key_events) ? sessionLore.key_events : []),
    active_flags: Array.isArray(sessionLore.active_flags)
      ? sessionLore.active_flags
      : (Array.isArray(sessionLore.open_threads) ? sessionLore.open_threads : []),
    summary_segments: normalizeSessionSummarySegments(sessionLore),
    open_threads: Array.isArray(sessionLore.active_flags)
      ? sessionLore.active_flags
      : (Array.isArray(sessionLore.open_threads) ? sessionLore.open_threads : []),
    key_events: Array.isArray(sessionLore.long_term_events)
      ? sessionLore.long_term_events
      : (Array.isArray(sessionLore.key_events) ? sessionLore.key_events : [])
  };
  story.session_lore.summary = renderSessionSummarySegments(story.session_lore.summary_segments);
  return story.session_lore;
}

const DROPBOX_SYNC_SETTING_KEYS = [
  'api_provider',
  'api_key',
  'model_name',
  'search_model_name',
  'web_search_provider',
  'show_choices',
  'autoscroll_enabled',
  'custom_models',
  'dropbox_app_key',
  'dropbox_sync_frequency',
  'dropbox_sync_tombstones',
  'lore_auto_search_enabled',
  'thinking_level',
  'thinking_level_gemini3',
  'thinking_budget_preset_gemini25',
  'prompt_debug_enabled',
  'history_compression_enabled',
  'history_turn_limit',
  'session_summary_auto_enabled',
  'session_summary_turn_interval',
  'session_summary_model_name',
  'session_summary_prompt',
  'api_timeout',
  'api_retries',
  'font_size',
  'narration_bg',
  'narration_color',
  'narration_opacity'
];

const DEFAULT_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite (無料枠多め・高速)' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (高速・最適)' },
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro (超高精度・長文)' },
  { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash (前世代高速)' },
  { value: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview (Preview・検索対応)' },
  { value: 'gemma-4-31b-it', label: 'gemma-4-31b-it (Gemma 4・高推論・無料)' },
  { value: 'gemma-4-26b-a4b-it', label: 'gemma-4-26b-a4b-it (Gemma 4・軽量・無料)' },
  { value: 'gemma-3-27b-it', label: 'gemma-3-27b-it (Gemma 3・高推論)' },
  { value: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant (Groq・高速)' },
  { value: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile (Groq・高性能)' },
  { value: 'openai/gpt-oss-20b', label: 'openai/gpt-oss-20b (Groq・OSS)' },
  { value: 'openai/gpt-oss-120b', label: 'openai/gpt-oss-120b (Groq・大型OSS)' },
  { value: 'qwen/qwen3-32b', label: 'qwen/qwen3-32b (Groq・Qwen)' }
];

const DEFAULT_MODEL_VALUES = DEFAULT_MODEL_OPTIONS.map(option => option.value);
const DEFAULT_GROQ_MODEL_NAME = 'llama-3.1-8b-instant';
const DEFAULT_GEMINI_MODEL_NAME = 'gemini-2.5-flash';
const GROQ_MODEL_VALUES = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b'
]);

function isGroqModelName(modelName = '') {
  const normalized = String(modelName || '').trim();
  return GROQ_MODEL_VALUES.has(normalized);
}
const GEMINI3_THINKING_OPTIONS = [
  { value: 'minimal', label: 'Minimal (最小限)' },
  { value: 'low', label: 'Low (軽め)' },
  { value: 'medium', label: 'Medium (標準)' },
  { value: 'high', label: 'High (深め)' }
];
const GEMINI25_FLASH_THINKING_OPTIONS = [
  { value: 'off', label: 'オフ (0)' },
  { value: 'dynamic', label: '自動 (Dynamic / -1)' },
  { value: 'minimal', label: '少なめ (512)' },
  { value: 'balanced', label: '標準 (1024)' },
  { value: 'high', label: '深め (4096)' }
];
const GEMINI25_PRO_THINKING_OPTIONS = [
  { value: 'dynamic', label: '自動 (Dynamic / -1)' },
  { value: 'minimal', label: '少なめ (512)' },
  { value: 'balanced', label: '標準 (1024)' },
  { value: 'high', label: '深め (4096)' }
];
const GEMMA4_THINKING_OPTIONS = [
  { value: 'on', label: 'オン (<|think|>)' },
  { value: 'off', label: 'オフ' }
];

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

function getActiveThinkingSelection(modelName, stateSnapshot = getState()) {
  const support = getThinkingSupportForModel(modelName);
  if (support.kind === 'gemma4') {
    return normalizeGemmaThinkingEnabled(stateSnapshot.gemmaThinkingEnabled) ? 'on' : 'off';
  }
  if (support.kind === 'gemini3') {
    return normalizeGemini3ThinkingLevel(stateSnapshot.thinkingLevelGemini3);
  }
  if (support.kind === 'gemini25') {
    return normalizeGemini25ThinkingPreset(stateSnapshot.thinkingBudgetPresetGemini25, modelName);
  }
  return '';
}

function populateThinkingSelectForModel(modelName, stateSnapshot = getState()) {
  const thinkingEl = document.getElementById('thinking-level-select');
  const thinkingLabelEl = document.getElementById('thinking-level-label');
  const thinkingHelpEl = document.getElementById('thinking-level-help');
  if (!thinkingEl) return;

  const support = getThinkingSupportForModel(modelName);
  let label = 'Thinking設定';
  let help = '選択中モデルに合わせて設定が切り替わります。';
  let options = [];

  if (support.kind === 'gemini3') {
    label = '思考レベル (Thinking Level)';
    help = 'Gemini 3系は minimal / low / medium / high を使います。完全な思考OFFはできず、minimal が最も軽い設定です。';
    options = GEMINI3_THINKING_OPTIONS;
  } else if (support.kind === 'gemma4') {
    label = 'Gemma Thinking';
    help = 'Gemma 4 は <|think|> 制御トークンの有無で思考モードを切り替えます。ON でシステムプロンプト先頭に <|think|> を付与します。';
    options = GEMMA4_THINKING_OPTIONS;
  } else if (support.kind === 'gemini25') {
    label = 'Thinking Budget';
    help = support.isPro
      ? 'Gemini 2.5 Pro は thinkingBudget を使います。思考OFFはできないため、Dynamic か予算値を選びます。'
      : 'Gemini 2.5 Flash系は thinkingBudget を使います。オフ / Dynamic / 数値予算から選べます。';
    options = support.isPro ? GEMINI25_PRO_THINKING_OPTIONS : GEMINI25_FLASH_THINKING_OPTIONS;
  } else {
    label = 'Thinking設定';
    help = 'このモデルでは Thinking 設定を使用しません。Gemma系や一部旧モデルは対象外です。';
  }

  thinkingEl.innerHTML = '';
  if (options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '対象外';
    thinkingEl.appendChild(opt);
    thinkingEl.disabled = true;
    thinkingEl.style.opacity = '0.55';
  } else {
    options.forEach(option => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      thinkingEl.appendChild(opt);
    });
    thinkingEl.disabled = false;
    thinkingEl.style.opacity = '1';
    thinkingEl.value = getActiveThinkingSelection(modelName, stateSnapshot);
  }

  if (thinkingLabelEl) thinkingLabelEl.textContent = label;
  if (thinkingHelpEl) thinkingHelpEl.textContent = help;
}

function populateModelSelect(selectEl, customModels = [], options = {}) {
  if (!selectEl) return;

  const {
    includeFollowOption = false,
    followOptionLabel = '使用モデルに追従',
    selectedValue = ''
  } = options;

  selectEl.innerHTML = '';

  if (includeFollowOption) {
    const followOpt = document.createElement('option');
    followOpt.value = '';
    followOpt.textContent = followOptionLabel;
    selectEl.appendChild(followOpt);
  }

  DEFAULT_MODEL_OPTIONS.forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    selectEl.appendChild(opt);
  });

  customModels.forEach(customModel => {
    if (!DEFAULT_MODEL_VALUES.includes(customModel)) {
      const opt = document.createElement('option');
      opt.value = customModel;
      opt.textContent = `${customModel} (カスタム)`;
      selectEl.appendChild(opt);
    }
  });

  if (selectedValue && !DEFAULT_MODEL_VALUES.includes(selectedValue) && !customModels.includes(selectedValue)) {
    const opt = document.createElement('option');
    opt.value = selectedValue;
    opt.textContent = `${selectedValue} (カスタム)`;
    selectEl.appendChild(opt);
  }

  selectEl.value = selectedValue;
}

function renderCustomModelList(customModels = []) {
  const container = document.getElementById('custom-model-list');
  if (!container) return;

  if (!Array.isArray(customModels) || customModels.length === 0) {
    container.innerHTML = '<span style="font-size: 12px; color: var(--text-sub);">追加したカスタムモデルはここに表示されます。</span>';
    return;
  }

  container.innerHTML = '';
  customModels.forEach(model => {
    const chip = document.createElement('span');
    chip.className = 'custom-model-chip';
    chip.dataset.model = model;
    chip.style.display = 'inline-flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '6px';
    chip.style.padding = '5px 8px';
    chip.style.borderRadius = '999px';
    chip.style.border = '1px solid var(--border-color, #ccc)';
    chip.style.background = 'var(--bg-input, rgba(255,255,255,0.03))';
    chip.style.fontSize = '12px';

    const label = document.createElement('span');
    label.textContent = model;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'custom-model-remove-btn';
    removeBtn.dataset.model = model;
    removeBtn.title = '削除';
    removeBtn.style.border = 'none';
    removeBtn.style.background = 'none';
    removeBtn.style.color = 'inherit';
    removeBtn.style.cursor = 'pointer';
    removeBtn.style.padding = '0';
    removeBtn.style.display = 'inline-flex';
    removeBtn.style.alignItems = 'center';
    removeBtn.style.justifyContent = 'center';

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.style.fontSize = '16px';
    icon.textContent = 'close';
    removeBtn.appendChild(icon);

    chip.appendChild(label);
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  });
}

function updateHistoryCompressionControls(enabled) {
  const historyTurnLimitEl = document.getElementById('history-turn-limit-select');
  const historyTurnLimitHelpEl = document.getElementById('history-turn-limit-help');
  if (historyTurnLimitEl) {
    historyTurnLimitEl.disabled = !enabled;
    historyTurnLimitEl.title = enabled ? '' : '会話履歴の圧縮がOFFのため無効です。';
    historyTurnLimitEl.style.opacity = enabled ? '1' : '0.55';
  }
  if (historyTurnLimitHelpEl) {
    historyTurnLimitHelpEl.textContent = enabled
      ? '古い会話はセッションロア要約に委ね、直近の指定ターン数だけをAIへ送ります。'
      : '圧縮がOFFの間は、会話履歴ターン数の制限を使わず全履歴をAIへ送ります。';
  }
}

function updateSessionSummaryControls(enabled) {
  const summaryTurnIntervalEl = document.getElementById('session-summary-turn-interval-select');
  const summaryTurnIntervalHelpEl = document.getElementById('session-summary-turn-interval-help');
  if (summaryTurnIntervalEl) {
    summaryTurnIntervalEl.disabled = !enabled;
    summaryTurnIntervalEl.title = enabled ? '' : '自動要約がOFFのため無効です。';
    summaryTurnIntervalEl.style.opacity = enabled ? '1' : '0.55';
  }
  if (summaryTurnIntervalHelpEl) {
    summaryTurnIntervalHelpEl.textContent = enabled
      ? '指定したユーザー入力ターン数ごとに、会話履歴を圧縮してセッションロアへ統合します。'
      : '自動要約がOFFの間は、手動の要約ボタンからだけ圧縮を実行できます。';
  }
}

function getSessionSummaryInterval(stateSnapshot = getState()) {
  return normalizeTurnIntervalChoice(stateSnapshot.sessionSummaryTurnInterval, 20);
}

function shouldAutoSummarizeStory(story, stateSnapshot = getState()) {
  if (!story || stateSnapshot.sessionSummaryAutoEnabled === false) return false;
  const sessionLore = ensureSessionLoreStructure(story);
  const totalTurns = countUserTurnChunks(story.messages || []);
  const checkpointTurn = Number.isFinite(Number(sessionLore.summary_checkpoint_turn))
    ? Number(sessionLore.summary_checkpoint_turn)
    : 0;
  return totalTurns - checkpointTurn >= getSessionSummaryInterval(stateSnapshot);
}

async function maybeChapterCompressSessionSummary(story) {
  const sessionLore = ensureSessionLoreStructure(story);
  const segments = normalizeSessionSummarySegments(sessionLore);
  if (segments.length <= SESSION_SUMMARY_RECENT_SEGMENT_LIMIT + 1) return false;

  const olderSegments = segments.slice(0, -SESSION_SUMMARY_RECENT_SEGMENT_LIMIT);
  const recentSegments = segments.slice(-SESSION_SUMMARY_RECENT_SEGMENT_LIMIT);
  if (olderSegments.length < 2) return false;

  const result = await generateSessionChapterSummary(story, { segments: olderSegments });
  const chapterSegment = createSessionSummarySegment({
    type: 'chapter',
    startTurn: result.startTurn,
    endTurn: result.endTurn,
    summary: result.summary,
    source: 'ai-chapter-summary'
  });
  if (!chapterSegment) return false;

  sessionLore.summary_segments = [chapterSegment, ...recentSegments];
  sessionLore.summary = renderSessionSummarySegments(sessionLore.summary_segments);
  sessionLore.summary_source = 'ai-summary';
  return true;
}

async function refreshStoryAfterSessionSummary(storyId) {
  const stories = await db.getStories();
  const activeState = getState();
  const refreshedStory = stories.find(item => item.storyId === storyId) || activeState.currentStory;
  updateState({ stories });
  if (activeState.currentStory?.storyId === storyId && refreshedStory) {
    setActiveStory(refreshedStory);
    ui.renderStory();
    ui.renderSidebar();
    await ui.renderLorebook();
  }
  ui.renderStoryList();
}

async function runSessionSummary(storyId, options = {}) {
  if (!storyId || sessionSummaryInFlight.has(storyId)) return false;

  sessionSummaryInFlight.add(storyId);
  const activeBefore = getState().currentStory;
  if (activeBefore?.storyId === storyId) {
    updateState({ isSessionSummaryRunning: true });
    ui.renderStory();
  }

  try {
    const workingStory = await db.getStory(storyId);
    if (!workingStory) throw new Error('対象のストーリーが見つかりませんでした。');

    ensureSessionLoreStructure(workingStory);
    workingStory.session_lore.last_summary_status = 'running';
    workingStory.session_lore.last_summary_error = '';
    workingStory.session_lore.last_summary_mode = options.mode === 'manual' ? 'manual' : 'auto';
    await db.saveStory(workingStory);
    await refreshStoryAfterSessionSummary(storyId);

    const result = await generateStorySummary(workingStory, { mode: options.mode || 'manual' });

    if (result?.unchanged) {
      const latestStory = await db.getStory(storyId);
      if (latestStory) {
        ensureSessionLoreStructure(latestStory);
        latestStory.session_lore.last_summary_status = 'success';
        latestStory.session_lore.last_summary_error = '';
        latestStory.session_lore.last_summary_mode = options.mode === 'manual' ? 'manual' : 'auto';
        latestStory.session_lore.last_summary_at = Date.now();
        await db.saveStory(latestStory);
      }
      await refreshStoryAfterSessionSummary(storyId);
      return true;
    }

    const latestStory = await db.getStory(storyId);
    if (!latestStory) throw new Error('要約保存時にストーリーを再取得できませんでした。');

    ensureSessionLoreStructure(latestStory);
    const nextSegment = createSessionSummarySegment({
      type: 'segment',
      startTurn: Number(result.startTurn || 0) + 1,
      endTurn: result.checkpointTurn,
      summary: result.summary,
      source: 'ai-summary'
    });
    const existingSegments = normalizeSessionSummarySegments(latestStory.session_lore);
    latestStory.session_lore.summary_segments = [...existingSegments, nextSegment].filter(Boolean);
    latestStory.session_lore.summary = renderSessionSummarySegments(latestStory.session_lore.summary_segments);
    latestStory.session_lore.summary_source = 'ai-summary';
    latestStory.session_lore.summary_checkpoint_turn = Number(result.checkpointTurn || countUserTurnChunks(latestStory.messages || []));
    latestStory.session_lore.last_summary_at = Date.now();
    latestStory.session_lore.last_summary_status = 'success';
    latestStory.session_lore.last_summary_error = '';
    latestStory.session_lore.last_summary_mode = options.mode === 'manual' ? 'manual' : 'auto';
    try {
      await maybeChapterCompressSessionSummary(latestStory);
    } catch (chapterErr) {
      console.warn('[Session Summary] Chapter compression failed:', chapterErr);
    }
    await db.saveStory(latestStory);

    queueDropboxAutoSync({ storyId, syncStory: true });
    await refreshStoryAfterSessionSummary(storyId);
    return true;
  } catch (err) {
    const latestStory = await db.getStory(storyId);
    if (latestStory) {
      ensureSessionLoreStructure(latestStory);
      latestStory.session_lore.last_summary_status = 'error';
      latestStory.session_lore.last_summary_error = String(err?.message || err || '').trim();
      latestStory.session_lore.last_summary_mode = options.mode === 'manual' ? 'manual' : 'auto';
      latestStory.session_lore.last_summary_at = Date.now();
      await db.saveStory(latestStory);
    }
    await refreshStoryAfterSessionSummary(storyId);
    if (options.mode === 'manual') {
      alert(`要約に失敗しました:\n${err.message}`);
    } else {
      console.warn('[Session Summary] Auto summary failed:', err);
    }
    return false;
  } finally {
    sessionSummaryInFlight.delete(storyId);
    const activeAfter = getState().currentStory;
    if (activeAfter?.storyId === storyId) {
      updateState({ isSessionSummaryRunning: false });
      ui.renderStory();
      ui.renderSidebar();
    }
  }
}

async function collectDropboxSettings() {
  const settings = {};
  for (const key of DROPBOX_SYNC_SETTING_KEYS) {
    const value = await db.getSetting(key, undefined);
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

async function restoreDropboxSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  for (const key of DROPBOX_SYNC_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      await db.saveSetting(key, settings[key]);
    }
  }
  await loadConfigurations();
}

async function getStoredDropboxManifestSnapshot() {
  const snapshot = await db.getSetting(DROPBOX_REMOTE_MANIFEST_SNAPSHOT_KEY, null);
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

async function saveDropboxManifestSnapshot(manifest) {
  if (!manifest || typeof manifest !== 'object') return;
  await db.saveSetting(DROPBOX_REMOTE_MANIFEST_SNAPSHOT_KEY, manifest);
  if (manifest.updatedAt) {
    await db.saveSetting('dropbox_remote_manifest_updated_at', Number(manifest.updatedAt || 0));
  }
}

function normalizeSyncFranchise(value) {
  const text = String(value || '').trim();
  return (text || '共通').toLowerCase();
}

async function replacePulledLoreGroups(lores = [], franchiseLabels = []) {
  const targetKeys = new Set((franchiseLabels || []).map(normalizeSyncFranchise));
  if (targetKeys.size === 0 && lores.length > 0) {
    for (const lore of lores) targetKeys.add(normalizeSyncFranchise(lore?.franchise));
  }
  if (targetKeys.size === 0) return;

  const existingLores = await db.getWorldLores();
  for (const lore of existingLores) {
    if (targetKeys.has(normalizeSyncFranchise(lore?.franchise))) {
      await db.deleteLore(lore.id);
    }
  }
  for (const lore of lores) {
    await db.saveLore(lore);
  }
}

async function applyDropboxPullToLocal(pulled, { forceFull = false } = {}) {
  await db.runWithoutLocalChangeTracking(async () => {
    await restoreDropboxSettings(pulled.settings);

    for (const { assetId, blob } of (pulled.newAssets || [])) {
      await db.saveAssetWithId(assetId, blob, blob.type);
    }

    if (!pulled.delta || forceFull) {
      await db.clearStore('stories');
      await db.clearStore('characters');
      await db.clearStore('world_lore');
      for (const story of (pulled.stories || [])) await db.saveStoryFromSync(story);
      for (const char of (pulled.characters || [])) await db.saveCharacterFromSync(char);
      for (const lore of (pulled.lores || [])) await db.saveLore(lore);
      return;
    }

    for (const storyId of (pulled.delta.deletedStoryIds || [])) {
      await db.deleteStory(storyId);
    }
    for (const characterId of (pulled.delta.deletedCharacterIds || [])) {
      await db.deleteCharacter(characterId);
    }
    if ((pulled.delta.deletedLoreFranchises || []).length > 0) {
      await replacePulledLoreGroups([], pulled.delta.deletedLoreFranchises);
    }

    for (const story of (pulled.stories || [])) await db.saveStoryFromSync(story);
    for (const char of (pulled.characters || [])) await db.saveCharacterFromSync(char);
    await replacePulledLoreGroups(pulled.lores || [], pulled.delta.loreFranchises || []);
  });
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

  return true;
}

async function hasCharacterLibraryConflict(keyword, franchise) {
  const normalizedKeyword = normalizeLoreKey(keyword);
  if (!normalizedKeyword) return false;

  const characters = await db.getCharacters();
  return characters.some(character =>
    normalizeLoreKey(character?.name) === normalizedKeyword &&
    isCharacterInFranchise(character, franchise)
  );
}

function pickMostLikelyLoreFranchise(candidates) {
  const counts = new Map();
  for (const candidate of candidates) {
    const value = (candidate || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
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

async function resolveLoreFranchise(story) {
  const direct = (story?.franchise || '').trim();
  if (direct) return direct;

  const storyTag = Array.isArray(story?.tags)
    ? story.tags.map(tag => (tag || '').trim()).find(Boolean)
    : '';
  if (storyTag) return storyTag;

  const attachedIds = new Set((story?.characters || []).map(ref => ref.characterId));
  const loadedCharacters = getState().characters?.length ? getState().characters : await db.getCharacters();
  const candidates = [];

  for (const character of loadedCharacters) {
    if (!attachedIds.has(character.characterId)) continue;
    if (character.category) candidates.push(character.category);
    if (Array.isArray(character.tags)) candidates.push(...character.tags);
  }

  return pickMostLikelyLoreFranchise(candidates);
}

const LORE_KEYWORD_STOPWORDS = new Set([
  '主人公', '地の文', 'ナレーション', 'セリフ', '会話', '場面', '現在地',
  '時間帯', '状況', '世界', '国名', '地名', '名前', '話', '設定', '情報',
  '関係', '記録', '記憶', '主要', 'イベント', 'キャラ', 'キャラクター',
  'アイテム', '解呪アイテム', '道具', '武器',
  'カテゴリー', 'カテゴリ', '多様性', 'テーブル', 'フォーク',
  '金', '物資', '情報', '金・物資・情報', 'タイミング'
]);

const SESSION_SPECIFIC_AUTO_LORE_PATTERNS = [
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

const LORE_LOCATION_HINTS = ['高校', '学園', '学院', '学校', '寮', '屋敷', '邸', '城', '宮', '神殿', '聖域', '都', '市', '町', '村', 'マンション', 'アパート', 'ホテル', 'カフェ', '喫茶'];
const LORE_ORGANIZATION_HINTS = ['組', '団', '隊', '軍', '教', '教会', '商会', '会社', '部', '陣営', '騎士団'];
const LORE_EVENT_HINTS = ['王選', '試験', '祭', '編', '会議', '戦'];
const LORE_ITEM_HINTS = ['剣', '杖', '指輪', '徽章', '勲章', '書', '石'];
const LORE_TOPIC_SUFFIXES = ['社会構造', '文化', '歴史', '政治体制', '経済構造', '制度', '仕組み', '種族構成', '身分制度'];

function isLoreKeywordCandidate(word, story) {
  const trimmed = (word || '').trim();
  if (!trimmed || trimmed.length < 2) return false;
  if (/^[0-9０-９]+$/.test(trimmed)) return false;
  if (LORE_KEYWORD_STOPWORDS.has(trimmed)) return false;

  const normalized = normalizeLoreKey(trimmed);
  if (normalized === normalizeLoreKey(story?.franchise)) return false;
  if (normalized === normalizeLoreKey(story?.protagonist?.name)) return false;
  if (!isLikelyWorldLoreName(trimmed)) return false;

  return true;
}

function isSessionSpecificAutoLoreText(text) {
  const value = (text || '').trim();
  if (!value) return false;
  return SESSION_SPECIFIC_AUTO_LORE_PATTERNS.some(pattern => pattern.test(value));
}

function shouldSkipAutoLoreRegistration(result, story) {
  if (!result || result.shouldRegister === false) {
    return true;
  }

  const combined = [
    result.canonicalName,
    result.summary,
    result.profile,
    result.speech,
    result.relationships,
    result.reason
  ].filter(Boolean).join(' ');

  if (!result.summary) return true;
  if (isSessionSpecificAutoLoreText(combined)) return true;
  if (!isLikelyWorldLoreName(result.canonicalName, result.type)) return true;

  const normalizedName = normalizeLoreKey(result.canonicalName);
  if (normalizedName === normalizeLoreKey(story?.protagonist?.name)) {
    return true;
  }

  return false;
}

function inferLoreCandidateType(name) {
  const value = (name || '').trim();
  if (!value) return 'term';
  if (LORE_LOCATION_HINTS.some(hint => value.includes(hint) || value.endsWith(hint))) return 'location';
  if (LORE_ORGANIZATION_HINTS.some(hint => value.includes(hint) || value.endsWith(hint))) return 'organization';
  if (LORE_EVENT_HINTS.some(hint => value.includes(hint) || value.endsWith(hint))) return 'event';
  if (LORE_ITEM_HINTS.some(hint => value.endsWith(hint))) return 'item';
  return 'term';
}

function isLikelyLoreTopicName(value) {
  const text = normalizeLoreEntryName(value);
  if (!text || text.length < 4) return false;
  return LORE_TOPIC_SUFFIXES.some(suffix => text.endsWith(suffix) && text.length > suffix.length + 1);
}

function extractRequestedLoreTopics(story) {
  const msgs = story.messages || [];
  const lastUser = [...msgs].reverse().find(msg => msg.role === 'user');
  const text = (lastUser?.content || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const topics = new Set();
  const directPatterns = [
    /([^\n。！？]{2,40}?の(?:社会構造|文化|歴史|政治体制|経済構造|制度|仕組み|種族構成|身分制度))(?:について|を|は|って|とは)?(?:教えて|知りたい|説明|詳しく|頼む|見せて)?/gu,
    /([^\n。！？]{2,40}?)(?:について|とは)(?:教えて|知りたい|説明|詳しく|頼む|見せて)?/gu
  ];

  for (const pattern of directPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeLoreEntryName((match[1] || '').trim());
      if (!candidate || LORE_KEYWORD_STOPWORDS.has(candidate)) continue;
      if (isLikelyLoreTopicName(candidate) || isLikelyWorldLoreName(candidate)) {
        topics.add(candidate);
      }
    }
  }

  return Array.from(topics).slice(0, 2);
}

function extractRecentTurnLoreKeywords(story) {
  const wordsSet = new Set();
  const msgs = story.messages || [];
  const recent = msgs.slice(-2);
  const textSource = [];

  for (const msg of recent) {
    textSource.push(msg.content || '');
    textSource.push(msg.aiContent || '');
  }

  const combinedText = textSource.join('\n');
  const quotedMatches = [...combinedText.matchAll(/[「『]([^「」『』\n]{2,24})[」』]/g)].map(match => match[1] || '');
  const boldMatches = [...combinedText.matchAll(/\*\*([^*\n]{2,24})\*\*/g)].map(match => match[1] || '');
  const matchesKatakana = combinedText.match(/[\u30A0-\u30FF\u30FC・]{2,24}/g) || [];
  const matchesKanji = combinedText.match(/[\u4E00-\u9FAF]{2,10}/g) || [];
  const matchesMixedJapanese = combinedText.match(/[\u4E00-\u9FAF々][\u3040-\u309F]{1,3}/g) || [];
  const matchesEnglish = combinedText.match(/[A-Z][a-zA-Z]{2,15}/g) || [];

  [...quotedMatches, ...boldMatches, ...matchesKatakana, ...matchesKanji, ...matchesMixedJapanese, ...matchesEnglish].forEach(word => {
    const w = normalizeLoreEntryName(word.trim());
    if (isLoreKeywordCandidate(w, story)) {
      wordsSet.add(w);
    }
  });

  return Array.from(wordsSet)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
}

function getRecentLoreContextText(story) {
  const msgs = story.messages || [];
  return msgs.slice(-2)
    .flatMap(msg => [msg.content || '', msg.aiContent || ''])
    .join('\n');
}

function getRecentModelLoreContextText(story) {
  const msgs = story.messages || [];
  return msgs
    .filter(msg => msg.role === 'model')
    .slice(-1)
    .flatMap(msg => [msg.content || ''])
    .join('\n');
}

function splitJapaneseSentences(text) {
  return ((text || '').match(/[^。！？\n]+[。！？]?/g) || [])
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function sanitizeLorePassageText(text) {
  return (text || '')
    .replace(/\*\*/g, '')
    .replace(/[`#>*_]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line &&
      !/ロアブック|機能テスト|世界観の深掘り|解説します|先ほどの概要|さらに/.test(line)
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLoreContextSnippet(text, keyword) {
  const source = sanitizeLorePassageText(text).replace(/[（(][^）)]*[）)]/g, '');
  const target = (keyword || '').trim();
  if (!source || !target) return '';

  const index = source.indexOf(target);
  if (index < 0) return '';

  const before = source.slice(0, index);
  const after = source.slice(index + target.length);
  const lastBoundary = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'));
  const nextCandidates = ['。', '！', '？']
    .map(mark => after.indexOf(mark))
    .filter(pos => pos >= 0);
  const nextBoundary = nextCandidates.length > 0 ? Math.min(...nextCandidates) : -1;

  const start = lastBoundary >= 0 ? lastBoundary + 1 : Math.max(0, index - 48);
  const end = nextBoundary >= 0 ? index + target.length + nextBoundary + 1 : Math.min(source.length, index + target.length + 48);
  let snippet = source.slice(start, end).trim();

  if (start > 0) snippet = `...${snippet}`;
  if (end < source.length) snippet = `${snippet}...`;
  snippet = snippet
    .replace(new RegExp(`${target}について\\s*${target}について`, 'g'), `${target}について`)
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (snippet.length > 120) {
    snippet = `${snippet.slice(0, 117).trim()}...`;
  }
  return snippet;
}

function extractLorePassage(text, keyword) {
  const source = sanitizeLorePassageText(text);
  const target = (keyword || '').trim();
  if (!source || !target) return '';

  const sentences = splitJapaneseSentences(source);
  if (sentences.length === 0) {
    return findLoreContextSnippet(source, target);
  }

  const sentenceIndex = sentences.findIndex(sentence => sentence.includes(target));
  if (sentenceIndex < 0) {
    return findLoreContextSnippet(source, target);
  }

  const picked = [];
  let totalLength = 0;
  for (let i = sentenceIndex; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (!sentence) continue;
    picked.push(sentence);
    totalLength += sentence.length;
    if (picked.length >= 3 || totalLength >= 260) break;
  }

  return picked.join(' ').trim();
}

function buildLoreCandidateContent(name, type, passage = '') {
  const fallback = `「${name}」が作品全体で共有される安定設定なら採用してください。`;
  if (!passage) {
    return {
      summary: fallback,
      profile: ''
    };
  }

  const sentences = splitJapaneseSentences(passage);
  if (sentences.length === 0) {
    return {
      summary: fallback,
      profile: passage
    };
  }

  let summary = sentences[0].trim();
  if (summary.length > 110) {
    summary = `${summary.slice(0, 107).trim()}...`;
  }

  const profile = sentences.slice(0, 3).join(' ').trim();
  return {
    summary,
    profile: profile !== summary ? profile : ''
  };
}

async function queueLoreCandidatesFromRecentTurn(story) {
  const franchise = await resolveLoreFranchise(story);
  if (!franchise) return 0;

  if (!story.franchise) {
    story.franchise = franchise;
  }

  if (!Array.isArray(story.lore_candidates)) {
    story.lore_candidates = [];
  }

  const existingLore = await db.getWorldLores();
  const existingCandidateKeys = new Set(
    story.lore_candidates.map(candidate => `${normalizeLoreKey(candidate.franchise)}::${normalizeLoreKey(candidate.name)}`)
  );

  let queuedCount = 0;
  const requestedTopics = extractRequestedLoreTopics(story);
  const keywords = requestedTopics.length > 0 ? [] : extractRecentTurnLoreKeywords(story);
  const combinedContextText = getRecentLoreContextText(story);
  const modelContextText = getRecentModelLoreContextText(story);
  const candidatesToQueue = [
    ...requestedTopics.map(name => ({ name, sourceKind: 'user-topic' })),
    ...keywords.map(name => ({ name, sourceKind: 'local-heuristic' }))
  ];

  for (const entry of candidatesToQueue) {
    const keyword = entry.name;
    const name = normalizeLoreEntryName(keyword);
    if (!name) continue;
    if (!isLikelyLoreTopicName(name) && !isLikelyWorldLoreName(name)) continue;
    if (await hasCharacterLibraryConflict(name, franchise)) continue;

    const existsInLore = existingLore.some(lore =>
      normalizeLoreKey(lore.franchise) === normalizeLoreKey(franchise) &&
      normalizeLoreKey(lore.name) === normalizeLoreKey(name)
    );
    if (existsInLore) continue;

    const candidateKey = `${normalizeLoreKey(franchise)}::${normalizeLoreKey(name)}`;
    if (existingCandidateKeys.has(candidateKey)) continue;

    const type = isLikelyLoreTopicName(name) ? 'term' : inferLoreCandidateType(name);
    const preferredContext = entry.sourceKind === 'user-topic' ? modelContextText || combinedContextText : combinedContextText;
    const passage = extractLorePassage(preferredContext, name);
    const candidateContent = buildLoreCandidateContent(name, type, passage);
    story.lore_candidates.push({
      id: crypto.randomUUID(),
      franchise,
      type,
      name,
      content: {
        summary: candidateContent.summary,
        profile: candidateContent.profile,
        speech: '',
        relationships: ''
      },
      source: entry.sourceKind,
      createdAt: Date.now()
    });
    existingCandidateKeys.add(candidateKey);
    queuedCount++;
  }

  return queuedCount;
}

// Boot strap execution
async function bootApp() {
  if (hasBooted) return;
  hasBooted = true;
  console.log('ZetaTavern booting...');
  
  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('ServiceWorker registration successful:', reg.scope))
        .catch(err => console.warn('ServiceWorker registration failed:', err));
    });
  }

  // Load configuration from settings store
  await loadConfigurations();

  // Load lists from IndexedDB
  const stories = await db.getStories();
  const characters = await db.getCharacters();
  updateState({ stories, characters });

  // ★ 前回開いていたストーリーを自動復元する
  if (stories.length > 0) {
    stories.sort((a, b) => b.timestamp - a.timestamp);
    const lastActiveId = await db.getSetting('last_active_story_id', null);
    let targetStory = stories.find(s => s.storyId === lastActiveId);
    if (!targetStory) targetStory = stories[0]; // 見つからない場合は最新のもの
    setActiveStory(targetStory);
  } else {
    setActiveStory(null);
  }

  // Initialize UI displays
  ui.renderStoryList();
  ui.renderCharacterLibrary();
  ui.renderStory();
  ui.renderApiUsagePanel();
  ui.renderSidebar();
  ui.bindScrollJumpControls();

  // Fill story settings form after initial render
  if (getState().currentStory) {
    fillStorySettingsForm(getState().currentStory);
  }

  // Bind all event handlers
  await bindEvents();

  // Subscribe state changes to auto-render UI
  subscribe((event, state) => {
    if (event === 'storyChanged') {
      // ★ ストーリー切り替え時にIDを保存し、次回起動時に復元できるようにする
      if (state.currentStory && state.currentStory.storyId) {
        db.saveSetting('last_active_story_id', state.currentStory.storyId);
      }
      // メモリリーク防止のため、古いアバター画像Blob URLキャッシュをクリーンアップ
      ui.clearBlobUrlCache();
      ui.renderStory();
      ui.renderApiUsagePanel();
      ui.renderSidebar();
      fillStorySettingsForm(state.currentStory);
    } else if (event === 'stateChanged') {
      // Toggle screens
      toggleScreenVisibility(state.activeScreen);
      ui.renderApiUsagePanel();
      if (state.activeScreen === 'lorebook') {
        ui.renderLorebook();
      }
      
      // Update sidebar when loading status or mode changes
      const sendBtn = document.getElementById('send-btn');
      if (sendBtn) {
        sendBtn.disabled = state.isGenerating;
      }
    }
  });

  // OAuth 戻りを先に処理（トークン保存後に接続 UI を更新）
  await handleDropboxOAuthReturnIfPresent();

  await initDropbox();

  // Setup auto-sync on tab return
  setupVisibilitySync();

  // Startup sync (silent pull if auto-sync is configured)
  await performStartupSync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp, { once: true });
} else {
  bootApp();
}

/**
 * Loads API keys and models from storage.
 */
async function loadConfigurations() {
  const provider = await db.getSetting('api_provider', 'gemini');
  const key = await db.getSetting('api_key', '');
  const groqApiKey = await db.getSetting('groq_api_key', '');
  const tavilyApiKey = await db.getSetting('tavily_api_key', '');
  let model = await db.getSetting('model_name', 'gemini-2.5-flash');
  if (provider === 'groq' && !isGroqModelName(model)) {
    model = DEFAULT_GROQ_MODEL_NAME;
    await db.saveSetting('model_name', model);
  } else if (provider !== 'groq' && isGroqModelName(model)) {
    model = DEFAULT_GEMINI_MODEL_NAME;
    await db.saveSetting('model_name', model);
  }
  const searchModel = await db.getSetting('search_model_name', '');
  const rawWebSearchProvider = await db.getSetting('web_search_provider', 'google');
  const webSearchProvider = ['google', 'tavily', 'off'].includes(String(rawWebSearchProvider || '').trim().toLowerCase())
    ? String(rawWebSearchProvider || '').trim().toLowerCase()
    : 'google';
  if (webSearchProvider !== rawWebSearchProvider) {
    await db.saveSetting('web_search_provider', webSearchProvider);
  }
  const choices = await db.getSetting('show_choices', true);
  const autoscroll = await db.getSetting('autoscroll_enabled', true); // ★自動スクロール設定
  const customModels = await db.getSetting('custom_models', []);
  const dropboxAppKey = await db.getSetting('dropbox_app_key', '');
  const loreAutoSearchEnabled = await db.getSetting('lore_auto_search_enabled', false);
  const legacyThinkingLevel = await db.getSetting('thinking_level', 'standard');
  const thinkingLevelGemini3 = normalizeGemini3ThinkingLevel(await db.getSetting('thinking_level_gemini3', legacyThinkingLevel));
  const thinkingBudgetPresetGemini25 = normalizeGemini25ThinkingPreset(await db.getSetting('thinking_budget_preset_gemini25', legacyThinkingLevel), model);
  const gemmaThinkingEnabled = normalizeGemmaThinkingEnabled(await db.getSetting('gemma_thinking_enabled', true));
  const promptDebugEnabled = await db.getSetting('prompt_debug_enabled', false);
  const historyCompressionEnabled = await db.getSetting('history_compression_enabled', true);
  const historyTurnLimit = normalizeTurnIntervalChoice(await db.getSetting('history_turn_limit', 10), 10);
  const sessionSummaryAutoEnabled = await db.getSetting('session_summary_auto_enabled', true);
  const sessionSummaryTurnInterval = normalizeTurnIntervalChoice(await db.getSetting('session_summary_turn_interval', 20), 20);
  const sessionSummaryModelName = await db.getSetting('session_summary_model_name', '');
  const sessionSummaryPrompt = await db.getSetting('session_summary_prompt', DEFAULT_SESSION_SUMMARY_PROMPT);
  await db.saveSetting('history_turn_limit', historyTurnLimit);
  await db.saveSetting('session_summary_turn_interval', sessionSummaryTurnInterval);
  
  // Settingsからタイムアウト設定値とリトライ設定値も取得してStateに同期させる
  const apiTimeout = await db.getSetting('api_timeout', 60);
  const apiRetries = await db.getSetting('api_retries', 3);
  
  // フォントサイズの設定（デフォルト：15px）を読み込み、即座に適用
  const fontSize = await db.getSetting('font_size', 15);
  ui.applyFontSize(fontSize);

  // 地の文の表示カスタマイズ設定を読み込み、即座に適用
  const narrationBg = await db.getSetting('narration_bg', '#f3f5f8');
  const narrationColor = await db.getSetting('narration_color', '#323232');
  const narrationOpacity = await db.getSetting('narration_opacity', 80);
  ui.applyNarrationStyles(narrationBg, narrationColor, narrationOpacity);

  // Sync to memory state
  updateState({
    apiProvider: provider,
    apiKey: key,
    groqApiKey,
    tavilyApiKey,
    modelName: model,
    searchModelName: searchModel,
    webSearchProvider,
    showChoices: choices,
    autoscrollEnabled: autoscroll, // ★Stateに反映
    apiTimeout: apiTimeout,
    apiRetries: apiRetries,
    fontSize: fontSize,
    narrationBg: narrationBg,
    narrationColor: narrationColor,
    narrationOpacity: narrationOpacity,
    loreAutoSearchEnabled: loreAutoSearchEnabled,
    thinkingLevelGemini3,
    thinkingBudgetPresetGemini25,
    gemmaThinkingEnabled,
    promptDebugEnabled,
    historyCompressionEnabled,
    historyTurnLimit,
    sessionSummaryAutoEnabled,
    sessionSummaryTurnInterval,
    sessionSummaryModelName: String(sessionSummaryModelName || '').trim(),
    sessionSummaryPrompt: String(sessionSummaryPrompt || DEFAULT_SESSION_SUMMARY_PROMPT),
    isSessionSummaryRunning: false
  });

  // Prefill settings form
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const groqKeyEl = document.getElementById('groq-api-key-input');
  const tavilyKeyEl = document.getElementById('tavily-api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const searchModelEl = document.getElementById('search-model-name-select');
  const webSearchProviderEl = document.getElementById('web-search-provider-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');
  const autoscrollEl = document.getElementById('autoscroll-toggle-checkbox'); // ★DOM取得
  const dropboxKeyEl = document.getElementById('dropbox-app-key-input');
  const retriesEl = document.getElementById('settings-retries-input');
  const timeoutEl = document.getElementById('settings-timeout-input');
  const fontSizeEl = document.getElementById('font-size-input');
  const nBgEl = document.getElementById('narration-bg-input');
  const nColorEl = document.getElementById('narration-color-input');
  const nOpacityEl = document.getElementById('narration-opacity-slider');
  const promptDebugEl = document.getElementById('prompt-debug-toggle-checkbox');
  const historyCompressionEl = document.getElementById('history-compression-toggle-checkbox');
  const historyTurnLimitEl = document.getElementById('history-turn-limit-select');
  const sessionSummaryAutoEl = document.getElementById('session-summary-auto-toggle-checkbox');
  const sessionSummaryTurnIntervalEl = document.getElementById('session-summary-turn-interval-select');
  const sessionSummaryModelEl = document.getElementById('session-summary-model-name-select');
  const sessionSummaryPromptEl = document.getElementById('session-summary-prompt-input');

  if (provEl) provEl.value = provider;
  if (keyEl) keyEl.value = key;
  if (groqKeyEl) groqKeyEl.value = groqApiKey || '';
  if (tavilyKeyEl) tavilyKeyEl.value = tavilyApiKey || '';
  if (choicesEl) choicesEl.checked = choices;
  if (autoscrollEl) autoscrollEl.checked = autoscroll;
  if (dropboxKeyEl) dropboxKeyEl.value = dropboxAppKey || '';
  if (retriesEl) retriesEl.value = apiRetries;
  if (timeoutEl) timeoutEl.value = apiTimeout;
  if (fontSizeEl) fontSizeEl.value = fontSize;
  if (nBgEl) nBgEl.value = narrationBg;
  if (nColorEl) nColorEl.value = narrationColor;
  if (nOpacityEl) nOpacityEl.value = narrationOpacity;
  if (promptDebugEl) promptDebugEl.checked = promptDebugEnabled;
  if (historyCompressionEl) historyCompressionEl.checked = historyCompressionEnabled;
  if (historyTurnLimitEl) historyTurnLimitEl.value = String(historyTurnLimit);
  if (sessionSummaryAutoEl) sessionSummaryAutoEl.checked = sessionSummaryAutoEnabled;
  if (sessionSummaryTurnIntervalEl) sessionSummaryTurnIntervalEl.value = String(sessionSummaryTurnInterval);
  if (sessionSummaryPromptEl) sessionSummaryPromptEl.value = String(sessionSummaryPrompt || DEFAULT_SESSION_SUMMARY_PROMPT);
  if (webSearchProviderEl) webSearchProviderEl.value = webSearchProvider || 'google';
  updateHistoryCompressionControls(historyCompressionEnabled);
  updateSessionSummaryControls(sessionSummaryAutoEnabled);

  const normalizedCustomModels = Array.isArray(customModels) ? [...new Set(customModels.filter(Boolean))] : [];
  if (model && !DEFAULT_MODEL_VALUES.includes(model) && !normalizedCustomModels.includes(model)) {
    normalizedCustomModels.push(model);
    await db.saveSetting('custom_models', normalizedCustomModels);
  }
  if (searchModel && !DEFAULT_MODEL_VALUES.includes(searchModel) && !normalizedCustomModels.includes(searchModel)) {
    normalizedCustomModels.push(searchModel);
    await db.saveSetting('custom_models', normalizedCustomModels);
  }
  if (sessionSummaryModelName && !DEFAULT_MODEL_VALUES.includes(sessionSummaryModelName) && !normalizedCustomModels.includes(sessionSummaryModelName)) {
    normalizedCustomModels.push(sessionSummaryModelName);
    await db.saveSetting('custom_models', normalizedCustomModels);
  }

  populateModelSelect(modelEl, normalizedCustomModels, { selectedValue: model });
  populateModelSelect(searchModelEl, normalizedCustomModels, {
    includeFollowOption: true,
    followOptionLabel: '使用モデルに追従',
    selectedValue: searchModel
  });
  populateModelSelect(sessionSummaryModelEl, normalizedCustomModels, {
    includeFollowOption: true,
    followOptionLabel: '使用モデルに追従',
    selectedValue: sessionSummaryModelName
  });
  renderCustomModelList(normalizedCustomModels);
  populateThinkingSelectForModel(model, getState());
}

async function isLoreAutoSearchEnabled() {
  const stateValue = getState().loreAutoSearchEnabled;
  if (typeof stateValue === 'boolean') return stateValue;
  return await db.getSetting('lore_auto_search_enabled', false);
}

/**
 * Syncs the story settings fields (Rule, world prompts, protagonist specs)
 */
function fillStorySettingsForm(story) {
  const rPrompt = document.getElementById('story-rule-prompt');
  const wPrompt = document.getElementById('story-world-prompt');
  const fInput = document.getElementById('story-franchise-input');
  const fContextInput = document.getElementById('story-franchise-context-input');
  const imageBaseUrlInput = document.getElementById('story-image-base-url-input');
  const imageDefaultOutfitInput = document.getElementById('story-image-default-outfit-input');
  const pName = document.getElementById('protagonist-name');
  const pDesc = document.getElementById('protagonist-desc');
  const pPreview = document.getElementById('protagonist-img-preview');

  if (!story) {
    if (rPrompt) rPrompt.value = '';
    if (wPrompt) wPrompt.value = '';
    if (fInput) fInput.value = '';
    if (fContextInput) fContextInput.value = '';
    if (imageBaseUrlInput) imageBaseUrlInput.value = '';
    if (imageDefaultOutfitInput) imageDefaultOutfitInput.value = '';
    if (pName) pName.value = '';
    if (pDesc) pDesc.value = '';
    if (pPreview) pPreview.src = 'assets/default-silhouette.png';
    return;
  }

  if (rPrompt) rPrompt.value = story.storytellerPrompt || '';
  if (wPrompt) wPrompt.value = story.worldPrompt || '';
  if (fInput) fInput.value = story.franchise || '';
  if (fContextInput) fContextInput.value = story.franchiseContext || '';
  if (imageBaseUrlInput) imageBaseUrlInput.value = story.imageBaseUrl || '';
  if (imageDefaultOutfitInput) imageDefaultOutfitInput.value = story.imageDefaultOutfit || '';
  if (pName) pName.value = story.protagonist?.name || '';
  if (pDesc) pDesc.value = story.protagonist?.description || '';
  
  if (pPreview && story.protagonist) {
    db.getAssetBlob(story.protagonist.avatarAssetId).then(blob => {
      if (blob) {
        pPreview.src = URL.createObjectURL(blob);
      } else {
        pPreview.src = 'assets/default-silhouette.png';
      }
    });
  }

  // ★ フォーム更新時に高さを自動調整
  triggerAutoResize(rPrompt);
  triggerAutoResize(wPrompt);
  triggerAutoResize(pDesc);
}

// ★ Textarea の Auto-resize（自動拡張）用ヘルパー関数
function triggerAutoResize(el) {
  if (!el) return;
  el.style.height = 'auto'; // 一旦autoにしてscrollHeightを再計算
  if (el.scrollHeight > 0) {
    el.style.height = el.scrollHeight + 'px';
  }
}

/**
 * Handles DOM view switches based on screen ID.
 */
function toggleScreenVisibility(activeScreen) {
  const mobileMoreBtn = document.getElementById('mobile-more-btn');

  document.querySelectorAll('.app-screen').forEach(screen => {
    if (screen.id === `${activeScreen}-screen`) {
      screen.classList.add('active');
    } else {
      screen.classList.remove('active');
    }
  });

  // Sync menu highlights
  document.querySelectorAll('.screen-nav-btn').forEach(btn => {
    if (btn.dataset.screen === activeScreen) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (mobileMoreBtn) {
    mobileMoreBtn.classList.toggle('active', ['library', 'lorebook', 'settings'].includes(activeScreen));
  }
}

/**
 * Binds all general DOM events.
 */
async function bindEvents() {
  if (!hasDropboxAutoSyncEventBinding && typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('dropbox-auto-sync-request', (event) => {
      queueDropboxAutoSync({
        storyId: event?.detail?.storyId || null,
        forceFull: !!event?.detail?.forceFull,
        syncStory: !!event?.detail?.syncStory,
        syncLores: !!event?.detail?.syncLores,
        syncCharacters: !!event?.detail?.syncCharacters,
        characterIds: Array.isArray(event?.detail?.characterIds) ? event.detail.characterIds : [],
        assetIds: Array.isArray(event?.detail?.assetIds) ? event.detail.assetIds : [],
        loreFranchises: Array.isArray(event?.detail?.loreFranchises) ? event.detail.loreFranchises : []
      });
    });
    hasDropboxAutoSyncEventBinding = true;
  }

  const mobileDrawer = document.getElementById('mobile-drawer');
  const sidebarContainer = document.getElementById('story-sidebar-container');
  const mobileMoreSheet = document.getElementById('mobile-more-sheet');
  const mobileMoreBtn = document.getElementById('mobile-more-btn');

  const closeMobileMoreSheet = () => {
    if (!mobileMoreSheet) return;
    mobileMoreSheet.classList.remove('open');
    mobileMoreSheet.setAttribute('aria-hidden', 'true');
    if (mobileMoreBtn) mobileMoreBtn.setAttribute('aria-expanded', 'false');
  };

  const openMobileMoreSheet = () => {
    if (!mobileMoreSheet) return;
    mobileMoreSheet.classList.add('open');
    mobileMoreSheet.setAttribute('aria-hidden', 'false');
    if (mobileMoreBtn) mobileMoreBtn.setAttribute('aria-expanded', 'true');
  };

  // 1. Navigation Screen switching
  document.querySelectorAll('.screen-nav-btn').forEach(btn => {
    btn.onclick = () => {
      const screen = btn.dataset.screen;
      updateState({ activeScreen: screen });
      if (mobileDrawer) mobileDrawer.classList.remove('open');
      if (sidebarContainer) sidebarContainer.classList.remove('open');
      closeMobileMoreSheet();
      if (screen === 'library') {
        ui.renderCharacterLibrary();
      } else if (screen === 'lorebook') {
        ui.renderLorebook();
      }
    };
  });

  // Bind Lorebook elements
  const loreAddBtn = document.getElementById('lore-add-btn');
  const loreExportBtn = document.getElementById('lore-export-btn');
  const loreSearchInput = document.getElementById('lore-search-input');
  const loreFilterSelect = document.getElementById('lore-filter-select');
  const tabWorld = document.getElementById('lorebook-tab-world');
  const tabSession = document.getElementById('lorebook-tab-session');
  const tabResearch = document.getElementById('lorebook-tab-research');

  if (loreAddBtn) {
    loreAddBtn.onclick = () => ui.showLoreEditModal(null);
  }
  if (loreExportBtn) {
    loreExportBtn.onclick = () => ui.showLoreExportModal();
  }
  if (loreSearchInput) {
    loreSearchInput.oninput = () => ui.renderLorebook();
  }
  if (loreFilterSelect) {
    loreFilterSelect.onchange = () => ui.renderLorebook();
  }

  // ロアブックの作品/セッションタブ切り替えバインド（active クラスは renderLorebook が管理）
  if (tabWorld) {
    tabWorld.onclick = () => ui.renderLorebook('world');
  }
  if (tabSession) {
    tabSession.onclick = () => ui.renderLorebook('session');
  }
  if (tabResearch) {
    tabResearch.onclick = () => ui.renderLorebook('research');
  }

  // Mobile drawer trigger (left — story list)
  const menuBtn = document.getElementById('menu-trigger-btn');
  const drawerOverlay = document.getElementById('drawer-overlay');

  if (menuBtn && mobileDrawer && drawerOverlay) {
    menuBtn.onclick = () => {
      mobileDrawer.classList.add('open');
      ui.renderStoryList();
    };
    drawerOverlay.onclick = () => {
      mobileDrawer.classList.remove('open');
    };
  }

  // Right sidebar toggle (mobile — scene/status/config)
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebarOverlay = document.getElementById('sidebar-overlay');

  if (sidebarToggleBtn && sidebarContainer) {
    sidebarToggleBtn.onclick = () => {
      sidebarContainer.classList.toggle('open');
    };
  }
  if (sidebarOverlay && sidebarContainer) {
    sidebarOverlay.onclick = () => {
      sidebarContainer.classList.remove('open');
    };
  }

  const mobileMoreOverlay = document.getElementById('mobile-more-overlay');
  const mobileMoreCloseBtn = document.getElementById('mobile-more-close-btn');
  if (mobileMoreBtn) {
    mobileMoreBtn.onclick = () => {
      if (mobileMoreSheet?.classList.contains('open')) {
        closeMobileMoreSheet();
      } else {
        openMobileMoreSheet();
      }
    };
  }
  if (mobileMoreOverlay) {
    mobileMoreOverlay.onclick = closeMobileMoreSheet;
  }
  if (mobileMoreCloseBtn) {
    mobileMoreCloseBtn.onclick = closeMobileMoreSheet;
  }

  // 2. View mode switching (Novel / Chat)
  const modeToggle = document.getElementById('view-mode-toggle');
  if (modeToggle) {
    modeToggle.onclick = () => {
      const currentMode = getState().uiMode;
      const nextMode = currentMode === 'novel' ? 'chat' : 'novel';
      const iconEl = modeToggle.querySelector('.material-symbols-outlined');
      if (iconEl) {
        iconEl.textContent = nextMode === 'novel' ? 'menu_book' : 'forum';
      }
      modeToggle.title = nextMode === 'novel' ? 'チャット表示へ切り替え' : '小説表示へ切り替え';
      updateState({ uiMode: nextMode });
      ui.renderStory();
    };
  }

  // 3. New Story Creation
  const newStoryBtn = document.getElementById('new-story-btn');
  if (newStoryBtn) {
    newStoryBtn.onclick = () => createNewStory();
  }
  window.addEventListener('createNewStoryRequested', () => {
    createNewStory();
  });

  // Bind action custom event (choices button click)
  window.addEventListener('submitUserAction', (e) => {
    const userInputField = document.getElementById('user-input-field');
    if (userInputField) {
      userInputField.value = e.detail;
      triggerAutoResize(userInputField);
      submitStoryTurn();
    }
  });

  // UI（チャットメッセージ）からの再生成・リトライ要求を受け取るイベントリスナーを追加
  window.addEventListener('requestRegenerate', (e) => {
    const isRetryOnly = e.detail?.retryOnly;
    submitStoryTurn(isRetryOnly ? 'retry' : 'regen');
  });
  window.addEventListener('requestSessionSummary', async (e) => {
    const targetStoryId = e.detail?.storyId || getState().currentStory?.storyId;
    if (!targetStoryId) return;
    await runSessionSummary(targetStoryId, { mode: 'manual' });
  });

  // Send action input trigger
  const sendBtn = document.getElementById('send-btn');
  const summaryRunBtn = document.getElementById('summary-run-btn');
  const userInputField = document.getElementById('user-input-field');

  if (sendBtn && userInputField) {
    ui.bindMentionAutocomplete(userInputField);
    sendBtn.onclick = () => submitStoryTurn();
    // キーバインド改修：Ctrl+Enter(Command+Enter)でのみ送信、通常のEnterは改行を許可
    userInputField.onkeydown = (e) => {
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          submitStoryTurn();
        } else {
          // Enter単体の場合はイベントをインターセプトせず、そのまま改行（textareaの標準挙動）を通す
          // Auto-resizeを遅延実行して改行後の高さを反映させる
          setTimeout(() => triggerAutoResize(e.target), 0);
        }
      }
    };
  }
  if (summaryRunBtn) {
    summaryRunBtn.onclick = async () => {
      const targetStoryId = getState().currentStory?.storyId;
      if (!targetStoryId) return;
      await runSessionSummary(targetStoryId, { mode: 'manual' });
    };
  }

  // ★ 長文用 textarea の自動拡張イベントをバインド
  const textareasToAutoResize = [
    document.getElementById('user-input-field'),
    document.getElementById('story-rule-prompt'),
    document.getElementById('story-world-prompt'),
    document.getElementById('protagonist-desc'),
    document.getElementById('session-summary-prompt-input')
  ];
  textareasToAutoResize.forEach(el => {
    if (el) {
      el.addEventListener('input', () => triggerAutoResize(el));
    }
  });

  // 4. Save Settings Changes
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const groqKeyEl = document.getElementById('groq-api-key-input');
  const tavilyKeyEl = document.getElementById('tavily-api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const searchModelEl = document.getElementById('search-model-name-select');
  const webSearchProviderEl = document.getElementById('web-search-provider-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');
  const autoscrollEl = document.getElementById('autoscroll-toggle-checkbox'); // ★自動スクロールDOM
  const customModelInput = document.getElementById('custom-model-input');
  const customModelAddBtn = document.getElementById('custom-model-add-btn');
  const customModelList = document.getElementById('custom-model-list');
  const retriesEl = document.getElementById('settings-retries-input');
  const timeoutEl = document.getElementById('settings-timeout-input');
  const fontSizeEl = document.getElementById('font-size-input');
  const nBgEl = document.getElementById('narration-bg-input');
  const nColorEl = document.getElementById('narration-color-input');
  const nOpacityEl = document.getElementById('narration-opacity-slider');
  const thinkingEl = document.getElementById('thinking-level-select');
  const promptDebugEl = document.getElementById('prompt-debug-toggle-checkbox');
  const historyCompressionEl = document.getElementById('history-compression-toggle-checkbox');
  const historyTurnLimitEl = document.getElementById('history-turn-limit-select');
  const sessionSummaryAutoEl = document.getElementById('session-summary-auto-toggle-checkbox');
  const sessionSummaryTurnIntervalEl = document.getElementById('session-summary-turn-interval-select');
  const sessionSummaryModelEl = document.getElementById('session-summary-model-name-select');
  const sessionSummaryPromptEl = document.getElementById('session-summary-prompt-input');

  if (provEl) {
    provEl.onchange = async (e) => {
      const val = e.target.value;
      const updates = { apiProvider: val };
      await db.saveSetting('api_provider', val);

      const currentModel = String(getState().modelName || modelEl?.value || '').trim();
      if (val === 'groq' && !isGroqModelName(currentModel)) {
        updates.modelName = DEFAULT_GROQ_MODEL_NAME;
        if (modelEl) modelEl.value = DEFAULT_GROQ_MODEL_NAME;
        await db.saveSetting('model_name', DEFAULT_GROQ_MODEL_NAME);
      } else if (val !== 'groq' && isGroqModelName(currentModel)) {
        updates.modelName = DEFAULT_GEMINI_MODEL_NAME;
        if (modelEl) modelEl.value = DEFAULT_GEMINI_MODEL_NAME;
        await db.saveSetting('model_name', DEFAULT_GEMINI_MODEL_NAME);
      }

      updateState(updates);
      populateThinkingSelectForModel(updates.modelName || currentModel, getState());
    };
  }
  if (keyEl) {
    keyEl.oninput = (e) => {
      const val = e.target.value.trim();
      updateState({ apiKey: val });
      db.saveSetting('api_key', val);
      localStorage.setItem('zetatavern_api_key', val);
    };
  }
  if (groqKeyEl) {
    groqKeyEl.oninput = (e) => {
      const val = String(e.target.value || '').trim();
      updateState({ groqApiKey: val });
      db.saveSetting('groq_api_key', val);
      localStorage.setItem('zetatavern_groq_api_key', val);
    };
  }
  if (tavilyKeyEl) {
    tavilyKeyEl.oninput = (e) => {
      const val = String(e.target.value || '').trim();
      updateState({ tavilyApiKey: val });
      db.saveSetting('tavily_api_key', val);
    };
  }
  if (modelEl) {
    modelEl.onchange = (e) => {
      const val = e.target.value;
      updateState({ modelName: val });
      db.saveSetting('model_name', val);
      populateThinkingSelectForModel(val, getState());
    };
  }
  if (searchModelEl) {
    searchModelEl.onchange = (e) => {
      const val = e.target.value;
      updateState({ searchModelName: val });
      db.saveSetting('search_model_name', val);
    };
  }
  if (webSearchProviderEl) {
    webSearchProviderEl.onchange = (e) => {
      const raw = String(e.target.value || 'google').trim().toLowerCase();
      const val = ['google', 'tavily', 'off'].includes(raw) ? raw : 'google';
      updateState({ webSearchProvider: val });
      db.saveSetting('web_search_provider', val);
    };
  }
  if (choicesEl) {
    choicesEl.onchange = (e) => {
      const val = e.target.checked;
      updateState({ showChoices: val });
      db.saveSetting('show_choices', val);
      ui.renderStory();
    };
  }
  // ★ 自動スクロールトグルのイベント
  if (autoscrollEl) {
    autoscrollEl.onchange = (e) => {
      const val = e.target.checked;
      updateState({ autoscrollEnabled: val });
      db.saveSetting('autoscroll_enabled', val);
    };
  }
  if (retriesEl) {
    retriesEl.oninput = (e) => {
      const val = parseInt(e.target.value) || 3;
      updateState({ apiRetries: val });
      db.saveSetting('api_retries', val);
    };
  }
  if (timeoutEl) {
    timeoutEl.oninput = (e) => {
      const val = parseInt(e.target.value) || 60;
      updateState({ apiTimeout: val });
      db.saveSetting('api_timeout', val);
    };
  }
  if (fontSizeEl) {
    // 任意のフォント数値入力を監視し、リアルタイム適用
    fontSizeEl.oninput = (e) => {
      const val = parseInt(e.target.value) || 15;
      updateState({ fontSize: val });
      db.saveSetting('font_size', val);
      ui.applyFontSize(val); // UIフォントサイズの一括・即時反映
    };
  }
  if (thinkingEl) {
    thinkingEl.onchange = (e) => {
      const val = e.target.value;
      const activeModelName = (getState().modelName || modelEl?.value || '').trim();
      const support = getThinkingSupportForModel(activeModelName);
      if (support.kind === 'gemma4') {
        const nextValue = val !== 'off';
        updateState({ gemmaThinkingEnabled: nextValue });
        db.saveSetting('gemma_thinking_enabled', nextValue);
      } else if (support.kind === 'gemini3') {
        const nextValue = normalizeGemini3ThinkingLevel(val);
        updateState({ thinkingLevelGemini3: nextValue });
        db.saveSetting('thinking_level_gemini3', nextValue);
      } else if (support.kind === 'gemini25') {
        const nextValue = normalizeGemini25ThinkingPreset(val, activeModelName);
        updateState({ thinkingBudgetPresetGemini25: nextValue });
        db.saveSetting('thinking_budget_preset_gemini25', nextValue);
      }
    };
  }
  if (promptDebugEl) {
    promptDebugEl.onchange = (e) => {
      const val = e.target.checked;
      updateState({ promptDebugEnabled: val });
      db.saveSetting('prompt_debug_enabled', val);
      ui.renderApiUsagePanel();
      ui.renderStory();
    };
  }
  if (historyCompressionEl) {
    historyCompressionEl.onchange = (e) => {
      const val = e.target.checked;
      updateState({ historyCompressionEnabled: val });
      db.saveSetting('history_compression_enabled', val);
      updateHistoryCompressionControls(val);
      ui.renderApiUsagePanel();
    };
  }
  if (historyTurnLimitEl) {
    historyTurnLimitEl.onchange = (e) => {
      const nextValue = normalizeTurnIntervalChoice(e.target.value, 10);
      e.target.value = String(nextValue);
      updateState({ historyTurnLimit: nextValue });
      db.saveSetting('history_turn_limit', nextValue);
    };
  }
  if (sessionSummaryAutoEl) {
    sessionSummaryAutoEl.onchange = (e) => {
      const val = e.target.checked;
      updateState({ sessionSummaryAutoEnabled: val });
      db.saveSetting('session_summary_auto_enabled', val);
      updateSessionSummaryControls(val);
    };
  }
  if (sessionSummaryTurnIntervalEl) {
    sessionSummaryTurnIntervalEl.onchange = (e) => {
      const nextValue = normalizeTurnIntervalChoice(e.target.value, 20);
      e.target.value = String(nextValue);
      updateState({ sessionSummaryTurnInterval: nextValue });
      db.saveSetting('session_summary_turn_interval', nextValue);
    };
  }
  if (sessionSummaryModelEl) {
    sessionSummaryModelEl.onchange = (e) => {
      const val = String(e.target.value || '').trim();
      updateState({ sessionSummaryModelName: val });
      db.saveSetting('session_summary_model_name', val);
    };
  }
  if (sessionSummaryPromptEl) {
    sessionSummaryPromptEl.oninput = (e) => {
      const val = String(e.target.value || '');
      updateState({ sessionSummaryPrompt: val });
      db.saveSetting('session_summary_prompt', val);
    };
  }
  // ナレーション表示設定変更のイベント監視
  const onNarrationStyleChange = () => {
    const bg = nBgEl ? nBgEl.value : '#f3f5f8';
    const color = nColorEl ? nColorEl.value : '#323232';
    const op = nOpacityEl ? parseInt(nOpacityEl.value) : 80;
    
    ui.applyNarrationStyles(bg, color, op);
    db.saveSetting('narration_bg', bg);
    db.saveSetting('narration_color', color);
    db.saveSetting('narration_opacity', op);
    updateState({ narrationBg: bg, narrationColor: color, narrationOpacity: op });
  };

  if (nBgEl) nBgEl.onchange = onNarrationStyleChange;
  if (nColorEl) nColorEl.onchange = onNarrationStyleChange;
  if (nOpacityEl) nOpacityEl.oninput = onNarrationStyleChange;

  if (customModelAddBtn && customModelInput && modelEl) {
    customModelAddBtn.onclick = async () => {
      const newModel = customModelInput.value.trim();
      if (!newModel) return;

      const customModels = await db.getSetting('custom_models', []);
      const normalizedCustomModels = Array.isArray(customModels) ? [...new Set(customModels.filter(Boolean))] : [];
      if (!DEFAULT_MODEL_VALUES.includes(newModel) && !normalizedCustomModels.includes(newModel)) {
        normalizedCustomModels.push(newModel);
        await db.saveSetting('custom_models', normalizedCustomModels);
      }

      populateModelSelect(modelEl, normalizedCustomModels, { selectedValue: newModel });
      populateModelSelect(searchModelEl, normalizedCustomModels, {
        includeFollowOption: true,
        followOptionLabel: '使用モデルに追従',
        selectedValue: getState().searchModelName || ''
      });
      populateModelSelect(sessionSummaryModelEl, normalizedCustomModels, {
        includeFollowOption: true,
        followOptionLabel: '使用モデルに追従',
        selectedValue: getState().sessionSummaryModelName || ''
      });
      renderCustomModelList(normalizedCustomModels);

      updateState({ modelName: newModel });
      await db.saveSetting('model_name', newModel);

      customModelInput.value = '';
      alert(`モデル「${newModel}」を追加し、現在モデルとして適用しました。`);
    };
  }

  if (customModelList) {
    customModelList.onclick = async (e) => {
      const removeBtn = e.target.closest('.custom-model-remove-btn');
      if (!removeBtn) return;

      const modelToRemove = removeBtn.dataset.model;
      if (!modelToRemove) return;
      if (!confirm(`カスタムモデル「${modelToRemove}」を削除しますか？`)) return;

      let customModels = await db.getSetting('custom_models', []);
      customModels = Array.isArray(customModels) ? customModels.filter(model => model && model !== modelToRemove) : [];
      await db.saveSetting('custom_models', customModels);

      const updates = {};
      if (getState().modelName === modelToRemove) {
        updates.modelName = 'gemini-2.5-flash';
        await db.saveSetting('model_name', updates.modelName);
      }
      if (getState().searchModelName === modelToRemove) {
        updates.searchModelName = '';
        await db.saveSetting('search_model_name', '');
      }
      if (getState().sessionSummaryModelName === modelToRemove) {
        updates.sessionSummaryModelName = '';
        await db.saveSetting('session_summary_model_name', '');
      }
      if (Object.keys(updates).length > 0) {
        updateState(updates);
      }

      populateModelSelect(modelEl, customModels, {
        selectedValue: updates.modelName || getState().modelName
      });
      populateModelSelect(searchModelEl, customModels, {
        includeFollowOption: true,
        followOptionLabel: '使用モデルに追従',
        selectedValue: updates.searchModelName !== undefined ? updates.searchModelName : getState().searchModelName
      });
      populateModelSelect(sessionSummaryModelEl, customModels, {
        includeFollowOption: true,
        followOptionLabel: '使用モデルに追従',
        selectedValue: updates.sessionSummaryModelName !== undefined ? updates.sessionSummaryModelName : getState().sessionSummaryModelName
      });
      renderCustomModelList(customModels);
    };
  }

  // 5. Active Story Configurations (World Settings changes)
  const rPrompt = document.getElementById('story-rule-prompt');
  const wPrompt = document.getElementById('story-world-prompt');
  const fInput = document.getElementById('story-franchise-input');
  const fContextInput = document.getElementById('story-franchise-context-input');
  const imageBaseUrlInput = document.getElementById('story-image-base-url-input');
  const imageDefaultOutfitInput = document.getElementById('story-image-default-outfit-input');
  let storyConfigSaveTimer = null;

  const saveCurrentStoryConfig = () => {
    const { currentStory } = getState();
    if (!currentStory) return;
    currentStory.storytellerPrompt = rPrompt.value.trim();
    currentStory.worldPrompt = wPrompt.value.trim();
    currentStory.franchise = fInput ? fInput.value.trim() : '';
    currentStory.franchiseContext = fContextInput ? fContextInput.value.trim() : '';
    currentStory.imageBaseUrl = imageBaseUrlInput ? imageBaseUrlInput.value.trim() : '';
    currentStory.imageDefaultOutfit = imageDefaultOutfitInput ? imageDefaultOutfitInput.value.trim() : '';

    if (storyConfigSaveTimer) clearTimeout(storyConfigSaveTimer);
    storyConfigSaveTimer = setTimeout(async () => {
      await db.saveStory(currentStory);
      const stateNow = getState();
      const nextStories = Array.isArray(stateNow.stories)
        ? stateNow.stories.map(story => story.storyId === currentStory.storyId ? currentStory : story)
        : [currentStory];
      updateState({ stories: nextStories });
    }, 180);
  };

  if (rPrompt) rPrompt.oninput = () => { saveCurrentStoryConfig(); triggerAutoResize(rPrompt); };
  if (wPrompt) wPrompt.oninput = () => { saveCurrentStoryConfig(); triggerAutoResize(wPrompt); };
  if (fInput) fInput.oninput = () => { saveCurrentStoryConfig(); };
  if (fContextInput) fContextInput.oninput = () => { saveCurrentStoryConfig(); };
  if (imageBaseUrlInput) imageBaseUrlInput.oninput = () => { saveCurrentStoryConfig(); };
  if (imageDefaultOutfitInput) imageDefaultOutfitInput.oninput = () => { saveCurrentStoryConfig(); };

  // Protagonist Profile updates
  const pName = document.getElementById('protagonist-name');
  const pDesc = document.getElementById('protagonist-desc');
  const pImgInput = document.getElementById('protagonist-img-input');
  const pPreview = document.getElementById('protagonist-img-preview');

  const saveProtagonistConfig = async () => {
    const { currentStory } = getState();
    if (!currentStory) return;
    if (!currentStory.protagonist) {
      currentStory.protagonist = { name: '主人公', avatarAssetId: '', description: '' };
    }

    currentStory.protagonist.name = pName.value.trim() || '主人公';
    currentStory.protagonist.description = pDesc.value.trim();
    
    await db.saveStory(currentStory);
    
    const stories = await db.getStories();
    updateState({ stories });
    ui.renderSidebar();
  };

  if (pName) pName.oninput = saveProtagonistConfig;
  if (pDesc) pDesc.oninput = () => { saveProtagonistConfig(); triggerAutoResize(pDesc); };
  
  if (pImgInput && pPreview) {
    pImgInput.onchange = async (e) => {
      const { currentStory } = getState();
      if (!currentStory) return;
      
      const file = e.target.files[0];
      if (file) {
        if (!currentStory.protagonist) {
          currentStory.protagonist = { name: '主人公', avatarAssetId: '', description: '' };
        }
        
        // 選択された画像に対して、大きなトリミングダイアログを起動
        ui.showAvatarCropModal(file, async (croppedBlob) => {
          if (currentStory.protagonist.avatarAssetId) {
            await db.deleteAsset(currentStory.protagonist.avatarAssetId);
          }
          
          const newAssetId = await db.saveAsset(croppedBlob, 'image/jpeg');
          currentStory.protagonist.avatarAssetId = newAssetId;
          pPreview.src = URL.createObjectURL(croppedBlob);
          
          await db.saveStory(currentStory);
          
          const stories = await db.getStories();
          updateState({ stories });
          ui.renderSidebar();
          queueDropboxAutoSync({
            storyId: currentStory.storyId,
            syncStory: true,
            assetIds: newAssetId ? [newAssetId] : []
          });
        });
      }
    };
  }

  // 5b. Character Library Search & Filter
  const librarySearchInput = document.getElementById('library-search-input');
  const libraryFilterSelect = document.getElementById('library-filter-select');
  if (librarySearchInput) {
    librarySearchInput.oninput = () => ui.renderCharacterLibrary();
  }
  if (libraryFilterSelect) {
    libraryFilterSelect.onchange = () => ui.renderCharacterLibrary();
  }

  // 6. Character Import Trigger
  const importCharInput = document.getElementById('char-import-input');
  const importCharBtn = document.getElementById('char-import-btn');
  if (importCharBtn && importCharInput) {
    importCharBtn.onclick = () => importCharInput.click();
    importCharInput.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        ui.importCharacterJSON(file);
      }
      e.target.value = '';
    };
  }
  const charPasteBtn = document.getElementById('char-paste-btn');
  if (charPasteBtn) {
    charPasteBtn.onclick = () => ui.showCharacterPasteModal();
  }

  // 6b. Lore Import Trigger
  const importLoreInput = document.getElementById('lore-import-input');
  const importLoreBtn = document.getElementById('lore-import-btn');
  if (importLoreBtn && importLoreInput) {
    importLoreBtn.onclick = () => importLoreInput.click();
    importLoreInput.onchange = async (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        await ui.importLoreJSON(files);
      }
      e.target.value = '';
    };
  }
  const lorePasteBtn = document.getElementById('lore-paste-btn');
  if (lorePasteBtn) {
    lorePasteBtn.onclick = () => ui.showLorePasteModal();
  }

  // 7. Dropbox buttons
  const dropboxAuthBtn      = document.getElementById('dropbox-auth-btn');
  const dropboxPushBtn      = document.getElementById('dropbox-push-btn');
  const dropboxPullBtn      = document.getElementById('dropbox-pull-btn');
  const dropboxDisconnectBtn = document.getElementById('dropbox-disconnect-btn');
  const dropboxFreqSelect   = document.getElementById('dropbox-sync-frequency');
  const dropboxAppKeyInput  = document.getElementById('dropbox-app-key-input');

  if (dropboxAppKeyInput) {
    dropboxAppKeyInput.oninput = (e) => {
      db.saveSetting('dropbox_app_key', e.target.value.trim());
    };
  }

  if (dropboxAuthBtn) {
    dropboxAuthBtn.onclick = () => startDropboxAuth();
  }
  if (dropboxPushBtn) {
    dropboxPushBtn.onclick = () => performDropboxPush();
  }
  if (dropboxPullBtn) {
    dropboxPullBtn.onclick = () => performDropboxPull();
  }
  if (dropboxDisconnectBtn) {
    dropboxDisconnectBtn.onclick = async () => {
      if (!confirm('Dropbox との連携を解除しますか？\nローカルのデータは削除されません。')) return;
      await dropbox.disconnect();
      updateDropboxUI(false);
    };
  }
  if (dropboxFreqSelect) {
    const savedFreq = await db.getSetting('dropbox_sync_frequency', '0');
    dropboxFreqSelect.value = savedFreq;
    dropboxFreqSelect.onchange = (e) => {
      db.saveSetting('dropbox_sync_frequency', e.target.value);
    };
  }
}

/**
 * Creates a new blank story in IndexedDB and activates it.
 */
async function promptForStoryTitle(defaultValue = '新規ストーリー') {
  return new Promise(resolve => {
    const existing = document.getElementById('story-title-prompt-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'story-title-prompt-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0, 0, 0, 0.55)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '4000';

    modal.innerHTML = `
      <div style="width:min(92vw, 420px); background: var(--bg-card, #fff); color: var(--text-color, #222); border: 1px solid var(--border-color, #ccc); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.25); padding: 18px; display:flex; flex-direction:column; gap:12px; box-sizing:border-box;">
        <div style="display:flex; flex-direction:column; gap:6px;">
          <h3 style="margin:0; font-size:16px;">新規ストーリー作成</h3>
          <p style="margin:0; font-size:12px; color: var(--text-sub, #666);">タイトルを入力してください。</p>
        </div>
        <input id="story-title-prompt-input" type="text" value="${defaultValue.replace(/"/g, '&quot;')}" style="width:100%; padding:10px 12px; border-radius:6px; border:1px solid var(--border-color, #ccc); background: var(--bg-input, transparent); color: var(--text-color, #fff); caret-color: var(--text-color, #fff); box-sizing:border-box;">
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button id="story-title-prompt-cancel" class="secondary-btn" type="button">キャンセル</button>
          <button id="story-title-prompt-ok" class="primary-btn" type="button">作成</button>
        </div>
      </div>
    `;

    const cleanup = (value) => {
      modal.remove();
      resolve(value);
    };

    document.body.appendChild(modal);

    const input = modal.querySelector('#story-title-prompt-input');
    const okBtn = modal.querySelector('#story-title-prompt-ok');
    const cancelBtn = modal.querySelector('#story-title-prompt-cancel');

    okBtn.onclick = () => cleanup((input.value || '').trim() || defaultValue);
    cancelBtn.onclick = () => cleanup(null);
    modal.onclick = (e) => {
      if (e.target === modal) cleanup(null);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        okBtn.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelBtn.click();
      }
    };

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

async function createNewStory() {
  const storyTitle = await promptForStoryTitle('新規ストーリー');
  if (storyTitle === null) return;

  const newStory = {
    title: storyTitle || '無題のストーリー',
    franchise: '', // ★作品タグ（原作検索・ロア用）
    franchiseContext: '',
    imageBaseUrl: '',
    imageDefaultOutfit: '',
    storytellerPrompt: '', // ★デフォルトの長い指示はコアに移動したため空でOK
    worldPrompt: DEFAULT_WORLD_PROMPT,
    tags: [],
    protagonist: {
      name: '主人公',
      avatarAssetId: '',
      description: '普通の男子高校生。'
    },
    characters: [], // Array of { characterId, attendance }
    messages: [
      {
        role: 'user',
        content: '物語を開始してください。',
        timestamp: Date.now() - 1000
      },
      {
        role: 'model',
        content: `新しい物語が始まりました。主人公の名前は「主人公」です。\n右側の設定パネルから、世界設定や主人公の詳細、登場人物の登録を確認してください。\n\nメッセージを入力するか、または送信してストーリーを開始してください。`,
        timestamp: Date.now()
      }
    ],
    session_lore: createEmptySessionLore(),
    story_plan: createEmptyStoryPlan(),
    characterMemory: {},
    relationshipMemory: {},
    lore_candidates: [],
    search_memory: []
  };

  try {
    const storyId = await db.saveStory(newStory);
    newStory.storyId = storyId;

    // 現在のタグ条件に一致するキャラクターを、このストーリーの管理対象として初期化
    const charactersList = await db.getCharacters();
    newStory.characters = buildStoryCharacterRefs(newStory, charactersList);
    await db.saveStory(newStory);

    // Refresh stories lists
    const stories = await db.getStories();
    updateState({ stories });
    setActiveStory(newStory);
    ui.renderStoryList();
    
    // Switch to story board screen
    updateState({ activeScreen: 'story' });
  } catch (err) {
    alert(`ストーリー作成に失敗しました: ${err.message}`);
  }
}

function getSessionLoreSignature(story) {
  return JSON.stringify({
    session_lore: ensureSessionLoreStructure(story),
    relationshipMemory: story?.relationshipMemory || null
  });
}

function cleanFallbackSummarySource(text) {
  const cleaned = (text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*\*/g, '')
    .replace(/[`#>*_]/g, '')
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^(A|B|C)[\.\):：）．、]/.test(trimmed)) return '';
      if (/^【[^】]+】$/.test(trimmed)) return '';

      const speakerMatch = trimmed.match(/^([^\s「【\[]{1,24}(?:（[^）]+）)?)[\:：]\s*(.+)$/);
      if (speakerMatch) {
        const speaker = (speakerMatch[1] || '').trim();
        const body = (speakerMatch[2] || '').replace(/^「|」$/g, '').trim();
        if (!body) return '';
        return `${speaker}: ${body}`;
      }

      return trimmed;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

function extractFallbackSessionSummary(text, options = {}) {
  const cleaned = cleanFallbackSummarySource(text);
  const sentences = splitJapaneseSentences(cleaned);
  const preferLast = options.preferLast === true;
  const minLength = Number.isFinite(Number(options.minLength)) ? Number(options.minLength) : 12;
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 120;
  const candidatePool = preferLast ? [...sentences].reverse() : sentences;
  const picked = candidatePool.find(sentence => sentence.length >= minLength) || cleaned;
  if (!picked) return '';
  return picked.length > limit ? `${picked.slice(0, limit - 3).trim()}...` : picked;
}

function buildFallbackSessionSummary(story, userText, aiText) {
  const sessionLore = story?.session_lore && typeof story.session_lore === 'object'
    ? story.session_lore
    : createEmptySessionLore();
  const previousSummary = (sessionLore.summary || '').trim();
  const actionSummary = extractFallbackSessionSummary(userText, { minLength: 4, limit: 90 });
  const currentSituation = extractFallbackSessionSummary(aiText, { minLength: 8, limit: 120 });
  const latestBeat = extractFallbackSessionSummary(aiText, { preferLast: true, minLength: 8, limit: 120 });

  const segments = [];
  if (actionSummary) {
    segments.push(`主人公の直近行動: ${actionSummary}`);
  }
  if (currentSituation) {
    segments.push(`現在状況: ${currentSituation}`);
  }
  if (latestBeat && latestBeat !== currentSituation) {
    segments.push(`直近展開: ${latestBeat}`);
  }

  if (segments.length === 0 && previousSummary) {
    return previousSummary;
  }

  const summary = segments.join('。 ').replace(/。 。/g, '。 ');
  return summary.length > 340 ? `${summary.slice(0, 337).trim()}...` : summary;
}

function applyFallbackSessionLoreUpdate(story, userText, aiText, options = {}) {
  const sessionLore = ensureSessionLoreStructure(story);

  const nextSummary = buildFallbackSessionSummary(story, userText, aiText);
  const rawUserText = String(userText || '').trim();
  const rawAiText = String(aiText || '').trim();
  const summarySource = String(sessionLore.summary_source || '').trim();
  const preserveAiSummary = options.preserveAiSummary === true &&
    ['ai', 'ai-summary'].includes(summarySource) &&
    String(sessionLore.summary || '').trim();
  const shouldKeepCompressedSummary = ['manual', 'ai-summary'].includes(summarySource) &&
    String(sessionLore.summary || '').trim();

  if (!preserveAiSummary && !shouldKeepCompressedSummary && nextSummary) {
    sessionLore.summary = nextSummary;
    sessionLore.summary_source = 'fallback';
  }

  if (!sessionLore.summary && rawAiText) {
    const fallbackSegments = [];
    if (rawUserText) fallbackSegments.push(`主人公の直近行動: ${rawUserText}`);
    fallbackSegments.push(`直近の応答要旨: ${rawAiText.length > 180 ? `${rawAiText.slice(0, 177).trim()}...` : rawAiText}`);
    sessionLore.summary = fallbackSegments.join('。 ').trim();
    sessionLore.summary_source = 'fallback';
  }

  if (getState().promptDebugEnabled) {
    console.log('[Session Lore Debug][extract]', JSON.stringify({
      storyId: story?.storyId || '',
      rawUserText,
      rawAiTextPreview: rawAiText.slice(0, 220),
      nextSummary
    }));
  }
}

/**
 * Main turn handler. Sends messages history and states to Gemini API and appends responses.
 * 再生成機能やエラー時のリトライ処理にも対応。
 */
async function submitStoryTurn(mode = 'normal') {
  const { currentStory, isGenerating } = getState();
  const inputEl = document.getElementById('user-input-field');
  
  if (!currentStory || isGenerating) return;

  const userText = inputEl ? inputEl.value.trim() : '';

  if (mode === 'regen') {
    // 【再生成】最後のAI応答（model）を削除して、再度生成を試みる
    if (currentStory.messages.length > 0 && currentStory.messages[currentStory.messages.length - 1].role === 'model') {
      currentStory.messages.pop();
    }
  } else if (mode === 'retry') {
    // 【リトライ】メッセージ配列を操作せず、そのままAPIへ送信する
  } else {
    // 【通常送信】
    if (userText) {
    const directedInput = parseDirectedUserInput(userText);
      currentStory.messages.push({
        role: 'user',
        content: userText,
        aiContent: directedInput.aiContent,
        directedUtterances: directedInput.utterances,
        timestamp: Date.now()
      });
      if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = 'auto'; // 送信後に高さをリセット
      }
    } else {
      // 送信欄が空の場合
      const lastMsg = currentStory.messages[currentStory.messages.length - 1];
      if (!lastMsg || lastMsg.role === 'model') {
        currentStory.messages.push({
          role: 'user',
          content: '（物語の続きを描写してください）',
          timestamp: Date.now()
        });
      }
      // すでに最後のメッセージが 'user' であれば、追加せずにリトライとしてAPIを叩く
    }
  }

  // ★ API送信前に、ユーザーの入力や編集内容を確実にDBへ保存しUIに反映
  await db.saveStory(currentStory);
  ui.renderStory();

  // Trigger AI generation
  updateState({ isGenerating: true });
  ui.renderStory();

  try {
    const beforeLoreSignature = getSessionLoreSignature(currentStory);
    const aiResponse = await generateStoryResponse(currentStory); // ★ 変数名を変更
    if (!aiResponse?.text) {
      throw new Error('AIから有効な本文が返されませんでした。');
    }

    const afterLoreSignature = getSessionLoreSignature(currentStory);
    applyFallbackSessionLoreUpdate(currentStory, userText, aiResponse.text, {
      preserveAiSummary: beforeLoreSignature !== afterLoreSignature
    });
    if (getState().promptDebugEnabled) {
      console.log('[Session Lore Debug][after-fallback]', JSON.stringify({
        storyId: currentStory.storyId,
        session_lore: currentStory.session_lore,
        relationshipMemory: currentStory.relationshipMemory
      }));
    }

    currentStory.messages.push({
      role: 'model',
      content: aiResponse.text,         // ★ 本文
      thought: aiResponse.thought || '', // ★ 思考内容を追加保存
      usage: aiResponse.usage || null,
      timestamp: Date.now()
    });

    await db.saveStory(currentStory);

    // バックグラウンド検索はコストが高いため、明示的に有効化された場合のみ実行する
    if (await isLoreAutoSearchEnabled()) {
      triggerBackgroundLoreLookup(currentStory);
    }
    
    // Auto sync story lists count
    const stories = await db.getStories();
    const refreshedStory = stories.find(story => story.storyId === currentStory.storyId) || currentStory;
    if (getState().promptDebugEnabled) {
      console.log('[Session Lore Debug][after-reload]', JSON.stringify({
        storyId: refreshedStory.storyId,
        session_lore: refreshedStory.session_lore,
        relationshipMemory: refreshedStory.relationshipMemory
      }));
    }
    updateState({ stories, isGenerating: false });
    setActiveStory(refreshedStory);
    ui.renderStory();
    ui.renderStoryList();
    ui.renderSidebar();
    await ui.renderLorebook();

    // Auto-sync to Dropbox in the background.
    queueDropboxAutoSync({ storyId: refreshedStory.storyId });

    if (shouldAutoSummarizeStory(refreshedStory, getState())) {
      runSessionSummary(refreshedStory.storyId, { mode: 'auto' }).catch(err => {
        console.warn('[Session Summary] Auto summary task failed:', err);
      });
    }

  } catch (err) {
    // ユーザーによる意図的なキャンセル（手動停止）の場合
    if (err.message && err.message.includes('中止されました')) {
      updateState({ isGenerating: false });
      ui.renderStory();
      return;
    }

    alert(`ストーリーテラーの応答生成中にエラーが発生しました:\n${err.message}`);
    
    // ★ エラー時にユーザーの入力を消さずに（popせずに）そのまま保存して状態を保つ
    await db.saveStory(currentStory);

    updateState({ isGenerating: false });
    ui.renderStory();
  }
}
function parseDirectedUserInput(text) {
  const utterances = [];
  const passthrough = [];
  const directiveRegex = /^@:\s*([^「」:：\n]+)\s*(?:「([^」]*)」|[:：]\s*(.+)|\s+(.+))\s*$/;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(directiveRegex);
    if (!match) {
      if (trimmed) passthrough.push(line);
      continue;
    }

    const speaker = match[1].trim();
    const speech = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!speaker || !speech) {
      passthrough.push(line);
      continue;
    }
    utterances.push({ speaker, speech });
  }

  if (utterances.length === 0) {
    return { aiContent: text, utterances: [] };
  }

  const lines = [
    '【ユーザー指定発言】',
    '以下の発言はユーザーが直接指定した台詞です。指定された発言者の発言として扱い、次の展開に自然に反映してください。'
  ];
  for (const item of utterances) {
    lines.push(`${item.speaker}: 「${item.speech}」`);
  }
  if (passthrough.length > 0) {
    lines.push('', '【ユーザー補足】', ...passthrough);
  }

  return { aiContent: lines.join('\n'), utterances };
}
// ============================================================
// Dropbox 同期ヘルパー
// ============================================================

/** Dropbox 接続状態を確認し、UIを初期化する */
async function initDropbox() {
  const connected = await dropbox.isConnected();
  updateDropboxUI(connected);

  if (connected) {
    try {
      const account = await dropbox.testConnection();
      const nameEl = document.getElementById('dropbox-user-name');
      if (nameEl && account?.name?.display_name) {
        nameEl.textContent = account.name.display_name + ' のアカウントと連携済み';
      }
      const lastSync = await db.getSetting('dropbox_last_sync', null);
      updateLastSyncText(lastSync);
      updateSyncStatusIndicator('idle');
    } catch (e) {
      console.warn('[Dropbox] 接続テストに失敗しました。', e);
      const nameEl = document.getElementById('dropbox-user-name');
      if (nameEl && !nameEl.textContent.trim()) {
        nameEl.textContent = 'Dropbox と連携済み (接続確認に失敗)';
      }
      updateSyncStatusIndicator('idle');
    }
  }
}

/** 接続状態に応じて設定画面のDropbox UIを切り替える */
function updateDropboxUI(connected) {
  const authState      = document.getElementById('dropbox-auth-state');
  const connectedState = document.getElementById('dropbox-connected-state');
  if (authState)      authState.classList.toggle('hidden', connected);
  if (connectedState) connectedState.classList.toggle('hidden', !connected);
}

/** 最終同期時刻を表示する */
function updateLastSyncText(timestamp) {
  const el = document.getElementById('dropbox-last-sync-text');
  if (!el) return;
  if (!timestamp) {
    el.textContent = 'まだ同期していません';
    return;
  }
  const d = new Date(timestamp);
  el.textContent = `最終同期: ${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP')}`;
}

/** 同期進捗メッセージを表示する */
function setDropboxProgress(msg) {
  const el = document.getElementById('dropbox-sync-progress');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
    el.textContent = '';
  }
}

const DROPBOX_PKCE_STORAGE_KEY = 'dropbox_pkce_pending';

/** PKCE 情報を sessionStorage + localStorage に保存（モバイルで session が消える対策） */
function saveDropboxPkceSession({ codeVerifier, state, redirectUri, clientId }) {
  const payload = JSON.stringify({
    codeVerifier,
    state,
    redirectUri,
    clientId,
    savedAt: Date.now()
  });
  sessionStorage.setItem('dropbox_code_verifier', codeVerifier);
  sessionStorage.setItem('dropbox_oauth_state', state);
  sessionStorage.setItem('dropbox_redirect_uri', redirectUri);
  sessionStorage.setItem('dropbox_client_id', clientId);
  localStorage.setItem(DROPBOX_PKCE_STORAGE_KEY, payload);
}

/** 保存済み PKCE を読み出す（10 分以内のみ有効） */
function loadDropboxPkceSession() {
  try {
    const raw = localStorage.getItem(DROPBOX_PKCE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.codeVerifier || !data?.state || !data?.redirectUri || !data?.clientId) return null;
    if (Date.now() - (data.savedAt || 0) > 10 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

function clearDropboxPkceSession() {
  sessionStorage.removeItem('dropbox_code_verifier');
  sessionStorage.removeItem('dropbox_oauth_state');
  sessionStorage.removeItem('dropbox_redirect_uri');
  sessionStorage.removeItem('dropbox_client_id');
  localStorage.removeItem(DROPBOX_PKCE_STORAGE_KEY);
}

function stripOAuthQueryFromUrl() {
  const cleanUrl = dropbox.getOAuthRedirectUri();
  window.history.replaceState({}, document.title, cleanUrl);
  return cleanUrl;
}

/** URL に OAuth 戻りパラメータがあれば処理する */
async function handleDropboxOAuthReturnIfPresent() {
  const urlParams = new URLSearchParams(window.location.search);
  if (!urlParams.has('code') && !urlParams.has('error')) return;

  if (urlParams.has('error')) {
    const msg = urlParams.get('error_description') || urlParams.get('error') || '認可がキャンセルされました';
    clearDropboxPkceSession();
    stripOAuthQueryFromUrl();
    alert(`Dropbox 認証エラー:\n${msg}`);
    return;
  }

  if (!urlParams.has('state')) return;

  await handleDropboxOAuthCallback(urlParams);
}

/**
 * Dropbox PKCE 認証フローを開始する。
 */
async function startDropboxAuth() {
  try {
    const appKey = await dropbox.getAppKey();
    if (!appKey) {
      alert('Dropbox App key が未設定です。設定画面で App key を入力してください。');
      return;
    }

    const { codeVerifier, codeChallenge } = await dropbox.generatePKCE();
    const redirectUri = dropbox.getOAuthRedirectUri();
    const state = crypto.randomUUID();

    saveDropboxPkceSession({ codeVerifier, state, redirectUri, clientId: appKey });

    const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', appKey);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('token_access_type', 'offline');

    window.location.assign(authUrl.toString());
  } catch (err) {
    alert(`Dropbox 認証の開始に失敗しました:\n${err.message}`);
  }
}

/**
 * OAuth コールバック処理。URLパラメータの code を使ってトークンを取得する。
 */
async function handleDropboxOAuthCallback(urlParams) {
  const code = urlParams.get('code');
  const returnedState = urlParams.get('state');

  const savedFromStorage = loadDropboxPkceSession();
  const savedState = sessionStorage.getItem('dropbox_oauth_state') || savedFromStorage?.state;
  const codeVerifier = sessionStorage.getItem('dropbox_code_verifier') || savedFromStorage?.codeVerifier;
  const redirectUri = sessionStorage.getItem('dropbox_redirect_uri') || savedFromStorage?.redirectUri || dropbox.getOAuthRedirectUri();
  const clientId = sessionStorage.getItem('dropbox_client_id') || savedFromStorage?.clientId || await dropbox.getAppKey();

  stripOAuthQueryFromUrl();

  if (!codeVerifier) {
    clearDropboxPkceSession();
    alert(
      'Dropbox 認証の途中データが見つかりませんでした。\n' +
      '（別タブで開いた、プライベート閲覧、ブラウザのストレージ制限などが原因のことがあります）\n\n' +
      'もう一度「Dropbox と連携する」からやり直してください。'
    );
    return;
  }

  if (!savedState || returnedState !== savedState) {
    clearDropboxPkceSession();
    alert(
      'Dropbox 認証の検証に失敗しました（セッション不一致）。\n' +
      '同じブラウザ・同じタブで、もう一度「Dropbox と連携する」からやり直してください。'
    );
    return;
  }

  clearDropboxPkceSession();

  try {
    await dropbox.getAccessToken(code, redirectUri, codeVerifier, clientId);
    const account = await dropbox.testConnection();
    updateDropboxUI(true);

    const nameEl = document.getElementById('dropbox-user-name');
    if (nameEl && account?.name?.display_name) {
      nameEl.textContent = account.name.display_name + ' のアカウントと連携済み';
    }

    alert(`Dropbox との連携が完了しました！\n「クラウドへ保存 (Push)」で初回バックアップを行ってください。`);
  } catch (err) {
    console.error('[Dropbox] OAuth token exchange failed:', err);
    alert(
      `Dropbox 認証に失敗しました:\n${err.message}\n\n` +
      `※ 使用した App key: ${clientId}\n` +
      `※ Dropbox アプリ設定の「Redirect URI」に次が登録されているか確認してください:\n${dropbox.PRODUCTION_OAUTH_REDIRECT_URI}\n\n` +
      `「code is associated with a different app key」が出る場合:\n` +
      `設定の App key と認可開始時のキーが一致しているか確認し、もう一度連携してください。`
    );
  }
}

/**
 * ローカルデータを Dropbox へ Push する。
 */
async function performDropboxPush() {
  const pushBtn = document.getElementById('dropbox-push-btn');
  const pullBtn = document.getElementById('dropbox-pull-btn');
  if (pushBtn) pushBtn.disabled = true;
  if (pullBtn) pullBtn.disabled = true;

  try {
    setDropboxProgress(activeDropboxSyncLabel ? `他の同期 (${activeDropboxSyncLabel}) の完了待ち...` : '同期待機中...');
    await runExclusiveDropboxSync('manual-push', async () => {
      const stories    = await db.getStories();
      const characters = await db.getCharacters();
      const lores      = await db.getWorldLores();

      const assetIds = new Set();
      [...stories, ...characters].forEach(item => {
        if (item.protagonist?.avatarAssetId) assetIds.add(item.protagonist.avatarAssetId);
        if (item.avatarAssetId) assetIds.add(item.avatarAssetId);
      });

      const assets = [];
      for (const assetId of assetIds) {
        if (!assetId) continue;
        const blob = await db.getAssetBlob(assetId);
        if (blob) assets.push({ assetId, blob });
      }

      const pushedManifest = await dropbox.pushToDropbox({
        stories,
        characters,
        lores,
        settings: await collectDropboxSettings(),
        assets,
        onProgress: msg => setDropboxProgress(msg)
      });
      await saveDropboxManifestSnapshot(pushedManifest);

      const now = Date.now();
      await db.saveSetting('dropbox_last_sync', now);
      const remoteManifestUpdatedAt = await dropbox.getLastRemoteManifestUpdatedAt();
      if (remoteManifestUpdatedAt) {
        await db.saveSetting('dropbox_remote_manifest_updated_at', remoteManifestUpdatedAt);
      }
      updateLastSyncText(now);
    });
    setDropboxProgress(null);
    alert('クラウドへの保存が完了しました！');
  } catch (err) {
    setDropboxProgress(null);
    alert(`Push 同期に失敗しました:\n${err.message}`);
  } finally {
    if (pushBtn) pushBtn.disabled = false;
    if (pullBtn) pullBtn.disabled = false;
  }
}

/**
 * Dropbox からデータを Pull し、ローカルに反映する。
 */
async function performDropboxPull() {
  if (!confirm('クラウドからデータを復元します。\n現在のローカルデータは上書きされます。続行しますか？')) return;

  const pushBtn = document.getElementById('dropbox-push-btn');
  const pullBtn = document.getElementById('dropbox-pull-btn');
  if (pushBtn) pushBtn.disabled = true;
  if (pullBtn) pullBtn.disabled = true;

  try {
    setDropboxProgress(activeDropboxSyncLabel ? `他の同期 (${activeDropboxSyncLabel}) の完了待ち...` : '同期待機中...');
    let result = null;
    await runExclusiveDropboxSync('manual-pull', async () => {
      const localAssets = await db.getAll('assets');
      const localAssetIds = new Set(localAssets.map(a => a.assetId));

      const pulled = await dropbox.pullFromDropbox({
        localAssetIds,
        onProgress: msg => setDropboxProgress(msg)
      });

      if (!pulled.stories) {
        result = pulled;
        return;
      }

      setDropboxProgress('ローカルデータを更新中...');

      await applyDropboxPullToLocal(pulled, { forceFull: true });
      await saveDropboxManifestSnapshot(pulled.manifest);

      const now = Date.now();
      await db.saveSetting('dropbox_last_sync', now);
      const remoteManifestUpdatedAt = await dropbox.getLastRemoteManifestUpdatedAt();
      if (remoteManifestUpdatedAt) {
        await db.saveSetting('dropbox_remote_manifest_updated_at', remoteManifestUpdatedAt);
      }
      updateLastSyncText(now);
      result = pulled;
    });

    if (!result?.stories) {
      setDropboxProgress(null);
      alert('クラウドにデータが見つかりませんでした。');
      return;
    }

    setDropboxProgress(null);

    const updatedStories = await db.getStories();
    const updatedChars   = await db.getCharacters();
    updateState({ stories: updatedStories, characters: updatedChars });

    if (updatedStories.length > 0) {
      updatedStories.sort((a, b) => b.timestamp - a.timestamp);
      setActiveStory(updatedStories[0]);
    }

    ui.renderStoryList();
    ui.renderCharacterLibrary();
    ui.renderLorebook();
    ui.renderStory();
    ui.renderSidebar();

    alert(`クラウドからの復元が完了しました！\nストーリー: ${result.stories.length}件, キャラクター: ${result.characters.length}件, ロア: ${(result.lores || []).length}件, 新規アセット: ${result.newAssets.length}件`);
  } catch (err) {
    setDropboxProgress(null);
    alert(`Pull 同期に失敗しました:\n${err.message}`);
  } finally {
    if (pushBtn) pushBtn.disabled = false;
    if (pullBtn) pullBtn.disabled = false;
  }
}

/** ターン終了後に自動同期を行うか確認する（静的UI表示） */
function queueDropboxAutoSync(request = {}) {
  const hasExplicitScope =
    request?.syncStory !== undefined ||
    request?.syncLores !== undefined ||
    request?.syncCharacters !== undefined;
  const uniq = values => [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  const uniqLoreFranchises = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim() || '共通').filter(Boolean))];
  const normalized = {
    storyId: request?.storyId || null,
    forceFull: !!request?.forceFull,
    syncStory: hasExplicitScope ? !!request.syncStory : !!request?.storyId,
    syncLores: !!request?.syncLores,
    syncCharacters: !!request?.syncCharacters,
    characterIds: uniq(request?.characterIds),
    assetIds: uniq(request?.assetIds),
    loreFranchises: uniqLoreFranchises(request?.loreFranchises)
  };
  if (!normalized.forceFull && !normalized.syncStory && !normalized.syncLores && !normalized.syncCharacters) {
    normalized.forceFull = true;
  }
  pendingDropboxAutoSync = pendingDropboxAutoSync
    ? {
      storyId: normalized.storyId || pendingDropboxAutoSync.storyId || null,
      forceFull: pendingDropboxAutoSync.forceFull || normalized.forceFull,
      syncStory: pendingDropboxAutoSync.syncStory || normalized.syncStory,
      syncLores: pendingDropboxAutoSync.syncLores || normalized.syncLores,
      syncCharacters: pendingDropboxAutoSync.syncCharacters || normalized.syncCharacters,
      characterIds: uniq([...(pendingDropboxAutoSync.characterIds || []), ...normalized.characterIds]),
      assetIds: uniq([...(pendingDropboxAutoSync.assetIds || []), ...normalized.assetIds]),
      loreFranchises: uniqLoreFranchises([...(pendingDropboxAutoSync.loreFranchises || []), ...normalized.loreFranchises])
    }
    : normalized;
  if (isDropboxAutoSyncRunning) return;

  isDropboxAutoSyncRunning = true;
  setTimeout(async () => {
    try {
      while (pendingDropboxAutoSync) {
        const next = pendingDropboxAutoSync;
        pendingDropboxAutoSync = null;
        await performAutoDropboxSync(next);
      }
    } finally {
      isDropboxAutoSyncRunning = false;
      if (pendingDropboxAutoSync) queueDropboxAutoSync(pendingDropboxAutoSync);
    }
  }, 0);
}

async function performAutoDropboxSync({ storyId = null, forceFull = false, syncStory = false, syncLores = false, syncCharacters = false, characterIds = [], assetIds = [], loreFranchises = [] } = {}) {
  const connected = await dropbox.isConnected();
  if (!connected) return;

  const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);
  if (freq === 0) return;

  const counter = (parseInt(await db.getSetting('dropbox_sync_counter', '0'), 10) + 1);
  await db.saveSetting('dropbox_sync_counter', counter);

  if (counter >= freq) {
    await db.saveSetting('dropbox_sync_counter', 0);
    console.log('[Dropbox] 自動同期を開始...');
    await runExclusiveDropboxSync('auto-sync', async () => {
      updateSyncStatusIndicator('syncing');
      try {
        let completed = false;
        if (!forceFull && (syncStory || syncLores || syncCharacters)) {
          completed = await performDropboxSelectiveAutoSync({ storyId, syncStory, syncLores, syncCharacters, characterIds, assetIds, loreFranchises });
          if (!completed) {
            console.log('[Dropbox AutoSync] 差分同期の基準がないため、フル同期します。');
          }
        }
        if (!completed) {
          completed = await performDropboxPushSilent({ storyId, preferDelta: !forceFull && syncStory && !syncLores });
        }
        if (completed && typeof completed === 'object') {
          await saveDropboxManifestSnapshot(completed);
        }
        const now = Date.now();
        await db.saveSetting('dropbox_last_sync', now);
        const remoteManifestUpdatedAt = await dropbox.getLastRemoteManifestUpdatedAt();
        if (remoteManifestUpdatedAt) {
          await db.saveSetting('dropbox_remote_manifest_updated_at', remoteManifestUpdatedAt);
        }
        updateLastSyncText(now);
        updateSyncStatusIndicator('success');
      } catch (e) {
        console.warn('[Dropbox] 自動同期に失敗しました:', e);
        updateSyncStatusIndicator('error');
      }
    });
  }
}

/**
 * Silent push (no alert, no button disable — for auto-sync).
 */
async function performDropboxPushSilent({ storyId = null, preferDelta = false } = {}) {
  const stories    = await db.getStories();
  const characters = await db.getCharacters();
  const lores      = await db.getWorldLores();
  const settings = await collectDropboxSettings();

  if (preferDelta && storyId) {
    const story = stories.find(item => item.storyId === storyId);
    if (story) {
      const result = await dropbox.pushStoryDeltaToDropbox({
        story,
        settings,
        onProgress: msg => console.log('[Dropbox AutoSync]', msg)
      });
      if (result) return result;
      console.log('[Dropbox AutoSync] 差分同期の基準がないため、初回のみフル同期します。');
    }
  }

  const assetIds = new Set();
  [...stories, ...characters].forEach(item => {
    if (item.protagonist?.avatarAssetId) assetIds.add(item.protagonist.avatarAssetId);
    if (item.avatarAssetId) assetIds.add(item.avatarAssetId);
  });

  const assets = [];
  for (const assetId of assetIds) {
    if (!assetId) continue;
    const blob = await db.getAssetBlob(assetId);
    if (blob) assets.push({ assetId, blob });
  }

  return await dropbox.pushToDropbox({
    stories,
    characters,
    lores,
    settings,
    assets,
    onProgress: msg => console.log('[Dropbox AutoSync]', msg)
  });
}

async function performDropboxSelectiveAutoSync({ storyId = null, syncStory = false, syncLores = false, syncCharacters = false, characterIds = [], assetIds = [], loreFranchises = [] } = {}) {
  const stories = await db.getStories();
  const uniqueCharacterIds = [...new Set((characterIds || []).filter(Boolean))];
  const uniqueAssetIds = [...new Set((assetIds || []).filter(Boolean))];
  const needsSettingsDelta = syncStory || syncLores || syncCharacters;
  const settings = needsSettingsDelta ? await collectDropboxSettings() : null;
  let lastManifest = null;

  if (syncStory && storyId) {
    const story = stories.find(item => item.storyId === storyId);
    if (story) {
      const storyAssetIds = [];
      if (uniqueAssetIds.length > 0 && story?.protagonist?.avatarAssetId && uniqueAssetIds.includes(story.protagonist.avatarAssetId)) {
        storyAssetIds.push(story.protagonist.avatarAssetId);
      }
      const storyAssets = [];
      for (const assetId of storyAssetIds) {
        const blob = await db.getAssetBlob(assetId);
        if (blob) storyAssets.push({ assetId, blob });
      }
      const storyResult = await dropbox.pushStoryDeltaToDropbox({
        story,
        settings,
        assets: storyAssets,
        onProgress: msg => console.log('[Dropbox AutoSync]', msg)
      });
      if (!storyResult) return false;
      lastManifest = storyResult;
    } else {
      const storyResult = await dropbox.pushStoryDeltaToDropbox({
        story: null,
        settings,
        assets: [],
        onProgress: msg => console.log('[Dropbox AutoSync]', msg)
      });
      if (!storyResult) return false;
      lastManifest = storyResult;
    }
  }

  if (syncCharacters && uniqueCharacterIds.length > 0) {
    const allCharacters = await db.getCharacters();
    const targetCharacters = allCharacters.filter(item => uniqueCharacterIds.includes(item.characterId));
    if (targetCharacters.length === 0) return false;

    const relevantAssetIds = uniqueAssetIds.length > 0
      ? uniqueAssetIds
      : targetCharacters.map(item => item.avatarAssetId).filter(Boolean);
    const characterAssets = [];
    for (const assetId of relevantAssetIds) {
      const blob = await db.getAssetBlob(assetId);
      if (blob) characterAssets.push({ assetId, blob });
    }

    const characterResult = await dropbox.pushCharacterDeltaToDropbox({
      characters: targetCharacters,
      settings,
      assets: characterAssets,
      onProgress: msg => console.log('[Dropbox AutoSync]', msg)
    });
    if (!characterResult) return false;
    lastManifest = characterResult;
  } else if (syncCharacters && uniqueCharacterIds.length === 0 && uniqueAssetIds.length > 0) {
    const characterResult = await dropbox.pushCharacterDeltaToDropbox({
      characters: [],
      settings,
      assets: [],
      onProgress: msg => console.log('[Dropbox AutoSync]', msg)
    });
    if (!characterResult) return false;
    lastManifest = characterResult;
  }

  if (syncLores) {
    const lores = await db.getWorldLores();
    const loreResult = await dropbox.pushLoreDeltaToDropbox({
      lores,
      settings,
      franchises: [...new Set((Array.isArray(loreFranchises) ? loreFranchises : []).map(value => String(value || '').trim() || '共通').filter(Boolean))],
      onProgress: msg => console.log('[Dropbox AutoSync]', msg)
    });
    if (!loreResult) return false;
    lastManifest = loreResult;
  }

  return lastManifest || true;
}

/**
 * Updates the sync status indicator in the header.
 * States: 'syncing', 'success', 'error', 'offline', 'idle'
 */
function updateSyncStatusIndicator(status) {
  const indicator = document.getElementById('sync-status-indicator');
  if (!indicator) return;
  const iconEl = indicator.querySelector('.material-symbols-outlined');
  if (!iconEl) return;

  if (status === 'idle' && isDropboxSyncBusy()) {
    status = 'syncing';
  }

  const token = ++syncStatusUpdateToken;
  indicator.classList.remove('hidden');
  indicator.className = 'sync-status-indicator';

  switch (status) {
    case 'syncing':
      iconEl.textContent = 'cloud_sync';
      indicator.classList.add('sync-active');
      indicator.title = '同期中...';
      break;
    case 'success':
      iconEl.textContent = 'cloud_done';
      indicator.classList.add('sync-success');
      indicator.title = '同期完了';
      setTimeout(() => {
        if (token !== syncStatusUpdateToken || isDropboxSyncBusy()) return;
        indicator.classList.remove('sync-success');
        indicator.classList.add('sync-idle');
        iconEl.textContent = 'cloud_done';
        indicator.title = 'Dropbox 連携済み';
      }, 3000);
      break;
    case 'error':
      iconEl.textContent = 'cloud_off';
      indicator.classList.add('sync-error');
      indicator.title = '同期エラー';
      break;
    case 'offline':
      iconEl.textContent = 'cloud_off';
      indicator.classList.add('sync-offline');
      indicator.title = 'オフライン';
      break;
    default:
      iconEl.textContent = 'cloud_done';
      indicator.classList.add('sync-idle');
      indicator.title = 'Dropbox 連携済み';
  }
}

/** 
 * ローカルの更新（ストーリーやキャラクター）が、前回の同期時刻より新しいか判定
 */
async function hasNewerLocalChanges() {
  const lastSync = parseInt(await db.getSetting('dropbox_last_sync', '0'), 10) || 0;
  const localChangeAt = parseInt(await db.getLocalChangeMarker(), 10) || 0;
  return localChangeAt > lastSync;
}

/** Auto-pull on app startup if connected and frequency > 0 */
async function performStartupSync() {
  const connected = await dropbox.isConnected();
  if (!connected) return;

  const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);
  if (freq === 0) return;

  await runExclusiveDropboxSync('startup-sync', async () => {
    updateSyncStatusIndicator('syncing');
    try {
      if (await hasNewerLocalChanges()) {
        console.log('[Dropbox StartupSync] ローカルに最新の未同期編集があります。Pullをスキップし、直近ストーリーを差分Pushします。');
        const lastActiveId = await db.getSetting('last_active_story_id', null);
        const localStories = await db.getStories();
        const latestStory = localStories
          .slice()
          .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];
        const targetStoryId = lastActiveId || latestStory?.storyId || null;
        const completed = targetStoryId
          ? await performDropboxSelectiveAutoSync({ storyId: targetStoryId, syncStory: true })
          : false;
        if (!completed) {
          console.warn('[Dropbox StartupSync] 差分Pushできるストーリーがないため、起動時の重いフルPushはスキップしました。手動Pushで全体同期できます。');
          updateSyncStatusIndicator('error');
          return;
        }
        if (completed && typeof completed === 'object') {
          await saveDropboxManifestSnapshot(completed);
        }
        const now = Date.now();
        await db.saveSetting('dropbox_last_sync', now);
        const remoteManifestUpdatedAt = await dropbox.getLastRemoteManifestUpdatedAt();
        if (remoteManifestUpdatedAt) {
          await db.saveSetting('dropbox_remote_manifest_updated_at', remoteManifestUpdatedAt);
        }
        updateLastSyncText(now);
        updateSyncStatusIndicator('success');
        return;
      }

      const knownRemoteManifestUpdatedAt = parseInt(await db.getSetting('dropbox_remote_manifest_updated_at', '0'), 10) || 0;
      const remoteManifestInfo = await dropbox.getRemoteManifestInfo();
      if (remoteManifestInfo?.updatedAt && remoteManifestInfo.updatedAt === knownRemoteManifestUpdatedAt) {
        console.log('[Dropbox StartupSync] クラウド側の manifest に変更がないため、重いプルをスキップします。');
        updateSyncStatusIndicator('success');
        return;
      }

      const localAssets = await db.getAll('assets');
      const localAssetIds = new Set(localAssets.map(a => a.assetId));
      const previousManifest = await getStoredDropboxManifestSnapshot();

      const pulled = await dropbox.pullFromDropbox({
        localAssetIds,
        previousManifest,
        differential: !!previousManifest,
        onProgress: msg => console.log('[Dropbox StartupSync]', msg)
      });

      if (pulled?.stories) {
        await applyDropboxPullToLocal(pulled, { forceFull: !pulled.delta });
        await saveDropboxManifestSnapshot(pulled.manifest);
        const updatedStories = await db.getStories();
        const updatedChars   = await db.getCharacters();
        updateState({ stories: updatedStories, characters: updatedChars });

        if (updatedStories.length > 0) {
          updatedStories.sort((a, b) => b.timestamp - a.timestamp);
          const lastActiveId = await db.getSetting('last_active_story_id', null);
          let targetStory = updatedStories.find(s => s.storyId === lastActiveId);
          if (!targetStory) targetStory = updatedStories[0];
          setActiveStory(targetStory);
        }
        ui.renderStoryList();
        ui.renderCharacterLibrary();
        ui.renderLorebook();
      }

      const now = Date.now();
      await db.saveSetting('dropbox_last_sync', now);
      const remoteManifestUpdatedAt = await dropbox.getLastRemoteManifestUpdatedAt();
      if (remoteManifestUpdatedAt) {
        await db.saveSetting('dropbox_remote_manifest_updated_at', remoteManifestUpdatedAt);
      }
      updateLastSyncText(now);
      updateSyncStatusIndicator('success');
    } catch (e) {
      console.warn('[Dropbox] 起動時同期に失敗:', e);
      updateSyncStatusIndicator('error');
    }
  });
}

/** Sync on tab return (visibility change) */
function setupVisibilitySync() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
// タブ復帰だけでは同期しない。同期は起動時・チャット更新時・明示操作に限定する。
    // Chrome などのフォーカス変更で過剰同期が走るのを避けるため、ここでは表示だけ整える。
    if (await dropbox.isConnected()) {
      updateSyncStatusIndicator(isDropboxSyncBusy() ? 'syncing' : 'idle');
    }

  });
}

// ==========================================
// 自動ロア検索バックグラウンド処理
// ==========================================

async function triggerBackgroundLoreLookup(story) {
  if (!(await isLoreAutoSearchEnabled())) {
    console.log('[Lore Automatic Lookup] Skipped because auto lore search is disabled.');
    return;
  }

  const franchise = await resolveLoreFranchise(story);
  if (!franchise) {
    console.log('[Lore Automatic Lookup] Skipped because no franchise could be resolved.');
    return;
  }

  if (!story.franchise) {
    story.franchise = franchise;
    db.saveStory(story).catch(err => {
      console.warn('[Lore Automatic Lookup] Failed to persist inferred franchise:', err);
    });
  }

  const detectedKeywords = extractKeywordsForLore(story);
  if (detectedKeywords.length === 0) {
    console.log('[Lore Automatic Lookup] No keyword candidates found for franchise:', franchise);
    return;
  }

  console.log('[Lore Automatic Lookup] Resolved franchise and keywords:', franchise, detectedKeywords);

  for (const keyword of detectedKeywords) {
    try {
      const existing = await db.getLoreByNameAndFranchise(keyword, franchise);
      if (existing && ['completed', 'pending', 'failed'].includes(existing.status)) {
        continue;
      }

      const placeholder = {
        id: 'lore_' + crypto.randomUUID(),
        franchise,
        type: 'term',
        name: keyword,
        content: {
          summary: 'Searching lore...',
          profile: '',
          speech: '',
          relationships: ''
        },
        source: 'ai-generated',
        verified: false,
        status: 'pending'
      };
      await db.saveLore(placeholder);
      queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
      if (getState().activeScreen === 'lorebook') {
        ui.renderLorebook();
      }

      executeLoreLookup(placeholder, keyword, franchise, story);
    } catch (e) {
      console.warn(`Error check or initial save for lore keyword ${keyword}:`, e);
    }
  }
}

async function executeLoreLookup(placeholder, keyword, franchise, story) {
  try {
    console.log(`[Lore Automatic Lookup] Starting search for [${franchise}] ${keyword}`);
    const result = await generateLoreProfileFromSearch(keyword, franchise);

    if (shouldSkipAutoLoreRegistration(result, story)) {
      console.log(`[Lore Automatic Lookup] Skipped auto-registration for ${keyword}: ${result?.reason || 'not a stable world lore entry'}`);
      await db.deleteLore(placeholder.id);
      queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
      return;
    }

    const canonicalName = normalizeLoreEntryName(result.canonicalName || keyword);
    if (!canonicalName) {
      await db.deleteLore(placeholder.id);
      queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
      return;
    }

    const existingCanonical = await db.getLoreByNameAndFranchise(canonicalName, franchise);
    if (existingCanonical && existingCanonical.id !== placeholder.id) {
      console.log(`[Lore Automatic Lookup] Skipped duplicate lore for ${canonicalName}.`);
      await db.deleteLore(placeholder.id);
      queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
      return;
    }

    if (result.type === 'character' && await hasCharacterLibraryConflict(canonicalName, franchise)) {
      console.log(`[Lore Automatic Lookup] Skipped duplicate character lore for ${canonicalName} because character library data takes priority.`);
      await db.deleteLore(placeholder.id);
      queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
      return;
    }

    placeholder.name = canonicalName;
    placeholder.content = {
      summary: result.summary || '',
      profile: result.profile || '',
      speech: result.speech || '',
      relationships: result.relationships || ''
    };
    placeholder.type = result.type || 'term';
    placeholder.status = 'completed';
    await db.saveLore(placeholder);
    queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
    console.log(`[Lore Automatic Lookup] Completed and saved lore for ${keyword}`);
    
    // ロアブック画面が表示されている場合はリアルタイムに再描画
    if (getState().activeScreen === 'lorebook') {
      ui.renderLorebook();
    }
  } catch (err) {
    console.error(`[Lore Automatic Lookup] Failed for keyword ${keyword}:`, err);
    placeholder.status = 'failed';
    placeholder.content.summary = `自動検索に失敗しました。Error: ${err.message}`;
    await db.saveLore(placeholder);
    queueDropboxAutoSync({ storyId: story?.storyId || null, syncLores: true, loreFranchises: [franchise || '共通'] });
    if (getState().activeScreen === 'lorebook') {
      ui.renderLorebook();
    }
  }
}

// 補助用にai-client.jsと同様の簡易抽出をapp.js内にも持たせる
function extractKeywordsForLore(story) {
  const wordsSet = new Set();
  const textSource = [];
  const msgs = story.messages || [];
  const startIdx = Math.max(0, msgs.length - 4);
  for (let i = startIdx; i < msgs.length; i++) {
    textSource.push(msgs[i].content || '');
    textSource.push(msgs[i].aiContent || '');
  }
  const combinedText = textSource.join('\n');
  const matchesKatakana = combinedText.match(/[\u30A0-\u30FF\u30FC・]{2,24}/g) || [];
  const matchesKanji = combinedText.match(/[\u4E00-\u9FAF]{2,10}/g) || [];
  const matchesMixedJapanese = combinedText.match(/[\u4E00-\u9FAF々][\u3040-\u309F]{1,3}/g) || [];
  const matchesEnglish = combinedText.match(/[A-Z][a-zA-Z]{2,15}/g) || [];

  [...matchesKatakana, ...matchesKanji, ...matchesMixedJapanese, ...matchesEnglish].forEach(word => {
    const w = word.trim();
    if (isLoreKeywordCandidate(w, story)) {
      wordsSet.add(w);
    }
  });

  return Array.from(wordsSet)
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
}
