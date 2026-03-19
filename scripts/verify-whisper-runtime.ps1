Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Resolve-PythonRunner {
  if ($env:LOCALAIHUB_VERIFY_PYTHON) {
    return @($env:LOCALAIHUB_VERIFY_PYTHON)
  }

  $managedWhisperPython = 'D:\LocalAIHub\tools\whisper\.venv\Scripts\python.exe'
  if (Test-Path $managedWhisperPython) {
    return @($managedWhisperPython)
  }

  try {
    & py -3 -c "print('ok')" | Out-Null
    return @('py', '-3')
  } catch {
  }

  try {
    & python -c "print('ok')" | Out-Null
    return @('python')
  } catch {
  }

  throw 'Python 3 is required to verify the Whisper helper fallback path.'
}

$tempRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'temp\whisper-runtime-verification'
$stubsRoot = Join-Path $tempRoot 'stubs'
$packageRoot = Join-Path $stubsRoot 'faster_whisper'
$helperPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'electron\helpers\transcribe_whisper.py'
$audioPath = Join-Path $tempRoot 'sample.m4a'
$cacheDir = Join-Path $tempRoot 'models'
$attemptLogPath = Join-Path $tempRoot 'attempts.json'

if (Test-Path $tempRoot) {
  Remove-Item $tempRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
Set-Content -Path $audioPath -Value 'stub audio' -Encoding utf8
Set-Content -Path (Join-Path $packageRoot '__init__.py') -Encoding utf8 -Value @"
import json
import os

LOG_PATH = os.environ.get('WHISPER_STUB_LOG_PATH', '')


def append_attempt(entry):
    if not LOG_PATH:
        return
    if os.path.exists(LOG_PATH):
        with open(LOG_PATH, 'r', encoding='utf8') as handle:
            payload = json.load(handle)
    else:
        payload = []
    payload.append(entry)
    with open(LOG_PATH, 'w', encoding='utf8') as handle:
        json.dump(payload, handle)


class Segment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class Info:
    def __init__(self):
        self.duration = 1.0
        self.language = 'en'


class WhisperModel:
    def __init__(self, model_name, device='cpu', compute_type='int8', download_root=None):
        append_attempt({'stage': 'init', 'device': device, 'computeType': compute_type, 'model': model_name})
        self.device = device
        self.compute_type = compute_type
        if device == 'cuda' and compute_type in {'float16', 'int8_float16'}:
            raise RuntimeError(f'Requested {compute_type} compute type, but the target device or backend do not support efficient {compute_type} computation.')

    def transcribe(self, audio_path, vad_filter=True):
        append_attempt({'stage': 'transcribe', 'device': self.device, 'computeType': self.compute_type, 'audioPath': audio_path, 'vadFilter': bool(vad_filter)})
        if self.device == 'cuda':
            raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded')
        return [Segment(0.0, 1.0, 'Hello from CPU fallback.')], Info()
"@

$pythonRunner = @(Resolve-PythonRunner)
$pythonCommand = $pythonRunner[0]
$pythonArgs = @()
if ($pythonRunner.Length -gt 1) {
  $pythonArgs = $pythonRunner[1..($pythonRunner.Length - 1)]
}

$previousPythonPath = $env:PYTHONPATH
$previousStubLog = $env:WHISPER_STUB_LOG_PATH
$env:PYTHONPATH = $stubsRoot
$env:WHISPER_STUB_LOG_PATH = $attemptLogPath

try {
  $output = & $pythonCommand @pythonArgs $helperPath $audioPath 'tiny' $cacheDir 2>&1
  $exitCode = $LASTEXITCODE
} finally {
  if ($null -ne $previousPythonPath) {
    $env:PYTHONPATH = $previousPythonPath
  } else {
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
  }

  if ($null -ne $previousStubLog) {
    $env:WHISPER_STUB_LOG_PATH = $previousStubLog
  } else {
    Remove-Item Env:WHISPER_STUB_LOG_PATH -ErrorAction SilentlyContinue
  }
}

Assert-Condition ($exitCode -eq 0) ("The Whisper helper exited with code $exitCode. Output:`n" + ($output -join "`n"))

$jsonLine = $output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ } | Select-Object -Last 1
Assert-Condition ($jsonLine.StartsWith('{')) 'Whisper helper did not print a JSON payload.'
$payload = $jsonLine | ConvertFrom-Json
Assert-Condition ($payload.device -eq 'cpu') 'Expected the helper to fall back to CPU transcription.'
Assert-Condition ($payload.computeType -eq 'int8') 'Expected the CPU fallback to use int8 compute.'
Assert-Condition ($payload.text -eq 'Hello from CPU fallback.') 'Expected the helper to keep the CPU transcript output.'
Assert-Condition ($payload.runtimeNote -like '*CPU mode*') 'Expected the helper to report that it switched to CPU mode.'

$attempts = Get-Content $attemptLogPath -Raw | ConvertFrom-Json
$attemptLabels = @($attempts | ForEach-Object { "$($_.stage):$($_.device):$($_.computeType)" })
$expectedLabels = @(
  'init:cuda:float16',
  'init:cuda:int8_float16',
  'init:cuda:int8',
  'transcribe:cuda:int8',
  'init:cpu:int8',
  'transcribe:cpu:int8'
)
Assert-Condition (($attemptLabels -join '|') -eq ($expectedLabels -join '|')) 'Expected the helper to retry on CPU after the CUDA runtime failed during transcription.'

Write-Output 'Whisper runtime verification passed.'

