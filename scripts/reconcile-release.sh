#!/usr/bin/env bash
set -euo pipefail

PACKAGES=(
  "@zhcsyncer/pi-extensions|package.json|CHANGELOG.md|pi-extensions|root"
  "@zhcsyncer/pi-recap|packages/pi-recap/package.json|packages/pi-recap/CHANGELOG.md|pi-recap|child"
  "@zhcsyncer/pi-tool-display-intent|packages/pi-tool-display-intent/package.json|packages/pi-tool-display-intent/CHANGELOG.md|pi-tool-display-intent|child"
  "@zhcsyncer/pi-todo|packages/pi-todo/package.json|packages/pi-todo/CHANGELOG.md|pi-todo|child"
)

wait_for_package() {
  local package=$1
  local version=$2

  for attempt in {1..36}; do
    local published_version
    published_version=$(npm view "$package@$version" version 2>/dev/null || true)
    if [[ "$published_version" == "$version" ]]; then
      return 0
    fi

    if [[ "${PUBLISHED_THIS_RUN:-false}" != "true" ]]; then
      echo "$package@$version is not published; skipping its release reconciliation."
      return 1
    fi

    if [[ "$attempt" == "36" ]]; then
      echo "$package@$version did not become visible on npm in time." >&2
      return 2
    fi

    echo "Waiting for $package@$version to become visible on npm (attempt $attempt/36)..."
    sleep 10
  done
}

ensure_remote_tag() {
  local tag=$1

  if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    return
  fi

  if ! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    git tag "$tag"
  fi
  git push origin "refs/tags/$tag"
}

extract_release_notes() {
  local changelog=$1
  local version=$2

  awk -v version="$version" '
    $0 == "## " version { found = 1; next }
    found && /^## / { exit }
    found { print }
  ' "$changelog"
}

for entry in "${PACKAGES[@]}"; do
  IFS="|" read -r package manifest changelog title kind <<<"$entry"
  version=$(node -p "require('./$manifest').version")

  wait_status=0
  wait_for_package "$package" "$version" || wait_status=$?
  if [[ "$wait_status" == "1" ]]; then
    continue
  fi
  if [[ "$wait_status" != "0" ]]; then
    exit "$wait_status"
  fi

  package_tag="$package@$version"
  ensure_remote_tag "$package_tag"

  if [[ "$kind" == "root" ]]; then
    release_tag="v$version"
    ensure_remote_tag "$release_tag"

    if ! gh release view "$release_tag" >/dev/null 2>&1; then
      gh release create "$release_tag" \
        --verify-tag \
        --generate-notes \
        --title "$title v$version"
    fi
    continue
  fi

  if ! gh release view "$package_tag" >/dev/null 2>&1; then
    notes=$(extract_release_notes "$changelog" "$version")
    if [[ -z "$notes" ]]; then
      notes="Release $package@$version"
    fi

    gh release create "$package_tag" \
      --verify-tag \
      --latest=false \
      --notes "$notes" \
      --title "$title v$version"
  fi
done
