"use strict";

const { JsonRpcProvider } = require("ethers");

const SEPOLIA_CHAIN_ID = 11155111n;

function getSepoliaRpcUrls(env = process.env) {
    return [
        env.BLOCKCHAIN_RPC_URL,
        ...(env.BLOCKCHAIN_RPC_FALLBACK_URLS || "")
            .split(",")
            .map(url => url.trim())
    ].filter((url, index, urls) =>
        typeof url === "string" && url.length > 0 &&
        urls.indexOf(url) === index
    );
}

async function createSepoliaProvider({
    env = process.env,
    createProvider = url => new JsonRpcProvider(url)
} = {}) {
    const urls = getSepoliaRpcUrls(env);
    if (urls.length === 0) {
        const error = new Error(
            "BLOCKCHAIN_RPC_URL or BLOCKCHAIN_RPC_FALLBACK_URLS must configure a Sepolia RPC endpoint."
        );
        error.status = 503;
        throw error;
    }

    const failures = [];
    for (const url of urls) {
        try {
            const provider = createProvider(url);
            const network = await provider.getNetwork();
            if (network.chainId === SEPOLIA_CHAIN_ID) {
                return provider;
            }
            failures.push("an endpoint returned an unexpected chain ID");
        } catch {
            failures.push("an endpoint was unavailable");
        }
    }

    const error = new Error(
        `No configured RPC endpoint returned Ethereum Sepolia (chain ID ${SEPOLIA_CHAIN_ID}); ${failures.length} endpoint(s) checked.`
    );
    error.status = 503;
    throw error;
}

module.exports = {
    SEPOLIA_CHAIN_ID,
    createSepoliaProvider,
    getSepoliaRpcUrls
};
