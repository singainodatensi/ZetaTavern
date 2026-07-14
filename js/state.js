/**
 * state.js - ZetaTavern State Management
 * Holds application memory states and notifies subscribers on changes.
 */

const state = {
  // Configs
  apiProvider: 'gemini',
  apiKey: '',
  groqApiKey: '',
  tavilyApiKey: '',
  modelName: 'gemini-2.5-flash',
  searchModelName: '',
  webSearchProvider: 'google',
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
  lastApiUsage: null,
  apiUsageHistory: [],
  thinkingLevelGemini3: 'medium',
  thinkingBudgetPresetGemini25: 'balanced',
  gemmaThinkingEnabled: true,
  promptDebugEnabled: false,
  historyCompressionEnabled: true,
  historyTurnLimit: 10,
  sessionSummaryAutoEnabled: true,
  sessionSummaryTurnInterval: 20,
  sessionSummaryModelName: '',
  sessionSummaryPrompt: '',
  isSessionSummaryRunning: false
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

export function setActiveStory(story) {
  state.currentStory = story;

  notify('storyChanged', state);
  notify('stateChanged', state);
}
