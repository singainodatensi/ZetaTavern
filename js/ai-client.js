/**
 * ai-client.js - ZetaTavern AI Integration
 * Constructs character-aware dynamic prompts and manages Gemini API calls with retries & timeouts.
 */

import { getState } from './state.js';
import { getCharacter } from './db.js';

/**
 * Builds the comprehensive System Instruction for the Gemini API.
 * Combines storyteller rules, world prompts, protagonist info, active character roles,
 * active scene states, short-term memories, and relationships.
 */
export async function buildSystemInstruction(story) {
  if (!story) return '';

  const { storytellerPrompt, worldPrompt, protagonist, sceneState, characterMemory, relationshipMemory } = story;
  const showChoices = getState().showChoices;

  // 1. Core Role and Storyteller Instructions
  let instruction = `# 役割\n`;
  instruction += `あなたは卓越したストーリーテラー（語り手・ゲームマスター）です。\n`;
  instruction += `以下の【執筆ルール】、【世界観設定】、および登録された【登場人物】や【シーン状況】に従い、プレイヤー（主人公）の行動に対する物語の展開を描写してください。\n\n`;

  instruction += `【執筆ルール】\n`;
  instruction += `${storytellerPrompt || '三人称小説形式で描写してください。感情の直接説明を避け、行動や仕草、セリフで表現してください。'}\n\n`;

  if (showChoices) {
    instruction += `【選択肢の提示ルール】\n`;
    instruction += `応答の末尾に、必ずストーリーを次の展開に進めるための選択肢を以下の【A/B/C形式】で出力してください。それ以外の形式（箇条書きの変更など）は禁止します。\n`;
    instruction += `──────────────\n`;
    instruction += `► A.（関係を前に進める行動・セリフ）\n`;
    instruction += `► B.（様子を見る・保留する行動・セリフ）\n`;
    instruction += `► C.（意外性のある・場を動かす行動・セリフ）\n`;
    instruction += `──────────────\n`;
    instruction += `※選択肢は主人公（${protagonist?.name || '主人公'}）の行動またはセリフとして提示し、それぞれ全く異なる性質を持たせてください。\n\n`;
  } else {
    instruction += `【選択肢の提示ルール】\n`;
    instruction += `応答の末尾に選択肢（► A, B, C）を提示しないでください。ストーリーの描写のみで終了してください。\n\n`;
  }

  // 2. World Concept Settings
  instruction += `【世界観設定・あらすじ】\n`;
  instruction += `${worldPrompt || '特に設定されていません。一般的な日常世界です。'}\n\n`;

  // 3. Protagonist Settings
  if (protagonist) {
    instruction += `【主人公設定】\n`;
    instruction += `・名前: ${protagonist.name || '主人公'}\n`;
    if (protagonist.description) {
      instruction += `・詳細・容姿・性格:\n${protagonist.description}\n`;
    }
    instruction += `\n`;
  }

  // 4. Character Attendance / Specifications
  instruction += `【登場人物・キャラクター設定】\n`;
  if (story.characters && story.characters.length > 0) {
    for (const charRef of story.characters) {
      const { characterId, attendance } = charRef;
      if (attendance === 'absent') continue; // Skip absent characters completely

      const char = await getCharacter(characterId);
      if (!char) continue;

      if (attendance === 'main') {
        instruction += `■ ${char.name} (主要人物 - このシーンのメインキャラクター)\n`;
        instruction += `・詳細設定・容姿: ${char.description || '特になし'}\n`;
        instruction += `・性格・特徴: ${char.personality || '特になし'}\n`;
        if (char.mes_example) {
          instruction += `・台詞・口調サンプル:\n${char.mes_example}\n`;
        }
      } else if (attendance === 'support') {
        instruction += `■ ${char.name} (補助人物 - 会話や行動に参加する脇役)\n`;
        instruction += `・設定と性格の要約: ${char.description?.substring(0, 300) || '特になし'}\n`;
        instruction += `・性格・口調の特徴: ${char.personality || '特になし'}\n`;
      } else if (attendance === 'background') {
        instruction += `■ ${char.name} (背景人物 - その場に居合わせるが、積極的には発言・行動しない)\n`;
      }
      instruction += `\n`;
    }
  } else {
    instruction += `登録されている登場人物はいません。\n\n`;
  }

  // 5. Active Scene States
  if (sceneState) {
    instruction += `【現在のシーン状況 (Scene State)】\n`;
    instruction += `・現在地: ${sceneState.location || '不明'}\n`;
    instruction += `・時間帯: ${sceneState.timeOfDay || '不明'}\n`;
    instruction += `・雰囲気: ${sceneState.atmosphere || '不明'}\n`;
    instruction += `・直近の目的: ${sceneState.currentObjective || 'なし'}\n\n`;
  }

  // 6. Dynamic Memories (Short-term states & Relationships)
  let memoryStr = '';
  if (characterMemory && typeof characterMemory === 'object') {
    for (const [charId, mem] of Object.entries(characterMemory)) {
      const char = await getCharacter(charId);
      if (!char || !mem) continue;
      memoryStr += `・${char.name}の状況: ${mem.status || '特になし'}, 短期目標: ${mem.shortTermGoal || 'なし'}, 位置: ${mem.location || 'シーン現在地'}\n`;
      if (mem.notes) {
        memoryStr += `  (メモ: ${mem.notes})\n`;
      }
    }
  }
  if (memoryStr) {
    instruction += `【登場人物の個別状態・短期記憶】\n${memoryStr}\n`;
  }

  let relationStr = '';
  if (relationshipMemory && typeof relationshipMemory === 'object') {
    for (const [charId, rel] of Object.entries(relationshipMemory)) {
      const char = await getCharacter(charId);
      if (!char || !rel) continue;
      relationStr += `・${char.name}との関係性 (好感度: ${rel.affinity ?? 50}/100): ${rel.notes || '特になし'}\n`;
    }
  }
  if (relationStr) {
    instruction += `【主人公と各人物の関係性記憶】\n${relationStr}\n`;
  }

  return instruction;
}

/**
 * Sends messages to Gemini API.
 * Supports timeout, retries, and models that accept systemInstruction.
 */
export async function generateStoryResponse(story, customTimeout = 90000, maxRetries = 3) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();
  
  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  const systemInstruction = await buildSystemInstruction(story);

  // Map messages to Gemini API formats: { role: 'user' | 'model', parts: [{ text: string }] }
  const contents = story.messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));

  const modelName = appState.modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const payload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      temperature: 0.9,
      topP: 0.95,
      maxOutputTokens: 2048
    }
  };

  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), customTimeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `HTTP status ${response.status}`;
        throw new Error(`Gemini API Error: ${errMsg}`);
      }

      const result = await response.json();
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        throw new Error('APIから有効なテキストレスポンスが得られませんでした。安全性フィルター等によりブロックされた可能性があります。');
      }

      return text;

    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`API call attempt ${attempt} failed:`, err);
      
      // If we used all retries or it was aborted by user, throw
      if (attempt >= maxRetries || err.name === 'AbortError') {
        throw err;
      }
      
      // Backoff delay before next retry
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Fallback to read API key from localStorage if not in memory state.
 */
async function getApiKeyFromStorage() {
  // Directly reading from localStorage is appropriate for basic initialization
  return localStorage.getItem('zetatavern_api_key') || '';
}
