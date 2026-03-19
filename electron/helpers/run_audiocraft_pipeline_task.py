import json
import os
import sys
import traceback


def fail(message: str):
    print(json.dumps({"message": message}))
    raise SystemExit(1)


def load_request(path_value: str):
    try:
        with open(path_value, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except FileNotFoundError:
        fail('Local AI Hub could not find the AudioCraft request file.')
    except json.JSONDecodeError:
        fail('Local AI Hub could not read the AudioCraft request file.')


def ensure_parent_directory(path_value: str):
    parent = os.path.dirname(path_value)
    if parent:
        os.makedirs(parent, exist_ok=True)


def main():
    if len(sys.argv) < 2:
        fail('Local AI Hub did not receive an AudioCraft request file path.')

    request = load_request(sys.argv[1])
    output_path = os.path.abspath(str(request.get('outputPath') or '').strip())
    if not output_path:
        fail('Local AI Hub could not prepare the destination path for the generated audio file.')

    prompt = str(request.get('prompt') or '').strip()
    audio_mode = str(request.get('audioMode') or 'music').strip().lower() or 'music'
    source_audio_path = os.path.abspath(str(request.get('sourceAudioPath') or '').strip()) if str(request.get('sourceAudioPath') or '').strip() else ''
    if audio_mode not in {'music', 'sound'}:
        audio_mode = 'music'

    if audio_mode == 'sound' and source_audio_path:
        fail('Sound mode currently accepts text prompts only in this Local AI Hub audio slice. Switch the step to Music mode if you want to guide generation with audio.')

    if not prompt and not source_audio_path:
        fail('Add a text prompt or connect an audio guide before running this AudioCraft step.')

    if source_audio_path and not os.path.exists(source_audio_path):
        fail('The connected source audio file could not be found anymore. Choose it again and rerun the pipeline.')

    try:
        import torchaudio
        from audiocraft.data.audio import audio_write
        from audiocraft.models import AudioGen, MusicGen
    except Exception:
        fail('AudioCraft is installed, but its Python environment is missing the packages needed for pipeline audio generation. Run Repair or reinstall AudioCraft WebUI, then try again.')

    duration_seconds = max(1, int(float(request.get('durationSeconds') or 8)))
    requested_model = str(request.get('model') or '').strip()

    try:
        if audio_mode == 'sound':
            model_name = requested_model or 'facebook/audiogen-medium'
            model = AudioGen.get_pretrained(model_name)
            model.set_generation_params(duration=duration_seconds)
            wav_batch = model.generate([prompt or 'generated audio'])
        else:
            model_name = requested_model or ('facebook/musicgen-melody' if source_audio_path else 'facebook/musicgen-medium')
            model = MusicGen.get_pretrained(model_name)
            model.set_generation_params(duration=duration_seconds)
            if source_audio_path:
                melody, melody_sample_rate = torchaudio.load(source_audio_path)
                if melody.dim() == 1:
                    melody = melody.unsqueeze(0)
                if melody.dim() == 2:
                    melody = melody.unsqueeze(0)
                wav_batch = model.generate_with_chroma([prompt], melody, melody_sample_rate)
            else:
                wav_batch = model.generate([prompt or 'generated music'])

        if wav_batch is None or len(wav_batch) == 0:
            fail('AudioCraft finished, but it did not return any generated audio.')

        waveform = wav_batch[0].cpu()
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)

        output_stem, _ = os.path.splitext(output_path)
        ensure_parent_directory(output_stem)
        audio_write(output_stem, waveform, model.sample_rate, strategy='loudness', loudness_compressor=True)
        final_output_path = output_stem + '.wav'
        if not os.path.exists(final_output_path):
            fail('AudioCraft finished, but the generated audio file could not be written to disk.')

        duration_value = round(float(waveform.shape[-1]) / float(model.sample_rate), 2) if waveform.shape[-1] else 0
        message = 'AudioCraft generated audio locally.'
        if source_audio_path:
            message = 'AudioCraft generated audio locally using the connected source audio as guidance.'

        print(json.dumps({
            'audioMode': audio_mode,
            'durationSeconds': duration_value,
            'message': message,
            'model': model_name,
            'outputPath': final_output_path,
            'prompt': prompt,
            'sampleRate': int(model.sample_rate),
        }))
    except SystemExit:
        raise
    except Exception:
        fail('AudioCraft could not finish this pipeline audio request. Check the AudioCraft runtime and model setup, then try again.')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fallback_message = 'AudioCraft could not finish this pipeline audio request. Check the AudioCraft runtime and model setup, then try again.'
        traceback.print_exc()
        fail(fallback_message)
