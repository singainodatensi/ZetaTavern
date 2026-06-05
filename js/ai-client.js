/**
 * ai-client.js - ZetaTavern AI Integration
 * Constructs character-aware dynamic prompts and manages Gemini API calls with retries & timeouts.
 */

import { getState, updateState } from './state.js'; // ★ updateState のインポートを追加
import { getCharacter, getLoreByNameAndFranchise, saveLore, getCharacters } from './db.js';

async function getCharactersList() {
  try {
    return await getCharacters();
  } catch (e) {
    return [];
  }
}

/**
 * Builds the comprehensive System Instruction for the Gemini API.
 * Combines storyteller rules, world prompts, protagonist info, active character roles,
 * active scene states, short-term memories, and relationships.
 */
export async function buildSystemInstruction(story) {
  if (!story) return '';

  // ★ momentum と worldTone を取り出すように追加
  const { storytellerPrompt, worldPrompt, protagonist, sceneState, characterMemory, relationshipMemory, momentum, worldTone } = story;
  const showChoices = getState().showChoices;

  // 1. Core Role and Instructions (固定のエンジン哲学)
  let instruction = `# 役割\n`;
  instruction += `あなたは卓越したゲームマスターであり、物語の演出家です。\n`;
  instruction += `以下の【GM哲学】、【演出モジュール】、および登録された【登場人物】に従い、インタラクティブな群像劇を展開してください。\n\n`;

  instruction += `【出力形式（厳守・最優先）】\n`;
  instruction += `- プレイヤーに見せるのは**日本語の物語本文**（と選択肢）だけ。メタな思考過程や英語は一切出力しない。\n`;
  instruction += `- 執筆ルールの文字数目安に従い、本文を十分な長さで書く。\n\n`;

  instruction += `【重要：チャットUI表示のための記述フォーマット】\n`;
  instruction += `UI側で発言者と描写を分離して吹き出し描画を行うため、物語本文は以下の「台本形式」の記法ルールを**絶対に厳守**してください。\n`;
  instruction += `1. **キャラクターの行動・発言**:\n`;
  instruction += `   必ず \`キャラクター名（動作や表情など）:「セリフ内容」\` の形式で1行ずつ記述してください。主人公（${protagonist?.name || '主人公'}）の場合も同様です。\n`;
  instruction += `   - セリフのみの場合: \`キャラクター名:「セリフ」\`\n`;
  instruction += `   - セリフがなく動作のみの場合: \`キャラクター名（動作）\`\n`;
  instruction += `   （例: \`中野四葉（勢いよく立ち上がる）:「終わりました！」\` または \`上杉風太郎（深くため息をつく）\`）\n`;
  instruction += `2. **環境描写・状況説明**: 必ず \`【】\` で囲んで記述してください。例: \`【放課後の図書室。夕日が窓から差し込んでいる。】\`\n`;
  instruction += `3. **心理描写・地の文**: 必ず \`**\` で囲んで記述してください。例: \`**彼の平穏な放課後は、今日も遠い。**\`\n\n`;

  // === 新設：GM哲学（コア思想・固定） ===
  instruction += `【GMとしての基本哲学（絶対ルール）】\n`;
  instruction += `1. **行動の尊重と世界の抵抗**: ユーザーの行動（試み）は肯定し見せ場を作るが、成功や結果は安易に保証しない。世界や敵は自らの法則で抵抗する。\n`;
  instruction += `2. **NPCの生気と群像劇**: 世界は停止しない。NPCは自律し、主人公の指示待ち人形にならず、自らの感情と行動原理で動く。NPC同士の会話や対立も描くこと。\n`;
  instruction += `3. **誘導（ナッジ）によるテンポ管理**: 会話や場面の区切りでは、強制的なシーン切り替えではなく「窓の外は夕闇に染まっていた――」のように情景や空気感の変化を描写し、次へ進むべきタイミングをユーザーに誘導（提案）すること。\n`;
  instruction += `4. **判断の余白**: 一度の出力で事態を勝手に解決・完結させず、主人公が次のターンで介入・選択できる明確な「余白」を残した時点で出力を止める（ターンの制御）。\n\n`;
  // ★ ここに追加
  instruction += `5. **主人公の不可侵性（アンタッチャブル）**: 主人公の「セリフ」「行動」「思考」「感情」はすべてユーザーが決定する。AIが主人公の言動や判断を勝手に捏造・代行することは絶対に禁止する。\n`;
  instruction += `6. **ナレーターの視点制限（カメラ視点）**: 地の文は、外から観測可能な事実（情景、NPCの表情や行動など）のみを描写するカメラに徹すること。主人公の内心（何を考え、何を感じ、何を理解したか）を勝手に代弁・描写してはならない。「主人公は〇〇と理解した」「不快感はなかった」等の心理解釈は固く禁ずる。\n\n`;
  // ★ 追加：検索ツールの強制使用ルール
  instruction += `【重要：世界観の正確な描写と検索ツールの使用】\n`;
  instruction += `実在の作品名（アニメ、漫画等）をベースにした世界観の場合、安易にオリジナルの敵、魔法、地名、設定を捏造してはいけません。\n`;
  instruction += `登場人物、モンスター、専門用語などを物語に出す際は、**必ずGoogle検索ツールを使用して原作の正確な情報を取得・参照**し、原作に忠実な展開を行ってください。\n\n`;
  // === 新設：AIディレクターモジュール（パラメータの翻訳） ===
  const curSettings = story.directorSettings || { momentum: 40, autonomy: 80, worldTone: 10, backgroundTension: 0, romanticVisibility: 20, relationshipDrift: 60, intrusionRate: 0 };

  instruction += `【演出モジュール（現在のセッション設定）】\n`;

  // 1. Momentum (展開の推進力)
  instruction += `■ 展開の推進力: `;
  if (curSettings.momentum >= 70) {
    instruction += `[劇的・能動的] AIの裁量で積極的にアクシデント、ハプニング、対立を発生させ、物語を停滞させずユーザーに行動を迫ること。\n`;
  } else if (curSettings.momentum <= 30) {
    instruction += `[日常・受動的] ユーザーの行動を待ち、日常や会話の解像度を上げることに注力。AIから急激な場面転換や事件は起こさないこと。\n`;
  } else {
    instruction += `[標準的] 基本はユーザーの行動に応じるが、物語が完全に停滞した時のみ、軽い変化やイベントを起こすこと。\n`;
  }

  // 2. World Tone (世界の温度)
  instruction += `■ 世界の温度: `;
  if (curSettings.worldTone <= 30) {
    instruction += `[優しい・甘め] NPCは基本的に好意的・寛容であり、失敗しても致命的な結果にはならない。安心感を与える空気感を維持すること。\n`;
  } else if (curSettings.worldTone >= 70) {
    instruction += `[シビア・残酷] 世界はユーザーに冷酷である。NPCの裏切り、理不尽な暴力、致命的な失敗が起こり得る。甘い選択には厳しい代償で応じること。\n`;
  } else {
    instruction += `[現実的] 現実的な因果関係。好意には好意で、敵対には敵対で世界が妥当なリアクションを返すこと。\n`;
  }

  // 3. Autonomy (NPCの自律性)
  instruction += `■ NPCの自律性: `;
  if (curSettings.autonomy >= 70) {
    instruction += `[独立した群像劇] NPCは主人公の指示待ちにならず、独自の行動原理で動く。NPC同士の会話、意見の対立、主人公の知らない場所での行動も積極的に描くこと。\n`;
  } else if (curSettings.autonomy <= 30) {
    instruction += `[主人公フォーカス] NPCは主に主人公に向けてアクションを行い、主人公の行動に対するリアクションを中心に描写すること。\n`;
  } else {
    instruction += `[標準的] 基本は主人公との関係を中心に描くが、時折NPC独自の意思や行動も見せること。\n`;
  }

  // 4. Background Tension (不穏さ)
  if (curSettings.backgroundTension >= 70) {
    instruction += `■ 不穏さ: 画面の端々に、不穏な空気、見えない悪意、あるいは説明のつかない違和感を常に漂わせること。\n`;
  } else if (curSettings.backgroundTension <= 30) {
    instruction += `■ 不穏さ: 緊迫感はなく、徹底的に平和で安心できる空気感をベースとすること。\n`;
  }

  // 5. Romantic Visibility (恋愛・好意の露出)
  instruction += `■ 恋愛・好意の露出: `;
  if (curSettings.romanticVisibility <= 30) {
    instruction += `[秘匿・行間] 好意や恋愛感情は直接言葉に出さず、視線の泳ぎ、僅かな焦り、距離感の躊躇いなど、秘匿された感情として繊細に描写すること。\n`;
  } else if (curSettings.romanticVisibility >= 70) {
    instruction += `[直接的・露骨] 好意や感情は隠さず、直接的な言葉や大胆なスキンシップとして明確に表現すること。\n`;
  } else {
    instruction += `[自然な表現] 状況や親密度に応じて、自然な形で好意や感情を表現すること。\n`;
  }

  // 6. Relationship Drift (関係性の変動)
  if (curSettings.relationshipDrift >= 70) {
    instruction += `■ 関係性の変動: キャラクター同士の好感度や信頼関係は固定ではない。ちょっとしたすれ違いで疑心暗鬼になったり急接近したりと、関係性をダイナミックに揺さぶること。\n`;
  }

  // 7. Intrusion Rate (非日常の侵入)
  if (curSettings.intrusionRate >= 70) {
    instruction += `■ 非日常の侵入: 平和な日常描写の最中であっても、唐突に非日常（敵の襲撃、異変、事件のトリガー）を侵入させ、空気を一変させること。\n`;
  }
  instruction += `\n`;
  // 既存のストーリーテラープロンプト（ユーザーが書いたローカルルール）
  if (storytellerPrompt) {
    instruction += `【追加のローカルルール（独自設定）】\n${storytellerPrompt}\n\n`;
  }

  // 選択肢の提示ルール
  if (showChoices) {
    instruction += `【選択肢の提示ルール】\n`;
    instruction += `応答の末尾に、必ずストーリーを次の展開に進めるための選択肢を以下の【A/B/C形式】で出力してください。それ以外の形式は禁止します。\n`;
    instruction += `──────────────\n`;
    instruction += `► A.（関係を進める・能動的な行動やセリフ）\n`;
    instruction += `► B.（様子を見る・保留する行動やセリフ）\n`;
    instruction += `► C.（意外性のある・場を動かす行動やセリフ）\n`;
    instruction += `──────────────\n\n`;
  } else {
    instruction += `【選択肢の提示ルール】\n`;
    instruction += `応答の末尾に選択肢（► A, B, C）を提示しないでください。ストーリーの描写のみで終了してください。\n\n`;
  }

  // 2. World Concept Settings (以降は元のコードのまま)
  instruction += `【世界観設定・あらすじ】\n`;
  // ... 以下既存のコードが続く ...
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

  // 6.5 Session Lore (長期あらすじとフラグ記録)
  if (story.session_lore) {
    instruction += `【これまでのストーリー進行・獲得フラグ（長期記憶）】\n`;
    if (story.session_lore.summary) {
      instruction += `・全体状況/あらすじ: ${story.session_lore.summary}\n`;
    }
    if (story.session_lore.key_events && story.session_lore.key_events.length > 0) {
      instruction += `・主要イベント・獲得フラグ:\n`;
      story.session_lore.key_events.forEach(ev => {
        instruction += `  - ${ev}\n`;
      });
    }
    instruction += `\n`;
  }

  // ==========================================
  // RAG: 固有名詞の抽出とロアブックの注入
  // ==========================================
  const detectedKeywords = extractKeywordsForLore(story);
  if (detectedKeywords.length > 0) {
    const matchedLores = [];
    const franchise = story.franchise || '';

    // DBから完全/部分一致するロアを取得
    for (const keyword of detectedKeywords) {
      try {
        const lore = await getLoreByNameAndFranchise(keyword, franchise);
        if (lore && lore.status === 'completed' && !matchedLores.some(l => l.id === lore.id)) {
          matchedLores.push(lore);
        }
      } catch (e) {
        console.warn(`Error querying lore for ${keyword}:`, e);
      }
    }

    if (matchedLores.length > 0) {
      // 関連度スコアリング (簡易的にキーワード一致数または順序で評価)
      // 制限：最大5件、かつ合計最大4000文字
      const MAX_LORE_ITEMS = 5;
      const MAX_LORE_CHARS = 4000;

      let injectedCount = 0;
      let totalChars = 0;
      let loreInstruction = `【関連設定・ロア情報 (Reference Lore)】\n`;

      for (const lore of matchedLores) {
        if (injectedCount >= MAX_LORE_ITEMS) break;

        let loreBlock = `■ ${lore.name} (${lore.type || '設定'})\n`;
        if (lore.content?.summary) loreBlock += `・概要: ${lore.content.summary}\n`;
        if (lore.content?.profile) loreBlock += `・詳細プロフィール: ${lore.content.profile}\n`;
        if (lore.content?.speech) loreBlock += `・口調・特徴: ${lore.content.speech}\n`;
        if (lore.content?.relationships) loreBlock += `・関係性: ${lore.content.relationships}\n`;
        loreBlock += `\n`;

        if (totalChars + loreBlock.length > MAX_LORE_CHARS) {
          // 残りの枠に入る分だけ部分的に入れるか、安全のため足切りする
          const remainingSpace = MAX_LORE_CHARS - totalChars;
          if (remainingSpace > 100) {
            loreInstruction += loreBlock.substring(0, remainingSpace) + `... [以下文字数制限のため省略]\n\n`;
            totalChars = MAX_LORE_CHARS;
          }
          break;
        }

        loreInstruction += loreBlock;
        totalChars += loreBlock.length;
        injectedCount++;
      }

      if (injectedCount > 0) {
        instruction += `\n${loreInstruction}`;
      }
    }
  }

  return instruction;
}

/**
 * 簡易固有名詞抽出ロジック
 * ユーザー入力や直近メッセージ、シーン情報から漢字、カタカナ、英数字単語をキーワードとして切り出す
 */
function extractKeywordsForLore(story) {
  const wordsSet = new Set();
  const textSource = [];

  // 直近2メッセージのテキストを追加
  const msgs = story.messages || [];
  const startIdx = Math.max(0, msgs.length - 2);
  for (let i = startIdx; i < msgs.length; i++) {
    textSource.push(msgs[i].content);
  }

  // シーン情報も追加
  if (story.sceneState) {
    textSource.push(story.sceneState.location || '');
    textSource.push(story.sceneState.currentObjective || '');
  }

  const combinedText = textSource.join('\n');

  // カタカナ・漢字（2文字以上）、および大文字英単語などを抽出する簡易的な正規表現
  const matchesKatakana = combinedText.match(/[\u30a0-\u30ffー]{2,15}/g) || [];
  const matchesKanji = combinedText.match(/[\u4e00-\u9faf]{2,10}/g) || [];
  const matchesEnglish = combinedText.match(/[A-Z][a-zA-Z]{2,15}/g) || [];

  [...matchesKatakana, ...matchesKanji, ...matchesEnglish].forEach(word => {
    // 一般名詞や助詞、不要な言葉のフィルタリング（文字長などの簡易フィルタ）
    const w = word.trim();
    if (w && w.length >= 2) {
      wordsSet.add(w);
    }
  });

  return Array.from(wordsSet);
}

/** 行に十分な日本語が含まれるか */
function hasSignificantJapanese(str) {
  if (!str) return false;
  const cjk = (str.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
  return cjk >= 6 || (str.length > 0 && cjk / str.length > 0.12);
}

/**
 * 思考漏れ（英語の計画メモ等）が本文に混ざったときの救済フィルタ
 */
export function stripLeakedThinkingText(text) {
  if (!text || typeof text !== 'string') return text;

  let working = text.trim();

  const draftMatch = working.match(/Drafting the scene:\s*/i);
  if (draftMatch) {
    working = working.slice(working.indexOf(draftMatch[0]) + draftMatch[0].length).trim();
  }

  const metaLine =
    /^(User input:|Context:|Setting:|Goal:|Visuals?:|Action:|Encounter:|Let's |Third[- ]person|Show, don't|Avoid direct|Strict adherence|No meta|Maybe |Actually |Who\?|Describe the|Introduce the|Yuki has|End with)/i;

  const lines = working.split('\n');
  let storyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (storyStart === i) storyStart = i + 1;
      continue;
    }
    if (/^---+$/.test(line) || metaLine.test(line)) {
      storyStart = i + 1;
      continue;
    }
    if (hasSignificantJapanese(line)) {
      storyStart = i;
      break;
    }
    if (/^[A-Za-z0-9\s,.:;'"!?()[\]\-–—]+$/.test(line) && line.length > 12) {
      storyStart = i + 1;
      continue;
    }
    break;
  }

  const stripped = lines.slice(storyStart).join('\n').trim();
  return stripped.length >= 40 ? stripped : working;
}

/**
 * API レスポンスから物語本文だけを取り出す（thought パートを除外）
 */
export function extractStoryTextAndThoughtFromApiResponse(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return { text: null, thought: null };

  let storyChunks = [];
  let thoughtChunks = [];

  for (const part of parts) {
    const t = part?.text;
    if (!t) continue;
    if (part.thought === true) {
      thoughtChunks.push(t);
    } else {
      storyChunks.push(t);
    }
  }

  const storyText = storyChunks.length > 0 ? stripLeakedThinkingText(storyChunks.join('\n\n').trim()) : null;
  // もしthoughtフラグがなく混ざっているモデル（2.5 Flash等）へのフォールバック
  if (!storyText && thoughtChunks.length === 0) {
    const full = parts.map(p => p.text).filter(Boolean).join('\n\n').trim();
    return { text: stripLeakedThinkingText(full), thought: null };
  }

  return { text: storyText, thought: thoughtChunks.join('\n\n').trim() };
}

/** UIの思考レベル設定から、API送信用の Thinking Budget 数値を決定する */
function buildThinkingConfig(thinkingLevel, modelName) {
  const m = (modelName || '').toLowerCase();

  // ★ 安全装置：Gemmaシリーズや、Thinkingに非対応な古いモデルの場合は強制的にオフにする
  if (m.includes('gemma') || m.includes('1.5') || (m.includes('2.0') && !m.includes('thinking'))) {
    return null;
  }

  let budget = 1024; // デフォルトは Standard

  if (thinkingLevel === 'none') {
    return null; // 思考機能をオフ
  } else if (thinkingLevel === 'minimal') {
    budget = 512;
  } else if (thinkingLevel === 'high') {
    budget = 4096;
  }

  return { thinkingBudget: budget };
}

/**
 * Sends messages to Gemini API.
 * Supports timeout, retries, and manual stop.
 */
export async function generateStoryResponse(story) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  // --- 設定から値を取得（なければ安全なデフォルト値を使用） ---
  const parsedTimeout = parseInt(appState.apiTimeout, 10);
  const parsedRetries = parseInt(appState.apiRetries, 10);
  const timeoutSeconds = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 60;
  const maxRetries = Number.isFinite(parsedRetries) && parsedRetries > 0 ? parsedRetries : 1;

  const systemInstruction = await buildSystemInstruction(story);

  // Map messages to Gemini API formats: { role: 'user' | 'model', parts: [{ text: string }] }
  const contents = story.messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.aiContent || msg.content }]
  }));

  const modelName = appState.modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const generationConfig = {
    temperature: 0.9,
    topP: 0.95,
    maxOutputTokens: 8192
  };

  // ★ モデル名も一緒に渡して、非対応モデルならエラーを回避する
  const thinkingLevel = appState.thinkingLevel || 'standard';
  const thinkingConfig = buildThinkingConfig(thinkingLevel, modelName);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  // 手動キャンセル用のメイン AbortController
  const mainController = new AbortController();
  updateState({ activeAbortController: mainController });

  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;

    // このアテンプト専用の AbortController
    const attemptController = new AbortController();

    const onMainAbort = () => attemptController.abort();
    mainController.signal.addEventListener('abort', onMainAbort);

    const timeoutId = setTimeout(() => {
      attemptController.abort();
    }, timeoutSeconds * 1000);

  try {
      // ★ 変更：Google検索ツールを外し、Function Calling専用にする
      const tools = [];

      // update_session_lore ツールを追加定義 (AIがセッション情報を更新するためのツール)
      tools.push({
        functionDeclarations: [{
          name: 'update_session_lore',
          description: 'ストーリーの進行や現在の状況に応じて、登場人物の関係性や重要な出来事・記憶（セッションロア）を追記・更新します。',
          parameters: {
            type: 'OBJECT',
            properties: {
              summary: {
                type: 'STRING',
                description: '今までのストーリーのあらすじ、進行状況、または重要なマイルストーンの更新。'
              },
              affinity_updates: {
                type: 'ARRAY',
                description: '登場人物と主人公の関係性の変更・好感度の更新リスト。',
                items: {
                  type: 'OBJECT',
                  properties: {
                    characterName: { type: 'STRING', description: '登場人物の名前（例: エミリア）' },
                    affinity: { type: 'INTEGER', description: '新しい好感度スコア (0-100)' },
                    notes: { type: 'STRING', description: '関係性の特徴や特記事項。' }
                  },
                  required: ['characterName', 'affinity']
                }
              },
              key_events: {
                type: 'ARRAY',
                description: '発生した重要な事件や獲得したフラグ、オリジナルアイテム。',
                items: { type: 'STRING' }
              }
            }
          }
        }]
      });

      let currentContents = [...contents];
      let extracted = { text: null, thought: null };

      // ★ 追加：Function Calling 往復用のループ（AIがメモを更新して本文を書くまで最大3回まで往復する）
      for (let fcTurn = 0; fcTurn < 3; fcTurn++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: currentContents,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig,
            tools,
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
          }),
          signal: attemptController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errMsg = errorData.error?.message || `HTTP status ${response.status}`;
          throw new Error(`Gemini API Error: ${errMsg}`);
        }

        const result = await response.json();

        // Function Calling (update_session_lore) の呼び出し判定・実行
        const call = result?.candidates?.[0]?.content?.parts?.find(p => p.functionCall);
        if (call && call.functionCall.name === 'update_session_lore') {
          try {
            const args = call.functionCall.args || {};
            console.log('[Function Call: update_session_lore]', args);

            if (!story.session_lore) story.session_lore = { summary: '', key_events: [] };
            if (args.summary) story.session_lore.summary = args.summary;
            if (args.key_events) {
              story.session_lore.key_events = Array.from(new Set([...(story.session_lore.key_events || []), ...args.key_events]));
            }
            if (args.affinity_updates) {
              if (!story.relationshipMemory) story.relationshipMemory = {};
              const characters = await getCharactersList();
              for (const update of args.affinity_updates) {
                const charMatch = characters.find(c => c.name === update.characterName);
                if (charMatch) {
                  story.relationshipMemory[charMatch.characterId] = {
                    affinity: update.affinity,
                    notes: update.notes || ''
                  };
                }
              }
            }

            // バックグラウンドでセーブを実行
            import('./db.js').then(async db => {
              await db.saveStory(story);
              if (typeof window !== 'undefined' && window.dispatchEvent) {
                setTimeout(() => {
                  const sidebarTab = document.getElementById('story-sidebar');
                  if (sidebarTab) {
                    import('./ui.js').then(ui => ui.renderSidebar());
                  }
                }, 100);
              }
            });
          } catch (fcErr) {
            console.warn('[Function Call] Failed to execute update_session_lore:', fcErr);
          }

          // ★重要：テキストも一緒に返してきたか確認
          const tmpExtracted = extractStoryTextAndThoughtFromApiResponse(result);
          if (tmpExtracted.text) {
             extracted = tmpExtracted;
             break; // テキストがあればループ終了
          } else {
             // テキストがない（関数実行要求のみ）場合、結果を積んで再リクエスト
             currentContents.push(result.candidates[0].content); // AIの関数呼び出し履歴を追加
             currentContents.push({
               role: 'user',
               parts: [{
                 functionResponse: {
                   name: call.functionCall.name,
                   response: { result: "success" } // AIに「保存成功したから本文書いて」と伝える
                 }
               }]
             });
             continue; // ループしてもう一度APIを叩く
          }
        }

        // 関数呼び出しがない場合は通常通り本文を抽出して終了
        extracted = extractStoryTextAndThoughtFromApiResponse(result);
        break; 
      } // for loop end

      clearTimeout(timeoutId);
      mainController.signal.removeEventListener('abort', onMainAbort);

      if (!extracted.text) {
        throw new Error('有効なテキストが得られませんでした。');
      }

      updateState({ activeAbortController: null });
      return extracted;

    } catch (err) {
      clearTimeout(timeoutId);
      mainController.signal.removeEventListener('abort', onMainAbort);

      if (mainController.signal.aborted) {
        updateState({ activeAbortController: null });
        throw new Error('ユーザーにより生成が中止されました。');
      }

      console.warn(`API call attempt ${attempt} failed:`, err);

      if (attempt >= maxRetries) {
        updateState({ activeAbortController: null });
        throw err;
      }

      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  updateState({ activeAbortController: null });
  throw new Error('AI応答の生成が開始されませんでした。リトライ回数の設定を確認してください。');
}

/**
 * Fallback to read API key from localStorage if not in memory state.
 */
async function getApiKeyFromStorage() {
  return localStorage.getItem('zetatavern_api_key') || '';
}
/**
 * キャラクタープロフィールをGoogle検索経由で自動生成し、JSONで返す関数
 */
export async function generateCharacterProfile(name, category) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  const prompt = `
# キャラクタープロフィール生成 指示書

## 概要
このタスクは、単なるキャラクター解説記事を作るものではない。
目的は、AIによるロールプレイ・会話生成・人格再現を行うための「構造化キャラクターデータ」を生成することである。

対象キャラクター名: ${name}
${category ? `対象作品 / カテゴリー: ${category}` : ''}

生成するプロフィールは、以下の用途で利用される。
* AIチャット / キャラクターロールプレイ / シナリオ生成 / 会話生成 / 感情シミュレーション
そのため、単なる設定紹介ではなく、「どのように話すか」「何を嫌うか」「どう感情変化するか」「どんな人間関係を持つか」を重視して記述すること。

---

# 情報収集ルール
## 優先参照順位
1. 公式サイト  2. 原作  3. 信頼性の高いWiki  4. インタビュー・設定資料集  5. その他Web情報
## 禁止事項
以下を事実として扱わないこと： 二次創作設定 / ネタ画像・ミーム / Fanon（ファン解釈） / 明確な根拠のない考察 / AIの推測のみで補完した情報
## 情報不足時
不明な情報は無理に埋めず、「不明」「作中で明言なし」と記載する。

---
（以下、要求する出力内容の項目。これらを元に後のJSONを作成すること）
1. 基本プロファイル (Identity & Visuals)
年齢・役割、外見的特徴、性格タグ（5〜10個）、表の性格、裏の性格/本音、キャラクター崩壊になりやすい要素（過剰なデレなどAIが誤りやすい点）

2. 話し方と口調 (Speech Patterns)
一人称/二人称、口癖・語尾、トーン、会話テンポ、NGワード、NG行動

3. 代表的なセリフ集 (Dialogue Examples)
状況A：初対面で敵対している時 / 状況B：戦闘中・能力使用時 / 状況C：照れ・好意を隠している時 / 状況D：日常会話 / 状況E：パニック / 状況F：怒り / 状況G：弱みを見せる時
※各状況ごとに、感情・相手との距離感・実際のセリフをセットで記述。

4. 人間関係と行動原理 (Relationships & Motivation)
主人公への態度（時系列変化）、ユーザーへの適応方針（AIチャット時の立場）、関連人物との関係性、行動原理、恐れているもの

5. 特記事項 (Trivia & Deep Lore)
好物・趣味・弱点、日常習慣、感情トリガー、重要キーワード（3つ以上）

---

# 最終出力フォーマット（厳守）
上記の分析結果を踏まえ、システムに登録するためのデータを以下の JSON フォーマットで出力してください。Markdownのコードブロック（\`\`\`json ... \`\`\`）で囲むこと。必ず以下のキーを持つJSONオブジェクト1つを出力してください。

\`\`\`json
{
  "description": "【1. 基本プロファイル】【5. 特記事項】の内容をまとめた詳細な文章。",
  "personality": "【4. 人間関係と行動原理】の内容（行動原理、恐れているもの、関係性など）、および性格の詳細をまとめた文章。",
  "mes_example": "【2. 話し方と口調】【3. 代表的なセリフ集】を詳細にまとめた文章。セリフは必ず [キャラクター名] 「セリフ」 の形式を含めること。",
  "tags": ["特徴1", "特徴2", "特徴3"]
}
\`\`\`
`;

  const modelName = appState.modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  // 検索用のツールをONにし、JSON生成のため少しだけ温度を低め(0.7)に設定
  const generationConfig = { temperature: 0.7, topP: 0.9, maxOutputTokens: 8192 };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP status ${response.status}`);
  }

  const result = await response.json();
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error('APIから有効なテキストが返されませんでした。');

  // thought（思考）部分を除外し、出力テキストだけを結合
  const text = parts.filter(p => !p.thought).map(p => p.text).join('\n').trim();

  // ```json の中身だけを正規表現でくり抜く
  const jsonMatch = text.match(/\`\`\`json\s*(\{[\s\S]*?\})\s*\`\`\`/);
  let parsed = null;

  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[1]); } catch (e) { }
  } else {
    try { parsed = JSON.parse(text); } catch (e) { }
  }

  if (!parsed) {
    console.error('AI Raw Response:', text);
    throw new Error('AIが正しいJSON形式で出力しませんでした。');
  }

  return parsed;
}

/**
 * 原作知識・固有名詞をGoogle検索経由で要約収集し、構造化JSONで返す関数
 */
export async function generateLoreProfileFromSearch(name, franchise) {
  const appState = getState();
  const apiKey = appState.apiKey || await getApiKeyFromStorage();

  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面で登録してください。');
  }

  const prompt = `
# 世界観設定 / 固有名詞ロアデータ生成 指示書

対象ワード: ${name}
対象作品・コンテキスト: ${franchise}

このワードについてGoogle検索を用いて原作の正確な設定情報を収集し、ZetaTavernロアブック用の構造化データを作成してください。
安易な捏造や無関係な作品の別単語との混同を避け、正確な原作知識を要約してください。

出力は以下のJSONフォーマット（Markdownの \`\`\`json ... \`\`\` コードブロックで囲む）で返してください。

\`\`\`json
{
  "type": "character", // character, location, organization, term, event, item のいずれか一つ
  "summary": "【概要・設定要約】100文字〜200文字程度の簡単な紹介・定義文。",
  "profile": "【プロフィール詳細】外見、性格、戦闘能力、役割などの詳細な設定テキスト。",
  "speech": "【口調や特徴】セリフや話し方の傾向、一人称/二人称、特徴的な口癖など（もしあれば記載、なければ空欄）。",
  "relationships": "【人間関係・他者とのつながり】原作における他の主要キャラクターたちとのつながりや関係性（もしあれば記載、なければ空欄）。"
}
\`\`\`
`;

  const modelName = appState.modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const generationConfig = { temperature: 0.5, topP: 0.9, maxOutputTokens: 4096 };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
      tools: [{ googleSearch: {} }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP status ${response.status}`);
  }

  const result = await response.json();
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error('APIから有効なテキストが返されませんでした。');

  const text = parts.filter(p => !p.thought).map(p => p.text).join('\n').trim();
  const jsonMatch = text.match(/\`\`\`json\s*(\{[\s\S]*?\})\s*\`\`\`/);
  let parsed = null;

  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[1]); } catch (e) { }
  } else {
    try { parsed = JSON.parse(text); } catch (e) { }
  }

  if (!parsed) {
    console.error('AI Raw Response:', text);
    throw new Error('AIが正しいJSON形式で出力しませんでした。');
  }

  return parsed;
}
