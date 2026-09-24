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
  for (const retiredName of [
    'shouldUseServerSideGoogleSearchForStory',
    'fetchGoogleSearchGroundingMemo',
    'includeServerSideToolInvocations',
    'shouldOfferGoogleSearchForTurn',
    'googleSearchAllowedForRequest'
  ]) {
    assert.equal(ai.includes(retiredName), false, `Retired combined-search path remains: ${retiredName}`);
  }
  assert(ai.includes("name: 'search_web'"));
  assert(ai.includes('runGoogleSearchLookup'));
  assert(ai.includes('runTavilyLookup'));
  assert(ai.includes("functionCallingConfig: { mode: 'AUTO' }"));
  assert(ai.includes("(webSearchEnabled || fn.name !== 'search_web')"));
  console.log('PASS: retired combined Google Search path removed; search_web providers remain');

  const searchQueries = vm.createContext({
    normalizeLoreEntryName: value => String(value || '').trim(),
    uniqueNonEmpty: values => [...new Set(values.filter(Boolean))],
    collectStoryScopedSearchAnchors: (_, text) => text.includes('エミリア') ? ['エミリア'] : [],
    PROACTIVE_REFERENCE_STOPWORDS: new Set(),
    KNOWN_WORLD_SEARCH_TERMS: new Set(['白鯨'])
  });
  vm.runInContext(section(ai, 'function extractReferenceCandidatesFromText(', 'function collectStoryScopedSearchAnchors('), searchQueries);
  const normalizeQuery = (query, franchise = 'リゼロ') => searchQueries.normalizeSearchWebQuery(query, { franchise }, franchise);
  assert.equal(normalizeQuery('「なんだか知らないけど、捕まってたのかアンタ。ちょっと待ってろ、縄を切るから」').rejected, true);
  assert.equal(normalizeQuery('「助けて」').reason, 'dialogue_query');
  assert.equal(normalizeQuery('なんだか知らないけど、捕まってたのかアンタ。').reason, 'dialogue_query');
  assert.equal(normalizeQuery('「エミリアが捕まった。助けよう」').query, 'エミリア リゼロ');
  assert.equal(normalizeQuery('白鯨 リゼロ').query, '白鯨 リゼロ');
  assert.equal(normalizeQuery('「星くず☆うぃっちメルル」').query, '星くず☆うぃっちメルル');
  assert.equal(normalizeQuery('「ドキドキ！プリキュア」').query, 'ドキドキ！プリキュア');
  let providerCalls = 0;
  let webSearchEnabled = true;
  const blockedSearch = vm.createContext({
    ...searchQueries,
    getState: () => ({ apiKey: 'test-key', webSearchProvider: 'google', webSearchEnabled }),
    normalizeWebSearchProvider: value => value,
    getApiKeyFromStorage: async () => 'test-key',
    runGoogleSearchLookup: async () => { providerCalls++; return { found: true }; }
  });
  vm.runInContext(section(ai, 'async function searchWebForStory(', 'function isQuotaLikeApiError('), blockedSearch);
  const blockedResult = await blockedSearch.searchWebForStory({ franchise: 'リゼロ' }, {
    query: '「なんだか知らないけど、捕まってたのかアンタ。ちょっと待ってろ、縄を切るから」'
  });
  assert.equal(blockedResult.rejected, true);
  assert.equal(providerCalls, 0);
  webSearchEnabled = false;
  const disabledResult = await blockedSearch.searchWebForStory({ franchise: 'リゼロ' }, { query: '白鯨 リゼロ' });
  assert.equal(disabledResult.found, false);
  assert.match(disabledResult.message, /OFF/);
  assert.equal(providerCalls, 0);
  webSearchEnabled = true;
  console.log('PASS: dialogue is withheld from Web search while named topics remain searchable');

  const memory = vm.createContext({});
  vm.runInContext(read('js/story-structure.js').replaceAll('export ', ''), memory);
  vm.runInContext(section(ai, 'async function applySessionLoreUpdate(', 'async function applyStoryPlanUpdate('), memory);
  const story = { session_lore: { long_term_events: Array.from({ length: 80 }, (_, i) => `event ${i}`) } };
  memory.ensureSessionLoreStructure(story, { normalizeLists: true });
  await memory.applySessionLoreUpdate({ long_term_events: ['event 80', 'event 0'] }, story);
  assert.equal(story.session_lore.long_term_events.length, 81);
  assert.equal(story.session_lore.long_term_events[0], 'event 0');
  assert.equal(story.session_lore.long_term_events.at(-1), 'event 80');
  assert.deepEqual(story.session_lore.key_events, story.session_lore.long_term_events);
  console.log('PASS: long-term events survive normalization and updates beyond 20 entries');

  const errors = [];
  let mode = 'network';
  let seenSignal;
  const research = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    getState: () => ({ apiKey: 'test', webSearchProvider: 'google', webSearchEnabled }),
    normalizeWebSearchProvider: value => value,
    shouldUseExternalProviderPlanning: () => false,
    resolveSearchModelName: () => 'test-model',
    buildSearchPlanningPrompt: () => 'test prompt',
    accumulatePromptDebug() {}, addUsageMetadata() {},
    parseJsonObjectFromModelText: JSON.parse,
    normalizeLoreEntryName: value => value,
    findSearchMemoryMatch: () => null,
    searchCharacterLibraryForStory: async () => ({}),
    searchLorebookForStory: async () => ({}),
    isStrongCharacterHit: () => false, isStrongLoreHit: () => false,
    recordToolCall() {},
    searchWebForStory: async (_, args, usage, state, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    recordSearchError: (_, error) => errors.push(error),
    fetch: async (_, options) => {
      seenSignal = options.signal;
      if (mode === 'network') throw new TypeError('Network disconnected');
      if (mode === 'http') return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
      if (mode === 'success') return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"needsSearch":false}' }] } }] }) };
      if (mode === 'provider') return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"needsSearch":true,"query":"character"}' }] } }] }) };
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
  });
  vm.runInContext(section(ai, 'async function planProactiveStorySearch(', 'function isNoisyTavilyResult('), research);
  const run = (signal, timeout = 100) => research.runProactiveStoryResearch(
    { franchise: 'test' }, [{ role: 'user', content: 'test' }], {}, signal, timeout
  );
  webSearchEnabled = false;
  assert.equal(await run(new AbortController().signal), null);
  assert.equal(errors.length, 0);
  webSearchEnabled = true;
  assert.equal(await run(new AbortController().signal), null);
  assert.equal(errors.at(-1).code, 'research_failed');
  mode = 'http';
  assert.equal(await run(new AbortController().signal), null);
  assert.equal(errors.at(-1).code, 'planner:429');
  mode = 'pending';
  assert.equal(await run(new AbortController().signal, 10), null);
  assert.equal(errors.at(-1).code, 'research_timeout');
  assert.equal(seenSignal.aborted, true);
  const parent = new AbortController();
  const task = run(parent.signal);
  parent.abort();
  await assert.rejects(task, /中止されました/);
  mode = 'success';
  const previousErrors = errors.length;
  assert.equal(await run(new AbortController().signal), null);
  assert.equal(errors.length, previousErrors);
  mode = 'provider';
  assert.equal(await run(new AbortController().signal, 10), null);
  assert.equal(errors.at(-1).code, 'research_timeout');
  console.log('PASS: planner network/HTTP/timeout fallback, user cancellation and normal response');

  const calls = [];
  const deletion = vm.createContext({
    console, db: { getStories: async () => [], getCharacters: async () => [] },
    collectDropboxSettings: async () => ({ dropbox_sync_tombstones: { characters: { deleted: 1 } } }),
    dropbox: { pushCharacterDeltaToDropbox: async args => { calls.push(args); return { updatedAt: 1 }; } }
  });
  vm.runInContext(section(read('js/app.js'), 'async function performDropboxSelectiveAutoSync(', 'function updateSyncStatusIndicator('), deletion);
  const result = await deletion.performDropboxSelectiveAutoSync({ syncCharacters: true, characterIds: ['deleted'] });
  assert.equal(result.updatedAt, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].characters.length, 0);
  assert.equal(calls[0].settings.dropbox_sync_tombstones.characters.deleted, 1);
  console.log('PASS: deleted character sends tombstones through delta sync without a full push');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
