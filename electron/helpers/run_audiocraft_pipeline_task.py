import importlib
import json
import os
import time
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


def append_wav_files(request, output_path):
    source_audio_path = os.path.abspath(str(request.get('sourceAudioPath') or '').strip())
    segment_audio_path = os.path.abspath(str(request.get('segmentAudioPath') or '').strip())
    if not source_audio_path or not os.path.exists(source_audio_path):
        fail('Local AI Hub could not find the current cumulative audio file for AudioCraft continuation chaining.')
    if not segment_audio_path or not os.path.exists(segment_audio_path):
        fail('Local AI Hub could not find the generated continuation segment for AudioCraft continuation chaining.')

    try:
        with wave.open(source_audio_path, 'rb') as source_handle, wave.open(segment_audio_path, 'rb') as segment_handle:
            source_params = source_handle.getparams()
            segment_params = segment_handle.getparams()
            if source_params.comptype != 'NONE' or segment_params.comptype != 'NONE':
                fail('AudioCraft continuation chaining can only stitch standard PCM WAV files in this pass.')
            if source_params.nchannels != segment_params.nchannels or source_params.sampwidth != segment_params.sampwidth or source_params.framerate != segment_params.framerate:
                fail('AudioCraft generated a continuation segment, but Local AI Hub could not append it because the WAV channel layout or sample rate changed. Use one AudioCraft model and WAV output settings for the whole chain.')
            source_frames = source_handle.readframes(source_params.nframes)
            segment_frames = segment_handle.readframes(segment_params.nframes)
    except SystemExit:
        raise
    except Exception:
        fail('Local AI Hub could not read the WAV files needed to update the AudioCraft continuation chain.')

    ensure_parent_directory(output_path)
    try:
        with wave.open(output_path, 'wb') as output_handle:
            output_handle.setnchannels(source_params.nchannels)
            output_handle.setsampwidth(source_params.sampwidth)
            output_handle.setframerate(source_params.framerate)
            output_handle.writeframes(source_frames)
            output_handle.writeframes(segment_frames)
    except Exception:
        fail('AudioCraft generated the continuation segment, but Local AI Hub could not save the cumulative chain audio.')

    source_duration_seconds = float(source_params.nframes) / float(source_params.framerate) if source_params.framerate else 0
    segment_duration_seconds = float(segment_params.nframes) / float(segment_params.framerate) if segment_params.framerate else 0
    final_duration_seconds = source_duration_seconds + segment_duration_seconds
    print(json.dumps({
        'audioTask': 'append-audio',
        'finalOutputDurationSeconds': round(float(final_duration_seconds), 2),
        'message': 'Local AI Hub updated the cumulative AudioCraft continuation chain audio.',
        'outputPath': output_path,
        'segmentAudioPath': segment_audio_path,
        'segmentDurationSeconds': round(float(segment_duration_seconds), 2),
        'sourceAudioPath': source_audio_path,
        'sourceDurationSeconds': round(float(source_duration_seconds), 2),
    }))


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


def coerce_number(value, fallback, minimum=None, maximum=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(fallback)
    if minimum is not None:
        number = max(float(minimum), number)
    if maximum is not None:
        number = min(float(maximum), number)
    return number


def coerce_bool(value):
    if isinstance(value, bool):
        return value
    return str(value or '').strip().lower() in {'1', 'true', 'yes', 'on'}


MAX_CONTINUATION_REPEAT_COUNT = 10


def parse_continuation_repeat_count(value):
    if value is None or str(value).strip() == '':
        return 1
    try:
        number = float(value)
    except (TypeError, ValueError):
        fail('Continuation repeat count must be a whole number from 1 to ' + str(MAX_CONTINUATION_REPEAT_COUNT) + '.')
    if not number.is_integer():
        fail('Continuation repeat count must be a whole number from 1 to ' + str(MAX_CONTINUATION_REPEAT_COUNT) + '.')
    repeat_count = int(number)
    if repeat_count < 1 or repeat_count > MAX_CONTINUATION_REPEAT_COUNT:
        fail('Continuation repeat count must be between 1 and ' + str(MAX_CONTINUATION_REPEAT_COUNT) + '.')
    return repeat_count


def build_generation_params(request, duration_seconds):
    settings = request.get('generationSettings') if isinstance(request.get('generationSettings'), dict) else {}
    return {
        'cfg_coef': coerce_number(settings.get('cfgCoef'), 3.0, 0.0, 20.0),
        'duration': duration_seconds,
        'temperature': coerce_number(settings.get('temperature'), 1.0, 0.01, 5.0),
        'top_k': int(coerce_number(settings.get('topK'), 250, 0, 10000)),
        'top_p': coerce_number(settings.get('topP'), 0.0, 0.0, 1.0),
        'two_step_cfg': coerce_bool(settings.get('twoStepCfg')),
    }


def trim_end_seed(waveform, sample_rate, requested_seed_seconds):
    if waveform.dim() == 1:
        waveform = waveform.unsqueeze(0)
    if waveform.dim() != 2:
        fail('AudioCraft could not use the source audio because it has an unsupported tensor shape.')

    frame_count = int(waveform.shape[-1])
    if sample_rate <= 0 or frame_count <= 0:
        fail('AudioCraft could not use the source audio because it is empty.')

    source_duration = float(frame_count) / float(sample_rate)
    if source_duration < 0.25:
        fail('The source audio is too short for AudioCraft continuation. Use a clip that is at least a quarter second long.')

    seed_seconds = coerce_number(requested_seed_seconds, 12.0, 0.25, source_duration)
    seed_frames = max(1, min(frame_count, int(round(seed_seconds * sample_rate))))
    seed_audio = waveform[..., frame_count - seed_frames:].contiguous()
    actual_seed_seconds = float(seed_frames) / float(sample_rate)
    return seed_audio, source_duration, actual_seed_seconds


def normalize_source_for_append(source_audio, source_sample_rate, target_sample_rate, target_channels, torchaudio_module, purpose='append-source output'):
    source = source_audio.detach().cpu().float()
    if source.dim() == 1:
        source = source.unsqueeze(0)
    if source.dim() != 2:
        fail('AudioCraft could not prepare the source audio for ' + purpose + ' because it has an unsupported tensor shape.')

    if int(source_sample_rate) != int(target_sample_rate):
        try:
            source = torchaudio_module.functional.resample(source, int(source_sample_rate), int(target_sample_rate))
        except Exception:
            fail('AudioCraft generated the continuation, but Local AI Hub could not resample the source audio for ' + purpose + '. Try a WAV source that matches the AudioCraft model sample rate, or switch back to continuation-only output.')

    source_channels = int(source.shape[0])
    target_channels = int(target_channels)
    if source_channels < 1 or target_channels < 1:
        fail('AudioCraft could not prepare audio for ' + purpose + ' because one of the audio tensors has no channels.')

    if source_channels == target_channels:
        return source.contiguous()
    if source_channels == 1 and target_channels > 1:
        return source.repeat(target_channels, 1).contiguous()
    if target_channels == 1 and source_channels > 1:
        return source.mean(dim=0, keepdim=True).contiguous()
    if source_channels < target_channels:
        repeat_count = int((target_channels + source_channels - 1) / source_channels)
        return source.repeat(repeat_count, 1)[:target_channels, :].contiguous()

    fail('AudioCraft generated the continuation, but Local AI Hub could not match the source audio channel layout for ' + purpose + '. Use mono or stereo source audio, or switch back to continuation-only output.')


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

    audio_task = str(request.get('audioTask') or '').strip().lower()
    if audio_task == 'append-audio':
        append_wav_files(request, output_path)
        return

    prompt = str(request.get('prompt') or '').strip()
    audio_mode = str(request.get('audioMode') or 'music').strip().lower() or 'music'
    source_audio_path = os.path.abspath(str(request.get('sourceAudioPath') or '').strip()) if str(request.get('sourceAudioPath') or '').strip() else ''
    if audio_mode not in {'music', 'sound', 'continuation'}:
        audio_mode = 'music'

    if audio_mode == 'sound' and source_audio_path:
        fail('Sound mode currently accepts text prompts only in this Local AI Hub audio slice. Switch the step to Music mode if you want to guide generation with audio.')

    if audio_mode == 'continuation' and not source_audio_path:
        fail('Continuation mode needs a source audio clip. Connect an Audio File node or an earlier audio output, then run this AudioCraft step again.')

    if audio_mode != 'continuation' and not prompt and not source_audio_path:
        fail('Add a text prompt or connect an audio guide before running this AudioCraft step.')

    if source_audio_path and not os.path.exists(source_audio_path):
        fail('The connected source audio file could not be found anymore. Choose it again and rerun the pipeline.')

    torchaudio, audio_write, AudioGen, MusicGen = load_audiocraft_runtime()

    duration_seconds = max(1, int(float(request.get('durationSeconds') or 8)))
    requested_model = str(request.get('model') or '').strip()
    validate_requested_model_path(requested_model, audio_mode)
    generation_params = build_generation_params(request, duration_seconds)
    continuation_seed_seconds = coerce_number(request.get('continuationSeedSeconds'), 12.0, 0.25, 120.0)
    continuation_repeat_count = parse_continuation_repeat_count(request.get('repeatCount', request.get('continuationRepeatCount'))) if audio_mode == 'continuation' else 1
    heavy_step_cooldown_seconds = max(0, min(300, int(float(request.get('heavyStepCooldownSeconds') or 0)))) if audio_mode == 'continuation' else 0
    append_source = audio_mode == 'continuation' and coerce_bool(request.get('appendSource'))
    generated_duration_seconds = 0
    requested_generated_duration_seconds = duration_seconds * continuation_repeat_count if audio_mode == 'continuation' else duration_seconds
    source_duration_seconds = 0
    actual_seed_seconds = 0
    continuation_repeat_details = []
    source_audio = None
    source_sample_rate = 0
    waveform = None
    wav_batch = None

    try:
        if audio_mode == 'sound':
            model_name = requested_model or 'facebook/audiogen-medium'
            model = AudioGen.get_pretrained(model_name)
            model.set_generation_params(**generation_params)
            wav_batch = model.generate([prompt or 'generated audio'])
        elif audio_mode == 'continuation':
            try:
                import torch
            except Exception:
                fail('AudioCraft could not prepare repeat continuation because Torch is missing from the AudioCraft environment. Run Repair or reinstall AudioCraft WebUI, then try again.')

            model_name = requested_model or 'facebook/musicgen-small'
            model = MusicGen.get_pretrained(model_name)
            if not hasattr(model, 'generate_continuation'):
                fail('The selected AudioCraft model does not expose continuation generation. Choose a MusicGen model or snapshot that supports continuation.')
            source_audio, source_sample_rate = load_audio_for_chroma(source_audio_path, torchaudio)
            current_audio = source_audio.detach().cpu().float()
            if current_audio.dim() == 1:
                current_audio = current_audio.unsqueeze(0)
            if current_audio.dim() != 2:
                fail('AudioCraft could not use the source audio because it has an unsupported tensor shape.')
            current_sample_rate = int(source_sample_rate)
            descriptions = [prompt] if prompt else None
            generated_segments = []
            generated_frame_count = 0

            for repeat_index in range(1, continuation_repeat_count + 1):
                if repeat_index > 1 and heavy_step_cooldown_seconds > 0:
                    time.sleep(heavy_step_cooldown_seconds)
                seed_audio, current_duration_seconds, actual_seed_seconds = trim_end_seed(current_audio, current_sample_rate, continuation_seed_seconds)
                if repeat_index == 1:
                    source_duration_seconds = current_duration_seconds
                seed_start_seconds = max(0.0, current_duration_seconds - actual_seed_seconds)
                total_duration_seconds = actual_seed_seconds + duration_seconds
                model.set_generation_params(**build_generation_params(request, total_duration_seconds))
                try:
                    repeat_batch = model.generate_continuation(seed_audio, current_sample_rate, descriptions=descriptions)
                except Exception as error:
                    fail('AudioCraft could not generate continuation repeat ' + str(repeat_index) + ' of ' + str(continuation_repeat_count) + '. ' + summarize_runtime_exception(error))

                if repeat_batch is None or len(repeat_batch) == 0:
                    fail('AudioCraft finished repeat ' + str(repeat_index) + ', but it did not return any generated audio.')

                generated_waveform = repeat_batch[0].cpu()
                if generated_waveform.dim() == 1:
                    generated_waveform = generated_waveform.unsqueeze(0)
                if generated_waveform.dim() != 2:
                    fail('AudioCraft returned an unsupported audio tensor shape on continuation repeat ' + str(repeat_index) + '.')

                prompt_frames = int(round(actual_seed_seconds * float(model.sample_rate)))
                if generated_waveform.shape[-1] <= prompt_frames:
                    fail('AudioCraft returned only the continuation prompt on repeat ' + str(repeat_index) + ' and did not produce new audio. Shorten the seed or increase the continuation duration.')
                continuation_segment = generated_waveform[..., prompt_frames:].contiguous()
                segment_frames = int(continuation_segment.shape[-1])
                if segment_frames < 1:
                    fail('AudioCraft returned an empty continuation segment on repeat ' + str(repeat_index) + '.')

                try:
                    current_audio_for_repeat = current_audio
                    if int(current_sample_rate) != int(model.sample_rate) or int(current_audio_for_repeat.shape[0]) != int(continuation_segment.shape[0]):
                        current_audio_for_repeat = normalize_source_for_append(current_audio_for_repeat, current_sample_rate, model.sample_rate, int(continuation_segment.shape[0]), torchaudio, 'repeat continuation')
                    current_audio = torch.cat([current_audio_for_repeat, continuation_segment], dim=-1).contiguous()
                    current_sample_rate = int(model.sample_rate)
                    generated_segments.append(continuation_segment)
                    generated_frame_count += segment_frames
                except SystemExit:
                    raise
                except Exception:
                    fail('AudioCraft generated continuation repeat ' + str(repeat_index) + ', but Local AI Hub could not stitch it onto the current audio for the next repeat.')

                segment_duration_seconds = float(segment_frames) / float(model.sample_rate)
                continuation_repeat_details.append({
                    'repeatIndex': repeat_index,
                    'seedStartSeconds': round(float(seed_start_seconds), 2),
                    'seedEndSeconds': round(float(current_duration_seconds), 2),
                    'seedSeconds': round(float(actual_seed_seconds), 2),
                    'generatedSegmentDurationSeconds': round(float(segment_duration_seconds), 2),
                    'cumulativeDurationAfterRepeatSeconds': round(float(current_audio.shape[-1]) / float(model.sample_rate), 2),
                })

            if not generated_segments:
                fail('AudioCraft did not produce any continuation segments.')
            waveform = torch.cat(generated_segments, dim=-1).contiguous()
            generated_duration_seconds = round(float(generated_frame_count) / float(model.sample_rate), 2) if generated_frame_count else 0
            if append_source:
                source_for_append = normalize_source_for_append(source_audio, source_sample_rate, model.sample_rate, int(waveform.shape[0]), torchaudio)
                try:
                    waveform = torch.cat([source_for_append, waveform], dim=-1).contiguous()
                except Exception:
                    fail('AudioCraft generated the continuation, but Local AI Hub could not stitch the source audio and continuation into one WAV file. Switch back to continuation-only output and try again.')
        else:
            model_name = requested_model or ('facebook/musicgen-melody' if source_audio_path else 'facebook/musicgen-medium')
            model = MusicGen.get_pretrained(model_name)
            model.set_generation_params(**generation_params)
            if source_audio_path:
                melody, melody_sample_rate = load_audio_for_chroma(source_audio_path, torchaudio)
                if melody.dim() == 1:
                    melody = melody.unsqueeze(0)
                if melody.dim() == 2:
                    melody = melody.unsqueeze(0)
                wav_batch = model.generate_with_chroma([prompt], melody, melody_sample_rate)
            else:
                wav_batch = model.generate([prompt or 'generated music'])

        if audio_mode != 'continuation':
            if wav_batch is None or len(wav_batch) == 0:
                fail('AudioCraft finished, but it did not return any generated audio.')

            waveform = wav_batch[0].cpu()
            if waveform.dim() == 1:
                waveform = waveform.unsqueeze(0)

        if waveform is None:
            fail('AudioCraft finished, but it did not return any generated audio.')

        output_stem, _ = os.path.splitext(output_path)
        final_output_path = output_stem + '.wav'
        write_pcm16_wav(final_output_path, waveform, model.sample_rate)
        if not os.path.exists(final_output_path):
            fail('AudioCraft finished, but the generated audio file could not be written to disk.')

        duration_value = round(float(waveform.shape[-1]) / float(model.sample_rate), 2) if waveform.shape[-1] else 0
        if audio_mode == 'continuation' and not generated_duration_seconds:
            generated_duration_seconds = duration_value
        message = 'AudioCraft generated audio locally.'
        if audio_mode == 'continuation' and append_source:
            message = 'AudioCraft generated ' + str(continuation_repeat_count) + ' continuation segment' + ('' if continuation_repeat_count == 1 else 's') + ' and appended them to the source audio.'
        elif audio_mode == 'continuation':
            message = 'AudioCraft generated ' + str(continuation_repeat_count) + ' continuation segment' + ('' if continuation_repeat_count == 1 else 's') + ' from the end of the connected source audio.'
        elif source_audio_path:
            message = 'AudioCraft generated audio locally using the connected source audio as guidance.'

        print(json.dumps({
            'advancedSettings': {
                'cfgCoef': generation_params['cfg_coef'],
                'temperature': generation_params['temperature'],
                'topK': generation_params['top_k'],
                'topP': generation_params['top_p'],
                'twoStepCfg': generation_params['two_step_cfg'],
            },
            'appendSource': bool(append_source),
            'audioMode': audio_mode,
            'continuationRepeatCount': int(continuation_repeat_count),
            'continuationRepeats': continuation_repeat_details,
            'continuationSeedSeconds': round(float(actual_seed_seconds), 2) if actual_seed_seconds else 0,
            'durationSeconds': duration_value,
            'finalOutputDurationSeconds': duration_value,
            'generatedDurationSeconds': generated_duration_seconds,
            'repeatCount': int(continuation_repeat_count),
            'requestedGeneratedDurationSeconds': round(float(requested_generated_duration_seconds), 2),
            'message': message,
            'model': model_name,
            'outputPath': final_output_path,
            'prompt': prompt,
            'sampleRate': int(model.sample_rate),
            'sourceAudioPath': source_audio_path,
            'sourceDurationSeconds': round(float(source_duration_seconds), 2) if source_duration_seconds else 0,
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
