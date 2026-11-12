"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, verifyMessage } = require("ethers");
const {
    constantTimeEqual,
    hashPassword,
    hashTicket,
    signToken,
    verifyPassword,
    verifyToken
} = require("./security");
const {
    sanitizePlayerName,
    validBattleId,
    validMatchResults,
    validPassword,
    validPlayerAddress,
    validRewardAmount,
    validTeam,
    validUsername,
    walletChallengeMessage,
    isAllowedOrigin
} = require("./index");

test("password hashes verify without storing plaintext", async () => {
    const hash = await hashPassword("tankPassword123");
    assert.notEqual(hash, "tankPassword123");
    assert.equal(await verifyPassword("tankPassword123", hash), true);
    assert.equal(await verifyPassword("wrongPassword123", hash), false);
});

test("malformed stored password hashes are rejected without throwing", async () => {
    assert.equal(await verifyPassword("tankPassword123", null), false);
    assert.equal(await verifyPassword("tankPassword123", "invalid"), false);
    assert.equal(
        await verifyPassword("tankPassword123", "scrypt$16384$8$1$AA$AA"),
        false
    );
});

test("signed access tokens reject tampering and expired tokens", () => {
    const token = signToken({ sub: "7" }, "test-secret", 60);
    assert.equal(verifyToken(token, "test-secret").sub, "7");
    const parts = token.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    const tampered = parts.join(".");
    assert.equal(verifyToken(tampered, "test-secret"), null);

    const expired = signToken({ sub: "7" }, "test-secret", -1);
    assert.equal(verifyToken(expired, "test-secret"), null);
});

test("input validators enforce account and team constraints", () => {
    assert.equal(validUsername("tank_player7"), true);
    assert.equal(validUsername("x"), false);
    assert.equal(validPassword("longpassword2"), true);
    assert.equal(validPassword("short1"), false);
    assert.equal(validTeam("blue"), true);
    assert.equal(validTeam("green"), false);
    assert.equal(sanitizePlayerName("Tank\u0000 Pilot").length, 10);
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(hashTicket("abc").length, 64);
});

test("CORS permits local development origins and rejects them in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    try {
        delete process.env.NODE_ENV;
        assert.equal(isAllowedOrigin("http://localhost:51956"), true);
        assert.equal(isAllowedOrigin("http://127.0.0.1:51956"), true);
        assert.equal(isAllowedOrigin("https://malicious.example"), false);
        process.env.NODE_ENV = "production";
        assert.equal(isAllowedOrigin("http://localhost:51956"), false);
    } finally {
        if (previousNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = previousNodeEnv;
        }
    }
});

test("blockchain reward validators reject malformed or unsafe inputs", () => {
    assert.equal(validPlayerAddress("0x0000000000000000000000000000000000000001"), true);
    assert.equal(validPlayerAddress("not-an-address"), false);
    assert.equal(validRewardAmount("1"), true);
    assert.equal(validRewardAmount("0"), false);
    assert.equal(validRewardAmount("01"), false);
    assert.equal(validRewardAmount("1.5"), false);
    assert.equal(
        validRewardAmount("115792089237316195423570985008687907853269984665640564039457584007913129639936"),
        false
    );
    assert.equal(validBattleId(`0x${"a".repeat(64)}`), true);
    assert.equal(validBattleId(`0x${"0".repeat(64)}`), false);
    assert.equal(validBattleId("not-a-battle-id"), false);
});

test("wallet challenge message binds account, address, and one-time nonce", async () => {
    const wallet = Wallet.createRandom();
    const nonce = "ab".repeat(32);
    const message = walletChallengeMessage("42", wallet.address, nonce);
    const signature = await wallet.signMessage(message);

    assert.equal(verifyMessage(message, signature), wallet.address);
    assert.notEqual(
        verifyMessage(
            walletChallengeMessage("43", wallet.address, nonce),
            signature
        ),
        wallet.address
    );
    assert.notEqual(
        verifyMessage(
            walletChallengeMessage("42", wallet.address, "cd".repeat(32)),
            signature
        ),
        wallet.address
    );
});

test("online match results require unique valid room players", () => {
    const valid = {
        winningTeam: 1,
        players: [
            { userId: "1", team: 1, kills: 2 },
            { userId: "2", team: 2, kills: 0 }
        ]
    };
    assert.equal(validMatchResults(valid), true);
    assert.equal(validMatchResults({ ...valid, winningTeam: 3 }), false);
    assert.equal(validMatchResults({
        ...valid,
        players: [...valid.players, valid.players[0]]
    }), false);
    assert.equal(validMatchResults({
        winningTeam: 2,
        players: [{ userId: "1", team: 1, kills: -1 }]
    }), false);
});
