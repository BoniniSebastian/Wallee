// Replace the placeholder values below with your Firebase web app config.
// Firebase Console -> Project settings -> Your apps -> Web app.
//
// The app automatically falls back to local-only mode until these values are filled in.

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export function firebaseConfigured() {
  return !Object.values(firebaseConfig).some(
    value => !value || String(value).includes("YOUR_")
  );
}
