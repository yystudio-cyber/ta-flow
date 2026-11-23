# Windows.Media.Ocr helper. Usage: powershell -ExecutionPolicy Bypass -File winocr.ps1 -Image <path> [-SliceLimitPx 2200] [-OverlapPx 120]
# Outputs recognized text to stdout (UTF-8). ASCII-only source (no CJK literals) so it parses regardless of BOM.
param(
    [Parameter(Mandatory=$true)][string]$Image,
    [int]$SliceLimitPx = 2200,
    [int]$OverlapPx = 120
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# Helper to await WinRT IAsyncOperation<T> -> TResult
function Await($WinRtTask, $ResultType) {
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
    (New-Object Windows.Globalization.Language('zh-Hans-CN')))

if ($null -eq $engine) {
    # fall back to user profile language engine
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) { Write-Error 'No OCR engine available'; exit 2 }

# Load image as bitmap via System.Drawing, then convert to SoftwareBitmap via WIC (StorageFile path is most reliable)
# Use StorageFile.GetFileFromPathAsync + BitmapDecoder for reliable decoding of PNG/RGBA
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$softBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$pixelHeight = $softBitmap.PixelHeight
$pixelWidth = $softBitmap.PixelWidth

# Slicing: if height exceeds limit, split into vertical bands with overlap.
$bands = @()
if ($pixelHeight -le $SliceLimitPx) {
    $bands += ,@($null, $null, $pixelHeight)
} else {
    $y = 0
    while ($y -lt $pixelHeight) {
        $end = [Math]::Min($y + $SliceLimitPx, $pixelHeight)
        $bands += ,@($y, $end, $null)
        if ($end -ge $pixelHeight) { break }
        $y = $end - $OverlapPx
    }
}

$allLines = New-Object System.Collections.Generic.List[string]
foreach ($band in $bands) {
    $sy = $band[0]; $ey = $band[1]
    $bandBitmap = $softBitmap
    if ($null -ne $sy) {
        # Crop band from original software bitmap using BitmapTransform
        $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
        $transform.ScaledWidth = [uint32]$pixelWidth
        $transform.ScaledHeight = [uint32]($ey - $sy)
        $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
        $transform.Bounds = New-Object Windows.Foundation.Rect(0, $sy, $pixelWidth, ($ey - $sy))
        $bandBitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform,
            [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
            [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    }
    $result = Await ($engine.RecognizeAsync($bandBitmap)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $result.Lines) {
        $allLines.Add($line.Text)
    }
}

# Output UTF-8
$out = $allLines -join "`n"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::WriteLine($out)
