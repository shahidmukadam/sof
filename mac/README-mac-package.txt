State of Finance — Mac App
==========================

A private, local personal finance tracker.
Everything runs on your Mac. Nothing is sent anywhere.


HOW TO INSTALL
--------------
1. Unzip this file — you will see "StateOfFinance.app".
2. Drag StateOfFinance.app into your Applications folder
   (or leave it wherever you like).
3. Double-click StateOfFinance.app to launch.

The first launch may take 10–15 seconds while the app
initialises. Subsequent launches are faster.

If macOS shows a warning ("unidentified developer"):
  → Right-click the app → Open → click Open in the dialog.
  You only need to do this once.


HOW TO USE
----------
1. A small launcher window appears on screen.
2. Your default browser opens automatically with the app.
3. Create an account on the signup screen.
4. Keep the launcher window open while you use the app.
   Closing it stops the local server.

The app lives at:  http://127.0.0.1:5050/
(or a nearby port if 5050 is taken by another app)


WHERE YOUR DATA IS STORED
--------------------------
All your financial data is stored ONLY on your Mac at:

  ~/Library/Application Support/State of Finance/

Files:
  finance.db   — your database (SQLite)
  secret.key   — session encryption key (do not share)

This folder is NOT touched when you update or reinstall
the app. Your data is safe across upgrades.

To back up your data, simply copy that folder somewhere safe.


PRIVACY
-------
- No internet connection is required after first launch.
- The only outbound requests are:
    • Live stock prices from Yahoo Finance / DFM / ADX
    • Daily currency exchange rates from open.er-api.com
  Both are read-only lookups. No personal data is sent.
- Your account names, balances, and notes never leave
  your computer.


UPDATING
--------
This desktop build is a snapshot. New features are released
to the online version first (https://sof-czt8.onrender.com).

To get the latest features, download a new build when available
and replace your existing StateOfFinance.app. Your data folder
is separate and will not be affected.


TROUBLESHOOTING
---------------
App won't open?
  → Right-click → Open to bypass the macOS security warning.

Browser doesn't open?
  → Click "Open App" in the launcher window, or type
    http://127.0.0.1:5050/ in your browser.

App is slow on first load?
  → Normal. The app is initialising the database on first run.

Port already in use?
  → The app will automatically try nearby ports (5051, 5052…).

Need to move your data?
  → Set the SOF_DATA_DIR environment variable before launching
    to point to a custom folder.


UNINSTALLING
------------
1. Delete StateOfFinance.app from Applications.
2. To also remove your data:
   Delete ~/Library/Application Support/State of Finance/

That's it — no other files are created anywhere.


---
Built by Shahid Mukadam  |  https://sof-czt8.onrender.com
