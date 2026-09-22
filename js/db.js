/**
 * db.js - ZetaTavern IndexedDB Module
 * Handles storage for settings, assets (Blobs), characters, and stories.
 */

const DB_NAME = 'ZetaTavern_PWA_Unique_v1_DB'; // 他のアプリと絶対衝突しない名前に変更
// Bump when adding stores/indexes so existing users receive schema upgrades.
const DB_VERSION = 3;
const LOCAL_CHANGE_MARKER_KEY = 'dropbox_local_change_at';
const SYNC_JOURNAL_KEY = 'dropbox_pending_changes_v1';

function changeKey(scope, id) {
  return JSON.stringify([scope, id]);
}

export async function getPendingDropboxChanges() {
  const record = await get('settings', SYNC_JOURNAL_KEY);
  return record?.value || {};
}

async function updateSyncJournal(update) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const request = store.get(SYNC_JOURNAL_KEY);
    request.onsuccess = () => {
      const changes = request.result?.value || {};
      update(changes);
      store.put({ key: SYNC_JOURNAL_KEY, value: changes });
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Sync journal transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function recordDropboxSyncRequest(request = {}) {
  await updateSyncJournal(changes => {
    const add = (scope, id) => {
      changes[changeKey(scope, id)] = { scope, id, revision: crypto.randomUUID() };
    };
    if (request.forceFull || (!request.storyId && !request.syncStory && !request.syncCharacters && !request.syncLores)) {
      add('full', '*');
    }
    if (request.storyId) add('stories', request.storyId);
    for (const id of request.characterIds || []) add('characters', id);
    for (const id of request.assetIds || []) add('assets', id);
    if (request.syncLores) {
      for (const id of request.loreFranchises?.length ? request.loreFranchises : ['*']) add('lores', id || '共通');
    }
  });
}

export async function acknowledgeDropboxChanges(snapshot) {
  await updateSyncJournal(changes => {
    for (const [key, sent] of Object.entries(snapshot)) {
      if (changes[key]?.revision === sent.revision) delete changes[key];
    }
  });
}

// Commit local data and its dirty scope together. A concurrent write gets a new revision.
async function mutateTracked(storeName, value, key, removing = false) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName, 'settings'], 'readwrite');
    const store = tx.objectStore(storeName);
    const settings = tx.objectStore('settings');
    const oldRequest = store.get(key);
    oldRequest.onsuccess = () => {
      const journalRequest = settings.get(SYNC_JOURNAL_KEY);
      journalRequest.onsuccess = () => {
        const changes = journalRequest.result?.value || {};
        const ids = storeName === 'world_lore'
          ? [...new Set([oldRequest.result, value].filter(Boolean).map(item => String(item.franchise || '').trim() || '共通'))]
          : [key];
        const scope = storeName === 'world_lore' ? 'lores' : storeName;
        for (const id of ids) changes[changeKey(scope, id)] = { scope, id, revision: crypto.randomUUID() };
        settings.put({ key: SYNC_JOURNAL_KEY, value: changes });
        settings.put({ key: LOCAL_CHANGE_MARKER_KEY, value: Date.now() });
        if (removing) store.delete(key);
        else store.put(value);
      };
    };
    tx.oncomplete = () => resolve(key);
    tx.onabort = () => reject(tx.error || new Error('Data transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

let dbPromise = null;
let localChangeTrackingSuspendCount = 0;

/**
 * Initializes and returns the IndexedDB instance.
 */
function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      // Settings Store: { key: string, value: any }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Assets Store (Images as Blobs): { assetId: string, blob: Blob, mimeType: string, timestamp: number }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'assetId' });
      }

      // Characters Store: { characterId: string, name: string, avatarAssetId: string, description: string, personality: string, mes_example: string, timestamp: number }
      if (!db.objectStoreNames.contains('characters')) {
        db.createObjectStore('characters', { keyPath: 'characterId' });
      }

      // Stories Store: { storyId: string, title: string, storytellerPrompt: string, worldPrompt: string, protagonist: Object, characters: Array, messages: Array, characterMemory: Object, relationshipMemory: Object, timestamp: number }
      if (!db.objectStoreNames.contains('stories')) {
        db.createObjectStore('stories', { keyPath: 'storyId' });
      }

      // World Lore Store: { id: string, franchise: string, type: string, name: string, content: Object, source: string, verified: boolean, status: string }
      if (!db.objectStoreNames.contains('world_lore')) {
        const loreStore = db.createObjectStore('world_lore', { keyPath: 'id' });
        loreStore.createIndex('franchise', 'franchise', { unique: false });
        loreStore.createIndex('name', 'name', { unique: false });
      }
    };

    request.onsuccess = event => {
      resolve(event.target.result);
    };

    request.onerror = event => {
      console.error('IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };
  });
  return dbPromise;
}

// ==========================================
// Generic CRUD Helpers
// ==========================================

async function get(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(storeName, value, track = true) {
  if (track && localChangeTrackingSuspendCount === 0 && storeName !== 'settings') {
    const key = value.storyId || value.characterId || value.assetId || value.id;
    return mutateTracked(storeName, value, key);
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(value);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteKey(storeName, key) {
  if (localChangeTrackingSuspendCount === 0 && storeName !== 'settings') {
    return mutateTracked(storeName, null, key, true);
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearStore(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ==========================================
// Settings API
// ==========================================

export async function getSetting(key, defaultValue = null) {
  try {
    const result = await get('settings', key);
    return result ? result.value : defaultValue;
  } catch (err) {
    console.error(`Error getting setting ${key}:`, err);
    return defaultValue;
  }
}

export async function saveSetting(key, value) {
  try {
    await put('settings', { key, value });
  } catch (err) {
    console.error(`Error saving setting ${key}:`, err);
  }
}

async function touchLocalChangeMarker() {
  if (localChangeTrackingSuspendCount > 0) return;
  try {
    await put('settings', { key: LOCAL_CHANGE_MARKER_KEY, value: Date.now() });
  } catch (err) {
    console.error('Error updating local change marker:', err);
  }
}

export async function getLocalChangeMarker() {
  return getSetting(LOCAL_CHANGE_MARKER_KEY, 0);
}

export async function runWithoutLocalChangeTracking(callback) {
  localChangeTrackingSuspendCount += 1;
  try {
    return await callback();
  } finally {
    localChangeTrackingSuspendCount = Math.max(0, localChangeTrackingSuspendCount - 1);
  }
}

// ==========================================
// Assets API (Blob Storage)
// ==========================================

export async function saveAsset(blob, mimeType) {
  const assetId = crypto.randomUUID();
  try {
    await put('assets', {
      assetId,
      blob,
      mimeType,
      timestamp: Date.now()
    });
    await touchLocalChangeMarker();
    return assetId;
  } catch (err) {
    console.error('Error saving asset:', err);
    throw err;
  }
}

export async function getAssetBlob(assetId) {
  if (!assetId) return null;
  try {
    const asset = await get('assets', assetId);
    return asset ? asset.blob : null;
  } catch (err) {
    console.error(`Error getting asset ${assetId}:`, err);
    return null;
  }
}

export async function deleteAsset(assetId) {
  if (!assetId) return;
  try {
    await deleteKey('assets', assetId);
    await touchLocalChangeMarker();
  } catch (err) {
    console.error(`Error deleting asset ${assetId}:`, err);
  }
}

/**
 * Saves an asset blob with a SPECIFIC, pre-existing assetId.
 * Used for Dropbox Pull to restore assets with their original IDs.
 */
export async function saveAssetWithId(assetId, blob, mimeType) {
  if (!assetId || !blob) return;
  try {
    await put('assets', {
      assetId,
      blob,
      mimeType,
      timestamp: Date.now()
    });
    await touchLocalChangeMarker();
  } catch (err) {
    console.error(`Error saving asset with id ${assetId}:`, err);
    throw err;
  }
}

// Helper to convert Blob to base64 for exports
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Helper to convert base64 to Blob for imports
export function base64ToBlob(base64Str, defaultMime = 'image/png') {
  const parts = base64Str.split(';base64,');
  const mime = parts[0].split(':')[1] || defaultMime;
  const raw = window.atob(parts[1]);
  const rawLength = raw.length;
  const uInt8Array = new Uint8Array(rawLength);

  for (let i = 0; i < rawLength; ++i) {
    uInt8Array[i] = raw.charCodeAt(i);
  }

  return new Blob([uInt8Array], { type: mime });
}

// ==========================================
// Characters API
// ==========================================

export async function getCharacters() {
  try {
    return await getAll('characters');
  } catch (err) {
    console.error('Error getting all characters:', err);
    return [];
  }
}

export async function getCharacter(characterId) {
  try {
    return await get('characters', characterId);
  } catch (err) {
    console.error(`Error getting character ${characterId}:`, err);
    return null;
  }
}

export async function saveCharacter(character) {
  if (!character.characterId) {
    character.characterId = crypto.randomUUID();
  }
  character.timestamp = Date.now();
  try {
    await put('characters', character);
    await touchLocalChangeMarker();
    return character.characterId;
  } catch (err) {
    console.error('Error saving character:', err);
    throw err;
  }
}

export async function saveCharacterFromSync(character) {
  if (!character.characterId) {
    character.characterId = crypto.randomUUID();
  }
  if (!character.timestamp) {
    character.timestamp = Date.now();
  }
  try {
    await put('characters', character, false);
    return character.characterId;
  } catch (err) {
    console.error('Error saving synced character:', err);
    throw err;
  }
}

export async function deleteCharacter(characterId) {
  try {
    const char = await getCharacter(characterId);
    if (char && char.avatarAssetId) {
      await deleteAsset(char.avatarAssetId);
    }
    await deleteKey('characters', characterId);
    await touchLocalChangeMarker();
  } catch (err) {
    console.error(`Error deleting character ${characterId}:`, err);
    throw err;
  }
}

// ==========================================
// Stories API
// ==========================================

export async function getStories() {
  try {
    return await getAll('stories');
  } catch (err) {
    console.error('Error getting all stories:', err);
    return [];
  }
}

export async function getStory(storyId) {
  try {
    return await get('stories', storyId);
  } catch (err) {
    console.error(`Error getting story ${storyId}:`, err);
    return null;
  }
}

export async function saveStory(story) {
  if (!story.storyId) {
    story.storyId = crypto.randomUUID();
  }
  story.timestamp = Date.now();
  try {
    await put('stories', story);
    await touchLocalChangeMarker();
    return story.storyId;
  } catch (err) {
    console.error('Error saving story:', err);
    throw err;
  }
}

export async function saveStoryFromSync(story) {
  if (!story.storyId) {
    story.storyId = crypto.randomUUID();
  }
  if (!story.timestamp) {
    story.timestamp = Date.now();
  }
  try {
    await put('stories', story, false);
    return story.storyId;
  } catch (err) {
    console.error('Error saving synced story:', err);
    throw err;
  }
}

export async function deleteStory(storyId) {
  try {
    await deleteKey('stories', storyId);
    await touchLocalChangeMarker();
  } catch (err) {
    console.error(`Error deleting story ${storyId}:`, err);
    throw err;
  }
}

// ==========================================
// World Lore API
// ==========================================

export async function getWorldLores() {
  try {
    return await getAll('world_lore');
  } catch (err) {
    console.error('Error getting all world lore:', err);
    return [];
  }
}

export async function getLore(loreId) {
  try {
    return await get('world_lore', loreId);
  } catch (err) {
    console.error(`Error getting lore ${loreId}:`, err);
    return null;
  }
}

export async function saveLore(lore) {
  if (!lore.id) {
    lore.id = 'lore_' + crypto.randomUUID();
  }
  try {
    await put('world_lore', lore);
    await touchLocalChangeMarker();
    return lore.id;
  } catch (err) {
    console.error('Error saving world lore:', err);
    throw err;
  }
}

export async function deleteLore(loreId) {
  try {
    await deleteKey('world_lore', loreId);
    await touchLocalChangeMarker();
  } catch (err) {
    console.error(`Error deleting world lore ${loreId}:`, err);
    throw err;
  }
}

export async function getLoreByNameAndFranchise(name, franchise) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('world_lore', 'readonly');
    const store = transaction.objectStore('world_lore');
    const nameIndex = store.index('name');
    const request = nameIndex.getAll(name);

    request.onsuccess = () => {
      const results = request.result || [];
      if (!franchise) {
        resolve(results[0] || null);
        return;
      }
      const match = results.find(item => item.franchise === franchise);
      resolve(match || results[0] || null);
    };
    request.onerror = () => reject(request.error);
  });
}
