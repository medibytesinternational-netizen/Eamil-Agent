# Deploying on Railway

Your data stays in SQLite files on **your own Railway Volume**. It never goes into a third-party database.

## 1. Volume (required)
Add a Volume to the service, mounted at `/data`. Without it, every deploy erases all data.

## 2. Google OAuth (Web client)
In Google Cloud Console → APIs & Services → Credentials, create an OAuth client of type **Web application**.
- Authorized redirect URI: `https://<your-app>.up.railway.app/api/oauth/callback`
- Keep the Gmail scopes and test users you already use.

## 3. Variables
| Variable | Value |
|---|---|
| `DATA_DIR` | `/data` |
| `APP_PASSWORD` | a long password. The app refuses to start without one, because it can read your email |
| `FERNET_KEY` | the same key as your local `.env`, or a new one (a new key means reconnecting Gmail) |
| `OPENAI_API_KEY` | your key |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from the Web client |
| `PUBLIC_URL` | `https://<your-app>.up.railway.app` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | for push notifications (subject e.g. `mailto:you@example.com`) |
| `THESYS_API_KEY` | optional (OpenUI Gateway) |

Railway sets `RAILWAY_ENVIRONMENT` automatically, which turns the login on.

## 4. Deploy
Push to GitHub and connect the repo in Railway. It builds the `Dockerfile`, which builds the frontend and serves everything from one URL.
Open the URL, log in with `APP_PASSWORD`, and go through setup. **Connect Gmail** redirects to Google and back.
