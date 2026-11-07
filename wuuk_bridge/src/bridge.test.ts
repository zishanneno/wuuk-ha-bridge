import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Aedes } from 'aedes';
import { connectAsync } from 'mqtt';
import { addonEnvironment } from './addon-options.js';
import { batteryTargets } from './battery.js';
import { deviceId, HomeAssistantMqtt } from './mqtt.js';
import { decodePush } from './wuuk.js';
import { receiverStateForAccount, type ReceiverState } from './receiver-state.js';
import { firebaseSentTime, installFirebaseSentTimeTracker, isStalePush, trackParserSentTime } from './push-timing.js';

test('tracks Firebase transport time only while its packet is delivered', () => {
  let registered: ((packet: { tag?: number; object?: { sent?: unknown } }) => unknown) | undefined;
  const prototype = {
    on(_event: string, listener: (packet: { tag?: number; object?: { sent?: unknown } }) => unknown) {
      registered = listener;
      return () => { registered = undefined; };
    },
  };
  const original = prototype.on;
  const tracker = trackParserSentTime(prototype);
  let observed: unknown;
  prototype.on('message', () => { observed = tracker.current(); });
  registered!({ tag: 8, object: { sent: '1794000000000' } });
  assert.equal(observed, '1794000000000');
  assert.equal(tracker.current(), undefined);
  registered!({ tag: 8, object: {} });
  assert.equal(observed, undefined);
  tracker.restore();
  assert.equal(prototype.on, original);
});

test('tracks a message through the installed Firebase parser', () => {
  const require = createRequire(import.meta.url);
  const Parser = require(join(dirname(require.resolve('@eneris/push-receiver')), 'parser.js')).default;
  const tracker = installFirebaseSentTimeTracker();
  try {
    const parser = new Parser(new EventEmitter());
    let observed: unknown;
    parser.on('message', () => { observed = tracker.current(); });
    parser.emit('message', { tag: 8, object: { sent: '1794000000000' } });
    assert.equal(observed, '1794000000000');
    assert.equal(tracker.current(), undefined);
    parser.destroy();
  } finally {
    tracker.restore();
  }
});

test('filters stale Firebase notifications but preserves fresh and uncertain events', () => {
  const now = Date.UTC(2026, 10, 7, 5, 0, 0);
  assert.equal(firebaseSentTime(String(now), now), now);
  assert.equal(firebaseSentTime(String(now / 1000), now), now);
  assert.equal(isStalePush(firebaseSentTime(String(now - 60_001), now), now), true);
  assert.equal(isStalePush(firebaseSentTime(String(now - 60_000), now), now), false);
  for (const unknown of [undefined, null, '', 'invalid', 0, '1', String(now + 301_000)]) {
    assert.equal(isStalePush(firebaseSentTime(unknown, now), now), false);
  }
});

test('drops a replayed Firebase ring and persists its ID while delivering fresh and unknown-time rings',
  { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'wuuk-timing-test-'));
    const stateFile = join(directory, 'receiver.json');
    const preload = join(directory, 'preload.cjs');
    const broker = await Aedes.createBroker();
    const server = createServer(broker.handle);
    t.after(async () => {
      await broker.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const brokerUrl = `mqtt://127.0.0.1:${address.port}`;
    const subscriber = await connectAsync(brokerUrl);
    t.after(() => subscriber.endAsync(true));
    await subscriber.subscribeAsync('wuuk/+/ring');
    const received: string[] = [];
    subscriber.on('message', topic => received.push(topic));
    await writeFile(preload, `
      const { EventEmitter } = require('node:events');
      const { dirname, join } = require('node:path');
      const entry = ${JSON.stringify(createRequire(import.meta.url).resolve('@eneris/push-receiver'))};
      const receiverModule = require(entry);
      const Parser = require(join(dirname(entry), 'parser.js')).default;
      receiverModule.PushReceiver = class extends EventEmitter {
        constructor(config) { super(); this.persistentIds = config.persistentIds; this.fcmToken = 'test-token'; }
        onCredentialsChanged(fn) { this.on('credentials', fn); }
        onNotification(fn) { this.on('notification', fn); }
        onReady(fn) { this.on('ready', fn); }
        async connect() {
          const parser = new Parser(new EventEmitter()); this.parser = parser;
          parser.on('message', ({object}) => this.emit('notification', {
            message: { data: { sn: object.serial, kind: 1 } }, persistentId: object.persistentId,
          }));
          this.emit('ready');
          setTimeout(() => {
            parser.emit('message', { tag: 8, object: { sent: String(Date.now()-300000), serial:'old', persistentId:'old-id' } });
            parser.emit('message', { tag: 8, object: { sent: String(Date.now()), serial:'fresh', persistentId:'fresh-id' } });
            parser.emit('message', { tag: 8, object: { serial:'unknown', persistentId:'unknown-id' } });
          }, 500);
        }
        destroy() { this.parser?.destroy(); }
      };
      global.fetch = async (url) => {
        if (url.endsWith('/user/login')) return Response.json({ data: { user_id:'account', token:'session' } });
        if (url.endsWith('/device/all')) return Response.json({ data: [] });
        return Response.json({ data: {} });
      };
    `);
    const child = spawn(process.execPath, ['--require', preload, fileURLToPath(new URL('./index.js', import.meta.url))], {
      env: { ...process.env, WUUK_EMAIL:'test@example.test', WUUK_PASSWORD:'test', MQTT_URL:brokerUrl,
        MQTT_USERNAME:'', MQTT_PASSWORD:'', WUUK_STATE_FILE:stateFile, WUUK_BATTERY_ENABLED:'false', WUUK_BATTERY_PROFILE:'' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', data => { output += data.toString(); });
    try {
      const end = Date.now()+10_000;
      while (received.length < 2 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(new Set(received), new Set([`wuuk/${deviceId('fresh')}/ring`, `wuuk/${deviceId('unknown')}/ring`]));
      assert.match(output, /Discarded an outdated Firebase notification/);
      await new Promise(resolve => setTimeout(resolve, 100));
      child.kill('SIGTERM');
      await once(child, 'exit');
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as ReceiverState;
      assert(state.persistentIds.includes('old-id'));
      assert(state.persistentIds.includes('fresh-id'));
      assert(state.persistentIds.includes('unknown-id'));
    } finally {
      child.kill('SIGKILL');
    }
  });

const testCredentials = {
  gcm: { androidId: 'test-id', securityToken: 'test-security-token', appId: 'test-app', token: 'test-gcm-token' },
  fcm: { token: 'test-fcm-token', installation: {
    token: 'test-installation-token', createdAt: 0, expiresIn: 3600, refreshToken: 'test-refresh', fid: 'test-fid',
  } },
  keys: { privateKey: 'test-private', publicKey: 'test-public', authSecret: 'test-auth' },
  config: { projectId: 'test-project', vapidKey: '', bundleId: 'test-bundle' },
};

test('replaces legacy and changed-account registrations and preserves same-account state', () => {
  const legacy: ReceiverState = {
    deviceId: 'installation-id', credentials: testCredentials, persistentIds: ['old-message'],
  };
  const first = receiverStateForAccount(legacy, 'account-one');
  assert.equal(first.deviceId, legacy.deviceId);
  assert.equal(first.credentials, undefined);
  assert.deepEqual(first.persistentIds, []);
  assert.match(first.accountId!, /^[a-f0-9]{64}$/);

  const registered = JSON.parse(JSON.stringify({
    ...first, credentials: testCredentials, persistentIds: ['new-message'],
  })) as ReceiverState;
  assert.equal(receiverStateForAccount(registered, 'account-one'), registered);
  const changed = receiverStateForAccount(registered, 'account-two');
  assert.notEqual(changed.accountId, registered.accountId);
  assert.equal(changed.credentials, undefined);
  assert.deepEqual(changed.persistentIds, []);
  // A failed registration can safely restart using the already-saved reset state.
  assert.deepEqual(receiverStateForAccount(JSON.parse(JSON.stringify(changed)), 'account-two'), changed);
});

test('startup persists account ownership before connecting and keeps state after failed login',
  { timeout: 30_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'wuuk-startup-test-'));
    const stateFile = join(directory, 'receiver.json');
    const preload = join(directory, 'preload.cjs');
    const broker = await Aedes.createBroker();
    const server = createServer(broker.handle);
    t.after(async () => {
      await broker.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const brokerUrl = `mqtt://127.0.0.1:${address.port}`;
    await writeFile(stateFile, JSON.stringify({
      deviceId: 'test-installation', credentials: testCredentials, persistentIds: ['legacy-message'],
    }));
    // Replace only the cloud boundaries. The child runs the real entrypoint and MQTT client.
    await writeFile(preload, `
      const assert = require('node:assert/strict');
      const { readFileSync } = require('node:fs');
      const { createHash } = require('node:crypto');
      const { EventEmitter } = require('node:events');
      const receiverModule = require(${JSON.stringify(createRequire(import.meta.url).resolve('@eneris/push-receiver'))});
      const account = process.env.TEST_ACCOUNT;
      const expectedToken = process.env.TEST_EXISTING_TOKEN || undefined;
      receiverModule.PushReceiver = class extends EventEmitter {
        constructor(options) {
          super();
          assert.equal(options.credentials?.fcm.token, expectedToken);
          const persisted = JSON.parse(readFileSync(process.env.WUUK_STATE_FILE, 'utf8'));
          assert.equal(persisted.accountId, createHash('sha256').update(account).digest('hex'));
          assert.equal(persisted.credentials?.fcm.token, expectedToken);
          this.persistentIds = options.persistentIds;
          if (!expectedToken) assert.deepEqual(this.persistentIds, []);
          this.fcmToken = expectedToken || 'new-token-' + account;
        }
        onCredentialsChanged(listener) { this.on('credentials', listener); }
        onNotification(listener) { this.on('notification', listener); }
        onReady(listener) { this.on('ready', listener); }
        async connect() {
          const credentials = ${JSON.stringify(testCredentials)};
          credentials.fcm.token = this.fcmToken;
          this.emit('credentials', { newCredentials: credentials });
          this.emit('ready');
        }
        destroy() {}
      };
      global.fetch = async (url, options) => {
        if (url.endsWith('/user/login')) {
          if (process.env.TEST_REJECT_LOGIN) return Response.json({ error: { code: 401 } }, { status: 401 });
          return Response.json({ data: { user_id: account, token: 'test-session' } });
        }
        if (url.endsWith('/device/all')) return Response.json({ data: [] });
        assert(url.endsWith('/user/' + account + '/push_token/update'));
        assert.equal(options.body.get('token'), expectedToken || 'new-token-' + account);
        return Response.json({ data: {} });
      };
    `);

    async function run(account: string, existingToken = '', rejectLogin = false): Promise<void> {
      const child = spawn(process.execPath, ['--require', preload, fileURLToPath(new URL('./index.js', import.meta.url))], {
        env: {
          ...process.env, WUUK_EMAIL: 'test@example.test', WUUK_PASSWORD: 'test-password',
          MQTT_URL: brokerUrl, MQTT_USERNAME: '', MQTT_PASSWORD: '',
          WUUK_STATE_FILE: stateFile, WUUK_BATTERY_ENABLED: 'false', WUUK_BATTERY_PROFILE: '',
          TEST_ACCOUNT: account, TEST_EXISTING_TOKEN: existingToken, TEST_REJECT_LOGIN: rejectLogin ? '1' : '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      let output = '';
      child.stderr.on('data', data => {
        output += data.toString();
        if (output.includes('Wuuk MQTT bridge ready')) child.kill('SIGTERM');
      });
      try {
        const [code, signal] = await once(child, 'exit');
        assert.equal(signal, null, output);
        assert.equal(code, rejectLogin ? 1 : 0, output);
        assert.match(output, rejectLogin ? /Wuuk login failed/ : /Wuuk MQTT bridge ready/);
      } finally {
        clearTimeout(timer);
        child.kill('SIGKILL');
      }
    }

    await run('account-one');
    await run('account-one', 'new-token-account-one');
    const beforeFailedLogin = await readFile(stateFile, 'utf8');
    await run('account-two', '', true);
    assert.equal(await readFile(stateFile, 'utf8'), beforeFailedLogin);
    await run('account-two');
    await run('account-two', 'new-token-account-two');
  });

test('maps Supervisor options to the bridge environment and validates broker URLs', () => {
  const options = {
    wuuk_email: 'user@example.test', wuuk_password: 'example = password',
    mqtt_url: 'mqtts://broker.example.test:8883', mqtt_username: 'subscriber',
    battery_enabled: false,
  };
  const env = addonEnvironment(options);
  assert.equal(env.WUUK_EMAIL, options.wuuk_email);
  assert.equal(env.WUUK_PASSWORD, options.wuuk_password);
  assert.equal(env.MQTT_URL, options.mqtt_url);
  assert.equal(env.MQTT_USERNAME, options.mqtt_username);
  assert.equal(env.MQTT_PASSWORD, undefined);
  assert.equal(env.WUUK_BATTERY_ENABLED, 'false');
  assert.equal(env.WUUK_BATTERY_INTERVAL_SECONDS, '900');
  assert.equal(env.WUUK_STATE_FILE, '/data/receiver.json');
  assert.throws(() => addonEnvironment({ ...options, wuuk_password: null }), /wuuk_password/);
  assert.throws(() => addonEnvironment({ ...options, mqtt_url: 'https://broker.example.test' }), /mqtts?:/);
  assert.throws(() => addonEnvironment({ ...options, mqtt_url: 'mqtt://user:secret@broker.example.test' }),
    /username and password fields/);
});

test('maps only known kinds and strips unrelated push fields', () => {
  assert.deepEqual(decodePush({ data: { sn: 'test', kind: '1', dsk: 'unused' } }), {
    serial: 'test', kind: 1, type: 'ring', name: undefined, time: undefined,
  });
  assert.equal(decodePush({ message: { data: { sn: 'test', kind: 5 } } })?.type, 'camera_activity');
  assert.equal(decodePush({ data: { sn: 'test', kind: 4 } }), undefined);
  assert.equal(decodePush({ data: { kind: 1 } }), undefined);
});

test('derives the LAN identity and seed for paired Y0210 devices only', () => {
  const base = {
    model: 'B0210', did: 'PREFIX-000123-TAIL', init_string: 'directory:abc',
    paired_devices: [{ model: 'Y0210', sn: 'test-doorbell' }, { model: 'Y0410', sn: 'test-camera' }],
  };
  const [target, ...others] = batteryTargets([base]);
  assert.deepEqual(others, []);
  assert(target && 'identity' in target);
  assert.equal(target.doorbell_serial, 'test-doorbell');
  assert.equal(target.seed, '26da6160');
  assert.equal(target.identity.readUInt32BE(8), 123);
  assert.equal(target.identity.subarray(0, 6).toString(), 'PREFIX');
  assert.equal(target.identity.subarray(12, 16).toString(), 'TAIL');
  assert.deepEqual(batteryTargets([{ ...base, init_string: 'directory' }]), []);
});

test('publishes MQTT discovery and transient events to a loopback broker', { timeout: 10_000 }, async t => {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `mqtt://127.0.0.1:${address.port}`;
  const subscriber = await connectAsync(url);
  const bridge = new HomeAssistantMqtt(url, 'test');
  let retained: Awaited<ReturnType<typeof connectAsync>> | undefined;
  t.after(async () => {
    await retained?.endAsync(true);
    await bridge.close();
    await subscriber.endAsync(true);
    await broker.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  if (!bridge.client.connected) await new Promise<void>(resolve => bridge.client.once('connect', () => resolve()));
  const messages = new Map<string, { payload: string; retain: boolean }>();
  subscriber.on('message', (topic, body, packet) => {
    messages.set(topic, { payload: body.toString(), retain: packet.retain });
  });
  await subscriber.subscribeAsync('#');
  const serial = 'test-doorbell';
  const id = deviceId(serial);
  await bridge.status(true);
  await bridge.publishEvent({ serial, kind: 1, type: 'ring' });
  await bridge.publishEvent({ serial, kind: 5, type: 'camera_activity' });
  await bridge.publishBattery(serial, 35, 900);
  const retainedClient = await connectAsync(url);
  retained = retainedClient;
  const configTopic = `homeassistant/event/${id}/ring/config`;
  const configMessage = new Promise<{ topic: string; payload: string; retain: boolean }>(resolve => {
    retainedClient.once('message', (topic, payload, packet) => {
      resolve({ topic, payload: payload.toString(), retain: packet.retain });
    });
  });
  await retainedClient.subscribeAsync(configTopic);
  const { topic, payload, retain } = await configMessage;
  assert.equal(topic, configTopic);
  assert.equal(retain, true);
  assert.equal(JSON.parse(payload.toString()).device_class, 'doorbell');
  assert.deepEqual(JSON.parse(payload.toString()).event_types, ['ring']);
  for (const [component, expected] of [['ring', 'ring'], ['activity', 'camera_activity']]) {
    const event = messages.get(`wuuk/${id}/${component}`);
    assert(event);
    assert.equal(event.retain, false);
    assert.equal(JSON.parse(event.payload).event_type, expected);
  }
  assert.equal(messages.get(`wuuk/${id}/battery`)?.payload, '35');
  assert.equal(messages.get('wuuk/bridge/test/availability')?.payload, 'online');
  const eventConfig = JSON.parse(payload);
  assert.deepEqual(eventConfig.availability, [
    { topic: bridge.connectionAvailability }, { topic: bridge.availability },
  ]);
  assert.equal(eventConfig.availability_mode, 'all');
  const batteryConfig = JSON.parse(messages.get(`homeassistant/sensor/${id}/battery/config`)!.payload);
  assert.equal(batteryConfig.availability_topic, bridge.connectionAvailability);
  assert.equal(batteryConfig.expire_after, 2700);

  function nextStatus(statusTopic: string, value: string): Promise<void> {
    return new Promise(resolve => {
      function listener(topic: string, payload: Buffer): void {
        if (topic !== statusTopic || payload.toString() !== value) return;
        subscriber.off('message', listener);
        resolve();
      }
      subscriber.on('message', listener);
    });
  }

  // Firebase can be offline while LAN battery readings still arrive.
  const pushOffline = nextStatus(bridge.availability, 'offline');
  await bridge.status(false);
  await pushOffline;
  const newBattery = nextStatus(`wuuk/${id}/battery`, '36');
  await bridge.publishBattery(serial, 36, 900);
  await newBattery;
  assert.equal(messages.get(bridge.connectionAvailability)?.payload, 'online');

  // Losing MQTT triggers the connection will, and reconnection restores availability.
  const connectionOffline = nextStatus(bridge.connectionAvailability, 'offline');
  bridge.client.stream.destroy();
  await connectionOffline;
  const reconnected = nextStatus(bridge.connectionAvailability, 'online');
  bridge.client.once('connect', () => { void bridge.status(false); });
  await reconnected;
  assert.equal(messages.get(bridge.availability)?.payload, 'offline');
  const pushRestored = nextStatus(bridge.availability, 'online');
  await bridge.status(true);
  await pushRestored;

  const stopped = nextStatus(bridge.connectionAvailability, 'offline');
  await bridge.close();
  await stopped;
});
