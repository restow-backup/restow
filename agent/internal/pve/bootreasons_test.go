package pve

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestBootTestReasonsAreConstants: the boot test code names a result's reason only through the
// constants of bootreasons.go, which the server's table of reasons is checked against
// (packages/core/src/pve/boot-test.test.ts). A reason written as a literal would reach the
// server unknown and keep whatever outcome the node sent beside it.
func TestBootTestReasonsAreConstants(t *testing.T) {
	fset := token.NewFileSet()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	used := map[string]bool{}
	parsed := map[string]*ast.File{}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		parsed[name] = f
		if name != "bootreasons.go" {
			continue
		}
		for _, decl := range f.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				vs := spec.(*ast.ValueSpec)
				for i, id := range vs.Names {
					lit, ok := vs.Values[i].(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						t.Fatalf("%s is no string constant", id.Name)
					}
					v, _ := strconv.Unquote(lit.Value)
					reasons[id.Name] = v
				}
			}
		}
	}
	if len(reasons) == 0 {
		t.Fatal("bootreasons.go defines no reasons")
	}
	literal := func(e ast.Expr, where string) {
		if lit, ok := e.(*ast.BasicLit); ok && lit.Kind == token.STRING && lit.Value != `""` {
			t.Errorf("%s: the reason %s of %s is a literal; use a constant of bootreasons.go", fset.Position(lit.Pos()), lit.Value, where)
		}
	}
	for name, f := range parsed {
		// The boot test's own files; other results of the package have reasons of their own.
		boot := strings.HasPrefix(name, "boot")
		ast.Inspect(f, func(n ast.Node) bool {
			if _, ok := n.(*ast.Ident); !ok && !boot {
				return true
			}
			switch n := n.(type) {
			case *ast.Ident:
				if _, ok := reasons[n.Name]; ok && name != "bootreasons.go" {
					used[n.Name] = true
				}
			case *ast.CompositeLit:
				typ, _ := n.Type.(*ast.Ident)
				for i, el := range n.Elts {
					if kv, ok := el.(*ast.KeyValueExpr); ok {
						if key, ok := kv.Key.(*ast.Ident); ok && (key.Name == "Reason" || key.Name == "reason") {
							literal(kv.Value, "a result")
						}
						continue
					}
					if typ != nil && ((typ.Name == "bootOutcome" && i == 1) || (typ.Name == "isolationSkip" && i == 0)) {
						literal(el, typ.Name)
					}
				}
			case *ast.CallExpr:
				if fn, ok := n.Fun.(*ast.Ident); ok && fn.Name == "skipped" && len(n.Args) > 0 {
					literal(n.Args[0], "skipped()")
				}
			case *ast.AssignStmt:
				if len(n.Lhs) == len(n.Rhs) {
					for i, l := range n.Lhs {
						if sel, ok := l.(*ast.SelectorExpr); ok && sel.Sel.Name == "Reason" {
							literal(n.Rhs[i], "a result")
						}
					}
				}
			case *ast.FuncDecl:
				// Helpers that answer (reason, message string).
				res := n.Type.Results
				if n.Body == nil || res == nil || len(res.List) == 0 || len(res.List[0].Names) == 0 || res.List[0].Names[0].Name != "reason" {
					return true
				}
				ast.Inspect(n.Body, func(m ast.Node) bool {
					if _, ok := m.(*ast.FuncLit); ok {
						return false
					}
					if ret, ok := m.(*ast.ReturnStmt); ok && len(ret.Results) > 0 {
						literal(ret.Results[0], n.Name.Name+"()")
					}
					return true
				})
			}
			return true
		})
	}
	var unused []string
	for name := range reasons {
		if !used[name] {
			unused = append(unused, name)
		}
	}
	sort.Strings(unused)
	if len(unused) > 0 {
		t.Errorf("reasons no code sends (drop them, or keep the server's table and the web texts in step): %v", unused)
	}
}
