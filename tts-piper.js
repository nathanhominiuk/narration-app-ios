// ═══════════════════════════════════════════
//  Piper TTS Engine
//  Uses @mintplex-labs/piper-tts-web via CDN
//  VITS-based, MIT licensed, 900+ voices
// ═══════════════════════════════════════════
'use strict';

import { TTSEngine, AudioBufferPlayer, registerEngine, estimateWordTimings } from './tts-engines.js';

const PIPER_CDN = 'https://cdn.jsdelivr.net/npm/@nickolanack/piper-tts-web@1.2.1/+esm';

// Default voice models hosted on Hugging Face
const PIPER_VOICES = [
  {
    id: 'en_US-amy-medium',
    name: 'Amy (US Female)',
    lang: 'en-US',
    modelUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx',
    configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json'
  },
  {
    id: 'en_US-ryan-medium',
    name: 'Ryan (US Male)',
    lang: 'en-US',
    modelUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx',
    configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json'
  },
  {
    id: 'en_US-lessac-medium',
    name: 'Lessac (US Female)',
    lang: 'en-US',
    modelUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json'
  },
  {
    id: 'en_GB-alba-medium',
    name: 'Alba (British Female)',
    lang: 'en-GB',
    modelUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx',
    configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json'
  },
];

export class PiperEngine extends TTSEngine {
  constructor() {
    super('piper', 'Piper');
    this._piper = null;        // PiperTTS module
    this._worker = null;
    this._player = new AudioBufferPlayer();
    this._voiceId = 'en_US-amy-medium';
    this._loadedVoice = null;  // Track which voice model is loaded
  }

  getCapabilities() {
    return { pitch: false, rate: true, volume: false, voices: true };
  }

  async getVoices() {
    return PIPER_VOICES.map(v => ({ id: v.id, name: v.name, lang: v.lang }));
  }

  async init(onProgress) {
    if (this.status === 'ready' && this._piper) return;
    this.status = 'loading';

    try {
      this._piper = await import(/* webpackIgnore: true */ PIPER_CDN);
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      throw new Error('Failed to load Piper TTS library: ' + err.message);
    }
  }

  async _ensureVoiceLoaded(onProgress) {
    const voiceDef = PIPER_VOICES.find(v => v.id === this._voiceId) || PIPER_VOICES[0];

    if (this._loadedVoice === voiceDef.id && this._worker) return;

    if (onProgress) onProgress({ percent: 0, file: voiceDef.id + '.onnx' });

    // Fetch model and config
    const [modelResponse, configResponse] = await Promise.all([
      fetch(voiceDef.modelUrl),
      fetch(voiceDef.configUrl)
    ]);

    if (!modelResponse.ok) throw new Error('Failed to download voice model: ' + modelResponse.status);
    if (!configResponse.ok) throw new Error('Failed to download voice config: ' + configResponse.status);

    // Read model with progress tracking
    const contentLength = modelResponse.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength) : 0;
    const reader = modelResponse.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (onProgress && total) {
        onProgress({ loaded, total, percent: (loaded / total) * 100, file: voiceDef.id + '.onnx' });
      }
    }

    const modelBlob = new Blob(chunks);
    const modelUrl = URL.createObjectURL(modelBlob);
    const config = await configResponse.json();

    // Create Piper TTS worker
    if (this._piper.default || this._piper.PiperTTS || this._piper.createPiperPhonemize) {
      // Use available API
      this._config = config;
      this._modelUrl = modelUrl;
    }

    this._loadedVoice = voiceDef.id;
    if (onProgress) onProgress({ percent: 100, file: voiceDef.id + '.onnx' });
  }

  async speak(text, opts = {}) {
    const { rate, words, onWord, onStart, onEnd, onError, startWordIdx = 0, onProgress } = opts;
    if (rate != null) this._rate = rate;

    this._player.stop();

    try {
      await this._ensureVoiceLoaded(onProgress);

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

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const sentenceBuffers = [];

      // Generate audio for each sentence using Piper
      for (const sent of sentences) {
        let samples, sampleRate;

        if (this._piper.PiperTTS) {
          // @mintplex-labs API
          const tts = new this._piper.PiperTTS(this._modelUrl, this._config);
          const result = await tts.synthesize(sent.text);
          samples = new Float32Array(result.audio);
          sampleRate = result.sampleRate || this._config.audio?.sample_rate || 22050;
        } else if (this._piper.synthesize) {
          const result = await this._piper.synthesize(sent.text, this._modelUrl, this._config);
          samples = new Float32Array(result.audio || result);
          sampleRate = result.sampleRate || this._config.audio?.sample_rate || 22050;
        } else {
          // Fallback: use Web Speech API if Piper API is unrecognized
          throw new Error('Piper TTS API not recognized. Please update the library version.');
        }

        // Normalize to [-1, 1] if needed
        let maxAbs = 0;
        for (let i = 0; i < samples.length; i++) {
          const a = Math.abs(samples[i]);
          if (a > maxAbs) maxAbs = a;
        }
        if (maxAbs > 1) {
          for (let i = 0; i < samples.length; i++) samples[i] /= maxAbs;
        }

        const audioBuffer = audioCtx.createBuffer(1, samples.length, sampleRate);
        audioBuffer.copyToChannel(samples, 0);
        const duration = samples.length / sampleRate;

        // Estimate word timings proportionally
        const sentWords = (words || []).filter(w =>
          w.charStart >= sent.charOffset &&
          w.charStart < sent.charOffset + sent.text.length
        );
        const wordTimings = estimateWordTimings(
          sentWords, duration, sent.charOffset, sent.text.length
        );

        sentenceBuffers.push({
          buffer: audioBuffer,
          wordTimings,
          text: sent.text,
          charOffset: sent.charOffset
        });
      }

      // Find starting sentence
      let startSentenceIdx = 0;
      if (startWordIdx > 0 && words) {
        for (let i = 0; i < sentenceBuffers.length; i++) {
          const sb = sentenceBuffers[i];
          if (sb.wordTimings.some(wt => wt.wordIdx >= startWordIdx)) {
            startSentenceIdx = i;
            break;
          }
        }
      }

      const buffersToPlay = sentenceBuffers.slice(startSentenceIdx);
      this._player.playSentences(buffersToPlay, {
        onWord,
        onEnd,
        onStart,
        startWordIdx,
        rate: this._rate
      });

    } catch (err) {
      if (onError) onError(err);
    }
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

  setVoice(voiceId) {
    this._voiceId = voiceId;
    // Voice change takes effect on next speak() call
  }
}

// Register
const piperEngine = new PiperEngine();
registerEngine(piperEngine);
export default piperEngine;
