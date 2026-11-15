// Your Google OAuth "Web application" client ID (from Google Cloud Console → Credentials).
// It is not a secret: it only identifies the app to Google, which checks the page's origin.
export const GOOGLE_CLIENT_ID = '679964558856-foaac5dcqeua5djiqv584odaufoe13h9.apps.googleusercontent.com';

// Only this Google account may use this page. This is Drive's opaque account ID (not an email address),
// so it doesn't reveal who you are. Leave empty to allow any account.
// It's a courtesy lock that stops other people using this page as their own journal. Your entries are
// protected regardless: by your Google sign-in plus your passphrase.
export const OWNER_ACCOUNT_ID = '14310924213276912841';
