package share

import (
	"bytes"
	"encoding/binary"
	"os"
	"strings"
	"syscall"
	"testing"
)

var eacces = &os.PathError{Op: "getxattr", Path: "/share", Err: syscall.EACCES}

func TestChooseACLXattrSMBFallback(t *testing.T) {
	sys := newFakeSys(MagicCIFS)
	sys.put("/share", XattrNTSDFull, []byte("full"))
	sys.put("/share", XattrNTSD, []byte("ntsd"))
	sys.put("/share", XattrCIFSACL, []byte("acl"))
	if got, _ := ChooseACLXattr(sys, "/share", ProtocolSMB); got != XattrNTSDFull {
		t.Fatalf("full: %s", got)
	}
	// No SeSecurityPrivilege: the full descriptor is refused, the DACL one works.
	sys.getErr["*|"+XattrNTSDFull] = eacces
	got, err := ChooseACLXattr(sys, "/share", ProtocolSMB)
	if got != XattrNTSD || err == nil {
		t.Fatalf("ntsd: %s %v", got, err)
	}
	sys.getErr["*|"+XattrNTSD] = eacces
	if got, _ := ChooseACLXattr(sys, "/share", ProtocolSMB); got != XattrCIFSACL {
		t.Fatalf("acl: %s", got)
	}
	sys.getErr["*|"+XattrCIFSACL] = eacces
	if got, err := ChooseACLXattr(sys, "/share", ProtocolSMB); got != ACLModeNone || err == nil {
		t.Fatalf("none: %s %v", got, err)
	}
}

func TestChooseACLXattrNFS(t *testing.T) {
	sys := newFakeSys(MagicNFS)
	sys.put("/share", XattrNFS4ACL, []byte("nfs4"))
	if got, _ := ChooseACLXattr(sys, "/share", ProtocolNFS); got != XattrNFS4ACL {
		t.Fatalf("nfs4: %s", got)
	}
	// NFSv3: no nfs4_acl, POSIX ACLs answer ENODATA (supported, none set).
	sys = newFakeSys(MagicNFS)
	sys.getErr["*|"+XattrNFS4ACL] = syscall.EOPNOTSUPP
	if got, _ := ChooseACLXattr(sys, "/share", ProtocolNFS); got != ACLModePosix {
		t.Fatalf("posix: %s", got)
	}
	// A server without ACLs: none, and no error (no warning, 4.5).
	sys.getErr["*|"+XattrPosixAccess] = syscall.EOPNOTSUPP
	if got, err := ChooseACLXattr(sys, "/share", ProtocolNFS); got != ACLModeNone || err != nil {
		t.Fatalf("none: %s %v", got, err)
	}
}

func TestCaptureReadsDescriptorDOSAndCreationTime(t *testing.T) {
	sys := newFakeSys(MagicCIFS)
	attrs := make([]byte, 4)
	binary.LittleEndian.PutUint32(attrs, 0x21)
	created := make([]byte, 8)
	binary.LittleEndian.PutUint64(created, 133701234567890000)
	sys.put("/share/f", XattrNTSD, []byte("sd"))
	sys.put("/share/f", XattrDOSAttrib, attrs)
	sys.put("/share/f", XattrCreationTime, created)
	c := &Capturer{X: sys, Protocol: ProtocolSMB, Xattr: XattrNTSD}
	got, err := c.Capture("/share/f", false)
	mustNoErr(t, err)
	if string(got.Descriptor.Raw) != "sd" || *got.Attrs != 0x21 || *got.Created != 133701234567890000 {
		t.Fatalf("captured %+v", got)
	}
	// A per-file failure is an error for that file; the DOS attributes still come.
	sys.getErr["/share/f|"+XattrNTSD] = eacces
	got, err = c.Capture("/share/f", false)
	if err == nil || got.Descriptor != nil || got.Attrs == nil {
		t.Fatalf("per-file failure: %+v %v", got, err)
	}
	// Posix: access plus default for a folder.
	sys.put("/d", XattrPosixAccess, []byte{1})
	sys.put("/d", XattrPosixDefault, []byte{2})
	pc := &Capturer{X: sys, Protocol: ProtocolNFS, Xattr: ACLModePosix}
	got, err = pc.Capture("/d", true)
	mustNoErr(t, err)
	if !bytes.Equal(got.Descriptor.Posix.Access, []byte{1}) || !bytes.Equal(got.Descriptor.Posix.Default, []byte{2}) {
		t.Fatalf("posix %+v", got.Descriptor.Posix)
	}
}

func TestParseDOSAttrib(t *testing.T) {
	if v, ok := ParseDOSAttrib([]byte{0x20, 0x10, 0, 0}); !ok || v != 0x1020 || !IsOffline(v) {
		t.Fatalf("binary: %x %v", v, ok)
	}
	if v, ok := ParseDOSAttrib([]byte("0x400020\x00")); !ok || v != 0x400020 || !IsOffline(v) {
		t.Fatalf("text: %x %v", v, ok)
	}
	if _, ok := ParseDOSAttrib([]byte{1, 2}); ok {
		t.Fatal("two bytes accepted")
	}
	if IsOffline(0x20) {
		t.Fatal("archive is not offline")
	}
}

func TestApplierFallbackAndOrder(t *testing.T) {
	sys := newFakeSys(MagicCIFS)
	// The owner and SACL need privileges the account lacks: full and ntsd are refused.
	sys.setErr["*|"+XattrNTSDFull] = &os.PathError{Err: syscall.EPERM}
	sys.setErr["*|"+XattrNTSD] = &os.PathError{Err: syscall.EPERM}
	a := &Applier{X: sys, Protocol: ProtocolSMB, HeaderXattr: XattrNTSDFull}
	attrs := uint32(DOSReadOnly | DOSOffline | DOSRecallOnDataAccess | 0x20)
	created := uint64(42)
	level, err := a.Apply("/share/f", SidecarEntry{Path: "f", Descriptor: &Descriptor{Raw: []byte("sd")}, Attrs: &attrs, Created: &created})
	mustNoErr(t, err)
	if level != XattrCIFSACL || a.Levels[XattrCIFSACL] != 1 {
		t.Fatalf("level %s %v", level, a.Levels)
	}
	// Order: the descriptor first, DOS attributes last.
	if len(sys.sets) != 3 || !strings.HasPrefix(sys.sets[0], XattrCIFSACL) || !strings.HasPrefix(sys.sets[2], XattrDOSAttrib) {
		t.Fatalf("order %v", sys.sets)
	}
	// Offline and recall bits are never restored.
	if v := binary.LittleEndian.Uint32(sys.value("/share/f", XattrDOSAttrib)); v != DOSReadOnly|0x20 {
		t.Fatalf("dos attrs %x", v)
	}

	// A descriptor read without SACL starts at cifs_ntsd, never at the full one.
	sys2 := newFakeSys(MagicCIFS)
	a2 := &Applier{X: sys2, Protocol: ProtocolSMB, HeaderXattr: XattrNTSD}
	level, _ = a2.Apply("/x", SidecarEntry{Descriptor: &Descriptor{Raw: []byte("sd")}})
	if level != XattrNTSD || len(sys2.sets) != 1 {
		t.Fatalf("start level %s %v", level, sys2.sets)
	}

	// Nothing works: counted as failed, the error returned.
	sys.setErr["*|"+XattrCIFSACL] = &os.PathError{Err: syscall.EPERM}
	if _, err := a.Apply("/share/g", SidecarEntry{Descriptor: &Descriptor{Raw: []byte("sd")}}); err == nil || a.Failed != 1 {
		t.Fatalf("all refused: %v %d", err, a.Failed)
	}
}

func TestApplierNFS(t *testing.T) {
	sys := newFakeSys(MagicNFS)
	a := &Applier{X: sys, Protocol: ProtocolNFS}
	level, err := a.Apply("/d", SidecarEntry{Descriptor: &Descriptor{Posix: &PosixACL{Access: []byte{1}, Default: []byte{2}}}})
	mustNoErr(t, err)
	if level != ACLModePosix || !bytes.Equal(sys.value("/d", XattrPosixDefault), []byte{2}) {
		t.Fatalf("posix %s", level)
	}
	level, err = a.Apply("/f", SidecarEntry{Descriptor: &Descriptor{Raw: []byte("acl4")}})
	mustNoErr(t, err)
	if level != XattrNFS4ACL {
		t.Fatalf("nfs4 %s", level)
	}
	// An SMB descriptor never reaches an NFS target as a raw nfs4_acl... the caller
	// checks the protocol; the SMB applier refuses POSIX descriptors.
	smb := &Applier{X: sys, Protocol: ProtocolSMB}
	if _, err := smb.Apply("/x", SidecarEntry{Descriptor: &Descriptor{Posix: &PosixACL{Access: []byte{1}}}}); err == nil {
		t.Fatal("posix descriptor on SMB accepted")
	}
}
