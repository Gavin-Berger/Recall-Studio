const dgram = require("dgram");

const client = dgram.createSocket("udp4");

setInterval(() => {
  const message = Buffer.from("/recall/heartbeat RecallStudioDevice 1.0.0");

  client.send(message, 9000, "127.0.0.1", (error) => {
    if (error) {
      console.error("Failed to send heartbeat:", error);
      return;
    }

    console.log("sent heartbeat");
  });
}, 2000);