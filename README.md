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
- Local video idea persistence on device.
- Local reminder persistence and scheduled Android notifications (permission required).
- PIN and password storage using Expo SecureStore.
- Device biometric unlock using Expo Local Authentication.
- GitHub Actions quality workflow: dependency compatibility, Expo Doctor, TypeScript check and Android bundle export.
- GitHub Actions Android build workflow: creates an installable debug APK artifact on every push/PR to `main`.

## Not connected yet
These are deliberately shown as pending rather than faked:
- AI model/provider APIs and automatic free-tier fallback.
- Story, voice, image/video generation and rendering pipeline.
- Dedicated RJ cloud backend, durable server-side job queue and background worker.
- YouTube OAuth, upload, privacy state and scheduled publishing.
- Cloud backup/sync and push notifications.
- Signed release APK.

## Security rules
- Never commit API keys, OAuth client secrets, refresh tokens, service-role keys, or passwords.
- Provider secrets belong in server-side secret storage, never inside the Android bundle.
- Use a separate RJ backend project. Do not reuse the NOOR database or credentials.
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
