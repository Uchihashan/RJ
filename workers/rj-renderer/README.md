# RJ FFmpeg Renderer Worker

This isolated Docker worker converts a saved RJ story into a playable 1280x720 H.264 MP4 storyboard, a thumbnail, and an SRT captions sidecar.

## Current output scope

- Generates text-led vector scene cards from the saved story. These are not AI-generated images.
- Renders the cards into an MP4 with FFmpeg.
- Generates scene-timed SRT captions. Captions are not aligned to speech.
- No narration/audio is added while the speech provider remains disabled.
- Does not upload to YouTube or schedule publishing.
- Uses a private Supabase Storage bucket and stores object paths in the job output.
- Uses the durable `rj_claim_job_stage` lease RPC to avoid concurrent processing.

The renderer deliberately makes no paid image, video, or speech API calls.

## Required environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only key; never put this in the Android app
- Optional `RJ_RENDER_BUCKET` (defaults to `rj-renders`)
- Optional `RJ_RENDER_POLL_MS` (defaults to 15000)
- Optional `RJ_RENDER_BATCH_SIZE` (defaults to 2)

## Build and run

Build from the repository root with Docker context `workers/rj-renderer`:

```sh
docker build -t rj-renderer ./workers/rj-renderer
docker run --rm \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  rj-renderer
```

The worker requires the branch-only Supabase migrations, including the durable stage lease function and private storage bucket. Do not run it against production until those migrations are reviewed and explicitly deployed.

## Render deployment

Create a Render Background Worker using this Dockerfile and the `workers/rj-renderer` directory as its Docker context. Choose a Singapore region when available for Sri Lanka latency. A continuously running Render worker requires a paid compute plan; do not approve or create the service until the user has reviewed its current price.

The worker handles SIGTERM/SIGINT by stopping new polls and finishing the current render before exit. No Render service has been created or deployed by this code change.