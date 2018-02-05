import { setDefault, DEFAULT_PREFIX } from "./util";
import * as _redisAdapter from "socket.io-redis";
import * as IOServer from "socket.io";
import * as redis from "redis";
import {
    ToBackendMessage,
    ToSlaveMessage,
    NewConnectionMessage,
    ClientMessage,
} from "./distributor";
import {
    ServerDefinition,
    NamespaceNames,
    ServerNamespace,
    RootServer,
    ServerSideClientSocket,
} from "typed-socket.io";
import { promisifySocket } from "typed-socket.io/util";

export interface RedisAdapter {
    pubClient: redis.RedisClient;
    subClient: redis.RedisClient;
    remoteJoin(id: string, room: string, callback: (err: any) => void): void;
    remoteLeave(id: string, room: string, callback: (err: any) => void): void;
    remoteDisconnect(
        id: string,
        close: boolean,
        callback?: (err: any) => void,
    ): void;
}

export interface Config<
    D extends ServerDefinition,
    K extends NamespaceNames<D>
> {
    namespace: string;
    addCustomFunctions?: (
        before: ServerNamespace<D, K>,
    ) => ServerNamespace<D, K>;
    mapOnAsyncErrors?: (e: any) => any;
    redis: {
        uri?: string;
        opts?: SocketIORedis.SocketIORedisOptions;
        // prefix all events with this string
        prefix?: string;
    };
}
/**
 * emulate the usual socketio interface (require("socket.io")(port).of(namespace))
 * while actually getting client messages indirectly via redis
 *
 * @param addCustomFunctions a function that adds all the custom properties specified in the CustomServerNamespaceInterface
 */
export function indirectSocketViaRedis<
    D extends ServerDefinition,
    K extends NamespaceNames<D>
>({
    namespace,
    addCustomFunctions = x => x,
    redis,
    mapOnAsyncErrors,
}: Config<D, K>): ServerNamespace<D, K> {
    // 0 to not actually listen on any port, connections will come through socket.io-distributor
    const globalSocketIO = (IOServer(0) as any) as RootServer<D>;
    const redAdapter = redis.uri
        ? _redisAdapter(redis.uri, redis.opts)
        : _redisAdapter(redis.opts!);
    (globalSocketIO as any).adapter(redAdapter);
    const rawNSSocket = globalSocketIO.of(namespace);
    const adapter = (rawNSSocket as any).adapter as RedisAdapter;
    const connectionListeners: ((
        socket: ServerSideClientSocket<D, K>,
    ) => void)[] = [];
    type MW = (
        socket: ServerSideClientSocket<D, K>,
        fn: (err?: any) => void,
    ) => void;
    const middlewares: MW[] = [];
    const sockets: { [socketId: string]: any } = {};
    const socketEventMap = new Map<string, Map<string, any[]>>();
    const masterSubscriber = adapter.subClient.duplicate();
    const redisPrefix = redis.prefix || DEFAULT_PREFIX;
    masterSubscriber.subscribe(redisPrefix + "/toBackend" + namespace);
    masterSubscriber.on("message", (channel: string, dataString: string) => {
        if (!channel.startsWith(redisPrefix + "/toBackend"))
            throw Error("did not sub to " + channel);
        const data = JSON.parse(dataString) as ToBackendMessage;
        if (data.type === "newConnection") {
            handleNewConnection(data);
        } else if (data.type === "clientMessage") {
            handleClientMessage(data);
        } else {
            throw Error(`unknown message ${data && data!.type}`);
        }
    });
    const wrappedNSSocket = {
        server: globalSocketIO,
        of: <K extends NamespaceNames<D>>(ns: K) =>
            addCustomFunctions(globalSocketIO.of(ns as any)),
        namespace,
        adapter,
        on(
            event: "connection",
            callback: (info: ServerSideClientSocket<D, K>) => void,
        ) {
            if (event !== "connection")
                throw Error("don't know how to listen to " + event);
            connectionListeners.push(callback);
            return this;
        },
        sockets,
        to: (room: string) => rawNSSocket.to(room),
        in: (room: string) => rawNSSocket.in(room),
        emit: (event: string, ...args: any[]) =>
            (rawNSSocket as any).emit(event, ...args),
        volatile: {
            emit: (rawNSSocket as any).volatile.emit.bind(
                (rawNSSocket as any).volatile,
            ),
        },
        use(
            fn: (
                socket: ServerSideClientSocket<D, K>,
                fn: (err?: any) => void,
            ) => void,
        ) {
            middlewares.push(fn);
            return this;
        },
        close: () =>
            adapter.pubClient.publish(
                redisPrefix + `/toSlave/all`,
                JSON.stringify({ type: "close", namespace }),
            ),
    };
    return addCustomFunctions(wrappedNSSocket);

    function handleNewConnection(data: NewConnectionMessage) {
        const client = Object.assign({}, data.additionalSocketInfo, {
            id: data.socketId,
            emit: (event: string, ...args: any[]) =>
                (rawNSSocket.in(data.socketId) as any).emit(event, ...args),
            on: function(event: string, callback: () => void) {
                const ls = setDefault(
                    setDefault(socketEventMap, data.socketId, () => new Map()),
                    event,
                    () => [],
                );
                ls.push(callback);
            },
            join: (room: string, cb: () => void) =>
                adapter.remoteJoin(data.socketId, room, cb),
            leave: (room: string, cb: () => void) =>
                adapter.remoteLeave(data.socketId, room, cb),
            disconnect: (close = false, cb?: () => void) =>
                adapter.remoteDisconnect(data.socketId, close, cb),
        });
        promisifySocket(client as any, { mapErrors: mapOnAsyncErrors });
        client.on("disconnect", () => {
            delete sockets[client.id];
            socketEventMap.delete(client.id);
        });
        const mws: MW[] = [
            ...middlewares,
            client => connectionListeners.forEach(cb => cb(client)),
        ];
        nextMiddleware(mws, client, 0);
        sockets[client.id] = client;
    }
    function handleClientMessage(data: ClientMessage) {
        const myMap = socketEventMap.get(data.socketId)!;
        if (!myMap) return;
        if (data.callbackId) {
            data.data.push((...args: any[]) =>
                adapter.pubClient.publish(
                    redisPrefix + `/toSlave/${data.slaveId}`,
                    JSON.stringify({
                        callbackId: data.callbackId,
                        data: args,
                        type: "callback",
                        namespace,
                        socketId: data.socketId,
                    } as ToSlaveMessage),
                ),
            );
        }
        const listeners = myMap.get(data.event);
        if (listeners)
            for (const listener of listeners) listener(...(data.data || []));
    }
}
function nextMiddleware(mws: any[], client: any, i: number) {
    if (i >= mws.length) return;
    mws[i](client, () => nextMiddleware(mws, client, i + 1));
}
