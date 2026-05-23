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
 *
 * 厳密な [キャラクター名] 記法と、従来のヒューリスティック判定の双方に対応したハイブリッドパーサー。
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

      // ナレーターやシステム用の出力は、吹き出し無しの地の文（narration）として扱う
      if (speaker === 'ナレーター' || speaker === 'システム' || speaker === '背景' || speaker === 'ナレーション') {
        segments.push({ type: 'narration', text: dialogueText });
        continue;
      }

      currentDialogue = {
        type: 'dialogue',
        speaker: speaker,
        lines: [{ kind: 'speech', text: dialogueText }]
      };
      flushDialogue(); // 1セリフごとに単一の吹き出しとして完結させる
      continue;
    }

    // ────────────────────────────────────────────────────────
    // ルール B: 新しい明示的な動作描写・地の文 *動作* 
    // ────────────────────────────────────────────────────────
    const isAction = /^\*(.+)\*$/.test(trimmed) || /^＊(.+)＊$/.test(trimmed);
    if (isAction) {
      const actionText = trimmed.replace(/^\*|\*$/g, '').replace(/^＊|＊$/g, '').trim();
      
      // 直前が会話であれば、その会話ブロックの中の「動作」として追加する
      if (currentDialogue) {
        currentDialogue.lines.push({ kind: 'action', text: actionText });
      } else {
        // そうでなければ単体の動作ナレーションとして書き出す
        flushNarration();
        segments.push({ type: 'narration', text: `*${actionText}*` });
      }
      continue;
    }

    // ────────────────────────────────────────────────────────
    // ルール C: 旧ヒューリスティック判定（過去のログ表示や、AIの出力微ブレ時のフォールバック用）
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

    // いずれにも当てはまらない場合はナレーション（地の文）
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
            narEl.className = 'chat-narration';
            let html = '';
            if (window.marked && typeof window.marked.parse === 'function') {
              html = sanitizeHTML(window.marked.parse(seg.text));
            } else {
              html = sanitizeHTML(seg.text.replace(/\n/g, '<br>'));
            }
            narEl.innerHTML = `<div class="narration-content">${html}</div>`;
            container.appendChild(narEl);
        } else if (seg.type === 'dialogue') {
            // 話し手が「主人公」本人かどうか判定（設定された主人公名、または「主人公」という文字列に合致するか）
            const protagonistName = currentStory.protagonist?.name || '主人公';
            const isProtagonist = (seg.speaker === protagonistName || seg.speaker === '主人公');

            let avatarUrl = 'assets/default-silhouette.png';
            let roleClass = 'bot-role'; // デフォルトは左側（他キャラクター）

            if (isProtagonist) {
              roleClass = 'user-role'; // 主人公であれば右側に配置
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

  // 停止ボタンのクリックイベントを結びつける
  const cancelBtn = loader.querySelector('#cancel-generation-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      const { activeAbortController } = getState();
      if (activeAbortController) {
        activeAbortController.abort(); // メインのコントローラーを中断させる
      }
    };
  }
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
  const characters = await db.getCharacters();

  let html = `
    <!-- Protagonist Profile Card -->
    <div class="sidebar-section">
      <h4>主人公プロファイル</h4>
      <div class="sidebar-protagonist-card">
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
    html += `<p class="note">キャラクターライブラリにキャラクターが登録されていません。</p>`;
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
    db.saveStory(currentStory).then(() => {
      // Notify other modules of change if needed, but avoid full re-render of sidebar during active typing
      window.dispatchEvent(new CustomEvent('storyDataUpdated'));
    });
  };

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
      // スマホドロワーが開いていれば閉じる
      document.getElementById('mobile-drawer')?.classList.remove('open');
    };
    container.appendChild(settingsBtn);
  }

  stories.forEach(story => {
    const el = document.createElement('div');
    el.className = `story-list-item ${current && current.storyId === story.storyId ? 'active' : ''}`;
    
    // レイアウト崩れを防ぐため、テキストとアクション(編集・削除)をflexコンテナでグループ化します
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
      // 1. 名前変更ボタンがクリックされた場合の処理
      if (e.target.closest('.rename-story-btn')) {
        e.stopPropagation(); // 親要素のストーリー切り替えイベントを発火させない
        const oldTitle = story.title || '新しいストーリー';
        const newTitle = prompt('ストーリーの名前を変更:', oldTitle);
        
        if (newTitle !== null && newTitle.trim() !== '') {
          story.title = newTitle.trim();
          db.saveStory(story).then(() => {
            // もし名前を変更したストーリーが「現在のアクティブなストーリー」なら状態も更新する
            if (current && current.storyId === story.storyId) {
              setActiveStory(story);
            }
            renderStoryList();
          });
        }
        return;
      }

      // 2. 削除ボタンがクリックされた場合の処理
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
      
      // 3. 通常のストーリー選択処理
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

  // Rebuild filter options dynamically (keep "all" and "in-story", add categories)
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
      (c.personality || '').toLowerCase().includes(searchQuery)
    );
  }
  if (filterMode === 'in-story') {
    filtered = filtered.filter(c => inStoryCharIds.has(c.characterId));
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
    
    const categoryTag = char.category
      ? `<span class="char-card-tag">${escapeHTML(char.category)}</span>`
      : '';

    card.innerHTML = `
      <div class="char-card-avatar-wrapper">
        <img src="${avatarUrl}" alt="${char.name}">
      </div>
      <div class="char-card-details">
        <strong>${escapeHTML(char.name)}</strong>
        ${categoryTag}
        <p class="char-card-personality">${escapeHTML(char.personality || '個性未設定')}</p>
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
        db.deleteCharacter(char.characterId).then(() => {
          renderCharacterLibrary();
          renderSidebar();
        });
      }
    };

    container.appendChild(card);
  }
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

  // Reset fields
  nameInput.value = char ? char.name : '';
  if (categoryInput) categoryInput.value = char ? char.category || '' : '';
  descInput.value = char ? char.description || '' : '';
  persInput.value = char ? char.personality || '' : '';
  exInput.value = char ? char.mes_example || '' : '';
  imgInput.value = '';
  
  let currentAvatarAssetId = char ? char.avatarAssetId : '';
  previewImg.src = await getAvatarUrl(currentAvatarAssetId);

  titleEl.textContent = char ? 'キャラクター設定編集' : '新規キャラクター登録';

  // Temp holder for new selected file
  let newFileBlob = null;
  imgInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      newFileBlob = file;
      previewImg.src = URL.createObjectURL(file);
    }
  };

  saveBtn.onclick = async () => {
    if (!nameInput.value.trim()) {
      alert('キャラクター名を入力してください。');
      return;
    }

    try {
      // Save new image if uploaded
      if (newFileBlob) {
        // If editing, delete old asset first
        if (currentAvatarAssetId) {
          await db.deleteAsset(currentAvatarAssetId);
        }
        currentAvatarAssetId = await db.saveAsset(newFileBlob, newFileBlob.type);
      }

      const characterData = {
        characterId: char ? char.characterId : undefined,
        name: nameInput.value.trim(),
        category: categoryInput ? categoryInput.value.trim() : '',
        avatarAssetId: currentAvatarAssetId,
        description: descInput.value.trim(),
        personality: persInput.value.trim(),
        mes_example: exInput.value.trim()
      };

      await db.saveCharacter(characterData);
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
 * スマホ・PC双方に対応したストーリー設定（主人公・世界観・プロンプト）の編集モーダルを動的に生成・表示します。
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

  // CSSを追加せずにスタイルを完全保証するため、インラインスタイルを適用しています
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
              <img id="story-p-avatar-preview" src="${pAvatarUrl}" style="width: 70px; height: 70px; border-radius: 50%; object-fit: cover; border: 2px solid var(--primary-color, #4a90e2); display: block; margin-bottom: 4px;" alt="Avatar">
              <label for="story-p-avatar-input" style="font-size: 11px; cursor: pointer; color: var(--primary-color, #4a90e2); text-decoration: underline;">画像を変更</label>
              <input type="file" id="story-p-avatar-input" accept="image/*" style="display: none;">
            </div>
            <div style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
              <label style="font-size: 11px; font-weight: bold;">名前</label>
              <input type="text" id="story-p-name-input" value="${escapeHTML(currentStory.protagonist?.name || '')}" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 11px; font-weight: bold;">詳細・性格・容姿</label>
            <textarea id="story-p-desc-input" rows="2" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; box-sizing: border-box;">${escapeHTML(currentStory.protagonist?.description || '')}</textarea>
          </div>
        </fieldset>

        <!-- 世界観の設定 -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">世界観設定・あらすじ</label>
          <textarea id="story-world-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; box-sizing: border-box;" placeholder="例：一般的な日常世界です。">${escapeHTML(currentStory.worldPrompt || '')}</textarea>
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

  const closeModal = () => modal.remove();
  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;

  let newAvatarBlob = null;
  avatarInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      newAvatarBlob = file;
      avatarPreview.src = URL.createObjectURL(file);
    }
  };

  saveBtn.onclick = async () => {
    const name = modal.querySelector('#story-p-name-input').value.trim();
    const desc = modal.querySelector('#story-p-desc-input').value.trim();
    const world = modal.querySelector('#story-world-input').value.trim();
    const promptText = modal.querySelector('#story-prompt-input').value.trim();

    try {
      let avatarAssetId = currentStory.protagonist?.avatarAssetId || '';
      if (newAvatarBlob) {
        if (avatarAssetId) {
          await db.deleteAsset(avatarAssetId);
        }
        avatarAssetId = await db.saveAsset(newAvatarBlob, newAvatarBlob.type);
      }

      currentStory.protagonist = {
        name: name || '主人公',
        description: desc,
        avatarAssetId: avatarAssetId
      };
      currentStory.worldPrompt = world;
      currentStory.storytellerPrompt = promptText;

      await db.saveStory(currentStory);
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
      description: importObj.description,
      personality: importObj.personality,
      mes_example: importObj.mes_example,
      avatarAssetId: avatarAssetId
    };

    await db.saveCharacter(charData);
    renderCharacterLibrary();
    renderSidebar();
    alert(`キャラクター「${charData.name}」を取り込みました。`);
  } catch (err) {
    alert(`取り込みに失敗しました: ${err.message}`);
  }
}
