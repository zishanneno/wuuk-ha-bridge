import { createHash } from 'node:crypto';
import { connect, type MqttClient } from 'mqtt';
import type { WuukEvent } from './wuuk.js';

export function deviceId(serial: string): string {
  return 'wuuk_' + createHash('sha256').update(serial).digest('hex').slice(0, 24);
}

export class HomeAssistantMqtt {
  readonly client: MqttClient;
  readonly availability: string;
  readonly connectionAvailability: string;
  private readonly announced = new Set<string>();
  private closing = false;

  constructor(url: string, instance: string, private readonly prefix = 'homeassistant',
    username?: string, password?: string) {
    this.availability = `wuuk/bridge/${instance}/availability`;
    this.connectionAvailability = `wuuk/bridge/${instance}/connection`;
    this.client = connect(url, {
      username, password, connectTimeout: 10_000, reconnectPeriod: 2_000,
      will: { topic: this.connectionAvailability, payload: 'offline', qos: 1, retain: true },
    });
  }

  async status(pushOnline: boolean): Promise<void> {
    if (this.closing || !this.client.connected) return;
    await this.client.publishAsync(this.availability, pushOnline ? 'online' : 'offline',
      { qos: 1, retain: true });
    if (this.closing || !this.client.connected) return;
    await this.client.publishAsync(this.connectionAvailability, 'online', { qos: 1, retain: true });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.client.connected) {
      await this.client.publishAsync(this.connectionAvailability, 'offline',
        { qos: 1, retain: true }).catch(() => undefined);
    }
    await this.client.endAsync(true);
  }

  async discover(serial: string, name?: string, model?: string): Promise<void> {
    const id = deviceId(serial);
    if (this.announced.has(id)) return;
    for (const [component, label, eventType] of [
      ['ring', 'Doorbell', 'ring'],
      ['activity', 'Camera activity', 'camera_activity'],
    ]) {
      await this.client.publishAsync(`${this.prefix}/event/${id}/${component}/config`, JSON.stringify({
        name: label, unique_id: `${id}_${component}`,
        state_topic: `wuuk/${id}/${component}`,
        availability: [{ topic: this.connectionAvailability }, { topic: this.availability }],
        availability_mode: 'all',
        event_types: [eventType], qos: 1,
        ...(component === 'ring' ? { device_class: 'doorbell' } : {}),
        device: { identifiers: [id], name: name || 'Wuuk doorbell', manufacturer: 'Wuuk', model },
      }), { qos: 1, retain: true });
    }
    this.announced.add(id);
  }

  async publishBattery(serial: string, battery: number, intervalSeconds: number): Promise<void> {
    const id = deviceId(serial);
    const stateTopic = `wuuk/${id}/battery`;
    await this.client.publishAsync(`${this.prefix}/sensor/${id}/battery/config`, JSON.stringify({
      name: 'Battery', unique_id: `${id}_battery`, state_topic: stateTopic,
      availability_topic: this.connectionAvailability, device_class: 'battery', state_class: 'measurement',
      unit_of_measurement: '%', expire_after: intervalSeconds * 3,
      device: { identifiers: [id] },
    }), { qos: 1, retain: true });
    await this.client.publishAsync(stateTopic, String(battery), { qos: 1, retain: false });
  }

  async publishEvent(event: WuukEvent): Promise<void> {
    const id = deviceId(event.serial);
    const component = event.type === 'ring' ? 'ring' : 'activity';
    await this.discover(event.serial, event.name);
    await this.client.publishAsync(`wuuk/${id}/${component}`, JSON.stringify({
      event_type: event.type, wuuk_kind: event.kind,
    }), { qos: 1, retain: false });
  }
}
