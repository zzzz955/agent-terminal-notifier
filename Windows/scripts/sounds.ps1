param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
# Generated tones: no third-party audio licensing or checked-in binary assets.
$tones = @{ completed = @(660,880); attention = @(880,660,880); blocked = @(330,220); error = @(220,220,220) }
foreach ($name in $tones.Keys) {
    $file = Join-Path $Directory ($name + '.wav')
    if (Test-Path -LiteralPath $file) { continue } # Preserve customized SFX.
    $rate = 22050
    $samplesPerTone = [int]($rate * 0.13)
    $gap = [int]($rate * 0.06)
    $count = $tones[$name].Count * ($samplesPerTone + $gap)
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
        $writer.Write([int](36 + $count * 2))
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
        $writer.Write([int]16); $writer.Write([int16]1); $writer.Write([int16]1)
        $writer.Write([int]$rate); $writer.Write([int]($rate * 2)); $writer.Write([int16]2); $writer.Write([int16]16)
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data')); $writer.Write([int]($count * 2))
        foreach ($frequency in $tones[$name]) {
            for ($i = 0; $i -lt $samplesPerTone; $i++) {
                $fade = [Math]::Min(1, [Math]::Min($i / 220.0, ($samplesPerTone - $i) / 220.0))
                $writer.Write([int16](5000 * $fade * [Math]::Sin(2 * [Math]::PI * $frequency * $i / $rate)))
            }
            for ($i = 0; $i -lt $gap; $i++) { $writer.Write([int16]0) }
        }
        $writer.Flush()
        [System.IO.File]::WriteAllBytes($file, $stream.ToArray())
    } finally { $writer.Dispose(); $stream.Dispose() }
}
