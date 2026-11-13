"use strict";

process.env.ALLOWED_ORIGINS = "http://localhost:3000";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createGateway, getConfig } = require("./game-ws-gateway");

function respond(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json"
    });
    response.end(JSON.stringify(value));
}

function connectAndAuthenticate(url, ticket) {
    const socket = new WebSocket(url, {
        origin: "http://localhost:3000"
    });
    const authenticated = new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("close", (code, reason) => {
            reject(new Error(
                `Socket closed before authentication (${code}): ${reason}`
            ));
        });
        socket.on("message", raw => {
            const message = JSON.parse(raw.toString("utf8"));
            if (message.type === "authenticated") {
                resolve(message);
            } else if (message.type === "error") {
                reject(new Error(message.message));
            }
        });
        socket.once("open", () => {
            socket.send(JSON.stringify({
                type: "authenticate",
                ticket
            }));
        });
    });
    return { socket, authenticated };
}

test("gateway rejects loopback public endpoint without explicit local opt-in", () => {
    const configKeys = [
        "ABRAMS_ONLINE_API_URL",
        "ABRAMS_ONLINE_SERVER_ID",
        "ABRAMS_ONLINE_WS_PUBLIC_URL",
        "ABRAMS_ONLINE_ALLOW_LOCAL_WS_URL",
        "ABRAMS_ONLINE_WS_PORT",
        "ABRAMS_ONLINE_MAX_PLAYERS",
        "ABRAMS_ONLINE_RECONNECT_GRACE_MS",
        "SERVER_API_TOKEN",
        "NODE_ENV"
    ];
    const originalValues = new Map(
        configKeys.map(key => [key, process.env[key]])
    );

    try {
        process.env.ABRAMS_ONLINE_API_URL =
            "http://62.210.246.125:3000";
        process.env.ABRAMS_ONLINE_SERVER_ID = "test-gateway";
        process.env.ABRAMS_ONLINE_WS_PUBLIC_URL =
            "ws://127.0.0.1:7777/game";
        delete process.env.ABRAMS_ONLINE_ALLOW_LOCAL_WS_URL;
        process.env.ABRAMS_ONLINE_WS_PORT = "7777";
        process.env.ABRAMS_ONLINE_MAX_PLAYERS = "32";
        delete process.env.ABRAMS_ONLINE_RECONNECT_GRACE_MS;
        process.env.SERVER_API_TOKEN =
            "test-server-token-that-is-long-enough";
        delete process.env.NODE_ENV;

        assert.throws(
            () => getConfig(),
            /players cannot reach/
        );
        process.env.ABRAMS_ONLINE_ALLOW_LOCAL_WS_URL = "true";
        assert.equal(
            getConfig().publicWsUrl,
            "ws://127.0.0.1:7777/game"
        );
        assert.equal(getConfig().reconnectGraceMs, 30_000);
    } finally {
        for (const [key, value] of originalValues) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
});

test(
    "gateway refreshes assignment before ticket auth and replaces reconnects",
    { timeout: 10_000 },
    async t => {
        let assignmentPolls = 0;
        let ticketValidations = 0;
        let roomCompletions = 0;
        let registration;
        let resolveRoomCompletion;
        let resolveMemberLeave;
        const memberLeaveCompleted = new Promise(resolve => {
            resolveMemberLeave = resolve;
        });
        const roomCompletion = new Promise(resolve => {
            resolveRoomCompletion = resolve;
        });
        const api = http.createServer((request, response) => {
            if (request.url === "/api/server/register") {
                const chunks = [];
                request.on("data", chunk => chunks.push(chunk));
                request.on("end", () => {
                    registration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    respond(response, 200, {});
                });
                return;
            }
            if (request.url.startsWith("/api/server/assignment")) {
                assignmentPolls++;
                respond(response, 200, assignmentPolls === 1
                    ? { room: null }
                    : { room: { id: "42" } });
                return;
            }
            if (request.url === "/api/server/tickets/validate") {
                ticketValidations++;
                respond(response, 200, {
                    roomId: "42",
                    userId: "123",
                    team: 1,
                    playerName: "Pilot"
                });
                return;
            }
            if (request.url.endsWith("/leave")) {
                request.resume();
                respond(response, 200, {});
                resolveMemberLeave();
                return;
            }
            if (request.url.endsWith("/complete")) {
                const chunks = [];
                request.on("data", chunk => chunks.push(chunk));
                request.on("end", () => {
                    roomCompletions++;
                    assert.equal(
                        JSON.parse(Buffer.concat(chunks).toString("utf8"))
                            .reason,
                        "reconnect_grace_expired_empty"
                    );
                    respond(response, 200, {});
                    resolveRoomCompletion();
                });
                return;
            }
            respond(response, 200, {});
        });
        api.listen(0, "127.0.0.1");
        await once(api, "listening");
        const apiAddress = api.address();

        const gateway = createGateway({
            apiUrl: new URL(`http://127.0.0.1:${apiAddress.port}`),
            serverId: "test-gateway",
            publicWsUrl: "ws://127.0.0.1:7777/game",
            port: 0,
            maxPlayers: 32,
            reconnectGraceMs: 200,
            serverToken: "test-server-token-that-is-long-enough"
        });
        let gatewayStarted = false;
        const clients = [];

        t.after(async () => {
            for (const client of clients) {
                if (client.readyState === WebSocket.OPEN)
                    client.close();
            }
            if (gatewayStarted) {
                await gateway.stop();
            }
            await new Promise(resolve => api.close(resolve));
        });

        await gateway.start();
        gatewayStarted = true;
        assert.equal(registration.host, "127.0.0.1");
        assert.equal(registration.port, 7777);
        const port = gateway.server.address().port;
        const url = `ws://127.0.0.1:${port}/game`;

        const first = connectAndAuthenticate(
            url,
            "first-ticket-value-long-enough-123"
        );
        clients.push(first.socket);
        assert.equal((await first.authenticated).type, "authenticated");
        assert.ok(assignmentPolls >= 2);
        const afterRejectedDroneUpdate = new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error("Room stopped broadcasting after drone input.")),
                2000
            );
            const onMessage = raw => {
                const message = JSON.parse(raw.toString("utf8"));
                if (message.type !== "state")
                    return;
                const player = message.players?.find(item =>
                    item.userId === "123"
                );
                if (!player)
                    return;
                clearTimeout(timeout);
                first.socket.off("message", onMessage);
                resolve(player);
            };
            first.socket.once("close", (code, reason) => {
                clearTimeout(timeout);
                reject(new Error(
                    `Drone update closed the room socket (${code}): ${reason}`
                ));
            });
            first.socket.on("message", onMessage);
        });
        first.socket.send(JSON.stringify({
            type: "input",
            throttle: 0,
            steering: 0,
            fire: false,
            droneActive: true,
            droneFlying: false,
            droneX: 1000,
            droneY: 1,
            droneZ: 0
        }));
        const stateAfterRejectedDroneUpdate =
            await afterRejectedDroneUpdate;
        assert.equal(stateAfterRejectedDroneUpdate.droneActive, false);
        assert.equal(first.socket.readyState, WebSocket.OPEN);

        const firstPosition = first.authenticated.then(state => {
            const initialX = state.snapshot.players[0].x;
            const moved = new Promise((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error("Tank did not move before disconnect.")),
                    2000
                );
                const onMessage = raw => {
                    const message = JSON.parse(raw.toString("utf8"));
                    const current = message.players?.find(player =>
                        player.userId === "123"
                    );
                    if (message.type !== "state" || !current ||
                        current.x === initialX)
                        return;
                    clearTimeout(timeout);
                    first.socket.off("message", onMessage);
                    resolve(current.x);
                };
                first.socket.on("message", onMessage);
            });
            first.socket.send(JSON.stringify({
                type: "input",
                throttle: 1,
                steering: 0,
                fire: false
            }));
            return moved;
        });
        const movedX = await firstPosition;
        const firstClosed = once(first.socket, "close");
        first.socket.close();
        await firstClosed;

        const second = connectAndAuthenticate(
            url,
            "second-ticket-value-long-enough-123"
        );
        clients.push(second.socket);
        const reconnectedState = await second.authenticated;
        assert.equal(reconnectedState.type, "authenticated");
        assert.equal(reconnectedState.snapshot.players.length, 1);
        assert.equal(reconnectedState.snapshot.players[0].userId, "123");
        assert.equal(reconnectedState.snapshot.players[0].connected, true);
        assert.equal(reconnectedState.snapshot.players[0].x, movedX);
        assert.equal(ticketValidations, 2);

        second.socket.close();
        await roomCompletion;
        assert.equal(roomCompletions, 1);
        await memberLeaveCompleted;
    }
);

test(
    "gateway isolates simultaneous rooms on one dedicated server",
    { timeout: 10_000 },
    async t => {
        const completedRooms = new Set();
        const api = http.createServer((request, response) => {
            if (request.url === "/api/server/register") {
                request.resume();
                respond(response, 200, {});
                return;
            }
            if (request.url.startsWith("/api/server/assignment")) {
                respond(response, 200, {
                    rooms: [{ id: "42" }, { id: "43" }]
                });
                return;
            }
            if (request.url === "/api/server/tickets/validate") {
                const chunks = [];
                request.on("data", chunk => chunks.push(chunk));
                request.on("end", () => {
                    const { ticket } = JSON.parse(
                        Buffer.concat(chunks).toString("utf8")
                    );
                    const first = ticket.startsWith("first");
                    respond(response, 200, {
                        roomId: first ? "42" : "43",
                        userId: first ? "123" : "456",
                        team: first ? 1 : 2,
                        playerName: first ? "Pilot One" : "Pilot Two"
                    });
                });
                return;
            }
            if (request.url.endsWith("/complete")) {
                completedRooms.add(request.url.split("/")[4]);
                respond(response, 200, {});
                return;
            }
            request.resume();
            respond(response, 200, {});
        });
        api.listen(0, "127.0.0.1");
        await once(api, "listening");
        const apiAddress = api.address();

        const gateway = createGateway({
            apiUrl: new URL(`http://127.0.0.1:${apiAddress.port}`),
            serverId: "multi-room-gateway",
            publicWsUrl: "ws://127.0.0.1:7777/game",
            port: 0,
            maxPlayers: 32,
            reconnectGraceMs: 0,
            serverToken: "test-server-token-that-is-long-enough"
        });
        let gatewayStarted = false;
        const clients = [];

        t.after(async () => {
            for (const client of clients) {
                if (client.readyState === WebSocket.OPEN)
                    client.close();
            }
            if (gatewayStarted)
                await gateway.stop();
            await new Promise(resolve => api.close(resolve));
        });

        await gateway.start();
        gatewayStarted = true;
        const url = `ws://127.0.0.1:${gateway.server.address().port}/game`;
        const first = connectAndAuthenticate(
            url,
            "first-ticket-value-long-enough-123"
        );
        const second = connectAndAuthenticate(
            url,
            "second-ticket-value-long-enough-123"
        );
        clients.push(first.socket, second.socket);

        const [firstState, secondState] = await Promise.all([
            first.authenticated,
            second.authenticated
        ]);
        assert.equal(firstState.roomId, "42");
        assert.equal(secondState.roomId, "43");
        assert.deepEqual(
            firstState.snapshot.players.map(player => player.userId),
            ["123"]
        );
        assert.deepEqual(
            secondState.snapshot.players.map(player => player.userId),
            ["456"]
        );

        first.socket.close();
        second.socket.close();
        await Promise.all([
            once(first.socket, "close"),
            once(second.socket, "close")
        ]);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual([...completedRooms].sort(), ["42", "43"]);
    }
);

test(
    "creating another room keeps the first active room joinable",
    { timeout: 10_000 },
    async t => {
        let exposeSecondRoom = false;
        const completedRooms = new Set();
        let memberLeaves = 0;
        let resolveBothMemberLeaves;
        const bothMemberLeaves = new Promise(resolve => {
            resolveBothMemberLeaves = resolve;
        });
        let resolveFirstRoomCompletion;
        const firstRoomCompletion = new Promise(resolve => {
            resolveFirstRoomCompletion = resolve;
        });
        let resolveSecondRoomCompletion;
        const secondRoomCompletion = new Promise(resolve => {
            resolveSecondRoomCompletion = resolve;
        });
        const api = http.createServer((request, response) => {
            if (request.url === "/api/server/register") {
                request.resume();
                respond(response, 200, {});
                return;
            }
            if (request.url.startsWith("/api/server/assignment")) {
                respond(response, 200, {
                    rooms: exposeSecondRoom
                        ? [{ id: "42" }, { id: "43" }]
                        : [{ id: "42" }]
                });
                return;
            }
            if (request.url === "/api/server/tickets/validate") {
                const chunks = [];
                request.on("data", chunk => chunks.push(chunk));
                request.on("end", () => {
                    const { ticket } = JSON.parse(
                        Buffer.concat(chunks).toString("utf8")
                    );
                    const second = ticket.startsWith("second");
                    respond(response, 200, {
                        roomId: second ? "43" : "42",
                        userId: second ? "456" : "123",
                        team: second ? 2 : 1,
                        playerName: second ? "Pilot Two" : "Pilot One"
                    });
                });
                return;
            }
            if (request.url.endsWith("/complete")) {
                const roomId = request.url.split("/")[4];
                completedRooms.add(roomId);
                respond(response, 200, {});
                if (roomId === "42")
                    resolveFirstRoomCompletion();
                if (roomId === "43")
                    resolveSecondRoomCompletion();
                return;
            }
            if (request.url.endsWith("/leave")) {
                request.resume();
                respond(response, 200, {});
                memberLeaves++;
                if (memberLeaves === 2)
                    resolveBothMemberLeaves();
                return;
            }
            request.resume();
            respond(response, 200, {});
        });
        api.listen(0, "127.0.0.1");
        await once(api, "listening");
        const apiAddress = api.address();

        const gateway = createGateway({
            apiUrl: new URL(`http://127.0.0.1:${apiAddress.port}`),
            serverId: "room-persistence-gateway",
            publicWsUrl: "ws://127.0.0.1:7777/game",
            port: 0,
            maxPlayers: 32,
            reconnectGraceMs: 0,
            serverToken: "test-server-token-that-is-long-enough"
        });
        let gatewayStarted = false;
        const clients = [];

        t.after(async () => {
            for (const client of clients) {
                if (client.readyState === WebSocket.OPEN)
                    client.close();
            }
            if (gatewayStarted)
                await gateway.stop();
            await new Promise(resolve => api.close(resolve));
        });

        await gateway.start();
        gatewayStarted = true;
        const url = `ws://127.0.0.1:${gateway.server.address().port}/game`;
        const first = connectAndAuthenticate(
            url,
            "first-ticket-value-long-enough-123"
        );
        clients.push(first.socket);
        const firstState = await first.authenticated;
        assert.equal(firstState.roomId, "42");

        exposeSecondRoom = true;
        const second = connectAndAuthenticate(
            url,
            "second-ticket-value-long-enough-123"
        );
        clients.push(second.socket);
        const secondState = await second.authenticated;
        assert.equal(secondState.roomId, "43");

        const firstRoomState = new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error("First room stopped receiving updates.")),
                2000
            );
            const onMessage = raw => {
                const message = JSON.parse(raw.toString("utf8"));
                if (message.type !== "state" ||
                    !message.players?.some(player =>
                        player.userId === "123" && player.x !==
                            firstState.snapshot.players[0].x
                    )) {
                    return;
                }
                clearTimeout(timeout);
                first.socket.off("message", onMessage);
                resolve(message);
            };
            first.socket.on("message", onMessage);
        });
        first.socket.send(JSON.stringify({
            type: "input",
            throttle: 1,
            steering: 0,
            fire: false
        }));
        const updatedFirstRoom = await firstRoomState;
        assert.equal(updatedFirstRoom.roomId, "42");
        assert.equal(secondState.roomId, "43");

        second.socket.close();
        await once(second.socket, "close");
        await secondRoomCompletion;
        assert.ok(completedRooms.has("43"));
        assert.equal(completedRooms.has("42"), false);

        first.socket.close();
        await once(first.socket, "close");
        await Promise.all([firstRoomCompletion, bothMemberLeaves]);
    }
);
