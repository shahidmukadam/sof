param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$VenvPath = Join-Path $ProjectRoot ".venv-windows-package"
$PythonExe = Join-Path $VenvPath "Scripts\python.exe"
$DistRoot = Join-Path $ProjectRoot "dist"
$BuildRoot = Join-Path $ProjectRoot "build"
$ReleaseRoot = Join-Path $ProjectRoot "release"
$BundleRoot = Join-Path $ReleaseRoot "StateOfFinance-windows"
$ZipPath = Join-Path $ReleaseRoot "StateOfFinance-windows-portable.zip"

function Invoke-PythonLauncher {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Args
    )

    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 @Args
        return
    }

    if (Get-Command python -ErrorAction SilentlyContinue) {
        & python @Args
        return
    }

    throw "Python 3 is required on the Windows build machine."
}

Set-Location $ProjectRoot

if ($Clean) {
    Remove-Item $VenvPath, $DistRoot, $BuildRoot, $ReleaseRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $VenvPath)) {
    Invoke-PythonLauncher -Args "-m", "venv", $VenvPath
}

& $PythonExe -m pip install --upgrade pip
& $PythonExe -m pip install -r (Join-Path $ProjectRoot "requirements-windows-package.txt")
& $PythonExe -m PyInstaller --noconfirm (Join-Path $ProjectRoot "windows\StateOfFinance.spec")

New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
Remove-Item $BundleRoot -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $DistRoot "StateOfFinance") $BundleRoot -Recurse
Copy-Item (Join-Path $ProjectRoot "windows\README-windows-package.txt") (Join-Path $BundleRoot "README.txt") -Force

if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

Compress-Archive -Path $BundleRoot -DestinationPath $ZipPath

Write-Host ""
Write-Host "Windows package created:"
Write-Host "  Folder: $BundleRoot"
Write-Host "  Zip:    $ZipPath"
