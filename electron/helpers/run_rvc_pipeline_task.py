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
        fail('Local AI Hub could not find the RVC request file.')
    except json.JSONDecodeError:
        fail('Local AI Hub could not read the RVC request file.')


def ensure_parent_directory(path_value: str):
    parent = os.path.dirname(path_value)
    if parent:
        os.makedirs(parent, exist_ok=True)


def find_voice_model(weight_root: str, request: dict):
    requested_relative_path = str(request.get('voiceModelRelativePath') or '').strip()
    requested_path = str(request.get('voiceModelPath') or '').strip()
    requested_model = str(request.get('model') or '').strip()
    requested_name = str(request.get('voiceModelName') or '').strip()

    candidates = []
    if requested_path:
        candidates.append(os.path.abspath(requested_path))
    if requested_relative_path:
        candidates.append(os.path.abspath(os.path.join(weight_root, requested_relative_path)))
    if requested_model:
        candidates.append(os.path.abspath(os.path.join(weight_root, requested_model)))
        candidates.append(os.path.abspath(os.path.join(weight_root, os.path.basename(requested_model))))
    if requested_name:
        candidates.append(os.path.abspath(os.path.join(weight_root, requested_name)))
        candidates.append(os.path.abspath(os.path.join(weight_root, os.path.basename(requested_name))))

    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate

    requested_file_name = os.path.basename(requested_relative_path or requested_model or requested_name or requested_path)
    if requested_file_name:
        for root, _, files in os.walk(weight_root):
            for file_name in files:
                if file_name.lower() == requested_file_name.lower():
                    return os.path.join(root, file_name)

    return ''


def normalize_index_token(value: str):
    return ''.join(character.lower() if character.isalnum() else ' ' for character in str(value or '')).strip()


def compact_index_token(value: str):
    return ''.join(normalize_index_token(value).split())


def summarize_backend_info(info: str):
    lines = [line.strip() for line in str(info or '').splitlines() if line.strip()]
    if not lines:
        return ''

    useful_lines = []
    for line in lines:
        if line.startswith('Traceback '):
            continue
        if line.startswith('File "'):
            continue
        if line.startswith('^'):
            continue
        useful_lines.append(line)

    if not useful_lines:
        useful_lines = lines

    summary = useful_lines[-1]
    if len(summary) > 500:
        summary = summary[:497].rstrip() + '...'
    return summary


def build_incomplete_audio_message(info: str, output_path: str, source_audio_path: str):
    backend_detail = summarize_backend_info(info)
    lower_info = str(info or '').lower()
    expected_path = ' Expected output path: ' + output_path if output_path else ''

    if 'failed to load audio' in lower_info and ('winerror 2' in lower_info or 'ffmpeg' in lower_info or 'no such file' in lower_info or 'file not found' in lower_info):
        return 'RVC could not load the source audio because FFmpeg was not available to the RVC helper. Local AI Hub uses FFmpeg to decode audio formats such as M4A before voice conversion.' + expected_path

    if 'model file not found' in lower_info and 'hubert_base.pt' in lower_info:
        return 'RVC is missing its Hubert feature model at assets/hubert/hubert_base.pt. Run Repair or reinstall RVC, then try this voice conversion again.' + expected_path

    if ('model file not found' in lower_info or 'no such file' in lower_info or 'file not found' in lower_info) and 'rmvpe.pt' in lower_info:
        return 'RVC is missing its RMVPE pitch model at assets/rmvpe/rmvpe.pt. Run Repair or reinstall RVC, then try this voice conversion again.' + expected_path

    if 'keyerror' in lower_info and 'rmvpe_root' in lower_info:
        return 'RVC could not locate its RMVPE pitch model folder. Run Repair or reinstall RVC, then try this voice conversion again.' + expected_path

    if is_weights_only_load_error(info):
        return 'RVC could not load a local checkpoint with PyTorch\'s safe weights-only loader. Local AI Hub only retries normal RVC pickle-style checkpoint loading for files inside the managed RVC weights and assets folders. RVC .pth checkpoints can run pickle code while loading, so only use voice models from sources you trust.' + expected_path

    if backend_detail:
        return 'RVC did not return transformed audio. Backend reported: ' + backend_detail + '.' + expected_path

    return 'RVC finished, but it did not return transformed audio data.' + expected_path


def get_torch_load_path(load_target):
    if isinstance(load_target, (str, bytes, os.PathLike)):
        return os.fspath(load_target)
    target_name = getattr(load_target, 'name', '')
    if isinstance(target_name, (str, bytes, os.PathLike)):
        return os.fspath(target_name)
    return ''


def normalize_real_path(path_value: str):
    if not path_value:
        return ''
    try:
        return os.path.realpath(os.path.abspath(path_value))
    except (OSError, TypeError, ValueError):
        return ''


def path_is_inside(candidate: str, root: str):
    candidate_path = normalize_real_path(candidate)
    root_path = normalize_real_path(root)
    if not candidate_path or not root_path:
        return False
    return candidate_path == root_path or candidate_path.startswith(root_path + os.sep)


def is_weights_only_load_error(error):
    message = str(error or '').lower()
    return 'weights only load failed' in message or ('weights_only' in message and 'torch.load' in message)


def install_rvc_torch_load_compatibility(tool_root: str, weight_root: str):
    import torch

    if getattr(torch.load, '_localaihub_rvc_compat', False):
        return

    original_load = torch.load
    trusted_roots = [
        normalize_real_path(weight_root),
        normalize_real_path(os.path.join(tool_root, 'assets')),
    ]
    trusted_roots = [root for root in trusted_roots if root]

    def is_trusted_rvc_load_path(load_target):
        load_path = get_torch_load_path(load_target)
        return any(path_is_inside(load_path, trusted_root) for trusted_root in trusted_roots)

    def localaihub_rvc_torch_load(*args, **kwargs):
        if 'weights_only' in kwargs:
            return original_load(*args, **kwargs)

        try:
            return original_load(*args, **kwargs)
        except Exception as error:
            load_target = args[0] if args else None
            if not is_weights_only_load_error(error) or not is_trusted_rvc_load_path(load_target):
                raise
            if hasattr(load_target, 'seek'):
                try:
                    load_target.seek(0)
                except Exception:
                    pass
            retry_kwargs = dict(kwargs)
            retry_kwargs['weights_only'] = False
            return original_load(*args, **retry_kwargs)

    localaihub_rvc_torch_load._localaihub_rvc_compat = True
    localaihub_rvc_torch_load._localaihub_rvc_original = original_load
    torch.load = localaihub_rvc_torch_load


def find_index_file(tool_root: str, index_root: str, model_path: str, request: dict):
    requested_relative_path = str(request.get('voiceModelIndexRelativePath') or '').strip()
    requested_path = str(request.get('voiceModelIndexPath') or '').strip()
    candidates = []
    if requested_path:
        candidates.append(os.path.abspath(requested_path))
    if requested_relative_path:
        candidates.append(os.path.abspath(os.path.join(tool_root, requested_relative_path)))
        candidates.append(os.path.abspath(os.path.join(index_root, requested_relative_path)))

    for candidate in candidates:
        if candidate and candidate.lower().endswith('.index') and os.path.exists(candidate):
            return candidate

    if not os.path.exists(index_root):
        return ''

    index_files = []
    for root, _, files in os.walk(index_root):
        for file_name in files:
            if file_name.lower().endswith('.index'):
                index_files.append(os.path.join(root, file_name))

    if not index_files:
        return ''

    model_token = compact_index_token(os.path.splitext(os.path.basename(model_path))[0])
    if model_token and model_token not in {'model', 'pytorchmodel', 'weight', 'weights'}:
        for index_path in index_files:
            relative_index = os.path.relpath(index_path, index_root)
            if model_token in compact_index_token(relative_index):
                return index_path

    return index_files[0] if len(index_files) == 1 else ''


def normalize_model_token(model_path: str, weight_root: str):
    try:
        relative_path = os.path.relpath(model_path, weight_root)
    except ValueError:
        return os.path.basename(model_path)
    if relative_path.startswith('..'):
        return os.path.basename(model_path)
    return relative_path.replace('\\', '/')


def main():
    if len(sys.argv) < 2:
        fail('Local AI Hub did not receive an RVC request file path.')

    request = load_request(sys.argv[1])
    output_path = os.path.abspath(str(request.get('outputPath') or '').strip())
    source_audio_path = os.path.abspath(str(request.get('sourceAudioPath') or '').strip()) if str(request.get('sourceAudioPath') or '').strip() else ''
    tool_root = os.path.abspath(str(request.get('toolRoot') or os.getcwd()).strip())
    instruction = str(request.get('instruction') or '').strip()

    if not output_path:
        fail('Local AI Hub could not prepare the destination path for the transformed audio file.')

    if not source_audio_path:
        fail('Connect a source audio file before running this RVC step.')

    if not os.path.exists(source_audio_path):
        fail('The connected source audio file could not be found anymore. Choose it again and rerun the pipeline.')

    weight_root = os.path.join(tool_root, 'weights')
    index_root = os.path.join(tool_root, 'logs')
    rmvpe_root = os.path.join(tool_root, 'assets', 'rmvpe')
    if not os.path.exists(weight_root):
        fail('RVC is installed, but its weights folder is missing. Repair or reinstall RVC, then try again.')

    model_path = find_voice_model(weight_root, request)
    if not model_path:
        fail('The selected RVC voice model could not be found in the weights folder. Refresh the model list or choose another model, then try again.')

    model_token = normalize_model_token(model_path, weight_root)
    index_path = find_index_file(tool_root, index_root, model_path, request)
    target_voice = os.path.splitext(os.path.basename(model_path))[0]

    try:
        os.chdir(tool_root)
        if tool_root not in sys.path:
            sys.path.insert(0, tool_root)
        os.environ['weight_root'] = weight_root
        os.environ['index_root'] = index_root
        os.environ['rmvpe_root'] = rmvpe_root
        sys.argv = [sys.argv[0]]

        install_rvc_torch_load_compatibility(tool_root, weight_root)

        import numpy as np
        import soundfile as sf
        from configs.config import Config
        from infer.modules.vc.modules import VC
    except Exception:
        fail('RVC is installed, but its Python environment is missing the packages needed for voice conversion. Run Repair or reinstall RVC, then try again.')

    try:
        config = Config()
        vc = VC(config)
        vc.get_vc(model_token)
        info, converted_audio = vc.vc_single(
            0,
            source_audio_path,
            0,
            None,
            'rmvpe',
            index_path,
            '',
            0.75,
            3,
            0,
            0.25,
            0.33,
        )

        if not converted_audio or len(converted_audio) != 2:
            fail(build_incomplete_audio_message(info, output_path, source_audio_path))

        sample_rate, audio_array = converted_audio
        if sample_rate is None or audio_array is None:
            fail(build_incomplete_audio_message(info, output_path, source_audio_path))

        if hasattr(audio_array, 'cpu'):
            audio_array = audio_array.cpu().numpy()
        audio_array = np.asarray(audio_array)
        if audio_array.size == 0:
            fail(build_incomplete_audio_message(info, output_path, source_audio_path))
        if audio_array.ndim == 2 and audio_array.shape[0] <= 8:
            audio_array = audio_array.T

        ensure_parent_directory(output_path)
        sf.write(output_path, audio_array, int(sample_rate))
        if not os.path.exists(output_path):
            fail('RVC finished, but the transformed audio file could not be written to disk. Expected output path: ' + output_path)
        if os.path.getsize(output_path) <= 0:
            fail('RVC wrote an empty transformed audio file. Expected output path: ' + output_path)

        frame_count = audio_array.shape[0] if audio_array.ndim >= 1 else 0
        duration_seconds = round(float(frame_count) / float(sample_rate), 2) if frame_count and sample_rate else 0
        message = 'RVC transformed the source audio locally.'
        if instruction:
            message = 'RVC transformed the source audio locally and kept your note with the saved result metadata.'

        print(json.dumps({
            'durationSeconds': duration_seconds,
            'info': str(info or '').strip(),
            'message': message,
            'indexPath': index_path,
            'model': model_token,
            'outputPath': output_path,
            'sampleRate': int(sample_rate),
            'targetVoice': target_voice,
            'transformationType': 'voice-conversion',
        }))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        fail('RVC could not finish this voice conversion request. Check the selected voice model and RVC runtime, then try again.')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        fail('RVC could not finish this voice conversion request. Check the selected voice model and RVC runtime, then try again.')