# Wallee v3 – No visible login

There is no login screen.

The app automatically creates an anonymous Firebase session in the background.
The user simply opens Wallee and lands on Home.

## One Firebase setting is required

Firebase Console:
Build -> Authentication -> Sign-in method -> Anonymous -> Enable

This does NOT create a visible login flow.

## Firestore

Copy the contents of `firestore.rules` to:

Firestore Database -> Rules -> Publish

## Replace in GitHub

Replace only:

- index.html
- app.js
- firestore.rules
- sw.js

Everything else can remain as it is.

After GitHub Pages deploys, Safari/PWA may still have the old service worker for one launch.
Close Wallee completely and reopen it, or refresh twice.
