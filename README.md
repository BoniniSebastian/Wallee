# Wallee Approval

A mobile-first content approval PWA for previewing and approving social content.

## Current v1 flow

- Home
  - New post
  - Pending count
  - Approved total count
- New Post
  - Account name
  - Post / Reel
  - Post: up to 3 preview images + total number of images
  - Reel: 1 screenshot/cover
  - Caption
  - Optional internal note
- Pending
  - Compact queue of all pending items
- Approval view
  - Instagram-inspired content preview
  - Edit caption
  - Approve
  - Add comment
- Approved
  - Ready to post
  - Posted
  - Checkbox toggles "Posted live"
  - Approved timestamp and posted timestamp
- PWA
  - Standalone home-screen app
  - Locked viewport
  - Internal lists scroll, page shell does not
  - Service worker caches the app shell

## Firebase

The app works in local-only mode immediately.

To enable Firebase:

1. Create a Firebase project.
2. Enable Firestore Database.
3. Enable Firebase Storage.
4. Create a Web App in Firebase.
5. Copy the Firebase config to `firebase-config.js`.
6. Deploy the example rules in `firebase.rules.example` only for private development.

### Important security note

The example Firebase rules allow public read/write. Do not use those rules for a public production app.

For production, add Firebase Authentication and restrict Firestore/Storage to signed-in users.

## Selected Player logo

`Assets/selected-player-logo.svg` is only a placeholder because the official logo file was not supplied in this chat.

Replace it with the real logo using the same filename, or update the path in `index.html`.

The animation is CSS-based and will automatically apply to the replacement logo.

## GitHub Pages

Upload all files to the root of a GitHub repository.

Then:

Settings -> Pages -> Deploy from branch -> main / root

Open the Pages URL in Safari on iPhone/iPad and choose:

Share -> Add to Home Screen

## Files

- `index.html`
- `style.css`
- `app.js`
- `firebase-config.js`
- `manifest.webmanifest`
- `sw.js`
- `firebase.rules.example`
- `Assets/*`
