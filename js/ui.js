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

export async function getAvatarUrl(assetId) {
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

export function clearBlobUrlCache() {
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  blobUrlCache.clear();
}

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

  return { bodyText: text, choices: [] };
}

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

    const structuredDialogueMatch = trimmed.match(/^\[([^\]]+)\]\s*(「[^」]+」|.*)$/);
    if (structuredDialogueMatch) {
      flushNarration();
      flushDialogue();

      const speaker = structuredDialogueMatch[1].trim();
      const dialogueText = structuredDialogueMatch[2].trim();

      if (speaker === 'ナレーター' || speaker === 'システム' || speaker === '背景' || speaker === 'ナレーション') {
        segments.push({ type: 'narration', text: dialogueText });
        continue;
      }

      currentDialogue = {
        type: 'dialogue',
        speaker: speaker,
        lines: [{ kind: 'speech', text: dialogueText }]
      };
      flushDialogue();
      continue;
    }

    const isAction = /^\*(.+)\*$/.test(trimmed) || /^＊(.+)＊$/.test(trimmed);
    if (isAction) {
      const actionText = trimmed.replace(/^\*|\*$/g, '').replace(/^＊|＊$/g, '').trim();
      
      if (currentDialogue) {
        currentDialogue.lines.push({ kind: 'action', text: actionText });
      } else {
        flushNarration();
        segments.push({ type: 'narration', text: `*${actionText}*` });
      }
      continue;
    }

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

    narrationBuffer.push(line);
  }

  flushNarration();
  flushDialogue();

  return segments.length > 0 ? segments : [{ type: 'narration', text: text }];
}

function matchCharacterByName(speakerName, characters) {
  if (!speakerName || !characters || characters.length === 0) return null;
  const normalised = speakerName.trim();

  let match = characters.find(c => c.name === normalised);
  if (match) return match;

  match = characters.find(c =>
    c.name.includes(normalised) || normalised.includes(c.name)
  );
  if (match) return match;

  return null;
}

export function isCharacterMatchingStory(char, story) {
  if (!story) return false;
  const storyTags = story.tags || [];
  if (storyTags.length === 0) return true;

  const charCategory = char.category || '';
  const charTags = char.tags || [];

  const matchCategory = storyTags.includes(charCategory);
  const matchTags = charTags.some(tag => storyTags.includes(tag));

  return matchCategory || matchTags;
}

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
  
  const lastMsg = messages[messages.length - 1];
  const lastIsModel = lastMsg && lastMsg.role === 'model';
  
  let parsedLast = { bodyText: '', choices: [] };
  if (lastIsModel) {
    parsedLast = parseChoices(lastMsg.content);
  }

  const characters = uiMode === 'chat' ? await db.getCharacters() : [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;
    const isModel = msg.role === 'model';
    const textToRender = (isLast && isModel) ? parsedLast.bodyText : msg.content;

    if (uiMode === 'chat') {
      if (isModel) {
        const segments = parseModelOutputToSegments(textToRender);
        for (const seg of segments) {
          if (seg.type === 'narration') {
            const narEl = document.createElement('div');
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
            const protagonistName = currentStory.protagonist?.name || '主人公';
            const isProtagonist = (seg.speaker === protagonistName || seg.speaker === '主人公');

            let avatarUrl = 'assets/default-silhouette.png';
            let roleClass = 'bot-role';

            if (isProtagonist) {
              roleClass = 'user-role';
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

    const cancelBtn = loader.querySelector('#cancel-generation-btn');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        const { activeAbortController } = getState();
        if (activeAbortController) {
          activeAbortController.abort();
        }
      };
    }
  }

  container.scrollTop = container.scrollHeight;
  renderChoiceButtons(parsedLast.choices);
}

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
      const textToSend = `${choice.label}. ${choice.text}`;
      window.dispatchEvent(new CustomEvent('submitUserAction', { detail: textToSend }));
    };
    choicesContainer.appendChild(btn);
  });
}

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
  
  const allCharacters = await db.getCharacters();
  const characters = allCharacters.filter(char => isCharacterMatchingStory(char, currentStory));

  let html = `
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
  bindSidebarEvents();
}

function bindSidebarEvents() {
  const { currentStory } = getState();
  if (!currentStory) return;

  const saveStateChanges = () => {
    db.saveStory(currentStory).then(async () => {
      const stories = await db.getStories();
      updateState({ stories });
      window.dispatchEvent(new CustomEvent('storyDataUpdated'));
    });
  };

  const pCard = document.querySelector('.sidebar-protagonist-card');
  if (pCard) {
    pCard.onclick = () => {
      showStorySettingsModal();
    };
  }

  const locInput = document.getElementById('scene-location-input');
  const timeInput = document.getElementById('scene-time-input');
  const atmosInput = document.getElementById('scene-atmosphere-input');
  const objInput = document.getElementById('scene-objective-input');

  if (locInput) locInput.oninput = (e) => { currentStory.sceneState.location = e.target.value; saveStateChanges(); };
  if (timeInput) timeInput.oninput = (e) => { currentStory.sceneState.timeOfDay = e.target.value; saveStateChanges(); };
  if (atmosInput) atmosInput.oninput = (e) => { currentStory.sceneState.atmosphere = e.target.value; saveStateChanges(); };
  if (objInput) objInput.oninput = (e) => { currentStory.sceneState.currentObjective = e.target.value; saveStateChanges(); };

  document.querySelectorAll('.char-attendance-select').forEach(select => {
    select.onchange = (e) => {
      const charId = e.target.dataset.charId;
      const role = e.target.value;
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

  document.querySelectorAll('.char-affinity-range').forEach(range => {
    range.oninput = (e) => {
      const charId = e.target.dataset.charId;
      const val = parseInt(e.target.value);
      const label = e.target.previousElementSibling;
      label.textContent = `好感度 (${val})`;

      if (!currentStory.relationshipMemory) currentStory.relationshipMemory = {};
      if (!currentStory.relationshipMemory[charId]) currentStory.relationshipMemory[charId] = { affinity: 50, notes: '' };
      
      currentStory.relationshipMemory[charId].affinity = val;
      saveStateChanges();
    };
  });

  document.querySelectorAll('.char-status-input').forEach(input => {
    input.oninput = (e) => {
      const charId = e.target.dataset.charId;
      if (!currentStory.characterMemory) currentStory.characterMemory = {};
      if (!currentStory.characterMemory[charId]) currentStory.characterMemory[charId] = { status: '', shortTermGoal: '', location: '' };
      currentStory.characterMemory[charId].status = e.target.value;
      saveStateChanges();
    };
  });

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

export async function renderStoryList() {
  const container = document.getElementById('stories-list-container');
  if (!container) return;

  container.innerHTML = '';
  const stories = await db.getStories();
  const current = getState().currentStory;

  stories.sort((a, b) => b.timestamp - a.timestamp);

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
      document.getElementById('mobile-drawer')?.classList.remove('open');
    };

    container.appendChild(el);
  });
}

export async function renderCharacterLibrary() {
  const container = document.getElementById('library-viewport');
  if (!container) return;

  container.innerHTML = '';
  const characters = await db.getCharacters();

  const searchInput = document.getElementById('library-search-input');
  const filterSelect = document.getElementById('library-filter-select');
  const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const filterMode = filterSelect ? filterSelect.value : 'all';

  const categories = new Set();
  characters.forEach(c => {
    if (c.category) categories.add(c.category);
  });

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

  const { currentStory } = getState();
  const inStoryCharIds = new Set();
  if (currentStory && currentStory.characters) {
    currentStory.characters.forEach(c => {
      if (c.attendance && c.attendance !== 'absent') {
        inStoryCharIds.add(c.characterId);
      }
    });
  }

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

  const addCard = document.createElement('div');
  addCard.className = 'char-card add-card';
  addCard.innerHTML = `
    <span class="material-symbols-outlined add-icon">person_add</span>
    <strong>新しいキャラクター</strong>
  `;
  addCard.onclick = () => showCharacterModal();
  container.appendChild(addCard);

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

export function cropImageToSquareBlob(file, zoomPercent, shiftX, shiftY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 300; 
      canvas.height = 300;
      const ctx = canvas.getContext('2d');

      const r = 300 / 200; 
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

      const drawWidth = baseWidth * scale * r;
      const drawHeight = baseHeight * scale * r;

      const drawX = (300 - drawWidth) / 2 + (shiftX * r);
      const drawY = (300 - drawHeight) / 2 + (shiftY * r);

      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/jpeg', 0.9);

      URL.revokeObjectURL(img.src);
    };
    img.onerror = (err) => reject(err);
  });
}

export function showAvatarCropModal(file, onCropComplete) {
  let modal = document.getElementById('avatar-crop-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'avatar-crop-modal';
  
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
      
      <div style="position: relative; width: 200px; height: 200px; margin: 0 auto; background: #eee; border: 1px solid #ccc; border-radius: 4px; overflow: hidden; display: flex; justify-content: center; align-items: center;">
        <img id="crop-modal-preview-img" style="position: absolute; transform-origin: center; max-width: none; max-height: none;" alt="Crop Preview">
        <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; box-shadow: inset 0 0 0 100px rgba(0,0,0,0.55); border-radius: 50%;"></div>
      </div>

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

  const imgUrl = URL.createObjectURL(file);
  previewImg.src = imgUrl;

  const updatePreview = () => {
    const z = zoomSlider.value;
    const x = shiftXSlider.value;
    const y = shiftYSlider.value;
    previewImg.style.transform = `scale(${z / 100}) translate(${x}px, ${y}px)`;
  };

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

  nameInput.value = char ? char.name : '';
  if (categoryInput) categoryInput.value = char ? char.category || '' : '';
  if (tagsInput) tagsInput.value = char && char.tags ? char.tags.join(', ') : '';
  descInput.value = char ? char.description || '' : '';
  persInput.value = char ? char.personality || '' : '';
  exInput.value = char ? char.mes_example || '' : '';
  imgInput.value = '';
  previewImg.style.transform = 'none'; 
  if (adjustBtn) adjustBtn.style.display = 'none'; 
  
  let currentAvatarAssetId = char ? char.avatarAssetId : '';
  previewImg.src = await getAvatarUrl(currentAvatarAssetId);

  titleEl.textContent = char ? 'キャラクター設定編集' : '新規キャラクター登録';

  let currentOriginalFile = null;
  let newFileBlob = null;

  imgInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      currentOriginalFile = file; 
      showAvatarCropModal(file, (croppedBlob) => {
        newFileBlob = croppedBlob;
        previewImg.src = URL.createObjectURL(croppedBlob); 
        if (adjustBtn) adjustBtn.style.display = 'inline-flex'; 
      });
    }
  };

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

  saveBtn.onclick = async () => {
    if (!nameInput.value.trim()) {
      alert('キャラクター名を入力してください。');
      return;
    }

    try {
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
        tags: tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(t => t.length > 0) : [],
        avatarAssetId: currentAvatarAssetId,
        description: descInput.value.trim(),
        personality: persInput.value.trim(),
        mes_example: exInput.value.trim()
      };

      await db.saveCharacter(characterData);
      
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

    const updatedChars = await db.getCharacters();
    updateState({ characters: updatedChars });

    renderCharacterLibrary();
    renderSidebar();
    alert(`キャラクター「${charData.name}」を取り込みました。`);
  } catch (err) {
    alert(`取り込みに失敗しました: ${err.message}`);
  }
}

export async function showStorySettingsModal() {
  const { currentStory } = getState();
  if (!currentStory) return;

  let modal = document.getElementById('story-settings-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'story-settings-modal';
  
  const pAvatarUrl = await getAvatarUrl(currentStory.protagonist?.avatarAssetId);

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

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">世界観設定・あらすじ</label>
          <textarea id="story-world-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; box-sizing: border-box;" placeholder="例：一般的な日常世界です。">${escapeHTML(currentStory.worldPrompt || '')}</textarea>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーのタグ (カンマ区切り)</label>
          <input type="text" id="story-tags-input" value="${escapeHTML(currentStory.tags ? currentStory.tags.join(', ') : '')}" style="width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;" placeholder="例: 五等分の花嫁, ラブコメ">
        </div>

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

  const closeBtn = modal.querySelector('#story-settings-close-btn');
  const cancelBtn = modal.querySelector('#story-settings-cancel-btn');
  const saveBtn = modal.querySelector('#story-settings-save-btn');
  const avatarInput = modal.querySelector('#story-p-avatar-input');
  const avatarPreview = modal.querySelector('#story-p-avatar-preview');
  const adjustBtnContainer = modal.querySelector('#story-p-adjust-btn-container');

  const closeModal = () => modal.remove();
  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;

  let newAvatarBlob = null;
  let currentOriginalFile = null;

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
      currentOriginalFile = file; 
      showAvatarCropModal(file, (croppedBlob) => {
        newAvatarBlob = croppedBlob;
        avatarPreview.src = URL.createObjectURL(croppedBlob);
        adjustBtn.style.display = 'inline-flex'; 
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
      
      currentStory.tags = tagsText ? tagsText.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

      await db.saveStory(currentStory);
      
      const updatedStories = await db.getStories();
      updateState({ stories: updatedStories });

      closeModal();
      
      renderStoryList();
      renderSidebar();
      renderStory();
    } catch (err) {
      alert(`保存に失敗しました: ${err.message}`);
    }
  };
}

export function applyFontSize(size) {
  const numSize = parseFloat(size) || 15;
  const root = document.documentElement;
  root.style.setProperty('--chat-font-size', `${numSize}px`);
  root.style.setProperty('--narration-font-size', `${Math.max(10, numSize - 0.5)}px`);
  root.style.setProperty('--ui-font-size', `${Math.max(10, numSize - 2)}px`);
}

export function applyNarrationStyles(bgColor, textColor, opacityPercent) {
  const root = document.documentElement;
  
  let finalBg = bgColor || '#f3f5f8';
  if (opacityPercent !== undefined && finalBg.startsWith('#') && finalBg.length === 7) {
    const r = parseInt(finalBg.slice(1, 3), 16) || 243;
    const g = parseInt(finalBg.slice(3, 5), 16) || 245;
    const b = parseInt(finalBg.slice(5, 7), 16) || 248;
    finalBg = `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
  }
  
  root.style.setProperty('--narration-bg', finalBg);
  root.style.setProperty('--narration-text', textColor || '#323232');
}

const styleInject = document.createElement('style');
styleInject.textContent = `
  :root {
    --chat-font-size: 15px;
    --narration-font-size: 14.5px;
    --ui-font-size: 13px;
    
    --narration-bg: rgba(243, 245, 248, 0.8);
    --narration-text: #323232;
  }

  .chat-speech, .novel-block, .chat-bubble p {
    font-size: var(--chat-font-size) !important;
  }
  .narration-content, .chat-narration {
    font-size: var(--narration-font-size) !important;
  }
  .chat-sender-name, .novel-action-badge {
    font-size: var(--ui-font-size) !important;
  }

  .chat-narration {
    display: flex;
    justify-content: flex-start;
    width: 100%;
    box-sizing: border-box;
    margin: 14px 0 !important;
  }
  
  .narration-content {
    padding-left: 62px !important;
    padding-right: 16px !important;
    padding-top: 8px !important;
    padding-bottom: 8px !important;
    width: 100%;
    max-width: 82% !important; 
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

  .chat-bubble p {
    line-height: 1.65 !important;
    margin-bottom: 8px !important;
  }
  .chat-bubble p:last-child {
    margin-bottom: 0 !important;
  }

 @media (min-width: 1024px) {
    .timeline-container {
      max-width: 800px !important;
      margin: 0 auto !important;
      width: 100% !important;
      display: flex !important;
      flex-direction: column !important;
      box-sizing: border-box !important;
    }
    
    #story-viewport {
      /* 背景色の強制上書きを削除し、元の黒（テーマ色）に戻します */
      border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)) !important;
      border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)) !important;
    }
  }

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
      padding-left: 48px !important;
      max-width: 95% !important;
      font-size: 0.95em !important;
    }
  }

  @media (prefers-color-scheme: dark) {
    .chat-narration {
      color: rgba(225, 228, 232, 0.95) !important;
      background-color: rgba(30, 34, 42, 0.7) !important;
      border-left: 4px solid var(--primary-light, #64b5f6) !important;
    }
  }
`;
document.head.appendChild(styleInject);
