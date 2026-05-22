from __future__ import annotations

import json
import math
import os
import sys
import traceback
from importlib import metadata
from pathlib import Path

MIN_REFERENCE_SECONDS = 5.0
DEFAULT_MAX_TEXT_LENGTH = 400
DEFAULT_MODEL_ID = "ResembleAI/chatterbox-turbo"


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def fail(message: str, *, error_type: str = "runtime", code: int = 1, details: dict | None = None) -> None:
    payload = {
        "ok": False,
        "errorType": error_type,
        "message": str(message or "Chatterbox-Turbo could not finish the reference voice TTS request."),
    }
    if details:
        payload["details"] = details
    emit(payload)
    raise SystemExit(code)


def classify_exception(exc: BaseException) -> tuple[str, str]:
    text = "\n".join([str(exc), traceback.format_exc()]).lower()
    if "out of memory" in text or "cuda oom" in text or "cuda error: out of memory" in text:
        return (
            "cuda-oom",
            "Chatterbox-Turbo ran out of GPU memory. Try shorter text or a shorter reference clip, close other GPU tools, or use a GPU with more VRAM.",
        )
    if "cuda" in text and ("not available" in text or "no cuda" in text or "driver" in text):
        return (
            "cuda-unavailable",
            "Chatterbox-Turbo needs CUDA for normal Local AI Hub generation, but CUDA was not available. Repair the Chatterbox install or update the NVIDIA driver, then try again.",
        )
    if "pkg_resources" in text or "perthimplicitwatermarker" in text:
        return (
            "setuptools-repair-needed",
            "Chatterbox-Turbo is installed, but its watermarking dependency needs pkg_resources. Run Repair so Local AI Hub can pin setuptools below 81.",
        )
    if "huggingface" in text or "hf_hub" in text or "401" in text or "403" in text or "429" in text or "timed out" in text:
        return (
            "model-download-failed",
            "Chatterbox-Turbo could not download or read its Hugging Face model cache. Check the network/cache location and try again, or run Repair while online.",
        )
    if "no module named" in text or "modulenotfounderror" in text:
        return (
            "missing-package",
            "Chatterbox-Turbo is missing required Python packages. Run Repair or reinstall Chatterbox-Turbo TTS, then try again.",
        )
    return (
        exc.__class__.__name__,
        "Chatterbox-Turbo could not finish the reference voice TTS request: " + str(exc),
    )


def load_request() -> dict:
    if len(sys.argv) < 2:
        fail("Local AI Hub did not provide a Chatterbox-Turbo request file.", error_type="bad-request")
    request_path = Path(sys.argv[1]).expanduser()
    if not request_path.exists():
        fail("The Chatterbox-Turbo request file could not be found.", error_type="bad-request")
    try:
        return json.loads(request_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        fail("Local AI Hub could not read the Chatterbox-Turbo request file: " + str(exc), error_type="bad-request")


def require_path(value: str, label: str, *, must_exist: bool = True) -> Path:
    raw = str(value or "").strip()
    if not raw:
        fail(label + " was not provided.", error_type="bad-request")
    path = Path(raw).expanduser()
    if must_exist and not path.exists():
        fail(label + " could not be found at " + str(path), error_type="missing-input")
    return path


def normalize_waveform(wav):
    import torch

    if wav is None:
        fail("Chatterbox-Turbo returned no waveform.", error_type="empty-output")
    if not isinstance(wav, torch.Tensor):
        try:
            wav = torch.as_tensor(wav)
        except Exception as exc:
            fail("Chatterbox-Turbo returned audio in an unsupported format: " + str(exc), error_type="bad-output")
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    elif wav.ndim == 2:
        pass
    elif wav.ndim == 3 and wav.shape[0] == 1:
        wav = wav.squeeze(0)
    else:
        fail("Chatterbox-Turbo returned audio with an unexpected shape: " + str(tuple(wav.shape)), error_type="bad-output")
    return wav.detach().cpu().float().contiguous()


def get_package_version(name: str) -> str:
    try:
        return metadata.version(name)
    except Exception:
        return ""


def main() -> None:
    request = load_request()
    text = str(request.get("text") or request.get("prompt") or "").strip()
    max_text_length = int(request.get("maxTextLength") or DEFAULT_MAX_TEXT_LENGTH)
    if not text:
        fail("Reference Voice TTS needs connected text to speak.", error_type="missing-text")
    if len(text) > max_text_length:
        fail(
            "Reference Voice TTS text is too long for this first Chatterbox-Turbo pass. Keep it under " + str(max_text_length) + " characters.",
            error_type="text-too-long",
            details={"textLength": len(text), "maxTextLength": max_text_length},
        )

    reference_audio_path = require_path(str(request.get("referenceAudioPath") or ""), "The reference voice audio", must_exist=True)
    try:
        if reference_audio_path.stat().st_size <= 0:
            fail("The reference voice audio file is empty.", error_type="missing-input")
    except OSError:
        fail("Local AI Hub could not inspect the reference voice audio file.", error_type="missing-input")

    output_path = require_path(str(request.get("outputPath") or ""), "The output WAV path", must_exist=False)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import torch
        import torchaudio
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        import pkg_resources  # noqa: F401 - verifies resemble-perth compatibility on current Chatterbox releases.
    except Exception as exc:
        error_type, message = classify_exception(exc)
        fail(message, error_type=error_type)

    try:
        info = torchaudio.info(str(reference_audio_path))
        reference_frames = int(getattr(info, "num_frames", 0) or 0)
        reference_sample_rate = int(getattr(info, "sample_rate", 0) or 0)
        reference_duration = reference_frames / float(reference_sample_rate) if reference_frames and reference_sample_rate else 0.0
    except Exception as exc:
        fail("Local AI Hub could not read the reference voice WAV metadata: " + str(exc), error_type="bad-reference-audio")

    if not math.isfinite(reference_duration) or reference_duration < MIN_REFERENCE_SECONDS:
        fail(
            "Reference Voice TTS needs a reference voice sample longer than 5 seconds for Chatterbox-Turbo.",
            error_type="reference-audio-too-short",
            details={"durationSeconds": round(float(reference_duration or 0.0), 3)},
        )

    requested_device = str(request.get("devicePreference") or request.get("device") or "cuda").strip().lower()
    allow_cpu = bool(request.get("allowCpu") or request.get("allowCpuFallback"))
    cuda_available = bool(torch.cuda.is_available())
    if requested_device in ("auto", "cuda"):
        if cuda_available:
            device = "cuda"
        elif allow_cpu:
            device = "cpu"
        else:
            fail("Chatterbox-Turbo needs CUDA for normal Local AI Hub generation, but CUDA was not available. Install a CUDA PyTorch build or run Repair, then try again.", error_type="cuda-unavailable")
    elif requested_device == "cpu":
        if not allow_cpu:
            fail("CPU fallback is disabled for Chatterbox-Turbo because it can be impractically slow. Enable CPU fallback explicitly before using CPU generation.", error_type="cpu-disabled")
        device = "cpu"
    else:
        fail("Unsupported Chatterbox-Turbo device preference: " + requested_device, error_type="bad-request")

    gpu_name = torch.cuda.get_device_name(0) if device == "cuda" else ""
    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    try:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
        wav = model.generate(text, audio_prompt_path=str(reference_audio_path))
        wav = normalize_waveform(wav)
        sample_rate = int(getattr(model, "sr", 0) or getattr(model, "sample_rate", 0) or 24000)
        torchaudio.save(str(output_path), wav, sample_rate)
    except Exception as exc:
        error_type, message = classify_exception(exc)
        fail(message, error_type=error_type)

    if not output_path.exists() or output_path.stat().st_size <= 0:
        fail("Chatterbox-Turbo reported success, but the output WAV was not written.", error_type="empty-output")

    try:
        output_info = torchaudio.info(str(output_path))
        output_sample_rate = int(getattr(output_info, "sample_rate", 0) or sample_rate)
        output_frames = int(getattr(output_info, "num_frames", 0) or 0)
        output_channels = int(getattr(output_info, "num_channels", 0) or (wav.shape[0] if wav.ndim > 1 else 1))
        duration_seconds = output_frames / float(output_sample_rate) if output_frames and output_sample_rate else wav.shape[-1] / float(sample_rate)
    except Exception:
        output_sample_rate = sample_rate
        output_channels = int(wav.shape[0] if wav.ndim > 1 else 1)
        duration_seconds = wav.shape[-1] / float(sample_rate)

    peak_allocated_mb = 0.0
    peak_reserved_mb = 0.0
    if device == "cuda":
        peak_allocated_mb = float(torch.cuda.max_memory_allocated() / (1024 * 1024))
        peak_reserved_mb = float(torch.cuda.max_memory_reserved() / (1024 * 1024))

    emit({
        "ok": True,
        "message": "Chatterbox-Turbo generated reference voice speech locally.",
        "backend": "chatterbox-tts",
        "backendLabel": "Chatterbox-Turbo",
        "model": DEFAULT_MODEL_ID,
        "modelId": DEFAULT_MODEL_ID,
        "packageVersion": get_package_version("chatterbox-tts"),
        "torchVersion": str(getattr(torch, "__version__", "")),
        "torchaudioVersion": str(getattr(torchaudio, "__version__", "")),
        "cudaAvailable": cuda_available,
        "device": device,
        "gpuName": gpu_name,
        "peakAllocatedMb": round(peak_allocated_mb, 1),
        "peakReservedMb": round(peak_reserved_mb, 1),
        "operationId": "audioGenerate",
        "operationSubtype": "referenceVoiceTts",
        "mode": "referenceVoiceTts",
        "outputPath": str(output_path),
        "sampleRate": output_sample_rate,
        "channels": output_channels,
        "durationSeconds": round(float(duration_seconds), 3),
        "referenceAudioPath": str(reference_audio_path),
        "referenceDurationSeconds": round(float(reference_duration), 3),
        "referenceSampleRate": reference_sample_rate,
        "textLength": len(text),
        "textPreview": text[:120],
    })


if __name__ == "__main__":
    main()
