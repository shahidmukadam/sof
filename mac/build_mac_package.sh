#!/usr/bin/env bash
# ============================================================
#  State of Finance — Mac Package Builder
#  Run from the project root:
#
#     chmod +x mac/build_mac_package.sh
#     ./mac/build_mac_package.sh
#
#  What it does:
#    1. Creates and activates a clean virtual environment
#    2. Installs all dependencies (excluding server-only libs)
#    3. Runs PyInstaller to produce StateOfFinance.app
#    4. Zips the .app + end-user README into a distributable archive
#
#  Output:
#    dist/StateOfFinance-mac.zip
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
VENV_DIR="$PROJECT_ROOT/.venv-build"
ZIP_NAME="StateOfFinance-mac.zip"

echo ""
echo "=================================================="
echo "  State of Finance — Mac Package Builder"
echo "=================================================="
echo ""

# ── 1. Python check ─────────────────────────────────────────────────────────
PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
    echo "ERROR: python3 not found. Install it from https://www.python.org/downloads/"
    exit 1
fi

PY_VER=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "Using Python $PY_VER at $PYTHON"

# ── 2. Virtual environment ───────────────────────────────────────────────────
echo ""
echo "→ Creating build virtual environment..."
"$PYTHON" -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install --upgrade pip --quiet

# ── 3. Install dependencies ──────────────────────────────────────────────────
echo "→ Installing dependencies..."
pip install flask werkzeug cryptography pyinstaller --quiet
# psycopg and gunicorn are NOT needed in the desktop build

# ── 4. Build .app ────────────────────────────────────────────────────────────
echo "→ Running PyInstaller..."
cd "$PROJECT_ROOT"
pyinstaller --clean --noconfirm mac/StateOfFinance-mac.spec

APP_PATH="$DIST_DIR/StateOfFinance.app"
if [ ! -d "$APP_PATH" ]; then
    echo ""
    echo "ERROR: Build failed — StateOfFinance.app not found in dist/"
    exit 1
fi
echo "✓ Build complete: $APP_PATH"

# ── 5. Package into a distributable zip ─────────────────────────────────────
echo "→ Creating distributable zip..."
cd "$DIST_DIR"
cp "$SCRIPT_DIR/README-mac-package.txt" .
zip -r "$ZIP_NAME" StateOfFinance.app README-mac-package.txt --quiet
rm -f README-mac-package.txt
echo "✓ Package ready: $DIST_DIR/$ZIP_NAME"

# ── 6. Cleanup build artefacts ──────────────────────────────────────────────
deactivate
echo ""
echo "=================================================="
echo "  Done! Share dist/$ZIP_NAME with users."
echo "=================================================="
echo ""
