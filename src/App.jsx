import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { LiveAvatarSession, SessionEvent, AgentEventsEnum } from '@heygen/liveavatar-web-sdk';

/* ── Icons ─────────────────────────────────────────────────────── */
function SunIcon({ size = 36 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

/* ── Timer ──────────────────────────────────────────────────────── */
function useSessionTimer(isActive, onExpire) {
  const [secs, setSecs] = useState(15 * 60);
  useEffect(() => {
    if (!isActive) return;
    if (secs <= 0) { onExpire(); return; }
    const t = setTimeout(() => setSecs(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [isActive, secs, onExpire]);
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

/* ── Callback Form ──────────────────────────────────────────────── */
function CallbackForm({ customerData }) {
  const [date, setDate]   = useState('');
  const [time, setTime]   = useState('');
  const [notes, setNotes] = useState('');
  const [sent, setSent]   = useState(false);
  const [busy, setBusy]   = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/request-callback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: customerData.firstName, lastName: customerData.lastName,
          phone: customerData.phone, email: customerData.email,
          contact_id: customerData.contact_id,
          preferredDate: date, preferredTime: time, notes,
        }),
      });
      if (res.ok) setSent(true);
      else alert((await res.json()).error || 'Failed. Try again.');
    } catch { alert('Network error.'); }
    setBusy(false);
  };

  if (sent) return <div className="cb-success">✅ A Zeo Energy rep will call you on <strong>{date}</strong> at <strong>{time}</strong>.</div>;

  return (
    <form className="cb-form" onSubmit={handleSubmit}>
      <p className="cb-title">📅 Prefer a personal callback?</p>
      <div className="cb-row">
        <input type="date" required value={date} onChange={e => setDate(e.target.value)}
          min={new Date().toISOString().split('T')[0]} className="cb-input" />
        <input type="time" required value={time} onChange={e => setTime(e.target.value)} className="cb-input" />
      </div>
      <input type="text" placeholder="Notes for the rep (optional)" value={notes}
        onChange={e => setNotes(e.target.value)} className="cb-input cb-full" />
      <button type="submit" className="cb-submit" disabled={busy}>{busy ? 'Sending…' : 'Request Call →'}</button>
    </form>
  );
}

/* ── End Screen ──────────────────────────────────────────────────── */
function EndScreen({ customerData, searchParams }) {
  const agreementUrl = searchParams.get('agreement_url') || 'https://zeoenergy.enerflo.io';
  const parseNum = (v) => parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;
  const monthlySave = (parseNum(customerData.oldBill) - parseNum(customerData.newPayment)).toFixed(0);
  const fullName = [customerData.firstName, customerData.lastName].filter(Boolean).join(' ');

  const handleRestart = () => window.location.reload();

  return (
    <div className="end-screen">
      <div className="end-card fade-up">
        <div className="end-badge">Session Complete</div>
        <h1 className="end-heading">Thank you{fullName ? `, ${customerData.firstName}` : ''}!</h1>
        <p className="end-sub">Here's a summary of what we covered today.</p>

        <div className="end-stats">
          <div className="end-stat"><span className="end-stat-label">System</span><span className="end-stat-val">{customerData.systemSize}</span></div>
          <div className="end-stat"><span className="end-stat-label">Offset</span><span className="end-stat-val">{customerData.offset}</span></div>
          <div className="end-stat"><span className="end-stat-label">Monthly Save</span><span className="end-stat-val green">~${monthlySave}</span></div>
          <div className="end-stat"><span className="end-stat-label">25-yr Savings</span><span className="end-stat-val blue">{customerData.savings}</span></div>
        </div>

        <a href={agreementUrl} target="_blank" rel="noopener noreferrer" className="btn-primary btn-lg">
          ✍️ Review Agreement
        </a>

        <CallbackForm customerData={customerData} />

        <button className="btn-restart" onClick={handleRestart}>
          🔄 Start New Session
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MAIN APP
   ════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [status, setStatus]             = useState('');
  const [loading, setLoading]           = useState(false);
  const [isStreaming, setIsStreaming]    = useState(false);
  const [hasStarted, setHasStarted]     = useState(false);
  const [hasError, setHasError]         = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // ── Stable refs (don't cause re-renders in event handlers) ────────
  const videoRef        = useRef(null);
  const sessionRef      = useRef(null);
  const isConnectedRef  = useRef(false);   // true while WebRTC is live
  const didStreamRef    = useRef(false);   // true once video has been received
  const manualEndRef    = useRef(false);   // true only when the user clicks "End"
  const dataInjectedRef = useRef(false);   // true after we fire the proposal message
  const keepAliveRef    = useRef(null);    // setInterval handle for keepAlive pings
  const speakCountRef   = useRef(0);       // count of AVATAR_SPEAK_ENDED events
  const bargeInTimer    = useRef(null);    // debounce handle for barge-in interrupt

  // ── Parse URL params (memoized — only recalculates if URL changes) ─
  const sp = useMemo(() => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''), []);
  const cd = useMemo(() => ({
    firstName:  sp.get('firstName')  || '',
    lastName:   sp.get('lastName')   || '',
    phone:      sp.get('phone')      || '',
    email:      sp.get('email')      || '',
    contact_id: sp.get('contact_id') || '',
    systemSize: sp.get('size')       || '7.29 kW',
    panels:     sp.get('panels')     || '18 Qcells 405W panels',
    offset:     sp.get('offset')     || '92%',
    oldBill:    sp.get('oldBill')    || '$148',
    newPayment: sp.get('newPayment') || '$118',
    savings:    sp.get('savings')    || '$19,103',
  }), [sp]);
  const fullName = useMemo(() => [cd.firstName, cd.lastName].filter(Boolean).join(' '), [cd.firstName, cd.lastName]);
  const greeting = cd.firstName ? `Hi ${cd.firstName}!` : '';

  // ── Timer ─────────────────────────────────────────────────────
  const handleExpire = useCallback(() => {
    manualEndRef.current = true; // timer expiry is a graceful end
    clearInterval(keepAliveRef.current);
    if (sessionRef.current) sessionRef.current.stop().catch(() => {});
    setSessionEnded(true);
  }, []);
  const timeLeft = useSessionTimer(isStreaming, handleExpire);
  const timerLow = (() => {
    const parts = timeLeft.split(':');
    return parseInt(parts[0], 10) < 2;
  })();

  // ── Fullscreen ────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  // ── Internal session start (called on initial start + reconnect) ─
  const startSession = useCallback(async (token) => {
    const session = new LiveAvatarSession(token, { voiceChat: true });
    sessionRef.current = session;
    isConnectedRef.current  = false;
    didStreamRef.current    = false;

    // ── STREAM READY ─────────────────────────────────────────────
    session.on(SessionEvent.SESSION_STREAM_READY, () => {
      if (videoRef.current) session.attach(videoRef.current);
      isConnectedRef.current = true;
      didStreamRef.current   = true;
      setIsStreaming(true);
      setReconnecting(false);
      setStatus('');

      // Start keepAlive pings every 25 seconds to prevent server timeout
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = setInterval(async () => {
        if (isConnectedRef.current && sessionRef.current) {
          try { await sessionRef.current.keepAlive(); }
          catch (e) { console.warn('keepAlive failed:', e); }
        }
      }, 25_000);
    });

    // ── AVATAR SPOKE — inject data after the first sentence ──────
    // We wait for AVATAR_SPEAK_ENDED (first time) so the audio pipeline
    // is fully warmed up before sending the proposal data message.
    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      speakCountRef.current += 1;
      if (speakCountRef.current === 1 && !dataInjectedRef.current) {
        dataInjectedRef.current = true;
        const nameCtx = fullName ? `The customer's name is ${cd.firstName} ${cd.lastName}.` : '';
        try {
          session.message(
            `[CUSTOMER PROPOSAL DATA — use these exact numbers when discussing their solar plan]\n` +
            `${nameCtx}\n` +
            `System Size: ${cd.systemSize}\n` +
            `Panels: ${cd.panels}\n` +
            `Energy Offset: ${cd.offset}\n` +
            `Current Monthly Electric Bill: ${cd.oldBill}\n` +
            `New Monthly Solar Payment: ${cd.newPayment} (zero money down via GoodLeap)\n` +
            `Estimated 25-Year Net Savings: ${cd.savings}\n` +
            `\nNow walk the customer through their proposal conversationally. Start by highlighting their monthly savings, then cover the system details, then ask if they have questions.`
          );
        } catch (e) { console.warn('Data injection failed:', e); }
      }
    });

    // ── DISCONNECT — reconnect if unexpected; end if intentional ─
    session.on(SessionEvent.SESSION_DISCONNECTED, () => {
      isConnectedRef.current = false;
      clearInterval(keepAliveRef.current);
      if (videoRef.current) videoRef.current.srcObject = null;
      setIsStreaming(false);

      if (manualEndRef.current) {
        // Intentional end → show end screen
        setSessionEnded(true);
        return;
      }

      if (didStreamRef.current) {
        // Unexpected drop after streaming started → attempt one reconnect
        setReconnecting(true);
        setStatus('Connection dropped. Reconnecting…');
        setTimeout(async () => {
          try {
            const r    = await fetch('/get-token', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const body = await r.json();
            if (!r.ok || !body.session_token) throw new Error('Failed to refresh token');
            speakCountRef.current   = 0;
            dataInjectedRef.current = false;
            await startSession(body.session_token);
            await sessionRef.current.start();
            if (isConnectedRef.current) {
              await sessionRef.current.voiceChat.start();
              sessionRef.current.startListening();
            }
          } catch (err) {
            console.error('Reconnect failed:', err);
            setReconnecting(false);
            setSessionEnded(true); // Give up and show end screen
          }
        }, 3_000);
      } else {
        // Never streamed successfully → return to landing with error
        setHasStarted(false);
        setHasError(true);
        setStatus('Connection failed. Please try again.');
        setLoading(false);
      }
    });

    // ── BARGE-IN — 300ms debounce so minor sounds don't interrupt ─
    session.on(AgentEventsEnum.USER_SPEAK_STARTED, () => {
      clearTimeout(bargeInTimer.current);
      bargeInTimer.current = setTimeout(() => {
        if (isConnectedRef.current && sessionRef.current) {
          try { sessionRef.current.interrupt(); } catch (_) {}
        }
      }, 300);
    });
    session.on(AgentEventsEnum.USER_SPEAK_ENDED, () => {
      clearTimeout(bargeInTimer.current);
    });

    await session.start();
    if (isConnectedRef.current) {
      await session.voiceChat.start();
      session.startListening();
    } else {
      // start() resolved but stream isn't ready yet — start voice after STREAM_READY
      session.on(SessionEvent.SESSION_STREAM_READY, async () => {
        try {
          await session.voiceChat.start();
          session.startListening();
        } catch (e) { console.warn('Voice start after STREAM_READY failed:', e); }
      });
    }
  }, [cd, fullName]);

  // ── Start Call (user-initiated) ───────────────────────────────
  const handleStart = useCallback(async () => {
    try {
      manualEndRef.current    = false;
      dataInjectedRef.current = false;
      speakCountRef.current   = 0;
      setLoading(true);
      setHasError(false);
      setStatus('Connecting to your Solar Advisor…');

      const res  = await fetch('/get-token', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok || !data.session_token) throw new Error(data.error || 'Token error');

      setHasStarted(true);
      setStatus('Setting up your session…');
      await startSession(data.session_token);

    } catch (err) {
      console.error('LiveAvatar error:', err);
      setHasError(true);
      setLoading(false);
      setStatus(err.message);
    }
  }, [startSession]);

  // ── End session (intentional) ─────────────────────────────────
  const handleEnd = useCallback(() => {
    manualEndRef.current = true;
    clearInterval(keepAliveRef.current);
    clearTimeout(bargeInTimer.current);
    if (sessionRef.current) sessionRef.current.stop().catch(() => {});
    setSessionEnded(true);
  }, []);

  // ── Cleanup on unmount (navigation away, etc.) ────────────────
  useEffect(() => {
    return () => {
      clearInterval(keepAliveRef.current);
      clearTimeout(bargeInTimer.current);
    };
  }, []);

  // ── Derived ───────────────────────────────────────────────────
  const parseNum = (v) => parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;
  const oldNum   = parseNum(cd.oldBill);
  const newNum   = parseNum(cd.newPayment);
  const savePct  = oldNum > 0 ? Math.round(((oldNum - newNum) / oldNum) * 100) : 0;

  if (sessionEnded) return <EndScreen customerData={cd} searchParams={sp} />;

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */
  return (
    <div className={`app ${isFullscreen ? 'app--fs' : ''}`}>

      {/* ── PRE-CALL: Landing Page ── */}
      {!hasStarted && (
        <div className="landing">
          {/* Animated bg orbs */}
          <div className="orb orb-1" /><div className="orb orb-2" /><div className="orb orb-3" />

          <div className="landing-card fade-up">
            <div className="landing-logo">
              <SunIcon size={42} />
              <span>Zeo Energy</span>
            </div>

            <h1 className="landing-heading">
              {greeting ? <>{greeting}<br /></> : null}
              Your Solar Proposal is Ready
            </h1>
            <p className="landing-sub">Chat with your AI Solar Advisor to walk through your custom design and savings.</p>

            {/* Quick stat pills */}
            <div className="stat-pills">
              <div className="pill"><span className="pill-label">System</span><span className="pill-value">{cd.systemSize}</span></div>
              <div className="pill"><span className="pill-label">Offset</span><span className="pill-value">{cd.offset}</span></div>
              <div className="pill pill--green"><span className="pill-label">Monthly</span><span className="pill-value">{cd.newPayment}</span></div>
              <div className="pill pill--blue"><span className="pill-label">25-yr Save</span><span className="pill-value">{cd.savings}</span></div>
            </div>

            <button className="btn-primary btn-lg" disabled={loading} onClick={handleStart}>
              {loading ? <span className="spin" /> : <>☀️ Start My Solar Consultation</>}
            </button>

            {hasError && <p className="err">{status}</p>}
            {loading && !hasError && <p className="loading-hint">{status}</p>}

            <p className="landing-fine">Powered by Zeo Energy AI • Takes about 5 minutes</p>
          </div>
        </div>
      )}

      {/* ── IN-CALL: Dashboard + Video ── */}
      {hasStarted && !isFullscreen && (
        <div className="call-layout">
          {/* Left: Metrics */}
          <aside className="call-sidebar fade-up">
            <div className="sidebar-brand">
              <SunIcon size={28} />
              <div>
                <strong className="brand-name">Zeo Energy</strong>
                <span className="brand-sub">{fullName ? `${fullName}'s Proposal` : 'Solar Proposal'}</span>
              </div>
            </div>

            {/* Savings bar */}
            <div className="save-block">
              <div className="save-header">
                <span>Monthly Comparison</span>
                <span className="save-badge">Save {savePct}%</span>
              </div>
              <div className="save-row">
                <span className="save-label">Old Bill</span>
                <div className="save-track"><div className="save-fill save-old" style={{ width: `${(oldNum / Math.max(oldNum, newNum, 1)) * 100}%` }} /></div>
                <span className="save-amt save-amt-old">{cd.oldBill}</span>
              </div>
              <div className="save-row">
                <span className="save-label">Solar</span>
                <div className="save-track"><div className="save-fill save-new" style={{ width: `${(newNum / Math.max(oldNum, newNum, 1)) * 100}%` }} /></div>
                <span className="save-amt save-amt-new">{cd.newPayment}</span>
              </div>
            </div>

            <div className="fact-grid">
              <div className="fact"><span className="fact-label">System Size</span><span className="fact-val">{cd.systemSize}</span></div>
              <div className="fact"><span className="fact-label">Panels</span><span className="fact-val">{cd.panels}</span></div>
              <div className="fact"><span className="fact-label">Offset</span><span className="fact-val">{cd.offset}</span></div>
              <div className="fact fact--accent"><span className="fact-label">25-yr Savings</span><span className="fact-val">{cd.savings}</span></div>
            </div>

            <div className="sidebar-cta">
              <a href={sp.get('agreement_url') || 'https://zeoenergy.enerflo.io'} target="_blank" rel="noopener noreferrer" className="btn-primary btn-sm">
                ✍️ Review Agreement
              </a>
            </div>
          </aside>

            {/* Right: Video */}
          <section className="call-video-area">
            <div className="video-frame">
              {!isStreaming && !reconnecting && (
                <div className="video-placeholder">
                  <div className="pulse-ring" />
                  <p className="ph-text">{status || 'Connecting…'}</p>
                </div>
              )}
              {reconnecting && (
                <div className="video-placeholder">
                  <div className="pulse-ring" style={{ borderTopColor: '#f59e0b' }} />
                  <p className="ph-text" style={{ color: '#f59e0b' }}>Connection dropped &mdash; Reconnecting…</p>
                </div>
              )}
              <video ref={videoRef} className={`main-video${isFullscreen ? ' main-video--fs' : ''}`} autoPlay playsInline style={{ opacity: isStreaming ? 1 : 0 }} />
            </div>

            {/* Controls bar */}
            <div className="controls">
              <div className="ctrl-left">
                {isStreaming && <span className={`timer${timerLow ? ' timer--low' : ''}`}>⏱ {timeLeft}</span>}
              </div>
              <div className="ctrl-center">
                <button className="ctrl-btn ctrl-end" onClick={handleEnd} title="End call">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                </button>
              </div>
              <div className="ctrl-right">
                <button className="ctrl-btn" onClick={toggleFullscreen} title="Fullscreen">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ── FULLSCREEN OVERLAY (controls only — video moves via CSS) ── */}
      {hasStarted && isFullscreen && (
        <div className="fs-overlay">
          <div className="fs-top">
            <span className="fs-brand"><SunIcon size={20} /> Zeo Energy</span>
            {isStreaming && <span className={`fs-timer${timerLow ? ' timer--low' : ''}`}>⏱ {timeLeft}</span>}
          </div>
          <div className="fs-bottom">
            <button className="ctrl-btn" onClick={toggleFullscreen} title="Exit fullscreen">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" /></svg>
            </button>
            <button className="ctrl-btn ctrl-end" onClick={handleEnd} title="End call">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
