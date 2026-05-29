(() => {
  'use strict';

  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  const storage = window.localStorage;
  const sessionKey = 'noise.sessionId';
  const roomKey = 'noise.roomCode';
  const nameKey = 'noise.name';
  const sessionId = getSessionId();
  const queryRoom = new URLSearchParams(window.location.search).get('room');

  let socket = null;
  let reconnectTimer = null;
  let state = null;
  let connected = false;
  let selectedNumber = null;
  let selectedNoiseId = null;
  let selectedNoiseType = null;
  let shiftDirection = 1;
  let lastRoundRendered = 0;

  connect();
  render();

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.addEventListener('open', () => {
      connected = true;
      render();
      const roomCode = queryRoom || storage.getItem(roomKey);
      if (roomCode) {
        send({
          type: 'resumeRoom',
          roomCode,
          sessionId
        });
      }
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'snapshot') {
        state = message.state;
        storage.setItem(roomKey, state.roomCode);
        selectedNumber = null;
        selectedNoiseId = null;
        selectedNoiseType = null;
        shiftDirection = 1;
        render();
      } else if (message.type === 'error') {
        showToast(message.message);
      } else if (message.type === 'notice') {
        showToast(message.message);
      }
    });

    socket.addEventListener('close', () => {
      connected = false;
      render();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 900);
    });
  }

  function render() {
    if (!state) {
      renderLobby();
      return;
    }

    if (state.status === 'lobby') {
      renderWaiting();
      return;
    }

    renderGame();
  }

  function renderLobby() {
    const savedName = escapeHtml(storage.getItem(nameKey) || '');
    const roomValue = escapeHtml(queryRoom || '');
    app.innerHTML = `
      <section class="lobby">
        <div class="brand">
          <p class="eyebrow">ONLINE DUEL CARD GAME</p>
          <h1>NOISE</h1>
          <p class="tagline">数字とノイズで読む、2人専用の心理戦。ルームコードを作成するか、相手のコードで参加します。</p>
          <div class="connection"><span class="dot ${connected ? 'on' : ''}"></span><span>${connected ? 'サーバー接続中' : '再接続中'}</span></div>
        </div>
        <div class="lobby-panel">
          <label class="field">
            <span>プレイヤー名</span>
            <input id="nameInput" maxlength="18" autocomplete="name" value="${savedName}" placeholder="Player">
          </label>
          <button class="primary" id="createBtn" ${connected ? '' : 'disabled'}>ルーム作成</button>
          <label class="field">
            <span>ルームコード</span>
            <input id="roomInput" maxlength="8" autocapitalize="characters" value="${roomValue}" placeholder="ABCDE">
          </label>
          <button class="secondary" id="joinBtn" ${connected ? '' : 'disabled'}>参加</button>
        </div>
      </section>
    `;

    document.getElementById('nameInput').addEventListener('input', (event) => {
      storage.setItem(nameKey, event.target.value);
    });
    document.getElementById('createBtn').addEventListener('click', () => {
      send({
        type: 'createRoom',
        sessionId,
        name: getPlayerName()
      });
    });
    document.getElementById('joinBtn').addEventListener('click', () => {
      const roomCode = document.getElementById('roomInput').value;
      send({
        type: 'joinRoom',
        sessionId,
        name: getPlayerName(),
        roomCode
      });
    });
  }

  function renderWaiting() {
    app.innerHTML = `
      <section class="lobby">
        <div class="brand">
          <p class="eyebrow">ROOM CREATED</p>
          <h1>NOISE</h1>
          <p class="tagline">相手が入室すると自動でゲームが始まります。</p>
          <div class="connection"><span class="dot ${connected ? 'on' : ''}"></span><span>${connected ? '接続中' : '再接続中'}</span></div>
        </div>
        <div class="waiting-panel">
          <p class="eyebrow">ROOM CODE</p>
          <button class="room-code" id="copyCode">${escapeHtml(state.roomCode)}</button>
          <button class="primary" id="shareLink">招待リンクをコピー</button>
          <button class="ghost" id="leaveRoom">ロビーに戻る</button>
        </div>
      </section>
    `;

    document.getElementById('copyCode').addEventListener('click', () => copyText(state.roomCode));
    document.getElementById('shareLink').addEventListener('click', () => {
      const url = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
      copyText(url);
    });
    document.getElementById('leaveRoom').addEventListener('click', resetLocalRoom);
  }

  function renderGame() {
    const isReveal = state.phase === 'reveal' || state.phase === 'ended';
    const rule = isReveal && state.reveal ? state.reveal.effectiveRule : state.currentRule;
    const flipClass = state.round !== lastRoundRendered ? 'flip' : '';
    lastRoundRendered = state.round;

    app.innerHTML = `
      <section class="game">
        ${topbarTemplate()}
        <section class="table">
          ${playerBandTemplate(state.opponent, 'opponent')}
          <div class="arena">
            <div class="rule-card ${flipClass}">
              <div class="rule-label">${escapeHtml(rule?.label || 'READY')}</div>
              <div class="rule-summary">${escapeHtml(rule?.summary || '相手の入室を待っています')}</div>
            </div>
            <p class="status-line">${escapeHtml(statusText())}</p>
            ${noiseRevealTemplate()}
            ${numberRevealTemplate()}
            ${resultTemplate()}
            ${privateNotesTemplate()}
            ${logsTemplate()}
          </div>
          ${playerBandTemplate(state.you, 'you')}
        </section>
        ${handPanelTemplate()}
      </section>
    `;

    bindGameEvents();
  }

  function topbarTemplate() {
    const you = state.you;
    const opponent = state.opponent || { name: 'Waiting', score: 0 };
    return `
      <header class="topbar">
        <div class="round-pill">R${state.round || 0}/${state.totalRounds}</div>
        <div class="scoreboard">
          <div class="score">
            <span class="score-name">${escapeHtml(you.name)}</span>
            <span class="score-value">${you.score}</span>
          </div>
          <span class="score-separator">-</span>
          <div class="score">
            <span class="score-name">${escapeHtml(opponent.name)}</span>
            <span class="score-value">${opponent.score}</span>
          </div>
        </div>
        <button class="room-pill" id="copyCode">${escapeHtml(state.roomCode)}</button>
      </header>
    `;
  }

  function playerBandTemplate(player, side) {
    const name = player ? player.name : 'Waiting';
    const connectedClass = player?.connected ? 'on' : '';
    return `
      <div class="player-band ${side}">
        <div class="player-name">
          <span class="dot ${connectedClass}"></span>
          <span>${escapeHtml(name)}</span>
        </div>
        <div class="used-strip" aria-label="${escapeHtml(name)}の使用済み数字">
          ${Array.from({ length: 10 }, (_, index) => {
            const number = index + 1;
            const used = player?.usedNumbers?.includes(number);
            return `<span class="used-dot ${used ? 'used' : ''}">${number}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  function noiseRevealTemplate() {
    const reveal = state.reveal;
    const ownNoise = reveal ? reveal.noises[state.you.id] : null;
    const opponentNoise = reveal && state.opponent ? reveal.noises[state.opponent.id] : null;
    return `
      <div class="noise-row">
        <div class="noise-reveal ${opponentNoise ? 'fired' : ''}">${escapeHtml(opponentNoise || 'NO NOISE')}</div>
        <div class="noise-reveal ${ownNoise ? 'fired' : ''}">${escapeHtml(ownNoise || 'NO NOISE')}</div>
      </div>
    `;
  }

  function numberRevealTemplate() {
    const reveal = state.reveal;
    const ownId = state.you.id;
    const opponentId = state.opponent?.id;
    const ownValue = reveal ? reveal.finalNumbers[ownId] : state.choices?.you.pendingNumber;
    const opponentValue = reveal && opponentId ? reveal.finalNumbers[opponentId] : null;

    return `
      <div class="reveal-grid">
        <div class="slot">
          <span class="slot-label">${escapeHtml(state.opponent?.name || 'Opponent')}</span>
          <div class="number-stage">${numberCardTemplate(opponentValue, reveal)}</div>
        </div>
        <div class="slot">
          <span class="slot-label">${escapeHtml(state.you.name)}</span>
          <div class="number-stage">${numberCardTemplate(ownValue, reveal || state.choices?.you.numberLocked)}</div>
        </div>
      </div>
    `;
  }

  function numberCardTemplate(value, revealed) {
    if (value === null || value === undefined) return '<div class="card-back">?</div>';
    return `<div class="big-number ${revealed ? 'revealed' : ''}">${value}</div>`;
  }

  function resultTemplate() {
    if (state.phase === 'ended' && state.matchResult) {
      return `
        <div class="game-over">
          <p class="eyebrow">FINAL RESULT</p>
          <h2>${escapeHtml(state.matchResult.title)}</h2>
          <p>${escapeHtml(state.matchResult.detail)}</p>
          <button class="primary" id="newRoom">新しいルームへ</button>
        </div>
      `;
    }

    if (!state.reveal) return '';

    const winner = state.reveal.winner;
    const title = winner ? `${playerName(winner)} WIN` : 'DRAW';
    return `
      <div class="result-banner ${winner ? '' : 'draw'}">
        <div class="result-title">${escapeHtml(title)}</div>
        <div class="result-detail">${escapeHtml(state.reveal.judgement.detail)}</div>
      </div>
    `;
  }

  function privateNotesTemplate() {
    if (!state.reveal?.privateNotes?.length) return '';
    return state.reveal.privateNotes
      .map((note) => `<div class="private-note">${escapeHtml(note)}</div>`)
      .join('');
  }

  function logsTemplate() {
    if (!state.reveal?.logs?.length) return '';
    return `
      <div class="log-list">
        ${state.reveal.logs.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
      </div>
    `;
  }

  function handPanelTemplate() {
    if (state.phase === 'ended') return '';

    if (state.phase === 'reveal') {
      return `
        <section class="hand-panel compact">
          <div class="hand-actions">
            ${actionTemplate()}
          </div>
        </section>
      `;
    }

    return `
      <section class="hand-panel">
        ${numberHandTemplate()}
        ${noiseHandTemplate()}
        <div class="hand-actions">
          ${actionTemplate()}
        </div>
      </section>
    `;
  }

  function numberHandTemplate() {
    const canPick = state.phase === 'number' && !state.choices?.you.numberLocked;
    return `
      <div>
        <div class="hand-title"><span>数字カード</span><span>${state.choices?.you.numberLocked ? '送信済み' : '1回だけ使用'}</span></div>
        <div class="number-hand">
          ${Array.from({ length: 10 }, (_, index) => {
            const number = index + 1;
            const used = state.you.usedNumbers.includes(number);
            const selected = selectedNumber === number;
            return `
              <button class="card-button ${used ? 'used' : ''} ${selected ? 'selected' : ''}"
                data-number="${number}" ${canPick && !used ? '' : 'disabled'}>${number}</button>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function noiseHandTemplate() {
    const canPick = state.phase === 'noise' && !state.choices?.you.noiseLocked;
    const hand = state.you.noiseHand || [];
    const noneSelected = selectedNoiseId === null;
    return `
      <div>
        <div class="hand-title"><span>ノイズカード</span><span>1ラウンド1枚まで</span></div>
        <div class="noise-hand">
          <button class="noise-button none ${noneSelected ? 'selected' : ''}" data-noise-id="" ${canPick ? '' : 'disabled'}>使わない</button>
          ${hand.map((card) => `
            <button class="noise-button ${selectedNoiseId === card.id ? 'selected' : ''}"
              data-noise-id="${escapeHtml(card.id)}" data-noise-type="${escapeHtml(card.type)}" ${canPick ? '' : 'disabled'}>${escapeHtml(card.type)}</button>
          `).join('')}
        </div>
        ${shiftControlTemplate(canPick)}
      </div>
    `;
  }

  function shiftControlTemplate(canPick) {
    if (selectedNoiseType !== 'Shift') return '';
    const pending = state.choices?.you.pendingNumber;
    const disableMinus = pending === 1;
    const disablePlus = pending === 10;
    return `
      <div class="shift-control">
        <button data-shift="-1" class="${shiftDirection === -1 ? 'selected' : ''}" ${canPick && !disableMinus ? '' : 'disabled'}>-1</button>
        <button data-shift="1" class="${shiftDirection === 1 ? 'selected' : ''}" ${canPick && !disablePlus ? '' : 'disabled'}>+1</button>
      </div>
    `;
  }

  function actionTemplate() {
    if (state.phase === 'number') {
      const locked = state.choices?.you.numberLocked;
      return `<button class="primary" id="submitNumber" ${selectedNumber && !locked ? '' : 'disabled'}>${locked ? '相手の数字待ち' : '伏せて送信'}</button>`;
    }

    if (state.phase === 'noise') {
      const locked = state.choices?.you.noiseLocked;
      return `<button class="primary" id="submitNoise" ${locked ? 'disabled' : ''}>${locked ? '相手のノイズ待ち' : 'ノイズ送信'}</button>`;
    }

    if (state.phase === 'reveal') {
      const ready = state.ready[state.you.id];
      const label = state.reveal?.finalRound ? '最終結果へ' : '次のラウンドへ';
      return `<button class="secondary" id="readyNext" ${ready ? 'disabled' : ''}>${ready ? '相手待ち' : label}</button>`;
    }

    return '';
  }

  function bindGameEvents() {
    const copyCode = document.getElementById('copyCode');
    if (copyCode) copyCode.addEventListener('click', () => copyText(state.roomCode));

    document.querySelectorAll('[data-number]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedNumber = Number(button.dataset.number);
        renderGame();
      });
    });

    document.querySelectorAll('[data-noise-id]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedNoiseId = button.dataset.noiseId || null;
        selectedNoiseType = button.dataset.noiseType || null;
        const pending = state.choices?.you.pendingNumber;
        if (selectedNoiseType === 'Shift') {
          shiftDirection = pending === 10 ? -1 : 1;
        }
        renderGame();
      });
    });

    document.querySelectorAll('[data-shift]').forEach((button) => {
      button.addEventListener('click', () => {
        shiftDirection = Number(button.dataset.shift);
        renderGame();
      });
    });

    const submitNumber = document.getElementById('submitNumber');
    if (submitNumber) {
      submitNumber.addEventListener('click', () => {
        send({ type: 'submitNumber', number: selectedNumber });
      });
    }

    const submitNoise = document.getElementById('submitNoise');
    if (submitNoise) {
      submitNoise.addEventListener('click', () => {
        send({
          type: 'submitNoise',
          cardId: selectedNoiseId,
          direction: shiftDirection
        });
      });
    }

    const readyNext = document.getElementById('readyNext');
    if (readyNext) readyNext.addEventListener('click', () => send({ type: 'readyNext' }));

    const newRoom = document.getElementById('newRoom');
    if (newRoom) newRoom.addEventListener('click', resetLocalRoom);
  }

  function statusText() {
    if (!connected) return '再接続中です。操作は接続後に再開されます。';
    if (!state.opponent?.connected) return '相手の再接続を待っています。';
    if (state.phase === 'number') {
      if (state.choices?.you.numberLocked) return '数字を伏せました。相手を待っています。';
      return '数字カードを選んで伏せて送信します。';
    }
    if (state.phase === 'noise') {
      if (state.choices?.you.noiseLocked) return 'ノイズを送信しました。相手を待っています。';
      return 'ノイズを1枚使うか、使わないを選びます。';
    }
    if (state.phase === 'reveal') return '結果公開。両者が進むと次のラウンドです。';
    if (state.phase === 'ended') return '全10ラウンド終了。';
    return '';
  }

  function playerName(playerId) {
    if (state.you.id === playerId) return state.you.name;
    if (state.opponent?.id === playerId) return state.opponent.name;
    return playerId;
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast('サーバーに接続していません。');
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function getPlayerName() {
    const input = document.getElementById('nameInput');
    const name = input ? input.value.trim() : storage.getItem(nameKey);
    storage.setItem(nameKey, name || 'Player');
    return name || 'Player';
  }

  function getSessionId() {
    let value = storage.getItem(sessionKey);
    if (!value) {
      value = window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `session_${Math.random().toString(36).slice(2)}_${Date.now()}`;
      storage.setItem(sessionKey, value);
    }
    return value;
  }

  function resetLocalRoom() {
    storage.removeItem(roomKey);
    state = null;
    selectedNumber = null;
    selectedNoiseId = null;
    selectedNoiseType = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
    renderLobby();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('コピーしました。');
    } catch (error) {
      showToast(text);
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
