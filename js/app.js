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
    `・一度の出力で事態を勝手に解決・完結させず、主人公（ユーザー）が次のターンで介入（発言や行動 of 選択）できる明確な「判断の余白」を残した時点で物語の記述を終了してください。`;

// Default World settings template
const DEFAULT_WORLD_PROMPT = `【世界観】\n現代の高校を舞台にした日常系ラブコメの世界。\n\n【状況】\n主人公は平凡な男子高校生。ある日、隣の席に学校一の美少女が座ることになり……`;

let hasBooted = false;
let isSyncInProgress = false; // 同期の多重実行を防ぐ排他ガードフラグ

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

  // Fill story settings form after initial render
  if (getState().currentStory) {
    fillStorySettingsForm(getState().currentStory);
  }

  // Bind all event handlers
  await bindEvents();

  // Subscribe state changes to auto-render UI
  subscribe((event, state) => {
    if (event === 'storyChanged') {
      // メモリリーク防止のため、古いアバター画像Blob URLキャッシュをクリーンアップ
      ui.clearBlobUrlCache();
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
  const customModels = await db.getSetting('custom_models', []);
  const dropboxAppKey = await db.getSetting('dropbox_app_key', '');
  
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
    apiTimeout: apiTimeout,
    apiRetries: apiRetries,
    fontSize: fontSize,
    narrationBg: narrationBg,
    narrationColor: narrationColor,
    narrationOpacity: narrationOpacity
  });

  // Prefill settings form
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');
  const dropboxKeyEl = document.getElementById('dropbox-app-key-input');
  const retriesEl = document.getElementById('settings-retries-input');
  const timeoutEl = document.getElementById('settings-timeout-input');
  const fontSizeEl = document.getElementById('font-size-input');
  const nBgEl = document.getElementById('narration-bg-input');
  const nColorEl = document.getElementById('narration-color-input');
  const nOpacityEl = document.getElementById('narration-opacity-slider');

  if (provEl) provEl.value = provider;
  if (keyEl) keyEl.value = key;
  if (choicesEl) choicesEl.checked = choices;
  if (dropboxKeyEl) dropboxKeyEl.value = dropboxAppKey || '';
  if (retriesEl) retriesEl.value = apiRetries;
  if (timeoutEl) timeoutEl.value = apiTimeout;
  if (fontSizeEl) fontSizeEl.value = fontSize;
  if (nBgEl) nBgEl.value = narrationBg;
  if (nColorEl) nColorEl.value = narrationColor;
  if (nOpacityEl) nOpacityEl.value = narrationOpacity;

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
async function bindEvents() {
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
      submitStoryTurn();
    }
  });

  // Send action input trigger
  const sendBtn = document.getElementById('send-btn');
  const userInputField = document.getElementById('user-input-field');

  if (sendBtn && userInputField) {
    sendBtn.onclick = () => submitStoryTurn();
    
    // キーバインド改修：Ctrl+Enter(Command+Enter)でのみ送信、通常のEnterは改行を許可
    userInputField.onkeydown = (e) => {
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          submitStoryTurn();
        } else {
          // Enter単体の場合はイベントをインターセプトせず、そのまま改行（textareaの標準挙動）を通す
        }
      }
    };
  }

  // 4. Save Settings Changes
  const provEl = document.getElementById('api-provider-select');
  const keyEl = document.getElementById('api-key-input');
  const modelEl = document.getElementById('model-name-select');
  const choicesEl = document.getElementById('choices-toggle-checkbox');
  const customModelInput = document.getElementById('custom-model-input');
  const customModelAddBtn = document.getElementById('custom-model-add-btn');
  const retriesEl = document.getElementById('settings-retries-input');
  const timeoutEl = document.getElementById('settings-timeout-input');
  const fontSizeEl = document.getElementById('font-size-input');
  const nBgEl = document.getElementById('narration-bg-input');
  const nColorEl = document.getElementById('narration-color-input');
  const nOpacityEl = document.getElementById('narration-opacity-slider');

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

  const saveCurrentStoryConfig = () => {
    const { currentStory } = getState();
    if (!currentStory) return;
    currentStory.storytellerPrompt = rPrompt.value.trim();
    currentStory.worldPrompt = wPrompt.value.trim();
    db.saveStory(currentStory).then(async () => {
      const stories = await db.getStories();
      updateState({ stories });
      ui.renderSidebar();
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
    
    const stories = await db.getStories();
    updateState({ stories });
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
    storytellerPrompt: DEFAULT_STORYTELLER_PROMPT,
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
  
  const finalUserText = userText || '（物語の続きを描写してください）';
  
  currentStory.messages.push({
    role: 'user',
    content: finalUserText,
    timestamp: Date.now()
  });
  
  if (inputEl) inputEl.value = '';
  
  await db.saveStory(currentStory);
  ui.renderStory();

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

    // Auto-sync to Dropbox (silent)
    await performAutoDropboxSync();

  } catch (err) {
    // ユーザーによる意図的なキャンセル（手動停止）の場合
    if (err.message && err.message.includes('中止されました')) {
      updateState({ isGenerating: false });
      ui.renderStory();
      return;
    }

    alert(`ストーリーテラーの応答生成中にエラーが発生しました:\n${err.message}`);
    
    currentStory.messages.pop();
    await db.saveStory(currentStory);

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
async function performAutoDropboxSync() {
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
      await performDropboxPushSilent();
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
async function performDropboxPushSilent() {
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

  // ★ 追加：多重起動（Visibility APIとの競合）を防ぐ排他処理ガード
  if (isSyncInProgress) {
    console.log('[Dropbox] 起動時同期の多重実行を回避しました。');
    return;
  }

  isSyncInProgress = true;
  updateSyncStatusIndicator('syncing');
  try {
    // ★ 安全ガード：ローカルに変更がある場合は、引き戻さずに、サイレントにPush（自動退避アップロード）を行う
    if (await hasNewerLocalChanges()) {
      console.log('[Dropbox StartupSync] ローカルに最新の未同期編集があります。Pullをスキップし、Pushをバックグラウンド実行します。');
      await performDropboxPushSilent();
      const now = Date.now();
      await db.saveSetting('dropbox_last_sync', now);
      updateLastSyncText(now);
      updateSyncStatusIndicator('success');
      return;
    }

    // Pull latest data silently
    const localAssets = await db.getAll('assets');
    const localAssetIds = new Set(localAssets.map(a => a.assetId));

    const { stories, characters, newAssets } = await dropbox.pullFromDropbox({
      localAssetIds,
      onProgress: msg => console.log('[Dropbox StartupSync]', msg)
    });

    if (stories) {
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
        setActiveStory(updatedStories[0]);
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
    isSyncInProgress = false; // ★ ガード解除
  }
}

/** Sync on tab return (visibility change) */
function setupVisibilitySync() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const connected = await dropbox.isConnected();
    if (!connected) return;
    const freq = parseInt(await db.getSetting('dropbox_sync_frequency', '0'), 10);
    if (freq === 0) return;
    // Auto-pull on tab return
    await performStartupSync();
  });
}

3. js/ui.js の全コード（完全版・差し替え用）

余計な日本語の文章を一切排除した、プログラムとして100%クリーンな ui.js の全ソースコードです。
トリミングのズレ問題に対する倍率計算の完全同期、モーダル内に表示される「位置を再調整」ボタン（何度でもトリミングをやり直せるセッション保持）、さらにPC画面でのタイムライン全体（ナレーター＆セリフ）の800px中央カラム制限、および
await 抜けバグが完全に修正されています [7.1, 7.2]。

/**
 * ui.js - ZetaTavern UI Rendering & DOM Events
 * Controls screen views, renders stories (novel / chat mode with per-character bubbles),
 * handles settings/character libraries, and parses AI-generated A/B/C options.
 */

import { getState, updateState, setActiveStory, updateCharacterAttendance } from './state.js';
import * as db from './db.js';
import { sanitizeHTML, escapeHTML } from './sanitizer.js';

// Holds temporary blob URLs to prevent memory leaks
const blobUrlCache = new Map();

/**
 * Generates or retrieves a Blob URL for a given Asset ID.
 * Falls back to default silhouette if not found.
 */
async function getAvatarUrl(assetId) {
  if (!assetId) {
    return 'assets/default-silhouette.png';
  }
  
  if (blobUrlCache.has(assetId)) {
    return blobUrlCache.get(assetId);
  }

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

/**
 * Revokes all cached Blob URLs to free memory.
 */
export function clearBlobUrlCache() {
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  blobUrlCache.clear();
}

/**
 * Parses choice formats like "► A. Description" or "A. Description" from LLM output.
 * Splits the body text from the choices block.
 */
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

  // Fallback: no choices parsed, return full text
  return { bodyText: text, choices: [] };
}

// ============================================================
// Chat Parser — split AI narrative into per-character segments
// ============================================================

/**
 * Segment types:
 *   { type: 'narration', text: '...' }
 *   { type: 'dialogue', speaker: '中野四葉', lines: [ { kind: 'speech'|'action', text } ] }
 */
export function parseModelOutputToSegments(text) {
  if (!text) return [{ type: 'narration', text: '' }];

  const lines = text.split('\n');
  const segments = [];
  let currentDialogue = null;
  let narrationBuffer = [];

  const flushNarration = () => {
    const joined = narrationBuffer.join('\n').trim();
    if (joined) {
      segments.push({ type: 'narration', text: joined });
    }
    narrationBuffer = [];
  };

  const flushDialogue = () => {
    if (currentDialogue && currentDialogue.lines.length > 0) {
      segments.push(currentDialogue);
    }
    currentDialogue = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ────────────────────────────────────────────────────────
    // ルール A: 新しい明示的なフォーマット [キャラクター名] 「セリフ」
    // ────────────────────────────────────────────────────────
    const structuredDialogueMatch = trimmed.match(/^\[([^\]]+)\]\s*(「[^」]+」|.*)$/);
    if (structuredDialogueMatch) {
      flushNarration();
      flushDialogue();

      const speaker = structuredDialogueMatch[1].trim();
      const dialogueText = structuredDialogueMatch[2].trim();

      // ナレーター、システム、背景、ナレーション用のセリフブロックは、吹き出し無しの地の文（narration）として扱う
      if (speaker === 'ナレーター' || speaker === 'システム' || speaker === '背景' || speaker === 'ナレーション') {
        segments.push({ type: 'narration', text: dialogueText });
        continue;
      }

      currentDialogue = {
        type: 'dialogue',
        speaker: speaker,
        lines: [{ kind: 'speech', text: dialogueText }]
      };
      flushDialogue(); // 1セリフごとに単一の吹き出しとして即座に完結させます
      continue;
    }

    // ────────────────────────────────────────────────────────
    // ルール B: 新しい明示的な動作描写・地の文 *動作* 
    // ────────────────────────────────────────────────────────
    const isAction = /^\*(.+)\*$/.test(trimmed) || /^＊(.+)＊$/.test(trimmed);
    if (isAction) {
      const actionText = trimmed.replace(/^\*|\*$/g, '').replace(/^＊|＊$/g, '').trim();
      
      // 直前が会話中であれば、その会話ブロックの中の「動作」としてぶら下げる
      if (currentDialogue) {
        currentDialogue.lines.push({ kind: 'action', text: actionText });
      } else {
        // そうでなければ独立した動作・ナレーション
        flushNarration();
        segments.push({ type: 'narration', text: `*${actionText}*` });
      }
      continue;
    }

    // ────────────────────────────────────────────────────────
    // ルール C: 旧ヒューリスティック判定（後方互換用）
    // ────────────────────────────────────────────────────────
    const inlineDialogueMatch = trimmed.match(/^(.+?)「(.+)$/);
    const startsWithQuote = trimmed.startsWith('「');

    const isSpeakerHeader = (
      trimmed.length > 0 &&
      trimmed.length <= 30 &&
      !trimmed.includes('「') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('―') &&
      !trimmed.startsWith('─') &&
      !trimmed.startsWith('-') &&
      !trimmed.startsWith('>') &&
      !/^[\s\d\.\-\*]+$/.test(trimmed)
    );

    if (inlineDialogueMatch && !startsWithQuote) {
      const speakerCandidate = inlineDialogueMatch[1].trim();
      if (speakerCandidate.length <= 20 && !/[#\*\-►▶]/.test(speakerCandidate)) {
        flushNarration();
        flushDialogue();
        currentDialogue = { type: 'dialogue', speaker: speakerCandidate, lines: [] };
        const speechText = '「' + inlineDialogueMatch[2];
        currentDialogue.lines.push({ kind: 'speech', text: speechText });
        continue;
      }
    }

    if (isSpeakerHeader) {
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;
      const nextLine = nextIdx < lines.length ? lines[nextIdx].trim() : '';
      if (nextLine.startsWith('「') || /^\*(.+)\*$/.test(nextLine) || /^＊(.+)＊$/.test(nextLine)) {
        flushNarration();
        flushDialogue();
        currentDialogue = { type: 'dialogue', speaker: trimmed, lines: [] };
        continue;
      }
    }

    if (currentDialogue) {
      if (startsWithQuote || trimmed.includes('「')) {
        currentDialogue.lines.push({ kind: 'speech', text: trimmed });
        continue;
      }
      flushDialogue();
    }

    // デフォルト：地の文
    narrationBuffer.push(line);
  }

  flushNarration();
  flushDialogue();

  return segments.length > 0 ? segments : [{ type: 'narration', text: text }];
}

/**
 * Fuzzy-match a speaker name against registered characters.
 * Returns matched Character object or null.
 */
function matchCharacterByName(speakerName, characters) {
  if (!speakerName || !characters || characters.length === 0) return null;
  const normalised = speakerName.trim();

  // Exact match
  let match = characters.find(c => c.name === normalised);
  if (match) return match;

  // Partial match: speaker name is contained in character name or vice versa
  match = characters.find(c =>
    c.name.includes(normalised) || normalised.includes(c.name)
  );
  if (match) return match;

  return null;
}

/**
 * キャラクターがストーリーのタグにマッチしているか判定します（世界観絞り込みフィルタ）。
 */
export function isCharacterMatchingStory(char, story) {
  if (!story) return false;
  const storyTags = story.tags || [];
  if (storyTags.length === 0) return true; // 物語にタグがない場合はすべてのキャラを表示（互換性維持）

  const charCategory = char.category || '';
  const charTags = char.tags || [];

  // カテゴリー、またはキャラクター自身に登録された個別タグが、ストーリータグに含まれているか確認
  const matchCategory = storyTags.includes(charCategory);
  const matchTags = charTags.some(tag => storyTags.includes(tag));

  return matchCategory || matchTags;
}

/**
 * Renders the story messages to the screen based on the current uiMode.
 */
export async function renderStory() {
  const container = document.getElementById('story-viewport');
  if (!container) return;

  container.innerHTML = '';
  const { currentStory, uiMode, isGenerating } = getState();

  if (!currentStory) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined">menu_book</span>
        <p>ストーリーを作成または選択してください</p>
        <button id="quick-create-story-btn" class="primary-btn">新規ストーリー作成</button>
      </div>
    `;
    return;
  }

  const messages = currentStory.messages || [];
  
  // Determine if we should parse choices on the very last model response
  const lastMsg = messages[messages.length - 1];
  const lastIsModel = lastMsg && lastMsg.role === 'model';
  
  let parsedLast = { bodyText: '', choices: [] };
  if (lastIsModel) {
    parsedLast = parseChoices(lastMsg.content);
  }

  // Pre-load character list for avatar matching in chat mode
  const characters = uiMode === 'chat' ? await db.getCharacters() : [];

  // Render messages
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;
    const isModel = msg.role === 'model';
    const textToRender = (isLast && isModel) ? parsedLast.bodyText : msg.content;

    if (uiMode === 'chat') {
      // ── Chat View: per-character bubbles ──
      if (isModel) {
        const segments = parseModelOutputToSegments(textToRender);
        for (const seg of segments) {
          if (seg.type === 'narration') {
            const narEl = document.createElement('div');
            // ★ 通常のセリフと同じ構造にし、左側に不可視アバターを配置することでラインをセリフと完全統一
            narEl.className = 'chat-message narration-role'; 
            let html = '';
            if (window.marked && typeof window.marked.parse === 'function') {
              html = sanitizeHTML(window.marked.parse(seg.text));
            } else {
              html = sanitizeHTML(seg.text.replace(/\n/g, '<br>'));
            }
            narEl.innerHTML = `
              <div class="chat-avatar" style="visibility: hidden; flex-shrink: 0;"></div>
              <div class="chat-content-wrapper">
                <div class="narration-content">${html}</div>
              </div>
            `;
            container.appendChild(narEl);
          } else if (seg.type === 'dialogue') {
            // 話し手が「主人公」本人かどうか判定
            const protagonistName = currentStory.protagonist?.name || '主人公';
            const isProtagonist = (seg.speaker === protagonistName || seg.speaker === '主人公');

            let avatarUrl = 'assets/default-silhouette.png';
            let roleClass = 'bot-role'; // デフォルト：左側

            if (isProtagonist) {
              roleClass = 'user-role'; // 右側配置
              avatarUrl = await getAvatarUrl(currentStory.protagonist?.avatarAssetId);
            } else {
              const charMatch = matchCharacterByName(seg.speaker, characters);
              if (charMatch) {
                avatarUrl = await getAvatarUrl(charMatch.avatarAssetId);
              }
            }

            const msgEl = document.createElement('div');
            msgEl.className = `chat-message ${roleClass}`;

            let linesHTML = '';
            for (const line of seg.lines) {
              if (line.kind === 'speech') {
                const escaped = escapeHTML(line.text);
                linesHTML += `<p class="chat-speech">${escaped}</p>`;
              } else if (line.kind === 'action') {
                linesHTML += `<p class="chat-action"><em>*${escapeHTML(line.text)}*</em></p>`;
              }
            }

            msgEl.innerHTML = `
              <div class="chat-avatar">
                <img src="${avatarUrl}" alt="${escapeHTML(seg.speaker)}">
              </div>
              <div class="chat-content-wrapper">
                <span class="chat-sender-name">${escapeHTML(seg.speaker)}</span>
                <div class="chat-bubble">${linesHTML}</div>
              </div>
            `;
            container.appendChild(msgEl);
          }
        }
      } else {
        // User message
        let avatarUrl = 'assets/default-silhouette.png';
        let senderName = 'You';
        if (currentStory.protagonist) {
          senderName = currentStory.protagonist.name || 'You';
          avatarUrl = await getAvatarUrl(currentStory.protagonist.avatarAssetId);
        }

        let contentHTML = '';
        if (window.marked && typeof window.marked.parse === 'function') {
          contentHTML = sanitizeHTML(window.marked.parse(textToRender));
        } else {
          contentHTML = sanitizeHTML(textToRender.replace(/\n/g, '<br>'));
        }

        const msgEl = document.createElement('div');
        msgEl.className = 'chat-message user-role';
        msgEl.innerHTML = `
          <div class="chat-avatar">
            <img src="${avatarUrl}" alt="${senderName}">
          </div>
          <div class="chat-content-wrapper">
            <span class="chat-sender-name">${senderName}</span>
            <div class="chat-bubble">${contentHTML}</div>
          </div>
        `;
        container.appendChild(msgEl);
      }

    } else {
      // ── Novel View Rendering ──
      let contentHTML = '';
      if (window.marked && typeof window.marked.parse === 'function') {
        contentHTML = sanitizeHTML(window.marked.parse(textToRender));
      } else {
        contentHTML = sanitizeHTML(textToRender.replace(/\n/g, '<br>'));
      }

      const blockEl = document.createElement('div');
      blockEl.className = `novel-block ${isModel ? 'story-paragraph' : 'action-paragraph'}`;
      
      if (!isModel) {
        const pName = currentStory.protagonist?.name || '主人公';
        blockEl.innerHTML = `<span class="novel-action-badge">${pName}の行動</span>${contentHTML}`;
      } else {
        blockEl.innerHTML = contentHTML;
      }
      container.appendChild(blockEl);
    }
  }

  // If loading indicator is active
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
    container.appendChild(loader);

    // 停止ボタンのクリックイベントを設定
    const cancelBtn = loader.querySelector('#cancel-generation-btn');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        const { activeAbortController } = getState();
        if (activeAbortController) {
          activeAbortController.abort(); // 生成処理を中断
        }
      };
    }
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;

  // Render parsed choices at the bottom if enabled and available
  renderChoiceButtons(parsedLast.choices);
}

/**
 * Renders the parsed choices as interactive buttons.
 */
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
      // Auto-submit the choice
      const textToSend = `${choice.label}. ${choice.text}`;
      window.dispatchEvent(new CustomEvent('submitUserAction', { detail: textToSend }));
    };
    choicesContainer.appendChild(btn);
  });
}

/**
 * Renders the sidebar (Scene status, protagonist info, character roles, relationships)
 */
export async function renderSidebar() {
  const { currentStory } = getState();
  const sidebarEl = document.getElementById('story-sidebar');
  if (!sidebarEl) return;

  if (!currentStory) {
    sidebarEl.innerHTML = `<div class="sidebar-empty">ストーリーを選択するとステータスが表示されます</div>`;
    return;
  }

  const { protagonist, sceneState, characterMemory, relationshipMemory } = currentStory;
  const pAvatarUrl = await getAvatarUrl(protagonist?.avatarAssetId);
  
  // 世界観のタグ絞り込み（タグ一致キャラのみ抽出、タグがなければ全キャラ表示）
  const allCharacters = await db.getCharacters();
  const characters = allCharacters.filter(char => isCharacterMatchingStory(char, currentStory));

  let html = `
    <!-- Protagonist Profile Card -->
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

    <!-- Active Scene Status -->
    <div class="sidebar-section">
      <h4>現在のシーン状況</h4>
      <div class="scene-state-form">
        <div class="form-row">
          <label>現在地</label>
          <input type="text" id="scene-location-input" value="${escapeHTML(sceneState?.location || '')}" placeholder="例: 教室、放課後">
        </div>
        <div class="form-row">
          <label>時間帯</label>
          <input type="text" id="scene-time-input" value="${escapeHTML(sceneState?.timeOfDay || '')}" placeholder="例: 夕方">
        </div>
        <div class="form-row">
          <label>雰囲気</label>
          <input type="text" id="scene-atmosphere-input" value="${escapeHTML(sceneState?.atmosphere || '')}" placeholder="例: 気まずい、賑やか">
        </div>
        <div class="form-row">
          <label>直近の目的</label>
          <input type="text" id="scene-objective-input" value="${escapeHTML(sceneState?.currentObjective || '')}" placeholder="例: 告白する、脱出する">
        </div>
      </div>
    </div>

    <!-- Character Roles (Attendance) and Memories -->
    <div class="sidebar-section">
      <h4>登場キャラクター・関係性</h4>
      <div class="sidebar-characters-list">
  `;

  if (characters.length === 0) {
    html += `<p class="note">タグの一致するキャラクター、または登録されているキャラクターはいません。</p>`;
  } else {
    for (const char of characters) {
      const charRef = currentStory.characters?.find(c => c.characterId === char.characterId);
      const role = charRef ? charRef.attendance : 'absent';
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
            <select class="char-attendance-select" data-char-id="${char.characterId}">
              <option value="main" ${role === 'main' ? 'selected' : ''}>主要 (Main)</option>
              <option value="support" ${role === 'support' ? 'selected' : ''}>補助 (Support)</option>
              <option value="background" ${role === 'background' ? 'selected' : ''}>背景 (Bg)</option>
              <option value="absent" ${role === 'absent' ? 'selected' : ''}>不在 (Absent)</option>
            </select>
          </div>
          
          <div class="char-role-body ${role === 'absent' ? 'hidden' : ''}">
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

  html += `
      </div>
    </div>
  `;

  sidebarEl.innerHTML = html;

  // Bind change events to sidebar elements to save changes immediately
  bindSidebarEvents();
}

/**
 * Binds input and change event listeners to dynamically update the active story object.
 */
function bindSidebarEvents() {
  const { currentStory } = getState();
  if (!currentStory) return;

  const saveStateChanges = () => {
    db.saveStory(currentStory).then(async () => {
      // 変更をグローバルStateリストに同期して整合性を維持
      const stories = await db.getStories();
      updateState({ stories });
      window.dispatchEvent(new CustomEvent('storyDataUpdated'));
    });
  };

  // 主人公カードクリック時に設定モーダルを起動（PC・タブレット用）
  const pCard = document.querySelector('.sidebar-protagonist-card');
  if (pCard) {
    pCard.onclick = () => {
      showStorySettingsModal();
    };
  }

  // 1. Scene State changes
  const locInput = document.getElementById('scene-location-input');
  const timeInput = document.getElementById('scene-time-input');
  const atmosInput = document.getElementById('scene-atmosphere-input');
  const objInput = document.getElementById('scene-objective-input');

  if (locInput) locInput.oninput = (e) => { currentStory.sceneState.location = e.target.value; saveStateChanges(); };
  if (timeInput) timeInput.oninput = (e) => { currentStory.sceneState.timeOfDay = e.target.value; saveStateChanges(); };
  if (atmosInput) atmosInput.oninput = (e) => { currentStory.sceneState.atmosphere = e.target.value; saveStateChanges(); };
  if (objInput) objInput.oninput = (e) => { currentStory.sceneState.currentObjective = e.target.value; saveStateChanges(); };

  // 2. Attendance Select changes
  document.querySelectorAll('.char-attendance-select').forEach(select => {
    select.onchange = (e) => {
      const charId = e.target.dataset.charId;
      const role = e.target.value;
      
      // Update UI roles visibility
      const row = e.target.closest('.sidebar-char-row');
      const body = row.querySelector('.char-role-body');
      if (role === 'absent') {
        body.classList.add('hidden');
      } else {
        body.classList.remove('hidden');
      }
      
      updateCharacterAttendance(charId, role);
      saveStateChanges();
    };
  });

  // 3. Affinity Range changes
  document.querySelectorAll('.char-affinity-range').forEach(range => {
    range.oninput = (e) => {
      const charId = e.target.dataset.charId;
      const val = parseInt(e.target.value);
      
      // Update label
      const label = e.target.previousElementSibling;
      label.textContent = `好感度 (${val})`;

      if (!currentStory.relationshipMemory) currentStory.relationshipMemory = {};
      if (!currentStory.relationshipMemory[charId]) currentStory.relationshipMemory[charId] = { affinity: 50, notes: '' };
      
      currentStory.relationshipMemory[charId].affinity = val;
      saveStateChanges();
    };
  });

  // 4. Status Memory changes
  document.querySelectorAll('.char-status-input').forEach(input => {
    input.oninput = (e) => {
      const charId = e.target.dataset.charId;
      if (!currentStory.characterMemory) currentStory.characterMemory = {};
      if (!currentStory.characterMemory[charId]) currentStory.characterMemory[charId] = { status: '', shortTermGoal: '', location: '' };

      currentStory.characterMemory[charId].status = e.target.value;
      saveStateChanges();
    };
  });

  // 5. Relation Memory notes changes
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

/**
 * Renders the story list in the side drawer or switcher.
 */
export async function renderStoryList() {
  const container = document.getElementById('stories-list-container');
  if (!container) return;

  container.innerHTML = '';
  const stories = await db.getStories();
  const current = getState().currentStory;

  stories.sort((a, b) => b.timestamp - a.timestamp);

  // --- 追加：スマホ対応アクティブストーリー設定ボタン ---
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
    
    // レイアウト崩れを防ぐため、テキストとアクション(編集・削除)をflexコンテナでグループ化
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
      // 名前変更
      if (e.target.closest('.rename-story-btn')) {
        e.stopPropagation();
        const oldTitle = story.title || '新しいストーリー';
        const newTitle = prompt('ストーリーの名前を変更:', oldTitle);
        
        if (newTitle !== null && newTitle.trim() !== '') {
          story.title = newTitle.trim();
          db.saveStory(story).then(() => {
            if (current && current.storyId === story.storyId) {
              setActiveStory(story);
            }
            renderStoryList();
          });
        }
        return;
      }

      // 削除
      if (e.target.closest('.delete-story-btn')) {
        e.stopPropagation();
        if (confirm(`ストーリー「${story.title}」を削除しますか？`)) {
          db.deleteStory(story.storyId).then(() => {
            if (current && current.storyId === story.storyId) {
              setActiveStory(null);
            }
            renderStoryList();
          });
        }
        return;
      }
      
      setActiveStory(story);
      renderStoryList();
      // Close mobile drawer if open
      document.getElementById('mobile-drawer')?.classList.remove('open');
    };

    container.appendChild(el);
  });
}

/**
 * Renders the Character Library screen (Grid view & Add/Edit form)
 * Supports search filtering and category filtering.
 */
export async function renderCharacterLibrary() {
  const container = document.getElementById('library-viewport');
  if (!container) return;

  container.innerHTML = '';
  const characters = await db.getCharacters();

  const searchInput = document.getElementById('library-search-input');
  const filterSelect = document.getElementById('library-filter-select');
  const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const filterMode = filterSelect ? filterSelect.value : 'all';

  // Collect unique categories for the filter dropdown
  const categories = new Set();
  characters.forEach(c => {
    if (c.category) categories.add(c.category);
  });

  // Rebuild filter options dynamically (keep "all", "in-story", "matching-tags" and categories)
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

    // 追加：タグの一致するキャラクターのみを表示するフィルターオプション
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

  // Determine which character IDs are in the current story
  const { currentStory } = getState();
  const inStoryCharIds = new Set();
  if (currentStory && currentStory.characters) {
    currentStory.characters.forEach(c => {
      if (c.attendance && c.attendance !== 'absent') {
        inStoryCharIds.add(c.characterId);
      }
    });
  }

  // Filter characters
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

  // "Add Character" Card
  const addCard = document.createElement('div');
  addCard.className = 'char-card add-card';
  addCard.innerHTML = `
    <span class="material-symbols-outlined add-icon">person_add</span>
    <strong>新しいキャラクター</strong>
  `;
  addCard.onclick = () => showCharacterModal();
  container.appendChild(addCard);

  // Render character list cards
  for (const char of filtered) {
    const card = document.createElement('div');
    card.className = 'char-card';
    const avatarUrl = await getAvatarUrl(char.avatarAssetId);
    
    let tagBadges = '';
    if (char.category) {
      tagBadges += `<span class="char-card-tag">${escapeHTML(char.category)}</span>`;
    }
    if (char.tags && char.tags.length > 0) {
      char.tags.forEach(t => {
        if (t !== char.category) {
          tagBadges += `<span class="char-card-tag" style="background-color: var(--primary-light, #e1f5fe); color: var(--primary-dark, #0288d1);">${escapeHTML(t)}</span>`;
        }
      });
    }

    card.innerHTML = `
      <div class="char-card-avatar-wrapper">
        <img src="${avatarUrl}" alt="${char.name}">
      </div>
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

    // Action handlers
    card.querySelector('.edit-char-btn').onclick = (e) => {
      e.stopPropagation();
      showCharacterModal(char);
    };
    
    card.querySelector('.export-char-btn').onclick = (e) => {
      e.stopPropagation();
      exportCharacterJSON(char);
    };

    card.querySelector('.delete-char-btn').onclick = (e) => {
      e.stopPropagation();
      if (confirm(`キャラクター「${char.name}」を削除しますか？\n(紐付いているアバター画像も削除されます)`)) {
        db.deleteCharacter(char.characterId).then(async () => {
          // メモリ上のStateを同期
          const updatedChars = await db.getCharacters();
          updateState({ characters: updatedChars });
          renderCharacterLibrary();
          renderSidebar();
        });
      }
    };

    container.appendChild(card);
  }
}

/**
 * Canvasを使用して、画像を任意の倍率と位置（トリミング・プレビュー同期）で切り抜いて正方形のBlobとして返します。
 * 外部ライブラリ不要で、完全にオフラインで動作します。
 */
export function cropImageToSquareBlob(file, zoomPercent, shiftX, shiftY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 300; // アイコン用に最適化された正方形
      canvas.height = 300;
      const ctx = canvas.getContext('2d');

      const r = 300 / 200; // プレビュー200pxから出力300pxへの変換倍率(1.5)

      // ズーム値を反映したソース切り出し窓のサイズを数学的に完全同期
      const scale = zoomPercent / 100;
      const aspect = img.width / img.height;
      
      let baseWidth, baseHeight;
      if (aspect > 1) {
        baseHeight = 200;
        baseWidth = 200 * aspect;
      } else {
        baseWidth = 200;
        baseHeight = 200 / aspect;
      }

      // 出力用の描画寸法
      const drawWidth = baseWidth * scale * r;
      const drawHeight = baseHeight * scale * r;

      // CSSのtranslateプレビューと数学的に100%一致する描画始点の算出
      const drawX = (300 - drawWidth) / 2 + (shiftX * r);
      const drawY = (300 - drawHeight) / 2 + (shiftY * r);

      // canvasに精密に切り出し描画
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/jpeg', 0.9); // 高画質JPEGで書き出して軽量化

      URL.revokeObjectURL(img.src);
    };
    img.onerror = (err) => reject(err);
  });
}

/**
 * 大きなトリミング調整専用ダイアログを表示し、円形のガイドを見ながら調整できるようにします（PC・スマホ双方に完全対応）
 */
export function showAvatarCropModal(file, onCropComplete) {
  let modal = document.getElementById('avatar-crop-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'avatar-crop-modal';
  
  // 画面中央に配置
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
    <div style="background: var(--bg-card, #fff); color: var(--text-color, #333); width: 90%; max-width: 380px; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">アバターの位置調整（トリミング）</h3>
      
      <!-- プレビュー枠：200px正方形の中に画像を置き、その上に透明な丸マスクを重ねる -->
      <div style="position: relative; width: 200px; height: 200px; margin: 0 auto; background: #eee; border: 1px solid #ccc; border-radius: 4px; overflow: hidden; display: flex; justify-content: center; align-items: center;">
        <img id="crop-modal-preview-img" style="position: absolute; transform-origin: center; max-width: none; max-height: none;" alt="Crop Preview">
        <!-- 丸い切り抜きガイドマスク（マスク外側を薄暗くするCSSデザイン） -->
        <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; box-shadow: inset 0 0 0 100px rgba(0,0,0,0.55); border-radius: 50%;"></div>
      </div>

      <!-- 位置・ズーム操作スライダー -->
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
        <button id="crop-modal-cancel-btn" style="background: none; border: 1px solid #ccc; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; color: inherit;">キャンセル</button>
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

  // 仮表示用のURL
  const imgUrl = URL.createObjectURL(file);
  previewImg.src = imgUrl;

  const updatePreview = () => {
    const z = zoomSlider.value;
    const x = shiftXSlider.value;
    const y = shiftYSlider.value;
    // CSSのズームと移動をハードウェアアクセラレーションして滑らかに同期
    previewImg.style.transform = `scale(${z / 100}) translate(${x}px, ${y}px)`;
  };

  // 画像自体の比率をロード時に計算し、アスペクト比に関わらずプレビューズレを完全に解消
  previewImg.onload = () => {
    const aspect = previewImg.naturalWidth / previewImg.naturalHeight;
    if (aspect > 1) {
      previewImg.style.height = '200px';
      previewImg.style.width = `${200 * aspect}px`;
    } else {
      previewImg.style.width = '200px';
      previewImg.style.height = `${200 / aspect}px`;
    }
    updatePreview();
  };

  zoomSlider.oninput = updatePreview;
  shiftXSlider.oninput = updatePreview;
  shiftYSlider.oninput = updatePreview;

  cancelBtn.onclick = () => {
    modal.remove();
    URL.revokeObjectURL(imgUrl);
  };

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

/**
 * Shows the Character Add/Edit Modal
 */
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

  // タグ（カンマ区切り）入力欄を、HTMLを変更せずJavaScriptで動的インジェクション
  let tagsInput = document.getElementById('char-tags-input');
  if (!tagsInput && categoryInput) {
    const parent = categoryInput.parentElement;
    const tagsRow = document.createElement('div');
    tagsRow.className = 'form-row';
    tagsRow.innerHTML = `
      <label>タグ (カンマ区切り)</label>
      <input type="text" id="char-tags-input" placeholder="例: 五等分の花嫁, アニメ">
    `;
    parent.after(tagsRow);
    tagsInput = document.getElementById('char-tags-input');
  }

  // 位置再調整ボタンをアップローダーの下に動的インジェクション
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

  // Reset fields
  nameInput.value = char ? char.name : '';
  if (categoryInput) categoryInput.value = char ? char.category || '' : '';
  if (tagsInput) tagsInput.value = char && char.tags ? char.tags.join(', ') : '';
  descInput.value = char ? char.description || '' : '';
  persInput.value = char ? char.personality || '' : '';
  exInput.value = char ? char.mes_example || '' : '';
  imgInput.value = '';
  previewImg.style.transform = 'none'; // CSS変形を一旦リセット
  if (adjustBtn) adjustBtn.style.display = 'none'; // 一旦隠す
  
  let currentAvatarAssetId = char ? char.avatarAssetId : '';
  previewImg.src = await getAvatarUrl(currentAvatarAssetId);

  titleEl.textContent = char ? 'キャラクター設定編集' : '新規キャラクター登録';

  // アップロードされた未トリミングの元ファイルをモーダルセッション内で保持
  let currentOriginalFile = null;

  imgInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      currentOriginalFile = file; // 元画像を保持
      showAvatarCropModal(file, (croppedBlob) => {
        newFileBlob = croppedBlob;
        previewImg.src = URL.createObjectURL(croppedBlob); // プレビュー更新
        if (adjustBtn) adjustBtn.style.display = 'inline-flex'; // 再調整を可能に
      });
    }
  };

  // 画像を再選択することなく、何度でも位置を再調整できるイベントバインド
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

  let newFileBlob = null;

  saveBtn.onclick = async () => {
    if (!nameInput.value.trim()) {
      alert('キャラクター名を入力してください。');
      return;
    }

    try {
      // 保存
      if (newFileBlob) {
        if (currentAvatarAssetId) {
          await db.deleteAsset(currentAvatarAssetId);
        }
        currentAvatarAssetId = await db.saveAsset(newFileBlob, 'image/jpeg');
      }

      const characterData = {
        characterId: char ? char.characterId : undefined,
        name: nameInput.value.trim(),
        category: categoryInput ? categoryInput.value.trim() : '',
        tags: tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t.length > 0) : [], // タグ配列を追加
        avatarAssetId: currentAvatarAssetId,
        description: descInput.value.trim(),
        personality: persInput.value.trim(),
        mes_example: exInput.value.trim()
      };

      await db.saveCharacter(characterData);
      
      // 保存完了時にState側のキャラクター一覧を即時同期
      const updatedChars = await db.getCharacters();
      updateState({ characters: updatedChars });

      modal.classList.add('hidden');
      renderCharacterLibrary();
      renderSidebar();
    } catch (err) {
      alert(`保存に失敗しました: ${err.message}`);
    }
  };

  modal.classList.remove('hidden');
}

/**
 * Handles character exporting as base64-encoded JSON.
 */
async function exportCharacterJSON(char) {
  try {
    const exportObj = {
      spec: 'zetatavern-character',
      version: 1,
      name: char.name,
      category: char.category || '',
      tags: char.tags || [],
      description: char.description || '',
      personality: char.personality || '',
      mes_example: char.mes_example || '',
      avatarBase64: ''
    };

    if (char.avatarAssetId) {
      const blob = await db.getAssetBlob(char.avatarAssetId);
      if (blob) {
        exportObj.avatarBase64 = await db.blobToBase64(blob);
      }
    }

    const jsonStr = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${char.name}_card.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`エクスポートに失敗しました: ${err.message}`);
  }
}

/**
 * Handles character importing from JSON
 */
export async function importCharacterJSON(file) {
  try {
    const text = await file.text();
    const importObj = JSON.parse(text);

    if (importObj.spec !== 'zetatavern-character') {
      throw new Error('サポートされていないファイル形式です。(ZetaTavernキャラクターJSONではありません)');
    }

    let avatarAssetId = '';
    if (importObj.avatarBase64) {
      const blob = db.base64ToBlob(importObj.avatarBase64);
      avatarAssetId = await db.saveAsset(blob, blob.type);
    }

    const charData = {
      name: importObj.name,
      category: importObj.category || '',
      tags: importObj.tags || [],
      description: importObj.description,
      personality: importObj.personality,
      mes_example: importObj.mes_example,
      avatarAssetId: avatarAssetId
    };

    await db.saveCharacter(charData);

    // インポート完了時にStateを同期
    const updatedChars = await db.getCharacters();
    updateState({ characters: updatedChars });

    renderCharacterLibrary();
    renderSidebar();
    alert(`キャラクター「${charData.name}」を取り込みました。`);
  } catch (err) {
    alert(`取り込みに失敗しました: ${err.message}`);
  }
}

/**
 * スマホ・PC双方に対応したストーリー設定（主人公・世界観・プロンプト・ストーリータグ・主人公大画面トリミング）の編集モーダルを動的に生成・表示します。
 */
export async function showStorySettingsModal() {
  const { currentStory } = getState();
  if (!currentStory) return;

  // 重複防止のため、既存のモーダルがあれば削除
  let modal = document.getElementById('story-settings-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'story-settings-modal';
  
  const pAvatarUrl = await getAvatarUrl(currentStory.protagonist?.avatarAssetId);

  // CSSを追加せずにスタイルを完全保証するため、インラインスタイルを適用
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
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #333); width: 90%; max-width: 550px; max-height: 85vh; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,0.15); overflow: hidden;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 10px; margin-bottom: 16px;">
        <h3 style="margin: 0;">ストーリー設定</h3>
        <button id="story-settings-close-btn" style="background: none; border: none; font-size: 24px; cursor: pointer; color: inherit;">&times;</button>
      </div>
      
      <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding-right: 4px;">
        
        <!-- 主人公の設定 -->
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
              <input type="text" id="story-p-name-input" value="${escapeHTML(currentStory.protagonist?.name || '')}" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
            </div>
          </div>
          <div id="story-p-adjust-btn-container" style="text-align: left; margin-bottom: 8px;"></div>
          
          <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 8px;">
            <label style="font-size: 11px; font-weight: bold;">詳細・性格・容姿</label>
            <textarea id="story-p-desc-input" rows="2" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; box-sizing: border-box;">${escapeHTML(currentStory.protagonist?.description || '')}</textarea>
          </div>
        </fieldset>

        <!-- 世界観の設定 -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">世界観設定・あらすじ</label>
          <textarea id="story-world-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; box-sizing: border-box;" placeholder="例：一般的な日常世界です。">${escapeHTML(currentStory.worldPrompt || '')}</textarea>
        </div>

        <!-- ストーリータグの設定（追加） -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーのタグ (カンマ区切り)</label>
          <input type="text" id="story-tags-input" value="${escapeHTML(currentStory.tags ? currentStory.tags.join(', ') : '')}" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;" placeholder="例: 五等分の花嫁, ラブコメ">
        </div>

        <!-- 執筆ルールの設定 -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーテラーへの指示（執筆ルール）</label>
          <textarea id="story-prompt-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; box-sizing: border-box;" placeholder="空欄の場合、デフォルトのチャットロールプレイ最適化ルールが適用されます。">${escapeHTML(currentStory.storytellerPrompt || '')}</textarea>
        </div>

      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; border-top: 1px solid var(--border-color, #eee); padding-top: 12px;">
        <button id="story-settings-cancel-btn" class="secondary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">キャンセル</button>
        <button id="story-settings-save-btn" class="primary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">設定を保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // イベントリスナーの設定
  const closeBtn = modal.querySelector('#story-settings-close-btn');
  const cancelBtn = modal.querySelector('#story-settings-cancel-btn');
  const saveBtn = modal.querySelector('#story-settings-save-btn');
  const avatarInput = modal.querySelector('#story-p-avatar-input');
  const avatarPreview = modal.querySelector('#story-p-avatar-preview');
  const adjustBtnContainer = modal.querySelector('#story-p-adjust-btn-container');

  const closeModal = () => modal.remove();
  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;

  // 主人公用のアバター画像選択時：大画面クロッパーを割り当て
  let newAvatarBlob = null;
  let currentOriginalFile = null;

  // 「位置を再調整」ボタンの動的追加
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
      currentOriginalFile = file; // 元画像をセッション内に保持
      showAvatarCropModal(file, (croppedBlob) => {
        newAvatarBlob = croppedBlob;
        avatarPreview.src = URL.createObjectURL(croppedBlob);
        adjustBtn.style.display = 'inline-flex'; // 再調整可能に
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
    const world = modal.querySelector('#story-world-input').value.trim();
    const promptText = modal.querySelector('#story-prompt-input').value.trim();
    const tagsText = modal.querySelector('#story-tags-input').value.trim();

    try {
      let avatarAssetId = currentStory.protagonist?.avatarAssetId || '';
      if (newAvatarBlob) {
        if (avatarAssetId) {
          await db.deleteAsset(avatarAssetId);
        }
        avatarAssetId = await db.saveAsset(newAvatarBlob, 'image/jpeg');
      }

      currentStory.protagonist = {
        name: name || '主人公',
        description: desc,
        avatarAssetId: avatarAssetId
      };
      currentStory.worldPrompt = world;
      currentStory.storytellerPrompt = promptText;
      
      // カンマ区切りのテキストをパースしてタグ配列に変換して保存
      currentStory.tags = tagsText ? tagsText.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

      await db.saveStory(currentStory);
      
      // 保存完了時にState側の物語一覧データを同期する
      const updatedStories = await db.getStories();
      updateState({ stories: updatedStories });

      closeModal();
      
      // UIの再レンダリング
      renderStoryList();
      renderSidebar();
      renderStory();
    } catch (err) {
      alert(`保存に失敗しました: ${err.message}`);
    }
  };
}

/**
 * フォントサイズをCSS変数経由で一括変更し、上書きの競合を完全に防ぎます。
 */
export function applyFontSize(size) {
  const numSize = parseFloat(size) || 15;
  const root = document.documentElement;
  root.style.setProperty('--chat-font-size', `${numSize}px`);
  root.style.setProperty('--narration-font-size', `${numSize - 0.5}px`);
  root.style.setProperty('--ui-font-size', `${numSize - 2}px`);
}

/**
 * 地の文（ナレーション）の背景色・文字色・不透明度をCSS変数に注入します。
 */
export function applyNarrationStyles(bgColor, textColor, opacityPercent) {
  const root = document.documentElement;
  
  let finalBg = bgColor || '#f3f5f8';
  // HEX値をRGBAに変換して不透明度を反映
  if (opacityPercent !== undefined && finalBg.startsWith('#') && finalBg.length === 7) {
    const r = parseInt(finalBg.slice(1, 3), 16) || 243;
    const g = parseInt(finalBg.slice(3, 5), 16) || 245;
    const b = parseInt(finalBg.slice(5, 7), 16) || 248;
    finalBg = `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
  }
  
  root.style.setProperty('--narration-bg', finalBg);
  root.style.setProperty('--narration-text', textColor || '#323232');
}

// ────────────────────────────────────────────────────────
// 3. 視認性・可読性・スマホ特化レイアウト調整用CSSの自動注入
// ────────────────────────────────────────────────────────
const styleInject = document.createElement('style');
styleInject.textContent = `
  /* CSS変数による一括フォント・ナレーション設定 */
  :root {
    --chat-font-size: 15px;
    --narration-font-size: 14.5px;
    --ui-font-size: 13px;
    
    --narration-bg: rgba(243, 245, 248, 0.8);
    --narration-text: #323232;
  }

  /* フォントサイズ設定の強制上書き */
  .chat-speech, .novel-block, .chat-bubble p {
    font-size: var(--chat-font-size) !important;
  }
  .narration-content, .chat-narration {
    font-size: var(--narration-font-size) !important;
  }
  .chat-sender-name, .novel-action-badge {
    font-size: var(--ui-font-size) !important;
  }

  /* ナレーター（地の文）の開始ライン・横幅を「会話の吹き出し」と完全に同期 */
  .chat-narration {
    display: flex;
    justify-content: flex-start;
    width: 100%;
    box-sizing: border-box;
    margin: 14px 0 !important;
  }
  
  .narration-content {
    /* 吹き出しのテキスト左端ライン（アバター50px + 隙間12px = 62px）に完全に揃えます */
    padding-left: 62px !important;
    padding-right: 16px !important;
    padding-top: 8px !important;
    padding-bottom: 8px !important;
    width: 100%;
    max-width: 82% !important; /* 吹き出しと同じ最大幅に制限 */
    box-sizing: border-box !important;
    line-height: 1.75 !important;
    letter-spacing: 0.03em !important;
    color: var(--narration-text) !important;
    background-color: var(--narration-bg) !important;
    border-left: 4px solid var(--primary-color, #4a90e2) !important;
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.01);
  }
  
  .narration-content p {
    margin: 0 !important;
  }

  /* セリフ吹き出し内の行間・可読性も調整 */
  .chat-bubble p {
    line-height: 1.65 !important;
    margin-bottom: 8px !important;
  }
  .chat-bubble p:last-child {
    margin-bottom: 0 !important;
  }

  /* PC・タブレットサイズ時のチャット画面中央寄せ・カラム最大幅制限（ライン崩れ完全対策） */
  @media (min-width: 1024px) {
    .timeline-container {
      max-width: 800px !important;
      margin: 0 auto !important;
      width: 100% !important;
      display: flex !important;
      flex-direction: column !important;
      box-sizing: border-box !important;
    }
    
    /* タイムラインに薄い境界線と専用背景色をつけて視覚的な読みやすさを劇的に向上 */
    #story-viewport {
      border-left: 1px solid var(--border-color, #eee) !important;
      border-right: 1px solid var(--border-color, #eee) !important;
      background-color: var(--bg-viewport, #fafafa) !important;
    }
  }

  /* スマートフォン専用：可読性マージン調整 & ナレーター余白ラインをモバイルアバター幅に同期 */
  @media (max-width: 1023px) {
    #story-viewport {
      padding: 12px 8px !important;
    }
    .chat-message {
      margin-bottom: 14px !important;
      gap: 8px !important;
    }
    .chat-avatar {
      width: 40px !important;
      height: 40px !important;
    }
    .chat-bubble {
      padding: 10px 12px !important;
      max-width: 82% !important;
    }
    .narration-content {
      /* モバイルでのアバター幅(40px) + 隙間(8px) = 48px に同期して左端を会話と一直線にします */
      padding-left: 48px !important;
      max-width: 95% !important;
      font-size: 0.95em !important;
    }
  }

  /* ダークモード時のナレーター可読性補正 */
  @media (prefers-color-scheme: dark) {
    .chat-narration {
      color: rgba(225, 228, 232, 0.95) !important;
      background-color: rgba(30, 34, 42, 0.7) !important;
      border-left: 4px solid var(--primary-light, #64b5f6) !important;
    }
  }
`;
document.head.appendChild(styleInject);
