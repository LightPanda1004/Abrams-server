"use strict";

const {
    Contract,
    getAddress,
    isAddress,
    Wallet
} = require("ethers");
const {
    createSepoliaProvider,
    SEPOLIA_CHAIN_ID
} = require("./blockchain-rpc");

const TANK_COIN_ABI = [
    "function MINTER_ROLE() view returns (bytes32)",
    "function GAME_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)"
];
const TANK_GAME_ABI = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function GAME_SERVER_ROLE() view returns (bytes32)",
    "function processedBattleIds(bytes32 battleId) view returns (bool)",
    "function coin() view returns (address)",
    "function rewardDestroyEnemy(address player, uint256 amount, string reason, bytes32 battleId)"
];

let blockchainContractPromise;

async function getBlockchainContract() {
    if (!blockchainContractPromise) {
        blockchainContractPromise = (async () => {
            const required = [
                "BLOCKCHAIN_RPC_URL",
                "BLOCKCHAIN_CHAIN_ID",
                "TANK_COIN_CONTRACT_ADDRESS",
                "TANK_GAME_CONTRACT_ADDRESS",
                "GAME_SERVER_ADDRESS",
                "GAME_SERVER_PRIVATE_KEY"
            ];
            const missing = required.filter(name => !process.env[name]);
            if (missing.length > 0) {
                const error = new Error(
                    `Blockchain rewards are not configured: ${missing.join(", ")}.`
                );
                error.status = 503;
                throw error;
            }

            const chainIdText = process.env.BLOCKCHAIN_CHAIN_ID;
            if (chainIdText !== SEPOLIA_CHAIN_ID.toString()) {
                const error = new Error(
                    `BLOCKCHAIN_CHAIN_ID must be ${SEPOLIA_CHAIN_ID} (Ethereum Sepolia).`
                );
                error.status = 503;
                throw error;
            }
            if (!isAddress(process.env.TANK_COIN_CONTRACT_ADDRESS) ||
                !isAddress(process.env.TANK_GAME_CONTRACT_ADDRESS) ||
                !isAddress(process.env.GAME_SERVER_ADDRESS)) {
                const error = new Error(
                    "TANK_COIN_CONTRACT_ADDRESS, TANK_GAME_CONTRACT_ADDRESS, and GAME_SERVER_ADDRESS must be valid addresses."
                );
                error.status = 503;
                throw error;
            }

            const provider = await createSepoliaProvider();

            const coinAddress = getAddress(
                process.env.TANK_COIN_CONTRACT_ADDRESS
            );
            const gameAddress = getAddress(
                process.env.TANK_GAME_CONTRACT_ADDRESS
            );
            const coinCode = await provider.getCode(coinAddress);
            const gameCode = await provider.getCode(gameAddress);
            if (coinCode === "0x" || gameCode === "0x") {
                const missingContracts = [
                    coinCode === "0x" ? "TankCoin" : "",
                    gameCode === "0x" ? "TankGame" : ""
                ].filter(Boolean);
                const error = new Error(
                    `${missingContracts.join(" and ")} contract address(es) have no bytecode on the configured chain.`
                );
                error.status = 503;
                throw error;
            }

            const gameReader = new Contract(
                gameAddress,
                [
                    "function coin() view returns (address)",
                    "function hasRole(bytes32 role, address account) view returns (bool)",
                    "function GAME_SERVER_ROLE() view returns (bytes32)"
                ],
                provider
            );
            const linkedCoinAddress = getAddress(await gameReader.coin());
            if (linkedCoinAddress !== coinAddress) {
                const error = new Error(
                    "TankGame is configured to use a different TankCoin address."
                );
                error.status = 503;
                throw error;
            }

            const coinReader = new Contract(
                coinAddress,
                TANK_COIN_ABI,
                provider
            );
            const minterRole = await coinReader.MINTER_ROLE();
            const gameRole = await coinReader.GAME_ROLE();
            const tankGameHasMinterRole = await coinReader.hasRole(
                minterRole,
                gameAddress
            );
            const tankGameHasGameRole = await coinReader.hasRole(
                gameRole,
                gameAddress
            );
            if (!tankGameHasMinterRole || !tankGameHasGameRole) {
                const error = new Error(
                    "TankGame is missing the required MINTER_ROLE or GAME_ROLE on TankCoin."
                );
                error.status = 503;
                throw error;
            }

            const signer = new Wallet(
                process.env.GAME_SERVER_PRIVATE_KEY,
                provider
            );
            const configuredSignerAddress = getAddress(
                process.env.GAME_SERVER_ADDRESS
            );
            if (getAddress(signer.address) !== configuredSignerAddress) {
                const error = new Error(
                    "GAME_SERVER_ADDRESS does not match the backend signing key."
                );
                error.status = 503;
                throw error;
            }
            const gameSigner = new Contract(
                gameAddress,
                TANK_GAME_ABI,
                signer
            );
            const serverRole = await gameReader.GAME_SERVER_ROLE();
            const signerHasServerRole = await gameReader.hasRole(
                serverRole,
                signer.address
            );
            if (!signerHasServerRole) {
                const error = new Error(
                    "The configured GAME_SERVER_ADDRESS does not hold GAME_SERVER_ROLE on TankGame."
                );
                error.status = 503;
                throw error;
            }
            return gameSigner;
        })().catch(error => {
            blockchainContractPromise = undefined;
            throw error;
        });
    }
    return blockchainContractPromise;
}

module.exports = { getBlockchainContract };
