param([string]$Voice = 'Microsoft Zira Desktop')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$discernAudio = Join-Path $PSScriptRoot 'media/audio'
New-Item -ItemType Directory -Force -Path $discernAudio | Out-Null
$discernStory = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'narration.json') -Raw | ConvertFrom-Json
$discernSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $discernSynth.SelectVoice($Voice)
    $discernSynth.Rate = 0
    foreach ($discernChapter in $discernStory) {
        for ($discernCue = 0; $discernCue -lt $discernChapter.cues.Count; $discernCue++) {
            $discernWave = Join-Path $discernAudio ('{0}-{1}.wav' -f $discernChapter.id, $discernCue)
            $discernSynth.SetOutputToWaveFile($discernWave)
            $discernSynth.Speak($discernChapter.cues[$discernCue])
            $discernSynth.SetOutputToNull()
        }
    }
} finally {
    $discernSynth.Dispose()
}
Write-Output ('Narration saved to ' + $discernAudio)
