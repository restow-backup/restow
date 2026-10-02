#!/bin/sh
# Signs the endpoint agent of a release, on the maintainer's own machine. The
# private key never leaves it and never enters the repository or CI
# (agent/README.md, "Release signing").
#
#   scripts/release/sign-agent.sh --keygen <path>        create the key pair (once)
#   scripts/release/sign-agent.sh <tag> --key <path> [--repo <owner/name>] [--yes]
#                                                        sign the agent of a release
#
#   --key <path>        the private key (default: $RESTOW_AGENT_SIGNING_KEY)
#   --repo <owner/name> the GitHub repository that holds the release (default:
#                       the repository of the clone this script lives in, as
#                       `gh repo view` reports it, else restow-backup/restow)
#   --yes               do not ask before signing
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
# It runs from any directory and needs no clone with the tag. The tag, its
# commit and agent/release-signing.pub at it are read from the clone this
# script lives in when that clone belongs to the repository and has the tag
# (a `git fetch --tags` is tried first); otherwise (a clone without the tag,
# a copy of the tree without a GitHub remote, no repository at all) they are
# read from GitHub with `gh api`. Nothing is cloned or changed locally.
#
# Needs: gh (logged in, push rights), ssh-keygen (OpenSSH 8.1 or newer; every
# supported macOS has it). git is used only to find the tag in a local clone.
set -eu

NAMESPACE=restow-agent-release
DEFAULT_REPO=restow-backup/restow
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)

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
  # The header comment above, without the shebang and the comment markers.
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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

# owner/name, nothing else: it ends up in API paths.
valid_repo() {
  case "$1" in
    '' | */*/* | /* | */ | *[!A-Za-z0-9._/-]*) return 1 ;;
    */*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints owner/name of the GitHub repository of the clone this script lives in.
# Fails when the script is not at the top of its own git work tree (a copy of
# the tree, a release tarball) or when gh finds no GitHub remote there.
clone_repo() {
  command -v git >/dev/null 2>&1 || return 1
  top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ "$top" = "$ROOT" ] || return 1
  # No stdin, so gh never asks which remote to use.
  (cd "$ROOT" && gh repo view --json nameWithOwner --jq .nameWithOwner </dev/null 2>/dev/null)
}

# gh api, with the failure text kept in $work/gh-error for the message.
gh_get() {
  gh api "$@" 2>"$work/gh-error"
}

gh_error() {
  head -n 1 "$work/gh-error"
}

# The tag from the local clone: sets $commit and writes $work/release-signing.pub.
# Fails (quietly) when the clone does not have the tag.
tag_from_clone() {
  git -C "$ROOT" fetch --quiet --tags origin 2>/dev/null || true
  commit=$(git -C "$ROOT" rev-parse --verify --quiet "$tag^{commit}") || return 1
  git -C "$ROOT" show "$tag:agent/release-signing.pub" >"$work/release-signing.pub" 2>/dev/null ||
    die "$tag has no agent/release-signing.pub"
}

# The tag from GitHub: sets $commit and writes $work/release-signing.pub. An
# annotated tag is a tag object that points at the commit (and could point at
# another tag object), so dereference until a commit is reached.
tag_from_github() {
  target=$(gh_get "repos/$repo/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha') ||
    die "the tag $tag is not known in $repo (not pushed yet, or no access to it): $(gh_error)"
  depth=0
  while [ "${target%% *}" = tag ]; do
    depth=$((depth + 1))
    [ "$depth" -le 5 ] || die "the tag $tag nests tag objects too deeply"
    target=$(gh_get "repos/$repo/git/tags/${target#* }" --jq '.object.type + " " + .object.sha') ||
      die "could not read the tag object of $tag in $repo: $(gh_error)"
  done
  [ "${target%% *}" = commit ] || die "the tag $tag points at a ${target%% *}, not at a commit"
  commit=${target#* }
  # Read at the commit the tag resolved to, not at the tag name, so a branch of
  # the same name or a tag moved in between cannot give another file.
  gh_get -H 'Accept: application/vnd.github.raw+json' "repos/$repo/contents/agent/release-signing.pub?ref=$commit" \
    >"$work/release-signing.pub" ||
    die "$tag has no agent/release-signing.pub in $repo: $(gh_error)"
}

sign() {
  tag="$1"
  key="$2"
  yes="$3"
  repo="$4"
  [ -n "$key" ] || die "give the private key: $0 $tag --key <path>"
  [ -f "$key" ] || die "the private key $key does not exist"
  case "$tag" in
    '' | *[!A-Za-z0-9._-]*) die "$tag is not a release tag (expected something like v1.2.3)" ;;
  esac
  for tool in gh ssh-keygen; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is needed"
  done

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  clone=$(clone_repo || true)
  if [ -z "$repo" ]; then
    repo=${clone:-$DEFAULT_REPO}
  fi
  valid_repo "$repo" || die "the repository must look like owner/name, not '$repo'"

  # A local clone is used only when it is a clone of this very repository and
  # has the tag; every other case asks GitHub.
  origin=github
  if [ -n "$clone" ] && [ "$(lower "$clone")" = "$(lower "$repo")" ] && tag_from_clone; then
    origin=clone
  fi
  if [ "$origin" = github ]; then
    tag_from_github
  fi
  grep -q '^ssh-ed25519 ' "$work/release-signing.pub" ||
    die "agent/release-signing.pub at $tag is still the placeholder; commit the public key first"

  draft=$(gh release view "$tag" -R "$repo" --json isDraft --jq .isDraft 2>/dev/null) ||
    die "there is no release $tag in $repo yet; wait until the agent job of the release workflow created the draft"
  [ "$draft" = true ] || die "the release $tag is already published; a published release is never signed again"

  gh release download "$tag" -R "$repo" --dir "$work" --pattern agent-SHA256SUMS ||
    die "the draft $tag has no agent-SHA256SUMS yet"
  sums="$work/agent-SHA256SUMS"

  if [ "$origin" = clone ]; then
    echo "Repository:     $repo (tag read from the local clone)"
  else
    echo "Repository:     $repo (tag read from GitHub)"
  fi
  echo "Release:        $tag ($(printf '%.7s' "$commit"))"
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
  gh release upload "$tag" -R "$repo" --clobber "$sums.sig" || die "uploading agent-SHA256SUMS.sig failed"
  echo "Uploaded agent-SHA256SUMS.sig to the draft release $tag."

  # Let the release workflow continue.
  run=$(gh run list -R "$repo" --workflow release.yml --branch "$tag" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
  if [ -z "$run" ] || [ "$run" = null ]; then
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
  conclusion=$(gh run view "$run" -R "$repo" --json conclusion --jq .conclusion 2>/dev/null || true)
  if [ "$conclusion" = failure ]; then
    gh run rerun "$run" -R "$repo" --failed && echo "Re-ran the failed jobs of run $run; the release continues." && return 0
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
  *)
    tag=''
    key="${RESTOW_AGENT_SIGNING_KEY:-}"
    repo=''
    yes=no
    while [ $# -gt 0 ]; do
      case "$1" in
        -h | --help)
          usage
          exit 0
          ;;
        --key)
          [ $# -ge 2 ] || die "--key needs a path"
          key="$2"
          shift
          ;;
        --repo)
          [ $# -ge 2 ] || die "--repo needs owner/name"
          repo="$2"
          shift
          ;;
        --yes) yes=yes ;;
        -*)
          printf 'error: unknown option %s\n\n' "$1" >&2
          usage >&2
          exit 2
          ;;
        *)
          [ -z "$tag" ] || die "unexpected argument $1 (the tag is $tag already)"
          tag="$1"
          ;;
      esac
      shift
    done
    if [ -z "$tag" ]; then
      usage >&2
      exit 2
    fi
    sign "$tag" "$key" "$yes" "$repo"
    ;;
esac
