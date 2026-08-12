// Room registry and quotas (RFC 001 §9).
//
// State is in memory only: room -> set of connections. There is no database, and
// no Yjs document — the relay cannot build one, because it only ever sees
// ciphertext.
//
// The quotas are load-bearing rather than hardening. An authenticated WebSocket
// fan-out service is a general-purpose message bus, and it will be found and
// used as one. Every limit below refuses with a named reason instead of dropping
// silently, so an honest client can tell a quota from a bug.

export const LIMITS = {
  peersPerRoom: 8,

  // The first sync frame a peer sends carries the *entire* document, so this
  // scales with project size, not with edit size. 1 MiB looked generous and was
  // not: a 115-file project produced a frame well past it, the relay closed the
  // sender, it reconnected, and the two peers never finished syncing.
  //
  // Chunking the initial sync is the real fix and needs a protocol change; until
  // then this has to comfortably exceed a realistic project's text.
  maxFrameBytes: 32 * 1024 * 1024,

  framesPerSecond: 200,
  frameBurst: 1000,

  // Refill rate for sustained traffic, kept modest...
  bytesPerSecond: 4 * 1024 * 1024,
  // ...but the bucket has to be deep enough to admit one maximum-size frame, or
  // a legitimate initial sync is refused no matter how long the peer waits.
  byteBurst: 32 * 1024 * 1024,

  roomsPerUser: 20,
  connectionsPerUser: 10,
  idleRoomTtlMs: 10 * 60 * 1000,
};

export class Rooms {
  constructor(limits = LIMITS) {
    this.limits = limits;
    this.rooms = new Map(); // "owner/session" -> { owner, session, conns:Set, allow:Set|null, reaper }
    this.byUser = new Map(); // username -> Set<conn>
  }

  static id(owner, session) {
    return `${owner}/${session}`;
  }

  get(owner, session) {
    return this.rooms.get(Rooms.id(owner, session));
  }

  countRoomsOwnedBy(username) {
    let n = 0;
    for (const room of this.rooms.values()) if (room.owner === username) n++;
    return n;
  }

  connectionsFor(username) {
    return this.byUser.get(username)?.size ?? 0;
  }

  // Only the namespace owner may create a room under their own name; that makes
  // the namespace self-policing without a reservation system.
  create({ owner, session, allow }) {
    const id = Rooms.id(owner, session);
    let room = this.rooms.get(id);
    if (room) {
      if (allow) room.allow = new Set(allow);
      clearTimeout(room.reaper);
      room.reaper = null;
      return room;
    }
    room = { owner, session, conns: new Set(), allow: allow ? new Set(allow) : null, reaper: null };
    this.rooms.set(id, room);
    return room;
  }

  attach(room, conn) {
    room.conns.add(conn);
    clearTimeout(room.reaper);
    room.reaper = null;
    if (!this.byUser.has(conn.username)) this.byUser.set(conn.username, new Set());
    this.byUser.get(conn.username).add(conn);
  }

  detach(room, conn) {
    room.conns.delete(conn);
    const userConns = this.byUser.get(conn.username);
    userConns?.delete(conn);
    if (userConns && userConns.size === 0) this.byUser.delete(conn.username);

    // Rooms are ephemeral: once empty, the session is gone after a grace period.
    // Nothing is lost that git does not already hold, and the next peer to
    // connect re-seeds from its own disk.
    if (room.conns.size === 0 && !room.reaper) {
      room.reaper = setTimeout(() => {
        if (room.conns.size === 0) this.rooms.delete(Rooms.id(room.owner, room.session));
      }, this.limits.idleRoomTtlMs);
      room.reaper.unref?.();
    }
  }

  peerNames(room, except) {
    const names = new Set();
    for (const conn of room.conns) if (conn !== except) names.add(conn.username);
    return [...names];
  }

  // Metadata only. Deliberately no file names, no counts of files, nothing
  // derived from frame payloads — the relay cannot see them, and a dashboard
  // must not imply otherwise.
  snapshot(forUsername) {
    const out = [];
    for (const room of this.rooms.values()) {
      const peers = [...room.conns];
      const involved = room.owner === forUsername || peers.some((c) => c.username === forUsername);
      if (!involved) continue;
      out.push({
        id: Rooms.id(room.owner, room.session),
        owner: room.owner,
        session: room.session,
        allow: room.allow ? [...room.allow] : null,
        peerCount: peers.length,
        peers: peers.map((c) => ({
          username: c.username,
          joinedAt: c.joinedAt,
          bytesIn: c.bytesIn,
          bytesOut: c.bytesOut,
          frames: c.frames,
          lastActiveAt: c.lastActiveAt,
        })),
      });
    }
    return out.sort((a, b) => b.peerCount - a.peerCount || a.id.localeCompare(b.id));
  }
}

// Token bucket, refilled continuously. Separate buckets for frame count and byte
// volume, because a client can abuse either dimension independently.
export class RateLimiter {
  constructor(limits = LIMITS) {
    this.limits = limits;
    this.byteCapacity = limits.byteBurst ?? limits.bytesPerSecond;
    this.frames = limits.frameBurst;
    this.bytes = this.byteCapacity;
    this.last = Date.now();
  }

  // Returns null if allowed, or the name of the limit that was hit.
  check(frameBytes) {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.frames = Math.min(
      this.limits.frameBurst,
      this.frames + elapsed * this.limits.framesPerSecond,
    );
    this.bytes = Math.min(this.byteCapacity, this.bytes + elapsed * this.limits.bytesPerSecond);
    if (frameBytes > this.limits.maxFrameBytes) return 'maxFrameBytes';
    if (this.frames < 1) return 'framesPerSecond';
    if (this.bytes < frameBytes) return 'bytesPerSecond';
    this.frames -= 1;
    this.bytes -= frameBytes;
    return null;
  }
}
