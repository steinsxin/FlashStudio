param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $env:RUNNER_TEMP) { throw 'Run this installation test only on a disposable CI runner.' }
$project = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$installerPath = (Resolve-Path $Installer).Path
$installDir = Join-Path $env:RUNNER_TEMP 'FlashStudio install test'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FlashStudio'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'FlashStudio\FlashStudio.lnk'
if ((Test-Path $registry) -or (Test-Path $installDir) -or (Test-Path $shortcut)) {
    throw 'Refusing to overwrite an existing FlashStudio installation.'
}
$app = $null
try {
    # /D must be last and unquoted, including when the path contains spaces.
    $install = Start-Process -FilePath $installerPath -ArgumentList "/S /D=$installDir" -Wait -PassThru
    if ($install.ExitCode -notin @(0, 3010)) { throw "Installer failed: $($install.ExitCode)" }
    foreach ($relative in @('flashstudio.exe', 'uninstall.exe', 'THIRD_PARTY_NOTICES.md', 'openocd\bin\openocd.exe')) {
        if (-not (Test-Path (Join-Path $installDir $relative))) { throw "Missing installed file: $relative" }
    }
    if (Test-Path (Join-Path $installDir 'install-usb-rules.sh')) { throw 'Linux helper leaked into Windows package.' }
    if (-not (Test-Path $shortcut)) { throw 'Start menu shortcut missing.' }
    $entry = Get-ItemProperty $registry
    if ($entry.DisplayName -ne 'FlashStudio' -or -not $entry.UninstallString) { throw 'Uninstall registration missing.' }
    # A developer runner already has VC runtimes. Inspect imports so it cannot
    # hide an accidental dependency on a user's separately installed VC runtime.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $dumpbin = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
    if (-not $dumpbin) { throw 'Cannot locate dumpbin for the installed executable dependency check.' }
    $imports = (& $dumpbin /dependents (Join-Path $installDir 'flashstudio.exe')) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect installed executable imports.' }
    if ($imports -match '(?im)^\s*(?:VCRUNTIME|MSVCP)\d\S*\.dll') { throw 'Application unexpectedly requires a separate Visual C++ runtime.' }
    & python (Join-Path $project 'packaging/common/verify-engine.py') (Join-Path $installDir 'openocd') win32-x64
    if ($LASTEXITCODE -ne 0) { throw 'Installed engine validation failed.' }
    $app = Start-Process -FilePath (Join-Path $installDir 'flashstudio.exe') -PassThru
    Start-Sleep -Seconds 5
    if ($app.HasExited) { throw "Installed application exited during startup: $($app.ExitCode)" }
    Write-Host 'Installed application started; OpenOCD, DLLs, scripts, shortcut and uninstall entry verified.'
} finally {
    if ($app -and -not $app.HasExited) {
        Stop-Process -Id $app.Id -Force
        $app.WaitForExit()
    }
    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (Test-Path $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installDir" -Wait -PassThru
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstall.ExitCode)" }
        if ((Test-Path (Join-Path $installDir 'flashstudio.exe')) -or (Test-Path (Join-Path $installDir 'openocd')) -or (Test-Path $registry) -or (Test-Path $shortcut)) {
            throw 'Uninstall left application files, resources, registry entry or shortcut behind.'
        }
        # _?= runs the uninstaller in place; remove the remaining test directory.
        if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
        Write-Host 'Uninstall verified.'
    }
}
