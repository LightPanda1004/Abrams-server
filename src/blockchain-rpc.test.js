"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    createSepoliaProvider,
    getSepoliaRpcUrls
} = require("./blockchain-rpc");

test("Sepolia RPC URLs include unique configured fallbacks", () => {
    assert.deepEqual(
        getSepoliaRpcUrls({
            BLOCKCHAIN_RPC_URL: "https://rpc.example",
            BLOCKCHAIN_RPC_FALLBACK_URLS:
                "https://backup.example, https://rpc.example"
        }),
        ["https://rpc.example", "https://backup.example"]
    );
});

test("Sepolia provider skips unavailable and wrong-chain endpoints", async () => {
    const endpoints = [];
    const provider = await createSepoliaProvider({
        env: {
            BLOCKCHAIN_RPC_URL: "https://wrong-chain.example",
            BLOCKCHAIN_RPC_FALLBACK_URLS:
                "https://unavailable.example,https://sepolia.example"
        },
        createProvider(url) {
            endpoints.push(url);
            return {
                async getNetwork() {
                    if (url.includes("unavailable")) {
                        throw new Error("offline");
                    }
                    return {
                        chainId: url.includes("sepolia") ? 11155111n : 1n
                    };
                }
            };
        }
    });

    assert.deepEqual(endpoints, [
        "https://wrong-chain.example",
        "https://unavailable.example",
        "https://sepolia.example"
    ]);
    assert.equal(typeof provider.getNetwork, "function");
});

test("Sepolia provider rejects configuration when all endpoints are invalid", async () => {
    await assert.rejects(
        createSepoliaProvider({
            env: { BLOCKCHAIN_RPC_URL: "https://mainnet.example" },
            createProvider: () => ({
                async getNetwork() {
                    return { chainId: 1n };
                }
            })
        }),
        {
            status: 503,
            message: /chain ID 11155111/
        }
    );
});
