﻿'use strict';

import HardwareSocketMessageHandler from './hardware/hardwareSocketMessageHandler';
import HardwareMonitor from './hardware/hardwareMonitor';
import PopupHelper from './popup_helper';

enum HardwareModuleType {
    builtIn = 'builtin',
    module = 'module',
}

enum HardwareStatement {
    disconnected = 'disconnected',
    socketConnected = 'socketConnected',
    hardwareConnected = 'hardwareConnected',
}

export default class Hardware implements IEntry.Hardware {
    get httpsServerAddress() {
        return 'https://hw.playentry.org:23518';
    } // 하드웨어 프로그램 접속용 주소
    get httpsServerAddress2() {
        return 'https://hardware.playentry.org:23518';
    } // legacy
    get httpServerAddress() {
        return 'http://127.0.0.1:23518';
    } // http 인 오프라인 접속용 주소

    // socketIO 및 하드웨어 커넥션용
    private readonly sessionRoomId: string | null;
    private readonly socketConnectionRetryCount: number;
    private reconnectionTimeout: number;
    private programConnected: boolean;
    private socket: SocketIOClient.Socket; // 실제 연결된 소켓
    private socketMode: number;
    private socketConnectOption = {
        transports: ['websocket', 'polling'],
        query: {
            client: true,
            roomId: this.sessionRoomId,
        },
    };

    // entryjs 내 하드웨어모듈 통신용
    public portData: UnknownAny;
    public sendQueue: UnknownAny;

    // 현재 연결된 모듈 컨트롤용
    public hwModule?: IEntry.HardwareModule;
    public communicationType: string; // 'manual' || 'auto'
    private currentDeviceKey?: string;
    private hwModuleType: HardwareModuleType;
    private hwMonitor?: HardwareMonitor;

    // 하드웨어 설치여부 확인용
    private ieLauncher: { set: () => void };
    private popupHelper?: UnknownAny;
    private _w: any;

    constructor() {
        const prevRoomId = localStorage.getItem('entryhwRoomId');
        this.sessionRoomId = prevRoomId || this._createRandomRoomId();
        if (!prevRoomId) {
            localStorage.setItem('entryhwRoomId', this.sessionRoomId);
        }

        this.socketConnectionRetryCount = 3;
        this.programConnected = false;
        this.communicationType = 'auto';
        this.portData = {};
        this.sendQueue = {};
        this.hwModuleType = HardwareModuleType.builtIn;

        this._initHardwareObject();
        this._addEntryEventListener();
    }

    async _loadExternalHardwareBlock(moduleName: string) {
        try {
            await Entry.moduleManager.loadExternalModule(moduleName);
        } catch (e) {
            Entry.toast.alert(
                window.Lang.Hw.hw_module_load_fail_title,
                `${moduleName} ${window.Lang.Hw.hw_module_load_fail_desc}`,
            );
        }
    }

    retryConnect() {
        this._initSocket();
    }

    openHardwareProgram(args?: { [key: string]: string }) {
        this._alertUnderVersionUsed().then(() => {
            this._executeHardware(args);

            if (!this.socket || !this.socket.connected) {
                setTimeout(() => {
                    this._initSocket();
                }, 1000);
            }
        });
    }

    /**
     * 외부 하드웨어 모듈을 등록한다.
     * 이때 기존 외부 하드웨어 모듈이 추가되어있는 경우를 대비하여,
     * 현재 보여지고 있는 하드웨어 블록들을 전부 숨김처리한다.
     * @param moduleObject
     */
    setExternalModule(moduleObject: IEntry.HardwareModule) {
        this.hwModule = moduleObject;
        this.hwModuleType = HardwareModuleType.module;
        this._banClassAllHardware();
        Entry.dispatchEvent('hwChanged');
    }

    /**
     * 하드웨어 블록메뉴의 노출상태를 변경한다.
     * 최초 실행시 모든 하드웨어 블록 숨김 / 미연결 상태 버튼 출력
     * 현재 하드웨어 로드가 외부 모듈에 의한 것인 경우는 연결이 해제되어도 블록숨김을 실행하지 않는다.
     */
    refreshHardwareBlockMenu() {
        const workspace = Entry.getMainWS();
        const blockMenu = workspace && workspace.blockMenu;

        if (!blockMenu) {
            return;
        }

        if (!this.hwModule) {
            // NOTE 이 코드는 하드웨어 블록 초기화 작업도 겸하므로 삭제금지
            this._banClassAllHardware();
        }

        const { disconnected, socketConnected, hardwareConnected } = HardwareStatement;
        if (this.programConnected) {
            if (this.hwModule) {
                blockMenu.unbanClass(this.hwModule.name);
                this._setHardwareDefaultMenu(hardwareConnected);
            } else {
                this._setHardwareDefaultMenu(socketConnected);
            }
        } else {
            this._setHardwareDefaultMenu(disconnected);
        }

        blockMenu.hwCodeOutdated = true;
        blockMenu._generateHwCode(true);
        blockMenu.reDraw();
    }

    disconnectSocket() {
        if (this.programConnected) {
            Entry.propertyPanel && Entry.propertyPanel.removeMode('hw');
            this.programConnected = false;
            this.currentDeviceKey = undefined;

            /*
            entryjs 내에 존재하던 기존 하드웨어의 경우 원래 프로세스에 따라 연결 종료시 보여주지 않는다.
            만약 외부모듈인 경우, 하드웨어가 연결종료 되더라도 블록은 남는다.
             */
            if (this.hwModuleType === HardwareModuleType.builtIn) {
                this.hwModule = undefined;
            }

            this.socket && this.socket.close();
            this.socket = undefined;

            Entry.dispatchEvent('hwChanged');
            Entry.toast.alert(
                window.Lang.Hw.hw_module_terminaltion_title,
                window.Lang.Hw.hw_module_terminaltion_desc,
                false,
            );
        }
    }

    /**
     * @deprecated
     */
    setDigitalPortValue(port: any, value: any) {
        console.warn('this function will be deprecated. please use Entry.hw.sendQueue directly.');
        this.sendQueue[port] = value;
        this.removePortReadable(port);
    }

    /**
     * @deprecated
     */
    getAnalogPortValue(port: any) {
        console.warn('this function will be deprecated. please use Entry.hw.portData directly.');
        if (!this.programConnected || !this.hwModule) {
            return 0;
        }
        return this.portData[`a${port}`];
    }

    /**
     * @deprecated
     */
    getDigitalPortValue(port: any) {
        console.warn('this function will be deprecated. please use Entry.hw.portData directly.');
        if (!this.programConnected || !this.hwModule) {
            return 0;
        }
        this.setPortReadable(port);
        if (this.portData[port] !== undefined) {
            return this.portData[port];
        } else {
            return 0;
        }
    }

    /**
     * @deprecated
     */
    setPortReadable(port: any) {
        console.warn('this function will be deprecated. please control port state directly.');
        if (!this.sendQueue.readablePorts) {
            this.sendQueue.readablePorts = [];
        }

        let isPass = false;
        for (const i in this.sendQueue.readablePorts) {
            if (this.sendQueue.readablePorts[i] == port) {
                isPass = true;
                break;
            }
        }

        if (!isPass) {
            this.sendQueue.readablePorts.push(port);
        }
    }

    /**
     * @deprecated
     */
    removePortReadable(port: any) {
        console.warn('this function will be deprecated. please use Entry.hw.sendQueue directly.');
        if (!this.sendQueue.readablePorts && !Array.isArray(this.sendQueue.readablePorts)) {
            return;
        }
        let target;
        for (const i in this.sendQueue.readablePorts) {
            if (this.sendQueue.readablePorts[i] == port) {
                target = Number(i);
                break;
            }
        }

        if (target != undefined) {
            this.sendQueue.readablePorts = this.sendQueue.readablePorts
                .slice(0, target)
                .concat(
                    this.sendQueue.readablePorts.slice(
                        target + 1,
                        this.sendQueue.readablePorts.length,
                    ),
                );
        }
    }

    update() {
        if (!this.socket || this.socket.disconnected) {
            return;
        }

        if (this.hwModule && this.hwModule.sendMessage) {
            this.hwModule.sendMessage(this);
        } else {
            this._sendSocketMessage({
                data: JSON.stringify(this.sendQueue),
                mode: this.socketMode,
                type: 'utf8',
            });
        }

        this.hwModule && this.hwModule.afterSend && this.hwModule.afterSend(this.sendQueue);
    }


    closeConnection() {
        if (this.socket) {
            this.socket.close();
        }
    }

    downloadConnector() {
        Entry.dispatchEvent('hwDownload', 'hardware');
    }

    downloadGuide() {
        Entry.dispatchEvent('hwDownload', 'manual');
    }

    downloadSource() {
        Entry.dispatchEvent('hwDownload', 'ino');
    }

    setZero() {
        if (!this.hwModule) {
            return;
        }
        this.hwModule.setZero();
    }

    /**
     * 디바이스의 연결상태를 체크한다.
     * 만약 이미 바로 직전에 동일한 하드웨어와 연결된 경우는 dataHandler 로 데이터를 전송하기만 한다.
     * 새로운 하드웨어의 연결인 경우는 연결 하드웨어를 치환하고 엔트리에 상태변경을 요청한다.
     * @param data
     */
    checkDevice(data: HardwareMessageData) {
        if (data.company === undefined) {
            return;
        }

        const key = `${this._convertHexToString(data.company)}.${this._convertHexToString(
            data.model,
        )}`;

        if (this.currentDeviceKey && key === this.currentDeviceKey) {
            if (this.hwModule && this.hwModule.dataHandler) {
                this.hwModule.dataHandler(data);
            }
            return;
        }

        this.currentDeviceKey = key;
        this.hwModule = Entry.HARDWARE_LIST[key];
        if (!this.hwModule) {
            return;
        }
        this.communicationType = this.hwModule.communicationType || 'auto';
        this._banClassAllHardware();
        Entry.dispatchEvent('hwChanged');

        let descMsg = '';
        if (Entry.propertyPanel && this.hwModule.monitorTemplate) {
            descMsg = window.Lang.Msgs.hw_connection_success_desc;
            this._setHardwareMonitorTemplate();
        } else {
            descMsg = window.Lang.Msgs.hw_connection_success_desc2;
        }
        Entry.toast.success(window.Lang.Msgs.hw_connection_success, descMsg);
    }

    openHardwareDownloadPopup() {
        if (Entry.events_.openHardWareDownloadModal) {
            Entry.dispatchEvent('openHardWareDownloadModal');
        } else {
            this.popupHelper.show('hwDownload', true);
        }
    }


    private _initHardwareObject() {
        const { hardwareEnable } = Entry;
        this._hwPopupCreate();
        hardwareEnable && this._initSocket();
    }

    private _addEntryEventListener() {
        // hwChanged 에 걸려있는 다른 이벤트 함수와 동일선상에 두기위함
        Entry.addEventListener('hwChanged', this.refreshHardwareBlockMenu.bind(this));
        Entry.addEventListener('stop', this.setZero.bind(this));
    }

    private _createRandomRoomId() {
        return 'xxxxxxxxyx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    private _trySocketConnect(url: string) {
        return new Promise((resolve, reject) => {
            const socket = io.connect(url, this.socketConnectOption);
            socket.io.reconnectionAttempts(this.socketConnectionRetryCount);
            socket.io.reconnectionDelayMax(1000);
            socket.io.timeout(1000);
            socket.on('connect', () => {
                this._handleSocketConnected(socket);
                resolve();
            });
            socket.on('reconnect_failed', () => {
                reject();
            });
        });
    }

    private _handleSocketConnected(socket: SocketIOClient.Socket) {
        socket.removeEventListener('reconnect_failed');
        socket.removeEventListener('connect');
        // this._initHardware(socket);
        this.socket = socket;
        this._setSocketConnected();
        if (Entry.playground && Entry.playground.object) {
            Entry.playground.setMenu(Entry.playground.object.objectType);
        }

        socket.on('connect', () => {
            this._setSocketConnected();
        });

        socket.on('mode', (mode: number) => {
            if (this.socketMode === 0 && mode === 1) {
                this._disconnectHardware();
            }
            this.socketMode = mode;
        });

        const messageHandler = new HardwareSocketMessageHandler(socket);
        messageHandler.addEventListener('init', this._loadExternalHardwareBlock.bind(this));
        messageHandler.addEventListener('state', async (statement, name) => {
            /*
            statement 로는 before_connect, connected 등 하드웨어 프로그램의 상태 전부가 오지만
            WS 에서는 connected 외에 전부 socketConnected 상태로 머무르게 된다.
             */
            switch (statement) {
                case 'disconnectHardware':
                    this._disconnectHardware();
                    break;
                case 'connected':
                    // init action 과 동일동작
                    await this._loadExternalHardwareBlock(name);
                    break;
                default:
                    break;
            }
        });

        // 1.7.0 버전 이전 하드웨어 프로그램 종료로직 대응으로 남겨두어야 한다.
        messageHandler.addEventListener('disconnect', this._disconnectHardware.bind(this));
        messageHandler.addEventListener('data', (portData: HardwareMessageData) => {
            this.portData = portData;
            this.checkDevice(portData);
            this._updatePortData(portData);
            if (this.hwModule && this.hwModule.afterReceive) {
                this.hwModule.afterReceive(portData);
            }
        });

        socket.on('disconnect', () => {
            // cloud PC 연결 클릭시 순간 disconnect 되고 재연결을 시도하기 위한 로직
            this._setSocketClosed();
            this.reconnectionTimeout = window.setTimeout(() => {
                this._initSocket();
            }, 1500);
        });

        socket.on('reconnect_failed', () => {
            this._setSocketClosed();
        });
    }

    private _setSocketConnected() {
        this.programConnected = true;
        console.log('Hardware Program Connected'); // 하드웨어 프로그램 연결 성공, 스테이터스 변화 필요
        Entry.dispatchEvent('hwChanged');
    }

    private _setSocketClosed(needRedraw: boolean = true) {
        this.programConnected = false;
        this.hwModule = undefined;
        this.currentDeviceKey = undefined;
        needRedraw && Entry.dispatchEvent('hwChanged');
    }

    /**
     * 이미 연결했던 소켓이 존재한다면 재연결을 시도한다.
     * 연결성공했던 소켓이 없다면 전체 리스트를 순회하며 연결을 시도한다.
     * @private
     */
    private _initSocket() {
        if (this.socket) {
            if (this.reconnectionTimeout) {
                clearTimeout(this.reconnectionTimeout);
                this.reconnectionTimeout = undefined;
            }
            this.socket.io.reconnection(true);
            this.socket.connect();
        } else {
            const connectionTries = [this.httpsServerAddress, this.httpsServerAddress2];

            // http 혹은 파일시스템 프로토콜에서 동작하는 경우, 로컬호스트 를 최우선 연결시도 한다.
            if (['http:', 'file:'].indexOf(location.protocol) > -1) {
                connectionTries.unshift(this.httpServerAddress);
            } else {
                connectionTries.push(this.httpServerAddress);
            }

            connectionTries
                .reduce<Promise<boolean>>(async (prevPromise, address) => {
                    const prevResult = await prevPromise;
                    if (prevResult) {
                        return true;
                    }

                    try {
                        await this._trySocketConnect(address);
                        return true;
                    } catch (e) {
                        return !!(this.programConnected || this.socket);
                    }
                }, undefined)
                .then((result) => {
                    // 하드웨어 소켓 연결 시도 결과 반환 로직
                    if (!result) {
                        console.warn('All hardware socket connection failed');
                        this._setSocketClosed();
                    }
                })
                .catch(() => {
                    console.error('Error occurred while try to connect hardware socket');
                });
        }
    }

    /**
     * 하드웨어 버튼 노출상태를 변경한다.
     * @param statement {HardwareStatement}
     * @private
     */
    private _setHardwareDefaultMenu(statement: HardwareStatement) {
        const workspace = Entry.getMainWS();
        const blockMenu = workspace && workspace.blockMenu;

        if (!blockMenu) {
            return;
        }

        const { disconnected, socketConnected, hardwareConnected } = HardwareStatement;

        switch (statement) {
            case disconnected:
                blockMenu.unbanClass('arduinoDisconnected', true);
                blockMenu.banClass('arduinoConnected', true);
                blockMenu.banClass('arduinoConnect', true);
                break;
            case socketConnected:
                blockMenu.banClass('arduinoDisconnected', true);
                blockMenu.banClass('arduinoConnected', true);
                blockMenu.unbanClass('arduinoConnect', true);
                break;
            case hardwareConnected:
                blockMenu.banClass('arduinoDisconnected', true);
                blockMenu.unbanClass('arduinoConnected', true);
                blockMenu.banClass('arduinoConnect', true);
                break;
        }
    }

    /**
     * 모든 하드웨어를 숨김처리한다. 현재 연결된 하드웨어도 예외는 없다.
     * @private
     */
    private _banClassAllHardware() {
        const workspace = Entry.getMainWS();
        const blockMenu = workspace && workspace.blockMenu;
        if (!blockMenu) {
            return;
        }

        Object.values(Entry.HARDWARE_LIST).forEach((hardware) => {
            blockMenu.banClass(hardware.name, true);
        });
    }

    private _disconnectHardware() {
        if (this.hwModule) {
            Entry.propertyPanel && Entry.propertyPanel.removeMode('hw');
            this.currentDeviceKey = undefined;
            this.hwModule = undefined;
            Entry.dispatchEvent('hwChanged');
        }
    }

    private _sendSocketMessage(message: WebSocketMessage) {
        if (this.programConnected && this.socket && !this.socket.disconnected) {
            this.socket.emit('message', message);
        }
    }

    private _updatePortData(data: HardwareMessageData) {
        if (this.hwMonitor && Entry.propertyPanel && Entry.propertyPanel.selected === 'hw') {
            this.hwMonitor.update(data, this.sendQueue);
        }
    }

    private _setHardwareMonitorTemplate() {
        if (!this.hwMonitor) {
            this.hwMonitor = new HardwareMonitor(this.hwModule);
        } else {
            this.hwMonitor.setHwModule(this.hwModule);
            this.hwMonitor.initView();
        }
        Entry.propertyPanel.addMode('hw', this.hwMonitor);
        this.hwMonitor.generateViewByMode();
    }

    /**
     * 버전 공지용 함수.
     * 1.9.0 버전으로 올라가면서 SSL 인증서 문제로 과거버전은 소켓연결에 문제가 있음.
     * 그에 따른 조치이기 때문에 추후 유저들이 1.9.0 버전의 사용비중이 높아진다면 삭제해도 무방하다.
     * @returns {Promise<void>}
     * @private
     */
    private _alertUnderVersionUsed() {
        return new Promise((resolve) => {
            const dontShowChecked = localStorage.getItem('skipNoticeHWOldVersion');
            if (!dontShowChecked) {
                const title = window.Lang.Msgs.hardware_need_update_title;
                const content = window.Lang.Msgs.hardware_need_update_content;
                window.entrylms
                    .alert(content, title, { withDontShowAgain: true })
                    .one(
                        'click',
                        (event: any, { dontShowChecked }: { dontShowChecked: boolean }) => {
                            if (dontShowChecked) {
                                localStorage.setItem('skipNoticeHWOldVersion', 'true');
                            }
                            resolve();
                        },
                    );
            } else {
                resolve();
            }
        });
    }

    private _executeHardware(args?: { [key: string]: string }) {
        const hw = this;
        const executeIeCustomLauncher = {
            _bNotInstalled: false,
            init(sUrl: string, fpCallback: (bInstalled: boolean) => void) {
                const width = 220;
                const height = 225;
                const left = window.screenLeft;
                const top = window.screenTop;
                const settings = `width=${width}, height=${height},  top=${top}, left=${left}`;
                this._w = window.open('/views/hwLoading.html', 'entry_hw_launcher', settings);
                let fnInterval: number = undefined;
                fnInterval = window.setTimeout(() => {
                    executeIeCustomLauncher.runViewer(sUrl, fpCallback);
                    clearInterval(fnInterval);
                }, 1000);
            },
            runViewer(sUrl: string, fpCallback: (bNotInstalled: boolean) => void) {
                this._w.document.write(
                    `<iframe src='${sUrl}' onload='opener.Entry.hw.ieLauncher.set()' style='display:none;width:0;height:0'></iframe>`,
                );
                let nCounter = 0;
                const bNotInstalled = false;
                let nInterval: number = undefined;
                nInterval = window.setInterval(() => {
                    try {
                        this._w.location.href;
                    } catch (e) {
                        this._bNotInstalled = true;
                    }

                    if (bNotInstalled || nCounter > 10) {
                        clearInterval(nInterval);
                        let nCloseCounter = 0;
                        let nCloseInterval: number = undefined;
                        nCloseInterval = window.setInterval(() => {
                            nCloseCounter++;
                            if (this._w.closed || nCloseCounter > 2) {
                                clearInterval(nCloseInterval);
                            } else {
                                this._w.close();
                            }
                            this._bNotInstalled = false;
                            nCounter = 0;
                        }, 5000);
                        fpCallback(!this._bNotInstalled);
                    }
                    nCounter++;
                }, 100);
            },
            set() {
                this._bNotInstalled = true;
            },
        };

        this.ieLauncher = executeIeCustomLauncher;

        const customSchemaArgsString = Object.entries({
            roomId: this.sessionRoomId,
            ...args,
        }).reduce(
            (result, [key, value]) =>
                result === '' ? `${key}:${value}` : `${result}&${key}:${value}`,
            '',
        );

        const entryHardwareUrl = `entryhw://?${customSchemaArgsString}`;
        console.log('request Hardware using url custom schema.. : ', entryHardwareUrl);
        if (navigator.userAgent.indexOf('MSIE') > 0 || navigator.userAgent.indexOf('Trident') > 0) {
            if (navigator.msLaunchUri !== undefined) {
                executeIe(entryHardwareUrl);
            } else {
                let ieVersion;
                // @ts-ignore IE 에 실제 있는 프로퍼티이다.
                if (document.documentMode > 0) {
                    // @ts-ignore IE 에 실제 있는 프로퍼티이다.
                    ieVersion = document.documentMode;
                } else {
                    ieVersion = navigator.userAgent.match(/(?:MSIE) ([0-9.]+)/)[1];
                }

                if (ieVersion < 9) {
                    alert(window.Lang.msgs.not_support_browser);
                } else {
                    executeIeCustomLauncher.init(entryHardwareUrl, (bInstalled) => {
                        if (bInstalled === false) {
                            hw.openHardwareDownloadPopup();
                        }
                    });
                }
            }
        } else if (navigator.userAgent.indexOf('Firefox') > 0) {
            executeFirefox(entryHardwareUrl);
        } else if (navigator.userAgent.indexOf('Chrome') > 0) {
            executeChrome(entryHardwareUrl);
        } else if (navigator.userAgent.indexOf('Safari') > 0) {
            executeSafari(entryHardwareUrl);
        } else {
            alert(window.Lang.msgs.not_support_browser);
        }

        function executeIe(customUrl: string) {
            navigator.msLaunchUri(
                customUrl,
                () => {
                },
                () => {
                    hw.openHardwareDownloadPopup();
                },
            );
        }

        function executeFirefox(customUrl: string) {
            const iFrame = document.createElement('iframe');
            iFrame.src = 'about:blank';
            iFrame.setAttribute('style', 'display:none');
            document.getElementsByTagName('body')[0].appendChild(iFrame);
            let fnTimeout: number = undefined;
            fnTimeout = window.setTimeout(() => {
                let isInstalled = false;
                try {
                    iFrame.contentWindow.location.href = customUrl;
                    isInstalled = true;
                } catch (e) {
                    if (e.name === 'NS_ERROR_UNKNOWN_PROTOCOL') {
                        isInstalled = false;
                    }
                }

                if (!isInstalled) {
                    hw.openHardwareDownloadPopup();
                }

                document.getElementsByTagName('body')[0].removeChild(iFrame);
                clearTimeout(fnTimeout);
            }, 500);
        }

        function executeChrome(customUrl: string) {
            let isInstalled = false;
            window.focus();
            $(window).one('blur', () => {
                isInstalled = true;
            });
            Entry.dispatchEvent('workspaceUnbindUnload', true);
            location.assign(encodeURI(customUrl));
            setTimeout(() => {
                Entry.dispatchEvent('workspaceBindUnload', true);
            }, 100);
            setTimeout(() => {
                if (isInstalled === false) {
                    hw.openHardwareDownloadPopup();
                }
                window.onblur = null;
            }, 3000);
        }

        /**
         * safari 브라우저에서 ${customUrl} 인식하여 페이지 이동 처리되서 분기처리(미설치 안내팝업)
         *
         *
         * @param customUrl
         */
        function executeSafari(customUrl: string) {
            const iFrame = document.createElement('iframe');
            iFrame.src = 'about:blank';
            iFrame.setAttribute('style', 'display:none');
            document.getElementsByTagName('body')[0].appendChild(iFrame);
            let isInstalled = false;

            try {
                iFrame.contentWindow.location.href = customUrl;

                isInstalled = true;
            } catch (err) {
                isInstalled = false;
            }

            if (!isInstalled) {
                hw.openHardwareDownloadPopup();
            }
            setTimeout(() => {
                document.getElementsByTagName('body')[0].removeChild(iFrame);
            }, 500);
        }
    }

    private _hwPopupCreate() {
        const hw = this;
        if (!this.popupHelper) {
            if (window.popupHelper) {
                this.popupHelper = window.popupHelper;
            } else {
                this.popupHelper = new PopupHelper(true);
            }
        }

        this.popupHelper.addPopup('hwDownload', {
            type: 'confirm',
            title: window.Lang.Msgs.not_install_title,
            setPopupLayout(popup: any) {
                const content = Entry.Dom('div', {
                    class: 'contentArea',
                });
                const text = Entry.Dom('div', {
                    class: 'textArea',
                    parent: content,
                });
                const text1 = Entry.Dom('div', {
                    class: 'text1',
                    parent: text,
                });
                const text2 = Entry.Dom('div', {
                    class: 'text2',
                    parent: text,
                });
                const text3 = Entry.Dom('div', {
                    class: 'text3',
                    parent: text,
                });
                const text4 = Entry.Dom('div', {
                    class: 'text4',
                    parent: text,
                });
                const cancel = Entry.Dom('div', {
                    classes: ['popupCancelBtn', 'popupDefaultBtn'],
                    parent: content,
                });
                const ok = Entry.Dom('div', {
                    classes: ['popupOkBtn', 'popupDefaultBtn'],
                    parent: content,
                });
                (text1 as any).text(window.Lang.Msgs.hw_download_text1);
                (text2 as any).html(window.Lang.Msgs.hw_download_text2);
                (text3 as any).text(window.Lang.Msgs.hw_download_text3);
                (text4 as any).text(window.Lang.Msgs.hw_download_text4);
                (cancel as any).text(window.Lang.Buttons.cancel);
                (ok as any).html(window.Lang.Msgs.hw_download_btn);

                (content as any).bindOnClick('.popupDefaultBtn', function() {
                    const $this = $(this);
                    if ($this.hasClass('popupOkBtn')) {
                        hw.downloadConnector();
                    }

                    hw.popupHelper.hide('hwDownload');
                });

                popup.append(content);
            },
        });
    }

    private _convertHexToString(num: number | string) {
        if (typeof num === 'string') {
            return num.toUpperCase();
        }

        return num.toString(16).toUpperCase();
    }
}

Entry.HW = Hardware;
