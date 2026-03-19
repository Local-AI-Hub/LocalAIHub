import json
import os
import re
import sys

TRANSCRIPTION_ATTEMPTS = [
    ('cuda', 'float16'),
    ('cuda', 'int8_float16'),
    ('cuda', 'int8'),
    ('cpu', 'int8'),
]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def error_message(error: Exception) -> str:
    message = str(error).strip()
    return message or error.__class__.__name__


def is_missing_module(message: str, module_name: str) -> bool:
    normalized = message.lower()
    quoted_name = f"'{module_name.lower()}'"
    return 'no module named' in normalized and (quoted_name in normalized or module_name.lower() in normalized)


def is_missing_cuda_runtime(message: str) -> bool:
    normalized = message.lower()
    return (
        bool(re.search(r'cublas64_\d+\.dll', normalized))
        or 'cudnn' in normalized
        or ('cuda' in normalized and 'dll' in normalized)
    )


def is_audio_decode_failure(message: str) -> bool:
    normalized = message.lower()
    return (
        'invalid data found when processing input' in normalized
        or 'moov atom not found' in normalized
        or 'error opening input file' in normalized
        or 'failed to open the input' in normalized
        or 'input/output error' in normalized
        or 'end of file' in normalized
        or 'no such file or directory' in normalized
    )


def build_failure_message(attempt_failures) -> str:
    messages = [message for _device, _compute_type, message in attempt_failures]
    cpu_failures = [message for device, _compute_type, message in attempt_failures if device == 'cpu']

    if any(is_missing_module(message, 'faster_whisper') for message in messages):
        return 'Whisper is missing the faster-whisper Python package. Repair or reinstall Whisper and try again.'

    if any(is_missing_module(message, 'av') for message in messages):
        return 'Whisper is missing its bundled audio decoder. Repair or reinstall Whisper and try again.'

    if any(is_audio_decode_failure(message) for message in cpu_failures or messages):
        return 'Whisper could not read that audio file. Save it again or convert it to WAV, MP3, M4A, FLAC, AAC, OGG, or WMA and try again.'

    if any(is_missing_cuda_runtime(message) for message in messages):
        if cpu_failures:
            return 'Whisper could not use NVIDIA acceleration because Windows is missing the CUDA libraries it needs, and the CPU fallback did not finish either. Repair or reinstall Whisper and try again.'
        return 'Whisper could not use NVIDIA acceleration because Windows is missing the CUDA libraries it needs. Repair or reinstall Whisper and try again.'

    last_error = messages[-1] if messages else 'Whisper could not load the selected model.'
    return f'Whisper could not transcribe this file: {last_error}'


def transcribe_once(audio_path: str, model_name: str, cache_dir: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=cache_dir)
    segments, info = model.transcribe(audio_path, vad_filter=True)
    collected_segments = []
    for segment in segments:
        collected_segments.append(
            {
                'start': round(float(segment.start), 2),
                'end': round(float(segment.end), 2),
                'text': segment.text.strip(),
            }
        )

    transcript = ' '.join(segment['text'] for segment in collected_segments if segment['text']).strip()
    return {
        'computeType': compute_type,
        'device': device,
        'durationSeconds': round(float(getattr(info, 'duration', 0) or 0), 2) or None,
        'language': getattr(info, 'language', None),
        'segments': collected_segments,
        'text': transcript,
    }


def main() -> None:
    if len(sys.argv) < 4:
        fail('Whisper needs an audio file, model name, and cache folder.')

    audio_path = os.path.abspath(sys.argv[1])
    model_name = sys.argv[2].strip() or 'base'
    cache_dir = os.path.abspath(sys.argv[3])

    if not os.path.exists(audio_path):
        fail('The selected audio file could not be found.')

    os.makedirs(cache_dir, exist_ok=True)

    attempt_failures = []
    runtime_note = ''

    for device, compute_type in TRANSCRIPTION_ATTEMPTS:
        try:
            transcription = transcribe_once(audio_path, model_name, cache_dir, device, compute_type)
            if runtime_note:
                transcription['runtimeNote'] = runtime_note
            print(json.dumps(transcription, ensure_ascii=False))
            return
        except Exception as error:
            message = error_message(error)
            attempt_failures.append((device, compute_type, message))
            if device == 'cuda' and is_missing_cuda_runtime(message):
                runtime_note = 'Local AI Hub switched Whisper to CPU mode because Windows is missing the NVIDIA CUDA libraries it needs for GPU transcription.'
                continue
            if device == 'cuda':
                continue
            break

    fail(build_failure_message(attempt_failures))


if __name__ == '__main__':
    main()
