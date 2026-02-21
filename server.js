/* eslint-disable no-console */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const FOCUS_MS = 25 * 60 * 1000;
const BREAK_MS = 5 * 60 * 1000;

/**
 * @typedef {{ id: string, name: string }} Participant
 * @typedef {{ id: string, text: string, completed: boolean }} Todo
 * @typedef {{ id: string, fromId: string, fromName: string, text: string, ts: number }} ChatMessage
 * @typedef {{ mode: 'focus'|'break', isRunning: boolean, remainingMs: number, endAt: number|null }} TimerState
 * @typedef {{ key: string, participants: Map<string, Participant>, todosByParticipant: Map<string, Todo[]>, chat: ChatMessage[], timer: TimerState, timerTimeout: NodeJS.Timeout|null }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

function nowMs() {
  return Date.now();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isValidSessionKey(key) {
  return typeof key === 'string' && /^[A-Z0-9]{8}$/.test(key);
}

function durationForMode(mode) {
  return mode === 'break' ? BREAK_MS : FOCUS_MS;
}

function createSession(key) {
  /** @type {Session} */
  const session = {
    key,
    participants: new Map(),
    todosByParticipant: new Map(),
    chat: [],
    timer: {
      mode: 'focus',
      isRunning: false,
      remainingMs: FOCUS_MS,
      endAt: null,
    },
    timerTimeout: null,
  };
  sessions.set(key, session);
  return session;
}

function getOrCreateSession(key) {
  return sessions.get(key) || createSession(key);
}

function serializeSession(session) {
  return {
    key: session.key,
    participants: Array.from(session.participants.values()),
    chat: session.chat,
    timer: session.timer,
  };
}

function getParticipantTodos(session, participantId) {
  return session.todosByParticipant.get(participantId) || [];
}

function setParticipantTodos(session, participantId, nextTodos) {
  session.todosByParticipant.set(participantId, nextTodos);
}

function computeProgress(todos) {
  const total = todos.length;
  const done = todos.reduce((acc, t) => acc + (t.completed ? 1 : 0), 0);
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function broadcastToSession(session, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const [clientId] of session.participants) {
    const ws = clientsById.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function stopTimerTimeout(session) {
  if (session.timerTimeout) {
    clearTimeout(session.timerTimeout);
    session.timerTimeout = null;
  }
}

function scheduleTimerTimeout(session) {
  stopTimerTimeout(session);
  if (!session.timer.isRunning || !session.timer.endAt) return;

  const delay = Math.max(0, session.timer.endAt - nowMs());
  session.timerTimeout = setTimeout(() => {
    // Timer done
    session.timer.isRunning = false;
    session.timer.remainingMs = 0;
    session.timer.endAt = null;

    broadcastToSession(session, {
      type: 'timer_update',
      payload: session.timer,
    });

    broadcastToSession(session, {
      type: 'timer_done',
      payload: { mode: session.timer.mode },
    });
  }, delay);
}

function startTimer(session) {
  if (session.timer.isRunning) return;

  const remaining = Math.max(0, session.timer.remainingMs);
  session.timer.isRunning = true;
  session.timer.endAt = nowMs() + remaining;

  scheduleTimerTimeout(session);
}

function pauseTimer(session) {
  if (!session.timer.isRunning) return;

  const remaining = session.timer.endAt ? Math.max(0, session.timer.endAt - nowMs()) : session.timer.remainingMs;
  session.timer.isRunning = false;
  session.timer.remainingMs = remaining;
  session.timer.endAt = null;

  stopTimerTimeout(session);
}

function resetTimer(session) {
  pauseTimer(session);
  session.timer.remainingMs = durationForMode(session.timer.mode);
}

function setTimerMode(session, mode) {
  pauseTimer(session);
  session.timer.mode = mode;
  session.timer.remainingMs = durationForMode(mode);
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

/** @type {Map<string, WebSocket>} */
const clientsById = new Map();
/** @type {Map<WebSocket, { clientId: string, sessionKey: string|null }>} */
const clientMeta = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const clientId = randomId();
  clientsById.set(clientId, ws);
  clientMeta.set(ws, { clientId, sessionKey: null });

  ws.send(
    JSON.stringify({
      type: 'welcome',
      payload: { clientId },
    })
  );

  ws.on('message', (buf) => {
    const raw = typeof buf === 'string' ? buf : buf.toString('utf8');
    const msg = safeJsonParse(raw);
    if (!msg || typeof msg.type !== 'string') return;

    const meta = clientMeta.get(ws);
    if (!meta) return;

    if (msg.type === 'hello') {
      const { sessionKey, name } = msg.payload || {};
      if (!isValidSessionKey(sessionKey) || typeof name !== 'string' || !name.trim()) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid hello payload' } }));
        return;
      }

      // Leave any previous session
      if (meta.sessionKey) {
        const oldSession = sessions.get(meta.sessionKey);
        if (oldSession) {
          oldSession.participants.delete(meta.clientId);
          broadcastToSession(oldSession, { type: 'participants_update', payload: Array.from(oldSession.participants.values()) });
        }
      }

      meta.sessionKey = sessionKey;
      const session = getOrCreateSession(sessionKey);
      session.participants.set(meta.clientId, { id: meta.clientId, name: name.trim() });

      // Ensure personal todo bucket exists
      if (!session.todosByParticipant.has(meta.clientId)) {
        session.todosByParticipant.set(meta.clientId, []);
      }

      ws.send(
        JSON.stringify({
          type: 'session_state',
          payload: {
            ...serializeSession(session),
            me: {
              id: meta.clientId,
              name: name.trim(),
            },
            myTodos: getParticipantTodos(session, meta.clientId),
          },
        })
      );
      broadcastToSession(session, { type: 'participants_update', payload: Array.from(session.participants.values()) });
      return;
    }

    if (!meta.sessionKey) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not in session' } }));
      return;
    }

    const session = sessions.get(meta.sessionKey);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Session missing' } }));
      return;
    }

    switch (msg.type) {
      case 'todo_add': {
        const { text } = msg.payload || {};
        if (typeof text !== 'string' || !text.trim()) return;
        const todo = { id: randomId(), text: text.trim(), completed: false };
        const current = getParticipantTodos(session, meta.clientId);
        const next = [...current, todo];
        setParticipantTodos(session, meta.clientId, next);
        ws.send(JSON.stringify({ type: 'todos_update', payload: { todos: next } }));
        break;
      }

      case 'todo_toggle': {
        const { id } = msg.payload || {};
        if (typeof id !== 'string') return;
        const current = getParticipantTodos(session, meta.clientId);
        const next = current.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t));
        setParticipantTodos(session, meta.clientId, next);
        ws.send(JSON.stringify({ type: 'todos_update', payload: { todos: next } }));
        break;
      }

      case 'todo_remove': {
        const { id } = msg.payload || {};
        if (typeof id !== 'string') return;
        const current = getParticipantTodos(session, meta.clientId);
        const next = current.filter((t) => t.id !== id);
        setParticipantTodos(session, meta.clientId, next);
        ws.send(JSON.stringify({ type: 'todos_update', payload: { todos: next } }));
        break;
      }

      case 'todos_peek': {
        const { participantId } = msg.payload || {};
        if (typeof participantId !== 'string') return;
        if (!session.participants.has(participantId)) return;
        const targetTodos = getParticipantTodos(session, participantId);
        const summary = computeProgress(targetTodos);
        ws.send(
          JSON.stringify({
            type: 'todos_peek',
            payload: {
              participantId,
              todos: targetTodos,
              progress: summary,
            },
          })
        );
        break;
      }

      case 'chat_send': {
        const { text } = msg.payload || {};
        if (typeof text !== 'string' || !text.trim()) return;

        const from = session.participants.get(meta.clientId);
        const message = {
          id: randomId(),
          fromId: meta.clientId,
          fromName: from ? from.name : 'Guest',
          text: text.trim().slice(0, 280),
          ts: nowMs(),
        };

        session.chat = [...session.chat, message].slice(-200);
        broadcastToSession(session, { type: 'chat_update', payload: { message } });
        break;
      }

      case 'timer_start': {
        startTimer(session);
        broadcastToSession(session, { type: 'timer_update', payload: session.timer });
        break;
      }

      case 'timer_pause': {
        pauseTimer(session);
        broadcastToSession(session, { type: 'timer_update', payload: session.timer });
        break;
      }

      case 'timer_reset': {
        resetTimer(session);
        broadcastToSession(session, { type: 'timer_update', payload: session.timer });
        break;
      }

      case 'timer_set_mode': {
        const { mode } = msg.payload || {};
        if (mode !== 'focus' && mode !== 'break') return;
        setTimerMode(session, mode);
        broadcastToSession(session, { type: 'timer_update', payload: session.timer });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const meta = clientMeta.get(ws);
    clientMeta.delete(ws);
    clientsById.delete(clientId);

    if (meta?.sessionKey) {
      const session = sessions.get(meta.sessionKey);
      if (session) {
        session.participants.delete(meta.clientId);
        broadcastToSession(session, { type: 'participants_update', payload: Array.from(session.participants.values()) });

        // GC empty sessions
        if (session.participants.size === 0) {
          stopTimerTimeout(session);
          sessions.delete(session.key);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[study-dashboard] WS server listening on http://localhost:${PORT}`);
});
