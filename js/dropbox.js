/**
 * dropbox.js - ZetaTavern Dropbox Sync Module (ES Module版)
 * 旧プロジェクト(Gemini-PWA-Mk-IInotGCS)のDropbox連携ロジックをZetaTavern向けにES Module化。
 * db.js の getSetting / saveSetting を利用してトークン情報を IndexedDB に永続化する。
 *
 * 同期対象:
 *   - /ZetaTavern_data.json  … stories + characters + settings のメタデータ (Blob除く)
 *   - /ZetaTavern_Assets/    … キャラ・主人公のアバター画像 (Blob → バイナリ)
 */

import { getSetting, saveSetting } from './db.js?v=20260619a';

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
const V2_LORES        = `${V2_ROOT}/world_lore.json`;
const V2_LORE_DIR     = `${V2_ROOT}/lores`;
const V2_CHAR_DIR     = `${V2_ROOT}/characters`;
const V2_STORY_DIR    = `${V2_ROOT}/stories`;
const MESSAGE_CHUNK_SIZE = 100;
let lastRemoteManifestInfo = null;
const ensuredFolderPaths = new Set();

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
  const rawHeaders = options.headers || {};
  const method = String(options.method || 'POST').toUpperCase();
  const corsSafeOptions = {
    ...options,
    method,
    mode: 'cors',
    headers: {},
  };

  requestUrl.searchParams.set('authorization', `Bearer ${accessToken}`);
  requestUrl.searchParams.set('reject_cors_preflight', 'true');

  let dropboxArg = '';
  if (typeof rawHeaders?.get === 'function') {
    dropboxArg = rawHeaders.get('Dropbox-API-Arg') || rawHeaders.get('dropbox-api-arg') || '';
  } else if (Array.isArray(rawHeaders)) {
    const match = rawHeaders.find(([key]) => String(key).toLowerCase() === 'dropbox-api-arg');
    dropboxArg = match?.[1] || '';
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    dropboxArg = rawHeaders['Dropbox-API-Arg'] || rawHeaders['dropbox-api-arg'] || '';
  }
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
  if (domain === 'api' && corsSafeOptions.method === 'POST' && (corsSafeOptions.body === undefined || corsSafeOptions.body === null)) {
    // Dropbox の一部 RPC エンドポイントは「引数なし」を null として期待する。
    corsSafeOptions.body = 'null';
  }

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
    const message = String(error?.message || '');
    if (!message.includes('not_found') && !message.includes('path/conflict/folder')) {
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
  return _request('api', '/users/get_current_account', { method: 'POST', body: 'null' });
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

async function deleteRemotePath(path) {
  const target = String(path || '').trim();
  if (!target) return null;
  try {
    return await _request('api', '/files/delete_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
  } catch (error) {
    if (String(error?.message || '').includes('not_found')) return null;
    throw error;
  }
}

async function syncSettingsDelta(manifest, settings = {}, onProgress) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  const remoteSettingsPayload = await downloadJson(manifest?.settingsPath || V2_SETTINGS);
  const mergedTombstones = mergeSyncTombstones(
    settings?.dropbox_sync_tombstones || {},
    remoteSettingsPayload?.settings?.dropbox_sync_tombstones || {}
  );
  const mergedSettings = {
    ...(remoteSettingsPayload?.settings || {}),
    ...(settings || {}),
    dropbox_sync_tombstones: mergedTombstones
  };
  progress('設定を差分アップロード中...');
  await uploadJson(manifest.settingsPath || V2_SETTINGS, { settings: mergedSettings, updatedAt: Date.now() });
  manifest.settingsPath = manifest.settingsPath || V2_SETTINGS;
  return { mergedSettings, mergedTombstones };
}

async function pruneDeletedStoryEntries(manifest, tombstones = {}, onProgress) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  if (!manifest?.stories || typeof manifest.stories !== 'object') return;
  for (const storyId of Object.keys(tombstones || {})) {
    const entry = manifest.stories?.[storyId];
    if (!entry) continue;
    progress(`削除済みストーリーをクラウドから整理中... (${entry.title || storyId})`);
    await deleteRemotePath(entry.dirPath || '');
    delete manifest.stories[storyId];
  }
}

async function pruneDeletedCharacterEntries(manifest, tombstones = {}, onProgress) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  if (!manifest?.characters || typeof manifest.characters !== 'object') return;
  for (const characterId of Object.keys(tombstones || {})) {
    const entry = manifest.characters?.[characterId];
    if (!entry) continue;
    progress(`削除済みキャラクターをクラウドから整理中... (${entry.name || characterId})`);
    await deleteRemotePath(entry.path || '');
    delete manifest.characters[characterId];
  }
}

async function pruneDeletedAssetEntries(manifest, tombstones = {}, onProgress) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  if (!manifest?.assets || typeof manifest.assets !== 'object') return;
  for (const assetId of Object.keys(tombstones || {})) {
    const entry = manifest.assets?.[assetId];
    if (!entry) continue;
    progress(`削除済みアセットをクラウドから整理中... (${entry.label || assetId})`);
    await deleteRemotePath(entry.path || '');
    delete manifest.assets[assetId];
  }
}

export async function getRemoteManifestInfo() {
  const manifest = await downloadJson(V2_MANIFEST);
  if (!manifest || Number(manifest.schemaVersion || 0) < 2) {
    lastRemoteManifestInfo = null;
    return null;
  }
  lastRemoteManifestInfo = {
    updatedAt: Number(manifest.updatedAt || 0),
    schemaVersion: Number(manifest.schemaVersion || 0)
  };
  return lastRemoteManifestInfo;
}

export async function getLastRemoteManifestUpdatedAt() {
  return Number(lastRemoteManifestInfo?.updatedAt || 0);
}

async function ensureFolderExists(path) {
  if (!path || ensuredFolderPaths.has(path)) return;
  try {
    await _request('api', '/files/create_folder_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, autorename: false }),
    });
  } catch (error) {
    if (!error.message.includes('path/conflict')) {
      throw error;
    }
  }
  ensuredFolderPaths.add(path);
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

function sanitizeRemoteNamePart(value, fallback = 'item') {
  const text = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = text
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return normalized || fallback;
}

function buildStoryFolderName(story) {
  const title = sanitizeRemoteNamePart(story?.title || 'story', 'story');
  const franchise = sanitizeRemoteNamePart(story?.franchise || story?.tags?.[0] || '', '');
  return franchise ? `${story.storyId}__${title}__${franchise}` : `${story.storyId}__${title}`;
}

function buildCharacterFileName(character) {
  const name = sanitizeRemoteNamePart(character?.name || 'character', 'character');
  return `${character.characterId}__${name}.json`;
}

function getLoreFranchiseLabel(value) {
  const text = String(value || '').trim();
  return text || '共通';
}

function hashTextForRemoteName(value = '') {
  let hash = 5381;
  const source = String(value || '');
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildLoreFranchiseKey(franchise) {
  const label = getLoreFranchiseLabel(franchise);
  const safeLabel = sanitizeRemoteNamePart(label, 'common');
  return `${safeLabel}__${hashTextForRemoteName(label)}`;
}

function buildLoreFileName(franchise) {
  const label = getLoreFranchiseLabel(franchise);
  return `${buildLoreFranchiseKey(label)}.json`;
}

function groupLoresByFranchise(lores = []) {
  const grouped = new Map();
  for (const lore of Array.isArray(lores) ? lores : []) {
    const franchise = getLoreFranchiseLabel(lore?.franchise);
    if (!grouped.has(franchise)) grouped.set(franchise, []);
    grouped.get(franchise).push(lore);
  }
  return grouped;
}

function getMimeExtension(mimeType = '') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('avif')) return '.avif';
  return '.jpg';
}

function mergeTombstoneMaps(localMap = {}, remoteMap = {}) {
  const merged = { ...remoteMap };
  for (const [id, value] of Object.entries(localMap || {})) {
    const current = merged[id];
    if (!current || Number(value?.deletedAt || 0) >= Number(current?.deletedAt || 0)) {
      merged[id] = value;
    }
  }
  return merged;
}

function mergeSyncTombstones(local = {}, remote = {}) {
  return {
    stories: mergeTombstoneMaps(local?.stories, remote?.stories),
    characters: mergeTombstoneMaps(local?.characters, remote?.characters),
    lores: mergeTombstoneMaps(local?.lores, remote?.lores),
    assets: mergeTombstoneMaps(local?.assets, remote?.assets)
  };
}

function filterDeletedItems(items, key, tombstones) {
  if (!Array.isArray(items) || !tombstones || typeof tombstones !== 'object') return items || [];
  return items.filter(item => item?.[key] && !tombstones[item[key]]);
}

function buildAssetLabelIndex(stories = [], characters = []) {
  const labels = {};
  for (const story of stories || []) {
    const protagonistId = story?.protagonist?.avatarAssetId;
    if (protagonistId && !labels[protagonistId]) {
      const base = story?.protagonist?.name || story?.title || 'protagonist';
      labels[protagonistId] = `${base}_avatar`;
    }
  }
  for (const character of characters || []) {
    const assetId = character?.avatarAssetId;
    if (assetId && !labels[assetId]) {
      labels[assetId] = `${character?.name || 'character'}_avatar`;
    }
  }
  return labels;
}

function buildAssetRemotePath(assetId, mimeType, label, previousPath = '') {
  if (previousPath && previousPath.includes('__')) return previousPath;
  if (previousPath && !previousPath.endsWith(`/${assetId}`)) return previousPath;
  const safeLabel = sanitizeRemoteNamePart(label || 'asset', 'asset');
  return `${ASSETS_DIR_PATH}/${assetId}__${safeLabel}${getMimeExtension(mimeType)}`;
}

async function buildAssetManifestEntries({ assets = [], stories = [], characters = [], existingManifest = null, onProgress }) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  await ensureAssetsFolderExists();

  const existingAssets = existingManifest?.assets && typeof existingManifest.assets === 'object'
    ? existingManifest.assets
    : {};
  const labelIndex = buildAssetLabelIndex(stories, characters);
  const manifestAssets = {};
  let remoteLegacyAssetNames = null;

  if (assets.length > 0 && Object.keys(existingAssets).length === 0) {
    try {
      progress('クラウド上の既存アセットを確認中...');
      remoteLegacyAssetNames = new Set((await listRemoteAssets()).map(entry => entry?.name).filter(Boolean));
    } catch (error) {
      console.warn('[Dropbox] 既存アセット一覧の取得に失敗しました。必要に応じて再アップロードします。', error);
      remoteLegacyAssetNames = new Set();
    }
  }

  for (let i = 0; i < assets.length; i++) {
    const item = assets[i];
    if (!item?.assetId || !item?.blob) continue;
    const previous = existingAssets[item.assetId] || null;
    const label = previous?.label || labelIndex[item.assetId] || 'asset';
    const path = buildAssetRemotePath(item.assetId, item.blob.type, label, previous?.path || '');
    const existsRemotely = !!previous || !!remoteLegacyAssetNames?.has(item.assetId);

    manifestAssets[item.assetId] = {
      path: previous?.path || (remoteLegacyAssetNames?.has(item.assetId) ? `${ASSETS_DIR_PATH}/${item.assetId}` : path),
      label,
      updatedAt: previous?.updatedAt || Date.now()
    };

    if (existsRemotely) {
      continue;
    }

    progress(`アセット ${i + 1}/${assets.length} をアップロード中...`);
    await uploadAsset(item.blob, item.assetId, manifestAssets[item.assetId].path);
    manifestAssets[item.assetId].updatedAt = Date.now();
  }

  return manifestAssets;
}

async function uploadV2Data({ stories = [], characters = [], lores = [], settings = {}, assetEntries = {}, existingManifest = null, onProgress }) {
  const now = Date.now();
  const progress = msg => { if (onProgress) onProgress(msg); };

  if (!existingManifest) {
    await ensureFolderExists('/ZetaTavern');
    await ensureFolderExists(V2_ROOT);
    await ensureFolderExists(V2_LORE_DIR);
    await ensureFolderExists(V2_CHAR_DIR);
    await ensureFolderExists(V2_STORY_DIR);
  } else {
    ensuredFolderPaths.add('/ZetaTavern');
    ensuredFolderPaths.add(V2_ROOT);
    ensuredFolderPaths.add(V2_LORE_DIR);
    ensuredFolderPaths.add(V2_CHAR_DIR);
    ensuredFolderPaths.add(V2_STORY_DIR);
  }

  progress('設定を分割アップロード中...');
  await uploadJson(V2_SETTINGS, { settings, updatedAt: now });

  const manifest = {
    schemaVersion: 4,
    updatedAt: now,
    settingsPath: V2_SETTINGS,
    assets: assetEntries,
    loreFiles: {},
    characters: {},
    stories: {}
  };

  const loreGroups = groupLoresByFranchise(lores);
  progress(`ロア ${lores.length} 件を作品別同期中...`);
  for (const [franchise, items] of loreGroups.entries()) {
    const previousEntry = existingManifest?.loreFiles?.[buildLoreFranchiseKey(franchise)];
    const path = previousEntry?.path || `${V2_LORE_DIR}/${buildLoreFileName(franchise)}`;
    await uploadJson(path, { franchise, lores: items, updatedAt: now });
    manifest.loreFiles[buildLoreFranchiseKey(franchise)] = {
      path,
      franchise,
      count: items.length,
      updatedAt: now
    };
  }

  progress(`キャラクター ${characters.length} 件を同期中...`);
  for (const character of characters) {
    if (!character?.characterId) continue;
    const previousPath = existingManifest?.characters?.[character.characterId]?.path || '';
    const path = previousPath && previousPath.includes('__')
      ? previousPath
      : `${V2_CHAR_DIR}/${buildCharacterFileName(character)}`;
    await uploadJson(path, character);
    manifest.characters[character.characterId] = {
      path,
      updatedAt: character.timestamp || now,
      name: character.name || '',
      category: character.category || ''
    };
  }

  progress(`ストーリー ${stories.length} 件を同期中...`);
  for (const story of stories) {
    if (!story?.storyId) continue;
    manifest.stories[story.storyId] = await uploadV2Story(story, existingManifest?.stories?.[story.storyId], now);
  }

  progress('同期目次を更新中...');
  await uploadJson(V2_MANIFEST, manifest);
  return manifest;
}

async function uploadV2Story(story, previousEntry = null, now = Date.now()) {
  const storyDir = previousEntry?.dirPath && previousEntry.dirPath.includes('__')
    ? previousEntry.dirPath
    : `${V2_STORY_DIR}/${buildStoryFolderName(story)}`;
  if (!previousEntry?.dirPath) {
    await ensureFolderExists(storyDir);
  } else {
    ensuredFolderPaths.add(storyDir);
  }

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
    dirPath: storyDir,
    metaPath,
    messageChunks,
    messageCount: Array.isArray(story.messages) ? story.messages.length : 0,
    updatedAt: story.timestamp || now,
    title: story.title || '',
    franchise: story.franchise || ''
  };
}

async function uploadV2StoryAppendDelta(story, previousEntry, now = Date.now()) {
  if (!previousEntry || !Number.isFinite(previousEntry.messageCount)) {
    return uploadV2Story(story, previousEntry, now);
  }

  const storyDir = previousEntry?.dirPath && previousEntry.dirPath.includes('__')
    ? previousEntry.dirPath
    : `${V2_STORY_DIR}/${buildStoryFolderName(story)}`;
  ensuredFolderPaths.add(storyDir);

  const { meta, chunks } = splitStoryForSync(story);
  const nextMessageCount = Array.isArray(story.messages) ? story.messages.length : 0;
  if (nextMessageCount < previousEntry.messageCount) {
    return uploadV2Story(story, previousEntry, now);
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
    dirPath: storyDir,
    metaPath,
    messageChunks,
    messageCount: nextMessageCount,
    updatedAt: story.timestamp || now,
    title: story.title || '',
    franchise: story.franchise || ''
  };
}

async function downloadV2Data({ localAssetIds, onProgress }) {
  const progress = msg => { if (onProgress) onProgress(msg); };
  const manifest = await downloadJson(V2_MANIFEST);
  if (!manifest || manifest.schemaVersion < 2) return null;
  lastRemoteManifestInfo = {
    updatedAt: Number(manifest.updatedAt || 0),
    schemaVersion: Number(manifest.schemaVersion || 0)
  };

  progress('同期目次を取得しました。差分を復元中...');
  const settingsPayload = await downloadJson(manifest.settingsPath || V2_SETTINGS);
  const settings = settingsPayload?.settings || {};
  let lores = [];
  const loreFiles = manifest.loreFiles && typeof manifest.loreFiles === 'object'
    ? Object.values(manifest.loreFiles)
    : [];
  if (loreFiles.length > 0) {
    for (const entry of loreFiles) {
      const lorePayload = await downloadJson(entry?.path);
      if (Array.isArray(lorePayload?.lores)) {
        lores.push(...lorePayload.lores);
      }
    }
  } else {
    const lorePayload = await downloadJson(manifest.loresPath || V2_LORES);
    lores = Array.isArray(lorePayload?.lores) ? lorePayload.lores : [];
  }

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
      const blob = await downloadAsset(assetId, manifest.assets?.[assetId]?.path || '');
      if (blob) newAssets.push({ assetId, blob });
    }
  }

  return { stories, characters, lores, settings, newAssets };
}

// ============================================================
// アセット (Blob 画像) の同期
// ============================================================

/**
 * アセットフォルダの存在を保証する。なければ作成する。
 */
export async function ensureAssetsFolderExists() {
  if (ensuredFolderPaths.has(ASSETS_DIR_PATH)) return;
  try {
    await _request('api', '/files/create_folder_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ASSETS_DIR_PATH, autorename: false }),
    });
  } catch (error) {
    if (!error.message.includes('path/conflict')) {
      throw error;
    }
  }
  ensuredFolderPaths.add(ASSETS_DIR_PATH);
}

/**
 * 単一のアセット Blob を Dropbox にアップロードする。
 */
export async function uploadAsset(blob, assetId, remotePath = '') {
  const path = remotePath || `${ASSETS_DIR_PATH}/${assetId}`;
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
export async function downloadAsset(assetId, remotePath = '') {
  const path = remotePath || `${ASSETS_DIR_PATH}/${assetId}`;
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
export async function pushToDropbox({ stories, characters, lores, settings, assets, onProgress }) {
  const progress = msg => { console.log('[Dropbox Push]', msg); if (onProgress) onProgress(msg); };

  progress('同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('push');
  try {
    const existingManifest = await downloadJson(V2_MANIFEST);
    const remoteSettingsPayload = await downloadJson(existingManifest?.settingsPath || V2_SETTINGS);
    const mergedTombstones = mergeSyncTombstones(
      settings?.dropbox_sync_tombstones || {},
      remoteSettingsPayload?.settings?.dropbox_sync_tombstones || {}
    );
    const mergedSettings = {
      ...(remoteSettingsPayload?.settings || {}),
      ...(settings || {}),
      dropbox_sync_tombstones: mergedTombstones
    };
    const filteredStories = filterDeletedItems(stories, 'storyId', mergedTombstones.stories);
    const filteredCharacters = filterDeletedItems(characters, 'characterId', mergedTombstones.characters);
    const filteredLores = filterDeletedItems(lores, 'id', mergedTombstones.lores);
    const filteredAssets = (assets || []).filter(item => item?.assetId && !mergedTombstones.assets?.[item.assetId]);

    const assetEntries = await buildAssetManifestEntries({
      assets: filteredAssets,
      stories: filteredStories,
      characters: filteredCharacters,
      existingManifest,
      onProgress
    });

    progress('分割メタデータをアップロード中...');
    const manifest = await uploadV2Data({
      stories: filteredStories,
      characters: filteredCharacters,
      lores: filteredLores,
      settings: mergedSettings,
      assetEntries,
      existingManifest,
      onProgress
    });
    lastRemoteManifestInfo = {
      updatedAt: Number(manifest?.updatedAt || 0),
      schemaVersion: Number(manifest?.schemaVersion || 0)
    };

    progress('プッシュ完了！');
  } finally {
    try {
      await deleteLockFile();
    } catch (error) {
      console.warn('[Dropbox] ロックファイル削除に失敗しました。期限切れ後に自動解除されます。', error);
    }
  }
}

export async function pushStoryDeltaToDropbox({ story, settings, assets = [], onProgress }) {
  const progress = msg => { console.log('[Dropbox Delta Push]', msg); if (onProgress) onProgress(msg); };

  progress('差分同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('delta-push');
  try {
    const manifest = await downloadJson(V2_MANIFEST);
    if (!manifest || manifest.schemaVersion < 2) {
      return null;
    }
    const { mergedTombstones } = await syncSettingsDelta(manifest, settings || {}, onProgress);

    const now = Date.now();
    ensuredFolderPaths.add('/ZetaTavern');
    ensuredFolderPaths.add(V2_ROOT);
    ensuredFolderPaths.add(V2_STORY_DIR);
    await pruneDeletedStoryEntries(manifest, mergedTombstones?.stories, onProgress);
    await pruneDeletedAssetEntries(manifest, mergedTombstones?.assets, onProgress);

    if (Array.isArray(assets) && assets.length > 0) {
      progress(`関連アセット ${assets.length} 件を差分アップロード中...`);
      const assetEntries = await buildAssetManifestEntries({
        assets,
        stories: [story],
        existingManifest: manifest,
        onProgress
      });
      manifest.assets = {
        ...(manifest.assets || {}),
        ...assetEntries
      };
    }

    if (story?.storyId) {
      progress('現在のストーリーを差分アップロード中...');
      manifest.stories = manifest.stories || {};
      manifest.stories[story.storyId] = await uploadV2StoryAppendDelta(story, manifest.stories[story.storyId], now);
    }
    manifest.updatedAt = now;

    progress('同期目次を更新中...');
    await uploadJson(V2_MANIFEST, manifest);
    lastRemoteManifestInfo = {
      updatedAt: Number(manifest.updatedAt || 0),
      schemaVersion: Number(manifest.schemaVersion || 0)
    };
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

export async function pushCharacterDeltaToDropbox({ characters, settings = {}, assets = [], onProgress }) {
  const progress = msg => { console.log('[Dropbox Character Delta]', msg); if (onProgress) onProgress(msg); };
  const targetCharacters = Array.isArray(characters)
    ? characters.filter(item => item?.characterId)
    : [];

  progress('キャラクター差分同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('delta-push-characters');
  try {
    const manifest = await downloadJson(V2_MANIFEST);
    if (!manifest || manifest.schemaVersion < 2) {
      return null;
    }
    const { mergedTombstones } = await syncSettingsDelta(manifest, settings || {}, onProgress);

    const now = Date.now();
    ensuredFolderPaths.add('/ZetaTavern');
    ensuredFolderPaths.add(V2_ROOT);
    ensuredFolderPaths.add(V2_CHAR_DIR);
    await pruneDeletedCharacterEntries(manifest, mergedTombstones?.characters, onProgress);
    await pruneDeletedAssetEntries(manifest, mergedTombstones?.assets, onProgress);

    if (Array.isArray(assets) && assets.length > 0) {
      progress(`関連アセット ${assets.length} 件を差分アップロード中...`);
      const assetEntries = await buildAssetManifestEntries({
        assets,
        characters: targetCharacters,
        existingManifest: manifest,
        onProgress
      });
      manifest.assets = {
        ...(manifest.assets || {}),
        ...assetEntries
      };
    }

    progress(`キャラクター ${targetCharacters.length} 件を差分アップロード中...`);
    manifest.characters = manifest.characters || {};
    for (const character of targetCharacters) {
      const previousPath = manifest.characters?.[character.characterId]?.path || '';
      const path = previousPath && previousPath.includes('__')
        ? previousPath
        : `${V2_CHAR_DIR}/${buildCharacterFileName(character)}`;
      await uploadJson(path, character);
      manifest.characters[character.characterId] = {
        path,
        updatedAt: character.timestamp || now,
        name: character.name || '',
        category: character.category || ''
      };
    }

    manifest.updatedAt = now;
    progress('同期目次を更新中...');
    await uploadJson(V2_MANIFEST, manifest);
    lastRemoteManifestInfo = {
      updatedAt: Number(manifest.updatedAt || 0),
      schemaVersion: Number(manifest.schemaVersion || 0)
    };
    progress('キャラクター差分同期完了！');
    return manifest;
  } finally {
    try {
      await deleteLockFile();
    } catch (error) {
      console.warn('[Dropbox] ロックファイル削除に失敗しました。期限切れ後に自動解除されます。', error);
    }
  }
}

export async function pushLoreDeltaToDropbox({ lores, settings = {}, franchises = [], onProgress }) {
  const progress = msg => { console.log('[Dropbox Lore Delta]', msg); if (onProgress) onProgress(msg); };

  progress('ロアブック差分同期を開始します...');
  const lock = await checkLockFile();
  if (lock) {
    throw new Error(`他の端末が同期中です (${lock.operation}) 。しばらく待ってから再試行してください。`);
  }

  await uploadLockFile('delta-push-lores');
  try {
    const manifest = await downloadJson(V2_MANIFEST);
    if (!manifest || manifest.schemaVersion < 2) {
      return null;
    }
    const { mergedTombstones } = await syncSettingsDelta(manifest, settings || {}, onProgress);

    const now = Date.now();
    ensuredFolderPaths.add('/ZetaTavern');
    ensuredFolderPaths.add(V2_ROOT);
    ensuredFolderPaths.add(V2_LORE_DIR);
    await pruneDeletedAssetEntries(manifest, mergedTombstones?.assets, onProgress);

    const allLores = Array.isArray(lores) ? lores : [];
    const hasSplitLoreFiles = manifest.loreFiles && typeof manifest.loreFiles === 'object' && Object.keys(manifest.loreFiles).length > 0;
    const normalizedTargets = [...new Set(
      (Array.isArray(franchises) ? franchises : [])
        .map(getLoreFranchiseLabel)
        .filter(Boolean)
    )];

    if (!hasSplitLoreFiles) {
      progress('旧式ロア同期から作品別ファイルへ移行中...');
      await ensureFolderExists(V2_LORE_DIR);
      manifest.loreFiles = {};
      for (const [franchise, items] of groupLoresByFranchise(allLores).entries()) {
        const key = buildLoreFranchiseKey(franchise);
        const path = `${V2_LORE_DIR}/${buildLoreFileName(franchise)}`;
        await uploadJson(path, { franchise, lores: items, updatedAt: now });
        manifest.loreFiles[key] = {
          path,
          franchise,
          count: items.length,
          updatedAt: now
        };
      }
    } else {
      const loreGroups = groupLoresByFranchise(allLores);
      const targetFranchises = normalizedTargets.length > 0
        ? normalizedTargets
        : [...new Set([...loreGroups.keys(), ...Object.values(manifest.loreFiles || {}).map(entry => getLoreFranchiseLabel(entry?.franchise))])];

      for (const franchise of targetFranchises) {
        const key = buildLoreFranchiseKey(franchise);
        const items = loreGroups.get(franchise) || [];
        const path = manifest.loreFiles?.[key]?.path || `${V2_LORE_DIR}/${buildLoreFileName(franchise)}`;
        if (items.length === 0) {
          progress(`空になったロアブックをクラウドから整理中... (${franchise})`);
          await deleteRemotePath(path);
          if (manifest.loreFiles?.[key]) {
            delete manifest.loreFiles[key];
          }
        } else {
          progress(`ロアブックを差分アップロード中... (${franchise})`);
          await uploadJson(path, { franchise, lores: items, updatedAt: now });
          manifest.loreFiles[key] = {
            path,
            franchise,
            count: items.length,
            updatedAt: now
          };
        }
      }
    }

    manifest.schemaVersion = Math.max(Number(manifest.schemaVersion || 0), 4);
    manifest.updatedAt = now;

    progress('同期目次を更新中...');
    await uploadJson(V2_MANIFEST, manifest);
    lastRemoteManifestInfo = {
      updatedAt: Number(manifest.updatedAt || 0),
      schemaVersion: Number(manifest.schemaVersion || 0)
    };
    progress('ロアブック差分同期完了！');
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
 * @returns {{ stories: Array, characters: Array, lores: Array, settings: object, newAssets: Array<{assetId, blob}> }}
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
