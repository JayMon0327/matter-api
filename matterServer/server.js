const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Matter 설정
const MATTER_CONFIG = {
    chipPath: process.env.MATTER_TOOL_PATH || "chip-tool",
    fabricId: process.env.MATTER_FABRIC_ID,
    defaultNodeId: "1",  // 기본 노드 ID
    timeout: 60000       // 커맨드 타임아웃 (60초)
};

// 디바이스 상태 관리
const deviceState = new Map();

// Matter 명령어 실행 함수
const executeMatterCommand = (command, timeout = MATTER_CONFIG.timeout) => {
    return new Promise((resolve, reject) => {
        console.log(`📡 실행 명령어: ${command}`);
        
        const childProcess = exec(command, { timeout }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ 오류 발생:`, stderr);
                reject(error);
                return;
            }
            console.log(`✅ 실행 결과:`, stdout);
            resolve(stdout);
        });
    });
};

// Matter 에러 처리 함수
const handleMatterError = (error) => {
    if (error.message.includes("CHIP:BLE")) {
        return {
            code: "BLE_ERROR",
            message: "BLE 연결 중 오류가 발생했습니다."
        };
    }
    if (error.message.includes("CHIP:DMG")) {
        return {
            code: "DATA_MODEL_ERROR",
            message: "데이터 모델 처리 중 오류가 발생했습니다."
        };
    }
    return {
        code: "UNKNOWN_ERROR",
        message: "알 수 없는 오류가 발생했습니다."
    };
};

// 1. 디바이스 검색 엔드포인트
app.post("/api/discovery/scan", async (req, res) => {
    try {
        console.log("🔍 Matter 디바이스 검색 시작...");
        const command = `${MATTER_CONFIG.chipPath} discover`;
        
        const result = await executeMatterCommand(command);
        
        res.json({
            status: "success",
            message: "디바이스 검색 완료",
            devices: result
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 2. Matter 설정 코드 페어링 엔드포인트
app.post("/api/pairing/code", async (req, res) => {
    const {
        nodeId = MATTER_CONFIG.defaultNodeId,
        setupCode,
        discriminator
    } = req.body;

    if (!setupCode) {
        return res.status(400).json({
            status: "error",
            message: "설정 코드는 필수 항목입니다."
        });
    }

    try {
        console.log(`🔗 페어링 시작 - NodeID: ${nodeId}, SetupCode: ${setupCode}`);
        
        // Matter 페어링 명령어 실행
        const command = `${MATTER_CONFIG.chipPath} pairing code ${nodeId} ${setupCode}`;
        const result = await executeMatterCommand(command);

        // 디바이스 상태 저장
        deviceState.set(nodeId, {
            status: "paired",
            setupCode,
            discriminator,
            timestamp: new Date().toISOString()
        });

        res.json({
            status: "success",
            message: "디바이스 페어링 완료",
            deviceInfo: deviceState.get(nodeId),
            output: result
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 3. Wi-Fi 설정 및 커미셔닝 엔드포인트
app.post("/api/commissioning/wifi", async (req, res) => {
    const {
        nodeId = MATTER_CONFIG.defaultNodeId,
        ssid,
        password,
        discriminator
    } = req.body;

    if (!ssid || !password) {
        return res.status(400).json({
            status: "error",
            message: "Wi-Fi SSID와 비밀번호는 필수 항목입니다."
        });
    }

    try {
        console.log(`🌐 Wi-Fi 커미셔닝 시작 - NodeID: ${nodeId}, SSID: ${ssid}`);
        
        // Wi-Fi 커미셔닝 명령어 실행
        const command = `${MATTER_CONFIG.chipPath} pairing ble-wifi ${nodeId} ${discriminator} "${ssid}" "${password}"`;
        const result = await executeMatterCommand(command);

        // 디바이스 상태 업데이트
        const deviceInfo = deviceState.get(nodeId) || {};
        deviceState.set(nodeId, {
            ...deviceInfo,
            status: "commissioned",
            network: {
                ssid,
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            status: "success",
            message: "Wi-Fi 설정 및 커미셔닝 완료",
            deviceInfo: deviceState.get(nodeId),
            output: result
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Matter Bridge Server running on port ${PORT}`);
    console.log(`✨ Matter SDK Path: ${MATTER_CONFIG.chipPath}`);
});
