"use strict";

const {
  Contract,
  Interface,
  getAddress,
  isAddress
} = require("ethers");
const {
  createSepoliaProvider,
  SEPOLIA_CHAIN_ID
} = require("../src/blockchain-rpc");

const COIN_ADDRESS = "0xb9990D003798C454442501dFDBa532b552787A7F";
const GAME_ADDRESS = "0xD9Ad1F98575B6fE616B2D21fBdE33ecBf56383bE";
const DEPLOYMENT_ADMIN = "0x2a8937299ae3D0003Cc43c4619ba4286e2E8916c";
const COIN_ABI = [
  "function coin() view returns (address)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function GAME_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)"
];
const GAME_ABI = [
  "function coin() view returns (address)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function GAME_SERVER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)"
];

async function main() {
  if (process.env.BLOCKCHAIN_CHAIN_ID !== SEPOLIA_CHAIN_ID.toString()) {
    throw new Error(
      `Set BLOCKCHAIN_CHAIN_ID=${SEPOLIA_CHAIN_ID} before preparing role grants.`
    );
  }
  const provider = await createSepoliaProvider();
  const coin = new Contract(COIN_ADDRESS, COIN_ABI, provider);
  const game = new Contract(GAME_ADDRESS, GAME_ABI, provider);
  const adminText =
    process.env.CONTRACT_ADMIN_ADDRESS || DEPLOYMENT_ADMIN;
  if (!isAddress(adminText)) {
    throw new Error("CONTRACT_ADMIN_ADDRESS must be a valid Ethereum address.");
  }
  const adminAddress = getAddress(adminText);
  const [coinCode, gameCode, linkedCoin] = await Promise.all([
    provider.getCode(COIN_ADDRESS),
    provider.getCode(GAME_ADDRESS),
    game.coin()
  ]);
  if (coinCode === "0x" || gameCode === "0x" ||
      getAddress(linkedCoin) !== getAddress(COIN_ADDRESS)) {
    throw new Error(
      "The configured Sepolia deployment is missing or TankGame references another TankCoin."
    );
  }

  const [coinAdminRole, gameAdminRole] = await Promise.all([
    coin.DEFAULT_ADMIN_ROLE(),
    game.DEFAULT_ADMIN_ROLE()
  ]);
  const [coinAdmin, gameAdmin] = await Promise.all([
    coin.hasRole(coinAdminRole, adminAddress),
    game.hasRole(gameAdminRole, adminAddress)
  ]);
  if (!coinAdmin || !gameAdmin) {
    throw new Error(
      `${adminAddress} is not an administrator of both deployed contracts.`
    );
  }

  const coinInterface = new Interface(COIN_ABI);
  const gameInterface = new Interface(GAME_ABI);
  const plan = [];
  const [minterRole, gameRole] = await Promise.all([
    coin.MINTER_ROLE(),
    coin.GAME_ROLE()
  ]);
  if (!await coin.hasRole(minterRole, GAME_ADDRESS)) {
    plan.push({
      purpose: "Allow TankGame to mint TCOIN purchases",
      to: getAddress(COIN_ADDRESS),
      function: "grantRole(MINTER_ROLE, TankGame)",
      data: coinInterface.encodeFunctionData(
        "grantRole",
        [minterRole, GAME_ADDRESS]
      )
    });
  }
  if (!await coin.hasRole(gameRole, GAME_ADDRESS)) {
    plan.push({
      purpose: "Allow TankGame to mint authorized gameplay rewards",
      to: getAddress(COIN_ADDRESS),
      function: "grantRole(GAME_ROLE, TankGame)",
      data: coinInterface.encodeFunctionData(
        "grantRole",
        [gameRole, GAME_ADDRESS]
      )
    });
  }

  const serverAddressText = process.env.GAME_SERVER_ADDRESS;
  if (!serverAddressText || !isAddress(serverAddressText)) {
    console.log("GAME_SERVER_ADDRESS is not configured; no server-role transaction was prepared.");
  } else {
    const serverAddress = getAddress(serverAddressText);
    const serverRole = await game.GAME_SERVER_ROLE();
    if (!await game.hasRole(serverRole, serverAddress)) {
      plan.push({
        purpose: "Authorize the backend signer to submit unique game rewards",
        to: getAddress(GAME_ADDRESS),
        function: "grantRole(GAME_SERVER_ROLE, backend signer)",
        data: gameInterface.encodeFunctionData(
          "grantRole",
          [serverRole, serverAddress]
        )
      });
    }
  }

  console.log(`Network: Ethereum Sepolia (${SEPOLIA_CHAIN_ID})`);
  console.log(`Administrator required to submit: ${adminAddress}`);
  console.log("No transactions were sent. Import each `to` + `data` pair into a wallet transaction only after reviewing it.");
  console.log(JSON.stringify(plan, null, 2));
  if (plan.length === 0) {
    console.log("No role grants are needed for the currently configured recipients.");
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
