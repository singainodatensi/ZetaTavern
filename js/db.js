/**
 * db.js - ZetaTavern IndexedDB Module
 * Handles storage for settings, assets (Blobs), characters, and stories.
 */

const DB_NAME = 'ZetaTavern_PWA_Unique_v1_DB'; // 他のアプリと絶対衝突しない名前に変更
// Bump when adding stores/indexes so existing users receive schema upgrades.
const DB_VERSION = 3;

let dbPromise = null;

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

      // Stories Store: { storyId: string, title: string, storytellerPrompt: string, worldPrompt: string, protagonist: Object, characters: Array, messages: Array, sceneState: Object, characterMemory: Object, relationshipMemory: Object, timestamp: number }
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

async function put(storeName, value) {
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
    return character.characterId;
  } catch (err) {
    console.error('Error saving character:', err);
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
    return story.storyId;
  } catch (err) {
    console.error('Error saving story:', err);
    throw err;
  }
}

export async function deleteStory(storyId) {
  try {
    await deleteKey('stories', storyId);
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
    return lore.id;
  } catch (err) {
    console.error('Error saving world lore:', err);
    throw err;
  }
}

export async function deleteLore(loreId) {
  try {
    await deleteKey('world_lore', loreId);
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
