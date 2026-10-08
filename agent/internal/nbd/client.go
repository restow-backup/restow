package nbd

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// ClientOptions configures Dial.
type ClientOptions struct {
	// Export is the export name ("" is the default export).
	Export string
	// MetaContexts are requested with NBD_OPT_SET_META_CONTEXT (needs
	// structured replies). A context the server does not offer is simply
	// absent from Client.Contexts.
	MetaContexts []string
	// NoStructuredReplies turns structured replies off (tests).
	NoStructuredReplies bool
	// HandshakeTimeout bounds the handshake (default 30 s).
	HandshakeTimeout time.Duration
}

// Client is a connection in the transmission phase. Its methods may be
// called from several goroutines; requests are serialised.
type Client struct {
	mu         sync.Mutex
	conn       net.Conn
	r          *bufio.Reader
	w          *bufio.Writer
	size       uint64
	flags      uint16
	structured bool
	contexts   map[string]uint32
	cookie     uint64
	minBlock   uint32
	closed     bool
	broken     error
}

// Dial connects to an NBD server ("unix", "/path/to/socket" or "tcp", host:port)
// and negotiates the export.
func Dial(ctx context.Context, network, address string, o ClientOptions) (*Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, network, address)
	if err != nil {
		return nil, fmt.Errorf("nbd: connect %s: %w", address, err)
	}
	c, err := NewClient(ctx, conn, o)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return c, nil
}

// NewClient runs the handshake on an established connection.
func NewClient(ctx context.Context, conn net.Conn, o ClientOptions) (*Client, error) {
	timeout := o.HandshakeTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	c := &Client{
		conn:     conn,
		r:        bufio.NewReaderSize(conn, 256<<10),
		w:        bufio.NewWriterSize(conn, 64<<10),
		contexts: map[string]uint32{},
	}
	if err := c.handshake(o); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return c, nil
}

// Size is the export size in bytes.
func (c *Client) Size() uint64 { return c.size }

// Flags are the transmission flags of the export.
func (c *Client) Flags() uint16 { return c.flags }

// ReadOnly reports whether the export refuses writes and trims.
func (c *Client) ReadOnly() bool { return c.flags&FlagReadOnly != 0 }

// CanTrim reports whether the server accepts NBD_CMD_TRIM.
func (c *Client) CanTrim() bool { return c.flags&FlagSendTrim != 0 && !c.ReadOnly() }

// Structured reports whether structured replies were negotiated.
func (c *Client) Structured() bool { return c.structured }

// Context returns the id of a negotiated meta context.
func (c *Client) Context(name string) (uint32, bool) {
	id, ok := c.contexts[name]
	return id, ok
}

func (c *Client) handshake(o ClientOptions) error {
	var hdr [18]byte
	if _, err := io.ReadFull(c.r, hdr[:]); err != nil {
		return fmt.Errorf("nbd: read greeting: %w", err)
	}
	if binary.BigEndian.Uint64(hdr[0:8]) != magicInit {
		return errors.New("nbd: not an NBD server (bad magic)")
	}
	if binary.BigEndian.Uint64(hdr[8:16]) != magicOpt {
		return errors.New("nbd: server speaks the oldstyle protocol, which is not supported")
	}
	serverFlags := binary.BigEndian.Uint16(hdr[16:18])
	if serverFlags&flagFixedNewstyle == 0 {
		return errors.New("nbd: server does not support fixed newstyle negotiation")
	}
	clientFlags := clientFlagFixed
	if serverFlags&flagNoZeroes != 0 {
		clientFlags |= clientFlagNoZero
	}
	if err := binary.Write(c.w, binary.BigEndian, clientFlags); err != nil {
		return err
	}

	if !o.NoStructuredReplies {
		replies, err := c.option(optStructuredRepl, nil)
		if err != nil {
			return err
		}
		if last := replies[len(replies)-1]; last.typ == repAck {
			c.structured = true
		}
	}
	if len(o.MetaContexts) > 0 && c.structured {
		var data []byte
		data = appendString32(data, o.Export)
		data = binary.BigEndian.AppendUint32(data, uint32(len(o.MetaContexts)))
		for _, q := range o.MetaContexts {
			data = appendString32(data, q)
		}
		replies, err := c.option(optSetMetaCtx, data)
		if err != nil {
			return err
		}
		for _, rep := range replies {
			if rep.typ == repMetaContext && len(rep.data) >= 4 {
				id := binary.BigEndian.Uint32(rep.data[0:4])
				c.contexts[string(rep.data[4:])] = id
			}
		}
	}

	var data []byte
	data = appendString32(data, o.Export)
	data = binary.BigEndian.AppendUint16(data, 1)
	data = binary.BigEndian.AppendUint16(data, infoBlockSize)
	replies, err := c.option(optGo, data)
	if err != nil {
		return err
	}
	gotExport := false
	for _, rep := range replies {
		if rep.typ != repInfo || len(rep.data) < 2 {
			continue
		}
		switch binary.BigEndian.Uint16(rep.data[0:2]) {
		case infoExport:
			if len(rep.data) < 12 {
				return errors.New("nbd: short NBD_INFO_EXPORT")
			}
			c.size = binary.BigEndian.Uint64(rep.data[2:10])
			c.flags = binary.BigEndian.Uint16(rep.data[10:12])
			gotExport = true
		case infoBlockSize:
			if len(rep.data) >= 14 {
				c.minBlock = binary.BigEndian.Uint32(rep.data[2:6])
			}
		}
	}
	if !gotExport {
		return errors.New("nbd: server sent no export information")
	}
	return nil
}

type optReply struct {
	typ  uint32
	data []byte
}

// option sends one option and collects replies up to the final one (ACK or an
// error). An error reply is returned as *OptionError, except for structured
// replies, where ERR_UNSUP just means "not available".
func (c *Client) option(opt uint32, data []byte) ([]optReply, error) {
	var hdr [16]byte
	binary.BigEndian.PutUint64(hdr[0:8], magicOpt)
	binary.BigEndian.PutUint32(hdr[8:12], opt)
	binary.BigEndian.PutUint32(hdr[12:16], uint32(len(data)))
	if _, err := c.w.Write(hdr[:]); err != nil {
		return nil, err
	}
	if _, err := c.w.Write(data); err != nil {
		return nil, err
	}
	if err := c.w.Flush(); err != nil {
		return nil, err
	}
	var out []optReply
	for {
		var rh [20]byte
		if _, err := io.ReadFull(c.r, rh[:]); err != nil {
			return nil, fmt.Errorf("nbd: read option reply: %w", err)
		}
		if binary.BigEndian.Uint64(rh[0:8]) != magicOptReply {
			return nil, errors.New("nbd: bad option reply magic")
		}
		if got := binary.BigEndian.Uint32(rh[8:12]); got != opt {
			return nil, fmt.Errorf("nbd: reply for option %d while waiting for %d", got, opt)
		}
		typ := binary.BigEndian.Uint32(rh[12:16])
		n := binary.BigEndian.Uint32(rh[16:20])
		if n > 1<<20 {
			return nil, errors.New("nbd: option reply too large")
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			return nil, err
		}
		out = append(out, optReply{typ: typ, data: payload})
		if typ&repErrBit != 0 {
			if opt == optStructuredRepl && typ == repErrUnsup {
				return out, nil
			}
			if opt == optSetMetaCtx && typ == repErrUnsup {
				return out, nil
			}
			return nil, &OptionError{Option: opt, Reply: typ, Message: string(payload)}
		}
		if typ == repAck {
			return out, nil
		}
	}
}

func appendString32(b []byte, s string) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(len(s)))
	return append(b, s...)
}

func (c *Client) usable() error {
	if c.closed {
		return errors.New("nbd: connection closed")
	}
	if c.broken != nil {
		return fmt.Errorf("nbd: connection unusable after an earlier failure: %w", c.broken)
	}
	return nil
}

// fail marks the connection unusable after a protocol or transport error: the
// reply stream can no longer be trusted to be in step with the requests.
func (c *Client) fail(err error) error {
	if c.broken == nil {
		c.broken = err
	}
	return err
}

func (c *Client) send(cmd, flags uint16, offset uint64, length uint32) (uint64, error) {
	c.cookie++
	var req [28]byte
	binary.BigEndian.PutUint32(req[0:4], magicRequest)
	binary.BigEndian.PutUint16(req[4:6], flags)
	binary.BigEndian.PutUint16(req[6:8], cmd)
	binary.BigEndian.PutUint64(req[8:16], c.cookie)
	binary.BigEndian.PutUint64(req[16:24], offset)
	binary.BigEndian.PutUint32(req[24:28], length)
	if _, err := c.w.Write(req[:]); err != nil {
		return 0, c.fail(err)
	}
	if err := c.w.Flush(); err != nil {
		return 0, c.fail(err)
	}
	return c.cookie, nil
}

func (c *Client) checkRange(offset uint64, length uint64) error {
	if length == 0 {
		return errors.New("nbd: zero-length request")
	}
	if offset+length < offset || offset+length > c.size {
		return fmt.Errorf("nbd: request %d+%d beyond the export size %d", offset, length, c.size)
	}
	return nil
}

// ReadAt fills p from the export at offset. Holes read as zeroes. Requests
// larger than MaxRequest are split.
func (c *Client) ReadAt(p []byte, offset uint64) error {
	for len(p) > 0 {
		n := len(p)
		if n > MaxRequest {
			n = MaxRequest
		}
		if err := c.readOnce(p[:n], offset); err != nil {
			return err
		}
		p = p[n:]
		offset += uint64(n)
	}
	return nil
}

func (c *Client) readOnce(p []byte, offset uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.usable(); err != nil {
		return err
	}
	if err := c.checkRange(offset, uint64(len(p))); err != nil {
		return err
	}
	cookie, err := c.send(cmdRead, 0, offset, uint32(len(p)))
	if err != nil {
		return err
	}
	var cmdErr error
	covered := uint64(0)
	simple, err := c.replies(cookie, func(typ uint16, payload []byte) error {
		switch typ {
		case chunkOffsetData:
			if len(payload) < 8 {
				return errors.New("nbd: short OFFSET_DATA chunk")
			}
			at := binary.BigEndian.Uint64(payload[0:8])
			data := payload[8:]
			if at < offset || at+uint64(len(data)) > offset+uint64(len(p)) {
				return errors.New("nbd: OFFSET_DATA outside the request")
			}
			copy(p[at-offset:], data)
			covered += uint64(len(data))
		case chunkOffsetHole:
			if len(payload) != 12 {
				return errors.New("nbd: bad OFFSET_HOLE chunk")
			}
			at := binary.BigEndian.Uint64(payload[0:8])
			n := uint64(binary.BigEndian.Uint32(payload[8:12]))
			if at < offset || at+n > offset+uint64(len(p)) {
				return errors.New("nbd: OFFSET_HOLE outside the request")
			}
			clear(p[at-offset : at-offset+n])
			covered += n
		default:
			return fmt.Errorf("nbd: unexpected chunk type %d in a read reply", typ)
		}
		return nil
	}, p, &cmdErr)
	if err != nil {
		return c.fail(err)
	}
	if cmdErr != nil {
		return cmdErr
	}
	if !simple && covered != uint64(len(p)) {
		return c.fail(fmt.Errorf("nbd: read reply covered %d of %d bytes", covered, len(p)))
	}
	return nil
}

// replies reads the reply (simple or a sequence of structured chunks) for
// cookie. For a simple reply to a read, the data goes into simpleData. A
// command error is stored in cmdErr (the connection stays usable); a
// protocol error is returned.
func (c *Client) replies(cookie uint64, chunk func(typ uint16, payload []byte) error, simpleData []byte, cmdErr *error) (simple bool, err error) {
	for {
		var magic [4]byte
		if _, err := io.ReadFull(c.r, magic[:]); err != nil {
			return false, fmt.Errorf("nbd: read reply: %w", err)
		}
		switch binary.BigEndian.Uint32(magic[:]) {
		case magicSimpleReply:
			var rest [12]byte
			if _, err := io.ReadFull(c.r, rest[:]); err != nil {
				return false, err
			}
			errno := binary.BigEndian.Uint32(rest[0:4])
			if got := binary.BigEndian.Uint64(rest[4:12]); got != cookie {
				return false, fmt.Errorf("nbd: reply for cookie %d while waiting for %d", got, cookie)
			}
			if errno != 0 {
				*cmdErr = &ErrorReply{Errno: errno}
				return true, nil
			}
			if simpleData != nil {
				if _, err := io.ReadFull(c.r, simpleData); err != nil {
					return false, err
				}
			}
			return true, nil
		case magicStructReply:
			var rest [16]byte
			if _, err := io.ReadFull(c.r, rest[:]); err != nil {
				return false, err
			}
			flags := binary.BigEndian.Uint16(rest[0:2])
			typ := binary.BigEndian.Uint16(rest[2:4])
			if got := binary.BigEndian.Uint64(rest[4:12]); got != cookie {
				return false, fmt.Errorf("nbd: reply for cookie %d while waiting for %d", got, cookie)
			}
			n := binary.BigEndian.Uint32(rest[12:16])
			if n > maxStructuredChunk+64 {
				return false, errors.New("nbd: reply chunk too large")
			}
			payload := make([]byte, n)
			if _, err := io.ReadFull(c.r, payload); err != nil {
				return false, err
			}
			switch {
			case typ&chunkErrorBit != 0:
				if len(payload) < 6 {
					return false, errors.New("nbd: short error chunk")
				}
				errno := binary.BigEndian.Uint32(payload[0:4])
				ml := int(binary.BigEndian.Uint16(payload[4:6]))
				msg := ""
				if 6+ml <= len(payload) {
					msg = string(payload[6 : 6+ml])
				}
				if *cmdErr == nil {
					*cmdErr = &ErrorReply{Errno: errno, Message: msg}
				}
			case typ == chunkNone:
			default:
				if *cmdErr == nil {
					if err := chunk(typ, payload); err != nil {
						return false, err
					}
				}
			}
			if flags&replyFlagDone != 0 {
				return false, nil
			}
		default:
			return false, errors.New("nbd: bad reply magic")
		}
	}
}

// BlockStatus queries the extents of a meta context for [offset, offset+length).
// The answer may cover less than asked for (servers may stop early); callers
// continue from the end of the last extent. length is capped at 2 GiB.
func (c *Client) BlockStatus(contextID uint32, offset, length uint64) ([]Extent, error) {
	if length > 1<<31 {
		length = 1 << 31
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.usable(); err != nil {
		return nil, err
	}
	if !c.structured {
		return nil, errors.New("nbd: block status needs structured replies")
	}
	if err := c.checkRange(offset, length); err != nil {
		return nil, err
	}
	cookie, err := c.send(cmdBlockStatus, 0, offset, uint32(length))
	if err != nil {
		return nil, err
	}
	var extents []Extent
	var cmdErr error
	_, err = c.replies(cookie, func(typ uint16, payload []byte) error {
		if typ != chunkBlockStatus {
			return fmt.Errorf("nbd: unexpected chunk type %d in a block status reply", typ)
		}
		if len(payload) < 4 || (len(payload)-4)%8 != 0 {
			return errors.New("nbd: malformed block status chunk")
		}
		if binary.BigEndian.Uint32(payload[0:4]) != contextID {
			return nil // another context
		}
		at := offset
		for i := 4; i < len(payload); i += 8 {
			n := uint64(binary.BigEndian.Uint32(payload[i : i+4]))
			f := binary.BigEndian.Uint32(payload[i+4 : i+8])
			if n == 0 {
				return errors.New("nbd: zero-length extent")
			}
			if at+n > c.size {
				n = c.size - at
			}
			extents = append(extents, Extent{Offset: at, Length: n, Flags: f})
			at += n
			if at >= c.size {
				break
			}
		}
		return nil
	}, nil, &cmdErr)
	if err != nil {
		return nil, c.fail(err)
	}
	if cmdErr != nil {
		return nil, cmdErr
	}
	if len(extents) == 0 {
		return nil, c.fail(errors.New("nbd: block status reply without extents"))
	}
	return extents, nil
}

// Extents walks the whole range with BlockStatus and returns contiguous,
// merged extents covering [offset, offset+length).
func (c *Client) Extents(contextID uint32, offset, length uint64) ([]Extent, error) {
	end := offset + length
	var out []Extent
	for at := offset; at < end; {
		ext, err := c.BlockStatus(contextID, at, end-at)
		if err != nil {
			return nil, err
		}
		for _, e := range ext {
			if e.Offset >= end {
				break
			}
			if e.Offset+e.Length > end {
				e.Length = end - e.Offset
			}
			if n := len(out); n > 0 && out[n-1].Flags == e.Flags && out[n-1].Offset+out[n-1].Length == e.Offset {
				out[n-1].Length += e.Length
			} else {
				out = append(out, e)
			}
			at = e.Offset + e.Length
		}
	}
	return out, nil
}

// Trim discards a range (frees fleecing space on the PVE side). length is
// split into requests of at most 1 GiB.
func (c *Client) Trim(offset, length uint64) error {
	for length > 0 {
		n := length
		if n > 1<<30 {
			n = 1 << 30
		}
		if err := c.trimOnce(offset, n); err != nil {
			return err
		}
		offset += n
		length -= n
	}
	return nil
}

func (c *Client) trimOnce(offset, length uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.usable(); err != nil {
		return err
	}
	if err := c.checkRange(offset, length); err != nil {
		return err
	}
	cookie, err := c.send(cmdTrim, 0, offset, uint32(length))
	if err != nil {
		return err
	}
	var cmdErr error
	if _, err := c.replies(cookie, func(uint16, []byte) error { return nil }, nil, &cmdErr); err != nil {
		return c.fail(err)
	}
	return cmdErr
}

// Close sends NBD_CMD_DISC and closes the connection.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	if c.broken == nil {
		_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := c.send(cmdDisc, 0, 0, 0); err == nil {
			_ = c.w.Flush()
		}
	}
	return c.conn.Close()
}
