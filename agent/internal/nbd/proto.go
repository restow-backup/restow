// Package nbd implements the parts of the Network Block Device protocol that
// restow-pve needs, from the public protocol description
// (https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md):
//
//   - a client for the backup side: fixed newstyle handshake over a Unix
//     socket, structured replies, NBD_OPT_SET_META_CONTEXT (for the
//     `qemu:dirty-bitmap:<name>` and `base:allocation` contexts),
//     NBD_OPT_GO, and the commands READ, BLOCK_STATUS, TRIM and DISC;
//   - a read-only server for the restore side: it serves one or more exports
//     to `qemu-img convert` (`nbd+unix:///<export>?socket=<path>`), with
//     structured replies and `base:allocation` so unwritten blocks read as
//     holes.
//
// Standard library only. Requests are issued one at a time per connection;
// that keeps the state machine small and is fast enough for 4 MiB reads.
package nbd

import (
	"errors"
	"fmt"
)

// Magic numbers and constants of the protocol.
const (
	magicInit         uint64 = 0x4e42444d41474943 // "NBDMAGIC"
	magicOpt          uint64 = 0x49484156454f5054 // "IHAVEOPT"
	magicOptReply     uint64 = 0x0003e889045565a9
	magicRequest      uint32 = 0x25609513
	magicSimpleReply  uint32 = 0x67446698
	magicStructReply  uint32 = 0x668e33ef
	flagFixedNewstyle uint16 = 1 << 0
	flagNoZeroes      uint16 = 1 << 1
	clientFlagFixed   uint32 = 1 << 0
	clientFlagNoZero  uint32 = 1 << 1
)

// Option codes.
const (
	optExportName     uint32 = 1
	optAbort          uint32 = 2
	optList           uint32 = 3
	optStartTLS       uint32 = 5
	optInfo           uint32 = 6
	optGo             uint32 = 7
	optStructuredRepl uint32 = 8
	optListMetaCtx    uint32 = 9
	optSetMetaCtx     uint32 = 10
)

// Option reply types.
const (
	repAck         uint32 = 1
	repServer      uint32 = 2
	repInfo        uint32 = 3
	repMetaContext uint32 = 4
	repErrBit      uint32 = 1 << 31
	repErrUnsup           = repErrBit | 1
	repErrPolicy          = repErrBit | 2
	repErrInvalid         = repErrBit | 3
	repErrUnknown         = repErrBit | 6
)

// Info types (NBD_OPT_INFO / NBD_OPT_GO).
const (
	infoExport    uint16 = 0
	infoBlockSize uint16 = 3
)

// Transmission flags.
const (
	FlagHasFlags        uint16 = 1 << 0
	FlagReadOnly        uint16 = 1 << 1
	FlagSendFlush       uint16 = 1 << 2
	FlagSendTrim        uint16 = 1 << 5
	FlagSendWriteZeroes uint16 = 1 << 6
	FlagSendDF          uint16 = 1 << 7
	FlagCanMultiConn    uint16 = 1 << 8
)

// Commands.
const (
	cmdRead        uint16 = 0
	cmdWrite       uint16 = 1
	cmdDisc        uint16 = 2
	cmdFlush       uint16 = 3
	cmdTrim        uint16 = 4
	cmdBlockStatus uint16 = 7
)

// Command flags.
const (
	cmdFlagReqOne uint16 = 1 << 3
)

// Structured reply chunk types and flags.
const (
	replyFlagDone      uint16 = 1 << 0
	chunkNone          uint16 = 0
	chunkOffsetData    uint16 = 1
	chunkOffsetHole    uint16 = 2
	chunkBlockStatus   uint16 = 5
	chunkErrorBit      uint16 = 1 << 15
	chunkError                = chunkErrorBit | 1
	chunkErrorOffset          = chunkErrorBit | 2
	maxStructuredChunk        = 64 << 20
)

// Errno values used on the wire.
const (
	errPerm      uint32 = 1
	errIO        uint32 = 5
	errInval     uint32 = 22
	errNoSpc     uint32 = 28
	errOverflow  uint32 = 75
	errNotSup    uint32 = 95
	errShutdown  uint32 = 108
	maxNameBytes        = 4096
	// MaxRequest is the largest read this package issues or serves (32 MiB,
	// the limit qemu-nbd also applies).
	MaxRequest = 32 << 20
)

// Context names.
const (
	// ContextBaseAllocation is the standard allocation context (holes, zeroes).
	ContextBaseAllocation = "base:allocation"
	// DirtyBitmapPrefix is how QEMU names the context of a dirty bitmap.
	DirtyBitmapPrefix = "qemu:dirty-bitmap:"
)

// Block status flags of base:allocation.
const (
	StateHole uint32 = 1 << 0
	StateZero uint32 = 1 << 1
)

// StateDirty is set in a dirty-bitmap context for the dirty parts of the image
// (the first bit, per the QEMU documentation of the context).
const StateDirty uint32 = 1 << 0

// Extent is one run of a block status reply.
type Extent struct {
	Offset uint64
	Length uint64
	Flags  uint32
}

// ErrorReply is an error the server answered a command with.
type ErrorReply struct {
	Errno   uint32
	Message string
}

func (e *ErrorReply) Error() string {
	name := errnoName(e.Errno)
	if e.Message != "" {
		return fmt.Sprintf("nbd: server error %s: %s", name, e.Message)
	}
	return "nbd: server error " + name
}

// IsErrno reports whether err is a server error with this errno.
func IsErrno(err error, errno uint32) bool {
	var e *ErrorReply
	return errors.As(err, &e) && e.Errno == errno
}

func errnoName(n uint32) string {
	switch n {
	case errPerm:
		return "EPERM"
	case errIO:
		return "EIO"
	case 12:
		return "ENOMEM"
	case errInval:
		return "EINVAL"
	case errNoSpc:
		return "ENOSPC"
	case errOverflow:
		return "EOVERFLOW"
	case errNotSup:
		return "ENOTSUP"
	case errShutdown:
		return "ESHUTDOWN"
	}
	return fmt.Sprintf("errno %d", n)
}

// OptionError is a refusal of an option during the handshake.
type OptionError struct {
	Option  uint32
	Reply   uint32
	Message string
}

func (e *OptionError) Error() string {
	return fmt.Sprintf("nbd: option %d refused (reply 0x%x): %s", e.Option, e.Reply, e.Message)
}
