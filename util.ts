import { RedisClient } from "redis";

var Emitter = require("events").EventEmitter;

export const DEFAULT_PREFIX = "siod";

export function socketIoWildcard() {
    var emit = Emitter.prototype.emit;

    function onevent(this: any, packet: any) {
        var args = packet.data || [];
        if (packet.id != null) {
            args.push(this.ack(packet.id));
        }
        emit.call(this, "*", packet);
        return emit.apply(this, args);
    }

    return function(socket: any, next: any) {
        if (socket.onevent !== onevent) {
            socket.onevent = onevent;
        }
        return next ? next() : null;
    };
}

/**
 * return the value for key K from the given map, setting a default if it doesn't exist
 *
 * inspired by python dict.setdefault
 */
export function setDefault<K, V>(map: Map<K, V>, k: K, def: () => V) {
    let res = map.get(k);
    if (!res) {
        res = def();
        map.set(k, res);
    }
    return res;
}

export function publishCustomEvent(
    redisClient: RedisClient,
    event: { [name: string]: any },
    prefix = DEFAULT_PREFIX,
) {
    redisClient.publish(
        prefix + `/toSlave/all`,
        JSON.stringify({ ...event, type: "custom" }),
    );
}
