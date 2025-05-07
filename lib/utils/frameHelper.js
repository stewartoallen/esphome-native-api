const EventEmitter = require("events");
const Net = require("net");
const { pb, id_to_type } = require("./messages");

class FrameHelper extends EventEmitter {
    constructor(host, port) {
        super();
        this.host = host;
        this.port = port;
        this.buffer = Buffer.from([]);
        this.socket = new Net.Socket();
        this.socket.on("close", () => this.emit("close"));
        this.socket.on("error", (e) => {
            this.emit("error", e);
            this.socket.end();
        });
    }

    connect() {
        this.socket.connect(this.port, this.host);
    }

    end() {
        this.socket.end();
    }

    destroy() {
        this.socket.destroy();
    }

    removeAllListeners() {
        this.socket.removeAllListeners();
        super.removeAllListeners();
    }

    buildMessage(messageId, bytes) {
        try {
            return pb[id_to_type[messageId]].deserializeBinary(bytes);
        } catch(e) {
            this.emit('error', new Error(`Failed find or parsed message type for Id: ${messageId}`));
            // console.log({ messageId, id_to_type });
            if (typeof id_to_type[messageId] !== undefined) {
                // we know this type and close connect mb error or freeze connect
                this.socket.end();
            }
        }
    }
}

module.exports = FrameHelper;
