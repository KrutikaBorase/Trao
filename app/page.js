'use client';

import { useEffect, useMemo, useState } from 'react';
import { buildPracticeQueue, reorderQuestions } from '../lib/builder.js';
import { allocateSchedule } from '../lib/schedule.js';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const demoForm = {
  jd: 'Senior Backend Engineer\n\nWe are looking for 5+ years of React, strong distributed systems experience, mentoring junior engineers, and shipping APIs that scale.',
  company_url: 'https://example.com',
  days: 5,
};

export default function HomePage() {
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ email: 'demo@example.com', password: 'password123' });
  const [user, setUser] = useState(null);
  const [form, setForm] = useState(demoForm);
  const [kits, setKits] = useState([]);
  const [selectedKitId, setSelectedKitId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generationStage, setGenerationStage] = useState('');
  const [batchProgress, setBatchProgress] = useState(null);
  const [error, setError] = useState('');
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [confidenceMap, setConfidenceMap] = useState({});
  const [showPracticeAnswer, setShowPracticeAnswer] = useState(false);

  const selectedKit = useMemo(
    () => kits.find((kit) => kit.id === selectedKitId) || kits[0] || null,
    [kits, selectedKitId],
  );

  useEffect(() => {
    const init = async () => {
      try {
        const response = await fetch(`${API}/api/me`, { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          setUser(data.user);
          await fetchKits();
        }
      } catch (_) {
        // no user session yet
      }
    };
    init();
  }, []);

  useEffect(() => {
    setPracticeIndex(0);
    setConfidenceMap(selectedKit?.kit?.practice?.confidence || {});
    setShowPracticeAnswer(false);
  }, [selectedKitId]);

  async function fetchKits() {
    try {
      const response = await fetch(`${API}/api/kits`, { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      setKits(data.kits || []);
      if (data.kits?.length) setSelectedKitId(data.kits[0].id);
    } catch (_) {
      // ignore initial unauthenticated state
    }
  }

  async function readResponse(response, fallbackMessage) {
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : {};
    if (!response.ok) {
      if (response.status === 401) {
        setUser(null);
        setKits([]);
        setSelectedKitId('');
        throw new Error('Your session expired. Please log in again.');
      }
      throw new Error(data.message || fallbackMessage);
    }
    return data;
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setError('');
    try {
      const response = await fetch(`${API}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(authForm),
      });
      const data = await readResponse(response, 'Authentication failed');
      setUser(data.user);
      await fetchKits();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setGenerationStage('Researching company pages');
    try {
      setGenerationStage('Extracting role requirements');
      await new Promise((resolve) => setTimeout(resolve, 150));
      setGenerationStage('Generating and validating questions');
      const response = await fetch(`${API}/api/kits/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...form, id: `case-${Date.now()}` }),
      });
      const data = await readResponse(response, 'Kit generation failed');
      setKits((current) => {
        const filtered = current.filter((entry) => entry.id !== data.id);
        return [
          { id: data.id, status: data.status, kit: data.kit, error: data.error },
          ...filtered,
        ];
      });
      setSelectedKitId(data.id);
      setGenerationStage('Kit ready');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setGenerationStage('');
    }
  }

  async function handleBatchUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      const cases = file.name.toLowerCase().endsWith('.csv')
        ? text.trim().split(/\r?\n/).slice(1).map((line) => {
          const [jd, company_url, days] = line.split(',');
          return { jd, company_url, days: Number(days) || 5 };
        })
        : JSON.parse(text);
      if (!Array.isArray(cases) || !cases.length) throw new Error('Upload must contain at least one case.');
      setBatchProgress({ total: cases.length, completed: 0 });
      for (const [index, item] of cases.entries()) {
        setGenerationStage(`Generating case ${index + 1} of ${cases.length}`);
        const response = await fetch(`${API}/api/kits/generate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ ...item, id: item.id || `upload-${Date.now()}-${index}` }),
        });
        const data = await readResponse(response, `Case ${index + 1} failed`);
        setKits((current) => [{ id: data.id, status: data.status, kit: data.kit, error: data.error }, ...current.filter((entry) => entry.id !== data.id)]);
        setSelectedKitId(data.id);
        setBatchProgress({ total: cases.length, completed: index + 1 });
      }
    } catch (err) {
      setError(err.message || 'Could not read upload. Use JSON or CSV.');
    } finally {
      setGenerationStage('');
      event.target.value = '';
    }
  }

  async function handleLogout() {
    try {
      await fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (_) {
      // Clear the local view even if the API is temporarily unavailable.
    }
    setUser(null);
    setKits([]);
    setSelectedKitId('');
  }

  async function saveSelectedKit() {
    if (!selectedKit?.kit) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`${API}/api/kits/${selectedKit.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ kit: selectedKit.kit }),
      });
      const data = await readResponse(response, 'Could not save kit changes');
      setKits((current) => current.map((entry) => (entry.id === data.id ? { ...entry, kit: data.kit } : entry)));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function regenerateCompanyBrief() {
    if (!selectedKit?.kit) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`${API}/api/kits/${selectedKit.id}/regenerate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ section: 'company-brief' }),
      });
      const data = await readResponse(response, 'Could not regenerate company brief');
      setKits((current) => current.map((entry) => entry.id === data.id ? { ...entry, kit: data.kit } : entry));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function updateQuestion(questionId, field, value) {
    if (!selectedKit?.kit) return;
    setKits((current) =>
      current.map((entry) => {
        if (entry.id !== selectedKit.id) return entry;
        return {
          ...entry,
          kit: {
            ...entry.kit,
            questions: entry.kit.questions.map((question) => {
              if (question.id !== questionId) return question;
              return { ...question, [field]: value, state: question.state === 'generated' ? 'edited' : question.state };
            }),
            flashcards: entry.kit.flashcards.map((flashcard) => {
              if (flashcard.question_id !== questionId) return flashcard;
              return { ...flashcard, [field === 'prompt' ? 'front' : 'back']: value, state: 'edited' };
            }),
          },
        };
      }),
    );
  }

  function updateFlashcard(flashcardId, field, value) {
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : {
      ...entry,
      kit: { ...entry.kit, flashcards: entry.kit.flashcards.map((card) => card.id === flashcardId ? { ...card, [field]: value, state: 'edited' } : card) },
    }));
  }

  function updateCompanyBrief(field, value) {
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : {
      ...entry,
      kit: { ...entry.kit, company_brief: { ...entry.kit.company_brief, [field]: value } },
    }));
  }

  function regenerateSchedule() {
    if (!selectedKit?.kit) return;
    setKits((current) => current.map((entry) => entry.id !== selectedKit.id ? entry : {
      ...entry,
      kit: { ...entry.kit, schedule: allocateSchedule(entry.kit.role.requirements, entry.kit.schedule.days_available, entry.kit.questions.map((question) => question.id), entry.kit.questions) },
    }));
  }

  function deleteQuestion(questionId) {
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : {
      ...entry,
      kit: { ...entry.kit, questions: entry.kit.questions.filter((question) => question.id !== questionId), flashcards: entry.kit.flashcards.filter((card) => card.question_id !== questionId) },
    }));
  }

  function addQuestion() {
    if (!selectedKit?.kit) return;
    const id = `q-custom-${Date.now()}`;
    setKits((current) => current.map((entry) => entry.id !== selectedKit.id ? entry : {
      ...entry,
      kit: { ...entry.kit, questions: [...entry.kit.questions, { id, requirement_ids: [], category: 'technical', prompt: 'Write your interview question', answer_outline: 'Write your answer outline', difficulty: 1, state: 'edited', pinned: true }] },
    }));
  }

  function addFlashcard() {
    if (!selectedKit?.kit) return;
    const id = `f-custom-${Date.now()}`;
    setKits((current) => current.map((entry) => entry.id !== selectedKit.id ? entry : {
      ...entry,
      kit: { ...entry.kit, flashcards: [...entry.kit.flashcards, { id, front: 'Write a flashcard prompt', back: 'Write the answer', requirement_ids: [], state: 'edited', pinned: true }] },
    }));
  }

  function deleteFlashcard(flashcardId) {
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : {
      ...entry,
      kit: { ...entry.kit, flashcards: entry.kit.flashcards.filter((card) => card.id !== flashcardId) },
    }));
  }

  function moveFlashcard(flashcardId, direction) {
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : {
      ...entry,
      kit: { ...entry.kit, flashcards: reorderQuestions(entry.kit.flashcards, flashcardId, direction) },
    }));
  }

  function togglePinned(itemId, collection) {
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : {
      ...entry,
      kit: { ...entry.kit, [collection]: entry.kit[collection].map((item) => item.id === itemId ? { ...item, pinned: !item.pinned, state: 'pinned' } : item) },
    }));
  }

  function moveQuestion(questionId, direction) {
    if (!selectedKit?.kit) return;
    setKits((current) =>
      current.map((entry) => {
        if (entry.id !== selectedKit.id) return entry;
        return {
          ...entry,
          kit: {
            ...entry.kit,
            questions: reorderQuestions(entry.kit.questions, questionId, direction),
          },
        };
      }),
    );
  }

  function regenerateCategory(category) {
    if (!selectedKit?.kit) return;
    setKits((current) =>
      current.map((entry) => {
        if (entry.id !== selectedKit.id) return entry;
        const regeneratedQuestions = entry.kit.questions.map((question) => {
          if (question.category !== category || question.state !== 'generated') return question;
          const requirementText = entry.kit.role.requirements.find((req) => req.id === question.requirement_ids[0])?.text || 'this requirement';
          return {
            ...question,
            prompt: `Prepare a strong answer for: ${requirementText}`,
            answer_outline: `Give a concise answer with examples, trade-offs, and clear structure for ${requirementText}.`,
            state: 'generated',
          };
        });
        return {
          ...entry,
          kit: {
            ...entry.kit,
            questions: regeneratedQuestions,
            flashcards: entry.kit.flashcards.map((flashcard) => {
              const question = regeneratedQuestions.find((item) => item.id === flashcard.question_id);
              return question && question.category === category && question.state === 'generated'
                ? { ...flashcard, front: question.prompt, back: question.answer_outline, state: 'generated' }
                : flashcard;
            }),
          },
        };
      }),
    );
  }

  const practiceCards = useMemo(() => {
    if (!selectedKit?.kit) return [];
    return buildPracticeQueue(selectedKit.kit.flashcards, confidenceMap);
  }, [selectedKit, confidenceMap]);

  const selectedCard = practiceCards[practiceIndex] || null;

  function recordConfidence(value) {
    if (!selectedCard) return;
    const nextConfidence = { ...confidenceMap, [selectedCard.id]: value };
    setConfidenceMap(nextConfidence);
    setShowPracticeAnswer(false);
    setKits((current) => current.map((entry) => entry.id !== selectedKit?.id ? entry : { ...entry, kit: { ...entry.kit, practice: { ...(entry.kit.practice || {}), confidence: nextConfidence } } }));
    setPracticeIndex((idx) => {
      const nextIndex = idx + 1;
      return nextIndex >= practiceCards.length ? 0 : nextIndex;
    });
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
        <div className="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl shadow-cyan-950/30">
          <p className="text-xs uppercase tracking-[0.3em] text-emerald-200">Fieldnote / interview studio</p>
          <h1 className="mt-4 text-3xl font-bold">Access your prep kit</h1>
          <div className="mt-6 flex gap-2 rounded-xl bg-slate-800 p-1">
            {['login', 'register'].map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAuthMode(mode)}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold ${authMode === mode ? 'bg-cyan-500 text-slate-900' : 'text-slate-300'}`}
              >
                {mode === 'login' ? 'Log in' : 'Register'}
              </button>
            ))}
          </div>
          <form onSubmit={handleAuthSubmit} className="mt-6 space-y-4">
            <label className="block text-sm text-slate-300">
              Email
              <input
                type="email"
                value={authForm.email}
                onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Password
              <input
                type="password"
                value={authForm.password}
                onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5"
              />
            </label>
            {error ? <p className="text-sm text-rose-300">{error}</p> : null}
            <button type="submit" className="w-full rounded-xl bg-cyan-500 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-400">
              {authMode === 'login' ? 'Continue' : 'Create account'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-emerald-200">Fieldnote / interview studio</p>
            <h1 className="mt-2 text-2xl font-bold">Turn the role into your advantage.</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-sm text-slate-300">{user.email}</span>
            <button onClick={saveSelectedKit} disabled={saving || !selectedKit?.kit} className="rounded-xl border border-cyan-500/50 px-4 py-2 text-sm font-medium text-cyan-200 hover:border-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button onClick={handleLogout} className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium hover:border-slate-500">
              Log out
            </button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          <aside className="space-y-6">
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-semibold">Create a kit</h2>
              <form onSubmit={handleGenerate} className="mt-4 space-y-4">
                <label className="block text-sm text-slate-300">
                  Company URL
                  <input
                    value={form.company_url}
                    onChange={(event) => setForm({ ...form, company_url: event.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5"
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Days before interview
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={form.days}
                    onChange={(event) => setForm({ ...form, days: Number(event.target.value) || 1 })}
                    className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5"
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Job description
                  <textarea
                    rows={10}
                    value={form.jd}
                    onChange={(event) => setForm({ ...form, jd: event.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5"
                  />
                </label>
                {error ? <p className="text-sm text-rose-300">{error}</p> : null}
                <button type="submit" disabled={loading} className="w-full rounded-xl bg-cyan-500 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60">
                  {loading ? generationStage || 'Generating…' : 'Generate kit'}
                </button>
                <label className="block rounded-xl border border-dashed border-slate-700 p-3 text-sm text-slate-300">
                  Upload multiple roles (JSON or CSV)
                  <input type="file" accept=".json,.csv,application/json,text/csv" onChange={handleBatchUpload} className="mt-2 block w-full text-xs" />
                </label>
                {batchProgress ? <p className="text-xs text-cyan-300">Uploaded cases: {batchProgress.completed}/{batchProgress.total}</p> : null}
              </form>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-semibold">Saved kits</h2>
              <div className="mt-4 space-y-3">
                {kits.length === 0 ? (
                  <p className="text-sm text-slate-400">No kits yet.</p>
                ) : (
                  kits.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedKitId(entry.id)}
                      className={`w-full rounded-xl border p-3 text-left ${selectedKitId === entry.id ? 'border-cyan-400 bg-slate-800' : 'border-slate-700 bg-slate-950'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{entry.kit?.source?.company || 'Kit'}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${entry.status === 'ok' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                          {entry.status || 'pending'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{entry.kit?.role?.title || 'Interview prep'}</p>
                    </button>
                  ))
                )}
              </div>
            </section>
          </aside>

          <section className="space-y-6">
            {!selectedKit || !selectedKit.kit ? (
              <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900 p-12 text-center text-slate-400">
                Generate a kit to view your company brief, questions, flashcards, and schedule.
              </div>
            ) : (
              <>
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.25em] text-cyan-300">Company brief</p>
                      <h2 className="mt-2 text-2xl font-bold">{selectedKit.kit.source.company}</h2>
                    </div>
                    <div className="flex gap-2"><button type="button" onClick={regenerateCompanyBrief} className="rounded-xl border border-slate-700 px-4 py-2 text-sm hover:border-cyan-400">Regenerate brief</button><a href={selectedKit.kit.source.company_url} target="_blank" rel="noreferrer" className="rounded-xl border border-slate-700 px-4 py-2 text-sm hover:border-cyan-400">Open company URL</a></div>
                  </div>
                  <textarea value={selectedKit.kit.company_brief.summary} onChange={(event) => updateCompanyBrief('summary', event.target.value)} rows={3} className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-300" />
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div className="rounded-xl bg-slate-950 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">What they do</p>
                      <textarea value={selectedKit.kit.company_brief.what_they_do} onChange={(event) => updateCompanyBrief('what_they_do', event.target.value)} rows={3} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200" />
                    </div>
                    <div className="rounded-xl bg-slate-950 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Sources</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-200">
                        {selectedKit.kit.company_brief.sources.map((source) => (
                          <li key={source}><a href={source} target="_blank" rel="noreferrer" className="underline underline-offset-2">{source}</a></li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-semibold">Role breakdown</h2>
                  </div>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div className="rounded-xl bg-slate-950 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Title</p>
                      <p className="mt-2 text-lg font-semibold">{selectedKit.kit.role.title}</p>
                    </div>
                    <div className="rounded-xl bg-slate-950 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Seniority</p>
                      <p className="mt-2 text-lg font-semibold">{selectedKit.kit.role.seniority}</p>
                    </div>
                  </div>
                  <ul className="mt-4 space-y-2">
                    {selectedKit.kit.role.requirements.map((requirement) => (
                      <li key={requirement.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{requirement.id}</span>
                          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs uppercase">{requirement.priority}</span>
                        </div>
                        <p className="mt-2 text-slate-200">{requirement.text}</p>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-xl font-semibold">Question bank</h2>
                    <div className="flex gap-2">
                      <button type="button" onClick={addQuestion} className="rounded-lg border border-cyan-500/50 px-2 py-1 text-xs uppercase text-cyan-200">Add question</button>
                      {['technical', 'behavioural', 'company-fit'].map((category) => (
                        <button
                          key={category}
                          type="button"
                          onClick={() => regenerateCategory(category)}
                          className="rounded-lg border border-slate-700 px-2 py-1 text-xs uppercase hover:border-cyan-400"
                        >
                          Regenerate {category}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    {selectedKit.kit.questions.map((question) => (
                      <div key={question.id} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                        <div className="mb-3 flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-cyan-500/20 px-2 py-1 text-xs font-medium text-cyan-300">{question.category}</span>
                            <span className="text-xs text-slate-400">{question.id}</span>
                          </div>
                          <div className="flex gap-2">
                            <button type="button" onClick={() => moveQuestion(question.id, -1)} className="rounded border border-slate-700 px-2 py-1 text-xs">↑</button>
                            <button type="button" onClick={() => moveQuestion(question.id, 1)} className="rounded border border-slate-700 px-2 py-1 text-xs">↓</button>
                            <button type="button" onClick={() => togglePinned(question.id, 'questions')} className="rounded border border-slate-700 px-2 py-1 text-xs">{question.pinned ? 'Unpin' : 'Pin'}</button>
                            <button type="button" onClick={() => deleteQuestion(question.id)} className="rounded border border-rose-500/50 px-2 py-1 text-xs text-rose-300">Delete</button>
                          </div>
                        </div>
                        <textarea
                          value={question.prompt}
                          onChange={(event) => updateQuestion(question.id, 'prompt', event.target.value)}
                          rows={3}
                          className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2"
                        />
                        <select value={question.category} onChange={(event) => updateQuestion(question.id, 'category', event.target.value)} className="mt-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
                          {['technical', 'behavioural', 'company-fit'].map((category) => <option key={category} value={category}>{category}</option>)}
                        </select>
                        <textarea
                          value={question.answer_outline}
                          onChange={(event) => updateQuestion(question.id, 'answer_outline', event.target.value)}
                          rows={3}
                          className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2"
                        />
                        <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                          <span>{question.state || 'generated'}</span>
                          <span>Difficulty {question.difficulty}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">Flashcards</h2><button type="button" onClick={addFlashcard} className="rounded-lg border border-cyan-500/50 px-2 py-1 text-xs uppercase text-cyan-200">Add flashcard</button></div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {selectedKit.kit.flashcards.map((flashcard) => (
                      <div key={flashcard.id} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                        <div className="mb-3 flex justify-end gap-2"><button type="button" onClick={() => moveFlashcard(flashcard.id, -1)} className="rounded border border-slate-700 px-2 py-1 text-xs">↑</button><button type="button" onClick={() => moveFlashcard(flashcard.id, 1)} className="rounded border border-slate-700 px-2 py-1 text-xs">↓</button><button type="button" onClick={() => togglePinned(flashcard.id, 'flashcards')} className="rounded border border-slate-700 px-2 py-1 text-xs">{flashcard.pinned ? 'Unpin' : 'Pin'}</button><button type="button" onClick={() => deleteFlashcard(flashcard.id)} className="rounded border border-rose-500/50 px-2 py-1 text-xs text-rose-300">Delete</button></div>
                        <p className="text-sm text-slate-400">Front</p>
                        <textarea value={flashcard.front} onChange={(event) => updateFlashcard(flashcard.id, 'front', event.target.value)} rows={3} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2" />
                        <p className="mt-4 text-sm text-slate-400">Back</p>
                        <textarea value={flashcard.back} onChange={(event) => updateFlashcard(flashcard.id, 'back', event.target.value)} rows={3} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2" />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold">Practice mode</h2>
                    <button
                      type="button"
                      onClick={() => setPracticeIndex(0)}
                      className="rounded-xl border border-slate-700 px-3 py-2 text-xs uppercase tracking-[0.2em] text-slate-300"
                    >
                      Reset queue
                    </button>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs uppercase tracking-[0.15em]">
                    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><strong className="block text-lg text-emerald-200">{Object.keys(confidenceMap).length}</strong>Covered</div>
                    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><strong className="block text-lg text-coral-200">{Math.max(0, practiceCards.length - Object.keys(confidenceMap).length)}</strong>Uncovered</div>
                    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><strong className="block text-lg text-slate-100">{practiceCards.length}</strong>Total</div>
                  </div>

                  {selectedCard ? (
                    <div className="mt-4 space-y-4 rounded-2xl border border-slate-800 bg-slate-950 p-5">
                      <p className="text-xs uppercase tracking-[0.25em] text-cyan-300">Queue item {practiceIndex + 1} / {practiceCards.length}</p>
                      <p className="text-lg font-semibold text-slate-100">{selectedCard.front}</p>
                      {showPracticeAnswer ? <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-slate-300"><p className="text-xs uppercase tracking-[0.2em] text-slate-400">Answer</p><p className="mt-2">{selectedCard.back}</p></div> : <button type="button" onClick={() => setShowPracticeAnswer(true)} className="rounded-xl border border-emerald-400/50 px-4 py-3 text-sm text-emerald-200">Reveal answer</button>}
                      <div className="flex flex-wrap gap-2">
                        {[1, 2, 3, 4, 5].map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => recordConfidence(value)}
                            className="rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 hover:border-cyan-400"
                          >
                            Rate {value}/5
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-4 text-slate-400">Practice queue complete. Rebuild confidence scores to continue.</p>
                  )}
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Study schedule</h2><button type="button" onClick={regenerateSchedule} className="rounded-lg border border-slate-700 px-2 py-1 text-xs uppercase hover:border-cyan-400">Regenerate schedule</button></div>
                  <div className="mt-4 space-y-3">
                    {selectedKit.kit.schedule.days.map((day) => (
                      <div key={day.day} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold">Day {day.day}</p>
                          <span className="rounded-full bg-slate-800 px-2 py-1 text-xs">{day.minutes} min</span>
                        </div>
                        <p className="mt-2 text-slate-300">{day.focus}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {day.question_ids.map((id) => (
                            <span key={id} className="rounded-full border border-slate-700 px-2 py-1 text-xs">{id}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
