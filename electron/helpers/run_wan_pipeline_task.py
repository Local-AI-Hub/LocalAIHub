import glob
import json
import os
import sys


def fail(message):
    raise RuntimeError(str(message).strip() or 'Wan2.1 could not finish the local video request.')


def load_request(request_path):
    if not request_path:
        fail('Local AI Hub could not find the Wan request file.')

    with open(request_path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def normalize_size(size_value):
    normalized = str(size_value or '').strip().lower()
    if normalized not in {'832x480', '1280x720'}:
        fail('Wan2.1 currently supports only 832x480 or 1280x720 in this first local-video pipeline slice.')
    width_text, height_text = normalized.split('x', 1)
    return normalized, int(width_text), int(height_text)


def resolve_base_models_dir(tool_root):
    candidates = [
        os.path.join(tool_root, 'models', 'Wan-AI'),
        os.path.join(tool_root, 'Wan2.1', 'models', 'Wan-AI'),
    ]
    for candidate in candidates:
        if os.path.isdir(candidate):
            return candidate
    fail('Wan2.1 models were not found under models\\Wan-AI inside the installed tool folder. Download the matching Wan model set first, then rerun the pipeline.')


def find_named_model_dir(base_dir, model_name):
    normalized_target = str(model_name or '').strip().lower()
    if not normalized_target:
        return None

    direct_candidates = [
        model_name,
        os.path.basename(model_name),
    ]
    for candidate in direct_candidates:
        joined = os.path.join(base_dir, candidate)
        if os.path.isdir(joined):
            return joined

    for entry in os.listdir(base_dir):
        full_path = os.path.join(base_dir, entry)
        if os.path.isdir(full_path) and entry.strip().lower() == normalized_target:
            return full_path

    return None


def pick_model_dir(base_dir, requested_model, reference_image_path, normalized_size):
    if requested_model:
        requested_dir = find_named_model_dir(base_dir, requested_model)
        if requested_dir:
            return requested_dir
        fail('The selected Wan model folder could not be found inside models\\Wan-AI. Enter a valid folder name or leave the model field blank so Local AI Hub can auto-detect one.')

    if reference_image_path:
        preferred = ['Wan2.1-I2V-14B-480P'] if normalized_size == '832x480' else ['Wan2.1-I2V-14B-720P', 'Wan2.1-I2V-14B-480P']
    else:
        preferred = ['Wan2.1-T2V-1.3B', 'Wan2.1-T2V-14B'] if normalized_size == '832x480' else ['Wan2.1-T2V-14B', 'Wan2.1-T2V-1.3B']

    for folder_name in preferred:
        full_path = os.path.join(base_dir, folder_name)
        if os.path.isdir(full_path):
            return full_path

    requested_mode = 'image-to-video' if reference_image_path else 'text-to-video'
    fail('Local AI Hub could not find a compatible Wan model folder for ' + requested_mode + '. Install one of the expected Wan2.1 model folders under models\\Wan-AI and try again.')


def collect_diffusion_weights(model_dir):
    shard_paths = sorted(glob.glob(os.path.join(model_dir, 'diffusion_pytorch_model-*.safetensors')))
    if shard_paths:
        return shard_paths

    single_path = os.path.join(model_dir, 'diffusion_pytorch_model.safetensors')
    if os.path.isfile(single_path):
        return single_path

    alt_paths = sorted(glob.glob(os.path.join(model_dir, 'diffusion_pytorch_model*.safetensors')))
    if len(alt_paths) == 1:
        return alt_paths[0]
    if alt_paths:
        return alt_paths

    fail('Wan2.1 diffusion weights were not found in the selected model folder.')


def pick_required_file(model_dir, patterns, missing_message):
    for pattern in patterns:
        matches = sorted(glob.glob(os.path.join(model_dir, pattern)))
        if matches:
            return matches[0]
    fail(missing_message)


def load_pipeline_components(model_dir, reference_image_path):
    diffusion_weights = collect_diffusion_weights(model_dir)
    text_encoder = pick_required_file(
        model_dir,
        ['models_t5_*.pth'],
        'Wan2.1 text encoder weights were not found in the selected model folder.',
    )
    vae_path = pick_required_file(
        model_dir,
        ['Wan2.1_VAE.pth', '*VAE*.pth'],
        'Wan2.1 VAE weights were not found in the selected model folder.',
    )
    image_encoder = None
    if reference_image_path:
        image_encoder = pick_required_file(
            model_dir,
            ['models_clip_*.pth'],
            'Wan2.1 image-to-video needs the CLIP image encoder weights, but they were not found in the selected model folder.',
        )

    return {
        'diffusion_weights': diffusion_weights,
        'image_encoder': image_encoder,
        'text_encoder': text_encoder,
        'vae_path': vae_path,
    }


def main():
    try:
        request_path = sys.argv[1] if len(sys.argv) > 1 else ''
        request = load_request(request_path)
        prompt = str(request.get('prompt') or '').strip()
        if not prompt:
            fail('Wan2.1 did not receive a prompt for this video step.')

        tool_root = os.path.abspath(str(request.get('toolRoot') or '').strip())
        if not tool_root or not os.path.isdir(tool_root):
            fail('Local AI Hub could not find the installed Wan tool folder for this pipeline step.')

        output_path = os.path.abspath(str(request.get('outputPath') or '').strip())
        if not output_path:
            fail('Local AI Hub could not determine where to save the generated video.')
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        normalized_size, width, height = normalize_size(request.get('size'))
        reference_image_path = os.path.abspath(str(request.get('referenceImagePath') or '').strip()) if request.get('referenceImagePath') else ''
        if reference_image_path and not os.path.isfile(reference_image_path):
            fail('The reference image for the Wan video step could not be found anymore.')

        try:
            import torch
        except ModuleNotFoundError:
            fail('Wan2.1 is missing PyTorch in its Python environment. Run Repair to reinstall the Wan dependencies.')

        try:
            from diffsynth import ModelManager, WanVideoPipeline, save_video
        except ModuleNotFoundError:
            fail('Wan2.1 is missing the DiffSynth runtime used by Local AI Hub for local video generation. Run Repair to reinstall the Wan dependencies.')

        try:
            from PIL import Image
        except ModuleNotFoundError:
            fail('Wan2.1 is missing Pillow in its Python environment. Run Repair to reinstall the Wan dependencies.')

        if not torch.cuda.is_available():
            fail('Wan2.1 local video generation needs a working NVIDIA driver and CUDA-enabled PyTorch runtime. The CUDA Toolkit or nvcc is separate and is only needed for optional build acceleration such as flash_attn.')

        total_vram_mb = 0
        try:
            total_vram_mb = int(torch.cuda.get_device_properties(0).total_memory // (1024 * 1024))
        except Exception:
            total_vram_mb = 0
        if total_vram_mb and total_vram_mb < 12288:
            fail('Wan2.1 local video generation is not practical on this GPU: Local AI Hub detected about ' + str(round(total_vram_mb / 1024, 1)) + ' GB of VRAM, while Wan2.1 is aimed at 12 GB or more. The install can stay in place, but use a higher-VRAM GPU or a lighter video workflow for generation.')

        base_models_dir = resolve_base_models_dir(tool_root)
        model_dir = pick_model_dir(base_models_dir, request.get('model'), reference_image_path, normalized_size)
        components = load_pipeline_components(model_dir, reference_image_path)

        model_manager = ModelManager(device='cpu')
        if components['image_encoder']:
            model_manager.load_models([components['image_encoder']], torch_dtype=torch.float32)

        diffusion_dtype = torch.bfloat16
        if '14b' in os.path.basename(model_dir).lower() and hasattr(torch, 'float8_e4m3fn') and not components['image_encoder']:
            diffusion_dtype = torch.float8_e4m3fn

        model_manager.load_models(
            [
                components['diffusion_weights'],
                components['text_encoder'],
                components['vae_path'],
            ],
            torch_dtype=diffusion_dtype,
        )

        pipe = WanVideoPipeline.from_model_manager(model_manager, torch_dtype=torch.bfloat16, device='cuda')
        if components['image_encoder']:
            pipe.enable_vram_management(num_persistent_param_in_dit=6 * 10**9)
        else:
            pipe.enable_vram_management(num_persistent_param_in_dit=None)

        call_args = {
            'prompt': prompt,
            'negative_prompt': str(request.get('negativePrompt') or '').strip(),
            'num_inference_steps': max(1, int(request.get('steps') or 24)),
            'seed': int(request.get('seed') or 0),
            'tiled': True,
        }
        if reference_image_path:
            input_image = Image.open(reference_image_path).convert('RGB')
            if input_image.size != (width, height):
                fail('The reference image dimensions do not match the selected Wan video size. Use a matching image or change the video size in the pipeline step.')
            call_args['input_image'] = input_image

        video = pipe(**call_args)
        fps = max(1, int(request.get('fps') or 15))
        quality = max(1, int(request.get('quality') or 5))
        save_video(video, output_path, fps=fps, quality=quality)

        response = {
            'message': 'Wan2.1 rendered the video locally and saved it into this pipeline run.',
            'modelDir': model_dir,
            'outputPath': output_path,
            'size': normalized_size,
            'usedReferenceImage': bool(reference_image_path),
        }
        print(json.dumps(response, ensure_ascii=True))
    except Exception as error:
        print(str(error).strip() or 'Wan2.1 could not finish the local video request.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
