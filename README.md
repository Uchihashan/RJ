# RJ — Personal Android Assistant

RJ is a personal-use Android app with a fixed **black + red** visual identity. The app is being built as a real Android project, not as a screenshot-only prototype.

## Product requirements
- Android-first, with Tamil, Tanglish and English support.
- Chat-first personal assistant for daily tasks.
- Kids YouTube workflow: topic → story/script → voice → visuals → subtitles → edit/render → scheduled upload.
- Automatic provider fallback when a configured provider reports quota/rate-limit exhaustion.
- Durable job state so interrupted work can resume instead of being lost.
- YouTube upload/scheduling with explicit one-time account authorization and user-configured publishing policy.
- PIN, password and device biometric protection.
- Free-first provider strategy. Provider quotas are finite; RJ must pause/resume safely if every configured free option is exhausted.

## Current implemented app foundation
- Expo SDK 58 / React Native 0.88 Android project.
- Black + red home, video workspace, schedule and security screens.
- Tamil / Tanglish / English video language selector.
- Local video idea persistence and Android reminder notifications.
- Separate RJ Supabase backend in Singapore with five RLS-protected tables: profiles, user_settings, jobs, job_attempts and schedules.
- Durable `pgmq` queue `rj_jobs`, database enqueue trigger, and a Supabase Edge Function worker deployed as `rj-worker`.
- Supabase Cron invokes the worker every minute; a random worker token is stored encrypted in Supabase Vault.
- Per-user Gemini and OpenRouter API keys are stored encrypted in Vault through authenticated RPCs; keys are never returned to the app.
- Story worker tries Gemini first, then OpenRouter's `openrouter/free` route. It does not automatically call paid models.
- Quota/rate-limit and transient failures are recorded in `job_attempts`; jobs are delayed and retried. Jobs paused for missing provider keys automatically resume after a key is saved.
- Database migrations and Edge Function source are tracked under `supabase/`.
- Supabase email account creation/sign-in with persisted sessions stored through Expo SecureStore.
- Signed-in users can save and reload their video project ideas through their own account; project rows are isolated by RLS.
- PIN and password storage using Expo SecureStore.
- Device biometric unlock using Expo Local Authentication.
- GitHub Actions quality workflow: dependency compatibility, Expo Doctor, TypeScript check and Android bundle export.
- GitHub Actions Android build workflow: attempts an installable debug APK artifact on every push/PR to `main`; artifact availability depends on a successful run.

## Current AI pipeline boundary
- The background worker and free-first story provider adapters are deployed, but real provider calls are not yet verified because no provider API keys have been added.
- Once a key is saved in RJ Settings, the worker can generate and save the story script. Story-ready jobs are paused at the next stage until voice, visuals and rendering are implemented.
- Gemini and OpenRouter free usage have changing quotas and availability. OpenRouter's free router is rate-limited; it is not unlimited free compute.

## Not connected yet
These are deliberately shown as pending rather than faked:
- Tamil voice-over generation and audio storage.
- Scene image/video generation, subtitle timing, editing and final rendering.
- YouTube OAuth, upload, private/public state transitions and scheduled publishing.
- Cloud backup for local reminders and push notifications.
- Signed release APK/AAB.

## Security rules
- Never commit API keys, OAuth client secrets, refresh tokens, service-role keys, or passwords.
- Provider secrets are stored per user in Supabase Vault and retrieved only by the server-side worker; never put them in the Android bundle or GitHub.
- Use the separate RJ Supabase project only. Do not reuse the NOOR database or credentials.
- The Android app contains only the Supabase publishable key, which is intended for client use. RLS protects user-owned rows. Never place service-role or provider API keys in the app.
- YouTube publishing must use the user's own OAuth authorization and configured publishing policy.

## Development checks
GitHub Actions runs on pushes and pull requests to `main`:
1. Install dependencies on Node.js 22.
2. Check Expo SDK dependency compatibility.
3. Run Expo Doctor.
4. Run TypeScript checks.
5. Export the Android JavaScript bundle.

## Local development
1. Install Node.js 22.13 or newer.
2. Run `npm install`.
3. Run `npx expo start`.
4. Use a development build for native notification testing.

## APK build
GitHub Actions now builds an installable debug APK artifact on pushes and pull requests. Open the repository's **Actions** tab, select **Build RJ Android APK**, and download the `RJ-android-debug-apk` artifact when the run succeeds. A signed production APK/AAB still requires release signing and a production build profile.

## Project boundary
This repository is **RJ only**. It is separate from the user's NOOR project.
