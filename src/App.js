import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const SESSION_KEY_RE = /^[A-Z0-9]{8}$/;
const FOCUS_SEC = 25 * 60;
const BREAK_SEC = 5 * 60;

const PERSIST_KEY = 'sandclock-session';

function getDefaultTimer() {
  return { mode: 'focus', isRunning: false, remainingMs: FOCUS_SEC * 1000, endAt: null };
}

function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    let screen = parsed.screen === 'session' ? 'session' : 'landing';
    const sessionKind = parsed.sessionKind === 'solo' || parsed.sessionKind === 'multi' ? parsed.sessionKind : null;
    const sessionKey = typeof parsed.sessionKey === 'string' && SESSION_KEY_RE.test(parsed.sessionKey) ? parsed.sessionKey : null;
    const guestName = typeof parsed.guestName === 'string' ? parsed.guestName.slice(0, 32) : '';

    // If required session fields are missing, don't force the session screen.
    if (screen === 'session') {
      if (!sessionKind) screen = 'landing';
      if (sessionKind === 'multi' && !sessionKey) screen = 'landing';
      if (sessionKind === 'solo' && !guestName.trim()) screen = 'landing';
    }

    let timer = null;
    let todos = null;
    let chat = null;

    if (sessionKind === 'solo') {
      const t = parsed.timer;
      if (t && typeof t === 'object') {
        const mode = t.mode === 'break' ? 'break' : 'focus';
        const isRunning = Boolean(t.isRunning);
        const remainingMs = clampToNonNegativeInt((t.remainingMs ?? 0) / 1) * 1;
        const endAt = typeof t.endAt === 'number' && Number.isFinite(t.endAt) ? t.endAt : null;
        timer = { mode, isRunning, remainingMs, endAt };
      }
      todos = Array.isArray(parsed.todos) ? parsed.todos : [];
      chat = Array.isArray(parsed.chat) ? parsed.chat : [];
    }

    return { screen, sessionKind, sessionKey, guestName, timer, todos, chat };
  } catch {
    return null;
  }
}

function clearPersistedSession() {
  try {
    localStorage.removeItem(PERSIST_KEY);
  } catch {
    // ignore
  }
}

function clampToNonNegativeInt(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function formatClock(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function normalizeSessionKey(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function generateSessionKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function getWsUrl() {
  // Allow override for deployments.
  if (process.env.REACT_APP_WS_URL) return process.env.REACT_APP_WS_URL;
  return 'ws://localhost:8080';
}

function useInterval(callback, delayMs) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs == null) return undefined;
    const id = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}

function App() {
  const persisted = useMemo(() => loadPersistedSession(), []);

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('sandclock-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore
    }

    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('sandclock-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  // Landing state
  const [screen, setScreen] = useState(() => persisted?.screen ?? 'landing'); // 'landing' | 'session'
  const [guestName, setGuestName] = useState(() => persisted?.guestName ?? '');
  const [landingMode, setLandingMode] = useState(null); // null | 'join' | 'create'
  const [joinKey, setJoinKey] = useState('');
  const [createKey, setCreateKey] = useState('');
  const [landingError, setLandingError] = useState('');

  // Session state
  const [sessionKind, setSessionKind] = useState(() => persisted?.sessionKind ?? null); // null | 'solo' | 'multi'
  const [sessionKey, setSessionKey] = useState(() => persisted?.sessionKey ?? null); // string | null
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // disconnected|connecting|connected
  const wsRef = useRef(null);

  const [participants, setParticipants] = useState(() => {
    if (persisted?.screen === 'session' && persisted?.sessionKind === 'solo' && persisted.guestName?.trim()) {
      const name = persisted.guestName.trim();
      return [{ id: 'solo', name }];
    }
    return [];
  });
  const [me, setMe] = useState(() => {
    if (persisted?.screen === 'session' && persisted?.sessionKind === 'solo' && persisted.guestName?.trim()) {
      const name = persisted.guestName.trim();
      return { id: 'solo', name };
    }
    return null;
  });

  const [todoDraft, setTodoDraft] = useState('');
  const [todos, setTodos] = useState(() => (persisted?.sessionKind === 'solo' && Array.isArray(persisted?.todos) ? persisted.todos : []));

  const [chatDraft, setChatDraft] = useState('');
  const [chat, setChat] = useState(() => (persisted?.sessionKind === 'solo' && Array.isArray(persisted?.chat) ? persisted.chat : []));
  const chatEndRef = useRef(null);

  const [hoverPeek, setHoverPeek] = useState({
    visible: false,
    x: 0,
    y: 0,
    participantId: null,
    participantName: '',
    loading: false,
    todos: [],
    progress: { done: 0, total: 0, pct: 0 },
  });

  const hoverParticipantIdRef = useRef(null);

  // Lofi player (local-only)
  const tracks = useMemo(
    () => [
      { title: 'Lofi Track 1', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
      { title: 'Lofi Track 2', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
      { title: 'Lofi Track 3', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
    ],
    []
  );
  const audioRef = useRef(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [musicVol, setMusicVol] = useState(0.3);

  const [timer, setTimer] = useState(() => {
    if (persisted?.sessionKind === 'solo' && persisted?.timer) return persisted.timer;
    return getDefaultTimer();
  });

  const [banner, setBanner] = useState('');
  const wsUrl = useMemo(() => getWsUrl(), []);

  // Persist session so reload resumes unless user explicitly leaves.
  useEffect(() => {
    try {
      if (screen !== 'session' || !sessionKind) {
        localStorage.removeItem(PERSIST_KEY);
        return;
      }

      const payload = {
        screen,
        sessionKind,
        sessionKey: sessionKind === 'multi' ? sessionKey : null,
        guestName,
      };

      if (sessionKind === 'solo') {
        payload.timer = timer;
        payload.todos = todos;
        payload.chat = chat;
      }

      localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [screen, sessionKind, sessionKey, guestName, timer, todos, chat]);

  const effectiveRemainingSec = useMemo(() => {
    if (timer.isRunning && timer.endAt) {
      return clampToNonNegativeInt((timer.endAt - Date.now()) / 1000);
    }
    return clampToNonNegativeInt(timer.remainingMs / 1000);
  }, [timer]);

  useInterval(() => {
    // Force re-render for clock when running.
    if (timer.isRunning) {
      setTimer((t) => ({ ...t }));
    }
  }, 250);

  const completedCount = useMemo(() => todos.filter((t) => t.completed).length, [todos]);
  const progressPct = todos.length ? Math.round((completedCount / todos.length) * 100) : 0;

  function sendWs(type, payload) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type, payload }));
  }

  // WebSocket lifecycle
  useEffect(() => {
    if (screen !== 'session' || sessionKind !== 'multi' || !sessionKey) return undefined;

    setConnectionStatus('connecting');
    setBanner('');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const onOpen = () => {
      setConnectionStatus('connected');
      sendWs('hello', { sessionKey, name: guestName.trim() });
    };

    const onClose = () => {
      setConnectionStatus('disconnected');
    };

    const onError = () => {
      setConnectionStatus('disconnected');
      setBanner('Could not connect to session server.');
    };

    const onMessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'session_state': {
          const s = msg.payload;
          if (!s) return;
          if (s.me) setMe(s.me);
          setParticipants(Array.isArray(s.participants) ? s.participants : []);
          setChat(Array.isArray(s.chat) ? s.chat : []);
          setTodos(Array.isArray(s.myTodos) ? s.myTodos : []);
          if (s.timer) setTimer(s.timer);
          break;
        }
        case 'participants_update': {
          setParticipants(Array.isArray(msg.payload) ? msg.payload : []);
          break;
        }
        case 'todos_update': {
          const next = msg.payload?.todos;
          if (Array.isArray(next)) setTodos(next);
          break;
        }
        case 'todos_peek': {
          const pid = msg.payload?.participantId;
          if (!pid || pid !== hoverParticipantIdRef.current) return;
          const nextTodos = Array.isArray(msg.payload?.todos) ? msg.payload.todos : [];
          const prog = msg.payload?.progress;
          setHoverPeek((p) => ({
            ...p,
            loading: false,
            todos: nextTodos,
            progress: prog && typeof prog === 'object' ? prog : p.progress,
          }));
          break;
        }
        case 'chat_update': {
          const message = msg.payload?.message;
          if (!message) return;
          setChat((prev) => [...prev, message].slice(-200));
          break;
        }
        case 'timer_update': {
          if (msg.payload) setTimer(msg.payload);
          break;
        }
        case 'timer_done': {
          const mode = msg.payload?.mode;
          setBanner(mode === 'focus' ? 'Focus complete. Take a break?' : 'Break complete. Back to focus?');
          break;
        }
        case 'error': {
          const m = msg.payload?.message;
          if (typeof m === 'string') setBanner(m);
          break;
        }
        default:
          break;
      }
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    ws.addEventListener('message', onMessage);

    return () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('message', onMessage);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [screen, sessionKind, sessionKey, wsUrl, guestName]);

  // Auto-scroll chat
  useEffect(() => {
    if (!chatEndRef.current) return;
    chatEndRef.current.scrollIntoView({ block: 'end' });
  }, [chat.length, screen]);

  // Solo timer ticking
  useInterval(() => {
    if (screen !== 'session' || sessionKind !== 'solo') return;
    if (!timer.isRunning || !timer.endAt) return;
    const remainingMs = Math.max(0, timer.endAt - Date.now());
    if (remainingMs > 0) return;

    setTimer((t) => ({ ...t, isRunning: false, remainingMs: 0, endAt: null }));
    setBanner(timer.mode === 'focus' ? 'Focus complete. Take a break?' : 'Break complete. Back to focus?');
  }, 250);

  function startSessionSolo() {
    setLandingError('');
    const name = guestName.trim();
    if (!name) {
      setLandingError('Guest Name is required.');
      return;
    }

    setSessionKind('solo');
    setSessionKey(null);
    setMe({ id: 'solo', name });
    setParticipants([{ id: 'solo', name }]);
    setTodos([]);
    setChat([]);
    setTimer(getDefaultTimer());
    setScreen('session');
  }

  function startSessionMulti(key) {
    setLandingError('');
    const name = guestName.trim();
    const normalized = normalizeSessionKey(key);
    if (!name) {
      setLandingError('Guest Name is required.');
      return;
    }
    if (!SESSION_KEY_RE.test(normalized)) {
      setLandingError('Session Key must be 8 characters (A-Z, 0-9).');
      return;
    }

    setSessionKind('multi');
    setSessionKey(normalized);
    setParticipants([]);
    setTodos([]);
    setChat([]);
    setMe(null);
    setTimer(getDefaultTimer());
    setScreen('session');
  }

  function leaveSession() {
    clearPersistedSession();
    setScreen('landing');
    setSessionKind(null);
    setSessionKey(null);
    setLandingMode(null);
    setJoinKey('');
    setCreateKey('');
    setBanner('');
    setMe(null);
    setChat([]);
    setTodos([]);
  }

  function onTimerStartPause() {
    if (sessionKind === 'multi') {
      sendWs(timer.isRunning ? 'timer_pause' : 'timer_start', {});
      return;
    }

    // solo
    setTimer((t) => {
      if (t.isRunning) {
        const remaining = t.endAt ? Math.max(0, t.endAt - Date.now()) : t.remainingMs;
        return { ...t, isRunning: false, remainingMs: remaining, endAt: null };
      }
      return { ...t, isRunning: true, endAt: Date.now() + t.remainingMs };
    });
  }

  function onTimerReset() {
    if (sessionKind === 'multi') {
      sendWs('timer_reset', {});
      return;
    }
    setTimer((t) => ({ ...t, isRunning: false, remainingMs: t.mode === 'break' ? BREAK_SEC * 1000 : FOCUS_SEC * 1000, endAt: null }));
  }

  function onTimerModeToggle() {
    const nextMode = timer.mode === 'focus' ? 'break' : 'focus';
    if (sessionKind === 'multi') {
      sendWs('timer_set_mode', { mode: nextMode });
      return;
    }
    setTimer({ mode: nextMode, isRunning: false, remainingMs: nextMode === 'break' ? BREAK_SEC * 1000 : FOCUS_SEC * 1000, endAt: null });
  }

  function onTodoAdd(e) {
    e.preventDefault();
    const text = todoDraft.trim();
    if (!text) return;
    setTodoDraft('');

    if (sessionKind === 'multi') {
      sendWs('todo_add', { text });
      return;
    }

    setTodos((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, text, completed: false }]);
  }

  function onTodoToggle(id) {
    if (sessionKind === 'multi') {
      sendWs('todo_toggle', { id });
      return;
    }
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
  }

  function onTodoRemove(id) {
    if (sessionKind === 'multi') {
      sendWs('todo_remove', { id });
      return;
    }
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }

  function onChatSend(e) {
    e.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    setChatDraft('');

    if (sessionKind === 'multi') {
      sendWs('chat_send', { text });
      return;
    }

    // solo local echo
    const name = guestName.trim() || 'Guest';
    setChat((prev) =>
      [
        ...prev,
        { id: `${Date.now()}-${Math.random()}`, fromId: 'solo', fromName: name, text: text.slice(0, 280), ts: Date.now() },
      ].slice(-200)
    );
  }

  function nextTrack() {
    setTrackIndex((i) => (i + 1) % tracks.length);
  }

  function toggleMusic() {
    const audio = audioRef.current;
    if (!audio) return;
    if (musicPlaying) {
      audio.pause();
      setMusicPlaying(false);
    } else {
      audio.play().then(
        () => setMusicPlaying(true),
        () => setBanner('Browser blocked autoplay. Press Play again.')
      );
    }
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = musicVol;
  }, [musicVol]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = tracks[trackIndex].url;
    audio.load();
    if (musicPlaying) {
      audio.play().catch(() => setMusicPlaying(false));
    }
  }, [trackIndex, tracks, musicPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => setTrackIndex((i) => (i + 1) % tracks.length);
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, [tracks.length]);

  function onPersonEnter(e, p) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.right + 12;
    const y = rect.top;

    hoverParticipantIdRef.current = p.id;
    setHoverPeek({
      visible: true,
      x,
      y,
      participantId: p.id,
      participantName: p.name,
      loading: sessionKind === 'multi',
      todos: [],
      progress: { done: 0, total: 0, pct: 0 },
    });

    if (sessionKind === 'multi') {
      sendWs('todos_peek', { participantId: p.id });
    } else {
      // solo
      setHoverPeek((prev) => ({
        ...prev,
        loading: false,
        todos,
        progress: { done: completedCount, total: todos.length, pct: progressPct },
      }));
    }
  }

  function onPersonMove(e) {
    const x = e.clientX + 14;
    const y = e.clientY + 14;
    setHoverPeek((p) => (p.visible ? { ...p, x, y } : p));
  }

  function onPersonLeave() {
    hoverParticipantIdRef.current = null;
    setHoverPeek((p) => ({ ...p, visible: false, participantId: null }));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      setBanner('Copied!');
      setTimeout(() => setBanner(''), 1000);
    } catch {
      setBanner('Copy failed.');
    }
  }

  if (screen === 'landing') {
    return (
      <div className={`appRoot theme-${theme}`}>
        <div className="bgScene" aria-hidden="true">
          <div className="bgSky" />
          <div className="bgSand" />
          <div className="bgWind" />
          <svg className="bgBirds" viewBox="0 0 300 80" preserveAspectRatio="none">
            <path d="M20 55 q14 -18 28 0 q14 -18 28 0" />
            <path d="M110 35 q12 -14 24 0 q12 -14 24 0" />
            <path d="M210 50 q10 -12 20 0 q10 -12 20 0" />
          </svg>
          <div className="bgStars" />
          <div className="bgDunes" />
          <div className="bgNightWind" />
          <svg className="bgPalm palm1" viewBox="0 0 120 200">
            <path d="M60 190 C55 150 58 120 62 90 C66 60 70 35 72 10" />
            <path d="M72 18 C55 24 40 36 30 52" />
            <path d="M72 18 C88 28 102 42 112 60" />
            <path d="M70 28 C54 34 42 48 34 64" />
            <path d="M74 28 C90 38 102 54 108 72" />
          </svg>
          <svg className="bgPalm palm2" viewBox="0 0 120 200">
            <path d="M60 190 C56 155 54 125 56 98 C58 68 64 44 68 10" />
            <path d="M68 18 C52 26 38 40 26 60" />
            <path d="M68 18 C86 30 98 46 110 70" />
            <path d="M66 30 C52 38 40 54 32 74" />
            <path d="M70 30 C86 44 98 62 104 86" />
          </svg>
        </div>

        <div className="screen">
          <header className="titleBar">
            <div className="titleRow">
              <div>
                <div className="title">SANDCLOCK</div>
                <div className="subtitle">8-bit collaborative study sessions</div>
              </div>
              <button className="btn tiny" type="button" onClick={toggleTheme}>
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
            </div>
          </header>

          <div className="panel">
            <label className="label" htmlFor="guestName">
              Guest Name
            </label>
            <input
              id="guestName"
              className="input"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="Enter a name"
              maxLength={32}
              autoComplete="nickname"
            />

            <div className="row">
              <button className="btn" type="button" onClick={() => setLandingMode('join')}>
                Join Session
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setLandingMode('create');
                  const k = generateSessionKey();
                  setCreateKey(k);
                }}
              >
                Create Session
              </button>
              <button className="btn" type="button" onClick={startSessionSolo}>
                Solo Session
              </button>
            </div>

            {landingMode === 'join' && (
              <div className="subPanel">
                <label className="label" htmlFor="joinKey">
                  Session Key
                </label>
                <input
                  id="joinKey"
                  className="input mono"
                  value={joinKey}
                  onChange={(e) => setJoinKey(normalizeSessionKey(e.target.value))}
                  placeholder="8 chars: A-Z / 0-9"
                  inputMode="text"
                />
                <div className="row">
                  <button className="btn primary" type="button" onClick={() => startSessionMulti(joinKey)}>
                    Join
                  </button>
                  <button className="btn" type="button" onClick={() => setLandingMode(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {landingMode === 'create' && (
              <div className="subPanel">
                <div className="label">Session Key</div>
                <div className="keyRow">
                  <div className="key mono">{createKey}</div>
                  <button className="btn" type="button" onClick={() => copyText(createKey)}>
                    Copy
                  </button>
                </div>
                <div className="row">
                  <button className="btn primary" type="button" onClick={() => startSessionMulti(createKey)}>
                    Enter Session
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      const k = generateSessionKey();
                      setCreateKey(k);
                    }}
                  >
                    Re-roll Key
                  </button>
                  <button className="btn" type="button" onClick={() => setLandingMode(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {landingError && <div className="error">{landingError}</div>}
          </div>

          <footer className="footer">
            Tip: Share the Session Key to study together.
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className={`appRoot theme-${theme}`}>
      <div className="bgScene" aria-hidden="true">
        <div className="bgSky" />
        <div className="bgSand" />
        <div className="bgWind" />
        <svg className="bgBirds" viewBox="0 0 300 80" preserveAspectRatio="none">
          <path d="M20 55 q14 -18 28 0 q14 -18 28 0" />
          <path d="M110 35 q12 -14 24 0 q12 -14 24 0" />
          <path d="M210 50 q10 -12 20 0 q10 -12 20 0" />
        </svg>
        <div className="bgStars" />
        <div className="bgDunes" />
        <div className="bgNightWind" />
        <svg className="bgPalm palm1" viewBox="0 0 120 200">
          <path d="M60 190 C55 150 58 120 62 90 C66 60 70 35 72 10" />
          <path d="M72 18 C55 24 40 36 30 52" />
          <path d="M72 18 C88 28 102 42 112 60" />
          <path d="M70 28 C54 34 42 48 34 64" />
          <path d="M74 28 C90 38 102 54 108 72" />
        </svg>
        <svg className="bgPalm palm2" viewBox="0 0 120 200">
          <path d="M60 190 C56 155 54 125 56 98 C58 68 64 44 68 10" />
          <path d="M68 18 C52 26 38 40 26 60" />
          <path d="M68 18 C86 30 98 46 110 70" />
          <path d="M66 30 C52 38 40 54 32 74" />
          <path d="M70 30 C86 44 98 62 104 86" />
        </svg>
      </div>

      <div className="screen">
        <header className="titleBar">
          <div className="titleRow">
            <div>
              <div className="title">SANDCLOCK</div>
              <div className="subtitle">
                {sessionKind === 'solo' ? 'Solo Session' : `Key: ${sessionKey}`} · Guest: {guestName.trim()}
                {sessionKind === 'multi' && ` · ${connectionStatus}`}
              </div>
            </div>
            <button className="btn tiny" type="button" onClick={toggleTheme}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </header>

        {banner && <div className="banner">{banner}</div>}

        <div className="layout">
          <div className="mainCol">
            <div className="panel">
            <div className="panelTitle">Pomodoro</div>
            <div className="timerMode">{timer.mode === 'break' ? 'BREAK' : 'FOCUS'}</div>
            <div className="timerClock mono">{formatClock(effectiveRemainingSec)}</div>
            <div className="row">
              <button className="btn primary" type="button" onClick={onTimerStartPause}>
                {timer.isRunning ? 'Pause' : 'Start'}
              </button>
              <button className="btn" type="button" onClick={onTimerReset}>
                Reset
              </button>
              <button className="btn" type="button" onClick={onTimerModeToggle}>
                Switch
              </button>
            </div>
          </div>

            <div className="panel">
            <div className="panelTitle">To-Do</div>

            <form onSubmit={onTodoAdd} className="row">
              <input
                className="input"
                value={todoDraft}
                onChange={(e) => setTodoDraft(e.target.value)}
                placeholder="Add task"
                maxLength={80}
              />
              <button className="btn primary" type="submit">
                Add
              </button>
            </form>

            <div className="progress">
              <div className="progressTrack">
                <div className="progressFill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="progressLabel mono">
                {completedCount}/{todos.length}
              </div>
            </div>

            <div className="todoList">
              {todos.length === 0 ? (
                <div className="muted">No tasks yet.</div>
              ) : (
                todos.map((t) => (
                  <div key={t.id} className={`todoItem ${t.completed ? 'done' : ''}`}>
                    <button className="todoToggle" type="button" onClick={() => onTodoToggle(t.id)}>
                      {t.completed ? '✓' : ' '}
                    </button>
                    <div className="todoText" onClick={() => onTodoToggle(t.id)} role="button" tabIndex={0}>
                      {t.text}
                    </div>
                    <button className="todoRemove" type="button" onClick={() => onTodoRemove(t.id)}>
                      X
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

            <div className="panel">
            <div className="panelTitle">Lofi</div>
            <audio ref={audioRef} />

            <div className="muted">Now playing</div>
            <div className="mono" style={{ fontSize: 11, marginTop: 6 }}>
              {tracks[trackIndex].title}
            </div>

            <div className="row">
              <button className="btn primary" type="button" onClick={toggleMusic}>
                {musicPlaying ? 'Pause' : 'Play'}
              </button>
              <button className="btn" type="button" onClick={nextTrack}>
                Next
              </button>
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="label">Volume</div>
              <input
                className="range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={musicVol}
                onChange={(e) => setMusicVol(Number(e.target.value))}
              />
            </div>
          </div>

          </div>

          <div className="sideCol">
            <div className="panel">
              <div className="panelTitle">Chat</div>
              <div className="chatLog">
                {chat.length === 0 ? (
                  <div className="muted">No messages yet.</div>
                ) : (
                  chat.map((m) => (
                    <div key={m.id} className="chatMsg">
                      <span className="chatFrom">{m.fromName}:</span> <span className="chatText">{m.text}</span>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>

              <form onSubmit={onChatSend} className="row" style={{ marginTop: 12 }}>
                <input
                  className="input"
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  placeholder={sessionKind === 'multi' ? 'Message…' : 'Message (solo)…'}
                  maxLength={280}
                />
                <button className="btn primary" type="submit">
                  Send
                </button>
              </form>
            </div>

            <div className="panel">
              <div className="panelTitle">People</div>
              <div className="peopleList">
                {(participants.length ? participants : [{ id: 'loading', name: '…' }]).map((p) => (
                  <div
                    key={p.id}
                    className={`person ${me?.id === p.id ? 'me' : ''}`}
                    onMouseEnter={(e) => onPersonEnter(e, p)}
                    onMouseMove={onPersonMove}
                    onMouseLeave={onPersonLeave}
                  >
                    {p.name}
                  </div>
                ))}
              </div>

              {sessionKind === 'multi' && sessionKey && (
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" type="button" onClick={() => copyText(sessionKey)}>
                    Copy Key
                  </button>
                </div>
              )}

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" type="button" onClick={leaveSession}>
                  Leave
                </button>
              </div>
            </div>
          </div>
        </div>

        {hoverPeek.visible && (
          <div className="peek" style={{ left: hoverPeek.x, top: hoverPeek.y }}>
            <div className="peekTitle">{hoverPeek.participantName}</div>
            {hoverPeek.loading ? (
              <div className="muted">Loading tasks…</div>
            ) : (
              <>
                <div className="peekProgress">
                  <div className="progressTrack">
                    <div className="progressFill" style={{ width: `${hoverPeek.progress?.pct ?? 0}%` }} />
                  </div>
                  <div className="progressLabel mono">
                    {hoverPeek.progress?.done ?? 0}/{hoverPeek.progress?.total ?? 0}
                  </div>
                </div>
                <div className="peekTodos">
                  {hoverPeek.todos.length === 0 ? (
                    <div className="muted">No tasks.</div>
                  ) : (
                    hoverPeek.todos.slice(0, 8).map((t) => (
                      <div key={t.id} className={`peekTodo ${t.completed ? 'done' : ''}`}>
                        {t.completed ? '✓' : '·'} {t.text}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;