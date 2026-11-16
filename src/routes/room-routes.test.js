"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoomRoutes } = require("./room-routes");

function createHarness(overrides = {}) {
    const responses = [];
    const queries = [];
    const dependencies = {
        pool: {
            async query(sql) {
                queries.push(sql);
                return { rows: [{ id: "12", name: "Test room" }] };
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
        async withTransaction(action) {
            return action({ query: async () => ({ rows: [] }) });
        },
        async issueTicket() {
            return "ticket";
        },
        ...overrides
    };

    return {
        handle: createRoomRoutes(dependencies),
        responses,
        queries
    };
}

test("room routes leave unrelated requests to the next router", async () => {
    const { handle } = createHarness();
    assert.equal(await handle({}, {}, "/api/profile", "GET"), false);
});

test("room routes require an authenticated player", async () => {
    const { handle, responses } = createHarness();
    assert.equal(await handle({}, {}, "/api/rooms", "GET"), true);
    assert.deepEqual(responses, [{
        status: 401,
        body: { error: "Sign in to use online rooms." }
    }]);
});

test("room list response keeps its room query and response shape", async () => {
    const { handle, responses, queries } = createHarness({
        authenticatedUser: () => ({ sub: "7", username: "tank" })
    });

    assert.equal(await handle({}, {}, "/api/rooms", "GET"), true);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /heartbeat_at > NOW\(\) - INTERVAL '20 seconds'/);
    assert.deepEqual(responses, [{
        status: 200,
        body: { rooms: [{ id: "12", name: "Test room" }] }
    }]);
});
