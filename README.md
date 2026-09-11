# 渡 · Bridge Chat

A private chat website: GitHub Pages → HTTPS relay on your Mac → WebBridge → your signed-in ChatGPT browser → the website.

## What runs where

- **GitHub Pages** serves `public/`: a responsive chat UI, invitation login, conversation list, incremental answers and copyable code blocks.
- **Your Mac** runs the authenticated relay gateway, durable SQLite-backed queue, and Python connector. A Cloudflare Quick Tunnel exposes only the gateway. No Cloudflare account is required.
- **Chrome + Tampermonkey** runs `local/relay.user.js` only in tabs explicitly created for Bridge Chat. The script reads full answers from the visible web UI. No OpenAI API key or ChatGPT cookie is sent to visitors or GitHub.

This is a small private beta, not a production multi-tenant service. The Mac must stay on. The tunnel address changes on restart; `--publish` updates the GitHub Pages configuration. Chat history lives on this Mac; back up `local-state/` securely. Losing the browser login token loses access to that visitor's history. Logging in again creates a new visitor identity.

## Requirements

- macOS, Node.js 22.19+ (or newer supported Node release), Python 3.10+
- Google Chrome, logged into ChatGPT, with Tampermonkey enabled
- `cloudflared` on PATH (`brew install cloudflared`)
- GitHub CLI (`gh`) authenticated with permission to push this repository

## Run

```sh
npm ci
python3 scripts/setup.py
python3 scripts/launch.py --publish
```

The first start creates `local-state/ACCESS.md`, containing the invitation code and private userscript installation URL. Open that file **locally**, install the script once in Chrome, then open the dedicated standby tab linked there. The status badge should say “Bridge Chat · 已连接”. Visitors only need the website and invitation code.

Keep the launcher running. Press Ctrl+C to stop. The launcher supervises its three processes and shuts down the rest if one exits. It does not install a login agent or automatically run at startup.

To change the destination from regular ChatGPT to a particular GPT/Project, edit `target_url` in the ignored file `local-state/config.json`. Only `https://chatgpt.com/…` targets are accepted. Use a dedicated destination without unrelated private Project files or custom actions: all messages are processed under the owner's signed-in account and its available context.

Restart the launcher after changing `target_url`. This affects new website conversations only: follow-ups keep their existing mapped ChatGPT conversation, and no old chats are moved. For a Project target, new conversations are rejected unless their page is inside that Project. Conversations in the same Project may use its shared instructions and context; website visitor isolation does not isolate the upstream Project's memory.

## GitHub Pages setup

1. Push this repository to your own GitHub account.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. The included `pages.yml` publishes only `public/`.
4. Start `launch.py --publish`; it discovers the repository owner, permits that GitHub Pages origin, and publishes the current tunnel address in `public/config.js`.

The API address is public; the invitation code, connector credential and local bridge credential remain outside Git. Never upload `.dev.vars`, `local-state/`, generated installers or chat databases. Hosting a static page on GitHub does **not** run the Python service on GitHub.

## Data flow and failure behavior

1. A visitor authenticates using an invitation, receiving a signed 30-day token stored in the current browser.
2. New requests are persisted and associated with that visitor and conversation. The same client request ID cannot enqueue twice.
3. The connector claims one request at a time. A short lease is renewed while processing.
4. It opens a dedicated blank ChatGPT page for a new conversation, or returns to the previously mapped conversation. It verifies the latest user message and assistant count before continuing.
5. The userscript sends once. Complete and incremental answer text is uploaded only after the matching new user turn is observed.
6. An uncertain delivery or expired lease is marked failed. It is never automatically resubmitted. A local durable journal prevents replay after connector restarts.

Visitors cannot choose page IDs, browse snapshots, use connector routes, or read another visitor's conversation. Request/answer limits, per-visitor daily limits and a bounded global queue are enforced. Invitation login has a short-window attempt limit; this is a shared invite for trusted users, not verified per-person accounts.

The original local WebBridge at port 5010 is not modified or published. This isolated Relay transport binds port 5011 to loopback and requires a separate local credential. It follows WebBridge's poll/command/result model and adds dedicated-tab selection and full answer capture. No supervisor is enabled.

## Validation

```sh
npm run check
npm test
python3 -m compileall -q local scripts
```

Tests cover authenticated access, cross-user isolation, concurrent idempotency, exclusive claims, lease expiry, full response delivery, unknown-page rejection and restart replay protection. Browser UI and real ChatGPT checks must additionally be performed on the machine running Chrome. Never treat a mock answer as a live GPT verification.

Live verification on 2026-09-11: the public HTTPS relay sent a new prompt through the installed dedicated userscript and received `BRIDGE_OK`; a follow-up in the same conversation received `BRIDGE_OK_FOLLOWUP`. To repeat explicitly, run `python3 scripts/live_smoke.py` (creates a new private test conversation and sends two harmless messages; it is not part of automated unit tests).

## Optional cloud relay

The same Worker in `src/worker.ts` can be deployed to Cloudflare Workers + D1 later. `wrangler.jsonc` is a template: create a database, replace its placeholder ID, configure the three secrets and `ALLOWED_ORIGIN`, then apply migrations and deploy. Point `relay_url` at the remote Worker. This is optional and requires a Cloudflare account.

## Current limits

- Text only; plain text and fenced code rendering. No attachments, regeneration or remote stop yet.
- One GPT request at a time to keep account use and conversation mapping predictable.
- Background Chrome throttling, login challenges, ChatGPT limits and selector changes can interrupt replies. The website surfaces failure instead of silently retrying.
- A disconnected laptop means visitors cannot reach the API, even though GitHub still serves the UI.
- Temporary tunnel links and local credentials are for a trusted-user prototype. A stable domain and individual accounts are the next step for broader deployment.

## Attribution

The local browser transport is adapted from the MIT-licensed ChatGPT WebUI Bridge by OLmatter. See `THIRD_PARTY_NOTICES.md`.
