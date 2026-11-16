"use strict";

const { isAddress } = require("ethers");

const MAX_UINT256 = (1n << 256n) - 1n;
const ROOM_CAPACITY = 32;

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
        body.players.length > ROOM_CAPACITY) {
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

function teamId(value) {
    return value === "blue" ? 1 : 2;
}

function sanitizePlayerName(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
}

module.exports = {
    sanitizePlayerName,
    teamId,
    validBattleId,
    validMatchResults,
    validPassword,
    validPlayerAddress,
    validRewardAmount,
    validTeam,
    validUsername,
    walletChallengeMessage
};
