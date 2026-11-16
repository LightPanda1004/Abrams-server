"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountRoutes } = require("./account-routes");

function createHarness(overrides = {}) {
    const responses = [];
    const queries = [];
    const dependencies = {
        pool: {
            async query(sql, values) {
                queries.push({ sql, values });
                if (sql.includes("FROM users WHERE id")) {
                    return {
                        rows: [{
                            player_id: "7",
                            username: "tank",
                            wallet_address: null,
                            experience: "2500",
                            battles_played: "3",
                            victories: "2",
                            defeats: "1",
                            tanks_destroyed: "4"
                        }]
                    };
                }
                return {
                    rows: [{
                        id: "7",
                        username: "tank",
                        wallet_address: null
                    }]
                };
            }
        },
        respond(_response, status, body) {
            responses.push({ status, body });
        },
        async readJson() {
            return {};
        },
        authenticatedUser() {
            return null;
        },
        allowAuthRequest() {
            return true;
        },
        async withTransaction(action) {
            return action({ query: async () => ({ rows: [] }) });
        },
        accessToken() {
            return "access-token";
        },
        hashWalletNonce() {
            return "hashed-nonce";
        },
        async hashPassword() {
            return "password-hash";
        },
        async verifyPassword() {
            return true;
        },
        ...overrides
    };

    return {
        handle: createAccountRoutes(dependencies),
        responses,
        queries
    };
}

test("account routes leave unrelated requests to the next router", async () => {
    const { handle } = createHarness();
    assert.equal(
        await handle({}, {}, "/api/rooms", "GET"),
        false
    );
});

test("wallet routes require an authenticated account", async () => {
    const { handle, responses } = createHarness();
    assert.equal(
        await handle({}, {}, "/api/wallet/challenge", "POST"),
        true
    );
    assert.deepEqual(responses, [{
        status: 401,
        body: { error: "Sign in to link a wallet." }
    }]);
});

test("profile route formats the existing account profile response", async () => {
    const { handle, responses, queries } = createHarness({
        authenticatedUser: () => ({ sub: "7" })
    });

    assert.equal(await handle({}, {}, "/api/profile", "GET"), true);
    assert.equal(queries.length, 1);
    assert.deepEqual(responses, [{
        status: 200,
        body: {
            playerId: "7",
            username: "tank",
            walletAddress: "",
            level: 3,
            experience: "2500",
            battlesPlayed: "3",
            victories: "2",
            defeats: "1",
            tanksDestroyed: "4"
        }
    }]);
});
