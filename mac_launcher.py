"""
State of Finance — Mac Launcher
Starts a local Flask server and opens the app in the default browser.
Keep this window open while using the app.
"""

import os
import socket
import subprocess
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox

from werkzeug.serving import make_server

APP_NAME = "State of Finance"
HOST = "127.0.0.1"
PREFERRED_PORT = 5050


def _default_data_dir():
    # macOS convention: ~/Library/Application Support/<AppName>
    return Path.home() / "Library" / "Application Support" / APP_NAME


def _configure_runtime_environment():
    data_dir = Path(os.environ.get("SOF_DATA_DIR") or _default_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("SOF_DATA_DIR", str(data_dir))
    os.environ.setdefault("SOF_DB_PATH", str(data_dir / "finance.db"))
    os.environ.setdefault("SOF_SECRET_KEY_PATH", str(data_dir / "secret.key"))
    # Secure cookie not needed for localhost
    os.environ.setdefault("SESSION_COOKIE_SECURE", "0")
    return data_dir


DATA_DIR = _configure_runtime_environment()

from app import app, init_db, migrate_db  # noqa: E402


def _find_open_port(host=HOST, start=PREFERRED_PORT, attempts=25):
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    raise RuntimeError("Could not find an open local port for the app.")


def _wait_for_server(host, port, attempts=80, delay=0.25):
    for _ in range(attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            try:
                sock.connect((host, port))
            except OSError:
                threading.Event().wait(delay)
                continue
            return True
    return False


class _ServerThread(threading.Thread):
    def __init__(self, flask_app, host, port):
        super().__init__(daemon=True)
        self._server = make_server(host, port, flask_app, threaded=True)

    def run(self):
        self._server.serve_forever()

    def shutdown(self):
        self._server.shutdown()


class LauncherWindow:
    def __init__(self):
        init_db()
        migrate_db()

        self.host = HOST
        self.port = _find_open_port()
        self.url = f"http://{self.host}:{self.port}/"
        self.server = _ServerThread(app, self.host, self.port)
        self.server.start()

        if not _wait_for_server(self.host, self.port):
            raise RuntimeError("The local app server did not start. Try relaunching.")

        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("480x270")
        self.root.resizable(False, False)
        self.root.configure(bg="#0f172a")
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        # ── Layout ──────────────────────────────────────────────────────────
        frame = tk.Frame(self.root, bg="#0f172a", padx=26, pady=22)
        frame.pack(fill="both", expand=True)

        tk.Label(
            frame,
            text=APP_NAME,
            font=("Helvetica Neue", 20, "bold"),
            fg="#f8fafc",
            bg="#0f172a",
        ).pack(anchor="w")

        tk.Label(
            frame,
            text="Your personal finance tracker is running locally.",
            font=("Helvetica Neue", 11),
            fg="#cbd5e1",
            bg="#0f172a",
        ).pack(anchor="w", pady=(6, 16))

        # Info box
        info = tk.Frame(
            frame,
            bg="#111827",
            highlightbackground="#334155",
            highlightthickness=1,
            padx=14,
            pady=12,
        )
        info.pack(fill="x")

        tk.Label(
            info,
            text=f"App URL:  {self.url}",
            font=("Helvetica Neue", 10),
            fg="#e2e8f0",
            bg="#111827",
            anchor="w",
            justify="left",
        ).pack(fill="x")

        tk.Label(
            info,
            text=f"Data folder:  {DATA_DIR}",
            font=("Helvetica Neue", 9),
            fg="#94a3b8",
            bg="#111827",
            anchor="w",
            justify="left",
            wraplength=420,
        ).pack(fill="x", pady=(8, 0))

        tk.Label(
            frame,
            text="Keep this window open while using the app.\nClosing it shuts down the local server.",
            font=("Helvetica Neue", 9),
            fg="#94a3b8",
            bg="#0f172a",
            justify="left",
        ).pack(anchor="w", pady=(14, 16))

        # Buttons
        actions = tk.Frame(frame, bg="#0f172a")
        actions.pack(fill="x")

        tk.Button(
            actions,
            text="Open App",
            command=self.open_browser,
            bg="#4f46e5",
            fg="#ffffff",
            activebackground="#4338ca",
            activeforeground="#ffffff",
            relief="flat",
            padx=18,
            pady=9,
            cursor="pointinghand",
        ).pack(side="left")

        tk.Button(
            actions,
            text="Reveal Data Folder",
            command=self.reveal_data_folder,
            bg="#1e293b",
            fg="#cbd5e1",
            activebackground="#334155",
            activeforeground="#ffffff",
            relief="flat",
            padx=14,
            pady=9,
            cursor="pointinghand",
        ).pack(side="left", padx=(10, 0))

        tk.Button(
            actions,
            text="Quit",
            command=self.close,
            bg="#334155",
            fg="#f8fafc",
            activebackground="#1e293b",
            activeforeground="#ffffff",
            relief="flat",
            padx=14,
            pady=9,
            cursor="pointinghand",
        ).pack(side="right")

        # Auto-open browser after short delay
        self.root.after(600, self.open_browser)

    def open_browser(self):
        webbrowser.open(self.url, new=1)

    def reveal_data_folder(self):
        subprocess.run(["open", str(DATA_DIR)], check=False)

    def close(self):
        try:
            self.server.shutdown()
        finally:
            self.root.destroy()

    def run(self):
        self.root.mainloop()


def _show_error(message):
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(APP_NAME, message)
    root.destroy()


def main():
    try:
        launcher = LauncherWindow()
    except Exception as exc:
        _show_error(str(exc))
        raise SystemExit(1)
    launcher.run()


if __name__ == "__main__":
    main()
