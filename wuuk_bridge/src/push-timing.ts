import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type ParserPacket = { tag?: number; object?: { sent?: unknown } };
type ParserListener = (packet: ParserPacket) => unknown;
type ParserOn = (this: object, event: string, listener: ParserListener) => unknown;
type ParserPrototype = { on: ParserOn };

/** Keep the Firebase envelope timestamp available while its notification is emitted. */
export function trackParserSentTime(prototype: ParserPrototype): { current: () => unknown; restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'on');
  const original = prototype.on;
  let current: unknown;
  const wrapped: ParserOn = function (event, listener) {
    if (event !== 'message') return original.call(this, event, listener);
    return original.call(this, event, (packet) => {
      const before = current;
      current = packet.tag === 8 && packet.object && Object.hasOwn(packet.object, 'sent')
        ? packet.object.sent : undefined;
      try { return listener(packet); } finally { current = before; }
    });
  };
  prototype.on = wrapped;
  return {
    current: () => current,
    restore: () => {
      if (prototype.on !== wrapped) return;
      if (descriptor) Object.defineProperty(prototype, 'on', descriptor);
      else delete (prototype as { on?: ParserOn }).on;
    },
  };
}

export function installFirebaseSentTimeTracker(): ReturnType<typeof trackParserSentTime> {
  const require = createRequire(import.meta.url);
  const path = join(dirname(require.resolve('@eneris/push-receiver')), 'parser.js');
  const parser = require(path) as { default?: { prototype?: ParserPrototype } };
  if (!parser.default?.prototype || typeof parser.default.prototype.on !== 'function') {
    throw new Error('Unsupported Firebase receiver parser');
  }
  return trackParserSentTime(parser.default.prototype);
}

/** Accept only plausible epoch values; unknown values must never suppress a ring. */
export function firebaseSentTime(value: unknown, now: number): number | undefined {
  if (value === undefined || value === null) return;
  const number = Number(String(value));
  if (!Number.isFinite(number) || number <= 0) return;
  const milliseconds = number < 100_000_000_000 ? number * 1000 : number;
  if (milliseconds < Date.UTC(2020, 0, 1) || milliseconds > now + 300_000) return;
  return milliseconds;
}

export function isStalePush(sent: number | undefined, receivedAt: number): boolean {
  return sent !== undefined && receivedAt - sent > 60_000;
}
