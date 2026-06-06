export function isCharacterMatchingStory(char, story) {
  if (!story) return false;
  const storyTags = Array.isArray(story.tags) ? story.tags.filter(Boolean) : [];
  if (storyTags.length === 0) return true;

  const charCategory = (char?.category || '').trim();
  const charTags = Array.isArray(char?.tags) ? char.tags.filter(Boolean) : [];
  return storyTags.includes(charCategory) || charTags.some(tag => storyTags.includes(tag));
}

export function getStoryScopedCharacters(allCharacters, story) {
  if (!Array.isArray(allCharacters)) return [];
  return allCharacters.filter(char => isCharacterMatchingStory(char, story));
}

export function buildStoryCharacterRefs(story, allCharacters) {
  return getStoryScopedCharacters(allCharacters, story).map(char => ({
    characterId: char.characterId,
    attendance: 'active'
  }));
}

export function getStoryCharacterIds(story, allCharacters) {
  return new Set(buildStoryCharacterRefs(story, allCharacters).map(ref => ref.characterId));
}
