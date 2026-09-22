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
    .split(/\r?\n|[.!?;]+|\s+[•*-]\s+/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*•\d.)]+\s*/, '').trim())
    .filter((line) => line.length >= 4)
    .slice(0, 40);

  const technicalTerms = /\b(?:[a-z][a-z0-9]+(?:\.js|\.net)|api|apis|sdk|sql|nosql|ci\/cd|devops|cloud|data|security|testing|observability|reliability|architecture|infrastructure|platform|frontend|backend|full[- ]stack|machine learning|artificial intelligence|distributed systems|system design|microservices|event[- ]driven|containerization|kubernetes|terraform|graphql|typescript|javascript|python|java|kotlin|scala|swift|rust|c\+\+|c#|go|ruby|php|react|vue|angular|node(?:\.js)?|docker|aws|azure|gcp|kafka|spark|postgres(?:ql)?|mysql|mongodb|redis|elasticsearch|linux|git)\b/i;
  const acronym = /\b[A-Z]{2,}[A-Za-z0-9+#.-]*\b/;
  const requirementLanguage = /\b(?:required|required qualifications?|must(?: have| be)?|need(?:s|ed)?|essential|minimum|preferred|nice to have|bonus|plus|experience with|experience in|proficien(?:t|cy) in|familiar(?:ity)? with|knowledge of|ability to|responsible for|you will|we are looking for|strong|proven|hands[- ]on|years? of)\b/i;
  const behaviouralLanguage = /\b(?:mentor|mentoring|lead|leadership|communicat|collaborat|stakeholder|teamwork|cross[- ]functional|coach|manage|ownership|culture|feedback|negotiat|presentation)\w*/i;

  const requirements = [];
  for (const phrase of phrases) {
    const hasEvidence = requirementLanguage.test(phrase) || technicalTerms.test(phrase) || acronym.test(phrase) || /\b\d+\+?\s*years?\b/i.test(phrase) || behaviouralLanguage.test(phrase);
    if (!hasEvidence) continue;

    const cleaned = phrase.replace(/^(?:we are looking for|the ideal candidate has|responsibilities include)\s*:??\s*/i, '').trim();
    if (cleaned.length < 4) continue;

    const isNice = /\b(?:preferred|nice to have|bonus|plus|optional|ideally)\b/i.test(phrase);
    const requirement = {
      id: `r${requirements.length + 1}`,
      text: cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned,
      kind: behaviouralLanguage.test(phrase) ? 'behavioural' : /domain|industry|market|fintech|healthcare|retail|education/i.test(phrase) ? 'domain' : 'technical',
      priority: isNice ? 'nice' : 'must',
    };

    if (requirements.some((existing) => existing.text.toLowerCase() === requirement.text.toLowerCase())) continue;
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
