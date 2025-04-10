const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const path = require("path");
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Matter SDK 설정
const MATTER_CONFIG = {
    sdkPath: process.env.MATTER_SDK_PATH || '/home/ubuntu/connectedhomeip',
    chipToolPath: 'out/debug/standalone/chip-tool',  // SDK 내의 chip-tool 상대 경로
    fabricId: process.env.MATTER_FABRIC_ID,
    defaultNodeId: "1",
    timeout: 60000,
    logPath: '/home/ubuntu/matter-api/matterServer/logs'  // 로그 저장 경로
};

// 로그 디렉토리 생성
if (!fs.existsSync(MATTER_CONFIG.logPath)) {
    fs.mkdirSync(MATTER_CONFIG.logPath, { recursive: true });
}

// 로깅 함수
const logToFile = (type, message) => {
    const timestamp = new Date().toISOString();
    const logFile = path.join(MATTER_CONFIG.logPath, `matter_${new Date().toISOString().split('T')[0]}.log`);
    const logMessage = `[${timestamp}] [${type}] ${message}\n`;
    
    fs.appendFileSync(logFile, logMessage);
    console.log(logMessage.trim());
};

// 디바이스 상태 관리
const deviceState = new Map();

// Matter 명령어 실행 함수
const executeMatterCommand = (command, timeout = MATTER_CONFIG.timeout) => {
    return new Promise((resolve, reject) => {
        // 전체 명령어 경로 구성
        const fullCommand = `cd ${MATTER_CONFIG.sdkPath} && ./${MATTER_CONFIG.chipToolPath} ${command}`;
        logToFile('COMMAND', `실행: ${fullCommand}`);
        
        const childProcess = exec(fullCommand, { timeout }, (error, stdout, stderr) => {
            if (error) {
                logToFile('ERROR', `실행 오류: ${stderr}`);
                reject(error);
                return;
            }
            logToFile('SUCCESS', `실행 결과: ${stdout}`);
            resolve(stdout);
        });

        // 실시간 출력 로깅
        childProcess.stdout.on('data', (data) => {
            logToFile('STDOUT', data.toString().trim());
        });

        childProcess.stderr.on('data', (data) => {
            logToFile('STDERR', data.toString().trim());
        });
    });
};

// Matter 에러 처리 함수
const handleMatterError = (error) => {
    logToFile('ERROR_HANDLER', `에러 처리: ${error.message}`);
    
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
    if (error.message.includes("not found")) {
        return {
            code: "COMMAND_NOT_FOUND",
            message: "Matter SDK 명령어를 찾을 수 없습니다. SDK 경로를 확인해주세요."
        };
    }
    return {
        code: "UNKNOWN_ERROR",
        message: `알 수 없는 오류가 발생했습니다: ${error.message}`
    };
};

// 1. 디바이스 검색 엔드포인트
app.post("/api/discovery/scan", async (req, res) => {
    try {
        logToFile('INFO', "Matter 디바이스 검색 시작...");
        const command = `discover`;
        
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
        logToFile('INFO', `페어링 시작 - NodeID: ${nodeId}, SetupCode: ${setupCode}`);
        
        const command = `pairing code ${nodeId} ${setupCode}`;
        const result = await executeMatterCommand(command);

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
        logToFile('INFO', `Wi-Fi 커미셔닝 시작 - NodeID: ${nodeId}, SSID: ${ssid}`);
        
        const command = `pairing ble-wifi ${nodeId} ${discriminator} "${ssid}" "${password}"`;
        const result = await executeMatterCommand(command);

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

// 4. 로그 조회 엔드포인트
app.get("/api/logs", (req, res) => {
    const { date } = req.query;
    const logDate = date || new Date().toISOString().split('T')[0];
    const logFile = path.join(MATTER_CONFIG.logPath, `matter_${logDate}.log`);

    try {
        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8');
            res.json({
                status: "success",
                date: logDate,
                logs: logs.split('\n').filter(Boolean)
            });
        } else {
            res.status(404).json({
                status: "error",
                message: `${logDate} 날짜의 로그를 찾을 수 없습니다.`
            });
        }
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: "로그 조회 중 오류가 발생했습니다.",
            error: error.message
        });
    }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logToFile('SERVER', `Matter Bridge Server running on port ${PORT}`);
    logToFile('CONFIG', `Matter SDK Path: ${MATTER_CONFIG.sdkPath}`);
    logToFile('CONFIG', `Chip Tool Path: ${path.join(MATTER_CONFIG.sdkPath, MATTER_CONFIG.chipToolPath)}`);
});
