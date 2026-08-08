#!/usr/bin/env bash
# Pubblica dist/ su transfer.wayfold.xyz (symlink atomico + smoke test).
# Sorgente: repo WayFold → apps/wayfold-relay (o checkout legacy /home/wayfold/apps/transfer).
set -euo pipefail

APP_DIR="/home/wayfold/apps/transfer"
WEB_ROOT="/var/www/transfer"
KEEP_RELEASES=5
APP_PATH="/home/wayfold/.nvm/versions/node/v22.22.3/bin:$PATH"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
  run_as_app() {
    sudo -u wayfold env "PATH=$APP_PATH" "$@"
  }
else
  SUDO=(sudo)
  export PATH="$APP_PATH"
  run_as_app() {
    "$@"
  }
fi

cd "$APP_DIR"
if [ -n "$(run_as_app git status --porcelain)" ]; then
  echo "Refusing deploy: Git working tree is dirty." >&2
  exit 1
fi

run_as_app git pull --ff-only
run_as_app npm ci
run_as_app npm run typecheck
run_as_app npm test
run_as_app npm run build

STAMP="$(date -u +%Y%m%d%H%M%S)"
release="$WEB_ROOT/releases/$STAMP"
previous="$(readlink -f "$WEB_ROOT/current" 2>/dev/null || true)"
tmp_link="$WEB_ROOT/.current-$STAMP"

"${SUDO[@]}" mkdir -p "$release"
"${SUDO[@]}" cp -a dist/. "$release/"
"${SUDO[@]}" chown -R root:www-data "$release"
"${SUDO[@]}" find "$release" -type d -exec chmod 755 {} \;
"${SUDO[@]}" find "$release" -type f -exec chmod 644 {} \;
"${SUDO[@]}" rm -f "$tmp_link"
"${SUDO[@]}" ln -s "$release" "$tmp_link"
"${SUDO[@]}" mv -Tf "$tmp_link" "$WEB_ROOT/current"

rollback() {
  echo "Smoke test failed; restoring previous release." >&2
  if [ -n "$previous" ]; then
    local rollback_link="$WEB_ROOT/.rollback-$STAMP"
    "${SUDO[@]}" rm -f "$rollback_link"
    "${SUDO[@]}" ln -s "$previous" "$rollback_link"
    "${SUDO[@]}" mv -Tf "$rollback_link" "$WEB_ROOT/current"
  else
    "${SUDO[@]}" rm -f "$WEB_ROOT/current"
  fi
  "${SUDO[@]}" nginx -t
  "${SUDO[@]}" systemctl reload nginx
}

"${SUDO[@]}" nginx -t
"${SUDO[@]}" systemctl reload nginx

smoke_urls=(
  "https://transfer.wayfold.xyz/"
  "https://transfer.wayfold.xyz/send/"
  "https://transfer.wayfold.xyz/receive/"
  "https://wayfold.xyz/"
)
for url in "${smoke_urls[@]}"; do
  if ! curl --fail --silent --show-error --retry 4 --retry-delay 2 --output /dev/null "$url"; then
    rollback
    exit 1
  fi
done

mapfile -t releases < <("${SUDO[@]}" ls -1dt "$WEB_ROOT"/releases/* 2>/dev/null || true)
for ((i = KEEP_RELEASES; i < ${#releases[@]}; i++)); do
  "${SUDO[@]}" rm -rf -- "${releases[$i]}"
done

echo "Deploy completed: https://transfer.wayfold.xyz"
