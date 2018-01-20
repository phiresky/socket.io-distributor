import { indirectSocketViaRedis } from "../../backend";
import { MyServerDefinition } from "./common";

const io = indirectSocketViaRedis<MyServerDefinition, "/chat">({
    namespace: "/chat",
    redis: { uri: "redis://localhost:6379" },
});

io.on("connection", client => {
    client.on("postMessage", info => {
        // typeof info.message === string
        // typeof info.channel === "en" | "ru"
        io.emit("chatMessage", {
            ...info,
            sender: client.id,
        });
    });
});
