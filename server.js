const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const USERS_FILE = path.join(__dirname, 'users.json');

let users = {};
if (fs.existsSync(USERS_FILE)) {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
    catch (e) { users = {}; }
}

// Safe migration for existing profiles missing new fields
for (const u of Object.values(users)) {
    if (u.totalDiffSum === undefined) u.totalDiffSum = 0;
    if (u.maxStreak    === undefined) u.maxStreak    = 0;
    if (u.totalGames   === undefined) u.totalGames   = 0;
    if (u.totalWins    === undefined) u.totalWins    = 0;
}

function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function getRankTitle(totalWins) {
    if (totalWins >= 15) return 'ტაიმ მასტერი';
    if (totalWins >= 8)  return 'ქრონოსი';
    if (totalWins >= 3)  return 'დროის დეტექტივი';
    return 'დამწყები';
}

function buildProfilePayload(username) {
    const u = users[username];
    if (!u) return null;
    return {
        username,
        maxStreak:    u.maxStreak,
        totalGames:   u.totalGames,
        totalWins:    u.totalWins,
        totalDiffSum: u.totalDiffSum,
        avatar:       u.avatar || null,
    };
}

let rooms = {};

const systemChallenges = [
    'მიდი ნებისმიერ თანამშრომელთან, ჩაეხუტე და უთხარი, რომ მისი სურნელი მოგწონს.',
    'მომდევნო 1 წუთის განმავლობაში ყველას დაუძახე სიტყვა: ჩემო კარგო.',
    'შეჭამე ლიმონის ნაჭერი ისე, რომ სახე საერთოდ არ დაგემანჭოს.',
    'ადექი და კამერის წინ გააკეთე 10 აზიდვა.',
    'მომდევნო რაუნდში ისაუბრე მხოლოდ ჩურჩულით.',
    'დაურეკე ნებისმიერ მეგობარს და უთხარი, რომ სამსახურიდან წამოხვედი, მერე კი სასწრაფოდ გაუთიშე.',
    'განმარტე შენი ყველაზე მოულოდნელი ჩვევა.',
    'ყველა მოთამაშეს ასწავლე ერთი ახალი სიტყვა სხვა ენაზე.',
];

function generateRoomCode() {
    let code;
    do { code = Math.floor(1000 + Math.random() * 9000).toString(); }
    while (rooms[code]);
    return code;
}

function generateTargetTime() {
    return Math.random() < 0.75
        ? Math.floor(Math.random() * (14 - 1 + 1)) + 1
        : Math.floor(Math.random() * (30 - 15 + 1)) + 15;
}

function makePlayer(socketId, username, isHost) {
    return {
        id: socketId,
        name: username,
        isHost,
        ready: false,
        clickedTime: null,
        diff: null,
        currentStreak: 0,
        brokeStreak: false,
        previousStreakValue: 0,
    };
}

function playerLeaveRoom(socket) {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const wasInCounting = room.status === 'COUNTING';
    delete room.players[socket.id];
    socket.leave(code);
    delete socket.roomCode;

    if (Object.keys(room.players).length === 0) {
        delete rooms[code];
        return;
    }
    if (socket.id === room.hostId) {
        const newHostId = Object.keys(room.players)[0];
        room.hostId = newHostId;
        room.players[newHostId].isHost = true;
    }

    if (wasInCounting) {
        const remaining = Object.values(room.players);
        if (remaining.length > 0 && remaining.every(p => p.ready)) {
            resolveRound(code);
            return;
        }
    }

    io.to(code).emit('room_update', room);
}

io.on('connection', (socket) => {

    socket.on('register_user', ({ username, password, avatar }) => {
        if (!username || !password) {
            return socket.emit('auth_response', { success: false, error: 'შეიყვანეთ სახელი და პაროლი' });
        }
        if (users[username]) {
            return socket.emit('auth_response', { success: false, error: 'ეს სახელი უკვე დაკავებულია' });
        }
        users[username] = {
            password,
            maxStreak:    0,
            totalGames:   0,
            totalWins:    0,
            totalDiffSum: 0,
            avatar:       avatar || null,
        };
        saveUsers();
        socket.emit('auth_response', { success: true, user: buildProfilePayload(username) });
    });

    socket.on('login_user', ({ username, password }) => {
        const u = users[username];
        if (!u || u.password !== password) {
            return socket.emit('auth_response', { success: false, error: 'არასწორი სახელი ან პაროლი' });
        }
        socket.emit('auth_response', { success: true, user: buildProfilePayload(username) });
    });

    socket.on('create_room', ({ username }, cb) => {
        const code = generateRoomCode();
        rooms[code] = {
            code,
            status: 'LOBBY',
            hostId: socket.id,
            challengeType: 'system',
            challengeText: '',
            targetTime: 0,
            players: {},
            lastWinnerName: null,
            lastLoserName: null,
        };
        socket.join(code);
        socket.roomCode = code;
        rooms[code].players[socket.id] = makePlayer(socket.id, username, true);
        cb({ code });
        io.to(code).emit('room_update', rooms[code]);
    });

    socket.on('join_room', ({ username, code }, cb) => {
        const room = rooms[code];
        if (!room) return cb({ error: 'ოთახი ვერ მოიძებნა' });
        if (room.status !== 'LOBBY') return cb({ error: 'თამაში უკვე მიმდინარეობს' });
        socket.join(code);
        socket.roomCode = code;
        room.players[socket.id] = makePlayer(socket.id, username, false);
        cb({ ok: true });
        io.to(code).emit('room_update', room);
    });

    socket.on('leave_room', () => playerLeaveRoom(socket));

    socket.on('set_challenge', ({ type, text }) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        if (Object.keys(room.players).length < 2) return;
        room.challengeType = type;
        room.challengeText = type === 'system'
            ? systemChallenges[Math.floor(Math.random() * systemChallenges.length)]
            : text;
        room.targetTime = generateTargetTime();
        room.status = 'ROUND_SETUP';
        for (const id in room.players) {
            room.players[id].ready      = false;
            room.players[id].clickedTime = null;
            room.players[id].diff        = null;
        }
        io.to(socket.roomCode).emit('room_update', room);
    });

    socket.on('start_round', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        if (Object.keys(room.players).length < 2) return;
        room.status = 'COUNTING';
        io.to(socket.roomCode).emit('room_update', room);
    });

    socket.on('stop_timer', (elapsedTime) => {
        const room = rooms[socket.roomCode];
        if (!room || room.status !== 'COUNTING') return;
        const player = room.players[socket.id];
        if (player && !player.ready) {
            player.clickedTime = parseFloat(elapsedTime.toFixed(2));
            player.diff        = parseFloat(Math.abs(player.clickedTime - room.targetTime).toFixed(2));
            player.ready       = true;
            const allReady = Object.values(room.players).every(p => p.ready);
            if (allReady) resolveRound(socket.roomCode);
            else io.to(socket.roomCode).emit('room_update', room);
        }
    });

    socket.on('next_round', () => {
        const room = rooms[socket.roomCode];
        if (!room || socket.id !== room.hostId) return;
        room.status     = 'ROUND_SETUP';
        room.targetTime = generateTargetTime();
        if (room.challengeType === 'system') {
            room.challengeText = systemChallenges[Math.floor(Math.random() * systemChallenges.length)];
        }
        for (const id in room.players) {
            const p      = room.players[id];
            p.ready      = false;
            p.clickedTime = null;
            p.diff        = null;
            p.brokeStreak = false;
        }
        io.to(socket.roomCode).emit('room_update', room);
    });

    socket.on('disconnect', () => playerLeaveRoom(socket));
});

function resolveRound(code) {
    const room = rooms[code];
    if (!room) return;
    room.status = 'RESULTS';
    const arr = Object.values(room.players);
    if (arr.length === 0) return;

    let winner = arr[0];
    let loser  = arr[0];
    arr.forEach(p => {
        if (p.diff < winner.diff) winner = p;
        if (p.diff > loser.diff)  loser  = p;
    });

    arr.forEach(p => {
        const u = users[p.name];

        if (u) {
            u.totalGames++;
            // Accumulate precision deviation for every completed round
            if (p.diff !== null) u.totalDiffSum = parseFloat(((u.totalDiffSum || 0) + p.diff).toFixed(2));
        }

        if (p.id === winner.id) {
            p.currentStreak++;
            p.brokeStreak = false;
            if (u) {
                u.totalWins++;
                if (p.currentStreak > u.maxStreak) u.maxStreak = p.currentStreak;
            }
        } else {
            if (p.currentStreak >= 2) {
                p.brokeStreak = true;
                p.previousStreakValue = p.currentStreak;
            } else {
                p.brokeStreak = false;
            }
            p.currentStreak = 0;
        }
    });

    saveUsers();
    room.lastWinnerName = winner.name;
    room.lastLoserName  = loser.name;
    io.to(code).emit('room_update', room);

    arr.forEach(p => {
        const payload = buildProfilePayload(p.name);
        if (payload) io.to(p.id).emit('profile_update', payload);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
