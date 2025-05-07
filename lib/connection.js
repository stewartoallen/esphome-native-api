const EventEmitter = require("events");
const { Entities } = require('./entities');
const { mapMessageByType, isBase64 } = require("./utils/mapMessageByType");
const { pb } = require('./utils/messages');
const Package = require('../package.json');
const PlaintextFrameHelper = require('./utils/plaintextFrameHelper');
const NoiseFrameHelper = require('./utils/noiseFrameHelper');

class EsphomeNativeApiConnection extends EventEmitter {

    #check_connected() {
        if (!this.connected) throw new Error(`Not connected`);
    }

    #check_authorized() {
        this.#check_connected();
        if (!this.authorized) throw new Error(`Not authorized`);
    }

    #emit(topic) {
        if (this.listeners(topic).length === 0) {
            console.log(`{{ ${topic} }}`, [...arguments].slice(1));
        }
        this.emit(...arguments);
    }

    constructor({
        port = 6053,
        host,
        clientInfo = Package.name + ' ' + Package.version,
        password = '',
        encryptionKey = '',
        expectedServerName = '',
        reconnect = true,
        reconnectInterval = 30 * 1000,
        pingInterval = 15 * 1000,
        pingAttempts = 3
    }) {
        super();

        if (!host) throw new Error(`Host is required`);

        if (encryptionKey && (!isBase64(encryptionKey) || Buffer.from(encryptionKey, "base64").length !== 32)) {
            throw new Error(`Encryption key must be base64 and 32 bytes long`);
        }

        const frameHelper = this.frameHelper = !encryptionKey ?
            new PlaintextFrameHelper(host, port) :
            new NoiseFrameHelper(host, port, encryptionKey, expectedServerName);

        frameHelper.on('message', (message) => {
            const type = message.constructor.type;
            const mapped = mapMessageByType(type, message.toObject());
            // console.log({ type, message, mapped });
            this.#emit(`message.${type}`, mapped);
            this.emit('message', type, mapped);
        });

        // frame helper close
        frameHelper.on('close', () => {
            this.connected = false;
            this.authorized = false;
            clearInterval(this.pingTimer);
            this.pingCount = 0;
            if (this.reconnect) {
                this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectInterval);
                this.emit('reconnect');
            }
        })

        // frame helper connect
        frameHelper.on('connect', async () => {
            clearTimeout(this.reconnectTimer);
            this.connected = true;
            try {
                const helloResponse = await this.helloService(this.clientInfo);
                this.supportsRawBLEAdvertisements = helloResponse.apiVersionMajor > 1 ||
                    (helloResponse.apiVersionMajor === 1 && helloResponse.apiVersionMinor >= 9);
                const { invalidPassword } = await this.connectService(this.password);
                if (invalidPassword === true) throw new Error(`Invalid password`);
                this.authorized = true;
            } catch (e) {
                this.emit('error', e);
                frameHelper.end();
            }
            this.pingTimer = setInterval(async () => {
                try {
                    await this.pingService();
                    this.pingCount = 0;
                } catch (e) {
                    if (++this.pingCount >= this.pingAttempts) {
                        frameHelper.end();
                    }
                }
            }, this.pingInterval);
        })

        // frame helper error
        frameHelper.on('error', (e) => {
            this.emit('error', e);
        })

        frameHelper.on('data', (data) => {
            this.emit('data', data);
        })

        // DisconnectRequest
        this.on('message.DisconnectRequest', () => {
            try {
                this.sendMessage(new pb.DisconnectResponse());
                frameHelper.destroy();
            } catch (e) {
                this.emit('error', new Error(`Failed respond to DisconnectRequest. Reason: ${e.message}`));
            }
        })

        // DisconnectResponse
        this.on('message.DisconnectResponse', () => {
            frameHelper.destroy();
        })

        // PingRequest
        this.on('message.PingRequest', () => {
            try {
                this.sendMessage(new pb.PingResponse());
            } catch (e) {
                this.emit('error', new Error(`Failed respond to PingRequest. Reason: ${e.message}`));
            }
        })

        // GetTimeRequest
        this.on('message.GetTimeRequest', () => {
            try {
                const message = new pb.GetTimeResponse();
                message.setEpochSeconds(Math.floor(Date.now() / 1000));
                this.sendMessage(message);
            } catch (e) {
                this.emit('error', new Error(`Failed respond to GetTimeRequest. Reason: ${e.message}`));
            }
        })

        this.on('message.BluetoothLERawAdvertisementsResponse', msg => {
            for (const advertisement of msg.advertisementsList)
                this.emit("message.BluetoothLEAdvertisementResponse", advertisement);
        })

        this._connected = false;
        this._authorized = false;

        this.port = port;
        this.host = host;
        this.clientInfo = clientInfo;
        this.password = password;
        this.encryptionKey = encryptionKey;
        this.reconnect = reconnect;
        this.reconnectTimer = null;
        this.reconnectInterval = reconnectInterval;
        this.pingTimer = null;
        this.pingInterval = pingInterval;
        this.pingAttempts = pingAttempts;
        this.pingCount = 0;
    }

    set connected(value) {
        if (this._connected === value) return;
        this._connected = value;
        this.emit(this._connected ? 'connected' : 'disconnected');
    }

    get connected() {
        return this._connected;
    }

    set authorized(value) {
        if (this._authorized === value) return;
        this._authorized = value;
        this.emit(this._authorized ? 'authorized' : 'unauthorized');
    }

    get authorized() {
        return this._authorized;
    }

    connect() {
        if (this.connected) throw new Error(`Already connected. Can't connect.`);
        this.frameHelper.connect();
    }

    disconnect() {
        clearInterval(this.pingTimer);
        clearTimeout(this.reconnectTimer);
        if (this.connected) {
            try {
                this.sendMessage(new pb.DisconnectRequest());
            } catch (e) { }
        }
        this.authorized = false;
        this.connected = false;
        this.reconnect = false;
        this.frameHelper.removeAllListeners();
        this.removeAllListeners();
        this.frameHelper.destroy();
    }

    sendMessage(message) {
        this.#check_connected();
        this.frameHelper.sendMessage(message);
    }

    sendCommandMessage(message) {
        this.#check_authorized();
        this.sendMessage(message);
    }

    async sendMessageAwaitResponse(message, responseMessageTypeName, timeoutSeconds = 5) {
        return new Promise((resolve, reject) => {
            const clear = () => {
                this.off(`message.${responseMessageTypeName}`, handler);
                clearTimeout(timeout);
            }
            const handler = (message) => {
                clear();
                resolve(message);
            }
            this.sendMessage(message);
            this.once(`message.${responseMessageTypeName}`, handler);
            const timeout = setTimeout(() => {
                clear();
                reject(new Error(`sendMessage timeout waiting for ${responseMessageTypeName}`));
            }, timeoutSeconds * 1000);
        })
    }

    async helloService(clientInfo) {
        const message = new pb.HelloRequest();

        if (clientInfo !== undefined) message.setClientInfo(clientInfo);
        message.setApiVersionMajor(1);
        message.setApiVersionMinor(10);

        return await this.sendMessageAwaitResponse(message, 'HelloResponse');
    }

    async connectService(password) {
        const message = new pb.ConnectRequest();

        if (password !== undefined) message.setPassword(password);

        return await this.sendMessageAwaitResponse(message, 'ConnectResponse');
    }

    async disconnectService() {
        return await this.sendMessageAwaitResponse(new pb.DisconnectRequest(), 'DisconnectResponse');
    }

    async pingService() {
        return await this.sendMessageAwaitResponse(new pb.PingRequest(), 'PingResponse');
    }

    async deviceInfoService() {
        if (!this.connected) throw new Error(`Not connected`);
        return await this.sendMessageAwaitResponse(new pb.DeviceInfoRequest(), 'DeviceInfoResponse');
    }

    async getTimeService() {
        if (!this.connected) throw new Error(`Not connected`);
        return await this.sendMessageAwaitResponse(new pb.GetTimeRequest(), 'GetTimeResponse');
    }

    async listEntitiesService() {
        if (!this.connected) throw new Error(`Not connected`);
        if (!this.authorized) throw new Error(`Not authorized`);
        const message = new pb.ListEntitiesRequest();

        const allowedEvents = [
            'ListEntitiesBinarySensorResponse',
            'ListEntitiesCoverResponse',
            'ListEntitiesFanResponse',
            'ListEntitiesLightResponse',
            'ListEntitiesSensorResponse',
            'ListEntitiesSwitchResponse',
            'ListEntitiesTextSensorResponse',
            'ListEntitiesCameraResponse',
            'ListEntitiesClimateResponse',
            'ListEntitiesNumberResponse',
            'ListEntitiesSelectResponse',
            'ListEntitiesSirenResponse',
            'ListEntitiesLockResponse',
            'ListEntitiesButtonResponse',
            'ListEntitiesMediaPlayerResponse',
            'ListEntitiesTextResponse',
            // 'ListEntitiesEventResponse',
            // 'ListEntitiesUpdateResponse',
            // 'ListEntitiesDoneResponse',
        ]
        const entitiesList = [];
        const onMessage = (type, message) => {
            if (!allowedEvents.includes(type)) {
                // console.log('DISALLOWED', type);
                return;
            }
            entitiesList.push({
                component: type.slice(12, -8),
                entity: message
            });
        };
        this.on('message', onMessage);
        await this.sendMessageAwaitResponse(message, 'ListEntitiesDoneResponse').then(() => {
            this.off('message', onMessage);
        }, e => {
            this.off('message', onMessage);
            throw e;
        });
        // console.log({ entitiesList });
        return entitiesList;
    }

    subscribeStatesService() {
        this.#check_authorized();
        this.sendMessage(new pb.SubscribeStatesRequest());
    }

    subscribeLogsService(
        level = pb.LogLevel.LOG_LEVEL_DEBUG,
        dumpConfig = false
    ) {
        this.#check_authorized();
        const message = new pb.SubscribeLogsRequest();
        message.setLevel(level);
        message.setDumpConfig(dumpConfig);
        this.sendMessage(message);
    }

    subscribeHomeAssistantServices() {
        this.#check_authorized();
        const message = new pb.SubscribeHomeassistantServicesRequest();
        this.sendMessage(message);
    }

    subscribeHomeAssistantStatesService(
        subscribe = true,
        flags = pb.VoiceAssistantSubscribeFlag.VOICE_ASSISTANT_SUBSCRIBE_API_AUDIO
    ) {
        this.#check_authorized();
        const message = new pb.SubscribeHomeAssistantStatesRequest();
        this.sendMessage(message);
    }

    configureVoiceAssistantService(
        subscribe = true,
        flags = pb.VoiceAssistantSubscribeFlag.VOICE_ASSISTANT_SUBSCRIBE_API_AUDIO
    ) {
        this.#check_authorized();
        const message = new pb.SubscribeVoiceAssistantRequest();
        message.setSubscribe(subscribe);
        message.setFlags(flags);
        this.sendMessage(message);
    }

    sendVoiceAssistantResponse({
        port = 10700,
        error = false
    }) {
        this.#check_authorized();
        const message = new pb.VoiceAssistantResponse();
        message.setPort(port);
        message.setError(error);
        this.sendMessage(message);
    }

    sendVoiceAssistantEvent({
        type = 0,
        data = undefined
    }) {
        this.#check_authorized();
        const message = new pb.VoiceAssistantEventResponse();
        message.setEventType(type);
        if (Array.isArray(data)) {
            message.setDataList(data);
        } else if (data) {
            message.setDataList([ data ]);
        }
        this.sendMessage(message);
    }

    createVoiceAssistantEventData(name, value) {
        const message = new pb.VoiceAssistantEventResponse();
        message.setName(name);
        message.setValue(value);
        return message;
    }

    cameraImageService(single = true, stream = false) {
        this.#check_authorized();
        const message = new pb.CameraImageRequest();
        message.setSingle(single);
        message.setStream(stream);
        this.sendMessage(message);
    }

    // Entity command services
    buttonCommandService(data) {
        Entities.Button.commandService(this, data);
    }

    climateCommandService(data) {
        Entities.Climate.commandService(this, data);
    }

    coverCommandService(data) {
        Entities.Cover.commandService(this, data);
    }

    fanCommandService(data) {
        Entities.Fan.commandService(this, data);
    }

    lightCommandService(data) {
        Entities.Light.commandService(this, data);
    }

    lockCommandService(data) {
        Entities.Lock.commandService(this, data);
    }

    numberCommandService(data) {
        Entities.Number.commandService(this, data);
    }

    selectCommandService(data) {
        Entities.Select.commandService(this, data);
    }

    sirenCommandService(data) {
        Entities.Siren.commandService(this, data);
    }

    switchCommandService(data) {
        Entities.Switch.commandService(this, data);
    }

    mediaPlayerCommandService(data) {
        Entities.MediaPlayer.commandService(this, data);
    }

    subscribeBluetoothAdvertisementService() {
        this.#check_authorized();
        this.sendMessage(new pb.SubscribeBluetoothLEAdvertisementsRequest([this.supportsRawBLEAdvertisements ? 1 : 0]))
    }

    unsubscribeBluetoothAdvertisementService() {
        this.#check_authorized();
        this.sendMessage(new pb.UnsubscribeBluetoothLEAdvertisementsRequest());
    }

    async connectBluetoothDeviceService(address, addressType) {
        this.#check_authorized();
        const message = new pb.BluetoothDeviceRequest([address]);
        if (addressType != undefined) {
            message.setHasAddressType(true);
            message.setAddressType(addressType);
        }
        return await this.sendMessageAwaitResponse(
            message,
            'BluetoothDeviceConnectionResponse',
            10
        );
    }

    async disconnectBluetoothDeviceService(address) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothDeviceRequest([
                address,
                pb.BluetoothDeviceRequestType
                    .BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT,
            ]),
            'BluetoothDeviceConnectionResponse'
        );
    }

    async pairBluetoothDeviceService(address) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothDeviceRequest([
                address,
                pb.BluetoothDeviceRequestType
                    .BLUETOOTH_DEVICE_REQUEST_TYPE_PAIR,
            ]),
            'BluetoothDevicePairingResponse',
            10
        );
    }

    async unpairBluetoothDeviceService(address) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothDeviceRequest([
                address,
                pb.BluetoothDeviceRequestType
                    .BLUETOOTH_DEVICE_REQUEST_TYPE_UNPAIR,
            ]),
            'BluetoothDeviceUnpairingResponse',
            10
        );
    }

    async listBluetoothGATTServicesService(address) {
        this.#check_authorized();
        const message = new pb.BluetoothGATTGetServicesRequest([address]);

        const servicesList = [];
        const onMessage = (message) => {
            if (message.address === address)
                servicesList.push(...message.servicesList);
        };
        this.on('message.BluetoothGATTGetServicesResponse', onMessage);
        await this.sendMessageAwaitResponse(
            message,
            'BluetoothGATTGetServicesDoneResponse'
        ).then(
            () => {
                this.off('message.BluetoothGATTGetServicesResponse', onMessage);
            },
            (e) => {
                this.off('message.BluetoothGATTGetServicesResponse', onMessage);
                throw e;
            }
        );
        return { address, servicesList };
    }

    async readBluetoothGATTCharacteristicService(address, handle) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothGATTReadRequest([address, handle]),
            'BluetoothGATTReadResponse'
        );
    }

    async writeBluetoothGATTCharacteristicService(
        address,
        handle,
        value,
        response = false
    ) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothGATTWriteRequest([
                address,
                handle,
                response,
                value,
            ]),
            'BluetoothGATTWriteResponse'
        );
    }

    async notifyBluetoothGATTCharacteristicService(address, handle) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothGATTNotifyRequest([address, handle, true]),
            'BluetoothGATTNotifyResponse'
        );
    }

    async readBluetoothGATTDescriptorService(address, handle) {
        this.#check_authorized();
        return await this.sendMessageAwaitResponse(
            new pb.BluetoothGATTReadDescriptorRequest([address, handle]),
            'BluetoothGATTReadResponse'
        );
    }

    async writeBluetoothGATTDescriptorService(
        address,
        handle,
        value
    ) {
        this.#check_authorized();
        await this.sendMessageAwaitResponse(
            new pb.BluetoothGATTWriteDescriptorRequest([
                address,
                handle,
                value,
            ]),
            'BluetoothGATTWriteResponse'
        );
    }

    textCommandService(data) {
        Entities.Text.commandService(this, data);
    }

}

module.exports = EsphomeNativeApiConnection;
