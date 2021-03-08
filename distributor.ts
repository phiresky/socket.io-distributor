import * as SocketIO from "socket.io";
import * as redis from "redis";
import { socketIoWildcard, DEFAULT_PREFIX } from "./util";
import * as net from "net";
import { mixed } from "typed-socket.io/util";
import {
    ServerDefinition,
    RootServer,
    NamespaceNames,
    ServerNamespace,
    ServerSideClientSocket,
    // @ts-ignore needed for declaration export
    GeneralClientMessages,
    // @ts-ignore needed for declaration export
    ServerSideClientSocketI,
} from "typed-socket.io";
import * as SocketIORedis from "socket.io-redis";

export type NewConnectionMessage = {
    type: "newConnection";
    socketId: string;
    // any properties returned by Config.onClientConnect
    additionalSocketInfo: object;
};

export type ClientMessage = {
    type: "clientMessage";
    event: string;
    data: mixed[];
    socketId: string;
    callbackId?: number;
    slaveId: number;
};
export type ToBackendMessage = ClientMessage | NewConnectionMessage;

export type CallbackMessage = {
    type: "callback";
    namespace: string;
    socketId: string;
    callbackId: number;
    data: mixed[];
};
export type ToSlaveMessage =
    | CallbackMessage
    | {
          type: "close";
          namespace: string;
      }
    | {
          type: "custom";
          [name: string]: mixed;
      };

export interface Config<S extends ServerDefinition> {
    server: net.Server;
    slaveId: number;
    validOrigins?: string[];
    namespaces: NamespaceNames<S>[];
    statsFrequency_ms?: number;
    redis: {
        uri?: string;
        opts?: redis.ClientOpts;
        // prefix all events with this string
        prefix?: string;
    };
    customEventHandler?: (event: {
        type: "custom";
        [name: string]: mixed;
    }) => void;
    /** called on connect. return any additional properties you want passed to the workers like a session id etc. */
    onClientConnect?: (client: NamespaceNames<S>) => object;
}

export class Worker<S extends ServerDefinition> {
    readonly slaveId: number;
    private readonly server: net.Server;
    readonly redisAdapter: SocketIORedis.RedisAdapter;
    readonly io: RootServer<S>;
    readonly namespaces = new Map<
        NamespaceNames<S>,
        NamespaceWorker<S, NamespaceNames<S>>
    >();
    get namespaceList() {
        return Array.from(this.namespaces.values());
    }
    private nextClientCallbackId = 1;
    private readonly clientCallbacks = new Map<
        number,
        (...args: mixed[]) => void
    >();
    private redisPrefix: string;

    public constructor(
        public readonly config: Config<S>,
        socketioServerOptions?: SocketIO.ServerOptions,
    ) {
        this.redisPrefix = config.redis.prefix || DEFAULT_PREFIX;
        this.server = config.server;
        this.slaveId = config.slaveId;
        const pubClient = config.redis.uri
            ? redis.createClient(config.redis.uri, config.redis.opts)
            : redis.createClient(config.redis.opts);
        const subClient = pubClient.duplicate();
        this.redisAdapter = SocketIORedis({ pubClient, subClient });

        this.io = SocketIO(this.server, socketioServerOptions) as any;
        this.io.adapter(this.redisAdapter);
        if (config.validOrigins) {
            const origins = config.validOrigins;
            (this.io as any).origins(
                (origin: string, cb: (error: mixed, succ: boolean) => void) => {
                    const valid = origins.indexOf(origin) >= 0;
                    if (!valid) {
                        console.error(
                            "connection attempt from invalid origin: ",
                            origin,
                        );
                    }
                    cb(valid ? null : "Forbidden: Invalid Origin", valid);
                },
            );
        }

        const slavePath = this.redisPrefix + `/toSlave/${this.slaveId}`;
        const redisClient = this.redisAdapter.subClient.duplicate();
        const slaveSubscriber = redisClient.duplicate();
        slaveSubscriber.subscribe(slavePath, this.redisPrefix + `/toSlave/all`);
        slaveSubscriber.on("message", (_: mixed, message: string) => {
            const data = JSON.parse(message) as ToSlaveMessage;
            if (data.type === "callback") {
                this.namespaces.get(data.namespace)!.handleCallback(data);
            } else if (data.type === "close") {
                const backendNS = data.namespace;
                this.namespaces.get(backendNS)!.disconnectAllClients();
            } else if (
                data.type === "custom" &&
                this.config.customEventHandler
            ) {
                this.config.customEventHandler(data);
            } else {
                console.error("unknown toSlave message", data.type);
            }
        });
        for (const ns of config.namespaces) {
            this.namespaces.set(ns, new NamespaceWorker<S, any>(this, ns));
        }
        if (config.statsFrequency_ms) {
            setInterval(() => this.sendStats(), config.statsFrequency_ms);
        }
    }
    /** add a middleware to all namespaces */
    public addMiddleware(
        middleware: (
            socket: ServerSideClientSocket<S, NamespaceNames<S>>,
            fn: (err?: mixed) => void,
        ) => void,
    ) {
        for (const nsWorker of this.namespaceList) {
            nsWorker.nsio.use(middleware);
        }
    }
    addClientCallback(callback: (...args: mixed[]) => void) {
        const callbackId = this.nextClientCallbackId++;
        this.clientCallbacks.set(callbackId, callback);
        return callbackId;
    }
    private sendStats() {
        const stats = this.namespaceList
            .map((ns) => `${ns.namespace}: ${ns.connectionCount}`)
            .join("\t");
        console.log(`distributor${this.slaveId}:`, stats);
    }
    toBackend(
        data: ToBackendMessage,
        namespace: NamespaceNames<S>,
        backendDownCallback?: () => void,
    ) {
        this.redisAdapter.pubClient.publish(
            this.redisPrefix + "/toBackend" + namespace,
            JSON.stringify(data),
            (_: mixed, listenerCount: number) => {
                if (listenerCount === 0)
                    backendDownCallback && backendDownCallback();
                else if (listenerCount > 1)
                    console.error(
                        "there seem to be ",
                        listenerCount,
                        namespace,
                        "backends",
                    );
            },
        );
    }
    public async shutdown() {
        console.log(`shutting down worker ${this.slaveId}`);
        let disconnected = 0;
        for (const ns of this.namespaceList) {
            disconnected += ns.shutdown();
        }
        if (disconnected > 0)
            console.log(
                "sent disconnect message to backend for ",
                disconnected,
                "sockets",
            );
        this.server.close();
    }
}

export type CustomServerClientInterface = {
    siodCallbacks: Map<number, (...args: mixed[]) => void> | undefined;
    siodNextCallbackId: number | undefined;
    on(x: "*", listener: (event: { data: mixed[] }) => void): void;
};
/**
 * handles clients for a single backend
 */
export class NamespaceWorker<
    S extends ServerDefinition,
    NS extends NamespaceNames<S>
> {
    readonly nsio: ServerNamespace<S, NS>;
    connectionCount = 0;
    private readonly cached: {
        [id: string]: ServerSideClientSocket<S, NS> &
            CustomServerClientInterface;
    } = {};
    constructor(private worker: Worker<S>, public namespace: NS) {
        this.nsio = worker.io.of(this.namespace) as any;
        this.nsio.use(socketIoWildcard());
        this.nsio.on("connection", (client) => {
            if (this.cached[client.id]) {
                // race condition in socket.io code, when client does
                // for(var i = 0; i < 5; i++){ws.disconnect();ws.connect()}
                // the socket instances are created multiple times but the client handles it as one connection
                client.disconnect();
                this.cached[client.id].disconnect();
            } else this.clientConnected(client);
        });
    }
    private async clientConnected(
        client: ServerSideClientSocket<S, NS> & CustomServerClientInterface,
    ) {
        this.connectionCount++;
        this.cached[client.id] = client;
        const additionalSocketInfo = this.worker.config.onClientConnect
            ? this.worker.config.onClientConnect(client)
            : {};
        this.worker.toBackend(
            {
                type: "newConnection",
                additionalSocketInfo,
                socketId: client.id,
            },
            this.namespace,
            // disconnect all clients on fail because the backend might have crashed without us noticing
            this.disconnectAllClients,
        );
        client.on("*", ({ data: [event, ...data] }) => {
            if (typeof event !== "string") {
                console.warn("why is event", typeof event);
                return;
            }
            let callbackId: number | undefined = undefined;
            if (
                data.length > 0 &&
                typeof data[data.length - 1] === "function"
            ) {
                // has callback.
                const callback = data.pop() as (...args: mixed[]) => void;
                if (!client.siodCallbacks) {
                    client.siodCallbacks = new Map<
                        number,
                        (...args: mixed[]) => void
                    >();
                    client.siodNextCallbackId = 1;
                }
                callbackId = client.siodNextCallbackId!;
                client.siodNextCallbackId = callbackId + 1;
                client.siodCallbacks.set(callbackId, callback);
            }
            this.worker.toBackend(
                {
                    type: "clientMessage",
                    event,
                    socketId: client.id,
                    data,
                    callbackId,
                    slaveId: this.worker.slaveId,
                },
                this.namespace,
            );
        });
        client.on("disconnect", () => {
            this.worker.toBackend(
                {
                    type: "clientMessage",
                    event: "disconnect",
                    socketId: client.id,
                    data: [],
                    slaveId: this.worker.slaveId,
                },
                this.namespace,
            );
            this.connectionCount--;
            delete this.cached[client.id];
        });
    }
    handleCallback(data: CallbackMessage) {
        const socket = this.nsio.sockets[
            data.socketId
        ] as CustomServerClientInterface;
        const cb =
            socket &&
            socket.siodCallbacks &&
            socket.siodCallbacks.get(data.callbackId);
        if (cb) {
            socket.siodCallbacks!.delete(data.callbackId);
            cb(...data.data);
        }
    }
    getAllClients() {
        return Array.from(Object.values(this.nsio.sockets));
    }
    disconnectAllClients = () => {
        for (const client of this.getAllClients()) client!.disconnect();
    };
    shutdown() {
        const sockets = this.getAllClients();
        for (const client of sockets) {
            // tell the backend the clients disconnected
            this.worker.toBackend(
                {
                    type: "clientMessage",
                    event: "disconnect",
                    socketId: client!.id,
                    data: [],
                    slaveId: this.worker.slaveId,
                },
                this.namespace,
            );
        }
        return sockets.length;
    }
}
