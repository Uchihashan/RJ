# RJ

RJ is a personal Android assistant app. Its confirmed visual identity is **black + red**.

## Current foundation
- Expo / React Native Android project
- Tamil, Tanglish and English interface direction
- Home assistant dashboard, video idea workspace, schedule screen and settings screen
- Secure local PIN storage and device biometric authentication foundation
- EAS configuration for a preview APK build

## Current integration status
AI story/video generation, voice generation, YouTube OAuth/upload/scheduling, cloud sync, push notifications, and account password authentication are not connected yet. The app labels these as pending integrations rather than pretending they already work. Never commit API keys or OAuth secrets to this repository.

## Run locally
1. Install Node.js.
2. Run `npm install`.
3. Run `npx expo start`.
4. Open the project with Expo Go for UI testing.

## Android APK
Configure an EAS project, then run `eas build --platform android --profile preview`.
