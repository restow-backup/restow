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
)

// ContextFunc answers a block status query of one meta context for
// [offset, offset+length). The extents must start at offset, be contiguous
// and may cover less than asked for.
type ContextFunc func(offset, length uint64) ([]Extent, error)

// Export is what a Server serves under one name.
type Export struct {
	Size   uint64
	Reader io.ReaderAt
	// Contexts are the meta contexts besides base:allocation (tests use it for
	// a dirty bitmap). Allocation answers base:allocation; nil reports
	// everything as data.
	Contexts   map[string]ContextFunc
	Allocation ContextFunc
	// Trim makes the export accept NBD_CMD_TRIM (and not read-only); writes
	// are refused either way.
	Trim func(offset, length uint64) error
}

// Server is a read-only NBD server (fixed newstyle, structured replies).
type Server struct {
	// Lookup returns the export of a name.
	Lookup func(name string) (*Export, bool)
	// Logf receives one line per connection error (optional).
	Logf func(format string, args ...any)

	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

// Serve accepts connections until the listener is closed.
func (s *Server) Serve(l net.Listener) error {
	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		s.track(conn, true)
		go func() {
			defer s.track(conn, false)
			defer conn.Close()
			if err := s.ServeConn(context.Background(), conn); err != nil && s.Logf != nil {
				s.Logf("nbd: connection ended: %v", err)
			}
		}()
	}
}

func (s *Server) track(c net.Conn, add bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conns == nil {
		s.conns = map[net.Conn]struct{}{}
	}
	if add {
		s.conns[c] = struct{}{}
	} else {
		delete(s.conns, c)
	}
}

// CloseConnections closes every open connection (shutdown).
func (s *Server) CloseConnections() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		_ = c.Close()
	}
}

type serverConn struct {
	s          *Server
	r          *bufio.Reader
	w          *bufio.Writer
	noZeroes   bool
	structured bool
	export     *Export
	// selected meta contexts: id -> name (id = index+1)
	selected map[uint32]string
}

// ServeConn runs one connection to its end.
func (s *Server) ServeConn(ctx context.Context, conn net.Conn) error {
	sc := &serverConn{
		s: s,
		r: bufio.NewReaderSize(conn, 64<<10),
		w: bufio.NewWriterSize(conn, 256<<10),
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if err := sc.negotiate(); err != nil {
		if errors.Is(err, errAbort) {
			return nil
		}
		return err
	}
	return sc.transmit()
}

var errAbort = errors.New("client aborted")

func (sc *serverConn) negotiate() error {
	var greet [18]byte
	binary.BigEndian.PutUint64(greet[0:8], magicInit)
	binary.BigEndian.PutUint64(greet[8:16], magicOpt)
	binary.BigEndian.PutUint16(greet[16:18], flagFixedNewstyle|flagNoZeroes)
	if _, err := sc.w.Write(greet[:]); err != nil {
		return err
	}
	if err := sc.w.Flush(); err != nil {
		return err
	}
	var cf [4]byte
	if _, err := io.ReadFull(sc.r, cf[:]); err != nil {
		return err
	}
	flags := binary.BigEndian.Uint32(cf[:])
	if flags&clientFlagFixed == 0 {
		return errors.New("client does not use fixed newstyle")
	}
	sc.noZeroes = flags&clientFlagNoZero != 0
	for {
		var hdr [16]byte
		if _, err := io.ReadFull(sc.r, hdr[:]); err != nil {
			return err
		}
		if binary.BigEndian.Uint64(hdr[0:8]) != magicOpt {
			return errors.New("bad option magic")
		}
		opt := binary.BigEndian.Uint32(hdr[8:12])
		n := binary.BigEndian.Uint32(hdr[12:16])
		if n > 64<<10 {
			return errors.New("option data too large")
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(sc.r, data); err != nil {
			return err
		}
		done, err := sc.handleOption(opt, data)
		if err != nil {
			return err
		}
		if done {
			return sc.w.Flush()
		}
		if err := sc.w.Flush(); err != nil {
			return err
		}
	}
}

func (sc *serverConn) reply(opt, typ uint32, data []byte) error {
	var hdr [20]byte
	binary.BigEndian.PutUint64(hdr[0:8], magicOptReply)
	binary.BigEndian.PutUint32(hdr[8:12], opt)
	binary.BigEndian.PutUint32(hdr[12:16], typ)
	binary.BigEndian.PutUint32(hdr[16:20], uint32(len(data)))
	if _, err := sc.w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := sc.w.Write(data)
	return err
}

func (sc *serverConn) exportFlags(e *Export) uint16 {
	f := FlagHasFlags | FlagSendFlush
	if e.Trim != nil {
		f |= FlagSendTrim
	} else {
		f |= FlagReadOnly
	}
	return f
}

func readString32(data []byte) (string, []byte, bool) {
	if len(data) < 4 {
		return "", nil, false
	}
	n := binary.BigEndian.Uint32(data[0:4])
	if n > maxNameBytes || uint32(len(data)-4) < n {
		return "", nil, false
	}
	return string(data[4 : 4+n]), data[4+n:], true
}

func (sc *serverConn) handleOption(opt uint32, data []byte) (bool, error) {
	switch opt {
	case optAbort:
		_ = sc.reply(opt, repAck, nil)
		_ = sc.w.Flush()
		return false, errAbort
	case optExportName:
		e, ok := sc.s.Lookup(string(data))
		if !ok {
			return false, fmt.Errorf("unknown export %q", string(data))
		}
		sc.export = e
		var b []byte
		b = binary.BigEndian.AppendUint64(b, e.Size)
		b = binary.BigEndian.AppendUint16(b, sc.exportFlags(e))
		if !sc.noZeroes {
			b = append(b, make([]byte, 124)...)
		}
		_, err := sc.w.Write(b)
		return true, err
	case optStructuredRepl:
		if len(data) != 0 {
			return false, sc.reply(opt, repErrInvalid, []byte("no data expected"))
		}
		sc.structured = true
		return false, sc.reply(opt, repAck, nil)
	case optListMetaCtx, optSetMetaCtx:
		if !sc.structured {
			return false, sc.reply(opt, repErrInvalid, []byte("structured replies first"))
		}
		name, rest, ok := readString32(data)
		if !ok || len(rest) < 4 {
			return false, sc.reply(opt, repErrInvalid, []byte("malformed request"))
		}
		e, found := sc.s.Lookup(name)
		if !found {
			return false, sc.reply(opt, repErrUnknown, []byte("unknown export"))
		}
		count := binary.BigEndian.Uint32(rest[0:4])
		rest = rest[4:]
		var queries []string
		for i := uint32(0); i < count; i++ {
			var q string
			q, rest, ok = readString32(rest)
			if !ok {
				return false, sc.reply(opt, repErrInvalid, []byte("malformed query"))
			}
			queries = append(queries, q)
		}
		available := append([]string{ContextBaseAllocation}, sortedKeys(e.Contexts)...)
		if opt == optSetMetaCtx {
			sc.selected = map[uint32]string{}
		}
		for i, ctxName := range available {
			match := opt == optListMetaCtx && len(queries) == 0
			for _, q := range queries {
				if q == ctxName {
					match = true
				}
			}
			if !match {
				continue
			}
			id := uint32(i + 1)
			if opt == optSetMetaCtx {
				sc.selected[id] = ctxName
			}
			b := binary.BigEndian.AppendUint32(nil, id)
			if err := sc.reply(opt, repMetaContext, append(b, ctxName...)); err != nil {
				return false, err
			}
		}
		return false, sc.reply(opt, repAck, nil)
	case optInfo, optGo:
		name, rest, ok := readString32(data)
		if !ok || len(rest) < 2 {
			return false, sc.reply(opt, repErrInvalid, []byte("malformed request"))
		}
		e, found := sc.s.Lookup(name)
		if !found {
			return false, sc.reply(opt, repErrUnknown, []byte("unknown export"))
		}
		var info []byte
		info = binary.BigEndian.AppendUint16(info, infoExport)
		info = binary.BigEndian.AppendUint64(info, e.Size)
		info = binary.BigEndian.AppendUint16(info, sc.exportFlags(e))
		if err := sc.reply(opt, repInfo, info); err != nil {
			return false, err
		}
		var bs []byte
		bs = binary.BigEndian.AppendUint16(bs, infoBlockSize)
		bs = binary.BigEndian.AppendUint32(bs, 1)
		bs = binary.BigEndian.AppendUint32(bs, 4096)
		bs = binary.BigEndian.AppendUint32(bs, MaxRequest)
		if err := sc.reply(opt, repInfo, bs); err != nil {
			return false, err
		}
		if err := sc.reply(opt, repAck, nil); err != nil {
			return false, err
		}
		if opt == optGo {
			sc.export = e
			return true, nil
		}
		return false, nil
	case optList:
		return false, sc.reply(opt, repErrPolicy, []byte("export listing is not offered"))
	}
	return false, sc.reply(opt, repErrUnsup, []byte("option not supported"))
}

func sortedKeys(m map[string]ContextFunc) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

func (sc *serverConn) simpleReply(cookie uint64, errno uint32, data []byte) error {
	var hdr [16]byte
	binary.BigEndian.PutUint32(hdr[0:4], magicSimpleReply)
	binary.BigEndian.PutUint32(hdr[4:8], errno)
	binary.BigEndian.PutUint64(hdr[8:16], cookie)
	if _, err := sc.w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := sc.w.Write(data)
	return err
}

func (sc *serverConn) chunk(cookie uint64, flags, typ uint16, payload ...[]byte) error {
	n := 0
	for _, p := range payload {
		n += len(p)
	}
	var hdr [20]byte
	binary.BigEndian.PutUint32(hdr[0:4], magicStructReply)
	binary.BigEndian.PutUint16(hdr[4:6], flags)
	binary.BigEndian.PutUint16(hdr[6:8], typ)
	binary.BigEndian.PutUint64(hdr[8:16], cookie)
	binary.BigEndian.PutUint32(hdr[16:20], uint32(n))
	if _, err := sc.w.Write(hdr[:]); err != nil {
		return err
	}
	for _, p := range payload {
		if _, err := sc.w.Write(p); err != nil {
			return err
		}
	}
	return nil
}

func (sc *serverConn) fail(cookie uint64, errno uint32, msg string) error {
	if !sc.structured {
		return sc.simpleReply(cookie, errno, nil)
	}
	var p []byte
	p = binary.BigEndian.AppendUint32(p, errno)
	if len(msg) > 4096 {
		msg = msg[:4096]
	}
	p = binary.BigEndian.AppendUint16(p, uint16(len(msg)))
	p = append(p, msg...)
	return sc.chunk(cookie, replyFlagDone, chunkError, p)
}

func (sc *serverConn) transmit() error {
	e := sc.export
	buf := make([]byte, 0, 4<<20)
	for {
		var req [28]byte
		if _, err := io.ReadFull(sc.r, req[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if binary.BigEndian.Uint32(req[0:4]) != magicRequest {
			return errors.New("bad request magic")
		}
		flags := binary.BigEndian.Uint16(req[4:6])
		cmd := binary.BigEndian.Uint16(req[6:8])
		cookie := binary.BigEndian.Uint64(req[8:16])
		offset := binary.BigEndian.Uint64(req[16:24])
		length := uint64(binary.BigEndian.Uint32(req[24:28]))
		inRange := length > 0 && offset+length >= offset && offset+length <= e.Size

		var err error
		switch cmd {
		case cmdDisc:
			return sc.w.Flush()
		case cmdRead:
			switch {
			case !inRange:
				err = sc.fail(cookie, errInval, "read beyond the end of the export")
			case length > MaxRequest:
				err = sc.fail(cookie, errOverflow, "read too large")
			default:
				if cap(buf) < int(length) {
					buf = make([]byte, length)
				}
				p := buf[:length]
				if _, rerr := e.Reader.ReadAt(p, int64(offset)); rerr != nil && !(errors.Is(rerr, io.EOF)) {
					err = sc.fail(cookie, errIO, rerr.Error())
				} else if sc.structured {
					err = sc.chunk(cookie, replyFlagDone, chunkOffsetData, binary.BigEndian.AppendUint64(nil, offset), p)
				} else {
					err = sc.simpleReply(cookie, 0, p)
				}
			}
		case cmdWrite:
			if _, derr := io.CopyN(io.Discard, sc.r, int64(length)); derr != nil {
				return derr
			}
			err = sc.fail(cookie, errPerm, "export is read-only")
		case cmdFlush:
			err = sc.simpleReply(cookie, 0, nil)
		case cmdTrim:
			switch {
			case e.Trim == nil:
				err = sc.fail(cookie, errPerm, "export is read-only")
			case !inRange:
				err = sc.fail(cookie, errInval, "trim beyond the end of the export")
			default:
				if terr := e.Trim(offset, length); terr != nil {
					err = sc.fail(cookie, errIO, terr.Error())
				} else {
					err = sc.simpleReply(cookie, 0, nil)
				}
			}
		case cmdBlockStatus:
			if !sc.structured || len(sc.selected) == 0 {
				err = sc.fail(cookie, errInval, "no meta context selected")
				break
			}
			if !inRange {
				err = sc.fail(cookie, errInval, "block status beyond the end of the export")
				break
			}
			err = sc.blockStatus(cookie, flags, offset, length)
		default:
			err = sc.fail(cookie, errInval, "command not supported")
		}
		if err != nil {
			return err
		}
		if sc.r.Buffered() == 0 {
			if err := sc.w.Flush(); err != nil {
				return err
			}
		}
	}
}

func (sc *serverConn) blockStatus(cookie uint64, flags uint16, offset, length uint64) error {
	ids := make([]uint32, 0, len(sc.selected))
	for id := range sc.selected {
		ids = append(ids, id)
	}
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && ids[j] < ids[j-1]; j-- {
			ids[j], ids[j-1] = ids[j-1], ids[j]
		}
	}
	for i, id := range ids {
		name := sc.selected[id]
		fn := sc.export.Contexts[name]
		if name == ContextBaseAllocation {
			fn = sc.export.Allocation
		}
		var extents []Extent
		if fn == nil {
			extents = []Extent{{Offset: offset, Length: length}}
		} else {
			var err error
			extents, err = fn(offset, length)
			if err != nil {
				return sc.fail(cookie, errIO, err.Error())
			}
		}
		if flags&cmdFlagReqOne != 0 && len(extents) > 1 {
			extents = extents[:1]
		}
		p := binary.BigEndian.AppendUint32(nil, id)
		for _, ex := range extents {
			n := ex.Length
			for n > 0 {
				part := n
				if part > 1<<31 {
					part = 1 << 31
				}
				p = binary.BigEndian.AppendUint32(p, uint32(part))
				p = binary.BigEndian.AppendUint32(p, ex.Flags)
				n -= part
			}
		}
		var f uint16
		if i == len(ids)-1 {
			f = replyFlagDone
		}
		if err := sc.chunk(cookie, f, chunkBlockStatus, p); err != nil {
			return err
		}
	}
	return nil
}
