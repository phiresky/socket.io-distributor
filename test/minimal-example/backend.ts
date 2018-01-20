import { indirectSocketViaRedis } from "../../backend";
import { MyServerDefinition } from "./common";

const io = indirectSocketViaRedis<MyServerDefinition, "/chat">({
    namespace: "/chat",
    redis: { uri: "redis://localhost:6379" },
});
