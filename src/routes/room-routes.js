"use strict";

const {
    sanitizePlayerName,
    teamId,
    validTeam
} = require("../validation");

const ROOM_CAPACITY = 32;

function createRoomRoutes({
    pool,
    respond,
    readJson,
    authenticatedUser,
    withTransaction,
    issueTicket
}) {
    return async function handleRoomRoute(request, response, path, method) {
        if (!path.startsWith("/api/rooms")) {
            return false;
        }

        const user = authenticatedUser(request);
        if (!user) {
            respond(response, 401, {
                error: "Sign in to use online rooms."
            });
            return true;
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
                    AND rm.connected = TRUE
                    AND rm.joined_at > NOW() - INTERVAL '45 seconds'
                 WHERE r.status IN ('waiting', 'playing')
                   AND gs.heartbeat_at > NOW() - INTERVAL '20 seconds'
                 GROUP BY r.id, gs.host, gs.port, gs.ws_url
                 ORDER BY r.created_at DESC
                 LIMIT 100`
            );
            respond(response, 200, { rooms: result.rows });
            return true;
        }

        if (method === "POST" && path === "/api/rooms") {
            const body = await readJson(request);
            const name = typeof body.name === "string"
                ? body.name.replace(/[\u0000-\u001f\u007f]/g, "")
                    .trim().slice(0, 32)
                : "";
            const playerName = sanitizePlayerName(
                body.playerName || user.username
            );
            if (!name || !playerName || !validTeam(body.team)) {
                respond(response, 400, {
                    error: "Room name, player name, and a blue or red team are required."
                });
                return true;
            }
            try {
                const room = await withTransaction(async client => {
                    const serverResult = await client.query(
                        `SELECT id, host, port, max_players, ws_url
                         FROM game_servers
                         WHERE status IN ('ready', 'busy')
                           AND heartbeat_at > NOW() - INTERVAL '20 seconds'
                         ORDER BY CASE WHEN status = 'ready' THEN 0 ELSE 1 END,
                                  heartbeat_at DESC
                         LIMIT 1
                         FOR UPDATE`
                    );
                    const server = serverResult.rows[0];
                    if (!server) {
                        const error = new Error(
                            "No dedicated game server is available."
                        );
                        error.status = 503;
                        throw error;
                    }
                    const created = await client.query(
                        `INSERT INTO rooms (name, owner_user_id, server_id, status, max_players)
                         VALUES ($1, $2, $3, 'waiting', $4)
                         RETURNING id::TEXT AS id, name,
                                   max_players AS "maxPlayers", status`,
                        [
                            name,
                            user.sub,
                            server.id,
                            Math.min(ROOM_CAPACITY, server.max_players)
                        ]
                    );
                    const createdRoom = created.rows[0];
                    await client.query(
                        `INSERT INTO room_members
                            (room_id, user_id, team, player_name)
                         VALUES ($1, $2, $3, $4)`,
                        [
                            createdRoom.id,
                            user.sub,
                            teamId(body.team),
                            playerName
                        ]
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
                    return true;
                }
                throw error;
            }
            return true;
        }

        const joinMatch = /^\/api\/rooms\/(\d+)\/join$/.exec(path);
        if (method === "POST" && joinMatch) {
            const body = await readJson(request);
            const playerName = sanitizePlayerName(
                body.playerName || user.username
            );
            if (!validTeam(body.team) || !playerName) {
                respond(response, 400, {
                    error: "A player name and blue or red team are required."
                });
                return true;
            }
            try {
                const room = await withTransaction(async client => {
                    const result = await client.query(
                        `SELECT r.id::TEXT AS id, r.name, r.status,
                                r.max_players AS "maxPlayers",
                                gs.host, gs.port, gs.ws_url AS "wsUrl"
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
                        const error = new Error(
                            "That room is no longer available."
                        );
                        error.status = 404;
                        throw error;
                    }
                    const members = await client.query(
                        `SELECT COUNT(*)::INTEGER AS count FROM room_members
                         WHERE room_id = $1
                           AND connected = TRUE
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
                        `INSERT INTO room_members
                            (room_id, user_id, team, player_name)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (room_id, user_id)
                         DO UPDATE SET team = EXCLUDED.team,
                                       player_name = EXCLUDED.player_name`,
                        [
                            current.id,
                            user.sub,
                            teamId(body.team),
                            playerName
                        ]
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
                    return true;
                }
                throw error;
            }
            return true;
        }

        return false;
    };
}

module.exports = { createRoomRoutes };
