# Legible - On-Device Article Narration

Live at https://nathanhominiuk.github.io/narration-app-ios/ until GitHub tries to make me pay for hosting

---

## Deploy

```bash
# 1. Create a new GitHub repo (e.g. "legible")
# 2. Push these three files to the main branch:
git init
git add index.html manifest.json sw.js
git commit -m "Initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/legible.git
git push -u origin main

# 3. Enable GitHub Pages:
#    Repo → Settings → Pages → Source: main branch / root
#    Your app is live at: https://YOUR_USERNAME.github.io/legible/
```

Or drag the folder into github.com/new and use the web editor.

---

## Install on iPhone

1. Open `https://YOUR_USERNAME.github.io/legible/` in **Safari**
2. Tap the **Share** button → **Add to Home Screen** → Add
3. Opens fullscreen, works offline after first load

---

## Features

- **On-device Neural TTS** — Apple's built-in voices, no API keys
- **Accurate word highlighting** — uses `charIndex` + `charLength` from
  the Web Speech API's boundary events to highlight the exact word being spoken
- **Tap any word** to jump to that point instantly
- **Lock screen controls** — play/pause and skip work from the lock screen
  via the MediaSession API
- **Progress saved** — localStorage persists your position per article;
  reopen and pick up where you left off (saved for 30 days)
- **Skip ±15s**, scrub bar, 8 playback speeds (0.7× – 2×)
- **URL mode** — fetches via allorigins.win CORS proxy
- **Paste mode** — for paywalled articles, copy-paste the text directly
- **PWA** — installable, cached, works offline for previously loaded articles

---

## Add more voices

Settings → Accessibility → Spoken Content → Voices → English →
download Ava, Nathan, Nicky, or any other Neural voice.
Legible will automatically use the best available en-US voice.
