# Haan OCR Proxy (Cloudflare Worker)

Securely proxies receipt images from **Haan** to **Gemini 2.5 Flash-Lite** (~฿0.01/receipt) with automatic escalation to **Gemini 2.5 Flash** if any item is missed.

## Deploy in 2 Minutes (Option A: Cloudflare Dashboard — No CLI)
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker** (name it `haan-ocr`).
2. Click **Edit code**, paste the contents of `worker.js`, and click **Deploy**.
3. Go to **Settings → Variables and Secrets** → add:
   - Secret: `GEMINI_API_KEY` = your Google AI Studio API key
   - Variable (optional): `ALLOWED_ORIGINS` = `https://oboun.github.io,http://localhost:8765`
4. Copy your Worker URL (e.g. `https://haan-ocr.<your-subdomain>.workers.dev`) and paste it into `OCR_WORKER_URL` at the top of `ocr.js`.

## Deploy via CLI (Option B: Wrangler)
```bash
cd worker
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```
Then copy the printed `https://haan-ocr.*.workers.dev` URL into `OCR_WORKER_URL` in `ocr.js`.
