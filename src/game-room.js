"use strict";

const ROOM_CAPACITY = 32;
const MAX_WORLD_COORDINATE = 100;
const MAX_SPEED_BOOST = 5;
const TANK_HALF_WIDTH = 1.21;
const TANK_HALF_LENGTH = 3.45;
const TANK_COLLIDER_HEIGHT = 3.2;
const DRONE_COLLISION_RADIUS = 1.2;
const DRONE_COLLISION_DAMAGE = 100;
const FORWARD_SPEED = 6;
const REVERSE_SPEED = 3;
const ACCELERATION = 2;
const DECELERATION = 3;
const TURN_SPEED = 45;
const PROJECTILE_SPEED = 160;
const PROJECTILE_DAMAGE = 25;
const PROJECTILE_RANGE = 800;
const FIRE_COOLDOWN_MS = 3000;
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
            speedBoostAmount: 0,
            speed: 0,
            droneActive: false,
            droneDestroyed: false,
            droneX: 0,
            droneY: 0,
            droneZ: 0,
            health: 200,
            kills: 0,
            deaths: 0,
            alive: true,
            respawnAt: 0,
            lastFireAt: 0,
            fireInputPressed: false
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
            (input.speedBoostAmount !== undefined &&
                (typeof input.speedBoostAmount !== "number" ||
                    !Number.isFinite(input.speedBoostAmount))) ||
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
        player.speedBoostAmount = player.alive
            ? clamp(input.speedBoostAmount || 0, 0, MAX_SPEED_BOOST)
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

        const firePressed = input.fire && !player.fireInputPressed;
        player.fireInputPressed = input.fire;
        if (player.alive && firePressed &&
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
            const boostedTargetSpeed =
                Math.abs(player.throttle) > 0.01
                    ? targetSpeed +
                        Math.sign(player.throttle) *
                            player.speedBoostAmount
                    : targetSpeed;
            const accelerating =
                Math.abs(boostedTargetSpeed) > Math.abs(player.speed) &&
                (Math.sign(boostedTargetSpeed) === Math.sign(player.speed) ||
                    Math.abs(player.speed) < 0.01);
            const speedChange = (accelerating ? ACCELERATION : DECELERATION) *
                delta;
            if (player.speed < boostedTargetSpeed) {
                player.speed = Math.min(
                    boostedTargetSpeed,
                    player.speed + speedChange
                );
            } else if (player.speed > boostedTargetSpeed) {
                player.speed = Math.max(
                    boostedTargetSpeed,
                    player.speed - speedChange
                );
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

        this.resolveTankCollisions();
        this.resolveDroneCollisions(now);
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
            const previousPosition = {
                x: projectile.x,
                y: projectile.y,
                z: projectile.z
            };
            const radians = projectile.heading * Math.PI / 180;
            const distance = PROJECTILE_SPEED * delta;
            projectile.x += Math.sin(radians) * distance;
            projectile.z += Math.cos(radians) * distance;
            projectile.y -= Math.sin(projectile.pitch * Math.PI / 180) *
                distance;
            projectile.distance += distance;

            let target = null;
            let impact = null;
            for (const player of this.players.values()) {
                if (!player.alive || player.team === projectile.team)
                    continue;
                const contact = getTankSegmentContact(
                    previousPosition,
                    projectile,
                    player
                );
                if (contact) {
                    target = player;
                    impact = contact;
                    break;
                }
            }
            if (target) {
                target.health = Math.max(0, target.health - PROJECTILE_DAMAGE);
                this.pendingEvents.push({
                    type: "playerHit",
                    userId: target.userId,
                    attackerId: projectile.ownerId,
                    health: target.health,
                    x: round(impact.x),
                    y: round(impact.y),
                    z: round(impact.z),
                    projectileId: projectile.id
                });
                this.handleTankDestroyed(target, projectile.ownerId, now);
                continue;
            }

            let droneTarget = null;
            let droneImpact = null;
            for (const player of this.players.values()) {
                if (!player.droneActive || player.droneDestroyed ||
                    player.team === projectile.team) {
                    continue;
                }
                const contact = getSegmentSphereContact(
                    previousPosition,
                    projectile,
                    {
                        x: player.droneX,
                        y: player.droneY,
                        z: player.droneZ
                    },
                    2.5
                );
                if (contact) {
                    droneTarget = player;
                    droneImpact = contact;
                    break;
                }
            }
            if (droneTarget) {
                droneTarget.droneActive = false;
                droneTarget.droneDestroyed = true;
                this.pendingEvents.push({
                    type: "droneHit",
                    userId: droneTarget.userId,
                    attackerId: projectile.ownerId,
                    x: round(droneImpact.x),
                    y: round(droneImpact.y),
                    z: round(droneImpact.z),
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
        player.health = 200;
        player.throttle = 0;
        player.steering = 0;
        player.speed = 0;
        player.speedBoostAmount = 0;
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

    resolveTankCollisions() {
        const players = [...this.players.values()].filter(player =>
            player.alive
        );
        for (let pass = 0; pass < 2; pass++) {
            for (let leftIndex = 0; leftIndex < players.length; leftIndex++) {
                for (let rightIndex = leftIndex + 1;
                    rightIndex < players.length;
                    rightIndex++) {
                    separateTankBodies(
                        players[leftIndex],
                        players[rightIndex]
                    );
                }
            }
        }
    }

    resolveDroneCollisions(now) {
        for (const owner of this.players.values()) {
            if (!owner.alive || !owner.droneActive ||
                owner.droneDestroyed) {
                continue;
            }
            const target = [...this.players.values()].find(player =>
                player.alive &&
                tankIntersectsDrone(player, owner)
            );
            if (!target)
                continue;

            owner.droneActive = false;
            owner.droneDestroyed = true;
            target.health = Math.max(
                0,
                target.health - DRONE_COLLISION_DAMAGE
            );
            this.pendingEvents.push({
                type: "droneCollision",
                userId: target.userId,
                attackerId: owner.userId,
                health: target.health,
                x: round(owner.droneX),
                y: round(owner.droneY),
                z: round(owner.droneZ)
            });
            this.handleTankDestroyed(target, owner.userId, now);
        }
    }

    handleTankDestroyed(target, attackerId, now) {
        if (target.health > 0 || !target.alive)
            return;

        target.alive = false;
        target.droneActive = false;
        target.speedBoostAmount = 0;
        target.deaths++;
        target.respawnAt = now + RESPAWN_DELAY_MS;
        const attacker = this.players.get(attackerId);
        if (attacker)
            attacker.kills++;
        this.pendingEvents.push({
            type: "playerDestroyed",
            userId: target.userId,
            attackerId: attacker ? attacker.userId : ""
        });
    }
}

function tankAxes(tank) {
    const radians = tank.heading * Math.PI / 180;
    return {
        forward: { x: Math.sin(radians), z: Math.cos(radians) },
        right: { x: Math.cos(radians), z: -Math.sin(radians) }
    };
}

function dot2(left, right) {
    return left.x * right.x + left.z * right.z;
}

function tankProjectionRadius(tank, axis) {
    const axes = tankAxes(tank);
    return TANK_HALF_LENGTH * Math.abs(dot2(axes.forward, axis)) +
        TANK_HALF_WIDTH * Math.abs(dot2(axes.right, axis));
}

function separateTankBodies(left, right) {
    const delta = { x: right.x - left.x, z: right.z - left.z };
    const leftAxes = tankAxes(left);
    const rightAxes = tankAxes(right);
    const axes = [
        leftAxes.forward,
        leftAxes.right,
        rightAxes.forward,
        rightAxes.right
    ];
    let minimumOverlap = Number.POSITIVE_INFINITY;
    let separationAxis = null;
    for (const axis of axes) {
        const overlap = tankProjectionRadius(left, axis) +
            tankProjectionRadius(right, axis) -
            Math.abs(dot2(delta, axis));
        if (overlap <= 0)
            return;
        if (overlap < minimumOverlap) {
            minimumOverlap = overlap;
            separationAxis = axis;
        }
    }

    const direction = dot2(delta, separationAxis) >= 0 ? 1 : -1;
    const offset = minimumOverlap * 0.5 + 0.001;
    left.x = clamp(
        left.x - separationAxis.x * direction * offset,
        -MAX_WORLD_COORDINATE,
        MAX_WORLD_COORDINATE
    );
    left.z = clamp(
        left.z - separationAxis.z * direction * offset,
        -MAX_WORLD_COORDINATE,
        MAX_WORLD_COORDINATE
    );
    right.x = clamp(
        right.x + separationAxis.x * direction * offset,
        -MAX_WORLD_COORDINATE,
        MAX_WORLD_COORDINATE
    );
    right.z = clamp(
        right.z + separationAxis.z * direction * offset,
        -MAX_WORLD_COORDINATE,
        MAX_WORLD_COORDINATE
    );
    left.speed = 0;
    right.speed = 0;
}

function getTankSegmentContact(start, end, tank) {
    const axes = tankAxes(tank);
    const startDelta = {
        x: start.x - tank.x,
        z: start.z - tank.z
    };
    const endDelta = {
        x: end.x - tank.x,
        z: end.z - tank.z
    };
    const startLocal = [
        dot2(startDelta, axes.forward),
        dot2(startDelta, axes.right),
        start.y
    ];
    const endLocal = [
        dot2(endDelta, axes.forward),
        dot2(endDelta, axes.right),
        end.y
    ];
    const minimum = [
        -TANK_HALF_LENGTH - 0.35,
        -TANK_HALF_WIDTH - 0.35,
        -0.25
    ];
    const maximum = [
        TANK_HALF_LENGTH + 0.35,
        TANK_HALF_WIDTH + 0.35,
        TANK_COLLIDER_HEIGHT + 0.25
    ];
    let entry = 0;
    let exit = 1;
    for (let axis = 0; axis < startLocal.length; axis++) {
        const direction = endLocal[axis] - startLocal[axis];
        if (Math.abs(direction) < 0.000001) {
            if (startLocal[axis] < minimum[axis] ||
                startLocal[axis] > maximum[axis]) {
                return null;
            }
            continue;
        }
        let near = (minimum[axis] - startLocal[axis]) / direction;
        let far = (maximum[axis] - startLocal[axis]) / direction;
        if (near > far)
            [near, far] = [far, near];
        entry = Math.max(entry, near);
        exit = Math.min(exit, far);
        if (entry > exit)
            return null;
    }

    const fraction = clamp(entry, 0, 1);
    return {
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
        z: start.z + (end.z - start.z) * fraction
    };
}

function tankIntersectsDrone(tank, droneOwner) {
    const axes = tankAxes(tank);
    const delta = {
        x: droneOwner.droneX - tank.x,
        z: droneOwner.droneZ - tank.z
    };
    const localForward = dot2(delta, axes.forward);
    const localRight = dot2(delta, axes.right);
    const closestForward = clamp(
        localForward,
        -TANK_HALF_LENGTH,
        TANK_HALF_LENGTH
    );
    const closestRight = clamp(
        localRight,
        -TANK_HALF_WIDTH,
        TANK_HALF_WIDTH
    );
    const closestY = clamp(droneOwner.droneY, 0, TANK_COLLIDER_HEIGHT);
    const dx = localForward - closestForward;
    const dz = localRight - closestRight;
    const dy = droneOwner.droneY - closestY;
    return dx * dx + dy * dy + dz * dz <=
        DRONE_COLLISION_RADIUS * DRONE_COLLISION_RADIUS;
}

function getSegmentSphereContact(start, end, center, radius) {
    const segment = {
        x: end.x - start.x,
        y: end.y - start.y,
        z: end.z - start.z
    };
    const lengthSquared =
        segment.x * segment.x +
        segment.y * segment.y +
        segment.z * segment.z;
    const fraction = lengthSquared > 0
        ? clamp(
            ((center.x - start.x) * segment.x +
                (center.y - start.y) * segment.y +
                (center.z - start.z) * segment.z) / lengthSquared,
            0,
            1
        )
        : 0;
    const contact = {
        x: start.x + segment.x * fraction,
        y: start.y + segment.y * fraction,
        z: start.z + segment.z * fraction
    };
    const dx = center.x - contact.x;
    const dy = center.y - contact.y;
    const dz = center.z - contact.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius
        ? contact
        : null;
}

function round(value) {
    return Math.round(value * 100) / 100;
}

module.exports = {
    GameRoom,
    ROOM_CAPACITY
};
