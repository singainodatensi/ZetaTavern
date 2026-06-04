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
const DEFAULT_STORYTELLER_PROMPT =   `・三人称視点で描写し、キャラクター同士のテンポの良い会話（台詞）と、動き・仕草（動作・情景描写）を中心に物語を進行させてください。\n` +
    `・「語るな、見せろ（Show, don't tell）」を厳守してください。キャラクターの感情を「嬉しい」「怒る」などと地の文で直接説明せず、声のトーン、視線、間（ま）、仕草、セリフの選び方で生き生きと表現してください。\n` +
    `・各登場人物は、主人公や他のキャラクターの話し方に影響（汚染・伝染）されず、固有の一人称・二人称・敬語レベル・語尾を厳格に維持して発言させてください。\n` +
    `・一度の出力で事態を勝手に解決・完結させず、主人公（ユーザー）が次のターンで介入（発言や行動の選択）できる明確な「判断の余白」を残した時点で物語の記述を終了してください。`;

// Default World settings template
const DEFAULT_WORLD_PROMPT = `【世界観】\n現代の高校を舞台にした日常系ラブコメの世界。\n\n【状況】\n主人公は平凡な男子高校生。ある日、隣の席に学校一の美少女が座ることになり……`;

let hasBooted = false;
let isSyncInProgress = false; // 同期の多重実行を防ぐ排他ガードフラグ
let isDropboxAutoSyncRunning = false;
let pendingDropboxAutoSync = null;

const DROPBOX_SYNC_SETTING_KEYS = [
  'api_provider',
  'api_key',
  'model_name',
  'show_choices',
  'autoscroll_enabled',
  'custom_models',
  'dropbox_app_key',
  'dropbox_sync_frequency',
  'thinking_level',
  'api_timeout',
  'api_retries',
  'font_size',
  'narration_bg',
  'narration_color',
  'narration_opacity'
];

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
      ui.renderSidebar();
      fillStorySettingsForm(state.currentStory);
    } else if (event === 'stateChanged') {
      // Toggle screens
      toggleScreenVisibility(state.activeScreen);
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
  const model = await db.getSetting('model_name', 'gemini-2.5-flash');
  const choices = await db.getSetting('show_choices', true);
  const autoscroll = await db.getSetting('autoscroll_enabled', true); // ★自動スクロール設定
  const customModels = await db.getSetting('custom_models', []);
  const dropboxAppKey = await db.getSetting('dropbox_app_key', '');
  const thinkingLevel = await db.getSetting('thinking_level', 'standard');
  
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
    modelName: model,
    showChoices: choices,
    autoscrollEnabled: autoscroll, // ★Stateに反映
    apiTimeout: apiTimeout,
    apiRetries: apiRetries,
    fontSize: fontSize,
    narrationBg: narrationBg,
    narrationColor: narrationColor,
    narrationOpacity: narrationOpacity,
    thinkingLevel: thinkingLevel // ★ 追加
  });

  // Prefill settings form
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');
  const autoscrollEl = document.getElementById('autoscroll-toggle-checkbox'); // ★DOM取得
  const dropboxKeyEl = document.getElementById('dropbox-app-key-input');
  const retriesEl = document.getElementById('settings-retries-input');
  const timeoutEl = document.getElementById('settings-timeout-input');
  const fontSizeEl = document.getElementById('font-size-input');
  const nBgEl = document.getElementById('narration-bg-input');
  const nColorEl = document.getElementById('narration-color-input');
  const nOpacityEl = document.getElementById('narration-opacity-slider');
  const thinkingEl = document.getElementById('thinking-level-select'); // ★ 追加

  if (provEl) provEl.value = provider;
  if (keyEl) keyEl.value = key;
  if (choicesEl) choicesEl.checked = choices;
  if (autoscrollEl) autoscrollEl.checked = autoscroll;
  if (dropboxKeyEl) dropboxKeyEl.value = dropboxAppKey || '';
  if (retriesEl) retriesEl.value = apiRetries;
  if (timeoutEl) timeoutEl.value = apiTimeout;
  if (fontSizeEl) fontSizeEl.value = fontSize;
  if (nBgEl) nBgEl.value = narrationBg;
  if (nColorEl) nColorEl.value = narrationColor;
  if (nOpacityEl) nOpacityEl.value = narrationOpacity;
  if (thinkingEl) thinkingEl.value = thinkingLevel; // ★ 追加

  if (modelEl) {
    const defaultValues = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemma-3-27b-it'];
    Array.from(modelEl.options).forEach(opt => {
      if (!defaultValues.includes(opt.value)) {
        modelEl.remove(opt.index);
      }
    });

    customModels.forEach(customModel => {
      const opt = document.createElement('option');
      opt.value = customModel;
      opt.textContent = `${customModel} (カスタム)`;
      modelEl.appendChild(opt);
    });

    if (!defaultValues.includes(model) && !customModels.includes(model)) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = `${model} (カスタム)`;
      modelEl.appendChild(opt);
      customModels.push(model);
      await db.saveSetting('custom_models', customModels);
    }

    modelEl.value = model;
  }
}

/**
 * Syncs the story settings fields (Rule, world prompts, protagonist specs)
 */
function fillStorySettingsForm(story) {
  const rPrompt = document.getElementById('story-rule-prompt');
  const wPrompt = document.getElementById('story-world-prompt');
  const fInput = document.getElementById('story-franchise-input');
  const pName = document.getElementById('protagonist-name');
  const pDesc = document.getElementById('protagonist-desc');
  const pPreview = document.getElementById('protagonist-img-preview');

  if (!story) {
    if (rPrompt) rPrompt.value = '';
    if (wPrompt) wPrompt.value = '';
    if (fInput) fInput.value = '';
    if (pName) pName.value = '';
    if (pDesc) pDesc.value = '';
    if (pPreview) pPreview.src = 'assets/default-silhouette.png';
    return;
  }

  if (rPrompt) rPrompt.value = story.storytellerPrompt || '';
  if (wPrompt) wPrompt.value = story.worldPrompt || '';
  if (fInput) fInput.value = story.franchise || '';
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
async function bindEvents() {
  // 1. Navigation Screen switching
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      const screen = btn.dataset.screen;
      updateState({ activeScreen: screen });
      if (screen === 'library') {
        ui.renderCharacterLibrary();
      } else if (screen === 'lorebook') {
        ui.renderLorebook();
      }
    };
  });

  // Bind Lorebook elements
  const loreAddBtn = document.getElementById('lore-add-btn');
  const loreSearchInput = document.getElementById('lore-search-input');
  const loreFilterSelect = document.getElementById('lore-filter-select');
  const tabWorld = document.getElementById('lorebook-tab-world');
  const tabSession = document.getElementById('lorebook-tab-session');

  if (loreAddBtn) {
    loreAddBtn.onclick = () => ui.showLoreEditModal(null);
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

  // Mobile drawer trigger (left — story list)
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

  // Right sidebar toggle (mobile — scene/status/config)
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebarContainer = document.getElementById('story-sidebar-container');
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

  // Send action input trigger
  const sendBtn = document.getElementById('send-btn');
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

  // ★ 長文用 textarea の自動拡張イベントをバインド
  const textareasToAutoResize = [
    document.getElementById('user-input-field'),
    document.getElementById('story-rule-prompt'),
    document.getElementById('story-world-prompt'),
    document.getElementById('protagonist-desc')
  ];
  textareasToAutoResize.forEach(el => {
    if (el) {
      el.addEventListener('input', () => triggerAutoResize(el));
    }
  });

  // 4. Save Settings Changes
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');
  const autoscrollEl = document.getElementById('autoscroll-toggle-checkbox'); // ★自動スクロールDOM
  const customModelInput = document.getElementById('custom-model-input');
  const customModelAddBtn = document.getElementById('custom-model-add-btn');
  const retriesEl = document.getElementById('settings-retries-input');
  const timeoutEl = document.getElementById('settings-timeout-input');
  const fontSizeEl = document.getElementById('font-size-input');
  const nBgEl = document.getElementById('narration-bg-input');
  const nColorEl = document.getElementById('narration-color-input');
  const nOpacityEl = document.getElementById('narration-opacity-slider');
  const thinkingEl = document.getElementById('thinking-level-select'); // ★ 追加

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
      updateState({ thinkingLevel: val });
      db.saveSetting('thinking_level', val);
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

      let optionExists = false;
      for (let i = 0; i < modelEl.options.length; i++) {
        if (modelEl.options[i].value === newModel) {
          optionExists = true;
          break;
        }
      }

      if (!optionExists) {
        const opt = document.createElement('option');
        opt.value = newModel;
        opt.textContent = `${newModel} (カスタム)`;
        modelEl.appendChild(opt);
      }

      if (!customModels.includes(newModel)) {
        customModels.push(newModel);
        await db.saveSetting('custom_models', customModels);
      }

      modelEl.value = newModel;
      updateState({ modelName: newModel });
      await db.saveSetting('model_name', newModel);

      customModelInput.value = '';
      alert(`モデル「${newModel}」を追加し、現在モデルとして適用しました。`);
    };
  }

  // 5. Active Story Configurations (World Settings changes)
  const rPrompt = document.getElementById('story-rule-prompt');
  const wPrompt = document.getElementById('story-world-prompt');
  const fInput = document.getElementById('story-franchise-input');

  const saveCurrentStoryConfig = () => {
    const { currentStory } = getState();
    if (!currentStory) return;
    currentStory.storytellerPrompt = rPrompt.value.trim();
    currentStory.worldPrompt = wPrompt.value.trim();
    currentStory.franchise = fInput ? fInput.value.trim() : '';
    db.saveStory(currentStory).then(async () => {
      const stories = await db.getStories();
      updateState({ stories });
      ui.renderSidebar();
    });
  };

  if (rPrompt) rPrompt.oninput = () => { saveCurrentStoryConfig(); triggerAutoResize(rPrompt); };
  if (wPrompt) wPrompt.oninput = () => { saveCurrentStoryConfig(); triggerAutoResize(wPrompt); };
  if (fInput) fInput.oninput = () => { saveCurrentStoryConfig(); };

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
    };
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
async function createNewStory() {
  const storyTitle = prompt('新しいストーリーのタイトルを入力してください:', '新規ストーリー');
  if (storyTitle === null) return;

  const newStory = {
title: storyTitle || '無題のストーリー',
    franchise: '', // ★作品タグ（原作検索・ロア用）
    storytellerPrompt: '', // ★デフォルトの長い指示はコアに移動したため空でOK
    worldPrompt: DEFAULT_WORLD_PROMPT,
    tags: [],
    // ★ プリセットデータの初期値を丸ごとセットする（デフォルトはラブコメ）
    directorSettings: { momentum: 40, autonomy: 80, worldTone: 10, backgroundTension: 0, romanticVisibility: 20, relationshipDrift: 60, intrusionRate: 0 },
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
    const aiResponse = await generateStoryResponse(currentStory); // ★ 変数名を変更
    if (!aiResponse?.text) {
      throw new Error('AIから有効な本文が返されませんでした。');
    }

    currentStory.messages.push({
      role: 'model',
      content: aiResponse.text,         // ★ 本文
      thought: aiResponse.thought || '', // ★ 思考内容を追加保存
      timestamp: Date.now()
    });

    await db.saveStory(currentStory);

    // バックグラウンドで自動ロア検索とデータベース保存を実行（非同期）
    triggerBackgroundLoreLookup(currentStory);
    
    // Auto sync story lists count
    const stories = await db.getStories();
    updateState({ stories, isGenerating: false });
    ui.renderStory();
    ui.renderStoryList();

    // Auto-sync to Dropbox in the background.
    queueDropboxAutoSync(currentStory.storyId);

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
  const directiveRegex = /^@:\s*([^「」:：\n]+?)\s*(?:「([^」]*)」|[:：]\s*(.+)|\s+(.+))\s*$/;

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
      updateDropboxUI(false);
      updateSyncStatusIndicator('offline');
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
    const stories    = await db.getStories();
    const characters = await db.getCharacters();

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
      settings: await collectDropboxSettings(),
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
    const localAssets = await db.getAll('assets');
    const localAssetIds = new Set(localAssets.map(a => a.assetId));

    const { stories, characters, settings, newAssets } = await dropbox.pullFromDropbox({
      localAssetIds,
      onProgress: msg => setDropboxProgress(msg)
    });

    if (!stories) {
      setDropboxProgress(null);
      alert('クラウドにデータが見つかりませんでした。');
      return;
    }

    setDropboxProgress('ローカルデータを更新中...');

    await restoreDropboxSettings(settings);

    for (const { assetId, blob } of newAssets) {
      await db.saveAssetWithId(assetId, blob, blob.type);
    }

    await db.clearStore('stories');
    await db.clearStore('characters');

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

/** ターン終了後に自動同期を行うか確認する（静的UI表示） */
function queueDropboxAutoSync(storyId = null) {
  pendingDropboxAutoSync = { storyId };
  if (isDropboxAutoSyncRunning) return;

  isDropboxAutoSyncRunning = true;
  setTimeout(async () => {
    try {
      while (pendingDropboxAutoSync) {
        const next = pendingDropboxAutoSync;
        pendingDropboxAutoSync = null;
        await performAutoDropboxSync(next.storyId);
      }
    } finally {
      isDropboxAutoSyncRunning = false;
      if (pendingDropboxAutoSync) queueDropboxAutoSync(pendingDropboxAutoSync.storyId);
    }
  }, 0);
}

async function performAutoDropboxSync(storyId = null) {
  const connected = await dropbox.isConnected();
  if (!connected) return;

  const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);
  if (freq === 0) return;

  const counter = (parseInt(await db.getSetting('dropbox_sync_counter', '0'), 10) + 1);
  await db.saveSetting('dropbox_sync_counter', counter);

  if (counter >= freq) {
    await db.saveSetting('dropbox_sync_counter', 0);
    console.log('[Dropbox] 自動同期を開始...');
    updateSyncStatusIndicator('syncing');
    try {
      await performDropboxPushSilent({ storyId, preferDelta: true });
      const now = Date.now();
      await db.saveSetting('dropbox_last_sync', now);
      updateLastSyncText(now);
      updateSyncStatusIndicator('success');
    } catch (e) {
      console.warn('[Dropbox] 自動同期に失敗しました:', e);
      updateSyncStatusIndicator('error');
    }
  }
}

/**
 * Silent push (no alert, no button disable — for auto-sync).
 */
async function performDropboxPushSilent({ storyId = null, preferDelta = false } = {}) {
  const stories    = await db.getStories();
  const characters = await db.getCharacters();
  const settings = await collectDropboxSettings();

  if (preferDelta && storyId) {
    const story = stories.find(item => item.storyId === storyId);
    if (story) {
      const result = await dropbox.pushStoryDeltaToDropbox({
        story,
        settings,
        onProgress: msg => console.log('[Dropbox AutoSync]', msg)
      });
      if (result) return;
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

  await dropbox.pushToDropbox({
    stories,
    characters,
    settings,
    assets,
    onProgress: msg => console.log('[Dropbox AutoSync]', msg)
  });
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
  const stories = await db.getStories();
  const characters = await db.getCharacters();

  const hasNewStory = stories.some(s => (s.timestamp || 0) > lastSync);
  const hasNewChar = characters.some(c => (c.timestamp || 0) > lastSync);

  return hasNewStory || hasNewChar;
}

/** Auto-pull on app startup if connected and frequency > 0 */
async function performStartupSync() {
  const connected = await dropbox.isConnected();
  if (!connected) return;

  const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);
  if (freq === 0) return;

  if (isSyncInProgress) {
    console.log('[Dropbox] 起動時同期の多重実行を回避しました。');
    return;
  }

  isSyncInProgress = true;
  updateSyncStatusIndicator('syncing');
  try {
    if (await hasNewerLocalChanges()) {
      console.log('[Dropbox StartupSync] ローカルに最新の未同期編集があります。Pullをスキップし、Pushをバックグラウンド実行します。');
      await performDropboxPushSilent();
      const now = Date.now();
      await db.saveSetting('dropbox_last_sync', now);
      updateLastSyncText(now);
      updateSyncStatusIndicator('success');
      return;
    }

    const localAssets = await db.getAll('assets');
    const localAssetIds = new Set(localAssets.map(a => a.assetId));

    const { stories, characters, settings, newAssets } = await dropbox.pullFromDropbox({
      localAssetIds,
      onProgress: msg => console.log('[Dropbox StartupSync]', msg)
    });

    if (stories) {
      await restoreDropboxSettings(settings);

      for (const { assetId, blob } of newAssets) {
        await db.saveAssetWithId(assetId, blob, blob.type);
      }
      await db.clearStore('stories');
      await db.clearStore('characters');
      for (const story of stories) await db.saveStory(story);
      for (const char of characters) await db.saveCharacter(char);

      const updatedStories = await db.getStories();
      const updatedChars   = await db.getCharacters();
      updateState({ stories: updatedStories, characters: updatedChars });

      if (updatedStories.length > 0) {
        updatedStories.sort((a, b) => b.timestamp - a.timestamp);
        // ★ ここでも起動時のラストストーリーの復元処理を連携
        const lastActiveId = await db.getSetting('last_active_story_id', null);
        let targetStory = updatedStories.find(s => s.storyId === lastActiveId);
        if (!targetStory) targetStory = updatedStories[0];
        setActiveStory(targetStory);
      }
      ui.renderStoryList();
      ui.renderCharacterLibrary();
    }

    const now = Date.now();
    await db.saveSetting('dropbox_last_sync', now);
    updateLastSyncText(now);
    updateSyncStatusIndicator('success');
  } catch (e) {
    console.warn('[Dropbox] 起動時同期に失敗:', e);
    updateSyncStatusIndicator('error');
  } finally {
    isSyncInProgress = false;
  }
}

/** Sync on tab return (visibility change) */
function setupVisibilitySync() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
// タブ復帰だけでは同期しない。同期は起動時・チャット更新時・明示操作に限定する。
    // Chrome などのフォーカス変更で過剰同期が走るのを避けるため、ここでは表示だけ整える。
    if (await dropbox.isConnected()) {
      updateSyncStatusIndicator('idle');
    }

  });
}

// ==========================================
// 自動ロア検索バックグラウンド処理
// ==========================================
import { generateLoreProfileFromSearch } from './ai-client.js';

async function triggerBackgroundLoreLookup(story) {
  const franchise = story.franchise || '';
  if (!franchise) return; // 作品タグがない場合は検索クエリの正確性が保てないためスキップ

  // キーワードの抽出 (直近のメッセージなどを解析)
  // ai-clientの関数を動的に呼び出すための簡易的な抽出処理
  const detectedKeywords = extractKeywordsForLore(story);
  if (detectedKeywords.length === 0) return;

  for (const keyword of detectedKeywords) {
    try {
      const existing = await db.getLoreByNameAndFranchise(keyword, franchise);
      if (existing) {
        // すでに登録されているか、現在処理中、あるいは過去のエラーならスキップ
        if (existing.status === 'completed' || existing.status === 'pending' || existing.status === 'failed') {
          continue;
        }
      }

      // 未登録の場合はプレースホルダー登録して処理開始
      const placeholder = {
        id: 'lore_' + crypto.randomUUID(),
        franchise,
        type: 'term',
        name: keyword,
        content: {
          summary: '自動検索・要約中...',
          profile: '',
          speech: '',
          relationships: ''
        },
        source: 'ai-generated',
        verified: false,
        status: 'pending'
      };
      await db.saveLore(placeholder);

      // バックグラウンドで非同期実行
      executeLoreLookup(placeholder, keyword, franchise);

    } catch (e) {
      console.warn(`Error check or initial save for lore keyword ${keyword}:`, e);
    }
  }
}

async function executeLoreLookup(placeholder, keyword, franchise) {
  try {
    console.log(`[Lore Automatic Lookup] Starting search for [${franchise}] ${keyword}`);
    const result = await generateLoreProfileFromSearch(keyword, franchise);
    
    placeholder.content = {
      summary: result.summary || '',
      profile: result.profile || '',
      speech: result.speech || '',
      relationships: result.relationships || ''
    };
    placeholder.type = result.type || 'term';
    placeholder.status = 'completed';
    await db.saveLore(placeholder);
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
  }
}

// 補助用にai-client.jsと同様の簡易抽出をapp.js内にも持たせる
function extractKeywordsForLore(story) {
  const wordsSet = new Set();
  const textSource = [];
  const msgs = story.messages || [];
  const startIdx = Math.max(0, msgs.length - 2);
  for (let i = startIdx; i < msgs.length; i++) {
    textSource.push(msgs[i].content);
  }
  if (story.sceneState) {
    textSource.push(story.sceneState.location || '');
    textSource.push(story.sceneState.currentObjective || '');
  }
  const combinedText = textSource.join('\n');
  const matchesKatakana = combinedText.match(/[\u30a0-\u30ffー]{2,15}/g) || [];
  const matchesKanji = combinedText.match(/[\u4e00-\u9faf]{2,10}/g) || [];
  const matchesEnglish = combinedText.match(/[A-Z][a-zA-Z]{2,15}/g) || [];

  [...matchesKatakana, ...matchesKanji, ...matchesEnglish].forEach(word => {
    const w = word.trim();
    if (w && w.length >= 2) {
      wordsSet.add(w);
    }
  });
  return Array.from(wordsSet);
}
