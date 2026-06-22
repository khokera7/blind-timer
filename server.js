const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const mongoose  = require('mongoose');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/ping', (req, res) => res.send('OK'));

// ---- DATABASE ----
const MONGO_URI =
    'mongodb+srv://aleksandrekhokerashvili_db_user:QWLibnpv7LZ4KiPu@cluster0.z0pxavb.mongodb.net/blind_timer?appName=Cluster0';

mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB initial connection error:', err));

mongoose.connection.on('error', err => console.error('MongoDB error:', err));
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));

const userSchema = new mongoose.Schema({
    username:     { type: String, required: true, unique: true },
    password:     { type: String, required: true },
    maxStreak:    { type: Number, default: 0 },
    totalGames:   { type: Number, default: 0 },
    totalWins:    { type: Number, default: 0 },
    totalDiffSum: { type: Number, default: 0 },
    avatar:       { type: String, default: null },
});

const User = mongoose.model('User', userSchema);

// ---- HELPERS ----
function getRankTitle(totalWins) {
    if (totalWins >= 15) return 'ტაიმ მასტერი';
    if (totalWins >= 8)  return 'ქრონოსი';
    if (totalWins >= 3)  return 'დროის დეტექტივი';
    return 'დამწყები';
}

function buildProfilePayload(user) {
    return {
        username:     user.username,
        maxStreak:    user.maxStreak,
        totalGames:   user.totalGames,
        totalWins:    user.totalWins,
        totalDiffSum: user.totalDiffSum,
        avatar:       user.avatar || null,
    };
}

// ---- ROOM STATE (in-memory) ----
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

    // Auto-resolve if the disconnecting player was the last one everyone was waiting on
    if (wasInCounting) {
        const remaining = Object.values(room.players);
        if (remaining.length > 0 && remaining.every(p => p.ready)) {
            resolveRound(code).catch(err => console.error('resolveRound error after disconnect:', err));
            return;
        }
    }

    io.to(code).emit('room_update', room);
}

// ---- SOCKET HANDLERS ----
io.on('connection', (socket) => {

    socket.on('register_user', async (data) => {
        console.log('User registering:', data?.username);
        const { username, password, avatar } = data || {};
        if (!username || !password) {
            return socket.emit('auth_response', { success: false, error: 'შეიყვანეთ სახელი და პაროლი' });
        }
        try {
            const existing = await User.findOne({ username });
            if (existing) {
                return socket.emit('auth_response', { success: false, error: 'ეს სახელი უკვე დაკავებულია' });
            }
            const user = new User({ username, password, avatar: avatar || null });
            await user.save();
            console.log('Registered new user:', username);
            socket.emit('auth_response', { success: true, user: buildProfilePayload(user) });
        } catch (err) {
            console.error('register_user error:', err.message);
            socket.emit('auth_response', { success: false, error: 'სერვერის შეცდომა' });
        }
    });

    socket.on('login_user', async (data) => {
        console.log('User logging in:', data?.username);
        const { username, password } = data || {};
        if (!username || !password) {
            return socket.emit('auth_response', { success: false, error: 'შეიყვანეთ სახელი და პაროლი' });
        }
        try {
            const user = await User.findOne({ username });
            if (!user || user.password !== password) {
                return socket.emit('auth_response', { success: false, error: 'არასწორი სახელი ან პაროლი' });
            }
            console.log('Login successful:', username);
            socket.emit('auth_response', { success: true, user: buildProfilePayload(user) });
        } catch (err) {
            console.error('login_user error:', err.message);
            socket.emit('auth_response', { success: false, error: 'სერვერის შეცდომა' });
        }
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
            room.players[id].ready       = false;
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

    socket.on('stop_timer', async (elapsedTime) => {
        const room = rooms[socket.roomCode];
        if (!room || room.status !== 'COUNTING') return;
        const player = room.players[socket.id];
        if (player && !player.ready) {
            player.clickedTime = parseFloat(elapsedTime.toFixed(2));
            player.diff        = parseFloat(Math.abs(player.clickedTime - room.targetTime).toFixed(2));
            player.ready       = true;
            const allReady = Object.values(room.players).every(p => p.ready);
            if (allReady) {
                await resolveRound(socket.roomCode);
            } else {
                io.to(socket.roomCode).emit('room_update', room);
            }
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
            const p       = room.players[id];
            p.ready       = false;
            p.clickedTime = null;
            p.diff        = null;
            p.brokeStreak = false;
        }
        io.to(socket.roomCode).emit('room_update', room);
    });

    socket.on('disconnect', () => playerLeaveRoom(socket));
});

// ---- RESOLVE ROUND (async — writes to MongoDB) ----
async function resolveRound(code) {
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

    // Update in-memory streaks first so room_update carries the correct values
    arr.forEach(p => {
        if (p.id === winner.id) {
            p.currentStreak++;
            p.brokeStreak = false;
        } else {
            if (p.currentStreak >= 2) {
                p.brokeStreak         = true;
                p.previousStreakValue = p.currentStreak;
            } else {
                p.brokeStreak = false;
            }
            p.currentStreak = 0;
        }
    });

    room.lastWinnerName = winner.name;
    room.lastLoserName  = loser.name;

    // Broadcast results immediately with updated streak values
    io.to(code).emit('room_update', room);

    // Persist stats to MongoDB concurrently for all players
    await Promise.all(arr.map(async (p) => {
        try {
            const user = await User.findOne({ username: p.name });
            if (!user) return;

            user.totalGames++;
            if (p.diff !== null) {
                user.totalDiffSum = parseFloat(((user.totalDiffSum || 0) + p.diff).toFixed(2));
            }
            if (p.id === winner.id) {
                user.totalWins++;
                if (p.currentStreak > user.maxStreak) user.maxStreak = p.currentStreak;
            }

            await user.save();

            io.to(p.id).emit('profile_update', buildProfilePayload(user));
        } catch (err) {
            console.error(`resolveRound DB error for player "${p.name}":`, err.message);
        }
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
