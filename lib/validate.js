const REQUIRED_FIELDS = [
  'source.company',
  'source.company_url',
  'source.role',
  'source.jd_chars',
  'source.researched_at',
  'source.pages_used',
  'company_brief.summary',
  'company_brief.what_they_do',
  'company_brief.sources',
  'role.title',
  'role.seniority',
  'role.responsibilities',
  'role.requirements',
  'questions',
  'flashcards',
  'schedule.days_available',
  'schedule.days',
  'coverage.uncovered_requirement_ids',
  'coverage.passes',
];

function getPathValue(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

export function validateKitStructure(kit) {
  if (!kit || typeof kit !== 'object') {
    throw new Error('Invalid kit: expected object');
  }

  for (const field of REQUIRED_FIELDS) {
    const value = getPathValue(kit, field);
    if (value === undefined || value === null) {
      throw new Error(`Invalid kit: missing ${field}`);
    }
  }

  if (!Array.isArray(kit.role.requirements) || !kit.role.requirements.length) {
    throw new Error('Invalid kit: role.requirements must be an array with at least one item');
  }

  if (!Array.isArray(kit.questions) || !Array.isArray(kit.flashcards) || !Array.isArray(kit.schedule.days)) {
    throw new Error('Invalid kit: questions, flashcards, and schedule.days must be arrays');
  }

  if (!Number.isInteger(kit.schedule.days_available) || kit.schedule.days_available < 1 || kit.schedule.days.length !== kit.schedule.days_available) {
    throw new Error('Invalid kit: schedule day count must match days_available');
  }

  const requirementIds = new Set();
  for (const requirement of kit.role.requirements) {
    if (requirementIds.has(requirement.id) || !requirement.id || !requirement.text || !['must', 'nice'].includes(requirement.priority) || !['technical', 'behavioural', 'domain'].includes(requirement.kind)) {
      throw new Error('Invalid kit: requirement entries are incomplete or invalid');
    }
    requirementIds.add(requirement.id);
  }

  const questionIds = new Set();
  for (const question of kit.questions) {
    if (questionIds.has(question.id) || !question.id || !question.prompt || !question.answer_outline || !Number.isInteger(question.difficulty) || question.difficulty < 1 || question.difficulty > 3) {
      throw new Error('Invalid kit: question entries are incomplete or invalid');
    }
    if (!Array.isArray(question.requirement_ids) || question.requirement_ids.some((id) => !requirementIds.has(id))) {
      throw new Error('Invalid kit: question references an unknown requirement');
    }
    questionIds.add(question.id);
  }

  const flashcardIds = new Set();
  for (const flashcard of kit.flashcards) {
    if (flashcardIds.has(flashcard.id) || !flashcard.id || typeof flashcard.front !== 'string' || typeof flashcard.back !== 'string') {
      throw new Error('Invalid kit: flashcard entries are incomplete or invalid');
    }
    if (!Array.isArray(flashcard.requirement_ids) || flashcard.requirement_ids.some((id) => !requirementIds.has(id))) {
      throw new Error('Invalid kit: flashcard references an unknown requirement');
    }
    flashcardIds.add(flashcard.id);
  }

  const scheduledQuestionIds = new Set();
  for (const day of kit.schedule.days) {
    if (!Number.isInteger(day.day) || !Number.isInteger(day.minutes) || day.minutes < 1 || !Array.isArray(day.question_ids)) {
      throw new Error('Invalid kit: schedule day is incomplete or invalid');
    }
    for (const questionId of day.question_ids) {
      if (!questionIds.has(questionId)) throw new Error('Invalid kit: schedule references an unknown question');
      scheduledQuestionIds.add(questionId);
    }
  }

  const mustRequirementIds = kit.role.requirements.filter((requirement) => requirement.priority === 'must').map((requirement) => requirement.id);
  const scheduledMustIds = new Set(kit.questions.filter((question) => scheduledQuestionIds.has(question.id)).flatMap((question) => question.requirement_ids));
  if (mustRequirementIds.some((id) => !scheduledMustIds.has(id))) {
    throw new Error('Invalid kit: schedule does not cover every must-have requirement');
  }

  return true;
}

export function findUncoveredRequirements(requirements, questions) {
  const requirementIds = (requirements || []).map((requirement) => requirement.id);
  const covered = new Set();

  for (const question of questions || []) {
    if (Array.isArray(question.requirement_ids)) {
      for (const requirementId of question.requirement_ids) {
        if (requirementIds.includes(requirementId)) {
          covered.add(requirementId);
        }
      }
    }
  }

  return requirements
    .filter((requirement) => requirement.priority === 'must' && !covered.has(requirement.id))
    .map((requirement) => requirement.id);
}
