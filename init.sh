#!/usr/bin/env bash
set -euo pipefail

echo "=== Agent Team Studio Harness Init ==="
echo ""

MISSING=false
for file in AGENTS.md CLAUDE.md AGENTS.team.md agents.json feature_list.json progress.md session-handoff.md quality-document.md evaluator-rubric.md clean-state-checklist.md init.sh docs/PROCESS.md; do
  if [ ! -f "$file" ]; then
    echo "  MISSING: $file"
    MISSING=true
  else
    echo "  OK: $file"
  fi
done

if [ "$MISSING" = "true" ]; then
  echo ""
  echo "Some harness files are missing. Fix them before continuing."
  exit 1
fi
echo ""

if [ -f package.json ]; then
  PM="npm"
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    PM="pnpm"
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    PM="yarn"
  elif { [ -f bun.lock ] || [ -f bun.lockb ]; } && command -v bun >/dev/null 2>&1; then
    PM="bun"
  fi

  echo "=== Installing dependencies with $PM ==="
  if ! command -v "$PM" >/dev/null 2>&1; then
    echo "  MISSING: $PM is not installed."
    exit 1
  fi
  "$PM" install
  echo ""

  if command -v node >/dev/null 2>&1; then
    echo "=== Running available verification scripts ==="
    if node -e "const s=require('./package.json').scripts||{};process.exit(s.check?0:1)" >/dev/null 2>&1; then
      "$PM" run check
    fi
    if node -e "const s=require('./package.json').scripts||{};process.exit(s.test?0:1)" >/dev/null 2>&1; then
      "$PM" test
    fi
    if node -e "const s=require('./package.json').scripts||{};process.exit(s.build?0:1)" >/dev/null 2>&1; then
      "$PM" run build
    fi
  else
    echo "  WARN: node is not installed; skipping package script verification."
  fi
else
  echo "No package.json detected."
  echo "Replace this section with the project's verification commands."
fi

echo ""
echo "=== Harness initialization complete. ==="
