import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PushReceiver } from '@eneris/push-receiver';
import { batteryTargets, readBattery, type BatteryProfile } from './battery.js';
import { firebaseConfig } from './firebase-config.js';
import { HomeAssistantMqtt } from './mqtt.js';
import { receiverStateForAccount, type ReceiverState } from './receiver-state.js';
import { firebaseSentTime, installFirebaseSentTimeTracker, isStalePush } from './push-timing.js';
import { decodePush, WuukClient, type WuukDevice } from './wuuk.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before starting the bridge`);
  return value;
}

function doorbells(devices: WuukDevice[]): WuukDevice[] {
  return devices.flatMap(device => [
    ...([1, 6, 8].includes(Number(device.kind)) || /^(W0001|Y0210|Y0110)$/i.test(device.model ?? '') ? [device] : []),
    ...doorbells(device.paired_devices ?? []),
  ]);
}

async function main(): Promise<void> {
  process.umask(0o077);
  const email = required('WUUK_EMAIL').trim();
  const password = required('WUUK_PASSWORD');
  const mqttUrl = required('MQTT_URL');
  const profilePath = process.env.WUUK_BATTERY_PROFILE;
  const batteryProfile = profilePath
    ? JSON.parse(await readFile(profilePath, 'utf8')) as BatteryProfile
    : undefined;
  const intervalSeconds = Number(process.env.WUUK_BATTERY_INTERVAL_SECONDS || 900);
  const batteryEnabled = process.env.WUUK_BATTERY_ENABLED !== 'false';
  if (batteryEnabled && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86_400)) {
    throw new Error('Battery interval must be between 60 and 86400 seconds');
  }
  const statePath = process.env.WUUK_STATE_FILE || 'state/receiver.json';
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  let state: ReceiverState;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8')) as ReceiverState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { deviceId: randomUUID(), persistentIds: [] };
  }
  let saving = Promise.resolve();
  function saveState(): Promise<void> {
    const payload = JSON.stringify(state);
    saving = saving.catch(() => undefined).then(async () => {
      await writeFile(`${statePath}.tmp`, payload, { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    return saving;
  }

  const wuuk = new WuukClient(state.deviceId);
  const user = await wuuk.login(email, password);
  state = receiverStateForAccount(state, user.user_id);
  // Persist the reset before creating a receiver or requesting new credentials.
  await saveState();
  const devices = await wuuk.listDevices(user).catch(() => {
    console.error('Wuuk device list unavailable. Devices will be discovered on their first event.');
    return [];
  });
  const mqtt = new HomeAssistantMqtt(mqttUrl, `${state.deviceId}_${state.accountId}`, process.env.MQTT_DISCOVERY_PREFIX,
    process.env.MQTT_USERNAME, process.env.MQTT_PASSWORD);
  mqtt.client.on('error', () => console.error('MQTT connection error'));
  const sentTime = installFirebaseSentTimeTracker();
  const push = new PushReceiver({
    firebase: firebaseConfig,
    bundleId: 'com.wuuklabs.android.store',
    credentials: state.credentials,
    persistentIds: [...state.persistentIds],
  });
  let batteryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let registered = false;
  let pushOnline = false;
  let events = Promise.resolve();
  const recent = new Map<string, number>();
  push.onCredentialsChanged(({ newCredentials }) => {
    state.credentials = newCredentials;
    void saveState().catch(() => console.error('Could not save Firebase receiver state'));
  });
  push.onNotification(({ message, persistentId }) => {
    const event = decodePush(message);
    if (!event || stopping) return;
    const receivedAt = Date.now();
    const sentAt = firebaseSentTime(sentTime.current(), receivedAt);
    if (push.persistentIds.length > 100) push.persistentIds.splice(0, push.persistentIds.length - 100);
    events = events.then(async () => {
      const now = Date.now();
      for (const [key, expires] of recent) if (expires <= now) recent.delete(key);
      const key = JSON.stringify([event.serial, event.kind, event.time]);
      if (recent.has(key) || (persistentId && state.persistentIds.includes(persistentId))) return;
      if (isStalePush(sentAt, receivedAt)) {
        if (persistentId) state.persistentIds = [...state.persistentIds, persistentId].slice(-100);
        await saveState();
        console.error('Discarded an outdated Firebase notification');
        return;
      }
      await mqtt.publishEvent(event);
      recent.set(key, now + (event.time ? 60_000 : 1_000));
      if (persistentId) state.persistentIds = [...state.persistentIds, persistentId].slice(-100);
      await saveState();
    }).catch(() => console.error('Could not publish or save a Wuuk event'));
  });
  function updateAvailability(): void {
    if (registered && !stopping && mqtt.client.connected) {
      void mqtt.status(pushOnline).catch(() => console.error('Could not publish availability'));
    }
  }
  mqtt.client.on('connect', updateAvailability);
  push.onReady(() => {
    pushOnline = true;
    updateAvailability();
  });
  push.on('ON_DISCONNECT', () => {
    pushOnline = false;
    updateAvailability();
  });

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimeout(batteryTimer);
    push.destroy();
    sentTime.restore();
    await mqtt.close();
    await saving.catch(() => undefined);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void stop().catch(() => { process.exitCode = 1; }); });
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      push.connect(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Firebase connection timed out')), 30_000);
      }),
    ]);
    if (!push.fcmToken) throw new Error('Firebase did not return a receiver token');
    if (!mqtt.client.connected) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          mqtt.client.removeListener('connect', connected);
          reject(new Error('MQTT connection timed out'));
        }, 15_000);
        function connected(): void {
          clearTimeout(timer);
          resolve();
        }
        mqtt.client.once('connect', connected);
      });
    }
    if (stopping) return;
    await wuuk.registerPush(user, push.fcmToken);
    for (const device of doorbells(devices)) {
      if (device.sn) await mqtt.discover(device.sn, device.name, device.model);
    }
    registered = true;
    await mqtt.status(pushOnline);
    console.error('Wuuk MQTT bridge ready');
    const targets = batteryEnabled ? batteryProfile ? [batteryProfile] : batteryTargets(devices) : [];
    async function pollBattery(): Promise<void> {
      for (const profile of targets) {
        if (stopping) return;
        try {
          const battery = await readBattery(profile);
          if (!stopping && mqtt.client.connected) {
            await mqtt.discover(profile.doorbell_serial);
            await mqtt.publishBattery(profile.doorbell_serial, battery, intervalSeconds);
          }
        } catch {
          console.error('Could not read or publish the LAN battery');
        }
      }
      if (!stopping) batteryTimer = setTimeout(() => {
        void pollBattery();
      }, intervalSeconds * 1_000);
    }
    if (targets.length) void pollBattery();
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bridge failed');
  process.exitCode = 1;
});
