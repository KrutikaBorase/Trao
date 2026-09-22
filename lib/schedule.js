export function allocateSchedule(requirements, daysAvailable, questionIds, questionDetails = []) {
  const musts = requirements.filter((req) => req.priority === 'must');
  const safeDays = Math.max(1, Number(daysAvailable) || 1);
  const safeQuestionIds = Array.isArray(questionIds) ? questionIds : [];

  const totalMinutes = Math.max(30, safeQuestionIds.length * 25 + musts.length * 15);
  const minutesPerDay = Math.max(20, Math.round(totalMinutes / safeDays));

  const days = Array.from({ length: safeDays }, (_, index) => ({
    day: index + 1,
    focus: index === 0 ? 'Core requirements and fundamentals' : `Priority review ${index + 1}`,
    question_ids: [],
    minutes: 0,
  }));

  const requirementPriority = new Map(musts.map((requirement) => [requirement.id, 2]));
  const sortedQuestions = [...safeQuestionIds].map((id, index) => {
    const detail = questionDetails.find((question) => question.id === id);
    const priority = Math.max(...(detail?.requirement_ids || []).map((requirementId) => requirementPriority.get(requirementId) || 0), 0);
    return { id, score: priority * 100 + (detail?.difficulty || 1) * 10 - index / 1000 };
  });

  sortedQuestions.sort((a, b) => b.score - a.score);

  sortedQuestions.forEach((item, idx) => {
    const dayIndex = idx % safeDays;
    days[dayIndex].question_ids.push(item.id);
  });

  days.forEach((day, index) => {
    const base = Math.min(90, Math.max(30, minutesPerDay - index * 5));
    day.minutes = base;
    if (day.question_ids.length === 0 && safeQuestionIds.length > 0) {
      day.focus = `Light review ${index + 1}`;
      day.minutes = 30;
    }
  });

  return {
    days_available: safeDays,
    days,
  };
}
