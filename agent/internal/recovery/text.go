package recovery

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Languages of the recovery console (10.2).
const (
	LangEN = "en"
	LangDE = "de"
)

// catalogs holds the texts per language; text_en.go and text_de.go fill
// them. Ids: code.<plan or recover code>, check.<check id>, hint.<hint
// code> and the ids of the dialogs. {name} is replaced by the parameter
// of that name.
var catalogs = map[string]map[string]string{LangEN: textEN, LangDE: textDE}

// T is the text of id in lang (English when lang is unknown or the text
// is missing) with the parameters given as name, value pairs.
func T(lang, id string, kv ...any) string {
	params := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		if k, ok := kv[i].(string); ok {
			params[k] = kv[i+1]
		}
	}
	return TParams(lang, id, params)
}

// TParams is T with a parameter map (a planner finding's params).
func TParams(lang, id string, params map[string]any) string {
	tmpl, ok := catalogs[lang][id]
	if !ok {
		if tmpl, ok = textEN[id]; !ok {
			return id
		}
	}
	return fill(tmpl, params)
}

// HasText reports whether lang has a text for id.
func HasText(lang, id string) bool { _, ok := catalogs[lang][id]; return ok }

func fill(tmpl string, params map[string]any) string {
	var b strings.Builder
	for {
		i := strings.IndexByte(tmpl, '{')
		if i < 0 {
			b.WriteString(tmpl)
			break
		}
		j := strings.IndexByte(tmpl[i:], '}')
		if j < 0 {
			b.WriteString(tmpl)
			break
		}
		b.WriteString(tmpl[:i])
		name := tmpl[i+1 : i+j]
		if v, ok := params[name]; ok {
			b.WriteString(SanitizeForConsole(paramString(v)))
		} else {
			b.WriteString(tmpl[i : i+j+1])
		}
		tmpl = tmpl[i+j+1:]
	}
	return b.String()
}

func paramString(v any) string {
	switch t := v.(type) {
	case nil:
		return "?"
	case string:
		return t
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	case []string:
		return strings.Join(t, ", ")
	case []any:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			parts = append(parts, paramString(e))
		}
		return strings.Join(parts, ", ")
	}
	return fmt.Sprint(v)
}

// placeholders lists the {name} placeholders of a text.
func placeholders(tmpl string) []string {
	var out []string
	for {
		i := strings.IndexByte(tmpl, '{')
		if i < 0 {
			break
		}
		j := strings.IndexByte(tmpl[i:], '}')
		if j < 0 {
			break
		}
		out = append(out, tmpl[i+1:i+j])
		tmpl = tmpl[i+j+1:]
	}
	sort.Strings(out)
	return out
}

// LangForKeymap is the default language for a keymap (de, at and ch
// German, otherwise English); the operator can change it.
func LangForKeymap(layout string) string {
	switch layout {
	case "de", "at", "ch":
		return LangDE
	}
	return LangEN
}
