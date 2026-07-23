#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${NPM_BOOTSTRAP_TOKEN:-}" ]]; then
  echo "Publishing with the one-time npm bootstrap token."
  export NODE_AUTH_TOKEN="$NPM_BOOTSTRAP_TOKEN"
  # npm prefers GitHub OIDC when these variables are present. A package cannot
  # configure a trusted publisher until after its first publish, so force token
  # auth only for the explicitly configured bootstrap run.
  unset ACTIONS_ID_TOKEN_REQUEST_TOKEN
  unset ACTIONS_ID_TOKEN_REQUEST_URL
else
  echo "Publishing with npm trusted publishing (OIDC)."
  unset NODE_AUTH_TOKEN
fi

pnpm release
