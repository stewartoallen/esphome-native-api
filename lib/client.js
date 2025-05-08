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
    #voice_chunk;
    #voice_buffer;
    #voice_complete;

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
            if (data.start !== true) {
                // console.log('NO VOICE START');
                return;
            }
            this.#voice_buffer = Buffer.alloc(0);
            let { port, close } = await createUDPListener((data, remote) => {
                this.#handle_voice_buffer(data, 'raw');
            });
            // console.log(`UDP server on port ${port}`);
            // set port to 0 to get `message.VoiceAssistantAudio` events
            // over this conn protobuf link instead of the UDP server
            conn.sendVoiceAssistantResponse({ port });
            conn.sendVoiceAssistantEvent({ type: 1 }); // run start
            conn.sendVoiceAssistantEvent({ type: 3 }); // stt start
            conn.sendVoiceAssistantEvent({ type: 11 }); // enable VAD
            // kill UDP server after 30 seconds no matter what
            setTimeout(close, 30000);
        });

        conn.on('message.VoiceAssistantAudio', async ({ data, end }) => {
            if (!this.#voice_buffer) {
                // console.log('stream ended! but data', { data, end });
                return;
            }
            this.#handle_voice_buffer(Buffer.from(data, 'base64'), 'b64');
        })

        conn.on('error', e => {
            this.emit('error', e);
        });

        this.#deviceInfo = null;
        this.#entities = {};
        this.#initialized = false;
        this._subscribeBLEAdvertisements = initializeSubscribeBLEAdvertisements;
    }

    #handle_voice_buffer(bufr, src) {
        if (!this.#voice_buffer) {
            // drop late frames
            return;
        }
        this.#voice_buffer = Buffer.concat([ this.#voice_buffer, bufr ]);
        if (this.#voice_chunk(bufr) === true) {
            this.#handle_voice_complete();
        }
    }

    #handle_voice_complete(close) {
        if (close) {
            close();
        }
        if (!this.#voice_buffer) {
            console.log('double voice complete');
            return;
        }
        const conn = this.#connection;
        conn.sendVoiceAssistantEvent({ type: 12 }); // disable VAD
        conn.sendVoiceAssistantEvent({ type: 4 }); // stt end
        conn.sendVoiceAssistantEvent({ type: 2 }); // run end
        this.#voice_complete(this.#voice_buffer);
        this.#voice_buffer = undefined;
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

    setVoiceAssistantHandler({ onChunk, onComplete }) {
        this.#connection.configureVoiceAssistantService(onComplete ? true : false);
        this.#voice_complete = onComplete;
        this.#voice_chunk = onChunk || (() => {});
    }

    createUDPListener(onData, port) {
        return createUDPListener(onData, port);
    }

    async propagateError(e) {
        this.emit('error', e);
    }
}

module.exports = EsphomeNativeApiClient;
