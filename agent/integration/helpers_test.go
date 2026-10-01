//go:build integration

package integration

import "encoding/json"

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }
