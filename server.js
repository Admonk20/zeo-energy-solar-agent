import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '100kb' }));

// Structured logger
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}]`;
  if (data !== undefined) console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](prefix, msg, data);
  else console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](prefix, msg);
}

// Rate limiters
const tokenLimiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Too many requests. Try again in a minute.' } });
const scrapeLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many scrape requests. Try again in a minute.' } });

// Serve the Vite build output in production
app.use(express.static(join(__dirname, 'dist')));

// Pre-warm Puppeteer import in the background (avoids cold-start delay on first scrape)
let puppeteerModule = null;
import('puppeteer').then(m => { puppeteerModule = m; }).catch(() => {});

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── POST /get-token ─────────────────────────────────────────────────────────
app.post('/get-token', tokenLimiter, async (req, res) => {
  try {
    const apiKey = process.env.HEYGEN_API_KEY;

    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
      return res.status(500).json({
        error: 'HEYGEN_API_KEY is not configured. Add your key to the .env file.',
      });
    }

    const response = await fetch('https://api.liveavatar.com/v1/sessions/token', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'FULL',
        avatar_id: process.env.HEYGEN_AVATAR_ID || '64b526e4-741c-43b6-a918-4e40f3261c7a',
        avatar_persona: {
          voice_id:   process.env.HEYGEN_VOICE_ID   || 'b139a8fe-7240-4454-ac37-8c68aebcee41',
          context_id: process.env.HEYGEN_CONTEXT_ID  || '5f8dad9d-0318-4bec-a981-fefe3f4bdab6',
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      log('ERROR', 'LiveAvatar API error:', data);
      return res.status(response.status).json({
        error: data.message || data.error || 'Failed to retrieve session token from LiveAvatar.',
      });
    }

    return res.json({ session_token: data.data?.session_token || data.data?.token || data.session_token || data.token });
  } catch (err) {
    log('ERROR', 'Server error in /get-token:', err.message);
    return res.status(500).json({
      error: 'Internal server error while fetching the session token.',
    });
  }
});

// ── Shared GHL intake handler ────────────────────────────────────────────────
async function handleGhlIntake(req, res) {
  try {
    const {
      first_name, last_name, phone, email,
      size, panels, offset, oldBill, newPayment, savings,
      agreement_url,
      contact_id,
    } = req.body;

    const fullName = [first_name, last_name].filter(Boolean).join(' ');

    const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const params = new URLSearchParams();
    if (first_name) params.set('firstName', first_name);
    if (last_name) params.set('lastName', last_name);
    if (size) params.set('size', size);
    if (panels) params.set('panels', panels);
    if (offset) params.set('offset', offset);
    if (oldBill) params.set('oldBill', oldBill);
    if (newPayment) params.set('newPayment', newPayment);
    if (savings) params.set('savings', savings);
    if (agreement_url) params.set('agreement_url', agreement_url);
    if (contact_id) params.set('contact_id', contact_id);

    const customerLink = `${baseUrl}/?${params.toString()}`;
    log('INFO', `📩 GHL intake | Customer: ${fullName} | ID: ${contact_id} | Link: ${customerLink}`);

    const ghlWebhookUrl = process.env.GHL_DELIVERY_WEBHOOK_URL;
    if (ghlWebhookUrl) {
      const ghlRes = await fetch(ghlWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id,
          contact_first_name: first_name,
          contact_last_name: last_name,
          contact_phone: phone,
          contact_email: email,
          proposal_link: customerLink,
        }),
      });
      if (!ghlRes.ok) {
        const txt = await ghlRes.text();
        log('ERROR', 'GHL webhook callback failed:', `${ghlRes.status} ${txt}`);
      } else {
        log('INFO', '✅ Link sent back to GHL successfully');
      }
    } else {
      log('WARN', 'GHL_DELIVERY_WEBHOOK_URL not set — link generated but not forwarded.');
    }

    return res.json({ success: true, link: customerLink });
  } catch (err) {
    log('ERROR', 'Error in GHL intake handler:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /api/ghl-intake ────────────────────────────────────────────────────
// Called BY GHL when a new solar proposal is ready.
app.post('/api/ghl-intake', handleGhlIntake);

// ── POST /api/send-link (Admin Panel manual trigger) ─────────────────────────
// Uses the same handler as /api/ghl-intake.
app.post('/api/send-link', handleGhlIntake);

// ── POST /api/request-callback ───────────────────────────────────────────────
// Called when the customer submits the "Request a Call" date/time form.
// We forward the scheduling request to GHL so a rep can follow up.
app.post('/api/request-callback', async (req, res) => {
  try {
    const { firstName, lastName, phone, email, contact_id, preferredDate, preferredTime, notes } = req.body;

    const ghlWebhookUrl = process.env.GHL_CALLBACK_WEBHOOK_URL
      || process.env.GHL_DELIVERY_WEBHOOK_URL;

    if (!ghlWebhookUrl) {
      return res.status(422).json({ error: 'GHL_CALLBACK_WEBHOOK_URL not configured yet.' });
    }

    const ghlRes = await fetch(ghlWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'callback_request',
        contact_id,
        contact_first_name: firstName,
        contact_last_name: lastName,
        contact_phone: phone,
        contact_email: email,
        preferred_date: preferredDate,
        preferred_time: preferredTime,
        notes: notes || '',
      }),
    });

    if (!ghlRes.ok) {
      const txt = await ghlRes.text();
      log('ERROR', 'GHL callback webhook failed:', `${ghlRes.status} ${txt}`);
      return res.status(502).json({ error: 'Failed to notify GHL. Try again.' });
    }

    log('INFO', `📅 Callback request from ${firstName} ${lastName} for ${preferredDate} at ${preferredTime}`);
    return res.json({ success: true });
  } catch (err) {
    log('ERROR', 'Error in /api/request-callback:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate-lead ──────────────────────────────────────────────────
// Accepts { name, email, id, url } — scrapes the Enerflo/proposal URL with
// Puppeteer, extracts the raw page text, then uses Anthropic to parse out the
// structured solar proposal metrics and returns them as JSON.
app.post('/api/generate-lead', scrapeLimiter, async (req, res) => {
  const { name, email, id, url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Validate URL scheme to prevent SSRF
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'URL must use http or https protocol.' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured in .env' });
  }

  let browser;
  try {
    // ── 1. Launch Puppeteer and scrape the page ───────────────────
    const puppeteer = puppeteerModule?.default || (await import('puppeteer')).default;
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Overall timeout: 45s for the entire scrape operation
    const scrapeTimeout = setTimeout(() => {
      if (browser) { browser.close().catch(() => {}); browser = null; }
    }, 45_000);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Extract all visible text from the rendered page
    const pageText = await page.evaluate(() => document.body.innerText);
    clearTimeout(scrapeTimeout);
    await browser.close();
    browser = null;

    if (!pageText || pageText.trim().length < 20) {
      return res.status(422).json({ error: 'Page loaded but contained no readable content.' });
    }

    log('INFO', `🔍 Scraped ${pageText.length} chars from: ${url}`);

    // ── 2. Send extracted text to Anthropic for structured extraction ─
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    const msg = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      temperature: 0,
      system: 'You are a data extraction assistant. I will provide raw text scraped from a Zeo Energy solar proposal. Extract the following specific metrics and return them STRICTLY as a valid JSON object: "systemSize", "panels", "offset", "oldBill", "newPayment", "savings". If a value is missing or cannot be determined, return "Not Found" for that key. Do not include any markdown formatting, code blocks, or extra text. Output ONLY the raw JSON object.',
      messages: [
        {
          role: 'user',
          content: pageText.slice(0, 50000), // Claude can handle larger contexts
        },
      ],
    });

    const raw = msg.content[0].text.trim();
    let proposalData;
    try {
      // Sometimes Claude might still wrap in ```json ... ```, so let's strip it if it exists
      const cleanRaw = raw.replace(/^```(json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      proposalData = JSON.parse(cleanRaw);
    } catch {
      proposalData = { parseError: 'Anthropic returned non-JSON', raw };
    }

    log('INFO', `✅ Proposal extracted for ${name || id}:`, proposalData);

    return res.json({
      status: 'success',
      customer: { name: name || '', email: email || '', id: id || '' },
      proposalData,
    });

  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) { }
    }
    log('ERROR', 'Error in /api/generate-lead:', err.message);
    return res.status(500).json({
      error: err.message || 'Unknown error in /api/generate-lead',
    });
  }
});

// API 404 — return JSON for unknown /api/* routes instead of HTML fallback
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

// SPA fallback — serve index.html for all non-API routes (production)
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log('INFO', `✅ Zeo Energy server running → http://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  log('INFO', `${signal} received — shutting down gracefully...`);
  server.close(() => {
    log('INFO', 'Server closed. Goodbye.');
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
