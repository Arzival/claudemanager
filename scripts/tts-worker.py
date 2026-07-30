#!/usr/bin/env python3
"""Worker de síntesis de voz para claudemanager.

Proceso persistente: recibe una petición JSON por línea en stdin y responde
una línea JSON en stdout. Mantener el proceso vivo evita pagar la carga del
modelo en cada síntesis (Kokoro tarda segundos en arrancar).

  → {"id": 1, "engine": "kokoro", "voice": "ef_dora", "text": "hola"}
  ← {"id": 1, "ok": true, "wav": "<base64>"}

Motores:
  - kokoro: kokoro-onnx con el modelo en ~/.claudemanager/tts/
  - piper:  piper-tts con los .onnx en ~/.claudemanager/voices/piper/
"""
import base64
import io
import json
import os
import sys
import wave

TTS_DIR = os.path.expanduser("~/.claudemanager/tts")
PIPER_DIR = os.path.expanduser("~/.claudemanager/voices/piper")

_kokoro = None
_piper_cache = {}


def kokoro_lang(voice):
    # Prefijo de la voz → idioma: a=inglés US, b=inglés GB, e=español
    return {"a": "en-us", "b": "en-gb", "e": "es"}.get(voice[:1], "en-us")


def synth_kokoro(voice, text, speed):
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(
            os.path.join(TTS_DIR, "kokoro-v1.0.onnx"),
            os.path.join(TTS_DIR, "voices-v1.0.bin"),
        )
    samples, rate = _kokoro.create(text, voice=voice, speed=speed, lang=kokoro_lang(voice))
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def synth_piper(voice, text, speed, speaker):
    if voice not in _piper_cache:
        import piper as piper_pkg
        from piper import PiperVoice
        model = os.path.join(PIPER_DIR, voice + ".onnx")
        if not os.path.exists(model):
            raise FileNotFoundError(f"modelo no descargado: {voice}")
        # La ruta por defecto del wheel apunta al directorio de compilación de
        # su CI (inexistente aquí) — se pasa la copia empaquetada explícita.
        # realpath: espeak rechaza rutas que atraviesan symlinks.
        espeak_dir = os.path.realpath(os.path.join(os.path.dirname(piper_pkg.__file__), "espeak-ng-data"))
        _piper_cache[voice] = PiperVoice.load(model, espeak_data_dir=espeak_dir)
    pv = _piper_cache[voice]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        try:
            from piper import SynthesisConfig
            cfg = SynthesisConfig(length_scale=1.0 / speed, speaker_id=speaker)
            pv.synthesize_wav(text, w, syn_config=cfg)
        except ImportError:
            pv.synthesize(text, w, length_scale=1.0 / speed, speaker_id=speaker)
    return buf.getvalue()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            engine = req["engine"]
            voice = req["voice"]
            text = req["text"]
            speed = float(req.get("speed", 1.0))
            speaker = req.get("speaker")
            if speaker is not None:
                speaker = int(speaker)
            wav = synth_kokoro(voice, text, speed) if engine == "kokoro" else synth_piper(voice, text, speed, speaker)
            out = {"id": rid, "ok": True, "wav": base64.b64encode(wav).decode("ascii")}
        except Exception as e:  # noqa: BLE001 — el error viaja al servidor
            out = {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
