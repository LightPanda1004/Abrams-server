"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;

async function hashPassword(password) {
    const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
    const hash = await scrypt(password, salt, PASSWORD_HASH_BYTES, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
    });

    return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
    if (typeof password !== "string" ||
        typeof storedHash !== "string") {
        return false;
    }

    const parts = storedHash.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
        return false;
    }

    const [, cost, blockSize, parallelization, saltText, hashText] = parts;
    if (cost !== "16384" || blockSize !== "8" || parallelization !== "1" ||
        !/^[A-Za-z0-9_-]+$/.test(saltText) ||
        !/^[A-Za-z0-9_-]+$/.test(hashText)) {
        return false;
    }

    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== PASSWORD_SALT_BYTES ||
        expected.length !== PASSWORD_HASH_BYTES) {
        return false;
    }

    const actual = await scrypt(
        password,
        salt,
        PASSWORD_HASH_BYTES,
        { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
    );
    return expected.length === actual.length &&
        crypto.timingSafeEqual(expected, actual);
}

function signToken(payload, secret, lifetimeSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const header = encodeJson({ alg: "HS256", typ: "JWT" });
    const body = encodeJson({
        ...payload,
        iat: now,
        exp: now + lifetimeSeconds
    });
    const unsigned = `${header}.${body}`;
    const signature = crypto
        .createHmac("sha256", secret)
        .update(unsigned)
        .digest("base64url");
    return `${unsigned}.${signature}`;
}

function verifyToken(token, secret) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        return null;
    }

    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = crypto
        .createHmac("sha256", secret)
        .update(unsigned)
        .digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (expected.length !== actual.length ||
        !crypto.timingSafeEqual(expected, actual)) {
        return null;
    }

    try {
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (header.alg !== "HS256" ||
            typeof payload.exp !== "number" ||
            payload.exp <= Math.floor(Date.now() / 1000)) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

function hashTicket(ticket) {
    return crypto.createHash("sha256").update(ticket).digest("hex");
}

function constantTimeEqual(left, right) {
    const leftBuffer = Buffer.from(left || "");
    const rightBuffer = Buffer.from(right || "");
    return leftBuffer.length === rightBuffer.length &&
        crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeJson(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

module.exports = {
    constantTimeEqual,
    hashPassword,
    hashTicket,
    signToken,
    verifyPassword,
    verifyToken
};
