"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GameRoom, ROOM_CAPACITY } = require("./game-room");

function player(userId, team = 1) {
    return {
        userId: String(userId),
        playerName: `Pilot${userId}`,
        team
    };
}

test("room capacity supports 32 players and rejects the next join", () => {
    const room = new GameRoom("room-1");
    for (let id = 1; id <= ROOM_CAPACITY; id++) {
        room.addPlayer(player(id, id % 2 === 0 ? 2 : 1));
    }

    assert.equal(room.snapshot().players.length, 32);
    assert.throws(() => room.addPlayer(player(33)), /full/);
});

test("room enforces team selection and one active connection per account", () => {
    const room = new GameRoom("room-2");
    room.addPlayer(player(1, 2));
    assert.equal(room.snapshot().players[0].team, 2);
    assert.throws(() => room.addPlayer(player(1)), /already connected/);
    assert.throws(
        () => room.addPlayer({ ...player(2), team: 3 }),
        /invalid/
    );
});

test("server clamps movement input and keeps players inside the arena", () => {
    const room = new GameRoom("room-3");
    room.addPlayer(player(1));
    assert.equal(room.setInput("1", {
        throttle: 500,
        steering: 0,
        fire: false
    }), true);

    for (let i = 0; i < 200; i++) {
        room.tick(0.1, 10_000 + i * 100);
    }

    const state = room.snapshot().players[0];
    assert.ok(state.x <= 100 && state.x >= -100);
    assert.ok(state.z <= 100 && state.z >= -100);
    assert.equal(room.setInput("1", {
        throttle: NaN,
        steering: 0,
        fire: false
    }), false);
});

test("movement follows tank acceleration and turns more slowly while reversing", () => {
    const room = new GameRoom("room-movement");
    room.addPlayer(player(1));
    room.setInput("1", {
        throttle: 1,
        steering: 0,
        fire: false
    });

    for (let tick = 0; tick < 5; tick++) {
        room.tick(0.1);
    }
    const moving = room.snapshot().players[0];
    assert.equal(moving.speed, 1);
    assert.ok(Math.abs(moving.x - (-23.7)) < 0.001);
    assert.equal(moving.z, -48);

    room.setInput("1", {
        throttle: -1,
        steering: 1,
        fire: false
    });
    const headingBeforeReverse = room.players.get("1").heading;
    room.tick(0.1);
    const reversed = room.players.get("1");
    assert.ok(Math.abs(reversed.heading - headingBeforeReverse - 4.5) < 0.001);
});

test("online movement applies the Abrams speed boost within the configured cap", () => {
    const room = new GameRoom("room-speed-boost");
    room.addPlayer(player(1));
    room.setInput("1", {
        throttle: 1,
        steering: 0,
        speedBoostAmount: 100,
        fire: false
    });

    for (let tick = 0; tick < 60; tick++) {
        room.tick(0.1);
    }

    assert.equal(room.players.get("1").speed, 11);
});

test("online shell speed and reload match the Abrams single-player settings", () => {
    const room = new GameRoom("room-abrams-shell-settings");
    room.addPlayer(player(1));
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90
    }, 10_000);

    const initialEvent = room.pendingEvents.find(event =>
        event.type === "playerFired"
    );
    assert.equal(initialEvent.cooldown, 3);

    const state = room.tick(0.05, 10_050);
    assert.ok(Math.abs(state.projectiles[0].x + 13.5) < 0.001);
});

test("online shell follows the reported muzzle position and direction", () => {
    const room = new GameRoom("room-muzzle-direction");
    room.addPlayer(player(1));
    const shooter = room.players.get("1");
    const muzzleHeading = 30 * Math.PI / 180;
    const muzzlePitch = -10 * Math.PI / 180;
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 0,
        aimPitch: 0,
        hasFireOrigin: true,
        fireOriginX: shooter.x,
        fireOriginY: 2.5,
        fireOriginZ: shooter.z + 4.89,
        hasFireDirection: true,
        fireDirectionX: Math.sin(muzzleHeading) * Math.cos(muzzlePitch),
        fireDirectionY: -Math.sin(muzzlePitch),
        fireDirectionZ: Math.cos(muzzleHeading) * Math.cos(muzzlePitch)
    }, 10_000);

    const state = room.tick(0.05, 10_050);
    const projectile = state.projectiles[0];

    assert.ok(Math.abs(projectile.heading - 30) < 0.001);
    assert.ok(Math.abs(projectile.pitch + 10) < 0.001);
    assert.ok(Math.abs(
        projectile.x -
        (shooter.x + Math.sin(muzzleHeading) *
            Math.cos(muzzlePitch) * 8)
    ) < 0.001);
    assert.ok(projectile.z > shooter.z + 4.89);
    assert.ok(projectile.y > 2.5);
});

test("server rejects invalid muzzle data", () => {
    const room = new GameRoom("room-invalid-muzzle");
    room.addPlayer(player(1));
    const shooter = room.players.get("1");
    const input = {
        throttle: 0,
        steering: 0,
        fire: true,
        hasFireOrigin: true,
        fireOriginX: shooter.x + 20,
        fireOriginY: 2,
        fireOriginZ: shooter.z,
        hasFireDirection: true,
        fireDirectionX: 0,
        fireDirectionY: 0,
        fireDirectionZ: 0
    };

    assert.equal(room.setInput("1", input, 10_000), false);
    assert.equal(room.projectiles.length, 0);

    assert.equal(room.setInput("1", {
        ...input,
        fireOriginX: shooter.x,
        fireDirectionY: 1
    }, 10_000), false);
    assert.equal(room.projectiles.length, 0);
});

test("server-side projectiles damage 200-health enemies and award a kill", () => {
    const room = new GameRoom("room-4");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const shooter = room.players.get("1");
    const target = room.players.get("2");
    shooter.x = 0;
    shooter.z = 0;
    shooter.heading = 90;
    target.x = 10;
    target.z = 0;

    let now = 10_000;
    for (let shot = 0; shot < 8; shot++) {
        room.setInput("1", {
            throttle: 0,
            steering: 0,
            fire: true
        }, now);
        for (let tick = 0; tick < 50; tick++) {
            room.tick(0.05, now + tick * 50);
        }
        now += 3200;
        room.setInput("1", {
            throttle: 0,
            steering: 0,
            fire: false
        }, now);
    }

    assert.equal(target.health, 0);
    assert.equal(target.alive, false);
    assert.equal(shooter.kills, 1);
    assert.equal(target.deaths, 1);
    assert.equal(room.snapshot().matchEnded, true);
    assert.equal(room.snapshot().winningTeam, shooter.team);

    room.tick(0.05, Number.MAX_SAFE_INTEGER);
    assert.equal(target.alive, false);
    assert.equal(target.health, 0);
});

test("tank collider prevents online tanks from passing through each other", () => {
    const room = new GameRoom("room-tank-collision");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const left = room.players.get("1");
    const right = room.players.get("2");
    left.x = 0;
    left.z = 0;
    left.heading = 0;
    right.x = 2;
    right.z = 0;
    right.heading = 0;

    room.tick(0.05);

    assert.ok(Math.abs(right.x - left.x) >= 2.41);
});

test("deployed drone colliding with a tank explodes and applies damage", () => {
    const room = new GameRoom("room-drone-collision");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const owner = room.players.get("1");
    const target = room.players.get("2");
    owner.droneActive = true;
    owner.droneFlying = true;
    owner.droneX = target.x;
    owner.droneY = 1;
    owner.droneZ = target.z;

    const state = room.tick(0.05, 20_000);

    assert.equal(owner.droneActive, false);
    assert.equal(owner.droneDestroyed, true);
    assert.equal(target.health, 100);
    assert.ok(state.events.some(event =>
        event.type === "droneCollision" &&
        event.userId === target.userId &&
        event.attackerId === owner.userId &&
        event.health === 100
    ));
});

test("drone launch and owner or teammate contact cannot cause damage", () => {
    const room = new GameRoom("room-drone-owner-team");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 1));
    room.addPlayer(player(3, 2));
    const owner = room.players.get("1");
    const teammate = room.players.get("2");
    const enemy = room.players.get("3");
    owner.x = 0;
    owner.z = 0;
    teammate.x = 0;
    teammate.z = 0;
    enemy.x = 80;
    enemy.z = 80;
    owner.droneActive = true;
    owner.droneX = 0;
    owner.droneY = 1;
    owner.droneZ = 0;

    room.tick(0.05, 20_000);
    assert.equal(owner.droneActive, true);
    assert.equal(owner.droneDestroyed, false);
    assert.equal(owner.health, 200);
    assert.equal(teammate.health, 200);
    assert.equal(enemy.health, 200);

    owner.droneFlying = true;
    room.tick(0.05, 20_050);
    assert.equal(owner.droneActive, true);
    assert.equal(owner.droneDestroyed, false);
    assert.equal(owner.health, 200);
    assert.equal(teammate.health, 200);
    assert.equal(enemy.health, 200);
});

test("server validates drone launch, flight state, and movement", () => {
    const room = new GameRoom("room-drone-validation");
    room.addPlayer(player(1, 1));
    const owner = room.players.get("1");
    const baseInput = {
        throttle: 0,
        steering: 0,
        fire: false,
        droneActive: true,
        droneX: owner.x,
        droneY: 1,
        droneZ: owner.z
    };

    assert.equal(room.setInput("1", {
        ...baseInput,
        droneX: owner.x + 11
    }, 10_000), true);
    assert.equal(owner.droneActive, false);
    assert.equal(room.setInput("1", baseInput, 10_000), true);
    assert.equal(room.setInput("1", {
        ...baseInput,
        throttle: 1,
        droneX: owner.x + 2
    }, 10_050), true);
    assert.equal(owner.droneX, owner.x);
    assert.equal(owner.throttle, 1);
    assert.equal(room.setInput("1", {
        ...baseInput,
        droneX: owner.x + 0.4,
        droneY: 1.1
    }, 10_050), true);
    assert.equal(room.setInput("1", {
        ...baseInput,
        droneX: owner.x + 0.4,
        droneY: 5.8,
        droneFlying: true
    }, 11_700), true);
    assert.equal(owner.droneFlying, false);
    assert.equal(room.setInput("1", {
        ...baseInput,
        droneX: owner.x + 0.4,
        droneY: 6,
        droneFlying: true
    }, 11_700), true);
    assert.equal(owner.droneFlying, true);
});

test("one server projectile damages only one tank once", () => {
    const room = new GameRoom("room-single-impact");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const shooter = room.players.get("1");
    const target = room.players.get("2");
    shooter.x = 0;
    shooter.z = 0;
    shooter.aimHeading = 90;
    target.x = 4;
    target.z = 0;

    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90
    }, 10_000);
    const hitState = room.tick(0.05, 10_050);
    assert.equal(target.health, 175);
    assert.equal(hitState.events.filter(event =>
        event.type === "playerHit"
    ).length, 1);
    assert.equal(hitState.projectiles.length, 0);

    room.tick(0.05, 10_100);
    assert.equal(target.health, 175);
});

test("a shell detonates on a friendly tank without damaging it", () => {
    const room = new GameRoom("room-friendly-shell-impact");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 1));
    const shooter = room.players.get("1");
    const teammate = room.players.get("2");
    shooter.x = 0;
    shooter.z = 0;
    shooter.aimHeading = 90;
    teammate.x = 4;
    teammate.z = 0;

    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90
    }, 10_000);
    const impactState = room.tick(0.05, 10_050);

    assert.equal(teammate.health, 200);
    assert.equal(room.projectiles.length, 0);
    assert.equal(impactState.events.filter(event =>
        event.type === "projectileImpact"
    ).length, 1);
    assert.equal(impactState.events.some(event =>
        event.type === "playerHit"
    ), false);
});

test("environment impact reports must match the owner's recent projectile path", () => {
    const room = new GameRoom("room-environment-shell-impact");
    room.addPlayer(player(1, 1));
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90
    }, 10_000);
    room.tick(0.05, 10_050);
    const projectile = room.projectiles[0];
    const validImpact = {
        projectileId: projectile.id,
        x: projectile.x - 2,
        y: projectile.y,
        z: projectile.z,
        normalX: -1,
        normalY: 0,
        normalZ: 0
    };
    const invalidImpact = {
        ...validImpact,
        x: 90
    };

    assert.equal(room.reportProjectileImpact("1", invalidImpact), false);
    assert.equal(room.projectiles.length, 1);
    assert.equal(room.reportProjectileImpact("2", validImpact), false);
    assert.equal(room.reportProjectileImpact("1", validImpact), true);
    assert.equal(room.reportProjectileImpact("1", validImpact), false);
    assert.equal(room.projectiles.length, 0);

    const impactState = room.tick(0.05, 10_100);
    assert.equal(impactState.events.filter(event =>
        event.type === "projectileImpact"
    ).length, 1);
    assert.equal(impactState.events[0].projectileId, projectile.id);
    assert.equal(impactState.events[0].normalX, -1);
});

test("shell contact is resolved against tank collider bounds", () => {
    const room = new GameRoom("room-tank-hitbox");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const shooter = room.players.get("1");
    const target = room.players.get("2");
    shooter.x = 0;
    shooter.z = 0;
    shooter.aimHeading = 90;
    target.x = 12;
    target.z = 0;
    target.heading = -90;

    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90
    }, 10_000);
    let event = null;
    for (let tick = 0; tick < 5 && !event; tick++) {
        const state = room.tick(0.05, 10_050 + tick * 50);
        event = state.events.find(item => item.type === "playerHit");
    }

    assert.ok(event);
    assert.equal(event.userId, target.userId);
    assert.ok(Math.abs(event.x - (target.x - 3.8)) < 0.01);
    assert.equal(target.health, 175);
});

test("networked shot starts at the tank fire point", () => {
    const room = new GameRoom("room-fire-origin");
    room.addPlayer(player(1));
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90,
        aimPitch: -5,
        hasFireOrigin: true,
        fireOriginX: -17.25,
        fireOriginY: 3.4,
        fireOriginZ: -45.8
    }, 10_000);

    const projectile = room.projectiles[0];
    assert.equal(projectile.x, -17.25);
    assert.equal(projectile.y, 3.4);
    assert.equal(projectile.z, -45.8);
});

test("server-side projectiles destroy an enemy player's deployed drone", () => {
    const room = new GameRoom("room-drone");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const shooter = room.players.get("1");
    const target = room.players.get("2");
    shooter.x = 0;
    shooter.z = 0;
    shooter.aimHeading = 90;
    shooter.aimPitch = 0;
    target.x = 50;
    target.droneActive = true;
    target.droneFlying = true;
    target.droneX = 5;
    target.droneY = 1.5;
    target.droneZ = 0;
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90,
        aimPitch: 0
    }, 10_000);

    const state = room.tick(0.05, 10_050);
    assert.equal(target.droneActive, false);
    assert.equal(target.droneDestroyed, true);
    assert.ok(state.events.some(event =>
        event.type === "droneHit" &&
        event.userId === "2" &&
        event.attackerId === "1"
    ));
});

test("a disconnect after both teams join awards victory without AI replacement", () => {
    const room = new GameRoom("room-disconnect-victory");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));

    assert.equal(room.removePlayer("2"), true);
    const state = room.snapshot();

    assert.equal(state.matchEnded, true);
    assert.equal(state.winningTeam, 1);
    assert.deepEqual(state.players.map(item => item.userId), ["1"]);
    assert.throws(() => room.addPlayer(player(3, 2)), /match has ended/);
});

test("a temporarily disconnected player remains in the room and stops moving", () => {
    const room = new GameRoom("room-reconnect-grace");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    room.setInput("2", {
        throttle: 1,
        steering: 0,
        fire: false
    });
    room.tick(0.1);
    const disconnectedPlayer = room.players.get("2");
    const positionBeforeDisconnect = {
        x: disconnectedPlayer.x,
        z: disconnectedPlayer.z
    };

    assert.equal(room.setPlayerConnected("2", false), true);
    assert.equal(room.snapshot().matchEnded, false);
    assert.equal(room.snapshot().players.find(item =>
        item.userId === "2"
    ).connected, false);
    room.tick(0.1);

    assert.equal(room.players.has("2"), true);
    assert.equal(disconnectedPlayer.x, positionBeforeDisconnect.x);
    assert.equal(disconnectedPlayer.z, positionBeforeDisconnect.z);
    assert.equal(disconnectedPlayer.speed, 0);

    assert.equal(room.setPlayerConnected("2", true), true);
    assert.equal(room.snapshot().players.find(item =>
        item.userId === "2"
    ).connected, true);
    assert.equal(room.snapshot().matchEnded, false);
});

test("simultaneously expired disconnected teams resolve as a draw", () => {
    const room = new GameRoom("room-disconnect-draw");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));

    assert.equal(room.removePlayer("1", false), true);
    assert.equal(room.removePlayer("2", false), true);
    room.checkForVictory();

    assert.equal(room.snapshot().matchEnded, true);
    assert.equal(room.snapshot().winningTeam, 0);
});

test("a one-team lobby does not resolve a PvP result", () => {
    const room = new GameRoom("room-one-team-lobby");
    room.addPlayer(player(1, 1));
    room.removePlayer("1");
    room.addPlayer(player(2, 2));

    assert.equal(room.matchStarted, false);
    assert.equal(room.snapshot().matchEnded, false);
    assert.equal(room.snapshot().players.length, 1);
});

test("simultaneous team elimination ends in a draw", () => {
    const room = new GameRoom("room-draw");
    room.addPlayer(player(1, 1));
    room.addPlayer(player(2, 2));
    const blue = room.players.get("1");
    const red = room.players.get("2");
    blue.x = 0;
    blue.z = 0;
    red.x = 4;
    red.z = 0;
    blue.health = 25;
    red.health = 25;

    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90
    }, 10_000);
    room.setInput("2", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 270
    }, 10_000);

    const state = room.tick(0.05, 10_050);
    assert.equal(blue.alive, false);
    assert.equal(red.alive, false);
    assert.equal(state.matchEnded, true);
    assert.equal(state.winningTeam, 0);
    assert.ok(state.events.some(event =>
        event.type === "matchEnded" && event.draw
    ));
});

test("projectile vertical travel matches Unity's cannon pitch direction", () => {
    const room = new GameRoom("room-projectile-pitch");
    room.addPlayer(player(1));
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 90,
        aimPitch: -20
    }, 10_000);

    const state = room.tick(0.05, 10_050);
    assert.equal(state.projectiles.length, 1);
    assert.ok(state.projectiles[0].y > 1.5);
});

test("one fire press creates one projectile until the button is released", () => {
    const room = new GameRoom("room-fire");
    room.addPlayer(player(1));
    const firstInput = {
        throttle: 0,
        steering: 0,
        fire: true,
        aimHeading: 123,
        aimPitch: 12
    };

    room.setInput("1", firstInput, 10_000);
    assert.equal(room.projectiles.length, 1);
    assert.deepEqual(room.pendingEvents[0], {
        type: "playerJoined",
        userId: "1",
        playerName: "Pilot1",
        team: 1
    });
    assert.equal(room.pendingEvents[1].type, "playerFired");

    room.setInput("1", firstInput, 12_999);
    assert.equal(room.projectiles.length, 1);
    room.setInput("1", { ...firstInput, fire: false }, 13_000);
    room.setInput("1", firstInput, 13_000);
    assert.equal(room.projectiles.length, 2);

    const state = room.tick(0.05, 13_050);
    assert.equal(state.players[0].aimHeading, 123);
    assert.equal(state.players[0].aimPitch, 12);
    assert.equal(state.projectiles[0].heading, 123);
    assert.equal(state.projectiles[0].pitch, 12);
    assert.equal(state.events.filter(event => event.type === "playerFired").length, 2);
});

test("projectile expiry does not create another shot while fire stays held", () => {
    const room = new GameRoom("room-fire-expiry");
    room.addPlayer(player(1));
    const input = {
        throttle: 0,
        steering: 0,
        fire: true
    };

    room.setInput("1", input, 10_000);
    assert.equal(room.projectiles.length, 1);
    for (let tick = 0; tick < 50; tick++) {
        room.tick(0.1, 10_100 + tick * 100);
    }

    assert.equal(room.projectiles.length, 0);
    assert.equal(room.setInput("1", input, 15_100), true);
    assert.equal(room.projectiles.length, 0);

    room.setInput("1", { ...input, fire: false }, 15_101);
    room.setInput("1", input, 15_102);
    assert.equal(room.projectiles.length, 1);
    assert.equal(room.projectiles[0].id, 2);
});

test("server movement follows its heading without lateral drift", () => {
    const room = new GameRoom("room-straight-movement");
    room.addPlayer(player(1));
    const tank = room.players.get("1");
    const initialZ = tank.z;
    room.setInput("1", {
        throttle: 1,
        steering: 0,
        fire: false
    }, 10_000);

    for (let tick = 0; tick < 20; tick++)
        room.tick(0.05, 10_050 + tick * 50);

    assert.ok(tank.x > -24);
    assert.equal(tank.z, initialZ);
    assert.equal(tank.heading, 90);
});

test("a disconnected player and their projectiles are removed", () => {
    const room = new GameRoom("room-5");
    room.addPlayer(player(1));
    room.setInput("1", {
        throttle: 0,
        steering: 0,
        fire: true
    }, 10_000);
    assert.equal(room.projectiles.length, 1);
    assert.equal(room.removePlayer("1"), true);
    assert.equal(room.removePlayer("1"), false);
    assert.equal(room.projectiles.length, 0);
    assert.equal(room.snapshot().players.length, 0);
});
