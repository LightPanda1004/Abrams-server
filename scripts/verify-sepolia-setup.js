"use strict";

const {
  Contract,
  Wallet,
  getAddress,
  isAddress
} = require("ethers");
const {
  createSepoliaProvider,
  SEPOLIA_CHAIN_ID
} = require("../src/blockchain-rpc");

const COIN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function GAME_ROLE() view returns (bytes32)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)"
];
const GAME_ABI = [
  "function coin() view returns (address)",
  "function coinsPerEth() view returns (uint256)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function GAME_SERVER_ROLE() view returns (bytes32)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)"
];
const DEPLOYMENT_ADMIN =
  "0x2a8937299ae3D0003Cc43c4619ba4286e2E8916c";

async function main() {
  const required = [
    "BLOCKCHAIN_RPC_URL",
    "BLOCKCHAIN_CHAIN_ID",
    "TANK_COIN_CONTRACT_ADDRESS",
    "TANK_GAME_CONTRACT_ADDRESS"
  ];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }
  if (process.env.BLOCKCHAIN_CHAIN_ID !== SEPOLIA_CHAIN_ID.toString()) {
    throw new Error(
      `BLOCKCHAIN_CHAIN_ID must be ${SEPOLIA_CHAIN_ID} (Ethereum Sepolia).`
    );
  }
  if (!isAddress(process.env.TANK_COIN_CONTRACT_ADDRESS) ||
      !isAddress(process.env.TANK_GAME_CONTRACT_ADDRESS)) {
    throw new Error("Configured contract addresses must be valid Ethereum addresses.");
  }

  const provider = await createSepoliaProvider();
  const network = await provider.getNetwork();
  console.log(`RPC chain ID: ${network.chainId}`);

  const coinAddress = getAddress(process.env.TANK_COIN_CONTRACT_ADDRESS);
  const gameAddress = getAddress(process.env.TANK_GAME_CONTRACT_ADDRESS);
  const [coinCode, gameCode] = await Promise.all([
    provider.getCode(coinAddress),
    provider.getCode(gameAddress)
  ]);
  const coinDeployed = coinCode !== "0x";
  const gameDeployed = gameCode !== "0x";
  console.log(`TankCoin bytecode: ${coinDeployed ? "present" : "missing"}`);
  console.log(`TankGame bytecode: ${gameDeployed ? "present" : "missing"}`);
  if (!coinDeployed || !gameDeployed) {
    throw new Error("One or both configured contracts have no Sepolia bytecode.");
  }

  const coin = new Contract(coinAddress, COIN_ABI, provider);
  const game = new Contract(gameAddress, GAME_ABI, provider);
  const [
    tokenName,
    tokenSymbol,
    decimals,
    totalSupply,
    maxSupply,
    linkedCoin,
    coinsPerEth,
    coinAdminRole,
    minterRole,
    gameRole,
    gameAdminRole,
    gameServerRole
  ] = await Promise.all([
    coin.name(),
    coin.symbol(),
    coin.decimals(),
    coin.totalSupply(),
    coin.MAX_SUPPLY(),
    game.coin(),
    game.coinsPerEth(),
    coin.DEFAULT_ADMIN_ROLE(),
    coin.MINTER_ROLE(),
    coin.GAME_ROLE(),
    game.DEFAULT_ADMIN_ROLE(),
    game.GAME_SERVER_ROLE()
  ]);

  console.log(`TankCoin: ${tokenName} (${tokenSymbol}), ${decimals} decimals`);
  console.log(`TankCoin total supply: ${totalSupply.toString()}`);
  console.log(`TankCoin maximum supply: ${maxSupply.toString()}`);
  console.log(`TankGame coin(): ${getAddress(linkedCoin)}`);
  console.log(`TCOIN per Sepolia ETH: ${coinsPerEth.toString()}`);

  if (getAddress(linkedCoin) !== coinAddress) {
    throw new Error("TankGame references a different TankCoin address.");
  }
  if (tokenName !== "Tank Coin" || tokenSymbol !== "TCOIN" ||
      BigInt(decimals) !== 18n ||
      maxSupply !== 1_000_000_000n * 10n ** 18n) {
    throw new Error("TankCoin metadata or maximum supply differs from expectations.");
  }
  if (coinsPerEth <= 0n) {
    throw new Error("TankGame has an invalid TCOIN purchase exchange rate.");
  }

  let valid = true;
  const gameHasMinterRole = await coin.hasRole(minterRole, gameAddress);
  const gameHasGameRole = await coin.hasRole(gameRole, gameAddress);
  console.log(`TankGame has MINTER_ROLE: ${gameHasMinterRole}`);
  console.log(`TankGame has GAME_ROLE: ${gameHasGameRole}`);
  valid = valid && gameHasMinterRole && gameHasGameRole;

  const configuredAdmin =
    process.env.CONTRACT_ADMIN_ADDRESS || DEPLOYMENT_ADMIN;
  if (!isAddress(configuredAdmin)) {
    throw new Error("CONTRACT_ADMIN_ADDRESS is not a valid Ethereum address.");
  }
  const adminAddress = getAddress(configuredAdmin);
  const [coinAdmin, gameAdmin] = await Promise.all([
    coin.hasRole(coinAdminRole, adminAddress),
    game.hasRole(gameAdminRole, adminAddress)
  ]);
  console.log(`Contract administrator: ${adminAddress}`);
  console.log(`Administrator has TankCoin DEFAULT_ADMIN_ROLE: ${coinAdmin}`);
  console.log(`Administrator has TankGame DEFAULT_ADMIN_ROLE: ${gameAdmin}`);
  valid = valid && coinAdmin && gameAdmin;

  const serverAddress = process.env.GAME_SERVER_ADDRESS;
  if (!serverAddress || !isAddress(serverAddress)) {
    console.log("GAME_SERVER_ADDRESS: not configured or invalid.");
    valid = false;
  } else {
    const signerAddress = getAddress(serverAddress);
    const hasServerRole = await game.hasRole(gameServerRole, signerAddress);
    console.log(`Backend signer: ${signerAddress}`);
    console.log(`Backend signer has GAME_SERVER_ROLE: ${hasServerRole}`);
    valid = valid && hasServerRole;

    if (process.env.GAME_SERVER_PRIVATE_KEY) {
      const derivedAddress = getAddress(
        new Wallet(process.env.GAME_SERVER_PRIVATE_KEY).address
      );
      if (derivedAddress !== signerAddress) {
        throw new Error(
          "GAME_SERVER_ADDRESS does not match GAME_SERVER_PRIVATE_KEY."
        );
      }
    }
  }

  console.log(`TankCoin MINTER_ROLE admin: ${await coin.getRoleAdmin(minterRole)}`);
  console.log(`TankCoin GAME_ROLE admin: ${await coin.getRoleAdmin(gameRole)}`);
  console.log(`TankGame GAME_SERVER_ROLE admin: ${await game.getRoleAdmin(gameServerRole)}`);
  if (!valid) {
    throw new Error(
      "Sepolia contracts are deployed, but permissions or signer configuration are incomplete."
    );
  }
  console.log("Sepolia economy contract configuration and permissions are valid.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
