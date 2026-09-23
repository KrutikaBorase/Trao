# AI Interview Prep Kit

## Overview
This project implements a compact full-stack interview-prep application that accepts a job description, a company URL, and a day count, then produces a structured preparation kit. The app is intentionally built as a controlled pipeline: requirement extraction, coverage analysis, schedule generation, and kit validation are deterministic and code-driven, while the UI is a thin interactive shell around that logic.

It now includes a stronger research layer, explicit builder-state handling, a confidence-based practice queue, and signed session cookies with persistent storage for the local assessment build.

## Tech stack
- Frontend: Next.js 14 + Tailwind CSS
- Backend: Node.js + Express
- Storage: MongoDB when `MONGODB_URI` is configured, local JSON fallback for clean-clone development
- Validation: custom JavaScript validation functions
- Batch entry point: `npm run evaluate -- --input <cases.json> --output <kits.json>`

This stack keeps the project simple and easy to run from a clean clone while staying close to the assessment requirements.

## Local setup
1. Install dependencies:
   npm install
2. Create your environment file from the example:
   cp .env.example .env
3. Start the app. For the most reliable local workflow, use two terminals:
   - Terminal 1: `npm run dev:backend`
   - Terminal 2: `npm run dev:frontend`
   - Or use `npm run dev`, which stops both processes together if either fails.
4. Open the frontend at http://localhost:3000 and the backend API at http://localhost:3001.

Environment variables:
- `GEMINI_API_KEY`: server-only Gemini key; never use a `NEXT_PUBLIC_` name.
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `SESSION_SECRET`: signing secret, required in production.
- `FRONTEND_ORIGIN`: comma-separated allowed frontend origins for credentialed CORS.
- `MONGODB_URI` and `MONGODB_DB`: optional durable production persistence. Without them, local JSON files in `data/` are used.

For MongoDB Atlas, add the deployed Render service to the Atlas Network Access allowlist. For a free-tier demo, `0.0.0.0/0` is the simplest option; restrict it further for production. If MongoDB is temporarily unavailable, the backend logs the failure and starts with the local fallback instead of crashing.

## Batch mode
Run the full pipeline for a batch of cases:

npm run evaluate -- --input cases.json --output kits.json

The input file is a JSON array of objects in the form:
[
  { "id": "case-01", "jd": "Senior Backend Engineer...", "company_url": "https://example.com", "days": 5 }
]

The command writes the output structure required by the assessment, including per-case status and a structured error object when a case fails.

The web builder also accepts a JSON array or simple CSV upload containing multiple `{ jd, company_url, days }` cases and shows per-case progress while using the same API pipeline.

## Architecture
- `backend/pipeline.js`: the central kit-building logic used by the app and batch runner
- `lib/schedule.js`: arithmetic-based schedule allocation
- `lib/validate.js`: validation and coverage checking
- `scripts/evaluate.js`: CLI batch entry point
- `app/page.js`: interface shell for generating and reviewing kits
- `backend/server.js`: API endpoints for auth, kit generation, and list retrieval

## Retrieval and research approach
The project uses a lightweight crawled-company strategy with a safe, defensive fetch layer:
- validate the submitted company URL
- reject private / loopback targets in production paths
- fetch only expected content types and small page sizes
- extract links and prioritise likely hiring / about / careers / jobs / handbook pages
- record sources and continue even when a page or domain is unavailable

This is intentionally deterministic and resilient: it ranks likely hiring signals and summarises the best available public context without crashing on missing or rate-limited sources.

The app does not hard-code a fixed list of paths; rather it ranks links by signal (career/hiring keywords, job process language, and canonical site structure) and keeps going even if a source is not discoverable.

## Sequence of generation steps
The production pipeline is intentionally sequential:
1. Extract requirements from the job description.
2. Build a company brief from the company URL and available public signals.
3. Generate separate technical, behavioural, and company-fit question drafts. Gemini uses one validated request per category; the deterministic fallback mirrors the same categories when the provider is unavailable.
4. Check the generated questions against the extracted requirements and find uncovered must-haves.
5. Run a second pass to fill gaps and validate coverage again.
6. Generate flashcards from the final set of questions.
7. Allocate the study schedule using arithmetic across the selected number of days.
8. Validate the whole kit before returning it.

This keeps model output constrained and ensures the category prompts respond to the research and requirements rather than relying on a single giant prompt.

## State handling (generated vs edited vs pinned)
The assessment’s hardest state problem is preserved by separating generation state from user edits. In this implementation, question and flashcard objects are treated as generated items with stable ids, while user edits are reflected by editing the object in-place. Regeneration works by replacing only the generated slice for that section and leaving untouched items as-is, which preserves custom edits unless the user explicitly re-generates the same question or category.

The explicit builder helpers in `lib/builder.js` now centralise queue ordering, category re-generation, and reorder logic so the UI preserves state consistently.

The interface supports inline edits, add/delete/reorder actions, pinning, and an explicit save action. Generated questions and their linked flashcards are regenerated together; edited or pinned items are preserved.

## Practice mode
The app includes a confidence-driven practice queue that reorders flashcards based on lower confidence scores so users work on the weakest material first. Each card lets the user rate their confidence out of five and the queue continues with the next most uncertain item.

## Secure sessions and persistence
Authentication is now protected with signed session tokens instead of unserialised base64 identifiers. Each cookie is created with a server secret and verified on every API request. Passwords are bcrypt-hashed. When `MONGODB_URI` is configured, users and kits are stored in MongoDB; otherwise the local `data/` JSON adapter keeps a clean clone self-contained.

This keeps demo login and kit storage stable without exposing the session as a trivially forgeable token.

## Deployment and public hosting
The repo now includes deployment configuration for the two common hosting patterns:

- Render: `render.yaml` runs the backend and web app as separate services. Set `MONGODB_URI` there for durable storage; Render's local filesystem is not durable across restarts.
- Vercel: `vercel.json` remains as the front-end config for a Next.js deployment.

For public hosting, pick Render if you want both the API and frontend managed in one place. The production environment should set:

- `NODE_ENV=production`
- `SESSION_SECRET=<long random secret>`
- `NEXT_PUBLIC_API_URL=https://<your-api-host>`
- `FRONTEND_ORIGIN=https://<your-web-host>`
- `MONGODB_URI=<managed MongoDB connection string>`
- `MONGODB_DB=interview_prep`

Then deploy the backend and frontend services and confirm that the UI can reach the production API and log in successfully. The repository contains the application and deployment configuration, but the final public URL requires connecting the repository to a hosting account.

## Schedule allocation
The schedule is arithmetic rather than prompt-based. The allocator:
- takes the requested number of days
- prioritises must-have requirements and harder material earlier in the plan
- distributes question IDs across the days using a deterministic round-robin placement
- assigns integer minute counts to each day
- ensures the schedule spans exactly the number of days requested

This logic is implemented in `lib/schedule.js`.

## Failure handling and edge cases
The system fails gracefully in the common edge cases described in the brief:
- invalid or broken company URLs are treated as honest gaps rather than fatal errors
- missing hiring or about pages are reported in the brief and do not stop generation
- thin job descriptions produce a small kit rather than invented requirements
- public discussion with no useful information simply leaves the company brief conservative
- rate-limit or provider failures are returned as structured errors instead of crashing the run
- duplicate descriptions with the same company are treated as repeatable inputs; the app makes the same pipeline decision without duplicating logic
- one-day and sixty-day schedules are both supported by the allocator

## LLM provider
When `GEMINI_API_KEY` is present on the backend, the pipeline calls Gemini for question drafts and validates the returned JSON before accepting it. If the provider is unavailable, rate-limited, or returns invalid data, the pipeline logs the failure and uses the deterministic fallback generator so the kit still completes. The key is server-side only and must never be exposed through `NEXT_PUBLIC_*` variables or client code.

## Design decisions and known limitations
- The app intentionally avoids a heavy database and authentication system because the assessment focuses on pipeline integrity and kit validation.
- The current implementation is intentionally small and deterministic, which improves reliability under free-tier rate limits.
- The generated kit is a realistic draft and not a full production-grade research platform, but it follows the required structure and batch contract.

## Testing
Run the automated checks with:

npm test

The tests cover schedule allocation, coverage-checking, strict kit structure validation, unseen-posting extraction, practice ordering, session signing, and an API authentication smoke test.

## Walkthrough checklist
For the required 3–4 minute walkthrough, show:
1. Paste a job description, enter a company URL, and choose the interview days.
2. Show the research, category generation, coverage pass, and schedule result.
3. Edit and reorder a question, pin it, save, and regenerate its category without losing the edit.
4. Add or delete a flashcard, then use Practice mode to reveal and rate confidence.
5. Upload a JSON or CSV batch and show per-case progress.

## Known limitations
- Gemini requests are rate-limited and have a bounded timeout; the deterministic generator keeps the batch contract available during provider failure.
- External interview discussion search uses a bounded public DuckDuckGo HTML result lookup and records links as optional evidence.
- The local JSON adapter is intentionally for development; configure MongoDB for a durable deployment.
