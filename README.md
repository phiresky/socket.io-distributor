## Usage

### Backends

On your backends, instead of doing this:

```ts
import socketio from "socket.io";
import http from "http";
const server = http.createServer();
const io = io(server).of("/test");
server.listen(8000);
```

Do this:

```ts
```

And then start a few load leveling processes that look like this:

```ts
```

* Worker Server
