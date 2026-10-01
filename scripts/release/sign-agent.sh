#!/bin/sh
# Signs the endpoint agent of a release, on the maintainer's own machine. The
# private key never leaves it and never enters the repository or CI
# (agent/README.md, "Release signing").
#
#   scripts/release/sign-agent.sh --keygen <path>        create the key pair (once)
#   scripts/release/sign-agent.sh <tag> --key <path>     sign the agent of a release
#
# Signing a release:
#   1. the release workflow of <tag> built the agent and put its checksum list
#      (agent-SHA256SUMS) on the DRAFT release <tag>, then waits;
#   2. this script downloads agent-SHA256SUMS with `gh`, shows what it signs,
#      signs it with ssh-keygen (namespace restow-agent-release), verifies the
#      signature against agent/release-signing.pub as committed at <tag>,
#      uploads agent-SHA256SUMS.sig to the draft
#   3. and lets the workflow continue (approves the waiting job of the
#      environment agent-release-signing, or re-runs the failed signature job).
#      The workflow then builds the images with the signed agent, runs the
#      release smoke, checks the signature once more and publishes the draft.
#
# Needs: git, gh (logged in, push rights), ssh-keygen (OpenSSH 8.1 or newer;
# every supported macOS has it).
set -eu

NAMESPACE=restow-agent-release
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

keygen() {
  path="$1"
  [ -n "$path" ] || die "--keygen needs the path of the new private key"
  [ ! -e "$path" ] || die "$path exists already; never overwrite a release key"
  command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is needed"
  echo "Creating the Ed25519 release signing key $path."
  echo "Choose a long passphrase and store it in your password manager."
  ssh-keygen -t ed25519 -a 100 -C "$NAMESPACE" -f "$path"
  chmod 0600 "$path"
  echo
  echo "Public key (commit this as agent/release-signing.pub, replacing the placeholder):"
  echo
  cat "$path.pub"
  echo
  echo "Fingerprint: $(ssh-keygen -l -f "$path.pub" | cut -d ' ' -f 2)"
  echo
  echo "Next: copy $path.pub to agent/release-signing.pub, commit it, and back up $path"
  echo "and its passphrase offline (see agent/README.md, \"Release signing\")."
}

sign() {
  tag="$1"
  key="$2"
  yes="$3"
  [ -n "$key" ] || die "give the private key: $0 $tag --key <path>"
  [ -f "$key" ] || die "the private key $key does not exist"
  for tool in git gh ssh-keygen; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is needed"
  done
  cd "$ROOT"

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  git fetch --quiet --tags origin 2>/dev/null || true
  git rev-parse --verify --quiet "$tag^{commit}" >/dev/null || die "the tag $tag is not known here (git fetch --tags)"
  git show "$tag:agent/release-signing.pub" >"$work/release-signing.pub" 2>/dev/null ||
    die "$tag has no agent/release-signing.pub"
  grep -q '^ssh-ed25519 ' "$work/release-signing.pub" ||
    die "agent/release-signing.pub at $tag is still the placeholder; commit the public key first"

  draft=$(gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null) ||
    die "there is no release $tag yet; wait until the agent job of the release workflow created the draft"
  [ "$draft" = true ] || die "the release $tag is already published; a published release is never signed again"

  gh release download "$tag" --dir "$work" --pattern agent-SHA256SUMS ||
    die "the draft $tag has no agent-SHA256SUMS yet"
  sums="$work/agent-SHA256SUMS"

  echo "Release:        $tag ($(git rev-parse --short "$tag^{commit}"))"
  echo "Release key:    $(ssh-keygen -l -f "$work/release-signing.pub" | cut -d ' ' -f 2)"
  echo "agent-SHA256SUMS ($(wc -l <"$sums" | tr -d ' ') files, SHA-256 $(sha256_of "$sums")):"
  sed 's/^/    /' "$sums"
  echo
  if [ "$yes" != yes ]; then
    printf 'Sign this agent release with %s? [y/N] ' "$key"
    read -r answer </dev/tty || answer=''
    case "$answer" in
      y | Y | yes) ;;
      *) die "not signed" ;;
    esac
  fi

  ssh-keygen -q -Y sign -f "$key" -n "$NAMESPACE" "$sums" || die "signing failed"
  sh "$ROOT/scripts/release/verify-agent-signature.sh" "$sums" "$sums.sig" "$work/release-signing.pub" ||
    die "the new signature does not verify against agent/release-signing.pub at $tag (wrong key?); nothing was uploaded"
  gh release upload "$tag" --clobber "$sums.sig" || die "uploading agent-SHA256SUMS.sig failed"
  echo "Uploaded agent-SHA256SUMS.sig to the draft release $tag."

  # Let the release workflow continue.
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  run=$(gh run list --workflow release.yml --branch "$tag" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
  if [ -z "$run" ]; then
    echo "No run of the release workflow for $tag was found; continue it by hand in GitHub Actions."
    return 0
  fi
  pending=$(gh api "repos/$repo/actions/runs/$run/pending_deployments" --jq '[.[] | select(.environment.name == "agent-release-signing") | .environment.id] | join(",")' 2>/dev/null || true)
  if [ -n "$pending" ]; then
    printf '{"environment_ids":[%s],"state":"approved","comment":"agent signed with scripts/release/sign-agent.sh"}' "$pending" |
      gh api --method POST "repos/$repo/actions/runs/$run/pending_deployments" --input - >/dev/null &&
      echo "Approved the waiting signature job of run $run; the release continues." && return 0
    echo "Could not approve the waiting job; approve it in GitHub Actions (run $run)."
    return 0
  fi
  conclusion=$(gh run view "$run" --json conclusion --jq .conclusion 2>/dev/null || true)
  if [ "$conclusion" = failure ]; then
    gh run rerun "$run" --failed && echo "Re-ran the failed jobs of run $run; the release continues." && return 0
  fi
  echo "The release workflow (run $run) picks the signature up in its signature job."
}

case "${1:-}" in
  '' | -h | --help)
    usage
    exit 0
    ;;
  --keygen)
    keygen "${2:-}"
    ;;
  -*)
    usage >&2
    exit 2
    ;;
  *)
    tag="$1"
    shift
    key="${RESTOW_AGENT_SIGNING_KEY:-}"
    yes=no
    while [ $# -gt 0 ]; do
      case "$1" in
        --key)
          [ $# -ge 2 ] || die "--key needs a path"
          key="$2"
          shift
          ;;
        --yes) yes=yes ;;
        *) die "unknown option $1" ;;
      esac
      shift
    done
    sign "$tag" "$key" "$yes"
    ;;
esac
