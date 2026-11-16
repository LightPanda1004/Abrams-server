"use strict";

const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean)
);

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

module.exports = { isAllowedOrigin };
