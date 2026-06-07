/**
 * state.js - ZetaTavern State Management
 * Holds application memory states and notifies subscribers on changes.
 */

const state = {
  // Configs
  apiProvider: 'gemini',
  apiKey: '',
  modelName: 'gemini-2.5-flash',
  searchModelName: '',
  availableModels: [],
  lastUsedModel: '',
  
  // Data lists
  stories: [],
  characters: [],
  
  // Active states
  currentStory: null,
  activeScreen: 'story', // 'story' (main board), 'library' (characters), 'settings'
  uiMode: 'novel',       // 'novel' (visual text-focused), 'chat' (standard chat avatars)
  isGenerating: false,
  showChoices: true,     // Option A/B/C toggle
  
  // Participant attendance for current active story
  // e.g., { "char-uuid": "active" | "absent" }
  attendance: {}
};

const listeners = new Set();

/**
 * Subscribe to state change events.
 * Returns an unsubscribe function.
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notify all subscribers about a state change event.
 */
export function notify(event, data = {}) {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch (err) {
      console.error('Error in state subscriber callback:', err);
    }
  }
}

/**
 * Get a read-only snapshot of the current state.
 */
export function getState() {
  // Return shallow copy to protect state references
  return { ...state };
}

/**
 * Updates the state properties and fires a change notification.
 */
export function updateState(updates) {
  Object.assign(state, updates);
  notify('stateChanged', state);
}

export function normalizeCharacterAttendance(role) {
  return role === 'absent' ? 'absent' : 'active';
}

/**
 * Sets the active story, syncing character attendance state.
 */
export function setActiveStory(story) {
  state.currentStory = story;
  
  if (story) {
    // Populate attendance map from story object
    state.attendance = {};
    if (story.characters && Array.isArray(story.characters)) {
      story.characters.forEach(c => {
        state.attendance[c.characterId] = normalizeCharacterAttendance(c.attendance);
      });
    }
  } else {
    state.attendance = {};
  }
  
  notify('storyChanged', state);
  notify('stateChanged', state);
}

/**
 * Updates attendance for a specific character in the active story.
 */
export function updateCharacterAttendance(characterId, role) {
  if (!state.currentStory) return;

  const normalizedRole = normalizeCharacterAttendance(role);
  state.attendance[characterId] = normalizedRole;
  
  // Sync back to currentStory data structure
  if (!state.currentStory.characters) {
    state.currentStory.characters = [];
  }
  
  const charIndex = state.currentStory.characters.findIndex(c => c.characterId === characterId);
  if (charIndex > -1) {
    state.currentStory.characters[charIndex].attendance = normalizedRole;
  } else {
    state.currentStory.characters.push({ characterId, attendance: normalizedRole });
  }

  notify('attendanceChanged', { characterId, role: normalizedRole });
  notify('stateChanged', state);
}
