#!/usr/bin/env bash
#
# Installs local git hooks that block broken code from being pushed.
#
# WHY THIS EXISTS: GitHub only enforces branch protection on PRIVATE repos for paid plans
# (Team, $4/user/month). For a solo developer that's poor value — the real benefit of branch
# protection isn't ceremony, it's "don't push code that doesn't build". A local pre-push hook
# gives you exactly that, immediately, for free.
#
# When you hire, upgrade to GitHub Team and add server-side protection too. Hooks are local, so
# a second developer can bypass them; that's the point at which server-side enforcement matters.
#
# Run once:  bash scripts/install-git-hooks.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "Not a git repository: $REPO_ROOT" >&2
  exit 1
fi

mkdir -p "$HOOK_DIR"

cat > "$HOOK_DIR/pre-push" <<'HOOK'
#!/usr/bin/env bash
#
# Blocks a push if the code doesn't typecheck, doesn't build, or fails the e2e suite.
# Bypass in a genuine emergency with:  git push --no-verify
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo ""
echo "  pre-push: verifying before this reaches GitHub…"
echo ""

fail() {
  echo ""
  echo "  ✗ PUSH BLOCKED: $1"
  echo "    Fix it, or bypass with:  git push --no-verify"
  echo ""
  exit 1
}

# 1. Nothing secret should ever be committed. Cheapest, highest-value check, so it runs first.
#
# Two-layer check, because filename alone is not enough in either direction:
#
#   Layer A - filenames that must never be committed (.env, .pem, id_rsa, ...).
#             EXCEPT the placeholder templates, which are deliberately tracked: .gitignore
#             carries `!.env.example` and `!deploy/.env.production.template` precisely so
#             they DO get committed. An earlier version of this pattern matched `.env`
#             followed by any dot, so `.env.example` tripped it — the file whose entire job
#             is to be committed was the one thing the hook refused to push.
#
#   Layer B - content scan of those allowed templates. Being allowlisted by name is exactly
#             how a real secret would sneak past Layer A: paste a live key into .env.example
#             and the filename check waves it through. So the templates are read, and any
#             value that looks like real key material rather than a placeholder is blocked.
SECRET_FILE_RE='(^|/)\.env($|\.)|\.pem$|\.p12$|(^|/)id_rsa$'
SECRET_ALLOW_RE='(^|/)\.env\.(example|sample|template)$|\.template$'

changed_files() {
  # Staged files plus every file touched by the commits being pushed.
  local range; range="$(git rev-parse --abbrev-ref HEAD)"
  { git diff --cached --name-only 2>/dev/null
    git log origin/"$range"..HEAD --name-only --pretty=format: 2>/dev/null
  } | sed '/^$/d' | sort -u
}

SUSPECT="$(changed_files | grep -E "$SECRET_FILE_RE" | grep -vE "$SECRET_ALLOW_RE" || true)"
if [ -n "$SUSPECT" ]; then
  echo "$SUSPECT" | sed 's/^/      /'
  fail "a secret-looking file is being committed (listed above)"
fi

# Layer B: real key material hiding inside an allowlisted template.
# A placeholder like `change-me-run-openssl-rand-base64-32` is broken up by dashes and never
# forms a long unbroken run; `openssl rand -base64 32` output is a 43-char unbroken run. That
# difference is the whole test. Comments are stripped so prose can't trip it.
TEMPLATES="$(changed_files | grep -E "$SECRET_ALLOW_RE" || true)"
for f in $TEMPLATES; do
  [ -f "$f" ] || continue
  if sed 's/#.*//' "$f" | grep -qE '=[A-Za-z0-9+/]{32,}={0,2}$|=[0-9a-fA-F]{40,}$'; then
    echo "      $f contains a value that looks like a real key, not a placeholder:"
    sed 's/#.*//' "$f" | grep -nE '=[A-Za-z0-9+/]{32,}={0,2}$|=[0-9a-fA-F]{40,}$' | sed 's/^/        /'
    fail "real-looking key material in a template file"
  fi
done

# 2. Typecheck both apps.
echo "  → typechecking API…"
npx tsc --noEmit -p apps/api/tsconfig.json || fail "API typecheck failed"
echo "  → typechecking web…"
npx tsc --noEmit -p apps/web/tsconfig.json || fail "web typecheck failed"

# 3. Build both. Catches things typecheck alone misses (bundler/config errors).
echo "  → building API…"
npm run build -w apps/api --silent >/dev/null 2>&1 || fail "API build failed"
echo "  → building web…"
npm run build -w apps/web --silent >/dev/null 2>&1 || fail "web build failed"

# 4. Full e2e suite against a real (embedded) Postgres.
#    Skip with SKIP_E2E=1 git push  — for a docs-only change where it's genuinely unnecessary.
if [ "${SKIP_E2E:-0}" != "1" ]; then
  echo "  → running e2e suite (this is the slow part; SKIP_E2E=1 to skip)…"
  # AES-256 needs a key that decodes to EXACTLY 32 bytes. Generate it rather than hard-coding a
  # base64 literal: the previous literal was 37 bytes, which made every crypto path throw
  # ENCRYPTION_MISCONFIGURED and blocked pushes for a reason that had nothing to do with the code.
  HOOK_CREDS_KEY="${CREDENTIALS_KEY:-$(openssl rand -base64 32)}"
  E2E_OUT="$(DB_MODE=embedded LOG_LEVEL=error \
    CREDENTIALS_KEY="$HOOK_CREDS_KEY" \
    npm run test:e2e --silent 2>&1)" || {
      echo "$E2E_OUT" | grep -E '^FAIL|FAILED CHECKS' | head -20
      fail "e2e tests failed"
    }
  echo "$E2E_OUT" | grep -E 'checks passed' || true
fi

echo ""
echo "  ✓ all checks passed — pushing"
echo ""
HOOK

chmod +x "$HOOK_DIR/pre-push"

echo ""
echo "  Installed: .git/hooks/pre-push"
echo ""
echo "  Every 'git push' will now run: secret scan → typecheck → build → 382 e2e tests."
echo "  A push is blocked if any of them fail."
echo ""
echo "  Escape hatches:"
echo "    SKIP_E2E=1 git push      # skip only the slow test suite"
echo "    git push --no-verify     # skip everything (emergencies only)"
echo ""
