State of Finance for Windows
============================

This package is self-contained. End users do not need to install Python or any other dependency.

How to use it
-------------
1. Unzip the package to any folder you can access.
2. Open the "StateOfFinance-windows" folder.
3. Double-click "StateOfFinance.exe".
4. The launcher window will appear and the app will open in your default browser.

Important notes
---------------
- Keep the launcher window open while you use the app.
- Closing the launcher window stops the local app server.
- Your local database and session secret are stored outside the install folder.

Default local data location
---------------------------
%LOCALAPPDATA%\State of Finance

Files created there
-------------------
- finance.db
- secret.key

This means:
- the packaged app can live in Program Files, Downloads, or on the Desktop
- user data is not bundled into the package
- updating the app package does not overwrite the user's local database
