/**
 * dropbox.js - ZetaTavern Dropbox Sync Module (ES Module版)
 * 旧プロジェクト(Gemini-PWA-Mk-IInotGCS)のDropbox連携ロジックをZetaTavern向けにES Module化。
 * db.js の getSetting / saveSetting を利用してトークン情報を IndexedDB に永続化する。
 *
 * 同期対象:
 *   - /ZetaTavern_data.json  … stories + characters のメタデータ (Blob除く)
 *   - /ZetaTavern_Assets/    … キャラ・主人公のアバター画像 (Blob → バイナリ)
 */

import { getSetting, saveSetting } from './db.js';

// ============================================================
// 定数
// ============================================================

export const APP_KEY         = 'lk117tt6k0vfkb8'; // 先頭に export を付け、ご自身のキーに変更
const METADATA_PATH   = '/ZetaTavern_data.json';
const ASSETS_DIR_PATH = '/ZetaTavern_Assets';
const LOCK_PATH       = '/.zetatavern_sync_lock';
const TOKENS_KEY      = 'dropboxTokens';

// ============================================================
// 内部ヘルパー
// ============================================================

async function _getTokens() {
  return getSetting(TOKENS_KEY, null);
}

async function _saveTokens(tokens) {
  await saveSetting(TOKENS_KEY, tokens);
}

async function _refreshAccessToken(refreshToken) {
  console.log('[Dropbox] アクセストークンを更新中...');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     APP_KEY,
  });

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error_description || 'トークン更新に失敗しました');
  }

  const data = await response.json();
  const current = await _getTokens() || {};
  const updated = {
    ...current,
    ...data,
    expires_at: Date.now() + (data.expires_in - 300) * 1000,
  };
  await _saveTokens(updated);
  console.log('[Dropbox] トークン更新完了。');
  return updated;
}

/**
 * Dropbox API への共通リクエスト関数。
 * 401 を受けた場合は一度だけトークンをリフレッシュしてリトライする。
 *
 * @param {'api'|'content'} domain
 * @param {string} endpoint
 * @param {object} [options={}]
 * @param {number} [retryCount=0]
 */
async function _request(domain, endpoint, options = {}, retryCount = 0) {
  let tokens = await _getTokens();
  if (!tokens || !tokens.access_token) {
    throw new Error('Dropbox が未接続です。先に連携してください。');
  }

  // トークンが期限切れなら事前にリフレッシュ
  if (Date.now() >= tokens.expires_at) {
    if (!tokens.refresh_token) {
      await disconnect();
      throw new Error('セッションが期限切れです。再度 Dropbox と連携してください。');
    }
    tokens = await _refreshAccessToken(tokens.refresh_token);
  }

  const url = `https://${domain}.dropboxapi.com/2${endpoint}`;
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    ...options.headers,
  };

  try {
    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      // 401 → トークンリフレッシュ → 1回だけリトライ
      if (response.status === 401 && retryCount === 0) {
        console.log('[Dropbox] 401 受信。トークンをリフレッシュしてリトライ...');
        tokens = await _refreshAccessToken(tokens.refresh_token);
        return _request(domain, endpoint, options, 1);
      }

      let errMsg = `Dropbox API エラー (${response.status}): ${response.statusText}`;
      try {
        const errJson = await response.json();
        errMsg = errJson.error_summary || JSON.stringify(errJson.error) || errMsg;
      } catch (_) { /* ignore */ }
      throw new Error(errMsg);
    }

    // ダウンロード系は Blob で返す
    if (endpoint === '/files/download') {
      return response.blob();
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};

  } catch (error) {
    if (!error.message.includes('not_found')) {
      console.error(`[Dropbox] リクエストエラー (${endpoint}):`, error);
    }
    throw error;
  }
}

// ============================================================
// 認証 Public API
// ============================================================

/**
 * PKCE フロー用の code_verifier / code_challenge を生成する。
 */
export async function generatePKCE() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return { codeVerifier, codeChallenge };
}

/**
 * 認可コードとコードベリファイアを使ってアクセストークンを取得・保存する。
 */
export async function getAccessToken(code, redirectUri, codeVerifier) {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
    client_id:     APP_KEY,
    code_verifier: codeVerifier,
  });

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error_description || `トークン取得エラー (${response.status})`);
  }

  const tokenData = await response.json();
  tokenData.expires_at = Date.now() + (tokenData.expires_in - 300) * 1000;
  await _saveTokens(tokenData);
  return tokenData;
}

/**
 * 接続テスト (現在のユーザー情報を取得)
 */
export async function testConnection() {
  return _request('api', '/users/get_current_account', { method: 'POST' });
}

/**
 * Dropbox との連携を解除し、ローカルトークンを削除する。
 */
export async function disconnect() {
  const tokens = await _getTokens();
  if (tokens && tokens.access_token) {
    try {
      await _request('api', '/auth/token/revoke', { method: 'POST' });
    } catch (e) {
      console.warn('[Dropbox] サーバー側のトークン失効に失敗しましたが、ローカルは削除します。', e);
    }
  }
  await saveSetting(TOKENS_KEY, null);
  console.log('[Dropbox] 連携を解除しました。');
}

/**
 * 現在の接続状態を確認する。トークンが存在し、有効かどうかを返す。
 */
export async function isConnected() {
  const tokens = await _getTokens();
  return !!(tokens && tokens.access_token);
}

// ============================================================
// メタデータ (stories + characters) の同期
// ============================================================

/**
 * ZetaTavern の stories + characters 全データを Dropbox にアップロードする。
 * アバター画像 (Blob) は除外し、assetId のみ保持する。
 */
export async function uploadMetadata(stories, characters) {
  const payload = JSON.stringify({ stories, characters, exportedAt: Date.now() });
  const args = { path: METADATA_PATH, mode: 'overwrite', mute: true };

  return _request('content', '/files/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify(args),
    },
    body: payload,
  });
}

/**
 * Dropbox から stories + characters のメタデータを取得する。
 * ファイルが存在しない場合は null を返す。
 */
export async function downloadMetadata() {
  const args = { path: METADATA_PATH };
  try {
    const blob = await _request('content', '/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify(args) },
    });
    return blob.text();
  } catch (error) {
    if (error.message.includes('path/not_found')) return null;
    throw error;
  }
}

// ============================================================
// アセット (Blob 画像) の同期
// ============================================================

/**
 * アセットフォルダの存在を保証する。なければ作成する。
 */
export async function ensureAssetsFolderExists() {
  try {
    await _request('api', '/files/get_metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ASSETS_DIR_PATH }),
    });
  } catch (error) {
    if (error.message.includes('path/not_found')) {
      console.log(`[Dropbox] アセットフォルダを作成: ${ASSETS_DIR_PATH}`);
      await _request('api', '/files/create_folder_v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ASSETS_DIR_PATH, autorename: false }),
      });
    } else {
      throw error;
    }
  }
}

/**
 * 単一のアセット Blob を Dropbox にアップロードする。
 */
export async function uploadAsset(blob, assetId) {
  const path = `${ASSETS_DIR_PATH}/${assetId}`;
  const args = { path, mode: 'overwrite', mute: true };
  return _request('content', '/files/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify(args),
    },
    body: blob,
  });
}

/**
 * 単一のアセットを Dropbox からダウンロードし Blob を返す。
 * ファイルが存在しない場合は null を返す。
 */
export async function downloadAsset(assetId) {
  const path = `${ASSETS_DIR_PATH}/${assetId}`;
  const args = { path };
  try {
    return await _request('content', '/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify(args) },
    });
  } catch (error) {
    if (error.message.includes('path/not_found')) {
      console.warn(`[Dropbox] アセットがクラウドに見つかりません: ${assetId}`);
      return null;
    }
    throw error;
  }
}

/**
 * Dropbox 上のアセット一覧を取得する。
 */
export async function listRemoteAssets() {
  let entries = [];
  let cursor  = null;
  let hasMore = true;

  try {
    while (hasMore) {
      let res;
      if (cursor) {
        res = await _request('api', '/files/list_folder/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor }),
        });
      } else {
        res = await _request('api', '/files/list_folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: ASSETS_DIR_PATH, recursive: false, limit: 2000 }),
        });
      }
      entries = entries.concat(res.entries || []);
      hasMore = res.has_more;
      cursor  = res.cursor;
    }
    return entries;
  } catch (error) {
    if (error.message.includes('path/not_found')) return [];
    throw error;
  }
}

/**
 * 複数アセットをバッチアップロードする (5件ごとに1秒のウェイトを入れてレート制限を回避)
 *
 * @param {Array<{assetId: string, blob: Blob}>} items
 * @param {Function} [progressCallback] - (current, total) => void
 */
export async function uploadAssetsInBatches(items, progressCallback) {
  if (!items || items.length === 0) return;
  const BATCH_SIZE = 5;
  const DELAY_MS   = 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < items.length; i++) {
    const { assetId, blob } = items[i];
    if (progressCallback) progressCallback(i + 1, items.length);

    try {
      await uploadAsset(blob, assetId);
      console.log(`[Dropbox] アセットをアップロード: ${assetId} (${i + 1}/${items.length})`);
    } catch (error) {
      console.error(`[Dropbox] アセットのアップロードに失敗: ${assetId}`, error);
      throw new Error(`アセット ${assetId} のアップロードに失敗しました: ${error.message}`);
    }

    if ((i + 1) % BATCH_SIZE === 0 && i < items.length - 1) {
      console.log(`[Dropbox] バッチ間の待機 ${DELAY_MS}ms...`);
      await sleep(DELAY_MS);
    }
  }
  console.log(`[Dropbox] バッチアップロード完了 (${items.length}件)`);
}

// ============================================================
// ロックファイル (排他制御)
// ============================================================

export async function uploadLockFile(operation) {
  const body = JSON.stringify({ timestamp: new Date().toISOString(), operation });
  return _request('content', '/files/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: LOCK_PATH, mode: 'overwrite', mute: true }),
    },
    body,
  });
}

export async function deleteLockFile() {
  try {
    return await _request('api', '/files/delete_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: LOCK_PATH }),
    });
  } catch (error) {
    if (error.message.includes('not_found')) return null;
    throw error;
  }
}

export async function checkLockFile() {
  try {
    const blob = await _request('content', '/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path: LOCK_PATH }) },
    });
    const text = await blob.text();
    return JSON.parse(text);
  } catch (error) {
    if (error.message.includes('path/not_found')) return null;
    throw error;
  }
}

// ============================================================
// 高レベル 同期 API  (Push / Pull)
// ============================================================

/**
 * ローカル → Dropbox へのフルプッシュ同期。
 * 1. ロックファイル取得
 * 2. メタデータ (stories, characters) をアップロード
 * 3. アセットフォルダ保証 → ローカルに存在するアセットをバッチアップロード
 * 4. ロックファイル削除
 *
 * @param {object} opts
 * @param {Array}  opts.stories
 * @param {Array}  opts.characters
 * @param {Array}  opts.assets  - [{ assetId, blob }]
 * @param {Function} [opts.onProgress]  - (message: string) => void
 */
export async function pushToDropbox({ stories, characters, assets, onProgress }) {
  const progress = msg => { console.log('[Dropbox Push]', msg); if (onProgress) onProgress(msg); };

  progress('同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('push');
  try {
    progress('メタデータをアップロード中...');
    await uploadMetadata(stories, characters);

    progress('アセットフォルダを確認中...');
    await ensureAssetsFolderExists();

    if (assets && assets.length > 0) {
      progress(`${assets.length}件のアセットをアップロード中...`);
      await uploadAssetsInBatches(assets, (cur, tot) => progress(`アセット ${cur}/${tot} をアップロード中...`));
    }

    progress('プッシュ完了！');
  } finally {
    await deleteLockFile();
  }
}

/**
 * Dropbox → ローカル へのフルプル同期。
 * メタデータをダウンロードし、ローカルに存在しないアセットを取得して返す。
 *
 * @param {object} opts
 * @param {Set<string>} opts.localAssetIds  - ローカルにすでに存在するアセットIDの集合
 * @param {Function} [opts.onProgress]
 * @returns {{ stories: Array, characters: Array, newAssets: Array<{assetId, blob}> }}
 */
export async function pullFromDropbox({ localAssetIds, onProgress }) {
  const progress = msg => { console.log('[Dropbox Pull]', msg); if (onProgress) onProgress(msg); };

  progress('クラウドからデータを取得中...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('pull');
  try {
    const metaText = await downloadMetadata();
    if (!metaText) {
      progress('クラウドにデータがありませんでした。');
      return { stories: null, characters: null, newAssets: [] };
    }

    const { stories, characters } = JSON.parse(metaText);

    // 必要なアセットIDを収集
    const requiredAssetIds = new Set();
    [...(stories || []), ...(characters || [])].forEach(item => {
      if (item.protagonist?.avatarAssetId) requiredAssetIds.add(item.protagonist.avatarAssetId);
      if (item.avatarAssetId) requiredAssetIds.add(item.avatarAssetId);
    });

    // ローカルに存在しないアセットだけダウンロード
    const missingIds = [...requiredAssetIds].filter(id => id && !localAssetIds.has(id));
    const newAssets = [];

    if (missingIds.length > 0) {
      progress(`${missingIds.length}件のアセットをダウンロード中...`);
      for (let i = 0; i < missingIds.length; i++) {
        const assetId = missingIds[i];
        progress(`アセット ${i + 1}/${missingIds.length} をダウンロード中...`);
        const blob = await downloadAsset(assetId);
        if (blob) {
          newAssets.push({ assetId, blob });
        }
      }
    }

    progress('プル完了！');
    return { stories, characters, newAssets };
  } finally {
    await deleteLockFile();
  }
}
