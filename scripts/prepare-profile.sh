#!/bin/bash
set -euo pipefail

PROFILE=${1:-default}
PROFILE_FILE="profiles/${PROFILE}.json"
RESOURCES_DIR="src-tauri/resources"

if [ ! -f "$PROFILE_FILE" ]; then
  echo "Error: Profile '${PROFILE}' not found at ${PROFILE_FILE}"
  exit 1
fi

echo "Preparing profile: ${PROFILE}"

# Clean staging directories
rm -rf "$RESOURCES_DIR/bundled-skills" "$RESOURCES_DIR/bundled-apps"
rm -f "$RESOURCES_DIR/profile.json"

# Copy profile manifest
cp "$PROFILE_FILE" "$RESOURCES_DIR/profile.json"

# Stage profile-specific skills
mkdir -p "$RESOURCES_DIR/bundled-skills"
for skill in $(jq -r '.skills[]' "$PROFILE_FILE" 2>/dev/null); do
  if [ -d "profiles/skills/$skill" ]; then
    cp -r "profiles/skills/$skill" "$RESOURCES_DIR/bundled-skills/"
    echo "  Bundled skill: $skill"
  else
    echo "  Warning: skill '$skill' not found in profiles/skills/"
  fi
done

# Stage profile-specific apps
mkdir -p "$RESOURCES_DIR/bundled-apps"
for app in $(jq -r '.apps[]' "$PROFILE_FILE" 2>/dev/null); do
  if [ -d "profiles/apps/$app" ]; then
    cp -r "profiles/apps/$app" "$RESOURCES_DIR/bundled-apps/"
    echo "  Bundled app: $app"
  else
    echo "  Warning: app '$app' not found in profiles/apps/"
  fi
done

echo "Profile '${PROFILE}' staged to ${RESOURCES_DIR}"
