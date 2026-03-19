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
    if not os.path.exists(weight_root):
        fail('RVC is installed, but its weights folder is missing. Repair or reinstall RVC, then try again.')

    model_path = find_voice_model(weight_root, request)
    if not model_path:
        fail('The selected RVC voice model could not be found in the weights folder. Refresh the model list or choose another model, then try again.')

    model_token = normalize_model_token(model_path, weight_root)
    target_voice = os.path.splitext(os.path.basename(model_path))[0]

    try:
        os.chdir(tool_root)
        if tool_root not in sys.path:
            sys.path.insert(0, tool_root)
        os.environ['weight_root'] = weight_root
        os.environ['index_root'] = index_root
        sys.argv = [sys.argv[0]]

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
            '',
            '',
            0.75,
            3,
            0,
            0.25,
            0.33,
        )

        if not converted_audio or len(converted_audio) != 2:
            fail('RVC finished, but it did not return a transformed audio file.')

        sample_rate, audio_array = converted_audio
        if sample_rate is None or audio_array is None:
            fail('RVC finished, but the transformed audio data was incomplete.')

        if hasattr(audio_array, 'cpu'):
            audio_array = audio_array.cpu().numpy()
        audio_array = np.asarray(audio_array)
        if audio_array.ndim == 2 and audio_array.shape[0] <= 8:
            audio_array = audio_array.T

        ensure_parent_directory(output_path)
        sf.write(output_path, audio_array, int(sample_rate))
        if not os.path.exists(output_path):
            fail('RVC finished, but the transformed audio file could not be written to disk.')

        frame_count = audio_array.shape[0] if audio_array.ndim >= 1 else 0
        duration_seconds = round(float(frame_count) / float(sample_rate), 2) if frame_count and sample_rate else 0
        message = 'RVC transformed the source audio locally.'
        if instruction:
            message = 'RVC transformed the source audio locally and kept your note with the saved result metadata.'

        print(json.dumps({
            'durationSeconds': duration_seconds,
            'info': str(info or '').strip(),
            'message': message,
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