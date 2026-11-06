export function addonEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Home Assistant options must be a JSON object');
  }
  const options = value as Record<string, unknown>;
  function stringOption(key: string, required = false): string | undefined {
    const option = options[key];
    if ((option === undefined || option === null || option === '') && !required) return;
    if (typeof option !== 'string' || !option.trim()) {
      throw new Error(`Set ${key} in the app Configuration tab`);
    }
    return option;
  }

  const email = stringOption('wuuk_email', true)!;
  const password = stringOption('wuuk_password', true)!;
  const broker = stringOption('mqtt_url', true)!.trim();
  const url = URL.parse(broker);
  if (!url?.hostname || !['mqtt:', 'mqtts:'].includes(url.protocol)) {
    throw new Error('MQTT broker URL must start with mqtt:// or mqtts:// and include a host');
  }
  if (url.username || url.password) {
    throw new Error('Use the MQTT username and password fields for broker credentials');
  }

  const prefix = stringOption('mqtt_discovery_prefix')?.trim() ?? 'homeassistant';
  if (/[+#\u0000]/.test(prefix) || prefix.split('/').some(part => !part)) {
    throw new Error('MQTT discovery prefix must be a nonempty topic prefix without wildcards');
  }
  const batteryEnabled = options.battery_enabled ?? true;
  if (typeof batteryEnabled !== 'boolean') throw new Error('LAN battery polling must be a boolean');
  const interval = options.battery_interval_seconds ?? 900;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 60 || interval > 86_400) {
    throw new Error('Battery interval must be between 60 and 86400 seconds');
  }
  return {
    WUUK_EMAIL: email.trim(),
    WUUK_PASSWORD: password,
    MQTT_URL: broker,
    MQTT_USERNAME: stringOption('mqtt_username'),
    MQTT_PASSWORD: stringOption('mqtt_password'),
    MQTT_DISCOVERY_PREFIX: prefix,
    WUUK_BATTERY_ENABLED: String(batteryEnabled),
    WUUK_BATTERY_INTERVAL_SECONDS: String(interval),
    WUUK_STATE_FILE: '/data/receiver.json',
  };
}
