# Recreates the small vector-style application icon without external image services.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
[System.IO.Directory]::CreateDirectory((Join-Path $root 'build')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $root 'public')) | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#102b35'))
$foreground = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#9dd6bb'))
$pen = [System.Drawing.Pen]::new($foreground, 9)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
try {
    $shape.AddArc(0, 0, 64, 64, 180, 90)
    $shape.AddArc(191, 0, 64, 64, 270, 90)
    $shape.AddArc(191, 191, 64, 64, 0, 90)
    $shape.AddArc(0, 191, 64, 64, 90, 90)
    $shape.CloseFigure()
    $graphics.FillPath($background, $shape)
    $graphics.DrawLine($pen, 62, 91, 62, 66)
    $graphics.DrawLine($pen, 62, 66, 88, 66)
    $graphics.DrawLine($pen, 168, 66, 194, 66)
    $graphics.DrawLine($pen, 194, 66, 194, 91)
    $graphics.DrawLine($pen, 62, 165, 62, 190)
    $graphics.DrawLine($pen, 62, 190, 88, 190)
    $graphics.DrawLine($pen, 168, 190, 194, 190)
    $graphics.DrawLine($pen, 194, 190, 194, 165)
    $graphics.FillEllipse($foreground, 96, 108, 13, 13)
    $graphics.FillEllipse($foreground, 147, 108, 13, 13)
    $graphics.DrawArc($pen, 97, 126, 61, 36, 18, 144)
    $pngPath = Join-Path $root 'public/icon.png'
    $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = [System.IO.File]::ReadAllBytes($pngPath)
    $writer = [System.IO.BinaryWriter]::new([System.IO.File]::Create((Join-Path $root 'build/icon.ico')))
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
        $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
    } finally { $writer.Dispose() }
    Write-Output 'Created build/icon.ico and public/icon.png'
} finally { $shape.Dispose(); $pen.Dispose(); $foreground.Dispose(); $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
