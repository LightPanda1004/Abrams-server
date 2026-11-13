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
        let resolveMemberLeave;
        let resolveRoomCompletion;
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
                respond(response, 200, {});
                resolveMemberLeave();
                return;
            }
            if (request.url.endsWith("/complete")) {
                roomCompletions++;
                respond(response, 200, {});
                resolveRoomCompletion();
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
                await memberLeaveCompleted;
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
        const firstClosed = once(first.socket, "close");

        const second = connectAndAuthenticate(
            url,
            "second-ticket-value-long-enough-123"
        );
        clients.push(second.socket);
        assert.equal((await second.authenticated).type, "authenticated");
        assert.equal(ticketValidations, 2);

        const [closeCode] = await firstClosed;
        assert.equal(closeCode, 4004);
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
