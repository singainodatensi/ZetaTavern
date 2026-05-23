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

  // カテゴリー、またはキャラクター自身に登録された個別タグが, ストーリータグに含まれているか確認
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

  // ★ 修正：awaitを追加し、非同期のキャラクターリストを完全に解決
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

      // ズーム値を反映したソース切り出し窓のサイズ（ズームするほど切り出す範囲は狭くなる）
      const baseSize = Math.min(img.width, img.height);
      const sourceSize = baseSize / (zoomPercent / 100);

      // 中心位置を起点としたピクセル単位のシフト量を算出
      const offsetX = (img.width - sourceSize) / 2 + (shiftX * (sourceSize / 200));
      const offsetY = (img.height - sourceSize) / 2 + (shiftY * (sourceSize / 200));

      // canvasに綺麗に描画
      ctx.drawImage(
        img,
        offsetX, offsetY, sourceSize, sourceSize, // ソース画像領域
        0, 0, 300, 300                            // 描画先キャンバス領域
      );

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
        <img id="crop-modal-preview-img" style="position: absolute; transform-origin: center; max-width: none; max-height: none; width: 100%; height: 100%; object-fit: contain;">
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
    previewImg.style.transform = `scale(${z / 100}) translate(${-x / 2}%, ${-y / 2}%)`;
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

  // Reset fields
  nameInput.value = char ? char.name : '';
  if (categoryInput) categoryInput.value = char ? char.category || '' : '';
  if (tagsInput) tagsInput.value = char && char.tags ? char.tags.join(', ') : '';
  descInput.value = char ? char.description || '' : '';
  persInput.value = char ? char.personality || '' : '';
  exInput.value = char ? char.mes_example || '' : '';
  imgInput.value = '';
  previewImg.style.transform = 'none'; // CSS変形を一旦リセット
  
  let currentAvatarAssetId = char ? char.avatarAssetId : '';
  previewImg.src = await getAvatarUrl(currentAvatarAssetId);

  titleEl.textContent = char ? 'キャラクター設定編集' : '新規キャラクター登録';

  // 画像アップロード選択時：大画面トリミングモーダルを割り当ててポップアップ表示
  let newFileBlob = null;
  imgInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      showAvatarCropModal(file, (croppedBlob) => {
        newFileBlob = croppedBlob;
        previewImg.src = URL.createObjectURL(croppedBlob); // 綺麗にトリミングされた画像プレビュー
      });
    }
  };

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

  const closeModal = () => modal.remove();
  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;

  // 主人公用のアバター画像選択時：大画面クロッパーを割り当て
  let newAvatarBlob = null;
  avatarInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      showAvatarCropModal(file, (croppedBlob) => {
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
export function applyFontSize(sizeClass) {
  let chatSize = '15px';
  let narrationSize = '14.5px';
  let uiSize = '13px';

  if (sizeClass === 'small') {
    chatSize = '13px';
    narrationSize = '12.5px';
    uiSize = '11px';
  } else if (sizeClass === 'large') {
    chatSize = '18px';
    narrationSize = '17px';
    uiSize = '15px';
  }

  const root = document.documentElement;
  root.style.setProperty('--chat-font-size', chatSize);
  root.style.setProperty('--narration-font-size', narrationSize);
  root.style.setProperty('--ui-font-size', uiSize);
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
