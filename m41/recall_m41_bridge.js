const maxApi = require("max-api");
const dgram = require("dgram");

const HOST = "127.0.0.1";
const PORT = 9000;

const DEVICE_VERSION = "0.1.0";
const SOURCE = "max_for_live";

const client = dgram.createSocket("udp4");

let heartbeatInterval = null;

function nowMs() {
  return Date.now();
}

function sendRecallEvent(event) {
  const message = Buffer.from(JSON.stringify(event));

  client.send(message, PORT, HOST, (error) => {
    if (error) {
      maxApi.post(`Recall Studio UDP send failed: ${error.message}`);
      return;
    }

    maxApi.post(`Recall event sent: ${event.event_type}`);
  });
}

function createEvent(eventType, title, description, payload = null) {
  return {
    protocol: "recall.v1",
    source: SOURCE,
    event_type: eventType,
    timestamp_ms: nowMs(),
    title,
    description,
    payload: payload ? JSON.stringify(payload) : null,
    session_id: null,
  };
}

function sendHeartbeat() {
  sendRecallEvent(
    createEvent(
      "heartbeat",
      "Max for Live Heartbeat",
      "Recall Studio Max for Live device is connected.",
      {
        device_version: DEVICE_VERSION,
        transport: "max_for_live",
      }
    )
  );
}

function sendDeviceLoaded() {
  sendRecallEvent(
    createEvent(
      "device_loaded",
      "Max for Live Device Loaded",
      "Recall Studio Max for Live device was loaded in Ableton.",
      {
        device_version: DEVICE_VERSION,
        host: HOST,
        port: PORT,
      }
    )
  );
}

function startBridge() {
  if (heartbeatInterval) {
    maxApi.post("Recall Studio bridge already running.");
    return;
  }

  sendDeviceLoaded();
  sendHeartbeat();

  heartbeatInterval = setInterval(sendHeartbeat, 2000);

  maxApi.post("Recall Studio bridge started.");
}

function stopBridge() {
  if (!heartbeatInterval) {
    maxApi.post("Recall Studio bridge is not running.");
    return;
  }

  clearInterval(heartbeatInterval);
  heartbeatInterval = null;

  sendRecallEvent(
    createEvent(
      "device_unloaded",
      "Max for Live Device Stopped",
      "Recall Studio Max for Live bridge stopped.",
      {
        device_version: DEVICE_VERSION,
      }
    )
  );

  maxApi.post("Recall Studio bridge stopped.");
}

maxApi.addHandler("start", () => {
  startBridge();
});

maxApi.addHandler("stop", () => {
  stopBridge();
});

maxApi.addHandler("send_test_event", () => {
  sendRecallEvent(
    createEvent(
      "m4l_test_event",
      "Max for Live Test Event",
      "Manual test event sent from the Max for Live device.",
      {
        device_version: DEVICE_VERSION,
      }
    )
  );
});

maxApi.post("Recall Studio Max for Live bridge script loaded.");