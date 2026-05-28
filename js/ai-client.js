/**
 * ai-client.js - ZetaTavern AI Integration
 * Constructs character-aware dynamic prompts and manages Gemini API calls with retries & timeouts.
 */

import { getState, updateState } from './state.js'; // ★ updateState のインポートを追加
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

  instruction += `【出力形式（厳守・最優先）】\n`;
  instruction += `- プレイヤーに見せるのは**日本語の物語本文**（と選択肢）だけ。英語は一切使わない。\n`;
  instruction += `- 思考過程・執筆メモ・分析・計画・User input・Context・Goal・Setting・Drafting・Let's などの**メタ記述は出力しない**（頭の中で考えてよいが、画面には出さない）。\n`;
  instruction += `- 「承知しました」「了解」「I understand」などの前置き応答も禁止。\n`;
  instruction += `- 執筆ルールの文字数目安に従い、**本文を十分な長さ**で書く。短い要約やプロット箇条書きで済ませない。\n\n`;

  // --- 追加：チャットパース用の構造化指定 ---
  instruction += `【重要：チャットUI表示のための記述フォーマット】\n`;
  instruction += `UI側で発言者と描写を分離して吹き出し描画を行うため、物語本文は以下の記法ルールを**絶対に厳守**して出力してください。小説のようなプレーンな文章は出力しないでください。\n`;
  instruction += `1. **セリフ（発言）**:\n`;
  instruction += `   必ず行の先頭に \`[発言者名] 「セリフ内容」\` の形式で1行ずつ記述してください。前後に不要な空白は入れないでください。\n`;
  instruction += `   ※主人公（${protagonist?.name || '主人公'}）自身が発言する場合も、必ず \`[${protagonist?.name || '主人公'}] 「〜〜〜」\` と記述してください。\n`;
  instruction += `   ※主要人物や補助人物が発言する場合も、必ず \`[登場人物の名前] 「〜〜〜」\` と記述してください。\n`;
  instruction += `   （例: \`[中野四葉] 「おはようございまーす！」\`）\n`;
  instruction += `2. **動作描写・仕草・状況説明・ナレーション（地の文）**:\n`;
  instruction += `   セリフ以外のすべての描写は、必ず独立した行とし、その行全体をアスタリスク（*）で囲んで記述してください。アスタリスク行の中に「」を含めてはいけません。\n`;
  instruction += `   （例: \`*全力で駆け寄ってくる*\`）\n`;
  instruction += `   （例: \`*放課後の教室。夕日が窓から差し込んでいる。*\`）\n\n`;

  // デフォルトのチャットロールプレイ最適化執筆ルール
  const defaultStorytellerPrompt = 
    `・三人称主人公視点で描写し、キャラクター同士のテンポの良い会話（台詞）と、動き・仕草（動作・情景描写）を中心に物語を進行させてください。\n` +
    `・「語るな、見せろ（Show, don't tell）」を厳守してください。キャラクターの感情を「嬉しい」「怒る」などと地の文で直接説明せず、声のトーン、視線、間（ま）、仕草、セリフの選び方で生き生きと表現してください。\n` +
    `・各登場人物は、主人公や他のキャラクターの話し方に影響（汚染・伝染）されず、固有の一人称・二人称・敬語レベル・語尾を厳格に維持して発言させてください。\n` +
    `・一度の出力で事態を勝手に解決・完結させず、主人公（ユーザー）が次のターンで介入（発言や行動の選択）できる明確な「判断の余白」を残した時点で物語の記述を終了してください。`;

  instruction += `【執筆ルール】\n`;
  instruction += `${storytellerPrompt || defaultStorytellerPrompt}\n\n`;

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
export function extractStoryTextFromApiResponse(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return null;

  const storyChunks = [];

  for (const part of parts) {
    const t = part?.text;
    if (!t) continue;
    if (part.thought === true) {
      continue;
    }
    storyChunks.push(t);
  }

  if (storyChunks.length > 0) {
    const joined = storyChunks.join('\n\n').trim();
    return stripLeakedThinkingText(joined);
  }

  // thought フラグ無しで全部1パートに混ざるケース（2.5 Flash 等）
  const full = parts.map(p => p.text).filter(Boolean).join('\n\n').trim();
  return stripLeakedThinkingText(full);
}

/** モデル別 thinking 設定（2.5 Flash は 0 で思考オフ） */
function buildThinkingConfig(modelName) {
  const m = (modelName || '').toLowerCase();
  if (m.includes('2.5-pro')) {
    return { thinkingBudget: 512 };
  }
  if (m.includes('2.5-flash') || m.includes('2.5-flash-lite') || m.includes('robotics-er')) {
    return { thinkingBudget: 0 };
  }
  if (m.includes('gemini-2.5')) {
    return { thinkingBudget: 0 };
  }
  return null;
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
  const timeoutSeconds = appState.apiTimeout ? parseInt(appState.apiTimeout) : 60;
  const maxRetries = appState.apiRetries !== undefined ? parseInt(appState.apiRetries) : 3;

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

  const thinkingConfig = buildThinkingConfig(modelName);
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
     const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: contents,
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          generationConfig,
          // ↓この tools ブロックを追加するだけ！
          tools: [
            { googleSearch: {} }
          ]
        }),
        signal: attemptController.signal
      });

      clearTimeout(timeoutId);
      mainController.signal.removeEventListener('abort', onMainAbort);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `HTTP status ${response.status}`;
        throw new Error(`Gemini API Error: ${errMsg}`);
      }

      const result = await response.json();
      const text = extractStoryTextFromApiResponse(result);

      if (!text) {
        throw new Error('有効なテキストが得られませんでした。');
      }

      updateState({ activeAbortController: null });
      return text;

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
    try { parsed = JSON.parse(jsonMatch[1]); } catch (e) {}
  } else {
    try { parsed = JSON.parse(text); } catch (e) {}
  }

  if (!parsed) {
    console.error('AI Raw Response:', text);
    throw new Error('AIが正しいJSON形式で出力しませんでした。');
  }

  return parsed;
}
