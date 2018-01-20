# socket.io-distributor

Simple load leveling for socket.io. Transfers events via redis like [socket.io-redis](https://github.com/socketio/socket.io-redis) but allows two-way communication.

Install via npm: [socket.io-distributor](https://www.npmjs.com/package/socket.io-distributor).

Source code on GitHub: [phiresky/socket.io-distributor](https://github.com/phiresky/socket.io-distributor)

Works great with [typed-socket.io](https://github.com/phiresky/typed-socket.io).

## Usage


On your backend, instead of doing this:

```ts
import socketio from "socket.io";
import http from "http";
const server = http.createServer();
server.listen(8000);
const io = io(server).of("/chat");
```

Do this:

```ts
import { indirectSocketViaRedis } from "socket.io-distributor/backend";

const io = indirectSocketViaRedis<MyServerDefinition, "/chat">({
    namespace: "/chat",
    redis: { uri: "redis://localhost:6379" },
});
```

The `io` object will work basically the same as before.

Then you start a few distributor processes that look like this:

```ts
const slaveId = +process.argv[2];
const server = http.createServer();
server.listen(8000 + slaveId);
const worker = new Worker<MyServerDefinition>({
    server,
    slaveId,
    namespaces: ["/chat" /*...*/],
    redis: { uri: "redis://localhost:6379" },
});
```

Now clients can connect to any of http://localhost:8001, http://localhost:8002, etc, and they will be able to send and receive messages from the backend.
