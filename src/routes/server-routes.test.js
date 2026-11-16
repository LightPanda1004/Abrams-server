"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServerRoutes } = require("./server-routes");

function createHarness(overrides = {}) {
    const responses = [];
    const queries = [];
    const dependencies = {
        pool: {
            async query(sql, values) {
                queries.push({ sql, values });
                return { rows: [{ id: "12", name: "Test room" }] };
            }
        },
        respond(_response, status, body) {
            responses.push({ status, body });
        },
        async readJson() {
            return {};
        },
        requireServer() {
            return true;
        },
        async withTransaction(action) {
            return action({ query: async () => ({ rows: [] }) });
        },
        ...overrides
    };

    return {
        handle: createServerRoutes(dependencies),
        responses,
        queries
    };
}

test("server routes leave unrelated requests to the next router", async () => {
    const { handle } = createHarness();
    assert.equal(
        await handle({}, {}, "/api/rooms", "GET", new URL("http://localhost/api/rooms")),
        false
    );
});

test("server routes require server authentication", async () => {
    const { handle, responses } = createHarness({
        requireServer(_request, response) {
            response.statusCode = 401;
            return false;
        }
    });
    const response = {};

    assert.equal(
        await handle(
            {},
            response,
            "/api/server/heartbeat",
            "POST",
            new URL("http://localhost/api/server/heartbeat")
        ),
        true
    );
    assert.equal(response.statusCode, 401);
    assert.deepEqual(responses, []);
});

test("server assignment keeps its query and response shape", async () => {
    const { handle, responses, queries } = createHarness();

    assert.equal(
        await handle(
            {},
            {},
            "/api/server/assignment",
            "GET",
            new URL("http://localhost/api/server/assignment?id=game-1")
        ),
        true
    );
    assert.deepEqual(queries[0].values, ["game-1"]);
    assert.deepEqual(responses, [{
        status: 200,
        body: {
            rooms: [{ id: "12", name: "Test room" }],
            room: { id: "12", name: "Test room" }
        }
    }]);
});

test("server ticket validation rejects malformed tickets before querying", async () => {
    const { handle, responses, queries } = createHarness({
        async readJson() {
            return { ticket: "short", serverId: "game-1" };
        }
    });

    assert.equal(
        await handle(
            {},
            {},
            "/api/server/tickets/validate",
            "POST",
            new URL("http://localhost/api/server/tickets/validate")
        ),
        true
    );
    assert.deepEqual(responses, [{
        status: 400,
        body: { error: "Invalid ticket." }
    }]);
    assert.deepEqual(queries, []);
});
