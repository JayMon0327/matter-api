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
    
    // Matter SDK의 타임아웃 에러 확인 (CHIP Error 0x00000032: Timeout)
    if (error.message.includes("CHIP Error 0x00000032: Timeout") || 
        error.stderr?.includes("CHIP Error 0x00000032: Timeout")) {
        return {
            code: "TIMEOUT_ERROR",
            message: "Matter 명령어 실행이 시간 초과되었습니다.",
            errorCode: "0x00000032"
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
    
    // Matter SDK 에러 코드 패턴 확인 (CHIP Error 0x...)
    const chipErrorMatch = (error.message || error.stderr || '').match(/CHIP Error (0x[0-9a-fA-F]+)/);
    if (chipErrorMatch) {
        return {
            code: "MATTER_SDK_ERROR",
            message: `Matter SDK 오류가 발생했습니다.`,
            errorCode: chipErrorMatch[1]
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

// Matter 디바이스 검색 결과 파싱 함수
const parseDiscoveryResult = (result) => {
    try {
        if (!result || result.trim() === '') {
            return [];
        }

        const devices = [];
        let currentDevice = null;

        // 타임스탬프와 로그 레벨 제거 함수
        const cleanLine = (line) => {
            // [1744266250.301] [47866:47868] [DIS] 와 같은 prefix 제거
            return line.replace(/\[\d+\.\d+\]\s*\[\d+:\d+\]\s*\[\w+\]\s*/, '').trim();
        };

        // 값 추출 함수
        const extractValue = (line) => {
            const colonIndex = line.indexOf(':');
            if (colonIndex === -1) return '';
            return line.substring(colonIndex + 1).trim();
        };

        // 결과를 줄 단위로 분석
        const lines = result.split('\n');
        for (const line of lines) {
            const cleanedLine = cleanLine(line);
            
            // 새로운 디바이스 시작
            if (cleanedLine === 'Discovered commissionable/commissioner node:') {
                if (currentDevice) {
                    devices.push(currentDevice);
                }
                currentDevice = {
                    name: '',
                    addresses: [],
                    port: '',
                    vendorId: '',
                    productId: '',
                    deviceType: '',
                    discriminator: '',
                    pairingHint: '',
                    instanceName: '',
                    commissioningMode: '',
                    supportsCommissionerGeneratedPasscode: false
                };
                continue;
            }

            if (!currentDevice) continue;

            // 디바이스 정보 파싱
            if (cleanedLine.startsWith('Hostname:')) {
                currentDevice.name = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('IP Address #')) {
                const address = extractValue(cleanedLine);
                if (address) {
                    currentDevice.addresses.push(address);
                }
            }
            else if (cleanedLine.startsWith('Port:')) {
                currentDevice.port = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Vendor ID:')) {
                currentDevice.vendorId = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Product ID:')) {
                currentDevice.productId = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Device Type:')) {
                currentDevice.deviceType = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Long Discriminator:')) {
                currentDevice.discriminator = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Pairing Hint:')) {
                currentDevice.pairingHint = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Instance Name:')) {
                currentDevice.instanceName = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Commissioning Mode:')) {
                currentDevice.commissioningMode = extractValue(cleanedLine);
            }
            else if (cleanedLine.startsWith('Supports Commissioner Generated Passcode:')) {
                currentDevice.supportsCommissionerGeneratedPasscode = 
                    extractValue(cleanedLine).toLowerCase() === 'true';
            }
        }

        // 마지막 디바이스 추가
        if (currentDevice) {
            devices.push(currentDevice);
        }

        // nodeId 자동 생성 및 할당
        return devices.map((device, index) => ({
            ...device,
            nodeId: (index + 1).toString(),
            type: 'wifi'
        }));

    } catch (error) {
        logToFile('ERROR', `디바이스 검색 결과 파싱 중 오류: ${error.message}`);
        return [];
    }
};

// NodeId 생성 함수
const generateNodeId = (() => {
    let lastId = 0;
    return () => {
        lastId += 1;
        return lastId.toString();
    };
})();

// 디바이스 타입 감지 함수
const detectDeviceType = (deviceInfo) => {
    // Matter SDK의 출력을 분석하여 디바이스 타입 판단
    if (deviceInfo.toLowerCase().includes('wifi')) {
        return 'wifi';
    } else if (deviceInfo.toLowerCase().includes('thread')) {
        return 'thread';
    }
    return 'unknown';
};

// 1. Matter 디바이스 검색 시작
app.post("/api/device/search", async (req, res) => {
    try {
        logToFile('INFO', `Matter 디바이스 검색 시작`);
        const command = `discover commissionables`;
        const result = await executeMatterCommand(command);
        const devices = parseDiscoveryResult(result);

        // 검색된 디바이스 정보 저장
        devices.forEach(device => {
            deviceState.set(device.nodeId, {
                ...device,
                status: 'discovered',
                timestamp: new Date().toISOString()
            });
        });

        res.json({
            status: "success",
            message: devices.length > 0 ? "디바이스 검색 완료" : "검색된 디바이스가 없습니다.",
            devices: devices
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 2. 검색된 디바이스와 페어링 시도
app.post("/api/device/pair", async (req, res) => {
    const { deviceId, manualPairingCode } = req.body;

    if (!manualPairingCode) {
        return res.status(400).json({
            status: "error",
            message: "Matter 설정 코드는 필수 항목입니다."
        });
    }

    try {
        // 디바이스 정보 조회
        const deviceInfo = deviceState.get(deviceId);
        if (!deviceInfo) {
            return res.status(404).json({
                status: "error",
                message: "디바이스를 찾을 수 없습니다."
            });
        }

        logToFile('INFO', `페어링 시작 - Device: ${deviceInfo.name}, Manual Pairing Code: ${manualPairingCode}`);
        const command = `pairing code ${deviceId} ${manualPairingCode}`;
        const result = await executeMatterCommand(command);

        // 디바이스 상태 업데이트
        deviceState.set(deviceId, {
            ...deviceInfo,
            manualPairingCode,
            status: 'paired',
            pairingTimestamp: new Date().toISOString()
        });

        res.json({
            status: "success",
            message: "디바이스 페어링 완료",
            deviceInfo: deviceState.get(deviceId)
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 3. 페어링된 디바이스 Wi-Fi 커미셔닝
app.post("/api/device/commission", async (req, res) => {
    const { 
        deviceId,
        ssid,      // 선택사항: 현재 연결된 Wi-Fi 정보
        password   // 선택사항: 현재 연결된 Wi-Fi 정보
    } = req.body;

    try {
        // 디바이스 정보 조회
        const deviceInfo = deviceState.get(deviceId);
        if (!deviceInfo) {
            return res.status(404).json({
                status: "error",
                message: "디바이스를 찾을 수 없습니다."
            });
        }

        if (deviceInfo.status !== 'paired') {
            return res.status(400).json({
                status: "error",
                message: "페어링이 완료되지 않은 디바이스입니다."
            });
        }

        // Wi-Fi 정보 확인
        const wifiSSID = ssid || process.env.WIFI_SSID;
        const wifiPassword = password || process.env.WIFI_PASSWORD;

        if (!wifiSSID || !wifiPassword) {
            return res.status(400).json({
                status: "error",
                message: "Wi-Fi 정보가 제공되지 않았습니다."
            });
        }

        logToFile('INFO', `Wi-Fi 커미셔닝 시작 - Device: ${deviceInfo.name}, SSID: ${wifiSSID}`);
        const command = `pairing ble-wifi ${deviceId} ${deviceInfo.discriminator} "${wifiSSID}" "${wifiPassword}"`;
        const result = await executeMatterCommand(command);

        // 디바이스 상태 업데이트
        deviceState.set(deviceId, {
            ...deviceInfo,
            status: 'commissioned',
            network: {
                ssid: wifiSSID,
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            status: "success",
            message: "Wi-Fi 커미셔닝 완료",
            deviceInfo: deviceState.get(deviceId)
        });
    } catch (error) {
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// 기존 API들은 디버깅 및 테스트용으로 유지
// 1. 디바이스 검색 시작
app.post("/api/discovery/scan", async (req, res) => {
    try {
        logToFile('INFO', "Matter 디바이스 검색 시작...");
        const command = `discover commissionables`;
        
        const result = await executeMatterCommand(command);
        const devices = parseDiscoveryResult(result);
        
        // 검색된 디바이스 정보를 메모리에 저장
        devices.forEach(device => {
            deviceState.set(device.nodeId, {
                ...device,
                status: 'discovered',
                timestamp: new Date().toISOString()
            });
        });

        res.json({
            status: "success",
            message: "커미셔닝 가능한 디바이스 검색 완료",
            devices: devices
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
        const devices = parseDiscoveryResult(result);
        
        // 메모리에 저장된 디바이스 상태 정보 추가
        const devicesWithState = devices.map(device => {
            const state = deviceState.get(device.nodeId);
            return {
                ...device,
                status: state?.status || 'discovered',
                lastSeen: state?.timestamp || new Date().toISOString()
            };
        });

        res.json({
            status: "success",
            message: devices.length > 0 ? "발견된 디바이스 목록 조회 완료" : "발견된 디바이스가 없습니다.",
            devices: devicesWithState
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
