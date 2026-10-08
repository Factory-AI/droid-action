#!/usr/bin/env bash
# Point git at the GH_TOKEN of whichever step runs it, so fetches and pushes
# authenticate as the Factory GitHub App. Steps without GH_TOKEN (the distill
# step) get an empty password and cannot reach GitHub.
set -euo pipefail

# actions/checkout stored the read-only Actions token as an Authorization
# header on this clone, which git would send instead of consulting a
# credential helper.
git config --local --unset-all "http.$GITHUB_SERVER_URL/.extraheader" || true
git config --local --replace-all credential.helper ''
git config --local --add credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
git config user.name >/dev/null || git config --local user.name 'factory-droid[bot]'
git config user.email >/dev/null || git config --local user.email '138933559+factory-droid[bot]@users.noreply.github.com'
