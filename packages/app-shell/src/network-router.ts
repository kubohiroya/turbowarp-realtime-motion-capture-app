/**
 * Sorts the WebRTC receive queue so a stream of pose frames cannot bury the control messages.
 *
 * Every message a peer sends — pairing tests, calibration requests and replies, and the pose frames
 * a camera sends many times a second — arrives in one queue in the WebRTC extension. An SB3 script
 * can take one message per frame, which is fewer than one camera sends, so the queue would grow and
 * the control messages behind the frames would arrive late or never.
 *
 * The router drains the whole queue in one call. A `latest-data` envelope only ever replaces the
 * previous one for its peer and channel — an older pose is worthless once a newer one exists — and
 * every other message keeps its place in a queue the application's dispatcher reads.
 */

export interface WebRtcQueuePort {
  messageCount(): number;
  nextMessage(): string;
}

export interface NetworkRouterHost {
  /** The WebRTC extension instance, or null while it is not loaded. */
  webrtc(): WebRtcQueuePort | null;
  nowMs(): number;
}

interface LatestEntry {
  payload: string;
  count: number;
  receivedAtMs: number;
}

/** A single call never spends a frame draining an unbounded queue. */
const MAXIMUM_DRAIN_PER_CALL = 1000;
/**
 * Control messages are rare. A backlog this long means nothing is reading them, and dropping the
 * oldest keeps memory bounded while the drop count keeps the loss visible.
 */
const MAXIMUM_QUEUED_MESSAGES = 200;

const LATEST_DATA_TYPE = 'latest-data';

export class NetworkRouter {
  private readonly host: NetworkRouterHost;
  private readonly queue: string[] = [];
  private readonly latest = new Map<string, Map<string, LatestEntry>>();
  private dropped = 0;

  public constructor(host: NetworkRouterHost) {
    this.host = host;
  }

  /** Drains the WebRTC queue. Returns how many messages were taken. */
  public pump(): number {
    const webrtc = this.host.webrtc();
    if (webrtc === null) return 0;
    let taken = 0;
    while (taken < MAXIMUM_DRAIN_PER_CALL && webrtc.messageCount() > 0) {
      const text = webrtc.nextMessage();
      taken += 1;
      if (text === '') continue;
      this.route(text);
    }
    return taken;
  }

  public queuedCount(): number {
    return this.queue.length;
  }

  public next(): string {
    return this.queue.shift() ?? '';
  }

  public droppedCount(): number {
    return this.dropped;
  }

  public latestPayload(channel: string, peer: string): string {
    return this.latest.get(channel)?.get(peer)?.payload ?? '';
  }

  public latestCount(channel: string, peer: string): number {
    return this.latest.get(channel)?.get(peer)?.count ?? 0;
  }

  /** Milliseconds since the latest payload arrived, or -1 when none has. */
  public latestAgeMs(channel: string, peer: string): number {
    const entry = this.latest.get(channel)?.get(peer);
    return entry === undefined ? -1 : Math.max(0, Math.round(this.host.nowMs() - entry.receivedAtMs));
  }

  /** The peers that have sent on a channel, sorted so a script can walk them in a stable order. */
  public latestPeers(channel: string): string[] {
    return [...(this.latest.get(channel)?.keys() ?? [])].sort();
  }

  public clear(): void {
    this.queue.length = 0;
    this.latest.clear();
    this.dropped = 0;
  }

  private route(text: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      this.enqueue(text);
      return;
    }
    if (typeof envelope === 'object' && envelope !== null) {
      const record = envelope as Record<string, unknown>;
      if (record['type'] === LATEST_DATA_TYPE && typeof record['peer'] === 'string') {
        const channel = typeof record['channel'] === 'string' ? record['channel'] : 'default';
        const peers = this.latest.get(channel) ?? new Map<string, LatestEntry>();
        this.latest.set(channel, peers);
        const previous = peers.get(record['peer']);
        peers.set(record['peer'], {
          payload: JSON.stringify(record['payload'] ?? null),
          count: (previous?.count ?? 0) + 1,
          receivedAtMs: this.host.nowMs()
        });
        return;
      }
    }
    this.enqueue(text);
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    while (this.queue.length > MAXIMUM_QUEUED_MESSAGES) {
      this.queue.shift();
      this.dropped += 1;
    }
  }
}

/**
 * Reaches the WebRTC extension's receive queue through its own blocks.
 *
 * The extension's published runtime capability covers pairing and sending but not the receive queue,
 * and it does not register its instance under `ext_kubohiroyawebrtc`. What every loading path does
 * have is its block implementations: `kubohiroyawebrtc_messageCount` when loaded on its own, and
 * `<bundle>_kubohiroyawebrtc__messageCount` inside a static bundle. They are looked up by that
 * suffix, so the same shell works in both.
 *
 * `_primitives` is the VM's table of block implementations, not a published API. A receive queue on
 * the capability would remove this lookup; until then it is confined to this one function.
 */
export function createScratchNetworkRouterHost(): NetworkRouterHost {
  let resolved: WebRtcQueuePort | null = null;
  return {
    webrtc() {
      if (resolved !== null) return resolved;
      const primitives = Scratch.vm?.runtime?.['_primitives'];
      if (typeof primitives !== 'object' || primitives === null) return null;
      const table = primitives as Record<string, unknown>;
      const find = (opcode: string) => {
        const pattern = new RegExp(`(^|_)kubohiroyawebrtc_+${opcode}$`);
        const key = Object.keys(table).find((candidate) => pattern.test(candidate));
        const implementation = key === undefined ? undefined : table[key];
        return typeof implementation === 'function'
          ? (implementation as (args: Record<string, unknown>) => unknown)
          : undefined;
      };
      const messageCount = find('messageCount');
      const nextMessage = find('nextMessage');
      if (messageCount === undefined || nextMessage === undefined) return null;
      resolved = {
        messageCount: () => Number(messageCount({})) || 0,
        nextMessage: () => String(nextMessage({}) ?? '')
      };
      return resolved;
    },
    nowMs: () => (typeof performance === 'undefined' ? Date.now() : performance.now())
  };
}
