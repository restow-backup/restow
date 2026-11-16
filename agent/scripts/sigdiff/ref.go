package main

// refVerify is the Ed25519 verification of the Windows installer
// (agent/install/windows.ps1, function Test-Ed25519Signature) written once
// more in Go with math/big, step for step like the PowerShell code. Its tests
// compare it with crypto/ed25519 on the same vectors the Windows job feeds to
// the PowerShell code, so a mistake in the algorithm shows on Linux already;
// the Windows job then checks the PowerShell transcription itself.
//
// Acceptance rules of crypto/ed25519 (and so of the agent): signature of 64
// bytes with the top three bits of the last byte clear, S < L, the public key
// decodes (non-canonical y and a negative zero x are accepted, as in
// filippo.io/edwards25519), k = SHA-512(R || A || M) mod L, valid exactly when
// the encoding of [S]B - [k]A equals R byte for byte (so a non-canonical R
// never verifies).

import (
	"crypto/sha512"
	"math/big"
)

var (
	edP     = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	edL     = mustInt("7237005577332262213973186563042994240857116359379907606001950938285454250989")
	edD     = refMod(new(big.Int).Mul(big.NewInt(-121665), new(big.Int).ModInverse(big.NewInt(121666), edP)))
	edD2    = refMod(new(big.Int).Mul(edD, big.NewInt(2)))
	edSqrtM = new(big.Int).Exp(big.NewInt(2), new(big.Int).Rsh(new(big.Int).Sub(edP, big.NewInt(1)), 2), edP)
	edBy    = refMod(new(big.Int).Mul(big.NewInt(4), new(big.Int).ModInverse(big.NewInt(5), edP)))
)

func mustInt(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic(s)
	}
	return v
}

func refMod(a *big.Int) *big.Int { return new(big.Int).Mod(a, edP) }

// leInt reads little-endian bytes as a non-negative integer.
func leInt(b []byte) *big.Int {
	be := make([]byte, len(b))
	for i := range b {
		be[len(b)-1-i] = b[i]
	}
	return new(big.Int).SetBytes(be)
}

type point struct{ X, Y, Z, T *big.Int }

func identity() point { return point{big.NewInt(0), big.NewInt(1), big.NewInt(1), big.NewInt(0)} }

// pointAdd is add-2008-hwcd-3 for a = -1 (unified: also doubles).
func pointAdd(p, q point) point {
	mul := func(a, b *big.Int) *big.Int { return refMod(new(big.Int).Mul(a, b)) }
	add := func(a, b *big.Int) *big.Int { return refMod(new(big.Int).Add(a, b)) }
	sub := func(a, b *big.Int) *big.Int { return refMod(new(big.Int).Sub(a, b)) }
	a := mul(sub(p.Y, p.X), sub(q.Y, q.X))
	b := mul(add(p.Y, p.X), add(q.Y, q.X))
	c := mul(mul(p.T, edD2), q.T)
	d := mul(mul(p.Z, big.NewInt(2)), q.Z)
	e, f, g, h := sub(b, a), sub(d, c), add(d, c), add(b, a)
	return point{mul(e, f), mul(g, h), mul(f, g), mul(e, h)}
}

func pointNeg(p point) point {
	return point{refMod(new(big.Int).Neg(p.X)), p.Y, p.Z, refMod(new(big.Int).Neg(p.T))}
}

// decodePoint returns nil when the bytes are no point.
func decodePoint(b []byte) *point {
	if len(b) != 32 {
		return nil
	}
	c := append([]byte(nil), b...)
	sign := c[31] >> 7
	c[31] &= 0x7f
	y := refMod(leInt(c))
	y2 := refMod(new(big.Int).Mul(y, y))
	u := refMod(new(big.Int).Sub(y2, big.NewInt(1)))
	v := refMod(new(big.Int).Add(new(big.Int).Mul(edD, y2), big.NewInt(1)))
	// x = (u/v)^((p+3)/8)
	uv := refMod(new(big.Int).Mul(u, new(big.Int).ModInverse(v, edP)))
	x := new(big.Int).Exp(uv, new(big.Int).Rsh(new(big.Int).Add(edP, big.NewInt(3)), 3), edP)
	vx2 := refMod(new(big.Int).Mul(v, new(big.Int).Mul(x, x)))
	switch {
	case vx2.Cmp(u) == 0:
	case vx2.Cmp(refMod(new(big.Int).Neg(u))) == 0:
		x = refMod(new(big.Int).Mul(x, edSqrtM))
	default:
		return nil
	}
	if x.Bit(0) != uint(sign) {
		x = refMod(new(big.Int).Neg(x))
	}
	return &point{x, y, big.NewInt(1), refMod(new(big.Int).Mul(x, y))}
}

func encodePoint(p point) []byte {
	zi := new(big.Int).ModInverse(p.Z, edP)
	x := refMod(new(big.Int).Mul(p.X, zi))
	y := refMod(new(big.Int).Mul(p.Y, zi))
	be := y.FillBytes(make([]byte, 32))
	out := make([]byte, 32)
	for i := range be {
		out[31-i] = be[i]
	}
	out[31] |= byte(x.Bit(0)) << 7
	return out
}

// refVerify mirrors Test-Ed25519Signature in windows.ps1.
func refVerify(pub, msg, sig []byte) bool {
	if len(pub) != 32 || len(sig) != 64 || sig[63]&0xe0 != 0 {
		return false
	}
	a := decodePoint(pub)
	if a == nil {
		return false
	}
	s := leInt(sig[32:])
	if s.Cmp(edL) >= 0 {
		return false
	}
	h := sha512.New()
	h.Write(sig[:32])
	h.Write(pub)
	h.Write(msg)
	k := new(big.Int).Mod(leInt(h.Sum(nil)), edL)
	b := basePoint()
	negA := pointNeg(*a)
	// Joint double-and-add over both scalars (Straus), high bit first.
	q := identity()
	for i := 255; i >= 0; i-- {
		q = pointAdd(q, q)
		if s.Bit(i) == 1 {
			q = pointAdd(q, b)
		}
		if k.Bit(i) == 1 {
			q = pointAdd(q, negA)
		}
	}
	r := encodePoint(q)
	for i := range r {
		if r[i] != sig[i] {
			return false
		}
	}
	return true
}

// basePoint decodes B from its y = 4/5 with an even x.
func basePoint() point {
	be := edBy.FillBytes(make([]byte, 32))
	le := make([]byte, 32)
	for i := range be {
		le[31-i] = be[i]
	}
	return *decodePoint(le)
}
