# Abrams online service

This project has two Node.js processes: the HTTP API for accounts, room
allocation, and one-time join tickets; and an authoritative WebSocket game
gateway for browser clients. PostgreSQL stores account and room data. The
gateway currently runs a simple server-side tank-arena simulation; it does not
run Unity physics or the local single-player scene.

## Run locally

Requirements: Node.js 20+ and PostgreSQL 14+.

1. Create a PostgreSQL database and user.
2. Copy `.env.example` to `.env`; set `DATABASE_URL`, `ACCESS_TOKEN_SECRET`,
   and `SERVER_API_TOKEN` to unique random values of at least 32 characters.
   Local development allows HTTP origins on `localhost` and `127.0.0.1`.
   In production, set `ALLOWED_ORIGINS` to a comma-separated list of exact
   HTTPS game origins, for example `https://game.example.com`.
3. Install dependencies and start the HTTP API:

   ```sh
   npm install
   npm test
   npm start
   ```

The service creates its tables on startup. `/health` checks both the HTTP
process and PostgreSQL connection.

Signed-in players can retrieve their persistent profile from
`GET /api/profile`. The response includes the account ID, username, wallet,
experience, battles played, victories, defeats, and tanks destroyed. Levels
are calculated as `floor(experience / 1000) + 1`; a completed battle awards
100 experience plus 25 per tank destroyed.

### Load development sample data

Start the service once so it can create the database tables, then, from this
directory, import the sample rows:

```sh
set -a
. ./.env
set +a
psql "$DATABASE_URL" -f sample-data.sql
```

The sample accounts are `samplepilot` and `redcommander`; both use the
development-only password `TankDemo2026!`. The sample match is marked complete
and its sample game server is offline, so it demonstrates stored data without
appearing as a joinable online room. Never use these credentials outside a
local development database.

## WebSocket game gateway

Run one gateway process per concurrently hosted room. Each process registers
with the API, polls for its room assignment, validates one-time player tickets,
and sends authoritative snapshots at 20 Hz. A room supports up to 32 players.
The gateway accepts browser WebSockets at `/game`; it authenticates each
connection with the ticket sent as the first WebSocket message, not in the URL.
Room creation reserves a gateway before the owner connects. Retrying a join
from the same account reissues its ticket without consuming another player
slot; only the newest unused ticket remains valid. An assigned room with no
connected players is released after 30 seconds. Authenticated gateway
coordination traffic is isolated from player request limits.

Configure these values in the same `.env` used by the API. For local
development:

```dotenv
ABRAMS_ONLINE_API_URL=http://127.0.0.1:3000
ABRAMS_ONLINE_SERVER_ID=local-01
ABRAMS_ONLINE_WS_PUBLIC_URL=ws://localhost:7777/game
ABRAMS_ONLINE_WS_PORT=7777
ABRAMS_ONLINE_MAX_PLAYERS=32
```

Keep `SERVER_API_TOKEN` identical for the API and gateway; never put it in the
Unity client. For local development, the API permits localhost browser
origins. In production, set `ALLOWED_ORIGINS` to the exact HTTPS game origin,
publish a `wss://` URL, and terminate TLS either in the gateway (using
`TLS_CERT_FILE` and `TLS_KEY_FILE`) or a reverse proxy that forwards WebSocket
upgrades to the gateway's port. With a reverse proxy, leave both certificate
variables unset and firewall the gateway port so only the proxy can reach it.
The WebSocket URL must end in `/game`.

### VPS deployment with Nginx

Use a domain name whose DNS `A` record points to the VPS public IP. Browsers
need HTTPS for the WebGL site and WSS for its game connection; do not publish
the local `ws://` example as a production endpoint. For example, if the game
site, API, and WebSocket endpoint all use `game.example.com`, configure:

```dotenv
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=https://game.example.com
ABRAMS_ONLINE_API_URL=https://game.example.com
ABRAMS_ONLINE_SERVER_ID=vps-01
ABRAMS_ONLINE_WS_PUBLIC_URL=wss://game.example.com/game
ABRAMS_ONLINE_WS_PORT=7777
ABRAMS_ONLINE_MAX_PLAYERS=32
```

Also set `DATABASE_URL` to the VPS PostgreSQL database and replace
`ACCESS_TOKEN_SECRET` and `SERVER_API_TOKEN` with separate, random secrets of
at least 32 characters. Keep PostgreSQL, port 3000, and port 7777 inaccessible
from the public internet. Allow inbound SSH and HTTPS (ports 22 and 443); allow
HTTP port 80 only if using it for the HTTPS redirect and certificate setup.

Configure Nginx with a valid certificate for the domain. Serve the Unity
WebGL build from `/var/www/abrams`, proxy API requests to port 3000, and proxy
the WebSocket route to port 7777. The `/game` location must preserve the
WebSocket upgrade:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name game.example.com;

    ssl_certificate     /etc/letsencrypt/live/game.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;

    root /var/www/abrams;
    index index.html;

    location /game {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Start PostgreSQL, then run `npm start` and `npm run start:game-ws-gateway`
from this directory (use a process manager such as systemd to keep both
running after logout/reboot). Publish the contents of the Unity WebGL build
to `/var/www/abrams`. In the Unity scene used for the WebGL build, set the
`GameDirector` **Online Service Url** to `https://game.example.com`, rebuild,
and upload the new build. Create an account and room in the browser; the
gateway should log that the assigned room is ready.

After starting the API with `npm start`, start the gateway in another process:

```sh
npm run start:game-ws-gateway
```

Set the Unity `GameDirector` **Online Service Url** field to the API's public
HTTPS origin in the browser build (or `http://localhost:3000` for local tests).
The game UI supports registration/login, room listing/creation, team selection,
and joining. Browser clients require HTTPS/WSS in production; raw UDP is not
used by this online flow. Use a distinct server ID and public WebSocket URL for
each additional gateway process. The API assigns one active room to each
gateway process.

The current gateway is a Node.js simulation with simplified X/Z movement and
server-side projectiles. The WebGL client predicts its own tank movement,
smooths corrections and remote-player snapshots, and renders networked shot
effects plus track, rotor, and exhaust animations. The server does not
instantiate the Unity tank prefab or simulate the local scene's physics,
drones, or equipment, so tank-to-tank hits are determined by the server's
simplified arena model. Match-result and blockchain reward endpoints are not
automatically invoked by this gateway.

### Blockchain battle rewards

The service can submit verified battle rewards through the `TankGame` contract.
Set `BLOCKCHAIN_RPC_URL`, `BLOCKCHAIN_CHAIN_ID`,
`TANK_COIN_CONTRACT_ADDRESS`, and `TANK_GAME_CONTRACT_ADDRESS` in `.env`, and
set `GAME_SERVER_PRIVATE_KEY` to a dedicated backend signer key. Configure
Ethereum Sepolia with chain ID `11155111` and
`https://ethereum-sepolia-rpc.publicnode.com`. The supplied TankGame address
has bytecode on Ethereum Sepolia and points to the supplied TankCoin address,
but that TankCoin address has no bytecode there. Deploy TankCoin and deploy
TankGame with the deployed TankCoin address, then update `.env` and the Unity
GameDirector contract-address fields before using the economy or battle
rewards. Grant
that signer `GAME_SERVER_ROLE` on
`TankGame`; also grant the `TankGame` contract `MINTER_ROLE` and `GAME_ROLE` on
`TankCoin`. Keep the signer key private and never put it in a Unity client.

After independently verifying a battle result, a trusted dedicated server can
call `POST /api/server/rewards` with `X-Server-Token` and JSON fields
`playerAddress`, `amountWei`, `reason`, and `battleId`. `amountWei` is a
positive decimal integer in TCOIN's smallest units (18 decimals), and
`battleId` is a unique, nonzero `bytes32` hex value. The contract prevents a
battle ID from being rewarded more than once; retries return
`already_rewarded`. This endpoint trusts authenticated dedicated servers to
verify game outcomes and must not be exposed as a player reward claim API.
Players link a reward wallet while signed in: request `POST /api/wallet/challenge`
with an `address`, sign the returned `message` with that wallet, and submit the
address, returned `nonce`, and signature to `POST /api/wallet/verify`. The
challenge expires after five minutes, is single-use, and each wallet can be
linked to only one account. The dedicated server receives the verified wallet
address as part of join-ticket validation; it must never accept a reward
destination directly from a game client. Set
`ABRAMS_ONLINE_KILL_REWARD_WEI` in each dedicated server process to the
positive integer reward per enemy tank destroyed.

Do not expose this service or send passwords over plain HTTP on the public
internet. Terminate HTTPS at a trusted reverse proxy and restrict the service
and database with firewall rules. The Node service is the account/lobby
and database with firewall rules. The API and game gateway are separate
processes and should both be supervised and monitored in production.
