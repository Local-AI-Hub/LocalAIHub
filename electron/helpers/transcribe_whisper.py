import json
import os
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def load_model(model_name: str, cache_dir: str):
    from faster_whisper import WhisperModel

    try:
        return WhisperModel(model_name, device='cuda', compute_type='float16', download_root=cache_dir)
    except Exception:
        return WhisperModel(model_name, device='cpu', compute_type='int8', download_root=cache_dir)


def main() -> None:
    if len(sys.argv) < 4:
        fail('Whisper needs an audio file, model name, and cache folder.')

    audio_path = os.path.abspath(sys.argv[1])
    model_name = sys.argv[2].strip() or 'base'
    cache_dir = os.path.abspath(sys.argv[3])

    if not os.path.exists(audio_path):
        fail('The selected audio file could not be found.')

    os.makedirs(cache_dir, exist_ok=True)

    try:
        model = load_model(model_name, cache_dir)
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
        print(
            json.dumps(
                {
                    'language': getattr(info, 'language', None),
                    'segments': collected_segments,
                    'text': transcript,
                },
                ensure_ascii=False,
            )
        )
    except Exception as error:
        fail(f'Whisper could not transcribe this file: {error}')


if __name__ == '__main__':
    main()
