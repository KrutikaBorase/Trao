export function buildPracticeQueue(questions, confidenceMap = {}) {
  const safeQuestions = Array.isArray(questions) ? questions : [];

  return [...safeQuestions].sort((left, right) => {
    const leftScore = confidenceMap[left.id] ?? 3;
    const rightScore = confidenceMap[right.id] ?? 3;
    return leftScore - rightScore || left.id.localeCompare(right.id);
  });
}

export function reorderQuestions(list, questionId, direction) {
  const safeList = Array.isArray(list) ? [...list] : [];
  const currentIndex = safeList.findIndex((item) => item.id === questionId);
  if (currentIndex < 0) return safeList;

  const nextIndex = Math.min(safeList.length - 1, Math.max(0, currentIndex + direction));
  if (nextIndex === currentIndex) return safeList;

  const reordered = [...safeList];
  const [moved] = reordered.splice(currentIndex, 1);
  reordered.splice(nextIndex, 0, moved);
  return reordered;
}

export function updateQuestionState(questions, questionId, nextState) {
  if (!Array.isArray(questions)) return [];
  return questions.map((question) =>
    question.id === questionId ? { ...question, state: nextState } : question,
  );
}
