# Firebase Setup

This app now uses Firebase Authentication plus Firestore security rules.

## 0. Environment variables

- Put the real Firebase config in `.env`.
- Keep `.env` local only. It is git-ignored.
- Use `.env.example` as the template for other environments.

## 1. Enable login

In Firebase Console:

1. Open `Authentication`.
2. Open `Sign-in method`.
3. Enable `Email/Password`.

## 2. Deploy Firestore rules

Use the rules from `firestore.rules`.

If you use Firebase CLI:

```powershell
firebase deploy --only firestore:rules
```

Or paste the same rules into the Firestore Rules editor in Firebase Console.

## 3. Create the first admin

For security, new users are always created with role `user`.

To create the first admin:

1. Register a normal account in the app.
2. Open Firestore Console.
3. Go to `users/{uid}` for that account.
4. Change `role` from `user` to `admin`.
5. Sign out and sign in again.

## 4. Security notes

- SQL injection is not the main risk here because the app uses Firestore, not SQL.
- The important protections are Firebase Auth, Firestore Rules, and output escaping in the UI.
- User text is now escaped before rendering so stored content cannot inject HTML or scripts into the page.
- Booking slots are only created after admin approval, which avoids rejected requests permanently blocking time.

## 5. Build for GitHub Pages

This project is configured so:

```powershell
npm run build
```

updates the `docs/` folder used by GitHub Pages.
