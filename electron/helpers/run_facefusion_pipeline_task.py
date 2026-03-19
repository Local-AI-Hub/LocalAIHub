import json
import os
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

    ensure_parent_directory(output_path)
    python_executable = sys.executable
    candidates = build_candidate_commands(python_executable, facefusion_script, reference_image_path, target_image_path, output_path)
    attempts = []

    try:
        for candidate in candidates:
            result = run_candidate(candidate, tool_root)
            attempts.append({
                'code': result['code'],
                'stderr': first_non_empty_line(result['stderr']),
                'stdout': first_non_empty_line(result['stdout']),
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
        candidate_message = attempt['stderr'] or attempt['stdout']
        if candidate_message and candidate_message not in attempt_messages:
            attempt_messages.append(candidate_message)

    fail(attempt_messages[0] if attempt_messages else 'FaceFusion could not finish this image transformation request. Check the FaceFusion runtime and selected images, then try again.')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        fail('FaceFusion could not finish this image transformation request. Check the FaceFusion runtime and selected images, then try again.')
