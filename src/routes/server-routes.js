"use strict";

const { getAddress } = require("ethers");
const { getBlockchainContract } = require("../blockchain-rewards");
const { hashTicket } = require("../security");
const {
    validBattleId,
    validMatchResults,
    validPlayerAddress,
    validRewardAmount
} = require("../validation");

const ROOM_CAPACITY = 32;

function createServerRoutes({
    pool,
    respond,
    readJson,
    requireServer,
    withTransaction
}) {
    return async function handleServerRoute(request, response, path, method, url) {
        if (!path.startsWith("/api/server/")) {
            return false;
        }
        if (!requireServer(request, response)) {
            return true;
        }

        const body = method === "POST" ? await readJson(request) : {};
        if (method === "POST" && path === "/api/server/register") {
            const { id, host, port, maxPlayers, wsUrl } = body;
            if (typeof id !== "string" ||
                !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
                typeof host !== "string" || host.length > 255 ||
                !Number.isInteger(port) || port < 1 || port > 65535 ||
                !Number.isInteger(maxPlayers) || maxPlayers < 2 ||
                maxPlayers > ROOM_CAPACITY ||
                typeof wsUrl !== "string" || wsUrl.length > 512) {
                respond(response, 400, {
                    error: "Invalid dedicated server configuration."
                });
                return true;
            }

            let parsedWsUrl;
            try {
                parsedWsUrl = new URL(wsUrl);
            } catch {
                respond(response, 400, {
                    error: "Invalid dedicated server WebSocket URL."
                });
                return true;
            }
            if (!["ws:", "wss:"].includes(parsedWsUrl.protocol) ||
                !parsedWsUrl.pathname.endsWith("/game") ||
                parsedWsUrl.search || parsedWsUrl.hash ||
                (process.env.NODE_ENV === "production" &&
                    parsedWsUrl.protocol !== "wss:")) {
                respond(response, 400, {
                    error: "Dedicated servers must advertise a valid WebSocket game endpoint."
                });
                return true;
            }

            await withTransaction(async client => {
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
            return true;
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
                return true;
            }

            const contract = await getBlockchainContract();
            if (await contract.processedBattleIds(battleId)) {
                respond(response, 200, {
                    status: "already_rewarded",
                    battleId
                });
                return true;
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
                    throw new Error(
                        "Battle reward transaction was not confirmed."
                    );
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
                    return true;
                }
                throw error;
            }
            return true;
        }

        const matchResultsMatch =
            /^\/api\/server\/rooms\/(\d+)\/results$/.exec(path);
        if (method === "POST" && matchResultsMatch) {
            if (typeof body.serverId !== "string" ||
                !validMatchResults(body)) {
                respond(response, 400, {
                    error: "A server id, winning team, and 2-32 unique valid player results are required."
                });
                return true;
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
                if (!room ||
                    !["waiting", "playing", "complete"].includes(room.status)) {
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
                if (body.players.some(player =>
                    !roomUserIds.has(player.userId))) {
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
            return true;
        }

        if (method === "POST" && path === "/api/server/heartbeat") {
            if (typeof body.id !== "string") {
                respond(response, 400, { error: "Server id is required." });
                return true;
            }
            await pool.query(
                "UPDATE game_servers SET heartbeat_at = NOW() WHERE id = $1",
                [body.id]
            );
            respond(response, 200, { status: "ok" });
            return true;
        }

        if (method === "GET" && path === "/api/server/assignment") {
            const id = url.searchParams.get("id");
            if (!id) {
                respond(response, 400, { error: "Server id is required." });
                return true;
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
            return true;
        }

        if (method === "POST" && path === "/api/server/tickets/validate") {
            if (typeof body.ticket !== "string" || body.ticket.length < 32 ||
                typeof body.serverId !== "string") {
                respond(response, 400, { error: "Invalid ticket." });
                return true;
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
                    `UPDATE room_members
                     SET joined_at = NOW(), connected = TRUE
                     WHERE room_id = $1 AND user_id = $2`,
                    [validated.room_id, validated.user_id]
                );
                return validated;
            });
            if (!ticket) {
                respond(response, 401, {
                    error: "Ticket is invalid, expired, or already used."
                });
                return true;
            }
            respond(response, 200, {
                roomId: String(ticket.room_id),
                userId: String(ticket.user_id),
                team: ticket.team,
                playerName: ticket.player_name,
                playerAddress: ticket.player_address || ""
            });
            return true;
        }

        const roomStateMatch =
            /^\/api\/server\/rooms\/(\d+)\/(start|end|complete)$/.exec(path);
        if (method === "POST" && roomStateMatch) {
            const roomId = roomStateMatch[1];
            const action = roomStateMatch[2];
            const reason = body.reason;
            if (action !== "start" &&
                (typeof reason !== "string" ||
                    !/^[a-z0-9_:-]{1,64}$/.test(reason))) {
                respond(response, 400, {
                    error: "A valid room shutdown reason is required."
                });
                return true;
            }
            await withTransaction(async client => {
                if (action === "start") {
                    await client.query(
                        `UPDATE rooms SET status = 'playing'
                         WHERE id = $1 AND server_id = $2 AND status = 'waiting'`,
                        [roomId, body.serverId]
                    );
                } else {
                    await client.query(
                        `UPDATE rooms SET status = 'complete',
                                          closed_reason = $3
                         WHERE id = $1 AND server_id = $2
                           AND status IN ('waiting', 'playing')`,
                        [roomId, body.serverId, reason]
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
            return true;
        }

        const leaveMatch = /^\/api\/server\/rooms\/(\d+)\/leave$/.exec(path);
        const memberHeartbeatMatch =
            /^\/api\/server\/rooms\/(\d+)\/members\/heartbeat$/.exec(path);
        if (method === "POST" && memberHeartbeatMatch) {
            if (typeof body.serverId !== "string" ||
                !Array.isArray(body.userIds) || body.userIds.length > 32 ||
                body.userIds.some(id =>
                    typeof id !== "string" || !/^\d+$/.test(id))) {
                respond(response, 400, {
                    error: "Invalid online room member heartbeat."
                });
                return true;
            }
            await pool.query(
                `UPDATE room_members rm
                 SET connected = rm.user_id = ANY($3::BIGINT[]),
                     joined_at = CASE
                         WHEN rm.user_id = ANY($3::BIGINT[]) THEN NOW()
                         ELSE rm.joined_at
                     END
                 FROM rooms r
                 WHERE rm.room_id = r.id AND r.id = $1
                   AND r.server_id = $2`,
                [memberHeartbeatMatch[1], body.serverId, body.userIds]
            );
            respond(response, 200, { status: "ok" });
            return true;
        }

        const memberDisconnectMatch =
            /^\/api\/server\/rooms\/(\d+)\/members\/disconnect$/.exec(path);
        if (method === "POST" && memberDisconnectMatch) {
            if (typeof body.serverId !== "string" ||
                typeof body.userId !== "string" ||
                !/^\d+$/.test(body.userId)) {
                respond(response, 400, {
                    error: "Invalid room member disconnect."
                });
                return true;
            }
            await pool.query(
                `UPDATE room_members rm SET connected = FALSE
                 FROM rooms r
                 WHERE rm.room_id = r.id AND r.id = $1
                   AND r.server_id = $2 AND rm.user_id = $3`,
                [memberDisconnectMatch[1], body.serverId, body.userId]
            );
            respond(response, 200, { status: "disconnected" });
            return true;
        }

        if (method === "POST" && leaveMatch) {
            if (typeof body.serverId !== "string" ||
                typeof body.userId !== "string") {
                respond(response, 400, {
                    error: "Server and user ids are required."
                });
                return true;
            }
            await pool.query(
                `DELETE FROM room_members rm USING rooms r
                 WHERE rm.room_id = r.id AND rm.room_id = $1
                   AND rm.user_id = $2 AND r.server_id = $3
                   AND r.status IN ('waiting', 'playing')`,
                [leaveMatch[1], body.userId, body.serverId]
            );
            respond(response, 200, { status: "left" });
            return true;
        }

        return false;
    };
}

module.exports = { createServerRoutes };
