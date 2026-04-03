import { useState } from 'react';

/* ── Admin Panel — Internal use by Zeo Energy sales reps ──────── */
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN || '2025';

/* ── Field mapping: API response keys → form keys ─────────────── */
const FIELD_MAP = {
  systemSize:  'size',
  panels:      'panels',
  offset:      'offset',
  oldBill:     'oldBill',
  newPayment:  'newPayment',
  savings:     'savings',
};

export default function Admin() {
  const [pin, setPin]         = useState('');
  const [authed, setAuthed]   = useState(false);
  const [pinError, setPinError] = useState(false);
  const [copied, setCopied]   = useState(false);

  // ── AI Auto-fill state (isolated — doesn't affect any other state) ──
  const [autoFillUrl,    setAutoFillUrl]    = useState('');
  const [autoFillStatus, setAutoFillStatus] = useState(null); // null | 'loading' | 'ok' | 'error'
  const [autoFillMsg,    setAutoFillMsg]    = useState('');

  const handleAutoFill = async () => {
    if (!autoFillUrl.trim()) return;
    setAutoFillStatus('loading');
    setAutoFillMsg('Analysing proposal with Claude AI…');
    try {
      const res  = await fetch('/api/generate-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: autoFillUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'API error');

      const proposal = data.proposalData || {};
      // Map response keys → form keys using FIELD_MAP; skip 'Not Found' values
      setForm(prev => {
        const updated = { ...prev };
        for (const [apiKey, formKey] of Object.entries(FIELD_MAP)) {
          const val = proposal[apiKey];
          if (val && val !== 'Not Found') updated[formKey] = String(val);
        }
        return updated;
      });
      setAutoFillStatus('ok');
      setAutoFillMsg('✅ Fields filled! Review and adjust if needed.');
    } catch (err) {
      setAutoFillStatus('error');
      setAutoFillMsg(`❌ ${err.message}`);
    }
  };

  const [sendingLink, setSendingLink] = useState(false);

  const [form, setForm] = useState({
    firstName:   '',
    lastName:    '',
    phone:       '',
    email:       '',
    size:        '',
    panels:      '',
    offset:      '',
    oldBill:     '',
    newPayment:  '',
    savings:     '',
    agreementUrl: '',
    bookingUrl:  '',
  });

  const handlePinSubmit = (e) => {
    e.preventDefault();
    if (pin === ADMIN_PIN) { setAuthed(true); setPinError(false); }
    else { setPinError(true); }
  };

  const buildLink = () => {
    const base = window.location.origin;
    const params = new URLSearchParams();
    if (form.firstName)    params.set('firstName', form.firstName);
    if (form.lastName)     params.set('lastName', form.lastName);
    if (form.phone)        params.set('phone', form.phone);
    if (form.email)        params.set('email', form.email);
    if (form.size)         params.set('size', form.size);
    if (form.panels)       params.set('panels', form.panels);
    if (form.offset)       params.set('offset', form.offset);
    if (form.oldBill)      params.set('oldBill', form.oldBill);
    if (form.newPayment)   params.set('newPayment', form.newPayment);
    if (form.savings)      params.set('savings', form.savings);
    if (form.agreementUrl) params.set('agreement_url', form.agreementUrl);
    if (form.bookingUrl)   params.set('booking_url', form.bookingUrl);
    return `${base}/?${params.toString()}`;
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(buildLink());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleSendLink = async () => {
    setSendingLink(true);
    try {
      const res = await fetch('/api/send-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: form.firstName,
          last_name:  form.lastName,
          phone:      form.phone,
          email:      form.email,
          size:       form.size,
          panels:     form.panels,
          offset:     form.offset,
          oldBill:    form.oldBill,
          newPayment: form.newPayment,
          savings:    form.savings,
          agreement_url: form.agreementUrl,
          contact_id: '',
          link: buildLink(),
        }),
      });
      const data = await res.json();
      alert(res.ok ? '✅ SMS + Email sent to customer!' : `❌ ${data.error}`);
    } catch (err) {
      alert(`❌ Network error: ${err.message}`);
    }
    setSendingLink(false);
  };

  const update = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

  if (!authed) {
    return (
      <main className="admin-login">
        <div className="admin-card">
          <h1 className="admin-title">🔒 Zeo Energy Admin</h1>
          <p className="admin-sub">Enter your access PIN to continue</p>
          <form onSubmit={handlePinSubmit} className="pin-form">
            <input
              type="password" placeholder="Enter PIN" value={pin}
              onChange={e => setPin(e.target.value)} className="pin-input"
              autoFocus maxLength={8}
            />
            {pinError && <p className="pin-error">Incorrect PIN. Try again.</p>}
            <button type="submit" className="cta-btn" style={{ marginTop: '1rem' }}>Unlock →</button>
          </form>
        </div>
      </main>
    );
  }

  const generatedLink = buildLink();

  return (
    <main className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-logo">
          <span className="admin-logo-icon">☀️</span>
          <div>
            <strong>Zeo Energy</strong>
            <small>Sales Admin Panel</small>
          </div>
        </div>
        <nav className="admin-nav">
          <span className="admin-nav-item active">🔗 Generate Link</span>
        </nav>
      </aside>

      <section className="admin-main">
        <div className="admin-header-row">
          <h1 className="admin-page-title">Generate Proposal Link</h1>
          <p className="admin-page-sub">Fill in the customer's solar proposal details, then copy + send the link via SMS/Email.</p>
        </div>

        {/* ── AI Auto-fill ─────────────────────────────────────────── */}
        <div className="admin-section" style={{ marginBottom: '1.5rem' }}>
          <h3 className="admin-section-title">⚡ AI Auto-fill from Proposal URL</h3>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted, #8a9bb0)', marginBottom: '0.75rem' }}>
            Paste the Enerflo proposal link and Claude AI will extract all the figures automatically.
          </p>
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'stretch' }}>
            <input
              placeholder="https://zeoenergy.enerflo.io/proposals/..."
              value={autoFillUrl}
              onChange={e => setAutoFillUrl(e.target.value)}
              style={{ flex: 1 }}
              onKeyDown={e => e.key === 'Enter' && handleAutoFill()}
            />
            <button
              className="cta-btn"
              onClick={handleAutoFill}
              disabled={autoFillStatus === 'loading' || !autoFillUrl.trim()}
              style={{ whiteSpace: 'nowrap', padding: '0 1.2rem' }}
            >
              {autoFillStatus === 'loading' ? '⏳ Scanning…' : '🤖 AI Auto-fill'}
            </button>
          </div>
          {autoFillMsg && (
            <p style={{
              marginTop: '0.5rem',
              fontSize: '0.82rem',
              color: autoFillStatus === 'ok' ? '#22c55e' : autoFillStatus === 'error' ? '#f87171' : '#94a3b8',
            }}>{autoFillMsg}</p>
          )}
        </div>

        <div className="admin-form-grid">
          {/* Customer Info */}
          <div className="admin-section">
            <h3 className="admin-section-title">Customer Info</h3>
            <div className="form-row-grid">
              <div className="form-row">
                <label>First Name</label>
                <input placeholder="John" value={form.firstName} onChange={update('firstName')} />
              </div>
              <div className="form-row">
                <label>Last Name</label>
                <input placeholder="Smith" value={form.lastName} onChange={update('lastName')} />
              </div>
            </div>
            <div className="form-row">
              <label>Phone (with country code)</label>
              <input placeholder="+1 555 000 0000" value={form.phone} onChange={update('phone')} />
            </div>
            <div className="form-row">
              <label>Email Address</label>
              <input placeholder="john@email.com" value={form.email} onChange={update('email')} />
            </div>
          </div>

          {/* Proposal Figures */}
          <div className="admin-section">
            <h3 className="admin-section-title">Proposal Figures</h3>
            <div className="form-row-grid">
              <div className="form-row">
                <label>System Size</label>
                <input placeholder="7.29 kW" value={form.size} onChange={update('size')} />
              </div>
              <div className="form-row">
                <label>Energy Offset</label>
                <input placeholder="92%" value={form.offset} onChange={update('offset')} />
              </div>
              <div className="form-row">
                <label>Old Utility Bill</label>
                <input placeholder="$148" value={form.oldBill} onChange={update('oldBill')} />
              </div>
              <div className="form-row">
                <label>New Solar Payment</label>
                <input placeholder="$118" value={form.newPayment} onChange={update('newPayment')} />
              </div>
              <div className="form-row" style={{ gridColumn: 'span 2' }}>
                <label>25-Year Savings</label>
                <input placeholder="$19,103" value={form.savings} onChange={update('savings')} />
              </div>
              <div className="form-row" style={{ gridColumn: 'span 2' }}>
                <label>Panel Equipment</label>
                <input placeholder="18 Qcells 405W panels" value={form.panels} onChange={update('panels')} />
              </div>
            </div>
          </div>

          {/* CTA URLs */}
          <div className="admin-section">
            <h3 className="admin-section-title">Button Links (optional)</h3>
            <div className="form-row">
              <label>Agreement / Signing URL</label>
              <input placeholder="https://zeoenergy.enerflo.io/proposals/..." value={form.agreementUrl} onChange={update('agreementUrl')} />
            </div>
            <div className="form-row">
              <label>Booking / Calendar URL</label>
              <input placeholder="https://calendly.com/zeoenergy" value={form.bookingUrl} onChange={update('bookingUrl')} />
            </div>
          </div>
        </div>

        {/* Generated Link */}
        <div className="admin-link-box">
          <h3 className="admin-section-title">Generated Proposal Link</h3>
          <div className="link-display">
            <span className="link-text">{generatedLink}</span>
          </div>
          <div className="link-actions">
            <button className="link-btn link-btn-copy" onClick={handleCopy}>
              {copied ? '✅ Copied!' : '📋 Copy Link'}
            </button>
            <button className="link-btn link-btn-send" onClick={handleSendLink} disabled={sendingLink || (!form.phone && !form.email)}>
              {sendingLink ? '⏳ Sending…' : '🚀 Send via SMS + Email'}
            </button>
          </div>
          <p className="link-hint">"Send via SMS + Email" will be active once Twilio/Resend credentials are configured.</p>
        </div>
      </section>
    </main>
  );
}
