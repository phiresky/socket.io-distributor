import { Worker } from "../../distributor";
import * as http from "http";
import { MyServerDefinition } from "./common";

const slaveId = +process.argv[2];
const server = http.createServer();
server.listen(8000 + slaveId);
new Worker<MyServerDefinition>({
    server,
    slaveId,
    // optional: prevent CSRF
    validOrigins:
        process.env.NODE_ENV === "production"
            ? ["http://localhost"]
            : undefined,
    namespaces: ["/chat" /*...*/],
    redis: { uri: "redis://localhost:6379" },
});
