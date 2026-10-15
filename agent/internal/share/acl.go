package share

import (
	"encoding/binary"
	"errors"
	"strconv"
	"strings"
)

// Permissions capture and write-back through extended attributes
// (docs/FILESHARES.md 4.5 and 4.7). The cifs client exposes a file's
// security descriptor as pseudo-xattrs without `cifsacl` [I, host check 3];
// the NFS client exposes NFSv4 ACLs and, over NFSACL, POSIX ACLs [I, host
// check 7]. Everything here goes through the Xattrs interface.

// The xattrs this package reads and writes.
const (
	XattrNTSDFull     = "system.cifs_ntsd_full"
	XattrNTSD         = "system.cifs_ntsd"
	XattrCIFSACL      = "system.cifs_acl"
	XattrDOSAttrib    = "user.cifs.dosattrib"
	XattrCreationTime = "user.cifs.creationtime"
	XattrNFS4ACL      = "system.nfs4_acl"
	XattrPosixAccess  = "system.posix_acl_access"
	XattrPosixDefault = "system.posix_acl_default"

	// ACLModePosix and ACLModeNone are the header's `xattr` for POSIX ACLs and
	// for a share without readable permissions.
	ACLModePosix = "posix"
	ACLModeNone  = "none"
)

// SMBChain is the order of the SMB xattrs, most complete first.
var SMBChain = []string{XattrNTSDFull, XattrNTSD, XattrCIFSACL}

// DOS attribute bits [K].
const (
	DOSReadOnly           = 0x1
	DOSOffline            = 0x1000
	DOSRecallOnOpen       = 0x40000
	DOSRecallOnDataAccess = 0x400000
)

// IsOffline: a tiered placeholder that reading would recall (4.4).
func IsOffline(attrs uint32) bool { return attrs&(DOSOffline|DOSRecallOnDataAccess) != 0 }

// ChooseACLXattr decides, at the share root, which xattr this run reads
// (4.5). It returns ACLModeNone when the share has none; the error, when not
// nil, is why the most capable one failed (for the probe's report).
func ChooseACLXattr(x Xattrs, root, protocol string) (string, error) {
	switch protocol {
	case ProtocolSMB:
		var first error
		for _, name := range SMBChain {
			_, err := x.GetXattr(root, name)
			if err == nil {
				return name, first
			}
			if first == nil {
				first = err
			}
		}
		return ACLModeNone, first
	case ProtocolNFS:
		if _, err := x.GetXattr(root, XattrNFS4ACL); err == nil {
			return XattrNFS4ACL, nil
		} else if !isNotSupported(err) && !isNoData(err) {
			return ACLModeNone, err
		}
		_, err := x.GetXattr(root, XattrPosixAccess)
		if err == nil || isNoData(err) {
			return ACLModePosix, nil
		}
		if isNotSupported(err) {
			// The server has no ACLs: no warning (4.5).
			return ACLModeNone, nil
		}
		return ACLModeNone, err
	}
	return ACLModeNone, errors.New("unknown protocol")
}

// Capturer reads the permissions of one file or folder.
type Capturer struct {
	X        Xattrs
	Protocol string
	// Xattr is what ChooseACLXattr decided.
	Xattr string
}

// Captured is what Capture read.
type Captured struct {
	Descriptor *Descriptor
	Attrs      *uint32
	Created    *uint64
}

// Capture reads the descriptor (an error is an acl_unreadable item) and, on
// SMB, best effort, the DOS attributes and the creation time.
func (c *Capturer) Capture(path string, isDir bool) (Captured, error) {
	var out Captured
	var aclErr error
	switch c.Xattr {
	case ACLModeNone, "":
	case ACLModePosix:
		acl := &PosixACL{}
		access, err := c.X.GetXattr(path, XattrPosixAccess)
		switch {
		case err == nil:
			acl.Access = access
		case isNoData(err):
		default:
			aclErr = err
		}
		if isDir && aclErr == nil {
			def, err := c.X.GetXattr(path, XattrPosixDefault)
			switch {
			case err == nil:
				acl.Default = def
			case isNoData(err):
			default:
				aclErr = err
			}
		}
		if aclErr == nil {
			out.Descriptor = &Descriptor{Posix: acl}
		}
	default:
		raw, err := c.X.GetXattr(path, c.Xattr)
		if err != nil {
			aclErr = err
		} else {
			out.Descriptor = &Descriptor{Raw: raw}
		}
	}
	if c.Protocol == ProtocolSMB {
		if v, err := c.X.GetXattr(path, XattrDOSAttrib); err == nil {
			if a, ok := ParseDOSAttrib(v); ok {
				out.Attrs = &a
			}
		}
		if v, err := c.X.GetXattr(path, XattrCreationTime); err == nil {
			if t, ok := parseUint64LE(v); ok {
				out.Created = &t
			}
		}
	}
	return out, aclErr
}

// ParseDOSAttrib reads user.cifs.dosattrib: a little-endian 32-bit value
// [K for current kernels]; a "0x..." text form is accepted as well.
func ParseDOSAttrib(v []byte) (uint32, bool) {
	if s := strings.TrimSpace(strings.TrimRight(string(v), "\x00")); strings.HasPrefix(s, "0x") {
		n, err := strconv.ParseUint(s[2:], 16, 32)
		return uint32(n), err == nil
	}
	if len(v) == 4 {
		return binary.LittleEndian.Uint32(v), true
	}
	if len(v) == 8 {
		return uint32(binary.LittleEndian.Uint64(v)), true
	}
	return 0, false
}

func parseUint64LE(v []byte) (uint64, bool) {
	if len(v) != 8 {
		return 0, false
	}
	return binary.LittleEndian.Uint64(v), true
}

// Applier writes permissions back (4.7). It is not safe for concurrent use.
type Applier struct {
	X        Xattrs
	Protocol string
	// HeaderXattr is the sidecar header's `xattr`: SMB starts its fallback
	// chain there (a descriptor read without SACL is never written as a full
	// one, which would clear the target's SACL).
	HeaderXattr string
	// Levels counts the level reached per file: an xattr name, "posix", or
	// "none".
	Levels map[string]int
	Failed int
}

// Apply writes one entry to path. It returns the level reached ("" when the
// entry has nothing to write) and, when no level worked, the last error.
// DOS attributes and the creation time are set last, best effort, offline
// and recall bits never.
func (a *Applier) Apply(path string, e SidecarEntry) (string, error) {
	if a.Levels == nil {
		a.Levels = map[string]int{}
	}
	level := ""
	var lastErr error
	if e.Descriptor != nil && !e.Descriptor.Empty() {
		level, lastErr = a.applyDescriptor(path, *e.Descriptor)
		if level == "" {
			a.Failed++
			a.Levels[ACLModeNone]++
		} else {
			a.Levels[level]++
		}
	}
	if a.Protocol == ProtocolSMB {
		if e.Created != nil {
			b := make([]byte, 8)
			binary.LittleEndian.PutUint64(b, *e.Created)
			_ = a.X.SetXattr(path, XattrCreationTime, b)
		}
		if e.Attrs != nil {
			attrs := *e.Attrs &^ (DOSOffline | DOSRecallOnDataAccess | DOSRecallOnOpen)
			b := make([]byte, 4)
			binary.LittleEndian.PutUint32(b, attrs)
			_ = a.X.SetXattr(path, XattrDOSAttrib, b)
		}
	}
	if level == "" && lastErr != nil {
		return "", lastErr
	}
	return level, nil
}

func (a *Applier) applyDescriptor(path string, d Descriptor) (string, error) {
	switch a.Protocol {
	case ProtocolSMB:
		if d.Raw == nil {
			return "", errors.New("not an SMB descriptor")
		}
		start := 0
		for i, name := range SMBChain {
			if name == a.HeaderXattr {
				start = i
			}
		}
		var lastErr error
		for _, name := range SMBChain[start:] {
			if err := a.X.SetXattr(path, name, d.Raw); err != nil {
				lastErr = err
				continue
			}
			return name, nil
		}
		return "", lastErr
	case ProtocolNFS:
		if d.Posix != nil {
			if len(d.Posix.Access) > 0 {
				if err := a.X.SetXattr(path, XattrPosixAccess, d.Posix.Access); err != nil {
					return "", err
				}
			}
			if len(d.Posix.Default) > 0 {
				if err := a.X.SetXattr(path, XattrPosixDefault, d.Posix.Default); err != nil {
					return "", err
				}
			}
			return ACLModePosix, nil
		}
		if err := a.X.SetXattr(path, XattrNFS4ACL, d.Raw); err != nil {
			return "", err
		}
		return XattrNFS4ACL, nil
	}
	return "", errors.New("unknown protocol")
}
