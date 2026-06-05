# Dropbox 連携セットアップ（ZetaTavern）

## 1. Dropbox アプリを作成

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) でアプリを作成
2. **Scoped access** を選択
3. **Full Dropbox** または **App folder**（どちらでも `/ZetaTavern_data.json` 形式のパスは利用可能）
4. 権限（Permissions）で最低限:
   - `account_info.read`
   - `files.content.read`
   - `files.content.write`

## 2. Redirect URI を登録（最重要）

**Settings → Redirect URIs** に、次を **完全一致** で追加:

```
https://singainodatensi.github.io/ZetaTavern/
```

- 末尾の `/` を忘れないこと
- `index.html` を付けないこと
- `http://` 版は本番では不要（ローカル検証時のみ `http://localhost:.../` を追加可）

## 3. App key をコードに設定

`js/dropbox.js` の `APP_KEY` を、作成したアプリの **App key** に置き換える。

```javascript
export const APP_KEY = 'あなたのアプリキー';
```

`js/app.js` の認証 URL はこの定数を参照するため、両方のファイルでキーが一致している必要はありません（dropbox.js のみ）。

## 4. デプロイ後の確認

1. https://singainodatensi.github.io/ZetaTavern/ を開く
2. 設定 → 「Dropbox と連携する」
3. 許可後、同じ URL に戻り「連携が完了」と表示されること
4. 「クラウドへ保存 (Push)」で初回バックアップ

## よくあるエラー

| メッセージ | 原因 |
|----------|------|
| `invalid_redirect_uri` | Redirect URI 未登録、または末尾スラッシュ不一致 |
| `セッション不一致` | 別ブラウザ/プライベートモード、または古い SW キャッシュ。ハードリロード後に再試行 |
| `invalid_grant` | 認可コードの期限切れ。もう一度連携からやり直す |
| Push で API エラー | アプリの files 権限不足、または別端末の同期ロック残り |

## キャッシュのクリア

修正後も連携できない場合:

1. ブラウザでサイトのデータを削除、または
2. DevTools → Application → Service Workers → Unregister
3. ページを再読み込み
