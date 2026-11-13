"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { URL } = require("node:url");
const { WebSocketServer, WebSocket } = require("ws");
const { GameRoom, ROOM_CAPACITY } = require("./game-room");
const { constantTimeEqual } = require("./security");
const { isAllowedOrigin } = require("./index");

const TICK_RATE_MS = 50;
const ASSIGNMENT_POLL_MS = 3000;
const HEARTBEAT_MS = 5000;
const EMPTY_ROOM_GRACE_MS = 30_000;
const MAX_MESSAGES_PER_SECOND = 30;

function requiredEnv(name) {
    const value = process.env[name];
    if (!value || value.length < 1) {
        throw new Error(`${name} is required.`);
    }
    return value;
}

function validServerId(value) {
    return typeof value === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" ||
        host === "::1" ||
        host.startsWith("127.");
}

function getConfig() {
    const apiUrl = new URL(requiredEnv("ABRAMS_ONLINE_API_URL"));
    const serverId = requiredEnv("ABRAMS_ONLINE_SERVER_ID");
    const publicWsUrl = new URL(requiredEnv("ABRAMS_ONLINE_WS_PUBLIC_URL"));
    const port = Number(process.env.ABRAMS_ONLINE_WS_PORT || 7777);
    const maxPlayers = Number(process.env.ABRAMS_ONLINE_MAX_PLAYERS || ROOM_CAPACITY);
    const serverToken = requiredEnv("SERVER_API_TOKEN");
    if (!["http:", "https:"].includes(apiUrl.protocol) ||
        !validServerId(serverId) ||
        !["ws:", "wss:"].includes(publicWsUrl.protocol) ||
        !publicWsUrl.pathname.endsWith("/game") ||
        publicWsUrl.search || publicWsUrl.hash ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        !Number.isInteger(maxPlayers) || maxPlayers < 2 ||
        maxPlayers > ROOM_CAPACITY || serverToken.length < 32) {
        throw new Error("Dedicated WebSocket server configuration is invalid.");
    }
    if (isLoopbackHost(publicWsUrl.hostname) &&
        process.env.ABRAMS_ONLINE_ALLOW_LOCAL_WS_URL !== "true") {
        throw new Error(
            "ABRAMS_ONLINE_WS_PUBLIC_URL points to localhost/loopback, " +
            "which players cannot reach unless the gateway runs on their " +
            "own computer. Set it to the VPS's public WebSocket address or " +
            "domain and restart the gateway. For local-only development, " +
            "explicitly set ABRAMS_ONLINE_ALLOW_LOCAL_WS_URL=true."
        );
    }
    if (process.env.NODE_ENV === "production" &&
        (apiUrl.protocol !== "https:" || publicWsUrl.protocol !== "wss:")) {
        throw new Error("Production game servers require HTTPS and WSS endpoints.");
    }
    return {
        apiUrl,
        serverId,
        publicWsUrl: publicWsUrl.toString(),
        port,
        maxPlayers,
        serverToken
    };
}

function sendJson(socket, value) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(value));
    }
}

function createGateway(config) {
    const app = config.server || http.createServer();
    const webSockets = new WebSocketServer({
        noServer: true,
        maxPayload: 4096,
        perMessageDeflate: false
    });
    const socketsByUserId = new Map();
    let activeRoom = null;
    let activeRoomId = "";
    let emptySince = 0;
    let startedRoomId = "";
    let stopping = false;
    let roomHadPlayers = false;
    let completionInProgressRoomId = "";
    let completionRetryAt = 0;
    let completionFailures = 0;
    let assignmentPollPromise = null;
    let heartbeatPromise = null;

    async function apiRequest(path, body) {
        const response = await fetch(new URL(path, config.apiUrl), {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "X-Server-Token": config.serverToken,
                ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/json" })
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000)
        });
        const text = await response.text();
        let result;
        try {
            result = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(`API returned invalid JSON for ${path}.`);
        }
        if (!response.ok) {
            throw new Error(
                `API request ${path} failed (${response.status}): ` +
                (result.error || "request rejected")
            );
        }
        return result;
    }

    async function register() {
        const publicWsUrl = new URL(config.publicWsUrl);
        await apiRequest("/api/server/register", {
            id: config.serverId,
            host: publicWsUrl.hostname,
            port: Number(publicWsUrl.port || (
                publicWsUrl.protocol === "wss:" ? 443 : 80
            )),
            maxPlayers: config.maxPlayers,
            wsUrl: publicWsUrl.toString()
        });
    }

    function pollAssignment() {
        if (stopping) {
            return Promise.resolve();
        }
        if (!assignmentPollPromise) {
            assignmentPollPromise = (async () => {
                const result = await apiRequest(
                    `/api/server/assignment?id=${encodeURIComponent(config.serverId)}`
                );
                const nextRoomId = result.room ? String(result.room.id) : "";
                if (nextRoomId === activeRoomId) {
                    return;
                }
                if (activeRoom && activeRoom.players.size > 0) {
                    console.error(
                        `Assignment changed while room ${activeRoomId} had connected players.`
                    );
                    return;
                }
                activeRoomId = nextRoomId;
                activeRoom = nextRoomId
                    ? new GameRoom(nextRoomId, config.maxPlayers)
                    : null;
                emptySince = 0;
                startedRoomId = "";
                roomHadPlayers = false;
                completionRetryAt = 0;
                completionFailures = 0;
                if (activeRoom) {
                    console.log(`Dedicated game room ${activeRoomId} is ready.`);
                }
            })().finally(() => {
                assignmentPollPromise = null;
            });
        }
        return assignmentPollPromise;
    }

    async function validateTicket(ticket) {
        return apiRequest("/api/server/tickets/validate", {
            ticket,
            serverId: config.serverId
        });
    }

    async function startRoomIfReady(roomId) {
        if (!activeRoom || activeRoomId !== roomId ||
            activeRoom.players.size < 2 || startedRoomId === roomId) {
            return;
        }
        await apiRequest(
            `/api/server/rooms/${encodeURIComponent(roomId)}/start`,
            { serverId: config.serverId }
        );
        if (activeRoomId === roomId && activeRoom?.players.size >= 2) {
            startedRoomId = roomId;
        }
    }

    function broadcastState(state) {
        for (const socket of socketsByUserId.values()) {
            sendJson(socket, state);
        }
    }

    async function completeEmptyRoom(roomId) {
        if (completionInProgressRoomId === roomId) {
            return;
        }
        completionInProgressRoomId = roomId;
        try {
            await apiRequest(
                `/api/server/rooms/${encodeURIComponent(roomId)}/complete`,
                { serverId: config.serverId }
            );
            if (activeRoomId === roomId &&
                activeRoom &&
                activeRoom.players.size === 0) {
                activeRoom = null;
                activeRoomId = "";
                startedRoomId = "";
                emptySince = 0;
                roomHadPlayers = false;
                completionRetryAt = 0;
                completionFailures = 0;
            }
        } finally {
            completionInProgressRoomId = "";
        }
    }

    function closeRoomWhenEmpty(now) {
        if (!activeRoom || activeRoom.players.size > 0) {
            emptySince = 0;
            return;
        }
        if (!roomHadPlayers && !emptySince) {
            emptySince = now;
            return;
        }
        if (!roomHadPlayers && now - emptySince < EMPTY_ROOM_GRACE_MS) {
            return;
        }
        if (completionInProgressRoomId || now < completionRetryAt) {
            return;
        }
        const roomId = activeRoomId;
        completeEmptyRoom(roomId).catch(error => {
            completionFailures++;
            completionRetryAt = Date.now() + Math.min(
                30_000,
                1_000 * (2 ** Math.min(completionFailures - 1, 5))
            );
            console.error(`Could not complete empty room ${roomId}:`, error.message);
        });
    }

    async function disconnectPlayer(socket, userId) {
        if (!userId || socketsByUserId.get(userId) !== socket) {
            return;
        }
        const roomId = activeRoomId;
        socketsByUserId.delete(userId);
        activeRoom?.removePlayer(userId);
        closeRoomWhenEmpty(Date.now());
        sendJson(socket, { type: "disconnected" });
        if (activeRoom) {
            broadcastState(activeRoom.snapshot());
        }
        try {
            await apiRequest(
                `/api/server/rooms/${encodeURIComponent(roomId)}/leave`,
                { serverId: config.serverId, userId }
            );
        } catch (error) {
            console.error(`Could not release room member ${userId}:`, error.message);
        }
    }

    function upgrade(request, socket, head) {
        const origin = request.headers.origin;
        let requestUrl;
        try {
            requestUrl = new URL(request.url, config.publicWsUrl);
        } catch {
            socket.destroy();
            return;
        }
        if (requestUrl.pathname !== "/game" ||
            requestUrl.search || requestUrl.hash ||
            typeof origin !== "string" ||
            !isAllowedOrigin(origin)) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        webSockets.handleUpgrade(request, socket, head, client => {
            webSockets.emit("connection", client, request);
        });
    }

    function handleConnection(socket) {
        let userId = "";
        let authenticating = false;
        let messageCount = 0;
        let messageWindowStart = Date.now();
        const authenticationTimer = setTimeout(() => {
            socket.close(4001, "Authentication required.");
        }, 5000);
        socket.on("pong", () => {
            socket.isAlive = true;
        });
        socket.isAlive = true;
        socket.on("message", async raw => {
            const now = Date.now();
            if (now - messageWindowStart >= 1000) {
                messageWindowStart = now;
                messageCount = 0;
            }
            messageCount++;
            if (messageCount > MAX_MESSAGES_PER_SECOND) {
                socket.close(4008, "Message rate exceeded.");
                return;
            }

            let message;
            try {
                message = JSON.parse(raw.toString("utf8"));
            } catch {
                socket.close(4002, "Invalid JSON.");
                return;
            }

            if (!userId) {
                if (authenticating) {
                    socket.close(4001, "Authentication is already in progress.");
                    return;
                }
                if (message.type !== "authenticate" ||
                    typeof message.ticket !== "string" ||
                    message.ticket.length < 32 ||
                    message.ticket.length > 256) {
                    socket.close(4001, "Authentication required.");
                    return;
                }
                authenticating = true;
                clearTimeout(authenticationTimer);
                try {
                    await pollAssignment();
                    if (!activeRoom) {
                        socket.close(4003, "This server is not assigned to a room.");
                        return;
                    }
                    if (completionInProgressRoomId === activeRoomId) {
                        socket.close(4003, "This room is closing.");
                        return;
                    }
                    const ticket = await validateTicket(message.ticket);
                    if (socket.readyState !== WebSocket.OPEN ||
                        completionInProgressRoomId === activeRoomId ||
                        !activeRoom ||
                        String(ticket.roomId) !== activeRoomId) {
                        await apiRequest(
                            `/api/server/rooms/${encodeURIComponent(ticket.roomId)}/leave`,
                            {
                                serverId: config.serverId,
                                userId: String(ticket.userId)
                            }
                        );
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.close(
                                4003,
                                "This server is no longer accepting players for that room."
                            );
                        }
                        return;
                    }
                    if (socketsByUserId.has(ticket.userId)) {
                        const previous = socketsByUserId.get(ticket.userId);
                        socketsByUserId.delete(ticket.userId);
                        activeRoom.removePlayer(ticket.userId);
                        previous.close(4004, "This account connected elsewhere.");
                    }
                    activeRoom.addPlayer({
                        userId: String(ticket.userId),
                        playerName: ticket.playerName,
                        team: ticket.team
                    });
                    roomHadPlayers = true;
                    emptySince = 0;
                    userId = String(ticket.userId);
                    socketsByUserId.set(userId, socket);
                    sendJson(socket, {
                        type: "authenticated",
                        roomId: activeRoomId,
                        userId,
                        playerName: ticket.playerName,
                        team: ticket.team,
                        snapshot: activeRoom.snapshot()
                    });
                    await startRoomIfReady(activeRoomId);
                    broadcastState(activeRoom.snapshot());
                } catch (error) {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.close(4003, error.message);
                    }
                }
                return;
            }

            if (!activeRoom || message.type !== "input" ||
                !activeRoom.setInput(userId, message)) {
                socket.close(4002, "Invalid game input.");
            }
        });
        socket.on("close", () => {
            clearTimeout(authenticationTimer);
            disconnectPlayer(socket, userId);
        });
        socket.on("error", error => {
            console.warn("Game WebSocket error:", error.message);
        });
    }

    app.on("upgrade", upgrade);
    webSockets.on("connection", handleConnection);

    const tickTimer = setInterval(() => {
        if (activeRoom) {
            broadcastState(activeRoom.tick(TICK_RATE_MS / 1000));
            closeRoomWhenEmpty(Date.now());
        }
    }, TICK_RATE_MS);
    const assignmentTimer = setInterval(() => {
        pollAssignment().catch(error => {
            console.error("Could not poll room assignment:", error.message);
        });
    }, ASSIGNMENT_POLL_MS);
    const heartbeatTimer = setInterval(() => {
        if (heartbeatPromise) {
            return;
        }
        const heartbeats = [
            apiRequest("/api/server/heartbeat", { id: config.serverId })
                .catch(error => {
                    console.error("Dedicated-server heartbeat failed:", error.message);
                })
        ];
        if (activeRoom && activeRoom.players.size > 0) {
            heartbeats.push(
                apiRequest(
                    `/api/server/rooms/${encodeURIComponent(activeRoomId)}/members/heartbeat`,
                    {
                        serverId: config.serverId,
                        userIds: [...activeRoom.players.keys()]
                    }
                ).catch(error => {
                    console.error("Room member heartbeat failed:", error.message);
                })
            );
        }
        heartbeatPromise = Promise.all(heartbeats).finally(() => {
            heartbeatPromise = null;
        });
    }, HEARTBEAT_MS);

    return {
        server: app,
        async start() {
            await register();
            await pollAssignment();
            await new Promise((resolve, reject) => {
                app.once("error", reject);
                app.listen(config.port, "0.0.0.0", resolve);
            });
            const address = app.address();
            const listeningPort = address && typeof address === "object"
                ? address.port
                : config.port;
            console.log(
                `Dedicated WebSocket server ${config.serverId} listening ` +
                `on port ${listeningPort}, advertising ${config.publicWsUrl}`
            );
        },
        async stop() {
            stopping = true;
            clearInterval(tickTimer);
            clearInterval(assignmentTimer);
            clearInterval(heartbeatTimer);
            for (const socket of socketsByUserId.values()) {
                socket.close(1001, "Dedicated server shutting down.");
            }
            await new Promise(resolve => {
                webSockets.close(() => app.close(resolve));
            });
        }
    };
}

async function main() {
    const hasTlsCert = Boolean(process.env.TLS_CERT_FILE);
    const hasTlsKey = Boolean(process.env.TLS_KEY_FILE);
    if (hasTlsCert !== hasTlsKey) {
        throw new Error(
            "TLS_CERT_FILE and TLS_KEY_FILE must be configured together."
        );
    }
    const config = getConfig();
    if (hasTlsCert) {
        config.server = https.createServer({
            cert: fs.readFileSync(process.env.TLS_CERT_FILE),
            key: fs.readFileSync(process.env.TLS_KEY_FILE)
        });
    } else {
        config.server = http.createServer();
    }
    const gateway = createGateway(config);
    const shutdown = async () => {
        await gateway.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
        await gateway.start();
    } catch (error) {
        await gateway.stop().catch(() => {});
        throw error;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error("Could not start dedicated WebSocket server:", error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    getConfig,
    createGateway,
    validServerId,
    isLoopbackHost
};
