/**
 * ui.js - ZetaTavern UI Rendering & DOM Events
 * Controls screen views, renders stories (novel / chat mode with per-character bubbles),
 * handles settings/character libraries, and parses AI-generated A/B/C options.
 */

import { getState, updateState, setActiveStory, updateCharacterAttendance } from './state.js';
import * as db from './db.js';
import { sanitizeHTML, escapeHTML } from './sanitizer.js';

const blobUrlCache = new Map();

export async function getAvatarUrl(assetId) {
  if (!assetId) return 'assets/default-silhouette.png';
  if (blobUrlCache.has(assetId)) return blobUrlCache.get(assetId);
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
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
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
    if (joined) segments.push({ type: 'narration', text: joined });
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
      currentDialogue = { type: 'dialogue', speaker: speaker, lines: [{ kind: 'speech', text: dialogueText }] };
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
      trimmed.length > 0 && trimmed.length <= 30 &&
      !trimmed.includes('「') && !trimmed.startsWith('#') &&
      !trimmed.startsWith('*') && !trimmed.startsWith('―') &&
      !trimmed.startsWith('─') && !trimmed.startsWith('-') &&
      !trimmed.startsWith('>') && !/^[\s\d\.\-\*]+$/.test(trimmed)
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
  match = characters.find(c => c.name.includes(normalised) || normalised.includes(c.name));
  if (match) return match;
  return null;
}

export function isCharacterMatchingStory(char, story) {
  if (!story) return false;
  const storyTags = story.tags || [];
  if (storyTags.length === 0) return true;
  const charCategory = char.category || '';
  const charTags = char.tags || [];
  return storyTags.includes(charCategory) || charTags.some(tag => storyTags.includes(tag));
}

function getMentionQuery(textarea) {
  const caret = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, caret);
  const lineStart = Math.max(before.lastIndexOf('\n') + 1, 0);
  const line = before.slice(lineStart);
  const match = line.match(/(?:^|\s)(@:?\s*([^\s「」:：]*)?)$/);
  if (!match) return null;
  const token = match[1] || '@';
  return {
    query: (match[2] || '').trim(),
    start: caret - token.length,
    end: caret
  };
}

async function getMentionCandidates(query) {
  const { currentStory } = getState();
  const characters = await db.getCharacters();
  const storyIds = new Set((currentStory?.characters || [])
    .filter(ref => ref.attendance !== 'absent')
    .map(ref => ref.characterId));
  const protagonist = currentStory?.protagonist?.name
    ? [{ name: currentStory.protagonist.name, avatarAssetId: currentStory.protagonist.avatarAssetId, isProtagonist: true }]
    : [];

  const sorted = [
    ...protagonist,
    ...characters
      .map(char => ({ ...char, inStory: storyIds.has(char.characterId) }))
      .sort((a, b) => Number(b.inStory) - Number(a.inStory) || (a.name || '').localeCompare(b.name || '', 'ja'))
  ];

  const normalizedQuery = query.toLowerCase();
  return sorted
    .filter(char => {
      const haystack = `${char.name || ''} ${char.category || ''} ${(char.tags || []).join(' ')}`.toLowerCase();
      return !normalizedQuery || haystack.includes(normalizedQuery);
    })
    .slice(0, 8);
}

export function bindMentionAutocomplete(textarea) {
  if (!textarea || textarea.dataset.mentionBound === 'true') return;
  textarea.dataset.mentionBound = 'true';

  const popup = document.createElement('div');
  popup.id = 'mention-autocomplete';
  popup.className = 'mention-autocomplete hidden';
  textarea.closest('.input-panel-wrapper')?.appendChild(popup);

  let activeQuery = null;

  const hide = () => {
    popup.classList.add('hidden');
    popup.innerHTML = '';
    activeQuery = null;
  };

  const insertMention = (name) => {
    if (!activeQuery) return;
    const before = textarea.value.slice(0, activeQuery.start);
    const after = textarea.value.slice(activeQuery.end);
    const insertion = `@:${name}`;
    textarea.value = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    hide();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const refresh = async () => {
    const query = getMentionQuery(textarea);
    if (!query) {
      hide();
      return;
    }
    activeQuery = query;
    const candidates = await getMentionCandidates(query.query);
    if (candidates.length === 0) {
      hide();
      return;
    }

    popup.innerHTML = '';
    for (const candidate of candidates) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mention-candidate';
      const avatarUrl = await getAvatarUrl(candidate.avatarAssetId);
      btn.innerHTML = `
        <img src="${avatarUrl}" alt="">
        <span>${escapeHTML(candidate.name || '名前なし')}</span>
        ${candidate.inStory || candidate.isProtagonist ? '<small>登場中</small>' : ''}
      `;
      btn.onclick = () => insertMention(candidate.name || '');
      popup.appendChild(btn);
    }
    popup.classList.remove('hidden');
  };

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('keyup', refresh);
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('blur', () => setTimeout(hide, 160));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
    if (e.key === 'Tab' && !popup.classList.contains('hidden')) {
      const first = popup.querySelector('.mention-candidate');
      if (first) {
        e.preventDefault();
        first.click();
      }
    }
  });
}

export async function renderStory() {
  const container = document.getElementById('story-viewport');
  if (!container) return;

  container.innerHTML = '';
  const appState = getState();
  const { currentStory, uiMode, isGenerating, autoscrollEnabled } = appState;

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

    // メッセージとアクションボタンを包むラッパー
    const msgWrapper = document.createElement('div');
    msgWrapper.className = 'message-wrapper';

    const contentContainer = document.createElement('div');
    contentContainer.className = 'message-content-container';

    if (uiMode === 'chat') {
      if (isModel) {
        const segments = parseModelOutputToSegments(textToRender);
        for (const seg of segments) {
          if (seg.type === 'narration') {
            const narEl = document.createElement('div');
            narEl.className = 'chat-message narration-role'; 
            let html = window.marked && typeof window.marked.parse === 'function' 
              ? sanitizeHTML(window.marked.parse(seg.text)) 
              : sanitizeHTML(seg.text.replace(/\n/g, '<br>'));
            narEl.innerHTML = `
              <div class="chat-avatar" style="visibility: hidden; flex-shrink: 0;"></div>
              <div class="chat-content-wrapper">
                <div class="narration-content">${html}</div>
              </div>
            `;
            contentContainer.appendChild(narEl);
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
                linesHTML += `<p class="chat-speech">${escapeHTML(line.text)}</p>`;
              } else if (line.kind === 'action') {
                linesHTML += `<p class="chat-action"><em>*${escapeHTML(line.text)}*</em></p>`;
              }
            }
            msgEl.innerHTML = `
              <div class="chat-avatar"><img src="${avatarUrl}" alt="${escapeHTML(seg.speaker)}"></div>
              <div class="chat-content-wrapper" style="position: relative;">
                <span class="chat-sender-name">${escapeHTML(seg.speaker)}</span>
                <div class="chat-bubble" style="position: relative;">
                  ${linesHTML}
                  <button class="segment-edit-btn" title="この台詞を編集" style="position: absolute; right: -28px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; opacity: 0; transition: opacity 0.2s; display: flex; align-items: center; justify-content: center; color: var(--text-sub);"><span class="material-symbols-outlined" style="font-size:16px;">edit</span></button>
                </div>
              </div>
            `;
            // ホバー時に編集ボタンを表示
            const bubbleEl = msgEl.querySelector('.chat-bubble');
            const editBtn = msgEl.querySelector('.segment-edit-btn');
            if (bubbleEl && editBtn) {
              bubbleEl.addEventListener('mouseenter', () => editBtn.style.opacity = '1');
              bubbleEl.addEventListener('mouseleave', () => editBtn.style.opacity = '0');
              editBtn.onclick = () => showEditSegmentModal(i, seg);
            }
            contentContainer.appendChild(msgEl);
          }
        }
} else {
        // ユーザー入力を改行で分割し、「@:キャラクター名」の指定がある行と通常の行を仕分ける
        const lines = textToRender.split('\n');
        const userSegments = [];
        let currentUserBuffer = [];

        const flushUser = () => {
          if (currentUserBuffer.length > 0) {
            const joined = currentUserBuffer.join('\n').trim();
            if (joined) userSegments.push({ type: 'user', text: joined });
            currentUserBuffer = [];
          }
        };

        const directiveRegex = /^@:\s*([^「」:：\n]+?)\s*(?:「([^」]*)」|[:：]\s*(.+)|\s+(.+))\s*$/;

        for (const line of lines) {
          const match = line.match(directiveRegex);
          if (match) {
            flushUser();
            const speaker = match[1].trim();
            const speech = (match[2] ?? match[3] ?? match[4] ?? '').trim();
            userSegments.push({ type: 'character', speaker, text: speech });
          } else {
            currentUserBuffer.push(line);
          }
        }
        flushUser();

        // 抽出したセグメントを順番に画面に描画する
        for (const seg of userSegments) {
          if (seg.type === 'character') {
            // ① 指定キャラクターの発言（左側に表示）
            const charMatch = matchCharacterByName(seg.speaker, characters);
            let avatarUrl = 'assets/default-silhouette.png';
            if (charMatch) {
              avatarUrl = await getAvatarUrl(charMatch.avatarAssetId);
            }
            const msgEl = document.createElement('div');
            msgEl.className = 'chat-message bot-role'; // 左側に配置
            msgEl.innerHTML = `
              <div class="chat-avatar"><img src="${avatarUrl}" alt="${escapeHTML(seg.speaker)}"></div>
              <div class="chat-content-wrapper">
                <span class="chat-sender-name">${escapeHTML(seg.speaker)}</span>
                <div class="chat-bubble">
                  <p class="chat-speech">「${escapeHTML(seg.text)}」</p>
                </div>
              </div>
            `;
            contentContainer.appendChild(msgEl);
          } else {
            // ② 主人公の通常発言・行動（右側に表示）
            let avatarUrl = 'assets/default-silhouette.png';
            let senderName = currentStory.protagonist?.name || 'You';
            if (currentStory.protagonist) {
              avatarUrl = await getAvatarUrl(currentStory.protagonist.avatarAssetId);
            }
            let contentHTML = window.marked && typeof window.marked.parse === 'function'
              ? sanitizeHTML(window.marked.parse(seg.text))
              : sanitizeHTML(seg.text.replace(/\n/g, '<br>'));
            
            const msgEl = document.createElement('div');
            msgEl.className = 'chat-message user-role'; // 右側に配置
            msgEl.innerHTML = `
              <div class="chat-avatar"><img src="${avatarUrl}" alt="${senderName}"></div>
              <div class="chat-content-wrapper">
                <span class="chat-sender-name">${senderName}</span>
                <div class="chat-bubble">${contentHTML}</div>
              </div>
            `;
            contentContainer.appendChild(msgEl);
          }
        }
      }
    } else {
      let contentHTML = window.marked && typeof window.marked.parse === 'function'
        ? sanitizeHTML(window.marked.parse(textToRender))
        : sanitizeHTML(textToRender.replace(/\n/g, '<br>'));
      const blockEl = document.createElement('div');
      blockEl.className = `novel-block ${isModel ? 'story-paragraph' : 'action-paragraph'}`;
      if (!isModel) {
        const pName = currentStory.protagonist?.name || '主人公';
        blockEl.innerHTML = `<span class="novel-action-badge">${pName}の行動</span>${contentHTML}`;
      } else {
        blockEl.innerHTML = contentHTML;
      }
      contentContainer.appendChild(blockEl);
    }

    msgWrapper.appendChild(contentContainer);

    // ★ 編集・削除・再生成用のアクションボタンを動的追加
    const actionsEl = document.createElement('div');
    actionsEl.className = 'chat-message-actions';
    let actionHtml = `
      <button class="action-icon-btn edit-msg-btn" title="メッセージ全体を編集">
        <span class="material-symbols-outlined" style="font-size:18px;">edit_note</span>
      </button>
      <button class="action-icon-btn delete-msg-btn" title="メッセージを削除">
        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
      </button>
    `;
    if (isModel && isLast) {
      actionHtml += `
        <button class="action-icon-btn regen-msg-btn" title="AIの応答を再生成">
          <span class="material-symbols-outlined" style="font-size:18px;">refresh</span>
        </button>
      `;
    }
    actionsEl.innerHTML = actionHtml;

    actionsEl.querySelector('.edit-msg-btn').onclick = () => showEditMessageModal(i);
    actionsEl.querySelector('.delete-msg-btn').onclick = async () => {
      if (confirm('このメッセージを削除しますか？')) {
        currentStory.messages.splice(i, 1);
        await db.saveStory(currentStory);
        const stories = await db.getStories();
        updateState({ stories });
        renderStory();
      }
    };
    if (isModel && isLast) {
      actionsEl.querySelector('.regen-msg-btn').onclick = () => {
        if (confirm('現在のAIの返答を破棄して、もう一度新しく生成し直しますか？')) {
          window.dispatchEvent(new CustomEvent('requestRegenerate', { detail: { retryOnly: false } }));
        }
      };
    }
    msgWrapper.appendChild(actionsEl);
    container.appendChild(msgWrapper);
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
        if (activeAbortController) activeAbortController.abort();
      };
    }
  }

  // ★ APIエラーや手動中断時、最後がユーザー発言であれば「リトライボタン」を表示
  if (!isGenerating && lastMsg && lastMsg.role === 'user') {
    const retryContainer = document.createElement('div');
    retryContainer.style = "text-align: center; margin: 16px 0;";
    retryContainer.innerHTML = `
      <button id="retry-generation-btn" class="primary-btn" style="display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 20px; border-radius: 20px; font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.15); cursor: pointer;">
        <span class="material-symbols-outlined" style="font-size:20px;">refresh</span> AIの応答を生成する (リトライ)
      </button>
    `;
    retryContainer.querySelector('#retry-generation-btn').onclick = () => {
      window.dispatchEvent(new CustomEvent('requestRegenerate', { detail: { retryOnly: true } }));
    };
    container.appendChild(retryContainer);
  }

  renderChoiceButtons(parsedLast.choices);

  // ★ 設定がONのときだけ一番下まで自動スクロールする
  if (autoscrollEnabled !== false) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * チャット最上段・最下段へのジャンプボタンのイベント登録及び表示制御
 */
export function bindScrollJumpControls() {
  const container = document.getElementById('story-viewport');
  const jumpControls = document.getElementById('scroll-jump-controls');
  const topBtn = document.getElementById('scroll-top-btn');
  const bottomBtn = document.getElementById('scroll-bottom-btn');
  if (!container || !jumpControls) return;

  // スクロール状態を監視して、ある程度スクロールされたらジャンプボタンを表示
  container.addEventListener('scroll', () => {
    // 1画面分以上スクロールされているか、最下部から一定距離離れている場合に表示
    const threshold = 150;
    const isScrollable = container.scrollHeight > container.clientHeight;
    const isOffset = container.scrollTop > threshold || (container.scrollHeight - container.scrollTop - container.clientHeight) > threshold;
    
    if (isScrollable && isOffset) {
      jumpControls.classList.add('visible');
      jumpControls.classList.remove('hidden');
    } else {
      jumpControls.classList.remove('visible');
      jumpControls.classList.add('hidden');
    }
  });

  if (topBtn) {
    topBtn.onclick = () => {
      container.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  if (bottomBtn) {
    bottomBtn.onclick = () => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    };
  }
}

/**
 * キャラクターの吹き出し（セグメント）ごとの編集モーダルを表示する関数
 */
export async function showEditSegmentModal(msgIndex, seg) {
  const { currentStory } = getState();
  if (!currentStory || !currentStory.messages[msgIndex]) return;
  const msg = currentStory.messages[msgIndex];

  // 編集用のテキストを構築（スピーチとアクションを結合）
  let originalText = '';
  if (seg.type === 'dialogue') {
    originalText = seg.lines.map(l => {
      if (l.kind === 'speech') return l.text;
      if (l.kind === 'action') return `*${l.text}*`;
      return l.text;
    }).join('\n');
  } else {
    originalText = seg.text;
  }

  let modal = document.getElementById('segment-edit-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'segment-edit-modal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  modal.style.zIndex = '5000';

  modal.innerHTML = `
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 500px; border-radius: 8px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 12px; box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">${escapeHTML(seg.speaker || 'ナレーション')} の台詞を編集</h3>
      <textarea id="seg-edit-textarea" style="width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; font-family: inherit; font-size: 14px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit; line-height: 1.6;">${escapeHTML(originalText)}</textarea>
      
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
        <button id="seg-edit-full-btn" style="background: none; border: none; font-size: 12px; text-decoration: underline; color: var(--primary-color, #4a90e2); cursor: pointer; padding: 0;">メッセージ全体を編集する</button>
        <div style="display: flex; gap: 10px;">
          <button id="seg-edit-cancel-btn" class="secondary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">キャンセル</button>
          <button id="seg-edit-save-btn" class="primary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">変更を保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const textarea = modal.querySelector('#seg-edit-textarea');
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', autoResize);
  setTimeout(autoResize, 0);

  // キャンセル処理
  modal.querySelector('#seg-edit-cancel-btn').onclick = () => modal.remove();
  
  // 部分的な置換が難しい場合のための「全体編集への切り替え」
  modal.querySelector('#seg-edit-full-btn').onclick = () => {
    modal.remove();
    showEditMessageModal(msgIndex);
  };

  // 保存処理（テキストの一部置換を行う）
  modal.querySelector('#seg-edit-save-btn').onclick = async () => {
    const newText = textarea.value.trim();
    if (!newText) {
      alert('台詞を空にはできません。削除したい場合は「メッセージ全体を編集する」から行ってください。');
      return;
    }

    let updatedContent = msg.content;
    let replaceSuccess = false;

    // 元のテキスト内で該当箇所を探して置換する
    const firstLine = seg.type === 'dialogue' && seg.lines.length > 0 
      ? (seg.lines[0].kind === 'action' ? `*${seg.lines[0].text}*` : seg.lines[0].text) 
      : originalText;

    // パターン1: そのままの文字列でマッチする場合
    if (updatedContent.includes(firstLine)) {
      updatedContent = updatedContent.replace(firstLine, newText);
      // 複数行あった場合は、残りの古い行を削除して整合性をとる
      if (seg.type === 'dialogue' && seg.lines.length > 1) {
        for (let i = 1; i < seg.lines.length; i++) {
          const l = seg.lines[i];
          const target = l.kind === 'action' ? `*${l.text}*` : l.text;
          updatedContent = updatedContent.replace(target, '');
        }
      }
      replaceSuccess = true;
    } 
    // パターン2: [キャラクター名] 「セリフ」 の形式で生データが保存されている場合
    else {
      const formattedFallback = `[${seg.speaker}] ${firstLine}`;
      if (updatedContent.includes(formattedFallback)) {
        updatedContent = updatedContent.replace(formattedFallback, `[${seg.speaker}] ${newText}`);
        replaceSuccess = true;
      }
    }

    if (replaceSuccess) {
      // 連続する改行をきれいにする
      updatedContent = updatedContent.replace(/\n{3,}/g, '\n\n');
      
      currentStory.messages[msgIndex].content = updatedContent;
      await db.saveStory(currentStory);
      modal.remove();
      renderStory();
    } else {
      alert('テキストの置換箇所を特定できませんでした。AIの出力フォーマットが複雑なため、左下の「メッセージ全体を編集する」から修正を行ってください。');
    }
  };
}

/**
 * 過去のメッセージ内容を編集する専用モーダルダイアログ (自動拡張機能付き)
 */
export async function showEditMessageModal(msgIndex) {
  const { currentStory } = getState();
  if (!currentStory || !currentStory.messages[msgIndex]) return;
  const msg = currentStory.messages[msgIndex];

  let modal = document.getElementById('msg-edit-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'msg-edit-modal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  modal.style.zIndex = '5000';

  modal.innerHTML = `
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 600px; max-height: 90vh; border-radius: 8px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 12px; box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">メッセージの編集</h3>
      <div style="flex: 1; overflow-y: auto; padding-right: 4px;">
        <textarea id="msg-edit-textarea" style="width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; font-family: inherit; font-size: 14px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit; line-height: 1.6; overflow-y: hidden;">${escapeHTML(msg.content)}</textarea>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px;">
        <button id="msg-edit-cancel-btn" class="secondary-btn" style="padding: 8px 16px; border-radius: 4px; cursor: pointer;">キャンセル</button>
        <button id="msg-edit-save-btn" class="primary-btn" style="padding: 8px 16px; border-radius: 4px; cursor: pointer;">変更を保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const textarea = modal.querySelector('#msg-edit-textarea');
  // Auto-resizeロジック
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', autoResize);
  setTimeout(autoResize, 0); // 初期表示時に高さを合わせる

  modal.querySelector('#msg-edit-cancel-btn').onclick = () => modal.remove();
  modal.querySelector('#msg-edit-save-btn').onclick = async () => {
    const newContent = textarea.value.trim();
    if (newContent) {
      currentStory.messages[msgIndex].content = newContent;
      await db.saveStory(currentStory);
      modal.remove();
      renderStory();
    } else {
      alert('メッセージを空にはできません。削除したい場合はゴミ箱アイコンを使用してください。');
    }
  };
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

  html += `</div></div>`;
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
  if (pCard) pCard.onclick = () => showStorySettingsModal();

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
      if (role === 'absent') body.classList.add('hidden');
      else body.classList.remove('hidden');
      updateCharacterAttendance(charId, role);
      saveStateChanges();
    };
  });

  document.querySelectorAll('.char-affinity-range').forEach(range => {
    range.oninput = (e) => {
      const charId = e.target.dataset.charId;
      const val = parseInt(e.target.value);
      e.target.previousElementSibling.textContent = `好感度 (${val})`;
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
            if (current && current.storyId === story.storyId) setActiveStory(story);
            renderStoryList();
          });
        }
        return;
      }

      if (e.target.closest('.delete-story-btn')) {
        e.stopPropagation();
        if (confirm(`ストーリー「${story.title}」を削除しますか？`)) {
          db.deleteStory(story.storyId).then(() => {
            if (current && current.storyId === story.storyId) setActiveStory(null);
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
  characters.forEach(c => { if (c.category) categories.add(c.category); });

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
      if (c.attendance && c.attendance !== 'absent') inStoryCharIds.add(c.characterId);
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
  addCard.innerHTML = `<span class="material-symbols-outlined add-icon">person_add</span><strong>新しいキャラクター</strong>`;
  addCard.onclick = () => showCharacterModal();
  container.appendChild(addCard);

  for (const char of filtered) {
    const card = document.createElement('div');
    card.className = 'char-card';
    const avatarUrl = await getAvatarUrl(char.avatarAssetId);
    
    let tagBadges = '';
    if (char.category) tagBadges += `<span class="char-card-tag">${escapeHTML(char.category)}</span>`;
    if (char.tags && char.tags.length > 0) {
      char.tags.forEach(t => {
        if (t !== char.category) tagBadges += `<span class="char-card-tag" style="background-color: var(--primary-light, #e1f5fe); color: var(--primary-dark, #0288d1);">${escapeHTML(t)}</span>`;
      });
    }

    card.innerHTML = `
      <div class="char-card-avatar-wrapper"><img src="${avatarUrl}" alt="${char.name}"></div>
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

    card.querySelector('.edit-char-btn').onclick = (e) => { e.stopPropagation(); showCharacterModal(char); };
    card.querySelector('.export-char-btn').onclick = (e) => { e.stopPropagation(); exportCharacterJSON(char); };
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
      if (aspect > 1) { baseHeight = 200; baseWidth = 200 * aspect; }
      else { baseWidth = 200; baseHeight = 200 / aspect; }
      const drawWidth = baseWidth * scale * r;
      const drawHeight = baseHeight * scale * r;
      const drawX = (300 - drawWidth) / 2 + (shiftX * r);
      const drawY = (300 - drawHeight) / 2 + (shiftY * r);
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      canvas.toBlob((blob) => { resolve(blob); }, 'image/jpeg', 0.9);
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
    <div style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 380px; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.25); box-sizing: border-box;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">アバターの位置調整</h3>
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
        <button id="crop-modal-cancel-btn" style="background: none; border: 1px solid var(--border-color, #ccc); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; color: inherit;">キャンセル</button>
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
    if (aspect > 1) { previewImg.style.height = '200px'; previewImg.style.width = `${200 * aspect}px`; }
    else { previewImg.style.width = '200px'; previewImg.style.height = `${200 / aspect}px`; }
    updatePreview();
  };

  zoomSlider.oninput = updatePreview;
  shiftXSlider.oninput = updatePreview;
  shiftYSlider.oninput = updatePreview;

  cancelBtn.onclick = () => { modal.remove(); URL.revokeObjectURL(imgUrl); };
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
    tagsRow.innerHTML = `<label>タグ (カンマ区切り)</label><input type="text" id="char-tags-input" placeholder="例: 五等分の花嫁, アニメ">`;
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
    if (!nameInput.value.trim()) { alert('キャラクター名を入力してください。'); return; }
    try {
      if (newFileBlob) {
        if (currentAvatarAssetId) await db.deleteAsset(currentAvatarAssetId);
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
      spec: 'zetatavern-character', version: 1, name: char.name, category: char.category || '',
      tags: char.tags || [], description: char.description || '', personality: char.personality || '',
      mes_example: char.mes_example || '', avatarBase64: ''
    };
    if (char.avatarAssetId) {
      const blob = await db.getAssetBlob(char.avatarAssetId);
      if (blob) exportObj.avatarBase64 = await db.blobToBase64(blob);
    }
    const jsonStr = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${char.name}_card.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert(`エクスポートに失敗しました: ${err.message}`); }
}

export async function importCharacterJSON(file) {
  try {
    const text = await file.text();
    const importObj = JSON.parse(text);
    if (importObj.spec !== 'zetatavern-character') throw new Error('サポートされていないファイル形式です');
    let avatarAssetId = '';
    if (importObj.avatarBase64) {
      const blob = db.base64ToBlob(importObj.avatarBase64);
      avatarAssetId = await db.saveAsset(blob, blob.type);
    }
    const charData = {
      name: importObj.name, category: importObj.category || '', tags: importObj.tags || [],
      description: importObj.description, personality: importObj.personality,
      mes_example: importObj.mes_example, avatarAssetId: avatarAssetId
    };
    await db.saveCharacter(charData);
    const updatedChars = await db.getCharacters();
    updateState({ characters: updatedChars });
    renderCharacterLibrary();
    renderSidebar();
    alert(`キャラクター「${charData.name}」を取り込みました。`);
  } catch (err) { alert(`取り込みに失敗しました: ${err.message}`); }
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
    <div class="modal-content" style="background: var(--bg-card, #fff); color: var(--text-color, #fff); width: 90%; max-width: 550px; max-height: 85vh; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,0.15); overflow: hidden;">
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
              <input type="text" id="story-p-name-input" value="${escapeHTML(currentStory.protagonist?.name || '')}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
            </div>
          </div>
          <div id="story-p-adjust-btn-container" style="text-align: left; margin-bottom: 8px;"></div>
          <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 8px;">
            <label style="font-size: 11px; font-weight: bold;">詳細・性格・容姿</label>
            <textarea id="story-p-desc-input" rows="2" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; overflow-y: hidden; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">${escapeHTML(currentStory.protagonist?.description || '')}</textarea>
          </div>
        </fieldset>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">世界観設定・あらすじ</label>
          <textarea id="story-world-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; overflow-y: hidden; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">${escapeHTML(currentStory.worldPrompt || '')}</textarea>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーのタグ (カンマ区切り)</label>
          <input type="text" id="story-tags-input" value="${escapeHTML(currentStory.tags ? currentStory.tags.join(', ') : '')}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-weight: bold; font-size: 13px;">ストーリーテラーへの指示（執筆ルール）</label>
          <textarea id="story-prompt-input" rows="3" style="width: 100%; padding: 6px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; resize: none; overflow-y: hidden; box-sizing: border-box; background: var(--bg-input, transparent); color: inherit;">${escapeHTML(currentStory.storytellerPrompt || '')}</textarea>
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; border-top: 1px solid var(--border-color, #eee); padding-top: 12px;">
        <button id="story-settings-cancel-btn" class="secondary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">キャンセル</button>
        <button id="story-settings-save-btn" class="primary-btn" style="padding: 6px 12px; border-radius: 4px; cursor: pointer;">設定を保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Auto-resize logic for settings textareas
  const textareas = modal.querySelectorAll('textarea');
  textareas.forEach(ta => {
    const autoResize = () => {
      ta.style.height = 'auto';
      if (ta.scrollHeight > 0) ta.style.height = ta.scrollHeight + 'px';
    };
    ta.addEventListener('input', autoResize);
    setTimeout(autoResize, 0);
  });

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
        if (avatarAssetId) await db.deleteAsset(avatarAssetId);
        avatarAssetId = await db.saveAsset(newAvatarBlob, 'image/jpeg');
      }

      currentStory.protagonist = { name: name || '主人公', description: desc, avatarAssetId: avatarAssetId };
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
  .chat-speech, .novel-block, .chat-bubble p { font-size: var(--chat-font-size) !important; }
  .narration-content, .chat-narration { font-size: var(--narration-font-size) !important; }
  .chat-sender-name, .novel-action-badge { font-size: var(--ui-font-size) !important; }
  .chat-narration { display: flex; justify-content: flex-start; width: 100%; box-sizing: border-box; margin: 14px 0 !important; }
  .narration-content { padding-left: 62px !important; padding-right: 16px !important; padding-top: 8px !important; padding-bottom: 8px !important; width: 100%; max-width: 82% !important; box-sizing: border-box !important; line-height: 1.75 !important; letter-spacing: 0.03em !important; color: var(--narration-text) !important; background-color: var(--narration-bg) !important; border-left: 4px solid var(--primary-color, #4a90e2) !important; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.01); }
  .narration-content p { margin: 0 !important; }
  .chat-bubble p { line-height: 1.65 !important; margin-bottom: 8px !important; }
  .chat-bubble p:last-child { margin-bottom: 0 !important; }

  /* メッセージアクションとラッパーのCSS設定 */
  .message-wrapper { position: relative; width: 100%; display: flex; flex-direction: column; }
  .message-content-container { width: 100%; }
  .chat-message-actions { position: absolute; top: 0px; right: 8px; display: none; gap: 4px; background: var(--bg-card, #fff); padding: 4px 6px; border-radius: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); border: 1px solid var(--border-color, #eee); z-index: 10; }
  .message-wrapper:hover .chat-message-actions { display: flex; }
  .action-icon-btn { background: none; border: none; cursor: pointer; color: var(--text-color, #333); opacity: 0.5; padding: 2px 4px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
  .action-icon-btn:hover { opacity: 1; color: var(--primary-color, #4a90e2); }

  @media (min-width: 1024px) {
    .timeline-container { max-width: 800px !important; margin: 0 auto !important; width: 100% !important; display: flex !important; flex-direction: column !important; box-sizing: border-box !important; }
    #story-viewport { border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)) !important; border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15)) !important; }
  }
  @media (max-width: 1023px) {
    #story-viewport { padding: 12px 8px !important; }
    .chat-message { margin-bottom: 14px !important; gap: 8px !important; }
    .chat-avatar { width: 40px !important; height: 40px !important; }
    .chat-bubble { padding: 10px 12px !important; max-width: 82% !important; }
    .narration-content { padding-left: 48px !important; max-width: 95% !important; font-size: 0.95em !important; }
    
    /* モバイル向けアクションボタンの常時薄表示対応 */
    .chat-message-actions { display: flex; opacity: 0.2; top: -8px; right: 0px; }
    .message-wrapper:active .chat-message-actions, .chat-message-actions:active { opacity: 1; }
  }
  @media (prefers-color-scheme: dark) {
    .chat-narration { color: rgba(225, 228, 232, 0.95) !important; background-color: rgba(30, 34, 42, 0.7) !important; border-left: 4px solid var(--primary-light, #64b5f6) !important; }
  }
`;
document.head.appendChild(styleInject);
