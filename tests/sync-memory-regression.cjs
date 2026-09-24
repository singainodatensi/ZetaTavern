const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing test section: ${start}`);
  return source.slice(first, last);
}

async function main() {
  const ai = read('js/ai-client.js');
  const history = vm.createContext({});
  vm.runInContext(section(ai, 'function chunkMessagesByUserTurn(', 'export function countUserTurnChunks') +
    section(ai, 'function selectPromptMessages(', 'function normalizeSearchText'), history);
  const messages = Array.from({ length: 31 }, (_, i) => ({ role: 'user', content: String(i) }));
  assert.equal(history.selectPromptMessages(messages, 10).omittedTurns, 0);
  assert.equal(history.selectPromptMessages(messages, 10, { summary: 'saved', summary_checkpoint_turn: 20, last_summary_status: 'error' }).omittedTurns, 20);
  assert.equal(history.selectPromptMessages(messages, 10, { summary: 'saved', summary_checkpoint_turn: 30 }).omittedTurns, 21);
  assert.equal(history.selectPromptMessages(messages, 0, { summary: 'saved', summary_checkpoint_turn: 30 }).omittedTurns, 0);
  assert.equal(history.selectPromptMessages(messages, 10, { summary: '', summary_checkpoint_turn: 30 }).omittedTurns, 0);
  console.log('PASS: uncompressed history survives failed/missing summaries');

  const drop = read('js/dropbox.js');
  const uploads = [];
  const delta = vm.createContext({
    crypto: webcrypto, TextEncoder, MESSAGE_CHUNK_SIZE: 100,
    ensuredFolderPaths: new Set(),
    splitStoryForSync: story => ({ meta: {}, chunks: [story.messages.slice(0, 100), story.messages.slice(100)] }),
    uploadJson: async file => uploads.push(file)
  });
  vm.runInContext(section(drop, 'async function hashMessageChunks(', 'async function uploadV2Story(') +
    section(drop, 'async function uploadV2StoryAppendDelta(', 'function hasRemoteEntryChanged'), delta);
  const original = Array.from({ length: 150 }, (_, i) => ({ content: String(i) }));
  const previous = { messageCount: 150, dirPath: '/stories/id__title', messageChunkHashes: await delta.hashMessageChunks([original.slice(0, 100), original.slice(100)]) };
  const edited = structuredClone(original);
  edited[0].content = 'edited';
  await delta.uploadV2StoryAppendDelta({ messages: edited }, previous);
  assert.deepEqual(uploads, ['/stories/id__title/meta.json', '/stories/id__title/messages_0001.json']);
  uploads.length = 0;
  await delta.uploadV2StoryAppendDelta({ messages: original }, previous);
  assert.deepEqual(uploads, ['/stories/id__title/meta.json']);
  uploads.length = 0;
  await delta.uploadV2StoryAppendDelta({ messages: original }, { ...previous, messageChunkHashes: undefined });
  assert.equal(uploads.length, 3);
  console.log('PASS: old edits upload their chunk; unchanged history is skipped; legacy manifests migrate');

  const app = read('js/app.js');
  let pending = { lore: { scope: 'lores', id: 'series', revision: '1' }, story: { scope: 'stories', id: 'A', revision: '2' } };
  let failLore = false;
  const sent = [];
  const settings = { dropbox_sync_frequency: 2, dropbox_sync_counter: 0 };
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    db: {
      getPendingDropboxChanges: async () => structuredClone(pending),
      acknowledgeDropboxChanges: async snapshot => {
        for (const [key, entry] of Object.entries(snapshot)) if (pending[key]?.revision === entry.revision) delete pending[key];
      },
      getSetting: async (key, fallback) => settings[key] ?? fallback,
      saveSetting: async (key, value) => { settings[key] = value; }
    },
    dropbox: { isConnected: async () => true, getLastRemoteManifestUpdatedAt: async () => 1 },
    runExclusiveDropboxSync: async (_, task) => task(),
    updateSyncStatusIndicator() {}, updateLastSyncText() {}, saveDropboxManifestSnapshot: async () => {},
    performDropboxSelectiveAutoSync: async request => {
      if (request.syncLores && failLore) throw new Error('network failed');
      sent.push(request);
      return { updatedAt: 1 };
    },
    performDropboxPushSilent: async () => { throw new Error('Unexpected full push'); }
  });
  vm.runInContext(section(app, 'async function performAutoDropboxSync(', 'async function performDropboxPushSilent('), context);
  await context.performAutoDropboxSync();
  assert.equal(Object.keys(pending).length, 2);
  await context.performAutoDropboxSync();
  assert.equal(sent.length, 2);
  assert.equal(Object.keys(pending).length, 0);
  pending = { s1: { scope: 'stories', id: 'A', revision: '3' }, s2: { scope: 'stories', id: 'B', revision: '4' }, l: { scope: 'lores', id: 'series', revision: '5' } };
  failLore = true;
  await assert.rejects(context.flushPendingDropboxChanges(), /network failed/);
  assert.deepEqual(Object.keys(pending), ['l']);
  failLore = false;
  await context.flushPendingDropboxChanges();
  assert.equal(Object.keys(pending).length, 0);
  console.log('PASS: frequency batching, multiple stories, partial failure and retry');

  vm.runInContext(section(app, 'async function hasNewerLocalChanges(', 'function setupVisibilitySync('), context);
  pending = { l: { scope: 'lores', id: 'startup-series', revision: '6' } };
  await context.performStartupSync();
  assert.equal(Object.keys(pending).length, 0);
  assert.equal(sent.at(-1).loreFranchises[0], 'startup-series');
  console.log('PASS: startup flushes pending lore without substituting the active story');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:18765/**', route => {
      const isDb = new URL(route.request().url()).pathname === '/db.js';
      return route.fulfill({ contentType: isDb ? 'text/javascript' : 'text/html', body: isDb ? read('js/db.js') : '<!doctype html><title>Isolated regression test</title>' });
    });
    await page.goto('http://127.0.0.1:18765/');
    const result = await page.evaluate(async () => {
      const db = await import('/db.js');
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      await Promise.all([
        db.saveStory({ storyId: 'A', messages: [] }),
        db.saveStory({ storyId: 'B', messages: [] }),
        db.saveLore({ id: 'L', franchise: 'old', name: 'test' }),
        db.saveCharacter({ characterId: 'C', name: 'test' })
      ]);
      const snapshot = await db.getPendingDropboxChanges();
      check(Object.keys(snapshot).length === 4, 'Concurrent writes lost scopes');
      await db.saveStory({ storyId: 'A', messages: [{ content: 'new' }] });
      await db.acknowledgeDropboxChanges(snapshot);
      let pending = Object.values(await db.getPendingDropboxChanges());
      check(pending.length === 1 && pending[0].id === 'A', 'New edit acknowledged by old sync');
      await db.saveLore({ id: 'L', franchise: 'new', name: 'test' });
      pending = Object.values(await db.getPendingDropboxChanges());
      check(pending.some(e => e.id === 'old') && pending.some(e => e.id === 'new'), 'Lore move lost old scope');
      await db.acknowledgeDropboxChanges(await db.getPendingDropboxChanges());
      await db.runWithoutLocalChangeTracking(async () => {
        await db.saveLore({ id: 'remote', franchise: 'remote' });
        await db.saveStoryFromSync({ storyId: 'remote', messages: [] });
      });
      check(Object.keys(await db.getPendingDropboxChanges()).length === 0, 'Pull marked dirty');
      await db.deleteCharacter('C');
      await db.deleteLore('L');
      return Object.values(await db.getPendingDropboxChanges());
    });
    assert(result.some(e => e.scope === 'characters' && e.id === 'C'));
    assert(result.some(e => e.scope === 'lores' && e.id === 'new'));
    await page.reload();
    const afterReload = await page.evaluate(async () => Object.values(await (await import('/db.js')).getPendingDropboxChanges()));
    assert.deepEqual(afterReload, result);
    console.log('PASS: real IndexedDB concurrent writes, revision acknowledgement, move/delete, pull exclusion, reload persistence');
    if (process.env.ZT_TEST_URL) {
      const smoke = await browser.newPage();
      const errors = [];
      smoke.on('pageerror', error => errors.push(error.message));
      await smoke.goto(process.env.ZT_TEST_URL);
      await smoke.locator('#new-story-btn').waitFor();
      await smoke.locator('#new-story-btn').click();
      await smoke.locator('#story-title-prompt-input').waitFor({ timeout: 5000 });
      await smoke.locator('#story-title-prompt-input').fill('作品情報UIテスト');
      await smoke.locator('#story-title-prompt-ok').click();
      await smoke.getByText('現在のストーリーを設定', { exact: false }).waitFor({ timeout: 5000 });
      await smoke.getByText('現在のストーリーを設定', { exact: false }).click();
      const metadataGroup = smoke.locator('#story-settings-modal [data-story-settings-scroll-body="true"] > .story-metadata-group');
      await metadataGroup.waitFor({ timeout: 5000 });
      assert.equal(await metadataGroup.locator('#story-franchise-modal-input').count(), 1);
      assert.equal(await metadataGroup.locator('#story-franchise-context-modal-input').count(), 1);
      assert.equal(await metadataGroup.locator('#story-tags-input').count(), 1);
      await smoke.locator('#story-franchise-modal-input').fill('作品タグ');
      await smoke.locator('#story-franchise-context-modal-input').fill('作品の正式名称');
      await smoke.locator('#story-tags-input').fill('作品タグ, テスト');
      await smoke.locator('#story-settings-save-btn').click();
      await smoke.locator('.sidebar-tab-btn[data-tab="config"]').click();
      assert.equal(await smoke.locator('#story-franchise-input').inputValue(), '作品タグ');
      assert.equal(await smoke.locator('#story-franchise-context-input').inputValue(), '作品の正式名称');
      assert.equal(await smoke.locator('#story-tags-sidebar-input').inputValue(), '作品タグ, テスト');
      await smoke.locator('#web-search-toggle-checkbox').evaluate(input => {
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await smoke.waitForFunction(async () => (await (await import('/js/db.js')).getSetting('web_search_enabled')) === false);
      await smoke.reload();
      await smoke.waitForFunction(() => document.getElementById('web-search-toggle-checkbox')?.checked === false);
      assert.deepEqual(errors, []);
      console.log('PASS: application boots, story metadata stays grouped, Web search toggle persists');
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
