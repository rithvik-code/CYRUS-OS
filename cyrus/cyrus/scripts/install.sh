#!/bin/bash
set -e

echo "[CYRUS] Installing Python dependencies..."
pip install -r requirements.txt

if ! command -v ollama &> /dev/null; then
  echo "[CYRUS] Ollama not found. Install it from https://ollama.com before continuing."
  exit 1
fi

echo "[CYRUS] Pulling default local model (qwen2.5:3b)..."
ollama pull qwen2.5:3b

chmod +x scripts/*.sh

echo "[CYRUS] Setup complete. Run with: python -m cyrus.main"
