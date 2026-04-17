# Firebase Setup

This app now uses a public booking flow plus admin-only Firebase Authentication.

## 0. Environment variables

- Put the real Firebase config in `.env`.
- Keep `.env` local only. It is git-ignored.
- Use `.env.example` as the template for other environments.

## 1. Enable admin login

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

Public visitors no longer register in the app. Create the admin manually:

1. Open `Authentication`.
2. Open `Users`.
3. Create a user with email and password for the admin.
4. Copy that user's `uid`.
5. Open Firestore Console.
6. Create the document `users/{uid}` with at least these fields:

```json
{
  "uid": "same uid from Authentication",
  "email": "admin@example.com",
  "name": "Admin Name",
  "role": "admin"
}
```

7. Sign in through the admin page in the app.

## 4. Security notes

- The public site can read halls and approved booking slots, and it can submit booking requests without login.
- Only admins can read submitted requests, approve or reject them, and create final booking slots.
- User text is escaped before rendering so stored content cannot inject HTML or scripts into the page.
- Booking slots are created only after admin approval, which avoids rejected requests permanently blocking time.

## 5. Build for GitHub Pages

This project is configured so:

```powershell
npm run build
```

updates the `docs/` folder used by GitHub Pages.
