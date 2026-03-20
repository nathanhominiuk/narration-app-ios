# Legible – Narration App

## Overview
Zero-dependency vanilla JS PWA that converts articles to audio narration using the Web Speech API. Single HTML file (`index.html`) with embedded CSS/JS, plus `sw.js` (service worker) and `manifest.json` (PWA manifest).

## Deployment
- **GitHub Pages**: https://nathanhominiuk.github.io/narration-app-ios/
- Deploys from `main` branch, root directory — no build step, no CI/CD
- Subpath: `/narration-app-ios/` — all paths must be relative or account for this

## Architecture
- **Article fetching**: CORS proxy chain (codetabs primary, allorigins fallback) → DOMParser → content extraction
- **Narration**: Web Speech API (`speechSynthesis`) with word-level boundary tracking
- **Persistence**: localStorage (30-day expiry) for playback progress
- **PWA**: Service worker caches shell files; network-only for article fetches

## Key Functions (index.html)
- `fetchArticle(url)` — fetches via CORS proxy with fallback chain
- `extractArticle(doc, url)` — parses DOM to extract title, source, paragraphs
- `startListening()` — orchestrates URL/paste input → fetch → narration
- `beginNarration(article)` — tokenizes, renders transcript, starts speech
- `playFromWord(idx)` — seeks to word index and queues utterances

## Testing
No automated tests. Manual testing:
1. Load the GH Pages URL
2. Paste an article URL (e.g., NPR, Ars Technica) and click Listen
3. Verify article text loads, narration plays, word highlighting works
