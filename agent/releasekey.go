// Package agent holds what the agent binary embeds from the root of the agent
// module: the public key that agent releases are signed with
// (release-signing.pub, see README.md "Release signing").
//
// The key is compiled in, so an installed agent decides on its own which
// binaries it accepts as updates; the Restow instance that serves them cannot
// change that.
package agent

import _ "embed"

// ReleaseSigningKey is the content of release-signing.pub: one OpenSSH
// ssh-ed25519 public key line, or the placeholder text while the maintainer has
// not created the key yet (package release tells the two apart).
//
//go:embed release-signing.pub
var ReleaseSigningKey string
