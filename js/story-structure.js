export const DEFAULT_SESSION_SUMMARY_PROMPT = `あなたはプロの編集者です。以下の会話履歴を、第三者の視点から見た物語の「あらすじ」として要約してください。
「承知しました」等のAIとしての応答は不要です。要約文のみ出力して下さい。

【最重要ルール】
- プロットの維持: 物語の重要な転換点、登場人物の重要な決断、新しい事実の判明、伏線となりうる発言は、絶対に省略しないでください。
- 客観的な記述: 「主人公は〜した。」「〇〇は〜と感じた。」のように、キャラクターの行動と感情を客観的に記述してください。
- 情報の取捨選択: 日常的な挨拶や、物語の進行に直接関係のない会話は省略してください。
- 時系列の維持: 出来事が起こった順番を正確に保ってください。
- 継続性の維持: 誰が誰とどう出会ったか、なぜ同行しているのか、今後どこへ向かうのかが失われないようにしてください。
- 未回収要素の保持: 約束、保留案件、未解決の懸案、今後回収すべき話題があれば明示してください。

最終的な出力は、このあらすじを初めて読む人でも、これまでの物語の流れを正確に理解できるような形式にしてください。`;

export function normalizeSessionLoreEvent(event) {
  if (typeof event === 'string') return event.trim();
  if (typeof event === 'number' || typeof event === 'boolean') return String(event);
  if (!event || typeof event !== 'object') return '';

  const candidates = [
    event.text,
    event.summary,
    event.description,
    event.event,
    event.title,
    event.label,
    event.name,
    event.value,
    event.note
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

export function normalizeSessionLoreList(items = [], limit = null) {
  const normalized = Array.from(new Set((Array.isArray(items) ? items : [])
    .map(normalizeSessionLoreEvent)
    .filter(Boolean)));
  return limit !== null && Number.isFinite(Number(limit))
    ? normalized.slice(0, Number(limit))
    : normalized;
}

export function mergeSessionLoreEvents(existingEvents = [], nextEvents = []) {
  return normalizeSessionLoreList([...existingEvents, ...nextEvents]);
}

export function createEmptySessionLore() {
  return {
    summary: '',
    summary_segments: [],
    summary_source: '',
    summary_checkpoint_turn: 0,
    last_summary_at: 0,
    last_summary_status: '',
    last_summary_error: '',
    last_summary_mode: '',
    long_term_events: [],
    active_flags: [],
    open_threads: [],
    key_events: []
  };
}

export function normalizeStoryPlanList(items = [], limit = 8) {
  const source = Array.isArray(items)
    ? items
    : String(items || '').split(/\r?\n|,/);
  return Array.from(new Set(source
    .map(item => String(item || '').trim())
    .filter(Boolean))).slice(0, limit);
}

export function createEmptyStoryPlan() {
  return {
    short_term: [],
    mid_term: [],
    long_term: [],
    research_needs: [],
    updatedAt: 0
  };
}

export function ensureStoryPlanStructure(story) {
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

export function createSessionSummarySegment({
  type = 'segment',
  startTurn = 1,
  endTurn = 1,
  summary = '',
  source = '',
  createdAt = Date.now(),
  updatedAt = Date.now()
} = {}) {
  const text = String(summary || '').trim();
  if (!text) return null;
  const parsedStartTurn = Number(startTurn);
  const fromTurn = Number.isFinite(parsedStartTurn)
    ? Math.max(1, Math.floor(parsedStartTurn))
    : 1;
  const parsedEndTurn = Number(endTurn);
  const toTurn = Number.isFinite(parsedEndTurn)
    ? Math.max(fromTurn, Math.floor(parsedEndTurn))
    : fromTurn;
  const parsedCreatedAt = Number(createdAt);
  const parsedUpdatedAt = Number(updatedAt);
  return {
    type: type === 'chapter' ? 'chapter' : 'segment',
    startTurn: fromTurn,
    endTurn: toTurn,
    summary: text,
    source: String(source || '').trim(),
    createdAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now(),
    updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : Date.now()
  };
}

export function parseSessionSummarySegmentsFromText(summaryText = '', checkpointTurn = 0, source = '') {
  const raw = String(summaryText || '').trim();
  if (!raw) return [];

  const segments = [];
  const regex = /【第(\d+)(?:〜(\d+))?ターン(章)?要約】\r?\n([\s\S]*?)(?=\r?\n\r?\n【第\d+(?:〜\d+)?ターン(?:章)?要約】|$)/g;
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

  const normalizedSource = String(source || '').trim();
  const parsedCheckpointTurn = Number(checkpointTurn);
  const shouldMigrateLegacySummary = Number.isFinite(parsedCheckpointTurn) && parsedCheckpointTurn > 0
    || ['manual', 'ai', 'ai-summary', 'ai-chapter-summary'].includes(normalizedSource);
  if (!shouldMigrateLegacySummary) return [];

  const fallbackEndTurn = Number.isFinite(parsedCheckpointTurn)
    ? Math.max(1, Math.floor(parsedCheckpointTurn))
    : 1;
  const fallbackType = normalizedSource === 'manual' ? 'segment' : 'chapter';
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

export function normalizeSessionSummarySegments(sessionLore = {}) {
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

export function renderSessionSummarySegments(segments = []) {
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

export function ensureSessionLoreStructure(story, options = {}) {
  if (!story) return createEmptySessionLore();
  const sessionLore = story.session_lore && typeof story.session_lore === 'object'
    ? story.session_lore
    : {};
  const {
    current_state: _retiredCurrentState,
    recent_turning_points: _retiredTurningPoints,
    ...activeSessionLore
  } = sessionLore;
  const listLimits = options.normalizeLists === true;
  const originalSummary = String(sessionLore.summary || '').trim();
  const summarySegments = normalizeSessionSummarySegments(sessionLore);
  const longTermEvents = normalizeSessionLoreList(
    sessionLore.long_term_events || sessionLore.key_events || [],
    listLimits ? 20 : null
  );
  const activeFlags = normalizeSessionLoreList(
    sessionLore.active_flags || sessionLore.open_threads || [],
    listLimits ? 10 : null
  );

  story.session_lore = {
    ...createEmptySessionLore(),
    ...activeSessionLore,
    summary: originalSummary,
    summary_checkpoint_turn: Number.isFinite(Number(sessionLore.summary_checkpoint_turn))
      ? Number(sessionLore.summary_checkpoint_turn)
      : 0,
    last_summary_at: Number.isFinite(Number(sessionLore.last_summary_at))
      ? Number(sessionLore.last_summary_at)
      : 0,
    last_summary_status: String(sessionLore.last_summary_status || '').trim(),
    last_summary_error: String(sessionLore.last_summary_error || '').trim(),
    last_summary_mode: String(sessionLore.last_summary_mode || '').trim(),
    summary_segments: summarySegments,
    long_term_events: longTermEvents,
    active_flags: activeFlags,
    open_threads: [...activeFlags],
    key_events: [...longTermEvents]
  };
  if (story.session_lore.summary_segments.length > 0) {
    story.session_lore.summary = renderSessionSummarySegments(story.session_lore.summary_segments);
  }
  return story.session_lore;
}
