#!/bin/zsh
# מפעיל את "נקדן לקריינים" (מנוע מקומי עצמאי, ללא Dicta/אינטרנט) ופותח בדפדפן
cd "$(dirname "$0")"
PORT="${PORT:-8788}"
PY="./.venv/bin/python"
[ -x "$PY" ] || PY="python3"
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "כבר רץ על http://localhost:$PORT"
else
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PORT=$PORT nohup "$PY" server.py > /tmp/nikud-karyanim.log 2>&1 &
  echo "מפעיל… (טעינת המודל לוקחת כמה שניות בפעם הראשונה)"
  sleep 1
fi
open "http://localhost:$PORT"
