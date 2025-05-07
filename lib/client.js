const EventEmitter = require("events");
const Connection = require('./connection');
const { create: createEntity, Entities } = require('./entities');

async function createUDPListener(onData, port = 0) {
    return new Promise((resolve, reject) => {
        if (!onData) {
            reject('missing onData() callback');
        }

        const dgram = require('dgram');
        const server = dgram.createSocket('udp4');

        server.on('message', (msg, remote) => {
            onData(msg, remote);
        });

        server.bind(port, () => {
            const { port } = server.address();
            resolve({ port, close() { server.close() } });
        });
    });
}

class EsphomeNativeApiClient extends EventEmitter {
    #connected;
    #connection;
    #initialized;
    #deviceInfo;
    #entities;

    constructor({
        clearSession = true,
        initializeDeviceInfo = true,
        initializeListEntities = true,
        initializeSubscribeStates = true,
        initializeSubscribeLogs = false,
        initializeSubscribeBLEAdvertisements = false,
        initializeSubscribeHomeAssistantState = false,
        initializeSubscribeHomeAssistantServices = false,
        ...config
    }) {
        super();

        this.propagateError = this.propagateError.bind(this);
        const conn = this.#connection = new Connection(config);

        conn.on('authorized', async () => {
            this.#connected = true;
            try {
                this.#initialized = false;
                if (clearSession) {
                    for (const id of Object.keys(this.#entities)) this.removeEntity(id);
                }
                if (initializeDeviceInfo) {
                    await conn.deviceInfoService()
                };
                if (initializeListEntities) {
                    await conn.listEntitiesService();
                }
                if (initializeSubscribeStates) {
                    conn.subscribeStatesService();
                }
                if (initializeSubscribeLogs) {
                    conn.subscribeLogsService(...((initializeSubscribeLogs === true) ? [] : [initializeSubscribeLogs.level, initializeSubscribeLogs.dumpConfig]));
                }
                if (initializeSubscribeBLEAdvertisements) {
                    conn.subscribeBluetoothAdvertisementService();
                }
                if (initializeSubscribeHomeAssistantState) {
                    conn.subscribeHomeAssistantStatesService();
                }
                if (initializeSubscribeHomeAssistantServices) {
                    conn.subscribeHomeAssistantServices();
                }
                this.#initialized = true;
                this.emit('initialized');
            } catch (e) {
                this.emit('error', e);
                if (conn.connected) conn.frameHelper.end();
            }
        });

        conn.on('unauthorized', async () => {
            this.#connected = false;
            this.#initialized = false;
        });

        conn.on('message.DeviceInfoResponse', async deviceInfo => {
            this.#deviceInfo = deviceInfo;
            this.emit('deviceInfo', deviceInfo);
        });

        for (const EntityClass of Object.values(Entities)) {
            conn.on(`message.${EntityClass.getListEntitiesResponseName()}`, async config => {
                if (!this.#entities[config.key]) this.addEntity(EntityClass.name, config);
            });
        }

        conn.on('message.SubscribeLogsResponse', async data => {
            this.emit('logs', data);
        });

        conn.on('message.UpdateStateResponse', async data => {
            this.emit('state', data);
        });

        conn.on('message.BluetoothLEAdvertisementResponse', async data => {
            this.emit('ble', data);
        });

        conn.on('message.VoiceAssistantRequest', async data => {
            console.log('VOICE REQUEST', data);
            let { port, close } = await createUDPListener((data, remote) => {
                console.log(`UDP << ${data.length} from ${remote.address}:${remote.port}`);
            });
            console.log(`UDP server on port ${port}`);
            conn.sendVoiceAssistantResponse({ port });
            setTimeout(() => {
                // end STT
                conn.sendVoiceAssistantEvent({ type: 2 });
            }, 500);
        });

        conn.on('message.VoiceAssistantAudio', async ({ data, end }) => {
            console.log({ voice: data.length });
        })

        conn.on('error', async e => {
            this.emit('error', e);
        });

        this.#deviceInfo = null;
        this.#entities = {};
        this.#initialized = false;
        this._subscribeBLEAdvertisements = initializeSubscribeBLEAdvertisements;
    }

    set connected(value) {
        if (this.#connected !== value) {
            this.#connected = value;
            this.emit(this.#connected ? 'connected' : 'disconnected');
        }
    }

    get connected() {
        return this.#connected;
    }

    connect() {
        this.#connection.connect();
    }

    disconnect() {
        if (this.#connection.connected && this._subscribeBLEAdvertisements) {
            this.#connection.unsubscribeBluetoothAdvertisementService();
        }
        this.#connection.disconnect();
    }

    addEntity(entityClassName, config) {
        if (this.#entities[config.key]) throw new Error(`Entity with id(i.e key) ${config.key} is already added`);
        this.#entities[config.key] = createEntity(entityClassName, { connection: this.#connection, config });
        this.#entities[config.key].on('error', this.propagateError);
        this.emit('newEntity', this.#entities[config.key]);
    }

    removeEntity(id) {
        if (!this.#entities[id]) throw new Error(`Cannot find entity with is(i.e. key) ${id}`);
        this.#entities[id].destroy();
        this.#entities[id].off('error', this.propagateError);
        delete this.#entities[id];
    }

    setVoiceAssistantHandler(handler) {
        this.#connection.configureVoiceAssistantService(handler ? true : false);
    }

    createUDPListener(onData, port) {
        return createUDPListener(onData, port);
    }

    async propagateError(e) {
        this.emit('error', e);
    }
}

module.exports = EsphomeNativeApiClient;
