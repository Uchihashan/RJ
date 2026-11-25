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

## Free Tamil narration and image generation

- Tamil narration is generated locally inside the renderer with Piper ONNX; it does not call a paid speech API. The primary voice is tinisoft's Rasa Female (CC BY 4.0) and the fallback is Jeyaram-K's HemaLatha (Apache-2.0). Rasa attribution: Praveen Srinivasa Varadhan, Ashwin Sankar, Giri Raju and Mitesh M. Khapra, “Rasa: Building Expressive Speech Synthesis Systems for Low-resource Settings,” Interspeech 2024; model: https://huggingface.co/tinisoft/piper-ta_IN-rasa_female-medium. HemaLatha model: https://huggingface.co/Jeyaram-K/piper-tamil-voices. Model attribution and licenses are preserved here.
- The Cloudflare FLUX.1 schnell image adapter is optional and is only for accounts on the **Workers Free** plan. The 10,000 Neurons/day allowance hard-stops at quota on that plan. Do not configure a Workers Paid account: usage above the allowance can be billed.
- If the Cloudflare image quota is exhausted, the renderer stops calling Cloudflare for that job and uses locally generated vector scene cards. No paid image fallback is ever used.
- The renderer includes the model weights in its Docker image; downloading/building this image is free of model licensing fees but the machine hosting the renderer may still have infrastructure charges. Do not deploy it to a paid host without explicit approval.
