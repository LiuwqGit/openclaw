// Realtime telephony audio pacing for mulaw streams.

const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
// The lead absorbs event-loop timer lateness and network jitter in the telephony edge buffer.
// Barge-in clear flushes both queues, so this cushion does not add interruption latency.
const LEAD_MS = 160;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const QUEUE_COMPACT_HEAD_THRESHOLD = 256;
const MAX_PLAYBACK_SEGMENTS = 128;
const MAX_PENDING_MARK_BOUNDARIES = 64;

/** Queue item sent over the realtime provider media stream. */
type RealtimeAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      segment: RealtimePlaybackSegment;
      type: "audio";
    }
  | {
      name: string;
      type: "mark";
    };

/** Retained playout accounting for one run of same-item provider audio. */
type RealtimePlaybackSegment = {
  itemId?: string;
  totalMs: number;
  sentMs: number;
  /** Cumulative send position of the segment's last sent frame. */
  lastSentEndMs?: number;
};

/** Send-time snapshot binding a carrier mark to the playback prefix before it. */
type RealtimeMarkBoundary = {
  name: string;
  sentMs: number;
};

/** Carrier edge buffer still ahead of playout when the paced queue drained. */
type RealtimeDrainedLead = {
  atMs: number;
  bufferedMs: number;
};

/** WebSocket send callback for realtime audio frames. */
type RealtimeAudioSend = (message: string) => boolean;

/** Provider-specific serializer for media, clear, and mark frames. */
interface RealtimeAudioSerializer {
  media(payloadBase64: string): string;
  clear(): string;
  mark(name: string): string;
}

/** Paces outgoing mulaw audio frames at telephony cadence. */
export class RealtimeAudioPacer {
  private queue: RealtimeAudioQueueItem[] = [];
  private queueHead = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;
  private streamClockMs: number | null = null;
  private playbackSegments: RealtimePlaybackSegment[] = [];
  private sentAudioMs = 0;
  private evictedSentMs = 0;
  private confirmedPlayedMs = 0;
  private drainedLead: RealtimeDrainedLead | null = null;
  private markBoundaries: RealtimeMarkBoundary[] = [];

  constructor(
    private readonly params: {
      maxQueuedAudioBytes?: number;
      onBackpressure?: () => void;
      send: RealtimeAudioSend;
      serializer: RealtimeAudioSerializer;
    },
  ) {}

  /** Queue mulaw audio and split it into 20ms-ish telephony chunks. */
  sendAudio(muLaw: Buffer, metadata?: { itemId?: string }): void {
    if (this.closed || muLaw.length === 0) {
      return;
    }
    const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
        this.failBackpressure();
        return;
      }
      const durationMs = chunk.length / 8;
      const segment = this.extendPlaybackSegment(metadata?.itemId, durationMs);
      this.queue.push({
        type: "audio",
        chunk,
        durationMs,
        segment,
      });
      this.queuedAudioBytes += chunk.length;
    }
    this.ensurePump();
  }

  /**
   * Retained provider items in playback order with consumed playout duration.
   * Queued audio has not reached the telephony line, so unplayed items report zero.
   */
  getPlaybackState(): { itemId: string; audioEndMs: number }[] {
    let remaining = Math.max(0, this.consumedPlayoutMs() - this.evictedSentMs);
    const items: { itemId: string; audioEndMs: number }[] = [];
    for (const segment of this.playbackSegments) {
      const consumed = Math.min(remaining, segment.sentMs);
      remaining -= consumed;
      if (segment.itemId !== undefined) {
        items.push({ itemId: segment.itemId, audioEndMs: Math.floor(consumed) });
      }
    }
    return items;
  }

  /** Queue a provider mark frame after prior audio frames. */
  sendMark(name: string): void {
    if (this.closed || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  /** Retire the playback prefix once the carrier confirms playout reached the mark. */
  acknowledgeMark(name?: string): void {
    if (this.closed || !name) {
      return;
    }
    const boundaryIndex = this.markBoundaries.findIndex((boundary) => boundary.name === name);
    if (boundaryIndex < 0) {
      return;
    }
    // Carrier marks fire in send order, so every earlier boundary retires too.
    const boundary = this.markBoundaries[boundaryIndex];
    this.markBoundaries.splice(0, boundaryIndex + 1);
    if (!boundary) {
      return;
    }
    // Retire every segment whose sent frames all landed before the mark; the
    // FIFO send order guarantees no retired segment receives more frames later.
    for (const head of this.playbackSegments) {
      if (head.lastSentEndMs === undefined || head.lastSentEndMs > boundary.sentMs) {
        break;
      }
      const retired = this.playbackSegments.shift();
      if (retired) {
        this.evictedSentMs += retired.sentMs;
      }
    }
    this.confirmedPlayedMs = Math.max(
      this.confirmedPlayedMs,
      Math.min(boundary.sentMs, this.sentAudioMs),
    );
  }

  /** Clear queued audio and notify the provider stream. */
  clearAudio(): number {
    if (this.closed) {
      return 0;
    }
    const clearedAudioBytes = this.queuedAudioBytes;
    this.clearTimer();
    this.resetQueue();
    this.resetPlaybackState();
    this.params.send(this.params.serializer.clear());
    return clearedAudioBytes;
  }

  /** True while queued audio or a paced send timer can still reach the telephony stream. */
  hasPendingAudio(): boolean {
    return !this.closed && (this.queuedAudioBytes > 0 || this.timer !== null);
  }

  /** Stop sending and discard queued frames. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.resetQueue();
    this.resetPlaybackState();
  }

  /** Milliseconds of sent audio the telephony edge can already have played. */
  private consumedPlayoutMs(): number {
    let consumedMs: number;
    if (this.hasPendingAudio()) {
      // While pacing, the lead window is still buffered in the telephony edge.
      consumedMs = Math.max(0, this.sentAudioMs - LEAD_MS);
    } else if (this.drainedLead) {
      // The queue drained, but the final lead can still sit in the carrier buffer
      // until the playout frontier passes it.
      const elapsedMs = Math.max(0, performance.now() - this.drainedLead.atMs);
      const bufferedMs = Math.max(0, this.drainedLead.bufferedMs - elapsedMs);
      consumedMs = Math.max(0, this.sentAudioMs - bufferedMs);
    } else {
      consumedMs = 0;
    }
    // Carrier mark acknowledgements confirm playout regardless of the lead estimate.
    return Math.min(this.sentAudioMs, Math.max(consumedMs, this.confirmedPlayedMs));
  }

  private extendPlaybackSegment(itemId: string | undefined, durationMs: number) {
    let segment = this.playbackSegments.at(-1);
    if (!segment || segment.itemId !== itemId) {
      segment = { itemId, totalMs: 0, sentMs: 0 };
      this.playbackSegments.push(segment);
      while (this.playbackSegments.length > MAX_PLAYBACK_SEGMENTS) {
        const dropped = this.playbackSegments.shift();
        if (dropped) {
          this.evictedSentMs += dropped.sentMs;
        }
      }
    }
    segment.totalMs += durationMs;
    return segment;
  }

  private resetPlaybackState(): void {
    this.playbackSegments = [];
    this.queuedAudioBytes = 0;
    this.sentAudioMs = 0;
    this.evictedSentMs = 0;
    this.confirmedPlayedMs = 0;
    this.drainedLead = null;
    this.markBoundaries = [];
    this.streamClockMs = null;
  }

  /** Clear the scheduled pump timer. */
  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Start the pump when queued work exists and no timer is active. */
  private ensurePump(): void {
    if (!this.timer) {
      this.pump();
    }
  }

  /** Close the pacer and notify the caller about queued-audio backpressure. */
  private failBackpressure(): void {
    this.close();
    this.params.onBackpressure?.();
  }

  private get pendingQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  /** Take one queued item without shifting the remaining paced-audio backlog. */
  private takeNextItem(): RealtimeAudioQueueItem | undefined {
    if (this.queueHead >= this.queue.length) {
      this.resetQueue();
      return undefined;
    }
    const item = this.queue[this.queueHead];
    this.queueHead += 1;
    if (this.queueHead >= this.queue.length) {
      this.resetQueue();
    } else if (
      this.queueHead > QUEUE_COMPACT_HEAD_THRESHOLD &&
      this.queueHead * 2 > this.queue.length
    ) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    return item;
  }

  private resetQueue(): void {
    this.queue.length = 0;
    this.queueHead = 0;
  }

  /** Fill the provider playout cushion, then wake at the next timeline boundary. */
  private pump(): void {
    this.timer = null;
    if (this.closed) {
      return;
    }
    const now = performance.now();
    this.streamClockMs ??= now;

    let sentAudio = false;
    while (this.pendingQueueSize > 0 && this.streamClockMs < now + LEAD_MS) {
      const item = this.takeNextItem();
      if (!item) {
        break;
      }

      if (item.type === "audio") {
        sentAudio = true;
        // Fresh audio replaces any previous drain frontier.
        this.drainedLead = null;
        if (!this.sendAudioItem(item)) {
          this.resetQueue();
          this.queuedAudioBytes = 0;
          this.streamClockMs = null;
          return;
        }
      } else if (!this.sendMarkItem(item)) {
        this.resetQueue();
        this.queuedAudioBytes = 0;
        this.streamClockMs = null;
        return;
      }
    }

    if (this.pendingQueueSize === 0) {
      this.finishDrain(now, sentAudio);
      return;
    }
    const delayMs = Math.max(1, this.streamClockMs - LEAD_MS - performance.now());
    this.timer = setTimeout(() => this.pump(), delayMs);
  }

  private sendAudioItem(item: Extract<RealtimeAudioQueueItem, { type: "audio" }>): boolean {
    this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
    const sent = this.params.send(this.params.serializer.media(item.chunk.toString("base64")));
    if (sent) {
      item.segment.sentMs += item.durationMs;
      this.sentAudioMs += item.durationMs;
      item.segment.lastSentEndMs = this.sentAudioMs;
    }
    this.streamClockMs = (this.streamClockMs ?? performance.now()) + item.durationMs;
    return sent;
  }

  /** Send a queued mark frame and bind it to the playback prefix before it. */
  private sendMarkItem(item: Extract<RealtimeAudioQueueItem, { type: "mark" }>): boolean {
    const sent = this.params.send(this.params.serializer.mark(item.name));
    if (sent) {
      this.markBoundaries.push({
        name: item.name,
        sentMs: this.sentAudioMs,
      });
      if (this.markBoundaries.length > MAX_PENDING_MARK_BOUNDARIES) {
        this.markBoundaries.shift();
      }
    }
    return sent;
  }

  /** Record how much of the lead window the carrier edge may still hold. */
  private finishDrain(now: number, sentAudio: boolean): void {
    if (sentAudio) {
      const bufferedMs =
        this.streamClockMs === null ? 0 : Math.min(LEAD_MS, Math.max(0, this.streamClockMs - now));
      this.drainedLead = { atMs: now, bufferedMs };
    } else if (this.drainedLead) {
      // A mark-only pump keeps the frontier moving while the lead plays out.
      const elapsedMs = Math.max(0, now - this.drainedLead.atMs);
      this.drainedLead = {
        atMs: now,
        bufferedMs: Math.max(0, this.drainedLead.bufferedMs - elapsedMs),
      };
    }
    this.streamClockMs = null;
  }
}
