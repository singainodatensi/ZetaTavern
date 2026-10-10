const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}

async function main() {
  const ai = read('js/ai-client.js');
  let plannerMode = 'http';
  let providerMode = 'http';
  let providerCalls = 0;
  let searchModel = 'search-model';
  const requests = [];
  const requestUrls = [];
  const userText = '「ああ、行こう」';
  const pending = signal => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    getState: () => ({ apiKey: 'dummy', webSearchProvider: 'google' }),
    normalizeWebSearchProvider: value => value,
    normalizeLoreEntryName: value => String(value || '').trim(),
    shouldUseExternalProviderPlanning: () => false,
    resolveSearchModelName: () => searchModel,
    buildSearchPlanningPrompt: () => userText,
    accumulatePromptDebug() {}, addUsageMetadata() {}, recordToolCall() {},
    findSearchMemoryMatch: () => null,
    searchCharacterLibraryForStory: async () => ({}),
    searchLorebookForStory: async () => ({}),
    isStrongCharacterHit: () => false, isStrongLoreHit: () => false,
    getWebSearchCooldownRemainingMs: () => 0,
    normalizeSearchWebQuery: query => query === userText
      ? { query: '', reason: 'dialogue_query' }
      : { query: query.replace(/\s+/g, ' ').trim() },
    fetch: async (url, options) => {
      requestUrls.push(url);
      requests.push(JSON.parse(options.body));
      if (plannerMode === 'network') throw new TypeError('Failed to fetch');
      if (plannerMode === 'pending') return pending(options.signal);
      if (plannerMode === 'http') return { ok: false, status: 503, json: async () => ({ error: { message: 'Internal error encountered.' } }) };
      if (plannerMode === 'body') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON response'); } };
      if (plannerMode === 'budget') {
        const complete = requests.at(-1).generationConfig.maxOutputTokens >= 487 + 800;
        const text = complete ? JSON.stringify({ needsSearch: true, query: 'オットー リゼロ' }) : '```json { "needsSearch": true, "topicKey": "ルグ';
        return { ok: true, status: 200, json: async () => ({
          candidates: [{ finishReason: complete ? 'STOP' : 'MAX_TOKENS', content: { parts: [{ text }] } }],
          usageMetadata: { thoughtsTokenCount: 487 }
        }) };
      }
      const fixtures = {
        truncated: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"needsSearch": true, "query": "' }] } }], usageMetadata: { thoughtsTokenCount: 490 } },
        thoughts: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'private thought', thought: true }] } }], usageMetadata: { thoughtsTokenCount: 512 } },
        empty: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] },
        blocked: { promptFeedback: { blockReason: 'SAFETY' } },
        fields: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"needsSearch":"true"}' }] } }] },
        query: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"needsSearch":true,"query":123}' }] } }] },
        array: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[]' }] } }] },
        fenced: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n{"needsSearch":false}\n```' }] } }] },
        long: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<img src=x onerror=alert(1)>'.repeat(30) }] } }] }
      };
      if (fixtures[plannerMode]) return { ok: true, status: 200, json: async () => fixtures[plannerMode] };
      const text = plannerMode === 'invalid' ? 'not JSON' : JSON.stringify({ needsSearch: plannerMode === 'search', query: 'オットー リゼロ' });
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
    },
    runGoogleSearchLookup: async ({ query, signal }) => {
      providerCalls++;
      assert.equal(query, 'オットー リゼロ');
      if (providerMode === 'network') throw new TypeError('Provider disconnected');
      if (providerMode === 'pending') return pending(signal);
      return { found: false, provider: 'google', status: 503, modelName: 'search-model', message: 'Internal error encountered.' };
    },
    formatUsageNumber: value => String(value)
  });
  for (const [start, end] of [
    ['function parseJsonObjectFromModelText(', 'function ensureSearchMemory('],
    ['function summarizeCandidatePartKinds(', 'function recordGroundingMetadata('],
    ['function updateUsageStage(', 'function addUsageMetadata('],
    ['function recordSearchError(', 'function classifySearchFailure('],
    ['function getThinkingSupportForModel(', 'function buildStructuredSearchMemoPrompt('],
    ['function buildSearchPlanningGenerationConfig(', 'async function planProactiveStorySearch('],
    ['async function planProactiveStorySearch(', 'function isNoisyTavilyResult('],
    ['async function searchWebForStory(', 'function isQuotaLikeApiError(']
  ]) vm.runInContext(section(ai, start, end), context);
  vm.runInContext(section(read('js/ui.js'), 'function formatSearchProviderLabel(', 'export function renderApiUsagePanel('), context);
  const run = (usage, signal = new AbortController().signal, timeout = 100) => context.runProactiveStoryResearch(
    { franchise: 'リゼロ' }, [{ role: 'user', content: userText }], usage, signal, timeout
  );

  const planning = {};
  await run(planning);
  const planningError = planning.searchErrors[0];
  assert.equal(planningError.stage, 'planning');
  assert.equal(planningError.query, '');
  assert.equal(planningError.status, 503);
  assert.equal(planningError.modelName, 'search-model');
  assert.equal(providerCalls, 0);
  assert.equal(requests[0].tools, undefined);
  const displayed = context.formatSearchError(planningError);
  assert.match(displayed, /検索計画の生成失敗.*検索語: 未生成.*外部検索未実行.*search-model.*HTTP 503/);
  assert.equal(displayed.includes(userText), false);
  console.log('PASS: planner HTTP failure displays no user dialogue or fictitious search query');

  for (const mode of ['network', 'pending', 'invalid']) {
    plannerMode = mode;
    const usage = {};
    await run(usage, new AbortController().signal, 10);
    assert.equal(usage.searchErrors.length, 1);
    assert.equal(usage.searchErrors[0].stage, 'planning');
    assert.equal(usage.searchErrors[0].query, '');
    assert.equal(usage.searchErrors[0].modelName, 'search-model');
    if (mode === 'pending') assert.equal(usage.searchErrors[0].code, 'research_timeout');
  }
  plannerMode = 'skip';
  const skipped = {};
  await run(skipped);
  assert.equal(skipped.stageStatus.planning.phase, 'skipped');
  assert.equal(skipped.searchErrors, undefined);
  console.log('PASS: planner network, timeout and malformed response retain the stage; no-search is not an error');

  const diagnostics = {};
  for (const [mode, issue] of [
    ['truncated', 'invalid_json'], ['thoughts', 'empty_text'], ['empty', 'empty_text'],
    ['blocked', 'blocked'], ['fields', 'invalid_fields'], ['query', 'invalid_fields'],
    ['array', 'invalid_object'], ['body', 'invalid_response_body'], ['long', 'invalid_json']
  ]) {
    plannerMode = mode;
    const usage = {};
    await run(usage);
    assert.equal(usage.searchErrors[0].failureKind, issue, mode);
    assert.equal(usage.searchErrors[0].query, '');
    assert.equal(usage.searchErrors[0].status, 200);
    assert.equal(usage.stageStatus.planning.outputTokenLimit, 4096);
    assert.equal(usage.stageStatus.planning.validationIssue, issue);
    diagnostics[mode] = usage.stageStatus.planning;
  }
  assert.equal(providerCalls, 0);
  assert.equal(diagnostics.truncated.finishReason, 'MAX_TOKENS');
  assert.match(diagnostics.truncated.message, /出力上限/);
  assert.equal(diagnostics.thoughts.extractedTextLength, 0);
  assert.equal(diagnostics.thoughts.thoughtsTokenCount, 512);
  assert.equal(diagnostics.thoughts.responsePreview, '');
  assert.deepEqual(Array.from(diagnostics.thoughts.partKinds), ['thought_text']);
  assert.equal(diagnostics.blocked.blockReason, 'SAFETY');
  assert.equal(diagnostics.blocked.candidateCount, 0);
  assert.match(diagnostics.query.message, /query/);
  assert.equal(diagnostics.long.responsePreview.length, 400);
  plannerMode = 'fenced';
  const fenced = {};
  await run(fenced);
  assert.equal(fenced.stageStatus.planning.phase, 'skipped');
  assert.equal(fenced.searchErrors, undefined);
  console.log('PASS: HTTP 200 diagnoses truncation, empty/thought-only output, blocking, invalid JSON/fields; fenced JSON parses');

  for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']) {
    const config = context.buildSearchPlanningGenerationConfig(model);
    assert.equal(config.maxOutputTokens, 4096);
    assert.equal(config.thinkingConfig.thinkingBudget, 1024);
    assert.equal(config.thinkingConfig.thinkingLevel, undefined);
  }
  for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-pro']) {
    assert.equal(context.buildSearchPlanningGenerationConfig(model).thinkingConfig.thinkingLevel, 'low');
  }
  for (const model of ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-2.0-flash', 'custom-model']) {
    assert.equal(context.buildSearchPlanningGenerationConfig(model).thinkingConfig, undefined);
  }
  searchModel = 'gemini-2.5-flash';
  plannerMode = 'budget';
  const budgetUsage = {};
  const plan = await context.planProactiveStorySearch({ franchise: 'リゼロ' }, [{ role: 'user', content: userText }], budgetUsage);
  assert.equal(plan.query, 'オットー リゼロ');
  assert.equal(budgetUsage.searchErrors, undefined);
  assert.equal(budgetUsage.stageStatus.planning.finishReason, 'STOP');
  assert.equal(budgetUsage.stageStatus.planning.thoughtsTokenCount, 487);
  assert.equal(budgetUsage.stageStatus.planning.thinkingConfigLabel, 'Budget: 1024');
  assert.equal(requests.at(-1).generationConfig.thinkingConfig.thinkingBudget, 1024);
  assert.match(requestUrls.at(-1), /models\/gemini-2\.5-flash:generateContent/);
  assert.equal(providerCalls, 0);
  searchModel = 'search-model';
  console.log('PASS: planner has room for thinking and complete JSON, applies model-specific limits without switching models');

  const rejected = {};
  await context.searchWebForStory({ franchise: 'リゼロ' }, { query: userText }, rejected);
  assert.equal(rejected.searchErrors[0].stage, 'query_validation');
  assert.equal(rejected.searchErrors[0].query, '');
  assert.equal(rejected.searchErrors[0].rawQuery, userText);
  assert.match(context.formatSearchError(rejected.searchErrors[0]), /検索語の却下.*候補:.*外部検索未実行/);
  assert.equal(providerCalls, 0);

  const external = {};
  await context.searchWebForStory({}, { query: 'オットー  リゼロ' }, external);
  assert.equal(external.searchErrors[0].stage, 'provider_lookup');
  assert.equal(external.searchErrors[0].query, 'オットー リゼロ');
  assert.equal(external.searchErrors[0].rawQuery, 'オットー  リゼロ');
  assert.match(context.formatSearchError(external.searchErrors[0]), /外部検索の失敗.*Google.*検索語: オットー リゼロ.*HTTP 503/);
  console.log('PASS: rejected candidates differ from submitted provider queries');

  plannerMode = 'search';
  for (const mode of ['network', 'pending']) {
    providerMode = mode;
    const usage = {};
    await run(usage, new AbortController().signal, 10);
    assert.equal(usage.searchErrors.length, 1);
    assert.equal(usage.searchErrors[0].count, 1);
    assert.equal(usage.searchErrors[0].stage, 'provider_lookup');
    assert.equal(usage.searchErrors[0].query, 'オットー リゼロ');
  }
  const cancelled = {};
  const controller = new AbortController();
  const task = run(cancelled, controller.signal);
  controller.abort();
  await assert.rejects(task, /中止/);
  assert.equal(cancelled.searchErrors, undefined);
  console.log('PASS: provider network and timeout errors are recorded once; user cancellation is excluded');

  const mixed = {};
  context.recordSearchError(mixed, planningError);
  context.recordSearchError(mixed, { ...planningError, stage: 'provider_lookup' });
  context.recordSearchError(mixed, { ...planningError, modelName: 'another-model' });
  assert.equal(mixed.searchErrors.length, 3);
  context.recordSearchError(mixed, planningError);
  assert.equal(mixed.searchErrors[0].count, 2);
  context.recordSearchError(mixed, { stage: 'provider_lookup', query: 'q'.repeat(120), message: 'failure' });
  assert.equal(mixed.searchErrors.at(-1).query.length, 120);
  console.log('PASS: error grouping preserves stage/model distinctions and full submitted queries');

  if (process.env.ZT_TEST_URL) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, serviceWorkers: 'block' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(process.env.ZT_TEST_URL);
        await page.locator('#new-story-btn').click();
        await page.locator('#story-title-prompt-input').fill('検索ログ確認');
        await page.locator('#story-title-prompt-ok').click();
        await page.waitForFunction(async () => Boolean((await import('/js/state.js')).getState().currentStory?.storyId));
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(async ({ planningError, rejectedError, externalError, diagnosticStage }) => {
          const { updateState } = await import('/js/state.js');
          const ui = await import(`/js/ui.js?v=${window.__ZT_BUILD_VERSION__}`);
          updateState({ promptDebugEnabled: true, lastApiUsage: {
            modelName: 'chat-model', requestType: 'story', timestamp: Date.now(),
            debug: {
              breakdown: [{ label: 'System', chars: 100, estimatedPromptTokens: 50 }],
              searchErrors: [planningError, rejectedError, externalError],
              groundingQueries: [], stageStatus: { planning: diagnosticStage }
            }
          } });
          ui.renderApiUsagePanel();
          document.querySelector('#api-usage-panel details').open = true;
        }, { planningError, rejectedError: rejected.searchErrors[0], externalError: external.searchErrors[0], diagnosticStage: diagnostics.long });
        const chips = page.locator('#api-usage-panel .api-usage-error');
        assert.equal(await chips.count(), 4);
        assert.match(await chips.nth(0).innerText(), /返答冒頭.*<img/);
        assert.equal(await chips.nth(0).locator('img').count(), 0);
        assert.match(await page.locator('#api-usage-panel').innerText(), /Thinking 0.*出力上限 4,096/);
        assert.match(await chips.nth(1).innerText(), /検索計画の生成失敗.*未生成.*外部検索未実行/);
        assert.equal((await chips.nth(1).innerText()).includes(userText), false);
        assert.match(await chips.nth(2).innerText(), /検索語の却下.*候補:/);
        assert.match(await chips.nth(3).innerText(), /外部検索の失敗.*検索語: オットー リゼロ/);
        assert.equal(await chips.evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)), true);
        assert.deepEqual(errors, []);
        await page.close();
      }
      console.log('PASS: real desktop/mobile UI distinguishes stages and wraps error messages');
    } finally {
      await browser.close();
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
