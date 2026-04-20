# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for State of Finance — macOS .app bundle
# Run from the project root:  pyinstaller mac/StateOfFinance-mac.spec

from pathlib import Path

project_root = Path(SPECPATH).resolve().parent   # mac/ is one level below root

datas = [
    (str(project_root / "templates"),           "templates"),
    (str(project_root / "static"),              "static"),
    (str(project_root / "schema.sql"),          "."),
    (str(project_root / "schema_postgres.sql"), "."),
]

a = Analysis(
    [str(project_root / "mac_launcher.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "werkzeug.serving",
        "cryptography.fernet",
        "cryptography.hazmat.primitives.ciphers.algorithms",
        "cryptography.hazmat.backends.openssl",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["psycopg", "gunicorn"],   # not needed in the local app
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StateOfFinance",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,    # set to "arm64" or "x86_64" to force a slice
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="StateOfFinance",
)

# Wrap the COLLECT folder inside a proper .app bundle
app = BUNDLE(
    coll,
    name="StateOfFinance.app",
    icon=None,               # replace with "mac/AppIcon.icns" if you add an icon
    bundle_identifier="com.shahidmukadam.state-of-finance",
    info_plist={
        "CFBundleDisplayName": "State of Finance",
        "CFBundleShortVersionString": "1.0.0",
        "NSHighResolutionCapable": True,
        "LSUIElement": False,           # show in Dock while running
        "NSRequiresAquaSystemAppearance": False,
    },
)
