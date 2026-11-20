param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [string]$TestRoot = $env:RUNNER_TEMP
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $TestRoot) { throw 'Specify -TestRoot on a disposable Windows test machine, or run on a CI runner.' }
$installerPath = (Resolve-Path $Installer).Path
$installDir = Join-Path ([IO.Path]::GetFullPath($TestRoot)) 'FlashStudio install test'
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
    & (Join-Path $PSScriptRoot 'verify-engine.ps1') -EngineRoot (Join-Path $installDir 'openocd')
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
