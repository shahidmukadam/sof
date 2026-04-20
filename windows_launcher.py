import os
import socket
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
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        base = Path.home()
    return base / APP_NAME


def _configure_runtime_environment():
    data_dir = Path(os.environ.get("SOF_DATA_DIR") or _default_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("SOF_DATA_DIR", str(data_dir))
    os.environ.setdefault("SOF_DB_PATH", str(data_dir / "finance.db"))
    os.environ.setdefault("SOF_SECRET_KEY_PATH", str(data_dir / "secret.key"))
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
    raise RuntimeError("Could not find an open local port for the packaged app.")


def _wait_for_server(host, port, attempts=60, delay=0.25):
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
            raise RuntimeError("The local app server did not start correctly.")

        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("460x250")
        self.root.resizable(False, False)
        self.root.configure(bg="#0f172a")
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        frame = tk.Frame(self.root, bg="#0f172a", padx=24, pady=22)
        frame.pack(fill="both", expand=True)

        title = tk.Label(
            frame,
            text=APP_NAME,
            font=("Segoe UI", 18, "bold"),
            fg="#f8fafc",
            bg="#0f172a",
        )
        title.pack(anchor="w")

        subtitle = tk.Label(
            frame,
            text="Your local finance tracker is running on this computer.",
            font=("Segoe UI", 10),
            fg="#cbd5e1",
            bg="#0f172a",
        )
        subtitle.pack(anchor="w", pady=(8, 18))

        info_box = tk.Frame(frame, bg="#111827", highlightbackground="#334155", highlightthickness=1, padx=14, pady=12)
        info_box.pack(fill="x")

        tk.Label(
            info_box,
            text=f"App URL: {self.url}",
            font=("Segoe UI", 10),
            fg="#e2e8f0",
            bg="#111827",
            anchor="w",
            justify="left",
        ).pack(fill="x")
        tk.Label(
            info_box,
            text=f"Local data folder: {DATA_DIR}",
            font=("Segoe UI", 9),
            fg="#94a3b8",
            bg="#111827",
            anchor="w",
            justify="left",
            wraplength=390,
        ).pack(fill="x", pady=(8, 0))

        note = tk.Label(
            frame,
            text="Keep this window open while you use the app. Closing it shuts down the local server.",
            font=("Segoe UI", 9),
            fg="#94a3b8",
            bg="#0f172a",
            justify="left",
            wraplength=400,
        )
        note.pack(anchor="w", pady=(16, 18))

        actions = tk.Frame(frame, bg="#0f172a")
        actions.pack(fill="x")

        open_button = tk.Button(
            actions,
            text="Open App",
            command=self.open_browser,
            bg="#4f46e5",
            fg="#ffffff",
            activebackground="#4338ca",
            activeforeground="#ffffff",
            relief="flat",
            padx=16,
            pady=9,
        )
        open_button.pack(side="left")

        exit_button = tk.Button(
            actions,
            text="Exit",
            command=self.close,
            bg="#334155",
            fg="#f8fafc",
            activebackground="#1e293b",
            activeforeground="#ffffff",
            relief="flat",
            padx=16,
            pady=9,
        )
        exit_button.pack(side="right")

        self.root.after(500, self.open_browser)

    def open_browser(self):
        webbrowser.open(self.url, new=1)

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
