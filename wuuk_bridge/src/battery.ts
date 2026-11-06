import { createSocket, type RemoteInfo } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { WuukDevice } from './wuuk.js';

export interface BatteryProfile {
  host: string;
  subnet: string;
  seed: string;
  table: string;
  doorbell_serial: string;
}

interface AutomaticBattery {
  doorbell_serial: string;
  seed: string;
  table: string;
  identity: Buffer;
}

export type BatteryTarget = BatteryProfile | AutomaticBattery;

// Byte substitution table for the PPCS LAN transport used by the B0210.
const ppcsTable = '7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc11fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a388ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb10e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af4237d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c818e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17';

export function batteryTargets(devices: WuukDevice[]): BatteryTarget[] {
  const targets = new Map<string, AutomaticBattery>();
  for (const base of devices) {
    if (base.model?.toUpperCase() !== 'B0210' && Number(base.kind) !== 2) continue;
    const did = base.did?.match(/^([A-Za-z0-9]{1,8})-(\d{1,10})-([A-Za-z0-9]{1,8})(?::.*)?$/);
    const separator = base.init_string?.lastIndexOf(':') ?? -1;
    const lanKey = separator > 0 ? base.init_string?.slice(separator + 1) : undefined;
    if (!did || Number(did[2]) > 0xffffffff || !lanKey) continue;
    const identity = Buffer.alloc(20);
    identity.write(did[1], 0, 'ascii');
    identity.writeUInt32BE(Number(did[2]), 8);
    identity.write(did[3], 12, 'ascii');
    const seed = Buffer.alloc(4);
    for (const byte of Buffer.from(lanKey).subarray(0, 20)) {
      seed[0] += byte;
      seed[1] -= byte;
      seed[2] += Math.floor(byte / 3);
      seed[3] ^= byte;
    }
    for (const doorbell of base.paired_devices ?? []) {
      if (doorbell.sn && (doorbell.model?.toUpperCase() === 'Y0210' || Number(doorbell.kind) === 6)) {
        targets.set(doorbell.sn, { doorbell_serial: doorbell.sn, identity, seed: seed.toString('hex'), table: ppcsTable });
      }
    }
  }
  return [...targets.values()];
}

function numberOf(address: string): number {
  return address.split('.').reduce((value, octet) => (value << 8) | Number(octet), 0) >>> 0;
}

function isPrivate(ip: number): boolean {
  return ip >>> 24 === 10 || ip >>> 20 === 0xac1 || ip >>> 16 === 0xc0a8;
}

function broadcastFor(host: string, subnet: string): string {
  const [network, bits] = subnet.split('/');
  if (!isIPv4(host) || !isIPv4(network) || !/^\d+$/.test(bits ?? '')) {
    throw new Error('Invalid battery profile address');
  }
  const length = Number(bits);
  const mask = length >= 8 && length <= 30 ? (0xffffffff << (32 - length)) >>> 0 : 0;
  const ip = numberOf(host);
  if (!mask || !isPrivate(ip) || (ip & mask) !== (numberOf(network) & mask)) {
    throw new Error('Battery profile must specify a private address on its LAN subnet');
  }
  const broadcast = (ip | ~mask) >>> 0;
  return [24, 16, 8, 0].map(shift => (broadcast >>> shift) & 255).join('.');
}

const magic = Buffer.from('090b0d0a', 'hex');
const channel = Buffer.from([0xd1, 0, 0, 0]);

function packet(kind: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.from([0xf1, kind, 0, 0]);
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function request(id: number, data: object): Buffer {
  const payload = Buffer.from(JSON.stringify(data));
  const header = Buffer.concat([magic, Buffer.from([1, 8]), Buffer.alloc(8)]);
  header.writeUInt32LE(payload.length, 6);
  header.writeUInt32LE(id, 10);
  return Buffer.concat([header, payload]);
}

function batteryFromFrames(body: Buffer): number | undefined {
  while (body.length >= 14) {
    const end = 14 + body.readUInt32LE(6);
    if (!body.subarray(0, 4).equals(magic) || end > body.length) return;
    if (body[4] === 2 && body[5] === 8 && body.readUInt32LE(10) === 11) {
      try {
        const reply = JSON.parse(body.toString('utf8', 14, end).replace(/\0+$/, ''));
        const value: unknown = reply.d?.battery;
        if (reply.r === 0 && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100) {
          return value;
        }
      } catch { return; }
    }
    body = body.subarray(end);
  }
}

export async function readBattery(profile: BatteryTarget): Promise<number> {
  const manual = 'host' in profile;
  const broadcasts = new Set(['255.255.255.255']);
  if (manual) broadcasts.add(broadcastFor(profile.host, profile.subnet));
  else for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (!address.internal && address.family === 'IPv4' && address.cidr &&
        isPrivate(numberOf(address.address))) {
        const prefix = Number(address.cidr.split('/')[1]);
        if (prefix >= 8 && prefix <= 30) broadcasts.add(broadcastFor(address.address, address.cidr));
      }
    }
  }
  if (!/^[\da-f]{8}$/i.test(profile.seed) || !/^[\da-f]{512}$/i.test(profile.table) ||
    typeof profile.doorbell_serial !== 'string' || !profile.doorbell_serial) {
    throw new Error('Invalid battery transport profile');
  }
  const table = Buffer.from(profile.table, 'hex');
  const seed = Buffer.from(profile.seed, 'hex');
  function transform(data: Buffer, encode: boolean): Buffer {
    const output = Buffer.alloc(data.length);
    let previous = 0;
    for (let i = 0; i < data.length; i++) {
      output[i] = data[i] ^ table[(previous + seed[previous & 3]) & 255];
      previous = encode ? output[i] : data[i];
    }
    return output;
  }

  const query = packet(0xd0, Buffer.concat([
    channel, request(10, {}), request(11, { sn: profile.doorbell_serial }),
  ]));
  return new Promise<number>((resolve, reject) => {
    const socket = createSocket('udp4');
    const candidates = new Set<string>();
    let peer: RemoteInfo | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    function finish(error?: Error, battery?: number): void {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearTimeout(deadline);
      socket.close();
      if (error) reject(error);
      else resolve(battery!);
    }
    const deadline = setTimeout(() => finish(new Error('LAN battery read timed out')), 10_000);
    function send(data: Buffer, address: string, port: number, callback?: () => void): void {
      socket.send(transform(data, true), port, address, error => {
        if (error) finish(error);
        else callback?.();
      });
    }
    socket.on('error', finish);
    socket.on('message', (wire, sender) => {
      if (closed || (manual ? sender.address !== profile.host : !isPrivate(numberOf(sender.address))) ||
        (peer && (sender.address !== peer.address || sender.port !== peer.port))) return;
      const frame = transform(wire, false);
      if (frame.length < 4 || frame[0] !== 0xf1 || frame.readUInt16BE(2) > frame.length - 4) return;
      const body = frame.subarray(4, 4 + frame.readUInt16BE(2));
      const addressKey = `${sender.address}:${sender.port}`;
      if (frame[1] === 0x41 && body.length === 20 && (manual || body.equals(profile.identity))) {
        candidates.add(addressKey);
        send(packet(0x41, body), sender.address, sender.port);
      } else if (frame[1] === 0x42 && body.length === 20 && !peer &&
        candidates.has(addressKey)) {
        peer = sender;
        send(query, sender.address, sender.port);
      } else if (peer && frame[1] === 0xe0) {
        send(packet(0xe1), sender.address, sender.port);
      } else if (peer && frame[1] === 0xd0 && body.length >= 4 && body[0] === 0xd1 && body[1] === 0) {
        send(packet(0xd1, Buffer.concat([Buffer.from([0xd1, 0, 0, 1]), body.subarray(2, 4)])),
          sender.address, sender.port);
        const battery = batteryFromFrames(body.subarray(4));
        if (battery !== undefined) {
          clearInterval(interval);
          send(packet(0xf0), sender.address, sender.port, () => finish(undefined, battery));
        }
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      function tick(): void {
        if (peer) send(query, peer.address, peer.port);
        else for (const address of broadcasts) {
          send(packet(0x30), address, 32108);
        }
      }
      tick();
      interval = setInterval(tick, 500);
    });
  });
}
