#!/usr/bin/env bash
# Put OAuth 2.0 Client ID + Secret on the Worker (interactive — values never echoed to git).
# NOT for Consumer Key / API Key / Bearer Token from "Keys and tokens".
set -euo pipefail
cd "$(dirname "$0")/.."

CALLBACK="https://xpro.howtomovetheneedle.com/api/auth/x/callback"

cat <<EOF
X OAuth 2.0 secrets for xpro-howtomovetheneedle
================================================
Portal checklist first (developer.x.com → app x-pro-setup):
  • User authentication: Web App, Automated App or Bot
  • Permissions: Read and write
  • Callback URI (exact):
      ${CALLBACK}
  • Website URL:
      https://xpro.howtomovetheneedle.com
  • After save: copy OAuth 2.0 Client ID + Client Secret
    (NOT Consumer Key / API Key / Bearer)

EOF

if [ -t 0 ]; then
  read -r -p "OAuth 2.0 Client ID: " X_CLIENT_ID
  read -r -s -p "OAuth 2.0 Client Secret: " X_CLIENT_SECRET
  echo
else
  echo "Run this in an interactive terminal (needs your Client ID/Secret)." >&2
  exit 1
fi

if [ -z "${X_CLIENT_ID}" ] || [ -z "${X_CLIENT_SECRET}" ]; then
  echo "Both Client ID and Client Secret are required." >&2
  exit 1
fi

# Reject common mistakes: Bearer tokens and very short junk
if [[ "${X_CLIENT_ID}" == AAAA* ]] || [[ "${X_CLIENT_SECRET}" == AAAA* ]]; then
  echo "That looks like a Bearer token, not OAuth 2.0 Client credentials." >&2
  exit 1
fi

printf '%s' "${X_CLIENT_ID}" | npx wrangler secret put X_CLIENT_ID
printf '%s' "${X_CLIENT_SECRET}" | npx wrangler secret put X_CLIENT_SECRET

echo
echo "Done. Verify:"
echo "  npx wrangler secret list"
echo "  open https://xpro.howtomovetheneedle.com/app.html"
echo "  → Connect with X (should redirect to x.com authorize, then back to ${CALLBACK})"
