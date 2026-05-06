import importlib
import json
import os
import sys
import traceback
import wave


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


def format_missing_pipeline_packages(missing):
    unique = []
    for item in missing:
        value = str(item or '').strip()
        if value and value not in unique:
            unique.append(value)
    detail = ': ' + ', '.join(unique) if unique else ''
    return 'AudioCraft is installed, but its Python environment is missing the packages needed for pipeline audio generation' + detail + '. Run Repair or reinstall AudioCraft WebUI, then try again.'


def is_path_like_model_name(value):
    text = str(value or '').strip()
    if not text:
        return False
    if os.path.isabs(text):
        return True
    if text.startswith('.'):
        return True
    if '\\' in text:
        return True
    return False


def validate_requested_model_path(model_name, audio_mode):
    if not is_path_like_model_name(model_name):
        return

    model_path = os.path.abspath(model_name)
    if not os.path.isdir(model_path):
        fail('The selected AudioCraft snapshot folder could not be found anymore. Refresh the AudioCraft model list, choose an installed snapshot, or clear the model field to use AudioCraft upstream defaults.')

    required_files = ['state_dict.bin', 'compression_state_dict.bin']
    missing = [name for name in required_files if not os.path.exists(os.path.join(model_path, name))]
    if missing:
        fail('The selected AudioCraft snapshot is incomplete and is missing: ' + ', '.join(missing) + '. Download it again from Model Manager or clear the model field to use AudioCraft upstream defaults.')


def summarize_runtime_exception(error):
    message = str(error or '').strip()
    error_type = error.__class__.__name__ if error else 'Error'
    if error_type == 'HFValidationError' and 'Repo id' in message:
        return 'AudioCraft could not load the selected model. If you chose a downloaded snapshot, refresh the model list and choose an installed snapshot folder; if you typed a model manually, use a valid Hugging Face repo id such as facebook/musicgen-small.'
    if error_type == 'ImportError' and 'TorchCodec' in message:
        return 'AudioCraft generated audio, but the save/export step needs an audio codec package that is not available in this environment. Run Repair or reinstall AudioCraft WebUI, then try again.'
    if isinstance(error, FileNotFoundError):
        return 'AudioCraft could not find a required model file: ' + message + '. Download the snapshot again or clear the model field to use upstream defaults.'
    if isinstance(error, RuntimeError) and ('CUDA' in message or 'out of memory' in message.lower() or 'DefaultCPUAllocator' in message):
        return 'AudioCraft could not allocate enough compute memory for this request. Try MusicGen small, shorten the duration, close other GPU apps, or clear incompatible CUDA/xFormers packages by running Repair.'
    if message:
        return 'AudioCraft could not finish this pipeline audio request: ' + error_type + ': ' + message
    return 'AudioCraft could not finish this pipeline audio request. Check the AudioCraft runtime and model setup, then try again.'


def write_pcm16_wav(output_path, waveform, sample_rate):
    try:
        import numpy as np
    except Exception:
        fail('AudioCraft generated audio, but Local AI Hub could not save it because NumPy is missing from the AudioCraft environment. Run Repair or reinstall AudioCraft WebUI, then try again.')

    wav = waveform.detach().cpu().float()
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    if wav.dim() != 2:
        fail('AudioCraft generated audio in an unsupported tensor shape, so Local AI Hub could not save it as a WAV file.')

    if wav.shape[0] > 8 and wav.shape[1] <= 8:
        wav = wav.transpose(0, 1)

    channel_count = int(wav.shape[0])
    frame_count = int(wav.shape[1])
    if channel_count < 1 or frame_count < 1:
        fail('AudioCraft generated an empty audio tensor, so Local AI Hub could not save it as a WAV file.')

    samples = wav.clamp(-1.0, 1.0).transpose(0, 1).contiguous().numpy()
    samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm16 = (samples * 32767.0).round().astype('<i2', copy=False)

    ensure_parent_directory(output_path)
    with wave.open(output_path, 'wb') as handle:
        handle.setnchannels(channel_count)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm16.tobytes(order='C'))


def read_pcm_wav(source_audio_path):
    try:
        import numpy as np
        import torch
    except Exception:
        fail('AudioCraft could not read the connected WAV guide because NumPy or Torch is missing from the AudioCraft environment. Run Repair or reinstall AudioCraft WebUI, then try again.')

    with wave.open(source_audio_path, 'rb') as handle:
        if handle.getcomptype() != 'NONE':
            fail('AudioCraft could not read the connected guide audio because it is a compressed WAV file. Use a standard PCM WAV file for audio guidance.')
        channel_count = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frame_count = handle.getnframes()
        raw = handle.readframes(frame_count)

    if channel_count < 1 or frame_count < 1:
        fail('AudioCraft could not read the connected guide audio because it is empty.')

    if sample_width == 1:
        samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sample_width == 2:
        samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif sample_width == 4:
        samples = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    else:
        fail('AudioCraft could not read the connected guide audio because its WAV bit depth is not supported yet.')

    samples = samples.reshape(-1, channel_count).transpose(1, 0).copy()
    return torch.from_numpy(samples), sample_rate


def load_audio_for_chroma(source_audio_path, torchaudio_module):
    try:
        return torchaudio_module.load(source_audio_path)
    except ImportError as error:
        if 'TorchCodec' in str(error or '') and source_audio_path.lower().endswith('.wav'):
            return read_pcm_wav(source_audio_path)
        raise


def load_audiocraft_runtime():
    missing = []
    failed = []

    def load_module(module_name, label):
        try:
            return importlib.import_module(module_name)
        except ModuleNotFoundError as exc:
            missing.append(getattr(exc, 'name', '') or label)
        except Exception:
            failed.append(label)
        return None

    torchaudio_module = load_module('torchaudio', 'torchaudio')
    audio_module = load_module('audiocraft.data.audio', 'audiocraft.data.audio')
    models_module = load_module('audiocraft.models', 'audiocraft.models')

    if missing:
        fail(format_missing_pipeline_packages(missing))
    if failed or not torchaudio_module or not audio_module or not models_module:
        fail('AudioCraft is installed, but Local AI Hub could not load the Python packages needed for pipeline audio generation. Run Repair or reinstall AudioCraft WebUI, then try again.')

    return torchaudio_module, audio_module.audio_write, models_module.AudioGen, models_module.MusicGen


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

    torchaudio, audio_write, AudioGen, MusicGen = load_audiocraft_runtime()

    duration_seconds = max(1, int(float(request.get('durationSeconds') or 8)))
    requested_model = str(request.get('model') or '').strip()
    validate_requested_model_path(requested_model, audio_mode)

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
                melody, melody_sample_rate = load_audio_for_chroma(source_audio_path, torchaudio)
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
        final_output_path = output_stem + '.wav'
        write_pcm16_wav(final_output_path, waveform, model.sample_rate)
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
    except Exception as error:
        traceback.print_exc()
        fail(summarize_runtime_exception(error))


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fallback_message = 'AudioCraft could not finish this pipeline audio request. Check the AudioCraft runtime and model setup, then try again.'
        traceback.print_exc()
        fail(fallback_message)
