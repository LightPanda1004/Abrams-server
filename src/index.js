"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
    constantTimeEqual,
    hashTicket,
    signToken,
    verifyToken
} = require("./security");
const schema = require("./database-schema");
const { isAllowedOrigin } = require("./http-utils");
const { createAccountRoutes } = require("./routes/account-routes");
const { createRoomRoutes } = require("./routes/room-routes");
const { createServerRoutes } = require("./routes/server-routes");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 16 * 1024;
const ACCESS_TOKEN_SECONDS = 60 * 60 * 12;
const JOIN_TICKET_SECONDS = 60;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const rateLimits = new Map();
const authRateLimits = new Map();

function requiredSecret(name) {
    const value = process.env[name];
    if (!value || value.length < 32) {
        throw new Error(`${name} must contain at least 32 characters`);
    }
    return value;
}

let accessTokenSecret;
let serverApiToken;
let pool;
let nextRateLimitCleanupAt = 0;

function respond(response, status, body) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(body));
}

function clientAddress(request) {
    return request.socket.remoteAddress || "unknown";
}

function cleanupExpiredRateLimits(now = Date.now()) {
    if (now < nextRateLimitCleanupAt) {
        return;
    }
    nextRateLimitCleanupAt = now + RATE_LIMIT_CLEANUP_INTERVAL_MS;

    for (const [key, limit] of rateLimits) {
        if (limit.resetAt <= now) {
            rateLimits.delete(key);
        }
    }
    for (const [key, limit] of authRateLimits) {
        if (limit.resetAt <= now) {
            authRateLimits.delete(key);
        }
    }
}

function allowAuthRequest(request, response) {
    const now = Date.now();
    cleanupExpiredRateLimits(now);
    const key = clientAddress(request);
    const previous = authRateLimits.get(key);
    if (!previous || previous.resetAt <= now) {
        authRateLimits.set(key, { count: 1, resetAt: now + 60_000 });
        return true;
    }
    previous.count++;
    if (previous.count > 10) {
        respond(response, 429, { error: "Too many sign-in attempts. Try again shortly." });
        return false;
    }
    return true;
}

function allowRequest(request, response) {
    cleanupExpiredRateLimits();
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
        respond(response, 403, { error: "Origin is not allowed." });
        return false;
    }
    if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
        response.writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Server-Token",
            "Access-Control-Max-Age": "600"
        });
        response.end();
        return false;
    }

    const path = new URL(request.url, "http://localhost").pathname;
    if (path.startsWith("/api/server/") &&
        hasValidServerToken(request)) {
        return true;
    }

    const now = Date.now();
    const user = authenticatedUser(request);
    const key = user && typeof user.sub === "string"
        ? `user:${user.sub}`
        : `ip:${clientAddress(request)}`;
    const previous = rateLimits.get(key);
    if (!previous || previous.resetAt <= now) {
        rateLimits.set(key, { count: 1, resetAt: now + 60_000 });
        return true;
    }
    previous.count++;
    if (previous.count > 120) {
        respond(response, 429, { error: "Too many requests." });
        return false;
    }
    return true;
}

async function readJson(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error("Request body is too large.");
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) {
        return {};
    }
    let value;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        const error = new Error("Request body must be valid JSON.");
        error.status = 400;
        throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        const error = new Error("Request body must be a JSON object.");
        error.status = 400;
        throw error;
    }
    return value;
}

function authenticatedUser(request) {
    const header = request.headers.authorization || "";
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    return match ? verifyToken(match[1], accessTokenSecret) : null;
}

function requireServer(request, response) {
    if (!hasValidServerToken(request)) {
        respond(response, 401, { error: "Server authentication failed." });
        return false;
    }
    return true;
}

function hasValidServerToken(request) {
    const token = request.headers["x-server-token"];
    return typeof token === "string" &&
        typeof serverApiToken === "string" &&
        constantTimeEqual(token, serverApiToken);
}

function hashWalletNonce(nonce) {
    return crypto.createHash("sha256").update(nonce).digest("hex");
}

function createTicket() {
    return crypto.randomBytes(32).toString("base64url");
}

function accessToken(user) {
    return signToken(
        { sub: String(user.id), username: user.username },
        accessTokenSecret,
        ACCESS_TOKEN_SECONDS
    );
}

async function issueTicket(client, roomId, userId, team, playerName) {
    const ticket = createTicket();
    await client.query(
        `DELETE FROM join_tickets
         WHERE room_id = $1 AND user_id = $2 AND consumed_at IS NULL`,
        [roomId, userId]
    );
    await client.query(
        `INSERT INTO join_tickets
            (ticket_hash, room_id, user_id, team, player_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second'))`,
        [hashTicket(ticket), roomId, userId, team, playerName, JOIN_TICKET_SECONDS]
    );
    return ticket;
}

async function withTransaction(action) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await action(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function route(
    request,
    response,
    handleAccountRoute,
    handleRoomRoute,
    handleServerRoute
) {
    if (!allowRequest(request, response)) {
        return;
    }
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/health") {
        await pool.query("SELECT 1");
        respond(response, 200, { status: "ok" });
        return;
    }

    if (await handleAccountRoute(request, response, path, method)) {
        return;
    }

    if (await handleRoomRoute(request, response, path, method)) {
        return;
    }

    if (await handleServerRoute(request, response, path, method, url)) {
        return;
    }

    respond(response, 404, { error: "Not found." });
}

async function main() {
    accessTokenSecret = requiredSecret("ACCESS_TOKEN_SECRET");
    serverApiToken = requiredSecret("SERVER_API_TOKEN");
    if (accessTokenSecret === serverApiToken) {
        throw new Error("ACCESS_TOKEN_SECRET and SERVER_API_TOKEN must differ");
    }
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required");
    }
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
        throw new Error("PORT must be an integer from 1 to 65535");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(schema);
    const handleAccountRoute = createAccountRoutes({
        pool,
        respond,
        readJson,
        authenticatedUser,
        allowAuthRequest,
        withTransaction,
        accessToken,
        hashWalletNonce
    });
    const handleRoomRoute = createRoomRoutes({
        pool,
        respond,
        readJson,
        authenticatedUser,
        withTransaction,
        issueTicket
    });
    const handleServerRoute = createServerRoutes({
        pool,
        respond,
        readJson,
        requireServer,
        withTransaction
    });
    const server = http.createServer((request, response) => {
        route(
            request,
            response,
            handleAccountRoute,
            handleRoomRoute,
            handleServerRoute
        )
            .catch(error => {
            if (response.headersSent) {
                response.destroy(error);
                return;
            }
            const requestId = crypto.randomUUID();
            const path = new URL(request.url, "http://localhost").pathname;
            console.error(
                `Request failed [${requestId}] ${request.method} ${path}:`,
                error.message
            );
            respond(
                response,
                Number.isInteger(error.status) ? error.status : 500,
                {
                    error: error.status
                        ? error.message
                        : "The request could not be completed.",
                    requestId
                }
            );
        });
    });
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Abrams online service listening on port ${PORT}`);
    });

    const shutdown = async () => {
        server.close();
        await pool.end();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (require.main === module) {
    main().catch(error => {
        console.error("Could not start online service:", error.message);
        process.exitCode = 1;
    });
}
