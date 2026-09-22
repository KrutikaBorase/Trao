import { allocateSchedule } from '../lib/schedule.js';
import { validateKitStructure, findUncoveredRequirements } from '../lib/validate.js';
import { researchCompany } from './research.js';
import { generateQuestionsWithGemini } from './llm.js';

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || 'role';
}

export function extractRequirementsFromJD(jd) {
  const text = String(jd || '').trim();
  if (!text) {
    return [];
  }

  const phrases = text
    .split(/\n|\.|;|,|\//)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);

  const requirements = [];
  for (const phrase of phrases) {
    const match = /\b(\d+\+?\s*years?|strong|expert|solid|experience|mentoring|design|leadership|backend|frontend|react|node|aws|python|sql|go|kubernetes|system\s+design|distributed\s+systems|api|microservices|mentoring|debugging)/i.exec(phrase);
    if (!match) continue;
    const requirement = {
      id: `r${requirements.length + 1}`,
      text: phrase.length > 140 ? phrase.slice(0, 140) : phrase,
      kind: /mentor|leadership|communication|stakeholder|collaboration|culture|behavior|behaviour/i.test(phrase) ? 'behavioural' : /system|design|distributed|architecture|backend|api|microservices/i.test(phrase) ? 'technical' : 'technical',
      priority: /must|required|minimum|strongly|plus|experience/i.test(phrase) ? 'must' : 'nice',
    };
    requirements.push(requirement);
  }

  if (!requirements.length) {
    return [{ id: 'r1', text: 'No concrete requirements were identifiable in the supplied description.', priority: 'nice', kind: 'technical' }];
  }

  return requirements;
}

function generateTemplateQuestions(requirements, companyBrief) {
  const questions = requirements.map((requirement, index) => ({
    id: `q${index + 1}`,
    requirement_ids: [requirement.id],
    category: requirement.kind === 'behavioural' ? 'behavioural' : requirement.kind === 'domain' ? 'company-fit' : 'technical',
    prompt: `Discuss how your experience relates to: ${requirement.text}`,
    answer_outline: `Explain your approach, evidence, trade-offs, and examples for ${requirement.text}.`,
    difficulty: requirement.priority === 'must' ? 2 : 1,
    state: 'generated',
  }));

  if (companyBrief && /hiring|process|interview/i.test(companyBrief.summary || '')) {
    questions.push({
      id: `q${questions.length + 1}`,
      requirement_ids: requirements.map((req) => req.id).slice(0, 1),
      category: 'company-fit',
      prompt: 'What do you know about the company’s hiring process and how would you prepare for it?',
      answer_outline: 'Summarise the company’s process, show strategic preparation, and explain your interview story.',
      difficulty: 2,
      state: 'generated',
    });
  }

  return questions;
}

async function generateQuestions(requirements, companyBrief) {
  try {
    const generated = await generateQuestionsWithGemini(requirements, companyBrief);
    if (generated) return generated;
  } catch (error) {
    console.warn(`LLM generation unavailable, using deterministic fallback: ${error.message}`);
  }
  return generateTemplateQuestions(requirements, companyBrief);
}

function generateFlashcards(questions) {
  return questions.map((question, index) => ({
    id: `f${index + 1}`,
    question_id: question.id,
    front: question.prompt,
    back: question.answer_outline,
    requirement_ids: question.requirement_ids,
    state: 'generated',
  }));
}

async function buildCompanyBrief(companyUrl) {
  const research = await researchCompany(companyUrl);
  return {
    summary: research.summary,
    what_they_do: research.what_they_do,
    sources: research.sources.length ? research.sources : companyUrl ? [companyUrl] : [],
    interview_process_sources: research.discussionSources || [],
  };
}

function injectCoverage(requirements, questions) {
  const uncovered = findUncoveredRequirements(requirements, questions);
  return { uncovered_requirement_ids: uncovered, passes: 2 };
}

export async function buildKitFromCase({ id, jd, company_url, days }) {
  const safeDays = Math.max(1, Number(days) || 1);
  const requirements = extractRequirementsFromJD(jd);
  const companyBrief = await buildCompanyBrief(company_url);
  let questions = await generateQuestions(requirements, companyBrief, safeDays);
  let coverage = injectCoverage(requirements, questions);

  if (coverage.uncovered_requirement_ids.length) {
    const followUps = requirements
      .filter((req) => coverage.uncovered_requirement_ids.includes(req.id))
      .map((req, idx) => ({
        id: `q${questions.length + idx + 1}`,
        requirement_ids: [req.id],
        category: req.kind === 'behavioural' ? 'behavioural' : 'technical',
        prompt: `Prepare for: ${req.text}`,
        answer_outline: `Answer with concrete examples and a concise strategy for ${req.text}.`,
        difficulty: req.priority === 'must' ? 3 : 2,
        state: 'generated',
      }));
    questions = [...questions, ...followUps];
    coverage = injectCoverage(requirements, questions);
  }

  const flashcards = generateFlashcards(questions);
  const schedule = allocateSchedule(requirements, safeDays, questions.map((q) => q.id), questions);
  const kit = {
    source: {
      company: slugify(company_url || 'acme'),
      company_url: company_url || '',
      role: 'Engineering role',
      location: 'Remote / unspecified',
      jd_chars: Number(String(jd || '').length),
      researched_at: new Date().toISOString(),
      pages_used: companyBrief.sources,
    },
    company_brief: companyBrief,
    role: {
      title: 'Engineer',
      seniority: 'mid-level',
      responsibilities: [
        'Deliver core technical work with a quality bar',
        'Collaborate with peers and stakeholders',
        'Support decision-making and ongoing improvement',
      ],
      requirements,
    },
    questions,
    flashcards,
    schedule,
    coverage,
    practice: { confidence: {} },
  };

  try {
    validateKitStructure(kit);
  } catch (error) {
    return {
      id,
      status: 'failed',
      kit: null,
      error: {
        code: 'INVALID_KIT',
        message: error.message,
      },
    };
  }

  return {
    id,
    status: 'ok',
    kit,
    error: null,
  };
}
