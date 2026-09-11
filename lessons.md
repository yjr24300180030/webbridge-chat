# Anti-regression notes

- Never expose the original local bridge, browser cookies, installers containing local credentials, or unrelated browser snapshots.
- Persist send intent before dispatch. Expired or uncertain delivery must not automatically resend a prompt.
- Match the dedicated conversation and previous turn before appending. Never fall back to a personal tab.
- Block navigation/logout while a send request is pending; reset request identifiers on conversation changes.
- GitHub Pages must be enabled before its first successful workflow deployment.
- A successful mock roundtrip is not evidence of live ChatGPT delivery.
- Do not claim owner-invisible privacy: visitors' messages are processed on the owner's computer and ChatGPT account.
- ChatGPT's temporary /c/WEB:<uuid> URL is not a durable conversation identity; bind only the final UUID URL.
- Bust the browser cache for temporary tunnel configuration after local restarts.
