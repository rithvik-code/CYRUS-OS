#!/bin/bash
# Registered CYRUS script. The model can select this by name only —
# it cannot alter what it does. Keep this file boring and readable.
set -e

echo "[CYRUS] Setting up Python data science environment..."
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install pandas numpy matplotlib jupyterlab scikit-learn
mkdir -p data notebooks src tests
echo "[CYRUS] Done. Activate with: source .venv/bin/activate"
