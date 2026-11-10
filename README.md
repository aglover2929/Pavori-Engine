# Payvori Engine — Netlify deploy

This is the same setup as the Payvori Sales Portal: Netlify Identity for sign-in, a server function for data (Netlify Blobs), and `_redirects` for who can open what. Deploy this whole folder as the site root, through Git (GitHub) or the Netlify CLI. Drag-and-drop does not run server functions.

## Deploy from GitHub
1. Create a new **private** GitHub repository and upload the contents of this folder to its root (netlify.toml at the top level).
2. Netlify → Add new project → Import an existing project → GitHub → pick the repository.
3. Leave the build command empty. Publish directory: `.`  Functions directory: `functions` (both already set in netlify.toml).
4. Deploy.

## Or deploy with the Netlify CLI
    npm install -g netlify-cli
    netlify login
    netlify init        (create a new project for Engine)
    netlify deploy --prod

## After the first deploy
1. Identity → Enable Identity. Registration: **Invite only**. Leave email confirmation on.
2. Identity → Invite users → invite yourself. Accept the email and choose a password.
3. In Identity, open your user and set the role to `admin` (app_metadata.roles = ["admin"]). Identity admins are always Engine Admin.
4. Redeploy (Deploys → Trigger deploy) so the function picks up Identity.
5. Go to `https://<your-site>/import`, choose `payvori-engine-data-export.json` and click Import. This loads your organizations, processors and schedules, plus the user list (Marce and Andy, both Admin). Anyone in the list without an account gets an email invite.
6. Check Logs & metrics → Functions lists: db.

The export file holds partner contacts and buy rates. **Do not commit it to the repository.** Import it once, then delete it.

## Adding people
In Engine, go to Users → Add user and enter their name and email. They get an Identity invite email, and their Engine role (Admin, Finance, Operations, Sales, Read-only) decides what they see. Setting someone to Disabled or removing them takes their access away. Only Engine Admins can change Users.

## How access works
- `/login` is public. Every other page needs a signed-in account with the Identity role `admin` or `member`.
- The `db` function gives `member` to people added under Users, and takes it away when they are disabled or removed.
- Every read and write goes through the `db` function, which checks the person's Engine record. Read-only users can't save anything, and only Admins can change Users.
- Which sections someone sees is decided by their Engine role inside the page, as it was on claude.ai.

## What is in here
- index.html — Payvori Engine (the same app as on claude.ai)
- engine-runtime.js — connects the app to Netlify sign-in and the db function instead of claude.ai
- login.html, auth.js — sign-in, invites and password reset
- import.html — one-time data import (Identity admins only)
- functions/db.js — Engine's data store and access checks (Netlify Blobs store `payvori-engine`)
- _redirects — access rules for every path
- package.json — the library the db function uses (Netlify installs it on deploy)

## Notes
- Changes from other people show up within a few seconds (the page checks every 4 seconds while it's open).
- Engine on claude.ai keeps working separately. After you switch, make changes only on the Netlify site so the two don't drift apart.
