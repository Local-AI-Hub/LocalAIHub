import json
import os
import re
import subprocess
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
        fail('Local AI Hub could not find the FaceFusion request file.')
    except json.JSONDecodeError:
        fail('Local AI Hub could not read the FaceFusion request file.')


def ensure_parent_directory(path_value: str):
    parent = os.path.dirname(path_value)
    if parent:
        os.makedirs(parent, exist_ok=True)


def first_non_empty_line(value: str):
    for line in str(value or '').splitlines():
        normalized = line.strip()
        if normalized:
            return normalized
    return ''


def is_progress_only_line(line: str):
    normalized = str(line or '').strip()
    if not normalized:
        return True
    return bool(re.search(r'\[FACEFUSION\.CORE\]\s+processing step \d+ of \d+', normalized, re.IGNORECASE))


def is_routine_status_line(line: str):
    normalized = str(line or '').strip()
    if is_progress_only_line(normalized):
        return True
    routine_patterns = [
        r'\[FACEFUSION\.DOWNLOAD\]\s+validating (?:hash|source) for .+ succeeded',
        r'\[FACEFUSION\.INFERENCE_MANAGER\]\s+loading model .+ succeeded',
    ]
    return any(re.search(pattern, normalized, re.IGNORECASE) for pattern in routine_patterns)


def summarize_process_output(stderr: str, stdout: str):
    combined = '\n'.join([str(stderr or ''), str(stdout or '')])
    missing_module = re.search(r"ModuleNotFoundError:\s+No module named ['\"]([^'\"]+)['\"]", combined, re.IGNORECASE)
    if missing_module:
        module_name = missing_module.group(1)
        if module_name.lower() == 'cv2':
            return 'FaceFusion is missing OpenCV (cv2). Run Repair to reinstall the opencv-python dependency required by this FaceFusion version.'
        if module_name.lower() == 'onnxruntime':
            return 'FaceFusion is missing ONNX Runtime (onnxruntime). Run Repair to reinstall the ONNX Runtime dependency declared by this FaceFusion version.'
        return f'FaceFusion is missing the Python package "{module_name}". Run Repair to rebuild its managed Python environment.'

    lines = [line.strip() for line in combined.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith('{'):
            try:
                payload = json.loads(line)
                message = str(payload.get('message') or '').strip()
                if message and not message.lower().startswith('traceback') and not is_progress_only_line(message):
                    return message
            except Exception:
                pass
        if re.match(r'^Traceback', line, re.IGNORECASE) or re.match(r'^File "', line):
            continue
        if is_routine_status_line(line):
            continue
        if re.search(r'(Error|Exception|No module named|failed|not found|invalid|match the target and output extension|no face|face.*not)', line, re.IGNORECASE):
            return line
        if '[FACEFUSION.' in line.upper():
            return line

    for line in lines:
        if not is_routine_status_line(line):
            return line
    return ''


def run_candidate(command, cwd):
    completed = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    return {
        'code': int(completed.returncode or 0),
        'stderr': str(completed.stderr or ''),
        'stdout': str(completed.stdout or ''),
    }


def output_exists(output_path: str):
    return bool(output_path) and os.path.exists(output_path) and os.path.getsize(output_path) > 0


def remove_file_if_exists(path_value: str):
    if path_value and os.path.exists(path_value) and os.path.isfile(path_value):
        os.remove(path_value)


def align_output_extension(output_path: str, target_path: str):
    target_extension = os.path.splitext(target_path)[1].lower()
    output_root, output_extension = os.path.splitext(output_path)
    if target_extension and output_extension and target_extension != output_extension.lower():
        return output_root + target_extension
    return output_path


def build_missing_output_message(output_path: str, attempts):
    progress_lines = []
    for attempt in attempts:
        combined = '\n'.join([str(attempt.get('stderr') or ''), str(attempt.get('stdout') or '')])
        for line in combined.splitlines():
            normalized = line.strip()
            if is_progress_only_line(normalized) and normalized not in progress_lines:
                progress_lines.append(normalized)
    progress_note = f' The last FaceFusion progress line was: {progress_lines[-1]}.' if progress_lines else ''
    return f'FaceFusion ran but did not produce a transformed image at {output_path}.{progress_note} Check that both connected images contain detectable faces, then try again.'


def build_candidate_commands(python_executable: str, facefusion_script: str, source_path: str, target_path: str, output_path: str):
    processor_sets = [
        ['face_swapper', 'face_enhancer'],
        ['face_swapper'],
    ]
    commands = []
    for processors in processor_sets:
        commands.append([
            python_executable,
            facefusion_script,
            'headless-run',
            '--source-path', source_path,
            '--target-path', target_path,
            '--output-path', output_path,
            '--processors',
            *processors,
            '--log-level', 'debug',
        ])
        commands.append([
            python_executable,
            facefusion_script,
            'run',
            '--headless',
            '--source-path', source_path,
            '--target-path', target_path,
            '--output-path', output_path,
            '--processors',
            *processors,
            '--log-level', 'debug',
        ])
        commands.append([
            python_executable,
            facefusion_script,
            'headless-run',
            '-s', source_path,
            '-t', target_path,
            '-o', output_path,
            '--processors',
            *processors,
            '--log-level', 'debug',
        ])
        commands.append([
            python_executable,
            facefusion_script,
            'run',
            '--headless',
            '-s', source_path,
            '-t', target_path,
            '-o', output_path,
            '--processors',
            *processors,
            '--log-level', 'debug',
        ])
    return commands


def main():
    if len(sys.argv) < 2:
        fail('Local AI Hub did not receive a FaceFusion request file path.')

    request = load_request(sys.argv[1])
    output_path = os.path.abspath(str(request.get('outputPath') or '').strip())
    reference_image_path = os.path.abspath(str(request.get('referenceImagePath') or '').strip()) if str(request.get('referenceImagePath') or '').strip() else ''
    target_image_path = os.path.abspath(str(request.get('targetImagePath') or '').strip()) if str(request.get('targetImagePath') or '').strip() else ''
    tool_root = os.path.abspath(str(request.get('toolRoot') or os.getcwd()).strip())
    instruction = str(request.get('instruction') or '').strip()

    if not output_path:
        fail('Local AI Hub could not prepare the destination path for the transformed image file.')

    if not target_image_path:
        fail('Connect a target image before running this FaceFusion step.')

    if not os.path.exists(target_image_path):
        fail('The connected target image could not be found anymore. Choose it again and rerun the pipeline.')

    if not reference_image_path:
        fail('FaceFusion needs a source face image on the Reference Image input.')

    if not os.path.exists(reference_image_path):
        fail('The source face image for this FaceFusion step could not be found anymore. Choose it again and rerun the pipeline.')

    facefusion_script = os.path.join(tool_root, 'facefusion.py')
    if not os.path.exists(facefusion_script):
        fail('FaceFusion is installed, but facefusion.py could not be found. Repair or reinstall FaceFusion, then try again.')

    output_path = align_output_extension(output_path, target_image_path)
    ensure_parent_directory(output_path)
    remove_file_if_exists(output_path)
    python_executable = sys.executable
    candidates = build_candidate_commands(python_executable, facefusion_script, reference_image_path, target_image_path, output_path)
    attempts = []

    try:
        for candidate in candidates:
            result = run_candidate(candidate, tool_root)
            attempts.append({
                'code': result['code'],
                'stderr': result['stderr'],
                'stdout': result['stdout'],
                'summary': summarize_process_output(result['stderr'], result['stdout']),
            })
            if result['code'] == 0 and output_exists(output_path):
                message = 'FaceFusion transformed the connected target image locally.'
                if instruction:
                    message = 'FaceFusion transformed the connected target image locally and kept your note with the saved result metadata.'
                print(json.dumps({
                    'message': message,
                    'outputPath': output_path,
                    'transformationType': 'face-swap',
                }))
                return
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        fail('FaceFusion could not finish this image transformation request. Check the FaceFusion runtime and selected images, then try again.')

    attempt_messages = []
    for attempt in attempts:
        candidate_message = attempt.get('summary') or first_non_empty_line(attempt.get('stderr')) or first_non_empty_line(attempt.get('stdout'))
        if candidate_message and not is_routine_status_line(candidate_message) and candidate_message not in attempt_messages:
            attempt_messages.append(candidate_message)

    fallback_message = build_missing_output_message(output_path, attempts)
    fail(attempt_messages[0] if attempt_messages else fallback_message)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        fail('FaceFusion could not finish this image transformation request. Check the FaceFusion runtime and selected images, then try again.')
