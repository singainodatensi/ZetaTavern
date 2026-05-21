/**
 * app.js - ZetaTavern Application Entry Point
 * Handles application boot, DOM events wiring, messaging pipeline, and protagonist updates.
 */

import { getState, updateState, setActiveStory, subscribe } from './state.js';
import * as db from './db.js';
import * as ui from './ui.js';
import { generateStoryResponse } from './ai-client.js';
import * as dropbox from './dropbox.js';

// Default Storyteller instructions preset matching the Storyteller rules
const DEFAULT_STORYTELLER_PROMPT = `・語り口は三人称。会話と行動描写をメインに据えてテンポよく進める。
・「語るな、見せろ」：感情の直接説明を避け、行動・セリフ・仕草・視線で表現する。キャラクターの感情を「嬉しかった」「悲しかった」等と直接記述しない。
- 1回の出力の目安は1200～1800字。展開を急がず、感情が動く場面はゆっくりと詳細に描く。
- 【R-18要素ガイドライン】: 官能的かつ下世話な表現を用いつつ文学的な官能美を目指す。前戯、反応、結合、絶頂、事後の余韻までを五感を使って描写する。手順を飛ばしたり省略したりせず、段階的に複数回に分けて出力する。(※男と女、女と女の組み合わせのみ許可。男同士は禁止。)`;

// Default World settings template
const DEFAULT_WORLD_PROMPT = `【世界観】\n現代の高校を舞台にした日常系ラブコメの世界。\n\n【状況】\n主人公は平凡な男子高校生。ある日、隣の席に学校一の美少女が座ることになり……`;

let hasBooted = false;

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

  // Select the most recent story if available
  if (stories.length > 0) {
    stories.sort((a, b) => b.timestamp - a.timestamp);
    setActiveStory(stories[0]);
  } else {
    setActiveStory(null);
  }

  // Initialize UI displays
  ui.renderStoryList();
  ui.renderCharacterLibrary();
  ui.renderStory();
  ui.renderSidebar();

  // Bind all event handlers
  bindEvents();

  // Subscribe state changes to auto-render UI
  subscribe((event, state) => {
    if (event === 'storyChanged') {
      ui.renderStory();
      ui.renderSidebar();
      fillStorySettingsForm(state.currentStory);
    } else if (event === 'stateChanged') {
      // Toggle screens
      toggleScreenVisibility(state.activeScreen);
      
      // Update sidebar when loading status or mode changes
      const sendBtn = document.getElementById('send-btn');
      if (sendBtn) {
        sendBtn.disabled = state.isGenerating;
      }
    }
  });
  "adjustments": {
    "target_file": "js/app.js",
    "updated_code": "/**\n * app.js - ZetaTavern Application Entry Point\n * Handles application boot, DOM events wiring, messaging pipeline, and protagonist updates.\n */\n\nimport { getState, updateState, setActiveStory, subscribe } from './state.js';\nimport * as db from './db.js';\nimport * as ui from './ui.js';\nimport { generateStoryResponse } from './ai-client.js';\nimport * as dropbox from './dropbox.js';\n\n// Default Storyteller instructions preset matching the Storyteller rules\nconst DEFAULT_STORYTELLER_PROMPT = `・語り口は三人称。会話と行動描写をメインに据えてテンポよく進める。\n・「語るな、見せろ」：感情の直接説明を避け、行動・セリフ・仕草・視線で表現する。キャラクターの感情を「嬉しかった」「悲しかった」等と直接記述しない。\n- 1回の出力の目安は1200～1800字。展開を急がず、感情が動く場面はゆっくりと詳細に描く。\n- 【R-18要素ガイドライン】: 官能的かつ下世話な表現を用いつつ文学的な官能美を目指す。前戯、反応、結合、絶頂、事後の余韻までを五感を使って描写する。手順を飛ばしたり省略したりせず、段階的に複数回に分けて出力する。(※男と女、女と女の組み合わせのみ許可。男同士は禁止。)`;\n\n// Default World settings template\nconst DEFAULT_WORLD_PROMPT = `【世界観】\\n現代の高校を舞台にした日常系ラブコメの世界。\\n\\n【状況】\\n主人公は平凡な男子高校生。ある日、隣の席に学校一の美少女が座ることになり……`;\n\nlet hasBooted = false;\n\n// Boot strap execution\nasync function bootApp() {\n  if (hasBooted) return;\n  hasBooted = true;\n  console.log('ZetaTavern booting...');\n  \n  // Register Service Worker for PWA\n  if ('serviceWorker' in navigator) {\n    window.addEventListener('load', () => {\n      navigator.serviceWorker.register('./sw.js')\n        .then(reg => console.log('ServiceWorker registration successful:', reg.scope))\n        .catch(err => console.warn('ServiceWorker registration failed:', err));\n    });\n  }\n\n  // Load configuration from settings store\n  await loadConfigurations();\n\n  // Load lists from IndexedDB\n  const stories = await db.getStories();\n  const characters = await db.getCharacters();\n  updateState({ stories, characters });\n\n  // Select the most recent story if available\n  if (stories.length > 0) {\n    stories.sort((a, b) => b.timestamp - a.timestamp);\n    setActiveStory(stories[0]);\n  } else {\n    setActiveStory(null);\n  }\n\n  // Initialize UI displays\n  ui.renderStoryList();\n  ui.renderCharacterLibrary();\n  ui.renderStory();\n  ui.renderSidebar();\n\n  // Bind all event handlers\n  bindEvents();\n\n  // Subscribe state changes to auto-render UI\n  subscribe((event, state) => {\n    if (event === 'storyChanged') {\n      // メモリリーク防止のため、古いアバター画像Blob URLキャッシュをクリーンアップ\n      ui.clearBlobUrlCache();\n      ui.renderStory();\n      ui.renderSidebar();\n      fillStorySettingsForm(state.currentStory);\n    } else if (event === 'stateChanged') {\n      // Toggle screens\n      toggleScreenVisibility(state.activeScreen);\n      \n      // Update sidebar when loading status or mode changes\n      const sendBtn = document.getElementById('send-btn');\n      if (sendBtn) {\n        sendBtn.disabled = state.isGenerating;\n      }\n    }\n  });\n\n  // Initialize Dropbox connection state UI after the core app is interactive.\n  await initDropbox();\n\n  // Handle Dropbox OAuth callback (PKCE)\n  const urlParams = new URLSearchParams(window.location.search);\n  if (urlParams.has('code') && urlParams.has('state')) {\n    await handleDropboxOAuthCallback(urlParams);\n  }\n}\n\nif (document.readyState === 'loading') {\n  document.addEventListener('DOMContentLoaded', bootApp, { once: true });\n} else {\n  bootApp();\n}\n\n/**\n * Loads API keys and models from storage.\n */\nasync function loadConfigurations() {\n  const provider = await db.getSetting('api_provider', 'gemini');\n  const key = await db.getSetting('api_key', '');\n  const model = await db.getSetting('model_name', 'gemini-2.5-flash');\n  const choices = await db.getSetting('show_choices', true);\n  \n  // Sync to memory state\n  updateState({\n    apiProvider: provider,\n    apiKey: key,\n    modelName: model,\n    showChoices: choices\n  });\n\n  // Prefill settings form\n  const provEl = document.getElementById('api-provider-select');\n  const keyEl = document.getElementById('api-key-input');\n  const modelEl = document.getElementById('model-name-select');\n  const choicesEl = document.getElementById('choices-toggle-checkbox');\n\n  if (provEl) provEl.value = provider;\n  if (keyEl) keyEl.value = key;\n  if (modelEl) modelEl.value = model;\n  if (choicesEl) choicesEl.checked = choices;\n}\n\n/**\n * Syncs the story settings fields (Rule, world prompts, protagonist specs)\n */\nfunction fillStorySettingsForm(story) { \n  const rPrompt = document.getElementById('story-rule-prompt');\n  const wPrompt = document.getElementById('story-world-prompt');\n  const pName = document.getElementById('protagonist-name');\n  const pDesc = document.getElementById('protagonist-desc');\n  const pPreview = document.getElementById('protagonist-img-preview');\n\n  if (!story) {\n    if (rPrompt) rPrompt.value = '';\n    if (wPrompt) wPrompt.value = '';\n    if (pName) pName.value = '';\n    if (pDesc) pDesc.value = '';\n    if (pPreview) pPreview.src = 'assets/default-silhouette.png';\n    return;\n  }\n\n  if (rPrompt) rPrompt.value = story.storytellerPrompt || '';\n  if (wPrompt) wPrompt.value = story.worldPrompt || '';\n  if (pName) pName.value = story.protagonist?.name || '';\n  if (pDesc) pDesc.value = story.protagonist?.description || '';\n  \n  if (pPreview && story.protagonist) {\n    db.getAssetBlob(story.protagonist.avatarAssetId).then(blob => {\n      if (blob) {\n        pPreview.src = URL.createObjectURL(blob);\n      } else {\n        pPreview.src = 'assets/default-silhouette.png';\n      }\n    });\n  }\n}\n\n/**\n * Handles DOM view switches based on screen ID.\n */\nfunction toggleScreenVisibility(activeScreen) {\n  document.querySelectorAll('.app-screen').forEach(screen => {\n    if (screen.id === `${activeScreen}-screen`) {\n      screen.classList.add('active');\n    } else {\n      screen.classList.remove('active');\n    }\n  });\n\n  // Sync menu highlights\n  document.querySelectorAll('.nav-btn').forEach(btn => {\n    if (btn.dataset.screen === activeScreen) {\n      btn.classList.add('active');\n    } else {\n      btn.classList.remove('active');\n    }\n  });\n}\n\n/**\n * Binds all general DOM events.\n */\nfunction bindEvents() {\n  // 1. Navigation Screen switching\n  document.querySelectorAll('.nav-btn').forEach(btn => {\n    btn.onclick = () => {\n      const screen = btn.dataset.screen;\n      updateState({ activeScreen: screen });\n      if (screen === 'library') {\n        ui.renderCharacterLibrary();\n      }\n    };\n  });\n\n  // Mobile drawer trigger\n  const menuBtn = document.getElementById('menu-trigger-btn');\n  const mobileDrawer = document.getElementById('mobile-drawer');\n  const drawerOverlay = document.getElementById('drawer-overlay');\n\n  if (menuBtn && mobileDrawer && drawerOverlay) {\n    menuBtn.onclick = () => {\n      mobileDrawer.classList.add('open');\n      ui.renderStoryList();\n    };\n    drawerOverlay.onclick = () => {\n      mobileDrawer.classList.remove('open');\n    };\n  }\n\n  // 2. View mode switching (Novel / Chat)\n  const modeToggle = document.getElementById('view-mode-toggle');\n  if (modeToggle) {\n    modeToggle.onclick = () => {\n      const currentMode = getState().uiMode;\n      const nextMode = currentMode === 'novel' ? 'chat' : 'novel';\n      modeToggle.textContent = nextMode === 'novel' ? 'book' : 'forum';\n      modeToggle.title = nextMode === 'novel' ? 'チャット表示へ切り替え' : '小説表示へ切り替え';\n      updateState({ uiMode: nextMode });\n      ui.renderStory();\n    };\n  }\n\n  // 3. New Story Creation\n  const newStoryBtn = document.getElementById('new-story-btn');\n  if (newStoryBtn) {\n    newStoryBtn.onclick = () => createNewStory();\n  }\n\n  // Bind action custom event (choices button click)\n  window.addEventListener('submitUserAction', (e) => {\n    const userInputField = document.getElementById('user-input-field');\n    if (userInputField) {\n      userInputField.value = e.detail;\n      submitStoryTurn();\n    }\n  });\n\n  // Send action input trigger\n  const sendBtn = document.getElementById('send-btn');\n  const userInputField = document.getElementById('user-input-field');\n\n  if (sendBtn && userInputField) {\n    sendBtn.onclick = () => submitStoryTurn();\n    userInputField.onkeydown = (e) => {\n      if (e.key === 'Enter' && !e.shiftKey) {\n        e.preventDefault();\n        submitStoryTurn();\n      }\n    };\n  }\n\n  // 4. Save Settings Changes\n  const provEl = document.getElementById('api-provider-select');\n  const keyEl = document.getElementById('api-key-input');\n  const modelEl = document.getElementById('model-name-select');\n  const choicesEl = document.getElementById('choices-toggle-checkbox');\n\n  if (provEl) {\n    provEl.onchange = (e) => {\n      const val = e.target.value;\n      updateState({ apiProvider: val });\n      db.saveSetting('api_provider', val);\n    };\n  }\n  if (keyEl) {\n    keyEl.oninput = (e) => {\n      const val = e.target.value.trim();\n      updateState({ apiKey: val });\n      db.saveSetting('api_key', val);\n      // Also save to localStorage for legacy fallback\n      localStorage.setItem('zetatavern_api_key', val);\n    };\n  }\n  if (modelEl) {\n    modelEl.onchange = (e) => {\n      const val = e.target.value;\n      updateState({ modelName: val });\n      db.saveSetting('model_name', val);\n    };\n  }\n  if (choicesEl) {\n    choicesEl.onchange = (e) => {\n      const val = e.target.checked;\n      updateState({ showChoices: val });\n      db.saveSetting('show_choices', val);\n      ui.renderStory(); // Refresh bottom choices\n    };\n  }\n\n  // 5. Active Story Configurations (World Settings changes)\n  const rPrompt = document.getElementById('story-rule-prompt');\n  const wPrompt = document.getElementById('story-world-prompt');\n\n  const saveCurrentStoryConfig = () => {\n    const { currentStory } = getState();\n    if (!currentStory) return;\n    currentStory.storytellerPrompt = rPrompt.value.trim();\n    currentStory.worldPrompt = wPrompt.value.trim();\n    db.saveStory(currentStory).then(() => {\n      ui.renderSidebar(); // Update sidebar configurations view\n    });\n  };\n\n  if (rPrompt) rPrompt.oninput = saveCurrentStoryConfig;\n  if (wPrompt) wPrompt.oninput = saveCurrentStoryConfig;\n\n  // Protagonist Profile updates\n  const pName = document.getElementById('protagonist-name');\n  const pDesc = document.getElementById('protagonist-desc');\n  const pImgInput = document.getElementById('protagonist-img-input');\n  const pPreview = document.getElementById('protagonist-img-preview');\n\n  const saveProtagonistConfig = async () => {\n    const { currentStory } = getState();\n    if (!currentStory) return;\n    if (!currentStory.protagonist) {\n      currentStory.protagonist = { name: '主人公', avatarAssetId: '', description: '' };\n    }\n\n    currentStory.protagonist.name = pName.value.trim() || '主人公';\n    currentStory.protagonist.description = pDesc.value.trim();\n    \n    await db.saveStory(currentStory);\n    ui.renderSidebar();\n  };\n\n  if (pName) pName.oninput = saveProtagonistConfig;\n  if (pDesc) pDesc.oninput = saveProtagonistConfig;\n  \n  if (pImgInput && pPreview) {\n    pImgInput.onchange = async (e) => {\n      const { currentStory } = getState();\n      if (!currentStory) return;\n      \n      const file = e.target.files[0];\n      if (file) {\n        if (!currentStory.protagonist) {\n          currentStory.protagonist = { name: '主人公', avatarAssetId: '', description: '' };\n        }\n        \n        // Delete old asset\n        if (currentStory.protagonist.avatarAssetId) {\n          await db.deleteAsset(currentStory.protagonist.avatarAssetId);\n        }\n        \n        // Save new\n        const newAssetId = await db.saveAsset(file, file.type);\n        currentStory.protagonist.avatarAssetId = newAssetId;\n        pPreview.src = URL.createObjectURL(file);\n        \n        await db.saveStory(currentStory);\n        ui.renderSidebar();\n      }\n    };\n  }\n\n  // 6. Character Import Trigger\n  const importCharInput = document.getElementById('char-import-input');\n  const importCharBtn = document.getElementById('char-import-btn');\n  if (importCharBtn && importCharInput) {\n    importCharBtn.onclick = () => importCharInput.click();\n    importCharInput.onchange = (e) => {\n      const file = e.target.files[0];\n      if (file) {\n        ui.importCharacterJSON(file);\n      }\n    };\n  }\n\n  // 7. Dropbox buttons\n  const dropboxAuthBtn      = document.getElementById('dropbox-auth-btn');\n  const dropboxPushBtn      = document.getElementById('dropbox-push-btn');\n  const dropboxPullBtn      = document.getElementById('dropbox-pull-btn');\n  const dropboxDisconnectBtn = document.getElementById('dropbox-disconnect-btn');\n  const dropboxFreqSelect   = document.getElementById('dropbox-sync-frequency');\n\n  if (dropboxAuthBtn) {\n    dropboxAuthBtn.onclick = () => startDropboxAuth();\n  }\n  if (dropboxPushBtn) {\n    dropboxPushBtn.onclick = () => performDropboxPush();\n  }\n  if (dropboxPullBtn) {\n    dropboxPullBtn.onclick = () => performDropboxPull();\n  }\n  if (dropboxDisconnectBtn) {\n    dropboxDisconnectBtn.onclick = async () => {\n      if (!confirm('Dropbox との連携を解除しますか？\\nローカルのデータは削除されません。')) return;\n      await dropbox.disconnect();\n      updateDropboxUI(false);\n    };\n  }\n  if (dropboxFreqSelect) {\n    const savedFreq = await db.getSetting('dropbox_sync_frequency', '0');\n    dropboxFreqSelect.value = savedFreq;\n    dropboxFreqSelect.onchange = (e) => {\n      db.saveSetting('dropbox_sync_frequency', e.target.value);\n    };\n  }\n}\n\n/**\n * Creates a new blank story in IndexedDB and activates it.\n */\nasync function createNewStory() {\n  const storyTitle = prompt('新しいストーリーのタイトルを入力してください:', '新規ストーリー');\n  if (storyTitle === null) return;\n\n  const newStory = {\n    title: storyTitle || '無題のストーリー',\n    storytellerPrompt: DEFAULT_STORYTELLER_PROMPT,\n    worldPrompt: DEFAULT_WORLD_PROMPT,\n    protagonist: {\n      name: '主人公',\n      avatarAssetId: '',\n      description: '普通の男子高校生。'\n    },\n    characters: [], // Array of { characterId, attendance }\n    // Gemini APIの制約（First turn must be USER）に対応するため、履歴の開始にダミーのuserメッセージを追加します\n    messages: [\n      {\n        role: 'user',\n        content: '物語を開始してください。',\n        timestamp: Date.now() - 1000\n      },\n      {\n        role: 'model',\n        content: `新しい物語が始まりました。主人公の名前は「主人公」です。\\n右側の設定パネルから、世界設定や主人公の詳細、登場人物の追加・役割の設定を行ってください。\\n\\nメッセージを入力するか、または送信してストーリーを開始してください。`,\n        timestamp: Date.now()\n      }\n    ],\n    sceneState: {\n      location: '学校',\n      timeOfDay: '昼下がり',\n      atmosphere: '穏やか',\n      summary: '新しい始まり。',\n      currentObjective: '周りの様子を伺う'\n    },\n    characterMemory: {},\n    relationshipMemory: {}\n  };\n\n  try {\n    const storyId = await db.saveStory(newStory);\n    newStory.storyId = storyId;\n\n    // Load active characters list to initialize attendance as absent\n    const charactersList = await db.getCharacters();\n    newStory.characters = charactersList.map(c => ({\n      characterId: c.characterId,\n      attendance: 'absent'\n    }));\n    await db.saveStory(newStory);\n\n    // Refresh stories lists\n    const stories = await db.getStories();\n    updateState({ stories });\n    setActiveStory(newStory);\n    ui.renderStoryList();\n    \n    // Switch to story board screen\n    updateState({ activeScreen: 'story' });\n  } catch (err) {\n    alert(`ストーリー作成に失敗しました: ${err.message}`);\n  }\n}\n\n/**\n * Main turn handler. Sends messages history and states to Gemini API and appends responses.\n */\nasync function submitStoryTurn() {\n  const { currentStory, isGenerating } = getState();\n  const inputEl = document.getElementById('user-input-field');\n  \n  if (!currentStory || isGenerating) return;\n\n  const userText = inputEl ? inputEl.value.trim() : '';\n  \n  // Gemini APIの交互性の規則（user -> model -> user）を遵守するため、\n  // 送信時にはテキストが空であっても『（物語の続きを描写してください）』等の代替テキストを必ず user 側から追加して送信します。\n  const finalUserText = userText || '（物語の続きを描写してください）';\n  \n  currentStory.messages.push({\n    role: 'user',\n    content: finalUserText,\n    timestamp: Date.now()\n  });\n  \n  if (inputEl) inputEl.value = '';\n  \n  await db.saveStory(currentStory);\n  ui.renderStory();\n\n  // Trigger AI generation\n  updateState({ isGenerating: true });\n  ui.renderStory();\n\n  try {\n    const aiTextResponse = await generateStoryResponse(currentStory);\n\n    currentStory.messages.push({\n      role: 'model',\n      content: aiTextResponse,\n      timestamp: Date.now()\n    });\n\n    await db.saveStory(currentStory);\n    \n    // Auto sync story lists count\n    const stories = await db.getStories();\n    updateState({ stories, isGenerating: false });\n    ui.renderStory();\n    ui.renderStoryList();\n\n    // Check auto-sync\n    await checkAutoSync();\n\n  } catch (err) {\n    alert(`ストーリーテラーの応答生成中にエラーが発生しました:\\n${err.message}`);\n    \n    // APIエラーが発生した場合、直前に追加した user メッセージをロールバックする処理を入れると、より親切です。\n    currentStory.messages.pop();\n    await db.saveStory(currentStory);\n\n    updateState({ isGenerating: false });\n    ui.renderStory();\n  }\n}\n\n// ============================================================\n// Dropbox 同期ヘルパー\n// ============================================================\n\n/** Dropbox 接続状態を確認し、UIを初期化する */\nasync function initDropbox() {\n  const connected = await dropbox.isConnected();\n  updateDropboxUI(connected);\n\n  if (connected) {\n    try {\n      const account = await dropbox.testConnection();\n      const nameEl = document.getElementById('dropbox-user-name');\n      if (nameEl && account?.name?.display_name) {\n        nameEl.textContent = account.name.display_name + ' のアカウントと連携済み';\n      }\n      const lastSync = await db.getSetting('dropbox_last_sync', null);\n      updateLastSyncText(lastSync);\n    } catch (e) {\n      console.warn('[Dropbox] 接続テストに失敗しました。', e);\n      updateDropboxUI(false);\n    }\n  }\n}\n\n/** 接続状態に応じて設定画面のDropbox UIを切り替える */\nfunction updateDropboxUI(connected) {\n  const authState      = document.getElementById('dropbox-auth-state');\n  const connectedState = document.getElementById('dropbox-connected-state');\n  if (authState)      authState.classList.toggle('hidden', connected);\n  if (connectedState) connectedState.classList.toggle('hidden', !connected);\n}\n\n/** 最終同期時刻を表示する */\nfunction updateLastSyncText(timestamp) {\n  const el = document.getElementById('dropbox-last-sync-text');\n  if (!el) return;\n  if (!timestamp) {\n    el.textContent = 'まだ同期していません';\n    return;\n  }\n  const d = new Date(timestamp);\n  el.textContent = `最終同期: ${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP')}`;\n}\n\n/** 同期進捗メッセージを表示する */\nfunction setDropboxProgress(msg) {\n  const el = document.getElementById('dropbox-sync-progress');\n  if (!el) return;\n  if (msg) {\n    el.textContent = msg;\n    el.classList.remove('hidden');\n  } else {\n    el.classList.add('hidden');\n    el.textContent = '';\n  }\n}\n\n/**\n * Dropbox PKCE 認証フローを開始する。\n * code_verifier を sessionStorage に保存し、認可ページへリダイレクトする。\n */\nasync function startDropboxAuth() { \n  try {\n    const { codeVerifier, codeChallenge } = await dropbox.generatePKCE();\n    sessionStorage.setItem('dropbox_code_verifier', codeVerifier);\n\n    const redirectUri = encodeURIComponent(window.location.href.split('?')[0]);\n    const state = crypto.randomUUID();\n    sessionStorage.setItem('dropbox_oauth_state', state);\n\n    const authUrl = `https://www.dropbox.com/oauth2/authorize` +\n      `?client_id=7z1zhgvciq5n7o0` +\n      `&response_type=code` +\n      `&redirect_uri=${redirectUri}` +\n      `&code_challenge=${codeChallenge}` +\n      `&code_challenge_method=S256` +\n      `&state=${state}` +\n      `&token_access_type=offline`;\n\n    window.location.href = authUrl;\n  } catch (err) {\n    alert(`Dropbox 認証の開始に失敗しました:\\n${err.message}`);\n  }\n}\n\n/**\n * OAuth コールバック処理。URLパラメータの code を使ってトークンを取得する。\n */\nasync function handleDropboxOAuthCallback(urlParams) { \n  const code          = urlParams.get('code');\n  const returnedState = urlParams.get('state');\n  const savedState    = sessionStorage.getItem('dropbox_oauth_state');\n  const codeVerifier  = sessionStorage.getItem('dropbox_code_verifier');\n\n  // stateが一致しない場合はセキュリティ上の問題\n  if (returnedState !== savedState) {\n    console.error('[Dropbox] OAuth state mismatch!');\n    return;\n  }\n\n  sessionStorage.removeItem('dropbox_oauth_state');\n  sessionStorage.removeItem('dropbox_code_verifier');\n\n  // URLをクリーンにする (コードを履歴から削除)\n  const cleanUrl = window.location.href.split('?')[0];\n  window.history.replaceState({}, document.title, cleanUrl);\n\n  try {\n    const redirectUri = cleanUrl;\n    await dropbox.getAccessToken(code, redirectUri, codeVerifier);\n    const account = await dropbox.testConnection();\n    updateDropboxUI(true);\n\n    const nameEl = document.getElementById('dropbox-user-name');\n    if (nameEl && account?.name?.display_name) {\n      nameEl.textContent = account.name.display_name + ' のアカウントと連携済み';\n    }\n\n    alert(`Dropbox との連携が完了しました！\\n「クラウドへ保存 (Push)」で初回バックアップを行ってください。`);\n  } catch (err) {\n    alert(`Dropbox 認証に失敗しました:\\n${err.message}`);\n  }\n}\n\n/**\n * ローカルデータを Dropbox へ Push する。\n */\nasync function performDropboxPush() { \n  const pushBtn = document.getElementById('dropbox-push-btn');\n  const pullBtn = document.getElementById('dropbox-pull-btn');\n  if (pushBtn) pushBtn.disabled = true;\n  if (pullBtn) pullBtn.disabled = true;\n\n  try {\n    const stories    = await db.getStories();\n    const characters = await db.getCharacters();\n\n    // アセットIDを収集し Blob を取得\n    const assetIds = new Set();\n    [...stories, ...characters].forEach(item => {\n      if (item.protagonist?.avatarAssetId) assetIds.add(item.protagonist.avatarAssetId);\n      if (item.avatarAssetId) assetIds.add(item.avatarAssetId);\n    });\n\n    const assets = [];\n    for (const assetId of assetIds) {\n      if (!assetId) continue;\n      const blob = await db.getAssetBlob(assetId);\n      if (blob) assets.push({ assetId, blob });\n    }\n\n    await dropbox.pushToDropbox({\n      stories,\n      characters,\n      assets,\n      onProgress: msg => setDropboxProgress(msg)\n    });\n\n    const now = Date.now();\n    await db.saveSetting('dropbox_last_sync', now);\n    updateLastSyncText(now);\n    setDropboxProgress(null);\n    alert('クラウドへの保存が完了しました！');\n  } catch (err) {\n    setDropboxProgress(null);\n    alert(`Push 同期に失敗しました:\\n${err.message}`);\n  } finally {\n    if (pushBtn) pushBtn.disabled = false;\n    if (pullBtn) pullBtn.disabled = false;\n  }\n}\n\n/**\n * Dropbox からデータを Pull し、ローカルに反映する。\n */\nasync function performDropboxPull() { \n  if (!confirm('クラウドからデータを復元します。\\n現在のローカルデータは上書きされます。続行しますか？')) return;\n\n  const pushBtn = document.getElementById('dropbox-push-btn');\n  const pullBtn = document.getElementById('dropbox-pull-btn');\n  if (pushBtn) pushBtn.disabled = true;\n  if (pullBtn) pullBtn.disabled = true;\n\n  try {\n    // 現在のローカルアセットIDを収集\n    const localAssets = await db.getAll('assets');\n    const localAssetIds = new Set(localAssets.map(a => a.assetId));\n\n    const { stories, characters, newAssets } = await dropbox.pullFromDropbox({\n      localAssetIds,\n      onProgress: msg => setDropboxProgress(msg)\n    });\n\n    if (!stories) {\n      setDropboxProgress(null);\n      alert('クラウドにデータが見つかりませんでした。');\n      return;\n    }\n\n    setDropboxProgress('ローカルデータを更新中...');\n\n    // 新しいアセットを保存\n    for (const { assetId, blob } of newAssets) {\n      // 既存の assetId で保存するには put を直接使う\n      await db.saveAssetWithId(assetId, blob, blob.type);\n    }\n\n    // Dropbox 側のメタデータを正として、ローカルだけに残った古い項目を消す。\n    await db.clearStore('stories');\n    await db.clearStore('characters');\n\n    // stories / characters を上書き保存\n    for (const story of stories) {\n      await db.saveStory(story);\n    }\n    for (const char of characters) {\n      await db.saveCharacter(char);\n    }\n\n    const now = Date.now();\n    await db.saveSetting('dropbox_last_sync', now);\n    updateLastSyncText(now);\n    setDropboxProgress(null);\n\n    // アプリの状態を再ロード\n    const updatedStories = await db.getStories();\n    const updatedChars   = await db.getCharacters();\n    updateState({ stories: updatedStories, characters: updatedChars });\n\n    if (updatedStories.length > 0) {\n      updatedStories.sort((a, b) => b.timestamp - a.timestamp);\n      setActiveStory(updatedStories[0]);\n    }\n\n    ui.renderStoryList();\n    ui.renderCharacterLibrary();\n    ui.renderStory();\n    ui.renderSidebar();\n\n    alert(`クラウドからの復元が完了しました！\\nストーリー: ${stories.length}件, キャラクター: ${characters.length}件, 新規アセット: ${newAssets.length}件`);\n  } catch (err) {\n    setDropboxProgress(null);\n    alert(`Pull 同期に失敗しました:\\n${err.message}`);\n  } finally {\n    if (pushBtn) pushBtn.disabled = false;\n    if (pullBtn) pullBtn.disabled = false;\n  }\n}\n\n/** ターン終了後に自動同期を行うか確認する */\nasync function checkAutoSync() {\n  const connected = await dropbox.isConnected();\n  if (!connected) return;\n\n  const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);\n  if (freq === 0) return;\n\n  const counter = (parseInt(await db.getSetting('dropbox_sync_counter', '0'), 10) + 1);\n  await db.saveSetting('dropbox_sync_counter', counter);\n\n  if (counter >= freq) {\n    await db.saveSetting('dropbox_sync_counter', 0);\n    console.log('[Dropbox] 自動同期を開始...');\n    try {\n      await performDropboxPush();\n    } catch (e) {\n      console.warn('[Dropbox] 自動同期に失敗しました:', e);\n    }\n  }\n}"
  },
  "next_steps": [
    "1. 上記に提示した修正済みの `js/app.js` の内容を、現在開発中プロジェクト内の同名ファイルに上書きしてください。",
    "2. APIキー（Gemini APIキー）を設定し、新規ストーリーを作成してメッセージの送信ができるか（ロール交互性のエラーが出ずに動作するか）テストを行ってください。",
    "3. Dropbox連携フロー、インポート・エクスポート等、その他の『動作検証と調整』を実施してください。検証中に新たな不具合や「ここを調整したい」という点が見つかりましたら、いつでもお気軽にお申し付けください。引き続き開発のサポートを担当させていただきます。"
  ]
}
}
  // Initialize Dropbox connection state UI after the core app is interactive.
  await initDropbox();

  // Handle Dropbox OAuth callback (PKCE)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('code') && urlParams.has('state')) {
    await handleDropboxOAuthCallback(urlParams);
  }
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
  const model = await db.getSetting('model_name', 'gemini-2.5-flash');
  const choices = await db.getSetting('show_choices', true);
  
  // Sync to memory state
  updateState({
    apiProvider: provider,
    apiKey: key,
    modelName: model,
    showChoices: choices
  });

  // Prefill settings form
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');

  if (provEl) provEl.value = provider;
  if (keyEl) keyEl.value = key;
  if (modelEl) modelEl.value = model;
  if (choicesEl) choicesEl.checked = choices;
}

/**
 * Syncs the story settings fields (Rule, world prompts, protagonist specs)
 */
function fillStorySettingsForm(story) {
  const rPrompt = document.getElementById('story-rule-prompt');
  const wPrompt = document.getElementById('story-world-prompt');
  const pName = document.getElementById('protagonist-name');
  const pDesc = document.getElementById('protagonist-desc');
  const pPreview = document.getElementById('protagonist-img-preview');

  if (!story) {
    if (rPrompt) rPrompt.value = '';
    if (wPrompt) wPrompt.value = '';
    if (pName) pName.value = '';
    if (pDesc) pDesc.value = '';
    if (pPreview) pPreview.src = 'assets/default-silhouette.png';
    return;
  }

  if (rPrompt) rPrompt.value = story.storytellerPrompt || '';
  if (wPrompt) wPrompt.value = story.worldPrompt || '';
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
}

/**
 * Handles DOM view switches based on screen ID.
 */
function toggleScreenVisibility(activeScreen) {
  document.querySelectorAll('.app-screen').forEach(screen => {
    if (screen.id === `${activeScreen}-screen`) {
      screen.classList.add('active');
    } else {
      screen.classList.remove('active');
    }
  });

  // Sync menu highlights
  document.querySelectorAll('.nav-btn').forEach(btn => {
    if (btn.dataset.screen === activeScreen) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

/**
 * Binds all general DOM events.
 */
function bindEvents() {
  // 1. Navigation Screen switching
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      const screen = btn.dataset.screen;
      updateState({ activeScreen: screen });
      if (screen === 'library') {
        ui.renderCharacterLibrary();
      }
    };
  });

  // Mobile drawer trigger
  const menuBtn = document.getElementById('menu-trigger-btn');
  const mobileDrawer = document.getElementById('mobile-drawer');
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

  // 2. View mode switching (Novel / Chat)
  const modeToggle = document.getElementById('view-mode-toggle');
  if (modeToggle) {
    modeToggle.onclick = () => {
      const currentMode = getState().uiMode;
      const nextMode = currentMode === 'novel' ? 'chat' : 'novel';
      modeToggle.textContent = nextMode === 'novel' ? 'book' : 'forum';
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

  // Bind action custom event (choices button click)
  window.addEventListener('submitUserAction', (e) => {
    const userInputField = document.getElementById('user-input-field');
    if (userInputField) {
      userInputField.value = e.detail;
      submitStoryTurn();
    }
  });

  // Send action input trigger
  const sendBtn = document.getElementById('send-btn');
  const userInputField = document.getElementById('user-input-field');

  if (sendBtn && userInputField) {
    sendBtn.onclick = () => submitStoryTurn();
    userInputField.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitStoryTurn();
      }
    };
  }

  // 4. Save Settings Changes
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');

  if (provEl) {
    provEl.onchange = (e) => {
      const val = e.target.value;
      updateState({ apiProvider: val });
      db.saveSetting('api_provider', val);
    };
  }
  if (keyEl) {
    keyEl.oninput = (e) => {
      const val = e.target.value.trim();
      updateState({ apiKey: val });
      db.saveSetting('api_key', val);
      // Also save to localStorage for legacy fallback
      localStorage.setItem('zetatavern_api_key', val);
    };
  }
  if (modelEl) {
    modelEl.onchange = (e) => {
      const val = e.target.value;
      updateState({ modelName: val });
      db.saveSetting('model_name', val);
    };
  }
  if (choicesEl) {
    choicesEl.onchange = (e) => {
      const val = e.target.checked;
      updateState({ showChoices: val });
      db.saveSetting('show_choices', val);
      ui.renderStory(); // Refresh bottom choices
    };
  }

  // 5. Active Story Configurations (World Settings changes)
  const rPrompt = document.getElementById('story-rule-prompt');
  const wPrompt = document.getElementById('story-world-prompt');

  const saveCurrentStoryConfig = () => {
    const { currentStory } = getState();
    if (!currentStory) return;
    currentStory.storytellerPrompt = rPrompt.value.trim();
    currentStory.worldPrompt = wPrompt.value.trim();
    db.saveStory(currentStory).then(() => {
      ui.renderSidebar(); // Update sidebar configurations view
    });
  };

  if (rPrompt) rPrompt.oninput = saveCurrentStoryConfig;
  if (wPrompt) wPrompt.oninput = saveCurrentStoryConfig;

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
    ui.renderSidebar();
  };

  if (pName) pName.oninput = saveProtagonistConfig;
  if (pDesc) pDesc.oninput = saveProtagonistConfig;
  
  if (pImgInput && pPreview) {
    pImgInput.onchange = async (e) => {
      const { currentStory } = getState();
      if (!currentStory) return;
      
      const file = e.target.files[0];
      if (file) {
        if (!currentStory.protagonist) {
          currentStory.protagonist = { name: '主人公', avatarAssetId: '', description: '' };
        }
        
        // Delete old asset
        if (currentStory.protagonist.avatarAssetId) {
          await db.deleteAsset(currentStory.protagonist.avatarAssetId);
        }
        
        // Save new
        const newAssetId = await db.saveAsset(file, file.type);
        currentStory.protagonist.avatarAssetId = newAssetId;
        pPreview.src = URL.createObjectURL(file);
        
        await db.saveStory(currentStory);
        ui.renderSidebar();
      }
    };
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
    };
  }

  // 7. Dropbox buttons
  const dropboxAuthBtn      = document.getElementById('dropbox-auth-btn');
  const dropboxPushBtn      = document.getElementById('dropbox-push-btn');
  const dropboxPullBtn      = document.getElementById('dropbox-pull-btn');
  const dropboxDisconnectBtn = document.getElementById('dropbox-disconnect-btn');
  const dropboxFreqSelect   = document.getElementById('dropbox-sync-frequency');

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
async function createNewStory() {
  const storyTitle = prompt('新しいストーリーのタイトルを入力してください:', '新規ストーリー');
  if (storyTitle === null) return;

  const newStory = {
    title: storyTitle || '無題のストーリー',
    storytellerPrompt: DEFAULT_STORYTELLER_PROMPT,
    worldPrompt: DEFAULT_WORLD_PROMPT,
    protagonist: {
      name: '主人公',
      avatarAssetId: '',
      description: '普通の男子高校生。'
    },
    characters: [], // Array of { characterId, attendance }
    messages: [
      {
        role: 'model',
        content: `新しい物語が始まりました。主人公の名前は「主人公」です。\n右側の設定パネルから、世界設定や主人公の詳細、登場人物の追加・役割の設定を行ってください。\n\nメッセージを入力するか、または送信してストーリーを開始してください。`,
        timestamp: Date.now()
      }
    ],
    sceneState: {
      location: '学校',
      timeOfDay: '昼下がり',
      atmosphere: '穏やか',
      summary: '新しい始まり。',
      currentObjective: '周りの様子を伺う'
    },
    characterMemory: {},
    relationshipMemory: {}
  };

  try {
    const storyId = await db.saveStory(newStory);
    newStory.storyId = storyId;

    // Load active characters list to initialize attendance as absent
    const charactersList = await db.getCharacters();
    newStory.characters = charactersList.map(c => ({
      characterId: c.characterId,
      attendance: 'absent'
    }));
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

/**
 * Main turn handler. Sends messages history and states to Gemini API and appends responses.
 */
async function submitStoryTurn() {
  const { currentStory, isGenerating } = getState();
  const inputEl = document.getElementById('user-input-field');
  
  if (!currentStory || isGenerating) return;

  const userText = inputEl ? inputEl.value.trim() : '';
  
  // Create user message if they typed something
  if (userText) {
    currentStory.messages.push({
      role: 'user',
      content: userText,
      timestamp: Date.now()
    });
    
    if (inputEl) inputEl.value = '';
    
    await db.saveStory(currentStory);
    ui.renderStory();
  }

  // Trigger AI generation
  updateState({ isGenerating: true });
  ui.renderStory();

  try {
    const aiTextResponse = await generateStoryResponse(currentStory);

    currentStory.messages.push({
      role: 'model',
      content: aiTextResponse,
      timestamp: Date.now()
    });

    await db.saveStory(currentStory);
    
    // Auto sync story lists count
    const stories = await db.getStories();
    updateState({ stories, isGenerating: false });
    ui.renderStory();
    ui.renderStoryList();

    // Check auto-sync
    await checkAutoSync();

  } catch (err) {
    alert(`ストーリーテラーの応答生成中にエラーが発生しました:\n${err.message}`);
    
    // Rollback user input if API failed completely (optional, here we keep it but reset generator state)
    updateState({ isGenerating: false });
    ui.renderStory();
  }
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
    } catch (e) {
      console.warn('[Dropbox] 接続テストに失敗しました。', e);
      updateDropboxUI(false);
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

/**
 * Dropbox PKCE 認証フローを開始する。
 * code_verifier を sessionStorage に保存し、認可ページへリダイレクトする。
 */
async function startDropboxAuth() {
  try {
    const { codeVerifier, codeChallenge } = await dropbox.generatePKCE();
    sessionStorage.setItem('dropbox_code_verifier', codeVerifier);

    const redirectUri = encodeURIComponent(window.location.href.split('?')[0]);
    const state = crypto.randomUUID();
    sessionStorage.setItem('dropbox_oauth_state', state);

    const authUrl = `https://www.dropbox.com/oauth2/authorize` +
      `?client_id=7z1zhgvciq5n7o0` +
      `&response_type=code` +
      `&redirect_uri=${redirectUri}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256` +
      `&state=${state}` +
      `&token_access_type=offline`;

    window.location.href = authUrl;
  } catch (err) {
    alert(`Dropbox 認証の開始に失敗しました:\n${err.message}`);
  }
}

/**
 * OAuth コールバック処理。URLパラメータの code を使ってトークンを取得する。
 */
async function handleDropboxOAuthCallback(urlParams) {
  const code          = urlParams.get('code');
  const returnedState = urlParams.get('state');
  const savedState    = sessionStorage.getItem('dropbox_oauth_state');
  const codeVerifier  = sessionStorage.getItem('dropbox_code_verifier');

  // stateが一致しない場合はセキュリティ上の問題
  if (returnedState !== savedState) {
    console.error('[Dropbox] OAuth state mismatch!');
    return;
  }

  sessionStorage.removeItem('dropbox_oauth_state');
  sessionStorage.removeItem('dropbox_code_verifier');

  // URLをクリーンにする (コードを履歴から削除)
  const cleanUrl = window.location.href.split('?')[0];
  window.history.replaceState({}, document.title, cleanUrl);

  try {
    const redirectUri = cleanUrl;
    await dropbox.getAccessToken(code, redirectUri, codeVerifier);
    const account = await dropbox.testConnection();
    updateDropboxUI(true);

    const nameEl = document.getElementById('dropbox-user-name');
    if (nameEl && account?.name?.display_name) {
      nameEl.textContent = account.name.display_name + ' のアカウントと連携済み';
    }

    alert(`Dropbox との連携が完了しました！\n「クラウドへ保存 (Push)」で初回バックアップを行ってください。`);
  } catch (err) {
    alert(`Dropbox 認証に失敗しました:\n${err.message}`);
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
    const stories    = await db.getStories();
    const characters = await db.getCharacters();

    // アセットIDを収集し Blob を取得
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

    await dropbox.pushToDropbox({
      stories,
      characters,
      assets,
      onProgress: msg => setDropboxProgress(msg)
    });

    const now = Date.now();
    await db.saveSetting('dropbox_last_sync', now);
    updateLastSyncText(now);
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
    // 現在のローカルアセットIDを収集
    const localAssets = await db.getAll('assets');
    const localAssetIds = new Set(localAssets.map(a => a.assetId));

    const { stories, characters, newAssets } = await dropbox.pullFromDropbox({
      localAssetIds,
      onProgress: msg => setDropboxProgress(msg)
    });

    if (!stories) {
      setDropboxProgress(null);
      alert('クラウドにデータが見つかりませんでした。');
      return;
    }

    setDropboxProgress('ローカルデータを更新中...');

    // 新しいアセットを保存
    for (const { assetId, blob } of newAssets) {
      // 既存の assetId で保存するには put を直接使う
      await db.saveAssetWithId(assetId, blob, blob.type);
    }

    // Dropbox 側のメタデータを正として、ローカルだけに残った古い項目を消す。
    await db.clearStore('stories');
    await db.clearStore('characters');

    // stories / characters を上書き保存
    for (const story of stories) {
      await db.saveStory(story);
    }
    for (const char of characters) {
      await db.saveCharacter(char);
    }

    const now = Date.now();
    await db.saveSetting('dropbox_last_sync', now);
    updateLastSyncText(now);
    setDropboxProgress(null);

    // アプリの状態を再ロード
    const updatedStories = await db.getStories();
    const updatedChars   = await db.getCharacters();
    updateState({ stories: updatedStories, characters: updatedChars });

    if (updatedStories.length > 0) {
      updatedStories.sort((a, b) => b.timestamp - a.timestamp);
      setActiveStory(updatedStories[0]);
    }

    ui.renderStoryList();
    ui.renderCharacterLibrary();
    ui.renderStory();
    ui.renderSidebar();

    alert(`クラウドからの復元が完了しました！\nストーリー: ${stories.length}件, キャラクター: ${characters.length}件, 新規アセット: ${newAssets.length}件`);
  } catch (err) {
    setDropboxProgress(null);
    alert(`Pull 同期に失敗しました:\n${err.message}`);
  } finally {
    if (pushBtn) pushBtn.disabled = false;
    if (pullBtn) pullBtn.disabled = false;
  }
}

/** ターン終了後に自動同期を行うか確認する */
async function checkAutoSync() {
  const connected = await dropbox.isConnected();
  if (!connected) return;

  const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);
  if (freq === 0) return;

  const counter = (parseInt(await db.getSetting('dropbox_sync_counter', '0'), 10) + 1);
  await db.saveSetting('dropbox_sync_counter', counter);

  if (counter >= freq) {
    await db.saveSetting('dropbox_sync_counter', 0);
    console.log('[Dropbox] 自動同期を開始...');
    try {
      await performDropboxPush();
    } catch (e) {
      console.warn('[Dropbox] 自動同期に失敗しました:', e);
    }
  }
}
