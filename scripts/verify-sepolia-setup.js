"use strict";

const {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress
} = require("ethers");

const requiredEnv = [
  "BLOCKCHAIN_RPC_URL",
  "BLOCKCHAIN_CHAIN_ID",
  "TANK_COIN_CONTRACT_ADDRESS",
  "TANK_GAME_CONTRACT_ADDRESS",
  "GAME_SERVER_PRIVATE_KEY"
];

async function main() {
  const missing = requiredEnv.filter(name => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing required environment values: ${missing.join(", ")}`);
    process.exit(1);
  }

  const chainIdText = process.env.BLOCKCHAIN_CHAIN_ID;
  if (!/^[1-9]\d*$/.test(chainIdText) || !Number.isSafeInteger(Number(chainIdText))) {
    console.error("BLOCKCHAIN_CHAIN_ID must be a positive integer.");
    process.exit(1);
  }

  const coinAddress = process.env.TANK_COIN_CONTRACT_ADDRESS;
  const gameAddress = process.env.TANK_GAME_CONTRACT_ADDRESS;
  if (!isAddress(coinAddress) || !isAddress(gameAddress)) {
    console.error("TANK_COIN_CONTRACT_ADDRESS and TANK_GAME_CONTRACT_ADDRESS must be valid addresses.");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
  const network = await provider.getNetwork();
  console.log(`RPC network: ${network.name || "unknown"}, chainId=${network.chainId.toString()}`);
  if (network.chainId !== BigInt(chainIdText)) {
    console.error(`Expected chain ID ${chainIdText} but RPC returned ${network.chainId.toString()}.`);
    process.exit(1);
  }

  const gameReader = new Contract(
    getAddress(gameAddress),
    [
      "function coin() view returns (address)",
      "function GAME_SERVER_ROLE() view returns (bytes32)",
      "function hasRole(bytes32 role, address account) view returns (bool)"
    ],
    provider
  );

  const coinCode = await provider.getCode(getAddress(coinAddress));
  const gameCode = await provider.getCode(getAddress(gameAddress));
  console.log(`TankCoin bytecode: ${coinCode === "0x" ? "missing" : "present"}`);
  console.log(`TankGame bytecode: ${gameCode === "0x" ? "missing" : "present"}`);

  if (coinCode === "0x" || gameCode === "0x") {
    console.error("At least one configured contract is missing bytecode on the configured chain.");
    process.exit(1);
  }

  const linkedCoinAddress = getAddress(await gameReader.coin());
  console.log(`TankGame coin() => ${linkedCoinAddress}`);
  if (linkedCoinAddress !== getAddress(coinAddress)) {
    console.error("TankGame is pointing to a different TankCoin address than the configured value.");
    process.exit(1);
  }

  const coinReader = new Contract(
    getAddress(coinAddress),
    [
      "function MINTER_ROLE() view returns (bytes32)",
      "function GAME_ROLE() view returns (bytes32)",
      "function hasRole(bytes32 role, address account) view returns (bool)"
    ],
    provider
  );

  const minterRole = await coinReader.MINTER_ROLE();
  const gameRole = await coinReader.GAME_ROLE();
  const gameHasMinterRole = await coinReader.hasRole(minterRole, getAddress(gameAddress));
  const gameHasGameRole = await coinReader.hasRole(gameRole, getAddress(gameAddress));
  console.log(`TankGame has MINTER_ROLE: ${gameHasMinterRole}`);
  console.log(`TankGame has GAME_ROLE: ${gameHasGameRole}`);

  if (!gameHasMinterRole || !gameHasGameRole) {
    console.error("TankGame is missing one or more required TankCoin roles.");
    process.exit(1);
  }

  const signer = new Wallet(process.env.GAME_SERVER_PRIVATE_KEY, provider);
  const serverRole = await gameReader.GAME_SERVER_ROLE();
  const signerHasServerRole = await gameReader.hasRole(serverRole, signer.address);
  console.log(`Backend signer ${signer.address} has GAME_SERVER_ROLE: ${signerHasServerRole}`);

  if (!signerHasServerRole) {
    console.error("The configured GAME_SERVER_PRIVATE_KEY does not hold GAME_SERVER_ROLE on TankGame.");
    process.exit(1);
  }

  console.log("Sepolia economy configuration is valid.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
