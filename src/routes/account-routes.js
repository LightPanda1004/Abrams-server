"use strict";

const crypto = require("node:crypto");
const { getAddress, verifyMessage } = require("ethers");
const { hashPassword, verifyPassword } = require("../security");
const {
    validPassword,
    validPlayerAddress,
    validUsername,
    walletChallengeMessage
} = require("../validation");

function createAccountRoutes({
    pool,
    respond,
    readJson,
    authenticatedUser,
    allowAuthRequest,
    withTransaction,
    accessToken,
    hashWalletNonce
}) {
    return async function handleAccountRoute(request, response, path, method) {
        if (method === "POST" && path === "/api/auth/register") {
            if (!allowAuthRequest(request, response)) {
                return true;
            }
            const body = await readJson(request);
            const username = typeof body.username === "string"
                ? body.username.trim().toLowerCase()
                : "";
            if (!validUsername(username) || !validPassword(body.password)) {
                respond(response, 400, {
                    error: "Username must be 3-24 letters, numbers, or underscores. Password must be 10-128 characters and include a letter and a number."
                });
                return true;
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
                    respond(response, 409, {
                        error: "That username is already registered."
                    });
                    return true;
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
            return true;
        }

        if (method === "POST" && path === "/api/auth/login") {
            if (!allowAuthRequest(request, response)) {
                return true;
            }
            const body = await readJson(request);
            if (typeof body.username !== "string" ||
                typeof body.password !== "string") {
                respond(response, 400, {
                    error: "Username and password are required."
                });
                return true;
            }
            const result = await pool.query(
                "SELECT id, username, password_hash, wallet_address FROM users WHERE username = $1",
                [body.username.trim().toLowerCase()]
            );
            const user = result.rows[0];
            const valid = user &&
                await verifyPassword(body.password, user.password_hash);
            if (!valid) {
                respond(response, 401, {
                    error: "Invalid username or password."
                });
                return true;
            }
            respond(response, 200, {
                token: accessToken(user),
                user: {
                    id: String(user.id),
                    username: user.username,
                    walletAddress: user.wallet_address || ""
                }
            });
            return true;
        }

        if (path.startsWith("/api/wallet/")) {
            const user = authenticatedUser(request);
            if (!user) {
                respond(response, 401, {
                    error: "Sign in to link a wallet."
                });
                return true;
            }

            if (method === "POST" && path === "/api/wallet/challenge") {
                const body = await readJson(request);
                if (!validPlayerAddress(body.address)) {
                    respond(response, 400, {
                        error: "A valid wallet address is required."
                    });
                    return true;
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
                    return true;
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
                return true;
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
                    return true;
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
                            return {
                                error: "Wallet challenge is invalid or expired."
                            };
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
                            challenge.linked_address !==
                                challenge.wallet_address) {
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
                        return {
                            walletAddress: update.rows[0].wallet_address
                        };
                    });
                } catch (error) {
                    if (error.code === "23505") {
                        respond(response, 409, {
                            error: "That wallet is already linked to another account."
                        });
                        return true;
                    }
                    throw error;
                }

                if (result.error) {
                    respond(response, 401, { error: result.error });
                    return true;
                }
                respond(response, 200, {
                    walletAddress: result.walletAddress
                });
                return true;
            }
            return false;
        }

        if (method === "GET" && path === "/api/profile") {
            const user = authenticatedUser(request);
            if (!user) {
                respond(response, 401, {
                    error: "Sign in to view your player profile."
                });
                return true;
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
                respond(response, 404, {
                    error: "Player profile was not found."
                });
                return true;
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
            return true;
        }

        return false;
    };
}

module.exports = { createAccountRoutes };
