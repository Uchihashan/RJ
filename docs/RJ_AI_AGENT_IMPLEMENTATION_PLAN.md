# RJ AI Agent — Implementation Plan

## Repository audit

Repository: `Uchihashan/RJ`  
Base branch: `main`  
Working branch: `feature/rj-full-integration`

The existing app is an Expo SDK 58 / React Native Android app. It already has Supabase email authentication, SecureStore-backed sessions, local PIN/password/biometric protection, Tamil/Tanglish/English video-language selection, local reminders, and a Supabase-backed durable job queue.

The separate RJ Supabase backend already contains RLS-protected profile, settings, job, attempt, and schedule tables; a `pgmq` queue; a scheduled Edge Function worker; encrypted per-user Gemini/OpenRouter credentials; provider fallback; retry handling; and the first children's-story generation stage.

## Verified gaps

- The current chat screen is a placeholder; it echoes the user's text and does not call an AI assistant.
- The worker currently handles only the `video_generation` job type and pauses after the story stage.
- Tamil voice generation, visual generation, subtitle timing, rendering, YouTube OAuth, upload, and scheduled publishing are not implemented.
- The UI currently uses text-only RJ branding. The approved Dragon + Crown RJ image must be used unchanged for the app icon and launch screen; no “AI Assistant” or “Personal AI Assistant” text may be added to the logo.
- The current GitHub Actions workflows provide dependency/type checks, Android bundle export, and an installable Android APK build.

## Target architecture

1. **RJ conversation gateway** — authenticated Supabase Edge Function receives Tamil, Tanglish, and English messages, loads only the signed-in user's permitted context, and calls the configured free-first model provider from server-side Vault credentials.
2. **Structured agent decisions** — model output is validated against a strict action schema. Ordinary answers return as messages; tasks become durable jobs; unsafe or external side effects are never executed from free-form model text.
3. **Permission-controlled tools** — read-only tasks may run within the user's granted scope. Actions such as YouTube upload, publish, delete, or account changes require an explicit confirmation in the app immediately before execution.
4. **Durable execution** — all long-running work is recorded in RJ's queue, with idempotency keys, progress stages, retry/backoff, cancellation, and visible error states.
5. **YouTube connection** — OAuth authorization uses the user's own Google account. Refresh tokens remain server-side and encrypted; publishing follows the user's configured privacy/scheduling policy.
6. **Creator pipeline** — story/script → Tamil voice-over → scene assets → subtitle timing → render → user review → YouTube upload/schedule. Each stage stores its output and can resume after interruption.
7. **Audit and security** — RLS for user-owned records, server-only secrets, validated tool inputs, rate limits, action audit records, and no reuse of NOOR credentials or database.

## Delivery sequence

### Phase 1 — AI Brain foundation
- Add authenticated conversation storage and an assistant Edge Function.
- Add provider adapter/fallback shared with the existing worker.
- Replace the echo-only chat with real streaming or request/response AI chat.
- Add a typed task/action contract and a confirmation UI for side effects.
- Add tests for language routing, malformed model output, authorization, and provider failure.

### Phase 2 — Agent task execution
- Add a typed tool registry with per-tool permission scopes.
- Connect safe app tasks (create/list/update reminders and video projects) to real app/backend actions.
- Add job progress, cancellation, retry, and audit history.
- Require confirmation for external or destructive actions.

### Phase 3 — YouTube and creator pipeline
- Implement Google OAuth and secure token storage.
- Implement the media pipeline as resumable queue stages.
- Add upload privacy selection, scheduling, and final pre-publish confirmation.
- Add integration tests with mocked provider and YouTube responses.

### Phase 4 — Branding, Android QA, and release readiness
- Apply the exact approved Dragon + Crown RJ logo unchanged to app icon and launch screen.
- Keep the existing dark UI and approved RJ identity; do not add prohibited logo wording.
- Run Expo dependency checks, Expo Doctor, TypeScript, Edge Function checks, Android export, and APK build.
- Test sign-in, chat, task confirmations, queue recovery, language handling, and Android install/launch.

## Acceptance criteria

- RJ responds naturally in Tamil, Tanglish, and English.
- Chat is connected to a real backend AI gateway; no echo-only placeholder remains.
- The assistant cannot silently execute external/destructive actions.
- Long-running jobs survive app restarts and can be resumed or cancelled.
- YouTube publishing uses the user's own OAuth connection and the configured privacy policy.
- No provider keys, OAuth secrets, refresh tokens, or service-role credentials are bundled in the app or committed to Git.
- All work stays in the RJ repository and RJ Supabase project. NOOR remains untouched.
- The final approved logo is used as-is, with no added text or redesign.

## Safety boundary

Do not merge this branch into `main` or deploy production changes without the user's explicit approval. Never use NOOR infrastructure, credentials, or data for RJ.
