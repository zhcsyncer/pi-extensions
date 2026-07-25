#!/usr/bin/env bash
set -euo pipefail

echo "Publishing with npm trusted publishing (OIDC)."
unset NODE_AUTH_TOKEN

# Fail before changeset publish can partially release a plan that contains a
# package npm does not know yet. New package creation is intentionally isolated
# in the manually approved Bootstrap npm package workflow.
node scripts/check-unbootstrapped-packages.mjs

pnpm release
