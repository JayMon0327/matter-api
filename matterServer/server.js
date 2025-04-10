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
    logPath: '/home/ubuntu/matter-api/matterServer/logs',  // 로그 저장 경로
    // 개발용 PAA 인증서 경로 (기본값)
    paaStorePath: process.env.MATTER_PAA_STORE_PATH || '/home/ubuntu/connectedhomeip/credentials/development/paa-root-certs'
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

                // 상세 로깅 추가
                logToFile('DEBUG', '=== Matter SDK 명령어 실행 결과 시작 ===');
                logToFile('DEBUG', `표준 출력 타입: ${typeof stdout}`);
                logToFile('DEBUG', `표준 출력 길이: ${stdout.length}`);
                logToFile('DEBUG', '표준 출력 내용:');
                logToFile('DEBUG', stdout);
                
                // stdout에서 [DIS] 태그가 있는 라인만 추출하여 로깅
                const disLines = stdout.split('\n')
                    .filter(line => line.includes('[DIS]'))
                    .join('\n');
                
                logToFile('DEBUG', '=== [DIS] 태그 포함된 라인만 ===');
                logToFile('DEBUG', disLines);
                logToFile('DEBUG', '=== Matter SDK 명령어 실행 결과 끝 ===');

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

        // ANSI 이스케이프 시퀀스 제거 함수
        const removeAnsiEscapes = (str) => {
            return str.replace(/\x1b\[[0-9;]*m/g, '');
        };

        // 결과를 줄 단위로 분석
        const lines = result.split('\n');
        for (const line of lines) {
            // [DIS] 태그가 있는 라인만 처리
            if (!line.includes('[DIS]')) {
                continue;
            }

            const cleanLine = removeAnsiEscapes(line.trim());
            
            // 새로운 디바이스 시작
            if (cleanLine.includes('Discovered commissionable/commissioner node:')) {
                if (currentDevice) {
                    devices.push(currentDevice);
                }
                currentDevice = {
                    nodeId: '',              // Matter 노드 ID
                    name: '',                // 디바이스 이름
                    setupPinCode: '',        // Matter 설정 PIN 코드
                    setupDiscriminator: '',  // Matter discriminator
                    vendorId: '',           // 벤더 ID
                    productId: '',          // 제품 ID
                    deviceType: '',         // 디바이스 타입
                    instanceName: '',       // 인스턴스 이름
                    addresses: [],          // IP 주소 목록
                    port: '',              // 포트
                    pairingHint: '',       // 페어링 힌트
                    commissioningMode: '', // 커미셔닝 모드
                    type: 'wifi'           // 네트워크 타입 (wifi/thread)
                };
                continue;
            }

            if (!currentDevice) continue;

            // 값 추출 함수
            const extractValue = (line, key) => {
                const parts = line.split(key + ':');
                if (parts.length > 1) {
                    return removeAnsiEscapes(parts[1].trim());
                }
                return '';
            };

            // 디바이스 정보 파싱
            if (cleanLine.includes('Hostname:')) {
                currentDevice.name = extractValue(cleanLine, 'Hostname');
            }
            else if (cleanLine.includes('IP Address #')) {
                const address = cleanLine.split('IP Address #')[1].split(':').slice(1).join(':').trim();
                if (address && address !== 'not present') {
                    currentDevice.addresses.push(address);
                }
            }
            else if (cleanLine.includes('Port:')) {
                currentDevice.port = extractValue(cleanLine, 'Port');
            }
            else if (cleanLine.includes('Long Discriminator:')) {
                currentDevice.setupDiscriminator = extractValue(cleanLine, 'Long Discriminator');
            }
            else if (cleanLine.includes('Vendor ID:')) {
                currentDevice.vendorId = extractValue(cleanLine, 'Vendor ID');
            }
            else if (cleanLine.includes('Product ID:')) {
                currentDevice.productId = extractValue(cleanLine, 'Product ID');
            }
            else if (cleanLine.includes('Device Type:')) {
                currentDevice.deviceType = extractValue(cleanLine, 'Device Type');
            }
            else if (cleanLine.includes('Instance Name:')) {
                currentDevice.instanceName = extractValue(cleanLine, 'Instance Name');
            }
            else if (cleanLine.includes('Pairing Hint:')) {
                currentDevice.pairingHint = extractValue(cleanLine, 'Pairing Hint');
            }
            else if (cleanLine.includes('Commissioning Mode:')) {
                currentDevice.commissioningMode = extractValue(cleanLine, 'Commissioning Mode');
            }
        }

        // 마지막 디바이스 추가
        if (currentDevice) {
            devices.push(currentDevice);
        }

        // nodeId 자동 생성 및 할당
        return devices.map((device, index) => ({
            ...device,
            nodeId: (index + 1).toString()
        }));

    } catch (error) {
        logToFile('ERROR', `디바이스 검색 결과 파싱 중 오류: ${error.message}`);
        logToFile('ERROR', `파싱 시도한 원본 데이터: ${result}`);
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

// Matter 디바이스 Wi-Fi 페어링 및 커미셔닝
app.post("/api/device/setup", async (req, res) => {
    const { 
        nodeId,            // Matter 노드 ID
        setupPinCode,      // Matter 설정 PIN 코드
        setupDiscriminator,// Matter discriminator
        ssid,             // Wi-Fi SSID
        password,         // Wi-Fi 비밀번호
        paaStorePath      // 선택사항: 커스텀 PAA 인증서 경로
    } = req.body;

    try {
        logToFile('DEBUG', `Wi-Fi 페어링 및 커미셔닝 요청 수신 - 요청 데이터: ${JSON.stringify({
            nodeId,
            setupDiscriminator,
            ssid,
            setupPinCode: '***',
            password: '***'
        }, null, 2)}`);

        // 필수 파라미터 검증
        if (!setupPinCode || !ssid || !password) {
            const error = new Error("필수 파라미터가 누락되었습니다. (setupPinCode, ssid, password)");
            logToFile('ERROR', error.message);
            return res.status(400).json({
                status: "error",
                message: error.message
            });
        }

        // 디바이스 상태 확인
        const deviceInfo = deviceState.get(nodeId);
        if (!deviceInfo) {
            const error = new Error(`디바이스를 찾을 수 없습니다. (nodeId: ${nodeId})`);
            logToFile('ERROR', error.message);
            return res.status(404).json({
                status: "error",
                message: error.message
            });
        }

        logToFile('INFO', `Wi-Fi 페어링 및 커미셔닝 시작 - Device: ${deviceInfo.name}, SSID: ${ssid}`);
        
        // PAA 인증서 경로 설정
        const paaCertPath = paaStorePath || MATTER_CONFIG.paaStorePath;
        
        // Wi-Fi 페어링 및 커미셔닝 명령어 구성
        const command = `pairing code-wifi ${nodeId} "${ssid}" "${password}" ${setupPinCode} --paa-trust-store-path ${paaCertPath}`;
        
        logToFile('INFO', `페어링 및 커미셔닝 명령어 실행 (민감 정보 제외): pairing code-wifi ${nodeId} [SSID] [PASSWORD] [SETUP_PIN_CODE] --paa-trust-store-path ${paaCertPath}`);
        
        const result = await executeMatterCommand(command);

        // 디바이스 상태 업데이트
        const updatedDeviceInfo = {
            ...deviceInfo,
            status: 'commissioned',
            network: {
                ssid: ssid,
                timestamp: new Date().toISOString()
            },
            setupPinCode,
            setupDiscriminator
        };
        
        deviceState.set(nodeId, updatedDeviceInfo);

        res.json({
            status: "success",
            message: "Wi-Fi 페어링 및 커미셔닝 완료",
            deviceInfo: {
                ...updatedDeviceInfo,
                // 민감 정보 제외
                network: {
                    ssid: ssid,
                    timestamp: new Date().toISOString()
                }
            }
        });
    } catch (error) {
        logToFile('ERROR', `페어링 및 커미셔닝 중 오류 발생: ${error.message}`);
        logToFile('ERROR', `스택 트레이스: ${error.stack}`);
        const errorDetails = handleMatterError(error);
        res.status(500).json({
            status: "error",
            ...errorDetails
        });
    }
});

// Matter 디바이스 검색
app.get("/api/device/search", async (req, res) => {
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
