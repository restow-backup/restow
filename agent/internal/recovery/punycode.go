package recovery

import (
	"errors"
	"strings"
)

// Punycode (RFC 3492) parameters.
const (
	pcBase        = 36
	pcTMin        = 1
	pcTMax        = 26
	pcSkew        = 38
	pcDamp        = 700
	pcInitialBias = 72
	pcInitialN    = 128
	pcMaxInt      = int32(^uint32(0) >> 1)
)

var errPunycodeOverflow = errors.New("punycode: overflow")

// punycodeEncode encodes one label (without the xn-- prefix) as in RFC 3492,
// section 6.3. Basic code points are copied as they are (no case folding;
// the caller lowers the label first). It is the only IDNA step the agent
// needs, so the agent keeps its no-module rule (see go.mod).
func punycodeEncode(label string) (string, error) {
	input := []rune(label)
	var out strings.Builder
	for _, r := range input {
		if r < 0x80 {
			out.WriteRune(r)
		}
	}
	b := int32(out.Len())
	h := b
	if b > 0 {
		out.WriteByte('-')
	}
	n := int32(pcInitialN)
	delta := int32(0)
	bias := int32(pcInitialBias)
	for h < int32(len(input)) {
		m := pcMaxInt
		for _, r := range input {
			if r >= n && r < m {
				m = r
			}
		}
		if (m - n) > (pcMaxInt-delta)/(h+1) {
			return "", errPunycodeOverflow
		}
		delta += (m - n) * (h + 1)
		n = m
		for _, r := range input {
			if r < n {
				delta++
				if delta < 0 {
					return "", errPunycodeOverflow
				}
			}
			if r != n {
				continue
			}
			q := delta
			for k := int32(pcBase); ; k += pcBase {
				t := k - bias
				switch {
				case t < pcTMin:
					t = pcTMin
				case t > pcTMax:
					t = pcTMax
				}
				if q < t {
					break
				}
				out.WriteByte(punycodeDigit(t + (q-t)%(pcBase-t)))
				q = (q - t) / (pcBase - t)
			}
			out.WriteByte(punycodeDigit(q))
			bias = punycodeAdapt(delta, h+1, h == b)
			delta = 0
			h++
		}
		delta++
		n++
	}
	return out.String(), nil
}

func punycodeDigit(d int32) byte {
	if d < 26 {
		return byte('a' + d)
	}
	return byte('0' + d - 26)
}

func punycodeAdapt(delta, numPoints int32, first bool) int32 {
	if first {
		delta /= pcDamp
	} else {
		delta /= 2
	}
	delta += delta / numPoints
	k := int32(0)
	for delta > ((pcBase-pcTMin)*pcTMax)/2 {
		delta /= pcBase - pcTMin
		k += pcBase
	}
	return k + (pcBase-pcTMin+1)*delta/(delta+pcSkew)
}
