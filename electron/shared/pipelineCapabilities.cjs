const MODALITY_TEXT = 'text';
const MODALITY_IMAGE = 'image';
const MODALITY_AUDIO = 'audio';
const MODALITY_VIDEO = 'video';
const MODALITY_FILE = 'file';
const MODALITY_PLAN = 'plan';

const RECORD_INPUT_MODE_IDS = Object.freeze({
  MICROPHONE: 'microphone',
  SCREEN: 'screen',
  SCREEN_MICROPHONE: 'screenMic',
  WEBCAM: 'webcam',
  WEBCAM_MICROPHONE: 'webcamMic',
  SYSTEM_AUDIO: 'systemAudio',
  SCREEN_SYSTEM_AUDIO: 'screenSystemAudio',
});

const RECORD_INPUT_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.SCREEN, label: 'Screen only', outputKind: MODALITY_VIDEO, backend: 'ffmpeg', needsScreen: true }),
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.MICROPHONE, label: 'Microphone only', outputKind: MODALITY_AUDIO, backend: 'ffmpeg', needsMicrophone: true }),
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.SCREEN_MICROPHONE, label: 'Screen + microphone', outputKind: MODALITY_VIDEO, backend: 'ffmpeg', needsScreen: true, needsMicrophone: true }),
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.WEBCAM, label: 'Webcam only', outputKind: MODALITY_VIDEO, backend: 'ffmpeg', needsWebcam: true }),
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.WEBCAM_MICROPHONE, label: 'Webcam + microphone', outputKind: MODALITY_VIDEO, backend: 'ffmpeg', needsMicrophone: true, needsWebcam: true }),
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.SYSTEM_AUDIO, label: 'System audio only', outputKind: MODALITY_AUDIO, backend: 'electron', needsDisplay: true, needsSystemAudio: true }),
  Object.freeze({ id: RECORD_INPUT_MODE_IDS.SCREEN_SYSTEM_AUDIO, label: 'Screen + system audio', outputKind: MODALITY_VIDEO, backend: 'electron', needsDisplay: true, needsScreen: true, needsSystemAudio: true }),
]);

const PIPELINE_RECORD_INPUT_CAPABILITY = Object.freeze({
  inputKinds: Object.freeze([]),
  outputKinds: Object.freeze([MODALITY_AUDIO, MODALITY_VIDEO]),
  interactive: true,
  autoStart: false,
  modes: RECORD_INPUT_MODE_OPTIONS,
  unsupportedCombinations: Object.freeze([
    'screenWebcam',
    'window',
    'systemAudioMicrophone',
    'webcamSystemAudio',
  ]),
});

const PIPELINE_OPERATION_IDS = Object.freeze({
  GRAPH_WORKFLOW: 'graphWorkflow',
  IMAGE_ANALYZE: 'imageAnalyze',
  IMAGE_GENERATE: 'imageGenerate',
  IMAGE_TRANSFORM: 'imageTransform',
  VIDEO_GENERATE: 'videoGenerate',
  AUDIO_GENERATE: 'audioGenerate',
  AUDIO_TRANSFORM: 'audioTransform',
  LLM_PROMPT: 'llmPrompt',
  VALIDATION_LLM: 'validationLlm',
  WHISPER_TRANSCRIBE: 'whisperTranscribe',
});

const TOOL_PIPELINE_STRATEGY_IDS = Object.freeze({
  GRAPH_NATIVE_DEFERRED: 'graph-native-deferred',
  GRAPH_NATIVE_WORKFLOW: 'graph-native-workflow',
  LOCAL_MODEL_RUNTIME: 'local-model-runtime',
  LOCAL_OPERATION_TOOL: 'local-operation-tool',
});

const TOOL_PIPELINE_STRATEGIES = Object.freeze({
  ollama: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_MODEL_RUNTIME,
    label: 'Local model runtime',
    notes: 'Ollama fits the model-step architecture for text generation and multimodal text output, but it is not used for local media generation in this pass.',
  }),
  whisper: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Whisper fits the sequential model-step pipeline for local audio transcription and runs through the embedded faster-whisper task adapter with typed text output and source-audio lineage.',
  }),
  automatic1111: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Automatic1111 exposes a simple WebUI API that fits the current sequential model-step pipeline for text-to-image generation.',
  }),
  forge: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Forge exposes a simple WebUI API that fits the current sequential model-step pipeline for text-to-image generation.',
  }),
  upscayl: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Upscayl uses the main image input and returns an enhanced or upscaled image artifact with lineage tied to the connected source image.',
  }),
  facefusion: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'FaceFusion uses the main image input as the target image and the Reference Image input as the source face, then returns the transformed image artifact.',
  }),
  'wan21-webui': Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Wan2.1 WebUI fits the sequential model-step pipeline for local video generation, but Local AI Hub runs it through a dedicated direct Python adapter instead of flattening graph-native tools into the same shape.',
  }),
  'audiocraft-webui': Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'AudioCraft WebUI fits the sequential model-step pipeline for generated audio, and Local AI Hub runs it through a dedicated direct Python adapter so prompt-to-audio artifacts stay typed and reusable inside the pipeline.',
  }),
  'chatterbox-tts': Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'Chatterbox-Turbo fits the sequential model-step pipeline for reference voice TTS, and Local AI Hub runs it through a dedicated direct Python adapter instead of launching a WebUI.',
  }),
  rvc: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL,
    label: 'Operation-driven local tool',
    notes: 'RVC fits the sequential model-step pipeline for source-audio transformation, and Local AI Hub runs it through a dedicated direct Python adapter so transformed audio artifacts keep clear lineage back to the source clip.',
  }),
  comfyui: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW,
    label: 'Graph-native workflow tool',
    notes: 'ComfyUI uses the dedicated graph workflow step with explicit typed boundaries and an imported workflow contract instead of the model-step abstraction.',
  }),
  invokeai: Object.freeze({
    id: TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW,
    label: 'Graph-native workflow tool',
    notes: "InvokeAI uses the dedicated graph workflow step with an imported workflow-or-graph contract and Local AI Hub submits the executable graph through InvokeAI's queue API.",
  }),
});

const TOOL_PIPELINE_CAPABILITIES = Object.freeze({
  ollama: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Image input requires a vision-capable Ollama model.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_PLAN]),
        derivedInputKinds: Object.freeze([MODALITY_FILE]),
        notes: 'Image validation requires a vision-capable Ollama model. Document-style files are reviewed through extracted text and metadata.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'tool',
  }),
  whisper: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.WHISPER_TRANSCRIBE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_AUDIO]),
        notes: 'Runs locally through faster-whisper inside Local AI Hub and keeps transcript timing details attached to the result.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'tool',
  }),
  automatic1111: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Runs a single text-to-image request through the Stable Diffusion WebUI API.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
    }),
    targetType: 'tool',
  }),
  forge: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Runs a single text-to-image request through the Stable Diffusion WebUI API.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
    }),
    targetType: 'tool',
  }),
  upscayl: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        notes: 'Runs Upscayl through a dedicated local adapter so enhancement and upscaling return a transformed image artifact with clear lineage back to the connected source image.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
        transformSubtypes: Object.freeze(['upscale', 'enhance']),
      }),
    }),
    targetType: 'tool',
  }),
  facefusion: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        notes: 'Runs FaceFusion through a dedicated local adapter. Connect the target image on the main input and a source face image on the Reference Image input.',
        outputKinds: Object.freeze([MODALITY_IMAGE]),
        requiresReferenceImage: true,
        transformSubtypes: Object.freeze(['face-swap']),
      }),
    }),
    targetType: 'tool',
  }),
  'wan21-webui': Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Runs a local Wan video request through a dedicated direct Python adapter. Text input produces text-to-video. Image input produces image-to-video when motion guidance is supplied in the step instruction box.',
        operationSubtypes: Object.freeze(['text-to-video', 'image-to-video']),
        outputKinds: Object.freeze([MODALITY_VIDEO]),
      }),
    }),
    targetType: 'tool',
  }),
  'audiocraft-webui': Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_AUDIO]),
        notes: 'Runs AudioCraft through a dedicated direct Python adapter. Text input produces generated audio. Audio input can guide Music mode or seed real continuation mode from the end of the connected clip.',
        operationSubtypes: Object.freeze(['music', 'sound', 'continuation']),
        outputKinds: Object.freeze([MODALITY_AUDIO]),
      }),
    }),
    targetType: 'tool',
  }),
  'chatterbox-tts': Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Runs Chatterbox-Turbo through a dedicated direct Python adapter. Text input supplies the words to speak, and the Reference Audio input supplies the short voice sample used for zero-shot reference voice TTS.',
        operationSubtypes: Object.freeze(['referenceVoiceTts']),
        outputKinds: Object.freeze([MODALITY_AUDIO]),
        referenceInputKinds: Object.freeze([MODALITY_AUDIO]),
        requiresReferenceAudio: true,
      }),
    }),
    targetType: 'tool',
  }),
  rvc: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.AUDIO_TRANSFORM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_AUDIO]),
        notes: 'Runs RVC through a dedicated direct Python adapter. The connected source clip stays first-class and the converted result keeps explicit lineage back to that source audio.',
        operationSubtypes: Object.freeze(['voice-conversion']),
        outputKinds: Object.freeze([MODALITY_AUDIO]),
        transformSubtypes: Object.freeze(['voice-conversion']),
      }),
    }),
    targetType: 'tool',
  }),
});

const PROVIDER_PIPELINE_CAPABILITIES = Object.freeze({
  openai: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        notes: 'Runs through the provider chat path as a vision image-to-text request.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_PLAN]),
        derivedInputKinds: Object.freeze([MODALITY_FILE]),
        notes: 'Document-style files are reviewed through extracted text and metadata in the current OpenAI-compatible chat path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Image generation uses a dedicated OpenAI image model such as gpt-image-1. Image input needs an edit instruction.',
        operationSubtypes: Object.freeze(['textToImage', 'imageToImage']),
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
      [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Speech generation uses a dedicated OpenAI text-to-speech model such as gpt-4o-mini-tts, tts-1, or tts-1-hd.',
        outputKinds: Object.freeze([MODALITY_AUDIO]),
      }),
    }),
    targetType: 'provider',
  }),
  anthropic: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_FILE]),
        notes: 'Claude can review images and many document-style files in the current chat path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        notes: 'Runs through the provider chat path as a vision image-to-text request.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_FILE, MODALITY_PLAN]),
        notes: 'PDF documents can be attached directly. Other document-style files fall back to extracted text when needed.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  google: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_VIDEO, MODALITY_FILE]),
        notes: 'Gemini can review attached images, videos, and document-style files in the current provider path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_ANALYZE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_IMAGE]),
        notes: 'Runs through the provider chat path as a vision image-to-text request.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_VIDEO, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE, MODALITY_VIDEO, MODALITY_FILE, MODALITY_PLAN]),
        notes: 'Gemini validation can review attached images, videos, and document-style files in the current provider path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'Gemini text-to-speech can turn text into a saved speech artifact when you choose a TTS-capable Gemini model.',
        outputKinds: Object.freeze([MODALITY_AUDIO]),
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Gemini image generation can create an image from text, or edit a source image with a text instruction when a compatible Gemini image model is selected.',
        operationSubtypes: Object.freeze(['textToImage', 'imageToImage']),
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
      [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'Google Veo creates videos from text, or from an image plus motion guidance, through Gemini long-running operations.',
        operationSubtypes: Object.freeze(['textToVideo', 'imageToVideo']),
        outputKinds: Object.freeze([MODALITY_VIDEO]),
        requiresModel: false,
      }),
    }),
    targetType: 'provider',
  }),
  mistral: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_PLAN]),
        derivedInputKinds: Object.freeze([MODALITY_FILE]),
        notes: 'Document-style files are reviewed through extracted text and metadata in the current chat path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  groq: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_PLAN]),
        derivedInputKinds: Object.freeze([MODALITY_FILE]),
        notes: 'Document-style files are reviewed through extracted text and metadata in the current chat path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  deepseek: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_PLAN]),
        derivedInputKinds: Object.freeze([MODALITY_FILE]),
        notes: 'Document-style files are reviewed through extracted text and metadata in the current chat path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
    }),
    targetType: 'provider',
  }),
  xai: Object.freeze({
    operations: Object.freeze({
      [PIPELINE_OPERATION_IDS.LLM_PROMPT]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.VALIDATION_LLM]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_FILE, MODALITY_PLAN]),
        directInputKinds: Object.freeze([MODALITY_TEXT, MODALITY_PLAN]),
        derivedInputKinds: Object.freeze([MODALITY_FILE]),
        notes: 'Document-style files are reviewed through extracted text and metadata in the current chat path.',
        outputKinds: Object.freeze([MODALITY_TEXT]),
      }),
      [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT]),
        notes: 'xAI text-to-speech beta turns text into a saved speech artifact through its provider-managed voice runtime. Model selection stays optional in this pass because xAI does not currently expose a separate TTS model list here.',
        outputKinds: Object.freeze([MODALITY_AUDIO]),
        requiresModel: false,
      }),
      [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'xAI image generation can create an image from text, or edit a source image with a text instruction when a compatible image model is selected.',
        operationSubtypes: Object.freeze(['textToImage', 'imageToImage']),
        outputKinds: Object.freeze([MODALITY_IMAGE]),
      }),
      [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
        inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
        notes: 'xAI Grok Imagine creates videos from text, or animates a still image with motion guidance through xAI asynchronous video operations.',
        operationSubtypes: Object.freeze(['textToVideo', 'imageToVideo']),
        outputKinds: Object.freeze([MODALITY_VIDEO]),
        requiresModel: false,
      }),
    }),
    targetType: 'provider',
  }),
});

const PROVIDER_MODEL_CAPABILITY_RULES = Object.freeze({
  openai: Object.freeze([
    Object.freeze({
      capabilityLabels: Object.freeze(['Speech generation']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT]),
          notes: 'Creates speech audio from text through the OpenAI speech endpoint.',
          outputKinds: Object.freeze([MODALITY_AUDIO]),
        }),
      }),
      pattern: /^(gpt-4o-mini-tts|tts-1(?:-hd)?)$/i,
    }),
    Object.freeze({
      capabilityLabels: Object.freeze(['Image generation', 'Image editing']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
          notes: 'Creates an image from text, or edits a source image with a text instruction.',
          operationSubtypes: Object.freeze(['textToImage', 'imageToImage']),
          outputKinds: Object.freeze([MODALITY_IMAGE]),
        }),
      }),
      pattern: /^(gpt-image-1(?:\.5|-mini)?|chatgpt-image-latest)$/i,
    }),
  ]),
  google: Object.freeze([
    Object.freeze({
      capabilityLabels: Object.freeze(['Video generation', 'Image reference', 'Long-running operation']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
          notes: 'Creates a video from text or from an image plus motion guidance through Google Veo.',
          operationSubtypes: Object.freeze(['textToVideo', 'imageToVideo']),
          outputKinds: Object.freeze([MODALITY_VIDEO]),
          requiresModel: false,
        }),
      }),
      pattern: /^models\/veo-[a-z0-9.-]+$/i,
    }),
    Object.freeze({
      capabilityLabels: Object.freeze(['Speech generation']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.AUDIO_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT]),
          notes: 'Creates speech audio from text through Gemini text-to-speech.',
          outputKinds: Object.freeze([MODALITY_AUDIO]),
        }),
      }),
      pattern: /^models\/gemini-[a-z0-9.-]*tts$/i,
    }),
    Object.freeze({
      capabilityLabels: Object.freeze(['Image generation', 'Image editing']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
          notes: 'Creates an image from text, or edits a source image with a text instruction through Gemini image generation.',
          operationSubtypes: Object.freeze(['textToImage', 'imageToImage']),
          outputKinds: Object.freeze([MODALITY_IMAGE]),
        }),
      }),
      pattern: /^models\/gemini-(?:[a-z0-9.-]+-image|2\.0-flash-preview-image-generation)$/i,
    }),
  ]),
  xai: Object.freeze([
    Object.freeze({
      capabilityLabels: Object.freeze(['Video generation', 'Image reference', 'Async operation']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.VIDEO_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
          notes: 'Creates a video from text or from an image plus motion guidance through xAI Grok Imagine.',
          operationSubtypes: Object.freeze(['textToVideo', 'imageToVideo']),
          outputKinds: Object.freeze([MODALITY_VIDEO]),
          requiresModel: false,
        }),
      }),
      pattern: /^grok-imagine-video(?:-[a-z0-9.-]+)?$/i,
    }),
    Object.freeze({
      capabilityLabels: Object.freeze(['Image generation', 'Image editing']),
      capabilitySource: 'explicit',
      exclusive: true,
      operations: Object.freeze({
        [PIPELINE_OPERATION_IDS.IMAGE_GENERATE]: Object.freeze({
          inputKinds: Object.freeze([MODALITY_TEXT, MODALITY_IMAGE]),
          notes: 'Creates an image from text, or edits a source image with a text instruction through xAI image generation.',
          operationSubtypes: Object.freeze(['textToImage', 'imageToImage']),
          outputKinds: Object.freeze([MODALITY_IMAGE]),
        }),
      }),
      pattern: /^grok-imagine-image(?:-[a-z0-9.-]+)?$/i,
    }),
  ]),
});

const PROVIDER_MODEL_FALLBACK_OPERATION_IDS = Object.freeze({
  openai: Object.freeze([PIPELINE_OPERATION_IDS.LLM_PROMPT, PIPELINE_OPERATION_IDS.IMAGE_ANALYZE, PIPELINE_OPERATION_IDS.VALIDATION_LLM]),
  google: Object.freeze([PIPELINE_OPERATION_IDS.LLM_PROMPT, PIPELINE_OPERATION_IDS.IMAGE_ANALYZE, PIPELINE_OPERATION_IDS.VALIDATION_LLM]),
  xai: Object.freeze([PIPELINE_OPERATION_IDS.LLM_PROMPT, PIPELINE_OPERATION_IDS.VALIDATION_LLM, PIPELINE_OPERATION_IDS.AUDIO_GENERATE, PIPELINE_OPERATION_IDS.VIDEO_GENERATE]),
});

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function cloneKinds(kinds = []) {
  return [...new Set((kinds || []).map((kind) => String(kind || '').trim().toLowerCase()).filter(Boolean))];
}

function cloneSubtypes(subtypes = []) {
  return [...new Set((subtypes || []).map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function cloneOperation(operation) {
  if (!operation) {
    return null;
  }

  return {
    ...operation,
    derivedInputKinds: cloneKinds(operation.derivedInputKinds),
    directInputKinds: cloneKinds(operation.directInputKinds),
    inputKinds: cloneKinds(operation.inputKinds),
    outputKinds: cloneKinds(operation.outputKinds),
    operationSubtypes: cloneSubtypes(operation.operationSubtypes),
    transformSubtypes: cloneSubtypes(operation.transformSubtypes),
  };
}

function cloneOperationMap(operations = {}) {
  return Object.fromEntries(Object.entries(operations || {}).map(([operationId, operation]) => [operationId, cloneOperation(operation)]));
}

function cloneCapabilityRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    capabilityLabels: Array.isArray(record.capabilityLabels)
      ? [...new Set(record.capabilityLabels.map((entry) => String(entry || '').trim()).filter(Boolean))]
      : [],
    capabilitySource: String(record.capabilitySource || '').trim() || '',
    operations: cloneOperationMap(record.operations || {}),
  };
}

function cloneToolPipelineStrategy(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    label: String(record.label || '').trim() || '',
    notes: String(record.notes || '').trim() || '',
  };
}

function getToolPipelineCapabilities(toolId) {
  return cloneCapabilityRecord(TOOL_PIPELINE_CAPABILITIES[normalizeId(toolId)] || null);
}

function getProviderPipelineCapabilities(providerId) {
  return cloneCapabilityRecord(PROVIDER_PIPELINE_CAPABILITIES[normalizeId(providerId)] || null);
}

function getToolPipelineStrategy(toolId) {
  return cloneToolPipelineStrategy(TOOL_PIPELINE_STRATEGIES[normalizeId(toolId)] || null);
}

function getMatchingProviderModelRule(providerId, modelId) {
  const normalizedModelId = String(modelId || '').trim();
  if (!normalizedModelId) {
    return null;
  }

  return (PROVIDER_MODEL_CAPABILITY_RULES[normalizeId(providerId)] || []).find((rule) => rule.pattern?.test(normalizedModelId)) || null;
}

function getProviderModelFallbackOperations(providerId) {
  const providerRecord = PROVIDER_PIPELINE_CAPABILITIES[providerId] || null;
  const fallbackOperationIds = PROVIDER_MODEL_FALLBACK_OPERATION_IDS[providerId] || null;
  if (!providerRecord) {
    return {};
  }

  if (!fallbackOperationIds) {
    return providerRecord.operations || {};
  }

  return Object.fromEntries(
    fallbackOperationIds
      .map((operationId) => [operationId, providerRecord.operations?.[operationId] || null])
      .filter(([, operation]) => Boolean(operation)),
  );
}

function getProviderModelCapabilities(providerId, modelId) {
  const normalizedProviderId = normalizeId(providerId);
  const providerRecord = PROVIDER_PIPELINE_CAPABILITIES[normalizedProviderId] || null;
  const rule = getMatchingProviderModelRule(providerId, modelId);
  const fallbackOperations = getProviderModelFallbackOperations(normalizedProviderId);
  if (!rule) {
    return cloneCapabilityRecord(
      providerRecord
        ? {
            ...providerRecord,
            operations: fallbackOperations,
          }
        : null,
    );
  }

  const baseOperations = rule.exclusive ? {} : fallbackOperations;
  return cloneCapabilityRecord({
    capabilityLabels: rule.capabilityLabels || [],
    capabilitySource: rule.capabilitySource || 'explicit',
    operations: {
      ...baseOperations,
      ...(rule.operations || {}),
    },
    targetType: 'provider',
  });
}

function getToolPipelineOperation(toolId, operationId) {
  return cloneOperation(TOOL_PIPELINE_CAPABILITIES[normalizeId(toolId)]?.operations?.[operationId] || null);
}

function getProviderPipelineOperation(providerId, operationId) {
  return cloneOperation(PROVIDER_PIPELINE_CAPABILITIES[normalizeId(providerId)]?.operations?.[operationId] || null);
}

function getProviderModelOperation(providerId, modelId, operationId) {
  return cloneOperation(getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId] || null);
}

function doesProviderModelSupportOperation(providerId, modelId, operationId) {
  return Boolean(getProviderModelCapabilities(providerId, modelId)?.operations?.[operationId]);
}

function doesProviderOperationRequireExplicitModel(providerId, operationId) {
  const providerOperation = PROVIDER_PIPELINE_CAPABILITIES[normalizeId(providerId)]?.operations?.[operationId] || null;
  if (!providerOperation) {
    return true;
  }

  return providerOperation.requiresModel !== false;
}

function getToolIdsForPipelineOperation(operationId) {
  return Object.entries(TOOL_PIPELINE_CAPABILITIES)
    .filter(([, record]) => Boolean(record?.operations?.[operationId]))
    .map(([toolId]) => toolId);
}

function getProviderIdsForPipelineOperation(operationId) {
  return Object.entries(PROVIDER_PIPELINE_CAPABILITIES)
    .filter(([, record]) => Boolean(record?.operations?.[operationId]))
    .map(([providerId]) => providerId);
}

function getToolIdsForPipelineStrategy(strategyIds) {
  const normalizedStrategyIds = (Array.isArray(strategyIds) ? strategyIds : [strategyIds])
    .map((strategyId) => String(strategyId || '').trim())
    .filter(Boolean);

  if (!normalizedStrategyIds.length) {
    return [];
  }

  return Object.entries(TOOL_PIPELINE_STRATEGIES)
    .filter(([, record]) => normalizedStrategyIds.includes(record?.id))
    .map(([toolId]) => toolId);
}

function getGraphWorkflowToolIds(options = {}) {
  const strategyIds = [TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW];
  if (options.includeDeferred !== false) {
    strategyIds.push(TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_DEFERRED);
  }

  return getToolIdsForPipelineStrategy(strategyIds);
}

function getRunnableGraphWorkflowToolIds() {
  return getToolIdsForPipelineStrategy(TOOL_PIPELINE_STRATEGY_IDS.GRAPH_NATIVE_WORKFLOW);
}
function getOperationDrivenToolIdsForPipelineOperation(operationId) {
  return Object.entries(TOOL_PIPELINE_CAPABILITIES)
    .filter(([toolId, record]) => {
      if (!record?.operations?.[operationId]) {
        return false;
      }

      return TOOL_PIPELINE_STRATEGIES[toolId]?.id === TOOL_PIPELINE_STRATEGY_IDS.LOCAL_OPERATION_TOOL;
    })
    .map(([toolId]) => toolId);
}

module.exports = {
  MODALITY_AUDIO,
  MODALITY_FILE,
  MODALITY_PLAN,
  MODALITY_IMAGE,
  MODALITY_TEXT,
  MODALITY_VIDEO,
  PIPELINE_RECORD_INPUT_CAPABILITY,
  PIPELINE_OPERATION_IDS,
  RECORD_INPUT_MODE_IDS,
  RECORD_INPUT_MODE_OPTIONS,
  TOOL_PIPELINE_STRATEGY_IDS,
  doesProviderModelSupportOperation,
  doesProviderOperationRequireExplicitModel,
  getGraphWorkflowToolIds,
  getOperationDrivenToolIdsForPipelineOperation,
  getProviderIdsForPipelineOperation,
  getProviderModelCapabilities,
  getProviderModelOperation,
  getProviderPipelineCapabilities,
  getProviderPipelineOperation,
  getRunnableGraphWorkflowToolIds,
  getToolIdsForPipelineOperation,
  getToolIdsForPipelineStrategy,
  getToolPipelineCapabilities,
  getToolPipelineOperation,
  getToolPipelineStrategy,
};

module.exports.default = module.exports;

