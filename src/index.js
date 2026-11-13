"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
    Contract,
    getAddress,
    id,
    isAddress,
    JsonRpcProvider,
    verifyMessage,
    Wallet
} = require("ethers");
const {
    constantTimeEqual,
    hashPassword,
    hashTicket,
    signToken,
    verifyPassword,
    verifyToken
} = require("./security");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 16 * 1024;
const ACCESS_TOKEN_SECONDS = 60 * 60 * 12;
const JOIN_TICKET_SECONDS = 60;
const ROOM_CAPACITY = 32;
const MAX_UINT256 = (1n << 256n) - 1n;
const GAME_SERVER_ROLE = id("GAME_SERVER_ROLE");
const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean)
);
const TANK_GAME_ABI = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function processedBattleIds(bytes32 battleId) view returns (bool)",
    "function coin() view returns (address)",
    "function rewardDestroyEnemy(address player, uint256 amount, string reason, bytes32 battleId)"
];
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
let blockchainContractPromise;

const schema = `
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    wallet_address TEXT,
    experience BIGINT NOT NULL DEFAULT 0 CHECK (experience >= 0),
    battles_played BIGINT NOT NULL DEFAULT 0 CHECK (battles_played >= 0),
    victories BIGINT NOT NULL DEFAULT 0 CHECK (victories >= 0),
    defeats BIGINT NOT NULL DEFAULT 0 CHECK (defeats >= 0),
    tanks_destroyed BIGINT NOT NULL DEFAULT 0 CHECK (tanks_destroyed >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS experience BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battles_played BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS victories BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS defeats BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tanks_destroyed BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_address_unique_idx
    ON users (wallet_address) WHERE wallet_address IS NOT NULL;
CREATE TABLE IF NOT EXISTS wallet_challenges (
    nonce_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS game_servers (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 32),
    ws_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready', 'busy', 'offline')),
    current_room_id BIGINT,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE game_servers ADD COLUMN IF NOT EXISTS ws_url TEXT;
CREATE TABLE IF NOT EXISTS rooms (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id BIGINT NOT NULL REFERENCES users(id),
    server_id TEXT NOT NULL REFERENCES game_servers(id),
    status TEXT NOT NULL CHECK (status IN ('waiting', 'playing', 'complete')),
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS room_members (
    room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team SMALLINT NOT NULL CHECK (team IN (1, 2)),
    player_name TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS join_tickets (
    ticket_hash TEXT PRIMARY KEY,
    room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team SMALLINT NOT NULL CHECK (team IN (1, 2)),
    player_name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS match_results (
    room_id BIGINT PRIMARY KEY REFERENCES rooms(id),
    server_id TEXT NOT NULL REFERENCES game_servers(id),
    winning_team SMALLINT NOT NULL CHECK (winning_team IN (1, 2)),
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS player_match_results (
    room_id BIGINT NOT NULL REFERENCES match_results(room_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team SMALLINT NOT NULL CHECK (team IN (1, 2)),
    kills INTEGER NOT NULL CHECK (kills BETWEEN 0 AND 100),
    victory BOOLEAN NOT NULL,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS rooms_status_created_idx
    ON rooms (status, created_at);
CREATE INDEX IF NOT EXISTS join_tickets_room_idx
    ON join_tickets (room_id, expires_at);
`;

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

function isAllowedOrigin(origin) {
    if (allowedOrigins.has(origin)) {
        return true;
    }
    if (process.env.NODE_ENV === "production") {
        return false;
    }

    try {
        const url = new URL(origin);
        return url.origin === origin &&
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
        return false;
    }
}

function allowAuthRequest(request, response) {
    const now = Date.now();
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

function validUsername(value) {
    return typeof value === "string" &&
        /^[A-Za-z0-9_]{3,24}$/.test(value);
}

function validPassword(value) {
    return typeof value === "string" &&
        value.length >= 10 &&
        value.length <= 128 &&
        /[A-Za-z]/.test(value) &&
        /\d/.test(value);
}

function validTeam(value) {
    return value === "blue" || value === "red";
}

function validPlayerAddress(value) {
    return typeof value === "string" && isAddress(value);
}

function validRewardAmount(value) {
    if (typeof value !== "string" ||
        value.length > 78 ||
        !/^[1-9]\d*$/.test(value)) {
        return false;
    }
    return BigInt(value) <= MAX_UINT256;
}

function validBattleId(value) {
    return typeof value === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(value) &&
        !/^0x0{64}$/i.test(value);
}

function walletChallengeMessage(userId, walletAddress, nonce) {
    return [
        "Abrams Tank Battle wallet binding",
        `Account: ${userId}`,
        `Wallet: ${walletAddress}`,
        `Nonce: ${nonce}`
    ].join("\n");
}

function validMatchResults(body) {
    if (!body || (body.winningTeam !== 1 && body.winningTeam !== 2) ||
        !Array.isArray(body.players) || body.players.length < 2 ||
        body.players.length > 32) {
        return false;
    }

    const userIds = new Set();
    return body.players.every(player => {
        if (!player ||
            typeof player.userId !== "string" ||
            !/^[1-9]\d{0,18}$/.test(player.userId) ||
            (player.team !== 1 && player.team !== 2) ||
            !Number.isInteger(player.kills) ||
            player.kills < 0 ||
            player.kills > 100 ||
            userIds.has(player.userId)) {
            return false;
        }
        userIds.add(player.userId);
        return true;
    });
}

function hashWalletNonce(nonce) {
    return crypto.createHash("sha256").update(nonce).digest("hex");
}

function teamId(value) {
    return value === "blue" ? 1 : 2;
}

function sanitizePlayerName(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
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

async function getBlockchainContract() {
    if (!blockchainContractPromise) {
        blockchainContractPromise = (async () => {
            const required = [
                "BLOCKCHAIN_RPC_URL",
                "BLOCKCHAIN_CHAIN_ID",
                "TANK_COIN_CONTRACT_ADDRESS",
                "TANK_GAME_CONTRACT_ADDRESS",
                "GAME_SERVER_PRIVATE_KEY"
            ];
            const missing = required.filter(name => !process.env[name]);
            if (missing.length > 0) {
                const error = new Error(
                    `Blockchain rewards are not configured: ${missing.join(", ")}.`
                );
                error.status = 503;
                throw error;
            }

            const chainIdText = process.env.BLOCKCHAIN_CHAIN_ID;
            if (!/^[1-9]\d*$/.test(chainIdText) ||
                !Number.isSafeInteger(Number(chainIdText))) {
                const error = new Error(
                    "BLOCKCHAIN_CHAIN_ID must be a positive safe integer."
                );
                error.status = 503;
                throw error;
            }
            if (!isAddress(process.env.TANK_COIN_CONTRACT_ADDRESS) ||
                !isAddress(process.env.TANK_GAME_CONTRACT_ADDRESS)) {
                const error = new Error(
                    "TANK_COIN_CONTRACT_ADDRESS and TANK_GAME_CONTRACT_ADDRESS must be valid addresses."
                );
                error.status = 503;
                throw error;
            }

            const provider = new JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
            const network = await provider.getNetwork();
            if (network.chainId !== BigInt(chainIdText)) {
                const error = new Error(
                    "Blockchain RPC returned an unexpected chain ID."
                );
                error.status = 503;
                throw error;
            }

            const coinAddress = getAddress(
                process.env.TANK_COIN_CONTRACT_ADDRESS
            );
            const gameAddress = getAddress(
                process.env.TANK_GAME_CONTRACT_ADDRESS
            );
            const coinCode = await provider.getCode(coinAddress);
            const gameCode = await provider.getCode(gameAddress);
            if (coinCode === "0x" || gameCode === "0x") {
                const missingContracts = [
                    coinCode === "0x" ? "TankCoin" : "",
                    gameCode === "0x" ? "TankGame" : ""
                ].filter(Boolean);
                const error = new Error(
                    `${missingContracts.join(" and ")} contract address(es) have no bytecode on the configured chain.`
                );
                error.status = 503;
                throw error;
            }

            const gameReader = new Contract(
                gameAddress,
                ["function coin() view returns (address)"],
                provider
            );
            const linkedCoinAddress = getAddress(await gameReader.coin());
            if (linkedCoinAddress !== coinAddress) {
                const error = new Error(
                    "TankGame is configured to use a different TankCoin address."
                );
                error.status = 503;
                throw error;
            }

            const signer = new Wallet(process.env.GAME_SERVER_PRIVATE_KEY, provider);
            return new Contract(
                gameAddress,
                TANK_GAME_ABI,
                signer
            );
        })().catch(error => {
            blockchainContractPromise = undefined;
            throw error;
        });
    }
    return blockchainContractPromise;
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

async function route(request, response) {
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

    if (method === "POST" && path === "/api/auth/register") {
        if (!allowAuthRequest(request, response)) {
            return;
        }
        const body = await readJson(request);
        const username = typeof body.username === "string"
            ? body.username.trim().toLowerCase()
            : "";
        if (!validUsername(username) || !validPassword(body.password)) {
            respond(response, 400, {
                error: "Username must be 3-24 letters, numbers, or underscores. Password must be 10-128 characters and include a letter and a number."
            });
            return;
        }
        const computedHash = await hashPassword(body.password);
        let result;
        try {
            result = await pool.query(
                "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, wallet_address",
                [username, computedHash]
            );
        } catch (error) {
            if (error.code === "23505") {
                respond(response, 409, { error: "That username is already registered." });
                return;
            }
            throw error;
        }
        const user = result.rows[0];
        respond(response, 201, {
            token: accessToken(user),
            user: {
                id: String(user.id),
                username: user.username,
                walletAddress: user.wallet_address || ""
            }
        });
        return;
    }

    if (method === "POST" && path === "/api/auth/login") {
        if (!allowAuthRequest(request, response)) {
            return;
        }
        const body = await readJson(request);
        if (typeof body.username !== "string" ||
            typeof body.password !== "string") {
            respond(response, 400, { error: "Username and password are required." });
            return;
        }
        const result = await pool.query(
            "SELECT id, username, password_hash, wallet_address FROM users WHERE username = $1",
            [body.username.trim().toLowerCase()]
        );
        const user = result.rows[0];
        const valid = user &&
            await verifyPassword(body.password, user.password_hash);
        if (!valid) {
            respond(response, 401, { error: "Invalid username or password." });
            return;
        }
        respond(response, 200, {
            token: accessToken(user),
            user: {
                id: String(user.id),
                username: user.username,
                walletAddress: user.wallet_address || ""
            }
        });
        return;
    }

    if (path.startsWith("/api/wallet/")) {
        const user = authenticatedUser(request);
        if (!user) {
            respond(response, 401, { error: "Sign in to link a wallet." });
            return;
        }

        if (method === "POST" && path === "/api/wallet/challenge") {
            const body = await readJson(request);
            if (!validPlayerAddress(body.address)) {
                respond(response, 400, { error: "A valid wallet address is required." });
                return;
            }

            const walletAddress = getAddress(body.address);
            const userResult = await pool.query(
                "SELECT wallet_address FROM users WHERE id = $1",
                [user.sub]
            );
            const linkedAddress = userResult.rows[0]?.wallet_address;
            if (linkedAddress && linkedAddress !== walletAddress) {
                respond(response, 409, {
                    error: "This account already has a different wallet linked."
                });
                return;
            }

            const nonce = crypto.randomBytes(32).toString("hex");
            const message = walletChallengeMessage(
                user.sub,
                walletAddress,
                nonce
            );
            await withTransaction(async client => {
                await client.query(
                    "DELETE FROM wallet_challenges WHERE user_id = $1 AND consumed_at IS NULL",
                    [user.sub]
                );
                await client.query(
                    `INSERT INTO wallet_challenges
                        (nonce_hash, user_id, wallet_address, expires_at)
                     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
                    [hashWalletNonce(nonce), user.sub, walletAddress]
                );
            });
            respond(response, 200, { nonce, message });
            return;
        }

        if (method === "POST" && path === "/api/wallet/verify") {
            const body = await readJson(request);
            if (!validPlayerAddress(body.address) ||
                typeof body.nonce !== "string" ||
                !/^[0-9a-f]{64}$/.test(body.nonce) ||
                typeof body.signature !== "string" ||
                !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
                respond(response, 400, {
                    error: "A valid wallet address, challenge nonce, and 65-byte signature are required."
                });
                return;
            }

            const walletAddress = getAddress(body.address);
            let result;
            try {
                result = await withTransaction(async client => {
                    const challengeResult = await client.query(
                        `SELECT wc.wallet_address, u.wallet_address AS linked_address
                         FROM wallet_challenges wc
                         JOIN users u ON u.id = wc.user_id
                         WHERE wc.nonce_hash = $1 AND wc.user_id = $2
                           AND wc.expires_at > NOW() AND wc.consumed_at IS NULL
                         FOR UPDATE OF wc, u`,
                        [hashWalletNonce(body.nonce), user.sub]
                    );
                    const challenge = challengeResult.rows[0];
                    if (!challenge ||
                        challenge.wallet_address !== walletAddress) {
                        return { error: "Wallet challenge is invalid or expired." };
                    }

                    await client.query(
                        "UPDATE wallet_challenges SET consumed_at = NOW() WHERE nonce_hash = $1",
                        [hashWalletNonce(body.nonce)]
                    );

                    let recoveredAddress;
                    try {
                        recoveredAddress = getAddress(verifyMessage(
                            walletChallengeMessage(
                                user.sub,
                                challenge.wallet_address,
                                body.nonce
                            ),
                            body.signature
                        ));
                    } catch {
                        return { error: "Wallet signature is invalid." };
                    }
                    if (recoveredAddress !== challenge.wallet_address) {
                        return { error: "Wallet signature is invalid." };
                    }
                    if (challenge.linked_address &&
                        challenge.linked_address !== challenge.wallet_address) {
                        return {
                            error: "This account already has a different wallet linked."
                        };
                    }

                    const update = await client.query(
                        `UPDATE users SET wallet_address = $1
                         WHERE id = $2 AND (wallet_address IS NULL OR wallet_address = $1)
                         RETURNING wallet_address`,
                        [challenge.wallet_address, user.sub]
                    );
                    if (update.rowCount !== 1) {
                        return {
                            error: "This account already has a different wallet linked."
                        };
                    }
                    return { walletAddress: update.rows[0].wallet_address };
                });
            } catch (error) {
                if (error.code === "23505") {
                    respond(response, 409, {
                        error: "That wallet is already linked to another account."
                    });
                    return;
                }
                throw error;
            }

            if (result.error) {
                respond(response, 401, { error: result.error });
                return;
            }
            respond(response, 200, { walletAddress: result.walletAddress });
            return;
        }
    }

    if (method === "GET" && path === "/api/profile") {
        const user = authenticatedUser(request);
        if (!user) {
            respond(response, 401, { error: "Sign in to view your player profile." });
            return;
        }

        const result = await pool.query(
            `SELECT id::TEXT AS player_id, username, wallet_address,
                    experience::TEXT, battles_played::TEXT,
                    victories::TEXT, defeats::TEXT, tanks_destroyed::TEXT
             FROM users WHERE id = $1`,
            [user.sub]
        );
        const profile = result.rows[0];
        if (!profile) {
            respond(response, 404, { error: "Player profile was not found." });
            return;
        }
        const experience = BigInt(profile.experience);
        respond(response, 200, {
            playerId: profile.player_id,
            username: profile.username,
            walletAddress: profile.wallet_address || "",
            level: Number(experience / 1000n) + 1,
            experience: profile.experience,
            battlesPlayed: profile.battles_played,
            victories: profile.victories,
            defeats: profile.defeats,
            tanksDestroyed: profile.tanks_destroyed
        });
        return;
    }

    if (path.startsWith("/api/rooms")) {
        const user = authenticatedUser(request);
        if (!user) {
            respond(response, 401, { error: "Sign in to use online rooms." });
            return;
        }

        if (method === "GET" && path === "/api/rooms") {
            const result = await pool.query(
                `SELECT r.id::TEXT AS id, r.name, r.status,
                        r.max_players AS "maxPlayers",
                        gs.host, gs.port, gs.ws_url AS "wsUrl",
                        COUNT(rm.user_id)::INTEGER AS "playerCount"
                 FROM rooms r
                 JOIN game_servers gs ON gs.id = r.server_id
                 LEFT JOIN room_members rm ON rm.room_id = r.id
                    AND rm.joined_at > NOW() - INTERVAL '45 seconds'
                 WHERE r.status IN ('waiting', 'playing')
                   AND gs.heartbeat_at > NOW() - INTERVAL '20 seconds'
                 GROUP BY r.id, gs.host, gs.port, gs.ws_url
                 ORDER BY r.created_at DESC
                 LIMIT 100`
            );
            respond(response, 200, { rooms: result.rows });
            return;
        }

        if (method === "POST" && path === "/api/rooms") {
            const body = await readJson(request);
            const name = typeof body.name === "string"
                ? body.name.replace(/[\u0000-\u001f\u007f]/g, "")
                    .trim().slice(0, 32)
                : "";
            const playerName = sanitizePlayerName(body.playerName || user.username);
            if (!name || !playerName || !validTeam(body.team)) {
                respond(response, 400, {
                    error: "Room name, player name, and a blue or red team are required."
                });
                return;
            }
            try {
                const room = await withTransaction(async client => {
                    const serverResult = await client.query(
                        `SELECT id, host, port, max_players, ws_url
                         FROM game_servers
                         WHERE status = 'ready'
                           AND heartbeat_at > NOW() - INTERVAL '20 seconds'
                         ORDER BY heartbeat_at DESC
                         LIMIT 1
                         FOR UPDATE`
                    );
                    const server = serverResult.rows[0];
                    if (!server) {
                        const error = new Error("No dedicated game server is available.");
                        error.status = 503;
                        throw error;
                    }
                    const created = await client.query(
                        `INSERT INTO rooms (name, owner_user_id, server_id, status, max_players)
                         VALUES ($1, $2, $3, 'waiting', $4)
                         RETURNING id::TEXT AS id, name,
                                   max_players AS "maxPlayers", status`,
                        [name, user.sub, server.id, Math.min(ROOM_CAPACITY, server.max_players)]
                    );
                    const createdRoom = created.rows[0];
                    await client.query(
                        "INSERT INTO room_members (room_id, user_id, team, player_name) VALUES ($1, $2, $3, $4)",
                        [createdRoom.id, user.sub, teamId(body.team), playerName]
                    );
                    const ticket = await issueTicket(
                        client,
                        createdRoom.id,
                        user.sub,
                        teamId(body.team),
                        playerName
                    );
                    return {
                        ...createdRoom,
                        host: server.host,
                        port: server.port,
                        wsUrl: server.ws_url,
                        ticket
                    };
                });
                respond(response, 201, { room });
            } catch (error) {
                if (error.status === 503) {
                    respond(response, 503, { error: error.message });
                    return;
                }
                throw error;
            }
            return;
        }

        const joinMatch = /^\/api\/rooms\/(\d+)\/join$/.exec(path);
        if (method === "POST" && joinMatch) {
            const body = await readJson(request);
            const playerName = sanitizePlayerName(body.playerName || user.username);
            if (!validTeam(body.team) || !playerName) {
                respond(response, 400, { error: "A player name and blue or red team are required." });
                return;
            }
            try {
                const room = await withTransaction(async client => {
                    const result = await client.query(
                        `SELECT r.id::TEXT AS id, r.name, r.status,
                                r.max_players AS "maxPlayers",
                                gs.host, gs.port,
                                gs.ws_url AS "wsUrl"
                         FROM rooms r
                         JOIN game_servers gs ON gs.id = r.server_id
                         WHERE r.id = $1
                           AND r.status IN ('waiting', 'playing')
                           AND gs.heartbeat_at > NOW() - INTERVAL '20 seconds'
                         FOR UPDATE OF r`,
                        [joinMatch[1]]
                    );
                    const current = result.rows[0];
                    if (!current) {
                        const error = new Error("That room is no longer available.");
                        error.status = 404;
                        throw error;
                    }
                    const members = await client.query(
                        `SELECT COUNT(*)::INTEGER AS count FROM room_members
                         WHERE room_id = $1
                           AND joined_at > NOW() - INTERVAL '45 seconds'`,
                        [current.id]
                    );
                    const existing = await client.query(
                        `SELECT 1
                         FROM room_members WHERE room_id = $1 AND user_id = $2`,
                        [current.id, user.sub]
                    );
                    if (existing.rowCount === 0 &&
                        members.rows[0].count >= current.max_players) {
                        const error = new Error("That room is full.");
                        error.status = 409;
                        throw error;
                    }
                    await client.query(
                        `INSERT INTO room_members (room_id, user_id, team, player_name)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (room_id, user_id)
                         DO UPDATE SET team = EXCLUDED.team, player_name = EXCLUDED.player_name`,
                        [current.id, user.sub, teamId(body.team), playerName]
                    );
                    const ticket = await issueTicket(
                        client,
                        current.id,
                        user.sub,
                        teamId(body.team),
                        playerName
                    );
                    return { ...current, ticket };
                });
                respond(response, 200, { room });
            } catch (error) {
                if (error.status) {
                    respond(response, error.status, { error: error.message });
                    return;
                }
                throw error;
            }
            return;
        }
    }

    if (path.startsWith("/api/server/")) {
        if (!requireServer(request, response)) {
            return;
        }
        const body = method === "POST" ? await readJson(request) : {};
        if (method === "POST" && path === "/api/server/register") {
            const { id, host, port, maxPlayers } = body;
            const wsUrl = body.wsUrl;
            if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
                typeof host !== "string" || host.length > 255 ||
                !Number.isInteger(port) || port < 1 || port > 65535 ||
                !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > ROOM_CAPACITY ||
                typeof wsUrl !== "string" || wsUrl.length > 512) {
                respond(response, 400, { error: "Invalid dedicated server configuration." });
                return;
            }
            let parsedWsUrl;
            try {
                parsedWsUrl = new URL(wsUrl);
            } catch {
                respond(response, 400, { error: "Invalid dedicated server WebSocket URL." });
                return;
            }
            if (!["ws:", "wss:"].includes(parsedWsUrl.protocol) ||
                !parsedWsUrl.pathname.endsWith("/game") ||
                parsedWsUrl.search || parsedWsUrl.hash ||
                (process.env.NODE_ENV === "production" &&
                    parsedWsUrl.protocol !== "wss:")) {
                respond(response, 400, { error: "Dedicated servers must advertise a valid WebSocket game endpoint." });
                return;
            }
            await withTransaction(async client => {
                await client.query(
                    `DELETE FROM room_members rm USING rooms r
                     WHERE rm.room_id = r.id AND r.server_id = $1
                       AND r.status IN ('waiting', 'playing')`,
                    [id]
                );
                await client.query(
                    "UPDATE rooms SET status = 'complete' WHERE server_id = $1 AND status IN ('waiting', 'playing')",
                    [id]
                );
                await client.query(
                    `INSERT INTO game_servers
                        (id, host, port, max_players, ws_url, status, current_room_id)
                     VALUES ($1, $2, $3, $4, $5, 'ready', NULL)
                     ON CONFLICT (id) DO UPDATE SET host = EXCLUDED.host,
                        port = EXCLUDED.port,
                        max_players = EXCLUDED.max_players,
                        ws_url = EXCLUDED.ws_url, status = 'ready',
                        current_room_id = NULL, heartbeat_at = NOW()`,
                    [id, host, port, maxPlayers, parsedWsUrl.toString()]
                );
            });
            respond(response, 200, { status: "ready" });
            return;
        }
        if (method === "POST" && path === "/api/server/rewards") {
            const { playerAddress, amountWei, reason, battleId } = body;
            const cleanReason = typeof reason === "string" ? reason.trim() : "";
            if (!validPlayerAddress(playerAddress) ||
                !validRewardAmount(amountWei) ||
                !validBattleId(battleId) ||
                !cleanReason ||
                Buffer.byteLength(cleanReason, "utf8") > 128) {
                respond(response, 400, {
                    error: "A valid player address, positive amountWei, reason (1-128 UTF-8 bytes), and nonzero bytes32 battleId are required."
                });
                return;
            }

            const contract = await getBlockchainContract();
            const signerAddress = await contract.runner.getAddress();
            if (!await contract.hasRole(GAME_SERVER_ROLE, signerAddress)) {
                const error = new Error(
                    "The configured blockchain signer lacks GAME_SERVER_ROLE."
                );
                error.status = 503;
                throw error;
            }

            if (await contract.processedBattleIds(battleId)) {
                respond(response, 200, {
                    status: "already_rewarded",
                    battleId
                });
                return;
            }

            let transaction;
            try {
                transaction = await contract.rewardDestroyEnemy(
                    getAddress(playerAddress),
                    BigInt(amountWei),
                    cleanReason,
                    battleId
                );
                const receipt = await transaction.wait();
                if (!receipt || receipt.status !== 1) {
                    throw new Error("Battle reward transaction was not confirmed.");
                }
                respond(response, 200, {
                    status: "rewarded",
                    battleId,
                    transactionHash: transaction.hash,
                    blockNumber: receipt.blockNumber
                });
            } catch (error) {
                if (await contract.processedBattleIds(battleId)) {
                    respond(response, 200, {
                        status: "already_rewarded",
                        battleId,
                        transactionHash: transaction?.hash || null
                    });
                    return;
                }
                throw error;
            }
            return;
        }
        const matchResultsMatch =
            /^\/api\/server\/rooms\/(\d+)\/results$/.exec(path);
        if (method === "POST" && matchResultsMatch) {
            if (typeof body.serverId !== "string" ||
                !validMatchResults(body)) {
                respond(response, 400, {
                    error: "A server id, winning team, and 2-32 unique valid player results are required."
                });
                return;
            }

            const roomId = matchResultsMatch[1];
            const outcome = await withTransaction(async client => {
                const roomResult = await client.query(
                    `SELECT id::TEXT AS id, status
                     FROM rooms
                     WHERE id = $1 AND server_id = $2
                     FOR UPDATE`,
                    [roomId, body.serverId]
                );
                const room = roomResult.rows[0];
                if (!room || !["waiting", "playing", "complete"].includes(room.status)) {
                    const error = new Error(
                        "This server does not own an active room with that id."
                    );
                    error.status = 404;
                    throw error;
                }

                const previous = await client.query(
                    "SELECT 1 FROM match_results WHERE room_id = $1",
                    [roomId]
                );
                if (previous.rowCount > 0) {
                    return { status: "already_recorded" };
                }

                const memberResult = await client.query(
                    `SELECT DISTINCT user_id::TEXT AS user_id
                     FROM join_tickets WHERE room_id = $1`,
                    [roomId]
                );
                const roomUserIds = new Set(
                    memberResult.rows.map(member => member.user_id)
                );
                if (body.players.some(player => !roomUserIds.has(player.userId))) {
                    const error = new Error(
                        "Match results include a player who did not join this room."
                    );
                    error.status = 400;
                    throw error;
                }

                await client.query(
                    `INSERT INTO match_results (room_id, server_id, winning_team)
                     VALUES ($1, $2, $3)`,
                    [roomId, body.serverId, body.winningTeam]
                );
                for (const player of body.players) {
                    const victory = player.team === body.winningTeam;
                    const experienceGained = 100 + player.kills * 25;
                    await client.query(
                        `INSERT INTO player_match_results
                            (room_id, user_id, team, kills, victory)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [roomId, player.userId, player.team, player.kills, victory]
                    );
                    await client.query(
                        `UPDATE users
                         SET experience = experience + $1,
                             battles_played = battles_played + 1,
                             victories = victories + $2,
                             defeats = defeats + $3,
                             tanks_destroyed = tanks_destroyed + $4
                         WHERE id = $5`,
                        [
                            experienceGained,
                            victory ? 1 : 0,
                            victory ? 0 : 1,
                            player.kills,
                            player.userId
                        ]
                    );
                }
                return { status: "recorded" };
            });
            respond(response, 200, outcome);
            return;
        }
        if (method === "POST" && path === "/api/server/heartbeat") {
            if (typeof body.id !== "string") {
                respond(response, 400, { error: "Server id is required." });
                return;
            }
            await pool.query(
                "UPDATE game_servers SET heartbeat_at = NOW() WHERE id = $1",
                [body.id]
            );
            respond(response, 200, { status: "ok" });
            return;
        }
        if (method === "GET" && path === "/api/server/assignment") {
            const id = url.searchParams.get("id");
            if (!id) {
                respond(response, 400, { error: "Server id is required." });
                return;
            }
            const result = await pool.query(
                `SELECT r.id::TEXT AS id, r.name, r.status, r.max_players
                 FROM rooms r JOIN game_servers gs ON gs.id = r.server_id
                 WHERE gs.id = $1
                   AND r.status IN ('waiting', 'playing')
                 ORDER BY r.created_at ASC`,
                [id]
            );
            respond(response, 200, {
                rooms: result.rows,
                room: result.rows[0] || null
            });
            return;
        }
        if (method === "POST" && path === "/api/server/tickets/validate") {
            if (typeof body.ticket !== "string" || body.ticket.length < 32 ||
                typeof body.serverId !== "string") {
                respond(response, 400, { error: "Invalid ticket." });
                return;
            }
            const ticket = await withTransaction(async client => {
                const result = await client.query(
                    `UPDATE join_tickets jt SET consumed_at = NOW()
                     FROM rooms r, room_members rm, users u
                     WHERE jt.ticket_hash = $1
                       AND jt.room_id = r.id AND jt.user_id = rm.user_id
                       AND jt.room_id = rm.room_id
                       AND u.id = jt.user_id
                       AND jt.expires_at > NOW() AND jt.consumed_at IS NULL
                       AND r.status IN ('waiting', 'playing')
                       AND r.server_id = $2
                     RETURNING jt.room_id, jt.user_id, jt.team, jt.player_name,
                               u.wallet_address AS player_address`,
                    [hashTicket(body.ticket), body.serverId]
                );
                const validated = result.rows[0];
                if (!validated) {
                    return null;
                }
                await client.query(
                    "UPDATE room_members SET joined_at = NOW() WHERE room_id = $1 AND user_id = $2",
                    [validated.room_id, validated.user_id]
                );
                return validated;
            });
            if (!ticket) {
                respond(response, 401, { error: "Ticket is invalid, expired, or already used." });
                return;
            }
            respond(response, 200, {
                roomId: String(ticket.room_id),
                userId: String(ticket.user_id),
                team: ticket.team,
                playerName: ticket.player_name,
                playerAddress: ticket.player_address || ""
            });
            return;
        }
        const roomStateMatch =
            /^\/api\/server\/rooms\/(\d+)\/(start|end|complete)$/.exec(path);
        if (method === "POST" && roomStateMatch) {
            const roomId = roomStateMatch[1];
            const action = roomStateMatch[2];
            await withTransaction(async client => {
                if (action === "start") {
                    await client.query(
                        `UPDATE rooms SET status = 'playing'
                         WHERE id = $1 AND server_id = $2 AND status = 'waiting'`,
                        [roomId, body.serverId]
                    );
                } else {
                    await client.query(
                        `UPDATE rooms SET status = 'complete'
                         WHERE id = $1 AND server_id = $2
                           AND status IN ('waiting', 'playing')`,
                        [roomId, body.serverId]
                    );
                    await client.query(
                        "DELETE FROM room_members WHERE room_id = $1",
                        [roomId]
                    );
                }
            });
            respond(response, 200, {
                status: action === "start" ? "playing"
                    : action === "end" ? "complete" : "ready"
            });
            return;
        }
        const leaveMatch = /^\/api\/server\/rooms\/(\d+)\/leave$/.exec(path);
        const memberHeartbeatMatch =
            /^\/api\/server\/rooms\/(\d+)\/members\/heartbeat$/.exec(path);
        if (method === "POST" && memberHeartbeatMatch) {
            if (typeof body.serverId !== "string" ||
                !Array.isArray(body.userIds) || body.userIds.length > 32 ||
                body.userIds.some(id => typeof id !== "string" || !/^\d+$/.test(id))) {
                respond(response, 400, { error: "Invalid online room member heartbeat." });
                return;
            }
            await pool.query(
                `UPDATE room_members rm SET joined_at = NOW()
                 FROM rooms r
                 WHERE rm.room_id = r.id AND r.id = $1
                   AND r.server_id = $2 AND rm.user_id = ANY($3::BIGINT[])`,
                [memberHeartbeatMatch[1], body.serverId, body.userIds]
            );
            respond(response, 200, { status: "ok" });
            return;
        }
        if (method === "POST" && leaveMatch) {
            if (typeof body.serverId !== "string" ||
                typeof body.userId !== "string") {
                respond(response, 400, { error: "Server and user ids are required." });
                return;
            }
            await pool.query(
                `DELETE FROM room_members rm USING rooms r
                 WHERE rm.room_id = r.id AND rm.room_id = $1
                   AND rm.user_id = $2 AND r.server_id = $3
                   AND r.status IN ('waiting', 'playing')`,
                [leaveMatch[1], body.userId, body.serverId]
            );
            respond(response, 200, { status: "left" });
            return;
        }
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
    const server = http.createServer((request, response) => {
        route(request, response).catch(error => {
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

module.exports = {
    validBattleId,
    validPlayerAddress,
    validMatchResults,
    walletChallengeMessage,
    sanitizePlayerName,
    validPassword,
    validRewardAmount,
    validTeam,
    validUsername,
    isAllowedOrigin
};
