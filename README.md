# ViralTrend AI — starter

Responsive web dashboard for TikTok account authorization, viewing the authorized account's own video metrics, drafting captions, maintaining a 30-day calendar, and preparing consent-based posts.

## Important limitations

- TikTok's official APIs do not provide a universal public feed of every viral video or arbitrary comments for this app. The dashboard ranks videos returned for the connected account using available view/like/comment/share counts. This is a performance signal, not a prediction guarantee.
- This starter does not scrape TikTok pages or copy other creators' videos. The caption helper creates an original draft from a topic you provide.
- Direct publishing requires TikTok approval for the Content Posting API and the `video.publish` scope. TikTok may restrict unaudited clients to private posts. The app asks the user to confirm each publish action; it does not silently publish a scheduled post.
- The Direct Post implementation below uses `PULL_FROM_URL`. You must host your own original video on an HTTPS URL from a domain/prefix verified in TikTok Developers. Never use URLs for videos you do not own or have permission to publish.
- TikTok's posting UX, required consent, creator information and privacy options can change. Verify the current official docs before production launch.

## Requirements

- Node.js 20+
- A TikTok for Developers app with Login Kit and Content Posting API configured.
- A public HTTPS website and registered redirect URI for production.
- A verified video URL domain for PULL_FROM_URL.
- TikTok-approved scopes as needed: `user.info.basic`, `user.info.stats`, `video.list`, and `video.publish`.

Official docs:
- https://developers.tiktok.com/docs/en/getting-started-create-an-app
- https://developers.tiktok.com/docs/en/scopes-overview
- https://developers.tiktok.com/docs/en/oauth-user-access-token-management
- https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post

## Setup

1. Copy `.env.example` to `.env`.
2. Generate secrets, for example:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   Use a separate long random string for `SESSION_SECRET`.
3. Add your TikTok client key/secret and exact redirect URI to `.env` and your TikTok app settings.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.
6. For production, use HTTPS, set `BASE_URL` and `TIKTOK_REDIRECT_URI` to your real domain, and keep `.env` out of source control.

## Security notes

This demo uses encrypted token storage in a local JSON file, HTTP-only cookies, OAuth `state`, Helmet, rate limiting and a server-side session cookie signature. For a public production service, replace the demo session implementation with a vetted session store, add CSRF protection to all state-changing routes, account separation, audit logs, backup policy, database encryption/rotation, and a privacy policy/terms page. Do not deploy this starter with a shared public login; it is intended for a single account owner.

## What works

- TikTok OAuth authorization-code flow and refresh-token handling.
- Own profile info and own public video list, where scopes/API access allow it.
- Local trend scoring based on engagement and view count among the videos returned by TikTok.
- 30-day calendar and saved drafts.
- Comment-analysis input for comments you are allowed to use (pasted manually); no scraping of inaccessible comments.
- Publish action for an original video hosted on a verified URL, after explicit user confirmation and only if TikTok returns the required creator privacy options.

## What is intentionally not automated

- No automatic likes, follows, comments, mass actions, scraping, or copying/reposting of other creators' videos.
- The calendar is a planning queue. It does not silently publish at a future time because TikTok posting permissions and explicit-consent requirements must be respected.
