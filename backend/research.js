import * as cheerio from 'cheerio';

function isSafeUrl(target) {
  try {
    const parsed = new URL(target);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const isPrivate = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
      || host.startsWith('10.') || host.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isPrivate && process.env.NODE_ENV === 'production') return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function rankPage(url, text) {
  const lower = (text || '').toLowerCase();
  let score = 0;
  const keywords = ['careers', 'jobs', 'hiring', 'interview', 'engineer', 'talent', 'culture', 'about', 'team', 'handbook'];
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += 2;
  }
  if (/careers|jobs|hiring|interview/.test(url)) score += 4;
  if (lower.length > 300) score += 1;
  return score;
}

export async function researchCompany(companyUrl) {
  if (!companyUrl) {
    return {
      summary: 'No company URL was supplied, so the brief is intentionally conservative.',
      what_they_do: 'No company details were available.',
      sources: [],
      hiringSignals: [],
    };
  }

  try {
    const parsed = new URL(companyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }
  } catch {
    return {
      summary: 'The supplied company URL was invalid, so the company brief is intentionally limited.',
      what_they_do: 'No company description could be verified from the provided address.',
      sources: [],
      hiringSignals: [],
    };
  }

  const sources = [];
  const hiringSignals = [];
  const seen = new Set();
  const finalSignals = [];
  const fetchedAt = new Map();
  let robotsRules = [];
  const discussionSources = [];

  function maybeAddSignal(text) {
    if (!text) return;
    const cleaned = String(text).replace(/\s+/g, ' ').trim();
    if (cleaned.length > 120) finalSignals.push(cleaned);
  }

  function allowedByRobots(url) {
    try {
      const path = new URL(url).pathname;
      return !robotsRules.some((rule) => rule && path.startsWith(rule));
    } catch {
      return false;
    }
  }

  async function waitForDomain(url) {
    const origin = new URL(url).origin;
    const previous = fetchedAt.get(origin) || 0;
    const delay = Math.max(0, 150 - (Date.now() - previous));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    fetchedAt.set(origin, Date.now());
  }

  async function fetchPage(url, attempt = 0) {
    if (!isSafeUrl(url) || seen.has(url)) return null;
    if (!allowedByRobots(url)) return null;
    seen.add(url);

    try {
      await waitForDomain(url);
      const response = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { 'user-agent': 'Mozilla/5.0 interview-prep-kit' } });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        seen.delete(url);
        await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
        return fetchPage(url, attempt + 1);
      }
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return null;
      const html = await response.text();
      if (html.length > 200000) return null;
      sources.push(url);
      return html;
    } catch {
      return null;
    }
  }

  async function searchPublicDiscussion() {
    try {
      const host = new URL(companyUrl).hostname.replace(/^www\./, '');
      const query = encodeURIComponent(`"${host}" interview process engineering`);
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'interview-prep-kit research bot' },
      });
      if (!response.ok) return;
      const html = await response.text();
      const $ = cheerio.load(html);
      $('.result__a').slice(0, 3).each((_, element) => {
        const href = $(element).attr('href');
        if (href && /^https?:/i.test(href)) discussionSources.push(href);
      });
    } catch {
      // External discussion is optional evidence; the company crawl remains useful.
    }
  }

  try {
    const robotsUrl = new URL('/robots.txt', companyUrl).toString();
    const robotsResponse = await fetch(robotsUrl, { signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'interview-prep-kit' } });
    if (robotsResponse.ok) {
      const robotsText = await robotsResponse.text();
      robotsRules = robotsText.split(/\r?\n/)
        .filter((line) => /^disallow:/i.test(line))
        .map((line) => line.replace(/^disallow:\s*/i, '').trim())
        .filter(Boolean);
    }
  } catch {
    // A missing robots file does not prevent public-page research.
  }

  const homepage = await fetchPage(companyUrl);
  let homepageText = '';
  let candidatePages = [];

  if (homepage) {
    homepageText = extractTextFromHtml(homepage);
    const $ = cheerio.load(homepage);
    const hrefs = new Set();
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      const normalized = normalizeUrl(companyUrl, href);
      if (!normalized || !isSafeUrl(normalized)) return;
      hrefs.add(normalized);
    });

    for (const href of [...hrefs].slice(0, 12)) {
      const pageHtml = await fetchPage(href);
      if (!pageHtml) continue;
      const text = extractTextFromHtml(pageHtml);
      const score = rankPage(href, text);
      if (score > 0) candidatePages.push({ url: href, score, text });
    }
  }

  maybeAddSignal(homepageText);

  candidatePages.sort((a, b) => b.score - a.score);
  const topPages = candidatePages.slice(0, 4);

  for (const page of topPages) {
    maybeAddSignal(page.text);
  }

  await searchPublicDiscussion();

  for (const page of topPages) {
    if (/careers|jobs|hiring|interview|culture|team|about|handbook/.test(page.url.toLowerCase())) {
      hiringSignals.push(page.url);
    }
  }

  const evidenceText = finalSignals.join(' ');
  const summary = evidenceText.length > 120
    ? evidenceText.slice(0, 420)
    : 'No public company or hiring detail was discoverable from the provided URL, so the brief is intentionally conservative.';

  const companySummary = summary
    .replace(/\s+/g, ' ')
    .trim();

  const whatTheyDo = /products?|platform|software|services|engineering|cloud|data|security|ai|analytics/i.test(companySummary)
    ? 'The company appears to operate in a software, platform, or technical services domain, with public hiring signals suggesting engineering and product-oriented work.'
    : 'The company could not be reliably identified from public pages, so the brief is intentionally conservative.';

  return {
    summary: companySummary,
    what_they_do: whatTheyDo,
    sources: [...new Set(sources.concat(hiringSignals, discussionSources))].slice(0, 8),
    hiringSignals,
    discussionSources,
  };
}
