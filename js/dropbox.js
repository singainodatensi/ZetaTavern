/**
 * dropbox.js - ZetaTavern Dropbox Sync Module (ES Module版)
 * 旧プロジェクト(Gemini-PWA-Mk-IInotGCS)のDropbox連携ロジックをZetaTavern向けにES Module化。
 * db.js の getSetting / saveSetting を利用してトークン情報を IndexedDB に永続化する。
 *
 * 同期対象:
 *   - /ZetaTavern_data.json  … stories + characters + settings のメタデータ (Blob除く)
 *   - /ZetaTavern_Assets/    … キャラ・主人公のアバター画像 (Blob → バイナリ)
 */

import { getSetting, saveSetting } from './db.js?v=20260606c';

// ============================================================
// 定数
// ============================================================

/** コード内デフォルト（設定画面で上書き可能） */
export const DEFAULT_APP_KEY = 'lk117tt6k0vfkb8';
/** @deprecated getAppKey() を使用 */
export const APP_KEY = DEFAULT_APP_KEY;

/** GitHub Pages 本番で Dropbox アプリに登録するリダイレクト URI（末尾スラッシュ必須） */
export const PRODUCTION_OAUTH_REDIRECT_URI = 'https://singainodatensi.github.io/ZetaTavern/';

const DROPBOX_APP_KEY_SETTING = 'dropbox_app_key';

/**
 * 認可・トークン交換の両方で使う App key（設定画面の値を優先）
 */
export async function getAppKey() {
  const stored = await getSetting(DROPBOX_APP_KEY_SETTING, '');
  const key = (typeof stored === 'string' ? stored : '').trim();
  return key || DEFAULT_APP_KEY;
}

const METADATA_PATH   = '/ZetaTavern_data.json';
const ASSETS_DIR_PATH = '/ZetaTavern_Assets';
const LOCK_PATH       = '/.zetatavern_sync_lock';
const TOKENS_KEY      = 'dropboxTokens';
const CLIENT_ID_KEY   = 'dropboxClientId';
const LOCK_TTL_MS     = 30 * 60 * 1000;
const V2_ROOT         = '/ZetaTavern/v2';
const V2_MANIFEST     = `${V2_ROOT}/manifest.json`;
const V2_SETTINGS     = `${V2_ROOT}/settings.json`;
const V2_CHAR_DIR     = `${V2_ROOT}/characters`;
const V2_STORY_DIR    = `${V2_ROOT}/stories`;
const MESSAGE_CHUNK_SIZE = 100;

// ============================================================
// 内部ヘルパー
// ============================================================

/**
 * OAuth で使う redirect_uri を固定化する。
 * window.location そのままだと index.html の有無や末尾スラッシュで Dropbox 登録値とずれて失敗する。
 */
export function getOAuthRedirectUri() {
  const host = window.location.hostname;
  if (host === 'singainodatensi.github.io') {
    return PRODUCTION_OAUTH_REDIRECT_URI;
  }

  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/index\.html$/i, '/');
  if (!path.endsWith('/')) {
    path = path.substring(0, path.lastIndexOf('/') + 1) || '/';
  }
  url.pathname = path;
  return url.toString();
}

function _applyTokenExpiry(tokens) {
  if (!tokens) return tokens;
  const expiresIn = Number(tokens.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    tokens.expires_at = Date.now() + (expiresIn - 300) * 1000;
  } else if (!Number.isFinite(tokens.expires_at)) {
    // 期限情報が無い場合は 4 時間後に再取得を試みる
    tokens.expires_at = Date.now() + 4 * 60 * 60 * 1000;
  }
  return tokens;
}

function _isTokenExpired(tokens) {
  return Number.isFinite(tokens?.expires_at) && Date.now() >= tokens.expires_at;
}

async function _getTokens() {
  return getSetting(TOKENS_KEY, null);
}

async function _saveTokens(tokens) {
  await saveSetting(TOKENS_KEY, tokens);
}

function _buildDropboxCorsSafeFetch(domain, endpoint, accessToken, options = {}) {
  const requestUrl = new URL(`https://${domain}.dropboxapi.com/2${endpoint}`);
  const sourceHeaders = new Headers(options.headers || {});
  const method = String(options.method || 'POST').toUpperCase();
  const corsSafeOptions = {
    ...options,
    method,
    mode: 'cors',
    headers: {},
  };

  requestUrl.searchParams.set('authorization', `Bearer ${accessToken}`);
  requestUrl.searchParams.set('reject_cors_preflight', 'true');

  const dropboxArg = sourceHeaders.get('Dropbox-API-Arg');
  if (dropboxArg) {
    requestUrl.searchParams.set('arg', dropboxArg);
  }

  if (endpoint === '/files/download') {
    corsSafeOptions.method = 'GET';
    delete corsSafeOptions.body;
    return { url: requestUrl.toString(), options: corsSafeOptions };
  }

  corsSafeOptions.headers = {
    'Content-Type': 'text/plain; charset=dropbox-cors-hack',
  };

  return { url: requestUrl.toString(), options: corsSafeOptions };
}

async function _readDropboxErrorResponse(response) {
  const text = await response.text().catch(() => '');
  if (!text) {
    return `Dropbox API エラー (${response.status}): ${response.statusText}`;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed.error_summary || JSON.stringify(parsed.error) || text;
  } catch (_) {
    return text;
  }
}

async function _getClientId() {
  let id = await getSetting(CLIENT_ID_KEY, '');
  if (!id) {
    id = crypto.randomUUID();
    await saveSetting(CLIENT_ID_KEY, id);
  }
  return id;
}

async function _refreshAccessToken(refreshToken) {
  console.log('[Dropbox] アクセストークンを更新中...');
  const clientId = await getAppKey();
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
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
  const updated = _applyTokenExpiry({ ...current, ...data });
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
  if (_isTokenExpired(tokens)) {
    if (!tokens.refresh_token) {
      await disconnect();
      throw new Error('セッションが期限切れです。再度 Dropbox と連携してください。');
    }
    tokens = await _refreshAccessToken(tokens.refresh_token);
  }

  const request = _buildDropboxCorsSafeFetch(domain, endpoint, tokens.access_token, options);

  try {
    const response = await fetch(request.url, request.options);

    if (!response.ok) {
      // 401 → トークンリフレッシュ → 1回だけリトライ
      if (response.status === 401 && retryCount === 0) {
        console.log('[Dropbox] 401 受信。トークンをリフレッシュしてリトライ...');
        tokens = await _refreshAccessToken(tokens.refresh_token);
        return _request(domain, endpoint, options, 1);
      }

      const errMsg = await _readDropboxErrorResponse(response);
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
export async function getAccessToken(code, redirectUri, codeVerifier, clientId) {
  const appKey = (clientId && String(clientId).trim()) || await getAppKey();
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
    client_id:     appKey,
    code_verifier: codeVerifier,
  });

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const detail = err.error_description || err.error || err.error_summary || JSON.stringify(err);
    throw new Error(`${detail} (HTTP ${response.status})`);
  }

  const tokenData = _applyTokenExpiry(await response.json());
  if (!tokenData.access_token) {
    throw new Error('Dropbox からアクセストークンを取得できませんでした。');
  }
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
// メタデータ (stories + characters + settings) の同期
// ============================================================

/**
 * ZetaTavern の stories + characters + settings 全データを Dropbox にアップロードする。
 * アバター画像 (Blob) は除外し、assetId のみ保持する。
 */
export async function uploadMetadata(stories, characters, settings = {}) {
  const payload = JSON.stringify({ stories, characters, settings, exportedAt: Date.now() });
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

async function uploadJson(path, value) {
  const payload = JSON.stringify(value);
  const args = { path, mode: 'overwrite', mute: true };
  return _request('content', '/files/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify(args),
    },
    body: payload,
  });
}

async function downloadJson(path) {
  try {
    const blob = await _request('content', '/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path }) },
    });
    return JSON.parse(await blob.text());
  } catch (error) {
    if (error.message.includes('path/not_found')) return null;
    throw error;
  }
}

async function ensureFolderExists(path) {
  try {
    await _request('api', '/files/get_metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch (error) {
    if (error.message.includes('path/not_found')) {
      await _request('api', '/files/create_folder_v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, autorename: false }),
      });
      return;
    }
    throw error;
  }
}

function splitStoryForSync(story) {
  const { messages = [], ...meta } = story || {};
  const chunks = [];
  for (let i = 0; i < messages.length; i += MESSAGE_CHUNK_SIZE) {
    chunks.push(messages.slice(i, i + MESSAGE_CHUNK_SIZE));
  }
  if (chunks.length === 0) chunks.push([]);
  return { meta, chunks };
}

async function uploadV2Data({ stories = [], characters = [], settings = {}, onProgress }) {
  const now = Date.now();
  const progress = msg => { if (onProgress) onProgress(msg); };

  await ensureFolderExists('/ZetaTavern');
  await ensureFolderExists(V2_ROOT);
  await ensureFolderExists(V2_CHAR_DIR);
  await ensureFolderExists(V2_STORY_DIR);

  progress('設定を分割アップロード中...');
  await uploadJson(V2_SETTINGS, { settings, updatedAt: now });

  const manifest = {
    schemaVersion: 2,
    updatedAt: now,
    settingsPath: V2_SETTINGS,
    characters: {},
    stories: {}
  };

  progress(`キャラクター ${characters.length} 件を同期中...`);
  for (const character of characters) {
    if (!character?.characterId) continue;
    const path = `${V2_CHAR_DIR}/${character.characterId}.json`;
    await uploadJson(path, character);
    manifest.characters[character.characterId] = {
      path,
      updatedAt: character.timestamp || now
    };
  }

  progress(`ストーリー ${stories.length} 件を同期中...`);
  for (const story of stories) {
    if (!story?.storyId) continue;
    manifest.stories[story.storyId] = await uploadV2Story(story, now);
  }

  progress('同期目次を更新中...');
  await uploadJson(V2_MANIFEST, manifest);
  return manifest;
}

async function uploadV2Story(story, now = Date.now()) {
  const storyDir = `${V2_STORY_DIR}/${story.storyId}`;
  await ensureFolderExists(storyDir);

  const { meta, chunks } = splitStoryForSync(story);
  const metaPath = `${storyDir}/meta.json`;
  await uploadJson(metaPath, meta);

  const messageChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkName = `messages_${String(i + 1).padStart(4, '0')}.json`;
    const chunkPath = `${storyDir}/${chunkName}`;
    await uploadJson(chunkPath, { index: i, messages: chunks[i] });
    messageChunks.push(chunkPath);
  }

  return {
    metaPath,
    messageChunks,
    messageCount: Array.isArray(story.messages) ? story.messages.length : 0,
    updatedAt: story.timestamp || now
  };
}

async function uploadV2StoryAppendDelta(story, previousEntry, now = Date.now()) {
  if (!previousEntry || !Number.isFinite(previousEntry.messageCount)) {
    return uploadV2Story(story, now);
  }

  const storyDir = `${V2_STORY_DIR}/${story.storyId}`;
  await ensureFolderExists(storyDir);

  const { meta, chunks } = splitStoryForSync(story);
  const nextMessageCount = Array.isArray(story.messages) ? story.messages.length : 0;
  if (nextMessageCount < previousEntry.messageCount) {
    return uploadV2Story(story, now);
  }

  const metaPath = `${storyDir}/meta.json`;
  await uploadJson(metaPath, meta);

  const messageChunks = chunks.map((_, index) => {
    const chunkName = `messages_${String(index + 1).padStart(4, '0')}.json`;
    return `${storyDir}/${chunkName}`;
  });

  const firstChangedChunk = Math.max(0, Math.floor(Math.max(previousEntry.messageCount - 1, 0) / MESSAGE_CHUNK_SIZE));
  for (let i = firstChangedChunk; i < chunks.length; i++) {
    await uploadJson(messageChunks[i], { index: i, messages: chunks[i] });
  }

  return {
    metaPath,
    messageChunks,
    messageCount: nextMessageCount,
    updatedAt: story.timestamp || now
  };
}

async function downloadV2Data({ localAssetIds, onProgress }) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  const manifest = await downloadJson(V2_MANIFEST);
  if (!manifest || manifest.schemaVersion !== 2) return null;

  progress('同期目次を取得しました。差分を復元中...');
  const settingsPayload = await downloadJson(manifest.settingsPath || V2_SETTINGS);
  const settings = settingsPayload?.settings || {};

  const characters = [];
  for (const entry of Object.values(manifest.characters || {})) {
    const character = await downloadJson(entry.path);
    if (character) characters.push(character);
  }

  const stories = [];
  for (const entry of Object.values(manifest.stories || {})) {
    const meta = await downloadJson(entry.metaPath);
    if (!meta) continue;
    const messages = [];
    for (const chunkPath of entry.messageChunks || []) {
      const chunk = await downloadJson(chunkPath);
      if (Array.isArray(chunk?.messages)) messages.push(...chunk.messages);
    }
    stories.push({ ...meta, messages });
  }

  const requiredAssetIds = new Set();
  [...stories, ...characters].forEach(item => {
    if (item.protagonist?.avatarAssetId) requiredAssetIds.add(item.protagonist.avatarAssetId);
    if (item.avatarAssetId) requiredAssetIds.add(item.avatarAssetId);
  });

  const missingIds = [...requiredAssetIds].filter(id => id && !localAssetIds.has(id));
  const newAssets = [];
  if (missingIds.length > 0) {
    progress(`不足アセット ${missingIds.length} 件を取得中...`);
    for (let i = 0; i < missingIds.length; i++) {
      const assetId = missingIds[i];
      progress(`アセット ${i + 1}/${missingIds.length} を取得中...`);
      const blob = await downloadAsset(assetId);
      if (blob) newAssets.push({ assetId, blob });
    }
  }

  return { stories, characters, settings, newAssets };
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
  const now = Date.now();
  const body = JSON.stringify({
    ownerId: await _getClientId(),
    operation,
    timestamp: new Date(now).toISOString(),
    createdAt: now,
    expiresAt: now + LOCK_TTL_MS
  });
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
    const lock = JSON.parse(text);
    const expiresAt = Number(lock.expiresAt || 0);
    const timestamp = Date.parse(lock.timestamp || '');
    const fallbackExpiresAt = Number.isFinite(timestamp) ? timestamp + LOCK_TTL_MS : 0;
    const effectiveExpiresAt = expiresAt || fallbackExpiresAt;

    if (effectiveExpiresAt && Date.now() > effectiveExpiresAt) {
      console.warn('[Dropbox] Stale sync lock detected. Removing it automatically.', lock);
      await deleteLockFile();
      return null;
    }

    return lock;
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
 * 2. メタデータ (stories, characters, settings) をアップロード
 * 3. アセットフォルダ保証 → ローカルに存在するアセットをバッチアップロード
 * 4. ロックファイル削除
 *
 * @param {object} opts
 * @param {Array}  opts.stories
 * @param {Array}  opts.characters
 * @param {object} opts.settings
 * @param {Array}  opts.assets  - [{ assetId, blob }]
 * @param {Function} [opts.onProgress]  - (message: string) => void
 */
export async function pushToDropbox({ stories, characters, settings, assets, onProgress }) {
  const progress = msg => { console.log('[Dropbox Push]', msg); if (onProgress) onProgress(msg); };

  progress('同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('push');
  try {
    progress('分割メタデータをアップロード中...');
    await uploadV2Data({ stories, characters, settings, onProgress });

    progress('アセットフォルダを確認中...');
    await ensureAssetsFolderExists();

    if (assets && assets.length > 0) {
      progress('クラウド上の既存アセットを確認中...');
      const remoteEntries = await listRemoteAssets();
      const remoteAssetIds = new Set(remoteEntries.map(entry => entry?.name).filter(Boolean));
      const assetsToUpload = assets.filter(item => item?.assetId && !remoteAssetIds.has(item.assetId));
      const skippedCount = assets.length - assetsToUpload.length;

      if (skippedCount > 0) {
        progress(`既存アセット ${skippedCount} 件をスキップします...`);
      }

      if (assetsToUpload.length > 0) {
        progress(`${assetsToUpload.length}件のアセットをアップロード中...`);
        await uploadAssetsInBatches(assetsToUpload, (cur, tot) => progress(`アセット ${cur}/${tot} をアップロード中...`));
      } else {
        progress('アップロードが必要な新規アセットはありません。');
      }
    }

    progress('プッシュ完了！');
  } finally {
    try {
      await deleteLockFile();
    } catch (error) {
      console.warn('[Dropbox] ロックファイル削除に失敗しました。期限切れ後に自動解除されます。', error);
    }
  }
}

export async function pushStoryDeltaToDropbox({ story, settings, onProgress }) {
  const progress = msg => { console.log('[Dropbox Delta Push]', msg); if (onProgress) onProgress(msg); };

  if (!story?.storyId) {
    throw new Error('差分同期するストーリーが見つかりません。');
  }

  progress('差分同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('delta-push');
  try {
    const manifest = await downloadJson(V2_MANIFEST);
    if (!manifest || manifest.schemaVersion !== 2) {
      return null;
    }

    const now = Date.now();
    await ensureFolderExists('/ZetaTavern');
    await ensureFolderExists(V2_ROOT);
    await ensureFolderExists(V2_STORY_DIR);

    if (settings) {
      progress('設定を差分アップロード中...');
      await uploadJson(manifest.settingsPath || V2_SETTINGS, { settings, updatedAt: now });
      manifest.settingsPath = manifest.settingsPath || V2_SETTINGS;
    }

    progress('現在のストーリーを差分アップロード中...');
    manifest.stories = manifest.stories || {};
    manifest.stories[story.storyId] = await uploadV2StoryAppendDelta(story, manifest.stories[story.storyId], now);
    manifest.updatedAt = now;

    progress('同期目次を更新中...');
    await uploadJson(V2_MANIFEST, manifest);
    progress('差分同期完了！');
    return manifest;
  } finally {
    try {
      await deleteLockFile();
    } catch (error) {
      console.warn('[Dropbox] ロックファイル削除に失敗しました。期限切れ後に自動解除されます。', error);
    }
  }
}

/**
 * Dropbox → ローカル へのフルプル同期。
 * メタデータをダウンロードし、ローカルに存在しないアセットを取得して返す。
 *
 * @param {object} opts
 * @param {Set<string>} opts.localAssetIds  - ローカルにすでに存在するアセットIDの集合
 * @param {Function} [opts.onProgress]
 * @returns {{ stories: Array, characters: Array, settings: object, newAssets: Array<{assetId, blob}> }}
 */
export async function pullFromDropbox({ localAssetIds, onProgress }) {
  const progress = msg => { console.log('[Dropbox Pull]', msg); if (onProgress) onProgress(msg); };

  progress('クラウドからデータを取得中...');
  const v2Data = await downloadV2Data({ localAssetIds, onProgress });
  if (v2Data) {
    progress('プル完了！');
    return v2Data;
  }

  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  const metaText = await downloadMetadata();
  if (!metaText) {
    progress('クラウドにデータがありませんでした。');
    return { stories: null, characters: null, settings: null, newAssets: [] };
  }

  const { stories, characters, settings } = JSON.parse(metaText);

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
  return { stories, characters, settings, newAssets };
}
