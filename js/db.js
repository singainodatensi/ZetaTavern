/**
 * db.js - ZetaTavern IndexedDB Module
 * Handles storage for settings, assets (Blobs), characters, and stories.
 */

const DB_NAME = 'ZetaTavern_PWA_Unique_v1_DB';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Initializes and returns the IndexedDB instance.
 */
function getDB() {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;
      console.log('[DB] Upgrading IndexedDB schema...');

      // Settings Store: { key: string, value: any }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
        console.log('[DB] Created settings store');
      }

      // Assets Store (Images as Blobs): { assetId: string, blob: Blob, mimeType: string, timestamp: number }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'assetId' });
        console.log('[DB] Created assets store');
      }

      // Characters Store: { characterId: string, name: string, avatarAssetId: string, description: string, personality: string, mes_example: string, timestamp: number }
      if (!db.objectStoreNames.contains('characters')) {
        db.createObjectStore('characters', { keyPath: 'characterId' });
        console.log('[DB] Created characters store');
      }

      // Stories Store: { storyId: string, title: string, storytellerPrompt: string, worldPrompt: string, protagonist: Object, characters: Array, messages: Array, sceneState: Object, characterMemory: Object, relationshipMemory: Object, timestamp: number }
      if (!db.objectStoreNames.contains('stories')) {
        db.createObjectStore('stories', { keyPath: 'storyId' });
        console.log('[DB] Created stories store');
      }
    };

    request.onsuccess = event => {
      dbInstance = event.target.result;
      console.log('[DB] IndexedDB opened successfully');
      resolve(dbInstance);
    };

    request.onerror = event => {
      console.error('[DB] IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };

    request.onblocked = event => {
      console.warn('[DB] IndexedDB open blocked - close other tabs with this app');
    };
  });
}

// ==========================================
// Generic CRUD Helpers
// ==========================================

async function get(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    } catch (err) {
      reject(err);
    }
  });
}

export async function getAll(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function put(storeName, value) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function deleteKey(storeName, key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    } catch (err) {
      reject(err);
    }
  });
}

export async function clearStore(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    } catch (err) {
      reject(err);
    }
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
    console.error(`[DB] Error getting setting ${key}:`, err);
    return defaultValue;
  }
}

export async function saveSetting(key, value) {
  try {
    await put('settings', { key, value });
    console.log(`[DB] Setting saved: ${key}`);
  } catch (err) {
    console.error(`[DB] Error saving setting ${key}:`, err);
    throw err;
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
    console.log(`[DB] Asset saved: ${assetId}`);
    return assetId;
  } catch (err) {
    console.error('[DB] Error saving asset:', err);
    throw err;
  }
}

export async function getAssetBlob(assetId) {
  if (!assetId) return null;
  try {
    const asset = await get('assets', assetId);
    return asset ? asset.blob : null;
  } catch (err) {
    console.error(`[DB] Error getting asset ${assetId}:`, err);
    return null;
  }
}

export async function deleteAsset(assetId) {
  if (!assetId) return;
  try {
    await deleteKey('assets', assetId);
    console.log(`[DB] Asset deleted: ${assetId}`);
  } catch (err) {
    console.error(`[DB] Error deleting asset ${assetId}:`, err);
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
    console.log(`[DB] Asset saved with ID: ${assetId}`);
  } catch (err) {
    console.error(`[DB] Error saving asset with id ${assetId}:`, err);
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
    const chars = await getAll('characters');
    console.log(`[DB] Retrieved ${chars.length} characters`);
    return chars;
  } catch (err) {
    console.error('[DB] Error getting all characters:', err);
    return [];
  }
}

export async function getCharacter(characterId) {
  try {
    return await get('characters', characterId);
  } catch (err) {
    console.error(`[DB] Error getting character ${characterId}:`, err);
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
    console.log(`[DB] Character saved: ${character.name} (${character.characterId})`);
    return character.characterId;
  } catch (err) {
    console.error('[DB] Error saving character:', err);
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
    console.log(`[DB] Character deleted: ${characterId}`);
  } catch (err) {
    console.error(`[DB] Error deleting character ${characterId}:`, err);
    throw err;
  }
}

// ==========================================
// Stories API
// ==========================================

export async function getStories() {
  try {
    const stories = await getAll('stories');
    console.log(`[DB] Retrieved ${stories.length} stories`);
    return stories;
  } catch (err) {
    console.error('[DB] Error getting all stories:', err);
    return [];
  }
}

export async function getStory(storyId) {
  try {
    return await get('stories', storyId);
  } catch (err) {
    console.error(`[DB] Error getting story ${storyId}:`, err);
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
    console.log(`[DB] Story saved: ${story.title} (${story.storyId})`);
    return story.storyId;
  } catch (err) {
    console.error('[DB] Error saving story:', err);
    throw err;
  }
}

export async function deleteStory(storyId) {
  try {
    await deleteKey('stories', storyId);
    console.log(`[DB] Story deleted: ${storyId}`);
  } catch (err) {
    console.error(`[DB] Error deleting story ${storyId}:`, err);
    throw err;
  }
}
