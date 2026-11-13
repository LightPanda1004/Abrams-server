"use strict";

const ROOM_CAPACITY = 32;
const MAX_WORLD_COORDINATE = 100;
const FORWARD_SPEED = 6;
const REVERSE_SPEED = 3;
const ACCELERATION = 2;
const DECELERATION = 3;
const TURN_SPEED = 45;
const PROJECTILE_SPEED = 42;
const PROJECTILE_DAMAGE = 25;
const PROJECTILE_RANGE = 80;
const FIRE_COOLDOWN_MS = 1800;
const RESPAWN_DELAY_MS = 3500;

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

class GameRoom {
    constructor(roomId, capacity = ROOM_CAPACITY) {
        if (typeof roomId !== "string" || !roomId) {
            throw new TypeError("A room id is required.");
        }
        if (!Number.isInteger(capacity) || capacity < 2 ||
            capacity > ROOM_CAPACITY) {
            throw new RangeError(`Room capacity must be between 2 and ${ROOM_CAPACITY}.`);
        }

        this.roomId = roomId;
        this.capacity = capacity;
        this.players = new Map();
        this.projectiles = [];
        this.pendingEvents = [];
        this.nextProjectileId = 1;
    }

    addPlayer({ userId, playerName, team }) {
        if (typeof userId !== "string" || !/^[1-9]\d{0,18}$/.test(userId) ||
            typeof playerName !== "string" || !playerName ||
            (team !== 1 && team !== 2)) {
            throw new TypeError("Player identity, name, or team is invalid.");
        }
        if (this.players.has(userId)) {
            throw new Error("This player is already connected to the room.");
        }
        if (this.players.size >= this.capacity) {
            throw new Error("The room is full.");
        }

        const teamPlayers = [...this.players.values()]
            .filter(player => player.team === team).length;
        const spawnX = team === 1 ? -24 : 24;
        const player = {
            userId,
            playerName,
            team,
            x: spawnX,
            z: (teamPlayers - (this.capacity / 4)) * 6,
            heading: team === 1 ? 90 : -90,
            aimHeading: team === 1 ? 90 : -90,
            aimPitch: 0,
            throttle: 0,
            steering: 0,
            speed: 0,
            droneActive: false,
            droneDestroyed: false,
            droneX: 0,
            droneY: 0,
            droneZ: 0,
            health: 100,
            kills: 0,
            deaths: 0,
            alive: true,
            respawnAt: 0,
            lastFireAt: 0
        };
        this.players.set(userId, player);
        this.pendingEvents.push({
            type: "playerJoined",
            userId,
            playerName,
            team
        });
        return this.snapshot();
    }

    removePlayer(userId) {
        const player = this.players.get(userId);
        if (!player) {
            return false;
        }
        this.players.delete(userId);
        this.projectiles = this.projectiles.filter(
            projectile => projectile.ownerId !== userId
        );
        this.pendingEvents.push({ type: "playerLeft", userId });
        return true;
    }

    setInput(userId, input, now = Date.now()) {
        const player = this.players.get(userId);
        if (!player || !input || typeof input !== "object" ||
            Array.isArray(input) ||
            typeof input.throttle !== "number" ||
            typeof input.steering !== "number" ||
            typeof input.fire !== "boolean" ||
            !Number.isFinite(input.throttle) ||
            !Number.isFinite(input.steering) ||
            (input.aimHeading !== undefined &&
                (typeof input.aimHeading !== "number" ||
                    !Number.isFinite(input.aimHeading))) ||
            (input.aimPitch !== undefined &&
                (typeof input.aimPitch !== "number" ||
                    !Number.isFinite(input.aimPitch))) ||
            (input.hasFireOrigin !== undefined &&
                typeof input.hasFireOrigin !== "boolean") ||
            (input.hasFireOrigin === true &&
                [input.fireOriginX, input.fireOriginY, input.fireOriginZ]
                    .some(value =>
                        typeof value !== "number" ||
                        !Number.isFinite(value))) ||
            (input.droneActive !== undefined &&
                typeof input.droneActive !== "boolean") ||
            (input.droneActive === true &&
                [input.droneX, input.droneY, input.droneZ].some(value =>
                    typeof value !== "number" || !Number.isFinite(value)))) {
            return false;
        }

        player.throttle = player.alive
            ? clamp(input.throttle, -1, 1)
            : 0;
        player.steering = player.alive
            ? clamp(input.steering, -1, 1)
            : 0;
        if (Number.isFinite(input.aimHeading)) {
            player.aimHeading =
                ((input.aimHeading % 360) + 360) % 360;
        }
        if (Number.isFinite(input.aimPitch)) {
            player.aimPitch = clamp(input.aimPitch, -20, 45);
        }
        if (typeof input.droneActive === "boolean" &&
            !player.droneDestroyed) {
            player.droneActive = input.droneActive;
        }
        if (player.droneActive) {
            player.droneX = clamp(input.droneX, -MAX_WORLD_COORDINATE,
                MAX_WORLD_COORDINATE);
            player.droneY = clamp(input.droneY, 0, MAX_WORLD_COORDINATE);
            player.droneZ = clamp(input.droneZ, -MAX_WORLD_COORDINATE,
                MAX_WORLD_COORDINATE);
        }

        if (player.alive && input.fire &&
            now - player.lastFireAt >= FIRE_COOLDOWN_MS) {
            player.lastFireAt = now;
            const projectile = this.createProjectile(player, now, input);
            this.projectiles.push(projectile);
            this.pendingEvents.push({
                type: "playerFired",
                userId,
                projectileId: projectile.id,
                cooldown: FIRE_COOLDOWN_MS / 1000
            });
        }
        return true;
    }

    tick(deltaSeconds, now = Date.now()) {
        const delta = clamp(deltaSeconds, 0, 0.1);
        for (const player of this.players.values()) {
            if (!player.alive) {
                if (now >= player.respawnAt) {
                    this.respawn(player);
                }
                continue;
            }

            const targetSpeed = player.throttle >= 0
                ? player.throttle * FORWARD_SPEED
                : player.throttle * REVERSE_SPEED;
            const accelerating =
                Math.abs(targetSpeed) > Math.abs(player.speed) &&
                (Math.sign(targetSpeed) === Math.sign(player.speed) ||
                    Math.abs(player.speed) < 0.01);
            const speedChange = (accelerating ? ACCELERATION : DECELERATION) *
                delta;
            if (player.speed < targetSpeed) {
                player.speed = Math.min(targetSpeed, player.speed + speedChange);
            } else if (player.speed > targetSpeed) {
                player.speed = Math.max(targetSpeed, player.speed - speedChange);
            }

            const direction = player.speed < -0.01 ? -1 : 1;
            player.heading = ((player.heading +
                player.steering * TURN_SPEED * direction * delta) % 360 + 360) % 360;
            const radians = player.heading * Math.PI / 180;
            player.x = clamp(
                player.x + Math.sin(radians) * player.speed * delta,
                -MAX_WORLD_COORDINATE,
                MAX_WORLD_COORDINATE
            );
            player.z = clamp(
                player.z + Math.cos(radians) * player.speed * delta,
                -MAX_WORLD_COORDINATE,
                MAX_WORLD_COORDINATE
            );
        }

        this.advanceProjectiles(delta, now);
        const events = this.pendingEvents;
        this.pendingEvents = [];
        return {
            type: "state",
            roomId: this.roomId,
            players: [...this.players.values()].map(player => ({
                userId: player.userId,
                playerName: player.playerName,
                team: player.team,
                x: round(player.x),
                z: round(player.z),
                heading: round(player.heading),
                aimHeading: round(player.aimHeading),
                aimPitch: round(player.aimPitch),
                speed: round(player.speed),
                droneActive: player.droneActive,
                droneDestroyed: player.droneDestroyed,
                droneX: round(player.droneX),
                droneY: round(player.droneY),
                droneZ: round(player.droneZ),
                health: player.health,
                kills: player.kills,
                deaths: player.deaths,
                alive: player.alive
            })),
            projectiles: this.projectiles.map(projectile => ({
                id: projectile.id,
                ownerId: projectile.ownerId,
                x: round(projectile.x),
                y: round(projectile.y),
                z: round(projectile.z),
                heading: round(projectile.heading),
                pitch: round(projectile.pitch)
            })),
            events
        };
    }

    snapshot() {
        return {
            type: "state",
            roomId: this.roomId,
            players: [...this.players.values()].map(player => ({
                userId: player.userId,
                playerName: player.playerName,
                team: player.team,
                x: round(player.x),
                z: round(player.z),
                heading: round(player.heading),
                aimHeading: round(player.aimHeading),
                aimPitch: round(player.aimPitch),
                speed: round(player.speed),
                droneActive: player.droneActive,
                droneDestroyed: player.droneDestroyed,
                droneX: round(player.droneX),
                droneY: round(player.droneY),
                droneZ: round(player.droneZ),
                health: player.health,
                kills: player.kills,
                deaths: player.deaths,
                alive: player.alive
            })),
            projectiles: [],
            events: []
        };
    }

    createProjectile(player, now, input = {}) {
        const radians = player.aimHeading * Math.PI / 180;
        return {
            id: this.nextProjectileId++,
            ownerId: player.userId,
            team: player.team,
            x: input.hasFireOrigin === true
                ? clamp(input.fireOriginX, -MAX_WORLD_COORDINATE - 10,
                    MAX_WORLD_COORDINATE + 10)
                : player.x + Math.sin(radians) * 2.5,
            z: input.hasFireOrigin === true
                ? clamp(input.fireOriginZ, -MAX_WORLD_COORDINATE - 10,
                    MAX_WORLD_COORDINATE + 10)
                : player.z + Math.cos(radians) * 2.5,
            heading: player.aimHeading,
            pitch: player.aimPitch,
            y: input.hasFireOrigin === true
                ? clamp(input.fireOriginY, -10, 50)
                : 1.5,
            distance: 0,
            createdAt: now
        };
    }

    advanceProjectiles(delta, now) {
        const remaining = [];
        for (const projectile of this.projectiles) {
            const radians = projectile.heading * Math.PI / 180;
            const distance = PROJECTILE_SPEED * delta;
            projectile.x += Math.sin(radians) * distance;
            projectile.z += Math.cos(radians) * distance;
            projectile.y -= Math.sin(projectile.pitch * Math.PI / 180) *
                distance;
            projectile.distance += distance;

            const target = [...this.players.values()].find(player =>
                player.alive &&
                player.team !== projectile.team &&
                squaredDistance(player, projectile) <= 2.5 * 2.5
            );
            if (target) {
                target.health = Math.max(0, target.health - PROJECTILE_DAMAGE);
                this.pendingEvents.push({
                    type: "playerHit",
                    userId: target.userId,
                    attackerId: projectile.ownerId,
                    health: target.health,
                    x: round(projectile.x),
                    y: round(projectile.y),
                    z: round(projectile.z),
                    projectileId: projectile.id
                });
                if (target.health === 0) {
                    target.alive = false;
                    target.droneActive = false;
                    target.deaths++;
                    target.respawnAt = now + RESPAWN_DELAY_MS;
                    const attacker = this.players.get(projectile.ownerId);
                    if (attacker) {
                        attacker.kills++;
                    }
                    this.pendingEvents.push({
                        type: "playerDestroyed",
                        userId: target.userId,
                        attackerId: attacker ? attacker.userId : ""
                    });
                }
                continue;
            }

            const droneTarget = [...this.players.values()].find(player =>
                player.droneActive &&
                !player.droneDestroyed &&
                player.team !== projectile.team &&
                squaredDroneDistance(player, projectile) <= 2.5 * 2.5
            );
            if (droneTarget) {
                droneTarget.droneActive = false;
                droneTarget.droneDestroyed = true;
                this.pendingEvents.push({
                    type: "droneHit",
                    userId: droneTarget.userId,
                    attackerId: projectile.ownerId,
                    x: round(projectile.x),
                    y: round(projectile.y),
                    z: round(projectile.z),
                    projectileId: projectile.id
                });
                continue;
            }

            if (projectile.distance < PROJECTILE_RANGE) {
                remaining.push(projectile);
            }
        }
        this.projectiles = remaining;
    }

    respawn(player) {
        player.alive = true;
        player.health = 100;
        player.throttle = 0;
        player.steering = 0;
        player.speed = 0;
        player.x = player.team === 1 ? -24 : 24;
        player.z = 0;
        player.heading = player.team === 1 ? 90 : -90;
        player.aimHeading = player.heading;
        player.aimPitch = 0;
        player.respawnAt = 0;
        this.pendingEvents.push({
            type: "playerRespawned",
            userId: player.userId
        });
    }
}

function squaredDistance(left, right) {
    const dx = left.x - right.x;
    const dz = left.z - right.z;
    return dx * dx + dz * dz;
}

function squaredDroneDistance(player, projectile) {
    const dx = player.droneX - projectile.x;
    const dy = player.droneY - projectile.y;
    const dz = player.droneZ - projectile.z;
    return dx * dx + dy * dy + dz * dz;
}

function round(value) {
    return Math.round(value * 100) / 100;
}

module.exports = {
    GameRoom,
    ROOM_CAPACITY
};
