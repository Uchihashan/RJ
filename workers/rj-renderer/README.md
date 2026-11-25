# RJ Kids Video Renderer Worker

This isolated Docker worker turns an approved RJ story into a complete MP4 preview and preserves the scene source assets for later per-scene editing.

## Current automatic pipeline

- Reads the saved story and splits it into up to 12 scenes.
- Generates child-safe storybook images with Cloudflare FLUX.1 schnell when the user has connected a Cloudflare Workers **Free** account and its free quota is available.
- If image generation is unavailable or the free quota is exhausted, creates local vector scene artwork. It never switches to a paid image provider.
- Keeps a clean source image for every scene in the private `rj-renders` bucket at `<user>/<job>/scenes/scene-NN.jpg`.
- Builds a versioned timeline manifest in `jobs.output.render.timeline`, including scene number, title, narration text, image path, duration, image source, and motion preset. This is the foundation for scene-by-scene re-editing.
- Adds a slow FFmpeg Ken Burns zoom to each still-image sequence, then assembles the result as H.264 MP4.
- Generates Tamil narration locally with Piper when the Tamil voice models are available.
- Creates an SRT captions sidecar and a thumbnail.
- Saves the final MP4 and all editable source assets in private Supabase Storage.

## Important capability boundary

The Ken Burns effect animates still images with camera movement; it is **not** generative image-to-video AI. No free generative video provider is currently connected in RJ. The provider registry keeps paid video generation disabled. The finished MP4 can be previewed, and the saved scene images plus timeline manifest make later per-scene replacement/re-render possible. A full interactive timeline UI and YouTube OAuth upload flow are separate integration tasks and are not claimed as complete by this worker.

The worker deliberately does not publish to YouTube. Upload remains blocked until a YouTube channel is securely connected and the user confirms publishing.

## Required environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only key; never put this in the Android app
- Optional `RJ_RENDER_BUCKET` (defaults to `rj-renders`)
- Optional `RJ_RENDER_POLL_MS` (defaults to `15000`)
- Optional `RJ_RENDER_BATCH_SIZE` (defaults to `2`)

## Build and run

Build from the repository root with Docker context `workers/rj-renderer`:

```sh
docker build -t rj-renderer ./workers/rj-renderer
docker run --rm \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  rj-renderer
```

## Render deployment

Create a Render Background Worker using this Dockerfile and the `workers/rj-renderer` directory as its Docker context. A continuously running Render worker requires a paid compute plan. Do not create or deploy that service until the user has reviewed and approved its current price.

## Free/local media components

- Tamil narration uses Piper ONNX locally: Rasa Female (CC BY 4.0) with HemaLatha (Apache-2.0) fallback. Model attribution and licenses are preserved here: https://huggingface.co/tinisoft/piper-ta_IN-rasa_female-medium and https://huggingface.co/Jeyaram-K/piper-tamil-voices.
- Cloudflare FLUX.1 schnell is optional and must only be used with a Cloudflare Workers Free account. Its daily allowance hard-stops at quota; RJ records quota failures and uses local vector fallback.
- FFmpeg, FFprobe, and Sharp are open-source/local media tools. The compute host and private storage may still incur infrastructure charges.
