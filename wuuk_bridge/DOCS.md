# Wuuk Doorbell Bridge

1. Set up an MQTT broker first. Use an existing broker or install and start the **Mosquitto broker** app separately. Enable the MQTT integration in Home Assistant and connect it to that broker.
2. Open the Wuuk Doorbell Bridge app and select **Configuration**.
3. Enter the Wuuk email and password. A dedicated account with accepted shared access works. Use email and password sign-in.
4. Enter the MQTT URL and any broker credentials. For the Mosquitto broker app, the URL is typically `mqtt://core-mosquitto:1883`. For a separate broker, use its reachable hostname or IP and port.
5. Save, then start the app. Check **Log** for the ready message. Restart the app after configuration changes.

Home Assistant discovers a **Doorbell** event and **Camera activity** event for supported Wuuk devices. Events require internet access to Wuuk and Firebase.

Battery polling is enabled by default for a Y0210 paired with a B0210. It uses the app host’s network to discover the base station on the same IPv4 broadcast network and reads the percentage over the LAN. Disable **LAN battery polling** if you only want events. The default polling interval is 900 seconds.

Passwords are masked in the Configuration form. The app keeps its Firebase receiver registration in its private persistent data directory.

## Troubleshooting

- If the app cannot sign in, check that the same Wuuk account can sign in with email and password in the Wuuk mobile app and that the doorbell appears there.
- If Home Assistant does not show the event entities, check the app log for MQTT connection errors and confirm that the app and Home Assistant use the same broker and discovery prefix. The default prefix is `homeassistant`.
- If events work but battery is missing, confirm that LAN battery polling is enabled, the model pair is Y0210/B0210, and the app host and base station are on the same IPv4 broadcast network.
