package baremetal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"unicode/utf8"
)

// MaxLayoutBytes bounds the canonical encoding of a manifest (512 KiB; the
// server rejects larger ones and the agent reports layout_too_large).
const MaxLayoutBytes = 524288

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER (2^53 - 1): the
// largest integer both languages read without loss.
const maxSafeInteger = 9007199254740991

// Canonical returns the canonical JSON of v (contract C1): UTF-8 without
// whitespace, object keys sorted by their UTF-8 bytes, arrays in order,
// strings escaping only '"' and '\', integers 0..2^53-1 without sign or
// exponent. The TypeScript side (canonicalLayoutJson in @restow/core)
// produces the same bytes for the same value; both are tested against the
// files in testdata/manifests.
//
// v is first encoded with encoding/json (which writes struct fields in
// declaration order) and read back as a generic tree with UseNumber, so the
// order of keys comes only from the sort here.
func Canonical(v any) ([]byte, error) {
	tree, err := toTree(v)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, tree); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// toTree turns v into map[string]any, []any, string, json.Number, bool and nil.
func toTree(v any) (any, error) {
	var raw []byte
	switch t := v.(type) {
	case json.RawMessage:
		raw = t
	case []byte:
		raw = t
	default:
		// encoding/json replaces invalid UTF-8 with U+FFFD: check first.
		if err := checkValueStrings(reflect.ValueOf(v), 0); err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(v); err != nil {
			return nil, err
		}
		raw = buf.Bytes()
	}
	return parseTree(raw)
}

// parseTree decodes JSON into a generic tree, keeping numbers as text. It
// rejects what encoding/json would silently turn into U+FFFD: invalid UTF-8
// and lone surrogate escapes (JavaScript keeps those, and they are invalid
// manifest strings there too).
func parseTree(raw []byte) (any, error) {
	if !utf8.Valid(raw) {
		return nil, fmt.Errorf("%w: not valid UTF-8", errBadString)
	}
	if err := checkSurrogates(raw); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("trailing data after the JSON value")
	}
	return tree, nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		s := string(t)
		if !isCanonicalInteger(s) {
			return fmt.Errorf("number %s is not an integer between 0 and %d", s, int64(maxSafeInteger))
		}
		buf.WriteString(s)
	case string:
		if err := checkString(t); err != nil {
			return fmt.Errorf("%q: %w", truncateForError(t), err)
		}
		writeString(buf, t)
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			if err := checkString(k); err != nil {
				return fmt.Errorf("key %q: %w", truncateForError(k), err)
			}
			keys = append(keys, k)
		}
		// Go compares strings by their bytes: UTF-8 byte order.
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeString(buf, k)
			buf.WriteByte(':')
			if err := writeCanonical(buf, t[k]); err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("unsupported JSON value %T", v)
	}
	return nil
}

// writeString writes s quoted, escaping only '"' and '\' (checkString has
// ruled out everything else that JSON would need escaped).
func writeString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' {
			buf.WriteByte('\\')
		}
		buf.WriteByte(c)
	}
	buf.WriteByte('"')
}

// checkSurrogates rejects \uD800-\uDFFF escapes that are not a valid pair.
func checkSurrogates(raw []byte) error {
	inString := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if !inString {
			if c == '"' {
				inString = true
			}
			continue
		}
		switch c {
		case '"':
			inString = false
		case '\\':
			if i+1 < len(raw) && raw[i+1] == 'u' && i+5 < len(raw) {
				r, ok := hex4(raw[i+2 : i+6])
				if ok && r >= 0xd800 && r <= 0xdfff {
					if r >= 0xdc00 {
						return fmt.Errorf("%w: lone surrogate escape", errBadString)
					}
					if i+11 >= len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
						return fmt.Errorf("%w: lone surrogate escape", errBadString)
					}
					lo, ok := hex4(raw[i+8 : i+12])
					if !ok || lo < 0xdc00 || lo > 0xdfff {
						return fmt.Errorf("%w: lone surrogate escape", errBadString)
					}
					i += 11
					continue
				}
				i += 5
				continue
			}
			i++
		}
	}
	return nil
}

func hex4(b []byte) (rune, bool) {
	n, err := strconv.ParseUint(string(b), 16, 32)
	return rune(n), err == nil
}

// checkValueStrings applies checkString to every string reachable from v.
func checkValueStrings(v reflect.Value, depth int) error {
	if depth > 64 {
		return nil
	}
	switch v.Kind() {
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			return fmt.Errorf("%q: %w: not valid UTF-8", truncateForError(v.String()), errBadString)
		}
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			return checkValueStrings(v.Elem(), depth+1)
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				if err := checkValueStrings(v.Field(i), depth+1); err != nil {
					return err
				}
			}
		}
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.Type().Elem().Kind() == reflect.Uint8 {
			return nil
		}
		for i := 0; i < v.Len(); i++ {
			if err := checkValueStrings(v.Index(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.Map:
		it := v.MapRange()
		for it.Next() {
			if err := checkValueStrings(it.Key(), depth+1); err != nil {
				return err
			}
			if err := checkValueStrings(it.Value(), depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func isCanonicalInteger(s string) bool {
	if s == "" || len(s) > 16 {
		return false
	}
	if s == "0" {
		return true
	}
	if s[0] < '1' || s[0] > '9' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return err == nil && n <= maxSafeInteger
}

func truncateForError(s string) string {
	if len(s) > 40 {
		return s[:40] + "..."
	}
	return s
}
