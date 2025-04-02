import express from "express";
import { exec } from "child_process";

const app = express();
const PORT = 3000;

app.use(express.json());

app.post("/api/pairing/code", (req, res) => {
  const {
    nodeId,
    manualPairingCode,
    discriminator,
    deviceAddress, // "BLE" or IP (ex: "192.168.1.100")
    networkType,   // "wifi" or "thread"
  } = req.body;

  let command = "";

  if (deviceAddress === "BLE") {
    // BLE 기반 pairing 명령어
    // Wi-Fi SSID/PW는 실제 구현 시 따로 받거나 dotenv 등으로 관리
    const ssid = process.env.WIFI_SSID || "TestSSID";
    const password = process.env.WIFI_PASSWORD || "TestPassword";

    if (networkType === "wifi") {
      command = `chip-tool pairing ble-wifi ${nodeId} ${discriminator} ${ssid} ${password}`;
    } else if (networkType === "thread") {
      // Thread dataset이 필요
      const dataset = process.env.THREAD_DATASET || "hex:..."; // 예시
      command = `chip-tool pairing ble-thread ${nodeId} ${discriminator} ${dataset}`;
    } else {
      return res.status(400).json({ error: "Invalid networkType" });
    }
  } else {
    // 수동 코드 기반 pairing
    command = `chip-tool pairing code ${nodeId} ${manualPairingCode}`;
  }

  console.log("▶️ 실행 명령어:", command);

  exec(command, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Error:", err.message);
      return res.status(500).json({ error: err.message });
    }

    console.log("✅ stdout:", stdout);
    res.json({ result: stdout });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Matter pairing API server running at http://localhost:${PORT}`);
});
