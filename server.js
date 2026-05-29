'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const TOTAL_ROUNDS = 10;

const RULE_COUNTS = {
  BIG: 3,
  SMALL: 3,
  FAR: 2,
  CHAIN: 2,
  EVEN: 2
};

const RULES = {
  BIG: {
    label: 'BIG',
    summary: '大きい数字が勝利'
  },
  SMALL: {
    label: 'SMALL',
    summary: '小さい数字が勝利'
  },
  FAR: {
    label: 'FAR',
    summary: '5.5から遠い数字が勝利'
  },
  CHAIN: {
    label: 'CHAIN',
    summary: '前回との差が小さい方が勝利'
  },
  EVEN: {
    label: 'EVEN',
    summary: '偶数が優先。同性質なら大きい数字'
  }
};

const NOISES = {
  Reverse: {
    label: 'Reverse',
    summary: '現在のルールを反転'
  },
  Shift: {
    label: 'Shift',
    summary: '自分の数字を±1'
  },
  Jam: {
    label: 'Jam',
    summary: '公開されたノイズ効果を無効化'
  },
  Echo: {
    label: 'Echo',
    summary: '相手が直近で使ったノイズをコピー'
  },
  Peek: {
    label: 'Peek',
    summary: '相手のノイズ手札を1枚確認'
  }
};

const NOISE_TYPES = Object.keys(NOISES);
const rooms = new Map();
const socketClients = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8'
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  let filePath;

  try {
    filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(urlPath)));
  } catch (error) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  serveFile(filePath, res, () => {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    const hasExtension = Boolean(path.extname(requestUrl.pathname));

    if (wantsHtml || !hasExtension) {
      serveFile(INDEX_FILE, res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });
});

server.on('upgrade', (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    ''
  ].join('\r\n'));

  const client = {
    socket,
    buffer: Buffer.alloc(0),
    sessionId: null,
    roomCode: null,
    playerId: null
  };

  socketClients.set(socket, client);
  socket.on('data', (chunk) => readFrames(client, chunk));
  socket.on('close', () => handleDisconnect(client));
  socket.on('error', () => handleDisconnect(client));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NOISE server listening on http://localhost:${PORT}`);
});

setInterval(cleanupRooms, 15 * 60 * 1000).unref();

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});

function serveFile(filePath, res, onMissing) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (onMissing) {
        onMissing();
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function readFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const high = client.buffer.readUInt32BE(offset);
      const low = client.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;

    let payload = client.buffer.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index += 1) {
        unmasked[index] = payload[index] ^ mask[index % 4];
      }
      payload = unmasked;
    }

    client.buffer = client.buffer.subarray(offset + maskLength + length);

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      sendFrame(client.socket, 0xA, payload);
      continue;
    }
    if (opcode !== 0x1) continue;

    try {
      handleMessage(client, JSON.parse(payload.toString('utf8')));
    } catch (error) {
      sendError(client, 'メッセージを処理できませんでした。');
    }
  }
}

function sendJson(socket, value) {
  if (!socket || socket.destroyed || !socket.writable) return;
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value), 'utf8'));
}

function sendFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  socket.write(Buffer.concat([header, payload]));
}

function handleMessage(client, message) {
  const type = String(message.type || '');

  if (type === 'createRoom') {
    createRoom(client, message);
    return;
  }
  if (type === 'joinRoom') {
    joinRoom(client, message);
    return;
  }
  if (type === 'resumeRoom') {
    resumeRoom(client, message);
    return;
  }
  if (type === 'submitNumber') {
    submitNumber(client, message);
    return;
  }
  if (type === 'submitNoise') {
    submitNoise(client, message);
    return;
  }
  if (type === 'readyNext') {
    readyNext(client);
    return;
  }

  sendError(client, '未対応の操作です。');
}

function createRoom(client, message) {
  detachFromCurrentRoom(client, false);

  const sessionId = normalizeSessionId(message.sessionId) || makeId('session');
  const room = {
    code: makeRoomCode(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'lobby',
    phase: 'lobby',
    round: 0,
    totalRounds: TOTAL_ROUNDS,
    players: {
      A: createPlayer('A', sessionId, message.name || 'Player A'),
      B: null
    },
    ruleDeck: [],
    currentRule: null,
    choices: null,
    ready: { A: false, B: false },
    reveal: null
  };

  rooms.set(room.code, room);
  attachClient(client, room, room.players.A);
  broadcastRoom(room);
}

function joinRoom(client, message) {
  const code = normalizeRoomCode(message.roomCode);
  const room = rooms.get(code);
  if (!room) {
    sendError(client, 'ルームが見つかりません。');
    return;
  }

  const sessionId = normalizeSessionId(message.sessionId) || makeId('session');
  const existingId = findPlayerIdBySession(room, sessionId);

  if (existingId) {
    attachClient(client, room, room.players[existingId]);
    broadcastRoom(room);
    return;
  }

  if (room.players.B) {
    sendError(client, 'このルームは満員です。');
    return;
  }

  detachFromCurrentRoom(client, false);
  room.players.B = createPlayer('B', sessionId, message.name || 'Player B');
  attachClient(client, room, room.players.B);

  if (room.status === 'lobby') {
    startGame(room);
  }

  broadcastRoom(room);
}

function resumeRoom(client, message) {
  const code = normalizeRoomCode(message.roomCode);
  const sessionId = normalizeSessionId(message.sessionId);
  const room = rooms.get(code);
  if (!room || !sessionId) {
    sendError(client, '再接続できるルームがありません。');
    return;
  }

  const playerId = findPlayerIdBySession(room, sessionId);
  if (!playerId) {
    sendError(client, 'この端末の参加情報が見つかりません。');
    return;
  }

  attachClient(client, room, room.players[playerId]);
  broadcastRoom(room);
}

function submitNumber(client, message) {
  const { room, player } = getActivePlayer(client);
  if (!room || !player) return;
  if (room.phase !== 'number') {
    sendError(client, '今は数字を選べません。');
    return;
  }

  const number = Number(message.number);
  if (!Number.isInteger(number) || number < 1 || number > 10) {
    sendError(client, '1から10の数字を選んでください。');
    return;
  }
  if (player.usedNumbers.includes(number)) {
    sendError(client, 'その数字はすでに使用済みです。');
    return;
  }

  const choice = room.choices[player.id];
  if (choice.number !== null) {
    sendError(client, 'このラウンドの数字は送信済みです。');
    return;
  }

  choice.number = number;
  room.updatedAt = Date.now();

  if (room.choices.A.number !== null && room.choices.B.number !== null) {
    room.phase = 'noise';
  }

  broadcastRoom(room);
}

function submitNoise(client, message) {
  const { room, player } = getActivePlayer(client);
  if (!room || !player) return;
  if (room.phase !== 'noise') {
    sendError(client, '今はノイズを選べません。');
    return;
  }

  const choice = room.choices[player.id];
  if (choice.noiseSubmitted) {
    sendError(client, 'このラウンドのノイズは送信済みです。');
    return;
  }

  const cardId = typeof message.cardId === 'string' ? message.cardId : null;
  if (!cardId) {
    choice.noise = null;
    choice.noiseSubmitted = true;
  } else {
    const card = player.noiseHand.find((item) => item.id === cardId);
    if (!card) {
      sendError(client, 'そのノイズカードは手札にありません。');
      return;
    }

    const direction = card.type === 'Shift'
      ? normalizeShiftDirection(room.choices[player.id].number, message.direction)
      : null;

    if (card.type === 'Shift' && direction === null) {
      sendError(client, 'Shiftの方向を選んでください。');
      return;
    }

    choice.noise = {
      cardId: card.id,
      type: card.type,
      direction
    };
    choice.noiseSubmitted = true;
  }

  room.updatedAt = Date.now();

  if (room.choices.A.noiseSubmitted && room.choices.B.noiseSubmitted) {
    resolveRound(room);
  }

  broadcastRoom(room);
}

function readyNext(client) {
  const { room, player } = getActivePlayer(client);
  if (!room || !player) return;
  if (room.phase !== 'reveal') {
    sendError(client, 'まだ次へ進めません。');
    return;
  }

  room.ready[player.id] = true;
  room.updatedAt = Date.now();

  if (room.ready.A && room.ready.B) {
    if (room.round >= TOTAL_ROUNDS) {
      endGame(room);
    } else {
      startRound(room);
    }
  }

  broadcastRoom(room);
}

function startGame(room) {
  room.status = 'active';
  room.phase = 'number';
  room.round = 0;
  room.ruleDeck = makeRuleDeck();
  room.reveal = null;
  room.ready = { A: false, B: false };

  for (const player of Object.values(room.players)) {
    if (!player) continue;
    player.score = 0;
    player.usedNumbers = [];
    player.noiseHand = dealNoiseHand();
    player.noiseHistory = [];
    player.lastNumber = null;
  }

  startRound(room);
}

function startRound(room) {
  room.round += 1;
  room.phase = 'number';
  room.currentRule = drawRule(room);
  room.choices = {
    A: createRoundChoice(),
    B: createRoundChoice()
  };
  room.ready = { A: false, B: false };
  room.reveal = null;
  room.updatedAt = Date.now();
}

function resolveRound(room) {
  const playerA = room.players.A;
  const playerB = room.players.B;
  const choices = room.choices;
  const baseNumbers = {
    A: choices.A.number,
    B: choices.B.number
  };
  const finalNumbers = {
    A: baseNumbers.A,
    B: baseNumbers.B
  };
  const noises = {
    A: choices.A.noise,
    B: choices.B.noise
  };
  const logs = [];
  const privateNotes = { A: [], B: [] };
  const directJam = Object.values(noises).some((noise) => noise?.type === 'Jam');
  let reversed = false;
  let echoJam = false;
  const peekActors = [];

  consumeNoise(playerA, noises.A);
  consumeNoise(playerB, noises.B);

  if (directJam) {
    logs.push('Jamが発動し、公開されたノイズ効果を無効化しました。');
  } else {
    for (const playerId of ['A', 'B']) {
      if (noises[playerId]?.type === 'Reverse') {
        reversed = !reversed;
        logs.push(`${playerLabel(room, playerId)}のReverseがルールを反転しました。`);
      }
    }

    for (const playerId of ['A', 'B']) {
      if (noises[playerId]?.type === 'Shift') {
        applyShift(room, playerId, finalNumbers, noises[playerId].direction, 'Shift', logs);
      }
    }

    const echoEffects = [];
    for (const playerId of ['A', 'B']) {
      if (noises[playerId]?.type !== 'Echo') continue;

      const target = findEchoTarget(opponentId(playerId), room);
      if (!target) {
        logs.push(`${playerLabel(room, playerId)}のEchoはコピー対象がなく不発でした。`);
        continue;
      }

      logs.push(`${playerLabel(room, playerId)}のEchoが${target.type}をコピーしました。`);
      echoEffects.push({ playerId, target });
    }

    if (echoEffects.some((effect) => effect.target.type === 'Jam')) {
      echoJam = true;
      logs.push('EchoでコピーされたJamが、Echo以降のノイズ効果を無効化しました。');
    }

    if (!echoJam) {
      for (const effect of echoEffects) {
        if (effect.target.type === 'Reverse') {
          reversed = !reversed;
          logs.push(`${playerLabel(room, effect.playerId)}のEcho-Reverseがルールを反転しました。`);
        }
      }

      for (const effect of echoEffects) {
        if (effect.target.type === 'Shift') {
          applyShift(room, effect.playerId, finalNumbers, effect.target.direction, 'Echo-Shift', logs);
        }
      }

      for (const effect of echoEffects) {
        if (effect.target.type === 'Peek') {
          peekActors.push({ playerId: effect.playerId, source: 'Echo-Peek' });
        }
      }

      for (const playerId of ['A', 'B']) {
        if (noises[playerId]?.type === 'Peek') {
          peekActors.push({ playerId, source: 'Peek' });
        }
      }

      for (const actor of peekActors) {
        resolvePeek(room, actor.playerId, actor.source, privateNotes, logs);
      }
    }
  }

  const judgement = judgeRound(room.currentRule, reversed, finalNumbers, {
    A: playerA.lastNumber,
    B: playerB.lastNumber
  });

  if (judgement.winner) {
    room.players[judgement.winner].score += 1;
  }

  for (const playerId of ['A', 'B']) {
    const player = room.players[playerId];
    player.usedNumbers.push(baseNumbers[playerId]);
    player.lastNumber = finalNumbers[playerId];
    if (noises[playerId]) {
      player.noiseHistory.push({
        round: room.round,
        type: noises[playerId].type,
        direction: noises[playerId].direction
      });
    }
  }

  room.phase = 'reveal';
  room.reveal = {
    round: room.round,
    baseNumbers,
    finalNumbers,
    noises: {
      A: noises.A ? noises.A.type : null,
      B: noises.B ? noises.B.type : null
    },
    reversed,
    effectiveRule: effectiveRule(room.currentRule, reversed),
    logs,
    privateNotes,
    winner: judgement.winner,
    judgement,
    scores: {
      A: playerA.score,
      B: playerB.score
    },
    finalRound: room.round >= TOTAL_ROUNDS
  };
  room.ready = { A: false, B: false };
  room.updatedAt = Date.now();
}

function endGame(room) {
  room.status = 'ended';
  room.phase = 'ended';
  room.updatedAt = Date.now();
}

function applyShift(room, playerId, finalNumbers, direction, source, logs) {
  const before = finalNumbers[playerId];
  const normalized = normalizeShiftDirection(before, direction);
  if (normalized === null) {
    logs.push(`${playerLabel(room, playerId)}の${source}は方向が決まらず不発でした。`);
    return;
  }

  finalNumbers[playerId] = before + normalized;
  const sign = normalized > 0 ? '+1' : '-1';
  logs.push(`${playerLabel(room, playerId)}の${source}で ${before} -> ${finalNumbers[playerId]} (${sign})。`);
}

function resolvePeek(room, playerId, source, privateNotes, logs) {
  const targetId = opponentId(playerId);
  const target = room.players[targetId];
  const visibleCard = pick(target.noiseHand);

  if (!visibleCard) {
    privateNotes[playerId].push(`${source}: 相手のノイズ手札は残っていません。`);
    logs.push(`${playerLabel(room, playerId)}の${source}は、確認できるカードがありませんでした。`);
    return;
  }

  privateNotes[playerId].push(`${source}: 相手の手札に ${visibleCard.type} があります。`);
  logs.push(`${playerLabel(room, playerId)}の${source}が相手のノイズ手札を1枚確認しました。`);
}

function judgeRound(rule, reversed, numbers, previousNumbers) {
  if (rule === 'BIG') {
    return compareNumbers(numbers.A, numbers.B, reversed ? 'low' : 'high', effectiveRule(rule, reversed));
  }
  if (rule === 'SMALL') {
    return compareNumbers(numbers.A, numbers.B, reversed ? 'high' : 'low', effectiveRule(rule, reversed));
  }
  if (rule === 'FAR') {
    const distances = {
      A: Math.abs(numbers.A - 5.5),
      B: Math.abs(numbers.B - 5.5)
    };
    const mode = reversed ? 'low' : 'high';
    return compareMetrics(distances.A, distances.B, mode, effectiveRule(rule, reversed), {
      A: `距離${distances.A}`,
      B: `距離${distances.B}`,
      tie: '5.5からの距離が同じでした。'
    });
  }
  if (rule === 'CHAIN') {
    if (previousNumbers.A === null || previousNumbers.B === null) {
      return {
        winner: null,
        title: effectiveRule(rule, reversed).label,
        detail: '前回の数字がないため引き分けです。'
      };
    }

    const diffs = {
      A: Math.abs(numbers.A - previousNumbers.A),
      B: Math.abs(numbers.B - previousNumbers.B)
    };
    const mode = reversed ? 'high' : 'low';
    return compareMetrics(diffs.A, diffs.B, mode, effectiveRule(rule, reversed), {
      A: `差${diffs.A}`,
      B: `差${diffs.B}`,
      tie: '前回との差が同じでした。'
    });
  }
  if (rule === 'EVEN') {
    return judgeEven(numbers, reversed);
  }

  return {
    winner: null,
    title: 'UNKNOWN',
    detail: '未知のルールのため引き分けです。'
  };
}

function compareNumbers(a, b, mode, ruleInfo) {
  if (a === b) {
    return {
      winner: null,
      title: ruleInfo.label,
      detail: '数字が同じため引き分けです。'
    };
  }

  const winner = mode === 'high'
    ? (a > b ? 'A' : 'B')
    : (a < b ? 'A' : 'B');
  const word = mode === 'high' ? '大きい' : '小さい';

  return {
    winner,
    title: ruleInfo.label,
    detail: `${word}数字が勝利しました。`
  };
}

function compareMetrics(a, b, mode, ruleInfo, labels) {
  if (a === b) {
    return {
      winner: null,
      title: ruleInfo.label,
      detail: labels.tie
    };
  }

  const winner = mode === 'high'
    ? (a > b ? 'A' : 'B')
    : (a < b ? 'A' : 'B');
  const word = mode === 'high' ? '大きい' : '小さい';

  return {
    winner,
    title: ruleInfo.label,
    detail: `${labels.A} / ${labels.B}。${word}方が勝利しました。`
  };
}

function judgeEven(numbers, reversed) {
  const aEven = numbers.A % 2 === 0;
  const bEven = numbers.B % 2 === 0;

  if (!reversed) {
    if (aEven !== bEven) {
      return {
        winner: aEven ? 'A' : 'B',
        title: 'EVEN',
        detail: '偶数が優先されました。'
      };
    }

    return compareNumbers(numbers.A, numbers.B, 'high', {
      label: 'EVEN',
      summary: '同性質なら大きい数字'
    });
  }

  if (aEven !== bEven) {
    return {
      winner: aEven ? 'B' : 'A',
      title: 'ODD',
      detail: 'Reverseにより奇数が優先されました。'
    };
  }

  return compareNumbers(numbers.A, numbers.B, 'low', {
    label: 'ODD',
    summary: '同性質なら小さい数字'
  });
}

function effectiveRule(rule, reversed) {
  if (!reversed) return { label: RULES[rule]?.label || rule, summary: RULES[rule]?.summary || '' };

  if (rule === 'BIG') return { label: 'SMALL', summary: 'Reverseにより小さい数字が勝利' };
  if (rule === 'SMALL') return { label: 'BIG', summary: 'Reverseにより大きい数字が勝利' };
  if (rule === 'FAR') return { label: 'NEAR', summary: 'Reverseにより5.5に近い数字が勝利' };
  if (rule === 'CHAIN') return { label: 'CHAIN+', summary: 'Reverseにより前回との差が大きい方が勝利' };
  if (rule === 'EVEN') return { label: 'ODD', summary: 'Reverseにより奇数が優先。同性質なら小さい数字' };

  return { label: rule, summary: '' };
}

function consumeNoise(player, noise) {
  if (!noise) return;
  const index = player.noiseHand.findIndex((card) => card.id === noise.cardId);
  if (index >= 0) {
    player.noiseHand.splice(index, 1);
  }
}

function findEchoTarget(opponentPlayerId, room) {
  const history = room.players[opponentPlayerId].noiseHistory;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].type !== 'Echo') {
      return history[index];
    }
  }
  return null;
}

function normalizeShiftDirection(number, value) {
  if (number === 1) return 1;
  if (number === 10) return -1;
  const direction = Number(value);
  if (direction === 1 || direction === -1) return direction;
  return null;
}

function createPlayer(id, sessionId, name) {
  return {
    id,
    sessionId,
    name: normalizeName(name, id),
    socket: null,
    connected: false,
    score: 0,
    usedNumbers: [],
    lastNumber: null,
    noiseHand: [],
    noiseHistory: []
  };
}

function createRoundChoice() {
  return {
    number: null,
    noise: null,
    noiseSubmitted: false
  };
}

function attachClient(client, room, player) {
  detachFromCurrentRoom(client, false);

  if (player.socket && player.socket !== client.socket) {
    sendJson(player.socket, {
      type: 'notice',
      message: '同じプレイヤーが別の接続で再開しました。'
    });
  }

  player.socket = client.socket;
  player.connected = true;
  client.roomCode = room.code;
  client.playerId = player.id;
  client.sessionId = player.sessionId;
  room.updatedAt = Date.now();
}

function detachFromCurrentRoom(client, shouldBroadcast) {
  if (!client.roomCode || !client.playerId) return;

  const room = rooms.get(client.roomCode);
  if (room) {
    const player = room.players[client.playerId];
    if (player && player.socket === client.socket) {
      player.socket = null;
      player.connected = false;
      room.updatedAt = Date.now();
      if (shouldBroadcast) broadcastRoom(room);
    }
  }

  client.roomCode = null;
  client.playerId = null;
}

function handleDisconnect(client) {
  detachFromCurrentRoom(client, true);
  socketClients.delete(client.socket);
}

function getActivePlayer(client) {
  const room = rooms.get(client.roomCode);
  if (!room || !client.playerId) {
    sendError(client, 'ルームに参加していません。');
    return {};
  }

  const player = room.players[client.playerId];
  if (!player) {
    sendError(client, 'プレイヤー情報が見つかりません。');
    return {};
  }

  if (room.status !== 'active') {
    sendError(client, '対戦中ではありません。');
    return {};
  }

  return { room, player };
}

function broadcastRoom(room) {
  for (const playerId of ['A', 'B']) {
    const player = room.players[playerId];
    if (!player?.socket) continue;
    sendJson(player.socket, {
      type: 'snapshot',
      state: snapshotFor(room, playerId)
    });
  }
}

function snapshotFor(room, viewerId) {
  const opponent = opponentId(viewerId);
  const state = {
    roomCode: room.code,
    status: room.status,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    currentRule: room.currentRule ? {
      type: room.currentRule,
      label: RULES[room.currentRule].label,
      summary: RULES[room.currentRule].summary
    } : null,
    you: serializePlayer(room.players[viewerId], true),
    opponent: serializePlayer(room.players[opponent], false),
    choices: serializeChoices(room, viewerId),
    ready: { ...room.ready },
    reveal: room.reveal ? revealFor(room.reveal, viewerId) : null,
    allNoises: NOISES,
    now: Date.now()
  };

  if (room.status === 'ended') {
    state.matchResult = matchResult(room);
  }

  return state;
}

function serializePlayer(player, isSelf) {
  if (!player) return null;

  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    score: player.score,
    usedNumbers: [...player.usedNumbers],
    lastNumber: player.lastNumber,
    noiseCount: player.noiseHand.length,
    noiseHand: isSelf ? player.noiseHand.map((card) => ({ ...card })) : undefined
  };
}

function serializeChoices(room, viewerId) {
  if (!room.choices) return null;
  const opponent = opponentId(viewerId);
  const own = room.choices[viewerId];
  const other = room.choices[opponent];

  return {
    you: {
      numberLocked: own.number !== null,
      pendingNumber: own.number,
      noiseLocked: own.noiseSubmitted,
      pendingNoise: own.noise ? own.noise.type : null
    },
    opponent: {
      numberLocked: other.number !== null,
      noiseLocked: other.noiseSubmitted
    }
  };
}

function revealFor(reveal, viewerId) {
  return {
    ...reveal,
    privateNotes: reveal.privateNotes[viewerId] || []
  };
}

function matchResult(room) {
  const scoreA = room.players.A.score;
  const scoreB = room.players.B.score;
  if (scoreA === scoreB) {
    return {
      winner: null,
      title: 'DRAW',
      detail: `${scoreA} - ${scoreB}`
    };
  }

  const winner = scoreA > scoreB ? 'A' : 'B';
  return {
    winner,
    title: `${playerLabel(room, winner)} WIN`,
    detail: `${scoreA} - ${scoreB}`
  };
}

function sendError(client, message) {
  sendJson(client.socket, {
    type: 'error',
    message
  });
}

function makeRuleDeck() {
  const deck = [];
  for (const [rule, count] of Object.entries(RULE_COUNTS)) {
    for (let index = 0; index < count; index += 1) deck.push(rule);
  }
  return shuffle(deck);
}

function drawRule(room) {
  if (room.ruleDeck.length === 0) room.ruleDeck = makeRuleDeck();

  for (let attempts = 0; attempts < room.ruleDeck.length + 1; attempts += 1) {
    const rule = room.ruleDeck.shift();
    if (room.round === 1 && rule === 'CHAIN') {
      room.ruleDeck.push(rule);
      continue;
    }
    return rule;
  }

  return 'BIG';
}

function dealNoiseHand() {
  return shuffle([...NOISE_TYPES]).slice(0, 3).map((type) => ({
    id: makeId('noise'),
    type
  }));
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function pick(items) {
  if (!items.length) return null;
  return items[crypto.randomInt(items.length)];
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = '';
    for (let index = 0; index < 5; index += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function normalizeRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 90) return null;
  return text.replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeName(value, playerId) {
  const fallback = playerId === 'A' ? 'Player A' : 'Player B';
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 18) : fallback;
}

function findPlayerIdBySession(room, sessionId) {
  for (const playerId of ['A', 'B']) {
    if (room.players[playerId]?.sessionId === sessionId) return playerId;
  }
  return null;
}

function opponentId(playerId) {
  return playerId === 'A' ? 'B' : 'A';
}

function playerLabel(room, playerId) {
  return room.players[playerId]?.name || playerId;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const inactiveFor = now - room.updatedAt;
    const bothGone = !room.players.A?.connected && !room.players.B?.connected;
    if (bothGone && inactiveFor > 3 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}
