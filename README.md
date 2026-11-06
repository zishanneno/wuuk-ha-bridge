# Wuuk HA Bridge

Bring doorbell presses, camera activity, and battery percentage from your Wuuk doorbell into Home Assistant through MQTT discovery. This is an unofficial project tested with the **Y0210 doorbell and B0210 base station**. Other models are unverified.

| Home Assistant entity | How it works |
| --- | --- |
| Doorbell | Receives button presses through Wuuk and Firebase. Internet access is required. |
| Camera activity | Receives activity notifications through the same service. |
| Battery percentage | Reads the battery over your local network. Setup is automatic for the tested doorbell and base station. |

## What you need

- A Wuuk account that signs in with email and password and can see the doorbell in the Wuuk app. You can use a separate account after accepting a share from the owner. Social sign-in and interactive two-factor prompts are unsupported.
- A separate MQTT broker. If you already have one, reuse it. Otherwise, install and start a broker such as the **Mosquitto broker** app in Home Assistant OS. Connect Home Assistant's [MQTT integration](https://www.home-assistant.io/integrations/mqtt/) and Wuuk Doorbell Bridge to that same broker, with MQTT discovery enabled.
- For automatic battery discovery, the bridge and base station must be on the same IPv4 broadcast network. The bridge uses Wuuk account information at startup to identify the pairing, then reads battery data directly over the LAN.

## Install on Home Assistant OS

Wuuk Doorbell Bridge supports AMD64 and ARM64 on Home Assistant OS.

1. In Home Assistant, open **Settings → Apps → Install app**, then open the three-dot menu and select **Repositories**.
2. Add `https://github.com/zishanneno/wuuk-ha-bridge`.
3. Find and install **Wuuk Doorbell Bridge**.
4. Open **Configuration** and enter your Wuuk email and password, MQTT URL, and any MQTT credentials. For the Home Assistant Mosquitto broker app, the URL is typically `mqtt://core-mosquitto:1883`. For another broker, use its reachable address and port.
5. Save and start the app. Check its **Log** tab if the entities do not appear under the MQTT integration.

See the [app documentation](wuuk_bridge/DOCS.md) for battery settings and troubleshooting. Home Assistant also documents [how to add a third-party app repository](https://www.home-assistant.io/common-tasks/os/#installing-a-third-party-app-repository).

## Run standalone

Install Node.js 22 or later. From a terminal on the machine that will run the bridge:

```sh
git clone https://github.com/zishanneno/wuuk-ha-bridge.git
cd wuuk-ha-bridge/wuuk_bridge
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

Edit `.env` using the [included template](wuuk_bridge/.env.example). Files that start with a dot may be hidden in your file manager. Set `WUUK_EMAIL`, `WUUK_PASSWORD`, and `MQTT_URL`. The template uses localhost, so replace it if the broker runs on another host. Set `MQTT_USERNAME` and `MQTT_PASSWORD` if your broker requires them. Use `mqtts://` for a TLS broker.

Start the bridge after saving your settings:

```sh
node --env-file=.env dist/index.js
```

Keep `state/receiver.json` private and preserve it between restarts. Run one bridge process per state file. Set `WUUK_BATTERY_ENABLED=false` if you only want events.

## Verification

A Home Assistant OS test installation verified the configuration form, automatic battery discovery, and a live camera activity event. A physical button press was verified with the standalone listener. A physical press through the Home Assistant app has yet to be tested.

## License

[MIT](LICENSE)
