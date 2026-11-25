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
3. **Permission-controlled tools** — read-only tasks may run within the user's granted scope. Actions such as YouTube upload, publish, delete, account changes, connecting a new provider, or spending paid credits require clear user consent at the appropriate point.
4. **Dynamic Tool Hub / integrations** — RJ includes an in-app catalogue where the user can search, connect, configure, test, pause, and disconnect tools/services. It must support a growing adapter model rather than a hard-coded list: coding/development tools, Google services, AI model providers, image/video/audio generation, storage, publishing, and future MCP/API integrations. Show each integration's capabilities, permissions, pricing/free-tier notes where verifiable, connection state, and required setup. The agent can recommend a tool for a task and guide the user through OAuth/API-key setup without asking for passwords in chat. Credentials are stored encrypted server-side and scoped per user. Unknown tools are not silently trusted: validate manifests, scopes, endpoints, and permissions before enabling them.
5. **Google Flow / Google video provider support** — expose a Google video integration inside RJ's Tool Hub and creator workflow. The user must remain in RJ's UI: no forced navigation to the Flow website/app and no “open Flow to finish” step. Before implementation, verify Google's currently supported official developer interfaces and account/region/plan restrictions. Google's Flow product is a consumer creative studio; do not assume Flow's own credits or private website features are callable from an app API. If no official Flow API is available, use an official supported Google video-generation API (for example, Gemini/Veo where available) behind the same provider adapter, and label it accurately as Google video generation rather than claiming it is the Flow API. Do not use fragile browser-cookie scraping or unofficial account automation. If an authorized supported Flow connector/API becomes available, it can be added without changing the in-app workflow.
6. **In-app video creation experience** — a user can type a prompt or request a video in RJ chat; RJ plans the job, asks only for essential missing details, shows an editable preview of the plan, then runs the pipeline in the background. The user stays in the RJ APK and sees progress, stages, generated previews, errors, retry/cancel controls, and the final video. The pipeline is: brief/prompt → script/storyboard → scene/image/video generation → Tamil voice-over → subtitles/captions → assembly/render → quality preview → user approval → publish/upload. Store outputs in the user's RJ project and storage; allow download/share from inside RJ. Do not hand the user off to an external editing website to complete the job.
7. **Provider routing and cost controls** — define capability-based adapters (text, image, video, speech, transcription, rendering, storage, publishing). Route each stage to the best connected provider that meets the user's quality, language, privacy, and budget settings. Prefer genuinely free tiers when available, show quotas/credit use and any likely charge before a paid run, and never promise unlimited/free generation. Support provider fallback only when the fallback is compatible and the user has permitted it.
8. **Durable execution** — all long-running work is recorded in RJ's queue, with idempotency keys, progress stages, retry/backoff, cancellation, and visible error states.
9. **YouTube connection** — OAuth authorization uses the user's own Google account. Refresh tokens remain server-side and encrypted; publishing follows the user's configured privacy/scheduling policy. The user reviews title, description, visibility, thumbnail, and schedule and confirms before upload/publish.
10. **Audit and security** — RLS for user-owned records, server-only secrets, validated tool inputs, rate limits, action audit records, least-privilege OAuth scopes, integration disconnect/revoke support, and no reuse of NOOR credentials or database.

## Delivery sequence

### Phase 1 — AI Brain foundation
- Add authenticated conversation storage and an assistant Edge Function.
- Add provider adapter/fallback shared with the existing worker.
- Replace the echo-only chat with real streaming or request/response AI chat.
- Add a typed task/action contract and a confirmation UI for side effects.
- Add tests for language routing, malformed model output, authorization, and provider failure.

### Phase 2 — Agent task execution and Tool Hub
- Add a typed, capability-based tool registry with per-tool permission scopes and validated integration manifests.
- Build the in-app Tool Hub: browse/search, connect, configure, test, view permissions/status, pause, and disconnect.
- Add OAuth and secure API-key connection flows; never request or store provider passwords in chat.
- Connect safe app tasks (create/list/update reminders and video projects) to real app/backend actions.
- Add job progress, cancellation, retry, and audit history.
- Require confirmation for external, paid, or destructive actions.

### Phase 3 — In-app creator studio and Google video integration
- Implement provider adapters for image, video, speech, subtitles, and rendering; evaluate supported Google video APIs and Flow integration honestly.
- Build the complete resumable creator pipeline and in-app project/preview/editor experience.
- Ensure prompt-to-video creation can complete within the RJ APK without redirecting to a separate creative website.
- Implement Google OAuth and secure token storage for supported Google services.
- Implement YouTube upload privacy selection, scheduling, and final pre-publish confirmation.
- Add integration tests with mocked provider and YouTube responses, plus tests for quota exhaustion, provider fallback, cancellation, and interrupted rendering.

### Phase 4 — Branding, Android QA, and release readiness
- Apply the exact approved Dragon + Crown RJ logo unchanged to app icon and launch screen.
- Keep the existing dark UI and approved RJ identity; do not add prohibited logo wording.
- Run Expo dependency checks, Expo Doctor, TypeScript, Edge Function checks, Android export, and APK build.
- Test sign-in, chat, tool connection/disconnection, permissions, paid-credit confirmation, video job recovery, preview, upload confirmation, language handling, and Android install/launch.

## Acceptance criteria

- RJ responds naturally in Tamil, Tanglish, and English.
- Chat is connected to a real backend AI gateway; no echo-only placeholder remains.
- The assistant can discover and use connected tools through a permission-controlled registry, and the user can connect/disconnect integrations from inside RJ.
- Tool integrations are modular: adding a new supported API/MCP provider does not require rebuilding the entire agent architecture.
- Google video generation is accessible from RJ's in-app workflow; RJ does not force the user to open Google Flow or another external editor to finish a video. The implementation must not misrepresent an official Flow API if none is available.
- A user can enter a prompt in RJ, receive a generated video inside RJ, preview it, and approve upload from the same APK.
- Long-running jobs survive app restarts and can be resumed or cancelled.
- YouTube publishing uses the user's own OAuth connection and the configured privacy policy, with explicit confirmation before upload/publish.
- Provider costs, credit consumption, and free-tier limits are shown accurately; paid actions require consent.
- No provider keys, OAuth secrets, refresh tokens, or service-role credentials are bundled in the app or committed to Git.
- All work stays in the RJ repository and RJ Supabase project. NOOR remains untouched.
- The final approved logo is used as-is, with no added text or redesign.

## Safety boundary

Do not merge this branch into `main` or deploy production changes without the user's explicit approval. Never use NOOR infrastructure, credentials, or data for RJ.


## Non-negotiable requirement: Autonomous Video Operations

The user requires RJ to operate as an autonomous, cloud-run video production and publishing agent. This is a product requirement, not an optional enhancement to the editor.

### A. Capability-based provider failover

- Every production stage must declare required capabilities and accepted output formats: script/text, image, video clips, speech, transcription, captions, media assembly/rendering, storage, and YouTube publishing.
- Maintain a server-side provider registry with per-user connection state, supported capabilities, model/format constraints, region availability, quota/rate-limit state, health, estimated cost, and priority.
- Before a stage starts, select the best eligible provider for that exact capability and the user's quality/budget policy.
- On quota exhaustion (HTTP 429, provider quota/resource-exhausted response), cooldown that provider for the provider-reported reset time when available; otherwise use bounded exponential backoff. Immediately try the next compatible, connected, user-authorized provider.
- Also fail over for transient network/5xx/provider outages. Do not blindly retry invalid credentials, unsupported formats, policy blocks, or invalid input; mark the provider/configuration as needing attention and continue only with a compatible alternative.
- Persist every attempt and provider decision. Do not repeat a paid operation after an ambiguous timeout unless the provider supports idempotency or the previous result has been reconciled.
- Never claim that every job can always finish: if every compatible provider is unavailable, out of quota, disconnected, or over the user's budget, keep the job durable and resumable, show exactly which stage is blocked, and notify the user. Never silently switch to a paid provider without the user's prior spending permission.
- No single vendor is mandatory. Integrations must be replaceable adapters; never depend on private browser cookies or unofficial web scraping.

### B. Complete video pipeline

A job is not complete when a story/script is generated. Track durable stages independently:
1. Brief and schedule validation
2. Script and storyboard
3. Scene asset generation
4. Voice-over and audio
5. Captions/subtitle timing
6. Timeline assembly and editing
7. Render/export
8. Quality checks and final preview
9. YouTube metadata and thumbnail
10. Upload as private/scheduled, then verify the platform's returned video ID and scheduled publish time

Each stage stores inputs, outputs, provider, attempt history, timestamps, and retry state. A retry resumes from the last verified successful stage; it must not regenerate or re-charge completed stages unnecessarily. The final deliverable must be an actual playable video file, not just an editor form or script.

### C. Multi-channel / multi-recipient publishing calendar

- Support multiple independently authorized YouTube channels/destinations, each with its own encrypted OAuth tokens, channel identity, timezone, upload defaults, and permissions.
- Let the user create a publishing plan in one request: destination/channel, video count, dates, exact local times, language/topic/template, visibility, and optional recurrence.
- Support separate plans for two or more people/channels, with isolated content, assets, credentials, and schedules. Never cross-post to another person's channel unless that channel owner has authorized the connection and the user has permission to publish there.
- Store schedule timestamps as timezone-aware instants and retain the IANA timezone used to enter them. Default the user's local schedule UI to Asia/Colombo only when that is the user's selected timezone.
- Show a calendar/list with queued, generating, ready, upload-pending, scheduled, published, retrying, blocked, and failed states. Allow reschedule, pause, cancel, and retry.
- Before the deadline, generate and render early enough to leave a configurable safety buffer. The scheduled publish time is the target; do not wait until the last minute to begin generation.
- Prefer YouTube's supported scheduled-publishing flow: upload the completed video as private with the approved publish time when supported, then verify the video resource. If the channel/API does not support the requested operation or quota is exhausted, preserve the asset and report the exact issue; do not falsely mark it published.

### D. App-closed execution and reliability

- The Android app is only the control panel. Once a plan is saved, cloud database + durable queue + scheduled cloud worker own execution. Android background timers, local notifications, or the app remaining open must never be required.
- Use the existing Supabase Postgres/pgmq queue and pg_cron worker as the durable scheduling foundation; extend the existing minute worker rather than creating a second competing scheduler.
- Workers must claim work safely, use idempotency keys, lease/visibility timeouts, bounded concurrency, retry/backoff, dead-letter/blocked states, and periodic recovery of expired leases.
- Each stage commits progress before proceeding. If a worker is restarted or a function reaches its runtime limit, another worker resumes from stored state.
- Alert on deadline risk and final failure. The app should display server-side status whenever reopened; push notifications are helpful but not the source of truth.

### E. Implementation order and acceptance tests

1. Provider registry + capability-aware router + quota cooldown and attempt history.
2. Durable pipeline stage state machine + resumable workers.
3. Multi-channel OAuth credential isolation and YouTube publishing adapter.
4. Calendar UI for bulk plans, multiple destinations, timezone-aware scheduling, and run status.
5. End-to-end media rendering and verification.

Acceptance tests must include: provider A returns 429 and provider B completes the same stage; all providers unavailable then job resumes after cooldown; app is force-closed and a scheduled job still runs; two channels receive only their own assigned videos; duplicate cron/worker invocations do not create duplicate uploads; a render completed early is published at the requested local time; a deadline cannot be met and RJ reports it rather than claiming success; and no paid fallback runs without prior consent.


## Implementation status — 2026-11-25

This status supersedes earlier audit bullets where they conflict.

### Implemented on `feature/rj-full-integration`
- Authenticated Tamil/Tanglish/English assistant request/response gateway using Gemini with OpenRouter fallback.
- Per-user provider keys are retrieved server-side through the existing Vault RPC; keys are not bundled in the app.
- Local app actions for video-project creation, reminder creation, and tab navigation require an explicit confirmation card; duplicate actions are prevented while a confirmed action runs, and the assistant reports the actual action result.
- Tamil/Tanglish aliases for supported video, reminder, and navigation commands; a new message cancels an older unconfirmed action.
- Signed-out video ideas are saved as local drafts and are not misreported as cloud-queued jobs; signed-in jobs use the durable cloud queue.
- Video project queue and first story-generation worker stage.
- Durable pipeline-stage schema, persisted progress display, and stage status tracking for running, blocked, waiting-retry, succeeded, and failed states.
- Text-provider health and cooldown routing: quota/transient failures cool down a provider, compatible configured text providers are tried as fallback, and paused jobs can resume after a provider key is connected.
- When no compatible image/video adapter is connected, the worker explicitly blocks at scene-assets rather than claiming a finished video.
- Agent permission and action-audit schema, plus an authenticated `rj-agent-actions` Edge Function for per-user permission listing/updates, server-side allowlist checks, explicit-confirmation gating, and action completion audit.
- Settings controls for enabling/disabling the currently supported agent tools (video project creation, reminder creation, and app navigation); new permissions default to disabled and each action still requires confirmation.
- Server audit entries record proposed/confirmed/succeeded/failed/denied outcomes and store only allowlisted, sanitized action arguments.
- Browser-only private CI artifact workflow; no public web deployment.
- Reminder validation uses the requested reminder time, not the screen's default time.

### Still not implemented / not verified
- The permission/audit migration and Edge Function are committed on the feature branch but are not deployed to the hosted Supabase project. The enforcement currently covers the three app actions wired into the assistant (video project creation, reminder creation, and navigation); YouTube/provider-management actions are reserved in the allowlist but are not yet connected to UI execution.
- Capability-aware adapters and provider selection for image, video, speech, captioning, rendering, storage, and YouTube are not complete.
- No end-to-end playable video renderer or media asset pipeline exists yet.
- No YouTube OAuth connection, multi-channel token management, upload, scheduled publishing, or verification flow exists yet.
- No separate long-running media worker has been deployed. The current Supabase worker handles the story stage only.
- Stage progress is persisted, but the full stage runner, retry/resume behavior per media stage, cancellation, and end-to-end acceptance tests remain outstanding.
- Supabase migrations in this branch have not been applied to the hosted RJ project. Worker code that writes `job_stages` requires the autonomous-operations migration to be applied before that worker version is deployed.
- No production Edge Function deployment, Render deployment, `main` merge, or APK build has been performed.

### External prerequisites for actual full video publishing
- A supported, authorized video-generation provider and its credentials. Google Flow is a consumer studio, not assumed to expose a public app API; use a documented Google Cloud/Gemini video API adapter only where the account, region, model, and billing permit it.
- A speech/TTS provider, rendering runtime, and storage bucket with sufficient capacity.
- Google OAuth client configuration and YouTube Data API project approval/quota for each channel owner. Refresh tokens must remain server-side and encrypted.
- Explicit per-user paid-provider budget approval before any non-free generation or rendering is attempted.

Do not describe RJ as a completed autonomous video publisher until the remaining items above are implemented, deployed with approval, and end-to-end tested.
