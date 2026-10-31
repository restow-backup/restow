// Command sigdiff writes Ed25519 test vectors for the differential test of the
// Windows installer's own signature check (agent/install/windows.ps1,
// docs/WINDOWS-AGENT.md, section 14.3). Every line is
//
//	<public key hex> <message hex> <signature hex> <1|0>
//
// where the last field is the verdict of crypto/ed25519, the check the agent
// itself uses. The vectors are valid signatures and their mutations: flipped
// bits in R and S, S + L and other values of S at or above L, the top bits of
// the last byte, non-canonical encodings of R, another message, another key,
// and signatures of the wrong length. agent/scripts/test-install-windows.ps1
// feeds them to the PowerShell check and fails on any disagreement.
//
// With -sshsig <folder> it writes the SSHSIG fixtures instead (sshsig.go).
// Only the standard library is used. With -seed the output is reproducible.
//
//	go run ./scripts/sigdiff -n 400 -seed 1 > vectors.txt
//	go run ./scripts/sigdiff -sshsig install/testdata/sshsig
//	go run ./scripts/sigdiff -sign dist/SHA256SUMS   (test release, fixture key)
package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"math/big"
	"math/rand/v2"
	"os"
)

// Case is one test vector.
type Case struct {
	Pub, Msg, Sig []byte
	Valid         bool
}

func main() {
	n := flag.Int("n", 400, "number of vectors (besides the fixed RFC 8032 ones)")
	seed := flag.Uint64("seed", 0, "seed for reproducible output (0: random)")
	fixtures := flag.String("sshsig", "", "write the SSHSIG fixtures into this folder instead of the vectors")
	sign := flag.String("sign", "", "sign this file with the fixture key (writes <file>.sig, prints the key line); tests only")
	flag.Parse()
	if *sign != "" {
		if err := signWithFixtureKey(*sign); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *fixtures != "" {
		if err := writeFixtures(*fixtures); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	s := *seed
	if s == 0 {
		s = rand.Uint64()
	}
	if err := write(os.Stdout, Generate(*n, s)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func write(w io.Writer, cases []Case) error {
	for _, c := range cases {
		v := 0
		if c.Valid {
			v = 1
		}
		if _, err := fmt.Fprintf(w, "%s %s %s %d\n", hexOrDash(c.Pub), hexOrDash(c.Msg), hexOrDash(c.Sig), v); err != nil {
			return err
		}
	}
	return nil
}

// hexOrDash writes "-" for an empty field (an empty message), so every line
// has four fields.
func hexOrDash(b []byte) string {
	if len(b) == 0 {
		return "-"
	}
	return hex.EncodeToString(b)
}

// rfc8032 are the test vectors 1 to 3 of RFC 8032, section 7.1.
var rfc8032 = [][3]string{
	{"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
		"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
	{"3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
		"92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
	{"fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
		"6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"},
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func verdict(pub, msg, sig []byte) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(pub, msg, sig)
}

// Generate returns the fixed RFC 8032 vectors and n generated ones.
func Generate(n int, seed uint64) []Case {
	rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	var out []Case
	add := func(pub, msg, sig []byte) {
		out = append(out, Case{Pub: pub, Msg: msg, Sig: sig, Valid: verdict(pub, msg, sig)})
	}
	for _, v := range rfc8032 {
		add(mustHex(v[0]), mustHex(v[1]), mustHex(v[2]))
	}
	randBytes := func(k int) []byte {
		b := make([]byte, k)
		for i := range b {
			b[i] = byte(rng.UintN(256))
		}
		return b
	}
	for len(out) < n+len(rfc8032) {
		seedKey := randBytes(ed25519.SeedSize)
		priv := ed25519.NewKeyFromSeed(seedKey)
		pub := priv.Public().(ed25519.PublicKey)
		msg := randBytes(rng.IntN(200))
		sig := ed25519.Sign(priv, msg)
		switch rng.IntN(12) {
		case 0, 1:
			add(pub, msg, sig)
		case 2: // a bit flipped in R
			m := append([]byte(nil), sig...)
			m[rng.IntN(32)] ^= 1 << rng.IntN(8)
			add(pub, msg, m)
		case 3: // a bit flipped in S
			m := append([]byte(nil), sig...)
			m[32+rng.IntN(32)] ^= 1 << rng.IntN(8)
			add(pub, msg, m)
		case 4: // S + L: same point, non-canonical scalar
			add(pub, msg, withS(sig, func(s *big.Int) { s.Add(s, edL) }))
		case 5: // S + k*L or S = L exactly
			if rng.IntN(2) == 0 {
				add(pub, msg, withS(sig, func(s *big.Int) { s.Set(edL) }))
			} else {
				add(pub, msg, withS(sig, func(s *big.Int) { s.Add(s, new(big.Int).Mul(edL, big.NewInt(int64(2+rng.IntN(6))))) }))
			}
		case 6: // top bits of the last byte
			m := append([]byte(nil), sig...)
			m[63] |= 0x20 << rng.IntN(3)
			add(pub, msg, m)
		case 7: // R encoded non-canonically (y + p), where that still fits in 255 bits
			add(pub, msg, nonCanonicalR(sig))
		case 8: // another message
			other := append([]byte(nil), msg...)
			other = append(other, byte(rng.UintN(256)))
			add(pub, other, sig)
		case 9: // another key
			other := ed25519.NewKeyFromSeed(randBytes(ed25519.SeedSize)).Public().(ed25519.PublicKey)
			add(other, msg, sig)
		case 10: // wrong length
			if rng.IntN(2) == 0 {
				add(pub, msg, sig[:63])
			} else {
				add(pub, msg, append(append([]byte(nil), sig...), 0))
			}
		case 11: // random bytes
			add(pub, msg, randBytes(64))
		}
	}
	return out
}

func leBytes(v *big.Int) []byte {
	be := v.FillBytes(make([]byte, 32))
	out := make([]byte, 32)
	for i := range be {
		out[31-i] = be[i]
	}
	return out
}

// withS replaces S when the result still fits in 32 bytes, else keeps sig.
func withS(sig []byte, change func(*big.Int)) []byte {
	s := leInt(sig[32:])
	change(s)
	if s.BitLen() > 256 {
		return sig
	}
	m := append([]byte(nil), sig[:32]...)
	return append(m, leBytes(s)...)
}

// nonCanonicalR re-encodes the y of R as y + p when that is below 2^255.
func nonCanonicalR(sig []byte) []byte {
	r := append([]byte(nil), sig[:32]...)
	sign := r[31] & 0x80
	r[31] &= 0x7f
	y := leInt(r)
	y.Add(y, edP)
	if y.BitLen() > 255 {
		// No non-canonical form for this y; flip the sign bit instead.
		r[31] |= sign ^ 0x80
		return append(r, sig[32:]...)
	}
	enc := leBytes(y)
	enc[31] |= sign
	return append(enc, sig[32:]...)
}
