// ═══════════════════════════════════════════
//  Kokoro TTS Engine
//  Uses kokoro-js via CDN (Transformers.js + ONNX Runtime)
//  82M parameter model, Apache 2.0
// ═══════════════════════════════════════════
'use strict';

import { TTSEngine, AudioBufferPlayer, registerEngine, estimateWordTimings } from './tts-engines.js';

const KOKORO_CDN = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.1.1/+esm';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const KOKORO_VOICES = [
  { id: 'af_heart',  name: 'Heart (Female)',    lang: 'en-US' },
  { id: 'af_alloy',  name: 'Alloy (Female)',    lang: 'en-US' },
  { id: 'af_aoede',  name: 'Aoede (Female)',    lang: 'en-US' },
  { id: 'af_bella',  name: 'Bella (Female)',    lang: 'en-US' },
  { id: 'af_jessica', name: 'Jessica (Female)', lang: 'en-US' },
  { id: 'af_nicole', name: 'Nicole (Female)',   lang: 'en-US' },
  { id: 'af_nova',   name: 'Nova (Female)',     lang: 'en-US' },
  { id: 'af_river',  name: 'River (Female)',    lang: 'en-US' },
  { id: 'af_sarah',  name: 'Sarah (Female)',    lang: 'en-US' },
  { id: 'af_sky',    name: 'Sky (Female)',      lang: 'en-US' },
  { id: 'am_adam',   name: 'Adam (Male)',       lang: 'en-US' },
  { id: 'am_echo',   name: 'Echo (Male)',       lang: 'en-US' },
  { id: 'am_eric',   name: 'Eric (Male)',       lang: 'en-US' },
  { id: 'am_liam',   name: 'Liam (Male)',       lang: 'en-US' },
  { id: 'am_michael', name: 'Michael (Male)',   lang: 'en-US' },
  { id: 'am_onyx',   name: 'Onyx (Male)',       lang: 'en-US' },
  { id: 'bf_emma',   name: 'Emma (Female, British)', lang: 'en-GB' },
  { id: 'bf_isabella', name: 'Isabella (Female, British)', lang: 'en-GB' },
  { id: 'bm_daniel', name: 'Daniel (Male, British)', lang: 'en-GB' },
  { id: 'bm_fable',  name: 'Fable (Male, British)',  lang: 'en-GB' },
  { id: 'bm_george', name: 'George (Male, British)', lang: 'en-GB' },
];

function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + (ms / 1000) + 's')), ms))
  ]);
}

export class KokoroEngine extends TTSEngine {
  constructor() {
    super('kokoro', 'Kokoro');
    this._tts = null;          // KokoroTTS instance
    this._player = new AudioBufferPlayer();
    this._voiceId = 'af_heart';
    this._abortController = null;
  }

  getCapabilities() {
    return { pitch: false, rate: true, volume: false, voices: true };
  }

  async getVoices() {
    return KOKORO_VOICES;
  }

  async init(onProgress) {
    if (this.status === 'ready') return;
    this.status = 'loading';

    try {
      const { KokoroTTS } = await import(/* webpackIgnore: true */ KOKORO_CDN);

      this._tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (progress) => {
          if (onProgress && progress.status === 'progress') {
            onProgress({
              loaded: progress.loaded || 0,
              total: progress.total || 0,
              percent: progress.progress || 0,
              file: progress.file || ''
            });
          }
        }
      });

      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      throw new Error('Failed to load Kokoro TTS: ' + err.message);
    }
  }

  async speak(text, opts = {}) {
    const { rate, words, onWord, onStart, onEnd, onError, onProgress, startWordIdx = 0 } = opts;
    if (rate != null) this._rate = rate;
    if (!this._tts) throw new Error('Kokoro not initialized');

    this._player.stop();

    try {
      // Split text into sentences
      const sentences = [];
      const rx = /[^.!?\n]+[.!?\n]*/g;
      let m;
      while ((m = rx.exec(text)) !== null) {
        const sentText = m[0].trim();
        if (sentText.length < 3) continue;
        sentences.push({ text: sentText, charOffset: m.index });
      }

      if (!sentences.length) return;

      // Find starting sentence based on startWordIdx
      let startSentenceIdx = 0;
      if (startWordIdx > 0 && words) {
        const startChar = words[startWordIdx]?.charStart ?? 0;
        for (let i = 0; i < sentences.length; i++) {
          const sent = sentences[i];
          if (startChar >= sent.charOffset && startChar < sent.charOffset + sent.text.length) {
            startSentenceIdx = i;
            break;
          }
          if (sent.charOffset > startChar) { startSentenceIdx = Math.max(0, i - 1); break; }
          startSentenceIdx = i;
        }
      }

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const totalSentences = sentences.length - startSentenceIdx;

      // Generate FIRST sentence and start playback immediately
      if (onProgress) onProgress({ phase: 'generating', current: 1, total: totalSentences });
      const firstBuffer = await this._generateSentenceBuffer(sentences[startSentenceIdx], words, audioCtx);

      // Start playing the first sentence right away
      this._player.playSentences([firstBuffer], {
        onWord,
        onEnd: null,  // Don't end yet — more sentences coming
        onStart,
        startWordIdx,
        rate: this._rate
      });

      // Generate remaining sentences in background, appending as they're ready
      for (let i = startSentenceIdx + 1; i < sentences.length; i++) {
        if (!this._player.playing && !this._player.paused && !this._player._waitingForNext) break; // stopped
        const buf = await this._generateSentenceBuffer(sentences[i], words, audioCtx);
        this._player.appendSentence(buf);
        if (onProgress) onProgress({
          phase: 'generating',
          current: i - startSentenceIdx + 1,
          total: totalSentences
        });
      }

      // All sentences generated — set final onEnd and finalize
      this._player._onEnd = onEnd;
      this._player.finalize();

    } catch (err) {
      if (onError) onError(err);
    }
  }

  async _generateSentenceBuffer(sent, words, audioCtx) {
    const result = await withTimeout(
      this._tts.generate(sent.text, { voice: this._voiceId }),
      60000, 'Audio generation'
    );

    // Convert to AudioBuffer
    const audioData = result.audio;
    const sampleRate = result.sampling_rate || 24000;
    let samples;
    if (audioData instanceof Float32Array) {
      samples = audioData;
    } else if (audioData?.data) {
      samples = new Float32Array(audioData.data);
    } else {
      samples = new Float32Array(audioData);
    }

    const audioBuffer = audioCtx.createBuffer(1, samples.length, sampleRate);
    audioBuffer.copyToChannel(samples, 0);
    const duration = samples.length / sampleRate;

    // Estimate word timings for this sentence
    const sentWords = (words || []).filter(w =>
      w.charStart >= sent.charOffset &&
      w.charStart < sent.charOffset + sent.text.length
    );
    const wordTimings = estimateWordTimings(
      sentWords, duration, sent.charOffset, sent.text.length
    );

    return {
      buffer: audioBuffer,
      wordTimings,
      text: sent.text,
      charOffset: sent.charOffset
    };
  }

  pause() {
    this._player.pause();
  }

  resume() {
    this._player.resume();
  }

  stop() {
    this._player.stop();
  }

  setRate(rate) {
    this._rate = rate;
    this._player.setRate(rate);
  }
}

// Register
const kokoroEngine = new KokoroEngine();
registerEngine(kokoroEngine);
export default kokoroEngine;
