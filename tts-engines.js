// ═══════════════════════════════════════════
//  TTS Engine Abstraction Layer
//  Base class + WebSpeechEngine + AudioBufferPlayer
// ═══════════════════════════════════════════
'use strict';

// ── Base class ──────────────────────────────
export class TTSEngine {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.status = 'not-loaded'; // 'not-loaded' | 'loading' | 'ready' | 'error'
    this._voiceId = null;
    this._rate = 1;
  }
  async init(onProgress) { throw new Error('Not implemented'); }
  async speak(text, opts) { throw new Error('Not implemented'); }
  pause() {}
  resume() {}
  stop() {}
  async getVoices() { return []; }
  setVoice(voiceId) { this._voiceId = voiceId; }
  setRate(rate) { this._rate = rate; }
  getCapabilities() { return { pitch: false, rate: true, volume: false, voices: false }; }
}

// ── WebSpeechEngine ─────────────────────────
export class WebSpeechEngine extends TTSEngine {
  constructor() {
    super('web-speech', 'System');
    this._utterances = [];
    this._currentUttIdx = 0;
    this._onWord = null;
    this._onEnd = null;
    this._words = [];
    this._rawText = '';
    this._currentWordIdx = 0;
  }

  async init() {
    this.status = 'ready';
  }

  getCapabilities() {
    return { pitch: true, rate: true, volume: true, voices: true };
  }

  async getVoices() {
    return new Promise(resolve => {
      let voices = speechSynthesis.getVoices();
      if (voices.length) {
        resolve(voices.map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang, _native: v })));
        return;
      }
      speechSynthesis.onvoiceschanged = () => {
        voices = speechSynthesis.getVoices();
        resolve(voices.map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang, _native: v })));
      };
      // Fallback timeout
      setTimeout(() => resolve([]), 500);
    });
  }

  async speak(text, opts = {}) {
    const { rate, words, onWord, onStart, onEnd, onError, startWordIdx = 0 } = opts;
    if (rate != null) this._rate = rate;
    this._words = words || [];
    this._rawText = text;
    this._onWord = onWord;
    this._onEnd = onEnd;
    this._currentWordIdx = startWordIdx;

    speechSynthesis.cancel();

    // Build utterances from sentences
    this._utterances = [];
    const rx = /[^.!?\n]+[.!?\n]*/g;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const sentText = m[0].trim();
      if (sentText.length < 3) continue;
      const utt = new SpeechSynthesisUtterance(sentText);
      utt.rate = this._rate;
      utt.volume = 1;
      utt._charOffset = m.index;
      utt._sentText = sentText;

      // Set voice if selected
      if (this._voiceId) {
        const voices = speechSynthesis.getVoices();
        const v = voices.find(v => v.voiceURI === this._voiceId);
        if (v) utt.voice = v;
      }

      this._utterances.push(utt);
    }

    // Find starting utterance from word index
    const startChar = this._words[startWordIdx]?.charStart ?? 0;
    let startUttIdx = 0;
    for (let i = 0; i < this._utterances.length; i++) {
      const utt = this._utterances[i];
      if (utt._charOffset <= startChar &&
          startChar < utt._charOffset + utt._sentText.length) {
        startUttIdx = i; break;
      }
      if (utt._charOffset > startChar) { startUttIdx = Math.max(0, i - 1); break; }
      startUttIdx = i;
    }

    this._currentUttIdx = startUttIdx;
    this._queueUtterances(startUttIdx, onStart, onEnd, onError);
  }

  _queueUtterances(fromIdx, onStart, onEnd, onError) {
    for (let i = fromIdx; i < this._utterances.length; i++) {
      const utt = this._utterances[i];
      const uttIdx = i;

      utt.onboundary = (e) => {
        if (e.name !== 'word') return;
        const charInFull = utt._charOffset + e.charIndex;
        const charLen = e.charLength ?? 1;
        let best = this._currentWordIdx;
        const lo = Math.max(0, this._currentWordIdx - 1);
        const hi = Math.min(this._words.length - 1, this._currentWordIdx + 40);
        for (let wi = lo; wi <= hi; wi++) {
          const w = this._words[wi];
          if (w.charStart >= charInFull && w.charStart < charInFull + charLen + 4) {
            best = wi; break;
          }
          if (w.charStart <= charInFull) best = wi;
        }
        this._currentWordIdx = best;
        if (this._onWord) this._onWord(best);
      };

      utt.onstart = () => {
        this._currentUttIdx = uttIdx;
        if (onStart) onStart();
      };

      utt.onend = () => {
        if (uttIdx === this._utterances.length - 1) {
          if (onEnd) onEnd();
        }
      };

      utt.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        if (onError) onError(e);
      };

      speechSynthesis.speak(utt);
    }
  }

  pause() {
    speechSynthesis.pause();
  }

  resume() {
    speechSynthesis.resume();
  }

  stop() {
    speechSynthesis.cancel();
  }

  setRate(rate) {
    this._rate = rate;
    this._utterances.forEach(u => { u.rate = rate; });
  }
}


// ── AudioBufferPlayer ───────────────────────
// Shared utility for Kokoro/Piper: plays AudioBuffer with pause/resume/seek/speed
export class AudioBufferPlayer {
  constructor() {
    this._ctx = null;
    this._source = null;
    this._buffer = null;       // Current AudioBuffer
    this._startOffset = 0;     // Position in seconds when playback started
    this._startTime = 0;       // audioCtx.currentTime when started
    this._playing = false;
    this._paused = false;
    this._rate = 1;
    this._rafId = null;
    this._wordTimings = [];    // [{wordIdx, time}] sorted by time
    this._currentWordIdx = 0;
    this._onWord = null;
    this._onEnd = null;
    this._onStart = null;
    this._gainNode = null;

    // Sentence queue for streaming
    this._sentenceBuffers = [];  // [{buffer, wordTimings, charOffset}]
    this._currentSentenceIdx = 0;
    this._sentenceStartOffset = 0; // cumulative time offset for current sentence
    this._waitingForNext = false;  // true when player exhausted queue but more may come
    this._finalized = false;       // true when no more sentences will be appended
  }

  _ensureContext() {
    if (!this._ctx || this._ctx.state === 'closed') {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
    if (!this._gainNode) {
      this._gainNode = this._ctx.createGain();
      this._gainNode.connect(this._ctx.destination);
    }
    return this._ctx;
  }

  // Play a single buffer with word timings
  play(buffer, wordTimings, opts = {}) {
    const { onWord, onEnd, onStart, startOffset = 0, rate = 1 } = opts;
    this._ensureContext();
    this.stopSource();

    this._buffer = buffer;
    this._wordTimings = wordTimings || [];
    this._startOffset = startOffset;
    this._rate = rate;
    this._onWord = onWord;
    this._onEnd = onEnd;
    this._onStart = onStart;
    this._currentWordIdx = 0;
    this._playing = true;
    this._paused = false;

    this._createSource();
    if (onStart) onStart();
    this._startWordTracking();
  }

  // Queue multiple sentence buffers for sequential playback
  playSentences(sentenceBuffers, opts = {}) {
    const { onWord, onEnd, onStart, startWordIdx = 0, rate = 1 } = opts;
    this._ensureContext();
    this.stopSource();

    this._sentenceBuffers = sentenceBuffers;
    this._onWord = onWord;
    this._onEnd = onEnd;
    this._onStart = onStart;
    this._rate = rate;
    this._playing = true;
    this._paused = false;
    this._waitingForNext = false;
    this._finalized = false;

    // Find which sentence to start from based on word index
    this._currentSentenceIdx = 0;
    this._sentenceStartOffset = 0;
    for (let i = 0; i < sentenceBuffers.length; i++) {
      const sb = sentenceBuffers[i];
      const lastTiming = sb.wordTimings[sb.wordTimings.length - 1];
      if (lastTiming && lastTiming.wordIdx >= startWordIdx) {
        this._currentSentenceIdx = i;
        break;
      }
      this._currentSentenceIdx = i;
    }

    this._playSentenceAtIndex(this._currentSentenceIdx);
    if (onStart) onStart();
  }

  _playSentenceAtIndex(idx) {
    if (idx >= this._sentenceBuffers.length) {
      if (this._finalized) {
        this._playing = false;
        this._waitingForNext = false;
        if (this._onEnd) this._onEnd();
      } else {
        // More sentences may be coming — wait
        this._waitingForNext = true;
      }
      return;
    }
    this._waitingForNext = false;

    const sb = this._sentenceBuffers[idx];
    this._buffer = sb.buffer;
    this._wordTimings = sb.wordTimings;
    this._currentWordIdx = 0;
    this._startOffset = 0;
    this._currentSentenceIdx = idx;

    this._createSource();
    this._startWordTracking();
  }

  _createSource() {
    const ctx = this._ctx;
    this._source = ctx.createBufferSource();
    this._source.buffer = this._buffer;
    this._source.playbackRate.value = this._rate;
    this._source.connect(this._gainNode);

    this._source.onended = () => {
      if (!this._playing || this._paused) return;
      // If using sentence queue, advance to next
      if (this._sentenceBuffers.length > 0) {
        this._playSentenceAtIndex(this._currentSentenceIdx + 1);
      } else {
        this._playing = false;
        this._stopWordTracking();
        if (this._onEnd) this._onEnd();
      }
    };

    this._startTime = ctx.currentTime;
    this._source.start(0, this._startOffset);
  }

  _startWordTracking() {
    this._stopWordTracking();
    const tick = () => {
      if (!this._playing || this._paused) return;
      const elapsed = (this._ctx.currentTime - this._startTime) * this._rate + this._startOffset;
      // Find current word based on elapsed time
      for (let i = this._currentWordIdx; i < this._wordTimings.length; i++) {
        if (this._wordTimings[i].time <= elapsed) {
          if (this._onWord) this._onWord(this._wordTimings[i].wordIdx);
          this._currentWordIdx = i + 1;
        } else {
          break;
        }
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopWordTracking() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  getCurrentTime() {
    if (!this._ctx || !this._playing) return this._startOffset;
    if (this._paused) return this._startOffset;
    return (this._ctx.currentTime - this._startTime) * this._rate + this._startOffset;
  }

  pause() {
    if (!this._playing || this._paused) return;
    this._paused = true;
    this._startOffset = this.getCurrentTime();
    this._stopWordTracking();
    this.stopSource();
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._playing = true;
    this._ensureContext();
    this._createSource();
    this._startWordTracking();
  }

  stopSource() {
    try { this._source?.stop(); } catch {}
    this._source = null;
  }

  stop() {
    this._playing = false;
    this._paused = false;
    this._stopWordTracking();
    this.stopSource();
    this._sentenceBuffers = [];
    this._startOffset = 0;
    this._waitingForNext = false;
    this._finalized = false;
  }

  // Append a sentence buffer during streaming playback
  appendSentence(sentenceBuffer) {
    this._sentenceBuffers.push(sentenceBuffer);
    if (this._waitingForNext) {
      this._waitingForNext = false;
      this._playSentenceAtIndex(this._sentenceBuffers.length - 1);
    }
  }

  // Signal that no more sentences will be appended
  finalize() {
    this._finalized = true;
    if (this._waitingForNext) {
      this._playing = false;
      this._waitingForNext = false;
      this._stopWordTracking();
      if (this._onEnd) this._onEnd();
    }
  }

  setRate(rate) {
    this._rate = rate;
    if (this._source) {
      this._source.playbackRate.value = rate;
    }
  }

  get playing() { return this._playing && !this._paused; }
  get paused() { return this._paused; }
}


// ── Engine Registry ─────────────────────────
const engines = {};

export function registerEngine(engine) {
  engines[engine.id] = engine;
}

export function getEngine(id) {
  return engines[id] || null;
}

export function getAllEngines() {
  return Object.values(engines);
}

// Register Web Speech API engine by default
registerEngine(new WebSpeechEngine());

// ── Utility: estimate word timings from audio duration ──
export function estimateWordTimings(words, audioDuration, charOffset = 0, charLength = 0) {
  if (!words.length || !audioDuration) return [];
  const totalChars = charLength || (words[words.length - 1].charEnd - words[0].charStart);
  const startChar = charOffset || words[0].charStart;
  const timings = [];
  for (const w of words) {
    const relChar = w.charStart - startChar;
    const time = (relChar / Math.max(1, totalChars)) * audioDuration;
    timings.push({ wordIdx: w.id, time });
  }
  return timings;
}
