#!/bin/sh
# Rebuilds the recovery ISO of a release on a Linux amd64 Docker host of your own and
# compares it with the ISO the two CI builds agreed on (the third build before the
# release is signed, docs/BAREMETAL.md 21.4 item 20). It needs no signing key; it
# prints the SHA-256 that scripts/release/sign-agent.sh takes on the signing machine
# with --iso-sha256, so the ISO never has to be copied there.
#
#   scripts/release/rebuild-iso.sh <tag> [--repo <owner/name>] [--out <dir>]
#
#   <tag>               the release tag (v1.2.3); this clone must be checked out at it
#   --repo <owner/name> the repository of the release (default restow-backup/restow)
#   --out <dir>         where the agent build and the ISO go (default ./rebuild-<tag>)
#
# What it does:
#   1. finds the release workflow run of <tag> and checks that it built this commit;
#   2. downloads agent-SHA256SUMS from the DRAFT release and the run's agent build
#      (artifact agent-dist), and checks the linux-amd64 files against the list;
#   3. builds the ISO with integrations/recovery/build.sh from this clone;
#   4. compares its SHA-256 with the list's recovery/ line and prints the result.
# On a difference the ISO stays in <dir>/iso for a comparison (integrations/recovery/README.md).
#
# Needs: Linux on amd64, Docker with --privileged (run as root or as a member of the
# docker group), gh logged in with read access to the repository and its drafts, git,
# sha256sum. The agent build is an artifact of the run and expires after 7 days.
set -eu

DEFAULT_REPO=restow-backup/restow
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

tag=''
repo=$DEFAULT_REPO
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --repo)
      [ $# -ge 2 ] || die "--repo needs owner/name"
      repo="$2"
      shift
      ;;
    --out)
      [ $# -ge 2 ] || die "--out needs a directory"
      out="$2"
      shift
      ;;
    -*)
      printf 'error: unknown option %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [ -z "$tag" ] || die "unexpected argument $1 (the tag is $tag already)"
      tag="$1"
      shift
      continue
      ;;
  esac
  shift
done
[ -n "$tag" ] || {
  usage >&2
  exit 2
}
printf '%s' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' ||
  die "$tag is not a release tag (expected something like v1.2.3)"
printf '%s' "$repo" | grep -Eqx '[A-Za-z0-9._-]+/[A-Za-z0-9._-]+' ||
  die "the repository must look like owner/name, not '$repo'"
version=${tag#v}
[ "$(uname -s)" = Linux ] || die "the ISO builds on Linux only (live-build in a privileged container)"
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) die "the ISO builds on amd64 only, not on $(uname -m) (emulation does not rebuild it bit for bit)" ;;
esac
for tool in gh git docker sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is needed"
done

# This clone, at the tag: the build recipe that runs here is the one of the release.
commit=$(git -C "$ROOT" rev-parse "$tag^{commit}" 2>/dev/null) ||
  die "this clone has no tag $tag (git fetch --tags, or clone with --branch $tag)"
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$commit" ] ||
  die "this clone is not checked out at $tag (git checkout $tag)"

out=${out:-rebuild-$tag}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
rm -rf "$out/agent-dist" "$out/iso" "$out/agent-SHA256SUMS"

run=$(gh run list -R "$repo" --workflow release.yml --branch "$tag" --limit 1 \
  --json databaseId,headSha --jq '.[0] | "\(.databaseId) \(.headSha)"' 2>/dev/null) || run=''
[ -n "$run" ] && [ "$run" != "null null" ] || die "no run of release.yml for $tag in $repo"
run_id=${run%% *}
[ "${run#* }" = "$commit" ] || die "the release run $run_id of $tag built ${run#* }, not $commit"
echo "Release run:  $run_id ($tag, $(printf '%.7s' "$commit"))"

gh release download "$tag" -R "$repo" --dir "$out" --pattern agent-SHA256SUMS ||
  die "the draft $tag has no agent-SHA256SUMS yet; wait for the release run"
name="restow-recovery_${version}_amd64.iso"
want=$(sed -n "s#^\\([0-9a-f]\\{64\\}\\)  recovery/$name\$#\\1#p" "$out/agent-SHA256SUMS")
[ -n "$want" ] || die "agent-SHA256SUMS of $tag lists no recovery/$name"

gh run download "$run_id" -R "$repo" -n agent-dist -D "$out/agent-dist" ||
  die "cannot download the agent build of run $run_id (artifacts expire after 7 days)"
# The files the ISO takes must be the ones the list (and so the signature) names.
for file in restow-agent restic THIRD_PARTY_NOTICES.txt; do
  line=$(grep -E "^[0-9a-f]{64}  linux-amd64/$file\$" "$out/agent-SHA256SUMS") ||
    die "agent-SHA256SUMS lists no linux-amd64/$file"
  [ "$(sha256sum "$out/agent-dist/linux-amd64/$file" | cut -d ' ' -f 1)" = "${line%% *}" ] ||
    die "linux-amd64/$file of run $run_id differs from agent-SHA256SUMS on the draft"
done
chmod 0755 "$out/agent-dist/linux-amd64/restow-agent" "$out/agent-dist/linux-amd64/restic"

sh "$ROOT/integrations/recovery/build.sh" --agent-dist "$out/agent-dist/linux-amd64" \
  --version "$version" --out "$out/iso"
have=$(sha256sum "$out/iso/$name" | cut -d ' ' -f 1)

echo
echo "Recovery ISO: recovery/$name"
echo "  CI builds:  $want"
echo "  rebuilt:    $have"
if [ "$have" != "$want" ]; then
  echo
  echo "DIFFERENT: do not sign. The ISO built here is $out/iso/$name."
  exit 1
fi
echo
echo "EQUAL. Sign on the signing machine (with --key, unless RESTOW_AGENT_SIGNING_KEY is set):"
echo
echo "  sh scripts/release/sign-agent.sh $tag --iso-sha256 $have"
