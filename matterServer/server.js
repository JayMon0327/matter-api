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
    chipToolPath: 'out/chip-tool/chip-tool',  // 수정된 정확한 chip-tool 경로
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
    try {
        const timestamp = new Date().toISOString();
        const logFile = path.join(MATTER_CONFIG.logPath, `matter_${new Date().toISOString().split('T')[0]}.log`);
        const logMessage = `[${timestamp}] [${type}] ${message}\n`;
        
        fs.appendFileSync(logFile, logMessage);
        console.log(logMessage.trim());
    } catch (error) {
        console.error('로깅 중 오류 발생:', error);
    }
};

// 프로세스 에러 처리
process.on('uncaughtException', (error) => {
    logToFile('ERROR', `예기치 않은 에러 발생: ${error.message}`);
    logToFile('ERROR', `스택 트레이스: ${error.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
    logToFile('ERROR', `처리되지 않은 Promise 거부: ${reason}`);
});

// 서버 종료 처리
process.on('SIGTERM', () => {
    logToFile('INFO', '서버 종료 신호 수신 (SIGTERM)');
    gracefulShutdown();
});

process.on('SIGINT', () => {
    logToFile('INFO', '서버 종료 신호 수신 (SIGINT)');
    gracefulShutdown();
});

const gracefulShutdown = () => {
    logToFile('INFO', '서버 종료 프로세스 시작...');
    server.close(() => {
        logToFile('INFO', '서버가 정상적으로 종료되었습니다.');
        process.exit(0);
    });

    // 10초 후에도 종료되지 않으면 강제 종료
    setTimeout(() => {
        logToFile('ERROR', '서버 강제 종료 (타임아웃)');
        process.exit(1);
    }, 10000);
};

// 디바이스 상태 관리
const deviceState = new Map();

// Matter 명령어 실행 함수
const executeMatterCommand = (command, timeout = MATTER_CONFIG.timeout) => {
    return new Promise((resolve, reject) => {
        try {
            // 전체 명령어 경로 구성
            const chipToolFullPath = path.join(MATTER_CONFIG.sdkPath, MATTER_CONFIG.chipToolPath);
            const fullCommand = `cd ${MATTER_CONFIG.sdkPath} && ${chipToolFullPath} ${command}`;
            
            logToFile('COMMAND', `실행: ${fullCommand}`);
            
            // 실행 파일 존재 확인
            if (!fs.existsSync(chipToolFullPath)) {
                const error = new Error(`chip-tool이 존재하지 않습니다: ${chipToolFullPath}`);
                logToFile('ERROR', error.message);
                reject(error);
                return;
            }
            
            const childProcess = exec(fullCommand, { timeout }, (error, stdout, stderr) => {
                if (error) {
                    logToFile('ERROR', `실행 오류: ${error.message}`);
                    logToFile('ERROR', `표준 에러: ${stderr}`);
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

            childProcess.on('error', (error) => {
                logToFile('ERROR', `자식 프로세스 오류: ${error.message}`);
                reject(error);
            });
        } catch (error) {
            logToFile('ERROR', `명령어 실행 중 예외 발생: ${error.message}`);
            reject(error);
        }
    });
};

// Matter 에러 처리 함수
const handleMatterError = (error) => {
    logToFile('ERROR_HANDLER', `에러 처리: ${error.message}`);
    
    // Matter SDK의 타임아웃 에러 확인 (CHIP Error: Timeout)
    if (error.message.includes("Timeout") || error.stderr?.includes("Timeout")) {
        return {
            code: "TIMEOUT_ERROR",
            message: "Matter 명령어 실행이 시간 초과되었습니다."
        };
    }
    
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
    
    // 기타 Matter SDK 관련 에러 메시지 처리
    if (error.stderr) {
        return {
            code: "MATTER_SDK_ERROR",
            message: `Matter SDK 오류: ${error.stderr}`
        };
    }
    
    return {
        code: "UNKNOWN_ERROR",
        message: `알 수 없는 오류가 발생했습니다: ${error.message}`
    };
};

// 1. 디바이스 검색 시작
app.post("/api/discovery/scan", async (req, res) => {
    try {
        logToFile('INFO', "Matter 디바이스 검색 시작...");
        const command = `discover commissionables`;
        
        const result = await executeMatterCommand(command);
        
        res.json({
            status: "success",
            message: "커미셔닝 가능한 디바이스 검색 완료",
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

// 2. 디바이스 검색 중지
app.post("/api/discovery/stop", async (req, res) => {
    try {
        logToFile('INFO', "Matter 디바이스 검색 중지...");
        const command = `discover stop`;
        
        const result = await executeMatterCommand(command);
        
        res.json({
            status: "success",
            message: "디바이스 검색이 중지되었습니다.",
            result: result
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 3. 발견된 디바이스 목록 조회
app.get("/api/discovery/list", async (req, res) => {
    try {
        logToFile('INFO', "발견된 Matter 디바이스 목록 조회...");
        const command = `discover list`;
        
        const result = await executeMatterCommand(command);
        
        // 결과가 비어있는 경우 처리
        if (!result || result.trim() === '') {
            return res.json({
                status: "success",
                message: "발견된 디바이스가 없습니다.",
                devices: []
            });
        }
        
        res.json({
            status: "success",
            message: "발견된 디바이스 목록 조회 완료",
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
const server = app.listen(PORT, () => {
    logToFile('SERVER', `Matter Bridge Server running on port ${PORT}`);
    logToFile('CONFIG', `Matter SDK Path: ${MATTER_CONFIG.sdkPath}`);
    logToFile('CONFIG', `Chip Tool Path: ${path.join(MATTER_CONFIG.sdkPath, MATTER_CONFIG.chipToolPath)}`);
});

// 서버 에러 처리
server.on('error', (error) => {
    logToFile('ERROR', `서버 에러 발생: ${error.message}`);
});
