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
    ui.re
