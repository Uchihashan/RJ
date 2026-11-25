FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fontconfig ca-certificates python3 python3-venv curl espeak-ng libespeak-ng1 \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/piper-venv \
  && /opt/piper-venv/bin/pip install --no-cache-dir piper-tts \
  && mkdir -p /opt/piper-models \
  && curl -fsSL "https://huggingface.co/tinisoft/piper-ta_IN-rasa_female-medium/resolve/main/ta_IN-rasa_female-medium.onnx" -o /opt/piper-models/rasa.onnx \
  && curl -fsSL "https://huggingface.co/tinisoft/piper-ta_IN-rasa_female-medium/resolve/main/ta_IN-rasa_female-medium.onnx.json" -o /opt/piper-models/rasa.onnx.json \
  && curl -fsSL "https://huggingface.co/Jeyaram-K/piper-tamil-voices/resolve/main/ta_IN-HemaLatha-medium/ta_IN-HemaLatha-medium.onnx" -o /opt/piper-models/hemalatha.onnx \
  && curl -fsSL "https://huggingface.co/Jeyaram-K/piper-tamil-voices/resolve/main/ta_IN-HemaLatha-medium/ta_IN-HemaLatha-medium.onnx.json" -o /opt/piper-models/hemalatha.onnx.json \
  && printf 'வணக்கம், இது தமிழ் குரல் சோதனை.\\n' | /opt/piper-venv/bin/piper --model /opt/piper-models/rasa.onnx --config /opt/piper-models/rasa.onnx.json --output_file /tmp/rasa-test.wav \
  && printf 'வணக்கம், இது இரண்டாவது தமிழ் குரல் சோதனை.\\n' | /opt/piper-venv/bin/piper --model /opt/piper-models/hemalatha.onnx --config /opt/piper-models/hemalatha.onnx.json --output_file /tmp/hemalatha-test.wav \
  && test -s /tmp/rasa-test.wav && test -s /tmp/hemalatha-test.wav \
  && rm -f /tmp/rasa-test.wav /tmp/hemalatha-test.wav

COPY package.json ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

USER node
CMD ["node", "dist/index.js"]