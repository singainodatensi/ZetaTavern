# ZetaTavern

**Zeta** と **SillyTavern** のいいとこ取りを目指した、ブラウザ完結の AI ストーリーテリング PWA。

- 本番 URL: https://singainodatensi.github.io/ZetaTavern/
- リポジトリ: https://github.com/singainodatensi/ZetaTavern

---

## このプロジェクトが目指すもの

### 開発経緯（なぜ作ったか）

| ツール | 強み | 弱み |
|--------|------|------|
| **SillyTavern** | キャラクター単位の設定・口調・カードが強い | 複数キャラの「ストーリー」が弱い。まとめても順番に喋るだけになりがち |
| **Zeta** | 複数キャラ・シーン・関係性を含む物語の進行が理想的 | モデル性能が低く物忘れが多い。長編向きではない |

**ZetaTavern** はこの両方を補い合わせるために作られた。

- SillyTavern 的な **キャラクターライブラリ**（JSON カード、口調サンプル、アバター）
- Zeta 的な **ストーリー単位の進行**（シーン状態、登場役割、関係性メモ、執筆ルール、世界設定）
- その上で **Gemini など高性能モデル** をクライアントから直接叩ける構成

### 目指すプレイ体験（理想像）

ユーザーは **主人公** として台詞・行動を入力し、AI ストーリーテラーが世界を描写する。

| 要素 | あるべき姿 |
|------|------------|
| **ユーザー** | 主人公のセリフ・行動を入力 |
| **ナレーター** | 地の文（状況描写・心理の「見せ方」）を表示 |
| **キャラクター** | 登場人物ごとに **アイコン** と **吹き出し** で台詞 |
| **ストーリー** | 複数キャラが同時に関わるシーンを、役割（Main / Support / Background）で制御 |
| **選択肢** | 必要に応じて A/B/C で次の主人公行動を提示 |

つまり「小説を一塊で流す」のではなく、**ビジュアルノベル／チャット RPG に近い UI** が最終目標。

---

## 現状（2026年5月時点）

### できていること

- ストーリー複数管理（IndexedDB）
- キャラクターライブラリ（作成・編集・JSON 入出力）
- ストーリーごとの執筆ルール・世界設定・主人公設定
- サイドバーでの **シーン状態**（場所・時間・雰囲気・目的）
- キャラごとの **登場役割**（Main / Support / Background / Absent）
- 好感度・関係メモ・キャラ状態（手動更新 → プロンプトに反映）
- Gemini API 連携（モデル選択、カスタムモデル、思考パート除外）
- A/B/C 選択肢のパースとボタン表示
- **小説表示（novel）** と **チャット表示（chat）** の切替 UI（ヘッダー）
- Dropbox 同期（PKCE、Push/Pull、画像アセット）
- PWA（Service Worker、オフラインキャッシュ）

### まだ理想に届いていないこと（重要）

| 項目 | 現状 | あるべき姿 |
|------|------|------------|
| **チャット表示** | AI 返答を **1つの塊**（`Storyteller`）として Markdown 表示。実質「小説ビューに近い」 | 地の文と台詞を **分解**し、キャラごとに吹き出し + アイコン |
| **キャラアイコン** | 主人公のみ（ユーザーメッセージ側）。AI 返答側はデフォルトシルエット | ライブラリの `avatarAssetId` を名前と紐付けて表示 |
| **AI による状態更新** | シーン・記憶は **ユーザー手入力** のみ | （将来）返答から状態をパースして自動更新する余地あり |
| **README / 設計共有** | 本ファイルで補完 | 機能追加時にここを更新すること |

> **複数 AI で開発している場合**  
> チャット UI を直すときは `js/ui.js` の `renderStory()`（`uiMode === 'chat'` 分支）と、AI 出力の **パーサ新設** が中心になる。いまは `role: model` の全文をそのまま描画しているだけ。

---

## 技術スタック

- 素の **HTML / CSS / JavaScript（ES Modules）**
- ビルドツールなし
- データ: **IndexedDB**（`js/db.js`）
- AI: **Google Gemini** `generateContent`（`js/ai-client.js`）
- 同期: **Dropbox API**（`js/dropbox.js`）— 手順は [DROPBOX_SETUP.md](./DROPBOX_SETUP.md)
- ホスティング: **GitHub Pages**

---

## ファイル構成と責務

```
ZetaTavern/
├── index.html          # 画面骨格（ストーリー／ライブラリ／設定）
├── style.css           # UI スタイル
├── manifest.json       # PWA
├── sw.js               # Service Worker（JS/HTML はネットワーク優先）
├── marked.js           # Markdown レンダリング（オフライン同梱）
└── js/
    ├── app.js          # 起動・イベント・ターン送信・Dropbox UI
    ├── state.js        # メモリ上の状態・subscribe
    ├── db.js           # IndexedDB（stories / characters / assets / settings）
    ├── ui.js           # 描画・選択肢・キャラモーダル・ライブラリ
    ├── ai-client.js    # プロンプト構築・Gemini 呼び出し・思考フィルタ
    ├── dropbox.js      # OAuth PKCE・Push/Pull
    └── sanitizer.js    # XSS 対策・escapeHTML
```

### データモデル（概要）

**Story（`stories` ストア）**

- `storyId`, `title`, `timestamp`
- `storytellerPrompt` … 執筆ルール
- `worldPrompt` … 世界観
- `protagonist` … `{ name, description, avatarAssetId }`
- `characters[]` … `{ characterId, attendance }`（`main` | `support` | `background` | `absent`）
- `messages[]` … `{ role: 'user' | 'model', content, timestamp }`
- `sceneState` … `{ location, timeOfDay, atmosphere, currentObjective }`
- `characterMemory`, `relationshipMemory` … キャラ ID キーのオブジェクト

**Character（`characters` ストア）**

- `characterId`, `name`, `description`, `personality`, `mes_example`, `avatarAssetId`

**Settings（`settings` ストア）**

- `api_key`, `model_name`, `show_choices`, `dropbox_app_key`, `dropboxTokens`, など

---

## ローカル開発・デプロイ

### ローカルで動かす

静的ファイルのため、ルートで HTTP サーバを立てる（`file://` では SW / IndexedDB が不安定になりやすい）。

```bash
# 例: Python
cd ZetaTavern
python -m http.server 8080
# → http://localhost:8080/ZetaTavern/ のようにパスに注意
```

### GitHub Pages

`main` ブランチを Pages のソースにし、リポジトリ名が `ZetaTavern` なら  
`https://<user>.github.io/ZetaTavern/` で公開される。

デプロイ後は **Service Worker の Unregister** とハードリロードを推奨（古い JS が残りやすい）。

### 初回セットアップ（利用者向け）

1. 設定 → **Gemini API キー** を入力
2. モデル選択（推奨: `gemini-2.5-flash`）
3. キャラクターをライブラリに登録
4. ストーリー作成 → サイドバーで登場キャラの役割を設定
5. （任意）Dropbox 連携 — [DROPBOX_SETUP.md](./DROPBOX_SETUP.md)

---

## AI 連携の注意（開発者・引き継ぎ用）

### プロンプト

`ai-client.js` の `buildSystemInstruction()` が毎ターンのシステム指示を組み立てる。

- 執筆ルール・世界観・主人公・**登場中キャラのみ**・シーン状態・記憶
- **出力形式**: 日本語の物語本文のみ（英語の思考メモ禁止）

### Gemini 2.5 の「思考」

- `thinkingConfig.thinkingBudget: 0`（Flash 系）で思考オフ
- `part.thought === true` のパートは `extractStoryTextFromApiResponse()` で除外
- 漏れ英語メモは `stripLeakedThinkingText()` で救済

### 既知の落とし穴

- `maxOutputTokens` を小さくしすぎると本文が短くなる（現在 8192）
- `gemini-2.5-pro` は思考を完全オフにできない
- 会話履歴は `messages` をそのまま API に渡す。長くなるとコンテキスト圧迫

---

## 設計検討：キャラクターとモブ

### 「主要 / 補助 / 背景 / 不在」の役割

**現状の意図:** 1ターンに渡すプロンプトの量を抑えつつ、シーンに関わるキャラだけ詳細設定を載せる。

| 役割 | プロンプトへの載せ方 |
|------|---------------------|
| 主要 (main) | 設定・口調サンプルまで全文 |
| 補助 (support) | 要約 + 性格 |
| 背景 (background) | 名前と「その場にいる」程度 |
| 不在 (absent) | プロンプトから除外 |

**微妙な点:** UI 上の4段階は初心者には分かりにくく、AI には「背景」と「補助」の差が伝わりにくい。

**今後の方向性（案）:**

- 短期: そのまま使うが、UI ラベルを簡略化（例: 「このシーンに出す / 出さない」+ 詳細度スライダー）
- 中期: 役割を **「登場」フラグ + 詳細度（高/低）」** の2軸に整理
- プロンプト構築ロジック（`ai-client.js`）は役割名が変わっても同じ考え方でよい

### ユーザーが全キャラを用意する必要はあるか？

**必須ではない。** 目標は次のハイブリッド。

| 方式 | 内容 | 優先 |
|------|------|------|
| **A. モブ表示（Zeta 方式）** | ライブラリに無い名前 → **デフォルトシルエット** + 吹き出しで表示。プロンプトには「未登録の通行人」程度 | **まず実装**（チャット UI 本実装時） |
| **B. 自動リスト追加** | AI が新規名を出したら **暫定キャラ** として `characters` に追加。ユーザーが後からアイコン・設定を肉付け | **ロードマップ**（アイマス級の大量キャラ向け） |

**推奨フロー（将来）:**

1. パースで登場名を検出
2. ライブラリに一致 → そのアバター
3. 未登録 → シルエットで表示 + 「暫定キャラ」として一覧に追加（`attendance: background`, `autoGenerated: true` など）
4. ユーザーが編集画面で正式登録

これなら「最初から全員カードを作る」負担を避けつつ、後から好きなキャラだけ育てられる。

---

## ロードマップ（優先度の目安）

1. **チャット UI の本実装** — AI 出力を「地の文 / キャラ台詞」にパースし、吹き出し + アイコン表示（`ui.js`）
2. **ストーリーテラー用ナレーター表示** — 地の文専用スタイル（アイコンなし or 共通アイコン）
3. **登場キャラ名とライブラリのファジーマッチ** — 「四葉」「中野四葉」など
4. **（任意）AI 返答からの sceneState / 記憶更新** — JSON ブロック等の設計が必要
5. **README / CHANGELOG の更新習慣** — 複数 AI 開発時の必須
6. **モブの自動リスト追加（B）** — 暫定キャラ + 後から肉付け

### モバイル UI（2026-05 対応済み）

- ヘッダー nav: 狭い画面では **アイコンのみ**（ラベル非表示で縦折り崩れ防止）
- ストーリー画面: `70vh` 固定をやめ **flex で入力欄を下部固定**（下部の謎余白を解消）
- 入力欄: `min-height` 拡大、`100dvh` + `safe-area-inset-bottom`
- Enter: **スマホでは改行のみ**、送信は送信ボタン（PC は Enter で送信、Shift+Enter で改行）

---

## ライセンス・貢献

- 個人プロジェクト。貢献・フォークは歓迎。
- 機能を直すときは **この README の「目指すもの」「現状」** を先に読み、ズレた実装（特に UI）を増やさないこと。

---

## 関連ドキュメント

- [DROPBOX_SETUP.md](./DROPBOX_SETUP.md) — Dropbox OAuth / Redirect URI / App key
