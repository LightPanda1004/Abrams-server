"use strict";

module.exports = `
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    wallet_address TEXT,
    experience BIGINT NOT NULL DEFAULT 0 CHECK (experience >= 0),
    battles_played BIGINT NOT NULL DEFAULT 0 CHECK (battles_played >= 0),
    victories BIGINT NOT NULL DEFAULT 0 CHECK (victories >= 0),
    defeats BIGINT NOT NULL DEFAULT 0 CHECK (defeats >= 0),
    tanks_destroyed BIGINT NOT NULL DEFAULT 0 CHECK (tanks_destroyed >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS experience BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS battles_played BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS victories BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS defeats BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tanks_destroyed BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_address_unique_idx
    ON users (wallet_address) WHERE wallet_address IS NOT NULL;
CREATE TABLE IF NOT EXISTS wallet_challenges (
    nonce_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS game_servers (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 32),
    ws_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready', 'busy', 'offline')),
    current_room_id BIGINT,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE game_servers ADD COLUMN IF NOT EXISTS ws_url TEXT;
CREATE TABLE IF NOT EXISTS rooms (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id BIGINT NOT NULL REFERENCES users(id),
    server_id TEXT NOT NULL REFERENCES game_servers(id),
    status TEXT NOT NULL CHECK (status IN ('waiting', 'playing', 'complete')),
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 32),
    closed_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS closed_reason TEXT;
CREATE TABLE IF NOT EXISTS room_members (
    room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team SMALLINT NOT NULL CHECK (team IN (1, 2)),
    player_name TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    connected BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (room_id, user_id)
);
ALTER TABLE room_members
    ADD COLUMN IF NOT EXISTS connected BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS join_tickets (
    ticket_hash TEXT PRIMARY KEY,
    room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team SMALLINT NOT NULL CHECK (team IN (1, 2)),
    player_name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS match_results (
    room_id BIGINT PRIMARY KEY REFERENCES rooms(id),
    server_id TEXT NOT NULL REFERENCES game_servers(id),
    winning_team SMALLINT NOT NULL CHECK (winning_team IN (1, 2)),
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS player_match_results (
    room_id BIGINT NOT NULL REFERENCES match_results(room_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team SMALLINT NOT NULL CHECK (team IN (1, 2)),
    kills INTEGER NOT NULL CHECK (kills BETWEEN 0 AND 100),
    victory BOOLEAN NOT NULL,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS rooms_status_created_idx
    ON rooms (status, created_at);
CREATE INDEX IF NOT EXISTS join_tickets_room_idx
    ON join_tickets (room_id, expires_at);
`;
